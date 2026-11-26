# open-questions.md — Câu hỏi mở của SafePC

Gói bàn giao SafePC — tạo 2026-11-26.

Mỗi câu hỏi: **câu hỏi / bối cảnh / mặc định đang dùng / rủi ro nếu mặc định sai / trạng thái**. "Mặc định đang dùng" là cách hệ thống hiện hành xử sự trong lúc câu hỏi chưa được chốt — không phải quyết định cuối cùng. Nguồn: `docs/01-PRD.md` (§2.8–2.11), `docs/02-ARCHITECTURE.md` §4.13, `~/MEMORY.md`, lịch sử chat.

## OQ-001. Ai vận hành bản đa gia đình, và có mua chứng chỉ ký số không?
- **Câu hỏi:** Khi mở SafePC cho phụ huynh khác dùng (PRD §2.9): ai là người vận hành bản triển khai dùng chung (giữ khóa quản trị Supabase, chịu trách nhiệm dữ liệu)? Có mua domain riêng không? Tài khoản đăng ký cửa hàng extension đứng tên ai? Có mua chứng chỉ ký số cho bộ cài không?
- **Bối cảnh:** PRD §2.9 ghi rõ cả cụm này là "Quyết định còn mở (chưa chốt)". Hạ tầng kỹ thuật đã sẵn phần lớn: một Supabase + một web, dữ liệu tách bằng RLS; bộ cài đã có giao diện ghép nối; trang hướng dẫn + chính sách riêng tư đã có.
- **Mặc định đang dùng:** Chưa mở cho gia đình ngoài — SafePC chỉ chạy cho gia đình anh Tiến. Bộ cài chưa ký số (Windows hiện cảnh báo SmartScreen, phụ huynh phải bấm "vẫn chạy"); chứng chỉ ký số là khoản có phí, "để sau cũng được" theo PRD.
- **Rủi ro nếu mặc định sai:** Không có rủi ro kỹ thuật tức thời; rủi ro là khi mời gia đình ngoài dùng thử mà chưa chốt người vận hành thì không ai chịu trách nhiệm dữ liệu trẻ em của gia đình khác, và bản cài chưa ký dễ làm phụ huynh ngại cài.
- **Trạng thái:** MỞ — chờ anh Tiến quyết (cụm quyết định, không chặn việc hiện tại).

## OQ-002. Khi nào xuất bản extension lên Edge Add-ons?
- **Câu hỏi:** Thời điểm nộp extension lên cửa hàng Edge Add-ons để có ID chính thức và bật được chính sách ép cài (xem AMENDMENTS A-06).
- **Bối cảnh:** Tài khoản nhà phát hành đã đăng ký + xác minh xong 18/11/2026 (Individual, tên hiển thị "NDT Soft"), CHƯA xuất bản extension nào. Mỗi lần nộp/cập nhật phải chờ duyệt tối đa 7 ngày làm việc. Ép cài chỉ hoạt động với extension đã lên cửa hàng, và ID sẽ đổi so với bản cài tay hiện tại.
- **Mặc định đang dùng:** Chờ extension ổn định mới nộp; hiện vẫn dùng bản cài tay (unpacked) để debug. Hệ quả đã biết: với bản cài tay, con có thể tự gỡ/tắt extension — lớp bảo vệ hiện tại là PHÁT HIỆN (mất heartbeat → cảnh báo can thiệp), không phải ngăn chặn.
- **Rủi ro nếu mặc định sai:** Nộp quá sớm → mỗi vòng sửa phải chờ duyệt lại, chậm debug. Để quá lâu → cửa sổ con tự tắt extension mà không bị ngăn vẫn mở.
- **Trạng thái:** MỞ — mặc định "chờ ổn định" do anh Tiến chốt 18/11/2026; thời điểm cụ thể chưa chốt.

## OQ-003. Migration 25 (seen accounts) và migration 26 (RPC ngân hàng giờ theo con) — khi nào viết?
- **Câu hỏi:** Hai migration này hiện mới tồn tại dưới dạng THIẾT KẾ ghi trong TODO của code Dashboard, chưa có file migration. Khi nào triển khai thật?
- **Bối cảnh:** Migration 25 = bảng `device_seen_accounts` + RPC `safepc_report_seen_account` (thiết kế trong `src/lib/deviceChildren.ts`) — phục vụ việc Dashboard liệt kê các tài khoản Windows Tray đã "nhìn thấy" để phụ huynh chọn gắn, không gõ tay. Migration 26 = gắn phạm vi theo con cho RPC `safepc_grant_time_bank`/`safepc_void_time_bank_grant` (thiết kế trong TODO phía trên `handleGrant` ở `TimeBankTab.tsx`) — hiện tại thu hồi giờ thưởng chỉ tới được máy mặc định của con (giới hạn đã ghi trong PRD §2.11).
- **Mặc định đang dùng:** Dashboard đọc seen-accounts theo kiểu best-effort (bảng chưa có thì hiện ghi chú, gắn vẫn chạy); ngân hàng giờ hoạt động theo ngữ nghĩa hiện tại của migration 13/17/27.
- **Rủi ro nếu mặc định sai:** Thấp — cả hai đều là hoàn thiện của Sprint 5, không phải lỗi. Để lâu thì trải nghiệm gắn tài khoản và thu hồi giờ thưởng trên máy phụ của con vẫn dở dang.
- **Trạng thái:** MỞ — chưa lên lịch; làm khi đợt Sprint 5 tiếp theo được mở.

