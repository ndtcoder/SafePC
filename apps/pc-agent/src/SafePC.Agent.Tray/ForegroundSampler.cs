using System.Diagnostics;
using System.Threading;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Tray;

/// <summary>
/// Lấy mẫu app foreground mỗi 15 giây (chạy trong user session, nơi Win32 API
/// nhìn thấy cửa sổ) và gửi mẫu về Service qua IPC.
/// Chỉ gửi tên process + hash đường dẫn exe — xem <see cref="ForegroundTracker"/>.
///
/// Ngoài mẫu usage, Sampler còn gửi message foreground-changed để Service thi
/// hành quy tắc theo app: gửi khi app foreground ĐỔI (tên file exe hoặc tên
/// process khác lần gửi trước), và heartbeat tối đa mỗi 60 giây để Service
/// biết báo cáo còn tươi. Service không kill khi báo cáo đã cũ.
///
/// BÁO ĐỔI TỨC THÌ (18/11/2026): ngoài kỳ poll 15 giây, một WinEvent hook
/// (<see cref="ForegroundChangeHook"/>) báo đổi foreground ngay khi đổi để
/// rút ngắn độ trễ chặn app từ ~1 phút xuống ~vài giây. Hook lỗi thì poll
/// 15 giây vẫn làm dự phòng như trước. Mẫu usage vẫn chỉ đếm theo kỳ poll
/// 15 giây — hook không gửi mẫu usage, không đổi cách tính thời gian dùng.
///
/// THỬ LẠI KHI GỬI RỚT (18/11/2026): nhận dạng/thời điểm gửi chỉ được cập
/// nhật khi gửi THÀNH CÔNG. Mẫu cũ cập nhật kể cả khi message bị bỏ (pipe
/// đang nối lại), khiến một lần đổi foreground bị rớt làm Service mù tới
/// heartbeat 60 giây sau — cộng dồn với poll 15 giây và tick 15 giây thành
/// ~90 giây tệ nhất. Gửi rớt thì mẫu sau (poll ≤15 giây hoặc hook lần đổi
/// sau) thử lại.
/// TODO Sprint 1: gộp mẫu theo phiên tại Tray trước khi gửi để giảm lưu lượng IPC.
/// </summary>
public sealed class ForegroundSampler : IDisposable
{
    private readonly IpcPipeClient _ipc;
    private readonly LocalLogger _log;
    private readonly ForegroundChangeHook _hook;
    private System.Threading.Timer? _timer;

    // Cổng xâu chuỗi hai đường gửi foreground-changed (kỳ poll + hook):
    // kiểm tra nhận dạng → gửi → cập nhật phải nguyên tử, nếu không hai
    // đường cùng thấy "đã đổi" và gửi trùng. Cổng chỉ giữ trong lúc gửi
    // (mili-giây khi nối tốt, tối đa 5 giây khi khóa ghi kẹt) nên không
    // chặn đường nào đáng kể; hook vốn fire-and-forget nên không bao giờ
    // giữ thread callback của hệ thống.
    private readonly SemaphoreSlim _sendGate = new(1, 1);

    // Nhận dạng foreground ở lần gửi foreground-changed THÀNH CÔNG trước +
    // thời điểm gửi: đổi nhận dạng thì gửi ngay, không thì heartbeat mỗi
    // 60 giây. Chỉ cập nhật khi SendAsync trả về true (xem ghi chú ở đầu
    // file) — mọi truy cập đều dưới _sendGate.
    private string? _lastForegroundIdentity;
    private DateTimeOffset _lastForegroundSentAt = DateTimeOffset.MinValue;

    public ForegroundSampler(IpcPipeClient ipc, LocalLogger log)
    {
        _ipc = ipc;
        _log = log;
        _hook = new ForegroundChangeHook(OnForegroundChangedByHook, log);
    }

