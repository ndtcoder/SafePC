using System.Windows;

namespace SafePC.Agent.Tray;

/// <summary>
/// Cửa sổ "Xem thời gian còn lại" từ menu tray.
/// SKELETON: chỉ hiển thị chuỗi được truyền vào.
/// TODO Sprint 1: hiển thị thời gian còn lại thật + rules của con, lấy từ Service qua IPC.
/// </summary>
public partial class RemainingTimeWindow : Window
{
    public RemainingTimeWindow(string text)
    {
        InitializeComponent();
        InfoText.Text = text;
    }

    private void CloseButton_Click(object sender, RoutedEventArgs e)
    {
        Close();
    }
}
