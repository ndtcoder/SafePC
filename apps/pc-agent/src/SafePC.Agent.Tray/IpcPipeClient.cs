using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
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
    private StreamWriter? _writer;
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
                string outcome = await ConnectAndReadAsync(ct);
                if (!ct.IsCancellationRequested && !_disposed)
                {
                    _log.Warning("IPC: phiên kết nối kết thúc (" + outcome + "), thử lại sau 5 giây.");
                }
                else
                {
                    _log.Info("IPC: phiên kết nối kết thúc (" + outcome + "), đang dừng.");
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
                await Task.Delay(TimeSpan.FromSeconds(5), ct);
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
        _pipe = new NamedPipeClientStream(".", AgentConstants.IpcPipeName, PipeDirection.InOut, PipeOptions.Asynchronous);

        // ConnectAsync không timeout sẽ chờ mãi nếu server chưa tạo pipe —
        // giới hạn 10 giây để lỗi hiện rõ trong log thay vì im lặng (gặp ở
        // log Tray đợt 13:32–14:02 ngày 2026-11-16: chờ nửa tiếng không lỗi).
        using var connectCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        connectCts.CancelAfter(TimeSpan.FromSeconds(10));
        try
        {
            await _pipe.ConnectAsync(connectCts.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            _log.Error("IPC: không nối được tới Service trong 10 giây (pipe chưa sẵn sàng?), thử lại sau 5 giây.");
            return "connect-timeout";
        }

        _log.Info("IPC: đã kết nối tới Service.");
        _writer = new StreamWriter(_pipe, Encoding.UTF8, bufferSize: 1024, leaveOpen: true) { AutoFlush = true };

        using var reader = new StreamReader(_pipe, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, bufferSize: 1024, leaveOpen: true);
        // KHÔNG kiểm tra _pipe.IsConnected ở đây (xem ghi chú ở đầu file):
        // chỉ thoát khi ReadLineAsync trả về null (server đóng), ném
        // exception, idle quá 120 giây, hoặc token bị hủy — mọi đường thoát
        // đều ghi log. Mỗi lần đọc dùng một CancellationTokenSource liên
        // kết riêng với CancelAfter(120s), cùng mẫu với phía server.
        while (!ct.IsCancellationRequested)
        {
            string? line;
            bool idleTimedOut = false;
            using (var readCts = CancellationTokenSource.CreateLinkedTokenSource(ct))
            {
                readCts.CancelAfter(ReadIdleTimeout);
                try
                {
                    line = await reader.ReadLineAsync(readCts.Token);
                }
                catch (OperationCanceledException)
                {
                    if (ct.IsCancellationRequested)
                    {
                        return "stopping";
                    }

                    idleTimedOut = true;
                    line = null;
                }
            }

            if (idleTimedOut)
            {
                _log.Warning("IPC: không nhận message nào trong 120 giây, đóng kết nối để nối lại.");
                return "idle-timeout";
            }

            if (line is null)
            {
                _log.Warning("IPC: Service đã đóng kết nối, thử lại sau 5 giây.");
                return "closed-by-server";
            }

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

        return "stopping";
    }

    /// <summary>
    /// Gửi một message lên Service. Bỏ qua (ghi log chống spam) nếu chưa kết
    /// nối. Chờ khóa ghi tối đa 5 giây: quá hạn thì bỏ message đó chứ không
    /// chặn sampler/UI thread vô hạn.
    /// </summary>
    public async Task SendAsync(IpcMessage message)
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
                _log.Warning("IPC: chưa kết nối tới Service, bỏ qua message " + message.Type + ".");
            }

            return;
        }

        // Không kiểm tra _pipe.IsConnected (xem ghi chú ở đầu file): cứ ghi,
        // lỗi ghi sẽ hiện rõ trong log và vòng đọc sẽ tự nối lại.

        bool entered = await _writeGate.WaitAsync(WriteGateTimeout);
        if (!entered)
        {
            _log.Warning("IPC: chờ khóa ghi quá 5 giây, bỏ qua message " + message.Type + " (không chặn sampler).");
            return;
        }

        try
        {
            await writer.WriteLineAsync(message.ToLine());
            await writer.FlushAsync();
        }
        catch (Exception ex)
        {
            _log.Error("IPC: không gửi được message tới Service.", ex);
        }
        finally
        {
            _writeGate.Release();
        }
    }

    private void CleanupConnection()
    {
        // Ghi log MỌI lần dọn kết nối: log thật ngày 17/11/2026 cho thấy
        // _writer thành null mà không có một dòng outcome nào — dòng này cho
        // biết chính xác khi nào writer bị dọn, để lần sau phân biệt được
        // "vòng đọc thoát" với "writer null bí ẩn".
        _log.Warning("IPC: dọn kết nối (đóng writer/pipe, lần nối sau sẽ tạo mới).");
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
