// Logic thuần cho cấu hình quy tắc (không phụ thuộc React/Supabase):
// quy ước thứ trong tuần, chuyển đổi giữa config JSONB lưu trong DB và
// trạng thái form (draft), kiểm tra hợp lệ, và nhóm các ngày giống nhau
// để trình bày mô tả tiếng Việt.
//
// Quy ước thứ: khớp `Date.getDay()` và C# `DayOfWeek`: 0 = Chủ nhật,
// 6 = Thứ 7. Thứ tự hiển thị trên form: Thứ 2 trước, Chủ nhật cuối.

export type WeekdayNumber = 0 | 1 | 2 | 3 | 4 | 5 | 6

export interface WeekdayOption {
  value: WeekdayNumber
  label: string
}

export const WEEKDAY_OPTIONS: WeekdayOption[] = [
  { value: 1, label: 'Thứ 2' },
  { value: 2, label: 'Thứ 3' },
  { value: 3, label: 'Thứ 4' },
  { value: 4, label: 'Thứ 5' },
  { value: 5, label: 'Thứ 6' },
  { value: 6, label: 'Thứ 7' },
  { value: 0, label: 'Chủ nhật' },
]

export interface TimeRangeValue {
  start: string
  end: string
}

export type MinutesByWeekday = Partial<Record<WeekdayNumber, number>>
export type WindowsByWeekday = Partial<Record<WeekdayNumber, TimeRangeValue[]>>
export type BedtimeByWeekday = Partial<Record<WeekdayNumber, TimeRangeValue>>

// ---------------------------------------------------------------------------
// Trạng thái form (draft): mọi ô nhập đều giữ dạng chuỗi.
// ---------------------------------------------------------------------------

/** Số phút mỗi ngày, dạng chuỗi; chuỗi rỗng = không giới hạn ngày đó. */
export type DailyLimitDraft = Record<WeekdayNumber, string>

/** Danh sách khung giờ mỗi ngày; mảng rỗng = không được dùng máy ngày đó. */
export type TimeWindowDraft = Record<WeekdayNumber, TimeRangeValue[]>

export interface BedtimeDayDraft {
  enabled: boolean
  start: string
  end: string
}

export type BedtimeDraft = Record<WeekdayNumber, BedtimeDayDraft>

export function emptyDailyLimitDraft(): DailyLimitDraft {
  return { 0: '', 1: '', 2: '', 3: '', 4: '', 5: '', 6: '' }
}

export function emptyTimeWindowDraft(): TimeWindowDraft {
  return { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }
}

export function emptyBedtimeDraft(): BedtimeDraft {
  const day = (): BedtimeDayDraft => ({ enabled: false, start: '21:00', end: '07:00' })
  return { 0: day(), 1: day(), 2: day(), 3: day(), 4: day(), 5: day(), 6: day() }
}

// ---------------------------------------------------------------------------
// Giờ "HH:MM"
// ---------------------------------------------------------------------------

export function isValidHHmm(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

export function hhmmToMinutes(value: string): number {
  const [h, m] = value.split(':')
  return Number(h) * 60 + Number(m)
}

// ---------------------------------------------------------------------------
// Đọc config JSONB đã lưu (kèm tương thích hình dạng cũ) -> dạng chuẩn.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asNonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
  return value
}

function asTimeRange(value: unknown): TimeRangeValue | null {
  const record = asRecord(value)
  if (!record) return null
  const start = record['start']
  const end = record['end']
  if (typeof start !== 'string' || typeof end !== 'string') return null
  if (!isValidHHmm(start) || !isValidHHmm(end)) return null
  return { start, end }
}

function weekdayKey(day: WeekdayNumber): string {
  return String(day)
}

/**
 * Đọc config daily_limit. Hình dạng mới `minutesByWeekday` được ưu tiên;
 * hình dạng cũ (`minutes_per_day` / `daily_minutes` / `minutes`) được hiểu
 * là cùng một giới hạn cho mọi ngày trong tuần.
 */
export function parseDailyLimitConfig(config: Record<string, unknown>): MinutesByWeekday {
  const byWeekday = asRecord(config['minutesByWeekday'])
  if (byWeekday) {
    const result: MinutesByWeekday = {}
    for (const { value } of WEEKDAY_OPTIONS) {
      const minutes = asNonNegativeInt(byWeekday[weekdayKey(value)])
      if (minutes !== null) result[value] = minutes
    }
    return result
  }
  for (const key of ['minutes_per_day', 'daily_minutes', 'minutes', 'limit_minutes']) {
    const minutes = asNonNegativeInt(config[key])
    if (minutes !== null) {
      const result: MinutesByWeekday = {}
      for (const { value } of WEEKDAY_OPTIONS) result[value] = minutes
      return result
    }
  }
  return {}
}

export function parseTimeWindowConfig(config: Record<string, unknown>): WindowsByWeekday {
  const byWeekday = asRecord(config['windowsByWeekday'])
  if (!byWeekday) return {}
  const result: WindowsByWeekday = {}
  for (const { value } of WEEKDAY_OPTIONS) {
    const raw = byWeekday[weekdayKey(value)]
    if (!Array.isArray(raw)) continue
    const ranges: TimeRangeValue[] = []
    for (const item of raw) {
      const range = asTimeRange(item)
      if (range) ranges.push(range)
    }
    if (ranges.length > 0) result[value] = ranges
  }
  return result
}

/**
 * Đọc config bedtime. Hình dạng mới `bedtimeByWeekday` được ưu tiên;
 * hình dạng cũ `{"start","end"}` được hiểu là cùng một khung giờ cấm
 * cho mọi ngày trong tuần.
 */
export function parseBedtimeConfig(config: Record<string, unknown>): BedtimeByWeekday {
  const byWeekday = asRecord(config['bedtimeByWeekday'])
  if (byWeekday) {
    const result: BedtimeByWeekday = {}
    for (const { value } of WEEKDAY_OPTIONS) {
      const range = asTimeRange(byWeekday[weekdayKey(value)])
      if (range) result[value] = range
    }
    return result
  }
  const legacy = asTimeRange(config)
  if (legacy) {
    const result: BedtimeByWeekday = {}
    for (const { value } of WEEKDAY_OPTIONS) result[value] = { ...legacy }
    return result
  }
  return {}
}

// ---------------------------------------------------------------------------
// Chuyển đổi giữa dạng chuẩn và draft (để sửa rule đã có).
// ---------------------------------------------------------------------------

export function dailyLimitConfigToDraft(config: MinutesByWeekday): DailyLimitDraft {
  const draft = emptyDailyLimitDraft()
  for (const { value } of WEEKDAY_OPTIONS) {
    const minutes = config[value]
    if (minutes !== undefined) draft[value] = String(minutes)
  }
  return draft
}

export function timeWindowConfigToDraft(config: WindowsByWeekday): TimeWindowDraft {
  const draft = emptyTimeWindowDraft()
  for (const { value } of WEEKDAY_OPTIONS) {
    const ranges = config[value]
    if (ranges) draft[value] = ranges.map((r) => ({ ...r }))
  }
  return draft
}

export function bedtimeConfigToDraft(config: BedtimeByWeekday): BedtimeDraft {
  const draft = emptyBedtimeDraft()
  for (const { value } of WEEKDAY_OPTIONS) {
    const range = config[value]
    if (range) draft[value] = { enabled: true, start: range.start, end: range.end }
  }
  return draft
}

// ---------------------------------------------------------------------------
// Kiểm tra hợp lệ + chuyển draft -> config JSONB để ghi vào DB.
// Trả về null khi hợp lệ, ngược lại trả về thông báo lỗi tiếng Việt.
// ---------------------------------------------------------------------------

