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
