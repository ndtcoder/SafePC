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
/// Một hàng cài đặt chụp màn hình theo hồ sơ con (bảng
/// <c>child_screen_settings</c>, migration 32), trả về bởi RPC
/// <c>safepc_fetch_screen_settings</c> cho MỌI con của máy này. Phụ huynh
/// bật/tắt trên Dashboard; <see cref="Enabled"/> = true là chụp ngay —
/// không có lớp đồng ý nào phía server hay phía con (quyết định anh Tiến
/// 28/11/2026, mô hình sửa 11:16: con chỉ được THÔNG BÁO minh bạch hằng
/// tuần qua Tray). <see cref="IntervalMinutes"/> là nhịp chụp nội bộ —
/// không bao giờ hiển thị phía con. <see cref="RetentionDays"/> là hạn
/// giữ ảnh trên Drive của phụ huynh, Service tự dọn thư mục ngày quá hạn.
/// </summary>
public sealed class ScreenSettingsRecord
{
    [JsonPropertyName("child_id")]
    public Guid ChildId { get; set; }

    [JsonPropertyName("child_name")]
    public string ChildName { get; set; } = string.Empty;

    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; }

    [JsonPropertyName("interval_minutes")]
    public int IntervalMinutes { get; set; }

    [JsonPropertyName("retention_days")]
    public int RetentionDays { get; set; }
}

/// <summary>
/// Một dòng metadata ảnh chụp màn hình đã upload lên Drive của phụ huynh,
/// khớp phần tử của mảng batch (tham số <c>p_items</c>) trong RPC
/// <c>safepc_push_screenshot_meta</c> (migration 32). Ảnh thật nằm trên
/// Drive phụ huynh (file id trong <see cref="DriveFileId"/>); Supabase
/// chỉ giữ danh mục này. Server suy hồ sơ con TỪNG MẪU qua
/// <see cref="WindowsSid"/> (ánh xạ migration 24, fallback con mặc định
/// của máy) như mẫu usage — <see cref="ChildId"/> RPC không đọc, chỉ là
/// giá trị Service đã đối chiếu nội bộ khi tạo record.
/// <see cref="Day"/> là ngày chụp theo giờ tin cậy quy đổi múi giờ gia
/// đình (yyyy-MM-dd) — cũng là tên thư mục ngày trên Drive, để việc dọn
/// theo hạn giữ đối chiếu được hai phía.
/// </summary>
public sealed class ScreenshotMetaRecord
{
    [JsonPropertyName("child_id")]
    public Guid ChildId { get; set; }

    /// <summary>SID tài khoản Windows của phiên đã chụp (từ metadata
    /// hàng đợi screen_queue): RPC dùng trường này để ghi metadata đúng
    /// hồ sơ con trên máy dùng chung. Thiếu SID thì server rơi về con
    /// mặc định của máy.</summary>
    [JsonPropertyName("windows_sid")]
    public string? WindowsSid { get; set; }

    [JsonPropertyName("day")]
    public string Day { get; set; } = string.Empty;

    [JsonPropertyName("captured_at")]
    public DateTimeOffset CapturedAt { get; set; }

    [JsonPropertyName("drive_file_id")]
    public string DriveFileId { get; set; } = string.Empty;

    [JsonPropertyName("size_bytes")]
    public long SizeBytes { get; set; }

    [JsonPropertyName("width")]
    public int Width { get; set; }

    [JsonPropertyName("height")]
    public int Height { get; set; }
}

/// <summary>
/// Kết quả RPC <c>safepc_fetch_drive_token</c> (migration 32): bộ thông
/// tin OAuth Google Drive của phụ huynh (refresh token + client của ứng
/// dụng) để Service đổi access token và upload thẳng lên Drive phụ huynh
/// (scope drive.file). RPC trả null khi phụ huynh chưa kết nối Drive.
/// MỌI trường trong đây đều là secret hoặc đi kèm secret: KHÔNG bao giờ
/// ghi log; Service chỉ lưu refresh token + client vào file DPAPI + ACL
/// SYSTEM/Admins trên máy con (xem DriveTokenStore phía Service).
/// </summary>
public sealed class DriveTokenResult
{
    [JsonPropertyName("refresh_token")]
    public string RefreshToken { get; set; } = string.Empty;

    [JsonPropertyName("google_email")]
    public string? GoogleEmail { get; set; }

    [JsonPropertyName("client_id")]
    public string ClientId { get; set; } = string.Empty;

    [JsonPropertyName("client_secret")]
    public string ClientSecret { get; set; } = string.Empty;
}

/// <summary>
/// Metadata đi kèm mỗi ảnh trong hàng đợi <c>screen_queue</c> (file
/// <c>&lt;tên&gt;.json</c> cạnh <c>&lt;tên&gt;.jpg</c>): Tray ghi khi chụp,
/// Service đọc để đối chiếu SID → hồ sơ con như mẫu web usage (Sprint 5).
/// Chỉ chứa SID của phiên đã chụp + thời điểm + kích thước sau thu nhỏ —
/// không chứa nội dung màn hình hay đường dẫn.
/// </summary>
public sealed class ScreenshotQueueMetadata
{
    [JsonPropertyName("windows_sid")]
    public string? WindowsSid { get; set; }

    [JsonPropertyName("captured_at")]
    public DateTimeOffset CapturedAt { get; set; }

    [JsonPropertyName("width")]
    public int Width { get; set; }

    [JsonPropertyName("height")]
    public int Height { get; set; }

    /// <summary>Drive file id khi ảnh đã upload thành công nhưng đẩy
    /// metadata lên server chưa thành công (Service ghi bổ sung vào file
    /// json sau lần upload): lần thử lại chỉ đẩy metadata, không upload
    /// lại ảnh (tránh trùng ảnh trên Drive). Vắng mặt = chưa upload.</summary>
    [JsonPropertyName("drive_file_id")]
    public string? DriveFileId { get; set; }

    /// <summary>Average-hash (hex) của ảnh, Service tính và ghi bổ sung
    /// cùng lúc với <see cref="DriveFileId"/> sau khi upload thành công.
    /// Hash "ảnh gần nhất" trong device_state CHỈ được cập nhật sau khi
    /// đẩy metadata lên server thành công — file json giữ hash này để
    /// lần thử lại (chỉ đẩy metadata) vẫn còn hash mà ghi đúng thời
    /// điểm đó. Vắng mặt = ảnh không giải mã được để tính hash.</summary>
    [JsonPropertyName("hash")]
    public string? HashHex { get; set; }
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
