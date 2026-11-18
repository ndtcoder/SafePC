// Logic thuần cho luồng duyệt yêu cầu xin mở trang web (loại
// unblock_domain, migration 18): dựng payload lệnh cho phép tạm thời đúng
// hình dạng lệnh ghi đè domain hiện có (xem handleSendDomainOverride ở
// RulesPage.tsx) để Agent nhận qua poll lệnh và xuất bản tempAllow.
// Tách riêng để kiểm tra được bằng harness, không phụ thuộc React.

/** Số phút tối thiểu/tối đa cho một lần cho phép mở trang web tạm thời. */
export const UNBLOCK_DOMAIN_MIN_MINUTES = 1
export const UNBLOCK_DOMAIN_MAX_MINUTES = 240

/** Các mức thời lượng chọn nhanh trên trang Yêu cầu. */
export const UNBLOCK_DOMAIN_DURATIONS = [15, 30, 60]

/**
 * Kẹp số phút về khoảng hợp lệ 1–240. Giá trị không phải số nguyên dương
 * thì trả về giá trị mặc định 30 (không throw — nút Duyệt kiểm tra lại
 * trước khi gửi).
 */
export function clampUnblockMinutes(value: unknown, fallback = 30): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const minutes = Math.floor(value)
  if (minutes < UNBLOCK_DOMAIN_MIN_MINUTES) return UNBLOCK_DOMAIN_MIN_MINUTES
  if (minutes > UNBLOCK_DOMAIN_MAX_MINUTES) return UNBLOCK_DOMAIN_MAX_MINUTES
  return minutes
}

/**
 * Payload lệnh temporary_override cho phép tạm thời một domain. Trả về
 * null khi tên miền rỗng — nơi gọi hiện lỗi thay vì gửi lệnh không có
 * domain. Tên miền đã chuẩn hóa phía server (chữ thường, chỉ tên miền);
 * ở đây chỉ trim, không tự sửa gì thêm.
 */
export function buildAllowDomainCommandPayload(
  domain: string | null | undefined,
  minutes: number,
  nowMs: number,
): { action: 'allow_domain'; domains: string[]; minutes: number; expires_at: string } | null {
  const trimmed = (domain ?? '').trim()
  if (trimmed === '') return null
  const safeMinutes = clampUnblockMinutes(minutes)
  return {
    action: 'allow_domain',
    domains: [trimmed],
    minutes: safeMinutes,
    expires_at: new Date(nowMs + safeMinutes * 60000).toISOString(),
  }
}
