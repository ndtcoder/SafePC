# Kiểm thử RLS — SafePC

Tài liệu này mô tả các ca kiểm thử Row Level Security (RLS) **phải chạy và
đạt** trước khi cho Dashboard/Agent kết nối thật vào project Supabase.

**Trạng thái (16/11/2026): CHƯA CHẠY ĐƯỢC.** Project Supabase SafePC đã tạo
nhưng migration `20261116102900_init_safepc.sql` chưa áp dụng. Chạy các ca
dưới đây ngay sau khi áp migration theo `README.md`, và chạy lại sau mỗi lần
đổi policy/migration.

Mục tiêu: chứng minh ranh giới `family_id` hoạt động — user gia đình A không
đọc/sửa/xóa được dữ liệu gia đình B, thành viên không phải owner không quản
lý được `family_members`, và `audit_logs` chỉ đọc đối với user thường.

## 1. Chuẩn bị: 2 tài khoản test + dữ liệu mẫu

Tạo 2 tài khoản qua Supabase Auth (đăng ký trên Dashboard, hoặc
Authentication > Users > Add user):

- **User A** — owner của **Gia đình A**.
- **User B** — owner của **Gia đình B**.

Lấy UUID của 2 tài khoản (chạy trong SQL Editor với quyền mặc định):

```sql
select id, email from auth.users order by created_at;
```

Ghi lại 2 UUID, thay vào các placeholder `<UUID_USER_A>`, `<UUID_USER_B>` bên
dưới. Sau đó tạo dữ liệu mẫu — các câu lệnh này chạy với quyền postgres trong
SQL Editor nên bypass RLS (đây là bước chuẩn bị, không phải bước kiểm thử).
Chạy từng câu, ghi lại `id` trả về theo bảng đối chiếu ở cuối mục này.

```sql
-- 1. Hai gia đình
insert into public.families (owner_id, name)
values ('<UUID_USER_A>', 'Gia đình A') returning id; -- -> <FAMILY_A>
insert into public.families (owner_id, name)
values ('<UUID_USER_B>', 'Gia đình B') returning id; -- -> <FAMILY_B>

-- 2. Mỗi owner tự thêm mình làm thành viên (role parent) của gia đình mình
insert into public.family_members (family_id, user_id, role)
values ('<FAMILY_A>', '<UUID_USER_A>', 'parent');
insert into public.family_members (family_id, user_id, role)
values ('<FAMILY_B>', '<UUID_USER_B>', 'parent');

-- 3. Mỗi gia đình 1 con, 1 máy
insert into public.children (family_id, display_name, birth_year)
values ('<FAMILY_A>', 'Con A', 2016) returning id; -- -> <CHILD_A>
insert into public.children (family_id, display_name, birth_year)
values ('<FAMILY_B>', 'Con B', 2016) returning id; -- -> <CHILD_B>

insert into public.devices (family_id, child_id, hostname)
values ('<FAMILY_A>', '<CHILD_A>', 'PC-A') returning id; -- -> <DEVICE_A>
insert into public.devices (family_id, child_id, hostname)
values ('<FAMILY_B>', '<CHILD_B>', 'PC-B') returning id; -- -> <DEVICE_B>

-- 4. Mỗi gia đình 1 rule, 1 app_usage, 1 web_visit, 1 request, 1 command, 1 audit log
insert into public.rules (family_id, child_id, type, config)
values ('<FAMILY_A>', '<CHILD_A>', 'daily_limit', '{"minutesByWeekday": {"1": 120}}'::jsonb)
returning id; -- -> <RULE_A>
insert into public.rules (family_id, child_id, type, config)
values ('<FAMILY_B>', '<CHILD_B>', 'daily_limit', '{"minutesByWeekday": {"1": 120}}'::jsonb)
returning id; -- -> <RULE_B>

insert into public.app_usage (family_id, device_id, child_id, app_name, exe_path_hash, started_at, duration_sec)
values ('<FAMILY_A>', '<DEVICE_A>', '<CHILD_A>', 'TestApp', 'test-hash', now(), 60)
returning id; -- -> <USAGE_A>
insert into public.app_usage (family_id, device_id, child_id, app_name, exe_path_hash, started_at, duration_sec)
values ('<FAMILY_B>', '<DEVICE_B>', '<CHILD_B>', 'TestApp', 'test-hash', now(), 60)
returning id; -- -> <USAGE_B>

insert into public.web_visits (family_id, device_id, child_id, domain, visited_at, blocked)
values ('<FAMILY_A>', '<DEVICE_A>', '<CHILD_A>', 'example.com', now(), false)
returning id; -- -> <VISIT_A>
insert into public.web_visits (family_id, device_id, child_id, domain, visited_at, blocked)
values ('<FAMILY_B>', '<DEVICE_B>', '<CHILD_B>', 'example.com', now(), false)
returning id; -- -> <VISIT_B>

insert into public.requests (family_id, child_id, type, reason)
values ('<FAMILY_A>', '<CHILD_A>', 'extra_time', 'test') returning id; -- -> <REQUEST_A>
insert into public.requests (family_id, child_id, type, reason)
values ('<FAMILY_B>', '<CHILD_B>', 'extra_time', 'test') returning id; -- -> <REQUEST_B>

insert into public.commands (family_id, device_id, type)
values ('<FAMILY_A>', '<DEVICE_A>', 'refresh_rules') returning id; -- -> <COMMAND_A>
insert into public.commands (family_id, device_id, type)
values ('<FAMILY_B>', '<DEVICE_B>', 'refresh_rules') returning id; -- -> <COMMAND_B>

insert into public.audit_logs (family_id, actor, action, target, ip_hash)
values ('<FAMILY_A>', '<UUID_USER_A>', 'test_setup', 'test', 'test-hash')
returning id; -- -> <AUDIT_A>
insert into public.audit_logs (family_id, actor, action, target, ip_hash)
values ('<FAMILY_B>', '<UUID_USER_B>', 'test_setup', 'test', 'test-hash')
returning id; -- -> <AUDIT_B>
```

