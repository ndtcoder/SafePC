using System.Runtime.InteropServices;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Tray;

/// <summary>
/// Hook WinEvent báo đổi cửa sổ foreground NGAY khi đổi
/// (EVENT_SYSTEM_FOREGROUND), để Tray gửi báo cáo foreground-changed về
/// Service trong vài trăm mili-giây thay vì chờ tới kỳ poll 15 giây — rút
/// ngắn độ trễ chặn app từ ~1 phút xuống ~vài giây (phàn nàn máy thật
/// 18/11/2026: Chrome/Notepad có lúc tới 1 phút mới bị đóng).
///
/// An toàn luồng: callback chạy trên thread do hệ thống quản lý
/// (WINEVENT_OUTOFCONTEXT), KHÔNG BAO GIỜ chạm object WPF/UI — chỉ gọi
/// delegate nơi đăng ký, nơi đó phải trả về ngay (fire-and-forget). Hook
/// lỗi thì <see cref="Start"/> trả về false và sampler 15 giây tiếp tục
/// làm dự phòng. Delegate callback được giữ trong field suốt đời object
/// để GC không thu hồi: thu hồi delegate của hook đang hoạt động sẽ crash
/// process khi hệ thống gọi vào địa chỉ đã giải phóng.
/// </summary>
public sealed class ForegroundChangeHook : IDisposable
{
    private const uint EventSystemForeground = 0x0003;
    private const uint WineventOutOfContext = 0x0000;
    private const uint WineventSkipOwnProcess = 0x0002;
    private const int ObjidWindow = 0;

    private delegate void WinEventProc(
        IntPtr hWinEventHook,
        uint eventType,
        IntPtr hwnd,
        int idObject,
        int idChild,
        uint dwEventThread,
        uint dwmsEventTime);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWinEventHook(
        uint eventMin,
        uint eventMax,
        IntPtr hmodWinEventProc,
        WinEventProc lpfnWinEventProc,
        uint idProcess,
        uint idThread,
        uint dwFlags);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWinEvent(IntPtr hWinEventHook);

    private readonly Action _onForegroundChanged;
    private readonly LocalLogger _log;

    // GC root: giữ delegate sống suốt đời hook (xem ghi chú ở đầu file).
    private readonly WinEventProc _callback;
    private IntPtr _hook;
    private bool _disposed;

    public ForegroundChangeHook(Action onForegroundChanged, LocalLogger log)
    {
        _onForegroundChanged = onForegroundChanged;
        _log = log;
        _callback = OnWinEvent;
    }

    /// <summary>
    /// Cài hook cho mọi process/thread. Trả về false khi hệ thống từ chối
    /// (chỉ ghi log một lần) — nơi gọi tiếp tục chỉ dùng poll 15 giây.
    /// </summary>
    public bool Start()
    {
        if (_hook != IntPtr.Zero)
        {
            return true;
        }

        // idProcess/idThread = 0: mọi process. hmod = NULL vì OUTOFCONTEXT
        // (callback chạy ngoài process gây sự kiện, không cần DLL inject).
        // SKIPOWNPROCESS: bỏ qua cửa sổ của chính Tray (menu/cảnh báo) để
        // khỏi gửi báo cáo nhiễu mỗi lần Tray tự hiện cửa sổ của nó.
        _hook = SetWinEventHook(
            EventSystemForeground,
            EventSystemForeground,
            IntPtr.Zero,
            _callback,
            0,
            0,
            WineventOutOfContext | WineventSkipOwnProcess);
        if (_hook == IntPtr.Zero)
        {
            _log.Warning("Không cài được WinEvent hook theo dõi foreground (mã lỗi "
                + Marshal.GetLastWin32Error() + "), chỉ dùng poll 15 giây.");
            return false;
        }

        _log.Info("WinEvent hook theo dõi foreground đã cài.");
        return true;
    }

    public void Stop()
    {
        if (_hook != IntPtr.Zero)
        {
            _ = UnhookWinEvent(_hook);
            _hook = IntPtr.Zero;
        }
    }

    /// <summary>
    /// Callback của hệ thống. Chỉ quan tâm sự kiện cấp cửa sổ có handle;
    /// không chạm UI, không await — chỉ kích hoạt nơi đăng ký.
    /// </summary>
    private void OnWinEvent(
        IntPtr hWinEventHook,
        uint eventType,
        IntPtr hwnd,
        int idObject,
        int idChild,
        uint dwEventThread,
        uint dwmsEventTime)
    {
        if (hwnd == IntPtr.Zero || idObject != ObjidWindow)
        {
            return;
        }

        try
        {
            _onForegroundChanged();
        }
        catch
        {
            // Callback hook không được ném exception ra hệ thống.
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        Stop();
    }
}
