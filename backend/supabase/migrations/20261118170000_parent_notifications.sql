-- SafePC — Migration 12: nhật ký gửi email thông báo cho phụ huynh + lịch quét sự kiện
-- Ngày: 18/11/2026. Áp dụng qua Dashboard > SQL Editor (như migration 1-11),
-- chạy một lần, kiểm chứng bằng truy vấn ở cuối file (ghi chú).
--
-- Bối cảnh: Edge Function send-parent-notifications gửi email cho phụ huynh
-- khi có sự kiện cần chú ý (PRD §2.8): con xin thêm giờ / xin mở ứng dụng,
-- phát hiện can thiệp, máy offline bất thường. Function chạy quét định kỳ
-- (không dùng trigger — xem lý do ở đầu file function), và bảng dưới đây
-- là khóa chống gửi trùng: mỗi sự kiện có đúng một hàng.
--
-- Migration này:
--
-- 1. Bật extension pg_cron (lịch) + pg_net (gọi HTTP từ lịch) nếu chưa có
--    (migration 11 đã bật; câu IF NOT EXISTS chạy lại không lỗi).
-- 2. Tạo bảng notification_sends: một hàng cho mỗi sự kiện đã xử lý, khóa
--    duy nhất (kind, event_key). RLS bật, phụ huynh chỉ đọc được hàng của
--    gia đình mình; chỉ vai trò quản trị (Edge Function) ghi được, qua ba
--    RPC dưới đây.
-- 3. Ba RPC giữ chỗ / ghi nhận đã gửi / ghi dấu bỏ qua (xem chi tiết ở từng
--    hàm). Chỗ giữ kẹt ở trạng thái đang gửi quá 1 giờ (function chết giữa
--    chừng) sẽ được thu hồi để lần quét sau gửi lại được.
-- 4. Lịch cron 'safepc-parent-notifications': mỗi 5 phút gọi Edge Function
--    qua pg_net.
--
-- QUAN TRỌNG — SECRET TRONG LỊCH CRON: câu lệnh cron ở mục 4 chứa một
-- placeholder (chuỗi duy nhất có dạng <...> trong file). TRƯỚC KHI BẤM
-- RUN, anh Tiến phải thay placeholder đó bằng ĐÚNG chuỗi secret đã đặt
-- trong Edge Function Secrets (WEEKLY_REPORT_SECRET) — cùng một chuỗi đã
-- dùng cho lịch báo cáo tuần ở migration 11, xem docs/07-NOTIFICATIONS-SETUP.md.
-- Không để giá trị thật nào khác trong file này. Secret sẽ hiện trong
-- định nghĩa job (người có quyền đọc database xem được) — đó là đánh đổi
-- đã biết của mẫu pg_cron + pg_net, xem mục "nâng cao" trong docs/06 nếu
-- muốn giấu secret trong Vault.
--
-- Múi giờ của lịch: pg_cron chạy theo múi giờ của database (UTC trên
-- project này). Lịch quét mỗi 5 phút nên múi giờ không ảnh hưởng giờ gửi.

