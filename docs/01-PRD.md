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
- [ ] Giới hạn tổng thời gian/ngày theo thứ trong tuần (VD: T2-T6: 2h, T7-CN: 3h).
- [ ] Lịch giờ ngủ / giờ cấm (VD: 21:30-07:00 không dùng máy).
- [ ] Cảnh báo trước 15/5/1 phút khi sắp hết giờ.
- [ ] Khi hết giờ: hiển thị màn hình khóa toàn màn hình, khóa phiên làm việc (LockWorkStation), không tắt máy đột ngột làm mất bài làm — lưu ý: khóa sau khi lưu cảnh báo.
- [ ] Phụ huynh có thể "Khóa ngay" / "Mở thêm 15/30/60 phút" từ xa.

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
