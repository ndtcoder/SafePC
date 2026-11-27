import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Thông báo đẩy (Web Push) cho phụ huynh — phía Dashboard
 * (migration 30, PRD §2.13, AMENDMENTS A-16).
 *
 * Luồng: phụ huynh bật công tắc "Thông báo đẩy" ở header → xin
 * quyền Notification → Service Worker (public/sw.js) tạo một
 * PushSubscription bằng khóa công khai VAPID → lưu endpoint + cặp
 * khóa của subscription vào bảng push_subscriptions (RLS: chỉ chủ
 * sở hữu ghi được dòng của mình). Edge Function
 * send-push-notifications quét sự kiện (tin chat của con, yêu cầu
 * mới) mỗi 5 phút và đẩy tới các subscription này.
 *
 * Khóa công khai VAPID đọc từ biến môi trường VITE_VAPID_PUBLIC_KEY
 * (đặt trên Vercel cùng giá trị với secret VAPID_PUBLIC_KEY của
 * Edge Function). THIẾU biến này thì tính năng tắt êm: công tắc bị
 * vô hiệu kèm ghi chú, không crash, không gọi API giả.
 */

const rawVapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined

/** Khóa công khai VAPID đã chuẩn hóa; null khi chưa cấu hình. */
export const VAPID_PUBLIC_KEY: string | null =
  rawVapidKey && rawVapidKey.trim() !== '' ? rawVapidKey.trim() : null

export function isPushConfigured(): boolean {
  return VAPID_PUBLIC_KEY !== null
}

/** Trình duyệt có hỗ trợ Web Push không (SW + PushManager + Notification). */
export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

/**
 * Đăng ký Service Worker /sw.js (chỉ xử lý push, không cache — xem
 * public/sw.js). Trả null khi trình duyệt không hỗ trợ hoặc đăng ký
 * lỗi: Dashboard vẫn chạy bình thường, chỉ mất kênh push.
 */
export async function registerPushServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return null
  }
  try {
    return await navigator.serviceWorker.register('/sw.js')
  } catch {
    return null
  }
}

/** Giải mã base64url (định dạng của khóa VAPID) thành bytes cho pushManager.subscribe. */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4)
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i)
  }
  return output
}

function arrayBufferToBase64Url(buffer: ArrayBuffer | null): string | null {
  if (!buffer) return null
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  const registration = await registerPushServiceWorker()
  if (registration) return registration
  return navigator.serviceWorker.ready
}

/** Subscription hiện tại của trình duyệt này (null khi chưa subscribe). */
export async function getBrowserPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null
  try {
    const registration = await navigator.serviceWorker.getRegistration('/sw.js')
    if (!registration) return null
    return await registration.pushManager.getSubscription()
  } catch {
    return null
  }
}

export type PushPermissionState = NotificationPermission | 'unsupported'

export interface PushState {
  supported: boolean
  configured: boolean
  permission: PushPermissionState
  /** Trình duyệt này đang có subscription hiệu lực hay không. */
  subscribed: boolean
}

export async function loadPushState(): Promise<PushState> {
  const supported = isPushSupported()
  if (!supported) {
    return { supported: false, configured: isPushConfigured(), permission: 'unsupported', subscribed: false }
  }
  const subscription = await getBrowserPushSubscription()
  return {
    supported: true,
    configured: isPushConfigured(),
    permission: Notification.permission,
    subscribed: subscription !== null,
  }
}

/** Ghi/refresh một subscription lên bảng push_subscriptions (upsert theo user_id + endpoint). */
async function upsertSubscriptionRow(
  client: SupabaseClient,
  userId: string,
  familyId: string,
  subscription: PushSubscription,
): Promise<void> {
  const json = subscription.toJSON()
  const keys = (json.keys ?? {}) as { p256dh?: string; auth?: string }
  const { error } = await client.from('push_subscriptions').upsert(
    {
      user_id: userId,
      family_id: familyId,
      platform: 'web',
      endpoint: subscription.endpoint,
      p256dh: keys.p256dh ?? null,
      auth: keys.auth ?? null,
      user_agent: navigator.userAgent,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,endpoint' },
  )
  if (error) throw error
}

/**
 * Bật thông báo đẩy cho trình duyệt này: xin quyền → subscribe →
 * lưu đăng ký. Ném Error với thông điệp tiếng Việt khi không bật
 * được (chưa cấu hình / quyền bị từ chối / trình duyệt không hỗ
 * trợ) để component hiển thị thẳng cho phụ huynh.
 */
export async function enablePush(
  client: SupabaseClient,
  userId: string,
  familyId: string,
): Promise<void> {
  if (!isPushSupported()) {
    throw new Error('Trình duyệt này không hỗ trợ thông báo đẩy.')
  }
  if (!VAPID_PUBLIC_KEY) {
    throw new Error('Thông báo đẩy chưa được cấu hình (thiếu VITE_VAPID_PUBLIC_KEY).')
  }
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error(
      'Quyền thông báo chưa được cấp. Anh/chị cho phép thông báo cho trang này trong cài đặt trình duyệt rồi bật lại.',
    )
  }
  const registration = await readyRegistration()
  let subscription = await registration.pushManager.getSubscription()
  if (subscription) {
    // Subscription cũ gắn với khóa VAPID khác (đã xoay khóa) thì
    // phải hủy để subscribe lại bằng khóa hiện tại.
    const existingKey = arrayBufferToBase64Url(subscription.options.applicationServerKey)
    if (existingKey !== null && existingKey !== VAPID_PUBLIC_KEY) {
      await subscription.unsubscribe()
      subscription = null
    }
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    })
  }
  await upsertSubscriptionRow(client, userId, familyId, subscription)
}

/**
 * Tắt thông báo đẩy cho trình duyệt này: xóa dòng đăng ký của
 * endpoint hiện tại rồi hủy subscription ở trình duyệt. Trình
 * duyệt không còn subscription (đã hủy từ trước) thì không xóa gì:
 * dòng của các trình duyệt khác thuộc về chính các trình duyệt đó.
 */
export async function disablePush(client: SupabaseClient, userId: string): Promise<void> {
  const subscription = await getBrowserPushSubscription()
  if (!subscription) return
  const { error } = await client
    .from('push_subscriptions')
    .delete()
    .eq('user_id', userId)
    .eq('endpoint', subscription.endpoint)
  if (error) throw error
  await subscription.unsubscribe()
}

/**
 * Làm mới last_seen_at cho subscription đang bật (gọi khi mở
 * Dashboard): server biết đăng ký còn sống, và nếu dòng bị mất
 * (vd bị dọn vì endpoint chết oan) thì upsert tạo lại.
 */
export async function touchPushSubscription(
  client: SupabaseClient,
  userId: string,
  familyId: string,
): Promise<void> {
  const subscription = await getBrowserPushSubscription()
  if (!subscription) return
  await upsertSubscriptionRow(client, userId, familyId, subscription)
}
