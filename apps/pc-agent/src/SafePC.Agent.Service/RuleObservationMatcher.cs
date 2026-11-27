using System.Globalization;
using System.Text.Json;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>
/// Đối chiếu mẫu sử dụng với luật cho mặt THEO DÕI KHI LUẬT KHÔNG
/// CHẶN (PRD §2.15, migration 31): thuần logic đọc config luật, không
/// I/O. Dùng cho cả ba đường ghi nhận của AgentWorker: luật đang tắt
/// (cache monitor — ngữ cảnh rule_disabled), luật đang bật nhưng bị
/// cho phép tạm thời che mất (cache thi hành — ngữ cảnh temp_allowed)
/// và trường hợp suy luận là không chặn được (unenforceable — phía
/// AgentWorker SUY LUẬN từ heartbeat extension, không phải bằng
/// chứng tuyệt đối; xem ghi chú tại RecordWebObservationsAsync).
///
/// Ngữ nghĩa khớp bám đúng phía thi hành: app so bằng
/// <see cref="ExeNames.Matches"/> như AppRuleParser/AgentWorker;
/// domain khớp hậu tố (host bằng domain hoặc là tên miền con) +
/// danh mục mở rộng qua <see cref="DomainCategoryLists"/> + mẫu URL
/// "host/path" — cùng chuẩn hóa với DomainRulesPublisher
/// (NormalizeDomain/NormalizeUrlPattern được dùng lại trực tiếp,
/// không chép bản sao). Khung giờ theo thứ đọc từ
/// windowsByWeekday với cùng quy tắc bỏ khoảng start &gt;= end như
/// AppRuleParser.ParseWindowsByWeekday. Mọi thời điểm truyền vào đều
/// đã quy đổi múi giờ gia đình theo giờ tin cậy (TrustedClock).
/// </summary>
internal static class RuleObservationMatcher
{
    /// <summary>Ngữ cảnh: mẫu thuộc diện luật đang tắt.</summary>
    public const string ContextRuleDisabled = "rule_disabled";

    /// <summary>Ngữ cảnh: mẫu thuộc diện luật đang bật nhưng đang được cho phép tạm thời.</summary>
    public const string ContextTempAllowed = "temp_allowed";

    /// <summary>Ngữ cảnh: mẫu thuộc diện luật đang bật nhưng không chặn được (nhãn SUY LUẬN từ trạng thái extension — best-effort, chỉ phục vụ báo cáo).</summary>
    public const string ContextUnenforceable = "unenforceable";

    /// <summary>
    /// Mặt theo dõi của luật còn bật không: config.observe vắng mặt
    /// (hoặc không phải boolean) = BẬT (mặc định theo PRD §2.15); chỉ
    /// giá trị false tường minh mới tắt. Khớp điều kiện lọc phía
    /// server trong RPC safepc_fetch_device_monitor_rules.
    /// </summary>
    public static bool ObserveEnabled(Rule rule)
    {
        return rule.Config.ValueKind != JsonValueKind.Object
            || !rule.Config.TryGetProperty("observe", out JsonElement observe)
            || observe.ValueKind != JsonValueKind.False;
    }

    /// <summary>
    /// Mode hiệu lực của luật để làm bản chụp rule_mode: type app/
    /// website lấy config.mode; luật giờ (daily_limit/bedtime/
    /// time_window) lấy chính type. Thiếu mode thì trả về type.
    /// </summary>
    public static string ModeOf(Rule rule)
    {
        if ((rule.Type == RuleTypes.App || rule.Type == RuleTypes.Website)
            && rule.Config.ValueKind == JsonValueKind.Object
            && rule.Config.TryGetProperty("mode", out JsonElement mode)
            && mode.ValueKind == JsonValueKind.String
            && !string.IsNullOrWhiteSpace(mode.GetString()))
        {
            return mode.GetString()!;
        }

        return rule.Type;
    }

    /// <summary>
    /// Tên bản chụp của luật: tên phụ huynh đặt (rules.name) khi có;
    /// chưa có (server cũ chưa trả name, hoặc luật chưa đặt tên) thì
    /// dùng mode/type làm nhãn — Dashboard nhóm báo cáo theo tên này.
    /// </summary>
    public static string SnapshotName(Rule rule)
    {
        return !string.IsNullOrWhiteSpace(rule.Name) ? rule.Name.Trim() : ModeOf(rule);
    }

