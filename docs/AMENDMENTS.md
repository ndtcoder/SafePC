# AMENDMENTS.md — Các lần đổi spec/quy ước đã chốt của SafePC

Gói bàn giao SafePC — tạo 2026-11-26.

Mỗi mục: **đổi gì / vì sao / ngày / ai quyết**. Mặc định người quyết là anh Tiến (chủ dự án); mục nào do phía kỹ thuật tự đính chính bài học sẽ ghi rõ. Nguồn: `~/MEMORY.md`, `docs/01-PRD.md` (§2.8–2.11), `docs/04-ROADMAP.md` và lịch sử chat.

## A-01. Loại chụp màn hình khỏi kế hoạch
- **Đổi gì:** Hủy hẳn mục "chụp màn hình theo lịch (opt-in)" ở PRD §4; SafePC không chụp màn hình, không ghi phím, không đọc nội dung chat/file của con — ở mọi đợt, kể cả dạng tự nguyện.
- **Vì sao:** Giữ ranh giới riêng tư của dự án (dữ liệu trẻ em); anh Tiến phê duyệt cùng gói 3 đề xuất lớn và loại riêng mục này.
- **Ngày:** 17/11/2026. **Ai quyết:** anh Tiến.

## A-02. Scheme version Agent = `0.1.<số run CI>`
- **Đổi gì:** Version bản cài là `0.1.<CI run number>` (ví dụ build #111 → v0.1.111), CI tự đóng dấu qua `dotnet publish -p:Version` + ISCC `/DAppVersion`; cấm hardcode chuỗi version trong code.
- **Vì sao:** Đối chiếu 1-1 giữa bản cài trên máy và run CI sinh ra nó, hết cảnh nhớ/mò version thủ công.
- **Ngày:** 17/11/2026. **Ai quyết:** anh Tiến (yêu cầu).

## A-03. Ngữ nghĩa unlock: chỉ hoãn khóa máy theo giờ giấc
- **Đổi gì:** "Mở khóa tạm thời" (temporary override dạng unlock) CHỈ hoãn việc khóa máy theo giờ giấc/giới hạn ngày; chặn app, giờ học tập trung (focus) và nghỉ bắt buộc VẪN thi hành trong suốt thời gian mở khóa.
- **Vì sao:** Tránh việc mở khóa tạm vô hiệu hóa toàn bộ luật bảo vệ khác; đã chứng minh trên máy thật (v0.1.187, CI #187 xanh, commit 652c693).
- **Ngày:** 18/11/2026 (anh chốt 10:52). **Ai quyết:** anh Tiến.

## A-04. Lịch sử web: lưu domain + đường dẫn (nới từ "chỉ domain")
- **Đổi gì:** Lịch sử web lưu tên miền **và đường dẫn**, nhưng BỎ phần truy vấn (query) và fragment; giữ 90 ngày rồi tự xóa cũ hơn. Trước đó quy ước là chỉ lưu tên miền.
- **Vì sao:** Anh Tiến chủ động nới ranh giới riêng tư một cách có ý thức để phụ huynh kiểm tra được nội dung con truy cập, kèm tìm kiếm + lọc lịch sử web trong Báo cáo tuần.
- **Ngày:** 18/11/2026 (anh chốt 23:13). **Ai quyết:** anh Tiến.

## A-05. Giữ WhatsApp Web / Telegram Web / LinkedIn trong danh mục "Mạng xã hội"
- **Đổi gì:** KHÔNG tách nhóm nhắn tin ra khỏi danh mục chặn "Mạng xã hội": WhatsApp Web, Telegram Web và LinkedIn vẫn thuộc danh mục này.
- **Vì sao:** Anh Tiến trả lời câu hỏi mở của đợt chặn theo danh mục; giữ phân loại đơn giản, không sửa code.
- **Ngày:** 18/11/2026 (anh trả lời 22:49). **Ai quyết:** anh Tiến.

## A-06. Ép cài extension: chỉ qua Edge Add-ons, chấp nhận đổi ID extension
- **Đổi gì:** Đường ép cài extension duy nhất là đăng lên cửa hàng Edge Add-ons chính thức (máy không join domain thì Edge/Chrome chỉ ép cài được extension đã lên cửa hàng). Chỉ làm Edge, không làm Chrome Web Store; chấp nhận ID extension MỚI do cửa hàng cấp (NativeHost phải nướng ID mới, storage cục bộ reset, dữ liệu server không mất); giữ bản cài tay (unpacked) để debug; chính sách ép cài chỉ bật sau khi extension ổn định.
- **Vì sao:** Ràng buộc kỹ thuật của Windows/Edge trên máy không join domain; tài khoản Edge Add-ons đã đăng ký + xác minh 18/11/2026 (Individual, Việt Nam, tên hiển thị "NDT Soft").
- **Ngày:** 18/11/2026 (anh quyết 14:47). **Ai quyết:** anh Tiến.

## A-07. Domain dự án: ndt.ap.vn thay cho ndtcoder.io.vn
- **Đổi gì:** Domain dùng cho email/hạ tầng SafePC là `ndt.ap.vn` (đăng ký chiều 18/11/2026, DNS cấu hình từ Resend); bỏ phương án `ndtcoder.io.vn` — hóa đơn của phương án cũ KHÔNG thanh toán.
- **Vì sao:** Anh Tiến đổi lựa chọn domain khi đăng ký thực tế.
- **Ngày:** 18/11/2026. **Ai quyết:** anh Tiến.
- **Diễn biến sau:** domain live 25/11/2026, Resend đã verified cùng ngày; email thật đầu tiên qua Edge Function đã tới hộp thư phụ huynh 25/11/2026 15:50.

## A-08. Tên xưng của AI: TraMuse / em My (thay "em MyMuse")
- **Đổi gì:** AI tự xưng là **TraMuse** hoặc **em My**; gọi user là **anh Tiến**; luôn trao đổi bằng tiếng Việt.
- **Vì sao:** Anh Tiến đổi tên cho trợ lý để gọi thân thương hơn.
- **Ngày:** 18/11/2026. **Ai quyết:** anh Tiến.

## A-09. Artifact CI: retention 14 ngày
- **Đổi gì:** Bước upload-artifact trong `.github/workflows/ci.yml` đặt `retention-days: 14` (trước đó mặc định GitHub giữ 90 ngày); chủ trương xóa bản cài cũ, chỉ giữ bản cài hiện hành.
- **Vì sao:** GitHub báo dung lượng Actions đạt 90% hạn mức gói Free (0,46/0,5 GB, email 19/11/2026) — artifact bản cài ~95 MB mỗi run chất đống sẽ chặn các lần tải lên sau. (Con số 0,5 GB là mức trung bình theo thời gian, không phải tổng tức thời; KHÔNG đặt ngân sách $0 cho Actions vì sẽ chặn luôn lần tải bản cài mới.)
- **Ngày:** 19/11/2026 (anh quyết 08:21; triển khai commit 16f7550, run #287 xanh). **Ai quyết:** anh Tiến.

## A-10. Sprint 5: phương án 2 — một phiên active
- **Đổi gì:** Quản lý nhiều con trên một máy theo phương án 2: chỉ phiên console đang active mới bị thi hành luật; phiên nền tạm dừng (không thi hành, không tính giờ) cho tới khi quay lại console; lệnh gắn theo từng con, lệnh cho con chưa active thì hoãn tới khi con đó lên console; một file `domain_rules.json` chung mang luật của con đang active; mỗi con vẫn có thể có nhiều máy, quản lý theo hồ sơ từng con. KHÔNG chọn phương án 1 (thi hành đầy đủ theo từng phiên).
- **Vì sao:** Phương án 1 phải giữ cache luật riêng từng con, xuất domain rules riêng từng tài khoản Windows, và khóa phiên nền không xác định ở tầng Win32 (`LockWorkStation` chỉ khóa console). Phương án 2 tốn khoảng 60–70% công sức phương án 1 (ước lượng) với cái giá chấp nhận được. Chi tiết: PRD §2.11.
- **Ngày:** 20/11/2026 (anh phê duyệt 23:18). **Ai quyết:** anh Tiến.

## A-11. Tài khoản Standard chưa gắn hồ sơ con: không quản lý + cảnh báo trên Dashboard
- **Đổi gì:** Tài khoản Windows Standard chưa được gắn với hồ sơ con nào thì KHÔNG bị quản lý, nhưng phải HIỆN CẢNH BÁO trên Dashboard để phụ huynh thấy. Không dùng tùy chọn "tài khoản chưa gắn = con còn lại".
- **Vì sao:** Anh Tiến chốt trong các lựa chọn xử lý tài khoản chưa gắn của Sprint 5; thà không quản lý còn hơn quản lý nhầm con, nhưng phụ huynh phải nhìn thấy để gắn bổ sung.
- **Ngày:** 20/11/2026 (anh chốt 23:29). **Ai quyết:** anh Tiến.

## A-12. Đồng bộ trạng thái lúc gắn: phương án (a) — sao chép trạng thái lúc gắn
- **Đổi gì:** Khi gắn thêm con B vào máy chung, trạng thái thi hành hiện tại của B (khóa cưỡng chế + tối đa 1 ghi đè đang hiệu lực kể cả giờ thưởng) được SAO CHÉP sang máy đó ngay lúc gắn, kiểu migration 21 — triển khai bằng migration 27 (RPC `safepc_sync_enforcement_state_to_device`), Dashboard gọi ngay sau khi gắn, best-effort (chưa áp migration 27 thì gắn vẫn xong, chỉ hiện ghi chú; gắn trước khi áp M27 thì sau khi áp phải gỡ rồi gắn lại mới đồng bộ). KHÔNG chọn phương án (b) Service tự suy ra khi con lên console.
- **Vì sao:** Nếu không đồng bộ, con B ngồi vào máy chung sẽ không chịu lệnh khóa/ghi đè đang hiệu lực của mình vì máy này chưa từng tiêu thụ lệnh của B qua vòng poll.
- **Ngày:** 21/11/2026 (anh chọn 12:32). **Ai quyết:** anh Tiến.

## A-13. zalo.me thuộc danh mục "Mạng xã hội"
- **Đổi gì:** Thêm `zalo.me` vào danh sách hạt giống của danh mục "Mạng xã hội" trong `DomainCategoryLists.cs` (danh mục tăng 16 → 17 domain; tổng hạt giống 53 → 54). Đã sửa trong cây local, build xanh; đẩy cùng đợt Agent tiếp theo (đang chờ sau khi anh test xong bản 309).
- **Vì sao:** Diệu Linh xin mở Zalo Web (chat.zalo.me) 3 lần chiều 21/11/2026; anh Tiến xác nhận zalo.me là mạng xã hội. Nhất quán với A-05 (các web nhắn tin/trò chuyện thuộc danh mục Mạng xã hội).
- **Ngày:** 24/11/2026. **Ai quyết:** anh Tiến.

## A-14. Lưu cụm từ tìm kiếm trên công cụ tìm kiếm (kiểm duyệt từ khóa)
- **Đổi gì:** SafePC trích và LƯU cụm từ tìm kiếm của con trên 5 công cụ tìm kiếm (Google, Bing, DuckDuckGo, Yahoo, Cốc Cốc) vào bảng `search_terms` (migration 28), kèm cờ bị chặn hay không, giữ 90 ngày như lịch sử web; đồng thời có quy tắc chặn theo từ khóa (mode `block_search_keywords`) — cụm từ chứa từ khóa bị cấm thì bị chặn và hiện trang cảnh báo. Đây là lần nới ranh giới riêng tư tiếp theo sau A-04: quyết định ngày 18/11/2026 là mọi URL đều bỏ phần truy vấn, chỉ lưu tên miền + đường dẫn; nay RIÊNG cụm từ tìm kiếm trên các công cụ tìm kiếm được giữ lại nguyên văn. Mọi URL khác vẫn bỏ query/fragment như cũ.
- **Vì sao:** Anh Tiến yêu cầu tính năng kiểm duyệt từ khóa tìm kiếm kiểu Microsoft Family Safety (chặn tìm kiếm vướng từ khóa bị cấm + hiện cảnh báo) và thống kê/tóm tắt các từ khóa đã tìm vào báo cáo tuần như lịch sử web. Đã xây ở cây local 27/11/2026 (Dashboard + extension + backend), chờ đẩy cùng đợt sau khi anh test xong v0.1.309; migration 28 cần chạy tay sau migration 24/27.
- **Bổ sung cùng quyết định (27/11/2026, anh yêu cầu 14:51):** danh sách từ cấm mẫu được chia theo 6 CHỦ ĐỀ — Nội dung người lớn (16+/18+), Cờ bạc / cá cược, Bạo lực, Game, Phim, Mạng xã hội — để phụ huynh tích chọn cả nhóm, cộng thêm từ khóa riêng của gia đình. (Nhóm "Cờ bạc / cá cược" được TÁCH ra khỏi nhóm người lớn theo review độc lập 27/11/2026: bộ mẫu gốc gộp cả hai, nhưng nhãn nhóm phải nói đúng nội dung.) Config lưu thêm `groups` (id các nhóm đã chọn) và `customKeywords` (từ riêng), nhưng `keywords` vẫn là danh sách hiệu lực duy nhất backend đọc nên không đổi hợp đồng phía sau; mẫu sẵn "Chặn từ khóa tìm kiếm" bật sẵn nhóm Nội dung người lớn (16+/18+).
- **Ngày:** 27/11/2026. **Ai quyết:** anh Tiến.

## A-15. Lưu nội dung tin nhắn trong kênh nhắn tin gia đình
- **Đổi gì:** SafePC có kênh nhắn tin tích hợp chỉ trong gia đình (migration 29): bảng `messages` LƯU NỘI DUNG tin nhắn hai chiều giữa phụ huynh và con, kèm mốc đã đọc hai phía; bảng `chat_sessions` giữ phiên chat của con trên máy con (chỉ lưu hash SHA-256 của token phiên 12 giờ). Tin nhắn nằm trong file xuất dữ liệu của con và bị xóa khi phụ huynh xóa dữ liệu con (RPC `safepc_delete_child_data` được migration 29 mở rộng thêm hai mục này). Đây là lần nới ranh giới riêng tư tiếp theo sau A-04/A-14: trước nay nguyên tắc là không lưu nội dung liên lạc của con.
- **Vì sao:** Anh Tiến yêu cầu ngày 27/11/2026 một kênh để con liên lạc với bố mẹ mà không phải dùng ứng dụng nhắn tin bên ngoài gây xao lãng. Nội dung ở đây khác hẳn "đọc trộm" nội dung chat của con ở ứng dụng khác (việc đó vẫn bị cấm tuyệt đối): đây là kênh liên lạc hai chiều NGAY trong sản phẩm, do chính phụ huynh và con chủ động gửi cho nhau, cả hai phía đều là người tham gia cuộc trò chuyện và đều biết tin nhắn được lưu trong hệ thống của gia đình. Phương án dùng app bên thứ ba (Telegram/WhatsApp) với danh bạ được phép đã được cân nhắc và loại vì các app đó không cho bên ngoài kiểm soát danh bạ — xem PRD §2.13. V1 chỉ tin nhắn chữ, làm trước trên web; gọi thoại/video để giai đoạn Android.
- **Ngày:** 27/11/2026. **Ai quyết:** anh Tiến.

## A-16. Thông báo đẩy (push) là BẮT BUỘC cho nhắn tin — v1 Web Push cho PWA
- **Đổi gì:** Thay trạng thái cũ "đẩy thông báo (push) để sau cùng app Android" (PRD §2.6/§3 và ROADMAP từng ghi): push trở thành một phần của v1 nhắn tin. Phạm vi v1: Web Push cho Dashboard PWA, hai họ sự kiện — (a) tin nhắn chat mới do CON gửi, (b) yêu cầu mới của con (`extra_time` / `unblock_app` / `unblock_domain`, cùng họ với email thông báo hiện có). Hạ tầng mới: migration 30 (bảng `push_subscriptions` lưu đăng ký của PHỤ HUYNH — điểm nhận push + khóa công khai mã hóa của điểm nhận, RLS chỉ chủ sở hữu; cột `messages.push_notified_at`; bảng `push_sends` chống gửi trùng theo từng người nhận) + Edge Function `send-push-notifications` quét mỗi 5 phút. Email và push là HAI KÊNH ĐỘC LẬP: dấu đã gửi của kênh này không chặn kênh kia. Nội dung push gồm tiêu đề + đoạn xem trước TỐI ĐA 60 ký tự của tin mới nhất (cắt ở server; payload mã hóa theo chuẩn Web Push, chỉ thiết bị của phụ huynh giải mã được) — 0 xem trước thì thông báo vô danh dễ bị bỏ qua, đúng cái push sinh ra để tránh; phụ huynh không muốn xem trước thì tắt push ở header Dashboard. Phía Android/FCM chỉ để sẵn cấu trúc dữ liệu (cột `platform`), build ở giai đoạn app Android dùng chung backend.
- **Vì sao:** Anh Tiến nêu rõ ngày 27/11/2026 (18:38): việc con xin mở chat.zalo.me 4 lần qua Family Safety mà anh không hề biết chính là lý do anh muốn SafePC có nhắn tin — yêu cầu push notification (cả Android và PWA) để không lỡ tin/yêu cầu của con dù không mở app/web. Email thông báo hiện có không đáp ứng được: phụ huynh không mở hộp thư thì vẫn lỡ. Đã xây ở cây local 27/11/2026 (harness migration 30 đạt 26/26); còn chờ các bước tay của anh (cặp khóa VAPID, secret Supabase, biến Vercel, deploy function, áp migration 30 sau 29) — xem ROADMAP mục push.
- **Ngày:** 27/11/2026. **Ai quyết:** anh Tiến.

## A-17. Giờ tin cậy: thi hành theo giờ server + múi giờ gia đình, không theo đồng hồ máy con
- **Đổi gì:** Mọi luật theo giờ (giờ đi ngủ, khung giờ, hạn mức ngày, giờ học tập trung) và ranh giới ngày của thống kê được thi hành theo GIỜ TIN CẬY: giờ server Supabase tại lần đồng bộ cuối + thời gian trôi đơn điệu (TickCount64) trên máy, quy đổi sang MÚI GIỜ GIA ĐÌNH do phụ huynh đặt trên Dashboard (mặc định Asia/Ho_Chi_Minh). Giờ hệ thống và múi giờ Windows của máy con không còn tác dụng với thi hành. Lệch giữa giờ máy và giờ tin cậy > 120 giây vẫn phát sự kiện can thiệp `clock_drift` như hiện nay, nhưng chỉnh giờ từ nay không lách được luật — chỉ bị ghi nhận. Thiết kế đầy đủ: PRD §2.14.
- **Vì sao:** Anh Tiến yêu cầu ngày 27/11/2026: việc check giờ mở máy phải luôn so với giờ internet theo múi giờ UTC+7 phụ huynh đặt, đề phòng con chỉnh giờ/timezone. Cơ chế cũ đã phát hiện lệch giờ khi có mạng nhưng thi hành vẫn theo đồng hồ máy, nên phát hiện được mà chưa bịt được đường lách qua múi giờ.
- **Ngày:** 27/11/2026. **Ai quyết:** anh Tiến. (Trạng thái: ĐÃ XÂY ở cây local ngày 27/11/2026 — migration 31 + TrustedClock + Dashboard; harness PGlite m31 đạt 40/40. Chưa áp migration 31, chưa kiểm chứng máy thật.)

## A-18. Theo dõi khi luật không chặn (rule observations) — gắn liên kết luật vào dữ liệu vốn đã thu
- **Đổi gì:** Mỗi luật cấm có thêm mặt theo dõi mặc định bật (tắt được theo từng luật): khi con dùng app/domain/giờ thuộc diện luật nhưng luật KHÔNG chặn — vì luật đang tắt, vì đang được cho phép tạm thời, hoặc vì không chặn được — Agent ghi một dòng quan sát GỘP (bảng `rule_observations`, migration 31 khi triển khai) gồm luật nào (kèm bản chụp tên + mode lúc ghi), đối tượng nào, bao nhiêu lần/tổng phút, ngữ cảnh nào; hiện trong Báo cáo tuần. Sửa luật → ghi theo thông số mới từ lúc sửa, dòng cũ giữ bản chụp cũ; xóa luật → dừng ghi. Thiết kế đầy đủ: PRD §2.15.
- **Vì sao:** Anh Tiến yêu cầu ngày 27/11/2026: luật cấm chỉ cho thấy phần chặn được; phụ huynh cần biết con làm gì với app/domain bị cấm trong các khoảng luật không thi hành (tắt luật, cho phép tạm thời, chặn hụt) để quyết định bật lại luật hay siết/thả — thông tin này phải lên báo cáo tổng hợp.
- **Ranh giới riêng tư:** KHÔNG phải lần nới ranh giới như A-14/A-15: không thu thêm bất kỳ loại dữ liệu mới nào (tên app, tên miền, thời lượng vốn đã thu theo §2.2/§2.5), chỉ gắn thêm liên kết với luật. Giữ 90 ngày như lịch sử web; nằm trong xuất/xóa dữ liệu của con. Khi triển khai phải cập nhật docs/09 + trang Chính sách riêng tư cho khớp (nêu rõ có ghi nhận này) trước khi bật cho người dùng thật.
- **Ngày:** 27/11/2026. **Ai quyết:** anh Tiến. (Trạng thái: ĐÃ XÂY ở cây local ngày 27/11/2026 — migration 31 + publisher monitorRules + Service đối chiếu/đẩy + Dashboard; docs/09 + trang Chính sách riêng tư đã cập nhật cùng đợt. Chưa áp migration 31, chưa kiểm chứng máy thật.)
