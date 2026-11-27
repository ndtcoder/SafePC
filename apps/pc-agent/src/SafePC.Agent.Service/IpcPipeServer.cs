using System.Globalization;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Channels;
using Microsoft.Extensions.Hosting;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>
/// Named Pipe server cho IPC giữa Service (SYSTEM) và Tray App (user session).
/// Giao thức: JSON theo dòng (mỗi dòng một <see cref="IpcMessage"/>), pipe hai chiều:
/// Tray gửi usage-sample / extra-time-request lên, Service gửi warning / lock xuống.
///
/// BẢO MẬT (docs/03-SECURITY.md mục 4): pipe có ACL — chỉ SYSTEM (FullControl)
/// và nhóm Builtin Users (ReadWrite) được kết nối. Pipe này chỉ dùng giao tiếp
/// nội bộ trên máy, không chứa token hay secret.
/// Hỗ trợ nhiều client cùng lúc (mỗi user session một kết nối): vòng lặp
/// accept tạo pipe instance mới ngay sau mỗi kết nối thay vì chờ client cũ
/// ngắt. Ghi chú 2026-11-16: bản một-client khiến Tray ở session thứ hai
/// không bao giờ nối được (log ngày 2026-11-16: Tray session kia giữ pipe
/// suốt 27 phút, Tray session này chờ mãi).
///
/// CHỐNG KẸT (chẩn đoán từ log thật tối 16/11/2026): vòng accept chỉ nhận
/// đúng 1 kết nối rồi kẹt im lặng — không chờ lần 2, không lỗi, không báo
/// ngắt — trong khi các vòng lặp khác của Service vẫn chạy, khiến mọi lệnh
/// khóa/mở sau đó đều bị bỏ ("Tray chưa kết nối"). Để một kết nối chết
/// (zombie) không bao giờ giữ pipe instance mãi và một lần kẹt không bao giờ
/// im lặng nữa:
/// - Mỗi handler có idle timeout 120 giây: không dòng nào tới trong 120s thì
///   đóng + dispose stream của handler đó, giải phóng pipe instance (Tray gửi
///   mẫu foreground mỗi 15s nên kết nối sống không bao giờ idle tới 120s).
/// - Vòng accept ghi log MỌI vòng lặp kèm số thứ tự (chờ, đã nối, đã giao,
///   lỗi tạo/kết nối) để lần kẹt nào cũng nhìn thấy trong log.
/// - Watchdog 60s chỉ ghi log (không dispose/khởi tạo lại gì): nếu quá 90s
///   không có vòng accept mới thì ghi cảnh báo LOUD một lần cho mỗi đợt yên
///   lặng — để phân biệt "đang chờ Tray" với "vòng accept đã kẹt".
/// TODO Sprint 2: thu hẹp ACL theo session của con + xác thực message, và
/// chỉ gửi cảnh báo/khóa tới session của con thay vì broadcast mọi client.
/// </summary>
public sealed class IpcPipeServer : BackgroundService
{
    /// <summary>
    /// Idle timeout cho mỗi kết nối handler: 120 giây không có dòng nào thì
    /// thu hồi. PHẢI khớp phía client (IpcPipeClient): cả hai bên cùng 120s.
    /// </summary>
    internal static readonly TimeSpan IdleTimeout = TimeSpan.FromSeconds(120);

    /// <summary>Ngưỡng watchdog: quá 90s không có vòng accept mới thì cảnh báo.</summary>
    private static readonly TimeSpan WatchdogStallThreshold = TimeSpan.FromSeconds(90);

    /// <summary>Chu kỳ watchdog kiểm tra vòng accept.</summary>
    private static readonly TimeSpan WatchdogInterval = TimeSpan.FromSeconds(60);

    /// <summary>Chờ khóa ghi tối đa 5 giây: một writer kẹt không được treo vòng kiểm tra rules.</summary>
    private static readonly TimeSpan WriteGateTimeout = TimeSpan.FromSeconds(5);

    /// <summary>Chống spam log "Tray chưa kết nối": tối đa 1 lần/60 giây.</summary>
    private static readonly TimeSpan NoTrayLogThrottle = TimeSpan.FromSeconds(60);

    private readonly OutboxStore _outbox;
    private readonly LocalLogger _log;
    private readonly ForegroundState _foregroundState;
    private readonly TrayQueryState _queryState;
    private readonly SupabaseApiClient _api;
    private readonly SemaphoreSlim _writeGate = new(1, 1);

    /// <summary>
    /// Một kết nối Tray: writer + thông tin phiên Tray đã giới thiệu qua
    /// message hello (trống khi Tray chưa kịp giới thiệu). Lệnh khóa và
    /// cảnh báo chỉ giao tới writer KHÔNG phải admin; writer chưa rõ (chưa
    /// có hello) vẫn nhận lệnh — miễn trừ chỉ áp dụng khi đã biết chắc
    /// phiên đó là admin (fail-closed cho khóa máy). <c>Sid</c> là SID của
    /// tài khoản Windows của phiên (Sprint 5, Tray gửi trong hello) để
    /// Service biết phiên này là hồ sơ con nào; null khi Tray cũ chưa gửi.
    /// Mọi trường phiên chỉ được ghi dưới <see cref="_writersLock"/> (nhánh
    /// hello) và đọc khi chụp danh sách dưới cùng khóa đó (gửi message).
    /// </summary>
    private sealed class WriterEntry
    {
        public required StreamWriter Writer { get; init; }
        public int? SessionId { get; set; }
        public string? UserName { get; set; }
        public bool IsAdmin { get; set; }
        public bool HasHello { get; set; }
        public string? Sid { get; set; }

        /// <summary>Thời điểm hello gần nhất của phiên này (Sprint 4: watchdog Tray dùng để biết phiên nào đã mất Tray).</summary>
        public DateTimeOffset LastHelloAt { get; set; }
    }

    private readonly System.Collections.Generic.HashSet<WriterEntry> _clientWriters = new();
    private readonly object _writersLock = new();

    /// <summary>
    /// Lần hello gần nhất theo phiên (Sprint 4): giữ lại cả khi Tray đã ngắt
    /// kết nối, để watchdog biết phiên nào TỪNG có Tray rồi mất. Chỉ ghi
    /// dưới <see cref="_writersLock"/> (nhánh hello), đọc khi chụp snapshot
    /// dưới cùng khóa đó. Session id có thể tái sử dụng sau khi khởi động
    /// lại máy — Service khởi động lại cùng lúc nên dict cũng mất theo.
    /// </summary>
    private readonly Dictionary<int, DateTimeOffset> _lastHelloBySession = new();

    /// <summary>Khoảng cách tối thiểu giữa hai lần báo cùng một SID lên server (migration 25): hello lặp lại mỗi lần Tray reconnect (~2 phút) nhưng server chỉ cần last_seen_at tươi ở mức này.</summary>
    private static readonly TimeSpan SeenAccountReportInterval = TimeSpan.FromMinutes(10);

    /// <summary>
    /// Lần báo gần nhất theo SID (migration 25, RPC
    /// safepc_report_seen_account): chống ghi dồn khi Tray reconnect liên
    /// tục. Chỉ chạm dưới <see cref="_seenAccountGate"/>; mục đã quá hạn
    /// throttle được dọn khi từ điển phình (mục quá hạn đằng nào cũng được
    /// phép báo lại, giữ chỉ tốn bộ nhớ).
    /// </summary>
    private readonly Dictionary<string, DateTimeOffset> _lastSeenReportBySid = new();
    private readonly object _seenAccountGate = new();

    /// <summary>
    /// Đã cảnh báo "RPC báo tài khoản đã thấy chưa có trên server" trong
    /// vòng đời process này chưa (migration 25 chưa áp): mẫu cờ
    /// _searchTermsRpcMissingWarned của AgentWorker — cảnh báo MỘT lần,
    /// reset khi báo thành công trở lại. Chỉ chạm dưới
    /// <see cref="_seenAccountGate"/>.
    /// </summary>
    private bool _seenAccountRpcMissingWarned;

