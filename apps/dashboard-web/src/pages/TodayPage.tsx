import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useAuth } from '../context/AuthContext'
import type { HourChartRow } from '../components/TodayHourChart'

// Biểu đồ kéo theo Recharts (nặng) nên tải lười, cùng lý do với trang Báo
// cáo tuần: trang tổng quan không được bắt mọi lượt xem trả thêm ~108KB
// gzip (đo từ build thật) chỉ để xem nhanh trạng thái.
const TodayHourChart = lazy(() => import('../components/TodayHourChart'))
import { supabase } from '../lib/supabase'
import type {
  AppUsage,
  AuditLog,
  Child,
  Command,
  Device,
  EnforcementDecision,
  EnforcementSnapshot,
  Rule,
  WebVisit,
} from '../lib/types'
import {
  deviceStatusLabel,
  enforcementDecisionLabel,
  enforcementReasonLabel,
  formatDateTimeVi,
  formatDurationVi,
  formatRelativeVi,
  formatTimeVi,
  parseEnforcementSnapshot,
  startOfTodayIso,
  tamperEventLabel,
  toVietnameseError,
} from '../lib/format'
import {
  activeOverrideForDevice,
  extensionStatus,
  hourlyTotals,
  isDeviceOnline,
  remainingTimeForChild,
} from '../lib/todayOverview'
import { countBlockedVisits, sumDurationSec, topDomains } from '../lib/weekReport'
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  NotConfiguredState,
  PageHeader,
  Spinner,
  secondaryButtonClassName,
} from '../components/ui'

interface TopApp {
  appName: string
  totalSec: number
  sessions: number
}

type LoadState = 'loading' | 'ready' | 'error'

/** Cùng bảng màu huy hiệu với trang Thiết bị. */
const STATUS_BADGE: Record<Device['status'], string> = {
  online: 'bg-emerald-100 text-emerald-800',
  offline: 'bg-slate-200 text-slate-700',
  locked: 'bg-red-100 text-red-800',
}

const ENFORCEMENT_BADGE: Record<EnforcementDecision, string> = {
  allow: 'bg-emerald-100 text-emerald-800',
  warn: 'bg-amber-100 text-amber-800',
  lock: 'bg-red-100 text-red-800',
}

const EXTENSION_TONE_CLASS: Record<'ok' | 'warn' | 'unknown', string> = {
  ok: 'font-medium text-emerald-700',
  warn: 'font-medium text-amber-700',
  unknown: 'text-slate-500',
}

// PostgREST trả tối đa 1000 hàng mỗi lần gọi nên dữ liệu trong ngày phải
// đọc theo trang (cùng trần với trang Báo cáo tuần: 20 trang, 20.000
// hàng — extension ghi 1 hàng/phút cho mỗi domain đang xem nên ngày dùng
// web nhiều có thể chạm trần). Chạm trần thì giao diện cảnh báo số liệu
// có thể chưa đủ, thay vì cắt lặng.
const PAGE_SIZE = 1000
const MAX_PAGES = 20

interface PagedResult<T> {
  rows: T[]
  /** true khi đã đọc đủ MAX_PAGES mà trang cuối vẫn đủ hàng — có thể còn hàng chưa đọc. */
  truncated: boolean
}

function isTruncated(pagesRead: number, lastPageCount: number): boolean {
  return pagesRead >= MAX_PAGES && lastPageCount >= PAGE_SIZE
}

async function fetchTodayRows<T>(
  client: SupabaseClient,
  table: string,
  columns: string,
  timeColumn: string,
  startIso: string,
): Promise<PagedResult<T>> {
  const rows: T[] = []
  let pagesRead = 0
  let lastPageCount = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .gte(timeColumn, startIso)
      .order('id', { ascending: true })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (error) throw error
    const pageRows = (data ?? []) as T[]
    rows.push(...pageRows)
    pagesRead = page + 1
    lastPageCount = pageRows.length
    if (pageRows.length < PAGE_SIZE) break
  }
  return { rows, truncated: isTruncated(pagesRead, lastPageCount) }
}

