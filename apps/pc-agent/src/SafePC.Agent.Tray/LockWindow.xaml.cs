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
/// Chế độ Immediate (khóa tới sau khi độ trễ cảnh báo đã hết): con đã có cả
/// thời gian chờ để lưu bài nên không đếm ngược nữa — hiện màn hình khóa,
/// ẩn dòng đếm ngược, đổi lời nhắc, khóa phiên ngay khi hiện (yêu cầu test
/// máy thật 17/11/2026).
///
/// TODO Sprint 2 (đợt 3): xử lý Alt+Tab / Task Manager ở mức hợp lý, không
/// chặn phá hoại; hiển thị trạng thái yêu cầu xin thêm giờ.
/// </summary>
public partial class LockWindow : Window
{
    private const int CountdownSeconds = 60;

    /// <summary>
    /// Chỉ dùng cho --self-test: không gọi LockWorkStation thật (khóa phiên
    /// của runner CI sẽ phá các check sau). Mặc định false; self-test bật
    /// trong lúc kiểm tra chế độ Immediate rồi tắt lại. Process self-test
    /// thoát ngay sau đó nên cờ không bao giờ rò sang chạy thật.
    /// </summary>
    internal static bool SuppressWorkstationLockForTest { get; set; }

    private readonly Action _showExtraTime;
    private readonly DispatcherTimer _countdownTimer;
    private int _secondsLeft = CountdownSeconds;
    private bool _locked;

    /// <summary>Cho self-test kiểm tra dòng đếm ngược có bị ẩn ở chế độ Immediate không.</summary>
    internal bool CountdownVisible => CountdownText.Visibility == Visibility.Visible;

    public LockWindow(string reason, Action showExtraTime, bool immediate = false)
    {
        InitializeComponent();
        _showExtraTime = showExtraTime;
        ReasonText.Text = reason;
        if (immediate)
        {
            CountdownText.Visibility = Visibility.Collapsed;
            HintText.Text = "Máy đã khóa. Bấm Xin thêm giờ để gửi yêu cầu tới phụ huynh.";
        }
        else
        {
            CountdownText.Text = "Máy sẽ khóa sau " + CountdownSeconds + " giây.";
        }

        _countdownTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _countdownTimer.Tick += OnCountdownTick;
        Loaded += (_, _) =>
        {
            if (immediate)
            {
                LockNow();
            }
            else
            {
                _countdownTimer.Start();
            }
        };
        Closed += (_, _) => _countdownTimer.Stop();
    }

    /// <summary>Khóa phiên ngay (chế độ Immediate): dừng đếm ngược, khóa một lần duy nhất.</summary>
    private void LockNow()
    {
        _countdownTimer.Stop();
        if (!_locked)
        {
            _locked = true;
            if (!SuppressWorkstationLockForTest)
            {
                LockWorkStation();
            }
        }
    }

    /// <summary>
    /// Chuyển một cửa sổ đang đếm ngược sang khóa ngay (lệnh khóa Immediate
    /// tới trong lúc cửa sổ thường đang hiện): dừng đếm ngược, ẩn dòng đếm
    /// ngược, đổi lời nhắc, khóa phiên ngay.
    /// </summary>
    public void LockImmediately()
    {
        CountdownText.Visibility = Visibility.Collapsed;
        HintText.Text = "Máy đã khóa. Bấm Xin thêm giờ để gửi yêu cầu tới phụ huynh.";
        LockNow();
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
                if (!SuppressWorkstationLockForTest)
                {
                    LockWorkStation();
                }
            }

            return;
        }

        CountdownText.Text = "Máy sẽ khóa sau " + _secondsLeft + " giây.";
    }

    /// <summary>
    /// Khóa lại ngay khi Service nhắc lại lệnh khóa (giờ nghỉ bắt buộc nhắc
    /// mỗi 15 giây): chỉ khi cửa sổ đã khóa rồi (hết đếm ngược, con đăng
    /// nhập lại sớm) thì gọi LockWorkStation lại ngay; đang đếm ngược thì
    /// không làm gì — đếm ngược KHÔNG khởi động lại.
    /// </summary>
    public void ReassertLock()
    {
        if (_locked && !SuppressWorkstationLockForTest)
        {
            LockWorkStation();
        }
    }

    private void ExtraTimeButton_Click(object sender, RoutedEventArgs e)
    {
        _showExtraTime();
    }

    [DllImport("user32.dll")]
    private static extern bool LockWorkStation();
}
