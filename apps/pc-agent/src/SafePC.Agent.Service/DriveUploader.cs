using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>
/// Kho token Google Drive của phụ huynh trên máy con (migration 32): bọc
/// <see cref="TokenStore"/> (DPAPI LocalMachine + ACL SYSTEM/Admins) với
/// nội dung là JSON của <see cref="DriveTokenResult"/> — cùng chuẩn bảo
/// vệ như device_token.dat. KHÔNG bao giờ ghi log bất kỳ trường nào.
/// </summary>
public sealed class DriveTokenStore
{
    private readonly TokenStore _inner;

    public DriveTokenStore(string filePath)
    {
        _inner = new TokenStore(filePath);
    }

    /// <summary>Đã có token Drive được lưu hay chưa.</summary>
    public bool HasToken => _inner.HasToken();

    /// <summary>Đọc bộ token đã lưu. Null khi chưa lưu hoặc file hỏng.</summary>
    public DriveTokenResult? TryLoad()
    {
        string? raw = _inner.TryLoadToken();
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        try
        {
            DriveTokenResult? parsed = JsonSerializer.Deserialize<DriveTokenResult>(raw);
            return parsed is null || string.IsNullOrWhiteSpace(parsed.RefreshToken) ? null : parsed;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>Lưu bộ token (mã hóa DPAPI + khóa ACL qua TokenStore).</summary>
    public void Save(DriveTokenResult token)
    {
        ArgumentNullException.ThrowIfNull(token);
        _inner.SaveToken(JsonSerializer.Serialize(token));
    }

    /// <summary>Xóa token đã lưu (khi Google báo invalid_grant).</summary>
    public void Delete() => _inner.DeleteToken();
}

/// <summary>Trạng thái một lần chuẩn bị access token Drive.</summary>
public enum DriveAccessStatus
{
    /// <summary>Có access token dùng được (đã cache hoặc vừa đổi xong).</summary>
    Ready,

    /// <summary>Chưa có token nào dùng được: phụ huynh chưa kết nối Drive,
    /// hoặc token duy nhất fetch được chính là token đã bị thu hồi.</summary>
    NoToken,

    /// <summary>Google từ chối refresh token (invalid_grant): token đã bị
    /// thu hồi/hết hạn. Nơi gọi phải báo drive_disconnected + tamper event
    /// rồi xóa cache cục bộ (xem ScreenshotService).</summary>
    Revoked,

    /// <summary>Lỗi mạng/server tạm thời — thử lại vòng sau.</summary>
    Failed,
}

/// <summary>Lỗi một lần gọi Drive API, mang mã HTTP để nơi gọi phân biệt 401 (access token bị thu hồi giữa chừng) với lỗi thường.</summary>
public sealed class DriveRequestException : Exception
{
    public DriveRequestException(int statusCode, string message)
        : base(message)
    {
        StatusCode = statusCode;
    }

    public int StatusCode { get; }
}

/// <summary>
/// Upload ảnh chụp màn hình thẳng lên Google Drive của phụ huynh (migration
/// 32, phương án A của docs/11): Service giữ refresh token (DPAPI, xem
/// <see cref="DriveTokenStore"/>), đổi access token khi cần (cache ~50
/// phút — access token Google sống 60 phút, trừ hao 10 phút), tạo cây
/// thư mục "SafePC/&lt;tên con&gt;/&lt;yyyy-MM-dd&gt;" và upload qua Drive
/// API v3. Mọi request chỉ chạm file/thư mục do app tạo (scope drive.file
/// phía OAuth nên Google tự giới hạn). Ảnh KHÔNG đi qua Supabase.
///
/// Lỗi mạng: ném/trả Failed để nơi gọi giữ file local thử lại vòng sau.
/// Lỗi 401 ở các API Drive: nơi gọi xóa cache access token để lần sau đổi
/// token mới; refresh token bị từ chối invalid_grant là đường Revoked
/// riêng (phụ huynh đã thu hồi quyền) — xem <see cref="EnsureAccessTokenAsync"/>.
/// </summary>
public sealed class DriveUploader
{
    private const string TokenEndpoint = "https://oauth2.googleapis.com/token";
    private const string FilesEndpoint = "https://www.googleapis.com/drive/v3/files";
    private const string UploadEndpoint = "https://www.googleapis.com/upload/drive/v3/files";

    /// <summary>Cache access token 50 phút (sống thật 60 phút, trừ hao đồng hồ/lệch mạng).</summary>
    private static readonly TimeSpan AccessTokenLifetime = TimeSpan.FromMinutes(50);

    /// <summary>Nhịp đối chiếu token cục bộ với server: tối đa mỗi 15 phút (khi chưa có token cục bộ thì fetch mỗi lần Ensure như cũ). Nhờ nhịp này mà phụ huynh ngắt kết nối/đổi tài khoản Google trên Dashboard thì Agent nhận ra và dừng/thay token thay vì upload mãi bằng token cũ.</summary>
    private static readonly TimeSpan ServerReconcileInterval = TimeSpan.FromMinutes(15);

    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(60) };
    private readonly LocalLogger _log;
    private readonly DriveTokenStore _store;
    private readonly SupabaseApiClient _api;
    private readonly OutboxStore _outbox;

    private string? _accessToken;
    private DateTimeOffset _accessTokenExpiresAt;
    private DriveTokenResult? _credentials;

    // Lần đối chiếu token với server gần nhất (null = chưa đối chiếu
    // trong phiên chạy này). Chỉ chạm trên luồng tick tuần tự.
    private DateTimeOffset? _lastServerReconcileAt;

    // Cache id thư mục theo đường dẫn đầy đủ ("SafePC/<con>/<ngày>"):
    // vòng đời process, Drive không đổi id khi thư mục còn đó. Mất mạng
    // khởi động lại thì tra lại bằng files.list (rẻ, drive.file chỉ thấy
    // thư mục app tạo).
    private readonly Dictionary<string, string> _folderIds = new(StringComparer.Ordinal);

    public DriveUploader(LocalLogger log, DriveTokenStore store, SupabaseApiClient api, OutboxStore outbox)
    {
        _log = log;
        _store = store;
        _api = api;
        _outbox = outbox;
    }

    /// <summary>Refresh token vừa bị Google từ chối ở lần <see cref="EnsureAccessTokenAsync"/> gần nhất trả Revoked (để nơi gọi ghi hash chống thử lại). Không bao giờ ghi log giá trị này.</summary>
    public string? LastRevokedRefreshToken { get; private set; }

    /// <summary>
    /// Đảm bảo có access token dùng được. Thứ tự: nạp thông tin đăng
    /// nhập cục bộ (DPAPI); ĐỐI CHIẾU với server theo nhịp thưa (chưa có
    /// token cục bộ → fetch mỗi lần; đã có → tối đa mỗi 15 phút một lần
    /// fetch qua RPC <c>safepc_fetch_drive_token</c>): server trả token
    /// KHÁC → thay bản cục bộ (phụ huynh kết nối lại bằng tài khoản
    /// Google khác); server XÁC NHẬN trống (RPC thành công, kết quả
    /// null) trong khi cục bộ đang có token → XÓA token cục bộ +
    /// NoToken (phụ huynh đã ngắt kết nối trên Dashboard — RPC
    /// <c>safepc_disconnect_drive</c> xóa hẳn hàng
    /// token — hoặc token bị thu hồi phía server); đối chiếu gặp LỖI
    /// TẠM THỜI (mất mạng, HTTP lỗi, migration 32 chưa áp) → GIỮ
    /// NGUYÊN token cục bộ, đi tiếp đường refresh như bình thường,
    /// không xóa gì (đợt cứng hóa 28/11: bản trước fetch gộp mọi lý
    /// do thành null nên mất mạng đúng tick đối chiếu có thể xóa oan
    /// token cục bộ + access token còn hạn); token đang giữ trùng
    /// hash token đã bị thu hồi (device_state) → NoToken (chờ phụ huynh
    /// kết nối lại, không thử upload bằng token chết); access token
    /// cache còn hạn → Ready; cuối cùng đổi refresh token lấy access
    /// token mới.
    /// </summary>
    public async Task<DriveAccessStatus> EnsureAccessTokenAsync(CancellationToken ct)
    {
        LastRevokedRefreshToken = null;

        _credentials ??= _store.TryLoad();

        bool reconcileDue = _credentials is null
            || _lastServerReconcileAt is null
            || DateTimeOffset.UtcNow - _lastServerReconcileAt.Value >= ServerReconcileInterval;
        if (reconcileDue)
        {
            (DriveTokenFetchStatus fetchStatus, DriveTokenResult? fetched) =
                await _api.FetchDriveTokenExAsync(ct);
            if (fetchStatus == DriveTokenFetchStatus.TransientError)
            {
                // Không đối chiếu được trạng thái server (mất mạng, HTTP
                // lỗi, migration 32 chưa áp, chưa ghép nối...): GIỮ
                // NGUYÊN token cục bộ, không xóa gì, không dập mốc đối
                // chiếu (lần Ensure sau thử lại ngay) và đi tiếp xuống
                // đường refresh bằng token cục bộ như bình thường. Chưa
                // có token cục bộ thì ở dưới sẽ trả NoToken như cũ.
                if (_credentials is not null)
                {
                    _log.Warning("Drive: không đối chiếu được token với server lần này (lỗi tạm thời) — giữ nguyên token cục bộ.");
                }
            }
            else if (fetchStatus == DriveTokenFetchStatus.ServerEmpty)
            {
                // Server XÁC NHẬN không còn token (RPC thành công, kết
                // quả null): phụ huynh đã ngắt kết nối phía
                // Dashboard/server. CHỈ trạng thái này mới xóa cục bộ.
                if (_credentials is not null)
                {
                    _lastServerReconcileAt = DateTimeOffset.UtcNow;
                    InvalidateLocalTokens();
                    _log.Info("Drive: server không còn token Drive của phụ huynh (đã ngắt kết nối trên Dashboard?) — đã xóa token cục bộ, dừng upload cho tới khi kết nối lại.");
                }

                return DriveAccessStatus.NoToken;
            }
            else
            {
                // HasToken: fetched chắc chắn có token dùng được.
                _lastServerReconcileAt = DateTimeOffset.UtcNow;
                if (_credentials is null)
                {
                    _credentials = fetched!;
                    _store.Save(fetched!);
                    _log.Info("Drive: đã nhận token Drive của phụ huynh từ server và lưu mã hóa trên máy.");
                }
                else if (!IsSameToken(_credentials, fetched!))
                {
                    // Token trên server đã ĐỔI (phụ huynh kết nối lại, có
                    // thể bằng tài khoản Google khác): thay bản cục bộ, bỏ
                    // access token + cache thư mục của tài khoản cũ (id thư
                    // mục không dùng chéo tài khoản được).
                    _accessToken = null;
                    _accessTokenExpiresAt = default;
                    _folderIds.Clear();
                    _credentials = fetched!;
                    _store.Save(fetched!);
                    _log.Info("Drive: token Drive trên server đã thay đổi — đã thay token cục bộ bằng token mới từ server.");
                }
            }
        }

        if (_credentials is null)
        {
            return DriveAccessStatus.NoToken;
        }

        if (_accessToken is not null && DateTimeOffset.UtcNow < _accessTokenExpiresAt)
        {
            return DriveAccessStatus.Ready;
        }

        // Token đã bị thu hồi trước đó mà fetch lại vẫn ra đúng token đó:
        // phụ huynh chưa kết nối lại — không gọi Google nữa (gọi chỉ nhận
        // lại invalid_grant và spam sự kiện drive_disconnected).
        string? revokedHash = await _outbox.GetStateAsync(StateKeys.ScreenRevokedDriveTokenHash, ct);
        if (revokedHash is not null
            && string.Equals(Hashing.HashSecret(_credentials.RefreshToken), revokedHash, StringComparison.Ordinal))
        {
            return DriveAccessStatus.NoToken;
        }

        return await RefreshAccessTokenAsync(ct);
    }

    /// <summary>Hai bộ token là MỘT khi refresh token + client id/secret trùng nhau (email Google chỉ là hiển thị, không so).</summary>
    private static bool IsSameToken(DriveTokenResult a, DriveTokenResult b)
        => string.Equals(a.RefreshToken, b.RefreshToken, StringComparison.Ordinal)
            && string.Equals(a.ClientId, b.ClientId, StringComparison.Ordinal)
            && string.Equals(a.ClientSecret, b.ClientSecret, StringComparison.Ordinal);

    /// <summary>Đổi refresh token hiện có lấy access token mới và cache ~50 phút.</summary>
    private async Task<DriveAccessStatus> RefreshAccessTokenAsync(CancellationToken ct)
    {
        if (_credentials is null)
        {
            return DriveAccessStatus.NoToken;
        }

        using var content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["client_id"] = _credentials.ClientId,
            ["client_secret"] = _credentials.ClientSecret,
            ["refresh_token"] = _credentials.RefreshToken,
            ["grant_type"] = "refresh_token",
        });

