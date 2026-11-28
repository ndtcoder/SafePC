Gói bàn giao SafePC — tạo 2026-11-26. STATE.md cập nhật 2026-11-28 (đợt cứng hóa nhỏ) cho khớp hiện trạng main/develop.

# STATE.md — Trạng thái dự án SafePC

Tài liệu này là điểm vào duy nhất để nắm trạng thái dự án. Mọi con số trong mục "Kiểm chứng tươi" đều chạy thật trên máy làm việc (VM Linux) ngày 2026-11-26 và ghi nguyên văn. Trạng thái còn lại lấy từ `docs/01-PRD.md`, `docs/04-ROADMAP.md`, `docs/03-SECURITY.md` và hồ sơ giao đợt đã kiểm chứng; chỗ nào chưa rõ đều ghi CHƯA XÁC MINH kèm cách kiểm.

## 1. Dự án là gì

SafePC là app quản lý máy tính của con, gần giống Microsoft Family Safety / Google Family Link: phụ huynh đặt quy tắc giờ giấc, chặn app, chặn website; Agent trên máy con thi hành; Dashboard web để phụ huynh quản lý. Đối tượng hiện tại: gia đình của anh Tiến (dưới 100 user, dịch vụ free). Ranh giới riêng tư đã chốt: không ghi phím, không đọc nội dung chat/file của con, không bật mic/camera. Chụp màn hình: bị LOẠI ngày 17/11 nhưng anh Tiến đã MỞ LẠI và duyệt triển khai ngày 28/11/2026 (AMENDMENTS A-19) theo mô hình phụ huynh quyết định cứng bật/tắt, con chỉ được thông báo 1 lần/tuần (không nêu tần suất), ảnh lưu Drive riêng của phụ huynh — đợt code đã lên `develop` (xem mục 3), chưa kiểm chứng máy thật.

### Kiến trúc

| Thành phần | Công nghệ | Ghi chú |
|---|---|---|
| PC Agent | C# / .NET 8: Windows Service (SYSTEM) + Tray WPF + NativeHost | Chạy trên Windows 10/11; bộ cài Inno Setup, cài một lần bằng quyền Admin |
| Dashboard | React + TypeScript + Vite (PWA) | Vercel: https://safe-pc.vercel.app — tự deploy mỗi lần push lên `main` |
| Backend | Supabase (Postgres + Auth + RLS theo `family_id`) | Project ref `fzknvolkxnwfxdcfmops`, region Singapore, gói Free |
| Extension | Manifest V3 (Edge/Chrome), JS thuần | Trên `main` 0.1.11; trên `develop` 0.1.13 (đợt cứng hóa 28/11); ID `djcgbhjbmcccdgedbmfihdpeeanmldbd`; đang cài tay dạng unpacked |
| Email | Supabase Edge Functions + Resend | Domain gửi `ndt.ap.vn` đã verified (xem mục 7) |

### Repo và cây làm việc

- Repo GitHub: `ndtcoder/SafePC`, **Private**. Hai nhánh làm việc: `main` (production) và `develop` (mọi thay đổi mới đi qua develop từ 27/11/2026 theo quy trình anh chốt; chỉ merge develop → main khi anh duyệt các đợt lớn).
- Head `main`: `b5414b5` — đã gồm Sprint 5 (backend + Dashboard + migration 27) và kiểm duyệt từ khóa tìm kiếm; bản cài production **v0.1.332**. Head `develop` (trước đợt cứng hóa 28/11): hơn `main` **51 commit**, chứa các đợt ở mục 3 (nhắn tin + push, migration 25/26, danh sách domain 6 nhóm, giờ tin cậy + theo dõi luật, chụp màn hình) — tất cả CHƯA merge, chờ cổng ở mục 10.
- Cây local `~/workspace/projects/safepc` **KHÔNG có `.git`** — không chạy được `git status`/`git log` tại đây. Mọi đẩy code lên GitHub đều qua giao diện web (upload từng đợt); Git Trees API và SSH git đều bị chặn từ môi trường này.
- Từ 25/11/2026 cây local có backup tự động mỗi 30 phút (script `~/workspace/scripts/backup-safepc.sh`, giữ 12 snapshot ở `~/workspace/backups/safepc/`) và chat log được đẩy lên nhánh riêng `chat-logs` của repo (không bao giờ lên `main`).

