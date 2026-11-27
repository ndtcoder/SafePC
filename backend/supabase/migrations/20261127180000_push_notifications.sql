-- SafePC — Migration 30: thông báo đẩy (Web Push) cho phụ huynh
-- Ngày: 27/11/2026. Áp dụng qua Dashboard > SQL Editor (như migration
-- 1-29), chạy một lần, kiểm chứng bằng truy vấn ở cuối file (ghi chú).
--
-- Bối cảnh (PRD §2.13, AMENDMENTS A-16): anh Tiến yêu cầu ngày
-- 27/11/2026 push notification là BẮT BUỘC cho tính năng nhắn tin —
-- lý do trực tiếp: con xin mở chat.zalo.me 4 lần qua Family Safety mà
-- anh không hề biết vì không mở app/web lúc đó. Phạm vi v1:
-- (a) tin nhắn chat mới do CON gửi (bảng messages, migration 29);
-- (b) yêu cầu mới của con (bảng requests: extra_time / unblock_app /
-- unblock_domain) — cùng họ sự kiện với email của Edge Function
-- send-parent-notifications (migration 12) nhưng là KÊNH ĐỘC LẬP:
-- dấu đã gửi của push và của email không chặn nhau (xem mục 2-3).
-- Kênh v1: Web Push cho Dashboard PWA (VAPID). Android/FCM chỉ để
-- sẵn cấu trúc dữ liệu (cột platform), KHÔNG có phía Android ở đợt
-- này — FCM để giai đoạn app Android.
--
-- YÊU CẦU: migration 12 (notification_sends + pg_cron/pg_net) VÀ
-- migration 29 (bảng messages) ĐÃ ÁP TRƯỚC. Migration này ALTER
-- bảng messages và đọc bảng requests; thiếu 29 thì câu ALTER lỗi.
--
-- Thiết kế chống gửi trùng (hai cơ chế khác nhau theo bản chất sự
-- kiện, ghi rõ để khỏi gộp nhầm):
-- - Chat: cột messages.push_notified_at (mục 2). Một tin nhắn là
--   một sự kiện toàn cục của gia đình (không theo từng phụ huynh),
--   nên một mốc trên chính hàng tin là đủ và rẻ nhất: function quét
--   xử lý xong (đã đẩy, hoặc gia đình không có subscription nào) thì
--   đóng mốc, không quét lại. Tin của PHỤ HUYNH không bao giờ được
--   đẩy cho chính họ — function chỉ xét sender_role = 'child'.
-- - Yêu cầu: bảng push_sends (mục 3), khóa unique (kind, ref_id,
--   user_id) theo TỪNG phụ huynh nhận — vì một yêu cầu được đẩy tới
--   nhiều phụ huynh và kết quả gửi khác nhau theo người (có/không
--   có subscription, gửi thành công/thất bại). Cơ chế này tách hẳn
--   khỏi notification_sends của email: email đã gửi KHÔNG làm push
--   bỏ qua sự kiện và ngược lại.
--
-- Migration này:
-- 1. Bảng push_subscriptions: đăng ký nhận push của từng phụ huynh
--    (endpoint + khóa của thiết bị/trình duyệt). RLS: chủ sở hữu chỉ
--    thấy/thêm/sửa/xóa dòng của chính mình (user_id = auth.uid());
--    không có đường ghi cho người khác. Cột platform để sẵn 'web'
--    (v1) và 'android' (giai đoạn app Android, chưa dùng).
-- 2. Cột messages.push_notified_at + index một phần cho vòng quét.
-- 3. Bảng push_sends: nhật ký chống trùng của kênh push cho sự kiện
--    yêu cầu. RLS: thành viên gia đình chỉ đọc (như
--    notification_sends); chỉ Edge Function (khóa quản trị, bypass
--    RLS) ghi.
-- 4. Lịch cron 'safepc-push-notifications': mỗi 5 phút gọi Edge
--    Function send-push-notifications qua pg_net (cùng nhịp với
--    lịch email ở migration 12).
--
-- QUAN TRỌNG — SECRET TRONG LỊCH CRON: câu lệnh cron ở mục 4 chứa
-- một placeholder (chuỗi duy nhất có dạng <...> trong file). TRƯỚC
-- KHI BẤM RUN, anh Tiến phải thay placeholder đó bằng ĐÚNG chuỗi
-- secret đã đặt trong Edge Function Secrets (WEEKLY_REPORT_SECRET)
-- — cùng một chuỗi đã dùng cho lịch báo cáo tuần ở migration 11 và
-- lịch email ở migration 12. Không để giá trị thật nào khác trong
-- file này.
--
-- Chạy lại an toàn: IF NOT EXISTS / DROP POLICY IF EXISTS / ADD
-- COLUMN IF NOT EXISTS — chạy lại file không lỗi, không tạo trùng.

