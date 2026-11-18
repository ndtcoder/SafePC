import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import type { TimeBankGrant } from '../lib/types'
import {
  formatDateTimeVi,
  formatDurationVi,
  formatTimeVi,
  toVietnameseError,
} from '../lib/format'
import {
  activeGrantLatestExpiry,
  activeGrantTotal,
  endOfTodayIso,
  grantedByLabel,
  grantStatusLabel,
  grantValidationMessage,
  isGrantActive,
  sortGrantsDesc,
  TIME_BANK_MAX_MINUTES,
  TIME_BANK_MAX_REASON_LENGTH,
  TIME_BANK_MIN_MINUTES,
  TIME_BANK_QUICK_MINUTES,
  validateGrantInput,
} from '../lib/timeBank'
import {
  Card,
  chipClassName,
  dangerOutlineButtonClassName,
  EmptyState,
  ErrorState,
  Field,
  inputClassName,
  LoadingState,
  NotConfiguredState,
  primaryButtonClassName,
  secondaryButtonClassName,
} from '../components/ui'

type LoadState = 'loading' | 'ready' | 'error'

/** Lịch sử tối đa tải một lần; lượng thưởng mỗi ngày rất ít nên đủ dùng. */
const HISTORY_LIMIT = 200

interface RpcTotalResult {
  total_minutes?: number
  devices_notified?: number
}

/**
 * Tab Ngân hàng giờ trong hồ sơ của một con: phụ huynh thưởng thêm phút
 * kèm lý do, xem tổng phút đang hiệu lực và lịch sử, thu hồi lần thưởng
 * còn hiệu lực. Phút thưởng cộng vào mức trần giờ hôm nay (ngữ nghĩa
 * bonus_minutes), hiệu lực tới hết ngày — xem migration 13.
 *
 * Ghi qua RPC safepc_grant_time_bank / safepc_void_time_bank_grant
 * (nguyên tử: ghi sổ cái + gửi lệnh tới mọi máy của con); đọc bảng
 * time_bank_grants trực tiếp. Chưa áp migration 13 thì hiện hướng dẫn
 * thay vì lỗi thô của database.
 */
