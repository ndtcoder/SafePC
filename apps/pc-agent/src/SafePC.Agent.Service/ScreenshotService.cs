using System.Globalization;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>
/// Luồng chụp màn hình phía Service (migration 32, quyết định anh Tiến
/// 28/11/2026 — mô hình sửa 11:16: phụ huynh bật/tắt theo từng con trên
/// Dashboard, KHÔNG có đồng ý phía con; con chỉ được Tray thông báo minh
/// bạch hằng tuần):
///
/// 1. Mỗi tick (60 giây, AgentWorker gọi): tải cài đặt theo con qua RPC
///    <c>safepc_fetch_screen_settings</c> về cache trong bộ nhớ (RPC chưa
///    có/lỗi mạng → giữ cache cũ), rồi báo trạng thái hiệu lực cho Tray
///    của PHIÊN CONSOLE đang active qua IPC
///    (<see cref="IpcMessageTypes.ScreenCaptureState"/>, chỉ gửi khi đổi
///    để không spam log pipe — ngoại trừ khi Tray của phiên hello lại
///    thì gửi lại ngay). Đây là đường IPC đã chọn: mở rộng mẫu
///    hello/state-sync hiện có bằng một message Service→Tray theo phiên
///    (SendToSessionAsync), không thêm kênh mới — Tray của con không
///    active không nhận trạng thái và không chụp.
/// 2. Xử lý hàng đợi <c>screen_queue</c>: Tray ghi cặp .jpg + .json
///    (SID, thời điểm, kích thước). Service đối chiếu SID→con như web
///    usage (ánh xạ migration 24, fallback con mặc định khi máy chưa có
///    ánh xạ nào), bỏ qua (xóa) file của con không bật chụp, khử trùng
///    lặp bằng average-hash so với ảnh gần nhất đã đẩy metadata thành
///    công của cùng con,
///    upload thẳng lên Drive phụ huynh (xem <see cref="DriveUploader"/>),
///    đẩy metadata qua RPC rồi mới xóa file local.
/// 3. Chính sách thử lại file lỗi (đã chọn): lỗi mạng/Drive tạm thời thì
///    GIỮ file, thử lại tick sau; tối đa 10 lần thử trong một phiên chạy
///    Service HOẶC file quá 7 ngày tuổi (theo captured_at) thì xóa cặp
///    file + ghi log Warning — hàng đợi không bao giờ kẹt vô hạn và
///    không phình đĩa khi Drive chết hẳn. Ảnh đã upload mà đẩy metadata
///    lỗi thì ghi drive_file_id vào .json: lần thử lại chỉ đẩy metadata.
/// 4. Dọn Drive theo hạn giữ 1 lần/ngày: thư mục ngày (theo múi giờ gia
///    đình) cũ hơn retention_days của từng con → xóa file trong đó +
///    xóa thư mục + purge metadata phía server.
/// 5. Refresh token bị Google thu hồi (invalid_grant): báo server
///    (<c>safepc_report_drive_disconnected</c>) + tamper event
///    'drive_disconnected' (throttle 1 lần/giờ như các tamper khác) +
///    ghi hash token đã chết vào device_state + xóa token cache cục bộ;
///    từ đó EnsureAccessToken trả NoToken cho tới khi fetch được token
///    MỚI khác hẳn (phụ huynh kết nối lại Drive).
///
/// Mọi lỗi đều chỉ ghi log — tick này không bao giờ làm chết AgentWorker.
/// </summary>
public sealed class ScreenshotService
{
    /// <summary>Số lần thử tối đa cho một cặp file trong một phiên chạy Service trước khi bỏ (kèm trần tuổi 7 ngày bên dưới).</summary>
    private const int MaxAttemptsPerRun = 10;

    /// <summary>Trần tuổi file trong hàng đợi: captured_at quá 7 ngày mà vẫn chưa upload được thì xóa (mất ảnh cũ còn hơn kẹt đĩa vô hạn).</summary>
    private static readonly TimeSpan MaxQueueAge = TimeSpan.FromDays(7);

