Gói bàn giao SafePC — tạo 2026-11-26 từ bộ nhớ làm việc của Muse hiện tại.

# MEMORY.md — Sự thật bền vững về anh Tiến và dự án SafePC

## Anh Tiến là ai
- Tên thật: Đức; luôn gọi là **anh Tiến** (anh dặn; nguồn: USER.md, MEMORY.md).
- Đang ở Hà Nội (cho biết 2026-11-16). Múi giờ làm việc: Asia/Ho_Chi_Minh (GMT+7).
- Tài khoản GitHub: **ndtcoder** (đã kết nối Muse, quyền All repositories — 2026-11-16).
- Anh muốn xây các app hoàn thiện cao, chuyên nghiệp, bảo mật; dùng dịch vụ free, mục tiêu dưới 100 user (2026-11-16).

## Gia đình (chỉ mức cần cho SafePC)
- Vợ của anh Tiến — có thể được mời làm phụ huynh thứ hai trên SafePC (migration 14, xem dưới).
- Hai con: **Diệu Linh** và **Đức Dũng**. Hai con dùng chung một máy tính; SafePC quản lý riêng theo hồ sơ từng con (Sprint 5).
- Diệu Linh mượn máy của Đức Dũng trong giai đoạn đầu nên báo cáo tuần Microsoft Family Safety ghi dưới tên Đức Dũng — đây là dữ liệu máy mượn, anh cho phép dùng làm mốc so sánh cho báo cáo tuần SafePC (anh xác nhận 2026-11-18).

## Dự án SafePC là gì
- App quản lý máy tính của con, gần giống Microsoft Family Safety / Google Family Link: giới hạn giờ dùng máy, chặn app, chặn website theo domain/danh mục, ngân hàng giờ, báo cáo tuần cho phụ huynh (khởi động 2026-11-16).
- Ưu tiên PC (máy con Windows 10, tương thích Windows 11); app Android cho phụ huynh làm sau. Có đăng nhập, dữ liệu nhạy cảm, không cần thanh toán.
- Ranh giới riêng tư đã chốt: thu thập tối thiểu — chỉ tên app, thời lượng, tên miền/đường dẫn web; KHÔNG chụp màn hình, KHÔNG ghi phím, KHÔNG đọc nội dung chat/file, không bật mic/camera (chụp màn hình bị loại khỏi kế hoạch, anh duyệt 2026-11-17).

