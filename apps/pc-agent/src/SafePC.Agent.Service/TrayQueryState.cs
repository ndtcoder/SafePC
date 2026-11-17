namespace SafePC.Agent.Service;

/// <summary>
/// Trạng thái Service chia sẻ cho các câu hỏi của Tray qua IPC — cùng mẫu
/// với <see cref="ForegroundState"/> (một singleton nhỏ, khóa đơn giản):
/// quyết định thi hành mới nhất (để Tray trả lời "thời gian còn lại") và
/// hash mã PIN thoát đã đồng bộ từ server (để Service kiểm tra PIN mà
/// không phải gửi hash xuống Tray).
///
/// Đăng ký singleton trong DI; AgentWorker ghi, IpcPipeServer đọc.
/// </summary>
public sealed class TrayQueryState
{
    private readonly object _gate = new();
    private RuleDecision? _latestDecision;
    private DateTimeOffset _latestDecisionAt;
    private string? _exitPinHash;

    /// <summary>Ghi quyết định mới nhất của vòng kiểm tra rules (đã gồm mọi ghi đè/nghỉ bắt buộc/khóa có độ trễ).</summary>
    public void UpdateDecision(RuleDecision decision, DateTimeOffset evaluatedAt)
    {
        ArgumentNullException.ThrowIfNull(decision);
        lock (_gate)
        {
            _latestDecision = decision;
            _latestDecisionAt = evaluatedAt;
        }
    }

    /// <summary>Đọc quyết định mới nhất. Trả về false khi Service chưa đánh giá lần nào.</summary>
    public bool TryGetDecision(out RuleDecision decision, out DateTimeOffset evaluatedAt)
    {
        lock (_gate)
        {
            if (_latestDecision is null)
            {
                decision = null!;
                evaluatedAt = default;
                return false;
            }

            decision = _latestDecision;
            evaluatedAt = _latestDecisionAt;
            return true;
        }
    }

    /// <summary>
    /// Ghi hash mã PIN thoát từ heartbeat. Trả về true khi giá trị ĐỔI so với
    /// lần trước (kể cả đổi thành null = phụ huynh đã gỡ PIN) để AgentWorker
    /// chỉ ghi log khi có thay đổi. Hash không bao giờ được ghi log.
    /// </summary>
    public bool UpdatePinHash(string? exitPinHash)
    {
        lock (_gate)
        {
            if (string.Equals(_exitPinHash, exitPinHash, StringComparison.Ordinal))
            {
                return false;
            }

            _exitPinHash = string.IsNullOrWhiteSpace(exitPinHash) ? null : exitPinHash;
            return true;
        }
    }

    /// <summary>Hash mã PIN hiện tại, hoặc null khi phụ huynh chưa đặt PIN. Chỉ Service đọc.</summary>
    public string? ExitPinHash
    {
        get
        {
            lock (_gate)
            {
                return _exitPinHash;
            }
        }
    }
}
