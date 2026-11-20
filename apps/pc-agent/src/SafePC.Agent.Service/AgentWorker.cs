using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using Microsoft.Extensions.Hosting;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>
/// Worker chính của Windows Service (chạy quyền SYSTEM).
/// Năm vòng lặp nền, độc lập với nhau — một vòng lặp lỗi không làm chết các vòng khác:
/// 1. Heartbeat 60s lên server + đồng bộ rules về cache + kiểm tra lệch đồng hồ.
/// 2. Poll commands 15s từ server, thi hành lệnh, ack kết quả về server.
/// 3. Flush usage 5 phút: tổng hợp mẫu foreground theo app, gửi lên server;
///    đồng thời đọc file web_usage.jsonl do NativeHost ghi và đẩy lên server.
/// 4. Kiểm tra rules 15s từ cache local (offline-first): hết giờ thì báo Tray
///    hiện cảnh báo/màn hình khóa qua IPC (Tray đếm ngược 60s rồi khóa phiên).
/// 5. Watchdog Tray 60s (Sprint 4): phát hiện Tray tắt bất thường rồi khởi
///    động lại trong phiên của user; báo phụ huynh khi khởi động lại thất
///    bại nhiều lần.
///
/// Sau mỗi lần đồng bộ rules, khi ghi đè thay đổi (áp dụng/hết hạn/hủy), và
/// lúc khởi động (nếu cache không rỗng), Worker xuất bản lại file
/// domain_rules.json cho extension trình duyệt qua <see cref="DomainRulesPublisher"/>.
///
/// Lệnh lock_now của phụ huynh được lưu bền vững (device_state) nên sống sót
/// qua khởi động lại Service, cho tới khi có lệnh unlock. Khi mất mạng hoặc
/// chưa pairing, Service vẫn thi hành rules trong cache local và giữ usage
/// lại để gửi sau — không bao giờ "đoán" trạng thái từ server.
///
/// Sprint 2 đợt 3: vòng kiểm tra rules còn thi hành quy tắc theo app (đóng
/// app foreground vượt giới hạn/ngoài khung giờ/không thuộc giờ học tập
/// trung, dựa trên báo cáo foreground Tray gửi qua IPC), nghỉ bắt buộc
/// (khóa phiên khi dùng liên tục quá lâu, trạng thái bền vững trong
/// device_state), và báo sự kiện can thiệp (lệch đồng hồ, Service khởi động
/// lại) + heartbeat của extension lên server qua RPC migration 5. Ghi đè mở
/// máy tạm thời (unlock) chỉ hoãn khóa máy theo giờ giấc (giờ ngủ/khung
/// giờ/giới hạn ngày/khóa cưỡng chế); thi hành theo app, giờ học tập trung
/// và nghỉ bắt buộc vẫn chạy trong lúc mở khóa (quyết định ngày 18/11/2026).
///
/// Bản sửa lỗi sau Sprint 2 đợt 3: thêm mode app mới (app_block luôn chặn,
/// app_allowlist / app_allowlist_by_time chỉ cho phép danh sách app), ghi đè
/// app tạm thời (block_app/allow_app, xét trước mọi rule theo app), và báo
/// cáo trạng thái thi hành (snapshot enforcement qua RPC migration 6, gửi ở
/// chu kỳ heartbeat khi đổi, tối đa 1 lần/phút — chu kỳ heartbeat là
/// throttle tự nhiên, không chặn thêm) + log chẩn đoán quyết định rules
/// (khi đổi + mỗi 15 phút). Thứ tự thi hành theo app: ghi đè app
/// → focus → allowlist → luôn chặn → chặn theo giờ → giới hạn thời gian;
/// mọi đường đóng app đều qua KillAppAsync với denylist bảo vệ.
/// </summary>
public sealed class AgentWorker : BackgroundService
{
    private readonly LocalLogger _log;
    private readonly OutboxStore _outbox;
    private readonly SupabaseApiClient _api;
    private readonly RuleEngine _ruleEngine;
    private readonly IpcPipeServer _ipc;
    private readonly TokenStore _tokens;
    private readonly DomainRulesPublisher _publisher;
    private readonly ForegroundState _foregroundState;
    private readonly TrayQueryState _queryState;

    // Chống spam yêu cầu xin mở domain: domain đã gửi thành công thì không
    // gửi lại trong 5 phút (xem DomainRequestThrottle).
    private readonly DomainRequestThrottle _unblockDomainThrottle = new();

    // Denylist kill (tên đã chuẩn hóa bằng ExeNames, so khớp không phân biệt
    // hoa thường): tiến trình hệ thống + chính các exe của SafePC — không bao
    // giờ đóng, kể cả khi quy tắc của phụ huynh ghi nhầm tên.
    private static readonly HashSet<string> DenylistedExes = new(StringComparer.OrdinalIgnoreCase)
    {
        "explorer", "taskmgr", "SearchUI", "StartMenuExperienceHost", "TextInputHost",
        "dwm", "csrss", "winlogon", "services", "lsass",
        "SafePC.Agent.Tray", "SafePC.Agent.Service", "SafePC.Agent.NativeHost",
    };

    // Chống spam cảnh báo: mỗi ngưỡng 15/5/1 phút chỉ báo một lần.
    private int _lastWarnBucket;
    private bool _lockSent;

    // Lịch sử thi hành (migration 10): nghỉ bắt buộc có đang hiệu lực ở
    // lần kiểm tra trước không — chuyển false -> true là một lần nghỉ bắt
    // đầu, ghi sự kiện break_started. Chỉ trong bộ nhớ: Service khởi động
    // lại giữa giờ nghỉ thì lần kiểm tra đầu tiên thấy breakActive = true
    // và ghi thêm một sự kiện cho cùng giờ nghỉ (nhiễu hiếm, chấp nhận).
    private bool _lastBreakActive;

    // Chống spam sự kiện app_blocked: cùng một exe + loại thi hành chỉ ghi
    // 1 sự kiện trong 60 giây — lượt thi hành ngay và vòng tick có thể
    // cùng thấy một tiến trình còn sống trong vài giây đầu sau khi đóng
    // (kill chưa thu hồi kịp), và con mở lại liên tục trong 1 phút vẫn
    // chỉ tính là một đợt chặn. Khóa "loại|exe", giờ UTC. Không dọn:
    // số cặp exe×loại bị chặn bởi số rule, nhỏ và hữu hạn.
    private readonly Dictionary<string, DateTimeOffset> _lastAppBlockEventAt = new(StringComparer.OrdinalIgnoreCase);

    // Khóa có độ trễ (lệnh lock_now kèm delay_minutes 1–5): thời điểm lệnh
    // khóa thật sự có hiệu lực. Trong lúc chờ, vòng kiểm tra chỉ gửi cảnh
    // báo (cửa sổ nhỏ) thay vì màn hình khóa full màn — con có thời gian
    // lưu bài. Chỉ tồn tại trong bộ nhớ: Service khởi động lại giữa chừng
    // thì trạng thái khóa bền vững (ForcedLock) khiến tick sau khóa ngay
    // (fail-closed, mất độ trễ nhưng không mất lệnh khóa).
    private DateTimeOffset? _pendingLockAt;

    // Số phút còn lại của lần cảnh báo chờ-khóa gần nhất đã gửi — chỉ gửi
    // lại khi số phút đổi (tránh spam mỗi tick 15s; Tray tự đếm ngược).
    private int _lastPendingWarnMinutes;

    // Chữ ký ghi đè ở lần kiểm tra rules trước (action + hết hạn + domains):
    // đổi là ghi đè đã áp dụng/hết hạn/bị thay, cần xuất bản lại file domain.
    private string? _lastOverrideSignature;

    // Chống spam log khi không có báo cáo foreground tươi (tối đa 1 lần/15
    // phút) và khi extension vắng mặt (tối đa 1 lần/giờ) — chỉ trong bộ nhớ.
    private DateTimeOffset _lastStaleForegroundLogAt;
    private DateTimeOffset _lastExtensionStaleLogAt;

    // Sprint 4 — watchdog Tray: chính sách khởi động lại (thuần, xem
    // TrayWatchdog) + lần cuối thấy một trình duyệt chạy foreground (để
    // kết luận extension "mất" chỉ khi trình duyệt đang chạy mà extension
    // im lặng — trình duyệt đóng thì extension im lặng là bình thường).
    // OnForegroundReportReceived chạy trên thread pipe, vòng heartbeat đọc
    // — mọi truy cập qua khóa này.
    private readonly TrayWatchdog _trayWatchdog = new();
    private readonly object _browserGate = new();
    private DateTimeOffset _lastBrowserForegroundAt;
    private string? _lastBrowserExe;

