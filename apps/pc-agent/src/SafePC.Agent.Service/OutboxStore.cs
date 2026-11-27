using System.Globalization;
using System.Text.Json;
using System.Threading;
using Microsoft.Data.Sqlite;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>Một bản ghi chờ gửi trong bảng outbox.</summary>
public sealed record OutboxItem(long Id, string PayloadJson);

/// <summary>Tổng hợp mẫu foreground theo app trong một khoảng thời gian, để gửi lên server.
/// <c>Sid</c> là SID của tài khoản Windows đã dùng app (Sprint 5) — null là
/// mẫu không rõ phiên (Tray cũ / mẫu trước Sprint 5); nhóm theo (app, hash,
/// sid) để không gộp giờ của hai con dùng chung app.</summary>
public sealed record UsageSummary(string AppName, string? ExePathHash, long SampleCount, DateTimeOffset FirstSampledAt, DateTimeOffset LastSampledAt, string? Sid = null);

/// <summary>Một dòng quan sát luật-không-chặn đang chờ đẩy trong hàng đợi cục bộ (migration 31): id hàng đợi + con mà dòng thuộc về + bản ghi đã gộp.</summary>
public sealed record RuleObservationOutboxItem(long Id, Guid ChildId, RuleObservationRecord Record);

/// <summary>
/// Lưu trữ local SQLite cho Service (offline-first, docs/02-ARCHITECTURE.md mục 4.2):
/// - Bảng <c>outbox</c>: usage batch chưa gửi, retry với backoff.
/// - Bảng <c>rules_cache</c>: rules tải về lần cuối, để mất mạng vẫn thi hành đúng.
/// - Bảng <c>usage_samples</c>: mẫu foreground Tray gửi qua IPC, dùng ước lượng
///   thời gian đã dùng hôm nay.
/// - Bảng <c>active_override</c>: ghi đè tạm thời đang hiệu lực (một hàng theo con, khóa <c>child_key</c>),
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
    private readonly string _dbFilePath;

    public OutboxStore(string dbFilePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(dbFilePath);

        string? directory = Path.GetDirectoryName(dbFilePath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        _dbFilePath = dbFilePath;
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
                name TEXT,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS monitor_rules_cache (
                id TEXT PRIMARY KEY,
                family_id TEXT NOT NULL,
                child_id TEXT NOT NULL,
                type TEXT NOT NULL,
                config_json TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                name TEXT,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS rule_observations_outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                child_id TEXT NOT NULL,
                rule_id TEXT,
                rule_name TEXT NOT NULL,
                rule_mode TEXT NOT NULL,
                target TEXT NOT NULL,
                context TEXT NOT NULL,
                day TEXT NOT NULL,
                occurrence_count INTEGER NOT NULL DEFAULT 0,
                total_seconds INTEGER NOT NULL DEFAULT 0,
                first_seen_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                windows_sid TEXT,
                UNIQUE (child_id, rule_id, day, target, context)
            );
            CREATE TABLE IF NOT EXISTS usage_samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                app_name TEXT NOT NULL,
                exe_path_hash TEXT,
                sampled_at TEXT NOT NULL,
                sid TEXT
            );
            CREATE TABLE IF NOT EXISTS active_override (
                child_key TEXT PRIMARY KEY,
                action TEXT NOT NULL,
                minutes INTEGER NOT NULL,
                expires_at TEXT NOT NULL,
                domains_json TEXT,
                apps_json TEXT,
                command_created_at TEXT,
                child_id TEXT,
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
        // không chạy. Cùng mẫu: cột command_created_at (mốc chống lệnh ghi
        // đè cũ gửi lại) cho DB đã tồn tại từ trước đợt cứng hóa này.
        await EnsureOverrideDomainsColumnAsync(connection, ct);
        await EnsureOverrideAppsColumnAsync(connection, ct);
        await EnsureOverrideCommandCreatedAtColumnAsync(connection, ct);
        await EnsureOverrideChildIdColumnAsync(connection, ct);
        await EnsureUsageSamplesSidColumnAsync(connection, ct);
        // Migration 31: cột name cho rules_cache của DB đã tồn tại
        // (bản chụp tên luật cho dòng theo dõi luật không chặn).
        await EnsureRulesCacheNameColumnAsync(connection, ct);

        // Sprint 5 đợt 1 (sửa MAJOR-1): di trú bảng active_override từ 1 hàng
        // duy nhất sang một hàng theo con — chạy sau các Ensure ở trên để
        // cột child_id đã có khi copy hàng cũ.
        await MigrateOverrideTableToPerChildAsync(connection, ct);

        // Sprint 4: khóa ACL file DB chỉ còn SYSTEM + Administrators. DB
        // chứa hàng đợi offline, cache rules, trạng thái bền (mốc chống
        // lệnh cũ, đếm lần sai PIN...) — trước đây file mang ACL mặc định,
        // Standard User đọc được. Không process nào ở quyền user chạm tới
        // file này (Tray chỉ nói chuyện qua IPC), nên khóa không ảnh hưởng
        // luồng chạy. Best-effort, thất bại thì DB vẫn dùng được.
        AclHelper.RestrictFileToSystemAndAdmins(_dbFilePath);
    }

    /// <summary>Thêm cột <c>name</c> vào bảng <c>rules_cache</c> nếu chưa có (migration 31: bản chụp tên luật).</summary>
    private static async Task EnsureRulesCacheNameColumnAsync(SqliteConnection connection, CancellationToken ct)
    {
        bool hasColumn = false;
        await using (var pragma = connection.CreateCommand())
        {
            pragma.CommandText = "PRAGMA table_info(rules_cache);";
            await using var reader = await pragma.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                if (reader.GetString(1) == "name")
                {
                    hasColumn = true;
                    break;
                }
            }
        }

        if (!hasColumn)
        {
            await using var alter = connection.CreateCommand();
            alter.CommandText = "ALTER TABLE rules_cache ADD COLUMN name TEXT;";
            await alter.ExecuteNonQueryAsync(ct);
        }
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

    /// <summary>Thêm cột <c>command_created_at</c> vào bảng <c>active_override</c> nếu chưa có (mốc chống lệnh ghi đè cũ gửi lại, mirror hai cột trên). Hàng cũ để NULL — coi như không có mốc.</summary>
    private static async Task EnsureOverrideCommandCreatedAtColumnAsync(SqliteConnection connection, CancellationToken ct)
    {
        bool hasColumn = false;
        await using (var pragma = connection.CreateCommand())
        {
            pragma.CommandText = "PRAGMA table_info(active_override);";
            await using var reader = await pragma.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                // PRAGMA table_info: cid, name, type, notnull, dflt_value, pk.
                if (reader.GetString(1) == "command_created_at")
                {
                    hasColumn = true;
                    break;
                }
            }
        }

        if (!hasColumn)
        {
            await using var alter = connection.CreateCommand();
            alter.CommandText = "ALTER TABLE active_override ADD COLUMN command_created_at TEXT;";
            await alter.ExecuteNonQueryAsync(ct);
        }
    }

    /// <summary>
    /// Thêm cột <c>child_id</c> vào bảng <c>active_override</c> nếu chưa có
    /// (Sprint 5: ghi đè thuộc về hồ sơ con nào — Guid dạng "D", null là
    /// hàng cũ, thuộc về con mặc định của máy). Hàng cũ để NULL.
    /// </summary>
    private static async Task EnsureOverrideChildIdColumnAsync(SqliteConnection connection, CancellationToken ct)
    {
        bool hasColumn = false;
        await using (var pragma = connection.CreateCommand())
        {
            pragma.CommandText = "PRAGMA table_info(active_override);";
            await using var reader = await pragma.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                if (reader.GetString(1) == "child_id")
                {
                    hasColumn = true;
                    break;
                }
            }
        }

        if (!hasColumn)
        {
            await using var alter = connection.CreateCommand();
            alter.CommandText = "ALTER TABLE active_override ADD COLUMN child_id TEXT;";
            await alter.ExecuteNonQueryAsync(ct);
        }
    }

    /// <summary>Khóa hàng ghi đè của một con: guid dạng "D", "" cho hàng legacy chưa gắn con (thuộc về con mặc định của máy).</summary>
    private static string OverrideChildKey(Guid? childId) => childId?.ToString("D") ?? string.Empty;

    /// <summary>
    /// Di trú bảng <c>active_override</c> từ 1 hàng duy nhất (khóa <c>id = 1</c>)
    /// sang một hàng theo con (khóa <c>child_key</c> = guid con, "" = hàng legacy
    /// thuộc về con mặc định) — sửa MAJOR-1 review Sprint 5 đợt 1: ghi đè mới
    /// của con B từng XÓA ghi đè đang hiệu lực của con A. Chỉ chạy khi bảng cũ
    /// còn cột <c>id</c>; bảng mới đã có cột <c>child_key</c> thì không làm gì.
    /// Hàng cũ (tối đa 1) được giữ nguyên nội dung, child_key lấy từ child_id
    /// (null → ""). Di trú trong một transaction để không mất ghi đè đang hiệu
    /// lực nếu Service chết giữa chừng.
    /// </summary>
    private static async Task MigrateOverrideTableToPerChildAsync(SqliteConnection connection, CancellationToken ct)
    {
        bool isOldShape = false;
        await using (var pragma = connection.CreateCommand())
        {
            pragma.CommandText = "PRAGMA table_info(active_override);";
            await using var reader = await pragma.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                if (reader.GetString(1) == "id")
                {
                    isOldShape = true;
                    break;
                }
            }
        }

        if (!isOldShape)
        {
            return;
        }

        await using var transaction = connection.BeginTransaction();
        await using (var create = connection.CreateCommand())
        {
            create.Transaction = transaction;
            create.CommandText = """
                CREATE TABLE active_override_new (
                    child_key TEXT PRIMARY KEY,
                    action TEXT NOT NULL,
                    minutes INTEGER NOT NULL,
                    expires_at TEXT NOT NULL,
                    domains_json TEXT,
                    apps_json TEXT,
                    command_created_at TEXT,
                    child_id TEXT,
                    updated_at TEXT NOT NULL
                );
                """;
            await create.ExecuteNonQueryAsync(ct);
        }

        await using (var copy = connection.CreateCommand())
        {
            copy.Transaction = transaction;
            copy.CommandText = """
                INSERT INTO active_override_new (child_key, action, minutes, expires_at, domains_json, apps_json, command_created_at, child_id, updated_at)
                    SELECT COALESCE(child_id, ''), action, minutes, expires_at, domains_json, apps_json, command_created_at, child_id, updated_at FROM active_override;
                """;
            await copy.ExecuteNonQueryAsync(ct);
        }

        await using (var drop = connection.CreateCommand())
        {
            drop.Transaction = transaction;
            drop.CommandText = "DROP TABLE active_override;";
            await drop.ExecuteNonQueryAsync(ct);
        }

        await using (var rename = connection.CreateCommand())
        {
            rename.Transaction = transaction;
            rename.CommandText = "ALTER TABLE active_override_new RENAME TO active_override;";
            await rename.ExecuteNonQueryAsync(ct);
        }

        await transaction.CommitAsync(ct);
    }

    /// <summary>
    /// Thêm cột <c>sid</c> vào bảng <c>usage_samples</c> nếu chưa có
    /// (Sprint 5: SID của tài khoản Windows đã dùng app — null là mẫu không
    /// rõ phiên, chỉ tính cho con mặc định của máy).
    /// </summary>
    private static async Task EnsureUsageSamplesSidColumnAsync(SqliteConnection connection, CancellationToken ct)
    {
        bool hasColumn = false;
        await using (var pragma = connection.CreateCommand())
        {
            pragma.CommandText = "PRAGMA table_info(usage_samples);";
            await using var reader = await pragma.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                if (reader.GetString(1) == "sid")
                {
                    hasColumn = true;
                    break;
                }
            }
        }

        if (!hasColumn)
        {
            await using var alter = connection.CreateCommand();
            alter.CommandText = "ALTER TABLE usage_samples ADD COLUMN sid TEXT;";
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

    /// <summary>
    /// Xếp một yêu cầu xin thêm giờ của con vào outbox (kind
    /// 'extra_time_request') để AgentWorker đẩy lên bảng requests. Hàng đợi
    /// bền vững: yêu cầu không mất khi mất mạng hay khởi động lại Service,
    /// và được gửi lại theo backoff của <see cref="MarkFailedAsync"/>.
    /// </summary>
    /// <summary>
    /// Xếp một yêu cầu xin thêm giờ vào outbox. <paramref name="sid"/> là SID
    /// của tài khoản Windows đã gửi yêu cầu (Sprint 5, Service đóng dấu từ
    /// hello của phiên gửi) — lưu kèm trong payload để đợt sau biết yêu cầu
    /// là của con nào; null với hàng cũ (không rõ phiên).
    /// </summary>
    public async Task EnqueueExtraTimeRequestAsync(int minutes, string reason, DateTimeOffset requestedAt, CancellationToken ct, string? sid = null)
    {
        ArgumentException.ThrowIfNullOrEmpty(reason);

        string payload = JsonSerializer.Serialize(new ExtraTimeRequestPayload(minutes, reason, requestedAt, sid));

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO outbox (kind, payload_json, attempts, next_retry_at, created_at)
            VALUES ('extra_time_request', $payload, 0, $now, $now);
            """;
        command.Parameters.AddWithValue("$payload", payload);
        command.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("o"));
        await command.ExecuteNonQueryAsync(ct);
    }

    /// <summary>Lấy các yêu cầu xin thêm giờ đã đến hạn gửi, cũ nhất trước. Chỉ kind 'extra_time_request'.</summary>
    public async Task<IReadOnlyList<OutboxItem>> GetPendingExtraTimeRequestsAsync(int limit, CancellationToken ct)
    {
        var items = new List<OutboxItem>();

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, payload_json FROM outbox
            WHERE kind = 'extra_time_request' AND next_retry_at <= $now
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

    /// <summary>Thay toàn bộ cache rules bằng danh sách mới tải về.</summary>
    public Task SaveRulesAsync(IReadOnlyList<Rule> rules, CancellationToken ct)
        => SaveRulesToTableAsync("rules_cache", rules, ct);

    /// <summary>
    /// Thay toàn bộ cache luật-chỉ-theo-dõi (luật cấm ĐANG TẮT còn bật
    /// mặt theo dõi, migration 31) bằng danh sách mới tải về — cùng
    /// hình dạng bảng với rules_cache nhưng là tập riêng: luật tắt
    /// không bao giờ được lẫn vào cache thi hành.
    /// </summary>
    public Task SaveMonitorRulesAsync(IReadOnlyList<Rule> rules, CancellationToken ct)
        => SaveRulesToTableAsync("monitor_rules_cache", rules, ct);

    /// <summary>Ghi rules vào một bảng cache (xóa sạch + chèn lại trong một giao dịch). Tên bảng chỉ đến từ hai hằng nội bộ phía trên.</summary>
    private async Task SaveRulesToTableAsync(string table, IReadOnlyList<Rule> rules, CancellationToken ct)
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
                delete.CommandText = "DELETE FROM " + table + ";";
                await delete.ExecuteNonQueryAsync(ct);
            }

            foreach (Rule rule in rules)
            {
                await using var insert = connection.CreateCommand();
                insert.Transaction = transaction;
                insert.CommandText =
                    "INSERT INTO " + table
                    + " (id, family_id, child_id, type, config_json, enabled, name, updated_at)"
                    + " VALUES ($id, $familyId, $childId, $type, $config, $enabled, $name, $now);";
                insert.Parameters.AddWithValue("$id", rule.Id.ToString());
                insert.Parameters.AddWithValue("$familyId", rule.FamilyId.ToString());
                insert.Parameters.AddWithValue("$childId", rule.ChildId.ToString());
                insert.Parameters.AddWithValue("$type", rule.Type);
                insert.Parameters.AddWithValue("$config", rule.Config.GetRawText());
                insert.Parameters.AddWithValue("$enabled", rule.Enabled ? 1 : 0);
                insert.Parameters.AddWithValue("$name", (object?)rule.Name ?? DBNull.Value);
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
    public Task<IReadOnlyList<Rule>> GetCachedRulesAsync(CancellationToken ct)
        => GetRulesFromTableAsync("rules_cache", ct);

    /// <summary>Đọc luật-chỉ-theo-dõi từ cache local (migration 31).</summary>
    public Task<IReadOnlyList<Rule>> GetCachedMonitorRulesAsync(CancellationToken ct)
        => GetRulesFromTableAsync("monitor_rules_cache", ct);

    /// <summary>Đọc toàn bộ một bảng cache rules. Tên bảng chỉ đến từ hai hằng nội bộ phía trên.</summary>
    private async Task<IReadOnlyList<Rule>> GetRulesFromTableAsync(string table, CancellationToken ct)
    {
        var rules = new List<Rule>();

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT id, family_id, child_id, type, config_json, enabled, name FROM " + table + ";";
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
                Name = reader.IsDBNull(6) ? null : reader.GetString(6),
            });
        }

        return rules;
    }

    /// <summary>
    /// Gộp một quan sát luật-không-chặn vào hàng đợi cục bộ
    /// (rule_observations_outbox, migration 31): cùng khóa (con,
    /// luật, ngày, đối tượng, ngữ cảnh) thì CỘNG DỒN số lần + tổng
    /// giây và mở rộng khoảng first/last seen — đúng khóa gộp phía
    /// server trừ rule_name (server gộp theo tên bản chụp; phía máy
    /// giữ theo rule_id chính xác hơn, hai mẫu trùng tên khác id vẫn
    /// tách hàng ở đây và được RPC phía server gộp tiếp theo tên).
    /// Ngày do người gọi tính theo giờ tin cậy + múi giờ gia đình.
    /// </summary>
    public async Task AddRuleObservationAsync(Guid childId, RuleObservationRecord record, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(record);

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO rule_observations_outbox
                (child_id, rule_id, rule_name, rule_mode, target, context, day,
                 occurrence_count, total_seconds, first_seen_at, last_seen_at, windows_sid)
            VALUES
                ($childId, $ruleId, $ruleName, $ruleMode, $target, $context, $day,
                 $count, $seconds, $first, $last, $sid)
            ON CONFLICT (child_id, rule_id, day, target, context) DO UPDATE SET
                rule_name = excluded.rule_name,
                rule_mode = excluded.rule_mode,
                occurrence_count = occurrence_count + excluded.occurrence_count,
                total_seconds = total_seconds + excluded.total_seconds,
                first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
                last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
                windows_sid = coalesce(excluded.windows_sid, windows_sid);
            """;
        command.Parameters.AddWithValue("$childId", childId.ToString());
        command.Parameters.AddWithValue("$ruleId", record.RuleId is Guid rid ? rid.ToString() : DBNull.Value);
        command.Parameters.AddWithValue("$ruleName", record.RuleName);
        command.Parameters.AddWithValue("$ruleMode", record.RuleMode);
        command.Parameters.AddWithValue("$target", record.Target);
        command.Parameters.AddWithValue("$context", record.Context);
        command.Parameters.AddWithValue("$day", record.Day);
        command.Parameters.AddWithValue("$count", record.OccurrenceCount);
        command.Parameters.AddWithValue("$seconds", record.TotalSeconds);
        command.Parameters.AddWithValue("$first", record.FirstSeenAt.UtcDateTime.ToString("o", CultureInfo.InvariantCulture));
        command.Parameters.AddWithValue("$last", record.LastSeenAt.UtcDateTime.ToString("o", CultureInfo.InvariantCulture));
        command.Parameters.AddWithValue("$sid", (object?)record.WindowsSid ?? DBNull.Value);
        await command.ExecuteNonQueryAsync(ct);
    }

    /// <summary>Đọc tối đa <paramref name="limit"/> dòng quan sát đang chờ đẩy (kèm id hàng đợi để xóa sau khi đẩy thành công).</summary>
    public async Task<IReadOnlyList<RuleObservationOutboxItem>> GetPendingRuleObservationsAsync(int limit, CancellationToken ct)
    {
        var items = new List<RuleObservationOutboxItem>();

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, child_id, rule_id, rule_name, rule_mode, target, context, day,
                   occurrence_count, total_seconds, first_seen_at, last_seen_at, windows_sid
            FROM rule_observations_outbox
            ORDER BY id
            LIMIT $limit;
            """;
        command.Parameters.AddWithValue("$limit", limit);
        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            var record = new RuleObservationRecord
            {
                RuleId = reader.IsDBNull(2) ? null : Guid.Parse(reader.GetString(2)),
                RuleName = reader.GetString(3),
                RuleMode = reader.GetString(4),
                Target = reader.GetString(5),
                Context = reader.GetString(6),
                Day = reader.GetString(7),
                OccurrenceCount = (int)reader.GetInt64(8),
                TotalSeconds = (int)reader.GetInt64(9),
                FirstSeenAt = DateTimeOffset.Parse(reader.GetString(10), CultureInfo.InvariantCulture),
                LastSeenAt = DateTimeOffset.Parse(reader.GetString(11), CultureInfo.InvariantCulture),
                WindowsSid = reader.IsDBNull(12) ? null : reader.GetString(12),
            };
            items.Add(new RuleObservationOutboxItem(
                reader.GetInt64(0),
                Guid.Parse(reader.GetString(1)),
                record));
        }

        return items;
    }

    /// <summary>Xóa các dòng quan sát đã đẩy thành công khỏi hàng đợi cục bộ.</summary>
    public async Task DeleteRuleObservationsAsync(IReadOnlyList<long> ids, CancellationToken ct)
    {
        if (ids.Count == 0)
        {
            return;
        }

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        foreach (long id in ids)
        {
            await using var command = connection.CreateCommand();
            command.CommandText = "DELETE FROM rule_observations_outbox WHERE id = $id;";
            command.Parameters.AddWithValue("$id", id);
            await command.ExecuteNonQueryAsync(ct);
        }
    }

    /// <summary>
    /// Lưu ghi đè tạm thời đang hiệu lực của MỘT con (Sprint 5 đợt 1, sửa
    /// MAJOR-1): một hàng theo con, khóa <c>child_key</c> = guid con ("" =
    /// hàng legacy chưa gắn con, thuộc về con mặc định). Ghi đè mới của con B
    /// KHÔNG xóa ghi đè đang hiệu lực của con A nữa — mỗi con giữ hàng của
    /// riêng mình. Chỉ có một hàng hiệu lực cho mỗi con: hàng legacy ("")
    /// thuộc về con mặc định, nên khi con mặc định đã có hàng gắn guid thì
    /// hàng legacy cũ bị thay thế (và ngược lại, lệnh legacy mới hơn thay thế
    /// hàng guid của con mặc định) — <paramref name="defaultChildId"/> null
    /// (chưa biết con mặc định) thì bỏ qua bước dọn này. Domains của ghi đè
    /// domain được lưu dạng mảng JSON trong cột <c>domains_json</c> (null với
    /// ghi đè khác); apps của ghi đè app lưu tương tự trong cột
    /// <c>apps_json</c>; <c>CommandCreatedAt</c> (giờ server của lệnh đã tạo
    /// ghi đè) lưu trong cột <c>command_created_at</c> để lần poll sau so mốc
    /// chống lệnh cũ.
    /// </summary>
    public async Task SaveOverrideAsync(TemporaryOverride ov, Guid? defaultChildId, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ov);

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        string childKey = OverrideChildKey(ov.ChildId);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO active_override (child_key, action, minutes, expires_at, domains_json, apps_json, command_created_at, child_id, updated_at)
            VALUES ($key, $action, $minutes, $expires, $domains, $apps, $created, $childId, $now)
            ON CONFLICT(child_key) DO UPDATE SET
                action = excluded.action,
                minutes = excluded.minutes,
                expires_at = excluded.expires_at,
                domains_json = excluded.domains_json,
                apps_json = excluded.apps_json,
                command_created_at = excluded.command_created_at,
                child_id = excluded.child_id,
                updated_at = excluded.updated_at;
            """;
        command.Parameters.AddWithValue("$key", childKey);
        command.Parameters.AddWithValue("$action", ov.Action);
        command.Parameters.AddWithValue("$minutes", ov.Minutes);
        command.Parameters.AddWithValue("$expires", ov.ExpiresAt.ToString("o", CultureInfo.InvariantCulture));
        command.Parameters.AddWithValue("$domains", ov.Domains is null ? DBNull.Value : (object)JsonSerializer.Serialize(ov.Domains));
        command.Parameters.AddWithValue("$apps", ov.Apps is null ? DBNull.Value : (object)JsonSerializer.Serialize(ov.Apps));
        command.Parameters.AddWithValue("$created", ov.CommandCreatedAt is null ? DBNull.Value : (object)ov.CommandCreatedAt.Value.ToString("o", CultureInfo.InvariantCulture));
        command.Parameters.AddWithValue("$childId", ov.ChildId is null ? DBNull.Value : (object)ov.ChildId.Value.ToString("D"));
        command.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("o"));
        await command.ExecuteNonQueryAsync(ct);

        // Một con chỉ có MỘT hàng hiệu lực: dọn hàng cũ của cùng con mặc
        // định ở khóa còn lại (legacy "" ↔ guid). Hàng của con khác không
        // đụng tới.
        if (defaultChildId is not null)
        {
            string? supersededKey = null;
            if (ov.ChildId is null)
            {
                supersededKey = defaultChildId.Value.ToString("D");
            }
            else if (ov.ChildId.Value == defaultChildId.Value)
            {
                supersededKey = string.Empty;
            }

            if (supersededKey is not null)
            {
                await DeleteOverrideRowAsync(connection, supersededKey, ct);
            }
        }
    }

    /// <summary>
    /// Đọc ghi đè LEGACY đang hiệu lực (hàng child_key "", chưa gắn con —
    /// thuộc về con mặc định của máy). Trả về null khi không có ghi đè, khi
    /// hàng lưu bị hỏng, hoặc khi ghi đè đã hết hạn (hàng hết hạn được xóa
    /// luôn để bảng không giữ trạng thái cũ). RuleEngine vẫn tự kiểm tra
    /// <c>ExpiresAt</c> ở mỗi lần đánh giá — đây là lớp bảo vệ thứ hai.
    /// Đường theo con dùng <see cref="GetActiveOverrideForChildAsync"/>; hàm
    /// này chỉ còn phục vụ đường cũ / chẩn đoán — ghi đè đã tách theo con
    /// nên hàng của con khác không bao giờ trả về ở đây.
    /// </summary>
    public async Task<TemporaryOverride?> GetActiveOverrideAsync(CancellationToken ct)
    {
        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);
        return await ReadOverrideRowAsync(connection, string.Empty, ct);
    }

    /// <summary>
    /// Đọc một hàng ghi đè theo khóa con. Hết hạn hoặc không đọc được
    /// <c>expires_at</c> thì XÓA đúng hàng đó (không đụng hàng con khác) rồi
    /// trả null. domains_json/apps_json hỏng thì coi như không có danh sách
    /// (ghi đè domain/app sẽ không sinh entry nào — an toàn hơn là đoán),
    /// không xóa hàng. command_created_at hỏng thì coi như không có mốc —
    /// hàng vẫn hiệu lực, watermark bền vững (nếu có) vẫn chặn lệnh cũ.
    /// child_id hỏng thì coi như hàng cũ (con mặc định).
    /// </summary>
    private static async Task<TemporaryOverride?> ReadOverrideRowAsync(SqliteConnection connection, string childKey, CancellationToken ct)
    {
        string? action = null;
        long minutes = 0;
        string? expiresText = null;
        string? domainsJson = null;
        string? appsJson = null;
        string? commandCreatedAtText = null;
        string? childIdText = null;
        await using (var select = connection.CreateCommand())
        {
            select.CommandText = "SELECT action, minutes, expires_at, domains_json, apps_json, command_created_at, child_id FROM active_override WHERE child_key = $key;";
            select.Parameters.AddWithValue("$key", childKey);
            await using var reader = await select.ExecuteReaderAsync(ct);
            if (await reader.ReadAsync(ct))
            {
                action = reader.GetString(0);
                minutes = reader.GetInt64(1);
                expiresText = reader.GetString(2);
                domainsJson = reader.IsDBNull(3) ? null : reader.GetString(3);
                appsJson = reader.IsDBNull(4) ? null : reader.GetString(4);
                commandCreatedAtText = reader.IsDBNull(5) ? null : reader.GetString(5);
                childIdText = reader.IsDBNull(6) ? null : reader.GetString(6);
            }
        }

        if (action is null || expiresText is null)
        {
            return null;
        }

        if (!DateTimeOffset.TryParse(
                expiresText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset expiresAt))
        {
            await DeleteOverrideRowAsync(connection, childKey, ct);
            return null;
        }

        if (expiresAt <= DateTimeOffset.UtcNow)
        {
            await DeleteOverrideRowAsync(connection, childKey, ct);
            return null;
        }

        DateTimeOffset? commandCreatedAt = null;
        if (!string.IsNullOrWhiteSpace(commandCreatedAtText)
            && DateTimeOffset.TryParse(
                commandCreatedAtText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset parsedCreatedAt))
        {
            commandCreatedAt = parsedCreatedAt;
        }

        Guid? childId = null;
        if (!string.IsNullOrWhiteSpace(childIdText)
            && Guid.TryParse(childIdText, out Guid parsedChildId))
        {
            childId = parsedChildId;
        }

        return new TemporaryOverride(action, (int)minutes, expiresAt, ParseOverrideDomains(domainsJson), ParseOverrideApps(appsJson), commandCreatedAt, childId);
    }

    /// <summary>Hàng ghi đè của khóa con này có tồn tại không (kể cả đã hết hạn — chỉ kiểm tra sự hiện diện, không đọc nội dung).</summary>
    private static async Task<bool> OverrideRowExistsAsync(SqliteConnection connection, string childKey, CancellationToken ct)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM active_override WHERE child_key = $key;";
        command.Parameters.AddWithValue("$key", childKey);
        object? scalar = await command.ExecuteScalarAsync(ct);
        return scalar is long count && count > 0;
    }

    /// <summary>
    /// Đọc ghi đè đang hiệu lực của MỘT con (Sprint 5 đợt 1, sửa MAJOR-1):
    /// hàng gắn đúng guid con đó; con mặc định thì thêm hàng legacy "" (ghi
    /// đè cũ chưa gắn con) khi chưa từng có hàng guid — hàng guid đã hết hạn
    /// thì không hồi sinh hàng legacy cũ hơn. Hàng của con khác không trả về
    /// (ghi đè của con khác không được tính cho con đang ngồi máy, dù nó vẫn
    /// còn hạn). Hết hạn/hỏng thì xử lý như <see cref="ReadOverrideRowAsync"/>
    /// (xóa đúng hàng đã đọc).
    /// </summary>
    public async Task<TemporaryOverride?> GetActiveOverrideForChildAsync(Guid? childId, Guid? defaultChildId, CancellationToken ct)
    {
        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        string key = OverrideChildKey(childId);
        bool useLegacyFallback = childId is not null
            && defaultChildId is not null
            && childId.Value == defaultChildId.Value
            && !await OverrideRowExistsAsync(connection, key, ct);

        TemporaryOverride? row = await ReadOverrideRowAsync(connection, key, ct);
        if (row is null && useLegacyFallback)
        {
            row = await ReadOverrideRowAsync(connection, string.Empty, ct);
        }

        return row;
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

    /// <summary>
    /// Xóa ghi đè đang hiệu lực của MỘT con (khi phụ huynh gửi lệnh hủy cho
    /// con đó). Hủy ghi đè của con A không xóa ghi đè của con B. Con mặc
    /// định thì xóa cả hàng guid của nó lẫn hàng legacy "" (cả hai đều thuộc
    /// về con mặc định; chỉ một trong hai tồn tại sau các lần lưu — xóa cả
    /// hai cho chắc khi hàng legacy còn sót từ trước khi di trú).
    /// </summary>
    public async Task ClearOverrideForChildAsync(Guid? childId, Guid? defaultChildId, CancellationToken ct)
    {
        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);
        await DeleteOverrideRowAsync(connection, OverrideChildKey(childId), ct);
        if (childId is not null && defaultChildId is not null && childId.Value == defaultChildId.Value)
        {
            await DeleteOverrideRowAsync(connection, string.Empty, ct);
        }
    }

    /// <summary>
    /// Đọc mốc sàn lệnh ghi đè bền vững (khóa <c>OverrideCommandFloor</c>
    /// trong <c>device_state</c>). Null khi chưa từng áp lệnh ghi đè nào
    /// hoặc giá trị lưu bị hỏng — hỏng thì coi như không có mốc (hàng ghi
    /// đè, nếu còn, vẫn tự mang mốc của nó).
    /// </summary>
    public async Task<DateTimeOffset?> GetOverrideCommandFloorAsync(CancellationToken ct)
        => await GetOverrideCommandFloorAsync(null, null, ct);

    /// <summary>
    /// Đọc mốc sàn lệnh ghi đè của một con (Sprint 5): khóa theo-con
    /// (<c>override_command_floor_&lt;childId:N&gt;</c>). Con mặc định thì
    /// lấy mốc LỚN HƠN trong hai khóa (theo-con và khóa gốc) — khóa gốc giữ
    /// mốc của máy nâng cấp từ bản cũ, lệnh cũ của con mặc định gửi lại sau
    /// nâng cấp vẫn bị chặn. Con khác thì chỉ khóa theo-con của nó.
    /// <paramref name="childId"/> null = đường cũ (khóa gốc).
    /// </summary>
    public async Task<DateTimeOffset?> GetOverrideCommandFloorAsync(Guid? childId, Guid? defaultChildId, CancellationToken ct)
    {
        if (childId is null)
        {
            return await ReadFloorAsync(StateKeys.OverrideCommandFloor, ct);
        }

        DateTimeOffset? floor = await ReadFloorAsync(StateKeys.OverrideCommandFloorForChild(childId.Value), ct);
        if (childId.Value != defaultChildId)
        {
            return floor;
        }

        DateTimeOffset? legacy = await ReadFloorAsync(StateKeys.OverrideCommandFloor, ct);
        if (floor is null)
        {
            return legacy;
        }

        return legacy is null || floor.Value > legacy.Value ? floor : legacy;
    }

    private async Task<DateTimeOffset?> ReadFloorAsync(string key, CancellationToken ct)
    {
        string? value = await GetStateAsync(key, ct);
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        if (DateTimeOffset.TryParse(
                value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset floor))
        {
            return floor;
        }

        return null;
    }

    /// <summary>
    /// Nâng mốc sàn lệnh ghi đè lên <c>commandCreatedAt</c> (chỉ nâng, không
    /// bao giờ hạ). Gọi mỗi khi áp một lệnh ghi đè — kể cả lệnh hủy, vì hủy
    /// xóa hàng ghi đè nên mốc trong hàng sẽ mất theo; và khi lệnh lock_now
    /// xóa ghi đè mở khóa đang hiệu lực. Chỉ vòng poll lệnh ghi khóa này
    /// nên đọc-rồi-ghi không đua tranh với luồng khác. Mốc <c>default</c>
    /// (lệnh thiếu giờ tạo — không xảy ra qua RPC thật) thì bỏ qua, không
    /// ghi mốc năm 1 xuống DB.
    /// </summary>
    public async Task RaiseOverrideCommandFloorAsync(DateTimeOffset commandCreatedAt, CancellationToken ct)
        => await RaiseOverrideCommandFloorAsync(null, commandCreatedAt, ct);

    /// <summary>Nâng mốc sàn lệnh ghi đè của một con (Sprint 5): ghi khóa theo-con của con đó. Null = đường cũ (khóa gốc).</summary>
    public async Task RaiseOverrideCommandFloorAsync(Guid? childId, DateTimeOffset commandCreatedAt, CancellationToken ct)
    {
        if (commandCreatedAt == default)
        {
            return;
        }

        string key = childId is null
            ? StateKeys.OverrideCommandFloor
            : StateKeys.OverrideCommandFloorForChild(childId.Value);
        DateTimeOffset? current = childId is null
            ? await GetOverrideCommandFloorAsync(ct)
            : await GetOverrideCommandFloorAsync(childId, null, ct);
        DateTimeOffset raised = OverrideCommandOrder.RaiseFloor(current, commandCreatedAt);
        if (current is null || raised > current.Value)
        {
            await SetStateAsync(key, raised.ToString("o", CultureInfo.InvariantCulture), ct);
        }
    }

    /// <summary>
    /// Đọc mốc sàn lệnh khóa/mở bền vững (khóa <c>ForcedLockCommandFloor</c>
    /// trong <c>device_state</c>). Null khi chưa từng áp lệnh khóa/mở nào
    /// hoặc giá trị lưu bị hỏng — hỏng thì coi như không có mốc (fail-open
    /// về hành vi cũ, lần nâng sau ghi đè giá trị đúng).
    /// </summary>
    public async Task<DateTimeOffset?> GetForcedLockCommandFloorAsync(CancellationToken ct)
        => await GetForcedLockCommandFloorAsync(null, null, ct);

    /// <summary>
    /// Đọc mốc sàn lệnh khóa/mở của một con (Sprint 5) — cùng mẫu fallback
    /// về khóa gốc cho con mặc định như
    /// <see cref="GetOverrideCommandFloorAsync(Guid?, Guid?, CancellationToken)"/>.
    /// </summary>
    public async Task<DateTimeOffset?> GetForcedLockCommandFloorAsync(Guid? childId, Guid? defaultChildId, CancellationToken ct)
    {
        if (childId is null)
        {
            return await ReadFloorAsync(StateKeys.ForcedLockCommandFloor, ct);
        }

        DateTimeOffset? floor = await ReadFloorAsync(StateKeys.ForcedLockCommandFloorForChild(childId.Value), ct);
        if (childId.Value != defaultChildId)
        {
            return floor;
        }

        DateTimeOffset? legacy = await ReadFloorAsync(StateKeys.ForcedLockCommandFloor, ct);
        if (floor is null)
        {
            return legacy;
        }

        return legacy is null || floor.Value > legacy.Value ? floor : legacy;
    }

    /// <summary>
    /// Nâng mốc sàn lệnh khóa/mở lên <c>commandCreatedAt</c> (chỉ nâng, không
    /// bao giờ hạ). Gọi mỗi khi áp một lệnh lock_now hoặc unlock — kể cả
    /// lệnh khóa bị chốt chặn giữ ghi đè mở khóa mới hơn, vì cờ khóa cưỡng
    /// chế vẫn được đặt và trạng thái khóa khi đó phản ánh đúng lệnh khóa
    /// này. Chỉ vòng poll lệnh ghi khóa này nên đọc-rồi-ghi không đua tranh
    /// với luồng khác. Mốc <c>default</c> (lệnh thiếu giờ tạo — không xảy ra
    /// qua RPC thật) thì bỏ qua, không ghi mốc năm 1 xuống DB.
    /// </summary>
    public async Task RaiseForcedLockCommandFloorAsync(DateTimeOffset commandCreatedAt, CancellationToken ct)
        => await RaiseForcedLockCommandFloorAsync(null, commandCreatedAt, ct);

    /// <summary>Nâng mốc sàn lệnh khóa/mở của một con (Sprint 5): ghi khóa theo-con của con đó. Null = đường cũ (khóa gốc).</summary>
    public async Task RaiseForcedLockCommandFloorAsync(Guid? childId, DateTimeOffset commandCreatedAt, CancellationToken ct)
    {
        if (commandCreatedAt == default)
        {
            return;
        }

        string key = childId is null
            ? StateKeys.ForcedLockCommandFloor
            : StateKeys.ForcedLockCommandFloorForChild(childId.Value);
        DateTimeOffset? current = childId is null
            ? await GetForcedLockCommandFloorAsync(ct)
            : await GetForcedLockCommandFloorAsync(childId, null, ct);
        DateTimeOffset raised = OverrideCommandOrder.RaiseFloor(current, commandCreatedAt);
        if (current is null || raised > current.Value)
        {
            await SetStateAsync(key, raised.ToString("o", CultureInfo.InvariantCulture), ct);
        }
    }

    /// <summary>
    /// Cờ khóa cưỡng chế của một con có đang bật không (Sprint 5).
    /// <paramref name="childId"/> null = đường cũ (khóa gốc
    /// <c>forced_lock</c>). Con mặc định thì đọc khóa theo-con TRƯỚC, rơi
    /// về khóa gốc khi chưa có — máy nâng cấp từ bản cũ vẫn giữ lệnh khóa
    /// đang hiệu lực của con mặc định cho tới khi lệnh sau ghi đè.
    /// </summary>
    public async Task<bool> GetForcedLockAsync(Guid? childId, Guid? defaultChildId, CancellationToken ct)
    {
        if (childId is null)
        {
            return await GetStateAsync(StateKeys.ForcedLock, ct) is not null;
        }

        if (await GetStateAsync(StateKeys.ForcedLockForChild(childId.Value), ct) is not null)
        {
            return true;
        }

        return childId.Value == defaultChildId
            && await GetStateAsync(StateKeys.ForcedLock, ct) is not null;
    }

    /// <summary>
    /// Bật/tắt cờ khóa cưỡng chế của một con (Sprint 5).
    /// <paramref name="childId"/> null = đường cũ (ghi/xóa khóa gốc).
    /// Ghi cho con mặc định thì đồng thời XÓA khóa gốc (di trú một lần) để
    /// không còn hai nguồn sự thật song song: lần đọc sau chỉ còn khóa
    /// theo-con. Con khác thì khóa gốc không được chạm tới.
    /// </summary>
    public async Task SetForcedLockAsync(Guid? childId, Guid? defaultChildId, bool locked, CancellationToken ct)
    {
        if (childId is null)
        {
            if (locked)
            {
                await SetStateAsync(StateKeys.ForcedLock, "1", ct);
            }
            else
            {
                await DeleteStateAsync(StateKeys.ForcedLock, ct);
            }

            return;
        }

        string key = StateKeys.ForcedLockForChild(childId.Value);
        if (locked)
        {
            await SetStateAsync(key, "1", ct);
        }
        else
        {
            await DeleteStateAsync(key, ct);
        }

        if (childId.Value == defaultChildId)
        {
            await DeleteStateAsync(StateKeys.ForcedLock, ct);
        }
    }

    private static async Task DeleteOverrideRowAsync(SqliteConnection connection, string childKey, CancellationToken ct)
    {
        await using var delete = connection.CreateCommand();
        delete.CommandText = "DELETE FROM active_override WHERE child_key = $key;";
        delete.Parameters.AddWithValue("$key", childKey);
        await delete.ExecuteNonQueryAsync(ct);
    }

    /// <summary>Ghi một mẫu foreground do Tray gửi qua IPC. SID (nếu có) do Service đóng dấu từ bản tin hello của phiên gửi (xem IpcPipeServer) — mẫu không rõ phiên thì sid NULL, chỉ tính cho con mặc định của máy.</summary>
    public async Task RecordUsageSampleAsync(UsageSamplePayload sample, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(sample);

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO usage_samples (app_name, exe_path_hash, sampled_at, sid)
            VALUES ($app, $hash, $at, $sid);
            """;
        command.Parameters.AddWithValue("$app", sample.AppName);
        command.Parameters.AddWithValue("$hash", (object?)sample.ExePathHash ?? DBNull.Value);
        command.Parameters.AddWithValue("$at", sample.SampledAt.UtcDateTime.ToString("o"));
        command.Parameters.AddWithValue("$sid", (object?)sample.Sid ?? DBNull.Value);
        await command.ExecuteNonQueryAsync(ct);
    }

    /// <summary>
    /// Cửa sổ UTC của một "ngày thi hành": nửa đêm của ngày chứa
    /// <paramref name="dayInZone"/> theo offset của chính nó, tới nửa
    /// đêm hôm sau. Từ đợt giờ tin cậy (PRD §2.14) người gọi truyền
    /// giờ tin cậy đã quy đổi múi giờ gia đình (TrustedClock.FamilyNow)
    /// nên ngày thi hành không còn phụ thuộc đồng hồ/múi giờ máy.
    /// </summary>
    private static (string From, string To) DayWindowUtc(DateTimeOffset dayInZone)
    {
        var midnight = new DateTimeOffset(dayInZone.Date, dayInZone.Offset);
        string from = midnight.UtcDateTime.ToString("o", CultureInfo.InvariantCulture);
        string to = midnight.AddDays(1).UtcDateTime.ToString("o", CultureInfo.InvariantCulture);
        return (from, to);
    }

    /// <summary>
    /// Ước lượng thời gian đã dùng "hôm nay" theo NGÀY ĐỊA PHƯƠNG của máy con
    /// (quy tắc daily_limit tính theo giờ local) = số mẫu trong [nửa đêm
    /// local hôm nay, nửa đêm local ngày mai) x 15 giây/mẫu. Mẫu lưu theo giờ
    /// UTC nên ranh giới ngày local được đổi sang UTC trước khi so sánh chuỗi.
    /// Bản không tham số giữ cho người gọi cũ (ngày theo giờ máy); đường
    /// thi hành luật dùng bản có tham số với giờ tin cậy.
    /// </summary>
    public Task<TimeSpan> GetUsageTodayAsync(CancellationToken ct)
        => GetUsageTodayAsync(DateTimeOffset.Now, ct);

    /// <summary>Như <see cref="GetUsageTodayAsync(CancellationToken)"/> nhưng ranh giới ngày lấy theo <paramref name="dayInZone"/> (giờ tin cậy quy đổi múi giờ gia đình).</summary>
    public async Task<TimeSpan> GetUsageTodayAsync(DateTimeOffset dayInZone, CancellationToken ct)
    {
        (string from, string to) = DayWindowUtc(dayInZone);

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM usage_samples WHERE sampled_at >= $from AND sampled_at < $to;";
        command.Parameters.AddWithValue("$from", from);
        command.Parameters.AddWithValue("$to", to);
        object? scalar = await command.ExecuteScalarAsync(ct);
        long count = scalar is long c ? c : 0;
        return TimeSpan.FromSeconds(count * AgentConstants.ForegroundSampleInterval.TotalSeconds);
    }

    /// <summary>
    /// Thời gian đã dùng "hôm nay" của MỘT con (Sprint 5): chỉ đếm mẫu mang
    /// SID thuộc về con đó, cộng thêm mẫu không rõ phiên (sid NULL) khi phạm
    /// vi cho phép — mẫu không rõ phiên chỉ tính cho con mặc định của máy
    /// (xem <see cref="UsageScope"/>). Cùng ranh giới ngày địa phương như
    /// <see cref="GetUsageTodayAsync"/>.
    /// </summary>
    public Task<TimeSpan> GetUsageTodayForChildAsync(UsageScope scope, CancellationToken ct)
        => GetUsageTodayForChildAsync(scope, DateTimeOffset.Now, ct);

    /// <summary>Như <see cref="GetUsageTodayForChildAsync(UsageScope, CancellationToken)"/> nhưng ranh giới ngày lấy theo <paramref name="dayInZone"/> (giờ tin cậy quy đổi múi giờ gia đình).</summary>
    public async Task<TimeSpan> GetUsageTodayForChildAsync(UsageScope scope, DateTimeOffset dayInZone, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(scope);

        (string from, string to) = DayWindowUtc(dayInZone);

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        (string sidCondition, List<(string Name, object Value)> sidParameters) = BuildScopedSidCondition(scope);
        command.CommandText = "SELECT COUNT(*) FROM usage_samples WHERE sampled_at >= $from AND sampled_at < $to AND " + sidCondition + ";";
        command.Parameters.AddWithValue("$from", from);
        command.Parameters.AddWithValue("$to", to);
        foreach ((string name, object value) in sidParameters)
        {
            command.Parameters.AddWithValue(name, value);
        }

        object? scalar = await command.ExecuteScalarAsync(ct);
        long count = scalar is long c ? c : 0;
        return TimeSpan.FromSeconds(count * AgentConstants.ForegroundSampleInterval.TotalSeconds);
    }

    /// <summary>
    /// Xây điều kiện SID cho truy vấn usage theo phạm vi của một con
    /// (Sprint 5): mẫu thuộc phạm vi khi sid nằm trong danh sách SID của
    /// con đó, hoặc (khi phạm vi cho phép) sid IS NULL — mẫu không rõ phiên.
    /// Trả về (mảnh SQL điều kiện, tham số sid). Cùng mẫu dùng cho cả ba hàm
    /// đếm theo con (ngày / theo app / chuỗi thời gian) để không lệch nhau.
    /// </summary>
    private static (string Condition, List<(string Name, object Value)> Parameters) BuildScopedSidCondition(UsageScope scope)
    {
        var parameters = new List<(string, object)>();
        if (scope.Sids.Count == 0)
        {
            // Con chưa gắn SID nào (máy đơn-con chưa có ánh xạ): chỉ còn
            // mẫu không rõ phiên — khi phạm vi cho phép (con mặc định) thì
            // đếm đúng chúng, ngược lại không đếm gì.
            return scope.IncludeUnattributed ? ("sid IS NULL", parameters) : ("1 = 0", parameters);
        }

        var sidParams = new List<string>();
        for (int i = 0; i < scope.Sids.Count; i++)
        {
            string name = "$sid" + i;
            sidParams.Add(name);
            parameters.Add((name, scope.Sids[i]));
        }

        string inList = string.Join(", ", sidParams);
        string condition = scope.IncludeUnattributed
            ? $"(sid IN ({inList}) OR sid IS NULL)"
            : $"sid IN ({inList})";
        return (condition, parameters);
    }

    /// <summary>
    /// Thời gian đã dùng "hôm nay" (ngày địa phương, cùng ranh giới như
    /// <see cref="GetUsageTodayAsync"/>) theo từng app: số mẫu x 15 giây/mẫu,
    /// khóa theo <c>app_name</c> (tên process trần, không có ".exe"). Nơi gọi
    /// chuẩn hóa cả hai phía bằng <see cref="ExeNames"/> khi so khớp với
    /// config quy tắc (config ghi "game.exe").
    /// </summary>
    public Task<IReadOnlyDictionary<string, TimeSpan>> GetUsageByAppTodayAsync(CancellationToken ct)
        => GetUsageByAppTodayAsync(DateTimeOffset.Now, ct);

    /// <summary>Như <see cref="GetUsageByAppTodayAsync(CancellationToken)"/> nhưng ranh giới ngày lấy theo <paramref name="dayInZone"/> (giờ tin cậy quy đổi múi giờ gia đình).</summary>
    public async Task<IReadOnlyDictionary<string, TimeSpan>> GetUsageByAppTodayAsync(DateTimeOffset dayInZone, CancellationToken ct)
    {
        (string from, string to) = DayWindowUtc(dayInZone);

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
    /// Thời gian đã dùng "hôm nay" của MỘT con theo từng app (Sprint 5) —
    /// cùng phạm vi SID như <see cref="GetUsageTodayForChildAsync"/>.
    /// </summary>
    public Task<IReadOnlyDictionary<string, TimeSpan>> GetUsageByAppTodayForChildAsync(UsageScope scope, CancellationToken ct)
        => GetUsageByAppTodayForChildAsync(scope, DateTimeOffset.Now, ct);

    /// <summary>Như <see cref="GetUsageByAppTodayForChildAsync(UsageScope, CancellationToken)"/> nhưng ranh giới ngày lấy theo <paramref name="dayInZone"/> (giờ tin cậy quy đổi múi giờ gia đình).</summary>
    public async Task<IReadOnlyDictionary<string, TimeSpan>> GetUsageByAppTodayForChildAsync(UsageScope scope, DateTimeOffset dayInZone, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(scope);

        (string from, string to) = DayWindowUtc(dayInZone);

        var usage = new Dictionary<string, TimeSpan>(StringComparer.Ordinal);

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        (string sidCondition, List<(string Name, object Value)> sidParameters) = BuildScopedSidCondition(scope);
        command.CommandText =
            "SELECT app_name, COUNT(*) FROM usage_samples WHERE sampled_at >= $from AND sampled_at < $to AND "
            + sidCondition + " GROUP BY app_name;";
        command.Parameters.AddWithValue("$from", from);
        command.Parameters.AddWithValue("$to", to);
        foreach ((string name, object value) in sidParameters)
        {
            command.Parameters.AddWithValue(name, value);
        }

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

    /// <summary>
    /// Các thời điểm lấy mẫu của MỘT con mới hơn <paramref name="since"/>
    /// (Sprint 5) — cùng phạm vi SID như
    /// <see cref="GetUsageTodayForChildAsync"/>; nghỉ bắt buộc của con nào
    /// thì tính chuỗi dùng của con đó (trạng thái nghỉ vẫn giữ ở cấp máy
    /// trong đợt 1 — xem docs/02-ARCHITECTURE.md §4.13).
    /// </summary>
    public async Task<IReadOnlyList<DateTimeOffset>> GetSampleTimesSinceForChildAsync(DateTimeOffset since, UsageScope scope, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(scope);

        var times = new List<DateTimeOffset>();

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        (string sidCondition, List<(string Name, object Value)> sidParameters) = BuildScopedSidCondition(scope);
        command.CommandText =
            "SELECT sampled_at FROM usage_samples WHERE sampled_at > $since AND "
            + sidCondition + " ORDER BY sampled_at ASC;";
        command.Parameters.AddWithValue("$since", since.UtcDateTime.ToString("o", CultureInfo.InvariantCulture));
        foreach ((string name, object value) in sidParameters)
        {
            command.Parameters.AddWithValue(name, value);
        }

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
    /// Nhóm theo cả tên app, hash exe VÀ sid để hai con dùng chung app
    /// không bị gộp chung giờ (Sprint 5) — server suy ra con theo SID của
    /// từng nhóm; nhóm sid NULL là mẫu không rõ phiên, server ghi theo con
    /// mặc định của máy.
    /// </summary>
    public async Task<IReadOnlyList<UsageSummary>> GetUsageSummaryAsync(DateTimeOffset since, CancellationToken ct)
    {
        var summaries = new List<UsageSummary>();

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT app_name, exe_path_hash, sid, COUNT(*), MIN(sampled_at), MAX(sampled_at)
            FROM usage_samples
            WHERE sampled_at > $since
            GROUP BY app_name, exe_path_hash, sid
            ORDER BY MIN(sampled_at) ASC;
            """;
        command.Parameters.AddWithValue("$since", since.UtcDateTime.ToString("o", CultureInfo.InvariantCulture));

        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            string appName = reader.GetString(0);
            string? hash = reader.IsDBNull(1) ? null : reader.GetString(1);
            string? sid = reader.IsDBNull(2) ? null : reader.GetString(2);
            long count = reader.GetInt64(3);
            if (!DateTimeOffset.TryParse(reader.GetString(4), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset first)
                || !DateTimeOffset.TryParse(reader.GetString(5), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset last))
            {
                continue;
            }

            summaries.Add(new UsageSummary(appName, hash, count, first, last, sid));
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
