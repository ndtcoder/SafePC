-- SafePC — Migration 27: đồng bộ trạng thái thi hành lúc gắn thêm con vào máy chung
-- (phương án (a) đã chốt 21/11/2026, PRD §2.11)
-- Ngày: 21/11/2026. Áp dụng qua Dashboard > SQL Editor (như migration 1-26),
-- chạy một lần, kiểm chứng bằng truy vấn ở cuối file (ghi chú).
--
-- Bối cảnh: migration 24 đặt nền dữ liệu cho máy chung (bảng
-- device_child_accounts, commands.child_id) nhưng KHÔNG chèn bản sao lệnh
-- lúc tạo ánh xạ — con B ngồi vào máy chung có thể chưa bị khóa dù đang
-- bị khóa cưỡng chế trên máy khác, vì máy chung chưa từng tiêu thụ lệnh
-- của B. Anh Tiến đã chốt phương án (a) ngày 21/11/2026: tái dùng kiểu
-- migration 21 — chèn bản sao lệnh khóa/ghi đè mới nhất của B cho thiết
-- bị này ngay khi tạo ánh xạ (Dashboard gọi RPC dưới đây sau khi gắn).
-- Phương án (b) — Service suy ra trạng thái lúc phiên của B lên console —
-- không làm.
--
-- Nguồn sự thật và luật đi bộ: Y HỆT migration 21 (xem ghi chú đầu file
-- đó — vì sao suy ra từ bảng commands thay vì heartbeat/snapshot, quy tắc
-- an toàn "không chắc thì không khóa", thứ tự chèn khóa TRƯỚC ghi đè SAU,
-- ngoại lệ created_at gốc duy nhất được phép, khóa tư vấn theo con). Khối
-- đi bộ dưới đây là cùng một luật đó, tham số hóa theo (thiết bị, con)
-- thay vì redeem pairing code. Điểm khác duy nhất so với migration 21:
--
-- (1) PHẠM VI VÒNG ĐI BỘ — bao cả lệnh legacy lẫn lệnh Sprint 5:
--   - Lệnh legacy: commands.child_id IS NULL, nằm trên máy mà con là hồ
--     sơ mặc định (devices.child_id = con). Lệnh này thuộc về con mặc
--     định của máy theo ngữ nghĩa cũ (ShouldApplyCommand phía Service).
--   - Lệnh Sprint 5: commands.child_id = con, nằm trên BẤT KỲ máy nào
--     trong gia đình — kể cả máy chung khác mà con đã gắn qua ánh xạ.
--     Lệnh theo con không còn gắn với một máy cố định nữa nên vòng đi bộ
--     phải quét theo con, không theo máy.
--   - Cả hai nhánh đều LOẠI TRỪ chính thiết bị đích (c.device_id <>
--     p_device_id): lệnh đã nằm sẵn trên máy đích (kể cả lệnh legacy của
--     con mặc định) sẽ được Agent tiêu thụ qua vòng poll khi con lên
--     console — sao chép lại chỉ tạo bản trùng pending. Vòng đi bộ chỉ
--     mang trạng thái TỪ MÁY KHÁC về máy này.
--
-- (2) LẶP LẠI ĐƯỢC (gắn lại không nhân đôi lệnh pending): trước khi chèn,
--   xóa các lệnh sao chép PENDING trước đó của cùng (thiết bị, con) do
--   chính RPC này tạo ra. Không thể chỉ lọc theo payload source =
--   'link_sync' như bản nháp đầu: bản sao khóa (lock_now) KHÔNG có
--   trường source nào trong payload, và bản sao bonus giữ source
--   'time_bank' như migration 21 (để RPC thu hồi nhận ra nó) — lọc theo
--   source sẽ bỏ sót cả hai và gắn lại sẽ nhân đôi lệnh pending. Vì vậy
--   MỌI bản sao đều mang thêm cờ payload link_sync = true, và bước xóa
--   lọc theo cờ đó; lệnh phụ huynh gửi trực tiếp không có cờ này nên
--   không bao giờ bị đụng. Bản sao ghi đè (không phải bonus) vẫn ghi
--   source 'link_sync' như thiết kế; bản sao bonus giữ source 'time_bank'.
--
-- (3) Kiểm tra quyền chặt như RPC ngân hàng giờ (migration 13): chỉ phụ
--   huynh trong gia đình của cả thiết bị lẫn con mới được gọi; thiết bị
--   và con phải cùng một gia đình; con phải gắn với máy này (con mặc
--   định hoặc có hàng ánh xạ) — gọi cho (thiết bị, con) chưa gắn thì
--   lỗi 'not_linked' thay vì chèn lệnh vào máy mà con không ngồi.
--
-- Yêu cầu: migration 24 đã áp (bảng device_child_accounts +
-- commands.child_id). Chạy được cả khi migration 13 chưa áp: bảng
-- time_bank_grants là tùy chọn — kiểm tra bằng to_regclass như
-- migration 21; bảng chưa có thì phần bonus bỏ qua.
--
-- Không có secret hay giá trị thật nào trong file này. File chạy lại an
-- toàn (CREATE OR REPLACE, GRANT lặp lại được). Không đổi RLS, không đổi
-- bảng nào. Không cần Agent/Dashboard/extension mới: máy đích chạy Agent
-- v0.1.317 nhận lệnh sao chép như mọi lệnh khác (poll 15 giây, giữ
-- pending tới khi con lên console).
--
-- Giới hạn còn lại (kế thừa migration 21):
-- - Gắn lại thì sao chép lại từ đầu (bản sao pending cũ bị xóa, bản sao
--   mới chèn lại) — trạng thái sau cùng vẫn đúng vì vòng đi bộ đọc lại
--   từ bảng commands.
-- - Lệnh phụ huynh chèn đúng giữa lúc RPC đọc trạng thái và commit sẽ
--   không được sao chép (đua tranh hẹp, như migration 21) — máy giữ
--   trạng thái trước đó, phụ huynh gửi lại là xong.
-- - Trạng thái khóa theo quy tắc giờ giấc (bedtime/giới hạn ngày) KHÔNG
--   cần sao chép: máy đích tự tải rules của con và tự khóa theo giờ.
-- - Thu hồi giờ thưởng (void) vẫn chỉ gửi lệnh tới máy mặc định của con
--   (tới migration 26): bonus đã sao chép sang máy chung lúc gắn vẫn còn
--   hiệu lực tới hết ngày dù phụ huynh thu hồi sau đó.

