-- SafePC — Migration 19: lịch sử web lưu đường dẫn + tự xóa sau 90 ngày
-- Ngày: 18/11/2026. Áp dụng qua Dashboard > SQL Editor (như migration 1-18),
-- chạy một lần, kiểm chứng bằng truy vấn ở cuối file (ghi chú).
--
-- Bối cảnh: phụ huynh chốt ngày 18/11/2026 — lịch sử web lưu TÊN MIỀN +
-- ĐƯỜNG DẪN (path), BỎ phần truy vấn (query) và fragment, giữ 90 ngày.
-- Đây là nới ranh giới "chỉ tên miền" trước đây, đúng một phần này: vẫn
-- không ghi phím, không đọc nội dung chat/file, không query/fragment.
-- Đường dẫn do extension 0.1.10 tách từ URL tab và cắt query/fragment
-- ngay tại điểm thu thập; Agent cắt lại lần nữa; RPC dưới đây cắt lại
-- lần thứ ba (phòng thủ theo chiều sâu). Lượt web bị chặn vẫn chỉ ghi
-- tên miền, không có đường dẫn.
--
-- Migration này:
-- 1. Thêm cột web_visits.path (nullable, trần 500 ký tự, cấm '?'/'#',
--    phải bắt đầu bằng '/'). Cột nullable nên hàng cũ không bị ảnh hưởng.
-- 2. Định nghĩa lại RPC safepc_push_web_visits (CÙNG chữ ký (uuid, text,
--    jsonb) nên CREATE OR REPLACE thay thế đúng hàm của migration 10,
--    không tạo overload): recordset nhận thêm trường path; sample thiếu
--    path (client cũ) thì ghi NULL — Agent cũ vẫn chạy được. Đường dẫn
--    được cắt query/fragment + trần 500 ký tự trong câu INSERT.
-- 3. Lịch cron 'safepc-web-history-cleanup': mỗi ngày 03:00 UTC (10:00
--    giờ +07) xóa hàng web_visits có visited_at cũ hơn 90 ngày. Lệnh
--    DELETE trực tiếp, không secret, không gọi HTTP nên không cần pg_net.
--
-- Chạy lại an toàn: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, lịch
-- gỡ trước rồi mới tạo (mẫu migration 11/12) nên chạy lại không tạo
-- trùng job. Không có câu INSERT dữ liệu mẫu nào.

-- ============ 1. Cột path cho web_visits ============
-- CHECK chỉ là lưới an toàn cuối cùng: RPC luôn cắt query/fragment và
-- trần 500 ký tự trước khi INSERT nên hàng từ RPC không bao giờ vi phạm.
-- Hàng ghi trực tiếp (bỏ qua RPC) vi phạm CHECK sẽ bị từ chối — đúng ý.
alter table public.web_visits
  add column if not exists path text
    check (path is null
      or (length(path) <= 500
        and path like '/%'
        and path not like '%?%'
        and path not like '%#%'));

-- ============ 2. RPC đẩy batch web visits: nhận thêm đường dẫn ============
-- Thân hàm giữ nguyên từng bước của migration 10 (xác thực device,
-- kiểm tra mảng/mẫu, INSERT ... SELECT), chỉ thêm cột path vào danh
-- sách INSERT + recordset và biểu thức cắt đường dẫn.
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

  insert into public.web_visits (family_id, device_id, child_id, domain, path, visited_at, duration_sec, blocked)
  select
    v_device.family_id,
    v_device.id,
    v_device.child_id,
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
    as s(domain text, path text, visited_at timestamptz, duration_sec int, blocked boolean)
  where s.domain is not null and length(trim(s.domain)) > 0
    and s.visited_at is not null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Quyền gọi qua PostgREST (khóa publishable dùng role anon) — cùng
-- danh sách với migration 10, cấp lại cho rõ (CREATE OR REPLACE giữ
-- quyền cũ, câu này không thừa).
grant execute on function public.safepc_push_web_visits(uuid, text, jsonb) to anon, authenticated, service_role;

-- ============ 3. Lịch dọn dẹp lịch sử web cũ hơn 90 ngày ============
-- pg_cron đã bật từ migration 11; IF NOT EXISTS để file chạy được độc
-- lập nếu lịch đó chưa từng áp dụng.
create extension if not exists pg_cron with schema extensions;

-- Gỡ lịch cũ cùng tên nếu có (chạy lại file an toàn): câu SELECT dưới
-- đây không làm gì khi chưa có job nào tên này.
select cron.unschedule(jobid) from cron.job where jobname = 'safepc-web-history-cleanup';

-- 03:00 UTC mỗi ngày = 10:00 giờ Việt Nam (múi giờ database là UTC,
-- xem ghi chú migration 11). Xóa theo visited_at (thời điểm xem thật),
-- không theo created_at (thời điểm hàng được ghi, có thể chậm khi máy
-- offline rồi mới đồng bộ).
select cron.schedule(
  'safepc-web-history-cleanup',
  '0 3 * * *',
  $cron$delete from public.web_visits where visited_at < now() - interval '90 days';$cron$
);

--- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ============
--- select column_name, data_type from information_schema.columns
--- where table_name = 'web_visits' and column_name = 'path';
--- Kỳ vọng 1 dòng: path, text.
--- select pg_get_functiondef(oid) like '%s.path%' from pg_proc
--- where proname = 'safepc_push_web_visits' and pronamespace = 'public'::regnamespace;
--- Kỳ vọng: true (thân hàm mới đọc trường path của sample).
--- select grantee from information_schema.routine_privileges where routine_name = 'safepc_push_web_visits' and privilege_type = 'EXECUTE' order by grantee;
--- Kỳ vọng: có đủ anon, authenticated, service_role; cộng hàng postgres là chủ hàm (bình thường), không có hàng PUBLIC.
--- select jobname, schedule, active from cron.job where jobname = 'safepc-web-history-cleanup';
--- Kỳ vọng 1 dòng: safepc-web-history-cleanup, '0 3 * * *', active = true.
--- select count(*) from public.web_visits where visited_at < now() - interval '90 days';
--- Kỳ vọng: 0 sau lần chạy lịch đầu tiên (trước lần chạy đầu, số này là hàng cũ sẽ bị xóa).