export function validateDailyLimitDraft(draft: DailyLimitDraft): string | null {
  let filled = 0
  for (const { value, label } of WEEKDAY_OPTIONS) {
    const text = draft[value].trim()
    if (text === '') continue
    filled += 1
    const minutes = Number(text)
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
      return `${label}: số phút phải là số nguyên từ 0 đến 1440 (24 giờ). Để trống nếu không giới hạn ngày đó.`
    }
  }
  if (filled === 0) return 'Hãy nhập số phút cho ít nhất một ngày trong tuần.'
  return null
}

export function dailyLimitDraftToConfig(draft: DailyLimitDraft): { minutesByWeekday: MinutesByWeekday } {
  const minutesByWeekday: MinutesByWeekday = {}
  for (const { value } of WEEKDAY_OPTIONS) {
    const text = draft[value].trim()
    if (text !== '') minutesByWeekday[value] = Number(text)
  }
  return { minutesByWeekday }
}

export function validateTimeWindowDraft(draft: TimeWindowDraft): string | null {
  let total = 0
  for (const { value, label } of WEEKDAY_OPTIONS) {
    for (const range of draft[value]) {
      total += 1
      if (!isValidHHmm(range.start) || !isValidHHmm(range.end)) {
        return `${label}: giờ bắt đầu và giờ kết thúc phải đúng định dạng HH:MM.`
      }
      if (hhmmToMinutes(range.start) >= hhmmToMinutes(range.end)) {
        return `${label}: giờ bắt đầu (${range.start}) phải sớm hơn giờ kết thúc (${range.end}). Khung giờ qua đêm thuộc về quy tắc giờ ngủ.`
      }
    }
  }
  if (total === 0) return 'Hãy thêm ít nhất một khung giờ cho một ngày trong tuần.'
  return null
}

export function timeWindowDraftToConfig(draft: TimeWindowDraft): { windowsByWeekday: WindowsByWeekday } {
  const windowsByWeekday: WindowsByWeekday = {}
  for (const { value } of WEEKDAY_OPTIONS) {
    if (draft[value].length > 0) {
      windowsByWeekday[value] = draft[value].map((r) => ({ start: r.start, end: r.end }))
    }
  }
  return { windowsByWeekday }
}

export function validateBedtimeDraft(draft: BedtimeDraft): string | null {
  let enabled = 0
  for (const { value, label } of WEEKDAY_OPTIONS) {
    const day = draft[value]
    if (!day.enabled) continue
    enabled += 1
    if (!isValidHHmm(day.start) || !isValidHHmm(day.end)) {
      return `${label}: giờ bắt đầu và giờ kết thúc phải đúng định dạng HH:MM.`
    }
    if (day.start === day.end) {
      return `${label}: giờ bắt đầu và giờ kết thúc không được trùng nhau.`
    }
  }
  if (enabled === 0) return 'Hãy bật giờ ngủ cho ít nhất một ngày trong tuần.'
  return null
}

export function bedtimeDraftToConfig(draft: BedtimeDraft): { bedtimeByWeekday: BedtimeByWeekday } {
  const bedtimeByWeekday: BedtimeByWeekday = {}
  for (const { value } of WEEKDAY_OPTIONS) {
    const day = draft[value]
    if (day.enabled) bedtimeByWeekday[value] = { start: day.start, end: day.end }
  }
  return { bedtimeByWeekday }
}

// ---------------------------------------------------------------------------
// Nhóm các ngày liên tiếp có cùng giá trị, để mô tả gọn ("Thứ 2–6: ...").
// ---------------------------------------------------------------------------

export interface WeekdayGroup<T> {
  days: WeekdayNumber[]
  value: T
}

/**
 * Nhóm các ngày theo thứ tự hiển thị (Thứ 2..Chủ nhật). Các ngày liên tiếp
 * có cùng `keyOf(value)` được gộp thành một nhóm.
 */
export function groupWeekdays<T>(
  values: Record<WeekdayNumber, T>,
  keyOf: (value: T) => string,
): Array<WeekdayGroup<T>> {
  const groups: Array<WeekdayGroup<T>> = []
  for (const { value } of WEEKDAY_OPTIONS) {
    const dayValue = values[value]
    const last = groups[groups.length - 1]
    if (last && keyOf(last.value) === keyOf(dayValue)) {
      last.days.push(value)
    } else {
      groups.push({ days: [value], value: dayValue })
    }
  }
  return groups
}

/** Trình bày một nhóm ngày liên tiếp: "Thứ 2–6", "Thứ 7–Chủ nhật", "Chủ nhật". */
export function formatWeekdayGroup(days: WeekdayNumber[]): string {
  if (days.length === 0) return ''
  const labelOf = (day: WeekdayNumber): string =>
    WEEKDAY_OPTIONS.find((o) => o.value === day)?.label ?? ''
  if (days.length === 1) return labelOf(days[0])
  const first = days[0]
  const last = days[days.length - 1]
  const endLabel = last === 0 ? 'Chủ nhật' : String(last + 1)
  return `${labelOf(first)}–${endLabel}`
}

// ---------------------------------------------------------------------------
// Quy tắc website (đợt 2): một dòng rule type='website' mang đúng 1 chế độ
// (mode), lưu trong config JSONB dạng {"mode": ..., ...}. Các hình dạng
// config dưới đây dùng `type` (không dùng `interface`) để gán được trực
// tiếp vào `Record<string, unknown>` khi ghi xuống DB (xem RulesPage).
// ---------------------------------------------------------------------------

export type WebsiteMode =
  | 'block_domains'
  | 'block_domains_by_time'
  | 'allowlist'
  | 'allowlist_by_time'
  | 'domain_time_limit'
  | 'safe_search'
  | 'focus'

export interface WebsiteModeOption {
  value: WebsiteMode
  label: string
}

export const WEBSITE_MODE_OPTIONS: WebsiteModeOption[] = [
  { value: 'block_domains', label: 'Chặn website' },
  { value: 'block_domains_by_time', label: 'Chặn website theo giờ' },
  { value: 'allowlist', label: 'Chỉ cho phép một số website' },
  { value: 'allowlist_by_time', label: 'Chỉ cho phép một số website theo giờ' },
  { value: 'domain_time_limit', label: 'Giới hạn thời gian theo website' },
  { value: 'safe_search', label: 'Tìm kiếm an toàn (SafeSearch / YouTube)' },
  { value: 'focus', label: 'Giờ học tập trung' },
]

/** Chặn các domain trong danh sách (kể cả tên miền con). */
export type BlockDomainsConfig = {
  mode: 'block_domains'
  domains: string[]
}

/** Chặn các domain trong danh sách, chỉ trong các khung giờ theo thứ. */
export type BlockDomainsByTimeConfig = {
  mode: 'block_domains_by_time'
  domains: string[]
  windowsByWeekday: WindowsByWeekday
}

/** Chỉ cho phép các domain trong danh sách; mọi website khác đều bị chặn. */
export type AllowlistConfig = {
  mode: 'allowlist'
  domains: string[]
}

/**
 * Chỉ cho phép các domain trong danh sách, chỉ trong các khung giờ theo
 * thứ (khung giờ = thời gian danh sách cho phép có hiệu lực, giờ địa
 * phương của máy con). Ngoài khung giờ, quy tắc không giới hạn website
 * nào. Ngày nào không có khung giờ nào thì ngày đó không giới hạn.
 */
export type AllowlistByTimeConfig = {
  mode: 'allowlist_by_time'
  domains: string[]
  windowsByWeekday: WindowsByWeekday
}

/** Tổng số phút mỗi ngày cho tất cả các domain trong danh sách cộng lại. */
export type DomainTimeLimitConfig = {
  mode: 'domain_time_limit'
  domains: string[]
  minutes_per_day: number
}

