using System.Globalization;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Channels;
using Microsoft.Extensions.Hosting;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>
/// Named Pipe server cho IPC giữa Service (SYSTEM) và Tray App (user session).
/// Giao thức: JSON theo dòng (mỗi dòng một <see cref="IpcMessage"/>), pipe hai chiều:
/// Tray gửi usage-sample / extra-time-request lên, Service gửi warning / lock xuống.
///
/// BẢO MẬT (docs/03-SECURITY.md mục 4): pipe có ACL — chỉ SYSTEM (FullControl)
/// và nhóm Builtin Users (ReadWrite) được kết nối. Pipe này chỉ dùng giao tiếp
/// nội bộ trên máy, không chứa token hay secret.
/// Hỗ trợ nhiều client cùng lúc (mỗi user session một kết nối): vòng lặp
/// accept tạo pipe instance mới ngay sau mỗi kết nối thay vì chờ client cũ
/// ngắt. Ghi chú 2026-11-16: bản một-client khiến Tray ở session thứ hai
/// không bao giờ nối được (log ngày 2026-11-16: Tray session kia giữ pipe
/// suốt 27 phút, Tray session này chờ mãi).
///
/// CHỐNG KẸT (chẩn đoán từ log thật tối 16/11/2026): vòng accept chỉ nhận
/// đúng 1 kết nối rồi kẹt im lặng — không chờ lần 2, không lỗi, không báo
/// ngắt — trong khi các vòng lặp khác của Service vẫn chạy, khiến mọi lệnh
/// khóa/mở sau đó đều bị bỏ ("Tray chưa kết nối"). Để một kết nối chết
/// (zombie) không bao giờ giữ pipe instance mãi và một lần kẹt không bao giờ
/// im lặng nữa:
/// - Mỗi handler có idle timeout 120 giây: không dòng nào tới trong 120s thì
///   đóng + dispose stream của handler đó, giải phóng pipe instance (Tray gửi
///   mẫu foreground mỗi 15s nên kết nối sống không bao giờ idle tới 120s).
/// - Vòng accept ghi log MỌI vòng lặp kèm số thứ tự (chờ, đã nối, đã giao,
///   lỗi tạo/kết nối) để lần kẹt nào cũng nhìn thấy trong log.
/// - Watchdog 60s chỉ ghi log (không dispose/khởi tạo lại gì): nếu quá 90s
///   không có vòng accept mới thì ghi cảnh báo LOUD một lần cho mỗi đợt yên
///   lặng — để phân biệt "đang chờ Tray" với "vòng accept đã kẹt".
/// TODO Sprint 2: thu hẹp ACL theo session của con + xác thực message, và
/// chỉ gửi cảnh báo/khóa tới session của con thay vì broadcast mọi client.
/// </summary>
public sealed class IpcPipeServer : BackgroundService
{
    /// <summary>
    /// Idle timeout cho mỗi kết nối handler: 120 giây không có dòng nào thì
    /// thu hồi. PHẢI khớp phía client (IpcPipeClient): cả hai bên cùng 120s.
    /// </summary>
    internal static readonly TimeSpan IdleTimeout = TimeSpan.FromSeconds(120);

    /// <summary>Ngưỡng watchdog: quá 90s không có vòng accept mới thì cảnh báo.</summary>
    private static readonly TimeSpan WatchdogStallThreshold = TimeSpan.FromSeconds(90);

    /// <summary>Chu kỳ watchdog kiểm tra vòng accept.</summary>
    private static readonly TimeSpan WatchdogInterval = TimeSpan.FromSeconds(60);

    /// <summary>Chờ khóa ghi tối đa 5 giây: một writer kẹt không được treo vòng kiểm tra rules.</summary>
    private static readonly TimeSpan WriteGateTimeout = TimeSpan.FromSeconds(5);

    /// <summary>Chống spam log "Tray chưa kết nối": tối đa 1 lần/60 giây.</summary>
    private static readonly TimeSpan NoTrayLogThrottle = TimeSpan.FromSeconds(60);

