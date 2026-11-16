using System.Text.Json;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>Kết quả đánh giá rules: cho phép, cảnh báo, hay khóa.</summary>
public enum RuleDecisionKind
{
    Allowed,
    Warn,
    Lock,
}

/// <summary>Kết quả đánh giá rules tại một thời điểm.</summary>
public sealed record RuleDecision(RuleDecisionKind Kind, string Reason, int MinutesLeft);

/// <summary>
/// Đánh giá rules từ cache local (thuần logic, không I/O — dễ kiểm thử).
/// Thứ tự: bedtime trước, rồi daily_limit.
///
/// Định dạng config (JSONB, khớp cột rules.config):
/// - bedtime: {"start":"21:30","end":"07:00"} (giờ địa phương, qua đêm được).
/// - daily_limit: {"daily_minutes":120}
///
/// TODO Sprint 1: daily_limit theo thứ trong tuần (VD: T2-T6: 120, T7-CN: 180).
/// TODO Sprint 2: rule theo app (chặn/giới hạn từng app, dùng foregroundAppName)
/// và rule website (phối hợp với extension). Hiện các rule đó được bỏ qua.
/// </summary>
public sealed class RuleEngine
{
    public RuleDecision Evaluate(
        IReadOnlyList<Rule> rules,
        TimeSpan usedToday,
        DateTimeOffset now,
        string? foregroundAppName)
    {
        ArgumentNullException.ThrowIfNull(rules);

        foreach (Rule rule in rules)
        {
            if (!rule.Enabled || rule.Type != RuleTypes.Bedtime)
            {
                continue;
            }

            RuleDecision? bedtime = CheckBedtime(rule, now);
            if (bedtime is not null)
            {
                return bedtime;
            }
        }

        foreach (Rule rule in rules)
        {
            if (!rule.Enabled || rule.Type != RuleTypes.DailyLimit)
            {
                continue;
            }

            RuleDecision? limit = CheckDailyLimit(rule, usedToday);
            if (limit is not null)
            {
                return limit;
            }
        }

        // TODO Sprint 2: dùng foregroundAppName để đánh giá rule loại "app".
        _ = foregroundAppName;
        return new RuleDecision(RuleDecisionKind.Allowed, string.Empty, int.MaxValue);
    }

    private static RuleDecision? CheckBedtime(Rule rule, DateTimeOffset now)
    {
        if (!TryGetString(rule.Config, "start", out string? startText)
            || !TryGetString(rule.Config, "end", out string? endText))
        {
            return null;
        }

        if (!TimeOnly.TryParse(startText, out TimeOnly start)
            || !TimeOnly.TryParse(endText, out TimeOnly end))
        {
            return null;
        }

        TimeOnly current = TimeOnly.FromDateTime(now.LocalDateTime);
        bool inBedtime = start <= end
            ? current >= start && current < end
            : current >= start || current < end;

        if (!inBedtime)
        {
            return null;
        }

        return new RuleDecision(RuleDecisionKind.Lock, "Đã đến giờ ngủ.", 0);
    }

    private static RuleDecision? CheckDailyLimit(Rule rule, TimeSpan usedToday)
    {
        if (!TryGetInt32(rule.Config, "daily_minutes", out int dailyMinutes))
        {
            return null;
        }

        int minutesLeft = dailyMinutes - (int)usedToday.TotalMinutes;
        if (minutesLeft <= 0)
        {
            return new RuleDecision(RuleDecisionKind.Lock, "Đã hết thời gian dùng máy hôm nay.", 0);
        }

        if (minutesLeft <= 15)
        {
            return new RuleDecision(RuleDecisionKind.Warn, "Sắp hết thời gian dùng máy.", minutesLeft);
        }

        return null;
    }

    private static bool TryGetString(JsonElement config, string property, out string? value)
    {
        value = null;
        return config.ValueKind == JsonValueKind.Object
            && config.TryGetProperty(property, out JsonElement element)
            && element.ValueKind == JsonValueKind.String
            && (value = element.GetString()) is not null;
    }

    private static bool TryGetInt32(JsonElement config, string property, out int value)
    {
        value = 0;
        return config.ValueKind == JsonValueKind.Object
            && config.TryGetProperty(property, out JsonElement element)
            && element.ValueKind == JsonValueKind.Number
            && element.TryGetInt32(out value);
    }
}
