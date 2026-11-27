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

/// <summary>Kết quả heartbeat: giờ server (để phát hiện chỉnh đồng hồ) + gia đình/con + hash mã PIN thoát.</summary>
public sealed class HeartbeatResult
{
    [JsonPropertyName("server_time")]
    public DateTimeOffset ServerTime { get; set; }

    [JsonPropertyName("family_id")]
    public Guid FamilyId { get; set; }

    [JsonPropertyName("child_id")]
    public Guid? ChildId { get; set; }

    /// <summary>
    /// Hash PBKDF2 của mã PIN thoát (cột devices.exit_pin_hash, migration 7).
    /// Null khi phụ huynh chưa đặt PIN hoặc server chưa áp migration 7.
    /// Không bao giờ ghi log giá trị này.
    /// </summary>
    [JsonPropertyName("exit_pin_hash")]
    public string? ExitPinHash { get; set; }
}

/// <summary>Trạng thái một lần đẩy cụm từ tìm kiếm lên server (migration 28).</summary>
public enum SearchTermsPushStatus
{
    /// <summary>Server đã nhận batch (kết quả inserted/skipped đi kèm).</summary>
    Sent,

    /// <summary>Lỗi mạng/server/chưa ghép nối — giữ dữ liệu, chu kỳ sau gửi lại.</summary>
    Failed,

    /// <summary>RPC chưa có trên server (migration 28 chưa áp — PostgREST
    /// trả 404/PGRST202). Nơi gọi cảnh báo MỘT lần rồi giữ dữ liệu như
    /// Failed, không spam log mỗi chu kỳ.</summary>
    RpcMissing,
}

/// <summary>Kết quả RPC <c>safepc_push_search_terms</c>: số mẫu đã ghi + số mẫu bị bỏ qua phía server.</summary>
public sealed class SearchTermsPushResult
{
    [JsonPropertyName("inserted")]
    public int Inserted { get; set; }

    [JsonPropertyName("skipped")]
    public int Skipped { get; set; }
}

/// <summary>Trạng thái một lần xin cấp phiên chat (migration 29).</summary>
public enum ChatSessionMintStatus
{
    /// <summary>Đã cấp phiên: kết quả <see cref="ChatSessionMintResult"/> đi kèm có token.</summary>
    Ok,

    /// <summary>Chưa ghép nối máy (chưa có device token) hoặc chưa cấu hình
    /// Supabase — phía IPC dịch sang mã lỗi "not_paired" cho Tray.</summary>
    NotPaired,

    /// <summary>RPC chưa có trên server (migration 29 chưa áp — PostgREST
    /// trả 404/PGRST202). Phía IPC dịch sang mã lỗi "chat_not_enabled".</summary>
    RpcMissing,

    /// <summary>Lỗi mạng/server/kết quả không hợp lệ — phía IPC dịch sang
    /// mã lỗi "failed".</summary>
    Failed,
}

/// <summary>Trạng thái một lần báo tài khoản Windows đã thấy (migration 25).</summary>
public enum SeenAccountReportStatus
{
    /// <summary>Server đã ghi nhận tài khoản (upsert theo device + SID).</summary>
    Reported,

    /// <summary>Chưa ghép nối máy (chưa có device token) hoặc chưa cấu hình
    /// Supabase — nơi gọi bỏ qua êm, không coi là lỗi.</summary>
    NotPaired,

    /// <summary>RPC chưa có trên server (migration 25 chưa áp — PostgREST
    /// trả 404/PGRST202). Nơi gọi cảnh báo MỘT lần rồi bỏ qua mềm.</summary>
    RpcMissing,

