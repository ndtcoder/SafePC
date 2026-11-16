# PRD — SafePC v0.1

## 1. Người dùng và vai trò

| Vai trò | Mô tả | Quyền |
|---|---|---|
| Phụ huynh (Parent/Admin) | Người tạo gia đình, cài Agent, đặt quy tắc | Toàn quyền: xem báo cáo, đổi quy tắc, khóa/mở máy, phê duyệt xin thêm giờ |
| Con (Child) | Người dùng máy PC | Xem thời gian còn lại, xem quy tắc của mình, gửi yêu cầu xin thêm giờ / mở app bị chặn |
| Hệ thống (Agent) | Chạy trên máy con | Thu thập usage, thi hành quy tắc, gửi heartbeat |

Một gia đình: 1-2 phụ huynh, 1-3 con, 1-3 máy PC (MVP: 1 phụ huynh, 1 con, 1 máy).

## 2. MVP — Giai đoạn 1: PC Agent + Dashboard Web (Ưu tiên cao nhất)

### 2.1. Tài khoản & liên kết thiết bị
- [ ] Đăng ký/đăng nhập phụ huynh bằng email + mật khẩu (Supabase Auth), xác minh email.
- [ ] Tạo hồ sơ con (tên, ngày sinh/độ tuổi, avatar).
- [ ] Ghép nối máy con bằng mã pairing 6 số + QR, hết hạn sau 10 phút, dùng 1 lần.
- [ ] Agent lưu device token an toàn (Windows Credential Manager / DPAPI), không lưu mật khẩu phụ huynh trên máy con.

### 2.2. Theo dõi thời gian sử dụng (Usage Tracking)
- [ ] Ghi nhận app đang chạy ở foreground (tên process, tên hiển thị, thời lượng), tổng hợp theo 5 phút.
- [ ] Ghi nhận thời gian online/offline, thời gian khóa màn hình.
- [ ] Gửi dữ liệu lên server theo batch, có hàng đợi offline (SQLite local), đồng bộ khi có mạng.
- [ ] Dashboard hiển thị: tổng thời gian hôm nay/tuần, top app, biểu đồ theo giờ.

### 2.3. Giới hạn thời gian (Screen Time)
- [x] Giới hạn tổng thời gian/ngày theo thứ trong tuần (VD: T2-T6: 2h, T7-CN: 3h). — Xong Sprint 2 đợt 1 (Dashboard + Agent, xem 2.3.1).
- [x] Lịch giờ ngủ / giờ cấm theo từng thứ (VD: 21:30-07:00 không dùng máy, qua đêm được). — Xong Sprint 2 đợt 1 (xem 2.3.1).
- [x] Khung giờ được dùng máy theo từng thứ (VD: T2-T6 chỉ 07:00-21:00, ngoài khung giờ thì khóa). — Xong Sprint 2 đợt 1 (xem 2.3.1).
- [ ] Cảnh báo trước 15/5/1 phút khi sắp hết giờ.
- [ ] Khi hết giờ: hiển thị màn hình khóa toàn màn hình, khóa phiên làm việc (LockWorkStation), không tắt máy đột ngột làm mất bài làm — lưu ý: khóa sau khi lưu cảnh báo.
- [x] Phụ huynh có thể "Khóa ngay" / "Mở thêm 15/30/60 phút" từ xa. — Xong Sprint 2 đợt 1 dưới dạng ghi đè tạm thời tự hết hạn (cộng thêm giờ / khóa tạm thời / tạm mở máy, 15/30/60/120 phút, xem 2.3.1).

#### 2.3.1. Danh mục quy tắc giờ giấc — Sprint 2 đợt 1 (đã triển khai)

Quy tắc lưu trong bảng `rules` (cột `config` JSONB). Mọi giờ giấc theo **giờ địa phương trên máy của con**. Quy ước thứ: số 0–6 khớp `Date.getDay()` và C# `DayOfWeek` (0 = Chủ nhật, 6 = Thứ 7). Hình dạng config chi tiết (TypeScript) xem `packages/shared-types/src/index.ts`.

