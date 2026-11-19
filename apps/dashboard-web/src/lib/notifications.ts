// Logic cho mục Thông báo trong Dashboard (PRD §2.6/§2.8): chuông ở
// header + trang /thong-bao, song song với email thông báo.
//
// Nguồn sự kiện = đúng 3 nguồn của Edge Function send-parent-notifications
// (định nghĩa lấy từ file đó, không bịa thêm):
// - Yêu cầu còn chờ duyệt (requests status = pending, cả 3 loại
//   extra_time/unblock_app/unblock_domain; đã duyệt/từ chối thì không
//   hiện nữa). Tên miền hiện best-effort như trang Nhật ký.
// - Cảnh báo can thiệp: đúng 5 action TAMPER_ACTIONS trong audit_logs.
// - Máy offline quá 48 giờ: một mục cho mỗi "đợt" offline, khóa đợt gắn
//   với thời điểm thấy máy lần cuối (cùng công thức khóa của function
//   email) — máy offline kéo dài không sinh thêm mục mới; máy quay lại
//   rồi lại offline thì đợt mới, mục mới.
//
// Khác với email: Dashboard KHÔNG áp dụng chặn spam theo giờ của email
// (1 email/giờ/con, 1 email/6h/máy+loại) — đây là danh sách để phụ huynh
// duyệt qua, có phân trang, nên hiện đủ sự kiện trong cửa sổ 30 ngày.
// Cửa sổ 30 ngày (không phải 24 giờ như email): phụ huynh mở app thưa
// vẫn thấy việc còn tồn đọng; lần đầu mở cũng không bị ngập lịch sử cũ.
//
// Trạng thái đã đọc: mốc (watermark) riêng theo user, bảng
// notification_reads (migration 20). Sự kiện mới hơn mốc thì chưa đọc;
// chưa có mốc (chưa từng bấm "đã đọc") thì mọi sự kiện trong cửa sổ đều
// chưa đọc. Mốc của máy offline là lúc vượt ngưỡng 48 giờ (lúc sự kiện
// "xảy ra"), không phải lúc thấy máy lần cuối — nếu không, bấm "đã đọc"
// xong máy vẫn offline thì mục đó đã cũ hơn mốc mãi mãi nhưng đợt thì
// vẫn đang diễn ra; dùng mốc vượt ngưỡng thì hành vi vẫn đúng: đợt cũ
// đã đọc thì thôi, đợt mới thì mốc vượt ngưỡng mới hơn mốc đã đọc.
// Không dùng Realtime (dự án không dùng ở đâu cả): chuông tải lại khi
// đổi route và khi trang Thông báo báo đã đánh dấu đã đọc.

import type { SupabaseClient } from '@supabase/supabase-js'
import { formatDateTimeVi, requestTypeLabel, tamperEventLabel } from './format'
import type { AppRequest, AuditLog, Child, Device, NotificationRead } from './types'
import { driftMinutes, TAMPER_ACTIONS } from './weekReport'

/** Cửa sổ nhìn lại của mục Thông báo: 30 ngày. */
export const NOTIFICATION_LOOKBACK_MS = 30 * 24 * 3600 * 1000
/** Máy không thấy tín hiệu quá 48 giờ thì báo offline (cùng ngưỡng với email thông báo). */
export const OFFLINE_AFTER_MS = 48 * 3600 * 1000
/** Tên bảng mốc đã đọc (migration 20) — dùng để nhận diện lỗi "chưa áp migration". */
export const NOTIFICATION_READS_TABLE = 'notification_reads'
/** Sự kiện window mà trang Thông báo phát sau khi đánh dấu đã đọc, để chuông tải lại số chưa đọc. */
export const NOTIFICATIONS_READ_EVENT = 'safepc:notifications-read'

export type NotificationKind = 'request' | 'tamper' | 'device_offline'

export const NOTIFICATION_KINDS: Array<{ value: NotificationKind; label: string }> = [
  { value: 'request', label: 'Yêu cầu' },
  { value: 'tamper', label: 'Can thiệp' },
  { value: 'device_offline', label: 'Máy offline' },
]

