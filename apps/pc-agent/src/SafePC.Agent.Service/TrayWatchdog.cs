namespace SafePC.Agent.Service;

/// <summary>Một phiên user từng có Tray nối qua IPC: lần hello gần nhất + Tray có đang nối không.</summary>
public sealed record TraySessionSnapshot(int SessionId, string? UserName, bool IsAdmin, DateTimeOffset LastHelloAt, bool Connected);

/// <summary>Việc watchdog yêu cầu vòng lặp gọi thực hiện cho một phiên.</summary>
public sealed record TrayWatchdogAction(int SessionId, TrayWatchdogActionKind Kind, string Reason);

/// <summary>Loại việc watchdog yêu cầu.</summary>
public enum TrayWatchdogActionKind
{
    /// <summary>Khởi động lại Tray trong phiên này (qua <see cref="TrayLauncher"/>).</summary>
    Relaunch,

    /// <summary>
    /// Khởi động lại thất bại quá nhiều lần trong một giờ: báo phụ huynh bằng
    /// sự kiện can thiệp <c>tray_stopped</c> (AgentWorker đẩy, chống spam 1 lần/giờ).
    /// </summary>
    AlertTrayStopped,
}

/// <summary>
/// Chính sách watchdog cho Tray App (Sprint 4) — PHẦN THUẦN, không chạm
/// Win32/API mạng/DB nên kiểm chứng được bằng harness console trên Linux.
///
/// Luật (xem docs/02-ARCHITECTURE.md §5):
/// - Một phiên từng có Tray (đã hello ít nhất một lần) mà quá
///   <see cref="SilentThreshold"/> không thấy hello mới thì Tray coi như đã
///   tắt bất thường → yêu cầu khởi động lại trong phiên đó. Ngưỡng 5 phút
///   chừa biên độ cho chu kỳ nối lại IPC bình thường của Tray (~2,5 phút:
///   idle timeout 120 giây + nối lại 5 giây + hello).
/// - Backoff giữa các lần thử trong cùng một giờ: 0, 1, 2, 5, 10 phút.
///   Quá <see cref="MaxRelaunchAttemptsPerHour"/> lần trong một giờ thì
///   dừng thử, yêu cầu báo phụ huynh một lần, rồi thử lại ở giờ sau.
/// - Thoát Tray bằng mã PIN (phụ huynh cho phép, xem IpcPipeServer) thì
///   ân hạn 30 phút: vòng lặp truyền <c>pinExitGraceActive</c> = true thì
///   không yêu cầu khởi động lại phiên nào.
/// - Hello mới (Tray đã trở lại) thì đặt lại toàn bộ đếm của phiên đó.
/// - Phiên không còn user đăng nhập thì launcher báo lại, vòng lặp gọi
///   <see cref="ForgetSession"/> để watchdog quên phiên đó.
/// </summary>
public sealed class TrayWatchdog
{
    /// <summary>Quá 5 phút không hello thì coi như Tray đã tắt bất thường.</summary>
    public static readonly TimeSpan SilentThreshold = TimeSpan.FromMinutes(5);

    /// <summary>Số lần khởi động lại tối đa cho một phiên trong một giờ, sau đó báo phụ huynh.</summary>
    public const int MaxRelaunchAttemptsPerHour = 5;

    /// <summary>Thời gian ân hạn sau khi thoát Tray bằng mã PIN (phụ huynh bảo trì máy).</summary>
    public static readonly TimeSpan PinExitGrace = TimeSpan.FromMinutes(30);

    /// <summary>Khoảng chờ giữa các lần thử khởi động lại trong cùng một giờ (theo số lần đã thử).</summary>
    public static readonly TimeSpan[] RelaunchBackoff =
    {
        TimeSpan.Zero,
        TimeSpan.FromMinutes(1),
        TimeSpan.FromMinutes(2),
        TimeSpan.FromMinutes(5),
        TimeSpan.FromMinutes(10),
    };

    private sealed class SessionState
    {
        public DateTimeOffset WindowStartedAt;
        public int AttemptsInWindow;
        public DateTimeOffset LastAttemptAt;
        public bool AlertSentInWindow;
        public DateTimeOffset LastHelloAt;
    }

    private readonly Dictionary<int, SessionState> _sessions = new();

    /// <summary>
    /// Phiên đã quên vì không còn user đăng nhập (launcher báo): mốc hello
    /// lúc quên. Evaluate bỏ qua phiên này cho tới khi có hello MỚI HƠN
    /// mốc đó (user đăng nhập lại, Tray chạy lại) — nếu không, snapshot
    /// vẫn liệt kê phiên cũ và watchdog sẽ thử khởi động lại mỗi phút mãi.
    /// </summary>
    private readonly Dictionary<int, DateTimeOffset> _forgotten = new();

