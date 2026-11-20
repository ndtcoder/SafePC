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
/// <see cref="CommandCreatedAt"/> là <c>created_at</c> của lệnh đã tạo ra
/// ghi đè này (giờ server Postgres, cột <c>command_created_at</c>): mốc để
/// bỏ qua lệnh ghi đè cũ gửi lại sau (ack rớt) khi đã có lệnh mới hơn.
/// Null với hàng do bản Agent cũ ghi (chưa có cột) — coi như không có mốc.
/// <c>ChildId</c> (Sprint 5, cột <c>child_id</c>): hồ sơ con mà ghi đè này
/// thuộc về — null là hàng cũ, thuộc về con mặc định của máy. Mỗi con có
/// MỘT ghi đè hiệu lực riêng (một hàng theo con trong bảng
/// <c>active_override</c>): ghi đè của con đang active mới được tính; ghi đè
/// của con khác không được tính cho con đang ngồi máy, và ghi đè mới của con
/// này không xóa ghi đè của con khác.
/// </summary>
public sealed record TemporaryOverride(string Action, int Minutes, DateTimeOffset ExpiresAt, IReadOnlyList<string>? Domains = null, IReadOnlyList<string>? Apps = null, DateTimeOffset? CommandCreatedAt = null, Guid? ChildId = null);

/// <summary>
/// Thứ tự lệnh ghi đè theo giờ server — logic thuần, không chạm DB, để
/// kiểm tra được bằng harness.
///
/// Bối cảnh: lệnh <c>temporary_override</c> là một lần (pending -&gt; done),
/// nhưng ack của một lệnh có thể rớt (lỗi mạng sau khi thi hành, Service
/// chết giữa chừng) nên lệnh cũ vẫn còn <c>pending</c> và được poll trả lại
/// ở chu kỳ sau — SAU KHI một lệnh mới hơn đã được áp và ack xong. Không có
/// mốc so sánh, lệnh cũ sẽ ghi đè trạng thái mới hơn (kể cả tổng ngân hàng
/// giờ mới hơn). Mốc là <c>created_at</c> do Postgres sinh
/// (<c>default now()</c>, không bên nào tự đặt), nên phép so sánh chỉ dùng
/// giờ server và không bị ảnh hưởng nếu đồng hồ máy con bị chỉnh.
/// </summary>
public static class OverrideCommandOrder
{
    /// <summary>
    /// Mốc sàn hiệu lực: giá trị mới hơn trong hai nguồn (hàng ghi đè đang
    /// hiệu lực và watermark bền vững trong <c>device_state</c>). Null khi
    /// cả hai đều vắng — chưa từng có lệnh ghi đè nào được áp.
    /// </summary>
    public static DateTimeOffset? Floor(DateTimeOffset? rowCommandCreatedAt, DateTimeOffset? watermark)
    {
        if (rowCommandCreatedAt is null)
        {
            return watermark;
        }

        if (watermark is null)
        {
            return rowCommandCreatedAt;
        }

        return rowCommandCreatedAt.Value > watermark.Value ? rowCommandCreatedAt.Value : watermark.Value;
    }

    /// <summary>
    /// Lệnh này có cũ hơn mốc sàn không. Chỉ cũ hơn THẬT SỰ mới bị bỏ qua:
    /// bằng mốc thì vẫn áp — hai lệnh không phân biệt được thứ tự bằng
    /// mốc (cùng một lệnh gửi lại thì áp lại đúng trạng thái cũ, vô hại;
    /// hai lệnh khác nhau cùng mốc gần như không xảy ra vì mỗi lệnh là
    /// một transaction riêng với độ phân giải micro-giây, và áp thì giữ
    /// đúng ngữ nghĩa "lệnh xử lý sau thắng" trong cùng một đợt poll).
    /// </summary>
    public static bool IsStale(DateTimeOffset commandCreatedAt, DateTimeOffset? floor)
    {
        return floor is not null && commandCreatedAt < floor.Value;
    }

    /// <summary>
    /// Watermark mới sau khi áp một lệnh: chỉ nâng lên, không bao giờ hạ
    /// xuống (lệnh cũ hơn mốc hiện tại không được kéo mốc về quá khứ).
    /// </summary>
    public static DateTimeOffset RaiseFloor(DateTimeOffset? currentFloor, DateTimeOffset commandCreatedAt)
    {
        if (currentFloor is null || commandCreatedAt > currentFloor.Value)
        {
            return commandCreatedAt;
        }

        return currentFloor.Value;
    }
}