Bảng đối chiếu placeholder (điền sau khi chạy xong mục 1):

| Placeholder | Ý nghĩa |
|---|---|
| `<UUID_USER_A>` / `<UUID_USER_B>` | UUID trong `auth.users` của 2 tài khoản test |
| `<FAMILY_A>` / `<FAMILY_B>` | id 2 gia đình |
| `<CHILD_A>` / `<CHILD_B>`, `<DEVICE_A>` / `<DEVICE_B>` | id con và máy của mỗi gia đình |
| `<RULE_A>` / `<RULE_B>`, `<USAGE_A>` / `<USAGE_B>`, `<VISIT_A>` / `<VISIT_B>` | id rule / app_usage / web_visit |
| `<REQUEST_A>` / `<REQUEST_B>`, `<COMMAND_A>` / `<COMMAND_B>`, `<AUDIT_A>` / `<AUDIT_B>` | id request / command / audit log |

## 2. Cách giả lập đúng quyền của từng user trong SQL Editor

SQL Editor chạy với quyền postgres (bypass RLS), nên chạy câu test trực tiếp
sẽ **luôn thấy dữ liệu và luôn cho kết quả sai**. Muốn kiểm chứng RLS thật,
phải giả lập JWT của user rồi chuyển sang role `authenticated` — `auth.uid()`
đọc `sub` từ JWT giả lập này.

**Quy tắc chạy:** mỗi khối test dưới đây phải chạy trong **1 lần Run duy
nhất**, gồm 3 phần: giả lập user → các câu test → reset quyền. Không tách
phần giả lập và câu test ra 2 lần Run khác nhau.

```sql
-- Phần 1: giả lập user A (thay UUID; đổi sang <UUID_USER_B> để giả lập user B)
select set_config('request.jwt.claims', '{"sub": "<UUID_USER_A>", "role": "authenticated"}', false);
set role authenticated;
select auth.uid(); -- kiểm tra: phải trả về <UUID_USER_A>

-- Phần 2: các câu test của khối đó (xem mục 3-6)

-- Phần 3: reset, trả lại quyền postgres
reset role;
select set_config('request.jwt.claims', null, false);
```

