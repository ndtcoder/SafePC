using System.Globalization;
using System.Linq;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>
/// Xuất bản quy tắc website cho extension trình duyệt (Sprint 2 đợt 2).
///
/// Luồng: rules <c>type = 'website'</c> trong cache SQLite + ghi đè domain
/// đang hiệu lực -&gt; file <c>domain_rules.json</c> trong thư mục chia sẻ
/// <c>%ProgramData%\SafePC\shared\</c> -&gt; NativeHost đọc file này và trả
/// cho extension qua giao thức native messaging. Extension KHÔNG bao giờ nói
/// chuyện trực tiếp với Supabase và không đọc được database/token của Agent.
/// Từ Sprint 2 đợt 3, file còn mang thêm mục <c>focus</c> (giờ học tập trung,
/// hợp từ mọi rule focus) — trường cộng thêm, Version vẫn là 1. Bản sửa lỗi
/// sau đó thêm <c>allowlistByTime</c> (allowlist chỉ trong khung giờ, hợp từ
/// mọi rule mode 'allowlist_by_time'; khóa vắng mặt khi không có rule nào) —
/// cũng là trường cộng thêm, Version vẫn là 1. Batch 4 thêm <c>urlPatterns</c>
/// (mẫu "host/path" chỉ chặn đúng đường dẫn đó, hợp từ mọi rule mode
/// 'block_domains'; khóa vắng mặt khi không có mẫu nào) — cũng là trường
/// cộng thêm, Version vẫn là 1. Đợt danh mục chặn thêm <c>blockedCategories</c>
/// (domain theo từng danh mục đã chọn, hợp từ mọi rule mode
/// 'block_domains' mang mảng 'categories'; khóa vắng mặt khi không có
/// danh mục nào) — cũng là trường cộng thêm, Version vẫn là 1. Đợt kiểm
/// duyệt từ khóa tìm kiếm (27/11/2026) thêm <c>searchGuard</c> (từ khóa
/// cấm tìm kiếm, hợp từ mọi rule mode 'block_search_keywords', chuẩn hóa
/// trim + chữ thường + bỏ trùng; khóa vắng mặt khi không có rule nào) —
/// cũng là trường cộng thêm, Version vẫn là 1. Domain
/// danh mục đồng thời nằm trong <c>blocked</c> (cùng mức ưu tiên chặn 30
/// phía extension); <c>blockedCategories</c> chỉ để extension hiện đúng
/// lý do theo danh mục trên trang chặn.
///
/// File chỉ ghi lại khi nội dung (trừ <c>updated_at</c>) thay đổi, để vòng
/// lặp đồng bộ mỗi phút không chạm đĩa vô ích. Ghi nguyên tử: ghi file tạm
/// rồi đổi tên đè lên, nên NativeHost không bao giờ đọc được file nửa vời.
///
/// BẢO MẬT (docs/03-SECURITY.md): thư mục shared có ACL SYSTEM toàn quyền +
/// Users chỉ đọc (kế thừa xuống file), cộng quyền tạo file chỉ ở mức thư
/// mục để NativeHost (chạy ở quyền user) ghi được <c>web_usage.jsonl</c>.
/// Bản thân <c>domain_rules.json</c> được khóa thêm bằng ACL riêng ở cấp
/// file (SYSTEM + Administrators toàn quyền, Users chỉ đọc, không kế thừa),
/// nên tài khoản Standard của con không sửa/xóa được quy tắc. Đặt ACL là
/// best-effort: thất bại thì ghi log cảnh báo và dùng ACL mặc định.
/// </summary>
public sealed class DomainRulesPublisher
{
    /// <summary>Thư mục chia sẻ giữa Service (SYSTEM) và NativeHost (user).</summary>
    public static string SharedDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "SafePC",
        "shared");

    /// <summary>File quy tắc domain extension đọc qua NativeHost.</summary>
    public static string DomainRulesFilePath => Path.Combine(SharedDirectory, "domain_rules.json");

    /// <summary>File JSONL NativeHost ghi lượt thăm web vào, Service đọc lên server.</summary>
    public static string WebUsageFilePath => Path.Combine(SharedDirectory, "web_usage.jsonl");

    /// <summary>File JSONL NativeHost ghi yêu cầu xin mở domain vào (extension 0.1.9), Service đọc trong chu kỳ poll lệnh.</summary>
    public static string DomainRequestsFilePath => Path.Combine(SharedDirectory, "domain_requests.jsonl");

    /// <summary>File JSONL NativeHost ghi cụm từ tìm kiếm vào (extension 0.1.11), Service đọc trong chu kỳ flush usage.</summary>
    public static string SearchTermsFilePath => Path.Combine(SharedDirectory, "search_terms.jsonl");

    /// <summary>File NativeHost ghi đè mỗi khi extension liên hệ (chỉ chứa timestamp UTC ISO), Service đọc để báo extension còn sống.</summary>
    public static string ExtensionHeartbeatFilePath => Path.Combine(SharedDirectory, "extension_heartbeat.txt");

    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    private readonly OutboxStore _outbox;
    private readonly LocalLogger _log;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private string? _lastPublishedBody;

    public DomainRulesPublisher(OutboxStore outbox, LocalLogger log)
    {
        _outbox = outbox;
        _log = log;
    }

    /// <summary>
    /// Xuất bản lại file quy tắc domain từ cache rules + ghi đè đang hiệu
    /// lực. Trả về true chỉ khi file thực sự được ghi (nội dung thay đổi).
    /// Không bao giờ ném exception (trừ hủy): lỗi I/O/SQLite chỉ ghi log,
    /// để vòng lặp gọi không chết vì một lần xuất bản lỗi.
    /// <paramref name="activeChildId"/> (Sprint 5): hồ sơ con đang ngồi ở
    /// máy — ghi đè domain chỉ được tính khi thuộc về con đó; null = đường
    /// cũ (không biết con nào, tính mọi ghi đè như trước — dùng lúc khởi
    /// động trước khi vòng tick phân giải con lần đầu).
    /// </summary>
    public async Task<bool> PublishAsync(CancellationToken ct, Guid? activeChildId = null, Guid? defaultChildId = null)
    {
        await _gate.WaitAsync(ct);
        try
        {
            DomainRulesFile file = await BuildFileAsync(ct, activeChildId, defaultChildId);

            // So sánh nội dung TRỪ updated_at (đang để trống): nếu các quy
            // tắc không đổi thì không ghi lại, kể cả khi được gọi mỗi phút.
            string bodyJson = JsonSerializer.Serialize(file, JsonOptions);
            if (bodyJson == _lastPublishedBody)
            {
                return false;
            }

            file.UpdatedAt = DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture);
            string json = JsonSerializer.Serialize(file, JsonOptions);

            EnsureSharedDirectory();
            string tempPath = Path.Combine(SharedDirectory, "domain_rules.json.tmp-" + Guid.NewGuid().ToString("N"));
            try
            {
                await File.WriteAllTextAsync(tempPath, json, new UTF8Encoding(false), ct);
                File.Move(tempPath, DomainRulesFilePath, overwrite: true);
            }
            catch
            {
                try
                {
                    File.Delete(tempPath);
                }
                catch (IOException)
                {
                    // Bỏ qua lỗi dọn file tạm.
                }
                catch (UnauthorizedAccessException)
                {
                    // Bỏ qua lỗi dọn file tạm.
                }

                throw;
            }

            EnsureRulesFileAcl(DomainRulesFilePath);
            _lastPublishedBody = bodyJson;
            _log.Info("Đã xuất bản domain_rules.json: " + file.Blocked.Count + " domain chặn, "
                + (file.UrlPatterns is null ? 0 : file.UrlPatterns.Count) + " mẫu URL, "
                + (file.BlockedCategories is null
                    ? "không có danh mục"
                    : "danh mục " + file.BlockedCategories.Count + " (" + file.BlockedCategories.Values.Sum(list => list.Count) + " domain)") + ", "
                + file.BlockedByTime.Count + " chặn theo giờ, "
                + (file.Allowlist is null ? "không có allowlist" : file.Allowlist.Count + " domain cho phép") + ", "
                + (file.AllowlistByTime is null ? "không có allowlist theo giờ" : file.AllowlistByTime.Count + " allowlist theo giờ") + ", "
                + file.DomainLimits.Count + " giới hạn theo domain, "
                + "tempAllow " + file.TempAllow.Count + ", tempBlock " + file.TempBlock.Count + ", "
                + (file.Focus is null ? "không có focus" : "focus " + file.Focus.AllowedDomains.Count + " domain cho phép") + ", "
                + (file.SearchGuard is null ? "không có searchGuard" : "searchGuard " + file.SearchGuard.BlockedKeywords.Count + " từ khóa cấm") + ".");
            return true;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.Error("Xuất bản domain_rules.json lỗi.", ex);
            return false;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Dựng nội dung file từ cache rules (chỉ rule website đang bật) và ghi
    /// đè domain đang hiệu lực. Mọi danh sách đều sắp xếp determinist để
    /// chuỗi so sánh không đổi giả khi quy tắc không đổi. Cache rules chỉ
    /// chứa luật của con đang active (AgentWorker đổi cache khi đổi phiên)
    /// nên file luôn là luật của đúng con đó. Ghi đè domain (một hàng duy
    /// nhất trên toàn máy) chỉ được tính khi thuộc về con đang active —
    /// <paramref name="activeChildId"/> null thì tính như trước (đường cũ).
    /// </summary>
    private async Task<DomainRulesFile> BuildFileAsync(CancellationToken ct, Guid? activeChildId = null, Guid? defaultChildId = null)
    {
        var file = new DomainRulesFile();
        var blocked = new HashSet<string>(StringComparer.Ordinal);
        var urlPatterns = new HashSet<string>(StringComparer.Ordinal);

        // Danh mục chặn: domain theo từng id danh mục, hợp qua mọi rule
        // block_domains (xem AddRuleCategories). Sau vòng lặp, domain
        // danh mục hợp vào tập chặn chung + xuất riêng theo danh mục.
        var categoryDomains = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);

        // Kiểm duyệt từ khóa tìm kiếm (27/11/2026): hợp từ khóa cấm từ
        // mọi rule mode 'block_search_keywords' đang hiệu lực của con
        // đang xét — đã chuẩn hóa (trim + chữ thường) ngay khi đọc nên
        // tập này tự bỏ trùng (xem AddRuleSearchKeywords).
        var searchKeywords = new HashSet<string>(StringComparer.Ordinal);
        HashSet<string>? allowlist = null;
        bool safeSearch = false;
        bool youtubeRestricted = false;

        // Allowlist theo giờ: hợp (union) qua nhiều entry — mỗi rule hợp lệ
        // thành một entry, extension đánh giá "trong khung giờ của BẤT KỲ
        // entry nào thì chỉ cho phép hợp các domain của các entry đang hiệu
        // lực" (xem thang ưu tiên DNR ở DomainRulesFile).
        var allowlistByTime = new List<TimeBlockedEntry>();

        // Giờ học tập trung (Sprint 2 đợt 3): hợp (union) mọi rule focus
        // đang bật — gộp khung giờ theo từng thứ, hợp các domain cho phép.
        // Phía app (đóng app ngoài danh sách) do AgentWorker thi hành trực
        // tiếp từ cache rules; file này chỉ mang phía domain cho extension.
        var focusWindows = new Dictionary<string, List<TimeRangeEntry>>(StringComparer.Ordinal);
        var focusDomains = new HashSet<string>(StringComparer.Ordinal);

        IReadOnlyList<Rule> rules = await _outbox.GetCachedRulesAsync(ct);
        foreach (Rule rule in rules)
        {
            if (!rule.Enabled || rule.Type != RuleTypes.Website)
            {
                continue;
            }

            JsonElement config = rule.Config;
            if (config.ValueKind != JsonValueKind.Object)
            {
                _log.Warning("Rule website có config không phải object, bỏ qua.");
                continue;
            }

            string? mode = TryGetString(config, "mode");
            switch (mode)
            {
                case "block_domains":
                    AddRuleDomains(blocked, config);
                    AddRuleUrlPatterns(urlPatterns, config);
                    AddRuleCategories(categoryDomains, config);
                    break;

                case "block_domains_by_time":
                {
                    WarnIfUrlPatternsPresent(config, "block_domains_by_time");
                    WarnIfCategoriesPresent(config, "block_domains_by_time");
                    var domains = new HashSet<string>(StringComparer.Ordinal);
                    AddRuleDomains(domains, config);
                    Dictionary<string, List<TimeRangeEntry>>? windows = ParseWindowsByWeekday(config);
                    if (domains.Count == 0 || windows is null)
                    {
                        _log.Warning("Rule block_domains_by_time thiếu domain hoặc khung giờ hợp lệ, bỏ qua.");
                        break;
                    }

                    file.BlockedByTime.Add(new TimeBlockedEntry
                    {
                        Domains = domains.OrderBy(d => d, StringComparer.Ordinal).ToList(),
                        WindowsByWeekday = windows,
                    });
                    break;
                }

                case "allowlist":
                    WarnIfUrlPatternsPresent(config, "allowlist");
                    WarnIfCategoriesPresent(config, "allowlist");
                    allowlist ??= new HashSet<string>(StringComparer.Ordinal);
                    AddRuleDomains(allowlist, config);
                    break;

                case "allowlist_by_time":
                {
                    WarnIfUrlPatternsPresent(config, "allowlist_by_time");
                    WarnIfCategoriesPresent(config, "allowlist_by_time");
                    var domains = new HashSet<string>(StringComparer.Ordinal);
                    AddRuleDomains(domains, config);
                    Dictionary<string, List<TimeRangeEntry>>? windows = ParseWindowsByWeekday(config);
                    if (domains.Count == 0 || windows is null)
                    {
                        _log.Warning("Rule allowlist_by_time thiếu domain hoặc khung giờ hợp lệ, bỏ qua.");
                        break;
                    }

                    allowlistByTime.Add(new TimeBlockedEntry
                    {
                        Domains = domains.OrderBy(d => d, StringComparer.Ordinal).ToList(),
                        WindowsByWeekday = windows,
                    });
                    break;
                }

                case "domain_time_limit":
                {
                    WarnIfUrlPatternsPresent(config, "domain_time_limit");
                    WarnIfCategoriesPresent(config, "domain_time_limit");
                    int? minutes = TryGetInt32(config, "minutes_per_day") ?? TryGetInt32(config, "minutesPerDay");
                    if (minutes is null || minutes.Value <= 0 || minutes.Value > 1440)
                    {
                        _log.Warning("Rule domain_time_limit thiếu minutes_per_day hợp lệ (1-1440), bỏ qua.");
                        break;
                    }

                    var domains = new HashSet<string>(StringComparer.Ordinal);
                    AddRuleDomains(domains, config);
                    if (domains.Count == 0)
                    {
                        _log.Warning("Rule domain_time_limit không có domain hợp lệ, bỏ qua.");
                        break;
                    }

                    file.DomainLimits.Add(new DomainLimitEntry
                    {
                        Domains = domains.OrderBy(d => d, StringComparer.Ordinal).ToList(),
                        MinutesPerDay = minutes.Value,
                    });
                    break;
                }

                case "safe_search":
                    // Booleans vắng mặt mặc định true: có rule safe_search là
                    // bật cả hai, trừ khi phụ huynh tắt tường minh.
                    safeSearch |= TryGetBoolOrDefault(config, "searchProviders", defaultValue: true);
                    youtubeRestricted |= TryGetBoolOrDefault(config, "youtubeRestricted", defaultValue: true);
                    break;

                case "block_search_keywords":
                    // Kiểm duyệt từ khóa tìm kiếm: rule chỉ mang mảng
                    // keywords; từ khóa hợp vào tập chung, xuất qua
                    // searchGuard sau vòng lặp (null khi tập rỗng).
                    AddRuleSearchKeywords(searchKeywords, config);
                    break;

                case "focus":
                {
                    Dictionary<string, List<TimeRangeEntry>>? windows = ParseWindowsByWeekday(config);
                    if (windows is null)
                    {
                        _log.Warning("Rule focus thiếu khung giờ hợp lệ, bỏ qua.");
                        break;
                    }

                    foreach (KeyValuePair<string, List<TimeRangeEntry>> day in windows)
                    {
                        if (!focusWindows.TryGetValue(day.Key, out List<TimeRangeEntry>? ranges))
                        {
                            ranges = new List<TimeRangeEntry>();
                            focusWindows[day.Key] = ranges;
                        }

                        ranges.AddRange(day.Value);
                    }

                    AddAllowedDomains(focusDomains, config);
                    break;
                }

                default:
                    _log.Warning("Rule website không rõ mode, bỏ qua: " + (mode ?? "(trống)") + ".");
                    break;
            }
        }

        // Danh mục chặn: domain danh mục hợp vào tập chặn chung (extension
        // chặn ở cùng mức ưu tiên như domain gõ tay, không đổi thang DNR),
        // đồng thời xuất riêng theo danh mục để extension hiện đúng lý do
        // trên trang chặn. Thứ tự danh mục chuẩn để chuỗi JSON so sánh ổn
        // định giữa các lần xuất bản.
        Dictionary<string, List<string>>? blockedCategories = null;
        foreach (string categoryId in DomainCategoryLists.OrderedIds)
        {
            if (!categoryDomains.TryGetValue(categoryId, out HashSet<string>? domains) || domains.Count == 0)
            {
                continue;
            }

            foreach (string domain in domains)
            {
                blocked.Add(domain);
            }

            blockedCategories ??= new Dictionary<string, List<string>>(StringComparer.Ordinal);
            blockedCategories[categoryId] = domains.OrderBy(d => d, StringComparer.Ordinal).ToList();
        }

        file.Blocked = blocked.OrderBy(d => d, StringComparer.Ordinal).ToList();
        file.BlockedCategories = blockedCategories;
        // searchGuard: null khi không có rule block_search_keywords nào
        // đang hiệu lực (hoặc mọi từ khóa đều không hợp lệ) — khóa JSON
        // được BỎ HOÀN TOÀN khi null (WhenWritingNull, cùng mẫu
        // blockedCategories) để extension cũ không thấy khóa lạ.
        file.SearchGuard = searchKeywords.Count == 0
            ? null
            : new SearchGuardEntry
            {
                BlockedKeywords = searchKeywords.OrderBy(k => k, StringComparer.Ordinal).ToList(),
            };
        file.UrlPatterns = urlPatterns.Count == 0
            ? null
            : urlPatterns.OrderBy(p => p, StringComparer.Ordinal).ToList();
        file.Allowlist = allowlist is null || allowlist.Count == 0
            ? null
            : allowlist.OrderBy(d => d, StringComparer.Ordinal).ToList();
        file.AllowlistByTime = allowlistByTime.Count == 0 ? null : allowlistByTime;
        file.SafeSearch = safeSearch;
        file.YoutubeRestricted = youtubeRestricted;

        // Focus: null khi không có rule focus hợp lệ nào (không có khung giờ
        // hợp lệ). Danh sách domain cho phép có thể rỗng — nghĩa là trong giờ
        // tập trung không domain nào được phép (chỉ app trong danh sách cho
        // phép mới mở được, do AgentWorker thi hành).
        if (focusWindows.Count > 0)
        {
            file.Focus = new FocusEntry
            {
                WindowsByWeekday = FinalizeFocusWindows(focusWindows),
                AllowedDomains = focusDomains.OrderBy(d => d, StringComparer.Ordinal).ToList(),
            };
        }

        // Ghi đè domain (một hàng theo con, lệnh mới nhất của con đó thắng):
        // chỉ sinh temp entry khi còn hạn (GetActiveOverrideForChildAsync đã
        // lọc hết hạn) và còn ít nhất một domain hợp lệ. Ghi đè giờ giấc
        // không ảnh hưởng file này.
        // Sprint 5: hàng ghi đè thuộc về MỘT con — chỉ tính khi đúng con
        // đang active; chưa biết con nào thì tính cho con mặc định (đường cũ
        // khi activeChildId null) qua GetActiveOverrideForChildAsync.
        TemporaryOverride? activeOverride = await _outbox.GetActiveOverrideForChildAsync(activeChildId ?? defaultChildId, defaultChildId, ct);
        if (activeOverride is not null
            && (activeOverride.Action == OverrideActions.AllowDomain || activeOverride.Action == OverrideActions.BlockDomain)
            && activeOverride.Domains is not null)
        {
            var domains = new HashSet<string>(StringComparer.Ordinal);
            foreach (string raw in activeOverride.Domains)
            {
                string? normalized = NormalizeDomain(raw);
                if (normalized is null)
                {
                    _log.Warning("Domain không hợp lệ trong ghi đè domain, đã bỏ qua: " + TruncateForLog(ToCandidate(raw)));
                    continue;
                }

                domains.Add(normalized);
            }

            if (domains.Count > 0)
            {
                var entry = new TempEntry
                {
                    Domains = domains.OrderBy(d => d, StringComparer.Ordinal).ToList(),
                    ExpiresAt = activeOverride.ExpiresAt.ToString("o", CultureInfo.InvariantCulture),
                };

                if (activeOverride.Action == OverrideActions.AllowDomain)
                {
                    file.TempAllow.Add(entry);
                }
                else
                {
                    file.TempBlock.Add(entry);
                }
            }
        }

        return file;
    }

    /// <summary>Đọc mảng <c>domains</c> trong config rule, chuẩn hóa và thêm vào tập đích.</summary>
    private void AddRuleDomains(HashSet<string> target, JsonElement config)
    {
        if (!config.TryGetProperty("domains", out JsonElement array) || array.ValueKind != JsonValueKind.Array)
        {
            _log.Warning("Rule website thiếu mảng domains, bỏ qua.");
            return;
        }

        foreach (JsonElement element in array.EnumerateArray())
        {
            if (element.ValueKind != JsonValueKind.String)
            {
                _log.Warning("Mục domains không phải chuỗi trong rule website, đã bỏ qua.");
                continue;
            }

            string? raw = element.GetString();
            string? normalized = NormalizeDomain(raw);
            if (normalized is null)
            {
                _log.Warning("Domain không hợp lệ trong rule website, đã bỏ qua: " + TruncateForLog(ToCandidate(raw)));
                continue;
            }

            target.Add(normalized);
        }
    }

    /// <summary>
    /// Đọc mảng <c>keywords</c> trong config rule mode
    /// 'block_search_keywords', chuẩn hóa (trim + chữ thường) và thêm vào
    /// tập đích — tập đích là HashSet nên từ khóa trùng tự bị bỏ. Từ khóa
    /// rỗng sau khi trim bị bỏ qua lặng lẽ (phụ huynh để sót dòng trống);
    /// mục không phải chuỗi hoặc mảng vắng mặt thì ghi Warning như mẫu
    /// <see cref="AddRuleDomains"/>. Không bao giờ ném exception hay làm
    /// hỏng lần xuất bản.
    /// </summary>
    private void AddRuleSearchKeywords(HashSet<string> target, JsonElement config)
    {
        if (!config.TryGetProperty("keywords", out JsonElement array) || array.ValueKind != JsonValueKind.Array)
        {
            _log.Warning("Rule block_search_keywords thiếu mảng keywords, bỏ qua.");
            return;
        }

        foreach (JsonElement element in array.EnumerateArray())
        {
            if (element.ValueKind != JsonValueKind.String)
            {
                _log.Warning("Mục keywords không phải chuỗi trong rule block_search_keywords, đã bỏ qua.");
                continue;
            }

            string? keyword = element.GetString()?.Trim().ToLowerInvariant();
            if (string.IsNullOrEmpty(keyword))
            {
                continue;
            }

            target.Add(keyword);
        }
    }

    /// <summary>
    /// Đọc mảng <c>urlPatterns</c> trong config rule mode 'block_domains',
    /// chuẩn hóa và thêm vào tập đích. Mỗi mẫu là "host/path": host qua
    /// <see cref="NormalizeDomain"/> (chữ thường), path giữ nguyên chữ hoa/
    /// thường như phụ huynh gõ. Khóa vắng mặt hoặc không phải mảng nghĩa là
    /// rule không có mẫu nào (không cảnh báo — hầu hết rule chặn domain chỉ
    /// có <c>domains</c>). Mẫu sai chỉ ghi Warning và bỏ qua, không bao giờ
    /// ném exception hay làm hỏng lần xuất bản.
    /// </summary>
    private void AddRuleUrlPatterns(HashSet<string> target, JsonElement config)
    {
        if (!config.TryGetProperty("urlPatterns", out JsonElement array) || array.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        foreach (JsonElement element in array.EnumerateArray())
        {
            if (element.ValueKind != JsonValueKind.String)
            {
                _log.Warning("Mục urlPatterns không phải chuỗi trong rule website, đã bỏ qua.");
                continue;
            }

            string? raw = element.GetString();
            string? normalized = NormalizeUrlPattern(raw);
            if (normalized is null)
            {
                _log.Warning("Mẫu URL không hợp lệ trong rule website, đã bỏ qua: " + TruncateForLog(raw?.Trim()));
                continue;
            }

            target.Add(normalized);
        }
    }

    /// <summary>
    /// Đọc mảng <c>categories</c> trong config rule mode 'block_domains',
    /// mở rộng mỗi id danh mục thành danh sách domain hạt giống
    /// (<see cref="DomainCategoryLists"/>) và thêm vào tập theo danh mục.
    /// Khóa vắng mặt hoặc không phải mảng nghĩa là rule không chọn danh
    /// mục nào (không cảnh báo — hầu hết rule chặn domain chỉ có
    /// <c>domains</c>). Id lạ chỉ ghi Warning và bỏ qua, không bao giờ
    /// ném exception hay làm hỏng lần xuất bản. Domain hạt giống đã là
    /// hằng hợp lệ nên không chuẩn hóa lại.
    /// </summary>
    private void AddRuleCategories(Dictionary<string, HashSet<string>> target, JsonElement config)
    {
        if (!config.TryGetProperty("categories", out JsonElement array) || array.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        foreach (JsonElement element in array.EnumerateArray())
        {
            if (element.ValueKind != JsonValueKind.String)
            {
                _log.Warning("Mục categories không phải chuỗi trong rule website, đã bỏ qua.");
                continue;
            }

            string? id = element.GetString();
            if (id is null || !DomainCategoryLists.ById.TryGetValue(id, out string[]? domains))
            {
                _log.Warning("Danh mục chặn không rõ trong rule website, đã bỏ qua: " + TruncateForLog(id) + ".");
                continue;
            }

            if (!target.TryGetValue(id, out HashSet<string>? set))
            {
                set = new HashSet<string>(StringComparer.Ordinal);
                target[id] = set;
            }

            foreach (string domain in domains)
            {
                set.Add(domain);
            }
        }
    }

    /// <summary>
    /// Chuẩn hóa một mẫu URL "host/path": bỏ khoảng trắng đầu/cuối, bỏ scheme
    /// http:// hoặc https:// ở đầu, tách ở dấu '/' đầu tiên — host qua
    /// <see cref="NormalizeDomain"/>, path giữ nguyên (bắt đầu bằng '/') trừ
    /// phần query/fragment (bỏ từ '?' hoặc '#') và dấu '/' cuối (bỏ, để
    /// "bing.com/videos/" cũng khớp "/videos"). Trả về null khi thiếu host
    /// hợp lệ hoặc thiếu đường dẫn (kể cả một mình "/" — hãy dùng rule
    /// domain trần cho cả domain). Khớp với chuẩn hóa phía Dashboard.
    /// </summary>
    private static string? NormalizeUrlPattern(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        string value = raw.Trim();
        if (value.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            int schemeEnd = value.IndexOf("://", StringComparison.Ordinal);
            value = value[(schemeEnd + 3)..];
        }

        int slash = value.IndexOf('/');
        if (slash <= 0)
        {
            return null;
        }

        string? host = NormalizeDomain(value[..slash]);
        if (host is null)
        {
            return null;
        }

        string path = value[slash..];
        int cutAt = path.IndexOfAny(new[] { '?', '#' });
        if (cutAt >= 0)
        {
            path = path[..cutAt];
        }

        path = path.TrimEnd('/');
        if (path.Length == 0)
        {
            return null;
        }

        return host + path;
    }

    /// <summary>
    /// Phòng thủ sâu (đợt 4): Agent chỉ thi hành <c>urlPatterns</c> ở mode
    /// <c>block_domains</c>. Các mode website khác mà config vẫn mang mảng
    /// <c>urlPatterns</c> không rỗng (ví dụ sửa tay trong DB) thì ghi Warning
    /// để khoảng trống thi hành hiện rõ trong log thay vì lặng lẽ bỏ qua.
    /// </summary>
    private void WarnIfUrlPatternsPresent(JsonElement config, string mode)
    {
        if (config.TryGetProperty("urlPatterns", out JsonElement array)
            && array.ValueKind == JsonValueKind.Array
            && array.GetArrayLength() > 0)
        {
            _log.Warning("Rule " + mode + " có urlPatterns nhưng Agent chưa thi hành đường dẫn ở mode này, đã bỏ qua các mẫu URL.");
        }
    }

    /// <summary>
    /// Phòng thủ sâu (đợt danh mục): Agent chỉ thi hành <c>categories</c>
    /// ở mode <c>block_domains</c>. Các mode website khác mà config vẫn
    /// mang mảng <c>categories</c> không rỗng (ví dụ sửa tay trong DB) thì
    /// ghi Warning để khoảng trống thi hành hiện rõ trong log thay vì lặng
    /// lẽ bỏ qua — cùng mẫu với <see cref="WarnIfUrlPatternsPresent"/>.
    /// </summary>
    private void WarnIfCategoriesPresent(JsonElement config, string mode)
    {
        if (config.TryGetProperty("categories", out JsonElement array)
            && array.ValueKind == JsonValueKind.Array
            && array.GetArrayLength() > 0)
        {
            _log.Warning("Rule " + mode + " có categories nhưng Agent chưa thi hành danh mục ở mode này, đã bỏ qua các danh mục.");
        }
    }

    /// <summary>Đọc mảng <c>allowedDomains</c> trong config rule focus, chuẩn hóa và thêm vào tập đích.</summary>
    private void AddAllowedDomains(HashSet<string> target, JsonElement config)
    {
        if (!config.TryGetProperty("allowedDomains", out JsonElement array) || array.ValueKind != JsonValueKind.Array)
        {
            _log.Warning("Rule focus thiếu mảng allowedDomains, coi như không có domain nào được phép.");
            return;
        }

        foreach (JsonElement element in array.EnumerateArray())
        {
            if (element.ValueKind != JsonValueKind.String)
            {
                _log.Warning("Mục allowedDomains không phải chuỗi trong rule focus, đã bỏ qua.");
                continue;
            }

            string? raw = element.GetString();
            string? normalized = NormalizeDomain(raw);
            if (normalized is null)
            {
                _log.Warning("Domain không hợp lệ trong rule focus, đã bỏ qua: " + TruncateForLog(ToCandidate(raw)));
                continue;
            }

            target.Add(normalized);
        }
    }

    /// <summary>
    /// Chốt khung giờ focus đã hợp từ nhiều rule: khử trùng lặp từng thứ,
    /// sắp xếp theo giờ bắt đầu, sắp xếp các thứ theo số — để chuỗi JSON so
    /// sánh ổn định giữa các lần xuất bản.
    /// </summary>
    private static Dictionary<string, List<TimeRangeEntry>> FinalizeFocusWindows(
        Dictionary<string, List<TimeRangeEntry>> merged)
    {
        var result = new Dictionary<string, List<TimeRangeEntry>>(StringComparer.Ordinal);
        foreach (KeyValuePair<string, List<TimeRangeEntry>> day in merged
            .OrderBy(pair => int.Parse(pair.Key, CultureInfo.InvariantCulture)))
        {
            result[day.Key] = day.Value
                .GroupBy(range => range.Start + "|" + range.End, StringComparer.Ordinal)
                .Select(group => group.First())
                .OrderBy(range => range.Start, StringComparer.Ordinal)
                .ThenBy(range => range.End, StringComparer.Ordinal)
                .ToList();
        }

        return result;
    }

    /// <summary>
    /// Đọc <c>windowsByWeekday</c> (0 = Chủ nhật..6 = Thứ 7, khớp DayOfWeek và
    /// Date.getDay()). Chỉ giữ khung start &lt; end hợp lệ; ngày không còn
    /// khung nào thì bỏ. Trả về null khi không còn khung hợp lệ nào.
    /// </summary>
    private Dictionary<string, List<TimeRangeEntry>>? ParseWindowsByWeekday(JsonElement config)
    {
        if (!config.TryGetProperty("windowsByWeekday", out JsonElement byWeekday)
            || byWeekday.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var parsed = new Dictionary<string, List<TimeRangeEntry>>();
        foreach (JsonProperty day in byWeekday.EnumerateObject())
        {
            if (!int.TryParse(day.Name, NumberStyles.Integer, CultureInfo.InvariantCulture, out int weekday)
                || weekday < 0 || weekday > 6
                || day.Value.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            var ranges = new List<TimeRangeEntry>();
            foreach (JsonElement range in day.Value.EnumerateArray())
            {
                if (range.ValueKind != JsonValueKind.Object
                    || !TryGetTime(range, "start", out TimeOnly start)
                    || !TryGetTime(range, "end", out TimeOnly end)
                    || start >= end)
                {
                    continue;
                }

                ranges.Add(new TimeRangeEntry
                {
                    Start = start.ToString("HH:mm", CultureInfo.InvariantCulture),
                    End = end.ToString("HH:mm", CultureInfo.InvariantCulture),
                });
            }

            if (ranges.Count > 0)
            {
                parsed[weekday.ToString(CultureInfo.InvariantCulture)] = ranges;
            }
        }

        if (parsed.Count == 0)
        {
            return null;
        }

        // Sắp xếp theo thứ để chuỗi JSON so sánh ổn định giữa các lần xuất bản.
        return parsed
            .OrderBy(pair => int.Parse(pair.Key, CultureInfo.InvariantCulture))
            .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
    }

    /// <summary>
    /// Chuẩn hóa một domain từ config: chữ thường, bỏ scheme (http://...),
    /// bỏ path/query/fragment, bỏ cổng, bỏ dấu chấm đầu/cuối. Trả về null
    /// khi chuỗi rỗng hoặc không đúng dạng domain (xem <see cref="IsValidDomain"/>).
    /// Không bỏ tiền tố "www": www.youtube.com và youtube.com là hai hostname
    /// khác nhau, extension khớp bằng hậu tố nên rule "youtube.com" vẫn chặn
    /// được cả hai.
    /// </summary>
    private static string? NormalizeDomain(string? raw)
    {
        string? candidate = ToCandidate(raw);
        return candidate is not null && IsValidDomain(candidate) ? candidate : null;
    }

    private static string? ToCandidate(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        string value = raw.Trim().ToLowerInvariant();
        int scheme = value.IndexOf("://", StringComparison.Ordinal);
        if (scheme >= 0)
        {
            value = value[(scheme + 3)..];
        }

        int cut = value.IndexOfAny(new[] { '/', '?', '#' });
        if (cut >= 0)
        {
            value = value[..cut];
        }

        int colon = value.IndexOf(':');
        if (colon >= 0)
        {
            value = value[..colon];
        }

        value = value.Trim().Trim('.');
        return value.Length == 0 ? null : value;
    }

    /// <summary>
    /// Domain hợp lệ: dài 1-253 ký tự, ít nhất 2 nhãn, mỗi nhãn 1-63 ký tự
    /// [a-z0-9-], không bắt đầu/kết thúc bằng '-'. Không chấp nhận IP thuần
    /// hay tên một nhãn (localhost): extension khớp theo hậu tố domain.
    /// </summary>
    private static bool IsValidDomain(string candidate)
    {
        if (candidate.Length == 0 || candidate.Length > 253)
        {
            return false;
        }

        string[] labels = candidate.Split('.');
        if (labels.Length < 2)
        {
            return false;
        }

        foreach (string label in labels)
        {
            if (label.Length == 0 || label.Length > 63
                || label.StartsWith('-') || label.EndsWith('-'))
            {
                return false;
            }

            foreach (char c in label)
            {
                bool ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-';
                if (!ok)
                {
                    return false;
                }
            }
        }

        return true;
    }

    private static string TruncateForLog(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return "(trống)";
        }

        return value.Length > 80 ? value[..80] : value;
    }

    private static string? TryGetString(JsonElement config, string property)
    {
        return config.ValueKind == JsonValueKind.Object
            && config.TryGetProperty(property, out JsonElement element)
            && element.ValueKind == JsonValueKind.String
            ? element.GetString()
            : null;
    }

    private static int? TryGetInt32(JsonElement config, string property)
    {
        return config.ValueKind == JsonValueKind.Object
            && config.TryGetProperty(property, out JsonElement element)
            && element.ValueKind == JsonValueKind.Number
            && element.TryGetInt32(out int value)
            ? value
            : null;
    }

    private static bool TryGetBoolOrDefault(JsonElement config, string property, bool defaultValue)
    {
        return config.ValueKind == JsonValueKind.Object
            && config.TryGetProperty(property, out JsonElement element)
            && (element.ValueKind == JsonValueKind.True || element.ValueKind == JsonValueKind.False)
            ? element.GetBoolean()
            : defaultValue;
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

    /// <summary>Tạo thư mục shared và đặt ACL thư mục (best-effort, xem ghi chú ở đầu file).</summary>
    private void EnsureSharedDirectory()
    {
        string directory = SharedDirectory;
        Directory.CreateDirectory(directory);

        try
        {
            // Lưu ý: .NET Core/.NET 8 KHÔNG có Directory.GetAccessControl
            // tĩnh (chỉ có ở .NET Framework) — API chuẩn là extension
            // GetAccessControl/SetAccessControl trên DirectoryInfo/FileInfo
            // (FileSystemAclExtensions, namespace System.IO, package
            // System.Security.AccessControl). Dùng sai sẽ lỗi biên dịch CS0117.
            var directoryInfo = new DirectoryInfo(directory);
            DirectorySecurity security = directoryInfo.GetAccessControl();
            bool changed = false;
            changed |= AddRuleIfMissing(
                security, WellKnownSidType.LocalSystemSid, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit);
            changed |= AddRuleIfMissing(
                security, WellKnownSidType.BuiltinUsersSid, FileSystemRights.Read,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit);
            // WriteData trên thư mục chính là quyền tạo file (CreateFiles):
            // NativeHost ở quyền user cần tạo/ghi web_usage.jsonl. Chỉ áp
            // cho thư mục này, KHÔNG kế thừa xuống file, để domain_rules.json
            // không bị ghi theo.
            changed |= AddRuleIfMissing(
                security, WellKnownSidType.BuiltinUsersSid, FileSystemRights.WriteData,
                InheritanceFlags.None);

            if (changed)
            {
                directoryInfo.SetAccessControl(security);
            }
        }
        catch (Exception ex)
        {
            _log.Warning("Không đặt được ACL cho thư mục shared, dùng ACL mặc định của hệ thống: " + ex.Message);
        }
    }

    /// <summary>Thêm một ACE nếu chưa có rule tương đương (để gọi lặp không nhân đôi ACE).</summary>
    private static bool AddRuleIfMissing(
        DirectorySecurity security,
        WellKnownSidType sidType,
        FileSystemRights rights,
        InheritanceFlags inheritance)
    {
        var sid = new SecurityIdentifier(sidType, null);
        foreach (FileSystemAccessRule existing in security
            .GetAccessRules(includeExplicit: true, includeInherited: false, targetType: typeof(SecurityIdentifier))
            .OfType<FileSystemAccessRule>())
        {
            if (string.Equals(existing.IdentityReference.Value, sid.Value, StringComparison.Ordinal)
                && existing.AccessControlType == AccessControlType.Allow
                && (existing.FileSystemRights & rights) == rights
                && existing.InheritanceFlags == inheritance
                && existing.PropagationFlags == PropagationFlags.None)
            {
                return false;
            }
        }

        security.AddAccessRule(new FileSystemAccessRule(
            sid, rights, inheritance, PropagationFlags.None, AccessControlType.Allow));
        return true;
    }

    /// <summary>
    /// Khóa file domain_rules.json bằng ACL riêng ở cấp file: SYSTEM và
    /// Administrators toàn quyền, Users chỉ đọc, không kế thừa từ thư mục.
    /// Best-effort: thất bại thì ghi log cảnh báo, file vẫn dùng được với
    /// ACL kế thừa từ thư mục shared.
    /// </summary>
    private void EnsureRulesFileAcl(string filePath)
    {
        try
        {
            var fileInfo = new FileInfo(filePath);
            FileSecurity security = fileInfo.GetAccessControl();
            security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);

            // Xóa mọi rule tường minh còn lại để lần xuất bản sau không nhân đôi ACE.
            List<FileSystemAccessRule> existing = security
                .GetAccessRules(includeExplicit: true, includeInherited: false, targetType: typeof(SecurityIdentifier))
                .OfType<FileSystemAccessRule>()
                .ToList();
            foreach (FileSystemAccessRule rule in existing)
            {
                security.RemoveAccessRule(rule);
            }

            security.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                FileSystemRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                FileSystemRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null),
                FileSystemRights.Read, AccessControlType.Allow));
            fileInfo.SetAccessControl(security);
        }
        catch (Exception ex)
        {
            _log.Warning("Không đặt được ACL cho domain_rules.json, dùng ACL kế thừa: " + ex.Message);
        }
    }
}

