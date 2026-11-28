using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.Json;
using System.Threading;
using Microsoft.Win32;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Tray;

/// <summary>
/// Module chụp màn hình phía Tray (migration 32): Tray chạy trong phiên
/// người dùng nên là nơi duy nhất nhìn thấy desktop (Service ở session 0
/// không chụp được). Service báo trạng thái hiệu lực qua IPC
/// (<see cref="IpcMessageTypes.ScreenCaptureState"/>) — bật/tắt + nhịp
/// chụp NỘI BỘ của con đang active ở phiên này; Tray chụp toàn màn hình
/// ảo, thu nhỏ tối đa 1280px chiều ngang, lưu JPEG chất lượng 72 vào
/// hàng đợi <c>%ProgramData%\SafePC\shared\screen_queue</c> kèm file
/// .json (SID phiên + thời điểm UTC + kích thước) để Service đối chiếu
/// con, upload Drive và xóa.
///
/// TUYỆT ĐỐI không hiển thị nhịp chụp ra bất kỳ UI nào phía con (quyết
/// định minh bạch 28/11/2026: menu khay chỉ hiện "Chụp màn hình: đang
/// bật", thông báo hằng tuần không nêu tần suất).
///
/// Bỏ qua lượt chụp khi:
/// - Phiên đang bị khóa: theo dõi qua
///   <see cref="SystemEvents.SessionSwitch"/> (SessionLock/SessionUnlock)
///   — màn hình khóa/secure desktop không chụp được và cũng không nên chụp.
/// - Phiên không phải phiên console đang active (WTSGetActiveConsoleSessionId
///   khác session của Tray): phiên nền không bị quản lý (Sprint 5).
/// - CopyFromScreen lỗi (secure desktop như hộp thoại UAC/Ctrl+Alt+Del):
///   bắt lỗi, ghi log nhẹ, bỏ qua lượt đó.
///
/// Timer là <see cref="System.Threading.Timer"/> chạy trên thread-pool —
/// KHÔNG chạy trên UI thread; lượt chụp đầu tiên sau khi bật diễn ra sau
/// tối đa 15 giây (để phụ huynh/con thấy tính năng thật sự chạy), các
/// lượt sau đúng nhịp Service gửi.
/// </summary>
public sealed class ScreenCapturer : IDisposable
{
    /// <summary>Chiều ngang tối đa của ảnh sau thu nhỏ (docs/11 mục 1.4).</summary>
    private const int MaxWidth = 1280;

    /// <summary>Chất lượng JPEG (docs/11: q72, thực tế ~80–250KB/ảnh).</summary>
    private const long JpegQuality = 72L;

    /// <summary>Độ trễ lượt chụp đầu tiên sau khi chụp được bật cho phiên này.</summary>
    private static readonly TimeSpan FirstCaptureDelay = TimeSpan.FromSeconds(15);

    private readonly LocalLogger _log;
    private readonly string _queueDirectory;
    private readonly string? _sid;
    private readonly System.Threading.Timer _timer;

    private readonly object _stateGate = new();
    private bool _enabled;
    private int _intervalMinutes;
    private Guid? _childId;
    private volatile bool _sessionLocked;
    private int _capturing;
    private bool _disposed;

    public ScreenCapturer(LocalLogger log)
    {
        _log = log;
        _queueDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "SafePC", "shared", "screen_queue");
        try
        {
            using WindowsIdentity identity = WindowsIdentity.GetCurrent();
            _sid = identity.User?.Value;
        }
        catch
        {
            _sid = null;
        }

        _timer = new System.Threading.Timer(OnTimerTick, null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
        SystemEvents.SessionSwitch += OnSessionSwitch;
    }

    /// <summary>Chụp có đang hiệu lực cho phiên này không (App đọc để hiện dòng trạng thái menu + quyết định thông báo minh bạch).</summary>
    public bool IsEnabled
    {
        get { lock (_stateGate) { return _enabled; } }
    }

