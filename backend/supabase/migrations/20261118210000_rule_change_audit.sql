-- SafePC — Migration 16: nhật ký đổi quy tắc (lịch sử đổi rule)
-- Ngày: 18/11/2026. Áp dụng qua Dashboard > SQL Editor (như migration 1-15),
-- chạy một lần, kiểm chứng bằng truy vấn ở cuối file (ghi chú).
--
-- Bối cảnh (PRD §2.8, follow-up của đợt nhật ký hoạt động): tab Nhật ký
-- chưa có nguồn cho "ai đổi quy tắc nào" — bảng rules không có lịch sử
-- sửa đổi và Dashboard không ghi audit khi sửa rule. Migration này cho
-- phép Dashboard tự ghi một hàng audit_logs mỗi khi phụ huynh tạo/sửa/
-- xóa/bật/tắt quy tắc hoặc tạo/sửa/xóa/áp dụng mẫu quy tắc, để tab Nhật
-- ký hiển thị được lịch sử đó. Lịch sử chỉ bắt đầu từ khi migration này
-- được áp + Dashboard mới được triển khai; thay đổi trước đó không có.
--
-- Vì sao dùng RPC thay vì thêm policy INSERT cho audit_logs: bảng
-- audit_logs chỉ có policy SELECT "family read" (migration 1) và là
-- nguồn của cả cảnh báo can thiệp lẫn đếm thi hành theo quy tắc. Một
-- policy INSERT cho phép ghi action tùy ý sẽ cho phép giả mạo cả sự
-- kiện can thiệp/thi hành. RPC SECURITY DEFINER dưới đây theo đúng mẫu
-- safepc_push_tamper_event (migration 5) / safepc_push_enforcement_event
-- (migration 10): action chỉ nhận 10 giá trị cho phép, actor luôn là
-- auth.uid(), con (nếu có) phải thuộc đúng gia đình, details cắt tối
-- đa 2KB. KHÔNG đổi RLS: không thêm policy nào cho audit_logs.
--
-- Không có secret hay giá trị thật nào trong file này. File chạy lại an
-- toàn (CREATE OR REPLACE, REVOKE/GRANT lặp lại được).

-- ============ RPC ghi một lần đổi quy tắc / mẫu quy tắc ===========
-- p_family_id: gia đình sở hữu quy tắc/mẫu. Người gọi phải là phụ huynh
--   (role 'parent') của đúng gia đình này — chặt hơn RLS is_family_member
--   chung, vì đây là hành động của riêng phụ huynh.
-- p_child_id: con gắn với quy tắc; NULL cho sự kiện ở cấp mẫu (tạo/sửa/
--   xóa mẫu không gắn với con nào). Khi có thì con phải thuộc gia đình
--   trên — không tin client mù.
-- p_action: 10 giá trị cho phép (xem kiểm tra bên dưới). Nhóm rule và
--   nhóm template không được trộn với p_child_id sai nhóm.
-- p_target: id quy tắc/mẫu dạng text (id mẫu sẵn: 'school'/'weekend'/
--   'holiday'/'edge_only'); NULL khi không có id (không bắt buộc).
-- p_details: chi tiết dễ đọc (tên quy tắc/mẫu, loại, tóm tắt cấu hình,
--   số quy tắc trong mẫu...). Cắt tối đa 2KB như các RPC ghi audit khác;
--   JSON hỏng sau khi cắt thì dùng '{}', không làm lỗi cả lần gọi.
-- Trả về id hàng audit_logs vừa ghi.
create or replace function public.safepc_log_rule_change(
  p_family_id uuid,
  p_child_id uuid,
  p_action text,
  p_target text,
  p_details jsonb
)
returns uuid
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_details jsonb;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated';
  end if;
  if p_family_id is null then
    raise exception 'family_not_found';
  end if;
  if p_action is null or p_action not in (
    'rule_created', 'rule_updated', 'rule_deleted', 'rule_enabled', 'rule_disabled',
    'template_created', 'template_updated', 'template_deleted',
    'template_applied', 'preset_applied'
  ) then
    raise exception 'invalid_action';
  end if;

  -- Chỉ phụ huynh trong gia đình mới được ghi nhật ký đổi quy tắc.
  if not exists (
    select 1 from public.family_members fm
    where fm.family_id = p_family_id
      and fm.user_id = auth.uid()
      and fm.role = 'parent'
  ) then
    raise exception 'not_a_parent';
  end if;

  -- Con (nếu có) phải thuộc đúng gia đình này.
  if p_child_id is not null and not exists (
    select 1 from public.children c
    where c.id = p_child_id and c.family_id = p_family_id
  ) then
    raise exception 'child_not_in_family';
  end if;

  -- Nhóm action phải khớp với p_child_id: sự kiện gắn với con (quy tắc
  -- hoặc áp mẫu cho một con) bắt buộc có child; sự kiện ở cấp mẫu (tạo/
  -- sửa/xóa mẫu) bắt buộc không có child. Trộn hai nhóm là lỗi gọi.
  if p_child_id is not null and p_action in ('template_created', 'template_updated', 'template_deleted') then
    raise exception 'invalid_action_for_child';
  end if;
  if p_child_id is null and p_action not in ('template_created', 'template_updated', 'template_deleted') then
    raise exception 'invalid_action_for_family';
  end if;

  begin
    v_details := left(coalesce(p_details, '{}'::jsonb)::text, 2000)::jsonb;
  exception when others then
    v_details := '{}'::jsonb;
  end;

  insert into public.audit_logs (family_id, child_id, device_id, actor, action, target, ip_hash, details)
  values (p_family_id, p_child_id, null, auth.uid(), p_action, p_target, null, v_details)
  returning id into v_id;

  return v_id;
end;
$$;

-- Chỉ tài khoản đã đăng nhập (vai trò authenticated) được gọi RPC này;
-- kiểm tra phụ huynh nằm trong thân hàm. Thu hồi quyền mặc định của
-- public trước (theo mẫu migration 3, 13 và 15).
revoke execute on function public.safepc_log_rule_change(uuid, uuid, text, text, jsonb) from public;
grant execute on function public.safepc_log_rule_change(uuid, uuid, text, text, jsonb) to authenticated;

-- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ===========
-- 1. RPC đã tạo:
-- select proname from pg_proc where proname = 'safepc_log_rule_change';
-- Kỳ vọng: 1 hàm.
--
-- 2. Quyền gọi: chỉ authenticated (public đã bị thu hồi):
-- select grantee, privilege_type from information_schema.routine_privileges
--   where routine_name = 'safepc_log_rule_change' order by grantee;
-- Kỳ vọng: không có hàng grantee = 'PUBLIC'; có hàng authenticated.
--
-- 3. RLS của audit_logs không đổi (vẫn chỉ có policy SELECT):
-- select policyname, cmd from pg_policies
--   where schemaname = 'public' and tablename = 'audit_logs' order by policyname;
-- Kỳ vọng: đúng 1 policy "family read", cmd = SELECT.
--
-- 4. Ghi thử đầu-cuối từ Dashboard (sau khi deploy bản mới): đổi một quy
-- tắc bất kỳ trên trang Quy tắc rồi kiểm tra hàng mới nhất:
-- select action, target, actor, child_id, details from public.audit_logs
--   where action like 'rule_%' or action like 'template_%' or action = 'preset_applied'
--   order by created_at desc limit 1;
-- Kỳ vọng: 1 hàng với action đúng thao tác vừa làm, actor = id tài khoản
-- phụ huynh vừa đăng nhập, details mang tên quy tắc/mẫu.
