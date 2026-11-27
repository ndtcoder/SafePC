-- SafePC — Migration 26: ngân hàng giờ nhắm đúng hồ sơ con (Sprint 5)
-- Ngày: 21/11/2026. Áp dụng qua Dashboard > SQL Editor (như migration
-- 1-25), chạy một lần, kiểm chứng bằng truy vấn ở cuối file (ghi chú).
--
-- Bối cảnh (PRD §2.11, TODO trong apps/dashboard-web/src/pages/
-- TimeBankTab.tsx): hai RPC ngân hàng giờ của migration 13 chưa biết
-- Sprint 5 —
--   (a) lệnh temporary_override chèn vào KHÔNG có child_id và chỉ nhắm
--       máy có devices.child_id = p_child_id, nên con chỉ-gắn trên máy
--       chung (qua device_child_accounts) không nhận được giờ thưởng
--       (devices_notified đếm thiếu);
--   (b) bước kiểm tra "ghi đè mới nhất" ở RPC thu hồi không lọc
--       child_id: trên máy chung, ghi đè mới nhất thuộc con khác thì
--       thu hồi về 0 không gửi lệnh hủy — bonus của con bị thu hồi vẫn
--       còn hiệu lực trên máy chung tới hết ngày (đúng mô tả TODO;
--       vòng máy của RPC thu hồi bản 13 cũng chỉ gồm máy mặc định
--       của con nên máy chung còn vô hình với thu hồi của con
--       chỉ-gắn).
--
-- Migration này CREATE OR REPLACE cả hai RPC, GIỮ NGUYÊN chữ ký, kiểm
-- tra đầu vào, khóa tư vấn theo con, ngữ nghĩa cộng dồn theo TỔNG và
-- hình dạng payload của migration 13 (trường hợp một con một máy cho
-- kết quả y hệt bản cũ — lệnh chỉ khác ở cột child_id được điền thay
-- vì NULL, đúng ngữ nghĩa cột này từ migration 24: lệnh có child_id
-- được Agent giữ pending tới khi đúng con đó active trên máy). Ba
-- thay đổi duy nhất, đúng thiết kế TODO:
--   1. Mọi lệnh chèn ra mang child_id = hồ sơ con được thưởng/thu hồi.
--   2. Tập máy đích = máy có devices.child_id = p_child_id UNION máy
--      có ánh xạ device_child_accounts.child_id = p_child_id (máy
--      thỏa cả hai chỉ tính một lần — devices_notified đếm máy phân
--      biệt).
--   3. Bước kiểm tra ghi đè mới nhất ở RPC thu hồi thêm điều kiện
--      (child_id = v_grant.child_id OR child_id IS NULL) — NULL là
--      lệnh legacy (migration 13/17 sinh trước Sprint 5, gồm cả lệnh
--      đồng bộ lúc ghép nối của migration 17) vẫn được công nhận là
--      của con như trước.
--
-- YÊU CẦU: migration 13 (bảng + hai RPC ngân hàng giờ) và migration
-- 24 (cột commands.child_id + bảng device_child_accounts) ĐÃ ÁP
-- TRƯỚC. Thân hàm tham chiếu hai bảng/cột đó trực tiếp.
--
-- Không có secret hay giá trị thật nào trong file này. File chạy lại
-- an toàn (CREATE OR REPLACE, GRANT lặp lại được như migration 17).

-- ============ 1. Thưởng phút (thay thế thân hàm migration 13) ============
-- Trả về: grant_id, total_minutes (tổng phút còn hiệu lực sau lần này),
-- expires_at (hạn xa nhất trong các lần còn hiệu lực), devices_notified
-- (số máy phân biệt đã gửi lệnh; gồm máy chỉ-gắn của con).
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

  -- Chỉ phụ huynh trong gia đình mới được thưởng giờ (giữ nguyên
  -- migration 13).
  if not exists (
    select 1 from public.family_members fm
    where fm.family_id = v_family_id
      and fm.user_id = auth.uid()
      and fm.role = 'parent'
  ) then
    raise exception 'not_a_parent';
  end if;

  -- Khóa theo con cho hết transaction (giữ nguyên migration 13).
  perform pg_advisory_xact_lock(hashtext('safepc_time_bank_' || p_child_id::text));

  insert into public.time_bank_grants (family_id, child_id, minutes, reason, granted_by, status, expires_at)
  values (v_family_id, p_child_id, p_minutes, nullif(trim(coalesce(p_reason, '')), ''), auth.uid(), 'active', p_expires_at)
  returning id into v_grant_id;

  -- Tổng + hạn xa nhất (giữ nguyên công thức migration 13).
  select coalesce(sum(minutes), 0), max(expires_at)
    into v_total, v_max_expires
  from public.time_bank_grants
  where child_id = p_child_id
    and status = 'active'
    and expires_at > now();

  -- Gửi lệnh cộng giờ mang TỔNG số dư (Sprint 5: lệnh mang child_id
  -- của con; tập máy đích gồm máy mặc định của con VÀ máy chung có
  -- ánh xạ tới con — điều kiện OR trên cùng một hàng devices nên máy
  -- thỏa cả hai chỉ sinh một lệnh).
  insert into public.commands (family_id, device_id, child_id, type, payload, status)
  select v_family_id, d.id, p_child_id, 'temporary_override',
    jsonb_build_object(
      'action', 'bonus_minutes',
      'minutes', v_total,
      'expires_at', v_max_expires,
      'source', 'time_bank'
    ),
    'pending'
  from public.devices d
  where d.family_id = v_family_id
    and (
      d.child_id = p_child_id
      or exists (
        select 1 from public.device_child_accounts a
        where a.device_id = d.id
          and a.child_id = p_child_id
      )
    );
  get diagnostics v_devices = row_count;

  return jsonb_build_object(
    'grant_id', v_grant_id,
    'total_minutes', v_total,
    'expires_at', v_max_expires,
    'devices_notified', v_devices
  );
