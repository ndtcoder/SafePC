using System.Globalization;
using System.Text.Json;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>Một khung giờ trong ngày (giờ địa phương), dạng [start, end).</summary>
internal readonly record struct AppTimeWindow(TimeOnly Start, TimeOnly End);

/// <summary>Một app trong config quy tắc: tên exe đã chuẩn hóa + tên hiển thị cho thông báo.</summary>
internal sealed record AppRef(string NormalizedExe, string DisplayName);

/// <summary>Một mục giới hạn thời gian theo app: app + số phút tối đa mỗi ngày (ngày địa phương).</summary>
internal sealed record AppTimeLimitEntry(AppRef App, int MinutesPerDay);

/// <summary>Một mục chặn app theo giờ: app + các khung giờ ĐƯỢC dùng theo thứ (ngoài khung thì đóng app).</summary>
internal sealed record AppBlockEntry(AppRef App, Dictionary<int, List<AppTimeWindow>> WindowsByWeekday);

/// <summary>Một rule giờ học tập trung (type website, mode focus): khung giờ tập trung + app được phép trong giờ đó.</summary>
internal sealed record FocusRuleEntry(Dictionary<int, List<AppTimeWindow>> WindowsByWeekday, List<AppRef> AllowedApps);

/// <summary>Cấu hình nghỉ bắt buộc: dùng liên tục workMinutes thì khóa máy breakMinutes.</summary>
internal sealed record ForcedBreakConfig(int WorkMinutes, int BreakMinutes);

/// <summary>Kết quả phân tích các rule theo app / focus / nghỉ bắt buộc từ cache rules.</summary>
internal sealed class ParsedAppRules
{
    public List<AppTimeLimitEntry> TimeLimits { get; } = new();
    public List<AppBlockEntry> BlockByTime { get; } = new();
    public List<FocusRuleEntry> FocusRules { get; } = new();
    public ForcedBreakConfig? BreakConfig { get; set; }

    /// <summary>Có rule nào cần thi hành theo foreground không (không tính nghỉ bắt buộc — đánh giá riêng).</summary>
    public bool HasAny => TimeLimits.Count > 0 || BlockByTime.Count > 0 || FocusRules.Count > 0;
}

/// <summary>
/// Phân tích config JSON của rule theo app và rule focus (Sprint 2 đợt 3).
/// Thuần logic, không I/O — AgentWorker chỉ gọi lại khi chữ ký rules đổi, để
/// không phân tích JSON và không ghi log cảnh báo lặp lại mỗi 15 giây.
///
/// Hình dạng config (khớp hợp đồng chia sẻ với Dashboard, xem docs/02):
/// - type 'app', mode 'app_time_limit': {"apps":[{"exe":"game.exe","name":"Game","minutesPerDay":60}]}
/// - type 'app', mode 'app_block_by_time': {"apps":[...],"windowsByWeekday":{"1":[{"start":"07:00","end":"21:00"}]}}
/// - type 'app', mode 'forced_break': {"workMinutes":45,"breakMinutes":10}
/// - type 'website', mode 'focus': {"windowsByWeekday":{...},"allowedApps":[...],"allowedDomains":[...]}
///   (phía Agent chỉ cần windowsByWeekday + allowedApps; allowedDomains do
///   extension thi hành qua mục focus trong domain_rules.json.)
///
/// Quy ước thứ: 0 = Chủ nhật..6 = Thứ 7, khớp DayOfWeek. Mọi mục không hợp
/// lệ đều bị bỏ qua kèm log cảnh báo (fail-open: không đoán ý phụ huynh).
/// </summary>
internal static class AppRuleParser
{
    public static ParsedAppRules Parse(IReadOnlyList<Rule> rules, LocalLogger log)
    {
        ArgumentNullException.ThrowIfNull(rules);
        ArgumentNullException.ThrowIfNull(log);

        var parsed = new ParsedAppRules();

        foreach (Rule rule in rules)
        {
            if (!rule.Enabled)
            {
                continue;
            }

            if (rule.Type == RuleTypes.App)
            {
                ParseAppRule(rule, parsed, log);
            }
            else if (rule.Type == RuleTypes.Website)
            {
                // Chỉ mode focus thuộc về phía Agent (đóng app ngoài danh
                // sách cho phép); các mode website khác do extension thi
                // hành qua DomainRulesPublisher — bỏ qua im lặng ở đây.
                if (rule.Config.ValueKind == JsonValueKind.Object
                    && TryGetString(rule.Config, "mode") == "focus")
                {
                    ParseFocusRule(rule, parsed, log);
                }
            }
        }

        return parsed;
    }

