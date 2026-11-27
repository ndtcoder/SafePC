-- SafePC — Migration 31: giờ tin cậy (múi giờ gia đình) + theo dõi khi
-- luật không chặn (rule_observations)
-- Ngày: 27/11/2026. Áp dụng qua Dashboard > SQL Editor (như migration
-- 1-30), chạy một lần, kiểm chứng bằng các truy vấn ở cuối file.
--
-- Bối cảnh (PRD §2.14 + §2.15, AMENDMENTS A-17 + A-18): hai ý tưởng
-- của anh Tiến ngày 27/11/2026.
-- (1) GIỜ TIN CẬY: luật theo giờ hiện thi hành bằng giờ local của máy
-- con — con chỉnh giờ hệ thống hoặc đổi múi giờ Windows là lách được
-- giờ cấm (cơ chế cũ chỉ PHÁT HIỆN lệch giờ qua clock_drift khi có
-- mạng, thi hành vẫn theo đồng hồ máy). Từ đợt này, Agent thi hành
-- bằng giờ server (đồng bộ qua heartbeat) + trôi đơn điệu, quy đổi
-- sang MÚI GIỜ GIA ĐÌNH do phụ huynh đặt (mục 1 + 5). Múi giờ Windows
-- của máy con không còn ảnh hưởng thi hành.
-- (2) THEO DÕI KHI LUẬT KHÔNG CHẶN: mỗi luật cấm có mặt theo dõi tích
-- hợp (config.observe, mặc định bật): con dùng app/domain/giờ thuộc
-- diện luật mà luật không chặn (luật đang tắt / đang được cho phép
-- tạm thời / không chặn được) thì Agent ghi dòng quan sát GỘP theo
-- (luật, ngày, đối tượng, ngữ cảnh) vào bảng rule_observations
-- (mục 2), hiện trong Báo cáo tuần. Sửa luật → ghi theo thông số mới
-- (mỗi dòng mang bản chụp tên + mode của luật); xóa luật → dừng ghi,
-- dòng cũ còn tới khi hết hạn giữ 90 ngày. KHÔNG thu loại dữ liệu
-- mới: chỉ gắn liên kết luật vào dữ liệu sử dụng vốn đã thu.
--
-- YÊU CẦU: migration 1-30 ĐÃ ÁP TRƯỚC (đặc biệt: 3 — safepc_auth_device
-- + heartbeat/fetch rules gốc; 7 — bản heartbeat có exit_pin_hash;
-- 9 — cột rules.name; 24 — device_child_accounts +
-- safepc_fetch_device_child_rules; 29 — bản safepc_delete_child_data
-- có messages/chat_sessions, được mục 6 thay thế nguyên văn + bổ
-- sung). pg_cron đã bật từ migration 11.
--
-- Migration này:
-- 1. Cột families.timezone (tên IANA, mặc định 'Asia/Ho_Chi_Minh'):
--    múi giờ gia đình phụ huynh đặt trên Dashboard. Không cần policy
--    mới: policy "owner full access" sẵn có của bảng families ở
--    migration 1 cho OWNER cập nhật (gồm cả cột này), thành viên gia
--    đình khác chỉ ĐỌC được (SELECT) — Dashboard khóa sẵn mục này
--    với người không phải chủ gia đình.
-- 2. Bảng rule_observations + RLS chỉ đọc cho thành viên gia đình.
--    Khóa gộp (child_id, day, target, context, rule_name): rule_id
--    được phép NULL (luật bị xóa thì ON DELETE SET NULL — dòng ghi
--    vẫn còn tới khi hết hạn giữ), nên khóa gộp KHÔNG dùng rule_id
--    (NULL không so sánh bằng nhau trong unique index thường, upsert
--    sẽ nhân đôi dòng). rule_name là bản chụp tên luật lúc ghi —
--    hai luật trùng tên cùng con nhắm cùng đối tượng trong cùng ngày
--    và cùng ngữ cảnh sẽ gộp chung một dòng: chấp nhận được vì báo
--    cáo nhóm theo tên luật (đúng đơn vị hiển thị), và trùng cả bốn
--    yếu tố đó là rất hiếm.
-- 3. RPC safepc_push_rule_observations: Agent đẩy batch dòng gộp
--    (mẫu token thiết bị như migration 28; child suy ra TỪNG MẪU qua
--    windows_sid → device_child_accounts, fallback devices.child_id;
--    mẫu không suy ra được con thì bỏ qua + đếm skipped). Upsert cộng
--    dồn occurrence_count/total_seconds, first_seen_at lấy mốc sớm
--    nhất, last_seen_at lấy mốc muộn nhất. rule_id chỉ giữ khi luật
--    còn tồn tại và thuộc đúng con (tránh FK lỗi / gắn nhầm luật con
--    khác); luật đã bị xóa → rule_id NULL, vẫn ghi theo bản chụp.
-- 4. RPC safepc_fetch_device_monitor_rules: luật CẤM ĐANG TẮT của
--    một con trên máy này (dạng chỉ-theo-dõi cho Agent đối chiếu).
--    Hai RPC fetch rules hiện có chỉ trả luật đang bật (enabled =
--    true) nên đường hiện tại KHÔNG lấy được luật đã tắt — cần RPC
--    riêng này (cùng mẫu phân giải con của migration 24). Chỉ trả
--    luật mà mặt theo dõi còn bật: config.observe vắng mặt = bật
--    (mặc định), observe = false (jsonb) = phụ huynh đã tắt theo
--    dõi cho luật đó. Chỉ các mode cấm: type daily_limit / bedtime /
--    time_window (luật giờ), type app với mode app_block /
--    app_block_by_time, type website với mode block_domains /
--    block_domains_by_time / focus. (app_time_limit, allowlist,
--    safe_search, block_search_keywords, forced_break không thuộc
--    phạm vi theo dõi của đợt này — xem PRD §2.15.)
-- 5. CREATE OR REPLACE safepc_device_heartbeat (bản migration 7 +
--    trường family_timezone) và hai RPC fetch rules (bản migration
--    3/24 + cột name trong JSON trả về): thuần bổ sung trường JSON —
--    Agent cũ bỏ qua trường lạ như mọi lần trước, Agent mới dùng
--    timezone để thi hành giờ tin cậy và name cho bản chụp luật.
-- 6. CREATE OR REPLACE safepc_delete_child_data: NGUYÊN VĂN bản
--    migration 29 cộng thêm mục rule_observations (đếm + xóa theo
--    child_id + khóa 'rule_observations' trong cả hai jsonb kết
--    quả). Chữ ký và dạng kết quả giữ nguyên như migration 29 đã
--    chốt.
-- 7. Lịch cron 'safepc-rule-observations-cleanup' 03:45 UTC hằng
--    ngày: xóa dòng quan sát có day cũ hơn 90 ngày (day là ngày
--    theo múi giờ gia đình; mốc xóa tính theo ngày UTC của server
--    nên có thể lệch tối đa 1 ngày so với ngày gia đình — chấp
--    nhận được cho hạn giữ 90 ngày).
--
-- Chạy lại an toàn: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT
-- EXISTS / DROP POLICY IF EXISTS / CREATE OR REPLACE / gỡ lịch cron
-- trước khi tạo lại — chạy lại file không lỗi, không tạo trùng.

