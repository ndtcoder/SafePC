using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Threading;

namespace SafePC.Agent.Tray;

/// <summary>
/// Màn hình khóa toàn màn hình khi hết giờ: hiện lý do, đếm ngược 60 giây để
/// con kịp lưu bài, rồi khóa phiên làm việc bằng LockWorkStation. Mở khi nhận
/// message IPC "lock" từ Service, đóng khi nhận "unlock" (đóng cửa sổ thì
/// đếm ngược dừng theo).
///
/// TODO Sprint 2 (đợt 3): xử lý Alt+Tab / Task Manager ở mức hợp lý, không
/// chặn phá hoại; hiển thị trạng thái yêu cầu xin thêm giờ.
/// </summary>
public partial class LockWindow : Window
{
    private const int CountdownSeconds = 60;

    private readonly Action _showExtraTime;
    private readonly DispatcherTimer _countdownTimer;
    private int _secondsLeft = CountdownSeconds;
    private bool _locked;

    public LockWindow(string reason, Action showExtraTime)
    {
        InitializeComponent();
        _showExtraTime = showExtraTime;
        ReasonText.Text = reason;
        CountdownText.Text = "Máy sẽ khóa sau " + CountdownSeconds + " giây.";
        _countdownTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _countdownTimer.Tick += OnCountdownTick;
        Loaded += (_, _) => _countdownTimer.Start();
        Closed += (_, _) => _countdownTimer.Stop();
    }

    private void OnCountdownTick(object? sender, EventArgs e)
    {
        _secondsLeft--;
        if (_secondsLeft <= 0)
        {
            _countdownTimer.Stop();
            if (!_locked)
            {
                _locked = true;
                LockWorkStation();
            }

            return;
        }

        CountdownText.Text = "Máy sẽ khóa sau " + _secondsLeft + " giây.";
    }

    private void ExtraTimeButton_Click(object sender, RoutedEventArgs e)
    {
        _showExtraTime();
    }

    [DllImport("user32.dll")]
    private static extern bool LockWorkStation();
}
