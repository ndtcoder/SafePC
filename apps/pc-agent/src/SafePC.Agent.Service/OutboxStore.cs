using System.Globalization;
using System.Text.Json;
using System.Threading;
using Microsoft.Data.Sqlite;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>Một bản ghi chờ gửi trong bảng outbox.</summary>
public sealed record OutboxItem(long Id, string PayloadJson);

/// <summary>Tổng hợp mẫu foreground theo app trong một khoảng thời gian, để gửi lên server.</summary>
public sealed record UsageSummary(string AppName, string? ExePathHash, long SampleCount, DateTimeOffset FirstSampledAt, DateTimeOffset LastSampledAt);

/// <summary>
/// Lưu trữ local SQLite cho Service (offline-first, docs/02-ARCHITECTURE.md mục 4.2):
/// - Bảng <c>outbox</c>: usage batch chưa gửi, retry với backoff.
/// - Bảng <c>rules_cache</c>: rules tải về lần cuối, để mất mạng vẫn thi hành đúng.
/// - Bảng <c>usage_samples</c>: mẫu foreground Tray gửi qua IPC, dùng ước lượng
///   thời gian đã dùng hôm nay.
/// - Bảng <c>active_override</c>: ghi đè tạm thời đang hiệu lực (tối đa 1 hàng),
///   để ghi đè không bị mất khi Service khởi động lại và vẫn hết hạn đúng giờ.
/// - Bảng <c>device_state</c>: trạng thái bền vững dạng khóa/giá trị (khóa
///   cưỡng chế của phụ huynh, watermark đẩy usage).
///
/// Mẫu foreground trong <c>usage_samples</c> KHÔNG bị xóa khi đã gửi lên
/// server (việc đếm giờ hôm nay cho daily_limit vẫn cần chúng); việc đẩy
/// usage dùng watermark (xem <see cref="GetUsageSummaryAsync"/>) và mẫu cũ
/// hơn 7 ngày được dọn định kỳ.
///
/// Mọi câu lệnh đều dùng tham số (parameterized) — không nối chuỗi SQL.
/// </summary>
public sealed class OutboxStore
{
    private readonly string _connectionString;

