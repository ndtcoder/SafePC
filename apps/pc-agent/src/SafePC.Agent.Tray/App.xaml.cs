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
///
/// Vì app không có cửa sổ chính, OnStartup tạo thêm một cửa sổ neo ẩn để
/// làm Owner cho mọi cửa sổ và PlacementTarget cho menu chuột phải — nếu
/// không, menu/cửa sổ rất dễ mất kích hoạt và kẹt (xem ghi chú ở OnStartup).
///
/// Chỉ một instance trong mỗi phiên đăng nhập (mutex Local\) — xem OnStartup.
/// </summary>
public partial class App : System.Windows.Application
{
    private readonly CancellationTokenSource _cts = new();

    private TrayIconManager? _tray;
    private IpcPipeClient? _ipc;
    private ForegroundSampler? _sampler;
    private LocalLogger? _log;
    private LockWindow? _lockWindow;
    private RemainingTimeWindow? _remainingWindow;
    private ExtraTimeWindow? _extraTimeWindow;
    private System.Windows.Window? _anchor;
    private Mutex? _singleInstanceMutex;
    private bool _ownsSingleInstanceMutex;
    private bool _shutDown;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        string logPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "SafePC", "logs", "agent-tray.log");
        _log = new LocalLogger(logPath);
        _log.Info("SafePC Tray khởi động (PID " + Environment.ProcessId + ").");

        // Single-instance theo từng phiên đăng nhập: chỉ một Tray trong mỗi
        // session. Mutex "Local\" là theo session — phiên của con và phiên
        // của phụ huynh vẫn có Tray riêng. Bản không có khóa này cho chạy
        // nhiều Tray cùng lúc (máy thật ngày 2026-11-16: 3 icon khay), các
        // process ghi chung một file log khiến log lẫn nhau không đọc được.
        // WaitOne(0) + AbandonedMutexException: nếu process cũ bị dừng đột
        // ngột (Task Manager), mutex bị bỏ rơi và instance mới vẫn chiếm được.
        _singleInstanceMutex = new Mutex(initiallyOwned: false, @"Local\SafePC.Agent.Tray");
        bool acquired;
        try
        {
            acquired = _singleInstanceMutex.WaitOne(TimeSpan.Zero);
        }
        catch (AbandonedMutexException)
        {
            acquired = true;
        }

        if (!acquired)
        {
            _log.Info("SafePC Tray đã chạy trong phiên này, thoát bản sao (PID " + Environment.ProcessId + ").");
            _singleInstanceMutex.Dispose();
            _singleInstanceMutex = null;
            Shutdown();
            return;
        }

        _ownsSingleInstanceMutex = true;

        _ipc = new IpcPipeClient(_log);
        _ipc.MessageReceived += OnIpcMessage;
        _ = _ipc.RunAsync(_cts.Token);

        _sampler = new ForegroundSampler(_ipc, _log);
        _sampler.Start();

        // Cửa sổ neo ẩn (0x0, ngoài màn hình): làm Owner cho mọi cửa sổ Tray
        // và PlacementTarget cho menu chuột phải. App không có cửa sổ chính
        // (ShutdownMode.OnExplicitShutdown) nên menu/cửa sổ không có owner
        // rất dễ mất kích hoạt và kẹt, nuốt mọi cú chuột — lỗi đơ gặp trên
        // máy thật ngày 2026-11-16 (menu hiện nhưng không bấm được, cửa sổ
        // không đóng được, bấm đúp thì mở thêm cửa sổ mới).
        _anchor = new System.Windows.Window
        {
            Width = 0,
            Height = 0,
            Left = -100,
            Top = -100,
            WindowStyle = System.Windows.WindowStyle.None,
            ResizeMode = System.Windows.ResizeMode.NoResize,
            ShowInTaskbar = false,
            ShowActivated = false,
        };
        _anchor.Show();

        _tray = new TrayIconManager(_anchor, ShowRemainingTime, ShowExtraTime, RequestExit);
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
                        new WarningWindow(warning.Reason, warning.MinutesLeft) { Owner = _anchor }.Show();
                    }
                    break;

                case IpcMessageTypes.Lock:
                    LockPayload? lockPayload = message.GetPayload<LockPayload>();
                    if (_lockWindow is { IsVisible: true })
                    {
                        // Màn hình khóa đã hiện: nhắc lại lệnh khóa (VD: giờ
                        // nghỉ bắt buộc nhắc mỗi 15 giây) thì khóa lại ngay
                        // nếu đã hết đếm ngược, không khởi động lại đếm ngược.
                        _lockWindow.ReassertLock();
                        _lockWindow.Activate();
                    }
                    else
                    {
                        _lockWindow ??= new LockWindow(lockPayload?.Reason ?? "Hết giờ.", ShowExtraTime) { Owner = _anchor };
                        _lockWindow.Show();
                        _lockWindow.Activate();
                    }
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
            _log?.Info("Tray: mở cửa sổ thời gian còn lại.");
            if (_remainingWindow is { IsVisible: true })
            {
                _remainingWindow.Activate();
                return;
            }

            // TODO Sprint 1: hỏi Service qua IPC để lấy thời gian còn lại thật
            // (từ cache rules + usage hôm nay) thay cho chuỗi placeholder này.
            // Chỉ giữ một cửa sổ: bấm đúp nhiều lần thì đưa cửa sổ cũ lên
            // trước thay vì mở thêm cửa sổ mới.
            _remainingWindow = new RemainingTimeWindow("Đang tải... (skeleton: TODO lấy thời gian còn lại từ Service qua IPC ở Sprint 1.)")
            {
                Owner = _anchor,
            };
            _remainingWindow.Closed += (_, _) => _remainingWindow = null;
            _remainingWindow.Show();
        });
    }

    private void ShowExtraTime()
    {
        Dispatcher.Invoke(() =>
        {
            _log?.Info("Tray: mở form xin thêm giờ.");
            if (_extraTimeWindow is { IsVisible: true })
            {
                _extraTimeWindow.Activate();
                return;
            }

            _extraTimeWindow = new ExtraTimeWindow(async (minutes, reason) =>
            {
                if (_ipc is not null)
                {
                    await _ipc.SendAsync(IpcMessage.Create(
                        IpcMessageTypes.ExtraTimeRequest,
                        new ExtraTimeRequestPayload(minutes, reason, DateTimeOffset.UtcNow)));
                }
            })
            {
                Owner = _anchor,
            };
            _extraTimeWindow.Closed += (_, _) => _extraTimeWindow = null;
            _extraTimeWindow.Show();
        });
    }

    private void RequestExit()
    {
        Dispatcher.Invoke(() =>
        {
            _log?.Info("Tray: mở hộp nhập PIN để thoát.");
            var pinDialog = new PinDialog { Owner = _anchor };
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

        try
        {
            _anchor?.Close();
        }
        catch
        {
            // Bỏ qua lỗi khi dọn dẹp lúc thoát.
        }

        if (_ownsSingleInstanceMutex && _singleInstanceMutex is not null)
        {
            try
            {
                _singleInstanceMutex.ReleaseMutex();
            }
            catch
            {
                // Bỏ qua lỗi khi dọn dẹp lúc thoát.
            }

            _singleInstanceMutex.Dispose();
            _singleInstanceMutex = null;
            _ownsSingleInstanceMutex = false;
        }

        _log?.Info("SafePC Tray đã thoát.");
        _cts.Dispose();
    }
}
