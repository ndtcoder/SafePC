using System.IO;
using System.Runtime.InteropServices;
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
///
/// CHẨN ĐOÁN + CỨNG HÓA (tối 16/11/2026): các process Tray chết sớm sau khởi
/// động/tương tác ở CẢ hai phiên mà không để lại log nào, và cả buổi tối
/// không có một dòng log bấm menu nào — nguyên nhân vẫn chưa rõ (đang chờ
/// Event Viewer). Từ bản này: global exception handler gắn ngay sau khi log
/// được tạo (UI exception không giết được Tray nữa), log từng bước khởi
/// động, breadcrumb ở mọi menu action / message IPC / mở-đóng cửa sổ, và
/// khóa dự phòng trực tiếp khi LockWindow mở không được (khóa phiên quan
/// trọng hơn giao diện đếm ngược). Cơ chế menu (cửa sổ WPF thật), ShutdownMode,
/// cửa sổ neo và mutex single-instance KHÔNG đổi.
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

        // Bước 1/6: gắn global exception handler NGAY sau khi log được tạo
        // (handler cần _log) và TRƯỚC mọi bước khác — một crash khởi động
        // sau bước này vẫn để lại dấu vết trong log.
        InstallGlobalExceptionHandlers();
        _log.Info("Tray khởi động: bước 1/6 — logger + global exception handler sẵn sàng.");

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
        _log.Info("Tray khởi động: bước 2/6 — đã chiếm mutex single-instance.");

        _ipc = new IpcPipeClient(_log);
        _ipc.MessageReceived += OnIpcMessage;
        _ = _ipc.RunAsync(_cts.Token);
        _log.Info("Tray khởi động: bước 3/6 — IPC đã khởi động.");

        _sampler = new ForegroundSampler(_ipc, _log);
        _sampler.Start();
        _log.Info("Tray khởi động: bước 4/6 — sampler foreground đã khởi động.");

        // Cửa sổ neo ẩn (0x0, ngoài màn hình): làm Owner cho mọi cửa sổ Tray
        // và PlacementTarget cho menu chuột phải. App không có cửa sổ chính
        // (ShutdownMode.OnExplicitShutdown) nên menu/cửa sổ không có owner
        // rất dễ mất kích hoạt và kẹt, nuốt mọi cú chuột — lỗi đơ gặp trên
        // máy thật ngày 2026-11-16 (menu hiện nhưng không bấm được, cửa sổ
        // không đóng được, bấm đúp thì mở thêm cửa sổ mới).
        //
        // Tạo neo + tray icon nằm trong try/catch ghi log kèm stack rồi mới
        // ném lại: một crash khởi động ở đây PHẢI để lại dấu vết trong log
        // ngay cả khi global handler bỏ sót.
        try
        {
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
            _log.Info("Tray khởi động: bước 5/6 — cửa sổ neo đã hiện.");

            _tray = new TrayIconManager(_log, _anchor, ShowRemainingTime, ShowExtraTime, RequestExit);
            _log.Info("Tray khởi động: bước 6/6 — tray icon đã tạo.");
        }
        catch (Exception ex)
        {
            _log.Error("Tray: khởi động thất bại ở bước neo/tray icon (ném lại sau khi ghi log): " + ex.ToString());
            throw;
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        ShutdownTray();
        base.OnExit(e);
    }

    /// <summary>
    /// Gắn 3 global handler, gọi ngay sau khi log được tạo trong OnStartup.
    /// Mục đích là CHẨN ĐOÁN (mọi exception đều để lại stack trong log) và
    /// CỨNG HÓA (UI exception không giết Tray). Kiểu tham số ghi đầy đủ
    /// namespace vì project bật cả WPF lẫn WinForms.
    /// </summary>
    private void InstallGlobalExceptionHandlers()
    {
        AppDomain.CurrentDomain.UnhandledException += OnUnhandledException;
        Dispatcher.UnhandledException += OnDispatcherUnhandledException;
        System.Threading.Tasks.TaskScheduler.UnobservedTaskException += OnUnobservedTaskException;
    }

    /// <summary>
    /// Exception không được bắt ở thread không phải UI: KHÔNG thể ngăn
    /// process chết — chỉ ghi log thật LOUD kèm stack để chẩn đoán sau.
    /// LocalLogger.Error chỉ ghi type + message nên stack được nhúng thẳng
    /// vào message qua ToString().
    /// </summary>
    private void OnUnhandledException(object sender, System.UnhandledExceptionEventArgs e)
    {
        string detail = e.ExceptionObject is Exception ex
            ? ex.ToString()
            : (e.ExceptionObject?.ToString() ?? "(null)");
        _log?.Error("Tray: UNHANDLED EXCEPTION (IsTerminating=" + e.IsTerminating + ", process sắp chết): " + detail);
    }

    /// <summary>
    /// Exception không được bắt trên UI thread (VD: trong handler bấm nút):
    /// ghi log LOUD kèm stack và đặt Handled = true để một UI exception
    /// không giết được Tray.
    /// </summary>
    private void OnDispatcherUnhandledException(object sender, System.Windows.Threading.DispatcherUnhandledExceptionEventArgs e)
    {
        _log?.Error("Tray: DISPATCHER EXCEPTION (đã bắt, Tray tiếp tục chạy): " + e.Exception.ToString());
        e.Handled = true;
    }

    /// <summary>Task exception không ai quan sát: ghi log kèm stack rồi đánh dấu đã quan sát.</summary>
    private void OnUnobservedTaskException(object? sender, System.Threading.Tasks.UnobservedTaskExceptionEventArgs e)
    {
        _log?.Error("Tray: UNOBSERVED TASK EXCEPTION: " + e.Exception.ToString());
        e.SetObserved();
    }

    private void OnIpcMessage(IpcMessage message)
    {
        _log?.Info("Tray: nhận IPC '" + message.Type + "' (bắt đầu xử lý).");

        // Message đến từ thread đọc pipe — chuyển về UI thread để mở cửa sổ WPF.
        // Toàn bộ delegate chạy trong try/catch: một message xấu không được
        // làm lỗi vòng nhận IPC (IpcPipeClient cũng bắt riêng từng message).
        try
        {
            Dispatcher.Invoke(() =>
            {
                try
                {
                    switch (message.Type)
                    {
                        case IpcMessageTypes.Warning:
                            WarningPayload? warning = message.GetPayload<WarningPayload>();
                            if (warning is not null)
                            {
                                try
                                {
                                    var window = new WarningWindow(warning.Reason, warning.MinutesLeft) { Owner = _anchor };
                                    window.Closed += (_, _) => _log?.Info("Tray: cửa sổ cảnh báo đã đóng.");
                                    window.Show();
                                    _log?.Info("Tray: cửa sổ cảnh báo đã hiện.");
                                }
                                catch (Exception ex)
                                {
                                    // Cảnh báo mở không được thì chỉ ghi log
                                    // và tiếp tục — không có fallback nào cần
                                    // thiết cho một cửa sổ cảnh báo.
                                    _log?.Error("Tray: mở WarningWindow lỗi (bỏ qua cảnh báo).", ex);
                                }
                            }
                            break;

                        case IpcMessageTypes.Lock:
                            LockPayload? lockPayload = message.GetPayload<LockPayload>();
                            try
                            {
                                if (_lockWindow is { IsVisible: true })
                                {
                                    // Màn hình khóa đã hiện: nhắc lại lệnh khóa (VD: giờ
                                    // nghỉ bắt buộc nhắc mỗi 15 giây) thì khóa lại ngay
                                    // nếu đã hết đếm ngược, không khởi động lại đếm ngược.
                                    _lockWindow.ReassertLock();
                                    _lockWindow.Activate();
                                    _log?.Info("Tray: màn hình khóa đã hiện, nhắc lại lệnh khóa.");
                                }
                                else
                                {
                                    if (_lockWindow is null)
                                    {
                                        var created = new LockWindow(lockPayload?.Reason ?? "Hết giờ.", ShowExtraTime) { Owner = _anchor };
                                        created.Closed += (_, _) =>
                                        {
                                            if (ReferenceEquals(_lockWindow, created))
                                            {
                                                _lockWindow = null;
                                            }

                                            _log?.Info("Tray: màn hình khóa đã đóng.");
                                        };
                                        _lockWindow = created;
                                    }

                                    _lockWindow.Show();
                                    _lockWindow.Activate();
                                    _log?.Info("Tray: màn hình khóa đã hiện.");
                                }
                            }
                            catch (Exception ex)
                            {
                                // KHÓA DỰ PHÒNG: LockWindow tạo/mở không được
                                // thì khóa phiên trực tiếp — khóa phiên quan
                                // trọng hơn giao diện đếm ngược.
                                _log?.Error("Tray: mở LockWindow lỗi, khóa phiên trực tiếp (fallback).", ex);
                                FallbackLockWorkstation();
                            }
                            break;

                        case IpcMessageTypes.Unlock:
                            try
                            {
                                _lockWindow?.Close();
                            }
                            catch (Exception ex)
                            {
                                _log?.Error("Tray: đóng LockWindow lỗi.", ex);
                            }

                            _lockWindow = null;
                            _log?.Info("Tray: đã đóng màn hình khóa theo lệnh unlock.");
                            break;

                        default:
                            _log?.Info("Tray: bỏ qua IPC không rõ loại: " + message.Type);
                            break;
                    }

                    _log?.Info("Tray: đã xử lý IPC '" + message.Type + "' (xong).");
                }
                catch (Exception ex)
                {
                    _log?.Error("Tray: xử lý IPC '" + message.Type + "' lỗi (đã bắt, vòng nhận IPC tiếp tục).", ex);
                }
            });
        }
        catch (Exception ex)
        {
            _log?.Error("Tray: Dispatcher.Invoke cho IPC '" + message.Type + "' lỗi.", ex);
        }
    }

    /// <summary>
    /// Khóa phiên làm việc trực tiếp qua user32, dùng khi LockWindow không mở
    /// được. Best-effort: thất bại thì chỉ ghi log (đã ghi log ở nơi gọi).
    /// </summary>
    private void FallbackLockWorkstation()
    {
        try
        {
            bool ok = LockWorkStation();
            _log?.Info("Tray: fallback LockWorkStation trả về " + ok + ".");
        }
        catch (Exception ex)
        {
            _log?.Error("Tray: fallback LockWorkStation lỗi.", ex);
        }
    }

    [DllImport("user32.dll")]
    private static extern bool LockWorkStation();

    private void ShowRemainingTime()
    {
        _log?.Info("Tray: menu — Xem thời gian còn lại (bắt đầu).");
        try
        {
            Dispatcher.Invoke(() =>
            {
                try
                {
                    if (_remainingWindow is { IsVisible: true })
                    {
                        _remainingWindow.Activate();
                        _log?.Info("Tray: cửa sổ thời gian còn lại đã hiện, đưa lên trước.");
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
                    _remainingWindow.Closed += (_, _) =>
                    {
                        _remainingWindow = null;
                        _log?.Info("Tray: cửa sổ thời gian còn lại đã đóng.");
                    };
                    _remainingWindow.Show();
                    _log?.Info("Tray: cửa sổ thời gian còn lại đã hiện.");
                }
                catch (Exception ex)
                {
                    _log?.Error("Tray: mở cửa sổ thời gian còn lại lỗi.", ex);
                }
            });
        }
        catch (Exception ex)
        {
            _log?.Error("Tray: Dispatcher.Invoke (thời gian còn lại) lỗi.", ex);
        }

        _log?.Info("Tray: menu — Xem thời gian còn lại (xong).");
    }

    private void ShowExtraTime()
    {
        _log?.Info("Tray: menu — Xin thêm giờ (bắt đầu).");
        try
        {
            Dispatcher.Invoke(() =>
            {
                try
                {
                    if (_extraTimeWindow is { IsVisible: true })
                    {
                        _extraTimeWindow.Activate();
                        _log?.Info("Tray: form xin thêm giờ đã hiện, đưa lên trước.");
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
                    _extraTimeWindow.Closed += (_, _) =>
                    {
                        _extraTimeWindow = null;
                        _log?.Info("Tray: form xin thêm giờ đã đóng.");
                    };
                    _extraTimeWindow.Show();
                    _log?.Info("Tray: form xin thêm giờ đã hiện.");
                }
                catch (Exception ex)
                {
                    _log?.Error("Tray: mở form xin thêm giờ lỗi.", ex);
                }
            });
        }
        catch (Exception ex)
        {
            _log?.Error("Tray: Dispatcher.Invoke (xin thêm giờ) lỗi.", ex);
        }

        _log?.Info("Tray: menu — Xin thêm giờ (xong).");
    }

    private void RequestExit()
    {
        _log?.Info("Tray: menu — Thoát (bắt đầu, mở hộp nhập PIN).");
        try
        {
            Dispatcher.Invoke(() =>
            {
                try
                {
                    var pinDialog = new PinDialog { Owner = _anchor };
                    bool? result = pinDialog.ShowDialog();
                    if (result == true)
                    {
                        _log?.Info("Tray: PIN đúng, thoát.");
                        Shutdown();
                    }
                    else
                    {
                        _log?.Info("Tray: hộp PIN đóng mà không thoát (bị từ chối hoặc hủy).");
                    }
                }
                catch (Exception ex)
                {
                    _log?.Error("Tray: hộp nhập PIN lỗi.", ex);
                }
            });
        }
        catch (Exception ex)
        {
            _log?.Error("Tray: Dispatcher.Invoke (thoát) lỗi.", ex);
        }

        _log?.Info("Tray: menu — Thoát (xong).");
    }

    private void ShutdownTray()
    {
        if (_shutDown)
        {
            return;
        }

        _shutDown = true;
        _log?.Info("Tray: đang dọn dẹp để thoát.");
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