    private readonly LocalLogger _log;
    private readonly SupabaseApiClient _api;
    private readonly OutboxStore _outbox;
    private readonly IpcPipeServer _ipc;
    private readonly DriveUploader _drive;
    private readonly TrustedClock _clock;

    // Cache cài đặt theo child_id (thay toàn bộ mỗi lần fetch thành công).
    private readonly Dictionary<Guid, ScreenSettingsRecord> _settings = new();

    // Trạng thái chụp đã gửi cho từng phiên (chữ ký "enabled|interval|child")
    // để chỉ gửi IPC khi đổi — vòng tick 60s không spam log pipe.
    private readonly Dictionary<int, string> _sentStateBySession = new();

    // LastHelloAt của từng phiên ở lần tick gần nhất đã thấy (qua
    // IpcPipeServer.GetTraySessionSnapshot): Tray khởi động lại trong
    // cùng phiên sẽ hello lại → mốc này đổi → xóa chữ ký đã gửi của
    // phiên để trạng thái chụp được gửi lại cho Tray mới (M4).
    private readonly Dictionary<int, DateTimeOffset> _seenHelloBySession = new();

    // Số lần thử upload thất bại theo đường dẫn file .jpg, trong phiên chạy.
    private readonly Dictionary<string, int> _attempts = new(StringComparer.OrdinalIgnoreCase);

    private bool _rpcMissingWarned;

    public ScreenshotService(
        LocalLogger log,
        SupabaseApiClient api,
        OutboxStore outbox,
        IpcPipeServer ipc,
        DriveUploader drive,
        TrustedClock clock)
    {
        _log = log;
        _api = api;
        _outbox = outbox;
        _ipc = ipc;
        _drive = drive;
        _clock = clock;
    }