    public void Start()
    {
        _timer = new System.Threading.Timer(
            _ => _ = SampleAsync(),
            state: null,
            dueTime: TimeSpan.Zero,
            period: AgentConstants.ForegroundSampleInterval);

        // Hook lỗi thì Start đã ghi log một lần; poll 15 giây làm dự phòng.
        _ = _hook.Start();
    }

    public void Stop()
    {
        _timer?.Change(Timeout.Infinite, Timeout.Infinite);
        _hook.Stop();
    }

    /// <summary>
    /// Kích hoạt từ callback WinEvent hook (thread của hệ thống): trả về
    /// ngay, không chạm UI — lấy mẫu + gửi chạy trên thread-pool.
    /// </summary>
    private void OnForegroundChangedByHook()
    {
        _ = ReportHookChangeAsync();
    }

    private async Task ReportHookChangeAsync()
    {
        try
        {
            if (!ForegroundTracker.TryGetForegroundApp(out ForegroundApp? app) || app is null)
            {
                return;
            }

            // Chỉ gửi foreground-changed, KHÔNG gửi mẫu usage: usage vẫn đếm
            // theo kỳ poll 15 giây, hook đổi nhịp đếm sẽ làm sai thời gian dùng.
            await SendForegroundChangedIfNeededAsync(app);
        }
        catch (ObjectDisposedException)
        {
            // Sampler đang được dispose khi Tray thoát: cổng gửi đã đóng,
            // bỏ qua lặng lẽ thay vì ghi lỗi.
        }
        catch (Exception ex)
        {
            _log.Error("Không gửi được báo cáo foreground từ hook.", ex);
        }
    }

    private async Task SampleAsync()
    {
        try
        {
            if (!ForegroundTracker.TryGetForegroundApp(out ForegroundApp? app) || app is null)
            {
                return;
            }

            await _ipc.SendAsync(IpcMessage.Create(
                IpcMessageTypes.UsageSample,
                new UsageSamplePayload(app.ProcessName, app.ExePathHash, app.SampledAt)));

            await SendForegroundChangedIfNeededAsync(app);
        }
        catch (Exception ex)
        {
            _log.Error("Không lấy/gửi được mẫu foreground.", ex);
        }
    }

    /// <summary>
    /// Gửi foreground-changed khi app foreground đổi hoặc đã quá 60 giây từ
    /// lần gửi trước. Nhận dạng/thời điểm chỉ cập nhật khi gửi thành công
    /// (SendAsync trả về true) — gửi rớt thì lần sau thử lại. Lỗi gửi tuân
    /// theo mẫu chung: IpcPipeClient tự ghi log, không ném exception.
    /// </summary>
    private async Task SendForegroundChangedIfNeededAsync(ForegroundApp app)
    {
        await _sendGate.WaitAsync();
        try
        {
            string identity = (app.ExeFileName ?? string.Empty) + "|" + app.ProcessName;
            DateTimeOffset now = DateTimeOffset.UtcNow;
            bool changed = !string.Equals(identity, _lastForegroundIdentity, StringComparison.Ordinal);
            bool heartbeatDue = now - _lastForegroundSentAt >= TimeSpan.FromSeconds(60);
            if (!changed && !heartbeatDue)
            {
                return;
            }

            int sessionId;
            using (Process current = Process.GetCurrentProcess())
            {
                sessionId = current.SessionId;
            }

            bool sent = await _ipc.SendAsync(IpcMessage.Create(
                IpcMessageTypes.ForegroundChanged,
                new ForegroundChangedPayload(app.ProcessName, app.ExeFileName, app.ExePathHash, sessionId, app.SampledAt)));

            if (sent)
            {
                _lastForegroundIdentity = identity;
                _lastForegroundSentAt = now;
            }
        }
        finally
        {
            _sendGate.Release();
        }
    }

    public void Dispose()
    {
        _timer?.Dispose();
        _hook.Dispose();
        _sendGate.Dispose();
    }
}
