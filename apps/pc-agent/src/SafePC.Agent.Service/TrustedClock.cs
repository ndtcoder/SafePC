using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>
/// Giờ tin cậy của Service (PRD §2.14, migration 31): nguồn thời gian
/// DUY NHẤT để thi hành luật theo giờ và đóng dấu ngày sử dụng. Cơ
/// chế: mỗi lần đồng bộ thành công với Supabase (heartbeat), ghi cặp
/// (giờ server UTC, Environment.TickCount64 tại thời điểm đó); từ
/// đó "bây giờ tin cậy" = giờ server + phần TickCount64 đã trôi —
/// đồng hồ treo tường của Windows (giờ hệ thống + múi giờ máy) KHÔNG
/// tham gia, nên con chỉnh giờ hệ thống hay đổi múi giờ Windows đều
/// không lách được luật. Đây là phần mở rộng của cơ chế đối chiếu
/// clock_drift vốn có (trước đây chỉ phát hiện lệch, vẫn thi hành
/// bằng giờ máy).
///
/// Trạng thái "chưa kiểm chứng" (PRD §2.14, giới hạn vật lý đã ghi):
/// sau khởi động lại mà chưa có mạng, Service nạp offset lần đồng bộ
/// cuối đã lưu bền (device_state, khóa TrustedClockOffsetMs) và áp
/// lên đồng hồ máy — <see cref="IsVerified"/> = false cho tới lần
/// đồng bộ mới. Lệch tích lũy của đồng hồ máy trong lúc mất mạng là
/// không tránh được; đồng bộ lại sẽ hiệu chỉnh ngay.
///
/// Múi giờ gia đình: nhận qua heartbeat (families.timezone, mặc định
/// 'Asia/Ho_Chi_Minh'); tra cứu TimeZoneInfo thất bại (id lạ do sửa
/// tay trong DB) → giữ nguyên múi giờ đang dùng và ghi log một lần
/// cho mỗi id xấu, không bao giờ làm sập Service. Trên Windows,
/// TimeZoneInfo chấp nhận cả tên IANA lẫn tên Windows; với riêng
/// 'Asia/Ho_Chi_Minh' khi tra cứu IANA thất bại thì thử tên Windows
/// tương đương 'SE Asia Standard Time' (môi trường .NET thiếu dữ
/// liệu ICU).
///
/// An toàn luồng: mọi trạng thái đọc/ghi qua một khóa; các vòng lặp
/// của AgentWorker (heartbeat, rule-check, flush) gọi đồng thời.
/// </summary>
public sealed class TrustedClock
{
    /// <summary>Múi giờ mặc định khi gia đình chưa đặt / server cũ chưa trả timezone.</summary>
    public const string DefaultTimeZoneId = "Asia/Ho_Chi_Minh";

    private readonly LocalLogger _log;
    private readonly object _gate = new();

    private DateTimeOffset _serverUtcAtSync;
    private long _tickAtSync;
    private bool _synced;
    private TimeSpan _persistedOffset = TimeSpan.Zero;
    private TimeZoneInfo _zone;
    private string _zoneId = DefaultTimeZoneId;
    private string? _lastBadZoneId;

    public TrustedClock(LocalLogger log)
    {
        _log = log;
        _zone = ResolveZone(DefaultTimeZoneId) ?? TimeZoneInfo.Local;
    }

    /// <summary>Đã có ít nhất một lần đồng bộ giờ server thành công trong phiên chạy này.</summary>
    public bool IsVerified
    {
        get { lock (_gate) { return _synced; } }
    }

    /// <summary>Tên múi giờ gia đình đang áp dụng (như đã nhận, kể cả khi phải fallback lúc tra cứu).</summary>
    public string TimeZoneId
    {
        get { lock (_gate) { return _zoneId; } }
    }

    /// <summary>
    /// Ghi mốc đồng bộ mới từ giờ server của heartbeat. Trả về độ
    /// lệch (server − máy) tại thời điểm đồng bộ để AgentWorker lưu
    /// bền cho trạng thái chưa-kiểm-chứng sau khởi động lại.
    /// </summary>
    public TimeSpan UpdateFromServer(DateTimeOffset serverUtc)
    {
        lock (_gate)
        {
            _serverUtcAtSync = serverUtc.ToUniversalTime();
            _tickAtSync = Environment.TickCount64;
            _synced = true;
            return _serverUtcAtSync - DateTimeOffset.UtcNow;
        }
    }

