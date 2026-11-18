// Logic thuần cho trang Báo cáo tuần (không phụ thuộc React/Supabase):
// ranh giới tuần theo giờ địa phương (bắt đầu thứ Hai), tổng hợp dữ liệu
// thô thành 7 mục của PRD §2.10, và các quy tắc gợi ý tự động.
//
// Mọi ngày/giờ đều tính theo giờ địa phương của trình duyệt: phụ huynh
// xem báo cáo ở cùng múi giờ với máy con (Việt Nam, GMT+7), khớp quy
// ước "giờ giấc theo giờ local trên máy con" của Agent. Một phiên dùng
// máy được tính vào ngày bắt đầu của nó (cột started_at / visited_at),
// cùng quy ước với trang Hôm nay.

import { formatDurationVi } from './format'
import { parseDailyLimitConfig, WEEKDAY_OPTIONS, type MinutesByWeekday, type WeekdayNumber } from './ruleConfig'
import type { AppRequest, AppUsage, AuditLog, Command, Device, Rule as RuleRow, WebVisit } from './types'

// ---------------------------------------------------------------------------
// Tuần: bắt đầu thứ Hai, giờ địa phương
// ---------------------------------------------------------------------------

/** Thứ tự ngày trong tuần báo cáo: Thứ 2 trước, Chủ nhật cuối (quy ước 0 = Chủ nhật). */
export const WEEK_ORDER: WeekdayNumber[] = [1, 2, 3, 4, 5, 6, 0]

/** Nhãn ngắn cho trục biểu đồ. */
export const WEEKDAY_SHORT: Record<WeekdayNumber, string> = {
  0: 'CN',
  1: 'T2',
  2: 'T3',
  3: 'T4',
  4: 'T5',
  5: 'T6',
  6: 'T7',
}

/** Nhãn đầy đủ ("Thứ 2", …, "Chủ nhật") — lấy từ WEEKDAY_OPTIONS để khỏi lệch. */
export function weekdayLabel(day: WeekdayNumber): string {
  return WEEKDAY_OPTIONS.find((o) => o.value === day)?.label ?? `Thứ ${day}`
}

/** 00:00:00 giờ địa phương của ngày chứa `date`. */
export function startOfDayLocal(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0)
}

/** Thứ Hai 00:00 giờ địa phương của tuần chứa `date`. */
export function mondayOfWeek(date: Date): Date {
  const day = startOfDayLocal(date)
  // getDay(): 0 = Chủ nhật … 6 = Thứ 7; khoảng lùi về thứ Hai: (getDay + 6) % 7.
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7))
  return day
}

export interface WeekRange {
  /** Thứ Hai 00:00 giờ địa phương, bao gồm. */
  start: Date
  /** Thứ Hai tuần sau 00:00 giờ địa phương, loại trừ. */
  end: Date
}

/** Ranh giới tuần: offset 0 = tuần này, 1 = tuần trước, … */
export function weekRange(weekOffset: number, now: Date = new Date()): WeekRange {
  const start = mondayOfWeek(now)
  start.setDate(start.getDate() - weekOffset * 7)
  const end = new Date(start)
  end.setDate(end.getDate() + 7)
  return { start, end }
}

