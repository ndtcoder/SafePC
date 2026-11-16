-- SafePC — Sprint 0 schema (DRAFT, chưa áp dụng)
-- Mục đích: tạo schema + RLS cho project Supabase Free, theo
-- docs/02-ARCHITECTURE.md mục 3 (mô hình dữ liệu) và
-- docs/03-SECURITY.md mục 2 (RLS theo family_id, chỉ lưu hash token/PIN/mã).
-- Trạng thái (16/11/2026): project Supabase SafePC ĐÃ tạo (gói Free), nhưng
-- migration này CHƯA áp dụng và chưa kiểm chứng trên project thật. Áp dụng
-- theo hướng dẫn trong backend/supabase/README.md (Supabase Dashboard >
-- SQL Editor, hoặc Supabase CLI: supabase db push).
-- Lưu ý thiết kế: app_usage / web_visits / requests / commands có thêm cột
-- family_id (không có trong sơ đồ rút gọn) để RLS kiểm tra trực tiếp theo
-- family_id thay vì JOIN qua devices/children mỗi lần truy vấn.
-- Sửa đổi Sprint 1 (16/11/2026, vẫn CHƯA áp dụng lên project):
-- chuyển 2 hàm helper xuống sau CREATE TABLE (tránh lỗi "relation does not
-- exist" lúc tạo hàm), thêm WITH CHECK tường minh cho mọi policy FOR ALL,
-- cố định search_path cho hàm SECURITY DEFINER. Không đổi tên bảng/cột.

-- Lưu ý: 2 hàm helper is_family_member / is_family_owner PHẢI khai báo SAU
-- khi tạo bảng (xem mục "Helpers" phía dưới, ngay trước phần RLS), vì hàm
-- LANGUAGE SQL được Postgres kiểm tra thân hàm lúc tạo và sẽ lỗi
-- "relation does not exist" nếu bảng family_members / families chưa tồn tại.

-- ============ families / family_members ============
create table public.families (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null default 'Gia đình',
  created_at timestamptz not null default now()
);

create table public.family_members (
  family_id uuid not null references public.families (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('parent', 'child')),
  created_at timestamptz not null default now(),
  primary key (family_id, user_id)
);

-- ============ children / devices ============
create table public.children (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  display_name text not null,
  birth_year int check (birth_year between 2000 and 2030),
  avatar_url text,
  created_at timestamptz not null default now()
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  child_id uuid references public.children (id) on delete set null,
  hostname text not null,
  os_version text,          -- vd: 'Windows 10 22H2' / 'Windows 11 24H2'
  agent_version text,
  last_seen_at timestamptz,
  status text not null default 'offline'
    check (status in ('online', 'offline', 'locked')),
  created_at timestamptz not null default now()
);

-- Chỉ lưu HASH của token, không lưu token thô (docs/03-SECURITY.md mục 2).
create table public.device_tokens (
  device_id uuid primary key references public.devices (id) on delete cascade,
  token_hash text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- Mã pairing 6 số: chỉ lưu hash, hết hạn 10 phút, dùng 1 lần, tối đa 5 lần thử.
create table public.pairing_codes (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  child_id uuid references public.children (id) on delete set null,
  code_hash text not null,
  attempts int not null default 0 check (attempts <= 5),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============ rules / usage / web visits ============
create table public.rules (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  child_id uuid not null references public.children (id) on delete cascade,
  type text not null
    check (type in ('daily_limit', 'bedtime', 'app', 'website')),
  config jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.app_usage (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  child_id uuid not null references public.children (id) on delete cascade,
  app_name text not null,
  exe_path_hash text,       -- hash đường dẫn, tránh lộ username Windows
  started_at timestamptz not null,
  duration_sec int not null default 0 check (duration_sec >= 0),
  created_at timestamptz not null default now()
);

create index app_usage_family_child_idx
  on public.app_usage (family_id, child_id, started_at desc);

-- Chỉ lưu domain, cắt bỏ path/query (docs/03-SECURITY.md mục 3).
create table public.web_visits (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  child_id uuid not null references public.children (id) on delete cascade,
  domain text not null,
  visited_at timestamptz not null,
  blocked boolean not null default false,
  created_at timestamptz not null default now()
);

create index web_visits_family_child_idx
  on public.web_visits (family_id, child_id, visited_at desc);

-- ============ requests / commands / audit_logs ============
create table public.requests (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  child_id uuid not null references public.children (id) on delete cascade,
  type text not null check (type in ('extra_time', 'unblock_app')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied')),
  reason text,
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.commands (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  type text not null
    check (type in ('lock_now', 'unlock', 'refresh_rules', 'update')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'done', 'failed')),
  created_at timestamptz not null default now()
);

create index commands_device_status_idx
  on public.commands (device_id, status, created_at);

-- Chỉ lưu hash IP, không lưu IP thô quá 30 ngày (docs/03-SECURITY.md mục 3).
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  actor uuid references auth.users (id),
  action text not null,
  target text,
  ip_hash text,
  created_at timestamptz not null default now()
);

create index audit_logs_family_idx
  on public.audit_logs (family_id, created_at desc);

-- ============ Helpers: kiểm tra tư cách thành viên gia đình ============
-- Đặt SAU tất cả CREATE TABLE (xem lưu ý ở đầu file): hàm LANGUAGE SQL tham
-- chiếu tới public.family_members / public.families nên 2 bảng này phải tồn
-- tại trước khi tạo hàm, và hàm phải tồn tại trước các policy bên dưới.
-- Hàm chạy SECURITY DEFINER nên không bị RLS của chính bảng
-- family_members/families chặn (tránh đệ quy); SET search_path cố định để
-- tránh tấn công qua search_path khi chạy với quyền của người tạo hàm.
create or replace function public.is_family_member(p_family_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.family_members fm
    where fm.family_id = p_family_id
      and fm.user_id = auth.uid()
  );
$$;

create or replace function public.is_family_owner(p_family_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.families f
    where f.id = p_family_id
      and f.owner_id = auth.uid()
  );
$$;

-- ============ RLS: bật trên mọi bảng, ranh giới là family_id ============
alter table public.families        enable row level security;
alter table public.family_members  enable row level security;
alter table public.children        enable row level security;
alter table public.devices         enable row level security;
alter table public.device_tokens   enable row level security;
alter table public.pairing_codes   enable row level security;
alter table public.rules           enable row level security;
alter table public.app_usage       enable row level security;
alter table public.web_visits      enable row level security;
alter table public.requests        enable row level security;
alter table public.commands        enable row level security;
alter table public.audit_logs      enable row level security;

-- families: chủ sở hữu toàn quyền; thành viên chỉ được đọc.
-- Mọi policy FOR ALL đều ghi tường minh cả USING (SELECT/UPDATE/DELETE) và
-- WITH CHECK (INSERT/UPDATE) để không phụ thuộc vào hành vi mặc định của
-- Postgres (thiếu WITH CHECK thì USING được dùng thay).
create policy "owner full access" on public.families
  for all using (owner_id = auth.uid())
  with check (owner_id = auth.uid());
create policy "members read" on public.families
  for select using (public.is_family_member(id));

-- family_members: thành viên trong gia đình được đọc; chỉ owner thêm/xóa.
-- Luồng khởi tạo: owner tạo family, rồi tự thêm mình vào family_members với
-- role 'parent' thì mới tạo được children/rules/... (các policy "family
-- access" bên dưới yêu cầu is_family_member).
create policy "members read" on public.family_members
  for select using (public.is_family_member(family_id));
create policy "owner manage" on public.family_members
  for all using (public.is_family_owner(family_id))
  with check (public.is_family_owner(family_id));

-- Các bảng còn lại: phụ huynh (thành viên gia đình) đọc/ghi trong gia đình
-- của mình; service_role (Edge Function / Agent qua backend) vẫn qua được
-- RLS theo cấu hình Supabase, không dùng anon key để vượt RLS.
create policy "family access" on public.children
  for all using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));
create policy "family access" on public.devices
  for all using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));
create policy "family access" on public.device_tokens
  for all using (
    exists (select 1 from public.devices d
            where d.id = device_tokens.device_id
              and public.is_family_member(d.family_id))
  )
  with check (
    exists (select 1 from public.devices d
            where d.id = device_tokens.device_id
              and public.is_family_member(d.family_id))
  );
create policy "family access" on public.pairing_codes
  for all using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));
create policy "family access" on public.rules
  for all using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));
create policy "family access" on public.app_usage
  for all using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));
create policy "family access" on public.web_visits
  for all using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));
create policy "family access" on public.requests
  for all using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));
create policy "family access" on public.commands
  for all using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));

-- audit_logs chỉ đọc đối với user thường (chỉ có policy SELECT): ghi log
-- chỉ thực hiện qua service_role (Edge Function), vốn bypass RLS.
create policy "family read" on public.audit_logs
  for select using (public.is_family_member(family_id));

-- ============ Seed mẫu (ghi chú, chưa chạy) ============
-- Sprint 0 chỉ cần schema + RLS. Seed dữ liệu mẫu (1 gia đình, 1 con,
-- 1 máy, 1 rule daily_limit 2h) sẽ thêm sau khi anh Tiến tạo tài khoản
-- phụ huynh đầu tiên trên Supabase Auth, vì families.owner_id phải là
-- auth.users.id thật — không seed owner giả.
