using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>
/// Lệnh kiểm tra mã PIN gỡ cài đặt (Sprint 4), gọi từ bộ gỡ cài đặt Inno
/// Setup trong <c>InitializeUninstall</c> (xem SafePCAgent.iss):
///   SafePC.Agent.Service.exe verify-pin &lt;mã 6 số&gt;
///   SafePC.Agent.Service.exe verify-pin --probe
///
/// Mã PIN gỡ cài đặt DÙNG CHUNG mã PIN thoát Tray của cùng máy (cột
/// <c>devices.exit_pin_hash</c>, phụ huynh đặt trên Dashboard): một mã để
/// phụ huynh nhớ, và cùng một lớp bảo vệ (PBKDF2-SHA256 100.000 vòng, xem
/// <see cref="PinHash"/>). Khác với thoát Tray, kiểm tra ở đây CHỈ xác
/// minh — KHÔNG tiêu thụ mã: gỡ bị hủy giữa chừng thì mã vẫn còn nguyên
/// để dùng sau (thoát Tray thì mã dùng một lần, xem IpcPipeServer).
///
/// Mã thoát:
///   0 = được gỡ (nhập đúng mã; hoặc máy chưa ghép nối; hoặc phụ huynh chưa
///       đặt mã PIN — mã PIN là lớp bảo vệ tự nguyện, chưa đặt thì gỡ bằng
///       quyền Admin như trước Sprint 4).
///   1 = sai cú pháp (thiếu mã / mã không phải 6 chữ số).
///   2 = chỉ --probe: máy ĐÃ đặt mã PIN (bộ gỡ phải hỏi mã trước khi gỡ).
///   3 = sai mã PIN (còn lượt thử; xem số lượt còn lại trong thông báo).
///   5 = không kiểm tra được (không cache + không tới được server — mất
///       mạng; fail-closed: chặn gỡ, thử lại khi có mạng).
///   6 = khóa nhập: sai quá 5 lần liên tiếp, khóa 30 phút (docs/03 §2).
///
/// Nguồn hash, theo thứ tự: (1) server qua heartbeat (luôn mới nhất —
/// phụ huynh vừa đặt/gỡ mã thì lần kiểm tra sau thấy ngay); (2) cache
/// local <c>exit_pin_hash.dat</c> (Service đồng bộ từ heartbeat, mã hóa
/// DPAPI + khóa ACL SYSTEM + Admins — xem AgentWorker) khi mất mạng.
/// Không cache + không tới được server thì fail-closed (mã 5), không đoán.
/// </summary>
public static class VerifyPinCli
{
    /// <summary>Được gỡ / không cần mã PIN (dùng chung cho verify và --probe).</summary>
    public const int ExitAllowed = 0;

    /// <summary>Sai cú pháp.</summary>
    public const int ExitUsage = 1;

    /// <summary>Chỉ --probe: máy đã đặt mã PIN, bộ gỡ phải hỏi mã.</summary>
    public const int ExitPinRequired = 2;

    /// <summary>Sai mã PIN.</summary>
    public const int ExitWrongPin = 3;

    /// <summary>Không kiểm tra được (mất mạng + không cache) — chặn gỡ.</summary>
    public const int ExitCannotVerify = 5;

    /// <summary>Khóa nhập sau 5 lần sai liên tiếp (30 phút).</summary>
    public const int ExitLockedOut = 6;

    /// <summary>Số lần sai liên tiếp tối đa trước khi khóa nhập (docs/03 §2).</summary>
    private const int MaxAttempts = 5;

    /// <summary>Thời gian khóa nhập sau khi sai quá số lần cho phép.</summary>
    private static readonly TimeSpan LockoutDuration = TimeSpan.FromMinutes(30);

    private const int AttachParentProcess = -1;

    /// <summary>Trạng thái lần sai của lệnh gỡ: chỉ gồm số đếm + mốc khóa — không chứa mã PIN hay hash.</summary>
    private sealed record AttemptsState(int Fails, DateTimeOffset? LockoutUntil);

    public static async Task<int> RunAsync(string[] args)
    {
        try
        {
            Console.OutputEncoding = System.Text.Encoding.UTF8;
            Console.InputEncoding = System.Text.Encoding.UTF8;
        }
        catch
        {
            // Không đổi được encoding thì bỏ qua.
        }

        try
        {
            AttachConsole(AttachParentProcess);
        }
        catch
        {
            // Không gắn được console thì bỏ qua.
        }

        string programData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "SafePC");
        string logPath = Path.Combine(programData, "logs", "agent-service.log");
        var log = new LocalLogger(logPath);
        var tokens = new TokenStore(Path.Combine(programData, "device_token.dat"));

