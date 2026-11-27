import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { formatDurationVi, isMissingTableError, toVietnameseError } from '../lib/format'
import type { RuleObservation, RuleObservationContext } from '../lib/types'
import { AlertBox, Card, ErrorState, LoadingState } from '../components/ui'

type LoadState = 'loading' | 'ready' | 'error'

// Dòng quan sát đã là số liệu GỘP theo (luật, ngày, đối tượng, ngữ
// cảnh) phía Agent + server nên một tuần chỉ có tối đa vài trăm dòng;
// vẫn phân trang như các mục báo cáo khác để không cắt lặng khi dữ
// liệu bất thường.
const PAGE_SIZE = 1000
const MAX_PAGES = 20

const OBSERVATION_COLUMNS =
  'id, family_id, child_id, device_id, rule_id, rule_name, rule_mode, target, context, occurrence_count, total_seconds, first_seen_at, last_seen_at, day, created_at'

const CONTEXT_LABELS: Record<RuleObservationContext, string> = {
  rule_disabled: 'Luật đang tắt',
  temp_allowed: 'Được cho phép tạm thời',
  unenforceable: 'Không chặn được',
}

const CONTEXT_ORDER: RuleObservationContext[] = ['rule_disabled', 'temp_allowed', 'unenforceable']

async function fetchObservationsInRange(
  client: SupabaseClient,
  childId: string,
  startDay: string,
  endDay: string,
): Promise<{ rows: RuleObservation[]; truncated: boolean }> {
  const rows: RuleObservation[] = []
  let pagesRead = 0
  let lastPageCount = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await client
      .from('rule_observations')
      .select(OBSERVATION_COLUMNS)
      .eq('child_id', childId)
      .gte('day', startDay)
      .lte('day', endDay)
      .order('day', { ascending: true })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (error) throw error
    const pageRows = (data ?? []) as RuleObservation[]
    rows.push(...pageRows)
    pagesRead = page + 1
    lastPageCount = pageRows.length
    if (pageRows.length < PAGE_SIZE) break
  }
  return { rows, truncated: pagesRead >= MAX_PAGES && lastPageCount >= PAGE_SIZE }
}

interface RuleGroup {
  key: string
  name: string
  mode: string
  totalCount: number
  totalSeconds: number
  byContext: Array<{
    context: RuleObservationContext
    rows: RuleObservation[]
    count: number
    seconds: number
  }>
}

/** Nhóm các dòng quan sát theo luật (tên + mode bản chụp), trong nhóm tách theo ngữ cảnh. */
function groupObservations(rows: RuleObservation[]): RuleGroup[] {
  const groups = new Map<string, RuleGroup>()
  for (const row of rows) {
    const key = `${row.rule_name}\n${row.rule_mode}`
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        name: row.rule_name,
        mode: row.rule_mode,
        totalCount: 0,
        totalSeconds: 0,
        byContext: [],
      }
      groups.set(key, group)
    }
    group.totalCount += row.occurrence_count
    group.totalSeconds += row.total_seconds
  }
  for (const group of groups.values()) {
    for (const context of CONTEXT_ORDER) {
      const contextRows = rows.filter(
        (row) => row.rule_name === group.name && row.rule_mode === group.mode && row.context === context,
      )
      if (contextRows.length === 0) continue
      group.byContext.push({
        context,
        rows: contextRows.sort(
          (a, b) => b.occurrence_count - a.occurrence_count || b.total_seconds - a.total_seconds,
        ),
        count: contextRows.reduce((sum, row) => sum + row.occurrence_count, 0),
        seconds: contextRows.reduce((sum, row) => sum + row.total_seconds, 0),
      })
    }
  }
  return [...groups.values()].sort((a, b) => b.totalCount - a.totalCount || b.totalSeconds - a.totalSeconds)
}

/**
 * Mục "Hoạt động thuộc diện luật đang không chặn" trong trang Báo
 * cáo tuần (migration 31, PRD §2.15): những lần con dùng ứng dụng /
 * trang web / khung giờ thuộc diện một luật CẤM mà luật không chặn
 * lúc đó — luật đang tắt, đang được cho phép tạm thời, hoặc không
 * chặn được. Số liệu suy ra từ dữ liệu sử dụng vốn đã thu (không thu
 * thêm loại dữ liệu mới), gộp theo ngày; tên luật là bản chụp lúc
 * ghi nên luật đã bị xóa vẫn hiện đúng tên cũ (giữ 90 ngày).
 *
 * Khi migration 31 chưa áp dụng, truy vấn lỗi thì hiện ghi chú "cần
 * migration" thay vì lỗi chung; các mục báo cáo khác không bị ảnh
 * hưởng vì mục này truy vấn riêng (cùng mẫu SearchTermsReport).
 */
