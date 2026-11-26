Gói bàn giao SafePC — tạo 2026-11-26.

# STATE.md — Trạng thái dự án SafePC

Tài liệu này là điểm vào duy nhất để nắm trạng thái dự án. Mọi con số trong mục "Kiểm chứng tươi" đều chạy thật trên máy làm việc (VM Linux) ngày 2026-11-26 và ghi nguyên văn. Trạng thái còn lại lấy từ `docs/01-PRD.md`, `docs/04-ROADMAP.md`, `docs/03-SECURITY.md` và hồ sơ giao đợt đã kiểm chứng; chỗ nào chưa rõ đều ghi CHƯA XÁC MINH kèm cách kiểm.

## 1. Dự án là gì

SafePC là app quản lý máy tính của con, gần giống Microsoft Family Safety / Google Family Link: phụ huynh đặt quy tắc giờ giấc, chặn app, chặn website; Agent trên máy con thi hành; Dashboard web để phụ huynh quản lý. Đối tượng hiện tại: gia đình của anh Tiến (dưới 100 user, dịch vụ free). Ranh giới riêng tư đã chốt: không chụp màn hình, không ghi phím, không đọc nội dung chat/file của con, không bật mic/camera.

### Kiến trúc

| Thành phần | Công nghệ | Ghi chú |
|---|---|---|
| PC Agent | C# / .NET 8: Windows Service (SYSTEM) + Tray WPF + NativeHost | Chạy trên Windows 10/11; bộ cài Inno Setup, cài một lần bằng quyền Admin |
| Dashboard | React + TypeScript + Vite (PWA) | Vercel: https://safe-pc.vercel.app — tự deploy mỗi lần push lên `main` |
| Backend | Supabase (Postgres + Auth + RLS theo `family_id`) | Project ref `fzknvolkxnwfxdcfmops`, region Singapore, gói Free |
| Extension | Manifest V3 (Edge/Chrome), JS thuần | Bản hiện hành 0.1.10; ID `djcgbhjbmcccdgedbmfihdpeeanmldbd`; đang cài tay dạng unpacked |
| Email | Supabase Edge Functions + Resend | Domain gửi `ndt.ap.vn` đã verified (xem mục 7) |

### Repo và cây làm việc

- Repo GitHub: `ndtcoder/SafePC`, **Private**, nhánh chính `main`.
- Head hiện tại: `bdfc640` — kiểm chứng qua GitHub API ngày 2026-11-21. Sau thời điểm đó KHÔNG có push nào: các đợt Sprint 5 Dashboard + migration 27 đang giữ ở cây local có chủ đích (chờ anh test xong bản 309, vì Vercel tự deploy theo `main`).
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
| Sprint 5 đợt 1 | Backend đa con trên máy chung: migration 24 + Service + NativeHost | Đã đẩy lên `main` (head `bdfc640`); CI #317 code XANH, bước upload artifact ĐỎ vì hết hạn mức Actions → chưa có bản cài | Harness M24 35/35 + resolver 90/90 (mục 2) |
| Sprint 5 đợt Dashboard + migration 27 | Gắn tài khoản Windows ↔ hồ sơ con, lệnh theo con, cảnh báo tài khoản chưa gắn, đồng bộ trạng thái lúc gắn (phương án (a) đã chốt 21/11) | Đã xây + review độc lập APPROVED 21/11; **chỉ ở cây local, chưa đẩy** — chờ anh test xong bản 309 | Harness M27 43/43 (mục 2); OWNER-INBOX T-001 |
| zalo.me vào danh mục Mạng xã hội | Thêm `zalo.me` vào danh sách hạt giống (danh mục social 17 domain, tổng 54) theo quyết định của anh 24/11 | Chỉ ở cây local, đẩy cùng đợt Sprint 5 | OWNER-INBOX R-001 |
| Giai đoạn 2 | App Android cho phụ huynh (Capacitor) | Chưa làm — anh chốt chưa làm vội | PRD mục 3 |

## 4. Migration Supabase

Thư mục: `backend/supabase/migrations/`. Quy tắc bất biến: trợ lý KHÔNG tự chạy migration — anh Tiến paste + chạy tay trong SQL Editor (trình duyệt tự động không paste được vào Monaco), có kiểm tra fidelity trước khi chạy (xem `docs/verify-owner-guide.md` mục 1).

| Migration | Nội dung | Trạng thái |
|---|---|---|
| 1–23 | Toàn bộ schema + RPC + cron tới Sprint 4 (gồm 21 đồng bộ lúc ghép nối, 22 sự kiện `tray_stopped`, 23 dọn `app_usage` 90 ngày) | **ĐÃ ÁP** lên DB thật (xác nhận 20/11/2026) |
| 24 (`20261120233000_sprint5_device_child_mapping.sql`) | Sprint 5: bảng `device_child_accounts`, `commands.child_id`, RPC theo con | Đã đẩy GitHub (commit `9eb9a78`); **CHƯA ÁP** |
| 25 | Bảng `device_seen_accounts` + RPC `safepc_report_seen_account` (tài khoản Windows Tray đã thấy) | Mới là thiết kế ghi trong TODO ở `apps/dashboard-web/src/lib/deviceChildren.ts`; **chưa có file** |
| 26 | Gắn `child_id` cho RPC ngân hàng giờ (`safepc_grant_time_bank` / `safepc_void_time_bank_grant`) | Mới là thiết kế ghi trong TODO ở `TimeBankTab.tsx`; **chưa có file** |
| 27 (`20261121123400_sprint5_link_time_enforcement_sync.sql`) | RPC `safepc_sync_enforcement_state_to_device` — đồng bộ trạng thái thi hành lúc gắn con vào máy chung | Chỉ ở cây local; **chưa đẩy, chưa áp**; phải áp 24 trước |

