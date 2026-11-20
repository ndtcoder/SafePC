using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>Trạng thái của phiên console sau khi phân giải ra hồ sơ con (Sprint 5).</summary>
public enum ActiveChildStatus
{
    /// <summary>Phiên console là một hồ sơ con đã biết (đã gắn, hoặc máy đơn-con fallback về con mặc định) — thi hành luật của con đó.</summary>
    Active,

    /// <summary>
    /// Phiên console là tài khoản Standard đã biết SID nhưng chưa gắn với hồ
    /// sơ con nào — ĐÃ CHỐT 20/11/2026: KHÔNG quản lý + ghi log cảnh báo
    /// (phần hiện cảnh báo trên Dashboard làm ở đợt Dashboard sau).
    /// </summary>
    UnmappedStandard,

    /// <summary>Phiên console là admin (phụ huynh) — miễn trừ như hiện tại.</summary>
    AdminExempt,

    /// <summary>Không có phiên console nào (máy ở màn hình đăng nhập / không ai ngồi máy) — không thi hành gì.</summary>
    NoConsoleSession,

    /// <summary>
    /// Có phiên console nhưng Service chưa biết đó là ai (Tray chưa hello
    /// kịp) — fallback về con mặc định như hành vi hôm nay (phiên chưa rõ
    /// vẫn thi hành luật, fail-closed cho khóa máy).
    /// </summary>
    NoSessionInfo,
}

/// <summary>Thông tin tối thiểu về một phiên đã hello để phân giải con đang active.</summary>
public sealed record ConsoleSessionInfo(int SessionId, string? Sid, string? UserName, bool IsAdmin);

/// <summary>
/// Phạm vi mẫu usage của một con: các SID thuộc về con đó + có tính mẫu
/// không rõ phiên (sid NULL, Tray cũ / mẫu trước Sprint 5) vào con này
/// không. Mẫu không rõ phiên chỉ tính cho con mặc định của máy — con khác
/// chỉ tính đúng mẫu mang SID của mình (mẫu lạ không được tính ké cho con
/// khác, tránh cộng dồn giờ sai).
/// </summary>
public sealed record UsageScope(IReadOnlyList<string> Sids, bool IncludeUnattributed);

/// <summary>
/// Phân giải "con nào đang ngồi ở máy" từ phiên console + ánh xạ SID→con —
/// logic thuần, không chạm Win32/DB/mạng, để kiểm tra được bằng harness.
///
/// Bối cảnh (Sprint 5, phương án 2 "một phiên active"): một máy có thể có
/// nhiều tài khoản con; chỉ phiên console đang hoạt động mới bị thi hành
/// luật, phiên nền tạm dừng. Service biết "ai đang ngồi máy" nhờ SID trong
/// bản tin hello của Tray (mỗi phiên gửi SID của tài khoản Windows của
/// mình) + bảng ánh xạ device_child_accounts (migration 24).
/// </summary>
public static class ActiveChildResolver
{
    /// <summary>
    /// Phân giải phiên console ra (trạng thái, hồ sơ con).
    /// <paramref name="consoleSessionId"/> null = WTSGetActiveConsoleSessionId
    /// báo không có phiên console (0xFFFFFFFF). <paramref name="sessions"/>
    /// là các phiên từng hello (kèm SID nếu Tray mới gửi). <paramref name="links"/>
    /// là ánh xạ SID→con của máy này. <paramref name="defaultChildId"/> là
    /// con mặc định/chính của máy (devices.child_id, lấy từ heartbeat).
    ///
    /// Thứ tự quyết định:
    /// 1. Không có phiên console → NoConsoleSession.
    /// 2. Phiên console chưa hello (Service chưa biết) → NoSessionInfo,
    ///    kèm con mặc định để vòng tick thi hành như hôm nay (fail-closed).
    /// 3. Phiên admin → AdminExempt (miễn trừ, không gắn với con nào).
    /// 4. SID khớp một hàng ánh xạ → Active(con đó).
    /// 5. SID đã biết nhưng không khớp ánh xạ nào:
    ///    - máy chưa có ánh xạ nào + có con mặc định → Active(con mặc định):
    ///      máy đơn-con (hoặc chưa gắn con nào) — phiên Standard duy nhất
    ///      đó chính là con của máy, giữ nguyên hành vi hôm nay. Trạng thái
    ///      chuyển tiếp này tránh "vách đá" lăn ra: mới cài Tray mới mà chưa
    ///      kịp gắn ánh xạ thì máy vẫn thi hành luật như cũ, thay vì đột
    ///      ngột ngừng quản lý cả con mặc định.
    ///    - còn lại → UnmappedStandard (không quản lý, quyết định đã chốt
    ///      20/11/2026).
    /// 6. Không có SID (Tray cũ chưa gửi SID) → Active(con mặc định) khi
    ///    biết con mặc định, ngược lại NoSessionInfo — phiên chưa rõ vẫn
    ///    thi hành luật như hành vi hôm nay.
    /// </summary>
    public static (ActiveChildStatus Status, Guid? ChildId) Resolve(
        int? consoleSessionId,
        IReadOnlyList<ConsoleSessionInfo> sessions,
        IReadOnlyList<ChildAccountLink> links,
        Guid? defaultChildId)
    {
        if (consoleSessionId is null)
        {
            return (ActiveChildStatus.NoConsoleSession, null);
        }

        ConsoleSessionInfo? session = null;
        foreach (ConsoleSessionInfo candidate in sessions)
        {
            if (candidate.SessionId == consoleSessionId.Value)
            {
                session = candidate;
                break;
            }
        }

        if (session is null)
        {
            return (ActiveChildStatus.NoSessionInfo, defaultChildId);
        }

        if (session.IsAdmin)
        {
            return (ActiveChildStatus.AdminExempt, null);
        }

        if (session.Sid is not null)
        {
            foreach (ChildAccountLink link in links)
            {
                if (string.Equals(link.WindowsSid, session.Sid, StringComparison.Ordinal))
                {
                    return (ActiveChildStatus.Active, link.ChildId);
                }
            }

            if (links.Count == 0 && defaultChildId is not null)
            {
                return (ActiveChildStatus.Active, defaultChildId);
            }

            return (ActiveChildStatus.UnmappedStandard, null);
        }

        // Tray cũ: không gửi SID. Coi như chưa rõ danh tính nhưng vẫn thi
        // hành luật của con mặc định (hành vi hôm nay).
        return defaultChildId is not null
            ? (ActiveChildStatus.Active, defaultChildId)
            : (ActiveChildStatus.NoSessionInfo, null);
    }

