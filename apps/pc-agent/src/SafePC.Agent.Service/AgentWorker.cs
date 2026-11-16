using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using Microsoft.Extensions.Hosting;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>
/// Worker chính của Windows Service (chạy quyền SYSTEM).
/// Bốn vòng lặp nền, độc lập với nhau — một vòng lặp lỗi không làm chết các vòng khác:
/// 1. Heartbeat 60s lên server + đồng bộ rules về cache + kiểm tra lệch đồng hồ.
/// 2. Poll commands 15s từ server, thi hành lệnh, ack kết quả về server.
/// 3. Flush usage 5 phút: tổng hợp mẫu foreground theo app, gửi lên server;
///    đồng thời đọc file web_usage.jsonl do NativeHost ghi và đẩy lên server.
/// 4. Kiểm tra rules 15s từ cache local (offline-first): hết giờ thì báo Tray
///    hiện cảnh báo/màn hình khóa qua IPC (Tray đếm ngược 60s rồi khóa phiên).
///
/// Sau mỗi lần đồng bộ rules, khi ghi đè thay đổi (áp dụng/hết hạn/hủy), và
/// lúc khởi động (nếu cache không rỗng), Worker xuất bản lại file
/// domain_rules.json cho extension trình duyệt qua <see cref="DomainRulesPublisher"/>.
///
/// Lệnh lock_now của phụ huynh được lưu bền vững (device_state) nên sống sót
/// qua khởi động lại Service, cho tới khi có lệnh unlock. Khi mất mạng hoặc
/// chưa pairing, Service vẫn thi hành rules trong cache local và giữ usage
/// lại để gửi sau — không bao giờ "đoán" trạng thái từ server.
///
/// Sprint 2 đợt 3: vòng kiểm tra rules còn thi hành quy tắc theo app (đóng
/// app foreground vượt giới hạn/ngoài khung giờ/không thuộc giờ học tập
/// trung, dựa trên báo cáo foreground Tray gửi qua IPC), nghỉ bắt buộc
/// (khóa phiên khi dùng liên tục quá lâu, trạng thái bền vững trong
/// device_state), và báo sự kiện can thiệp (lệch đồng hồ, Service khởi động
/// lại) + heartbeat của extension lên server qua RPC migration 5. Ghi đè mở
/// máy tạm thời (unlock) tạm ngưng cả ba nhóm thi hành này.
/// </summary>
public sealed class AgentWorker : BackgroundService
{
    private readonly LocalLogger _log;
    private readonly OutboxStore _outbox;
    private readonly SupabaseApiClient _api;
    private readonly RuleEngine _ruleEngine;
    private readonly IpcPipeServer _ipc;
    private readonly TokenStore _tokens;
    private readonly DomainRulesPublisher _publisher;
    private readonly ForegroundState _foregroundState;

    // Denylist kill (tên đã chuẩn hóa bằng ExeNames, so khớp không phân biệt
    // hoa thường): tiến trình hệ thống + chính các exe của SafePC — không bao
    // giờ đóng, kể cả khi quy tắc của phụ huynh ghi nhầm tên.
    private static readonly HashSet<string> DenylistedExes = new(StringComparer.OrdinalIgnoreCase)
    {
        "explorer", "taskmgr", "SearchUI", "StartMenuExperienceHost", "TextInputHost",
        "dwm", "csrss", "winlogon", "services", "lsass",
        "SafePC.Agent.Tray", "SafePC.Agent.Service", "SafePC.Agent.NativeHost",
    };

    // Chống spam cảnh báo: mỗi ngưỡng 15/5/1 phút chỉ báo một lần.
    private int _lastWarnBucket;
    private bool _lockSent;

    // Chữ ký ghi đè ở lần kiểm tra rules trước (action + hết hạn + domains):
    // đổi là ghi đè đã áp dụng/hết hạn/bị thay, cần xuất bản lại file domain.
    private string? _lastOverrideSignature;

    // Chống spam log khi không có báo cáo foreground tươi (tối đa 1 lần/15
    // phút) và khi extension vắng mặt (tối đa 1 lần/giờ) — chỉ trong bộ nhớ.
    private DateTimeOffset _lastStaleForegroundLogAt;
    private DateTimeOffset _lastExtensionStaleLogAt;

    // Chống spam log khi từ chối đóng một exe trong denylist (VD: Explorer
    // đang ở foreground trong giờ tập trung): tối đa 1 lần/15 phút mỗi exe.
    private readonly Dictionary<string, DateTimeOffset> _lastDenylistRefusalLogAt = new(StringComparer.OrdinalIgnoreCase);

    // Cảnh báo theo app đã gửi: khóa "loại|exe|ngày-địa-phương", mỗi exe mỗi
    // ngày chỉ cảnh báo một lần cho mỗi loại (limit/window). Key ngày cũ
    // được dọn ở mỗi lần thi hành.
    private readonly HashSet<string> _appWarnedKeys = new(StringComparer.OrdinalIgnoreCase);

    // Cache phân tích rule theo app/focus: chỉ phân tích lại khi chữ ký
    // rules đổi, để không phân tích JSON và ghi log cảnh báo lặp mỗi 15s.
    private string? _appRulesSignature;
    private ParsedAppRules? _parsedAppRules;

