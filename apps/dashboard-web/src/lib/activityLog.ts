// Logic thuần cho trang Nhật ký hoạt động (PRD §2.8): gộp 3 nguồn dữ
// liệu sẵn có thành một dòng sự kiện duy nhất, mới nhất trước.
//
// Nguồn dữ liệu (đọc migrations 1–12):
// - commands: lệnh phụ huynh gửi tới máy (khóa ngay, mở khóa tạm thời,
//   ghi đè tạm thời...). KHÔNG có cột người gửi — với một phụ huynh thì
//   người gửi là ngầm hiểu; khi có phụ huynh thứ hai vẫn chưa phân biệt
//   được ai đã gửi lệnh (ghi chú trung thực trong UI).
// - requests: yêu cầu của con (lúc tạo) + quyết định duyệt/từ chối
//   (decided_at/decided_by, migration 1). Người quyết định chỉ phân biệt
//   được "bạn" hay "phụ huynh khác" qua id user hiện tại — Dashboard
//   không tra cứu được email từ user id.
// - audit_logs: sự kiện can thiệp (migration 5) + sự kiện thi hành theo
//   quy tắc (migration 10). Lịch sử thi hành chỉ bắt đầu từ khi migration
//   10 được áp + bản Agent/extension mới được cài trên máy con.
//
// KHÔNG có nguồn cho "ai đổi rule nào": bảng rules không có lịch sử sửa
// đổi và Dashboard không ghi audit khi sửa rule. Trang này không bịa
// mục đó — ghi chú rõ trong UI, để đợt migration + trigger ghi audit
// riêng sau.

import { enforcementReasonLabel, formatTimeVi, overrideActionLabel, requestTypeLabel, tamperEventLabel } from './format'
import type { AppRequest, AuditLog, Command, CommandStatus, Device, TemporaryOverrideAction } from './types'
import { dateKeyLocal, driftMinutes, ENFORCEMENT_ACTIONS, startOfDayLocal, TAMPER_ACTIONS, weekdayLabel } from './weekReport'
import type { WeekdayNumber } from './ruleConfig'

export type ActivityCategory = 'command' | 'request' | 'decision' | 'enforcement' | 'tamper'

export const ACTIVITY_CATEGORIES: Array<{ value: ActivityCategory; label: string }> = [
  { value: 'command', label: 'Lệnh phụ huynh' },
  { value: 'request', label: 'Con xin phép' },
  { value: 'decision', label: 'Quyết định duyệt' },
  { value: 'enforcement', label: 'Thi hành theo quy tắc' },
  { value: 'tamper', label: 'Cảnh báo can thiệp' },
]

export function activityCategoryLabel(category: ActivityCategory): string {
  return ACTIVITY_CATEGORIES.find((c) => c.value === category)?.label ?? category
}

/** Một sự kiện trong nhật ký, đã dịch sang tiếng Việt và gắn tên con/máy. */
export interface ActivityEvent {
  /** Khóa ổn định: nguồn + id hàng (`cmd:…`, `req:…`, `dec:…`, `log:…`). */
  id: string
  category: ActivityCategory
  /** Mốc thời gian ISO (created_at của hàng, hoặc decided_at với quyết định). */
  at: string
  /** at dạng mili-giây; 0 khi không parse được (xếp cuối, không vỡ trang). */
  atMs: number
  childId: string | null
  childName: string | null
  deviceId: string | null
  deviceName: string | null
  title: string
  detail: string | null
  /** Nhãn trạng thái lệnh — chỉ lệnh phụ huynh mới có, các loại khác null. */
  statusLabel: string | null
}

export interface ActivityContext {
  childNameById: ReadonlyMap<string, string>
  deviceById: ReadonlyMap<string, Device>
  /** Id user đang đăng nhập (để phân biệt "bạn" với phụ huynh khác). */
  currentUserId: string | null
}

