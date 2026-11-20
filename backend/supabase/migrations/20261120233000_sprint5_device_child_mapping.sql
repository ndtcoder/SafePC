-- SafePC — Migration 24: Sprint 5 đợt 1 — ánh xạ thiết bị ↔ hồ sơ con ↔ tài khoản Windows
-- Ngày: 20/11/2026. Áp dụng qua Dashboard > SQL Editor (như migration 1-23),
-- chạy một lần, kiểm chứng bằng truy vấn ở cuối file (ghi chú).
--
-- Bối cảnh (PRD §2.11, phương án 2 "một phiên active"): một máy có thể có
-- nhiều tài khoản con (máy dùng chung của Diệu Linh và Đức Dũng). Hiện tại
-- một thiết bị chỉ ghép nối với một hồ sơ con (devices.child_id), nên mọi
-- con dùng chung máy phải dùng chung luật/giờ/báo cáo. Migration này đặt
-- nền dữ liệu cho quản lý riêng biệt theo hồ sơ con:
--
-- 1. Bảng mới device_child_accounts: ánh xạ (thiết bị, tài khoản Windows)
--    → hồ sơ con, lưu theo SID cho bền (đổi tên tài khoản không làm lệch
--    ánh xạ). family_id mang theo như mọi bảng khác để RLS theo gia đình.
--    Dashboard (đợt sau) ghi hàng này khi phụ huynh gắn tài khoản Windows
--    với hồ sơ con; Agent chỉ ĐỌC qua RPC (không ghi trực tiếp).
-- 2. commands thêm cột child_id (NULLABLE): lệnh gắn theo từng con. Lệnh cũ
--    (child_id NULL) giữ nguyên ngữ nghĩa hiện tại — áp dụng như trước, cho
--    con mặc định của máy. Agent giữ lệnh có child_id ở pending tới khi con
--    đó lên console (không ack done, không thi hành).
-- 3. RPC mới safepc_fetch_device_child_rules: lấy rules của MỘT con trên
--    máy này (con chính của máy khi p_child_id NULL, hoặc con có ánh xạ).
--    Con không gắn với máy này thì trả rỗng (fail-closed, không lộ luật
--    con khác). RPC cũ safepc_fetch_device_rules KHÔNG đổi — client cũ và
--    đường fallback của Agent mới vẫn chạy.
-- 4. RPC mới safepc_fetch_device_child_accounts: Agent tải ánh xạ của máy
--    để biết phiên console nào là con nào.
-- 5. safepc_push_device_usage / safepc_push_web_visits (cùng chữ ký, CREATE
--    OR REPLACE): mỗi sample thêm trường windows_sid TÙY CHỌN — có ánh xạ
--    thì ghi theo con của SID đó, không có / không khớp thì fallback về
--    devices.child_id như hiện tại. Sample cũ không có trường này vẫn chạy.
-- 6. safepc_push_unblock_domain_request: thêm tham số p_windows_sid TÙY CHỌN
--    (DEFAULT NULL) — DROP + CREATE lại vì đổi chữ ký (CREATE OR REPLACE
--    không đổi được danh sách tham số); gọi cũ với 3 đối số vẫn chạy nhờ
--    DEFAULT. Chống trùng đổi thành theo (device, child, domain) để hai con
--    xin mở cùng một domain thì thành hai yêu cầu riêng.
--
-- CHƯA LÀM Ở ĐÂY (quyết định còn mở, xem PRD §2.11): đồng bộ trạng thái khi
-- gắn thêm con B vào máy chung (khóa cưỡng chế / ghi đè đang hiệu lực /
-- tổng ngân hàng giờ của B đã done trên máy khác sẽ không tự tới được máy
-- này qua vòng poll lệnh). Migration này KHÔNG chèn bản sao lệnh kiểu
-- migration 21 lúc tạo ánh xạ, cũng không thêm RPC suy trạng thái — hai
-- phương án đó chốt ở đợt sau. Tới lúc đó, con B ngồi vào máy chung có thể
-- chưa bị khóa dù đang bị khóa cưỡng chế trên máy khác.
--
-- An toàn chạy lại: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / CREATE OR
-- REPLACE khắp nơi (trừ hàm unblock dùng DROP IF EXISTS + CREATE lại, vẫn
-- idempotent). KHÔNG đụng devices.child_id (giữ làm hồ sơ con chính/mặc
-- định của máy để đường đơn-con chạy như cũ). Không đổi RLS các bảng cũ.
-- devices.child_id NULL (máy chưa gắn con nào): sample mang SID có ánh xạ
-- vẫn ghi đúng con; sample không suy ra được con nào (SID lạ/thiếu và
-- không có con mặc định) thì BỊ BỎ khỏi batch — không fail cả batch — vì
-- app_usage/web_visits.child_id NOT NULL (sửa MINOR-1 review Sprint 5
-- đợt 1).

