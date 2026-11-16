-- SafePC — Migration 3: RPC cho PC Agent (pairing, heartbeat, rules, commands, usage)
-- Ngày: 16/11/2026. Áp dụng qua Supabase Dashboard > SQL Editor (như migration 1-2),
-- chạy một lần, kiểm chứng bằng truy vấn pg_proc ở cuối file (ghi chú).
--
-- Bối cảnh: Agent chạy trên máy con không đăng nhập Supabase Auth nên không
-- dùng RLS trực tiếp được. Mọi lệnh gọi từ Agent đi qua các hàm SECURITY
-- DEFINER dưới đây, xác thực bằng cặp (device_id, token_hash). Chỉ hash của
-- token/mã mới được lưu và so sánh — token thô không bao giờ lưu ở DB.
-- Cách làm này thay thế Edge Function pair-device (stub, không deploy): gom
-- "đánh dấu mã đã dùng + tạo device + tạo token" vào 1 transaction Postgres,
-- và triển khai được qua SQL Editor mà không cần Supabase CLI.
--
-- Mọi hàm đều SET search_path cố định (public, extensions) để tránh tấn công
-- qua search_path khi chạy với quyền của người tạo hàm; extensions cần có để
-- gọi gen_random_bytes/digest của pgcrypto trên Supabase.
-- Chỉ các hàm RPC mới được GRANT cho anon/authenticated/service_role; hàm
-- helper xác thực nội bộ bị REVOKE khỏi PUBLIC để không gọi trực tiếp được
-- qua PostgREST.

-- ============ Helper nội bộ: xác thực device bằng token hash ============
create or replace function public.safepc_auth_device(p_device_id uuid, p_token_hash text)
returns public.devices
language plpgsql
security definer
stable
set search_path = public, extensions
as $$
declare
  v_device public.devices;
begin
  select d.* into v_device
  from public.devices d
  join public.device_tokens t on t.device_id = d.id
  where d.id = p_device_id
    and t.token_hash = p_token_hash
    and t.revoked_at is null;

  if v_device.id is null then
    raise exception 'unauthorized' using errcode = 'P0001';
  end if;

  return v_device;
end;
$$;

revoke execute on function public.safepc_auth_device(uuid, text) from public;

-- ============ 1. Đổi mã pairing 6 số lấy device token ============
-- Input: hash SHA-256 hex chữ thường của chuỗi 6 chữ số (Agent tự hash, mã
-- thô không rời khỏi máy con). Mã phải còn hạn (10 phút), chưa dùng, và gắn
-- với một con. Thành công: đánh dấu used, tạo device + token 256-bit, trả
-- token thô ĐÚNG 1 LẦN. Thất bại: thông báo chung chung, không phân biệt
-- mã sai / hết hạn / đã dùng.
create or replace function public.safepc_redeem_pairing_code(
  p_code_hash text,
  p_hostname text,
  p_os_version text,
  p_agent_version text
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_code public.pairing_codes;
  v_device_id uuid;
  v_token text;
begin
  -- Khóa hàng mã để hai lần đổi cùng lúc không cùng thành công.
  select * into v_code
  from public.pairing_codes
  where code_hash = p_code_hash
    and used_at is null
    and expires_at > now()
    and attempts < 5
  order by created_at desc
  limit 1
  for update;

  if v_code.id is null or v_code.child_id is null then
    raise exception 'invalid_code' using errcode = 'P0001';
  end if;

  update public.pairing_codes
  set attempts = attempts + 1,
      used_at = now()
  where id = v_code.id;

  insert into public.devices (family_id, child_id, hostname, os_version, agent_version, last_seen_at, status)
  values (v_code.family_id, v_code.child_id,
          left(coalesce(nullif(trim(p_hostname), ''), 'PC'), 200),
          left(coalesce(p_os_version, ''), 200),
          left(coalesce(p_agent_version, ''), 50),
          now(), 'online')
  returning id into v_device_id;

  -- Token 32 byte ngẫu nhiên (hex 64 ký tự); chỉ hash được lưu.
  v_token := encode(gen_random_bytes(32), 'hex');

  insert into public.device_tokens (device_id, token_hash)
  values (v_device_id, encode(digest(convert_to(v_token, 'UTF8'), 'sha256'), 'hex'));

  return jsonb_build_object(
    'device_id', v_device_id,
    'token', v_token,
    'family_id', v_code.family_id,
    'child_id', v_code.child_id
  );
end;
$$;

-- ============ 2. Heartbeat: cập nhật last_seen_at, trả giờ server ============
-- Client dùng server_time để phát hiện đồng hồ máy bị chỉnh (lệch > 5 phút).
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
    'child_id', v_device.child_id
  );
