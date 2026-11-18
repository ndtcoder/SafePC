import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { isSupabaseConfigured, supabase } from '../lib/supabase'
import { needsMfaStep, type AalLevel } from '../lib/mfa'

export interface AalState {
  currentLevel: AalLevel | string | null
  nextLevel: AalLevel | string | null
}

interface AuthContextValue {
  /** true khi đã cấu hình VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. */
  configured: boolean
  user: User | null
  session: Session | null
  loading: boolean
  /** Mức đảm bảo xác thực của phiên hiện tại (null khi chưa đăng nhập). */
  aal: AalState | null
  /** true khi phiên đã đăng nhập nhưng còn thiếu bước nhập mã MFA. */
  mfaRequired: boolean
  /** Tính lại AAL từ phiên hiện tại (sau khi xác minh/gỡ factor). */
  refreshAal: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>({
  configured: isSupabaseConfigured,
  user: null,
  session: null,
  loading: false,
  aal: null,
  mfaRequired: false,
  refreshAal: async () => {},
  signOut: async () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [aal, setAal] = useState<AalState | null>(null)
  const [loading, setLoading] = useState<boolean>(isSupabaseConfigured)
  // Số thứ tự lần tính AAL gần nhất: tránh một lần tính cũ (chậm) ghi đè
  // kết quả của lần tính mới hơn khi phiên đổi nhanh liên tiếp.
  const aalSeqRef = useRef(0)

  // getAuthenticatorAssuranceLevel() không tham số đọc JWT + danh sách
  // factor ngay trong phiên cục bộ nên nhanh và không dùng mạng; khi lỗi
  // thì giữ nguyên giá trị AAL hiện tại. Sau mỗi lần đổi phiên, giá trị
  // hiện tại đã bị đặt lại về null (xem listener bên dưới) nên một lỗi
  // tính AAL không bao giờ để lại AAL của phiên cũ — mfaRequired coi
  // AAL chưa biết là cần MFA (fail-closed).
  const computeAal = useCallback(async (currentSession: Session | null): Promise<void> => {
    const seq = ++aalSeqRef.current
    if (!supabase || !currentSession) {
      if (seq === aalSeqRef.current) setAal(null)
      return
    }
    try {
      const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (error) throw error
      if (seq !== aalSeqRef.current) return
      setAal({ currentLevel: data.currentLevel, nextLevel: data.nextLevel })
    } catch (err) {
      console.warn('Không tính được mức xác thực MFA, giữ nguyên trạng thái cũ:', err)
    }
  }, [])

  const refreshAal = useCallback(async () => {
    if (!supabase) return
    const {
      data: { session: currentSession },
    } = await supabase.auth.getSession()
    await computeAal(currentSession)
  }, [computeAal])

  useEffect(() => {
    if (!supabase) {
      // Chưa cấu hình Supabase: không có phiên đăng nhập, app vẫn chạy
      // để hiển thị hướng dẫn cấu hình (không gọi API giả).
      setLoading(false)
      return
    }
    let cancelled = false
    supabase.auth
      .getSession()
      .then(async ({ data }) => {
        if (cancelled) return
        setSession(data.session)
        // Tính AAL xong mới hết loading: tránh RequireAuth cho phiên
        // aal1 vào trang trong trước khi biết tài khoản cần bước MFA.
        await computeAal(data.session)
      })
      .catch(() => {
        if (!cancelled) setSession(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    const { data: listener } = supabase.auth.onAuthStateChange((event, next) => {
      if (cancelled) return
      // Đặt lại AAL ĐỒNG BỘ khi phiên đổi: không render nào được dùng
      // AAL của phiên cũ (hoặc null sau đăng xuất) cho phiên mới trong
      // lúc chờ tính AAL bất đồng bộ xong. Không đặt lại ở
      // TOKEN_REFRESHED — làm mới token giữ nguyên AAL, đặt lại sẽ làm
      // người dùng đang ở trong bị đẩy về trang đăng nhập mỗi lần
      // refresh token. Cùng lý do, mfaRequired bên dưới coi AAL chưa
      // biết là cần MFA.
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'PASSWORD_RECOVERY') {
        setAal(null)
      }
      setSession(next)
      void computeAal(next)
    })
    return () => {
      cancelled = true
      listener.subscription.unsubscribe()
    }
  }, [computeAal])

  const signOut = async () => {
    if (!supabase) return
    await supabase.auth.signOut()
    setSession(null)
    setAal(null)
  }

  // Fail-closed: AAL chưa biết (null) thì coi như cần MFA, để không
  // render nào cho phiên aal1 lọt vào Dashboard trong lúc chờ tính AAL.
  const mfaRequired =
    session !== null && (aal === null || needsMfaStep(aal.currentLevel, aal.nextLevel))

  return (
    <AuthContext.Provider
      value={{
        configured: isSupabaseConfigured,
        user: session?.user ?? null,
        session,
        loading,
        aal,
        mfaRequired,
        refreshAal,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext)
}
