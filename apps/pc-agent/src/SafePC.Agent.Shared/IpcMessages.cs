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

/// <summary>Payload của <see cref="IpcMessageTypes.UsageSample"/>: chỉ metadata, không đường dẫn thô.</summary>
public sealed record UsageSamplePayload(string AppName, string? ExePathHash, DateTimeOffset SampledAt);

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
public sealed record LockPayload(string Reason);

/// <summary>Payload của <see cref="IpcMessageTypes.ExtraTimeRequest"/>.</summary>
public sealed record ExtraTimeRequestPayload(int Minutes, string Reason, DateTimeOffset RequestedAt);

/// <summary>
/// Payload của <see cref="IpcMessageTypes.Hello"/>: Tray báo phiên Windows,
/// tên tài khoản và quyền admin của mình. Service dùng <c>IsAdmin</c> để
/// MIỄN lệnh khóa/cảnh báo cho phiên admin (phụ huynh); phiên chưa giới
/// thiệu (chưa nhận hello) vẫn nhận lệnh như thường — miễn trừ chỉ áp dụng
/// khi đã biết chắc phiên đó là admin.
/// </summary>
public sealed record HelloPayload(int SessionId, string UserName, bool IsAdmin);
