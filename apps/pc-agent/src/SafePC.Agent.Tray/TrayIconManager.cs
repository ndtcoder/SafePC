using System.Drawing;
using WinForms = System.Windows.Forms;

namespace SafePC.Agent.Tray;

/// <summary>
/// Tray icon dùng System.Windows.Forms.NotifyIcon (bật UseWindowsForms, không
/// cần package ngoài). Menu chuột phải là một cửa sổ WPF thật
/// (<see cref="TrayMenuWindow"/>), mở bằng tay khi nhận MouseUp chuột phải.
/// Menu: Xem thời gian còn lại, Xin thêm giờ, Thoát. Thoát yêu cầu mã PIN —
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
/// </summary>
public sealed class TrayIconManager : IDisposable
{
    private readonly WinForms.NotifyIcon _icon;
    private readonly System.Windows.Window _anchor;
    private readonly Action _showRemainingTime;
    private readonly Action _showExtraTime;
    private readonly Action _requestExit;
    private TrayMenuWindow? _menuWindow;
    private DateTimeOffset _menuClosedAt;
    private bool _disposed;

    public TrayIconManager(System.Windows.Window anchor, Action showRemainingTime, Action showExtraTime, Action requestExit)
    {
        ArgumentNullException.ThrowIfNull(anchor);
        ArgumentNullException.ThrowIfNull(showRemainingTime);
        ArgumentNullException.ThrowIfNull(showExtraTime);
        ArgumentNullException.ThrowIfNull(requestExit);

        _anchor = anchor;
        _showRemainingTime = showRemainingTime;
        _showExtraTime = showExtraTime;
        _requestExit = requestExit;

        _icon = new WinForms.NotifyIcon
        {
            // TODO Sprint 1: icon .ico riêng của SafePC thay cho icon hệ thống.
            Icon = SystemIcons.Information,
            Text = "SafePC",
            Visible = true,
        };
        _icon.MouseUp += OnIconMouseUp;
        _icon.DoubleClick += (_, _) =>
        {
            CloseMenu();
            showRemainingTime();
        };
    }

    private void OnIconMouseUp(object? sender, WinForms.MouseEventArgs e)
    {
        if (_disposed || e.Button != WinForms.MouseButtons.Right)
        {
            return;
        }

        // Menu đang mở: chuột phải thì đóng (bật/tắt, như tray chuẩn).
        if (_menuWindow is { IsVisible: true })
        {
            CloseMenu();
            return;
        }

        // Menu vừa đóng do mất kích hoạt (cú chuột phải này khiến menu mất
        // kích hoạt rồi đóng ngay trước MouseUp): coi như bật/tắt, không mở
        // lại, nếu không menu sẽ nháy lên ngay sau khi vừa đóng.
        if (DateTimeOffset.UtcNow - _menuClosedAt < TimeSpan.FromMilliseconds(250))
        {
            return;
        }

        OpenMenu();
    }

    private void OpenMenu()
    {
        CloseMenu();

        var menu = new TrayMenuWindow(_showRemainingTime, _showExtraTime, _requestExit)
        {
            Owner = _anchor,
            Left = -10000,
            Top = -10000,
        };
        menu.Closed += (_, _) =>
        {
            _menuClosedAt = DateTimeOffset.UtcNow;
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
    }

    /// <summary>
    /// Đặt menu cạnh vị trí chuột, ưu tiên phía trên chuột (kiểu menu khay
    /// hệ thống), và giữ menu trong vùng làm việc của màn hình.
    /// </summary>
    private void PositionMenu(TrayMenuWindow menu)
    {
        // Vị trí chuột theo pixel màn hình -> đơn vị WPF (DIP), vì Left/Top
        // của Window tính bằng DIP còn Cursor.Position tính bằng pixel.
        System.Drawing.Point cursor = WinForms.Cursor.Position;
        var point = new System.Windows.Point(cursor.X, cursor.Y);
        System.Windows.Media.PresentationSource? source = System.Windows.Media.PresentationSource.FromVisual(_anchor);
        if (source?.CompositionTarget is not null)
        {
            point = source.CompositionTarget.TransformFromDevice.Transform(point);
        }

        System.Windows.Rect workArea = System.Windows.SystemParameters.WorkArea;
        double left = point.X - menu.ActualWidth;
        double top = point.Y - menu.ActualHeight - 4;
        if (top < workArea.Top)
        {
            top = point.Y + 4;
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

    private void CloseMenu()
    {
        if (_menuWindow is { IsVisible: true } window)
        {
            window.Close();
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
