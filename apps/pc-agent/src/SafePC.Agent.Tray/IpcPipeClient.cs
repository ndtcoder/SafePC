using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Channels;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Tray;

/// <summary>
/// Named Pipe client nối tới Service (pipe server, xem IpcPipeServer).
/// - Giữ kết nối thường trực: Service gửi warning/lock xuống bất cứ lúc nào.
/// - Tự kết nối lại sau 5 giây nếu mất kết nối.
/// - Giao thức: JSON theo dòng, như phía server. Ghi chú ACL phía server:
///   pipe chỉ cho SYSTEM và nhóm Users kết nối (docs/03-SECURITY.md mục 4).
///
/// Ghi chú 2026-11-16 (lỗi thật trên máy test): KHÔNG dùng
/// NamedPipeClientStream.IsConnected để quyết định nối/rớt — cờ này có thể
/// báo false ngay sau khi ConnectAsync thành công, khiến vòng đọc thoát im
/// lặng trong khi server vẫn giữ kết nối chết (log Tray 14:35 ngày
/// 2026-11-16: "đã kết nối" rồi rớt ngay, server giữ kết nối tới 8 phút).
/// Mọi quyết định nối/rớt đều dựa vào kết quả I/O thật (ReadLineAsync/
/// WriteLineAsync) và mọi lần rớt kết nối đều phải ghi log.
///
/// CHỐNG KẸT IM LẶNG (chẩn đoán từ log thật tối 16/11/2026): vòng nối lại
/// của Tray đã im lặng suốt 24 phút không một dòng log nối/timeout nào.
/// Từ bản này: mọi lần đọc đều có idle timeout 120 giây (khớp phía server —
/// Service gửi cảnh báo/khóa không thường xuyên, nhưng kết nối sống vẫn bị
/// thu hồi sau 120s im lặng rồi nối lại ngay, nên không có kết nối chết nào
/// nằm im mãi); mọi đường thoát của vòng đọc đều ghi log kèm kết quả
/// (connected/timeout/closed/exception); chờ khóa ghi tối đa 5 giây để một
/// lần ghi kẹt không bao giờ chặn sampler; cảnh báo "chưa kết nối" chống
/// spam tối đa 1 lần/60 giây.
///
/// SỬA 17/11/2026 (log thật: lần đọc kẹt 37 phút rồi kẹt mãi sau khi nối,
/// idle timeout không bao giờ kích hoạt ở cả hai mẫu CancelAfter lẫn
/// Task.WhenAny): lần đọc pipe nay chạy trên thread riêng (ReadLine đồng bộ
/// chặn) đẩy dòng vào Channel, watchdog riêng dispose pipe khi idle quá
/// 120s. Mọi await trong class này đều ConfigureAwait(false) và App.xaml.cs
/// khởi động vòng đọc qua Task.Run, để vòng đọc không bao giờ tiếp tục chạy
/// trên UI thread (bản 0.1.122 đã chứng minh mẫu này chữa được hiện tượng
/// "chuột chết khi pipe đang nối" quan sát được ngày 17/11/2026).
/// </summary>
public sealed class IpcPipeClient : IDisposable
{
    /// <summary>
    /// Idle timeout cho mỗi lần đọc: 120 giây không có dòng nào thì đóng và
    /// nối lại. PHẢI khớp phía server (IpcPipeServer.IdleTimeout).
    /// </summary>
    private static readonly TimeSpan ReadIdleTimeout = TimeSpan.FromSeconds(120);

    /// <summary>Chờ khóa ghi tối đa 5 giây: quá hạn thì bỏ message đó, không chặn sampler.</summary>
    private static readonly TimeSpan WriteGateTimeout = TimeSpan.FromSeconds(5);

    /// <summary>Chống spam cảnh báo "chưa kết nối": tối đa 1 lần/60 giây.</summary>
    private static readonly TimeSpan NoConnectionLogThrottle = TimeSpan.FromSeconds(60);

    private readonly LocalLogger _log;
    private readonly SemaphoreSlim _writeGate = new(1, 1);
    private readonly object _logThrottleLock = new();
    private DateTimeOffset _lastNoConnectionLogAt;

    private NamedPipeClientStream? _pipe;

