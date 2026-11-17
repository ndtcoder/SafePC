using System.Windows;

namespace SafePC.Agent.Tray;

/// <summary>
/// Cửa sổ "Xem thời gian còn lại" từ menu tray. App mở cửa sổ với chuỗi
/// "Đang tải...", hỏi Service qua IPC rồi gọi <see cref="Update"/> với
/// kết quả thật. Mọi lần gọi đều từ UI thread (App dùng Dispatcher).
/// </summary>
public partial class RemainingTimeWindow : Window
{
    public RemainingTimeWindow(string text)
    {
        InitializeComponent();
        InfoText.Text = text;
    }

    /// <summary>Cập nhật nội dung hiển thị (gọi từ UI thread).</summary>
    public void Update(string text)
    {
        InfoText.Text = text;
    }

    private void CloseButton_Click(object sender, RoutedEventArgs e)
    {
        Close();
    }
}
