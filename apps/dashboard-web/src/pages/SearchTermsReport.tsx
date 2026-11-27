import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { isMissingTableError, toVietnameseError } from '../lib/format'
import {
  aggregateSearchTerms,
  filterSearchTermSummaries,
  searchEngineLabel,
} from '../lib/weekReport'
import type { SearchTerm } from '../lib/types'
import {
  AlertBox,
  Card,
  ErrorState,
  Field,
  inputClassName,
  LoadingState,
} from '../components/ui'

type LoadState = 'loading' | 'ready' | 'error'

// Cùng trần phân trang với trang Báo cáo tuần (1000 hàng/trang, tối đa
// 20 trang): chạm trần thì giao diện cảnh báo thay vì cắt lặng.
const PAGE_SIZE = 1000
const MAX_PAGES = 20
/** Số dòng tổng hợp tối đa hiển thị (đã sắp xếp theo tổng lượt giảm dần). */
const MAX_ROWS = 50

const SEARCH_TERM_COLUMNS = 'family_id, child_id, device_id, engine, term, blocked, created_at'

async function fetchSearchTermsInRange(
  client: SupabaseClient,
  childId: string,
  startIso: string,
  endIso: string,
): Promise<{ rows: SearchTerm[]; truncated: boolean }> {
  const rows: SearchTerm[] = []
  let pagesRead = 0
  let lastPageCount = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await client
      .from('search_terms')
      .select(SEARCH_TERM_COLUMNS)
      .eq('child_id', childId)
      .gte('created_at', startIso)
      .lt('created_at', endIso)
      .order('created_at', { ascending: true })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (error) throw error
    const pageRows = (data ?? []) as SearchTerm[]
    rows.push(...pageRows)
    pagesRead = page + 1
    lastPageCount = pageRows.length
    if (pageRows.length < PAGE_SIZE) break
  }
  return { rows, truncated: pagesRead >= MAX_PAGES && lastPageCount >= PAGE_SIZE }
}

/**
 * Mục "Từ khóa tìm kiếm" trong trang Báo cáo tuần (migration 28 +
 * extension chặn từ khóa): bảng cụm từ con đã tìm trong tuần đang xem
 * của con đang chọn — mỗi dòng là một cụm từ trên một công cụ tìm kiếm,
 * kèm tổng số lượt và số lượt bị chặn (nổi bật). Chỉ cụm từ gõ vào ô
 * tìm kiếm của Google, Bing, DuckDuckGo, Yahoo, Cốc Cốc mới được ghi;
 * phần truy vấn của mọi link khác vẫn bị bỏ như lịch sử web.
 *
 * Khi migration 28 chưa áp dụng, truy vấn bảng search_terms lỗi thì
 * hiện ghi chú "cần migration" thay vì lỗi chung; báo cáo tuần phía
 * trên không bị ảnh hưởng vì mục này truy vấn riêng.
 */