## OQ-004. Ân hạn PIN của watchdog Tray: theo từng phiên hay toàn cục?
- **Câu hỏi:** Ân hạn 30 phút sau khi thoát Tray bằng PIN hiện là ân hạn TOÀN CỤC (áp cho mọi phiên trên máy). Có đổi thành ân hạn theo từng phiên Windows không?
- **Bối cảnh:** Watchdog Tray (Sprint 4): phiên im lặng >5 phút thì khởi động lại Tray, tối đa 5 lần/giờ rồi báo can thiệp `tray_stopped`; sau khi thoát bằng PIN có ân hạn 30 phút để watchdog không bật lại Tray ngay. Giới hạn "toàn cục" đã được ghi nhận khi review Sprint 4 (mục MINOR-7); với Sprint 5 (nhiều con chung máy), ân hạn toàn cục nghĩa là một con thoát bằng PIN thì các phiên con khác cũng được "ân hạn" theo.
- **Mặc định đang dùng:** Ân hạn toàn cục 30 phút.
- **Rủi ro nếu mặc định sai:** Thấp — trong cửa sổ ân hạn, watchdog không khởi động lại Tray ở các phiên khác; nếu một con khác đăng nhập đúng lúc đó và Tray của con đó không chạy, việc thi hành bị chậm tới khi hết ân hạn hoặc Tray tự chạy theo cơ chế khác.
- **Trạng thái:** MỞ — việc cứng hóa theo sau Sprint 5, chưa lên lịch.

## OQ-005. Khe mở khóa tối đa ~15 giây khi hello-sync gặp đổi con
- **Câu hỏi:** Có sửa triệt để hành vi: quyết định `Allowed` ở hello-sync gửi lệnh mở khóa cho BẤT KỲ con nào, tạo khe tối đa ~15 giây mà một con đang bị khóa có thể được mở khóa thoáng qua khi chuyển phiên qua lại không? (Đã ghi nhận là giới hạn đã biết số (7) trong `02-ARCHITECTURE.md` §4.13; có test khẳng định hành vi hiện tại — test 63 của harness resolver.)
- **Bối cảnh:** Đây là lựa chọn thiết kế có ý thức của đợt 1 Sprint 5 (đổi lại việc sửa lỗi "con mới bị kẹt ở màn hình khóa sau chuyển phiên nhanh"), không phải lỗi ẩn. Sửa triệt để cần TrayQueryState mang quyết định theo từng con.
- **Mặc định đang dùng:** Giữ hành vi hiện tại; tick 15 giây tiếp theo sẽ sửa lại quyết định đúng cho con đang active.
- **Rủi ro nếu mặc định sai:** Rất thấp — khe chỉ xuất hiện khi chuyển phiên nhanh qua lại đúng nhịp hello-sync, và tự đóng trong một tick.
- **Trạng thái:** MỞ — đã ghi nhận, chấp nhận tạm; chỉ sửa nếu anh Tiến yêu cầu siết chặt.

## OQ-006. Tiền đề GetLastError của `WTSGetActiveConsoleSessionId` — CHƯA XÁC MINH
- **Câu hỏi:** Khi `WTSGetActiveConsoleSessionId` trả `0xFFFFFFFF` (không có phiên console), việc dùng `GetLastError() == 0` để phân biệt "thật sự không có phiên console" với "API lỗi" có đúng không? Tài liệu Microsoft Learn của hàm này KHÔNG hề nhắc tới GetLastError.
- **Bối cảnh:** Service dùng hàm này để biết con nào đang ở console (Sprint 5). Nếu tiền đề sai, các khoảnh khắc ở màn hình đăng nhập có thể bị phân loại nhầm — nhưng lỗi có giới hạn và tự lành ở tick kế tiếp. Đã có sẵn cơ chế kiểm chứng: Service ghi log chẩn đoán một lần mỗi khi giá trị thay đổi, dòng log chứa `WTSGetActiveConsoleSessionId trả 0xFFFFFFFF, GetLastError=...` kèm mã lỗi thô.
- **Mặc định đang dùng:** Phân loại bằng helper thuần `ActiveChildResolver.ResolveNullConsoleSession(...)` với tiền đề CHƯA XÁC MINH như trên.
- **Rủi ro nếu mặc định sai:** Thấp và tự lành — thi hành luật có thể chệch trong vài giây quanh màn hình đăng nhập/chuyển phiên.
- **Trạng thái:** MỞ — CHƯA XÁC MINH. Cách kiểm: mở log Service trên máy thật tại thời điểm đang ở màn hình đăng nhập, tìm dòng log chẩn đoán nêu trên và đối chiếu mã GetLastError với kỳ vọng.

