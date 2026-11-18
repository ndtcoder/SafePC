# Kiến trúc — SafePC

## 1. Sơ đồ tổng thể

```
[Máy PC của con - Windows]
  ├─ Windows Service (SYSTEM): enforcement, watchdog, sync
  ├─ Tray App (User session): UI cảnh báo, màn hình khóa, xin thêm giờ
  ├─ Browser Extension (Chrome/Edge): lọc domain, báo cáo domain
  └─ SQLite local: hàng đợi offline, cache quy tắc

            ↕ HTTPS (TLS 1.2+)

[Backend: Supabase Free]
  ├─ Postgres + Row Level Security (RLS)
  ├─ Auth (email/password + MFA TOTP tự nguyện cho phụ huynh)
  ├─ Realtime: CHƯA DÙNG — yêu cầu của con tải lúc mở trang Dashboard; lệnh xuống Agent đi bằng polling 15s
  ├─ Storage (avatar, log đính kèm - nếu có)
  ├─ pg_cron + pg_net (lịch gửi email: báo cáo tuần + quét thông báo)
  └─ Edge Functions (send-weekly-report, send-parent-notifications; pairing đã chuyển sang RPC, dọn dữ liệu cũ chưa làm)

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
devices (id, family_id, child_id, hostname, os_version, agent_version, last_seen_at, last_extension_seen_at, enforcement_json, enforcement_updated_at, status)
device_tokens (device_id, token_hash, created_at, revoked_at) -- không lưu token thô
pairing_codes (id, family_id, child_id, code_hash, attempts, expires_at, used_at) -- chỉ lưu hash SHA-256 của mã
rules (id, child_id, type: daily_limit|bedtime|time_window|app|website, config JSONB, name, enabled)
rule_templates (id, family_id, name, description, rules JSONB, created_at, updated_at) -- mẫu quy tắc của phụ huynh
app_usage (id, device_id, child_id, app_name, exe_path_hash, started_at, duration_sec)
web_visits (id, device_id, child_id, domain, path, visited_at, duration_sec, blocked: bool) -- domain + đường dẫn (bỏ query/fragment, trần 500 ký tự), tự xóa sau 90 ngày (migration 19)
requests (id, child_id, type: extra_time|unblock_app|unblock_domain, domain, status, reason, decided_by, decided_at, minutes, device_id)
commands (id, device_id, type: lock_now|unlock|refresh_rules|update|temporary_override, payload, status, created_at)
audit_logs (id, family_id, child_id, device_id, actor, action, target, ip_hash, details, created_at)
time_bank_grants (id, family_id, child_id, minutes, reason, granted_by, status: active|voided, expires_at) -- lịch sử thưởng giờ
family_invites (id, family_id, invited_email, token_hash, invited_by, expires_at, accepted_at, accepted_by, revoked_at) -- chỉ lưu hash token
weekly_report_sends (id, family_id, week_start, status: sending|sent, claimed_at, sent_at, resend_id, recipients) -- chống gửi trùng email tuần
notification_sends (id, family_id, kind: request|tamper|device_offline, event_key, status, device_id, action, child_id, claimed_at, sent_at, resend_id, recipients) -- chống gửi trùng email thông báo
```

- Tất cả bảng bật RLS: phụ huynh chỉ thấy dữ liệu của gia đình mình.
- `exe_path_hash`: hash đường dẫn để tránh lộ username trong đường dẫn (C:\Users\<tên>\...).
- Dữ liệu lịch sử web (web_visits) giữ 90 ngày, xóa bởi lịch pg_cron dọn dẹp hàng ngày (migration 19, 03:00 UTC, DELETE trực tiếp — không có Edge Function tổng hợp/dọn dẹp).

## 4. Luồng chính

### 4.1. Pairing thiết bị
1. Phụ huynh bấm "Ghép nối máy mới" trên Dashboard, chọn con -> Dashboard tạo pairing_code 6 số (chỉ lưu hash SHA-256), hết hạn 5 phút.
2. Trên máy con, chạy lệnh `SafePC.Agent.Service.exe pair <mã>` bằng quyền Admin (PowerShell/Terminal).
3. Agent gọi RPC `safepc_redeem_pairing_code` qua PostgREST đổi code -> device_token + device_id (một transaction: đánh dấu mã đã dùng + tạo device + tạo token). Token lưu bằng DPAPI (máy con) + hash lưu DB. Edge Function pair-device đã thay bằng RPC (migration 3). Lệnh `pair` ép console sang UTF-8 (Output/InputEncoding, best-effort trong try/catch) ngay khi chạy để tiếng Việt in ra PowerShell/Terminal không vỡ dấu. Lệnh `pair` là đường console cho người dùng cuối; cờ `--self-test-ipc` cũng ghi console nhưng chỉ dùng cho CI.
4. Agent tải rules lần đầu, bắt đầu heartbeat 60s.

