using System.Drawing;
using System.Runtime.InteropServices;
using SafePC.Agent.Shared;
using WinForms = System.Windows.Forms;

namespace SafePC.Agent.Tray;

/// <summary>
/// Tray icon dùng System.Windows.Forms.NotifyIcon (bật UseWindowsForms, không
/// cần package ngoài). Menu chuột phải là một cửa sổ WPF thật
/// (<see cref="TrayMenuWindow"/>), mở bằng tay khi nhận MouseUp chuột phải.
/// Menu: Xem thời gian còn lại, Nhắn tin với bố mẹ, Xin thêm giờ, Thoát. Thoát yêu cầu mã PIN —
/// logic PIN nằm ở <see cref="PinDialog"/>.
///
/// Vì sao KHÔNG dùng ContextMenu (cả WinForms lẫn WPF): app này là WPF,
/// vòng lặp message duy nhất là WPF Dispatcher (ShutdownMode.OnExplicitShutdown,
/// không có cửa sổ chính), không hề gọi WinForms Application.Run.
/// WinForms ContextMenuStrip cần message filter của WinForms nên hiện mà đơ.
/// WPF ContextMenu phụ thuộc vào activation của cửa sổ chủ nên liên tục kẹt:
/// hiện nhưng không nhận chuột, không tự đóng, nuốt mọi cú chuột của cả app
/// (gặp trên máy thật qua 3 lần sửa, lần cuối ngày 2026-11-16 bản #53).
/// Cửa sổ menu thật tự kích hoạt và nhận chuột như mọi cửa sổ WPF khác.
/// Mọi kiểu WPF đều ghi rõ namespace đầy đủ vì project bật cả UseWPF lẫn
/// UseWindowsForms (nhiều tên tồn tại ở cả hai).
///
/// CHẨN ĐOÁN (tối 16/11/2026): người dùng báo icon biến mất khi bấm, cả hai
/// phiên, mà log không có dòng bấm menu nào. Mọi đường chuột (MouseUp,
/// DoubleClick) và mọi lần mở/đóng menu đều ghi breadcrumb và chạy trong
/// try/catch, để log đuôi cho thấy chính xác Tray đang làm gì nếu nó chết.
/// </summary>
public sealed class TrayIconManager : IDisposable
{
    private readonly LocalLogger _log;
    private readonly WinForms.NotifyIcon _icon;
    private readonly System.Windows.Window _anchor;
    private readonly Action _showRemainingTime;
    private readonly Action _openChat;
    private readonly Action _showExtraTime;
    private readonly Action _requestExit;
    private TrayMenuWindow? _menuWindow;
    private DateTimeOffset _menuClosedAt;
    private DateTimeOffset _menuOpenedAt;
    private bool _disposed;

    public TrayIconManager(LocalLogger log, System.Windows.Window anchor, Action showRemainingTime, Action openChat, Action showExtraTime, Action requestExit)
    {
        ArgumentNullException.ThrowIfNull(log);
        ArgumentNullException.ThrowIfNull(anchor);
        ArgumentNullException.ThrowIfNull(showRemainingTime);
        ArgumentNullException.ThrowIfNull(openChat);
        ArgumentNullException.ThrowIfNull(showExtraTime);
        ArgumentNullException.ThrowIfNull(requestExit);

        _log = log;
        _anchor = anchor;
        _showRemainingTime = showRemainingTime;
        _openChat = openChat;
        _showExtraTime = showExtraTime;
        _requestExit = requestExit;

        _icon = new WinForms.NotifyIcon
        {
            // TODO Sprint 1: icon .ico riêng của SafePC thay cho icon hệ thống.
            Icon = SystemIcons.Information,
            Text = "SafePC v" + AgentConstants.AgentVersion,
            Visible = true,
        };
        _icon.MouseUp += OnIconMouseUp;
        _icon.DoubleClick += (_, _) =>
        {
            _log.Info("Tray: bấm đúp icon khay (bắt đầu).");
            try
            {
                CloseMenu();
                showRemainingTime();
                _log.Info("Tray: bấm đúp icon khay (xong).");
            }
            catch (Exception ex)
            {
                _log.Error("Tray: xử lý bấm đúp icon lỗi (đã bắt, Tray tiếp tục chạy): " + ex.ToString());
            }
        };
    }