    /// <summary>
    /// Nạp offset lần đồng bộ cuối đã lưu bền (chỉ có tác dụng khi
    /// phiên chạy này chưa đồng bộ lần nào; sau lần đồng bộ đầu tiên
    /// offset bền bị thay bằng mốc monotonic chính xác hơn).
    /// </summary>
    public void SetPersistedOffset(TimeSpan offset)
    {
        lock (_gate)
        {
            _persistedOffset = offset;
        }
    }

    /// <summary>Offset hiện hành (giờ tin cậy − giờ máy) để AgentWorker lưu bền sau mỗi lần đồng bộ.</summary>
    public TimeSpan CurrentOffset
    {
        get { return UtcNow - DateTimeOffset.UtcNow; }
    }

    /// <summary>Thời điểm UTC theo giờ tin cậy.</summary>
    public DateTimeOffset UtcNow
    {
        get
        {
            lock (_gate)
            {
                if (_synced)
                {
                    long elapsedMs = Environment.TickCount64 - _tickAtSync;
                    return _serverUtcAtSync + TimeSpan.FromMilliseconds(elapsedMs);
                }

                return DateTimeOffset.UtcNow + _persistedOffset;
            }
        }
    }

    /// <summary>
    /// Độ lệch của đồng hồ máy so với giờ tin cậy (dương = giờ máy
    /// đang CHẠY TRƯỚC giờ tin cậy). |Drift| &gt; 120 giây là ngưỡng
    /// sự kiện clock_drift (PRD §2.14).
    /// </summary>
    public TimeSpan Drift => DateTimeOffset.UtcNow - UtcNow;

    /// <summary>"Bây giờ" theo giờ tin cậy, đã quy đổi sang múi giờ gia đình (offset trong kết quả là offset của múi giờ đó).</summary>
    public DateTimeOffset FamilyNow => ToFamily(UtcNow);

    /// <summary>Quy đổi một thời điểm bất kỳ sang múi giờ gia đình theo giờ tin cậy.</summary>
    public DateTimeOffset ToFamily(DateTimeOffset instant)
    {
        lock (_gate)
        {
            return TimeZoneInfo.ConvertTime(instant, _zone);
        }
    }

    /// <summary>
    /// Đặt múi giờ gia đình từ heartbeat. null/rỗng → giữ nguyên
    /// (server cũ). Id không tra cứu được → giữ múi giờ đang dùng +
    /// ghi log một lần cho mỗi id xấu.
    /// </summary>
    public void SetTimeZoneId(string? id)
    {
        if (string.IsNullOrWhiteSpace(id))
        {
            return;
        }

        string trimmed = id.Trim();
        lock (_gate)
        {
            if (string.Equals(trimmed, _zoneId, StringComparison.Ordinal))
            {
                return;
            }

            TimeZoneInfo? zone = ResolveZone(trimmed);
            if (zone is null)
            {
                if (!string.Equals(trimmed, _lastBadZoneId, StringComparison.Ordinal))
                {
                    _lastBadZoneId = trimmed;
                    _log.Warning("TrustedClock: không tra cứu được múi giờ gia đình '" + trimmed
                        + "', giữ nguyên múi giờ đang dùng '" + _zoneId + "'.");
                }

                return;
            }

            _zone = zone;
            _zoneId = trimmed;
            _lastBadZoneId = null;
            _log.Info("TrustedClock: múi giờ gia đình = " + trimmed + ".");
        }
    }

    private static TimeZoneInfo? ResolveZone(string id)
    {
        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById(id);
        }
        catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException)
        {
            // Fallback riêng cho múi giờ mặc định: môi trường .NET
            // thiếu dữ liệu IANA có thể vẫn biết tên Windows tương
            // đương. Các id khác không đoán mò — trả null để giữ
            // múi giờ đang dùng.
            if (string.Equals(id, DefaultTimeZoneId, StringComparison.Ordinal))
            {
                try
                {
                    return TimeZoneInfo.FindSystemTimeZoneById("SE Asia Standard Time");
                }
                catch (Exception ex2) when (ex2 is TimeZoneNotFoundException or InvalidTimeZoneException)
                {
                    return null;
                }
            }

            return null;
        }
    }
}
