using System.Globalization;
using System.Text.Json;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>
/// Phân tích một dòng lượt thăm web trong file JSONL
/// <c>web_usage.jsonl</c> do NativeHost ghi — logic thuần, không chạm
/// đĩa/mạng, để kiểm tra được bằng harness.
///
/// Mỗi dòng là một JSON {domain, startedAt, durationSec, blocked?, path?,
/// windows_sid?, username?} — chỉ domain + đường dẫn + thời điểm + thời
/// lượng + cờ bị chặn + SID tài khoản Windows đã thăm (Sprint 5), không
/// URL đầy đủ, query, fragment hay tiêu đề trang. <c>username</c> chỉ để
/// gỡ lỗi, Service không dùng (quyết định theo SID). Dòng cũ không có
/// blocked/path/windows_sid vẫn đọc được (tương thích ngược).
///
/// Luật kiểm tra (khớp NativeHost + RPC migration 19/24):
/// - Domain: 1-253 ký tự, không khoảng trắng, '/', '?' hay '#'.
/// - Thời lượng kẹp về 0..86400 (khớp RPC).
/// - blocked không phải boolean (khi có mặt) thì dòng không hợp lệ.
/// - path không phải chuỗi (khi có mặt) thì dòng không hợp lệ; chuỗi thì
///   cắt lại qua WebVisitPath (bỏ query/fragment, trần 500 ký tự); lượt bị
///   chặn không mang đường dẫn.
/// - windows_sid không phải chuỗi (khi có mặt) thì dòng không hợp lệ; chuỗi
///   thì trim, rỗng hoặc dài quá 256 ký tự thì coi như không có SID (giữ
///   lượt thăm, server ghi theo con mặc định) — SID là metadata ghi công,
///   không được làm mất lượt thăm thật.
/// </summary>
internal static class WebUsageLine
{
    /// <summary>Phân tích một dòng JSONL thành lượt thăm, hoặc null khi dòng hỏng/thiếu trường bắt buộc.</summary>
    public static WebVisitRecord? TryParse(string line)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(line);
        }
        catch (JsonException)
        {
            return null;
        }

        using (document)
        {
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            if (!root.TryGetProperty("domain", out JsonElement domainElement)
                || domainElement.ValueKind != JsonValueKind.String
                || domainElement.GetString() is not string rawDomain)
            {
                return null;
            }

            string domain = rawDomain.Trim().ToLowerInvariant();
            if (!IsValidDomain(domain))
            {
                return null;
            }

            if (!root.TryGetProperty("startedAt", out JsonElement startedElement)
                || startedElement.ValueKind != JsonValueKind.String
                || startedElement.GetString() is not string startedText
                || !DateTimeOffset.TryParse(startedText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset visitedAt))
            {
                return null;
            }

            if (!root.TryGetProperty("durationSec", out JsonElement durationElement)
                || durationElement.ValueKind != JsonValueKind.Number)
            {
                return null;
            }

            double seconds;
            if (durationElement.TryGetInt32(out int intSeconds))
            {
                seconds = intSeconds;
            }
            else if (durationElement.TryGetDouble(out double doubleSeconds))
            {
                seconds = doubleSeconds;
            }
            else
            {
                return null;
            }

            int durationSec = (int)Math.Clamp(Math.Truncate(seconds), 0, 86400);

            // Cờ bị chặn (migration 10, extension 0.1.7): dòng cũ không có
            // trường này thì coi là false; có mà không phải boolean thì
            // dòng không hợp lệ (cùng độ nghiêm với các trường khác).
            bool blocked = false;
            if (root.TryGetProperty("blocked", out JsonElement blockedElement))
            {
                if (blockedElement.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                {
                    return null;
                }

                blocked = blockedElement.GetBoolean();
            }

            // Đường dẫn (migration 19, extension 0.1.10): dòng cũ không
            // có trường này thì coi là không có đường dẫn; có mà không
            // phải chuỗi thì dòng không hợp lệ (cùng độ nghiêm với cờ
            // blocked). Chuỗi thì cắt lại qua WebVisitPath — phòng thủ
            // theo chiều sâu vì file JSONL nằm ở thư mục chia sẻ, dòng
            // viết tay có thể mang query/fragment; cắt không ra đường
            // dẫn dùng được thì giữ lượt thăm ở dạng chỉ-domain, không
            // vứt cả dòng. Lượt bị chặn không mang đường dẫn.
            string? path = null;
            if (root.TryGetProperty("path", out JsonElement pathElement))
            {
                if (pathElement.ValueKind != JsonValueKind.String
                    || pathElement.GetString() is not string rawPath)
                {
                    return null;
                }

                path = WebVisitPath.Sanitize(rawPath);
            }

            if (blocked)
            {
                path = null;
            }

            // SID tài khoản Windows đã thăm (Sprint 5, migration 24): dòng
            // cũ không có thì null (server ghi theo con mặc định); có mà
            // không phải chuỗi thì dòng không hợp lệ (cùng độ nghiêm với
            // path/blocked); chuỗi rỗng hoặc dài quá 256 thì coi như không
            // có SID — giữ lượt thăm, chỉ mất ghi công.
            string? windowsSid = null;
            if (root.TryGetProperty("windows_sid", out JsonElement sidElement))
            {
                if (sidElement.ValueKind != JsonValueKind.String
                    || sidElement.GetString() is not string rawSid)
                {
                    return null;
                }

                string sid = rawSid.Trim();
                if (sid.Length > 0 && sid.Length <= 256)
                {
                    windowsSid = sid;
                }
            }

            return new WebVisitRecord
            {
                Domain = domain,
                Path = path,
                VisitedAt = visitedAt,
                DurationSec = durationSec,
                Blocked = blocked,
                WindowsSid = windowsSid,
            };
        }
    }

    /// <summary>Cùng luật domain như lượt thăm web: 1-253 ký tự, không khoảng trắng, ký tự điều khiển, '/', '?' hay '#'.</summary>
    public static bool IsValidDomain(string domain)
    {
        if (domain.Length == 0 || domain.Length > 253)
        {
            return false;
        }

        foreach (char c in domain)
        {
            if (char.IsWhiteSpace(c) || char.IsControl(c) || c == '/' || c == '?' || c == '#')
            {
                return false;
            }
        }

        return true;
    }
}
