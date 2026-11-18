# SafePC — Quản lý máy tính của con

**Ngày tạo:** 16/11/2026
**Chủ dự án:** Anh Tiến (Hà Nội)
**Mục tiêu:** App quản lý máy tính của con, tương tự Microsoft Family Safety / Google Family Link, ưu tiên PC trước, sau đó thêm Android cho phụ huynh.
**Quy mô:** Dưới 100 user, dùng dịch vụ free.

## Trạng thái hiện tại (18/11/2026)

- **Dashboard đã live:** https://safe-pc.vercel.app (Vercel Free, deploy tự động từ `main`).
- **Backend:** Supabase Free (project SafePC, region Singapore). Đã áp 9 migration: schema 12 bảng + RLS, RPC thiết bị, web usage, cảnh báo can thiệp, báo cáo thi hành, PIN + yêu cầu xin giờ, gỡ PIN dùng một lần, tên rule + bảng rule_templates (migration 8 + 9 áp sáng 18/11/2026).
- **PC Agent:** C# .NET 8 (Service + Tray + NativeHost), bộ cài Inno Setup do CI đóng gói (phiên bản `0.1.<số run CI>`). **Khóa/mở máy từ Dashboard đã kiểm chứng trên máy thật** (bản v0.1.136, ngày 17/11/2026). Test tối 17/11 đã xác nhận thêm: khóa có độ trễ + khóa theo phiên (kể cả đường Limited-token), PIN thoát chỉ dùng một lần. Test sáng 18/11 đã xác nhận: chặn domain qua extension 0.1.2 (YouTube không xem được nữa), chặn app / mẫu Chỉ cho phép Edge (Chrome cài bằng quyền user của con bị đóng + hộp cảnh báo), đăng nhập lại khi đang khóa thì khóa ngay không đếm ngược. Bản mới nhất **v0.1.183** (CI run #183 xanh: Tray 19/19, Service IPC 13/13) gồm chặn theo đường dẫn URL (extension 0.1.3), khóa do phụ huynh bấm thì khóa ngay không đếm ngược, thẻ thiết bị hết xung đột khóa/mở, snapshot thi hành đẩy ngay khi đổi — đang chờ kiểm chứng trên máy thật. Quy tắc giờ giấc, theo app, giờ học tập trung, nghỉ bắt buộc, cảnh báo can thiệp và báo cáo thi hành đã triển khai; xem chi tiết trong `docs/01-PRD.md` và `docs/04-ROADMAP.md`.
- **Đang làm tiếp:** kiểm chứng bản v0.1.183 + extension 0.1.3 trên máy thật (rule đường dẫn, Khóa ngay không đếm ngược, thẻ thiết bị); kiểm chứng giao diện Quy tắc mới trên điện thoại thật.
- **Chưa làm:** app Android cho phụ huynh; các hạng mục đã phê duyệt ngày 17/11/2026 (tính năng nâng cao + giao diện chuyên nghiệp, flow cài đặt cho phụ huynh khác, báo cáo tuần) — thực hiện dần, xem `docs/01-PRD.md` §2.8–2.10 và `docs/04-ROADMAP.md`.

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

## 4. Cấu trúc repo (monorepo)

```
safepc/
  apps/
    pc-agent/        # C# .NET 8: Service + Tray + NativeHost + Installer (Inno Setup)
    dashboard-web/   # React + TS + Vite PWA (deploy Vercel)
    browser-extension/ # Extension MV3: lọc domain, báo cáo lượt thăm
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

## 6. CI (GitHub Actions)

Workflow `.github/workflows/ci.yml` chạy trên mỗi lần đẩy lên `main`:
- `docs-check`: kiểm tra tài liệu bắt buộc và quét secret cơ bản.
- `build-dashboard`: build Dashboard (Vite).
- `build-agent`: build + publish Agent trên Windows, chạy tự kiểm tra giao diện Tray và cổng kiểm tra khóa/mở (IPC), đóng gói bộ cài Inno Setup, tải lên artifact `SafePCAgentSetup`.

Để CI chạy nhanh:
- Job `changes` xác định lần đẩy có chạm code agent (`apps/pc-agent/`) hoặc chính workflow không; nếu không, job Windows được bỏ qua và run xong trong khoảng 30 giây.
- Gói NuGet được cache theo file `.csproj`; thư mục cài Inno Setup được cache để khỏi cài lại mỗi lần (tăng số trong khóa cache để ép dùng bản mới).
- Phiên bản bản cài là `0.1.<số run CI>` — không tách workflow vì số run tính theo từng workflow.
