-- Migration 9: tên quy tắc + mẫu quy tắc của phụ huynh (đợt thiết kế lại
-- Dashboard 17/11/2026 theo yêu cầu của anh Tiến: đặt tên quy tắc, sửa
-- mẫu của mình và áp dụng nhanh).
--
-- Không phụ thuộc migration nào khác ngoài migration 1 (bảng rules,
-- families và hàm is_family_member). Áp dụng độc lập, chạy lại an toàn
-- (IF NOT EXISTS / DROP POLICY IF EXISTS).
--
-- 1. Cột mới rules.name (text, nullable, không default): tên do phụ huynh
--    đặt cho từng quy tắc (vd "Giờ học", "Giờ ngủ"). Quy tắc cũ có name
--    NULL thì Dashboard hiển thị tên tự sinh từ loại quy tắc như trước.
-- 2. Bảng mới rule_templates: mẫu quy tắc do phụ huynh tự tạo từ các quy
--    tắc hiện có, để áp dụng nhanh cho con khác / lúc khác. Áp mẫu chỉ
--    THÊM quy tắc mới, không xóa hay sửa quy tắc hiện có.
--
-- Hình dạng rule_templates.rules (jsonb, luôn là mảng; mỗi phần tử là
-- một quy tắc sẽ được tạo khi áp mẫu):
--   { "type": "daily_limit" | "bedtime" | "time_window" | "app" | "website",
--     "name": "Giờ học" | null,   -- tên hiển thị của quy tắc, tùy chọn
--     "config": { ... } }         -- đúng hình dạng config của loại rule đó
-- Mẫu KHÔNG gắn child_id: con đích được chọn lúc áp dụng. Quy tắc SafePC
-- không có phạm vi theo máy (ghi đè tạm thời mới theo máy) nên mẫu cũng
-- không mang device_scope.
--
-- RLS: cùng mẫu bảng rules — chỉ thành viên gia đình sở hữu mới đọc/ghi.
-- Dashboard truy vấn bảng này theo mẫu best-effort: chưa áp migration
-- thì mục "Mẫu của tôi" ẩn đi kèm ghi chú, trang không vỡ.
--
-- Áp dụng: dán toàn bộ file vào Supabase SQL Editor và Run (như migration 7, 8).
-- Kiểm chứng:
-- select column_name from information_schema.columns where table_name = 'rules' and column_name = 'name';
-- Kỳ vọng 1 dòng: name.
-- select table_name from information_schema.tables where table_name = 'rule_templates';
-- Kỳ vọng 1 dòng: rule_templates.

alter table public.rules
  add column if not exists name text;

comment on column public.rules.name is
  'Tên do phụ huynh đặt cho quy tắc (vd "Giờ học", "Giờ ngủ"). NULL = chưa đặt tên, Dashboard hiển thị tên tự sinh từ loại quy tắc.';

create table if not exists public.rule_templates (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  name text not null,
  description text,
  rules jsonb not null default '[]'::jsonb
    check (jsonb_typeof(rules) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.rule_templates is
  'Mẫu quy tắc do phụ huynh tạo từ các quy tắc hiện có để áp dụng nhanh. Cột rules là mảng các {type, name, config}; xem đầu file migration 9.';

create index if not exists rule_templates_family_id_idx
  on public.rule_templates (family_id);

alter table public.rule_templates enable row level security;

drop policy if exists "family access" on public.rule_templates;
create policy "family access" on public.rule_templates
  for all using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));
