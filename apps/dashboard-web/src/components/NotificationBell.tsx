import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import {
  countUnread,
  formatBadgeCount,
  loadNotifications,
  NOTIFICATIONS_READ_EVENT,
} from '../lib/notifications'

/**
 * Chuông thông báo ở header (không phải tab thứ 6 ở thanh dưới): bấm để
 * mở trang Thông báo. Huy hiệu đỏ đếm số chưa đọc, quá 99 thì "99+".
 * Tải lại khi đổi route và khi trang Thông báo báo đã đánh dấu đã đọc;
 * không polling, không Realtime (dự án không dùng ở đâu cả). Lỗi tải
 * (kể cả migration 20 chưa áp) thì chỉ ẩn huy hiệu — header không bao
 * giờ vỡ vì chuông.
 */
export default function NotificationBell() {
  const { configured, user } = useAuth()
  const { pathname } = useLocation()
  const [unreadCount, setUnreadCount] = useState<number | null>(null)
  const loadSeqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current
    if (!supabase || !configured || !user) {
      setUnreadCount(null)
      return
    }
    try {
      const result = await loadNotifications(supabase, user.id)
      if (seq !== loadSeqRef.current) return
      // Thiếu migration 20 thì ẩn huy hiệu (không đếm trên dữ liệu nửa vời).
      setUnreadCount(result.missingMigration ? null : countUnread(result.items, result.watermarkMs))
    } catch {
      if (seq !== loadSeqRef.current) return
      setUnreadCount(null)
    }
  }, [configured, user])

  useEffect(() => {
    void load()
  }, [load, pathname])

  useEffect(() => {
    const handleRead = () => void load()
    window.addEventListener(NOTIFICATIONS_READ_EVENT, handleRead)
    return () => window.removeEventListener(NOTIFICATIONS_READ_EVENT, handleRead)
  }, [load])

  return (
    <Link
      to="/thong-bao"
      aria-label={
        unreadCount !== null && unreadCount > 0
          ? `Thông báo, ${unreadCount} chưa đọc`
          : 'Thông báo'
      }
      className="relative flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
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
      </svg>
      {unreadCount !== null && unreadCount > 0 && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 flex min-h-[20px] min-w-[20px] items-center justify-center rounded-full bg-red-600 px-1 text-[11px] font-bold leading-none text-white"
        >
          {formatBadgeCount(unreadCount)}
        </span>
      )}
    </Link>
  )
}
