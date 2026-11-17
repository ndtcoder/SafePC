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
/// ≥1 writer và client nhận đủ cả hai dòng; khẳng định extra-time-request
/// được xếp vào outbox; khẳng định pin-verify (đúng thì đạt, sai thì trượt
/// và trừ lần thử) và remaining-time-request trả về quyết định mới nhất;
/// khẳng định hello từ phiên không phải admin thì nhận ngay lệnh khóa đang
/// hiệu lực (đồng bộ trạng thái khi Tray mới nối); cuối cùng client gửi
/// hello IsAdmin=true và khẳng định lệnh lock không còn giao tới writer nào
/// (miễn trừ phiên admin). Lỗi "handler đã nối nhưng danh sách writer rỗng"
/// (bản 0.1.122) phải bị bắt ở đây.
/// Tổng 13 check.
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
        TrayQueryState queryState = host.Services.GetRequiredService<TrayQueryState>();

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
            // ĐỌC PHẢI CHẠY ĐỒNG THỜI VỚI GỬI (run #135): FlushAsync của
            // SendToTrayAsync chặn tới khi đầu kia đọc (FlushFileBuffers),
            // nên gửi-tuần-tự-rồi-mới-đọc sẽ chết chéo — lần gửi đầu kẹt ở
            // flush, task đọc chưa bao giờ bắt đầu, CTS 30s mới phá được
            // vòng chờ (FAIL 2/3). Bắt đầu task đọc TRƯỚC khi gửi, rồi chờ
            // cả hai. Task đọc dài 15s để bao hết vòng thử lại (~10s).
            Trace("đang bắt đầu đọc lock đồng thời, rồi gửi lock (thử lại tới khi giao được)...");
            Task<string?> lockReadTask = ReadLineWithTimeoutAsync(reader, client, TimeSpan.FromSeconds(15));
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
            Trace("đang chờ task đọc lock xong...");
            string? lockLine = await lockReadTask;
            Trace("chờ lock xong: nhận được dòng=" + (lockLine is not null) + ".");
            Check("client giả nhận được message lock", lockLine is not null && IpcMessage.FromLine(lockLine)?.Type == IpcMessageTypes.Lock);

            // Unlock: tương tự — đọc đồng thời với gửi (xem ghi chú ở lock).
            Trace("đang bắt đầu đọc unlock đồng thời, rồi gửi unlock...");
            Task<string?> unlockReadTask = ReadLineWithTimeoutAsync(reader, client, TimeSpan.FromSeconds(5));
            int unlockSent = await server.SendToTrayAsync(
                IpcMessage.Create(IpcMessageTypes.Unlock, new { }), cts.Token);
            Check("SendToTrayAsync(unlock) giao tới ≥1 writer", unlockSent >= 1);
            Trace("đang chờ task đọc unlock xong...");
            string? unlockLine = await unlockReadTask;
            Trace("chờ unlock xong: nhận được dòng=" + (unlockLine is not null) + ".");
            Check("client giả nhận được message unlock", unlockLine is not null && IpcMessage.FromLine(unlockLine)?.Type == IpcMessageTypes.Unlock);

            // Xin thêm giờ (đợt PIN/xin giờ/xem giờ): client giả gửi
            // extra-time-request, khẳng định server xếp nó vào outbox để
            // AgentWorker đẩy lên server (đường Tray→Service→hàng đợi).
            Trace("đang gửi extra-time-request, rồi poll outbox...");
            await writer.WriteLineAsync(IpcMessage.Create(
                IpcMessageTypes.ExtraTimeRequest,
                new ExtraTimeRequestPayload(30, "self-test xin thêm giờ", DateTimeOffset.UtcNow)).ToLine());
            await writer.FlushAsync();
            bool extraTimeEnqueued = false;
            long extraTimeItemId = 0;
            for (int i = 0; i < 10 && !extraTimeEnqueued; i++)
            {
                await Task.Delay(500, cts.Token);
                IReadOnlyList<OutboxItem> pending = await outbox.GetPendingExtraTimeRequestsAsync(10, cts.Token);
                foreach (OutboxItem item in pending)
                {
                    ExtraTimeRequestPayload? enqueued;
                    try
                    {
                        enqueued = System.Text.Json.JsonSerializer.Deserialize<ExtraTimeRequestPayload>(item.PayloadJson);
                    }
                    catch (System.Text.Json.JsonException)
                    {
                        enqueued = null;
                    }

                    if (enqueued is not null && enqueued.Minutes == 30 && enqueued.Reason == "self-test xin thêm giờ")
                    {
                        extraTimeEnqueued = true;
                        extraTimeItemId = item.Id;
                    }
                }
            }

            Check("server xếp extra-time-request vào outbox", extraTimeEnqueued);

            // Dọn hàng self-test khỏi outbox dùng chung: nếu chạy test này
            // trên máy thật rồi Service thật khởi động, hàng còn lại sẽ bị
            // đẩy lên Dashboard thành yêu cầu xin thêm giờ giả (review đợt này).
            if (extraTimeEnqueued)
            {
                await outbox.MarkSentAsync(extraTimeItemId, cts.Token);
            }

            // Kiểm tra PIN (đợt PIN/xin giờ/xem giờ): đặt hash của PIN
            // "123456" vào trạng thái chia sẻ (đóng vai heartbeat đã đồng
            // bộ), rồi hỏi qua pipe như Tray thật: PIN đúng thì được xác
            // thực, PIN sai thì bị từ chối và còn 4 lần thử (lần sai đầu
            // sau khi lần đúng đã đặt lại bộ đếm về 0). Đọc phải chạy đồng
            // thời với gửi (xem ghi chú ở lock): FlushAsync của câu trả lời
            // chặn tới khi đầu kia đọc.
            Trace("đang kiểm tra pin-verify PIN đúng...");
            queryState.UpdatePinHash(PinHash.Hash("123456"));
            Task<string?> pinOkReadTask = ReadLineWithTimeoutAsync(reader, client, TimeSpan.FromSeconds(5));
            await writer.WriteLineAsync(IpcMessage.Create(
                IpcMessageTypes.PinVerifyRequest,
                new PinVerifyRequestPayload("123456", "self-test-pin-ok")).ToLine());
            await writer.FlushAsync();
            string? pinOkLine = await pinOkReadTask;
            PinVerifyResponsePayload? pinOk = pinOkLine is null ? null : IpcMessage.FromLine(pinOkLine)?.GetPayload<PinVerifyResponsePayload>();
            Check("pin-verify PIN đúng thì được xác thực", pinOk is { Verified: true, PinConfigured: true, RequestId: "self-test-pin-ok" });

            // Mã PIN dùng một lần: lần đúng vừa rồi đã tiêu thụ hash (bộ
            // nhớ Service đã xóa; lệnh gỡ lên server thất bại vì self-test
            // không có thông tin ghép nối, cờ thử lại còn lại trong
            // device_state — vô hại trên DB mới của runner). Đặt lại hash
            // để kiểm tra lần sai trên cùng một mã: bộ đếm sai vẫn là 0 vì
            // lần đúng đã đặt lại, nên lần sai này còn đúng 4 lần thử.
            queryState.UpdatePinHash(PinHash.Hash("123456"));
            Trace("đang kiểm tra pin-verify PIN sai...");
            Task<string?> pinBadReadTask = ReadLineWithTimeoutAsync(reader, client, TimeSpan.FromSeconds(5));
            await writer.WriteLineAsync(IpcMessage.Create(
                IpcMessageTypes.PinVerifyRequest,
                new PinVerifyRequestPayload("000000", "self-test-pin-bad")).ToLine());
            await writer.FlushAsync();
            string? pinBadLine = await pinBadReadTask;
            PinVerifyResponsePayload? pinBad = pinBadLine is null ? null : IpcMessage.FromLine(pinBadLine)?.GetPayload<PinVerifyResponsePayload>();
            Check("pin-verify PIN sai thì bị từ chối, còn 4 lần thử", pinBad is { Verified: false, LockedOut: false, RemainingAttempts: 4, PinConfigured: true, RequestId: "self-test-pin-bad" });

            // Thời gian còn lại (đợt PIN/xin giờ/xem giờ): đặt quyết định
            // mới nhất vào trạng thái chia sẻ (đóng vai vòng kiểm tra
            // rules), rồi hỏi qua pipe như Tray thật và khẳng định câu trả
            // lời mang đúng quyết định đó.
            Trace("đang kiểm tra remaining-time-request...");
            queryState.UpdateDecision(new RuleDecision(RuleDecisionKind.Lock, "Self-test khóa/mở.", 0), DateTimeOffset.UtcNow);
            Task<string?> remainingReadTask = ReadLineWithTimeoutAsync(reader, client, TimeSpan.FromSeconds(5));
            await writer.WriteLineAsync(IpcMessage.Create(
                IpcMessageTypes.RemainingTimeRequest,
                new RemainingTimeRequestPayload("self-test-remaining")).ToLine());
            await writer.FlushAsync();
            string? remainingLine = await remainingReadTask;
            RemainingTimeResponsePayload? remaining = remainingLine is null ? null : IpcMessage.FromLine(remainingLine)?.GetPayload<RemainingTimeResponsePayload>();
            Check("remaining-time-request trả về quyết định mới nhất", remaining is { Decision: "lock", MinutesLeft: 0, RequestId: "self-test-remaining" });

            // Đồng bộ trạng thái khi Tray mới nối (đợt sửa 17/11/2026):
            // client giả gửi hello KHÔNG phải admin trong lúc quyết định
            // mới nhất đang là Lock thì server phải gửi ngay lệnh khóa
            // xuống writer vừa giới thiệu, không chờ vòng kiểm tra rules.
            // Lệnh khóa đồng bộ phải mang Immediate = true: quyết định
            // khóa đã có hiệu lực từ trước, Tray nối lại không được đếm
            // ngược 60 giây nữa. Đọc phải chạy đồng thời với gửi
            // (FlushAsync của lệnh khóa chặn tới khi đầu kia đọc).
            Trace("đang kiểm tra đồng bộ trạng thái khi hello...");
            Task<string?> helloSyncReadTask = ReadLineWithTimeoutAsync(reader, client, TimeSpan.FromSeconds(5));
            await writer.WriteLineAsync(IpcMessage.Create(
                IpcMessageTypes.Hello,
                new HelloPayload(0, "self-test-child", false)).ToLine());
            await writer.FlushAsync();
            string? helloSyncLine = await helloSyncReadTask;
            IpcMessage? helloSyncMessage = helloSyncLine is null ? null : IpcMessage.FromLine(helloSyncLine);
            Check("hello từ phiên không admin thì nhận ngay lệnh khóa đang hiệu lực", helloSyncMessage?.Type == IpcMessageTypes.Lock);
            LockPayload? helloSyncPayload = helloSyncMessage?.GetPayload<LockPayload>();
            Check("lệnh khóa đồng bộ khi hello phải khóa ngay, không đếm ngược", helloSyncPayload?.Immediate == true);

            // Miễn trừ admin (đợt khóa theo phiên): client giả gửi hello
            // IsAdmin=true, rồi khẳng định lệnh lock KHÔNG còn giao tới
            // writer nào (SendToTrayAsync trả về 0). Poll tới ~3s vì handler
            // xử lý hello bất đồng bộ; mỗi lần gửi trước khi hello được xử
            // lý sẽ giao 1 dòng lock xuống pipe — các dòng này không được
            // đọc, nằm lại trong buffer, vô hại vì test sắp dừng server.
            // KHÔNG bắt đầu task đọc ở đây: khi bộ lọc đúng thì không có
            // dòng nào tới, task đọc sẽ treo tới hết timeout.
            Trace("đang gửi hello admin, rồi khẳng định lock không còn giao tới...");
            await writer.WriteLineAsync(IpcMessage.Create(
                IpcMessageTypes.Hello,
                new HelloPayload(0, "self-test-admin", true)).ToLine());
            await writer.FlushAsync();
            bool lockFiltered = false;
            for (int i = 0; i < 15 && !lockFiltered; i++)
            {
                int filteredSent = await server.SendToTrayAsync(
                    IpcMessage.Create(IpcMessageTypes.Lock, new LockPayload("Self-test miễn trừ admin.")), cts.Token);
                lockFiltered = filteredSent == 0;
                if (!lockFiltered)
                {
                    await Task.Delay(200, cts.Token);
                }
            }

            Check("SendToTrayAsync(lock) giao 0 writer sau hello admin", lockFiltered);

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
