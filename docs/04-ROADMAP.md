# Roadmap & Quy trình làm việc — SafePC

## Trạng thái tổng quan (17/11/2026)

Chức năng chính (khóa/mở máy từ xa) đã kiểm chứng trên máy thật. Dashboard đã live. Còn lại: hoàn thiện Tray (PIN/xin giờ/xem giờ), kiểm chứng chặn domain đầu-cuối, và các hạng mục đã phê duyệt ngày 17/11/2026 (tính năng nâng cao, flow cài đặt cho phụ huynh khác, báo cáo tuần) thực hiện dần, rồi app Android. Chi tiết từng hạng mục trong PRD (`01-PRD.md` mục 0).

## Lộ trình thực tế

### Sprint 0 — Nền móng ✅ (16/11/2026)
- [x] Đã chốt: tên app SafePC, Windows 10/11, backend Supabase.
- [x] Repo private `ndtcoder/SafePC`, cấu trúc monorepo, CI (build + scan secret + cổng kiểm tra).
- [x] Project Supabase Free, schema 12 bảng + RLS, 6 migration đã áp.
- [x] Project Vercel Free, Dashboard live tại `https://safe-pc.vercel.app`.
- [x] Tài khoản phụ huynh đầu tiên đã đăng ký/đăng nhập thành công.

### Sprint 1 — Pairing + Usage Tracking ✅ (16/11/2026)
- [x] Backend: families/children/devices, pairing code, device token (RPC SECURITY DEFINER).
- [x] Agent: Service + Tray, heartbeat, ghi app foreground vào SQLite, đồng bộ lên Supabase.
- [x] Dashboard: trang Thiết bị, trang Hôm nay.
- [x] Installer Inno Setup, đã cài và kiểm chứng trên máy Windows thật.

### Sprint 2 — Screen Time + Lock + Rules ✅ (16–17/11/2026)
- [x] Đợt 1: quy tắc giờ giấc (tổng giờ/ngày theo thứ, khung giờ, giờ ngủ) + ghi đè tạm thời.
- [x] Đợt 2: chặn domain qua extension MV3 + NativeHost + SafeSearch/YouTube Restricted (code xong, **chưa kiểm chứng đầu-cuối**).
- [x] Đợt 3: quy tắc theo app, giờ học tập trung, nghỉ bắt buộc, cảnh báo can thiệp, mẫu một chạm.
- [x] Bản sửa lỗi: báo cáo thi hành realtime, cứng hóa Tray + IPC, Dashboard gom theo con + đếm ngược mở khóa + xóa thiết bị.
- [x] Gốc rễ lỗi IPC (deadlock AutoFlush) đã tìm ra và sửa; cổng kiểm tra khóa/mở trên CI đã xanh; khóa/mở đã kiểm chứng trên máy thật (v0.1.136, 17/11/2026).
- [x] Tối ưu CI: job lọc thay đổi (đẩy không chạm code agent thì bỏ qua job Windows), cache NuGet + Inno Setup.
- [x] Xin thêm giờ đầu-cuối (xong đợt 17/11/2026 — xem đợt hiện tại).