## Hạ tầng (đã xác minh)
- Repo: **ndtcoder/SafePC**, nhánh main, **Private** (tạo 2026-11-16, đã xác minh Private).
- Backend: **Supabase** — project ref `fzknvolkxnwfxdcfmops`, region Singapore (ap-southeast-1), gói Free, org "ndtcoder's DBs", trạng thái Healthy (tạo 2026-11-16). Mật khẩu DB và khóa quản trị KHÔNG lưu trong gói này — chúng không được ghi lại ở bất kỳ đâu trong bộ nhớ làm việc; khi cần, lấy qua kênh bảo mật của anh Tiến.
- Dashboard: https://safe-pc.vercel.app (Vercel, project safe-pc, team MyHome gói Hobby Free; root apps/dashboard-web). Site URL + Redirect URL của Supabase Auth đang trỏ về địa chỉ này.
- PC Agent: Windows Service + Tray (C#/.NET), bộ cài Inno Setup. Version theo scheme `0.1.<số run CI>` — KHÔNG bao giờ hardcode số version.
- Bản cài hiện hành: **v0.1.309** (CI run #309 xanh, head e94abb0, giao 2026-11-19 23:30) — bản tải được duy nhất còn trên GitHub Actions (artifact các run khác đã xóa hoặc không tải lên được do hết hạn mức). Sprint 5 đợt 1 (head bdfc640) code đã xanh ở CI #317 nhưng artifact bị chặn vì hết hạn mức Actions 0.5 GB; hạn mức reset 01/12/2026.
- Extension trình duyệt: MV3 (Edge/Chrome), bản hiện hành 0.1.10; ID Edge hiện tại `djcgbhjbmcccdgedbmfihdpeeanmldbd` (sẽ đổi khi lên Edge Add-ons).

## Quyết định đã chốt (kèm ngày)
- Tên app **SafePC**, backend Supabase (2026-11-16).
- Cài Agent một lần từ tài khoản admin của anh; Service chạy cho cả máy, Tray tự chạy mọi phiên đăng nhập; con dùng tài khoản Standard nên không tự gỡ được (2026-11-16).
- Cả 3 hướng lớn được duyệt (2026-11-17): tính năng nâng cao + giao diện chuyên nghiệp; flow cài đặt cho phụ huynh khác (đa gia đình, tách dữ liệu bằng RLS); báo cáo tuần dùng Recharts + email, KHÔNG dùng Power BI. Còn mở: ai vận hành bản đa gia đình, chứng chỉ ký số.
- **Ngữ nghĩa unlock** (anh chốt 2026-11-18, v0.1.187): mở khóa tạm thời CHỈ hoãn khóa máy theo giờ giấc; chặn app, giờ học tập trung, nghỉ bắt buộc vẫn thi hành trong lúc mở khóa. Đã chứng minh trên máy thật 2026-11-18.
- **Lịch sử web** (anh chốt 2026-11-18 23:13): lưu tên miền + đường dẫn, BỎ query và fragment; giữ 90 ngày rồi tự xóa. Đây là quyết định nới ranh giới riêng tư do chính anh quyết.
- **Danh mục chặn**: WhatsApp Web/Telegram Web/LinkedIn GIỮ trong danh mục "Mạng xã hội" (anh chốt 2026-11-18 22:49). **zalo.me thuộc danh mục Mạng xã hội** (anh quyết 2026-11-24) — đã thêm vào danh sách hạt giống trong cây local (social 17 domain, tổng 54), chờ đẩy cùng đợt sau. Nguồn sự thật duy nhất của danh sách: `DomainCategoryLists.cs` trong Service. Giới hạn thật: danh sách hạt giống chỉ gồm site phổ biến nhất, site mới/mirror sẽ lọt.
- **Ép cài extension**: chỉ qua **Edge Add-ons** (máy không join domain thì không ép cài được extension tự host). Tài khoản nhà phát triển đã đăng ký + xác minh 2026-11-18 bằng email ndt.coder@gmail.com, tên hiển thị "NDT Soft", trạng thái Authorized, CHƯA xuất bản extension nào. Anh đồng ý ID extension sẽ đổi khi lên store; giữ bản cài tay để debug; chỉ bật ép cài sau khi extension ổn định.
- **Domain + email**: ndt.ap.vn (đăng ký 2026-11-18, hạn tới 18/11/2029). DNS live 2026-11-25; **Resend đã verified 2026-11-25** (domain id f4963db3; gửi bật, nhận tắt); địa chỉ gửi `SafePC <bao-cao@ndt.ap.vn>`; 2 Edge Function email (send-weekly-report, send-parent-notifications) đã deploy lại. **Test gửi mail thật ĐÃ QUA 2026-11-25 15:50**: email báo máy DESKTOP-29JIBOP offline >48h đã tới đúng hộp thư phụ huynh — toàn bộ đường email Edge Function + Resend đã thông. Key Resend hiện hành nằm trong connector `custom.resend` của Muse (kết nối lại 2026-11-25) — giá trị key KHÔNG ghi ở đây.
- **Sprint 5 — phương án 2 "một phiên active"** (anh chốt 2026-11-20): nhiều con dùng chung một máy, quản lý riêng theo hồ sơ từng con; chỉ phiên console đang active bị thi hành luật, phiên nền tạm dừng; lệnh cho con chưa active thì hoãn tới khi con đó lên console (Dashboard hiện "sẽ áp dụng khi con đăng nhập"); mỗi con có thể có nhiều máy. Tài khoản Standard chưa gắn với con nào: không quản lý + hiện cảnh báo trên Dashboard (anh chốt 2026-11-20 23:29).
- Đồng bộ trạng thái lúc gắn tài khoản: anh chọn phương án (a) — copy trạng thái lúc gắn, kiểu migration 21 (anh chọn 2026-11-21 12:32). Migration 27 + đợt Dashboard Sprint 5 đã xây xong, review APPROVED 2026-11-21, đang giữ ở cây local CHƯA đẩy — chờ anh test xong bản 309 mới đẩy (vì Vercel tự deploy theo main).
- Migration 24 (Sprint 5 đợt 1) đã đẩy lên GitHub nhưng CHƯA áp vào DB; migration 27 chưa đẩy, chưa áp. Cả hai cần anh paste + chạy tay trong Supabase SQL Editor khi giao (trình duyệt tự động không paste được vào SQL Editor). Migration 1–23 đã áp xong (xác nhận 2026-11-20).
- Ngân hàng giờ (migration 13, đã áp): thưởng cộng vào mức trần tới hết ngày, nhiều lần cộng dồn, RPC gửi lệnh mang TỔNG số phút; số dư là tổng đã thưởng, không trừ theo giờ đã dùng; thưởng/thu hồi thay thế ghi đè đang hiệu lực.
- Mời phụ huynh thứ hai (migration 14, đã áp): link mời dùng một lần, hạn 7 ngày, anh tự gửi link qua tin nhắn/Zalo (chưa có email mời tự động). CHƯA có giao diện gỡ phụ huynh đã tham gia — mời nhầm email đã chấp nhận thì chỉ gỡ tay trong DB.
- Xuất/xóa dữ liệu (migration 15, đã áp): xóa là xóa cả hồ sơ con + cả máy của con, chỉ giữ 1 hàng audit. Khi kiểm chứng xóa, CHỈ thử trên hồ sơ con THỬ — không bao giờ dùng hồ sơ Diệu Linh.

## Việc nền đang chạy (dựng 2026-11-25 theo spec của anh)
- **Backup cây làm việc** `~/workspace/projects/safepc` mỗi 30 phút: script `~/workspace/scripts/backup-safepc.sh`, chỉ nén khi nội dung đổi (hash), giữ 12 snapshot ở `~/workspace/backups/safepc/`, loại trừ node_modules/coverage/test-results/.turbo/user-chat. Cron: `backup-safepc-30m`. Đã kiểm chứng chạy thật 2026-11-25 23:15 (snapshot đầu 15,7 MB; chạy lại báo "no change, skip").
- **Chat log**: lưu ở `~/workspace/projects/safepc/user-chat/` (main.md + một file mỗi side chat; chỉ tin của anh + reply của trợ lý; append ngay mỗi lượt) và đẩy lên GitHub repo ndtcoder/SafePC nhánh riêng `chat-logs` mỗi 30 phút khi đổi. Cron: `chatlog-push-safepc-30m`; state ở `~/workspace/chat-log-push-state.json`; guard mtime 2 phút; chỉ ghi state sau khi upload thành công.
- Cả hai việc im lặng khi bình thường, chỉ báo khi lỗi (backup: snapshot quá 2 giờ do cây không đổi thì báo đúng 1 lần).
- Lưu ý môi trường: cây local trên máy này KHÔNG có thư mục `.git` (đã kiểm chứng 2026-11-25) — lịch sử commit nằm trên GitHub; khôi phục từ snapshot thì giải nén vào thư mục TẠM kiểm tra trước, không đè lên cây live.

## Việc đang chờ anh (tính đến 2026-11-26)
- Test bản cài v0.1.309 + extension 0.1.10 trên máy thật theo kịch bản trong docs/03 (chưa có kết quả báo về). Xong bước này mới đẩy đợt Dashboard Sprint 5 + migration 27.
- Kiểm tra hồ sơ giấy tờ tên miền .vn với Tino (bản khai + CMND cho ndt.ap.vn và myhome.ap.vn) — đã nhắc 2026-11-26; CHƯA XÁC MINH anh đã nộp hay chưa. Cách kiểm: hỏi anh hoặc xem trạng thái hồ sơ trong Tino clientarea.
- Bật 2FA cho GitHub (hạn 04/01/2027 theo email GitHub 2026-11-20) — CHƯA XÁC MINH đã bật. Cách kiểm: hỏi anh.
- Sau 01/12/2026 (hạn mức Actions reset): chạy lại job lỗi của CI run #317 để lấy bản cài Sprint 5 v0.1.317.
- Mỗi lần build thành công phải ghi thêm vào `~/workspace/goals/safepc-parental-control-app/files/danh-sach-build-thanh-cong.md` (anh dặn 2026-11-24).
