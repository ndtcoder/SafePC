import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { formatDateTimeVi, toVietnameseError } from '../lib/format'
import {
  countUnread,
  isUnread,
  loadNotifications,
  markAllNotificationsRead,
  notificationKindLabel,
  notifyNotificationsRead,
  type NotificationItem,
  type NotificationKind,
} from '../lib/notifications'
import {
  AlertBox,
  EmptyState,
  ErrorState,
  LoadingState,
  MigrationMissingState,
  NotConfiguredState,
  PageHeader,
  primaryButtonClassName,
  secondaryButtonClassName,
  textLinkClassName,
} from '../components/ui'

type LoadState = 'loading' | 'ready' | 'error'

/** Số mục hiện mỗi đợt — nút "Xem thêm" tải đợt tiếp theo, không cắt lặng. */
const UI_PAGE_SIZE = 50

const KIND_CHIP_CLASS: Record<NotificationKind, string> = {
  request: 'bg-sky-100 text-sky-700',
  tamper: 'bg-red-100 text-red-700',
  device_offline: 'bg-amber-100 text-amber-800',
}

/**
 * Trang Thông báo (PRD §2.6/§2.8): những việc cần phụ huynh chú ý ngay —
 * yêu cầu còn chờ duyệt, cảnh báo can thiệp, máy offline quá 48 giờ —
 * mới nhất trước, trong 30 ngày gần nhất (máy đang offline quá 48 giờ
 * vẫn hiện dù đã offline lâu hơn). Song song với email thông
 * báo (cùng 3 nguồn sự kiện, cùng định nghĩa); không có push trong đợt
 * này. Mở trang không tự đánh dấu đã đọc — phụ huynh bấm nút mới xóa
 * huy hiệu, để không bỏ sót việc khi chỉ lướt qua.
 */
