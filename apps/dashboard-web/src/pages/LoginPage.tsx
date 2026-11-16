import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { toVietnameseError } from '../lib/format'
import { Field, inputClassName, primaryButtonClassName } from '../components/ui'

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
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  if (!loading && user) {
    return <Navigate to="/hom-nay" replace />
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
        navigate('/hom-nay', { replace: true })
      } else if (mode === 'signup') {
        const { error: authError } = await supabase.auth.signUp({ email, password })
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
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-6 flex flex-col items-center gap-2 text-center">
        <img src="/icons/icon.svg" alt="Logo SafePC" className="h-14 w-14" />
        <p className="text-xl font-bold tracking-tight text-slate-900">SafePC</p>
        <p className="text-sm text-slate-600">Dashboard phụ huynh — quản lý máy tính của con</p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">{copy.title}</h1>
        <p className="mt-1 text-sm text-slate-600">{copy.description}</p>

        {!configured && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4" role="status">
            <p className="text-sm font-medium text-amber-900">Chưa cấu hình Supabase</p>
            <p className="mt-1 text-sm text-amber-800">
              Form đăng nhập đang bị vô hiệu hoá vì chưa có project Supabase. Hãy copy file{' '}
              <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs">.env.example</code> thành{' '}
              <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs">.env</code>, điền Project URL và
              anon key từ Supabase Dashboard, rồi khởi động lại ứng dụng. App không đăng nhập giả khi chưa có
              backend thật.
            </p>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800" role="status">
            {notice}
          </div>
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

          <button type="submit" disabled={formDisabled} className={`${primaryButtonClassName} w-full py-2.5`}>
            {submitting ? 'Đang xử lý…' : copy.submit}
          </button>
        </form>

        <div className="mt-5 space-y-2 border-t border-slate-100 pt-4 text-center text-sm">
          {mode === 'login' && (
            <>
              <p>
                <button type="button" onClick={() => switchMode('forgot')} className="font-medium text-indigo-600 hover:underline">
                  Quên mật khẩu?
                </button>
              </p>
              <p className="text-slate-600">
                Chưa có tài khoản?{' '}
                <button type="button" onClick={() => switchMode('signup')} className="font-medium text-indigo-600 hover:underline">
                  Đăng ký tài khoản phụ huynh
                </button>
              </p>
            </>
          )}
          {mode !== 'login' && (
            <p className="text-slate-600">
              <button type="button" onClick={() => switchMode('login')} className="font-medium text-indigo-600 hover:underline">
                Quay lại đăng nhập
              </button>
            </p>
          )}
        </div>
      </div>

      <p className="mt-6 text-center text-xs text-slate-500">
        <Link to="/hom-nay" className="hover:underline">
          Xem trang tổng quan (chỉ hiển thị hướng dẫn khi chưa cấu hình)
        </Link>
      </p>
    </div>
  )
}