### Đợt hiện tại — theo yêu cầu ngày 17/11/2026 🔨
- [x] Khóa có độ trễ 0–5 phút + cửa sổ cảnh báo nhỏ + giao lệnh khóa theo phiên (đã kiểm chứng trên máy thật tối 17/11: độ trễ + cảnh báo nhỏ đúng, phiên admin miễn khóa qua đường Limited-token).
- [x] PIN thoát Tray, xin thêm giờ đầu-cuối, xem giờ còn lại thật (PIN một lần đã kiểm chứng trên máy thật tối 17/11; yêu cầu xin giờ + khóa nhập PIN đã thấy trong log máy thật; migration 8 đã áp sáng 18/11).
- [x] Đợt sửa theo 7 yêu cầu test máy thật 17/11: PIN chỉ dùng một lần, đồng bộ trạng thái khi Tray nối lại, duyệt xin giờ mở khóa luôn, lệnh khóa sau thắng ghi đè mở khóa trước, hết độ trễ khóa ngay không đếm ngược, hồ sơ theo con (Tổng quan / Hồ sơ / Yêu cầu), mã ghép nối 5 phút (CI xanh run #159, v0.1.159, chưa kiểm chứng trên máy thật).
- [x] Đợt sửa sau test v0.1.159 (đêm 17→18/11): đồng bộ trạng thái khóa ngay không đếm ngược, snapshot thi hành gửi ngay khi đổi (bỏ chặn 5 phút), duyệt xin giờ = mở khóa đúng N phút, thẻ thiết bị nhất quán sau Khóa ngay (tải lại + nhận diện lock_now), installer nướng ID extension Edge thật, extension 0.1.1 (chẩn đoán DNR trong popup), thiết kế lại trang Quy tắc + tên rule + mẫu của phụ huynh + mẫu Chỉ cho phép Edge, migration 9 (CI xanh run #167: Tray 19/19, Service IPC 13/13; run #170: build-dashboard xanh; v0.1.167 chờ kiểm chứng trên máy thật).
- [x] Đợt 4 + đợt sửa retest (sáng 18/11): rule chặn theo đường dẫn URL (Dashboard tách domain/đường dẫn, chỉ mode block_domains; publisher xuất urlPatterns; extension 0.1.3 regexFilter với ranh giới đường dẫn), Khóa ngay độ trễ 0 + khóa tạm thời khóa ngay không đếm ngược, thẻ thiết bị ưu tiên trạng thái mở khóa (hết xung đột khóa/mở), snapshot thi hành đẩy ngay khi đổi từ vòng tick 15s (CI xanh run #183: Tray 19/19, Service IPC 13/13; v0.1.183 chờ kiểm chứng trên máy thật).
- [x] Áp migration 8 (gỡ PIN đã dùng khỏi server) + migration 9 (tên rule + bảng rule_templates) lên Supabase (đã áp sáng 18/11; lệnh gỡ PIN chờ từ tối qua đã hoàn tất trên server).
- [x] Kiểm chứng v0.1.167 trên máy thật (sáng 18/11): đăng nhập lại khi đang khóa thì khóa ngay không đếm ngược ✅; duyệt giờ mở ngay ✅ nhưng thẻ thiết bị xung đột khóa/mở; Khóa ngay độ trễ 0 vẫn đếm ngược — 2 lỗi đã sửa ở v0.1.183.
- [x] Kiểm chứng chặn domain đầu-cuối với extension 0.1.2 (sáng 18/11): chặn được (YouTube hiện "You're offline"), popup hiện đúng version + domain + rule đang áp; trang chặn SafePC chưa hiện thay vỏ trang đệm. Chặn app / mẫu Chỉ cho phép Edge cũng đã kiểm chứng (Chrome bị đóng 2 lần + hộp cảnh báo).
- [x] Đồng bộ trạng thái thi hành cho máy mới ghép nối (migration 21, 19/11): máy mới nhận khóa cưỡng chế + tối đa 1 ghi đè đang hiệu lực (mở khóa / ghi đè khóa / allow_domain / block_domain / block_app / allow_app / tổng ngân hàng giờ) từ bảng `commands`, chèn khóa trước ghi đè sau, lệnh sao chép mang `created_at` gốc; kiểm chứng PGlite trên SQL thật: 42/42 pass (34 kịch bản). Chưa áp migration 21, chưa kiểm chứng trên máy thật.
- [ ] Kiểm chứng v0.1.183 + extension 0.1.3 trên máy thật: rule bing.com/videos (chặn /videos, mở được /abc); Khóa ngay độ trễ 0 không đếm ngược; thẻ thiết bị hết xung đột khóa/mở; giao diện Quy tắc mới trên điện thoại thật.

### Sprint 4 — Cứng hóa + Beta gia đình ✅ code (chờ anh kiểm chứng trên máy thật)
- [x] Tamper resistance: PIN gỡ cài đặt, watchdog, cảnh báo offline. — Đã triển khai 19/11/2026 (code, CI chờ chạy sau khi push, chưa kiểm chứng trên máy thật):
  - **PIN gỡ cài đặt** dùng chung mã PIN thoát Tray (không làm PIN riêng): bộ gỡ hỏi mã bằng form che ký tự (tối đa 3 lần nhập), kiểm tra bằng `Service.exe verify-pin <mã>` (exit code 0/2/3/5/6); chưa đặt PIN thì gỡ bằng quyền Admin như trước (fail-open có chủ đích); gỡ im lặng khi đã đặt PIN thì bị chặn. Hash PIN đồng bộ từ heartbeat xuống cache DPAPI `exit_pin_hash.dat` (khóa ACL SYSTEM + Admins) để kiểm tra được khi mất mạng.
  - **Watchdog Tray** phía Service: snapshot phiên IPC mỗi 60s, Tray im lặng >5 phút thì khởi động lại trong phiên user (WTSQueryUserToken + CreateProcessAsUser), backoff 0/1/2/5/10 phút, tối đa 5 lần/giờ rồi báo phụ huynh bằng sự kiện can thiệp mới `tray_stopped` (migration 22); ân hạn 30 phút sau khi thoát Tray bằng mã PIN. Service đã có SCM recovery restart 60s (giữ nguyên).
  - **Cảnh báo offline**: ĐÃ CÓ từ trước — email máy offline >48h + mục Thông báo trên Dashboard (phụ thuộc migration 12 + deploy Edge Function, xem MEMORY.md); Sprint 4 chỉ bổ sung mảnh thiếu là cảnh báo `extension_missing` (đẩy khi trình duyệt chạy foreground 15 phút mà extension im lặng) và `tray_stopped`. `service_stopped` không đẩy được từ Agent (Service chết thì không báo được) — được bao bởi cảnh báo offline.
- [x] Security checklist (docs/03) chạy đầy đủ, sửa lỗi Critical/High. — Đã chạy 19/11/2026, xem docs/03 §"Kết quả rà soát Sprint 4". Đã sửa: token/DB/hash-cache khóa ACL chỉ SYSTEM + Admins (High — `device_token.dat` đọc được bởi Standard User); sửa các câu sai trong docs (host_permissions, TTL ghép nối 10 phút → 5 phút, PIN "SHA-256 skeleton" → PBKDF2 thật); migration 23 (review độc lập MINOR-5: cron dọn hàng app_usage cũ hơn 90 ngày để server đúng với Chính sách riêng tư §4 — PGlite 15/15, chờ anh áp). Rủi ro còn lại đã ghi rõ (pipe IPC ACL, quét mã ghép nối, chưa ký số, chưa có tự cập nhật).
- [ ] QA: test trên 2 máy Windows khác nhau, test Standard User, test mất mạng, test khởi động lại. — **Chờ anh Tiến** (kịch bản kiểm chứng xem docs/03 §"Kịch bản kiểm chứng trên máy thật (Sprint 4)").
- [x] Tài liệu hướng dẫn cài đặt + Privacy Policy tiếng Việt. — docs/08-HUONG-DAN-CAI-DAT.md + docs/09-PRIVACY-POLICY.md, kèm 2 trang công khai trên Dashboard (/huong-dan-cai-dat, /chinh-sach-rieng-tu).
- [ ] Beta: anh Tiến dùng thật 1-2 tuần, ghi lại lỗi/cải tiến. — **Chờ anh Tiến**.
- [ ] Kiểm thử RLS truy cập chéo gia đình (2 tài khoản). — **Chờ anh Tiến**.

### Sprint 5 — Nhiều con dùng chung một máy (phương án 2: một phiên active) ⏳

Trạng thái: backend đợt 1 đã đẩy (head bdfc640, CI #317 code xanh — chỉ bước upload artifact đỏ do hết hạn mức lưu trữ); đợt Dashboard review xong (APPROVED) + migration 27 review xong (APPROVED), cả hai đều chỉ trong cây local, đang chờ anh test xong v0.1.309 mới đẩy (Vercel auto-deploy main). Chi tiết ngữ nghĩa xem PRD §2.11. Nguyên tắc: chỉ phiên console đang hoạt động mới bị thi hành luật; mỗi con vẫn có thể có nhiều máy (dùng chung hoặc riêng), quản lý theo hồ sơ từng con.

- [ ] Mô hình dữ liệu + migration: bảng ánh xạ thiết bị ↔ hồ sơ con ↔ tài khoản Windows (lưu theo SID — Tray gửi thêm SID trong bản tin hello); `commands` thêm `child_id`; watermark chống lệnh cũ tách theo (thiết bị, con); usage ghi theo (thiết bị, tài khoản Windows) rồi suy ra hồ sơ con; NativeHost gắn thêm username/SID vào mỗi dòng `web_usage.jsonl` và `domain_requests.jsonl`.
- [ ] Service nhận biết phiên console + đổi bộ luật khi đổi phiên (cơ chế phát hiện đổi phiên: Service `OnSessionChange` / `WTSGetActiveConsoleSessionId` / hello từ phiên mới — chốt lúc triển khai): chỉ thi hành luật của con đang active; phiên nền hiện trạng thái tạm dừng và không tính giờ; ghi lại `domain_rules.json` theo con đang active. Đường giết app giữ nguyên (đã theo phiên).
- [ ] Lệnh gắn theo con + hoãn khi chưa active: khóa/mở/ghi đè mang `child_id`; lệnh cho con chưa active thì hoãn tới khi con lên console; Dashboard hiện "sẽ áp dụng khi con đăng nhập".
- [ ] Dashboard gắn tài khoản Windows + lệnh theo con: trang thiết bị liệt kê các con gắn với máy kèm tài khoản Windows; gắn/gỡ bằng cách chọn từ danh sách tài khoản Tray đã "nhìn thấy" (không gõ tay); lệnh khóa/mở/duyệt yêu cầu chọn đúng con trên đúng máy.
- [ ] Đồng bộ trạng thái lúc gắn thêm con (phương án (a) đã chốt 21/11/2026): migration 27 (RPC `safepc_sync_enforcement_state_to_device`, tái dùng khối sao chép migration 21) + Dashboard gọi sau khi gắn (best-effort khi migration chưa áp).
- [ ] Kiểm thử máy thật với 2 tài khoản con + chuyển đổi nhanh (fast user switching); CI không mô phỏng được đa phiên.

Đã chốt 20/11/2026: tài khoản Standard chưa gắn thì không quản lý nhưng hiện cảnh báo lên Dashboard (xem PRD §2.11). Đồng bộ trạng thái khi gắn thêm con vào máy chung: ĐÃ CHỐT phương án (a) ngày 21/11/2026 — migration 27, RPC `safepc_sync_enforcement_state_to_device`, Dashboard gọi sau khi gắn (best-effort khi migration chưa áp) — xem PRD §2.11.

### Kiểm duyệt từ khóa tìm kiếm (yêu cầu của anh Tiến 27/11/2026) 🔨

Trạng thái: đã xây ở cây local ngày 27/11/2026 (Dashboard + extension + backend), chờ đẩy cùng đợt sau khi anh test xong v0.1.309 (giống đợt Dashboard Sprint 5 + migration 27 đang giữ). Chi tiết xem PRD §2.12 và AMENDMENTS A-14.

- [x] Rule website mode `block_search_keywords` (config `{"keywords": [...]}` theo từng hồ sơ con): Dashboard có form tích chọn nhóm từ khóa theo chủ đề + editor chip cho từ khóa riêng + mẫu sẵn một chạm; backend phát `searchGuard.blockedKeywords` qua domain_rules.json; extension chặn trên Google, Bing, DuckDuckGo, Yahoo, Cốc Cốc và hiện trang cảnh báo.
- [x] Bổ sung nhóm từ khóa theo chủ đề (anh yêu cầu 27/11/2026 14:51): 6 nhóm mẫu (Nội dung người lớn 16+/18+, Cờ bạc / cá cược, Bạo lực, Game, Phim, Mạng xã hội — nhóm cờ bạc tách riêng khỏi nhóm người lớn theo review 27/11/2026) để phụ huynh tích chọn cả nhóm + từ khóa riêng; config v2 lưu thêm `groups`/`customKeywords`, `keywords` vẫn là danh sách hiệu lực duy nhất; mẫu sẵn bật sẵn nhóm Nội dung người lớn (16+/18+).
- [x] Thống kê từ khóa đã tìm vào Báo cáo tuần: bảng `search_terms` (migration 28) + mục "Từ khóa tìm kiếm" trên trang Báo cáo (cụm từ × công cụ, tổng lượt + lượt bị chặn nổi bật, lọc text, tối đa 50 dòng).
- [x] Cập nhật ranh giới riêng tư: chỉ cụm từ trên công cụ tìm kiếm mới được lưu (giữ 90 ngày); URL khác vẫn bỏ query — đã ghi vào PRD §2.12, Chính sách riêng tư (trang công khai + docs/09) và AMENDMENTS A-14.
- [ ] Anh chạy tay migration 28 qua SQL Editor — SAU migration 24 và 27 (migration 28 cần chạy tay sau migration 24/27, cùng đợt áp của Sprint 5).
- [ ] Đẩy GitHub cùng đợt sau test v0.1.309 + kiểm chứng trên máy thật (tìm kiếm vướng từ khóa bị chặn + hiện cảnh báo; thống kê khớp trên Báo cáo tuần).

### Nhắn tin con ↔ phụ huynh trong SafePC (yêu cầu của anh Tiến 27/11/2026) 🔨

Trạng thái: đã xây ở cây local ngày 27/11/2026 (migration 29 + Dashboard; móc nối Agent do builder Agent phụ trách theo hợp đồng RPC của migration 29), chờ đẩy cùng đợt sau khi anh test xong v0.1.309. Chi tiết xem PRD §2.13 và AMENDMENTS A-15. Mục đích: con liên lạc với bố mẹ ngay trong SafePC, khỏi dùng ứng dụng nhắn tin bên ngoài gây xao lãng; đường dùng app bên thứ ba (Telegram/WhatsApp) với danh bạ được phép KHÔNG khả thi vì các app đó không cho bên ngoài kiểm soát danh bạ. V1 chỉ tin nhắn chữ, làm trước trên web; gọi thoại/video để giai đoạn Android.

- [x] Backend migration 29: bảng `messages` (RLS: gia đình đọc, phụ huynh tự gửi, con chỉ ghi qua RPC) + bảng `chat_sessions` (token phiên 12 giờ, chỉ lưu hash, không policy cho user thường) + RPC mint/fetch/send/mark_read theo token phiên, RPC phụ huynh mark_read + revoke phiên; mở rộng RPC xóa dữ liệu con (migration 15) thêm messages + chat_sessions.
- [x] Dashboard: tab "Nhắn tin" trong hồ sơ con (polling 5 giây, trạng thái Đã xem/Đã gửi) + trang chat của con `/nhan-tin` ngoài RequireAuth (chỉ 3 RPC theo token phiên) + mục "Tin nhắn" trong xuất dữ liệu con (phiên nhắn tin không xuất — thông tin xác thực).
- [x] Cập nhật ranh giới riêng tư: lưu NỘI DUNG tin nhắn của kênh hai chiều trong sản phẩm (cả hai phía đều là người tham gia) — đã ghi vào PRD §2.13, Chính sách riêng tư (trang công khai + docs/09) và AMENDMENTS A-15; ranh giới không đọc nội dung chat ở ứng dụng khác giữ nguyên.
- [x] Móc nối Agent: mục mở nhắn tin trong menu khay → Service gọi `safepc_mint_chat_session` bằng token thiết bị (kèm SID của phiên) → mở trình duyệt tới `/nhan-tin#t=<token>` (đã xây xong ở cây local).
- [ ] Anh chạy tay migration 29 qua SQL Editor — SAU migration 24 (RPC mint cần bảng ánh xạ thiết bị ↔ con của Sprint 5).
- [ ] Đẩy GitHub cùng đợt sau test v0.1.309 + kiểm chứng trên máy thật (con mở chat từ khay, hai phía nhắn qua lại, trạng thái đã xem khớp, thu hồi phiên thì trang con báo hết hạn).

### Đã phê duyệt 17/11/2026 — thực hiện dần (chi tiết trong PRD §2.8–2.10)

**Tính năng nâng cao + giao diện chuyên nghiệp (theo thứ tự ưu tiên):**
- [ ] Trang Hôm nay thành tổng quan thật (thẻ trạng thái, giờ còn lại, biểu đồ ngày, top app/domain).
- [ ] Thông báo email cho phụ huynh (xin thêm giờ, can thiệp, offline bất thường); push để sau cùng Android.
- [ ] Nhật ký hoạt động (ai đổi rule, khóa/mở, duyệt yêu cầu).
- [ ] Ngân hàng giờ (thưởng thêm giờ kèm lý do + lịch sử).
- [ ] Chặn theo danh mục domain từ danh sách công khai.
- [ ] Mời phụ huynh thứ hai cùng quản lý.
- [ ] Xuất dữ liệu + xóa toàn bộ dữ liệu của con.
- [ ] Chuẩn hóa giao diện (trạng thái rỗng/tải/lỗi/mất mạng) + hướng dẫn lần đầu.
- [ ] MFA cho tài khoản phụ huynh.

**Flow cài đặt cho phụ huynh khác (không cần biết code):**
- [ ] Bản triển khai dùng chung cho mọi gia đình (1 Supabase + 1 web, tách dữ liệu bằng RLS).
- [x] Bộ cài có giao diện nhập mã ghép nối (không còn bước PowerShell — lệnh PowerShell vẫn dùng được để debug). — Đã triển khai 19/11/2026 (SafePCAgent.iss, trang sau wpInstalling + chạy PairingCli + nhập lại + bỏ qua; CI chờ chạy sau khi push, chưa kiểm chứng trên máy thật).
- [ ] Extension lên cửa hàng Chrome/Edge (ID thật, tự cập nhật).
- [ ] Ký số bộ cài (hoặc hướng dẫn vượt cảnh báo SmartScreen cho tới khi có chứng chỉ).
- [ ] Agent tự cập nhật kèm kiểm tra hash.
- [x] Trang hướng dẫn + chính sách riêng tư tiếng Việt trước khi mời gia đình ngoài. — Đã triển khai 19/11/2026 (docs/08-HUONG-DAN-CAI-DAT.md, docs/09-PRIVACY-POLICY.md + 2 trang công khai /huong-dan-cai-dat, /chinh-sach-rieng-tu trên Dashboard).
- [ ] Quyết định còn mở: ai vận hành, domain, tài khoản cửa hàng extension, chứng chỉ ký số.

**Báo cáo tuần:**
- [ ] Trang Báo cáo trên Dashboard (Recharts) + email tóm tắt mỗi tuần (Edge Function + Resend free). Không dùng Power BI (xem PRD §2.10).
- [ ] 7 mục nội dung: tổng quan so với tuần trước, giờ theo ngày kèm giới hạn, top 5 app/domain, số lần thi hành, yêu cầu xin giờ, cảnh báo, gợi ý tự động.
- [ ] Xuất PDF để sau.

### Giai đoạn 2 — Android cho phụ huynh ⏳
- [ ] Tính năng nâng cao đã chốt ngày 17/11/2026 — sẵn sàng thảo luận khi bắt đầu.
- [ ] Capacitor wrapper, push notification, màn hình nhanh (khóa/mở, duyệt yêu cầu).
- [ ] Build APK thử nghiệm, sau đó AAB lên Play Console (khi anh Tiến sẵn sàng, phí đăng ký Play Console 25 USD một lần — ngoài phạm vi free, để sau).

## Quy trình làm việc chung (áp cho mọi app của anh Tiến)

1. **Mỗi tính năng bắt đầu bằng 1 mô tả ngắn:** làm gì, cho ai, xong thì kiểm tra thế nào.
2. **Nhánh:** `main` luôn chạy được. Đẩy code qua giao diện web GitHub theo từng đợt (Git Trees API và SSH git đều bị chặn từ môi trường làm việc); commit trung gian trong một đợt đẩy có thể đỏ, chỉ trạng thái của commit đầu (head) mới quyết định.
3. **Code review:** mỗi đợt sửa có 1 reviewer độc lập (agent nền) kiểm tra trước khi đẩy; anh Tiến kiểm tra bản chạy được trên máy thật, không cần đọc code. Lỗi trên máy thật được sửa theo log/ảnh chụp anh gửi.
4. **Không báo xong khi:** có secret trong code, cổng kiểm tra CI đỏ, hoặc tính năng khóa/mở chưa qua cổng kiểm tra CI (yêu cầu từ 17/11/2026: khóa/mở phải test kỹ trước khi gửi bản).
5. **Release:** phiên bản `0.1.<số run CI>`; installer đính kèm theo run CI xanh; giữ lại bản installer cũ để quay lại khi lỗi. Migration Supabase do anh Tiến paste + chạy (trình duyệt tự động không paste được vào SQL Editor), có kiểm tra độ trung thực trước khi chạy.

## Checklist QA trước mỗi release

- [ ] Luồng chính chạy được từ đầu tới cuối trên bản build mới (không chỉ trên máy dev).
- [ ] Trạng thái rỗng / loading / lỗi / mất mạng đều có giao diện rõ ràng.
- [ ] Kiểm tra trên 2 kích thước màn hình (laptop 14" + màn hình lớn) và 2 trình duyệt (Chrome + Edge).
- [ ] Agent: khởi động lại máy vẫn chạy, Standard User không tắt/gỡ được, mất mạng vẫn thi hành quy tắc.
- [ ] Không có lỗi Critical trong dependency scan và secret scan.
- [ ] Changelog + hướng dẫn cập nhật đã viết.

## Ước lượng (tham khảo, không phải cam kết)

- Sprint 0-3: mỗi sprint cần anh Tiến dành ~2-3 giờ/tuần để chốt thiết kế + test trên máy thật. Phần code do Trà My/em My làm chính, anh Tiến không cần code.
- Rủi ro lớn nhất: tích hợp sâu Windows (chặn app, khóa máy) cần test trên máy thật nhiều lần, không thể kiểm tra hết bằng máy ảo. Cần 1 máy Windows thật của con (hoặc máy test) từ Sprint 1.
- Chi phí: 0 đồng cho tới khi quyết định mua domain / Play Console / Code Signing. Supabase/Vercel/GitHub Free đủ cho <100 user nếu giữ dữ liệu gọn (tổng hợp 90 ngày).