### 4.2. Thi hành quy tắc (offline-first)
- Agent cache rules + giới hạn còn lại trong SQLite. Mất mạng vẫn thi hành đúng theo cache.
- Mỗi 15s: kiểm tra foreground app, cộng dồn thời gian, kiểm tra bedtime/limit.
- Mỗi 15s (khi online): poll commands. Mỗi 5 phút: đẩy usage batch (app + web). Polling là đường duy nhất — chưa dùng Realtime.
- Khi hết giờ: Tray App hiện màn hình khóa, đếm ngược 60s để con kịp lưu bài rồi gọi LockWorkStation khóa phiên. Với lệnh khóa có độ trễ (xem 4.9), giai đoạn chờ chỉ hiện cửa sổ cảnh báo nhỏ, hết độ trễ mới hiện màn hình khóa.
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

Chiều ngược lại: extension đếm thời gian tab hiển thị theo cặp (domain, đường dẫn) — đường dẫn đã cắt bỏ phần truy vấn (query) và fragment ngay tại điểm thu thập, trần 500 ký tự (quyết định của phụ huynh 18/11/2026; trước 0.1.10 chỉ ghi domain) → gửi NativeHost mỗi phút → ghi thêm vào `shared\web_usage.jsonl` → Agent đọc trong chu kỳ flush 5 phút (cắt lại query/fragment lần nữa), đẩy qua RPC `safepc_push_web_visits` (migration 4, sửa ở migration 10 để nhận thêm cờ `blocked`, sửa ở migration 19 để nhận thêm đường dẫn và cắt lại lần thứ ba) vào bảng `web_visits`; chỉ cắt file khi gửi thành công, gửi lỗi thì giữ lại chu kỳ sau. Lịch cron `safepc-web-history-cleanup` (migration 19) xóa hàng cũ hơn 90 ngày mỗi ngày. Từ extension 0.1.7, lượt web bị chặn cũng đi qua kênh này với `blocked = true`, `duration_sec = 0`, chỉ domain của rule đã khớp, không có đường dẫn (xem §4.10). Extension không gọi Supabase, không có secret. Khi chưa nối được NativeHost, extension mở (fail-open) và popup báo chưa kết nối; bản unpacked có thể bị Standard User tắt — cứng hóa bằng store publishing + chính sách `ExtensionInstallForcelist` là việc sau (tài khoản Edge Add-ons đã đăng ký + xác minh, chưa xuất bản extension nào, chưa bật chính sách). Manifest của NativeHost được bộ cài sinh ra lúc cài đặt (`WriteNativeHostManifest` trong `SafePCAgent.iss`) với ID extension Edge thật, không còn placeholder; sửa tay file manifest sẽ bị ghi đè khi cài lại.

Yêu cầu xin mở trang web (extension 0.1.9, migration 18): trang chặn có nút "Xin phép mở trang này" — domain hiển thị lấy từ tham số URL (đường tab watcher) hoặc hỏi background quy chiếu rule vừa khớp (đường redirect DNR); không xác định được domain thì nút ẩn. Con bấm nút → background gửi message `requestUnblock` (chỉ tên miền) qua NativeHost → ghi dòng JSONL vào `shared\domain_requests.jsonl` → Service đọc trong chu kỳ poll lệnh 15s, throttle 5 phút/domain, đẩy qua RPC `safepc_push_unblock_domain_request` (xác thực device token như RPC xin thêm giờ; đã có yêu cầu pending cho cùng device + domain thì trả về hàng cũ, không tạo mới) vào bảng `requests` loại `unblock_domain` (cột `domain`, chỉ tên miền). Phụ huynh duyệt trên trang Yêu cầu, chọn thời lượng 15/30/60 phút hoặc số phút tùy chọn (1–240) → một lệnh `temporary_override` action `allow_domain` đúng hình dạng ghi đè domain hiện có → Agent xuất bản `tempAllow`, extension làm mới trong ~1 phút, con quay lại rồi mở lại trang thì mở được; hết hạn, quy tắc website bình thường áp lại. Không có push tức thì: "hiệu lực tức thì" nghĩa là poll 15s + refresh extension ≤ 1 phút + con quay lại rồi mở lại trang. Ghi đè mới nhất thay thế ghi đè đang hiệu lực trên cùng máy (kể cả ghi đè giờ giấc) — cùng ngữ nghĩa một ghi đè duy nhất của Agent. Email thông báo cho loại yêu cầu mới đi qua cùng function quét 5 phút và cùng chống spam 1 email/giờ/con (xem docs/07). Chưa kiểm chứng đầu-cuối trên máy thật.

### 4.6. Thi hành theo app, giờ học tập trung và nghỉ bắt buộc (Sprint 2 đợt 3)

