using System.Text.Json;
using System.Text.Json.Serialization;

namespace SafePC.Agent.Shared;

// Các model dùng chung. Tên property JSON (JsonPropertyName) khớp tên cột
// trong migration backend/supabase/migrations/20261116102900_init_safepc.sql.

/// <summary>Khớp bảng <c>devices</c>.</summary>
public sealed class DeviceInfo
{
    [JsonPropertyName("id")]
    public Guid Id { get; set; }

    [JsonPropertyName("family_id")]
    public Guid FamilyId { get; set; }

    [JsonPropertyName("child_id")]
    public Guid? ChildId { get; set; }

    [JsonPropertyName("hostname")]
    public string Hostname { get; set; } = string.Empty;

    [JsonPropertyName("os_version")]
    public string? OsVersion { get; set; }

    [JsonPropertyName("agent_version")]
    public string? AgentVersion { get; set; }

    [JsonPropertyName("last_seen_at")]
    public DateTimeOffset? LastSeenAt { get; set; }

    [JsonPropertyName("status")]
    public string Status { get; set; } = "offline";
}

/// <summary>Các giá trị của cột <c>rules.type</c>.</summary>
public static class RuleTypes
{
    public const string DailyLimit = "daily_limit";
    public const string Bedtime = "bedtime";
    public const string TimeWindow = "time_window";
    public const string App = "app";
    public const string Website = "website";
}

/// <summary>Các giá trị của cột <c>commands.type</c>.</summary>
public static class CommandTypes
{
    public const string LockNow = "lock_now";
    public const string Unlock = "unlock";
    public const string RefreshRules = "refresh_rules";
    public const string Update = "update";
    public const string TemporaryOverride = "temporary_override";
}

/// <summary>Khớp bảng <c>rules</c>. Cột <c>config</c> là JSONB, giữ nguyên dạng JsonElement.</summary>
public sealed class Rule
{
    [JsonPropertyName("id")]
    public Guid Id { get; set; }

    [JsonPropertyName("family_id")]
    public Guid FamilyId { get; set; }

    [JsonPropertyName("child_id")]
    public Guid ChildId { get; set; }

    [JsonPropertyName("type")]
    public string Type { get; set; } = string.Empty;

    [JsonPropertyName("config")]
    public JsonElement Config { get; set; }

    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; } = true;

    [JsonPropertyName("created_at")]
    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>Tên luật phụ huynh đặt (migration 9; các RPC fetch rules
    /// trả thêm từ migration 31). Dùng làm BẢN CHỤP tên luật trong dòng
    /// theo dõi luật không chặn (<see cref="RuleObservationRecord"/>) —
    /// luật bị đổi tên/xóa thì dòng cũ vẫn hiện tên tại thời điểm ghi.
    /// Server cũ (chưa áp migration 31) không trả trường này → null,
    /// phía ghi nhận thay bằng nhãn suy từ mode/type.</summary>
    [JsonPropertyName("name")]
    public string? Name { get; set; }
}

/// <summary>Một dòng GỘP theo dõi khi luật không chặn (migration 31,
/// bảng <c>rule_observations</c>), khớp phần tử của mảng
/// <c>p_observations</c> trong RPC <c>safepc_push_rule_observations</c>.
/// Ngữ nghĩa (PRD §2.15): con dùng app/domain/giờ thuộc diện một luật
/// CẤM nhưng luật không chặn tại thời điểm đó — vì luật đang tắt
/// (context <c>rule_disabled</c>), vì đang được cho phép tạm thời
/// (<c>temp_allowed</c>) hoặc vì không chặn được
/// (<c>unenforceable</c>). Agent gộp phía máy theo (luật, ngày theo
/// giờ tin cậy + múi giờ gia đình, đối tượng, ngữ cảnh) rồi đẩy định
/// kỳ; server cộng dồn tiếp theo cùng khóa. RuleName/RuleMode là BẢN
/// CHỤP tại thời điểm ghi: sửa luật → ghi theo thông số mới, dòng cũ
/// giữ bản chụp cũ; xóa luật → RuleId thành null phía server nhưng
/// dòng vẫn còn tới hạn giữ 90 ngày. KHÔNG phải loại dữ liệu mới:
/// suy ra từ mẫu sử dụng Service vốn đã thu.</summary>
public sealed class RuleObservationRecord
{
    [JsonPropertyName("rule_id")]
    public Guid? RuleId { get; set; }

    [JsonPropertyName("rule_name")]
    public string RuleName { get; set; } = string.Empty;

    [JsonPropertyName("rule_mode")]
    public string RuleMode { get; set; } = string.Empty;

    /// <summary>Đối tượng: tên exe (app), domain (web), hoặc tên app
    /// đang dùng / "Máy tính" (luật giờ).</summary>
    [JsonPropertyName("target")]
    public string Target { get; set; } = string.Empty;

