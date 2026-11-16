using System.Text.Json;
using System.Text.Json.Serialization;

namespace SafePC.Agent.Shared;

// Các model dùng chung. Tên property JSON (JsonPropertyName) khớp tên cột
// trong migration backend/supabase/migrations/20261116102900_init_safepc.sql.

/// <summary>Khớp bảng <c>devices</c>.</summary>
public sealed class DeviceInfo
{
    [JsonPropertyName("id")]
    public Guid Id { get; set; }

    [JsonPropertyName("family_id")]
    public Guid FamilyId { get; set; }

    [JsonPropertyName("child_id")]
    public Guid? ChildId { get; set; }

    [JsonPropertyName("hostname")]
    public string Hostname { get; set; } = string.Empty;

    [JsonPropertyName("os_version")]
    public string? OsVersion { get; set; }

    [JsonPropertyName("agent_version")]
    public string? AgentVersion { get; set; }

    [JsonPropertyName("last_seen_at")]
    public DateTimeOffset? LastSeenAt { get; set; }

    [JsonPropertyName("status")]
    public string Status { get; set; } = "offline";
}

/// <summary>Các giá trị của cột <c>rules.type</c>.</summary>
public static class RuleTypes
{
    public const string DailyLimit = "daily_limit";
    public const string Bedtime = "bedtime";
    public const string App = "app";
    public const string Website = "website";
}

/// <summary>Các giá trị của cột <c>commands.type</c>.</summary>
public static class CommandTypes
{
    public const string LockNow = "lock_now";
    public const string Unlock = "unlock";
    public const string RefreshRules = "refresh_rules";
    public const string Update = "update";
}

/// <summary>Khớp bảng <c>rules</c>. Cột <c>config</c> là JSONB, giữ nguyên dạng JsonElement.</summary>
public sealed class Rule
{
    [JsonPropertyName("id")]
    public Guid Id { get; set; }

    [JsonPropertyName("family_id")]
    public Guid FamilyId { get; set; }

    [JsonPropertyName("child_id")]
    public Guid ChildId { get; set; }

    [JsonPropertyName("type")]
    public string Type { get; set; } = string.Empty;

    [JsonPropertyName("config")]
    public JsonElement Config { get; set; }

    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; } = true;

    [JsonPropertyName("created_at")]
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>Khớp bảng <c>commands</c> (lệnh phụ huynh gửi xuống máy con).</summary>
public sealed class Command
{
    [JsonPropertyName("id")]
    public Guid Id { get; set; }

    [JsonPropertyName("family_id")]
    public Guid FamilyId { get; set; }

    [JsonPropertyName("device_id")]
    public Guid DeviceId { get; set; }

    [JsonPropertyName("type")]
    public string Type { get; set; } = string.Empty;

    [JsonPropertyName("payload")]
    public JsonElement Payload { get; set; }

    [JsonPropertyName("status")]
    public string Status { get; set; } = "pending";

    [JsonPropertyName("created_at")]
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// Khớp bảng <c>app_usage</c>.
/// Chỉ lưu tên app + hash đường dẫn exe, KHÔNG lưu đường dẫn thô
/// (đường dẫn có thể lộ username Windows — docs/03-SECURITY.md mục 3).
/// </summary>
public sealed class UsageRecord
{
    [JsonPropertyName("id")]
    public Guid Id { get; set; } = Guid.NewGuid();

    [JsonPropertyName("family_id")]
    public Guid FamilyId { get; set; }

    [JsonPropertyName("device_id")]
    public Guid DeviceId { get; set; }

    [JsonPropertyName("child_id")]
    public Guid ChildId { get; set; }

    [JsonPropertyName("app_name")]
    public string AppName { get; set; } = string.Empty;

    [JsonPropertyName("exe_path_hash")]
    public string? ExePathHash { get; set; }

    [JsonPropertyName("started_at")]
    public DateTimeOffset StartedAt { get; set; }

    [JsonPropertyName("duration_sec")]
    public int DurationSec { get; set; }
}