    /// <summary>
    /// Tên exe trình duyệt đã biết (khớp danh sách KNOWN_BROWSERS trên
    /// Dashboard + msedge.exe — Edge là trình duyệt chính của SafePC, không
    /// nằm trong danh sách "chặn" của mẫu Chỉ cho phép Edge nhưng vẫn dùng
    /// extension). So khớp sau khi chuẩn hóa bằng ExeNames (bỏ .exe, không
    /// phân biệt hoa thường).
    /// </summary>
    private static readonly HashSet<string> KnownBrowserExeNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "msedge", "chrome", "firefox", "brave", "opera", "vivaldi", "arc", "chromium", "whale", "coccoc", "comet",
    };

    // Chống spam log khi từ chối đóng một exe trong denylist (VD: Explorer
    // đang ở foreground trong giờ tập trung): tối đa 1 lần/15 phút mỗi exe.
    private readonly Dictionary<string, DateTimeOffset> _lastDenylistRefusalLogAt = new(StringComparer.OrdinalIgnoreCase);

    // Cảnh báo theo app đã gửi: khóa "loại|exe|ngày-địa-phương", mỗi exe mỗi
    // ngày chỉ cảnh báo một lần cho mỗi loại (limit/window). Key ngày cũ
    // được dọn ở mỗi lần thi hành.
    private readonly HashSet<string> _appWarnedKeys = new(StringComparer.OrdinalIgnoreCase);

    // Cache phân tích rule theo app/focus: chỉ phân tích lại khi chữ ký
    // rules đổi, để không phân tích JSON và ghi log cảnh báo lặp mỗi 15s.
    // Vòng tick và lượt thi hành ngay (khi nhận báo cáo foreground) cùng
    // đọc/ghi cache này nên mọi truy cập qua khóa này — nếu không, hai
    // luồng phân tích xen kẽ có thể để lại chữ ký của đợt này đi kèm kết
    // quả của đợt kia (rule cũ áp cho chữ ký mới).
    private readonly object _appRulesCacheLock = new();
    private string? _appRulesSignature;
    private ParsedAppRules? _parsedAppRules;

    // Cổng chống chồng chéo cho thi hành theo app (18/11/2026): lượt thi
    // hành ngay (khi nhận báo cáo foreground) và vòng tick 15 giây cùng
    // chạy qua cổng này, vào bằng TryEnter KHÔNG CHỜ — lượt tới sau thấy
    // cổng bận thì bỏ qua (gộp burst), vì lượt đang chạy đã đọc báo cáo
    // mới nhất; báo cáo tới giữa chừng được vòng tick sau bắt lại trong
    // ≤15 giây (cửa tươi 90 giây). Không bao giờ chờ: chờ sẽ treo vòng
    // tick hoặc chồng chất lượt thi hành ngay. Cổng này không lồng với
    // khóa ghi IPC (SendToTrayAsync lấy khóa ghi bên trong rồi trả) nên
    // không deadlock với vòng đọc pipe.
    private readonly SemaphoreSlim _appEnforcementGate = new(1, 1);

    // Kết quả thi hành app/focus gần nhất: vòng tick dùng khi cổng bận
    // (lượt thi hành ngay đang chạy) để snapshot enforcement không dao
    // động về rỗng trong lúc chờ. Mọi truy cập qua khóa này.
    private readonly object _lastAppEnforcementLock = new();
    private (bool FocusActive, List<string> AppBlocks) _lastAppEnforcement = (false, new List<string>());

    // Chống spam breadcrumb "thi hành ngay": tối đa 1 dòng/15 phút.
    private DateTimeOffset _lastImmediateEnforcementLogAt;

    // Token dừng của Service, chụp ở đầu ExecuteAsync để lượt thi hành ngay
    // (kích hoạt từ event, ngoài vòng lặp) dùng chung. Trước khi ExecuteAsync
    // chạy thì là None — lượt thi hành lúc đó vẫn chạy xong bình thường.
    private CancellationToken _stoppingToken;

    // Báo cáo trạng thái thi hành (migration 6): vòng kiểm tra rules dựng
    // snapshot mỗi 15s và để ở đây; vòng heartbeat (60 giây) gửi lên server
    // khi nội dung (trừ thời điểm) ĐỔI — chu kỳ heartbeat là throttle tự
    // nhiên, không chặn thêm (đợt sửa 17/11/2026). Hai vòng chạy song song
    // nên mọi truy cập qua khóa này.
    private readonly object _enforcementGate = new();
    private string? _pendingEnforcementJson;
    private string? _pendingEnforcementSignature;
    private string? _lastSentEnforcementSignature;

    // Chẩn đoán quyết định rules: ghi log khi quyết định đổi, hoặc tối đa
    // 1 lần/15 phút khi không đổi — để log Service trả lời được rules có
    // đồng bộ và đánh giá đúng không.
    private string? _lastDecisionLogSignature;
    private DateTimeOffset _lastDecisionLogAt;

    // Sprint 5 (máy dùng chung, một phiên active): phiên console + hồ sơ con
    // đang ngồi máy ở lần kiểm tra trước, để phát hiện đổi phiên/đổi con và
    // đặt lại trạng thái tick trong bộ nhớ (xem RuleCheckLoopAsync). Chỉ
    // trong bộ nhớ: Service khởi động lại thì lần kiểm tra đầu tiên coi như
    // "đổi phiên" và đặt lại — an toàn vì trạng thái bền đã tách theo con.
    private int? _lastConsoleSessionId;
    private Guid? _lastActiveChildId;

    // Sprint 5, review lần hai MINOR-1: giá trị GetLastError thô gần nhất
    // đã log khi WTSGetActiveConsoleSessionId trả 0xFFFFFFFF (int.MinValue
    // = chưa log lần nào) — ghi log chẩn đoán một lần khi giá trị đổi, để
    // xác minh trên máy thật tiền đề "GetLastError == 0 ⟺ không có phiên".
    private int _lastConsoleQueryWin32Error = int.MinValue;

    // Sprint 5: phiên Standard chưa gắn hồ sơ nào đã được cảnh báo trong lần
    // chạy này (khóa theo session id) — quyết định đã chốt 20/11/2026 là
    // không quản lý + ghi log cảnh báo 1 lần/phiên, không lấp log mỗi 15s.
    private readonly HashSet<int> _unmappedWarnedSessions = new();

    // Sprint 5: phiên admin đã được ghi chú miễn trừ 1 lần/phiên (tách khỏi
    // _unmappedWarnedSessions vì session id có thể tái dùng sau khi phiên
    // cũ đăng xuất — phiên con mới không được "ăn theo" ghi chú của admin).
    private readonly HashSet<int> _adminNotedSessions = new();

    // Sprint 5: con mà lần bỏ qua kiểm tra gần nhất (do chưa đồng bộ được
    // rules) đã được cảnh báo — để mất mạng kéo dài không lấp log mỗi 15s.
    private Guid? _rulesSkipWarnedChildId;

    // Sprint 5: hồ sơ con mà cache rules hiện tại thuộc về (null = chưa biết,
    // VD: vừa khởi động lại Service — suy ra từ cache ở lần kiểm tra đầu
    // tiên). Cache chỉ chứa luật của MỘT con; đổi con mà cache chưa kịp đổi
    // thì vòng tick không thi hành luật con cũ cho con mới.
    private Guid? _rulesChildId;

    // Sprint 5: lệnh đang hoãn (con chưa active) đã được log một lần (khóa
    // theo id lệnh) — poll 15s không lấp log với cùng một lệnh. Lệnh rời
    // khỏi hàng pending thì quên để lần hoãn sau (nếu có) lại được log.
    private readonly HashSet<Guid> _deferredCommandLog = new();

    /// <summary>
    /// Phiên console + hồ sơ con đang ngồi máy ở một thời điểm (Sprint 5):
    /// kết quả phân giải của <see cref="ActiveChildResolver"/> từ phiên
    /// console (WTS), các phiên đã hello (SID) và ánh xạ SID→con. Mọi thi
    /// hành trong một chu kỳ (tick rules, poll lệnh) dùng cùng một context
    /// để không lệch nhau giữa chừng.
    /// </summary>
    private sealed record ActiveContext(
        int? ConsoleSessionId,
        ActiveChildStatus Status,
        Guid? ChildId,
        Guid? DefaultChildId,
        IReadOnlyList<ChildAccountLink> Links,
        string? ConsoleSessionSid = null)
    {
        /// <summary>
        /// Phạm vi mẫu usage của con đang active (SID của con + mẫu không rõ
        /// phiên chỉ cho con mặc định). Kèm SID của phiên console đang được
        /// phân giải (sửa MAJOR-2): phiên đó đã được xác định là con này nên
        /// mẫu Tray mới đóng dấu SID của phiên đó vẫn đếm đúng — máy đơn-con
        /// chưa có ánh xạ không còn đếm 0.
        /// </summary>
        public UsageScope Scope => ActiveChildResolver.ScopeForChild(ChildId, DefaultChildId, Links, ConsoleSessionSid);
    }

    /// <summary>
    /// Phiên console đang hoạt động của Windows (Sprint 5, phương án 2 "một
    /// phiên active"): chỉ phiên này mới bị thi hành luật. Dùng
    /// <c>WTSGetActiveConsoleSessionId</c> của Win32 (Service chạy quyền
    /// SYSTEM nên gọi được) — đơn giản và tin cậy nhất trong các phương án:
    /// không cần hook sự kiện đăng nhập, không cần theo dõi tiến trình theo
    /// session, chỉ poll cùng nhịp vòng tick 15s đã có.
    ///
    /// Trả về (SessionId, ApiFailed, Win32Error):
    /// - Có phiên console → (số phiên, false, 0).
    /// - Không có phiên console nào (máy ở màn hình đăng nhập) → (null,
    ///   false, lỗi thô): API trả 0xFFFFFFFF và GetLastError() == 0. Nơi gọi
    ///   trả về NoConsoleSession và vòng tick BỎ QUA lần kiểm tra — không
    ///   dọn ghi đè hết hạn, không ghi sự kiện thi hành trong lúc đó (thay
    ///   đổi so với trước Sprint 5, ghi rõ ở docs/02-ARCHITECTURE.md §4.13).
    /// - API không gọi được (trả 0xFFFFFFFF kèm lỗi Win32, hoặc thiếu DLL /
    ///   entry point — môi trường lạ) → (null, true, lỗi thô): nơi gọi rơi
    ///   về NoSessionInfo để GIỮ hành vi cũ (thi hành luật con mặc định),
    ///   thay vì bỏ qua kiểm tra.
    /// CHƯA XÁC MINH (review lần hai, MINOR-1): tiền đề "GetLastError == 0
    /// ⟺ không có phiên console" KHÔNG được trang Microsoft Learn của hàm
    /// này xác nhận, và giá trị có thể là lỗi cũ còn sót trên thread — nên
    /// nơi gọi KHÔNG dựa hoàn toàn vào nó: khi chưa phiên nào hello mà WTS
    /// trả 0xFFFFFFFF thì coi là không có phiên bất kể GetLastError (xem
    /// GetActiveContextAsync), và giá trị lỗi thô được log một lần khi đổi
    /// để xác minh trên máy thật.
    /// GIỚI HẠN: phiên RDP không phải phiên console nên không được tính —
    /// con dùng máy qua RDP thì không bị thi hành luật trong đợt này
    /// (xem docs/02-ARCHITECTURE.md §4.13).
    /// </summary>
    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern uint WTSGetActiveConsoleSessionId();

    private const uint NoConsoleSessionId = 0xFFFFFFFF;

    private static (int? SessionId, bool ApiFailed, int Win32Error) GetConsoleSessionId()
    {
        try
        {
            uint sessionId = WTSGetActiveConsoleSessionId();
            if (sessionId != NoConsoleSessionId)
            {
                return ((int)sessionId, false, 0);
            }

            // 0xFFFFFFFF vừa là "không có phiên console" vừa là "API lỗi":
            // phân biệt bằng GetLastError — 0 nghĩa là chỉ không có phiên
            // nào, khác 0 là API thật sự lỗi. Hai trường hợp xử lý khác nhau
            // ở nơi gọi (bỏ qua tick / giữ hành vi cũ). Win32Error trả kèm
            // để nơi gọi log chẩn đoán (review lần hai, MINOR-1): đọc ngay
            // sau P/Invoke, không có lệnh nào xen giữa.
            int win32Error = Marshal.GetLastWin32Error();
            return (null, win32Error != 0, win32Error);
        }
        catch (DllNotFoundException)
        {
            return (null, true, -1);
        }
        catch (EntryPointNotFoundException)
        {
            return (null, true, -1);
        }
    }

    public AgentWorker(
        LocalLogger log,
        OutboxStore outbox,
        SupabaseApiClient api,
        RuleEngine ruleEngine,
        IpcPipeServer ipc,
        TokenStore tokens,
        DomainRulesPublisher publisher,
        ForegroundState foregroundState,
        TrayQueryState queryState)
    {
        _log = log;
        _outbox = outbox;
        _api = api;
        _ruleEngine = ruleEngine;
        _ipc = ipc;
        _tokens = tokens;
        _publisher = publisher;
        _foregroundState = foregroundState;
        _queryState = queryState;

        // Thi hành app NGAY khi nhận báo cáo foreground mới (18/11/2026):
        // handler chỉ kích hoạt fire-and-forget, không bao giờ chặn thread
        // xử lý message của pipe (xem OnForegroundReportReceived).
        _foregroundState.ReportReceived += OnForegroundReportReceived;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _stoppingToken = stoppingToken;
        _log.Info("SafePC Agent Service khởi động (phiên bản " + AgentConstants.AgentVersion + ", session " + LocalLogger.CurrentSessionId + ").");

        try
        {
            await _outbox.InitializeAsync(stoppingToken);
        }
        catch (Exception ex)
        {
            _log.Error("Không khởi tạo được SQLite outbox.", ex);
        }

        // Lịch sử thi hành (migration 10): khởi tạo _lastBreakActive từ
        // trạng thái bền để Service khởi động lại giữa giờ nghỉ không ghi
        // trùng sự kiện break_started. BreakEndsAt còn hiệu lực nghĩa là
        // giờ nghỉ này đã bắt đầu trước khi process này chạy (sự kiện đã
        // ghi rồi). Lỗi đọc thì fail-open (giữ false): cùng lắm ghi trùng
        // một sự kiện, không chặn khởi động.
        // Lưu ý: _lockSent KHÔNG khởi tạo tương tự — khóa do quy tắc
        // không có trạng thái bền "đã gửi khóa" (ForcedLock bền chỉ dùng
        // cho khóa do phụ huynh, mà lock_started không ghi cho khóa đó),
        // và đặt _lockSent = true bừa sẽ chặn lần gửi khóa hợp lệ đầu
        // tiên sau khởi động. Khởi động lại giữa lúc đang khóa do quy
        // tắc có thể ghi trùng một lock_started (hiếm, +1 hàng đếm tuần).
        try
        {
            string? breakEndsAtText = await _outbox.GetStateAsync(StateKeys.BreakEndsAt, stoppingToken);
            if (breakEndsAtText is not null
                && DateTimeOffset.TryParse(breakEndsAtText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset breakEndsAt)
                && DateTimeOffset.Now < breakEndsAt)
            {
                _lastBreakActive = true;
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.Error("Đọc trạng thái nghỉ bắt buộc lúc khởi động lỗi.", ex);
        }

        // Báo Service vừa khởi động lại (tamper event agent_restart, chống
        // spam tối đa 1 lần/giờ qua device_state): phụ huynh thấy được khi
        // Service bị dừng/khởi động lại bất thường. Hàm tự bắt lỗi nên
        // không chặn khởi động khi DB/mạng có vấn đề.
        await PushThrottledTamperEventAsync(
            StateKeys.TamperRestartLastSent,
            "agent_restart",
            JsonSerializer.SerializeToElement(new { agent_version = AgentConstants.AgentVersion }),
            stoppingToken);

        if (!_tokens.HasToken())
        {
            _log.Warning("Chưa có device token (chưa pairing). Ghép nối bằng lệnh: SafePC.Agent.Service.exe pair <mã 6 số>. Heartbeat/poll sẽ chờ.");
        }

        // Xuất bản quy tắc domain lúc khởi động nếu cache không rỗng, để
        // extension có file mới nhất ngay cả khi chưa đồng bộ được lần nào.
        // PublishAsync tự bắt lỗi nên không cần try/catch ở đây.
        try
        {
            IReadOnlyList<Rule> cachedRules = await _outbox.GetCachedRulesAsync(stoppingToken);
            if (cachedRules.Count > 0)
            {
                await _publisher.PublishAsync(stoppingToken);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.Error("Đọc cache rules lúc khởi động lỗi.", ex);
        }

        Task heartbeat = HeartbeatLoopAsync(stoppingToken);
        Task polling = CommandPollLoopAsync(stoppingToken);
        Task flushing = UsageFlushLoopAsync(stoppingToken);
        Task ruleCheck = RuleCheckLoopAsync(stoppingToken);
        // Sprint 4 — watchdog Tray: phát hiện Tray tắt bất thường rồi khởi
        // động lại trong phiên của user (xem TrayWatchdogLoopAsync). Vòng
        // này độc lập như các vòng khác: lỗi thì chỉ log, không chết Service.
        Task trayWatchdog = TrayWatchdogLoopAsync(stoppingToken);

        await Task.WhenAll(heartbeat, polling, flushing, ruleCheck, trayWatchdog);
        _log.Info("SafePC Agent Service dừng.");
    }

    private async Task HeartbeatLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                HeartbeatResult? result = await _api.SendHeartbeatAsync(_lockSent ? "locked" : "online", ct);
                if (result is not null)
                {
                    // Chống chỉnh đồng hồ (docs/02-ARCHITECTURE.md mục 4.4):
                    // so sánh giờ máy với giờ server; lệch quá 5 phút thì ghi
                    // log cảnh báo và báo phụ huynh bằng tamper event
                    // clock_drift (tối đa 1 lần/giờ). Engine vẫn thi hành
                    // theo giờ máy + cache rules khi mất mạng.
                    TimeSpan drift = result.ServerTime - DateTimeOffset.UtcNow;
                    if (Math.Abs(drift.TotalMinutes) > 5)
                    {
                        _log.Warning("Đồng hồ máy lệch " + drift.TotalMinutes.ToString("F1", CultureInfo.InvariantCulture) + " phút so với giờ server (ngưỡng 5 phút).");
                        await PushThrottledTamperEventAsync(
                            StateKeys.TamperClockDriftLastSent,
                            "clock_drift",
                            JsonSerializer.SerializeToElement(new { drift_minutes = Math.Round(drift.TotalMinutes, 1) }),
                            ct);
                    }

                    // Sprint 5: đồng bộ ngữ cảnh con ↔ máy (con mặc định +
                    // ánh xạ SID→con) TRƯỚC khi đồng bộ rules, để lần đồng
                    // bộ rules ngay sau đó dùng được con mặc định và ánh xạ
                    // mới nhất khi phân giải con đang active.
                    await SyncChildContextAsync(result, ct);

                    await RefreshRulesAsync(ct);

                    // Đồng bộ hash mã PIN thoát (migration 7): Service giữ
                    // hash trong bộ nhớ để kiểm tra PIN cho Tray qua IPC.
                    // Chỉ ghi log khi giá trị ĐỔI; không bao giờ ghi hash.
                    // MÃ PIN DÙNG MỘT LẦN: nếu có cờ hash-đã-dùng mà server
                    // vẫn trả đúng hash đó (lệnh gỡ lần trước chưa tới) thì
                    // thử gỡ lại và KHÔNG khôi phục hash vào bộ nhớ — mã đã
                    // dùng rồi thì không dùng lại được. Server trả null
                    // (đã gỡ) hoặc hash khác (phụ huynh đã đặt mã mới) thì
                    // xóa cờ và đồng bộ bình thường.
                    string? consumedHash = await _outbox.GetStateAsync(StateKeys.PinConsumedHash, ct);
                    if (consumedHash is not null && string.Equals(result.ExitPinHash, consumedHash, StringComparison.Ordinal))
                    {
                        _queryState.UpdatePinHash(null);
                        bool? cleared = await _api.ClearExitPinAsync(consumedHash, ct);
                        if (cleared is not null)
                        {
                            // true = đã gỡ; false = hash trên server đã đổi
                            // sau lần đọc heartbeat (phụ huynh đặt mã mới) —
                            // RPC đối sánh hash nên mã mới không bị xóa, và
                            // cờ thử lại cũng không còn cần nữa.
                            await _outbox.DeleteStateAsync(StateKeys.PinConsumedHash, ct);
                            _log.Info("Mã PIN thoát đã dùng không còn trên server, xóa cờ thử lại.");
                        }
                        else
                        {
                            _log.Warning("Thử gỡ mã PIN thoát đã dùng trên server chưa thành công, sẽ thử lại ở chu kỳ sau.");
                        }
                    }
                    else
                    {
                        if (consumedHash is not null)
                        {
                            await _outbox.DeleteStateAsync(StateKeys.PinConsumedHash, ct);
                        }

                        if (_queryState.UpdatePinHash(result.ExitPinHash))
                        {
                            _log.Info(result.ExitPinHash is null
                                ? "Mã PIN thoát đã được gỡ (phụ huynh chưa đặt PIN)."
                                : "Mã PIN thoát đã được đặt/cập nhật từ server.");
                        }
                    }

                    // Sprint 4: đồng bộ hash mã PIN xuống cache local để lệnh
                    // verify-pin của bộ gỡ cài đặt kiểm tra được mã ngay cả
                    // khi mất mạng (xem VerifyPinCli). Hash null thì xóa
                    // cache (phụ huynh đã gỡ mã) — cache cũ mà còn thì bộ gỡ
                    // sẽ đòi mã cũ đã gỡ, sai. Best-effort, lỗi thì log.
                    SyncPinHashCache(_queryState.ExitPinHash);

                    // Kiểm tra extension còn sống (chỉ sau khi heartbeat
                    // thành công — máy offline thì không kết luận gì về
                    // extension): đọc file heartbeat NativeHost ghi, báo lên
                    // server tối đa 1 lần/5 phút.
                    await CheckExtensionHeartbeatAsync(ct);

                    // Báo trạng thái thi hành mới nhất (nếu đổi) lên server
                    // — Dashboard đọc để hiển thị máy đang bị khóa bởi gì.
                    // Hàm chỉ gửi khi nội dung đổi nên gọi mỗi chu kỳ là an
                    // toàn; máy offline thì snapshot chờ ở _pending.
                    await MaybeReportEnforcementAsync(ct);
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _log.Error("Heartbeat lỗi.", ex);
            }

            if (!await WaitAsync(AgentConstants.HeartbeatInterval, ct))
            {
                break;
            }
        }
    }

    /// <summary>
    /// Vòng lặp watchdog Tray (Sprint 4, mỗi 60 giây): hỏi IpcPipeServer
    /// snapshot các phiên từng có Tray, để TrayWatchdog quyết định phiên nào
    /// cần khởi động lại / báo phụ huynh, rồi thực hiện từng việc. Mọi lỗi
    /// đều chỉ log — vòng này không bao giờ làm chết Service, và một lần
    /// khởi động thất bại chỉ khiến watchdog backoff rồi thử lại.
    ///
    /// Không khởi động lại Tray khi: phiên đang nối IPC, phiên mới hello
    /// gần đây, phụ huynh vừa thoát Tray bằng mã PIN (ân hạn 30 phút),
    /// phiên không còn user đăng nhập (launcher báo, watchdog quên phiên).
    /// Đường dẫn Tray exe suy từ thư mục Service ({app}\Service →
    /// {app}\Tray); file không tồn tại thì launcher trả lỗi, watchdog
    /// backoff rồi báo phụ huynh sau 5 lần thử.
    /// </summary>
    private async Task TrayWatchdogLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                bool graceActive = await IsPinExitGraceActiveAsync(ct);
                IReadOnlyList<TraySessionSnapshot> snapshot = _ipc.GetTraySessionSnapshot();
                IReadOnlyList<TrayWatchdogAction> actions = _trayWatchdog.Evaluate(snapshot, DateTimeOffset.UtcNow, graceActive);
                foreach (TrayWatchdogAction action in actions)
                {
                    if (action.Kind == TrayWatchdogActionKind.Relaunch)
                    {
                        string trayExePath = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "Tray", "SafePC.Agent.Tray.exe"));
                        bool launched = TrayLauncher.TryLaunchInSession(action.SessionId, trayExePath, _log, out string reason, out bool noUser);
                        if (!launched)
                        {
                            _log.Warning("Watchdog Tray: " + action.Reason + " Khởi động lại thất bại: " + reason);
                        }

                        _trayWatchdog.RecordLaunchResult(action.SessionId, launched, noUser, DateTimeOffset.UtcNow);
                    }
                    else
                    {
                        _log.Warning("Watchdog Tray: " + action.Reason);
                        // Cờ "đã báo trong giờ này" đã được Evaluate đặt khi
                        // tạo việc Alert, nên lần quét sau trong cùng giờ
                        // không báo trùng; sang giờ mới Evaluate cho báo lại.
                        await PushThrottledTamperEventAsync(
                            StateKeys.TamperTrayStoppedLastSent,
                            "tray_stopped",
                            JsonSerializer.SerializeToElement(new { session_id = action.SessionId }),
                            ct);
                    }
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _log.Error("Watchdog Tray lỗi.", ex);
            }

            if (!await WaitAsync(TimeSpan.FromSeconds(60), ct))
            {
                break;
            }
        }
    }

    /// <summary>True khi đang trong ân hạn 30 phút sau khi phụ huynh thoát Tray bằng mã PIN (xem IpcPipeServer).</summary>
    private async Task<bool> IsPinExitGraceActiveAsync(CancellationToken ct)
    {
        try
        {
            string? untilText = await _outbox.GetStateAsync(StateKeys.TrayExitAuthorizedUntil, ct);
            return untilText is not null
                && DateTimeOffset.TryParse(untilText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset until)
                && until > DateTimeOffset.UtcNow;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.Warning("Đọc ân hạn thoát Tray lỗi (coi như không ân hạn): " + ex.Message);
            return false;
        }
    }

    /// <summary>
    /// Đồng bộ rules từ server về cache local cho con đang active (Sprint 5).
    /// Lỗi mạng hoặc chưa pairing (FetchRules trả về null) thì giữ nguyên
    /// cache cũ — KHÔNG xóa cache, vì đó là đường thi hành duy nhất khi offline.
    /// </summary>
    private async Task RefreshRulesAsync(CancellationToken ct)
    {
        ActiveContext active = await GetActiveContextAsync(ct);
        await RefreshRulesForChildAsync(active.ChildId, active.DefaultChildId, ct);
    }

    /// <summary>
    /// Đồng bộ rules của MỘT con từ server về cache local (Sprint 5). Con
    /// mặc định: thử RPC mới (migration 24), rơi về RPC cũ khi RPC mới chưa
    /// có (migration 24 chưa áp) — đường cũ (không truyền child) PHẢI trả về
    /// đúng luật như hiện tại. Con khác: chỉ RPC mới (RPC cũ trả luật SAI
    /// con nên không được fallback); null thì giữ cache cũ. Trả về true khi
    /// đã lưu rules mới (kể cả rỗng — con không có rule nào cũng là trạng
    /// thái hợp lệ, cache rỗng), false khi không tải được gì (mất mạng /
    /// RPC chưa có / chưa pairing). Lưu xong thì xuất bản lại file domain
    /// cho con đó (publisher tự bỏ qua khi nội dung website không đổi).
    /// </summary>
    private async Task<bool> RefreshRulesForChildAsync(Guid? childId, Guid? defaultChildId, CancellationToken ct)
    {
        IReadOnlyList<Rule>? rules = await _api.FetchRulesForChildAsync(childId, ct);
        if (rules is null && (childId is null || childId.Value == defaultChildId))
        {
            // RPC mới chưa có trên server (migration 24 chưa áp) hoặc lỗi
            // mạng: con mặc định thì RPC cũ trả đúng luật của nó.
            rules = await _api.FetchRulesAsync(ct);
        }

        if (rules is null)
        {
            return false;
        }

        int before = (await _outbox.GetCachedRulesAsync(ct)).Count;
        await _outbox.SaveRulesAsync(rules, ct);
        _rulesChildId = childId ?? defaultChildId;
        if (rules.Count != before)
        {
            _log.Info("Đã đồng bộ rules từ server cho con " + (_rulesChildId?.ToString("D") ?? "(chưa rõ)") + ": " + rules.Count + " rules (trước đó " + before + ").");
        }

        // Rules mới có thể đổi quy tắc website: xuất bản lại file domain
        // (publisher tự bỏ qua khi nội dung website không đổi).
        await _publisher.PublishAsync(ct, childId, defaultChildId);
        return true;
    }

    /// <summary>
    /// Phân giải "con nào đang ngồi ở máy" ngay lúc này (Sprint 5): phiên
    /// console (WTS) + các phiên đã hello (SID) + ánh xạ SID→con đã đồng bộ
    /// + con mặc định của máy. Lỗi đọc trạng thái thì trả về context rỗng
    /// (không phiên, không con) để nơi gọi giữ hành vi cũ thay vì crash.
    /// </summary>
    private async Task<ActiveContext> GetActiveContextAsync(CancellationToken ct)
    {
        (int? consoleSessionId, bool consoleQueryFailed, int consoleWin32Error) = GetConsoleSessionId();
        IReadOnlyList<TraySessionSnapshot> sessions = _ipc.GetTraySessionSnapshot();
        IReadOnlyList<ChildAccountLink> links = await GetChildAccountsAsync(ct);
        Guid? defaultChildId = await GetDefaultChildIdAsync(ct);
        if (consoleSessionId is null)
        {
            // Chẩn đoán tiền đề GetLastError (review lần hai, MINOR-1): ghi
            // log một lần khi giá trị lỗi thô đổi, để xác minh trên máy thật
            // rằng ở màn hình đăng nhập GetLastError có đúng bằng 0 không.
            if (consoleWin32Error != _lastConsoleQueryWin32Error)
            {
                _lastConsoleQueryWin32Error = consoleWin32Error;
                _log.Info("WTSGetActiveConsoleSessionId trả 0xFFFFFFFF, GetLastError=" + consoleWin32Error + " (chẩn đoán Sprint 5, review lần hai MINOR-1: xác minh tiền đề phân biệt không-phiên/API-lỗi).");
            }

            // WTS trả 0xFFFFFFFF (không có phiên console HOẶC API lỗi):
            // phân giải bằng ActiveChildResolver.ResolveNullConsoleSession
            // — chưa phiên nào hello thì chắc chắn là không có phiên (đối
            // chiếu snapshot, không cần dựa vào tiền đề GetLastError chưa
            // xác minh); còn lại giữ tiền đề cũ (lỗi API → NoSessionInfo
            // giữ hành vi cũ, không lỗi → NoConsoleSession bỏ qua tick).
            // NoSessionInfo thì con thi hành là con mặc định (fail-closed,
            // như hành vi hôm nay); NoConsoleSession thì không có con nào.
            ActiveChildStatus nullStatus = ActiveChildResolver.ResolveNullConsoleSession(sessions.Count > 0, consoleQueryFailed);
            Guid? nullChildId = nullStatus == ActiveChildStatus.NoSessionInfo ? defaultChildId : null;
            return new ActiveContext(null, nullStatus, nullChildId, defaultChildId, links);
        }

        var infos = new List<ConsoleSessionInfo>(sessions.Count);
        foreach (TraySessionSnapshot session in sessions)
        {
            infos.Add(new ConsoleSessionInfo(session.SessionId, session.Sid, session.UserName, session.IsAdmin));
        }

        (ActiveChildStatus status, Guid? childId) = ActiveChildResolver.Resolve(consoleSessionId, infos, links, defaultChildId);

        // SID của phiên console (nếu phiên đó đã hello): đưa vào Scope để
        // mẫu usage Tray mới đóng dấu SID vẫn đếm đúng cho con này — xem
        // ActiveChildResolver.ScopeForChild (sửa MAJOR-2).
        string? consoleSessionSid = null;
        if (consoleSessionId.HasValue)
        {
            foreach (ConsoleSessionInfo info in infos)
            {
                if (info.SessionId == consoleSessionId.Value)
                {
                    consoleSessionSid = info.Sid;
                    break;
                }
            }
        }

        return new ActiveContext(consoleSessionId, status, childId, defaultChildId, links, consoleSessionSid);
    }

    /// <summary>Ánh xạ SID→con của máy này đã đồng bộ từ server (device_state, heartbeat ghi). Lỗi thì trả về rỗng — máy đơn-con vẫn chạy bằng fallback con mặc định.</summary>
    private async Task<IReadOnlyList<ChildAccountLink>> GetChildAccountsAsync(CancellationToken ct)
    {
        try
        {
            string? json = await _outbox.GetStateAsync(StateKeys.ChildAccountsJson, ct);
            if (string.IsNullOrWhiteSpace(json))
            {
                return Array.Empty<ChildAccountLink>();
            }

            List<ChildAccountLink>? links = JsonSerializer.Deserialize<List<ChildAccountLink>>(json);
            return links ?? (IReadOnlyList<ChildAccountLink>)Array.Empty<ChildAccountLink>();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.Warning("Đọc cache ánh xạ con ↔ tài khoản lỗi (coi như chưa có ánh xạ): " + ex.Message);
            return Array.Empty<ChildAccountLink>();
        }
    }

    /// <summary>
    /// Con mặc định/chính của máy (devices.child_id). Ưu tiên giá trị
    /// heartbeat đã lưu; chưa heartbeat thành công lần nào thì suy ra từ
    /// cache rules — máy đơn-con thì mọi rule cùng một child_id. Trả về
    /// null khi không suy ra được (máy chưa gắn con nào / cache lẫn nhiều
    /// con) — nơi gọi giữ hành vi cũ thay vì đoán.
    /// </summary>
    private async Task<Guid?> GetDefaultChildIdAsync(CancellationToken ct)
    {
        try
        {
            string? stored = await _outbox.GetStateAsync(StateKeys.DefaultChildId, ct);
            if (!string.IsNullOrWhiteSpace(stored) && Guid.TryParse(stored, out Guid parsed))
            {
                return parsed;
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.Warning("Đọc con mặc định của máy lỗi: " + ex.Message);
        }

        try
        {
            IReadOnlyList<Rule> cached = await _outbox.GetCachedRulesAsync(ct);
            return DistinctCachedChild(cached);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.Warning("Suy con mặc định từ cache rules lỗi: " + ex.Message);
            return null;
        }
    }

    /// <summary>
    /// Hồ sơ con duy nhất trong cache rules, hoặc null khi cache rỗng / lẫn
    /// nhiều con (không nên xảy ra — cache chỉ chứa luật của một con).
    /// </summary>
    private static Guid? DistinctCachedChild(IReadOnlyList<Rule> rules)
    {
        Guid? only = null;
        foreach (Rule rule in rules)
        {
            if (only is null)
            {
                only = rule.ChildId;
            }
            else if (only.Value != rule.ChildId)
            {
                return null;
            }
        }

        return only;
    }

    /// <summary>
    /// Đồng bộ ngữ cảnh con ↔ máy sau mỗi heartbeat thành công (Sprint 5):
    /// lưu con mặc định của máy (devices.child_id, heartbeat trả về) + tải
    /// ánh xạ SID→con (migration 24) để vòng tick biết phiên console nào là
    /// con nào. Lỗi thì giữ cache cũ — máy đơn-con vẫn chạy bằng fallback
    /// con mặc định; RPC ánh xạ chưa có (migration 24 chưa áp) thì giữ
    /// cache cũ (rỗng lúc đầu) thay vì xóa.
    /// </summary>
    private async Task SyncChildContextAsync(HeartbeatResult result, CancellationToken ct)
    {
        try
        {
            if (result.ChildId is not null)
            {
                await _outbox.SetStateAsync(StateKeys.DefaultChildId, result.ChildId.Value.ToString("D"), ct);
            }
            else
            {
                await _outbox.DeleteStateAsync(StateKeys.DefaultChildId, ct);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.Warning("Lưu con mặc định của máy lỗi: " + ex.Message);
        }

        try
        {
            IReadOnlyList<ChildAccountLink>? links = await _api.FetchChildAccountsAsync(ct);
            if (links is not null)
            {
                await _outbox.SetStateAsync(StateKeys.ChildAccountsJson, JsonSerializer.Serialize(links), ct);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.Warning("Đồng bộ ánh xạ con ↔ tài khoản lỗi (giữ cache cũ): " + ex.Message);
        }
    }

    /// <summary>
    /// Gửi một message tới Tray của phiên đang active (Sprint 5): biết phiên
    /// console thì gửi có đích (<see cref="IpcPipeServer.SendToSessionAsync"/>)
    /// — phiên nền không nhận lệnh khóa/cảnh báo/mở; chưa biết phiên nào
    /// thì gửi broadcast như trước (fail-closed: lệnh khóa vẫn tới được Tray
    /// nào đang nối). Trả về số Tray đã ghi thành công như
    /// <see cref="IpcPipeServer.SendToTrayAsync"/>.
    /// </summary>
    private async Task<int> SendToTargetSessionAsync(IpcMessage message, ActiveContext active, CancellationToken ct)
    {
        if (active.ConsoleSessionId.HasValue)
        {
            return await _ipc.SendToSessionAsync(active.ConsoleSessionId.Value, message, ct);
        }

        return await _ipc.SendToTrayAsync(message, ct);
    }

    private async Task CommandPollLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                IReadOnlyList<Command> commands = await _api.PollCommandsAsync(ct);

                // Sprint 5: phân giải con đang ở phiên console MỘT lần cho
                // cả đợt poll — mọi lệnh trong đợt dùng cùng context để
                // không lệch nhau giữa chừng (đổi phiên giữa hai lệnh trong
                // cùng một đợt poll là cực hiếm, đợt sau sửa lại).
                ActiveContext active = await GetActiveContextAsync(ct);

                foreach (Command command in commands)
                {
                    // Lệnh cho con chưa active thì HOÃN: giữ pending, không
                    // ack, không thi hành — tới khi con đó lên console thì
                    // vòng poll sau áp dụng. Lệnh cũ (không gắn con) thuộc
                    // về con mặc định: hoãn khi con khác đang active.
                    if (!ActiveChildResolver.ShouldApplyCommand(command.ChildId, active.Status, active.ChildId, active.DefaultChildId))
                    {
                        // Log một lần cho mỗi lệnh để poll 15s không lấp log
                        // với cùng một lệnh đang chờ con lên console.
                        if (_deferredCommandLog.Add(command.Id))
                        {
                            _log.Info("Hoãn command " + command.Id + " (" + command.Type + ", con "
                                + (command.ChildId?.ToString("D") ?? "(mặc định)") + "): con đó chưa ở phiên console, giữ pending tới khi con lên console.");
                        }

                        continue;
                    }

                    _deferredCommandLog.Remove(command.Id);

                    // Mỗi lệnh xử lý độc lập: một lệnh lỗi không chặn các
                    // lệnh sau, và kết quả luôn được ack về server để phụ
                    // huynh biết lệnh đã tới máy hay chưa.
                    bool ok;
                    try
                    {
                        ok = await ExecuteCommandAsync(command, active, ct);
                    }
                    catch (Exception ex)
                    {
                        _log.Error("Thi hành command " + command.Id + " lỗi.", ex);
                        ok = false;
                    }

                    try
                    {
                        await _api.AckCommandAsync(command.Id, ok ? "done" : "failed", ct);
                    }
                    catch (Exception ex)
                    {
                        _log.Error("Ack command " + command.Id + " lỗi.", ex);
                    }
                }

                // Dọn log hoãn: lệnh không còn pending (đã áp/ack/xóa) thì
                // quên để lần hoãn sau (nếu có) lại được log một lần.
                _deferredCommandLog.IntersectWith(commands.Select(c => c.Id));

                // Đẩy các yêu cầu xin thêm giờ con đã gửi (Tray xếp vào
                // outbox) lên bảng requests — cùng chu kỳ poll 15s để phụ
                // huynh thấy yêu cầu gần như ngay khi con gửi.
                await FlushExtraTimeRequestsAsync(ct);

                // Đẩy các yêu cầu xin mở domain con đã gửi từ nút trên trang
                // chặn của extension (NativeHost ghi vào domain_requests.jsonl)
                // lên bảng requests — cùng chu kỳ poll 15s.
                await FlushDomainRequestsAsync(ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _log.Error("Poll commands lỗi.", ex);
            }

            if (!await WaitAsync(AgentConstants.CommandPollInterval, ct))
            {
                break;
            }
        }
    }

    /// <summary>
    /// Đẩy các yêu cầu xin thêm giờ đang chờ trong outbox lên server. Gửi
    /// thành công thì xóa hàng; lỗi thì hẹn thử lại theo backoff của
    /// outbox. Hàng hỏng (JSON không đọc được) thì xóa để không kẹt mãi.
    /// Mỗi hàng xử lý độc lập, lỗi một hàng không chặn các hàng sau.
    /// </summary>
    private async Task FlushExtraTimeRequestsAsync(CancellationToken ct)
    {
        IReadOnlyList<OutboxItem> pending = await _outbox.GetPendingExtraTimeRequestsAsync(limit: 10, ct);
        foreach (OutboxItem item in pending)
        {
            ExtraTimeRequestPayload? request;
            try
            {
                request = JsonSerializer.Deserialize<ExtraTimeRequestPayload>(item.PayloadJson);
            }
            catch (JsonException)
            {
                request = null;
            }

            if (request is null || request.Minutes < 1 || request.Minutes > 240 || string.IsNullOrEmpty(request.Reason))
            {
                _log.Warning("IPC: yêu cầu xin thêm giờ trong outbox hỏng, bỏ qua (id " + item.Id + ").");
                await _outbox.MarkSentAsync(item.Id, ct);
                continue;
            }

            bool ok;
            try
            {
                ok = await _api.PushExtraTimeRequestAsync(request.Minutes, request.Reason, ct);
            }
            catch (Exception ex)
            {
                _log.Error("Đẩy yêu cầu xin thêm giờ lỗi.", ex);
                ok = false;
            }

            if (ok)
            {
                await _outbox.MarkSentAsync(item.Id, ct);
                _log.Info("Đã đẩy yêu cầu xin thêm giờ (" + request.Minutes + " phút) lên server để phụ huynh duyệt.");
            }
            else
            {
                await _outbox.MarkFailedAsync(item.Id, ct);
            }
        }
    }

    /// <summary>Trần kích thước file domain_requests.jsonl: vượt trần thì bỏ dòng cũ nhất.</summary>
    private const int DomainRequestsMaxBytes = 1024 * 1024;

    /// <summary>
    /// Đẩy yêu cầu xin mở domain lên server từ file JSONL do NativeHost ghi
    /// (<c>%ProgramData%\SafePC\shared\domain_requests.jsonl</c>, message
    /// <c>requestUnblock</c> từ nút trên trang chặn của extension 0.1.9). Mỗi
    /// dòng là một JSON {"domain","requestedAt?"} — chỉ tên miền, không
    /// URL/path/query. Dòng gửi thành công, dòng trùng trong đợt, dòng bị
    /// throttle và dòng hỏng đều được tiêu thụ; dòng gửi lỗi (mất mạng, RPC
    /// chưa có) được giữ lại để chu kỳ sau gửi lại. Dòng dở cuối file
    /// (NativeHost đang ghi dở, chưa có newline) không được tiêu thụ. Mỗi
    /// dòng xử lý độc lập, lỗi một dòng không chặn các dòng sau và không
    /// làm chết vòng poll lệnh.
    /// </summary>
    private async Task FlushDomainRequestsAsync(CancellationToken ct)
    {
        string path = DomainRulesPublisher.DomainRequestsFilePath;
        if (!File.Exists(path))
        {
            return;
        }

        byte[] snapshot;
        try
        {
            await using FileStream stream = new(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var memory = new MemoryStream();
            await stream.CopyToAsync(memory, ct);
            snapshot = memory.ToArray();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.Error("Không đọc được file domain_requests.jsonl, để lại chu kỳ sau.", ex);
            return;
        }

        if (snapshot.Length == 0)
        {
            return;
        }

        // Chỉ tiêu thụ tới cuối dòng hoàn chỉnh cuối cùng: phần cuối chưa có
        // '\n' có thể là dòng NativeHost đang ghi dở — để lại chu kỳ sau.
        int consumedLength = LastNewlineOffset(snapshot) + 1;
        if (consumedLength == 0)
        {
            // File chỉ có một dòng dở không có newline. Nếu đã vượt trần 1MB
            // thì dòng đó là rác: cắt cả file để không kẹt mãi.
            if (snapshot.Length > DomainRequestsMaxBytes)
            {
                _log.Warning("File domain_requests.jsonl vượt 1MB mà không có dòng hoàn chỉnh nào, cắt bỏ.");
                // Cắt cả file: vị trí tiêu thụ = toàn bộ snapshot (không có
                // dòng hoàn chỉnh nào để giữ, phần sau cũng rỗng).
                await RewriteDomainRequestsFileAsync(path, Array.Empty<byte>(), snapshot.Length, ct);
            }

            return;
        }

        List<string> lines = SplitCompleteLines(snapshot, consumedLength);

        // Trần 1MB: bỏ các dòng cũ nhất (mất yêu cầu cũ, có log cảnh báo) để
        // file không phình vô hạn khi mất mạng dài ngày.
        int droppedForCap = 0;
        int bytesEstimate = lines.Sum(line => Encoding.UTF8.GetByteCount(line) + 1);
        while (lines.Count > 0 && bytesEstimate > DomainRequestsMaxBytes)
        {
            bytesEstimate -= Encoding.UTF8.GetByteCount(lines[0]) + 1;
            lines.RemoveAt(0);
            droppedForCap++;
        }

        if (droppedForCap > 0)
        {
            _log.Warning("File domain_requests.jsonl vượt 1MB, đã bỏ " + droppedForCap + " dòng cũ nhất.");
        }

        var failedLines = new List<string>();
        var seenInBatch = new HashSet<string>(StringComparer.Ordinal);
        int invalid = 0;
        int throttled = 0;
        int sent = 0;
        DateTimeOffset now = DateTimeOffset.UtcNow;
        foreach (string line in lines)
        {
            // Sprint 5: dòng mang thêm SID của tài khoản đã bấm xin mở
            // (NativeHost ghi) — yêu cầu được gán cho đúng con; dòng cũ
            // không có SID vẫn đọc được (Sid null → con mặc định).
            DomainRequest? request = DomainRequestLine.TryParseRequest(line);
            if (request is null)
            {
                invalid++;
                continue;
            }

            string domain = request.Domain;
            string? sid = request.Sid;

            // Trùng trong cùng đợt (con bấm nút nhiều lần trước một chu kỳ
            // poll): chỉ gửi một lần MỖI (domain, con) — hai con xin mở
            // cùng một domain là hai yêu cầu riêng (RPC chống trùng theo
            // (device, child, domain) từ migration 24).
            if (!seenInBatch.Add(domain + "\n" + (sid ?? string.Empty)))
            {
                continue;
            }

            if (!_unblockDomainThrottle.ShouldSend(domain, sid, now))
            {
                throttled++;
                continue;
            }

            bool ok;
            try
            {
                ok = await _api.PushUnblockDomainRequestAsync(domain, sid, ct);
            }
            catch (Exception ex)
            {
                _log.Error("Đẩy yêu cầu xin mở domain lỗi.", ex);
                ok = false;
            }

            if (ok)
            {
                _unblockDomainThrottle.RecordSent(domain, sid, now);
                sent++;
                _log.Info("Đã đẩy yêu cầu xin mở domain lên server để phụ huynh duyệt: " + domain + ".");
            }
            else
            {
                // Giữ nguyên dòng gốc để chu kỳ sau gửi lại.
                failedLines.Add(line);
            }
        }

        if (invalid > 0)
        {
            _log.Warning("Bỏ qua " + invalid + " dòng domain_requests.jsonl không hợp lệ.");
        }

        if (throttled > 0)
        {
            _log.Info("Bỏ qua " + throttled + " yêu cầu xin mở domain trong cửa sổ throttle 5 phút.");
        }

        if (failedLines.Count > 0)
        {
            _log.Warning("Gửi yêu cầu xin mở domain lỗi, giữ " + failedLines.Count + " dòng lại để chu kỳ sau gửi lại.");
        }

        // Viết lại file: các dòng gửi lỗi + phần sau vị trí đã tiêu thụ (dòng
        // dở cuối snapshot + dòng NativeHost ghi thêm trong lúc gửi). Không
        // dòng lỗi thì phần giữ lại rỗng, tức cắt đúng phần đã tiêu thụ.
        byte[] keepPrefix = failedLines.Count == 0
            ? Array.Empty<byte>()
            : Encoding.UTF8.GetBytes(string.Join('\n', failedLines) + '\n');
        await RewriteDomainRequestsFileAsync(path, keepPrefix, consumedLength, ct);
        if (sent > 0)
        {
            _log.Info("Đã gửi yêu cầu xin mở domain lên server: " + sent + " yêu cầu.");
        }
    }

    /// <summary>
    /// Viết lại file domain_requests.jsonl gồm phần giữ lại (dòng gửi lỗi)
    /// + phần sau vị trí đã tiêu thụ trong lần đọc mới nhất (dòng dở cuối
    /// snapshot + dòng NativeHost ghi thêm trong lúc gửi). Vẫn còn một cửa
    /// sổ đua hẹp nếu NativeHost ghi thêm đúng lúc cắt file — yêu cầu là
    /// best-effort (con bấm lại được, RPC chống trùng) nên chấp nhận, cùng
    /// lý do như file web_usage.jsonl.
    /// </summary>
    private async Task RewriteDomainRequestsFileAsync(string path, byte[] keepPrefix, int consumedLength, CancellationToken ct)
    {
        byte[] suffix;
        try
        {
            await using FileStream stream = new(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            if (stream.Length <= consumedLength)
            {
                suffix = Array.Empty<byte>();
            }
            else
            {
                suffix = new byte[stream.Length - consumedLength];
                stream.Seek(consumedLength, SeekOrigin.Begin);
                int read = 0;
                while (read < suffix.Length)
                {
                    int n = await stream.ReadAsync(suffix.AsMemory(read), ct);
                    if (n == 0)
                    {
                        break;
                    }

                    read += n;
                }

                if (read < suffix.Length)
                {
                    Array.Resize(ref suffix, read);
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.Error("Không đọc được phần còn lại của domain_requests.jsonl sau khi gửi, giữ nguyên file.", ex);
            return;
        }

        try
        {
            await using FileStream stream = new(path, FileMode.Create, FileAccess.Write, FileShare.ReadWrite);
            await stream.WriteAsync(keepPrefix, ct);
            await stream.WriteAsync(suffix, ct);
            await stream.FlushAsync(ct);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.Error("Không cắt được file domain_requests.jsonl sau khi gửi.", ex);
        }
    }

    private async Task UsageFlushLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await _outbox.PruneOldSamplesAsync(TimeSpan.FromDays(7), ct);

                DateTimeOffset since = await GetUsageWatermarkAsync(ct);
                IReadOnlyList<UsageSummary> summary = await _outbox.GetUsageSummaryAsync(since, ct);
                DeviceCredentials? creds = summary.Count > 0 ? _tokens.TryLoadCredentials() : null;
                if (creds is not null)
                {
                    var records = new List<UsageRecord>(summary.Count);
                    foreach (UsageSummary item in summary)
                    {
                        records.Add(new UsageRecord
                        {
                            DeviceId = creds.DeviceId,
                            AppName = item.AppName,
                            ExePathHash = item.ExePathHash,
                            StartedAt = item.FirstSampledAt,
                            DurationSec = (int)(item.SampleCount * AgentConstants.ForegroundSampleInterval.TotalSeconds),
                            // Sprint 5: SID của tài khoản đã dùng app — server
                            // suy ra hồ sơ con qua ánh xạ (migration 24);
                            // mẫu cũ không có SID thì server fallback về
                            // devices.child_id như trước.
                            WindowsSid = item.Sid,
                        });
                    }

                    // family_id/child_id trong record để trống: server suy ra
                    // từ device đã xác thực, client không gửi các trường đó.
                    if (await _api.SendUsageBatchAsync(records, ct))
                    {
                        DateTimeOffset watermark = summary.Max(s => s.LastSampledAt);
                        await _outbox.SetStateAsync(StateKeys.UsagePushedUntil, watermark.ToString("o", CultureInfo.InvariantCulture), ct);
                        _log.Info("Đã gửi usage lên server: " + records.Count + " nhóm app.");
                    }
                }

                // Cùng chu kỳ 5 phút: đẩy lượt thăm web do extension ghi qua
                // NativeHost. Lỗi trong này không được chặn chu kỳ sau.
                await FlushWebUsageAsync(ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _log.Error("Flush usage lỗi.", ex);
            }

            if (!await WaitAsync(AgentConstants.UsageBatchInterval, ct))
            {
                break;
            }
        }
    }

    /// <summary>Watermark đẩy usage: thời điểm mẫu mới nhất đã gửi. Chưa gửi lần nào thì từ đầu.</summary>
    private async Task<DateTimeOffset> GetUsageWatermarkAsync(CancellationToken ct)
    {
        string? stored = await _outbox.GetStateAsync(StateKeys.UsagePushedUntil, ct);
        if (stored is not null
            && DateTimeOffset.TryParse(stored, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset watermark))
        {
            return watermark;
        }

        return DateTimeOffset.MinValue;
    }

    /// <summary>Trần kích thước file web_usage.jsonl: vượt trần thì bỏ dòng cũ nhất.</summary>
    private const int WebUsageMaxBytes = 5 * 1024 * 1024;

    /// <summary>
    /// Đẩy lượt thăm web lên server từ file JSONL do NativeHost ghi
    /// (<c>%ProgramData%\SafePC\shared\web_usage.jsonl</c>). Mỗi dòng là một
    /// JSON {domain, startedAt, durationSec, blocked?, path?, windows_sid?}
    /// — chỉ domain, không URL/path/query; SID (Sprint 5) để server suy ra
    /// hồ sơ con, dòng cũ không có SID thì server ghi theo con mặc định.
    /// Lượt bị chặn (extension 0.1.7) mang blocked = true và durationSec = 0;
    /// dòng cũ không có blocked thì coi là false. Phân tích dòng do
    /// <see cref="WebUsageLine"/> đảm nhiệm (logic thuần, có harness).
    /// File chỉ bị cắt khi gửi thành công toàn bộ; gửi lỗi thì giữ nguyên để
    /// chu kỳ sau gửi lại. Dòng dở cuối file (NativeHost đang ghi dở, chưa
    /// có newline) không được tiêu thụ.
    /// </summary>
    private async Task FlushWebUsageAsync(CancellationToken ct)
    {
        string path = DomainRulesPublisher.WebUsageFilePath;
        if (!File.Exists(path))
        {
            return;
        }

        byte[] snapshot;
        try
        {
            await using FileStream stream = new(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var memory = new MemoryStream();
            await stream.CopyToAsync(memory, ct);
            snapshot = memory.ToArray();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.Error("Không đọc được file web_usage.jsonl, để lại chu kỳ sau.", ex);
            return;
        }

        if (snapshot.Length == 0)
        {
            return;
        }

        // Chỉ tiêu thụ tới cuối dòng hoàn chỉnh cuối cùng: phần cuối chưa có
        // '\n' có thể là dòng NativeHost đang ghi dở — để lại chu kỳ sau.
        int consumedLength = LastNewlineOffset(snapshot) + 1;
        if (consumedLength == 0)
        {
            // File chỉ có một dòng dở không có newline. Nếu đã vượt trần 5MB
            // thì dòng đó là rác: cắt cả file để không kẹt mãi.
            if (snapshot.Length > WebUsageMaxBytes)
            {
                _log.Warning("File web_usage.jsonl vượt 5MB mà không có dòng hoàn chỉnh nào, cắt bỏ.");
                await RewriteWebUsageFileAsync(path, Array.Empty<byte>(), ct);
            }

            return;
        }

        List<string> lines = SplitCompleteLines(snapshot, consumedLength);

        // Trần 5MB: bỏ các dòng cũ nhất (mất dữ liệu cũ, có log cảnh báo) để
        // file không phình vô hạn khi mất mạng dài ngày.
        int droppedForCap = 0;
        int bytesEstimate = lines.Sum(line => Encoding.UTF8.GetByteCount(line) + 1);
        while (lines.Count > 0 && bytesEstimate > WebUsageMaxBytes)
        {
            bytesEstimate -= Encoding.UTF8.GetByteCount(lines[0]) + 1;
            lines.RemoveAt(0);
            droppedForCap++;
        }

        if (droppedForCap > 0)
        {
            _log.Warning("File web_usage.jsonl vượt 5MB, đã bỏ " + droppedForCap + " dòng cũ nhất.");
        }

        var visits = new List<WebVisitRecord>(lines.Count);
        int invalid = 0;
        foreach (string line in lines)
        {
            WebVisitRecord? visit = WebUsageLine.TryParse(line);
            if (visit is null)
            {
                invalid++;
            }
            else
            {
                visits.Add(visit);
            }
        }

        if (invalid > 0)
        {
            _log.Warning("Bỏ qua " + invalid + " dòng web_usage.jsonl không hợp lệ.");
        }

        if (visits.Count == 0)
        {
            // Toàn dòng rác: cắt phần đã tiêu thụ để không thử lại mãi.
            await TruncateConsumedWebUsageAsync(path, consumedLength, ct);
            return;
        }

        // RPC giới hạn 500 dòng/batch: chia nhỏ, batch nào lỗi thì dừng và
        // giữ nguyên file để chu kỳ sau gửi lại từ đầu.
        const int batchSize = 500;
        for (int i = 0; i < visits.Count; i += batchSize)
        {
            IReadOnlyList<WebVisitRecord> batch = visits.Skip(i).Take(batchSize).ToList();
            if (!await _api.SendWebVisitsAsync(batch, ct))
            {
                _log.Warning("Gửi web visits lỗi, giữ file lại để chu kỳ sau gửi lại.");
                return;
            }
        }

        await TruncateConsumedWebUsageAsync(path, consumedLength, ct);
        _log.Info("Đã gửi web usage lên server: " + visits.Count + " lượt thăm.");
    }

    /// <summary>Vị trí byte của '\n' cuối cùng, hoặc -1 khi không có dòng hoàn chỉnh nào.</summary>
    private static int LastNewlineOffset(byte[] bytes)
    {
        for (int i = bytes.Length - 1; i >= 0; i--)
        {
            if (bytes[i] == (byte)'\n')
            {
                return i;
            }
        }

        return -1;
    }

    /// <summary>Tách vùng byte đã tiêu thụ thành các dòng, bỏ dòng rỗng và '\r' cuối dòng.</summary>
    private static List<string> SplitCompleteLines(byte[] snapshot, int consumedLength)
    {
        string text = Encoding.UTF8.GetString(snapshot, 0, consumedLength);
        string[] parts = text.Split('\n');
        var lines = new List<string>(parts.Length);
        foreach (string part in parts)
        {
            string line = part.TrimEnd('\r');
            if (line.Length > 0)
            {
                lines.Add(line);
            }
        }

        return lines;
    }

    /// <summary>
    /// Cắt phần đã tiêu thụ khỏi file web_usage.jsonl, giữ lại phần sau vị
    /// trí đã tiêu thụ (dòng dở cuối snapshot + dòng NativeHost ghi thêm
    /// trong lúc upload). Vẫn còn một cửa sổ đua hẹp nếu NativeHost ghi thêm
    /// đúng lúc cắt file — dữ liệu usage là best-effort nên chấp nhận.
    /// </summary>
    private async Task TruncateConsumedWebUsageAsync(string path, int consumedLength, CancellationToken ct)
    {
        byte[] suffix;
        try
        {
            await using FileStream stream = new(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            if (stream.Length <= consumedLength)
            {
                suffix = Array.Empty<byte>();
            }
            else
            {
                suffix = new byte[stream.Length - consumedLength];
                stream.Seek(consumedLength, SeekOrigin.Begin);
                int read = 0;
                while (read < suffix.Length)
                {
                    int n = await stream.ReadAsync(suffix.AsMemory(read), ct);
                    if (n == 0)
                    {
                        break;
                    }

                    read += n;
                }

                if (read < suffix.Length)
                {
                    Array.Resize(ref suffix, read);
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.Error("Không đọc được phần còn lại của web_usage.jsonl sau khi gửi, giữ nguyên file.", ex);
            return;
        }

        await RewriteWebUsageFileAsync(path, suffix, ct);
    }

    private async Task RewriteWebUsageFileAsync(string path, byte[] content, CancellationToken ct)
    {
        try
        {
            await using FileStream stream = new(path, FileMode.Create, FileAccess.Write, FileShare.ReadWrite);
            await stream.WriteAsync(content, ct);
            await stream.FlushAsync(ct);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.Error("Không cắt được file web_usage.jsonl sau khi gửi.", ex);
        }
    }

    private async Task RuleCheckLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                // Sprint 5 (máy dùng chung, một phiên active): mọi thi hành
                // trong một lần kiểm tra dùng cùng một context (phiên
                // console + con đang ngồi máy) để không lệch nhau giữa
                // chừng — xem GetActiveContextAsync.
                ActiveContext active = await GetActiveContextAsync(ct);

                // Phiên Standard chưa gắn hồ sơ nào: KHÔNG thi hành luật
                // (quyết định ĐÃ CHỐT 20/11/2026) — ghi log cảnh báo 1
                // lần/phiên, rồi chờ như thường. Cảnh báo trên Dashboard
                // cho tài khoản này làm ở đợt Dashboard (chưa làm ở đây).
                if (active.Status == ActiveChildStatus.UnmappedStandard)
                {
                    if (active.ConsoleSessionId.HasValue && _unmappedWarnedSessions.Add(active.ConsoleSessionId.Value))
                    {
                        _log.Warning("Phiên console " + active.ConsoleSessionId.Value + " chưa gắn với hồ sơ con nào: không thi hành luật trên phiên này.");
                    }

                    if (!await WaitAsync(AgentConstants.ForegroundSampleInterval, ct))
                    {
                        break;
                    }

                    continue;
                }

                // Phiên admin đang ngồi máy: miễn trừ như hiện tại (không
                // thi hành luật). Ghi chú một lần/phiên để log trả lời được
                // tại sao máy không khóa khi admin đang dùng.
                if (active.Status == ActiveChildStatus.AdminExempt)
                {
                    if (active.ConsoleSessionId.HasValue && _adminNotedSessions.Add(active.ConsoleSessionId.Value))
                    {
                        _log.Info("Phiên console là phiên admin: miễn trừ thi hành luật.");
                    }

                    if (!await WaitAsync(AgentConstants.ForegroundSampleInterval, ct))
                    {
                        break;
                    }

                    continue;
                }

                // Không có phiên console nào (máy ở màn hình đăng nhập):
                // không có ai để thi hành luật — chờ như thường, không log
                // (trạng thái bình thường).
                if (active.Status == ActiveChildStatus.NoConsoleSession)
                {
                    if (!await WaitAsync(AgentConstants.ForegroundSampleInterval, ct))
                    {
                        break;
                    }

                    continue;
                }

                // Đổi phiên console hoặc đổi con đang active: đặt lại trạng
                // thái tick trong bộ nhớ — trạng thái này thuộc về con/phiên
                // cũ (VD: _lockSent=true của con A không được chặn lệnh khóa
                // cho con B; cửa sổ cảnh báo đang đếm ngược của con A không
                // áp cho con B). Trạng thái BỀN (ghi đè, cờ khóa cưỡng chế,
                // watermark) đã tách theo con nên không mất.
                // Riêng _lastBreakActive chỉ đặt lại khi ĐỔI CON (giờ nghỉ
                // thuộc về con, không thuộc về phiên): con quay lại giữa
                // giờ nghỉ của chính mình sẽ ghi thêm một sự kiện
                // break_started — chấp nhận được ở đợt 1 (sự kiện vẫn đúng
                // cho phiên mới); đợt sau có thể tách trạng thái nghỉ theo con.
                bool sessionChanged = active.ConsoleSessionId != _lastConsoleSessionId;
                bool childChanged = active.ChildId != _lastActiveChildId;
                // Sprint 5 đợt 1 (sửa MAJOR-3, phần b): tick đầu tiên sau
                // khi đổi phiên/con — dùng ở nhánh Allowed để gửi Unlock một
                // lần dọn màn hình khóa còn sót (xem
                // ActiveChildResolver.ShouldSendUnlockOnAllowed).
                bool contextJustChanged = sessionChanged || childChanged;
                if (sessionChanged || childChanged)
                {
                    _lockSent = false;
                    _pendingLockAt = null;
                    _lastWarnBucket = 0;
                    _lastPendingWarnMinutes = 0;
                    _lastDecisionLogSignature = null;
                    if (childChanged)
                    {
                        _lastBreakActive = false;
                    }

                    _lastConsoleSessionId = active.ConsoleSessionId;
                    _lastActiveChildId = active.ChildId;
                    _log.Info("Đổi phiên console/con đang active: phiên "
                        + (active.ConsoleSessionId?.ToString(CultureInfo.InvariantCulture) ?? "(không rõ)")
                        + ", con " + (active.ChildId?.ToString("D") ?? "(chưa rõ)") + ". Đặt lại trạng thái tick.");
                }

                // Cache rules chỉ chứa luật của MỘT con: nếu biết chắc cache
                // đang là luật của con KHÁC, hoặc con đang active không phải
                // con mặc định mà không biết cache của ai (vừa khởi động),
                // thì thử đồng bộ luật của con đang active; không tải được
                // (mất mạng / RPC mới chưa có) thì BỎ QUA lần kiểm tra này
                // — thà không thi hành còn hơn thi hành luật của con khác
                // cho con này. Máy đơn-con thì cache luôn là luật con mặc
                // định nên không bao giờ rơi vào nhánh này.
                if (active.ChildId is not null
                    && ((_rulesChildId.HasValue && _rulesChildId.Value != active.ChildId.Value)
                        || (!_rulesChildId.HasValue && active.ChildId.Value != active.DefaultChildId)))
                {
                    bool refreshed = await RefreshRulesForChildAsync(active.ChildId, active.DefaultChildId, ct);
                    if (!refreshed)
                    {
                        if (_rulesSkipWarnedChildId != active.ChildId)
                        {
                            _rulesSkipWarnedChildId = active.ChildId;
                            _log.Warning("Chưa đồng bộ được rules cho con đang active (" + active.ChildId.Value.ToString("D") + ") — bỏ qua lần kiểm tra này để không thi hành luật của con khác.");
                        }

                        if (!await WaitAsync(AgentConstants.ForegroundSampleInterval, ct))
                        {
                            break;
                        }

                        continue;
                    }

                    _rulesSkipWarnedChildId = null;
                }

                IReadOnlyList<Rule> rules = await _outbox.GetCachedRulesAsync(ct);

                // Sprint 5: chỉ tính giờ dùng của con đang active (mẫu
                // usage gắn với SID của con; mẫu không rõ phiên chỉ tính
                // cho con mặc định — xem ActiveChildResolver.ScopeForChild).
                TimeSpan usedToday = await _outbox.GetUsageTodayForChildAsync(active.Scope, ct);

                // Đọc ghi đè tạm thời ở mỗi lần kiểm tra: hết hạn thì tự
                // vô hiệu (kể cả sau khi Service khởi động lại), không cần
                // lệnh hủy riêng. RuleEngine kiểm tra lại hết hạn một lần nữa.
                // Sprint 5: ghi đè theo con đang active (hàng legacy không
                // gắn con thuộc về con mặc định).
                TemporaryOverride? activeOverride = await _outbox.GetActiveOverrideForChildAsync(active.ChildId, active.DefaultChildId, ct);
                DateTimeOffset now = DateTimeOffset.Now;

                // Ghi đè đổi (áp dụng/hết hạn/bị thay) thì xuất bản lại file
                // domain: GetActiveOverrideForChildAsync xóa hàng hết hạn khi đọc,
                // nên lần kiểm tra đầu tiên sau khi hết hạn sẽ thấy chữ ký
                // đổi sang "(none)" và temp entry được gỡ khỏi file trong
                // vòng 15 giây. Publisher tự bỏ qua khi nội dung không đổi
                // (ghi đè giờ giấc không ảnh hưởng file domain).
                // Sprint 5: chữ ký mang cả con đang active — đổi con mà
                // ghi đè giống hệt nhau vẫn xuất bản lại file theo con mới.
                string overrideSignature = (active.ChildId?.ToString("D") ?? "(none)") + "|"
                    + (activeOverride is null
                        ? "(none)"
                        : activeOverride.Action + "|" + activeOverride.ExpiresAt.ToString("o", CultureInfo.InvariantCulture)
                            + "|" + string.Join(",", activeOverride.Domains ?? Array.Empty<string>())
                            + "|" + string.Join(",", activeOverride.Apps ?? Array.Empty<string>()));
                if (overrideSignature != _lastOverrideSignature)
                {
                    _lastOverrideSignature = overrideSignature;
                    await _publisher.PublishAsync(ct, active.ChildId, active.DefaultChildId);
                }

                // Sprint 5: cờ khóa cưỡng chế theo con đang active (khóa
                // legacy không gắn con thuộc về con mặc định).
                bool forcedLock = await _outbox.GetForcedLockAsync(active.ChildId, active.DefaultChildId, ct);

                // Ghi đè mở máy tạm thời (unlock) nghĩa là "máy được dùng thêm
                // giờ": RuleEngine mở máy theo giờ giấc, nhưng nghỉ bắt buộc
                // và thi hành theo app/focus VẪN chạy trong lúc ghi đè còn
                // hạn (quyết định ngày 18/11/2026). Biến này chỉ còn dùng
                // cho lý do hiển thị "thời gian còn lại" bên dưới.
                bool unlockOverride = activeOverride is not null
                    && activeOverride.ExpiresAt > now
                    && activeOverride.Action == OverrideActions.Unlock;

                ParsedAppRules parsedAppRules = GetParsedAppRules(rules);

                // Quyết định khóa/mở hiện tại: RuleEngine + nghỉ bắt buộc ép
                // thành khóa, qua đường dùng chung với handler ghi đè mở
                // khóa — một nguồn sự thật duy nhất.
                (RuleDecision decision, bool breakActive) = await EvaluateLockDecisionAsync(
                    rules, usedToday, activeOverride, forcedLock, parsedAppRules, now, active.Scope, ct);

                // Lịch sử thi hành (migration 10): nghỉ bắt buộc vừa bắt
                // đầu (chuyển false -> true) thì ghi sự kiện break_started.
                // Đánh giá ở đây — không ghi trong EvaluateForcedBreakAsync
                // — để hai đường gọi (tick + handler ghi đè) cùng đặt trạng
                // thái BreakEndsAt cũng chỉ sinh một sự kiện cho một giờ
                // nghỉ. BreakConfig có thể null khi rule bị gỡ giữa giờ
                // nghỉ (trạng thái BreakEndsAt vẫn còn): khi đó details
                // chỉ mang rule_ids, không mang số phút.
                if (breakActive && !_lastBreakActive)
                {
                    var breakDetails = new Dictionary<string, object>
                    {
                        ["rule_ids"] = ForcedBreakRuleIds(rules),
                    };
                    if (parsedAppRules.BreakConfig is not null)
                    {
                        breakDetails["work_minutes"] = parsedAppRules.BreakConfig.WorkMinutes;
                        breakDetails["break_minutes"] = parsedAppRules.BreakConfig.BreakMinutes;
                    }

                    await PushEnforcementEventAsync(
                        "break_started",
                        JsonSerializer.SerializeToElement(breakDetails),
                        ct);
                }

                _lastBreakActive = breakActive;

                switch (decision.Kind)
                {
                    case RuleDecisionKind.Allowed:
                        _lastWarnBucket = 0;
                        // Hết điều kiện khóa thì hủy cả lệnh khóa đang chờ
                        // (VD: ghi đè mở khóa tới trong lúc chờ): nếu cửa sổ
                        // cảnh báo đang hiện thì lệnh mở dưới đây sẽ đóng nó.
                        // Chỉ hủy pending khi gửi mở thành công (đúng mẫu
                        // _lockSent): gửi rớt thì tick sau gửi lại.
                        bool hadPendingLock = _pendingLockAt.HasValue;
                        // Sprint 5 đợt 1 (sửa MAJOR-3, phần b): vừa đổi
                        // phiên/con thì gửi Unlock một lần kể cả khi chưa từng
                        // gửi khóa cho con mới — dọn màn hình khóa do
                        // hello-sync gửi nhầm trước khi tick kịp đánh giá.
                        if (ActiveChildResolver.ShouldSendUnlockOnAllowed(_lockSent, hadPendingLock, contextJustChanged))
                        {
                            // Chuyển từ khóa sang cho phép (hết giờ ngủ, hết
                            // khung cấm, ghi đè hết hạn...): báo Tray đóng
                            // màn hình khóa, nếu không cửa sổ khóa sẽ ở lại
                            // dù rules đã cho phép. Chỉ xóa cờ khi gửi thành
                            // công tới ≥1 Tray (review batch #5): gửi rớt thì
                            // tick sau gửi lại.
                            _log.Info("Hết điều kiện khóa. Báo Tray đóng màn hình khóa/cảnh báo.");
                            // Sprint 5: chỉ gửi tới Tray của phiên đang
                            // active — phiên nền không nhận lệnh mở/khóa.
                            int unlockSent = await SendToTargetSessionAsync(IpcMessage.Create(IpcMessageTypes.Unlock, new { }), active, ct);
                            if (unlockSent > 0)
                            {
                                _lockSent = false;
                                _pendingLockAt = null;
                            }
                        }
                        break;

                    case RuleDecisionKind.Warn:
                        int bucket = decision.MinutesLeft <= 1 ? 1 : decision.MinutesLeft <= 5 ? 5 : 15;
                        if (bucket != _lastWarnBucket)
                        {
                            _lastWarnBucket = bucket;
                            _log.Info("Sắp hết giờ, còn " + decision.MinutesLeft + " phút. Báo Tray hiện cảnh báo.");
                            int deadlineWarned = await SendToTargetSessionAsync(
                                IpcMessage.Create(IpcMessageTypes.Warning, new WarningPayload(decision.MinutesLeft, decision.Reason)), active, ct);
                            // Lịch sử thi hành: chỉ ghi khi cảnh báo tới
                            // được ≥1 Tray (đã hiện thật cho con). Hành vi
                            // bucket không đổi: đã chuyển bucket thì lần
                            // kiểm tra sau không gửi lại dù lần này rớt.
                            if (deadlineWarned > 0)
                            {
                                await PushEnforcementEventAsync(
                                    "warning_shown",
                                    JsonSerializer.SerializeToElement(new { kind = "deadline", minutes_left = decision.MinutesLeft }),
                                    ct);
                            }
                        }
                        break;

                    case RuleDecisionKind.Lock:
                        // Khóa có độ trễ đang chờ: chưa tới hẹn thì chỉ gửi
                        // cảnh báo (khi số phút còn lại đổi), chưa gửi lệnh
                        // khóa. Tới hẹn thì xóa hẹn và rơi xuống gửi khóa
                        // như thường ở dưới — khóa này là Immediate (con đã
                        // có cả thời gian chờ để lưu bài nên màn hình khóa
                        // không đếm ngược 60 giây nữa).
                        bool delayJustExpired = false;
                        if (_pendingLockAt.HasValue)
                        {
                            if (now < _pendingLockAt.Value)
                            {
                                int minutesLeft = Math.Max(1, (int)Math.Ceiling((_pendingLockAt.Value - now).TotalMinutes));
                                if (minutesLeft != _lastPendingWarnMinutes)
                                {
                                    _log.Info("Đang chờ khóa có độ trễ, còn " + minutesLeft + " phút. Gửi cảnh báo.");
                                    int warned = await SendToTargetSessionAsync(
                                        IpcMessage.Create(IpcMessageTypes.Warning, new WarningPayload(minutesLeft, "Phụ huynh sẽ khóa máy. Hãy lưu bài làm của bạn.")), active, ct);
                                    if (warned > 0)
                                    {
                                        _lastPendingWarnMinutes = minutesLeft;
                                        // Lịch sử thi hành: cảnh báo chờ
                                        // khóa đã hiện thật cho con.
                                        await PushEnforcementEventAsync(
                                            "warning_shown",
                                            JsonSerializer.SerializeToElement(new { kind = "pending_lock", minutes_left = minutesLeft }),
                                            ct);
                                    }
                                }

                                break;
                            }

                            _pendingLockAt = null;
                            delayJustExpired = true;
                        }

                        bool firstLock = !_lockSent;
                        if (firstLock || breakActive)
                        {
                            // Giờ nghỉ bắt buộc nhắc lại lệnh khóa ở MỌI lần
                            // kiểm tra (kể cả khi đã gửi rồi), để con đăng
                            // nhập lại sớm thì Tray khóa lại ngay qua
                            // ReassertLock. Lần nhắc lại không ghi log để
                            // khỏi lấp đầy file log mỗi 15 giây.
                            if (firstLock)
                            {
                                _log.Info("Hết giờ (" + decision.Reason + "). Báo Tray hiện màn hình khóa.");
                            }

                            // Chỉ coi là "đã gửi" khi thật sự ghi tới ≥1
                            // Tray: mẫu cũ đặt _lockSent = true TRƯỚC khi
                            // gửi, nên lần gửi lúc chưa Tray nào nối (bị bỏ
                            // qua) vẫn khóa cờ vĩnh viễn và lệnh khóa không
                            // bao giờ được gửi lại — log 17/11/2026: màn
                            // hình khóa chưa từng hiện vì đúng lỗi này.
                            // Gửi thất bại thì cờ vẫn false, lần kiểm tra
                            // sau gửi lại.
                            int sent = await SendToTargetSessionAsync(
                                IpcMessage.Create(IpcMessageTypes.Lock, new LockPayload(decision.Reason, delayJustExpired)), active, ct);
                            if (firstLock)
                            {
                                _lockSent = sent > 0;
                            }

                            // Lịch sử thi hành (migration 10): màn hình khóa
                            // vừa hiện lần đầu do quyết định này. Chỉ ghi
                            // khóa do QUY TẮC GIỜ GIẤC: khóa cưỡng chế/ghi
                            // đè khóa của phụ huynh đã đếm được từ bảng
                            // commands, nghỉ bắt buộc đã có sự kiện
                            // break_started riêng — ghi thêm sẽ đếm trùng.
                            // Lần nhắc lại trong giờ nghỉ (breakActive,
                            // không phải firstLock) không ghi: cùng một lần
                            // khóa đang tiếp diễn. Phân loại bằng đúng
                            // helper của snapshot (DeriveLockedBy /
                            // DeriveEnforcementReasons) với quyết định GỐC:
                            // snapshot bên dưới dùng quyết định đã điều
                            // chỉnh độ trễ nên không dùng chung được.
                            if (firstLock && sent > 0
                                && DeriveLockedBy(decision, breakActive, forcedLock, activeOverride, now) == "rule")
                            {
                                (List<string> eventReasons, List<string> eventRuleIds) = DeriveEnforcementReasons(
                                    decision, rules, breakActive, forcedLock, activeOverride, now);
                                await PushEnforcementEventAsync(
                                    "lock_started",
                                    JsonSerializer.SerializeToElement(new
                                    {
                                        kind = eventReasons.Count > 0 ? eventReasons[0] : "rule",
                                        rule_ids = eventRuleIds,
                                    }),
                                    ct);
                            }
                        }
                        break;
                }

                // Thi hành theo app/focus SAU switch quyết định giờ giấc:
                // không có rule app/focus nào và không có ghi đè app thì hàm
                // tự bỏ qua ngay. Kết quả thi hành (focus có đang hiệu lực,
                // app nào đang bị chặn) đi vào snapshot enforcement bên dưới.
                // Thi hành theo app/focus luôn chạy, kể cả trong lúc mở khóa
                // tạm thời (quyết định ngày 18/11/2026): mở khóa chỉ thêm
                // giờ dùng máy, app bị chặn vẫn bị đóng. Qua cổng chống
                // chồng chéo với lượt thi hành ngay khi nhận báo cáo
                // foreground: cổng bận thì dùng kết quả gần nhất.
                (bool focusActive, List<string> appBlocks) = await EnforceAppRulesForTickAsync(parsedAppRules, now, activeOverride, active, ct);

                // Snapshot trạng thái thi hành + chẩn đoán quyết định: dựng
                // mỗi lần kiểm tra và gửi lên server ngay khi đổi (gọi
                // MaybeReportEnforcementAsync bên dưới; chu kỳ heartbeat
                // vẫn gọi lại như dự phòng). lockedBy/reasons/ruleIds suy
                // ra từ chính kết quả đánh giá của lần này.
                // Đang chờ khóa có độ trễ: snapshot báo "cảnh báo" thay vì
                // "đang khóa" — màn hình khóa chưa hiện, Dashboard không nên
                // báo khóa sớm. DeriveLockedBy trả về null khi decision
                // không phải Lock nên lockedBy cũng sạch.
                if (_pendingLockAt.HasValue && now < _pendingLockAt.Value)
                {
                    int pendingMinutesLeft = Math.Max(1, (int)Math.Ceiling((_pendingLockAt.Value - now).TotalMinutes));
                    decision = new RuleDecision(RuleDecisionKind.Warn, "Phụ huynh sẽ khóa máy.", pendingMinutesLeft);
                }

                (List<string> reasons, List<string> ruleIds) = DeriveEnforcementReasons(decision, rules, breakActive, forcedLock, activeOverride, now);
                string? lockedBy = DeriveLockedBy(decision, breakActive, forcedLock, activeOverride, now);
                (string snapshotJson, string snapshotSignature) = BuildEnforcementSnapshot(
                    decision, lockedBy, reasons, ruleIds, appBlocks, HasEnabledWebsiteRule(rules), focusActive, now);
                lock (_enforcementGate)
                {
                    _pendingEnforcementJson = snapshotJson;
                    _pendingEnforcementSignature = snapshotSignature;
                }

                // Báo snapshot lên server NGAY khi nội dung đổi (đợt sửa
                // 18/11/2026): trước đây chỉ chu kỳ heartbeat 60 giây mới
                // gửi, nên sau khi duyệt thêm giờ Dashboard vẫn hiện "Đang
                // khóa" tới 1 phút dù máy đã mở. Chữ ký đổi mới gửi (xem
                // MaybeReportEnforcementAsync) nên gọi mỗi lần kiểm tra
                // 15 giây cũng không gửi thừa; gửi lỗi thì giữ chữ ký cũ
                // để lần sau thử lại.
                await MaybeReportEnforcementAsync(ct);

                // Quyết định cuối cùng (đã gồm nghỉ bắt buộc, ghi đè, khóa
                // có độ trễ) cũng là đáp án cho câu hỏi "thời gian còn lại"
                // của Tray — để ở trạng thái chia sẻ cho IpcPipeServer đọc.
                // Riêng trường hợp Allowed, quyết định thi hành luôn mang
                // int.MaxValue nên phải điền số phút thật bằng
                // GetRemainingMinutes (review đợt này: không thì Tray báo
                // "không còn giới hạn" suốt cả ngày dù sắp hết giờ).
                RuleDecision displayDecision = decision;
                if (decision.Kind == RuleDecisionKind.Allowed)
                {
                    int remainingMinutes = _ruleEngine.GetRemainingMinutes(rules, usedToday, now, activeOverride);

                    // Đang trong thời gian mở khóa tạm thời thì nói rõ điều
                    // đó thay vì "không còn giới hạn" (yêu cầu test máy thật
                    // 17/11/2026): Tray hiển thị lý do khi không có số phút.
                    string displayReason = unlockOverride ? "Đang mở khóa tạm thời theo lệnh của phụ huynh." : string.Empty;
                    displayDecision = new RuleDecision(RuleDecisionKind.Allowed, displayReason, remainingMinutes);
                }

                // Phút thưởng thêm đang hiệu lực để Tray hiện cho con thấy giờ
                // thưởng của mình (ngân hàng giờ). Điều kiện giống hệt chỗ
                // RuleEngine cộng bonus (GetRemainingMinutes): ghi đè còn
                // hạn và đúng action bonus_minutes — không thêm ngữ nghĩa
                // mới, chỉ đọc lại ghi đè của lần đánh giá này.
                int? activeBonusMinutes = activeOverride is not null && activeOverride.ExpiresAt > now
                    && activeOverride.Action == OverrideActions.BonusMinutes
                    ? activeOverride.Minutes
                    : null;

                _queryState.UpdateDecision(displayDecision, now, activeBonusMinutes, active.ChildId);

                LogRuleDecisionIfDue(decision, ruleIds, usedToday, activeOverride);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _log.Error("Kiểm tra rules lỗi.", ex);
            }

            if (!await WaitAsync(AgentConstants.ForegroundSampleInterval, ct))
            {
                break;
            }
        }
    }

    /// <summary>
    /// Gửi một tamper event lên server, tối đa 1 lần/giờ cho mỗi loại (mốc
    /// lần gửi lưu bền vững trong device_state để sống sót qua khởi động
    /// lại). Chỉ ghi mốc khi gửi thành công — gửi lỗi thì lần sau thử lại.
    /// Tự bắt mọi lỗi (trừ hủy) để không chặn vòng lặp gọi.
    /// </summary>
    private async Task PushThrottledTamperEventAsync(string stateKey, string eventType, JsonElement details, CancellationToken ct)
    {
        try
        {
            string? lastSentText = await _outbox.GetStateAsync(stateKey, ct);
            if (lastSentText is not null
                && DateTimeOffset.TryParse(lastSentText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset lastSent)
                && DateTimeOffset.UtcNow - lastSent < TimeSpan.FromHours(1))
            {
                return;
            }

            if (await _api.PushTamperEventAsync(eventType, details, ct))
            {
                await _outbox.SetStateAsync(stateKey, DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture), ct);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.Error("Gửi tamper event " + eventType + " lỗi.", ex);
        }
    }

    /// <summary>
    /// Gửi một sự kiện thi hành lên server (migration 10, bảng audit_logs).
    /// Chỉ gọi ở điểm CHUYỂN TRẠNG THÁI (khóa bắt đầu, nghỉ bắt đầu, đóng
    /// app, hiện cảnh báo) — không throttle như tamper event vì bản thân
    /// các điểm gọi đã thưa. Lỗi mạng/server/RPC chưa tồn tại thì API trả
    /// false và đã ghi log throttle — nơi gọi bỏ qua mềm, không retry.
    /// Tự bắt mọi lỗi (trừ hủy) để không chặn vòng lặp gọi; thi hành (IPC
    /// /kill) luôn chạy TRƯỚC khi gọi hàm này nên lỗi đẩy không bao giờ
    /// ảnh hưởng thi hành. Trả về true chỉ khi server đã ghi (nơi gọi
    /// chống spam dùng để quyết định có ghi mốc dedupe không).
    /// </summary>
    private async Task<bool> PushEnforcementEventAsync(string eventType, JsonElement details, CancellationToken ct)
    {
        try
        {
            return await _api.PushEnforcementEventAsync(eventType, details, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.Error("Gửi enforcement event " + eventType + " lỗi.", ex);
            return false;
        }
    }

    /// <summary>
    /// Kiểm tra extension trình duyệt còn sống qua file heartbeat NativeHost
    /// ghi. Chỉ gọi sau khi heartbeat thành công (máy đang online). Timestamp
    /// mới (&lt; 5 phút) thì báo lên server, tối đa 1 lần/5 phút. File thiếu/
    /// hỏng/cũ hơn 15 phút thì chỉ ghi log cảnh báo (tối đa 1 lần/giờ, trong
    /// bộ nhớ) — KHÔNG đẩy tamper event: Dashboard hiển thị độ cũ từ cột
    /// last_extension_seen_at. Khoảng 5-15 phút là vùng xám, không làm gì.
    /// </summary>
    private async Task CheckExtensionHeartbeatAsync(CancellationToken ct)
    {
        DateTimeOffset? seenAt = await ReadExtensionHeartbeatAsync(ct);
        DateTimeOffset now = DateTimeOffset.UtcNow;

        if (seenAt is not null && now - seenAt.Value < TimeSpan.FromMinutes(5))
        {
            string? lastText = await _outbox.GetStateAsync(StateKeys.ExtensionHeartbeatLastReported, ct);
            bool due = lastText is null
                || !DateTimeOffset.TryParse(lastText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset last)
                || now - last >= TimeSpan.FromMinutes(5);
            if (due && await _api.ReportExtensionHeartbeatAsync(seenAt.Value, ct))
            {
                await _outbox.SetStateAsync(StateKeys.ExtensionHeartbeatLastReported, now.ToString("o", CultureInfo.InvariantCulture), ct);
            }

            return;
        }

        bool stale = seenAt is null || now - seenAt.Value > TimeSpan.FromMinutes(15);
        if (stale && now - _lastExtensionStaleLogAt >= TimeSpan.FromHours(1))
        {
            _lastExtensionStaleLogAt = now;
            _log.Warning("Không thấy dấu hiệu extension trình duyệt trong hơn 15 phút (file extension_heartbeat.txt thiếu hoặc đã cũ).");
        }

        // Sprint 4: extension TỪNG sống mà giờ mất dấu thì báo phụ huynh —
        // trước đây loại extension_missing không ai đẩy nên pipeline thông
        // báo (email + Dashboard) có sẵn mà không có dữ liệu. Chỉ đẩy khi
        // trình duyệt vừa chạy foreground (xem MaybePushExtensionMissingAsync).
        if (stale)
        {
            await MaybePushExtensionMissingAsync(seenAt, ct);
        }
    }

    /// <summary>
    /// Đồng bộ hash mã PIN thoát xuống cache local cho lệnh verify-pin của
    /// bộ gỡ cài đặt (Sprint 4): hash khác null thì ghi file (DPAPI + khóa
    /// ACL SYSTEM + Admins qua TokenStore); hash null (phụ huynh đã gỡ mã)
    /// thì xóa file cache. Đồng bộ (không await) vì TokenStore đồng bộ;
    /// best-effort: lỗi thì log, không chặn heartbeat.
    /// </summary>
    private void SyncPinHashCache(string? exitPinHash)
    {
        try
        {
            string cachePath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "SafePC",
                AgentConstants.ExitPinHashCacheFileName);
            if (string.IsNullOrEmpty(exitPinHash))
            {
                if (File.Exists(cachePath))
                {
                    File.Delete(cachePath);
                    _log.Info("Đã xóa cache hash mã PIN (phụ huynh đã gỡ mã PIN).");
                }

                return;
            }

            var cache = new TokenStore(cachePath);
            string? existing = cache.TryLoadToken();
            if (!string.Equals(existing, exitPinHash, StringComparison.Ordinal))
            {
                cache.SaveToken(exitPinHash);
                _log.Info("Đã đồng bộ hash mã PIN xuống cache local cho bộ gỡ cài đặt.");
            }
        }
        catch (Exception ex)
        {
            _log.Warning("Đồng bộ cache hash mã PIN lỗi (bộ gỡ cài đặt sẽ dùng server thay cho cache): " + ex.Message);
        }
    }

    /// <summary>
    /// Đẩy sự kiện can thiệp extension_missing khi extension TỪNG sống mà
    /// giờ mất dấu (Sprint 4). Ba cửa chặn để không báo sai:
    /// - Chưa từng báo extension sống lần nào (máy chưa từng cài/mở trình
    ///   duyệt có extension): không kết luận "mất".
    /// - Trình duyệt không chạy foreground trong 15 phút qua: extension im
    ///   lặng là bình thường (trình duyệt đóng), không kết luận "mất".
    /// - Chống spam 1 lần/giờ (hàm PushThrottledTamperEventAsync); email
    ///   chống spam riêng 1 lần/6h mỗi máy.
    /// Chỉ chạy sau heartbeat thành công (máy đang online) nên máy offline
    /// không bị kết luận sai về extension.
    /// </summary>
    private async Task MaybePushExtensionMissingAsync(DateTimeOffset? seenAt, CancellationToken ct)
    {
        try
        {
            string? everReported = await _outbox.GetStateAsync(StateKeys.ExtensionHeartbeatLastReported, ct);
            if (everReported is null)
            {
                return;
            }

            DateTimeOffset lastBrowser;
            string? lastBrowserExe;
            lock (_browserGate)
            {
                lastBrowser = _lastBrowserForegroundAt;
                lastBrowserExe = _lastBrowserExe;
            }

            if (DateTimeOffset.UtcNow - lastBrowser > TimeSpan.FromMinutes(15))
            {
                return;
            }

            await PushThrottledTamperEventAsync(
                StateKeys.TamperExtensionMissingLastSent,
                "extension_missing",
                JsonSerializer.SerializeToElement(new
                {
                    last_seen = seenAt?.ToString("o", CultureInfo.InvariantCulture),
                    browser = lastBrowserExe ?? "unknown",
                }),
                ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.Error("Đẩy sự kiện extension_missing lỗi.", ex);
        }
    }

    /// <summary>Đọc timestamp UTC trong file extension_heartbeat.txt. Null khi file thiếu, đọc lỗi hoặc timestamp hỏng.</summary>
    private async Task<DateTimeOffset?> ReadExtensionHeartbeatAsync(CancellationToken ct)
    {
        string path = DomainRulesPublisher.ExtensionHeartbeatFilePath;
        try
        {
            if (!File.Exists(path))
            {
                return null;
            }

            string text = await File.ReadAllTextAsync(path, ct);
            if (DateTimeOffset.TryParse(text.Trim(), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset seenAt))
            {
                return seenAt;
            }

            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.Warning("Không đọc được file extension_heartbeat.txt: " + ex.Message);
            return null;
        }
    }

    /// <summary>
    /// Phân tích rule theo app/focus từ cache, có cache theo chữ ký (id +
    /// enabled + config thô của rule app/website): rules không đổi thì trả
    /// kết quả cũ, tránh phân tích JSON mỗi 15 giây.
    /// </summary>
    private ParsedAppRules GetParsedAppRules(IReadOnlyList<Rule> rules)
    {
        lock (_appRulesCacheLock)
        {
            var signature = new StringBuilder();
            foreach (Rule rule in rules)
            {
                if (rule.Type != RuleTypes.App && rule.Type != RuleTypes.Website)
                {
                    continue;
                }

                signature.Append(rule.Id).Append('|').Append(rule.Enabled ? '1' : '0').Append('|')
                    .Append(rule.Type).Append('|').Append(rule.Config.GetRawText()).Append('\n');
            }

            string key = signature.ToString();
            if (key == _appRulesSignature && _parsedAppRules is not null)
            {
                return _parsedAppRules;
            }

            _parsedAppRules = AppRuleParser.Parse(rules, _log);
            _appRulesSignature = key;
            return _parsedAppRules;
        }
    }

    /// <summary>
    /// Đánh giá quyết định khóa/mở HIỆN TẠI theo đúng một đường duy nhất:
    /// <see cref="RuleEngine.Evaluate"/> (ghi đè + khóa cưỡng chế + giờ
    /// giấc), rồi nghỉ bắt buộc ép thành khóa khi đang trong giờ nghỉ.
    /// Vòng kiểm tra rules và handler ghi đè mở khóa tạm thời cùng dùng hàm
    /// này — một nguồn sự thật duy nhất, không nhân bản logic nghỉ bắt buộc
    /// sang handler. Trả về cả cờ nghỉ bắt buộc để vòng kiểm tra nhắc lại
    /// lệnh khóa ở mọi lần kiểm tra trong giờ nghỉ.
    /// </summary>
    private async Task<(RuleDecision Decision, bool BreakActive)> EvaluateLockDecisionAsync(
        IReadOnlyList<Rule> rules,
        TimeSpan usedToday,
        TemporaryOverride? activeOverride,
        bool forcedLock,
        ParsedAppRules parsedAppRules,
        DateTimeOffset now,
        UsageScope? scope,
        CancellationToken ct)
    {
        RuleDecision decision = _ruleEngine.Evaluate(rules, usedToday, now, foregroundAppName: null, activeOverride, forcedLock: forcedLock);

        // Nghỉ bắt buộc được đánh giá sau RuleEngine: đang trong giờ nghỉ
        // thì ép quyết định thành khóa; hết giờ nghỉ thì dọn trạng thái rồi
        // đánh giá bình thường. Nghỉ bắt buộc luôn được đánh giá, kể cả
        // trong lúc mở khóa tạm thời (quyết định ngày 18/11/2026): dùng
        // liên tục đủ lâu thì vẫn khóa tới hết giờ nghỉ.
        // Sprint 5: streak nghỉ tính trên mẫu của con đang active (scope
        // null = đường cũ: mọi mẫu; trạng thái BreakEndsAt/BreakStreakFloor
        // vẫn dùng chung cả máy ở đợt 1 — xem docs §4.13).
        bool breakActive = await EvaluateForcedBreakAsync(parsedAppRules, now, scope, ct);
        if (breakActive)
        {
            decision = new RuleDecision(RuleDecisionKind.Lock, "Đến giờ nghỉ bắt buộc", 0);
        }

        return (decision, breakActive);
    }

    /// <summary>
    /// Đánh giá nghỉ bắt buộc. Trả về true khi đang trong giờ nghỉ (kể cả giờ
    /// nghỉ vừa bắt đầu ở lần này). Trạng thái bền vững trong device_state:
    /// <c>BreakEndsAt</c> là thời điểm kết thúc giờ nghỉ; khi hết giờ nghỉ thì
    /// xóa nó và đặt <c>BreakStreakFloor</c> bằng thời điểm kết thúc, để mẫu
    /// trong giờ nghỉ không gây nghỉ lại ngay. Không có rule forced_break thì
    /// không làm gì. Trong giờ nghỉ thì bỏ qua đánh giá streak (mẫu lúc đó
    /// được sàn loại bỏ sau khi nghỉ xong).
    /// </summary>
    private async Task<bool> EvaluateForcedBreakAsync(ParsedAppRules parsed, DateTimeOffset now, UsageScope? scope, CancellationToken ct)
    {
        string? endsAtText = await _outbox.GetStateAsync(StateKeys.BreakEndsAt, ct);
        if (endsAtText is not null)
        {
            if (DateTimeOffset.TryParse(endsAtText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset endsAt))
            {
                if (now < endsAt)
                {
                    return true;
                }

                await _outbox.DeleteStateAsync(StateKeys.BreakEndsAt, ct);
                await _outbox.SetStateAsync(StateKeys.BreakStreakFloor, endsAt.ToString("o", CultureInfo.InvariantCulture), ct);
                _log.Info("Hết giờ nghỉ bắt buộc.");
            }
            else
            {
                // Giá trị hỏng: xóa để không kẹt ở trạng thái nghỉ mãi.
                await _outbox.DeleteStateAsync(StateKeys.BreakEndsAt, ct);
            }
        }

        ForcedBreakConfig? config = parsed.BreakConfig;
        if (config is null)
        {
            return false;
        }

        string? floorText = await _outbox.GetStateAsync(StateKeys.BreakStreakFloor, ct);
        DateTimeOffset floor = DateTimeOffset.MinValue;
        if (floorText is not null)
        {
            DateTimeOffset.TryParse(floorText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out floor);
        }

        DateTimeOffset windowStart = now.AddMinutes(-config.WorkMinutes - 10);
        if (floor > windowStart)
        {
            windowStart = floor;
        }

        IReadOnlyList<DateTimeOffset> samples = scope is null
            ? await _outbox.GetSampleTimesSinceAsync(windowStart, ct)
            : await _outbox.GetSampleTimesSinceForChildAsync(windowStart, scope, ct);
        TimeSpan streak = ComputeUsageStreak(samples, now);
        if (streak < TimeSpan.FromMinutes(config.WorkMinutes))
        {
            return false;
        }

        DateTimeOffset breakEnd = now.AddMinutes(config.BreakMinutes);
        await _outbox.SetStateAsync(StateKeys.BreakEndsAt, breakEnd.ToString("o", CultureInfo.InvariantCulture), ct);
        _log.Info("Bắt đầu nghỉ bắt buộc " + config.BreakMinutes + " phút sau " + config.WorkMinutes + " phút dùng liên tục.");
        return true;
    }

    /// <summary>
    /// Chuỗi dùng liên tục từ các thời điểm mẫu (đã sắp xếp tăng dần, nhịp
    /// 15 giây): khoảng trống &gt; 3 phút thì chuỗi đứt; mẫu mới nhất cũ hơn
    /// 3 phút nghĩa là đang idle, chuỗi = 0. Mẫu mới nhất đại diện cho thêm
    /// 15 giây (cùng cách đếm của <see cref="OutboxStore.GetUsageTodayAsync"/>).
    /// </summary>
    private static TimeSpan ComputeUsageStreak(IReadOnlyList<DateTimeOffset> sampleTimes, DateTimeOffset now)
    {
        if (sampleTimes.Count == 0)
        {
            return TimeSpan.Zero;
        }

        DateTimeOffset newest = sampleTimes[sampleTimes.Count - 1];
        if (now - newest > TimeSpan.FromMinutes(3))
        {
            return TimeSpan.Zero;
        }

        DateTimeOffset streakStart = newest;
        for (int i = sampleTimes.Count - 1; i > 0; i--)
        {
            if (sampleTimes[i] - sampleTimes[i - 1] > TimeSpan.FromMinutes(3))
            {
                break;
            }

            streakStart = sampleTimes[i - 1];
        }

        return (newest - streakStart) + AgentConstants.ForegroundSampleInterval;
    }

    /// <summary>
    /// Kích hoạt khi <see cref="ForegroundState"/> ghi nhận báo cáo
    /// foreground mới. Chạy trên thread xử lý message của handler pipe nên
    /// CHỈ kích hoạt fire-and-forget và trả về ngay — không await, không
    /// chặn, không ném. Lượt thi hành chạy trên thread-pool.
    /// </summary>
    private void OnForegroundReportReceived(ForegroundReport report)
    {
        // Sprint 4: ghi nhận trình duyệt chạy foreground để kết luận
        // extension "mất" chỉ khi trình duyệt đang chạy mà extension im lặng
        // (xem MaybePushExtensionMissingAsync). Không chặn xử lý báo cáo.
        TrackBrowserForeground(report);
        _ = EnforceAppRulesOnReportAsync(report);
    }

    /// <summary>
    /// Ghi nhận lần cuối một trình duyệt đã biết chạy foreground (Sprint 4).
    /// Chỉ cập nhật khi exe (đã chuẩn hóa) nằm trong danh sách trình duyệt.
    /// </summary>
    private void TrackBrowserForeground(ForegroundReport report)
    {
        try
        {
            string? exe = ExeNames.Normalize(report.Payload.ExeName);
            if (exe is null || !KnownBrowserExeNames.Contains(exe))
            {
                return;
            }

            lock (_browserGate)
            {
                _lastBrowserForegroundAt = DateTimeOffset.UtcNow;
                _lastBrowserExe = exe;
            }
        }
        catch (Exception ex)
        {
            _log.Warning("Ghi nhận trình duyệt foreground lỗi: " + ex.Message);
        }
    }

    /// <summary>
    /// Lượt thi hành app NGAY khi nhận báo cáo foreground mới, không chờ
    /// tick 15 giây (18/11/2026): app bị chặn bị đóng trong ~vài giây sau
    /// khi mở, thay vì tới ~1 phút. Dùng chung
    /// <see cref="EnforceAppRulesAsync"/> với vòng tick (không nhân đôi
    /// logic kill), tôn trọng cùng quy tắc tươi/fail-open. Cổng TryEnter
    /// gộp burst: đang có lượt chạy (tick hoặc lượt ngay khác) thì lượt
    /// này bỏ qua — lượt đang chạy đọc báo cáo mới nhất; báo cáo tới giữa
    /// chừng được vòng tick sau bắt lại trong ≤15 giây (cửa tươi 90 giây).
    /// Tự bắt mọi lỗi để không bao giờ ném ra thread xử lý pipe.
    /// </summary>
    private async Task EnforceAppRulesOnReportAsync(ForegroundReport report)
    {
        CancellationToken ct = _stoppingToken;
        try
        {
            // Sprint 5: phân giải con đang active TRƯỚC khi lấy cổng thi
            // hành (đọc nhanh từ SQLite local) — báo cáo từ phiên nền, từ
            // phiên admin, hay từ phiên chưa gắn hồ sơ thì bỏ qua ngay, kể
            // cả khi cổng đang rảnh: đường thi hành ngay không được giết
            // app của con đang chạy nền, cũng không được giết app của admin.
            ActiveContext active = await GetActiveContextAsync(ct);
            if (active.Status is ActiveChildStatus.UnmappedStandard or ActiveChildStatus.AdminExempt or ActiveChildStatus.NoConsoleSession)
            {
                return;
            }

            if (active.ConsoleSessionId.HasValue && report.Payload.SessionId != active.ConsoleSessionId.Value)
            {
                return;
            }

            // Cache rules chưa phải luật của con đang active (đổi con mà
            // vòng tick chưa kịp đồng bộ) thì bỏ qua lượt này — vòng tick
            // sẽ đồng bộ rồi thi hành trong ≤15 giây, không thi hành luật
            // của con khác cho con này.
            if (active.ChildId is not null
                && ((_rulesChildId.HasValue && _rulesChildId.Value != active.ChildId.Value)
                    || (!_rulesChildId.HasValue && active.ChildId.Value != active.DefaultChildId)))
            {
                return;
            }

            if (!await _appEnforcementGate.WaitAsync(0, ct))
            {
                return;
            }

            try
            {
                IReadOnlyList<Rule> rules = await _outbox.GetCachedRulesAsync(ct);
                // Sprint 5: ghi đè app theo con đang active.
                TemporaryOverride? activeOverride = await _outbox.GetActiveOverrideForChildAsync(active.ChildId, active.DefaultChildId, ct);
                DateTimeOffset now = DateTimeOffset.Now;
                await RunAndCacheAppEnforcementAsync(GetParsedAppRules(rules), now, activeOverride, active, ct);

                // Breadcrumb chống spam (tối đa 1 dòng/15 phút): đủ để log
                // trả lời được "đường thi hành ngay có chạy không" mà không
                // lấp log mỗi lần đổi cửa sổ. Lượt đóng app đã có dòng log
                // riêng trong KillAppAsync.
                if (DateTimeOffset.UtcNow - _lastImmediateEnforcementLogAt >= TimeSpan.FromMinutes(15))
                {
                    _lastImmediateEnforcementLogAt = DateTimeOffset.UtcNow;
                    _log.Info("Thi hành quy tắc app ngay khi nhận báo cáo foreground (phiên #" + report.Payload.SessionId + ").");
                }
            }
            finally
            {
                _appEnforcementGate.Release();
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Service đang dừng.
        }
        catch (Exception ex)
        {
            _log.Error("Thi hành quy tắc app ngay khi foreground đổi lỗi.", ex);
        }
    }

    /// <summary>
    /// Thi hành theo app cho vòng tick, qua cổng chống chồng chéo với lượt
    /// thi hành ngay: cổng bận thì trả về kết quả gần nhất (snapshot không
    /// dao động về rỗng) thay vì chờ — tick không bao giờ chờ lượt kia.
    /// </summary>
    private async Task<(bool FocusActive, List<string> AppBlocks)> EnforceAppRulesForTickAsync(
        ParsedAppRules parsed,
        DateTimeOffset now,
        TemporaryOverride? activeOverride,
        ActiveContext active,
        CancellationToken ct)
    {
        if (!await _appEnforcementGate.WaitAsync(0, ct))
        {
            lock (_lastAppEnforcementLock)
            {
                return _lastAppEnforcement;
            }
        }

        try
        {
            return await RunAndCacheAppEnforcementAsync(parsed, now, activeOverride, active, ct);
        }
        finally
        {
            _appEnforcementGate.Release();
        }
    }

    /// <summary>
    /// Chạy <see cref="EnforceAppRulesAsync"/> rồi lưu kết quả làm "gần
    /// nhất" cho vòng tick dùng khi cổng bận. Nơi gọi phải giữ
    /// <see cref="_appEnforcementGate"/> trước khi gọi.
    /// </summary>
    private async Task<(bool FocusActive, List<string> AppBlocks)> RunAndCacheAppEnforcementAsync(
        ParsedAppRules parsed,
        DateTimeOffset now,
        TemporaryOverride? activeOverride,
        ActiveContext active,
        CancellationToken ct)
    {
        (bool focusActive, List<string> appBlocks) = await EnforceAppRulesAsync(parsed, now, activeOverride, active, ct);
        lock (_lastAppEnforcementLock)
        {
            _lastAppEnforcement = (focusActive, appBlocks);
        }

        return (focusActive, appBlocks);
    }

    /// <summary>
    /// Thi hành quy tắc theo app và giờ học tập trung cho mọi session có báo
    /// cáo foreground tươi. Không có rule nào và không có ghi đè app thì bỏ
    /// qua ngay. Không có báo cáo tươi thì KHÔNG kill (fail-open: không biết
    /// foreground là gì), chỉ ghi log chống spam — nhưng vẫn trả về trạng
    /// thái focus/appBlocks tính theo giờ (không cần foreground) để snapshot
    /// enforcement phản ánh đúng. Hàm chạy cả trong lúc ghi đè mở khóa tạm
    /// thời (quyết định ngày 18/11/2026): unlock chỉ hoãn khóa máy theo giờ
    /// giấc, không miễn thi hành theo app/focus.
    /// Trả về (focus có đang hiệu lực, exe đang chịu thi hành chặn/allowlist
    /// trong lần này). Ghi đè app (block_app/allow_app) được xét trong
    /// <see cref="EnforceAppRulesForReportAsync"/> và có hiệu lực cả khi
    /// không có rule app nào.
    /// </summary>
    private async Task<(bool FocusActive, List<string> AppBlocks)> EnforceAppRulesAsync(
        ParsedAppRules parsed,
        DateTimeOffset now,
        TemporaryOverride? activeOverride,
        ActiveContext active,
        CancellationToken ct)
    {
        // Ghi đè app chỉ có hiệu lực khi còn hạn (GetActiveOverrideForChildAsync đã
        // lọc hết hạn, kiểm tra lại ở đây cho chắc).
        TemporaryOverride? appOverride = activeOverride is not null
            && activeOverride.ExpiresAt > now
            && (activeOverride.Action == OverrideActions.BlockApp || activeOverride.Action == OverrideActions.AllowApp)
            ? activeOverride
            : null;
        HashSet<string>? overrideApps = appOverride?.Apps is null ? null : NormalizeExeSet(appOverride.Apps);
        if (overrideApps is not null && overrideApps.Count == 0)
        {
            appOverride = null;
            overrideApps = null;
        }

        if (!parsed.HasAny && appOverride is null)
        {
            return (false, new List<string>());
        }

        DateTime local = now.LocalDateTime;
        (bool focusActive, _) = EvaluateFocusState(parsed, local);

        // Sprint 5: hạn mức app tính trên giờ dùng của con đang active
        // (mẫu gắn với SID của con; mẫu không rõ phiên chỉ tính cho con
        // mặc định) — giờ của con kia không làm con này hết hạn mức.
        IReadOnlyDictionary<string, TimeSpan> usageByApp = await _outbox.GetUsageByAppTodayForChildAsync(active.Scope, ct);
        Dictionary<string, TimeSpan> normalizedUsage = NormalizeUsageByApp(usageByApp);

        // App đang chịu thi hành chặn trong lần này (không cần foreground):
        // luôn chặn + ngoài khung giờ được dùng + đã hết hạn mức hôm nay.
        // App bị đóng do focus/allowlist/ghi đè được thêm ở từng báo cáo.
        var appBlocks = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (AppRef blocked in parsed.BlockAlways)
        {
            appBlocks.Add(blocked.NormalizedExe);
        }

        foreach (AppBlockEntry block in parsed.BlockByTime)
        {
            if (AppRuleParser.MinutesUntilWindowEnd(block.WindowsByWeekday, local) is null)
            {
                appBlocks.Add(block.App.NormalizedExe);
            }
        }

        foreach (AppTimeLimitEntry limit in parsed.TimeLimits)
        {
            normalizedUsage.TryGetValue(limit.App.NormalizedExe, out TimeSpan used);
            if (limit.MinutesPerDay - (int)used.TotalMinutes <= 0)
            {
                appBlocks.Add(limit.App.NormalizedExe);
            }
        }

        IReadOnlyList<ForegroundReport> reports = _foregroundState.TryGetFreshReports(TimeSpan.FromSeconds(90));
        if (reports.Count == 0)
        {
            if (DateTimeOffset.UtcNow - _lastStaleForegroundLogAt >= TimeSpan.FromMinutes(15))
            {
                _lastStaleForegroundLogAt = DateTimeOffset.UtcNow;
                _log.Warning("Không có báo cáo foreground tươi, bỏ qua thi hành quy tắc theo app kỳ này.");
            }

            return (focusActive, SortAppBlocks(appBlocks));
        }

        string todayKey = local.Date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        // Dọn key cảnh báo của ngày cũ để HashSet không phình vô hạn.
        _appWarnedKeys.RemoveWhere(key => !key.EndsWith("|" + todayKey, StringComparison.Ordinal));

        foreach (ForegroundReport report in reports)
        {
            // Sprint 5: chỉ thi hành cho báo cáo của phiên console đang
            // active — báo cáo của phiên nền (con kia đang chạy nền) không
            // giết app, không cảnh báo. Đường thi hành ngay đã lọc trước
            // khi lấy cổng; vòng tick lọc lại ở đây vì báo cáo có thể tới
            // từ phiên đã rời console giữa chừng.
            if (active.ConsoleSessionId.HasValue && report.Payload.SessionId != active.ConsoleSessionId.Value)
            {
                continue;
            }

            await EnforceAppRulesForReportAsync(
                report.Payload, parsed, normalizedUsage, local, todayKey, appOverride, overrideApps, appBlocks, ct);
        }

        return (focusActive, SortAppBlocks(appBlocks));
    }

    private static List<string> SortAppBlocks(HashSet<string> appBlocks)
    {
        return appBlocks.OrderBy(exe => exe, StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>
    /// Thi hành cho một báo cáo foreground. Thứ tự: ghi đè app tạm thời
    /// TRƯỚC (block_app đóng app khớp danh sách, allow_app miễn app khớp
    /// khỏi MỌI thi hành dưới đây), rồi focus, rồi allowlist theo app
    /// (luôn áp dụng hoặc theo giờ), rồi luôn chặn, rồi chặn theo giờ, rồi
    /// giới hạn thời gian. Có lệnh đóng thì đóng và dừng (không cảnh báo
    /// thêm); không thì cảnh báo một lần/ngày/exe khi sắp hết hạn. Chỉ log
    /// tên exe + lý do. Mọi đường đóng đều qua <see cref="KillAppAsync"/>.
    /// </summary>
    private async Task EnforceAppRulesForReportAsync(
        ForegroundChangedPayload foreground,
        ParsedAppRules parsed,
        Dictionary<string, TimeSpan> usageByApp,
        DateTime local,
        string todayKey,
        TemporaryOverride? appOverride,
        HashSet<string>? overrideApps,
        HashSet<string> appBlocks,
        CancellationToken ct)
    {
        // Ghi đè app tạm thời, xét TRƯỚC mọi rule: app foreground khớp danh
        // sách thì hoặc bị đóng (block_app) hoặc được miễn hoàn toàn
        // (allow_app, kể cả focus/allowlist).
        if (appOverride is not null && overrideApps is not null && IsForegroundAllowed(foreground, overrideApps))
        {
            if (appOverride.Action == OverrideActions.BlockApp)
            {
                string display = foreground.ExeName ?? foreground.AppName;
                string? fgExe = ForegroundNormalizedExe(foreground);
                if (fgExe is not null)
                {
                    appBlocks.Add(fgExe);
                }

                await KillAppAsync(fgExe, foreground.SessionId, display, "đang bị chặn tạm thời", "temp_block", ct);
            }

            return;
        }

        // Giờ học tập trung: hợp danh sách app cho phép của mọi rule focus
        // đang trong khung giờ. App foreground không thuộc danh sách thì đóng.
        (bool focusActive, HashSet<string> focusAllowed) = EvaluateFocusState(parsed, local);
        if (focusActive && !IsForegroundAllowed(foreground, focusAllowed))
        {
            string display = foreground.ExeName ?? foreground.AppName;
            string? fgExe = ForegroundNormalizedExe(foreground);
            if (fgExe is not null)
            {
                appBlocks.Add(fgExe);
            }

            await KillAppAsync(fgExe, foreground.SessionId, display, "đang giờ học tập trung", "focus", ct);
            return;
        }

        // Allowlist theo app: hợp danh sách cho phép của mọi rule allowlist
        // đang hiệu lực (luôn áp dụng, hoặc theo giờ thì chỉ trong khung).
        // App foreground không thuộc danh sách thì đóng (mirror focus).
        (bool allowlistActive, HashSet<string> allowlistAllowed) = EvaluateAllowlistState(parsed, local);
        if (allowlistActive && !IsForegroundAllowed(foreground, allowlistAllowed))
        {
            string display = foreground.ExeName ?? foreground.AppName;
            string? fgExe = ForegroundNormalizedExe(foreground);
            if (fgExe is not null)
            {
                appBlocks.Add(fgExe);
            }

            await KillAppAsync(fgExe, foreground.SessionId, display, "không thuộc danh sách app được phép", "allowlist", ct);
            return;
        }

        string? killExe = null;
        string? killDisplay = null;
        string? killClause = null;
        string? killKind = null;
        int? warnWindowMinutes = null;
        string? warnWindowExe = null;
        string? warnWindowDisplay = null;

        // Luôn chặn: app trong danh sách thì đóng khi thấy, không cần khung giờ.
        foreach (AppRef blocked in parsed.BlockAlways)
        {
            if (MatchesForeground(foreground, blocked.NormalizedExe))
            {
                killExe = blocked.NormalizedExe;
                killDisplay = blocked.DisplayName;
                killClause = "đang bị chặn";
                killKind = "block";
                break;
            }
        }

        if (killExe is null)
        {
            foreach (AppBlockEntry block in parsed.BlockByTime)
            {
                if (!MatchesForeground(foreground, block.App.NormalizedExe))
                {
                    continue;
                }

                int? minutesLeft = AppRuleParser.MinutesUntilWindowEnd(block.WindowsByWeekday, local);
                if (minutesLeft is null)
                {
                    // Ngoài mọi khung giờ được dùng hôm nay (kể cả ngày không có
                    // khung nào): đóng app.
                    killExe = block.App.NormalizedExe;
                    killDisplay = block.App.DisplayName;
                    killClause = "đang ngoài khung giờ được dùng";
                    killKind = "block_by_time";
                    break;
                }

                int clamped = Math.Max(1, minutesLeft.Value);
                if (clamped <= 5 && (warnWindowMinutes is null || clamped < warnWindowMinutes.Value))
                {
                    warnWindowMinutes = clamped;
                    warnWindowExe = block.App.NormalizedExe;
                    warnWindowDisplay = block.App.DisplayName;
                }
            }
        }

        int? warnLimitMinutes = null;
        string? warnLimitExe = null;
        string? warnLimitDisplay = null;
        if (killExe is null)
        {
            foreach (AppTimeLimitEntry limit in parsed.TimeLimits)
            {
                if (!MatchesForeground(foreground, limit.App.NormalizedExe))
                {
                    continue;
                }

                usageByApp.TryGetValue(limit.App.NormalizedExe, out TimeSpan used);
                int minutesLeft = limit.MinutesPerDay - (int)used.TotalMinutes;
                if (minutesLeft <= 0)
                {
                    killExe = limit.App.NormalizedExe;
                    killDisplay = limit.App.DisplayName;
                    killClause = "đã hết thời gian cho phép hôm nay";
                    killKind = "time_limit";
                    break;
                }

                if (minutesLeft <= 5 && (warnLimitMinutes is null || minutesLeft < warnLimitMinutes.Value))
                {
                    warnLimitMinutes = minutesLeft;
                    warnLimitExe = limit.App.NormalizedExe;
                    warnLimitDisplay = limit.App.DisplayName;
                }
            }
        }

        if (killExe is not null)
        {
            appBlocks.Add(killExe);
            await KillAppAsync(killExe, foreground.SessionId, killDisplay!, killClause!, killKind!, ct);
            return;
        }

        if (warnWindowMinutes is not null && warnWindowExe is not null && warnWindowDisplay is not null
            && MarkAppWarned(warnWindowExe, todayKey, "window"))
        {
            // Sprint 5: cảnh báo chỉ gửi tới Tray của phiên đã báo cáo
            // (phiên console đang active) — phiên nền không nhận.
            int appWindowWarned = await _ipc.SendToSessionAsync(
                foreground.SessionId,
                IpcMessage.Create(IpcMessageTypes.Warning, new WarningPayload(
                    warnWindowMinutes.Value,
                    warnWindowDisplay + " sắp hết khung giờ được dùng, còn " + warnWindowMinutes.Value + " phút.")),
                ct);
            // Lịch sử thi hành: chỉ ghi khi cảnh báo tới được ≥1 Tray.
            if (appWindowWarned > 0)
            {
                await PushEnforcementEventAsync(
                    "warning_shown",
                    JsonSerializer.SerializeToElement(new { kind = "app_window", minutes_left = warnWindowMinutes.Value, exe = warnWindowExe }),
                    ct);
            }
        }

        if (warnLimitMinutes is not null && warnLimitExe is not null && warnLimitDisplay is not null
            && MarkAppWarned(warnLimitExe, todayKey, "limit"))
        {
            int appLimitWarned = await _ipc.SendToSessionAsync(
                foreground.SessionId,
                IpcMessage.Create(IpcMessageTypes.Warning, new WarningPayload(
                    warnLimitMinutes.Value,
                    warnLimitDisplay + " sắp hết thời gian cho phép, còn " + warnLimitMinutes.Value + " phút.")),
                ct);
            // Lịch sử thi hành: chỉ ghi khi cảnh báo tới được ≥1 Tray.
            if (appLimitWarned > 0)
            {
                await PushEnforcementEventAsync(
                    "warning_shown",
                    JsonSerializer.SerializeToElement(new { kind = "app_limit", minutes_left = warnLimitMinutes.Value, exe = warnLimitExe }),
                    ct);
            }
        }
    }

    /// <summary>
    /// Gộp usage hôm nay theo tên exe đã chuẩn hóa (khóa so khớp không phân
    /// biệt hoa thường): <c>app_name</c> trong DB là tên process trần, còn
    /// config ghi "game.exe" — chuẩn hóa cả hai phía rồi cộng dồn.
    /// </summary>
    private static Dictionary<string, TimeSpan> NormalizeUsageByApp(IReadOnlyDictionary<string, TimeSpan> usageByApp)
    {
        var normalized = new Dictionary<string, TimeSpan>(StringComparer.OrdinalIgnoreCase);
        foreach (KeyValuePair<string, TimeSpan> pair in usageByApp)
        {
            string? key = ExeNames.Normalize(pair.Key);
            if (key is null)
            {
                continue;
            }

            normalized.TryGetValue(key, out TimeSpan existing);
            normalized[key] = existing + pair.Value;
        }

        return normalized;
    }

    /// <summary>App foreground có phải app của rule không: khớp tên file exe hoặc tên process (chuẩn hóa cả hai phía).</summary>
    private static bool MatchesForeground(ForegroundChangedPayload foreground, string normalizedExe)
    {
        return ExeNames.Matches(normalizedExe, foreground.ExeName)
            || ExeNames.Matches(normalizedExe, foreground.AppName);
    }

    /// <summary>App foreground có thuộc danh sách cho phép (tên đã chuẩn hóa) không.</summary>
    private static bool IsForegroundAllowed(ForegroundChangedPayload foreground, HashSet<string> allowedNormalized)
    {
        string? exe = ExeNames.Normalize(foreground.ExeName);
        if (exe is not null && allowedNormalized.Contains(exe))
        {
            return true;
        }

        string? app = ExeNames.Normalize(foreground.AppName);
        return app is not null && allowedNormalized.Contains(app);
    }

    /// <summary>Tên exe đã chuẩn hóa của app foreground (ưu tiên tên file exe, rồi tên process).</summary>
    private static string? ForegroundNormalizedExe(ForegroundChangedPayload foreground)
    {
        return ExeNames.Normalize(foreground.ExeName) ?? ExeNames.Normalize(foreground.AppName);
    }

    /// <summary>
    /// Trạng thái giờ học tập trung tại thời điểm <paramref name="local"/>:
    /// có rule focus nào đang trong khung giờ không, và hợp danh sách app
    /// được phép của các rule đang hiệu lực đó.
    /// </summary>
    private static (bool Active, HashSet<string> Allowed) EvaluateFocusState(ParsedAppRules parsed, DateTime local)
    {
        var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        bool active = false;
        foreach (FocusRuleEntry focus in parsed.FocusRules)
        {
            if (AppRuleParser.MinutesUntilWindowEnd(focus.WindowsByWeekday, local) is not null)
            {
                active = true;
                foreach (AppRef app in focus.AllowedApps)
                {
                    allowed.Add(app.NormalizedExe);
                }
            }
        }

        return (active, allowed);
    }

    /// <summary>
    /// Trạng thái allowlist theo app tại thời điểm <paramref name="local"/>:
    /// có rule allowlist nào đang hiệu lực không (luôn áp dụng, hoặc theo
    /// giờ thì đang trong khung), và hợp danh sách app được phép của các
    /// rule đang hiệu lực đó. Mirror <see cref="EvaluateFocusState"/>.
    /// </summary>
    private static (bool Active, HashSet<string> Allowed) EvaluateAllowlistState(ParsedAppRules parsed, DateTime local)
    {
        var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        bool active = false;
        foreach (AppAllowlistEntry entry in parsed.AllowlistRules)
        {
            bool inWindow = entry.WindowsByWeekday is null
                || AppRuleParser.MinutesUntilWindowEnd(entry.WindowsByWeekday, local) is not null;
            if (inWindow)
            {
                active = true;
                foreach (AppRef app in entry.AllowedApps)
                {
                    allowed.Add(app.NormalizedExe);
                }
            }
        }

        return (active, allowed);
    }

    /// <summary>Chuẩn hóa một danh sách tên exe thành tập so khớp (bỏ tên rỗng/chỉ ".exe", không phân biệt hoa thường).</summary>
    private static HashSet<string> NormalizeExeSet(IReadOnlyList<string> names)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string name in names)
        {
            string? normalized = ExeNames.Normalize(name);
            if (normalized is not null)
            {
                set.Add(normalized);
            }
        }

        return set;
    }

    /// <summary>Ghi nhận đã cảnh báo cho một exe trong ngày. Trả về false nếu đã cảnh báo rồi (mỗi exe mỗi ngày một lần cho mỗi loại).</summary>
    private bool MarkAppWarned(string normalizedExe, string todayKey, string kind)
    {
        return _appWarnedKeys.Add(kind + "|" + normalizedExe + "|" + todayKey);
    }

    /// <summary>
    /// Đóng app theo quy tắc: chỉ khi tên exe không nằm trong denylist. Đóng
    /// xong (ít nhất một tiến trình) thì báo Tray hiện thông báo với
    /// MinutesLeft = 0 (WarningWindow ẩn dòng đếm ngược, chỉ hiện lý do) và
    /// ghi sự kiện app_blocked lên server (migration 10). <paramref
    /// name="kind"/> là loại thi hành ổn định cho lịch sử (block,
    /// block_by_time, time_limit, focus, allowlist, temp_block) — khác
    /// <paramref name="clause"/> là câu tiếng Việt hiển thị cho con.
    /// </summary>
    private async Task KillAppAsync(string? normalizedExe, int sessionId, string displayName, string clause, string kind, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(normalizedExe))
        {
            return;
        }

        if (IsDenylisted(normalizedExe))
        {
            // Từ chối đóng nhưng chống spam: cùng một exe chỉ ghi log tối đa
            // 1 lần/15 phút (giờ tập trung nhắc lại mỗi 15 giây).
            if (!_lastDenylistRefusalLogAt.TryGetValue(normalizedExe, out DateTimeOffset lastRefusal)
                || DateTimeOffset.UtcNow - lastRefusal >= TimeSpan.FromMinutes(15))
            {
                _lastDenylistRefusalLogAt[normalizedExe] = DateTimeOffset.UtcNow;
                _log.Warning("Từ chối đóng " + normalizedExe + " vì nằm trong danh sách bảo vệ, dù quy tắc yêu cầu (" + clause + ").");
            }

            return;
        }

        int killed = KillProcessesInSession(normalizedExe, sessionId);
        if (killed > 0)
        {
            _log.Info("Đã đóng " + normalizedExe + " vì " + clause + ".");
            // Sprint 5: thông báo đóng app chỉ gửi tới Tray của phiên đã
            // báo cáo — phiên nền không nhận.
            await _ipc.SendToSessionAsync(
                sessionId,
                IpcMessage.Create(IpcMessageTypes.Warning, new WarningPayload(0, "Đã đóng " + displayName + " vì " + clause + ".")),
                ct);

            // Lịch sử thi hành (migration 10): chỉ ghi khi đóng được thật
            // (killed > 0), và chống spam cùng exe + loại trong 60 giây —
            // lượt thi hành ngay và vòng tick có thể cùng thấy một tiến
            // trình còn sống trong vài giây đầu sau khi đóng. Chỉ ghi mốc
            // khi gửi thành công (cùng mẫu tamper event): gửi lỗi thì lần
            // đóng sau thử lại.
            string dedupeKey = kind + "|" + normalizedExe;
            if (!_lastAppBlockEventAt.TryGetValue(dedupeKey, out DateTimeOffset lastEvent)
                || DateTimeOffset.UtcNow - lastEvent >= TimeSpan.FromSeconds(60))
            {
                if (await PushEnforcementEventAsync(
                    "app_blocked",
                    JsonSerializer.SerializeToElement(new { exe = normalizedExe, kind }),
                    ct))
                {
                    _lastAppBlockEventAt[dedupeKey] = DateTimeOffset.UtcNow;
                }
            }
        }
    }

    /// <summary>
    /// Đóng các tiến trình cùng tên trong ĐÚNG session đã báo cáo: bỏ qua
    /// session 0, bỏ qua tiến trình trong denylist, mỗi tiến trình bắt lỗi
    /// riêng (best-effort). Chỉ đóng đúng tiến trình đó, không đóng cây
    /// tiến trình con. Trả về số tiến trình đã đóng.
    /// </summary>
    private int KillProcessesInSession(string normalizedExe, int sessionId)
    {
        Process[] processes;
        try
        {
            processes = Process.GetProcessesByName(normalizedExe);
        }
        catch (Exception ex)
        {
            _log.Error("Không liệt kê được tiến trình để đóng " + normalizedExe + ".", ex);
            return 0;
        }

        int killed = 0;
        foreach (Process process in processes)
        {
            try
            {
                using (process)
                {
                    if (process.SessionId == 0 || process.SessionId != sessionId)
                    {
                        continue;
                    }

                    if (IsDenylisted(process.ProcessName))
                    {
                        continue;
                    }

                    process.Kill();
                    killed++;
                }
            }
            catch (Exception ex)
            {
                _log.Warning("Không đóng được một tiến trình " + normalizedExe + " (" + ex.GetType().Name + ").");
            }
        }

        return killed;
    }

    /// <summary>Tên exe có nằm trong denylist bảo vệ (hệ thống + chính Agent) không.</summary>
    private static bool IsDenylisted(string? name)
    {
        string? normalized = ExeNames.Normalize(name);
        return normalized is not null && DenylistedExes.Contains(normalized);
    }

    /// <summary>
    /// Thi hành một lệnh từ phụ huynh. Trả về true khi lệnh đã thi hành (kể
    /// cả lệnh ghi đè đã hết hạn trước khi nhận — đã tiêu thụ, không còn gì
    /// để làm), false khi payload sai/không rõ loại hoặc lệnh chưa triển khai
    /// — nơi gọi ack kết quả về server theo giá trị này.
    /// </summary>
    private async Task<bool> ExecuteCommandAsync(Command command, ActiveContext active, CancellationToken ct)
    {
        // Sprint 5: lệnh thuộc về con nào — child_id của lệnh, rơi về con
        // đang active, rồi con mặc định. Vòng poll đã hoãn lệnh của con
        // chưa active nên tới đây targetChild luôn là con đang ngồi máy
        // (hoặc con mặc định khi chưa biết phiên nào).
        Guid? targetChild = command.ChildId ?? active.ChildId ?? active.DefaultChildId;
        _log.Info("Nhận command: " + command.Type + " (id " + command.Id + ", con " + (targetChild?.ToString("D") ?? "(chưa rõ)") + ").");
        switch (command.Type)
        {
            case CommandTypes.LockNow:
                // Lệnh khóa cũ gửi lại (ack rớt) không được đặt lại cờ khóa
                // sau khi lệnh mở mới hơn đã xóa — kiểm tra TRƯỚC khi đặt
                // cờ, kể cả trước chốt chặn ghi đè bên dưới. Bỏ qua thì vẫn
                // trả true để ack done và rời khỏi hàng pending (xem
                // IsStaleForcedLockCommandAsync).
                if (await IsStaleForcedLockCommandAsync(command, targetChild, active.DefaultChildId, ct))
                {
                    return true;
                }

                // Lưu bền vững: khóa cưỡng chế sống sót qua khởi động lại
                // Service, chỉ hết khi có lệnh unlock. Sprint 5: cờ khóa
                // theo con (khóa legacy không gắn con thuộc về con mặc định).
                await _outbox.SetForcedLockAsync(targetChild, active.DefaultChildId, true, ct);
                await _outbox.RaiseForcedLockCommandFloorAsync(targetChild, command.CreatedAt, ct);

                // HÀNH ĐỘNG SAU THẮNG HÀNH ĐỘNG TRƯỚC (sửa 17/11/2026 theo
                // yêu cầu test máy thật): đang "mở khóa ngay" mà phụ huynh
                // bấm "khóa máy ngay" thì máy phải khóa — ghi đè mở khóa
                // còn hạn trước đây thắng cả khóa cưỡng chế nên lệnh khóa
                // bị nuốt. Lệnh khóa mới nhất hủy ghi đè MỞ KHÓA đang hiệu
                // lực (chỉ ghi đè mở khóa — ghi đè cộng giờ/chặn app/
                // domain không xung đột với lệnh khóa nên giữ nguyên).
                // Sprint 5: chỉ xét ghi đè của ĐÚNG con bị khóa — ghi đè
                // mở khóa của con khác (hàng single-override) không bị
                // hủy, để con đó quay lại vẫn còn mở khóa của mình.
                TemporaryOverride? conflictingOverride = await _outbox.GetActiveOverrideForChildAsync(targetChild, active.DefaultChildId, ct);
                if (conflictingOverride is not null && conflictingOverride.ExpiresAt > DateTimeOffset.UtcNow
                    && conflictingOverride.Action == OverrideActions.Unlock)
                {
                    // Lệnh khóa CŨ gửi lại (ack rớt) không được hủy ghi đè
                    // mở khóa MỚI HƠN đã áp sau nó: so mốc giờ server của
                    // lệnh đã tạo ra ghi đè với giờ server của lệnh khóa.
                    // Bằng mốc thì vẫn hủy (cùng quy tắc hòa mốc như lệnh
                    // ghi đè — xem OverrideCommandOrder.IsStale).
                    if (conflictingOverride.CommandCreatedAt is not null
                        && conflictingOverride.CommandCreatedAt.Value > command.CreatedAt)
                    {
                        _log.Warning(
                            "Bỏ qua phần hủy ghi đè của lệnh khóa cũ (tạo lúc " + command.CreatedAt.ToString("o")
                            + "): ghi đè mở khóa mới hơn (tạo lúc " + conflictingOverride.CommandCreatedAt.Value.ToString("o") + ") vẫn giữ nguyên.");
                        // Dừng ở đây: không gửi cảnh báo/khóa xuống Tray và
                        // không đặt hẹn khóa — ghi đè mở mới hơn đang thắng
                        // trong RuleEngine nên vòng kiểm tra rules sẽ gửi
                        // Unlock (nếu màn hình khóa đang hiện) từ trạng thái
                        // bền vững. Gửi Lock Immediate ở đây chỉ làm màn hình
                        // khóa hiện thoáng qua rồi tự mở lại ở tick sau.
                        return true;
                    }
                    else
                    {
                        await _outbox.ClearOverrideForChildAsync(targetChild, active.DefaultChildId, ct);
                        // Nâng mốc sàn lên giờ của lệnh khóa để lệnh mở
                        // khóa cũ gửi lại sau không hồi sinh ghi đè vừa bị
                        // hủy (hàng đã xóa nên mốc trong hàng cũng mất).
                        // Sprint 5: mốc sàn theo con bị khóa.
                        await _outbox.RaiseOverrideCommandFloorAsync(targetChild, command.CreatedAt, ct);
                        _log.Info("Lệnh khóa mới hủy ghi đè mở khóa đang hiệu lực (hành động sau thắng hành động trước).");
                    }
                }

                // Độ trễ khóa (Dashboard cho chọn 0–5 phút): delay > 0 và
                // chưa khóa thì CHƯA gửi lệnh khóa — đặt hẹn giờ, gửi cảnh
                // báo ngay (cửa sổ nhỏ, con vẫn làm việc/lưu bài), vòng
                // kiểm tra rules sẽ gửi lệnh khóa khi tới hẹn. Delay = 0
                // hoặc đã khóa rồi thì khóa ngay như trước.
                int delayMinutes = 0;
                if (TryGetPayloadInt32(command.Payload, "delay_minutes", out int parsedDelay))
                {
                    delayMinutes = Math.Clamp(parsedDelay, 0, 5);
                }

                if (delayMinutes > 0 && !_lockSent)
                {
                    _pendingLockAt = DateTimeOffset.UtcNow.AddMinutes(delayMinutes);
                    _lastPendingWarnMinutes = 0;
                    _log.Info("Khóa có độ trễ: sẽ khóa sau " + delayMinutes + " phút. Gửi cảnh báo trước.");
                    int warned = await SendToTargetSessionAsync(
                        IpcMessage.Create(IpcMessageTypes.Warning, new WarningPayload(delayMinutes, "Phụ huynh sẽ khóa máy. Hãy lưu bài làm của bạn.")), active, ct);
                    if (warned > 0)
                    {
                        // Chỉ ghi nhận đã cảnh báo khi thật sự giao được:
                        // gửi rớt (chưa Tray nào nối) thì tick sau gửi lại
                        // ngay thay vì chờ tới mốc phút tiếp theo.
                        _lastPendingWarnMinutes = delayMinutes;
                    }

                    return true;
                }

                _pendingLockAt = null;
                // Chỉ coi là "đã gửi" khi thật sự ghi tới ≥1 Tray (xem ghi
                // chú ở vòng kiểm tra rules): gửi thất bại thì cờ vẫn false
                // và vòng kiểm tra sau gửi lại từ trạng thái khóa bền vững.
                // Khóa Immediate (đợt sửa 18/11/2026): phụ huynh bấm "Khóa
                // ngay" (độ trễ 0) thì máy khóa luôn — Tray phải hiện trạng
                // thái đã khóa, KHÔNG đếm ngược 60 giây (như lệnh khóa
                // đồng bộ khi hello). Đếm ngược chỉ dành cho khóa do hết
                // giờ theo rule (con cần thời gian lưu bài); đường khóa có
                // độ trễ đã cho thời gian đó qua cửa sổ cảnh báo nên khi
                // hết trễ cũng khóa Immediate ở vòng kiểm tra rules.
                int lockSent = await SendToTargetSessionAsync(
                    IpcMessage.Create(IpcMessageTypes.Lock, new LockPayload("Phụ huynh đã khóa máy.", Immediate: true)), active, ct);
                _lockSent = lockSent > 0;
                return true;

            case CommandTypes.Unlock:
                // Lệnh mở cũ gửi lại (ack rớt) không được xóa cờ khóa do
                // lệnh khóa mới hơn đã đặt. Bỏ qua thì vẫn trả true để ack
                // done và rời khỏi hàng pending (xem
                // IsStaleForcedLockCommandAsync).
                if (await IsStaleForcedLockCommandAsync(command, targetChild, active.DefaultChildId, ct))
                {
                    return true;
                }

                await _outbox.SetForcedLockAsync(targetChild, active.DefaultChildId, false, ct);
                await _outbox.RaiseForcedLockCommandFloorAsync(targetChild, command.CreatedAt, ct);
                _pendingLockAt = null;
                // Chỉ xóa cờ khi gửi thành công tới ≥1 Tray (review batch #5):
                // gửi rớt thì tick sau gửi lại từ quyết định Allowed.
                int unlockSent = await SendToTargetSessionAsync(IpcMessage.Create(IpcMessageTypes.Unlock, new { }), active, ct);
                if (unlockSent > 0)
                {
                    _lockSent = false;
                }

                return true;

            case CommandTypes.RefreshRules:
                // Sprint 5: làm mới rules của con đang active (fallback
                // RPC cũ chỉ cho con mặc định — xem RefreshRulesForChildAsync).
                if (!await RefreshRulesForChildAsync(active.ChildId, active.DefaultChildId, ct))
                {
                    _log.Warning("Làm mới rules thất bại (mất mạng hoặc chưa pairing). Giữ cache cũ.");
                    return false;
                }

                _log.Info("Đã làm mới cache rules theo lệnh phụ huynh.");
                return true;

            case CommandTypes.TemporaryOverride:
                return await ExecuteTemporaryOverrideAsync(command, active, ct);

            case CommandTypes.Update:
                // TODO Sprint 2+: cập nhật Agent có kiểm tra hash + HTTPS (docs/03).
                _log.Warning("Command update chưa được triển khai.");
                return false;

            default:
                _log.Warning("Command không rõ loại, bỏ qua: " + command.Type);
                return false;
        }
    }

    /// <summary>
    /// Lệnh ghi đè này có cũ hơn trạng thái đang hiệu lực không. Ack của một
    /// lệnh có thể rớt (lỗi mạng sau khi thi hành, Service chết giữa chừng)
    /// nên lệnh vẫn còn <c>pending</c> và được poll trả lại ở chu kỳ sau —
    /// sau khi một lệnh mới hơn đã được áp và ack xong. So sánh dùng
    /// <c>created_at</c> do server sinh ở cả hai phía (lệnh tới và mốc sàn
    /// trong hàng ghi đè/watermark bền vững) nên không bị ảnh hưởng nếu
    /// đồng hồ máy con bị chỉnh. Lệnh thiếu mốc giờ (không xảy ra qua RPC
    /// thật — cột <c>created_at</c> NOT NULL) thì không kết luận là cũ, áp
    /// như trước. Cũ hơn thì ghi log cảnh báo rõ ràng — không bỏ qua im lặng.
    /// </summary>
    private async Task<bool> IsStaleOverrideCommandAsync(Command command, string action, Guid? targetChild, Guid? defaultChildId, CancellationToken ct)
    {
        if (command.CreatedAt == default)
        {
            return false;
        }

        // Sprint 5: so mốc với ghi đè + watermark của ĐÚNG con bị lệnh
        // nhắm tới (ghi đè của con khác không làm lệnh này cũ).
        TemporaryOverride? current = await _outbox.GetActiveOverrideForChildAsync(targetChild, defaultChildId, ct);
        DateTimeOffset? watermark = await _outbox.GetOverrideCommandFloorAsync(targetChild, defaultChildId, ct);
        DateTimeOffset? floor = OverrideCommandOrder.Floor(current?.CommandCreatedAt, watermark);
        if (!OverrideCommandOrder.IsStale(command.CreatedAt, floor))
        {
            return false;
        }

        _log.Warning(
            "Bỏ qua lệnh ghi đè cũ (action " + action + ", tạo lúc " + command.CreatedAt.ToString("o")
            + ", id " + command.Id + "): đã có lệnh mới hơn (mốc " + floor!.Value.ToString("o") + ").");
        return true;
    }

    /// <summary>
    /// Lệnh khóa/mở (lock_now/unlock) này có cũ hơn lệnh khóa/mở mới nhất đã
    /// áp không. Cùng lớp vấn đề như lệnh ghi đè: ack rớt khiến lệnh cũ vẫn
    /// còn <c>pending</c> và được poll trả lại sau khi lệnh mới hơn đã áp —
    /// không có mốc, lệnh khóa cũ sẽ đặt lại cờ khóa cưỡng chế sau khi lệnh
    /// mở mới hơn đã xóa, và ngược lại. Mốc là watermark bền vững riêng
    /// (<c>ForcedLockCommandFloor</c>), tách biệt với mốc sàn lệnh ghi đè:
    /// ghi đè mở khóa tạm thời không xóa cờ khóa cưỡng chế nên không được
    /// nâng mốc này — khóa cưỡng chế có hiệu lực trở lại khi ghi đè hết hạn
    /// là ngữ nghĩa đã chốt (xem <see cref="RuleEngine"/>). So sánh dùng
    /// <c>created_at</c> do server sinh nên không bị ảnh hưởng nếu đồng hồ
    /// máy con bị chỉnh; hòa mốc thì vẫn áp (cùng quy tắc như lệnh ghi đè —
    /// xem <see cref="OverrideCommandOrder.IsStale"/>). Lệnh thiếu mốc giờ
    /// (không xảy ra qua RPC thật) thì không kết luận là cũ, áp như trước.
    /// Cũ hơn thì ghi log cảnh báo rõ ràng — không bỏ qua im lặng.
    /// </summary>
    private async Task<bool> IsStaleForcedLockCommandAsync(Command command, Guid? targetChild, Guid? defaultChildId, CancellationToken ct)
    {
        if (command.CreatedAt == default)
        {
            return false;
        }

        // Sprint 5: watermark khóa cưỡng chế tách theo con — lệnh khóa/mở
        // cũ của con A không bị chặn bởi lệnh mới hơn của con B (và ngược lại).
        DateTimeOffset? floor = await _outbox.GetForcedLockCommandFloorAsync(targetChild, defaultChildId, ct);
        if (!OverrideCommandOrder.IsStale(command.CreatedAt, floor))
        {
            return false;
        }

        _log.Warning(
            "Bỏ qua lệnh khóa/mở cũ (loại " + command.Type + ", tạo lúc " + command.CreatedAt.ToString("o")
            + ", id " + command.Id + "): đã có lệnh khóa/mở mới hơn (mốc " + floor!.Value.ToString("o") + ").");
        return true;
    }

    /// <summary>
    /// Thi hành lệnh ghi đè tạm thời (payload: action, minutes, expires_at;
    /// ghi đè domain thêm domains, ghi đè app thêm apps). Ghi đè được lưu
    /// xuống SQLite để sống sót qua khởi động lại Service; lệnh mới nhất
    /// thay thế lệnh trước đó CỦA CÙNG CON (một hàng active_override theo
    /// con — child_key; ghi đè app mới của con này sẽ thay ghi đè giờ
    /// giấc/domain đang có của cùng con đó, không chạm ghi đè của con khác).
    /// Payload thiếu/sai thì bỏ qua và trả về false — không đoán ý phụ huynh.
    /// Lệnh cũ hơn trạng thái đang hiệu lực (ack rớt nên poll trả lại sau
    /// khi lệnh mới hơn đã áp) thì bị bỏ qua nhưng vẫn trả về true để được
    /// ack done và rời khỏi hàng pending — xem
    /// <see cref="IsStaleOverrideCommandAsync"/>.
    /// Ghi đè domain (allow_domain/block_domain) CHỈ ảnh hưởng file
    /// domain_rules.json (xuất bản lại ngay), không mở/khóa máy, không gửi
    /// IPC xuống Tray; RuleEngine cũng bỏ qua chúng (xem chốt chặn ở đó).
    /// Ghi đè app (block_app/allow_app) CHỈ ảnh hưởng thi hành theo app
    /// trong vòng kiểm tra rules, cũng không mở/khóa máy và không gửi IPC.
    /// </summary>
    private async Task<bool> ExecuteTemporaryOverrideAsync(Command command, ActiveContext active, CancellationToken ct)
    {
        // Sprint 5: ghi đè thuộc về con nào — child_id của lệnh, rơi về con
        // đang active, rồi con mặc định (cùng quy tắc như ExecuteCommandAsync).
        // Store giữ một hàng active_override theo con (child_key) nên ghi đè
        // mới chỉ thay thế ghi đè cũ của cùng con — ghi đè của con khác
        // không bị chạm (sửa MAJOR-1).
        Guid? targetChild = command.ChildId ?? active.ChildId ?? active.DefaultChildId;
        JsonElement payload = command.Payload;
        string? action = TryGetPayloadString(payload, "action");

        if (action == OverrideActions.Cancel)
        {
            // Lệnh hủy cũ không được xóa ghi đè mới hơn đã áp sau nó.
            if (await IsStaleOverrideCommandAsync(command, OverrideActions.Cancel, targetChild, active.DefaultChildId, ct))
            {
                return true;
            }

            // Chỉ xóa khi hàng ghi đè hiện tại thuộc về ĐÚNG con bị hủy —
            // hủy ghi đè của con A không được xóa ghi đè của con B.
            if (await _outbox.GetActiveOverrideForChildAsync(targetChild, active.DefaultChildId, ct) is not null)
            {
                await _outbox.ClearOverrideForChildAsync(targetChild, active.DefaultChildId, ct);
            }

            // Nâng mốc sàn: hàng đã xóa nên mốc trong hàng cũng mất — không
            // nâng thì lệnh ghi đè cũ gửi lại sau sẽ hồi sinh trạng thái
            // vừa bị hủy.
            await _outbox.RaiseOverrideCommandFloorAsync(targetChild, command.CreatedAt, ct);
            // KHÔNG xóa _lockSent ở đây (review batch #5): nếu màn hình khóa
            // đang hiện mà cờ bị xóa trước, tick sau quyết định Allowed nhưng
            // nhánh Allowed thấy cờ đã false nên không gửi Unlock và màn hình
            // khóa ở lại tới khi đếm ngược khóa phiên. Để tick sau tự gửi
            // Unlock qua nhánh Allowed rồi mới xóa cờ.
            _log.Info("Đã hủy ghi đè tạm thời theo lệnh phụ huynh.");
            await _publisher.PublishAsync(ct, targetChild, active.DefaultChildId);
            return true;
        }

        bool isDomainAction = action == OverrideActions.AllowDomain || action == OverrideActions.BlockDomain;
        bool isAppAction = action == OverrideActions.BlockApp || action == OverrideActions.AllowApp;

        if (action != OverrideActions.BonusMinutes
            && action != OverrideActions.Lock
            && action != OverrideActions.Unlock
            && !isDomainAction
            && !isAppAction)
        {
            _log.Warning("Ghi đè tạm thời không rõ action, bỏ qua: " + (action ?? "(trống)"));
            return false;
        }

        if (!TryGetPayloadInt32(payload, "minutes", out int minutes) || minutes <= 0)
        {
            _log.Warning("Ghi đè tạm thời thiếu minutes hợp lệ, bỏ qua.");
            return false;
        }

        if (!TryGetPayloadDateTimeOffset(payload, "expires_at", out DateTimeOffset expiresAt))
        {
            _log.Warning("Ghi đè tạm thời thiếu expires_at hợp lệ, bỏ qua.");
            return false;
        }

        IReadOnlyList<string>? domains = null;
        if (isDomainAction)
        {
            domains = TryGetPayloadStringArray(payload, "domains");
            if (domains is null || domains.Count == 0)
            {
                _log.Warning("Ghi đè domain thiếu mảng domains, bỏ qua.");
                return false;
            }
        }

        IReadOnlyList<string>? apps = null;
        if (isAppAction)
        {
            apps = TryGetPayloadStringArray(payload, "apps");
            if (apps is null || apps.Count == 0 || !apps.Any(app => ExeNames.Normalize(app) is not null))
            {
                _log.Warning("Ghi đè app thiếu mảng apps hợp lệ, bỏ qua.");
                return false;
            }
        }

        if (expiresAt <= DateTimeOffset.UtcNow)
        {
            _log.Info("Ghi đè tạm thời đã hết hạn trước khi nhận, bỏ qua.");
            return true;
        }

        // Lệnh cũ hơn trạng thái đang hiệu lực thì bỏ qua — kiểm tra SAU
        // khi payload đã hợp lệ và còn hạn, để lệnh sai payload vẫn ack
        // failed như trước (không đổi ngữ nghĩa lỗi).
        if (await IsStaleOverrideCommandAsync(command, action!, targetChild, active.DefaultChildId, ct))
        {
            return true;
        }

        await _outbox.SaveOverrideAsync(new TemporaryOverride(action!, minutes, expiresAt, domains, apps, command.CreatedAt, targetChild), active.DefaultChildId, ct);
        await _outbox.RaiseOverrideCommandFloorAsync(targetChild, command.CreatedAt, ct);
        if (isDomainAction)
        {
            _log.Info("Đã lưu ghi đè domain: " + action + " " + domains!.Count + " domain, " + minutes + " phút, hết hạn " + expiresAt.ToString("o") + ".");
        }
        else if (isAppAction)
        {
            _log.Info("Đã lưu ghi đè app: " + action + " " + apps!.Count + " app, " + minutes + " phút, hết hạn " + expiresAt.ToString("o") + ".");
        }
        else
        {
            _log.Info("Đã lưu ghi đè tạm thời: " + action + " " + minutes + " phút, hết hạn " + expiresAt.ToString("o") + ".");
        }

        // Xuất bản lại file domain ngay: ghi đè domain có tác dụng trong vòng
        // 1 phút (chu kỳ đọc của extension), không chờ đồng bộ rules.
        // Sprint 5: xuất bản theo con bị lệnh nhắm tới (= con đang active,
        // vì vòng poll đã hoãn lệnh của con khác).
        await _publisher.PublishAsync(ct, targetChild, active.DefaultChildId);

        // Tác dụng ngay với ghi đè giờ giấc, không chờ tới lần kiểm tra rules
        // tiếp theo (15 giây). Ghi đè domain/app không chạm tới khóa/mở máy:
        // domain có tác dụng qua file đã xuất bản ở trên, app qua vòng kiểm
        // tra rules tiếp theo. Nhánh dưới đây chỉ khớp action Lock/Unlock.
        if (!isDomainAction && action == OverrideActions.Lock)
        {
            // Ghi đè khóa có tác dụng ngay, hủy luôn lệnh khóa có độ trễ
            // đang chờ (nếu có) để tick sau không gửi cảnh báo thừa sau
            // lưng màn hình khóa.
            _pendingLockAt = null;
            // Chỉ coi là "đã gửi" khi thật sự ghi tới ≥1 Tray (xem ghi chú
            // ở vòng kiểm tra rules): gửi thất bại thì vòng kiểm tra sau
            // gửi lại từ ghi đè đang hiệu lực.
            // Khóa tạm thời do phụ huynh bấm: khóa ngay, không đếm ngược
            // (giống lock_now độ trễ 0 — đếm ngược chỉ dành cho khóa khi
            // hết thời gian theo quy tắc).
            int lockSent = await SendToTargetSessionAsync(
                IpcMessage.Create(IpcMessageTypes.Lock, new LockPayload("Phụ huynh đã khóa máy tạm thời.", Immediate: true)), active, ct);
            _lockSent = lockSent > 0;
        }
        else if (!isDomainAction && action == OverrideActions.Unlock)
        {
            // Chỉ gửi IPC Unlock NGAY khi quyết định thi hành HIỆN TẠI
            // (đánh giá với ghi đè mới vừa áp, đúng đường của vòng kiểm tra
            // rules) là được mở. Đang trong giờ nghỉ bắt buộc — hoặc bất kỳ
            // thi hành khóa nào khác không phải khóa theo giờ giấc — thì BỎ
            // QUA lần gửi này: vòng kiểm tra giữ màn hình khóa, và khi hết
            // giờ nghỉ thì vòng kiểm tra tự gửi Unlock từ ghi đè đang còn
            // hiệu lực. Gửi Unlock mù ở đây từng gây nháy màn hình khóa:
            // mở ra rồi ≤15 giây sau vòng kiểm tra khóa lại (MINOR review
            // 18/11/2026). Bỏ qua thì cũng không xóa _lockSent: cờ vẫn đúng
            // vì màn hình khóa vẫn đang hiện.
            RuleDecisionKind currentKind;
            try
            {
                IReadOnlyList<Rule> currentRules = await _outbox.GetCachedRulesAsync(ct);
                // Sprint 5: đánh giá trên giờ dùng + ghi đè + cờ khóa của
                // ĐÚNG con bị lệnh nhắm tới (phạm vi mẫu theo SID của con).
                // Lệnh chỉ áp khi con đó đang active (vòng poll đã hoãn lệnh
                // của con khác) nên dùng luôn Scope của context — gồm SID
                // phiên console (sửa MAJOR-2); lệnh nhắm con khác (không xảy
                // ra qua vòng poll) thì tính phạm vi riêng, không kèm SID
                // phiên.
                UsageScope targetScope = targetChild == active.ChildId
                    ? active.Scope
                    : ActiveChildResolver.ScopeForChild(targetChild, active.DefaultChildId, active.Links);
                TimeSpan usedToday = await _outbox.GetUsageTodayForChildAsync(targetScope, ct);
                TemporaryOverride? currentOverride = await _outbox.GetActiveOverrideForChildAsync(targetChild, active.DefaultChildId, ct);
                bool forcedLock = await _outbox.GetForcedLockAsync(targetChild, active.DefaultChildId, ct);
                (RuleDecision currentDecision, _) = await EvaluateLockDecisionAsync(
                    currentRules, usedToday, currentOverride, forcedLock,
                    GetParsedAppRules(currentRules), DateTimeOffset.Now, targetScope, ct);
                currentKind = currentDecision.Kind;
                if (currentKind != RuleDecisionKind.Allowed)
                {
                    _log.Info("Ghi đè mở khóa đã lưu nhưng máy vẫn bị khóa (" + currentDecision.Reason + ") — bỏ qua IPC Unlock, để vòng kiểm tra rules thi hành.");
                }
            }
            catch (Exception ex)
            {
                // Đánh giá lỗi thì coi như "không được mở": bỏ qua IPC, vòng
                // kiểm tra thi hành từ ghi đè đã lưu. Không ném ra ngoài để
                // lệnh vẫn ack thành công đúng với việc ghi đè đã lưu.
                _log.Warning("Đánh giá trạng thái khóa sau ghi đè mở khóa lỗi: " + ex.Message + " — bỏ qua IPC Unlock, để vòng kiểm tra rules thi hành.");
                currentKind = RuleDecisionKind.Lock;
            }
            if (currentKind == RuleDecisionKind.Allowed)
            {
                // Chỉ xóa cờ khi gửi thành công tới ≥1 Tray (review batch #5):
                // gửi rớt thì tick sau gửi lại từ ghi đè đang hiệu lực.
                int unlockSent = await SendToTargetSessionAsync(IpcMessage.Create(IpcMessageTypes.Unlock, new { }), active, ct);
                if (unlockSent > 0)
                {
                    _lockSent = false;
                }
            }
        }

        return true;
    }

    private static string? TryGetPayloadString(JsonElement payload, string property)
    {
        return payload.ValueKind == JsonValueKind.Object
            && payload.TryGetProperty(property, out JsonElement element)
            && element.ValueKind == JsonValueKind.String
            ? element.GetString()
            : null;
    }

    private static bool TryGetPayloadInt32(JsonElement payload, string property, out int value)
    {
        value = 0;
        return payload.ValueKind == JsonValueKind.Object
            && payload.TryGetProperty(property, out JsonElement element)
            && element.ValueKind == JsonValueKind.Number
            && element.TryGetInt32(out value);
    }

    private static bool TryGetPayloadDateTimeOffset(JsonElement payload, string property, out DateTimeOffset value)
    {
        value = default;
        return TryGetPayloadString(payload, property) is string text
            && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out value);
    }

    /// <summary>
    /// Đọc một mảng chuỗi trong payload (VD: domains của ghi đè domain,
    /// apps của ghi đè app). Trả về null khi thuộc tính vắng mặt hoặc không
    /// phải mảng; phần tử không phải chuỗi thì bỏ qua. Chuẩn hóa/kiểm tra
    /// domain do DomainRulesPublisher thực hiện lúc xuất bản; chuẩn hóa exe
    /// do ExeNames thực hiện lúc thi hành.
    /// </summary>
    private static IReadOnlyList<string>? TryGetPayloadStringArray(JsonElement payload, string property)
    {
        if (payload.ValueKind != JsonValueKind.Object
            || !payload.TryGetProperty(property, out JsonElement element)
            || element.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var values = new List<string>();
        foreach (JsonElement item in element.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String && item.GetString() is string text)
            {
                values.Add(text);
            }
        }

        return values;
    }

    /// <summary>
    /// Suy ra lý do + rule gây ra quyết định của lần kiểm tra này, từ chính
    /// kết quả đánh giá của <see cref="RuleEngine"/> (không đánh giá lại):
    /// nghỉ bắt buộc thắng trước (rule app mode forced_break), rồi khóa
    /// cưỡng chế / ghi đè khóa (không gắn rule nào), rồi ánh xạ chuỗi lý do
    /// ổn định của engine sang loại rule (giờ ngủ / khung giờ / giới hạn
    /// ngày). Các rule cùng loại đang bật đều được liệt kê vì engine đánh
    /// giá hợp (union) — đây là xấp xỉ trung thực, không phải rule duy nhất.
    /// Quyết định cho phép (không cảnh báo) thì reasons/ruleIds rỗng.
    /// </summary>
    private static (List<string> Reasons, List<string> RuleIds) DeriveEnforcementReasons(
        RuleDecision decision,
        IReadOnlyList<Rule> rules,
        bool breakActive,
        bool forcedLock,
        TemporaryOverride? activeOverride,
        DateTimeOffset now)
    {
        var reasons = new List<string>();
        var ruleIds = new List<string>();

        if (breakActive)
        {
            reasons.Add(RuleTypes.App);
            ruleIds.AddRange(ForcedBreakRuleIds(rules));
            return (reasons, ruleIds);
        }

        if (forcedLock)
        {
            return (reasons, ruleIds);
        }

        if (activeOverride is not null && activeOverride.ExpiresAt > now && activeOverride.Action == OverrideActions.Lock)
        {
            return (reasons, ruleIds);
        }

        string? type = null;
        if (decision.Reason.Contains("giờ ngủ", StringComparison.Ordinal))
        {
            type = RuleTypes.Bedtime;
        }
        else if (decision.Reason.Contains("khung giờ", StringComparison.Ordinal))
        {
            type = RuleTypes.TimeWindow;
        }
        else if (decision.Reason.Contains("thời gian dùng máy", StringComparison.Ordinal))
        {
            type = RuleTypes.DailyLimit;
        }

        if (type is null)
        {
            return (reasons, ruleIds);
        }

        reasons.Add(type);
        foreach (Rule rule in rules)
        {
            if (rule.Enabled && rule.Type == type)
            {
                ruleIds.Add(rule.Id.ToString());
            }
        }

        return (reasons, ruleIds);
    }

    /// <summary>Id các rule nghỉ bắt buộc đang bật (type app, mode forced_break).</summary>
    private static List<string> ForcedBreakRuleIds(IReadOnlyList<Rule> rules)
    {
        var ruleIds = new List<string>();
        foreach (Rule rule in rules)
        {
            if (rule.Enabled && rule.Type == RuleTypes.App && GetRuleMode(rule) == "forced_break")
            {
                ruleIds.Add(rule.Id.ToString());
            }
        }

        return ruleIds;
    }

    /// <summary>
    /// Ai/cái gì đang khóa máy: null khi không khóa; "break" (nghỉ bắt buộc)
    /// thắng "forced" (khóa cưỡng chế), rồi "override" (ghi đè khóa), còn
    /// lại là "rule" (bedtime/khung giờ/giới hạn ngày). Cùng thứ tự ưu tiên
    /// với <see cref="RuleEngine.Evaluate"/> + nhánh break trong vòng kiểm tra.
    /// </summary>
    private static string? DeriveLockedBy(
        RuleDecision decision,
        bool breakActive,
        bool forcedLock,
        TemporaryOverride? activeOverride,
        DateTimeOffset now)
    {
        if (decision.Kind != RuleDecisionKind.Lock)
        {
            return null;
        }

        if (breakActive)
        {
            return "break";
        }

        if (forcedLock)
        {
            return "forced";
        }

        if (activeOverride is not null && activeOverride.ExpiresAt > now && activeOverride.Action == OverrideActions.Lock)
        {
            return "override";
        }

        return "rule";
    }

    /// <summary>Đọc trường <c>mode</c> trong config rule. Null khi thiếu/không phải chuỗi.</summary>
    private static string? GetRuleMode(Rule rule)
    {
        return rule.Config.ValueKind == JsonValueKind.Object
            && rule.Config.TryGetProperty("mode", out JsonElement mode)
            && mode.ValueKind == JsonValueKind.String
            ? mode.GetString()
            : null;
    }

    /// <summary>Có rule website nào đang bật không (publisher xuất bản từ cùng cache nên rule bật là đã/ sắp được xuất bản).</summary>
    private static bool HasEnabledWebsiteRule(IReadOnlyList<Rule> rules)
    {
        foreach (Rule rule in rules)
        {
            if (rule.Enabled && rule.Type == RuleTypes.Website)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Dựng snapshot trạng thái thi hành (hợp đồng LITERAL với Dashboard,
    /// xem migration 6 + docs/02 mục 4.8). Trả về (JSON để gửi, chữ ký so
    /// sánh KHÔNG gồm thời điểm — nếu gồm "at" thì snapshot đổi mỗi 15 giây
    /// và throttle đổi-trạng-thái trở nên vô nghĩa). appBlocks cắt tối đa
    /// 20 exe để snapshot luôn dưới trần 4KB của RPC.
    /// </summary>
    private static (string Json, string Signature) BuildEnforcementSnapshot(
        RuleDecision decision,
        string? lockedBy,
        List<string> reasons,
        List<string> ruleIds,
        List<string> appBlocks,
        bool domainRulesActive,
        bool focusActive,
        DateTimeOffset now)
    {
        string decisionText = decision.Kind switch
        {
            RuleDecisionKind.Warn => "warn",
            RuleDecisionKind.Lock => "lock",
            _ => "allow",
        };
        List<string> cappedBlocks = appBlocks.Take(20).ToList();
        var payload = new
        {
            v = 1,
            at = now.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture),
            decision = decisionText,
            lockedBy,
            reasons,
            ruleIds,
            appBlocks = cappedBlocks,
            domainRulesActive,
            focusActive,
        };
        string json = JsonSerializer.Serialize(payload);
        string signature = decisionText + "|" + (lockedBy ?? "-")
            + "|" + string.Join(",", reasons)
            + "|" + string.Join(",", ruleIds)
            + "|" + string.Join(",", cappedBlocks)
            + "|" + domainRulesActive + "|" + focusActive;
        return (json, signature);
    }

    /// <summary>
    /// Gửi snapshot enforcement đang chờ lên server nếu nội dung (trừ thời
    /// điểm) đã đổi so với lần gửi trước. Không chặn 5 phút nữa (đợt sửa
    /// 17/11/2026): gọi từ vòng kiểm tra rules (mỗi 15 giây) và từ chu kỳ
    /// heartbeat (mỗi 60 giây, sau khi heartbeat thành công) — chữ ký đổi
    /// mới gửi nên không gửi thừa dù gọi từ hai vòng; hai vòng cùng thấy
    /// chữ ký mới thì cùng lắm gửi trùng một nội dung giống hệt (RPC ghi
    /// đè, vô hại). Gửi lỗi thì giữ nguyên chữ ký đã gửi để lần sau thử
    /// lại với snapshot mới nhất.
    /// </summary>
    private async Task MaybeReportEnforcementAsync(CancellationToken ct)
    {
        string? json;
        string? signature;
        lock (_enforcementGate)
        {
            json = _pendingEnforcementJson;
            signature = _pendingEnforcementSignature;
            if (json is null || signature is null || signature == _lastSentEnforcementSignature)
            {
                return;
            }
        }

        JsonElement payload;
        try
        {
            payload = JsonDocument.Parse(json).RootElement.Clone();
        }
        catch (JsonException ex)
        {
            _log.Error("Snapshot enforcement hỏng, bỏ qua lần gửi này.", ex);
            return;
        }

        if (await _api.ReportEnforcementAsync(payload, ct))
        {
            lock (_enforcementGate)
            {
                _lastSentEnforcementSignature = signature;
            }
        }
    }

    /// <summary>
    /// Ghi log chẩn đoán quyết định rules: khi quyết định/lý do/rule/ghi đè
    /// đổi, hoặc tối đa 1 lần/15 phút khi không đổi. Số phút đã dùng chỉ là
    /// nội dung log, không nằm trong chữ ký đổi (nếu không log sẽ lặp mỗi
    /// phút khi con đang dùng máy). Không bao giờ log token/hash.
    /// </summary>
    private void LogRuleDecisionIfDue(
        RuleDecision decision,
        List<string> ruleIds,
        TimeSpan usedToday,
        TemporaryOverride? activeOverride)
    {
        string overrideState = activeOverride is null ? "(không có)" : activeOverride.Action;
        string signature = decision.Kind + "|" + decision.Reason + "|" + string.Join(",", ruleIds) + "|" + overrideState;
        DateTimeOffset nowUtc = DateTimeOffset.UtcNow;
        bool due = signature != _lastDecisionLogSignature || nowUtc - _lastDecisionLogAt >= TimeSpan.FromMinutes(15);
        if (!due)
        {
            return;
        }

        _lastDecisionLogSignature = signature;
        _lastDecisionLogAt = nowUtc;
        string idsText = ruleIds.Count == 0
            ? "(không có)"
            : string.Join(", ", ruleIds.Take(3)) + (ruleIds.Count > 3 ? " (+" + (ruleIds.Count - 3) + " rule nữa)" : "");
        _log.Info("Quyết định rules: " + decision.Kind + " (" + decision.Reason + "), rule đang áp: " + idsText
            + ", đã dùng " + (int)usedToday.TotalMinutes + " phút, ghi đè: " + overrideState + ".");
    }

    /// <summary>Chờ một khoảng thời gian. Trả về false nếu bị hủy (Service đang dừng).</summary>
    private static async Task<bool> WaitAsync(TimeSpan delay, CancellationToken ct)
    {
        try
        {
            await Task.Delay(delay, ct);
            return !ct.IsCancellationRequested;
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }
}