    /// <summary>'rule_disabled' | 'temp_allowed' | 'unenforceable'.</summary>
    [JsonPropertyName("context")]
    public string Context { get; set; } = string.Empty;

    /// <summary>Ngày theo giờ tin cậy quy đổi múi giờ gia đình, dạng yyyy-MM-dd.</summary>
    [JsonPropertyName("day")]
    public string Day { get; set; } = string.Empty;

    [JsonPropertyName("occurrence_count")]
    public int OccurrenceCount { get; set; }

    [JsonPropertyName("total_seconds")]
    public int TotalSeconds { get; set; }

    [JsonPropertyName("first_seen_at")]
    public DateTimeOffset FirstSeenAt { get; set; }

    [JsonPropertyName("last_seen_at")]
    public DateTimeOffset LastSeenAt { get; set; }

    /// <summary>SID tài khoản Windows của mẫu (phân giải con phía
    /// server như các RPC Sprint 5); null = con mặc định của máy.</summary>
    [JsonPropertyName("windows_sid")]
    public string? WindowsSid { get; set; }
}

/// <summary>Khớp bảng <c>commands</c> (lệnh phụ huynh gửi xuống máy con).
/// <c>ChildId</c> (migration 24, Sprint 5): hồ sơ con mà lệnh nhắm tới —
/// null là lệnh cũ (không gắn con), thuộc về con mặc định của máy và giữ
/// nguyên ngữ nghĩa hiện tại. Agent chỉ thi hành lệnh có ChildId khi đúng
/// con đó đang ở phiên console; lệnh cho con chưa active thì giữ pending
/// tới khi con đó lên console.</summary>
public sealed class Command
{
    [JsonPropertyName("id")]
    public Guid Id { get; set; }

    [JsonPropertyName("family_id")]
    public Guid FamilyId { get; set; }

    [JsonPropertyName("device_id")]
    public Guid DeviceId { get; set; }

    [JsonPropertyName("child_id")]
    public Guid? ChildId { get; set; }

    [JsonPropertyName("type")]
    public string Type { get; set; } = string.Empty;

    [JsonPropertyName("payload")]
    public JsonElement Payload { get; set; }

    [JsonPropertyName("status")]
    public string Status { get; set; } = "pending";

    [JsonPropertyName("created_at")]
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// Khớp bảng <c>app_usage</c>.
/// Chỉ lưu tên app + hash đường dẫn exe, KHÔNG lưu đường dẫn thô
/// (đường dẫn có thể lộ username Windows — docs/03-SECURITY.md mục 3).
/// </summary>
public sealed class UsageRecord
{
    [JsonPropertyName("id")]
    public Guid Id { get; set; } = Guid.NewGuid();

    [JsonPropertyName("family_id")]
    public Guid FamilyId { get; set; }

    [JsonPropertyName("device_id")]
    public Guid DeviceId { get; set; }

    [JsonPropertyName("child_id")]
    public Guid ChildId { get; set; }

    [JsonPropertyName("app_name")]
    public string AppName { get; set; } = string.Empty;

    [JsonPropertyName("exe_path_hash")]
    public string? ExePathHash { get; set; }

    /// <summary>
    /// SID của tài khoản Windows đã dùng app này (Sprint 5) — server suy ra
    /// hồ sơ con qua bảng <c>device_child_accounts</c>, không khớp thì ghi
    /// theo con mặc định của máy (migration 24). Null với mẫu cũ (Tray cũ /
    /// mẫu trước Sprint 5): server coi như không rõ phiên, ghi theo con mặc
    /// định. Family_id/device_id/child_id do server suy ra, không gửi kèm.
    /// </summary>
    [JsonPropertyName("windows_sid")]
    public string? WindowsSid { get; set; }

    [JsonPropertyName("started_at")]
    public DateTimeOffset StartedAt { get; set; }

    [JsonPropertyName("duration_sec")]
    public int DurationSec { get; set; }
}

/// <summary>
/// Một lượt thăm web đã tổng hợp theo cặp (domain, đường dẫn), khớp bảng <c>web_visits</c>
/// (migration 1 + cột <c>duration_sec</c> ở migration 4 + cờ <c>blocked</c>
/// ở migration 10 + cột <c>path</c> ở migration 19).
/// Chỉ lưu domain + đường dẫn + thời điểm + thời lượng (giây) + cờ bị
/// chặn — KHÔNG lưu URL đầy đủ, query, fragment hay tiêu đề trang
/// (docs/03-SECURITY.md mục 3). Đường dẫn đã cắt query/fragment, trần
/// 500 ký tự (xem <see cref="WebVisitPath"/>); lượt xem ghi từ bản cũ
/// và lượt bị chặn không có đường dẫn (null). Lượt bị
/// chặn có <see cref="Blocked"/> = true và DurationSec = 0.
/// family_id/device_id/child_id do server suy ra từ device đã xác thực,
/// không gửi kèm.
/// </summary>
public sealed class WebVisitRecord
{
    [JsonPropertyName("domain")]
    public string Domain { get; set; } = string.Empty;