end;
$$;

-- ============ 3. Lấy rules đang bật của con gắn với device ============
create or replace function public.safepc_fetch_device_rules(
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

  if v_device.child_id is null then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(to_jsonb(r) order by r.created_at)
    from (
      select id, family_id, child_id, type, config, enabled, created_at
      from public.rules
      where family_id = v_device.family_id
        and child_id = v_device.child_id
        and enabled = true
    ) r
  ), '[]'::jsonb);
end;
$$;

-- ============ 4. Lấy commands đang chờ (pending), cũ trước ============
-- Không đánh dấu đã gửi ở đây: Agent ack sau khi thi hành xong, nên nếu
-- Agent chết giữa chừng thì lệnh được gửi lại. Mọi lệnh đều idempotent
-- (khóa/mở/làm mới rules/lưu ghi đè) nên gửi lại là an toàn.
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
      select id, family_id, device_id, type, payload, status, created_at
      from public.commands
      where device_id = v_device.id
        and status = 'pending'
    ) c
  ), '[]'::jsonb);
end;
$$;

-- ============ 5. Ack command đã thi hành (done/failed) ============
create or replace function public.safepc_ack_device_command(
  p_device_id uuid,
  p_token_hash text,
  p_command_id uuid,
  p_status text
)
returns boolean
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_device public.devices;
  v_updated boolean := false;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  if p_status not in ('done', 'failed') then
    raise exception 'invalid_status' using errcode = 'P0001';
  end if;

  update public.commands
  set status = p_status
  where id = p_command_id
    and device_id = v_device.id
    and status = 'pending';

  v_updated := found;
  return v_updated;
end;
$$;

-- ============ 6. Đẩy batch usage (tổng hợp theo app) ============
-- family_id/child_id/device_id lấy từ hàng devices đã xác thực, KHÔNG tin
-- giá trị client gửi kèm. Một câu INSERT duy nhất nên batch hoặc vào hết
-- hoặc không vào gì (Agent chỉ tiến watermark khi gọi thành công).
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

  if v_device.child_id is null then
    raise exception 'device_not_assigned' using errcode = 'P0001';
  end if;

  if p_samples is null or jsonb_typeof(p_samples) <> 'array' then
    raise exception 'invalid_samples' using errcode = 'P0001';
  end if;

  if jsonb_array_length(p_samples) > 500 then
    raise exception 'batch_too_large' using errcode = 'P0001';
  end if;

  insert into public.app_usage (family_id, device_id, child_id, app_name, exe_path_hash, started_at, duration_sec)
  select
    v_device.family_id,
    v_device.id,
    v_device.child_id,
    left(s.app_name, 200),
    left(s.exe_path_hash, 128),
    s.started_at,
    least(greatest(s.duration_sec, 0), 86400)
  from jsonb_to_recordset(p_samples)
    as s(app_name text, exe_path_hash text, started_at timestamptz, duration_sec int)
  where s.app_name is not null and length(trim(s.app_name)) > 0;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ============ Quyền gọi qua PostgREST (khóa publishable dùng role anon) ============
grant execute on function public.safepc_redeem_pairing_code(text, text, text, text) to anon, authenticated, service_role;
grant execute on function public.safepc_device_heartbeat(uuid, text, text, text) to anon, authenticated, service_role;
grant execute on function public.safepc_fetch_device_rules(uuid, text) to anon, authenticated, service_role;
grant execute on function public.safepc_fetch_device_commands(uuid, text) to anon, authenticated, service_role;
grant execute on function public.safepc_ack_device_command(uuid, text, uuid, text) to anon, authenticated, service_role;
grant execute on function public.safepc_push_device_usage(uuid, text, jsonb) to anon, authenticated, service_role;

-- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ============
-- select proname from pg_proc where proname like 'safepc\_%' order by proname;
-- Kỳ vọng 7 hàm: safepc_ack_device_command, safepc_auth_device,
-- safepc_device_heartbeat, safepc_fetch_device_commands, safepc_fetch_device_rules,
-- safepc_push_device_usage, safepc_redeem_pairing_code.
