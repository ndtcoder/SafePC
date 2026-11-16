# SafePC Dashboard (Web/PWA)

Dashboard cho phụ huynh: xem báo cáo, đặt quy tắc, khóa/mở máy, duyệt yêu cầu.

**Stack:** React 18 + TypeScript + Vite + Tailwind CSS v3, PWA, host Vercel Free.
**Router:** react-router-dom v6 (BrowserRouter; SPA fallback cấu hình trong `vercel.json`).
**Backend:** Supabase (Postgres + Auth + RLS). Schema nguồn sự thật: `backend/supabase/migrations/20261116102900_init_safepc.sql`.

## Trạng thái — Sprint 0 (khung chạy được, chưa có Supabase thật)

- [x] Khởi tạo Vite + React 18 + TypeScript + Tailwind v3, build xanh (`npm run build`).
- [x] Trang Đăng nhập: email/mật khẩu qua Supabase Auth (đăng nhập, đăng ký, quên mật khẩu), thông báo lỗi tiếng Việt, đăng xuất.
- [x] Layout chung: sidebar/topbar, tên SafePC, hiển thị email + nút đăng xuất.
- [x] Trang Hôm nay (`/hom-nay`): tổng thời lượng, top ứng dụng, hoạt động mới nhất — tính từ dữ liệu `app_usage` thật.
- [x] Trang Thiết bị (`/thiet-bi`): liệt kê `devices`, trạng thái online/offline/locked, nút “Khóa ngay” (tạo command `lock_now`), form tạo hồ sơ con tối thiểu, hướng dẫn ghép nối.
- [x] Trang Quy tắc (`/quy-tac`): liệt kê `rules` theo loại + config JSONB trình bày dễ đọc, bật/tắt, thêm rule `daily_limit`.
- [x] Trang Yêu cầu (`/yeu-cau`): liệt kê `requests` (chờ duyệt trước), Duyệt/Từ chối kèm `decided_at`.
- [x] PWA cơ bản: `manifest.webmanifest` + icon SVG + meta `theme-color`. Service worker đầy đủ và icon PNG 192/512 làm sau — Sprint 0 chỉ cần manifest + shell cài đặt được.
- [ ] Chưa kiểm chứng với Supabase project thật (chưa có project): đăng nhập và dữ liệu thật chưa được test end-to-end.
- [ ] Chưa deploy Vercel.
- [ ] Ghép nối (pairing code thật) cần Edge Function — thuộc Sprint 1, hiện chỉ có hướng dẫn và nút bị vô hiệu hoá.
- [ ] Form sửa/xoá quy tắc bedtime/app/website đầy đủ — Sprint tiếp theo (hiện có bật/tắt + thêm daily_limit).

## Khi chưa cấu hình Supabase

App **không crash và không dùng dữ liệu giả**. Nếu thiếu `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (hoặc vẫn là placeholder trong `.env.example`):

- Mọi trang hiển thị trạng thái “Chưa cấu hình Supabase” kèm hướng dẫn.
- Form đăng nhập bị vô hiệu hoá kèm giải thích, không gọi API giả.
- Mọi trang đều có 3 trạng thái rõ ràng: đang tải / rỗng / lỗi (kể cả lỗi mạng).

## Cấu hình

```bash
cp .env.example .env
# Điền giá trị thật vào .env (lấy từ Supabase Dashboard > Project Settings > API).
# Chỉ dùng anon key ở client. KHÔNG commit file .env, KHÔNG dùng service_role key ở trình duyệt.
```

Trước đó, tạo project Supabase và chạy migration trong `backend/supabase/migrations/` (Supabase Dashboard > SQL Editor hoặc Supabase CLI).

## Chạy và build

```bash
npm install
npm run dev     # chạy local (Vite)
npm run build   # kiểm tra TypeScript + build production (ra thư mục dist/)
npm run preview # xem trước bản production đã build
```

## Cấu trúc

```
apps/dashboard-web/
  index.html                 # lang="vi", theme-color, link manifest
  public/
    manifest.webmanifest     # PWA manifest (tiếng Việt, standalone)
    favicon.svg
    icons/icon.svg           # icon chính (SVG)
    icons/icon-maskable.svg  # icon maskable (SVG)
  src/
    main.tsx                 # BrowserRouter + AuthProvider
    App.tsx                  # routes + bảo vệ route khi đã cấu hình Supabase
    index.css                # Tailwind v3 directives
    lib/
      supabase.ts            # client Supabase (null khi chưa cấu hình)
      types.ts               # kiểu dữ liệu khớp migration
      format.ts              # định dạng tiếng Việt, mô tả config rule, dịch lỗi
      family.ts              # lấy/tạo gia đình của user hiện tại
    context/AuthContext.tsx  # phiên đăng nhập Supabase Auth
    components/
      Layout.tsx             # sidebar/topbar + footer
      ui.tsx                 # trạng thái loading/rỗng/lỗi/chưa cấu hình, form controls
    pages/
      LoginPage.tsx          # /dang-nhap
      TodayPage.tsx          # /hom-nay
      DevicesPage.tsx        # /thiet-bi (+ form tạo hồ sơ con)
      RulesPage.tsx          # /quy-tac
      RequestsPage.tsx       # /yeu-cau
  .env.example               # CHỈ placeholder, không chứa key thật
  vercel.json                # SPA fallback cho Vercel
```

## Lưu ý bảo mật

- Không hardcode URL/key Supabase trong code; chỉ đọc từ biến môi trường `VITE_*`.
- Không dùng `dangerouslySetInnerHTML` với dữ liệu người dùng; React tự escape khi render text/JSON.
- Không log token hay mật khẩu.
- Dữ liệu nhạy cảm được bảo vệ bằng RLS theo `family_id` phía Supabase; Dashboard chỉ dùng anon key.