| Loại (`type`) | Config JSONB | Ngữ nghĩa |
|---|---|---|
| `daily_limit` | `{"minutesByWeekday": {"1": 120, "2": 120, "3": 120, "4": 120, "5": 120, "6": 180, "0": 180}}` | Tổng số phút được dùng mỗi ngày, theo thứ. Ngày vắng mặt = không giới hạn ngày đó. Agent vẫn chấp nhận hình dạng cũ `{"minutes_per_day": N}` / `{"daily_minutes": N}` (mọi ngày) cho rule đã lưu trước Sprint 2. |
| `time_window` | `{"windowsByWeekday": {"1": [{"start": "07:00", "end": "21:00"}]}}` | Chỉ được dùng máy trong các khung giờ liệt kê. Ngoài mọi khung giờ thì khóa. **Ngày vắng mặt hoặc mảng rỗng = không được dùng máy ngày đó.** Mỗi khoảng phải có `start < end` (không qua đêm). Nhiều rule thì hợp (union) các khung giờ. |
| `bedtime` | `{"bedtimeByWeekday": {"1": {"start": "21:00", "end": "07:00"}}}` | Khung giờ cấm theo thứ. Khoảng qua đêm (`end <= start`) khóa từ `start` hôm nay tới `end` hôm sau (vd: bedtime Thứ 2 21:00–07:00 khóa tới 07:00 Thứ 3). Ngày vắng mặt = không khóa. Agent vẫn chấp nhận hình dạng cũ `{"start", "end"}` (mọi ngày). |

**Ghi đè tạm thời** (không phải rule — là lệnh trong bảng `commands`, loại `temporary_override`, payload gồm `action`, `minutes`, `expires_at` ISO 8601). Lệnh mới nhất trên cùng một máy thay thế lệnh trước đó; hết hạn thì tự vô hiệu, kể cả khi Service khởi động lại (Agent lưu ghi đè vào SQLite local và kiểm tra hết hạn ở mỗi lần đánh giá rules):

| Hành động (`action`) | Tác dụng |
|---|---|
| `bonus_minutes` | Cộng `minutes` vào hạn mức giờ hôm nay; `expires_at` = hết ngày hôm nay. |
| `lock` | Khóa máy tới `expires_at` (hiệu lực `minutes` phút). |
| `unlock` | Tạm ngưng các quy tắc giờ giấc tới `expires_at` (hiệu lực `minutes` phút). |
| `cancel` | Hủy ghi đè đang hiệu lực (không cần `minutes`/`expires_at`). |

Thứ tự thi hành trong Agent: ghi đè (khóa/mở) → giờ ngủ → khung giờ → giới hạn ngày. Các loại quy tắc khác (theo app, website/domain, giờ học, nghỉ bắt buộc, cảnh báo chống phá, mẫu sẵn) thuộc các đợt tiếp theo theo thứ tự đã chốt với phụ huynh.

### 2.4. Chặn / cho phép app (App Rules)
- [ ] Danh sách app đã phát hiện trên máy con, phụ huynh Bật/Tắt: Cho phép / Chặn / Giới hạn theo app.
- [ ] Chặn theo: tên process, đường dẫn exe, publisher (khi có). Khi app bị chặn đang chạy -> kết thúc process + hiện thông báo lý do.
- [ ] Giới hạn theo app: VD: game tối đa 45 phút/ngày, YouTube app 30 phút/ngày.
- [ ] Chế độ Allowlist (chỉ cho phép app trong danh sách) — để giai đoạn 1.5, không bắt buộc cho MVP.

