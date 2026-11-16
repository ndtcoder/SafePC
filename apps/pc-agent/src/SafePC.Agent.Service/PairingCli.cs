using System.Runtime.InteropServices;
using Microsoft.Extensions.Configuration;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>
/// Lệnh ghép nối chạy một lần từ dòng lệnh (bắt buộc quyền Admin):
///   SafePC.Agent.Service.exe pair 123456 [--force]
///
/// Đổi mã 6 số (phụ huynh tạo trên Dashboard, hiệu lực 10 phút) lấy device
/// token qua RPC, rồi lưu (device_id, token) mã hóa DPAPI xuống
/// %ProgramData%\SafePC. Service đang chạy tự nhận thông tin ghép nối mới
/// trong vòng 1 phút (SupabaseApiClient đọc token ở mỗi lần gọi) nên không
/// cần khởi động lại Service sau khi ghép nối.
///
/// Mã thoát: 0 = thành công, 1 = sai cú pháp, 2 = máy đã ghép nối (dùng
/// --force để ghép nối lại), 3 = ghép nối thất bại (mã sai/hết hạn, mất
/// mạng, hoặc không đủ quyền ghi). Mọi kết quả đều ghi thêm vào file log
/// của Service để chẩn đoán khi chạy không có console.
/// </summary>
public static class PairingCli
{
    private const int AttachParentProcess = -1;

    public static async Task<int> RunAsync(string[] args)
    {
        // Exe này là WinExe nên mặc định không gắn console: gắn vào console
        // của tiến trình cha để in kết quả ra PowerShell/Terminal. Thất bại
        // (VD: chạy bằng double-click) thì vẫn tiếp tục, kết quả nằm ở log.
        try
        {
            AttachConsole(AttachParentProcess);
        }
        catch
        {
            // Không gắn được console thì bỏ qua, kết quả vẫn ghi vào log.
        }

        string? code = args.Length > 0 ? args[0] : null;
        bool force = args.Any(a => a.Equals("--force", StringComparison.OrdinalIgnoreCase));

        string programData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "SafePC");
        string logPath = Path.Combine(programData, "logs", "agent-service.log");
        var log = new LocalLogger(logPath);
        var tokens = new TokenStore(Path.Combine(programData, "device_token.dat"));

        if (code is null || code.Length != 6 || !code.All(char.IsDigit))
        {
            Print("Cách dùng: SafePC.Agent.Service.exe pair <mã 6 số> [--force]");
            Print("Mã 6 số do phụ huynh tạo trên Dashboard (mục Thiết bị > Ghép nối máy mới), hiệu lực 10 phút.");
            Print("Chạy lệnh này trong PowerShell/Terminal với quyền Administrator.");
            return 1;
        }

        DeviceCredentials? existing = tokens.TryLoadCredentials();
        if (existing is not null && !force)
        {
            Print("Máy này đã ghép nối rồi (device id: " + existing.DeviceId + ").");
            Print("Để ghép nối lại với mã mới, chạy thêm --force. Device cũ trên Dashboard vẫn còn, phụ huynh có thể xóa nếu không dùng nữa.");
            return 2;
        }

        IConfiguration config = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json", optional: true, reloadOnChange: false)
            .AddEnvironmentVariables()
            .Build();

        using var http = new HttpClient();
        var api = new SupabaseApiClient(http, config, tokens, log);

        string hostname = Environment.MachineName;
        string osVersion = "Windows " + Environment.OSVersion.Version;
        PairingResult? result;
        try
        {
            result = await api.RedeemPairingCodeAsync(code, hostname, osVersion, CancellationToken.None);
        }
        catch (Exception ex)
        {
            log.Error("Ghép nối lỗi.", ex);
            Print("Ghép nối thất bại. Chi tiết xem file log: " + logPath);
            return 3;
        }

        if (result is null)
        {
            Print("Ghép nối thất bại. Kiểm tra: mã còn hạn (10 phút), mã gõ đúng, máy có mạng.");
            Print("Chi tiết xem file log: " + logPath);
            return 3;
        }

        try
        {
            tokens.SaveCredentials(new DeviceCredentials(result.DeviceId, result.Token));
        }
        catch (UnauthorizedAccessException)
        {
            Print("Không ghi được token: cần chạy lệnh này với quyền Administrator.");
            return 3;
        }
        catch (IOException ex)
        {
            log.Error("Không lưu được token sau khi ghép nối.", ex);
            Print("Ghép nối thành công nhưng không lưu được token. Chạy lại lệnh với quyền Administrator và mã mới.");
            return 3;
        }

        log.Info("Ghép nối thành công (device id: " + result.DeviceId + ").");
        Print("Ghép nối thành công! Device id: " + result.DeviceId);
        Print("Service đang chạy sẽ tự nhận trong vòng 1 phút, không cần khởi động lại. Kiểm tra trên Dashboard: thiết bị sẽ hiện trạng thái online.");
        return 0;
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
