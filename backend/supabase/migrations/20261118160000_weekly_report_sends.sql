-- SafePC — Migration 11: nhật ký gửi email báo cáo tuần + lịch gửi tự động
-- Ngày: 18/11/2026. Áp dụng qua Dashboard > SQL Editor (như migration 1-10),
-- chạy một lần, kiểm chứng bằng truy vấn ở cuối file (ghi chú).
--
-- Bối cảnh: Edge Function send-weekly-report gửi email báo cáo tuần cho
-- phụ huynh mỗi family (đủ 7 mục PRD §2.10, xem docs/06-EMAIL-SETUP.md).
-- Migration này:
--
-- 1. Bật extension pg_cron (lịch) + pg_net (gọi HTTP từ lịch). Nếu câu
--    CREATE EXTENSION lỗi trên project này thì bật hai extension đó trong
--    Dashboard > Database > Extensions trước, rồi chạy lại file này (mọi
--    câu đều chạy lại được an toàn, xem ghi chú từng mục).
-- 2. Tạo bảng weekly_report_sends: một hàng cho mỗi cặp (family, tuần đã
--    gửi) — khóa chống gửi trùng khi cron chạy lại hoặc gọi tay hai lần.
--    RLS bật, phụ huynh chỉ đọc được hàng của gia đình mình; chỉ vai trò
--    quản trị (Edge Function) ghi được, qua hai RPC dưới đây.
-- 3. Hai RPC giữ chỗ / ghi nhận đã gửi (xem chi tiết ở từng hàm). Chỗ giữ
--    kẹt ở trạng thái đang gửi quá 1 giờ (function chết giữa chừng) sẽ
--    được thu hồi để lần chạy sau gửi lại được.
-- 4. Lịch cron 'safepc-weekly-report': mỗi thứ Hai 00:00 UTC — tức 07:00
--    giờ Việt Nam — gọi Edge Function qua pg_net.
--
-- QUAN TRỌNG — SECRET TRONG LỊCH CRON: câu lệnh cron ở mục 4 chứa một
-- placeholder (chuỗi duy nhất có dạng <...> trong file). TRƯỚC KHI BẤM
-- RUN, anh Tiến phải thay placeholder đó bằng đúng chuỗi secret đã đặt
-- trong Edge Function Secrets (WEEKLY_REPORT_SECRET) — xem
-- docs/06-EMAIL-SETUP.md. Không để giá trị thật nào khác trong file
-- này. Secret sẽ hiện trong định nghĩa job (người có quyền đọc database
-- xem được) — đó là đánh đổi đã biết của mẫu pg_cron + pg_net, xem mục
-- "nâng cao" trong docs/06 nếu muốn giấu secret trong Vault.
--
-- Múi giờ của lịch: pg_cron chạy theo múi giờ của database (UTC trên
-- project này). '0 0 * * 1' = thứ Hai 00:00 UTC = thứ Hai 07:00 +07.
-- Nếu múi giờ database bị đổi thì giờ gửi sẽ lệch theo — kiểm chứng bằng
-- truy vấn ở cuối file sau lần chạy đầu tiên.

-- ============ 1. Extension pg_cron + pg_net ============
-- IF NOT EXISTS: đã bật rồi thì bỏ qua, không lỗi.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- ============ 2. Bảng nhật ký gửi ============
-- IF NOT EXISTS + DROP POLICY IF EXISTS: file chạy lại được an toàn
-- (trường hợp anh Tiến cần sửa placeholder secret rồi chạy lại).
create table if not exists public.weekly_report_sends (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  -- Ngày thứ Hai của tuần được báo cáo, theo giờ +07 (vd '2026-11-09').
  week_start date not null,
  status text not null check (status in ('sending', 'sent')),
  -- Lúc giữ chỗ; claim kẹt ở 'sending' quá 1 giờ thì RPC claim thu hồi.
  claimed_at timestamptz not null default now(),
  sent_at timestamptz,
  -- Id trả về bởi dịch vụ gửi email (để đối chiếu khi cần tra cứu).
  resend_id text,
  recipients text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (family_id, week_start)
);

alter table public.weekly_report_sends enable row level security;

drop policy if exists "family read" on public.weekly_report_sends;
create policy "family read" on public.weekly_report_sends
  for select using (public.is_family_member(family_id));
