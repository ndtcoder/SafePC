import type { DeviceStatus, EnforcementSnapshot, RequestStatus, RequestType, Rule, RuleType, TemporaryOverrideAction } from './types'
import {
  formatWeekdayGroup,
  groupWeekdays,
  hhmmToMinutes,
  domainCategoryLabel,
  parseAppConfig,
  parseBedtimeConfig,
  parseDailyLimitConfig,
  parseTimeWindowConfig,
  parseWebsiteConfig,
  type AppConfig,
  type AppEntry,
  type BedtimeByWeekday,
  type MinutesByWeekday,
  type TimeRangeValue,
  type WebsiteConfig,
  type WeekdayNumber,
  type WindowsByWeekday,
} from './ruleConfig'

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
    case 'time_window':
      return 'Khung giờ được dùng máy'
    case 'app':
      return 'Quy tắc ứng dụng'
    case 'website':
      return 'Quy tắc website'
  }
}

export function overrideActionLabel(action: TemporaryOverrideAction): string {
  switch (action) {
    case 'bonus_minutes':
      return 'Cộng thêm giờ'
    case 'lock':
      return 'Khóa máy tạm thời'
    case 'unlock':
      return 'Tạm mở máy (ngưng quy tắc giờ giấc)'
    case 'allow_domain':
      return 'Cho phép website tạm thời'
    case 'block_domain':
      return 'Chặn website tạm thời'
    case 'block_app':
      return 'Chặn ứng dụng tạm thời'
    case 'allow_app':
      return 'Cho phép ứng dụng tạm thời'
    case 'cancel':
      return 'Hủy ghi đè tạm thời'
  }
}

