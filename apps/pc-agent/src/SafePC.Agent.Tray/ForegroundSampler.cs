using System.Threading;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Tray;

/// <summary>
/// Lấy mẫu app foreground mỗi 15 giây (chạy trong user session, nơi Win32 API
/// nhìn thấy cửa sổ) và gửi mẫu về Service qua IPC.
/// Chỉ gửi tên process + hash đường dẫn exe — xem <see cref="ForegroundTracker"/>.
/// TODO Sprint 1: gộp mẫu theo phiên tại Tray trước khi gửi để giảm lưu lượng IPC.
/// </summary>
public sealed class ForegroundSampler : IDisposable
{
    private readonly IpcPipeClient _ipc;
    private readonly LocalLogger _log;
    private Timer? _timer;

    public ForegroundSampler(IpcPipeClient ipc, LocalLogger log)
    {
        _ipc = ipc;
        _log = log;
    }

    public void Start()
    {
        _timer = new Timer(
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
        }
        catch (Exception ex)
        {
            _log.Error("Không lấy/gửi được mẫu foreground.", ex);
        }
    }

    public void Dispose()
    {
        _timer?.Dispose();
    }
}
