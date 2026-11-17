# Roadmap & Quy trình làm việc — SafePC

## Trạng thái tổng quan (17/11/2026)

Chức năng chính (khóa/mở máy từ xa) đã kiểm chứng trên máy thật. Dashboard đã live. Còn lại: hoàn thiện Tray (PIN/xin giờ/xem giờ), kiểm chứng chặn domain đầu-cuối, báo cáo tuần, app Android, và flow cài đặt cho phụ huynh khác. Chi tiết từng hạng mục trong PRD (`01-PRD.md` mục 0).

## Lộ trình thực tế

### Sprint 0 — Nền móng ✅ (16/11/2026)
- [x] Đã chốt: tên app SafePC, Windows 10/11, backend Supabase.
- [x] Repo private `ndtcoder/SafePC`, cấu trúc monorepo, CI (build + scan secret + cổng kiểm tra).
- [x] Project Supabase Free, schema 12 bảng + RLS, 6 migration đã áp.
- [x] Project Vercel Free, Dashboard live tại `https://safe-pc.vercel.app`.
- [x] Tài khoản phụ huynh đầu tiên đã đăng ký/đăng nhập thành công.

### Sprint 1 — Pairing + Usage Tracking ✅ (16/11/2026)
- [x] Backend: families/children/devices, pairing code, device token (RPC SECURITY DEFINER).
- [x] Agent: Service + Tray, heartbeat, ghi app foreground vào SQLite, đồng bộ lên Supabase.
- [x] Dashboard: trang Thiết bị, trang Hôm nay.
- [x] Installer Inno Setup, đã cài và kiểm chứng trên máy Windows thật.

### Sprint 2 — Screen Time + Lock + Rules ✅ (16–17/11/2026)
- [x] Đợt 1: quy tắc giờ giấc (tổng giờ/ngày theo thứ, khung giờ, giờ ngủ) + ghi đè tạm thời.
- [x] Đợt 2: chặn domain qua extension MV3 + NativeHost + SafeSearch/YouTube Restricted (code xong, **chưa kiểm chứng đầu-cuối**).
- [x] Đợt 3: quy tắc theo app, giờ học tập trung, nghỉ bắt buộc, cảnh báo can thiệp, mẫu một chạm.
- [x] Bản sửa lỗi: báo cáo thi hành realtime, cứng hóa Tray + IPC, Dashboard gom theo con + đếm ngược mở khóa + xóa thiết bị.
- [x] Gốc rễ lỗi IPC (deadlock AutoFlush) đã tìm ra và sửa; cổng kiểm tra khóa/mở trên CI đã xanh; khóa/mở đã kiểm chứng trên máy thật (v0.1.136, 17/11/2026).
- [x] Tối ưu CI: job lọc thay đổi (đẩy không chạm code agent thì bỏ qua job Windows), cache NuGet + Inno Setup.
- [ ] Xin thêm giờ đầu-cuối (đang làm — xem đợt hiện tại).

### Đợt hiện tại — theo yêu cầu ngày 17/11/2026 🔨
- [ ] Khóa có độ trễ 0–5 phút + cửa sổ cảnh báo nhỏ + giao lệnh khóa theo phiên (đã đẩy code, đang chờ cổng kiểm tra CI, chưa kiểm chứng trên máy thật).
- [ ] PIN thoát Tray, xin thêm giờ đầu-cuối, xem giờ còn lại thật.
- [ ] Kiểm chứng chặn domain đầu-cuối: cài extension lên trình duyệt máy thật, sửa `allowed_origins` theo ID thật, thử chặn/cho phép thật.
- [ ] Rule mẫu URL có đường dẫn (`bing.com/videos`) bên cạnh rule domain.

### Sprint 4 — Cứng hóa + Beta gia đình ⏳
- [ ] Tamper resistance: PIN gỡ cài đặt, watchdog, cảnh báo offline.
- [ ] Security checklist (docs/03) chạy đầy đủ, sửa lỗi Critical/High.
- [ ] QA: test trên 2 máy Windows khác nhau, test Standard User, test mất mạng, test khởi động lại.
- [ ] Tài liệu hướng dẫn cài đặt + Privacy Policy tiếng Việt.
- [ ] Beta: anh Tiến dùng thật 1-2 tuần, ghi lại lỗi/cải tiến.
- [ ] Kiểm thử RLS truy cập chéo gia đình (2 tài khoản).

