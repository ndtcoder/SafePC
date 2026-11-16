using System.Drawing;
using WinForms = System.Windows.Forms;

namespace SafePC.Agent.Tray;

/// <summary>
/// Tray icon dùng System.Windows.Forms.NotifyIcon (bật UseWindowsForms, không
/// cần package ngoài). Menu chuột phải là WPF ContextMenu, mở bằng tay khi
/// nhận MouseUp chuột phải. Menu: Xem thời gian còn lại, Xin thêm giờ, Thoát.
/// Thoát yêu cầu mã PIN — logic PIN nằm ở <see cref="PinDialog"/>.
///
/// Vì sao KHÔNG dùng WinForms ContextMenuStrip: app này là WPF, vòng lặp
/// message duy nhất là WPF Dispatcher (ShutdownMode.OnExplicitShutdown, không
/// có cửa sổ chính), không hề gọi WinForms Application.Run. ContextMenuStrip
/// cần message filter của WinForms (ToolStripManager) để nhận chuột, nên
/// trong app WPF nó hiện lên nhưng bị đơ khi di chuột vào — lỗi này đã gặp
/// trên máy thật ngày 2026-11-16. WPF ContextMenu chạy trên Dispatcher nên
/// không gặp vấn đề đó. Mọi kiểu WPF đều ghi rõ namespace đầy đủ vì project
/// bật cả UseWPF lẫn UseWindowsForms (ContextMenu/MenuItem tồn tại ở cả hai).
/// </summary>
public sealed class TrayIconManager : IDisposable
{
    private readonly WinForms.NotifyIcon _icon;
    private readonly System.Windows.Controls.ContextMenu _menu;
    private bool _disposed;

    public TrayIconManager(Action showRemainingTime, Action showExtraTime, Action requestExit)
    {
        ArgumentNullException.ThrowIfNull(showRemainingTime);
        ArgumentNullException.ThrowIfNull(showExtraTime);
        ArgumentNullException.ThrowIfNull(requestExit);

        _menu = new System.Windows.Controls.ContextMenu();

        var remainingItem = new System.Windows.Controls.MenuItem { Header = "Xem thời gian còn lại" };
        remainingItem.Click += (_, _) => showRemainingTime();

        var extraTimeItem = new System.Windows.Controls.MenuItem { Header = "Xin thêm giờ" };
        extraTimeItem.Click += (_, _) => showExtraTime();

        var exitItem = new System.Windows.Controls.MenuItem { Header = "Thoát" };
        exitItem.Click += (_, _) => requestExit();

        _menu.Items.Add(remainingItem);
        _menu.Items.Add(extraTimeItem);
        _menu.Items.Add(new System.Windows.Controls.Separator());
        _menu.Items.Add(exitItem);

        _icon = new WinForms.NotifyIcon
        {
            // TODO Sprint 1: icon .ico riêng của SafePC thay cho icon hệ thống.
            Icon = SystemIcons.Information,
            Text = "SafePC",
            Visible = true,
        };
        _icon.MouseUp += OnIconMouseUp;
        _icon.DoubleClick += (_, _) => showRemainingTime();
    }

    private void OnIconMouseUp(object? sender, WinForms.MouseEventArgs e)
    {
        if (_disposed || e.Button != WinForms.MouseButtons.Right)
        {
            return;
        }

        // Mở menu tại vị trí chuột; WPF tự lật menu lên trên nếu gần mép màn hình.
        _menu.Placement = System.Windows.Controls.Primitives.PlacementMode.MousePoint;
        _menu.IsOpen = true;
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _menu.IsOpen = false;
        _icon.Visible = false;
        _icon.Dispose();
    }
}