Cách kiểm chứng bổ sung (khuyến nghị): gọi qua Supabase JS client với phiên
đăng nhập thật của user A/B (anon key + `signInWithPassword`), chạy cùng các
truy vấn SELECT/INSERT/UPDATE/DELETE — kết quả phải giống hệt mục 3-6.

## 3. Ca 1 — Cô lập giữa 2 gia đình (8 bảng)

Với vai trò **user A**, mọi truy vấn vào dữ liệu của **gia đình B** phải thất
bại theo đúng kiểu của từng lệnh:

- `SELECT`: trả về **0 dòng** (dữ liệu bị ẩn, không báo lỗi).
- `UPDATE` / `DELETE`: ảnh hưởng **0 dòng** (dòng đích vô hình với user A,
  không báo lỗi).
- `INSERT` với `family_id` của B: **lỗi** `new row violates row-level
  security policy`.

Lặp lại toàn bộ khối này với vai trò **user B** truy vấn dữ liệu gia đình A
(đổi A ↔ B), kết quả mong đợi giống hệt.

### 3.1. SELECT chéo gia đình — mong đợi: 0 dòng mỗi câu

```sql
select count(*) from public.children   where family_id = '<FAMILY_B>'; -- 0
select count(*) from public.devices    where family_id = '<FAMILY_B>'; -- 0
select count(*) from public.rules      where family_id = '<FAMILY_B>'; -- 0
select count(*) from public.app_usage  where family_id = '<FAMILY_B>'; -- 0
select count(*) from public.web_visits where family_id = '<FAMILY_B>'; -- 0
select count(*) from public.requests   where family_id = '<FAMILY_B>'; -- 0
select count(*) from public.commands   where family_id = '<FAMILY_B>'; -- 0
select count(*) from public.audit_logs where family_id = '<FAMILY_B>'; -- 0
```

Đối chứng dương (cùng vai trò user A, dữ liệu gia đình mình — phải thấy):

```sql
select count(*) from public.children   where family_id = '<FAMILY_A>'; -- 1
select count(*) from public.devices    where family_id = '<FAMILY_A>'; -- 1
select count(*) from public.rules      where family_id = '<FAMILY_A>'; -- 1
select count(*) from public.app_usage  where family_id = '<FAMILY_A>'; -- 1
select count(*) from public.web_visits where family_id = '<FAMILY_A>'; -- 1
select count(*) from public.requests   where family_id = '<FAMILY_A>'; -- 1
select count(*) from public.commands   where family_id = '<FAMILY_A>'; -- 1
select count(*) from public.audit_logs where family_id = '<FAMILY_A>'; -- 1
```

### 3.2. UPDATE / DELETE chéo gia đình — mong đợi: 0 dòng bị ảnh hưởng

```sql
update public.children   set display_name = 'HACK' where id = '<CHILD_B>';   -- 0 dòng
update public.devices    set hostname = 'HACK'     where id = '<DEVICE_B>';  -- 0 dòng
update public.rules      set enabled = false       where id = '<RULE_B>';    -- 0 dòng
update public.app_usage  set duration_sec = 0      where id = '<USAGE_B>';   -- 0 dòng
update public.web_visits set blocked = true        where id = '<VISIT_B>';   -- 0 dòng
update public.requests   set status = 'approved'   where id = '<REQUEST_B>'; -- 0 dòng
update public.commands   set status = 'done'       where id = '<COMMAND_B>'; -- 0 dòng
update public.audit_logs set action = 'HACK'       where id = '<AUDIT_B>';   -- 0 dòng

delete from public.children   where id = '<CHILD_B>';   -- 0 dòng
delete from public.devices    where id = '<DEVICE_B>';  -- 0 dòng
delete from public.rules      where id = '<RULE_B>';    -- 0 dòng
delete from public.app_usage  where id = '<USAGE_B>';   -- 0 dòng
delete from public.web_visits where id = '<VISIT_B>';   -- 0 dòng
delete from public.requests   where id = '<REQUEST_B>'; -- 0 dòng
delete from public.commands   where id = '<COMMAND_B>'; -- 0 dòng
delete from public.audit_logs where id = '<AUDIT_B>';   -- 0 dòng
```

