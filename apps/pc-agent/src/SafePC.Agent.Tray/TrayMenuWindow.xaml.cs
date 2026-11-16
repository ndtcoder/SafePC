using System.Windows;
using System.Windows.Input;

namespace SafePC.Agent.Tray;

/// <summary>
/// Cửa sổ menu chuột phải của tray icon, thay cho WPF ContextMenu.
///
/// LỊCH SỬ LỖI (máy thật, 2026-11-16): WPF ContextMenu mở từ NotifyIcon
/// liên tục kẹt — hiện nhưng không nhận chuột, không tự đóng, nuốt mọi cú
/// chuột của cả app — qua 3 lần sửa (đổi từ WinForms ContextMenuStrip sang
/// WPF ContextMenu, thêm cửa sổ neo làm PlacementTarget, bật/tắt bằng tay).
/// Nguyên nhân là popup của ContextMenu phụ thuộc vào trạng thái kích hoạt
/// (activation) của cửa sổ chủ, mà app Tray không có cửa sổ chính thật.
/// Cửa sổ thật này tự kích hoạt và nhận chuột như mọi cửa sổ WPF khác nên
/// không gặp vấn đề đó. Đóng khi: mất kích hoạt, bấm Escape, chọn một mục,
/// hoặc chuột phải lại vào icon (bật/tắt, xử lý ở TrayIconManager).
/// </summary>
public partial class TrayMenuWindow : Window
{
    private readonly Action _showRemainingTime;
    private readonly Action _showExtraTime;
    private readonly Action _requestExit;

    public TrayMenuWindow(Action showRemainingTime, Action showExtraTime, Action requestExit)
    {
        ArgumentNullException.ThrowIfNull(showRemainingTime);
        ArgumentNullException.ThrowIfNull(showExtraTime);
        ArgumentNullException.ThrowIfNull(requestExit);

        _showRemainingTime = showRemainingTime;
        _showExtraTime = showExtraTime;
        _requestExit = requestExit;

        InitializeComponent();

        Deactivated += (_, _) => Close();
        PreviewKeyDown += (_, e) =>
        {
            if (e.Key == Key.Escape)
            {
                Close();
            }
        };
    }

    private void RemainingButton_Click(object sender, RoutedEventArgs e)
    {
        Close();
        _showRemainingTime();
    }

    private void ExtraTimeButton_Click(object sender, RoutedEventArgs e)
    {
        Close();
        _showExtraTime();
    }

    private void ExitButton_Click(object sender, RoutedEventArgs e)
    {
        Close();
        _requestExit();
    }
}
