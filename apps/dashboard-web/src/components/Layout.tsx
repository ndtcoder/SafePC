import type { ReactNode } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

const NAV_ITEMS = [
  { to: '/hom-nay', label: 'Hôm nay' },
  { to: '/ho-so', label: 'Hồ sơ' },
  { to: '/yeu-cau', label: 'Yêu cầu' },
]

function navLinkClassName({ isActive }: { isActive: boolean }): string {
  return isActive
    ? 'block rounded-lg bg-indigo-600 px-3 py-2.5 text-sm font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2'
    : 'block rounded-lg px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2'
}

/** Icon vẽ tay (không thêm dependency) cho thanh tab dưới cùng trên điện thoại. */
function TabIcon({ to }: { to: string }) {
  const paths: Record<string, ReactNode> = {
    '/hom-nay': (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M8 3v4M16 3v4M3 10h18" />
      </>
    ),
    '/ho-so': (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5" />
      </>
    ),
    '/thiet-bi': (
      <>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M9 20h6M12 16v4" />
      </>
    ),
    '/quy-tac': (
      <>
        <path d="M12 3l7 3v5c0 4.6-3.1 7.7-7 9-3.9-1.3-7-4.4-7-9V6l7-3z" />
        <path d="M9 12l2 2 4-4" />
      </>
    ),
    '/yeu-cau': (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M3 7l9 6 9-6" />
      </>
    ),
  }
  return (
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
      {paths[to]}
    </svg>
  )
}

function tabLinkClassName({ isActive }: { isActive: boolean }): string {
  return isActive
    ? 'flex min-h-[56px] flex-col items-center justify-center gap-0.5 px-1 py-2 text-xs font-semibold text-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500'
    : 'flex min-h-[56px] flex-col items-center justify-center gap-0.5 px-1 py-2 text-xs font-medium text-slate-500 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500'
}

export default function Layout() {
  const { configured, user, signOut } = useAuth()
  const navigate = useNavigate()

  const handleSignOut = async () => {
    await signOut()
    navigate('/dang-nhap')
  }

  return (
    <div className="min-h-screen">
      {/* Topbar */}
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-2 sm:px-6">
          <Link
            to="/hom-nay"
            className="flex min-h-[44px] items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
          >
            <img src="/icons/icon.svg" alt="" className="h-8 w-8" aria-hidden="true" />
            <span className="text-lg font-bold tracking-tight text-slate-900">SafePC</span>
            <span className="hidden rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 sm:inline">
              Dashboard phụ huynh
            </span>
          </Link>
          <div className="flex items-center gap-3">
            {user ? (
              <>
                <span className="hidden max-w-56 truncate text-sm text-slate-600 sm:inline" title={user.email ?? ''}>
                  {user.email}
                </span>
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="inline-flex min-h-[44px] items-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 motion-reduce:transition-none"
                >
                  Đăng xuất
                </button>
              </>
            ) : (
              <Link
                to="/dang-nhap"
                className="inline-flex min-h-[44px] items-center rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 motion-reduce:transition-none"
              >
                Đăng nhập
              </Link>
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-4 sm:px-6 sm:py-6 lg:flex-row lg:items-start">
        {/* Sidebar — chỉ hiện từ màn hình lớn; trên điện thoại dùng thanh tab dưới cùng. */}
        <nav aria-label="Điều hướng chính" className="hidden shrink-0 lg:sticky lg:top-20 lg:block lg:w-52">
          <ul className="flex flex-col gap-1">
            {NAV_ITEMS.map((item) => (
              <li key={item.to} className="shrink-0">
                <NavLink to={item.to} className={navLinkClassName}>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
          {!configured && (
            <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
              Chưa cấu hình Supabase. Các trang sẽ hiển thị hướng dẫn kết nối thay vì dữ liệu thật.
            </p>
          )}
        </nav>

        {/* Nội dung trang */}
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>

      <footer className="mx-auto max-w-6xl px-4 pb-28 sm:px-6 lg:pb-8">
        <p className="text-xs text-slate-500">
          SafePC — công cụ của phụ huynh cho máy tính trong gia đình mình. Chỉ thu thập tên ứng dụng, thời
          lượng và tên miền web; không ghi phím, không đọc nội dung chat/file.
        </p>
      </footer>

      {/* Thanh tab dưới cùng — chỉ trên điện thoại/máy tính bảng nhỏ. */}
      <nav
        aria-label="Điều hướng chính"
        className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        <ul className="grid grid-cols-3">
          {NAV_ITEMS.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} className={tabLinkClassName}>
                {({ isActive }) => (
                  <>
                    <TabIcon to={item.to} />
                    <span>{item.label}</span>
                    <span
                      aria-hidden="true"
                      className={`h-1 w-6 rounded-full ${isActive ? 'bg-indigo-600' : 'bg-transparent'}`}
                    />
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  )
}
