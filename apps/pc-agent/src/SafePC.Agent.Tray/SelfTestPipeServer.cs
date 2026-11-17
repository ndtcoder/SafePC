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
/// NHẬN KẾT NỐI BẰNG LỆNH CHỜ + POLL (bài học từ run CI #127/#129/#131/
/// #133): lệnh chờ nối (WaitForConnectionAsync hay chặn đồng bộ) không
/// quan sát được kết nối đã thiết lập trước khi lệnh chờ bắt đầu (#127,
/// #129); NHƯNG poll IsConnected mà KHÔNG phát lệnh chờ thì đọc False mãi
/// (#131/#133: client đã nối mà poll 30s vẫn False) — IsConnected chỉ phản
/// ánh kết nối khi đã có lệnh chờ được phát (#129: True khi lệnh chờ chặn
/// đang treo). Vì vậy server giả phát lệnh chờ nối chặn trên thread riêng
/// (để bộ máy hoàn tất của OS hoạt động) VÀ poll IsConnected, tiến hành khi
/// một trong hai báo đã nối.
///
/// KHÔNG dùng AutoFlush trên StreamWriter của pipe (xem ghi chú ở
/// IpcPipeServer — chết chéo FlushFileBuffers, run CI #133): SendAsync
/// FlushAsync tường minh sau mỗi lần ghi.
///
/// GIỚI HẠN: cổng này chạy cùng user/cùng session nên không kiểm chứng
/// ranh giới ACL SYSTEM↔user hay đa session — nó không thay thế test trên
/// máy thật với Service chạy quyền SYSTEM + Tray ở session của con.
/// </summary>
internal sealed class SelfTestPipeServer : IDisposable
{
    private readonly LocalLogger? _log;
    private readonly object _connectLock = new();
    private NamedPipeServerStream? _server;
    private StreamReader? _reader;

    // Lệnh chờ nối chặn đã trả về thành công (đặt trên thread chờ, đọc từ
    // thread poll/gửi — volatile để thread đọc không thấy giá trị cũ mãi).
    // Chỉ đặt khi WaitForConnection trả về không exception; mọi exception
    // (kể cả dispose lúc dọn dẹp) đều để cờ ở false.
    private volatile bool _waitSucceeded;

    // Volatile: ghi khi EnsureConnected chạy, đọc từ UI thread (poll nối +
    // gửi) — không có volatile thì thread đọc có thể đọc giá trị cũ mãi.
    private volatile StreamWriter? _writer;
    private volatile bool _disposed;

    public SelfTestPipeServer(LocalLogger? log)
    {
        _log = log;
    }

    /// <summary>Tray đã nối tới và stream ghi đã sẵn sàng (chỉ đặt sau khi thấy IsConnected).</summary>
    public bool IsConnected => _writer is not null;

    /// <summary>Tạo pipe instance và phát lệnh chờ nối (xem ghi chú ở đầu file).</summary>
    public void Start()
    {
        if (_server is not null)
        {
            throw new InvalidOperationException("SelfTestPipeServer.Start() chỉ được gọi một lần.");
        }

        _server = new NamedPipeServerStream(
            AgentConstants.IpcPipeName,
            PipeDirection.InOut,
            maxNumberOfServerInstances: 1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous);
        NamedPipeServerStream server = _server;
        _ = Task.Run(() =>
        {
            try
            {
                server.WaitForConnection();
                _waitSucceeded = true;
            }
            catch (Exception ex) when (ex is IOException or ObjectDisposedException)
            {
                // Pipe đóng khi test dọn dẹp: chờ nối kết thúc không thành công.
            }
            catch (Exception ex)
            {
                _log?.Error("SELF-TEST: pipe server giả chờ nối lỗi ngoài dự kiến.", ex);
            }
        });
        _log?.Info("SELF-TEST: pipe server giả đã tạo, chờ Tray nối tới (lệnh chờ nối + poll IsConnected).");
    }