-- ============ Đồng bộ trạng thái thi hành sang máy vừa gắn thêm con ============
create or replace function public.safepc_sync_enforcement_state_to_device(
  p_device_id uuid,
  p_child_id uuid
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_device public.devices;
  v_child public.children;
  v_family_id uuid;
  -- Đồng bộ ngân hàng giờ (giữ nguyên công thức migration 21): tổng phút
  -- còn hiệu lực + hạn xa nhất trong các lần thưởng còn hiệu lực của con.
  v_total bigint;
  v_max_expires timestamptz;
  -- Đồng bộ trạng thái thi hành (tái dùng khối migration 21): loại + mốc
  -- giờ của lệnh khóa/mở mới nhất của con; hành động + hạn + danh sách
  -- domain/app của ghi đè hiệu lực (null = không có); cờ con đã từng có
  -- lệnh ghi đè; hàng lệnh đang duyệt trong vòng đi bộ; các biến tạm dựng
  -- lệnh sao chép.
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
  if auth.uid() is null then
    raise exception 'unauthenticated';
  end if;

  select * into v_device
  from public.devices
  where id = p_device_id;
  if v_device.id is null then
    raise exception 'device_not_found';
  end if;

  select * into v_child
  from public.children
  where id = p_child_id;
  if v_child.id is null then
    raise exception 'child_not_found';
  end if;

  if v_device.family_id is distinct from v_child.family_id then
    raise exception 'family_mismatch';
  end if;
  v_family_id := v_device.family_id;

  -- Chỉ phụ huynh trong gia đình mới được đồng bộ trạng thái (chặt hơn
  -- RLS is_family_member chung của app, cùng mẫu RPC ngân hàng giờ ở
  -- migration 13 — đây là hành động của riêng phụ huynh).
  if not exists (
    select 1 from public.family_members fm
    where fm.family_id = v_family_id
      and fm.user_id = auth.uid()
      and fm.role = 'parent'
  ) then
    raise exception 'not_a_parent';
  end if;

  -- Con phải gắn với máy này (con mặc định hoặc có hàng ánh xạ) — gọi
  -- cho (thiết bị, con) chưa gắn thì lỗi thay vì chèn lệnh vào máy mà
  -- con không ngồi.
  if v_device.child_id is distinct from p_child_id
     and not exists (
       select 1 from public.device_child_accounts a
       where a.device_id = p_device_id
         and a.child_id = p_child_id
     ) then
    raise exception 'not_linked';
  end if;

  -- Khóa tư vấn theo con lấy TRƯỚC khi đọc trạng thái (cùng khóa với
  -- RPC thưởng/thu hồi và redeem ở migration 21) để nối tiếp với lệnh
  -- ghi đè do thưởng/thu hồi sinh ra. Lệnh Dashboard chèn thẳng không
  -- lấy khóa này (đua tranh hẹp còn lại — xem ghi chú đầu file).
  perform pg_advisory_xact_lock(hashtext('safepc_time_bank_' || p_child_id::text));

  -- Xóa bản sao PENDING của lần đồng bộ trước cho cùng (thiết bị, con)
  -- để gắn lại không nhân đôi lệnh pending. Lọc theo cờ link_sync (xem
  -- ghi chú (2) đầu file) — lệnh phụ huynh gửi trực tiếp không có cờ
  -- này nên không bị đụng. Bản sao đã ack (done) là lịch sử, giữ lại.
  delete from public.commands
  where device_id = p_device_id
    and child_id = p_child_id
    and status = 'pending'
    and payload ->> 'link_sync' = 'true';

  -- (1) Khóa cưỡng chế: loại + mốc giờ của lệnh khóa/mở MỚI NHẤT của con
  -- (mọi máy của con trong gia đình, TRỪ máy đích — xem ghi chú (1) đầu
  -- file; mọi trạng thái — lệnh khóa là ý định chưa bị thu hồi). Hòa mốc
  -- giờ thì ưu tiên lock_now: khóa mà trùng mốc với lệnh mở thì khóa
  -- thắng — thà khóa nhầm còn hơn mở nhầm, mở lại bằng một thao tác;
  -- đúng luật hòa mốc của nhánh lock_now phía Agent.
  select c.type, c.created_at into v_lock_type, v_lock_created
  from public.commands c
  join public.devices d on d.id = c.device_id
  where d.family_id = v_family_id
    and c.device_id <> p_device_id
    and (c.child_id = p_child_id
         or (c.child_id is null and d.child_id = p_child_id))
    and c.type in ('lock_now', 'unlock')
  order by c.created_at desc,
    case when c.type = 'lock_now' then 0 else 1 end, c.id desc
  limit 1;

  -- (2) Ghi đè hiệu lực: đi bộ mới-nhất-trước qua lệnh temporary_override
  -- + lock_now của con, cùng luật với migration 21 (ngữ nghĩa hết hạn/
  -- hủy theo hàm getActiveOverride của Dashboard, kiểm tra tính hợp lệ
  -- của minutes/domains/apps theo Agent). Dừng ở hàng quyết định đầu
  -- tiên; giới hạn 50 hàng vì quyết định luôn nằm trong vài hàng mới nhất.
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
    where d.family_id = v_family_id
      and c.device_id <> p_device_id
      and (c.child_id = p_child_id
           or (c.child_id is null and d.child_id = p_child_id))
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
      where d2.family_id = v_family_id
        and c2.device_id <> p_device_id
        and (c2.child_id = p_child_id
             or (c2.child_id is null and d2.child_id = p_child_id))
        and c2.type = 'lock_now'
        and c2.created_at >= v_cmd.created_at
    ) then
      v_ov_action := null;
      exit;
    end if;

    -- expires_at: PHÂN BIỆT hai trường hợp. Thiếu/sai định dạng (cast
    -- lỗi → null) thì lệnh này Agent đã từ chối TRƯỚC khi lưu nên ghi đè
    -- cũ hơn vẫn còn hiệu lực trên máy cũ — đi tiếp hàng cũ hơn. Chỉ
    -- lệnh hết hạn THẬT mới dừng (lệnh đã được áp, ghi đè cũ đã bị thay).
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
    -- sẽ lỗi cast (Agent cũng từ chối) thay vì làm hỏng cả lần đồng bộ.
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
    -- thì bị từ chối. Lệnh sao chép giữ nguyên mảng gốc — Agent ở máy
    -- đích lọc phần tử chuỗi y như máy cũ.
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
  -- là bonus, hoặc con chưa từng có lệnh ghi đè nào (thưởng lúc con chưa
  -- có máy nào).
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
    -- to_regclass như migration 21; bảng chưa có thì phần bonus bỏ qua.
    if to_regclass('public.time_bank_grants') is not null then
      execute $q$
        select coalesce(sum(minutes), 0), max(expires_at)
          from public.time_bank_grants
         where child_id = $1
           and status = 'active'
           and expires_at > now()
      $q$ into v_total, v_max_expires using p_child_id;
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
      v_copy_source := 'link_sync';
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
  -- khối migration 21); lệnh bonus không có lệnh gốc thì lấy now() mặc
  -- định. Mọi bản sao đều mang cờ link_sync = true để gắn lại xóa đúng
  -- (xem ghi chú (2) đầu file); bản sao ghi đè mang child_id của con
  -- để Agent giữ pending tới khi con lên console trên máy đích.
  if v_lock_type = 'lock_now' then
    -- delay_minutes = 0: khóa ngay — độ trễ gốc (nếu có) thuộc về máy cũ
    -- lúc phụ huynh bấm khóa, đã qua từ lâu.
    insert into public.commands (family_id, device_id, child_id, type, payload, status, created_at)
    values (v_family_id, p_device_id, p_child_id, 'lock_now',
      jsonb_build_object('delay_minutes', 0, 'link_sync', true),
      'pending', v_lock_created);
  end if;

  if v_copy_action is not null then
    v_copy_payload := jsonb_build_object(
      'action', v_copy_action,
      'minutes', v_copy_minutes,
      'expires_at', v_copy_expires,
      'source', v_copy_source,
      'link_sync', true
    );
    if v_copy_domains is not null then
      v_copy_payload := v_copy_payload || jsonb_build_object('domains', v_copy_domains);
    end if;
    if v_copy_apps is not null then
      v_copy_payload := v_copy_payload || jsonb_build_object('apps', v_copy_apps);
    end if;
    insert into public.commands (family_id, device_id, child_id, type, payload, status, created_at)
    values (v_family_id, p_device_id, p_child_id, 'temporary_override',
      v_copy_payload, 'pending', coalesce(v_copy_created, now()));
  end if;

  return jsonb_build_object(
    'device_id', p_device_id,
    'child_id', p_child_id,
    -- v_lock_type null (không có lệnh khóa/mở nào) thì so sánh trả null
    -- nên ép về false cho Dashboard khỏi phải xử lý JSON null.
    'locked', coalesce(v_lock_type = 'lock_now', false),
    'lock_copied', coalesce(v_lock_type = 'lock_now', false),
    'override_action', v_copy_action,
    'override_minutes', v_copy_minutes,
    'override_expires_at', v_copy_expires,
    'override_copied', v_copy_action is not null
  );
