-- SafePC — Migration 22: thêm loại can thiệp 'tray_stopped' (Sprint 4)
-- Ngày: 19/11/2026. Áp dụng qua Supabase Dashboard > SQL Editor (như các
-- migration trước), chạy một lần, kiểm chứng bằng truy vấn ở cuối file.
--
-- Bối cảnh: RPC safepc_push_tamper_event (migration 5) chỉ nhận 4 loại
-- (clock_drift, agent_restart, extension_missing, service_stopped). Sprint 4
-- thêm watchdog Tray phía Service: Tray tắt bất thường mà khởi động lại 5
-- lần trong một giờ đều không trở lại thì Service báo phụ huynh bằng sự kiện
-- can thiệp — cần loại thứ 5 là 'tray_stopped'. Không đổi gì khác trong hàm:
-- thân hàm sao chép y hệt migration 5, chỉ thêm 'tray_stopped' vào danh sách
-- cho phép. Mọi câu đều idempotent (CREATE OR REPLACE / GRANT).
--
-- Pipeline nhận loại mới đã cập nhật cùng đợt (không cần migration):
-- - Edge Function send-parent-notifications: TAMPER_ACTIONS + nhãn
--   tamperActionLabel (cần deploy lại function).
-- - Dashboard: weekReport.ts TAMPER_ACTIONS + format.ts tamperEventLabel
--   (theo push main, Vercel deploy tự động).
-- - Báo cáo tuần (email): send-weekly-report tamperEventLabel.
-- Chưa áp migration 22 thì Agent đẩy tray_stopped sẽ nhận lỗi
-- invalid_event_type và chỉ ghi log (fail-soft, không chặn watchdog).

-- ============ Mở rộng danh sách loại sự kiện can thiệp ============
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

  if p_event_type is null or p_event_type not in ('clock_drift', 'agent_restart', 'extension_missing', 'service_stopped', 'tray_stopped') then
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
grant execute on function public.safepc_push_tamper_event(uuid, text, text, jsonb) to anon, authenticated, service_role;

-- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ============
-- select pg_get_functiondef(oid) from pg_proc where proname = 'safepc_push_tamper_event';
-- Kỳ vọng: thân hàm chứa 'tray_stopped' trong danh sách not in (...).