/** "17/11" — thêm năm khi hai đầu khác năm ("29/12/2026 – 04/01/2027"). */
export function weekRangeText(range: WeekRange): string {
  const last = new Date(range.end)
  last.setDate(last.getDate() - 1)
  const dayMonth = (d: Date): string =>
    `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
  if (range.start.getFullYear() === last.getFullYear()) {
    return `${dayMonth(range.start)} – ${dayMonth(last)}`
  }
  return `${dayMonth(range.start)}/${range.start.getFullYear()} – ${dayMonth(last)}/${last.getFullYear()}`
}

/** Nhãn cho ô chọn tuần: "Tuần này (17/11 – 23/11)", "Tuần trước (…)", "Tuần …". */
export function weekOptionLabel(weekOffset: number, now: Date = new Date()): string {
  const range = weekRange(weekOffset, now)
  const prefix = weekOffset === 0 ? 'Tuần này' : weekOffset === 1 ? 'Tuần trước' : 'Tuần'
  return `${prefix} (${weekRangeText(range)})`
}

/** Số tuần trước cho phép chọn (tuần này + 7 tuần trước). */
export const WEEK_HISTORY_COUNT = 8

/** Khóa ngày theo giờ địa phương ("2026-11-17") để gom phiên theo ngày. */
export function dateKeyLocal(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

// ---------------------------------------------------------------------------
// Tổng hợp theo ngày
// ---------------------------------------------------------------------------

export interface DailyTotal {
  weekday: WeekdayNumber
  /** Ngày đó, 00:00 giờ địa phương. */
  date: Date
  shortLabel: string
  fullLabel: string
  totalSec: number
}

/** Tổng giờ dùng cho 7 ngày của tuần (Thứ 2 → Chủ nhật), gom theo ngày bắt đầu phiên. */
export function dailyTotals(usage: readonly AppUsage[], range: WeekRange): DailyTotal[] {
  const byKey = new Map<string, number>()
  for (const row of usage) {
    const started = new Date(row.started_at)
    if (Number.isNaN(started.getTime())) continue
    const key = dateKeyLocal(started)
    byKey.set(key, (byKey.get(key) ?? 0) + Math.max(0, row.duration_sec))
  }
  const days: DailyTotal[] = []
  for (let i = 0; i < 7; i++) {
    const date = new Date(range.start)
    date.setDate(date.getDate() + i)
    const weekday = date.getDay() as WeekdayNumber
    days.push({
      weekday,
      date,
      shortLabel: WEEKDAY_SHORT[weekday],
      fullLabel: weekdayLabel(weekday),
      totalSec: byKey.get(dateKeyLocal(date)) ?? 0,
    })
  }
  return days
}

export function sumDurationSec(rows: readonly { duration_sec: number }[]): number {
  return rows.reduce((sum, row) => sum + Math.max(0, row.duration_sec), 0)
}

/** Số ngày trong tuần có dùng máy (tổng thời lượng ngày đó > 0). */
export function activeDayCount(daily: readonly DailyTotal[]): number {
  return daily.filter((d) => d.totalSec > 0).length
}

// ---------------------------------------------------------------------------
// Top ứng dụng / domain
// ---------------------------------------------------------------------------

export interface TopEntry {
  name: string
  totalSec: number
  /** Tỉ lệ trên tổng thời lượng cùng loại (0–1). */
  share: number
}

function topEntries(
  totals: Map<string, number>,
  totalSec: number,
  limit: number,
): TopEntry[] {
  return [...totals.entries()]
    .map(([name, entrySec]) => ({
      name,
      totalSec: entrySec,
      share: totalSec > 0 ? entrySec / totalSec : 0,
    }))
    .sort((a, b) => b.totalSec - a.totalSec)
    .slice(0, limit)
}

export function topApps(usage: readonly AppUsage[], limit = 5): TopEntry[] {
  const totals = new Map<string, number>()
  for (const row of usage) {
    totals.set(row.app_name, (totals.get(row.app_name) ?? 0) + Math.max(0, row.duration_sec))
  }
  return topEntries(totals, sumDurationSec(usage), limit)
}

export function topDomains(visits: readonly WebVisit[], limit = 5): TopEntry[] {
  const totals = new Map<string, number>()
  for (const row of visits) {
    // Lượt web bị chặn (blocked, duration_sec = 0) không phải thời gian
    // xem thật — loại khỏi top domain để không hiện mục 0 phút.
    if (row.blocked) continue
    totals.set(row.domain, (totals.get(row.domain) ?? 0) + Math.max(0, row.duration_sec))
  }
  return topEntries(totals, sumDurationSec(visits), limit)
}

// ---------------------------------------------------------------------------
// Giới hạn giờ/ngày (đường giới hạn trên biểu đồ)
// ---------------------------------------------------------------------------

/**
 * Giới hạn phút/ngày theo thứ, từ các quy tắc daily_limit ĐANG BẬT của
 * con. Nhiều quy tắc cùng ngày thì lấy giới hạn NHỎ NHẤT (chặt nhất
 * thắng — khớp cách RuleEngine thi hành). Ngày vắng mặt = không giới
 * hạn. Phản ánh quy tắc HIỆN TẠI, không phải quy tắc từng áp trong tuần.
 */
export function resolveDailyLimits(rules: readonly RuleRow[]): MinutesByWeekday {
  const limits: MinutesByWeekday = {}
  for (const rule of rules) {
    if (rule.type !== 'daily_limit' || !rule.enabled) continue
    const parsed = parseDailyLimitConfig(rule.config ?? {})
    for (const [key, minutes] of Object.entries(parsed)) {
      const day = Number(key) as WeekdayNumber
      if (minutes === undefined) continue
      const current = limits[day]
      if (current === undefined || minutes < current) limits[day] = minutes
    }
  }
  return limits
}

export interface OverLimitDay {
  day: DailyTotal
  limitMin: number
}

/** Các ngày dùng vượt giới hạn (tổng thời lượng > giới hạn phút của ngày đó). */
export function overLimitDays(
  daily: readonly DailyTotal[],
  limits: MinutesByWeekday,
): OverLimitDay[] {
  const over: OverLimitDay[] = []
  for (const day of daily) {
    const limitMin = limits[day.weekday]
    if (limitMin !== undefined && day.totalSec > limitMin * 60) {
      over.push({ day, limitMin })
    }
  }
  return over
}

// ---------------------------------------------------------------------------
// Yêu cầu, thi hành, cảnh báo
// ---------------------------------------------------------------------------

export interface RequestSummary {
  total: number
  pending: number
  approved: number
  denied: number
  extraTime: number
  unblockApp: number
  unblockDomain: number
}

export function summarizeRequests(requests: readonly AppRequest[]): RequestSummary {
  const summary: RequestSummary = {
    total: requests.length,
    pending: 0,
    approved: 0,
    denied: 0,
    extraTime: 0,
    unblockApp: 0,
    unblockDomain: 0,
  }
  for (const request of requests) {
    if (request.status === 'pending') summary.pending += 1
    else if (request.status === 'approved') summary.approved += 1
    else if (request.status === 'denied') summary.denied += 1
    if (request.type === 'extra_time') summary.extraTime += 1
    else if (request.type === 'unblock_app') summary.unblockApp += 1
    else if (request.type === 'unblock_domain') summary.unblockDomain += 1
  }
  return summary
}

/**
 * Lệnh thi hành do PHỤ HUYNH gửi trong tuần, chỉ tính lệnh Agent đã nhận
 * (status sent/done — lệnh pending/failed chưa thi hành). Lệnh khóa =
 * lock_now + temporary_override có action 'lock'; lệnh chặn tạm thời =
 * temporary_override có action 'block_domain'/'block_app'.
 *
 * Lịch sử thi hành DO QUY TẮC (khóa theo giờ giấc, chặn app, cảnh báo,
 * nghỉ bắt buộc) nằm ở audit_logs với 4 action thi hành (xem
 * ENFORCEMENT_ACTIONS, ghi bởi RPC safepc_push_enforcement_event từ
 * migration 10) — đếm bằng countRuleEnforcement, không đếm ở đây, để
 * lệnh phụ huynh và thi hành theo quy tắc không đếm trùng nhau: khóa do
 * phụ huynh chỉ tính ở hàm này, khóa do quy tắc chỉ tính ở hàm kia.
 */
export interface ParentEnforcementCounts {
  parentLocks: number
  parentTempBlocks: number
}

export function countParentEnforcement(commands: readonly Command[]): ParentEnforcementCounts {
  let parentLocks = 0
  let parentTempBlocks = 0
  for (const command of commands) {
    if (command.status !== 'sent' && command.status !== 'done') continue
    if (command.type === 'lock_now') {
      parentLocks += 1
      continue
    }
    if (command.type === 'temporary_override') {
      const action = command.payload['action']
      if (action === 'lock') parentLocks += 1
      else if (action === 'block_domain' || action === 'block_app') parentTempBlocks += 1
    }
  }
  return { parentLocks, parentTempBlocks }
}

/** Số lượt thăm web bị chặn (cột blocked — extension 0.1.7 báo cáo qua RPC, migration 10). */
export function countBlockedVisits(visits: readonly WebVisit[]): number {
  return visits.filter((v) => v.blocked).length
}

/** Bốn loại sự kiện can thiệp mà RPC safepc_push_tamper_event chấp nhận. */
export const TAMPER_ACTIONS = ['clock_drift', 'agent_restart', 'extension_missing', 'service_stopped'] as const

/**
 * Bốn loại sự kiện thi hành mà RPC safepc_push_enforcement_event chấp
 * nhận (migration 10). Agent chỉ ghi chuyển trạng thái: khóa bắt đầu
 * (chỉ khóa do quy tắc giờ giấc — khóa do phụ huynh đếm từ bảng
 * commands), nghỉ bắt đầu, lần đóng app, lần hiện cảnh báo.
 */
export const ENFORCEMENT_ACTIONS = ['lock_started', 'break_started', 'app_blocked', 'warning_shown'] as const

/**
 * Một hàng audit_logs có thuộc về một con không: khớp cột child_id (mọi
 * sự kiện do RPC migration 5/10 ghi đều có), hoặc — với hàng cũ không có
 * child_id — khớp qua thiết bị ở cột target (id thiết bị dạng text).
 * Dùng chung cho sự kiện can thiệp và sự kiện thi hành.
 */
export function isLogForChild(
  log: AuditLog,
  childId: string,
  deviceChildById: ReadonlyMap<string, string>,
): boolean {
  if (log.child_id) return log.child_id === childId
  if (log.target) return deviceChildById.get(log.target) === childId
  return false
}

/**
 * Lọc sự kiện can thiệp thuộc về một con (xem isLogForChild). Chỉ giữ
 * đúng 4 loại can thiệp (TAMPER_ACTIONS): truy vấn audit_logs còn lấy
 * cả sự kiện thi hành (migration 10) cho mục "Quy tắc đã thi hành", và
 * không lọc action ở đây thì sự kiện thi hành sẽ rò sang thẻ Cảnh báo.
 */
export function filterTamperForChild(
  logs: readonly AuditLog[],
  childId: string,
  deviceChildById: ReadonlyMap<string, string>,
): AuditLog[] {
  return logs.filter(
    (log) =>
      (TAMPER_ACTIONS as readonly string[]).includes(log.action) &&
      isLogForChild(log, childId, deviceChildById),
  )
}

export interface RuleEnforcementCounts {
  /** Khóa do giờ ngủ (lock_started, details.kind = bedtime). */
  bedtimeLocks: number
  /** Khóa do ngoài khung giờ (lock_started, details.kind = time_window). */
  timeWindowLocks: number
  /** Khóa do hết giới hạn ngày (lock_started, details.kind = daily_limit). */
  dailyLimitLocks: number
  /** Khóa do quy tắc nhưng không phân loại được (kind khác/lạ). */
  otherRuleLocks: number
  /** Nghỉ bắt buộc bắt đầu (break_started). */
  breaks: number
  /** Ứng dụng bị đóng (app_blocked). */
  appBlocks: number
  /** Cảnh báo đã hiện (warning_shown). */
  warnings: number
}

/**
 * Đếm thi hành theo quy tắc trong tuần từ audit_logs: chỉ hàng thuộc về
 * con (xem isLogForChild) và action thuộc ENFORCEMENT_ACTIONS. Khóa
 * phân loại theo details.kind; kind lạ/thiếu thì tính vào
 * otherRuleLocks để tổng số khóa không bị mất. Lượt web bị chặn KHÔNG
 * đếm ở đây — đếm từ web_visits.blocked bằng countBlockedVisits.
 *
 * Lịch sử chỉ bắt đầu từ khi migration 10 được áp + bản Agent/extension
 * mới được cài trên máy con: tuần trước thời điểm đó trả về 0 cho mọi
 * mục, và giao diện ghi rõ đó là thiếu dữ liệu chứ không phải không có
 * thi hành.
 */
export function countRuleEnforcement(
  logs: readonly AuditLog[],
  childId: string,
  deviceChildById: ReadonlyMap<string, string>,
): RuleEnforcementCounts {
  const counts: RuleEnforcementCounts = {
    bedtimeLocks: 0,
    timeWindowLocks: 0,
    dailyLimitLocks: 0,
    otherRuleLocks: 0,
    breaks: 0,
    appBlocks: 0,
    warnings: 0,
  }
  for (const log of logs) {
    if (!isLogForChild(log, childId, deviceChildById)) continue
    if (log.action === 'lock_started') {
      const kind = log.details?.['kind']
      if (kind === 'bedtime') counts.bedtimeLocks += 1
      else if (kind === 'time_window') counts.timeWindowLocks += 1
      else if (kind === 'daily_limit') counts.dailyLimitLocks += 1
      else counts.otherRuleLocks += 1
    } else if (log.action === 'break_started') {
      counts.breaks += 1
    } else if (log.action === 'app_blocked') {
      counts.appBlocks += 1
    } else if (log.action === 'warning_shown') {
      counts.warnings += 1
    }
  }
  return counts
}

/** Số phút đồng hồ lệch từ details của sự kiện clock_drift ({ drift_minutes }), null nếu không có. */
export function driftMinutes(details: AuditLog['details']): number | null {
  if (!details || typeof details !== 'object') return null
  const value = (details as Record<string, unknown>)['drift_minutes']
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// ---------------------------------------------------------------------------
// Kiểm tra tình trạng hiện tại (lúc xem báo cáo, không gắn với tuần đã chọn)
// ---------------------------------------------------------------------------

/** Máy không thấy quá 48 giờ thì báo "offline bất thường". */
export const OFFLINE_WARNING_AFTER_MS = 48 * 3600 * 1000
/** Extension không thấy quá 24 giờ trong khi máy vẫn hoạt động thì báo "mất tín hiệu". */
export const EXTENSION_STALE_AFTER_MS = 24 * 3600 * 1000
/** Máy được coi là "vẫn hoạt động" nếu thấy trong 24 giờ qua. */
export const DEVICE_ACTIVE_WITHIN_MS = 24 * 3600 * 1000

export interface CurrentWarning {
  kind: 'offline' | 'extension'
  device: Device
  lastSeenAt: string | null
  extensionSeenAt: string | null | undefined
}

/**
 * Kiểm tra tình trạng hiện tại của các máy của con:
 * - Offline bất thường: máy từng kết nối nhưng đã quá 48 giờ không thấy.
 * - Extension mất tín hiệu: máy vẫn thấy trong 24 giờ qua nhưng extension
 *   chưa từng thấy (null) hoặc đã quá 24 giờ không thấy. `undefined` =
 *   chưa biết gì về extension (truy vấn cột thất bại) thì bỏ qua, không
 *   báo động giả.
 */
export function currentStateWarnings(
  devices: readonly Device[],
  extensionSeenByDevice: ReadonlyMap<string, string | null>,
  nowMs: number,
): CurrentWarning[] {
  const warnings: CurrentWarning[] = []
  for (const device of devices) {
    const lastSeenMs = device.last_seen_at ? new Date(device.last_seen_at).getTime() : Number.NaN
    const hasLastSeen = Number.isFinite(lastSeenMs)
    if (hasLastSeen && nowMs - lastSeenMs > OFFLINE_WARNING_AFTER_MS) {
      warnings.push({ kind: 'offline', device, lastSeenAt: device.last_seen_at, extensionSeenAt: extensionSeenByDevice.get(device.id) })
      continue
    }
    if (!hasLastSeen || nowMs - lastSeenMs > DEVICE_ACTIVE_WITHIN_MS) continue
    const extSeen = extensionSeenByDevice.get(device.id)
    if (extSeen === undefined) continue
    const extSeenMs = extSeen ? new Date(extSeen).getTime() : Number.NaN
    if (!extSeen || !Number.isFinite(extSeenMs) || nowMs - extSeenMs > EXTENSION_STALE_AFTER_MS) {
      warnings.push({ kind: 'extension', device, lastSeenAt: device.last_seen_at, extensionSeenAt: extSeen })
    }
  }
  return warnings
}

// ---------------------------------------------------------------------------
// Gợi ý tự động — mỗi gợi ý phải nêu được con số dẫn tới nó
// ---------------------------------------------------------------------------

/** Giờ bắt đầu phiên từ 21:00 trở đi được tính là "dùng máy buổi tối muộn". */
export const LATE_NIGHT_HOUR = 21
const LATE_NIGHT_MIN_DAYS = 2
/** Trung bình cuối tuần gấp 1,5 lần ngày thường trở lên thì gợi ý. */
const WEEKEND_RATIO_THRESHOLD = 1.5
/** Một app/domain chiếm từ 40% thời lượng trở lên thì gợi ý. */
const SHARE_THRESHOLD = 0.4
/** Vượt giới hạn từ 2 ngày trở lên thì gợi ý. */
const OVER_LIMIT_MIN_DAYS = 2

/** Các ngày có phiên bắt đầu từ 21:00 trở đi (giờ địa phương). */
export function lateNightDays(
  usage: readonly AppUsage[],
  daily: readonly DailyTotal[],
): DailyTotal[] {
  const keys = new Set<string>()
  for (const row of usage) {
    const started = new Date(row.started_at)
    if (Number.isNaN(started.getTime())) continue
    if (started.getHours() >= LATE_NIGHT_HOUR) keys.add(dateKeyLocal(started))
  }
  return daily.filter((d) => keys.has(dateKeyLocal(d.date)))
}

export interface SuggestionInput {
  daily: readonly DailyTotal[]
  topApp: TopEntry | null
  topDomain: TopEntry | null
  totalSec: number
  totalWebSec: number
  overLimit: readonly OverLimitDay[]
  lateNights: readonly DailyTotal[]
  pendingRequests: number
}

function formatRatio(ratio: number): string {
  return ratio.toLocaleString('vi-VN', { maximumFractionDigits: 1 })
}

function formatPercent(share: number): string {
  return `${Math.round(share * 100)}%`
}

/**
 * Gợi ý theo quy tắc đơn giản, có căn cứ dữ liệu. Trả về mảng rỗng khi
 * không có quy tắc nào khớp — giao diện khi đó nói rõ "các chỉ số đều
 * trong ngưỡng" thay vì gợi ý chung chung.
 */
export function buildSuggestions(input: SuggestionInput): string[] {
  const suggestions: string[] = []

  // Cuối tuần dùng nhiều hơn hẳn ngày thường (trung bình theo ngày có dùng máy).
  const weekdaySecs: number[] = []
  const weekendSecs: number[] = []
  for (const day of input.daily) {
    if (day.totalSec <= 0) continue
    if (day.weekday === 0 || day.weekday === 6) weekendSecs.push(day.totalSec)
    else weekdaySecs.push(day.totalSec)
  }
  if (weekdaySecs.length > 0 && weekendSecs.length > 0) {
    const weekdayAvg = weekdaySecs.reduce((a, b) => a + b, 0) / weekdaySecs.length
    const weekendAvg = weekendSecs.reduce((a, b) => a + b, 0) / weekendSecs.length
    if (weekdayAvg > 0 && weekendAvg >= weekdayAvg * WEEKEND_RATIO_THRESHOLD) {
      suggestions.push(
        `Cuối tuần con dùng trung bình ${formatDurationVi(weekendAvg)} mỗi ngày, gấp ${formatRatio(weekendAvg / weekdayAvg)} lần ngày thường (${formatDurationVi(weekdayAvg)}). Cân nhắc đặt giới hạn riêng cho cuối tuần trong Quy tắc.`,
      )
    }
  }

  // Một domain chiếm tỉ lệ lớn trong thời gian xem web.
  if (input.topDomain && input.topDomain.share >= SHARE_THRESHOLD && input.totalWebSec > 0) {
    suggestions.push(
      `${input.topDomain.name} chiếm ${formatPercent(input.topDomain.share)} thời gian xem web (${formatDurationVi(input.topDomain.totalSec)} trên tổng ${formatDurationVi(input.totalWebSec)}). Cân nhắc đặt giới hạn thời gian cho domain này trong Quy tắc website.`,
    )
  }

  // Một ứng dụng chiếm tỉ lệ lớn trong tổng giờ dùng máy.
  if (input.topApp && input.topApp.share >= SHARE_THRESHOLD && input.totalSec > 0) {
    suggestions.push(
      `${input.topApp.name} chiếm ${formatPercent(input.topApp.share)} tổng giờ dùng máy (${formatDurationVi(input.topApp.totalSec)} trên tổng ${formatDurationVi(input.totalSec)}). Cân nhắc đặt giới hạn thời gian cho ứng dụng này trong Quy tắc ứng dụng.`,
    )
  }

  // Vượt giới hạn nhiều ngày.
  if (input.overLimit.length >= OVER_LIMIT_MIN_DAYS) {
    const days = input.overLimit.map((o) => o.day.fullLabel).join(', ')
    suggestions.push(
      `Con vượt giới hạn giờ/ngày trong ${input.overLimit.length} ngày tuần này (${days}). Cân nhắc xem lại giới hạn giờ/ngày hoặc khung giờ được dùng máy.`,
    )
  }

  // Dùng máy buổi tối muộn nhiều ngày.
  if (input.lateNights.length >= LATE_NIGHT_MIN_DAYS) {
    const days = input.lateNights.map((d) => d.fullLabel).join(', ')
    suggestions.push(
      `Con dùng máy sau ${LATE_NIGHT_HOUR}:00 trong ${input.lateNights.length} ngày tuần này (${days}). Cân nhắc đặt giờ ngủ để máy tự khóa buổi tối.`,
    )
  }

  // Yêu cầu đang chờ duyệt.
  if (input.pendingRequests > 0) {
    suggestions.push(
      `Còn ${input.pendingRequests} yêu cầu đang chờ duyệt. Mở trang Yêu cầu để duyệt hoặc từ chối, tránh để con chờ lâu.`,
    )
  }

  return suggestions
}

// ---------------------------------------------------------------------------
// Tìm kiếm lịch sử web (migration 19 + extension 0.1.10)
// ---------------------------------------------------------------------------

/** Các khoảng ngày cho phép tìm kiếm lịch sử web (tối đa 90 ngày = thời gian giữ). */
export const WEB_HISTORY_RANGES = [7, 30, 90] as const
export type WebHistoryRangeDays = (typeof WEB_HISTORY_RANGES)[number]

/** Nhãn cho ô chọn khoảng: "7 ngày qua", "30 ngày qua", "90 ngày qua". */
export function webHistoryRangeLabel(days: number): string {
  return `${days} ngày qua`
}

/** Đầu khoảng tìm kiếm: `days` × 24 giờ trước `now` (cửa sổ lăn, không cắt theo ngày). */
export function webHistoryRangeStart(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}

export interface WebHistoryFilter {
  /** Chuỗi tìm kiếm: khớp một phần, không phân biệt hoa thường. Rỗng = không lọc. */
  query: string
  /** true = chỉ lượt bị chặn. */
  blockedOnly: boolean
}

/**
 * Lọc lịch sử web ở phía client: chuỗi tìm kiếm khớp một phần (không
 * phân biệt hoa thường) trên tên miền HOẶC đường dẫn; lượt không có
 * đường dẫn chỉ khớp theo tên miền. `blockedOnly` thì chỉ giữ lượt bị
 * chặn. Thứ tự đầu vào được giữ nguyên (mới nhất trước).
 */
export function filterWebHistory(
  visits: readonly WebVisit[],
  filter: WebHistoryFilter,
): WebVisit[] {
  const needle = filter.query.trim().toLowerCase()
  return visits.filter((visit) => {
    if (filter.blockedOnly && !visit.blocked) return false
    if (needle.length === 0) return true
    if (visit.domain.toLowerCase().includes(needle)) return true
    const path = visit.path ?? ''
    return path.length > 0 && path.toLowerCase().includes(needle)
  })
}

// Tên miền an toàn để dựng link mở trang: chỉ nhãn chữ thường/số/gạch
// nối, ít nhất 2 nhãn, mỗi nhãn 1–63 ký tự, không bắt đầu/kết thúc bằng
// gạch nối. Tên miền trong DB do Agent kiểm tra ký tự trước khi gửi,
// nhưng kiểm tra lại ở đây để chuỗi lạ (vd hàng viết tay) không bao giờ
// thành link — giao diện khi đó hiện tên miền dạng chữ thường.
const SAFE_DOMAIN_FOR_LINK =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/** Tên miền có an toàn để mở thành link `https://<domain>` không? */
export function isSafeDomainForLink(domain: string): boolean {
  return SAFE_DOMAIN_FOR_LINK.test(domain.toLowerCase())
}
