# Kiến trúc — SafePC

## 1. Sơ đồ tổng thể

```
[Máy PC của con - Windows]
  ├─ Windows Service (SYSTEM): enforcement, watchdog, sync
  ├─ Tray App (User session): UI cảnh báo, màn hình khóa, xin thêm giờ
  ├─ Browser Extension (Chrome/Edge): lọc domain, báo cáo domain
  └─ SQLite local: hàng đợi offline, cache quy tắc

            ↕ HTTPS / WSS (TLS 1.2+)

[Backend: Supabase Free]
  ├─ Postgres + Row Level Security (RLS)
  ├─ Auth (email/password, MFA giai đoạn 2)
  ├─ Realtime (lệnh phụ huynh -> Agent, yêu cầu con -> phụ huynh)
  ├─ Storage (avatar, log đính kèm - nếu có)
  └─ Edge Functions (pairing, tổng hợp báo cáo, dọn dữ liệu cũ)

            ↕ HTTPS

[Dashboard phụ huynh: React + TS PWA trên Vercel Free]
  └─ Giai đoạn 2: Capacitor -> Android App (chung code)
```

## 2. Lựa chọn công nghệ và lý do

| Thành phần | Lựa chọn đề xuất | Lý do / Free tier |
|---|---|---|
| PC Agent | C# .NET 8, Windows Service + WPF/WinUI Tray | Tích hợp Windows sâu nhất, Win32 API, DPAPI, Task Scheduler. Build bằng GitHub Actions Free. Installer: Inno Setup / WiX (free). |
| Backend + DB | Supabase Free | Postgres 500MB, 50k MAU, 2GB bandwidth, Auth + Realtime có sẵn. RLS mạnh cho dữ liệu nhạy cảm. Đủ cho <100 user. |
| Dashboard | React 18 + TypeScript + Vite + Tailwind, PWA | Nhanh, dễ tuyển/bảo trì, deploy Vercel Free (100GB bandwidth). PWA cài được lên PC/Android. |
| Android (GĐ2) | Capacitor wrapper của Dashboard | Tái dùng 100% code web, ra APK nhanh. Nếu cần native sâu hơn thì chuyển Flutter sau, không làm lại backend. |
| Extension | Manifest V3, JavaScript thuần, không bước build (load unpacked) | Chạy được Chrome + Edge, code chung 1 repo. Quy tắc lấy qua NativeHost của Agent, không gọi Supabase trực tiếp. |
| CI/CD | GitHub Actions Free | Build + test + quét dependency (Dependabot, CodeQL free cho public repo; private repo vẫn có free minutes). |
| Monitoring | Sentry Free / Logtail Free + Supabase Logs | Bắt lỗi Agent/Dashboard, cảnh báo Agent offline. |

