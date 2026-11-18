-- SafePC — Migration 13: ngân hàng giờ (time bank)
-- Ngày: 18/11/2026. Áp dụng qua Dashboard > SQL Editor (như migration 1-12),
-- chạy một lần, kiểm chứng bằng truy vấn ở cuối file (ghi chú).
--
-- Bối cảnh (PRD §2.8): phụ huynh thưởng thêm giờ cho con kèm lý do và
-- lịch sử; con thấy được giờ thưởng của mình trên Tray.
--
-- Ngữ nghĩa (giữ nguyên ngữ nghĩa bonus_minutes hiện có, không phát minh
-- thêm): mỗi lần thưởng cộng phút vào MỨC TRẦN GIỜ HÔM NAY của con, hiệu
-- lực tới hết ngày theo giờ địa phương — không phải mở khóa, không cộng
-- dồn qua ngày. Điểm mới so với form ghi đè cũ: nhiều lần thưởng trong
-- cùng ngày CỘNG DỒN với nhau (form cũ thay thế). Cộng dồn được thực hiện
-- ở tầng RPC: mỗi lần thưởng/thu hồi, RPC gửi lệnh temporary_override
-- mang TỔNG số phút còn hiệu lực tới mọi máy của con — Agent vẫn chỉ giữ
-- 1 ghi đè duy nhất (lệnh mới nhất thắng) nên không cần đổi Agent.
--
-- Migration này:
--
-- 1. Tạo bảng time_bank_grants: một hàng cho mỗi lần thưởng (phút, lý do,
--    người thưởng, trạng thái, hạn). RLS bật, phụ huynh chỉ đọc được hàng
--    của gia đình mình; ghi chỉ qua 2 RPC dưới đây.
-- 2. RPC safepc_grant_time_bank: phụ huynh thưởng phút (kiểm tra vai trò
--    parent), ghi hàng sổ cái + gửi lệnh cộng giờ mang tổng số dư tới mọi
--    máy của con, nguyên tử trong một transaction.
-- 3. RPC safepc_void_time_bank_grant: phụ huynh thu hồi một lần thưởng còn
--    hiệu lực; tính lại tổng và gửi lệnh mới. Tổng về 0 thì chỉ gửi lệnh
--    hủy khi ghi đè đang hiệu lực trên máy là lệnh cộng giờ của ngân hàng
--    (không hủy nhầm lệnh mở khóa/khóa tay của phụ huynh).
--
-- Không có secret hay giá trị thật nào trong file này. File chạy lại an
-- toàn (IF NOT EXISTS, DROP POLICY IF EXISTS, CREATE OR REPLACE).

