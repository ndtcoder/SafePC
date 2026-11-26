Gói bàn giao SafePC — tạo 2026-11-26.

# OWNER-INBOX.md — Hộp thư quyết định của anh Tiến

Mỗi mục tự đủ thông tin để anh quyết trong dưới 2 phút. Ký hiệu:

- **D** = quyết định cần anh chốt
- **T** = việc kiểm chứng trên môi trường thật (chỉ anh làm được)
- **X** = dữ liệu cần anh cung cấp
- **S** = đổi spec / việc lớn
- **K** = ký duyệt milestone
- **R** = duyệt sau: trợ lý đã chọn mặc định và làm theo, anh có quyền veto

Cách làm chi tiết từng việc nằm ở `docs/verify-owner-guide.md`. Trạng thái dự án tổng thể ở `docs/STATE.md`.

---

## T-001 — Cài v0.1.309 + extension 0.1.10 và chạy kịch bản kiểm chứng

- **Loại:** T (kiểm thật) · **Từ:** 20/11/2026 · **Đang chặn:** đợt Sprint 5 Dashboard + migration 27
- **Bối cảnh:** Bản cài v0.1.309 (CI #309 xanh, Tray self-test 19/19, IPC 13/13) là bản Sprint 4: PIN gỡ cài đặt, watchdog Tray, cảnh báo extension mất tích / Tray dừng, khóa ACL file nhạy cảm. Toàn bộ mới chỉ xanh ở kiểm tra tự động, chưa qua máy thật lần nào.
- **Việc cần làm:** Cài v0.1.309 trên máy con (từ tài khoản admin của anh), cập nhật extension 0.1.10, chạy kịch bản 3 phần đã giao ngày 20/11: Phần 1 Sprint 4 (mục A–D trong `docs/03-SECURITY.md`), Phần 2 hồi quy lõi (khóa/mở, Chỉ cho phép Edge, trang chặn, ngữ nghĩa unlock), Phần 3 các đợt mới (ngân hàng giờ, chặn danh mục, xin mở domain, lịch sử web, chuông thông báo, audit, xuất dữ liệu trên hồ sơ con THỬ, MFA tùy chọn). Hướng dẫn: `docs/verify-owner-guide.md` mục 2.
- **Hệ quả:** Xong mục này mới đẩy được Sprint 5 Dashboard + migration 27 lên `main` (vì Vercel tự deploy theo main — đẩy sớm sẽ làm bản Sprint 5 rơi xuống giữa buổi test của anh). Có lỗi thì gửi log/ảnh chụp, trợ lý sửa theo bằng chứng.

## T-002 — Áp migration 24 rồi migration 27 trong Supabase SQL Editor

- **Loại:** T (kiểm thật) · **Đang chặn:** kích hoạt Sprint 5 trên DB thật
- **Bối cảnh:** Migration 24 (ánh xạ thiết bị ↔ con ↔ tài khoản Windows) đã có trên GitHub nhưng chưa áp. Migration 27 (đồng bộ trạng thái lúc gắn) mới ở cây local, **phải áp 24 trước** vì 27 dùng bảng và cột của 24. Trình duyệt tự động không paste được vào SQL Editor nên việc này chỉ anh làm được.
- **Việc cần làm:** Paste + chạy từng file theo hướng dẫn fidelity ở `docs/verify-owner-guide.md` mục 1. Không gấp — không ảnh hưởng buổi test bản 309.
- **Lưu ý quan trọng:** Đồng bộ lúc gắn chỉ chạy đúng thời điểm gắn. Nếu anh gắn tài khoản con vào máy **trước khi** áp migration 27, thì sau khi áp phải **gỡ rồi gắn lại** mới đồng bộ được trạng thái khóa/ghi đè sang máy đó.

## T-003 — Kiểm tra email báo cáo tuần tự động đầu tiên

- **Loại:** T (kiểm thật) · **Mốc:** sáng thứ Hai, 07:00 giờ Việt Nam
- **Bối cảnh:** Đường email đã thông hẳn (email thông báo phụ huynh gửi thật thành công 25/11). Nhưng email báo cáo tuần do cron tự gửi (thứ Hai 00:00 UTC) chưa từng chạy thật lần nào.
- **Việc cần làm:** Sáng thứ Hai mở hộp thư phụ huynh, xem có email báo cáo tuần từ `SafePC <bao-cao@ndt.ap.vn>` không. Hướng dẫn: `docs/verify-owner-guide.md` mục 6.
- **Hệ quả:** Có email → đường báo cáo tuần đóng kín đầu-cuối. Không có → báo trợ lý, trợ lý kiểm tra theo thứ tự: secret đã đặt đúng chưa → function đã deploy lại sau khi đổi secret chưa → trạng thái bảng `weekly_report_sends`.

## T-004 — Bật 2FA cho tài khoản GitHub trước 04/01/2027

- **Loại:** T (kiểm thật) · **Hạn:** 04/01/2027 00:00 UTC
- **Bối cảnh:** GitHub gửi email ngày 20/11/2026 yêu cầu tài khoản `ndtcoder` bật xác thực hai yếu tố trong 45 ngày. Quá hạn, quyền truy cập GitHub bị giới hạn cho tới khi bật — repo SafePC nằm ở đó nên đây là rủi ro vận hành thật. (2FA của Vercel đã bật rồi, đây là GitHub, khác nhau.)
- **Việc cần làm:** Bật bằng app authenticator anh đang dùng cho Vercel; lưu mã khôi phục ở chỗ an toàn. Hướng dẫn: `docs/verify-owner-guide.md` mục 4.

## T-005 — Kiểm dòng chẩn đoán GetLastError trong log Service ở màn hình đăng nhập

- **Loại:** T (kiểm thật) · **Không gấp** — làm khi có dịp mở log Service lúc máy đang ở màn hình đăng nhập
- **Bối cảnh:** Sprint 5 dựa vào một tiền đề CHƯA XÁC MINH về hàm Windows `WTSGetActiveConsoleSessionId`: khi không có phiên console nào (màn hình đăng nhập), cách Service phân biệt "chưa ai đăng nhập" với "API lỗi" dựa trên GetLastError — tài liệu Microsoft không ghi rõ hành vi này. Service đã được gắn sẵn dòng log chẩn đoán để kiểm chứng trên máy thật.
- **Việc cần làm:** Khi máy ở màn hình đăng nhập, xem log Service (`%ProgramData%\SafePC`, file log của Service) có dòng dạng `WTSGetActiveConsoleSessionId trả 0xFFFFFFFF, GetLastError=...` không; chụp/gửi lại dòng đó cho trợ lý.
- **Hệ quả:** Có dòng log + giá trị rõ ràng → tiền đề được xác minh hoặc bác bỏ bằng bằng chứng; nếu sai, ảnh hưởng bị chặn và tự lành ở lần đánh giá tiếp theo (tối đa ~15 giây), trợ lý sẽ sửa cách phân loại.

## D-001 — Sau 01/12/2026 có chạy lại job lỗi của CI #317 để lấy bản cài v0.1.317 không

- **Loại:** D (quyết định) · **Đề xuất của trợ lý: CÓ**
- **Bối cảnh:** CI #317 (Sprint 5 đợt 1) code đã xanh toàn bộ, chỉ bước tải artifact bị đỏ vì hết hạn mức lưu trữ Actions. Hạn mức reset ngày 01/12/2026. Chạy lại đúng job lỗi đó (không chạy lại cả run) sẽ cho bản cài v0.1.317 — bản Sprint 5 đầu tiên cài được lên máy thật.
- **Lựa chọn:** (a) Chạy lại sau 01/12 — có bản Sprint 5 để test đa phiên; (b) Không chạy — chờ đợt đẩy Sprint 5 Dashboard tạo run mới rồi lấy bản ở run đó.
- **Hệ quả nếu chọn mặc định (a):** trợ lý tự chạy lại khi anh gật; nếu vẫn báo lỗi hạn mức (GitHub tính lại mức dùng mỗi 6–12 giờ) thì chờ rồi thử lại sau, không lặp vô hạn. Cách bấm: `docs/verify-owner-guide.md` mục 3.

## D-002 — Đổi mật khẩu tạm + bật 2FA cho hộp thư admin@ndt.ap.vn

- **Loại:** D (quyết định kiêm việc tay) · **Không gấp nhưng đang treo từ 18/11**
- **Bối cảnh:** Hộp thư `admin@ndt.ap.vn` do Tino tự tạo khi đăng ký tên miền; mật khẩu tạm nằm trong email Tino gửi (trợ lý không giữ và không ghi lại giá trị). Tên miền đã verified trên Resend và đang gửi email thật cho SafePC, nên hộp thư quản trị của nó cần được khóa chặt.
- **Việc cần làm:** Đăng nhập tại mail.tino.vn bằng mật khẩu tạm trong email Tino, đổi mật khẩu, bật 2FA.
- **Mặc định nếu anh chưa làm:** không có rủi ro tức thời đã biết, nhưng mật khẩu tạm trong email là điểm yếu duy nhất còn treo của tên miền này.

## K-001 — Ký duyệt gói bàn giao này

- **Loại:** K (ký duyệt) · **Trạng thái: ĐÃ KÝ ngày 26/11/2026** — anh Tiến xác nhận bản tóm tắt 10 dòng là đúng; các mặc định đi kèm được giữ: đẩy gói lên GitHub `main`, giữ cách đặt file `handoff/` + `docs/`, giữ thứ tự việc tiếp theo ở `docs/STATE.md` mục 10.
- **Bối cảnh:** Gói bàn giao SafePC tạo ngày 26/11/2026 gồm: `docs/STATE.md`, `docs/OWNER-INBOX.md`, `docs/verify-owner-guide.md`, `docs/acceptance/` (README + M1/M2/M3), `docs/AMENDMENTS.md`, `docs/open-questions.md`, kèm các file ngữ cảnh bản chưng cất ở `handoff/` (MEMORY.md, USER.md, SOUL.md, AGENTS.md, IDENTITY.md, PROACTIVE_PREFERENCES.md) và cơ chế backup + chat log đã dựng từ 25/11.
- **Việc cần làm:** Đọc bản tóm tắt 10 dòng trợ lý gửi kèm, xác nhận đúng (hoặc chỉ chỗ sai) → gói được coi là xong. Chỗ nào anh sửa, trợ lý cập nhật lại file tương ứng.

## R-001 — zalo.me đã thêm vào danh mục Mạng xã hội ở cây local (anh có quyền veto)

- **Loại:** R (duyệt sau) · **Mặc định đã chọn:** thêm, theo quyết định của chính anh ngày 24/11/2026 ("zalo.me là mạng xã hội")
- **Bối cảnh:** Diệu Linh xin mở Zalo Web (chat.zalo.me) 3 lần chiều 21/11. Anh chốt zalo.me thuộc danh mục Mạng xã hội; trợ lý đã thêm vào danh sách hạt giống trong `DomainCategoryLists.cs` ở cây local (danh mục social thành 17 domain, tổng hạt giống 54), build local xanh.
- **Trạng thái:** Chưa đẩy — sẽ đi cùng đợt Sprint 5 Dashboard sau khi anh test xong bản 309 (T-001).
- **Veto:** Nếu anh đổi ý trước ngày đẩy, báo trợ lý gỡ `zalo.me` khỏi danh sách trước khi đẩy. Sau khi đã đẩy và cài bản mới, việc gỡ vẫn làm được nhưng phải qua một đợt build nữa.