**Phương án thay thế đã cân nhắc:** Firebase (Auth/Firestore tốt nhưng truy vấn báo cáo SQL kém hơn), Tauri/Rust cho Agent (nhẹ nhưng tích hợp Windows Service phức tạp hơn C#), Electron cho Agent (nặng, dễ bị tắt hơn Service).

## 3. Mô hình dữ liệu (rút gọn)

```
families (id, owner_id, name, created_at)
family_members (family_id, user_id, role: parent|child, ...)
children (id, family_id, display_name, birth_year, avatar_url)
devices (id, family_id, child_id, hostname, os_version, agent_version, last_seen_at, last_extension_seen_at, status)
device_tokens (device_id, token_hash, created_at, revoked_at) -- không lưu token thô
rules (id, child_id, type: daily_limit|bedtime|time_window|app|website, config JSONB, enabled)
app_usage (id, device_id, child_id, app_name, exe_path_hash, started_at, duration_sec)
web_visits (id, device_id, child_id, domain, visited_at, duration_sec, blocked: bool) -- chỉ domain + thời lượng, không path/query
requests (id, child_id, type: extra_time|unblock_app, status, reason, decided_by, decided_at)
commands (id, device_id, type: lock_now|unlock|refresh_rules|update|temporary_override, payload, status, created_at)
audit_logs (id, family_id, child_id, device_id, actor, action, target, ip_hash, details, created_at)
```

- Tất cả bảng bật RLS: phụ huynh chỉ thấy dữ liệu của gia đình mình.
- `exe_path_hash`: hash đường dẫn để tránh lộ username trong đường dẫn (C:\Users\<tên>\...).
- Dữ liệu usage chi tiết giữ 90 ngày, sau đó tổng hợp theo ngày và xóa chi tiết (Edge Function dọn dẹp).

## 4. Luồng chính

### 4.1. Pairing thiết bị
1. Phụ huynh bấm "Ghép nối máy mới" trên Dashboard, chọn con -> Dashboard tạo pairing_code 6 số (chỉ lưu hash SHA-256), hết hạn 10 phút.
2. Trên máy con, chạy lệnh `SafePC.Agent.Service.exe pair <mã>` bằng quyền Admin (PowerShell/Terminal).
3. Agent gọi RPC `safepc_redeem_pairing_code` qua PostgREST đổi code -> device_token + device_id (một transaction: đánh dấu mã đã dùng + tạo device + tạo token). Token lưu bằng DPAPI (máy con) + hash lưu DB. Edge Function pair-device đã thay bằng RPC (migration 3).
4. Agent tải rules lần đầu, bắt đầu heartbeat 60s.

### 4.2. Thi hành quy tắc (offline-first)
- Agent cache rules + giới hạn còn lại trong SQLite. Mất mạng vẫn thi hành đúng theo cache.
- Mỗi 15s: kiểm tra foreground app, cộng dồn thời gian, kiểm tra bedtime/limit.
- Mỗi 15-30s (khi online): poll commands + gửi usage batch. Realtime là lớp tăng tốc, polling là dự phòng.
- Khi hết giờ: Tray App hiện màn hình khóa, đếm ngược 60s để con kịp lưu bài rồi gọi LockWorkStation khóa phiên.
- Thứ tự đánh giá trong `RuleEngine` (Sprint 2 đợt 1 + đồng bộ): khóa cưỡng chế của phụ huynh (lệnh lock_now, tới khi có lệnh unlock) → ghi đè tạm thời (khóa/mở) → giờ ngủ → khung giờ được dùng → giới hạn ngày; cảnh báo lấy ngưỡng gần nhất. Mọi giờ giấc theo giờ địa phương của máy con; quy ước thứ 0–6 khớp `DayOfWeek` (0 = Chủ nhật). Ngày vắng mặt trong `minutesByWeekday`/`bedtimeByWeekday` = không áp rule ngày đó; riêng `time_window`, ngày vắng mặt = không được dùng máy. Bedtime qua đêm (`end <= start`) khóa từ `start` hôm nay tới `end` hôm sau — engine kiểm tra cả khung hôm nay và đuôi qua đêm của hôm qua.
- Ghi đè tạm thời (lệnh `temporary_override`): Agent lưu ghi đè đang hiệu lực vào bảng SQLite `active_override` (tối đa 1 hàng, lệnh mới thay lệnh cũ) và kiểm tra `expires_at` ở mỗi lần đánh giá, nên ghi đè hết hạn đúng giờ kể cả sau khi Service khởi động lại. Không suy ra lại từ server mỗi lần kiểm tra vì lệnh là một lần (pending → done) — sau khi nhận, hàng lệnh rời khỏi poll pending. Dashboard hiển thị ghi đè đang hiệu lực bằng cách đọc lệnh `temporary_override` mới nhất của máy từ bảng `commands`.
- Khi quyết định chuyển từ khóa sang cho phép (hết giờ ngủ, ghi đè hết hạn...), Service gửi IPC `unlock` để Tray đóng màn hình khóa.

### 4.3. Lệnh từ xa
Phụ huynh bấm Khóa ngay -> insert vào `commands` -> Agent poll 15s, thi hành, ack status (done/failed) về server. Lệnh lock_now được lưu bền vững trên máy (bảng `device_state`) nên sống sót qua khởi động lại Service, tới khi có lệnh unlock. Ghi audit log cho lệnh từ xa là TODO.

### 4.4. Đồng hồ máy con và chống chỉnh giờ

Giờ giấc của rules thi hành theo đồng hồ địa phương của máy con, nên con có thể lách bằng cách chỉnh đồng hồ hệ thống (cần quyền Admin — tài khoản con là Standard User nên không chỉnh được giờ hệ thống trong mặc định Windows, nhưng vẫn cần lớp phát hiện).

Đã triển khai kiểm tra lệch giờ (16/11/2026): trong vòng lặp heartbeat 60s, Worker so sánh giờ máy với giờ server trả về; lệch quá 5 phút thì ghi log cảnh báo. Từ Sprint 2 đợt 3, lệch giờ còn được báo phụ huynh bằng tamper event `clock_drift` (tối đa 1 lần/giờ, xem mục 4.7). Không tự động sửa giờ máy.

### 4.5. Lọc web qua extension (Sprint 2 đợt 2)

Phụ huynh đặt rule `type = website` trên Dashboard → Agent đồng bộ về cache SQLite → `DomainRulesPublisher` (Service) xuất bản file `domain_rules.json` vào `%ProgramData%\SafePC\shared\` (chỉ ghi lại khi nội dung website thay đổi; khi đồng bộ rules, khi ghi đè áp dụng/hết hạn/hủy, và lúc khởi động nếu cache không rỗng) → NativeHost (`SafePC.Agent.NativeHost.exe`, giao thức native messaging stdio) đọc file và trả cho extension → extension dựng lại declarativeNetRequest dynamic rules mỗi phút: chặn domain, chặn theo giờ (đánh giá theo giờ địa phương, ranh giới có hiệu lực trong ~1 phút), chế độ allowlist, cho phép/chặn tạm thời, giới hạn thời gian theo domain (ngân sách tính theo ngày địa phương, hết thì chặn tới hôm sau), SafeSearch cho Google/Bing và Restricted Mode cho YouTube (redirect sang `restrict.youtube.com`). Ghi đè domain chỉ ảnh hưởng file này, không mở/khóa máy (`RuleEngine` bỏ qua chúng).

Chiều ngược lại: extension đếm thời gian tab hiển thị theo domain (chỉ domain + giây, không URL/path/query) → gửi NativeHost mỗi phút → ghi thêm vào `shared\web_usage.jsonl` → Agent đọc trong chu kỳ flush 5 phút, đẩy qua RPC `safepc_push_web_visits` (migration 4) vào bảng `web_visits`; chỉ cắt file khi gửi thành công, gửi lỗi thì giữ lại chu kỳ sau. Extension không gọi Supabase, không có secret. Khi chưa nối được NativeHost, extension mở (fail-open) và popup báo chưa kết nối; bản unpacked có thể bị Standard User tắt — cứng hóa bằng store publishing + chính sách `ExtensionInstallForcelist` là việc sau (chưa triển khai). Manifest của NativeHost hiện dùng ID extension placeholder `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (xem `apps/browser-extension/README.md` mục 4).

### 4.6. Thi hành theo app, giờ học tập trung và nghỉ bắt buộc (Sprint 2 đợt 3)

Quy tắc theo app (`type = 'app'`, một rule một dòng, phân biệt bằng `config.mode`): `app_time_limit` (giới hạn phút/ngày cho từng app), `app_block_by_time` (khung giờ ĐƯỢC dùng theo thứ — ngoài khung thì đóng app), `forced_break` (nghỉ bắt buộc, xem dưới). Giờ học tập trung là rule `type = 'website'` với `mode = 'focus'` — ngoại lệ có chủ đích: phía đóng app do Agent đọc từ rule website (thi hành trong AgentWorker, không phải RuleEngine), phía domain do extension thi hành qua mục `focus` trong `domain_rules.json`.

Luồng thi hành theo app: Tray lấy mẫu foreground mỗi 15s và gửi thêm message IPC `foreground-changed` khi app foreground đổi (tên file exe hoặc tên process khác lần trước) + heartbeat mỗi 60s → `IpcPipeServer` ghi vào `ForegroundState` (báo cáo mới nhất của mỗi session) → mỗi 15s, AgentWorker đọc báo cáo còn tươi (≤ 90s) và đếm thời gian dùng theo app hôm nay từ `usage_samples`, rồi cảnh báo (một lần/ngày/exe khi còn ≤ 5 phút) hoặc đóng app khi vượt giới hạn/ngoài khung giờ/ngoài danh sách focus. So khớp tên exe dùng chung một helper chuẩn hóa (`ExeNames`: bỏ một hậu tố `.exe`, không phân biệt hoa thường) vì `usage_samples.app_name` là tên process trần còn config ghi `game.exe`. Đóng app chỉ tác động tiến trình cùng tên trong đúng session đã báo cáo, không bao giờ chạm session 0, và bị chặn bởi denylist (tiến trình hệ thống + chính exe của SafePC). Không có báo cáo tươi thì không đóng gì (fail-open). Ghi đè mở máy tạm thời (unlock) tạm ngưng cả thi hành theo app, focus và nghỉ bắt buộc.

Thứ tự ưu tiên phía domain (extension thi hành, cùng hợp đồng này): ghi đè chặn domain tạm thời (tempBlock) thắng allowlist của focus; ghi đè cho phép domain tạm thời (tempAllow) KHÔNG xuyên qua focus — trong giờ tập trung, domain ngoài danh sách focus vẫn bị chặn dù có tempAllow.

Nghỉ bắt buộc (`forced_break`, VD: dùng liên tục 45 phút thì nghỉ 10 phút): chuỗi dùng liên tục tính từ `usage_samples` — khoảng trống > 3 phút thì chuỗi đứt, mẫu mới nhất cũ hơn 3 phút thì chuỗi = 0. Khi chuỗi đạt `workMinutes`, Service lưu thời điểm kết thúc giờ nghỉ vào `device_state` (`BreakEndsAt`, sống sót qua khởi động lại) và gửi IPC khóa — tái dùng đúng đường khóa hiện có (màn hình khóa đếm ngược 60s rồi `LockWorkStation`), không có UI khóa thứ hai. Trong giờ nghỉ, lệnh khóa được gửi lại mỗi 15s để đăng nhập lại sớm thì khóa lại ngay (Tray `ReassertLock`). Hết giờ nghỉ thì xóa `BreakEndsAt` và đặt `BreakStreakFloor` bằng thời điểm kết thúc, để mẫu trong giờ nghỉ không gây nghỉ lại ngay. Nói thành thật: giờ nghỉ chỉ khóa phiên trên máy này — không thể ép con nghỉ ngơi, chỉ ngăn con tiếp tục dùng máy này.

### 4.7. Cảnh báo can thiệp (Sprint 2 đợt 3, migration 5)

Bốn loại sự kiện (`audit_logs.action`, RPC `safepc_push_tamper_event` chỉ nhận đúng 4 giá trị này): `clock_drift` (đồng hồ lệch > 5 phút so với giờ server), `agent_restart` (Service khởi động lại), `extension_missing` và `service_stopped`. Agent chỉ tự đẩy 2 loại đầu (mỗi loại tối đa 1 lần/giờ, mốc lưu trong `device_state`); 2 loại sau Agent không bao giờ đẩy — máy đã dừng thì không đẩy được, còn extension vắng mặt thì Dashboard suy ra từ độ cũ của `devices.last_extension_seen_at`.

Luồng heartbeat extension: mỗi message extension gửi qua NativeHost (`getRules`/`reportUsage`) khiến NativeHost ghi đè timestamp UTC vào `shared\extension_heartbeat.txt` (chỉ timestamp, không secret; ghi lỗi không làm lỗi message) → mỗi chu kỳ heartbeat 60s, sau khi heartbeat chính thành công, Service đọc file: timestamp mới (< 5 phút) thì báo lên server qua RPC `safepc_report_extension_heartbeat` (tối đa 1 lần/5 phút); file thiếu/hỏng/cũ hơn 15 phút thì chỉ ghi log cảnh báo (tối đa 1 lần/giờ). RPC ghi sự kiện vào `audit_logs` với `family_id`/`child_id`/`device_id` suy ra từ device đã xác thực, `details` cắt tối đa 2KB. Migration 5 chưa áp dụng lên Supabase (PENDING) — xem `backend/supabase/README.md`.

## 5. Chống can thiệp (Tamper resistance) — MVP

- Agent Service chạy quyền SYSTEM, Recovery: restart sau 1 phút nếu bị dừng.
- Tray App có Watchdog: nếu Service chết, thử khởi động lại (khi có quyền).
- Gỡ cài đặt / dừng Service / đổi rules local đều yêu cầu mã PIN phụ huynh (khác mật khẩu đăng nhập).
- Con dùng Standard User: không có quyền dừng Service SYSTEM, không gỡ app cài All Users nếu không có Admin.
- Cảnh báo "Máy offline bất thường" nếu heartbeat mất > 15 phút trong giờ được phép dùng.
- **Giới hạn thành thật:** Nếu con có Admin / boot Safe Mode / cài lại Windows thì mọi biện pháp phần mềm đều có thể bị vượt qua. Tài liệu hướng dẫn phụ huynh sẽ ghi rõ: giữ quyền Admin, bật BitLocker + Secure Boot, đặt BIOS password nếu cần.

## 6. Hiệu năng & độ tin cậy

- Agent: CPU < 2% khi idle, RAM < 100MB, không quét toàn bộ ổ đĩa.
- Dashboard: PWA, cache shell, dữ liệu ngày hiện tại load < 2s.
- Đồng bộ: batch 5 phút, retry với backoff, không mất dữ liệu khi mất mạng < 24h.

## 7. Triển khai Free (dưới 100 user)

- Supabase Free: 1 project, backup hàng ngày (giữ 7 ngày ở gói free — cần xuất backup thủ công hàng tuần).
- Vercel Free: Dashboard + landing, subdomain `*.vercel.app` cho tới khi có domain riêng.
- GitHub Free: Private repo + Actions (2000 phút/tháng cho private, đủ cho dự án này).
- Không cần mua domain/Figma ở giai đoạn này. Domain mua sau (~250k-350k/năm cho .com qua Cloudflare Registrar) khi muốn thương hiệu riêng.