    /// <summary>Lỗi mạng/server khác — nơi gọi thử lại ở lần hello sau
    /// (đã có throttle theo SID nên không thành bão).</summary>
    Failed,
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
    /// Tải rules đang bật của MỘT con trên máy này (Sprint 5, RPC migration
    /// 24 <c>safepc_fetch_device_child_rules</c>). <paramref name="childId"/>
    /// null = con mặc định của máy — cùng kết quả với
    /// <see cref="FetchRulesAsync"/>. Trả về null khi chưa sẵn sàng, lỗi
    /// mạng, HOẶC RPC chưa có trên server (migration 24 chưa áp — PostgREST
    /// trả 404); nơi gọi phân biệt bằng fallback: con mặc định thì gọi lại
    /// RPC cũ, con khác thì giữ cache cũ (RPC cũ trả luật SAI con nên không
    /// được fallback). Con không gắn với máy này thì RPC trả rỗng (không
    /// phải null) — fail-closed phía server.
    /// </summary>
    public async Task<IReadOnlyList<Rule>?> FetchRulesForChildAsync(Guid? childId, CancellationToken ct)
    {
        if (!TryGetCredentials(out DeviceCredentials? creds, out string? reason))
        {
            LogThrottled("not-ready", "Fetch rules theo con bỏ qua: " + reason + ".");
            return null;
        }

        List<Rule>? rules = await PostRpcAsync<List<Rule>>(
            "safepc_fetch_device_child_rules",
            new
            {
                p_device_id = creds.DeviceId,
                p_token_hash = Hashing.HashSecret(creds.Token),
                p_child_id = childId,
            },
            ct);
        return rules;
    }

    /// <summary>
    /// Tải ánh xạ (hồ sơ con ↔ tài khoản Windows) của máy này (Sprint 5, RPC
    /// migration 24 <c>safepc_fetch_device_child_accounts</c>). Trả về null
    /// khi chưa sẵn sàng, lỗi mạng, HOẶC RPC chưa có trên server (migration
    /// 24 chưa áp) — nơi gọi giữ cache ánh xạ cũ (máy đơn-con vẫn chạy bằng
    /// fallback con mặc định). Danh sách rỗng (không null) nghĩa là máy chưa
    /// gắn tài khoản nào.
    /// </summary>
    public async Task<IReadOnlyList<ChildAccountLink>?> FetchChildAccountsAsync(CancellationToken ct)
    {
        if (!TryGetCredentials(out DeviceCredentials? creds, out string? reason))
        {
            LogThrottled("not-ready", "Fetch child accounts bỏ qua: " + reason + ".");
            return null;
        }

        List<ChildAccountLink>? links = await PostRpcAsync<List<ChildAccountLink>>(
            "safepc_fetch_device_child_accounts",
            new
            {
                p_device_id = creds.DeviceId,
                p_token_hash = Hashing.HashSecret(creds.Token),
            },
            ct);
        return links;
    }

