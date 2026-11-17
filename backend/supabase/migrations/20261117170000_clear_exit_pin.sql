-- Migration 8: mã PIN thoát dùng một lần (đợt sửa 17/11/2026 theo yêu cầu
-- test máy thật: nhập đúng PIN để thoát Tray thì mã bị gỡ khỏi hệ thống).
--
-- Yêu cầu: migration 7 đã áp (cột devices.exit_pin_hash). Áp migration này
-- trước migration 7 thì hàm vẫn tạo được nhưng lần gọi đầu sẽ lỗi; Agent
-- đã fail-safe (giữ cờ thử lại, không crash).
--
-- 1. RPC mới safepc_clear_exit_pin: Agent gọi sau khi xác thực PIN đúng để
--    đặt devices.exit_pin_hash về NULL. Xác thực bằng (device_id,
--    token_hash) như mọi RPC thiết bị khác; chỉ gỡ PIN của chính máy đó.
--    CHỈ gỡ khi hash trên server đúng bằng p_expected_hash (hash của mã
--    vừa dùng): phụ huynh đặt mã PIN mới trong khoảng giữa lúc Agent đọc
--    heartbeat và lúc RPC tới thì mã mới không bị xóa nhầm. Trả
--    {cleared: true} khi đã gỡ, {cleared: false} khi hash đã đổi/mất.
--    Idempotent: gọi lại với cùng hash sau khi đã gỡ trả cleared=false.
-- 2. Không đổi schema bảng nào. Agent chưa cập nhật vẫn chạy bình thường
--    (không gọi RPC này); Agent mới trước khi áp migration sẽ thử gỡ lỗi
--    và giữ cờ thử lại — PIN vẫn bị xóa khỏi bộ nhớ Service ngay khi dùng
--    đúng nên không dùng lại được trong lúc chờ.
--
-- Áp dụng: dán toàn bộ file vào Supabase SQL Editor và Run (như migration 7).
-- Kiểm chứng:
-- select proname from pg_proc where proname = 'safepc_clear_exit_pin';
-- Kỳ vọng 1 dòng: safepc_clear_exit_pin.
-- select column_name from information_schema.columns where table_name = 'devices' and column_name = 'exit_pin_hash';
-- Kỳ vọng 1 dòng: exit_pin_hash (cột của migration 7).

create or replace function public.safepc_clear_exit_pin(
  p_device_id uuid,
  p_token_hash text,
  p_expected_hash text
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
  set exit_pin_hash = null
  where id = v_device.id
    and exit_pin_hash = p_expected_hash;

  return jsonb_build_object('cleared', found);
end;
$$;

grant execute on function public.safepc_clear_exit_pin(uuid, text, text) to anon, authenticated, service_role;
