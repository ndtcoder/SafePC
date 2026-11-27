-- SafePC — Migration 28: kiểm duyệt từ khóa tìm kiếm (bảng search_terms)
-- Ngày: 27/11/2026. Áp dụng qua Dashboard > SQL Editor (như migration
-- 1-27), chạy một lần, kiểm chứng bằng truy vấn ở cuối file (ghi chú).
--
-- Bối cảnh: anh Tiến yêu cầu ngày 27/11/2026, kiểu Microsoft Family
-- Safety: (1) chặn tìm kiếm chứa từ khóa bị cấm theo từng hồ sơ con
-- (rule website mode 'block_search_keywords', config {"keywords": [...]})
-- — phần chặn do extension thi hành qua trường searchGuard trong
-- domain_rules.json; (2) thống kê/tóm tắt các cụm từ đã tìm kiếm vào
-- Báo cáo tuần, như lịch sử web. Migration này chỉ lo PHÍA SERVER của
-- mục (2): bảng lưu cụm từ tìm kiếm + RPC cho Agent đẩy lên + lịch dọn
-- dẹp 90 ngày.
--
-- RIÊNG TƯ — NỚI RANH GIỚI DO ANH TIẾN QUYẾT ĐỊNH (27/11/2026): riêng
-- cụm từ tìm kiếm trên các công cụ tìm kiếm (Google, Bing, DuckDuckGo,
-- Yahoo, Cốc Cốc) được trích ra và lưu ở đây; mọi URL khác vẫn bỏ phần
-- truy vấn như cũ (migration 19). Cụm từ giữ 90 ngày rồi tự xóa (mục 3),
-- như lịch sử web. Lượt tìm kiếm BỊ CHẶN cũng được ghi (cột blocked) để
-- phụ huynh thấy con đã thử tìm gì.
--
-- YÊU CẦU: migration 24 ĐÃ ÁP TRƯỚC — RPC ở mục 2 suy hồ sơ con theo
-- từng mẫu qua bảng device_child_accounts (Sprint 5), giống hệt
-- safepc_push_web_visits bản sau migration 24.
--
-- Migration này:
-- 1. Bảng search_terms + 2 index + RLS (thành viên gia đình chỉ ĐỌC;
--    ghi chỉ qua RPC SECURITY DEFINER ở mục 2, như mẫu audit_logs).
-- 2. RPC safepc_push_search_terms(p_device_id, p_token_hash, p_terms):
--    xác thực thiết bị bằng cặp (device_id, hash của token) qua
--    safepc_auth_device; suy child_id theo từng mẫu từ windows_sid qua
--    device_child_accounts, không khớp/thiếu thì fallback devices.child_id;
--    mẫu không suy ra được con nào thì BỎ QUA (đếm skipped) — không fail
--    cả batch, cùng lý do như migration 24 §6/§7. Term cắt 200 ký tự,
--    engine cắt 32 ký tự. Trả jsonb {inserted, skipped}.
-- 3. Lịch cron 'safepc-search-terms-cleanup': mỗi ngày 03:30 UTC xóa
--    search_terms cũ hơn 90 ngày (theo created_at — thời điểm server
--    nhận; mẫu không mang mốc thời gian riêng nên không có cột thời
--    gian sự kiện như web_visits.visited_at).
--
-- Chạy lại an toàn: IF NOT EXISTS / DROP POLICY IF EXISTS / CREATE OR
-- REPLACE / gỡ lịch cron trước khi tạo lại — chạy lại file không lỗi,
-- không tạo trùng.

