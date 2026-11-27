-- SafePC — Migration 29: nhắn tin giữa con và phụ huynh trong SafePC
-- Ngày: 27/11/2026. Áp dụng qua Dashboard > SQL Editor (như migration
-- 1-28), chạy một lần, kiểm chứng bằng truy vấn ở cuối file (ghi chú).
--
-- Bối cảnh (PRD §2.13, AMENDMENTS A-15): anh Tiến yêu cầu ngày
-- 27/11/2026 một kênh nhắn tin TÍCH HỢP trong SafePC, chỉ trong gia
-- đình, để con khỏi phải dùng ứng dụng nhắn tin bên ngoài (gây xao
-- lãng). Đường dùng app bên thứ ba (Telegram/WhatsApp...) KHÔNG khả
-- thi cho yêu cầu "chỉ nhắn/gọi với người trong danh bạ được phép" vì
-- các app đó không cho bên ngoài kiểm soát danh bạ — SafePC chỉ
-- chặn/mở được cả app như các app khác. V1: chỉ tin nhắn chữ; gọi
-- thoại/video để giai đoạn app Android.
--
-- RIÊNG TƯ — NỚI RANH GIỚI DO ANH TIẾN QUYẾT ĐỊNH (27/11/2026, xem
-- AMENDMENTS A-15): SafePC trước nay KHÔNG lưu nội dung liên lạc
-- (không đọc chat/email/file của con ở ứng dụng khác — ranh giới đó
-- vẫn giữ nguyên). Tính năng này khác: nội dung tin nhắn là dữ liệu
-- do CHÍNH hai phía (phụ huynh và con) chủ động tạo ra trong kênh của
-- sản phẩm, cả hai phía đều là người tham gia cuộc trò chuyện. Tin
-- nhắn được lưu trên Supabase, nằm trong file xuất dữ liệu con và bị
-- xóa khi phụ huynh xóa dữ liệu con (mục 5 dưới đây).
--
-- YÊU CẦU: migration 24 ĐÃ ÁP TRƯỚC — RPC mint phiên ở mục 3 phân
-- giải hồ sơ con theo tài khoản Windows qua bảng
-- device_child_accounts, và mọi RPC phía máy con xác thực thiết bị
-- qua safepc_auth_device (migration 3) như các RPC thiết bị khác.
--
-- Thiết kế kênh của con (không cần tài khoản): Service trên máy con
-- (giữ token thiết bị) gọi safepc_mint_chat_session để lấy TOKEN
-- PHIÊN 12 giờ, mở trang web chat riêng cho con (/nhan-tin#t=<token>)
-- trong trình duyệt. Trang chat chỉ cầm token phiên — KHÔNG cầm token
-- thiết bị, KHÔNG đăng nhập — và chỉ gọi được 3 RPC chat (fetch /
-- send / mark_read). Token phiên 256-bit, database chỉ lưu SHA-256
-- hex (mẫu token thiết bị ở migration 3 và lời mời ở migration 14).
-- Mỗi (máy, con) chỉ có MỘT phiên hiệu lực: mint phiên mới thì thu
-- hồi mọi phiên chưa thu hồi khác của đúng (máy, con) đó. Phụ huynh
-- thu hồi toàn bộ phiên của một con bằng safepc_revoke_chat_sessions.
--
-- Migration này:
-- 1. Bảng messages: tin nhắn hai chiều trong gia đình (phụ huynh gửi
--    qua Dashboard đã đăng nhập; con gửi qua RPC mang token phiên).
--    RLS: thành viên gia đình SELECT; INSERT trực tiếp chỉ cho phụ
--    huynh tự gửi (sender_role = 'parent' và sender_user_id =
--    auth.uid()); KHÔNG có policy UPDATE — RLS không giới hạn theo
--    cột nên policy UPDATE sẽ cho sửa cả nội dung tin nhắn, việc
--    đánh dấu đã đọc đi qua RPC SECURITY DEFINER ở mục 3-4. Phía
--    con KHÔNG ghi trực tiếp được — chỉ qua RPC SECURITY DEFINER ở
--    mục 3.
-- 2. Bảng chat_sessions: phiên chat của con trên một máy. RLS bật và
--    KHÔNG có policy nào cho user thường — chỉ các RPC SECURITY
--    DEFINER chạm vào (token_hash là thông tin xác thực).
-- 3. RPC phía con / máy con (gọi bằng khóa publishable + token):
--    safepc_mint_chat_session (Agent gọi bằng token thiết bị),
--    safepc_chat_fetch, safepc_chat_send, safepc_chat_mark_read
--    (trang chat của con gọi bằng token phiên).
-- 4. RPC phía phụ huynh (đã đăng nhập, kiểm tra vai trò parent như
--    migration 15): safepc_parent_mark_read,
--    safepc_revoke_chat_sessions.
-- 5. CREATE OR REPLACE safepc_delete_child_data (bản migration 15):
--    GIỮ NGUYÊN chữ ký + hành vi cho 10 mục hiện có, thêm: xóa
--    messages + chat_sessions của con và đếm vào kết quả trả về
--    (khóa 'messages' / 'chat_sessions' trong mục deleted). File xuất
--    dữ liệu thêm mục messages ở phía Dashboard (lib/childData.ts);
--    chat_sessions KHÔNG xuất (chứa hash token phiên — thông tin xác
--    thực, cùng nhóm loại trừ với device_tokens).
--    Lưu ý phạm vi xóa: messages/chat_sessions xóa theo child_id
--    (tin nhắn của con khác trên cùng máy chung giữ nguyên; messages
--    của con khác chỉ mất liên kết máy qua ON DELETE SET NULL).
--    Riêng chat_sessions của con khác đang mở trên một máy THUỘC về
--    con bị xóa sẽ mất theo CASCADE khi máy bị xóa ở bước xóa thiết
--    bị — máy đã bị xóa khỏi hệ thống thì phiên trên máy đó vô
--    nghĩa; số đếm chat_sessions trong kết quả gồm cả các phiên đó
--    (đếm theo child_id HOẶC theo máy của con, như mẫu đếm
--    commands/device_tokens của migration 15).
--
-- Chạy lại an toàn: IF NOT EXISTS / DROP POLICY IF EXISTS / CREATE OR
-- REPLACE — chạy lại file không lỗi, không tạo trùng.

-- ============ 1. Bảng messages ============
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  child_id uuid not null references public.children (id) on delete cascade,
  -- Máy con gửi từ (tin phụ huynh gửi từ Dashboard thì null). Máy bị
  -- xóa thì tin vẫn giữ, chỉ mất liên kết máy.
  device_id uuid references public.devices (id) on delete set null,
  sender_role text not null check (sender_role in ('parent', 'child')),
  -- auth user khi phụ huynh gửi; null khi con gửi (con không có tài
  -- khoản — danh tính của phía con là phiên chat gắn với máy + hồ sơ).
  sender_user_id uuid,
  body text not null check (char_length(body) between 1 and 2000),
  -- Mốc phụ huynh đã đọc (áp cho tin của con) / con đã đọc (áp cho
  -- tin của phụ huynh). Mỗi phía chỉ đọc mốc của mình.
  parent_read_at timestamptz,
  child_read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists messages_child_created_idx
  on public.messages (child_id, created_at);

alter table public.messages enable row level security;

-- Đọc: mọi thành viên gia đình (cả hai phụ huynh cùng thấy một kênh).
drop policy if exists "family read" on public.messages;
create policy "family read" on public.messages
  for select using (public.is_family_member(family_id));

-- Ghi trực tiếp: CHỈ phụ huynh tự gửi tin của chính mình. Điều kiện
-- child thuộc đúng gia đình của hàng (chặn gắn tin vào con của gia
-- đình khác bằng cách khai family_id của mình + child_id lạ).
drop policy if exists "parent send" on public.messages;
create policy "parent send" on public.messages
  for insert with check (
    public.is_family_member(family_id)
    and sender_role = 'parent'
    and sender_user_id = auth.uid()
    and exists (
      select 1 from public.children c
      where c.id = child_id and c.family_id = messages.family_id
    )
  );

-- KHÔNG tạo policy UPDATE (chủ đích bảo mật): RLS của Postgres
-- không giới hạn theo cột, nên một policy UPDATE theo gia đình sẽ
-- cho phép mọi thành viên sửa BẤT KỲ cột nào của mọi tin nhắn — kể
-- cả body và sender_role của tin con gửi — phá tính toàn vẹn của
-- lịch sử chat. App cũng không cần UPDATE trực tiếp: cả hai phía
-- đánh dấu đã đọc đều qua RPC SECURITY DEFINER
-- (safepc_parent_mark_read / safepc_chat_mark_read), phía phụ huynh
-- gửi bằng INSERT ở trên, phía con ghi qua RPC ở mục 3. Tóm lại:
-- ghi/sửa trên messages CHỈ qua INSERT policy + RPC. DROP POLICY IF
-- EXISTS dưới đây để lần chạy lại trên DB đã từng áp bản nháp có
-- policy này cũng gỡ sạch.
drop policy if exists "family update" on public.messages;

-- ============ 2. Bảng chat_sessions ============
create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  child_id uuid not null references public.children (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  -- SHA-256 hex chữ thường của token phiên (token thô không bao giờ
  -- xuống database — cùng quy ước migration 3/14).
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists chat_sessions_child_idx
  on public.chat_sessions (child_id, created_at desc);

alter table public.chat_sessions enable row level security;
-- KHÔNG tạo policy nào: anon/authenticated không đọc/ghi trực tiếp
-- được bảng này; chỉ các RPC SECURITY DEFINER bên dưới chạm vào.

-- ============ 3. RPC phía con / máy con ============
-- Hàm nội bộ: tra phiên còn hiệu lực từ token thô. Mọi trường hợp sai
-- (không tìm thấy, đã thu hồi, đã hết hạn) đều gộp thành một lỗi
-- 'invalid_session' để không tạo oracle dò token (mẫu migration 14).
-- Không cấp quyền gọi trực tiếp cho ai: các RPC SECURITY DEFINER bên
-- dưới chạy với quyền chủ hàm nên gọi được.
create or replace function public.safepc_chat_session(
  p_session_token text
)
returns public.chat_sessions
language plpgsql
security definer
stable
set search_path = public, extensions
as $$
declare
  v_session public.chat_sessions;
begin
  if p_session_token is null or length(trim(p_session_token)) = 0 then
    raise exception 'invalid_session' using errcode = 'P0001';
  end if;

  select s.* into v_session
  from public.chat_sessions s
  where s.token_hash = encode(digest(convert_to(p_session_token, 'UTF8'), 'sha256'), 'hex')
    and s.revoked_at is null
    and s.expires_at > now();

  if v_session.id is null then
    raise exception 'invalid_session' using errcode = 'P0001';
  end if;

  return v_session;
end;
$$;

revoke execute on function public.safepc_chat_session(text) from public;

-- Mint phiên chat: Agent (đã có token thiết bị) gọi khi con bấm mở
-- nhắn tin từ khay hệ thống. Phân giải con như migration 24 §8: SID
-- có ánh xạ thì theo ánh xạ, không thì fallback con mặc định của máy;
-- máy chưa gắn con nào thì báo 'device_not_assigned' (mẫu lỗi P0001
-- của các RPC thiết bị). Thu hồi mọi phiên chưa thu hồi khác của
-- (máy, con) trước khi tạo phiên mới — mỗi (máy, con) một phiên.
create or replace function public.safepc_mint_chat_session(
  p_device_id uuid,
  p_token_hash text,
  p_windows_sid text default null
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_device public.devices;
  v_child_id uuid;
  v_mapped_child_id uuid;
  v_token text;
  v_expires_at timestamptz;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  v_child_id := v_device.child_id;
  if p_windows_sid is not null then
    select a.child_id into v_mapped_child_id
    from public.device_child_accounts a
    where a.device_id = v_device.id
      and a.windows_sid = p_windows_sid;
    v_child_id := coalesce(v_mapped_child_id, v_device.child_id);
  end if;

  if v_child_id is null then
    raise exception 'device_not_assigned' using errcode = 'P0001';
  end if;

  -- Khóa theo (máy, con) cho hết transaction: hai lần mint cùng lúc
  -- nối tiếp nhau, phiên sau thu hồi phiên trước — không để hai
  -- phiên cùng hiệu lực (mẫu khóa tư vấn của các RPC khác).
  perform pg_advisory_xact_lock(
    hashtext('safepc_chat_session_' || v_device.id::text || '|' || v_child_id::text));

  update public.chat_sessions
  set revoked_at = now()
  where device_id = v_device.id
    and child_id = v_child_id
    and revoked_at is null;

  -- Token 32 byte ngẫu nhiên (hex 64 ký tự); chỉ hash được lưu.
  v_token := encode(gen_random_bytes(32), 'hex');
  v_expires_at := now() + interval '12 hours';

  insert into public.chat_sessions (family_id, child_id, device_id, token_hash, expires_at)
  values (
    v_device.family_id,
    v_child_id,
    v_device.id,
    encode(digest(convert_to(v_token, 'UTF8'), 'sha256'), 'hex'),
    v_expires_at
  );

  return jsonb_build_object(
    'token', v_token,
    'expires_at', v_expires_at,
    'child_id', v_child_id
  );
end;
$$;

grant execute on function public.safepc_mint_chat_session(uuid, text, text) to anon, authenticated, service_role;

-- Lấy tin nhắn của con thuộc phiên, luôn trả theo thứ tự tăng dần
-- theo thời gian, trần p_limit ở 100. Hai chế độ: KHÔNG có p_after
-- -> cửa sổ MỚI NHẤT (tối đa v_limit tin gần nhất — trang chat mở
-- ra là thấy đoạn cuối cuộc trò chuyện); CÓ p_after -> các tin sau
-- mốc đó (tăng dần như cũ, làm tối ưu poll tùy chọn).
create or replace function public.safepc_chat_fetch(
  p_session_token text,
  p_after timestamptz default null,
  p_limit int default 100
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, extensions
as $$
declare
  v_session public.chat_sessions;
  v_limit integer;
begin
  v_session := public.safepc_chat_session(p_session_token);
  v_limit := least(greatest(coalesce(p_limit, 100), 1), 100);

  if p_after is null then
    -- Cửa sổ mới nhất: subquery lấy v_limit tin gần nhất (giảm dần),
    -- jsonb_agg sắp lại tăng dần cho trang chat hiển thị.
    return coalesce((
      select jsonb_agg(to_jsonb(m) order by m.created_at, m.id)
      from (
        select id, family_id, child_id, device_id, sender_role, sender_user_id,
               body, parent_read_at, child_read_at, created_at
        from public.messages
        where child_id = v_session.child_id
        order by created_at desc, id desc
        limit v_limit
      ) m
    ), '[]'::jsonb);
  end if;

  return coalesce((
    select jsonb_agg(to_jsonb(m) order by m.created_at, m.id)
    from (
      select id, family_id, child_id, device_id, sender_role, sender_user_id,
             body, parent_read_at, child_read_at, created_at
      from public.messages
      where child_id = v_session.child_id
        and created_at > p_after
      order by created_at asc, id asc
      limit v_limit
    ) m
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.safepc_chat_fetch(text, timestamptz, int) to anon, authenticated, service_role;

-- Con gửi một tin: body cắt khoảng trắng hai đầu; rỗng hoặc dài hơn
-- 2000 ký tự thì từ chối (CHECK của bảng là lớp chặn thứ hai). Trả về
-- hàng tin vừa tạo để trang chat hiển thị ngay.
create or replace function public.safepc_chat_send(
  p_session_token text,
  p_body text
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_session public.chat_sessions;
  v_body text;
  v_message public.messages;
begin
  v_session := public.safepc_chat_session(p_session_token);

  v_body := trim(coalesce(p_body, ''));
  if char_length(v_body) = 0 then
    raise exception 'empty_body' using errcode = 'P0001';
  end if;
  if char_length(v_body) > 2000 then
    raise exception 'body_too_long' using errcode = 'P0001';
  end if;

  insert into public.messages (family_id, child_id, device_id, sender_role, sender_user_id, body)
  values (v_session.family_id, v_session.child_id, v_session.device_id, 'child', null, v_body)
  returning * into v_message;

  return to_jsonb(v_message);
end;
$$;

grant execute on function public.safepc_chat_send(text, text) to anon, authenticated, service_role;

-- Con đánh dấu đã đọc: mọi tin của phụ huynh gửi cho con này chưa có
-- child_read_at thì đóng mốc bây giờ. Trả {updated}.
create or replace function public.safepc_chat_mark_read(
  p_session_token text
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_session public.chat_sessions;
  v_updated integer;
begin
  v_session := public.safepc_chat_session(p_session_token);

  update public.messages
  set child_read_at = now()
  where child_id = v_session.child_id
    and sender_role = 'parent'
    and child_read_at is null;
  get diagnostics v_updated = row_count;

  return jsonb_build_object('updated', v_updated);
end;
$$;

grant execute on function public.safepc_chat_mark_read(text) to anon, authenticated, service_role;

-- ============ 4. RPC phía phụ huynh ============
-- Đánh dấu đã đọc phía phụ huynh: mọi tin của con chưa có
-- parent_read_at thì đóng mốc. Kiểm tra vai trò parent trong gia
-- đình của con, đúng mẫu migration 15.
create or replace function public.safepc_parent_mark_read(
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
  v_updated integer;
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

  if not exists (
    select 1 from public.family_members fm
    where fm.family_id = v_family_id
      and fm.user_id = auth.uid()
      and fm.role = 'parent'
  ) then
    raise exception 'not_a_parent';
  end if;

  update public.messages
  set parent_read_at = now()
  where child_id = p_child_id
    and sender_role = 'child'
    and parent_read_at is null;
  get diagnostics v_updated = row_count;

  return jsonb_build_object('updated', v_updated);
end;
$$;

revoke execute on function public.safepc_parent_mark_read(uuid) from public;
grant execute on function public.safepc_parent_mark_read(uuid) to authenticated;

-- Thu hồi mọi phiên chat đang mở của con (vd máy bị mất, hoặc phụ
-- huynh muốn cắt kênh ngay): mọi phiên chưa thu hồi của con đều đóng.
create or replace function public.safepc_revoke_chat_sessions(
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
  v_revoked integer;
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

  if not exists (
    select 1 from public.family_members fm
    where fm.family_id = v_family_id
      and fm.user_id = auth.uid()
      and fm.role = 'parent'
  ) then
    raise exception 'not_a_parent';
  end if;

  update public.chat_sessions
  set revoked_at = now()
  where child_id = p_child_id
    and revoked_at is null;
  get diagnostics v_revoked = row_count;

  return jsonb_build_object('revoked', v_revoked);
end;
$$;

revoke execute on function public.safepc_revoke_chat_sessions(uuid) from public;
grant execute on function public.safepc_revoke_chat_sessions(uuid) to authenticated;

-- ============ 5. Xóa dữ liệu con: thêm messages + chat_sessions ============
-- CREATE OR REPLACE safepc_delete_child_data của migration 15: thân
-- hàm GIỮ NGUYÊN từng bước của bản gốc, chỉ thêm (a) đếm + xóa
-- messages và chat_sessions của con ở bước 4 mới, (b) hai khóa
-- 'messages' / 'chat_sessions' trong details của hàng audit và trong
-- mục deleted của kết quả trả về. Hai bảng này do CHÍNH migration 29
-- tạo ở mục 1-2 phía trên nên hàm tham chiếu trực tiếp, không cần
-- kiểm tra to_regclass như hai bảng tùy chọn của migration 12/13.
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
      'chat_sessions', v_deleted_chat_sessions
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
      'chat_sessions', v_deleted_chat_sessions
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

--- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ============
--- select column_name from information_schema.columns where table_name = 'messages' order by ordinal_position;
--- Kỳ vọng 10 cột: id, family_id, child_id, device_id, sender_role, sender_user_id, body, parent_read_at, child_read_at, created_at.
--- select column_name from information_schema.columns where table_name = 'chat_sessions' order by ordinal_position;
--- Kỳ vọng 8 cột: id, family_id, child_id, device_id, token_hash, expires_at, revoked_at, created_at.
--- select relrowsecurity from pg_class where relname in ('messages', 'chat_sessions');
--- Kỳ vọng 2 dòng, đều true.
--- select policyname, cmd from pg_policies where tablename = 'messages' order by policyname;
--- Kỳ vọng 2 dòng: family read (SELECT), parent send (INSERT) — chủ đích KHÔNG có policy UPDATE.
--- select policyname from pg_policies where tablename = 'chat_sessions';
--- Kỳ vọng: 0 dòng (chỉ RPC SECURITY DEFINER chạm vào).
--- select proname from pg_proc where proname like 'safepc_%chat%' or proname = 'safepc_mint_chat_session' order by proname;
--- Kỳ vọng 7 hàm: safepc_chat_fetch, safepc_chat_mark_read, safepc_chat_send, safepc_chat_session,
---   safepc_mint_chat_session, safepc_parent_mark_read, safepc_revoke_chat_sessions.
--- select count(*) from public.messages; select count(*) from public.chat_sessions;
--- Kỳ vọng: 0 ngay sau khi áp dụng (chưa có tin nhắn/phiên nào).
