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
/// </summary>
public sealed class IpcPipeClient : IDisposable
{
    private readonly LocalLogger _log;
    private readonly SemaphoreSlim _writeGate = new(1, 1);

    private NamedPipeClientStream? _pipe;
    private StreamWriter? _writer;
    private bool _disposed;

    /// <summary>Xảy ra khi nhận được một message từ Service (chạy trên thread đọc pipe).</summary>
    public event Action<IpcMessage>? MessageReceived;

    public IpcPipeClient(LocalLogger log)
    {
        _log = log;
    }

    /// <summary>Vòng lặp kết nối + đọc message. Chạy cho tới khi token bị hủy hoặc Dispose.</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && !_disposed)
        {
            try
            {
                await ConnectAndReadAsync(ct);
                if (!ct.IsCancellationRequested && !_disposed)
                {
                    // ConnectAndReadAsync trả về mà không qua các đường đã
                    // ghi log (timeout, server đóng, exception): ghi rõ để
                    // lần rớt kết nối nào cũng hiện trong log, không im lặng.
                    _log.Warning("IPC: phiên kết nối kết thúc, thử lại sau 5 giây.");
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _log.Error("IPC: mất kết nối tới Service, thử lại sau 5 giây.", ex);
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
    }

    /// <summary>
    /// Nối tới Service rồi đọc message cho tới khi server đóng kết nối hoặc
    /// token bị hủy. Trả về (không ném) khi hết timeout nối hoặc server đóng
    /// êm — RunAsync sẽ chờ 5 giây rồi thử lại.
    /// </summary>
    private async Task ConnectAndReadAsync(CancellationToken ct)
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
            return;
        }

        _log.Info("IPC: đã kết nối tới Service.");
        _writer = new StreamWriter(_pipe, Encoding.UTF8, bufferSize: 1024, leaveOpen: true) { AutoFlush = true };

        using var reader = new StreamReader(_pipe, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, bufferSize: 1024, leaveOpen: true);
        // KHÔNG kiểm tra _pipe.IsConnected ở đây (xem ghi chú ở đầu file):
        // chỉ thoát khi ReadLineAsync trả về null (server đóng) hoặc ném
        // exception — cả hai đều phải ghi log.
        while (!ct.IsCancellationRequested)
        {
            string? line = await reader.ReadLineAsync();
            if (line is null)
            {
                _log.Warning("IPC: Service đã đóng kết nối, thử lại sau 5 giây.");
                return;
            }

            IpcMessage? message = IpcMessage.FromLine(line);
            if (message is not null)
            {
                MessageReceived?.Invoke(message);
            }
        }
    }

    /// <summary>Gửi một message lên Service. Bỏ qua (ghi log) nếu chưa kết nối.</summary>
    public async Task SendAsync(IpcMessage message)
    {
        ArgumentNullException.ThrowIfNull(message);

        StreamWriter? writer = _writer;
        if (writer is null)
        {
            _log.Warning("IPC: chưa kết nối tới Service, bỏ qua message " + message.Type + ".");
            return;
        }

        // Không kiểm tra _pipe.IsConnected (xem ghi chú ở đầu file): cứ ghi,
        // lỗi ghi sẽ hiện rõ trong log và vòng đọc sẽ tự nối lại.

        await _writeGate.WaitAsync();
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