    /// <summary>
    /// Chụp trạng thái hello của mọi phiên từng có Tray: vòng lặp watchdog
    /// của AgentWorker dùng để phát hiện Tray tắt bất thường. Trả về rỗng
    /// khi chưa phiên nào hello (VD: vừa khởi động Service).
    /// </summary>
    public IReadOnlyList<TraySessionSnapshot> GetTraySessionSnapshot()
    {
        lock (_writersLock)
        {
            var connected = new HashSet<int>();
            foreach (WriterEntry entry in _clientWriters)
            {
                if (entry.HasHello && entry.SessionId.HasValue)
                {
                    connected.Add(entry.SessionId.Value);
                }
            }

            var snapshot = new List<TraySessionSnapshot>();
            foreach (KeyValuePair<int, DateTimeOffset> pair in _lastHelloBySession)
            {
                string? userName = null;
                bool isAdmin = false;
                string? sid = null;
                foreach (WriterEntry entry in _clientWriters)
                {
                    if (entry.SessionId == pair.Key)
                    {
                        userName = entry.UserName;
                        isAdmin = entry.IsAdmin;
                        sid = entry.Sid;
                        break;
                    }
                }

                snapshot.Add(new TraySessionSnapshot(pair.Key, userName, isAdmin, pair.Value, connected.Contains(pair.Key), sid));
            }

            return snapshot;
        }
    }

    // Đếm vòng accept + thời điểm vòng accept gần nhất (ticks UTC, truy cập
    // qua Interlocked vì watchdog chạy trên thread khác).
    private long _acceptIterationCount;
    private long _lastAcceptIterationTicks;
    private long _lastWatchdogWarnedCount = -1;

    /// <summary>Vòng accept đang ngồi chờ client nối tới (trạng thái bình thường) — watchdog bỏ qua.</summary>
    private volatile bool _waitingForConnection;
    private long _handlerCount;

    // Đã tạo thành công ít nhất một pipe instance kèm ACL hay chưa — chỉ
    // vòng accept chạm tới (đơn luồng). Instance #2+ dưới tài khoản không
    // phải SYSTEM được phép rơi về instance trần (xem CreatePipeServer);
    // instance ĐẦU TIÊN thì không, để lỗi tạo pipe đầu vẫn hiện rõ thay vì
    // âm thầm chạy với DACL mặc định yếu hơn.
    private bool _firstPipeCreated;

    private readonly object _noTrayLogLock = new();
    private DateTimeOffset _lastNoTrayLogAt;

    /// <summary>Số lần nhập sai mã PIN thoát cho phép trước khi khóa nhập.</summary>
    private const int MaxPinAttempts = 5;

    /// <summary>Thời gian khóa nhập PIN sau khi sai quá số lần cho phép.</summary>
    private static readonly TimeSpan PinLockoutDuration = TimeSpan.FromMinutes(5);

    public IpcPipeServer(OutboxStore outbox, LocalLogger log, ForegroundState foregroundState, TrayQueryState queryState, SupabaseApiClient api)
    {
        _outbox = outbox;
        _log = log;
        _foregroundState = foregroundState;
        _queryState = queryState;
        _api = api;
    }

    /// <summary>
    /// Gửi một message xuống các Tray App đang kết nối. Lệnh khóa và cảnh báo
    /// chỉ giao tới phiên KHÔNG phải admin (xem WriterEntry); mở khóa và
    /// message khác tới mọi Tray. Nếu không còn Tray nào nhận được (chưa Tray
    /// nào kết nối, hoặc chỉ còn phiên admin) thì bỏ qua (ghi log chống spam)
    /// chứ không xếp hàng — cảnh báo/khóa sẽ được gửi lại ở lần kiểm tra
    /// rules tiếp theo.
    /// </summary>
    /// <returns>Số Tray đã ghi thành công (0 khi chưa Tray nào nối, chỉ còn
    /// phiên admin đang nối mà message là khóa/cảnh báo, chờ khóa ghi quá
    /// hạn, hoặc mọi lần ghi đều lỗi). Nơi gọi dùng giá trị này để quyết
    /// định có coi lệnh là "đã gửi" hay không — xem _lockSent.</returns>
    public async Task<int> SendToTrayAsync(IpcMessage message, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(message);

        // Giao lệnh theo phiên (17/11/2026): lệnh khóa và cảnh báo chỉ tới
        // phiên KHÔNG phải admin — phiên admin (phụ huynh) không bị khóa
        // theo khi khóa máy của con (log thật: 2 writer cùng nối, cả hai
        // phiên cùng hiện màn khóa). Writer chưa giới thiệu (chưa có hello)
        // vẫn nhận lệnh: miễn trừ chỉ áp dụng khi đã biết chắc là admin.
        // Mở khóa và mọi message khác vẫn tới mọi writer. Chụp + lọc dưới
        // CÙNG một lần giữ khóa: nhánh hello cũng ghi IsAdmin dưới khóa này,
        // nên đọc ngoài khóa sẽ đua với lần ghi (review đợt này).
        bool lockOrWarning = message.Type == IpcMessageTypes.Lock || message.Type == IpcMessageTypes.Warning;
        System.Collections.Generic.List<WriterEntry> entries;
        System.Collections.Generic.List<WriterEntry> targets;
        lock (_writersLock)
        {
            entries = _clientWriters.ToList();
            targets = lockOrWarning
                ? entries.Where(e => !e.IsAdmin).ToList()
                : entries;
        }

        // Chẩn đoán 17/11/2026: ghi mọi lần gửi kèm số writer đang nối —
        // log bản 0.1.122 cho thấy handler đã bắt đầu đọc nhưng mọi lần gửi
        // đều thấy danh sách rỗng; dòng này cho biết phía gửi nhìn thấy gì.
        _log.Info("IPC: gửi message " + message.Type + " (đang nối: " + entries.Count + " writer"
            + (lockOrWarning ? ", giao tới " + targets.Count + " phiên không admin" : "") + ").");

        if (targets.Count == 0)
        {
            bool due;
            DateTimeOffset now = DateTimeOffset.UtcNow;
            lock (_noTrayLogLock)
            {
                due = now - _lastNoTrayLogAt >= NoTrayLogThrottle;
                if (due)
                {
                    _lastNoTrayLogAt = now;
                }
            }

            if (due)
            {
                _log.Info(entries.Count == 0
                    ? "IPC: Tray chưa kết nối, bỏ qua message " + message.Type + "."
                    : "IPC: chỉ có phiên admin đang nối, bỏ qua message " + message.Type + " (miễn khóa phiên admin).");
            }

            return 0;
        }

        return await WriteToTargetsAsync(targets, message, ct);
    }

    /// <summary>
    /// Gửi một message CHỈ tới Tray của một phiên (Sprint 5, phương án 2
    /// "một phiên active"): chỉ phiên console đang hoạt động mới nhận lệnh
    /// khóa/cảnh báo/mở — phiên nền không bị thi hành luật. Lệnh khóa và
    /// cảnh báo vẫn MIỄN phiên admin như <see cref="SendToTrayAsync"/> (mục
    /// tiêu là phiên admin thì trả 0, không gửi gì). Mở khóa và message khác
    /// tới mọi writer của phiên đó. Trả về số Tray đã ghi thành công (0 khi
    /// phiên chưa nối, là admin mà message là khóa/cảnh báo, chờ khóa ghi
    /// quá hạn, hoặc mọi lần ghi đều lỗi). Nơi gọi dùng giá trị này như
    /// <see cref="SendToTrayAsync"/> để quyết định "đã gửi".
    /// </summary>
    public async Task<int> SendToSessionAsync(int sessionId, IpcMessage message, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(message);

        bool lockOrWarning = message.Type == IpcMessageTypes.Lock || message.Type == IpcMessageTypes.Warning;
        System.Collections.Generic.List<WriterEntry> targets;
        lock (_writersLock)
        {
            targets = _clientWriters
                .Where(e => e.SessionId == sessionId && (!lockOrWarning || !e.IsAdmin))
                .ToList();
        }

        _log.Info("IPC: gửi message " + message.Type + " tới phiên #" + sessionId + " (tìm thấy " + targets.Count + " writer"
            + (lockOrWarning ? " không admin" : "") + ").");

        if (targets.Count == 0)
        {
            return 0;
        }

        return await WriteToTargetsAsync(targets, message, ct);
    }

