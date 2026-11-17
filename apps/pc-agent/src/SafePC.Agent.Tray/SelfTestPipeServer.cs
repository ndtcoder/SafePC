using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Tray;

/// <summary>
/// Pipe server GIẢ đóng vai Service trong --self-test (CHỈ dùng cho test,
/// không dùng lúc chạy thật): Tray nối tới nó bằng IpcPipeClient thật, nó
/// gửi message lock/unlock thật, và test khẳng định OnIpcMessage thật đã
/// hiện/đóng LockWindow thật. Nhờ đó lỗi đường nối Service→Tray (bản 0.1.122:
/// lệnh khóa không bao giờ tới Tray) bị bắt trên CI thay vì tới tay phụ huynh.
///
/// Server đọc-xả mọi dòng Tray gửi lên (usage-sample/foreground) trên thread
/// đọc riêng — nếu không đọc, pipe đầy sẽ chặn lần ghi của Tray. Vòng đọc
/// dùng đúng mẫu production (ReadLine đồng bộ + dispose để giải phóng),
/// không dùng ReadLineAsync + timeout.
///
/// ACCEPT CŨNG ĐỒNG BỘ (bài học từ run CI #127): bản đầu dùng
/// WaitForConnectionAsync — Tray nối được (log "đã kết nối" 04:02:25) nhưng
/// phía server im lặng suốt 30s, _writer không bao giờ được gán, cả 4 check
/// IPC rớt. Nghi là do client đang treo trong ConnectAsync từ lúc khởi động
/// nên nối ngay khi instance xuất hiện, trước khi lệnh chờ nối bất đồng bộ
/// kịp đăng ký (cơ chế chưa chứng minh chắc chắn — quan sát chắc chắn là
/// lệnh chờ đó không hoàn tất trong 30s).
/// WaitForConnection() chặn trên thread riêng xử lý đúng cả hai thứ tự
/// (client chờ sẵn hay nối sau), khớp bài học pipe của dự án: I/O pipe
/// đồng bộ trên thread riêng, không dùng lệnh chờ bất đồng bộ.
///
/// GIỚI HẠN: cổng này chạy cùng user/cùng session nên không kiểm chứng
/// ranh giới ACL SYSTEM↔user hay đa session — nó không thay thế test trên
/// máy thật với Service chạy quyền SYSTEM + Tray ở session của con.
/// </summary>
internal sealed class SelfTestPipeServer : IDisposable
{
    private readonly LocalLogger? _log;
    private NamedPipeServerStream? _server;
    private StreamReader? _reader;

    // Volatile: ghi trên thread accept, đọc trên UI thread (poll nối +
    // gửi) — không có volatile thì UI thread có thể đọc giá trị cũ mãi.
    private volatile StreamWriter? _writer;
    private bool _disposed;

    public SelfTestPipeServer(LocalLogger? log)
    {
        _log = log;
    }

    /// <summary>Tray đã nối tới và stream ghi đã sẵn sàng (chỉ đặt sau khi accept xong).</summary>
    public bool IsConnected => _writer is not null;

    /// <summary>Tạo pipe instance và bắt đầu chờ Tray nối tới (không chặn).</summary>
    public void Start()
    {
        _server = new NamedPipeServerStream(
            AgentConstants.IpcPipeName,
            PipeDirection.InOut,
            maxNumberOfServerInstances: 1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous);
        _ = Task.Run(AcceptLoop);
    }

    /// <summary>
    /// Chờ Tray nối tới bằng lệnh CHẶN đồng bộ trên thread riêng (xem ghi
    /// chú ở đầu file: WaitForConnectionAsync đã không hoàn tất ở run #127
    /// khi client nối trước khi lệnh chờ kịp đăng ký). Dispose pipe sẽ
    /// giải phóng lệnh chờ đang chặn.
    /// </summary>
    private void AcceptLoop()
    {
        _log?.Info("SELF-TEST: pipe server giả đang chờ Tray nối tới.");
        try
        {
            _server!.WaitForConnection();
            _reader = new StreamReader(_server, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, bufferSize: 1024, leaveOpen: true);
            _writer = new StreamWriter(_server, Encoding.UTF8, bufferSize: 1024, leaveOpen: true) { AutoFlush = true };
            _ = Task.Run(DrainLoop);
            _log?.Info("SELF-TEST: pipe server giả đã nhận kết nối từ Tray.");
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException)
        {
            // Test đã dispose server trong lúc chờ nối: thoát, nhưng vẫn ghi
            // log để lần sau phân biệt được "client chưa nối" với "accept chết".
            _log?.Warning("SELF-TEST: pipe server giả dừng chờ kết nối (" + ex.GetType().Name + ", thường là test đã dọn dẹp).");
        }
        catch (Exception ex)
        {
            _log?.Error("SELF-TEST: pipe server giả chờ kết nối lỗi.", ex);
        }
    }

    private void DrainLoop()
    {
        try
        {
            while (true)
            {
                string? line = _reader!.ReadLine();
                if (line is null)
                {
                    break;
                }

                // Xả bỏ: chỉ cần pipe không đầy để lần ghi của Tray không chặn.
            }
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException)
        {
            // Pipe đóng khi test dọn dẹp: thoát vòng xả.
        }
        catch (Exception ex)
        {
            _log?.Error("SELF-TEST: pipe server giả đọc-xả lỗi.", ex);
        }
    }

    /// <summary>Chờ Tray nối tới, tối đa <paramref name="timeout"/>.</summary>
    public async Task<bool> WaitForClientAsync(TimeSpan timeout)
    {
        DateTimeOffset deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            if (IsConnected)
            {
                return true;
            }

            await Task.Delay(200).ConfigureAwait(false);
        }

        bool connected = IsConnected;
        if (!connected)
        {
            // Chẩn đoán cho lần rớt sau (run #127): phân biệt "client chưa
            // nối" (pipe IsConnected=false) với "accept không hoàn tất"
            // (pipe IsConnected=true nhưng _writer chưa gán).
            _log?.Info("SELF-TEST: chờ Tray nối hết hạn: writer sẵn sàng=" + IsConnected
                + ", pipe IsConnected=" + (_server?.IsConnected.ToString() ?? "null") + ".");
        }

        return connected;
    }

    /// <summary>Gửi một message xuống Tray đang nối. Trả về false khi chưa nối hoặc ghi lỗi.</summary>
    public async Task<bool> SendAsync(IpcMessage message)
    {
        StreamWriter? writer = _writer;
        if (writer is null)
        {
            return false;
        }

        try
        {
            await writer.WriteLineAsync(message.ToLine()).ConfigureAwait(false);
            return true;
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException)
        {
            _log?.Error("SELF-TEST: pipe server giả gửi message lỗi.", ex);
            return false;
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        try
        {
            _writer?.Dispose();
        }
        catch
        {
            // Bỏ qua lỗi khi dọn dẹp cuối test.
        }

        try
        {
            _reader?.Dispose();
        }
        catch
        {
            // Bỏ qua lỗi khi dọn dẹp cuối test.
        }

        try
        {
            _server?.Dispose();
        }
        catch
        {
            // Bỏ qua lỗi khi dọn dẹp cuối test.
        }
    }
}
