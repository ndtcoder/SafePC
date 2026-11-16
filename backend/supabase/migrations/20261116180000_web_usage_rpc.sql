-- SafePC — Migration 4: RPC đẩy lượt thăm web (Sprint 2 đợt 2) + cột duration_sec cho web_visits
-- Ngày: 16/11/2026. Áp dụng qua Supabase Dashboard > SQL Editor (như migration 1-3),
-- chạy một lần, kiểm chứng bằng truy vấn ở cuối file (ghi chú).
--
-- Bối cảnh: migration 1 tạo bảng web_visits chỉ có visited_at + blocked,
-- không có cột thời lượng (khác app_usage có started_at + duration_sec).
-- Extension trình duyệt đếm thời gian xem theo từng domain (chỉ domain,
-- không path/query — docs/03-SECURITY.md mục 3), nên bảng cần thêm cột
-- duration_sec để lưu thời lượng đó. Hàm RPC dưới đây mirror chính xác
-- safepc_push_device_usage của migration 3: xác thực bằng
-- safepc_auth_device, family_id/child_id/device_id suy ra từ hàng devices
-- đã xác thực (không tin client), một câu INSERT duy nhất nên batch hoặc
-- vào hết hoặc không vào gì.
--
-- Hàm SET search_path cố định (public, extensions) như mọi hàm safepc_* khác.
-- blocked giữ giá trị mặc định false: đợt này chưa báo cáo lượt bị chặn.

-- ============ 1. Thêm cột duration_sec cho web_visits (idempotent) ============
alter table public.web_visits add column if not exists duration_sec int not null default 0 check (duration_sec >= 0);

-- ============ 2. Đẩy batch web visits (domain + thời lượng xem) ============
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

  if v_device.child_id is null then
    raise exception 'device_not_assigned' using errcode = 'P0001';
  end if;

  if p_samples is null or jsonb_typeof(p_samples) <> 'array' then
    raise exception 'invalid_samples' using errcode = 'P0001';
  end if;

  if jsonb_array_length(p_samples) > 500 then
    raise exception 'batch_too_large' using errcode = 'P0001';
  end if;

  insert into public.web_visits (family_id, device_id, child_id, domain, visited_at, duration_sec)
  select
    v_device.family_id,
    v_device.id,
    v_device.child_id,
    left(s.domain, 253),
    s.visited_at,
    least(greatest(coalesce(s.duration_sec, 0), 0), 86400)
  from jsonb_to_recordset(p_samples)
    as s(domain text, visited_at timestamptz, duration_sec int)
  where s.domain is not null and length(trim(s.domain)) > 0
    and s.visited_at is not null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ============ Quyền gọi qua PostgREST (khóa publishable dùng role anon) ============
grant execute on function public.safepc_push_web_visits(uuid, text, jsonb) to anon, authenticated, service_role;

-- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ============
-- select proname from pg_proc where proname = 'safepc_push_web_visits';
-- Kỳ vọng 1 hàm: safepc_push_web_visits (cùng 7 hàm safepc_* của migration 3
-- thành 8 hàm).
-- select column_name, data_type, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'web_visits'
--     and column_name = 'duration_sec';
-- Kỳ vọng 1 dòng: duration_sec | integer | 0.