/** Ép SafeSearch / chế độ hạn chế của YouTube. Cả hai đều mặc định bật khi rule tồn tại. */
export type SafeSearchConfig = {
  mode: 'safe_search'
  searchProviders: boolean
  youtubeRestricted: boolean
}

/**
 * Giờ học tập trung: trong các khung giờ theo thứ, chỉ các website trong
 * `allowedDomains` (do extension thi hành) và các ứng dụng trong
 * `allowedApps` (do Agent đóng các ứng dụng còn lại) mới mở được.
 * Thứ tự ưu tiên: chặn tạm thời thắng danh sách cho phép của focus;
 * cho phép tạm thời KHÔNG mở được website ngoài danh sách trong giờ tập trung.
 */
export type FocusConfig = {
  mode: 'focus'
  windowsByWeekday: WindowsByWeekday
  allowedApps: AppEntry[]
  allowedDomains: string[]
}

export type WebsiteConfig =
  | BlockDomainsConfig
  | BlockDomainsByTimeConfig
  | AllowlistConfig
  | AllowlistByTimeConfig
  | DomainTimeLimitConfig
  | SafeSearchConfig
  | FocusConfig

// ---------------------------------------------------------------------------
// Quy tắc ứng dụng (đợt 3): một dòng rule type='app' mang đúng 1 chế độ
// (mode), lưu trong config JSONB dạng {"mode": ..., ...}. Giống quy tắc
// website, các hình dạng config dưới đây dùng `type` (không dùng
// `interface`) để gán được trực tiếp vào `Record<string, unknown>`.
// ---------------------------------------------------------------------------

export type AppMode =
  | 'app_time_limit'
  | 'app_block'
  | 'app_block_by_time'
  | 'app_allowlist'
  | 'app_allowlist_by_time'
  | 'forced_break'

export interface AppModeOption {
  value: AppMode
  label: string
}

export const APP_MODE_OPTIONS: AppModeOption[] = [
  { value: 'app_time_limit', label: 'Giới hạn thời gian theo ứng dụng' },
  { value: 'app_block', label: 'Chặn ứng dụng' },
  { value: 'app_block_by_time', label: 'Chặn ứng dụng theo giờ' },
  { value: 'app_allowlist', label: 'Chỉ cho phép một số ứng dụng' },
  { value: 'app_allowlist_by_time', label: 'Chỉ cho phép một số ứng dụng theo giờ' },
  { value: 'forced_break', label: 'Nghỉ bắt buộc' },
]

/** Một ứng dụng, nhận dạng bằng tên file .exe; `name` chỉ để hiển thị. */
export type AppEntry = {
  exe: string
  name: string
}

/** Một ứng dụng kèm giới hạn số phút mỗi ngày. */
export type AppTimeLimitEntry = {
  exe: string
  name: string
  minutesPerDay: number
}

/** Giới hạn số phút mỗi ngày cho từng ứng dụng trong danh sách. */
export type AppTimeLimitConfig = {
  mode: 'app_time_limit'
  apps: AppTimeLimitEntry[]
}

/**
 * Chặn các ứng dụng trong danh sách NGOÀI các khung giờ theo thứ (khung
 * giờ = thời gian được phép dùng). Ngày nào không có khung giờ nào thì
 * các ứng dụng trên bị chặn cả ngày.
 */
export type AppBlockByTimeConfig = {
  mode: 'app_block_by_time'
  apps: AppEntry[]
  windowsByWeekday: WindowsByWeekday
}

/** Chặn các ứng dụng trong danh sách mọi lúc (cho đến khi tắt quy tắc). */
export type AppBlockConfig = {
  mode: 'app_block'
  apps: AppEntry[]
}

/**
 * Chỉ cho phép các ứng dụng trong danh sách; mọi ứng dụng khác đều bị
 * đóng (trừ các tiến trình hệ thống trong denylist của Agent).
 */
export type AppAllowlistConfig = {
  mode: 'app_allowlist'
  apps: AppEntry[]
}

/**
 * Chỉ cho phép các ứng dụng trong danh sách, chỉ trong các khung giờ theo
 * thứ (khung giờ = thời gian danh sách cho phép có hiệu lực, giờ địa
 * phương của máy con). Ngoài khung giờ, quy tắc không đóng ứng dụng nào.
 * Ngày nào không có khung giờ nào thì ngày đó không giới hạn.
 */
export type AppAllowlistByTimeConfig = {
  mode: 'app_allowlist_by_time'
  apps: AppEntry[]
  windowsByWeekday: WindowsByWeekday
}

/** Dùng máy liên tục đủ `workMinutes` thì khóa máy trong `breakMinutes`. */
export type ForcedBreakConfig = {
  mode: 'forced_break'
  workMinutes: number
  breakMinutes: number
}

export type AppConfig =
  | AppTimeLimitConfig
  | AppBlockConfig
  | AppBlockByTimeConfig
  | AppAllowlistConfig
  | AppAllowlistByTimeConfig
  | ForcedBreakConfig

// ---------------------------------------------------------------------------
// Domain: chuẩn hoá + kiểm tra hợp lệ.
// ---------------------------------------------------------------------------

/**
 * Chuẩn hoá một mục nhập thành hostname: chữ thường, bỏ scheme (http://,
 * https://), chỉ lấy hostname khi người dùng dán cả URL (bỏ path/query/
 * fragment và userinfo), bỏ dấu chấm ở đầu/cuối. Hàm này không kiểm tra
 * tính hợp lệ — xem `domainError`.
 */
