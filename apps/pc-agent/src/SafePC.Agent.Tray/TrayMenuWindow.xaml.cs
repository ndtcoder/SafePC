using System.Windows;
using System.Windows.Input;
using SafePC.Agent.Shared;

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
///
/// CHẨN ĐOÁN (tối 16/11/2026): các process Tray chết sớm sau khởi động/tương
/// tác mà không để lại log nào, và cả buổi tối không có một dòng log bấm
/// menu nào. Mọi cú bấm menu đều ghi breadcrumb (bắt đầu/xong/lỗi) và mọi
/// action đều chạy trong try/catch, để log đuôi cho thấy chính xác Tray đang
/// làm gì nếu nó chết — một action lỗi không được giết Tray.
/// </summary>
public partial class TrayMenuWindow : Window
{
    private readonly LocalLogger _log;
    private readonly Action _showRemainingTime;
    private readonly Action _showExtraTime;
    private readonly Action _requestExit;

    public TrayMenuWindow(LocalLogger log, Action showRemainingTime, Action showExtraTime, Action requestExit)
    {
        ArgumentNullException.ThrowIfNull(log);
        ArgumentNullException.ThrowIfNull(showRemainingTime);
        ArgumentNullException.ThrowIfNull(showExtraTime);
        ArgumentNullException.ThrowIfNull(requestExit);

        _log = log;
        _showRemainingTime = showRemainingTime;
        _showExtraTime = showExtraTime;
        _requestExit = requestExit;

        InitializeComponent();

        Deactivated += (_, _) =>
        {
            _log.Info("Tray: menu mất kích hoạt, đóng.");
            Close();
        };
        PreviewKeyDown += (_, e) =>
        {
            if (e.Key == Key.Escape)
            {
                _log.Info("Tray: menu đóng do bấm Escape.");
                Close();
            }
        };
    }

    private void RemainingButton_Click(object sender, RoutedEventArgs e)
    {
        _log.Info("Tray: menu — bấm 'Xem thời gian còn lại' (bắt đầu).");
        Close();
        InvokeMenuAction(_showRemainingTime, "Xem thời gian còn lại");
    }

    private void ExtraTimeButton_Click(object sender, RoutedEventArgs e)
    {
        _log.Info("Tray: menu — bấm 'Xin thêm giờ' (bắt đầu).");
        Close();
        InvokeMenuAction(_showExtraTime, "Xin thêm giờ");
    }

    private void ExitButton_Click(object sender, RoutedEventArgs e)
    {
        _log.Info("Tray: menu — bấm 'Thoát' (bắt đầu).");
        Close();
        InvokeMenuAction(_requestExit, "Thoát");
    }

    /// <summary>
    /// Chạy một action của menu trong try/catch + breadcrumb: action lỗi thì
    /// ghi log kèm stack và Tray tiếp tục chạy — không bao giờ để một cú bấm
    /// menu giết process mà không để lại dấu vết.
    /// </summary>
    private void InvokeMenuAction(Action action, string name)
    {
        try
        {
            action();
            _log.Info("Tray: menu — '" + name + "' (xong).");
        }
        catch (Exception ex)
        {
            _log.Error("Tray: menu — '" + name + "' lỗi (đã bắt, Tray tiếp tục chạy): " + ex.ToString());
        }
    }
}