-- Không có policy ghi cho user thường: chỉ Edge Function (qua RPC
-- SECURITY DEFINER bên dưới) được ghi vào bảng này.

-- ============ 3a. Giữ chỗ gửi cho một family + tuần ============
-- Trả true khi giữ chỗ thành công (chưa ai gửi tuần này), false khi đã
-- có hàng 'sent' hoặc đang có lượt gửi khác giữ chỗ. Claim kẹt ở
-- 'sending' quá 1 giờ được thu hồi nguyên tử (UPDATE có điều kiện).
create or replace function public.safepc_claim_weekly_report(
  p_family_id uuid,
  p_week_start date
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
  insert into public.weekly_report_sends (family_id, week_start, status)
  values (p_family_id, p_week_start, 'sending')
  on conflict (family_id, week_start) do nothing
  returning id into v_id;
  if found then
    return true;
  end if;

  update public.weekly_report_sends
  set claimed_at = now()
  where family_id = p_family_id
    and week_start = p_week_start
    and status = 'sending'
    and claimed_at < now() - interval '1 hour'
  returning id into v_id;
  return found;
end;
$$;

-- ============ 3b. Ghi nhận kết quả gửi ============
-- ok = true: đánh dấu 'sent' kèm id trả về và danh sách người nhận.
-- ok = false: xóa chỗ giữ 'sending' để lần chạy sau gửi lại được (hàng
-- 'sent' không bao giờ bị xóa ở đây — gửi trùng phải xóa tay, xem
-- docs/06-EMAIL-SETUP.md mục gửi thử).
create or replace function public.safepc_finish_weekly_report(
  p_family_id uuid,
  p_week_start date,
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
    update public.weekly_report_sends
    set status = 'sent',
        sent_at = now(),
        resend_id = p_resend_id,
        recipients = p_recipients
    where family_id = p_family_id
      and week_start = p_week_start;
  else
    delete from public.weekly_report_sends
    where family_id = p_family_id
      and week_start = p_week_start
      and status = 'sending';
  end if;
end;
$$;

-- Chỉ vai trò quản trị (Edge Function) được gọi hai RPC này.
grant execute on function public.safepc_claim_weekly_report(uuid, date) to service_role;
grant execute on function public.safepc_finish_weekly_report(uuid, date, boolean, text, text[]) to service_role;

-- ============ 4. Lịch gửi mỗi thứ Hai 07:00 giờ +07 ============
-- Gỡ lịch cũ cùng tên nếu có (chạy lại file an toàn): câu SELECT dưới
-- đây không làm gì khi chưa có job nào tên này.
select cron.unschedule(jobid) from cron.job where jobname = 'safepc-weekly-report';

-- NHẮC LẠI: thay placeholder trong câu lệnh dưới đây bằng secret thật TRƯỚC KHI RUN.
-- Secret phải khớp WEEKLY_REPORT_SECRET trong Edge Function Secrets.
select cron.schedule(
  'safepc-weekly-report',
  '0 0 * * 1',
  $$
  select net.http_post(
    url := 'https://fzknvolkxnwfxdcfmops.supabase.co/functions/v1/send-weekly-report',
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
-- select tablename from pg_tables where schemaname = 'public' and tablename = 'weekly_report_sends';
-- select proname from pg_proc where proname in ('safepc_claim_weekly_report', 'safepc_finish_weekly_report');
-- Kỳ vọng: 1 bảng, 2 hàm.
--
-- 3. Lịch đã tạo và đang bật:
-- select jobname, schedule, active, command from cron.job where jobname = 'safepc-weekly-report';
-- Kỳ vọng: 1 dòng, schedule '0 0 * * 1', active true, command chứa URL
-- function và secret thật (không còn placeholder).
--
-- 4. Múi giờ database (lịch pg_cron chạy theo múi giờ này):
-- show timezone;
-- Kỳ vọng: UTC ('0 0 * * 1' = thứ Hai 07:00 +07).
--
-- 5. Sau lần chạy đầu tiên (thứ Hai 07:00 +07 hoặc gọi tay): xem kết quả
-- gọi HTTP của pg_net và nhật ký gửi:
-- select id, status_code, created from net._http_response order by created desc limit 5;
-- Kỳ vọng: status_code 200 sau lần chạy thành công.
-- select family_id, week_start, status, sent_at from public.weekly_report_sends order by created_at desc limit 10;
