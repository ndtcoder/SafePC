import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import type { AppRequest, Child } from '../lib/types'
import {
  formatDateTimeVi,
  formatRelativeVi,
  requestStatusLabel,
  requestTypeLabel,
  toVietnameseError,
} from '../lib/format'
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  NotConfiguredState,
  PageHeader,
  secondaryButtonClassName,
} from '../components/ui'

const STATUS_BADGE: Record<AppRequest['status'], string> = {
  pending: 'bg-amber-100 text-amber-800',
  approved: 'bg-emerald-100 text-emerald-800',
  denied: 'bg-red-100 text-red-800',
}

type LoadState = 'loading' | 'ready' | 'error'

export default function RequestsPage() {
  const { configured, user } = useAuth()
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [requests, setRequests] = useState<AppRequest[]>([])
  const [children, setChildren] = useState<Child[]>([])
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [decidingId, setDecidingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!supabase || !user) {
      setState('ready')
      return
    }
    setState('loading')
    setError('')
    try {
      const [requestsResult, childrenResult] = await Promise.all([
        supabase
          .from('requests')
          .select('id, family_id, child_id, type, status, reason, decided_by, decided_at, created_at')
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('children')
          .select('id, family_id, display_name, birth_year, avatar_url, created_at'),
      ])
      if (requestsResult.error) throw requestsResult.error
      if (childrenResult.error) throw childrenResult.error
      setRequests((requestsResult.data ?? []) as AppRequest[])
      setChildren((childrenResult.data ?? []) as Child[])
      setState('ready')
    } catch (err) {
      setError(toVietnameseError(err))
      setState('error')
    }
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  const childNameById = useMemo(
    () => new Map(children.map((c) => [c.id, c.display_name])),
    [children],
  )

  // Yêu cầu đang chờ duyệt lên trước, trong từng nhóm sắp theo thời gian mới nhất.
  const sortedRequests = useMemo(() => {
    return [...requests].sort((a, b) => {
      const rank = (status: AppRequest['status']) => (status === 'pending' ? 0 : 1)
      if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status)
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
  }, [requests])

  const handleDecide = async (request: AppRequest, status: 'approved' | 'denied') => {
    if (!supabase || !user) return
    setDecidingId(request.id)
    setActionError(null)
    setActionMessage(null)
    try {
      const { error: updateError } = await supabase
        .from('requests')
        .update({
          status,
          decided_by: user.id,
          decided_at: new Date().toISOString(),
        })
        .eq('id', request.id)
      if (updateError) throw updateError
      setRequests((prev) =>
        prev.map((r) =>
          r.id === request.id
            ? { ...r, status, decided_by: user.id, decided_at: new Date().toISOString() }
            : r,
        ),
      )
      setActionMessage(
        `Đã ${status === 'approved' ? 'duyệt' : 'từ chối'} yêu cầu của ${childNameById.get(request.child_id) ?? 'con'}.`,
      )
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setDecidingId(null)
    }
  }

  if (!configured) {
    return (
      <>
        <PageHeader
          title="Yêu cầu"
          description="Yêu cầu xin thêm giờ và xin mở ứng dụng từ con."
        />
        <NotConfiguredState />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Yêu cầu"
        description="Yêu cầu xin thêm giờ và xin mở ứng dụng từ con. Yêu cầu đang chờ duyệt hiển thị trước."
        actions={
          <button type="button" onClick={() => void load()} className={secondaryButtonClassName}>
            Tải lại
          </button>
        }
      />

      {actionMessage && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800" role="status">
          {actionMessage}
        </div>
      )}
      {actionError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
          {actionError}
        </div>
      )}

      {state === 'loading' && <LoadingState label="Đang tải danh sách yêu cầu…" />}
      {state === 'error' && <ErrorState message={error} onRetry={() => void load()} />}

      {state === 'ready' && requests.length === 0 && (
        <EmptyState
          title="Chưa có yêu cầu nào"
          description="Con chưa gửi yêu cầu xin thêm giờ hay xin mở ứng dụng nào. Khi con gửi yêu cầu từ máy tính (màn hình khóa hoặc tray app), yêu cầu sẽ xuất hiện tại đây để phụ huynh duyệt."
        />
      )}

      {state === 'ready' && sortedRequests.length > 0 && (
        <div className="space-y-3">
          {sortedRequests.map((request) => (
            <Card key={request.id}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-slate-900">
                    {requestTypeLabel(request.type)} — {childNameById.get(request.child_id) ?? 'Không rõ con'}
                  </h2>
                  <p className="mt-1 text-sm text-slate-700">
                    <span className="font-medium">Lý do: </span>
                    {request.reason && request.reason.trim() !== '' ? request.reason : 'Con không nhập lý do.'}
                  </p>
                  <p className="mt-2 text-xs text-slate-500" title={formatDateTimeVi(request.created_at)}>
                    Gửi {formatRelativeVi(request.created_at)}
                    {request.decided_at && (
                      <> · Đã xử lý {formatDateTimeVi(request.decided_at)}</>
                    )}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_BADGE[request.status]}`}
                >
                  {requestStatusLabel(request.status)}
                </span>
              </div>
              {request.status === 'pending' && (
                <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
                  <button
                    type="button"
                    onClick={() => void handleDecide(request, 'approved')}
                    disabled={decidingId === request.id}
                    className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Duyệt
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDecide(request, 'denied')}
                    disabled={decidingId === request.id}
                    className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Từ chối
                  </button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  )
}
