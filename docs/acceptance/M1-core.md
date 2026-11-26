Gói bàn giao SafePC — tạo 2026-11-26.

# M1 — Nghiệm thu lõi (Sprint 0–2)

Phạm vi: nền móng (repo, Supabase, Dashboard live), ghép nối thiết bị, đồng bộ quy tắc, khóa/mở máy từ xa, chặn app, chặn domain qua extension, PIN thoát Tray, xin thêm giờ. Đây là phần đã được kiểm chứng trên máy Windows thật (máy con DESKTOP-29JIBOP, tài khoản con "Dieu Linh") trong hai ngày 17–18/11/2026.

Quy ước trạng thái xem `README.md` trong thư mục này.

| # | Tiêu chí | Bằng chứng | Trạng thái |
|---|---|---|---|
| 1 | Ghép nối máy con bằng mã 6 số (hết hạn 5 phút, dùng 1 lần), không cần PowerShell ở luồng chính | Kiểm chứng trên máy thật 16–17/11/2026 (PRD §2.1); sau này bộ cài có thêm trang nhập mã ghép nối (19/11) | **ĐẠT** (máy thật 17/11) |
| 2 | Agent đồng bộ rules từ server mỗi phút và khóa/mở máy theo lệnh từ Dashboard | Kiểm chứng trên máy thật 17/11/2026 với v0.1.136: khóa/mở từ Dashboard hoạt động đầu-cuối (PRD mục 0, §2.6 — lệnh tới trong ~15 giây với polling 15s) | **ĐẠT** (máy thật 17/11, v0.1.136) |
| 3 | Chặn app đang chạy bị đóng + mẫu "Chỉ cho phép Edge" (chặn 10 trình duyệt khác, trừ msedge.exe) | Kiểm chứng trên máy thật 18/11/2026: Chrome bị đóng 2 lần kèm hộp cảnh báo Tray (PRD mục 0, §2.4) | **ĐẠT** (máy thật 18/11) |
| 4 | Chặn domain qua extension và hiện trang chặn SafePC thật | Kiểm chứng trên máy thật 18/11/2026 lúc 13:32 với extension 0.1.4 — sau khi sửa gốc rễ: rule `redirect` của DNR bị trình duyệt bỏ qua âm thầm khi thiếu `host_permissions` (PRD §2.5) | **ĐẠT** (máy thật 18/11, extension 0.1.4) |
| 5 | Ngữ nghĩa unlock: mở khóa tạm thời CHỈ hoãn khóa máy theo giờ giấc; chặn app, focus, nghỉ bắt buộc vẫn thi hành trong lúc mở khóa | Quyết định của anh Tiến 18/11/2026; triển khai ở v0.1.187; kiểm chứng trên máy thật 18/11/2026 (PRD §2.3.1) | **ĐẠT** (máy thật 18/11, v0.1.187) |
| 6 | Kill app tức thì: app bị chặn vừa mở lên bị đóng trong vài giây (không chờ vòng đánh giá định kỳ) | Triển khai ở v0.1.190 (WinEvent hook + Tray báo foreground ngay); kiểm chứng trên máy thật 18/11/2026 lúc 14:12 | **ĐẠT** (máy thật 18/11, v0.1.190) |
| 7 | Miễn trừ phiên admin: phiên của phụ huynh (tài khoản admin, token Limited do UAC) không bị khóa theo luật của con | Kiểm chứng trên máy thật 17–18/11/2026 qua đường TokenElevationType (PRD §2.3.2); nhận định cũ dùng `IsInRole` là sai với token Limited | **ĐẠT** (máy thật 17–18/11) |
| 8 | PIN thoát Tray dùng một lần: nhập đúng và thoát xong thì mã tự gỡ, dùng lại lần 2 bị từ chối | Kiểm chứng trên máy thật tối 17/11/2026 (PRD §2.6); migration 8 đã áp sáng 18/11 | **ĐẠT** (máy thật 17/11) |
| 9 | Xin thêm giờ đầu-cuối: con xin từ Tray, phụ huynh duyệt, máy mở đúng N phút ngay | Kiểm chứng trên máy thật sáng 18/11/2026 (PRD §2.6) | **ĐẠT** (máy thật 18/11) |

## Ghi chú

- Các tiêu chí trên đạt ở các bản v0.1.136–v0.1.190. Những thay đổi lõi ở các bản sau (ví dụ cứng hóa lệnh cũ ở v0.1.258/v0.1.260) được nghiệm thu lại trong kịch bản hồi quy của bản v0.1.309 — xem `M3-sprint4.md` và `docs/verify-owner-guide.md` mục 2 phần 2.
- Khóa đúng giới hạn phút/ngày (daily limit) chưa từng kiểm chứng riêng trên máy thật — ghi nhận trung thực từ PRD mục 6 tiêu chí 2; nằm trong kịch bản hồi quy khi test bản 309.
