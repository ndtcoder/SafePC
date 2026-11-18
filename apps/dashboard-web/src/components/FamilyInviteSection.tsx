import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { getMyFamily } from '../lib/family'
import type { Family, FamilyInvite } from '../lib/types'
import {
  INVITE_STATUS_LABELS,
  INVITE_TTL_MS,
  buildInviteLink,
  generateInviteToken,
  inviteDisplayStatus,
  isValidInviteEmail,
  normalizeInviteEmail,
  sha256HexLower,
} from '../lib/familyInvites'
import { formatDateTimeVi, toVietnameseError } from '../lib/format'
import {
  Card,
  ErrorState,
  Field,
  LoadingState,
  dangerOutlineButtonClassName,
  inputClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
} from '../components/ui'

type LoadState = 'loading' | 'ready' | 'error'

/** Số lời mời tối đa liệt kê một lần; lời mời rất ít nên đủ dùng. */
const INVITE_LIST_LIMIT = 50

interface CreatedInviteLink {
  link: string
  email: string
  expiresAtIso: string
}

interface CreateInviteResult {
  invite_id?: string
  invited_email?: string
  expires_at?: string
}

interface RevokeInviteResult {
  status?: string
}

/**
 * Mục "Mời phụ huynh thứ hai" trên trang Hồ sơ. CHỈ chủ gia đình mới
 * thấy mục này (người mời phải là owner — cùng ranh giới với policy
 * "owner manage" trên family_members; phụ huynh thứ hai không mời thêm
 * người thứ ba). Người chưa có gia đình cũng không thấy gì — tạo gia
 * đình ở trang Thiết bị/Quy tắc trước.
 *
 * Luồng: chủ gia đình nhập email → Dashboard sinh token, chỉ gửi SHA-256
 * của token lên RPC safepc_create_family_invite → link hiện MỘT LẦN duy
 * nhất để chủ gia đình tự gửi cho người được mời (nhắn tin/Zalo). Token
 * thô không bao giờ xuống database nên link mất thì phải thu hồi và tạo
 * lại — không có cách nào xem lại link cũ.
 */
