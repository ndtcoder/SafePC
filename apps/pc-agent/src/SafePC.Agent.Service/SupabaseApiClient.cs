using System.Net.Http;
using System.Threading;
using Microsoft.Extensions.Configuration;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>
/// Client gọi Supabase (REST / Edge Functions) từ Agent.
///
/// SKELETON — Sprint 0: các phương thức dưới đây CHƯA gọi mạng thật. Chúng chỉ
/// kiểm tra cấu hình/pairing, ghi log và trả về kết quả rỗng/thất bại để các
/// vòng lặp trong <see cref="AgentWorker"/> chạy được khung.
/// TODO Sprint 1: triển khai gọi thật theo hợp đồng API chốt với backend:
/// - Endpoint lấy từ cấu hình "Supabase:Url" (appsettings.json / biến môi trường).
/// - Xác thực bằng device token đọc từ <see cref="TokenStore"/> (DPAPI),
///   gửi qua header Authorization. KHÔNG hardcode URL/key, KHÔNG log token.
/// - Mọi lệnh chỉ nhận từ Supabase qua TLS + device token (docs/03-SECURITY.md).
/// </summary>
public sealed class SupabaseApiClient
{
    private readonly HttpClient _http;
    private readonly IConfiguration _config;
    private readonly TokenStore _tokens;
    private readonly LocalLogger _log;

    public SupabaseApiClient(HttpClient http, IConfiguration config, TokenStore tokens, LocalLogger log)
    {
        _http = http;
        _http.Timeout = TimeSpan.FromSeconds(15);
        _config = config;
        _tokens = tokens;
        _log = log;
    }

    /// <summary>URL Supabase từ cấu hình. Null khi chưa cấu hình (chưa triển khai).</summary>
    private string? BaseUrl
    {
        get
        {
            string? url = _config["Supabase:Url"];
            return string.IsNullOrWhiteSpace(url) ? null : url.Trim();
        }
    }

    /// <summary>
    /// Gửi heartbeat (cập nhật last_seen_at/status của device).
    /// TODO Sprint 1: POST Edge Function heartbeat, dùng device token từ DPAPI.
    /// </summary>
    public Task<bool> SendHeartbeatAsync(CancellationToken ct)
    {
        if (!Ready(out string? reason))
        {
            _log.Info("Heartbeat bỏ qua: " + reason + " (skeleton).");
            return Task.FromResult(false);
        }

        // TODO Sprint 1: gọi thật. Không log token, không log nội dung request.
        _log.Info("Heartbeat skeleton: TODO gọi Supabase Edge Function (Sprint 1).");
        return Task.FromResult(false);
    }

    /// <summary>
    /// Poll các command đang chờ (status = pending) cho device này.
    /// TODO Sprint 1: GET bảng commands qua PostgREST/Edge Function + device token.
    /// </summary>
    public Task<IReadOnlyList<Command>> PollCommandsAsync(CancellationToken ct)
    {
        if (!Ready(out string? reason))
        {
            _log.Info("Poll commands bỏ qua: " + reason + " (skeleton).");
            return Task.FromResult<IReadOnlyList<Command>>(Array.Empty<Command>());
        }

        // TODO Sprint 1: gọi thật, trả về danh sách command pending.
        return Task.FromResult<IReadOnlyList<Command>>(Array.Empty<Command>());
    }

    /// <summary>
    /// Tải rules hiện tại của con để cache xuống SQLite (offline-first).
    /// TODO Sprint 1: GET bảng rules qua PostgREST/Edge Function + device token.
    /// </summary>
    public Task<IReadOnlyList<Rule>> FetchRulesAsync(CancellationToken ct)
    {
        if (!Ready(out string? reason))
        {
            _log.Info("Fetch rules bỏ qua: " + reason + " (skeleton).");
            return Task.FromResult<IReadOnlyList<Rule>>(Array.Empty<Rule>());
        }

        // TODO Sprint 1: gọi thật, trả về danh sách rules.
        return Task.FromResult<IReadOnlyList<Rule>>(Array.Empty<Rule>());
    }

    /// <summary>
    /// Gửi một batch usage lên bảng app_usage.
    /// TODO Sprint 1: POST batch qua PostgREST/Edge Function + device token.
    /// Trả về true chỉ khi server xác nhận đã nhận (để outbox xóa bản ghi).
    /// </summary>
    public Task<bool> SendUsageBatchAsync(IReadOnlyList<UsageRecord> records, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(records);

        if (!Ready(out string? reason))
        {
            _log.Info("Gửi usage batch bỏ qua: " + reason + " (skeleton). Dữ liệu giữ lại trong outbox.");
            return Task.FromResult(false);
        }

        // TODO Sprint 1: gọi thật. Giữ dữ liệu trong outbox cho tới khi gửi thành công.
        _log.Info("Gửi usage batch skeleton: " + records.Count + " bản ghi, TODO gọi Supabase (Sprint 1).");
        return Task.FromResult(false);
    }

    /// <summary>
    /// Kiểm tra đã sẵn sàng gọi server chưa: có URL cấu hình và đã pairing (có token).
    /// Không đọc giá trị token ở đây — chỉ kiểm tra sự tồn tại.
    /// </summary>
    private bool Ready(out string? reason)
    {
        if (BaseUrl is null)
        {
            reason = "chưa cấu hình Supabase:Url";
            return false;
        }

        if (!_tokens.HasToken())
        {
            reason = "chưa pairing (chưa có device token)";
            return false;
        }

        reason = null;
        return true;
    }
}