    /// <summary>
    /// Một tick chụp màn hình: đồng bộ cài đặt + báo trạng thái xuống Tray
    /// phiên console + xử lý hàng đợi + dọn hạn giữ (khi tới ngày). Tự bắt
    /// mọi lỗi (trừ hủy). Ngữ cảnh phiên/con do AgentWorker phân giải
    /// (cùng ActiveContext với vòng rules) để không lệch nhau giữa chừng.
    /// </summary>
    public async Task TickAsync(
        int? consoleSessionId,
        ActiveChildStatus status,
        Guid? activeChildId,
        IReadOnlyList<ChildAccountLink> links,
        Guid? defaultChildId,
        CancellationToken ct)
    {
        try
        {
            await RefreshSettingsAsync(ct);
            await SendStateToConsoleTrayAsync(consoleSessionId, status, activeChildId, ct);

            bool anyEnabled = _settings.Values.Any(s => s.Enabled);
            if (anyEnabled || _settings.Count > 0)
            {
                DriveAccessStatus access = await _drive.EnsureAccessTokenAsync(ct);
                switch (access)
                {
                    case DriveAccessStatus.Ready:
                        if (anyEnabled)
                        {
                            await ProcessQueueAsync(links, defaultChildId, ct);
                        }

                        // Dọn hạn giữ chạy cả khi MỌI con đều đang tắt
                        // chụp (chỉ cần còn cài đặt + token Ready): phụ
                        // huynh tắt chụp không có nghĩa là ảnh cũ được
                        // giữ quá hạn giữ đã hứa.
                        await MaybeCleanupExpiredAsync(ct);
                        break;

                    case DriveAccessStatus.Revoked:
                        await HandleDriveRevokedAsync(ct);
                        break;

                    case DriveAccessStatus.NoToken:
                        // Phụ huynh chưa kết nối Drive (hoặc token cũ đã
                        // bị thu hồi và chưa kết nối lại): hàng đợi giữ
                        // nguyên trong trần tuổi, không log ồn mỗi tick —
                        // DriveUploader/API đã log throttled phần của nó.
                        break;

                    default:
                        // Failed: lỗi tạm thời, tick sau thử lại.
                        break;
                }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.Error("Chụp màn hình: tick lỗi.", ex);
        }
    }

    /// <summary>Tải cài đặt chụp màn hình về cache. Null (lỗi/RPC chưa áp) thì giữ cache cũ; RPC chưa áp chỉ cảnh báo một lần cho tới khi tải thành công trở lại.</summary>
    private async Task RefreshSettingsAsync(CancellationToken ct)
    {
        IReadOnlyList<ScreenSettingsRecord>? fetched = await _api.FetchScreenSettingsAsync(ct);
        if (fetched is null)
        {
            if (!_rpcMissingWarned)
            {
                _rpcMissingWarned = true;
                _log.Warning("Chụp màn hình: chưa tải được cài đặt từ server (mất mạng hoặc migration 32 chưa áp) — giữ cache cũ, chụp theo cài đặt gần nhất đã biết.");
            }

            return;
        }

        _rpcMissingWarned = false;
        _settings.Clear();
        foreach (ScreenSettingsRecord record in fetched)
        {
            // Kẹp nhịp chụp vào khoảng hợp lệ 1–1440 phút: giá trị lạ từ
            // server (sửa tay DB) không được làm Tray chụp liên tục.
            record.IntervalMinutes = Math.Clamp(record.IntervalMinutes, 1, 1440);
            record.RetentionDays = Math.Clamp(record.RetentionDays, 1, 366);
            _settings[record.ChildId] = record;
        }
    }

    /// <summary>
    /// Báo trạng thái hiệu lực cho Tray của phiên console: chỉ phiên
    /// console mới nhận (phiên nền không chụp). Phiên admin/chưa gắn hồ
    /// sơ → trạng thái tắt (dừng chụp nếu Tray đó đang chạy timer từ
    /// trạng thái cũ). Chỉ gửi khi chữ ký trạng thái đổi cho phiên đó —
    /// NGOẠI TRỪ khi Tray của phiên vừa hello lại (khởi động lại trong
    /// cùng phiên hoặc nối lại pipe): Tray mới chưa có trạng thái nào
    /// trong bộ nhớ, phải gửi lại ngay tick này dù chữ ký không đổi
    /// (cùng tinh thần hello-sync của IpcPipeServer).
    /// </summary>
    private async Task SendStateToConsoleTrayAsync(int? consoleSessionId, ActiveChildStatus status, Guid? activeChildId, CancellationToken ct)
    {
        if (consoleSessionId is null)
        {
            return;
        }

        // M4: phát hiện hello mới của ĐÚNG phiên console qua snapshot
        // hello của IpcPipeServer (LastHelloAt đổi = Tray vừa giới
        // thiệu lại). Xóa chữ ký đã gửi của phiên để đoạn kiểm chữ ký
        // bên dưới không chặn việc gửi lại cho Tray mới.
        foreach (TraySessionSnapshot snapshot in _ipc.GetTraySessionSnapshot())
        {
            if (snapshot.SessionId != consoleSessionId.Value)
            {
                continue;
            }

            if (_seenHelloBySession.TryGetValue(snapshot.SessionId, out DateTimeOffset seenHello)
                && seenHello != snapshot.LastHelloAt)
            {
                _sentStateBySession.Remove(snapshot.SessionId);
            }

            _seenHelloBySession[snapshot.SessionId] = snapshot.LastHelloAt;
        }

        bool enabled = false;
        int interval = 0;
        Guid? childId = null;
        if ((status == ActiveChildStatus.Active || status == ActiveChildStatus.NoSessionInfo)
            && activeChildId is not null
            && _settings.TryGetValue(activeChildId.Value, out ScreenSettingsRecord? settings)
            && settings.Enabled)
        {
            enabled = true;
            interval = settings.IntervalMinutes;
            childId = activeChildId.Value;
        }

        string signature = enabled + "|" + interval + "|" + (childId?.ToString("N") ?? "-");
        if (_sentStateBySession.TryGetValue(consoleSessionId.Value, out string? last) && last == signature)
        {
            return;
        }

        _sentStateBySession[consoleSessionId.Value] = signature;
        int sent = await _ipc.SendToSessionAsync(
            consoleSessionId.Value,
            IpcMessage.Create(IpcMessageTypes.ScreenCaptureState, new ScreenCaptureStatePayload(enabled, interval, childId)),
            ct);
        _log.Info("Chụp màn hình: đã báo trạng thái cho Tray phiên #" + consoleSessionId.Value
            + " (bật=" + enabled + ", giao tới " + sent + " writer).");
    }

    /// <summary>
    /// Xử lý toàn bộ cặp file đang chờ trong screen_queue, cũ nhất trước.
    /// Drive đang 401 giữa chừng thì dừng cả đợt (token sẽ được đổi ở
    /// tick sau); lỗi từng file thì đếm lần thử và đi tiếp file sau.
    /// </summary>
    private async Task ProcessQueueAsync(IReadOnlyList<ChildAccountLink> links, Guid? defaultChildId, CancellationToken ct)
    {
        string queueDirectory = EnsureQueueDirectory();
        string[] jsonFiles;
        try
        {
            jsonFiles = Directory.GetFiles(queueDirectory, "*.json");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.Error("Chụp màn hình: không liệt kê được hàng đợi ảnh.", ex);
            return;
        }

        Array.Sort(jsonFiles, StringComparer.OrdinalIgnoreCase);
        foreach (string jsonPath in jsonFiles)
        {
            if (ct.IsCancellationRequested)
            {
                return;
            }

            string jpgPath = Path.ChangeExtension(jsonPath, ".jpg");
            try
            {
                await ProcessQueueItemAsync(jsonPath, jpgPath, links, defaultChildId, ct);
            }
            catch (DriveRequestException ex) when (ex.StatusCode == 401)
            {
                // Access token bị thu hồi giữa chừng: xóa cache để tick
                // sau đổi token mới, dừng đợt này (mọi file sau cũng 401).
                _drive.InvalidateAccessToken();
                _log.Warning("Chụp màn hình: Drive trả 401, sẽ đổi access token ở vòng sau.");
                return;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                RegisterFailure(jpgPath, "xử lý file hàng đợi lỗi: " + ex.Message);
            }
        }
    }

    private async Task ProcessQueueItemAsync(string jsonPath, string jpgPath, IReadOnlyList<ChildAccountLink> links, Guid? defaultChildId, CancellationToken ct)
    {
        if (!File.Exists(jpgPath))
        {
            // Có metadata mà mất ảnh: cặp hỏng, xóa để không kẹt.
            DeletePair(jsonPath, jpgPath);
            return;
        }

        ScreenshotQueueMetadata? meta;
        try
        {
            meta = JsonSerializer.Deserialize<ScreenshotQueueMetadata>(await File.ReadAllTextAsync(jsonPath, ct));
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            // Lỗi ĐỌC/parse tạm thời (Tray có thể đang ghi dở file .json
            // — race ghi/đọc): KHÔNG xóa cặp, đếm lần thử rồi tick sau
            // đọc lại (RegisterFailure tự bỏ cặp khi quá 10 lần thử nên
            // hàng đợi vẫn không kẹt vô hạn).
            RegisterFailure(jpgPath, "đọc metadata hàng đợi lỗi tạm thời, giữ file thử lại vòng sau: " + ex.Message);
            return;
        }

        if (meta is null || meta.CapturedAt == default)
        {
            // Đọc được nhưng nội dung không hợp lệ THẬT SỰ (rỗng hoặc
            // thiếu trường bắt buộc captured_at): cặp hỏng vĩnh viễn,
            // xóa để không kẹt hàng đợi.
            _log.Warning("Chụp màn hình: metadata hàng đợi không hợp lệ (rỗng/thiếu captured_at), xóa cặp file.");
            DeletePair(jsonPath, jpgPath);
            return;
        }

        // Trần tuổi: ảnh quá cũ mà vẫn nằm hàng đợi (Drive chết dài ngày)
        // thì bỏ — giữ vô hạn sẽ phình đĩa và đẩy ảnh quá cũ vô nghĩa.
        if (DateTimeOffset.UtcNow - meta.CapturedAt > MaxQueueAge)
        {
            _log.Warning("Chụp màn hình: bỏ một ảnh trong hàng đợi vì quá 7 ngày chưa upload được.");
            DeletePair(jsonPath, jpgPath);
            return;
        }

        Guid? childId = ResolveChildForSid(meta.WindowsSid, links, defaultChildId);
        if (childId is null)
        {
            // SID không thuộc hồ sơ con nào đã gắn (và máy đã có ánh xạ):
            // phiên đó không được quản lý — bỏ ảnh, không upload.
            _log.Info("Chụp màn hình: bỏ một ảnh vì phiên chụp không thuộc hồ sơ con nào đã gắn.");
            DeletePair(jsonPath, jpgPath);
            return;
        }

        if (!_settings.TryGetValue(childId.Value, out ScreenSettingsRecord? settings) || !settings.Enabled)
        {
            // Con không bật chụp (phụ huynh đã tắt sau khi ảnh chụp, hoặc
            // ảnh từ phiên cũ): bỏ qua theo đúng thiết kế, xóa để hàng
            // đợi không phình.
            DeletePair(jsonPath, jpgPath);
            return;
        }

        byte[] bytes = await File.ReadAllBytesAsync(jpgPath, ct);

        string driveFileId;
        if (!string.IsNullOrWhiteSpace(meta.DriveFileId))
        {
            // Đã upload ở lần thử trước, chỉ còn đẩy metadata.
            driveFileId = meta.DriveFileId;
        }
        else
        {
            // Khử trùng lặp: hash ảnh này so với hash ảnh gần nhất ĐÃ
            // upload của cùng con — tương đồng ≤ ngưỡng thì bỏ upload.
            byte[]? hash = ScreenshotHash.ComputeAverageHash(bytes);
            if (hash is not null)
            {
                byte[]? lastHash = ScreenshotHash.FromHex(await _outbox.GetStateAsync(StateKeys.ScreenLastHashForChild(childId.Value), ct));
                if (lastHash is not null
                    && ScreenshotHash.HammingDistance(hash, lastHash) <= ScreenshotHash.DuplicateThresholdBits)
                {
                    _log.Info("Chụp màn hình: bỏ một ảnh trùng lặp (màn hình gần như không đổi so với ảnh đã upload gần nhất).");
                    DeletePair(jsonPath, jpgPath);
                    return;
                }
            }

            DateTimeOffset familyTime = _clock.ToFamily(meta.CapturedAt);
            string day = familyTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            string folderId = await _drive.EnsureFolderPathAsync(
                new[] { "SafePC", SanitizeFolderName(settings.ChildName, childId.Value), day }, ct);
            string fileName = familyTime.ToString("HHmmss", CultureInfo.InvariantCulture) + "-" + Path.GetFileNameWithoutExtension(jpgPath) + ".jpg";
            driveFileId = await _drive.UploadFileAsync(folderId, fileName, bytes, ct);

            // Ghi drive_file_id vào metadata TRƯỚC khi đẩy metadata lên
            // server: đẩy lỗi thì lần thử lại không upload trùng ảnh.
            // Hash khử trùng lặp cũng ghi vào metadata cùng lúc này —
            // nhưng hash "ảnh gần nhất" trong device_state CHỈ được cập
            // nhật SAU khi đẩy metadata thành công (bên dưới): ghi sớm
            // ở đây sẽ làm ảnh kế tiếp bị coi là trùng với một ảnh mà
            // server chưa hề ghi nhận khi lần đẩy này thất bại hẳn.
            meta.DriveFileId = driveFileId;
            if (hash is not null)
            {
                meta.HashHex = ScreenshotHash.ToHex(hash);
            }

            try
            {
                await File.WriteAllTextAsync(jsonPath, JsonSerializer.Serialize(meta), ct);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _log.Warning("Chụp màn hình: không ghi được drive_file_id vào metadata hàng đợi (lần sau có thể upload trùng một ảnh): " + ex.Message);
            }
        }

        var record = new ScreenshotMetaRecord
        {
            ChildId = childId.Value,
            WindowsSid = meta.WindowsSid,
            Day = _clock.ToFamily(meta.CapturedAt).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            CapturedAt = meta.CapturedAt,
            DriveFileId = driveFileId,
            SizeBytes = bytes.LongLength,
            Width = meta.Width,
            Height = meta.Height,
        };
        if (!await _api.PushScreenshotMetaAsync(new[] { record }, ct))
        {
            RegisterFailure(jpgPath, "đẩy metadata ảnh lên server lỗi, giữ file thử lại vòng sau.");
            return;
        }

        // Đẩy metadata thành công — TỚI LÚC NÀY mới ghi hash "ảnh gần
        // nhất" của con (hash đã tính nằm trong metadata hàng đợi, cả ở
        // đường upload mới lẫn đường thử lại chỉ-đẩy-metadata).
        if (!string.IsNullOrWhiteSpace(meta.HashHex))
        {
            await _outbox.SetStateAsync(StateKeys.ScreenLastHashForChild(childId.Value), meta.HashHex, ct);
        }

        _attempts.Remove(jpgPath);
        DeletePair(jsonPath, jpgPath);
    }

    /// <summary>
    /// Đối chiếu SID của phiên đã chụp ra hồ sơ con — cùng luật với
    /// ActiveChildResolver: khớp ánh xạ thì ra con đó; máy CHƯA có ánh
    /// xạ nào (hoặc ảnh không mang SID) thì rơi về con mặc định; đã có
    /// ánh xạ mà SID lạ thì null (phiên không được quản lý).
    /// </summary>
    private static Guid? ResolveChildForSid(string? sid, IReadOnlyList<ChildAccountLink> links, Guid? defaultChildId)
    {
        if (!string.IsNullOrWhiteSpace(sid))
        {
            foreach (ChildAccountLink link in links)
            {
                if (string.Equals(link.WindowsSid, sid, StringComparison.Ordinal))
                {
                    return link.ChildId;
                }
            }

            return links.Count == 0 ? defaultChildId : null;
        }

        return defaultChildId;
    }

    /// <summary>Đếm một lần thử thất bại; đạt trần 10 lần trong phiên chạy thì xóa cặp file để hàng đợi không kẹt vô hạn.</summary>
    private void RegisterFailure(string jpgPath, string reason)
    {
        int attempts = _attempts.TryGetValue(jpgPath, out int current) ? current + 1 : 1;
        _attempts[jpgPath] = attempts;
        if (attempts >= MaxAttemptsPerRun)
        {
            _attempts.Remove(jpgPath);
            _log.Warning("Chụp màn hình: bỏ một ảnh sau " + attempts + " lần thử thất bại (" + reason + ").");
            DeletePair(Path.ChangeExtension(jpgPath, ".json"), jpgPath);
            return;
        }

        _log.Warning("Chụp màn hình: " + reason + " (lần thử " + attempts + "/" + MaxAttemptsPerRun + ").");
    }

    /// <summary>Xóa cặp .jpg + .json khỏi hàng đợi. Lỗi xóa chỉ ghi log — file còn lại sẽ được xử lý/dọn ở tick sau.</summary>
    private void DeletePair(string jsonPath, string jpgPath)
    {
        _attempts.Remove(jpgPath);
        foreach (string path in new[] { jpgPath, jsonPath })
        {
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _log.Warning("Chụp màn hình: không xóa được file hàng đợi " + Path.GetFileName(path) + ": " + ex.Message);
            }
        }
    }

