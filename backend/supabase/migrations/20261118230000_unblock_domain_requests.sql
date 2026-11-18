-- Migration 18: yêu cầu xin mở trang web bị chặn, gửi từ nút trên trang
-- chặn của extension (extension 0.1.9).
-- Áp dụng: Supabase Dashboard → SQL Editor → dán toàn bộ file → Run.
-- Kiểm chứng sau khi chạy: xem cuối file.
--
-- 1. requests.domain: TÊN MIỀN con xin mở (ví dụ "facebook.com"). CHỈ tên
--    miền — không path, không query, không URL đầy đủ (ranh giới riêng tư
--    như bảng web_visits: chỉ domain). NULL với yêu cầu loại khác.
-- 2. Loại yêu cầu mới 'unblock_domain' trong CHECK của requests.type (mẫu
--    drop/add constraint của migration 2).
-- 3. RPC mới safepc_push_unblock_domain_request: Agent đẩy yêu cầu xin mở
--    domain của con lên bảng requests, xác thực bằng device token như RPC
--    xin thêm giờ (migration 7). family_id / child_id / device_id suy ra
--    từ device đã xác thực, không tin client. CHỐNG TRÙNG: nếu đã có yêu
--    cầu pending cho cùng (device, domain) thì trả về yêu cầu đó thay vì
--    tạo mới — con bấm nút nhiều lần vẫn chỉ có một yêu cầu chờ duyệt.
--    Không đổi RLS: policy "family access" hiện có đã cho phụ huynh đọc;
--    ghi từ máy con chỉ qua RPC SECURITY DEFINER này.

alter table public.requests
  add column if not exists domain text
    check (domain is null or (char_length(domain) between 1 and 253));

alter table public.requests
  drop constraint if exists requests_type_check;

alter table public.requests
  add constraint requests_type_check
    check (type in ('extra_time', 'unblock_app', 'unblock_domain'));

-- Agent đẩy yêu cầu xin mở domain của con lên bảng requests. Chỉ tên miền
-- được chấp nhận: chứa '/', '?', '#', khoảng trắng hay ký tự điều khiển
-- (dấu hiệu của URL/path/query) thì từ chối, không đoán ý client.
create or replace function public.safepc_push_unblock_domain_request(
  p_device_id uuid,
  p_token_hash text,
  p_domain text
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
  v_id uuid;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  if v_device.child_id is null then
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

  -- Khóa tư vấn theo (device, domain) để hai lần gửi cùng lúc không cùng
  -- tạo hai yêu cầu pending trùng nhau (cùng mẫu khóa của RPC ngân hàng
  -- giờ, migration 13). Khóa xact: giữ tới hết transaction.
  perform pg_advisory_xact_lock(hashtext('safepc_unblock_domain_' || v_device.id::text || '|' || v_domain));

  select id into v_id
  from public.requests
  where device_id = v_device.id
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
    v_device.child_id,
    v_device.id,
    'unblock_domain',
    'pending',
    v_domain
  )
  returning id into v_id;

  return jsonb_build_object('request_id', v_id, 'already_pending', false);
end;
$$;

grant execute on function public.safepc_push_unblock_domain_request(uuid, text, text) to anon, authenticated, service_role;

--- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ============
--- select column_name from information_schema.columns
--- where table_name = 'requests' and column_name = 'domain';
--- Kỳ vọng 1 dòng: domain.
--- select pg_get_constraintdef(oid) from pg_constraint where conname = 'requests_type_check';
--- Kỳ vọng: CHECK ((type = ANY (ARRAY['extra_time'::text, 'unblock_app'::text, 'unblock_domain'::text]))).
--- select proname from pg_proc where proname = 'safepc_push_unblock_domain_request';
--- Kỳ vọng 1 dòng: safepc_push_unblock_domain_request.
--- select grantee from information_schema.routine_privileges where routine_name = 'safepc_push_unblock_domain_request' and privilege_type = 'EXECUTE' order by grantee;
--- Kỳ vọng: có đủ anon, authenticated, service_role; cộng hàng postgres là chủ hàm (bình thường), không có hàng PUBLIC.