end;
$$;

grant execute on function public.safepc_sync_enforcement_state_to_device(uuid, uuid) to anon, authenticated, service_role;

-- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ============
-- 1. Hàm đúng 1 hàm, đúng chữ ký:
-- select proname, pg_get_function_identity_arguments(oid) from pg_proc where proname = 'safepc_sync_enforcement_state_to_device';
-- Kỳ vọng: 1 hàng, đối số (uuid, uuid).
--
-- 2. Quyền gọi qua PostgREST đủ 3 vai trò:
-- select grantee from information_schema.routine_privileges where routine_name = 'safepc_sync_enforcement_state_to_device' and privilege_type = 'EXECUTE' order by grantee;
-- Kỳ vọng: có đủ anon, authenticated, service_role.
--
-- Các truy vấn 3-8 dùng chung một cách chuẩn bị: tạo một con thử + một
-- máy cũ của con đó, chèn lệnh lịch sử cho máy cũ với created_at TƯỜNG
-- MINH trong quá khứ, gắn con vào một máy chung (device_child_accounts)
-- rồi gọi select safepc_sync_enforcement_state_to_device('<id máy chung>',
-- '<id con>') và xem lệnh sinh ra cho máy chung. Lệnh lịch sử chèn tay
-- chỉ dùng để thử — KHÔNG bao giờ chèn tay vào dữ liệu thật của Diệu Linh.
--
-- 3. Con đang bị khóa cưỡng chế (lệnh lock_now mới nhất, không ghi đè):
-- select type, payload, status, child_id from public.commands where device_id = '<id máy chung>' order by created_at;
-- Kỳ vọng: đúng 1 lệnh lock_now pending, payload delay_minutes = 0,
-- link_sync = true, child_id = con; không có lệnh temporary_override nào.
--
-- 4. Con bị khóa cưỡng chế + đang được mở khóa tạm thời (unlock còn hạn):
-- select type, payload ->> 'action' as action, payload ->> 'source' as source, created_at from public.commands where device_id = '<id máy chung>' order by created_at;
-- Kỳ vọng: đúng 2 lệnh — lock_now TRƯỚC (created_at nhỏ hơn), rồi
-- temporary_override action 'unlock' source 'link_sync', minutes = số
-- phút còn lại (làm tròn lên), expires_at = hạn gốc của lệnh unlock cũ.
--
-- 5. Con có ghi đè allow_domain còn hạn (không khóa cưỡng chế):
-- select type, payload from public.commands where device_id = '<id máy chung>' order by created_at;
-- Kỳ vọng: đúng 1 lệnh temporary_override, action 'allow_domain', domains
-- giữ nguyên danh sách gốc, source 'link_sync'; không có lệnh lock_now.
--
-- 6. Ghi đè mới nhất đã hết hạn / đã hủy / bị lock_now mới hơn hủy; và
-- trường hợp con không có trạng thái nào:
-- select count(*) from public.commands where device_id = '<id máy chung>';
-- Kỳ vọng: 0 — không sao chép ghi đè hết hạn/còn dưới 1 phút, không sao
-- chép ghi đè đã hủy, không sao chép khóa khi lệnh mới nhất là unlock,
-- và không chèn gì khi con không có trạng thái nào.
--
-- 7. Ngân hàng giờ: con có tổng thưởng còn hiệu lực, ghi đè hiệu lực là
-- bonus (hoặc chưa từng có lệnh ghi đè nào):
-- select type, payload ->> 'action' as action, payload ->> 'minutes' as minutes, payload ->> 'source' as source from public.commands where device_id = '<id máy chung>' order by created_at;
-- Kỳ vọng: đúng 1 lệnh temporary_override bonus_minutes, minutes = tổng
-- phút còn hiệu lực, source 'time_bank', link_sync = true.
--
-- 8. Gắn lại (gọi RPC lần 2 cho cùng máy + con): số lệnh pending có cờ
-- link_sync trên máy chung không tăng — bản sao cũ bị xóa trước khi chèn
-- bản mới.
-- select count(*) from public.commands where device_id = '<id máy chung>' and status = 'pending' and payload ->> 'link_sync' = 'true';
-- Kỳ vọng: bằng đúng số lệnh ở lần gọi đầu (không nhân đôi).
