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

        void Trace(string step)
        {
            string line = "SELF-TEST-IPC: [debug] " + step;
            log.Info(line);
            Console.WriteLine(line);
        }

        // Watchdog cứng (run #129: test treo đủ 60s không một dòng log, bị
        // CI hủy mù): nếu RunAsync chưa xong sau 45s thì ép thoát kèm dấu
        // vết rõ ràng; breadcrumb gần nhất sẽ cho biết điểm treo. Test bình
        // thường xong trong vài giây nên watchdog không bao giờ kích hoạt.
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _ = Task.Run(async () =>
        {
            Task finished = await Task.WhenAny(Task.Delay(TimeSpan.FromSeconds(45)), done.Task).ConfigureAwait(false);
            if (finished != done.Task)
            {
                string stuck = "SELF-TEST-IPC: WATCHDOG: test chưa xong sau 45s, ép thoát (xem breadcrumb gần nhất để biết điểm treo).";
                log.Error(stuck);
                Console.WriteLine(stuck);
                Environment.Exit(2);
            }
        });

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
            Trace("đang tạo schema SQLite (InitializeAsync)...");
            await outbox.InitializeAsync(cts.Token);
            Trace("schema SQLite xong, đang khởi động IpcPipeServer...");
            await server.StartAsync(cts.Token);
            Trace("IpcPipeServer đã khởi động, client giả đang nối tới...");

            using var client = new NamedPipeClientStream(".", AgentConstants.IpcPipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
            await client.ConnectAsync(cts.Token);
            // Tới được đây nghĩa là ConnectAsync đã thành công — KHÔNG dùng
            // IsConnected để khẳng định (cờ này có thể báo false giả ngay
            // sau khi nối thành công; xem ghi chú ở IpcPipeClient).
            Check("client giả nối tới IpcPipeServer", true);

            // Breadcrumb mịn (run #131: main task im lặng giữa check 1 và
            // Trace gửi sample — khoảng giữa chỉ có 2 ctor StreamReader/
            // StreamWriter, về lý thuyết không thể chặn. Các dòng này xác
            // định chính xác ctor nào (nếu có) là điểm treo.)
            Trace("sau check 1, sắp tạo StreamReader...");
            using var reader = new StreamReader(client, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, bufferSize: 1024, leaveOpen: true);
            Trace("đã tạo StreamReader, sắp tạo StreamWriter...");
            // KHÔNG dùng AutoFlush trên pipe (xem ghi chú ở IpcPipeServer):
            // setter gọi Flush() → FlushFileBuffers chặn tới khi handler
            // phía server ĐỌC — chết chéo vì handler cũng đang kẹt ở ctor
            // StreamWriter của nó (run CI #133). Lần ghi sample dưới đây
            // FlushAsync tường minh.
            using var writer = new StreamWriter(client, Encoding.UTF8, bufferSize: 1024, leaveOpen: true);
            Trace("đã tạo StreamWriter.");

            // Gửi một usage-sample lên để chạy đường đọc của server (thread
            // đọc + Channel + HandleMessageAsync + ghi SQLite), rồi KHẲNG
            // ĐỊNH server đã xử lý nó: poll bảng usage_samples tới khi thấy
            // mẫu "self-test". Không có khẳng định này thì một thread đọc
            // của server bị kẹt (park) sẽ không làm test trượt.
            Trace("đang gửi usage-sample lên server...");
            await writer.WriteLineAsync(IpcMessage.Create(
                IpcMessageTypes.UsageSample,
                new UsageSamplePayload("self-test", null, DateTimeOffset.UtcNow)).ToLine());
            // Flush tường minh (thay cho AutoFlush đã bỏ): không flush thì
            // dòng sample nằm trong buffer, thread đọc của server không bao
            // giờ thấy. Flush lúc này an toàn vì thread đọc của handler chạy
            // độc lập, không phụ thuộc vào lần flush này — nó đọc dòng
            // sample rồi flush mới hoàn tất.
            await writer.FlushAsync();
            Trace("đã gửi usage-sample, đang poll bảng usage_samples...");
            bool sampleProcessed = false;
            for (int i = 0; i < 10 && !sampleProcessed; i++)
            {
                await Task.Delay(500, cts.Token);
                IReadOnlyDictionary<string, TimeSpan> usage = await outbox.GetUsageByAppTodayAsync(cts.Token);
                sampleProcessed = usage.ContainsKey("self-test");
                Trace("poll lần " + (i + 1) + "/10: thấy self-test=" + sampleProcessed + ".");
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
            Trace("đang gửi lock (thử lại tới khi giao được)...");
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
            Trace("đang chờ client giả nhận message lock (tối đa 5s)...");
            string? lockLine = await ReadLineWithTimeoutAsync(reader, client, TimeSpan.FromSeconds(5));
            Trace("chờ lock xong: nhận được dòng=" + (lockLine is not null) + ".");
            Check("client giả nhận được message lock", lockLine is not null && IpcMessage.FromLine(lockLine)?.Type == IpcMessageTypes.Lock);

            // Unlock: tương tự.
            Trace("đang gửi unlock...");
            int unlockSent = await server.SendToTrayAsync(
                IpcMessage.Create(IpcMessageTypes.Unlock, new { }), cts.Token);
            Check("SendToTrayAsync(unlock) giao tới ≥1 writer", unlockSent >= 1);
            Trace("đang chờ client giả nhận message unlock (tối đa 5s)...");
            string? unlockLine = await ReadLineWithTimeoutAsync(reader, client, TimeSpan.FromSeconds(5));
            Trace("chờ unlock xong: nhận được dòng=" + (unlockLine is not null) + ".");
            Check("client giả nhận được message unlock", unlockLine is not null && IpcMessage.FromLine(unlockLine)?.Type == IpcMessageTypes.Unlock);

            Trace("đang dừng IpcPipeServer...");
            await server.StopAsync(cts.Token);
            Trace("IpcPipeServer đã dừng.");
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
        done.TrySetResult();
        return passed == total ? 0 : 1;
    }

    /// <summary>
    /// Đọc một dòng với giới hạn chờ: đọc đồng bộ trên thread riêng, quá hạn
    /// thì dispose client để giải phóng lần đọc (đúng mẫu production — hủy
    /// token không abort được lần đọc pipe). Sau khi dispose chỉ chờ lần đọc
    /// bị bỏ tối đa 2s rồi bỏ mặc: chờ mãi ở đây sẽ treo cả test nếu dispose
    /// không giải phóng được lần đọc (điểm treo nghi vấn ở run #129). Trả về
    /// null khi quá hạn.
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
                await readTask.WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false);
            }
            catch
            {
                // Lần đọc bị bỏ kết thúc bằng lỗi sau khi dispose, hoặc vẫn
                // kẹt sau 2s — bỏ mặc, không chờ nữa (xem ghi chú ở đầu
                // phương thức). Thread nền bị bỏ sẽ chết cùng process.
            }

            return null;
        }

        return await readTask.ConfigureAwait(false);
    }
}