    private readonly OutboxStore _outbox;
    private readonly LocalLogger _log;
    private readonly ForegroundState _foregroundState;
    private readonly SemaphoreSlim _writeGate = new(1, 1);
    private readonly System.Collections.Generic.HashSet<StreamWriter> _clientWriters = new();
    private readonly object _writersLock = new();

    // Đếm vòng accept + thời điểm vòng accept gần nhất (ticks UTC, truy cập
    // qua Interlocked vì watchdog chạy trên thread khác).
    private long _acceptIterationCount;
    private long _lastAcceptIterationTicks;
    private long _lastWatchdogWarnedCount = -1;

    /// <summary>Vòng accept đang ngồi chờ client nối tới (trạng thái bình thường) — watchdog bỏ qua.</summary>
    private volatile bool _waitingForConnection;
    private long _handlerCount;

    private readonly object _noTrayLogLock = new();
    private DateTimeOffset _lastNoTrayLogAt;

    public IpcPipeServer(OutboxStore outbox, LocalLogger log, ForegroundState foregroundState)
    {
        _outbox = outbox;
        _log = log;
        _foregroundState = foregroundState;
    }

    /// <summary>
    /// Gửi một message xuống mọi Tray App đang kết nối. Nếu chưa Tray nào kết
    /// nối thì bỏ qua (ghi log chống spam) chứ không xếp hàng — cảnh báo/khóa
    /// sẽ được gửi lại ở lần kiểm tra rules tiếp theo.
    /// </summary>
    /// <returns>Số Tray đã ghi thành công (0 khi chưa Tray nào nối, chờ khóa
    /// ghi quá hạn, hoặc mọi lần ghi đều lỗi). Nơi gọi dùng giá trị này để
    /// quyết định có coi lệnh là "đã gửi" hay không — xem _lockSent.</returns>
    public async Task<int> SendToTrayAsync(IpcMessage message, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(message);

        System.Collections.Generic.List<StreamWriter> writers;
        lock (_writersLock)
        {
            writers = _clientWriters.ToList();
        }

        // Chẩn đoán 17/11/2026: ghi mọi lần gửi kèm số writer đang nối —
        // log bản 0.1.122 cho thấy handler đã bắt đầu đọc nhưng mọi lần gửi
        // đều thấy danh sách rỗng; dòng này cho biết phía gửi nhìn thấy gì.
        _log.Info("IPC: gửi message " + message.Type + " (đang nối: " + writers.Count + " writer).");

        if (writers.Count == 0)
        {
            bool due;
            DateTimeOffset now = DateTimeOffset.UtcNow;
            lock (_noTrayLogLock)
            {
                due = now - _lastNoTrayLogAt >= NoTrayLogThrottle;
                if (due)
                {
                    _lastNoTrayLogAt = now;
                }
            }

            if (due)
            {
                _log.Info("IPC: Tray chưa kết nối, bỏ qua message " + message.Type + ".");
            }

            return 0;
        }

        string line = message.ToLine();

        // Chờ khóa ghi có giới hạn: writer của một kết nối chết có thể treo
        // WriteLineAsync, và khóa bị giữ mãi sẽ treo mọi lần gửi sau.
        using var waitCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        waitCts.CancelAfter(WriteGateTimeout);
        try
        {
            await _writeGate.WaitAsync(waitCts.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            _log.Warning("IPC: chờ khóa ghi quá 5 giây, bỏ qua message " + message.Type + ".");
            return 0;
        }

        int sent = 0;
        try
        {
            foreach (StreamWriter writer in writers)
            {
                try
                {
                    await writer.WriteLineAsync(line);
                    await writer.FlushAsync();
                    sent++;
                }
                catch (Exception ex)
                {
                    _log.Error("IPC: không gửi được message tới một Tray (writer #" + writer.GetHashCode() + "), gỡ khỏi danh sách.", ex);
                    lock (_writersLock)
                    {
                        _clientWriters.Remove(writer);
                    }
                }
            }
        }
        finally
        {
            _writeGate.Release();
        }

        return sent;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        Interlocked.Exchange(ref _lastAcceptIterationTicks, DateTimeOffset.UtcNow.UtcTicks);

        // Watchdog chỉ ghi log, KHÔNG dispose hay tạo lại bất cứ thứ gì.
        using var watchdog = new System.Threading.Timer(WatchdogTick, null, WatchdogInterval, WatchdogInterval);

        while (!stoppingToken.IsCancellationRequested)
        {
            long iteration = Interlocked.Increment(ref _acceptIterationCount);
            Interlocked.Exchange(ref _lastAcceptIterationTicks, DateTimeOffset.UtcNow.UtcTicks);

            NamedPipeServerStream? server = null;
            try
            {
                _log.Info("IPC: accept #" + iteration + " — chờ Tray App kết nối...");
                server = CreatePipeServer();
                // Đánh dấu "đang chờ kết nối": watchdog KHÔNG được kêu trong
                // lúc này — chờ client là trạng thái bình thường, không phải
                // kẹt (log thật 17/11/2026: watchdog báo giả 3 lần trong lúc
                // vòng accept chỉ đang chờ Tray nối tới, làm nhiễu chẩn đoán).
                _waitingForConnection = true;
                try
                {
                    await server.WaitForConnectionAsync(stoppingToken);
                }
                finally
                {
                    _waitingForConnection = false;
                }
                _log.Info("IPC: accept #" + iteration + " — Tray App đã kết nối.");
                // Giao qua Task.Run — KHÔNG gọi trực tiếp: code của handler
                // (kể cả phần đồng bộ trước await đầu tiên) không bao giờ
                // được chạy trên thread của vòng accept. Log thật sáng
                // 17/11/2026: vòng accept kẹt ngay sau "đã kết nối" (không
                // có dòng "đã giao", không có accept #2, watchdog kêu) dù
                // không có lỗi nào — vòng lặp chỉ an toàn khi handler chạy
                // trên task riêng của nó. Handler tự dispose stream khi xong.
                // Chụp stream vào biến cục bộ: lambda bắt BIẾN server, mà
                // server bị gán null ngay sau đó — không chụp thì handler
                // có thể nhận null.
                NamedPipeServerStream connected = server;
                _ = Task.Run(() => HandleClientAsync(connected, stoppingToken), stoppingToken);
                server = null;
                _log.Info("IPC: accept #" + iteration + " — đã giao kết nối cho handler, tạo instance mới.");
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                server?.Dispose();
                _log.Info("IPC: accept #" + iteration + " — dừng theo yêu cầu, vòng accept kết thúc.");
                break;
            }
            catch (Exception ex)
            {
                server?.Dispose();
                _log.Error("IPC: accept #" + iteration + " lỗi (tạo pipe hoặc chờ kết nối thất bại), thử lại sau 5 giây.", ex);
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    _log.Info("IPC: vòng accept dừng trong lúc chờ thử lại.");
                    break;
                }
            }
        }

        _log.Info("IPC: server dừng.");
    }

