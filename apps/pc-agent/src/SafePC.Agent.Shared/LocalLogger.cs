namespace SafePC.Agent.Shared;

/// <summary>
/// Logger local đơn giản, ghi ra file text với xoay vòng.
/// - Tối đa 10MB/file (docs/03-SECURITY.md mục 4), giữ tối đa
///   <see cref="AgentConstants.MaxLogBackupFiles"/> file cũ.
/// - An toàn đa luồng (lock), không bao giờ throw: logger lỗi thì bỏ qua,
///   không được làm crash Service/Tray.
/// - KHÔNG ghi token, mật khẩu, PIN hay đường dẫn exe thô vào log. Nơi gọi
///   chịu trách nhiệm không truyền secret vào message.
/// </summary>
public sealed class LocalLogger
{
    private readonly string _filePath;
    private readonly object _gate = new();

    public LocalLogger(string filePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(filePath);
        _filePath = filePath;

        string? directory = Path.GetDirectoryName(filePath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }
    }

    public void Info(string message) => Write("INFO", message);

    public void Warning(string message) => Write("WARN", message);

    public void Error(string message, Exception? exception = null)
    {
        string full = exception is null
            ? message
            : message + " | " + exception.GetType().Name + ": " + exception.Message;
        Write("ERROR", full);
    }

    private void Write(string level, string message)
    {
        lock (_gate)
        {
            try
            {
                RotateIfNeeded();
                string line = $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz} [{level}] {message}{Environment.NewLine}";
                File.AppendAllText(_filePath, line);
            }
            catch
            {
                // Logger không được làm crash agent: nuốt lỗi ghi log.
            }
        }
    }

    private void RotateIfNeeded()
    {
        try
        {
            var info = new FileInfo(_filePath);
            if (!info.Exists || info.Length < AgentConstants.MaxLogFileBytes)
            {
                return;
            }

            // Đổi tên: agent.log -> agent.log.1 -> agent.log.2 ... (giữ tối đa N file cũ).
            for (int i = AgentConstants.MaxLogBackupFiles; i >= 1; i--)
            {
                string source = i == 1 ? _filePath : _filePath + "." + (i - 1);
                string destination = _filePath + "." + i;
                if (File.Exists(source))
                {
                    File.Move(source, destination, overwrite: true);
                }
            }
        }
        catch
        {
            // Xoay vòng thất bại thì cứ ghi tiếp vào file hiện tại.
        }
    }
}
