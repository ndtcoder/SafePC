import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { isValidInviteTokenFormat, sha256HexLower } from '../lib/familyInvites'
import { toVietnameseError } from '../lib/format'
import {
  NotConfiguredState,
  Spinner,
  primaryButtonClassName,
  secondaryButtonClassName,
} from '../components/ui'

type AcceptStatus = 'accepted' | 'email_mismatch' | 'already_has_family' | 'invalid'

interface AcceptInviteResult {
  status?: string
  family_id?: string
  family_name?: string | null
  invited_email?: string
}

function isKnownStatus(status: string | undefined): status is AcceptStatus {
  return (
    status === 'accepted' ||
    status === 'email_mismatch' ||
    status === 'already_has_family' ||
    status === 'invalid'
  )
}

/**
 * Trang chấp nhận lời mời phụ huynh thứ hai: /moi/<token>.
 * Trang này nằm NGOÀI RequireAuth (như trang đăng nhập) vì người được
 * mời có thể chưa đăng nhập, thậm chí chưa có tài khoản.
 *
 * Luồng:
 * - Chưa đăng nhập: hướng dẫn đăng nhập/đăng ký, link đăng nhập mang
 *   ?next=/moi/<token> để đăng nhập xong quay lại đây. Nếu đăng ký mới
 *   thì phải xác minh email trước; xác minh xong hãy bấm lại vào link
 *   lời mời (link vẫn nằm trong tin nhắn của người mời).
 * - Đã đăng nhập: hiển thị rõ email đang dùng và nút chấp nhận tường
 *   minh (KHÔNG tự chấp nhận khi mở trang — link có thể bị bấm nhầm
 *   hoặc tải trước). Bấm nút thì gọi RPC safepc_accept_family_invite
 *   với SHA-256 của token; kết quả hiển thị theo từng status server
 *   trả về, không đoán mò.
 */
