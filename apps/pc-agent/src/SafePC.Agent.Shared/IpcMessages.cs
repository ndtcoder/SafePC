using System.Text.Json;

namespace SafePC.Agent.Shared;

/// <summary>Các loại message IPC giữa Service và Tray App (qua Named Pipe, JSON theo dòng).</summary>
public static class IpcMessageTypes
{
    /// <summary>Tray -> Service: một mẫu app foreground (tên process + hash exe).</summary>
    public const string UsageSample = "usage-sample";

    /// <summary>Tray -> Service: app foreground đã đổi (hoặc heartbeat 60s), để Service thi hành quy tắc theo app.</summary>
    public const string ForegroundChanged = "foreground-changed";

    /// <summary>Service -> Tray: cảnh báo sắp hết giờ.</summary>
    public const string Warning = "warning";

    /// <summary>Service -> Tray: hiện màn hình khóa.</summary>
    public const string Lock = "lock";

    /// <summary>Service -> Tray: đóng màn hình khóa.</summary>
    public const string Unlock = "unlock";

    /// <summary>Tray -> Service: con gửi yêu cầu xin thêm giờ.</summary>
    public const string ExtraTimeRequest = "extra-time-request";

    /// <summary>Tray -> Service: Tray tự giới thiệu khi nối (phiên, tài khoản, quyền admin) để Service chỉ giao lệnh khóa/cảnh báo tới phiên của con.</summary>
    public const string Hello = "hello";

    /// <summary>Tray -> Service: xin thời gian còn lại (quyết định mới nhất của Service). Service trả <see cref="RemainingTimeResponse"/> về đúng writer đã hỏi.</summary>
    public const string RemainingTimeRequest = "remaining-time-request";

    /// <summary>Service -> Tray: trả lời <see cref="RemainingTimeRequest"/>.</summary>
    public const string RemainingTimeResponse = "remaining-time-response";

    /// <summary>Tray -> Service: kiểm tra mã PIN thoát. Service kiểm tra với hash đã đồng bộ, KHÔNG gửi hash xuống Tray.</summary>
    public const string PinVerifyRequest = "pin-verify-request";

    /// <summary>Service -> Tray: trả lời <see cref="PinVerifyRequest"/>.</summary>
    public const string PinVerifyResponse = "pin-verify-response";

    /// <summary>Tray -> Service: con bấm "Nhắn tin với bố mẹ", xin Service cấp phiên chat (RPC migration 29) và trả URL trang chat. Payload KHÔNG mang SID — Service lấy SID từ bản tin hello của đúng kết nối pipe đã hỏi.</summary>
    public const string ChatOpenRequest = "chat-open-request";

    /// <summary>Service -> Tray: trả lời <see cref="ChatOpenRequest"/> — URL trang chat đầy đủ (kèm token phiên trong fragment) hoặc mã lỗi trong <see cref="ChatOpenErrors"/>.</summary>
    public const string ChatOpenResponse = "chat-open-response";
}

/// <summary>
/// Mã lỗi trong câu trả lời mở chat (<see cref="IpcMessageTypes.ChatOpenResponse"/>).
/// Tray dịch từng mã sang câu chữ thân thiện cho con; mã lạ/không có thì
/// Tray rơi về câu lỗi chung. Không mã nào mang dữ liệu nhạy cảm.
/// </summary>
public static class ChatOpenErrors
{
    /// <summary>Máy chưa ghép nối với hồ sơ con nào (chưa có device token).</summary>
    public const string NotPaired = "not_paired";

    /// <summary>Server chưa có RPC cấp phiên chat (migration 29 chưa áp).</summary>
    public const string ChatNotEnabled = "chat_not_enabled";

    /// <summary>Lỗi khác (mất mạng, server từ chối, kết quả không hợp lệ...).</summary>
    public const string Failed = "failed";
}

/// <summary>
/// Một message IPC: loại + payload JSON. Truyền qua Named Pipe theo từng dòng
/// (mỗi dòng là một JSON object). Không chứa token hay secret.
/// </summary>
public sealed record IpcMessage(string Type, string PayloadJson)
{
    public static IpcMessage Create<T>(string type, T payload)
        => new(type, JsonSerializer.Serialize(payload));