function parseMs(iso: string): number {
  const ms = new Date(iso).getTime()
  return Number.isFinite(ms) ? ms : 0
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

function formatMinutes(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/** Nhãn trạng thái của một lệnh trong bảng commands. */
export function commandStatusLabel(status: CommandStatus): string {
  switch (status) {
    case 'pending':
      return 'Chờ máy nhận'
    case 'sent':
      return 'Đã gửi tới máy'
    case 'done':
      return 'Máy đã thực hiện'
    case 'failed':
      return 'Gửi thất bại'
  }
}

const OVERRIDE_ACTIONS: readonly string[] = [
  'bonus_minutes',
  'lock',
  'unlock',
  'allow_domain',
  'block_domain',
  'block_app',
  'allow_app',
  'cancel',
]

function isOverrideAction(value: string): value is TemporaryOverrideAction {
  return OVERRIDE_ACTIONS.includes(value)
}

/**
 * Mô tả thêm cho lệnh temporary_override: số phút + hạn (mở/khóa/cộng
 * giờ), hoặc danh sách domain/app (cho phép/chặn tạm thời). Danh sách
 * dài thì chỉ hiện 4 mục đầu + số còn lại.
 */
function describeOverridePayload(payload: Record<string, unknown>): string | null {
  const action = asString(payload['action'])
  const minutes = asNumber(payload['minutes'])
  const expiresAt = asString(payload['expires_at'])
  const parts: string[] = []
  if (action === 'bonus_minutes') {
    if (minutes !== null) {
      parts.push(
        expiresAt !== null
          ? `${formatMinutes(minutes)} phút cộng thêm vào giới hạn hôm nay, đến ${formatTimeVi(expiresAt)}`
          : `${formatMinutes(minutes)} phút cộng thêm vào giới hạn hôm nay`,
      )
    } else if (expiresAt !== null) {
      parts.push(`đến ${formatTimeVi(expiresAt)}`)
    }
  } else if (action === 'unlock' || action === 'lock') {
    if (minutes !== null) {
      parts.push(expiresAt !== null ? `${formatMinutes(minutes)} phút, đến ${formatTimeVi(expiresAt)}` : `${formatMinutes(minutes)} phút`)
    } else if (expiresAt !== null) {
      parts.push(`đến ${formatTimeVi(expiresAt)}`)
    }
  } else if (action === 'allow_domain' || action === 'block_domain') {
    const domains = asStringArray(payload['domains'])
    if (domains.length > 0) {
      parts.push(domains.length > 4 ? `${domains.slice(0, 4).join(', ')} và ${domains.length - 4} nữa` : domains.join(', '))
    }
    if (minutes !== null) parts.push(`${formatMinutes(minutes)} phút`)
  } else if (action === 'allow_app' || action === 'block_app') {
    const apps = asStringArray(payload['apps'])
    if (apps.length > 0) {
      parts.push(apps.length > 4 ? `${apps.slice(0, 4).join(', ')} và ${apps.length - 4} nữa` : apps.join(', '))
    }
    if (minutes !== null) parts.push(`${formatMinutes(minutes)} phút`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

/** Một lệnh phụ huynh thành một sự kiện. Con suy ra qua máy nhận lệnh. */
export function commandToEvent(cmd: Command, ctx: ActivityContext): ActivityEvent {
  const device = ctx.deviceById.get(cmd.device_id)
  const childId = device?.child_id ?? null
  const payload = asRecord(cmd.payload) ?? {}
  let title: string
  let detail: string | null = null
  switch (cmd.type) {
    case 'lock_now': {
      title = 'Khóa máy ngay'
      const delay = asNumber(payload['delay_minutes'])
      detail = delay !== null && delay > 0 ? `Sau ${formatMinutes(delay)} phút, máy hiện cảnh báo trước để con lưu bài` : 'Khóa ngay lập tức'
      break
    }
    case 'unlock':
      title = 'Mở khóa máy'
      break
    case 'refresh_rules':
      title = 'Yêu cầu máy tải lại quy tắc'
      break
    case 'update':
      title = 'Yêu cầu máy cập nhật'
      break
    case 'temporary_override': {
      const action = asString(payload['action'])
      title = action !== null && isOverrideAction(action) ? overrideActionLabel(action) : 'Ghi đè tạm thời'
      detail = describeOverridePayload(payload)
      break
    }
    default:
      // Loại lệnh lạ (tương lai thêm): giữ nguyên tên, không bịa nhãn.
      title = cmd.type
  }
  return {
    id: `cmd:${cmd.id}`,
    category: 'command',
    at: cmd.created_at,
    atMs: parseMs(cmd.created_at),
    childId,
    childName: childId !== null ? (ctx.childNameById.get(childId) ?? null) : null,
    deviceId: cmd.device_id,
    deviceName: device?.hostname ?? null,
    title,
    detail,
    statusLabel: commandStatusLabel(cmd.status),
  }
}

/**
 * Một yêu cầu thành 1–2 sự kiện: lúc con gửi yêu cầu, và lúc phụ huynh
 * quyết định (chỉ khi đã quyết định VÀ có decided_at — thiếu mốc thời
 * gian thì không đặt được sự kiện đúng chỗ nên bỏ qua, không bịa giờ).
 */
export function requestToEvents(req: AppRequest, ctx: ActivityContext): ActivityEvent[] {
  const device = req.device_id ? ctx.deviceById.get(req.device_id) : undefined
  const childName = ctx.childNameById.get(req.child_id) ?? null
  const base = {
    childId: req.child_id,
    childName,
    deviceId: req.device_id ?? null,
    deviceName: device?.hostname ?? null,
    statusLabel: null as string | null,
  }
  const typeLabel = requestTypeLabel(req.type)
  const detailParts: string[] = []
  if (req.type === 'extra_time' && typeof req.minutes === 'number') {
    detailParts.push(`Xin thêm ${formatMinutes(req.minutes)} phút`)
  }
  const reason = (req.reason ?? '').trim()
  if (reason) detailParts.push(`Lý do: ${reason}`)
  const events: ActivityEvent[] = [
    {
      id: `req:${req.id}`,
      category: 'request',
      at: req.created_at,
      atMs: parseMs(req.created_at),
      ...base,
      title: `Con gửi yêu cầu: ${typeLabel.toLowerCase()}`,
      detail: detailParts.length > 0 ? detailParts.join(' · ') : null,
    },
  ]
  if (req.status !== 'pending' && req.decided_at) {
    const decidedBy =
      req.decided_by !== null && ctx.currentUserId !== null && req.decided_by === ctx.currentUserId
        ? 'Bạn đã quyết định'
        : req.decided_by !== null
          ? 'Một phụ huynh khác đã quyết định'
          : null
    events.push({
      id: `dec:${req.id}`,
      category: 'decision',
      at: req.decided_at,
      atMs: parseMs(req.decided_at),
      ...base,
      title: `${req.status === 'approved' ? 'Đã duyệt' : 'Đã từ chối'}: ${typeLabel.toLowerCase()}`,
      detail: decidedBy,
    })
  }
  return events
}

/** Con của một hàng audit_logs: cột child_id trước, rồi khớp qua máy ở target (cùng thứ tự isLogForChild). */
function resolveLogChildId(
  log: AuditLog,
  deviceChildById: ReadonlyMap<string, string>,
): string | null {
  if (log.child_id) return log.child_id
  if (log.target) return deviceChildById.get(log.target) ?? null
  return null
}

function appBlockKindLabel(kind: string | null): string | null {
  switch (kind) {
    case 'block':
      return 'Ứng dụng bị chặn theo quy tắc'
    case 'block_by_time':
      return 'Ngoài khung giờ được dùng của ứng dụng'
    case 'time_limit':
      return 'Hết thời gian cho phép của ứng dụng'
    case 'temp_block':
      return 'Ứng dụng đang bị chặn tạm thời'
    case 'focus':
      return 'Đang giờ học tập trung'
    case 'allowlist':
      return 'Ứng dụng không thuộc danh sách cho phép'
    default:
      // Loại lạ: giữ nguyên chuỗi để phụ huynh vẫn thấy thông tin.
      return kind
  }
}

function warningKindDetail(details: Record<string, unknown>): string | null {
  const kind = asString(details['kind'])
  const minutesLeft = asNumber(details['minutes_left'])
  const exe = asString(details['exe'])
  const leftText = minutesLeft !== null ? `còn ${formatMinutes(minutesLeft)} phút` : null
  switch (kind) {
    case 'deadline':
      return leftText !== null ? `Sắp hết giờ, ${leftText}` : 'Sắp hết giờ'
    case 'pending_lock':
      return leftText !== null ? `Sắp khóa máy theo lệnh phụ huynh, ${leftText}` : 'Sắp khóa máy theo lệnh phụ huynh'
    case 'app_window':
      return `${exe ?? 'Ứng dụng'} sắp hết khung giờ được dùng${leftText !== null ? `, ${leftText}` : ''}`
    case 'app_limit':
      return `${exe ?? 'Ứng dụng'} sắp hết thời gian cho phép${leftText !== null ? `, ${leftText}` : ''}`
    default:
      return leftText
  }
}

/**
 * Một hàng audit_logs thành một sự kiện, hoặc null khi action không
 * thuộc 2 tập đã biết (truy vấn đã lọc action nên trường hợp này chỉ
 * xảy ra khi dữ liệu lạ lọt vào — bỏ qua thay vì hiện nhãn sai).
 */
export function auditLogToEvent(
  log: AuditLog,
  ctx: ActivityContext,
  deviceChildById: ReadonlyMap<string, string>,
): ActivityEvent | null {
  const isTamper = (TAMPER_ACTIONS as readonly string[]).includes(log.action)
  const isEnforcement = (ENFORCEMENT_ACTIONS as readonly string[]).includes(log.action)
  if (!isTamper && !isEnforcement) return null
  const childId = resolveLogChildId(log, deviceChildById)
  const deviceId =
    log.device_id ?? (log.target && ctx.deviceById.has(log.target) ? log.target : null)
  const device = deviceId !== null ? ctx.deviceById.get(deviceId) : undefined
  const details = asRecord(log.details) ?? {}
  let title: string
  let detail: string | null = null
  if (isTamper) {
    title = tamperEventLabel(log.action)
    if (log.action === 'clock_drift') {
      const drift = driftMinutes(log.details)
      if (drift !== null) detail = `Đồng hồ máy lệch ${formatMinutes(Math.abs(drift))} phút so với giờ máy chủ`
    } else if (log.action === 'agent_restart') {
      const version = asString(details['agent_version'])
      if (version !== null) detail = `Phiên bản Agent ${version}`
    }
  } else {
    switch (log.action) {
      case 'lock_started': {
        title = 'Máy bị khóa theo quy tắc'
        const kind = asString(details['kind'])
        if (kind !== null && kind !== 'rule') detail = enforcementReasonLabel(kind)
        else if (kind === 'rule') detail = 'Quy tắc giờ giấc'
        break
      }
      case 'break_started': {
        title = 'Bắt đầu nghỉ bắt buộc'
        const work = asNumber(details['work_minutes'])
        const rest = asNumber(details['break_minutes'])
        if (work !== null && rest !== null) {
          detail = `Sau ${formatMinutes(work)} phút dùng máy, nghỉ ${formatMinutes(rest)} phút`
        }
        break
      }
      case 'app_blocked': {
        const exe = asString(details['exe'])
        title = exe !== null ? `Đã đóng ứng dụng ${exe}` : 'Đã đóng ứng dụng bị chặn'
        detail = appBlockKindLabel(asString(details['kind']))
        break
      }
      case 'warning_shown':
        title = 'Đã hiện cảnh báo cho con'
        detail = warningKindDetail(details)
        break
      default:
        return null
    }
  }
  return {
    id: `log:${log.id}`,
    category: isTamper ? 'tamper' : 'enforcement',
    at: log.created_at,
    atMs: parseMs(log.created_at),
    childId,
    childName: childId !== null ? (ctx.childNameById.get(childId) ?? null) : null,
    deviceId,
    deviceName: device?.hostname ?? null,
    title,
    detail,
    statusLabel: null,
  }
}

/** Gộp 3 nguồn thành một danh sách, mới nhất trước; cùng mốc giờ thì id lớn trước (ổn định). */
export function buildActivityEvents(
  commands: readonly Command[],
  requests: readonly AppRequest[],
  logs: readonly AuditLog[],
  ctx: ActivityContext,
  deviceChildById: ReadonlyMap<string, string>,
  /** Mốc bắt đầu khoảng đã chọn (ms); null = không giới hạn. */
  rangeStartMs: number | null = null,
): ActivityEvent[] {
  const events: ActivityEvent[] = []
  for (const cmd of commands) events.push(commandToEvent(cmd, ctx))
  for (const req of requests) {
    for (const event of requestToEvents(req, ctx)) {
      // Yêu cầu đọc theo decided_at (quyết định muộn) mang theo cả sự
      // kiện tạo trước khoảng đã chọn: bỏ sự kiện tạo đó để không rò
      // ra ngoài khoảng; sự kiện quyết định (trong khoảng) giữ lại.
      // Quyết định luôn sau lúc tạo nên sự kiện quyết định không bao
      // giờ cũ hơn khoảng.
      if (rangeStartMs !== null && event.category === 'request' && event.atMs < rangeStartMs) continue
      events.push(event)
    }
  }
  for (const log of logs) {
    const event = auditLogToEvent(log, ctx, deviceChildById)
    if (event !== null) events.push(event)
  }
  return sortEventsDesc(events)
}

export function sortEventsDesc(events: readonly ActivityEvent[]): ActivityEvent[] {
  return [...events].sort((a, b) => {
    if (b.atMs !== a.atMs) return b.atMs - a.atMs
    return b.id < a.id ? -1 : b.id > a.id ? 1 : 0
  })
}

export interface ActivityFilter {
  /** 'all' = mọi con; sự kiện không gắn được với con nào chỉ hiện khi chọn 'all'. */
  childId: string | 'all'
  category: ActivityCategory | 'all'
}

export function filterEvents(events: readonly ActivityEvent[], filter: ActivityFilter): ActivityEvent[] {
  return events.filter((event) => {
    if (filter.childId !== 'all' && event.childId !== filter.childId) return false
    if (filter.category !== 'all' && event.category !== filter.category) return false
    return true
  })
}

// ---------------------------------------------------------------------------
// Khoảng thời gian
// ---------------------------------------------------------------------------

export type ActivityRangePreset = 'today' | '7d' | '30d' | 'all'

export const ACTIVITY_RANGES: Array<{ value: ActivityRangePreset; label: string }> = [
  { value: 'today', label: 'Hôm nay' },
  { value: '7d', label: '7 ngày qua' },
  { value: '30d', label: '30 ngày qua' },
  { value: 'all', label: 'Tất cả' },
]

/**
 * Mốc bắt đầu của khoảng (ISO, UTC) để truy vấn; null = không giới hạn
 * (preset 'all'). 'today' tính từ đầu ngày theo giờ địa phương của
 * trình duyệt; '7d'/'30d' là cửa sổ lăn từ thời điểm hiện tại.
 */
export function rangeStartIso(preset: ActivityRangePreset, now: Date = new Date()): string | null {
  switch (preset) {
    case 'today':
      return startOfDayLocal(now).toISOString()
    case '7d':
      return new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString()
    case '30d':
      return new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString()
    case 'all':
      return null
  }
}

// ---------------------------------------------------------------------------
// Nhóm theo ngày (giờ địa phương)
// ---------------------------------------------------------------------------

export interface ActivityDayGroup {
  /** Khóa ngày dạng yyyy-mm-dd theo giờ địa phương. */
  key: string
  label: string
  events: ActivityEvent[]
}

function dayLabel(date: Date, now: Date): string {
  const key = dateKeyLocal(date)
  const todayKey = dateKeyLocal(now)
  if (key === todayKey) return 'Hôm nay'
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (key === dateKeyLocal(yesterday)) return 'Hôm qua'
  const weekday = weekdayLabel(date.getDay() as WeekdayNumber)
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  return `${weekday}, ${dd}/${mm}/${date.getFullYear()}`
}

/** Nhóm các sự kiện (đã xếp mới nhất trước) theo ngày địa phương, giữ thứ tự nhóm mới nhất trước. */
export function groupEventsByDay(
  events: readonly ActivityEvent[],
  now: Date = new Date(),
): ActivityDayGroup[] {
  const groups: ActivityDayGroup[] = []
  const byKey = new Map<string, ActivityDayGroup>()
  for (const event of events) {
    const date = new Date(event.atMs)
    // Mốc giờ hỏng (atMs = 0) gom vào nhóm riêng thay vì nhãn ngày
    // 01/01/1970 gây khó hiểu; timestamptz thật luôn parse được nên
    // nhóm này chỉ là phòng thủ.
    const key = event.atMs === 0 ? 'unknown' : dateKeyLocal(date)
    let group = byKey.get(key)
    if (!group) {
      group = { key, label: event.atMs === 0 ? 'Không rõ thời gian' : dayLabel(date, now), events: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    group.events.push(event)
  }
  return groups
}
