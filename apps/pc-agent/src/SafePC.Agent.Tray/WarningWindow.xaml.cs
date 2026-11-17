using System;
using System.Globalization;
using System.Windows;
using System.Windows.Threading;

namespace SafePC.Agent.Tray;

/// <summary>
/// Cửa sổ cảnh báo sắp hết giờ — cửa sổ NHỎ, không full màn, con vẫn làm
/// việc và lưu bài trong lúc cảnh báo hiện. Mở khi nhận message IPC
/// "warning" từ Service; đếm ngược trực tiếp theo từng giây tới thời điểm
/// khóa. Khi minutesLeft &lt;= 0 (thông báo đã đóng app theo quy tắc), dòng
/// đếm ngược được ẩn đi, chỉ hiện lý do. Nút "Đã hiểu" đóng cửa sổ;
/// Service gửi lại cảnh báo ở lần kiểm tra sau nếu vẫn còn trong giai đoạn
/// chờ, nên đóng cửa sổ không làm mất cảnh báo.
/// </summary>
public partial class WarningWindow : Window
{
    private readonly DispatcherTimer _timer;
    private DateTimeOffset _deadline;

    public WarningWindow(string reason, int minutesLeft)
    {
        InitializeComponent();
        _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _timer.Tick += (_, _) => RefreshCountdown();
        Closed += (_, _) => _timer.Stop();
        Update(reason, minutesLeft);
    }

    /// <summary>Cập nhật lý do + đặt lại đếm ngược (cảnh báo nhắc lại).</summary>
    public void Update(string reason, int minutesLeft)
    {
        MessageText.Text = string.IsNullOrWhiteSpace(reason)
            ? "Sắp hết thời gian dùng máy."
            : reason;
        if (minutesLeft <= 0)
        {
            _timer.Stop();
            CountdownText.Visibility = Visibility.Collapsed;
        }
        else
        {
            _deadline = DateTimeOffset.UtcNow.AddMinutes(minutesLeft);
            CountdownText.Visibility = Visibility.Visible;
            RefreshCountdown();
            _timer.Start();
        }
    }

    private void RefreshCountdown()
    {
        TimeSpan remaining = _deadline - DateTimeOffset.UtcNow;
        if (remaining <= TimeSpan.Zero)
        {
            CountdownText.Text = "Sắp khóa máy.";
            _timer.Stop();
            return;
        }

        CountdownText.Text = "Còn lại " + (int)remaining.TotalMinutes + ":" + remaining.Seconds.ToString("D2", CultureInfo.InvariantCulture) + " trước khi khóa máy.";
    }

    private void OkButton_Click(object sender, RoutedEventArgs e)
    {
        Close();
    }
}
