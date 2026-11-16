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
/// </summary>
public sealed record TemporaryOverride(string Action, int Minutes, DateTimeOffset ExpiresAt);