    /// <summary>
    /// Watchdog của vòng accept: chạy mỗi 60s, chỉ ĐỌC trạng thái và ghi log.
    /// Không bao giờ dispose/tạo lại listener hay handler — tự khôi phục mù
    /// có thể phá kết nối đang sống. Mỗi đợt yên lặng chỉ cảnh báo một lần
    /// (đếm theo số vòng accept) để log không bị lấp đầy khi máy thật sự
    /// không có Tray nào nối tới trong thời gian dài.
    /// </summary>
    private void WatchdogTick(object? state)
    {
        try
        {
            // Vòng accept đang chờ client nối tới là trạng thái bình thường —
            // không kêu, nếu không log đầy cảnh báo giả (gặp ngày 17/11/2026).
            if (_waitingForConnection)
            {
                return;
            }

            long lastTicks = Interlocked.Read(ref _lastAcceptIterationTicks);
            if (lastTicks == 0)
            {
                return;
            }

            long count = Interlocked.Read(ref _acceptIterationCount);
            TimeSpan quiet = DateTimeOffset.UtcNow - new DateTimeOffset(lastTicks, TimeSpan.Zero);
            if (quiet > WatchdogStallThreshold && Interlocked.Read(ref _lastWatchdogWarnedCount) != count)
            {
                Interlocked.Exchange(ref _lastWatchdogWarnedCount, count);
                _log.Warning("IPC WATCHDOG: vòng accept không bắt đầu vòng mới trong "
                    + quiet.TotalSeconds.ToString("F0", CultureInfo.InvariantCulture)
                    + " giây (vòng gần nhất #" + count + "). Có thể vòng accept đã kẹt — kiểm tra log accept gần nhất. Watchdog chỉ ghi log, không tự khôi phục.");
            }
        }
        catch
        {
            // Watchdog không được ném exception ra thread pool.
        }
    }