-- ============ 0. Extension pg_cron + pg_net ============
-- IF NOT EXISTS: migration 11/12 đã bật thì bỏ qua, không lỗi.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- ============ 1. Bảng đăng ký nhận push ============
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  -- Phụ huynh sở hữu đăng ký (xóa tài khoản thì đăng ký xóa theo).
  user_id uuid not null references auth.users (id) on delete cascade,
  family_id uuid not null references public.families (id) on delete cascade,
  -- Kênh: 'web' là Web Push của Dashboard PWA (v1, đang dùng);
  -- 'android' để sẵn cho app Android/FCM ở giai đoạn sau — chưa có
  -- mã nào ghi/đọc giá trị này ở v1.
  platform text not null default 'web' check (platform in ('web', 'android')),
  -- Địa chỉ endpoint của dịch vụ push (Google/Mozilla/Apple tùy
  -- trình duyệt). Endpoint là định danh của ĐĂNG KÝ trên thiết bị,
  -- không phải khóa bí mật; khóa bí mật VAPID của server không bao
  -- giờ nằm ở bảng này.
  endpoint text not null,
  -- Cặp khóa mã hóa payload của subscription (khóa công khai của
  -- thiết bị + bí mật xác thực), trình duyệt cấp khi subscribe.
  -- Web Push bắt buộc có cả hai; để nullable cho các nền tảng sau
  -- này (vd token FCM không dùng hai cột này).
  p256dh text,
  auth text,
  user_agent text,
  created_at timestamptz not null default now(),
  -- Lần cuối Dashboard xác nhận đăng ký còn sống (bật lại/tải lại
  -- trang) — function cũng dùng để dọn đăng ký chết kết hợp với mã
  -- lỗi 404/410 từ dịch vụ push (xem function send-push-notifications).
  last_seen_at timestamptz not null default now(),
  unique (user_id, endpoint)
);

create index if not exists push_subscriptions_family_idx
  on public.push_subscriptions (family_id, user_id);

alter table public.push_subscriptions enable row level security;

-- Chủ sở hữu toàn quyền trên dòng của mình; KHÔNG có policy nào cho
-- người khác chạm vào (kể cả phụ huynh cùng gia đình — đăng ký push
-- là trạng thái thiết bị của từng người, như notification_reads ở
-- migration 20).
drop policy if exists "own subscriptions read" on public.push_subscriptions;
create policy "own subscriptions read" on public.push_subscriptions
  for select using (auth.uid() = user_id);

drop policy if exists "own subscriptions insert" on public.push_subscriptions;
create policy "own subscriptions insert" on public.push_subscriptions
  for insert with check (auth.uid() = user_id);

drop policy if exists "own subscriptions update" on public.push_subscriptions;
create policy "own subscriptions update" on public.push_subscriptions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own subscriptions delete" on public.push_subscriptions;
create policy "own subscriptions delete" on public.push_subscriptions
  for delete using (auth.uid() = user_id);

-- ============ 2. Mốc đã đẩy trên messages ============
-- Chỉ áp cho tin của con (sender_role = 'child'): function quét
-- đóng mốc sau khi xử lý tin (đã đẩy tới các subscription của phụ
-- huynh trong gia đình, hoặc gia đình không có subscription nào —
-- vẫn đóng mốc để không quét lại vô hạn; phụ huynh bật push sau đó
-- không nhận lại tin cũ, tin cũ vẫn nằm trong Dashboard).
alter table public.messages
  add column if not exists push_notified_at timestamptz;

-- Index một phần đúng hình dạng truy vấn của vòng quét: tin của con
-- chưa đẩy, theo thời gian tạo.
create index if not exists messages_unpushed_child_idx
  on public.messages (created_at)
  where sender_role = 'child' and push_notified_at is null;