export function normalizeDomain(raw: string): string {
  let host = raw.trim()
  const schemeIndex = host.indexOf('://')
  if (schemeIndex >= 0) host = host.slice(schemeIndex + 3)
  else if (host.startsWith('//')) host = host.slice(2)
  const cutAt = host.search(/[/?#]/)
  if (cutAt >= 0) host = host.slice(0, cutAt)
  const atIndex = host.lastIndexOf('@')
  if (atIndex >= 0) host = host.slice(atIndex + 1)
  if (host.startsWith('.')) host = host.slice(1)
  if (host.endsWith('.')) host = host.slice(0, -1)
  return host.toLowerCase()
}

const DOMAIN_LABEL_PATTERN = /^[a-z0-9-]+$/

/**
 * Kiểm tra một hostname ĐÃ chuẩn hoá bằng `normalizeDomain`. Trả về null
 * khi hợp lệ, ngược lại trả về thông báo lỗi tiếng Việt (không kèm tên
 * domain — nơi gọi sẽ gắn tên mục nhập vào).
 *
 * QUYẾT ĐỊNH: địa chỉ IP (vd 192.168.1.1) bị từ chối — quy tắc website
 * hoạt động theo hostname (extension so khớp tên miền, kể cả tên miền
 * con); chặn theo IP vừa dễ bị vượt qua (IP của một trang có thể đổi)
 * vừa không khớp với thứ phụ huynh nhìn thấy trên trình duyệt.
 * Tên miền 1 nhãn (không có dấu chấm, vd "youtube") cũng bị từ chối vì
 * gần như luôn là nhập thiếu — phụ huynh cần gõ đủ tên miền.
 */
export function domainError(domain: string): string | null {
  if (domain === '') return 'Domain không được để trống.'
  if (/\s/.test(domain)) return 'Domain không được chứa khoảng trắng.'
  if (domain.includes('*')) {
    return 'Domain không được chứa ký tự đại diện (*). Hãy gõ tên miền đầy đủ, ví dụ youtube.com.'
  }
  if (domain.includes(':')) {
    return 'Domain không được chứa cổng (ví dụ :8080). Chỉ nhập tên miền, ví dụ youtube.com.'
  }
  if (/[^a-z0-9.-]/.test(domain)) {
    return 'Domain chỉ gồm chữ cái, chữ số, dấu gạch ngang (-) và dấu chấm (.).'
  }
  if (domain.length > 253) return 'Domain quá dài (tối đa 253 ký tự).'
  if (!domain.includes('.')) return 'Domain phải có ít nhất một dấu chấm, ví dụ youtube.com.'
  const labels = domain.split('.')
  if (labels.every((label) => /^\d+$/.test(label))) {
    return 'Đây là địa chỉ IP, không phải tên miền. Quy tắc website chỉ áp dụng cho tên miền (ví dụ youtube.com).'
  }
  for (const label of labels) {
    if (label === '') return 'Domain không được chứa dấu chấm liên tiếp.'
    if (label.length > 63) return 'Mỗi phần của domain (giữa các dấu chấm) tối đa 63 ký tự.'
    if (!DOMAIN_LABEL_PATTERN.test(label) || label.startsWith('-') || label.endsWith('-')) {
      return 'Mỗi phần của domain chỉ gồm chữ cái, chữ số và dấu gạch ngang, không bắt đầu hoặc kết thúc bằng dấu gạch ngang.'
    }
  }
  return null
}

export interface ParsedDomains {
  domains: string[]
  error: string | null
}

/**
 * Tách chuỗi nhập thành danh sách domain đã chuẩn hoá, loại trùng (giữ
 * thứ tự nhập). Định dạng chính thức là mỗi dòng một domain; dấu phẩy
 * cũng được chấp nhận để tiện dán danh sách. Gặp mục nhập không hợp lệ
 * thì dừng và trả về lỗi kèm đúng mục đó; danh sách rỗng cũng là lỗi.
 */
export function parseDomainsInput(text: string): ParsedDomains {
  const seen = new Set<string>()
  const domains: string[] = []
  for (const rawEntry of text.split(/[\r\n,]+/)) {
    const raw = rawEntry.trim()
    if (raw === '') continue
    const normalized = normalizeDomain(raw)
    const error = domainError(normalized)
    if (error) return { domains: [], error: `“${raw}”: ${error}` }
    if (!seen.has(normalized)) {
      seen.add(normalized)
      domains.push(normalized)
    }
  }
  if (domains.length === 0) return { domains: [], error: 'Hãy nhập ít nhất một domain.' }
  return { domains, error: null }
}

export function validateWebsiteDomainsText(text: string): string | null {
  return parseDomainsInput(text).error
}

// ---------------------------------------------------------------------------
// Đọc config website đã lưu (kèm tương thích hình dạng cũ) -> dạng chuẩn.
// Trả về null khi không nhận dạng được (mode lạ và không có domain nào).
// ---------------------------------------------------------------------------

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * Đọc danh sách domain từ config đã lưu, chỉ giữ các domain hợp lệ (đọc
 * khoan dung để phần mô tả/sửa không vỡ khi gặp dữ liệu cũ hoặc lạ).
 * Hình dạng cũ `{"domain": "..."}` (1 domain) được hiểu như danh sách
 * 1 phần tử; khóa `domain` chỉ dùng khi không có mảng `domains`.
 * Tham số `key` cho phép đọc khóa khác (vd `allowedDomains` của chế độ
 * focus); khóa khác `domains` thì không áp dụng tương thích hình dạng cũ.
 */
function readStoredDomains(config: Record<string, unknown>, key = 'domains'): string[] {
  const rawEntries = asStringArray(config[key])
  if (rawEntries.length === 0 && key === 'domains') {
    for (const legacyKey of ['domain', 'website', 'url', 'host']) {
      const single = config[legacyKey]
      if (typeof single === 'string') rawEntries.push(single)
    }
  }
  const seen = new Set<string>()
  const domains: string[] = []
  for (const raw of rawEntries) {
    const normalized = normalizeDomain(raw)
    if (domainError(normalized) === null && !seen.has(normalized)) {
      seen.add(normalized)
      domains.push(normalized)
    }
  }
  return domains
}

/**
 * Đọc danh sách ứng dụng từ config đã lưu (khóa `apps` hoặc khóa khác do
 * nơi gọi truyền vào), khoan dung: mục nhập là chuỗi thì hiểu là tên exe;
 * mục nhập là object thì đọc `exe`/`name`; mục thiếu exe thì bỏ qua; tên
 * hiển thị trống thì lấy theo tên exe. Không kiểm tra ký tự cấm ở đây —
 * dữ liệu đã lưu được hiển thị/sửa lại, kiểm tra chặt chỉ áp dụng khi lưu.
 */
function readStoredApps(config: Record<string, unknown>, key = 'apps'): AppEntry[] {
  const raw = config[key]
  if (!Array.isArray(raw)) return []
  const apps: AppEntry[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const exe = item.trim()
      if (exe !== '') apps.push({ exe, name: exe })
      continue
    }
    const record = asRecord(item)
    if (!record) continue
    const exeRaw = record['exe']
    if (typeof exeRaw !== 'string') continue
    const exe = exeRaw.trim()
    if (exe === '') continue
    const nameRaw = record['name']
    const name = typeof nameRaw === 'string' && nameRaw.trim() !== '' ? nameRaw.trim() : exe
    apps.push({ exe, name })
  }
  return apps
}

function asBooleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

const WEBSITE_MODES: WebsiteMode[] = [
  'block_domains',
  'block_domains_by_time',
  'allowlist',
  'allowlist_by_time',
  'domain_time_limit',
  'safe_search',
  'focus',
]

const APP_MODES: AppMode[] = [
  'app_time_limit',
  'app_block',
  'app_block_by_time',
  'app_allowlist',
  'app_allowlist_by_time',
  'forced_break',
]

export function parseWebsiteConfig(config: Record<string, unknown>): WebsiteConfig | null {
  const modeRaw = config['mode']
  const domains = readStoredDomains(config)
  if (typeof modeRaw === 'string') {
    if (!WEBSITE_MODES.includes(modeRaw as WebsiteMode)) return null
    const mode = modeRaw as WebsiteMode
    switch (mode) {
      case 'block_domains':
        return { mode, domains }
      case 'block_domains_by_time':
        return { mode, domains, windowsByWeekday: parseTimeWindowConfig(config) }
      case 'allowlist':
        return { mode, domains }
      case 'allowlist_by_time':
        return { mode, domains, windowsByWeekday: parseTimeWindowConfig(config) }
      case 'domain_time_limit': {
        const minutes =
          asNonNegativeInt(config['minutes_per_day']) ?? asNonNegativeInt(config['minutes']) ?? 0
        return { mode, domains, minutes_per_day: minutes }
      }
      case 'safe_search':
        return {
          mode,
          searchProviders: asBooleanOr(config['searchProviders'], true),
          youtubeRestricted: asBooleanOr(config['youtubeRestricted'], true),
        }
      case 'focus':
        return {
          mode,
          windowsByWeekday: parseTimeWindowConfig(config),
          allowedApps: readStoredApps(config, 'allowedApps'),
          allowedDomains: readStoredDomains(config, 'allowedDomains'),
        }
    }
  }
  // Không có mode: hình dạng cũ (1 domain + action) hoặc mảng domains trần.
  // `action: "allow"` cũ được hiểu như allowlist 1 domain; còn lại là chặn.
  if (domains.length === 0) return null
  if (config['action'] === 'allow') return { mode: 'allowlist', domains }
  return { mode: 'block_domains', domains }
}

// ---------------------------------------------------------------------------
// Đọc config ứng dụng đã lưu -> dạng chuẩn. Trả về null khi mode lạ hoặc
// không có mode (hình dạng cũ của rule app không có mode chuẩn nên phần
// mô tả sẽ dùng câu chung chung thay vì đoán).
// ---------------------------------------------------------------------------

export function parseAppConfig(config: Record<string, unknown>): AppConfig | null {
  const modeRaw = config['mode']
  if (typeof modeRaw !== 'string' || !APP_MODES.includes(modeRaw as AppMode)) return null
  const mode = modeRaw as AppMode
  switch (mode) {
    case 'app_time_limit': {
      const apps: AppTimeLimitEntry[] = []
      const raw = config['apps']
      if (Array.isArray(raw)) {
        for (const item of raw) {
          const record = asRecord(item)
          if (!record) continue
          const exeRaw = record['exe']
          if (typeof exeRaw !== 'string' || exeRaw.trim() === '') continue
          const exe = exeRaw.trim()
          const nameRaw = record['name']
          const name = typeof nameRaw === 'string' && nameRaw.trim() !== '' ? nameRaw.trim() : exe
          const minutesPerDay = asNonNegativeInt(record['minutesPerDay']) ?? 0
          apps.push({ exe, name, minutesPerDay })
        }
      }
      return { mode, apps }
    }
    case 'app_block_by_time':
      return { mode, apps: readStoredApps(config), windowsByWeekday: parseTimeWindowConfig(config) }
    case 'app_block':
      return { mode, apps: readStoredApps(config) }
    case 'app_allowlist':
      return { mode, apps: readStoredApps(config) }
    case 'app_allowlist_by_time':
      return { mode, apps: readStoredApps(config), windowsByWeekday: parseTimeWindowConfig(config) }
    case 'forced_break':
      return {
        mode,
        workMinutes: asNonNegativeInt(config['workMinutes']) ?? 0,
        breakMinutes: asNonNegativeInt(config['breakMinutes']) ?? 0,
      }
  }
}

// ---------------------------------------------------------------------------
// Trạng thái form (draft) cho quy tắc website.
// ---------------------------------------------------------------------------

export interface WebsiteDomainsDraft {
  domainsText: string
}

export interface BlockDomainsByTimeDraft {
  domainsText: string
  windows: TimeWindowDraft
}

/**
 * Draft cho chế độ chỉ cho phép một số website theo giờ: cùng hình dạng
 * với BlockDomainsByTimeDraft (danh sách domain + khung giờ theo thứ),
 * nhưng khung giờ là thời gian danh sách cho phép có hiệu lực.
 */
export interface AllowlistByTimeDraft {
  domainsText: string
  windows: TimeWindowDraft
}

export interface DomainTimeLimitDraft {
  domainsText: string
  minutes: string
}

export interface SafeSearchDraft {
  searchProviders: boolean
  youtubeRestricted: boolean
}

/** Draft cho chế độ giờ học tập trung: khung giờ + domain được phép + app được phép. */
export interface FocusDraft {
  windows: TimeWindowDraft
  allowedDomainsText: string
  apps: Array<{ exe: string; name: string }>
}

export function emptyWebsiteDomainsDraft(): WebsiteDomainsDraft {
  return { domainsText: '' }
}

export function emptyBlockDomainsByTimeDraft(): BlockDomainsByTimeDraft {
  return { domainsText: '', windows: emptyTimeWindowDraft() }
}

export function emptyAllowlistByTimeDraft(): AllowlistByTimeDraft {
  return { domainsText: '', windows: emptyTimeWindowDraft() }
}

export function emptyDomainTimeLimitDraft(): DomainTimeLimitDraft {
  return { domainsText: '', minutes: '30' }
}

export function emptySafeSearchDraft(): SafeSearchDraft {
  return { searchProviders: true, youtubeRestricted: true }
}

/** Draft focus trống: một dòng ứng dụng trống để phụ huynh gõ ngay. */
export function emptyFocusDraft(): FocusDraft {
  return { windows: emptyTimeWindowDraft(), allowedDomainsText: '', apps: [{ exe: '', name: '' }] }
}

export function websiteConfigToDomainsDraft(config: WebsiteConfig | null): WebsiteDomainsDraft {
  if (!config || config.mode === 'safe_search' || config.mode === 'focus') {
    return emptyWebsiteDomainsDraft()
  }
  return { domainsText: config.domains.join('\n') }
}

export function websiteConfigToBlockByTimeDraft(config: WebsiteConfig | null): BlockDomainsByTimeDraft {
  const draft = emptyBlockDomainsByTimeDraft()
  if (!config || config.mode === 'safe_search' || config.mode === 'focus') return draft
  draft.domainsText = config.domains.join('\n')
  if (config.mode === 'block_domains_by_time') {
    draft.windows = timeWindowConfigToDraft(config.windowsByWeekday)
  }
  return draft
}

export function websiteConfigToAllowlistByTimeDraft(
  config: WebsiteConfig | null,
): AllowlistByTimeDraft {
  const draft = emptyAllowlistByTimeDraft()
  if (!config || config.mode === 'safe_search' || config.mode === 'focus') return draft
  draft.domainsText = config.domains.join('\n')
  if (config.mode === 'allowlist_by_time') {
    draft.windows = timeWindowConfigToDraft(config.windowsByWeekday)
  }
  return draft
}

export function websiteConfigToTimeLimitDraft(config: WebsiteConfig | null): DomainTimeLimitDraft {
  const draft = emptyDomainTimeLimitDraft()
  if (!config || config.mode === 'safe_search' || config.mode === 'focus') return draft
  draft.domainsText = config.domains.join('\n')
  if (config.mode === 'domain_time_limit' && config.minutes_per_day > 0) {
    draft.minutes = String(config.minutes_per_day)
  }
  return draft
}

export function websiteConfigToSafeSearchDraft(config: WebsiteConfig | null): SafeSearchDraft {
  if (config?.mode === 'safe_search') {
    return { searchProviders: config.searchProviders, youtubeRestricted: config.youtubeRestricted }
  }
  return emptySafeSearchDraft()
}

export function websiteConfigToFocusDraft(config: WebsiteConfig | null): FocusDraft {
  const draft = emptyFocusDraft()
  if (config?.mode !== 'focus') return draft
  draft.windows = timeWindowConfigToDraft(config.windowsByWeekday)
  draft.allowedDomainsText = config.allowedDomains.join('\n')
  if (config.allowedApps.length > 0) {
    draft.apps = config.allowedApps.map((app) => ({ exe: app.exe, name: app.name }))
  }
  return draft
}

// ---------------------------------------------------------------------------
// Kiểm tra hợp lệ + chuyển draft -> config JSONB để ghi vào DB.
// Các hàm build* giả định draft đã qua kiểm tra (quy ước như đợt 1).
// ---------------------------------------------------------------------------

export function buildBlockDomainsConfig(domainsText: string): BlockDomainsConfig {
  return { mode: 'block_domains', domains: parseDomainsInput(domainsText).domains }
}

export function buildAllowlistConfig(domainsText: string): AllowlistConfig {
  return { mode: 'allowlist', domains: parseDomainsInput(domainsText).domains }
}

export function validateBlockDomainsByTimeDraft(draft: BlockDomainsByTimeDraft): string | null {
  const domainsError = validateWebsiteDomainsText(draft.domainsText)
  if (domainsError) return domainsError
  return validateTimeWindowDraft(draft.windows)
}

export function buildBlockDomainsByTimeConfig(draft: BlockDomainsByTimeDraft): BlockDomainsByTimeConfig {
  return {
    mode: 'block_domains_by_time',
    domains: parseDomainsInput(draft.domainsText).domains,
    windowsByWeekday: timeWindowDraftToConfig(draft.windows).windowsByWeekday,
  }
}

export function validateAllowlistByTimeDraft(draft: AllowlistByTimeDraft): string | null {
  const domainsError = validateWebsiteDomainsText(draft.domainsText)
  if (domainsError) return domainsError
  return validateTimeWindowDraft(draft.windows)
}

export function buildAllowlistByTimeConfig(draft: AllowlistByTimeDraft): AllowlistByTimeConfig {
  return {
    mode: 'allowlist_by_time',
    domains: parseDomainsInput(draft.domainsText).domains,
    windowsByWeekday: timeWindowDraftToConfig(draft.windows).windowsByWeekday,
  }
}

export function validateDomainTimeLimitDraft(draft: DomainTimeLimitDraft): string | null {
  const domainsError = validateWebsiteDomainsText(draft.domainsText)
  if (domainsError) return domainsError
  const text = draft.minutes.trim()
  if (text === '') return 'Hãy nhập số phút giới hạn mỗi ngày.'
  const minutes = Number(text)
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    return 'Số phút phải là số nguyên từ 1 đến 1440 (24 giờ).'
  }
  return null
}