    /// <summary>Các exe thô trong mảng config.apps của luật app (chưa chuẩn hóa; so khớp bằng ExeNames.Matches).</summary>
    public static IReadOnlyList<string> RuleApps(Rule rule, string property = "apps")
    {
        var apps = new List<string>();
        if (rule.Config.ValueKind == JsonValueKind.Object
            && rule.Config.TryGetProperty(property, out JsonElement array)
            && array.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement element in array.EnumerateArray())
            {
                if (element.ValueKind == JsonValueKind.Object
                    && element.TryGetProperty("exe", out JsonElement exe)
                    && exe.ValueKind == JsonValueKind.String
                    && !string.IsNullOrWhiteSpace(exe.GetString()))
                {
                    apps.Add(exe.GetString()!);
                }
            }
        }

        return apps;
    }

    /// <summary>
    /// Mẫu app có thuộc diện luật app này không tại thời điểm gia
    /// đình <paramref name="familyTime"/>: app_block — thuộc danh
    /// sách apps là đủ; app_block_by_time — thuộc apps VÀ thời điểm
    /// nằm NGOÀI các khung giờ luật cho phép (trong khung là luật
    /// đang "nghỉ", mẫu không thuộc diện bị chặn thiếu).
    /// </summary>
    public static bool AppRuleMatches(Rule rule, string sampleAppName, DateTimeOffset familyTime)
    {
        string mode = ModeOf(rule);
        if (mode is not ("app_block" or "app_block_by_time"))
        {
            return false;
        }

        bool listed = false;
        foreach (string exe in RuleApps(rule))
        {
            if (ExeNames.Matches(exe, sampleAppName))
            {
                listed = true;
                break;
            }
        }

        if (!listed)
        {
            return false;
        }

        if (mode == "app_block")
        {
            return true;
        }

        Dictionary<int, List<(TimeOnly Start, TimeOnly End)>>? windows = ParseWindows(rule.Config);
        return windows is not null && !IsInWindows(windows, familyTime.DateTime);
    }

    /// <summary>
    /// Lượt web (host + path) có thuộc diện luật website này không
    /// tại thời điểm gia đình <paramref name="familyTime"/>:
    /// block_domains — host khớp domain/danh mục/mẫu URL là đủ;
    /// block_domains_by_time — thêm điều kiện thời điểm nằm TRONG
    /// khung giờ chặn của luật. Mode focus không đối chiếu ở đây
    /// (đường tick xử lý riêng theo app foreground).
    /// </summary>
    public static bool DomainRuleMatches(Rule rule, string host, string? path, DateTimeOffset familyTime)
    {
        string mode = ModeOf(rule);
        if (mode is not ("block_domains" or "block_domains_by_time"))
        {
            return false;
        }

        if (!DomainTargetsMatch(rule, host, path))
        {
            return false;
        }

        if (mode == "block_domains")
        {
            return true;
        }

        Dictionary<int, List<(TimeOnly Start, TimeOnly End)>>? windows = ParseWindows(rule.Config);
        return windows is not null && IsInWindows(windows, familyTime.DateTime);
    }

    /// <summary>
    /// Host (+ path) có khớp phần đối tượng của luật website không:
    /// mảng domains (khớp hậu tố), danh mục (mở rộng domain hạt giống
    /// qua DomainCategoryLists rồi khớp hậu tố như publisher gộp vào
    /// tập chặn), mảng urlPatterns (host khớp hậu tố domain của mẫu
    /// VÀ path bắt đầu bằng path của mẫu).
    /// </summary>
    public static bool DomainTargetsMatch(Rule rule, string host, string? path)
    {
        string? normalizedHost = DomainRulesPublisher.NormalizeDomain(host);
        if (normalizedHost is null)
        {
            return false;
        }

        if (rule.Config.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        if (rule.Config.TryGetProperty("domains", out JsonElement domains)
            && domains.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement element in domains.EnumerateArray())
            {
                if (element.ValueKind != JsonValueKind.String)
                {
                    continue;
                }

                string? domain = DomainRulesPublisher.NormalizeDomain(element.GetString());
                if (domain is not null && HostMatchesDomain(normalizedHost, domain))
                {
                    return true;
                }
            }
        }

        if (rule.Config.TryGetProperty("categories", out JsonElement categories)
            && categories.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement element in categories.EnumerateArray())
            {
                if (element.ValueKind != JsonValueKind.String)
                {
                    continue;
                }

                string? categoryId = element.GetString();
                if (categoryId is not null
                    && DomainCategoryLists.ById.TryGetValue(categoryId, out string[]? seeds))
                {
                    foreach (string seed in seeds)
                    {
                        if (HostMatchesDomain(normalizedHost, seed))
                        {
                            return true;
                        }
                    }
                }
            }
        }

        if (path is not null
            && rule.Config.TryGetProperty("urlPatterns", out JsonElement patterns)
            && patterns.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement element in patterns.EnumerateArray())
            {
                if (element.ValueKind != JsonValueKind.String)
                {
                    continue;
                }

                string? pattern = DomainRulesPublisher.NormalizeUrlPattern(element.GetString());
                if (pattern is null)
                {
                    continue;
                }

                int slash = pattern.IndexOf('/');
                string patternHost = pattern[..slash];
                string patternPath = pattern[slash..];
                if (HostMatchesDomain(normalizedHost, patternHost)
                    && path.StartsWith(patternPath, StringComparison.Ordinal))
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>Host khớp một domain luật khi bằng nhau hoặc là tên miền con của nó (khớp hậu tố theo nhãn, như extension).</summary>
    public static bool HostMatchesDomain(string host, string domain)
    {
        return string.Equals(host, domain, StringComparison.Ordinal)
            || host.EndsWith("." + domain, StringComparison.Ordinal);
    }

    /// <summary>
    /// Đọc windowsByWeekday của config thành map thứ (0 = Chủ nhật..
    /// 6 = Thứ 7) → các khoảng (start, end); bỏ khoảng start &gt;=
    /// end và ngày không có khoảng hợp lệ nào — cùng quy tắc
    /// AppRuleParser.ParseWindowsByWeekday. Trả null khi không có
    /// khung hợp lệ nào.
    /// </summary>
    public static Dictionary<int, List<(TimeOnly Start, TimeOnly End)>>? ParseWindows(JsonElement config)
    {
        if (config.ValueKind != JsonValueKind.Object
            || !config.TryGetProperty("windowsByWeekday", out JsonElement byWeekday)
            || byWeekday.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var parsed = new Dictionary<int, List<(TimeOnly Start, TimeOnly End)>>();
        foreach (JsonProperty day in byWeekday.EnumerateObject())
        {
            if (!int.TryParse(day.Name, NumberStyles.Integer, CultureInfo.InvariantCulture, out int weekday)
                || weekday < 0 || weekday > 6
                || day.Value.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            var ranges = new List<(TimeOnly Start, TimeOnly End)>();
            foreach (JsonElement range in day.Value.EnumerateArray())
            {
                if (range.ValueKind != JsonValueKind.Object
                    || !TryGetTime(range, "start", out TimeOnly start)
                    || !TryGetTime(range, "end", out TimeOnly end)
                    || start >= end)
                {
                    continue;
                }

                ranges.Add((start, end));
            }

            if (ranges.Count > 0)
            {
                parsed[weekday] = ranges;
            }
        }

        return parsed.Count == 0 ? null : parsed;
    }

    /// <summary>Thời điểm (giờ địa phương gia đình) có nằm trong một khung giờ của thứ hôm đó không.</summary>
    public static bool IsInWindows(Dictionary<int, List<(TimeOnly Start, TimeOnly End)>> windows, DateTime familyLocal)
    {
        if (!windows.TryGetValue((int)familyLocal.DayOfWeek, out List<(TimeOnly Start, TimeOnly End)>? ranges))
        {
            return false;
        }

        TimeOnly current = TimeOnly.FromDateTime(familyLocal);
        foreach ((TimeOnly start, TimeOnly end) in ranges)
        {
            if (current >= start && current < end)
            {
                return true;
            }
        }

        return false;
    }

    private static bool TryGetTime(JsonElement element, string property, out TimeOnly time)
    {
        time = default;
        return element.TryGetProperty(property, out JsonElement value)
            && value.ValueKind == JsonValueKind.String
            && TimeOnly.TryParse(value.GetString(), CultureInfo.InvariantCulture, out time);
    }
}