Quy tắc theo app (`type = 'app'`, một rule một dòng, phân biệt bằng `config.mode`): `app_time_limit` (giới hạn phút/ngày cho từng app), `app_block_by_time` (khung giờ ĐƯỢC dùng theo thứ — ngoài khung thì đóng app), `forced_break` (nghỉ bắt buộc, xem dưới). Bản sửa lỗi sau Sprint 2 đợt 3 thêm 3 mode: `app_block` (luôn chặn — đóng khi thấy), `app_allowlist` (luôn áp dụng — chỉ các app trong danh sách được mở, đóng app foreground ngoài danh sách), `app_allowlist_by_time` (allowlist chỉ trong khung giờ theo thứ, cùng ngữ nghĩa khung giờ với `app_block_by_time`). Giờ học tập trung là rule `type = 'website'` với `mode = 'focus'` — ngoại lệ có chủ đích: phía đóng app do Agent đọc từ rule website (thi hành trong AgentWorker, không phải RuleEngine), phía domain do extension thi hành qua mục `focus` trong `domain_rules.json`.

Luồng thi hành theo app: Tray phát hiện đổi foreground tức thì bằng WinEvent hook (EVENT_SYSTEM_FOREGROUND) và gửi message IPC `foreground-changed` ngay (gửi rớt thì lần quét sau thử lại; sampler lấy mẫu mỗi 15s + heartbeat 60s làm dự phòng và đếm usage) → `IpcPipeServer` ghi vào `ForegroundState` (báo cáo mới nhất của mỗi session) và kích hoạt thi hành ngay, dùng chung hàm thi hành với vòng tick qua cổng TryEnter chống chồng chéo (vòng tick 15s đọc báo cáo còn tươi (≤ 90s) làm dự phòng) → AgentWorker đếm thời gian dùng theo app hôm nay từ `usage_samples`, rồi cảnh báo (một lần/ngày/exe khi còn ≤ 5 phút) hoặc đóng app khi vượt giới hạn/ngoài khung giờ/ngoài danh sách focus. So khớp tên exe dùng chung một helper chuẩn hóa (`ExeNames`: bỏ một hậu tố `.exe`, không phân biệt hoa thường) vì `usage_samples.app_name` là tên process trần còn config ghi `game.exe`. Đóng app chỉ tác động tiến trình cùng tên trong đúng session đã báo cáo, không bao giờ chạm session 0, và bị chặn bởi denylist (tiến trình hệ thống + chính exe của SafePC). Không có báo cáo tươi thì không đóng gì (fail-open). Ghi đè mở máy tạm thời (unlock) chỉ hoãn khóa máy theo giờ giấc (giờ ngủ/khung giờ/giới hạn ngày/khóa cưỡng chế); thi hành theo app, focus và nghỉ bắt buộc vẫn chạy trong lúc mở khóa (quyết định ngày 18/11/2026).

Thứ tự thi hành theo app trong một lần kiểm tra (bản sửa lỗi sau đợt 3): ghi đè app tạm thời → focus → allowlist (luôn áp dụng + theo giờ) → luôn chặn → chặn theo giờ → giới hạn thời gian. Ghi đè app tạm thời là lệnh `temporary_override` với `action` `block_app`/`allow_app` và payload `{"apps":["exe",...],"minutes":N,"expires_at":ISO}`: `block_app` đóng app foreground khớp danh sách, `allow_app` miễn app khớp khỏi MỌI thi hành theo app (kể cả focus/allowlist) trong lúc còn hạn. Ghi đè app lưu bền vững trong bảng SQLite `active_override` (cột `apps_json`, cùng hàng duy nhất với ghi đè giờ giấc/domain — lệnh mới nhất thắng) và được `RuleEngine` bỏ qua hoàn toàn như ghi đè domain. Mọi đường đóng app đều đi qua đúng một hàm `KillAppAsync` (một điểm gọi `Process.Kill` duy nhất, kiểm tra denylist ở đầu hàm và ở từng process); không đường nào khác được đóng process.

Thứ tự ưu tiên phía domain (extension thi hành, cùng hợp đồng này): ghi đè chặn domain tạm thời (tempBlock) thắng allowlist của focus; ghi đè cho phép domain tạm thời (tempAllow) KHÔNG xuyên qua focus — trong giờ tập trung, domain ngoài danh sách focus vẫn bị chặn dù có tempAllow. Thang ưu tiên DNR đầy đủ (số càng cao càng thắng, extension thi hành, `domain_rules.json` chỉ mang dữ liệu; `PRIORITY` trong `background.js`): tempBlock 100 > redirect 65 > focusAllow 60 > focusBlockAllRedirect 59 > focusBlockAll 58 > tempAllow 57 > allowlistByTimeAllow 55 > allowlistAllow 50 > time 40 > blocked 30 > limit 20 > blockAllRedirect 15 > blockAll 14. Chặn theo danh mục (extension 0.1.8) không đổi thang này: domain thuộc danh mục vẫn là rule `blocked` ở mức 30, chỉ khác lý do hiện trên trang chặn (xem `blockedCategories` trong file rules). Mục `allowlistByTime` trong file (hợp từ mọi rule website mode `allowlist_by_time`, mỗi rule một entry domains + khung giờ theo thứ; khóa vắng mặt khi không có rule hợp lệ nào) do `DomainRulesPublisher` xuất bản, Version file vẫn là 1.