export function notificationKindLabel(kind: NotificationKind): string {
  return NOTIFICATION_KINDS.find((k) => k.value === kind)?.label ?? kind
}

/** Một mục thông báo, đã dịch sang tiếng Việt và gắn tên con/máy + link tới trang xử lý. */
export interface NotificationItem {
  /** Khóa ổn định: `req:<id>`, `log:<id>`, hoặc `offline:<device_id>@<last_seen_ms>`. */
  id: string
  kind: NotificationKind
  /** Mốc thời gian ISO của sự kiện (lúc tạo với yêu cầu/can thiệp; lúc vượt ngưỡng 48 giờ với offline). */
  at: string
  /** at dạng mili-giây. */
  atMs: number
  childId: string | null
  childName: string | null
  deviceId: string | null
  deviceName: string | null
  title: string
  detail: string | null
  /** Route tới trang xử lý mục này (Yêu cầu / Nhật ký / hồ sơ máy). */
  link: string
  linkLabel: string
}

export interface NotificationContext {
  childNameById: ReadonlyMap<string, string>
  deviceById: ReadonlyMap<string, Device>
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = new Date(iso).getTime()
  return Number.isFinite(ms) ? ms : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function formatMinutes(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/**
 * Khóa đợt offline của một máy — cùng công thức với Edge Function gửi
 * email: null khi máy chưa từng kết nối hoặc chưa quá ngưỡng 48 giờ.
 * Khóa gắn với thời điểm thấy máy lần cuối nên cùng một đợt offline
 * chỉ có một khóa duy nhất.
 */
export function offlineEpisodeKey(device: Pick<Device, 'id' | 'last_seen_at'>, nowMs: number): string | null {
  const seenMs = parseMs(device.last_seen_at)
  if (seenMs === null) return null
  if (nowMs - seenMs <= OFFLINE_AFTER_MS) return null
  return `${device.id}@${seenMs}`
}

/** Một yêu cầu còn chờ duyệt thành một mục thông báo; null khi đã quyết định hoặc ngoài cửa sổ 30 ngày. */
export function requestToNotification(
  req: AppRequest,
  ctx: NotificationContext,
  nowMs: number,
): NotificationItem | null {
  if (req.status !== 'pending') return null
  const createdMs = parseMs(req.created_at)
  if (createdMs === null || createdMs > nowMs || nowMs - createdMs > NOTIFICATION_LOOKBACK_MS) return null
  const device = req.device_id ? ctx.deviceById.get(req.device_id) : undefined
  const typeLabel = requestTypeLabel(req.type)
  const detailParts: string[] = []
  if (req.type === 'extra_time' && typeof req.minutes === 'number') {
    detailParts.push(`Xin thêm ${formatMinutes(req.minutes)} phút`)
  }
  if (req.type === 'unblock_domain' && req.domain) {
    detailParts.push(`Trang web: ${req.domain}`)
  }
  const reason = (req.reason ?? '').trim()
  if (reason) detailParts.push(`Lý do: ${reason}`)
  return {
    id: `req:${req.id}`,
    kind: 'request',
    at: req.created_at,
    atMs: createdMs,
    childId: req.child_id,
    childName: ctx.childNameById.get(req.child_id) ?? null,
    deviceId: req.device_id ?? null,
    deviceName: device?.hostname ?? null,
    title: typeLabel,
    detail: detailParts.length > 0 ? detailParts.join(' · ') : null,
    link: '/yeu-cau',
    linkLabel: 'Xem yêu cầu',
  }
}

/** Một hàng audit_logs can thiệp thành một mục thông báo; null khi action lạ hoặc ngoài cửa sổ 30 ngày. */
export function tamperLogToNotification(
  log: AuditLog,
  ctx: NotificationContext,
  deviceChildById: ReadonlyMap<string, string>,
  nowMs: number,
): NotificationItem | null {
  if (!(TAMPER_ACTIONS as readonly string[]).includes(log.action)) return null
  const createdMs = parseMs(log.created_at)
  if (createdMs === null || createdMs > nowMs || nowMs - createdMs > NOTIFICATION_LOOKBACK_MS) return null
  const childId = log.child_id ?? (log.target ? (deviceChildById.get(log.target) ?? null) : null)
  const deviceId = log.device_id ?? (log.target && ctx.deviceById.has(log.target) ? log.target : null)
  const device = deviceId !== null ? ctx.deviceById.get(deviceId) : undefined
  const details = asRecord(log.details) ?? {}
  let detail: string | null = null
  if (log.action === 'clock_drift') {
    const drift = driftMinutes(log.details)
    if (drift !== null) detail = `Đồng hồ máy lệch ${formatMinutes(Math.abs(drift))} phút so với giờ máy chủ`
  } else if (log.action === 'agent_restart') {
    const version = asString(details['agent_version'])
    if (version !== null) detail = `Phiên bản Agent ${version}`
  }
  return {
    id: `log:${log.id}`,
    kind: 'tamper',
    at: log.created_at,
    atMs: createdMs,
    childId,
    childName: childId !== null ? (ctx.childNameById.get(childId) ?? null) : null,
    deviceId,
    deviceName: device?.hostname ?? null,
    title: tamperEventLabel(log.action),
    detail,
    link: '/nhat-ky',
    linkLabel: 'Xem nhật ký',
  }
}

/** Một máy offline quá 48 giờ thành một mục thông báo; null khi chưa quá ngưỡng. */
export function deviceOfflineToNotification(
  device: Device,
  ctx: NotificationContext,
  nowMs: number,
): NotificationItem | null {
  const key = offlineEpisodeKey(device, nowMs)
  if (key === null) return null
  const seenMs = parseMs(device.last_seen_at)
  if (seenMs === null) return null
  const atMs = seenMs + OFFLINE_AFTER_MS
  return {
    id: `offline:${key}`,
    kind: 'device_offline',
    at: new Date(atMs).toISOString(),
    atMs,
    childId: device.child_id,
    childName: device.child_id !== null ? (ctx.childNameById.get(device.child_id) ?? null) : null,
    deviceId: device.id,
    deviceName: device.hostname,
    title: 'Máy offline hơn 48 giờ',
    detail: `Thấy lần cuối ${formatDateTimeVi(device.last_seen_at)}`,
    link: device.child_id !== null ? `/ho-so/${device.child_id}/thiet-bi` : '/thiet-bi',
    linkLabel: 'Xem máy',
  }
}

/** Gộp 3 nguồn thành một danh sách, mới nhất trước; cùng mốc giờ thì id lớn trước (ổn định). */
export function buildNotificationItems(
  requests: readonly AppRequest[],
  logs: readonly AuditLog[],
  devices: readonly Device[],
  ctx: NotificationContext,
  nowMs: number,
): NotificationItem[] {
  const deviceChildById = new Map(
    devices.filter((d) => d.child_id !== null).map((d) => [d.id, d.child_id as string]),
  )
  const items: NotificationItem[] = []
  for (const req of requests) {
    const item = requestToNotification(req, ctx, nowMs)
    if (item !== null) items.push(item)
  }
  for (const log of logs) {
    const item = tamperLogToNotification(log, ctx, deviceChildById, nowMs)
    if (item !== null) items.push(item)
  }
  for (const device of devices) {
    const item = deviceOfflineToNotification(device, ctx, nowMs)
    if (item !== null) items.push(item)
  }
  return items.sort((a, b) => {
    if (b.atMs !== a.atMs) return b.atMs - a.atMs
    return b.id < a.id ? -1 : b.id > a.id ? 1 : 0
  })
}

/**
 * Mục này có tính là chưa đọc không. Chưa có mốc (watermarkMs = null,
 * chưa từng bấm "đã đọc") thì mọi mục trong cửa sổ đều chưa đọc. Mục
 * đúng bằng mốc (tạo đúng lúc bấm) tính là đã đọc — bấm "đánh dấu tất
 * cả" phải xóa sạch huy hiệu ngay lúc đó.
 */
export function isUnread(item: NotificationItem, watermarkMs: number | null): boolean {
  if (watermarkMs === null) return true
  return item.atMs > watermarkMs
}

export function countUnread(items: readonly NotificationItem[], watermarkMs: number | null): number {
  let count = 0
  for (const item of items) {
    if (isUnread(item, watermarkMs)) count++
  }
  return count
}

/** Số hiện trên huy hiệu đỏ: quá 99 thì "99+". */
export function formatBadgeCount(count: number): string {
  return count > 99 ? '99+' : String(count)
}

/**
 * Lỗi này có phải là "bảng chưa tồn tại" (migration 20 chưa áp) không?
 * PostgREST báo mã PGRST205 kèm thông điệp nêu tên bảng; nhận diện theo
 * mã hoặc tên bảng trong thông điệp (cùng mẫu nhận diện thiếu migration
 * ở các tab khác). Lỗi khác (mạng, quyền) thì không nhận nhầm.
 */
export function isMissingTableError(error: unknown, table: string): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as { message?: unknown; code?: unknown }
  if (typeof record.code === 'string' && record.code === 'PGRST205') return true
  const message = typeof record.message === 'string' ? record.message : ''
  // Chỉ nhận đúng hình dạng "không tìm thấy bảng" của PostgREST — lỗi
  // khác có nhắc tên bảng (vd lỗi quyền) không được nhận nhầm.
  return message.includes('Could not find the table') && message.includes(table)
}

/** Phát sự kiện "đã đánh dấu đã đọc" để chuông ở header tải lại số chưa đọc. */
export function notifyNotificationsRead(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(NOTIFICATIONS_READ_EVENT))
  }
}

