# SafePC Backend (Supabase)

**Stack:** Supabase Free — Postgres + Auth + Realtime + Storage + Edge Functions.

**Trạng thái:** Sprint 0 — chưa tạo project Supabase. Xem `../docs/02-ARCHITECTURE.md` mục 3 (mô hình dữ liệu) và `../docs/03-SECURITY.md` (RLS) trước khi tạo schema.

**Quy tắc:**
- Mọi bảng đều bật RLS, ranh giới là `family_id`.
- Không commit service_role key, chỉ dùng anon key ở client + RLS.
- Migration đặt trong `migrations/`, đặt tên theo ngày: `YYYYMMDDHHMMSS_ten_migration.sql`.