-- ============ 1. Bảng ánh xạ thiết bị ↔ hồ sơ con ↔ tài khoản Windows ============
create table if not exists public.device_child_accounts (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  child_id uuid not null references public.children (id) on delete cascade,
  windows_sid text not null check (char_length(windows_sid) between 1 and 256),
  windows_username text,
  created_at timestamptz not null default now(),
  unique (device_id, windows_sid)
);

create index if not exists device_child_accounts_device_idx
  on public.device_child_accounts (device_id);

alter table public.device_child_accounts enable row level security;

drop policy if exists "family access" on public.device_child_accounts;
create policy "family access" on public.device_child_accounts
  for all using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));

-- ============ 2. commands.child_id (lệnh gắn theo từng con) ============
alter table public.commands
  add column if not exists child_id uuid references public.children (id) on delete cascade;

create index if not exists commands_child_created_idx
  on public.commands (child_id, created_at);

-- ============ 3. fetch_device_commands: trả thêm child_id ============
-- Cùng chữ ký (uuid, text) nên CREATE OR REPLACE thay thế đúng hàm của
-- migration 3, không tạo overload. Client cũ bỏ qua trường JSON lạ.
create or replace function public.safepc_fetch_device_commands(
  p_device_id uuid,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, extensions
as $$
declare
  v_device public.devices;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  return coalesce((
    select jsonb_agg(to_jsonb(c) order by c.created_at)
    from (
      select id, family_id, device_id, child_id, type, payload, status, created_at
      from public.commands
      where device_id = v_device.id
        and status = 'pending'
    ) c
  ), '[]'::jsonb);
end;
$$;

-- ============ 4. RPC mới: rules của một con trên máy này ============
-- p_child_id NULL nghĩa là con chính của máy (devices.child_id) — hành vi
-- giống hệt safepc_fetch_device_rules cũ. Con xin luật phải thuộc gia đình
-- này VÀ gắn với máy này (con chính hoặc có hàng ánh xạ); nếu không thì
-- trả rỗng thay vì lộ luật con khác. Dùng IS DISTINCT FROM để NULL ở
-- devices.child_id không làm lọt điều kiện kiểm tra.
create or replace function public.safepc_fetch_device_child_rules(
  p_device_id uuid,
  p_token_hash text,
  p_child_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, extensions
as $$
declare
  v_device public.devices;
  v_child_id uuid;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  v_child_id := coalesce(p_child_id, v_device.child_id);

  if v_child_id is null then
    return '[]'::jsonb;
  end if;

  if v_child_id is distinct from v_device.child_id
     and not exists (
       select 1 from public.device_child_accounts a
       where a.device_id = v_device.id
         and a.child_id = v_child_id
     ) then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(to_jsonb(r) order by r.created_at)
    from (
      select id, family_id, child_id, type, config, enabled, created_at
      from public.rules
      where family_id = v_device.family_id
        and child_id = v_child_id
        and enabled = true
    ) r
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.safepc_fetch_device_child_rules(uuid, text, uuid) to anon, authenticated, service_role;

-- ============ 5. RPC mới: ánh xạ con ↔ tài khoản Windows của máy này ============
create or replace function public.safepc_fetch_device_child_accounts(
  p_device_id uuid,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, extensions
as $$
declare
  v_device public.devices;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  return coalesce((
    select jsonb_agg(to_jsonb(a) order by a.created_at)
    from (
      select child_id, windows_sid, windows_username, created_at
      from public.device_child_accounts
      where device_id = v_device.id
    ) a
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.safepc_fetch_device_child_accounts(uuid, text) to anon, authenticated, service_role;

-- ============ 6. push_device_usage: child theo SID, fallback con mặc định ============
-- Cùng chữ ký (uuid, text, jsonb) nên CREATE OR REPLACE thay thế đúng hàm
-- của migration 3. Sample thiếu windows_sid (client cũ) hoặc SID không có
-- ánh xạ thì ghi theo devices.child_id như trước. Sample không suy ra được
-- con nào (devices.child_id NULL và SID không có ánh xạ) thì BỊ BỎ khỏi
-- batch — không fail cả batch — vì app_usage.child_id NOT NULL (sửa
-- MINOR-1 review Sprint 5 đợt 1: trước đây cả batch fail với
-- device_not_assigned ngay cả khi sample mang SID đã có ánh xạ).
create or replace function public.safepc_push_device_usage(
  p_device_id uuid,
  p_token_hash text,
  p_samples jsonb
)
returns integer
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_device public.devices;
  v_count integer;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  if p_samples is null or jsonb_typeof(p_samples) <> 'array' then
    raise exception 'invalid_samples' using errcode = 'P0001';
  end if;

  if jsonb_array_length(p_samples) > 500 then
    raise exception 'batch_too_large' using errcode = 'P0001';
  end if;

  -- Child suy ra từng sample qua SID (join ánh xạ ở dưới); sample không
  -- suy ra được con nào thì bị lọc ở WHERE — không fail cả batch (sửa
  -- MINOR-1: trước đây raise device_not_assigned ngay khi devices.child_id
  -- NULL, kể cả khi sample mang SID đã có ánh xạ).
  insert into public.app_usage (family_id, device_id, child_id, app_name, exe_path_hash, started_at, duration_sec)
  select
    v_device.family_id,
    v_device.id,
    coalesce(a.child_id, v_device.child_id),
    left(s.app_name, 200),
    left(s.exe_path_hash, 128),
    s.started_at,
    least(greatest(s.duration_sec, 0), 86400)
  from jsonb_to_recordset(p_samples)
    as s(app_name text, exe_path_hash text, started_at timestamptz, duration_sec int, windows_sid text)
  left join public.device_child_accounts a
    on a.device_id = v_device.id
   and a.windows_sid = s.windows_sid
  where s.app_name is not null and length(trim(s.app_name)) > 0
    and coalesce(a.child_id, v_device.child_id) is not null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ============ 7. push_web_visits: child theo SID, fallback con mặc định ============
-- Cùng chữ ký (uuid, text, jsonb) nên CREATE OR REPLACE thay thế đúng hàm
-- của migration 19 (giữ nguyên luật path/blocked ở đó). Sample thiếu
-- windows_sid (client cũ) hoặc SID không có ánh xạ thì ghi theo
-- devices.child_id như trước. Sample không suy ra được con nào thì BỊ BỎ
-- khỏi batch — không fail cả batch (sửa MINOR-1, cùng lý do như §6).
create or replace function public.safepc_push_web_visits(
  p_device_id uuid,
  p_token_hash text,
  p_samples jsonb
)
returns integer
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_device public.devices;
  v_count integer;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  if p_samples is null or jsonb_typeof(p_samples) <> 'array' then
    raise exception 'invalid_samples' using errcode = 'P0001';
  end if;

  if jsonb_array_length(p_samples) > 500 then
    raise exception 'batch_too_large' using errcode = 'P0001';
  end if;

  -- Như §6: child suy ra từng sample qua SID; sample không suy ra được
  -- con nào thì bị lọc ở WHERE — không fail cả batch (sửa MINOR-1).
  insert into public.web_visits (family_id, device_id, child_id, domain, path, visited_at, duration_sec, blocked)
  select
    v_device.family_id,
    v_device.id,
    coalesce(a.child_id, v_device.child_id),
    left(s.domain, 253),
    -- Đường dẫn: lượt bị chặn không lưu path (chỉ-domain, phòng thủ
    -- theo chiều sâu cho quyết định ở tầng extension/NativeHost/Service);
    -- chỉ nhận chuỗi bắt đầu bằng '/' (URL đầy đủ trá hình thì bỏ); cắt
    -- ở '?'/'#' đầu tiên rồi trần 500 ký tự; rỗng sau khi cắt thì NULL.
    -- Sample thiếu path (client cũ) thì NULL.
    case
      when coalesce(s.blocked, false) then null
      when trim(coalesce(s.path, '')) not like '/%' then null
      else nullif(left(split_part(split_part(trim(s.path), '?', 1), '#', 1), 500), '')
    end,
    s.visited_at,
    least(greatest(coalesce(s.duration_sec, 0), 0), 86400),
    coalesce(s.blocked, false)
  from jsonb_to_recordset(p_samples)
    as s(domain text, path text, visited_at timestamptz, duration_sec int, blocked boolean, windows_sid text)
  left join public.device_child_accounts a
    on a.device_id = v_device.id
   and a.windows_sid = s.windows_sid
  where s.domain is not null and length(trim(s.domain)) > 0
    and s.visited_at is not null
    and coalesce(a.child_id, v_device.child_id) is not null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ============ 8. push_unblock_domain_request: thêm SID tùy chọn, chống trùng theo con ============
-- ĐỔI CHỮ KÝ (thêm p_windows_sid DEFAULT NULL) nên phải DROP + CREATE lại
-- (CREATE OR REPLACE không đổi được danh sách tham số); gọi cũ với 3 đối
-- số vẫn chạy nhờ DEFAULT. Quyền gọi cấp lại sau DROP (DROP xóa grant cũ).
-- Child suy ra từ SID có ánh xạ, không có / không khớp thì fallback về con
-- mặc định của máy. Chống trùng theo (device, child, domain): hai con xin
-- mở cùng một domain thì thành hai yêu cầu riêng để phụ huynh duyệt từng
-- con; cùng một con bấm nhiều lần vẫn chỉ có một yêu cầu chờ duyệt.
drop function if exists public.safepc_push_unblock_domain_request(uuid, text, text);

create or replace function public.safepc_push_unblock_domain_request(
  p_device_id uuid,
  p_token_hash text,
  p_domain text,
  p_windows_sid text default null
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_device public.devices;
  v_domain text;
  v_child_id uuid;
  v_mapped_child_id uuid;
  v_id uuid;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  v_child_id := v_device.child_id;
  if p_windows_sid is not null then
    select a.child_id into v_mapped_child_id
    from public.device_child_accounts a
    where a.device_id = v_device.id
      and a.windows_sid = p_windows_sid;
    v_child_id := coalesce(v_mapped_child_id, v_device.child_id);
  end if;

  if v_child_id is null then
    raise exception 'device chưa gắn với con nào';
  end if;

  v_domain := lower(trim(coalesce(p_domain, '')));
  if v_domain = ''
    or char_length(v_domain) > 253
    or position('/' in v_domain) > 0
    or position('?' in v_domain) > 0
    or position('#' in v_domain) > 0
    or v_domain ~ '[[:space:][:cntrl:]]'
  then
    raise exception 'domain không hợp lệ';
  end if;

  -- Khóa tư vấn theo (device, child, domain) để hai lần gửi cùng lúc không
  -- cùng tạo hai yêu cầu pending trùng nhau (cùng mẫu khóa của RPC ngân
  -- hàng giờ, migration 13). Khóa xact: giữ tới hết transaction.
  perform pg_advisory_xact_lock(hashtext('safepc_unblock_domain_' || v_device.id::text || '|' || v_child_id::text || '|' || v_domain));

  select id into v_id
  from public.requests
  where device_id = v_device.id
    and child_id = v_child_id
    and type = 'unblock_domain'
    and domain = v_domain
    and status = 'pending'
  order by created_at desc
  limit 1;

  if v_id is not null then
    return jsonb_build_object('request_id', v_id, 'already_pending', true);
  end if;

  insert into public.requests (family_id, child_id, device_id, type, status, domain)
  values (
    v_device.family_id,
    v_child_id,
    v_device.id,
    'unblock_domain',
    'pending',
    v_domain
  )
  returning id into v_id;

  return jsonb_build_object('request_id', v_id, 'already_pending', false);
end;
$$;

grant execute on function public.safepc_push_unblock_domain_request(uuid, text, text, text) to anon, authenticated, service_role;

-- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ============
-- select column_name from information_schema.columns where table_name = 'device_child_accounts' order by ordinal_position;
-- Kỳ vọng 7 cột: id, family_id, device_id, child_id, windows_sid, windows_username, created_at.
-- select column_name from information_schema.columns where table_name = 'commands' and column_name = 'child_id';
-- Kỳ vọng 1 dòng: child_id.
-- select pg_get_constraintdef(oid) from pg_constraint where conname = 'device_child_accounts_device_id_windows_sid_key';
-- Kỳ vọng UNIQUE (device_id, windows_sid).
-- select relrowsecurity from pg_class where relname = 'device_child_accounts';
-- Kỳ vọng true.
-- select proname, pg_get_function_identity_arguments(oid) from pg_proc where proname in ('safepc_fetch_device_child_rules','safepc_fetch_device_child_accounts','safepc_push_unblock_domain_request') order by proname;
-- Kỳ vọng 3 dòng: safepc_fetch_device_child_accounts(uuid, text), safepc_fetch_device_child_rules(uuid, text, uuid), safepc_push_unblock_domain_request(uuid, text, text, text default null).
-- select pg_get_function_identity_arguments('public.safepc_push_web_visits(uuid, text, jsonb)'::regprocedure);
-- Kỳ vọng: không lỗi, 1 hàm duy nhất với chữ ký (uuid, text, jsonb) — không overload.