    /// <summary>
    /// WTS trả 0xFFFFFFFF (không có phiên console HOẶC API lỗi — review lần
    /// hai, MINOR-1): quyết định trạng thái từ snapshot hello + tiền đề
    /// GetLastError. Chưa phiên nào hello mà WTS trả 0xFFFFFFFF thì chắc
    /// chắn là chưa có phiên console (máy vừa khởi động / ở màn hình đăng
    /// nhập trước lần đăng nhập đầu tiên) — kết luận này không cần dựa vào
    /// tiền đề GetLastError chưa xác minh. Sau khi đã có phiên hello thì
    /// giữ tiền đề cũ: lỗi API → NoSessionInfo (giữ hành vi cũ, thi hành
    /// luật con mặc định), không lỗi → NoConsoleSession (bỏ qua tick).
    /// </summary>
    public static ActiveChildStatus ResolveNullConsoleSession(bool anySessionEverHelloed, bool apiFailed)
    {
        if (!anySessionEverHelloed)
        {
            return ActiveChildStatus.NoConsoleSession;
        }

        return apiFailed ? ActiveChildStatus.NoSessionInfo : ActiveChildStatus.NoConsoleSession;
    }

    /// <summary>
    /// Lệnh này có được thi hành ngay trong chu kỳ poll này không.
    /// Lệnh gắn con (child_id khác null) chỉ áp khi đúng con đó đang active.
    /// Lệnh cũ (child_id null) thuộc về con mặc định của máy: áp khi con
    /// mặc định đang active, hoặc khi chưa biết phiên nào (NoSessionInfo —
    /// hành vi hôm nay, fail-closed); hoãn trong mọi trạng thái còn lại
    /// (con khác đang active, phiên chưa gắn, phiên admin, không có phiên
    /// console) tới khi con mặc định lên console. Lệnh hoãn thì giữ pending,
    /// không ack, không thi hành — vòng poll sau thử lại.
    /// </summary>
    public static bool ShouldApplyCommand(
        Guid? commandChildId,
        ActiveChildStatus status,
        Guid? activeChildId,
        Guid? defaultChildId)
    {
        if (commandChildId is not null)
        {
            return status == ActiveChildStatus.Active && activeChildId == commandChildId;
        }

        if (status == ActiveChildStatus.NoSessionInfo)
        {
            return true;
        }

        return status == ActiveChildStatus.Active && activeChildId == defaultChildId;
    }

    /// <summary>Hành động hello-sync cho một Tray vừa giới thiệu (Sprint 5 đợt 1, sửa MAJOR-3).</summary>
    public enum HelloSyncAction
    {
        /// <summary>Không gửi gì — chờ vòng tick gửi quyết định đúng của con này (≤15s).</summary>
        Skip,

        /// <summary>Gửi lệnh khóa ngay (Immediate).</summary>
        SendLock,

        /// <summary>Gửi cảnh báo.</summary>
        SendWarn,

        /// <summary>Gửi mở khóa (đóng màn hình khóa/cảnh báo cũ nếu còn).</summary>
        SendUnlock,
    }