    public AgentWorker(
        LocalLogger log,
        OutboxStore outbox,
        SupabaseApiClient api,
        RuleEngine ruleEngine,
        IpcPipeServer ipc,
        TokenStore tokens,
        DomainRulesPublisher publisher,
        ForegroundState foregroundState)
    {
        _log = log;
        _outbox = outbox;
        _api = api;
        _ruleEngine = ruleEngine;
        _ipc = ipc;
        _tokens = tokens;
        _publisher = publisher;
        _foregroundState = foregroundState;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _log.Info("SafePC Agent Service khởi động (phiên bản " + AgentConstants.AgentVersion + ").");

        try
        {
            await _outbox.InitializeAsync(stoppingToken);
        }
        catch (Exception ex)
        {
            _log.Error("Không khởi tạo được SQLite outbox.", ex);
        }

        // Báo Service vừa khởi động lại (tamper event agent_restart, chống
        // spam tối đa 1 lần/giờ qua device_state): phụ huynh thấy được khi
        // Service bị dừng/khởi động lại bất thường. Hàm tự bắt lỗi nên
        // không chặn khởi động khi DB/mạng có vấn đề.
        await PushThrottledTamperEventAsync(
            StateKeys.TamperRestartLastSent,
            "agent_restart",
            JsonSerializer.SerializeToElement(new { agent_version = AgentConstants.AgentVersion }),
            stoppingToken);

        if (!_tokens.HasToken())
        {
            _log.Warning("Chưa có device token (chưa pairing). Ghép nối bằng lệnh: SafePC.Agent.Service.exe pair <mã 6 số>. Heartbeat/poll sẽ chờ.");
        }

        // Xuất bản quy tắc domain lúc khởi động nếu cache không rỗng, để
        // extension có file mới nhất ngay cả khi chưa đồng bộ được lần nào.
        // PublishAsync tự bắt lỗi nên không cần try/catch ở đây.
        try
        {
            IReadOnlyList<Rule> cachedRules = await _outbox.GetCachedRulesAsync(stoppingToken);
            if (cachedRules.Count > 0)
            {
                await _publisher.PublishAsync(stoppingToken);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.Error("Đọc cache rules lúc khởi động lỗi.", ex);
        }

        Task heartbeat = HeartbeatLoopAsync(stoppingToken);
        Task polling = CommandPollLoopAsync(stoppingToken);
        Task flushing = UsageFlushLoopAsync(stoppingToken);
        Task ruleCheck = RuleCheckLoopAsync(stoppingToken);

        await Task.WhenAll(heartbeat, polling, flushing, ruleCheck);
        _log.Info("SafePC Agent Service dừng.");
    }

    private async Task HeartbeatLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                HeartbeatResult? result = await _api.SendHeartbeatAsync(_lockSent ? "locked" : "online", ct);
                if (result is not null)
                {
                    // Chống chỉnh đồng hồ (docs/02-ARCHITECTURE.md mục 4.4):
                    // so sánh giờ máy với giờ server; lệch quá 5 phút thì ghi
                    // log cảnh báo và báo phụ huynh bằng tamper event
                    // clock_drift (tối đa 1 lần/giờ). Engine vẫn thi hành
                    // theo giờ máy + cache rules khi mất mạng.
                    TimeSpan drift = result.ServerTime - DateTimeOffset.UtcNow;
                    if (Math.Abs(drift.TotalMinutes) > 5)
                    {
                        _log.Warning("Đồng hồ máy lệch " + drift.TotalMinutes.ToString("F1", CultureInfo.InvariantCulture) + " phút so với giờ server (ngưỡng 5 phút).");
                        await PushThrottledTamperEventAsync(
                            StateKeys.TamperClockDriftLastSent,
                            "clock_drift",
                            JsonSerializer.SerializeToElement(new { drift_minutes = Math.Round(drift.TotalMinutes, 1) }),
                            ct);
                    }

                    await RefreshRulesAsync(ct);

                    // Kiểm tra extension còn sống (chỉ sau khi heartbeat
                    // thành công — máy offline thì không kết luận gì về
                    // extension): đọc file heartbeat NativeHost ghi, báo lên
                    // server tối đa 1 lần/5 phút.
                    await CheckExtensionHeartbeatAsync(ct);
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _log.Error("Heartbeat lỗi.", ex);
            }

            if (!await WaitAsync(AgentConstants.HeartbeatInterval, ct))
            {
                break;
            }
        }
    }

    /// <summary>
    /// Đồng bộ rules từ server về cache local. Lỗi mạng hoặc chưa pairing
    /// (FetchRulesAsync trả về null) thì giữ nguyên cache cũ — KHÔNG xóa
    /// cache, vì đó là đường thi hành duy nhất khi offline.
    /// </summary>
    private async Task RefreshRulesAsync(CancellationToken ct)
    {
        IReadOnlyList<Rule>? rules = await _api.FetchRulesAsync(ct);
        if (rules is null)
        {
            return;
        }

        int before = (await _outbox.GetCachedRulesAsync(ct)).Count;
        await _outbox.SaveRulesAsync(rules, ct);
        if (rules.Count != before)
        {
            _log.Info("Đã đồng bộ rules từ server: " + rules.Count + " rules (trước đó " + before + ").");
        }

        // Rules mới có thể đổi quy tắc website: xuất bản lại file domain
        // (publisher tự bỏ qua khi nội dung website không đổi).
        await _publisher.PublishAsync(ct);
    }

    private async Task CommandPollLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                IReadOnlyList<Command> commands = await _api.PollCommandsAsync(ct);
                foreach (Command command in commands)
                {
                    // Mỗi lệnh xử lý độc lập: một lệnh lỗi không chặn các
                    // lệnh sau, và kết quả luôn được ack về server để phụ
                    // huynh biết lệnh đã tới máy hay chưa.
                    bool ok;
                    try
                    {
                        ok = await ExecuteCommandAsync(command, ct);
                    }
                    catch (Exception ex)
                    {
                        _log.Error("Thi hành command " + command.Id + " lỗi.", ex);
                        ok = false;
                    }

                    try
                    {
                        await _api.AckCommandAsync(command.Id, ok ? "done" : "failed", ct);
                    }
                    catch (Exception ex)
                    {
                        _log.Error("Ack command " + command.Id + " lỗi.", ex);
                    }
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _log.Error("Poll commands lỗi.", ex);
            }

            if (!await WaitAsync(AgentConstants.CommandPollInterval, ct))
            {
                break;
            }
        }
    }

    private async Task UsageFlushLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await _outbox.PruneOldSamplesAsync(TimeSpan.FromDays(7), ct);

                DateTimeOffset since = await GetUsageWatermarkAsync(ct);
                IReadOnlyList<UsageSummary> summary = await _outbox.GetUsageSummaryAsync(since, ct);
                DeviceCredentials? creds = summary.Count > 0 ? _tokens.TryLoadCredentials() : null;
                if (creds is not null)
                {
                    var records = new List<UsageRecord>(summary.Count);
                    foreach (UsageSummary item in summary)
                    {
                        records.Add(new UsageRecord
                        {
                            DeviceId = creds.DeviceId,
                            AppName = item.AppName,
                            ExePathHash = item.ExePathHash,
                            StartedAt = item.FirstSampledAt,
                            DurationSec = (int)(item.SampleCount * AgentConstants.ForegroundSampleInterval.TotalSeconds),
                        });
                    }

                    // family_id/child_id trong record để trống: server suy ra
                    // từ device đã xác thực, client không gửi các trường đó.
                    if (await _api.SendUsageBatchAsync(records, ct))
                    {
                        DateTimeOffset watermark = summary.Max(s => s.LastSampledAt);
                        await _outbox.SetStateAsync(StateKeys.UsagePushedUntil, watermark.ToString("o", CultureInfo.InvariantCulture), ct);
                        _log.Info("Đã gửi usage lên server: " + records.Count + " nhóm app.");
                    }
                }

                // Cùng chu kỳ 5 phút: đẩy lượt thăm web do extension ghi qua
                // NativeHost. Lỗi trong này không được chặn chu kỳ sau.
                await FlushWebUsageAsync(ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _log.Error("Flush usage lỗi.", ex);
            }

            if (!await WaitAsync(AgentConstants.UsageBatchInterval, ct))
            {
                break;
            }
        }
    }

    /// <summary>Watermark đẩy usage: thời điểm mẫu mới nhất đã gửi. Chưa gửi lần nào thì từ đầu.</summary>
    private async Task<DateTimeOffset> GetUsageWatermarkAsync(CancellationToken ct)
    {
        string? stored = await _outbox.GetStateAsync(StateKeys.UsagePushedUntil, ct);
        if (stored is not null
            && DateTimeOffset.TryParse(stored, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset watermark))
        {
            return watermark;
        }

        return DateTimeOffset.MinValue;
    }

    /// <summary>Trần kích thước file web_usage.jsonl: vượt trần thì bỏ dòng cũ nhất.</summary>
    private const int WebUsageMaxBytes = 5 * 1024 * 1024;

    /// <summary>
    /// Đẩy lượt thăm web lên server từ file JSONL do NativeHost ghi
    /// (<c>%ProgramData%\SafePC\shared\web_usage.jsonl</c>). Mỗi dòng là một
    /// JSON {domain, startedAt, durationSec} — chỉ domain, không URL/path/
    /// query. File chỉ bị cắt khi gửi thành công toàn bộ; gửi lỗi thì giữ
    /// nguyên để chu kỳ sau gửi lại. Dòng dở cuối file (NativeHost đang ghi
    /// dở, chưa có newline) không được tiêu thụ.
    /// </summary>
    private async Task FlushWebUsageAsync(CancellationToken ct)
    {
        string path = DomainRulesPublisher.WebUsageFilePath;
        if (!File.Exists(path))
        {
            return;
        }

        byte[] snapshot;
        try
        {
            await using FileStream stream = new(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var memory = new MemoryStream();
            await stream.CopyToAsync(memory, ct);
            snapshot = memory.ToArray();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.Error("Không đọc được file web_usage.jsonl, để lại chu kỳ sau.", ex);
            return;
        }

        if (snapshot.Length == 0)
        {
            return;
        }

        // Chỉ tiêu thụ tới cuối dòng hoàn chỉnh cuối cùng: phần cuối chưa có
        // '\n' có thể là dòng NativeHost đang ghi dở — để lại chu kỳ sau.
        int consumedLength = LastNewlineOffset(snapshot) + 1;
        if (consumedLength == 0)
        {
            // File chỉ có một dòng dở không có newline. Nếu đã vượt trần 5MB
            // thì dòng đó là rác: cắt cả file để không kẹt mãi.
            if (snapshot.Length > WebUsageMaxBytes)
            {
                _log.Warning("File web_usage.jsonl vượt 5MB mà không có dòng hoàn chỉnh nào, cắt bỏ.");
                await RewriteWebUsageFileAsync(path, Array.Empty<byte>(), ct);
            }

            return;
        }

        List<string> lines = SplitCompleteLines(snapshot, consumedLength);

        // Trần 5MB: bỏ các dòng cũ nhất (mất dữ liệu cũ, có log cảnh báo) để
        // file không phình vô hạn khi mất mạng dài ngày.
        int droppedForCap = 0;
        int bytesEstimate = lines.Sum(line => Encoding.UTF8.GetByteCount(line) + 1);
        while (lines.Count > 0 && bytesEstimate > WebUsageMaxBytes)
        {
            bytesEstimate -= Encoding.UTF8.GetByteCount(lines[0]) + 1;
            lines.RemoveAt(0);
            droppedForCap++;
        }

        if (droppedForCap > 0)
        {
            _log.Warning("File web_usage.jsonl vượt 5MB, đã bỏ " + droppedForCap + " dòng cũ nhất.");
        }

        var visits = new List<WebVisitRecord>(lines.Count);
        int invalid = 0;
        foreach (string line in lines)
        {
            WebVisitRecord? visit = TryParseWebUsageLine(line);
            if (visit is null)
            {
                invalid++;
            }
            else
            {
                visits.Add(visit);
            }
        }

        if (invalid > 0)
        {
            _log.Warning("Bỏ qua " + invalid + " dòng web_usage.jsonl không hợp lệ.");
        }

        if (visits.Count == 0)
        {
            // Toàn dòng rác: cắt phần đã tiêu thụ để không thử lại mãi.
            await TruncateConsumedWebUsageAsync(path, consumedLength, ct);
            return;
        }

        // RPC giới hạn 500 dòng/batch: chia nhỏ, batch nào lỗi thì dừng và
        // giữ nguyên file để chu kỳ sau gửi lại từ đầu.
        const int batchSize = 500;
        for (int i = 0; i < visits.Count; i += batchSize)
        {
            IReadOnlyList<WebVisitRecord> batch = visits.Skip(i).Take(batchSize).ToList();
            if (!await _api.SendWebVisitsAsync(batch, ct))
            {
                _log.Warning("Gửi web visits lỗi, giữ file lại để chu kỳ sau gửi lại.");
                return;
            }
        }

        await TruncateConsumedWebUsageAsync(path, consumedLength, ct);
        _log.Info("Đã gửi web usage lên server: " + visits.Count + " lượt thăm.");
    }

    /// <summary>Vị trí byte của '\n' cuối cùng, hoặc -1 khi không có dòng hoàn chỉnh nào.</summary>
    private static int LastNewlineOffset(byte[] bytes)
    {
        for (int i = bytes.Length - 1; i >= 0; i--)
        {
            if (bytes[i] == (byte)'\n')
            {
                return i;
            }
        }

        return -1;
    }

    /// <summary>Tách vùng byte đã tiêu thụ thành các dòng, bỏ dòng rỗng và '\r' cuối dòng.</summary>
    private static List<string> SplitCompleteLines(byte[] snapshot, int consumedLength)
    {
        string text = Encoding.UTF8.GetString(snapshot, 0, consumedLength);
        string[] parts = text.Split('\n');
        var lines = new List<string>(parts.Length);
        foreach (string part in parts)
        {
            string line = part.TrimEnd('\r');
            if (line.Length > 0)
            {
                lines.Add(line);
            }
        }

        return lines;
    }

    /// <summary>
    /// Cắt phần đã tiêu thụ khỏi file web_usage.jsonl, giữ lại phần sau vị
    /// trí đã tiêu thụ (dòng dở cuối snapshot + dòng NativeHost ghi thêm
    /// trong lúc upload). Vẫn còn một cửa sổ đua hẹp nếu NativeHost ghi thêm
    /// đúng lúc cắt file — dữ liệu usage là best-effort nên chấp nhận.
    /// </summary>
    private async Task TruncateConsumedWebUsageAsync(string path, int consumedLength, CancellationToken ct)
    {
        byte[] suffix;
        try
        {
            await using FileStream stream = new(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            if (stream.Length <= consumedLength)
            {
                suffix = Array.Empty<byte>();
            }
            else
            {
                suffix = new byte[stream.Length - consumedLength];
                stream.Seek(consumedLength, SeekOrigin.Begin);
                int read = 0;
                while (read < suffix.Length)
                {
                    int n = await stream.ReadAsync(suffix.AsMemory(read), ct);
                    if (n == 0)
                    {
                        break;
                    }

                    read += n;
                }

                if (read < suffix.Length)
                {
                    Array.Resize(ref suffix, read);
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.Error("Không đọc được phần còn lại của web_usage.jsonl sau khi gửi, giữ nguyên file.", ex);
            return;
        }

        await RewriteWebUsageFileAsync(path, suffix, ct);
    }

    private async Task RewriteWebUsageFileAsync(string path, byte[] content, CancellationToken ct)
    {
        try
        {
            await using FileStream stream = new(path, FileMode.Create, FileAccess.Write, FileShare.ReadWrite);
            await stream.WriteAsync(content, ct);
            await stream.FlushAsync(ct);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.Error("Không cắt được file web_usage.jsonl sau khi gửi.", ex);
        }
    }

    /// <summary>
    /// Phân tích một dòng JSONL {domain, startedAt, durationSec}. Trả về null
    /// khi thiếu/sai trường. Domain phải dài 1-253 ký tự, không chứa khoảng
    /// trắng, '/', '?' hay '#'; thời lượng kẹp về 0..86400 (khớp RPC).
    /// Không log giá trị domain — chỉ đếm dòng lỗi ở nơi gọi.
    /// </summary>
    private static WebVisitRecord? TryParseWebUsageLine(string line)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(line);
        }
        catch (JsonException)
        {
            return null;
        }

        using (document)
        {
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            if (!root.TryGetProperty("domain", out JsonElement domainElement)
                || domainElement.ValueKind != JsonValueKind.String
                || domainElement.GetString() is not string rawDomain)
            {
                return null;
            }

            string domain = rawDomain.Trim().ToLowerInvariant();
            if (!IsValidWebUsageDomain(domain))
            {
                return null;
            }

            if (!root.TryGetProperty("startedAt", out JsonElement startedElement)
                || startedElement.ValueKind != JsonValueKind.String
                || startedElement.GetString() is not string startedText
                || !DateTimeOffset.TryParse(startedText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset visitedAt))
            {
                return null;
            }

            if (!root.TryGetProperty("durationSec", out JsonElement durationElement)
                || durationElement.ValueKind != JsonValueKind.Number)
            {
                return null;
            }

            double seconds;
            if (durationElement.TryGetInt32(out int intSeconds))
            {
                seconds = intSeconds;
            }
            else if (durationElement.TryGetDouble(out double doubleSeconds))
            {
                seconds = doubleSeconds;
            }
            else
            {
                return null;
            }

            int durationSec = (int)Math.Clamp(Math.Truncate(seconds), 0, 86400);
            return new WebVisitRecord { Domain = domain, VisitedAt = visitedAt, DurationSec = durationSec };
        }
    }

    private static bool IsValidWebUsageDomain(string domain)
    {
        if (domain.Length == 0 || domain.Length > 253)
        {
            return false;
        }

        foreach (char c in domain)
        {
            if (char.IsWhiteSpace(c) || char.IsControl(c) || c == '/' || c == '?' || c == '#')
            {
                return false;
            }
        }

        return true;
    }

    private async Task RuleCheckLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                IReadOnlyList<Rule> rules = await _outbox.GetCachedRulesAsync(ct);
                TimeSpan usedToday = await _outbox.GetUsageTodayAsync(ct);

                // Đọc ghi đè tạm thời ở mỗi lần kiểm tra: hết hạn thì tự
                // vô hiệu (kể cả sau khi Service khởi động lại), không cần
                // lệnh hủy riêng. RuleEngine kiểm tra lại hết hạn một lần nữa.
                TemporaryOverride? activeOverride = await _outbox.GetActiveOverrideAsync(ct);
                DateTimeOffset now = DateTimeOffset.Now;

                // Ghi đè đổi (áp dụng/hết hạn/bị thay) thì xuất bản lại file
                // domain: GetActiveOverrideAsync xóa hàng hết hạn khi đọc,
                // nên lần kiểm tra đầu tiên sau khi hết hạn sẽ thấy chữ ký
                // đổi sang "(none)" và temp entry được gỡ khỏi file trong
                // vòng 15 giây. Publisher tự bỏ qua khi nội dung không đổi
                // (ghi đè giờ giấc không ảnh hưởng file domain).
                string overrideSignature = activeOverride is null
                    ? "(none)"
                    : activeOverride.Action + "|" + activeOverride.ExpiresAt.ToString("o", CultureInfo.InvariantCulture)
                        + "|" + string.Join(",", activeOverride.Domains ?? Array.Empty<string>());
                if (overrideSignature != _lastOverrideSignature)
                {
                    _lastOverrideSignature = overrideSignature;
                    await _publisher.PublishAsync(ct);
                }

                bool forcedLock = await _outbox.GetStateAsync(StateKeys.ForcedLock, ct) is not null;
                RuleDecision decision = _ruleEngine.Evaluate(rules, usedToday, now, foregroundAppName: null, activeOverride, forcedLock: forcedLock);

                // Ghi đè mở máy tạm thời (unlock) nghĩa là "máy được dùng":
                // bỏ qua cả nghỉ bắt buộc lẫn thi hành theo app/focus trong
                // lúc ghi đè còn hạn (cùng điều kiện RuleEngine dùng để mở máy).
                bool unlockOverride = activeOverride is not null
                    && activeOverride.ExpiresAt > now
                    && activeOverride.Action == OverrideActions.Unlock;

                ParsedAppRules parsedAppRules = GetParsedAppRules(rules);

                // Nghỉ bắt buộc được đánh giá TRƯỚC switch: đang trong giờ
                // nghỉ thì ép quyết định thành khóa; hết giờ nghỉ thì dọn
                // trạng thái rồi đánh giá bình thường.
                bool breakActive = false;
                if (!unlockOverride)
                {
                    breakActive = await EvaluateForcedBreakAsync(parsedAppRules, now, ct);
                }

                if (breakActive)
                {
                    decision = new RuleDecision(RuleDecisionKind.Lock, "Đến giờ nghỉ bắt buộc", 0);
                }

                switch (decision.Kind)
                {
                    case RuleDecisionKind.Allowed:
                        _lastWarnBucket = 0;
                        if (_lockSent)
                        {
                            // Chuyển từ khóa sang cho phép (hết giờ ngủ, hết
                            // khung cấm, ghi đè hết hạn...): báo Tray đóng
                            // màn hình khóa, nếu không cửa sổ khóa sẽ ở lại
                            // dù rules đã cho phép.
                            _lockSent = false;
                            _log.Info("Hết điều kiện khóa. Báo Tray đóng màn hình khóa.");
                            await _ipc.SendToTrayAsync(IpcMessage.Create(IpcMessageTypes.Unlock, new { }), ct);
                        }
                        break;

                    case RuleDecisionKind.Warn:
                        int bucket = decision.MinutesLeft <= 1 ? 1 : decision.MinutesLeft <= 5 ? 5 : 15;
                        if (bucket != _lastWarnBucket)
                        {
                            _lastWarnBucket = bucket;
                            _log.Info("Sắp hết giờ, còn " + decision.MinutesLeft + " phút. Báo Tray hiện cảnh báo.");
                            await _ipc.SendToTrayAsync(
                                IpcMessage.Create(IpcMessageTypes.Warning, new WarningPayload(decision.MinutesLeft, decision.Reason)), ct);
                        }
                        break;

                    case RuleDecisionKind.Lock:
                        bool firstLock = !_lockSent;
                        _lockSent = true;
                        if (firstLock || breakActive)
                        {
                            // Giờ nghỉ bắt buộc nhắc lại lệnh khóa ở MỌI lần
                            // kiểm tra (kể cả khi đã gửi rồi), để con đăng
                            // nhập lại sớm thì Tray khóa lại ngay qua
                            // ReassertLock. Lần nhắc lại không ghi log để
                            // khỏi lấp đầy file log mỗi 15 giây.
                            if (firstLock)
                            {
                                _log.Info("Hết giờ (" + decision.Reason + "). Báo Tray hiện màn hình khóa.");
                            }

                            await _ipc.SendToTrayAsync(
                                IpcMessage.Create(IpcMessageTypes.Lock, new LockPayload(decision.Reason)), ct);
                        }
                        break;
                }

                // Thi hành theo app/focus SAU switch quyết định giờ giấc:
                // không có rule app/focus nào thì hàm tự bỏ qua ngay.
                if (!unlockOverride)
                {
                    await EnforceAppRulesAsync(parsedAppRules, now, ct);
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _log.Error("Kiểm tra rules lỗi.", ex);
            }

            if (!await WaitAsync(AgentConstants.ForegroundSampleInterval, ct))
            {
                break;
            }
        }
    }

    /// <summary>
    /// Gửi một tamper event lên server, tối đa 1 lần/giờ cho mỗi loại (mốc
    /// lần gửi lưu bền vững trong device_state để sống sót qua khởi động
    /// lại). Chỉ ghi mốc khi gửi thành công — gửi lỗi thì lần sau thử lại.
    /// Tự bắt mọi lỗi (trừ hủy) để không chặn vòng lặp gọi.
    /// </summary>
    private async Task PushThrottledTamperEventAsync(string stateKey, string eventType, JsonElement details, CancellationToken ct)
    {
        try
        {
            string? lastSentText = await _outbox.GetStateAsync(stateKey, ct);
            if (lastSentText is not null
                && DateTimeOffset.TryParse(lastSentText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset lastSent)
                && DateTimeOffset.UtcNow - lastSent < TimeSpan.FromHours(1))
            {
                return;
            }

            if (await _api.PushTamperEventAsync(eventType, details, ct))
            {
                await _outbox.SetStateAsync(stateKey, DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture), ct);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.Error("Gửi tamper event " + eventType + " lỗi.", ex);
        }
    }

    /// <summary>
    /// Kiểm tra extension trình duyệt còn sống qua file heartbeat NativeHost
    /// ghi. Chỉ gọi sau khi heartbeat thành công (máy đang online). Timestamp
    /// mới (&lt; 5 phút) thì báo lên server, tối đa 1 lần/5 phút. File thiếu/
    /// hỏng/cũ hơn 15 phút thì chỉ ghi log cảnh báo (tối đa 1 lần/giờ, trong
    /// bộ nhớ) — KHÔNG đẩy tamper event: Dashboard hiển thị độ cũ từ cột
    /// last_extension_seen_at. Khoảng 5-15 phút là vùng xám, không làm gì.
    /// </summary>
    private async Task CheckExtensionHeartbeatAsync(CancellationToken ct)
    {
        DateTimeOffset? seenAt = await ReadExtensionHeartbeatAsync(ct);
        DateTimeOffset now = DateTimeOffset.UtcNow;

        if (seenAt is not null && now - seenAt.Value < TimeSpan.FromMinutes(5))
        {
            string? lastText = await _outbox.GetStateAsync(StateKeys.ExtensionHeartbeatLastReported, ct);
            bool due = lastText is null
                || !DateTimeOffset.TryParse(lastText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset last)
                || now - last >= TimeSpan.FromMinutes(5);
            if (due && await _api.ReportExtensionHeartbeatAsync(seenAt.Value, ct))
            {
                await _outbox.SetStateAsync(StateKeys.ExtensionHeartbeatLastReported, now.ToString("o", CultureInfo.InvariantCulture), ct);
            }

            return;
        }

        bool stale = seenAt is null || now - seenAt.Value > TimeSpan.FromMinutes(15);
        if (stale && now - _lastExtensionStaleLogAt >= TimeSpan.FromHours(1))
        {
            _lastExtensionStaleLogAt = now;
            _log.Warning("Không thấy dấu hiệu extension trình duyệt trong hơn 15 phút (file extension_heartbeat.txt thiếu hoặc đã cũ).");
        }
    }

    /// <summary>Đọc timestamp UTC trong file extension_heartbeat.txt. Null khi file thiếu, đọc lỗi hoặc timestamp hỏng.</summary>
    private async Task<DateTimeOffset?> ReadExtensionHeartbeatAsync(CancellationToken ct)
    {
        string path = DomainRulesPublisher.ExtensionHeartbeatFilePath;
        try
        {
            if (!File.Exists(path))
            {
                return null;
            }

            string text = await File.ReadAllTextAsync(path, ct);
            if (DateTimeOffset.TryParse(text.Trim(), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset seenAt))
            {
                return seenAt;
            }

            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.Warning("Không đọc được file extension_heartbeat.txt: " + ex.Message);
            return null;
        }
    }

    /// <summary>
    /// Phân tích rule theo app/focus từ cache, có cache theo chữ ký (id +
    /// enabled + config thô của rule app/website): rules không đổi thì trả
    /// kết quả cũ, tránh phân tích JSON mỗi 15 giây.
    /// </summary>
    private ParsedAppRules GetParsedAppRules(IReadOnlyList<Rule> rules)
    {
        var signature = new StringBuilder();
        foreach (Rule rule in rules)
        {
            if (rule.Type != RuleTypes.App && rule.Type != RuleTypes.Website)
            {
                continue;
            }

            signature.Append(rule.Id).Append('|').Append(rule.Enabled ? '1' : '0').Append('|')
                .Append(rule.Type).Append('|').Append(rule.Config.GetRawText()).Append('\n');
        }

        string key = signature.ToString();
        if (key == _appRulesSignature && _parsedAppRules is not null)
        {
            return _parsedAppRules;
        }

        _parsedAppRules = AppRuleParser.Parse(rules, _log);
        _appRulesSignature = key;
        return _parsedAppRules;
    }

    /// <summary>
    /// Đánh giá nghỉ bắt buộc. Trả về true khi đang trong giờ nghỉ (kể cả giờ
    /// nghỉ vừa bắt đầu ở lần này). Trạng thái bền vững trong device_state:
    /// <c>BreakEndsAt</c> là thời điểm kết thúc giờ nghỉ; khi hết giờ nghỉ thì
    /// xóa nó và đặt <c>BreakStreakFloor</c> bằng thời điểm kết thúc, để mẫu
    /// trong giờ nghỉ không gây nghỉ lại ngay. Không có rule forced_break thì
    /// không làm gì. Trong giờ nghỉ thì bỏ qua đánh giá streak (mẫu lúc đó
    /// được sàn loại bỏ sau khi nghỉ xong).
    /// </summary>
    private async Task<bool> EvaluateForcedBreakAsync(ParsedAppRules parsed, DateTimeOffset now, CancellationToken ct)
    {
        string? endsAtText = await _outbox.GetStateAsync(StateKeys.BreakEndsAt, ct);
        if (endsAtText is not null)
        {
            if (DateTimeOffset.TryParse(endsAtText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset endsAt))
            {
                if (now < endsAt)
                {
                    return true;
                }

                await _outbox.DeleteStateAsync(StateKeys.BreakEndsAt, ct);
                await _outbox.SetStateAsync(StateKeys.BreakStreakFloor, endsAt.ToString("o", CultureInfo.InvariantCulture), ct);
                _log.Info("Hết giờ nghỉ bắt buộc.");
            }
            else
            {
                // Giá trị hỏng: xóa để không kẹt ở trạng thái nghỉ mãi.
                await _outbox.DeleteStateAsync(StateKeys.BreakEndsAt, ct);
            }
        }

        ForcedBreakConfig? config = parsed.BreakConfig;
        if (config is null)
        {
            return false;
        }

        string? floorText = await _outbox.GetStateAsync(StateKeys.BreakStreakFloor, ct);
        DateTimeOffset floor = DateTimeOffset.MinValue;
        if (floorText is not null)
        {
            DateTimeOffset.TryParse(floorText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out floor);
        }

        DateTimeOffset windowStart = now.AddMinutes(-config.WorkMinutes - 10);
        if (floor > windowStart)
        {
            windowStart = floor;
        }

        IReadOnlyList<DateTimeOffset> samples = await _outbox.GetSampleTimesSinceAsync(windowStart, ct);
        TimeSpan streak = ComputeUsageStreak(samples, now);
        if (streak < TimeSpan.FromMinutes(config.WorkMinutes))
        {
            return false;
        }

        DateTimeOffset breakEnd = now.AddMinutes(config.BreakMinutes);
        await _outbox.SetStateAsync(StateKeys.BreakEndsAt, breakEnd.ToString("o", CultureInfo.InvariantCulture), ct);
        _log.Info("Bắt đầu nghỉ bắt buộc " + config.BreakMinutes + " phút sau " + config.WorkMinutes + " phút dùng liên tục.");
        return true;
    }

    /// <summary>
    /// Chuỗi dùng liên tục từ các thời điểm mẫu (đã sắp xếp tăng dần, nhịp
    /// 15 giây): khoảng trống &gt; 3 phút thì chuỗi đứt; mẫu mới nhất cũ hơn
    /// 3 phút nghĩa là đang idle, chuỗi = 0. Mẫu mới nhất đại diện cho thêm
    /// 15 giây (cùng cách đếm của <see cref="OutboxStore.GetUsageTodayAsync"/>).
    /// </summary>
    private static TimeSpan ComputeUsageStreak(IReadOnlyList<DateTimeOffset> sampleTimes, DateTimeOffset now)
    {
        if (sampleTimes.Count == 0)
        {
            return TimeSpan.Zero;
        }

        DateTimeOffset newest = sampleTimes[sampleTimes.Count - 1];
        if (now - newest > TimeSpan.FromMinutes(3))
        {
            return TimeSpan.Zero;
        }

        DateTimeOffset streakStart = newest;
        for (int i = sampleTimes.Count - 1; i > 0; i--)
        {
            if (sampleTimes[i] - sampleTimes[i - 1] > TimeSpan.FromMinutes(3))
            {
                break;
            }

            streakStart = sampleTimes[i - 1];
        }

        return (newest - streakStart) + AgentConstants.ForegroundSampleInterval;
    }

    /// <summary>
    /// Thi hành quy tắc theo app và giờ học tập trung cho mọi session có báo
    /// cáo foreground tươi. Không có rule nào thì bỏ qua ngay. Không có báo
    /// cáo tươi thì KHÔNG kill (fail-open: không biết foreground là gì), chỉ
    /// ghi log chống spam. Nơi gọi đã loại trường hợp ghi đè unlock.
    /// </summary>
    private async Task EnforceAppRulesAsync(ParsedAppRules parsed, DateTimeOffset now, CancellationToken ct)
    {
        if (!parsed.HasAny)
        {
            return;
        }

        IReadOnlyList<ForegroundReport> reports = _foregroundState.TryGetFreshReports(TimeSpan.FromSeconds(90));
        if (reports.Count == 0)
        {
            if (DateTimeOffset.UtcNow - _lastStaleForegroundLogAt >= TimeSpan.FromMinutes(15))
            {
                _lastStaleForegroundLogAt = DateTimeOffset.UtcNow;
                _log.Warning("Không có báo cáo foreground tươi, bỏ qua thi hành quy tắc theo app kỳ này.");
            }

            return;
        }

        IReadOnlyDictionary<string, TimeSpan> usageByApp = await _outbox.GetUsageByAppTodayAsync(ct);
        Dictionary<string, TimeSpan> normalizedUsage = NormalizeUsageByApp(usageByApp);
        DateTime local = now.LocalDateTime;
        string todayKey = local.Date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        // Dọn key cảnh báo của ngày cũ để HashSet không phình vô hạn.
        _appWarnedKeys.RemoveWhere(key => !key.EndsWith("|" + todayKey, StringComparison.Ordinal));

        foreach (ForegroundReport report in reports)
        {
            await EnforceAppRulesForReportAsync(report.Payload, parsed, normalizedUsage, local, todayKey, ct);
        }
    }

    /// <summary>
    /// Thi hành cho một báo cáo foreground: focus trước (đóng app ngoài danh
    /// sách cho phép trong giờ tập trung), rồi chặn theo giờ, rồi giới hạn
    /// thời gian. Có lệnh đóng thì đóng và dừng (không cảnh báo thêm); không
    /// thì cảnh báo một lần/ngày/exe khi sắp hết hạn. Chỉ log tên exe + lý do.
    /// </summary>
    private async Task EnforceAppRulesForReportAsync(
        ForegroundChangedPayload foreground,
        ParsedAppRules parsed,
        Dictionary<string, TimeSpan> usageByApp,
        DateTime local,
        string todayKey,
        CancellationToken ct)
    {
        // Giờ học tập trung: hợp danh sách app cho phép của mọi rule focus
        // đang trong khung giờ. App foreground không thuộc danh sách thì đóng.
        bool focusActive = false;
        var focusAllowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (FocusRuleEntry focus in parsed.FocusRules)
        {
            if (AppRuleParser.MinutesUntilWindowEnd(focus.WindowsByWeekday, local) is not null)
            {
                focusActive = true;
                foreach (AppRef allowed in focus.AllowedApps)
                {
                    focusAllowed.Add(allowed.NormalizedExe);
                }
            }
        }

        if (focusActive && !IsForegroundAllowed(foreground, focusAllowed))
        {
            string display = foreground.ExeName ?? foreground.AppName;
            await KillAppAsync(ForegroundNormalizedExe(foreground), foreground.SessionId, display, "đang giờ học tập trung", ct);
            return;
        }

        string? killExe = null;
        string? killDisplay = null;
        string? killClause = null;
        int? warnWindowMinutes = null;
        string? warnWindowExe = null;
        string? warnWindowDisplay = null;

        foreach (AppBlockEntry block in parsed.BlockByTime)
        {
            if (!MatchesForeground(foreground, block.App.NormalizedExe))
            {
                continue;
            }

            int? minutesLeft = AppRuleParser.MinutesUntilWindowEnd(block.WindowsByWeekday, local);
            if (minutesLeft is null)
            {
                // Ngoài mọi khung giờ được dùng hôm nay (kể cả ngày không có
                // khung nào): đóng app.
                killExe = block.App.NormalizedExe;
                killDisplay = block.App.DisplayName;
                killClause = "đang ngoài khung giờ được dùng";
                break;
            }

            int clamped = Math.Max(1, minutesLeft.Value);
            if (clamped <= 5 && (warnWindowMinutes is null || clamped < warnWindowMinutes.Value))
            {
                warnWindowMinutes = clamped;
                warnWindowExe = block.App.NormalizedExe;
                warnWindowDisplay = block.App.DisplayName;
            }
        }

        int? warnLimitMinutes = null;
        string? warnLimitExe = null;
        string? warnLimitDisplay = null;
        if (killExe is null)
        {
            foreach (AppTimeLimitEntry limit in parsed.TimeLimits)
            {
                if (!MatchesForeground(foreground, limit.App.NormalizedExe))
                {
                    continue;
                }

                usageByApp.TryGetValue(limit.App.NormalizedExe, out TimeSpan used);
                int minutesLeft = limit.MinutesPerDay - (int)used.TotalMinutes;
                if (minutesLeft <= 0)
                {
                    killExe = limit.App.NormalizedExe;
                    killDisplay = limit.App.DisplayName;
                    killClause = "đã hết thời gian cho phép hôm nay";
                    break;
                }

                if (minutesLeft <= 5 && (warnLimitMinutes is null || minutesLeft < warnLimitMinutes.Value))
                {
                    warnLimitMinutes = minutesLeft;
                    warnLimitExe = limit.App.NormalizedExe;
                    warnLimitDisplay = limit.App.DisplayName;
                }
            }
        }

        if (killExe is not null)
        {
            await KillAppAsync(killExe, foreground.SessionId, killDisplay!, killClause!, ct);
            return;
        }

        if (warnWindowMinutes is not null && warnWindowExe is not null && warnWindowDisplay is not null
            && MarkAppWarned(warnWindowExe, todayKey, "window"))
        {
            await _ipc.SendToTrayAsync(
                IpcMessage.Create(IpcMessageTypes.Warning, new WarningPayload(
                    warnWindowMinutes.Value,
                    warnWindowDisplay + " sắp hết khung giờ được dùng, còn " + warnWindowMinutes.Value + " phút.")),
                ct);
        }

        if (warnLimitMinutes is not null && warnLimitExe is not null && warnLimitDisplay is not null
            && MarkAppWarned(warnLimitExe, todayKey, "limit"))
        {
            await _ipc.SendToTrayAsync(
                IpcMessage.Create(IpcMessageTypes.Warning, new WarningPayload(
                    warnLimitMinutes.Value,
                    warnLimitDisplay + " sắp hết thời gian cho phép, còn " + warnLimitMinutes.Value + " phút.")),
                ct);
        }
    }

    /// <summary>
    /// Gộp usage hôm nay theo tên exe đã chuẩn hóa (khóa so khớp không phân
    /// biệt hoa thường): <c>app_name</c> trong DB là tên process trần, còn
    /// config ghi "game.exe" — chuẩn hóa cả hai phía rồi cộng dồn.
    /// </summary>
    private static Dictionary<string, TimeSpan> NormalizeUsageByApp(IReadOnlyDictionary<string, TimeSpan> usageByApp)
    {
        var normalized = new Dictionary<string, TimeSpan>(StringComparer.OrdinalIgnoreCase);
        foreach (KeyValuePair<string, TimeSpan> pair in usageByApp)
        {
            string? key = ExeNames.Normalize(pair.Key);
            if (key is null)
            {
                continue;
            }

            normalized.TryGetValue(key, out TimeSpan existing);
            normalized[key] = existing + pair.Value;
        }

        return normalized;
    }

    /// <summary>App foreground có phải app của rule không: khớp tên file exe hoặc tên process (chuẩn hóa cả hai phía).</summary>
    private static bool MatchesForeground(ForegroundChangedPayload foreground, string normalizedExe)
    {
        return ExeNames.Matches(normalizedExe, foreground.ExeName)
            || ExeNames.Matches(normalizedExe, foreground.AppName);
    }

    /// <summary>App foreground có thuộc danh sách cho phép (tên đã chuẩn hóa) không.</summary>
    private static bool IsForegroundAllowed(ForegroundChangedPayload foreground, HashSet<string> allowedNormalized)
    {
        string? exe = ExeNames.Normalize(foreground.ExeName);
        if (exe is not null && allowedNormalized.Contains(exe))
        {
            return true;
        }

        string? app = ExeNames.Normalize(foreground.AppName);
        return app is not null && allowedNormalized.Contains(app);
    }

    /// <summary>Tên exe đã chuẩn hóa của app foreground (ưu tiên tên file exe, rồi tên process).</summary>
    private static string? ForegroundNormalizedExe(ForegroundChangedPayload foreground)
    {
        return ExeNames.Normalize(foreground.ExeName) ?? ExeNames.Normalize(foreground.AppName);
    }

    /// <summary>Ghi nhận đã cảnh báo cho một exe trong ngày. Trả về false nếu đã cảnh báo rồi (mỗi exe mỗi ngày một lần cho mỗi loại).</summary>
    private bool MarkAppWarned(string normalizedExe, string todayKey, string kind)
    {
        return _appWarnedKeys.Add(kind + "|" + normalizedExe + "|" + todayKey);
    }

    /// <summary>
    /// Đóng app theo quy tắc: chỉ khi tên exe không nằm trong denylist. Đóng
    /// xong (ít nhất một tiến trình) thì báo Tray hiện thông báo với
    /// MinutesLeft = 0 (WarningWindow ẩn dòng đếm ngược, chỉ hiện lý do).
    /// </summary>
    private async Task KillAppAsync(string? normalizedExe, int sessionId, string displayName, string clause, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(normalizedExe))
        {
            return;
        }

        if (IsDenylisted(normalizedExe))
        {
            // Từ chối đóng nhưng chống spam: cùng một exe chỉ ghi log tối đa
            // 1 lần/15 phút (giờ tập trung nhắc lại mỗi 15 giây).
            if (!_lastDenylistRefusalLogAt.TryGetValue(normalizedExe, out DateTimeOffset lastRefusal)
                || DateTimeOffset.UtcNow - lastRefusal >= TimeSpan.FromMinutes(15))
            {
                _lastDenylistRefusalLogAt[normalizedExe] = DateTimeOffset.UtcNow;
                _log.Warning("Từ chối đóng " + normalizedExe + " vì nằm trong danh sách bảo vệ, dù quy tắc yêu cầu (" + clause + ").");
            }

            return;
        }

        int killed = KillProcessesInSession(normalizedExe, sessionId);
        if (killed > 0)
        {
            _log.Info("Đã đóng " + normalizedExe + " vì " + clause + ".");
            await _ipc.SendToTrayAsync(
                IpcMessage.Create(IpcMessageTypes.Warning, new WarningPayload(0, "Đã đóng " + displayName + " vì " + clause + ".")),
                ct);
        }
    }

    /// <summary>
    /// Đóng các tiến trình cùng tên trong ĐÚNG session đã báo cáo: bỏ qua
    /// session 0, bỏ qua tiến trình trong denylist, mỗi tiến trình bắt lỗi
    /// riêng (best-effort). Chỉ đóng đúng tiến trình đó, không đóng cây
    /// tiến trình con. Trả về số tiến trình đã đóng.
    /// </summary>
    private int KillProcessesInSession(string normalizedExe, int sessionId)
    {
        Process[] processes;
        try
        {
            processes = Process.GetProcessesByName(normalizedExe);
        }
        catch (Exception ex)
        {
            _log.Error("Không liệt kê được tiến trình để đóng " + normalizedExe + ".", ex);
            return 0;
        }

        int killed = 0;
        foreach (Process process in processes)
        {
            try
            {
                using (process)
                {
                    if (process.SessionId == 0 || process.SessionId != sessionId)
                    {
                        continue;
                    }

                    if (IsDenylisted(process.ProcessName))
                    {
                        continue;
                    }

                    process.Kill();
                    killed++;
                }
            }
            catch (Exception ex)
            {
                _log.Warning("Không đóng được một tiến trình " + normalizedExe + " (" + ex.GetType().Name + ").");
            }
        }

        return killed;
    }

    /// <summary>Tên exe có nằm trong denylist bảo vệ (hệ thống + chính Agent) không.</summary>
    private static bool IsDenylisted(string? name)
    {
        string? normalized = ExeNames.Normalize(name);
        return normalized is not null && DenylistedExes.Contains(normalized);
    }

    /// <summary>
    /// Thi hành một lệnh từ phụ huynh. Trả về true khi lệnh đã thi hành (kể
    /// cả lệnh ghi đè đã hết hạn trước khi nhận — đã tiêu thụ, không còn gì
    /// để làm), false khi payload sai/không rõ loại hoặc lệnh chưa triển khai
    /// — nơi gọi ack kết quả về server theo giá trị này.
    /// </summary>
    private async Task<bool> ExecuteCommandAsync(Command command, CancellationToken ct)
    {
        _log.Info("Nhận command: " + command.Type + " (id " + command.Id + ").");
        switch (command.Type)
        {
            case CommandTypes.LockNow:
                // Lưu bền vững: khóa cưỡng chế sống sót qua khởi động lại
                // Service, chỉ hết khi có lệnh unlock.
                await _outbox.SetStateAsync(StateKeys.ForcedLock, "1", ct);
                _lockSent = true;
                await _ipc.SendToTrayAsync(
                    IpcMessage.Create(IpcMessageTypes.Lock, new LockPayload("Phụ huynh đã khóa máy.")), ct);
                return true;

            case CommandTypes.Unlock:
                await _outbox.DeleteStateAsync(StateKeys.ForcedLock, ct);
                _lockSent = false;
                await _ipc.SendToTrayAsync(IpcMessage.Create(IpcMessageTypes.Unlock, new { }), ct);
                return true;

            case CommandTypes.RefreshRules:
                IReadOnlyList<Rule>? rules = await _api.FetchRulesAsync(ct);
                if (rules is null)
                {
                    _log.Warning("Làm mới rules thất bại (mất mạng hoặc chưa pairing). Giữ cache cũ.");
                    return false;
                }

                await _outbox.SaveRulesAsync(rules, ct);
                _log.Info("Đã làm mới cache rules: " + rules.Count + " rules.");
                await _publisher.PublishAsync(ct);
                return true;

            case CommandTypes.TemporaryOverride:
                return await ExecuteTemporaryOverrideAsync(command, ct);

            case CommandTypes.Update:
                // TODO Sprint 2+: cập nhật Agent có kiểm tra hash + HTTPS (docs/03).
                _log.Warning("Command update chưa được triển khai.");
                return false;

            default:
                _log.Warning("Command không rõ loại, bỏ qua: " + command.Type);
                return false;
        }
    }

    /// <summary>
    /// Thi hành lệnh ghi đè tạm thời (payload: action, minutes, expires_at;
    /// ghi đè domain thêm domains). Ghi đè được lưu xuống SQLite để sống sót
    /// qua khởi động lại Service; lệnh mới nhất thay thế lệnh trước đó.
    /// Payload thiếu/sai thì bỏ qua và trả về false — không đoán ý phụ huynh.
    /// Ghi đè domain (allow_domain/block_domain) CHỈ ảnh hưởng file
    /// domain_rules.json (xuất bản lại ngay), không mở/khóa máy, không gửi
    /// IPC xuống Tray; RuleEngine cũng bỏ qua chúng (xem chốt chặn ở đó).
    /// </summary>
    private async Task<bool> ExecuteTemporaryOverrideAsync(Command command, CancellationToken ct)
    {
        JsonElement payload = command.Payload;
        string? action = TryGetPayloadString(payload, "action");

        if (action == OverrideActions.Cancel)
        {
            await _outbox.ClearOverrideAsync(ct);
            _lockSent = false;
            _log.Info("Đã hủy ghi đè tạm thời theo lệnh phụ huynh.");
            await _publisher.PublishAsync(ct);
            return true;
        }

        bool isDomainAction = action == OverrideActions.AllowDomain || action == OverrideActions.BlockDomain;

        if (action != OverrideActions.BonusMinutes
            && action != OverrideActions.Lock
            && action != OverrideActions.Unlock
            && !isDomainAction)
        {
            _log.Warning("Ghi đè tạm thời không rõ action, bỏ qua: " + (action ?? "(trống)"));
            return false;
        }

        if (!TryGetPayloadInt32(payload, "minutes", out int minutes) || minutes <= 0)
        {
            _log.Warning("Ghi đè tạm thời thiếu minutes hợp lệ, bỏ qua.");
            return false;
        }

        if (!TryGetPayloadDateTimeOffset(payload, "expires_at", out DateTimeOffset expiresAt))
        {
            _log.Warning("Ghi đè tạm thời thiếu expires_at hợp lệ, bỏ qua.");
            return false;
        }

        IReadOnlyList<string>? domains = null;
        if (isDomainAction)
        {
            domains = TryGetPayloadStringArray(payload, "domains");
            if (domains is null || domains.Count == 0)
            {
                _log.Warning("Ghi đè domain thiếu mảng domains, bỏ qua.");
                return false;
            }
        }

        if (expiresAt <= DateTimeOffset.UtcNow)
        {
            _log.Info("Ghi đè tạm thời đã hết hạn trước khi nhận, bỏ qua.");
            return true;
        }

        await _outbox.SaveOverrideAsync(new TemporaryOverride(action!, minutes, expiresAt, domains), ct);
        if (isDomainAction)
        {
            _log.Info("Đã lưu ghi đè domain: " + action + " " + domains!.Count + " domain, " + minutes + " phút, hết hạn " + expiresAt.ToString("o") + ".");
        }
        else
        {
            _log.Info("Đã lưu ghi đè tạm thời: " + action + " " + minutes + " phút, hết hạn " + expiresAt.ToString("o") + ".");
        }

        // Xuất bản lại file domain ngay: ghi đè domain có tác dụng trong vòng
        // 1 phút (chu kỳ đọc của extension), không chờ đồng bộ rules.
        await _publisher.PublishAsync(ct);

        // Tác dụng ngay với ghi đè giờ giấc, không chờ tới lần kiểm tra rules
        // tiếp theo (15 giây). Ghi đè domain không chạm tới khóa/mở máy.
        if (!isDomainAction && action == OverrideActions.Lock)
        {
            _lockSent = true;
            await _ipc.SendToTrayAsync(
                IpcMessage.Create(IpcMessageTypes.Lock, new LockPayload("Phụ huynh đã khóa máy tạm thời.")), ct);
        }
        else if (!isDomainAction && action == OverrideActions.Unlock)
        {
            _lockSent = false;
            await _ipc.SendToTrayAsync(IpcMessage.Create(IpcMessageTypes.Unlock, new { }), ct);
        }

        return true;
    }

    private static string? TryGetPayloadString(JsonElement payload, string property)
    {
        return payload.ValueKind == JsonValueKind.Object
            && payload.TryGetProperty(property, out JsonElement element)
            && element.ValueKind == JsonValueKind.String
            ? element.GetString()
            : null;
    }

    private static bool TryGetPayloadInt32(JsonElement payload, string property, out int value)
    {
        value = 0;
        return payload.ValueKind == JsonValueKind.Object
            && payload.TryGetProperty(property, out JsonElement element)
            && element.ValueKind == JsonValueKind.Number
            && element.TryGetInt32(out value);
    }

    private static bool TryGetPayloadDateTimeOffset(JsonElement payload, string property, out DateTimeOffset value)
    {
        value = default;
        return TryGetPayloadString(payload, property) is string text
            && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out value);
    }

    /// <summary>
    /// Đọc một mảng chuỗi trong payload (VD: domains của ghi đè domain).
    /// Trả về null khi thuộc tính vắng mặt hoặc không phải mảng; phần tử
    /// không phải chuỗi thì bỏ qua. Chuẩn hóa/kiểm tra domain do
    /// DomainRulesPublisher thực hiện lúc xuất bản.
    /// </summary>
    private static IReadOnlyList<string>? TryGetPayloadStringArray(JsonElement payload, string property)
    {
        if (payload.ValueKind != JsonValueKind.Object
            || !payload.TryGetProperty(property, out JsonElement element)
            || element.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var values = new List<string>();
        foreach (JsonElement item in element.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String && item.GetString() is string text)
            {
                values.Add(text);
            }
        }

        return values;
    }

    /// <summary>Chờ một khoảng thời gian. Trả về false nếu bị hủy (Service đang dừng).</summary>
    private static async Task<bool> WaitAsync(TimeSpan delay, CancellationToken ct)
    {
        try
        {
            await Task.Delay(delay, ct);
            return !ct.IsCancellationRequested;
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }
}
