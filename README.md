# SafePC — Quy hoạch dự án (Bản nháp v0.1)

**Ngày tạo:** 16/11/2026
**Chủ dự án:** Anh Tiến (Hà Nội)
**Mục tiêu:** App quản lý máy tính của con, tương tự Microsoft Family Safety / Google Family Link, ưu tiên PC trước, sau đó thêm Android cho phụ huynh.
**Quy mô:** Dưới 100 user, dùng dịch vụ free.
**Trạng thái:** Đã chốt ngày 16/11/2026 — Tên app SafePC, backend Supabase, máy con Windows 10 (tương thích cả Windows 11). Đang ở Sprint 0.

## 1. Tóm tắt sản phẩm

Phụ huynh cài 1 Agent lên máy tính của con (Windows). Agent theo dõi thời gian dùng máy, chặn app/web theo quy tắc, khóa máy khi hết giờ. Phụ huynh xem báo cáo và đổi quy tắc từ Dashboard Web/PWA, sau đó là app Android.

**Nguyên tắc quan trọng:**
- Đây là công cụ của phụ huynh cho máy tính trong gia đình mình. Con dùng tài khoản Standard User, không có quyền Admin.
- Chỉ thu thập metadata tối thiểu: tên app, thời lượng, tên miền web, thời điểm. Không ghi phím, không đọc nội dung chat/file, không quay màn hình mặc định.
- Mọi hành động chặn/khóa đều hiển thị lý do rõ ràng cho con, có nút "Xin thêm giờ".

## 2. Tài liệu trong thư mục docs/

- `01-PRD.md` — Yêu cầu chi tiết, MVP và các giai đoạn
- `02-ARCHITECTURE.md` — Kiến trúc hệ thống, luồng dữ liệu, lựa chọn công nghệ
- `03-SECURITY.md` — Mô hình bảo mật cho dữ liệu nhạy cảm, checklist OWASP
- `04-ROADMAP.md` — Lộ trình, tiêu chí hoàn thành từng giai đoạn, checklist QA/Release

## 3. Quyết định đã chốt

1. **Tên app:** SafePC.
2. **Hệ điều hành máy con:** Windows 10 64-bit (máy hiện tại), yêu cầu tương thích cả Windows 11 64-bit. Agent sẽ target .NET 8 và chỉ dùng API có trên cả Windows 10 và 11.
3. **Backend:** Supabase Free (Postgres + Auth + Realtime + Storage).
4. **Dashboard phụ huynh:** React + TypeScript + Vite, PWA, host Vercel Free. Giai đoạn 2 đóng gói Android bằng Capacitor (dùng chung code web).
5. **PC Agent:** C# .NET 8 (Windows Service + Tray App). Lý do: tích hợp sâu Windows, ổn định, dễ chống gỡ.
6. **Domain/Figma:** Chưa cần mua domain. Dùng subdomain free của Vercel/Supabase. Figma dùng gói Free Starter, thiết kế sau khi chốt luồng chính.

## 4. Cấu trúc repo dự kiến (monorepo)

```
safepc/
  apps/
    pc-agent/        # C# .NET 8: Service + Tray + Installer
    dashboard-web/   # React + TS + Vite PWA
    parent-android/  # Giai đoạn 2: Capacitor wrapper / Flutter (quyết sau)
  packages/
    shared-types/    # Type contract dùng chung
  backend/
    supabase/        # migrations, RLS policies, edge functions
  docs/              # PRD, kiến trúc, bảo mật, roadmap
  .github/workflows/ # CI: build, test, scan
```

## 5. Ghi chú về giới hạn kỹ thuật (cần nói rõ từ đầu)

- Google Family Link không quản lý được Windows PC. Microsoft Family Safety lọc web đầy đủ chủ yếu trên Edge. App tự làm cũng có giới hạn tương tự nếu chỉ dựa vào browser.
- Lọc web toàn hệ thống "mọi trình duyệt, mọi app" ở mức chuyên nghiệp cần driver/proxy hệ thống, rất phức tạp và dễ bị antivirus chặn. MVP sẽ làm theo hướng thực tế: Browser Extension (Chrome/Edge) + chặn app + DNS filtering + chính sách Windows, và ghi rõ phạm vi.
- Chống gỡ/tắt Agent 100% là không thể nếu con có quyền Admin. Giải pháp là: con dùng Standard User + Service chạy quyền SYSTEM + bảo vệ bằng mã PIN của phụ huynh + cảnh báo khi Agent offline.