// ---------------------------------------------------------------------------
// Tải dữ liệu (dùng chung cho chuông ở header và trang Thông báo)
// ---------------------------------------------------------------------------

// PostgREST trả tối đa 1000 hàng mỗi lần gọi nên đọc theo trang, cùng
// mẫu trang Nhật ký: 20 trang cho mỗi bảng; chạm trần thì báo truncated.
const PAGE_SIZE = 1000
const MAX_PAGES = 20

async function fetchRequestsPage(
  client: SupabaseClient,
  startIso: string,
): Promise<{ rows: AppRequest[]; truncated: boolean }> {
  const rows: AppRequest[] = []
  let truncated = false
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await client
      .from('requests')
      .select('id, family_id, child_id, type, status, reason, decided_by, decided_at, created_at, minutes, device_id')
      .eq('status', 'pending')
      .gte('created_at', startIso)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (error) throw error
    const pageRows = (data ?? []) as AppRequest[]
    rows.push(...pageRows)
    if (pageRows.length >= PAGE_SIZE && page + 1 >= MAX_PAGES) truncated = true
    if (pageRows.length < PAGE_SIZE) break
  }
  return { rows, truncated }
}

async function fetchTamperLogsPage(
  client: SupabaseClient,
  startIso: string,
): Promise<{ rows: AuditLog[]; truncated: boolean }> {
  const rows: AuditLog[] = []
  let truncated = false
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await client
      .from('audit_logs')
      .select('id, family_id, actor, action, target, ip_hash, created_at, child_id, device_id, details')
      .in('action', [...TAMPER_ACTIONS])
      .gte('created_at', startIso)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (error) throw error
    const pageRows = (data ?? []) as AuditLog[]
    rows.push(...pageRows)
    if (pageRows.length >= PAGE_SIZE && page + 1 >= MAX_PAGES) truncated = true
    if (pageRows.length < PAGE_SIZE) break
  }
  return { rows, truncated }
}