    /// <summary>
    /// Dọn Drive theo hạn giữ, tối đa 1 lần/ngày (mốc bền trong
    /// device_state theo ngày giờ tin cậy): với mỗi con có cài đặt, thư
    /// mục ngày cũ hơn retention_days → xóa mọi file trong đó, xóa thư
    /// mục ngày, rồi purge metadata phía server cho đúng (con, ngày).
    /// Chỉ xóa file/thư mục app tạo (scope drive.file tự giới hạn).
    /// </summary>
    private async Task MaybeCleanupExpiredAsync(CancellationToken ct)
    {
        string today = _clock.FamilyNow.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        string? lastCleanup = await _outbox.GetStateAsync(StateKeys.ScreenCleanupDay, ct);
        if (lastCleanup == today)
        {
            return;
        }

        foreach (ScreenSettingsRecord settings in _settings.Values)
        {
            string childFolderName = SanitizeFolderName(settings.ChildName, settings.ChildId);
            string? childFolderId = await _drive.FindFolderPathAsync(new[] { "SafePC", childFolderName }, ct);
            if (childFolderId is null)
            {
                continue;
            }

            DateTime cutoff = _clock.FamilyNow.Date.AddDays(-settings.RetentionDays);
            IReadOnlyList<(string Id, string Name, bool IsFolder)> children = await _drive.ListChildrenAsync(childFolderId, ct);
            foreach ((string id, string name, bool isFolder) in children)
            {
                if (!isFolder
                    || !DateTime.TryParseExact(name, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out DateTime folderDay)
                    || folderDay.Date >= cutoff)
                {
                    continue;
                }

                // Xóa từng file trong thư mục ngày trước, rồi thư mục.
                bool allDeleted = true;
                IReadOnlyList<(string Id, string Name, bool IsFolder)> files = await _drive.ListChildrenAsync(id, ct);
                foreach ((string fileId, _, _) in files)
                {
                    if (!await _drive.DeleteFileAsync(fileId, ct))
                    {
                        allDeleted = false;
                    }
                }

                if (allDeleted && await _drive.DeleteFileAsync(id, ct))
                {
                    await _api.PurgeScreenshotMetaAsync(settings.ChildId, name, ct);
                    _log.Info("Chụp màn hình: đã dọn thư mục ảnh ngày " + name + " (quá hạn giữ " + settings.RetentionDays + " ngày).");
                }
                else
                {
                    _log.Warning("Chụp màn hình: dọn thư mục ảnh ngày " + name + " chưa xong, sẽ thử lại lần dọn sau.");
                }
            }
        }

        await _outbox.SetStateAsync(StateKeys.ScreenCleanupDay, today, ct);
    }