        bool probe = args.Length > 0 && args[0].Equals("--probe", StringComparison.OrdinalIgnoreCase);
        string? pin = probe ? null : (args.Length > 0 ? args[0] : null);

        if (!probe && (pin is null || pin.Length != 6 || !pin.All(char.IsDigit)))
        {
            Print("Cách dùng: SafePC.Agent.Service.exe verify-pin <mã PIN 6 số>");
            Print("         SafePC.Agent.Service.exe verify-pin --probe");
            Print("Lệnh này chỉ dùng cho bộ gỡ cài đặt SafePC (kiểm tra mã PIN phụ huynh trước khi gỡ).");
            return ExitUsage;
        }

        // Máy chưa ghép nối thì không có mã PIN nào để kiểm tra: cho gỡ.
        DeviceCredentials? credentials = tokens.TryLoadCredentials();
        if (credentials is null)
        {
            Print("Máy chưa ghép nối với tài khoản phụ huynh nên không có mã PIN để kiểm tra.");
            log.Info("verify-pin: máy chưa ghép nối, cho gỡ cài đặt (không có mã PIN).");
            return ExitAllowed;
        }

        string attemptsPath = Path.Combine(programData, "uninstall_pin_attempts.json");
        AttemptsState attempts = ReadAttempts(attemptsPath);
        if (attempts.LockoutUntil.HasValue && attempts.LockoutUntil.Value > DateTimeOffset.UtcNow)
        {
            double minutesLeft = Math.Ceiling((attempts.LockoutUntil.Value - DateTimeOffset.UtcNow).TotalMinutes);
            Print("Nhập sai mã PIN quá " + MaxAttempts + " lần. Vui lòng thử lại sau " + minutesLeft.ToString(System.Globalization.CultureInfo.InvariantCulture) + " phút.");
            log.Warning("verify-pin: đang khóa nhập (sai " + attempts.Fails + " lần), chặn gỡ cài đặt.");
            return ExitLockedOut;
        }

        string? hash = await FetchPinHashAsync(tokens, log);
        if (hash is null)
        {
            // Không lấy được hash VÀ không phải "chưa đặt mã": hai trường hợp
            // này phân biệt bằng cờ riêng (xem FetchPinHashAsync) — tới đây
            // chỉ còn trường hợp không kiểm tra được: chặn gỡ.
            Print("Không kiểm tra được mã PIN (mất mạng và không có bản lưu trên máy). Kiểm tra mạng rồi thử lại.");
            log.Warning("verify-pin: không lấy được hash mã PIN (mất mạng + không cache), chặn gỡ cài đặt.");
            return ExitCannotVerify;
        }

        if (hash.Length == 0)
        {
            // Chuỗi rỗng là dấu hiệu "phụ huynh chưa đặt mã PIN" (xem
            // FetchPinHashAsync): mã PIN là lớp bảo vệ tự nguyện, chưa đặt
            // thì gỡ bằng quyền Admin như trước Sprint 4.
            Print("Chưa đặt mã PIN cho máy này nên gỡ cài đặt không yêu cầu mã PIN.");
            log.Info("verify-pin: chưa đặt mã PIN, cho gỡ cài đặt (quyền Admin như trước).");
            return ExitAllowed;
        }

        if (probe)
        {
            Print("Máy đã đặt mã PIN gỡ cài đặt.");
            return ExitPinRequired;
        }

        if (PinHash.Verify(pin!, hash))
        {
            WriteAttempts(attemptsPath, new AttemptsState(0, null));
            Print("Mã PIN đúng.");
            log.Info("verify-pin: mã PIN đúng, cho gỡ cài đặt.");
            return ExitAllowed;
        }

        int fails = attempts.Fails + 1;
        if (fails >= MaxAttempts)
        {
            DateTimeOffset until = DateTimeOffset.UtcNow.Add(LockoutDuration);
            WriteAttempts(attemptsPath, new AttemptsState(fails, until));
            Print("Sai mã PIN lần " + fails + "/" + MaxAttempts + ". Khóa nhập " + LockoutDuration.TotalMinutes.ToString(System.Globalization.CultureInfo.InvariantCulture) + " phút.");
            log.Warning("verify-pin: sai mã PIN lần " + fails + "/" + MaxAttempts + ", khóa nhập 30 phút, chặn gỡ cài đặt.");
            return ExitLockedOut;
        }

