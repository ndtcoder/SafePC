-- SafePC — Migration 17: đồng bộ tổng ngân hàng giờ cho máy mới ghép nối
-- Ngày: 18/11/2026. Áp dụng qua Dashboard > SQL Editor (như migration 1-16),
-- chạy một lần, kiểm chứng bằng truy vấn ở cuối file (ghi chú).
--
-- Bối cảnh: RPC thưởng/thu hồi ngân hàng giờ (migration 13) chỉ gửi lệnh
-- temporary_override mang tổng số dư tới các máy ĐÃ ghép nối lúc đó. Máy
-- ghép nối SAU một lần thưởng không nhận được tổng cho tới lần thưởng/thu
-- hồi tiếp theo — khoảng trống này khiến Tray trên máy mới không hiện câu
-- giờ thưởng dù con vẫn còn giờ thưởng trong ngày.
--
-- Cách sửa: mở rộng hàm đổi mã pairing safepc_redeem_pairing_code
-- (migration 3) — thay toàn bộ thân hàm bằng CREATE OR REPLACE, giữ
-- nguyên chữ ký và quyền gọi — để ngay trong transaction tạo máy mới,
-- nếu con có tổng phút thưởng còn hiệu lực thì chèn thêm MỘT lệnh
-- temporary_override mang tổng đó (đúng hình dạng lệnh của RPC thưởng:
-- action bonus_minutes, minutes = tổng, expires_at = hạn xa nhất,
-- source = 'time_bank') ở trạng thái pending cho chính máy vừa tạo.
-- Vòng poll 15 giây của Agent nhận lệnh này như mọi lệnh khác: máy mới
-- chưa có mốc sàn nên lệnh được áp ngay, lưu ghi đè kèm created_at của
-- lệnh, và ack done như thường. Không cần đổi Agent, Dashboard hay
-- extension; không thêm RPC mới, không thêm secret.
--
-- Vì sao đi bằng lệnh thật thay vì RPC đọc riêng: lệnh có created_at do
-- Postgres sinh nên tự đi qua cơ chế mốc chống lệnh cũ của Agent (đợt
-- cứng hóa 18/11/2026): lệnh thưởng sau đó mới hơn sẽ thắng lệnh đồng
-- bộ, và lệnh đồng bộ gửi lại sau (ack rớt) sẽ bị bỏ qua vì cũ hơn mốc
-- đang hiệu lực. RPC đọc riêng sẽ phải tự phát minh mốc giờ và đường
-- ack — rủi ro hơn mà không thêm được gì.
--
-- Chống đua tranh: khối đồng bộ lấy cùng khóa tư vấn theo con với 2 RPC
-- ngân hàng giờ (hashtext('safepc_time_bank_' || child_id)) TRƯỚC khi
-- đọc SUM, nên mọi cặp thưởng/thu hồi/ghép nối cùng con đều nối tiếp
-- nhau: thưởng commit trước thì SUM đã gồm nó; ghép nối commit trước
-- thì lệnh thưởng sau đó cũng tới được máy mới (máy đã có trong danh
-- sách) và thắng lệnh đồng bộ nhờ created_at mới hơn.
--
-- Chạy được cả khi migration 13 chưa áp: bảng time_bank_grants là tùy
-- chọn — kiểm tra bằng to_regclass, đọc SUM bằng SQL động (tên bảng là
-- hằng số, id truyền qua USING, theo mẫu migration 15). Bảng chưa có
-- thì bỏ qua khối đồng bộ, ghép nối vẫn thành công như trước.
--
-- Không có secret hay giá trị thật nào trong file này. File chạy lại an
-- toàn (CREATE OR REPLACE, GRANT lặp lại được). Không đổi RLS, không
-- đổi bảng nào.