export default function FamilyInviteSection() {
  const { configured, user } = useAuth()
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [missingMigration, setMissingMigration] = useState(false)
  const [family, setFamily] = useState<Family | null>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [invites, setInvites] = useState<FamilyInvite[]>([])

  const [email, setEmail] = useState('')
  const [creating, setCreating] = useState(false)
  const [createdLink, setCreatedLink] = useState<CreatedInviteLink | null>(null)
  const [copied, setCopied] = useState(false)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  const loadSeqRef = useRef(0)
  const linkInputRef = useRef<HTMLInputElement>(null)

  // Giờ hiện tại lấy mới mỗi lần render: nhãn "Hết hạn" phải đúng cả
  // khi trang mở lâu qua thời điểm hết hạn của một lời mời.
  const nowMs = Date.now()

  /**
   * Làm mới RIÊNG danh sách lời mời sau khi tạo/thu hồi, không động tới
   * state tải chung: load() đầy đủ sẽ hiện LoadingState/ErrorState và
   * che mất thẻ link vừa tạo — link chỉ hiện một lần nên không được để
   * một lần tải lại lỗi làm mất nó. Lỗi ở đây thì giữ danh sách cũ.
   */
  const refreshInviteList = useCallback(async () => {
    if (!supabase || !family) return
    try {
      const invitesResult = await supabase
        .from('family_invites')
        .select('id, family_id, invited_email, invited_by, expires_at, accepted_at, accepted_by, revoked_at, created_at')
        .order('created_at', { ascending: false })
        .limit(INVITE_LIST_LIMIT)
      if (invitesResult.error) throw invitesResult.error
      setInvites((invitesResult.data ?? []) as FamilyInvite[])
    } catch {
      // Giữ danh sách cũ; hành động chính đã thành công.
    }
  }, [family])

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current
    if (!supabase || !user) {
      setState('ready')
      return
    }
    setState('loading')
    setError('')
    setMissingMigration(false)
    try {
      const myFamily = await getMyFamily(supabase, user.id)
      if (seq !== loadSeqRef.current) return
      setFamily(myFamily)
      const owner = myFamily != null && myFamily.owner_id === user.id
      setIsOwner(owner)
      if (!owner) {
        // Không phải chủ gia đình: không tải gì thêm, không hiển thị.
        setState('ready')
        return
      }
      const invitesResult = await supabase
        .from('family_invites')
        .select('id, family_id, invited_email, invited_by, expires_at, accepted_at, accepted_by, revoked_at, created_at')
        .order('created_at', { ascending: false })
        .limit(INVITE_LIST_LIMIT)
      if (seq !== loadSeqRef.current) return
      if (invitesResult.error) throw invitesResult.error
      setInvites((invitesResult.data ?? []) as FamilyInvite[])
      setState('ready')
    } catch (err) {
      if (seq !== loadSeqRef.current) return
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('family_invites')) {
        setMissingMigration(true)
        setState('ready')
        return
      }
      setError(toVietnameseError(err))
      setState('error')
    }
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  const handleCreate = async () => {
    if (!supabase || !user || !family) return
    const normalized = normalizeInviteEmail(email)
    setActionMessage(null)
    setActionError(null)
    setCreatedLink(null)
    setCopied(false)
    if (!isValidInviteEmail(normalized)) {
      setActionError('Địa chỉ email không hợp lệ. Vui lòng kiểm tra lại.')
      return
    }
    if (user.email && normalized === normalizeInviteEmail(user.email)) {
      setActionError('Bạn không thể mời chính email của mình.')
      return
    }
    setCreating(true)
    try {
      const token = generateInviteToken()
      const tokenHash = await sha256HexLower(token)
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString()
      const { data, error: rpcError } = await supabase.rpc('safepc_create_family_invite', {
        p_email: normalized,
        p_token_hash: tokenHash,
        p_expires_at: expiresAt,
      })
      if (rpcError) throw rpcError
      const result = (data ?? {}) as CreateInviteResult
      setCreatedLink({
        link: buildInviteLink(window.location.origin, token),
        email: result.invited_email ?? normalized,
        expiresAtIso: result.expires_at ?? expiresAt,
      })
      setEmail('')
      setActionMessage(`Đã tạo lời mời cho ${result.invited_email ?? normalized}.`)
      void refreshInviteList()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('safepc_create_family_invite')) {
        setMissingMigration(true)
        return
      }
      if (message.includes('duplicate_pending_invite')) {
        setActionError('Đã có một lời mời đang chờ cho email này. Hãy thu hồi lời mời cũ rồi tạo lời mời mới.')
      } else if (message.includes('cannot_invite_self')) {
        setActionError('Bạn không thể mời chính email của mình.')
      } else if (message.includes('not_family_owner')) {
        setActionError('Chỉ chủ gia đình mới được mời thêm phụ huynh.')
      } else if (message.includes('invalid_email')) {
        setActionError('Địa chỉ email không hợp lệ. Vui lòng kiểm tra lại.')
      } else {
        setActionError(toVietnameseError(err))
      }
    } finally {
      setCreating(false)
    }
  }

  const handleCopyLink = async () => {
    if (!createdLink) return
    try {
      await navigator.clipboard.writeText(createdLink.link)
      setCopied(true)
    } catch {
      // Không copy được tự động (trình duyệt chặn): bôi đen ô link để
      // người dùng copy bằng tay, vẫn báo rõ thay vì im lặng.
      linkInputRef.current?.focus()
      linkInputRef.current?.select()
      setCopied(false)
      setActionMessage('Không copy tự động được — link đã được bôi đen, hãy copy bằng tay (Ctrl+C).')
    }
  }

  const handleRevoke = async (invite: FamilyInvite) => {
    if (!supabase) return
    setRevokingId(invite.id)
    setActionMessage(null)
    setActionError(null)
    try {
      const { data, error: rpcError } = await supabase.rpc('safepc_revoke_family_invite', {
        p_invite_id: invite.id,
      })
      if (rpcError) throw rpcError
      const status = (data as RevokeInviteResult | null)?.status
      if (status === 'already_accepted') {
        setActionError('Lời mời này đã được chấp nhận nên không thu hồi được nữa.')
      } else if (status === 'already_revoked') {
        setActionMessage('Lời mời này đã được thu hồi trước đó.')
      } else {
        setActionMessage(`Đã thu hồi lời mời cho ${invite.invited_email}. Link cũ không dùng được nữa.`)
      }
      setConfirmRevokeId(null)
      void refreshInviteList()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('safepc_revoke_family_invite')) {
        setMissingMigration(true)
        return
      }
      setActionError(toVietnameseError(err))
    } finally {
      setRevokingId(null)
    }
  }

  if (!configured) return null
  if (state === 'loading') return <LoadingState label="Đang tải mục mời phụ huynh…" />
  if (state === 'error') {
    return <ErrorState message={error} onRetry={() => void load()} />
  }
  if (!isOwner) return null

  if (missingMigration) {
    return (
      <Card title="Mời phụ huynh thứ hai">
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4" role="status">
          <p className="text-sm font-medium text-amber-900">Tính năng này chưa sẵn sàng</p>
          <p className="mt-1 text-sm text-amber-800">
            Tính năng này cần migration 14 (bảng lời mời + 3 hàm xử lý). Hãy áp dụng file{' '}
            <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs">
              20261118190000_family_invites.sql
            </code>{' '}
            trong thư mục backend/supabase/migrations/ qua Supabase SQL Editor, rồi tải lại trang.
          </p>
        </div>
      </Card>
    )
  }

  return (
    <Card title="Mời phụ huynh thứ hai">
      <p className="text-sm text-slate-600">
        Phụ huynh thứ hai sẽ thấy toàn bộ hồ sơ con, thiết bị, quy tắc, yêu cầu và báo cáo của gia đình, và
        cũng nhận email báo cáo tuần cùng email thông báo. Chỉ bạn (chủ gia đình) mới mời và thu hồi được lời
        mời.
      </p>

      {actionMessage && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800" role="status">
          {actionMessage}
        </div>
      )}
      {actionError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
          {actionError}
        </div>
      )}

      <div className="mt-4 space-y-3">
        <Field
          label="Email của phụ huynh được mời"
          htmlFor="invite-email"
          hint="Người được mời phải đăng nhập (hoặc đăng ký) bằng đúng email này thì mới chấp nhận được lời mời."
        >
          <input
            id="invite-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={creating}
            placeholder="vidu@example.com"
            className={inputClassName}
          />
        </Field>
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={creating || email.trim() === ''}
          className={primaryButtonClassName}
        >
          {creating ? 'Đang tạo lời mời…' : 'Tạo lời mời'}
        </button>
      </div>

      {createdLink && (
        <div className="mt-4 rounded-lg border border-indigo-200 bg-indigo-50 p-4">
          <p className="text-sm font-medium text-indigo-900">Link lời mời cho {createdLink.email}</p>
          <p className="mt-1 text-sm text-indigo-800">
            Link chỉ hiện MỘT LẦN duy nhất — hãy gửi ngay cho người được mời (nhắn tin, Zalo). Link hết hạn
            lúc {formatDateTimeVi(createdLink.expiresAtIso)} và chỉ dùng được một lần. Nếu mất link, hãy thu
            hồi lời mời này và tạo lời mời mới.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              ref={linkInputRef}
              type="text"
              readOnly
              value={createdLink.link}
              onFocus={(e) => e.target.select()}
              aria-label="Link lời mời"
              className={`${inputClassName} font-mono`}
            />
            <button type="button" onClick={() => void handleCopyLink()} className={secondaryButtonClassName}>
              {copied ? 'Đã copy' : 'Copy link'}
            </button>
          </div>
        </div>
      )}

      <h3 className="mt-6 mb-2 text-sm font-semibold text-slate-900">Lời mời đã tạo</h3>
      {invites.length === 0 ? (
        <p className="text-sm text-slate-600">Chưa có lời mời nào.</p>
      ) : (
        <ul className="space-y-2">
          {invites.map((invite) => {
            const status = inviteDisplayStatus(invite, nowMs)
            const confirming = confirmRevokeId === invite.id
            const revoking = revokingId === invite.id
            const canRevoke = status === 'pending'
            return (
              <li
                key={invite.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-900">{invite.invited_email}</p>
                  <p className="text-xs text-slate-500">
                    Tạo {formatDateTimeVi(invite.created_at)} · Hết hạn {formatDateTimeVi(invite.expires_at)}
                    {status === 'accepted' && invite.accepted_at && ` · Đã chấp nhận ${formatDateTimeVi(invite.accepted_at)}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
                      status === 'pending'
                        ? 'bg-amber-100 text-amber-800'
                        : status === 'accepted'
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {INVITE_STATUS_LABELS[status]}
                  </span>
                  {canRevoke &&
                    (confirming ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void handleRevoke(invite)}
                          disabled={revoking}
                          className={dangerOutlineButtonClassName}
                        >
                          {revoking ? 'Đang thu hồi…' : 'Thu hồi thật?'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRevokeId(null)}
                          disabled={revoking}
                          className={secondaryButtonClassName}
                        >
                          Giữ lại
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmRevokeId(invite.id)}
                        className={secondaryButtonClassName}
                      >
                        Thu hồi
                      </button>
                    ))}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <p className="mt-4 text-xs text-slate-500">
        Lưu ý: lời mời gắn với đúng một địa chỉ email và chỉ dùng được một lần. Hệ thống hiện chưa tự gửi
        email mời — bạn tự gửi link cho người được mời. Gỡ một phụ huynh đã tham gia khỏi gia đình thì chưa
        có giao diện, hãy liên hệ người vận hành nếu cần.
      </p>
    </Card>
  )
}
