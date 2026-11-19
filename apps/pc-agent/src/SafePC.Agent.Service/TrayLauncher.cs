using System.Runtime.InteropServices;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>
/// Khởi động lại Tray App trong user session (watchdog Sprint 4).
///
/// Service chạy ở session 0 không nhìn thấy màn hình user, nên muốn chạy
/// một process có giao diện (tray icon) trong phiên của user phải dùng đúng
/// công thức chuẩn của Windows: <c>WTSQueryUserToken</c> lấy token của user
/// đang đăng nhập trong phiên đó → <c>DuplicateTokenEx</c> đổi thành token
/// chính (primary) → <c>CreateProcessAsUser</c> với desktop
/// <c>winsta0\default</c> (bắt buộc: không đặt desktop thì process rơi vào
/// window station của Service, không hiện tray icon và không nhận chuột).
/// Xem Microsoft Learn "Starting an Interactive Client Process".
///
/// Mọi lỗi đều trả về false kèm lý do, KHÔNG ném — watchdog gọi hàm này
/// trong vòng lặp và tự backoff, nên một lần khởi động thất bại không bao
/// giờ được làm chết Service. Trường hợp thường gặp:
/// - Phiên không còn user đăng nhập (logoff/shutdown): token query thất bại
///   → <c>noUserInSession</c> = true, watchdog quên luôn phiên đó.
/// - Đường dẫn exe không tồn tại (cài đặt hỏng): false, lý do rõ ràng.
/// </summary>
public static class TrayLauncher
{
    private const uint MaxAllowed = 0x02000000;
    private const int SecurityIdentification = 1;
    private const int TokenPrimary = 1;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint NormalPriorityClass = 0x00000020;

    /// <summary>
    /// Thử khởi động Tray trong phiên <paramref name="sessionId"/>.
    /// Trả về true khi process đã được tạo (chưa chắc Tray đã hello lại —
    /// watchdog xác nhận bằng hello sau đó). <paramref name="noUserInSession"/>
    /// true khi phiên không còn user đăng nhập (watchdog quên phiên đó).
    /// </summary>
    public static bool TryLaunchInSession(int sessionId, string trayExePath, LocalLogger log, out string reason, out bool noUserInSession)
    {
        reason = string.Empty;
        noUserInSession = false;

        if (string.IsNullOrWhiteSpace(trayExePath) || !File.Exists(trayExePath))
        {
            reason = "Không tìm thấy file Tray: " + trayExePath;
            return false;
        }

        IntPtr userToken = IntPtr.Zero;
        IntPtr primaryToken = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        PROCESS_INFORMATION processInfo = default;
        bool processCreated = false;

        try
        {
            if (!WTSQueryUserToken(sessionId, out userToken))
            {
                int error = Marshal.GetLastWin32Error();
                // ERROR_NO_TOKEN (1008): phiên không có user đăng nhập
                // (logoff/shutdown) — không phải lỗi, chỉ là hết phiên.
                noUserInSession = error == 1008;
                reason = "Không lấy được token của phiên #" + sessionId + " (mã lỗi Win32 " + error + ").";
                return false;
            }

            if (!DuplicateTokenEx(userToken, MaxAllowed, IntPtr.Zero, SecurityIdentification, TokenPrimary, out primaryToken))
            {
                reason = "Không đổi được token phiên #" + sessionId + " thành token chính (mã lỗi Win32 " + Marshal.GetLastWin32Error() + ").";
                return false;
            }

            // Khối môi trường của user (PATH, USERPROFILE...): không có thì
            // Tray chạy với môi trường của SYSTEM — vẫn chạy được nhưng sai
            // đường dẫn user (log Tray ghi nhầm chỗ). Lỗi ở đây thì tiếp tục
            // với môi trường null (process thừa hưởng môi trường của Service).
            if (!CreateEnvironmentBlock(out environment, primaryToken, inherit: false))
            {
                log.Warning("Watchdog Tray: không tạo được khối môi trường cho phiên #" + sessionId + " (mã lỗi Win32 " + Marshal.GetLastWin32Error() + "), dùng môi trường mặc định.");
                environment = IntPtr.Zero;
            }

            var startupInfo = new STARTUPINFO
            {
                cb = Marshal.SizeOf<STARTUPINFO>(),
                lpDesktop = "winsta0\\default",
            };
            string commandLine = "\"" + trayExePath + "\"";
            processCreated = CreateProcessAsUser(
                primaryToken,
                applicationName: null,
                commandLine: commandLine,
                processAttributes: IntPtr.Zero,
                threadAttributes: IntPtr.Zero,
                inheritHandles: false,
                creationFlags: CreateUnicodeEnvironment | NormalPriorityClass,
                environment: environment,
                currentDirectory: null,
                ref startupInfo,
                out processInfo);
            if (!processCreated)
            {
                reason = "Không tạo được process Tray trong phiên #" + sessionId + " (mã lỗi Win32 " + Marshal.GetLastWin32Error() + ").";
                return false;
            }

            log.Info("Watchdog Tray: đã khởi động lại Tray trong phiên #" + sessionId + " (PID " + processInfo.dwProcessId + ").");
            return true;
        }
        catch (Exception ex)
        {
            // P/Invoke lỗi bất ngờ (VD: API không có trên bản Windows này):
            // ghi log, coi như khởi động thất bại, watchdog backoff rồi thử lại.
            reason = "Lỗi khi khởi động Tray trong phiên #" + sessionId + ": " + ex.Message;
            log.Warning("Watchdog Tray: " + reason);
            return false;
        }
        finally
        {
            if (processInfo.hProcess != IntPtr.Zero)
            {
                CloseHandle(processInfo.hProcess);
            }

            if (processInfo.hThread != IntPtr.Zero)
            {
                CloseHandle(processInfo.hThread);
            }

            if (environment != IntPtr.Zero)
            {
                DestroyEnvironmentBlock(environment);
            }

            if (primaryToken != IntPtr.Zero)
            {
                CloseHandle(primaryToken);
            }

            if (userToken != IntPtr.Zero)
            {
                CloseHandle(userToken);
            }
        }
    }

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSQueryUserToken(int sessionId, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool DuplicateTokenEx(IntPtr existingToken, uint desiredAccess, IntPtr tokenAttributes, int impersonationLevel, int tokenType, out IntPtr newToken);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, bool inherit);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool DestroyEnvironmentBlock(IntPtr environment);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUser(IntPtr token, string? applicationName, string commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string? currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }
}