end;
$$;

-- ============ 2. Thu hồi một lần thưởng (thay thế thân hàm migration 13) ============
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

  -- Khóa theo con cho hết transaction, cùng khóa với RPC thưởng.
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

  -- Tổng + hạn xa nhất (giữ nguyên công thức migration 13).
  select coalesce(sum(minutes), 0), max(expires_at)
    into v_total, v_max_expires
  from public.time_bank_grants
  where child_id = v_grant.child_id
    and status = 'active'
    and expires_at > now();

  -- Sprint 5: vòng máy đích là tập hợp nhất như RPC thưởng (máy mặc
  -- định của con + máy chung có ánh xạ tới con).
  for v_device in
    select d.id from public.devices d
    where d.family_id = v_grant.family_id
      and (
        d.child_id = v_grant.child_id
        or exists (
          select 1 from public.device_child_accounts a
          where a.device_id = d.id
            and a.child_id = v_grant.child_id
        )
      )
  loop
    if v_total > 0 then
      insert into public.commands (family_id, device_id, child_id, type, payload, status)
      values (v_grant.family_id, v_device.id, v_grant.child_id, 'temporary_override',
        jsonb_build_object(
          'action', 'bonus_minutes',
          'minutes', v_total,
          'expires_at', v_max_expires,
          'source', 'time_bank'
        ), 'pending');
      v_devices := v_devices + 1;
    else
      -- Tổng về 0: chỉ gửi lệnh hủy khi ghi đè mới nhất TRONG PHẠM VI
      -- CỦA CON NÀY trên máy là lệnh cộng giờ của ngân hàng (Sprint
      -- 5: thêm lọc child_id — lệnh của con khác trên cùng máy chung
      -- không còn ảnh hưởng quyết định; lệnh legacy child_id NULL
      -- vẫn tính là của con như trước migration 26).
      v_latest := null;
      select c.payload into v_latest
      from public.commands c
      where c.device_id = v_device.id
        and c.type = 'temporary_override'
        and (c.child_id = v_grant.child_id or c.child_id is null)
      order by c.created_at desc
      limit 1;
      if found and (v_latest ->> 'action') = 'bonus_minutes'
        and (v_latest ->> 'source') = 'time_bank' then
        insert into public.commands (family_id, device_id, child_id, type, payload, status)
        values (v_grant.family_id, v_device.id, v_grant.child_id, 'temporary_override',
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

-- Quyền gọi giữ nguyên như migration 13 (CREATE OR REPLACE đã giữ
-- quyền cũ; cấp lại cho rõ và để chạy lại an toàn).
revoke execute on function public.safepc_grant_time_bank(uuid, integer, text, timestamptz) from public;
revoke execute on function public.safepc_void_time_bank_grant(uuid) from public;
grant execute on function public.safepc_grant_time_bank(uuid, integer, text, timestamptz) to authenticated;
grant execute on function public.safepc_void_time_bank_grant(uuid) to authenticated;

-- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ============
-- 1. Hai RPC vẫn đúng 1 hàm mỗi tên, đúng chữ ký migration 13:
-- select proname, pg_get_function_identity_arguments(oid) from pg_proc where proname in ('safepc_grant_time_bank', 'safepc_void_time_bank_grant') order by proname;
-- Kỳ vọng: 2 hàng — (uuid, integer, text, timestamptz) và (uuid).
--
-- 2. Thưởng cho con CHỈ GẮN trên máy chung (không có máy mặc định):
--    Dashboard tab Ngân hàng giờ báo lệnh tới được máy chung và lệnh mang đúng con:
-- select device_id, child_id, payload from public.commands where type = 'temporary_override' and payload ->> 'source' = 'time_bank' order by created_at desc limit 5;
-- Kỳ vọng: có lệnh cho máy chung, child_id = hồ sơ con được thưởng, payload bonus_minutes mang tổng.
--
-- 3. Thu hồi về 0 trên máy chung có ghi đè mới nhất của con khác:
-- Kỳ vọng: vẫn sinh lệnh cancel mang child_id của con bị thu hồi (trước migration 26 thì không).