    /// <summary>
    /// Nếu pipe đã nối (lệnh chờ nối thành công HOẶC IsConnected) mà
    /// reader/writer chưa tạo thì tạo ngay và chạy vòng xả. Idempotent, an
    /// toàn khi gọi nhiều lần: chỉ lần đầu tạo, các lần sau thấy _writer đã
    /// có thì thôi.
    /// </summary>
    private void EnsureConnected()
    {
        if (_writer is not null || _disposed)
        {
            return;
        }

        lock (_connectLock)
        {
            if (_writer is not null || _disposed)
            {
                return;
            }

            NamedPipeServerStream? server = _server;
            if (server is null || (!_waitSucceeded && !server.IsConnected))
            {
                return;
            }

            _reader = new StreamReader(server, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, bufferSize: 1024, leaveOpen: true);
            // KHÔNG dùng AutoFlush trên pipe (xem ghi chú ở IpcPipeServer):
            // SendAsync FlushAsync tường minh sau mỗi lần ghi.
            _writer = new StreamWriter(server, Encoding.UTF8, bufferSize: 1024, leaveOpen: true);
            _ = Task.Run(DrainLoop);
            _log?.Info("SELF-TEST: pipe server giả đã nhận kết nối từ Tray.");
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

                // Trả lời canned cho câu hỏi của Tray (đợt PIN/xin giờ/xem
                // giờ): server giả đóng vai Service, vọng lại RequestId để
                // Tray đối chiếu. Ghi chặn đồng bộ trên thread xả này là an
                // toàn: SendAsync dùng ConfigureAwait(false) và thread xả
                // không có SynchronizationContext nên không deadlock; test
                // không gọi SendAsync đồng thời trong giai đoạn hỏi/đáp
                // (các lần gửi warning/lock/unlock chạy trước, tuần tự).
                // Mọi dòng khác (hello, usage-sample...) thì xả bỏ: chỉ cần
                // pipe không đầy để lần ghi của Tray không chặn.
                IpcMessage? message = IpcMessage.FromLine(line);
                if (message is null)
                {
                    continue;
                }

                try
                {
                    if (message.Type == IpcMessageTypes.RemainingTimeRequest)
                    {
                        RemainingTimeRequestPayload? request = message.GetPayload<RemainingTimeRequestPayload>();
                        _ = SendAsync(IpcMessage.Create(
                            IpcMessageTypes.RemainingTimeResponse,
                            new RemainingTimeResponsePayload("warn", 42, "Self-test.", DateTimeOffset.UtcNow, request?.RequestId ?? string.Empty)))
                            .GetAwaiter().GetResult();
                    }
                    else if (message.Type == IpcMessageTypes.PinVerifyRequest)
                    {
                        PinVerifyRequestPayload? request = message.GetPayload<PinVerifyRequestPayload>();
                        _ = SendAsync(IpcMessage.Create(
                            IpcMessageTypes.PinVerifyResponse,
                            new PinVerifyResponsePayload(Verified: true, LockedOut: false, RemainingAttempts: 5, PinConfigured: true, RequestId: request?.RequestId ?? string.Empty)))
                            .GetAwaiter().GetResult();
                    }
                }
                catch (Exception ex) when (ex is IOException or ObjectDisposedException)
                {
                    // Pipe đóng giữa chừng khi test dọn dẹp: thoát vòng xả.
                    break;
                }
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
            EnsureConnected();
            if (IsConnected)
            {
                return true;
            }

            await Task.Delay(200).ConfigureAwait(false);
        }

        EnsureConnected();
        bool connected = IsConnected;
        if (!connected)
        {
            // Chẩn đoán cho lần rớt sau: phân biệt "client chưa nối" (cả hai
            // tín hiệu đều âm tính) với "lệnh chờ/poll không quan sát được
            // kết nối" (một trong hai dương tính nhưng writer chưa gán).
            _log?.Info("SELF-TEST: chờ Tray nối hết hạn: writer sẵn sàng=" + IsConnected
                + ", lệnh chờ nối thành công=" + _waitSucceeded
                + ", pipe IsConnected=" + (_server?.IsConnected.ToString() ?? "null") + ".");
        }

        return connected;
    }

    /// <summary>Gửi một message xuống Tray đang nối. Trả về false khi chưa nối hoặc ghi lỗi.</summary>
    public async Task<bool> SendAsync(IpcMessage message)
    {
        EnsureConnected();
        StreamWriter? writer = _writer;
        if (writer is null)
        {
            return false;
        }

        try
        {
            await writer.WriteLineAsync(message.ToLine()).ConfigureAwait(false);
            // Flush tường minh (thay cho AutoFlush đã bỏ): không flush thì
            // message nằm trong buffer, Tray không bao giờ đọc. Flush lúc
            // này an toàn vì thread đọc của Tray chạy độc lập, không phụ
            // thuộc vào lần flush này — nó đọc message rồi flush mới hoàn tất.
            await writer.FlushAsync().ConfigureAwait(false);
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
