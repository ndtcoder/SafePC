import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { toVietnameseError } from '../lib/format'
import {
  MFA_CODE_LENGTH,
  buildQrCodeDataUrl,
  groupMfaSecret,
  isUnverifiedTotpFactor,
  isValidMfaCode,
  isVerifiedTotpFactor,
  normalizeMfaCode,
  type MfaFactorView,
} from '../lib/mfa'
import {
  AlertBox,
  Card,
  Field,
  Spinner,
  dangerOutlineButtonClassName,
  inputClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
} from '../components/ui'

type SectionState = 'loading' | 'ready' | 'error'
type Flow = 'idle' | 'enrolling' | 'disabling'

interface PendingEnrollment {
  factorId: string
  qrCodeSvg: string
  secret: string
}

/**
 * Mục "Bảo mật tài khoản" trên trang Hồ sơ: bật/tắt xác thực hai lớp
 * (MFA) TOTP cho tài khoản phụ huynh đang đăng nhập. MFA là tự nguyện:
 * tài khoản chưa bật thì đăng nhập như cũ, không đổi gì.
 *
 * Factor nằm trong schema auth của Supabase, Dashboard không lưu secret
 * hay mã khôi phục ở đâu. Gỡ một factor ĐÃ xác minh đòi phiên ở mức
 * aal2 (quy định của Supabase Auth) nên luồng tắt luôn yêu cầu nhập mã
 * hiện tại trước — vừa là xác nhận, vừa nâng phiên lên aal2 để gỡ được.
 */
