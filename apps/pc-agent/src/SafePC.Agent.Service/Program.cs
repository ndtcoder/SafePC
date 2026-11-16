using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using SafePC.Agent.Service;
using SafePC.Agent.Shared;

// SafePC Agent Service — chạy quyền SYSTEM dưới dạng Windows Service.
// Điểm vào dùng Host.CreateDefaultBuilder + UseWindowsService theo mẫu chuẩn
// của Microsoft.Extensions.Hosting.WindowsServices (.NET 8).
//
// Dữ liệu local đặt dưới %ProgramData%\SafePC (ghi được ở quyền SYSTEM,
// Standard User không sửa được):
//   - agent.db          : hàng đợi offline SQLite + cache rules
//   - device_token.dat  : device token mã hóa bằng DPAPI
//   - logs\             : log local (xoay vòng, tối đa 10MB/file)

var builder = Host.CreateDefaultBuilder(args);

builder.UseWindowsService(options =>
{
    options.ServiceName = AgentConstants.ServiceName;
});

builder.ConfigureServices((context, services) =>
{
    string programData = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "SafePC");

    services.AddSingleton(new LocalLogger(Path.Combine(programData, "logs", "agent-service.log")));
    services.AddSingleton(new TokenStore(Path.Combine(programData, "device_token.dat")));
    services.AddSingleton(new OutboxStore(Path.Combine(programData, "agent.db")));
    services.AddSingleton<RuleEngine>();
    services.AddHttpClient<SupabaseApiClient>();

    // IpcPipeServer vừa là singleton (để AgentWorker gửi message xuống Tray)
    // vừa là hosted service (vòng lặp chờ kết nối pipe).
    services.AddSingleton<IpcPipeServer>();
    services.AddHostedService(provider => provider.GetRequiredService<IpcPipeServer>());
    services.AddHostedService<AgentWorker>();
});

var host = builder.Build();
await host.RunAsync();
