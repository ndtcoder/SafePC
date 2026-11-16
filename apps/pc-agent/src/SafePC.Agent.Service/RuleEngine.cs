using System.Globalization;
using System.Text.Json;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>Kết quả đánh giá rules: cho phép, cảnh báo, hay khóa.</summary>
public enum RuleDecisionKind
{
    Allowed,
    Warn,
    Lock,
}

/// <summary>Kết quả đánh giá rules tại một thời điểm.</summary>
public sealed record RuleDecision(RuleDecisionKind Kind, string Reason, int MinutesLeft);

/// <summary>
/// Đánh giá rules từ cache local (thuần logic, không I/O — dễ kiểm thử).
/// Thứ tự ưu tiên: khóa cưỡng chế của phụ huynh (lệnh lock_now, tồn tại tới
/// khi có lệnh unlock) trước, rồi ghi đè tạm thời (khóa/mở), rồi bedtime,
/// rồi khung giờ được dùng, rồi giới hạn ngày. Trong các quyết định cảnh
/// báo, ngưỡng gần nhất (ít phút còn lại nhất) thắng.
///
/// Mọi giờ giấc đều theo GIỜ ĐỊA PHƯƠNG của máy con. Quy ước thứ: số 0-6
/// khớp <see cref="DayOfWeek"/> của C# và <c>Date.getDay()</c> của JS
/// (0 = Chủ nhật, 6 = Thứ 7) — xem packages/shared-types.
///
/// Định dạng config (JSONB, khớp cột rules.config):
/// - daily_limit: {"minutesByWeekday": {"1": 120, "6": 180}} — ngày vắng mặt
///   = không giới hạn. Vẫn chấp nhận {"minutes_per_day": 120} và
///   {"daily_minutes": 120} (mọi ngày) cho rule đã lưu trước Sprint 2.
/// - bedtime: {"bedtimeByWeekday": {"1": {"start": "21:00", "end": "07:00"}}}
///   — ngày vắng mặt = không khóa. Khoảng qua đêm (end &lt;= start) khóa từ
///   start hôm nay tới end hôm sau. Vẫn chấp nhận {"start","end"} (mọi ngày).
/// - time_window: {"windowsByWeekday": {"1": [{"start": "07:00", "end": "21:00"}]}}
///   — ngoài mọi khung giờ của hôm nay thì khóa; ngày vắng mặt hoặc mảng
///   rỗng = không được dùng máy ngày đó. Nhiều rule thì hợp (union) các
///   khung giờ lại. Chỉ khoảng start &lt; end mới có hiệu lực.
///
/// TODO Sprint 2 (đợt 3): rule theo app (chặn/giới hạn từng app, dùng
/// foregroundAppName). Rule website được xử lý riêng: DomainRulesPublisher
/// xuất bản chúng ra file domain_rules.json cho extension trình duyệt, và
/// RuleEngine bỏ qua chúng ở đây (kể cả ghi đè domain — xem chốt chặn trong
/// <see cref="Evaluate"/>).
/// </summary>
public sealed class RuleEngine
{
    public RuleDecision Evaluate(
        IReadOnlyList<Rule> rules,
        TimeSpan usedToday,
        DateTimeOffset now,
        string? foregroundAppName,
        TemporaryOverride? activeOverride,
        bool forcedLock)
    {
        ArgumentNullException.ThrowIfNull(rules);

        // Khóa cưỡng chế của phụ huynh (lệnh lock_now) có độ ưu tiên cao
        // nhất, tồn tại tới khi có lệnh unlock — kể cả sau khởi động lại.
        if (forcedLock)
        {
            return new RuleDecision(RuleDecisionKind.Lock, "Phụ huynh đã khóa máy.", 0);
        }

        int bonusMinutes = 0;
        // CHỐT CHẶN AN TOÀN (Sprint 2 đợt 2): ghi đè domain (allow_domain /
        // block_domain) CHỈ ảnh hưởng file domain_rules.json do
        // DomainRulesPublisher xuất bản — RuleEngine phải bỏ qua hoàn toàn,
        // không bao giờ được hiểu là mở/khóa máy. Khối dưới đây không có
        // nhánh default nào coi action lạ là unlock: action không khớp
        // Lock/Unlock/BonusMinutes thì rơi xuống đánh giá rules bình thường.
        // Điều kiện phủ định tường minh dưới đây là lớp bảo vệ thứ hai, để
        // một sửa đổi sau này không vô tình biến ghi đè domain thành unlock.
        if (activeOverride is not null && activeOverride.ExpiresAt > now
            && activeOverride.Action != OverrideActions.AllowDomain
            && activeOverride.Action != OverrideActions.BlockDomain)
        {
            if (activeOverride.Action == OverrideActions.Lock)
            {
                return new RuleDecision(RuleDecisionKind.Lock, "Phụ huynh đã khóa máy tạm thời.", 0);
            }

            if (activeOverride.Action == OverrideActions.Unlock)
            {
                return new RuleDecision(RuleDecisionKind.Allowed, string.Empty, int.MaxValue);
            }

            if (activeOverride.Action == OverrideActions.BonusMinutes)
            {
                bonusMinutes = activeOverride.Minutes;
            }
        }

        DateTime local = now.LocalDateTime;

        foreach (Rule rule in rules)
        {
            if (!rule.Enabled || rule.Type != RuleTypes.Bedtime)
            {
                continue;
            }

            if (IsInBedtime(rule, local))
            {
                return new RuleDecision(RuleDecisionKind.Lock, "Đã đến giờ ngủ.", 0);
            }
        }

        RuleDecision? warn = null;

        RuleDecision? windowDecision = CheckTimeWindows(rules, local);
        if (windowDecision is { Kind: RuleDecisionKind.Lock })
        {
            return windowDecision;
        }

        if (windowDecision is not null)
        {
            warn = windowDecision;
        }

        RuleDecision? limitDecision = CheckDailyLimit(rules, usedToday, local, bonusMinutes);
        if (limitDecision is { Kind: RuleDecisionKind.Lock })
        {
            return limitDecision;
        }

        if (limitDecision is not null && (warn is null || limitDecision.MinutesLeft < warn.MinutesLeft))
        {
            warn = limitDecision;
        }

        if (warn is not null)
        {
            return warn;
        }

        // TODO Sprint 2: dùng foregroundAppName để đánh giá rule loại "app".
        // Rule loại "website" không đánh giá ở đây: chúng được xuất bản cho
        // extension trình duyệt qua DomainRulesPublisher (Sprint 2 đợt 2).
        _ = foregroundAppName;
        return new RuleDecision(RuleDecisionKind.Allowed, string.Empty, int.MaxValue);
    }