Nghỉ bắt buộc (`forced_break`, VD: dùng liên tục 45 phút thì nghỉ 10 phút): chuỗi dùng liên tục tính từ `usage_samples` — khoảng trống > 3 phút thì chuỗi đứt, mẫu mới nhất cũ hơn 3 phút thì chuỗi = 0. Khi chuỗi đạt `workMinutes`, Service lưu thời điểm kết thúc giờ nghỉ vào `device_state` (`BreakEndsAt`, sống sót qua khởi động lại) và gửi IPC khóa — tái dùng đúng đường khóa hiện có (màn hình khóa đếm ngược 60s rồi `LockWorkStation`), không có UI khóa thứ hai. Trong giờ nghỉ, lệnh khóa được gửi lại mỗi 15s để đăng nhập lại sớm thì khóa lại ngay (Tray `ReassertLock`). Hết giờ nghỉ thì xóa `BreakEndsAt` và đặt `BreakStreakFloor` bằng thời điểm kết thúc, để mẫu trong giờ nghỉ không gây nghỉ lại ngay. Nói thành thật: giờ nghỉ chỉ khóa phiên trên máy này — không thể ép con nghỉ ngơi, chỉ ngăn con tiếp tục dùng máy này.

### 4.7. Cảnh báo can thiệp (Sprint 2 đợt 3, migration 5)

Bốn loại sự kiện (`audit_logs.action`, RPC `safepc_push_tamper_event` chỉ nhận đúng 4 giá trị này): `clock_drift` (đồng hồ lệch > 5 phút so với giờ server), `agent_restart` (Service khởi động lại), `extension_missing` và `service_stopped`. Agent chỉ tự đẩy 2 loại đầu (mỗi loại tối đa 1 lần/giờ, mốc lưu trong `device_state`); 2 loại sau Agent không bao giờ đẩy — máy đã dừng thì không đẩy được, còn extension vắng mặt thì Dashboard suy ra từ độ cũ của `devices.last_extension_seen_at`.

Luồng heartbeat extension: mỗi message extension gửi qua NativeHost (`getRules`/`reportUsage`) khiến NativeHost ghi đè timestamp UTC vào `shared\extension_heartbeat.txt` (chỉ timestamp, không secret; ghi lỗi không làm lỗi message) → mỗi chu kỳ heartbeat 60s, sau khi heartbeat chính thành công, Service đọc file: timestamp mới (< 5 phút) thì báo lên server qua RPC `safepc_report_extension_heartbeat` (tối đa 1 lần/5 phút); file thiếu/hỏng/cũ hơn 15 phút thì chỉ ghi log cảnh báo (tối đa 1 lần/giờ). RPC ghi sự kiện vào `audit_logs` với `family_id`/`child_id`/`device_id` suy ra từ device đã xác thực, `details` cắt tối đa 2KB. Migration 5 đã áp dụng lên Supabase ngày 16/11/2026 (cùng đợt migration 4, đã kiểm chứng qua REST).

### 4.8. Báo cáo trạng thái thi hành, chống kẹt IPC và cứng hóa Tray (bản sửa lỗi sau Sprint 2 đợt 3, migration 6)

Báo cáo thi hành: mỗi lần kiểm tra rules (15s), AgentWorker dựng snapshot từ chính kết quả đánh giá của lần đó — quyết định giờ giấc (RuleEngine + nghỉ bắt buộc), app đang bị chặn/allowlist, focus có hiệu lực, có rule website nào đang bật — và để ở bộ nhớ chờ; vòng heartbeat (60s) gửi snapshot lên qua RPC `safepc_report_enforcement` (migration 6, cập nhật đúng 2 cột `devices.enforcement_json` + `enforcement_updated_at`, payload cắt 4KB) khi nội dung (trừ thời điểm) đổi, tối đa 1 lần/5 phút. Hợp đồng snapshot (tên trường LITERAL, Dashboard đọc): `{"v":1,"at":ISO,"decision":"allow"|"warn"|"lock","lockedBy":null|"forced"|"rule"|"override"|"break","reasons":[rule-type],"ruleIds":[uuid],"appBlocks":[exe],"domainRulesActive":bool,"focusActive":bool}`. Cùng lúc, vòng kiểm tra ghi log chẩn đoán quyết định khi quyết định/lý do/rule/ghi đè đổi, hoặc mỗi 15 phút (quyết định, lý do, tối đa 3 id rule + tổng số, phút đã dùng, trạng thái ghi đè) — log Service tự trả lời được rules có đồng bộ và đánh giá đúng không, không bao giờ log token/hash.

