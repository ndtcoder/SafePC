using System.Buffers.Binary;
using System.Globalization;
using System.Text;
using System.Text.Json;
using SafePC.Agent.Shared;

namespace SafePC.Agent.NativeHost;

/// <summary>
/// Native messaging host cho extension trình duyệt SafePC (Sprint 2 đợt 2).
///
/// Chrome/Edge chạy process này (stdio) khi extension gọi
/// chrome.runtime.sendNativeMessage. Giao thức: mỗi message là 4 byte độ dài
/// (little-endian) + JSON UTF-8, theo spec native messaging của Chrome.
/// Host đọc message cho tới khi stdin đóng (EOF): sendNativeMessage gửi một
/// message rồi kết thúc process, cổng dài hạn (connectNative) gửi nhiều
/// message — cả hai đều chạy đúng với vòng lặp này.
///
/// Message:
/// - {"type":"getRules"} -&gt; {"type":"rules","rules":&lt;nội dung
///   domain_rules.json&gt; | null khi chưa có file}.
/// - {"type":"reportUsage","visits":[{"domain","startedAt","durationSec",
///   "blocked"?,"path"?}]} -&gt; ghi thêm (append) các dòng JSONL vào web_usage.jsonl,
///   trả {"type":"ack","ok":true|false}. blocked (tùy chọn, extension 0.1.7)
///   chỉ ghi vào dòng JSONL khi true; dòng cũ không có blocked thì Service
///   coi là false — cả hai chiều đều tương thích ngược. path (tùy chọn,
///   extension 0.1.10) chỉ ghi khi đã cắt sạch; visit bị chặn thì bỏ path.
/// - {"type":"requestUnblock","domain"} (extension 0.1.9) -&gt; ghi thêm một
///   dòng {"domain","requestedAt"} vào domain_requests.jsonl để Service đọc
///   trong chu kỳ poll lệnh, trả {"type":"ack","ok":true|false}. Chỉ tên
///   miền, cùng luật kiểm tra domain như visit (không '/', '?', '#',
///   khoảng trắng, ký tự điều khiển).
/// Mỗi message getRules/reportUsage (kể cả message lỗi) còn ghi đè timestamp
/// UTC hiện tại vào extension_heartbeat.txt — dấu hiệu extension còn sống để
/// Service đọc và báo lên server (Sprint 2 đợt 3). Ghi heartbeat không bao
/// giờ làm lỗi message: lỗi thì chỉ log ra stderr.
///
/// RANH GIỚI TIN CẬY (docs/03-SECURITY.md): host CHỈ đọc/ghi trong thư mục
/// chia sẻ %ProgramData%\SafePC\shared\, KHÔNG bao giờ chạm tới file token
/// (device_token.dat) hay database (agent.db) của Service, không gọi mạng,
/// không chạy lệnh nào khác. Host chạy ở quyền user (do trình duyệt khởi
/// động) nên chỉ đọc được domain_rules.json (ACL Users Read) và ghi được
/// web_usage.jsonl + extension_heartbeat.txt (chỉ timestamp, không secret).
/// Input xấu không bao giờ làm crash host: lỗi thì log ra
/// stderr (Chrome ghi vào log của nó, không hiện cho user) và trả ack false.
/// Không log domain hay dữ liệu thăm web — chỉ đếm.
/// </summary>
public static class Program
{
    public static int Main()
    {
        try
        {
            return NativeHostApp.Run();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[SafePC NativeHost] Lỗi nghiêm trọng: " + ex.Message);
            return 1;
        }
    }
}

internal static class NativeHostApp
{
    /// <summary>Độ dài message tối đa chấp nhận (1MB): rules + usage batch không bao giờ tới mức này.</summary>
    private const int MaxMessageBytes = 1024 * 1024;