export default function RuleObservationsReport({
  childId,
  childName,
  startDay,
  endDay,
}: {
  childId: string
  childName: string
  /** Ngày đầu tuần (yyyy-MM-dd, gồm cả ngày này) — day của dòng quan sát là ngày theo múi giờ gia đình. */
  startDay: string
  /** Ngày cuối tuần (yyyy-MM-dd, gồm cả ngày này). */
  endDay: string
}) {
  const { user } = useAuth()
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [loadError, setLoadError] = useState('')
  const [migrationMissing, setMigrationMissing] = useState(false)
  const [rows, setRows] = useState<RuleObservation[]>([])
  const [truncated, setTruncated] = useState(false)
  const loadSeqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current
    if (!supabase || !user || !childId) {
      setLoadState('ready')
      return
    }
    setLoadState('loading')
    setLoadError('')
    setMigrationMissing(false)
    try {
      const result = await fetchObservationsInRange(supabase, childId, startDay, endDay)
      if (seq !== loadSeqRef.current) return
      setRows(result.rows)
      setTruncated(result.truncated)
      setLoadState('ready')
    } catch (err) {
      if (seq !== loadSeqRef.current) return
      if (isMissingTableError(err, 'rule_observations')) {
        setMigrationMissing(true)
        setLoadState('ready')
        return
      }
      setLoadError(toVietnameseError(err))
      setLoadState('error')
    }
  }, [user, childId, startDay, endDay])

  useEffect(() => {
    void load()
  }, [load])

  const groups = useMemo(() => groupObservations(rows), [rows])
  const totalCount = useMemo(() => rows.reduce((sum, row) => sum + row.occurrence_count, 0), [rows])

  return (
    <Card title="Hoạt động thuộc diện luật đang không chặn">
      <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
        Những lần {childName} dùng ứng dụng, trang web hoặc khung giờ thuộc diện một luật cấm
        trong lúc luật đó không chặn — vì luật đang tắt, đang được cho phép tạm thời, hoặc
        không chặn được. Số liệu được suy ra từ dữ liệu sử dụng vốn đã thu (không thu thêm dữ
        liệu mới), giữ 90 ngày. Mục này chỉ có số liệu từ khi máy con chạy bản Agent có mặt
        theo dõi và migration 31 được áp dụng.
      </p>

      {loadState === 'loading' && <LoadingState label="Đang tải hoạt động theo dõi luật…" />}
      {loadState === 'error' && (
        <div className="mt-4">
          <ErrorState message={loadError} onRetry={() => void load()} />
        </div>
      )}
      {loadState === 'ready' && migrationMissing && (
        <AlertBox tone="warning" className="mt-4">
          Mục này chưa dùng được vì bảng dữ liệu theo dõi luật (rule_observations) chưa có trên
          Supabase (cần áp dụng migration 31 trong thư mục backend/supabase/migrations qua
          Supabase SQL Editor). Các mục báo cáo khác không bị ảnh hưởng.
        </AlertBox>
      )}

      {loadState === 'ready' && !migrationMissing && (
        <div className="mt-4">
          {truncated && (
            <AlertBox tone="warning" className="mb-4">
              Dữ liệu tuần này có thể chưa đủ — đã chạm giới hạn tải, bảng dưới đây chỉ tính
              trên dữ liệu đã tải được.
            </AlertBox>
          )}
          {groups.length === 0 ? (
            <p className="text-sm text-slate-600">
              Chưa ghi nhận hoạt động nào thuộc diện luật đang không chặn trong tuần này.
            </p>
          ) : (
            <>
              <p className="mb-3 text-sm text-slate-600">
                {groups.length} luật · {totalCount} lượt hoạt động thuộc diện luật trong tuần.
              </p>
              <div className="space-y-5">
                {groups.map((group) => (
                  <div key={group.key}>
                    <h3 className="text-sm font-semibold text-slate-800">
                      {group.name}
                      <span className="ml-2 font-normal text-slate-500">
                        {group.totalCount} lượt · {formatDurationVi(group.totalSeconds)}
                      </span>
                    </h3>
                    {group.byContext.map((contextGroup) => (
                      <div key={contextGroup.context} className="mt-2">
                        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                          {CONTEXT_LABELS[contextGroup.context]} · {contextGroup.count} lượt ·{' '}
                          {formatDurationVi(contextGroup.seconds)}
                        </p>
                        <div className="mt-1 overflow-x-auto">
                          <table className="w-full min-w-[420px] border-collapse text-sm">
                            <tbody>
                              {contextGroup.rows.map((row) => (
                                <tr key={row.id} className="border-b border-slate-100 last:border-0">
                                  <td className="py-1.5 pr-3">
                                    <span className="break-all font-medium text-slate-800">
                                      {row.target}
                                    </span>
                                  </td>
                                  <td className="py-1.5 pr-3 text-right text-slate-600">
                                    {row.occurrence_count} lần
                                  </td>
                                  <td className="py-1.5 text-right text-slate-600">
                                    {formatDurationVi(row.total_seconds)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  )
}
