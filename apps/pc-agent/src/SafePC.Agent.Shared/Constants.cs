namespace SafePC.Agent.Shared;

/// <summary>
/// Các hằng số dùng chung cho toàn bộ Agent.
/// Khớp docs/02-ARCHITECTURE.md: heartbeat 60s, poll commands 15s, batch usage 5 phút.
/// </summary>
public static class AgentConstants
{
    /// <summary>Phiên bản Agent, gửi kèm heartbeat và ghi vào bảng devices (cột agent_version).</summary>
    public const string AgentVersion = "0.1.0";

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
