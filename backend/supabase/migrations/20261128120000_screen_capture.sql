-- SafePC — Migration 32: chụp màn hình định kỳ (cài đặt + metadata
-- ảnh + token Google Drive của gia đình)
-- Ngày: 28/11/2026. Áp dụng qua Dashboard > SQL Editor (như migration
-- 1-31), chạy một lần, kiểm chứng bằng các truy vấn ở cuối file.
--
-- Bối cảnh (PRD §2.16, AMENDMENTS A-19): ngày 28/11/2026 anh Tiến DUYỆT
-- TRIỂN KHAI chụp màn hình định kỳ — ĐẢO NGƯỢC quyết định loại chụp
-- màn hình ngày 17/11/2026. Thiết kế theo docs/11-RESEARCH-SCREENSHOTS
-- và các chốt của anh ngày 28/11 (sửa lại 11:16 cùng ngày):
-- - Mức chụp 1/2/5/10/15/30 phút; ảnh nén <1MB (Tray thu nhỏ 1280px,
--   JPEG q72), lưu Google Drive RIÊNG của phụ huynh (OAuth scope
--   drive.file — app chỉ thấy file nó tạo); SafePC không thu tiền,
--   giữ mặc định 14 ngày, phụ huynh chọn 14/30/90/180 ngày.
-- - Mô hình quyết định (anh chốt lại 28/11 11:16, THAY mô hình cổng
--   đồng ý của con ở bản nháp trước): PHỤ HUYNH quyết định cứng
--   bật/tắt (enabled) — bật/tắt có hiệu lực ngay, KHÔNG có cổng đồng
--   ý của con, KHÔNG có trạng thái đồng ý, KHÔNG có xác nhận lại
--   định kỳ trên server. Con được THÔNG BÁO hàng tuần trên máy rằng
--   màn hình đang được chụp và bố mẹ có quyền xem ảnh (thông báo
--   không nêu tần suất chụp) — việc thông báo là của Tray trên máy
--   con, KHÔNG có trường/trạng thái server nào cho việc đó.
-- - Token Drive: refresh token của phụ huynh lưu ở bảng
--   family_drive_tokens (RLS bật, KHÔNG policy — chỉ RPC SECURITY
--   DEFINER và Edge Function connect-google-drive bằng service role
--   mới chạm được). Agent lấy token qua RPC theo mẫu token thiết bị,
--   lưu DPAPI + ACL trên máy con như device_token, upload thẳng lên
--   Drive (ảnh không qua server SafePC).
--
-- YÊU CẦU: migration 1, 3, 24, 29, 30, 31 ĐÃ ÁP TRƯỚC (3 —
-- safepc_auth_device; 24 — device_child_accounts; 29 — bản
-- safepc_delete_child_data có messages/chat_sessions; 30 — bảng
-- push_sends; 31 — bản safepc_delete_child_data có
-- rule_observations, được mục 7 thay thế nguyên văn + bổ sung).
-- pg_cron đã bật từ migration 11.
--
-- Migration này:
-- 1. Bảng child_screen_settings: cài đặt chụp màn hình theo TỪNG
--    con (enabled + interval_minutes + retention_days). RLS: thành
--    viên gia đình đọc; chỉ phụ huynh (role 'parent') mới ghi
--    (bật/tắt = quyết định cứng của phụ huynh, hiệu lực ngay).
-- 2. Bảng screenshot_metadata: danh mục ảnh (thời điểm, ngày theo
--    giờ gia đình, drive_file_id, kích thước) — ảnh thật nằm ở Drive
--    phụ huynh. RLS chỉ đọc cho thành viên; ghi qua RPC thiết bị.
-- 3. Bảng family_drive_tokens (token Drive theo gia đình) +
--    drive_oauth_states (nonce cho luồng OAuth) + drive_oauth_config
--    (client id/secret của app OAuth — Edge Function ghi từ secrets
--    của nó khi phụ huynh kết nối; Agent cần client id/secret để đổi
--    refresh token thành access token, đây là thông tin của CHÍNH
--    app SafePC dùng cho mọi gia đình, không phải bí mật của gia
--    đình). Cả ba bảng RLS bật, KHÔNG policy cho client.
-- 4. RPC thiết bị (mẫu token thiết bị): safepc_fetch_screen_settings
--    (settings các con gắn với máy), safepc_push_screenshot_meta
--    (batch danh mục ảnh), safepc_purge_screenshot_meta (xóa danh
--    mục của một ngày khi Agent dọn thư mục Drive quá hạn giữ),
--    safepc_fetch_drive_token (chỉ token của gia đình của máy, chỉ
--    khi chưa bị thu hồi), safepc_report_drive_disconnected (đánh
--    dấu token đã bị thu hồi/mất hiệu lực).
-- 5. RPC cho Dashboard (JWT): safepc_get_drive_connection (trạng
--    thái kết nối Drive của gia đình người gọi — KHÔNG trả token),
--    safepc_disconnect_drive (phụ huynh ngắt kết nối: xóa token).
--    Việc LƯU token do Edge Function connect-google-drive ghi thẳng
--    bằng service role (bypass RLS, bảng không có policy) — không
--    qua RPC, vì lúc callback OAuth chưa có phiên JWT của phụ huynh
--    trong request đó (Google chuyển hướng về), danh tính gia đình
--    nằm trong drive_oauth_states do function tự tạo lúc bắt đầu.
-- 6. CREATE OR REPLACE safepc_push_tamper_event (nguyên văn bản
--    migration 22 + thêm loại 'drive_disconnected').
-- 7. CREATE OR REPLACE safepc_delete_child_data: NGUYÊN VĂN bản
--    migration 31 cộng thêm settings + metadata ảnh (đếm + xóa theo
--    child_id, khóa 'screen_settings' + 'screenshots' trong cả hai
--    jsonb kết quả). Token Drive là của GIA ĐÌNH — không xóa theo
--    con. File ảnh trên Drive phụ huynh cũng không xóa ở đây (phụ
--    huynh tự quản trên Drive của mình; Agent dọn theo hạn giữ khi
--    máy con còn online) — ghi rõ ở tab Dữ liệu trên Dashboard.
-- 8. Mở rộng ràng buộc kind của push_sends thêm 'parent_alert' để
--    Edge Function send-push-notifications đẩy được sự kiện mới
--    (Drive mất kết nối) qua kênh push.
-- 9. Lịch cron 'safepc-screenshot-meta-cleanup' 04:30 UTC hằng ngày:
--    xóa danh mục ảnh cũ hơn 180 ngày (trần hạn giữ tối đa).
--
-- Chạy lại an toàn: CREATE TABLE IF NOT EXISTS / DROP POLICY IF
-- EXISTS / CREATE OR REPLACE / DO block gỡ ràng buộc theo nội dung /
-- gỡ lịch cron trước khi tạo lại — chạy lại file không lỗi, không
-- tạo trùng.

