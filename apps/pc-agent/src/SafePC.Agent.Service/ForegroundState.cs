using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>
/// Một báo cáo foreground đã nhận: payload Tray gửi kèm thời điểm Service
/// nhận được (giờ máy này) — độ tươi của báo cáo tính theo thời điểm nhận,
/// không theo đồng hồ của tiến trình gửi.
/// </summary>
public sealed record ForegroundReport(ForegroundChangedPayload Payload, DateTimeOffset ReceivedAt);

/// <summary>
/// Trạng thái foreground mới nhất của từng session (Sprint 2 đợt 3).
/// Tray gửi message <c>foreground-changed</c> khi app foreground đổi (và
/// heartbeat mỗi 60s); <see cref="IpcPipeServer"/> ghi vào đây, AgentWorker
/// đọc để thi hành quy tắc theo app và giờ học tập trung.
///
/// An toàn luồng: mọi truy cập qua một lock. Chỉ giữ báo cáo mới nhất của
/// mỗi session — báo cáo cũ không dùng để kill (fail-open khi không có
/// báo cáo tươi: xem <see cref="TryGetFreshReports"/>).
/// </summary>
public sealed class ForegroundState
{
    private readonly object _gate = new();
    private readonly Dictionary<int, ForegroundReport> _reports = new();

    /// <summary>
    /// Gọi sau mỗi lần ghi nhận báo cáo foreground mới. Nơi đăng ký
    /// (AgentWorker) PHẢI trả về ngay và không bao giờ ném: callback chạy
    /// trên thread xử lý message của handler pipe — chặn hay ném ở đây sẽ
    /// treo/giết vòng đọc của kết nối đó. Lượt thi hành ngay chạy
    /// fire-and-forget trên thread-pool, gộp burst bằng cổng TryEnter.
    /// </summary>
    public event Action<ForegroundReport>? ReportReceived;

    /// <summary>Ghi nhận báo cáo foreground mới nhất của một session (ghi đè báo cáo cũ).</summary>
    public void Report(ForegroundChangedPayload payload)
    {
        ArgumentNullException.ThrowIfNull(payload);

        ForegroundReport report;
        lock (_gate)
        {
            report = new ForegroundReport(payload, DateTimeOffset.UtcNow);
            _reports[payload.SessionId] = report;
        }

        // Ngoài khóa + bọc try/catch: subscriber lỗi không được phá vòng
        // đọc pipe (lưới an toàn cuối — subscriber theo hợp đồng không ném).
        try
        {
            ReportReceived?.Invoke(report);
        }
        catch
        {
            // Bỏ qua: subscriber phải tự bắt lỗi của nó.
        }
    }

    /// <summary>
    /// Trả về các báo cáo còn tươi (nhận được trong <paramref name="maxAge"/>
    /// vừa qua). Báo cáo cũ hơn bị loại — Service không kill dựa trên thông
    /// tin foreground đã cũ.
    /// </summary>
    public IReadOnlyList<ForegroundReport> TryGetFreshReports(TimeSpan maxAge)
    {
        DateTimeOffset cutoff = DateTimeOffset.UtcNow - maxAge;
        var fresh = new List<ForegroundReport>();
        lock (_gate)
        {
            foreach (ForegroundReport report in _reports.Values)
            {
                if (report.ReceivedAt >= cutoff)
                {
                    fresh.Add(report);
                }
            }
        }

        return fresh;
    }
}