Sau đó kiểm tra lại với quyền postgres: dữ liệu gia đình B vẫn nguyên vẹn
(không dòng nào bị đổi/xóa).

### 3.3. INSERT chéo gia đình — mong đợi: lỗi RLS policy mỗi câu

```sql
insert into public.children (family_id, display_name)
values ('<FAMILY_B>', 'HACK');
insert into public.devices (family_id, hostname)
values ('<FAMILY_B>', 'HACK');
insert into public.rules (family_id, child_id, type, config)
values ('<FAMILY_B>', '<CHILD_B>', 'daily_limit', '{}'::jsonb);
insert into public.app_usage (family_id, device_id, child_id, app_name, started_at, duration_sec)
values ('<FAMILY_B>', '<DEVICE_B>', '<CHILD_B>', 'HACK', now(), 0);
insert into public.web_visits (family_id, device_id, child_id, domain, visited_at)
values ('<FAMILY_B>', '<DEVICE_B>', '<CHILD_B>', 'hack.example', now());
insert into public.requests (family_id, child_id, type)
values ('<FAMILY_B>', '<CHILD_B>', 'extra_time');
insert into public.commands (family_id, device_id, type)
values ('<FAMILY_B>', '<DEVICE_B>', 'lock_now');
-- audit_logs: INSERT chéo gia đình cũng lỗi (xem thêm Ca 3: user thường
-- không INSERT được audit_logs ngay cả của gia đình mình).
insert into public.audit_logs (family_id, action)
values ('<FAMILY_B>', 'HACK');
```

Mỗi câu phải lỗi `new row violates row-level security policy`. (Nếu chạy cả
khối trong 1 lần Run, câu lỗi đầu tiên sẽ dừng khối — chạy từng câu riêng,
hoặc chạy lại khối sau mỗi lỗi, vẫn trong cùng phiên giả lập.)

Đối chứng dương: user A INSERT vào gia đình mình phải thành công (sau đó xóa
dòng test này với quyền postgres để dọn dẹp):

```sql
insert into public.children (family_id, display_name)
values ('<FAMILY_A>', 'Con test RLS') returning id;
```

## 4. Ca 2 — Chỉ owner được quản lý `family_members`

Với vai trò **user B** (không phải owner của gia đình A):

```sql
-- Đọc danh sách thành viên gia đình A: 0 dòng
select count(*) from public.family_members where family_id = '<FAMILY_A>'; -- 0

-- Thêm thành viên vào gia đình A: lỗi RLS policy
insert into public.family_members (family_id, user_id, role)
values ('<FAMILY_A>', '<UUID_USER_B>', 'parent');

-- Xóa thành viên của gia đình A: 0 dòng bị ảnh hưởng
delete from public.family_members
where family_id = '<FAMILY_A>' and user_id = '<UUID_USER_A>'; -- 0 dòng
```

Với vai trò **user A** (owner gia đình A) — phải thành công, rồi dọn dẹp:

```sql
-- Đọc được thành viên gia đình mình
select count(*) from public.family_members where family_id = '<FAMILY_A>'; -- 1

-- Thêm rồi xóa 1 thành viên test (dùng user B làm thành viên tạm)
insert into public.family_members (family_id, user_id, role)
values ('<FAMILY_A>', '<UUID_USER_B>', 'child'); -- thành công
delete from public.family_members
where family_id = '<FAMILY_A>' and user_id = '<UUID_USER_B>'; -- 1 dòng
```

Nâng cao (tùy chọn): tạo thêm tài khoản test C, thêm C làm thành viên
(non-owner) của gia đình A, rồi kiểm tra C đọc được `family_members` của A
nhưng INSERT/DELETE đều thất bại như user B ở trên.

## 5. Ca 3 — `audit_logs` chỉ đọc đối với user thường

Với vai trò **user A**, ngay cả dữ liệu của chính gia đình mình:

```sql
-- Đọc được log của gia đình mình
select count(*) from public.audit_logs where family_id = '<FAMILY_A>'; -- 1

-- Ghi log mới: lỗi (không có policy INSERT; ghi log chỉ qua service_role)
insert into public.audit_logs (family_id, action)
values ('<FAMILY_A>', 'HACK');

-- Sửa/xóa log: 0 dòng bị ảnh hưởng (không có policy UPDATE/DELETE)
update public.audit_logs set action = 'HACK' where id = '<AUDIT_A>'; -- 0 dòng
delete from public.audit_logs where id = '<AUDIT_A>';                -- 0 dòng
```

