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
    /// </summary>
    public async Task<bool> PublishAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            DomainRulesFile file = await BuildFileAsync(ct);

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
                + file.BlockedByTime.Count + " chặn theo giờ, "
                + (file.Allowlist is null ? "không có allowlist" : file.Allowlist.Count + " domain cho phép") + ", "
                + file.DomainLimits.Count + " giới hạn theo domain, "
                + "tempAllow " + file.TempAllow.Count + ", tempBlock " + file.TempBlock.Count + ".");
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
    /// chuỗi so sánh không đổi giả khi quy tắc không đổi.
    /// </summary>
    private async Task<DomainRulesFile> BuildFileAsync(CancellationToken ct)
    {
        var file = new DomainRulesFile();
        var blocked = new HashSet<string>(StringComparer.Ordinal);
        HashSet<string>? allowlist = null;
        bool safeSearch = false;
        bool youtubeRestricted = false;

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
                    break;

                case "block_domains_by_time":
                {
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
                    allowlist ??= new HashSet<string>(StringComparer.Ordinal);
                    AddRuleDomains(allowlist, config);
                    break;

                case "domain_time_limit":
                {
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

                default:
                    _log.Warning("Rule website không rõ mode, bỏ qua: " + (mode ?? "(trống)") + ".");
                    break;
            }
        }

        file.Blocked = blocked.OrderBy(d => d, StringComparer.Ordinal).ToList();
        file.Allowlist = allowlist is null || allowlist.Count == 0
            ? null
            : allowlist.OrderBy(d => d, StringComparer.Ordinal).ToList();
        file.SafeSearch = safeSearch;
        file.YoutubeRestricted = youtubeRestricted;

        // Ghi đè domain (tối đa 1 hàng, lệnh mới nhất thắng): chỉ sinh temp
        // entry khi còn hạn (GetActiveOverrideAsync đã lọc hết hạn) và còn
        // ít nhất một domain hợp lệ. Ghi đè giờ giấc không ảnh hưởng file này.
        TemporaryOverride? activeOverride = await _outbox.GetActiveOverrideAsync(ct);
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

/// <summary>Nội dung file domain_rules.json. Tên trường JSON khớp extension đọc qua NativeHost.</summary>
internal sealed class DomainRulesFile
{
    [JsonPropertyName("version")]
    public int Version { get; set; } = 1;

    [JsonPropertyName("updated_at")]
    public string UpdatedAt { get; set; } = string.Empty;

    [JsonPropertyName("blocked")]
    public List<string> Blocked { get; set; } = new();

    [JsonPropertyName("blockedByTime")]
    public List<TimeBlockedEntry> BlockedByTime { get; set; } = new();

    /// <summary>Null = không có chế độ allowlist (chỉ chặn theo danh sách); mảng = chỉ cho phép các domain này.</summary>
    [JsonPropertyName("allowlist")]
    public List<string>? Allowlist { get; set; }

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