    public OutboxStore(string dbFilePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(dbFilePath);

        string? directory = Path.GetDirectoryName(dbFilePath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        _connectionString = new SqliteConnectionStringBuilder { DataSource = dbFilePath }.ToString();
    }

    /// <summary>Tạo các bảng nếu chưa có. Gọi một lần khi Service khởi động.</summary>
    public async Task InitializeAsync(CancellationToken ct)
    {
        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                next_retry_at TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS rules_cache (
                id TEXT PRIMARY KEY,
                family_id TEXT NOT NULL,
                child_id TEXT NOT NULL,
                type TEXT NOT NULL,
                config_json TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS usage_samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                app_name TEXT NOT NULL,
                exe_path_hash TEXT,
                sampled_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS active_override (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                action TEXT NOT NULL,
                minutes INTEGER NOT NULL,
                expires_at TEXT NOT NULL,
                domains_json TEXT,
                apps_json TEXT,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS device_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """;
        await command.ExecuteNonQueryAsync(ct);

        // Migration tại chỗ cho DB đã tồn tại từ bản trước Sprint 2 đợt 2:
        // bảng active_override cũ chưa có cột domains_json (ghi đè domain)
        // và apps_json (ghi đè app). CREATE TABLE IF NOT EXISTS không thêm
        // cột vào bảng đã có, nên kiểm tra PRAGMA và ALTER TABLE khi cần.
        // DB mới đã có cả hai cột từ CREATE TABLE ở trên nên các nhánh này
        // không chạy.
        await EnsureOverrideDomainsColumnAsync(connection, ct);
        await EnsureOverrideAppsColumnAsync(connection, ct);
    }

    /// <summary>Thêm cột <c>domains_json</c> vào bảng <c>active_override</c> nếu chưa có.</summary>
    private static async Task EnsureOverrideDomainsColumnAsync(SqliteConnection connection, CancellationToken ct)
    {
        bool hasColumn = false;
        await using (var pragma = connection.CreateCommand())
        {
            pragma.CommandText = "PRAGMA table_info(active_override);";
            await using var reader = await pragma.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                // PRAGMA table_info: cid, name, type, notnull, dflt_value, pk.
                if (reader.GetString(1) == "domains_json")
                {
                    hasColumn = true;
                    break;
                }
            }
        }

        if (!hasColumn)
        {
            await using var alter = connection.CreateCommand();
            alter.CommandText = "ALTER TABLE active_override ADD COLUMN domains_json TEXT;";
            await alter.ExecuteNonQueryAsync(ct);
        }
    }

    /// <summary>Thêm cột <c>apps_json</c> vào bảng <c>active_override</c> nếu chưa có (ghi đè app, mirror cột domains_json).</summary>
    private static async Task EnsureOverrideAppsColumnAsync(SqliteConnection connection, CancellationToken ct)
    {
        bool hasColumn = false;
        await using (var pragma = connection.CreateCommand())
        {
            pragma.CommandText = "PRAGMA table_info(active_override);";
            await using var reader = await pragma.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                // PRAGMA table_info: cid, name, type, notnull, dflt_value, pk.
                if (reader.GetString(1) == "apps_json")
                {
                    hasColumn = true;
                    break;
                }
            }
        }

        if (!hasColumn)
        {
            await using var alter = connection.CreateCommand();
            alter.CommandText = "ALTER TABLE active_override ADD COLUMN apps_json TEXT;";
            await alter.ExecuteNonQueryAsync(ct);
        }
    }

    /// <summary>Xếp một usage record vào outbox để gửi sau.</summary>
    public async Task EnqueueUsageAsync(UsageRecord record, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(record);

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO outbox (kind, payload_json, attempts, next_retry_at, created_at)
            VALUES ('usage', $payload, 0, $now, $now);
            """;
        command.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(record));
        command.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("o"));
        await command.ExecuteNonQueryAsync(ct);
    }

    /// <summary>Lấy các bản ghi đã đến hạn retry, cũ nhất trước.</summary>
    public async Task<IReadOnlyList<OutboxItem>> GetPendingAsync(int limit, CancellationToken ct)
    {
        var items = new List<OutboxItem>();

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, payload_json FROM outbox
            WHERE next_retry_at <= $now
            ORDER BY id ASC
            LIMIT $limit;
            """;
        command.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("o"));
        command.Parameters.AddWithValue("$limit", limit);

        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            items.Add(new OutboxItem(reader.GetInt64(0), reader.GetString(1)));
        }

        return items;
    }

    /// <summary>Xóa bản ghi đã gửi thành công khỏi outbox.</summary>
    public async Task MarkSentAsync(long id, CancellationToken ct)
    {
        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM outbox WHERE id = $id;";
        command.Parameters.AddWithValue("$id", id);
        await command.ExecuteNonQueryAsync(ct);
    }

    /// <summary>
    /// Ghi nhận một lần gửi thất bại: tăng attempts, hẹn retry sau với backoff
    /// lũy thừa (2, 4, 8... phút, tối đa 60 phút).
    /// </summary>
    public async Task MarkFailedAsync(long id, CancellationToken ct)
    {
        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        int attempts = 0;
        await using (var select = connection.CreateCommand())
        {
            select.CommandText = "SELECT attempts FROM outbox WHERE id = $id;";
            select.Parameters.AddWithValue("$id", id);
            object? value = await select.ExecuteScalarAsync(ct);
            if (value is long current)
            {
                attempts = (int)current;
            }
        }

        int nextAttempts = attempts + 1;
        double delayMinutes = Math.Min(Math.Pow(2, nextAttempts), 60);
        string nextRetryAt = DateTimeOffset.UtcNow.AddMinutes(delayMinutes).ToString("o");

        await using var update = connection.CreateCommand();
        update.CommandText = "UPDATE outbox SET attempts = $attempts, next_retry_at = $next WHERE id = $id;";
        update.Parameters.AddWithValue("$attempts", nextAttempts);
        update.Parameters.AddWithValue("$next", nextRetryAt);
        update.Parameters.AddWithValue("$id", id);
        await update.ExecuteNonQueryAsync(ct);
    }

    /// <summary>Thay toàn bộ cache rules bằng danh sách mới tải về.</summary>
    public async Task SaveRulesAsync(IReadOnlyList<Rule> rules, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(rules);

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var transaction = (SqliteTransaction)await connection.BeginTransactionAsync(ct);
        try
        {
            await using (var delete = connection.CreateCommand())
            {
                delete.Transaction = transaction;
                delete.CommandText = "DELETE FROM rules_cache;";
                await delete.ExecuteNonQueryAsync(ct);
            }

            foreach (Rule rule in rules)
            {
                await using var insert = connection.CreateCommand();
                insert.Transaction = transaction;
                insert.CommandText = """
                    INSERT INTO rules_cache (id, family_id, child_id, type, config_json, enabled, updated_at)
                    VALUES ($id, $familyId, $childId, $type, $config, $enabled, $now);
                    """;
                insert.Parameters.AddWithValue("$id", rule.Id.ToString());
                insert.Parameters.AddWithValue("$familyId", rule.FamilyId.ToString());
                insert.Parameters.AddWithValue("$childId", rule.ChildId.ToString());
                insert.Parameters.AddWithValue("$type", rule.Type);
                insert.Parameters.AddWithValue("$config", rule.Config.GetRawText());
                insert.Parameters.AddWithValue("$enabled", rule.Enabled ? 1 : 0);
                insert.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("o"));
                await insert.ExecuteNonQueryAsync(ct);
            }

            await transaction.CommitAsync(ct);
        }
        catch
        {
            await transaction.RollbackAsync(ct);
            throw;
        }
    }

    /// <summary>Đọc rules từ cache local (dùng khi offline hoặc trước khi tải mới).</summary>
    public async Task<IReadOnlyList<Rule>> GetCachedRulesAsync(CancellationToken ct)
    {
        var rules = new List<Rule>();

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT id, family_id, child_id, type, config_json, enabled FROM rules_cache;";
        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            // Clone() để JsonElement sống độc lập sau khi JsonDocument bị hủy.
            JsonElement config = JsonDocument.Parse(reader.GetString(4)).RootElement.Clone();
            rules.Add(new Rule
            {
                Id = Guid.Parse(reader.GetString(0)),
                FamilyId = Guid.Parse(reader.GetString(1)),
                ChildId = Guid.Parse(reader.GetString(2)),
                Type = reader.GetString(3),
                Config = config,
                Enabled = reader.GetInt32(5) != 0,
            });
        }

        return rules;
    }

    /// <summary>
    /// Lưu ghi đè tạm thời đang hiệu lực (ghi đè mới thay thế ghi đè cũ).
    /// Chỉ có tối đa 1 hàng (id = 1). Domains của ghi đè domain được lưu
    /// dạng mảng JSON trong cột <c>domains_json</c> (null với ghi đè khác);
    /// apps của ghi đè app lưu tương tự trong cột <c>apps_json</c>.
    /// </summary>
    public async Task SaveOverrideAsync(TemporaryOverride ov, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ov);

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO active_override (id, action, minutes, expires_at, domains_json, apps_json, updated_at)
            VALUES (1, $action, $minutes, $expires, $domains, $apps, $now)
            ON CONFLICT(id) DO UPDATE SET
                action = excluded.action,
                minutes = excluded.minutes,
                expires_at = excluded.expires_at,
                domains_json = excluded.domains_json,
                apps_json = excluded.apps_json,
                updated_at = excluded.updated_at;
            """;
        command.Parameters.AddWithValue("$action", ov.Action);
        command.Parameters.AddWithValue("$minutes", ov.Minutes);
        command.Parameters.AddWithValue("$expires", ov.ExpiresAt.ToString("o", CultureInfo.InvariantCulture));
        command.Parameters.AddWithValue("$domains", ov.Domains is null ? DBNull.Value : (object)JsonSerializer.Serialize(ov.Domains));
        command.Parameters.AddWithValue("$apps", ov.Apps is null ? DBNull.Value : (object)JsonSerializer.Serialize(ov.Apps));
        command.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("o"));
        await command.ExecuteNonQueryAsync(ct);
    }