    private static void ParseAppRule(Rule rule, ParsedAppRules parsed, LocalLogger log)
    {
        JsonElement config = rule.Config;
        if (config.ValueKind != JsonValueKind.Object)
        {
            log.Warning("Rule app có config không phải object, bỏ qua.");
            return;
        }

        string? mode = TryGetString(config, "mode");
        switch (mode)
        {
            case "app_time_limit":
                ParseAppTimeLimit(config, parsed, log);
                break;

            case "app_block_by_time":
                ParseAppBlockByTime(config, parsed, log);
                break;

            case "forced_break":
                ParseForcedBreak(config, parsed, log);
                break;

            default:
                log.Warning("Rule app không rõ mode, bỏ qua: " + (mode ?? "(trống)") + ".");
                break;
        }
    }

    private static void ParseAppTimeLimit(JsonElement config, ParsedAppRules parsed, LocalLogger log)
    {
        if (!config.TryGetProperty("apps", out JsonElement apps) || apps.ValueKind != JsonValueKind.Array)
        {
            log.Warning("Rule app_time_limit thiếu mảng apps, bỏ qua.");
            return;
        }

        foreach (JsonElement item in apps.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
            {
                log.Warning("Mục apps không phải object trong rule app_time_limit, đã bỏ qua.");
                continue;
            }

            AppRef? app = TryParseAppRef(item, log, "app_time_limit");
            if (app is null)
            {
                continue;
            }

            if (!TryGetInt32(item, "minutesPerDay", out int minutes) || minutes < 1 || minutes > 1440)
            {
                log.Warning("Rule app_time_limit thiếu minutesPerDay hợp lệ (1-1440) cho app " + app.DisplayName + ", đã bỏ qua.");
                continue;
            }

            parsed.TimeLimits.Add(new AppTimeLimitEntry(app, minutes));
        }
    }

    private static void ParseAppBlockByTime(JsonElement config, ParsedAppRules parsed, LocalLogger log)
    {
        List<AppRef> apps = ParseAppRefs(config, "apps", log, "app_block_by_time");
        if (apps.Count == 0)
        {
            log.Warning("Rule app_block_by_time không có app hợp lệ, bỏ qua.");
            return;
        }

        Dictionary<int, List<AppTimeWindow>>? windows = ParseWindowsByWeekday(config);
        if (windows is null)
        {
            log.Warning("Rule app_block_by_time thiếu khung giờ hợp lệ, bỏ qua.");
            return;
        }

        foreach (AppRef app in apps)
        {
            parsed.BlockByTime.Add(new AppBlockEntry(app, windows));
        }
    }

    private static void ParseForcedBreak(JsonElement config, ParsedAppRules parsed, LocalLogger log)
    {
        if (!TryGetInt32(config, "workMinutes", out int workMinutes)
            || workMinutes < 15 || workMinutes > 180
            || !TryGetInt32(config, "breakMinutes", out int breakMinutes)
            || breakMinutes < 5 || breakMinutes > 60)
        {
            log.Warning("Rule forced_break có workMinutes (15-180) hoặc breakMinutes (5-60) không hợp lệ, bỏ qua.");
            return;
        }

        // Nhiều rule forced_break: rule hợp lệ đầu tiên thắng (Dashboard chỉ
        // cho một rule loại này trên mỗi con; thứ tự cache là ổn định).
        parsed.BreakConfig ??= new ForcedBreakConfig(workMinutes, breakMinutes);
    }

    private static void ParseFocusRule(Rule rule, ParsedAppRules parsed, LocalLogger log)
    {
        JsonElement config = rule.Config;

        Dictionary<int, List<AppTimeWindow>>? windows = ParseWindowsByWeekday(config);
        if (windows is null)
        {
            log.Warning("Rule focus thiếu khung giờ hợp lệ, bỏ qua.");
            return;
        }

        List<AppRef> allowedApps = ParseAppRefs(config, "allowedApps", log, "focus");
        if (allowedApps.Count == 0)
        {
            log.Warning("Rule focus không có allowedApps hợp lệ, bỏ qua.");
            return;
        }

        parsed.FocusRules.Add(new FocusRuleEntry(windows, allowedApps));
    }