    /// <summary>
    /// Tray vừa hello thì đồng bộ quyết định nào cho nó (Sprint 5 đợt 1, sửa
    /// MAJOR-3): quyết định đang lưu thuộc về MỘT con — chỉ gửi khóa/cảnh
    /// báo khi đúng con đó; gửi nhầm khóa của con A cho Tray của con B sẽ
    /// làm B kẹt ở màn hình khóa (màn hình khóa chỉ đóng khi nhận Unlock,
    /// mà vòng tick sau khi đổi con lại không gửi Unlock vì cờ đã bị reset).
    ///
    /// Quy tắc:
    /// - Quyết định Allowed → luôn SendUnlock (dọn màn hình khóa cũ nếu còn,
    ///   vô hại khi không có màn hình nào).
    /// - Phiên admin → Skip với Lock/Warn (miễn trừ như hiện tại).
    /// - Phiên Standard chưa gắn hồ sơ nào → Skip với Lock/Warn (không thi
    ///   hành luật cho phiên chưa gắn).
    /// - Con của quyết định và con của phiên đều biết mà khác nhau → Skip
    ///   (chờ vòng tick đánh giá đúng con này rồi gửi quyết định của nó).
    /// - Một trong hai con chưa biết (quyết định ghi từ đường cũ / self-test,
    ///   hoặc phiên chưa phân giải được) → gửi như trước (fail-closed cho
    ///   khóa máy: khóa thật không được bỏ chỉ vì thiếu thông tin).
    /// </summary>
    public static HelloSyncAction DecideHelloSync(
        RuleDecisionKind decisionKind,
        Guid? decisionChildId,
        ActiveChildStatus writerStatus,
        Guid? writerChildId,
        bool writerIsAdmin)
    {
        if (decisionKind == RuleDecisionKind.Allowed)
        {
            return HelloSyncAction.SendUnlock;
        }

        if (writerIsAdmin || writerStatus == ActiveChildStatus.UnmappedStandard)
        {
            return HelloSyncAction.Skip;
        }

        if (decisionChildId is not null && writerChildId is not null && decisionChildId.Value != writerChildId.Value)
        {
            return HelloSyncAction.Skip;
        }

        return decisionKind == RuleDecisionKind.Lock ? HelloSyncAction.SendLock : HelloSyncAction.SendWarn;
    }

    /// <summary>
    /// Vòng tick có gửi Unlock khi quyết định mới là Allowed không (sửa
    /// MAJOR-3, phần (b)): trước đây chỉ gửi khi <c>_lockSent</c> hoặc đang
    /// có lệnh khóa chờ — nhưng khi đổi phiên/con thì hai cờ này đã bị reset
    /// về false nên Unlock không bao giờ được gửi, con mới kẹt ở màn hình
    /// khóa do hello-sync gửi nhầm. Nay gửi Unlock một lần khi vừa đổi
    /// phiên/con (dọn màn hình khóa còn sót), kể cả khi chưa từng gửi khóa
    /// cho con mới. Gửi Unlock thừa là vô hại (Tray không có màn hình khóa
    /// thì bỏ qua); không gửi lại ở tick sau vì cờ đổi phiên chỉ đúng ở
    /// tick đầu tiên sau khi đổi.
    /// </summary>
    public static bool ShouldSendUnlockOnAllowed(bool lockSent, bool hadPendingLock, bool contextJustChanged)
        => lockSent || hadPendingLock || contextJustChanged;

    /// <summary>
    /// Phạm vi mẫu usage để tính giờ đã dùng của một con: các SID đã gắn
    /// với con đó; mẫu không rõ phiên (sid NULL) chỉ tính cho con mặc định
    /// của máy. Trả về phạm vi rỗng (không SID, không tính mẫu lạ) khi con
    /// là null — nơi gọi không tính gì cho "không có con nào".
    ///
    /// <paramref name="activeSessionSid"/> (Sprint 5 đợt 1, sửa MAJOR-2):
    /// SID của phiên console đang được phân giải — phiên đó ĐÃ được xác định
    /// là con này (qua ánh xạ hoặc qua fallback con mặc định) nên mẫu Tray
    /// mới đóng dấu SID của phiên đó phải được tính cho con này. Nơi gọi chỉ
    /// truyền SID này khi phiên console đã phân giải ra đúng con đang xét;
    /// không truyền (null) thì giữ hành vi cũ. Đây là điểm sửa lỗi đếm 0
    /// trên máy đơn-con: Tray mới đóng dấu SID vào MỌI mẫu, mà máy đơn-con
    /// chưa có ánh xạ thì danh sách SID của con là rỗng — không cộng SID
    /// phiên console vào thì điều kiện "sid IS NULL" không khớp mẫu nào.
    /// </summary>
    public static UsageScope ScopeForChild(Guid? childId, Guid? defaultChildId, IReadOnlyList<ChildAccountLink> links, string? activeSessionSid = null)
    {
        if (childId is null)
        {
            return new UsageScope(Array.Empty<string>(), false);
        }

        var sids = new List<string>();
        foreach (ChildAccountLink link in links)
        {
            if (link.ChildId == childId.Value)
            {
                sids.Add(link.WindowsSid);
            }
        }

        if (activeSessionSid is not null && !sids.Contains(activeSessionSid, StringComparer.Ordinal))
        {
            sids.Add(activeSessionSid);
        }

        return new UsageScope(sids, childId.Value == defaultChildId);
    }
}