    /// <summary>
    /// Nhận trạng thái mới từ Service (gọi trên UI thread từ App): đổi
    /// nhịp/con thì đặt lại timer; tắt thì dừng timer ngay. Trạng thái
    /// giống hệt lần trước thì không làm gì (Service chỉ gửi khi đổi,
    /// nhưng Tray tự vệ thêm một lớp).
    /// </summary>
    public void UpdateState(ScreenCaptureStatePayload state)
    {
        ArgumentNullException.ThrowIfNull(state);

        lock (_stateGate)
        {
            bool changed = _enabled != state.Enabled
                || _intervalMinutes != state.IntervalMinutes
                || _childId != state.ChildId;
            if (!changed)
            {
                return;
            }

            _enabled = state.Enabled;
            _intervalMinutes = state.IntervalMinutes;
            _childId = state.ChildId;
        }

        if (state.Enabled && state.IntervalMinutes >= 1 && state.ChildId is not null)
        {
            _timer.Change(FirstCaptureDelay, TimeSpan.FromMinutes(state.IntervalMinutes));
            _log.Info("Tray: chụp màn hình đã BẬT cho phiên này (không ghi nhịp chụp vào log/UI phía con).");
        }
        else
        {
            _timer.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
            _log.Info("Tray: chụp màn hình đã tắt cho phiên này.");
        }
    }

    private void OnSessionSwitch(object sender, SessionSwitchEventArgs e)
    {
        if (e.Reason == SessionSwitchReason.SessionLock)
        {
            _sessionLocked = true;
            _log.Info("Tray: phiên đã khóa — tạm dừng chụp màn hình.");
        }
        else if (e.Reason == SessionSwitchReason.SessionUnlock)
        {
            _sessionLocked = false;
            _log.Info("Tray: phiên đã mở khóa — tiếp tục chụp màn hình theo trạng thái.");
        }
    }

    private void OnTimerTick(object? state)
    {
        // Chống chồng lượt: một lượt chụp kẹt (đĩa chậm) không xếp chồng
        // lượt sau — mức 1 phút cũng không bao giờ block lẫn nhau.
        if (Interlocked.Exchange(ref _capturing, 1) == 1)
        {
            return;
        }

        try
        {
            CaptureOnce();
        }
        catch (Exception ex)
        {
            _log.Error("Tray: lượt chụp màn hình lỗi (đã bắt, bỏ qua lượt này).", ex);
        }
        finally
        {
            Interlocked.Exchange(ref _capturing, 0);
        }
    }

