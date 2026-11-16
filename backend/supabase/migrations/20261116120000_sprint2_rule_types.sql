-- SafePC — Sprint 2 đợt 1: mở rộng danh mục quy tắc và lệnh.
--
-- Migration đầu (20261116102900_init_safepc.sql) khóa cột `type` bằng CHECK:
-- rules.type chỉ nhận daily_limit|bedtime|app|website, commands.type chỉ nhận
-- lock_now|unlock|refresh_rules|update. Đợt 1 thêm loại rule `time_window`
-- (khung giờ được dùng máy) và loại lệnh `temporary_override` (ghi đè tạm
-- thời tự hết hạn), nên phải nới 2 CHECK này. Không đổi tên bảng/cột, không
-- động tới RLS/policy hay dữ liệu đã có.
--
-- Cách áp dụng: Supabase Dashboard > SQL Editor > New query, dán toàn bộ file,
-- bấm Run (xem backend/supabase/README.md). Chạy sau migration đầu, theo đúng
-- thứ tự tên file.
--
-- Kiểm chứng sau khi chạy (mỗi câu phải trả về 1 hàng, và câu INSERT thử phải
-- bị ROLLBACK lại):
--   select conname from pg_constraint
--     where conrelid = 'public.rules'::regclass and conname = 'rules_type_check';
--   select conname from pg_constraint
--     where conrelid = 'public.commands'::regclass and conname = 'commands_type_check';

alter table public.rules
  drop constraint if exists rules_type_check;

alter table public.rules
  add constraint rules_type_check
  check (type in ('daily_limit', 'bedtime', 'time_window', 'app', 'website'));

alter table public.commands
  drop constraint if exists commands_type_check;

alter table public.commands
  add constraint commands_type_check
  check (type in ('lock_now', 'unlock', 'refresh_rules', 'update', 'temporary_override'));