export default function AcceptInvitePage() {
  const { configured, user, loading, signOut } = useAuth()
  const { token } = useParams<{ token: string }>()
  const [calling, setCalling] = useState(false)
  const [result, setResult] = useState<AcceptInviteResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [missingMigration, setMissingMigration] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  const tokenValid = token != null && isValidInviteTokenFormat(token)

  const handleAccept = async () => {
    if (!supabase || !user || !token || !tokenValid) return
    setCalling(true)
    setError(null)
    try {
      const tokenHash = await sha256HexLower(token)
      const { data, error: rpcError } = await supabase.rpc('safepc_accept_family_invite', {
        p_token_hash: tokenHash,
      })
      if (rpcError) throw rpcError
      const parsed = (data ?? {}) as AcceptInviteResult
      if (!isKnownStatus(parsed.status)) {
        throw new Error('Máy chủ trả về kết quả không nhận dạng được. Vui lòng thử lại.')
      }
      setResult(parsed)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('safepc_accept_family_invite')) {
        setMissingMigration(true)
        return
      }
      setError(toVietnameseError(err))
    } finally {
      setCalling(false)
    }
  }

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      await signOut()
      setResult(null)
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-6 flex flex-col items-center gap-2 text-center">
        <img src="/icons/icon.svg" alt="Logo SafePC" className="h-14 w-14" />
        <p className="text-xl font-bold tracking-tight text-slate-900">SafePC</p>
        <p className="text-sm text-slate-600">Lời mời làm phụ huynh</p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        {loading ? (
          <Spinner label="Đang kiểm tra phiên đăng nhập…" />
        ) : !configured ? (
          <NotConfiguredState />
        ) : missingMigration ? (
          <div role="status">
            <h1 className="text-lg font-semibold text-slate-900">Tính năng này chưa sẵn sàng</h1>
            <p className="mt-1 text-sm text-slate-600">
              Máy chủ chưa áp dụng migration 14 cho lời mời phụ huynh. Hãy nhờ người mời kiểm tra lại, rồi
              bấm lại vào link lời mời sau.
            </p>
            <Link to="/hom-nay" className={`${secondaryButtonClassName} mt-4 w-full`}>
              Về trang tổng quan
            </Link>
          </div>
        ) : !tokenValid ? (
          <div role="alert">
            <h1 className="text-lg font-semibold text-slate-900">Link lời mời không hợp lệ</h1>
            <p className="mt-1 text-sm text-slate-600">
              Link này không đúng định dạng — có thể đã bị cắt khi copy. Hãy nhờ người mời gửi lại link đầy
              đủ.
            </p>
            <Link to="/hom-nay" className={`${secondaryButtonClassName} mt-4 w-full`}>
              Về trang tổng quan
            </Link>
          </div>
        ) : !user ? (
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Bạn được mời làm phụ huynh</h1>
            <p className="mt-1 text-sm text-slate-600">
              Chủ gia đình đã mời bạn cùng quản lý máy tính của con trên SafePC. Hãy đăng nhập (hoặc tạo tài
              khoản mới) bằng <strong>đúng email được mời</strong>, rồi quay lại link này để chấp nhận.
            </p>
            <p className="mt-3 text-sm text-slate-600">
              Nếu bạn đăng ký tài khoản mới, bạn sẽ cần xác minh email trước khi đăng nhập. Xác minh xong,
              hãy bấm lại vào link lời mời trong tin nhắn của người mời.
            </p>
            <Link
              to={`/dang-nhap?next=${encodeURIComponent(`/moi/${token}`)}`}
              className={`${primaryButtonClassName} mt-4 w-full`}
            >
              Đăng nhập / Đăng ký
            </Link>
          </div>
        ) : result?.status === 'accepted' ? (
          <div role="status">
            <h1 className="text-lg font-semibold text-slate-900">Bạn đã tham gia gia đình</h1>
            <p className="mt-1 text-sm text-slate-600">
              {result.family_name
                ? `Bạn đã trở thành phụ huynh của gia đình “${result.family_name}”.`
                : 'Bạn đã trở thành phụ huynh của gia đình.'}{' '}
              Bạn có thể xem hồ sơ con, thiết bị, quy tắc, yêu cầu và báo cáo, đồng thời nhận email báo cáo
              tuần cùng email thông báo như phụ huynh còn lại.
            </p>
            <Link to="/hom-nay" className={`${primaryButtonClassName} mt-4 w-full`}>
              Vào trang tổng quan
            </Link>
          </div>
        ) : result?.status === 'email_mismatch' ? (
          <div role="alert">
            <h1 className="text-lg font-semibold text-slate-900">Lời mời này dành cho email khác</h1>
            <p className="mt-1 text-sm text-slate-600">
              Lời mời này dành cho <strong>{result.invited_email}</strong>, nhưng bạn đang đăng nhập bằng{' '}
              <strong>{user.email ?? 'một email khác'}</strong>. Hãy đăng xuất rồi đăng nhập (hoặc đăng ký)
              bằng đúng email được mời, sau đó bấm lại vào link lời mời.
            </p>
            <button
              type="button"
              onClick={() => void handleSignOut()}
              disabled={signingOut}
              className={`${primaryButtonClassName} mt-4 w-full`}
            >
              {signingOut ? 'Đang đăng xuất…' : 'Đăng xuất để đổi tài khoản'}
            </button>
            <Link to="/hom-nay" className={`${secondaryButtonClassName} mt-3 w-full`}>
              Về trang tổng quan
            </Link>
          </div>
        ) : result?.status === 'already_has_family' ? (
          <div role="alert">
            <h1 className="text-lg font-semibold text-slate-900">Tài khoản này đã có gia đình riêng</h1>
            <p className="mt-1 text-sm text-slate-600">
              Tài khoản <strong>{user.email ?? 'này'}</strong> đã là chủ của một gia đình khác, nên không
              thể tham gia thêm gia đình được mời (mỗi tài khoản chỉ thuộc một gia đình). Hãy đăng xuất rồi
              đăng nhập (hoặc đăng ký) bằng một tài khoản khác với đúng email được mời.
            </p>
            <button
              type="button"
              onClick={() => void handleSignOut()}
              disabled={signingOut}
              className={`${primaryButtonClassName} mt-4 w-full`}
            >
              {signingOut ? 'Đang đăng xuất…' : 'Đăng xuất để đổi tài khoản'}
            </button>
            <Link to="/hom-nay" className={`${secondaryButtonClassName} mt-3 w-full`}>
              Về trang tổng quan
            </Link>
          </div>
        ) : result?.status === 'invalid' ? (
          <div role="alert">
            <h1 className="text-lg font-semibold text-slate-900">Lời mời không còn hiệu lực</h1>
            <p className="mt-1 text-sm text-slate-600">
              Lời mời này đã hết hạn, đã được dùng, đã bị thu hồi, hoặc không tồn tại. Hãy nhờ người mời tạo
              lời mời mới và gửi lại link cho bạn.
            </p>
            <Link to="/hom-nay" className={`${secondaryButtonClassName} mt-4 w-full`}>
              Về trang tổng quan
            </Link>
          </div>
        ) : (
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Bạn được mời làm phụ huynh</h1>
            <p className="mt-1 text-sm text-slate-600">
              Chấp nhận lời mời này, bạn sẽ trở thành phụ huynh của gia đình đã mời và thấy toàn bộ hồ sơ
              con, thiết bị, quy tắc, yêu cầu và báo cáo của gia đình đó, đồng thời nhận email báo cáo tuần
              cùng email thông báo.
            </p>
            <p className="mt-3 text-sm text-slate-600">
              Bạn đang đăng nhập bằng <strong>{user.email ?? 'tài khoản hiện tại'}</strong>. Lời mời chỉ
              chấp nhận được khi email này trùng với email được mời.
            </p>
            {error && (
              <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
                {error}
              </div>
            )}
            <button
              type="button"
              onClick={() => void handleAccept()}
              disabled={calling}
              className={`${primaryButtonClassName} mt-4 w-full`}
            >
              {calling ? 'Đang xử lý…' : 'Chấp nhận lời mời'}
            </button>
            <p className="mt-3 text-center text-xs text-slate-500">
              Không phải bạn?{' '}
              <button
                type="button"
                onClick={() => void handleSignOut()}
                disabled={signingOut || calling}
                className="font-medium text-indigo-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 rounded"
              >
                Đăng xuất để đổi tài khoản
              </button>
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
