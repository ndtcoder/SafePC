Gói bàn giao SafePC — tạo 2026-11-26.

# M3 — Nghiệm thu Sprint 4: cứng hóa (bản cài v0.1.309)

Phạm vi: PIN gỡ cài đặt, watchdog Tray, cảnh báo `extension_missing` + `tray_stopped`, khóa ACL file nhạy cảm, migration 22 + 23, trang hướng dẫn cài đặt + chính sách riêng tư công khai, header bảo mật. Giao ngày 19/11/2026 (head `e94abb0`), CI run #309 XANH, bản cài **SafePCAgentSetup v0.1.309** (94,8 MB) — hiện là artifact duy nhất còn tải được trên GitHub.

Phần code/CI: **ĐẠT**. Phần máy thật: **CẦN KIỂM TAY toàn bộ** — kịch bản đã giao anh Tiến ngày 20/11/2026, chưa có kết quả (xem OWNER-INBOX T-001; kịch bản gốc ở `docs/03-SECURITY.md` mục "Kịch bản kiểm chứng trên máy thật (Sprint 4)").

| # | Tiêu chí | Bằng chứng tự động | Trạng thái code/CI | Trạng thái máy thật |
|---|---|---|---|---|
| 1 | PIN gỡ cài đặt (dùng chung mã PIN thoát Tray; kiểm tra không tiêu thụ mã; chưa đặt PIN thì gỡ bằng quyền Admin; gỡ im lặng khi đã đặt PIN thì bị chặn) | CI #309 xanh; cơ chế exit code của `Service.exe verify-pin` ghi ở `docs/03-SECURITY.md` | ĐẠT | CẦN KIỂM TAY — kịch bản mục A (6 bước, gồm cả mất mạng) |
| 2 | Watchdog Tray (im lặng >5 phút thì khởi động lại trong phiên user; tối đa 5 lần/giờ; ân hạn 30 phút sau khi thoát bằng PIN) | CI #309 xanh; harness watchdog liên kết code thật `TrayWatchdog.cs` chạy lại 26/11/2026: **16 PASS, ALL PASS** | ĐẠT | CẦN KIỂM TAY — kịch bản mục B (4 bước) |
| 3 | Cảnh báo `extension_missing` (trình duyệt chạy foreground 15 phút mà extension im lặng; tối đa 1 lần/giờ) | CI #309 xanh | ĐẠT | CẦN KIỂM TAY — kịch bản mục C |
| 4 | Cảnh báo `tray_stopped` (Tray không mở lại được sau 5 lần/giờ → sự kiện can thiệp mới) | CI #309 xanh; migration 22 harness PGlite chạy lại 26/11/2026: **10 PASS, 0 FAIL** | ĐẠT | CẦN KIỂM TAY — kịch bản mục B.3 |
| 5 | Khóa ACL file nhạy cảm (chỉ SYSTEM + Admins): `device_token.dat`, `exit_pin_hash.dat`, `agent.db` | CI #309 xanh; rà soát bảo mật Sprint 4 ở `docs/03-SECURITY.md` (đây là mục High đã sửa) | ĐẠT | CẦN KIỂM TAY — kịch bản mục D (đăng nhập tài khoản Standard, đọc file phải bị từ chối) |
| 6 | Migration 23: cron dọn hàng `app_usage` cũ hơn 90 ngày (khớp cam kết lưu trữ trong chính sách riêng tư) | Harness PGlite chạy lại 26/11/2026: **15 PASS, 0 FAIL**; migration đã áp (nằm trong nhóm 1–23) | ĐẠT | ĐẠT ở mức SQL (harness) — việc cron chạy thật trên DB được suy ra từ trạng thái đã áp, không có kiểm chứng riêng |
| 7 | Trang Hướng dẫn cài đặt + Chính sách riêng tư công khai (route `/huong-dan-cai-dat`, `/chinh-sach-rieng-tu`, không cần đăng nhập) | CI #309 xanh; nội dung nguồn ở `docs/08-HUONG-DAN-CAI-DAT.md`, `docs/09-PRIVACY-POLICY.md` | ĐẠT | CẦN KIỂM TAY — mở 2 trang trên bản live và đọc bằng mắt |
| 8 | Header bảo mật trong `vercel.json` | CI #309 xanh; `docs/03-SECURITY.md` ghi "chưa kiểm chứng trên bản live" tại thời điểm viết | ĐẠT | CẦN KIỂM TAY — đối chiếu header trả về từ bản live |
| 9 | Self-test tích hợp trong CI của bản 309 | CI #309: Tray self-test **19/19**, Service IPC self-test **13/13** (đọc trong log job đã mở rộng) | ĐẠT | — (đây là bằng chứng CI, không thay kiểm máy thật) |

## Việc cố ý KHÔNG làm trong Sprint 4 (đã ghi lý do ở `docs/03-SECURITY.md`)

- Không làm migration rate-limit cho mã ghép nối (rủi ro còn lại mức LOW, đã ghi rõ).
- Không thiết kế lại ACL của Named Pipe IPC (rủi ro còn lại mức LOW, đã ghi rõ).
- `npm audit` chưa chạy được từ VM làm việc (registry chặn) — cần chạy lại trên máy có mạng thường trước khi kết luận phía npm.
