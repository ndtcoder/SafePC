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
                _pipe = new NamedPipeClientStream(".", AgentConstants.IpcPipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
                await _pipe.ConnectAsync(ct);
                _log.Info("IPC: đã kết nối tới Service.");

                _writer = new StreamWriter(_pipe, Encoding.UTF8, bufferSize: 1024, leaveOpen: true) { AutoFlush = true };

                using var reader = new StreamReader(_pipe, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, bufferSize: 1024, leaveOpen: true);
                while (!ct.IsCancellationRequested && _pipe.IsConnected)
                {
                    string? line = await reader.ReadLineAsync();
                    if (line is null)
                    {
                        break;
                    }

                    IpcMessage? message = IpcMessage.FromLine(line);
                    if (message is not null)
                    {
                        MessageReceived?.Invoke(message);
                    }
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

    /// <summary>Gửi một message lên Service. Bỏ qua (ghi log) nếu chưa kết nối.</summary>
    public async Task SendAsync(IpcMessage message)
    {
        ArgumentNullException.ThrowIfNull(message);

        StreamWriter? writer = _writer;
        if (writer is null || _pipe is not { IsConnected: true })
        {
            _log.Warning("IPC: chưa kết nối tới Service, bỏ qua message " + message.Type + ".");
            return;
        }

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
