import type {
  AppRequest,
  AppUsage,
  AuditLog,
  Child,
  Command,
  Device,
  Message,
  NotificationSend,
  PairingCode,
  Rule,
  RuleObservation,
  TimeBankGrant,
  WebVisit,
} from './types'

/**
 * Logic thuần cho tab Dữ liệu trong hồ sơ con (PRD §2.8: xuất dữ liệu
 * và xóa toàn bộ dữ liệu của con).
 *
 * - Xuất dữ liệu: Dashboard đọc các bảng qua RLS (chỉ dữ liệu của đúng
 *   gia đình) rồi đóng gói thành một file JSON. Không có mã server mới
 *   cho phần xuất; file này chỉ lo đóng gói + loại bỏ hash nhạy cảm.
 * - Xóa dữ liệu: gọi RPC safepc_delete_child_data (migration 15). File
 *   này chỉ lo kiểm tra xác nhận gõ tên + hình dạng kết quả trả về.
 */

// Các mục dữ liệu của một con, theo đúng thứ tự hiển thị trong tab.
export type ChildDataSectionKey =
  | 'devices'
  | 'rules'
  | 'requests'
  | 'commands'
  | 'app_usage'
  | 'web_visits'
  | 'rule_observations'
  | 'messages'
  | 'audit_logs'
  | 'time_bank_grants'
  | 'notification_sends'
  | 'pairing_codes'

export const CHILD_DATA_SECTIONS: Array<{
  key: ChildDataSectionKey
  label: string
  description: string
}> = [
  { key: 'devices', label: 'Thiết bị', description: 'Máy đã ghép nối cho con.' },
  { key: 'rules', label: 'Quy tắc', description: 'Quy tắc giờ giấc, app và website của con.' },
  { key: 'requests', label: 'Yêu cầu', description: 'Yêu cầu xin thêm giờ / xin mở app của con.' },
  { key: 'commands', label: 'Lệnh', description: 'Lệnh phụ huynh đã gửi xuống máy của con.' },
  { key: 'app_usage', label: 'Lịch sử dùng app', description: 'Thời gian dùng từng app trên máy của con.' },
  { key: 'web_visits', label: 'Lịch sử web', description: 'Tên miền và đường dẫn đã xem (đường dẫn bỏ phần truy vấn, chỉ có từ bản extension mới).' },
  { key: 'rule_observations', label: 'Quan sát luật không chặn', description: 'Ghi nhận khi con dùng app/website thuộc diện luật lúc luật đang tắt, được cho phép tạm thời hoặc không chặn được (migration 31).' },
  { key: 'messages', label: 'Tin nhắn', description: 'Tin nhắn hai chiều giữa phụ huynh và con trong kênh nhắn tin của SafePC.' },
  { key: 'audit_logs', label: 'Nhật ký kiểm tra', description: 'Sự kiện can thiệp và thi hành gắn với con.' },
  { key: 'time_bank_grants', label: 'Thưởng giờ', description: 'Lịch sử thưởng / thu hồi giờ của ngân hàng giờ.' },
  { key: 'notification_sends', label: 'Thông báo đã gửi', description: 'Email thông báo đã gửi gắn với con.' },
  { key: 'pairing_codes', label: 'Mã ghép nối', description: 'Mã ghép nối đã tạo cho con (chỉ còn thông tin, không còn mã).' },
]

export function sectionLabel(key: ChildDataSectionKey): string {
  return CHILD_DATA_SECTIONS.find((s) => s.key === key)?.label ?? key
}

/** Trạng thái đọc của một mục khi xuất: đủ, bị cắt ở trần trang, hoặc không đọc được. */
export type ChildDataSectionStatus = 'ok' | 'truncated' | 'unavailable'

export interface ChildDataExportSection {
  status: ChildDataSectionStatus
  /** Lý do khi status là 'unavailable' (vd bảng chưa tồn tại vì migration chưa áp dụng). */
  reason?: string
  rows: Array<Record<string, unknown>>
}

/**
 * File xuất dữ liệu của một con (JSON, version 1). Mọi hàng đều thuộc
 * đúng con đó và đúng gia đình của người xuất (RLS bảo đảm ở tầng đọc).
 * Các hash nhạy cảm KHÔNG có trong file này — xem `excluded`.
 */
export interface ChildDataExport {
  format: 'safepc-child-data-export'
  version: 1
  exported_at: string
  child: {
    id: string
    family_id: string
    display_name: string
    birth_year: number | null
    created_at: string
  }
  sections: Record<ChildDataSectionKey, ChildDataExportSection>
  /** Những gì cố tình không xuất, để người đọc file không hiểu nhầm là thiếu. */
  excluded: string[]
}

