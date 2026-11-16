using System.Text.Json;
using System.Threading;
using Microsoft.Extensions.Hosting;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>
/// Worker chính của Windows Service (chạy quyền SYSTEM).
/// Bốn vòng lặp nền, độc lập với nhau — một vòng lặp lỗi không làm chết các vòng khác:
/// 1. Heartbeat 60s lên server (skeleton — xem SupabaseApiClient).
/// 2. Poll commands 15s từ bảng commands, thi hành lệnh (skeleton).
/// 3. Flush outbox 5 phút: gửi batch usage đã xếp hàng trong SQLite.
/// 4. Kiểm tra rules 15s từ cache local (offline-first): hết giờ thì báo Tray
///    hiện cảnh báo/màn hình khóa qua IPC.
///
/// TODO Sprint 2: thi hành thật — kết thúc process bị chặn, gọi LockWorkStation
/// sau đếm ngược 60s, cập nhật status của command lên server. Hiện tại chỉ
/// ghi log + gửi IPC, KHÔNG giả vờ đã thi hành.
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
            _log.Warning("Chưa có device token (chưa pairing). Heartbeat/poll sẽ chờ. TODO Sprint 1: luồng pairing.");
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
                _ = await _api.SendHeartbeatAsync(ct);
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

    private async Task CommandPollLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                IReadOnlyList<Command> commands = await _api.PollCommandsAsync(ct);
                foreach (Command command in commands)
                {
                    await ExecuteCommandAsync(command, ct);
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
                IReadOnlyList<OutboxItem> pending = await _outbox.GetPendingAsync(AgentConstants.OutboxBatchSize, ct);
                if (pending.Count > 0)
                {
                    var records = new List<UsageRecord>();
                    foreach (OutboxItem item in pending)
                    {
                        UsageRecord? record = JsonSerializer.Deserialize<UsageRecord>(item.PayloadJson);
                        if (record is not null)
                        {
                            records.Add(record);
                        }
                    }

                    bool sent = records.Count > 0 && await _api.SendUsageBatchAsync(records, ct);
                    foreach (OutboxItem item in pending)
                    {
                        if (sent)
                        {
                            await _outbox.MarkSentAsync(item.Id, ct);
                        }
                        else
                        {
                            await _outbox.MarkFailedAsync(item.Id, ct);
                        }
                    }
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _log.Error("Flush outbox lỗi.", ex);
            }

            if (!await WaitAsync(AgentConstants.UsageBatchInterval, ct))
            {
                break;
            }
        }
    }

    private async Task RuleCheckLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                IReadOnlyList<Rule> rules = await _outbox.GetCachedRulesAsync(ct);
                TimeSpan usedToday = await _outbox.GetUsageTodayAsync(ct);
                RuleDecision decision = _ruleEngine.Evaluate(rules, usedToday, DateTimeOffset.Now, foregroundAppName: null);

                switch (decision.Kind)
                {
                    case RuleDecisionKind.Allowed:
                        _lastWarnBucket = 0;
                        _lockSent = false;
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
                            // TODO Sprint 2: đếm ngược 60s để con lưu bài, rồi gọi
                            // LockWorkStation. Chưa làm — không khóa phiên thật ở skeleton.
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

    private async Task ExecuteCommandAsync(Command command, CancellationToken ct)
    {
        _log.Info("Nhận command: " + command.Type + " (id " + command.Id + ").");
        switch (command.Type)
        {
            case CommandTypes.LockNow:
                await _ipc.SendToTrayAsync(
                    IpcMessage.Create(IpcMessageTypes.Lock, new LockPayload("Phụ huynh đã khóa máy.")), ct);
                // TODO Sprint 2: LockWorkStation sau đếm ngược + cập nhật status command.
                break;

            case CommandTypes.Unlock:
                await _ipc.SendToTrayAsync(IpcMessage.Create(IpcMessageTypes.Unlock, new { }), ct);
                _lockSent = false;
                break;

            case CommandTypes.RefreshRules:
                IReadOnlyList<Rule> rules = await _api.FetchRulesAsync(ct);
                await _outbox.SaveRulesAsync(rules, ct);
                _log.Info("Đã làm mới cache rules: " + rules.Count + " rules.");
                break;

            case CommandTypes.Update:
                // TODO Sprint 2+: cập nhật Agent có kiểm tra hash + HTTPS (docs/03).
                _log.Warning("Command update chưa được triển khai (skeleton).");
                break;

            default:
                _log.Warning("Command không rõ loại, bỏ qua: " + command.Type);
                break;
        }

        // TODO Sprint 1: cập nhật status của command (done/failed) lên server.
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
