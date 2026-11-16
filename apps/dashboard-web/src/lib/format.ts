import type { DeviceStatus, RequestStatus, RequestType, Rule, RuleType } from './types'

/** Định dạng thời lượng theo tiếng Việt, ví dụ: "1 giờ 20 phút", "45 phút", "30 giây". */
export function formatDurationVi(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) {
    return minutes > 0 ? `${hours} giờ ${minutes} phút` : `${hours} giờ`
  }
  if (minutes > 0) return `${minutes} phút`
  if (seconds > 0) return `${seconds} giây`
  return '0 phút'
}

/** Đầu ngày hôm nay theo giờ địa phương của trình duyệt, dạng ISO (UTC) để query Supabase. */
export function startOfTodayIso(): string {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
  return start.toISOString()
}

export function formatDateTimeVi(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatTimeVi(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
}

/** Mô tả tương đối: "vừa xong", "5 phút trước", "2 giờ trước", hoặc ngày giờ đầy đủ. */
export function formatRelativeVi(iso: string | null | undefined): string {
  if (!iso) return 'Chưa từng kết nối'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const diffMs = Date.now() - date.getTime()
  if (diffMs < 0) return formatDateTimeVi(iso)
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'Vừa xong'
  if (diffMin < 60) return `${diffMin} phút trước`
  const diffHours = Math.floor(diffMin / 60)
  if (diffHours < 24) return `${diffHours} giờ trước`
  return formatDateTimeVi(iso)
}

export function deviceStatusLabel(status: DeviceStatus): string {
  switch (status) {
    case 'online':
      return 'Đang online'
    case 'offline':
      return 'Offline'
    case 'locked':
      return 'Đang bị khóa'
  }
}

export function ruleTypeLabel(type: RuleType): string {
  switch (type) {
    case 'daily_limit':
      return 'Giới hạn giờ/ngày'
    case 'bedtime':
      return 'Giờ ngủ / giờ cấm'
    case 'app':
      return 'Quy tắc ứng dụng'
    case 'website':
      return 'Quy tắc website'
  }
}

export function requestTypeLabel(type: RequestType): string {
  switch (type) {
    case 'extra_time':
      return 'Xin thêm giờ'
    case 'unblock_app':
      return 'Xin mở ứng dụng'
  }
}

export function requestStatusLabel(status: RequestStatus): string {
  switch (status) {
    case 'pending':
      return 'Đang chờ duyệt'
    case 'approved':
      return 'Đã duyệt'
    case 'denied':
      return 'Đã từ chối'
  }
}

function configValue(config: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = config[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/**
 * Trình bày config JSONB của rule thành các dòng dễ đọc.
 * Ưu tiên các key quen thuộc theo từng loại rule; các key còn lại hiển thị
 * dạng "key: giá trị". Không dùng dangerouslySetInnerHTML — React tự escape.
 */
export function describeRuleConfig(rule: Rule): string[] {
  const config = rule.config ?? {}
  const lines: string[] = []

  if (rule.type === 'daily_limit') {
    const minutes = configValue(config, ['minutes_per_day', 'minutes', 'daily_minutes', 'limit_minutes'])
    if (minutes !== undefined) {
      const n = Number(minutes)
      lines.push(`Giới hạn: ${Number.isFinite(n) ? formatDurationVi(n * 60) : asText(minutes)} mỗi ngày`)
    }
  }

  if (rule.type === 'bedtime') {
    const start = configValue(config, ['start_time', 'start', 'bedtime_start', 'from'])
    const end = configValue(config, ['end_time', 'end', 'bedtime_end', 'to'])
    if (start !== undefined || end !== undefined) {
      lines.push(`Khung giờ cấm: ${start !== undefined ? asText(start) : '?'} – ${end !== undefined ? asText(end) : '?'}`)
    }
  }

  if (rule.type === 'app') {
    const app = configValue(config, ['app_name', 'app', 'name', 'process_name'])
    if (app !== undefined) lines.push(`Ứng dụng: ${asText(app)}`)
    const action = configValue(config, ['action'])
    if (action !== undefined) lines.push(`Hành động: ${asText(action)}`)
    const minutes = configValue(config, ['minutes_per_day', 'minutes', 'limit_minutes'])
    if (minutes !== undefined) {
      const n = Number(minutes)
      lines.push(`Giới hạn: ${Number.isFinite(n) ? formatDurationVi(n * 60) : asText(minutes)} mỗi ngày`)
    }
  }

  if (rule.type === 'website') {
    const domain = configValue(config, ['domain', 'website', 'url', 'host'])
    if (domain !== undefined) lines.push(`Website: ${asText(domain)}`)
    const action = configValue(config, ['action'])
    if (action !== undefined) lines.push(`Hành động: ${asText(action)}`)
  }

  // Các key chưa được trình bày ở trên: liệt kê nốt để không giấu thông tin.
  const shown = new Set([
    'minutes_per_day', 'minutes', 'daily_minutes', 'limit_minutes',
    'start_time', 'start', 'bedtime_start', 'from',
    'end_time', 'end', 'bedtime_end', 'to',
    'app_name', 'app', 'name', 'process_name', 'action',
    'domain', 'website', 'url', 'host',
  ])
  for (const [key, value] of Object.entries(config)) {
    if (!shown.has(key)) lines.push(`${key}: ${asText(value)}`)
  }

  if (lines.length === 0) lines.push('Chưa có cấu hình chi tiết.')
  return lines
}

/** Dịch thông báo lỗi thường gặp (Supabase Auth / mạng) sang tiếng Việt. */
export function toVietnameseError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const message = raw.trim()
  if (!message) return 'Đã xảy ra lỗi không xác định. Vui lòng thử lại.'
  if (/failed to fetch|networkerror|network request failed/i.test(message)) {
    return 'Không kết nối được tới máy chủ. Vui lòng kiểm tra mạng và cấu hình Supabase, rồi thử lại.'
  }
  const translations: Array<[RegExp, string]> = [
    [/invalid login credentials/i, 'Email hoặc mật khẩu không đúng. Vui lòng kiểm tra lại.'],
    [/email not confirmed/i, 'Email chưa được xác minh. Vui lòng kiểm tra hộp thư và bấm link xác minh.'],
    [/user already registered/i, 'Email này đã được đăng ký. Vui lòng đăng nhập hoặc dùng chức năng quên mật khẩu.'],
    [/password should be at least/i, 'Mật khẩu quá ngắn. Vui lòng dùng mật khẩu dài hơn (tối thiểu 6 ký tự).'],
    [/invalid email/i, 'Địa chỉ email không hợp lệ.'],
    [/too many requests|rate limit/i, 'Bạn đã thử quá nhiều lần. Vui lòng chờ một lúc rồi thử lại.'],
    [/user not found/i, 'Không tìm thấy tài khoản với email này.'],
    [/same password/i, 'Mật khẩu mới không được trùng mật khẩu cũ.'],
    [/expired|invalid.*token|otp expired/i, 'Link hoặc mã đã hết hạn. Vui lòng yêu cầu link mới.'],
    [/row-level security|permission denied|violates row-level/i, 'Bạn không có quyền xem/thay đổi dữ liệu này. Vui lòng kiểm tra tài khoản và gia đình của bạn.'],
  ]
  for (const [pattern, text] of translations) {
    if (pattern.test(message)) return text
  }
  return message
}