export interface ChildDataExportInput {
  exportedAt: string
  child: Child
  devices: Device[]
  rules: Rule[]
  requests: AppRequest[]
  commands: Command[]
  appUsage: AppUsage[]
  webVisits: WebVisit[]
  ruleObservations: RuleObservation[]
  messages: Message[]
  auditLogs: AuditLog[]
  timeBankGrants: TimeBankGrant[]
  notificationSends: NotificationSend[]
  pairingCodes: PairingCode[]
  truncatedSections: ChildDataSectionKey[]
  unavailableSections: Array<{ section: ChildDataSectionKey; reason: string }>
}

const EXCLUDED_NOTES = [
  'device_tokens: hash token của máy — thông tin xác thực, không có giá trị xuất dữ liệu.',
  'devices.exit_pin_hash: hash mã PIN thoát Tray — thông tin xác thực, không xuất.',
  'pairing_codes.code_hash: hash mã ghép nối — mã thô không bao giờ lưu, hash không có giá trị xuất.',
  'chat_sessions: phiên nhắn tin của con — chứa hash token phiên, là thông tin xác thực, không xuất (như device_tokens).',
  'Dữ liệu cấp gia đình (mẫu quy tắc, lời mời, lịch sử gửi email báo cáo tuần) không thuộc về riêng con nên không có trong file này.',
]

/**
 * Loại hash mã PIN khỏi hàng thiết bị trước khi xuất. Truy vấn xuất đã
 * không SELECT cột này; hàm này là lớp phòng thủ thứ hai nếu dữ liệu
 * đầu vào vô tình mang theo hash (vd tái dùng kiểu Device đầy đủ).
 */
export function sanitizeDeviceForExport(device: Device): Record<string, unknown> {
  const { exit_pin_hash: _removed, ...rest } = device as Device & Record<string, unknown>
  void _removed
  return rest as Record<string, unknown>
}

/**
 * Loại hash mã ghép nối khỏi hàng mã trước khi xuất. Truy vấn xuất đã
 * không SELECT cột này; hàm này là lớp phòng thủ thứ hai.
 */
export function sanitizePairingCodeForExport(
  code: PairingCode & { code_hash?: unknown },
): Record<string, unknown> {
  const { code_hash: _removed, ...rest } = code as PairingCode & Record<string, unknown>
  void _removed
  return rest as Record<string, unknown>
}

function toRow<T>(row: T): Record<string, unknown> {
  return { ...(row as Record<string, unknown>) }
}

export function buildChildDataExport(input: ChildDataExportInput): ChildDataExport {
  const truncated = new Set(input.truncatedSections)
  const unavailable = new Map(input.unavailableSections.map((u) => [u.section, u.reason]))
  const section = (
    key: ChildDataSectionKey,
    rows: Array<Record<string, unknown>>,
  ): ChildDataExportSection => {
    const reason = unavailable.get(key)
    if (reason !== undefined) return { status: 'unavailable', reason, rows: [] }
    if (truncated.has(key)) return { status: 'truncated', rows }
    return { status: 'ok', rows }
  }
  return {
    format: 'safepc-child-data-export',
    version: 1,
    exported_at: input.exportedAt,
    child: {
      id: input.child.id,
      family_id: input.child.family_id,
      display_name: input.child.display_name,
      birth_year: input.child.birth_year,
      created_at: input.child.created_at,
    },
    sections: {
      devices: section('devices', input.devices.map(sanitizeDeviceForExport)),
      rules: section('rules', input.rules.map(toRow)),
      requests: section('requests', input.requests.map(toRow)),
      commands: section('commands', input.commands.map(toRow)),
      app_usage: section('app_usage', input.appUsage.map(toRow)),
      web_visits: section('web_visits', input.webVisits.map(toRow)),
      rule_observations: section('rule_observations', input.ruleObservations.map(toRow)),
      messages: section('messages', input.messages.map(toRow)),
      audit_logs: section('audit_logs', input.auditLogs.map(toRow)),
      time_bank_grants: section('time_bank_grants', input.timeBankGrants.map(toRow)),
      notification_sends: section('notification_sends', input.notificationSends.map(toRow)),
      pairing_codes: section('pairing_codes', input.pairingCodes.map(sanitizePairingCodeForExport)),
    },
    excluded: [...EXCLUDED_NOTES],
  }
}

/** 'Diệu Linh' -> 'dieu-linh'; tên rỗng/toàn ký tự lạ -> 'con'. */
export function slugifyChildName(displayName: string): string {
  const slug = displayName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'con' : slug
}

/** 'safepc-du-lieu-dieu-linh-20261118-1830.json' (giờ địa phương của trình duyệt). */
export function buildChildDataExportFilename(displayName: string, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `safepc-du-lieu-${slugifyChildName(displayName)}-${stamp}.json`
}