        HttpResponseMessage response;
        try
        {
            response = await _http.PostAsync(TokenEndpoint, content, ct);
        }
        catch (HttpRequestException ex)
        {
            _log.Warning("Drive: không nối được tới Google để đổi access token: " + ex.Message);
            return DriveAccessStatus.Failed;
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
                    // Body lỗi không đọc được: phân loại theo mã HTTP.
                }

                // invalid_grant = refresh token đã bị thu hồi hoặc hết
                // hạn (phụ huynh rút quyền trên trang Google / đổi mật
                // khẩu...). Đây là trạng thái CỐ ĐỊNH cho tới khi phụ
                // huynh kết nối lại — nơi gọi báo server + tamper event.
                if ((int)response.StatusCode == 400 && body.Contains("invalid_grant", StringComparison.Ordinal))
                {
                    LastRevokedRefreshToken = _credentials.RefreshToken;
                    return DriveAccessStatus.Revoked;
                }

                _log.Warning("Drive: Google từ chối đổi access token (HTTP " + (int)response.StatusCode + ").");
                return DriveAccessStatus.Failed;
            }

            try
            {
                using JsonDocument document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
                string? accessToken = document.RootElement.TryGetProperty("access_token", out JsonElement tokenElement)
                    && tokenElement.ValueKind == JsonValueKind.String
                    ? tokenElement.GetString()
                    : null;
                if (string.IsNullOrEmpty(accessToken))
                {
                    _log.Warning("Drive: kết quả đổi token không có access_token.");
                    return DriveAccessStatus.Failed;
                }

                _accessToken = accessToken;
                _accessTokenExpiresAt = DateTimeOffset.UtcNow.Add(AccessTokenLifetime);
                return DriveAccessStatus.Ready;
            }
            catch (JsonException ex)
            {
                _log.Warning("Drive: không đọc được kết quả đổi access token: " + ex.Message);
                return DriveAccessStatus.Failed;
            }
        }
    }

    /// <summary>Xóa mọi cache token (access token trong bộ nhớ + refresh token DPAPI) — dùng khi token bị thu hồi.</summary>
    public void InvalidateLocalTokens()
    {
        _accessToken = null;
        _accessTokenExpiresAt = default;
        _credentials = null;
        _folderIds.Clear();
        _store.Delete();
    }

    /// <summary>Xóa chỉ cache access token (khi Drive API trả 401: token bị thu hồi giữa chừng) — lần Ensure sau đổi token mới bằng refresh token còn lưu.</summary>
    public void InvalidateAccessToken()
    {
        _accessToken = null;
        _accessTokenExpiresAt = default;
    }

    /// <summary>
    /// Đảm bảo một thư mục theo từng đoạn đường dẫn (từ gốc Drive) tồn
    /// tại, trả về id của thư mục cuối. Mỗi đoạn: tra files.list theo tên
    /// + thư mục cha trước, chưa có thì tạo. Tên thư mục chứa ký tự '
    /// được escape đúng cú pháp query của Drive.
    /// </summary>
    public async Task<string> EnsureFolderPathAsync(IReadOnlyList<string> segments, CancellationToken ct)
    {
        string accessToken = _accessToken ?? throw new InvalidOperationException("Chưa có access token Drive.");

        string? parentId = null;
        string path = string.Empty;
        foreach (string segment in segments)
        {
            path = path.Length == 0 ? segment : path + "/" + segment;
            if (_folderIds.TryGetValue(path, out string? cachedId))
            {
                parentId = cachedId;
                continue;
            }

            string? found = await FindFolderAsync(accessToken, segment, parentId, ct);
            if (found is null)
            {
                found = await CreateFolderAsync(accessToken, segment, parentId, ct);
                _log.Info("Drive: đã tạo thư mục " + path + ".");
            }

            _folderIds[path] = found;
            parentId = found;
        }

        return parentId ?? throw new InvalidOperationException("Đường dẫn thư mục rỗng.");
    }

    /// <summary>Id thư mục theo đường dẫn đã đảm bảo trước đó (null khi chưa từng tạo/tra trong phiên chạy này).</summary>
    public string? TryGetFolderId(string path)
        => _folderIds.TryGetValue(path, out string? id) ? id : null;

    /// <summary>
    /// Tra id thư mục theo từng đoạn đường dẫn mà KHÔNG tạo mới (dùng cho
    /// đợt dọn hạn giữ: con chưa từng có ảnh thì không được sinh thư mục
    /// rỗng trên Drive phụ huynh). Trả về null khi bất kỳ đoạn nào không
    /// tồn tại. Kết quả được cache như <see cref="EnsureFolderPathAsync"/>.
    /// </summary>
    public async Task<string?> FindFolderPathAsync(IReadOnlyList<string> segments, CancellationToken ct)
    {
        string accessToken = _accessToken ?? throw new InvalidOperationException("Chưa có access token Drive.");

        string? parentId = null;
        string path = string.Empty;
        foreach (string segment in segments)
        {
            path = path.Length == 0 ? segment : path + "/" + segment;
            if (_folderIds.TryGetValue(path, out string? cachedId))
            {
                parentId = cachedId;
                continue;
            }

            string? found = await FindFolderAsync(accessToken, segment, parentId, ct);
            if (found is null)
            {
                return null;
            }

            _folderIds[path] = found;
            parentId = found;
        }

        return parentId;
    }

    private async Task<string?> FindFolderAsync(string accessToken, string name, string? parentId, CancellationToken ct)
    {
        string query = "mimeType = 'application/vnd.google-apps.folder' and trashed = false and name = '" + EscapeQueryValue(name) + "'"
            + (parentId is null ? " and 'root' in parents" : " and '" + parentId + "' in parents");
        string url = FilesEndpoint + "?q=" + Uri.EscapeDataString(query) + "&fields=files(id,name)&pageSize=1";
        using JsonDocument document = await GetJsonAsync(accessToken, url, ct);
        if (document.RootElement.TryGetProperty("files", out JsonElement files)
            && files.ValueKind == JsonValueKind.Array
            && files.GetArrayLength() > 0
            && files[0].TryGetProperty("id", out JsonElement idElement)
            && idElement.GetString() is string id)
        {
            return id;
        }

        return null;
    }

    private async Task<string> CreateFolderAsync(string accessToken, string name, string? parentId, CancellationToken ct)
    {
        var metadata = new Dictionary<string, object>
        {
            ["name"] = name,
            ["mimeType"] = "application/vnd.google-apps.folder",
        };
        if (parentId is not null)
        {
            metadata["parents"] = new[] { parentId };
        }

        using var request = new HttpRequestMessage(HttpMethod.Post, FilesEndpoint + "?fields=id");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        request.Content = new StringContent(JsonSerializer.Serialize(metadata), Encoding.UTF8, "application/json");
        using JsonDocument document = await SendJsonAsync(request, ct);
        return document.RootElement.GetProperty("id").GetString()
            ?? throw new DriveRequestException(200, "Drive không trả id thư mục vừa tạo.");
    }

    /// <summary>
    /// Upload một file ảnh vào thư mục đã có (multipart/related: phần
    /// metadata JSON + phần dữ liệu JPEG). Trả về Drive file id.
    /// </summary>
    public async Task<string> UploadFileAsync(string folderId, string fileName, byte[] bytes, CancellationToken ct)
    {
        string accessToken = _accessToken ?? throw new InvalidOperationException("Chưa có access token Drive.");

        string boundary = "SafePCBoundary" + Guid.NewGuid().ToString("N");
        string metadataJson = JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["name"] = fileName,
            ["parents"] = new[] { folderId },
        });

        using var body = new MemoryStream();
        void WriteText(string text)
        {
            byte[] chunk = Encoding.UTF8.GetBytes(text);
            body.Write(chunk, 0, chunk.Length);
        }

        WriteText("--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + metadataJson + "\r\n");
        WriteText("--" + boundary + "\r\nContent-Type: image/jpeg\r\n\r\n");
        body.Write(bytes, 0, bytes.Length);
        WriteText("\r\n--" + boundary + "--\r\n");
        body.Position = 0;

        using var request = new HttpRequestMessage(HttpMethod.Post, UploadEndpoint + "?uploadType=multipart&fields=id");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        request.Content = new StreamContent(body);
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("multipart/related") { Parameters = { new NameValueHeaderValue("boundary", boundary) } };

        using JsonDocument document = await SendJsonAsync(request, ct);
        return document.RootElement.GetProperty("id").GetString()
            ?? throw new DriveRequestException(200, "Drive không trả id file vừa upload.");
    }

    /// <summary>Liệt kê các mục con trực tiếp của một thư mục (chỉ id + tên + loại), tối đa 1000 mục.</summary>
    public async Task<IReadOnlyList<(string Id, string Name, bool IsFolder)>> ListChildrenAsync(string folderId, CancellationToken ct)
    {
        string accessToken = _accessToken ?? throw new InvalidOperationException("Chưa có access token Drive.");

        string query = "'" + folderId + "' in parents and trashed = false";
        string url = FilesEndpoint + "?q=" + Uri.EscapeDataString(query) + "&fields=files(id,name,mimeType)&pageSize=1000";
        using JsonDocument document = await GetJsonAsync(accessToken, url, ct);

        var children = new List<(string Id, string Name, bool IsFolder)>();
        if (document.RootElement.TryGetProperty("files", out JsonElement files) && files.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement file in files.EnumerateArray())
            {
                if (file.TryGetProperty("id", out JsonElement idElement) && idElement.GetString() is string id
                    && file.TryGetProperty("name", out JsonElement nameElement) && nameElement.GetString() is string name)
                {
                    bool isFolder = file.TryGetProperty("mimeType", out JsonElement mimeElement)
                        && mimeElement.GetString() == "application/vnd.google-apps.folder";
                    children.Add((id, name, isFolder));
                }
            }
        }

        return children;
    }

    /// <summary>Xóa VĨNH VIỄN một file/thư mục trên Drive (files.delete, không vào thùng rác) — dùng cho dọn hạn giữ dữ liệu trẻ em. 404 coi như đã xóa.</summary>
    public async Task<bool> DeleteFileAsync(string fileId, CancellationToken ct)
    {
        string accessToken = _accessToken ?? throw new InvalidOperationException("Chưa có access token Drive.");

        using var request = new HttpRequestMessage(HttpMethod.Delete, FilesEndpoint + "/" + Uri.EscapeDataString(fileId));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);

        HttpResponseMessage response;
        try
        {
            response = await _http.SendAsync(request, ct);
        }
        catch (HttpRequestException ex)
        {
            _log.Warning("Drive: xóa file lỗi mạng: " + ex.Message);
            return false;
        }

        using (response)
        {
            if (response.IsSuccessStatusCode || (int)response.StatusCode == 404)
            {
                return true;
            }

            if ((int)response.StatusCode == 401)
            {
                throw new DriveRequestException(401, "Drive trả 401 khi xóa file.");
            }

            _log.Warning("Drive: xóa file bị từ chối (HTTP " + (int)response.StatusCode + ").");
            return false;
        }
    }

    private async Task<JsonDocument> GetJsonAsync(string accessToken, string url, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        return await SendJsonAsync(request, ct);
    }

    /// <summary>Gửi một request Drive và parse body JSON. Lỗi HTTP thì ném <see cref="DriveRequestException"/> mang mã trạng thái; lỗi mạng thì ném HttpRequestException như thường.</summary>
    private async Task<JsonDocument> SendJsonAsync(HttpRequestMessage request, CancellationToken ct)
    {
        HttpResponseMessage response = await _http.SendAsync(request, ct);
        using (response)
        {
            string body = await response.Content.ReadAsStringAsync(ct);
            if (!response.IsSuccessStatusCode)
            {
                throw new DriveRequestException((int)response.StatusCode, "Drive API trả HTTP " + (int)response.StatusCode + ".");
            }

            return JsonDocument.Parse(body.Length == 0 ? "{}" : body);
        }
    }

    /// <summary>Escape giá trị trong query Drive API: dấu ' thành \' và \ thành \\.</summary>
    private static string EscapeQueryValue(string value)
        => value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("'", "\\'", StringComparison.Ordinal);
}