    /// <summary>
    /// Có đang trong giờ ngủ không? Kiểm tra khung của hôm nay và đuôi qua
    /// đêm của khung hôm qua (bedtime bắt đầu 21:00 hôm qua khóa tới 07:00
    /// hôm nay). Hình dạng cũ {"start","end"} được hiểu là cùng một khung
    /// cho mọi ngày.
    /// </summary>
    private static bool IsInBedtime(Rule rule, DateTime local)
    {
        TimeOnly current = TimeOnly.FromDateTime(local);
        int weekday = (int)local.DayOfWeek;

        if (TryGetObject(rule.Config, "bedtimeByWeekday", out JsonElement byWeekday))
        {
            if (TryGetTimeRange(byWeekday, weekday.ToString(), out TimeOnly start, out TimeOnly end)
                && IsInBedtimeToday(current, start, end))
            {
                return true;
            }

            int yesterday = (weekday + 6) % 7;
            if (TryGetTimeRange(byWeekday, yesterday.ToString(), out TimeOnly yesterdayStart, out TimeOnly yesterdayEnd)
                && yesterdayEnd <= yesterdayStart
                && current < yesterdayEnd)
            {
                return true;
            }

            return false;
        }

        if (TryGetTime(rule.Config, "start", out TimeOnly legacyStart)
            && TryGetTime(rule.Config, "end", out TimeOnly legacyEnd))
        {
            if (IsInBedtimeToday(current, legacyStart, legacyEnd))
            {
                return true;
            }

            return legacyEnd <= legacyStart && current < legacyEnd;
        }

        return false;
    }

    /// <summary>
    /// Phần khung giờ ngủ thuộc về "hôm nay": khung trong ngày là [start, end);
    /// khung qua đêm chỉ tính phần tối nay [start, 24:00) — phần sáng mai do
    /// nhánh "đuôi hôm qua" xử lý khi sang ngày mới.
    /// </summary>
    private static bool IsInBedtimeToday(TimeOnly current, TimeOnly start, TimeOnly end)
    {
        return start <= end
            ? current >= start && current < end
            : current >= start;
    }

