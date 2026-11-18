import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import type { AppRequest, AuditLog, Child, Command, Device } from '../lib/types'
import { formatTimeVi, toVietnameseError } from '../lib/format'
import { RULE_CHANGE_ACTIONS } from '../lib/ruleAudit'
import { ENFORCEMENT_ACTIONS, TAMPER_ACTIONS } from '../lib/weekReport'
import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_RANGES,
  activityCategoryLabel,
  buildActivityEvents,
  filterEvents,
  groupEventsByDay,
  rangeStartIso,
  type ActivityCategory,
  type ActivityEvent,
  type ActivityRangePreset,
} from '../lib/activityLog'
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
  secondaryButtonClassName,
} from '../components/ui'

type LoadState = 'loading' | 'ready' | 'error'

// PostgREST trả tối đa 1000 hàng mỗi lần gọi nên đọc theo trang, cùng
// mẫu trang Báo cáo: 20 trang (20.000 hàng) cho mỗi bảng; chạm trần thì
// báo truncated để giao diện cảnh báo thay vì cắt lặng.
const PAGE_SIZE = 1000
const MAX_PAGES = 20
/** Số sự kiện hiện mỗi đợt — nút "Xem thêm" tải đợt tiếp theo, không cắt lặng. */
const UI_PAGE_SIZE = 50

interface PagedResult<T> {
  rows: T[]
  /** true khi đã đọc đủ MAX_PAGES mà trang cuối vẫn đủ hàng — có thể còn hàng chưa đọc. */
  truncated: boolean
}

function isTruncated(pagesRead: number, lastPageCount: number): boolean {
  return pagesRead >= MAX_PAGES && lastPageCount >= PAGE_SIZE
}

async function fetchCommandsInRange(
  client: SupabaseClient,
  startIso: string | null,
): Promise<PagedResult<Command>> {
  const rows: Command[] = []
  let pagesRead = 0
  let lastPageCount = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    let query = client
      .from('commands')
      .select('id, family_id, device_id, type, payload, status, created_at')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (startIso !== null) query = query.gte('created_at', startIso)
    const { data, error } = await query
    if (error) throw error
    const pageRows = (data ?? []) as Command[]
    rows.push(...pageRows)
    pagesRead = page + 1
    lastPageCount = pageRows.length
    if (pageRows.length < PAGE_SIZE) break
  }
  return { rows, truncated: isTruncated(pagesRead, lastPageCount) }
}

/**
 * Yêu cầu trong khoảng: đọc 2 lần — theo lúc tạo và theo lúc quyết
 * định — rồi gộp theo id. Yêu cầu tạo từ lâu nhưng mới được duyệt vẫn
 * phải hiện sự kiện quyết định trong khoảng đã chọn; chỉ đọc theo
 * created_at thì mất sự kiện đó. Không giới hạn khoảng ('all') thì một
 * lần đọc là đủ.
 */
async function fetchRequestsInRange(
  client: SupabaseClient,
  startIso: string | null,
): Promise<PagedResult<AppRequest>> {
  const byId = new Map<string, AppRequest>()
  let truncated = false
  const columns =
    'id, family_id, child_id, type, status, reason, decided_by, decided_at, created_at, minutes, device_id'
  for (let page = 0; page < MAX_PAGES; page++) {
    let query = client
      .from('requests')
      .select(columns)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (startIso !== null) query = query.gte('created_at', startIso)
    const { data, error } = await query
    if (error) throw error
    const pageRows = (data ?? []) as AppRequest[]
    for (const row of pageRows) byId.set(row.id, row)
    if (pageRows.length >= PAGE_SIZE && page + 1 >= MAX_PAGES) truncated = true
    if (pageRows.length < PAGE_SIZE) break
  }
  if (startIso !== null) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data, error } = await client
        .from('requests')
        .select(columns)
        .gte('decided_at', startIso)
        .neq('status', 'pending')
        .order('decided_at', { ascending: false })
        .order('id', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
      if (error) throw error
      const pageRows = (data ?? []) as AppRequest[]
      for (const row of pageRows) byId.set(row.id, row)
      if (pageRows.length >= PAGE_SIZE && page + 1 >= MAX_PAGES) truncated = true
      if (pageRows.length < PAGE_SIZE) break
    }
  }
  // Gộp tên miền best-effort: cột domain chỉ có sau migration 18. Đọc
  // riêng theo từng nhóm id để truy vấn chính không lỗi khi migration 18
  // chưa áp (cùng lý do như truy vấn best-effort ở RequestsPage); lỗi thì
  // lặng lẽ bỏ qua, yêu cầu vẫn hiện (không có tên miền trong chi tiết).
  await mergeRequestDomains(client, byId)
  return { rows: [...byId.values()], truncated }
}

