using System.Windows;
using System.Windows.Controls;

namespace SafePC.Agent.Tray;

/// <summary>
/// Form "Xin thêm giờ": chọn 15/30/60 phút + nhập lý do, gửi qua IPC lên Service.
/// TODO Sprint 2: gửi yêu cầu thật lên bảng requests (Supabase), hiển thị trạng
/// thái chờ duyệt và kết quả Duyệt/Từ chối từ phụ huynh.
/// </summary>
public partial class ExtraTimeWindow : Window
{
    private readonly Func<int, string, Task> _sendRequest;

    public ExtraTimeWindow(Func<int, string, Task> sendRequest)
    {
        InitializeComponent();
        _sendRequest = sendRequest;
    }

    private async void SendButton_Click(object sender, RoutedEventArgs e)
    {
        int minutes = 15;
        if (MinutesBox.SelectedItem is ComboBoxItem item
            && item.Tag is string tag
            && int.TryParse(tag, out int parsed))
        {
            minutes = parsed;
        }

        string reason = ReasonBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(reason))
        {
            _ = System.Windows.MessageBox.Show("Bạn hãy nhập lý do xin thêm giờ.", "SafePC", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        await _sendRequest(minutes, reason);
        _ = System.Windows.MessageBox.Show(
            "Đã gửi yêu cầu (bản skeleton — Sprint 2 mới gửi thật lên server để phụ huynh duyệt).",
            "SafePC",
            MessageBoxButton.OK,
            MessageBoxImage.Information);
        Close();
    }

    private void CancelButton_Click(object sender, RoutedEventArgs e)
    {
        Close();
    }
}