export function buildDomainTimeLimitConfig(draft: DomainTimeLimitDraft): DomainTimeLimitConfig {
  return {
    mode: 'domain_time_limit',
    domains: parseDomainsInput(draft.domainsText).domains,
    minutes_per_day: Number(draft.minutes.trim()),
  }
}

export function buildSafeSearchConfig(draft: SafeSearchDraft): SafeSearchConfig {
  return {
    mode: 'safe_search',
    searchProviders: draft.searchProviders,
    youtubeRestricted: draft.youtubeRestricted,
  }
}

// ---------------------------------------------------------------------------
// Giờ học tập trung (focus): kiểm tra hợp lệ + chuyển draft -> config.
// Danh sách ứng dụng được phép KHÔNG được để trống: trong giờ tập trung,
// Agent đóng mọi ứng dụng ngoài danh sách, nên danh sách trống sẽ đóng
// tất cả các ứng dụng.
// ---------------------------------------------------------------------------

export function validateFocusDraft(draft: FocusDraft): string | null {
  const windowsError = validateTimeWindowDraft(draft.windows)
  if (windowsError) return windowsError
  const domainsError = validateWebsiteDomainsText(draft.allowedDomainsText)
  if (domainsError) return domainsError
  const appsError = validateAppRows(
    draft.apps,
    'Hãy thêm ít nhất một ứng dụng được phép. Trong giờ học tập trung, mọi ứng dụng ngoài danh sách đều bị đóng, nên danh sách trống sẽ đóng tất cả các ứng dụng.',
  )
  if (appsError) return appsError
  return null
}

