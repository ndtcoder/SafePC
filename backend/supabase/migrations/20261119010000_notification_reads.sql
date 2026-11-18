-- SafePC — Migration 20: mốc "đã đọc" thông báo trong Dashboard
-- Ngày: 19/11/2026. Áp dụng qua Dashboard > SQL Editor (như migration 1-19),
-- chạy một lần, kiểm chứng bằng truy vấn ở cuối file (ghi chú).
--
-- Bối cảnh: mục Thông báo trong Dashboard (chuông ở header + trang
-- /thong-bao) hiện cùng 3 nguồn sự kiện với email thông báo (migration
-- 12): yêu cầu còn chờ duyệt, cảnh báo can thiệp, máy offline quá 48 giờ.
-- Mỗi phụ huynh có một mốc "đã đọc" riêng: sự kiện mới hơn mốc thì tính
-- là chưa đọc và hiện huy hiệu đỏ ở chuông; bấm "Đánh dấu tất cả đã đọc"
-- thì mốc nhảy tới thời điểm hiện tại. Push notification để sau, cùng
-- app Android (PRD §2.6).
--
-- Migration này chỉ tạo MỘT bảng, không hàm, không lịch:
-- notification_reads: một hàng cho mỗi user, khóa chính user_id. RLS
-- bật, mỗi user chỉ đọc/ghi được đúng hàng của mình (auth.uid()).
-- Dashboard upsert trực tiếp qua PostgREST, không cần RPC.
--
-- Chạy lại an toàn: CREATE TABLE IF NOT EXISTS + DROP POLICY IF EXISTS.
-- Không có câu INSERT dữ liệu mẫu nào.

-- ============ Bảng mốc đã đọc ============
-- user_id tham chiếu auth.users như family_members (migration 1): xóa
-- tài khoản thì hàng mốc đọc của tài khoản đó cũng bị xóa theo.
create table if not exists public.notification_reads (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- Mốc "đã đọc": sự kiện có thời điểm mới hơn mốc này thì tính là chưa
  -- đọc. Mặc định now() để hàng tạo tay (không qua Dashboard) không làm
  -- toàn bộ lịch sử 30 ngày hiện thành chưa đọc.
  read_at timestamptz not null default now()
);

alter table public.notification_reads enable row level security;

-- Mỗi user chỉ thấy hàng của chính mình: đọc chéo mốc của phụ huynh
-- khác trong cùng gia đình cũng bị chặn (mốc đọc là trạng thái riêng
-- tư của từng người, không phải dữ liệu gia đình).
drop policy if exists "own row read" on public.notification_reads;
create policy "own row read" on public.notification_reads
  for select using (auth.uid() = user_id);

-- Upsert qua PostgREST cần cả INSERT lẫn UPDATE: lần đầu tạo hàng,
-- lần sau cập nhật khi đã có hàng (on conflict user_id).
drop policy if exists "own row insert" on public.notification_reads;
create policy "own row insert" on public.notification_reads
  for insert with check (auth.uid() = user_id);

drop policy if exists "own row update" on public.notification_reads;
create policy "own row update" on public.notification_reads
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

--- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ============
--- select column_name, data_type from information_schema.columns
--- where table_name = 'notification_reads' order by ordinal_position;
--- Kỳ vọng 2 dòng: user_id, uuid; read_at, timestamp with time zone.
--- select relrowsecurity from pg_class where relname = 'notification_reads';
--- Kỳ vọng: true (RLS bật).
--- select policyname, cmd from pg_policies where tablename = 'notification_reads' order by policyname;
--- Kỳ vọng 3 dòng: own row insert (INSERT), own row read (SELECT), own row update (UPDATE).
--- select grantee, privilege_type from information_schema.table_privileges
--- where table_name = 'notification_reads' order by grantee, privilege_type;
--- Kỳ vọng: chỉ các role mặc định của project (postgres, anon, authenticated,
--- service_role) có quyền ở tầng GRANT — việc chặn đọc chéo user khác là nhờ
--- 3 policy RLS ở trên, không nhờ GRANT. Muốn chắc chắn thì đăng nhập bằng
--- tài khoản phụ huynh thứ hai và SELECT bảng này: chỉ thấy đúng hàng của mình.
