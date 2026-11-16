using System.Diagnostics.CodeAnalysis;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using Microsoft.Extensions.Configuration;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>Kết quả đổi mã pairing: id thiết bị + token thô (chỉ xuất hiện 1 lần).</summary>
public sealed class PairingResult
{
    [JsonPropertyName("device_id")]
    public Guid DeviceId { get; set; }

    [JsonPropertyName("token")]
    public string Token { get; set; } = string.Empty;

    [JsonPropertyName("family_id")]
    public Guid FamilyId { get; set; }

    [JsonPropertyName("child_id")]
    public Guid? ChildId { get; set; }
}

/// <summary>Kết quả heartbeat: giờ server (để phát hiện chỉnh đồng hồ) + gia đình/con.</summary>
public sealed class HeartbeatResult
{
    [JsonPropertyName("server_time")]
    public DateTimeOffset ServerTime { get; set; }

    [JsonPropertyName("family_id")]
    public Guid FamilyId { get; set; }

    [JsonPropertyName("child_id")]
    public Guid? ChildId { get; set; }
}

/// <summary>
/// Client gọi Supabase từ Agent qua PostgREST RPC (xem migration
/// backend/supabase/migrations/20261116170000_device_rpc.sql).
///
/// Agent không đăng nhập Supabase Auth nên mọi lệnh gọi đều đi qua các hàm
/// SECURITY DEFINER, xác thực bằng cặp (device_id, SHA-256 của device token).
/// Token thô không bao giờ rời khỏi máy; chỉ hash của nó được gửi đi.
/// Xác thực PostgREST dùng khóa publishable (AnonKey) qua header apikey +
/// Authorization — khóa này được thiết kế để lộ ra phía client, KHÔNG phải
/// khóa quản trị (docs/03-SECURITY.md).
///
/// Cấu hình đọc từ "Supabase:Url" và "Supabase:AnonKey" (appsettings.json).
/// Device token đọc từ <see cref="TokenStore"/> (DPAPI) ở MỖI lần gọi, nên
/// Service đang chạy tự nhận thông tin ghép nối mới mà không cần khởi động
/// lại. Không log token, hash token, mã pairing, hay khóa.
/// </summary>
public sealed class SupabaseApiClient
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };
    private static readonly TimeSpan LogThrottleInterval = TimeSpan.FromMinutes(5);

    private readonly HttpClient _http;
    private readonly TokenStore _tokens;
    private readonly LocalLogger _log;
    private readonly string? _baseUrl;
    private readonly object _logGate = new();
    private readonly Dictionary<string, DateTimeOffset> _lastLogByKey = new();

    public SupabaseApiClient(HttpClient http, IConfiguration config, TokenStore tokens, LocalLogger log)
    {
        _http = http;
        _http.Timeout = TimeSpan.FromSeconds(15);
        _tokens = tokens;
        _log = log;

        string? url = config["Supabase:Url"];
        _baseUrl = string.IsNullOrWhiteSpace(url) ? null : url.Trim().TrimEnd('/');
        string? anonKey = config["Supabase:AnonKey"];
        if (!string.IsNullOrWhiteSpace(anonKey))
        {
            _http.DefaultRequestHeaders.Add("apikey", anonKey.Trim());
            _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", anonKey.Trim());
        }
    }

    /// <summary>
    /// Đổi mã pairing 6 số lấy device token (chỉ dùng trong luồng ghép nối,
    /// không yêu cầu đã có token). Trả về null khi mã sai/hết hạn, mất mạng,
    /// hoặc chưa cấu hình URL/khóa.
    /// </summary>
    public async Task<PairingResult?> RedeemPairingCodeAsync(
        string code, string hostname, string osVersion, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(code);

        if (_baseUrl is null)
        {
            _log.Warning("Ghép nối bỏ qua: chưa cấu hình Supabase:Url.");
            return null;
        }

        string codeHash = Hashing.Sha256Hex(code);
        PairingResult? result = await PostRpcAsync<PairingResult>(
            "safepc_redeem_pairing_code",
            new
            {
                p_code_hash = codeHash,
                p_hostname = hostname,
                p_os_version = osVersion,
                p_agent_version = AgentConstants.AgentVersion,
            },
            ct);

        if (result is null || result.DeviceId == Guid.Empty || string.IsNullOrEmpty(result.Token))
        {
            return null;
        }

        return result;
    }

    /// <summary>
    /// Gửi heartbeat (cập nhật last_seen_at/status của device). Trả về giờ
    /// server để kiểm tra lệch đồng hồ, hoặc null khi chưa sẵn sàng/lỗi mạng.
    /// </summary>
    public async Task<HeartbeatResult?> SendHeartbeatAsync(string status, CancellationToken ct)
    {
        if (!TryGetCredentials(out DeviceCredentials? creds, out string? reason))
        {
            LogThrottled("not-ready", "Heartbeat bỏ qua: " + reason + ".");
            return null;
        }

        return await PostRpcAsync<HeartbeatResult>(
            "safepc_device_heartbeat",
            new
            {
                p_device_id = creds.DeviceId,
                p_token_hash = Hashing.HashSecret(creds.Token),
                p_agent_version = AgentConstants.AgentVersion,
                p_status = status,
            },
            ct);
    }

    /// <summary>Poll các command đang chờ (status = pending) cho device này.</summary>
    public async Task<IReadOnlyList<Command>> PollCommandsAsync(CancellationToken ct)
    {
        if (!TryGetCredentials(out DeviceCredentials? creds, out string? reason))
        {
            LogThrottled("not-ready", "Poll commands bỏ qua: " + reason + ".");
            return Array.Empty<Command>();
        }

        List<Command>? commands = await PostRpcAsync<List<Command>>(
            "safepc_fetch_device_commands",
            new
            {
                p_device_id = creds.DeviceId,
                p_token_hash = Hashing.HashSecret(creds.Token),
            },
            ct);
        return commands ?? (IReadOnlyList<Command>)Array.Empty<Command>();
    }

    /// <summary>Báo server một command đã thi hành xong (done) hoặc thất bại (failed).</summary>
    public async Task<bool> AckCommandAsync(Guid commandId, string status, CancellationToken ct)
    {
        if (!TryGetCredentials(out DeviceCredentials? creds, out string? reason))
        {
            LogThrottled("not-ready", "Ack command bỏ qua: " + reason + ".");
            return false;
        }

        bool? acked = await PostRpcAsync<bool>(
            "safepc_ack_device_command",
            new
            {
                p_device_id = creds.DeviceId,
                p_token_hash = Hashing.HashSecret(creds.Token),
                p_command_id = commandId,
                p_status = status,
            },
            ct);
        return acked ?? false;
    }

    /// <summary>
    /// Tải rules đang bật của con để cache xuống SQLite (offline-first).
    /// Trả về null khi chưa sẵn sàng hoặc lỗi mạng — nơi gọi PHẢI giữ nguyên
    /// cache cũ khi nhận null (danh sách rỗng nghĩa là server báo không có
    /// rule nào, khác với lỗi mạng).
    /// </summary>
    public async Task<IReadOnlyList<Rule>?> FetchRulesAsync(CancellationToken ct)
    {
        if (!TryGetCredentials(out DeviceCredentials? creds, out string? reason))
        {
            LogThrottled("not-ready", "Fetch rules bỏ qua: " + reason + ".");
            return null;
        }

        List<Rule>? rules = await PostRpcAsync<List<Rule>>(
            "safepc_fetch_device_rules",
            new
            {
                p_device_id = creds.DeviceId,
                p_token_hash = Hashing.HashSecret(creds.Token),
            },
            ct);
        return rules;
    }

    /// <summary>
    /// Gửi một batch usage lên bảng app_usage. family_id/child_id/device_id
    /// do server suy ra từ device đã xác thực — các trường đó trong
    /// <see cref="UsageRecord"/> không được gửi đi. Trả về true chỉ khi
    /// server xác nhận đã nhận (để nơi gọi tiến watermark).
    /// </summary>
    public async Task<bool> SendUsageBatchAsync(IReadOnlyList<UsageRecord> records, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(records);

        if (records.Count == 0)
        {
            return true;
        }

        if (!TryGetCredentials(out DeviceCredentials? creds, out string? reason))
        {
            LogThrottled("not-ready", "Gửi usage batch bỏ qua: " + reason + ". Dữ liệu giữ lại để gửi sau.");
            return false;
        }

        var samples = new List<object>(records.Count);
        foreach (UsageRecord record in records)
        {
            samples.Add(new
            {
                app_name = record.AppName,
                exe_path_hash = record.ExePathHash,
                started_at = record.StartedAt,
                duration_sec = record.DurationSec,
            });
        }

        int? inserted = await PostRpcAsync<int>(
            "safepc_push_device_usage",
            new
            {
                p_device_id = creds.DeviceId,
                p_token_hash = Hashing.HashSecret(creds.Token),
                p_samples = samples,
            },
            ct);
        return inserted.HasValue;
    }

    /// <summary>
    /// Gửi một batch web visits lên bảng web_visits (migration 4). Hình dạng
    /// payload: mỗi sample là {domain, visited_at, duration_sec}, khớp cột
    /// recordset của RPC <c>safepc_push_web_visits</c> và cột bảng
    /// web_visits. family_id/child_id/device_id do server suy ra từ device
    /// đã xác thực. Trả về true chỉ khi server xác nhận đã nhận (để nơi gọi
    /// cắt file web_usage.jsonl); false thì giữ file lại gửi sau.
    /// </summary>
    public async Task<bool> SendWebVisitsAsync(IReadOnlyList<WebVisitRecord> records, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(records);

        if (records.Count == 0)
        {
            return true;
        }

        if (!TryGetCredentials(out DeviceCredentials? creds, out string? reason))
        {
            LogThrottled("not-ready", "Gửi web visits bỏ qua: " + reason + ". Dữ liệu giữ lại để gửi sau.");
            return false;
        }

        var samples = new List<object>(records.Count);
        foreach (WebVisitRecord record in records)
        {
            samples.Add(new
            {
                domain = record.Domain,
                visited_at = record.VisitedAt,
                duration_sec = record.DurationSec,
            });
        }

        int? inserted = await PostRpcAsync<int>(
            "safepc_push_web_visits",
            new
            {
                p_device_id = creds.DeviceId,
                p_token_hash = Hashing.HashSecret(creds.Token),
                p_samples = samples,
            },
            ct);
        return inserted.HasValue;
    }

    /// <summary>
    /// Báo một sự kiện can thiệp lên server (migration 5, ghi vào bảng
    /// <c>audit_logs</c>). <paramref name="eventType"/> phải là một trong 4
    /// giá trị RPC chấp nhận (clock_drift, agent_restart, extension_missing,
    /// service_stopped) — Agent chỉ tự đẩy 2 loại đầu (xem AgentWorker).
    /// Trả về true chỉ khi server trả về id hàng đã ghi.
    /// </summary>
    public async Task<bool> PushTamperEventAsync(string eventType, JsonElement details, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(eventType);

        if (!TryGetCredentials(out DeviceCredentials? creds, out string? reason))
        {
            LogThrottled("not-ready", "Gửi tamper event bỏ qua: " + reason + ".");
            return false;
        }

        string? id = await PostRpcAsync<string>(
            "safepc_push_tamper_event",
            new
            {
                p_device_id = creds.DeviceId,
                p_token_hash = Hashing.HashSecret(creds.Token),
                p_event_type = eventType,
                p_details = details,
            },
            ct);
        return id is not null;
    }

    /// <summary>
    /// Báo server biết extension trình duyệt còn sống: cập nhật cột
    /// <c>devices.last_extension_seen_at</c> (migration 5). RPC trả về void
    /// nên PostgREST trả 204/không có body — dùng
    /// <see cref="PostRpcNoResultAsync"/> thay vì <c>PostRpcAsync&lt;T&gt;</c>
    /// (đọc JSON từ body rỗng sẽ luôn báo lỗi). Trả về true khi HTTP 2xx.
    /// </summary>
    public async Task<bool> ReportExtensionHeartbeatAsync(DateTimeOffset seenAt, CancellationToken ct)
    {
        if (!TryGetCredentials(out DeviceCredentials? creds, out string? reason))
        {
            LogThrottled("not-ready", "Báo extension heartbeat bỏ qua: " + reason + ".");
            return false;
        }

        return await PostRpcNoResultAsync(
            "safepc_report_extension_heartbeat",
            new
            {
                p_device_id = creds.DeviceId,
                p_token_hash = Hashing.HashSecret(creds.Token),
                p_seen_at = seenAt,
            },
            ct);
    }

    /// <summary>
    /// Báo trạng thái thi hành hiện tại lên server: cập nhật hai cột
    /// <c>devices.enforcement_json</c> / <c>enforcement_updated_at</c>
    /// (migration 6). RPC trả về void nên dùng
    /// <see cref="PostRpcNoResultAsync"/> như
    /// <see cref="ReportExtensionHeartbeatAsync"/>. Trả về true khi HTTP 2xx.
    /// </summary>
    public async Task<bool> ReportEnforcementAsync(JsonElement payload, CancellationToken ct)
    {
        if (!TryGetCredentials(out DeviceCredentials? creds, out string? reason))
        {
            LogThrottled("not-ready", "Báo enforcement bỏ qua: " + reason + ".");
            return false;
        }

        return await PostRpcNoResultAsync(
            "safepc_report_enforcement",
            new
            {
                p_device_id = creds.DeviceId,
                p_token_hash = Hashing.HashSecret(creds.Token),
                p_payload = payload,
            },
            ct);
    }

    /// <summary>
    /// Kiểm tra đã sẵn sàng gọi server chưa: có URL cấu hình, có khóa
    /// publishable (header đã gắn ở constructor), và đã pairing (có token).
    /// Đọc token ở mỗi lần gọi để Service đang chạy tự nhận ghép nối mới.
    /// </summary>
    private bool TryGetCredentials(
        [NotNullWhen(true)] out DeviceCredentials? credentials,
        out string? reason)
    {
        credentials = null;

        if (_baseUrl is null)
        {
            reason = "chưa cấu hình Supabase:Url";
            return false;
        }

        if (_http.DefaultRequestHeaders.Authorization is null)
        {
            reason = "chưa cấu hình Supabase:AnonKey";
            return false;
        }

        credentials = _tokens.TryLoadCredentials();
        if (credentials is null)
        {
            reason = "chưa pairing (chưa có device token)";
            return false;
        }

        reason = null;
        return true;
    }

    /// <summary>
    /// Gọi một RPC qua PostgREST. Trả về default khi lỗi mạng, server từ chối,
    /// hoặc kết quả không đọc được — nơi gọi tự phân biệt bằng kiểu trả về
    /// (null = lỗi, rỗng = thành công nhưng không có dữ liệu).
    /// </summary>
    private async Task<T?> PostRpcAsync<T>(string function, object args, CancellationToken ct)
    {
        string url = _baseUrl + "/rest/v1/rpc/" + function;
        string json = JsonSerializer.Serialize(args);
        using var request = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };

        HttpResponseMessage response;
        try
        {
            response = await _http.SendAsync(request, ct);
        }
        catch (HttpRequestException ex)
        {
            LogThrottled(function, "Không nối được tới server (" + function + ").", ex);
            return default;
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode)
            {
                string detail = await TryReadErrorMessageAsync(response, ct);
                LogThrottled(function, "Server từ chối " + function + " (HTTP " + (int)response.StatusCode + ")" + detail + ".");
                return default;
            }

            try
            {
                return await response.Content.ReadFromJsonAsync<T>(JsonOptions, ct);
            }
            catch (JsonException ex)
            {
                LogThrottled(function, "Không đọc được kết quả " + function + ".", ex);
                return default;
            }
        }
    }

    /// <summary>
    /// Gọi một RPC trả về void (PostgREST trả 204/không có body). Chỉ kiểm
    /// tra mã HTTP 2xx, không đọc/parse body. CHỈ dùng cho RPC void.
    /// </summary>
    private async Task<bool> PostRpcNoResultAsync(string function, object args, CancellationToken ct)
    {
        string url = _baseUrl + "/rest/v1/rpc/" + function;
        string json = JsonSerializer.Serialize(args);
        using var request = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };

        HttpResponseMessage response;
        try
        {
            response = await _http.SendAsync(request, ct);
        }
        catch (HttpRequestException ex)
        {
            LogThrottled(function, "Không nối được tới server (" + function + ").", ex);
            return false;
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode)
            {
                string detail = await TryReadErrorMessageAsync(response, ct);
                LogThrottled(function, "Server từ chối " + function + " (HTTP " + (int)response.StatusCode + ")" + detail + ".");
                return false;
            }

            return true;
        }
    }

    /// <summary>
    /// Đọc trường "message" trong body lỗi của PostgREST (các thông báo của
    /// RPC đều chung chung, an toàn để ghi log). Trả về "" khi không đọc được.
    /// </summary>
    private static async Task<string> TryReadErrorMessageAsync(HttpResponseMessage response, CancellationToken ct)
    {
        try
        {
            string body = await response.Content.ReadAsStringAsync(ct);
            using JsonDocument document = JsonDocument.Parse(body);
            if (document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty("message", out JsonElement message)
                && message.ValueKind == JsonValueKind.String
                && message.GetString() is string text
                && text.Length > 0)
            {
                return " — " + (text.Length > 120 ? text[..120] : text);
            }
        }
        catch (JsonException)
        {
            // Body lỗi không phải JSON: chỉ ghi mã HTTP.
        }

        return string.Empty;
    }

    /// <summary>
    /// Ghi log lỗi nhưng chống spam: mỗi khóa (tên RPC hoặc "not-ready") chỉ
    /// ghi tối đa một lần trong 5 phút. Vòng lặp poll 15s gặp lỗi mạng kéo
    /// dài không được lấp đầy file log.
    /// </summary>
    private void LogThrottled(string key, string message, Exception? exception = null)
    {
        lock (_logGate)
        {
            if (_lastLogByKey.TryGetValue(key, out DateTimeOffset last)
                && DateTimeOffset.UtcNow - last < LogThrottleInterval)
            {
                return;
            }

            _lastLogByKey[key] = DateTimeOffset.UtcNow;
        }

        if (exception is null)
        {
            _log.Warning(message);
        }
        else
        {
            _log.Error(message, exception);
        }
    }
}