export default function TimeBankTab({ childId, childName }: { childId: string; childName: string }) {
  const { configured, user } = useAuth()
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [missingMigration, setMissingMigration] = useState(false)
  const [grants, setGrants] = useState<TimeBankGrant[]>([])
  const [deviceCount, setDeviceCount] = useState(0)
  const [historyCapped, setHistoryCapped] = useState(false)

  const [minutes, setMinutes] = useState(30)
  const [customMinutes, setCustomMinutes] = useState('30')
  const [reason, setReason] = useState('')
  const [granting, setGranting] = useState(false)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const [confirmVoidId, setConfirmVoidId] = useState<string | null>(null)
  const [voidingId, setVoidingId] = useState<string | null>(null)

  const loadSeqRef = useRef(0)

  // Giờ hiện tại lấy mới mỗi lần render (không đóng băng): nhãn "Đang
  // hiệu lực" / "Đã hết hạn" phải đúng cả khi trang mở lâu qua nửa đêm.
  const now = new Date()
  const nowMs = now.getTime()
  const total = activeGrantTotal(grants, nowMs)
  const latestExpiry = activeGrantLatestExpiry(grants, nowMs)

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current
    if (!supabase || !user) {
      setState('ready')
      return
    }
    setState('loading')
    setError('')
    setMissingMigration(false)
    try {
      const [grantsResult, devicesResult] = await Promise.all([
        supabase
          .from('time_bank_grants')
          .select('id, family_id, child_id, minutes, reason, granted_by, status, expires_at, created_at')
          .eq('child_id', childId)
          .order('created_at', { ascending: false })
          // Đọc thừa 1 hàng để biết chắc có bị cắt hay không: đúng 200
          // hàng thì chưa cắt gì, banner chỉ hiện khi thật sự có hơn.
          .limit(HISTORY_LIMIT + 1),
        supabase.from('devices').select('id').eq('child_id', childId),
      ])
      if (seq !== loadSeqRef.current) return
      if (grantsResult.error) throw grantsResult.error
      if (devicesResult.error) throw devicesResult.error
      const rows = (grantsResult.data ?? []) as TimeBankGrant[]
      setHistoryCapped(rows.length > HISTORY_LIMIT)
      setGrants(sortGrantsDesc(rows.slice(0, HISTORY_LIMIT)))
      setDeviceCount((devicesResult.data ?? []).length)
      setState('ready')
    } catch (err) {
      if (seq !== loadSeqRef.current) return
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('time_bank_grants')) {
        setMissingMigration(true)
        setState('ready')
        return
      }
      setError(toVietnameseError(err))
      setState('error')
    }
  }, [user, childId])

  useEffect(() => {
    void load()
  }, [load])

  const pickMinutes = (value: number) => {
    setMinutes(value)
    setCustomMinutes(String(value))
  }

  const handleCustomMinutes = (value: string) => {
    setCustomMinutes(value)
    const parsed = Number(value)
    if (Number.isInteger(parsed)) setMinutes(parsed)
  }

  const handleGrant = async () => {
    if (!supabase || !user) return
    const trimmedReason = reason.trim()
    // Số phút lấy từ ô nhập tại thời điểm bấm (không dùng state minutes:
    // state chỉ đổi khi giá trị là số nguyên, ô nhập có thể đang dở dang
    // như "30.5" hay rỗng — kiểm tra đúng cái phụ huynh đang thấy).
    const parsedMinutes = Number(customMinutes)
    const validationError = validateGrantInput(parsedMinutes, trimmedReason)
    if (validationError) {
      setActionError(grantValidationMessage(validationError))
      setActionMessage(null)
      return
    }
    setGranting(true)
    setActionError(null)
    setActionMessage(null)
    try {
      const { data, error: rpcError } = await supabase.rpc('safepc_grant_time_bank', {
        p_child_id: childId,
        p_minutes: parsedMinutes,
        p_reason: trimmedReason === '' ? null : trimmedReason,
        p_expires_at: endOfTodayIso(),
      })
      if (rpcError) throw rpcError
      const result = (data ?? null) as RpcTotalResult | null
      const newTotal = typeof result?.total_minutes === 'number' ? result.total_minutes : total + parsedMinutes
      const notified = typeof result?.devices_notified === 'number' ? result.devices_notified : deviceCount
      setActionMessage(
        `Đã thưởng ${formatDurationVi(parsedMinutes * 60)} cho ${childName}. Tổng phút thưởng đang hiệu lực: ${formatDurationVi(newTotal * 60)}, hiệu lực tới hết ngày hôm nay` +
          (notified > 0
            ? ` — lệnh sẽ tới ${notified} máy trong vòng ~15 giây khi máy online.`
            : ' — con chưa có máy nào nên chưa gửi lệnh tới máy nào.'),
      )
      setReason('')
      await load()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('safepc_grant_time_bank')) {
        setMissingMigration(true)
      } else {
        setActionError(toVietnameseError(err))
      }
    } finally {
      setGranting(false)
    }
  }

  const handleVoid = async (grant: TimeBankGrant) => {
    if (!supabase || !user) return
    setVoidingId(grant.id)
    setActionError(null)
    setActionMessage(null)
    try {
      const { data, error: rpcError } = await supabase.rpc('safepc_void_time_bank_grant', {
        p_grant_id: grant.id,
      })
      if (rpcError) throw rpcError
      const result = (data ?? null) as RpcTotalResult | null
      const newTotal = typeof result?.total_minutes === 'number' ? result.total_minutes : Math.max(0, total - grant.minutes)
      setActionMessage(
        `Đã thu hồi ${formatDurationVi(grant.minutes * 60)} đã thưởng. Tổng phút thưởng đang hiệu lực còn: ${formatDurationVi(newTotal * 60)}.`,
      )
      setConfirmVoidId(null)
      await load()
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setVoidingId(null)
    }
  }

  if (!configured) {
    return <NotConfiguredState />
  }

  if (missingMigration) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 sm:p-6" role="status">
        <h3 className="font-semibold text-amber-900">Ngân hàng giờ chưa sẵn sàng</h3>
        <p className="mt-1 text-sm text-amber-800">
          Tính năng này cần migration 13 (bảng sổ cái thưởng giờ + 2 hàm xử lý). Hãy áp dụng file{' '}
          <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs">
            20261118180000_time_bank.sql
          </code>{' '}
          trong thư mục backend/supabase/migrations/ qua Supabase SQL Editor, rồi tải lại trang.
        </p>
        <button type="button" onClick={() => void load()} className={`mt-4 ${secondaryButtonClassName}`}>
          Tải lại
        </button>
      </div>
    )
  }

  if (state === 'loading') {
    return <LoadingState label="Đang tải ngân hàng giờ…" />
  }

  if (state === 'error') {
    return <ErrorState message={error} onRetry={() => void load()} />
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <Card title={`Ngân hàng giờ của ${childName}`}>
        <p className="text-2xl font-bold text-slate-900">
          {total > 0 ? `Đang thưởng thêm ${formatDurationVi(total * 60)}` : 'Chưa có giờ thưởng nào đang hiệu lực'}
        </p>
        <p className="mt-1 text-sm text-slate-600">
          {total > 0 && latestExpiry
            ? `Số phút này được cộng vào giới hạn giờ hôm nay của con, hiệu lực tới ${formatTimeVi(latestExpiry)} (hết ngày).`
            : 'Thưởng thêm phút để cộng vào giới hạn giờ hôm nay của con. Phút thưởng không cộng dồn qua ngày — hết ngày là hết.'}
        </p>
        <p className="mt-2 text-sm text-slate-600">
          Con thấy giờ thưởng của mình trong mục “Xem thời gian còn lại” ở biểu tượng SafePC trên máy.
        </p>
      </Card>

      <Card title="Thưởng thêm giờ">
        <div className="space-y-4">
          <div>
            <span className="mb-1 block text-sm font-medium text-slate-700">Số phút thưởng</span>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Số phút thưởng">
              {TIME_BANK_QUICK_MINUTES.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => pickMinutes(value)}
                  aria-pressed={minutes === value && customMinutes === String(value)}
                  className={chipClassName(minutes === value && customMinutes === String(value))}
                >
                  {value} phút
                </button>
              ))}
            </div>
            <div className="mt-2 flex max-w-xs items-center gap-2">
              <input
                id="time-bank-minutes"
                type="number"
                inputMode="numeric"
                min={TIME_BANK_MIN_MINUTES}
                max={TIME_BANK_MAX_MINUTES}
                step={1}
                value={customMinutes}
                onChange={(e) => handleCustomMinutes(e.target.value)}
                className={inputClassName}
                aria-label="Số phút thưởng (tùy chọn)"
              />
              <span className="shrink-0 text-sm text-slate-600">phút (1–240)</span>
            </div>
          </div>

          <Field label="Lý do thưởng (không bắt buộc)" htmlFor="time-bank-reason">
            <input
              id="time-bank-reason"
              type="text"
              value={reason}
              maxLength={TIME_BANK_MAX_REASON_LENGTH}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ví dụ: Làm xong bài tập sớm, giúp mẹ dọn nhà…"
              className={inputClassName}
            />
          </Field>

          <p className="text-sm text-slate-600">
            Nhiều lần thưởng trong ngày sẽ cộng dồn với nhau. Lệnh sẽ gửi tới {deviceCount} máy của con
            {deviceCount === 0 ? ' — con chưa có máy nào được ghép nối' : ''}.
          </p>

          {actionMessage && (
            <p className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800" role="status">
              {actionMessage}
            </p>
          )}
          {actionError && (
            <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
              {actionError}
            </p>
          )}

          <button
            type="button"
            onClick={() => void handleGrant()}
            disabled={granting}
            className={primaryButtonClassName}
          >
            {granting ? 'Đang thưởng…' : 'Thưởng giờ cho con'}
          </button>
        </div>
      </Card>

      <Card title="Lịch sử thưởng giờ">
        {grants.length === 0 ? (
          <EmptyState
            title="Chưa có lần thưởng nào"
            description="Những lần phụ huynh thưởng giờ cho con sẽ hiện ở đây, kèm lý do và trạng thái hiệu lực."
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {grants.map((grant) => {
              const status = grantStatusLabel(grant, nowMs)
              const canVoid = isGrantActive(grant, nowMs)
              const confirming = confirmVoidId === grant.id
              return (
                <li key={grant.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900">+{formatDurationVi(grant.minutes * 60)}</p>
                      <p className="mt-0.5 text-sm text-slate-600">
                        {grant.reason ? `Lý do: ${grant.reason}` : 'Không có lý do'}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {grantedByLabel(grant.granted_by, user?.id ?? null)} ·{' '}
                        {formatDateTimeVi(grant.created_at)} · hết hạn {formatTimeVi(grant.expires_at)}
                      </p>
                    </div>
                    <span
                      className={
                        status === 'Đang hiệu lực'
                          ? 'shrink-0 rounded-full bg-green-100 px-2 py-1 text-xs font-medium text-green-800'
                          : status === 'Đã thu hồi'
                            ? 'shrink-0 rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600'
                            : 'shrink-0 rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800'
                      }
                    >
                      {status}
                    </span>
                  </div>
                  {canVoid && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {confirming ? (
                        <>
                          <button
                            type="button"
                            onClick={() => void handleVoid(grant)}
                            disabled={voidingId === grant.id}
                            className={dangerOutlineButtonClassName}
                          >
                            {voidingId === grant.id ? 'Đang thu hồi…' : 'Chắc chắn thu hồi'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmVoidId(null)}
                            disabled={voidingId === grant.id}
                            className={secondaryButtonClassName}
                          >
                            Hủy
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmVoidId(grant.id)}
                          className={secondaryButtonClassName}
                        >
                          Thu hồi lần thưởng này
                        </button>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {historyCapped && (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            Chỉ hiện {HISTORY_LIMIT} lần thưởng gần nhất. Các lần cũ hơn vẫn lưu trong database.
          </p>
        )}
      </Card>

      <p className="text-xs text-slate-500">
        Lưu ý: phút thưởng cộng vào mức trần giờ hôm nay của con, không phải mở khóa máy. Thưởng hoặc thu
        hồi sẽ thay thế ghi đè đang hiệu lực trên máy của con (kể cả lệnh mở khóa tạm thời), giống như form
        ghi đè ở trang Quy tắc. Chiều ngược lại cũng vậy: dùng form ghi đè ở trang Quy tắc sau khi thưởng
        thì máy sẽ thôi áp tổng ngân hàng cho tới lần thưởng hoặc thu hồi tiếp theo. Máy mới ghép nối sau
        khi thưởng sẽ nhận tổng số dư ở lần thưởng hoặc thu hồi tiếp theo.
      </p>
    </div>
  )
}
