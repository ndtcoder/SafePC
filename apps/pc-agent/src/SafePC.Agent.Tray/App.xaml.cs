using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
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
/// giữ vòng đời app. Cửa sổ neo KHÔNG còn làm Owner cho cửa sổ nào nữa:
/// gán Owner là neo 0x0 + ShowActivated=false đã khiến cửa sổ con không giữ
/// được kích hoạt và không nhận chuột trên máy thật (log 17/11/2026, bản
/// #111: menu mất kích hoạt trong 300ms dù SetForegroundWindow trả về True;
/// hộp thoại hiện nhưng bấm X/Đóng không ăn). Mọi cửa sổ Tray giờ là
/// top-level độc lập, như cửa sổ của app bình thường.
///
/// --self-test: chạy Tray với tham số này để tự kiểm tra giao diện (mở menu,
/// hit-test nút, mở/đóng hộp thoại, đếm dispatcher exception) rồi thoát với
/// exit code 0 (đạt) hoặc 1 (trượt). CI chạy nó trên máy Windows thật sau
/// mỗi lần publish để lỗi cửa sổ bị bắt trước khi tới tay phụ huynh.
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
        _log.Info("SafePC Tray khởi động (PID " + Environment.ProcessId + ", phiên bản " + AgentConstants.AgentVersion + ", session " + LocalLogger.CurrentSessionId + ").");

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
        // Vòng đọc IPC chạy trên thread-pool, KHÔNG dính UI thread: mẫu cũ
        // fire-and-forget từ OnStartup (UI thread) khiến mọi continuation
        // của vòng đọc dính vào DispatcherSynchronizationContext — nghi phạm
        // chính của hiện tượng "chuột chết khi pipe đang nối" (17/11/2026).
        // IpcPipeClient cũng ConfigureAwait(false) mọi await của nó.
        _ = Task.Run(() => _ipc.RunAsync(_cts.Token));
        _log.Info("Tray khởi động: bước 3/6 — IPC đã khởi động.");

        _sampler = new ForegroundSampler(_ipc, _log);
        _sampler.Start();
        _log.Info("Tray khởi động: bước 4/6 — sampler foreground đã khởi động.");

        // Cửa sổ neo ẩn (0x0, ngoài màn hình): giữ vòng đời app khi không có
        // cửa sổ nào hiện. KHÔNG dùng làm Owner cho cửa sổ nào nữa — xem ghi
        // chú ở đầu file (log 17/11/2026: Owner là neo khiến cửa sổ con mất
        // kích hoạt và đơ chuột). Giữ lại cửa sổ neo để không đổi cơ chế
        // ShutdownMode/mutex; nó vô hại khi không ai dùng làm Owner.
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

        // --self-test: CI chạy Tray thật trên máy Windows rồi tự kiểm tra
        // menu + hộp thoại (xem RunSelfTestAsync). Xếp vào hàng đợi
        // Dispatcher thay vì chạy ngay: OnStartup chạy trước khi vòng lặp
        // message bắt đầu bơm, còn test cần layout/activation chạy thật.
        bool selfTest = false;
        foreach (string arg in e.Args)
        {
            if (arg == "--self-test")
            {
                selfTest = true;
                break;
            }
        }

        if (selfTest)
        {
            _log.Info("SELF-TEST: chế độ tự kiểm tra, chạy sau khi khởi động xong.");
            Dispatcher.BeginInvoke(new Func<Task>(RunSelfTestAndShutdownAsync));
        }
    }

    /// <summary>
    /// Tự kiểm tra giao diện Tray trên Windows thật: mở menu, hit-test nút,
    /// mở/đóng hộp thoại, kiểm tra khóa/mở qua pipe server giả, đếm
    /// dispatcher exception. Chạy trên UI thread,
    /// dùng await Task.Delay để vòng lặp message bơm bình thường giữa các
    /// bước (layout/activation cần message thật). Ghi từng check PASS/FAIL
    /// vào log rồi thoát với exit code 0 (đạt) hoặc 1 (trượt) để CI đọc.
    /// IsActive chỉ ghi log, KHÔNG tính đạt/trượt: phiên chạy CI có thể
    /// không cấp quyền foreground như máy người dùng.
    /// </summary>
    private async Task RunSelfTestAndShutdownAsync()
    {
        int exitCode;
        try
        {
            exitCode = await RunSelfTestAsync();
        }
        catch (Exception ex)
        {
            _log?.Error("SELF-TEST: lỗi ngoài dự kiến, tính là TRƯỢT.", ex);
            exitCode = 1;
        }

        Shutdown(exitCode);
    }

    private async Task<int> RunSelfTestAsync()
    {
        int passed = 0;
        int total = 0;
        int dispatcherExceptions = 0;
        void CountDispatcherException(object sender, System.Windows.Threading.DispatcherUnhandledExceptionEventArgs e)
        {
            dispatcherExceptions++;
        }

        void Check(string name, bool ok)
        {
            total++;
            if (ok)
            {
                passed++;
            }

            _log?.Info("SELF-TEST: [" + (ok ? "PASS" : "FAIL") + "] " + name);
        }

        Dispatcher.UnhandledException += CountDispatcherException;
        try
        {
            _log?.Info("SELF-TEST: bắt đầu (phiên bản " + AgentConstants.AgentVersion + ").");

            // 1. Menu: mở, hiện, có kích thước, nằm trong vùng màn hình.
            TrayMenuWindow? menu = _tray?.OpenMenuForTest();
            await Task.Delay(800);
            Check("menu hiện + có kích thước", menu is { IsVisible: true } && menu.ActualWidth > 0 && menu.ActualHeight > 0);
            _log?.Info("SELF-TEST: menu IsVisible=" + menu?.IsVisible + " IsActive=" + menu?.IsActive
                + " Left=" + menu?.Left + " Top=" + menu?.Top
                + " W=" + menu?.ActualWidth + " H=" + menu?.ActualHeight + ".");
            Check("menu nằm trong vùng màn hình", menu is not null
                && menu.Left > -5000 && menu.Top > -5000 && menu.Left < 10000 && menu.Top < 10000);

            // 2. Hit-test nút trong menu: kênh hit-test của WPF chết thì nút
            // hiện nhưng bấm không ăn (triệu chứng trên máy thật 17/11/2026).
            Check("hit-test nút trong menu", menu is not null && HitTestFirstButton(menu));

            // 3. Đóng menu.
            _tray?.CloseMenuForTest();
            await Task.Delay(300);
            Check("menu đóng được", menu is { IsVisible: false });

            // 4. Hộp thoại thời gian còn lại: hiện, enabled, hit-test được nút Đóng.
            ShowRemainingTime();
            await Task.Delay(500);
            Check("hộp thoại thời gian hiện + enabled", _remainingWindow is { IsVisible: true } && _remainingWindow.IsEnabled);
            Check("hit-test nút Đóng", _remainingWindow is not null && HitTestFirstButton(_remainingWindow));
            _remainingWindow?.Close();
            await Task.Delay(300);
            Check("hộp thoại đóng được", _remainingWindow is null);

            // 5. IPC khóa/mở qua pipe server giả (bản #6): chứng minh đường
            // nối Service→Tray — Tray nhận lock thì hiện màn hình khóa, nhận
            // unlock thì đóng. Chạy khi KHÔNG có Service thật: server giả
            // đóng vai Service, còn IpcPipeClient + OnIpcMessage + LockWindow
            // đều là code thật. Lỗi "lệnh khóa không tới Tray" (bản 0.1.122)
            // phải bị bắt ở đây thay vì trên máy phụ huynh.
            try
            {
                using var fakeServer = new SelfTestPipeServer(_log);
                fakeServer.Start();
                // Tray nối lại mỗi ~15s (10s chờ + 5s nghỉ) nên chờ tối đa 30s.
                bool connected = await fakeServer.WaitForClientAsync(TimeSpan.FromSeconds(30));
                Check("IPC: Tray nối tới pipe server giả", connected);
                if (connected)
                {
                    bool lockSent = await fakeServer.SendAsync(IpcMessage.Create(IpcMessageTypes.Lock, new LockPayload("Self-test khóa/mở.")));
                    _log?.Info("SELF-TEST: đã gửi message lock qua pipe giả: " + lockSent + ".");
                    for (int i = 0; i < 10 && _lockWindow is not { IsVisible: true }; i++)
                    {
                        await Task.Delay(500);
                    }

                    Check("IPC: nhận lock thì hiện màn hình khóa", lockSent && _lockWindow is { IsVisible: true });
                    Check("IPC: hit-test nút trong màn hình khóa", _lockWindow is not null && HitTestFirstButton(_lockWindow));

                    bool unlockSent = await fakeServer.SendAsync(IpcMessage.Create(IpcMessageTypes.Unlock, new { }));
                    _log?.Info("SELF-TEST: đã gửi message unlock qua pipe giả: " + unlockSent + ".");
                    for (int i = 0; i < 10 && _lockWindow is not null; i++)
                    {
                        await Task.Delay(500);
                    }

                    Check("IPC: nhận unlock thì đóng màn hình khóa", unlockSent && _lockWindow is null);
                }
                else
                {
                    Check("IPC: nhận lock thì hiện màn hình khóa", false);
                    Check("IPC: hit-test nút trong màn hình khóa", false);
                    Check("IPC: nhận unlock thì đóng màn hình khóa", false);
                }
            }
            catch (Exception ex)
            {
                _log?.Error("SELF-TEST: kiểm tra IPC lỗi ngoài dự kiến.", ex);
                Check("IPC: không lỗi ngoài dự kiến", false);
            }
            finally
            {
                // Không bao giờ để màn hình khóa còn hiện khi test kết thúc:
                // đếm ngược 60s của nó sẽ gọi LockWorkStation trên máy CI.
                // Unlock thật đã đóng thì _lockWindow đã null, lệnh này vô hại.
                try
                {
                    _lockWindow?.Close();
                }
                catch
                {
                    // Bỏ qua lỗi dọn dẹp cuối test.
                }

                _lockWindow = null;
            }

            // 6. Không có dispatcher exception nào trong suốt quá trình test
            // (bão Win32Exception 1816 trên máy thật sẽ bị bắt ở đây).
            _log?.Info("SELF-TEST: dispatcher exception trong lúc test: " + dispatcherExceptions + ".");
            Check("không có dispatcher exception", dispatcherExceptions == 0);
        }
        catch (Exception ex)
        {
            _log?.Error("SELF-TEST: lỗi trong lúc test.", ex);
            Check("không lỗi ngoài dự kiến", false);
        }
        finally
        {
            Dispatcher.UnhandledException -= CountDispatcherException;
        }

        _log?.Info("SELF-TEST: " + (passed == total ? "PASS" : "FAIL") + " (" + passed + "/" + total + " check đạt).");
        return passed == total ? 0 : 1;
    }

    /// <summary>
    /// Hit-test điểm giữa của Button đầu tiên trong cây visual của cửa sổ.
    /// Trả về false khi không tìm thấy nút, hit-test không trúng gì, hoặc
    /// kênh composition của WPF lỗi — đúng triệu chứng "hiện mà bấm không ăn".
    /// </summary>
    private bool HitTestFirstButton(System.Windows.Window window)
    {
        try
        {
            System.Windows.Controls.Button? button = FindVisualChild<System.Windows.Controls.Button>(window);
            if (button is null)
            {
                _log?.Info("SELF-TEST: không tìm thấy Button trong " + window.GetType().Name + ".");
                return false;
            }

            window.UpdateLayout();
            var center = new System.Windows.Point(button.ActualWidth / 2, button.ActualHeight / 2);
            System.Windows.Point point = button.TransformToAncestor(window).Transform(center);
            System.Windows.Media.HitTestResult? hit = System.Windows.Media.VisualTreeHelper.HitTest(window, point);
            _log?.Info("SELF-TEST: hit-test " + window.GetType().Name + " tại (" + point.X + "," + point.Y + ") -> "
                + (hit?.VisualHit?.GetType().Name ?? "(null)") + ".");
            return hit is not null;
        }
        catch (Exception ex)
        {
            _log?.Error("SELF-TEST: hit-test lỗi.", ex);
            return false;
        }
    }

    private static T? FindVisualChild<T>(System.Windows.DependencyObject parent)
        where T : System.Windows.DependencyObject
    {
        int count = System.Windows.Media.VisualTreeHelper.GetChildrenCount(parent);
        for (int i = 0; i < count; i++)
        {
            System.Windows.DependencyObject child = System.Windows.Media.VisualTreeHelper.GetChild(parent, i);
            if (child is T found)
            {
                return found;
            }

            T? nested = FindVisualChild<T>(child);
            if (nested is not null)
            {
                return nested;
            }
        }

        return null;
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
        // Dùng BeginInvoke (BẤT ĐỒNG BỘ), không dùng Invoke: Invoke đồng bộ
        // chặn thread đọc pipe cho tới khi UI thread chạy xong delegate, nên
        // một UI thread bận/kẹt sẽ treo cả vòng nhận IPC (log sáng 17/11/2026:
        // lệnh lock đã gửi tới nhưng Tray không bao giờ xử lý, không một dòng
        // log IPC nào). BeginInvoke xếp delegate vào hàng đợi rồi trả về ngay,
        // vòng đọc tiếp tục nhận message sau. Toàn bộ delegate vẫn chạy trong
        // try/catch của chính nó.
        try
        {
            Dispatcher.BeginInvoke(() =>
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
                                    var window = new WarningWindow(warning.Reason, warning.MinutesLeft);
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
                                        var created = new LockWindow(lockPayload?.Reason ?? "Hết giờ.", ShowExtraTime);
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
            _log?.Error("Tray: Dispatcher.BeginInvoke cho IPC '" + message.Type + "' lỗi.", ex);
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
                    _remainingWindow = new RemainingTimeWindow("Đang tải... (skeleton: TODO lấy thời gian còn lại từ Service qua IPC ở Sprint 1.)");
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
                    });
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
                    var pinDialog = new PinDialog();
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