    /// <summary>
    /// Ghi một message xuống đúng danh sách writer đã chọn (dùng chung bởi
    /// <see cref="SendToTrayAsync"/> và <see cref="SendToSessionAsync"/>):
    /// chờ khóa ghi tối đa 5 giây, ghi từng dòng + flush tường minh (KHÔNG
    /// AutoFlush — xem ghi chú ở đầu file), writer lỗi thì gỡ khỏi danh sách.
    /// Trả về số writer đã ghi thành công.
    /// </summary>
    private async Task<int> WriteToTargetsAsync(IReadOnlyList<WriterEntry> targets, IpcMessage message, CancellationToken ct)
    {
        string line = message.ToLine();

        // Chờ khóa ghi có giới hạn: writer của một kết nối chết có thể treo
        // WriteLineAsync, và khóa bị giữ mãi sẽ treo mọi lần gửi sau.
        using var waitCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        waitCts.CancelAfter(WriteGateTimeout);
        try
        {
            await _writeGate.WaitAsync(waitCts.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            _log.Warning("IPC: chờ khóa ghi quá 5 giây, bỏ qua message " + message.Type + ".");
            return 0;
        }

        int sent = 0;
        try
        {
            foreach (WriterEntry entry in targets)
            {
                try
                {
                    await entry.Writer.WriteLineAsync(line);
                    await entry.Writer.FlushAsync();
                    sent++;
                }
                catch (Exception ex)
                {
                    _log.Error("IPC: không gửi được message tới một Tray (writer #" + entry.Writer.GetHashCode() + "), gỡ khỏi danh sách.", ex);
                    lock (_writersLock)
                    {
                        _clientWriters.Remove(entry);
                    }
                }
            }
        }
        finally
        {
            _writeGate.Release();
        }

        return sent;
    }

    /// <summary>
    /// Trả lời riêng cho MỘT Tray đã hỏi (remaining-time, pin-verify): chỉ ghi
    /// xuống writer của kết nối đã gửi câu hỏi, không broadcast, không lọc
    /// admin (phiên admin cũng được xem giờ còn lại và kiểm tra PIN). Cùng
    /// khóa ghi và kiểu flush tường minh như <see cref="SendToTrayAsync"/>.
    /// </summary>
    /// <returns>True khi đã ghi thành công.</returns>
    private async Task<bool> SendToWriterAsync(WriterEntry entry, IpcMessage message, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(entry);
        ArgumentNullException.ThrowIfNull(message);

        using var waitCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        waitCts.CancelAfter(WriteGateTimeout);
        try
        {
            await _writeGate.WaitAsync(waitCts.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            _log.Warning("IPC: chờ khóa ghi quá 5 giây, bỏ qua trả lời " + message.Type + ".");
            return false;
        }

        try
        {
            await entry.Writer.WriteLineAsync(message.ToLine());
            await entry.Writer.FlushAsync();
            return true;
        }
        catch (Exception ex)
        {
            _log.Error("IPC: không trả lời được message " + message.Type + " tới một Tray (writer #" + entry.Writer.GetHashCode() + "), gỡ khỏi danh sách.", ex);
            lock (_writersLock)
            {
                _clientWriters.Remove(entry);
            }

            return false;
        }
        finally
        {
            _writeGate.Release();
        }
    }

    /// <summary>
    /// Gửi trạng thái thi hành hiện tại cho MỘT Tray vừa giới thiệu (xem
    /// trường hợp hello trong <see cref="HandleMessageAsync"/>): Service
    /// chưa đánh giá lần nào thì không gửi gì (vòng kiểm tra rules sẽ gửi
    /// khi có quyết định); đang khóa thì gửi khóa, đang cảnh báo thì gửi
    /// cảnh báo — cả hai đều MIỄN phiên admin như
    /// <see cref="SendToTrayAsync"/> và CHỈ gửi cho đúng con của quyết định
    /// đang lưu (Sprint 5 đợt 1, sửa MAJOR-3 — quyết định của con A không
    /// được gửi cho Tray của con B); đang cho phép thì gửi mở tới mọi phiên
    /// để đóng màn hình khóa/cảnh báo cũ còn sót. Khóa đồng bộ luôn là khóa
    /// NGAY (Immediate = true): lệnh khóa đã có hiệu lực từ trước khi Tray
    /// nối lại, đếm ngược "sẽ khóa sau 60 giây" là sai sự thật — test máy
    /// thật 17/11/2026 cho thấy Tray nối lại vẫn đếm ngược như bản cũ (đợt
    /// sửa 17/11/2026). Phiên khác con với quyết định đang lưu thì không gửi
    /// gì — vòng tick (≤15s) sẽ gửi quyết định đúng của con mới.
    /// </summary>
    private async Task SyncStateToWriterAsync(WriterEntry entry, CancellationToken ct)
    {
        if (!_queryState.TryGetDecisionWithChild(out RuleDecision decision, out _, out Guid? decisionChildId))
        {
            return;
        }

        (ActiveChildStatus writerStatus, Guid? writerChildId) = await ResolveWriterChildAsync(entry, ct);
        bool isAdmin;
        lock (_writersLock)
        {
            isAdmin = entry.IsAdmin;
        }

        // Sprint 5 đợt 1 (sửa MAJOR-3): quyết định đang lưu thuộc về MỘT
        // con — chỉ gửi khóa/cảnh báo khi đúng con của phiên vừa hello.
        // Gửi khóa của con A cho Tray của con B sẽ làm B kẹt ở màn hình khóa
        // (màn hình khóa chỉ đóng khi nhận Unlock, mà vòng tick sau khi đổi
        // con không gửi Unlock nếu không có cờ — xem ShouldSendUnlockOnAllowed).
        ActiveChildResolver.HelloSyncAction action = ActiveChildResolver.DecideHelloSync(decision.Kind, decisionChildId, writerStatus, writerChildId, isAdmin);
        switch (action)
        {
            case ActiveChildResolver.HelloSyncAction.SendLock:
                _log.Info("IPC: đồng bộ trạng thái cho Tray mới nối: đang khóa, gửi lệnh khóa ngay (không đếm ngược).");
                await SendToWriterAsync(entry, IpcMessage.Create(IpcMessageTypes.Lock, new LockPayload(decision.Reason, Immediate: true)), ct);
                break;

            case ActiveChildResolver.HelloSyncAction.SendWarn:
                _log.Info("IPC: đồng bộ trạng thái cho Tray mới nối: đang cảnh báo, gửi cảnh báo.");
                await SendToWriterAsync(entry, IpcMessage.Create(IpcMessageTypes.Warning, new WarningPayload(decision.MinutesLeft, decision.Reason)), ct);
                break;

            case ActiveChildResolver.HelloSyncAction.SendUnlock:
                await SendToWriterAsync(entry, IpcMessage.Create(IpcMessageTypes.Unlock, new { }), ct);
                break;

            default:
                _log.Info("IPC: không đồng bộ quyết định khóa/cảnh báo cho Tray mới nối (phiên không phải con của quyết định đang lưu — chờ vòng tick).");
                break;
        }
    }

    /// <summary>
    /// Phân giải hồ sơ con của một Tray vừa hello (Sprint 5 đợt 1, sửa
    /// MAJOR-3): cùng luật <see cref="ActiveChildResolver.Resolve"/> như
    /// vòng tick — SID trong hello + ánh xạ đã đồng bộ (device_state) + con
    /// mặc định của máy. Lỗi đọc trạng thái thì trả về NoSessionInfo kèm con
    /// mặc định (nếu biết) để không chặn khóa vì thiếu thông tin. Phiên chưa
    /// hello (không có SessionId) thì NoSessionInfo.
    /// </summary>
    private async Task<(ActiveChildStatus Status, Guid? ChildId)> ResolveWriterChildAsync(WriterEntry entry, CancellationToken ct)
    {
        int? sessionId;
        string? sid;
        string? userName;
        bool isAdmin;
        lock (_writersLock)
        {
            sessionId = entry.SessionId;
            sid = entry.Sid;
            userName = entry.UserName;
            isAdmin = entry.IsAdmin;
        }

        if (sessionId is null)
        {
            return (ActiveChildStatus.NoSessionInfo, null);
        }

        IReadOnlyList<ChildAccountLink> links = Array.Empty<ChildAccountLink>();
        Guid? defaultChildId = null;
        try
        {
            string? linksJson = await _outbox.GetStateAsync(StateKeys.ChildAccountsJson, ct);
            if (!string.IsNullOrWhiteSpace(linksJson))
            {
                links = JsonSerializer.Deserialize<List<ChildAccountLink>>(linksJson) ?? (IReadOnlyList<ChildAccountLink>)Array.Empty<ChildAccountLink>();
            }

            string? storedDefault = await _outbox.GetStateAsync(StateKeys.DefaultChildId, ct);
            if (!string.IsNullOrWhiteSpace(storedDefault) && Guid.TryParse(storedDefault, out Guid parsed))
            {
                defaultChildId = parsed;
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.Warning("Đọc ánh xạ con ↔ tài khoản cho hello-sync lỗi (coi như chưa có ánh xạ): " + ex.Message);
        }

        var infos = new[] { new ConsoleSessionInfo(sessionId.Value, sid, userName, isAdmin) };
        return ActiveChildResolver.Resolve(sessionId, infos, links, defaultChildId);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        Interlocked.Exchange(ref _lastAcceptIterationTicks, DateTimeOffset.UtcNow.UtcTicks);

        // Watchdog chỉ ghi log, KHÔNG dispose hay tạo lại bất cứ thứ gì.
        using var watchdog = new System.Threading.Timer(WatchdogTick, null, WatchdogInterval, WatchdogInterval);

        while (!stoppingToken.IsCancellationRequested)
        {
            long iteration = Interlocked.Increment(ref _acceptIterationCount);
            Interlocked.Exchange(ref _lastAcceptIterationTicks, DateTimeOffset.UtcNow.UtcTicks);

            NamedPipeServerStream? server = null;
            try
            {
                _log.Info("IPC: accept #" + iteration + " — chờ Tray App kết nối...");
                server = CreatePipeServer();
                // Đánh dấu "đang chờ kết nối": watchdog KHÔNG được kêu trong
                // lúc này — chờ client là trạng thái bình thường, không phải
                // kẹt (log thật 17/11/2026: watchdog báo giả 3 lần trong lúc
                // vòng accept chỉ đang chờ Tray nối tới, làm nhiễu chẩn đoán).
                _waitingForConnection = true;
                try
                {
                    await server.WaitForConnectionAsync(stoppingToken);
                }
                finally
                {
                    _waitingForConnection = false;
                }
                _log.Info("IPC: accept #" + iteration + " — Tray App đã kết nối.");
                // Giao qua Task.Run — KHÔNG gọi trực tiếp: code của handler
                // (kể cả phần đồng bộ trước await đầu tiên) không bao giờ
                // được chạy trên thread của vòng accept. Log thật sáng
                // 17/11/2026: vòng accept kẹt ngay sau "đã kết nối" (không
                // có dòng "đã giao", không có accept #2, watchdog kêu) dù
                // không có lỗi nào — vòng lặp chỉ an toàn khi handler chạy
                // trên task riêng của nó. Handler tự dispose stream khi xong.
                // Chụp stream vào biến cục bộ: lambda bắt BIẾN server, mà
                // server bị gán null ngay sau đó — không chụp thì handler
                // có thể nhận null.
                NamedPipeServerStream connected = server;
                _ = Task.Run(() => HandleClientAsync(connected, stoppingToken), stoppingToken);
                server = null;
                _log.Info("IPC: accept #" + iteration + " — đã giao kết nối cho handler, tạo instance mới.");
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                server?.Dispose();
                _log.Info("IPC: accept #" + iteration + " — dừng theo yêu cầu, vòng accept kết thúc.");
                break;
            }
            catch (Exception ex)
            {
                server?.Dispose();
                _log.Error("IPC: accept #" + iteration + " lỗi (tạo pipe hoặc chờ kết nối thất bại), thử lại sau 5 giây.", ex);
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    _log.Info("IPC: vòng accept dừng trong lúc chờ thử lại.");
                    break;
                }
            }
        }

        _log.Info("IPC: server dừng.");
    }

    /// <summary>
    /// Watchdog của vòng accept: chạy mỗi 60s, chỉ ĐỌC trạng thái và ghi log.
    /// Không bao giờ dispose/tạo lại listener hay handler — tự khôi phục mù
    /// có thể phá kết nối đang sống. Mỗi đợt yên lặng chỉ cảnh báo một lần
    /// (đếm theo số vòng accept) để log không bị lấp đầy khi máy thật sự
    /// không có Tray nào nối tới trong thời gian dài.
    /// </summary>
    private void WatchdogTick(object? state)
    {
        try
        {
            // Vòng accept đang chờ client nối tới là trạng thái bình thường —
            // không kêu, nếu không log đầy cảnh báo giả (gặp ngày 17/11/2026).
            if (_waitingForConnection)
            {
                return;
            }

            long lastTicks = Interlocked.Read(ref _lastAcceptIterationTicks);
            if (lastTicks == 0)
            {
                return;
            }

            long count = Interlocked.Read(ref _acceptIterationCount);
            TimeSpan quiet = DateTimeOffset.UtcNow - new DateTimeOffset(lastTicks, TimeSpan.Zero);
            if (quiet > WatchdogStallThreshold && Interlocked.Read(ref _lastWatchdogWarnedCount) != count)
            {
                Interlocked.Exchange(ref _lastWatchdogWarnedCount, count);
                _log.Warning("IPC WATCHDOG: vòng accept không bắt đầu vòng mới trong "
                    + quiet.TotalSeconds.ToString("F0", CultureInfo.InvariantCulture)
                    + " giây (vòng gần nhất #" + count + "). Có thể vòng accept đã kẹt — kiểm tra log accept gần nhất. Watchdog chỉ ghi log, không tự khôi phục.");
            }
        }
        catch
        {
            // Watchdog không được ném exception ra thread pool.
        }
    }

    /// <summary>Tạo pipe server với ACL: SYSTEM toàn quyền, Users đọc/ghi.</summary>
    private NamedPipeServerStream CreatePipeServer()
    {
        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            PipeAccessRights.FullControl,
            AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null),
            PipeAccessRights.ReadWrite,
            AccessControlType.Allow));

