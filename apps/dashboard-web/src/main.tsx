import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './context/AuthContext'
import { registerPushServiceWorker } from './lib/pushNotifications'
import './index.css'

// Đăng ký Service Worker cho Web Push (migration 30): SW chỉ xử lý
// sự kiện push + bấm vào thông báo, không cache gì (xem
// public/sw.js). Đăng ký lỗi thì bỏ qua êm — Dashboard vẫn chạy
// bình thường, chỉ mất kênh push.
void registerPushServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