    private void OnIconMouseUp(object? sender, WinForms.MouseEventArgs e)
    {
        try
        {
            if (_disposed || e.Button != WinForms.MouseButtons.Right)
            {
                return;
            }

            _log.Info("Tray: chuột phải vào icon khay.");

            // Menu vừa MỞ chưa tới 500ms: bỏ qua chuột phải này. Log thật
            // sáng 17/11/2026 (bản #111): mỗi lần mở menu xong lại có thêm
            // một sự kiện chuột phải trong cùng giây, rơi đúng nhánh bật/tắt
            // và đóng menu ngay — user chỉ thấy "chuột phải ko có menu".
            // Dù sự kiện thứ hai là do shell gửi trùng hay do user bấm dồn,
            // menu vừa mở cũng không được phép bị đóng ngay lập tức.
            if (_menuWindow is { IsVisible: true }
                && DateTimeOffset.UtcNow - _menuOpenedAt < TimeSpan.FromMilliseconds(500))
            {
                _log.Info("Tray: bỏ qua chuột phải (menu vừa mở dưới 500ms).");
                return;
            }

            // Menu đang mở: chuột phải thì đóng (bật/tắt, như tray chuẩn).
            if (_menuWindow is { IsVisible: true })
            {
                _log.Info("Tray: menu đang mở, đóng menu (bật/tắt).");
                CloseMenu();
                return;
            }

            // Menu vừa đóng do mất kích hoạt (cú chuột phải này khiến menu mất
            // kích hoạt rồi đóng ngay trước MouseUp): coi như bật/tắt, không mở
            // lại, nếu không menu sẽ nháy lên ngay sau khi vừa đóng.
            if (DateTimeOffset.UtcNow - _menuClosedAt < TimeSpan.FromMilliseconds(250))
            {
                _log.Info("Tray: bỏ qua chuột phải (menu vừa đóng dưới 250ms).");
                return;
            }

            OpenMenu();
        }
        catch (Exception ex)
        {
            _log.Error("Tray: xử lý chuột phải vào icon lỗi (đã bắt, Tray tiếp tục chạy): " + ex.ToString());
        }
    }

    private void OpenMenu()
    {
        _log.Info("Tray: mở menu (bắt đầu).");
        try
        {
            CloseMenu();

            var menu = new TrayMenuWindow(_log, _showRemainingTime, _openChat, _showExtraTime, _requestExit)
            {
                // KHÔNG đặt Owner: menu là cửa sổ top-level độc lập. Gán Owner
                // là cửa sổ neo 0x0 + ShowActivated=false đã khiến cửa sổ con
                // không giữ được kích hoạt và không nhận chuột trên máy thật
                // (menu mất kích hoạt trong 300ms dù SetForegroundWindow trả
                // về True; hộp thoại hiện nhưng bấm không ăn — log 17/11/2026).
                Left = -10000,
                Top = -10000,
            };
            menu.Closed += (_, _) =>
            {
                _menuClosedAt = DateTimeOffset.UtcNow;
                _log.Info("Tray: menu đã đóng.");
                if (ReferenceEquals(_menuWindow, menu))
                {
                    _menuWindow = null;
                }
            };
            _menuWindow = menu;
            menu.Show();
            menu.UpdateLayout();
            PositionMenu(menu);
            menu.Activate();
            // ĐƯA MENU LÊN FOREGROUND (mẫu Win32 chuẩn cho menu khay):
            // chỉ Activate() của WPF là không đủ — log thật sáng 17/11/2026
            // cho thấy menu mở ra rồi mất kích hoạt NGAY LẬP TỨC (Deactivated
            // trong cùng giây, lặp lại mọi lần bấm) vì cửa sổ foreground lúc
            // bấm chuột phải là shell/taskbar, Windows lấy lại kích hoạt ngay.
            // SetForegroundWindow xin quyền foreground cho cửa sổ menu.
            bool foreground = SetForegroundWindow(new System.Windows.Interop.WindowInteropHelper(menu).Handle);
            _log.Info("Tray: SetForegroundWindow cho menu trả về " + foreground + ".");
            _menuOpenedAt = DateTimeOffset.UtcNow;
            _log.Info("Tray: menu đã mở (xong).");
        }
        catch (Exception ex)
        {
            _log.Error("Tray: mở menu lỗi (đã bắt, Tray tiếp tục chạy): " + ex.ToString());
        }
    }