-- ============ 1. Bảng search_terms ============
create table if not exists public.search_terms (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  child_id uuid references public.children (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  engine text not null,
  term text not null,
  blocked boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists search_terms_child_created_idx
  on public.search_terms (child_id, created_at desc);

create index if not exists search_terms_family_created_idx
  on public.search_terms (family_id, created_at desc);

alter table public.search_terms enable row level security;

-- Chỉ ĐỌC cho thành viên gia đình (Dashboard/Báo cáo tuần đọc trực tiếp
-- qua RLS); không có policy ghi — Agent ghi qua RPC SECURITY DEFINER,
-- vốn chạy với quyền của chủ hàm nên qua được RLS (cùng mẫu audit_logs
-- ở migration 1: chỉ policy SELECT).
drop policy if exists "family read" on public.search_terms;
create policy "family read" on public.search_terms
  for select using (public.is_family_member(family_id));

-- ============ 2. RPC đẩy cụm từ tìm kiếm từ Agent ============
-- Soi mẫu safepc_push_web_visits BẢN SAU migration 24 (§7): cùng chữ ký
-- xác thực (p_device_id, p_token_hash), child suy ra TỪNG MẪU qua SID;
-- mẫu không suy ra được con nào thì bị lọc ở WHERE và đếm vào skipped —
-- không fail cả batch. Trần batch 500 mẫu như RPC web visits.
create or replace function public.safepc_push_search_terms(
  p_device_id uuid,
  p_token_hash text,
  p_terms jsonb
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, extensions
as $$
declare
  v_device public.devices;
  v_total integer;
  v_inserted integer;
begin
  v_device := public.safepc_auth_device(p_device_id, p_token_hash);

  if p_terms is null or jsonb_typeof(p_terms) <> 'array' then
    raise exception 'invalid_terms' using errcode = 'P0001';
  end if;

  if jsonb_array_length(p_terms) > 500 then
    raise exception 'batch_too_large' using errcode = 'P0001';
  end if;

  v_total := jsonb_array_length(p_terms);

  insert into public.search_terms (family_id, child_id, device_id, engine, term, blocked)
  select
    v_device.family_id,
    coalesce(a.child_id, v_device.child_id),
    v_device.id,
    -- Engine: thiếu/rỗng thì ghi 'unknown' để báo cáo không có engine
    -- trống; trần 32 ký tự (id engine thật chỉ vài ký tự).
    left(coalesce(nullif(trim(s.engine), ''), 'unknown'), 32),
    -- Cụm từ tìm kiếm: giữ nguyên chữ gốc (Dashboard hiển thị + đối
    -- chiếu), trần 200 ký tự.
    left(s.term, 200),
    coalesce(s.blocked, false)
  from jsonb_to_recordset(p_terms)
    as s(engine text, term text, blocked boolean, windows_sid text)
  left join public.device_child_accounts a
    on a.device_id = v_device.id
   and a.windows_sid = s.windows_sid
  where s.term is not null and length(trim(s.term)) > 0
    and coalesce(a.child_id, v_device.child_id) is not null;

  get diagnostics v_inserted = row_count;
  return jsonb_build_object('inserted', v_inserted, 'skipped', v_total - v_inserted);
end;
$$;

grant execute on function public.safepc_push_search_terms(uuid, text, jsonb) to anon, authenticated, service_role;

-- ============ 3. Lịch dọn dẹp cụm từ tìm kiếm cũ hơn 90 ngày ============
-- pg_cron đã bật từ migration 11; IF NOT EXISTS để file chạy được độc
-- lập nếu lịch đó chưa từng áp dụng (mẫu migration 19/23).
create extension if not exists pg_cron with schema extensions;

-- Gỡ lịch cũ cùng tên nếu có (chạy lại file an toàn): câu SELECT dưới
-- đây không làm gì khi chưa có job nào tên này.
select cron.unschedule(jobid) from cron.job where jobname = 'safepc-search-terms-cleanup';

-- 03:30 UTC mỗi ngày (lệch 30 phút với lịch dọn lịch sử web 03:00 để
-- hai lần dọn không chạy cùng lúc; múi giờ database là UTC, xem ghi
-- chú migration 11). Lệnh DELETE trực tiếp, không secret, không gọi
-- HTTP nên không cần pg_net.
select cron.schedule(
  'safepc-search-terms-cleanup',
  '30 3 * * *',
  $cron$delete from public.search_terms where created_at < now() - interval '90 days';$cron$
);

--- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ============
--- select column_name from information_schema.columns where table_name = 'search_terms' order by ordinal_position;
--- Kỳ vọng 8 cột: id, family_id, child_id, device_id, engine, term, blocked, created_at.
--- select relrowsecurity from pg_class where relname = 'search_terms';
--- Kỳ vọng true.
--- select pg_get_function_identity_arguments('public.safepc_push_search_terms(uuid, text, jsonb)'::regprocedure);
--- Kỳ vọng: không lỗi, 1 hàm duy nhất với chữ ký (uuid, text, jsonb).
--- select jobname, schedule, active from cron.job where jobname = 'safepc-search-terms-cleanup';
--- Kỳ vọng 1 dòng: safepc-search-terms-cleanup, '30 3 * * *', active = true.
--- select count(*) from public.search_terms where created_at < now() - interval '90 days';
--- Kỳ vọng: 0 sau lần chạy lịch đầu tiên (trước lần chạy đầu, số này là hàng cũ sẽ bị xóa).