## OQ-007. Mở khóa / cho phép theo ĐƯỜNG DẪN (path) thay vì chỉ theo domain?
- **Câu hỏi:** Luồng xin mở trang hiện hoạt động ở mức domain (con xin mở một domain, phụ huynh duyệt theo domain). Có mở rộng để duyệt/mở theo đường dẫn cụ thể (ví dụ chỉ mở `example.com/bai-hoc` mà không mở cả domain) không?
- **Bối cảnh:** Quy tắc chặn theo đường dẫn ĐÃ có (rule `urlPatterns` dạng "host/path", chỉ áp cho mode `block_domains`, từ v0.1.183 + extension 0.1.3) — phần chưa có là luồng XIN MỞ và ghi đè tạm thời theo path: yêu cầu xin mở trang hiện chỉ mang domain, và thăm web bị chặn luôn ghi `path = null` ở mọi lớp.
- **Mặc định đang dùng:** Xin mở + cho phép tạm thời ở mức domain.
- **Rủi ro nếu mặc định sai:** Thấp — duyệt theo domain rộng hơn mức tối thiểu cần thiết (mở cả domain khi chỉ cần một trang), nhưng đơn giản và dễ hiểu cho phụ huynh.
- **Trạng thái:** MỞ — thay đổi thiết kế riêng, chưa có quyết định làm hay không.

## OQ-008. Mở khóa tạm thời có XÓA LUÔN khóa cưỡng chế không?
- **Câu hỏi:** Hiện tại: ghi đè mở khóa tạm thời thắng khóa cưỡng chế trong lúc còn hiệu lực, nhưng khi ghi đè hết hạn thì khóa cưỡng chế có hiệu lực TRỞ LẠI. Có đổi thành "mở khóa tạm thời xóa hẳn khóa cưỡng chế" không?
- **Bối cảnh:** Đây là hệ quả của thứ tự ưu tiên RuleEngine (unlock-override > forced lock) kết hợp watermark lệnh khóa cưỡng chế riêng. Hành vi hiện tại đã được anh Tiến chấp thuận như ngữ nghĩa chủ ý khi chốt các đợt liên quan (xem thêm AMENDMENTS A-03 về ngữ nghĩa unlock).
- **Mặc định đang dùng:** KHÔNG xóa — khóa cưỡng chế hiệu lực lại khi ghi đè mở khóa hết hạn. Mặc định này ĐÃ ĐƯỢC CHỐT LÀ CHỦ Ý, không phải hành vi tạm.
- **Rủi ro nếu mặc định sai:** Nếu phụ huynh kỳ vọng "đã mở khóa là hết khóa" thì sẽ bất ngờ khi máy khóa lại lúc hết giờ mở khóa — rủi ro về kỳ vọng, không phải lỗi kỹ thuật.
- **Trạng thái:** ĐÃ CHỐT mặc định hiện tại; chỉ mở lại khi anh Tiến muốn đổi ngữ nghĩa sản phẩm.

## OQ-009. `npm audit` chưa chạy được trên máy này
- **Câu hỏi:** Khi nào và ở đâu chạy `npm audit` cho Dashboard để rà soát lỗ hổng phụ thuộc?
- **Bối cảnh:** Trong đợt Sprint 4 (19/11/2026), `npm audit` KHÔNG chạy được từ VM này vì egress proxy trả 403 khi gọi registry. Đây là một khoản kiểm tra bảo mật còn thiếu, không phải kết quả "sạch".
- **Mặc định đang dùng:** Chưa có kết quả audit; các cổng kiểm tra khác (tsc, build, secret scan) vẫn chạy bình thường mỗi đợt.
- **Rủi ro nếu mặc định sai:** Trung bình-thấp — một phụ thuộc có lỗ hổng đã công bố có thể tồn tại mà không ai biết cho tới khi audit được chạy.
- **Trạng thái:** MỞ — việc cần làm: chạy `npm audit` trên một máy có mạng bình thường (ví dụ máy của anh Tiến) và báo lại kết quả; không chạy được từ VM này.

## OQ-010. ROADMAP thiếu heading "Sprint 3"
- **Câu hỏi:** `docs/04-ROADMAP.md` nhảy từ "Sprint 2" sang "Sprint 4", không có heading `### Sprint 3`. Có bổ sung/đánh số lại không?
- **Bối cảnh:** Reviewer docs phát hiện ngày 20/11/2026 và ghi nhận là vấn đề CÓ SẴN TỪ TRƯỚC, nằm ngoài phạm vi đợt Sprint 5 lúc đó nên chưa sửa. Nội dung các sprint không thiếu — chỉ thiếu một tiêu đề/đánh số.
- **Mặc định đang dùng:** Giữ nguyên văn bản ROADMAP như hiện tại.
- **Rủi ro nếu mặc định sai:** Không đáng kể — chỉ gây khó đọc khi tra cứu lịch sử sprint.
- **Trạng thái:** MỞ — việc nhỏ, sửa khi có đợt chạm vào ROADMAP tiếp theo.
