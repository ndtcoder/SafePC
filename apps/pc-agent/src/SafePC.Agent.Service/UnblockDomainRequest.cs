using System.Globalization;
using System.Text.Json;

namespace SafePC.Agent.Service;

/// <summary>Một yêu cầu xin mở domain đã phân tích: domain + SID của tài khoản Windows đã bấm nút xin mở (null khi dòng cũ không có SID — server ghi theo con mặc định của máy).</summary>
internal sealed record DomainRequest(string Domain, string? Sid);

/// <summary>
/// Phân tích dòng yêu cầu xin mở domain trong file JSONL
/// <c>domain_requests.jsonl</c> do NativeHost ghi (message
/// <c>requestUnblock</c> từ extension 0.1.9). Logic thuần, không chạm
/// đĩa/mạng, để kiểm tra được bằng harness.
///
/// Mỗi dòng là một JSON {"domain","requestedAt?","windows_sid?","username?"}
/// — chỉ tên miền, không URL/path/query. <c>requestedAt</c> là thông tin gỡ
/// lỗi, Service không dùng để quyết định gì (thời điểm tạo yêu cầu lấy theo
/// giờ server lúc RPC chèn hàng) nên dòng thiếu nó vẫn hợp lệ.
/// <c>windows_sid</c> (Sprint 5) là SID của tài khoản Windows đã bấm nút —
/// server suy ra hồ sơ con qua bảng device_child_accounts; dòng cũ không có
/// SID thì server ghi theo con mặc định. <c>username</c> chỉ để gỡ lỗi,
/// Service không dùng.
/// </summary>
internal static class DomainRequestLine
{
    /// <summary>
    /// Trả về tên miền đã chuẩn hóa (trim + chữ thường) khi dòng hợp lệ,
    /// null khi dòng hỏng/thiếu domain/domain chứa ký tự cấm. Không bao giờ
    /// ném exception, không log (nơi gọi chỉ đếm dòng lỗi).
    /// </summary>
    public static string? TryParseDomain(string line)
        => TryParseRequest(line)?.Domain;

    /// <summary>
    /// Trả về yêu cầu đã phân tích (domain + SID, SID null khi dòng cũ
    /// không có), null khi dòng hỏng. SID có mà không phải chuỗi thì dòng
    /// không hợp lệ (cùng độ nghiêm với domain); chuỗi rỗng hoặc dài quá
    /// 256 thì coi như không có SID — giữ yêu cầu, chỉ mất ghi công.
    /// </summary>
    public static DomainRequest? TryParseRequest(string line)
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

            string? sid = null;
            if (root.TryGetProperty("windows_sid", out JsonElement sidElement))
            {
                if (sidElement.ValueKind != JsonValueKind.String
                    || sidElement.GetString() is not string rawSid)
                {
                    return null;
                }

                string trimmed = rawSid.Trim();
                if (trimmed.Length > 0 && trimmed.Length <= 256)
                {
                    sid = trimmed;
                }
            }

            return new DomainRequest(domain, sid);
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
/// Chống spam phía Service cho yêu cầu xin mở domain: một (domain, tài
/// khoản) đã gửi thành công thì không gửi lại trong cửa sổ 5 phút (con bấm
/// nút liên tục hoặc tải lại trang chặn rồi bấm tiếp cũng chỉ tạo một lần
/// gửi). Khóa theo cặp (domain, sid) — Sprint 5: hai con xin mở cùng một
/// domain là hai yêu cầu riêng (RPC chống trùng theo (device, child,
/// domain)), nên throttle không được gộp chúng. Lớp chống trùng thật nằm ở
/// RPC (yêu cầu pending cho cùng device+domain thì trả về hàng cũ);
/// throttle này chỉ tránh gọi RPC vô ích. Trạng thái chỉ trong bộ nhớ —
/// Service khởi động lại thì throttle rỗng, RPC vẫn chặn trùng. Logic thuần
/// theo giờ truyền vào, để kiểm tra được bằng harness.
/// </summary>
internal sealed class DomainRequestThrottle
{
    /// <summary>Cửa sổ chặn gửi lại sau một lần gửi thành công.</summary>
    public static readonly TimeSpan Window = TimeSpan.FromMinutes(5);

    private const int MaxEntries = 200;

    private readonly Dictionary<string, DateTimeOffset> _lastSentByDomain = new(StringComparer.Ordinal);

    /// <summary>(Domain, SID) này có được gửi ngay không (chưa gửi, hoặc lần gửi trước đã quá cửa sổ).</summary>
    public bool ShouldSend(string domain, string? sid, DateTimeOffset now)
    {
        if (_lastSentByDomain.TryGetValue(Key(domain, sid), out DateTimeOffset lastSent))
        {
            return now - lastSent >= Window;
        }

        return true;
    }

    /// <summary>Ghi dấu một lần gửi thành công. Chỉ gọi khi RPC đã trả về thành công.</summary>
    public void RecordSent(string domain, string? sid, DateTimeOffset now)
    {
        _lastSentByDomain[Key(domain, sid)] = now;
        if (_lastSentByDomain.Count > MaxEntries)
        {
            Prune(now);
        }
    }

    /// <summary>Khóa throttle theo cặp (domain, sid): sid null (dòng cũ không có SID) có khóa riêng, không gộp với SID nào.</summary>
    private static string Key(string domain, string? sid) => domain + "\n" + (sid ?? string.Empty);

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