    /// <summary>Tạo pipe server với ACL: SYSTEM toàn quyền, Users đọc/ghi.</summary>
    private static NamedPipeServerStream CreatePipeServer()
    {
        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            PipeAccessRights.FullControl,
            AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null),
            PipeAccessRights.ReadWrite,
            AccessControlType.Allow));

        return NamedPipeServerStreamAcl.Create(
            AgentConstants.IpcPipeName,
            PipeDirection.InOut,
            // Cho phép nhiều instance chờ sẵn để nhiều session nối cùng lúc.
            maxNumberOfServerInstances: 8,
            transmissionMode: PipeTransmissionMode.Byte,
            options: PipeOptions.Asynchronous,
            inBufferSize: 0,
            outBufferSize: 0,
            pipeSecurity: security);
    }

    private async Task HandleClientAsync(NamedPipeServerStream server, CancellationToken ct)
    {
        // Handler chạy nền, không được ném exception ra ngoài (ExecuteAsync
        // không await nó) — mọi lỗi đều ghi log tại đây. Stream do handler
        // sở hữu và dispose khi xong.
        long handlerId = Interlocked.Increment(ref _handlerCount);
        _log.Info("IPC: handler #" + handlerId + " bắt đầu đọc từ Tray App.");

        StreamWriter? writer = null;
        long receivedCount = 0;
        try
        {
            using var reader = new StreamReader(server, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, bufferSize: 1024, leaveOpen: true);
            writer = new StreamWriter(server, Encoding.UTF8, bufferSize: 1024, leaveOpen: true) { AutoFlush = true };
            int writerCount;
            lock (_writersLock)
            {
                _clientWriters.Add(writer);
                writerCount = _clientWriters.Count;
            }

            // Chẩn đoán 17/11/2026: dòng này chứng minh handler đã đăng ký
            // writer — log bản 0.1.122 cho thấy handler bắt đầu đọc nhưng
            // mọi lần gửi đều thấy danh sách rỗng.
            _log.Info("IPC: handler #" + handlerId + " đã đăng ký writer #" + writer.GetHashCode() + " (tổng " + writerCount + " writer).");

            // KHÔNG kiểm tra server.IsConnected (cờ này không đáng tin —
            // xem ghi chú ở IpcPipeClient): chỉ thoát khi đọc được null,
            // ném exception, Service dừng, hoặc idle quá 120 giây.
            //
            // ĐỌC BẰNG THREAD RIÊNG (sửa 17/11/2026): mẫu WhenAny giữa
            // ReadLineAsync và Task.Delay KHÔNG hoạt động trên máy thật —
            // log bản 0.1.122 cho thấy cả hai phía kẹt mãi sau khi nối,
            // timeout 120s không bao giờ kích hoạt dù Task.Delay ở vòng
            // kiểm tra rules vẫn chạy đúng chu kỳ. Mẫu mới: một thread đọc
            // đồng bộ (ReadLine chặn) đẩy dòng vào Channel; vòng xử lý
            // async đọc Channel; watchdog riêng dispose stream khi im lặng
            // quá 120s để giải phóng lần đọc đang chặn. Không còn WhenAny
            // nào dính tới lần đọc pipe.
            Channel<string> channel = Channel.CreateUnbounded<string>(
                new UnboundedChannelOptions { SingleReader = true, SingleWriter = true });
            long lastActivityTicks = DateTimeOffset.UtcNow.UtcTicks;

            Task readerTask = Task.Run(() =>
            {
                try
                {
                    while (true)
                    {
                        string? readLine = reader.ReadLine();
                        if (readLine is null)
                        {
                            _log.Info("IPC: handler #" + handlerId + " — Tray App đã đóng kết nối (EOF).");
                            break;
                        }

                        channel.Writer.TryWrite(readLine);
                    }
                }
                catch (Exception ex) when (ex is IOException or ObjectDisposedException)
                {
                    // Pipe đóng/gãy (kể cả do watchdog dispose khi idle):
                    // thoát thread đọc, vòng xử lý kết thúc khi Channel đóng.
                }
                catch (Exception ex)
                {
                    _log.Error("IPC: handler #" + handlerId + " lỗi thread đọc.", ex);
                }
                finally
                {
                    channel.Writer.TryComplete();
                }
            }, ct);

            // Watchdog idle: kiểm tra mỗi 30s, im lặng quá 120s thì dispose
            // stream (giải phóng ReadLine đang chặn) rồi thoát. Dùng CTS
            // riêng nối với ct để vòng xử lý hủy watchdog ngay khi Channel
            // đóng (không chờ tới kỳ kiểm tra 30s sau).
            using var watchdogCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            // Chụp token trước Task.Run: getter Token ném ObjectDisposedException
            // sau khi CTS bị dispose (review batch #5) — token đã chụp thì an toàn.
            CancellationToken watchdogToken = watchdogCts.Token;
            Task watchdogTask = Task.Run(async () =>
            {
                try
                {
                    while (!watchdogToken.IsCancellationRequested)
                    {
                        await Task.Delay(TimeSpan.FromSeconds(30), watchdogToken).ConfigureAwait(false);
                        long idleTicks = DateTimeOffset.UtcNow.UtcTicks - Volatile.Read(ref lastActivityTicks);
                        if (TimeSpan.FromTicks(idleTicks) > IdleTimeout)
                        {
                            _log.Warning("IPC: handler #" + handlerId + " idle quá 120 giây không có dòng nào, thu hồi kết nối (giải phóng pipe instance).");
                            try
                            {
                                server.Dispose();
                            }
                            catch
                            {
                                // Bỏ qua lỗi đóng stream cũ.
                            }

                            break;
                        }
                    }
                }
                catch (OperationCanceledException)
                {
                    // Service dừng hoặc Channel đã đóng: watchdog thoát.
                }
            }, watchdogToken);

            await foreach (string line in channel.Reader.ReadAllAsync(ct).ConfigureAwait(false))
            {
                Volatile.Write(ref lastActivityTicks, DateTimeOffset.UtcNow.UtcTicks);
                receivedCount++;

                IpcMessage? message = IpcMessage.FromLine(line);
                if (message is not null)
                {
                    // Xử lý message có giới hạn chờ 15 giây: một lần ghi DB
                    // kẹt không được treo vòng xử lý mãi. Quá hạn thì bỏ chờ,
                    // ghi log và đọc tiếp — tác vụ nền vẫn chạy, lỗi muộn
                    // của nó vẫn được ghi log.
                    Task handleTask = HandleMessageAsync(message, ct);
                    Task finished = await Task.WhenAny(handleTask, Task.Delay(TimeSpan.FromSeconds(15), ct)).ConfigureAwait(false);
                    if (ct.IsCancellationRequested)
                    {
                        break;
                    }

                    if (finished != handleTask)
                    {
                        _log.Warning("IPC: handler #" + handlerId + " xử lý message " + message.Type + " quá 15 giây, bỏ chờ và tiếp tục đọc.");
                        _ = handleTask.ContinueWith(
                            t => _log.Error("IPC: handler #" + handlerId + " xử lý message " + message.Type + " lỗi sau khi bỏ chờ.", t.Exception),
                            TaskContinuationOptions.OnlyOnFaulted);
                    }
                    else
                    {
                        // Ném lại exception (nếu có) vào catch của handler.
                        await handleTask.ConfigureAwait(false);
                    }
                }
            }

            // Channel đã đóng (thread đọc thoát): hủy watchdog, dispose
            // stream để giải phóng ReadLine đang chặn (đường break khi
            // Service dừng: không có gì dispose stream trước lần await này
            // thì await readerTask treo mãi — review batch #5), rồi chờ cả
            // hai task kết thúc hẳn trước khi finally dọn writer/stream.
            // Dispose lại ở finally là an toàn.
            watchdogCts.Cancel();
            try
            {
                server.Dispose();
            }
            catch
            {
                // Bỏ qua lỗi đóng stream cũ.
            }

            try
            {
                await readerTask.ConfigureAwait(false);
            }
            catch
            {
                // Thread đọc đã ghi log lỗi của nó; không ném thêm.
            }

            try
            {
                await watchdogTask.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Watchdog dừng theo yêu cầu khi Service dừng.
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            _log.Info("IPC: handler #" + handlerId + " dừng theo yêu cầu.");
        }
        catch (Exception ex)
        {
            _log.Error("IPC: handler #" + handlerId + " lỗi khi đọc từ Tray App.", ex);
        }
        finally
        {
            if (writer is not null)
            {
                int remainingWriters;
                lock (_writersLock)
                {
                    _clientWriters.Remove(writer);
                    remainingWriters = _clientWriters.Count;
                }

                _log.Info("IPC: handler #" + handlerId + " đã gỡ writer #" + writer.GetHashCode() + " (còn " + remainingWriters + " writer).");

                try
                {
                    writer.Dispose();
                }
                catch
                {
                    // Bỏ qua lỗi đóng writer khi pipe đã gãy (gặp ở log
                    // Service 14:43 ngày 2026-11-16: IOException "Pipe is
                    // broken" từ Dispose khi client bị dừng đột ngột).
                }
            }

            try
            {
                server.Dispose();
            }
            catch
            {
                // Bỏ qua lỗi đóng pipe đã gãy.
            }

            _log.Info("IPC: handler #" + handlerId + " — Tray App đã ngắt kết nối (đã nhận " + receivedCount + " message).");
        }
    }

    private async Task HandleMessageAsync(IpcMessage message, CancellationToken ct)
    {
        switch (message.Type)
        {
            case IpcMessageTypes.UsageSample:
                UsageSamplePayload? sample = message.GetPayload<UsageSamplePayload>();
                if (sample is not null)
                {
                    await _outbox.RecordUsageSampleAsync(sample, ct);
                }
                break;

            case IpcMessageTypes.ForegroundChanged:
                ForegroundChangedPayload? foreground = message.GetPayload<ForegroundChangedPayload>();
                if (foreground is not null)
                {
                    _foregroundState.Report(foreground);
                }
                break;

            case IpcMessageTypes.ExtraTimeRequest:
                // TODO Sprint 2: ghi yêu cầu vào bảng requests qua Supabase để
                // phụ huynh duyệt trên Dashboard, rồi nhận quyết định qua commands.
                _log.Info("IPC: nhận yêu cầu xin thêm giờ (skeleton, chưa gửi lên server).");
                break;

            default:
                _log.Warning("IPC: message không rõ loại, bỏ qua: " + message.Type);
                break;
        }
    }
}
