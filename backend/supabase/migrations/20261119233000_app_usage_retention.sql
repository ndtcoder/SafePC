-- SafePC — Migration 23: tự xóa mẫu dùng ứng dụng cũ hơn 90 ngày
-- Ngày: 19/11/2026. Áp dụng qua Dashboard > SQL Editor (như migration 1-22),
-- chạy một lần, kiểm chứng bằng truy vấn ở cuối file (ghi chú).
--
-- Bối cảnh (review độc lập Sprint 4, MINOR-5): Chính sách riêng tư
-- (docs/09-PRIVACY-POLICY.md §4) hứa "mẫu dùng ứng dụng: mẫu chi tiết giữ
-- 7 ngày cho việc tính giờ; số liệu tổng hợp theo ngày giữ 90 ngày".
-- Nửa đầu chỉ đúng ở local: Agent cắt mẫu cũ hơn 7 ngày
-- (OutboxStore.PruneOldSamplesAsync). Phía server thì SAI: không có
-- DELETE/cron nào dọn bảng app_usage, và cũng không có bảng tổng hợp theo
-- ngày nào (dailyTotals trong weekReport.ts tính client-side từ hàng thô)
-- nên hàng app_usage thô được giữ VÔ THỜI HẠN cho tới khi phụ huynh xóa cả
-- hồ sơ con (migration 15). Migration này làm server đúng với lời hứa:
-- xóa hàng app_usage cũ hơn 90 ngày mỗi ngày. Sau 90 ngày vẫn tính được
-- tổng hợp theo ngày (hàng trong 90 ngày còn nguyên); báo cáo tuần chỉ
-- cần 8 tuần gần nhất nên không vỡ gì.
--
-- Migration này:
-- 1. Lịch cron 'safepc-app-usage-cleanup': mỗi ngày 03:00 UTC (10:00
--    giờ +07) xóa hàng app_usage có started_at cũ hơn 90 ngày. Lệnh
--    DELETE trực tiếp, không secret, không gọi HTTP nên không cần pg_net.
--    Xóa theo started_at (thời điểm dùng thật), không theo created_at
--    (thời điểm hàng được ghi, có thể chậm khi máy offline rồi mới đồng bộ)
--    — cùng lý do như migration 19 với web_visits.visited_at.
--
-- Chạy lại an toàn: lịch gỡ trước rồi mới tạo (mẫu migration 11/12/19)
-- nên chạy lại không tạo trùng job. Không có câu INSERT dữ liệu mẫu nào.
-- Không đổi RPC hay bảng nào khác; xuất dữ liệu (migration 15) sau khi
-- dọn sẽ chỉ còn hàng trong 90 ngày — đúng với chính sách đã hứa.

-- ============ 1. Lịch dọn dẹp mẫu dùng ứng dụng cũ hơn 90 ngày ============
-- pg_cron đã bật từ migration 11; IF NOT EXISTS để file chạy được độc
-- lập nếu lịch đó chưa từng áp dụng.
create extension if not exists pg_cron with schema extensions;

-- Gỡ lịch cũ cùng tên nếu có (chạy lại file an toàn): câu SELECT dưới
-- đây không làm gì khi chưa có job nào tên này.
select cron.unschedule(jobid) from cron.job where jobname = 'safepc-app-usage-cleanup';

-- 03:00 UTC mỗi ngày = 10:00 giờ Việt Nam (múi giờ database là UTC,
-- xem ghi chú migration 11).
select cron.schedule(
  'safepc-app-usage-cleanup',
  '0 3 * * *',
  $cron$delete from public.app_usage where started_at < now() - interval '90 days';$cron$
);

--- ============ Kiểm chứng sau khi áp dụng (chạy riêng, không phải một phần của migration) ============
--- select jobname, schedule, active from cron.job where jobname = 'safepc-app-usage-cleanup';
--- Kỳ vọng 1 dòng: safepc-app-usage-cleanup, '0 3 * * *', active = true.
--- select count(*) from public.app_usage where started_at < now() - interval '90 days';
--- Kỳ vọng: 0 sau lần chạy lịch đầu tiên (trước lần chạy đầu, số này là hàng cũ sẽ bị xóa).