export function requestTypeLabel(type: RequestType): string {
  switch (type) {
    case 'extra_time':
      return 'Xin thêm giờ'
    case 'unblock_app':
      return 'Xin mở ứng dụng'
    case 'unblock_domain':
      return 'Xin mở trang web'
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

function fullWeek<T>(byWeekday: Partial<Record<WeekdayNumber, T>>, fallback: T): Record<WeekdayNumber, T> {
  return {
    0: byWeekday[0] ?? fallback,
    1: byWeekday[1] ?? fallback,
    2: byWeekday[2] ?? fallback,
    3: byWeekday[3] ?? fallback,
    4: byWeekday[4] ?? fallback,
    5: byWeekday[5] ?? fallback,
    6: byWeekday[6] ?? fallback,
  }
}

/** "Thứ 2–6: 2 giờ mỗi ngày; Thứ 7–Chủ nhật: không giới hạn". Ngày vắng mặt = không giới hạn. */
function describeDailyLimit(parsed: MinutesByWeekday): string[] {
  const perDay = fullWeek<number | null>(parsed, null)
  return groupWeekdays(perDay, (v) => (v === null ? 'none' : String(v))).map((group) =>
    group.value === null
      ? `${formatWeekdayGroup(group.days)}: không giới hạn`
      : `${formatWeekdayGroup(group.days)}: ${formatDurationVi(group.value * 60)} mỗi ngày`,
  )
}

/** "Thứ 2–6: cấm 21:00–07:00 (qua đêm); Thứ 7–Chủ nhật: không có giờ ngủ". Ngày vắng mặt = không khóa. */
function describeBedtime(parsed: BedtimeByWeekday): string[] {
  const perDay = fullWeek<TimeRangeValue | null>(parsed, null)
  return groupWeekdays(perDay, (v) => (v === null ? 'none' : `${v.start}-${v.end}`)).map((group) => {
    if (group.value === null) return `${formatWeekdayGroup(group.days)}: không có giờ ngủ`
    const overnight = hhmmToMinutes(group.value.end) <= hhmmToMinutes(group.value.start)
    return `${formatWeekdayGroup(group.days)}: cấm ${group.value.start}–${group.value.end}${overnight ? ' (qua đêm sang hôm sau)' : ''}`
  })
}

/**
 * "Thứ 2–6: được dùng 07:00–21:00; Chủ nhật: không được dùng máy".
 * Ngày vắng mặt = KHÔNG được dùng máy ngày đó (khác với daily_limit).
 */
function describeTimeWindow(parsed: WindowsByWeekday): string[] {
  const perDay = fullWeek<TimeRangeValue[] | null>(parsed, null)
  return groupWeekdays(perDay, (v) => (v === null ? 'none' : JSON.stringify(v))).map((group) => {
    if (group.value === null) return `${formatWeekdayGroup(group.days)}: không được dùng máy`
    const ranges = group.value.map((r) => `${r.start}–${r.end}`).join(', ')
    return `${formatWeekdayGroup(group.days)}: được dùng ${ranges}`
  })
}

/** "Game (game.exe)" khi tên hiển thị khác tên file, ngược lại chỉ tên file. */
function formatAppEntry(app: AppEntry): string {
  return app.name !== '' && app.name !== app.exe ? `${app.name} (${app.exe})` : app.exe
}

/**
 * Mô tả quy tắc ứng dụng theo chế độ (mode). Không bao giờ throw: config
 * thiếu/khuyết được mô tả bằng câu chung chung.
 */
function describeAppConfig(parsed: AppConfig): string[] {
  switch (parsed.mode) {
    case 'app_time_limit': {
      if (parsed.apps.length === 0) {
        return ['Giới hạn thời gian theo ứng dụng (chưa có ứng dụng nào).']
      }
      return parsed.apps.map((app) =>
        app.minutesPerDay <= 0
          ? `${formatAppEntry(app)}: chưa đặt số phút.`
          : `${formatAppEntry(app)}: tối đa ${formatDurationVi(app.minutesPerDay * 60)} mỗi ngày`,
      )
    }
    case 'app_block_by_time': {
      const lines: string[] = []
      if (parsed.apps.length === 0) {
        lines.push('Chặn ứng dụng theo giờ (chưa có ứng dụng nào).')
      } else {
        lines.push(`Ứng dụng: ${parsed.apps.map(formatAppEntry).join(', ')}`)
      }
      const perDay = fullWeek<TimeRangeValue[] | null>(parsed.windowsByWeekday, null)
      for (const group of groupWeekdays(perDay, (v) => (v === null ? 'none' : JSON.stringify(v)))) {
        if (group.value === null) {
          lines.push(`${formatWeekdayGroup(group.days)}: bị chặn cả ngày`)
        } else {
          const ranges = group.value.map((r) => `${r.start}–${r.end}`).join(', ')
          lines.push(`${formatWeekdayGroup(group.days)}: chỉ được dùng ${ranges}`)
        }
      }
      return lines
    }
    case 'app_block': {
      if (parsed.apps.length === 0) return ['Chặn ứng dụng (chưa có ứng dụng nào).']
      return [`Chặn: ${parsed.apps.map(formatAppEntry).join(', ')} (mọi lúc, đến khi tắt quy tắc)`]
    }
    case 'app_allowlist': {
      if (parsed.apps.length === 0) return ['Chỉ cho phép một số ứng dụng (chưa có ứng dụng nào).']
      return [
        `Chỉ cho phép: ${parsed.apps.map(formatAppEntry).join(', ')} — mọi ứng dụng khác đều bị đóng`,
      ]
    }
    case 'app_allowlist_by_time': {
      const lines: string[] = []
      if (parsed.apps.length === 0) {
        lines.push('Chỉ cho phép một số ứng dụng theo giờ (chưa có ứng dụng nào).')
      } else {
        lines.push(`Chỉ cho phép: ${parsed.apps.map(formatAppEntry).join(', ')}`)
      }
      const perDay = fullWeek<TimeRangeValue[] | null>(parsed.windowsByWeekday, null)
      for (const group of groupWeekdays(perDay, (v) => (v === null ? 'none' : JSON.stringify(v)))) {
        if (group.value === null) {
          lines.push(`${formatWeekdayGroup(group.days)}: không giới hạn`)
        } else {
          const ranges = group.value.map((r) => `${r.start}–${r.end}`).join(', ')
          lines.push(
            `${formatWeekdayGroup(group.days)}: chỉ các ứng dụng trên được mở ${ranges} (ngoài giờ đó không giới hạn)`,
          )
        }
      }
      return lines
    }
    case 'forced_break': {
      if (parsed.workMinutes <= 0 || parsed.breakMinutes <= 0) {
        return ['Nghỉ bắt buộc (chưa đặt số phút).']
      }
      return [
        `Dùng liên tục ${parsed.workMinutes} phút thì nghỉ ${parsed.breakMinutes} phút (khóa máy).`,
      ]
    }
  }
}

/** Liệt kê domain gọn: tối đa 8 domain, còn lại gộp thành "và N domain khác". */
function formatDomainList(domains: string[]): string {
  if (domains.length <= 8) return domains.join(', ')
  return `${domains.slice(0, 8).join(', ')} và ${domains.length - 8} domain khác`
}

/** Liệt kê đường dẫn gọn: tối đa 8 mục, còn lại gộp thành "và N đường dẫn khác". */
function formatPatternList(patterns: string[]): string {
  if (patterns.length <= 8) return patterns.join(', ')
  return `${patterns.slice(0, 8).join(', ')} và ${patterns.length - 8} đường dẫn khác`
}

/**
 * Mô tả quy tắc website theo chế độ (mode). Không bao giờ throw: config
 * thiếu/khuyết (vd chưa có domain nào) được mô tả bằng câu chung chung.
 * Quy tắc có cả domain và đường dẫn thì liệt kê riêng từng danh sách:
 * domain chặn/cho phép cả domain (kể cả tên miền con), đường dẫn chỉ
 * khớp các link bắt đầu bằng phần đó. Quy tắc chỉ có domain thì mô tả
 * giữ nguyên từng chữ như trước đợt 4.
 */
function describeWebsiteConfig(parsed: WebsiteConfig): string[] {
  switch (parsed.mode) {
    case 'block_domains': {
      const patterns = parsed.urlPatterns ?? []
      const categories = parsed.categories ?? []
      if (parsed.domains.length === 0 && patterns.length === 0 && categories.length === 0) {
        return ['Chặn website (chưa có domain nào).']
      }
      const lines: string[] = []
      if (parsed.domains.length > 0) {
        lines.push(`Chặn: ${formatDomainList(parsed.domains)} (kể cả tên miền con)`)
      }
      if (patterns.length > 0) {
        lines.push(`Chặn: ${formatPatternList(patterns)} (chỉ link bắt đầu bằng phần này)`)
      }
      if (categories.length > 0) {
        lines.push(
          `Chặn danh mục: ${categories.map(domainCategoryLabel).join(', ')} (danh sách domain của SafePC)`,
        )
      }
      return lines
    }
    case 'allowlist': {
      const patterns = parsed.urlPatterns ?? []
      if (parsed.domains.length === 0 && patterns.length === 0) {
        return ['Chỉ cho phép một số website (chưa có domain nào).']
      }
      const lines: string[] = []
      if (parsed.domains.length > 0) {
        lines.push(
          `Chỉ cho phép: ${formatDomainList(parsed.domains)} (kể cả tên miền con) — mọi website khác đều bị chặn`,
        )
      }
      if (patterns.length > 0) {
        lines.push(
          `Chỉ cho phép đường dẫn: ${formatPatternList(patterns)} (chỉ link bắt đầu bằng phần này) — mọi website khác đều bị chặn`,
        )
      }
      return lines
    }
    case 'allowlist_by_time': {
      const patterns = parsed.urlPatterns ?? []
      const lines: string[] = []
      if (parsed.domains.length === 0 && patterns.length === 0) {
        lines.push('Chỉ cho phép một số website theo giờ (chưa có domain nào).')
      } else {
        if (parsed.domains.length > 0) {
          lines.push(`Chỉ cho phép: ${formatDomainList(parsed.domains)} (kể cả tên miền con)`)
        }
        if (patterns.length > 0) {
          lines.push(
            `Chỉ cho phép đường dẫn: ${formatPatternList(patterns)} (chỉ link bắt đầu bằng phần này)`,
          )
        }
      }
      const perDay = fullWeek<TimeRangeValue[] | null>(parsed.windowsByWeekday, null)
      for (const group of groupWeekdays(perDay, (v) => (v === null ? 'none' : JSON.stringify(v)))) {
        if (group.value === null) {
          lines.push(`${formatWeekdayGroup(group.days)}: không giới hạn`)
        } else {
          const ranges = group.value.map((r) => `${r.start}–${r.end}`).join(', ')
          lines.push(
            `${formatWeekdayGroup(group.days)}: chỉ các website trên được mở ${ranges} (ngoài giờ đó không giới hạn)`,
          )
        }
      }
      return lines
    }
    case 'domain_time_limit': {
      const patterns = parsed.urlPatterns ?? []
      if (parsed.domains.length === 0 && patterns.length === 0) {
        return ['Giới hạn thời gian theo website (chưa có domain nào).']
      }
      if (parsed.minutes_per_day <= 0) {
        const lines: string[] = []
        if (parsed.domains.length > 0) {
          lines.push(`Giới hạn ${formatDomainList(parsed.domains)}: chưa đặt số phút.`)
        }
        if (patterns.length > 0) {
          lines.push(`Giới hạn ${formatPatternList(patterns)}: chưa đặt số phút.`)
        }
        return lines
      }
      const lines: string[] = []
      if (parsed.domains.length > 0) {
        lines.push(
          `Giới hạn ${formatDomainList(parsed.domains)}: ${formatDurationVi(parsed.minutes_per_day * 60)} mỗi ngày (tổng cộng các domain)`,
        )
      }
      if (patterns.length > 0) {
        lines.push(
          `Giới hạn ${formatPatternList(patterns)}: ${formatDurationVi(parsed.minutes_per_day * 60)} mỗi ngày (chỉ link bắt đầu bằng phần này)`,
        )
      }
      return lines
    }
    case 'safe_search': {
      const parts: string[] = []
      if (parsed.searchProviders) parts.push('bật SafeSearch cho công cụ tìm kiếm')
      if (parsed.youtubeRestricted) parts.push('bật chế độ hạn chế của YouTube')
      if (parts.length === 0) return ['Tìm kiếm an toàn: cả hai tùy chọn đều đang tắt.']
      return [`Tìm kiếm an toàn: ${parts.join(', ')}`]
    }
    case 'focus': {
      const lines: string[] = []
      if (parsed.allowedDomains.length === 0) {
        lines.push('Giờ học tập trung (chưa có domain nào được phép).')
      } else {
        lines.push(
          `Giờ học tập trung — website được phép: ${formatDomainList(parsed.allowedDomains)} (kể cả tên miền con)`,
        )
      }
      if (parsed.allowedApps.length === 0) {
        lines.push('Ứng dụng được phép: chưa có ứng dụng nào.')
      } else {
        lines.push(`Ứng dụng được phép: ${parsed.allowedApps.map(formatAppEntry).join(', ')}`)
      }
      const perDay = fullWeek<TimeRangeValue[] | null>(parsed.windowsByWeekday, null)
      for (const group of groupWeekdays(perDay, (v) => (v === null ? 'none' : JSON.stringify(v)))) {
        if (group.value === null) {
          lines.push(`${formatWeekdayGroup(group.days)}: không phải giờ học tập trung`)
        } else {
          const ranges = group.value.map((r) => `${r.start}–${r.end}`).join(', ')
          lines.push(`${formatWeekdayGroup(group.days)}: giờ học tập trung ${ranges}`)
        }
      }
      return lines
    }
    case 'block_domains_by_time': {
      const patterns = parsed.urlPatterns ?? []
      const lines: string[] = []
      if (parsed.domains.length === 0 && patterns.length === 0) {
        lines.push('Chặn website theo giờ (chưa có domain nào).')
      } else {
        if (parsed.domains.length > 0) {
          lines.push(`Chặn: ${formatDomainList(parsed.domains)} (kể cả tên miền con)`)
        }
        if (patterns.length > 0) {
          lines.push(`Chặn: ${formatPatternList(patterns)} (chỉ link bắt đầu bằng phần này)`)
        }
      }
      const perDay = fullWeek<TimeRangeValue[] | null>(parsed.windowsByWeekday, null)
      for (const group of groupWeekdays(perDay, (v) => (v === null ? 'none' : JSON.stringify(v)))) {
        if (group.value === null) lines.push(`${formatWeekdayGroup(group.days)}: không chặn`)
        else {
          const ranges = group.value.map((r) => `${r.start}–${r.end}`).join(', ')
          lines.push(`${formatWeekdayGroup(group.days)}: chặn ${ranges}`)
        }
      }
      return lines
    }
  }
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
    lines.push(...describeDailyLimit(parseDailyLimitConfig(config)))
  }

  if (rule.type === 'bedtime') {
    lines.push(...describeBedtime(parseBedtimeConfig(config)))
  }

  if (rule.type === 'time_window') {
    lines.push(...describeTimeWindow(parseTimeWindowConfig(config)))
  }

  if (rule.type === 'app') {
    const parsed = parseAppConfig(config)
    if (parsed) {
      lines.push(...describeAppConfig(parsed))
    } else {
      // Hình dạng lạ/không nhận dạng được: hiển thị các key quen thuộc
      // (nếu có) rồi câu chung chung — không bao giờ throw.
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
  }

  if (rule.type === 'website') {
    const parsed = parseWebsiteConfig(config)
    if (parsed) {
      lines.push(...describeWebsiteConfig(parsed))
    } else {
      // Hình dạng lạ/không nhận dạng được: hiển thị các key quen thuộc
      // (nếu có) rồi câu chung chung — không bao giờ throw.
      const domain = configValue(config, ['domain', 'website', 'url', 'host'])
      if (domain !== undefined) lines.push(`Website: ${asText(domain)}`)
      const action = configValue(config, ['action'])
      if (action !== undefined) lines.push(`Hành động: ${asText(action)}`)
      if (lines.length === 0) lines.push('Quy tắc website (cấu hình chưa nhận dạng được).')
    }
  }

  // Các key chưa được trình bày ở trên: liệt kê nốt để không giấu thông tin.
  const shown = new Set([
    'minutesByWeekday', 'windowsByWeekday', 'bedtimeByWeekday',
    'minutes_per_day', 'minutes', 'daily_minutes', 'limit_minutes',
    'start_time', 'start', 'bedtime_start', 'from',
    'end_time', 'end', 'bedtime_end', 'to',
    'app_name', 'app', 'name', 'process_name', 'action',
    'domain', 'website', 'url', 'host',
    'mode', 'domains', 'urlPatterns', 'categories', 'searchProviders', 'youtubeRestricted',
    'apps', 'minutesPerDay', 'workMinutes', 'breakMinutes', 'allowedApps', 'allowedDomains',
  ])
  for (const [key, value] of Object.entries(config)) {
    if (!shown.has(key)) lines.push(`${key}: ${asText(value)}`)
  }

  if (lines.length === 0) lines.push('Chưa có cấu hình chi tiết.')
  return lines
}

/** Nhãn tiếng Việt cho sự kiện can thiệp trong audit_logs (cột `action`); loại lạ thì giữ nguyên. */
export function tamperEventLabel(action: string): string {
  switch (action) {
    case 'clock_drift':
      return 'Đồng hồ máy bị chỉnh lệch'
    case 'agent_restart':
      return 'Agent khởi động lại'
    case 'extension_missing':
      return 'Không thấy extension trình duyệt'
    case 'service_stopped':
      return 'Service đã dừng'
    case 'tray_stopped':
      return 'Tray SafePC dừng bất thường'
    default:
      return action
  }
}

export function enforcementDecisionLabel(decision: EnforcementSnapshot['decision']): string {
  switch (decision) {
    case 'allow':
      return 'Cho phép'
    case 'warn':
      return 'Cảnh báo'
    case 'lock':
      return 'Đang khóa'
  }
}

/** Nhãn cho một lý do trong enforcement snapshot: loại rule quen thuộc thì dịch, chuỗi lạ thì giữ nguyên. */
export function enforcementReasonLabel(reason: string): string {
  switch (reason) {
    case 'daily_limit':
    case 'bedtime':
    case 'time_window':
    case 'app':
    case 'website':
      return ruleTypeLabel(reason)
    default:
      return reason
  }
}

/**
 * Đọc ảnh chụp thi hành (devices.enforcement_json, migration 6) một cách
 * khoan dung: JSON hỏng, '{}', thiếu decision hoặc decision lạ đều trả về
 * null (coi như "chưa có dữ liệu thi hành"). Các trường còn lại thiếu/sai
 * kiểu thì lấy giá trị mặc định an toàn thay vì làm vỡ trang. Giá trị có
 * thể là object (jsonb do supabase-js parse sẵn) hoặc chuỗi JSON.
 */
export function parseEnforcementSnapshot(value: unknown): EnforcementSnapshot | null {
  let parsed: unknown = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const decision = record['decision']
  if (decision !== 'allow' && decision !== 'warn' && decision !== 'lock') return null
  const lockedByRaw = record['lockedBy']
  const lockedBy =
    lockedByRaw === 'forced' || lockedByRaw === 'rule' || lockedByRaw === 'override' || lockedByRaw === 'break'
      ? lockedByRaw
      : null
  const stringList = (raw: unknown): string[] =>
    Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
  const atRaw = record['at']
  const vRaw = record['v']
  return {
    v: typeof vRaw === 'number' && Number.isFinite(vRaw) ? vRaw : 1,
    at: typeof atRaw === 'string' ? atRaw : '',
    decision,
    lockedBy,
    reasons: stringList(record['reasons']),
    ruleIds: stringList(record['ruleIds']),
    appBlocks: stringList(record['appBlocks']),
    domainRulesActive: record['domainRulesActive'] === true,
    focusActive: record['focusActive'] === true,
  }
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
    // Lỗi MFA đặt trước mẫu chung "expired/invalid token" bên dưới để
    // thông báo mã xác thực được nói rõ, không bị hiểu nhầm là link email.
    [/invalid totp|invalid.*mfa.*code|mfa.*code.*invalid/i, 'Mã xác thực không đúng. Vui lòng nhập mã 6 số mới nhất đang hiện trong app authenticator.'],
    [/challenge expired|mfa.*expired|expired.*challenge/i, 'Mã xác thực đã hết hạn. Vui lòng nhập mã 6 số mới nhất đang hiện trong app authenticator.'],
    [/factor not found|no.*verified.*factor/i, 'Không tìm thấy phương thức xác thực hai lớp của tài khoản này. Vui lòng đăng xuất rồi đăng nhập lại.'],
    [/insufficient_aal|aal2 required|require aal2/i, 'Phiên đăng nhập chưa hoàn tất bước xác thực hai lớp. Vui lòng nhập mã xác thực rồi thử lại.'],
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

/**
 * Lỗi này có phải là "cột chưa tồn tại" (migration chưa áp dụng) cho
 * đúng `column` không? PostgREST báo bằng mã 42703 (undefined_column)
 * kèm thông điệp "column <bảng>.<cột> does not exist". Chỉ kết luận
 * khi tên cột xuất hiện trong thông điệp, để lỗi ở cột khác không bị
 * nhận nhầm thành thiếu migration. Dùng để hiện trạng thái "cần
 * migration" thay cho lỗi chung, hoặc để thử lại truy vấn không có cột
 * mới (tương thích khi migration chưa áp dụng).
 */
export function isMissingColumnError(error: unknown, column: string): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as { message?: unknown; code?: unknown }
  const message = typeof record.message === 'string' ? record.message : ''
  // Khớp chặt: tên cột phải xuất hiện dạng "bảng.cột" (thông điệp thật
  // của PostgREST: "column web_visits.path does not exist") hoặc trong
  // dấu nháy — tránh nhận nhầm cột khác có tên chứa cột này (vd "pathx").
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const qualified = new RegExp(`\\.${escaped}(?![\\w$])|"${escaped}"`)
  if (!qualified.test(message)) return false
  if (typeof record.code === 'string' && record.code === '42703') return true
  return /does not exist/i.test(message)
}
