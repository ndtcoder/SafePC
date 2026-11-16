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
/// TODO Sprint 2: thu hẹp ACL theo session của con + xác thực message, và hỗ trợ
/// nhiều client (mỗi user session một kết nối) thay vì một client như hiện tại.
/// </summary>
public sealed class IpcPipeServer : BackgroundService
{
    private readonly OutboxStore _outbox;
    private readonly LocalLogger _log;
    private readonly SemaphoreSlim _writeGate = new(1, 1);

    private StreamWriter? _clientWriter;

    public IpcPipeServer(OutboxStore outbox, LocalLogger log)
    {
        _outbox = outbox;
        _log = log;
    }

    /// <summary>
    /// Gửi một message xuống Tray App đang kết nối. Nếu Tray chưa kết nối thì
    /// bỏ qua (ghi log) chứ không xếp hàng — cảnh báo/khóa sẽ được gửi lại ở
    /// lần kiểm tra rules tiếp theo.
    /// </summary>
    public async Task SendToTrayAsync(IpcMessage message, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(message);

        StreamWriter? writer = _clientWriter;
        if (writer is null)
        {
            _log.Info("IPC: Tray chưa kết nối, bỏ qua message " + message.Type + ".");
            return;
        }

        await _writeGate.WaitAsync(ct);
        try
        {
            await writer.WriteLineAsync(message.ToLine());
            await writer.FlushAsync();
        }
        catch (Exception ex)
        {
            _log.Error("IPC: không gửi được message tới Tray.", ex);
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
            try
            {
                await using var server = CreatePipeServer();
                _log.Info("IPC: chờ Tray App kết nối...");
                await server.WaitForConnectionAsync(stoppingToken);
                _log.Info("IPC: Tray App đã kết nối.");
                await HandleClientAsync(server, stoppingToken);
                _log.Info("IPC: Tray App đã ngắt kết nối.");
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
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
            maxNumberOfServerInstances: 1,
            transmissionMode: PipeTransmissionMode.Byte,
            options: PipeOptions.Asynchronous,
            inBufferSize: 0,
            outBufferSize: 0,
            pipeSecurity: security);
    }

    private async Task HandleClientAsync(NamedPipeServerStream server, CancellationToken ct)
    {
        using var reader = new StreamReader(server, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, bufferSize: 1024, leaveOpen: true);
        var writer = new StreamWriter(server, Encoding.UTF8, bufferSize: 1024, leaveOpen: true) { AutoFlush = true };
        _clientWriter = writer;

        try
        {
            while (!ct.IsCancellationRequested && server.IsConnected)
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
            if (ReferenceEquals(_clientWriter, writer))
            {
                _clientWriter = null;
            }

            writer.Dispose();
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