## 5. Bản cài và artifact

- Bản cài hiện hành: **SafePCAgentSetup v0.1.309** (CI run #309 XANH; 94,8 MB; self-test trong CI: Tray 19/19, IPC 13/13). Quy ước phiên bản: `0.1.<số run CI>`, không bao giờ ghi cứng số version trong code.
- Đây là artifact **DUY NHẤT** còn tải được trên GitHub. Danh sách build đầy đủ: `~/workspace/goals/safepc-parental-control-app/files/danh-sach-build-thanh-cong.md` (cập nhật mỗi lần có build thành công).
- Bản cài Sprint 5 sẽ là **v0.1.317** khi chạy lại job lỗi của CI #317 sau khi hạn mức Actions reset ngày 01/12/2026 (xem OWNER-INBOX D-001).
- Extension: bản 0.1.10, file zip ở `~/workspace/goals/safepc-parental-control-app/files/SafePC-Extension-0.1.10.zip`.

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
- Toàn bộ kịch bản test bản v0.1.309 + extension 0.1.10 — đã giao anh ngày 20/11, anh chưa báo kết quả (OWNER-INBOX T-001).
- Email báo cáo tuần TỰ ĐỘNG lần đầu — cron thứ Hai 00:00 UTC = 07:00 +07 (OWNER-INBOX T-003).
- Sprint 5 đa phiên trên máy thật (2 tài khoản con + chuyển đổi nhanh) — CI không mô phỏng được.
- Migration 27 đồng bộ lúc gắn trên máy thật.
- Tiền đề chẩn đoán `WTSGetActiveConsoleSessionId` / GetLastError của Sprint 5 (OWNER-INBOX T-005).

## 7. Email và Edge Functions

- Cả 3 Edge Function đã deploy ngày 21/11/2026: `send-weekly-report`, `send-parent-notifications`, `pair-device`. Cả 3 đều **tắt Verify JWT**.
- Secret `WEEKLY_REPORT_SECRET` do anh Tiến tự tạo và tự đặt (cả trong Edge Function Secrets lẫn trong lệnh cron của migration 11/12) — giá trị KHÔNG ghi ở bất kỳ đâu trong gói này.
- Resend: domain `ndt.ap.vn` **verified** ngày 25/11/2026 (sending enabled, receiving disabled); `RESEND_FROM` = `SafePC <bao-cao@ndt.ap.vn>`; 2 function email đã deploy lại sau khi đặt secret.
- Lịch gửi: báo cáo tuần mỗi thứ Hai 00:00 UTC (07:00 +07); thông báo phụ huynh quét mỗi 5 phút.

## 8. Bảng ký duyệt milestone

| Milestone | Trạng thái code | Kiểm chứng máy thật | Ký duyệt của anh Tiến |
|---|---|---|---|
| M1 — Lõi (Sprint 0–2) | Xong | Đã chứng minh các luồng lõi 17–18/11 | Chưa ký chính thức — gói nghiệm thu ở `docs/acceptance/M1-core.md` |
| M2 — Tính năng nâng cao | Xong | Phần lớn chưa kiểm | Chưa ký — `docs/acceptance/M2-advanced-features.md` |
| M3 — Sprint 4 (v0.1.309) | Xong, CI #309 xanh | Chưa kiểm (kịch bản đã giao 20/11) | Chưa ký — `docs/acceptance/M3-sprint4.md` |
| Sprint 5 | Đợt 1 đã lên main; đợt Dashboard + M27 giữ local | Chưa kiểm | Chưa có gói nghiệm thu (chưa xong) |
| Gói bàn giao này | Đã tạo 26/11/2026 | — | **ĐÃ KÝ 26/11/2026** — anh Tiến xác nhận bản tóm tắt đúng |

## 9. Rủi ro lớn nhất

1. **Hạn mức GitHub Actions** đã hết (0,5 GB tính trung bình theo thời gian) — tới 01/12/2026 mới reset; trước mốc đó build mới có thể lại không tải được artifact.
2. **Đợt Sprint 5 Dashboard + migration 27 + zalo.me chỉ tồn tại ở cây local.** Đã giảm rủi ro bằng backup 30 phút từ 25/11, nhưng chưa lên GitHub ngày nào thì ngày đó vẫn là điểm lỗi đơn.
3. **GitHub yêu cầu bật 2FA trước 04/01/2027** — quá hạn, tài khoản `ndtcoder` bị giới hạn truy cập cho tới khi bật (OWNER-INBOX T-004).
4. **Mọi tính năng giao từ 19/11 chưa qua máy thật** — CI xanh không thay được kiểm chứng thật, nhất là Sprint 4 và Sprint 5.

## 10. Việc tiếp theo (theo thứ tự)

1. Anh test bản 309 + extension 0.1.10 theo kịch bản (OWNER-INBOX T-001) → xong mới đẩy đợt Sprint 5 Dashboard + migration 27 + zalo.me.
2. Anh áp migration 24 rồi 27 (OWNER-INBOX T-002).
3. Sau 01/12: chạy lại job lỗi của CI #317 lấy bản v0.1.317 (OWNER-INBOX D-001).
4. Sáng thứ Hai: kiểm email báo cáo tuần tự động đầu tiên (OWNER-INBOX T-003).
5. Viết file migration 25 + 26 từ thiết kế TODO đã ghi trong code Dashboard.