    /// <summary>
    /// Refresh token bị Google thu hồi: báo server + tamper event
    /// 'drive_disconnected' (throttle 1 giờ qua device_state như các
    /// tamper khác), ghi hash token chết để không thử lại token đó, xóa
    /// token cache cục bộ. Upload dừng từ đây cho tới khi fetch được
    /// token mới (EnsureAccessToken tự xử lý qua hash đã ghi).
    /// </summary>
    private async Task HandleDriveRevokedAsync(CancellationToken ct)
    {
        _log.Warning("Chụp màn hình: Google Drive đã ngắt kết nối (refresh token bị thu hồi) — dừng upload, chờ phụ huynh kết nối lại.");

        string? revoked = _drive.LastRevokedRefreshToken;
        if (!string.IsNullOrEmpty(revoked))
        {
            await _outbox.SetStateAsync(StateKeys.ScreenRevokedDriveTokenHash, Hashing.HashSecret(revoked), ct);
        }

        _drive.InvalidateLocalTokens();
        await _api.ReportDriveDisconnectedAsync(ct);

        try
        {
            string? lastSentText = await _outbox.GetStateAsync(StateKeys.TamperDriveDisconnectedLastSent, ct);
            bool throttled = lastSentText is not null
                && DateTimeOffset.TryParse(lastSentText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset lastSent)
                && DateTimeOffset.UtcNow - lastSent < TimeSpan.FromHours(1);
            if (!throttled
                && await _api.PushTamperEventAsync(
                    "drive_disconnected",
                    JsonSerializer.SerializeToElement(new { reason = "invalid_grant" }),
                    ct))
            {
                await _outbox.SetStateAsync(StateKeys.TamperDriveDisconnectedLastSent, DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture), ct);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.Error("Chụp màn hình: gửi tamper event drive_disconnected lỗi.", ex);
        }
    }

