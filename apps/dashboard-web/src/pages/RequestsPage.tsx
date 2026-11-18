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
  AlertBox,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  NotConfiguredState,
  PageHeader,
  badgeBaseClassName,
  dangerButtonClassName,
  secondaryButtonClassName,
  successButtonClassName,
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
      // Truy vấn RIÊNG, best-effort: cột minutes/device_id chỉ có sau
      // migration 7. Truy vấn lỗi (cột chưa tồn tại) thì yêu cầu vẫn hiện
      // (không có số phút/máy), KHÔNG làm hỏng cả trang — cùng lý do như
      // truy vấn best-effort ở DevicesPage (Vercel deploy trước, migration
      // paste sau). Cùng thứ tự + giới hạn với truy vấn chính để gộp đúng
      // 100 yêu cầu mới nhất theo id.
      try {
        const extraResult = await supabase
          .from('requests')
          .select('id, minutes, device_id')
          .order('created_at', { ascending: false })
          .limit(100)
        if (!extraResult.error) {
          const extraById = new Map<string, { minutes: number | null; device_id: string | null }>()
          for (const row of (extraResult.data ?? []) as Array<{ id: string; minutes: number | null; device_id: string | null }>) {
            extraById.set(row.id, { minutes: row.minutes, device_id: row.device_id })
          }
          setRequests((prev) => prev.map((r) => ({ ...r, ...(extraById.get(r.id) ?? {}) })))
        }
      } catch {
        // Chưa có cột → giữ nguyên yêu cầu không có số phút/máy.
      }
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
      // Duyệt yêu cầu xin thêm giờ = MỞ KHÓA TRONG ĐÚNG N PHÚT (đợt sửa
      // 17/11/2026): gửi MỘT lệnh temporary_override action 'unlock' với
      // expires_at = now + N phút (cùng mẫu với "Mở khóa ngay" ở trang
      // Thiết bị). Mẫu cũ (lệnh unlock trần + bonus_minutes tới hết ngày)
      // không có tác dụng khi con đã dùng vượt mức trần ngày: test máy
      // thật 17/11/2026 cho thấy máy mở khóa rồi ~1 phút sau khóa lại vì
      // đã dùng 209 phút > mức trần + bonus. Trong N phút được duyệt,
      // giờ ngủ/khung giờ/giới hạn ngày đều tạm ngưng — cùng ngữ nghĩa
      // với "Mở khóa ngay", do phụ huynh duyệt tường minh; hết N phút
      // các quy tắc áp lại như cũ. Lệnh gửi trước, cập nhật trạng thái
      // sau — gửi lệnh lỗi thì yêu cầu vẫn ở trạng thái chờ để phụ huynh
      // thử lại.
      if (status === 'approved' && request.type === 'extra_time') {
        let deviceId = request.device_id ?? null
        if (!deviceId) {
          const { data: childDevices, error: devicesError } = await supabase
            .from('devices')
            .select('id, last_seen_at')
            .eq('child_id', request.child_id)
            .order('last_seen_at', { ascending: false, nullsFirst: false })
            .limit(1)
          if (devicesError) throw devicesError
          deviceId = childDevices?.[0]?.id ?? null
        }
        if (!deviceId) {
          throw new Error('Không tìm thấy thiết bị của con để gửi lệnh mở khóa.')
        }
        const minutes = request.minutes ?? 30
        const expiresAt = new Date(Date.now() + minutes * 60000)
        const { error: insertError } = await supabase.from('commands').insert({
          family_id: request.family_id,
          device_id: deviceId,
          type: 'temporary_override',
          payload: { action: 'unlock', minutes, expires_at: expiresAt.toISOString() },
          status: 'pending',
        })
        if (insertError) throw insertError
      }
      // Yêu cầu xin mở ứng dụng: chưa có thông tin app trong yêu cầu nên
      // duyệt chỉ đổi trạng thái (phụ huynh tự mở bằng ghi đè tạm thời ở
      // trang Quy tắc).
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
        status === 'approved' && request.type === 'extra_time'
          ? `Đã duyệt: máy sẽ mở khóa trong ${request.minutes ?? 30} phút cho ${childNameById.get(request.child_id) ?? 'con'}.`
          : `Đã ${status === 'approved' ? 'duyệt' : 'từ chối'} yêu cầu của ${childNameById.get(request.child_id) ?? 'con'}.`,
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
        <AlertBox tone="success" className="mb-4">
          {actionMessage}
        </AlertBox>
      )}
      {actionError && (
        <AlertBox tone="error" className="mb-4">
          {actionError}
        </AlertBox>
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
                  {request.type === 'extra_time' && request.minutes != null && (
                    <p className="mt-1 text-sm font-medium text-slate-900">
                      Xin thêm {request.minutes} phút
                    </p>
                  )}
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
                  className={`${badgeBaseClassName} ${STATUS_BADGE[request.status]}`}
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
                    className={successButtonClassName}
                  >
                    Duyệt
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDecide(request, 'denied')}
                    disabled={decidingId === request.id}
                    className={dangerButtonClassName}
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