    /// <summary>Đọc một mảng các app {exe, name} trong config. Mục thiếu exe hợp lệ thì bỏ qua kèm cảnh báo.</summary>
    private static List<AppRef> ParseAppRefs(JsonElement config, string property, LocalLogger log, string context)
    {
        var apps = new List<AppRef>();
        if (!config.TryGetProperty(property, out JsonElement array) || array.ValueKind != JsonValueKind.Array)
        {
            return apps;
        }

        foreach (JsonElement item in array.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
            {
                log.Warning("Mục " + property + " không phải object trong rule " + context + ", đã bỏ qua.");
                continue;
            }

            AppRef? app = TryParseAppRef(item, log, context);
            if (app is not null)
            {
                apps.Add(app);
            }
        }

        return apps;
    }

    private static AppRef? TryParseAppRef(JsonElement item, LocalLogger log, string context)
    {
        string? exe = TryGetString(item, "exe");
        string? normalized = ExeNames.Normalize(exe);
        if (normalized is null)
        {
            log.Warning("Mục app thiếu exe hợp lệ trong rule " + context + ", đã bỏ qua.");
            return null;
        }

        string? name = TryGetString(item, "name");
        string displayName = string.IsNullOrWhiteSpace(name) ? exe!.Trim() : name.Trim();
        return new AppRef(normalized, displayName);
    }

    /// <summary>
    /// Đọc windowsByWeekday (0 = Chủ nhật..6 = Thứ 7). Chỉ giữ khung start
    /// &lt; end hợp lệ; ngày không còn khung nào thì bỏ. Trả về null khi
    /// không còn khung hợp lệ nào.
    /// </summary>
    private static Dictionary<int, List<AppTimeWindow>>? ParseWindowsByWeekday(JsonElement config)
    {
        if (!config.TryGetProperty("windowsByWeekday", out JsonElement byWeekday)
            || byWeekday.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var parsed = new Dictionary<int, List<AppTimeWindow>>();
        foreach (JsonProperty day in byWeekday.EnumerateObject())
        {
            if (!int.TryParse(day.Name, NumberStyles.Integer, CultureInfo.InvariantCulture, out int weekday)
                || weekday < 0 || weekday > 6
                || day.Value.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            var ranges = new List<AppTimeWindow>();
            foreach (JsonElement range in day.Value.EnumerateArray())
            {
                if (range.ValueKind != JsonValueKind.Object
                    || !TryGetTime(range, "start", out TimeOnly start)
                    || !TryGetTime(range, "end", out TimeOnly end)
                    || start >= end)
                {
                    continue;
                }

                ranges.Add(new AppTimeWindow(start, end));
            }

            if (ranges.Count > 0)
            {
                parsed[weekday] = ranges;
            }
        }

        return parsed.Count == 0 ? null : parsed;
    }

    /// <summary>Có đang trong một khung giờ của hôm nay không? Trả về số phút tới cuối khung gần nhất đang chứa thời điểm hiện tại.</summary>
    internal static int? MinutesUntilWindowEnd(Dictionary<int, List<AppTimeWindow>> windows, DateTime local)
    {
        if (!windows.TryGetValue((int)local.DayOfWeek, out List<AppTimeWindow>? ranges))
        {
            return null;
        }

        TimeOnly current = TimeOnly.FromDateTime(local);
        int? remaining = null;
        foreach (AppTimeWindow window in ranges)
        {
            if (current >= window.Start && current < window.End)
            {
                int minutes = (int)(window.End - current).TotalMinutes;
                remaining = remaining is null ? minutes : Math.Max(remaining.Value, minutes);
            }
        }

        return remaining;
    }

    private static string? TryGetString(JsonElement obj, string property)
    {
        return obj.ValueKind == JsonValueKind.Object
            && obj.TryGetProperty(property, out JsonElement element)
            && element.ValueKind == JsonValueKind.String
            ? element.GetString()
            : null;
    }

    private static bool TryGetInt32(JsonElement obj, string property, out int value)
    {
        value = 0;
        return obj.ValueKind == JsonValueKind.Object
            && obj.TryGetProperty(property, out JsonElement element)
            && element.ValueKind == JsonValueKind.Number
            && element.TryGetInt32(out value);
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
}