-- ============ 1. Bảng sổ cái thưởng giờ ============
create table if not exists public.time_bank_grants (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  child_id uuid not null references public.children (id) on delete cascade,
  -- Phút thưởng của lần này (1-240, cùng biên với yêu cầu xin thêm giờ).
  minutes integer not null check (minutes >= 1 and minutes <= 240),
  -- Lý do phụ huynh ghi (không bắt buộc); RPC chuẩn hóa chuỗi trắng thành null.
  reason text check (reason is null or char_length(reason) <= 500),
  granted_by uuid not null references auth.users (id),
  -- 'active': đang tính vào tổng; 'voided': đã thu hồi, không tính nữa.
  -- Hết hạn không đổi status: tổng chỉ tính hàng còn hạn (expires_at > now()).
  status text not null default 'active' check (status in ('active', 'voided')),
  -- Hết ngày hôm nay theo giờ địa phương (Dashboard tính và truyền vào,
  -- cùng công thức form ghi đè ở RulesPage). Hết hạn thì không tính vào
  -- tổng nữa, nhưng hàng lịch sử vẫn giữ nguyên.
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists time_bank_grants_child_idx
  on public.time_bank_grants (child_id, status, expires_at);

alter table public.time_bank_grants enable row level security;

drop policy if exists "family read" on public.time_bank_grants;
create policy "family read" on public.time_bank_grants
  for select using (public.is_family_member(family_id));
-- Không có policy ghi cho user thường: chỉ 2 RPC SECURITY DEFINER bên
-- dưới được ghi (chúng tự kiểm tra vai trò phụ huynh).

-- ============ 2. Thưởng phút ============
-- Trả về: grant_id, total_minutes (tổng phút còn hiệu lực sau lần này),
-- expires_at (hạn xa nhất trong các lần còn hiệu lực), devices_notified
-- (số máy đã gửi lệnh; 0 khi con chưa có máy nào).
create or replace function public.safepc_grant_time_bank(
  p_child_id uuid,
  p_minutes integer,
  p_reason text,
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
  v_grant_id uuid;
  v_total integer;
  v_max_expires timestamptz;
  v_devices integer := 0;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated';
  end if;
  if p_minutes is null or p_minutes < 1 or p_minutes > 240 then
    raise exception 'invalid_minutes';
  end if;
  if p_reason is not null and char_length(trim(p_reason)) > 500 then
    raise exception 'reason_too_long';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'invalid_expires_at';
  end if;

  select family_id into v_family_id
  from public.children
  where id = p_child_id;
  if v_family_id is null then
    raise exception 'child_not_found';
  end if;

  -- Chỉ phụ huynh trong gia đình mới được thưởng giờ (chặt hơn RLS
  -- is_family_member chung của app, vì đây là hành động của riêng phụ
  -- huynh; Dashboard chỉ có tài khoản phụ huynh nên không ảnh hưởng
  -- luồng hiện tại).
  if not exists (
    select 1 from public.family_members fm
    where fm.family_id = v_family_id
      and fm.user_id = auth.uid()
      and fm.role = 'parent'
  ) then
    raise exception 'not_a_parent';
  end if;

  -- Khóa theo con cho hết transaction (cùng khóa với RPC thu hồi):
  -- hai lần thưởng/thu hồi cùng con chạy chồng nhau sẽ nối tiếp nhau,
  -- mỗi bên SUM thấy đầy đủ sổ cái của bên trước — không lệch tổng
  -- lặng lẽ giữa sổ cái và lệnh gửi xuống máy.
  perform pg_advisory_xact_lock(hashtext('safepc_time_bank_' || p_child_id::text));

  insert into public.time_bank_grants (family_id, child_id, minutes, reason, granted_by, status, expires_at)
  values (v_family_id, p_child_id, p_minutes, nullif(trim(coalesce(p_reason, '')), ''), auth.uid(), 'active', p_expires_at)
  returning id into v_grant_id;

  -- Tổng + hạn xa nhất. Hạn xa nhất chỉ đúng vì mọi lần thưởng cùng hết
  -- ngày hôm nay (Dashboard luôn truyền cuối ngày); caller tương lai
  -- không được truyền hạn khác nhau cho các lần thưởng.
  select coalesce(sum(minutes), 0), max(expires_at)
    into v_total, v_max_expires
  from public.time_bank_grants
  where child_id = p_child_id
    and status = 'active'
    and expires_at > now();

  -- Gửi lệnh cộng giờ mang TỔNG số dư tới mọi máy của con. Lệnh mang
  -- thêm 'source': 'time_bank' để RPC thu hồi nhận ra lệnh của ngân
  -- hàng (Agent bỏ qua trường thừa trong payload).
  insert into public.commands (family_id, device_id, type, payload, status)
  select v_family_id, d.id, 'temporary_override',
    jsonb_build_object(
      'action', 'bonus_minutes',
      'minutes', v_total,
      'expires_at', v_max_expires,
      'source', 'time_bank'
    ),
    'pending'
  from public.devices d
  where d.child_id = p_child_id
    and d.family_id = v_family_id;
  get diagnostics v_devices = row_count;

  return jsonb_build_object(
    'grant_id', v_grant_id,
    'total_minutes', v_total,
    'expires_at', v_max_expires,
    'devices_notified', v_devices
  );
end;
$$;

-- ============ 3. Thu hồi một lần thưởng ============
-- Trả về cùng hình dạng RPC thưởng (không có grant_id). Thu hồi lại lần
-- nữa thì không làm gì thêm (lũy đẳng), trả về tổng hiện tại.
create or replace function public.safepc_void_time_bank_grant(
  p_grant_id uuid
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_grant public.time_bank_grants;
  v_total integer;
  v_max_expires timestamptz;
  v_devices integer := 0;
  v_device record;
  v_latest jsonb;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated';
  end if;

  select * into v_grant
  from public.time_bank_grants
  where id = p_grant_id;
  if not found then
    raise exception 'grant_not_found';
  end if;

  if not exists (
    select 1 from public.family_members fm
    where fm.family_id = v_grant.family_id
      and fm.user_id = auth.uid()
      and fm.role = 'parent'
  ) then
    raise exception 'not_a_parent';
  end if;

  -- Khóa theo con cho hết transaction, cùng khóa với RPC thưởng (xem
  -- ghi chú ở đó): nối tiếp mọi cặp thưởng/thu hồi cùng con.
  perform pg_advisory_xact_lock(hashtext('safepc_time_bank_' || v_grant.child_id::text));

  if v_grant.status = 'voided' then
    select coalesce(sum(minutes), 0), max(expires_at)
      into v_total, v_max_expires
    from public.time_bank_grants
    where child_id = v_grant.child_id
      and status = 'active'
      and expires_at > now();
    return jsonb_build_object(
      'total_minutes', v_total,
      'expires_at', v_max_expires,
      'devices_notified', 0
    );
  end if;

  update public.time_bank_grants
  set status = 'voided'
  where id = p_grant_id;

  -- Tổng + hạn xa nhất (cùng giả định như RPC thưởng: mọi lần cùng hết
  -- ngày hôm nay, xem ghi chú ở đó).
  select coalesce(sum(minutes), 0), max(expires_at)
    into v_total, v_max_expires
  from public.time_bank_grants
  where child_id = v_grant.child_id
    and status = 'active'
    and expires_at > now();

  for v_device in
    select d.id from public.devices d
    where d.child_id = v_grant.child_id
      and d.family_id = v_grant.family_id
  loop
    if v_total > 0 then
      insert into public.commands (family_id, device_id, type, payload, status)
      values (v_grant.family_id, v_device.id, 'temporary_override',
        jsonb_build_object(
          'action', 'bonus_minutes',
          'minutes', v_total,
          'expires_at', v_max_expires,
          'source', 'time_bank'
        ), 'pending');
      v_devices := v_devices + 1;
    else
      -- Tổng về 0: chỉ gửi lệnh hủy khi ghi đè mới nhất trên máy là
      -- lệnh cộng giờ của ngân hàng — lệnh mở khóa/khóa tay phụ huynh
      -- gửi sau đó phải được giữ nguyên.
      v_latest := null;
      select c.payload into v_latest
      from public.commands c
      where c.device_id = v_device.id
        and c.type = 'temporary_override'
      order by c.created_at desc
      limit 1;
      if found and (v_latest ->> 'action') = 'bonus_minutes'
        and (v_latest ->> 'source') = 'time_bank' then
        insert into public.commands (family_id, device_id, type, payload, status)
        values (v_grant.family_id, v_device.id, 'temporary_override',
          jsonb_build_object('action', 'cancel', 'source', 'time_bank'), 'pending');
        v_devices := v_devices + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'total_minutes', v_total,
    'expires_at', v_max_expires,
    'devices_notified', v_devices
  );
end;
$$;

-- Chỉ tài khoản đã đăng nhập (vai trò authenticated) được gọi 2 RPC này;
-- kiểm tra phụ huynh nằm trong thân hàm. Thu hồi quyền mặc định của
-- public trước (theo mẫu safepc_auth_device ở migration 3).
revoke execute on function public.safepc_grant_time_bank(uuid, integer, text, timestamptz) from public;
revoke execute on function public.safepc_void_time_bank_grant(uuid) from public;
grant execute on function public.safepc_grant_time_bank(uuid, integer, text, timestamptz) to authenticated;
grant execute on function public.safepc_void_time_bank_grant(uuid) to authenticated;

-- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ===========
-- 1. Bảng + index + policy đã tạo:
-- select tablename from pg_tables where schemaname = 'public' and tablename = 'time_bank_grants';
-- select indexname from pg_indexes where schemaname = 'public' and tablename = 'time_bank_grants';
-- select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'time_bank_grants';
-- Kỳ vọng: 1 bảng, 1 index (time_bank_grants_child_idx), 1 policy SELECT ("family read").
--
-- 2. Hai RPC đã tạo:
-- select proname from pg_proc where proname in ('safepc_grant_time_bank', 'safepc_void_time_bank_grant');
-- Kỳ vọng: 2 hàm.
--
-- 3. Sau lần thưởng đầu tiên từ Dashboard: hàng sổ cái + lệnh đã gửi:
-- select child_id, minutes, status, expires_at from public.time_bank_grants order by created_at desc limit 5;
-- select device_id, type, payload from public.commands where type = 'temporary_override' and payload ->> 'source' = 'time_bank' order by created_at desc limit 5;
-- Kỳ vọng: 1 hàng 'active' và 1 lệnh bonus_minutes mang tổng số phút trên mỗi máy của con.