    /// <summary>
    /// Gửi một batch usage lên bảng app_usage. family_id/child_id/device_id
    /// do server suy ra từ device đã xác thực — các trường đó trong
    /// <see cref="UsageRecord"/> không được gửi đi. Riêng
    /// <c>windows_sid</c> (Sprint 5) ĐƯỢC gửi theo từng sample để server suy
    /// ra đúng hồ sơ con qua bảng device_child_accounts (migration 24);
    /// sample thiếu SID thì server ghi theo con mặc định của máy. Trả về
    /// true chỉ khi server xác nhận đã nhận (để nơi gọi tiến watermark).
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
                windows_sid = record.WindowsSid,
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
    /// Gửi một batch web visits lên bảng web_visits (migration 4, sửa ở
    /// migration 10 thêm cờ blocked, migration 19 thêm đường dẫn, migration
    /// 24 thêm SID). Hình dạng payload: mỗi sample là {domain, path,
    /// visited_at, duration_sec, blocked, windows_sid}, khớp cột recordset
    /// của RPC <c>safepc_push_web_visits</c> và cột bảng web_visits. Sample
    /// thiếu path (client cũ) thì RPC ghi NULL — client cũ vẫn chạy; sample
    /// thiếu windows_sid thì RPC ghi theo con mặc định của máy. family_id/
    /// child_id/device_id do server suy ra từ device đã xác thực. Trả về
    /// true chỉ khi server xác nhận đã nhận (để nơi gọi cắt file
    /// web_usage.jsonl); false thì giữ file lại gửi sau.
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
                path = record.Path,
                visited_at = record.VisitedAt,
                duration_sec = record.DurationSec,
                blocked = record.Blocked,
                windows_sid = record.WindowsSid,
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
    /// Gửi một batch cụm từ tìm kiếm lên bảng search_terms (migration 28,
    /// RPC <c>safepc_push_search_terms</c>). Hình dạng payload: mỗi mẫu là
    /// {engine, term, blocked, windows_sid} — server suy child_id theo
    /// từng mẫu qua SID (fallback con mặc định), mẫu không suy ra được
    /// con nào thì bỏ qua và đếm vào skipped. Khác
    /// <see cref="SendWebVisitsAsync"/> ở chỗ trả về TRẠNG THÁI tường
    /// minh: RPC là RPC tùy chọn theo nghĩa migration có thể chưa áp —
    /// PostgREST trả 404 kèm mã PGRST202 khi hàm chưa tồn tại, và nơi
    /// gọi phải phân biệt được trường hợp đó (cảnh báo 1 lần) với lỗi
    /// mạng thông thường (giữ file, thử lại lặng lẽ). Vì vậy hàm này gọi
    /// HTTP trực tiếp thay vì qua <see cref="PostRpcAsync{T}"/> (vốn gộp
    /// mọi lỗi thành default).
    /// </summary>
    public async Task<(SearchTermsPushStatus Status, SearchTermsPushResult? Result)> SendSearchTermsAsync(
        IReadOnlyList<SearchTermRecord> records, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(records);

        if (records.Count == 0)
        {
            return (SearchTermsPushStatus.Sent, new SearchTermsPushResult());
        }

        if (!TryGetCredentials(out DeviceCredentials? creds, out string? reason))
        {
            LogThrottled("not-ready", "Gửi search terms bỏ qua: " + reason + ". Dữ liệu giữ lại để gửi sau.");
            return (SearchTermsPushStatus.Failed, null);
        }

        var terms = new List<object>(records.Count);
        foreach (SearchTermRecord record in records)
        {
            terms.Add(new
            {
                engine = record.Engine,
                term = record.Term,
                blocked = record.Blocked,
                windows_sid = record.WindowsSid,
            });
        }

        const string function = "safepc_push_search_terms";
        string url = _baseUrl + "/rest/v1/rpc/" + function;
        string json = JsonSerializer.Serialize(new
        {
            p_device_id = creds.DeviceId,
            p_token_hash = Hashing.HashSecret(creds.Token),
            p_terms = terms,
        });
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
            return (SearchTermsPushStatus.Failed, null);
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode)
            {
                string body = string.Empty;
                try
                {
                    body = await response.Content.ReadAsStringAsync(ct);
                }
                catch (HttpRequestException)
                {
                    // Body lỗi không đọc được: phân loại theo mã HTTP ở dưới.
                }

                // PostgREST báo hàm không tồn tại bằng 404 + mã PGRST202
                // trong body. Chỉ hai dấu hiệu này mới là "chưa áp
                // migration"; lỗi khác (401/400/5xx) là Failed thường.
                if ((int)response.StatusCode == 404 || body.Contains("PGRST202", StringComparison.Ordinal))
                {
                    LogThrottled(function, "RPC " + function + " chưa có trên server (migration 28 chưa áp).");
                    return (SearchTermsPushStatus.RpcMissing, null);
                }

                LogThrottled(function, "Server từ chối " + function + " (HTTP " + (int)response.StatusCode + ").");
                return (SearchTermsPushStatus.Failed, null);
            }