    /// <summary>Giải mã payload. Trả về default khi JSON không hợp lệ (không throw).</summary>
    public T? GetPayload<T>()
    {
        try
        {
            return JsonSerializer.Deserialize<T>(PayloadJson);
        }
        catch (JsonException)
        {
            return default;
        }
    }

    /// <summary>Tuần tự hóa thành một dòng để ghi xuống pipe (không chứa ký tự xuống dòng).</summary>
    public string ToLine() => JsonSerializer.Serialize(this);

    /// <summary>Đọc một dòng từ pipe. Trả về null khi dòng không phải message hợp lệ.</summary>
    public static IpcMessage? FromLine(string line)
    {
        try
        {
            return JsonSerializer.Deserialize<IpcMessage>(line);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

/// <summary>Payload của <see cref="IpcMessageTypes.UsageSample"/>: chỉ metadata, không đường dẫn thô.
/// <c>Sid</c> là SID của tài khoản Windows của phiên gửi — Service ĐÓNG DẤU
/// từ bản tin hello của writer đó (quyền quyết định, không tin client gửi),
/// để mẫu usage ghi đúng con nào dùng app (Sprint 5: máy dùng chung). Tray
/// không cần gửi trường này; dòng cũ không có thì Service để null (mẫu
/// không rõ phiên, chỉ tính cho con mặc định của máy).</summary>
public sealed record UsageSamplePayload(string AppName, string? ExePathHash, DateTimeOffset SampledAt, string? Sid = null);

/// <summary>
/// Payload của <see cref="IpcMessageTypes.ForegroundChanged"/>: app đang ở
/// foreground tại một session. <c>ExeName</c> chỉ là TÊN FILE exe (không
/// đường dẫn), null khi không xác định được. <c>SessionId</c> để Service chỉ
/// tác động đúng session đã báo cáo (không bao giờ chạm session 0).
/// </summary>
public sealed record ForegroundChangedPayload(string AppName, string? ExeName, string? ExePathHash, int SessionId, DateTimeOffset ReportedAt);

/// <summary>Payload của <see cref="IpcMessageTypes.Warning"/>.</summary>
public sealed record WarningPayload(int MinutesLeft, string Reason);

/// <summary>Payload của <see cref="IpcMessageTypes.Lock"/>.</summary>
/// <summary>Lệnh khóa: Tray hiện màn hình khóa toàn màn hình. <c>Immediate</c> = true khi lệnh khóa tới sau khi độ trễ cảnh báo đã hết — con đã có thời gian lưu bài trong lúc chờ nên màn hình khóa không đếm ngược 60 giây nữa mà khóa phiên ngay (yêu cầu test máy thật 17/11/2026). Mặc định false để JSON cũ (không có trường này) vẫn hiểu là khóa có đếm ngược như trước.</summary>
public sealed record LockPayload(string Reason, bool Immediate = false);

/// <summary>Payload của <see cref="IpcMessageTypes.ExtraTimeRequest"/>.
/// <c>Sid</c> là SID của tài khoản Windows của phiên gửi — Service ĐÓNG DẤU
/// từ bản tin hello của writer đó (quyền quyết định), để đợt sau biết yêu
/// cầu này là của con nào (Sprint 5). RPC hiện tại
/// (<c>safepc_push_extra_time_request</c>, migration 7) chưa nhận SID nên
/// server vẫn ghi theo con mặc định của máy; trường này để sẵn cho lần
/// migration sau bổ sung tham số SID vào RPC đó.</summary>
public sealed record ExtraTimeRequestPayload(int Minutes, string Reason, DateTimeOffset RequestedAt, string? Sid = null);

/// <summary>
/// Payload của <see cref="IpcMessageTypes.Hello"/>: Tray báo phiên Windows,
/// tên tài khoản và quyền admin của mình. Service dùng <c>IsAdmin</c> để
/// MIỄN lệnh khóa/cảnh báo cho phiên admin (phụ huynh); phiên chưa giới
/// thiệu (chưa nhận hello) vẫn nhận lệnh như thường — miễn trừ chỉ áp dụng
/// khi đã biết chắc phiên đó là admin.
/// <c>Sid</c> là SID của tài khoản Windows đang chạy Tray
/// (<c>WindowsIdentity.GetCurrent().User.Value</c>), để Service biết phiên
/// này là hồ sơ con nào trên máy dùng chung (Sprint 5, bảng
/// <c>device_child_accounts</c> — ánh xạ theo SID cho bền khi đổi tên tài
/// khoản). Tham số tùy chọn để phía gửi cũ (self-test giả lập) vẫn biên
/// dịch và phía nhận cũ vẫn giải mã được khi thiếu trường này; thiếu SID
/// thì Service coi phiên như chưa rõ danh tính (fallback con mặc định).
/// </summary>
public sealed record HelloPayload(int SessionId, string UserName, bool IsAdmin, string? Sid = null);

/// <summary>
/// Payload của <see cref="IpcMessageTypes.RemainingTimeRequest"/>: chỉ mang
/// id để Tray đối chiếu câu trả lời (pipe đa message, câu trả lời đến muộn
/// của lần hỏi trước không được tính cho lần hỏi sau).
/// </summary>
public sealed record RemainingTimeRequestPayload(string RequestId);

/// <summary>
/// Payload của <see cref="IpcMessageTypes.RemainingTimeResponse"/>.
/// <c>Decision</c>: "allow" | "warn" | "lock" | "unknown" (Service chưa đánh
/// giá lần nào). <c>MinutesLeft</c> null = không giới hạn (hoặc chưa biết).
/// <c>BonusMinutes</c>: phút thưởng thêm đang hiệu lực (ghi đè bonus_minutes
/// còn hạn — ngân hàng giờ), null khi không có; Tray hiện cho con thấy giờ
/// thưởng của mình. Tham số tùy chọn để phía gửi cũ (self-test giả lập)
/// vẫn biên dịch và phía nhận cũ vẫn giải mã được khi thiếu trường này.
/// <c>RequestId</c> vọng lại id của câu hỏi.
/// </summary>
public sealed record RemainingTimeResponsePayload(string Decision, int? MinutesLeft, string Reason, DateTimeOffset EvaluatedAt, string RequestId, int? BonusMinutes = null);

/// <summary>
/// Payload của <see cref="IpcMessageTypes.PinVerifyRequest"/>: PIN con/người
/// dùng vừa nhập + id để đối chiếu câu trả lời. PIN chỉ đi trên pipe nội bộ
/// của máy, không bao giờ ghi log.
/// </summary>
public sealed record PinVerifyRequestPayload(string Pin, string RequestId);

/// <summary>
/// Payload của <see cref="IpcMessageTypes.PinVerifyResponse"/>.
/// <c>PinConfigured</c> false = phụ huynh chưa đặt PIN (không PIN nào đúng).
/// <c>LockedOut</c> true = đã sai quá số lần cho phép, phải chờ.
/// <c>RemainingAttempts</c>: số lần thử còn lại trước khi bị khóa.
/// <c>RequestId</c> vọng lại id của câu hỏi.
/// </summary>
public sealed record PinVerifyResponsePayload(bool Verified, bool LockedOut, int RemainingAttempts, bool PinConfigured, string RequestId);

/// <summary>
/// Payload của <see cref="IpcMessageTypes.ChatOpenRequest"/>: chỉ mang id để
/// Tray đối chiếu câu trả lời. CỐ Ý không mang SID hay thông tin tài khoản —
/// Service lấy SID của phiên từ bản tin hello của đúng kết nối pipe đã gửi
/// câu hỏi (quyền quyết định phía server, không tin payload).
/// </summary>
public sealed record ChatOpenRequestPayload(string RequestId);

/// <summary>
/// Payload của <see cref="IpcMessageTypes.ChatOpenResponse"/>.
/// <c>Ok</c> true thì <c>Url</c> là URL trang chat đầy đủ (token phiên nằm
/// trong fragment của URL — chỉ đi trên pipe nội bộ máy tới đúng Tray đã
/// hỏi, KHÔNG bao giờ ghi log ở cả hai phía). <c>Ok</c> false thì
/// <c>Error</c> là một mã trong <see cref="ChatOpenErrors"/> và
/// <c>Url</c> null. <c>RequestId</c> vọng lại id của câu hỏi.
/// </summary>
public sealed record ChatOpenResponsePayload(bool Ok, string? Url, string? Error, string RequestId);