export function buildFocusConfig(draft: FocusDraft): FocusConfig {
  return {
    mode: 'focus',
    windowsByWeekday: timeWindowDraftToConfig(draft.windows).windowsByWeekday,
    allowedApps: buildAppEntries(draft.apps),
    allowedDomains: parseDomainsInput(draft.allowedDomainsText).domains,
  }
}

// ---------------------------------------------------------------------------
// Quy tắc ứng dụng (đợt 3): draft, kiểm tra hợp lệ, chuyển draft -> config.
// ---------------------------------------------------------------------------

export interface AppTimeLimitDraft {
  apps: Array<{ exe: string; name: string; minutes: string }>
}

export interface AppBlockByTimeDraft {
  apps: Array<{ exe: string; name: string }>
  windows: TimeWindowDraft
}

/** Draft cho chế độ chặn ứng dụng và chỉ cho phép một số ứng dụng (chung danh sách ứng dụng, không khung giờ). */
export interface AppListDraft {
  apps: Array<{ exe: string; name: string }>
}

/**
 * Draft cho chế độ chỉ cho phép một số ứng dụng theo giờ: cùng hình dạng
 * với AppBlockByTimeDraft, nhưng khung giờ là thời gian danh sách cho
 * phép có hiệu lực.
 */
export interface AppAllowlistByTimeDraft {
  apps: Array<{ exe: string; name: string }>
  windows: TimeWindowDraft
}

export interface ForcedBreakDraft {
  workMinutes: string
  breakMinutes: string
}

/** Draft trống: một dòng ứng dụng trống để phụ huynh gõ ngay. */
export function emptyAppTimeLimitDraft(): AppTimeLimitDraft {
  return { apps: [{ exe: '', name: '', minutes: '60' }] }
}

export function emptyAppBlockByTimeDraft(): AppBlockByTimeDraft {
  return { apps: [{ exe: '', name: '' }], windows: emptyTimeWindowDraft() }
}

export function emptyAppListDraft(): AppListDraft {
  return { apps: [{ exe: '', name: '' }] }
}

export function emptyAppAllowlistByTimeDraft(): AppAllowlistByTimeDraft {
  return { apps: [{ exe: '', name: '' }], windows: emptyTimeWindowDraft() }
}

export function emptyForcedBreakDraft(): ForcedBreakDraft {
  return { workMinutes: '45', breakMinutes: '10' }
}

export function appConfigToTimeLimitDraft(config: AppConfig | null): AppTimeLimitDraft {
  const draft = emptyAppTimeLimitDraft()
  if (config?.mode !== 'app_time_limit') return draft
  if (config.apps.length > 0) {
    draft.apps = config.apps.map((app) => ({
      exe: app.exe,
      name: app.name,
      minutes: app.minutesPerDay > 0 ? String(app.minutesPerDay) : '',
    }))
  }
  return draft
}

export function appConfigToBlockByTimeDraft(config: AppConfig | null): AppBlockByTimeDraft {
  const draft = emptyAppBlockByTimeDraft()
  if (config?.mode !== 'app_block_by_time') return draft
  if (config.apps.length > 0) {
    draft.apps = config.apps.map((app) => ({ exe: app.exe, name: app.name }))
  }
  draft.windows = timeWindowConfigToDraft(config.windowsByWeekday)
  return draft
}

export function appConfigToListDraft(config: AppConfig | null): AppListDraft {
  const draft = emptyAppListDraft()
  if (config?.mode !== 'app_block' && config?.mode !== 'app_allowlist') return draft
  if (config.apps.length > 0) {
    draft.apps = config.apps.map((app) => ({ exe: app.exe, name: app.name }))
  }
  return draft
}

export function appConfigToAllowlistByTimeDraft(config: AppConfig | null): AppAllowlistByTimeDraft {
  const draft = emptyAppAllowlistByTimeDraft()
  if (config?.mode !== 'app_allowlist_by_time') return draft
  if (config.apps.length > 0) {
    draft.apps = config.apps.map((app) => ({ exe: app.exe, name: app.name }))
  }
  draft.windows = timeWindowConfigToDraft(config.windowsByWeekday)
  return draft
}

export function appConfigToForcedBreakDraft(config: AppConfig | null): ForcedBreakDraft {
  if (config?.mode !== 'forced_break') return emptyForcedBreakDraft()
  return {
    workMinutes: config.workMinutes > 0 ? String(config.workMinutes) : '',
    breakMinutes: config.breakMinutes > 0 ? String(config.breakMinutes) : '',
  }
}

// ---------------------------------------------------------------------------
// Tên file .exe: kiểm tra hợp lệ + dùng chung cho các danh sách ứng dụng.
// ---------------------------------------------------------------------------