/// <summary>
/// Average-hash 16x16 grayscale cho khử trùng lặp ảnh chụp màn hình
/// (docs/11 mục 1.5, bản Agent): thu nhỏ ảnh về 16x16, lấy độ sáng từng
/// pixel, bit = 1 khi sáng ≥ trung bình của 256 pixel → 256 bit (32 byte,
/// lưu hex trong device_state). Hai ảnh được coi là "gần như không đổi"
/// khi khoảng cách Hamming ≤ <see cref="DuplicateThresholdBits"/> bit
/// (5/256 ≈ 98% tương đồng — đã chọn: đủ chặt để thay đổi nội dung thật
/// (mở trang mới, gõ thêm đoạn văn) luôn vượt ngưỡng, đủ lỏng cho nhiễu
/// nén JPEG/đồng hồ giây trên màn hình đứng yên).
/// </summary>
public static class ScreenshotHash
{
    /// <summary>Ngưỡng khử trùng lặp đã chọn: Hamming distance ≤ 5 trên 256 bit thì coi là ảnh trùng.</summary>
    public const int DuplicateThresholdBits = 5;

    /// <summary>Tính average-hash của một ảnh JPEG. Null khi ảnh không giải mã được (nơi gọi coi như không trùng, vẫn upload).</summary>
    public static byte[]? ComputeAverageHash(byte[] jpegBytes)
    {
        try
        {
            using var sourceStream = new MemoryStream(jpegBytes);
            using var source = new Bitmap(sourceStream);
            using var small = new Bitmap(16, 16);
            using (Graphics graphics = Graphics.FromImage(small))
            {
                graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Bilinear;
                graphics.DrawImage(source, 0, 0, 16, 16);
            }

            var gray = new int[256];
            long sum = 0;
            for (int y = 0; y < 16; y++)
            {
                for (int x = 0; x < 16; x++)
                {
                    Color pixel = small.GetPixel(x, y);
                    int value = (pixel.R * 299 + pixel.G * 587 + pixel.B * 114) / 1000;
                    gray[y * 16 + x] = value;
                    sum += value;
                }
            }

            double mean = sum / 256.0;
            var hash = new byte[32];
            for (int i = 0; i < 256; i++)
            {
                if (gray[i] >= mean)
                {
                    hash[i / 8] |= (byte)(1 << (7 - (i % 8)));
                }
            }

            return hash;
        }
        catch (Exception)
        {
            // Ảnh hỏng/không giải mã được: không kết luận trùng.
            return null;
        }
    }

    /// <summary>Khoảng cách Hamming (số bit khác nhau) giữa hai hash cùng độ dài. Khác độ dài thì trả về int.MaxValue (không coi là trùng).</summary>
    public static int HammingDistance(byte[] a, byte[] b)
    {
        if (a.Length != b.Length)
        {
            return int.MaxValue;
        }

        int distance = 0;
        for (int i = 0; i < a.Length; i++)
        {
            int xor = a[i] ^ b[i];
            while (xor != 0)
            {
                distance += xor & 1;
                xor >>= 1;
            }
        }

        return distance;
    }

    /// <summary>Hash dạng hex để lưu trong device_state.</summary>
    public static string ToHex(byte[] hash) => Convert.ToHexString(hash).ToLowerInvariant();

    /// <summary>Đọc hash từ hex đã lưu. Null khi chuỗi không hợp lệ.</summary>
    public static byte[]? FromHex(string? hex)
    {
        if (string.IsNullOrWhiteSpace(hex))
        {
            return null;
        }

        try
        {
            return Convert.FromHexString(hex);
        }
        catch (FormatException)
        {
            return null;
        }
    }
}
