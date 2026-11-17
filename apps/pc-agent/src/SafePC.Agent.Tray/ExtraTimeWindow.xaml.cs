using System.Windows;
using System.Windows.Controls;

namespace SafePC.Agent.Tray;

/// <summary>
/// Form "Xin thêm giờ": chọn 15/30/60 phút + nhập lý do, gửi qua IPC lên
/// Service; Service xếp vào outbox và đẩy lên bảng requests để phụ huynh
/// duyệt trên Dashboard. Duyệt thì Dashboard gửi lệnh cộng giờ về máy.
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
            "Đã gửi yêu cầu xin thêm " + minutes + " phút. Phụ huynh sẽ duyệt trên Dashboard, máy sẽ tự mở thêm giờ khi được duyệt.",
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