## 6. Ca 4 — Bảng `families` và các bảng nhạy cảm còn lại

### 6.1. `families`: owner toàn quyền, người ngoài không thấy gì

Với vai trò **user B**:

```sql
select count(*) from public.families where id = '<FAMILY_A>'; -- 0
update public.families set name = 'HACK' where id = '<FAMILY_A>'; -- 0 dòng

-- Tạo family với owner_id là người khác: lỗi RLS policy
insert into public.families (owner_id, name)
values ('<UUID_USER_A>', 'HACK');
```

Với vai trò **user A** (đối chứng dương):

```sql
select count(*) from public.families where id = '<FAMILY_A>'; -- 1
update public.families set name = 'Gia đình A (đổi tên test)'
where id = '<FAMILY_A>'; -- 1 dòng (đổi lại tên cũ sau khi test)
```

### 6.2. `device_tokens` và `pairing_codes` (bảng nhạy cảm, kiểm tra thêm)

Với vai trò **user B** — không thấy hash token/mã của gia đình A:

```sql
-- device_tokens không có family_id: policy kiểm tra qua bảng devices
select count(*) from public.device_tokens dt
join public.devices d on d.id = dt.device_id
where d.family_id = '<FAMILY_A>'; -- 0

select count(*) from public.pairing_codes
where family_id = '<FAMILY_A>'; -- 0
```

### 6.3. Không đăng nhập (role `anon`): không thấy gì

```sql
set role anon;
select count(*) from public.children; -- 0 (auth.uid() = NULL)
select count(*) from public.families; -- 0
reset role;
```

## 7. Dọn dẹp sau khi test

Chạy với quyền postgres (mặc định trong SQL Editor). Xóa family sẽ cascade
xóa toàn bộ dữ liệu con của gia đình đó:

```sql
delete from public.families where id in ('<FAMILY_A>', '<FAMILY_B>');
```

Xóa 2 tài khoản test trong Authentication > Users nếu không dùng nữa. Không
dùng tài khoản test này cho dữ liệu thật.

## 8. Checklist ghi kết quả

Điền sau mỗi lần chạy. Tất cả các dòng phải ĐẠT thì mới được kết nối
Dashboard/Agent thật.

| # | Ca kiểm thử | Kết quả mong đợi | Kết quả thực tế | Ngày chạy / Người chạy |
|---|---|---|---|---|
| 1 | SELECT chéo gia đình, 8 bảng (mục 3.1) | 0 dòng, cả 2 chiều A↔B | | |
| 2 | UPDATE/DELETE chéo gia đình, 8 bảng (mục 3.2) | 0 dòng, dữ liệu B nguyên vẹn | | |
| 3 | INSERT chéo gia đình, 8 bảng (mục 3.3) | Lỗi RLS policy mỗi câu | | |
| 4 | Đối chứng dương: đọc/ghi gia đình mình | Thành công | | |
| 5 | Non-owner quản lý `family_members` (mục 4) | INSERT lỗi, DELETE 0 dòng | | |
| 6 | Owner quản lý `family_members` (mục 4) | INSERT/DELETE thành công | | |
| 7 | `audit_logs` chỉ đọc (mục 5) | INSERT lỗi, UPDATE/DELETE 0 dòng | | |
| 8 | `families`: người ngoài + owner (mục 6.1) | Ngoài: 0 dòng/lỗi; owner: đọc/sửa được | | |
| 9 | `device_tokens` / `pairing_codes` chéo gia đình (mục 6.2) | 0 dòng | | |
| 10 | Role `anon` (mục 6.3) | 0 dòng | | |

Nếu bất kỳ ca nào KHÔNG đạt: dừng lại, không kết nối Dashboard/Agent thật,
xem lại policy trong migration và sửa bằng migration mới (không sửa trực tiếp
policy trên Dashboard rồi quên cập nhật repo).