/** Đọc cột domain cho các yêu cầu đã lấy, theo từng nhóm 200 id. Lỗi thì bỏ qua toàn bộ. */
async function mergeRequestDomains(
  client: SupabaseClient,
  byId: Map<string, AppRequest>,
): Promise<void> {
  const ids = [...byId.keys()]
  if (ids.length === 0) return
  try {
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

/**
 * Sự kiện can thiệp + thi hành + đổi quy tắc trong khoảng (cùng mẫu
 * trang Báo cáo): không lọc child_id ở truy vấn — hàng cũ không có
 * child_id được khớp qua thiết bị ở phía client, hàng đổi mẫu không
 * gắn con nào. Mới nhất trước, thêm `.order('id')` để phân trang ổn
 * định khi nhiều hàng cùng created_at.
 */
async function fetchAuditLogsInRange(
  client: SupabaseClient,
  startIso: string | null,
): Promise<PagedResult<AuditLog>> {
  const rows: AuditLog[] = []
  let pagesRead = 0
  let lastPageCount = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    let query = client
      .from('audit_logs')
      .select('id, family_id, actor, action, target, ip_hash, created_at, child_id, device_id, details')
      .in('action', [...TAMPER_ACTIONS, ...ENFORCEMENT_ACTIONS, ...RULE_CHANGE_ACTIONS])
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (startIso !== null) query = query.gte('created_at', startIso)
    const { data, error } = await query
    if (error) throw error
    const pageRows = (data ?? []) as AuditLog[]
    rows.push(...pageRows)
    pagesRead = page + 1
    lastPageCount = pageRows.length
    if (pageRows.length < PAGE_SIZE) break
  }
  return { rows, truncated: isTruncated(pagesRead, lastPageCount) }
}

const CATEGORY_CHIP_CLASS: Record<ActivityCategory, string> = {
  command: 'bg-indigo-100 text-indigo-700',
  request: 'bg-sky-100 text-sky-700',
  decision: 'bg-emerald-100 text-emerald-700',
  rule_change: 'bg-violet-100 text-violet-700',
  enforcement: 'bg-amber-100 text-amber-800',
  tamper: 'bg-red-100 text-red-700',
}

/**
 * Trang Nhật ký hoạt động (PRD §2.8): lệnh phụ huynh, yêu cầu của con,
 * quyết định duyệt, đổi quy tắc, thi hành theo quy tắc và cảnh báo can
 * thiệp — gộp từ 3 bảng commands/requests/audit_logs, mới nhất trước,
 * nhóm theo ngày. Lọc theo con + loại sự kiện + khoảng thời gian. RLS
 * lo tách dữ liệu theo gia đình.
 */
export default function ActivityLogPage() {
  const { configured, user } = useAuth()

  const [metaState, setMetaState] = useState<LoadState>('loading')
  const [metaError, setMetaError] = useState('')
  const [children, setChildren] = useState<Child[]>([])
  const [devices, setDevices] = useState<Device[]>([])

  const [rangePreset, setRangePreset] = useState<ActivityRangePreset>('7d')
  const [childFilter, setChildFilter] = useState<string | 'all'>('all')
  const [categoryFilter, setCategoryFilter] = useState<ActivityCategory | 'all'>('all')
  const [visibleCount, setVisibleCount] = useState(UI_PAGE_SIZE)

  const [eventsState, setEventsState] = useState<LoadState>('loading')
  const [eventsError, setEventsError] = useState('')
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [dataTruncated, setDataTruncated] = useState(false)
  // Số thứ tự lần tải sự kiện: đổi khoảng thời gian liên tục thì phản
  // hồi cũ về sau phải bị bỏ qua, không ghi đè dữ liệu mới nhất.
  const loadSeqRef = useRef(0)

  const loadMeta = useCallback(async () => {
    if (!supabase || !user) {
      setMetaState('ready')
      return
    }
    setMetaState('loading')
    setMetaError('')
    try {
      const [childrenResult, devicesResult] = await Promise.all([
        supabase
          .from('children')
          .select('id, family_id, display_name, birth_year, avatar_url, created_at')
          .order('created_at', { ascending: true }),
        supabase
          .from('devices')
          .select('id, family_id, child_id, hostname, os_version, agent_version, last_seen_at, last_extension_seen_at, status, created_at')
          .order('created_at', { ascending: true }),
      ])
      if (childrenResult.error) throw childrenResult.error
      if (devicesResult.error) throw devicesResult.error
      setChildren((childrenResult.data ?? []) as Child[])
      setDevices((devicesResult.data ?? []) as Device[])
      setMetaState('ready')
    } catch (err) {
      setMetaError(toVietnameseError(err))
      setMetaState('error')
    }
  }, [user])

  useEffect(() => {
    void loadMeta()
  }, [loadMeta])

  const loadEvents = useCallback(async () => {
    // Tăng số thứ tự ngay cả khi trả về sớm: lần gọi nào cũng vô hiệu
    // hóa mọi phản hồi của lần tải trước còn đang bay.
    const seq = ++loadSeqRef.current
    if (!supabase || !user || metaState !== 'ready') return
    setEventsState('loading')
    setEventsError('')
    try {
      const startIso = rangeStartIso(rangePreset)
      const [commandsResult, requestsResult, logsResult] = await Promise.all([
        fetchCommandsInRange(supabase, startIso),
        fetchRequestsInRange(supabase, startIso),
        fetchAuditLogsInRange(supabase, startIso),
      ])
      if (seq !== loadSeqRef.current) return
      const childNameById = new Map(children.map((c) => [c.id, c.display_name]))
      const deviceById = new Map(devices.map((d) => [d.id, d]))
      const deviceChildById = new Map(
        devices.filter((d) => d.child_id !== null).map((d) => [d.id, d.child_id as string]),
      )
      const merged = buildActivityEvents(
        commandsResult.rows,
        requestsResult.rows,
        logsResult.rows,
        { childNameById, deviceById, currentUserId: user.id },
        deviceChildById,
        startIso !== null ? new Date(startIso).getTime() : null,
      )
      setEvents(merged)
      setDataTruncated(commandsResult.truncated || requestsResult.truncated || logsResult.truncated)
      setEventsState('ready')
    } catch (err) {
      if (seq !== loadSeqRef.current) return
      setEventsError(toVietnameseError(err))
      setEventsState('error')
    }
  }, [user, metaState, rangePreset, children, devices])

  useEffect(() => {
    void loadEvents()
  }, [loadEvents])

  // Đổi bộ lọc/khoảng thì quay về đầu danh sách.
  useEffect(() => {
    setVisibleCount(UI_PAGE_SIZE)
  }, [childFilter, categoryFilter, rangePreset])

  const filteredEvents = useMemo(
    () => filterEvents(events, { childId: childFilter, category: categoryFilter }),
    [events, childFilter, categoryFilter],
  )
  const visibleEvents = useMemo(() => filteredEvents.slice(0, visibleCount), [filteredEvents, visibleCount])
  const groups = useMemo(() => groupEventsByDay(visibleEvents), [visibleEvents])
  const remainingCount = filteredEvents.length - visibleEvents.length

  const clearFilters = () => {
    setChildFilter('all')
    setCategoryFilter('all')
  }

  return (
    <div>
      <PageHeader
        title="Nhật ký hoạt động"
        description="Lệnh khóa/mở, yêu cầu của con, quyết định duyệt, đổi quy tắc, thi hành theo quy tắc và cảnh báo can thiệp — mới nhất trước."
      />

      {!configured && <NotConfiguredState />}

      {configured && metaState === 'loading' && <LoadingState label="Đang tải danh sách con và thiết bị…" />}

      {configured && metaState === 'error' && (
        <ErrorState message={metaError} onRetry={() => void loadMeta()} />
      )}

      {configured && metaState === 'ready' && children.length === 0 && (
        <EmptyState
          title="Chưa có hồ sơ con"
          description="Tạo hồ sơ con ở trang Hồ sơ trước, nhật ký hoạt động sẽ hiện tại đây khi có lệnh, yêu cầu hoặc sự kiện thi hành."
        />
      )}

      {configured && metaState === 'ready' && children.length > 0 && (
        <div className="flex flex-col gap-4">
          {/* Ghi chú trung thực về dữ liệu chưa có nguồn — không bịa mục nào. */}
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-relaxed text-amber-800">
            <p className="font-semibold">Nhật ký này chưa ghi được mọi việc:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              <li>Lịch sử đổi quy tắc chỉ có từ khi migration 16 được áp dụng và Dashboard mới được triển khai — thay đổi trước đó không hiện ở đây.</li>
              <li>Lệnh khóa/mở chưa ghi lại ai đã gửi.</li>
              <li>Thi hành theo quy tắc chỉ có từ khi máy con cài bản Agent ghi sự kiện thi hành.</li>
            </ul>
          </div>

          <Card>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Con" htmlFor="activity-child-filter">
                <select
                  id="activity-child-filter"
                  className={inputClassName}
                  value={childFilter}
                  onChange={(e) => setChildFilter(e.target.value as string | 'all')}
                >
                  <option value="all">Tất cả các con</option>
                  {children.map((child) => (
                    <option key={child.id} value={child.id}>
                      {child.display_name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Loại sự kiện" htmlFor="activity-category-filter">
                <select
                  id="activity-category-filter"
                  className={inputClassName}
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value as ActivityCategory | 'all')}
                >
                  <option value="all">Tất cả các loại</option>
                  {ACTIVITY_CATEGORIES.map((category) => (
                    <option key={category.value} value={category.value}>
                      {category.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Khoảng thời gian" htmlFor="activity-range-filter">
                <select
                  id="activity-range-filter"
                  className={inputClassName}
                  value={rangePreset}
                  onChange={(e) => setRangePreset(e.target.value as ActivityRangePreset)}
                >
                  {ACTIVITY_RANGES.map((range) => (
                    <option key={range.value} value={range.value}>
                      {range.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={secondaryButtonClassName}
                onClick={() => void loadEvents()}
                disabled={eventsState === 'loading'}
              >
                Tải lại
              </button>
              {(childFilter !== 'all' || categoryFilter !== 'all') && (
                <button type="button" className={secondaryButtonClassName} onClick={clearFilters}>
                  Xóa bộ lọc
                </button>
              )}
            </div>
          </Card>

          {dataTruncated && eventsState === 'ready' && (
            <AlertBox tone="warning">
              Có thể còn sự kiện cũ hơn chưa tải hết (đã chạm giới hạn đọc). Thu hẹp khoảng thời gian để
              xem đủ.
            </AlertBox>
          )}

          {eventsState === 'loading' && <LoadingState label="Đang tải nhật ký…" />}

          {eventsState === 'error' && (
            <ErrorState message={eventsError} onRetry={() => void loadEvents()} />
          )}

          {eventsState === 'ready' && events.length === 0 && (
            <EmptyState
              title="Chưa có hoạt động nào trong khoảng này"
              description="Chưa có lệnh, yêu cầu hay sự kiện nào trong khoảng thời gian đã chọn. Thử chọn khoảng dài hơn."
            />
          )}

          {eventsState === 'ready' && events.length > 0 && filteredEvents.length === 0 && (
            <EmptyState
              title="Không có sự kiện nào khớp bộ lọc"
              description="Thử chọn con khác, loại sự kiện khác, hoặc xóa bộ lọc để xem tất cả."
            >
              <button type="button" className={secondaryButtonClassName} onClick={clearFilters}>
                Xóa bộ lọc
              </button>
            </EmptyState>
          )}

          {eventsState === 'ready' && groups.length > 0 && (
            <div className="flex flex-col gap-5">
              <p className="text-sm text-slate-600" role="status">
                Hiển thị {visibleEvents.length} trong {filteredEvents.length} sự kiện
                {childFilter !== 'all' || categoryFilter !== 'all' ? ' khớp bộ lọc' : ''}.
              </p>
              {groups.map((group) => (
                <section key={group.key} aria-label={group.label}>
                  <h2 className="mb-2 text-sm font-semibold text-slate-500">{group.label}</h2>
                  <ol className="flex flex-col gap-2">
                    {group.events.map((event) => (
                      <li
                        key={event.id}
                        className="flex gap-3 rounded-xl border border-slate-200 bg-white p-3 sm:p-4"
                      >
                        <span className="w-11 shrink-0 pt-0.5 text-sm font-semibold tabular-nums text-slate-700">
                          {formatTimeVi(event.at)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold text-slate-900">{event.title}</p>
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-medium ${CATEGORY_CHIP_CLASS[event.category]}`}
                            >
                              {activityCategoryLabel(event.category)}
                            </span>
                            {event.statusLabel && (
                              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                                {event.statusLabel}
                              </span>
                            )}
                          </div>
                          {event.detail && (
                            <p className="mt-0.5 break-words text-sm text-slate-600">{event.detail}</p>
                          )}
                          {(event.childName || event.deviceName) && (
                            <p className="mt-0.5 text-xs text-slate-500">
                              {[event.childName, event.deviceName].filter(Boolean).join(' · ')}
                            </p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              ))}
              {remainingCount > 0 && (
                <button
                  type="button"
                  className={`${secondaryButtonClassName} self-center`}
                  onClick={() => setVisibleCount((count) => count + UI_PAGE_SIZE)}
                >
                  Xem thêm {remainingCount} sự kiện
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