-- ============ 1. Múi giờ gia đình ============
alter table public.families
  add column if not exists timezone text not null default 'Asia/Ho_Chi_Minh';

comment on column public.families.timezone is
  'Múi giờ gia đình (tên IANA, VD Asia/Ho_Chi_Minh) do phụ huynh đặt trên Dashboard: Agent thi hành mọi luật theo giờ theo giờ server quy đổi sang múi giờ này (giờ tin cậy, PRD §2.14).';

-- ============ 2. Bảng rule_observations ============
create table if not exists public.rule_observations (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  child_id uuid not null references public.children (id) on delete cascade,
  -- Máy chỉ là nơi ghi nhận: dòng quan sát thuộc về CON (báo cáo
  -- theo con), nên xóa máy (VD khi xóa dữ liệu của con khác trên
  -- máy dùng chung) chỉ SET NULL device_id, không xóa dòng của con
  -- này — cùng ngữ nghĩa messages.device_id ở migration 29.
  device_id uuid references public.devices (id) on delete set null,
  -- Luật bị xóa thì dòng ghi vẫn còn (bản chụp bên dưới là căn cứ hiển
  -- thị) nên rule_id SET NULL, không cascade.
  rule_id uuid references public.rules (id) on delete set null,
  -- Bản chụp tên + mode của luật tại thời điểm ghi: sửa luật thì dòng
  -- cũ giữ bản chụp cũ, dòng mới mang bản chụp mới (PRD §2.15).
  rule_name text not null,
  rule_mode text not null,
  -- Đối tượng bị theo dõi: tên exe (app), domain (web) hoặc tên app
  -- đang dùng / "Máy tính" (luật giờ).
  target text not null,
  context text not null
    check (context in ('rule_disabled', 'temp_allowed', 'unenforceable')),
  occurrence_count integer not null default 0,
  total_seconds integer not null default 0,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  -- Ngày theo GIỜ TIN CẬY quy đổi múi giờ gia đình (Agent tính), là
  -- khóa gộp cùng (child_id, target, context, rule_name).
  day date not null,
  created_at timestamptz not null default now(),
  unique (child_id, day, target, context, rule_name)
);