/// <summary>Nội dung file domain_rules.json. Tên trường JSON khớp extension đọc qua NativeHost.
///
/// THANG ƯU TIÊN DNR PHÍA EXTENSION (extension thi hành; file này chỉ mang
/// dữ liệu, Service không sắp xếp gì thêm): tempBlock 100 &gt; focus 60 &gt;
/// allowlistByTime 55 &gt; allowlist 50 &gt; blockByTime 40 &gt; block 30 &gt;
/// domainLimits 20. Số càng cao càng thắng khi nhiều rule cùng khớp một
/// domain. Ghi đè cho phép tạm thời (tempAllow) không có trong thang này:
/// nó chỉ gỡ chặn trong các rule chặn thường, không xuyên qua focus.
/// </summary>
internal sealed class DomainRulesFile
{
    [JsonPropertyName("version")]
    public int Version { get; set; } = 1;

    [JsonPropertyName("updated_at")]
    public string UpdatedAt { get; set; } = string.Empty;

    [JsonPropertyName("blocked")]
    public List<string> Blocked { get; set; } = new();

    /// <summary>
    /// Domain theo danh mục chặn (đợt danh mục, cộng thêm — Version vẫn
    /// là 1): khóa là id danh mục ("adult", "gambling", "social"), giá
    /// trị là danh sách domain hạt giống của danh mục đó đang được chặn.
    /// Mọi domain ở đây ĐỒNG THỜI nằm trong <see cref="Blocked"/> (cùng
    /// mức ưu tiên chặn 30 phía extension, không đổi thang DNR); trường
    /// này chỉ để extension hiện đúng lý do theo danh mục trên trang
    /// chặn và để tab watcher quyết định cùng lý do. Null = không có
    /// danh mục nào — khóa JSON được BỎ HOÀN TOÀN khi null
    /// (WhenWritingNull, cùng mẫu với urlPatterns) để extension cũ không
    /// thấy khóa lạ (extension cũ vẫn chặn đúng nhờ <see cref="Blocked"/>).
    /// </summary>
    [JsonPropertyName("blockedCategories")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, List<string>>? BlockedCategories { get; set; }

    [JsonPropertyName("blockedByTime")]
    public List<TimeBlockedEntry> BlockedByTime { get; set; } = new();

    /// <summary>
    /// Mẫu URL (batch 4, cộng thêm — Version vẫn là 1): mỗi mẫu là
    /// "host/path" (host chữ thường đã chuẩn hóa, path giữ nguyên như phụ
    /// huynh gõ). Extension chỉ chặn đúng đường dẫn đó, các đường dẫn khác
    /// cùng host vẫn mở được. Null = không có mẫu nào — khóa JSON được BỎ
    /// HOÀN TOÀN khi null (WhenWritingNull, cùng mẫu với allowlistByTime) để
    /// extension cũ không thấy khóa lạ.
    /// </summary>
    [JsonPropertyName("urlPatterns")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? UrlPatterns { get; set; }

    /// <summary>Null = không có chế độ allowlist (chỉ chặn theo danh sách); mảng = chỉ cho phép các domain này.</summary>
    [JsonPropertyName("allowlist")]
    public List<string>? Allowlist { get; set; }

    /// <summary>
    /// Allowlist theo giờ (hợp từ mọi rule website mode 'allowlist_by_time'):
    /// mỗi entry là một rule (domains + khung giờ theo thứ). Null = không có
    /// rule hợp lệ nào — khóa JSON được BỎ HOÀN TOÀN khi null (WhenWritingNull) để
    /// extension cũ không thấy khóa lạ. Hình dạng entry tái dùng
    /// <see cref="TimeBlockedEntry"/> (domains + windowsByWeekday).
    /// </summary>
    [JsonPropertyName("allowlistByTime")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<TimeBlockedEntry>? AllowlistByTime { get; set; }

    [JsonPropertyName("domainLimits")]
    public List<DomainLimitEntry> DomainLimits { get; set; } = new();

    [JsonPropertyName("safeSearch")]
    public bool SafeSearch { get; set; }

    [JsonPropertyName("youtubeRestricted")]
    public bool YoutubeRestricted { get; set; }

    [JsonPropertyName("tempAllow")]
    public List<TempEntry> TempAllow { get; set; } = new();

    [JsonPropertyName("tempBlock")]
    public List<TempEntry> TempBlock { get; set; } = new();

    /// <summary>
    /// Giờ học tập trung (Sprint 2 đợt 3, cộng thêm — Version vẫn là 1):
    /// null = không có rule focus hợp lệ nào. Khi có, extension chỉ cho phép
    /// các domain trong danh sách trong khung giờ tập trung.
    /// </summary>
    [JsonPropertyName("focus")]
    public FocusEntry? Focus { get; set; }

    /// <summary>
    /// Kiểm duyệt từ khóa tìm kiếm (27/11/2026, cộng thêm — Version vẫn
    /// là 1): từ khóa cấm tìm kiếm hợp từ mọi rule website mode
    /// 'block_search_keywords' đang hiệu lực của con đang xét, đã chuẩn
    /// hóa trim + chữ thường + bỏ trùng phía Agent. Null = không có rule
    /// nào của mode này — khóa JSON được BỎ HOÀN TOÀN khi null
    /// (WhenWritingNull, cùng mẫu với <see cref="BlockedCategories"/>)
    /// để extension cũ không thấy khóa lạ. Extension dùng danh sách này
    /// để dựng rule DNR chặn tìm kiếm chứa từ khóa và để tab watcher
    /// đối chiếu dự phòng.
    /// </summary>
    [JsonPropertyName("searchGuard")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public SearchGuardEntry? SearchGuard { get; set; }
}

/// <summary>Kiểm duyệt từ khóa tìm kiếm: danh sách từ khóa cấm (đã chuẩn hóa) cho extension thi hành.</summary>
internal sealed class SearchGuardEntry
{
    [JsonPropertyName("blockedKeywords")]
    public List<string> BlockedKeywords { get; set; } = new();
}

/// <summary>Một mục chặn theo giờ: các domain + khung giờ theo thứ (0 = Chủ nhật..6 = Thứ 7).</summary>
internal sealed class TimeBlockedEntry
{
    [JsonPropertyName("domains")]
    public List<string> Domains { get; set; } = new();

    [JsonPropertyName("windowsByWeekday")]
    public Dictionary<string, List<TimeRangeEntry>> WindowsByWeekday { get; set; } = new();
}

/// <summary>Một mục giới hạn thời gian theo domain: các domain + số phút mỗi ngày.</summary>
internal sealed class DomainLimitEntry
{
    [JsonPropertyName("domains")]
    public List<string> Domains { get; set; } = new();

    [JsonPropertyName("minutesPerDay")]
    public int MinutesPerDay { get; set; }
}

/// <summary>Một mục ghi đè domain tạm thời: các domain + thời điểm hết hạn tuyệt đối (ISO 8601).</summary>
internal sealed class TempEntry
{
    [JsonPropertyName("domains")]
    public List<string> Domains { get; set; } = new();

    [JsonPropertyName("expiresAt")]
    public string ExpiresAt { get; set; } = string.Empty;
}

/// <summary>Một khung giờ trong ngày, dạng "HH:mm".</summary>
internal sealed class TimeRangeEntry
{
    [JsonPropertyName("start")]
    public string Start { get; set; } = string.Empty;

    [JsonPropertyName("end")]
    public string End { get; set; } = string.Empty;
}

/// <summary>Giờ học tập trung đã hợp từ mọi rule focus: khung giờ theo thứ + domain được phép trong giờ đó.</summary>
internal sealed class FocusEntry
{
    [JsonPropertyName("windowsByWeekday")]
    public Dictionary<string, List<TimeRangeEntry>> WindowsByWeekday { get; set; } = new();

    [JsonPropertyName("allowedDomains")]
    public List<string> AllowedDomains { get; set; } = new();
}
