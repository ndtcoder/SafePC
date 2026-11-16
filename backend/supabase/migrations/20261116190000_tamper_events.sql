-- SafePC — Migration 5: cảnh báo can thiệp + heartbeat của extension (Sprint 2 đợt 3)
-- Ngày: 16/11/2026. Áp dụng qua Supabase Dashboard > SQL Editor (như migration 1-4),
-- chạy một lần, kiểm chứng bằng truy vấn ở cuối file (ghi chú).
--
-- Bối cảnh: migration 1 tạo bảng audit_logs chỉ với các cột
-- (id, family_id, actor, action, target, ip_hash, created_at) — không có
-- cột nào để gắn sự kiện với con/máy hay mang chi tiết kèm theo. Migration
-- này thêm 3 cột đó, thêm cột last_extension_seen_at cho bảng devices, và
-- thêm 2 RPC SECURITY DEFINER cho Agent (xác thực bằng safepc_auth_device
-- của migration 3, family/child/device suy ra từ hàng devices đã xác thực,
-- không tin client):
-- - safepc_report_extension_heartbeat: cập nhật last_extension_seen_at.
-- - safepc_push_tamper_event: ghi một hàng audit_logs cho sự kiện can thiệp.
--
-- KHÔNG đổi RLS: audit_logs đã có policy SELECT "family read" và devices đã
-- có policy "family access" (migration 1) — policy áp cho cả hàng nên cột
-- mới tự động nằm trong cùng ranh giới family_id. Không thêm policy nào.
--
-- Các hàm SET search_path cố định (public, extensions) như mọi hàm safepc_*
-- khác. Mọi câu đều idempotent (IF NOT EXISTS / CREATE OR REPLACE).

-- ============ 1. Cột last_extension_seen_at cho devices ============
alter table public.devices add column if not exists last_extension_seen_at timestamptz;

-- ============ 2. Cột child_id / device_id / details cho audit_logs ============
alter table public.audit_logs add column if not exists child_id uuid references public.children (id) on delete set null;
alter table public.audit_logs add column if not exists device_id uuid references public.devices (id) on delete set null;
alter table public.audit_logs add column if not exists details jsonb not null default '{}'::jsonb;

-- Index phục vụ Dashboard lọc sự kiện can thiệp theo loại trong một gia đình.
create index if not exists audit_logs_family_action_idx
  on public.audit_logs (family_id, action, created_at desc);

-- ============ 3. Báo extension còn sống: cập nhật last_extension_seen_at ============
-- Chỉ cập nhật đúng cột này, không chạm tới last_seen_at/status (việc của
-- heartbeat chính). p_seen_at null thì dùng giờ server; giờ tương lai thì
-- kẹp về giờ server (không tin đồng hồ máy con).
create or replace function public.safepc_report_extension_heartbeat(
  p_device_id uuid,
  p_token_hash text,
  p_seen_at timestamptz
)
returns void
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_device public.devices;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  update public.devices
  set last_extension_seen_at = least(coalesce(p_seen_at, now()), now())
  where id = v_device.id;
end;
$$;

-- ============ 4. Ghi một sự kiện can thiệp vào audit_logs ============
-- p_event_type chỉ nhận 4 giá trị; giá trị khác thì lỗi invalid_event_type.
-- family_id/child_id/device_id lấy từ hàng devices đã xác thực. action ghi
-- đúng p_event_type, target là id device dạng text, actor/ip_hash để NULL
-- (sự kiện từ máy con, không phải hành động của user đăng nhập).
-- details cắt tối đa 2KB: cắt chuỗi JSON rồi parse lại trong khối
-- BEGIN/EXCEPTION — JSON hỏng sau khi cắt (hoặc p_details null) thì dùng
-- '{}'::jsonb, không bao giờ làm lỗi cả lần gọi vì chi tiết kèm theo.
create or replace function public.safepc_push_tamper_event(
  p_device_id uuid,
  p_token_hash text,
  p_event_type text,
  p_details jsonb
)
returns uuid
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_device public.devices;
  v_details jsonb;
  v_id uuid;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  if p_event_type is null or p_event_type not in ('clock_drift', 'agent_restart', 'extension_missing', 'service_stopped') then
    raise exception 'invalid_event_type' using errcode = 'P0001';
  end if;

  begin
    v_details := left(coalesce(p_details, '{}'::jsonb)::text, 2000)::jsonb;
  exception when others then
    v_details := '{}'::jsonb;
  end;

  insert into public.audit_logs (family_id, child_id, device_id, actor, action, target, ip_hash, details)
  values (v_device.family_id, v_device.child_id, v_device.id, null, p_event_type, v_device.id::text, null, v_details)
  returning id into v_id;

  return v_id;
end;
$$;

-- ============ Quyền gọi qua PostgREST (khóa publishable dùng role anon) ============
grant execute on function public.safepc_report_extension_heartbeat(uuid, text, timestamptz) to anon, authenticated, service_role;
grant execute on function public.safepc_push_tamper_event(uuid, text, text, jsonb) to anon, authenticated, service_role;

-- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ============
-- select proname from pg_proc where proname in ('safepc_report_extension_heartbeat', 'safepc_push_tamper_event') order by proname;
-- Kỳ vọng 2 hàm: safepc_push_tamper_event, safepc_report_extension_heartbeat
-- (cùng 8 hàm safepc_* của migration 3-4 thành 10 hàm).
-- select column_name, data_type from information_schema.columns
--   where table_schema = 'public' and table_name = 'devices'
--     and column_name = 'last_extension_seen_at';
-- Kỳ vọng 1 dòng: last_extension_seen_at | timestamp with time zone.
-- select column_name, data_type, column_default from information_schema.columns
--   where table_schema = 'public' and table_name = 'audit_logs'
--     and column_name in ('child_id', 'device_id', 'details') order by column_name;
-- Kỳ vọng 3 dòng: child_id | uuid, device_id | uuid,
-- details | jsonb với default '{}'::jsonb.
-- select indexname from pg_indexes
--   where schemaname = 'public' and tablename = 'audit_logs'
--     and indexname = 'audit_logs_family_action_idx';
-- Kỳ vọng 1 dòng: audit_logs_family_action_idx.
