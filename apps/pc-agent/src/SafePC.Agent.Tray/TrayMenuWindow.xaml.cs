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
    private readonly Action _openChat;
    private readonly Action _showExtraTime;
    private readonly Action _requestExit;

    /// <summary>
    /// Thời điểm menu hiện lên (Loaded): các sự kiện Deactivated trong
    /// 300ms đầu bị bỏ qua — log thật sáng 17/11/2026 cho thấy menu mất kích
    /// hoạt ngay trong cùng giây vừa mở (Windows lấy lại kích hoạt cho
    /// shell), khiến menu chớp rồi đóng và user không bao giờ thấy menu.
    /// SetForegroundWindow (TrayIconManager) là sửa chính; khoảng ân hạn
    /// này là lưới an toàn cho lần kích hoạt đầu chưa ổn định.
    /// </summary>
    private DateTimeOffset _shownAt;

    public TrayMenuWindow(LocalLogger log, Action showRemainingTime, Action openChat, Action showExtraTime, Action requestExit, string? screenStatusText = null)
    {
        ArgumentNullException.ThrowIfNull(log);
        ArgumentNullException.ThrowIfNull(showRemainingTime);
        ArgumentNullException.ThrowIfNull(openChat);
        ArgumentNullException.ThrowIfNull(showExtraTime);
        ArgumentNullException.ThrowIfNull(requestExit);

        _log = log;
        _showRemainingTime = showRemainingTime;
        _openChat = openChat;
        _showExtraTime = showExtraTime;
        _requestExit = requestExit;

        InitializeComponent();

        // Dòng trạng thái chụp màn hình (migration 32): chỉ hiện khi App
        // đã nhận trạng thái từ Service; câu chữ chỉ là đang bật/đang
        // tắt, không tần suất (minh bạch theo quyết định 28/11/2026).
        if (string.IsNullOrWhiteSpace(screenStatusText))
        {
            ScreenStatusText.Visibility = Visibility.Collapsed;
            ScreenStatusSeparator.Visibility = Visibility.Collapsed;
        }
        else
        {
            ScreenStatusText.Text = screenStatusText;
        }

        Loaded += (_, _) => _shownAt = DateTimeOffset.UtcNow;
        Deactivated += (_, _) =>
        {
            if (DateTimeOffset.UtcNow - _shownAt < TimeSpan.FromMilliseconds(300))
            {
                _log.Info("Tray: menu mất kích hoạt trong 300ms đầu, bỏ qua (ân hạn).");
                return;
            }

            _log.Info("Tray: menu mất kích hoạt, đóng.");
            try
            {
                Close();
            }
            catch (InvalidOperationException)
            {
                // Menu đang đóng dở (chuột phải bật/tắt gọi Close() cùng lúc
                // Deactivated chạy): lần đóng thứ hai ném InvalidOperationException
                // "while a Window is closing" — cửa sổ vẫn đóng bình thường,
                // chỉ bỏ qua exception này (gặp ở log thật ngày 17/11/2026).
                _log.Info("Tray: menu đang đóng dở, bỏ qua lần đóng thứ hai.");
            }
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

    private void ChatButton_Click(object sender, RoutedEventArgs e)
    {
        _log.Info("Tray: menu — bấm 'Nhắn tin với bố mẹ' (bắt đầu).");
        Close();
        InvokeMenuAction(_openChat, "Nhắn tin với bố mẹ");
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