## 2. Kiểm chứng tươi — chạy thật ngày 2026-11-26

| Kiểm tra | Lệnh / cách chạy | Kết quả nguyên văn |
|---|---|---|
| Build Agent | `~/dotnet/dotnet build SafePC.Agent.sln -p:EnableWindowsTargeting=true` (trong `apps/pc-agent/`) | `Build succeeded. 0 Warning(s), 0 Error(s)` |
| Typecheck Dashboard | `tsc --noEmit -p .` (trong `apps/dashboard-web/`) | exit 0 |
| Harness SQL migration 21 | PGlite, `~/workspace/goals/safepc-parental-control-app/hidden_files/m21-pglite/` | 42 PASS, 0 FAIL |
| Harness SQL migration 22 | PGlite (cùng thư mục m21-pglite) | 10 PASS, 0 FAIL |
| Harness SQL migration 23 | PGlite (cùng thư mục m21-pglite) | 15 PASS, 0 FAIL |
| Harness SQL migration 24 | PGlite, `hidden_files/m24-pglite/test-m24.mjs` | 35 PASS, 0 FAIL |
| Harness SQL migration 27 | PGlite, `hidden_files/m27-pglite/test-m27.mjs` | 43 PASS, 0 FAIL |
| Harness Sprint 5 resolver | `hidden_files/sprint5-resolver-test/` — liên kết code thật `ActiveChildResolver.cs` | 90 PASS, ALL PASS |
| Harness watchdog Tray | `hidden_files/tray-watchdog-test/` — liên kết code thật `TrayWatchdog.cs` | 16 PASS, ALL PASS |

Lưu ý: build trên Linux chỉ biên dịch được (dùng `EnableWindowsTargeting`); Agent không chạy được trên VM này. Kiểm chứng chạy thật (GUI, khóa máy, đa phiên) chỉ làm được trên CI Windows (self-test) và trên máy Windows thật của anh Tiến.

## 3. Tiến độ theo giai đoạn

