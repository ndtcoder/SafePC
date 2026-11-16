using System.IO;
using System.Threading;
using System.Windows;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Tray;

/// <summary>
/// Tray App — chạy trong user session của con, hiển thị tray icon, cảnh báo,
/// màn hình khóa và form xin thêm giờ. Không có cửa sổ chính lúc khởi động
/// (ShutdownMode.OnExplicitShutdown); thoát qua menu tray và yêu cầu mã PIN.
///
/// Tray App cũng là nơi lấy mẫu app foreground (Service ở session 0 không
/// nhìn thấy cửa sổ user) rồi gửi về Service qua IPC Named Pipe.
/// </summary>
public partial class App : Application
{
    private readonly CancellationTokenSource _cts = new();

    private TrayIconManager? _tray;
    private IpcPipeClient? _ipc;
    private ForegroundSampler? _sampler;
    private LocalLogger? _log;
    private LockWindow? _lockWindow;
    private bool _shutDown;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        string logPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "SafePC", "logs", "agent-tray.log");
        _log = new LocalLogger(logPath);
        _log.Info("SafePC Tray khởi động.");

        _ipc = new IpcPipeClient(_log);
        _ipc.MessageReceived += OnIpcMessage;
        _ = _ipc.RunAsync(_cts.Token);

        _sampler = new ForegroundSampler(_ipc, _log);
        _sampler.Start();

        _tray = new TrayIconManager(ShowRemainingTime, ShowExtraTime, RequestExit);
    }

    protected override void OnExit(ExitEventArgs e)
    {
        ShutdownTray();
        base.OnExit(e);
    }

    private void OnIpcMessage(IpcMessage message)
    {
        // Message đến từ thread đọc pipe — chuyển về UI thread để mở cửa sổ WPF.
        Dispatcher.Invoke(() =>
        {
            switch (message.Type)
            {
                case IpcMessageTypes.Warning:
                    WarningPayload? warning = message.GetPayload<WarningPayload>();
                    if (warning is not null)
                    {
                        new WarningWindow(warning.Reason, warning.MinutesLeft).Show();
                    }
                    break;

                case IpcMessageTypes.Lock:
                    LockPayload? lockPayload = message.GetPayload<LockPayload>();
                    _lockWindow ??= new LockWindow(lockPayload?.Reason ?? "Hết giờ.", ShowExtraTime);
                    if (!_lockWindow.IsVisible)
                    {
                        _lockWindow.Show();
                    }
                    _lockWindow.Activate();
                    break;

                case IpcMessageTypes.Unlock:
                    _lockWindow?.Close();
                    _lockWindow = null;
                    break;
            }
        });
    }

    private void ShowRemainingTime()
    {
        Dispatcher.Invoke(() =>
        {
            // TODO Sprint 1: hỏi Service qua IPC để lấy thời gian còn lại thật
            // (từ cache rules + usage hôm nay) thay cho chuỗi placeholder này.
            new RemainingTimeWindow("Đang tải... (skeleton: TODO lấy thời gian còn lại từ Service qua IPC ở Sprint 1.)").Show();
        });
    }

    private void ShowExtraTime()
    {
        Dispatcher.Invoke(() =>
        {
            var window = new ExtraTimeWindow(async (minutes, reason) =>
            {
                if (_ipc is not null)
                {
                    await _ipc.SendAsync(IpcMessage.Create(
                        IpcMessageTypes.ExtraTimeRequest,
                        new ExtraTimeRequestPayload(minutes, reason, DateTimeOffset.UtcNow)));
                }
            });
            window.Show();
        });
    }

    private void RequestExit()
    {
        Dispatcher.Invoke(() =>
        {
            var pinDialog = new PinDialog();
            if (pinDialog.ShowDialog() == true)
            {
                Shutdown();
            }
        });
    }

    private void ShutdownTray()
    {
        if (_shutDown)
        {
            return;
        }

        _shutDown = true;
        _cts.Cancel();

        try
        {
            _sampler?.Dispose();
        }
        catch
        {
            // Bỏ qua lỗi khi dọn dẹp lúc thoát.
        }

        try
        {
            _tray?.Dispose();
        }
        catch
        {
            // Bỏ qua lỗi khi dọn dẹp lúc thoát.
        }

        try
        {
            _ipc?.Dispose();
        }
        catch
        {
            // Bỏ qua lỗi khi dọn dẹp lúc thoát.
        }

        _log?.Info("SafePC Tray đã thoát.");
        _cts.Dispose();
    }
}
