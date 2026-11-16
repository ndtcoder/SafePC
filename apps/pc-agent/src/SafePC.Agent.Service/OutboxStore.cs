using System.Globalization;
using System.Text.Json;
using System.Threading;
using Microsoft.Data.Sqlite;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>Một bản ghi chờ gửi trong bảng outbox.</summary>
public sealed record OutboxItem(long Id, string PayloadJson);

/// <summary>
/// Lưu trữ local SQLite cho Service (offline-first, docs/02-ARCHITECTURE.md mục 4.2):
/// - Bảng <c>outbox</c>: usage batch chưa gửi, retry với backoff.
/// - Bảng <c>rules_cache</c>: rules tải về lần cuối, để mất mạng vẫn thi hành đúng.
/// - Bảng <c>usage_samples</c>: mẫu foreground Tray gửi qua IPC, dùng ước lượng
///   thời gian đã dùng hôm nay.
/// - Bảng <c>active_override</c>: ghi đè tạm thời đang hiệu lực (tối đa 1 hàng),
///   để ghi đè không bị mất khi Service khởi động lại và vẫn hết hạn đúng giờ.
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
                updated_at TEXT NOT NULL
            );
            """;
        await command.ExecuteNonQueryAsync(ct);
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
    /// Chỉ có tối đa 1 hàng (id = 1).
    /// </summary>
    public async Task SaveOverrideAsync(TemporaryOverride ov, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ov);

        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO active_override (id, action, minutes, expires_at, updated_at)
            VALUES (1, $action, $minutes, $expires, $now)
            ON CONFLICT(id) DO UPDATE SET
                action = excluded.action,
                minutes = excluded.minutes,
                expires_at = excluded.expires_at,
                updated_at = excluded.updated_at;
            """;
        command.Parameters.AddWithValue("$action", ov.Action);
        command.Parameters.AddWithValue("$minutes", ov.Minutes);
        command.Parameters.AddWithValue("$expires", ov.ExpiresAt.ToString("o", CultureInfo.InvariantCulture));
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
        await using (var select = connection.CreateCommand())
        {
            select.CommandText = "SELECT action, minutes, expires_at FROM active_override WHERE id = 1;";
            await using var reader = await select.ExecuteReaderAsync(ct);
            if (await reader.ReadAsync(ct))
            {
                action = reader.GetString(0);
                minutes = reader.GetInt64(1);
                expiresText = reader.GetString(2);
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

        return new TemporaryOverride(action, (int)minutes, expiresAt);
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
    /// Ước lượng thời gian đã dùng hôm nay (UTC) = số mẫu x 15 giây/mẫu.
    /// TODO Sprint 1: thay bằng tổng hợp theo phiên (session) chính xác hơn và
    /// tổng hợp thành UsageRecord gửi lên server, kèm dọn mẫu cũ.
    /// </summary>
    public async Task<TimeSpan> GetUsageTodayAsync(CancellationToken ct)
    {
        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);

        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM usage_samples WHERE substr(sampled_at, 1, 10) = $today;";
        command.Parameters.AddWithValue("$today", DateTimeOffset.UtcNow.ToString("yyyy-MM-dd"));
        object? value = await command.ExecuteScalarAsync(ct);
        long count = value is long c ? c : 0;
        return TimeSpan.FromSeconds(count * AgentConstants.ForegroundSampleInterval.TotalSeconds);
    }
}
