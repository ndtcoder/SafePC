// Logic thuần cho trang Hôm nay (tổng quan thật, PRD §2.8): giờ dùng theo
// từng giờ trong ngày, trạng thái máy, và giờ còn lại của từng con.
// Không phụ thuộc React/Supabase — mọi giờ giấc tính theo giờ địa phương
// của trình duyệt, cùng quy ước với trang Báo cáo tuần (phụ huynh xem ở
// cùng múi giờ với máy con). Một phiên dùng máy được tính vào giờ bắt đầu
// của nó (cột started_at), cùng quy ước gom theo ngày bắt đầu của trang
// Báo cáo tuần.

import { resolveDailyLimits } from './weekReport'
import type { AppUsage, Command, Device, Rule } from './types'

// ---------------------------------------------------------------------------
// Giờ dùng theo từng giờ trong ngày
// ---------------------------------------------------------------------------

export interface HourlyTotal {
  /** Giờ trong ngày, 0–23 (giờ địa phương). */
  hour: number
  /** Nhãn trục biểu đồ, vd "7h". */
  label: string
  totalSec: number
}

/** Khóa ngày theo giờ địa phương ("2026-11-18") để chỉ tính phiên của đúng ngày đó. */
function dateKeyLocal(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

/**
 * Tổng thời gian dùng máy cho 24 giờ của `day` (giờ địa phương). Phiên
 * bắt đầu trước/sau ngày đó (lệch đồng hồ, dữ liệu cũ lọt vào) bị bỏ qua;
 * ngày giờ hỏng và thời lượng âm cũng bị bỏ qua thay vì làm vỡ biểu đồ.
 */
export function hourlyTotals(usage: readonly AppUsage[], day: Date): HourlyTotal[] {
  const byHour = new Map<number, number>()
  const dayKey = dateKeyLocal(day)
  for (const row of usage) {
    const started = new Date(row.started_at)
    if (Number.isNaN(started.getTime())) continue
    if (dateKeyLocal(started) !== dayKey) continue
    const hour = started.getHours()
    byHour.set(hour, (byHour.get(hour) ?? 0) + Math.max(0, row.duration_sec))
  }
  const hours: HourlyTotal[] = []
  for (let hour = 0; hour < 24; hour++) {
    hours.push({ hour, label: `${hour}h`, totalSec: byHour.get(hour) ?? 0 })
  }
  return hours
}

// ---------------------------------------------------------------------------
// Trạng thái máy (cùng quy ước với trang Thiết bị)
// ---------------------------------------------------------------------------

/** Máy coi là đang online khi heartbeat mới nhất trong vòng 10 phút. */
export function isDeviceOnline(device: Device, nowMs: number): boolean {
  if (!device.last_seen_at) return false
  const seenMs = new Date(device.last_seen_at).getTime()
  if (Number.isNaN(seenMs)) return false
  return nowMs - seenMs <= 10 * 60 * 1000
}

export type ExtensionTone = 'ok' | 'warn' | 'unknown'

export interface ExtensionStatus {
  label: string
  tone: ExtensionTone
}

/**
 * Trạng thái extension trình duyệt từ `last_extension_seen_at` (cột do
 * migration 5 thêm). Thấy trong 15 phút gần nhất thì coi là đang hoạt
 * động; `null`/`undefined` (chưa áp migration 5, hoặc máy chưa từng báo)
 * đều là "Chưa có dữ liệu" — không báo giả là extension mất.
 */
export function extensionStatus(seenAt: string | null | undefined, nowMs: number): ExtensionStatus {
  if (!seenAt) return { label: 'Chưa có dữ liệu', tone: 'unknown' }
  const seenMs = new Date(seenAt).getTime()
  if (Number.isNaN(seenMs)) return { label: 'Chưa có dữ liệu', tone: 'unknown' }
  if (nowMs - seenMs < 15 * 60 * 1000) {
    return { label: 'Đang hoạt động', tone: 'ok' }
  }
  return { label: 'Không thấy gần đây', tone: 'warn' }
}

// ---------------------------------------------------------------------------
// Ghi đè tạm thời đang hiệu lực (luật mới-nhất-thắng, cùng luật với
// getActiveUnlock ở trang Thiết bị và getActiveOverride ở trang Quy tắc)
// ---------------------------------------------------------------------------

export type ActiveOverride =
  | { kind: 'unlock'; expiresAt: Date }
  | { kind: 'bonus'; minutes: number; expiresAt: Date }

const OVERRIDE_ACTIONS = new Set([
  'bonus_minutes',
  'lock',
  'unlock',
  'allow_domain',
  'block_domain',
  'block_app',
  'allow_app',
])

/**
 * Ghi đè mở khóa/cộng giờ đang hiệu lực trên một máy, suy ra từ các lệnh
 * mới nhất (mới nhất trước). Lệnh mới nhất cho máy đó quyết định: cancel
 * hoặc đã hết hạn nghĩa là không còn ghi đè; lock_now mới hơn chỉ hủy
 * ghi đè mở khóa (phía Service giữ nguyên ghi đè cộng giờ khi khóa máy);
 * ghi đè khác loại (khóa, chặn/mở website/ứng dụng) nghĩa là ghi đè mở
 * khóa/cộng giờ đã bị thay thế. Lệnh unlock trần không tạo ghi đè nên
 * bỏ qua. Trả về null khi không có ghi đè mở khóa/cộng giờ nào đang
 * hiệu lực.
 */
export function activeOverrideForDevice(
  commands: readonly Command[],
  deviceId: string,
  nowMs: number,
): ActiveOverride | null {
  // Có lệnh lock_now mới hơn ghi đè đang xét hay không (duyệt mới nhất
  // trước nên lock_now gặp trước ghi đè nghĩa là mới hơn ghi đè đó).
  // Cùng mẫu getActiveOverride của trang Quy tắc.
  let sawNewerLockNow = false
  for (const command of commands) {
    if (command.device_id !== deviceId) continue
    if (command.type === 'lock_now') {
      sawNewerLockNow = true
      continue
    }
    if (command.type !== 'temporary_override') continue
    const action = command.payload['action']
    if (action === 'cancel') return null
    if (typeof action !== 'string' || !OVERRIDE_ACTIONS.has(action)) continue
    // Ghi đè mở khóa đã bị lock_now mới hơn hủy phía Service thì không
    // còn hiệu lực; ghi đè cộng giờ thì lock_now không hủy nên vẫn sống.
    if (action === 'unlock' && sawNewerLockNow) return null
    const expiresRaw = command.payload['expires_at']
    const expiresAt = typeof expiresRaw === 'string' ? new Date(expiresRaw) : null
    if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= nowMs) return null
    if (action === 'unlock') return { kind: 'unlock', expiresAt }
    if (action === 'bonus_minutes') {
      const minutesRaw = command.payload['minutes']
      const minutes =
        typeof minutesRaw === 'number' && Number.isFinite(minutesRaw)
          ? Math.max(0, Math.floor(minutesRaw))
          : 0
      return { kind: 'bonus', minutes, expiresAt }
    }
    return null
  }
  return null
}