    // volatile: ghi từ vòng đọc, đọc từ sampler (thread khác) — tránh đọc
    // stale kéo dài (nghi vấn từ log 17/11: _writer null bí ẩn).
    private volatile StreamWriter? _writer;
    private bool _disposed;

    /// <summary>Xảy ra khi nhận được một message từ Service (chạy trên thread đọc pipe).</summary>
    public event Action<IpcMessage>? MessageReceived;

    public IpcPipeClient(LocalLogger log)
    {
        _log = log;
    }

    /// <summary>
    /// Vòng lặp kết nối + đọc message. Chạy cho tới khi token bị hủy hoặc
    /// Dispose. MỌI lần lặp đều ghi log kết quả — không có đường thoát im
    /// lặng nào: nối thành công rồi rớt, timeout, đóng, hay exception đều
    /// hiện trong log để lần kẹt sau (nếu có) nhìn thấy được.
    /// </summary>
    public async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && !_disposed)
        {
            try
            {
                string outcome = await ConnectAndReadAsync(ct).ConfigureAwait(false);
                if (!ct.IsCancellationRequested && !_disposed)
                {
                    _log.Warning("IPC: [client #" + GetHashCode() + "] phiên kết nối kết thúc (" + outcome + "), thử lại sau 5 giây.");
                }
                else
                {
                    _log.Info("IPC: [client #" + GetHashCode() + "] phiên kết nối kết thúc (" + outcome + "), đang dừng.");
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                _log.Info("IPC: vòng kết nối dừng theo yêu cầu.");
                break;
            }
            catch (Exception ex)
            {
                _log.Error("IPC: mất kết nối tới Service (exception), thử lại sau 5 giây.", ex);
            }
            finally
            {
                CleanupConnection();
            }

            try
            {
                await Task.Delay(TimeSpan.FromSeconds(5), ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }

        _log.Info("IPC: vòng kết nối đã thoát.");
    }

    /// <summary>
    /// Nối tới Service rồi đọc message cho tới khi server đóng kết nối, idle
    /// quá 120 giây, hoặc token bị hủy. Trả về chuỗi kết quả của phiên
    /// (connect-timeout / closed-by-server / idle-timeout / stopping) — nơi
    /// gọi ghi log kết quả này; exception I/O thì ném lên RunAsync ghi log.
    /// Không bao giờ trả về im lặng mà không có kết quả rõ ràng.
    /// </summary>
    private async Task<string> ConnectAndReadAsync(CancellationToken ct)
    {
        // Chụp pipe vào biến cục bộ: vòng đọc chỉ chạm tới bản cục bộ này,
        // nên lần đọc bị bỏ (idle timeout) không bao giờ động vào kết nối
        // mới của lần lặp sau. Field _pipe chỉ để CleanupConnection dọn.
        NamedPipeClientStream pipe = new NamedPipeClientStream(".", AgentConstants.IpcPipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        _pipe = pipe;

        // ConnectAsync không timeout sẽ chờ mãi nếu server chưa tạo pipe —
        // giới hạn 10 giây để lỗi hiện rõ trong log thay vì im lặng (gặp ở
        // log Tray đợt 13:32–14:02 ngày 2026-11-16: chờ nửa tiếng không lỗi).
        using var connectCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        connectCts.CancelAfter(TimeSpan.FromSeconds(10));
        try
        {
            await pipe.ConnectAsync(connectCts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            _log.Error("IPC: không nối được tới Service trong 10 giây (pipe chưa sẵn sàng?), thử lại sau 5 giây.");
            return "connect-timeout";
        }

        _log.Info("IPC: đã kết nối tới Service (client #" + GetHashCode() + ").");
        // KHÔNG dùng AutoFlush trên pipe (xem ghi chú ở IpcPipeServer): setter
        // gọi Flush() → FlushFileBuffers chặn tới khi Service ĐỌC — chết chéo
        // với handler phía Service cũng đang kẹt ở cùng chỗ (run CI
        // #127/#129/#131/#133: "writer đã sẵn sàng" không bao giờ xuất hiện).
        // SendAsync đã FlushAsync tường minh sau mỗi lần ghi.
        _writer = new StreamWriter(pipe, Encoding.UTF8, bufferSize: 1024, leaveOpen: true);
        // Breadcrumb mịn (run CI #127/#129/#131: client im lặng giữa "đã kết
        // nối" và "writer đã sẵn sàng" — khoảng giữa chỉ có ctor
        // StreamWriter, về lý thuyết không thể chặn. Dòng này xác định ctor
        // có hoàn tất hay điểm treo nằm ở lần ghi log sau đó.)
        _log.Info("IPC: writer đã tạo (client #" + GetHashCode() + ").");

        // Chẩn đoán 17/11/2026: dòng này chứng minh writer đã được gán —
        // log bản 0.1.122 cho thấy "đã kết nối" nhưng ngay sau đó sampler
        // vẫn báo "chưa kết nối" (writer null) mà không có dòng dọn nào.
        _log.Info("IPC: writer đã sẵn sàng (client #" + GetHashCode() + ").");

        // HELLO: giới thiệu phiên/tài khoản/quyền admin để Service chỉ giao
        // lệnh khóa/cảnh báo tới phiên của con (phiên admin được miễn).
        // FlushAsync chờ thread đọc của Service, vốn chạy độc lập sau khi
        // handler đăng ký, nên không chết chéo. Hello lỗi thì bỏ qua:
        // Service coi phiên này như chưa rõ và vẫn giao lệnh khóa như
        // thường (fail-closed).
        try
        {
            int sessionId = Process.GetCurrentProcess().SessionId;
            (string helloUserName, bool helloIsAdmin, string elevationType, string? helloSid) = DescribeCurrentUser();
            await SendAsync(IpcMessage.Create(
                IpcMessageTypes.Hello,
                new HelloPayload(sessionId, helloUserName, helloIsAdmin, helloSid))).ConfigureAwait(false);
            _log.Info("IPC: đã gửi hello (phiên #" + sessionId + ", " + helloUserName + ", admin=" + helloIsAdmin + ", elevation=" + elevationType
                + (helloSid is null ? ", chưa lấy được SID" : ", đã gửi SID") + ").");
        }
        catch (Exception ex)
        {
            _log.Error("IPC: gửi hello lỗi (bỏ qua, vẫn nhận lệnh khóa như thường).", ex);
        }

        using var reader = new StreamReader(pipe, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, bufferSize: 1024, leaveOpen: true);
        // KHÔNG kiểm tra pipe.IsConnected ở đây (xem ghi chú ở đầu file):
        // chỉ thoát khi ReadLine trả về null (server đóng), ném exception,
        // idle quá 120 giây, hoặc token bị hủy — mọi đường thoát đều ghi log.
        //
        // ĐỌC BẰNG THREAD RIÊNG (sửa 17/11/2026): mẫu WhenAny giữa
        // ReadLineAsync và Task.Delay KHÔNG hoạt động trên máy thật — log
        // bản 0.1.122 cho thấy vòng đọc kẹt mãi sau khi nối, timeout 120s
        // không bao giờ kích hoạt. Mẫu mới: một thread đọc đồng bộ (ReadLine
        // chặn) đẩy dòng vào Channel; vòng xử lý async đọc Channel; watchdog
        // riêng dispose pipe khi im lặng quá 120s để giải phóng lần đọc đang
        // chặn. Không còn WhenAny nào dính tới lần đọc pipe.
        Channel<string> channel = Channel.CreateUnbounded<string>(
            new UnboundedChannelOptions { SingleReader = true, SingleWriter = true });
        long lastActivityTicks = DateTimeOffset.UtcNow.UtcTicks;
        bool idleTimedOut = false;

        Task readerTask = Task.Run(() =>
        {
            try
            {
                while (true)
                {
                    string? readLine = reader.ReadLine();
                    if (readLine is null)
                    {
                        _log.Info("IPC: Service đã đóng kết nối (EOF).");
                        break;
                    }

                    channel.Writer.TryWrite(readLine);
                }
            }
            catch (Exception ex) when (ex is IOException or ObjectDisposedException)
            {
                // Pipe đóng/gãy (kể cả do watchdog dispose khi idle): thoát
                // thread đọc, vòng xử lý kết thúc khi Channel đóng.
            }
            catch (Exception ex)
            {
                _log.Error("IPC: lỗi thread đọc.", ex);
            }
            finally
            {
                channel.Writer.TryComplete();
            }
        }, ct);

        // Watchdog idle: kiểm tra mỗi 30s, im lặng quá 120s thì dispose pipe
        // (giải phóng ReadLine đang chặn) rồi thoát. Dùng CTS riêng nối với
        // ct để vòng xử lý hủy watchdog ngay khi Channel đóng.
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
                    if (TimeSpan.FromTicks(idleTicks) > ReadIdleTimeout)
                    {
                        _log.Warning("IPC: không nhận message nào trong 120 giây, đóng kết nối để nối lại.");
                        idleTimedOut = true;
                        try
                        {
                            pipe.Dispose();
                        }
                        catch
                        {
                            // Bỏ qua lỗi đóng pipe cũ.
                        }

                        break;
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // Đang dừng hoặc Channel đã đóng: watchdog thoát.
            }
        }, watchdogToken);

        await foreach (string line in channel.Reader.ReadAllAsync(ct).ConfigureAwait(false))
        {
            Volatile.Write(ref lastActivityTicks, DateTimeOffset.UtcNow.UtcTicks);

            IpcMessage? message = IpcMessage.FromLine(line);
            if (message is not null)
            {
                // Một message lỗi không được làm chết vòng đọc: bắt + ghi
                // log từng message, vòng lặp tiếp tục với message sau.
                try
                {
                    MessageReceived?.Invoke(message);
                }
                catch (Exception ex)
                {
                    _log.Error("IPC: xử lý message " + message.Type + " lỗi, tiếp tục nhận message sau.", ex);
                }
            }
        }

        // Channel đã đóng (thread đọc thoát): hủy watchdog rồi chờ cả hai
        // task kết thúc hẳn trước khi trả về kết quả phiên.
        watchdogCts.Cancel();
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
            // Watchdog dừng theo yêu cầu khi đang dừng.
        }

        if (ct.IsCancellationRequested)
        {
            return "stopping";
        }

        return idleTimedOut ? "idle-timeout" : "closed-by-server";
    }

    /// <summary>
    /// Gửi một message lên Service. Bỏ qua (ghi log chống spam) nếu chưa kết
    /// nối. Chờ khóa ghi tối đa 5 giây: quá hạn thì bỏ message đó chứ không
    /// chặn sampler/UI thread vô hạn.
    /// </summary>
    /// <returns>True khi đã ghi + flush thành công; false khi chưa kết nối,
    /// chờ khóa ghi quá hạn, hoặc ghi lỗi — nơi gọi dùng giá trị này để
    /// quyết định có thử lại không (xem ForegroundSampler: báo cáo
    /// foreground-changed bị rớt phải được gửi lại ở mẫu sau, không được
    /// coi như đã gửi).</returns>
    public async Task<bool> SendAsync(IpcMessage message)
    {
        ArgumentNullException.ThrowIfNull(message);

        StreamWriter? writer = _writer;
        if (writer is null)
        {
            bool due;
            DateTimeOffset now = DateTimeOffset.UtcNow;
            lock (_logThrottleLock)
            {
                due = now - _lastNoConnectionLogAt >= NoConnectionLogThrottle;
                if (due)
                {
                    _lastNoConnectionLogAt = now;
                }
            }

            if (due)
            {
                _log.Warning("IPC: [client #" + GetHashCode() + "] chưa kết nối tới Service, bỏ qua message " + message.Type + ".");
            }

            return false;
        }

        // Không kiểm tra _pipe.IsConnected (xem ghi chú ở đầu file): cứ ghi,
        // lỗi ghi sẽ hiện rõ trong log và vòng đọc sẽ tự nối lại.

        bool entered = await _writeGate.WaitAsync(WriteGateTimeout).ConfigureAwait(false);
        if (!entered)
        {
            _log.Warning("IPC: chờ khóa ghi quá 5 giây, bỏ qua message " + message.Type + " (không chặn sampler).");
            return false;
        }

        try
        {
            await writer.WriteLineAsync(message.ToLine()).ConfigureAwait(false);
            await writer.FlushAsync().ConfigureAwait(false);
            return true;
        }
        catch (Exception ex)
        {
            _log.Error("IPC: không gửi được message tới Service.", ex);
            return false;
        }
        finally
        {
            _writeGate.Release();
        }
    }

    /// <summary>
    /// Tên tài khoản (DOMAIN\user), quyền admin và loại elevation của phiên
    /// Tray đang chạy. QUAN TRỌNG: KHÔNG dùng riêng
    /// IsInRole(Administrator) — Tray chạy qua Run key nên không elevated,
    /// token đã lọc bởi UAC, IsInRole luôn trả false kể cả khi tài khoản
    /// thuộc nhóm Administrators (Microsoft Learn: "The code returns false
    /// if you are in the standard user role, even if you are in the
    /// Built-in Administrators group"). Kiểm tra tư cách TÀI KHOẢN qua
    /// TokenElevationType: Full/Limited (có split token) nghĩa là admin;
    /// Default nghĩa là standard user. Lỗi thì trả về không admin
    /// (fail-closed: phiên chưa rõ vẫn nhận lệnh khóa).
    /// SID lấy từ cùng identity (<c>WindowsIdentity.GetCurrent().User</c>)
    /// để Service biết phiên này là hồ sơ con nào (Sprint 5); không lấy
    /// được thì null — Service fallback về con mặc định như Tray cũ.
    /// </summary>
    private static (string UserName, bool IsAdmin, string ElevationType, string? Sid) DescribeCurrentUser()
    {
        try
        {
            using WindowsIdentity identity = WindowsIdentity.GetCurrent();
            string name = identity.Name;
            string? sid = identity.User?.Value;
            if (new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
            {
                // Đã elevated: chắc chắn là admin, khỏi hỏi token. Nhãn
                // "elevated" (không phải "Full"): khi UAC tắt, token của
                // admin thực chất là Default nhưng vẫn elevated.
                return (name, true, "elevated", sid);
            }

            string elevationType = GetTokenElevationType();
            bool isAdmin = elevationType is "Full" or "Limited";
            return (name, isAdmin, elevationType, sid);
        }
        catch
        {
            return (Environment.UserName, false, "unknown", null);
        }
    }

    private const uint TokenQueryAccess = 0x0008;
    private const int TokenElevationTypeClass = 18;

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr tokenHandle, int tokenInformationClass, out int tokenInformation, uint tokenInformationLength, out uint returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    /// <summary>
    /// Loại elevation của token process hiện tại: "Default" (1, không split
    /// token — standard user), "Full" (2) hoặc "Limited" (3, admin chạy
    /// token thường) — "unknown" khi P/Invoke lỗi.
    /// </summary>
    private static string GetTokenElevationType()
    {
        using var proc = Process.GetCurrentProcess();
        IntPtr processHandle = proc.Handle;
        if (!OpenProcessToken(processHandle, TokenQueryAccess, out IntPtr tokenHandle))
        {
            return "unknown";
        }

        try
        {
            if (!GetTokenInformation(tokenHandle, TokenElevationTypeClass, out int elevation, (uint)sizeof(int), out _))
            {
                return "unknown";
            }

            return elevation switch
            {
                1 => "Default",
                2 => "Full",
                3 => "Limited",
                _ => "unknown",
            };
        }
        finally
        {
            CloseHandle(tokenHandle);
        }
    }

    private void CleanupConnection()
    {
        // Ghi log MỌI lần dọn kết nối: log thật ngày 17/11/2026 cho thấy
        // _writer thành null mà không có một dòng outcome nào — dòng này cho
        // biết chính xác khi nào writer bị dọn, để lần sau phân biệt được
        // "vòng đọc thoát" với "writer null bí ẩn".
        _log.Warning("IPC: [client #" + GetHashCode() + "] dọn kết nối (đóng writer/pipe, lần nối sau sẽ tạo mới).");
        try
        {
            _writer?.Dispose();
        }
        catch
        {
            // Bỏ qua lỗi đóng kết nối cũ.
        }

        _writer = null;

        try
        {
            _pipe?.Dispose();
        }
        catch
        {
            // Bỏ qua lỗi đóng kết nối cũ.
        }

        _pipe = null;
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        CleanupConnection();
        _writeGate.Dispose();
    }
}
