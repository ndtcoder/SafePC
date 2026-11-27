-- SafePC — Migration 25: tài khoản Windows Tray đã thấy (device_seen_accounts)
-- Ngày: 21/11/2026. Áp dụng qua Dashboard > SQL Editor (như migration
-- 1-24), chạy một lần, kiểm chứng bằng truy vấn ở cuối file (ghi chú).
--
-- Bối cảnh (PRD §2.11, Sprint 5 đợt Dashboard): danh sách tài khoản
-- Windows mà Tray "nhìn thấy" trên máy (phiên hello: SessionId /
-- UserName / IsAdmin / SID) trước đây chỉ nằm trong bộ nhớ của Service,
-- nên Dashboard không thể liệt kê để phụ huynh CHỌN khi gắn tài khoản
-- với hồ sơ con (đợt Dashboard phải đọc best-effort và hiện ghi chú
-- "chưa có dữ liệu" khi bảng chưa tồn tại). Migration này thêm đúng
-- thiết kế đã chốt trong ghi chú ở apps/dashboard-web/src/lib/
-- deviceChildren.ts:
--
-- 1. Bảng device_seen_accounts: một hàng cho mỗi (máy, tài khoản
--    Windows) Tray từng thấy — SID, username, có phải admin, lần cuối
--    thấy. RLS "family access" như device_child_accounts (migration
--    24): Dashboard đọc thẳng qua RLS như mọi bảng khác, không cần RPC
--    đọc riêng.
-- 2. RPC safepc_report_seen_account: Service báo một tài khoản vừa
--    thấy; xác thực thiết bị bằng safepc_auth_device (migration 3),
--    family_id lấy từ chính device đã xác thực (không nhận từ tham
--    số), upsert theo (device_id, windows_sid) — báo lại chỉ cập nhật
--    username/is_admin/last_seen_at, không tạo hàng trùng.
-- 3. Lịch cron dọn hàng cũ: tài khoản quá 30 ngày không thấy lại thì
--    xóa (thiết kế gốc: "có thể dọn bằng cron" — làm theo nhánh này để
--    bảng không tích hàng ươn của tài khoản khách/ngắn hạn).
--
-- YÊU CẦU: migration 24 ĐÃ ÁP TRƯỚC (cùng đợt Sprint 5; RLS dùng
-- is_family_member của migration 1 và mẫu policy của
-- device_child_accounts ở migration 24).
--
-- Phía Service gọi RPC này mỗi khi Tray hello (một phiên), khi phát
-- hiện đổi phiên console, và làm mới định kỳ — phần gọi nằm ở bản
-- Agent đi cùng đợt Sprint 5 (điểm thu thập: hello trong
-- IpcPipeServer + phát hiện đổi phiên trong AgentWorker).
--
-- Không có secret hay giá trị thật nào trong file này. File chạy lại
-- an toàn (IF NOT EXISTS, DROP POLICY IF EXISTS, CREATE OR REPLACE,
-- gỡ lịch cron trước khi tạo lại).

-- ============ 1. Bảng tài khoản Windows đã thấy ============
create table if not exists public.device_seen_accounts (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  windows_sid text not null,
  windows_username text,
  is_admin boolean not null default false,
  last_seen_at timestamptz not null default now(),
  unique (device_id, windows_sid)
);

create index if not exists device_seen_accounts_device_idx
  on public.device_seen_accounts (device_id);

alter table public.device_seen_accounts enable row level security;

-- "family access" như device_child_accounts (migration 24): thành
-- viên gia đình đọc/ghi trong phạm vi gia đình mình; đường ghi thật
-- duy nhất là RPC SECURITY DEFINER ở mục 2 (Agent không có tài khoản
-- người dùng), policy này chủ yếu phục vụ Dashboard đọc trực tiếp.
drop policy if exists "family access" on public.device_seen_accounts;
create policy "family access" on public.device_seen_accounts
  for all using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));