/**
 * Xác nhận xóa: phụ huynh phải gõ đúng tên hiển thị của con. So sánh
 * sau khi cắt khoảng trắng hai đầu và gõ thường (không phân biệt hoa
 * thường), nhưng dấu tiếng Việt phải đúng — 'Dieu Linh' không khớp
 * 'Diệu Linh'. Chuỗi rỗng không bao giờ khớp.
 */
export function matchesChildNameForDelete(input: string, displayName: string): boolean {
  const typed = input.trim().toLocaleLowerCase()
  const expected = displayName.trim().toLocaleLowerCase()
  return typed !== '' && typed === expected
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Chuỗi lọc PostgREST cho các bảng vừa gắn con vừa gắn máy
 * (audit_logs, notification_sends), phản chiếu ĐÚNG phạm vi xóa của
 * RPC safepc_delete_child_data: hàng gắn trực tiếp với con, hoặc hàng
 * không gắn con nào nhưng gắn với một máy của con. Hàng mang child_id
 * của con khác không bao giờ khớp. Ném lỗi nếu id nào không đúng dạng
 * UUID — không bao giờ nội suy chuỗi chưa kiểm chứng vào chuỗi lọc.
 * Khi con chưa có máy nào thì chỉ còn nhánh gắn trực tiếp với con.
 */
export function buildChildOrDeviceFilter(childId: string, deviceIds: string[]): string {
  if (!UUID_PATTERN.test(childId)) throw new Error('ID hồ sơ không hợp lệ.')
  for (const deviceId of deviceIds) {
    if (!UUID_PATTERN.test(deviceId)) throw new Error('ID thiết bị không hợp lệ.')
  }
  if (deviceIds.length === 0) return `child_id.eq.${childId}`
  return `child_id.eq.${childId},and(child_id.is.null,device_id.in.(${deviceIds.join(',')}))`
}

/** Hình dạng JSONB mà RPC safepc_delete_child_data trả về (migration 15). */
export interface ChildDataDeleteCounts {
  devices: number
  rules: number
  requests: number
  time_bank_grants: number
  app_usage: number
  web_visits: number
  commands: number
  device_tokens: number
  audit_logs: number
  notification_sends: number
  pairing_codes: number
  /**
   * Số tin nhắn + phiên nhắn tin đã xóa (migration 29). TÙY CHỌN: khi
   * server chưa áp migration 29, RPC vẫn là bản migration 15 và không
   * trả hai khóa này — kết quả xóa vẫn hợp lệ, chỉ thiếu hai dòng này.
   */
  messages?: number
  chat_sessions?: number
  /**
   * Số dòng quan sát luật đã xóa (migration 31). TÙY CHỌN như hai
   * khóa trên: server chưa áp migration 31 thì RPC không trả khóa
   * này.
   */
  rule_observations?: number
}

export interface ChildDataDeleteResult {
  child_id: string
  family_id: string
  deleted: ChildDataDeleteCounts
  skipped_missing_tables: string[]
}

const DELETE_COUNT_KEYS: Array<keyof ChildDataDeleteCounts> = [
  'devices',
  'rules',
  'requests',
  'time_bank_grants',
  'app_usage',
  'web_visits',
  'commands',
  'device_tokens',
  'audit_logs',
  'notification_sends',
  'pairing_codes',
]

const OPTIONAL_DELETE_COUNT_KEYS: Array<'messages' | 'chat_sessions' | 'rule_observations'> = [
  'messages',
  'chat_sessions',
  'rule_observations',
]

/** Kiểm tra kết quả RPC có đúng hình dạng không trước khi hiển thị số liệu. */
export function isChildDataDeleteResult(value: unknown): value is ChildDataDeleteResult {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.child_id !== 'string' || typeof v.family_id !== 'string') return false
  if (!Array.isArray(v.skipped_missing_tables)) return false
  if (typeof v.deleted !== 'object' || v.deleted === null) return false
  const deleted = v.deleted as Record<string, unknown>
  const isCount = (n: unknown) => typeof n === 'number' && Number.isFinite(n as number)
  if (!DELETE_COUNT_KEYS.every((k) => isCount(deleted[k]))) return false
  // Khóa tùy chọn (migration 29): vắng mặt thì thôi, có mặt thì phải
  // là số hợp lệ — không vì thiếu khóa mà báo kết quả xóa bị hỏng.
  return OPTIONAL_DELETE_COUNT_KEYS.every((k) => deleted[k] === undefined || isCount(deleted[k]))
}

/** Nhãn hiển thị cho từng dòng số liệu đã xóa (kể cả device_tokens, mục chỉ có ở kết quả xóa). */
export function deleteCountLabel(key: keyof ChildDataDeleteCounts): string {
  switch (key) {
    case 'device_tokens':
      return 'Token của máy'
    case 'chat_sessions':
      return 'Phiên nhắn tin'
    default:
      return sectionLabel(key as ChildDataSectionKey)
  }
}