export default function TodayPage() {
  const { configured, user } = useAuth()
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [usage, setUsage] = useState<AppUsage[]>([])
  const [usageTruncated, setUsageTruncated] = useState(false)
  const [visits, setVisits] = useState<WebVisit[]>([])
  const [visitsTruncated, setVisitsTruncated] = useState(false)
  const [children, setChildren] = useState<Child[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [rules, setRules] = useState<Rule[]>([])
  const [commands, setCommands] = useState<Command[]>([])
  // Lần cuối thấy extension theo từng máy (truy vấn riêng, best-effort —
  // cột chỉ có sau migration 5; lỗi thì coi là chưa biết, không vỡ trang).
  const [extensionSeenByDevice, setExtensionSeenByDevice] = useState<Map<string, string | null>>(
    new Map(),
  )
  // Ảnh chụp thi hành mới nhất theo từng máy (truy vấn riêng, best-effort
  // — cột chỉ có sau migration 6; snapshot null nghĩa là chưa có dữ liệu
  // thi hành hợp lệ).
  const [enforcementByDevice, setEnforcementByDevice] = useState<
    Map<string, { snapshot: EnforcementSnapshot | null; updatedAt: string | null }>
  >(new Map())
  // Cảnh báo can thiệp (audit_logs): tải độc lập, lỗi thì chỉ thẻ cảnh báo
  // báo lỗi, không làm hỏng phần còn lại của trang.
  const [alerts, setAlerts] = useState<AuditLog[]>([])
  const [alertsFailed, setAlertsFailed] = useState(false)

  // Số thứ tự lần tải: bấm "Tải lại" liên tục thì phản hồi cũ về sau
  // phải bị bỏ qua, không ghi đè dữ liệu của lần tải mới nhất.
  const loadSeqRef = useRef(0)

  const load = useCallback(async () => {
    if (!supabase || !user) {
      setState('ready')
      return
    }
    const seq = ++loadSeqRef.current
    setState('loading')
    setError('')
    try {
      const startIso = startOfTodayIso()
      const [usagePaged, visitsPaged, childrenResult, devicesResult, rulesResult, commandsResult] =
        await Promise.all([
          fetchTodayRows<AppUsage>(
            supabase,
            'app_usage',
            'id, family_id, device_id, child_id, app_name, exe_path_hash, started_at, duration_sec, created_at',
            'started_at',
            startIso,
          ),
          fetchTodayRows<WebVisit>(
            supabase,
            'web_visits',
            'id, family_id, device_id, child_id, domain, visited_at, blocked, duration_sec, created_at',
            'visited_at',
            startIso,
          ),
          supabase
            .from('children')
            .select('id, family_id, display_name, birth_year, avatar_url, created_at'),
          supabase
            .from('devices')
            .select('id, family_id, child_id, hostname, os_version, agent_version, last_seen_at, status, created_at'),
          supabase
            .from('rules')
            .select('id, family_id, child_id, type, config, enabled, created_at'),
          supabase
            .from('commands')
            .select('id, family_id, device_id, type, payload, status, created_at')
            .in('type', ['temporary_override', 'lock_now'])
            .order('created_at', { ascending: false })
            .limit(50),
        ])
      if (childrenResult.error) throw childrenResult.error
      if (devicesResult.error) throw devicesResult.error
      if (rulesResult.error) throw rulesResult.error
      if (commandsResult.error) throw commandsResult.error
      if (seq !== loadSeqRef.current) return
      setUsage(usagePaged.rows)
      setUsageTruncated(usagePaged.truncated)
      setVisits(visitsPaged.rows)
      setVisitsTruncated(visitsPaged.truncated)
      setChildren((childrenResult.data ?? []) as Child[])
      setDevices((devicesResult.data ?? []) as Device[])
      setRules((rulesResult.data ?? []) as Rule[])
      setCommands((commandsResult.data ?? []) as Command[])
      try {
        const extensionResult = await supabase.from('devices').select('id, last_extension_seen_at')
        if (seq !== loadSeqRef.current) return
        if (extensionResult.error) {
          setExtensionSeenByDevice(new Map())
        } else {
          const seen = new Map<string, string | null>()
          for (const row of (extensionResult.data ?? []) as Array<{
            id: string
            last_extension_seen_at: string | null
          }>) {
            seen.set(row.id, row.last_extension_seen_at)
          }
          setExtensionSeenByDevice(seen)
        }
      } catch {
        if (seq === loadSeqRef.current) setExtensionSeenByDevice(new Map())
      }
      try {
        const enforcementResult = await supabase
          .from('devices')
          .select('id, enforcement_json, enforcement_updated_at')
        if (seq !== loadSeqRef.current) return
        if (enforcementResult.error) {
          setEnforcementByDevice(new Map())
        } else {
          const snapshots = new Map<
            string,
            { snapshot: EnforcementSnapshot | null; updatedAt: string | null }
          >()
          for (const row of (enforcementResult.data ?? []) as Array<{
            id: string
            enforcement_json: unknown
            enforcement_updated_at: string | null
          }>) {
            snapshots.set(row.id, {
              snapshot: parseEnforcementSnapshot(row.enforcement_json),
              updatedAt: row.enforcement_updated_at,
            })
          }
          setEnforcementByDevice(snapshots)
        }
      } catch {
        if (seq === loadSeqRef.current) setEnforcementByDevice(new Map())
      }
      // Chỉ chọn các cột của migration 1 (migration 5 chưa áp dụng thì các
      // cột child_id/device_id/details chưa tồn tại). Loại sự kiện nằm ở
      // cột `action`, `target` giữ id thiết bị dạng text.
      try {
        const alertsResult = await supabase
          .from('audit_logs')
          .select('id, family_id, action, target, created_at')
          .in('action', ['clock_drift', 'agent_restart', 'extension_missing', 'service_stopped'])
          .order('created_at', { ascending: false })
          .limit(20)
        if (seq !== loadSeqRef.current) return
        if (alertsResult.error) throw alertsResult.error
        setAlerts((alertsResult.data ?? []) as AuditLog[])
        setAlertsFailed(false)
      } catch {
        if (seq === loadSeqRef.current) {
          setAlerts([])
          setAlertsFailed(true)
        }
      }
      setState('ready')
    } catch (err) {
      if (seq !== loadSeqRef.current) return
      setError(toVietnameseError(err))
      setState('error')
    }
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  const nowMs = Date.now()
  // Tính mới mỗi lần render (không đóng băng từ lúc mount): trang mở
  // qua nửa đêm rồi tải lại phải dùng ngày mới cho nhãn, biểu đồ và
  // giờ còn lại.
  const now = new Date()
  const todayLabel = now.toLocaleDateString('vi-VN', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })

  const childNameById = useMemo(
    () => new Map(children.map((c) => [c.id, c.display_name])),
    [children],
  )
  const deviceById = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices])
  const deviceIdsByChild = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const device of devices) {
      if (!device.child_id) continue
      const list = map.get(device.child_id) ?? []
      list.push(device.id)
      map.set(device.child_id, list)
    }
    return map
  }, [devices])
  const rulesByChild = useMemo(() => {
    const map = new Map<string, Rule[]>()
    for (const rule of rules) {
      const list = map.get(rule.child_id) ?? []
      list.push(rule)
      map.set(rule.child_id, list)
    }
    return map
  }, [rules])

  const totalSec = useMemo(() => sumDurationSec(usage), [usage])
  const webSec = useMemo(() => sumDurationSec(visits), [visits])
  const blockedCount = useMemo(() => countBlockedVisits(visits), [visits])
  const onlineCount = useMemo(
    () => devices.filter((device) => isDeviceOnline(device, nowMs)).length,
    // nowMs cố định theo lần render — trạng thái online cập nhật khi tải lại trang.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [devices],
  )

  const usedSecByChild = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of usage) {
      map.set(row.child_id, (map.get(row.child_id) ?? 0) + Math.max(0, row.duration_sec))
    }
    return map
  }, [usage])

  const remainingByChild = useMemo(
    () =>
      children.map((child) => ({
        child,
        remaining: remainingTimeForChild({
          rules: rulesByChild.get(child.id) ?? [],
          usedSec: usedSecByChild.get(child.id) ?? 0,
          commands,
          deviceIds: deviceIdsByChild.get(child.id) ?? [],
          now,
        }),
      })),
    [children, rulesByChild, usedSecByChild, commands, deviceIdsByChild, now],
  )

  const topApps = useMemo<TopApp[]>(() => {
    const byApp = new Map<string, TopApp>()
    for (const row of usage) {
      const current = byApp.get(row.app_name) ?? { appName: row.app_name, totalSec: 0, sessions: 0 }
      current.totalSec += Math.max(0, row.duration_sec ?? 0)
      current.sessions += 1
      byApp.set(row.app_name, current)
    }
    return [...byApp.values()].sort((a, b) => b.totalSec - a.totalSec).slice(0, 8)
  }, [usage])
  const maxTopSec = topApps.length > 0 ? topApps[0].totalSec : 0

  const topDomainEntries = useMemo(() => topDomains(visits, 5), [visits])
  const maxDomainSec = topDomainEntries.length > 0 ? topDomainEntries[0].totalSec : 0

  const chartData = useMemo<HourChartRow[]>(
    () =>
      hourlyTotals(usage, now).map((row) => ({
        ...row,
        minutes: Math.round(row.totalSec / 60),
      })),
    [usage, now],
  )

  const recentUsage = useMemo(
    () =>
      [...usage].sort(
        (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
      ),
    [usage],
  )

  const hasAnything = children.length > 0 || devices.length > 0 || usage.length > 0 || visits.length > 0
  const truncated = usageTruncated || visitsTruncated

  if (!configured) {
    return (
      <>
        <PageHeader title="Hôm nay" description={`Tổng quan thời gian sử dụng máy tính — ${todayLabel}.`} />
        <NotConfiguredState />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Hôm nay"
        description={`Tổng quan thời gian sử dụng máy tính — ${todayLabel}. Số liệu được tính từ dữ liệu thật do Agent gửi lên.`}
        actions={
          <button type="button" onClick={() => void load()} className={secondaryButtonClassName}>
            Tải lại
          </button>
        }
      />

      {state === 'loading' && <LoadingState label="Đang tải dữ liệu hôm nay…" />}
      {state === 'error' && <ErrorState message={error} onRetry={() => void load()} />}

      {state === 'ready' && !hasAnything && (
        <EmptyState
          title="Chưa có dữ liệu hôm nay"
          description="Chưa có hồ sơ con, máy ghép nối hay dữ liệu sử dụng nào. Hãy tạo hồ sơ con và ghép nối máy của con ở trang Thiết bị để bắt đầu theo dõi."
        >
          <Link
            to="/thiet-bi"
            className="inline-flex min-h-[44px] items-center rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Tới trang Thiết bị
          </Link>
        </EmptyState>
      )}

      {state === 'ready' && hasAnything && (
        <div className="space-y-4 sm:space-y-6">
          {truncated && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800" role="status">
              Dữ liệu hôm nay rất nhiều nên số liệu dưới đây có thể chưa đủ (đã đọc tối đa 20.000
              dòng mỗi loại). Các con số vẫn đúng với phần dữ liệu đã đọc.
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <Card>
              <p className="text-sm text-slate-500">Giờ dùng máy hôm nay</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{formatDurationVi(totalSec)}</p>
            </Card>
            <Card>
              <p className="text-sm text-slate-500">Giờ duyệt web hôm nay</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{formatDurationVi(webSec)}</p>
            </Card>
            <Card>
              <p className="text-sm text-slate-500">Lượt web bị chặn</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{blockedCount}</p>
            </Card>
            <Card>
              <p className="text-sm text-slate-500">Máy đang online</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">
                {onlineCount}/{devices.length}
              </p>
            </Card>
          </div>

          <section aria-label="Trạng thái máy">
            <h2 className="mb-3 text-base font-semibold text-slate-900">Trạng thái máy</h2>
            {devices.length === 0 ? (
              <EmptyState
                title="Chưa ghép nối máy nào"
                description="Ghép nối máy của con ở trang Thiết bị để xem trạng thái máy tại đây."
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 sm:gap-4">
                {devices.map((device) => {
                  const online = isDeviceOnline(device, nowMs)
                  const extension = extensionStatus(extensionSeenByDevice.get(device.id), nowMs)
                  const enforcement = enforcementByDevice.get(device.id)
                  const snapshot = enforcement?.snapshot ?? null
                  const enforcementUpdatedMs = enforcement?.updatedAt
                    ? new Date(enforcement.updatedAt).getTime()
                    : Number.NaN
                  const enforcementStale =
                    !Number.isNaN(enforcementUpdatedMs) && nowMs - enforcementUpdatedMs > 5 * 60 * 1000
                  const override = activeOverrideForDevice(commands, device.id, nowMs)
                  const unlockExpiresAt = override?.kind === 'unlock' ? override.expiresAt : null
                  const unlockActive = unlockExpiresAt !== null
                  // Ghi đè mở khóa thắng trạng thái khóa cũ: snapshot cập
                  // nhật chậm hơn lệnh (Agent đẩy khi chữ ký đổi, từ vòng
                  // tick hoặc heartbeat), nên không ưu tiên ở đây thì thẻ
                  // sẽ hiện đồng thời "Đang khóa" và "Đang mở khóa".
                  const enforcementSupersededByUnlock =
                    unlockActive && snapshot !== null && snapshot.decision !== 'allow'
                  return (
                    <Card key={device.id}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="truncate text-base font-semibold text-slate-900">
                            {device.hostname}
                          </h3>
                          <p className="mt-0.5 text-sm text-slate-600">
                            {device.child_id
                              ? (childNameById.get(device.child_id) ?? 'Chưa gán cho con nào')
                              : 'Chưa gán cho con nào'}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-wrap justify-end gap-2">
                          {unlockActive ? (
                            <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">
                              Đang mở khóa
                            </span>
                          ) : (
                            <span
                              className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_BADGE[device.status]}`}
                            >
                              {deviceStatusLabel(device.status)}
                            </span>
                          )}
                          {!online && (
                            <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">
                              Mất kết nối
                            </span>
                          )}
                        </div>
                      </div>
                      <dl className="mt-4 space-y-1.5 text-sm">
                        <div className="flex justify-between gap-4">
                          <dt className="shrink-0 text-slate-500">Hoạt động gần nhất</dt>
                          <dd
                            className="min-w-0 break-words text-right text-slate-800"
                            title={formatDateTimeVi(device.last_seen_at)}
                          >
                            {formatRelativeVi(device.last_seen_at)}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-4">
                          <dt className="shrink-0 text-slate-500">Extension trình duyệt</dt>
                          <dd
                            className={`min-w-0 break-words text-right ${EXTENSION_TONE_CLASS[extension.tone]}`}
                            title={
                              extensionSeenByDevice.get(device.id)
                                ? formatDateTimeVi(extensionSeenByDevice.get(device.id))
                                : undefined
                            }
                          >
                            {extension.label}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-4">
                          <dt className="shrink-0 text-slate-500">Thi hành</dt>
                          <dd className="min-w-0 break-words text-right text-slate-800">
                            {snapshot ? (
                              <span className="inline-flex flex-col items-end gap-1">
                                <span
                                  className={`rounded-full px-2.5 py-1 text-xs font-medium ${enforcementSupersededByUnlock ? 'bg-amber-100 text-amber-800' : ENFORCEMENT_BADGE[snapshot.decision]}`}
                                >
                                  {enforcementSupersededByUnlock
                                    ? 'Đang mở khóa'
                                    : enforcementDecisionLabel(snapshot.decision)}
                                </span>
                                {!enforcementSupersededByUnlock && snapshot.reasons.length > 0 && (
                                  <span className="text-xs text-slate-500">
                                    Theo luật:{' '}
                                    {snapshot.reasons.map(enforcementReasonLabel).join(', ')}
                                  </span>
                                )}
                                <span className="text-xs text-slate-500">
                                  {enforcementSupersededByUnlock ? (
                                    <>
                                      Trước khi mở khóa: {enforcementDecisionLabel(snapshot.decision)}
                                      {', cập nhật '}
                                      {enforcement?.updatedAt
                                        ? formatRelativeVi(enforcement.updatedAt)
                                        : 'không rõ thời điểm'}
                                    </>
                                  ) : (
                                    <>
                                      Cập nhật{' '}
                                      {enforcement?.updatedAt
                                        ? formatRelativeVi(enforcement.updatedAt)
                                        : 'không rõ thời điểm'}
                                    </>
                                  )}
                                  {!enforcementSupersededByUnlock && enforcementStale && (
                                    <span className="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                                      Dữ liệu cũ
                                    </span>
                                  )}
                                </span>
                              </span>
                            ) : (
                              <span className="text-slate-500">Chưa có dữ liệu thi hành</span>
                            )}
                          </dd>
                        </div>
                        {unlockExpiresAt && (
                          <div className="flex justify-between gap-4">
                            <dt className="shrink-0 text-slate-500">Mở khóa đến</dt>
                            <dd className="min-w-0 break-words text-right font-medium text-amber-800">
                              {formatTimeVi(unlockExpiresAt.toISOString())}
                            </dd>
                          </div>
                        )}
                      </dl>
                    </Card>
                  )
                })}
              </div>
            )}
          </section>

          <section aria-label="Giờ còn lại hôm nay">
            <h2 className="mb-3 text-base font-semibold text-slate-900">Giờ còn lại hôm nay</h2>
            {children.length === 0 ? (
              <EmptyState
                title="Chưa có hồ sơ con nào"
                description="Tạo hồ sơ con ở trang Thiết bị để xem giờ còn lại của từng con tại đây."
              />
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2 sm:gap-4">
                  {remainingByChild.map(({ child, remaining }) => {
                    const capSec =
                      remaining.capMin === null ? null : (remaining.capMin + remaining.bonusMin) * 60
                    const usedPercent =
                      capSec !== null && capSec > 0
                        ? Math.min(100, Math.round((remaining.usedSec / capSec) * 100))
                        : 0
                    return (
                      <Card key={child.id}>
                        <h3 className="truncate text-base font-semibold text-slate-900">
                          {child.display_name}
                        </h3>
                        {remaining.state === 'unlocked' && remaining.unlockExpiresAt ? (
                          <>
                            <p className="mt-2 text-2xl font-bold text-amber-800">Đang mở khóa tạm thời</p>
                            <p className="mt-1 text-sm text-slate-600">
                              Quy tắc giờ giấc đang ngưng đến{' '}
                              {formatTimeVi(remaining.unlockExpiresAt.toISOString())}. Đã dùng{' '}
                              {formatDurationVi(remaining.usedSec)} hôm nay.
                            </p>
                          </>
                        ) : remaining.state === 'unlimited' ? (
                          <>
                            <p className="mt-2 text-2xl font-bold text-slate-900">Không giới hạn</p>
                            <p className="mt-1 text-sm text-slate-600">
                              Hôm nay không có giới hạn giờ. Đã dùng{' '}
                              {formatDurationVi(remaining.usedSec)}.
                            </p>
                          </>
                        ) : remaining.state === 'over' ? (
                          <>
                            <p className="mt-2 text-2xl font-bold text-red-700">
                              Đã vượt giới hạn {formatDurationVi(Math.abs(remaining.remainingSec ?? 0))}
                            </p>
                            <p className="mt-1 text-sm text-slate-600">
                              Đã dùng {formatDurationVi(remaining.usedSec)}
                              {remaining.capMin !== null && (
                                <>
                                  {' '}
                                  / giới hạn {formatDurationVi(remaining.capMin * 60)}
                                </>
                              )}
                              .
                            </p>
                            <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
                              <div className="h-full rounded-full bg-red-600" style={{ width: '100%' }} />
                            </div>
                          </>
                        ) : (
                          <>
                            <p className="mt-2 text-2xl font-bold text-slate-900">
                              Còn {formatDurationVi(remaining.remainingSec ?? 0)}
                            </p>
                            <p className="mt-1 text-sm text-slate-600">
                              Đã dùng {formatDurationVi(remaining.usedSec)}
                              {remaining.capMin !== null && (
                                <>
                                  {' '}
                                  / giới hạn {formatDurationVi(remaining.capMin * 60)}
                                </>
                              )}
                              .
                            </p>
                            <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
                              <div
                                className="h-full rounded-full bg-indigo-600"
                                style={{ width: `${usedPercent}%` }}
                              />
                            </div>
                          </>
                        )}
                        {remaining.bonusMin > 0 && (
                          <p className="mt-2 text-sm text-slate-600">
                            Đã gồm {formatDurationVi(remaining.bonusMin * 60)} thưởng thêm đang hiệu lực.
                          </p>
                        )}
                      </Card>
                    )
                  })}
                </div>
                <p className="mt-3 text-xs text-slate-500">
                  Giờ còn lại tính theo dữ liệu đã đồng bộ lên (Agent gửi mỗi 5 phút) nên có thể chậm
                  vài phút so với máy con; quyết định khóa thật do Agent trên máy thi hành. Chỉ tính
                  thời gian dùng ứng dụng — thời gian duyệt web không cộng thêm vì đã nằm trong thời
                  gian dùng trình duyệt. Con có nhiều máy thì phút thưởng hiện mức lớn nhất đang hiệu
                  lực giữa các máy.
                </p>
              </>
            )}
          </section>

          <Card title="Giờ dùng trong ngày">
            {totalSec === 0 ? (
              <p className="text-sm text-slate-600">
                Chưa có dữ liệu dùng máy hôm nay. Biểu đồ sẽ hiện khi Agent gửi dữ liệu lên.
              </p>
            ) : (
              <>
                <Suspense
                  fallback={
                    <div className="flex h-60 items-center justify-center">
                      <Spinner label="Đang tải biểu đồ…" />
                    </div>
                  }
                >
                  <TodayHourChart data={chartData} />
                </Suspense>
                <p className="mt-2 text-xs text-slate-500">
                  Đơn vị: phút. Mỗi phiên được tính vào giờ bắt đầu của nó.
                </p>
              </>
            )}
          </Card>

          <div className="grid gap-3 sm:grid-cols-2 sm:gap-4">
            <Card title="Ứng dụng dùng nhiều nhất hôm nay">
              {topApps.length === 0 ? (
                <p className="text-sm text-slate-600">Chưa có ứng dụng nào được ghi nhận.</p>
              ) : (
                <ul className="space-y-3">
                  {topApps.map((app) => (
                    <li key={app.appName}>
                      <div className="flex items-baseline justify-between gap-4 text-sm">
                        <span className="min-w-0 truncate font-medium text-slate-800">{app.appName}</span>
                        <span className="shrink-0 text-slate-600">
                          {formatDurationVi(app.totalSec)} · {app.sessions} phiên
                        </span>
                      </div>
                      <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className="h-full rounded-full bg-indigo-600"
                          style={{ width: `${maxTopSec > 0 ? Math.round((app.totalSec / maxTopSec) * 100) : 0}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Website dùng nhiều nhất hôm nay">
              {topDomainEntries.length === 0 ? (
                <p className="text-sm text-slate-600">
                  Chưa có dữ liệu duyệt web hôm nay. Cần cài extension trình duyệt trên máy con để
                  ghi nhận lượt web.
                </p>
              ) : (
                <>
                  <ul className="space-y-3">
                    {topDomainEntries.map((entry) => (
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
                            style={{
                              width: `${maxDomainSec > 0 ? Math.round((entry.totalSec / maxDomainSec) * 100) : 0}%`,
                            }}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-xs text-slate-500">
                    Lượt web bị chặn không tính vào thời gian xem. Hôm nay có {blockedCount} lượt bị
                    chặn.
                  </p>
                </>
              )}
            </Card>
          </div>

          <Card title="Hoạt động mới nhất">
            {recentUsage.length === 0 ? (
              <p className="text-sm text-slate-600">Chưa có hoạt động nào được ghi nhận hôm nay.</p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[40rem] text-left text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500">
                        <th className="pb-2 pr-4 font-medium">Ứng dụng</th>
                        <th className="pb-2 pr-4 font-medium">Con</th>
                        <th className="pb-2 pr-4 font-medium">Máy</th>
                        <th className="pb-2 pr-4 font-medium">Bắt đầu</th>
                        <th className="pb-2 font-medium">Thời lượng</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentUsage.slice(0, 20).map((row) => (
                        <tr key={row.id} className="border-b border-slate-100 last:border-0">
                          <td className="py-2 pr-4 font-medium text-slate-800">{row.app_name}</td>
                          <td className="py-2 pr-4 text-slate-600">
                            {childNameById.get(row.child_id) ?? '—'}
                          </td>
                          <td className="py-2 pr-4 text-slate-600">
                            {deviceById.get(row.device_id)?.hostname ?? '—'}
                          </td>
                          <td className="py-2 pr-4 text-slate-600" title={formatRelativeVi(row.started_at)}>
                            {formatTimeVi(row.started_at)}
                          </td>
                          <td className="py-2 text-slate-800">{formatDurationVi(row.duration_sec)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {recentUsage.length > 20 && (
                  <p className="mt-3 text-xs text-slate-500">
                    Đang hiển thị 20 hoạt động mới nhất trong tổng số {recentUsage.length} phiên hôm
                    nay.
                  </p>
                )}
              </>
            )}
          </Card>

          <Card title="Cảnh báo gần đây">
            {alertsFailed ? (
              <p className="text-sm text-slate-600">Không tải được cảnh báo.</p>
            ) : alerts.length === 0 ? (
              <p className="text-sm text-slate-600">Chưa có cảnh báo nào.</p>
            ) : (
              <ul className="space-y-3">
                {alerts.map((alert) => {
                  const device = alert.target ? deviceById.get(alert.target) : undefined
                  const childName =
                    device?.child_id ? (childNameById.get(device.child_id) ?? '—') : '—'
                  return (
                    <li
                      key={alert.id}
                      className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 pb-3 last:border-0 last:pb-0"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-800">{tamperEventLabel(alert.action)}</p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          Máy: {device?.hostname ?? '—'} · Con: {childName}
                        </p>
                      </div>
                      <span
                        className="shrink-0 text-sm text-slate-600"
                        title={formatDateTimeVi(alert.created_at)}
                      >
                        {formatRelativeVi(alert.created_at)}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
        </div>
      )}
    </>
  )
}
