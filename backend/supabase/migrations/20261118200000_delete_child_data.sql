-- SafePC — Migration 15: xóa toàn bộ dữ liệu của một con
-- Ngày: 18/11/2026. Áp dụng qua Dashboard > SQL Editor (như migration 1-14),
-- chạy một lần, kiểm chứng bằng truy vấn ở cuối file (ghi chú).
--
-- Bối cảnh (PRD §2.8 + docs/03-SECURITY.md mục 5): phụ huynh được xuất dữ
-- liệu và xóa toàn bộ dữ liệu của con (cam kết riêng tư kiểu GDPR). Xuất
-- dữ liệu chạy ở Dashboard qua các truy vấn RLS thông thường, không cần
-- migration. Xóa thì cần RPC vì:
--   - bảng audit_logs / notification_sends / time_bank_grants chỉ có
--     policy SELECT cho user thường — Dashboard không tự xóa được;
--   - xóa phải nguyên tử: hồ sơ con + mọi hàng phụ thuộc phải đi cùng
--     nhau trong một transaction, không để lại hàng mồ côi.
--
-- Phạm vi xóa (một con, đúng gia đình của người gọi):
--   - hồ sơ children + mọi hàng CASCADE theo nó: rules, requests,
--     time_bank_grants, app_usage, web_visits;
--   - các máy của con (devices.child_id) + mọi hàng CASCADE theo máy:
--     device_tokens, commands, app_usage, web_visits;
--   - audit_logs + notification_sends gắn với con (child_id) hoặc gắn
--     với máy của con mà không gắn với con khác (tránh xóa nhầm dữ liệu
--     của con khác nếu máy từng được gán lại);
--   - pairing_codes của con.
-- KHÔNG xóa dữ liệu cấp gia đình: rule_templates, family_invites,
-- weekly_report_sends, notification_sends không gắn với con/máy nào.
-- Xóa cả gia đình / xóa tài khoản là việc riêng, chưa làm ở đợt này.
--
-- Sau khi xóa: Agent trên máy của con mất token nên không đồng bộ được
-- nữa (fail-closed); phụ huynh cần gỡ Agent hoặc ghép nối lại máy dưới
-- hồ sơ con khác. Dashboard nêu rõ điều này trước khi xóa.
--
-- RPC này chạy được cả khi migration 12 (notification_sends) hoặc 13
-- (time_bank_grants) chưa áp dụng: hai bảng đó được kiểm tra bằng
-- to_regclass và xóa bằng SQL động, bỏ qua khi bảng chưa tồn tại (kết
-- quả trả về ghi rõ bảng nào đã bỏ qua). Không có secret hay giá trị
-- thật nào trong file này. File chạy lại an toàn (CREATE OR REPLACE).

