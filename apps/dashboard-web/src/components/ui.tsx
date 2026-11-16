import type { ReactNode } from 'react'

export function Spinner({ label = 'Đang tải…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-slate-600" role="status" aria-live="polite">
      <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
      <span>{label}</span>
    </div>
  )
}

export function LoadingState({ label }: { label?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6">
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
    <div className="rounded-xl border border-red-200 bg-red-50 p-6" role="alert">
      <h3 className="font-semibold text-red-800">{title}</h3>
      <p className="mt-1 text-sm text-red-700">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
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
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
      <h3 className="text-base font-semibold text-slate-800">{title}</h3>
      <p className="mx-auto mt-1 max-w-xl text-sm text-slate-600">{description}</p>
      {children && <div className="mt-4">{children}</div>}
    </div>
  )
}

/** Trạng thái hiển thị trên mọi trang khi chưa cấu hình Supabase. */
export function NotConfiguredState() {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-6" role="status">
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
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
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
    <section className={`rounded-xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}>
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

export const inputClassName =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400'

export const primaryButtonClassName =
  'rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50'

export const secondaryButtonClassName =
  'rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50'
