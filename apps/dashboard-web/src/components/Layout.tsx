import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

const NAV_ITEMS = [
  { to: '/hom-nay', label: 'Hôm nay' },
  { to: '/thiet-bi', label: 'Thiết bị' },
  { to: '/quy-tac', label: 'Quy tắc' },
  { to: '/yeu-cau', label: 'Yêu cầu' },
]

function navLinkClassName({ isActive }: { isActive: boolean }): string {
  return isActive
    ? 'block rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white'
    : 'block rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100'
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
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link to="/hom-nay" className="flex items-center gap-2">
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
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Đăng xuất
                </button>
              </>
            ) : (
              <Link
                to="/dang-nhap"
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
              >
                Đăng nhập
              </Link>
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:flex-row lg:items-start">
        {/* Sidebar (desktop) / điều hướng ngang (mobile) */}
        <nav aria-label="Điều hướng chính" className="shrink-0 lg:sticky lg:top-20 lg:w-52">
          <ul className="flex gap-1 overflow-x-auto lg:flex-col">
            {NAV_ITEMS.map((item) => (
              <li key={item.to} className="shrink-0">
                <NavLink to={item.to} className={navLinkClassName}>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
          {!configured && (
            <p className="mt-4 hidden rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 lg:block">
              Chưa cấu hình Supabase. Các trang sẽ hiển thị hướng dẫn kết nối thay vì dữ liệu thật.
            </p>
          )}
        </nav>

        {/* Nội dung trang */}
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>

      <footer className="mx-auto max-w-6xl px-4 pb-8 sm:px-6">
        <p className="text-xs text-slate-500">
          SafePC — công cụ của phụ huynh cho máy tính trong gia đình mình. Chỉ thu thập tên ứng dụng, thời
          lượng và tên miền web; không ghi phím, không đọc nội dung chat/file.
        </p>
      </footer>
    </div>
  )
}