create index if not exists rule_observations_child_day_idx
  on public.rule_observations (child_id, day desc);

create index if not exists rule_observations_family_day_idx
  on public.rule_observations (family_id, day desc);

alter table public.rule_observations enable row level security;

-- Chỉ ĐỌC cho thành viên gia đình (Dashboard/Báo cáo tuần đọc trực
-- tiếp qua RLS); không có policy ghi — Agent ghi qua RPC SECURITY
-- DEFINER (cùng mẫu search_terms ở migration 28).
drop policy if exists "family read" on public.rule_observations;
create policy "family read" on public.rule_observations
  for select using (public.is_family_member(family_id));

-- ============ 3. RPC đẩy dòng theo dõi luật từ Agent ============
-- Soi mẫu safepc_push_search_terms (migration 28): cùng chữ ký xác
-- thực (p_device_id, p_token_hash), child suy ra TỪNG MẪU qua SID;
-- mẫu không suy ra được con nào thì bị lọc và đếm vào skipped —
-- không fail cả batch. Trần batch 500 mẫu. Khác với search_terms
-- (insert thuần), RPC này UPSERT cộng dồn theo khóa gộp.
create or replace function public.safepc_push_rule_observations(
  p_device_id uuid,
  p_token_hash text,
  p_observations jsonb
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

  if p_observations is null or jsonb_typeof(p_observations) <> 'array' then
    raise exception 'invalid_observations' using errcode = 'P0001';
  end if;

  if jsonb_array_length(p_observations) > 500 then
    raise exception 'batch_too_large' using errcode = 'P0001';
  end if;

  v_total := jsonb_array_length(p_observations);

  -- Gộp nhóm NGAY trong batch theo khóa gộp trước khi upsert: hai
  -- mẫu trùng (child, day, target, context, rule_name) trong cùng
  -- một batch (VD luật bị xóa rồi tạo lại trùng tên — outbox phía
  -- Agent khóa theo rule_id nên vẫn là hai dòng) mà đưa thẳng vào
  -- INSERT ... ON CONFLICT sẽ lỗi "cannot affect row a second time".
  with src as (
    select
      coalesce(a.child_id, v_device.child_id) as child_id,
      s.day,
      left(s.target, 500) as target,
      s.context,
      left(s.rule_name, 200) as rule_name,
      max(left(s.rule_mode, 50)) as rule_mode,
      (array_agg(s.rule_id) filter (
         where r.id is not null
           and r.child_id = coalesce(a.child_id, v_device.child_id)))[1] as rule_id,
      sum(greatest(coalesce(s.occurrence_count, 0), 0))::integer as occurrence_count,
      sum(greatest(coalesce(s.total_seconds, 0), 0))::integer as total_seconds,
      min(s.first_seen_at) as first_seen_at,
      max(s.last_seen_at) as last_seen_at
    from jsonb_to_recordset(p_observations)
      as s(rule_id uuid, rule_name text, rule_mode text, target text,
           context text, occurrence_count integer, total_seconds integer,
           first_seen_at timestamptz, last_seen_at timestamptz,
           day date, windows_sid text)
    left join public.device_child_accounts a
      on a.device_id = v_device.id
     and a.windows_sid = s.windows_sid
    left join public.rules r
      on r.id = s.rule_id
    where coalesce(a.child_id, v_device.child_id) is not null
      and s.context in ('rule_disabled', 'temp_allowed', 'unenforceable')
      and s.rule_name is not null and length(trim(s.rule_name)) > 0
      and s.rule_mode is not null and length(trim(s.rule_mode)) > 0
      and s.target is not null and length(trim(s.target)) > 0
      and s.day is not null
      and s.first_seen_at is not null
      and s.last_seen_at is not null
    group by coalesce(a.child_id, v_device.child_id), s.day,
             left(s.target, 500), s.context, left(s.rule_name, 200)
  )
  insert into public.rule_observations (
    family_id, child_id, device_id, rule_id, rule_name, rule_mode,
    target, context, occurrence_count, total_seconds,
    first_seen_at, last_seen_at, day
  )
  select
    v_device.family_id,
    src.child_id,
    v_device.id,
    -- rule_id chỉ giữ khi luật còn tồn tại VÀ thuộc đúng con đã suy
    -- ra (luật bị xóa sau khi Agent ghi nhận, hoặc id lạ, thì ghi
    -- NULL — dòng vẫn có bản chụp tên/mode để hiển thị).
    src.rule_id,
    src.rule_name,
    src.rule_mode,
    src.target,
    src.context,
    src.occurrence_count,
    src.total_seconds,
    src.first_seen_at,
    src.last_seen_at,
    src.day
  from src
  on conflict (child_id, day, target, context, rule_name)
  do update set
    occurrence_count = public.rule_observations.occurrence_count + excluded.occurrence_count,
    total_seconds = public.rule_observations.total_seconds + excluded.total_seconds,
    first_seen_at = least(public.rule_observations.first_seen_at, excluded.first_seen_at),
    last_seen_at = greatest(public.rule_observations.last_seen_at, excluded.last_seen_at),
    -- Luật bị xóa sau lần đẩy trước: giữ NULL (bản chụp không đổi).
    -- Luật còn: giữ id luật để truy vết; mode lấy bản chụp mới nhất.
    rule_id = coalesce(excluded.rule_id, public.rule_observations.rule_id),
    rule_mode = excluded.rule_mode,
    device_id = excluded.device_id;

  get diagnostics v_accepted = row_count;
  return jsonb_build_object('accepted', v_accepted, 'skipped', v_total - v_accepted);
end;
$$;

grant execute on function public.safepc_push_rule_observations(uuid, text, jsonb) to anon, authenticated, service_role;

-- ============ 4. RPC lấy luật cấm ĐANG TẮT (chỉ-theo-dõi) ============
-- Cùng mẫu phân giải con của safepc_fetch_device_child_rules
-- (migration 24): p_child_id NULL = con chính của máy; con xin luật
-- phải thuộc gia đình này và gắn với máy này, không thì trả rỗng.
create or replace function public.safepc_fetch_device_monitor_rules(
  p_device_id uuid,
  p_token_hash text,
  p_child_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, extensions
as $$
declare
  v_device public.devices;
  v_child_id uuid;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  v_child_id := coalesce(p_child_id, v_device.child_id);

  if v_child_id is null then
    return '[]'::jsonb;
  end if;

  if v_child_id is distinct from v_device.child_id
     and not exists (
       select 1 from public.device_child_accounts a
       where a.device_id = v_device.id
         and a.child_id = v_child_id
     ) then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(to_jsonb(r) order by r.created_at)
    from (
      select id, family_id, child_id, type, config, enabled, created_at, name
      from public.rules
      where family_id = v_device.family_id
        and child_id = v_child_id
        and enabled = false
        -- Mặt theo dõi: config.observe vắng mặt/không phải false =
        -- bật (mặc định); chỉ jsonb false mới là phụ huynh đã tắt.
        and coalesce(config -> 'observe', 'true'::jsonb) <> 'false'::jsonb
        and (
          type in ('daily_limit', 'bedtime', 'time_window')
          or (type = 'app' and config ->> 'mode' in ('app_block', 'app_block_by_time'))
          or (type = 'website' and config ->> 'mode' in ('block_domains', 'block_domains_by_time', 'focus'))
        )
    ) r
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.safepc_fetch_device_monitor_rules(uuid, text, uuid) to anon, authenticated, service_role;

-- ============ 5. Heartbeat + fetch rules: bổ sung trường JSON ============
-- Heartbeat: giữ nguyên chữ ký và các trường cũ (bản migration 7),
-- thêm family_timezone — Agent cũ bỏ qua trường lạ như mọi lần.
create or replace function public.safepc_device_heartbeat(
  p_device_id uuid,
  p_token_hash text,
  p_agent_version text,
  p_status text
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_device public.devices;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  update public.devices
  set last_seen_at = now(),
      agent_version = coalesce(nullif(left(p_agent_version, 50), ''), agent_version),
      status = case when p_status in ('online', 'offline', 'locked') then p_status else status end
  where id = v_device.id;

  return jsonb_build_object(
    'server_time', now(),
    'family_id', v_device.family_id,
    'child_id', v_device.child_id,
    'exit_pin_hash', v_device.exit_pin_hash,
    'family_timezone', (
      select f.timezone from public.families f where f.id = v_device.family_id
    )
  );
end;
$$;

-- Fetch rules (bản migration 3) + cột name: Agent mới dùng name cho
-- bản chụp tên luật trong dòng theo dõi; Agent cũ bỏ qua trường lạ.
create or replace function public.safepc_fetch_device_rules(
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

  if v_device.child_id is null then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(to_jsonb(r) order by r.created_at)
    from (
      select id, family_id, child_id, type, config, enabled, created_at, name
      from public.rules
      where family_id = v_device.family_id
        and child_id = v_device.child_id
        and enabled = true
    ) r
  ), '[]'::jsonb);
end;
$$;

-- Fetch rules theo con (bản migration 24) + cột name, như trên.
create or replace function public.safepc_fetch_device_child_rules(
  p_device_id uuid,
  p_token_hash text,
  p_child_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, extensions
as $$
declare
  v_device public.devices;
  v_child_id uuid;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  v_child_id := coalesce(p_child_id, v_device.child_id);

  if v_child_id is null then
    return '[]'::jsonb;
  end if;

  if v_child_id is distinct from v_device.child_id
     and not exists (
       select 1 from public.device_child_accounts a
       where a.device_id = v_device.id
         and a.child_id = v_child_id
     ) then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(to_jsonb(r) order by r.created_at)
    from (
      select id, family_id, child_id, type, config, enabled, created_at, name
      from public.rules
      where family_id = v_device.family_id
        and child_id = v_child_id
        and enabled = true
    ) r
  ), '[]'::jsonb);
end;
$$;

-- ============ 6. Xóa dữ liệu con: thêm rule_observations ============
-- CREATE OR REPLACE safepc_delete_child_data: NGUYÊN VĂN bản
-- migration 29, chỉ cộng thêm mục rule_observations (biến đếm, đếm
-- trước theo child_id, bước xóa 4b, và khóa 'rule_observations'
-- trong jsonb audit + jsonb kết quả). Chữ ký/dạng kết quả giữ
-- nguyên như migration 29 đã chốt.
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
      'rule_observations', v_deleted_rule_observations
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
      'rule_observations', v_deleted_rule_observations
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

-- ============ 7. Dọn dòng theo dõi quá 90 ngày ============
create extension if not exists pg_cron with schema extensions;

-- Chạy lại an toàn: gỡ lịch cũ cùng tên trước khi tạo lại.
select cron.unschedule(jobid) from cron.job where jobname = 'safepc-rule-observations-cleanup';

select cron.schedule(
  'safepc-rule-observations-cleanup',
  '45 3 * * *',
  $cron$
    delete from public.rule_observations
    where day < (now() at time zone 'utc')::date - 90;
  $cron$
);

--- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ============
--- select column_name, data_type, column_default from information_schema.columns where table_name = 'families' and column_name = 'timezone';
--- select * from public.rule_observations limit 1; -- kỳ vọng: 0 dòng (hoặc lỗi bảng chưa có nếu migration chưa chạy)
--- select proname from pg_proc where proname in ('safepc_push_rule_observations', 'safepc_fetch_device_monitor_rules');
--- select jobname, schedule, active from cron.job where jobname = 'safepc-rule-observations-cleanup';
--- select public.safepc_device_heartbeat('<device-id>', '<token-hash-that>', 'manual-check', 'online') ->> 'family_timezone'; -- kỳ vọng 'Asia/Ho_Chi_Minh' (hoặc múi giờ đã đặt)
