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
/// TODO Sprint 1: gộp mẫu theo phiên tại Tray trước khi gửi để giảm lưu lượng IPC.
/// </summary>
public sealed class ForegroundSampler : IDisposable
{
    private readonly IpcPipeClient _ipc;
    private readonly LocalLogger _log;
    private System.Threading.Timer? _timer;

    // Nhận dạng foreground ở lần gửi foreground-changed trước + thời điểm gửi:
    // đổi nhận dạng thì gửi ngay, không thì heartbeat mỗi 60 giây.
    private string? _lastForegroundIdentity;
    private DateTimeOffset _lastForegroundSentAt = DateTimeOffset.MinValue;

    public ForegroundSampler(IpcPipeClient ipc, LocalLogger log)
    {
        _ipc = ipc;
        _log = log;
    }

    public void Start()
    {
        _timer = new System.Threading.Timer(
            _ => _ = SampleAsync(),
            state: null,
            dueTime: TimeSpan.Zero,
            period: AgentConstants.ForegroundSampleInterval);
    }

    public void Stop()
    {
        _timer?.Change(Timeout.Infinite, Timeout.Infinite);
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
    /// lần gửi trước. Lỗi gửi tuân theo mẫu chung: IpcPipeClient tự ghi log,
    /// không ném exception.
    /// </summary>
    private async Task SendForegroundChangedIfNeededAsync(ForegroundApp app)
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

        await _ipc.SendAsync(IpcMessage.Create(
            IpcMessageTypes.ForegroundChanged,
            new ForegroundChangedPayload(app.ProcessName, app.ExeFileName, app.ExePathHash, sessionId, app.SampledAt)));

        _lastForegroundIdentity = identity;
        _lastForegroundSentAt = now;
    }

    public void Dispose()
    {
        _timer?.Dispose();
    }
}