-- ============ 1. Cài đặt chụp màn hình theo con ============
create table if not exists public.child_screen_settings (
  child_id uuid primary key references public.children (id) on delete cascade,
  family_id uuid not null references public.families (id) on delete cascade,
  -- Phụ huynh bật/tắt — quyết định cứng của phụ huynh, có hiệu lực
  -- ngay khi Agent đọc settings. Con không tự tắt/bật được tính
  -- năng này qua bất kỳ đường server nào.
  enabled boolean not null default false,
  interval_minutes integer not null default 5
    check (interval_minutes in (1, 2, 5, 10, 15, 30)),
  retention_days integer not null default 14
    check (retention_days in (14, 30, 90, 180)),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

alter table public.child_screen_settings enable row level security;

-- Đọc: mọi thành viên gia đình (Dashboard hiện trạng thái cho cả hai
-- phụ huynh).
drop policy if exists "family read" on public.child_screen_settings;
create policy "family read" on public.child_screen_settings
  for select using (public.is_family_member(family_id));

-- Ghi: chỉ phụ huynh (role 'parent' trong gia đình đó) — bật/tắt và
-- đổi mức chụp là quyết định cứng của phụ huynh.
drop policy if exists "parent write" on public.child_screen_settings;
create policy "parent write" on public.child_screen_settings
  for all
  using (
    exists (
      select 1 from public.family_members fm
      where fm.family_id = child_screen_settings.family_id
        and fm.user_id = auth.uid()
        and fm.role = 'parent'
    )
  )
  with check (
    exists (
      select 1 from public.family_members fm
      where fm.family_id = child_screen_settings.family_id
        and fm.user_id = auth.uid()
        and fm.role = 'parent'
    )
  );

-- ============ 2. Danh mục ảnh chụp màn hình ============
create table if not exists public.screenshot_metadata (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  child_id uuid not null references public.children (id) on delete cascade,
  -- Máy chỉ là nơi chụp: danh mục thuộc về CON (xem/xóa theo con),
  -- xóa máy chỉ SET NULL device_id như rule_observations/messages.
  device_id uuid references public.devices (id) on delete set null,
  captured_at timestamptz not null,
  -- Ngày theo giờ tin cậy quy đổi múi giờ gia đình (Agent tính) —
  -- khớp tên thư mục ngày trên Drive để dọn dẹp đối chiếu chính xác.
  day date not null,
  drive_file_id text not null,
  size_bytes integer not null default 0,
  width integer,
  height integer,
  created_at timestamptz not null default now()
);

create index if not exists screenshot_metadata_child_time_idx
  on public.screenshot_metadata (child_id, captured_at desc);

alter table public.screenshot_metadata enable row level security;

-- Chỉ ĐỌC cho thành viên gia đình; ghi qua RPC SECURITY DEFINER
-- (cùng mẫu rule_observations ở migration 31).
drop policy if exists "family read" on public.screenshot_metadata;
create policy "family read" on public.screenshot_metadata
  for select using (public.is_family_member(family_id));

-- ============ 3. Token Drive + trạng thái OAuth (không policy) ============
create table if not exists public.family_drive_tokens (
  family_id uuid primary key references public.families (id) on delete cascade,
  -- Refresh token OAuth của phụ huynh (scope drive.file). CHỈ Edge
  -- Function (service role) ghi và RPC thiết bị của đúng gia đình đó
  -- đọc — không có đường nào cho client thường chạm vào.
  refresh_token text not null,
  google_email text,
  connected_at timestamptz not null default now(),
  -- Agent báo token bị thu hồi/hết hiệu lực (Google trả invalid_grant)
  -- thì RPC fetch không trả token nữa và Dashboard hiện "đã mất kết
  -- nối — kết nối lại" thay vì im lặng ngừng chụp.
  revoked_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.family_drive_tokens enable row level security;
-- CỐ Ý không tạo policy nào: RLS bật + không policy = client thường
-- (anon/authenticated) không đọc/ghi được hàng nào; service role
-- bypass RLS nên Edge Function vẫn ghi được.

create table if not exists public.drive_oauth_states (
  state text primary key,
  family_id uuid not null references public.families (id) on delete cascade,
  user_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.drive_oauth_states enable row level security;
-- Không policy như trên: chỉ Edge Function (service role) dùng.

create table if not exists public.drive_oauth_config (
  id integer primary key check (id = 1),
  -- Client id/secret của app OAuth SafePC (một app cho mọi gia đình;
  -- với ứng dụng cài đặt/desktop, client secret không được Google coi
  -- là bí mật tuyệt đối — nhưng vẫn chỉ phát qua RPC thiết bị đã xác
  -- thực của gia đình ĐÃ kết nối Drive, không phát công khai).
  client_id text,
  client_secret text,
  updated_at timestamptz not null default now()
);

alter table public.drive_oauth_config enable row level security;
-- Không policy như trên.

-- ============ 4. RPC thiết bị: settings + danh mục + token ============
-- Settings của các con gắn với máy này (con mặc định + các con đã ánh
-- xạ tài khoản Windows). Phụ huynh bật/tắt (enabled) là có hiệu lực
-- ngay — Agent cứ theo enabled/interval/retention mà chụp hay không.
create or replace function public.safepc_fetch_screen_settings(
  p_device_id uuid,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, extensions
as $$
declare
  v_device public.devices;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'child_id', c.id,
      'child_name', c.display_name,
      'enabled', s.enabled,
      'interval_minutes', s.interval_minutes,
      'retention_days', s.retention_days
    ) order by c.created_at)
    from public.child_screen_settings s
    join public.children c on c.id = s.child_id
    where s.family_id = v_device.family_id
      and (
        c.id = v_device.child_id
        or exists (
          select 1 from public.device_child_accounts a
          where a.device_id = v_device.id and a.child_id = c.id
        )
      )
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.safepc_fetch_screen_settings(uuid, text) to anon, authenticated, service_role;

-- Agent đẩy batch danh mục ảnh vừa upload lên Drive. Child suy ra
-- TỪNG MẪU qua windows_sid như safepc_push_rule_observations; mẫu
-- không suy ra được con thì bỏ qua + đếm skipped. Trần batch 500.
create or replace function public.safepc_push_screenshot_meta(
  p_device_id uuid,
  p_token_hash text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_device public.devices;
  v_total integer;
  v_accepted integer;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_items' using errcode = 'P0001';
  end if;

  if jsonb_array_length(p_items) > 500 then
    raise exception 'batch_too_large' using errcode = 'P0001';
  end if;

  v_total := jsonb_array_length(p_items);

  insert into public.screenshot_metadata (
    family_id, child_id, device_id, captured_at, day,
    drive_file_id, size_bytes, width, height
  )
  select
    v_device.family_id,
    coalesce(a.child_id, v_device.child_id),
    v_device.id,
    s.captured_at,
    s.day,
    left(s.drive_file_id, 200),
    greatest(coalesce(s.size_bytes, 0), 0),
    s.width,
    s.height
  from jsonb_to_recordset(p_items)
    as s(captured_at timestamptz, day date, drive_file_id text,
         size_bytes integer, width integer, height integer,
         windows_sid text)
  left join public.device_child_accounts a
    on a.device_id = v_device.id
   and a.windows_sid = s.windows_sid
  where coalesce(a.child_id, v_device.child_id) is not null
    and s.captured_at is not null
    and s.day is not null
    and s.drive_file_id is not null and length(trim(s.drive_file_id)) > 0;

  get diagnostics v_accepted = row_count;
  return jsonb_build_object('accepted', v_accepted, 'skipped', v_total - v_accepted);
end;
$$;

grant execute on function public.safepc_push_screenshot_meta(uuid, text, jsonb) to anon, authenticated, service_role;

-- Agent xóa danh mục của một NGÀY (theo giờ gia đình) của một con sau
-- khi đã xóa thư mục ngày đó trên Drive vì quá hạn giữ — để Dashboard
-- không hiện ảnh đã bị xóa kèm link hỏng. Con phải gắn với máy này
-- (con mặc định hoặc đã ánh xạ), không thì không xóa gì.
create or replace function public.safepc_purge_screenshot_meta(
  p_device_id uuid,
  p_token_hash text,
  p_child_id uuid,
  p_day date
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_device public.devices;
  v_deleted integer;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  if p_child_id is distinct from v_device.child_id
     and not exists (
       select 1 from public.device_child_accounts a
       where a.device_id = v_device.id and a.child_id = p_child_id
     ) then
    return jsonb_build_object('deleted', 0);
  end if;

  delete from public.screenshot_metadata
  where child_id = p_child_id
    and family_id = v_device.family_id
    and day = p_day;
  get diagnostics v_deleted = row_count;

  return jsonb_build_object('deleted', v_deleted);
end;
$$;

grant execute on function public.safepc_purge_screenshot_meta(uuid, text, uuid, date) to anon, authenticated, service_role;

-- Agent lấy token Drive của gia đình MÌNH (và chỉ của mình): gia
-- đình suy ra từ thiết bị đã xác thực, không có tham số gia đình để
-- giả mạo. Token đã bị đánh dấu thu hồi thì trả null (JSON) để Agent
-- ngừng thử và Dashboard hiện trạng thái mất kết nối. Kèm client
-- id/secret của app OAuth (Edge Function đã ghi vào
-- drive_oauth_config khi phụ huynh kết nối) để Agent đổi refresh
-- token → access token.
create or replace function public.safepc_fetch_drive_token(
  p_device_id uuid,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, extensions
as $$
declare
  v_device public.devices;
  v_token public.family_drive_tokens;
  v_config public.drive_oauth_config;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  select * into v_token
  from public.family_drive_tokens t
  where t.family_id = v_device.family_id;

  if not found or v_token.revoked_at is not null then
    return null;
  end if;

  select * into v_config from public.drive_oauth_config where id = 1;

  return jsonb_build_object(
    'refresh_token', v_token.refresh_token,
    'google_email', v_token.google_email,
    'client_id', v_config.client_id,
    'client_secret', v_config.client_secret
  );
end;
$$;

grant execute on function public.safepc_fetch_drive_token(uuid, text) to anon, authenticated, service_role;

-- Agent báo token Drive không còn dùng được (Google trả
-- invalid_grant khi đổi access token, hoặc Drive trả 401 liên tục):
-- đánh dấu revoked_at để fetch không trả nữa + Dashboard hiện "đã
-- mất kết nối". Sự kiện báo phụ huynh đi qua safepc_push_tamper_event
-- loại 'drive_disconnected' (mục 6) — RPC này chỉ lo trạng thái.
create or replace function public.safepc_report_drive_disconnected(
  p_device_id uuid,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_device public.devices;
  v_marked boolean := false;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  update public.family_drive_tokens
  set revoked_at = now(), updated_at = now()
  where family_id = v_device.family_id and revoked_at is null;
  v_marked := found;

  return jsonb_build_object('marked', v_marked);
end;
$$;

grant execute on function public.safepc_report_drive_disconnected(uuid, text) to anon, authenticated, service_role;

-- ============ 5. RPC Dashboard: trạng thái kết nối Drive ============
-- Bảng token không có policy nên Dashboard không đọc trực tiếp được;
-- RPC này chỉ trả TRẠNG THÁI (đã kết nối chưa, email nào, có bị thu
-- hồi không) cho gia đình của người gọi — KHÔNG BAO GIỜ trả token.
create or replace function public.safepc_get_drive_connection()
returns jsonb
language plpgsql
security definer
stable
set search_path = public, extensions
as $$
declare
  v_family_id uuid;
  v_token public.family_drive_tokens;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated';
  end if;

  select fm.family_id into v_family_id
  from public.family_members fm
  where fm.user_id = auth.uid()
  order by fm.created_at
  limit 1;

  if v_family_id is null then
    return jsonb_build_object('connected', false);
  end if;

  select * into v_token
  from public.family_drive_tokens t
  where t.family_id = v_family_id;

  if not found then
    return jsonb_build_object('connected', false);
  end if;

  return jsonb_build_object(
    'connected', v_token.revoked_at is null,
    'revoked', v_token.revoked_at is not null,
    'google_email', v_token.google_email,
    'connected_at', v_token.connected_at
  );
end;
$$;

revoke execute on function public.safepc_get_drive_connection() from public;
grant execute on function public.safepc_get_drive_connection() to authenticated;

-- Phụ huynh ngắt kết nối Drive: xóa hẳn hàng token (không giữ
-- refresh token của người đã rút quyền). Chỉ role 'parent'.
create or replace function public.safepc_disconnect_drive()
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_family_id uuid;
  v_deleted integer;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated';
  end if;

  select fm.family_id into v_family_id
  from public.family_members fm
  where fm.user_id = auth.uid() and fm.role = 'parent'
  order by fm.created_at
  limit 1;

  if v_family_id is null then
    raise exception 'not_a_parent';
  end if;

  delete from public.family_drive_tokens where family_id = v_family_id;
  get diagnostics v_deleted = row_count;

  return jsonb_build_object('disconnected', v_deleted > 0);
end;
$$;

revoke execute on function public.safepc_disconnect_drive() from public;
grant execute on function public.safepc_disconnect_drive() to authenticated;

-- ============ 6. Tamper event: thêm loại drive_disconnected ============
-- CREATE OR REPLACE safepc_push_tamper_event: NGUYÊN VĂN bản
-- migration 22 (5 loại) cộng thêm 'drive_disconnected'.
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

  if p_event_type is null or p_event_type not in ('clock_drift', 'agent_restart', 'extension_missing', 'service_stopped', 'tray_stopped', 'drive_disconnected') then
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

grant execute on function public.safepc_push_tamper_event(uuid, text, text, jsonb) to anon, authenticated, service_role;

-- ============ 7. Xóa dữ liệu con: thêm settings + metadata ảnh ============
-- CREATE OR REPLACE safepc_delete_child_data: NGUYÊN VĂN bản
-- migration 31, chỉ cộng thêm mục chụp màn hình (biến đếm, đếm trước
-- theo child_id, bước xóa 4c, và khóa 'screen_settings' +
-- 'screenshots' trong jsonb audit + jsonb kết quả). Chữ ký/dạng kết
-- quả giữ nguyên như migration 31 đã chốt. Token Drive (cấp gia
-- đình) và file ảnh trên Drive phụ huynh KHÔNG thuộc phạm vi xóa
-- theo con — xem ghi chú đầu file.
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
  v_deleted_messages integer := 0;
  v_deleted_chat_sessions integer := 0;
  v_deleted_rule_observations integer := 0;
  v_deleted_screen_settings integer := 0;
  v_deleted_screenshots integer := 0;
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
  -- Tin nhắn của con (migration 29): đếm theo child_id — tin của con
  -- khác trên cùng máy chung không thuộc về con này, không đếm.
  select count(*) into v_deleted_messages
  from public.messages where child_id = p_child_id;
  -- Phiên nhắn tin sẽ mất: phiên của con này, cộng phiên của con khác
  -- đang mở trên máy thuộc về con này (mất theo CASCADE khi xóa máy ở
  -- bước 5 — máy đã xóa khỏi hệ thống thì phiên trên đó vô nghĩa).
  select count(*) into v_deleted_chat_sessions
  from public.chat_sessions s
  where s.child_id = p_child_id
     or s.device_id in (
       select d.id from public.devices d
       where d.child_id = p_child_id and d.family_id = v_family_id
     );
  -- Dòng theo dõi luật của con (migration 31): đếm theo child_id —
  -- dòng của con này ghi trên máy dùng chung vẫn là dữ liệu của con
  -- này; dòng của con khác trên máy của con này mang child_id khác,
  -- không đếm (chúng thuộc về con kia, xem bước 4b).
  select count(*) into v_deleted_rule_observations
  from public.rule_observations where child_id = p_child_id;
  -- Cài đặt chụp màn hình của con (migration 32): 0 hoặc 1 hàng.
  select count(*) into v_deleted_screen_settings
  from public.child_screen_settings where child_id = p_child_id;
  -- Danh mục ảnh chụp của con (migration 32): đếm theo child_id như
  -- tin nhắn. File ảnh thật nằm trên Drive của phụ huynh — không
  -- thuộc phạm vi hàm này (xem ghi chú đầu file).
  select count(*) into v_deleted_screenshots
  from public.screenshot_metadata where child_id = p_child_id;

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

  -- 4. Tin nhắn + phiên nhắn tin của con (migration 29): xóa theo
  -- child_id trước khi xóa máy/hồ sơ để số đếm ở trên khớp hàng thật
  -- đã xóa ở bước này; phiên của con khác trên máy của con này không
  -- xóa ở đây — chúng mất theo CASCADE khi xóa máy ở bước 5 (đã đếm).
  delete from public.messages
  where child_id = p_child_id;
  delete from public.chat_sessions
  where child_id = p_child_id;

  -- 4b. Dòng theo dõi luật của con (migration 31): xóa theo child_id
  -- như tin nhắn. Dòng của con KHÁC ghi trên máy thuộc về con này
  -- KHÔNG xóa ở đây (dữ liệu của con kia; cột child_id mới là chuẩn,
  -- device_id chỉ là nơi ghi nhận).
  delete from public.rule_observations
  where child_id = p_child_id;

  -- 4c. Cài đặt + danh mục ảnh chụp màn hình của con (migration 32):
  -- xóa theo child_id như trên. Token Drive là của gia đình nên
  -- KHÔNG xóa ở đây; file ảnh trên Drive phụ huynh tự quản.
  delete from public.child_screen_settings
  where child_id = p_child_id;
  delete from public.screenshot_metadata
  where child_id = p_child_id;

  -- 5. Các máy của con: CASCADE xóa device_tokens, commands, app_usage,
  -- web_visits của máy. Ràng buộc cả family_id để không chạm tới máy
  -- của gia đình khác dù child_id có trùng (không thể trùng vì id là
  -- uuid, nhưng giữ điều kiện cho rõ ranh giới).
  delete from public.devices
  where child_id = p_child_id and family_id = v_family_id;
  get diagnostics v_deleted_devices = row_count;

  -- 6. Hồ sơ con: CASCADE xóa rules, requests, time_bank_grants và mọi
  -- hàng app_usage / web_visits còn lại của con.
  delete from public.children
  where id = p_child_id;
  if not found then
    -- Không tới được sau lần đọc lại có khóa ở trên; giữ để không bao
    -- giờ báo thành công khi thực ra không xóa gì.
    raise exception 'child_not_found';
  end if;

  -- 7. Ghi lại việc xóa để phụ huynh còn lại thấy được trong nhật ký:
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
      'pairing_codes', v_deleted_pairing,
      'messages', v_deleted_messages,
      'chat_sessions', v_deleted_chat_sessions,
      'rule_observations', v_deleted_rule_observations,
      'screen_settings', v_deleted_screen_settings,
      'screenshots', v_deleted_screenshots
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
      'pairing_codes', v_deleted_pairing,
      'messages', v_deleted_messages,
      'chat_sessions', v_deleted_chat_sessions,
      'rule_observations', v_deleted_rule_observations,
      'screen_settings', v_deleted_screen_settings,
      'screenshots', v_deleted_screenshots
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

-- ============ 8. push_sends: thêm kind 'parent_alert' ============
-- Ràng buộc CHECK của cột kind ở migration 30 là ràng buộc nội tuyến
-- (tên tự sinh). Gỡ đúng ràng buộc CHECK nào có nhắc tới 'kind' trên
-- bảng push_sends rồi tạo lại với danh sách mở rộng — idempotent:
-- chạy lại thì gỡ ràng buộc (đã mở rộng) và tạo lại y hệt.
do $$
declare
  v_constraint text;
begin
  for v_constraint in
    select conname from pg_constraint
    where conrelid = 'public.push_sends'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%kind%'
  loop
    execute format('alter table public.push_sends drop constraint %I', v_constraint);
  end loop;
end;
$$;

alter table public.push_sends
  add constraint push_sends_kind_check
  check (kind in ('chat_message', 'child_request', 'parent_alert'));

-- ============ 9. Dọn danh mục ảnh quá 180 ngày ============
create extension if not exists pg_cron with schema extensions;

-- Chạy lại an toàn: gỡ lịch cũ cùng tên trước khi tạo lại.
select cron.unschedule(jobid) from cron.job where jobname = 'safepc-screenshot-meta-cleanup';

select cron.schedule(
  'safepc-screenshot-meta-cleanup',
  '30 4 * * *',
  $cron$
    delete from public.screenshot_metadata
    where captured_at < now() - interval '180 days';
  $cron$
);

--- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ============
--- select table_name from information_schema.tables where table_schema = 'public' and table_name in ('child_screen_settings', 'screenshot_metadata', 'family_drive_tokens', 'drive_oauth_states', 'drive_oauth_config'); -- kỳ vọng 5 dòng
--- select proname from pg_proc where proname in ('safepc_fetch_screen_settings', 'safepc_push_screenshot_meta', 'safepc_purge_screenshot_meta', 'safepc_fetch_drive_token', 'safepc_report_drive_disconnected', 'safepc_get_drive_connection', 'safepc_disconnect_drive'); -- kỳ vọng 7 dòng
--- select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.push_sends'::regclass and conname = 'push_sends_kind_check'; -- kỳ vọng có 'parent_alert'
--- select jobname, schedule, active from cron.job where jobname = 'safepc-screenshot-meta-cleanup';