-- ============ 3. Bảng nhật ký chống trùng của kênh push ============
create table if not exists public.push_sends (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  -- Loại sự kiện: 'child_request' (yêu cầu của con — đang dùng ở
  -- v1); 'chat_message' GIỮ SẴN trong ràng buộc nhưng v1 KHÔNG ghi
  -- loại này: chống trùng cho chat là cột messages.push_notified_at
  -- ở mục 2 (mốc toàn cục theo tin, không theo người nhận). Loại
  -- 'chat_message' chỉ dùng nếu sau này cần chống trùng theo từng
  -- phụ huynh cho chat.
  kind text not null check (kind in ('chat_message', 'child_request')),
  -- Id của sự kiện gốc (hàng requests với kind = 'child_request').
  ref_id uuid not null,
  -- Phụ huynh nhận (một hàng cho mỗi cặp sự kiện × người nhận).
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Con gắn với sự kiện (phục vụ chặn dồn dập theo con: tối đa 1
  -- push yêu cầu / con / 10 phút, function tra trên bảng này).
  child_id uuid references public.children (id) on delete set null,
  -- 'sent': đã đẩy tới ít nhất một subscription của người này;
  -- 'skipped': không đẩy (không có subscription, hoặc yêu cầu đã
  -- được quyết định trước lúc gửi) — vẫn ghi để không xét lại;
  -- 'failed': mọi subscription đều lỗi (trừ lỗi 404/410 đã xóa
  -- đăng ký) — vẫn ghi để tránh bão thử lại mỗi 5 phút; sự kiện
  -- vẫn còn trên Dashboard và trong email (kênh độc lập).
  status text not null default 'sent' check (status in ('sent', 'failed', 'skipped')),
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (kind, ref_id, user_id)
);

alter table public.push_sends enable row level security;

drop policy if exists "family read" on public.push_sends;
create policy "family read" on public.push_sends
  for select using (public.is_family_member(family_id));
-- Không có policy ghi cho user thường: chỉ Edge Function (khóa
-- quản trị, bypass RLS) ghi vào bảng này.

-- Index phục vụ chặn dồn dập yêu cầu theo con.
create index if not exists push_sends_request_throttle_idx
  on public.push_sends (child_id, sent_at desc)
  where kind = 'child_request' and status = 'sent';

-- ============ 4. Lịch quét mỗi 5 phút ============
-- Gỡ lịch cũ cùng tên nếu có (chạy lại file an toàn).
select cron.unschedule(jobid) from cron.job where jobname = 'safepc-push-notifications';

-- NHẮC LẠI: thay placeholder trong câu lệnh dưới đây bằng secret thật TRƯỚC KHI RUN.
-- Secret phải khớp WEEKLY_REPORT_SECRET trong Edge Function Secrets (cùng
-- chuỗi đã dùng cho lịch báo cáo tuần ở migration 11 và lịch email ở 12).
select cron.schedule(
  'safepc-push-notifications',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://fzknvolkxnwfxdcfmops.supabase.co/functions/v1/send-push-notifications',
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
-- 2. Hai bảng mới + cột mới:
-- select tablename from pg_tables where schemaname = 'public'
--   and tablename in ('push_subscriptions', 'push_sends');
-- select column_name from information_schema.columns
--   where table_name = 'messages' and column_name = 'push_notified_at';
-- Kỳ vọng: 2 bảng, 1 cột.
--
-- 3. RLS + policy:
-- select tablename, policyname, cmd from pg_policies
--   where tablename in ('push_subscriptions', 'push_sends') order by tablename, policyname;
-- Kỳ vọng: push_subscriptions 4 dòng (SELECT/INSERT/UPDATE/DELETE của
-- chủ sở hữu), push_sends 1 dòng (family read, SELECT).
--
-- 4. Lịch đã tạo và đang bật:
-- select jobname, schedule, active from cron.job where jobname = 'safepc-push-notifications';
-- Kỳ vọng: 1 dòng, schedule '*/5 * * * *', active true, command chứa
-- URL function và secret thật (không còn placeholder).
--
-- 5. Sau lần quét đầu tiên (trong 5 phút sau khi áp dụng + deploy
-- function): xem kết quả gọi HTTP của pg_net:
-- select id, status_code, created from net._http_response order by created desc limit 5;
-- Kỳ vọng: status_code 200 sau lần quét thành công (404 nghĩa là
-- function chưa được deploy — deploy xong thì lần quét sau sẽ 200).