export default function NotificationsPage() {
  const { configured, user } = useAuth()

  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [loadError, setLoadError] = useState('')
  const [items, setItems] = useState<NotificationItem[]>([])
  const [watermarkMs, setWatermarkMs] = useState<number | null>(null)
  const [dataTruncated, setDataTruncated] = useState(false)
  const [missingMigration, setMissingMigration] = useState(false)
  const [visibleCount, setVisibleCount] = useState(UI_PAGE_SIZE)
  const [marking, setMarking] = useState(false)
  const [markError, setMarkError] = useState('')
  // Số thứ tự lần tải: tải lại liên tục thì phản hồi cũ về sau phải bị
  // bỏ qua, không ghi đè dữ liệu mới nhất.
  const loadSeqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current
    if (!supabase || !user) {
      setLoadState('ready')
      return
    }
    setLoadState('loading')
    setLoadError('')
    setMissingMigration(false)
    try {
      const result = await loadNotifications(supabase, user.id)
      if (seq !== loadSeqRef.current) return
      if (result.missingMigration) {
        setMissingMigration(true)
        setItems([])
        setWatermarkMs(null)
      } else {
        setItems(result.items)
        setWatermarkMs(result.watermarkMs)
      }
      setDataTruncated(result.truncated)
      setLoadState('ready')
    } catch (err) {
      if (seq !== loadSeqRef.current) return
      setLoadError(toVietnameseError(err))
      setLoadState('error')
    }
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  const unreadCount = useMemo(() => countUnread(items, watermarkMs), [items, watermarkMs])
  const visibleItems = useMemo(() => items.slice(0, visibleCount), [items, visibleCount])
  const remainingCount = items.length - visibleItems.length

  const handleMarkAllRead = async () => {
    if (!supabase || !user || marking) return
    setMarking(true)
    setMarkError('')
    try {
      const nowIso = new Date().toISOString()
      const result = await markAllNotificationsRead(supabase, user.id, nowIso)
      if (result.missingMigration) {
        setMissingMigration(true)
        return
      }
      // Cập nhật mốc ngay tại chỗ (không cần tải lại): mọi mục hiện tại
      // đều cũ hơn hoặc bằng mốc mới nên hết chưa đọc ngay lập tức.
      setWatermarkMs(new Date(nowIso).getTime())
      notifyNotificationsRead()
    } catch (err) {
      setMarkError(toVietnameseError(err))
    } finally {
      setMarking(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="Thông báo"
        description="Yêu cầu còn chờ duyệt, cảnh báo can thiệp và máy đang offline quá 48 giờ — mới nhất trước. Yêu cầu và cảnh báo trong 30 ngày gần nhất; máy đang offline vẫn hiện dù đã offline lâu hơn."
        actions={
          configured && !missingMigration && loadState === 'ready' ? (
            <button
              type="button"
              className={primaryButtonClassName}
              onClick={() => void handleMarkAllRead()}
              disabled={marking || unreadCount === 0}
            >
              {marking ? 'Đang đánh dấu…' : 'Đánh dấu tất cả đã đọc'}
            </button>
          ) : undefined
        }
      />

      {!configured && <NotConfiguredState />}

      {configured && missingMigration && (
        <MigrationMissingState
          title="Chưa áp dụng migration 20"
          detail="migration 20 (bảng mốc đã đọc thông báo)"
          file="20261119010000_notification_reads.sql"
          onRetry={() => void load()}
        />
      )}

      {configured && !missingMigration && loadState === 'loading' && (
        <LoadingState label="Đang tải thông báo…" />
      )}

      {configured && !missingMigration && loadState === 'error' && (
        <ErrorState message={loadError} onRetry={() => void load()} />
      )}

      {configured && !missingMigration && loadState === 'ready' && (
        <div className="flex flex-col gap-4">
          {markError && <AlertBox tone="error">{markError}</AlertBox>}

          {dataTruncated && (
            <AlertBox tone="warning">
              Có thể còn sự kiện cũ hơn chưa tải hết (đã chạm giới hạn đọc). Những việc mới nhất vẫn hiện
              đầy đủ phía trên.
            </AlertBox>
          )}

          <p className="text-sm text-slate-600" role="status">
            {items.length === 0
              ? 'Không có việc nào cần chú ý trong 30 ngày qua.'
              : unreadCount > 0
                ? `${unreadCount} chưa đọc trong ${items.length} thông báo.`
                : `Tất cả ${items.length} thông báo đều đã đọc.`}
          </p>

          {items.length === 0 && (
            <EmptyState
              title="Không có thông báo nào"
              description="Khi con gửi yêu cầu mới, khi phát hiện can thiệp, hoặc khi một máy offline quá 48 giờ, thông báo sẽ hiện tại đây và chuông ở đầu trang sẽ có huy hiệu đỏ."
            />
          )}

          {visibleItems.length > 0 && (
            <ol className="flex flex-col gap-2">
              {visibleItems.map((item) => {
                const unread = isUnread(item, watermarkMs)
                return (
                  <li
                    key={item.id}
                    className={`flex gap-3 rounded-xl border bg-white p-3 sm:p-4 ${
                      unread ? 'border-indigo-200' : 'border-slate-200'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${KIND_CHIP_CLASS[item.kind]}`}
                        >
                          {notificationKindLabel(item.kind)}
                        </span>
                        {unread && (
                          <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                            Chưa đọc
                          </span>
                        )}
                      </div>
                      {item.detail && (
                        <p className="mt-0.5 break-words text-sm text-slate-600">{item.detail}</p>
                      )}
                      <p className="mt-0.5 text-xs text-slate-500">
                        {[item.childName, item.deviceName].filter(Boolean).join(' · ')}
                        {item.childName || item.deviceName ? ' · ' : ''}
                        {formatDateTimeVi(item.at)}
                      </p>
                    </div>
                    <Link to={item.link} className={`${textLinkClassName} shrink-0 self-center`}>
                      {item.linkLabel}
                    </Link>
                  </li>
                )
              })}
            </ol>
          )}

          {remainingCount > 0 && (
            <button
              type="button"
              className={`${secondaryButtonClassName} self-center`}
              onClick={() => setVisibleCount((count) => count + UI_PAGE_SIZE)}
            >
              Xem thêm {remainingCount} thông báo
            </button>
          )}

          <p className="text-xs leading-relaxed text-slate-500">
            Thông báo trong Dashboard hiện cùng các sự kiện với email thông báo (yêu cầu chờ duyệt, can
            thiệp, máy offline). Yêu cầu đã duyệt hoặc từ chối sẽ biến mất khỏi danh sách này. Đẩy thông
            báo (push) lên điện thoại sẽ có sau, cùng app Android.
          </p>
        </div>
      )}
    </div>
  )
}
