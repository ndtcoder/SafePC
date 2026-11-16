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
  | 'domain_time_limit'
  | 'safe_search'

export interface WebsiteModeOption {
  value: WebsiteMode
  label: string
}

export const WEBSITE_MODE_OPTIONS: WebsiteModeOption[] = [
  { value: 'block_domains', label: 'Chặn website' },
  { value: 'block_domains_by_time', label: 'Chặn website theo giờ' },
  { value: 'allowlist', label: 'Chỉ cho phép một số website' },
  { value: 'domain_time_limit', label: 'Giới hạn thời gian theo website' },
  { value: 'safe_search', label: 'Tìm kiếm an toàn (SafeSearch / YouTube)' },
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

export type WebsiteConfig =
  | BlockDomainsConfig
  | BlockDomainsByTimeConfig
  | AllowlistConfig
  | DomainTimeLimitConfig
  | SafeSearchConfig

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
 */
function readStoredDomains(config: Record<string, unknown>): string[] {
  const rawEntries = asStringArray(config['domains'])
  if (rawEntries.length === 0) {
    for (const key of ['domain', 'website', 'url', 'host']) {
      const single = config[key]
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

function asBooleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

const WEBSITE_MODES: WebsiteMode[] = [
  'block_domains',
  'block_domains_by_time',
  'allowlist',
  'domain_time_limit',
  'safe_search',
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
    }
  }
  // Không có mode: hình dạng cũ (1 domain + action) hoặc mảng domains trần.
  // `action: "allow"` cũ được hiểu như allowlist 1 domain; còn lại là chặn.
  if (domains.length === 0) return null
  if (config['action'] === 'allow') return { mode: 'allowlist', domains }
  return { mode: 'block_domains', domains }
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

export interface DomainTimeLimitDraft {
  domainsText: string
  minutes: string
}

export interface SafeSearchDraft {
  searchProviders: boolean
  youtubeRestricted: boolean
}

export function emptyWebsiteDomainsDraft(): WebsiteDomainsDraft {
  return { domainsText: '' }
}

export function emptyBlockDomainsByTimeDraft(): BlockDomainsByTimeDraft {
  return { domainsText: '', windows: emptyTimeWindowDraft() }
}

export function emptyDomainTimeLimitDraft(): DomainTimeLimitDraft {
  return { domainsText: '', minutes: '30' }
}

export function emptySafeSearchDraft(): SafeSearchDraft {
  return { searchProviders: true, youtubeRestricted: true }
}

export function websiteConfigToDomainsDraft(config: WebsiteConfig | null): WebsiteDomainsDraft {
  if (!config || config.mode === 'safe_search') return emptyWebsiteDomainsDraft()
  return { domainsText: config.domains.join('\n') }
}

export function websiteConfigToBlockByTimeDraft(config: WebsiteConfig | null): BlockDomainsByTimeDraft {
  const draft = emptyBlockDomainsByTimeDraft()
  if (!config || config.mode === 'safe_search') return draft
  draft.domainsText = config.domains.join('\n')
  if (config.mode === 'block_domains_by_time') {
    draft.windows = timeWindowConfigToDraft(config.windowsByWeekday)
  }
  return draft
}

export function websiteConfigToTimeLimitDraft(config: WebsiteConfig | null): DomainTimeLimitDraft {
  const draft = emptyDomainTimeLimitDraft()
  if (!config || config.mode === 'safe_search') return draft
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