        WriteAttempts(attemptsPath, new AttemptsState(fails, null));
        Print("Sai mã PIN (lần " + fails + "/" + MaxAttempts + "). Còn " + (MaxAttempts - fails) + " lần thử trước khi bị khóa 30 phút.");
        log.Warning("verify-pin: sai mã PIN (lần " + fails + "/" + MaxAttempts + "), chặn gỡ cài đặt.");
        return ExitWrongPin;
    }

    /// <summary>
    /// Lấy hash mã PIN thoát: server trước (heartbeat trả về hash mới nhất),
    /// cache local khi mất mạng. Trả về null khi không lấy được; trả về
    /// chuỗi rỗng khi chắc chắn phụ huynh chưa đặt mã PIN (server hoặc cache
    /// nói rõ là null — phân biệt với "không lấy được").
    /// </summary>
    private static async Task<string?> FetchPinHashAsync(TokenStore tokens, LocalLogger log)
    {
        IConfiguration config = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json", optional: true, reloadOnChange: false)
            .AddEnvironmentVariables()
            .Build();

        using var http = new HttpClient();
        var api = new SupabaseApiClient(http, config, tokens, log);
        try
        {
            HeartbeatResult? result = await api.SendHeartbeatAsync("online", CancellationToken.None);
            if (result is not null)
            {
                // Server trả lời: hash null nghĩa là chưa đặt mã — chắc chắn.
                return result.ExitPinHash ?? string.Empty;
            }
        }
        catch (Exception ex)
        {
            log.Warning("verify-pin: không tới được server, dùng cache local: " + ex.Message);
        }

        // Mất mạng: dùng cache Service đồng bộ từ lần heartbeat trước.
        // Cache chỉ chứa hash khác null (hash null thì Service xóa file).
        string programData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "SafePC");
        string cachePath = Path.Combine(programData, AgentConstants.ExitPinHashCacheFileName);
        string? cached = new TokenStore(cachePath).TryLoadToken();
        if (!string.IsNullOrEmpty(cached))
        {
            log.Info("verify-pin: dùng hash mã PIN trong cache local (mất mạng).");
            return cached;
        }

        return null;
    }

    /// <summary>Đọc trạng thái lần sai (best-effort: file hỏng/thiếu thì coi như chưa sai lần nào).</summary>
    private static AttemptsState ReadAttempts(string path)
    {
        try
        {
            if (!File.Exists(path))
            {
                return new AttemptsState(0, null);
            }

            using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(path));
            JsonElement root = doc.RootElement;
            int fails = root.TryGetProperty("fails", out JsonElement failsElement) && failsElement.TryGetInt32(out int f) ? f : 0;
            DateTimeOffset? until = root.TryGetProperty("lockout_until", out JsonElement untilElement)
                && untilElement.ValueKind == JsonValueKind.String
                && DateTimeOffset.TryParse(untilElement.GetString(), System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind, out DateTimeOffset parsed)
                ? parsed : null;
            return new AttemptsState(Math.Max(0, fails), until);
        }
        catch (Exception)
        {
            return new AttemptsState(0, null);
        }
    }

    /// <summary>Ghi trạng thái lần sai (best-effort: ghi lỗi thì khóa nhập không bền — lần kiểm tra sau vẫn chặn bằng mã PIN đúng/sai, chỉ mất đếm khóa).</summary>
    private static void WriteAttempts(string path, AttemptsState state)
    {
        try
        {
            string? directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            string json = JsonSerializer.Serialize(new
            {
                fails = state.Fails,
                lockout_until = state.LockoutUntil?.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
            });
            File.WriteAllText(path, json);
        }
        catch (Exception)
        {
            // Ghi lỗi: bỏ qua, không chặn gỡ khi mã đúng.
        }
    }

    /// <summary>In ra console nếu có; không có console thì bỏ qua (log file đã ghi).</summary>
    private static void Print(string message)
    {
        try
        {
            Console.WriteLine(message);
        }
        catch (IOException)
        {
            // Không có console để in: bỏ qua.
        }
    }

    [DllImport("kernel32.dll")]
    private static extern bool AttachConsole(int dwProcessId);
}