// ---------------------------------------------------------------------------
// Giờ còn lại của một con trong ngày hôm nay
// ---------------------------------------------------------------------------

export interface RemainingTime {
  /** Giới hạn phút/ngày hôm nay (quy tắc chặt nhất đang bật), null = không giới hạn. */
  capMin: number | null
  /** Phút thưởng đang hiệu lực (cộng vào mức trần, theo ngữ nghĩa bonus_minutes của Agent). */
  bonusMin: number
  /** Thời gian đã dùng hôm nay (giây, theo dữ liệu app_usage đã đồng bộ). */
  usedSec: number
  /**
   * Số giây còn lại so với mức trần đã cộng thưởng; null khi không giới
   * hạn. Âm nghĩa là đã dùng vượt mức trần.
   */
  remainingSec: number | null
  /** Thời điểm hết mở khóa tạm thời, khi có máy nào của con đang được mở khóa. */
  unlockExpiresAt: Date | null
  state: 'unlimited' | 'remaining' | 'over' | 'unlocked'
}

/**
 * Giờ còn lại của một con, tính từ quy tắc daily_limit ĐANG BẬT (nhiều
 * quy tắc cùng ngày thì lấy giới hạn nhỏ nhất — khớp cách Agent thi
 * hành) trừ thời gian đã dùng, cộng phút thưởng đang hiệu lực. Khi con
 * đang được mở khóa tạm thời thì quy tắc giờ giấc bị ngưng nên trạng
 * thái là 'unlocked' và con số còn lại chỉ mang tính tham khảo.
 *
 * Đây là số liệu hiển thị từ dữ liệu đã đồng bộ (Agent gửi mỗi 5 phút)
 * nên có thể chậm vài phút so với máy con; quyết định khóa thật do Agent
 * trên máy thi hành. Chỉ tính thời gian dùng ứng dụng (app_usage) — thời
 * gian duyệt web không cộng thêm vì thời gian trình duyệt đã nằm trong
 * thời gian dùng ứng dụng đó.
 */
export function remainingTimeForChild(args: {
  /** Quy tắc của con (mọi loại; chỉ daily_limit đang bật được dùng). */
  rules: readonly Rule[]
  /** Thời gian đã dùng hôm nay của con (giây). */
  usedSec: number
  /** Lệnh mới nhất trước (đã lọc temporary_override + lock_now). */
  commands: readonly Command[]
  /** Id các máy của con. */
  deviceIds: readonly string[]
  now: Date
}): RemainingTime {
  const { rules, commands, deviceIds, now } = args
  const nowMs = now.getTime()
  const usedSec = Math.max(0, args.usedSec)
  const weekday = now.getDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6
  const capMin = resolveDailyLimits(rules)[weekday] ?? null

  let bonusMin = 0
  let unlockExpiresAt: Date | null = null
  for (const deviceId of deviceIds) {
    const override = activeOverrideForDevice(commands, deviceId, nowMs)
    if (!override) continue
    if (override.kind === 'unlock') {
      if (!unlockExpiresAt || override.expiresAt.getTime() > unlockExpiresAt.getTime()) {
        unlockExpiresAt = override.expiresAt
      }
    } else if (override.minutes > bonusMin) {
      // Phút thưởng lưu theo từng máy trên Agent; con có nhiều máy thì
      // lấy mức thưởng lớn nhất đang hiệu lực để hiển thị.
      bonusMin = override.minutes
    }
  }

  const remainingSec = capMin === null ? null : (capMin + bonusMin) * 60 - usedSec
  const state: RemainingTime['state'] =
    unlockExpiresAt !== null
      ? 'unlocked'
      : capMin === null
        ? 'unlimited'
        : (remainingSec ?? 0) < 0
          ? 'over'
          : 'remaining'
  return { capMin, bonusMin, usedSec, remainingSec, unlockExpiresAt, state }
}