export default function MfaSection() {
  const { configured, user, refreshAal } = useAuth()
  const [state, setState] = useState<SectionState>('loading')
  const [error, setError] = useState('')
  const [factors, setFactors] = useState<MfaFactorView[]>([])
  const [flow, setFlow] = useState<Flow>('idle')
  const [pending, setPending] = useState<PendingEnrollment | null>(null)
  const [disablingFactor, setDisablingFactor] = useState<MfaFactorView | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const loadSeqRef = useRef(0)

  const loadFactors = useCallback(async () => {
    if (!supabase || !user) {
      setState('ready')
      return
    }
    const seq = ++loadSeqRef.current
    setState('loading')
    setError('')
    try {
      const { data, error: listError } = await supabase.auth.mfa.listFactors()
      if (listError) throw listError
      if (seq !== loadSeqRef.current) return
      setFactors((data?.all ?? []) as MfaFactorView[])
      setState('ready')
    } catch (err) {
      if (seq !== loadSeqRef.current) return
      setError(toVietnameseError(err))
      setState('error')
    }
  }, [user])

  useEffect(() => {
    void loadFactors()
  }, [loadFactors])

  const verifiedFactors = factors.filter(isVerifiedTotpFactor)
  const unverifiedFactors = factors.filter(isUnverifiedTotpFactor)
  const otherFactors = factors.filter((f) => !isVerifiedTotpFactor(f) && !isUnverifiedTotpFactor(f))

  const resetFlow = () => {
    setFlow('idle')
    setPending(null)
    setDisablingFactor(null)
    setCode('')
    setActionError(null)
  }

  const handleStartEnroll = async () => {
    if (!supabase) return
    setBusy(true)
    setMessage(null)
    setActionError(null)
    try {
      // Dọn các lần đăng ký dở trước đó (factor chưa xác minh): secret
      // của chúng đã mất theo lần đăng ký cũ nên không dùng lại được.
      for (const stale of unverifiedFactors) {
        const { error: cleanupError } = await supabase.auth.mfa.unenroll({ factorId: stale.id })
        if (cleanupError) throw cleanupError
      }
      const { data, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'SafePC',
        issuer: 'SafePC',
      })
      if (enrollError) throw enrollError
      if (!data?.totp || !data.totp.qr_code || !data.totp.secret) {
        throw new Error('Không nhận được mã QR từ máy chủ. Vui lòng thử lại.')
      }
      setPending({ factorId: data.id, qrCodeSvg: data.totp.qr_code, secret: data.totp.secret })
      setFlow('enrolling')
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setBusy(false)
    }
  }

  const handleCancelEnroll = async () => {
    // Hủy đăng ký dở: gỡ factor chưa xác minh để lần sau bắt đầu sạch.
    // Lỗi khi dọn thì bỏ qua — lần bật sau sẽ dọn lại, và factor chưa
    // xác minh không ảnh hưởng đăng nhập.
    if (supabase && pending) {
      await supabase.auth.mfa.unenroll({ factorId: pending.factorId }).catch(() => {})
    }
    resetFlow()
    void loadFactors()
  }

  const handleConfirmEnroll = async (event: FormEvent) => {
    event.preventDefault()
    if (!supabase || !pending) return
    const normalized = normalizeMfaCode(code)
    if (!isValidMfaCode(normalized)) {
      setActionError('Vui lòng nhập đủ 6 chữ số đang hiện trong app authenticator.')
      return
    }
    setBusy(true)
    setActionError(null)
    try {
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId: pending.factorId,
        code: normalized,
      })
      if (verifyError) throw verifyError
      await refreshAal()
      resetFlow()
      setMessage('Đã bật xác thực hai lớp. Từ lần đăng nhập sau, bạn sẽ cần nhập mã 6 số từ app authenticator.')
      await loadFactors()
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setBusy(false)
    }
  }

  const handleStartDisable = (factor: MfaFactorView) => {
    setDisablingFactor(factor)
    setCode('')
    setMessage(null)
    setActionError(null)
    setFlow('disabling')
  }

  const handleConfirmDisable = async (event: FormEvent) => {
    event.preventDefault()
    if (!supabase || !disablingFactor) return
    const normalized = normalizeMfaCode(code)
    if (!isValidMfaCode(normalized)) {
      setActionError('Vui lòng nhập đủ 6 chữ số đang hiện trong app authenticator.')
      return
    }
    setBusy(true)
    setActionError(null)
    try {
      // Xác minh mã hiện tại trước: vừa chứng minh người thao tác đang
      // giữ thiết bị, vừa nâng phiên lên aal2 — điều kiện bắt buộc để
      // Supabase cho gỡ một factor đã xác minh.
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId: disablingFactor.id,
        code: normalized,
      })
      if (verifyError) throw verifyError
      const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId: disablingFactor.id })
      if (unenrollError) throw unenrollError
      // Làm mới phiên để danh sách factor trong phiên cục bộ hết liệt
      // kê factor vừa gỡ; nếu không, lần tải trang sau vẫn đòi mã MFA
      // dù tài khoản đã không còn factor nào. Lỗi làm mới không làm mất
      // kết quả gỡ (factor đã gỡ thành công) nên chỉ ghi nhật ký, lần
      // tải trang sau sẽ tự đồng bộ lại danh sách.
      try {
        await supabase.auth.refreshSession()
        await refreshAal()
      } catch (refreshError) {
        console.warn('Không làm mới được phiên sau khi gỡ factor MFA:', refreshError)
      }
      resetFlow()
      setMessage('Đã tắt xác thực hai lớp. Tài khoản chỉ còn cần email và mật khẩu để đăng nhập.')
      await loadFactors()
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setBusy(false)
    }
  }

  const handleDiscardUnverified = async (factor: MfaFactorView) => {
    if (!supabase) return
    setBusy(true)
    setActionError(null)
    try {
      const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId: factor.id })
      if (unenrollError) throw unenrollError
      await loadFactors()
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setBusy(false)
    }
  }

  const handleCopySecret = async () => {
    if (!pending) return
    try {
      await navigator.clipboard.writeText(pending.secret)
      setCopied(true)
    } catch {
      setCopied(false)
      setActionError('Không sao chép được. Vui lòng gõ tay mã bí mật vào app authenticator.')
    }
  }

  // Chưa cấu hình Supabase thì không hiện mục này (nút bật bấm vào
  // cũng im lặng vì không có client) — cùng mẫu với FamilyInviteSection.
  if (!configured) return null

  if (state === 'loading') {
    return (
      <Card title="Bảo mật tài khoản">
        <Spinner label="Đang tải trạng thái xác thực hai lớp…" />
      </Card>
    )
  }

  if (state === 'error') {
    return (
      <Card title="Bảo mật tài khoản">
        <AlertBox tone="error">{error}</AlertBox>
        <button type="button" onClick={() => void loadFactors()} className={`mt-4 ${secondaryButtonClassName}`}>
          Thử lại
        </button>
      </Card>
    )
  }

  return (
    <Card title="Bảo mật tài khoản">
      <p className="text-sm text-slate-600">
        Xác thực hai lớp (MFA) thêm một bước nhập mã 6 số từ app authenticator (Google Authenticator, Microsoft
        Authenticator…) sau mật khẩu. Kẻ trộm được mật khẩu vẫn không đăng nhập được nếu không có điện thoại của
        bạn. Đây là tính năng tự nguyện — tài khoản chưa bật vẫn đăng nhập như cũ.
      </p>

      {message && (
        <AlertBox tone="success" className="mt-4">
          {message}
        </AlertBox>
      )}
      {actionError && (
        <AlertBox tone="error" className="mt-4">
          {actionError}
        </AlertBox>
      )}

      {flow === 'idle' && (
        <div className="mt-4 space-y-3">
          {verifiedFactors.length > 0 ? (
            <>
              <AlertBox tone="success">
                Xác thực hai lớp đang bật cho tài khoản này ({verifiedFactors.length} phương thức).
              </AlertBox>
              <ul className="space-y-2">
                {verifiedFactors.map((factor) => (
                  <li
                    key={factor.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  >
                    <span className="text-slate-700">
                      {factor.friendly_name || 'App authenticator'} — tạo ngày{' '}
                      {new Date(factor.created_at).toLocaleDateString('vi-VN')}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleStartDisable(factor)}
                      disabled={busy}
                      className={dangerOutlineButtonClassName}
                    >
                      Tắt phương thức này
                    </button>
                  </li>
                ))}
              </ul>
              <p className="text-sm text-slate-600">
                Muốn dùng điện thoại khác? Hãy tắt phương thức cũ rồi bật lại trên điện thoại mới.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-600">Tài khoản này chưa bật xác thực hai lớp.</p>
              <button
                type="button"
                onClick={() => void handleStartEnroll()}
                disabled={busy}
                className={primaryButtonClassName}
              >
                {busy ? 'Đang chuẩn bị…' : 'Bật xác thực hai lớp'}
              </button>
            </>
          )}

          {unverifiedFactors.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <p>
                Có {unverifiedFactors.length} lần đăng ký chưa hoàn tất (đã tạo nhưng chưa nhập mã xác nhận). Các lần
                đăng ký dở này không bảo vệ tài khoản và sẽ bị dọn khi bạn bật lại.
              </p>
              <ul className="mt-2 space-y-2">
                {unverifiedFactors.map((factor) => (
                  <li key={factor.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {factor.friendly_name || 'App authenticator'} — tạo ngày{' '}
                      {new Date(factor.created_at).toLocaleDateString('vi-VN')}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleDiscardUnverified(factor)}
                      disabled={busy}
                      className={secondaryButtonClassName}
                    >
                      Hủy lần đăng ký này
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {otherFactors.length > 0 && (
            <p className="text-sm text-slate-600">
              Tài khoản còn có {otherFactors.length} phương thức xác thực loại khác (không phải app authenticator),
              được tạo từ nơi khác. Dashboard chỉ quản lý phương thức app authenticator và không quản lý các
              phương thức kia.
            </p>
          )}
        </div>
      )}

      {flow === 'enrolling' && pending && (
        <form onSubmit={handleConfirmEnroll} className="mt-4 space-y-4">
          <ol className="list-decimal space-y-3 pl-5 text-sm text-slate-600">
            <li>
              Mở app authenticator trên điện thoại, chọn thêm tài khoản và quét mã QR dưới đây.
              <span className="mt-2 block rounded-lg border border-slate-200 bg-white p-3 text-center">
                <img
                  src={buildQrCodeDataUrl(pending.qrCodeSvg)}
                  alt="Mã QR đăng ký SafePC vào app authenticator"
                  className="mx-auto h-48 w-48"
                />
              </span>
            </li>
            <li>
              Không quét được? Chọn nhập mã bí mật bằng tay trong app, tên tài khoản đặt là SafePC và nhập mã sau:
              <span className="mt-2 flex flex-wrap items-center gap-2">
                <code className="rounded bg-slate-100 px-2 py-1 font-mono text-sm tracking-wider text-slate-900">
                  {groupMfaSecret(pending.secret)}
                </code>
                <button type="button" onClick={() => void handleCopySecret()} className={secondaryButtonClassName}>
                  {copied ? 'Đã sao chép' : 'Sao chép mã'}
                </button>
              </span>
            </li>
            <li>Nhập mã 6 số đang hiện trong app để hoàn tất. Chỉ khi mã đúng thì xác thực hai lớp mới được bật.</li>
          </ol>
          <Field
            label="Mã xác thực 6 số"
            htmlFor="mfa-enroll-code"
            hint="Mã đổi sau mỗi 30 giây. Nhập mã mới nhất đang hiện trong app."
          >
            <input
              id="mfa-enroll-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              maxLength={MFA_CODE_LENGTH}
              value={code}
              onChange={(e) => setCode(normalizeMfaCode(e.target.value).slice(0, MFA_CODE_LENGTH))}
              disabled={busy}
              placeholder="123456"
              className={inputClassName}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy || !isValidMfaCode(code)} className={primaryButtonClassName}>
              {busy ? 'Đang xác minh…' : 'Xác nhận và bật'}
            </button>
            <button type="button" onClick={() => void handleCancelEnroll()} disabled={busy} className={secondaryButtonClassName}>
              Hủy
            </button>
          </div>
          <p className="text-sm text-slate-600">
            Lưu ý: bật xác thực hai lớp không đăng xuất các phiên đang mở khác của tài khoản này. Nếu nghi mật khẩu
            đã lộ, hãy đổi mật khẩu ngay và nhờ người giữ quyền quản trị dự án Supabase thu hồi các phiên đó qua
            Auth Admin API.
          </p>
        </form>
      )}

      {flow === 'disabling' && disablingFactor && (
        <form onSubmit={handleConfirmDisable} className="mt-4 space-y-4">
          <AlertBox tone="warning">
            Sau khi tắt, tài khoản chỉ còn được bảo vệ bằng email và mật khẩu. Chỉ tắt khi bạn chắc chắn thiết bị
            này không còn dùng nữa hoặc bạn muốn bật lại trên điện thoại khác.
          </AlertBox>
          <Field
            label="Mã xác thực hiện tại (6 số)"
            htmlFor="mfa-disable-code"
            hint="Nhập mã đang hiện trong app authenticator để xác nhận bạn đang giữ thiết bị."
          >
            <input
              id="mfa-disable-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              maxLength={MFA_CODE_LENGTH}
              value={code}
              onChange={(e) => setCode(normalizeMfaCode(e.target.value).slice(0, MFA_CODE_LENGTH))}
              disabled={busy}
              placeholder="123456"
              className={inputClassName}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy || !isValidMfaCode(code)} className={dangerOutlineButtonClassName}>
              {busy ? 'Đang xử lý…' : 'Tắt xác thực hai lớp'}
            </button>
            <button type="button" onClick={resetFlow} disabled={busy} className={secondaryButtonClassName}>
              Giữ nguyên
            </button>
          </div>
        </form>
      )}

      <div className="mt-5 border-t border-slate-100 pt-4">
        <h3 className="text-sm font-semibold text-slate-800">Mất điện thoại thì sao?</h3>
        <p className="mt-1 text-sm text-slate-600">
          Dashboard không có mã khôi phục tự phục vụ trong đợt này, và đặt lại mật khẩu qua email không bỏ qua bước
          nhập mã. Nếu mất thiết bị, người giữ quyền quản trị dự án Supabase cần gỡ factor MFA của tài khoản trong
          Supabase Dashboard (Authentication → Users → chọn tài khoản → gỡ factor ở mục MFA), hoặc qua Auth Admin
          API của Supabase. Phụ huynh còn lại trong gia đình không gỡ được từ Dashboard SafePC.
        </p>
      </div>
    </Card>
  )
}