### Đề xuất đang thảo luận (chưa phê duyệt — ghi vào đây sau khi chốt)
- Tính năng nâng cao + giao diện chuyên nghiệp: đang đề xuất, thảo luận trước khi chuyển sang Android.
- Flow cài đặt đơn giản cho phụ huynh khác (không cần biết code): đang đề xuất.
- Báo cáo tuần (nội dung + biểu đồ): đang đề xuất.
- Các đề xuất sau khi phê duyệt sẽ thành mục theo dõi trong roadmap này và PRD.

### Giai đoạn 2 — Android cho phụ huynh ⏳
- [ ] Thảo luận sau khi chốt tính năng nâng cao (theo yêu cầu 17/11/2026).
- [ ] Capacitor wrapper, push notification, màn hình nhanh (khóa/mở, duyệt yêu cầu).
- [ ] Build APK thử nghiệm, sau đó AAB lên Play Console (khi anh Tiến sẵn sàng, phí đăng ký Play Console 25 USD một lần — ngoài phạm vi free, để sau).

## Quy trình làm việc chung (áp cho mọi app của anh Tiến)

1. **Mỗi tính năng bắt đầu bằng 1 mô tả ngắn:** làm gì, cho ai, xong thì kiểm tra thế nào.
2. **Nhánh:** `main` luôn chạy được. Đẩy code qua giao diện web GitHub theo từng đợt (Git Trees API và SSH git đều bị chặn từ môi trường làm việc); commit trung gian trong một đợt đẩy có thể đỏ, chỉ trạng thái của commit đầu (head) mới quyết định.
3. **Code review:** mỗi đợt sửa có 1 reviewer độc lập (agent nền) kiểm tra trước khi đẩy; anh Tiến kiểm tra bản chạy được trên máy thật, không cần đọc code. Lỗi trên máy thật được sửa theo log/ảnh chụp anh gửi.
4. **Không báo xong khi:** có secret trong code, cổng kiểm tra CI đỏ, hoặc tính năng khóa/mở chưa qua cổng kiểm tra CI (yêu cầu từ 17/11/2026: khóa/mở phải test kỹ trước khi gửi bản).
5. **Release:** phiên bản `0.1.<số run CI>`; installer đính kèm theo run CI xanh; giữ lại bản installer cũ để quay lại khi lỗi. Migration Supabase do anh Tiến paste + chạy (trình duyệt tự động không paste được vào SQL Editor), có kiểm tra độ trung thực trước khi chạy.

## Checklist QA trước mỗi release

- [ ] Luồng chính chạy được từ đầu tới cuối trên bản build mới (không chỉ trên máy dev).
- [ ] Trạng thái rỗng / loading / lỗi / mất mạng đều có giao diện rõ ràng.
- [ ] Kiểm tra trên 2 kích thước màn hình (laptop 14" + màn hình lớn) và 2 trình duyệt (Chrome + Edge).
- [ ] Agent: khởi động lại máy vẫn chạy, Standard User không tắt/gỡ được, mất mạng vẫn thi hành quy tắc.
- [ ] Không có lỗi Critical trong dependency scan và secret scan.
- [ ] Changelog + hướng dẫn cập nhật đã viết.

## Ước lượng (tham khảo, không phải cam kết)

- Sprint 0-3: mỗi sprint cần anh Tiến dành ~2-3 giờ/tuần để chốt thiết kế + test trên máy thật. Phần code do Trà My/em My làm chính, anh Tiến không cần code.
- Rủi ro lớn nhất: tích hợp sâu Windows (chặn app, khóa máy) cần test trên máy thật nhiều lần, không thể kiểm tra hết bằng máy ảo. Cần 1 máy Windows thật của con (hoặc máy test) từ Sprint 1.
- Chi phí: 0 đồng cho tới khi quyết định mua domain / Play Console / Code Signing. Supabase/Vercel/GitHub Free đủ cho <100 user nếu giữ dữ liệu gọn (tổng hợp 90 ngày).
