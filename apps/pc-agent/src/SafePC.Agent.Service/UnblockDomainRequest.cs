using System.Globalization;
using System.Text.Json;

namespace SafePC.Agent.Service;

/// <summary>
/// Phân tích dòng yêu cầu xin mở domain trong file JSONL
/// <c>domain_requests.jsonl</c> do NativeHost ghi (message
/// <c>requestUnblock</c> từ extension 0.1.9). Logic thuần, không chạm
/// đĩa/mạng, để kiểm tra được bằng harness.
///
/// Mỗi dòng là một JSON {"domain","requestedAt?"} — chỉ tên miền, không
/// URL/path/query. <c>requestedAt</c> là thông tin gỡ lỗi, Service không
/// dùng để quyết định gì (thời điểm tạo yêu cầu lấy theo giờ server lúc
/// RPC chèn hàng) nên dòng thiếu nó vẫn hợp lệ.
/// </summary>
internal static class DomainRequestLine
{
    /// <summary>
    /// Trả về tên miền đã chuẩn hóa (trim + chữ thường) khi dòng hợp lệ,
    /// null khi dòng hỏng/thiếu domain/domain chứa ký tự cấm. Không bao giờ
    /// ném exception, không log (nơi gọi chỉ đếm dòng lỗi).
    /// </summary>
    public static string? TryParseDomain(string line)
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

            return domain;
        }
    }

    /// <summary>
    /// Cùng luật domain như lượt thăm web: 1-253 ký tự, không khoảng trắng,
    /// ký tự điều khiển, '/', '?' hay '#'.
    /// </summary>
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

/// <summary>
/// Chống spam phía Service cho yêu cầu xin mở domain: một domain đã gửi
/// thành công thì không gửi lại trong cửa sổ 5 phút (con bấm nút liên tục
/// hoặc tải lại trang chặn rồi bấm tiếp cũng chỉ tạo một lần gửi). Lớp
/// chống trùng thật nằm ở RPC (yêu cầu pending cho cùng device+domain thì
/// trả về hàng cũ); throttle này chỉ tránh gọi RPC vô ích. Trạng thái chỉ
/// trong bộ nhớ — Service khởi động lại thì throttle rỗng, RPC vẫn chặn
/// trùng. Logic thuần theo giờ truyền vào, để kiểm tra được bằng harness.
/// </summary>
internal sealed class DomainRequestThrottle
{
    /// <summary>Cửa sổ chặn gửi lại sau một lần gửi thành công.</summary>
    public static readonly TimeSpan Window = TimeSpan.FromMinutes(5);

    private const int MaxEntries = 200;

    private readonly Dictionary<string, DateTimeOffset> _lastSentByDomain = new(StringComparer.Ordinal);

    /// <summary>Domain này có được gửi ngay không (chưa gửi, hoặc lần gửi trước đã quá cửa sổ).</summary>
    public bool ShouldSend(string domain, DateTimeOffset now)
    {
        if (_lastSentByDomain.TryGetValue(domain, out DateTimeOffset lastSent))
        {
            return now - lastSent >= Window;
        }

        return true;
    }

    /// <summary>Ghi dấu một lần gửi thành công. Chỉ gọi khi RPC đã trả về thành công.</summary>
    public void RecordSent(string domain, DateTimeOffset now)
    {
        _lastSentByDomain[domain] = now;
        if (_lastSentByDomain.Count > MaxEntries)
        {
            Prune(now);
        }
    }

    private void Prune(DateTimeOffset now)
    {
        var expired = new List<string>();
        foreach (KeyValuePair<string, DateTimeOffset> entry in _lastSentByDomain)
        {
            if (now - entry.Value >= Window)
            {
                expired.Add(entry.Key);
            }
        }

        foreach (string key in expired)
        {
            _lastSentByDomain.Remove(key);
        }
    }
}
