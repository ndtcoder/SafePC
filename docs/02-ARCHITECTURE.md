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
| Extension | Manifest V3, TypeScript | Chạy được Chrome + Edge, code chung 1 repo. |
| CI/CD | GitHub Actions Free | Build + test + quét dependency (Dependabot, CodeQL free cho public repo; private repo vẫn có free minutes). |
| Monitoring | Sentry Free / Logtail Free + Supabase Logs | Bắt lỗi Agent/Dashboard, cảnh báo Agent offline. |

**Phương án thay thế đã cân nhắc:** Firebase (Auth/Firestore tốt nhưng truy vấn báo cáo SQL kém hơn), Tauri/Rust cho Agent (nhẹ nhưng tích hợp Windows Service phức tạp hơn C#), Electron cho Agent (nặng, dễ bị tắt hơn Service).

## 3. Mô hình dữ liệu (rút gọn)

```
families (id, owner_id, name, created_at)
family_members (family_id, user_id, role: parent|child, ...)
children (id, family_id, display_name, birth_year, avatar_url)
devices (id, family_id, child_id, hostname, os_version, agent_version, last_seen_at, status)
device_tokens (device_id, token_hash, created_at, revoked_at) -- không lưu token thô
rules (id, child_id, type: daily_limit|bedtime|time_window|app|website, config JSONB, enabled)
app_usage (id, device_id, child_id, app_name, exe_path_hash, started_at, duration_sec)
web_visits (id, device_id, child_id, domain, visited_at, blocked: bool) -- chỉ domain
requests (id, child_id, type: extra_time|unblock_app, status, reason, decided_by, decided_at)
commands (id, device_id, type: lock_now|unlock|refresh_rules|update|temporary_override, payload, status, created_at)
audit_logs (id, family_id, actor, action, target, ip_hash, created_at)
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

Đã triển khai kiểm tra lệch giờ (16/11/2026): trong vòng lặp heartbeat 60s, Worker so sánh giờ máy với giờ server trả về; lệch quá 5 phút thì ghi log cảnh báo. Chưa triển khai: báo phụ huynh (qua `audit_logs` / trạng thái thiết bị) — TODO đợt 3. Không tự động sửa giờ máy.

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