    /// <summary>
    /// Đọc ghi đè đang hiệu lực. Trả về null khi không có ghi đè, khi hàng
    /// lưu bị hỏng, hoặc khi ghi đè đã hết hạn (hàng hết hạn được xóa luôn
    /// để bảng không giữ trạng thái cũ). RuleEngine vẫn tự kiểm tra
    /// <c>ExpiresAt</c> ở mỗi lần đánh giá — đây là lớp bảo vệ thứ hai.
    /// </summary>
    public async Task<TemporaryOverride?> GetActiveOverrideAsync(CancellationToken ct)
    {
        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        string? action = null;
        long minutes = 0;
        string? expiresText = null;
        string? domainsJson = null;
        string? appsJson = null;
        await using (var select = connection.CreateCommand())
        {
            select.CommandText = "SELECT action, minutes, expires_at, domains_json, apps_json FROM active_override WHERE id = 1;";
            await using var reader = await select.ExecuteReaderAsync(ct);
            if (await reader.ReadAsync(ct))
            {
                action = reader.GetString(0);
                minutes = reader.GetInt64(1);
                expiresText = reader.GetString(2);
                domainsJson = reader.IsDBNull(3) ? null : reader.GetString(3);
                appsJson = reader.IsDBNull(4) ? null : reader.GetString(4);
            }
        }

        if (action is null || expiresText is null)
        {
            return null;
        }

        if (!DateTimeOffset.TryParse(
                expiresText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset expiresAt))
        {
            await DeleteOverrideRowAsync(connection, ct);
            return null;
        }

        if (expiresAt <= DateTimeOffset.UtcNow)
        {
            await DeleteOverrideRowAsync(connection, ct);
            return null;
        }

        // domains_json/apps_json hỏng thì coi như không có danh sách (ghi đè
        // domain/app sẽ không sinh entry nào — an toàn hơn là đoán), không
        // xóa hàng.
        return new TemporaryOverride(action, (int)minutes, expiresAt, ParseOverrideDomains(domainsJson), ParseOverrideApps(appsJson));
    }

