-- SafePC — Migration 6: trạng thái thi hành trên máy con (enforcement state)
-- Ngày: 16/11/2026. Áp dụng qua Supabase Dashboard > SQL Editor (như migration 1-5),
-- chạy một lần, kiểm chứng bằng truy vấn ở cuối file (ghi chú).
--
-- Bối cảnh: Dashboard cần biết máy con ĐANG thi hành gì (đang cho phép,
-- cảnh báo, hay khóa — và khóa bởi cái gì) mà không cần đọc log trên máy.
-- Agent dựng một snapshot JSON nhỏ ở mỗi lần kiểm tra rules (15s) và báo
-- lên đây khi nội dung đổi, tối đa 1 lần/5 phút. Snapshot chỉ mang quyết
-- định + id rule + tên exe đang bị chặn + cờ focus/domain — KHÔNG mang tiêu
-- đề cửa sổ, URL, nội dung hay tên con (docs/03-SECURITY.md mục 3).
--
-- Hợp đồng snapshot (Agent ghi, Dashboard đọc — tên trường LITERAL):
-- {"v":1,"at":ISO,"decision":"allow"|"warn"|"lock",
--  "lockedBy":null|"forced"|"rule"|"override"|"break",
--  "reasons":[rule-type strings],"ruleIds":[uuid strings],
--  "appBlocks":[exe names],"domainRulesActive":bool,"focusActive":bool}
--
-- KHÔNG đổi RLS: devices đã có policy "family access" (migration 1) — policy
-- áp cho cả hàng nên 2 cột mới tự động nằm trong cùng ranh giới family_id.
-- Không thêm policy nào. RPC SET search_path cố định (public, extensions)
-- như mọi hàm safepc_* khác. Mọi câu đều idempotent (IF NOT EXISTS /
-- CREATE OR REPLACE). Không overload hàm nào đã có (grep migrations 1-5:
-- chưa có hàm tên safepc_report_enforcement).

-- ============ 1. Cột enforcement_json / enforcement_updated_at cho devices ============
alter table public.devices add column if not exists enforcement_json jsonb not null default '{}'::jsonb;
alter table public.devices add column if not exists enforcement_updated_at timestamptz;

-- ============ 2. Báo trạng thái thi hành: chỉ cập nhật đúng 2 cột trên ============
-- p_payload null hoặc dài quá 4KB (dạng text) thì lỗi invalid_payload:
-- snapshot của Agent luôn dưới 1KB, payload lớn hơn là bất thường.
-- enforcement_updated_at luôn lấy giờ server (now()), không tin đồng hồ máy con.
create or replace function public.safepc_report_enforcement(
  p_device_id uuid,
  p_token_hash text,
  p_payload jsonb
)
returns void
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_device public.devices;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  if p_payload is null or length(p_payload::text) > 4096 then
    raise exception 'invalid_payload' using errcode = 'P0001';
  end if;

  update public.devices
  set enforcement_json = p_payload,
      enforcement_updated_at = now()
  where id = v_device.id;
end;
$$;

-- ============ Quyền gọi qua PostgREST (khóa publishable dùng role anon) ============
grant execute on function public.safepc_report_enforcement(uuid, text, jsonb) to anon, authenticated, service_role;

-- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ============
-- select proname from pg_proc where proname like 'safepc\_%' order by proname;
-- Kỳ vọng 11 hàm: safepc_ack_device_command, safepc_auth_device,
-- safepc_device_heartbeat, safepc_fetch_device_commands, safepc_fetch_device_rules,
-- safepc_push_device_usage, safepc_push_tamper_event, safepc_push_web_visits,
-- safepc_redeem_pairing_code, safepc_report_enforcement,
-- safepc_report_extension_heartbeat (10 hàm của migration 3-5 + 1 hàm mới).
-- select column_name, data_type, column_default from information_schema.columns
--   where table_schema = 'public' and table_name = 'devices'
--     and column_name in ('enforcement_json', 'enforcement_updated_at') order by column_name;
-- Kỳ vọng 2 dòng: enforcement_json | jsonb với default '{}'::jsonb,
-- enforcement_updated_at | timestamp with time zone (không default).