export default function SearchTermsReport({
  childId,
  childName,
  weekStartIso,
  weekEndIso,
}: {
  childId: string
  childName: string
  weekStartIso: string
  weekEndIso: string
}) {
  const { user } = useAuth()
  const [query, setQuery] = useState('')
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [loadError, setLoadError] = useState('')
  const [migrationMissing, setMigrationMissing] = useState(false)
  const [rows, setRows] = useState<SearchTerm[]>([])
  const [truncated, setTruncated] = useState(false)
  // Số thứ tự lần tải: đổi con/tuần liên tục thì phản hồi cũ về sau
  // phải bị bỏ qua, không ghi đè dữ liệu của lần tải mới nhất.
  const loadSeqRef = useRef(0)

  const loadTerms = useCallback(async () => {
    const seq = ++loadSeqRef.current
    if (!supabase || !user || !childId) {
      setLoadState('ready')
      return
    }
    setLoadState('loading')
    setLoadError('')
    setMigrationMissing(false)
    try {
      const result = await fetchSearchTermsInRange(supabase, childId, weekStartIso, weekEndIso)
      if (seq !== loadSeqRef.current) return
      setRows(result.rows)
      setTruncated(result.truncated)
      setLoadState('ready')
    } catch (err) {
      if (seq !== loadSeqRef.current) return
      // Bảng search_terms chưa có (migration 28 chưa áp dụng): hiện
      // ghi chú "cần migration" thay vì lỗi chung khó hiểu.
      if (isMissingTableError(err, 'search_terms')) {
        setMigrationMissing(true)
        setLoadState('ready')
        return
      }
      setLoadError(toVietnameseError(err))
      setLoadState('error')
    }
  }, [user, childId, weekStartIso, weekEndIso])

  useEffect(() => {
    void loadTerms()
  }, [loadTerms])

  const summaries = useMemo(() => aggregateSearchTerms(rows), [rows])
  const filtered = useMemo(
    () => filterSearchTermSummaries(summaries, query),
    [summaries, query],
  )
  const visible = useMemo(() => filtered.slice(0, MAX_ROWS), [filtered])
  const totalSearches = useMemo(() => summaries.reduce((sum, s) => sum + s.total, 0), [summaries])
  const totalBlocked = useMemo(
    () => summaries.reduce((sum, s) => sum + s.blockedCount, 0),
    [summaries],
  )

  return (
    <Card title="Từ khóa tìm kiếm">
      <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
        Chỉ cụm từ {childName} gõ vào ô tìm kiếm của Google, Bing, DuckDuckGo, Yahoo và Cốc Cốc mới
        được ghi lại (giữ 90 ngày); phần truy vấn của mọi link khác vẫn bị bỏ như lịch sử web. Số
        liệu chỉ có từ khi extension bản có kiểm duyệt từ khóa được cài trên máy con và migration 28
        được áp dụng.
      </p>

      <div className="mt-4 max-w-md">
        <Field label="Lọc theo từ khóa" htmlFor="search-terms-query">
          <input
            id="search-terms-query"
            type="search"
            className={inputClassName}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Gõ một phần của cụm từ…"
          />
        </Field>
      </div>

      {loadState === 'loading' && <LoadingState label="Đang tải từ khóa tìm kiếm…" />}
      {loadState === 'error' && (
        <div className="mt-4">
          <ErrorState message={loadError} onRetry={() => void loadTerms()} />
        </div>
      )}
      {loadState === 'ready' && migrationMissing && (
        <AlertBox tone="warning" className="mt-4">
          Mục này chưa dùng được vì bảng dữ liệu từ khóa tìm kiếm chưa có trên Supabase (cần áp dụng
          migration 28 trong thư mục backend/supabase/migrations qua Supabase SQL Editor, sau
          migration 24 và 27). Các mục báo cáo khác không bị ảnh hưởng.
        </AlertBox>
      )}

      {loadState === 'ready' && !migrationMissing && (
        <div className="mt-4">
          {truncated && (
            <AlertBox tone="warning" className="mb-4">
              Dữ liệu tuần này có thể chưa đủ — đã chạm giới hạn tải 20.000 hàng, bảng dưới đây chỉ
              tính trên dữ liệu đã tải được.
            </AlertBox>
          )}
          {summaries.length === 0 ? (
            <p className="text-sm text-slate-600">
              Chưa ghi nhận lượt tìm kiếm nào trong tuần này.
            </p>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-slate-600">
              Không có cụm từ nào khớp với ô lọc hiện tại.
            </p>
          ) : (
            <>
              <p className="mb-3 text-sm text-slate-600">
                {summaries.length} cụm từ · {totalSearches} lượt tìm kiếm · {totalBlocked} lượt bị
                chặn trong tuần
                {query.trim() ? ` — đang lọc theo “${query.trim()}”: ${filtered.length} cụm từ` : ''}
                {filtered.length > MAX_ROWS ? ` — hiện ${MAX_ROWS} cụm từ được tìm nhiều nhất` : ''}.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-slate-600">
                      <th scope="col" className="py-2 pr-3 font-medium">Từ khóa</th>
                      <th scope="col" className="py-2 pr-3 font-medium">Công cụ</th>
                      <th scope="col" className="py-2 pr-3 text-right font-medium">Số lượt</th>
                      <th scope="col" className="py-2 text-right font-medium">Bị chặn</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((summary) => {
                      const wasBlocked = summary.blockedCount > 0
                      return (
                        <tr
                          key={JSON.stringify([summary.term, summary.engine])}
                          className={`border-b border-slate-100 last:border-0 ${
                            wasBlocked ? 'bg-red-50/60' : ''
                          }`}
                        >
                          <td className="py-2 pr-3">
                            <span className="break-all font-medium text-slate-800">{summary.term}</span>
                            {wasBlocked && (
                              <span className="ml-2 whitespace-nowrap rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                                Bị chặn
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-slate-600">
                            {searchEngineLabel(summary.engine)}
                          </td>
                          <td className="py-2 pr-3 text-right text-slate-800">{summary.total}</td>
                          <td
                            className={`py-2 text-right ${
                              wasBlocked ? 'font-bold text-red-700' : 'text-slate-400'
                            }`}
                          >
                            {summary.blockedCount}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  )
}
