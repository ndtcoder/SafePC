# Roadmap & Quy trình làm việc — SafePC

## Lộ trình đề xuất (làm theo sprint 1-2 tuần, mỗi sprint có bản chạy được)

### Sprint 0 — Nền móng (1 tuần)
- [x] Đã chốt: tên app SafePC, Windows 10/11, backend Supabase (16/11/2026).
- [ ] Tạo repo private, cấu trúc monorepo, CI cơ bản (build + lint + scan secret).
- [ ] Tạo project Supabase Free, schema + RLS, seed data mẫu.
- [ ] Tạo project Vercel Free, deploy Dashboard khung (trang đăng nhập, layout).
- [ ] Design system v0 trong code (màu, font, component) — chưa cần Figma phức tạp. Figma Free tạo sau khi chốt luồng.

**Xong Sprint 0 khi:** Đăng nhập được, Dashboard deploy được, CI chạy xanh.

### Sprint 1 — Pairing + Usage Tracking
- [ ] Backend: families/children/devices, pairing code, device token.
- [ ] Agent: Service + Tray, heartbeat, ghi app foreground vào SQLite, đồng bộ lên Supabase.
- [ ] Dashboard: trang Thiết bị, trang Hôm nay (tổng giờ, top app).
- [ ] Installer thử nghiệm (Inno Setup) cài trên 1 máy Windows thật.

**Xong Sprint 1 khi:** Cài Agent lên máy thật, Dashboard thấy đúng app + thời gian đã dùng.

### Sprint 2 — Screen Time + Lock + Xin thêm giờ
- [ ] Rules: daily limit + bedtime, cảnh báo, màn hình khóa, LockWorkStation.
- [ ] Requests: con xin thêm giờ, phụ huynh duyệt/từ chối realtime.
- [ ] Commands: khóa ngay, mở thêm giờ từ xa.

**Xong Sprint 2 khi:** Test kịch bản hết giờ đầy đủ trên máy thật, không mất dữ liệu khi mất mạng.

### Sprint 3 — App Rules + Web Filtering (Extension)
- [ ] App blocklist/allowlist + giới hạn theo app.
- [ ] Extension Chrome/Edge MV3: blocklist domain + báo cáo domain.
- [ ] Dashboard: trang Quy tắc, trang Báo cáo tuần.

**Xong Sprint 3 khi:** Chặn được 1 app + 1 domain, có log, phụ huynh tự thêm/sửa được quy tắc.

### Sprint 4 — Cứng hóa + Beta gia đình
- [ ] Tamper resistance: PIN gỡ, watchdog, cảnh báo offline.
- [ ] Security checklist (docs/03) chạy đầy đủ, sửa lỗi Critical/High.
- [ ] QA: test trên 2 máy Windows khác nhau, test Standard User, test mất mạng, test khởi động lại.
- [ ] Tài liệu hướng dẫn cài đặt + Privacy Policy tiếng Việt.
- [ ] Beta: anh Tiến dùng thật 1-2 tuần, ghi lại lỗi/cải tiến.

### Giai đoạn 2 — Android cho phụ huynh
- [ ] Capacitor wrapper, push notification, màn hình nhanh (khóa/mở, duyệt yêu cầu).
- [ ] Build APK thử nghiệm, sau đó AAB lên Play Console (khi anh Tiến sẵn sàng, phí đăng ký Play Console 25 USD một lần — ngoài phạm vi free, để sau).

## Quy trình làm việc chung (áp cho mọi app của anh Tiến)

1. **Mỗi tính năng bắt đầu bằng 1 issue/mô tả ngắn:** làm gì, cho ai, xong thì kiểm tra thế nào.
2. **Branch:** `main` luôn chạy được. Tính năng làm trên branch riêng, merge qua Pull Request, CI phải xanh.
3. **Code review:** Trà My/em My tự kiểm tra theo checklist (bảo mật + lỗi + UX) trước khi báo xong. Anh Tiến kiểm tra bản chạy được, không cần đọc code.
4. **Không merge khi:** có secret trong code, test chính đỏ, RLS chưa kiểm tra, hoặc chưa test trên máy thật (đối với Agent).
5. **Release:** gắn tag version (v0.1.0...), ghi changelog tiếng Việt, giữ lại bản installer cũ để quay lại khi lỗi.

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