    /// <summary>
    /// Đánh giá snapshot các phiên, trả về việc cần làm cho mỗi phiên cần
    /// can thiệp. Gọi một lần mỗi phút từ vòng lặp watchdog của AgentWorker.
    /// Hàm này cập nhật trạng thái nội bộ (đếm lần thử, cửa sổ giờ, cờ đã
    /// báo) nên gọi đúng một lần cho mỗi tick.
    /// </summary>
    public IReadOnlyList<TrayWatchdogAction> Evaluate(IReadOnlyList<TraySessionSnapshot> sessions, DateTimeOffset now, bool pinExitGraceActive)
    {
        if (pinExitGraceActive)
        {
            return Array.Empty<TrayWatchdogAction>();
        }

        var actions = new List<TrayWatchdogAction>();
        foreach (TraySessionSnapshot session in sessions)
        {
            // Phiên đã quên (không còn user): chỉ quay lại khi có hello mới
            // hơn mốc lúc quên (user đăng nhập lại, Tray chạy lại).
            if (_forgotten.TryGetValue(session.SessionId, out DateTimeOffset forgottenHello))
            {
                if (session.LastHelloAt <= forgottenHello)
                {
                    continue;
                }

                _forgotten.Remove(session.SessionId);
            }

            if (session.Connected || now - session.LastHelloAt < SilentThreshold)
            {
                // Tray đang nối, hoặc mới hello gần đây (đang nối lại sau
                // rớt IPC): phiên khỏe, đặt lại đếm.
                _sessions.Remove(session.SessionId);
                continue;
            }

            if (!_sessions.TryGetValue(session.SessionId, out SessionState? state))
            {
                state = new SessionState
                {
                    WindowStartedAt = now,
                    AttemptsInWindow = 0,
                    LastAttemptAt = DateTimeOffset.MinValue,
                    AlertSentInWindow = false,
                    LastHelloAt = session.LastHelloAt,
                };
                _sessions[session.SessionId] = state;
            }

            state.LastHelloAt = session.LastHelloAt;

            // Hết một giờ thì cửa sổ mới: đếm lại từ đầu, được báo lại nếu vẫn hỏng.
            if (now - state.WindowStartedAt >= TimeSpan.FromHours(1))
            {
                state.WindowStartedAt = now;
                state.AttemptsInWindow = 0;
                state.AlertSentInWindow = false;
            }

            if (state.AttemptsInWindow >= MaxRelaunchAttemptsPerHour)
            {
                if (!state.AlertSentInWindow)
                {
                    state.AlertSentInWindow = true;
                    actions.Add(new TrayWatchdogAction(
                        session.SessionId,
                        TrayWatchdogActionKind.AlertTrayStopped,
                        "Tray phiên #" + session.SessionId + " đã tắt và khởi động lại " + MaxRelaunchAttemptsPerHour + " lần trong một giờ đều không trở lại."));
                }

                continue;
            }

            TimeSpan backoff = RelaunchBackoff[Math.Min(state.AttemptsInWindow, RelaunchBackoff.Length - 1)];
            if (state.AttemptsInWindow > 0 && now - state.LastAttemptAt < backoff)
            {
                continue;
            }

            state.AttemptsInWindow++;
            state.LastAttemptAt = now;
            actions.Add(new TrayWatchdogAction(
                session.SessionId,
                TrayWatchdogActionKind.Relaunch,
                "Tray phiên #" + session.SessionId + " không hello từ " + session.LastHelloAt.ToString("o", System.Globalization.CultureInfo.InvariantCulture) + " (lần thử " + state.AttemptsInWindow + "/" + MaxRelaunchAttemptsPerHour + " trong giờ này)."));
        }

        return actions;
    }

    /// <summary>Ghi nhận kết quả khởi động lại: thành công thì phiên sẽ hello lại và Evaluate tự đặt lại đếm; thất bại thì giữ đếm để backoff tăng.</summary>
    public void RecordLaunchResult(int sessionId, bool launched, bool noUserInSession, DateTimeOffset now)
    {
        if (noUserInSession)
        {
            // Phiên không còn user (logoff/shutdown): quên luôn tới khi có
            // hello mới. Mốc hello lấy từ trạng thái đã thấy ở lần Evaluate
            // gần nhất; chưa từng thấy thì dùng thời điểm hiện tại.
            DateTimeOffset lastHello = _sessions.TryGetValue(sessionId, out SessionState? state)
                ? state.LastHelloAt
                : now;
            _forgotten[sessionId] = lastHello;
            _sessions.Remove(sessionId);
            return;
        }

        // Khởi động thất bại (không phải do hết phiên): giữ nguyên đếm để
        // lần Evaluate sau chờ đủ backoff mới thử lại.
        _ = launched;
        _ = now;
    }

    /// <summary>Quên một phiên (VD: launcher báo không còn user đăng nhập).</summary>
    public void ForgetSession(int sessionId)
    {
        if (_sessions.TryGetValue(sessionId, out SessionState? state))
        {
            _forgotten[sessionId] = state.LastHelloAt;
        }

        _sessions.Remove(sessionId);
    }

    /// <summary>Số phiên đang được theo dõi (chỉ dùng cho chẩn đoán/test).</summary>
    public int TrackedSessionCount => _sessions.Count;
}