-- ============ 1. Extension pg_cron + pg_net ============
-- IF NOT EXISTS: đã bật rồi thì bỏ qua, không lỗi.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- ============ 2. Bảng nhật ký gửi thông báo ============
-- IF NOT EXISTS + DROP POLICY IF EXISTS: file chạy lại được an toàn
-- (trường hợp anh Tiến cần sửa placeholder secret rồi chạy lại).
create table if not exists public.notification_sends (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  -- Loại sự kiện: 'request' (xin thêm giờ / xin mở app), 'tamper' (can
  -- thiệp), 'device_offline' (máy offline bất thường).
  kind text not null check (kind in ('request', 'tamper', 'device_offline')),
  -- Khóa chống trùng của sự kiện: id hàng requests / id hàng audit_logs /
  -- khóa đợt offline '<device_id>@<last_seen_at dạng mili-giây>'.
  event_key text not null,
  -- 'sending': đang giữ chỗ gửi; 'sent': đã gửi; 'skipped': bỏ qua (vd
  -- yêu cầu đã được quyết định trước lúc gửi); 'throttled': bỏ qua do
  -- chặn spam (can thiệp cùng máy + cùng loại trong 6 giờ).
  status text not null check (status in ('sending', 'sent', 'skipped', 'throttled')),
  -- Máy và loại can thiệp của sự kiện (để truy vấn chặn spam); null khi
  -- sự kiện không gắn với máy/loại cụ thể.
  device_id uuid references public.devices (id) on delete set null,
  action text,
  -- Con gắn với sự kiện (để truy vấn chặn spam yêu cầu theo con); null
  -- khi sự kiện không gắn với con cụ thể.
  child_id uuid references public.children (id) on delete set null,
  -- Lúc giữ chỗ; claim kẹt ở 'sending' quá 1 giờ thì RPC claim thu hồi.
  claimed_at timestamptz not null default now(),
  sent_at timestamptz,
  -- Id trả về bởi dịch vụ gửi email (để đối chiếu khi cần tra cứu).
  resend_id text,
  recipients text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (kind, event_key)
);

alter table public.notification_sends enable row level security;

drop policy if exists "family read" on public.notification_sends;
create policy "family read" on public.notification_sends
  for select using (public.is_family_member(family_id));
-- Không có policy ghi cho user thường: chỉ Edge Function (qua RPC
-- SECURITY DEFINER bên dưới) được ghi vào bảng này.

-- Index phục vụ truy vấn chặn spam: email can thiệp đã gửi gần đây theo
-- từng máy + loại, và email yêu cầu đã gửi gần đây theo từng con.
create index if not exists notification_sends_throttle_idx
  on public.notification_sends (device_id, action, sent_at desc)
  where status = 'sent' and kind = 'tamper';

create index if not exists notification_sends_request_throttle_idx
  on public.notification_sends (child_id, sent_at desc)
  where status = 'sent' and kind = 'request';

-- ============ 3a. Giữ chỗ gửi cho một sự kiện ============
-- Trả true khi giữ chỗ thành công (sự kiện chưa được xử lý), false khi đã
-- có hàng (đã gửi / đang gửi / đã bỏ qua). Claim kẹt ở 'sending' quá 1
-- giờ được thu hồi nguyên tử (UPDATE có điều kiện).
create or replace function public.safepc_claim_notification(
  p_family_id uuid,
  p_kind text,
  p_event_key text,
  p_device_id uuid,
  p_action text,
  p_child_id uuid
)
returns boolean
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_id uuid;
begin
  insert into public.notification_sends (family_id, kind, event_key, status, device_id, action, child_id)
  values (p_family_id, p_kind, p_event_key, 'sending', p_device_id, p_action, p_child_id)
  on conflict (kind, event_key) do nothing
  returning id into v_id;
  if found then
    return true;
  end if;

  update public.notification_sends
  set claimed_at = now()
  where kind = p_kind
    and event_key = p_event_key
    and status = 'sending'
    and claimed_at < now() - interval '1 hour'
  returning id into v_id;
  return found;
end;
$$;

-- ============ 3b. Ghi nhận kết quả gửi ============
-- ok = true: đánh dấu 'sent' kèm id trả về và danh sách người nhận.
-- ok = false: xóa chỗ giữ 'sending' để lần quét sau gửi lại được (hàng
-- 'sent'/'skipped'/'throttled' không bao giờ bị xóa ở đây — gửi trùng
-- phải xóa tay, xem docs/07-NOTIFICATIONS-SETUP.md mục 7).
create or replace function public.safepc_finish_notification(
  p_kind text,
  p_event_key text,
  p_ok boolean,
  p_resend_id text default null,
  p_recipients text[] default '{}'
)
returns void
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
begin
  if p_ok then
    update public.notification_sends
    set status = 'sent',
        sent_at = now(),
        resend_id = p_resend_id,
        recipients = p_recipients
    where kind = p_kind
      and event_key = p_event_key;
  else
    delete from public.notification_sends
    where kind = p_kind
      and event_key = p_event_key
      and status = 'sending';
  end if;