    /// <summary>
    /// Đặt menu cạnh vị trí chuột, ưu tiên phía trên chuột (kiểu menu khay
    /// hệ thống), và giữ menu trong vùng làm việc của màn hình.
    /// </summary>
    private void PositionMenu(TrayMenuWindow menu)
    {
        // Vị trí chuột theo pixel màn hình -> đơn vị WPF (DIP), vì Left/Top
        // của Window tính bằng DIP còn Cursor.Position tính bằng pixel.
        // Lấy DPI của cửa sổ neo qua GetDpiForWindow (Windows 10+). KHÔNG
        // dùng PresentationSource/CompositionTarget: API đó làm CI lỗi
        // CS0234 ở project này (run #54) dù UseWPF đã bật.
        System.Drawing.Point cursor = WinForms.Cursor.Position;
        double scale = GetWindowDpiScale(_anchor);
        double cursorX = cursor.X / scale;
        double cursorY = cursor.Y / scale;

        System.Windows.Rect workArea = System.Windows.SystemParameters.WorkArea;
        double left = cursorX - menu.ActualWidth;
        double top = cursorY - menu.ActualHeight - 4;
        if (top < workArea.Top)
        {
            top = cursorY + 4;
        }

        if (left < workArea.Left)
        {
            left = workArea.Left;
        }

        if (left + menu.ActualWidth > workArea.Right)
        {
            left = workArea.Right - menu.ActualWidth;
        }

        if (top + menu.ActualHeight > workArea.Bottom)
        {
            top = workArea.Bottom - menu.ActualHeight;
        }

        menu.Left = left;
        menu.Top = top;
    }

    /// <summary>
    /// Tỉ lệ DPI của cửa sổ (1.0 ở màn hình 100%). Lấy qua GetDpiForWindow
    /// của user32; thất bại thì trả về 1.0 thay vì làm hỏng việc mở menu.
    /// </summary>
    private static double GetWindowDpiScale(System.Windows.Window window)
    {
        try
        {
            IntPtr hwnd = new System.Windows.Interop.WindowInteropHelper(window).Handle;
            if (hwnd != IntPtr.Zero)
            {
                uint dpi = GetDpiForWindow(hwnd);
                if (dpi > 0)
                {
                    return dpi / 96.0;
                }
            }
        }
        catch
        {
            // Lấy DPI thất bại thì dùng tỉ lệ 1.0 (màn hình 100%).
        }

        return 1.0;
    }

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    /// <summary>Chỉ dùng cho --self-test: mở menu y hệt chuột phải, trả về cửa sổ menu để kiểm tra.</summary>
    internal TrayMenuWindow? OpenMenuForTest()
    {
        OpenMenu();
        return _menuWindow;
    }

    /// <summary>Chỉ dùng cho --self-test: đóng menu đang mở.</summary>
    internal void CloseMenuForTest() => CloseMenu();

    private void CloseMenu()
    {
        if (_menuWindow is { IsVisible: true } window)
        {
            _log.Info("Tray: đóng menu.");
            try
            {
                window.Close();
            }
            catch (Exception ex)
            {
                _log.Error("Tray: đóng menu lỗi (đã bắt): " + ex.ToString());
            }
        }

        _menuWindow = null;
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        CloseMenu();
        _icon.Visible = false;
        _icon.Dispose();
    }
}
