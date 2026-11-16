using System.Windows;

namespace SafePC.Agent.Tray;

/// <summary>
/// Màn hình khóa toàn màn hình khi hết giờ: hiện lý do + nút "Xin thêm giờ".
/// Mở khi nhận message IPC "lock" từ Service, đóng khi nhận "unlock".
///
/// SKELETON — Sprint 0: cửa sổ fullscreen topmost, chưa khóa thật.
/// TODO Sprint 2:
/// - Đếm ngược 60s để con kịp lưu bài, rồi phối hợp với Service gọi
///   LockWorkStation (không tắt máy đột ngột — docs/01-PRD.md mục 2.3).
/// - Xử lý Alt+Tab / Task Manager ở mức hợp lý, không chặn phá hoại.
/// - Hiển thị trạng thái yêu cầu xin thêm giờ (đang chờ/được duyệt/từ chối).
/// </summary>
public partial class LockWindow : Window
{
    private readonly Action _showExtraTime;

    public LockWindow(string reason, Action showExtraTime)
    {
        InitializeComponent();
        _showExtraTime = showExtraTime;
        ReasonText.Text = reason;
    }

    private void ExtraTimeButton_Click(object sender, RoutedEventArgs e)
    {
        _showExtraTime();
    }
}
