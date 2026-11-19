-- SafePC — Migration 21: đồng bộ trạng thái thi hành cho máy mới ghép nối
-- (khóa cưỡng chế + ghi đè đang hiệu lực)
-- Ngày: 19/11/2026. Áp dụng qua Dashboard > SQL Editor (như migration 1-20),
-- chạy một lần, kiểm chứng bằng truy vấn ở cuối file (ghi chú).
--
-- Bối cảnh: migration 17 đã đóng khoảng trống ngân hàng giờ (máy mới nhận
-- tổng thưởng), nhưng máy mới vẫn KHÔNG nhận trạng thái khóa cưỡng chế
-- (forced lock) và ghi đè đang hiệu lực của con — một máy mới ghép nối có
-- thể không bị khóa trong khi máy cũ của con đang bị khóa cưỡng chế, hoặc
-- mất lệnh mở khóa/domain/app phụ huynh vừa duyệt. Đây là lỗ hổng thi hành
-- thật: quy tắc theo con (rules) thì máy mới nhận đủ qua fetch rules, chỉ
-- riêng trạng thái "đang bị khóa tay / đang được mở tạm" là không có nguồn
-- sự thật phía server — cờ khóa và ghi đè chỉ nằm trong SQLite local của
-- từng máy.
--
-- Nguồn sự thật: bảng commands (SUY RA, không dùng heartbeat).
-- Lệnh của phụ huynh (lock_now/unlock/temporary_override) là nhật ký ý
-- định đầy đủ của phụ huynh, xếp theo giờ server (created_at do Postgres
-- sinh — trừ đúng một ngoại lệ ở khối sao chép dưới đây, xem ghi chú đó).
-- Dashboard đã dùng chính bảng này làm nguồn sự thật hiển thị: hàm
-- getActiveOverride (RulesPage.tsx) và activeOverrideForDevice
-- (todayOverview.ts) suy ra ghi đè hiệu lực của một máy bằng cách đi bộ
-- mới-nhất-trước qua lệnh temporary_override + lock_now — khối sao chép
-- dưới đây là cùng một luật đi bộ đó, chuyển sang mức con (mọi máy của
-- con) trong SQL. Dùng chung luật với Dashboard thì máy mới nhận đúng
-- trạng thái phụ huynh ĐANG THẤY trên Dashboard.
--
-- Vì sao KHÔNG dùng heartbeat / snapshot enforcement (devices.
-- enforcement_json, migration 6): (1) snapshot không mang cờ khóa cưỡng
-- chế độc lập — trường lockedBy chỉ phản ánh quyết định hiện tại, nên khi
-- ghi đè unlock đang thắng thì lockedBy=null dù cờ khóa vẫn đặt (khóa sẽ
-- có hiệu lực trở lại khi ghi đè hết hạn — đúng trạng thái cần sao chép
-- lại bị ẩn mất); (2) snapshot cũng không mang payload ghi đè
-- (action/minutes/expires_at/domains/apps) nên không thể dựng lại lệnh;
-- (3) snapshot chỉ gửi khi nội dung ĐỔI nên enforcement_updated_at có thể
-- cũ nhiều ngày dù trạng thái vẫn đúng — không có quy tắc tươi mới nào
-- phân biệt được "cũ nhưng đúng" với "cũ và đã sai"; (4) máy cũ thường
-- TẮT đúng lúc ghép nối máy mới — lúc cần sao chép nhất thì heartbeat
-- không có dữ liệu tươi, và lệnh phụ huynh gửi trong lúc máy cũ offline
-- (lock_now đang pending) cũng vô hình với snapshot; (5) bổ sung trường
-- mới vào snapshot đòi Agent mới + cài lại trên máy CŨ trước khi migration
-- 21 có tác dụng, trong khi suy ra từ commands chạy được ngay với Agent
-- v0.1.275 đã cài. Hướng heartbeat vì vậy bị LOẠI cho đợt này; nếu sau
-- này cần hiển thị trạng thái máy theo thời gian thực thì snapshot vẫn là
-- kênh hiển thị, không phải nguồn sao chép.
--
-- Quy tắc an toàn (không suy ra khóa từ dữ liệu cũ/mất dấu):
-- - Chỉ sao chép khóa khi lệnh khóa/mở MỚI NHẤT của con là lock_now.
--   Không có lệnh nào, hoặc mới nhất là unlock, thì KHÔNG chèn lệnh khóa
--   (thà để máy mới mở rồi phụ huynh khóa tay, còn hơn khóa nhầm vì trạng
--   thái cũ).
-- - Lệnh khóa là ý định chưa bị thu hồi: trạng thái pending vẫn tính (máy
--   cũ chưa kịp nhận thì máy mới nhận thay) — "cũ" ở đây không làm lệnh
--   sai, vì cờ khóa cưỡng chế tồn tại tới khi có lệnh unlock tường minh.
--   Lệnh unlock mới hơn luôn thắng lệnh khóa cũ hơn.
-- - Ghi đè chỉ sao chép khi còn hạn thật (expires_at > now()) và còn từ
--   1 phút trở lên; hết hạn/còn < 1 phút thì bỏ qua (Dashboard có thể
--   vẫn hiển thị ghi đè đó trong chưa đầy 1 phút, sau đó hai phía đồng
--   nhất trở lại).
-- - Sao chép theo mức CON (lệnh mới nhất trên mọi máy của con), không
--   theo từng máy: phụ huynh khóa "máy của con" là khóa con, và một con
--   thường chỉ có một máy. GIỚI HẠN ĐÃ BIẾT: nếu phụ huynh cố tình chỉ
--   khóa 1 trong nhiều máy của con thì máy mới vẫn bị khóa theo lệnh khóa
--   mới nhất — phụ huynh mở lại bằng tay nếu muốn (khóa nhầm thì thấy
--   ngay và mở được bằng một thao tác; mở nhầm thì lỗ hổng thi hành vẫn
--   còn). Xem thêm mục giới hạn cuối file.
--
-- Thứ tự chèn và ngoại lệ created_at (QUAN TRỌNG — đọc kỹ):
-- Vòng poll của Agent xử lý lệnh theo created_at tăng dần (RPC
-- safepc_fetch_device_commands ORDER BY created_at), và nhánh lock_now
-- của Agent HỦY ghi đè unlock đang hiệu lực. Muốn máy mới đạt đúng trạng
-- thái "khóa cưỡng chế + ghi đè unlock đang thắng tạm thời" thì lệnh khóa
-- phải được xử lý TRƯỚC lệnh ghi đè. Nhưng cột created_at mặc định now()
-- là thời điểm BẮT ĐẦU transaction nên hai lệnh chèn trong cùng một redeem
-- sẽ CÙNG mốc giờ — thứ tự poll khi đó không xác định, và nếu ghi đè tới
-- trước thì lệnh khóa sẽ hủy mất nó. Vì vậy lệnh sao chép mang đúng mốc
-- created_at GỐC của lệnh gốc. Trong mọi trường hợp cả hai cùng được sao
-- chép thì thứ tự này đúng: ghi đè unlock mà có lệnh khóa mới hơn (kể cả
-- bằng mốc) thì đã bị hủy nên không được sao chép nữa — khóa gốc luôn cũ
-- hơn ghi đè gốc; ghi đè khác (bonus/domain/app/lock) thì nhánh khóa
-- không hủy nên thứ tự không ảnh hưởng. Đây là ngoại lệ DUY NHẤT trong
-- dự án được đặt created_at tường minh (mọi điểm Dashboard/RPC khác đều
-- để Postgres sinh — đã xác minh ở đợt cứng hóa 18/11/2026): giá trị đặt
-- vào vẫn là mốc giờ server gốc, không phải giờ máy khách, không bịa ra;
-- nó giữ đúng thứ tự thật của hành động phụ huynh. Mọi lệnh sau này cho
-- máy mới đều tạo sau lúc ghép nối nên mới hơn cả hai mốc — cơ chế mốc
-- chống lệnh cũ không bị ảnh hưởng. Lệnh bonus khi không có lệnh gốc (con
-- chưa từng có lệnh ghi đè) thì để mặc định now() như migration 17.
--
-- Thống nhất với ngân hàng giờ (thay thế khối migration 17): kiến trúc ghi
-- đè là ĐƠN — mỗi máy tối đa 1 ghi đè hiệu lực. Khối này vì vậy chỉ chèn
-- TỐI ĐA MỘT lệnh ghi đè: ghi đè hiệu lực đúng là bonus thì chèn bonus
-- theo tổng sổ cái (hình dạng migration 17 giữ nguyên); là unlock/
-- allow_domain/... thì sao chép đúng payload gốc với số phút còn lại; đã
-- hủy/hết hạn/bị khóa mới hơn hủy thì KHÔNG chèn ghi đè nào — kể cả khi
-- sổ cái vẫn còn tổng bonus (bonus đó đã bị ghi đè khác thay thế trên máy
-- cũ và không sống lại khi ghi đè kia hết hạn — đúng ngữ nghĩa đơn ghi
-- đè; tổng bonus vẫn nằm trong sổ cái và sẽ gửi lại ở lần thưởng/thu hồi
-- tiếp theo). Riêng trường hợp con chưa từng có lệnh ghi đè nào mà sổ cái
-- còn tổng (thưởng lúc con chưa có máy nào) thì vẫn chèn bonus — đúng mục
-- đích gốc của migration 17.
--
-- Chống đua tranh: khối đồng bộ lấy khóa tư vấn theo con
-- (hashtext('safepc_time_bank_' || child_id), cùng khóa với 2 RPC ngân
-- hàng giờ) TRƯỚC khi đọc trạng thái, nên mọi cặp thưởng/thu hồi/ghép nối
-- cùng con đều nối tiếp nhau. Lệnh Dashboard chèn thẳng (khóa/mở/hủy ghi
-- đè) không lấy khóa này nên vẫn còn một đua tranh hẹp: lệnh phụ huynh
-- chèn đúng giữa lúc redeem đọc trạng thái và commit sẽ không được sao
-- chép — máy mới giữ trạng thái trước đó, phụ huynh gửi lại là xong.
--
-- Chạy được cả khi migration 13 chưa áp: bảng time_bank_grants là tùy
-- chọn — kiểm tra bằng to_regclass như migration 17; bảng chưa có thì
-- phần bonus bỏ qua, phần khóa/ghi đè khác vẫn sao chép bình thường.
--
-- Không có secret hay giá trị thật nào trong file này. File chạy lại an
-- toàn (CREATE OR REPLACE, GRANT lặp lại được). Không đổi RLS, không
-- đổi bảng nào. Không cần Agent/Dashboard/extension mới: máy mới chạy
-- Agent v0.1.275 nhận lệnh sao chép như mọi lệnh khác (poll 15 giây),
-- máy cũ không cần cập nhật gì.
--
-- Giới hạn còn lại (sau migration 21):
-- - Máy ghép nối TRƯỚC khi migration 21 được áp không được đồng bộ ngược
--   (giống giới hạn của migration 17) — trạng thái trên máy đó chỉ đổi ở
--   lần phụ huynh thao tác tiếp theo (khóa/mở/thưởng...).
-- - Xóa một máy sẽ xóa luôn lệnh của máy đó (commands.device_id ON DELETE
--   CASCADE): nếu máy bị xóa giữ lệnh khóa/mở mới nhất của con thì lịch
--   sử suy ra sẽ lùi về lệnh cũ hơn — sao chép có thể sai hướng mở (an
--   toàn theo nguyên tắc trên: không chắc thì không khóa).
-- - Hai lệnh gốc trùng mốc giờ tới micro-giây (hai transaction riêng cùng
--   khởi động trong một micro-giây — gần như không xảy ra): bước (1) ưu
--   tiên lock_now khi hòa mốc (thà khóa nhầm còn hơn mở nhầm); lệnh sao
--   chép mang mốc gốc nên thứ tự POLL của hai lệnh cùng mốc không xác
--   định (fetch chỉ ORDER BY created_at) — máy mới kết thúc ở trạng thái
--   khóa, hoặc mở tạm rồi khóa lại khi ghi đè hết hạn, đều an toàn.
-- - Kiểm tra hủy unlock theo mức CON (EXISTS quét mọi máy của con): một
--   lệnh lock_now trên máy A có thể hủy ghi đè unlock trên máy B trong
--   vòng đi bộ — hệ quả của thiết kế mức con đã chốt ở trên (khóa lan
--   sang máy mới), không phải lỗi.
-- - Vòng đi bộ giới hạn 50 hàng: nếu hơn 50 hàng rác (action lạ/minutes
--   sai) đứng trước hàng quyết định thì không sao chép được gì, và cờ
--   v_ov_seen còn chặn cả nhánh bonus — gần như không xảy ra trong thực
--   tế (Dashboard cũng giới hạn 50 hàng khi đọc lệnh).
-- - Trạng thái khóa theo quy tắc giờ giấc (bedtime/giới hạn ngày) KHÔNG
--   cần sao chép: máy mới tự tải rules của con và tự khóa theo giờ.