    private static readonly string SharedDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "SafePC",
        "shared");

    private static readonly string RulesFilePath = Path.Combine(SharedDirectory, "domain_rules.json");
    private static readonly string UsageFilePath = Path.Combine(SharedDirectory, "web_usage.jsonl");

    /// <summary>File JSONL extension gửi yêu cầu xin mở domain vào (qua message requestUnblock), Service đọc trong chu kỳ poll lệnh.</summary>
    private static readonly string DomainRequestsFilePath = Path.Combine(SharedDirectory, "domain_requests.jsonl");

    /// <summary>File heartbeat của extension: chỉ chứa timestamp UTC ISO lúc extension liên hệ gần nhất. Service đọc để báo lên server.</summary>
    private static readonly string HeartbeatFilePath = Path.Combine(SharedDirectory, "extension_heartbeat.txt");

    public static int Run()
    {
        // Đọc/ghi stream thô (không qua Console.ReadLine/WriteLine): giao
        // thức native messaging là nhị phân (4 byte độ dài + JSON).
        using Stream input = Console.OpenStandardInput();
        using Stream output = Console.OpenStandardOutput();

        while (true)
        {
            byte[]? message = ReadMessage(input);
            if (message is null)
            {
                // EOF: trình duyệt đã đóng stdin, thoát bình thường.
                return 0;
            }

            string response = HandleMessage(message);
            WriteMessage(output, response);
            output.Flush();
        }
    }

    /// <summary>Đọc một message (4 byte độ dài LE + payload). Trả về null khi gặp EOF sạch giữa các message.</summary>
    private static byte[]? ReadMessage(Stream input)
    {
        Span<byte> lengthBuffer = stackalloc byte[4];
        int read = ReadExactly(input, lengthBuffer, allowEofAtStart: true);
        if (read == 0)
        {
            return null;
        }

        int length = BinaryPrimitives.ReadInt32LittleEndian(lengthBuffer);
        if (length <= 0 || length > MaxMessageBytes)
        {
            throw new InvalidDataException("Độ dài message native messaging không hợp lệ: " + length + ".");
        }

        var buffer = new byte[length];
        ReadExactly(input, buffer, allowEofAtStart: false);
        return buffer;
    }

    /// <summary>Đọc đủ buffer (stream có thể trả về từng phần). EOF giữa chừng thì ném lỗi, trừ khi cho phép EOF ở đầu.</summary>
    private static int ReadExactly(Stream input, Span<byte> buffer, bool allowEofAtStart)
    {
        int total = 0;
        while (total < buffer.Length)
        {
            int read = input.Read(buffer[total..]);
            if (read == 0)
            {
                if (total == 0 && allowEofAtStart)
                {
                    return 0;
                }

                throw new EndOfStreamException("Stdin đóng giữa message native messaging.");
            }

            total += read;
        }

        return total;
    }

    private static void WriteMessage(Stream output, string json)
    {
        byte[] payload = Encoding.UTF8.GetBytes(json);
        Span<byte> lengthBuffer = stackalloc byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(lengthBuffer, payload.Length);
        output.Write(lengthBuffer);
        output.Write(payload);
    }

    /// <summary>
    /// Xử lý một message. Không bao giờ ném exception: input xấu thì log ra
    /// stderr và trả ack lỗi, để một message hỏng không giết process.
    /// </summary>
    private static string HandleMessage(byte[] message)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(Encoding.UTF8.GetString(message));
        }
        catch (JsonException ex)
        {
            Console.Error.WriteLine("[SafePC NativeHost] Message không phải JSON, bỏ qua: " + ex.Message);
            return AckJson(ok: false);
        }

        using (document)
        {
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("type", out JsonElement typeElement)
                || typeElement.ValueKind != JsonValueKind.String)
            {
                Console.Error.WriteLine("[SafePC NativeHost] Message thiếu trường type, bỏ qua.");
                return AckJson(ok: false);
            }

            string? type = typeElement.GetString();
            if (type is "getRules" or "reportUsage" or "requestUnblock")
            {
                // Mọi lần extension liên hệ đều để lại dấu heartbeat — kể cả
                // khi message sau đó xử lý lỗi. Ghi lỗi không ảnh hưởng message.
                WriteExtensionHeartbeat();
            }

            return type switch
            {
                "getRules" => GetRulesJson(),
                "reportUsage" => ReportUsage(root),
                "requestUnblock" => RequestUnblock(root),
                _ => UnknownType(),
            };
        }
    }

    private static string UnknownType()
    {
        Console.Error.WriteLine("[SafePC NativeHost] Loại message không rõ, bỏ qua.");
        return AckJson(ok: false);
    }

    /// <summary>
    /// Ghi đè timestamp UTC hiện tại (ISO-8601, định dạng "o") vào file
    /// extension_heartbeat.txt. Best-effort: lỗi ghi chỉ log ra stderr,
    /// không bao giờ làm lỗi message đang xử lý. FileShare.ReadWrite để
    /// Service đọc được cùng lúc.
    /// </summary>
    private static void WriteExtensionHeartbeat()
    {
        try
        {
            Directory.CreateDirectory(SharedDirectory);
            using FileStream stream = new(HeartbeatFilePath, FileMode.Create, FileAccess.Write, FileShare.ReadWrite);
            using var writer = new StreamWriter(stream, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            writer.Write(DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture));
            writer.Flush();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine("[SafePC NativeHost] Không ghi được extension_heartbeat.txt: " + ex.Message);
        }
    }

    /// <summary>
    /// Trả về nội dung file domain_rules.json đã parse (hoặc null khi file
    /// chưa có/hỏng). File do Service xuất bản; host chỉ đọc, không sửa.
    /// </summary>
    private static string GetRulesJson()
    {
        JsonElement? rules = null;
        try
        {
            if (File.Exists(RulesFilePath))
            {
                using JsonDocument document = JsonDocument.Parse(File.ReadAllText(RulesFilePath, Encoding.UTF8));
                // Clone() để JsonElement sống độc lập sau khi JsonDocument bị hủy.
                rules = document.RootElement.Clone();
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            Console.Error.WriteLine("[SafePC NativeHost] Không đọc được domain_rules.json: " + ex.Message);
            rules = null;
        }

        return JsonSerializer.Serialize(new { type = "rules", rules });
    }

    /// <summary>
    /// Ghi thêm các lượt thăm vào web_usage.jsonl (mỗi visit một dòng JSON).
    /// Visit không hợp lệ thì bỏ qua và đếm; lỗi I/O thì trả ack false để
    /// extension giữ dữ liệu lại gửi sau. Không bao giờ ném exception.
    /// </summary>
    private static string ReportUsage(JsonElement root)
    {
        if (!root.TryGetProperty("visits", out JsonElement visits)
            || visits.ValueKind != JsonValueKind.Array)
        {
            Console.Error.WriteLine("[SafePC NativeHost] reportUsage thiếu mảng visits, bỏ qua.");
            return AckJson(ok: false);
        }

        var lines = new List<string>();
        int dropped = 0;
        foreach (JsonElement visit in visits.EnumerateArray())
        {
            string? line = TryFormatVisitLine(visit);
            if (line is null)
            {
                dropped++;
            }
            else
            {
                lines.Add(line);
            }
        }

        if (dropped > 0)
        {
            Console.Error.WriteLine("[SafePC NativeHost] Bỏ qua " + dropped + " visit không hợp lệ trong reportUsage.");
        }

        if (lines.Count == 0)
        {
            // Không có gì để ghi (kể cả mảng rỗng): coi là thành công để
            // extension xóa hàng đợi, tránh gửi lại mãi các visit hỏng.
            return AckJson(ok: true);
        }

        try
        {
            Directory.CreateDirectory(SharedDirectory);
            // FileShare.ReadWrite: Service có thể đọc file cùng lúc để đẩy
            // lên server mà không chặn lần ghi này.
            using FileStream stream = new(UsageFilePath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
            using var writer = new StreamWriter(stream, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            foreach (string line in lines)
            {
                writer.WriteLine(line);
            }

            writer.Flush();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine("[SafePC NativeHost] Không ghi được web_usage.jsonl: " + ex.Message);
            return AckJson(ok: false);
        }

        return AckJson(ok: true);
    }

    /// <summary>
    /// Kiểm tra và định dạng một visit thành dòng JSONL {domain, startedAt,
    /// durationSec, path?, blocked?}. Trả về null khi visit không hợp lệ. Domain chỉ chấp
    /// nhận 1-253 ký tự, không chứa '/', '?', '#', khoảng trắng hay ký tự
    /// điều khiển (không bao giờ là URL đầy đủ). Thời lượng kẹp 0..86400.
    /// blocked là cờ tùy chọn (extension 0.1.7): có mà không phải boolean
    /// thì visit không hợp lệ; chỉ ghi vào dòng khi true (dòng thường giữ
    /// nguyên hình dạng cũ để Service cũ đọc được — Service cũ vốn bỏ qua
    /// trường lạ, và dòng không có blocked thì Service mới coi là false).
    /// path là đường dẫn tùy chọn (extension 0.1.10): có mà không phải
    /// chuỗi thì visit không hợp lệ (cùng độ nghiêm với blocked); chuỗi
    /// thì cắt qua <see cref="WebVisitPath"/> (bỏ query/fragment, trần
    /// 500 ký tự) và chỉ ghi vào dòng khi cắt ra đường dẫn dùng được —
    /// dòng không có path thì Service mới coi là không có đường dẫn.
    /// Lượt bị chặn không bao giờ mang path (chỉ domain), nên path của
    /// visit bị chặn bị bỏ kể cả khi extension gửi kèm.
    /// </summary>
    private static string? TryFormatVisitLine(JsonElement visit)
    {
        if (visit.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (!visit.TryGetProperty("domain", out JsonElement domainElement)
            || domainElement.ValueKind != JsonValueKind.String
            || domainElement.GetString() is not string rawDomain)
        {
            return null;
        }

        string domain = rawDomain.Trim().ToLowerInvariant();
        if (domain.Length == 0 || domain.Length > 253 || ContainsForbiddenDomainChar(domain))
        {
            return null;
        }

        if (!visit.TryGetProperty("startedAt", out JsonElement startedElement)
            || startedElement.ValueKind != JsonValueKind.String
            || startedElement.GetString() is not string startedText
            || !DateTimeOffset.TryParse(startedText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset startedAt))
        {
            return null;
        }

        if (!visit.TryGetProperty("durationSec", out JsonElement durationElement)
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

        bool blocked = false;
        if (visit.TryGetProperty("blocked", out JsonElement blockedElement))
        {
            if (blockedElement.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            {
                return null;
            }

            blocked = blockedElement.GetBoolean();
        }

        string? path = null;
        if (visit.TryGetProperty("path", out JsonElement pathElement))
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
            return JsonSerializer.Serialize(new
            {
                domain,
                startedAt = startedAt.ToString("o", CultureInfo.InvariantCulture),
                durationSec,
                blocked = true,
            });
        }

        if (path is not null)
        {
            return JsonSerializer.Serialize(new
            {
                domain,
                startedAt = startedAt.ToString("o", CultureInfo.InvariantCulture),
                durationSec,
                path,
            });
        }

        return JsonSerializer.Serialize(new
        {
            domain,
            startedAt = startedAt.ToString("o", CultureInfo.InvariantCulture),
            durationSec,
        });
    }

    /// <summary>
    /// Ghi thêm một yêu cầu xin mở domain vào domain_requests.jsonl (một
    /// dòng JSON {"domain","requestedAt"}). Domain không hợp lệ thì trả ack
    /// false để extension hiện lỗi thay vì tưởng đã gửi; lỗi I/O cũng trả
    /// ack false để extension giữ nút ở trạng thái chưa gửi. Không bao giờ
    /// ném exception. Không log domain — chỉ đếm/không ghi gì thêm.
    /// </summary>
    private static string RequestUnblock(JsonElement root)
    {
        string? line = TryFormatDomainRequestLine(root);
        if (line is null)
        {
            Console.Error.WriteLine("[SafePC NativeHost] requestUnblock thiếu domain hợp lệ, bỏ qua.");
            return AckJson(ok: false);
        }

        try
        {
            Directory.CreateDirectory(SharedDirectory);
            // FileShare.ReadWrite: Service có thể đọc file cùng lúc để đẩy
            // yêu cầu lên server mà không chặn lần ghi này.
            using FileStream stream = new(DomainRequestsFilePath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
            using var writer = new StreamWriter(stream, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            writer.WriteLine(line);
            writer.Flush();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine("[SafePC NativeHost] Không ghi được domain_requests.jsonl: " + ex.Message);
            return AckJson(ok: false);
        }

        return AckJson(ok: true);
    }

    /// <summary>
    /// Kiểm tra và định dạng một message requestUnblock thành dòng JSONL
    /// {"domain","requestedAt"}. Trả về null khi domain thiếu/không hợp lệ:
    /// 1-253 ký tự sau khi trim + chữ thường, không chứa '/', '?', '#',
    /// khoảng trắng hay ký tự điều khiển (cùng luật với visit — không bao
    /// giờ là URL đầy đủ). requestedAt là giờ UTC lúc host nhận message.
    /// </summary>
    private static string? TryFormatDomainRequestLine(JsonElement root)
    {
        if (!root.TryGetProperty("domain", out JsonElement domainElement)
            || domainElement.ValueKind != JsonValueKind.String
            || domainElement.GetString() is not string rawDomain)
        {
            return null;
        }

        string domain = rawDomain.Trim().ToLowerInvariant();
        if (domain.Length == 0 || domain.Length > 253 || ContainsForbiddenDomainChar(domain))
        {
            return null;
        }

        return JsonSerializer.Serialize(new
        {
            domain,
            requestedAt = DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture),
        });
    }

    private static bool ContainsForbiddenDomainChar(string domain)
    {
        foreach (char c in domain)
        {
            if (char.IsWhiteSpace(c) || char.IsControl(c) || c == '/' || c == '?' || c == '#')
            {
                return true;
            }
        }

        return false;
    }

    private static string AckJson(bool ok) => JsonSerializer.Serialize(new { type = "ack", ok });
}
