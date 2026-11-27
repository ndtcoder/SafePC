import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { getMyFamily } from '../lib/family'
import {
  disablePush,
  enablePush,
  loadPushState,
  touchPushSubscription,
  type PushState,
} from '../lib/pushNotifications'

/**
 * Công tắc "Thông báo đẩy" ở header, cạnh chuông thông báo
 * (migration 30): bật thì trình duyệt này nhận Web Push khi con
 * nhắn tin hoặc gửi yêu cầu mới, kể cả khi Dashboard đang đóng —
 * đó là lý do tính năng này tồn tại (phụ huynh không mở web/app
 * vẫn không lỡ tin của con).
 *
 * Trạng thái suy từ trình duyệt (quyền Notification + subscription
 * hiện có), không lưu thêm ở client. Chưa cấu hình khóa VAPID hoặc
 * trình duyệt không hỗ trợ thì nút bị vô hiệu kèm ghi chú trong
 * title — không crash, không gọi API giả. Lỗi (kể cả migration 30
 * chưa áp) chỉ hiện trong thẻ nhỏ dưới nút, header không vỡ.
 */
export default function PushNotificationToggle() {
  const { configured, user } = useAuth()
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const familyIdRef = useRef<string | null>(null)

  const ensureFamilyId = useCallback(async (): Promise<string | null> => {
    if (familyIdRef.current) return familyIdRef.current
    if (!supabase || !user) return null
    try {
      const family = await getMyFamily(supabase, user.id)
      familyIdRef.current = family?.id ?? null
    } catch {
      familyIdRef.current = null
    }
    return familyIdRef.current
  }, [user])

  const refresh = useCallback(async () => {
    const next = await loadPushState()
    setState(next)
    // Đang bật thì làm mới last_seen_at để server biết đăng ký còn
    // sống (và tạo lại dòng nếu bị mất). Lỗi ở đây bỏ qua êm.
    if (next.subscribed && supabase && user) {
      const familyId = await ensureFamilyId()
      if (familyId) {
        try {
          await touchPushSubscription(supabase, user.id, familyId)
        } catch {
          // Không để lỗi refresh làm phiền giao diện.
        }
      }
    }
  }, [ensureFamilyId, user])

  useEffect(() => {
    if (!configured || !user || !supabase) return
    void refresh()
  }, [configured, user, refresh])

  if (!configured || !user || !supabase || !state) return null

  const disabledReason = !state.supported
    ? 'Trình duyệt này không hỗ trợ thông báo đẩy.'
    : !state.configured
      ? 'Thông báo đẩy chưa được cấu hình (thiếu VITE_VAPID_PUBLIC_KEY).'
      : state.permission === 'denied'
        ? 'Quyền thông báo đang bị chặn. Anh/chị cho phép thông báo cho trang này trong cài đặt trình duyệt.'
        : null

  const handleClick = async () => {
    if (busy) return
    const client = supabase
    if (!client) return
    if (disabledReason) {
      setNotice((prev) => (prev ? null : disabledReason))
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      if (state.subscribed) {
        await disablePush(client, user.id)
      } else {
        const familyId = await ensureFamilyId()
        if (!familyId) {
          throw new Error('Chưa xác định được gia đình của tài khoản này.')
        }
        await enablePush(client, user.id, familyId)
      }
      await refresh()
    } catch (err) {
      setNotice(
        err instanceof Error
          ? err.message
          : 'Không đổi được trạng thái thông báo đẩy. Anh/chị thử lại sau.',
      )
    } finally {
      setBusy(false)
    }
  }

  const label = state.subscribed ? 'Thông báo đẩy: đang bật' : 'Thông báo đẩy: đang tắt'

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={busy}
        aria-pressed={state.subscribed}
        aria-label={label}
        title={disabledReason ?? label}
        className={`relative flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 ${
          state.subscribed
            ? 'text-indigo-700 hover:bg-indigo-50'
            : 'text-slate-700 hover:bg-slate-100'
        } ${disabledReason ? 'cursor-not-allowed opacity-50' : ''}`}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-6 w-6"
          aria-hidden="true"
        >
          <path d="M18 9a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 15 18 9z" />
          <path d="M10 20a2.2 2.2 0 0 0 4 0" />
          {/* Sóng chuông chỉ hiện khi đang bật. */}
          {state.subscribed && <path d="M19.5 2.8a6.5 6.5 0 0 1 1.7 4.2M21.9 1a10 10 0 0 1 2.6 6.4" />}
        </svg>
        <span className="hidden sm:inline">Thông báo đẩy</span>
        {state.subscribed && (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-indigo-600"
          />
        )}
      </button>
      {notice && (
        <div
          role="status"
          className="absolute right-0 top-full z-30 mt-2 w-72 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 shadow-lg"
        >
          {notice}
        </div>
      )}
    </div>
  )
}