end;
$$;

-- ============ 3c. Ghi dấu cuối cho sự kiện không gửi ============
-- p_status chỉ nhận 'skipped' hoặc 'throttled' (ràng buộc check của bảng
-- sẽ chặn giá trị khác). Đã có hàng thì giữ nguyên, không ghi đè — TRỪ
-- hàng 'sending' kẹt quá 1 giờ (function chết giữa chừng) thì ghi đè,
-- cùng nguyên tắc thu hồi của RPC claim, để sự kiện không kẹt mãi.
create or replace function public.safepc_mark_notification_terminal(
  p_family_id uuid,
  p_kind text,
  p_event_key text,
  p_status text,
  p_device_id uuid,
  p_action text,
  p_child_id uuid
)
returns void
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
begin
  insert into public.notification_sends (family_id, kind, event_key, status, device_id, action, child_id)
  values (p_family_id, p_kind, p_event_key, p_status, p_device_id, p_action, p_child_id)
  on conflict (kind, event_key) do nothing;

  update public.notification_sends
  set status = p_status,
      device_id = p_device_id,
      action = p_action,
      child_id = p_child_id,
      claimed_at = now()
  where kind = p_kind
    and event_key = p_event_key
    and status = 'sending'
    and claimed_at < now() - interval '1 hour';
end;
$$;

-- Chỉ vai trò quản trị (Edge Function) được gọi ba RPC này.
grant execute on function public.safepc_claim_notification(uuid, text, text, uuid, text, uuid) to service_role;
grant execute on function public.safepc_finish_notification(text, text, boolean, text, text[]) to service_role;
grant execute on function public.safepc_mark_notification_terminal(uuid, text, text, text, uuid, text, uuid) to service_role;

-- ============ 4. Lịch quét mỗi 5 phút ============
-- Gỡ lịch cũ cùng tên nếu có (chạy lại file an toàn): câu SELECT dưới
-- đây không làm gì khi chưa có job nào tên này.
select cron.unschedule(jobid) from cron.job where jobname = 'safepc-parent-notifications';

-- NHẮC LẠI: thay placeholder trong câu lệnh dưới đây bằng secret thật TRƯỚC KHI RUN.
-- Secret phải khớp WEEKLY_REPORT_SECRET trong Edge Function Secrets (cùng
-- chuỗi đã dùng cho lịch báo cáo tuần ở migration 11).
select cron.schedule(
  'safepc-parent-notifications',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://fzknvolkxnwfxdcfmops.supabase.co/functions/v1/send-parent-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-safepc-report-secret', '<DAT_SECRET_CUA_ANH>'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ============
-- 1. Extension đã bật:
-- select extname from pg_extension where extname in ('pg_cron', 'pg_net');
-- Kỳ vọng: 2 dòng (pg_cron, pg_net).
--
-- 2. Bảng + RPC đã tạo:
-- select tablename from pg_tables where schemaname = 'public' and tablename = 'notification_sends';
-- select proname from pg_proc where proname in ('safepc_claim_notification', 'safepc_finish_notification', 'safepc_mark_notification_terminal');
-- Kỳ vọng: 1 bảng, 3 hàm.
--
-- 3. Lịch đã tạo và đang bật:
-- select jobname, schedule, active, command from cron.job where jobname = 'safepc-parent-notifications';
-- Kỳ vọng: 1 dòng, schedule '*/5 * * * *', active true, command chứa URL
-- function và secret thật (không còn placeholder).
--
-- 4. Sau lần quét đầu tiên (trong 5 phút sau khi áp dụng): xem kết quả
-- gọi HTTP của pg_net và nhật ký gửi:
-- select id, status_code, created from net._http_response order by created desc limit 5;
-- Kỳ vọng: status_code 200 sau lần quét thành công (404 nghĩa là function
-- chưa được deploy — deploy xong thì lần quét sau sẽ 200).
-- select kind, event_key, status, sent_at from public.notification_sends order by created_at desc limit 10;
