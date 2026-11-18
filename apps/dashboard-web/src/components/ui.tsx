import { useEffect, useState, type ReactNode } from 'react'
import type { DeviceStatus, EnforcementDecision } from '../lib/types'

export function Spinner({ label = 'Đang tải…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-slate-600" role="status" aria-live="polite">
      <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600 motion-reduce:animate-none" />
      <span>{label}</span>
    </div>
  )
}

export function LoadingState({ label }: { label?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
      <Spinner label={label} />
    </div>
  )
}

export function ErrorState({
  title = 'Không tải được dữ liệu',
  message,
  onRetry,
}: {
  title?: string
  message: string
  onRetry?: () => void
}) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-4 sm:p-6" role="alert">
      <h3 className="font-semibold text-red-800">{title}</h3>
      <p className="mt-1 text-sm text-red-700">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className={`mt-4 ${dangerButtonClassName}`}
        >
          Thử lại
        </button>
      )}
    </div>
  )
}

export function EmptyState({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children?: ReactNode
}) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center sm:p-8">
      <h3 className="text-base font-semibold text-slate-800">{title}</h3>
      <p className="mx-auto mt-1 max-w-xl text-sm text-slate-600">{description}</p>
      {children && <div className="mt-4">{children}</div>}
    </div>
  )
}

/** Trạng thái hiển thị trên mọi trang khi chưa cấu hình Supabase. */
export function NotConfiguredState() {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 sm:p-6" role="status">
      <h3 className="font-semibold text-amber-900">Chưa cấu hình Supabase</h3>
      <p className="mt-1 text-sm text-amber-800">
        Dashboard chưa kết nối được tới Supabase nên chưa hiển thị dữ liệu thật.
        Đây là trạng thái bình thường khi chưa tạo project Supabase — app không dùng dữ liệu giả.
      </p>
      <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-amber-800">
        <li>Tạo project tại Supabase Dashboard và chạy migration trong thư mục backend/supabase/migrations/.</li>
        <li>
          Copy file <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs">.env.example</code> thành{' '}
          <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs">.env</code> trong thư mục{' '}
          <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs">apps/dashboard-web/</code>.
        </li>
        <li>
          Điền <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs">VITE_SUPABASE_URL</code> và{' '}
          <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs">VITE_SUPABASE_ANON_KEY</code> (Project
          Settings &gt; API trong Supabase Dashboard, chỉ dùng anon key).
        </li>
        <li>Khởi động lại dev server / build lại và đăng nhập bằng tài khoản phụ huynh.</li>
      </ol>
      <p className="mt-3 text-sm text-amber-800">
        Không commit file <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs">.env</code> lên Git.
      </p>
    </div>
  )
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3 sm:mb-6 sm:gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-600">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

