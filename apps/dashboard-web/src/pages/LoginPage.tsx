import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { isValidInviteNextPath } from '../lib/familyInvites'
import { toVietnameseError } from '../lib/format'
import { AlertBox, AuthShell, Field, inputClassName, primaryButtonClassName, textLinkClassName } from '../components/ui'

type Mode = 'login' | 'signup' | 'forgot'

const MODE_TITLES: Record<Mode, { title: string; description: string; submit: string }> = {
  login: {
    title: 'Đăng nhập',
    description: 'Đăng nhập bằng tài khoản phụ huynh để quản lý máy tính của con.',
    submit: 'Đăng nhập',
  },
  signup: {
    title: 'Tạo tài khoản phụ huynh',
    description: 'Tạo tài khoản mới bằng email và mật khẩu. Bạn sẽ cần xác minh email.',
    submit: 'Đăng ký',
  },
  forgot: {
    title: 'Quên mật khẩu',
    description: 'Nhập email đã đăng ký, chúng tôi sẽ gửi link đặt lại mật khẩu.',
    submit: 'Gửi link đặt lại mật khẩu',
  },
}

export default function LoginPage() {
  const { configured, user, loading } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  // Nơi quay lại sau khi đăng nhập: chỉ chấp nhận đường dẫn chấp nhận
  // lời mời cùng origin (?next=/moi/<token>); mọi giá trị khác đều về
  // trang tổng quan để ?next= không thành chuyển hướng mở.
  const nextParam = searchParams.get('next')
  const redirectTo = nextParam && isValidInviteNextPath(nextParam) ? nextParam : '/hom-nay'
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  if (!loading && user) {
    return <Navigate to={redirectTo} replace />
  }

  const switchMode = (next: Mode) => {
    setMode(next)
    setError(null)
    setNotice(null)
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!supabase) return
    setError(null)
    setNotice(null)
    setSubmitting(true)
    try {
      if (mode === 'login') {
        const { error: authError } = await supabase.auth.signInWithPassword({ email, password })
        if (authError) throw authError
        navigate(redirectTo, { replace: true })
      } else if (mode === 'signup') {
        const { error: authError } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/dang-nhap` },
        })
        if (authError) throw authError
        setNotice(
          'Đã tạo tài khoản. Vui lòng kiểm tra hộp thư email để xác minh tài khoản trước khi đăng nhập.',
        )
      } else {
        const { error: authError } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/dang-nhap`,
        })
        if (authError) throw authError
        setNotice('Đã gửi email đặt lại mật khẩu (nếu email này đã được đăng ký). Vui lòng kiểm tra hộp thư.')
      }
    } catch (err) {
      setError(toVietnameseError(err))
    } finally {
      setSubmitting(false)
    }
  }

  const copy = MODE_TITLES[mode]
  const formDisabled = !configured || submitting

  return (
    <AuthShell
      subtitle="Dashboard phụ huynh — quản lý máy tính của con"
      footer={
        <p className="mt-6 text-center text-xs text-slate-500">
          <Link to="/hom-nay" className="inline-flex min-h-[44px] items-center rounded-lg px-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2">
            Xem trang tổng quan (chỉ hiển thị hướng dẫn khi chưa cấu hình)
          </Link>
        </p>
      }
    >
        <h1 className="text-lg font-semibold text-slate-900">{copy.title}</h1>
        <p className="mt-1 text-sm text-slate-600">{copy.description}</p>

        {!configured && (
          <AlertBox tone="warning" className="mt-4">
            <p className="text-sm font-medium text-amber-900">Chưa cấu hình Supabase</p>
            <p className="mt-1 text-sm text-amber-800">
              Form đăng nhập đang bị vô hiệu hoá vì chưa có project Supabase. Hãy copy file{' '}
              <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs">.env.example</code> thành{' '}
              <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs">.env</code>, điền Project URL và
              anon key từ Supabase Dashboard, rồi khởi động lại ứng dụng. App không đăng nhập giả khi chưa có
              backend thật.
            </p>
          </AlertBox>
        )}

        {error && (
          <AlertBox tone="error" className="mt-4">
            {error}
          </AlertBox>
        )}
        {notice && (
          <AlertBox tone="success" className="mt-4">
            {notice}
          </AlertBox>
        )}

        <form onSubmit={handleSubmit} className="mt-5 space-y-4" noValidate={false}>
          <Field label="Email" htmlFor="login-email">
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={formDisabled}
              placeholder="phuhuynh@example.com"
              className={inputClassName}
            />
          </Field>

          {mode !== 'forgot' && (
            <Field
              label="Mật khẩu"
              htmlFor="login-password"
              hint={mode === 'signup' ? 'Tối thiểu 6 ký tự. Không dùng chung mật khẩu với tài khoản khác.' : undefined}
            >
              <input
                id="login-password"
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={formDisabled}
                placeholder="••••••••"
                className={inputClassName}
              />
            </Field>
          )}

          <button type="submit" disabled={formDisabled} className={`${primaryButtonClassName} w-full`}>
            {submitting ? 'Đang xử lý…' : copy.submit}
          </button>
        </form>

        <div className="mt-5 space-y-1 border-t border-slate-100 pt-4 text-center text-sm">
          {mode === 'login' && (
            <>
              <p>
                <button type="button" onClick={() => switchMode('forgot')} className={textLinkClassName}>
                  Quên mật khẩu?
                </button>
              </p>
              <p className="text-slate-600">
                Chưa có tài khoản?{' '}
                <button type="button" onClick={() => switchMode('signup')} className={textLinkClassName}>
                  Đăng ký tài khoản phụ huynh
                </button>
              </p>
            </>
          )}
          {mode !== 'login' && (
            <p className="text-slate-600">
              <button type="button" onClick={() => switchMode('login')} className={textLinkClassName}>
                Quay lại đăng nhập
              </button>
            </p>
          )}
        </div>
    </AuthShell>
  )
}