    /// <summary>Tên thư mục con trên Drive: bỏ ký tự cấm của tên file/thư mục; tên rỗng thì dùng hậu tố id con.</summary>
    private static string SanitizeFolderName(string? childName, Guid childId)
    {
        string name = (childName ?? string.Empty).Trim();
        foreach (char invalid in Path.GetInvalidFileNameChars())
        {
            name = name.Replace(invalid, '_');
        }

        name = name.Trim().Trim('.');
        return name.Length == 0 ? "Con-" + childId.ToString("N")[..8] : name;
    }

    /// <summary>
    /// Tạo thư mục hàng đợi ảnh (cùng gốc shared) và đặt ACL best-effort:
    /// SYSTEM toàn quyền, Users được sửa (Tray ở quyền user cần tạo file
    /// ảnh; Service SYSTEM đọc/xóa). Thất bại ACL thì chỉ ghi log — thư
    /// mục vẫn dùng được với ACL kế thừa của thư mục shared.
    /// </summary>
    private string EnsureQueueDirectory()
    {
        string directory = DomainRulesPublisher.ScreenQueueDirectory;
        Directory.CreateDirectory(directory);
        try
        {
            var directoryInfo = new DirectoryInfo(directory);
            DirectorySecurity security = directoryInfo.GetAccessControl();
            bool changed = false;
            changed |= AddRuleIfMissing(security, WellKnownSidType.LocalSystemSid, FileSystemRights.FullControl);
            changed |= AddRuleIfMissing(security, WellKnownSidType.BuiltinUsersSid, FileSystemRights.Modify);
            if (changed)
            {
                directoryInfo.SetAccessControl(security);
            }
        }
        catch (Exception ex)
        {
            _log.Warning("Chụp màn hình: không đặt được ACL cho thư mục hàng đợi ảnh, dùng ACL mặc định: " + ex.Message);
        }

        return directory;
    }

    /// <summary>Thêm một ACE kế thừa xuống file/thư mục con nếu chưa có rule tương đương (mẫu DomainRulesPublisher).</summary>
    private static bool AddRuleIfMissing(DirectorySecurity security, WellKnownSidType sidType, FileSystemRights rights)
    {
        var sid = new SecurityIdentifier(sidType, null);
        foreach (FileSystemAccessRule existing in security
            .GetAccessRules(includeExplicit: true, includeInherited: false, targetType: typeof(SecurityIdentifier))
            .OfType<FileSystemAccessRule>())
        {
            if (string.Equals(existing.IdentityReference.Value, sid.Value, StringComparison.Ordinal)
                && existing.AccessControlType == AccessControlType.Allow
                && (existing.FileSystemRights & rights) == rights
                && existing.InheritanceFlags == (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit))
            {
                return false;
            }
        }

        security.AddAccessRule(new FileSystemAccessRule(
            sid, rights, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        return true;
    }
}
