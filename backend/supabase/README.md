# SafePC Backend (Supabase)

**Stack:** Supabase Free — Postgres + Auth + Realtime + Storage + Edge Functions.

**Trạng thái (16/11/2026): project Supabase SafePC ĐÃ tạo (gói Free, region
Singapore).** Migration CHƯA áp dụng, Edge Function chưa deploy, RLS chưa kiểm
chứng trên project thật. Các bước dưới đây áp migration lần đầu lên project
đã tạo.

Tài liệu liên quan: `../../docs/02-ARCHITECTURE.md` (mục 3: mô hình dữ liệu,
mục 4.1: pairing) và `../../docs/03-SECURITY.md` (RLS theo `family_id`, chỉ lưu
hash token/PIN/mã, chỉ lưu domain không lưu full URL).

## Cấu trúc

```
backend/supabase/
  migrations/
    20261116102900_init_safepc.sql   # Schema + RLS (12 bảng, 14 policy)
  functions/
    pair-device/index.ts             # Edge Function stub đổi pairing code -> device token
  README.md                          # File này
  RLS_TESTING.md                     # Các ca kiểm thử RLS phải chạy sau khi áp migration
```

## Quy tắc bắt buộc

- Mọi bảng đều bật RLS, ranh giới là `family_id`. Không tắt RLS để "cho chạy
  được" — nếu query bị chặn, xem lại policy và `RLS_TESTING.md`.
- **Không commit service_role key** (key này bypass RLS). Chỉ dùng trong Edge
  Function qua biến môi trường của Supabase, không bao giờ đưa vào code,
  Dashboard hay Agent.
- **Anon key chỉ dùng ở client (Dashboard) + RLS.** Anon key không vượt được
  RLS; mọi truy vấn từ Dashboard đều bị giới hạn trong gia đình của user đăng
  nhập.
- Chỉ lưu hash của device token / pairing code, chỉ lưu domain (không full
  URL), hash đường dẫn exe — xem `docs/03-SECURITY.md` mục 3.
- Migration đặt tên theo ngày: `YYYYMMDDHHMMSS_ten_migration.sql`. Không sửa
  migration đã áp dụng lên project thật — tạo migration mới thay thế.

## Cách 1 (chính): áp migration qua Supabase Dashboard > SQL Editor

Dùng cách này cho lần áp migration đầu tiên lên project đã tạo, khi chưa quen
Supabase CLI.

1. Mở project SafePC tại https://supabase.com/dashboard (đăng nhập bằng tài
   khoản GitHub của anh Tiến). Kiểm tra **Project URL** và **anon key** trong
   Settings > API — anon key dùng cho Dashboard, còn service_role key chỉ
   dùng cho Edge Function (xem mục Quy tắc). Không tạo project thứ hai; mọi
   bước dưới đây làm trên project SafePC này.
2. Trong Dashboard của project, mở **SQL Editor** > **New query**.
3. Mở file `migrations/20261116102900_init_safepc.sql` trong repo, copy toàn
   bộ nội dung, dán vào khung SQL Editor.
4. Bấm **Run**. Kết quả mong đợi: `Success. No rows returned.` (migration chỉ
   tạo bảng/hàm/policy, không trả về dữ liệu).
5. Kiểm tra trong **Table Editor**: đủ 12 bảng — `families`, `family_members`,
   `children`, `devices`, `device_tokens`, `pairing_codes`, `rules`,
   `app_usage`, `web_visits`, `requests`, `commands`, `audit_logs`.
6. Kiểm tra RLS và policy bằng SQL Editor (dán từng câu, bấm Run):
   ```sql
   -- Mọi bảng đều bật RLS: 12 dòng, tất cả rls_enabled = true
   select c.relname as table_name, c.relrowsecurity as rls_enabled
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
   order by c.relname;

   -- Đủ 14 policy (11 FOR ALL + 3 SELECT)
   select tablename, policyname, cmd
   from pg_policies
   where schemaname = 'public'
   order by tablename, policyname;
   ```
7. Kiểm tra 2 hàm helper tồn tại (dùng trong policy):
   ```sql
   select proname from pg_proc
   where proname in ('is_family_member', 'is_family_owner');
   -- Mong đợi: 2 dòng
   ```
8. Chạy các ca kiểm thử trong `RLS_TESTING.md` với 2 tài khoản test trước khi
   cho Dashboard/Agent kết nối thật.

**Nếu chạy lại migration trên cùng project:** `CREATE TABLE` sẽ lỗi "already
exists", `CREATE POLICY` sẽ lỗi "already exists" (chỉ `CREATE OR REPLACE
FUNCTION` là chạy lại được). Đây là hành vi bình thường — migration này chỉ
chạy 1 lần trên project này. Muốn chạy lại từ đầu thì xóa các bảng/policy đã
tạo trước.

## Cách 2 (ngắn): Supabase CLI

Chỉ dùng khi đã quen CLI và đã liên kết project (`supabase link`). Từ thư mục
gốc của repo:

```bash
supabase db push
```

CLI sẽ áp các file trong `backend/supabase/migrations/` theo thứ tự thời gian.
Cách này yêu cầu đã cài Supabase CLI và đã `supabase link --project-ref <ref>`.
Với lần áp đầu tiên, Cách 1 (SQL Editor) đơn giản và dễ kiểm tra hơn.

## Seed dữ liệu — chỉ làm SAU KHI có tài khoản phụ huynh thật

**Chưa seed gì cả.** `families.owner_id` phải là `auth.users.id` thật của tài
khoản phụ huynh đã đăng ký qua Supabase Auth — không seed owner giả. Sau khi
tài khoản phụ huynh đầu tiên được tạo (đăng ký qua Dashboard hoặc
Authentication > Users), mới seed 1 gia đình + 1 con + 1 rule mẫu, bằng 1
migration seed riêng hoặc thao tác trên Dashboard.

Lưu ý luồng khởi tạo: sau khi tạo `families`, owner phải tự thêm mình vào
`family_members` với `role = 'parent'` thì mới tạo được `children`, `rules`,
... vì các policy "family access" yêu cầu `is_family_member(family_id)`.
(Dashboard Sprint 1 cần thực hiện 2 bước này liền nhau khi tạo gia đình mới.)

## Edge Functions

Thư mục `functions/` chứa các Edge Function (Deno). Hiện chỉ có stub
`pair-device` (Sprint 1, chưa deploy, chưa kiểm chứng) — xem
`functions/pair-device/README.md`. Deploy sau khi migration đã áp dụng:

```bash
supabase functions deploy pair-device
```

Edge Function đọc `SUPABASE_URL` và `SUPABASE_SERVICE_ROLE_KEY` từ biến môi
trường do Supabase cấp sẵn — không hardcode key vào code.