Chống kẹt IPC (chẩn đoán từ log thật tối 16/11/2026: vòng accept của `IpcPipeServer` chỉ nhận 1 kết nối rồi kẹt im lặng, mọi lệnh khóa/mở sau đó đều bị bỏ; vòng nối lại của Tray cũng im lặng 24 phút): mỗi kết nối handler hai bên đều có idle timeout 120 giây (không dòng nào tới thì đóng + dispose, giải phóng pipe instance — kết nối chết không bao giờ giữ pipe mãi; Tray gửi mẫu mỗi 15s nên kết nối sống không chạm ngưỡng này); vòng accept ghi log mọi vòng lặp kèm số thứ tự; watchdog 60s chỉ ghi log cảnh báo LOUD (không tự khôi phục, không dispose gì) khi quá 90s không có vòng accept mới; phía client chờ khóa ghi tối đa 5 giây và chống spam cảnh báo "chưa kết nối" (1 lần/60s). Quy tắc cũ giữ nguyên: không bao giờ quyết định nối/rớt bằng cờ `IsConnected`, tối đa 8 pipe instance, ACL pipe không đổi.

Gốc rễ thật của lỗi IPC (tìm ra ngày 17/11/2026 qua CI run #133, xem `AGENTS.md`): `AutoFlush = true` trên `StreamWriter` của pipe — setter gọi `Flush()` → `FlushFileBuffers` chặn tới khi đầu kia đọc; hai bên cùng đặt trước khi thread đọc nào chạy nên chết chéo vĩnh viễn. Đã sửa bằng cách bỏ `AutoFlush` ở mọi writer pipe và `FlushAsync` tường minh sau mỗi lần ghi. **Khóa/mở từ Dashboard đã kiểm chứng trên máy thật ngày 17/11/2026 (bản v0.1.136):** Tray nhận lock thì hiện màn hình khóa, nhận unlock thì đóng, 0 lỗi cả hai phía.

### 4.9. Giao lệnh theo phiên, khóa có độ trễ và cổng kiểm tra CI (đợt 17/11/2026)

Giao lệnh theo phiên: mỗi Tray khi nối gửi message `hello` (phiên Windows, tên tài khoản, quyền admin). Quyền admin xác định bằng `TokenElevationType` qua P/Invoke `GetTokenInformation` — KHÔNG dùng riêng `IsInRole(Administrator)` vì Tray không elevated nên hàm này luôn trả false kể cả với tài khoản admin (token UAC đã lọc). Service chỉ giao lệnh khóa/cảnh báo tới phiên không phải admin; phiên admin (phụ huynh) được miễn; phiên chưa giới thiệu vẫn nhận lệnh (fail-closed). Mở khóa tới mọi phiên. Ghép nối vẫn ở mức máy; chỉ phần giao lệnh là theo phiên.

Khóa có độ trễ: lệnh `lock_now` mang `delay_minutes` (0–5). Độ trễ > 0 thì Service đặt hẹn giờ, gửi cảnh báo ngay (Tray hiện cửa sổ nhỏ có đếm ngược trực tiếp, tái dùng một cửa sổ, đóng khi nhận lock/unlock), tới hẹn mới gửi lệnh khóa; vòng kiểm tra gửi lại cảnh báo khi số phút còn lại đổi. Trong lúc chờ, snapshot thi hành báo `warn` thay vì `lock`. Hẹn giờ chỉ tồn tại trong bộ nhớ — Service khởi động lại giữa chừng thì trạng thái khóa bền vững khiến tick sau khóa ngay (fail-closed).

Cổng kiểm tra trên CI (job `build-agent`, runner Windows): Tray `--self-test` 19 check (giao diện + IPC qua pipe server giả, gồm cảnh báo nhỏ và đóng cảnh báo khi khóa, hit-test nút, đếm dispatcher exception) và Service `--self-test-ipc` 13 check (xử lý usage-sample, giao lock/unlock, miễn trừ admin sau hello, outbox yêu cầu, xác thực PIN, hỏi thời gian còn lại). Cả hai cổng phải xanh thì CI mới đóng gói installer. Giới hạn: cùng user/cùng phiên, không bao phủ ranh giới ACL SYSTEM↔user hay đa phiên — kiểm chứng trên máy thật vẫn là bước quyết định. Phiên bản installer là `0.1.<số run CI>`.

Cứng hóa Tray (nguyên nhân Tray chết sớm vẫn chưa rõ, đang chờ Event Viewer — đây là chẩn đoán + cứng hóa, không phải một bản sửa đoán mò): global handler gắn ngay sau khi log được tạo (`UnhandledException` ghi stack, `DispatcherUnhandledException` ghi stack + `Handled = true` để UI exception không giết Tray, `UnobservedTaskException` ghi + `SetObserved`); log từng bước khởi động (6 bước) và breadcrumb ở mọi menu action / message IPC / mở-đóng cửa sổ để log đuôi cho thấy Tray đang làm gì khi chết; try/catch quanh mọi đường chuột, action menu, xử lý IPC và gọi `MessageReceived`; nếu `LockWindow` tạo/mở lỗi thì khóa phiên trực tiếp bằng `LockWorkStation` (khóa dự phòng — khóa phiên quan trọng hơn giao diện đếm ngược), `WarningWindow` lỗi thì chỉ ghi log. Cơ chế menu (cửa sổ WPF thật), ShutdownMode, cửa sổ neo và mutex single-instance không đổi.

### 4.10. Lịch sử thi hành theo quy tắc — sự kiện thi hành (đợt 18/11/2026, migration 10)

Bối cảnh: trang Báo cáo tuần (PRD §2.10, mục 4) cần số lần thi hành theo loại, nhưng database chưa có lịch sử thi hành — Agent chỉ gửi ảnh chụp trạng thái hiện tại (`devices.enforcement_json`, migration 6), `audit_logs` chỉ có 4 loại sự kiện can thiệp (migration 5), và `web_visits.blocked` luôn false vì RPC đẩy lượt thăm không insert cột đó (migration 4).

RPC `safepc_push_enforcement_event` (migration 10, `SECURITY DEFINER`, xác thực bằng `safepc_auth_device`, `family_id`/`child_id`/`device_id` suy ra từ hàng device đã xác thực, không tin client) ghi một sự kiện vào bảng `audit_logs` sẵn có — không tạo bảng mới vì sự kiện thi hành và sự kiện can thiệp có cùng hình dạng và cùng ranh giới đọc. RPC chỉ nhận đúng 4 giá trị, `details` cắt tối đa 2KB (JSON hỏng sau khi cắt thì dùng `{}`):

| Action | Ý nghĩa | `details` |
|---|---|---|
| `lock_started` | Màn hình khóa vừa hiện do quy tắc giờ giấc | `kind` = bedtime, time_window, daily_limit hoặc rule; `rule_ids` |
| `break_started` | Giờ nghỉ bắt buộc vừa bắt đầu | `work_minutes`, `break_minutes`, `rule_ids` |
| `app_blocked` | Một ứng dụng vừa bị đóng do vi phạm quy tắc | `exe`, `kind` = block, block_by_time, time_limit, focus, allowlist hoặc temp_block |
| `warning_shown` | Một cửa sổ cảnh báo vừa hiện cho con | `kind` = deadline, pending_lock, app_window hoặc app_limit; `minutes_left`, `exe` với kind app_* |

Phía Agent (`AgentWorker`, qua `SupabaseApiClient.PushEnforcementEventAsync`): chỉ ghi CHUYỂN TRẠNG THÁI, không ghi mỗi vòng kiểm tra 15 giây. `lock_started` chỉ khi khóa lần đầu (`firstLock`) VÀ gửi IPC tới được ≥1 Tray VÀ `DeriveLockedBy(...) == "rule"` — khóa cưỡng chế/ghi đè khóa của phụ huynh KHÔNG ghi ở đây vì đã đếm được từ bảng `commands`, ghi thêm sẽ đếm trùng; lần nhắc lại lệnh khóa trong giờ nghỉ cũng không ghi. `break_started` chỉ khi chuyển false → true. `app_blocked` chỉ khi đóng được thật (≥1 process) và chống spam cùng (exe, kind) trong 60 giây, mốc dedupe chỉ ghi khi gửi thành công. `warning_shown` chỉ khi cảnh báo tới được ≥1 Tray (đã hiện thật cho con). Gửi lỗi thì ghi log và bỏ qua — lỗi đẩy không bao giờ ảnh hưởng thi hành; Agent/extension mới chạy trước khi migration 10 được áp thì RPC chưa tồn tại, PostgREST trả lỗi, Agent ghi log throttle và bỏ qua (không crash, không retry bão).

Phía extension (0.1.7): mỗi lần tab tới trang chặn, extension ghi một lượt chặn CHỈ DOMAIN (không path/query/URL/referrer) vào hàng đợi riêng `pendingBlocked` (tối đa 200, lưu bền), gửi kèm lượt xem thường qua `reportUsage` với `blocked = true`, `duration_sec = 0`. Cả hai đường tới trang chặn đều ghi theo domain của RULE đã khớp: đường tab watcher dùng `matchedBlockRuleDomain` (dự phòng hostname), đường redirect DNR tra rule vừa khớp bằng `getMatchedRules` (chỉ xét rule REDIRECT, tra domain từ `blockingRuleDomains` dựng từ read-back `getDynamicRules()` sau mỗi lần rebuild). Không quy chiếu được — rule chặn-tất-cả của focus/allowlist (không có domain cụ thể), `getMatchedRules` trống/lỗi — thì BỎ QUA, không đoán domain từ URL cũ của tab. Dedupe chung 60 giây theo domain cho cả hai đường. NativeHost chấp nhận cờ `blocked` tùy chọn (không phải boolean thì cả lượt thăm không hợp lệ) và chỉ ghi vào dòng JSONL khi true; Service gửi `blocked` lên qua RPC `safepc_push_web_visits` đã sửa ở migration 10 (sample thiếu `blocked` thì coi là false, client cũ vẫn chạy). Lượt bị chặn KHÔNG mang đường dẫn ngay cả sau khi lượt xem thường đã có đường dẫn (0.1.10/migration 19) — NativeHost và Service đều bỏ path của visit bị chặn. **Số lượt web bị chặn vì vậy là cận dưới, không phải toàn bộ** — trang Báo cáo ghi rõ điều này.

Phía Dashboard (`weekReport.ts`): `countRuleEnforcement` đếm 4 action thi hành từ `audit_logs` (khóa phân loại theo `details.kind`, kind lạ/thiếu vào `otherRuleLocks` để tổng không mất), `countParentEnforcement` đếm khóa/chặn tạm thời của phụ huynh từ `commands` (không đếm trùng), `countBlockedVisits` đếm `web_visits.blocked`, `filterTamperForChild` chỉ giữ đúng 4 loại can thiệp nên sự kiện thi hành không rò sang thẻ Cảnh báo. **Lịch sử chỉ bắt đầu từ khi migration 10 được áp + bản Agent/extension mới được cài**; tuần trước thời điểm đó hiện 0 kèm ghi chú trung thực trong giao diện, không hiện 0 như thể không có thi hành. Migration 10 đã áp ngày 18/11/2026; luồng này chưa kiểm chứng trên máy thật.

### 4.11. Luồng email — báo cáo tuần và thông báo phụ huynh (đợt 18/11/2026, migration 11 + 12)

Hai Edge Function một file, paste-deployable, dùng supabase-js qua esm.sh; logic thuần nằm giữa marker `__PURE_START__`/`__PURE_END__` và được kiểm chứng bằng harness Node tách đoạn đó ra (không cần chạy Deno). Cả hai gửi qua Resend bằng `fetch` tới API gửi email của Resend, nội dung HTML + text thuần, mọi chuỗi từ dữ liệu đều escape HTML, không log địa chỉ email hay secret. Client dùng khóa quản trị do nền tảng cấp nên bypass RLS — mọi truy vấn đều lọc tường minh theo `family_id` để không rò dữ liệu giữa các gia đình.

Hợp đồng secret (Edge Function Secrets, do phụ huynh đặt tay, không bao giờ vào repo; hai function DÙNG CHUNG, không thêm secret mới cho function thứ hai): `RESEND_API_KEY` (bắt buộc), `WEEKLY_REPORT_SECRET` (bắt buộc — endpoint kiểm tra header `x-safepc-report-secret`, thiếu/sai hoặc secret chưa cấu hình thì 401 fail-closed), `RESEND_FROM` (tùy chọn, mặc định `SafePC <onboarding@resend.dev>`), `DASHBOARD_URL` (tùy chọn, mặc định `https://safe-pc.vercel.app`). Tên biến môi trường của khóa quản trị được ghép từ các phần rời trong code để quét secret của CI không báo nhầm. **JWT verification PHẢI TẮT cho cả hai function** — pg_cron xác thực bằng header secret chung, không gửi JWT. Lịch gửi dùng pg_cron + pg_net; secret xuất hiện trong định nghĩa job (đánh đổi đã biết của mẫu này, xem mục nâng cao trong `docs/06-EMAIL-SETUP.md`).

**Email báo cáo tuần** (`send-weekly-report`, migration 11): lịch `safepc-weekly-report`, `'0 0 * * 1'` = thứ Hai 00:00 UTC = 07:00 giờ +07 (pg_cron chạy theo múi giờ database, kỳ vọng là UTC trên project này — chưa xác nhận). Một email cho một family, gửi tới mọi phụ huynh, đủ 7 mục PRD §2.10 ở dạng gọn, cùng ngữ nghĩa số liệu với trang Báo cáo tuần (tuần bắt đầu thứ Hai 00:00 giờ Asia/Ho_Chi_Minh). Người nhận lấy qua Auth Admin API (`family_members` role `parent` → email từng user; lỗi từng phụ huynh thì bỏ qua phụ huynh đó; không có email thì bỏ qua family). Chống gửi trùng: bảng `weekly_report_sends` khóa duy nhất (`family_id`, `week_start`) + RPC `safepc_claim_weekly_report`/`safepc_finish_weekly_report` (chỉ vai trò quản trị được gọi); claim kẹt ở `sending` quá 1 giờ được thu hồi để lần chạy sau gửi lại; gửi lỗi thì xóa claim để thử lại, gửi xong mới đánh dấu `sent` kèm id trả về. Gọi tay với body `{week_offset (0–8, mặc định 1), family_id, dry_run}` — `dry_run` chạy được khi chưa áp migration 11. Nếu email đã gửi nhưng đánh dấu `sent` thất bại thì UPDATE hàng đó thành `sent` kèm id trả về, KHÔNG xóa hàng (xóa sẽ gây gửi trùng). Migration 11 đã áp ngày 18/11/2026; dòng lịch cron + múi giờ UTC chưa kiểm chứng được qua REST, đang chờ xác nhận.

**Email thông báo phụ huynh** (`send-parent-notifications`, migration 12): lịch `safepc-parent-notifications` quét mỗi 5 phút (`'*/5 * * * *'`). Quét định kỳ thay vì trigger trên INSERT: offline là sự VẮNG tín hiệu nên không có hàng mới để trigger bám vào; trigger lỗi có thể làm hỏng đường ghi của Agent; quét cho chống trùng rõ ràng và tự bù ở lần quét sau. Ba loại sự kiện: yêu cầu mới còn chờ duyệt (`extra_time`, `unblock_app`), 4 loại can thiệp từ `audit_logs`, máy quá 48 giờ không tín hiệu (khóa đợt offline `"<device_id>@<last_seen_at ms>"` — ổn định trong lúc offline, đợt mới sau khi máy quay lại rồi lại offline; máy chưa từng nối không báo). Chống spam: chỉ xét sự kiện 24 giờ gần nhất; mỗi con tối đa 1 email yêu cầu/giờ; can thiệp tối đa 1 email/6 giờ cho mỗi máy + loại; tối đa 25 email mỗi lần quét cho một family (chốt chặn trước trần 100 email/ngày của gói Resend miễn phí); yêu cầu đã được quyết định thì đọc lại ngay trước lúc gửi và bỏ qua. Chống trùng: bảng `notification_sends` khóa duy nhất (`kind`, `event_key`) + 3 RPC claim/finish/mark-terminal (chỉ vai trò quản trị); claim là kiểm tra duy nhất, không đọc trước bảng để loại sự kiện (đọc trước sẽ loại cả hàng `sending` kẹt và làm đường thu hồi thành mã chết). Migration 12 đã viết, CHƯA áp dụng.

Giới hạn khi chưa có domain đã xác minh: gửi từ `onboarding@resend.dev` thì Resend chỉ giao tới đúng email đăng ký tài khoản Resend (email khác bị lỗi 403) — đủ cho một gia đình. Domain `ndt.ap.vn` đã mua chiều 18/11/2026 nhưng chưa thêm vào Resend và chưa xác minh DNS; sau khi xác minh, đổi người gửi chỉ cần đổi secret `RESEND_FROM` rồi deploy lại, không sửa code. **Trạng thái: code của cả hai function đã giao và qua CI, nhưng CHƯA kiểm chứng đầu-cuối** (chưa chạy thật trên Deno, chưa gửi thật, Auth Admin API chưa từng thử ở project này, lịch cron chưa thấy chạy). Các bước tay nằm ở `docs/06-EMAIL-SETUP.md` (5 bước) và `docs/07-NOTIFICATIONS-SETUP.md` (4 bước).

## 5. Chống can thiệp (Tamper resistance) — MVP

- Agent Service chạy quyền SYSTEM, Recovery: restart sau 1 phút nếu bị dừng (bộ cài đặt `sc.exe failure` restart 3 lần, mỗi lần sau 60 giây).
- Tray App KHÔNG có watchdog khởi động lại Service — không có code nào làm việc đó; Service tự khởi động lại nhờ Recovery của Windows ở trên.
- Gỡ cài đặt hiện chỉ cần quyền Admin (Standard User không gỡ được phần mềm cài All Users); yêu cầu mã PIN khi gỡ là việc Sprint 4 (TODO trong bộ cài), chưa triển khai. Dừng Service cũng cần quyền Admin. Rules local nằm trong `%ProgramData%\SafePC` với ACL hạn chế, Standard User không sửa được. Mã PIN thoát Tray (khác mã PIN gỡ) thì đã có: thoát Tray cần PIN phụ huynh, sai 5 lần khóa 5 phút.
- Con dùng Standard User: không có quyền dừng Service SYSTEM, không gỡ app cài All Users nếu không có Admin.
- Cảnh báo offline bất thường: email khi máy quá 48 giờ không tín hiệu (xem §4.11); Dashboard báo máy offline khi heartbeat quá 10 phút. Không có cảnh báo *offline* nào ở ngưỡng 15 phút — ngưỡng 15 phút chỉ dùng cho trạng thái extension "Không thấy gần đây" trên trang Hôm nay.
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

### 7.1. Mô hình dùng chung cho nhiều gia đình (đã phê duyệt 17/11/2026, xem PRD §2.9)

- Một bản triển khai duy nhất (1 project Supabase + 1 web app) phục vụ mọi gia đình; dữ liệu tách nhau bằng RLS theo `family_id` — cùng cơ chế đã dùng từ Sprint 0, không thay đổi kiến trúc dữ liệu.
- Phân phối: bộ cài 1 file (ghép nối bằng giao diện nhập mã, không còn PowerShell), extension qua cửa hàng Chrome/Edge (ID thật, tự cập nhật), Agent tự cập nhật kèm kiểm tra hash.
- Báo cáo tuần chạy trong Dashboard (Recharts) + email tóm tắt qua Edge Function + Resend gói free; không dùng Power BI.
- Quyết định còn mở: ai vận hành, domain, tài khoản cửa hàng extension, chứng chỉ ký số.