    /// <summary>Đường dẫn đã cắt (bắt đầu bằng '/', tối đa 500 ký tự),
    /// hoặc null khi lượt thăm không mang đường dẫn.</summary>
    [JsonPropertyName("path")]
    public string? Path { get; set; }

    [JsonPropertyName("visited_at")]
    public DateTimeOffset VisitedAt { get; set; }

    [JsonPropertyName("duration_sec")]
    public int DurationSec { get; set; }

    [JsonPropertyName("blocked")]
    public bool Blocked { get; set; }

    /// <summary>
    /// SID của tài khoản Windows đã thăm web (Sprint 5) — server suy ra hồ
    /// sơ con qua bảng <c>device_child_accounts</c>, không khớp thì ghi theo
    /// con mặc định của máy (migration 24). Null với dòng cũ (không có SID):
    /// server coi như không rõ phiên, ghi theo con mặc định.
    /// </summary>
    [JsonPropertyName("windows_sid")]
    public string? WindowsSid { get; set; }
}

/// <summary>
/// Một cụm từ tìm kiếm trên công cụ tìm kiếm, khớp bảng <c>search_terms</c>
/// (migration 28). Đây là kênh dữ liệu DUY NHẤT mang cụm từ tìm kiếm:
/// phụ huynh quyết định ngày 27/11/2026 (kiểu Microsoft Family Safety)
/// rằng riêng cụm từ trên các công cụ tìm kiếm (Google, Bing,
/// DuckDuckGo, Yahoo, Cốc Cốc) được trích ra để chặn theo từ khóa cấm
/// và thống kê vào Báo cáo tuần — mọi URL khác vẫn bỏ query như cũ.
/// <see cref="Engine"/> là id ngắn của công cụ ("google", "coccoc"...),
/// <see cref="Term"/> là cụm từ GỐC đã giải mã, trần 200 ký tự,
/// <see cref="Blocked"/> = lượt tìm bị chặn vì chứa từ khóa cấm.
/// family_id/device_id/child_id do server suy ra từ device đã xác thực
/// (child theo <see cref="WindowsSid"/> qua ánh xạ migration 24,
/// fallback con mặc định của máy), không gửi kèm.
/// </summary>
public sealed class SearchTermRecord
{
    [JsonPropertyName("engine")]
    public string Engine { get; set; } = string.Empty;

    [JsonPropertyName("term")]
    public string Term { get; set; } = string.Empty;

    [JsonPropertyName("blocked")]
    public bool Blocked { get; set; }

    /// <summary>SID của tài khoản Windows đã tìm kiếm (Sprint 5) — như
    /// <see cref="WebVisitRecord.WindowsSid"/>.</summary>
    [JsonPropertyName("windows_sid")]
    public string? WindowsSid { get; set; }
}

/// <summary>
/// Kết quả RPC <c>safepc_mint_chat_session</c> (migration 29): phiên chat
/// của con với phụ huynh. <see cref="Token"/> là token phiên (sống 12 giờ,
/// chỉ mang trong URL trang chat dạng fragment — Service đưa cho đúng Tray
/// đã hỏi qua IPC nội bộ máy; KHÔNG bao giờ ghi log token này).
/// <see cref="ExpiresAt"/> là thời điểm hết hạn server cấp,
/// <see cref="ChildId"/> là hồ sơ con mà phiên thuộc về (server suy ra từ
/// thiết bị + SID của phiên Tray).
/// </summary>
public sealed class ChatSessionMintResult
{
    [JsonPropertyName("token")]
    public string Token { get; set; } = string.Empty;

    [JsonPropertyName("expires_at")]
    public DateTimeOffset ExpiresAt { get; set; }

    [JsonPropertyName("child_id")]
    public Guid ChildId { get; set; }
}

/// <summary>
/// Một hàng ánh xạ thiết bị ↔ hồ sơ con ↔ tài khoản Windows (bảng
/// <c>device_child_accounts</c>, migration 24, Sprint 5): tài khoản Windows
/// có SID này trên máy này là hồ sơ con <c>ChildId</c>. Agent tải danh sách
/// này qua RPC <c>safepc_fetch_device_child_accounts</c> để biết phiên
/// console nào là con nào; Dashboard (đợt sau) ghi hàng khi phụ huynh gắn
/// tài khoản với hồ sơ con.
/// </summary>
public sealed class ChildAccountLink
{
    [JsonPropertyName("child_id")]
    public Guid ChildId { get; set; }

    [JsonPropertyName("windows_sid")]
    public string WindowsSid { get; set; } = string.Empty;

    [JsonPropertyName("windows_username")]
    public string? WindowsUsername { get; set; }
}
