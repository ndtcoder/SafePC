using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace SafePC.Agent.Shared;

/// <summary>
/// Kết quả một lần lấy mẫu app foreground: CHỈ tên process + hash đường dẫn exe.
/// Không chứa đường dẫn thô, không chứa tiêu đề cửa sổ, không chứa nội dung.
/// </summary>
public sealed record ForegroundApp(string ProcessName, string? ExePathHash, DateTimeOffset SampledAt);

/// <summary>
/// Theo dõi app đang ở foreground bằng Win32 API.
///
/// NGUYÊN TẮC RIÊNG TƯ (docs/01-PRD.md mục 5, docs/03-SECURITY.md mục 3):
/// - CHỈ lấy tên process và đường dẫn exe (để hash ngay, không lưu đường dẫn thô).
/// - KHÔNG gọi GetWindowText: không thu thập tiêu đề cửa sổ.
/// - KHÔNG keylogger, KHÔNG đọc nội dung, KHÔNG chụp màn hình.
///
/// LƯU Ý KIẾN TRÚC: class này phải được gọi từ Tray App (chạy trong user session).
/// Windows Service chạy ở session 0 nên GetForegroundWindow() không nhìn thấy
/// cửa sổ của người dùng. Tray App lấy mẫu rồi gửi về Service qua IPC.
/// </summary>
public static class ForegroundTracker
{
    private const uint ProcessQueryLimitedInformation = 0x1000;

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool QueryFullProcessImageName(IntPtr hProcess, int flags, StringBuilder exeName, ref int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    /// <summary>
    /// Lấy app foreground hiện tại. Trả về false khi không xác định được
    /// (không có cửa sổ, process đã thoát, thiếu quyền). Không bao giờ throw.
    /// </summary>
    public static bool TryGetForegroundApp(out ForegroundApp? app)
    {
        app = null;
        try
        {
            IntPtr hWnd = GetForegroundWindow();
            if (hWnd == IntPtr.Zero)
            {
                return false;
            }

            _ = GetWindowThreadProcessId(hWnd, out uint processId);
            if (processId == 0)
            {
                return false;
            }

            string? exePath = GetExePath(processId);
            string processName = GetProcessName(processId);

            // Hash ngay tại chỗ: đường dẫn thô không rời khỏi hàm này.
            app = new ForegroundApp(processName, Hashing.HashExePath(exePath), DateTimeOffset.UtcNow);
            return true;
        }
        catch
        {
            // Lấy mẫu thất bại thì bỏ qua mẫu này, không làm crash Tray App.
            return false;
        }
    }

    private static string GetProcessName(uint processId)
    {
        try
        {
            using Process process = Process.GetProcessById((int)processId);
            return process.ProcessName;
        }
        catch
        {
            return "unknown";
        }
    }

    private static string? GetExePath(uint processId)
    {
        // Cách 1: OpenProcess + QueryFullProcessImageName (ít quyền nhất có thể).
        IntPtr handle = OpenProcess(ProcessQueryLimitedInformation, false, processId);
        if (handle != IntPtr.Zero)
        {
            try
            {
                var buffer = new StringBuilder(1024);
                int size = buffer.Capacity;
                if (QueryFullProcessImageName(handle, 0, buffer, ref size))
                {
                    return buffer.ToString();
                }
            }
            catch
            {
                // Rơi xuống cách dự phòng bên dưới.
            }
            finally
            {
                _ = CloseHandle(handle);
            }
        }

        // Cách 2 (dự phòng): Process.MainModule — có thể throw Win32Exception
        // với process được bảo vệ hoặc process 64-bit khác quyền, nên bọc try/catch.
        try
        {
            using Process process = Process.GetProcessById((int)processId);
            return process.MainModule?.FileName;
        }
        catch
        {
            return null;
        }
    }
}