-- ============ Đổi mã pairing 6 số lấy device token (+ đồng bộ ngân hàng giờ) ============
-- Giữ nguyên toàn bộ ngữ nghĩa migration 3: mã phải còn hạn, chưa dùng,
-- gắn với một con; đánh dấu used, tạo device + token 256-bit, trả token
-- thô ĐÚNG 1 LẦN. Điểm mới duy nhất là khối đồng bộ tổng ngân hàng giờ
-- ở cuối thân hàm, trước RETURN.
create or replace function public.safepc_redeem_pairing_code(
  p_code_hash text,
  p_hostname text,
  p_os_version text,
  p_agent_version text
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_code public.pairing_codes;
  v_device_id uuid;
  v_token text;
  -- Đồng bộ ngân hàng giờ (migration 17): tổng phút còn hiệu lực + hạn
  -- xa nhất trong các lần thưởng còn hiệu lực của con (cùng công thức
  -- SUM + max(expires_at) của RPC thưởng/thu hồi ở migration 13).
  v_total integer;
  v_max_expires timestamptz;
begin
  -- Khóa hàng mã để hai lần đổi cùng lúc không cùng thành công.
  select * into v_code
  from public.pairing_codes
  where code_hash = p_code_hash
    and used_at is null
    and expires_at > now()
    and attempts < 5
  order by created_at desc
  limit 1
  for update;

  if v_code.id is null or v_code.child_id is null then
    raise exception 'invalid_code' using errcode = 'P0001';
  end if;

  update public.pairing_codes
  set attempts = attempts + 1,
      used_at = now()
  where id = v_code.id;

  insert into public.devices (family_id, child_id, hostname, os_version, agent_version, last_seen_at, status)
  values (v_code.family_id, v_code.child_id,
          left(coalesce(nullif(trim(p_hostname), ''), 'PC'), 200),
          left(coalesce(p_os_version, ''), 200),
          left(coalesce(p_agent_version, ''), 50),
          now(), 'online')
  returning id into v_device_id;

  -- Token 32 byte ngẫu nhiên (hex 64 ký tự); chỉ hash được lưu.
  v_token := encode(gen_random_bytes(32), 'hex');

  insert into public.device_tokens (device_id, token_hash)
  values (v_device_id, encode(digest(convert_to(v_token, 'UTF8'), 'sha256'), 'hex'));

  -- Đồng bộ tổng ngân hàng giờ cho máy vừa tạo (migration 17). Chỉ chạy
  -- khi bảng sổ cái đã tồn tại (migration 13 đã áp); tổng bằng 0 (chưa
  -- thưởng, đã thu hồi hết, hoặc đã hết hạn cuối ngày) thì không gửi
  -- lệnh nào. Lệnh mang đúng hình dạng của RPC thưởng để chốt chặn thu
  -- hồi ở RPC safepc_void_time_bank_grant (lệnh mới nhất là bonus của
  -- ngân hàng thì mới gửi lệnh hủy khi tổng về 0) nhận ra nó.
  if to_regclass('public.time_bank_grants') is not null then
    -- Cùng khóa theo con với RPC thưởng/thu hồi (xem ghi chú đầu file):
    -- nối tiếp với mọi lần thưởng/thu hồi cùng con trong transaction này.
    perform pg_advisory_xact_lock(hashtext('safepc_time_bank_' || v_code.child_id::text));

    execute $q$
      select coalesce(sum(minutes), 0), max(expires_at)
        from public.time_bank_grants
       where child_id = $1
         and status = 'active'
         and expires_at > now()
    $q$ into v_total, v_max_expires using v_code.child_id;

    if v_total > 0 then
      insert into public.commands (family_id, device_id, type, payload, status)
      values (v_code.family_id, v_device_id, 'temporary_override',
        jsonb_build_object(
          'action', 'bonus_minutes',
          'minutes', v_total,
          'expires_at', v_max_expires,
          'source', 'time_bank'
        ),
        'pending');
    end if;
  end if;

  return jsonb_build_object(
    'device_id', v_device_id,
    'token', v_token,
    'family_id', v_code.family_id,
    'child_id', v_code.child_id
  );
end;
$$;

-- Quyền gọi giữ nguyên như migration 3 (CREATE OR REPLACE đã giữ quyền
-- cũ; cấp lại cho rõ và để chạy lại an toàn).
grant execute on function public.safepc_redeem_pairing_code(text, text, text, text) to anon, authenticated, service_role;

-- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ===========
-- 1. Hàm vẫn đúng 1 hàm, đúng chữ ký như migration 3:
-- select proname, pg_get_function_identity_arguments(oid) from pg_proc where proname = 'safepc_redeem_pairing_code';
-- Kỳ vọng: 1 hàng, đối số (text, text, text, text).
--
-- 2. Quyền gọi qua PostgREST vẫn đủ 3 vai trò:
-- select grantee from information_schema.routine_privileges where routine_name = 'safepc_redeem_pairing_code' and privilege_type = 'EXECUTE' order by grantee;
-- Kỳ vọng: có đủ anon, authenticated, service_role; cộng hàng postgres là chủ hàm (bình thường), không có hàng PUBLIC.
--
-- 3. Sau khi ghép nối một máy mới cho con ĐANG có giờ thưởng còn hiệu lực:
-- select device_id, type, payload, status from public.commands where type = 'temporary_override' and payload ->> 'source' = 'time_bank' order by created_at desc limit 5;
-- Kỳ vọng: có 1 lệnh pending cho đúng máy mới, payload bonus_minutes với minutes = tổng phút còn hiệu lực và expires_at = cuối ngày. Lệnh này được Agent nhận ở chu kỳ poll sau và ack done.
--
-- 4. Sau khi ghép nối một máy mới cho con KHÔNG có giờ thưởng còn hiệu lực (chưa thưởng / đã thu hồi hết / đã hết hạn):
-- select count(*) from public.commands where type = 'temporary_override' and payload ->> 'source' = 'time_bank' and device_id = '<id máy mới>';
-- Kỳ vọng: 0 — không gửi lệnh nào khi tổng bằng 0.
