import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import {
  formatDateTimeVi,
  formatDurationVi,
  isMissingColumnError,
  toVietnameseError,
} from '../lib/format'
import {
  filterWebHistory,
  isSafeDomainForLink,
  webHistoryRangeLabel,
  webHistoryRangeStart,
  WEB_HISTORY_RANGES,
  type WebHistoryRangeDays,
} from '../lib/weekReport'
import type { WebVisit } from '../lib/types'
import {
  AlertBox,
  Card,
  ErrorState,
  Field,
  inputClassName,
  LoadingState,
  MigrationMissingState,
  secondaryButtonClassName,
  textLinkClassName,
} from '../components/ui'

type LoadState = 'loading' | 'ready' | 'error'

// Cùng trần phân trang với trang Báo cáo tuần (1000 hàng/trang, tối đa
// 20 trang): lịch sử 90 ngày có thể vượt 1000 hàng, khi đó giao diện
// cảnh báo thay vì cắt lặng.
const PAGE_SIZE = 1000
const MAX_PAGES = 20
// Số hàng hiện mỗi đợt (phân trang hiển thị tầng hai, cùng mẫu trang
// Nhật ký): danh sách dài thì phụ huynh bấm "Xem thêm" thay vì tải cả
// nghìn hàng lên màn hình điện thoại cùng lúc.
const DISPLAY_BATCH = 50

const WEB_HISTORY_COLUMNS =
  'id, family_id, device_id, child_id, domain, path, visited_at, blocked, duration_sec, created_at'

async function fetchHistoryInRange(
  client: SupabaseClient,
  childId: string,
  startIso: string,
  endIso: string,
): Promise<{ rows: WebVisit[]; truncated: boolean }> {
  const rows: WebVisit[] = []
  let pagesRead = 0
  let lastPageCount = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await client
      .from('web_visits')
      .select(WEB_HISTORY_COLUMNS)
      .eq('child_id', childId)
      .gte('visited_at', startIso)
      .lt('visited_at', endIso)
      .order('visited_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (error) throw error
    const pageRows = (data ?? []) as WebVisit[]
    rows.push(...pageRows)
    pagesRead = page + 1
    lastPageCount = pageRows.length
    if (pageRows.length < PAGE_SIZE) break
  }
  return { rows, truncated: pagesRead >= MAX_PAGES && lastPageCount >= PAGE_SIZE }
}

/**
 * Khu vực "Tìm kiếm lịch sử web" trong trang Báo cáo tuần (migration 19
 * + extension 0.1.10): phụ huynh tìm theo tên miền hoặc đường dẫn để
 * kiểm tra nội dung con đã xem có an toàn không.
 *
 * - Lọc: khoảng 7/30/90 ngày, chỉ lượt bị chặn / tất cả; tìm kiếm khớp
 *   một phần, không phân biệt hoa thường, trên cả tên miền và đường dẫn.
 * - Bấm tên miền chỉ mở TRANG CHỦ của tên miền đó ở tab mới để kiểm
 *   tra — đường dẫn hiển thị chỉ để đọc, không bao giờ dùng để dựng lại
 *   URL đầy đủ (phần truy vấn vốn đã bị cắt lúc thu thập nên không dựng
 *   lại được đúng trang).
 * - Khi migration 19 chưa áp dụng, truy vấn cột path lỗi thì hiện trạng
 *   thái "cần migration" thay vì lỗi chung; báo cáo tuần phía trên không
 *   bị ảnh hưởng vì nó không đọc cột path.
 */
