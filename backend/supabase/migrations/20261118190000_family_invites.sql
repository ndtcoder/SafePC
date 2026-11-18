-- SafePC — Migration 14: mời phụ huynh thứ hai (family invites)
-- Ngày: 18/11/2026. Áp dụng qua Dashboard > SQL Editor (như migration 1-13),
-- chạy một lần, kiểm chứng bằng truy vấn ở cuối file (ghi chú).
--
-- Bối cảnh (PRD §2.8): phụ huynh thứ hai cùng quản lý gia đình. Cấu trúc
-- family_members đã hỗ trợ sẵn role 'parent'; migration này thêm cơ chế
-- lời mời an toàn để đưa tài khoản thứ hai vào đúng gia đình.
--
-- Thiết kế (không dùng Supabase Auth invite, không cần Edge Function):
-- người mời (chỉ chủ gia đình) tạo lời mời gắn với một địa chỉ email; link
-- lời mời mang token ngẫu nhiên 256-bit, người mời tự gửi link cho người
-- được mời (nhắn tin/Zalo). Link chỉ là phương tiện mang token — token
-- thô không bao giờ xuống database, chỉ lưu SHA-256 hex (cùng quy ước mã
-- ghép nối ở migration 1). Người được mời mở link, đăng nhập/đăng ký bằng
-- ĐÚNG email được mời, bấm chấp nhận thì RPC kiểm tra ràng buộc email
-- (qua claim email trong JWT), hết hạn, dùng một lần, rồi mới thêm vào
-- family_members với role 'parent'.
--
-- Vì sao không gửi email mời từ hệ thống trong đợt này: Resend chưa có
-- domain xác minh nên chỉ gửi được tới đúng email đăng ký Resend, còn
-- Supabase Auth invite cần Edge Function + khóa quản trị. Gửi link bằng
-- tay chạy được đầu-cuối ngay hôm nay; gửi email tự động là follow-up
-- sau khi domain ndt.ap.vn xác minh xong.
--
-- Migration này:
--
-- 1. Tạo bảng family_invites: một hàng cho mỗi lời mời (email được mời,
--    hash token, người mời, hạn, trạng thái chấp nhận/thu hồi). RLS bật,
--    thành viên gia đình chỉ đọc; ghi chỉ qua 3 RPC dưới đây.
-- 2. RPC safepc_create_family_invite: chủ gia đình tạo lời mời (kiểm tra
--    quyền owner, định dạng email/hash, hạn trong tương lai và không quá
--    30 ngày, không trùng lời mời đang chờ cho cùng email).
-- 3. RPC safepc_accept_family_invite: người được mời chấp nhận. Trả về
--    JSON có status thay vì raise lỗi nghiệp vụ: 'accepted',
--    'email_mismatch' (kèm email được mời để giao diện giải thích),
--    'already_has_family' (tài khoản đã có gia đình riêng — Dashboard
--    theo mô hình một gia đình một tài khoản), hoặc 'invalid' gộp chung
--    cho mọi trường hợp còn lại (không tìm thấy, hết hạn, đã dùng, đã
--    thu hồi) để không tạo oracle dò token.
-- 4. RPC safepc_revoke_family_invite: chủ gia đình thu hồi lời mời chưa
--    được chấp nhận. Lời mời đã chấp nhận thì không thu hồi được (gỡ
--    thành viên là tính năng riêng, chưa có trong đợt này).
--
-- Không có secret hay giá trị thật nào trong file này. File chạy lại an
-- toàn (IF NOT EXISTS, DROP POLICY IF EXISTS, CREATE OR REPLACE).