    /// <summary>
    /// Đánh giá các rule khung giờ được dùng (hợp union): ngoài mọi khung giờ
    /// của hôm nay thì khóa; trong khung giờ mà sắp hết (còn &lt;= 15 phút)
    /// thì cảnh báo. Không có rule time_window nào đang bật thì không quyết
    /// định gì (trả về null). Ngày không có khung giờ nào = không được dùng.
    /// </summary>
    private static RuleDecision? CheckTimeWindows(IReadOnlyList<Rule> rules, DateTime local)
    {
        bool hasEnabledRule = false;
        int? minutesUntilWindowEnd = null;
        TimeOnly current = TimeOnly.FromDateTime(local);
        string weekdayKey = ((int)local.DayOfWeek).ToString();

        foreach (Rule rule in rules)
        {
            if (!rule.Enabled || rule.Type != RuleTypes.TimeWindow)
            {
                continue;
            }

            hasEnabledRule = true;

            if (!TryGetObject(rule.Config, "windowsByWeekday", out JsonElement byWeekday)
                || !byWeekday.TryGetProperty(weekdayKey, out JsonElement dayRanges)
                || dayRanges.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            foreach (JsonElement range in dayRanges.EnumerateArray())
            {
                if (!TryGetTime(range, "start", out TimeOnly start)
                    || !TryGetTime(range, "end", out TimeOnly end)
                    || start >= end)
                {
                    // Khoảng không hợp lệ (thiếu giờ hoặc qua đêm) thì bỏ qua:
                    // khung giờ qua đêm thuộc về rule bedtime, không phải đây.
                    continue;
                }

                if (current >= start && current < end)
                {
                    int remaining = (int)(end - current).TotalMinutes;
                    minutesUntilWindowEnd = minutesUntilWindowEnd is null
                        ? remaining
                        : Math.Max(minutesUntilWindowEnd.Value, remaining);
                }
            }
        }

        if (!hasEnabledRule)
        {
            return null;
        }

        if (minutesUntilWindowEnd is null)
        {
            return new RuleDecision(RuleDecisionKind.Lock, "Ngoài khung giờ được dùng máy.", 0);
        }

        if (minutesUntilWindowEnd.Value <= 15)
        {
            return new RuleDecision(RuleDecisionKind.Warn, "Sắp hết khung giờ được dùng máy.", minutesUntilWindowEnd.Value);
        }

        return null;
    }

    /// <summary>
    /// Đánh giá giới hạn ngày: lấy giới hạn chặt nhất (nhỏ nhất) trong các
    /// rule daily_limit đang bật, cộng thêm phút bonus nếu có. Ngày không có
    /// giới hạn (vắng mặt trong minutesByWeekday) thì rule đó không áp.
    /// </summary>
    private static RuleDecision? CheckDailyLimit(
        IReadOnlyList<Rule> rules,
        TimeSpan usedToday,
        DateTime local,
        int bonusMinutes)
    {
        int? effectiveLimit = null;
        int weekday = (int)local.DayOfWeek;

        foreach (Rule rule in rules)
        {
            if (!rule.Enabled || rule.Type != RuleTypes.DailyLimit)
            {
                continue;
            }

            int? limit = GetDailyLimitMinutes(rule, weekday);
            if (limit is not null)
            {
                effectiveLimit = effectiveLimit is null
                    ? limit.Value
                    : Math.Min(effectiveLimit.Value, limit.Value);
            }
        }

        if (effectiveLimit is null)
        {
            return null;
        }

        int minutesLeft = effectiveLimit.Value + bonusMinutes - (int)usedToday.TotalMinutes;
        if (minutesLeft <= 0)
        {
            return new RuleDecision(RuleDecisionKind.Lock, "Đã hết thời gian dùng máy hôm nay.", 0);
        }

        if (minutesLeft <= 15)
        {
            return new RuleDecision(RuleDecisionKind.Warn, "Sắp hết thời gian dùng máy.", minutesLeft);
        }

        return null;
    }

    /// <summary>
    /// Giới hạn phút của một rule daily_limit cho một thứ. Trả về null khi
    /// rule không áp giới hạn cho ngày đó (ngày vắng mặt trong
    /// minutesByWeekday, hoặc config không đọc được).
    /// </summary>
    private static int? GetDailyLimitMinutes(Rule rule, int weekday)
    {
        if (TryGetObject(rule.Config, "minutesByWeekday", out JsonElement byWeekday))
        {
            // Ngày vắng mặt = không giới hạn, KHÔNG fallback sang key cũ:
            // rule có minutesByWeekday là rule kiểu mới.
            if (byWeekday.TryGetProperty(weekday.ToString(), out JsonElement element)
                && element.ValueKind == JsonValueKind.Number
                && element.TryGetInt32(out int minutes))
            {
                return minutes;
            }

            return null;
        }

        // Hình dạng cũ: một giới hạn cho mọi ngày.
        if (TryGetInt32(rule.Config, "minutes_per_day", out int perDay))
        {
            return perDay;
        }

        if (TryGetInt32(rule.Config, "daily_minutes", out int daily))
        {
            return daily;
        }

        return null;
    }

    private static bool TryGetObject(JsonElement config, string property, out JsonElement value)
    {
        value = default;
        return config.ValueKind == JsonValueKind.Object
            && config.TryGetProperty(property, out value)
            && value.ValueKind == JsonValueKind.Object;
    }

    private static bool TryGetTimeRange(JsonElement parent, string property, out TimeOnly start, out TimeOnly end)
    {
        start = default;
        end = default;
        return parent.ValueKind == JsonValueKind.Object
            && parent.TryGetProperty(property, out JsonElement range)
            && range.ValueKind == JsonValueKind.Object
            && TryGetTime(range, "start", out start)
            && TryGetTime(range, "end", out end);
    }

    private static bool TryGetTime(JsonElement obj, string property, out TimeOnly value)
    {
        value = default;
        return obj.ValueKind == JsonValueKind.Object
            && obj.TryGetProperty(property, out JsonElement element)
            && element.ValueKind == JsonValueKind.String
            && element.GetString() is string text
            && TimeOnly.TryParseExact(text, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out value);
    }

    private static bool TryGetInt32(JsonElement config, string property, out int value)
    {
        value = 0;
        return config.ValueKind == JsonValueKind.Object
            && config.TryGetProperty(property, out JsonElement element)
            && element.ValueKind == JsonValueKind.Number
            && element.TryGetInt32(out value);
    }
}
