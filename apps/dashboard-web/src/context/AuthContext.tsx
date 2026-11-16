import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { isSupabaseConfigured, supabase } from '../lib/supabase'

interface AuthContextValue {
  /** true khi đã cấu hình VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. */
  configured: boolean
  user: User | null
  session: Session | null
  loading: boolean
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>({
  configured: isSupabaseConfigured,
  user: null,
  session: null,
  loading: false,
  signOut: async () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState<boolean>(isSupabaseConfigured)

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
      .then(({ data }) => {
        if (!cancelled) setSession(data.session)
      })
      .catch(() => {
        if (!cancelled) setSession(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!cancelled) setSession(next)
    })
    return () => {
      cancelled = true
      listener.subscription.unsubscribe()
    }
  }, [])

  const signOut = async () => {
    if (!supabase) return
    await supabase.auth.signOut()
    setSession(null)
  }

  return (
    <AuthContext.Provider
      value={{
        configured: isSupabaseConfigured,
        user: session?.user ?? null,
        session,
        loading,
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
