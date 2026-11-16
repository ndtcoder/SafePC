using System.Globalization;
using System.Linq;
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
/// 3. Flush usage 5 phút: tổng hợp mẫu foreground theo app, gửi lên server.
/// 4. Kiểm tra rules 15s từ cache local (offline-first): hết giờ thì báo Tray
///    hiện cảnh báo/màn hình khóa qua IPC (Tray đếm ngược 60s rồi khóa phiên).
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

    // Chống spam cảnh báo: mỗi ngưỡng 15/5/1 phút chỉ báo một lần.
    private int _lastWarnBucket;
    private bool _lockSent;

    public AgentWorker(
        LocalLogger log,
        OutboxStore outbox,
        SupabaseApiClient api,
        RuleEngine ruleEngine,
        IpcPipeServer ipc,
        TokenStore tokens)
    {
        _log = log;
        _outbox = outbox;
        _api = api;
        _ruleEngine = ruleEngine;
        _ipc = ipc;
        _tokens = tokens;
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
    /// Thi hành lệnh ghi đè tạm thời (payload: action, minutes, expires_at).
    /// Ghi đè được lưu xuống SQLite để sống sót qua khởi động lại Service;
    /// lệnh mới nhất thay thế lệnh trước đó. Payload thiếu/sai thì bỏ qua
    /// và trả về false — không đoán ý phụ huynh.
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
            return true;
        }

        if (action != OverrideActions.BonusMinutes
            && action != OverrideActions.Lock
            && action != OverrideActions.Unlock)
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

        if (expiresAt <= DateTimeOffset.UtcNow)
        {
            _log.Info("Ghi đè tạm thời đã hết hạn trước khi nhận, bỏ qua.");
            return true;
        }

        await _outbox.SaveOverrideAsync(new TemporaryOverride(action, minutes, expiresAt), ct);
        _log.Info("Đã lưu ghi đè tạm thời: " + action + " " + minutes + " phút, hết hạn " + expiresAt.ToString("o") + ".");

        // Tác dụng ngay, không chờ tới lần kiểm tra rules tiếp theo (15 giây).
        if (action == OverrideActions.Lock)
        {
            _lockSent = true;
            await _ipc.SendToTrayAsync(
                IpcMessage.Create(IpcMessageTypes.Lock, new LockPayload("Phụ huynh đã khóa máy tạm thời.")), ct);
        }
        else if (action == OverrideActions.Unlock)
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
