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

    // Chống spam cảnh báo: mỗi ngưỡng 15/5/1 phút chỉ báo một lần.
    private int _lastWarnBucket;
    private bool _lockSent;

    // Chữ ký ghi đè ở lần kiểm tra rules trước (action + hết hạn + domains):
    // đổi là ghi đè đã áp dụng/hết hạn/bị thay, cần xuất bản lại file domain.
    private string? _lastOverrideSignature;

    public AgentWorker(
        LocalLogger log,
        OutboxStore outbox,
        SupabaseApiClient api,
        RuleEngine ruleEngine,
        IpcPipeServer ipc,
        TokenStore tokens,
        DomainRulesPublisher publisher)
    {
        _log = log;
        _outbox = outbox;
        _api = api;
        _ruleEngine = ruleEngine;
        _ipc = ipc;
        _tokens = tokens;
        _publisher = publisher;
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
                    // log cảnh báo. Việc báo phụ huynh là TODO đợt 3; engine
                    // vẫn thi hành theo giờ máy + cache rules khi mất mạng.
                    TimeSpan drift = result.ServerTime - DateTimeOffset.UtcNow;
                    if (Math.Abs(drift.TotalMinutes) > 5)
                    {
                        _log.Warning("Đồng hồ máy lệch " + drift.TotalMinutes.ToString("F1", CultureInfo.InvariantCulture) + " phút so với giờ server (ngưỡng 5 phút).");
                    }

                    await RefreshRulesAsync(ct);
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
                RuleDecision decision = _ruleEngine.Evaluate(rules, usedToday, DateTimeOffset.Now, foregroundAppName: null, activeOverride, forcedLock: forcedLock);

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
                        if (!_lockSent)
                        {
                            _lockSent = true;
                            _log.Info("Hết giờ (" + decision.Reason + "). Báo Tray hiện màn hình khóa.");
                            await _ipc.SendToTrayAsync(
                                IpcMessage.Create(IpcMessageTypes.Lock, new LockPayload(decision.Reason)), ct);
                        }
                        break;
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
