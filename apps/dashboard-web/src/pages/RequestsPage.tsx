import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import type { AppRequest, Child, Device, DeviceChildAccount } from '../lib/types'
import { describeCommandInsertError, fetchDeviceChildAccounts } from '../lib/deviceChildren'
import {
  formatDateTimeVi,
  formatRelativeVi,
  requestStatusLabel,
  requestTypeLabel,
  toVietnameseError,
} from '../lib/format'
import {
  UNBLOCK_DOMAIN_DURATIONS,
  buildAllowDomainCommandPayload,
  clampUnblockMinutes,
} from '../lib/domainRequest'
import {
  AlertBox,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  NotConfiguredState,
  PageHeader,
  badgeBaseClassName,
  chipClassName,
  dangerButtonClassName,
  inputClassName,
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
  const [devices, setDevices] = useState<Device[]>([])
  // Ánh xạ con ↔ tài khoản Windows (bảng device_child_accounts,
  // migration 24) — best-effort (xem load()): chưa áp migration 24 thì
  // rỗng và đường dự phòng tìm máy của con chạy như trước.
  const [childAccounts, setChildAccounts] = useState<DeviceChildAccount[]>([])
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [decidingId, setDecidingId] = useState<string | null>(null)
  // Yêu cầu xin mở trang web đang mở bảng chọn thời lượng duyệt (chỉ một
  // thẻ mở cùng lúc) + số phút phụ huynh chọn (chuỗi nhập, mặc định 30).
  const [domainApproveId, setDomainApproveId] = useState<string | null>(null)
  const [domainApproveMinutes, setDomainApproveMinutes] = useState('30')

  const load = useCallback(async () => {
    if (!supabase || !user) {
      setState('ready')
      return
    }
    setState('loading')
    setError('')
    try {
      const [requestsResult, childrenResult, devicesResult] = await Promise.all([
        supabase
          .from('requests')
          .select('id, family_id, child_id, type, status, reason, decided_by, decided_at, created_at')
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('children')
          .select('id, family_id, display_name, birth_year, avatar_url, created_at'),
        supabase
          .from('devices')
          .select('id, family_id, child_id, hostname, os_version, agent_version, last_seen_at, last_extension_seen_at'),
      ])
      if (requestsResult.error) throw requestsResult.error
      if (childrenResult.error) throw childrenResult.error
      if (devicesResult.error) throw devicesResult.error
      setRequests((requestsResult.data ?? []) as AppRequest[])
      setChildren((childrenResult.data ?? []) as Child[])
      setDevices((devicesResult.data ?? []) as Device[])
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
      // Truy vấn RIÊNG thứ hai, best-effort: cột domain chỉ có sau
      // migration 18. Tách riêng khỏi truy vấn minutes/device_id để khi
      // migration 18 chưa áp thì truy vấn này lỗi một mình, không làm mất
      // số phút/máy của truy vấn trên.
      try {
        const domainResult = await supabase
          .from('requests')
          .select('id, domain')
          .order('created_at', { ascending: false })
          .limit(100)
        if (!domainResult.error) {
          const domainById = new Map<string, string | null>()
          for (const row of (domainResult.data ?? []) as Array<{ id: string; domain: string | null }>) {
            domainById.set(row.id, row.domain)
          }
          setRequests((prev) => prev.map((r) => (domainById.has(r.id) ? { ...r, domain: domainById.get(r.id) ?? null } : r)))
        }
      } catch {
        // Chưa có cột → giữ nguyên yêu cầu không có tên miền.
      }
      // Truy vấn RIÊNG, best-effort: bảng device_child_accounts chỉ có
      // sau migration 24. Truy vấn lỗi thì đường dự phòng tìm máy của
      // con (resolveDeviceId) chạy như trước, KHÔNG làm hỏng cả trang.
      const mappingsResult = await fetchDeviceChildAccounts(supabase)
      setChildAccounts(mappingsResult.accounts)
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

  const deviceNameById = useMemo(
    () => new Map(devices.map((d) => [d.id, d.hostname])),
    [devices],
  )

  // Yêu cầu đang chờ duyệt lên trước, trong từng nhóm sắp theo thời gian mới nhất.
  const sortedRequests = useMemo(() => {
    return [...requests].sort((a, b) => {
      const rank = (status: AppRequest['status']) => (status === 'pending' ? 0 : 1)
      if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status)
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
  }, [requests])

  // Máy nhận lệnh duyệt: máy đã gửi yêu cầu, nếu không có thì máy của con
  // thấy gần nhất (cùng mẫu dự phòng của luồng xin thêm giờ). Sprint 5:
  // "máy của con" gồm cả máy mà con là hồ sơ mặc định lẫn máy mà con đã
  // gắn qua ánh xạ tài khoản Windows (máy chung) — không thì yêu cầu của
  // con trên máy chung sẽ gửi lệnh nhầm sang máy riêng của con (hoặc
  // không tìm thấy máy nào dù con đang ngồi trên máy chung).
  const resolveDeviceId = useCallback(
    async (request: AppRequest): Promise<string | null> => {
      if (!supabase) return null
      if (request.device_id) return request.device_id
      // Fallback khi yêu cầu cũ không có device_id (trước migration 7):
      // KHÔNG xác định được chắc máy gốc đã gửi yêu cầu — lấy máy của
      // con (mặc định HOẶC đã gắn qua ánh xạ) có last_seen_at gần nhất,
      // thay vì ưu tiên máy mặc định trước như trước đây (máy riêng của
      // con có thể vừa online trong khi yêu cầu thực ra gửi từ máy
      // chung). Đây vẫn là suy đoán, không phải máy gốc chắc chắn.
      const linkedDeviceIds = childAccounts
        .filter((a) => a.child_id === request.child_id)
        .map((a) => a.device_id)
      const { data: childDevices, error: devicesError } = await supabase
        .from('devices')
        .select('id, last_seen_at')
        .eq('child_id', request.child_id)
        .order('last_seen_at', { ascending: false, nullsFirst: false })
        .limit(1)
      if (devicesError) throw devicesError
      let linkedDevices: Array<{ id: string; last_seen_at: string | null }> | null = null
      if (linkedDeviceIds.length > 0) {
        const { data: linkedData, error: linkedError } = await supabase
          .from('devices')
          .select('id, last_seen_at')
          .in('id', linkedDeviceIds)
          .order('last_seen_at', { ascending: false, nullsFirst: false })
          .limit(1)
        if (linkedError) throw linkedError
        linkedDevices = (linkedData ?? []) as Array<{ id: string; last_seen_at: string | null }>
      }
      const candidates = [
        ...((childDevices ?? []) as Array<{ id: string; last_seen_at: string | null }>),
        ...(linkedDevices ?? []),
      ]
      candidates.sort((a, b) => {
        const timeA = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0
        const timeB = b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0
        return timeB - timeA
      })
      return candidates[0]?.id ?? null
    },
    [childAccounts],
  )

  const handleDecide = async (request: AppRequest, status: 'approved' | 'denied', approveMinutes?: number) => {
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
      let approvedDeviceId: string | null = null
      if (status === 'approved' && request.type === 'extra_time') {
        const deviceId = await resolveDeviceId(request)
        if (!deviceId) {
          throw new Error('Không tìm thấy thiết bị của con để gửi lệnh mở khóa.')
        }
        approvedDeviceId = deviceId
        const minutes = request.minutes ?? 30
        const expiresAt = new Date(Date.now() + minutes * 60000)
        // Sprint 5: lệnh mở khóa gắn với đúng con đã xin (child_id của
        // yêu cầu) trên đúng máy đã gửi yêu cầu — Agent chỉ thi hành khi
        // đúng con đó active; con chưa đăng nhập thì lệnh giữ pending
        // tới khi con đăng nhập (không áp nhầm cho con khác trên máy chung).
        const { error: insertError } = await supabase.from('commands').insert({
          family_id: request.family_id,
          device_id: deviceId,
          child_id: request.child_id,
          type: 'temporary_override',
          payload: { action: 'unlock', minutes, expires_at: expiresAt.toISOString() },
          status: 'pending',
        })
        if (insertError) throw insertError
      }
      // Duyệt yêu cầu xin mở trang web = gửi MỘT lệnh temporary_override
      // action 'allow_domain' với đúng hình dạng lệnh ghi đè domain ở
      // trang Quy tắc (domains + minutes + expires_at): Agent nhận qua
      // poll 15s, xuất bản tempAllow, extension làm mới trong ~1 phút,
      // con quay lại rồi mở lại trang thì mở được. Hết thời lượng, quy tắc website
      // bình thường áp lại. Ghi đè mới nhất thay thế ghi đè đang hiệu lực
      // trên cùng máy (kể cả ghi đè giờ giấc) — cùng ngữ nghĩa một ghi đè
      // duy nhất của Agent; thông báo sau khi duyệt nói rõ điều này.
      let approvedDomain: string | null = null
      let approvedMinutes = 0
      if (status === 'approved' && request.type === 'unblock_domain') {
        const payload = buildAllowDomainCommandPayload(request.domain, approveMinutes ?? 30, Date.now())
        if (!payload) {
          throw new Error('Yêu cầu này không có tên miền để mở. Có thể migration 18 chưa được áp dụng.')
        }
        const deviceId = await resolveDeviceId(request)
        if (!deviceId) {
          throw new Error('Không tìm thấy thiết bị của con để gửi lệnh mở trang web.')
        }
        approvedDeviceId = deviceId
        const { error: insertError } = await supabase.from('commands').insert({
          family_id: request.family_id,
          device_id: deviceId,
          child_id: request.child_id,
          type: 'temporary_override',
          payload,
          status: 'pending',
        })
        if (insertError) throw insertError
        approvedDomain = payload.domains[0]
        approvedMinutes = payload.minutes
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
      // Tên máy + ghi chú hoãn cho thông báo sau khi duyệt: lệnh gắn với
      // đúng con trên đúng máy; nếu con chưa đăng nhập trên máy đó thì
      // lệnh giữ pending và áp dụng khi con đăng nhập (Sprint 5).
      const approvedDeviceName = approvedDeviceId
        ? (deviceNameById.get(approvedDeviceId) ?? 'máy của con')
        : null
      const deferredNote =
        status === 'approved' && (request.type === 'extra_time' || request.type === 'unblock_domain')
          ? ` Nếu ${childNameById.get(request.child_id) ?? 'con'} chưa đăng nhập trên máy này, lệnh sẽ áp dụng khi con đăng nhập.`
          : ''
      setActionMessage(
        status === 'approved' && request.type === 'extra_time'
          ? `Đã duyệt: máy "${approvedDeviceName}" sẽ mở khóa trong ${request.minutes ?? 30} phút cho ${childNameById.get(request.child_id) ?? 'con'}.${deferredNote}`
          : status === 'approved' && request.type === 'unblock_domain' && approvedDomain
            ? `Đã duyệt: ${approvedDomain} sẽ được mở trong ${approvedMinutes} phút cho ${childNameById.get(request.child_id) ?? 'con'} trên máy "${approvedDeviceName}". Lệnh tới máy trong ~15 giây, extension làm mới trong ~1 phút — con quay lại rồi mở lại trang thì mở được. Ghi đè mới thay thế ghi đè đang hiệu lực của con trên máy (nếu có).${deferredNote}`
            : `Đã ${status === 'approved' ? 'duyệt' : 'từ chối'} yêu cầu của ${childNameById.get(request.child_id) ?? 'con'}.`,
      )
      setDomainApproveId(null)
    } catch (err) {
      setActionError(describeCommandInsertError(err) ?? toVietnameseError(err))
    } finally {
      setDecidingId(null)
    }
  }

  if (!configured) {
    return (
      <>
        <PageHeader
          title="Yêu cầu"
          description="Yêu cầu xin thêm giờ, xin mở ứng dụng và xin mở trang web từ con."
        />
        <NotConfiguredState />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Yêu cầu"
        description="Yêu cầu xin thêm giờ, xin mở ứng dụng và xin mở trang web từ con. Yêu cầu đang chờ duyệt hiển thị trước."
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
          description="Con chưa gửi yêu cầu xin thêm giờ, xin mở ứng dụng hay xin mở trang web nào. Khi con gửi yêu cầu từ máy tính (màn hình khóa, tray app hoặc nút trên trang web bị chặn), yêu cầu sẽ xuất hiện tại đây để phụ huynh duyệt."
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
                  {request.type === 'unblock_domain' && request.domain && (
                    <p className="mt-1 text-sm font-medium text-slate-900">
                      Trang web: {request.domain}
                    </p>
                  )}
                  {request.device_id && deviceNameById.get(request.device_id) && (
                    <p className="mt-1 text-sm text-slate-700">
                      <span className="font-medium">Máy: </span>
                      {deviceNameById.get(request.device_id)}
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
                <div className="mt-4 border-t border-slate-100 pt-4">
                  {request.type === 'unblock_domain' && domainApproveId === request.id ? (
                    <div className="space-y-3">
                      <p className="text-sm text-slate-700">
                        Cho phép mở {request.domain ?? 'trang web này'} trong bao lâu? Hết thời gian, quy tắc
                        website bình thường áp lại. Ghi đè mới thay thế ghi đè đang hiệu lực trên máy (nếu có).
                      </p>
                      <div className="flex flex-wrap gap-2" role="group" aria-label="Thời lượng cho phép mở">
                        {UNBLOCK_DOMAIN_DURATIONS.map((minutes) => (
                          <button
                            key={minutes}
                            type="button"
                            onClick={() => setDomainApproveMinutes(String(minutes))}
                            aria-pressed={domainApproveMinutes === String(minutes)}
                            className={chipClassName(domainApproveMinutes === String(minutes))}
                          >
                            {minutes} phút
                          </button>
                        ))}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <label htmlFor={`domain-minutes-${request.id}`} className="text-sm text-slate-700">
                          Hoặc số phút khác (1–240):
                        </label>
                        <span className="w-28 shrink-0">
                          <input
                            id={`domain-minutes-${request.id}`}
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={240}
                            value={domainApproveMinutes}
                            onChange={(event) => setDomainApproveMinutes(event.target.value)}
                            className={inputClassName}
                          />
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void handleDecide(request, 'approved', clampUnblockMinutes(Number(domainApproveMinutes)))}
                          disabled={decidingId === request.id}
                          className={successButtonClassName}
                        >
                          Gửi lệnh mở
                        </button>
                        <button
                          type="button"
                          onClick={() => setDomainApproveId(null)}
                          disabled={decidingId === request.id}
                          className={secondaryButtonClassName}
                        >
                          Hủy
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          if (request.type === 'unblock_domain') {
                            setDomainApproveMinutes('30')
                            setDomainApproveId(request.id)
                          } else {
                            void handleDecide(request, 'approved')
                          }
                        }}
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
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  )
}
