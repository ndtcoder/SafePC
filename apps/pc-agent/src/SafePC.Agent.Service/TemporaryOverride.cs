namespace SafePC.Agent.Service;

/// <summary>Các giá trị của trường <c>action</c> trong payload lệnh <c>temporary_override</c>.</summary>
public static class OverrideActions
{
    /// <summary>Cộng thêm <c>minutes</c> vào hạn mức giờ hôm nay.</summary>
    public const string BonusMinutes = "bonus_minutes";

    /// <summary>Khóa máy tới <c>expires_at</c>.</summary>
    public const string Lock = "lock";

    /// <summary>Tạm ngưng các quy tắc giờ giấc tới <c>expires_at</c>.</summary>
    public const string Unlock = "unlock";

    /// <summary>Hủy ghi đè đang hiệu lực (không cần minutes/expires_at).</summary>
    public const string Cancel = "cancel";

    /// <summary>
    /// Cho phép tạm thời các domain trong <c>domains</c> tới <c>expires_at</c>
    /// (chỉ ảnh hưởng file domain_rules.json, không mở/khóa máy).
    /// </summary>
    public const string AllowDomain = "allow_domain";

    /// <summary>
    /// Chặn tạm thời các domain trong <c>domains</c> tới <c>expires_at</c>
    /// (chỉ ảnh hưởng file domain_rules.json, không mở/khóa máy).
    /// </summary>
    public const string BlockDomain = "block_domain";

    /// <summary>
    /// Chặn tạm thời các app trong <c>apps</c> tới <c>expires_at</c> (đóng
    /// app foreground khớp danh sách, qua <c>KillAppAsync</c> như mọi đường
    /// đóng app khác; không mở/khóa máy).
    /// </summary>
    public const string BlockApp = "block_app";

    /// <summary>
    /// Cho phép tạm thời các app trong <c>apps</c> tới <c>expires_at</c>:
    /// app khớp danh sách được miễn MỌI thi hành theo app (kể cả focus và
    /// allowlist) trong lúc ghi đè còn hạn. Không mở/khóa máy.
    /// </summary>
    public const string AllowApp = "allow_app";
}

/// <summary>
/// Ghi đè tạm thời đang hiệu lực, lưu trong SQLite local (bảng
/// <c>active_override</c> — xem <see cref="OutboxStore"/>).
///
/// Vì lệnh trong bảng <c>commands</c> là một lần (pending -&gt; done) nên sau
/// khi nhận lệnh, Agent phải tự lưu ghi đè xuống local; nếu không, sau khi
/// Service khởi động lại, ghi đè sẽ mất trong khi vẫn còn hạn. <see cref="RuleEngine"/>
/// kiểm tra <see cref="ExpiresAt"/> ở mỗi lần đánh giá nên ghi đè hết hạn thì
/// tự vô hiệu, không cần lệnh hủy riêng.
///
/// <see cref="Domains"/> chỉ có ý nghĩa với ghi đè domain
/// (<c>allow_domain</c>/<c>block_domain</c>): danh sách domain phụ huynh cho
/// phép/chặn tạm thời, lưu kèm trong cột <c>domains_json</c> để Service khởi
/// động lại không làm mất ghi đè domain đang hiệu lực khi xuất bản lại file
/// domain_rules.json. Ghi đè giờ giấc (bonus/lock/unlock) để null.
/// <see cref="Apps"/> tương tự, cho ghi đè app (<c>block_app</c>/
/// <c>allow_app</c>): tên exe thô như Dashboard gửi, lưu trong cột
/// <c>apps_json</c>; chuẩn hóa/so khớp bằng <c>ExeNames</c> lúc thi hành.
/// </summary>
public sealed record TemporaryOverride(string Action, int Minutes, DateTimeOffset ExpiresAt, IReadOnlyList<string>? Domains = null, IReadOnlyList<string>? Apps = null);
