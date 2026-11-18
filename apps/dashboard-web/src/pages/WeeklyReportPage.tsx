import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import type {
  AppRequest,
  AppUsage,
  AuditLog,
  Child,
  Command,
  Device,
  Rule,
  WebVisit,
} from '../lib/types'
import {
  formatDateTimeVi,
  formatDurationVi,
  formatRelativeVi,
  requestStatusLabel,
  requestTypeLabel,
  tamperEventLabel,
  toVietnameseError,
} from '../lib/format'
import {
  activeDayCount,
  buildSuggestions,
  countBlockedVisits,
  countParentEnforcement,
  countRuleEnforcement,
  currentStateWarnings,
  dailyTotals,
  driftMinutes,
  ENFORCEMENT_ACTIONS,
  filterTamperForChild,
  lateNightDays,
  overLimitDays,
  resolveDailyLimits,
  sumDurationSec,
  summarizeRequests,
  TAMPER_ACTIONS,
  topApps,
  topDomains,
  weekOptionLabel,
  weekRange,
  weekRangeText,
  WEEK_HISTORY_COUNT,
  type TopEntry,
} from '../lib/weekReport'
import {
  AlertBox,
  Card,
  EmptyState,
  ErrorState,
  Field,
  inputClassName,
  LoadingState,
  NotConfiguredState,
  PageHeader,
  primaryButtonClassName,
  secondaryButtonClassName,
} from '../components/ui'

type LoadState = 'loading' | 'ready' | 'error'

// PostgREST (Supabase) trả tối đa 1000 hàng mỗi lần gọi nên dữ liệu một
// tuần phải đọc theo trang. Giới hạn 20 trang (20.000 hàng) cho mỗi bảng:
// extension ghi 1 hàng/phút cho mỗi domain đang xem nên tuần dùng web
// nhiều có thể chạm trần — khi đó hàm fetch báo truncated để giao diện
// cảnh báo số liệu có thể chưa đủ, thay vì cắt lặng.
const PAGE_SIZE = 1000
const MAX_PAGES = 20

/**
 * Dữ liệu có thể bị cắt: đã đọc đủ MAX_PAGES trang mà trang cuối vẫn đủ
 * PAGE_SIZE hàng thì có thể còn hàng chưa đọc (không có cách biết chắc
 * mà không đọc thêm một trang nữa, nên báo "có thể chưa đủ").
 */
function isTruncated(pagesRead: number, lastPageCount: number): boolean {
  return pagesRead >= MAX_PAGES && lastPageCount >= PAGE_SIZE
}

/** Phản hồi của lần tải này còn là mới nhất không — phản hồi cũ về sau phải bị bỏ qua. */
function isLatestRequest(requestSeq: number, latestSeq: number): boolean {
  return requestSeq === latestSeq
}

interface PagedResult<T> {
  rows: T[]
  /** true khi đã đọc đủ MAX_PAGES mà trang cuối vẫn đủ hàng — có thể còn hàng chưa đọc. */
  truncated: boolean
}

async function fetchUsageInRange(
  client: SupabaseClient,
  childId: string,
  startIso: string,
  endIso: string,
): Promise<PagedResult<AppUsage>> {
  const rows: AppUsage[] = []
  let pagesRead = 0
  let lastPageCount = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await client
      .from('app_usage')
      .select('id, family_id, device_id, child_id, app_name, exe_path_hash, started_at, duration_sec, created_at')
      .eq('child_id', childId)
      .gte('started_at', startIso)
      .lt('started_at', endIso)
      .order('started_at', { ascending: true })
      .order('id', { ascending: true })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (error) throw error
    const pageRows = (data ?? []) as AppUsage[]
    rows.push(...pageRows)
    pagesRead = page + 1
    lastPageCount = pageRows.length
    if (pageRows.length < PAGE_SIZE) break
  }
  return { rows, truncated: isTruncated(pagesRead, lastPageCount) }
}

async function fetchVisitsInRange(
  client: SupabaseClient,
  childId: string,
  startIso: string,
  endIso: string,
): Promise<PagedResult<WebVisit>> {
  const rows: WebVisit[] = []
  let pagesRead = 0
  let lastPageCount = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await client
      .from('web_visits')
      .select('id, family_id, device_id, child_id, domain, visited_at, blocked, duration_sec, created_at')
      .eq('child_id', childId)
      .gte('visited_at', startIso)
      .lt('visited_at', endIso)
      .order('visited_at', { ascending: true })
      .order('id', { ascending: true })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (error) throw error
    const pageRows = (data ?? []) as WebVisit[]
    rows.push(...pageRows)
    pagesRead = page + 1
    lastPageCount = pageRows.length
    if (pageRows.length < PAGE_SIZE) break
  }
  return { rows, truncated: isTruncated(pagesRead, lastPageCount) }
}