    private void CaptureOnce()
    {
        lock (_stateGate)
        {
            if (!_enabled || _disposed)
            {
                return;
            }
        }

        if (_sessionLocked)
        {
            _log.Info("Tray: bỏ qua lượt chụp — phiên đang khóa.");
            return;
        }

        // Chỉ phiên console đang active mới chụp (phiên nền tạm dừng —
        // cùng ngữ nghĩa thi hành Sprint 5 phía Service).
        try
        {
            uint consoleSession = WTSGetActiveConsoleSessionId();
            int mySession = System.Diagnostics.Process.GetCurrentProcess().SessionId;
            if (consoleSession == 0xFFFFFFFF || (int)consoleSession != mySession)
            {
                _log.Info("Tray: bỏ qua lượt chụp — phiên này không phải phiên console đang active.");
                return;
            }
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException)
        {
            _log.Warning("Tray: không gọi được WTSGetActiveConsoleSessionId, bỏ qua lượt chụp: " + ex.Message);
            return;
        }

        Rectangle virtualScreen = System.Windows.Forms.SystemInformation.VirtualScreen;
        if (virtualScreen.Width <= 0 || virtualScreen.Height <= 0)
        {
            return;
        }

        byte[] jpegBytes;
        int width;
        int height;
        try
        {
            using var full = new Bitmap(virtualScreen.Width, virtualScreen.Height);
            using (Graphics graphics = Graphics.FromImage(full))
            {
                // Secure desktop (UAC/Ctrl+Alt+Del) làm lần gọi này ném
                // lỗi hoặc ra ảnh đen: lỗi thì catch ở dưới bỏ qua lượt.
                graphics.CopyFromScreen(virtualScreen.Left, virtualScreen.Top, 0, 0, full.Size);
            }

            double scale = full.Width > MaxWidth ? (double)MaxWidth / full.Width : 1.0;
            width = Math.Max(1, (int)Math.Round(full.Width * scale));
            height = Math.Max(1, (int)Math.Round(full.Height * scale));

            using var resized = new Bitmap(width, height);
            using (Graphics graphics = Graphics.FromImage(resized))
            {
                graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                graphics.DrawImage(full, 0, 0, width, height);
            }

            using var stream = new MemoryStream();
            SaveJpeg(resized, stream);
            jpegBytes = stream.ToArray();
        }
        catch (Exception ex)
        {
            // CopyFromScreen lỗi (secure desktop) hoặc GDI lỗi: log nhẹ,
            // bỏ qua lượt — không bao giờ để lỗi chụp làm phiền UI con.
            _log.Warning("Tray: chụp màn hình thất bại (có thể đang ở secure desktop), bỏ qua lượt: " + ex.Message);
            return;
        }

        try
        {
            Directory.CreateDirectory(_queueDirectory);
            DateTimeOffset capturedAt = DateTimeOffset.UtcNow;
            string stem = capturedAt.UtcDateTime.ToString("yyyyMMddHHmmssfff") + "-" + Guid.NewGuid().ToString("N")[..8];
            string jpgPath = Path.Combine(_queueDirectory, stem + ".jpg");
            string jsonPath = Path.Combine(_queueDirectory, stem + ".json");

            // Ghi ảnh TRƯỚC, metadata SAU: Service chỉ xử lý cặp có .json
            // nên .json hiện diện nghĩa là ảnh đã ghi xong. Metadata ghi
            // qua file tạm + ĐỔI TÊN (nguyên tử trong cùng thư mục):
            // Service không bao giờ đọc phải .json đang ghi dở (nửa
            // chừng) rồi kết luận cặp hỏng mà xóa — đổi tên xong là file
            // hoàn chỉnh xuất hiện một lần.
            File.WriteAllBytes(jpgPath, jpegBytes);
            var meta = new ScreenshotQueueMetadata
            {
                WindowsSid = _sid,
                CapturedAt = capturedAt,
                Width = width,
                Height = height,
            };
            string tempJsonPath = jsonPath + ".tmp";
            File.WriteAllText(tempJsonPath, JsonSerializer.Serialize(meta));
            File.Move(tempJsonPath, jsonPath);
            _log.Info("Tray: đã chụp màn hình vào hàng đợi (" + jpegBytes.Length + " byte).");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.Error("Tray: ghi ảnh chụp vào hàng đợi lỗi.", ex);
        }
    }

    /// <summary>Lưu bitmap thành JPEG chất lượng 72 qua encoder GDI+ (thuần .NET, không thêm dependency — docs/11 mục 1.4).</summary>
    private static void SaveJpeg(Bitmap bitmap, Stream stream)
    {
        ImageCodecInfo? jpegCodec = null;
        foreach (ImageCodecInfo codec in ImageCodecInfo.GetImageEncoders())
        {
            if (codec.FormatID == ImageFormat.Jpeg.Guid)
            {
                jpegCodec = codec;
                break;
            }
        }

        if (jpegCodec is null)
        {
            bitmap.Save(stream, ImageFormat.Jpeg);
            return;
        }

        using var parameters = new EncoderParameters(1);
        parameters.Param[0] = new EncoderParameter(Encoder.Quality, JpegQuality);
        bitmap.Save(stream, jpegCodec, parameters);
    }

    [DllImport("wtsapi32.dll")]
    private static extern uint WTSGetActiveConsoleSessionId();

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        SystemEvents.SessionSwitch -= OnSessionSwitch;
        _timer.Dispose();
    }
}
