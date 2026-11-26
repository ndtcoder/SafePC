Gói bàn giao SafePC — tạo 2026-11-26.

# M2 — Nghiệm thu đợt tính năng nâng cao (18–19/11/2026)

Phạm vi: 9 mục đã phê duyệt ngày 17/11/2026 (PRD §2.8) cộng các đợt bổ sung ngay sau đó (thông báo trong Dashboard, xin mở domain, tìm kiếm lịch sử web, audit đổi luật, báo cáo tuần). Toàn bộ đã xong phần code, CI xanh từng đợt. Trừ email thông báo phụ huynh, **chưa mục nào được kiểm chứng trên máy thật / điện thoại thật / tài khoản thật** — trạng thái máy thật mặc định là CẦN KIỂM TAY.

Số run CI lấy từ PRD §2.8; mục nào PRD không ghi số run thì ghi rõ CHƯA XÁC MINH tại tài liệu này (đối chiếu thêm ở `~/workspace/goals/safepc-parental-control-app/files/danh-sach-build-thanh-cong.md`).

| # | Hạng mục | Bằng chứng phần code | Trạng thái code | Trạng thái máy thật |
|---|---|---|---|---|
| 1 | Tổng quan hôm nay (thẻ trạng thái máy, giờ còn lại, biểu đồ giờ dùng, top app/domain) | head `f29b937`, CI #215 xanh (PRD §2.8) | ĐẠT | CẦN KIỂM TAY — chưa xem với dữ liệu thật / trên điện thoại thật |
| 2 | Email thông báo phụ huynh (xin thêm giờ, can thiệp, máy offline >48h) | head `a40a51a`, CI #218 xanh; Edge Function `send-parent-notifications` + migration 12 | ĐẠT | **ĐẠT** — gửi thật thành công 25/11/2026 15:50 (email máy offline, từ `bao-cao@ndt.ap.vn` tới hộp thư phụ huynh, sau khi domain verified) |
| 3 | Nhật ký hoạt động (route `/nhat-ky`) | head `2838181`, CI #222 xanh (PRD §2.8) | ĐẠT | CẦN KIỂM TAY — chưa xem với dữ liệu thật |
| 4 | Audit đổi luật (Dashboard tự ghi audit khi sửa rule, bổ sung cho mục 3) | Đợt follow-up sau nhật ký hoạt động; PRD không ghi số run — CHƯA XÁC MINH số run tại tài liệu này | ĐẠT | CẦN KIỂM TAY |
| 5 | Ngân hàng giờ (thưởng giờ kèm lý do + lịch sử; Tray hiện giờ thưởng) | head `eda2c5b`, CI #228 xanh, installer v0.1.228 (cài thẳng v0.1.229); migration 13 (PRD §2.8) | ĐẠT | CẦN KIỂM TAY — ngữ nghĩa đã chốt: thưởng cộng vào mức trần tới hết ngày, nhiều lần cộng dồn, số dư không trừ theo giờ đã dùng |
| 6 | Chặn theo danh mục domain (người lớn 14, cờ bạc 23, mạng xã hội 16 — tổng hạt giống 53 ở bản CI #229; nay 17/54 sau khi thêm zalo.me ở cây local, chưa đẩy) | head `bb632b6`, CI #229 xanh, installer v0.1.229 + extension 0.1.8 (PRD §2.8) | ĐẠT | CẦN KIỂM TAY — giới hạn trung thực: danh sách hạt giống chỉ gồm site phổ biến nhất, site mới/mirror sẽ lọt |
| 7 | Mời phụ huynh thứ hai (link mời token hiện một lần, hạn 7 ngày) | head `c7b5a4c`, CI #238 xanh; migration 14 (PRD §2.8) | ĐẠT | CẦN KIỂM TAY — rủi ro chính: claim email trong JWT chưa từng thử ở project này. CHƯA có giao diện gỡ phụ huynh đã tham gia |
| 8 | Xuất / xóa dữ liệu của con (tab Dữ liệu: xuất 1 file JSON 10 mục; xóa phải gõ đúng tên con) | head `4d713f3`, CI #241 xanh; migration 15 (PRD §2.8) | ĐẠT | CẦN KIỂM TAY — chỉ thử xóa trên hồ sơ con THỬ, tuyệt đối không dùng hồ sơ thật; xóa là xóa cả hồ sơ + cả máy của con |
| 9 | Chuẩn hóa giao diện (trạng thái rỗng/tải/lỗi/mất mạng + hướng dẫn lần đầu) | head `40fa948`, CI #245 xanh (PRD §2.8) | ĐẠT | CẦN KIỂM TAY — chưa kiểm bằng mắt trên điện thoại thật |
| 10 | MFA cho tài khoản phụ huynh (TOTP tự nguyện qua Supabase Auth) | PRD §2.8 xác nhận đã triển khai, không ghi số run — CHƯA XÁC MINH số run tại tài liệu này | ĐẠT | CẦN KIỂM TAY — chưa kiểm đầu-cuối trên tài khoản thật. Lưu ý: không có mã khôi phục tự phục vụ; mất thiết bị thì quản trị project Supabase gỡ factor |
| 11 | Thông báo trong Dashboard (chuông ở header + trang `/thong-bao`, mốc đã đọc theo user) | Cùng đợt thông báo ở PRD §2.8; migration 20; PRD không ghi số run riêng — CHƯA XÁC MINH số run tại tài liệu này | ĐẠT | CẦN KIỂM TAY |
| 12 | Yêu cầu mở khóa domain (nút "Xin phép mở trang này" trên trang chặn, extension 0.1.9) | PRD §2.5/§2.8 (extension 0.1.9); PRD không ghi số run — CHƯA XÁC MINH số run tại tài liệu này | ĐẠT | CẦN KIỂM TAY — duyệt yêu cầu sẽ thay thế ghi đè đang hiệu lực (đã ghi rõ trong UI) |
| 13 | Tìm kiếm lịch sử web trong Báo cáo tuần (lưu domain + đường dẫn, bỏ query/fragment, giữ 90 ngày) | Extension 0.1.10 + migration 19 (PRD §2.5); PRD không ghi số run — CHƯA XÁC MINH số run tại tài liệu này | ĐẠT | CẦN KIỂM TAY |
| 14 | Báo cáo tuần — trang Dashboard (đủ 7 mục, Recharts) | head `126f7765` (PRD §2.10), đã live tại route `/bao-cao` | ĐẠT | CẦN KIỂM TAY — chưa kiểm với dữ liệu thật |
| 15 | Báo cáo tuần — email tự động mỗi thứ Hai 07:00 +07 | head `4485d5e`, CI #212 xanh; Edge Function `send-weekly-report` + migration 11 (PRD §2.10); function đã deploy 21/11, domain đã verified 25/11 | ĐẠT | CẦN KIỂM TAY — chờ email tự động đầu tiên (xem OWNER-INBOX T-003) |

## Ghi chú

- Kịch bản kiểm các mục CẦN KIỂM TAY nằm ở Phần 3 của kịch bản test bản 309 đã giao ngày 20/11/2026, tóm tắt lại ở `docs/verify-owner-guide.md` mục 2.
- Migration của đợt này (11–21) đều đã nằm trong nhóm 1–23 ĐÃ ÁP (xem `docs/STATE.md` mục 4) — trạng thái "chưa áp" trong PRD §2.8 là tại thời điểm viết (18/11), đã được thay bằng xác nhận áp đủ 1–23 ngày 20/11/2026.
