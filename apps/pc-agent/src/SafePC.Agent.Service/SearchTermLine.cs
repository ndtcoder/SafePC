using System.Text.Json;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>
/// Phân tích một dòng cụm từ tìm kiếm trong file JSONL
/// <c>search_terms.jsonl</c> do NativeHost ghi — logic thuần, không chạm
/// đĩa/mạng, soi mẫu <see cref="WebUsageLine"/>.
///
/// Mỗi dòng là một JSON {engine, term, blocked?, windows_sid?,
/// username?} — engine là id ngắn của công cụ tìm kiếm, term là cụm từ
/// GỐC đã giải mã (kênh duy nhất được mang cụm từ tìm kiếm, theo quyết
/// định riêng tư của phụ huynh 27/11/2026), blocked là cờ lượt tìm bị
/// chặn vì chứa từ khóa cấm. <c>username</c> chỉ để gỡ lỗi, Service
/// không dùng (quyết định theo SID).
///
/// Luật kiểm tra (khớp NativeHost + RPC migration 28):
/// - Engine: chuỗi, trim + chữ thường, 1-32 ký tự, không khoảng trắng
///   hay ký tự điều khiển.
/// - Term: chuỗi, không rỗng sau khi trim; giữ nguyên chữ gốc, cắt lại
///   ở 200 ký tự (không chẻ đôi cặp surrogate) — phòng thủ theo chiều
///   sâu vì file JSONL nằm ở thư mục chia sẻ.
/// - blocked không phải boolean (khi có mặt) thì dòng không hợp lệ.
/// - windows_sid không phải chuỗi (khi có mặt) thì dòng không hợp lệ;
///   chuỗi thì trim, rỗng hoặc dài quá 256 ký tự thì coi như không có
///   SID (giữ mẫu, server ghi theo con mặc định) — như WebUsageLine.
/// </summary>
internal static class SearchTermLine
{
    /// <summary>Phân tích một dòng JSONL thành mẫu tìm kiếm, hoặc null khi dòng hỏng/thiếu trường bắt buộc.</summary>
    public static SearchTermRecord? TryParse(string line)
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

            if (!root.TryGetProperty("engine", out JsonElement engineElement)
                || engineElement.ValueKind != JsonValueKind.String
                || engineElement.GetString() is not string rawEngine)
            {
                return null;
            }

            string engine = rawEngine.Trim().ToLowerInvariant();
            if (engine.Length == 0 || engine.Length > 32)
            {
                return null;
            }

            foreach (char c in engine)
            {
                if (char.IsWhiteSpace(c) || char.IsControl(c))
                {
                    return null;
                }
            }

            if (!root.TryGetProperty("term", out JsonElement termElement)
                || termElement.ValueKind != JsonValueKind.String
                || termElement.GetString() is not string term)
            {
                return null;
            }

            if (term.Trim().Length == 0)
            {
                return null;
            }

            if (term.Length > 200)
            {
                term = term[..200];
                if (char.IsHighSurrogate(term[^1]))
                {
                    term = term[..^1];
                }
            }

            bool blocked = false;
            if (root.TryGetProperty("blocked", out JsonElement blockedElement))
            {
                if (blockedElement.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                {
                    return null;
                }

                blocked = blockedElement.GetBoolean();
            }

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

            return new SearchTermRecord
            {
                Engine = engine,
                Term = term,
                Blocked = blocked,
                WindowsSid = windowsSid,
            };
        }
    }
}
