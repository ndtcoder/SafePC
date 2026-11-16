using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
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
/// TODO Sprint 2: thu hẹp ACL theo session của con + xác thực message, và
/// chỉ gửi cảnh báo/khóa tới session của con thay vì broadcast mọi client.
/// </summary>
public sealed class IpcPipeServer : BackgroundService
{
    private readonly OutboxStore _outbox;
    private readonly LocalLogger _log;
    private readonly ForegroundState _foregroundState;
    private readonly SemaphoreSlim _writeGate = new(1, 1);
    private readonly System.Collections.Generic.HashSet<StreamWriter> _clientWriters = new();
    private readonly object _writersLock = new();

    public IpcPipeServer(OutboxStore outbox, LocalLogger log, ForegroundState foregroundState)
    {
        _outbox = outbox;
        _log = log;
        _foregroundState = foregroundState;
    }

    /// <summary>
    /// Gửi một message xuống mọi Tray App đang kết nối. Nếu chưa Tray nào kết
    /// nối thì bỏ qua (ghi log) chứ không xếp hàng — cảnh báo/khóa sẽ được
    /// gửi lại ở lần kiểm tra rules tiếp theo.
    /// </summary>
    public async Task SendToTrayAsync(IpcMessage message, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(message);

        System.Collections.Generic.List<StreamWriter> writers;
        lock (_writersLock)
        {
            writers = _clientWriters.ToList();
        }

        if (writers.Count == 0)
        {
            _log.Info("IPC: Tray chưa kết nối, bỏ qua message " + message.Type + ".");
            return;
        }

        string line = message.ToLine();
        await _writeGate.WaitAsync(ct);
        try
        {
            foreach (StreamWriter writer in writers)
            {
                try
                {
                    await writer.WriteLineAsync(line);
                    await writer.FlushAsync();
                }
                catch (Exception ex)
                {
                    _log.Error("IPC: không gửi được message tới một Tray, gỡ khỏi danh sách.", ex);
                    lock (_writersLock)
                    {
                        _clientWriters.Remove(writer);
                    }
                }
            }
        }
        finally
        {
            _writeGate.Release();
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            NamedPipeServerStream? server = null;
            try
            {
                server = CreatePipeServer();
                _log.Info("IPC: chờ Tray App kết nối...");
                await server.WaitForConnectionAsync(stoppingToken);
                _log.Info("IPC: Tray App đã kết nối.");
                // Không await handler: giao kết nối cho task nền rồi quay
                // lại tạo pipe instance mới ngay, để client khác nối được.
                // Handler tự dispose stream khi xong (xem HandleClientAsync).
                _ = HandleClientAsync(server, stoppingToken);
                server = null;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                server?.Dispose();
                break;
            }
            catch (Exception ex)
            {
                server?.Dispose();
                _log.Error("IPC server lỗi, thử lại sau 5 giây.", ex);
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }
    }

    /// <summary>Tạo pipe server với ACL: SYSTEM toàn quyền, Users đọc/ghi.</summary>
    private static NamedPipeServerStream CreatePipeServer()
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

        return NamedPipeServerStreamAcl.Create(
            AgentConstants.IpcPipeName,
            PipeDirection.InOut,
            // Cho phép nhiều instance chờ sẵn để nhiều session nối cùng lúc.
            maxNumberOfServerInstances: 8,
            transmissionMode: PipeTransmissionMode.Byte,
            options: PipeOptions.Asynchronous,
            inBufferSize: 0,
            outBufferSize: 0,
            pipeSecurity: security);
    }

    private async Task HandleClientAsync(NamedPipeServerStream server, CancellationToken ct)
    {
        // Handler chạy nền, không được ném exception ra ngoài (ExecuteAsync
        // không await nó) — mọi lỗi đều ghi log tại đây. Stream do handler
        // sở hữu và dispose khi xong.
        StreamWriter? writer = null;
        try
        {
            using var reader = new StreamReader(server, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, bufferSize: 1024, leaveOpen: true);
            writer = new StreamWriter(server, Encoding.UTF8, bufferSize: 1024, leaveOpen: true) { AutoFlush = true };
            lock (_writersLock)
            {
                _clientWriters.Add(writer);
            }

            // KHÔNG kiểm tra server.IsConnected (cờ này không đáng tin —
            // xem ghi chú ở IpcPipeClient): chỉ thoát khi đọc được null
            // hoặc ném exception.
            while (!ct.IsCancellationRequested)
            {
                string? line = await reader.ReadLineAsync();
                if (line is null)
                {
                    break;
                }

                IpcMessage? message = IpcMessage.FromLine(line);
                if (message is not null)
                {
                    await HandleMessageAsync(message, ct);
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Service đang dừng.
        }
        catch (Exception ex)
        {
            _log.Error("IPC: lỗi khi đọc từ Tray App.", ex);
        }
        finally
        {
            if (writer is not null)
            {
                lock (_writersLock)
                {
                    _clientWriters.Remove(writer);
                }

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

            _log.Info("IPC: Tray App đã ngắt kết nối.");
        }
    }

    private async Task HandleMessageAsync(IpcMessage message, CancellationToken ct)
    {
        switch (message.Type)
        {
            case IpcMessageTypes.UsageSample:
                UsageSamplePayload? sample = message.GetPayload<UsageSamplePayload>();
                if (sample is not null)
                {
                    await _outbox.RecordUsageSampleAsync(sample, ct);
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
                // TODO Sprint 2: ghi yêu cầu vào bảng requests qua Supabase để
                // phụ huynh duyệt trên Dashboard, rồi nhận quyết định qua commands.
                _log.Info("IPC: nhận yêu cầu xin thêm giờ (skeleton, chưa gửi lên server).");
                break;

            default:
                _log.Warning("IPC: message không rõ loại, bỏ qua: " + message.Type);
                break;
        }
    }
}
