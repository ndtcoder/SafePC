-- SafePC — Migration 10: lịch sử thi hành theo quy tắc + cờ chặn cho lượt thăm web
-- Ngày: 18/11/2026. Áp dụng qua Supabase Dashboard > SQL Editor (như migration 1-9),
-- chạy một lần, kiểm chứng bằng truy vấn ở cuối file (ghi chú).
--
-- Bối cảnh: trang Báo cáo tuần (PRD §2.10, mục 4) cần số lần thi hành theo
-- loại (khóa theo từng loại, chặn ứng dụng, cảnh báo, nghỉ bắt buộc), nhưng
-- database chưa có lịch sử thi hành: Agent chỉ gửi ảnh chụp trạng thái hiện
-- tại (devices.enforcement_json, migration 6), audit_logs chỉ có 4 loại sự
-- kiện can thiệp (migration 5), và web_visits.blocked luôn false vì RPC đẩy
-- lượt thăm không insert cột đó (migration 4). Migration này:
--
-- 1. Thêm RPC safepc_push_enforcement_event: ghi một sự kiện thi hành vào
--    bảng audit_logs sẵn có (đã có child_id/device_id/details từ migration
--    5, đã có index theo family/action). KHÔNG tạo bảng mới: sự kiện thi
--    hành và sự kiện can thiệp có cùng hình dạng (một hành động + chi tiết
--    JSON) và cùng ranh giới đọc (policy "family read" của migration 1).
--    RPC mới là bắt buộc thay vì nới lỏng safepc_push_tamper_event: RPC
--    tamper giới hạn p_event_type ở 4 giá trị can thiệp, và nới lỏng nó
--    sẽ trộn hai nhóm sự kiện có ngữ nghĩa khác nhau vào cùng một cửa.
--    RPC mới giới hạn p_event_type ở 4 giá trị thi hành:
--      lock_started   — màn hình khóa vừa hiện do quy tắc giờ giấc
--                       (details: kind = bedtime|time_window|daily_limit|rule,
--                       rule_ids = id các rule gây khóa).
--      break_started  — giờ nghỉ bắt buộc vừa bắt đầu
--                       (details: work_minutes, break_minutes, rule_ids).
--      app_blocked    — một ứng dụng vừa bị đóng do vi phạm quy tắc
--                       (details: exe, kind = block|block_by_time|time_limit|
--                       focus|allowlist|temp_block).
--      warning_shown  — một cửa sổ cảnh báo vừa hiện cho con
--                       (details: kind = deadline|pending_lock|app_window|
--                       app_limit, minutes_left, exe với kind app_*).
--    Agent chỉ ghi CHUYỂN TRẠNG THÁI (khóa bắt đầu, nghỉ bắt đầu, lần đóng
--    app, lần hiện cảnh báo), không ghi mỗi vòng kiểm tra 15 giây.
--    Khóa do phụ huynh (lock_now / ghi đè khóa) KHÔNG ghi ở đây: lệnh của
--    phụ huynh đã đếm được từ bảng commands, ghi thêm sẽ đếm trùng.
-- 2. Sửa RPC safepc_push_web_visits (cùng chữ ký, CREATE OR REPLACE): mỗi
--    sample nhận thêm trường blocked tùy chọn; thiếu thì coi là false
--    (client cũ gửi sample không có blocked vẫn chạy đúng). Extension báo
--    lượt web bị chặn qua cùng kênh reportUsage với duration_sec = 0.
--
-- KHÔNG đổi RLS: audit_logs/web_visits đã có policy "family access"/"family
-- read" (migration 1) — policy áp cho cả hàng nên không cần thêm policy.
-- Các hàm SET search_path cố định (public, extensions) như mọi hàm safepc_*
-- khác. Mọi câu đều idempotent (CREATE OR REPLACE). Không overload hàm nào
-- đã có (grep migrations 1-9: chưa có hàm tên safepc_push_enforcement_event).
--
-- Tương thích ngược: Agent/extension mới chạy trước khi migration này được
-- áp thì RPC chưa tồn tại — PostgREST trả lỗi, Agent ghi log throttle và
-- bỏ qua (không crash, không retry bão). Dữ liệu thi hành chỉ bắt đầu có
-- từ khi migration được áp + bản mới được cài; trang Báo cáo tuần ghi rõ
-- điều này thay vì hiện 0 như thể không có thi hành.

-- ============ 1. Ghi một sự kiện thi hành vào audit_logs ============
-- Mirror safepc_push_tamper_event (migration 5): xác thực bằng
-- safepc_auth_device, family/child/device suy ra từ hàng devices đã xác
-- thực (không tin client), action ghi đúng p_event_type, target là id
-- device dạng text, actor/ip_hash để NULL (sự kiện từ máy con, không phải
-- hành động của user đăng nhập). details cắt tối đa 2KB: cắt chuỗi JSON
-- rồi parse lại trong khối BEGIN/EXCEPTION — JSON hỏng sau khi cắt (hoặc
-- p_details null) thì dùng '{}'::jsonb, không bao giờ làm lỗi cả lần gọi
-- vì chi tiết kèm theo.
create or replace function public.safepc_push_enforcement_event(
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

  if p_event_type is null or p_event_type not in ('lock_started', 'break_started', 'app_blocked', 'warning_shown') then
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

-- ============ 2. Đẩy batch web visits: nhận thêm cờ blocked từng sample ============
-- Cùng chữ ký (uuid, text, jsonb) nên CREATE OR REPLACE thay thế đúng hàm
-- của migration 4, không tạo overload. Sample thiếu trường blocked (client
-- cũ) thì jsonb_to_recordset trả NULL và coalesce thành false — hành vi cũ
-- giữ nguyên. Lượt bị chặn có duration_sec = 0 (không xem được gì).
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

  insert into public.web_visits (family_id, device_id, child_id, domain, visited_at, duration_sec, blocked)
  select
    v_device.family_id,
    v_device.id,
    v_device.child_id,
    left(s.domain, 253),
    s.visited_at,
    least(greatest(coalesce(s.duration_sec, 0), 0), 86400),
    coalesce(s.blocked, false)
  from jsonb_to_recordset(p_samples)
    as s(domain text, visited_at timestamptz, duration_sec int, blocked boolean)
  where s.domain is not null and length(trim(s.domain)) > 0
    and s.visited_at is not null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ============ Quyền gọi qua PostgREST (khóa publishable dùng role anon) ============
grant execute on function public.safepc_push_enforcement_event(uuid, text, text, jsonb) to anon, authenticated, service_role;
grant execute on function public.safepc_push_web_visits(uuid, text, jsonb) to anon, authenticated, service_role;

-- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ============
-- select proname from pg_proc where proname like 'safepc\_%' order by proname;
-- Kỳ vọng 14 hàm: safepc_ack_device_command, safepc_auth_device,
-- safepc_clear_exit_pin, safepc_device_heartbeat, safepc_fetch_device_commands,
-- safepc_fetch_device_rules, safepc_push_device_usage, safepc_push_enforcement_event,
-- safepc_push_extra_time_request, safepc_push_tamper_event, safepc_push_web_visits,
-- safepc_redeem_pairing_code, safepc_report_enforcement,
-- safepc_report_extension_heartbeat (13 hàm của migration 3-9 + 1 hàm mới;
-- safepc_push_web_visits chỉ thay thế, không tăng số lượng).
-- select pg_get_function_identity_arguments('public.safepc_push_web_visits(uuid, text, jsonb)'::regprocedure);
-- Kỳ vọng: không lỗi, 1 hàm duy nhất với chữ ký (uuid, text, jsonb) — không overload.