-- ============ Xóa toàn bộ dữ liệu của một con ============
-- Trả về: child_id, family_id, deleted (số hàng đã xóa theo từng bảng),
-- skipped_missing_tables (bảng tùy chọn chưa tồn tại nên đã bỏ qua).
-- Lũy đẳng theo nghĩa: gọi lại với con đã xóa thì báo 'child_not_found'
-- (không xóa gì thêm, không báo thành công giả).
create or replace function public.safepc_delete_child_data(
  p_child_id uuid
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_family_id uuid;
  v_deleted_rules integer := 0;
  v_deleted_requests integer := 0;
  v_deleted_grants integer := 0;
  v_deleted_usage integer := 0;
  v_deleted_visits integer := 0;
  v_deleted_commands integer := 0;
  v_deleted_tokens integer := 0;
  v_deleted_devices integer := 0;
  v_deleted_audit integer := 0;
  v_deleted_notifications integer := 0;
  v_deleted_pairing integer := 0;
  v_skipped text[] := '{}';
  v_has_notifications boolean := false;
  v_has_grants boolean := false;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated';
  end if;

  select family_id into v_family_id
  from public.children
  where id = p_child_id;
  if v_family_id is null then
    raise exception 'child_not_found';
  end if;

  -- Chỉ phụ huynh trong gia đình mới được xóa dữ liệu của con (cùng
  -- ranh giới RPC ngân hàng giờ ở migration 13; chặt hơn RLS
  -- is_family_member chung của app). family_id lấy từ hàng children
  -- phía server, không từ input client.
  if not exists (
    select 1 from public.family_members fm
    where fm.family_id = v_family_id
      and fm.user_id = auth.uid()
      and fm.role = 'parent'
  ) then
    raise exception 'not_a_parent';
  end if;

  -- Khóa theo con cho hết transaction: hai lần xóa cùng con chạy chồng
  -- nhau sẽ nối tiếp nhau, bên sau thấy con đã mất và báo
  -- 'child_not_found' thay vì xóa trùng. Đồng thời giữ cả khóa ngân
  -- hàng giờ của con để một lần thưởng/thu hồi đang chạy không kịp ghi
  -- lệnh xuống máy đang bị xóa (thứ tự khóa cố định ở mọi đường gọi
  -- nên không tạo chu trình kẹt khóa).
  perform pg_advisory_xact_lock(hashtext('safepc_delete_child_' || p_child_id::text));
  perform pg_advisory_xact_lock(hashtext('safepc_time_bank_' || p_child_id::text));

  -- Đọc lại sau khi giữ khóa: con có thể đã bị xóa bởi lần gọi trước
  -- trong khoảng giữa lần đọc đầu và lúc giữ được khóa.
  select family_id into v_family_id
  from public.children
  where id = p_child_id;
  if v_family_id is null then
    raise exception 'child_not_found';
  end if;

  -- Hai bảng tùy chọn (migration 12/13 có thể chưa áp dụng): kiểm tra
  -- tồn tại trước, chỉ chạm tới khi bảng có thật.
  v_has_notifications := to_regclass('public.notification_sends') is not null;
  v_has_grants := to_regclass('public.time_bank_grants') is not null;
  if not v_has_notifications then
    v_skipped := array_append(v_skipped, 'notification_sends');
  end if;
  if not v_has_grants then
    v_skipped := array_append(v_skipped, 'time_bank_grants');
  end if;

  -- Đếm trước các hàng sẽ mất theo CASCADE (để báo cáo trung thực số
  -- hàng đã xóa; các bảng xóa trực tiếp bên dưới đếm bằng row_count).
  select count(*) into v_deleted_rules
  from public.rules where child_id = p_child_id;
  select count(*) into v_deleted_requests
  from public.requests where child_id = p_child_id;
  select count(*) into v_deleted_usage
  from public.app_usage where child_id = p_child_id;
  select count(*) into v_deleted_visits
  from public.web_visits where child_id = p_child_id;
  select count(*) into v_deleted_commands
  from public.commands c
  where c.device_id in (
    select d.id from public.devices d
    where d.child_id = p_child_id and d.family_id = v_family_id
  );
  select count(*) into v_deleted_tokens
  from public.device_tokens t
  where t.device_id in (
    select d.id from public.devices d
    where d.child_id = p_child_id and d.family_id = v_family_id
  );
  if v_has_grants then
    execute 'select count(*) from public.time_bank_grants where child_id = $1'
      into v_deleted_grants using p_child_id;
  end if;

  -- 1. Nhật ký kiểm tra gắn với con, hoặc gắn với máy của con mà không
  -- gắn với con khác (máy có thể từng được gán lại cho con khác — hàng
  -- mang child_id của con khác phải được giữ nguyên).
  delete from public.audit_logs
  where child_id = p_child_id
     or (child_id is null and device_id in (
       select d.id from public.devices d
       where d.child_id = p_child_id and d.family_id = v_family_id
     ));
  get diagnostics v_deleted_audit = row_count;

  -- 2. Nhật ký gửi thông báo: cùng điều kiện như audit_logs. Bảng tùy
  -- chọn nên dùng SQL động với tham số (không nối chuỗi id vào câu
  -- lệnh — tên bảng là hằng số, id truyền qua USING).
  if v_has_notifications then
    execute $q$
      delete from public.notification_sends
      where child_id = $1
         or (child_id is null and device_id in (
           select d.id from public.devices d
           where d.child_id = $1 and d.family_id = $2
         ))
    $q$ using p_child_id, v_family_id;
    get diagnostics v_deleted_notifications = row_count;
  end if;

  -- 3. Mã ghép nối của con (chỉ còn hash; mã đang chờ mà bị xóa thì
  -- lần ghép nối đang chạy sẽ báo mã không hợp lệ — an toàn).
  delete from public.pairing_codes
  where child_id = p_child_id and family_id = v_family_id;
  get diagnostics v_deleted_pairing = row_count;

  -- 4. Các máy của con: CASCADE xóa device_tokens, commands, app_usage,
  -- web_visits của máy. Ràng buộc cả family_id để không chạm tới máy
  -- của gia đình khác dù child_id có trùng (không thể trùng vì id là
  -- uuid, nhưng giữ điều kiện cho rõ ranh giới).
  delete from public.devices
  where child_id = p_child_id and family_id = v_family_id;
  get diagnostics v_deleted_devices = row_count;

  -- 5. Hồ sơ con: CASCADE xóa rules, requests, time_bank_grants và mọi
  -- hàng app_usage / web_visits còn lại của con.
  delete from public.children
  where id = p_child_id;
  if not found then
    -- Không tới được sau lần đọc lại có khóa ở trên; giữ để không bao
    -- giờ báo thành công khi thực ra không xóa gì.
    raise exception 'child_not_found';
  end if;

  -- 6. Ghi lại việc xóa để phụ huynh còn lại thấy được trong nhật ký:
  -- chỉ giữ id của con đã xóa trong details, KHÔNG giữ tên hiển thị
  -- (xóa là xóa). Hàng này mang child_id null vì hàng children đã mất
  -- (khóa ngoại không cho giữ id đã xóa).
  insert into public.audit_logs (family_id, actor, action, target, details)
  values (
    v_family_id,
    auth.uid(),
    'child_data_deleted',
    null,
    jsonb_build_object(
      'deleted_child_id', p_child_id,
      'devices', v_deleted_devices,
      'rules', v_deleted_rules,
      'requests', v_deleted_requests,
      'time_bank_grants', v_deleted_grants,
      'app_usage', v_deleted_usage,
      'web_visits', v_deleted_visits,
      'commands', v_deleted_commands,
      'device_tokens', v_deleted_tokens,
      'audit_logs', v_deleted_audit,
      'notification_sends', v_deleted_notifications,
      'pairing_codes', v_deleted_pairing
    )
  );

  return jsonb_build_object(
    'child_id', p_child_id,
    'family_id', v_family_id,
    'deleted', jsonb_build_object(
      'devices', v_deleted_devices,
      'rules', v_deleted_rules,
      'requests', v_deleted_requests,
      'time_bank_grants', v_deleted_grants,
      'app_usage', v_deleted_usage,
      'web_visits', v_deleted_visits,
      'commands', v_deleted_commands,
      'device_tokens', v_deleted_tokens,
      'audit_logs', v_deleted_audit,
      'notification_sends', v_deleted_notifications,
      'pairing_codes', v_deleted_pairing
    ),
    'skipped_missing_tables', to_jsonb(v_skipped)
  );
end;
$$;

-- Chỉ tài khoản đã đăng nhập (vai trò authenticated) được gọi RPC này;
-- kiểm tra phụ huynh nằm trong thân hàm. Thu hồi quyền mặc định của
-- public trước (theo mẫu migration 3 và 13).
revoke execute on function public.safepc_delete_child_data(uuid) from public;
grant execute on function public.safepc_delete_child_data(uuid) to authenticated;

-- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ===========
-- 1. RPC đã tạo:
-- select proname from pg_proc where proname = 'safepc_delete_child_data';
-- Kỳ vọng: 1 hàm.
--
-- 2. Chỉ kiểm chứng xóa thật trên HỒ SƠ CON DÙNG ĐỂ THỬ (xóa là không
-- thể hoàn tác): tạo một hồ sơ con thử, ghép nối nếu muốn, rồi gọi từ
-- Dashboard (tab Dữ liệu trong hồ sơ con đó) và đối chiếu số hàng trả
-- về với các truy vấn dưới đây trước/sau khi xóa. Không gọi RPC này
-- với hồ sơ con thật để "thử".
-- select count(*) from public.children where id = '<id con thử>';
-- select count(*) from public.devices where child_id = '<id con thử>';
-- select count(*) from public.rules where child_id = '<id con thử>';
-- select count(*) from public.audit_logs where action = 'child_data_deleted' order by created_at desc limit 1;
-- Kỳ vọng sau khi xóa: 0, 0, 0, và 1 hàng audit 'child_data_deleted'
-- mang details.deleted_child_id đúng id con thử.