const EXE_FORBIDDEN_PATTERN = /[/\\:*?"<>|]/

/**
 * Kiểm tra tên file .exe đã nhập. Trả về null khi hợp lệ, ngược lại trả
 * về thông báo lỗi tiếng Việt. Chỉ kiểm tra hình thức: tên đã trim dài
 * 1–100 ký tự, không chứa dấu phân tách đường dẫn hay ký tự cấm của tên
 * file Windows, không chứa ký tự điều khiển. Không bắt buộc hậu tố .exe
 * (Agent so khớp tên tiến trình) — gợi ý "game.exe" nằm ở giao diện.
 */
export function validateAppExe(value: string): string | null {
  const exe = value.trim()
  if (exe === '') return 'Tên file .exe không được để trống.'
  if (exe.length > 100) return 'Tên file .exe tối đa 100 ký tự.'
  if (EXE_FORBIDDEN_PATTERN.test(exe)) {
    return 'Tên file .exe không được chứa ký tự / \\ : * ? " < > | (chỉ nhập tên file, ví dụ: game.exe).'
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(exe)) {
    return 'Tên file .exe không được chứa ký tự điều khiển.'
  }
  return null
}

/**
 * Kiểm tra một danh sách dòng ứng dụng trong draft. Dòng hoàn toàn trống
 * (cả exe, tên và số phút nếu có) được bỏ qua; dòng đã gõ dở (có tên hoặc
 * số phút nhưng thiếu exe) là lỗi. Trùng exe (không phân biệt hoa/thường)
 * là lỗi vì Agent không phân biệt được hai dòng đó. Trả về null khi có
 * ít nhất một ứng dụng hợp lệ.
 */
function validateAppRows(
  rows: Array<{ exe: string; name: string; minutes?: string }>,
  emptyMessage = 'Hãy thêm ít nhất một ứng dụng.',
): string | null {
  const seen = new Set<string>()
  let filled = 0
  for (const row of rows) {
    const exe = row.exe.trim()
    const name = row.name.trim()
    const minutes = (row.minutes ?? '').trim()
    if (exe === '' && name === '' && minutes === '') continue
    filled += 1
    if (exe === '') return 'Mỗi ứng dụng cần có tên file .exe (ví dụ: game.exe).'
    const exeError = validateAppExe(exe)
    if (exeError) return `“${exe}”: ${exeError}`
    const key = exe.toLowerCase()
    if (seen.has(key)) return `Ứng dụng “${exe}” bị lặp lại trong danh sách.`
    seen.add(key)
  }
  if (filled === 0) return emptyMessage
  return null
}

/** Chuyển các dòng ứng dụng đã qua kiểm tra thành AppEntry (tên trống thì lấy theo tên exe). */
function buildAppEntries(rows: Array<{ exe: string; name: string }>): AppEntry[] {
  const entries: AppEntry[] = []
  for (const row of rows) {
    const exe = row.exe.trim()
    if (exe === '') continue
    const name = row.name.trim()
    entries.push({ exe, name: name === '' ? exe : name })
  }
  return entries
}

export function validateAppTimeLimitDraft(draft: AppTimeLimitDraft): string | null {
  const rowsError = validateAppRows(draft.apps)
  if (rowsError) return rowsError
  for (const row of draft.apps) {
    if (row.exe.trim() === '') continue
    const text = row.minutes.trim()
    if (text === '') return `“${row.exe.trim()}”: hãy nhập số phút giới hạn mỗi ngày.`
    const minutes = Number(text)
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      return `“${row.exe.trim()}”: số phút phải là số nguyên từ 1 đến 1440 (24 giờ).`
    }
  }
  return null
}

export function buildAppTimeLimitConfig(draft: AppTimeLimitDraft): AppTimeLimitConfig {
  const apps: AppTimeLimitEntry[] = []
  for (const row of draft.apps) {
    const exe = row.exe.trim()
    if (exe === '') continue
    const name = row.name.trim()
    apps.push({ exe, name: name === '' ? exe : name, minutesPerDay: Number(row.minutes.trim()) })
  }
  return { mode: 'app_time_limit', apps }
}

export function validateAppBlockByTimeDraft(draft: AppBlockByTimeDraft): string | null {
  const rowsError = validateAppRows(draft.apps)
  if (rowsError) return rowsError
  return validateTimeWindowDraft(draft.windows)
}

export function buildAppBlockByTimeConfig(draft: AppBlockByTimeDraft): AppBlockByTimeConfig {
  return {
    mode: 'app_block_by_time',
    apps: buildAppEntries(draft.apps),
    windowsByWeekday: timeWindowDraftToConfig(draft.windows).windowsByWeekday,
  }
}

export function validateAppListDraft(draft: AppListDraft): string | null {
  return validateAppRows(draft.apps)
}

export function buildAppBlockConfig(draft: AppListDraft): AppBlockConfig {
  return { mode: 'app_block', apps: buildAppEntries(draft.apps) }
}

export function buildAppAllowlistConfig(draft: AppListDraft): AppAllowlistConfig {
  return { mode: 'app_allowlist', apps: buildAppEntries(draft.apps) }
}

export function validateAppAllowlistByTimeDraft(draft: AppAllowlistByTimeDraft): string | null {
  const rowsError = validateAppRows(draft.apps)
  if (rowsError) return rowsError
  return validateTimeWindowDraft(draft.windows)
}

export function buildAppAllowlistByTimeConfig(
  draft: AppAllowlistByTimeDraft,
): AppAllowlistByTimeConfig {
  return {
    mode: 'app_allowlist_by_time',
    apps: buildAppEntries(draft.apps),
    windowsByWeekday: timeWindowDraftToConfig(draft.windows).windowsByWeekday,
  }
}

/**
 * Danh sách tên exe (đã trim) từ draft danh sách ứng dụng, dùng làm
 * payload `apps` của ghi đè tạm thời block_app/allow_app. Giả định draft
 * đã qua kiểm tra (quy ước như các hàm build*).
 */
export function appListDraftToExeList(draft: AppListDraft): string[] {
  return buildAppEntries(draft.apps).map((app) => app.exe)
}

export function validateForcedBreakDraft(draft: ForcedBreakDraft): string | null {
  const workText = draft.workMinutes.trim()
  if (workText === '') return 'Hãy nhập số phút dùng máy liên tục trước khi nghỉ.'
  const workMinutes = Number(workText)
  if (!Number.isInteger(workMinutes) || workMinutes < 15 || workMinutes > 180) {
    return 'Số phút dùng liên tục phải là số nguyên từ 15 đến 180.'
  }
  const breakText = draft.breakMinutes.trim()
  if (breakText === '') return 'Hãy nhập số phút nghỉ.'
  const breakMinutes = Number(breakText)
  if (!Number.isInteger(breakMinutes) || breakMinutes < 5 || breakMinutes > 60) {
    return 'Số phút nghỉ phải là số nguyên từ 5 đến 60.'
  }
  return null
}

export function buildForcedBreakConfig(draft: ForcedBreakDraft): ForcedBreakConfig {
  return {
    mode: 'forced_break',
    workMinutes: Number(draft.workMinutes.trim()),
    breakMinutes: Number(draft.breakMinutes.trim()),
  }
}

// ---------------------------------------------------------------------------
// Form danh sách (chặn/cho phép × luôn luôn/theo giờ/tạm thời): form thêm
// quy tắc website/ứng dụng cho phụ huynh chọn LOẠI DANH SÁCH trước, rồi
// chọn THỜI GIAN. "Tạm thời" không tạo dòng rule — nó gửi lệnh ghi đè tạm
// thời tới một máy (xem RulesPage). Các hàm dưới đây là ánh xạ thuần giữa
// lựa chọn trên form và mode/action trong config/payload; tên mode và tên
// action phải khớp ĐÚNG hợp đồng với PC Agent (C# thi hành cùng hình dạng).
// ---------------------------------------------------------------------------

/** Loại danh sách: 'block' = danh sách chặn, 'allow' = danh sách cho phép. */
export type ListKind = 'block' | 'allow'