export function Card({
  title,
  children,
  className = '',
}: {
  title?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 ${className}`}>
      {title && <h2 className="mb-3 text-base font-semibold text-slate-900">{title}</h2>}
      {children}
    </section>
  )
}

export function Field({
  label,
  htmlFor,
  children,
  hint,
}: {
  label: string
  htmlFor: string
  children: ReactNode
  hint?: string
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  )
}

// Ô nhập liệu: cao tối thiểu 44px để dễ chạm trên điện thoại; chữ 16px trên
// màn hình hẹp để iOS không tự phóng to khi focus, thu lại text-sm từ sm.
export const inputClassName =
  'min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-base text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 sm:text-sm'

// Nút bấm: cao tối thiểu 44px, vòng focus-visible rõ cho bàn phím, chuyển
// màu tôn trọng prefers-reduced-motion.
const buttonBaseClassName =
  'inline-flex min-h-[44px] items-center justify-center rounded-lg px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'

export const primaryButtonClassName =
  `${buttonBaseClassName} bg-indigo-600 text-white hover:bg-indigo-700 focus-visible:ring-indigo-500`

export const secondaryButtonClassName =
  `${buttonBaseClassName} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 focus-visible:ring-indigo-500`

export const dangerButtonClassName =
  `${buttonBaseClassName} bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500`

export const dangerOutlineButtonClassName =
  `${buttonBaseClassName} border border-red-200 bg-white text-red-700 hover:bg-red-50 focus-visible:ring-red-500`

export const successButtonClassName =
  `${buttonBaseClassName} bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:ring-emerald-500`

/** Chip chọn nhanh (VD: chọn số phút ghi đè): trạng thái chọn rõ bằng màu nền. */
export function chipClassName(active: boolean): string {
  return active
    ? 'inline-flex min-h-[44px] items-center justify-center rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 motion-reduce:transition-none'
    : 'inline-flex min-h-[44px] items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 motion-reduce:transition-none'
}

// Hộp thông báo một đoạn ngắn (thông báo sau thao tác, cảnh báo nội dung,
// trạng thái ghép nối…): MỘT hình dạng duy nhất cho cả Dashboard, tránh mỗi
// trang một biến thể màu/padding. Lỗi dùng role="alert", còn lại role="status".
const ALERT_BOX_TONE = {
  error: { className: 'border-red-200 bg-red-50 text-red-700', role: 'alert' as const },
  success: { className: 'border-emerald-200 bg-emerald-50 text-emerald-800', role: 'status' as const },
  warning: { className: 'border-amber-200 bg-amber-50 text-amber-800', role: 'status' as const },
}

export function AlertBox({
  tone,
  children,
  className = '',
}: {
  tone: keyof typeof ALERT_BOX_TONE
  children: ReactNode
  className?: string
}) {
  const { className: toneClassName, role } = ALERT_BOX_TONE[tone]
  return (
    <div className={`rounded-lg border p-3 text-sm ${toneClassName} ${className}`} role={role}>
      {children}
    </div>
  )
}

/**
 * Trạng thái khi tính năng cần migration chưa áp dụng: cùng một hình dạng
 * (hộp vàng lớn + tên file migration, nút tải lại tùy chọn) cho mọi tính năng.
 * `detail` là mô tả ngắn phần migration cần có, VD "migration 13 (bảng sổ
 * cái thưởng giờ + 2 hàm xử lý)".
 */
export function MigrationMissingState({
  title,
  detail,
  file,
  onRetry,
}: {
  title: string
  detail: string
  file: string
  onRetry?: () => void
}) {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 sm:p-6" role="status">
      <h3 className="font-semibold text-amber-900">{title}</h3>
      <p className="mt-1 text-sm text-amber-800">
        Tính năng này cần {detail}. Hãy áp dụng file{' '}
        <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs">{file}</code> trong thư mục
        backend/supabase/migrations/ qua Supabase SQL Editor, rồi tải lại trang.
      </p>
      {onRetry && (
        <button type="button" onClick={onRetry} className={`mt-4 ${secondaryButtonClassName}`}>
          Tải lại
        </button>
      )}
    </div>
  )
}

/**
 * Khung giữa màn hình cho các trang ngoài RequireAuth (đăng nhập, chấp
 * nhận lời mời): logo + tên app + thẻ trắng. Mọi trang auth dùng chung
 * một khung để không lệch nhau.
 */
export function AuthShell({
  subtitle,
  children,
  footer,
}: {
  subtitle: string
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-6 flex flex-col items-center gap-2 text-center">
        <img src="/icons/icon.svg" alt="Logo SafePC" className="h-14 w-14" />
        <p className="text-xl font-bold tracking-tight text-slate-900">SafePC</p>
        <p className="text-sm text-slate-600">{subtitle}</p>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">{children}</div>
      {footer}
    </div>
  )
}

// Nút viền vàng trong hộp cảnh báo (VD: "Huỷ ghi đè này" trong hộp ghi đè
// đang hiệu lực): cùng khung nút chuẩn, chỉ khác màu.
export const warningButtonClassName =
  `${buttonBaseClassName} border border-amber-300 bg-white text-amber-800 hover:bg-amber-100 focus-visible:ring-amber-500`

// Link/bút bấm dạng chữ trong dòng (VD: chuyển chế độ đăng nhập, đổi tài
// khoản): vẫn cao tối thiểu 44px để dễ chạm, chỉ không có viền/nền.
export const textLinkClassName =
  'inline-flex min-h-[44px] items-center rounded-lg px-2 font-medium text-indigo-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2'

// Ô checkbox: 20px, viền slate, dấu chọn indigo — một hình dạng duy nhất.
export const checkboxClassName = 'h-5 w-5 shrink-0 rounded border-slate-300 accent-indigo-600'

// Huy hiệu trạng thái: phần nền cố định, phần màu theo bảng tông bên dưới.
export const badgeBaseClassName = 'shrink-0 rounded-full px-2.5 py-1 text-xs font-medium'

/** Tông huy hiệu trạng thái máy — dùng chung cho trang Hôm nay và Thiết bị. */
export const DEVICE_STATUS_BADGE_TONE: Record<DeviceStatus, string> = {
  online: 'bg-emerald-100 text-emerald-800',
  offline: 'bg-slate-200 text-slate-700',
  locked: 'bg-red-100 text-red-800',
}

/** Tông huy hiệu quyết định thi hành — dùng chung cho trang Hôm nay và Thiết bị. */
export const ENFORCEMENT_BADGE_TONE: Record<EnforcementDecision, string> = {
  allow: 'bg-emerald-100 text-emerald-800',
  warn: 'bg-amber-100 text-amber-800',
  lock: 'bg-red-100 text-red-800',
}

/**
 * Biểu ngữ khi trình duyệt của phụ huynh mất mạng: chỉ hiển thị, không
 * thay đổi luồng nào. Khi có mạng trở lại thì tự ẩn.
 */
export function OfflineBanner() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])
  if (online) return null
  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-800" role="status">
      Bạn đang mất kết nối mạng. Dashboard sẽ không tải được dữ liệu mới cho tới khi có mạng trở lại.
    </div>
  )
}