### 2.5. Lọc web — Phạm vi MVP (nói rõ giới hạn)
- [ ] Browser Extension cho Chrome/Edge (Manifest V3): chặn domain trong blocklist, chặn category người lớn (danh sách có sẵn), báo cáo domain đã thăm (chỉ domain, không full URL có tham số nhạy cảm).
- [ ] Blocklist/Allowlist do phụ huynh tự thêm (VD: chặn tiktok.com, cho phép hocmai.vn).
- [ ] DNS filtering dự phòng: hướng dẫn đặt DNS gia đình trên máy con (VD: Cloudflare for Families 1.1.1.3) — ghi rõ đây là lớp bổ sung, không thay extension.
- [ ] **Ngoài phạm vi MVP:** lọc HTTPS toàn hệ thống bằng MITM proxy, chặn VPN, chặn mọi trình duyệt lạ. Các mục này cần đánh giá riêng ở giai đoạn 2 vì rủi ro bảo mật/pháp lý và bị antivirus chặn.

### 2.6. Yêu cầu từ con & thông báo
- [ ] Con bấm "Xin thêm giờ" / "Xin mở app" từ màn hình khóa/tray, nhập lý do.
- [ ] Phụ huynh nhận yêu cầu trên Dashboard (Realtime), Duyệt/Từ chối + ghi chú.
- [ ] Agent nhận lệnh trong vòng < 30 giây khi online (polling 15s + Realtime khi có).

### 2.7. Báo cáo
- [ ] Báo cáo ngày/tuần: tổng giờ, giờ theo app, số lần bị chặn, số lần xin thêm giờ.
- [ ] Xuất CSV (giai đoạn 1.5).

## 3. Giai đoạn 2: App Android cho phụ huynh

- [ ] Đóng gói Dashboard PWA bằng Capacitor -> APK/AAB, thêm push notification (Supabase + FCM free).
- [ ] Hoặc xây Flutter app riêng nếu cần UX native tốt hơn — quyết định sau khi Dashboard Web ổn định.
- [ ] Tính năng: xem nhanh trạng thái máy (online/offline, còn bao nhiêu phút), khóa/mở nhanh, duyệt yêu cầu, đổi quy tắc cơ bản.

## 4. Giai đoạn 3: Nâng cao (chỉ làm khi giai đoạn 1-2 ổn định)

- [ ] Chụp màn hình theo lịch (opt-in, phụ huynh bật rõ ràng, ảnh mã hóa, tự xóa sau 7 ngày) — mặc định TẮT.
- [ ] Giới hạn theo website (thời gian cho từng domain).
- [ ] Nhiều con/nhiều máy, quy tắc theo nhóm tuổi.
- [ ] Cảnh báo nội dung nguy hiểm theo từ khóa trên tiêu đề cửa sổ (không đọc nội dung) — cần đánh giá quyền riêng tư kỹ.
- [ ] Báo cáo AI tóm tắt tuần (dùng API free/low-cost, dữ liệu đã ẩn danh hóa).

## 5. Không làm (Non-goals)

- Không ghi phím (keylogger), không đọc tin nhắn/email/file, không nghe mic/bật camera.
- Không quản lý điện thoại Android/iOS của con trong MVP (chỉ PC).
- Không thanh toán trong MVP.
- Không hỗ trợ macOS/Linux trong MVP.

## 6. Tiêu chí chấp nhận MVP (Definition of Done)

1. Cài Agent trên máy Windows Standard User, Agent tự chạy khi khởi động, không cần phụ huynh can thiệp.
2. Phụ huynh đặt giới hạn 30 phút, Agent khóa đúng giờ, con thấy lý do và xin thêm giờ được.
3. Chặn 1 app (VD: game) và 1 domain (qua extension) hoạt động đúng, có log.
4. Mất mạng 1 giờ, dữ liệu không mất, đồng bộ lại khi có mạng.
5. Con (Standard User) không tắt/gỡ được Agent nếu không có mã PIN phụ huynh.
6. Dashboard load < 2s, hiển thị đúng dữ liệu trong ngày.