/**
 * Thời gian áp dụng: 'always' = luôn luôn (đến khi tắt quy tắc),
 * 'by_time' = theo khung giờ trong tuần, 'temporary' = tạm thời, đếm
 * ngược (ghi đè tạm thời, không tạo rule).
 */
export type TimeKind = 'always' | 'by_time' | 'temporary'

export interface ListSelection {
  listKind: ListKind
  timeKind: TimeKind
}

/** Hành động ghi đè tạm thời theo danh sách (payload mang `domains` hoặc `apps`). */
export type TempListOverrideAction = 'allow_domain' | 'block_domain' | 'allow_app' | 'block_app'

export function websiteModeFromListSelection(
  listKind: ListKind,
  timeKind: 'always' | 'by_time',
): WebsiteMode {
  if (listKind === 'block') return timeKind === 'always' ? 'block_domains' : 'block_domains_by_time'
  return timeKind === 'always' ? 'allowlist' : 'allowlist_by_time'
}

export function appModeFromListSelection(
  listKind: ListKind,
  timeKind: 'always' | 'by_time',
): AppMode {
  if (listKind === 'block') return timeKind === 'always' ? 'app_block' : 'app_block_by_time'
  return timeKind === 'always' ? 'app_allowlist' : 'app_allowlist_by_time'
}

/** Suy ra lựa chọn trên form từ mode của rule website đã lưu; mode không thuộc nhóm danh sách thì trả về null. */
export function websiteListSelectionFromMode(mode: WebsiteMode): ListSelection | null {
  switch (mode) {
    case 'block_domains':
      return { listKind: 'block', timeKind: 'always' }
    case 'block_domains_by_time':
      return { listKind: 'block', timeKind: 'by_time' }
    case 'allowlist':
      return { listKind: 'allow', timeKind: 'always' }
    case 'allowlist_by_time':
      return { listKind: 'allow', timeKind: 'by_time' }
    default:
      return null
  }
}

/** Suy ra lựa chọn trên form từ mode của rule ứng dụng đã lưu; mode không thuộc nhóm danh sách thì trả về null. */
export function appListSelectionFromMode(mode: AppMode): ListSelection | null {
  switch (mode) {
    case 'app_block':
      return { listKind: 'block', timeKind: 'always' }
    case 'app_block_by_time':
      return { listKind: 'block', timeKind: 'by_time' }
    case 'app_allowlist':
      return { listKind: 'allow', timeKind: 'always' }
    case 'app_allowlist_by_time':
      return { listKind: 'allow', timeKind: 'by_time' }
    default:
      return null
  }
}

/** Hành động ghi đè website tạm thời theo loại danh sách: chặn -> block_domain, cho phép -> allow_domain. */
export function websiteTempOverrideAction(listKind: ListKind): 'allow_domain' | 'block_domain' {
  return listKind === 'block' ? 'block_domain' : 'allow_domain'
}

/** Hành động ghi đè ứng dụng tạm thời theo loại danh sách: chặn -> block_app, cho phép -> allow_app. */
export function appTempOverrideAction(listKind: ListKind): 'allow_app' | 'block_app' {
  return listKind === 'block' ? 'block_app' : 'allow_app'
}

// ---------------------------------------------------------------------------
// Mẫu sẵn một chạm (đợt 3): dữ liệu thuần, không gọi Supabase. Trang Quy
// tắc chèn từng rule do `buildPresetRules` trả về (chỉ THÊM, không xóa
// hay sửa rule hiện có). `PresetRuleType` định nghĩa tại đây để module
// thuần này không phải import kiểu của Dashboard (file này không có import).
// ---------------------------------------------------------------------------

export type PresetRuleType = 'daily_limit' | 'bedtime' | 'time_window' | 'app' | 'website'

export type PresetId = 'school' | 'weekend' | 'holiday'

export interface PresetOption {
  id: PresetId
  label: string
  /** Các dòng mô tả đúng những quy tắc sẽ được tạo khi áp dụng mẫu. */
  summary: string[]
}

export const PRESET_OPTIONS: PresetOption[] = [
  {
    id: 'school',
    label: 'Ngày học',
    summary: [
      'Khung giờ được dùng máy: Thứ 2–6, 07:00–21:00.',
      'Giờ ngủ 21:00–07:00 (qua đêm) vào Chủ nhật, Thứ 2, Thứ 3, Thứ 4, Thứ 5.',
      'YouTube (youtube.com): tối đa 30 phút mỗi ngày.',
      'Giờ học tập trung Thứ 2–6, 19:00–21:00: chỉ 6 website học tập và 5 ứng dụng (Chrome, Edge, Word, Excel, PowerPoint) được mở.',
    ],
  },
  {
    id: 'weekend',
    label: 'Cuối tuần',
    summary: [
      'Tổng giờ dùng máy: 3 giờ mỗi ngày vào Thứ 7 và Chủ nhật.',
      'Giờ ngủ 22:00–08:00 (qua đêm) vào Thứ 6 và Thứ 7.',
    ],
  },
  {
    id: 'holiday',
    label: 'Kỳ nghỉ',
    summary: ['Tổng giờ dùng máy: 4 giờ mỗi ngày, cả tuần.'],
  },
]

export interface PresetRule {
  type: PresetRuleType
  config: Record<string, unknown>
}

export function buildPresetRules(presetId: PresetId): PresetRule[] {
  switch (presetId) {
    case 'school': {
      const schoolDays: WindowsByWeekday = {
        1: [{ start: '07:00', end: '21:00' }],
        2: [{ start: '07:00', end: '21:00' }],
        3: [{ start: '07:00', end: '21:00' }],
        4: [{ start: '07:00', end: '21:00' }],
        5: [{ start: '07:00', end: '21:00' }],
      }
      const focusWindows: WindowsByWeekday = {
        1: [{ start: '19:00', end: '21:00' }],
        2: [{ start: '19:00', end: '21:00' }],
        3: [{ start: '19:00', end: '21:00' }],
        4: [{ start: '19:00', end: '21:00' }],
        5: [{ start: '19:00', end: '21:00' }],
      }
      const night: TimeRangeValue = { start: '21:00', end: '07:00' }
      return [
        { type: 'time_window', config: { windowsByWeekday: schoolDays } },
        {
          type: 'bedtime',
          config: { bedtimeByWeekday: { 0: night, 1: night, 2: night, 3: night, 4: night } },
        },
        {
          type: 'website',
          config: { mode: 'domain_time_limit', domains: ['youtube.com'], minutes_per_day: 30 },
        },
        {
          type: 'website',
          config: {
            mode: 'focus',
            windowsByWeekday: focusWindows,
            allowedDomains: [
              'classroom.google.com',
              'docs.google.com',
              'drive.google.com',
              'meet.google.com',
              'wikipedia.org',
              'khanacademy.org',
            ],
            allowedApps: [
              { exe: 'chrome.exe', name: 'Chrome' },
              { exe: 'msedge.exe', name: 'Edge' },
              { exe: 'WINWORD.EXE', name: 'Word' },
              { exe: 'EXCEL.EXE', name: 'Excel' },
              { exe: 'POWERPNT.EXE', name: 'PowerPoint' },
            ],
          },
        },
      ]
    }
    case 'weekend':
      return [
        { type: 'daily_limit', config: { minutesByWeekday: { 0: 180, 6: 180 } } },
        {
          type: 'bedtime',
          config: {
            bedtimeByWeekday: {
              5: { start: '22:00', end: '08:00' },
              6: { start: '22:00', end: '08:00' },
            },
          },
        },
      ]
    case 'holiday':
      return [
        {
          type: 'daily_limit',
          config: { minutesByWeekday: { 0: 240, 1: 240, 2: 240, 3: 240, 4: 240, 5: 240, 6: 240 } },
        },
      ]
  }
}
