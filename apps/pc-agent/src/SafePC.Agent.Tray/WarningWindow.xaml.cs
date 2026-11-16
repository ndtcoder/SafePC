using System.Windows;

namespace SafePC.Agent.Tray;

/// <summary>
/// Cửa sổ cảnh báo sắp hết giờ (còn 15/5/1 phút). Mở khi nhận message IPC
/// "warning" từ Service. Khi minutesLeft &lt;= 0 (thông báo đã đóng app theo
/// quy tắc), dòng đếm ngược được ẩn đi, chỉ hiện lý do. Skeleton: chỉ hiển
/// thị, chưa có đếm ngược trực tiếp.
/// TODO Sprint 1: đếm ngược theo thời gian thực + âm thanh/nhấp nháy nhẹ.
/// </summary>
public partial class WarningWindow : Window
{
    public WarningWindow(string reason, int minutesLeft)
    {
        InitializeComponent();
        MessageText.Text = string.IsNullOrWhiteSpace(reason)
            ? "Sắp hết thời gian dùng máy."
            : reason;
        if (minutesLeft <= 0)
        {
            CountdownText.Visibility = Visibility.Collapsed;
        }
        else
        {
            CountdownText.Text = $"Còn lại khoảng {minutesLeft} phút.";
        }
    }

    private void OkButton_Click(object sender, RoutedEventArgs e)
    {
        Close();
    }
}
