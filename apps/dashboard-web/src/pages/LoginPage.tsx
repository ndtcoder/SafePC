import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { isValidInviteNextPath } from '../lib/familyInvites'
import { toVietnameseError } from '../lib/format'
import {
  MFA_CODE_LENGTH,
  hasVerifiedNonTotpFactor,
  isValidMfaCode,
  needsMfaStep,
  normalizeMfaCode,
  selectChallengeFactor,
} from '../lib/mfa'
import {
  AlertBox,
  AuthShell,
  Field,
  Spinner,
  inputClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
  textLinkClassName,
} from '../components/ui'

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
  const { configured, user, loading, mfaRequired, refreshAal, signOut } = useAuth()
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

  // Bước MFA: bật khi đăng nhập bằng mật khẩu xong mà tài khoản đã bật
  // xác thực hai lớp, hoặc khi tải lại trang giữa chừng với phiên aal1.
  const [mfaStep, setMfaStep] = useState(false)
  const [mfaCode, setMfaCode] = useState('')
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null)
  const [mfaPreparing, setMfaPreparing] = useState(false)
  const mfaPreparedRef = useRef(false)

  const showMfaStep = mfaStep || mfaRequired

  // Chuẩn bị bước MFA: lấy danh sách factor từ server (nguồn đáng tin —
  // phiên cục bộ có thể còn liệt kê factor đã bị gỡ ở nơi khác). Nếu
  // không còn factor đã xác minh nào mà phiên vẫn đòi aal2 thì phiên
  // cục bộ đã cũ: làm mới phiên rồi kiểm tra lại, tránh kẹt ở bước MFA
  // không bao giờ xong.
  const prepareMfaStep = useCallback(async () => {
    if (!supabase) return
    setMfaPreparing(true)
    setError(null)
    try {
      const { data, error: listError } = await supabase.auth.mfa.listFactors()
      if (listError) throw listError
      const factor = selectChallengeFactor(data?.all ?? [])
      if (factor) {
        setMfaFactorId(factor.id)
        return
      }
      // Còn factor đã xác minh loại khác (phone/webauthn...) thì phiên
      // vẫn đòi aal2 nhưng Dashboard không thách thức được factor đó:
      // đăng nhập lại không bao giờ sửa được, nên hướng thẳng tới đường
      // khôi phục qua quản trị Supabase (xem ghi chú "Mất điện thoại"
      // bên dưới) thay vì gợi ý đăng xuất/đăng nhập lại.
      if (hasVerifiedNonTotpFactor(data?.all ?? [])) {
        throw new Error(
          'Tài khoản này đang dùng một phương thức xác thực hai lớp mà Dashboard không hỗ trợ (Dashboard chỉ hỗ trợ app authenticator). Vui lòng nhờ người giữ quyền quản trị dự án Supabase gỡ phương thức đó trong Supabase Dashboard (Authentication → Users → tài khoản của bạn → gỡ factor MFA).',
        )
      }
      await supabase.auth.refreshSession()
      await refreshAal()
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (aal && !needsMfaStep(aal.currentLevel, aal.nextLevel)) {
        // Phiên mới không còn đòi MFA nữa: thoát bước MFA để chuyển
        // hướng vào Dashboard như đăng nhập thường.
        setMfaStep(false)
        return
      }
      throw new Error(
        'Không tìm thấy phương thức xác thực hai lớp của tài khoản này. Vui lòng đăng xuất rồi đăng nhập lại.',
      )
    } catch (err) {
      setError(toVietnameseError(err))
    } finally {
      setMfaPreparing(false)
    }
  }, [refreshAal])

  useEffect(() => {
    if (!user) {
      mfaPreparedRef.current = false
      return
    }
    if (!loading && showMfaStep && !mfaPreparedRef.current) {
      mfaPreparedRef.current = true
      void prepareMfaStep()
    }
  }, [loading, user, showMfaStep, prepareMfaStep])

  const handleMfaSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!supabase || !mfaFactorId) return
    const code = normalizeMfaCode(mfaCode)
    if (!isValidMfaCode(code)) {
      setError('Vui lòng nhập đủ 6 chữ số đang hiện trong app authenticator.')
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      // challengeAndVerify tạo thử thách mới và xác minh trong một bước,
      // nên mã nhập chậm không bị kẹt ở thử thách đã hết hạn.
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId: mfaFactorId,
        code,
      })
      if (verifyError) throw verifyError
      // Chỉ vào Dashboard khi phiên đã thực sự đạt aal2.
      await refreshAal()
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (aal && needsMfaStep(aal.currentLevel, aal.nextLevel)) {
        throw new Error('Phiên đăng nhập chưa hoàn tất bước xác thực hai lớp. Vui lòng nhập mã xác thực rồi thử lại.')
      }
      setMfaStep(false)
      navigate(redirectTo, { replace: true })
    } catch (err) {
      setError(toVietnameseError(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleMfaSignOut = async () => {
    await signOut()
    mfaPreparedRef.current = false
    setMfaStep(false)
    setMfaFactorId(null)
    setMfaCode('')
    setError(null)
    setNotice(null)
  }

  const handleMfaRetry = () => {
    mfaPreparedRef.current = false
    setMfaFactorId(null)
    void prepareMfaStep()
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
        // Tài khoản chưa bật MFA: mức tiếp theo vẫn là aal1 nên vào
        // thẳng như trước, không đổi luồng. Tài khoản đã bật MFA: mức
        // tiếp theo là aal2 nên phải qua bước nhập mã bên dưới.
        const { data: aal, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
        if (aalError) throw aalError
        if (needsMfaStep(aal.currentLevel, aal.nextLevel)) {
          setMfaStep(true)
        } else {
          navigate(redirectTo, { replace: true })
        }
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

  const authFooter = (
    <p className="mt-6 text-center text-xs text-slate-500">
      <Link to="/hom-nay" className="inline-flex min-h-[44px] items-center rounded-lg px-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2">
        Xem trang tổng quan (chỉ hiển thị hướng dẫn khi chưa cấu hình)
      </Link>
    </p>
  )

  if (!loading && user && !showMfaStep) {
    return <Navigate to={redirectTo} replace />
  }

  // Bước nhập mã MFA sau khi mật khẩu đã đúng.
  if (!loading && user && showMfaStep) {
    return (
      <AuthShell subtitle="Dashboard phụ huynh — quản lý máy tính của con" footer={authFooter}>
        <h1 className="text-lg font-semibold text-slate-900">Nhập mã xác thực</h1>
        <p className="mt-1 text-sm text-slate-600">
          Tài khoản này đã bật xác thực hai lớp. Mở app authenticator trên điện thoại của bạn và nhập mã 6 số đang
          hiện cho SafePC.
        </p>

        {error && (
          <AlertBox tone="error" className="mt-4">
            {error}
          </AlertBox>
        )}

        {mfaPreparing ? (
          <div className="mt-5">
            <Spinner label="Đang chuẩn bị bước xác thực…" />
          </div>
        ) : !mfaFactorId ? (
          <div className="mt-5 space-y-3">
            <button type="button" onClick={handleMfaRetry} className={`${secondaryButtonClassName} w-full`}>
              Thử lại
            </button>
            <p className="text-center text-sm">
              <button type="button" onClick={() => void handleMfaSignOut()} className={textLinkClassName}>
                Đăng xuất và quay lại đăng nhập
              </button>
            </p>
          </div>
        ) : (
          <form onSubmit={handleMfaSubmit} className="mt-5 space-y-4">
            <Field
              label="Mã xác thực 6 số"
              htmlFor="mfa-code"
              hint="Mã đổi sau mỗi 30 giây. Nhập mã mới nhất đang hiện trong app."
            >
              <input
                id="mfa-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                maxLength={MFA_CODE_LENGTH}
                value={mfaCode}
                onChange={(e) => setMfaCode(normalizeMfaCode(e.target.value).slice(0, MFA_CODE_LENGTH))}
                disabled={submitting}
                placeholder="123456"
                className={inputClassName}
              />
            </Field>
            <button type="submit" disabled={submitting || !isValidMfaCode(mfaCode)} className={`${primaryButtonClassName} w-full`}>
              {submitting ? 'Đang xác minh…' : 'Xác minh và đăng nhập'}
            </button>
          </form>
        )}

        <div className="mt-5 space-y-1 border-t border-slate-100 pt-4 text-center text-sm">
          <p className="text-slate-600">
            Mất điện thoại hoặc không còn app authenticator? Việc gỡ bước xác thực này phải do người giữ quyền quản
            trị dự án Supabase thực hiện trong Supabase Dashboard (Authentication → Users → tài khoản của bạn →
            gỡ factor MFA). Đặt lại mật khẩu qua email không bỏ qua bước này.
          </p>
          <p>
            <button type="button" onClick={() => void handleMfaSignOut()} className={textLinkClassName}>
              Đăng xuất và quay lại đăng nhập
            </button>
          </p>
        </div>
      </AuthShell>
    )
  }

  const copy = MODE_TITLES[mode]
  const formDisabled = !configured || submitting

  return (
    <AuthShell
      subtitle="Dashboard phụ huynh — quản lý máy tính của con"
      footer={authFooter}
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