export default function WebHistorySearch({
  childId,
  childName,
}: {
  childId: string
  childName: string
}) {
  const { user } = useAuth()
  const [query, setQuery] = useState('')
  const [rangeDays, setRangeDays] = useState<WebHistoryRangeDays>(7)
  const [blockedOnly, setBlockedOnly] = useState(false)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [loadError, setLoadError] = useState('')
  const [migrationMissing, setMigrationMissing] = useState(false)
  const [rows, setRows] = useState<WebVisit[]>([])
  const [truncated, setTruncated] = useState(false)
  const [visibleCount, setVisibleCount] = useState(DISPLAY_BATCH)
  // Số thứ tự lần tải: đổi con/khoảng liên tục thì phản hồi cũ về sau
  // phải bị bỏ qua, không ghi đè dữ liệu của lần tải mới nhất.
  const loadSeqRef = useRef(0)

  const loadHistory = useCallback(async () => {
    const seq = ++loadSeqRef.current
    if (!supabase || !user || !childId) {
      setLoadState('ready')
      return
    }
    setLoadState('loading')
    setLoadError('')
    setMigrationMissing(false)
    try {
      const now = new Date()
      const start = webHistoryRangeStart(rangeDays, now)
      const result = await fetchHistoryInRange(
        supabase,
        childId,
        start.toISOString(),
        now.toISOString(),
      )
      if (seq !== loadSeqRef.current) return
      setRows(result.rows)
      setTruncated(result.truncated)
      setVisibleCount(DISPLAY_BATCH)
      setLoadState('ready')
    } catch (err) {
      if (seq !== loadSeqRef.current) return
      // Cột path chưa có (migration 19 chưa áp dụng): hiện trạng thái
      // "cần migration" thay vì lỗi chung khó hiểu.
      if (isMissingColumnError(err, 'path')) {
        setMigrationMissing(true)
        setLoadState('ready')
        return
      }
      setLoadError(toVietnameseError(err))
      setLoadState('error')
    }
  }, [user, childId, rangeDays])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  const filtered = useMemo(
    () => filterWebHistory(rows, { query, blockedOnly }),
    [rows, query, blockedOnly],
  )
  const visibleRows = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount])
  const remainingCount = filtered.length - visibleRows.length

  return (
    <Card title="Tìm kiếm lịch sử web">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Tìm kiếm" htmlFor="web-history-query">
          <input
            id="web-history-query"
            type="search"
            className={inputClassName}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setVisibleCount(DISPLAY_BATCH)
            }}
            placeholder="Tên miền hoặc đường dẫn…"
          />
        </Field>
        <Field label="Khoảng thời gian" htmlFor="web-history-range">
          <select
            id="web-history-range"
            className={inputClassName}
            value={rangeDays}
            onChange={(e) => setRangeDays(Number(e.target.value) as WebHistoryRangeDays)}
          >
            {WEB_HISTORY_RANGES.map((days) => (
              <option key={days} value={days}>
                {webHistoryRangeLabel(days)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Loại lượt xem" htmlFor="web-history-blocked">
          <select
            id="web-history-blocked"
            className={inputClassName}
            value={blockedOnly ? 'blocked' : 'all'}
            onChange={(e) => {
              setBlockedOnly(e.target.value === 'blocked')
              setVisibleCount(DISPLAY_BATCH)
            }}
          >
            <option value="all">Tất cả</option>
            <option value="blocked">Chỉ lượt bị chặn</option>
          </select>
        </Field>
      </div>

      <p className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
        Lịch sử chỉ có đường dẫn từ khi bản Agent và extension mới được cài trên máy con và migration 19
        được áp dụng — lượt xem trước thời điểm đó chỉ có tên miền. Lượt bị chặn chỉ ghi tên miền, không
        có đường dẫn. Lịch sử tự xóa sau 90 ngày. Bấm tên miền chỉ mở trang chủ của tên miền đó để phụ
        huynh kiểm tra nội dung — đường dẫn chỉ để đọc, không mở lại đúng trang đã xem.
      </p>

      {loadState === 'loading' && <LoadingState label="Đang tải lịch sử web…" />}
      {loadState === 'error' && (
        <div className="mt-4">
          <ErrorState message={loadError} onRetry={() => void loadHistory()} />
        </div>
      )}
      {loadState === 'ready' && migrationMissing && (
        <div className="mt-4">
          <MigrationMissingState
            title="Tìm kiếm lịch sử web chưa dùng được"
            detail="migration 19 (cột đường dẫn + lịch tự xóa sau 90 ngày)"
            file="20261118233000_web_history_path_retention.sql"
            onRetry={() => void loadHistory()}
          />
        </div>
      )}

      {loadState === 'ready' && !migrationMissing && (
        <div className="mt-4">
          {truncated && (
            <AlertBox tone="warning" className="mb-4">
              Lịch sử trong khoảng này có thể chưa đủ — đã chạm giới hạn tải 20.000 hàng, danh sách dưới
              đây chỉ tính trên dữ liệu đã tải được. Thu hẹp khoảng thời gian hoặc gõ từ khóa để xem đủ
              hơn.
            </AlertBox>
          )}
          {filtered.length === 0 ? (
            <p className="text-sm text-slate-600">
              {rows.length === 0
                ? `${childName} chưa có lịch sử web nào trong ${webHistoryRangeLabel(rangeDays).toLowerCase()}.`
                : 'Không có lượt nào khớp với tìm kiếm và bộ lọc hiện tại.'}
            </p>
          ) : (
            <>
              <p className="mb-3 text-sm text-slate-600">
                {filtered.length} lượt trong {webHistoryRangeLabel(rangeDays).toLowerCase()}
                {query.trim() ? ` khớp "${query.trim()}"` : ''}
                {blockedOnly ? ' (chỉ lượt bị chặn)' : ''}.
              </p>
              <ul className="space-y-3">
                {visibleRows.map((visit) => (
                  <li
                    key={visit.id}
                    className="border-b border-slate-100 pb-3 last:border-0 last:pb-0"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 text-sm">
                        {isSafeDomainForLink(visit.domain) ? (
                          <a
                            href={`https://${visit.domain}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={textLinkClassName}
                            title="Mở trang chủ của tên miền này ở tab mới để kiểm tra"
                          >
                            {visit.domain}
                          </a>
                        ) : (
                          <span className="font-medium text-slate-800">{visit.domain}</span>
                        )}
                        {visit.blocked && (
                          <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                            Đã chặn
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-sm text-slate-600">
                        {visit.blocked ? 'Không xem được' : formatDurationVi(visit.duration_sec)}
                        {' · '}
                        {formatDateTimeVi(visit.visited_at)}
                      </span>
                    </div>
                    {visit.path && (
                      <p className="mt-0.5 break-all text-sm text-slate-600">{visit.path}</p>
                    )}
                  </li>
                ))}
              </ul>
              {remainingCount > 0 && (
                <button
                  type="button"
                  onClick={() => setVisibleCount((count) => count + DISPLAY_BATCH)}
                  className={`mt-4 ${secondaryButtonClassName}`}
                >
                  Xem thêm ({remainingCount} lượt nữa)
                </button>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  )
}
