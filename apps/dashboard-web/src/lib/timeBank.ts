import type { TimeBankGrant } from './types'

/**
 * Logic thuần của ngân hàng giờ (không gọi mạng): tính tổng phút thưởng
 * đang hiệu lực, kiểm tra đầu vào, xếp lịch sử. Ngữ nghĩa thi hành nằm
 * ở migration 13 + lệnh bonus_minutes hiện có — file này chỉ đọc và
 * tính toán từ hàng sổ cái, không tự ý định nghĩa thêm ngữ nghĩa.
 */

/** Phút thưởng cho một lần: 1–240, cùng biên với yêu cầu xin thêm giờ. */
export const TIME_BANK_MIN_MINUTES = 1
export const TIME_BANK_MAX_MINUTES = 240
/** Lý do tối đa 500 ký tự (cùng giới hạn cột reason ở migration 13). */
export const TIME_BANK_MAX_REASON_LENGTH = 500
/** Các mức phút chọn nhanh (cùng các mức form ghi đè ở RulesPage). */
export const TIME_BANK_QUICK_MINUTES = [15, 30, 60, 120]

/**
 * Hết ngày hôm nay theo giờ địa phương (nửa đêm ngày mai), dạng ISO.
 * Cùng công thức form ghi đè ở RulesPage: thưởng cộng giờ luôn hiệu
 * lực tới hết ngày, không cộng dồn qua ngày.
 */
export function endOfTodayIso(now: Date = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0).toISOString()
}

function parseMsOrZero(iso: string | null | undefined): number {
  if (!iso) return 0
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : 0
}

/**
 * Một lần thưởng có đang tính vào tổng không: chưa bị thu hồi và chưa
 * hết hạn. Mốc giờ hỏng thì coi như đã hết hạn (không tính).
 */
export function isGrantActive(grant: TimeBankGrant, nowMs: number): boolean {
  if (grant.status !== 'active') return false
  const ms = Date.parse(grant.expires_at)
  return Number.isFinite(ms) && ms > nowMs
}

/** Tổng phút thưởng đang hiệu lực của con (các lần chưa hết hạn, chưa thu hồi). */
export function activeGrantTotal(grants: readonly TimeBankGrant[], nowMs: number): number {
  let total = 0
  for (const grant of grants) {
    if (isGrantActive(grant, nowMs)) total += grant.minutes
  }
  return total
}

/** Hạn xa nhất trong các lần thưởng đang hiệu lực; null khi không còn lần nào. */
export function activeGrantLatestExpiry(
  grants: readonly TimeBankGrant[],
  nowMs: number,
): string | null {
  let latest: string | null = null
  let latestMs = -1
  for (const grant of grants) {
    if (!isGrantActive(grant, nowMs)) continue
    const ms = Date.parse(grant.expires_at)
    if (ms > latestMs) {
      latestMs = ms
      latest = grant.expires_at
    }
  }
  return latest
}

export type GrantValidationError = 'minutes_not_integer' | 'minutes_out_of_range' | 'reason_too_long'

/** Kiểm tra đầu vào form thưởng; null = hợp lệ. Cùng biên với RPC migration 13. */
export function validateGrantInput(minutes: number, reason: string): GrantValidationError | null {
  if (!Number.isInteger(minutes)) return 'minutes_not_integer'
  if (minutes < TIME_BANK_MIN_MINUTES || minutes > TIME_BANK_MAX_MINUTES) return 'minutes_out_of_range'
  if (reason.length > TIME_BANK_MAX_REASON_LENGTH) return 'reason_too_long'
  return null
}

export function grantValidationMessage(error: GrantValidationError): string {
  switch (error) {
    case 'minutes_not_integer':
      return 'Số phút phải là số nguyên.'
    case 'minutes_out_of_range':
      return `Số phút phải từ ${TIME_BANK_MIN_MINUTES} đến ${TIME_BANK_MAX_MINUTES}.`
    case 'reason_too_long':
      return `Lý do tối đa ${TIME_BANK_MAX_REASON_LENGTH} ký tự.`
  }
}

/** Lịch sử mới nhất trước; hòa giờ tạo thì id lớn trước (ổn định, xác định). */
export function sortGrantsDesc(grants: readonly TimeBankGrant[]): TimeBankGrant[] {
  return [...grants].sort((a, b) => {
    const diff = parseMsOrZero(b.created_at) - parseMsOrZero(a.created_at)
    if (diff !== 0) return diff
    return b.id < a.id ? -1 : b.id > a.id ? 1 : 0
  })
}

export type GrantStatusLabel = 'Đang hiệu lực' | 'Đã hết hạn' | 'Đã thu hồi'

export function grantStatusLabel(grant: TimeBankGrant, nowMs: number): GrantStatusLabel {
  if (grant.status === 'voided') return 'Đã thu hồi'
  return isGrantActive(grant, nowMs) ? 'Đang hiệu lực' : 'Đã hết hạn'
}

/** Người thưởng chỉ phân biệt "Bạn" / "Phụ huynh khác" (Dashboard không tra được email từ id). */
export function grantedByLabel(grantedBy: string, currentUserId: string | null): string {
  if (currentUserId !== null && grantedBy === currentUserId) return 'Bạn'
  return 'Phụ huynh khác'
}
