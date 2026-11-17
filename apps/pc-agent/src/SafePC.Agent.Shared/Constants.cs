using System.Reflection;

namespace SafePC.Agent.Shared;

/// <summary>
/// Các hằng số dùng chung cho toàn bộ Agent.
/// Khớp docs/02-ARCHITECTURE.md: heartbeat 60s, poll commands 15s, batch usage 5 phút.
/// </summary>
public static class AgentConstants
{
    /// <summary>
    /// Phiên bản Agent, gửi kèm heartbeat và ghi vào bảng devices (cột agent_version).
    /// Lấy từ AssemblyInformationalVersion của file .exe đang chạy — CI đóng dấu
    /// version 0.1.&lt;số run&gt; khi publish (vd: bản #111 là 0.1.111), nên log,
    /// Dashboard và tooltip tray luôn cho biết đúng bản đang chạy. Build tại chỗ
    /// không qua CI thì rơi về "0.1.0-dev".
    /// </summary>
    public static string AgentVersion { get; } = ResolveAgentVersion();

    private static string ResolveAgentVersion()
    {
        try
        {
            System.Reflection.Assembly? entry = System.Reflection.Assembly.GetEntryAssembly();
            string? informational = entry?.GetCustomAttribute<System.Reflection.AssemblyInformationalVersionAttribute>()?.InformationalVersion;
            if (!string.IsNullOrWhiteSpace(informational))
            {
                // InformationalVersion có thể kèm hậu tố "+commit" — chỉ lấy phần trước '+'.
                int plus = informational.IndexOf('+');
                return plus >= 0 ? informational.Substring(0, plus) : informational;
            }

            string? fileVersion = entry?.GetCustomAttribute<System.Reflection.AssemblyFileVersionAttribute>()?.Version;
            if (!string.IsNullOrWhiteSpace(fileVersion))
            {
                return fileVersion;
            }
        }
        catch
        {
            // Đọc version thất bại thì dùng giá trị dự phòng, không được làm hỏng khởi động.
        }

        return "0.1.0-dev";
    }

    /// <summary>Chu kỳ gửi heartbeat lên server (60 giây).</summary>
    public static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(60);

    /// <summary>Chu kỳ poll lệnh từ bảng commands (15 giây).</summary>
    public static readonly TimeSpan CommandPollInterval = TimeSpan.FromSeconds(15);

    /// <summary>Chu kỳ gửi batch usage từ hàng đợi offline (5 phút).</summary>
    public static readonly TimeSpan UsageBatchInterval = TimeSpan.FromMinutes(5);

    /// <summary>Chu kỳ lấy mẫu app foreground (15 giây). Mẫu được Tray App thu thập
    /// vì Service chạy ở session 0 không nhìn thấy cửa sổ của user session.</summary>
    public static readonly TimeSpan ForegroundSampleInterval = TimeSpan.FromSeconds(15);

    /// <summary>Tên Named Pipe cho IPC giữa Service (server) và Tray App (client).</summary>
    public const string IpcPipeName = "SafePCAgentPipe";

    /// <summary>Kích thước tối đa của một file log local trước khi xoay vòng (10MB, theo docs/03).</summary>
    public const long MaxLogFileBytes = 10L * 1024 * 1024;

    /// <summary>Số file log cũ giữ lại khi xoay vòng.</summary>
    public const int MaxLogBackupFiles = 3;

    /// <summary>Số bản ghi tối đa lấy từ outbox trong một lần flush.</summary>
    public const int OutboxBatchSize = 100;

    /// <summary>Tên Windows Service (dùng khi đăng ký bằng sc.exe trong installer).</summary>
    public const string ServiceName = "SafePCAgent";

    /// <summary>Ngưỡng cảnh báo trước khi hết giờ: còn 15/5/1 phút (docs/01-PRD.md mục 2.3).</summary>
    public static readonly int[] WarningThresholdMinutes = { 15, 5, 1 };
}

/// <summary>Các khóa trạng thái bền vững của Service trong bảng SQLite device_state.</summary>
public static class StateKeys
{
    /// <summary>Khóa cưỡng chế của phụ huynh (lệnh lock_now): tồn tại tới khi có lệnh unlock.</summary>
    public const string ForcedLock = "forced_lock";

    /// <summary>Watermark đẩy usage: thời điểm mẫu mới nhất đã gửi lên server.</summary>
    public const string UsagePushedUntil = "usage_pushed_until";

    /// <summary>Giờ nghỉ bắt buộc: thời điểm kết thúc giờ nghỉ (ISO-8601 UTC), tồn tại tới khi hết giờ nghỉ.</summary>
    public const string BreakEndsAt = "break_ends_at";

    /// <summary>Sàn streak nghỉ bắt buộc: chỉ mẫu sau thời điểm này mới tính vào chuỗi dùng liên tục (đặt bằng thời điểm kết thúc giờ nghỉ vừa hết, để mẫu trong giờ nghỉ không gây nghỉ lại ngay).</summary>
    public const string BreakStreakFloor = "break_streak_floor";

    /// <summary>Lần cuối đã gửi sự kiện can thiệp clock_drift lên server (ISO-8601 UTC), để chống spam tối đa 1 lần/giờ.</summary>
    public const string TamperClockDriftLastSent = "tamper_clock_drift_last_sent";

    /// <summary>Lần cuối đã gửi sự kiện can thiệp agent_restart lên server (ISO-8601 UTC), để chống spam tối đa 1 lần/giờ.</summary>
    public const string TamperRestartLastSent = "tamper_restart_last_sent";

    /// <summary>Lần cuối đã báo heartbeat của extension lên server (ISO-8601 UTC), để chống spam tối đa 1 lần/5 phút.</summary>
    public const string ExtensionHeartbeatLastReported = "extension_heartbeat_last_reported";

    /// <summary>Số lần nhập sai mã PIN thoát liên tiếp (đặt lại 0 khi nhập đúng). Lưu bền vững để khởi động lại Tray không xóa được số lần sai.</summary>
    public const string PinFailCount = "pin_fail_count";

    /// <summary>Thời điểm hết khóa nhập PIN (ISO-8601 UTC) sau khi sai quá số lần cho phép. Vắng mặt = không bị khóa.</summary>
    public const string PinLockoutUntil = "pin_lockout_until";
}