            try
            {
                SearchTermsPushResult? result = await response.Content.ReadFromJsonAsync<SearchTermsPushResult>(JsonOptions, ct);
                return result is null
                    ? (SearchTermsPushStatus.Failed, null)
                    : (SearchTermsPushStatus.Sent, result);
            }
            catch (JsonException ex)
            {
                LogThrottled(function, "Không đọc được kết quả " + function + ".", ex);
                return (SearchTermsPushStatus.Failed, null);
            }
        }
    }

    /// <summary>
    /// Xin server cấp một phiên chat cho con của PHIÊN Tray đang hỏi
    /// (migration 29, RPC <c>safepc_mint_chat_session</c>): Service gọi khi
    /// con bấm "Nhắn tin với bố mẹ" trong menu khay. Server suy ra hồ sơ con
    /// từ thiết bị đã xác thực + <paramref name="sid"/> (SID của tài khoản
    /// Windows của phiên Tray — Service lấy từ bản tin hello của kết nối
    /// pipe, KHÔNG lấy từ payload Tray gửi kèm); <paramref name="sid"/> null
    /// (Tray cũ chưa gửi SID) thì server ghi theo con mặc định của máy.
    /// Token phiên trong kết quả KHÔNG bao giờ được ghi log ở đây — nơi gọi
    /// (IPC) chỉ chuyển nó vào URL trả về đúng Tray đã hỏi.
    /// Giống <see cref="SendSearchTermsAsync"/>, hàm này gọi HTTP trực tiếp
    /// thay vì qua <see cref="PostRpcAsync{T}"/> vì nơi gọi phải phân biệt
    /// "RPC chưa áp" (404/PGRST202) với lỗi thường để báo đúng cho con.
    /// </summary>
    public async Task<(ChatSessionMintStatus Status, ChatSessionMintResult? Result)> SendChatSessionMintAsync(
        string? sid, CancellationToken ct)
    {
        if (!TryGetCredentials(out DeviceCredentials? creds, out string? reason))
        {
            LogThrottled("not-ready", "Xin phiên chat bỏ qua: " + reason + ".");
            return (ChatSessionMintStatus.NotPaired, null);
        }

        const string function = "safepc_mint_chat_session";
        string url = _baseUrl + "/rest/v1/rpc/" + function;
        string json = JsonSerializer.Serialize(new
        {
            p_device_id = creds.DeviceId,
            p_token_hash = Hashing.HashSecret(creds.Token),
            p_windows_sid = sid,
        });
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
            return (ChatSessionMintStatus.Failed, null);
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode)
            {
                string body = string.Empty;
                try
                {
                    body = await response.Content.ReadAsStringAsync(ct);
                }
                catch (HttpRequestException)
                {
                    // Body lỗi không đọc được: phân loại theo mã HTTP ở dưới.
                }

                // Máy đã ghép nối nhưng CHƯA gắn hồ sơ con nào: server
                // raise 'device_not_assigned' (migration 29, HTTP 400).
                // Đây là trạng thái cấu hình cố định — "thử lại sau"
                // không bao giờ tự khỏi — nên map về NotPaired để Tray
                // báo đúng câu chưa-ghép-nối-hồ-sơ thay vì Failed chung.
                if (body.Contains("device_not_assigned", StringComparison.Ordinal))
                {
                    LogThrottled(function, "Máy chưa gắn hồ sơ con (device_not_assigned) — không cấp được phiên chat.");
                    return (ChatSessionMintStatus.NotPaired, null);
                }

                // Như SendSearchTermsAsync: chỉ 404/PGRST202 mới là "chưa
                // áp migration 29"; lỗi khác (401/400/5xx) là Failed thường.
                if ((int)response.StatusCode == 404 || body.Contains("PGRST202", StringComparison.Ordinal))
                {
                    LogThrottled(function, "RPC " + function + " chưa có trên server (migration 29 chưa áp).");
                    return (ChatSessionMintStatus.RpcMissing, null);
                }

                LogThrottled(function, "Server từ chối " + function + " (HTTP " + (int)response.StatusCode + ").");
                return (ChatSessionMintStatus.Failed, null);
            }

            try
            {
                ChatSessionMintResult? result = await response.Content.ReadFromJsonAsync<ChatSessionMintResult>(JsonOptions, ct);
                if (result is null || string.IsNullOrWhiteSpace(result.Token))
                {
                    // Server trả 2xx nhưng không có token: coi như lỗi —
                    // không bao giờ trả "thành công" kèm URL thiếu token.
                    LogThrottled(function, "Kết quả " + function + " không có token phiên chat.");
                    return (ChatSessionMintStatus.Failed, null);
                }

                return (ChatSessionMintStatus.Ok, result);
            }
            catch (JsonException ex)
            {
                LogThrottled(function, "Không đọc được kết quả " + function + ".", ex);
                return (ChatSessionMintStatus.Failed, null);
            }
        }
    }

    /// <summary>
    /// Báo server một tài khoản Windows mà Tray vừa thấy trên máy này
    /// (migration 25, RPC <c>safepc_report_seen_account</c>): phía IPC gọi
    /// mỗi khi một phiên Tray hello (đã throttle theo SID ở phía IPC) để
    /// Dashboard liệt kê được các tài khoản Windows khi phụ huynh gắn tài
    /// khoản với hồ sơ con. Server upsert theo (device_id, windows_sid) —
    /// báo lại chỉ cập nhật username/is_admin/last_seen_at. Giống
    /// <see cref="SendChatSessionMintAsync"/>, hàm này gọi HTTP trực tiếp
    /// thay vì qua <see cref="PostRpcAsync{T}"/> vì nơi gọi phải phân biệt
    /// "RPC chưa áp" (404/PGRST202) với lỗi thường. Không log token: chỉ
    /// hash của token được gửi đi như mọi RPC thiết bị.
    /// </summary>
    public async Task<SeenAccountReportStatus> ReportSeenAccountAsync(
        string sid, string? username, bool isAdmin, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(sid);

        if (!TryGetCredentials(out DeviceCredentials? creds, out string? reason))
        {
            LogThrottled("not-ready", "Báo tài khoản đã thấy bỏ qua: " + reason + ".");
            return SeenAccountReportStatus.NotPaired;
        }

        const string function = "safepc_report_seen_account";
        string url = _baseUrl + "/rest/v1/rpc/" + function;
        string json = JsonSerializer.Serialize(new
        {
            p_device_id = creds.DeviceId,
            p_token_hash = Hashing.HashSecret(creds.Token),
            p_windows_sid = sid,
            p_windows_username = username,
            p_is_admin = isAdmin,
        });
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
            return SeenAccountReportStatus.Failed;
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode)
            {
                string body = string.Empty;
                try
                {
                    body = await response.Content.ReadAsStringAsync(ct);
                }
                catch (HttpRequestException)
                {
                    // Body lỗi không đọc được: phân loại theo mã HTTP ở dưới.
                }

                // Như SendSearchTermsAsync: chỉ 404/PGRST202 mới là "chưa
                // áp migration 25"; lỗi khác (401/400/5xx) là Failed thường.
                if ((int)response.StatusCode == 404 || body.Contains("PGRST202", StringComparison.Ordinal))
                {
                    LogThrottled(function, "RPC " + function + " chưa có trên server (migration 25 chưa áp).");
                    return SeenAccountReportStatus.RpcMissing;
                }

                LogThrottled(function, "Server từ chối " + function + " (HTTP " + (int)response.StatusCode + ").");
                return SeenAccountReportStatus.Failed;
            }

            // RPC trả jsonb {device_id, windows_sid, last_seen_at} nhưng
            // nơi gọi không cần giá trị nào trong đó — HTTP 2xx là đủ xác
            // nhận server đã upsert (như PostRpcNoResultAsync).
            return SeenAccountReportStatus.Reported;
        }
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
    /// Báo một sự kiện thi hành lên server (migration 10, ghi vào bảng
    /// <c>audit_logs</c>). <paramref name="eventType"/> phải là một trong 4
    /// giá trị RPC chấp nhận (lock_started, break_started, app_blocked,
    /// warning_shown) — khóa do phụ huynh không ghi ở đây (đã đếm được từ
    /// bảng commands). Trả về true chỉ khi server trả về id hàng đã ghi.
    /// RPC chưa tồn tại (migration 10 chưa áp) thì PostgREST trả lỗi và
    /// <see cref="PostRpcAsync{T}"/> trả default + log throttle — nơi gọi
    /// bỏ qua mềm, không crash, không retry bão.
    /// </summary>
    public async Task<bool> PushEnforcementEventAsync(string eventType, JsonElement details, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(eventType);

        if (!TryGetCredentials(out DeviceCredentials? creds, out string? reason))
        {
            LogThrottled("not-ready", "Gửi enforcement event bỏ qua: " + reason + ".");
            return false;
        }

        string? id = await PostRpcAsync<string>(
            "safepc_push_enforcement_event",
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
    /// Đẩy một yêu cầu xin thêm giờ của con lên bảng <c>requests</c>
    /// (migration 7, RPC <c>safepc_push_extra_time_request</c>). Trả về true
    /// khi server trả về id yêu cầu. Lỗi mạng/server đều trả false để
    /// AgentWorker giữ hàng trong outbox và thử lại theo backoff.
    /// </summary>
    public async Task<bool> PushExtraTimeRequestAsync(int minutes, string reason, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(reason);

        if (!TryGetCredentials(out DeviceCredentials? creds, out string? notReadyReason))
        {
            LogThrottled("not-ready", "Gửi yêu cầu xin thêm giờ bỏ qua: " + notReadyReason + ".");
            return false;
        }

        JsonElement? result = await PostRpcAsync<JsonElement>(
            "safepc_push_extra_time_request",
            new
            {
                p_device_id = creds.DeviceId,
                p_token_hash = Hashing.HashSecret(creds.Token),
                p_minutes = minutes,
                p_reason = reason,
            },
            ct);
        return result.HasValue;
    }

    /// <summary>
    /// Đẩy một yêu cầu xin mở domain của con lên bảng <c>requests</c>
    /// (migration 18, RPC <c>safepc_push_unblock_domain_request</c>). Chỉ
    /// tên miền, không URL/path/query. <paramref name="windowsSid"/> (Sprint
    /// 5, migration 24) là SID của tài khoản Windows đã bấm nút xin mở —
    /// server suy ra hồ sơ con qua bảng device_child_accounts; null thì
    /// server ghi theo con mặc định của máy. Trả về true khi server trả về
    /// id yêu cầu — kể cả khi RPC trả về yêu cầu pending đã có (chống trùng
    /// phía server), vì yêu cầu đã nằm trên server để phụ huynh duyệt. Lỗi
    /// mạng/server đều trả false để AgentWorker giữ dòng trong file và thử
    /// lại chu kỳ sau.
    /// </summary>
    public async Task<bool> PushUnblockDomainRequestAsync(string domain, string? windowsSid, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(domain);

        if (!TryGetCredentials(out DeviceCredentials? creds, out string? notReadyReason))
        {
            LogThrottled("not-ready", "Gửi yêu cầu xin mở domain bỏ qua: " + notReadyReason + ".");
            return false;
        }

        JsonElement? result = await PostRpcAsync<JsonElement>(
            "safepc_push_unblock_domain_request",
            new
            {
                p_device_id = creds.DeviceId,
                p_token_hash = Hashing.HashSecret(creds.Token),
                p_domain = domain,
                p_windows_sid = windowsSid,
            },
            ct);
        return result.HasValue;
    }

    /// <summary>Đẩy yêu cầu xin mở domain khi không biết phiên nào đã gửi (đường cũ): server ghi theo con mặc định của máy.</summary>
    public Task<bool> PushUnblockDomainRequestAsync(string domain, CancellationToken ct)
        => PushUnblockDomainRequestAsync(domain, null, ct);

    /// <summary>
    /// Gỡ mã PIN thoát khỏi server sau khi mã đã dùng đúng một lần (migration
    /// 8, RPC <c>safepc_clear_exit_pin</c>): đặt <c>devices.exit_pin_hash</c>
    /// về NULL, nhưng CHỈ khi hash trên server đúng bằng
    /// <paramref name="expectedHash"/> (hash của mã vừa dùng) — mã PIN mới
    /// phụ huynh đặt sau đó không bao giờ bị xóa nhầm. Trả về 3 trạng thái:
    /// true = đã gỡ; false = hash trên server đã đổi/mất (mã đã dùng không
    /// còn đó nữa); null = lỗi mạng/server/chưa áp migration (nơi gọi giữ cờ
    /// thử lại). Hash không bao giờ được ghi log.
    /// </summary>
    public async Task<bool?> ClearExitPinAsync(string expectedHash, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(expectedHash);

        if (!TryGetCredentials(out DeviceCredentials? creds, out string? notReadyReason))
        {
            LogThrottled("not-ready", "Gỡ mã PIN thoát bỏ qua: " + notReadyReason + ".");
            return null;
        }

        JsonElement? result = await PostRpcAsync<JsonElement>(
            "safepc_clear_exit_pin",
            new
            {
                p_device_id = creds.DeviceId,
                p_token_hash = Hashing.HashSecret(creds.Token),
                p_expected_hash = expectedHash,
            },
            ct);
        if (result is null)
        {
            return null;
        }

        // Kết quả không đúng dạng thì coi như lỗi (giữ cờ thử lại) thay vì
        // kết luận đã gỡ — an toàn hơn khi server trả về điều bất ngờ.
        if (result.Value.ValueKind == JsonValueKind.Object
            && result.Value.TryGetProperty("cleared", out JsonElement cleared)
            && cleared.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
            return cleared.GetBoolean();
        }

        return null;
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