-- ============ 1. Bảng lời mời ============
create table if not exists public.family_invites (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  -- Email được mời, đã chuẩn hóa (trim + chữ thường) trước khi ghi; CHECK
  -- bắt buộc dạng đã chuẩn hóa để không có hai hàng chỉ khác nhau chữ hoa.
  invited_email text not null check (
    invited_email = lower(trim(invited_email))
    and char_length(invited_email) <= 254
    and invited_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  -- SHA-256 hex CHỮ THƯỜNG của token (token thô không bao giờ xuống DB).
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by uuid not null references auth.users (id),
  -- Hạn lời mời (Dashboard gửi 7 ngày; RPC chặn hạn quá 30 ngày).
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- Token là khóa tra cứu lúc chấp nhận; UNIQUE để một hash chỉ khớp tối
-- đa một lời mời (token 256-bit nên va chạm thực tế không xảy ra; UNIQUE
-- là phòng thủ sâu cho logic chấp nhận).
create unique index if not exists family_invites_token_hash_key
  on public.family_invites (token_hash);
create index if not exists family_invites_family_idx
  on public.family_invites (family_id, created_at desc);

alter table public.family_invites enable row level security;

drop policy if exists "family read" on public.family_invites;
create policy "family read" on public.family_invites
  for select using (public.is_family_member(family_id));
-- Không có policy ghi cho user thường: chỉ 3 RPC SECURITY DEFINER bên
-- dưới được ghi (chúng tự kiểm tra quyền owner / ràng buộc email).
-- Lưu ý: policy đọc cho thấy cả token_hash với thành viên gia đình, nhưng
-- hash SHA-256 của token 256-bit không suy ra được token thô, và Dashboard
-- không SELECT cột này khi liệt kê lời mời.

-- ============ 2. Tạo lời mời ============
-- Trả về: invite_id, invited_email, expires_at.
create or replace function public.safepc_create_family_invite(
  p_email text,
  p_token_hash text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_family_id uuid;
  v_email text;
  v_caller_email text;
  v_invite_id uuid;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated';
  end if;

  v_email := lower(trim(coalesce(p_email, '')));
  if char_length(v_email) = 0
    or char_length(v_email) > 254
    or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  then
    raise exception 'invalid_email';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_token_hash';
  end if;
  if p_expires_at is null
    or p_expires_at <= now()
    or p_expires_at > now() + interval '30 days'
  then
    raise exception 'invalid_expires_at';
  end if;

  -- Chỉ CHỦ gia đình mới được mời thêm phụ huynh — cùng ranh giới với
  -- policy "owner manage" trên family_members (chủ gia đình quản lý
  -- thành viên; phụ huynh thứ hai không mời thêm người thứ ba).
  select f.id into v_family_id
  from public.families f
  where f.owner_id = auth.uid()
  order by f.created_at asc
  limit 1;
  if v_family_id is null then
    raise exception 'not_family_owner';
  end if;

  -- Không tự mời chính mình (so bằng claim email trong JWT; thiếu claim
  -- thì bỏ qua kiểm tra này — bước chấp nhận vẫn ràng buộc đúng email).
  v_caller_email := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
  if v_caller_email <> '' and v_caller_email = v_email then
    raise exception 'cannot_invite_self';
  end if;

  -- Khóa theo gia đình cho hết transaction: hai lần tạo lời mời cùng
  -- email chạy chồng nhau sẽ nối tiếp nhau, bên sau thấy hàng của bên
  -- trước và bị chặn trùng — không tạo hai link cùng hiệu lực.
  perform pg_advisory_xact_lock(hashtext('safepc_invite_' || v_family_id::text));

  if exists (
    select 1 from public.family_invites i
    where i.family_id = v_family_id
      and i.invited_email = v_email
      and i.accepted_at is null
      and i.revoked_at is null
      and i.expires_at > now()
  ) then
    raise exception 'duplicate_pending_invite';
  end if;

  insert into public.family_invites (family_id, invited_email, token_hash, invited_by, expires_at)
  values (v_family_id, v_email, p_token_hash, auth.uid(), p_expires_at)
  returning id into v_invite_id;

  return jsonb_build_object(
    'invite_id', v_invite_id,
    'invited_email', v_email,
    'expires_at', p_expires_at
  );
end;
$$;

-- ============ 3. Chấp nhận lời mời ============
-- Trả về JSON có status (xem ghi chú ở đầu file). Không raise lỗi nghiệp
-- vụ: Dashboard phân biệt các trường hợp bằng status, và 'invalid' gộp
-- chung để không lộ token nào tồn tại/hết hạn/đã dùng.
create or replace function public.safepc_accept_family_invite(
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_invite public.family_invites;
  v_caller_email text;
  v_family_name text;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- Khóa theo token cho hết transaction: hai lần chấp nhận cùng token
  -- chạy chồng nhau sẽ nối tiếp nhau, bên sau thấy accepted_at của bên
  -- trước và trả 'invalid' — lời mời chỉ dùng được đúng một lần.
  perform pg_advisory_xact_lock(hashtext('safepc_invite_token_' || p_token_hash));

  select * into v_invite
  from public.family_invites
  where token_hash = p_token_hash;
  if not found
    or v_invite.revoked_at is not null
    or v_invite.accepted_at is not null
    or v_invite.expires_at <= now()
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- Ràng buộc email: chỉ tài khoản đăng nhập bằng ĐÚNG email được mời
  -- mới chấp nhận được. Claim email lấy từ JWT của phiên hiện tại; thiếu
  -- claim thì từ chối (fail-closed) thay vì chấp nhận mù.
  v_caller_email := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
  if v_caller_email = '' or v_caller_email <> v_invite.invited_email then
    return jsonb_build_object(
      'status', 'email_mismatch',
      'invited_email', v_invite.invited_email
    );
  end if;

  -- Dashboard theo mô hình một gia đình một tài khoản (getMyFamily ưu
  -- tiên gia đình do user làm chủ): tài khoản đã có gia đình riêng mà
  -- chấp nhận thì sẽ không bao giờ thấy gia đình được mời, gây hiểu nhầm
  -- lặng lẽ. Từ chối rõ ràng để người được mời dùng tài khoản khác.
  if exists (
    select 1 from public.families f where f.owner_id = auth.uid()
  ) then
    return jsonb_build_object('status', 'already_has_family');
  end if;

  -- Trường hợp còn lại: đã là thành viên (không phải chủ) của một gia
  -- đình KHÁC — getMyFamily không có giao diện chuyển gia đình nên gia
  -- đình còn lại sẽ vô hình lặng lẽ. Chỉ loại trừ gia đình khác, để
  -- chấp nhận lũy đẳng khi đã là thành viên của đúng gia đình được mời
  -- (đường ON CONFLICT DO NOTHING bên dưới) vẫn thành công.
  if exists (
    select 1 from public.family_members fm
    where fm.user_id = auth.uid() and fm.family_id <> v_invite.family_id
  ) then
    return jsonb_build_object('status', 'already_has_family');
  end if;

  -- Thêm thành viên + đánh dấu đã dùng trong cùng một transaction.
  -- ON CONFLICT DO NOTHING: người được mời đã là thành viên (vd được
  -- thêm bằng đường khác) thì chấp nhận vẫn thành công, lũy đẳng.
  insert into public.family_members (family_id, user_id, role)
  values (v_invite.family_id, auth.uid(), 'parent')
  on conflict (family_id, user_id) do nothing;

  update public.family_invites
  set accepted_at = now(), accepted_by = auth.uid()
  where id = v_invite.id and accepted_at is null;

  select name into v_family_name
  from public.families
  where id = v_invite.family_id;

  return jsonb_build_object(
    'status', 'accepted',
    'family_id', v_invite.family_id,
    'family_name', v_family_name
  );
end;
$$;

-- ============ 4. Thu hồi lời mời ============
-- Trả về: status 'revoked' | 'already_accepted' | 'already_revoked'.
create or replace function public.safepc_revoke_family_invite(
  p_invite_id uuid
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_invite public.family_invites;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated';
  end if;

  select * into v_invite
  from public.family_invites
  where id = p_invite_id;
  if not found then
    raise exception 'invite_not_found';
  end if;

  -- Chỉ chủ của đúng gia đình này mới được thu hồi lời mời của nó.
  if not exists (
    select 1 from public.families f
    where f.id = v_invite.family_id and f.owner_id = auth.uid()
  ) then
    raise exception 'not_family_owner';
  end if;

  -- Cùng khóa với hàm accept (theo token_hash) để thu hồi và chấp nhận
  -- không chạy chồng nhau. Đọc lại sau khi giữ khóa vì ảnh chụp trước
  -- khóa có thể đã cũ nếu accept chạy xong trong khoảng giữa — nếu
  -- không, revoke có thể báo 'revoked' trong khi lời mời vừa được
  -- chấp nhận.
  perform pg_advisory_xact_lock(hashtext('safepc_invite_token_' || v_invite.token_hash));

  select * into v_invite
  from public.family_invites
  where id = p_invite_id;

  if v_invite.accepted_at is not null then
    return jsonb_build_object('status', 'already_accepted');
  end if;
  if v_invite.revoked_at is not null then
    return jsonb_build_object('status', 'already_revoked');
  end if;

  update public.family_invites
  set revoked_at = now()
  where id = p_invite_id and accepted_at is null and revoked_at is null;

  return jsonb_build_object('status', 'revoked');
end;
$$;

-- Chỉ tài khoản đã đăng nhập (vai trò authenticated) được gọi 3 RPC này;
-- kiểm tra quyền nằm trong thân hàm. Thu hồi quyền mặc định của public
-- trước (theo mẫu migration 3 và 13).
revoke execute on function public.safepc_create_family_invite(text, text, timestamptz) from public;
revoke execute on function public.safepc_accept_family_invite(text) from public;
revoke execute on function public.safepc_revoke_family_invite(uuid) from public;
grant execute on function public.safepc_create_family_invite(text, text, timestamptz) to authenticated;
grant execute on function public.safepc_accept_family_invite(text) to authenticated;
grant execute on function public.safepc_revoke_family_invite(uuid) to authenticated;

-- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ===========
-- 1. Bảng + index + policy đã tạo:
-- select tablename from pg_tables where schemaname = 'public' and tablename = 'family_invites';
-- select indexname from pg_indexes where schemaname = 'public' and tablename = 'family_invites';
-- select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'family_invites';
-- Kỳ vọng: 1 bảng, 3 index (family_invites_pkey do khóa chính tự tạo + family_invites_token_hash_key UNIQUE + family_invites_family_idx), 1 policy SELECT ("family read").
--
-- 2. Ba RPC đã tạo:
-- select proname from pg_proc where proname in ('safepc_create_family_invite', 'safepc_accept_family_invite', 'safepc_revoke_family_invite');
-- Kỳ vọng: 3 hàm.
--
-- 3. Sau lời mời đầu tiên từ Dashboard: hàng lời mời (chỉ hash, không token thô):
-- select family_id, invited_email, length(token_hash) as hash_len, expires_at, accepted_at, revoked_at from public.family_invites order by created_at desc limit 5;
-- Kỳ vọng: 1 hàng, hash_len = 64, accepted_at và revoked_at đều null.
--
-- 4. Sau khi người được mời chấp nhận: thành viên mới có role 'parent':
-- select family_id, user_id, role from public.family_members order by created_at desc limit 5;
-- Kỳ vọng: thêm 1 hàng role 'parent' trong đúng gia đình đã mời.
