import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import { useAuth } from './context/AuthContext'
import { Spinner } from './components/ui'
import LoginPage from './pages/LoginPage'
import AcceptInvitePage from './pages/AcceptInvitePage'
import TodayPage from './pages/TodayPage'
import DevicesPage from './pages/DevicesPage'
import RulesPage from './pages/RulesPage'
import RequestsPage from './pages/RequestsPage'
import NotificationsPage from './pages/NotificationsPage'
import ActivityLogPage from './pages/ActivityLogPage'
import ProfilesPage from './pages/ProfilesPage'
import ProfilePage from './pages/ProfilePage'

// Trang Báo cáo tuần kéo theo Recharts (nặng) nên tải lười: các trang
// khác không phải tải thêm ~280KB gzip chỉ để xem nhanh trạng thái.
const WeeklyReportPage = lazy(() => import('./pages/WeeklyReportPage'))

/**
 * Bảo vệ các trang bên trong:
 * - Khi đã cấu hình Supabase mà chưa đăng nhập -> chuyển tới trang đăng nhập.
 * - Khi phiên mới qua mật khẩu mà tài khoản đã bật MFA (còn thiếu bước
 *   nhập mã) -> cũng chuyển tới trang đăng nhập, nơi hiển thị bước MFA.
 * - Khi CHƯA cấu hình Supabase -> vẫn cho xem các trang để thấy hướng dẫn
 *   cấu hình (không có dữ liệu thật, không gọi API giả).
 */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { configured, user, loading, mfaRequired } = useAuth()
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="Đang kiểm tra phiên đăng nhập…" />
      </div>
    )
  }
  if (configured && (!user || mfaRequired)) {
    return <Navigate to="/dang-nhap" replace />
  }
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route path="/dang-nhap" element={<LoginPage />} />
      {/* Trang chấp nhận lời mời nằm ngoài RequireAuth: người được mời có
          thể chưa đăng nhập, thậm chí chưa có tài khoản. */}
      <Route path="/moi/:token" element={<AcceptInvitePage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Navigate to="/hom-nay" replace />} />
        <Route path="/hom-nay" element={<TodayPage />} />
        <Route path="/ho-so" element={<ProfilesPage />} />
        <Route path="/ho-so/:childId/:tab?" element={<ProfilePage />} />
        <Route path="/thiet-bi" element={<DevicesPage />} />
        <Route path="/quy-tac" element={<RulesPage />} />
        <Route path="/yeu-cau" element={<RequestsPage />} />
        <Route path="/thong-bao" element={<NotificationsPage />} />
        <Route path="/nhat-ky" element={<ActivityLogPage />} />
        <Route
          path="/bao-cao"
          element={
            <Suspense
              fallback={
                <div className="flex min-h-64 items-center justify-center">
                  <Spinner label="Đang tải trang báo cáo…" />
                </div>
              }
            >
              <WeeklyReportPage />
            </Suspense>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/hom-nay" replace />} />
    </Routes>
  )
}