/** Đọc cột domain cho các yêu cầu đã lấy, theo từng nhóm 200 id (cùng mẫu trang Nhật ký). Lỗi thì bỏ qua. */
async function mergeRequestDomains(client: SupabaseClient, rows: AppRequest[]): Promise<void> {
  if (rows.length === 0) return
  const byId = new Map(rows.map((row) => [row.id, row]))
  try {
    const ids = [...byId.keys()]
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200)
      const { data, error } = await client.from('requests').select('id, domain').in('id', chunk)
      if (error) return
      for (const row of (data ?? []) as Array<{ id: string; domain: string | null }>) {
        const existing = byId.get(row.id)
        if (existing) existing.domain = row.domain
      }
    }
  } catch {
    // Chưa có cột hoặc lỗi mạng: giữ nguyên yêu cầu không có tên miền.
  }
}

export interface NotificationLoadResult {
  items: NotificationItem[]
  /** Mốc đã đọc dạng mili-giây; null khi chưa có hàng mốc nào. */
  watermarkMs: number | null
  /** true khi đã chạm giới hạn đọc — có thể còn sự kiện chưa tải hết. */
  truncated: boolean
  /** true khi bảng notification_reads chưa tồn tại (migration 20 chưa áp). */
  missingMigration: boolean
}