| Giai đoạn | Nội dung | Trạng thái | Bằng chứng / gate |
|---|---|---|---|
| Sprint 0 | Nền móng: repo, Supabase, Vercel, CI | Xong | PRD mục 0; ROADMAP Sprint 0 |
| Sprint 1 | Ghép nối + theo dõi usage | Xong, đã kiểm chứng máy thật | Xem `docs/acceptance/M1-core.md` |
| Sprint 2 | Quy tắc giờ giấc, chặn app, chặn domain, focus, nghỉ bắt buộc | Xong phần code; lõi đã kiểm chứng máy thật 17–18/11 | `docs/acceptance/M1-core.md` |
| Đợt 17–18/11 | Khóa có độ trễ, PIN thoát, xin giờ đầu-cuối, thiết kế lại trang Quy tắc, rule theo đường dẫn URL | Xong phần code; phần lớn đã kiểm chứng máy thật 17–18/11 | PRD §2.3.2, §2.5, §2.6 |
| Tính năng nâng cao (9 mục + đợt bổ sung) | Tổng quan hôm nay, thông báo phụ huynh, nhật ký hoạt động, ngân hàng giờ, chặn theo danh mục, mời phụ huynh thứ hai, xuất/xóa dữ liệu, chuẩn hóa UI, MFA, thông báo Dashboard, xin mở domain, tìm kiếm lịch sử web, audit đổi luật | Xong phần code (CI xanh từng đợt); hầu hết CHƯA kiểm chứng máy thật | `docs/acceptance/M2-advanced-features.md` |
| Báo cáo tuần | Trang Báo cáo (Dashboard) + email tự động | Trang đã live; email: function đã deploy, domain đã verified, chờ email tự động đầu tiên | PRD §2.10; OWNER-INBOX T-003 |
| Sprint 4 | Cứng hóa: PIN gỡ cài đặt, watchdog Tray, cảnh báo `extension_missing` + `tray_stopped`, khóa ACL file nhạy cảm, migration 22+23, trang hướng dẫn + riêng tư, header bảo mật | Xong phần code — bản cài v0.1.309, CI #309 XANH; CHƯA kiểm chứng máy thật | `docs/acceptance/M3-sprint4.md`; kịch bản ở `docs/03-SECURITY.md` |
| Sprint 5 đợt 1 | Backend đa con trên máy chung: migration 24 + Service + NativeHost | Đã lên `main`; code có trong bản cài production v0.1.332 (CI #332 XANH) — đợt chạy lại CI #317 để lấy v0.1.317 KHÔNG còn cần (đã thay thế) | Harness M24 35/35 + resolver 90/90 (mục 2) |
| Sprint 5 đợt Dashboard + migration 27 | Gắn tài khoản Windows ↔ hồ sơ con, lệnh theo con, cảnh báo tài khoản chưa gắn, đồng bộ trạng thái lúc gắn (phương án (a) đã chốt 21/11) | Đã đẩy lên `main` 27/11 (head `b5414b5`), CI #332 XANH, có trong bản cài v0.1.332; migration 27 ĐÃ ÁP; CHƯA kiểm chứng máy thật | Harness M27 43/43 (mục 2) |
| zalo.me vào danh mục Mạng xã hội | Thêm `zalo.me` vào danh sách hạt giống (danh mục social) theo quyết định của anh 24/11 | Đã đẩy lên `main` 27/11 cùng đợt Sprint 5 | OWNER-INBOX R-001 (đã đóng) |
| Kiểm duyệt từ khóa tìm kiếm | Chặn tìm kiếm chứa từ khóa cấm theo hồ sơ con (5 công cụ tìm kiếm), 6 nhóm mẫu, thống kê vào Báo cáo tuần; migration 28 | Đã đẩy lên `main` 27/11; migration 28 ĐÃ ÁP; extension 0.1.11 trên main; CHƯA kiểm chứng máy thật | Harness M28 19/19 + test hàm thuần extension 49/49 |
| Sprint 5 migration 25 + 26 | Bảng `device_seen_accounts` + RPC báo tài khoản đã thấy (25); RPC ngân hàng giờ gắn `child_id` (26); Service nối lời gọi ở hello (throttle 10 phút/SID) | Code trên `develop`; **migration 25 + 26 CHƯA ÁP** | Harness M25 21/21, M26 23/23 |
| Nhắn tin con ↔ phụ huynh + push notification | Chat trong SafePC (tab Nhắn tin trên Dashboard + trang chat cho con qua link phiên 12 giờ từ menu khay); migration 29. Push PWA (Web Push/VAPID): tin nhắn mới của con + yêu cầu của con; migration 30 + Edge Function `send-push-notifications` | Code trên `develop` (bản cài v0.1.334); **migration 29 + 30 CHƯA ÁP, function CHƯA deploy, VAPID chưa đặt** — chưa chạy thật đầu-cuối | Harness M29 43/43, M30 26/26; CI #334/#342 XANH |
| Danh sách domain 6 nhóm từ filter list công khai | 18.339 domain (adult 8.000, gambling 4.000, violence 296, games 2.500, movies 2.000, social 1.543) từ nguồn sạch giấy phép (StevenBlack MIT, UT1 CC BY-SA, Block List Project Unlicense); extension 0.1.12: trần DNR 10.000 + tab watcher thi hành 100% | Code trên `develop` (bản cài v0.1.349, extension 0.1.12); CHƯA kiểm chứng máy thật | Harness ngân sách DNR 13/13; CI #349/#350 XANH |
| Giờ tin cậy + theo dõi khi luật không chặn | Giờ thi hành = giờ server + TickCount64 quy đổi múi giờ gia đình (Dashboard đặt); theo dõi luật không chặn qua bảng `rule_observations` (3 ngữ cảnh), hiện ở Báo cáo tuần; migration 31 | Code trên `develop` (bản cài v0.1.356); **migration 31 CHƯA ÁP**; CHƯA kiểm chứng máy thật | Harness M31 40/40; CI #356/#359 XANH |
| Chụp màn hình định kỳ | Phụ huynh bật/tắt cứng theo con (nhịp 1–30 phút), ảnh nén 1280px JPEG lưu Drive RIÊNG của phụ huynh (OAuth scope drive.file), khử trùng lặp, dọn theo hạn giữ; con được thông báo 1 lần/tuần, không nêu tần suất; migration 32 + Edge Function `connect-google-drive` | Code trên `develop` (bản cài v0.1.369); **migration 32 CHƯA ÁP, function CHƯA deploy, Google OAuth chưa cấu hình** — chưa chạy thật | Harness M32 43/43; CI #369 XANH |
| Đợt cứng hóa nhỏ 28/11 | Token Drive 3 trạng thái (lỗi tạm thời không xóa oan token cục bộ); extension 0.1.13 sửa bước cắt ngân sách DNR (cắt từ cuối hàng đợi danh mục); tóm tắt quan sát tuần trên thẻ luật; cập nhật STATE.md này | Code trên `develop`; CHƯA kiểm chứng máy thật | Cổng local đợt này (xem bản ghi đợt) |
| Giai đoạn 2 | App điện thoại: Android cho con phát hành APK trực tiếp, 2 chế độ cài (thường / Device Owner); app phụ huynh Capacitor APK + PWA iPhone; iPhone cho con BỎ (chỉ dùng free — quyết định A-20, 28/11) | Chưa làm — chờ anh lệnh triển khai | `docs/12-RESEARCH-MOBILE-APPS.md` |

## 4. Migration Supabase

Thư mục: `backend/supabase/migrations/`. Quy tắc bất biến: trợ lý KHÔNG tự chạy migration — anh Tiến paste + chạy tay trong SQL Editor (trình duyệt tự động không paste được vào Monaco), có kiểm tra fidelity trước khi chạy (xem `docs/verify-owner-guide.md` mục 1).

| Migration | Nội dung | Trạng thái |
|---|---|---|
| 1–24 | Toàn bộ schema + RPC + cron tới Sprint 5 đợt 1 (gồm 21 đồng bộ lúc ghép nối, 22 sự kiện `tray_stopped`, 23 dọn `app_usage` 90 ngày, 24 ánh xạ máy ↔ con) | **ĐÃ ÁP** lên DB thật (24 áp ngày 27/11/2026) |
| 25 (`20261121100000_sprint5_seen_accounts.sql`) | Bảng `device_seen_accounts` + RPC `safepc_report_seen_account` (tài khoản Windows Tray đã thấy) | File trên `develop`; **CHƯA ÁP** |
| 26 (`20261121110000_sprint5_time_bank_child_scope.sql`) | RPC ngân hàng giờ gắn `child_id` + định tuyến theo con | File trên `develop`; **CHƯA ÁP** |
| 27 (`20261121123400_sprint5_link_time_enforcement_sync.sql`) | RPC `safepc_sync_enforcement_state_to_device` — đồng bộ trạng thái thi hành lúc gắn con vào máy chung | **ĐÃ ÁP** ngày 27/11/2026 (phải áp 24 trước — đã đủ) |
| 28 (`20261127120000_search_keyword_guard.sql`) | Bảng `search_terms` + RPC đẩy lượt tìm kiếm (kiểm duyệt từ khóa) | **ĐÃ ÁP** ngày 27/11/2026 |
| 29 (`20261127160000_family_messaging.sql`) | Nhắn tin con ↔ phụ huynh: bảng `messages` + `chat_sessions` + RPC theo token thiết bị | File trên `develop`; **CHƯA ÁP** |
| 30 (`20261127180000_push_notifications.sql`) | Push notification: bảng `push_subscriptions` + `push_sends` + cron mỗi 5 phút | File trên `develop`; **CHƯA ÁP** — TRẠM: lệnh cron trong file chứa placeholder secret, phải thay WEEKLY_REPORT_SECRET thật trước khi chạy |
| 31 (`20261127210000_trusted_time_rule_observations.sql`) | Giờ tin cậy (cột `families.timezone`) + bảng `rule_observations` + RPC quan sát | File trên `develop`; **CHƯA ÁP** |
| 32 (`20261128120000_screen_capture.sql`) | Chụp màn hình: `child_screen_settings` + `screenshot_metadata` + `family_drive_tokens` | File trên `develop`; **CHƯA ÁP** |

Thứ tự áp các migration còn chờ: **25 → 26 → 29 → 30 → 31 → 32**.

## 5. Bản cài và artifact

- Bản cài production hiện hành (nhánh `main`): **SafePCAgentSetup v0.1.332** (CI #332 XANH; Tray 19/19, IPC 13/13). Quy ước phiên bản: `0.1.<số run CI>`, không bao giờ ghi cứng số version trong code.
- Bản cài **v0.1.309** (Sprint 4, CI #309 XANH, 94,8 MB) vẫn giữ để anh test cuối tuần 28–29/11/2026 — cổng merge develop → main (mục 10).
- Bản cài trên `develop` tải được: **v0.1.334** (nhắn tin + M25 Service), **v0.1.349** (danh sách domain 6 nhóm), **v0.1.356** (giờ tin cậy + theo dõi luật), **v0.1.369** (chụp màn hình). Danh sách build đầy đủ: `~/workspace/goals/safepc-parental-control-app/files/danh-sach-build-thanh-cong.md` (cập nhật mỗi lần có build thành công).
- Việc chạy lại job lỗi của CI #317 để lấy v0.1.317 KHÔNG còn cần — đã bị thay thế bởi các bản trên (OWNER-INBOX D-001 đã đóng theo hướng thay thế).
- Extension: trên `main` 0.1.11 (zip `SafePC-Extension-0.1.11.zip`), trên `develop` 0.1.13 sau đợt cứng hóa 28/11 (zip `SafePC-Extension-0.1.13.zip` trong cùng thư mục files của goal).

## 6. Đã chứng minh trên máy thật / chưa kiểm chứng

**ĐÃ CHỨNG MINH TRÊN MÁY THẬT:**
- Khóa / mở khóa từ Dashboard (17/11/2026, v0.1.136).
- Chặn app + mẫu "Chỉ cho phép Edge" (18/11).
- Chặn domain + trang chặn SafePC thật qua extension 0.1.4 — gốc rễ là thiếu `host_permissions` cho rule redirect (18/11).
- Ngữ nghĩa unlock mới: mở khóa tạm thời chỉ hoãn khóa theo giờ giấc, chặn app/focus/nghỉ bắt buộc vẫn thi hành (18/11, v0.1.187).
- Kill app tức thì khi app bị chặn mở lên (18/11, v0.1.190).
- Miễn trừ phiên admin qua token Limited (17–18/11).
- Email thông báo phụ huynh gửi THẬT thành công: 25/11/2026 15:50, email máy offline >48 giờ, từ `SafePC <bao-cao@ndt.ap.vn>` tới hộp thư phụ huynh (sau khi domain verified).

**CHƯA KIỂM CHỨNG THẬT (đừng nói là đã xong):**
- Toàn bộ kịch bản test bản v0.1.309 + extension — đã giao anh ngày 20/11; anh dự định test cuối tuần 28–29/11/2026 (OWNER-INBOX T-001). Đây là cổng merge develop → main.
- Email báo cáo tuần TỰ ĐỘNG lần đầu — cron thứ Hai 00:00 UTC = 07:00 +07 (OWNER-INBOX T-003).
- Sprint 5 đa phiên trên máy thật (2 tài khoản con + chuyển đổi nhanh) — CI không mô phỏng được.
- Migration 27 đồng bộ lúc gắn trên máy thật.
- Tiền đề chẩn đoán `WTSGetActiveConsoleSessionId` / GetLastError của Sprint 5 (OWNER-INBOX T-005).
- Mọi đợt trên `develop`: nhắn tin + push đầu-cuối, danh sách domain 18.339 với 10.000 rule DNR trên trình duyệt thật, giờ tin cậy khi con chỉnh giờ/múi giờ Windows, theo dõi luật không chặn, chụp màn hình + Drive OAuth — tất cả mới xanh ở kiểm tra tự động + CI.

## 7. Email và Edge Functions

- Đã deploy **3/5** Edge Function: `send-weekly-report`, `send-parent-notifications`, `pair-device` (deploy ngày 21/11/2026, cả 3 đều **tắt Verify JWT**). Còn **chưa deploy**: `send-push-notifications` (push) và `connect-google-drive` (OAuth Drive cho chụp màn hình — deploy phải tắt Verify JWT vì có callback OAuth).
- Secret `WEEKLY_REPORT_SECRET` do anh Tiến tự tạo và tự đặt (cả trong Edge Function Secrets lẫn trong lệnh cron của migration 11/12) — giá trị KHÔNG ghi ở bất kỳ đâu trong gói này.
- Resend: domain `ndt.ap.vn` **verified** ngày 25/11/2026 (sending enabled, receiving disabled); `RESEND_FROM` = `SafePC <bao-cao@ndt.ap.vn>`; 2 function email đã deploy lại sau khi đặt secret.
- Lịch gửi: báo cáo tuần mỗi thứ Hai 00:00 UTC (07:00 +07); thông báo phụ huynh quét mỗi 5 phút.

## 8. Bảng ký duyệt milestone

| Milestone | Trạng thái code | Kiểm chứng máy thật | Ký duyệt của anh Tiến |
|---|---|---|---|
| M1 — Lõi (Sprint 0–2) | Xong | Đã chứng minh các luồng lõi 17–18/11 | Chưa ký chính thức — gói nghiệm thu ở `docs/acceptance/M1-core.md` |
| M2 — Tính năng nâng cao | Xong | Phần lớn chưa kiểm | Chưa ký — `docs/acceptance/M2-advanced-features.md` |
| M3 — Sprint 4 (v0.1.309) | Xong, CI #309 xanh | Chưa kiểm (kịch bản đã giao 20/11) | Chưa ký — `docs/acceptance/M3-sprint4.md` |
| Sprint 5 | Code đã lên `main` (bản cài v0.1.332); migration 25 + 26 trên `develop` chưa áp | Chưa kiểm | Chưa có gói nghiệm thu (chưa xong) |
| Gói bàn giao này | Đã tạo 26/11/2026 | — | **ĐÃ KÝ 26/11/2026** — anh Tiến xác nhận bản tóm tắt đúng |

## 9. Rủi ro lớn nhất

1. **Hạn mức GitHub Actions** đã hết (0,5 GB tính trung bình theo thời gian) — tới 01/12/2026 mới reset; trước mốc đó build mới có thể lại không tải được artifact.
2. **`develop` đang hơn `main` 51 commit** (trước đợt cứng hóa 28/11): nhắn tin, push, danh sách domain, giờ tin cậy, chụp màn hình đều nằm chờ cổng merge — anh test xong v0.1.309 và XÁC NHẬN mới merge (quy tắc anh chốt 27/11/2026). Chờ càng lâu, đợt merge càng lớn.
3. **GitHub yêu cầu bật 2FA trước 04/01/2027** — quá hạn, tài khoản `ndtcoder` bị giới hạn truy cập cho tới khi bật (OWNER-INBOX T-004).
4. **Mọi tính năng giao từ 19/11 chưa qua máy thật** — CI xanh không thay được kiểm chứng thật, nhất là Sprint 4, Sprint 5 và toàn bộ các đợt trên develop.

## 10. Việc tiếp theo (theo thứ tự)

1. Anh test bản 309 + extension theo kịch bản cuối tuần 28–29/11/2026 (OWNER-INBOX T-001) → trợ lý chốt nốt sửa chữa → **hỏi anh xác nhận** → merge develop → main.
2. Anh áp migration theo thứ tự **25 → 26 → 29 → 30 → 31 → 32** (OWNER-INBOX T-002; migration 30 nhớ thay placeholder secret bằng WEEKLY_REPORT_SECRET thật trước khi chạy).
3. Push chạy thật: anh tạo cặp khóa VAPID (private không qua chat/repo), đặt 3 secret `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` trên Supabase, deploy function `send-push-notifications` (tắt Verify JWT), đặt `VITE_VAPID_PUBLIC_KEY` trên Vercel + Redeploy.
4. Chụp màn hình chạy thật: anh tạo Google OAuth client, đặt 2 secret `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` trên Supabase, đăng ký redirect URI `<SUPABASE_URL>/functions/v1/connect-google-drive/callback`, deploy function `connect-google-drive` (tắt Verify JWT) + deploy lại 2 function thông báo.
5. Sáng thứ Hai: kiểm email báo cáo tuần tự động đầu tiên (OWNER-INBOX T-003).
6. Anh bật 2FA GitHub trước hạn 04/01/2027 (OWNER-INBOX T-004).