-- ============ 2. RPC: Service báo một tài khoản Windows vừa thấy ============
-- Upsert theo (device_id, windows_sid): lần đầu chèn hàng mới, lần sau
-- chỉ cập nhật username/is_admin/last_seen_at. SID rỗng/toàn khoảng
-- trắng bị từ chối (P0001) — hàng không SID không có giá trị gắn con.
-- Trả về jsonb {device_id, windows_sid, last_seen_at}.
create or replace function public.safepc_report_seen_account(
  p_device_id uuid,
  p_token_hash text,
  p_windows_sid text,
  p_windows_username text,
  p_is_admin boolean
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_device public.devices;
  v_sid text;
  v_seen_at timestamptz;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  v_sid := nullif(trim(coalesce(p_windows_sid, '')), '');
  if v_sid is null or char_length(v_sid) > 256 then
    raise exception 'invalid_windows_sid' using errcode = 'P0001';
  end if;

  insert into public.device_seen_accounts (family_id, device_id, windows_sid, windows_username, is_admin, last_seen_at)
  values (
    v_device.family_id,
    v_device.id,
    v_sid,
    nullif(left(trim(coalesce(p_windows_username, '')), 200), ''),
    coalesce(p_is_admin, false),
    now()
  )
  on conflict (device_id, windows_sid) do update
    set windows_username = excluded.windows_username,
        is_admin = excluded.is_admin,
        last_seen_at = excluded.last_seen_at
  returning last_seen_at into v_seen_at;

  return jsonb_build_object(
    'device_id', v_device.id,
    'windows_sid', v_sid,
    'last_seen_at', v_seen_at
  );
end;
$$;

-- Thu hồi quyền mặc định của public trước (theo mẫu safepc_auth_device
-- ở migration 3), rồi cấp cho 3 vai trò như các RPC khác của Agent.
revoke execute on function public.safepc_report_seen_account(uuid, text, text, text, boolean) from public;
grant execute on function public.safepc_report_seen_account(uuid, text, text, text, boolean) to anon, authenticated, service_role;

-- ============ 3. Lịch dọn hàng quá 30 ngày không thấy lại ============
-- pg_cron đã bật từ migration 11; IF NOT EXISTS để file chạy được độc
-- lập nếu lịch đó chưa từng áp dụng (mẫu migration 19/23/28).
create extension if not exists pg_cron with schema extensions;

-- Gỡ lịch cũ cùng tên nếu có (chạy lại file an toàn): câu SELECT dưới
-- đây không làm gì khi chưa có job nào tên này.
select cron.unschedule(jobid) from cron.job where jobname = 'safepc-seen-accounts-cleanup';

-- 04:00 UTC mỗi ngày (sau hai lịch dọn 03:00/03:30 của migration
-- 19/28). Lệnh DELETE trực tiếp, không secret, không gọi HTTP nên
-- không cần pg_net.
select cron.schedule(
  'safepc-seen-accounts-cleanup',
  '0 4 * * *',
  $cron$delete from public.device_seen_accounts where last_seen_at < now() - interval '30 days';$cron$
);

-- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ============
-- 1. Bảng + cột + ràng buộc duy nhất:
-- select column_name from information_schema.columns where table_name = 'device_seen_accounts' order by ordinal_position;
-- Kỳ vọng 7 cột: id, family_id, device_id, windows_sid, windows_username, is_admin, last_seen_at.
-- select conname from pg_constraint where conrelid = 'public.device_seen_accounts'::regclass and contype = 'u';
-- Kỳ vọng: 1 ràng buộc unique trên (device_id, windows_sid).
--
-- 2. RLS + policy:
-- select relrowsecurity from pg_class where relname = 'device_seen_accounts';
-- Kỳ vọng true.
-- select policyname, cmd from pg_policies where tablename = 'device_seen_accounts';
-- Kỳ vọng: 1 policy "family access" (ALL).
--
-- 3. RPC đúng 1 hàm, đúng chữ ký:
-- select pg_get_function_identity_arguments('public.safepc_report_seen_account(uuid, text, text, text, boolean)'::regprocedure);
-- Kỳ vọng: không lỗi.
--
-- 4. Lịch dọn:
-- select jobname, schedule, active from cron.job where jobname = 'safepc-seen-accounts-cleanup';
-- Kỳ vọng 1 dòng: safepc-seen-accounts-cleanup, '0 4 * * *', active = true.
--
-- 5. Sau khi Agent bản Sprint 5 chạy và có Tray đăng nhập trên máy:
-- select device_id, windows_username, is_admin, last_seen_at from public.device_seen_accounts order by last_seen_at desc limit 10;
-- Kỳ vọng: có hàng cho mỗi tài khoản Windows đã đăng nhập trên máy, last_seen_at cập nhật theo hello/đổi phiên.