    /// <summary>Đọc mảng domains từ chuỗi JSON đã lưu. Null/hỏng thì trả về null.</summary>
    private static IReadOnlyList<string>? ParseOverrideDomains(string? domainsJson)
    {
        if (string.IsNullOrWhiteSpace(domainsJson))
        {
            return null;
        }

        try
        {
            using JsonDocument document = JsonDocument.Parse(domainsJson);
            if (document.RootElement.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            var domains = new List<string>();
            foreach (JsonElement element in document.RootElement.EnumerateArray())
            {
                if (element.ValueKind == JsonValueKind.String && element.GetString() is string domain)
                {
                    domains.Add(domain);
                }
            }

            return domains;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>Đọc mảng tên exe từ chuỗi JSON đã lưu (ghi đè app, mirror ParseOverrideDomains). Null/hỏng thì trả về null.</summary>
    private static IReadOnlyList<string>? ParseOverrideApps(string? appsJson)
    {
        if (string.IsNullOrWhiteSpace(appsJson))
        {
            return null;
        }

        try
        {
            using JsonDocument document = JsonDocument.Parse(appsJson);
            if (document.RootElement.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            var apps = new List<string>();
            foreach (JsonElement element in document.RootElement.EnumerateArray())
            {
                if (element.ValueKind == JsonValueKind.String && element.GetString() is string app)
                {
                    apps.Add(app);
                }
            }

            return apps;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>Xóa ghi đè đang hiệu lực (khi phụ huynh gửi lệnh hủy).</summary>
    public async Task ClearOverrideAsync(CancellationToken ct)
    {
        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);
        await DeleteOverrideRowAsync(connection, ct);
    }

    private static async Task DeleteOverrideRowAsync(SqliteConnection connection, CancellationToken ct)
    {
        await using var delete = connection.CreateCommand();
        delete.CommandText = "DELETE FROM active_override WHERE id = 1;";
        await delete.ExecuteNonQueryAsync(ct);
    }

    /// <summary>Ghi một mẫu foreground do Tray gửi qua IPC.</summary>
    public async Task RecordUsageSampleAsync(UsageSamplePayload sample, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(sample);

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO usage_samples (app_name, exe_path_hash, sampled_at)
            VALUES ($app, $hash, $at);
            """;
        command.Parameters.AddWithValue("$app", sample.AppName);
        command.Parameters.AddWithValue("$hash", (object?)sample.ExePathHash ?? DBNull.Value);
        command.Parameters.AddWithValue("$at", sample.SampledAt.UtcDateTime.ToString("o"));
        await command.ExecuteNonQueryAsync(ct);
    }

    /// <summary>
    /// Ước lượng thời gian đã dùng "hôm nay" theo NGÀY ĐỊA PHƯƠNG của máy con
    /// (quy tắc daily_limit tính theo giờ local) = số mẫu trong [nửa đêm
    /// local hôm nay, nửa đêm local ngày mai) x 15 giây/mẫu. Mẫu lưu theo giờ
    /// UTC nên ranh giới ngày local được đổi sang UTC trước khi so sánh chuỗi.
    /// </summary>
    public async Task<TimeSpan> GetUsageTodayAsync(CancellationToken ct)
    {
        DateTimeOffset localNow = DateTimeOffset.Now;
        var localMidnight = new DateTimeOffset(localNow.Date, localNow.Offset);
        string from = localMidnight.UtcDateTime.ToString("o", CultureInfo.InvariantCulture);
        string to = localMidnight.AddDays(1).UtcDateTime.ToString("o", CultureInfo.InvariantCulture);

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM usage_samples WHERE sampled_at >= $from AND sampled_at < $to;";
        command.Parameters.AddWithValue("$from", from);
        command.Parameters.AddWithValue("$to", to);
        object? value = await command.ExecuteScalarAsync(ct);
        long count = value is long c ? c : 0;
        return TimeSpan.FromSeconds(count * AgentConstants.ForegroundSampleInterval.TotalSeconds);
    }

    /// <summary>
    /// Thời gian đã dùng "hôm nay" (ngày địa phương, cùng ranh giới như
    /// <see cref="GetUsageTodayAsync"/>) theo từng app: số mẫu x 15 giây/mẫu,
    /// khóa theo <c>app_name</c> (tên process trần, không có ".exe"). Nơi gọi
    /// chuẩn hóa cả hai phía bằng <see cref="ExeNames"/> khi so khớp với
    /// config quy tắc (config ghi "game.exe").
    /// </summary>
    public async Task<IReadOnlyDictionary<string, TimeSpan>> GetUsageByAppTodayAsync(CancellationToken ct)
    {
        DateTimeOffset localNow = DateTimeOffset.Now;
        var localMidnight = new DateTimeOffset(localNow.Date, localNow.Offset);
        string from = localMidnight.UtcDateTime.ToString("o", CultureInfo.InvariantCulture);
        string to = localMidnight.AddDays(1).UtcDateTime.ToString("o", CultureInfo.InvariantCulture);

        var usage = new Dictionary<string, TimeSpan>(StringComparer.Ordinal);

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT app_name, COUNT(*) FROM usage_samples
            WHERE sampled_at >= $from AND sampled_at < $to
            GROUP BY app_name;
            """;
        command.Parameters.AddWithValue("$from", from);
        command.Parameters.AddWithValue("$to", to);

        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            string appName = reader.GetString(0);
            long count = reader.GetInt64(1);
            usage[appName] = TimeSpan.FromSeconds(count * AgentConstants.ForegroundSampleInterval.TotalSeconds);
        }

        return usage;
    }

    /// <summary>
    /// Các thời điểm lấy mẫu mới hơn <paramref name="since"/>, theo thứ tự
    /// tăng dần — dùng tính chuỗi dùng liên tục cho nghỉ bắt buộc. Chuỗi
    /// thời gian hỏng thì bỏ qua mẫu đó (giống <see cref="GetUsageSummaryAsync"/>).
    /// </summary>
    public async Task<IReadOnlyList<DateTimeOffset>> GetSampleTimesSinceAsync(DateTimeOffset since, CancellationToken ct)
    {
        var times = new List<DateTimeOffset>();

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT sampled_at FROM usage_samples
            WHERE sampled_at > $since
            ORDER BY sampled_at ASC;
            """;
        command.Parameters.AddWithValue("$since", since.UtcDateTime.ToString("o", CultureInfo.InvariantCulture));

        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            if (DateTimeOffset.TryParse(reader.GetString(0), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset sampledAt))
            {
                times.Add(sampledAt);
            }
        }

        return times;
    }

    /// <summary>Đọc một giá trị trạng thái bền vững của Service. Null khi chưa có.</summary>
    public async Task<string?> GetStateAsync(string key, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(key);

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT value FROM device_state WHERE key = $key;";
        command.Parameters.AddWithValue("$key", key);
        object? value = await command.ExecuteScalarAsync(ct);
        return value as string;
    }

    /// <summary>Ghi (hoặc ghi đè) một giá trị trạng thái bền vững của Service.</summary>
    public async Task SetStateAsync(string key, string value, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(key);
        ArgumentNullException.ThrowIfNull(value);

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO device_state (key, value) VALUES ($key, $value)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value;
            """;
        command.Parameters.AddWithValue("$key", key);
        command.Parameters.AddWithValue("$value", value);
        await command.ExecuteNonQueryAsync(ct);
    }

    /// <summary>Xóa một giá trị trạng thái bền vững của Service.</summary>
    public async Task DeleteStateAsync(string key, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(key);

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM device_state WHERE key = $key;";
        command.Parameters.AddWithValue("$key", key);
        await command.ExecuteNonQueryAsync(ct);
    }

    /// <summary>
    /// Tổng hợp mẫu foreground mới hơn <paramref name="since"/> theo từng app
    /// (số mẫu x 15 giây/mẫu = thời lượng ước lượng), để gửi lên server.
    /// Nhóm theo cả tên app và hash exe để hai app trùng tên nhưng khác file
    /// không bị gộp chung.
    /// </summary>
    public async Task<IReadOnlyList<UsageSummary>> GetUsageSummaryAsync(DateTimeOffset since, CancellationToken ct)
    {
        var summaries = new List<UsageSummary>();

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT app_name, exe_path_hash, COUNT(*), MIN(sampled_at), MAX(sampled_at)
            FROM usage_samples
            WHERE sampled_at > $since
            GROUP BY app_name, exe_path_hash
            ORDER BY MIN(sampled_at) ASC;
            """;
        command.Parameters.AddWithValue("$since", since.UtcDateTime.ToString("o", CultureInfo.InvariantCulture));

        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            string appName = reader.GetString(0);
            string? hash = reader.IsDBNull(1) ? null : reader.GetString(1);
            long count = reader.GetInt64(2);
            if (!DateTimeOffset.TryParse(reader.GetString(3), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset first)
                || !DateTimeOffset.TryParse(reader.GetString(4), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset last))
            {
                continue;
            }

            summaries.Add(new UsageSummary(appName, hash, count, first, last));
        }

        return summaries;
    }

    /// <summary>Xóa mẫu foreground cũ hơn <paramref name="maxAge"/> (mặc định 7 ngày).</summary>
    public async Task PruneOldSamplesAsync(TimeSpan maxAge, CancellationToken ct)
    {
        string cutoff = DateTimeOffset.UtcNow.Subtract(maxAge).UtcDateTime.ToString("o", CultureInfo.InvariantCulture);

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM usage_samples WHERE sampled_at < $cutoff;";
        command.Parameters.AddWithValue("$cutoff", cutoff);
        await command.ExecuteNonQueryAsync(ct);
    }
}