/**
 * Sự kiện can thiệp + thi hành trong tuần, đọc theo trang như usage/
 * visits (cùng trần MAX_PAGES + cờ truncated): sự kiện thi hành (mỗi
 * lần khóa/chặn/cảnh báo một hàng) có thể vượt 1000 hàng/tuần. Không
 * lọc theo child_id ở truy vấn — hàng cũ không có child_id được khớp
 * qua thiết bị ở phía client (isLogForChild). Mới nhất trước để thẻ
 * Cảnh báo liệt kê đúng thứ tự; thêm `.order('id')` để phân trang ổn
 * định khi nhiều hàng cùng created_at.
 */
async function fetchAuditLogsInRange(
  client: SupabaseClient,
  startIso: string,
  endIso: string,
): Promise<PagedResult<AuditLog>> {
  const rows: AuditLog[] = []
  let pagesRead = 0
  let lastPageCount = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await client
      .from('audit_logs')
      .select('id, family_id, actor, action, target, ip_hash, created_at, child_id, device_id, details')
      .in('action', [...TAMPER_ACTIONS, ...ENFORCEMENT_ACTIONS])
      .gte('created_at', startIso)
      .lt('created_at', endIso)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (error) throw error
    const pageRows = (data ?? []) as AuditLog[]
    rows.push(...pageRows)
    pagesRead = page + 1
    lastPageCount = pageRows.length
    if (pageRows.length < PAGE_SIZE) break
  }
  return { rows, truncated: isTruncated(pagesRead, lastPageCount) }
}

/** Tuần trước chỉ cần tổng giờ để so sánh nên chỉ đọc 2 cột. */
async function fetchPrevWeekSeconds(
  client: SupabaseClient,
  childId: string,
  startIso: string,
  endIso: string,
): Promise<{ total: number; truncated: boolean }> {
  let total = 0
  let pagesRead = 0
  let lastPageCount = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await client
      .from('app_usage')
      .select('started_at, duration_sec')
      .eq('child_id', childId)
      .gte('started_at', startIso)
      .lt('started_at', endIso)
      .order('started_at', { ascending: true })
      .order('id', { ascending: true })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (error) throw error
    const pageRows = (data ?? []) as Array<{ started_at: string; duration_sec: number }>
    total += sumDurationSec(pageRows)
    pagesRead = page + 1
    lastPageCount = pageRows.length
    if (pageRows.length < PAGE_SIZE) break
  }
  return { total, truncated: isTruncated(pagesRead, lastPageCount) }
}

interface ChartRow {
  day: string
  fullLabel: string
  dateLabel: string
  totalSec: number
  hours: number
  limitHours: number | null
  limitMin: number | null
  over: boolean
}

function DayTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ payload: ChartRow }>
}) {
  if (!active || !payload || payload.length === 0) return null
  const row = payload[0].payload
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-md">
      <p className="font-medium text-slate-900">
        {row.fullLabel}, {row.dateLabel}
      </p>
      <p className="mt-0.5 text-slate-700">Đã dùng: {formatDurationVi(row.totalSec)}</p>
      <p className="text-slate-700">
        Giới hạn: {row.limitMin !== null ? formatDurationVi(row.limitMin * 60) : 'không giới hạn'}
      </p>
      {row.over && <p className="font-medium text-red-600">Vượt giới hạn!</p>}
    </div>
  )
}