/**
 * Tải toàn bộ dữ liệu cho mục Thông báo: con + máy, yêu cầu chờ duyệt,
 * cảnh báo can thiệp trong 30 ngày, và mốc đã đọc của user. RLS lo tách
 * dữ liệu theo gia đình; mốc đọc tách theo user (policy của migration 20).
 * Bảng mốc đọc chưa tồn tại thì trả missingMigration thay vì ném lỗi —
 * trang hiện hướng dẫn áp migration, chuông ẩn huy hiệu.
 */
export async function loadNotifications(
  client: SupabaseClient,
  userId: string,
  nowMs: number = Date.now(),
): Promise<NotificationLoadResult> {
  const startIso = new Date(nowMs - NOTIFICATION_LOOKBACK_MS).toISOString()
  const [childrenResult, devicesResult, requestsResult, logsResult, watermarkResult] = await Promise.all([
    client.from('children').select('id, display_name').order('created_at', { ascending: true }),
    client
      .from('devices')
      .select('id, family_id, child_id, hostname, os_version, agent_version, last_seen_at, last_extension_seen_at, status, created_at')
      .order('created_at', { ascending: true }),
    fetchRequestsPage(client, startIso),
    fetchTamperLogsPage(client, startIso),
    client.from(NOTIFICATION_READS_TABLE).select('read_at').eq('user_id', userId).maybeSingle(),
  ])
  if (childrenResult.error) throw childrenResult.error
  if (devicesResult.error) throw devicesResult.error
  const children = (childrenResult.data ?? []) as Pick<Child, 'id' | 'display_name'>[]
  const devices = (devicesResult.data ?? []) as Device[]
  await mergeRequestDomains(client, requestsResult.rows)
  const items = buildNotificationItems(
    requestsResult.rows,
    logsResult.rows,
    devices,
    {
      childNameById: new Map(children.map((c) => [c.id, c.display_name])),
      deviceById: new Map(devices.map((d) => [d.id, d])),
    },
    nowMs,
  )
  const truncated = requestsResult.truncated || logsResult.truncated
  if (watermarkResult.error) {
    if (isMissingTableError(watermarkResult.error, NOTIFICATION_READS_TABLE)) {
      // Mốc đọc chưa có bảng: vẫn trả danh sách sự kiện (đọc được) kèm
      // cờ thiếu migration — trang quyết định hiện gì; chuông ẩn huy hiệu.
      return { items, watermarkMs: null, truncated, missingMigration: true }
    }
    throw watermarkResult.error
  }
  const readAt = (watermarkResult.data as NotificationRead | null)?.read_at ?? null
  return { items, watermarkMs: parseMs(readAt), truncated, missingMigration: false }
}

/**
 * Đánh dấu tất cả đã đọc: upsert mốc = thời điểm hiện tại. Trả về true
 * khi bảng mốc đọc chưa tồn tại (migration 20 chưa áp) để giao diện
 * hiện hướng dẫn thay vì lỗi chung; lỗi khác thì ném ra.
 */
export async function markAllNotificationsRead(
  client: SupabaseClient,
  userId: string,
  nowIso: string = new Date().toISOString(),
): Promise<{ missingMigration: boolean }> {
  const { error } = await client
    .from(NOTIFICATION_READS_TABLE)
    .upsert({ user_id: userId, read_at: nowIso }, { onConflict: 'user_id' })
  if (error) {
    if (isMissingTableError(error, NOTIFICATION_READS_TABLE)) return { missingMigration: true }
    throw error
  }
  return { missingMigration: false }
}
