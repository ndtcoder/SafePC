using System.Windows;

namespace SafePC.Agent.Tray;

/// <summary>
/// Cửa sổ thông báo của tính năng nhắn tin (menu "Nhắn tin với bố mẹ"):
/// hiện câu lỗi thân thiện khi không mở được chat (chưa ghép nối, server
/// chưa bật nhắn tin, lỗi tạm thời). Theo đúng mẫu
/// <see cref="RemainingTimeWindow"/>: cửa sổ top-level độc lập, KHÔNG đặt
/// Owner (bài học cửa sổ neo — xem ghi chú ở App.xaml.cs). Mọi lần gọi đều
/// từ UI thread.
/// </summary>
public partial class ChatMessageWindow : Window
{
    public ChatMessageWindow(string text)
    {
        InitializeComponent();
        InfoText.Text = text;
    }

    private void CloseButton_Click(object sender, RoutedEventArgs e)
    {
        Close();
    }
}
