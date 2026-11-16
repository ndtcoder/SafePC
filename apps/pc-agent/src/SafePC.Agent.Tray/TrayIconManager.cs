using System.Drawing;
using WinForms = System.Windows.Forms;

namespace SafePC.Agent.Tray;

/// <summary>
/// Tray icon dùng System.Windows.Forms.NotifyIcon (bật UseWindowsForms, không
/// cần package ngoài). Menu: Xem thời gian còn lại, Xin thêm giờ, Thoát.
/// Thoát yêu cầu mã PIN — logic PIN nằm ở <see cref="PinDialog"/>.
/// </summary>
public sealed class TrayIconManager : IDisposable
{
    private readonly WinForms.NotifyIcon _icon;
    private readonly WinForms.ContextMenuStrip _menu;
    private bool _disposed;

    public TrayIconManager(Action showRemainingTime, Action showExtraTime, Action requestExit)
    {
        ArgumentNullException.ThrowIfNull(showRemainingTime);
        ArgumentNullException.ThrowIfNull(showExtraTime);
        ArgumentNullException.ThrowIfNull(requestExit);

        _menu = new WinForms.ContextMenuStrip();

        var remainingItem = new WinForms.ToolStripMenuItem("Xem thời gian còn lại");
        remainingItem.Click += (_, _) => showRemainingTime();

        var extraTimeItem = new WinForms.ToolStripMenuItem("Xin thêm giờ");
        extraTimeItem.Click += (_, _) => showExtraTime();

        var exitItem = new WinForms.ToolStripMenuItem("Thoát");
        exitItem.Click += (_, _) => requestExit();

        _menu.Items.Add(remainingItem);
        _menu.Items.Add(extraTimeItem);
        _menu.Items.Add(new WinForms.ToolStripSeparator());
        _menu.Items.Add(exitItem);

        _icon = new WinForms.NotifyIcon
        {
            // TODO Sprint 1: icon .ico riêng của SafePC thay cho icon hệ thống.
            Icon = SystemIcons.Information,
            Text = "SafePC",
            ContextMenuStrip = _menu,
            Visible = true,
        };
        _icon.DoubleClick += (_, _) => showRemainingTime();
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _icon.Visible = false;
        _icon.Dispose();
        _menu.Dispose();
    }
}
