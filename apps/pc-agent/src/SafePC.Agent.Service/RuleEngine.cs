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
/// Thứ tự ưu tiên: ghi đè mở khóa tạm thời còn hạn thắng cả khóa cưỡng chế,
/// rồi khóa cưỡng chế của phụ huynh (lệnh lock_now, tồn tại tới khi có lệnh
/// unlock), rồi ghi đè khóa tạm thời, rồi bedtime, rồi khung giờ được dùng,
/// rồi giới hạn ngày. Trong các quyết định cảnh báo, ngưỡng gần nhất (ít
/// phút còn lại nhất) thắng.
///
/// Thời gian: tham số <c>now</c> phải là thời điểm ĐÃ biểu diễn theo
/// múi giờ dùng để thi hành — từ đợt giờ tin cậy (PRD §2.14, migration
/// 31) AgentWorker luôn truyền giờ tin cậy quy đổi múi giờ GIA ĐÌNH
/// (TrustedClock.FamilyNow), và engine đọc phần DateTime của nó
/// nguyên trạng (trước đây đọc LocalDateTime của giờ máy — hai cách
/// cho cùng kết quả khi người gọi truyền DateTimeOffset.Now, nên
/// hành vi với người gọi cũ không đổi). Quy ước thứ: số 0-6
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

        // Ghi đè MỞ KHÓA TẠM THỜI thắng cả khóa cưỡng chế trong thời hạn
        // của nó (sửa 17/11/2026): nút "Mở khóa ngay" trên Dashboard gửi
        // temporary_override action unlock — nếu khóa cưỡng chế được kiểm
        // tra trước, nút này không bao giờ có tác dụng khi máy đang bị
        // khóa cưỡng chế (log thật 17/11: ghi đè unlock đã lưu nhưng quyết
        // định vẫn Lock). Hết hạn ghi đè thì khóa cưỡng chế tự có hiệu lực
        // trở lại ở kỳ đánh giá sau; cờ khóa cưỡng chế không bị xóa.
        if (activeOverride is not null && activeOverride.ExpiresAt > now
            && activeOverride.Action == OverrideActions.Unlock)
        {
            return new RuleDecision(RuleDecisionKind.Allowed, string.Empty, int.MaxValue);
        }

        // Khóa cưỡng chế của phụ huynh (lệnh lock_now) có độ ưu tiên cao
        // nhất sau ghi đè mở khóa tạm thời, tồn tại tới khi có lệnh unlock
        // — kể cả sau khởi động lại.
        if (forcedLock)
        {
            return new RuleDecision(RuleDecisionKind.Lock, "Phụ huynh đã khóa máy.", 0);
        }

        int bonusMinutes = 0;
        // CHỐT CHẶN AN TOÀN (Sprint 2 đợt 2, mở rộng cho ghi đè app): ghi đè
        // domain (allow_domain / block_domain) CHỈ ảnh hưởng file
        // domain_rules.json và ghi đè app (block_app / allow_app) CHỈ ảnh
        // hưởng thi hành theo app trong AgentWorker — RuleEngine phải bỏ qua
        // hoàn toàn cả hai nhóm, không bao giờ được hiểu là mở/khóa máy.
        // Khối dưới đây không có nhánh default nào coi action lạ là unlock:
        // action không khớp Lock/Unlock/BonusMinutes thì rơi xuống đánh giá
        // rules bình thường. Điều kiện phủ định tường minh dưới đây là lớp
        // bảo vệ thứ hai, để một sửa đổi sau này không vô tình biến ghi đè
        // domain/app thành unlock.
        if (activeOverride is not null && activeOverride.ExpiresAt > now
            && activeOverride.Action != OverrideActions.AllowDomain
            && activeOverride.Action != OverrideActions.BlockDomain
            && activeOverride.Action != OverrideActions.BlockApp
            && activeOverride.Action != OverrideActions.AllowApp)
        {
            if (activeOverride.Action == OverrideActions.Lock)
            {
                return new RuleDecision(RuleDecisionKind.Lock, "Phụ huynh đã khóa máy tạm thời.", 0);
            }

            // Unlock còn hạn đã return ở khối trên (thắng cả khóa cưỡng chế)
            // nên tới đây không còn nhánh Unlock nào — không thêm lại.

            if (activeOverride.Action == OverrideActions.BonusMinutes)
            {
                bonusMinutes = activeOverride.Minutes;
            }
        }

        DateTime local = now.DateTime;

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
    /// Số phút còn lại cho tới ràng buộc giờ giấc gần nhất — dùng HIỂN THỊ
    /// cho "xem thời gian còn lại" trên Tray, KHÔNG dùng thi hành. Chỉ gọi
    /// khi quyết định thi hành là Allowed: trường hợp Lock/Warn đã có
    /// MinutesLeft đúng của nó (0 hoặc ngưỡng cảnh báo 15 phút), còn
    /// Allowed của <see cref="Evaluate"/> luôn mang <c>int.MaxValue</c> nên
    /// không cho biết còn bao nhiêu phút. Hàm này lấy min của ba ràng buộc:
    /// phút còn lại của giới hạn ngày (giới hạn chặt nhất + phút bonus),
    /// phút tới cuối khung giờ đang dùng, và phút tới lần bắt đầu giờ ngủ
    /// gần nhất. Không có ràng buộc nào thì trả về <c>int.MaxValue</c>
    /// (không giới hạn). Ghi đè mở khóa còn hạn thì quy tắc giờ giấc đang
    /// bị tạm ngưng nên cũng trả về <c>int.MaxValue</c>.
    ///
    /// Thuần logic, không I/O — cùng quy ước giờ địa phương và hình dạng
    /// config như <see cref="Evaluate"/>; các helper đọc config được dùng
    /// chung để hai đường không lệch nhau.
    /// </summary>
    public int GetRemainingMinutes(
        IReadOnlyList<Rule> rules,
        TimeSpan usedToday,
        DateTimeOffset now,
        TemporaryOverride? activeOverride)
    {
        ArgumentNullException.ThrowIfNull(rules);

        if (activeOverride is not null && activeOverride.ExpiresAt > now
            && activeOverride.Action == OverrideActions.Unlock)
        {
            return int.MaxValue;
        }

        int bonusMinutes = activeOverride is not null && activeOverride.ExpiresAt > now
            && activeOverride.Action == OverrideActions.BonusMinutes
            ? activeOverride.Minutes
            : 0;

        DateTime local = now.DateTime;
        int weekday = (int)local.DayOfWeek;
        int? remaining = null;
        void Consider(int minutes)
        {
            remaining = remaining is null ? minutes : Math.Min(remaining.Value, minutes);
        }

        // 1. Giới hạn ngày: giới hạn chặt nhất trong các rule đang bật,
        // cộng phút bonus, trừ thời gian đã dùng (làm tròn xuống như
        // CheckDailyLimit để hai đường khớp nhau).
        int? effectiveLimit = null;
        foreach (Rule rule in rules)
        {
            if (!rule.Enabled || rule.Type != RuleTypes.DailyLimit)
            {
                continue;
            }

            int? limit = GetDailyLimitMinutes(rule, weekday);
            if (limit is not null)
            {
                effectiveLimit = effectiveLimit is null ? limit.Value : Math.Min(effectiveLimit.Value, limit.Value);
            }
        }

        if (effectiveLimit is not null)
        {
            Consider(Math.Max(0, effectiveLimit.Value + bonusMinutes - (int)usedToday.TotalMinutes));
        }

        // 2. Khung giờ: phút tới cuối khung giờ đang chứa "now", lấy khung
        // dài nhất (khớp phép hợp union của CheckTimeWindows). Không trong
        // khung nào mà vẫn Allowed thì chỉ có thể do ghi đè unlock — đã
        // return ở trên — nên không cộng thêm ràng buộc ở đây.
        TimeOnly current = TimeOnly.FromDateTime(local);
        string weekdayKey = weekday.ToString(CultureInfo.InvariantCulture);
        int? minutesUntilWindowEnd = null;
        foreach (Rule rule in rules)
        {
            if (!rule.Enabled || rule.Type != RuleTypes.TimeWindow)
            {
                continue;
            }

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
                    continue;
                }

                if (current >= start && current < end)
                {
                    int untilEnd = (int)(end - current).TotalMinutes;
                    minutesUntilWindowEnd = minutesUntilWindowEnd is null
                        ? untilEnd
                        : Math.Max(minutesUntilWindowEnd.Value, untilEnd);
                }
            }
        }

        if (minutesUntilWindowEnd is not null)
        {
            Consider(minutesUntilWindowEnd.Value);
        }

        // 3. Giờ ngủ: phút tới lần bắt đầu giờ ngủ gần nhất (hôm nay nếu
        // chưa tới giờ, không thì ngày mai). Làm tròn LÊN để không hiển thị
        // "còn 0 phút" khi vẫn còn vài chục giây.
        int? minutesUntilBedtime = MinutesUntilNextBedtime(rules, local);
        if (minutesUntilBedtime is not null)
        {
            Consider(minutesUntilBedtime.Value);
        }

        return remaining ?? int.MaxValue;
    }

    /// <summary>
    /// Phút tới lần bắt đầu giờ ngủ gần nhất trong 24 giờ tới, lấy min qua
    /// mọi rule bedtime đang bật. Trả về null khi không có khung giờ ngủ
    /// nào sắp bắt đầu (không có rule, hoặc mọi khung đều rỗng). Khoảng
    /// rỗng (start == end) không bao giờ khóa nên không tính.
    /// </summary>
    private static int? MinutesUntilNextBedtime(IReadOnlyList<Rule> rules, DateTime local)
    {
        int? nearest = null;
        int weekday = (int)local.DayOfWeek;
        int tomorrow = (weekday + 1) % 7;
        DateTime today = local.Date;

        foreach (Rule rule in rules)
        {
            if (!rule.Enabled || rule.Type != RuleTypes.Bedtime)
            {
                continue;
            }

            foreach ((int day, DateTime date) in new[] { (weekday, today), (tomorrow, today.AddDays(1)) })
            {
                if (!TryGetBedtimeStart(rule, day, out TimeOnly start, out TimeOnly end) || start == end)
                {
                    continue;
                }

                DateTime startMoment = date.Add(start.ToTimeSpan());
                if (startMoment > local)
                {
                    int minutes = (int)Math.Ceiling((startMoment - local).TotalMinutes);
                    nearest = nearest is null ? minutes : Math.Min(nearest.Value, minutes);
                }
            }
        }

        return nearest;
    }

    /// <summary>
    /// Tìm các luật GIỜ trong danh sách truyền vào mà NẾU đang bật thì
    /// tại thời điểm này sẽ khóa máy — dùng cho mặt theo dõi khi luật
    /// không chặn (PRD §2.15): luật đang tắt (ngữ cảnh rule_disabled)
    /// hoặc luật đang bật nhưng bị ghi đè mở khóa tạm thời che mất
    /// (ngữ cảnh temp_allowed). KHÁC <see cref="Evaluate"/>: hàm này
    /// coi MỌI luật truyền vào là đang bật (không đọc cờ Enabled —
    /// người gọi truyền đúng tập cần xét: luật-tắt-theo-dõi hoặc luật
    /// đang bật), không xét ghi đè/khóa cưỡng chế, và trả về TỪNG
    /// luật khớp thay vì một quyết định gộp. Ngữ nghĩa từng loại bám
    /// đúng các helper thi hành: bedtime dùng IsInBedtime; daily_limit
    /// dùng GetDailyLimitMinutes + so usedToday như CheckDailyLimit
    /// (không cộng bonus — bonus là cho phép tạm thời, thuộc phía
    /// người gọi); time_window theo ngữ nghĩa HỢP của CheckTimeWindows:
    /// nếu tập truyền vào có ít nhất một luật khung giờ và thời điểm
    /// nằm ngoài MỌI khung của MỌI luật khung giờ trong tập thì TẤT
    /// CẢ luật khung giờ trong tập đều "sẽ khóa" (một luật khung giờ
    /// đơn lẻ không tự quyết được, vì luật khác có thể cho phép).
    /// <paramref name="now"/> theo cùng quy ước giờ thi hành như
    /// Evaluate (đã quy đổi múi giờ gia đình theo giờ tin cậy).
    /// </summary>
    public IReadOnlyList<Rule> FindWouldLockTimeRules(
        IReadOnlyList<Rule> rules,
        TimeSpan usedToday,
        DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(rules);

        DateTime local = now.DateTime;
        int weekday = (int)local.DayOfWeek;
        var matches = new List<Rule>();
        var windowRules = new List<Rule>();

        foreach (Rule rule in rules)
        {
            switch (rule.Type)
            {
                case RuleTypes.Bedtime:
                    if (IsInBedtime(rule, local))
                    {
                        matches.Add(rule);
                    }

                    break;

                case RuleTypes.DailyLimit:
                    int? limit = GetDailyLimitMinutes(rule, weekday);
                    if (limit is not null && (int)usedToday.TotalMinutes >= limit.Value)
                    {
                        matches.Add(rule);
                    }

                    break;

                case RuleTypes.TimeWindow:
                    windowRules.Add(rule);
                    break;
            }
        }

        if (windowRules.Count > 0)
        {
            // Tái dùng nguyên CheckTimeWindows trên bản sao đã bật cờ:
            // nó chỉ đọc các luật time_window đang bật trong danh sách
            // và trả quyết định Lock đúng khi ngoài mọi khung giờ.
            var asEnabled = new List<Rule>(windowRules.Count);
            foreach (Rule rule in windowRules)
            {
                asEnabled.Add(new Rule
                {
                    Id = rule.Id,
                    FamilyId = rule.FamilyId,
                    ChildId = rule.ChildId,
                    Type = rule.Type,
                    Config = rule.Config,
                    Enabled = true,
                    CreatedAt = rule.CreatedAt,
                    Name = rule.Name,
                });
            }

            RuleDecision? decision = CheckTimeWindows(asEnabled, local);
            if (decision is { Kind: RuleDecisionKind.Lock })
            {
                matches.AddRange(windowRules);
            }
        }

        return matches;
    }

    /// <summary>Giờ bắt đầu/kết thúc giờ ngủ của một rule cho một thứ (hình dạng mới theo thứ, hoặc hình dạng cũ mọi ngày).</summary>
    private static bool TryGetBedtimeStart(Rule rule, int weekday, out TimeOnly start, out TimeOnly end)
    {
        start = default;
        end = default;

        if (TryGetObject(rule.Config, "bedtimeByWeekday", out JsonElement byWeekday))
        {
            return TryGetTimeRange(byWeekday, weekday.ToString(CultureInfo.InvariantCulture), out start, out end);
        }

        return TryGetTime(rule.Config, "start", out start) && TryGetTime(rule.Config, "end", out end);
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