        try
        {
            NamedPipeServerStream server = NamedPipeServerStreamAcl.Create(
                AgentConstants.IpcPipeName,
                PipeDirection.InOut,
                // Cho phép nhiều instance chờ sẵn để nhiều session nối cùng lúc.
                maxNumberOfServerInstances: 8,
                transmissionMode: PipeTransmissionMode.Byte,
                options: PipeOptions.Asynchronous,
                inBufferSize: 0,
                outBufferSize: 0,
                pipeSecurity: security);
            _firstPipeCreated = true;
            return server;
        }
        catch (UnauthorizedAccessException ex) when (_firstPipeCreated)
        {
            // Instance #2+ dưới tài khoản không phải SYSTEM: tạo instance
            // kèm descriptor bảo mật bị từ chối vì pipe object đã có DACL từ
            // instance #1 (CI run #129: accept #2–#7 lỗi này khi chạy dưới
            // user thường; trên máy thật Service chạy SYSTEM nên không gặp).
            // Instance sau không cần descriptor — Windows áp DACL của
            // instance đầu cho toàn bộ pipe object — nên tạo instance trần:
            // bảo mật giữ nguyên, chỉ tránh lỗi tạo instance. Chỉ rơi về
            // khi instance đầu đã tạo thành công kèm ACL (xem _firstPipeCreated).
            _log.Warning("IPC: tạo pipe kèm ACL bị từ chối (không phải SYSTEM?), dùng instance trần — DACL của pipe đã chốt từ instance đầu. " + ex.Message);
            return new NamedPipeServerStream(
                AgentConstants.IpcPipeName,
                PipeDirection.InOut,
                maxNumberOfServerInstances: 8,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous);
        }
    }

    private async Task HandleClientAsync(NamedPipeServerStream server, CancellationToken ct)
    {
        // Handler chạy nền, không được ném exception ra ngoài (ExecuteAsync
        // không await nó) — mọi lỗi đều ghi log tại đây. Stream do handler
        // sở hữu và dispose khi xong.
        long handlerId = Interlocked.Increment(ref _handlerCount);
        _log.Info("IPC: handler #" + handlerId + " bắt đầu đọc từ Tray App.");

        StreamWriter? writer = null;
        WriterEntry? entry = null;
        long receivedCount = 0;
        try
        {
            using var reader = new StreamReader(server, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, bufferSize: 1024, leaveOpen: true);
            // Breadcrumb mịn (run #131: handler im lặng giữa "bắt đầu đọc"
            // và dòng "đã tạo reader/writer" — khoảng giữa chỉ có 2 ctor,
            // về lý thuyết không thể chặn. Dòng này xác định ctor nào là
            // điểm treo.)
            _log.Info("IPC: handler #" + handlerId + " — đã tạo reader, đang tạo writer.");
            // KHÔNG dùng AutoFlush trên pipe (bài học run CI #133): setter
            // AutoFlush gọi Flush() → FlushFileBuffers, chặn tới khi đầu kia
            // ĐỌC — hai bên cùng đặt AutoFlush trước khi thread đọc nào chạy
            // thì chết chéo vĩnh viễn (cả 3 luồng kẹt đúng tại ctor
            // StreamWriter, 4 run liên tiếp). Mọi lần ghi đã FlushAsync
            // tường minh ở SendToTrayAsync, nên bỏ AutoFlush không đổi hành
            // vi ghi — chỉ bỏ lần flush lúc khởi tạo gây chết chéo.
            writer = new StreamWriter(server, Encoding.UTF8, bufferSize: 1024, leaveOpen: true);
            // Breadcrumb (run #129: handler im lặng sau "bắt đầu đọc", không
            // tới được dòng đăng ký writer): dòng này phân biệt "chết khi
            // tạo reader/writer" với "chết khi đăng ký/vào vòng đọc".
            _log.Info("IPC: handler #" + handlerId + " — đã tạo reader/writer, đang đăng ký.");
            entry = new WriterEntry { Writer = writer };
            int writerCount;
            lock (_writersLock)
            {
                _clientWriters.Add(entry);
                writerCount = _clientWriters.Count;
            }

            // Chẩn đoán 17/11/2026: dòng này chứng minh handler đã đăng ký
            // writer — log bản 0.1.122 cho thấy handler bắt đầu đọc nhưng
            // mọi lần gửi đều thấy danh sách rỗng.
            _log.Info("IPC: handler #" + handlerId + " đã đăng ký writer #" + writer.GetHashCode() + " (tổng " + writerCount + " writer).");

            // KHÔNG kiểm tra server.IsConnected (cờ này không đáng tin —
            // xem ghi chú ở IpcPipeClient): chỉ thoát khi đọc được null,
            // ném exception, Service dừng, hoặc idle quá 120 giây.
            //
            // ĐỌC BẰNG THREAD RIÊNG (sửa 17/11/2026): mẫu WhenAny giữa
            // ReadLineAsync và Task.Delay KHÔNG hoạt động trên máy thật —
            // log bản 0.1.122 cho thấy cả hai phía kẹt mãi sau khi nối,
            // timeout 120s không bao giờ kích hoạt dù Task.Delay ở vòng
            // kiểm tra rules vẫn chạy đúng chu kỳ. Mẫu mới: một thread đọc
            // đồng bộ (ReadLine chặn) đẩy dòng vào Channel; vòng xử lý
            // async đọc Channel; watchdog riêng dispose stream khi im lặng
            // quá 120s để giải phóng lần đọc đang chặn. Không còn WhenAny
            // nào dính tới lần đọc pipe.
            Channel<string> channel = Channel.CreateUnbounded<string>(
                new UnboundedChannelOptions { SingleReader = true, SingleWriter = true });
            long lastActivityTicks = DateTimeOffset.UtcNow.UtcTicks;

            Task readerTask = Task.Run(() =>
            {
                try
                {
                    while (true)
                    {
                        string? readLine = reader.ReadLine();
                        if (readLine is null)
                        {
                            _log.Info("IPC: handler #" + handlerId + " — Tray App đã đóng kết nối (EOF).");
                            break;
                        }

                        channel.Writer.TryWrite(readLine);
                    }
                }
                catch (Exception ex) when (ex is IOException or ObjectDisposedException)
                {
                    // Pipe đóng/gãy (kể cả do watchdog dispose khi idle):
                    // thoát thread đọc, vòng xử lý kết thúc khi Channel đóng.
                }
                catch (Exception ex)
                {
                    _log.Error("IPC: handler #" + handlerId + " lỗi thread đọc.", ex);
                }
                finally
                {
                    channel.Writer.TryComplete();
                }
            }, ct);

            // Watchdog idle: kiểm tra mỗi 30s, im lặng quá 120s thì dispose
            // stream (giải phóng ReadLine đang chặn) rồi thoát. Dùng CTS
            // riêng nối với ct để vòng xử lý hủy watchdog ngay khi Channel
            // đóng (không chờ tới kỳ kiểm tra 30s sau).
            using var watchdogCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            // Chụp token trước Task.Run: getter Token ném ObjectDisposedException
            // sau khi CTS bị dispose (review batch #5) — token đã chụp thì an toàn.
            CancellationToken watchdogToken = watchdogCts.Token;
            Task watchdogTask = Task.Run(async () =>
            {
                try
                {
                    while (!watchdogToken.IsCancellationRequested)
                    {
                        await Task.Delay(TimeSpan.FromSeconds(30), watchdogToken).ConfigureAwait(false);
                        long idleTicks = DateTimeOffset.UtcNow.UtcTicks - Volatile.Read(ref lastActivityTicks);
                        if (TimeSpan.FromTicks(idleTicks) > IdleTimeout)
                        {
                            _log.Warning("IPC: handler #" + handlerId + " idle quá 120 giây không có dòng nào, thu hồi kết nối (giải phóng pipe instance).");
                            try
                            {
                                server.Dispose();
                            }
                            catch
                            {
                                // Bỏ qua lỗi đóng stream cũ.
                            }

                            break;
                        }
                    }
                }
                catch (OperationCanceledException)
                {
                    // Service dừng hoặc Channel đã đóng: watchdog thoát.
                }
            }, watchdogToken);

            // Breadcrumb (run #129): tới được đây nghĩa là thread đọc +
            // watchdog đã lên lịch; im lặng sau dòng này nghĩa là vòng xử lý
            // Channel đang chờ dòng đầu tiên (bình thường) hoặc đã kẹt.
            _log.Info("IPC: handler #" + handlerId + " — thread đọc + watchdog đã lên lịch, vào vòng xử lý.");
            await foreach (string line in channel.Reader.ReadAllAsync(ct).ConfigureAwait(false))
            {
                Volatile.Write(ref lastActivityTicks, DateTimeOffset.UtcNow.UtcTicks);
                receivedCount++;

                IpcMessage? message = IpcMessage.FromLine(line);
                if (message is not null)
                {
                    // Xử lý message có giới hạn chờ 15 giây: một lần ghi DB
                    // kẹt không được treo vòng xử lý mãi. Quá hạn thì bỏ chờ,
                    // ghi log và đọc tiếp — tác vụ nền vẫn chạy, lỗi muộn
                    // của nó vẫn được ghi log.
                    Task handleTask = HandleMessageAsync(message, entry, ct);
                    Task finished = await Task.WhenAny(handleTask, Task.Delay(TimeSpan.FromSeconds(15), ct)).ConfigureAwait(false);
                    if (ct.IsCancellationRequested)
                    {
                        break;
                    }

                    if (finished != handleTask)
                    {
                        _log.Warning("IPC: handler #" + handlerId + " xử lý message " + message.Type + " quá 15 giây, bỏ chờ và tiếp tục đọc.");
                        _ = handleTask.ContinueWith(
                            t => _log.Error("IPC: handler #" + handlerId + " xử lý message " + message.Type + " lỗi sau khi bỏ chờ.", t.Exception),
                            TaskContinuationOptions.OnlyOnFaulted);
                    }
                    else
                    {
                        // Ném lại exception (nếu có) vào catch của handler.
                        await handleTask.ConfigureAwait(false);
                    }
                }
            }

            // Channel đã đóng (thread đọc thoát): hủy watchdog, dispose
            // stream để giải phóng ReadLine đang chặn (đường break khi
            // Service dừng: không có gì dispose stream trước lần await này
            // thì await readerTask treo mãi — review batch #5), rồi chờ cả
            // hai task kết thúc hẳn trước khi finally dọn writer/stream.
            // Dispose lại ở finally là an toàn.
            watchdogCts.Cancel();
            try
            {
                server.Dispose();
            }
            catch
            {
                // Bỏ qua lỗi đóng stream cũ.
            }

            try
            {
                await readerTask.ConfigureAwait(false);
            }
            catch
            {
                // Thread đọc đã ghi log lỗi của nó; không ném thêm.
            }

            try
            {
                await watchdogTask.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Watchdog dừng theo yêu cầu khi Service dừng.
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            _log.Info("IPC: handler #" + handlerId + " dừng theo yêu cầu.");
        }
        catch (Exception ex)
        {
            _log.Error("IPC: handler #" + handlerId + " lỗi khi đọc từ Tray App.", ex);
        }
        finally
        {
            if (entry is not null)
            {
                int remainingWriters;
                lock (_writersLock)
                {
                    _clientWriters.Remove(entry);
                    remainingWriters = _clientWriters.Count;
                }

                _log.Info("IPC: handler #" + handlerId + " đã gỡ writer #" + entry.Writer.GetHashCode() + " (còn " + remainingWriters + " writer).");
            }

            if (writer is not null)
            {
                try
                {
                    writer.Dispose();
                }
                catch
                {
                    // Bỏ qua lỗi đóng writer khi pipe đã gãy (gặp ở log
                    // Service 14:43 ngày 2026-11-16: IOException "Pipe is
                    // broken" từ Dispose khi client bị dừng đột ngột).
                }
            }

            try
            {
                server.Dispose();
            }
            catch
            {
                // Bỏ qua lỗi đóng pipe đã gãy.
            }

            _log.Info("IPC: handler #" + handlerId + " — Tray App đã ngắt kết nối (đã nhận " + receivedCount + " message).");
        }
    }

    private async Task HandleMessageAsync(IpcMessage message, WriterEntry entry, CancellationToken ct)
    {
        switch (message.Type)
        {
            case IpcMessageTypes.Hello:
                HelloPayload? hello = message.GetPayload<HelloPayload>();
                if (hello is not null)
                {
                    lock (_writersLock)
                    {
                        entry.SessionId = hello.SessionId;
                        entry.UserName = hello.UserName;
                        entry.IsAdmin = hello.IsAdmin;
                        entry.Sid = hello.Sid;
                        entry.HasHello = true;
                        entry.LastHelloAt = DateTimeOffset.UtcNow;
                        // Sprint 4: ghi lại để watchdog biết phiên này từng
                        // có Tray, kể cả sau khi Tray ngắt kết nối.
                        _lastHelloBySession[hello.SessionId] = entry.LastHelloAt;
                    }

                    _log.Info("IPC: Tray phiên #" + hello.SessionId + " (" + hello.UserName + ") đã giới thiệu, admin=" + hello.IsAdmin
                        + (hello.Sid is null ? " (chưa gửi SID — Tray cũ)" : " (đã gửi SID)")
                        + " — lệnh khóa/cảnh báo " + (hello.IsAdmin ? "sẽ MIỄN phiên này." : "sẽ giao tới phiên này."));

                    // Migration 25: báo tài khoản Windows của ĐÚNG phiên
                    // vừa hello lên server (Dashboard liệt kê khi phụ
                    // huynh gắn tài khoản với hồ sơ con). Fire-and-forget
                    // có kiểm soát + throttle theo SID — xem
                    // ReportSeenAccountInBackground; không await để luồng
                    // đồng bộ trạng thái ngay dưới không bị trễ.
                    ReportSeenAccountInBackground(hello, ct);

                    // ĐỒNG BỘ TRẠNG THÁI KHI TRAY MỚI NỐI (sửa 17/11/2026
                    // theo yêu cầu test máy thật): Tray thoát rồi chạy lại
                    // (hoặc đăng nhập lại sau khi thoát bằng PIN) mà Service
                    // vẫn giữ cờ "đã gửi khóa" thì Tray mới không bao giờ
                    // nhận lại lệnh khóa — máy hiện "đang khóa" trên web
                    // nhưng thực tế không khóa. Gửi ngay trạng thái hiện
                    // tại cho writer vừa giới thiệu: đang khóa thì gửi khóa,
                    // đang cảnh báo thì gửi cảnh báo, đang cho phép thì gửi
                    // mở (đóng màn hình khóa cũ nếu còn). Không chờ tới kỳ
                    // kiểm tra rules sau, không cần Tray hỏi lại định kỳ.
                    await SyncStateToWriterAsync(entry, ct);
                }
                break;

            case IpcMessageTypes.UsageSample:
                UsageSamplePayload? sample = message.GetPayload<UsageSamplePayload>();
                if (sample is not null)
                {
                    // Sprint 5: ĐÓNG DẤU SID từ bản tin hello của writer này
                    // (quyền quyết định — không tin SID client tự gửi trong
                    // sample) để mẫu usage ghi đúng con nào dùng app. Đọc
                    // dưới khóa như IsAdmin ở SyncStateToWriterAsync.
                    string? sampleSid;
                    lock (_writersLock)
                    {
                        sampleSid = entry.Sid;
                    }

                    await _outbox.RecordUsageSampleAsync(sample with { Sid = sampleSid }, ct);
                }
                break;

            case IpcMessageTypes.ForegroundChanged:
                ForegroundChangedPayload? foreground = message.GetPayload<ForegroundChangedPayload>();
                if (foreground is not null)
                {
                    _foregroundState.Report(foreground);
                }
                break;

            case IpcMessageTypes.ExtraTimeRequest:
                ExtraTimeRequestPayload? request = message.GetPayload<ExtraTimeRequestPayload>();
                if (request is not null && request.Minutes >= 1 && request.Minutes <= 240)
                {
                    // Reason có thể null khi JSON gửi lên thiếu trường hoặc
                    // mang null (System.Text.Json không throw cho trường
                    // non-nullable) — .Trim() trực tiếp sẽ NRE và giết cả
                    // handler/kết nối (review đợt này).
                    string reason = (request.Reason ?? string.Empty).Trim();
                    // Sprint 5: đóng dấu SID từ hello của writer này (như
                    // usage sample) để đợt sau biết yêu cầu là của con nào.
                    string? requestSid;
                    lock (_writersLock)
                    {
                        requestSid = entry.Sid;
                    }

                    await _outbox.EnqueueExtraTimeRequestAsync(
                        request.Minutes,
                        reason.Length == 0 ? "(không có lý do)" : reason[..Math.Min(reason.Length, 500)],
                        request.RequestedAt,
                        ct,
                        requestSid);
                    _log.Info("IPC: nhận yêu cầu xin thêm giờ (" + request.Minutes + " phút), đã xếp vào outbox để đẩy lên server.");
                }
                else
                {
                    _log.Warning("IPC: yêu cầu xin thêm giờ không hợp lệ (thiếu payload hoặc số phút ngoài 1-240), bỏ qua.");
                }
                break;

            case IpcMessageTypes.RemainingTimeRequest:
                RemainingTimeRequestPayload? remainingRequest = message.GetPayload<RemainingTimeRequestPayload>();
                string remainingRequestId = remainingRequest?.RequestId ?? string.Empty;
                RemainingTimeResponsePayload remainingResponse;
                if (_queryState.TryGetDecisionWithBonus(out RuleDecision decision, out DateTimeOffset evaluatedAt, out int? activeBonusMinutes))
                {
                    string decisionText = decision.Kind switch
                    {
                        RuleDecisionKind.Warn => "warn",
                        RuleDecisionKind.Lock => "lock",
                        _ => "allow",
                    };
                    remainingResponse = new RemainingTimeResponsePayload(
                        decisionText,
                        decision.MinutesLeft == int.MaxValue ? null : decision.MinutesLeft,
                        decision.Reason,
                        evaluatedAt,
                        remainingRequestId,
                        activeBonusMinutes);
                }
                else
                {
                    remainingResponse = new RemainingTimeResponsePayload(
                        "unknown",
                        null,
                        "Service chưa đánh giá quy tắc lần nào.",
                        DateTimeOffset.UtcNow,
                        remainingRequestId);
                }

                await SendToWriterAsync(entry, IpcMessage.Create(IpcMessageTypes.RemainingTimeResponse, remainingResponse), ct);
                break;

            case IpcMessageTypes.ChatOpenRequest:
                await HandleChatOpenAsync(message, entry, ct);
                break;

            case IpcMessageTypes.PinVerifyRequest:
                await HandlePinVerifyAsync(message, entry, ct);
                break;

            default:
                _log.Warning("IPC: message không rõ loại, bỏ qua: " + message.Type);
                break;
        }
    }

    /// <summary>
    /// Báo lên server tài khoản Windows của phiên vừa hello (migration
    /// 25, RPC <c>safepc_report_seen_account</c>) để Dashboard liệt kê
    /// được các tài khoản Windows trên máy khi phụ huynh gắn tài khoản
    /// với hồ sơ con. Fire-and-forget có kiểm soát (mẫu
    /// OnForegroundReportReceived của AgentWorker): KHÔNG await trong
    /// luồng hello — việc đồng bộ trạng thái khóa/cảnh báo ngay sau hello
    /// không bị trễ vì một lần gọi HTTP; lỗi được bắt trọn trong
    /// <see cref="ReportSeenAccountCoreAsync"/> nên không bao giờ làm
    /// hỏng luồng hello. Throttle trong bộ nhớ: mỗi SID tối đa 1 lần gọi
    /// / 10 phút trong vòng đời process (hello lặp lại mỗi lần Tray
    /// reconnect ~2 phút); mốc được ghi khi QUYẾT ĐỊNH gọi — server đang
    /// lỗi hay RPC chưa áp thì nhịp gọi vẫn bị throttle, không thành bão.
    /// </summary>
    private void ReportSeenAccountInBackground(HelloPayload hello, CancellationToken ct)
    {
        string? sid = hello.Sid;
        if (string.IsNullOrWhiteSpace(sid))
        {
            // Tray cũ chưa gửi SID: RPC từ chối SID rỗng (P0001) và hàng
            // không SID không có giá trị gắn con — không có gì để báo.
            return;
        }

        DateTimeOffset now = DateTimeOffset.UtcNow;
        lock (_seenAccountGate)
        {
            if (_lastSeenReportBySid.TryGetValue(sid, out DateTimeOffset last)
                && now - last < SeenAccountReportInterval)
            {
                return;
            }

            _lastSeenReportBySid[sid] = now;

            // Dọn mục đã quá hạn throttle khi từ điển phình: các SID đó
            // đằng nào cũng được phép báo lại, giữ chỉ tốn bộ nhớ.
            if (_lastSeenReportBySid.Count > 64)
            {
                var stale = new List<string>();
                foreach (KeyValuePair<string, DateTimeOffset> pair in _lastSeenReportBySid)
                {
                    if (now - pair.Value >= SeenAccountReportInterval)
                    {
                        stale.Add(pair.Key);
                    }
                }

                foreach (string key in stale)
                {
                    _lastSeenReportBySid.Remove(key);
                }
            }
        }

        _ = ReportSeenAccountCoreAsync(sid, hello.UserName, hello.IsAdmin, ct);
    }

    /// <summary>
    /// Lượt báo tài khoản đã thấy chạy nền: tự bắt mọi lỗi. NotPaired và
    /// Failed đã được <see cref="SupabaseApiClient"/> log throttled nên ở
    /// đây không log thêm (tránh spam theo nhịp hello); riêng RpcMissing
    /// (migration 25 chưa áp) cảnh báo MỘT lần cho cả vòng đời process —
    /// mẫu FlushSearchTermsAsync/_searchTermsRpcMissingWarned của
    /// AgentWorker — và reset cờ khi báo thành công trở lại để lần mất
    /// RPC sau lại cảnh báo được.
    /// </summary>
    private async Task ReportSeenAccountCoreAsync(string sid, string? userName, bool isAdmin, CancellationToken ct)
    {
        try
        {
            SeenAccountReportStatus status = await _api.ReportSeenAccountAsync(sid, userName, isAdmin, ct).ConfigureAwait(false);
            if (status == SeenAccountReportStatus.RpcMissing)
            {
                bool warn;
                lock (_seenAccountGate)
                {
                    warn = !_seenAccountRpcMissingWarned;
                    _seenAccountRpcMissingWarned = true;
                }

                if (warn)
                {
                    _log.Warning("IPC: RPC safepc_report_seen_account chưa có trên server (migration 25 chưa áp) — Dashboard chưa liệt kê được tài khoản Windows đã thấy trên máy này; sẽ tự báo lại khi migration được áp.");
                }
            }
            else if (status == SeenAccountReportStatus.Reported)
            {
                lock (_seenAccountGate)
                {
                    _seenAccountRpcMissingWarned = false;
                }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.Error("IPC: báo tài khoản Windows đã thấy lỗi.", ex);
        }
    }

    /// <summary>
    /// Cấp phiên chat cho con khi con bấm "Nhắn tin với bố mẹ" (migration
    /// 29): Service lấy SID của phiên từ bản tin hello của ĐÚNG kết nối pipe
    /// đã hỏi (quyền quyết định phía server — payload câu hỏi cố ý không
    /// mang SID, xem <see cref="ChatOpenRequestPayload"/>), gọi RPC
    /// <c>safepc_mint_chat_session</c> rồi trả URL trang chat đầy đủ về đúng
    /// writer đã hỏi. URL chứa token phiên trong fragment: chỉ đi trên pipe
    /// nội bộ máy, KHÔNG bao giờ ghi log (kể cả khi ghi lỗi) — log chỉ ghi
    /// sự kiện + mã lỗi. Mọi lỗi đều có câu trả lời (fail mềm kèm mã lỗi để
    /// Tray dịch sang câu chữ cho con), handler không ném exception ra vòng
    /// đọc pipe.
    /// </summary>
    private async Task HandleChatOpenAsync(IpcMessage message, WriterEntry entry, CancellationToken ct)
    {
        ChatOpenRequestPayload? request = message.GetPayload<ChatOpenRequestPayload>();
        string requestId = request?.RequestId ?? string.Empty;

        async Task ReplyAsync(bool ok, string? url, string? error)
        {
            await SendToWriterAsync(entry, IpcMessage.Create(
                IpcMessageTypes.ChatOpenResponse,
                new ChatOpenResponsePayload(ok, url, error, requestId)), ct);
        }

        // SID của phiên: đọc dưới khóa như các nhánh khác (hello ghi dưới
        // cùng khóa này). Phiên chưa hello thì null — RPC ghi theo con mặc
        // định của máy, như các đường fallback khác.
        string? sid;
        lock (_writersLock)
        {
            sid = entry.Sid;
        }

        try
        {
            (ChatSessionMintStatus status, ChatSessionMintResult? result) = await _api.SendChatSessionMintAsync(sid, ct);
            switch (status)
            {
                case ChatSessionMintStatus.Ok when result is not null:
                    string chatUrl = AgentConstants.ChatPageUrl + "#t=" + Uri.EscapeDataString(result.Token);
                    _log.Info("IPC: đã cấp phiên chat cho một Tray (hết hạn " + result.ExpiresAt.ToString("o") + "), trả URL trang chat về đúng phiên đã hỏi.");
                    await ReplyAsync(ok: true, url: chatUrl, error: null);
                    break;

                case ChatSessionMintStatus.NotPaired:
                    _log.Warning("IPC: xin phiên chat bị từ chối: máy chưa ghép nối (not_paired).");
                    await ReplyAsync(ok: false, url: null, error: ChatOpenErrors.NotPaired);
                    break;

                case ChatSessionMintStatus.RpcMissing:
                    _log.Warning("IPC: xin phiên chat bị từ chối: server chưa bật nhắn tin (chat_not_enabled, migration 29 chưa áp).");
                    await ReplyAsync(ok: false, url: null, error: ChatOpenErrors.ChatNotEnabled);
                    break;

                default:
                    _log.Warning("IPC: xin phiên chat thất bại (failed).");
                    await ReplyAsync(ok: false, url: null, error: ChatOpenErrors.Failed);
                    break;
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.Error("IPC: xử lý yêu cầu mở nhắn tin lỗi.", ex);
            await ReplyAsync(ok: false, url: null, error: ChatOpenErrors.Failed);
        }
    }

    /// <summary>
    /// Kiểm tra mã PIN thoát: Service giữ hash (đồng bộ qua heartbeat), Tray
    /// chỉ gửi PIN nhập vào lên để kiểm tra — hash không bao giờ xuống Tray.
    /// Sai quá <see cref="MaxPinAttempts"/> lần liên tiếp thì khóa nhập
    /// <see cref="PinLockoutDuration"/>; số lần sai + thời điểm khóa lưu bền
    /// vững trong device_state nên khởi động lại Tray/Service không xóa được.
    /// Không bao giờ ghi log PIN nhập vào hay hash. Mọi lỗi (DB, hash hỏng)
    /// đều trả lời "không xác thực" (fail-closed).
    /// Ghi nhận (review đợt này): đọc-sửa-ghi PinFailCount không nguyên tử —
    /// hai phiên kiểm tra cùng lúc có thể làm mất một lần đếm, hậu quả chỉ
    /// là khóa chậm hơn một lần thử; chấp nhận, không khóa thêm. Tương tự,
    /// hai phiên gửi đúng PIN cùng một mili-giây có thể cùng đọc được hash
    /// trước khi bên kia kịp tiêu thụ — cửa sổ mili-giây, cùng một máy, mã
    /// vẫn bị gỡ ngay sau đó; chấp nhận, không khóa thêm.
    /// </summary>
    private async Task HandlePinVerifyAsync(IpcMessage message, WriterEntry entry, CancellationToken ct)
    {
        PinVerifyRequestPayload? request = message.GetPayload<PinVerifyRequestPayload>();
        string requestId = request?.RequestId ?? string.Empty;
        string? storedHash = _queryState.ExitPinHash;

        async Task ReplyAsync(bool verified, bool lockedOut, int remainingAttempts, bool pinConfigured)
        {
            await SendToWriterAsync(entry, IpcMessage.Create(
                IpcMessageTypes.PinVerifyResponse,
                new PinVerifyResponsePayload(verified, lockedOut, remainingAttempts, pinConfigured, requestId)), ct);
        }

        if (request is null || string.IsNullOrEmpty(request.Pin))
        {
            await ReplyAsync(verified: false, lockedOut: false, remainingAttempts: 0, pinConfigured: storedHash is not null);
            return;
        }

        if (storedHash is null)
        {
            await ReplyAsync(verified: false, lockedOut: false, remainingAttempts: 0, pinConfigured: false);
            return;
        }

        try
        {
            string? lockoutUntilText = await _outbox.GetStateAsync(StateKeys.PinLockoutUntil, ct);
            if (DateTimeOffset.TryParse(lockoutUntilText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset lockoutUntil)
                && lockoutUntil > DateTimeOffset.UtcNow)
            {
                await ReplyAsync(verified: false, lockedOut: true, remainingAttempts: 0, pinConfigured: true);
                return;
            }

            if (PinHash.Verify(request.Pin, storedHash))
            {
                await _outbox.SetStateAsync(StateKeys.PinFailCount, "0", ct);
                await _outbox.DeleteStateAsync(StateKeys.PinLockoutUntil, ct);

                // MÃ PIN CHỈ DÙNG MỘT LẦN (yêu cầu test máy thật 17/11/2026):
                // nhập đúng thì mã bị gỡ khỏi hệ thống ngay. Ghi cờ
                // hash-đã-dùng TRƯỚC khi xóa khỏi bộ nhớ: ghi cờ lỗi thì
                // catch ngoài trả lời "không xác thực" và mã vẫn còn nguyên
                // để thử lại (không để lại trạng thái nửa vời). Xóa khỏi bộ
                // nhớ xong thì mọi phiên khác hết dùng được mã này ngay lập
                // tức. Lệnh gỡ lên server lỗi (mất mạng, migration 8 chưa
                // áp) thì cờ còn lại và chu kỳ heartbeat thử lại cho tới khi
                // server xác nhận — không bao giờ chặn câu trả lời "được
                // phép thoát" vì lỗi gỡ. RPC chỉ gỡ khi hash trên server
                // đúng bằng hash vừa dùng nên mã PIN mới không bị xóa nhầm.
                await _outbox.SetStateAsync(StateKeys.PinConsumedHash, storedHash, ct);
                _queryState.UpdatePinHash(null);
                try
                {
                    bool? cleared = await _api.ClearExitPinAsync(storedHash, ct);
                    if (cleared is not null)
                    {
                        // true = đã gỡ; false = hash trên server đã đổi/mất
                        // (mã đã dùng không còn đó nữa) — cả hai đều không
                        // cần thử lại.
                        await _outbox.DeleteStateAsync(StateKeys.PinConsumedHash, ct);
                        _log.Info(cleared.Value
                            ? "IPC: mã PIN thoát đúng, cho phép thoát Tray; mã PIN đã gỡ khỏi server (dùng một lần)."
                            : "IPC: mã PIN thoát đúng, cho phép thoát Tray; mã PIN trên server đã đổi/gỡ rồi, không cần gỡ lại.");
                    }
                    else
                    {
                        _log.Warning("IPC: mã PIN thoát đúng, cho phép thoát Tray; lệnh gỡ mã trên server chưa thành công, sẽ thử lại ở chu kỳ heartbeat sau.");
                    }
                }
                catch (Exception ex)
                {
                    _log.Error("IPC: gỡ mã PIN thoát trên server lỗi (mã vẫn bị gỡ khỏi bộ nhớ Service, sẽ thử lại sau).", ex);
                }

                await ReplyAsync(verified: true, lockedOut: false, remainingAttempts: MaxPinAttempts, pinConfigured: true);

                // Sprint 4: thoát Tray bằng mã PIN là thoát CÓ PHÉP — đặt ân
                // hạn 30 phút để watchdog không khởi động lại Tray ngay trong
                // lúc phụ huynh bảo trì máy. Ghi bền vững để Service khởi
                // động lại giữa chừng vẫn nhớ. Best-effort: ghi lỗi thì chỉ
                // mất ân hạn (watchdog có thể khởi động lại Tray sớm hơn),
                // không bao giờ chặn câu trả lời "được phép thoát".
                try
                {
                    await _outbox.SetStateAsync(
                        StateKeys.TrayExitAuthorizedUntil,
                        DateTimeOffset.UtcNow.Add(TrayWatchdog.PinExitGrace).ToString("o", CultureInfo.InvariantCulture),
                        ct);
                }
                catch (Exception ex)
                {
                    _log.Warning("IPC: không ghi được ân hạn thoát Tray (watchdog có thể khởi động lại Tray sớm): " + ex.Message);
                }

                return;
            }

            string? failCountText = await _outbox.GetStateAsync(StateKeys.PinFailCount, ct);
            int fails = (int.TryParse(failCountText, CultureInfo.InvariantCulture, out int parsed) ? parsed : 0) + 1;
            await _outbox.SetStateAsync(StateKeys.PinFailCount, fails.ToString(CultureInfo.InvariantCulture), ct);
            if (fails >= MaxPinAttempts)
            {
                await _outbox.SetStateAsync(
                    StateKeys.PinLockoutUntil,
                    DateTimeOffset.UtcNow.Add(PinLockoutDuration).ToString("o", CultureInfo.InvariantCulture),
                    ct);
                _log.Warning("IPC: nhập sai mã PIN thoát lần " + fails + "/" + MaxPinAttempts + ", khóa nhập " + PinLockoutDuration.TotalMinutes.ToString(CultureInfo.InvariantCulture) + " phút.");
                await ReplyAsync(verified: false, lockedOut: true, remainingAttempts: 0, pinConfigured: true);
                return;
            }

            _log.Warning("IPC: nhập sai mã PIN thoát (lần " + fails + "/" + MaxPinAttempts + ").");
            await ReplyAsync(verified: false, lockedOut: false, remainingAttempts: MaxPinAttempts - fails, pinConfigured: true);
        }
        catch (Exception ex)
        {
            _log.Error("IPC: kiểm tra mã PIN thoát lỗi.", ex);
            await ReplyAsync(verified: false, lockedOut: false, remainingAttempts: 0, pinConfigured: true);
        }
    }
}