function TopEntriesList({
  entries,
  emptyText,
}: {
  entries: TopEntry[]
  emptyText: string
}) {
  if (entries.length === 0) {
    return <p className="text-sm text-slate-600">{emptyText}</p>
  }
  const maxSec = entries[0].totalSec
  return (
    <ul className="space-y-3">
      {entries.map((entry) => (
        <li key={entry.name}>
          <div className="flex items-baseline justify-between gap-4 text-sm">
            <span className="min-w-0 truncate font-medium text-slate-800">{entry.name}</span>
            <span className="shrink-0 text-slate-600">
              {formatDurationVi(entry.totalSec)} · {Math.round(entry.share * 100)}%
            </span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-indigo-600"
              style={{ width: `${maxSec > 0 ? Math.round((entry.totalSec / maxSec) * 100) : 0}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

/**
 * Trang Báo cáo tuần (PRD §2.10): 7 mục — tổng quan, giờ theo ngày kèm
 * đường giới hạn, top 5 app/domain, thi hành, yêu cầu, cảnh báo, gợi ý.
 * Tuần bắt đầu thứ Hai theo giờ địa phương. Dữ liệu tổng hợp ở client
 * từ các bảng app_usage, web_visits, requests, audit_logs (+ rules,
 * commands, devices cho đường giới hạn, lệnh phụ huynh và kiểm tra tình
 * trạng); RLS lo tách dữ liệu theo gia đình.
 */
export default function WeeklyReportPage() {
  const { configured, user } = useAuth()
  const [searchParams] = useSearchParams()
  const childParam = searchParams.get('child')

  const [childrenState, setChildrenState] = useState<LoadState>('loading')
  const [childrenError, setChildrenError] = useState('')
  const [children, setChildren] = useState<Child[]>([])
  const [selectedChildId, setSelectedChildId] = useState<string>('')
  const [weekOffset, setWeekOffset] = useState(0)
  // Số thứ tự lần tải tuần: đổi tuần/con liên tục thì phản hồi cũ về sau
  // phải bị bỏ qua, không ghi đè dữ liệu của lần tải mới nhất.
  const weekLoadSeqRef = useRef(0)

  const [weekState, setWeekState] = useState<LoadState>('loading')
  const [weekError, setWeekError] = useState('')
  // true khi bất kỳ nguồn phân trang nào chạm trần MAX_PAGES — giao diện
  // cảnh báo số liệu có thể chưa đủ thay vì hiện số thiếu như số đủ.
  const [dataTruncated, setDataTruncated] = useState(false)
  const [usage, setUsage] = useState<AppUsage[]>([])
  const [prevWeekSec, setPrevWeekSec] = useState(0)
  const [visits, setVisits] = useState<WebVisit[]>([])
  const [requests, setRequests] = useState<AppRequest[]>([])
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([])
  const [rules, setRules] = useState<Rule[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [commands, setCommands] = useState<Command[]>([])
  // Lần cuối thấy extension theo từng máy (truy vấn riêng, best-effort —
  // cùng mẫu với DevicesPage: cột chỉ có sau migration 5).
  const [extensionSeenByDevice, setExtensionSeenByDevice] = useState<Map<string, string | null>>(
    new Map(),
  )

  const loadChildren = useCallback(async () => {
    if (!supabase || !user) {
      setChildrenState('ready')
      return
    }
    setChildrenState('loading')
    setChildrenError('')
    try {
      const { data, error: childrenError } = await supabase
        .from('children')
        .select('id, family_id, display_name, birth_year, avatar_url, created_at')
        .order('created_at', { ascending: true })
      if (childrenError) throw childrenError
      const rows = (data ?? []) as Child[]
      setChildren(rows)
      // Ưu tiên con trong link (?child=… từ tab Báo cáo của hồ sơ), rồi
      // con đầu tiên — cùng quy ước chọn mặc định như RulesPage.
      if (childParam && rows.some((c) => c.id === childParam)) {
        setSelectedChildId(childParam)
      } else if (rows.length > 0) {
        setSelectedChildId(rows[0].id)
      }
      setChildrenState('ready')
    } catch (err) {
      setChildrenError(toVietnameseError(err))
      setChildrenState('error')
    }
  }, [user, childParam])

  useEffect(() => {
    void loadChildren()
  }, [loadChildren])

  const loadWeek = useCallback(async () => {
    // Tăng số thứ tự ngay cả khi trả về sớm: lần gọi nào cũng vô hiệu
    // hóa mọi phản hồi của lần tải trước còn đang bay.
    const seq = ++weekLoadSeqRef.current
    if (!supabase || !user || !selectedChildId) {
      setWeekState('ready')
      return
    }
    setWeekState('loading')
    setWeekError('')
    try {
      const range = weekRange(weekOffset)
      const prevRange = weekRange(weekOffset + 1)
      const startIso = range.start.toISOString()
      const endIso = range.end.toISOString()
      const [usageResult, prevResult, visitResult, requestsResult, auditResult, rulesResult, devicesResult, commandsResult] =
        await Promise.all([
          fetchUsageInRange(supabase, selectedChildId, startIso, endIso),
          fetchPrevWeekSeconds(supabase, selectedChildId, prevRange.start.toISOString(), prevRange.end.toISOString()),
          fetchVisitsInRange(supabase, selectedChildId, startIso, endIso),
          supabase
            .from('requests')
            .select('id, family_id, child_id, type, status, reason, decided_by, decided_at, created_at, minutes, device_id')
            .eq('child_id', selectedChildId)
            .gte('created_at', startIso)
            .lt('created_at', endIso)
            .order('created_at', { ascending: false })
            .limit(200),
          fetchAuditLogsInRange(supabase, startIso, endIso),
          supabase
            .from('rules')
            .select('id, family_id, child_id, type, config, enabled, created_at')
            .eq('child_id', selectedChildId)
            .eq('type', 'daily_limit'),
          supabase
            .from('devices')
            .select('id, family_id, child_id, hostname, os_version, agent_version, last_seen_at, status, created_at')
            .eq('child_id', selectedChildId),
          supabase
            .from('commands')
            .select('id, family_id, device_id, type, payload, status, created_at')
            .in('type', ['lock_now', 'temporary_override'])
            .gte('created_at', startIso)
            .lt('created_at', endIso)
            .order('created_at', { ascending: false })
            .limit(200),
        ])
      if (!isLatestRequest(seq, weekLoadSeqRef.current)) return
      if (requestsResult.error) throw requestsResult.error
      if (rulesResult.error) throw rulesResult.error
      if (devicesResult.error) throw devicesResult.error
      if (commandsResult.error) throw commandsResult.error
      setUsage(usageResult.rows)
      setPrevWeekSec(prevResult.total)
      setVisits(visitResult.rows)
      setDataTruncated(usageResult.truncated || prevResult.truncated || visitResult.truncated || auditResult.truncated)
      setRequests((requestsResult.data ?? []) as AppRequest[])
      setAuditLogs(auditResult.rows)
      setRules((rulesResult.data ?? []) as Rule[])
      const deviceRows = (devicesResult.data ?? []) as Device[]
      setDevices(deviceRows)
      const deviceIds = new Set(deviceRows.map((d) => d.id))
      setCommands(((commandsResult.data ?? []) as Command[]).filter((c) => deviceIds.has(c.device_id)))
      // Extension: truy vấn riêng, lỗi thì bỏ qua (map rỗng = chưa biết).
      try {
        const extensionResult = await supabase
          .from('devices')
          .select('id, last_extension_seen_at')
          .eq('child_id', selectedChildId)
        if (!isLatestRequest(seq, weekLoadSeqRef.current)) return
        if (extensionResult.error) throw extensionResult.error
        const seen = new Map<string, string | null>()
        for (const row of (extensionResult.data ?? []) as Array<{ id: string; last_extension_seen_at: string | null }>) {
          seen.set(row.id, row.last_extension_seen_at)
        }
        setExtensionSeenByDevice(seen)
      } catch {
        if (!isLatestRequest(seq, weekLoadSeqRef.current)) return
        setExtensionSeenByDevice(new Map())
      }
      if (!isLatestRequest(seq, weekLoadSeqRef.current)) return
      setWeekState('ready')
    } catch (err) {
      if (!isLatestRequest(seq, weekLoadSeqRef.current)) return
      setWeekError(toVietnameseError(err))
      setWeekState('error')
    }
  }, [user, selectedChildId, weekOffset])

  useEffect(() => {
    void loadWeek()
  }, [loadWeek])

  const selectedChild = useMemo(
    () => children.find((c) => c.id === selectedChildId) ?? null,
    [children, selectedChildId],
  )
  const range = useMemo(() => weekRange(weekOffset), [weekOffset])
  const rangeText = useMemo(() => weekRangeText(range), [range])
  const weekOptions = useMemo(
    () => Array.from({ length: WEEK_HISTORY_COUNT }, (_, offset) => offset),
    [],
  )

  const deviceById = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices])
  const deviceChildById = useMemo(
    () => new Map(devices.map((d) => [d.id, d.child_id ?? ''])),
    [devices],
  )

  const daily = useMemo(() => dailyTotals(usage, range), [usage, range])
  const totalSec = useMemo(() => sumDurationSec(usage), [usage])
  const totalWebSec = useMemo(() => sumDurationSec(visits), [visits])
  const activeDays = useMemo(() => activeDayCount(daily), [daily])
  const limits = useMemo(() => resolveDailyLimits(rules), [rules])
  const overLimit = useMemo(() => overLimitDays(daily, limits), [daily, limits])
  const hasAnyLimit = useMemo(() => Object.keys(limits).length > 0, [limits])
  const topAppEntries = useMemo(() => topApps(usage), [usage])
  const topDomainEntries = useMemo(() => topDomains(visits), [visits])
  const requestStats = useMemo(() => summarizeRequests(requests), [requests])
  const enforcement = useMemo(() => countParentEnforcement(commands), [commands])
  // Thi hành theo quy tắc (khóa/chặn/cảnh báo/nghỉ) — nguồn: audit_logs
  // do RPC safepc_push_enforcement_event ghi (migration 10).
  const ruleEnforcement = useMemo(
    () => countRuleEnforcement(auditLogs, selectedChildId, deviceChildById),
    [auditLogs, selectedChildId, deviceChildById],
  )
  const blockedVisits = useMemo(() => countBlockedVisits(visits), [visits])
  const tamperEvents = useMemo(
    () => filterTamperForChild(auditLogs, selectedChildId, deviceChildById),
    [auditLogs, selectedChildId, deviceChildById],
  )
  const stateWarnings = useMemo(
    () => currentStateWarnings(devices, extensionSeenByDevice, Date.now()),
    [devices, extensionSeenByDevice],
  )
  const lateNights = useMemo(() => lateNightDays(usage, daily), [usage, daily])
  const suggestions = useMemo(
    () =>
      buildSuggestions({
        daily,
        topApp: topAppEntries[0] ?? null,
        topDomain: topDomainEntries[0] ?? null,
        totalSec,
        totalWebSec,
        overLimit,
        lateNights,
        pendingRequests: requestStats.pending,
      }),
    [daily, topAppEntries, topDomainEntries, totalSec, totalWebSec, overLimit, lateNights, requestStats.pending],
  )
  const hasWeekData =
    usage.length > 0 ||
    visits.length > 0 ||
    requests.length > 0 ||
    tamperEvents.length > 0 ||
    enforcement.parentLocks + enforcement.parentTempBlocks > 0 ||
    ruleEnforcement.bedtimeLocks +
      ruleEnforcement.timeWindowLocks +
      ruleEnforcement.dailyLimitLocks +
      ruleEnforcement.otherRuleLocks +
      ruleEnforcement.breaks +
      ruleEnforcement.appBlocks +
      ruleEnforcement.warnings >
      0

  const chartData: ChartRow[] = useMemo(
    () =>
      daily.map((day) => {
        const limitMin = limits[day.weekday]
        return {
          day: day.shortLabel,
          fullLabel: day.fullLabel,
          dateLabel: `${String(day.date.getDate()).padStart(2, '0')}/${String(day.date.getMonth() + 1).padStart(2, '0')}`,
          totalSec: day.totalSec,
          hours: Math.round((day.totalSec / 3600) * 100) / 100,
          limitHours: limitMin !== undefined ? Math.round((limitMin / 60) * 100) / 100 : null,
          limitMin: limitMin ?? null,
          over: limitMin !== undefined && day.totalSec > limitMin * 60,
        }
      }),
    [daily, limits],
  )

  const deltaText = useMemo(() => {
    if (prevWeekSec > 0) {
      const pct = Math.round(((totalSec - prevWeekSec) / prevWeekSec) * 100)
      const sign = pct > 0 ? '+' : ''
      return `${sign}${pct}% so với tuần trước (${formatDurationVi(prevWeekSec)})`
    }
    if (totalSec > 0) return 'Tuần trước chưa có dữ liệu'
    return '—'
  }, [totalSec, prevWeekSec])

  if (!configured) {
    return (
      <>
        <PageHeader title="Báo cáo tuần" description="Tổng hợp tuần theo từng con: giờ dùng máy, ứng dụng, website, thi hành, yêu cầu và cảnh báo." />
        <NotConfiguredState />
      </>
    )
  }

  if (childrenState === 'loading') return <LoadingState label="Đang tải danh sách hồ sơ…" />
  if (childrenState === 'error') {
    return (
      <>
        <PageHeader title="Báo cáo tuần" />
        <ErrorState message={childrenError} onRetry={() => void loadChildren()} />
      </>
    )
  }

  if (children.length === 0) {
    return (
      <>
        <PageHeader title="Báo cáo tuần" description="Tổng hợp tuần theo từng con: giờ dùng máy, ứng dụng, website, thi hành, yêu cầu và cảnh báo." />
        <EmptyState
          title="Chưa có hồ sơ nào"
          description="Tạo hồ sơ cho con và ghép nối máy của con để bắt đầu có dữ liệu báo cáo tuần."
        >
          <Link
            to="/ho-so"
            className={primaryButtonClassName}
          >
            Tới trang Hồ sơ
          </Link>
        </EmptyState>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Báo cáo tuần"
        description={
          selectedChild
            ? `Tuần ${rangeText} của ${selectedChild.display_name} — từ thứ Hai tới Chủ nhật, theo giờ Việt Nam.`
            : `Tuần ${rangeText} — từ thứ Hai tới Chủ nhật, theo giờ Việt Nam.`
        }
        actions={
          <button type="button" onClick={() => void loadWeek()} className={secondaryButtonClassName}>
            Tải lại
          </button>
        }
      />

      <Card className="mb-4 sm:mb-6">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Con" htmlFor="report-child">
            <select
              id="report-child"
              className={inputClassName}
              value={selectedChildId}
              onChange={(e) => setSelectedChildId(e.target.value)}
            >
              {children.map((child) => (
                <option key={child.id} value={child.id}>
                  {child.display_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tuần" htmlFor="report-week">
            <select
              id="report-week"
              className={inputClassName}
              value={weekOffset}
              onChange={(e) => setWeekOffset(Number(e.target.value))}
            >
              {weekOptions.map((offset) => (
                <option key={offset} value={offset}>
                  {weekOptionLabel(offset)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      {weekState === 'loading' && <LoadingState label="Đang tải báo cáo tuần…" />}
      {weekState === 'error' && <ErrorState message={weekError} onRetry={() => void loadWeek()} />}

      {weekState === 'ready' && !hasWeekData && (
        <EmptyState
          title={`Tuần ${rangeText} chưa có dữ liệu`}
          description={`${selectedChild?.display_name ?? 'Con'} chưa có dữ liệu dùng máy, xem web, yêu cầu hay cảnh báo nào trong tuần này. Thử chọn tuần khác, hoặc kiểm tra máy đã ghép nối và Agent đã đồng bộ chưa.`}
        />
      )}

      {weekState === 'ready' && hasWeekData && (
        <div className="space-y-4 sm:space-y-6">
          {dataTruncated && (
            <AlertBox tone="warning">
              Dữ liệu tuần này có thể chưa đủ — đã chạm giới hạn tải 20.000 hàng, số liệu dưới đây chỉ tính trên
              dữ liệu đã tải được nên tổng giờ, top ứng dụng/website và tỉ lệ có thể thấp hơn thực tế.
            </AlertBox>
          )}
          <Card title="Tổng quan tuần">
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <dt className="text-sm text-slate-600">Tổng giờ dùng máy</dt>
                <dd className="mt-0.5 text-lg font-semibold text-slate-900">{formatDurationVi(totalSec)}</dd>
              </div>
              <div>
                <dt className="text-sm text-slate-600">So với tuần trước</dt>
                <dd className="mt-0.5 text-lg font-semibold text-slate-900">{deltaText}</dd>
              </div>
              <div>
                <dt className="text-sm text-slate-600">Số ngày dùng máy</dt>
                <dd className="mt-0.5 text-lg font-semibold text-slate-900">
                  {activeDays}/7 ngày
                </dd>
              </div>
              <div>
                <dt className="text-sm text-slate-600">Trung bình mỗi ngày dùng máy</dt>
                <dd className="mt-0.5 text-lg font-semibold text-slate-900">
                  {activeDays > 0 ? formatDurationVi(totalSec / activeDays) : '—'}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-slate-600">Thời gian xem web (theo extension)</dt>
                <dd className="mt-0.5 text-lg font-semibold text-slate-900">{formatDurationVi(totalWebSec)}</dd>
              </div>
            </dl>
          </Card>

          <Card title="Giờ dùng theo ngày">
            <div className="h-64 w-full" role="img" aria-label={`Biểu đồ giờ dùng theo ngày, tuần ${rangeText}`}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="day" tickLine={false} axisLine={false} interval={0} tick={{ fontSize: 12 }} />
                  <YAxis
                    width={40}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value: number) => `${value}h`}
                  />
                  <Tooltip content={<DayTooltip />} />
                  <Bar dataKey="hours" radius={[4, 4, 0, 0]} maxBarSize={48}>
                    {chartData.map((row) => (
                      <Cell key={row.day} fill={row.over ? '#dc2626' : '#4f46e5'} />
                    ))}
                  </Bar>
                  {hasAnyLimit && (
                    <Line
                      type="stepAfter"
                      dataKey="limitHours"
                      stroke="#dc2626"
                      strokeWidth={2}
                      strokeDasharray="6 4"
                      dot={{ r: 3, fill: '#dc2626' }}
                      connectNulls={false}
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-3 w-3 rounded-sm bg-indigo-600" aria-hidden="true" />
                Giờ đã dùng
              </span>
              {overLimit.length > 0 && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-3 w-3 rounded-sm bg-red-600" aria-hidden="true" />
                  Ngày vượt giới hạn
                </span>
              )}
              {hasAnyLimit && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-0 w-4 border-t-2 border-dashed border-red-600" aria-hidden="true" />
                  Giới hạn giờ/ngày
                </span>
              )}
            </div>
            {overLimit.length > 0 ? (
              <p className="mt-3 text-sm text-slate-700">
                Vượt giới hạn:{' '}
                {overLimit
                  .map((o) => `${o.day.fullLabel} (${formatDurationVi(o.day.totalSec)}, giới hạn ${formatDurationVi(o.limitMin * 60)})`)
                  .join('; ')}
                .
              </p>
            ) : hasAnyLimit ? (
              <p className="mt-3 text-sm text-slate-600">Không ngày nào vượt giới hạn giờ/ngày trong tuần này.</p>
            ) : (
              <p className="mt-3 text-sm text-slate-600">
                Chưa đặt giới hạn giờ/ngày cho {selectedChild?.display_name ?? 'con'} nên không có đường giới hạn. Đặt
                giới hạn trong Quy tắc để thấy ngày nào vượt.
              </p>
            )}
            <p className="mt-1 text-xs text-slate-500">
              Giới hạn lấy theo quy tắc giới hạn giờ/ngày đang bật hiện tại; ngày không đặt giới hạn thì không có
              đường giới hạn.
            </p>
          </Card>

          <Card title="Ứng dụng và website dùng nhiều nhất">
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <h3 className="mb-3 text-sm font-medium text-slate-800">Top 5 ứng dụng</h3>
                <TopEntriesList entries={topAppEntries} emptyText="Chưa có dữ liệu ứng dụng trong tuần này." />
              </div>
              <div>
                <h3 className="mb-3 text-sm font-medium text-slate-800">Top 5 website</h3>
                <TopEntriesList entries={topDomainEntries} emptyText="Chưa có dữ liệu xem web trong tuần này." />
              </div>
            </div>
            <p className="mt-4 text-xs text-slate-500">
              Tỉ lệ tính trên tổng thời lượng cùng loại (ứng dụng trên tổng giờ dùng máy, website trên tổng thời gian
              xem web).
            </p>
          </Card>

          <Card title="Quy tắc đã thi hành">
            <dl className="grid gap-3 sm:grid-cols-3">
              <div>
                <dt className="text-sm text-slate-600">Phụ huynh khóa máy</dt>
                <dd className="mt-0.5 text-lg font-semibold text-slate-900">{enforcement.parentLocks} lần</dd>
                <p className="text-xs text-slate-500">Lệnh khóa Agent đã nhận trong tuần.</p>
              </div>
              <div>
                <dt className="text-sm text-slate-600">Chặn tạm thời do phụ huynh</dt>
                <dd className="mt-0.5 text-lg font-semibold text-slate-900">{enforcement.parentTempBlocks} lần</dd>
                <p className="text-xs text-slate-500">Chặn website/ứng dụng tạm thời Agent đã nhận.</p>
              </div>
              <div>
                <dt className="text-sm text-slate-600">Lượt web bị chặn</dt>
                <dd className="mt-0.5 text-lg font-semibold text-slate-900">{blockedVisits} lượt</dd>
                <p className="text-xs text-slate-500">Lượt thăm web extension báo là bị chặn.</p>
              </div>
              <div>
                <dt className="text-sm text-slate-600">Khóa do giờ ngủ</dt>
                <dd className="mt-0.5 text-lg font-semibold text-slate-900">{ruleEnforcement.bedtimeLocks} lần</dd>
                <p className="text-xs text-slate-500">Máy bị khóa khi đến giờ ngủ.</p>
              </div>
              <div>
                <dt className="text-sm text-slate-600">Khóa do ngoài khung giờ</dt>
                <dd className="mt-0.5 text-lg font-semibold text-slate-900">{ruleEnforcement.timeWindowLocks} lần</dd>
                <p className="text-xs text-slate-500">Máy bị khóa ngoài khung giờ được dùng.</p>
              </div>
              <div>
                <dt className="text-sm text-slate-600">Khóa do hết giới hạn ngày</dt>
                <dd className="mt-0.5 text-lg font-semibold text-slate-900">{ruleEnforcement.dailyLimitLocks} lần</dd>
                <p className="text-xs text-slate-500">Máy bị khóa khi hết thời gian trong ngày.</p>
              </div>
              {ruleEnforcement.otherRuleLocks > 0 && (
                <div>
                  <dt className="text-sm text-slate-600">Khóa theo quy tắc (loại khác)</dt>
                  <dd className="mt-0.5 text-lg font-semibold text-slate-900">{ruleEnforcement.otherRuleLocks} lần</dd>
                  <p className="text-xs text-slate-500">Khóa do quy tắc nhưng không phân loại được.</p>
                </div>
              )}
              <div>
                <dt className="text-sm text-slate-600">Nghỉ bắt buộc</dt>
                <dd className="mt-0.5 text-lg font-semibold text-slate-900">{ruleEnforcement.breaks} lần</dd>
                <p className="text-xs text-slate-500">Lần bắt đầu nghỉ sau thời gian dùng liên tục.</p>
              </div>
              <div>
                <dt className="text-sm text-slate-600">Ứng dụng bị chặn</dt>
                <dd className="mt-0.5 text-lg font-semibold text-slate-900">{ruleEnforcement.appBlocks} lần</dd>
                <p className="text-xs text-slate-500">Lần Agent đóng ứng dụng bị chặn.</p>
              </div>
              <div>
                <dt className="text-sm text-slate-600">Cảnh báo đã hiện</dt>
                <dd className="mt-0.5 text-lg font-semibold text-slate-900">{ruleEnforcement.warnings} lần</dd>
                <p className="text-xs text-slate-500">Cảnh báo sắp khóa/sắp hết giờ đã hiện trên máy con.</p>
              </div>
            </dl>
            <p className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
              Lịch sử thi hành theo quy tắc chỉ bắt đầu từ khi bản Agent và extension mới được cài trên máy con và
              migration ghi sự kiện đã được áp dụng — tuần trước thời điểm đó có thể hiện 0 dù quy tắc vẫn đang thi
              hành. Lượt web bị chặn là con số tối thiểu: extension chỉ đếm lượt quy chiếu được tên miền; lượt bị chặn
              bởi quy tắc chặn tất cả (giờ học tập trung, danh sách chỉ cho phép) không đếm được nên không tính vào.
            </p>
          </Card>

          <Card title="Yêu cầu xin thêm giờ">
            <dl className="grid gap-3 sm:grid-cols-4">
              <div>
                <dt className="text-sm text-slate-600">Tổng số</dt>
                <dd className="mt-0.5 text-lg font-semibold text-slate-900">{requestStats.total}</dd>
              </div>
              <div>
                <dt className="text-sm text-slate-600">Đã duyệt</dt>
                <dd className="mt-0.5 text-lg font-semibold text-slate-900">{requestStats.approved}</dd>
              </div>
              <div>
                <dt className="text-sm text-slate-600">Đã từ chối</dt>
                <dd className="mt-0.5 text-lg font-semibold text-slate-900">{requestStats.denied}</dd>
              </div>
              <div>
                <dt className="text-sm text-slate-600">Đang chờ</dt>
                <dd className="mt-0.5 text-lg font-semibold text-slate-900">{requestStats.pending}</dd>
              </div>
            </dl>
            <p className="mt-3 text-sm text-slate-600">
              Trong đó: {requestStats.extraTime} yêu cầu xin thêm giờ, {requestStats.unblockApp} yêu cầu xin mở ứng
              dụng.
            </p>
            {requests.length > 0 && (
              <ul className="mt-4 space-y-2">
                {requests.map((request) => (
                  <li key={request.id} className="flex items-center justify-between gap-4 text-sm">
                    <span className="min-w-0 truncate text-slate-900">
                      {requestTypeLabel(request.type)}
                      {request.type === 'extra_time' && request.minutes != null ? ` (${request.minutes} phút)` : ''}
                      {request.reason ? ` — ${request.reason}` : ''}
                    </span>
                    <span className="shrink-0 text-slate-600">
                      {requestStatusLabel(request.status)} · {formatDateTimeVi(request.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4">
              <Link
                to="/yeu-cau"
                className={secondaryButtonClassName}
              >
                Tới trang Yêu cầu để duyệt
              </Link>
            </div>
          </Card>

          <Card title="Gợi ý">
            {suggestions.length === 0 ? (
              <p className="text-sm text-slate-600">
                Chưa có gợi ý nào cho tuần này — các chỉ số đều trong ngưỡng theo dõi (cuối tuần không vượt quá 1,5
                lần ngày thường, không ứng dụng hay website nào chiếm từ 40% thời lượng, không vượt giới hạn từ 2
                ngày, không dùng máy sau 21:00 từ 2 ngày, không còn yêu cầu chờ duyệt).
              </p>
            ) : (
              <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-slate-800">
                {suggestions.map((suggestion) => (
                  <li key={suggestion}>{suggestion}</li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {weekState === 'ready' && (
        <Card title="Cảnh báo" className="mt-4 sm:mt-6">
          {tamperEvents.length === 0 && stateWarnings.length === 0 ? (
            <p className="text-sm text-slate-600">Không có cảnh báo nào trong tuần này.</p>
          ) : (
            <div className="space-y-4">
              {tamperEvents.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-medium text-slate-800">Sự kiện trong tuần</h3>
                  <ul className="space-y-3">
                    {tamperEvents.map((event) => {
                      const deviceId = event.device_id ?? event.target ?? undefined
                      const device = deviceId ? deviceById.get(deviceId) : undefined
                      const drift = driftMinutes(event.details)
                      return (
                        <li
                          key={event.id}
                          className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 pb-3 last:border-0 last:pb-0"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-slate-800">{tamperEventLabel(event.action)}</p>
                            <p className="mt-0.5 text-xs text-slate-500">
                              Máy: {device?.hostname ?? '—'}
                              {event.action === 'clock_drift' && drift !== null
                                ? ` · Đồng hồ lệch ${drift} phút so với giờ server (ngưỡng báo là 5 phút)`
                                : ''}
                            </p>
                          </div>
                          <span className="shrink-0 text-sm text-slate-600" title={formatDateTimeVi(event.created_at)}>
                            {formatRelativeVi(event.created_at)}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
              {stateWarnings.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-medium text-slate-800">Kiểm tra lúc xem báo cáo</h3>
                  <ul className="space-y-2">
                    {stateWarnings.map((warning) =>
                      warning.kind === 'offline' ? (
                        <li key={`offline-${warning.device.id}`} className="text-sm text-slate-800">
                          Máy {warning.device.hostname} đã offline bất thường — thấy lần cuối{' '}
                          {formatRelativeVi(warning.lastSeenAt)} (quá 48 giờ).
                        </li>
                      ) : (
                        <li key={`extension-${warning.device.id}`} className="text-sm text-slate-800">
                          Không thấy extension trình duyệt trên máy {warning.device.hostname} (máy vẫn hoạt động;{' '}
                          {warning.extensionSeenAt
                            ? `extension thấy lần cuối ${formatRelativeVi(warning.extensionSeenAt)}`
                            : 'extension chưa từng gửi tín hiệu'}
                          , quá 24 giờ). Kiểm tra extension còn được cài và bật trong Edge/Chrome không.
                        </li>
                      ),
                    )}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Card>
      )}
    </>
  )
}