-- ============ Đổi mã pairing 6 số lấy device token (+ đồng bộ trạng thái thi hành) ============
-- Giữ nguyên toàn bộ ngữ nghĩa migration 3: mã phải còn hạn, chưa dùng,
-- gắn với một con; đánh dấu used, tạo device + token 256-bit, trả token
-- thô ĐÚNG 1 LẦN. Điểm mới duy nhất là khối đồng bộ trạng thái thi hành
-- ở cuối thân hàm, trước RETURN (migration 21 — thay thế khối ngân hàng
-- giờ của migration 17 bằng một khối thống nhất).
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
  -- Đồng bộ ngân hàng giờ (migration 17, giữ nguyên): tổng phút còn hiệu
  -- lực + hạn xa nhất trong các lần thưởng còn hiệu lực của con (cùng
  -- công thức SUM + max(expires_at) của RPC thưởng/thu hồi ở migration 13).
  v_total bigint;
  v_max_expires timestamptz;
  -- Đồng bộ trạng thái thi hành (migration 21): loại + mốc giờ của lệnh
  -- khóa/mở mới nhất của con; hành động + hạn + danh sách domain/app của
  -- ghi đè hiệu lực (null = không có); cờ con đã từng có lệnh ghi đè;
  -- hàng lệnh đang duyệt trong vòng đi bộ; các biến tạm dựng lệnh sao chép.
  v_lock_type text;
  v_lock_created timestamptz;
  v_ov_action text;
  v_ov_expires timestamptz;
  v_ov_domains jsonb;
  v_ov_apps jsonb;
  v_ov_created timestamptz;
  v_ov_seen boolean;
  v_cmd record;
  v_act text;
  v_exp timestamptz;
  v_min_int integer;
  v_str_count bigint;
  v_remaining_sec numeric;
  v_copy_action text;
  v_copy_minutes integer;
  v_copy_expires timestamptz;
  v_copy_domains jsonb;
  v_copy_apps jsonb;
  v_copy_created timestamptz;
  v_copy_source text;
  v_copy_payload jsonb;
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

  -- Đồng bộ trạng thái thi hành cho máy vừa tạo (migration 21 — thay thế
  -- khối ngân hàng giờ của migration 17 bằng MỘT khối thống nhất; xem ghi
  -- chú đầu file). Máy mới nhận đúng trạng thái con đang có: khóa cưỡng
  -- chế (nếu lệnh khóa/mở mới nhất của con là khóa) và TỐI ĐA MỘT ghi đè
  -- đang hiệu lực. Không bao giờ chèn 2 lệnh ghi đè.
  --
  -- Khóa tư vấn theo con lấy TRƯỚC khi đọc trạng thái (cùng khóa với RPC
  -- thưởng/thu hồi) để nối tiếp với lệnh ghi đè do thưởng/thu hồi sinh
  -- ra. Lệnh Dashboard chèn thẳng không lấy khóa này (đua tranh hẹp còn
  -- lại — xem ghi chú đầu file).
  perform pg_advisory_xact_lock(hashtext('safepc_time_bank_' || v_code.child_id::text));

  -- (1) Khóa cưỡng chế: loại + mốc giờ của lệnh khóa/mở MỚI NHẤT của con
  -- (mọi máy của con, mọi trạng thái — lệnh khóa là ý định chưa bị thu
  -- hồi; máy cũ chưa kịp nhận thì máy mới nhận thay). Hòa mốc giờ thì
  -- ưu tiên lock_now (id là UUID ngẫu nhiên nên không làm tie-break
  -- quyết định được): khóa mà trùng mốc với lệnh mở thì khóa thắng — thà
  -- khóa nhầm còn hơn mở nhầm, mở lại bằng một thao tác; đúng luật hòa
  -- mốc của nhánh lock_now phía Agent.
  select c.type, c.created_at into v_lock_type, v_lock_created
  from public.commands c
  join public.devices d on d.id = c.device_id
  where d.child_id = v_code.child_id
    and c.type in ('lock_now', 'unlock')
  order by c.created_at desc,
    case when c.type = 'lock_now' then 0 else 1 end, c.id desc
  limit 1;

  -- (2) Ghi đè hiệu lực: đi bộ mới-nhất-trước qua lệnh temporary_override
  -- + lock_now của con, LAI theo hai nguồn: ngữ nghĩa hết hạn/hủy theo
  -- hàm getActiveOverride của Dashboard (RulesPage.tsx), còn kiểm tra
  -- tính hợp lệ của minutes/domains/apps theo Agent
  -- (ExecuteTemporaryOverrideAsync) — Dashboard không kiểm tra các
  -- trường này nên vòng đi bộ không phải bản mirror thuần của Dashboard.
  -- Dừng ở hàng quyết định đầu tiên; giới hạn 50 hàng vì quyết định
  -- luôn nằm trong vài hàng mới nhất.
  v_ov_action := null;
  v_ov_expires := null;
  v_ov_domains := null;
  v_ov_apps := null;
  v_ov_created := null;
  v_ov_seen := false;
  for v_cmd in
    select c.type, c.payload, c.created_at
    from public.commands c
    join public.devices d on d.id = c.device_id
    where d.child_id = v_code.child_id
      and c.type in ('temporary_override', 'lock_now')
    order by c.created_at desc, c.id desc
    limit 50
  loop
    if v_cmd.type = 'lock_now' then
      -- lock_now gặp trước ghi đè nghĩa là mới hơn ghi đè đó (đang duyệt
      -- mới-nhất-trước); ghi đè unlock gặp sau sẽ bị hủy — các ghi đè
      -- khác lock_now không hủy nên không cần ghi cờ ở đây (kiểm tra hủy
      -- bằng mốc giờ ở nhánh unlock dưới đây).
      continue;
    end if;

    v_ov_seen := true;
    v_act := v_cmd.payload ->> 'action';

    -- Hủy ghi đè: không còn ghi đè nào (dừng — ghi đè đã hủy không sống
    -- lại, đúng cả phía Agent lẫn Dashboard).
    if v_act = 'cancel' then
      v_ov_action := null;
      exit;
    end if;

    -- Action lạ: bỏ qua, đi tiếp hàng cũ hơn (đúng mẫu Dashboard).
    if v_act is null
       or v_act not in ('bonus_minutes', 'lock', 'unlock', 'allow_domain', 'block_domain', 'block_app', 'allow_app') then
      continue;
    end if;

    -- Ghi đè unlock đã bị lock_now mới hơn hủy phía máy cũ (nhánh
    -- lock_now của Agent hủy ghi đè unlock; hòa mốc cũng hủy — kiểm tra
    -- bằng mốc giờ thay vì chỉ dựa vào thứ tự duyệt để không phụ thuộc
    -- vào id khi hai lệnh trùng mốc micro-giây).
    if v_act = 'unlock' and exists (
      select 1
      from public.commands c2
      join public.devices d2 on d2.id = c2.device_id
      where d2.child_id = v_code.child_id
        and c2.type = 'lock_now'
        and c2.created_at >= v_cmd.created_at
    ) then
      v_ov_action := null;
      exit;
    end if;

    -- expires_at: PHÂN BIỆT hai trường hợp. Thiếu/sai định dạng (cast
    -- lỗi → null) thì lệnh này Agent đã từ chối TRƯỚC khi lưu
    -- (ExecuteTemporaryOverrideAsync trả false) nên ghi đè cũ hơn vẫn
    -- còn hiệu lực trên máy cũ — đi tiếp hàng cũ hơn. Chỉ lệnh hết hạn
    -- THẬT mới dừng (lệnh đã được áp, ghi đè cũ đã bị thay). (Trường
    -- hợp lệnh tới muộn quá hạn khi máy cũ offline: ghi đè trước đó vẫn
    -- còn trên máy cũ nhưng Dashboard cũng hiển thị là không còn — giữ
    -- nguyên hành vi này cho nhất quán; máy mới nhận ghi đè ở lần phụ
    -- huynh thao tác tiếp theo.)
    begin
      v_exp := (v_cmd.payload ->> 'expires_at')::timestamptz;
    exception when others then
      v_exp := null;
    end;
    if v_exp is null then
      continue;
    end if;
    if v_exp <= now() then
      v_ov_action := null;
      exit;
    end if;

    -- minutes phải là số JSON nguyên dương (Agent dùng TryGetPayloadInt32
    -- nên minutes dạng chuỗi "30" hay thập phân 30.5 đều bị từ chối —
    -- lệnh đó không bao giờ được áp trên máy cũ nên đi tiếp hàng cũ hơn
    -- thay vì dừng). Cast đặt trong khối bắt lỗi: số quá lớn vượt int32
    -- sẽ lỗi cast (Agent cũng từ chối) thay vì làm hỏng cả redeem.
    if jsonb_typeof(v_cmd.payload -> 'minutes') is distinct from 'number'
       or (v_cmd.payload ->> 'minutes') is null
       or (v_cmd.payload ->> 'minutes') !~ '^[0-9]+$' then
      continue;
    end if;
    begin
      v_min_int := (v_cmd.payload ->> 'minutes')::int;
    exception when others then
      v_min_int := 0;
    end;
    if v_min_int <= 0 then
      continue;
    end if;

    -- Ghi đè domain/app thiếu danh sách: Agent từ chối — đi tiếp hàng cũ
    -- hơn (ghi đè trước đó vẫn còn trên máy cũ). Kiểm tra lồng nhau (không
    -- dùng OR với jsonb_array_length) để hàm đo độ dài chỉ chạy khi giá
    -- trị đã chắc là mảng; và phải có ÍT NHẤT MỘT phần tử chuỗi vì Agent
    -- (TryGetPayloadStringArray) chỉ giữ phần tử chuỗi, mảng toàn số/null
    -- thì bị từ chối. Lệnh sao chép giữ nguyên mảng gốc — Agent ở máy mới
    -- lọc phần tử chuỗi y như máy cũ. GIỚI HẠN: SQL không kiểm tra được
    -- chuẩn hóa tên exe (ExeNames.Normalize) phía Agent nên một payload
    -- block_app/allow_app mà mọi tên đều không chuẩn hóa được vẫn được
    -- sao chép rồi bị Agent từ chối ở máy mới — chỉ tới được qua chèn
    -- tay vào DB (Dashboard/RPC luôn gửi tên đã chuẩn hóa).
    if v_act in ('allow_domain', 'block_domain') then
      if jsonb_typeof(v_cmd.payload -> 'domains') is distinct from 'array' then
        continue;
      end if;
      select count(*) into v_str_count
        from jsonb_array_elements(v_cmd.payload -> 'domains') e
       where jsonb_typeof(e.value) = 'string';
      if v_str_count = 0 then
        continue;
      end if;
    end if;
    if v_act in ('block_app', 'allow_app') then
      if jsonb_typeof(v_cmd.payload -> 'apps') is distinct from 'array' then
        continue;
      end if;
      select count(*) into v_str_count
        from jsonb_array_elements(v_cmd.payload -> 'apps') e
       where jsonb_typeof(e.value) = 'string';
      if v_str_count = 0 then
        continue;
      end if;
    end if;

    -- Hàng quyết định: ghi đè này đang hiệu lực trên máy cũ.
    v_ov_action := v_act;
    v_ov_expires := v_exp;
    v_ov_domains := case when jsonb_typeof(v_cmd.payload -> 'domains') = 'array'
      then v_cmd.payload -> 'domains' else null end;
    v_ov_apps := case when jsonb_typeof(v_cmd.payload -> 'apps') = 'array'
      then v_cmd.payload -> 'apps' else null end;
    v_ov_created := v_cmd.created_at;
    exit;
  end loop;

  -- (3) Quyết định lệnh ghi đè cần chèn (tối đa MỘT — kiến trúc đơn ghi
  -- đè). Tổng sổ cái chỉ cần đọc trong hai trường hợp: ghi đè hiệu lực
  -- là bonus, hoặc con chưa từng có lệnh ghi đè nào (mục đích gốc của
  -- migration 17 — thưởng lúc con chưa có máy nào).
  v_copy_action := null;
  v_copy_minutes := null;
  v_copy_expires := null;
  v_copy_domains := null;
  v_copy_apps := null;
  v_copy_created := null;
  v_copy_source := null;
  v_total := 0;
  v_max_expires := null;

  if v_ov_action = 'bonus_minutes'
     or (v_ov_action is null and not v_ov_seen) then
    -- Bảng sổ cái là tùy chọn (migration 13 chưa áp) — kiểm tra bằng
    -- to_regclass như migration 17; bảng chưa có thì phần bonus bỏ qua.
    if to_regclass('public.time_bank_grants') is not null then
      execute $q$
        select coalesce(sum(minutes), 0), max(expires_at)
          from public.time_bank_grants
         where child_id = $1
           and status = 'active'
           and expires_at > now()
      $q$ into v_total, v_max_expires using v_code.child_id;
    end if;
  end if;

  if v_ov_action = 'bonus_minutes' then
    -- Ghi đè hiệu lực đúng là bonus: chèn bonus theo tổng sổ cái, đúng
    -- hình dạng lệnh của RPC thưởng (source 'time_bank' để chốt chặn thu
    -- hồi ở RPC safepc_void_time_bank_grant nhận ra nó). Tổng bằng 0 mà
    -- ghi đè bonus vẫn chưa hết hạn thì không chèn gì — nhánh này thực
    -- tế không tới được vì RPC thu hồi luôn gửi cancel khi lệnh mới nhất
    -- là bonus time_bank (vòng đi bộ đã dừng ở cancel trước đó).
    if v_total > 0 then
      v_copy_action := 'bonus_minutes';
      v_copy_minutes := v_total;
      v_copy_expires := v_max_expires;
      v_copy_created := v_ov_created;
      v_copy_source := 'time_bank';
    end if;
  elsif v_ov_action is not null then
    -- Ghi đè khác (unlock/lock/allow_domain/...): sao chép đúng payload
    -- gốc với số phút CÒN LẠI (làm tròn lên để không hết sớm hơn gốc);
    -- còn dưới 1 phút thì bỏ qua (sắp hết, không đáng sao chép).
    v_remaining_sec := extract(epoch from (v_ov_expires - now()));
    if v_remaining_sec >= 60 then
      v_copy_action := v_ov_action;
      v_copy_minutes := ceil(v_remaining_sec / 60)::int;
      v_copy_expires := v_ov_expires;
      v_copy_domains := v_ov_domains;
      v_copy_apps := v_ov_apps;
      v_copy_created := v_ov_created;
      v_copy_source := 'pairing_sync';
    end if;
  elsif not v_ov_seen and v_total > 0 then
    -- Con chưa từng có lệnh ghi đè nào mà sổ cái còn tổng: chèn bonus
    -- (không có lệnh gốc nên để mặc định now()).
    v_copy_action := 'bonus_minutes';
    v_copy_minutes := v_total;
    v_copy_expires := v_max_expires;
    v_copy_created := null;
    v_copy_source := 'time_bank';
  end if;

  -- (4) Chèn lệnh sao chép. Khóa TRƯỚC, ghi đè SAU: vòng poll xử lý theo
  -- created_at tăng dần, và nhánh lock_now của Agent hủy ghi đè unlock
  -- đang hiệu lực — chèn ngược sẽ hủy mất ghi đè vừa sao chép. Lệnh sao
  -- chép mang đúng mốc created_at GỐC của lệnh gốc (xem ghi chú đầu
  -- khối); lệnh bonus không có lệnh gốc thì lấy now() mặc định.
  if v_lock_type = 'lock_now' then
    -- delay_minutes = 0: khóa ngay — độ trễ gốc (nếu có) thuộc về máy cũ
    -- lúc phụ huynh bấm khóa, đã qua từ lâu.
    insert into public.commands (family_id, device_id, type, payload, status, created_at)
    values (v_code.family_id, v_device_id, 'lock_now',
      jsonb_build_object('delay_minutes', 0),
      'pending', v_lock_created);
  end if;

  if v_copy_action is not null then
    v_copy_payload := jsonb_build_object(
      'action', v_copy_action,
      'minutes', v_copy_minutes,
      'expires_at', v_copy_expires,
      'source', v_copy_source
    );
    if v_copy_domains is not null then
      v_copy_payload := v_copy_payload || jsonb_build_object('domains', v_copy_domains);
    end if;
    if v_copy_apps is not null then
      v_copy_payload := v_copy_payload || jsonb_build_object('apps', v_copy_apps);
    end if;
    insert into public.commands (family_id, device_id, type, payload, status, created_at)
    values (v_code.family_id, v_device_id, 'temporary_override',
      v_copy_payload, 'pending', coalesce(v_copy_created, now()));
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
-- Các truy vấn 3-8 dùng chung một cách chuẩn bị: tạo một con thử + một
-- máy cũ (device) của con đó, chèn lệnh lịch sử cho máy cũ với created_at
-- TƯỜNG MINH trong quá khứ (mốc giờ phải có thứ tự thật — lệnh khóa trước,
-- ghi đè sau), rồi gọi redeem bằng một mã pairing hợp lệ cho con thử và
-- xem lệnh sinh ra cho máy mới (device_id trả về từ redeem). Lệnh lịch sử
-- chèn tay chỉ dùng để thử — KHÔNG bao giờ chèn tay vào dữ liệu thật của
-- Diệu Linh.
--
-- 3. Con đang bị khóa cưỡng chế (lệnh lock_now mới nhất, không ghi đè):
-- select type, payload, status from public.commands where device_id = '<id máy mới>' order by created_at;
-- Kỳ vọng: đúng 1 lệnh lock_now pending, payload delay_minutes = 0, không
-- có lệnh temporary_override nào.
--
-- 4. Con bị khóa cưỡng chế + đang được mở khóa tạm thời (unlock còn hạn):
-- select type, payload ->> 'action' as action, payload ->> 'source' as source, created_at from public.commands where device_id = '<id máy mới>' order by created_at;
-- Kỳ vọng: đúng 2 lệnh — lock_now TRƯỚC (created_at nhỏ hơn), rồi
-- temporary_override action 'unlock' source 'pairing_sync', minutes = số
-- phút còn lại (làm tròn lên), expires_at = hạn gốc của lệnh unlock cũ.
-- Sau khi máy mới poll: Tray mở (ghi đè unlock thắng tạm thời) nhưng cờ
-- khóa cưỡng chế vẫn đặt — hết hạn unlock thì máy tự khóa lại.
--
-- 5. Con có ghi đè allow_domain còn hạn (không khóa cưỡng chế):
-- select type, payload from public.commands where device_id = '<id máy mới>' order by created_at;
-- Kỳ vọng: đúng 1 lệnh temporary_override, action 'allow_domain', domains
-- giữ nguyên danh sách gốc, source 'pairing_sync'; không có lệnh lock_now.
--
-- 6. Ghi đè mới nhất đã hết hạn / đã hủy / bị lock_now mới hơn hủy; và
-- trường hợp con không có trạng thái nào:
-- select count(*) from public.commands where device_id = '<id máy mới>';
-- Kỳ vọng: 0 — không sao chép ghi đè hết hạn/còn dưới 1 phút, không sao
-- chép ghi đè đã hủy, không sao chép khóa khi lệnh mới nhất là unlock,
-- và không chèn gì khi con không có trạng thái nào. (Riêng trường hợp
-- ghi đè mới nhất là unlock đã hết hạn mà sổ cái vẫn còn tổng bonus:
-- cũng 0 lệnh ghi đè — bonus đã bị unlock thay thế trên máy cũ, không
-- sống lại; tổng bonus vẫn nằm trong sổ cái và sẽ gửi lại ở lần
-- thưởng/thu hồi tiếp theo.)
--
-- 7. Ngân hàng giờ giữ nguyên hành vi migration 17 (con có tổng thưởng
-- còn hiệu lực, chưa từng có lệnh ghi đè nào):
-- select type, payload ->> 'action' as action, payload ->> 'minutes' as minutes, payload ->> 'source' as source from public.commands where device_id = '<id máy mới>' order by created_at;
-- Kỳ vọng: đúng 1 lệnh temporary_override bonus_minutes, minutes = tổng
-- phút còn hiệu lực, source 'time_bank' (created_at mặc định lúc redeem).
-- Và trường hợp bonus đã bị unlock thay thế (ghi đè mới nhất là unlock
-- còn hạn, sổ cái vẫn còn tổng): chỉ 1 lệnh unlock sao chép (như truy vấn
-- 4), KHÔNG có thêm lệnh bonus nào — không bao giờ 2 lệnh ghi đè.
--
-- 8. Sau khi máy mới poll và ack: cả hai lệnh sao chép (nếu có) đều
-- chuyển done, và máy mới giữ đúng trạng thái (khóa/mở) như máy cũ.
-- select type, status from public.commands where device_id = '<id máy mới>' order by created_at;
-- Kỳ vọng: toàn bộ 'done' sau một chu kỳ poll 15 giây.
