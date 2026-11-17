using System.IO.Pipes;
using System.Text;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>
/// Tự kiểm tra đường gửi IPC của Service (chạy bằng
/// SafePC.Agent.Service.exe --self-test-ipc, chỉ dùng trên CI): khởi động
/// IpcPipeServer THẬT (không khởi động AgentWorker nên không chạm Supabase),
/// nối một client pipe giả vào, gửi một usage-sample lên để chạy đường đọc
/// của server, rồi khẳng định SendToTrayAsync giao message lock/unlock tới
/// ≥1 writer và client nhận đủ cả hai dòng. Lỗi "handler đã nối nhưng danh
/// sách writer rỗng" (bản 0.1.122) phải bị bắt ở đây.
///
/// Ghi kết quả ra CẢ log file (LocalLogger) lẫn console để CI đọc trực tiếp.
/// Thoát 0 khi mọi check đạt, 1 khi có check trượt.
///
/// GIỚI HẠN (review batch #6): cổng này chạy cùng user/cùng session nên
/// không kiểm chứng ranh giới ACL SYSTEM↔user, đa session, hay idle-timeout
/// 120s — nó không thay thế test trên máy thật với Service chạy quyền SYSTEM
/// + Tray ở session của con.
/// </summary>
public static class SelfTestIpc
{
    public static async Task<int> RunAsync(IHost host)
    {
        LocalLogger log = host.Services.GetRequiredService<LocalLogger>();
        OutboxStore outbox = host.Services.GetRequiredService<OutboxStore>();
        IpcPipeServer server = host.Services.GetRequiredService<IpcPipeServer>();

        int passed = 0;
        int total = 0;
        void Check(string name, bool ok)
        {
            total++;
            if (ok)
            {
                passed++;
            }

            string line = "SELF-TEST-IPC: [" + (ok ? "PASS" : "FAIL") + "] " + name;
            log.Info(line);
            Console.WriteLine(line);
        }

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        try
        {
            string started = "SELF-TEST-IPC: bắt đầu (phiên bản " + AgentConstants.AgentVersion + ").";
            log.Info(started);
            Console.WriteLine(started);

            // AgentWorker (không khởi động ở chế độ này) là nơi duy nhất gọi
            // InitializeAsync lúc chạy thật — test phải tự tạo schema SQLite,
            // nếu không usage-sample gửi lên sẽ lỗi "no such table", handler
            // chết và lock/unlock sau đó không còn writer nào để giao.
            await outbox.InitializeAsync(cts.Token);

            await server.StartAsync(cts.Token);

            using var client = new NamedPipeClientStream(".", AgentConstants.IpcPipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
            await client.ConnectAsync(cts.Token);
            // Tới được đây nghĩa là ConnectAsync đã thành công — KHÔNG dùng
            // IsConnected để khẳng định (cờ này có thể báo false giả ngay
            // sau khi nối thành công; xem ghi chú ở IpcPipeClient).
            Check("client giả nối tới IpcPipeServer", true);

            using var reader = new StreamReader(client, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, bufferSize: 1024, leaveOpen: true);
            using var writer = new StreamWriter(client, Encoding.UTF8, bufferSize: 1024, leaveOpen: true) { AutoFlush = true };

            // Gửi một usage-sample lên để chạy đường đọc của server (thread
            // đọc + Channel + HandleMessageAsync + ghi SQLite), rồi KHẲNG
            // ĐỊNH server đã xử lý nó: poll bảng usage_samples tới khi thấy
            // mẫu "self-test". Không có khẳng định này thì một thread đọc
            // của server bị kẹt (park) sẽ không làm test trượt.
            await writer.WriteLineAsync(IpcMessage.Create(
                IpcMessageTypes.UsageSample,
                new UsageSamplePayload("self-test", null, DateTimeOffset.UtcNow)).ToLine());
            bool sampleProcessed = false;
            for (int i = 0; i < 10 && !sampleProcessed; i++)
            {
                await Task.Delay(500, cts.Token);
                IReadOnlyDictionary<string, TimeSpan> usage = await outbox.GetUsageByAppTodayAsync(cts.Token);
                sampleProcessed = usage.ContainsKey("self-test");
            }

            Check("server xử lý usage-sample gửi lên", sampleProcessed);

            // Lock: gửi lại tới khi giao được (tối đa ~10s) — ConnectAsync
            // trả về ngay khi server chấp nhận, nhưng writer chỉ được đăng
            // ký SAU ĐÓ trong handler chạy nền, nên lần gửi đầu có thể thấy
            // 0 writer dù kết nối đã xong. DỪNG NGAY ở lần gửi thành công
            // đầu tiên: lần gửi thất bại (0 writer) không ghi dòng nào xuống
            // pipe nên không tạo message trùng; gửi lại sau khi đã thành
            // công sẽ tạo 2 dòng lock và làm check unlock đọc nhầm.
            // (Review batch #6.)
            int lockSent = 0;
            for (int i = 0; i < 50 && lockSent < 1; i++)
            {
                lockSent = await server.SendToTrayAsync(
                    IpcMessage.Create(IpcMessageTypes.Lock, new LockPayload("Self-test khóa/mở.")), cts.Token);
                if (lockSent < 1)
                {
                    await Task.Delay(200, cts.Token);
                }
            }

            Check("SendToTrayAsync(lock) giao tới ≥1 writer", lockSent >= 1);
            string? lockLine = await ReadLineWithTimeoutAsync(reader, client, TimeSpan.FromSeconds(5));
            Check("client giả nhận được message lock", lockLine is not null && IpcMessage.FromLine(lockLine)?.Type == IpcMessageTypes.Lock);

            // Unlock: tương tự.
            int unlockSent = await server.SendToTrayAsync(
                IpcMessage.Create(IpcMessageTypes.Unlock, new { }), cts.Token);
            Check("SendToTrayAsync(unlock) giao tới ≥1 writer", unlockSent >= 1);
            string? unlockLine = await ReadLineWithTimeoutAsync(reader, client, TimeSpan.FromSeconds(5));
            Check("client giả nhận được message unlock", unlockLine is not null && IpcMessage.FromLine(unlockLine)?.Type == IpcMessageTypes.Unlock);

            await server.StopAsync(cts.Token);
        }
        catch (Exception ex)
        {
            log.Error("SELF-TEST-IPC: lỗi ngoài dự kiến, tính là TRƯỢT.", ex);
            Console.WriteLine("SELF-TEST-IPC: lỗi ngoài dự kiến: " + ex.Message);
            Check("không lỗi ngoài dự kiến", false);
        }

        string result = "SELF-TEST-IPC: " + (passed == total ? "PASS" : "FAIL") + " (" + passed + "/" + total + " check đạt).";
        log.Info(result);
        Console.WriteLine(result);
        return passed == total ? 0 : 1;
    }

    /// <summary>
    /// Đọc một dòng với giới hạn chờ: đọc đồng bộ trên thread riêng, quá hạn
    /// thì dispose client để giải phóng lần đọc (đúng mẫu production — hủy
    /// token không abort được lần đọc pipe). Trả về null khi quá hạn.
    /// </summary>
    private static async Task<string?> ReadLineWithTimeoutAsync(StreamReader reader, NamedPipeClientStream client, TimeSpan timeout)
    {
        Task<string?> readTask = Task.Run(() => reader.ReadLine());
        Task done = await Task.WhenAny(readTask, Task.Delay(timeout)).ConfigureAwait(false);
        if (done != readTask)
        {
            try
            {
                client.Dispose();
            }
            catch
            {
                // Bỏ qua lỗi đóng client sau timeout.
            }

            try
            {
                await readTask.ConfigureAwait(false);
            }
            catch
            {
                // Lần đọc bị bỏ kết thúc bằng lỗi sau khi dispose.
            }

            return null;
        }

        return await readTask.ConfigureAwait(false);
    }
}
