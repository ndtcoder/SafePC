-- Migration 7: mã PIN thoát Tray + yêu cầu xin thêm giờ đầu-cuối.
-- Áp dụng: Supabase Dashboard → SQL Editor → dán toàn bộ file → Run.
-- Kiểm chứng sau khi chạy: xem cuối file.
--
-- 1. devices.exit_pin_hash: hash PBKDF2 của mã PIN thoát Tray (6 số) do phụ
--    huynh đặt trên Dashboard. Dashboard băm phía trình duyệt (WebCrypto
--    PBKDF2-SHA256, 100.000 vòng, salt 16 byte) rồi chỉ gửi hash lên; PIN
--    thô không bao giờ rời trình duyệt và không lưu ở đâu cả. Định dạng
--    hash: "v1$100000$<salt base64>$<hash base64>" (khớp PinHash.cs phía
--    Agent và pinHash.ts phía Dashboard). NULL = chưa đặt PIN.
-- 2. requests.minutes + requests.device_id: yêu cầu xin thêm giờ mang theo
--    số phút con xin và máy đã gửi, để Dashboard duyệt đúng máy.
-- 3. safepc_device_heartbeat trả thêm exit_pin_hash để Agent đồng bộ xuống
--    và Tray kiểm tra PIN tại chỗ (kể cả khi mất mạng sau đó).
-- 4. RPC mới safepc_push_extra_time_request: Agent đẩy yêu cầu xin thêm giờ
--    của con lên bảng requests (xác thực bằng device token như mọi RPC khác).

alter table public.devices
  add column if not exists exit_pin_hash text;

alter table public.requests
  add column if not exists minutes integer check (minutes is null or (minutes >= 1 and minutes <= 240));

alter table public.requests
  add column if not exists device_id uuid references public.devices (id) on delete set null;

-- Heartbeat: giữ nguyên chữ ký, chỉ thêm trường exit_pin_hash vào JSON trả
-- về. Agent cũ (chưa biết trường này) vẫn chạy bình thường vì JSON thừa
-- trường được bỏ qua khi giải mã.
create or replace function public.safepc_device_heartbeat(
  p_device_id uuid,
  p_token_hash text,
  p_agent_version text,
  p_status text
)
returns jsonb
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
  set last_seen_at = now(),
      agent_version = coalesce(nullif(left(p_agent_version, 50), ''), agent_version),
      status = case when p_status in ('online', 'offline', 'locked') then p_status else status end
  where id = v_device.id;

  return jsonb_build_object(
    'server_time', now(),
    'family_id', v_device.family_id,
    'child_id', v_device.child_id,
    'exit_pin_hash', v_device.exit_pin_hash
  );
end;
$$;

-- Agent đẩy yêu cầu xin thêm giờ của con lên bảng requests. family_id /
-- child_id / device_id suy ra từ device đã xác thực, không tin client.
create or replace function public.safepc_push_extra_time_request(
  p_device_id uuid,
  p_token_hash text,
  p_minutes integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_device public.devices;
  v_id uuid;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  if v_device.child_id is null then
    raise exception 'device chưa gắn với con nào';
  end if;
  if p_minutes is null or p_minutes < 1 or p_minutes > 240 then
    raise exception 'minutes ngoài khoảng 1-240';
  end if;

  insert into public.requests (family_id, child_id, device_id, type, status, reason, minutes)
  values (
    v_device.family_id,
    v_device.child_id,
    v_device.id,
    'extra_time',
    'pending',
    left(coalesce(p_reason, ''), 500),
    p_minutes
  )
  returning id into v_id;

  return jsonb_build_object('request_id', v_id);
end;
$$;

grant execute on function public.safepc_push_extra_time_request(uuid, text, integer, text) to anon, authenticated, service_role;

--- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ============
--- select column_name from information_schema.columns
--- where table_name = 'devices' and column_name = 'exit_pin_hash';
--- Kỳ vọng 1 dòng: exit_pin_hash.
--- select column_name from information_schema.columns
--- where table_name = 'requests' and column_name in ('minutes', 'device_id');
--- Kỳ vọng 2 dòng: device_id, minutes.
--- select proname from pg_proc where proname = 'safepc_push_extra_time_request';
--- Kỳ vọng 1 dòng: safepc_push_extra_time_request.
