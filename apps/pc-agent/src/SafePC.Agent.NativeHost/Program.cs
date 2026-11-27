using System.Buffers.Binary;
using System.Globalization;
using System.Runtime.InteropServices;
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
///   windows_sid/username (Sprint 5): SID + tên tài khoản Windows đang chạy
///   host — Service suy ra hồ sơ con qua ánh xạ (migration 24); hai trường
///   này CHỈ ghi khi lấy được (không bao giờ ghi null — Service coi SID
///   không phải chuỗi là dòng hỏng).
/// - {"type":"requestUnblock","domain"} (extension 0.1.9) -&gt; ghi thêm một
///   dòng {"domain","requestedAt","windows_sid"?,"username"?} vào
///   domain_requests.jsonl để Service đọc trong chu kỳ poll lệnh, trả
///   {"type":"ack","ok":true|false}. Chỉ tên miền, cùng luật kiểm tra
///   domain như visit (không '/', '?', '#', khoảng trắng, ký tự điều khiển).
/// - {"type":"reportSearch","terms":[{"engine","term","blocked"?}]}
///   (extension 0.1.11, migration 28) -&gt; ghi thêm các dòng JSONL vào
///   search_terms.jsonl, trả {"type":"ack","ok":true|false}. Đây là kênh
///   DUY NHẤT được mang cụm từ tìm kiếm (quyết định riêng tư của phụ
///   huynh 27/11/2026: chỉ cụm từ trên các công cụ tìm kiếm mới được
///   trích; engine là id ngắn như "google"/"coccoc"). Tối đa 50 mẫu mỗi
///   message, term cắt 200 ký tự ngay tại host (phòng thủ 2 lớp, RPC
///   cắt lại lần nữa). windows_sid/username đóng dấu như dòng web_usage.
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

    /// <summary>File JSONL extension gửi cụm từ tìm kiếm vào (qua message reportSearch, extension 0.1.11), Service đọc trong chu kỳ flush usage.</summary>
    private static readonly string SearchTermsFilePath = Path.Combine(SharedDirectory, "search_terms.jsonl");

    /// <summary>File heartbeat của extension: chỉ chứa timestamp UTC ISO lúc extension liên hệ gần nhất. Service đọc để báo lên server.</summary>
    private static readonly string HeartbeatFilePath = Path.Combine(SharedDirectory, "extension_heartbeat.txt");

    /// <summary>
    /// Định danh tài khoản Windows đang chạy host (Sprint 5): NativeHost chạy
    /// dưới quyền user mở trình duyệt nên tự biết mình là ai — username +
    /// SID gắn vào mỗi dòng web_usage.jsonl / domain_requests.jsonl để
    /// Service suy ra hồ sơ con qua ánh xạ (migration 24). SID lấy bằng
    /// P/Invoke (GetTokenInformation + ConvertSidToStringSid) vì NativeHost
    /// là net8.0 thuần, không dùng WindowsIdentity (chỉ có sẵn trên
    /// net8.0-windows); username lấy từ Environment.UserName (BCL). Lấy
    /// MỘT lần khi process khởi động (định danh không đổi trong đời
    /// process); lỗi (kể cả chạy trên Linux lúc test) thì null — Service
    /// coi dòng không có SID là dòng cũ (fallback con mặc định). Không bao
    /// giờ log SID/username ra stderr (chỉ ghi vào file JSONL nội bộ).
    /// </summary>
    private static readonly (string? UserName, string? Sid) CurrentUser = GetCurrentUser();

    private static (string? UserName, string? Sid) GetCurrentUser()
    {
        string? userName;
        try
        {
            userName = Environment.UserName;
            if (string.IsNullOrWhiteSpace(userName))
            {
                userName = null;
            }
        }
        catch (Exception)
        {
            userName = null;
        }

        return (userName, GetCurrentUserSid());
    }

    private static string? GetCurrentUserSid()
    {
        IntPtr token = IntPtr.Zero;
        IntPtr buffer = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(GetCurrentProcess(), TokenQuery, out token) || token == IntPtr.Zero)
            {
                return null;
            }

            // Lần 1 đo kích thước TOKEN_USER, lần 2 đọc thật.
            _ = GetTokenInformation(token, TokenUserClass, IntPtr.Zero, 0, out uint needed);
            if (needed == 0)
            {
                return null;
            }

            buffer = Marshal.AllocHGlobal((int)needed);
            if (!GetTokenInformation(token, TokenUserClass, buffer, needed, out _))
            {
                return null;
            }

            // TOKEN_USER = { SID_AND_ATTRIBUTES User }: trường đầu tiên là
            // con trỏ SID.
            IntPtr sid = Marshal.ReadIntPtr(buffer);
            if (sid == IntPtr.Zero || !ConvertSidToStringSid(sid, out IntPtr sidStringPtr) || sidStringPtr == IntPtr.Zero)
            {
                return null;
            }

            try
            {
                return Marshal.PtrToStringUni(sidStringPtr);
            }
            finally
            {
                _ = LocalFree(sidStringPtr);
            }
        }
        catch (DllNotFoundException)
        {
            return null;
        }
        catch (EntryPointNotFoundException)
        {
            return null;
        }
        catch (Exception)
        {
            return null;
        }
        finally
        {
            if (buffer != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(buffer);
            }

            if (token != IntPtr.Zero)
            {
                _ = CloseHandle(token);
            }
        }
    }

    private const uint TokenQuery = 0x0008;
    private const int TokenUserClass = 1;

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(IntPtr tokenHandle, int tokenInformationClass, IntPtr tokenInformation, uint tokenInformationLength, out uint returnLength);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr stringSid);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr handle);

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
            if (type is "getRules" or "reportUsage" or "requestUnblock" or "reportSearch")
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
                "reportSearch" => ReportSearch(root),
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
            return SerializeVisitLine(domain, startedAt, durationSec, blocked: true, path: null);
        }

        return SerializeVisitLine(domain, startedAt, durationSec, blocked: false, path);
    }

    /// <summary>
    /// Tuần tự hóa một dòng web_usage.jsonl. Sprint 5: gắn thêm SID +
    /// username của tài khoản đang chạy host (để Service suy ra hồ sơ con)
    /// — CHỈ khi lấy được: trường null sẽ bị Service coi là dòng hỏng
    /// (SID không phải chuỗi), nên thà bỏ trường còn hơn ghi null.
    /// Dictionary giữ đúng thứ tự chèn khi tuần tự hóa.
    /// </summary>
    private static string SerializeVisitLine(string domain, DateTimeOffset startedAt, int durationSec, bool blocked, string? path)
    {
        var line = new Dictionary<string, object>
        {
            ["domain"] = domain,
            ["startedAt"] = startedAt.ToString("o", CultureInfo.InvariantCulture),
            ["durationSec"] = durationSec,
        };
        if (blocked)
        {
            line["blocked"] = true;
        }
        else if (path is not null)
        {
            line["path"] = path;
        }

        if (CurrentUser.Sid is not null)
        {
            line["windows_sid"] = CurrentUser.Sid;
        }

        if (CurrentUser.UserName is not null)
        {
            line["username"] = CurrentUser.UserName;
        }

        return JsonSerializer.Serialize(line);
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
    /// {"domain","requestedAt","windows_sid"?,"username"?}. Trả về null khi
    /// domain thiếu/không hợp lệ: 1-253 ký tự sau khi trim + chữ thường,
    /// không chứa '/', '?', '#', khoảng trắng hay ký tự điều khiển (cùng
    /// luật với visit — không bao giờ là URL đầy đủ). requestedAt là giờ UTC
    /// lúc host nhận message. windows_sid/username (Sprint 5) chỉ ghi khi
    /// lấy được tài khoản đang chạy host.
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

        var line = new Dictionary<string, object>
        {
            ["domain"] = domain,
            ["requestedAt"] = DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture),
        };
        // Sprint 5: gắn SID + username như dòng web_usage (chỉ khi lấy
        // được — không bao giờ ghi null, Service coi SID không phải chuỗi
        // là dòng hỏng).
        if (CurrentUser.Sid is not null)
        {
            line["windows_sid"] = CurrentUser.Sid;
        }

        if (CurrentUser.UserName is not null)
        {
            line["username"] = CurrentUser.UserName;
        }

        return JsonSerializer.Serialize(line);
    }

    /// <summary>Trần số mẫu tìm kiếm trong một message reportSearch: extension gửi từng lượt tìm (đã chống trùng) nên 50 là quá đủ; phần vượt bị bỏ và đếm.</summary>
    private const int MaxSearchTermsPerMessage = 50;

    /// <summary>Trần độ dài cụm từ tìm kiếm ghi vào search_terms.jsonl — cùng trần với cột search_terms.term phía server (migration 28 cắt lại lần nữa).</summary>
    private const int MaxSearchTermLength = 200;

    /// <summary>
    /// Ghi thêm các cụm từ tìm kiếm vào search_terms.jsonl (mỗi mẫu một
    /// dòng JSON). Mẫu không hợp lệ thì bỏ qua và đếm; lỗi I/O thì trả ack
    /// false để extension giữ hàng đợi lại gửi sau. Không bao giờ ném
    /// exception. Không log cụm từ — chỉ đếm (như visit).
    /// </summary>
    private static string ReportSearch(JsonElement root)
    {
        if (!root.TryGetProperty("terms", out JsonElement terms)
            || terms.ValueKind != JsonValueKind.Array)
        {
            Console.Error.WriteLine("[SafePC NativeHost] reportSearch thiếu mảng terms, bỏ qua.");
            return AckJson(ok: false);
        }

        var lines = new List<string>();
        int dropped = 0;
        int seen = 0;
        foreach (JsonElement sample in terms.EnumerateArray())
        {
            seen++;
            if (seen > MaxSearchTermsPerMessage)
            {
                dropped++;
                continue;
            }

            string? line = TryFormatSearchTermLine(sample);
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
            Console.Error.WriteLine("[SafePC NativeHost] Bỏ qua " + dropped + " mẫu tìm kiếm không hợp lệ/vượt trần trong reportSearch.");
        }

        if (lines.Count == 0)
        {
            // Không có gì để ghi (kể cả mảng rỗng): coi là thành công để
            // extension xóa hàng đợi, tránh gửi lại mãi các mẫu hỏng —
            // cùng ngữ nghĩa reportUsage.
            return AckJson(ok: true);
        }

        try
        {
            Directory.CreateDirectory(SharedDirectory);
            // FileShare.ReadWrite: Service có thể đọc file cùng lúc để đẩy
            // lên server mà không chặn lần ghi này.
            using FileStream stream = new(SearchTermsFilePath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
            using var writer = new StreamWriter(stream, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            foreach (string line in lines)
            {
                writer.WriteLine(line);
            }

            writer.Flush();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine("[SafePC NativeHost] Không ghi được search_terms.jsonl: " + ex.Message);
            return AckJson(ok: false);
        }

        return AckJson(ok: true);
    }

    /// <summary>
    /// Kiểm tra và định dạng một mẫu tìm kiếm thành dòng JSONL
    /// {"engine","term","blocked"?,"windows_sid"?,"username"?}. Trả về
    /// null khi mẫu không hợp lệ:
    /// - engine: chuỗi, trim + chữ thường, 1-32 ký tự, không khoảng
    ///   trắng/ký tự điều khiển (id engine do extension đặt: google,
    ///   bing, duckduckgo, yahoo, coccoc); dài hơn thì cắt ở 32 (RPC
    ///   cũng cắt 32).
    /// - term: chuỗi, không rỗng sau khi trim; GIỮ NGUYÊN chữ gốc (đã
    ///   decode) như extension gửi, chỉ cắt ở 200 ký tự — không chẻ đôi
    ///   cặp surrogate ở cuối.
    /// - blocked: tùy chọn; có mà không phải boolean thì mẫu không hợp
    ///   lệ (cùng độ nghiêm với visit); chỉ ghi vào dòng khi true.
    /// windows_sid/username (Sprint 5) đóng dấu như dòng web_usage — chỉ
    /// ghi khi lấy được, không bao giờ ghi null.
    /// </summary>
    private static string? TryFormatSearchTermLine(JsonElement sample)
    {
        if (sample.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (!sample.TryGetProperty("engine", out JsonElement engineElement)
            || engineElement.ValueKind != JsonValueKind.String
            || engineElement.GetString() is not string rawEngine)
        {
            return null;
        }

        string engine = rawEngine.Trim().ToLowerInvariant();
        if (engine.Length == 0)
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

        if (engine.Length > 32)
        {
            engine = engine[..32];
        }

        if (!sample.TryGetProperty("term", out JsonElement termElement)
            || termElement.ValueKind != JsonValueKind.String
            || termElement.GetString() is not string term)
        {
            return null;
        }

        if (term.Trim().Length == 0)
        {
            return null;
        }

        if (term.Length > MaxSearchTermLength)
        {
            term = term[..MaxSearchTermLength];
            // Không chẻ đôi cặp surrogate ở cuối chuỗi đã cắt.
            char last = term[^1];
            if (char.IsHighSurrogate(last))
            {
                term = term[..^1];
            }
        }

        bool blocked = false;
        if (sample.TryGetProperty("blocked", out JsonElement blockedElement))
        {
            if (blockedElement.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            {
                return null;
            }

            blocked = blockedElement.GetBoolean();
        }

        var line = new Dictionary<string, object>
        {
            ["engine"] = engine,
            ["term"] = term,
        };
        if (blocked)
        {
            line["blocked"] = true;
        }

        if (CurrentUser.Sid is not null)
        {
            line["windows_sid"] = CurrentUser.Sid;
        }

        if (CurrentUser.UserName is not null)
        {
            line["username"] = CurrentUser.UserName;
        }

        return JsonSerializer.Serialize(line);
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
