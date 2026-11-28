/**
 * Logic thuần cho tab Chụp màn hình trong hồ sơ con (migration 32,
 * PRD §2.16): các mức chụp/hạn giữ cho phép, ước tính dung lượng
 * Drive, và dịch mã lỗi trả về từ luồng OAuth Google Drive.
 *
 * Công thức ước tính theo docs/11-RESEARCH-SCREENSHOTS.md mục 2:
 * ngày dùng máy 10 giờ, ảnh thu nhỏ 1280px nén JPEG trung bình
 * ~300 KB/ảnh (mức làm việc thực tế 150–300 KB). Đây là ƯỚC TÍNH
 * kịch bản xấu (chưa tính khử trùng lặp ảnh giống nhau, vốn giảm
 * thêm 30–60% trong ngày học tập tĩnh).
 */

/** Các mức chụp cho phép (phút) — khớp CHECK của child_screen_settings. */
export const SCREEN_INTERVAL_OPTIONS = [1, 2, 5, 10, 15, 30] as const

/** Các hạn giữ cho phép (ngày) — khớp CHECK của child_screen_settings. */
export const SCREEN_RETENTION_OPTIONS = [14, 30, 90, 180] as const

/** Số giờ dùng máy giả định trong một ngày cho ước tính dung lượng. */
export const ESTIMATE_HOURS_PER_DAY = 10

/** Kích thước trung bình giả định của một ảnh (KB) cho ước tính. */
export const ESTIMATE_KB_PER_SHOT = 300

export interface StorageEstimate {
  /** Số ảnh chụp trong một ngày dùng 10 giờ. */
  shotsPerDay: number
  /** Tổng số ảnh trong suốt hạn giữ. */
  totalShots: number
  /** Tổng dung lượng ước tính (GB, 1 GB = 1024^3 byte). */
  totalGb: number
}

export function estimateStorage(intervalMinutes: number, retentionDays: number): StorageEstimate {
  const shotsPerDay = Math.floor((ESTIMATE_HOURS_PER_DAY * 60) / intervalMinutes)
  const totalShots = shotsPerDay * retentionDays
  const totalBytes = totalShots * ESTIMATE_KB_PER_SHOT * 1024
  return { shotsPerDay, totalShots, totalGb: totalBytes / (1024 * 1024 * 1024) }
}

/** '1,5 GB' / '0,54 GB' — tối đa 2 chữ số thập phân, bỏ số 0 thừa. */
export function formatGb(gb: number): string {
  const rounded = Math.round(gb * 100) / 100
  return `${rounded.toLocaleString('vi-VN', { maximumFractionDigits: 2 })} GB`
}

/** Kích thước một ảnh trong danh mục: '245 KB' (làm tròn lên KB). */
export function formatSizeKb(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return '0 KB'
  return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`
}

/**
 * Dịch mã `reason` trong tham số ?drive=error&reason=... mà Edge
 * Function connect-google-drive chuyển hướng về. Mã lạ → câu chung.
 */
export function driveErrorReasonLabel(reason: string | null): string {
  switch (reason) {
    case 'google_denied':
      return 'Bạn đã hủy hoặc Google từ chối cấp quyền. Bấm “Kết nối Google Drive” để thử lại.'
    case 'state_expired':
    case 'state_invalid':
      return 'Phiên kết nối đã hết hạn. Bấm “Kết nối Google Drive” để bắt đầu lại.'
    case 'missing_refresh_token':
      return 'Google không cấp quyền lưu trữ lâu dài cho lần kết nối này. Bấm “Kết nối Google Drive” và đồng ý cấp quyền để thử lại.'
    case 'token_exchange_failed':
      return 'Không đổi được mã kết nối với Google. Vui lòng thử lại sau ít phút.'
    case 'not_configured':
      return 'Tính năng kết nối Google Drive chưa được cấu hình trên máy chủ (thiếu thông tin OAuth của SafePC).'
    default:
      return 'Kết nối Google Drive chưa thành công. Vui lòng thử lại.'
  }
}
