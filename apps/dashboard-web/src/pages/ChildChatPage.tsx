import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { formatTimeVi } from '../lib/format'
import type { Message } from '../lib/types'

/**
 * Trang chat của con (/nhan-tin) — nằm NGOÀI RequireAuth (như trang
 * Hướng dẫn cài đặt / Chính sách riêng tư): con KHÔNG có tài khoản
 * SafePC. Quyền truy cập là TOKEN PHIÊN 12 giờ do Service trên máy
 * con mint bằng token thiết bị (RPC safepc_mint_chat_session,
 * migration 29) và mở trang này kèm token trong fragment của URL
 * (#t=...). Fragment không đi lên server/CDN log; trang đọc xong thì
 * lưu vào sessionStorage (chỉ sống trong tab này) và xóa khỏi URL.
 *
 * Trang này CHỈ gọi 3 RPC chat (fetch / send / mark_read) — không
 * truy vấn bất kỳ bảng nào khác, không cầm token thiết bị, không cầm
 * khóa đăng nhập nào. Token sai / hết hạn / bị phụ huynh thu hồi thì
 * RPC báo lỗi: trang xóa token và hiện hướng dẫn mở lại từ khay hệ
 * thống SafePC.
 */

const TOKEN_STORAGE_KEY = 'safepc_chat_token'
const POLL_INTERVAL_MS = 5000

type PageState = 'loading' | 'ready' | 'expired'

function readTokenFromHash(): string | null {
  const hash = window.location.hash
  if (!hash || hash.length < 2) return null
  const params = new URLSearchParams(hash.slice(1))
  const token = params.get('t')
  return token && token.trim() !== '' ? token.trim() : null
}

export default function ChildChatPage() {
  const [pageState, setPageState] = useState<PageState>('loading')
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  const tokenRef = useRef<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const expiredRef = useRef(false)

  const expireSession = useCallback(() => {
    if (expiredRef.current) return
    expiredRef.current = true
    tokenRef.current = null
    try {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY)
    } catch {
      // sessionStorage bị chặn (hiếm): vẫn hiện màn hình hết hạn.
    }
    setPageState('expired')
  }, [])

  const fetchMessages = useCallback(async () => {
    const token = tokenRef.current
    if (!supabase || !token || expiredRef.current) return
    const { data, error: rpcError } = await supabase.rpc('safepc_chat_fetch', {
      p_session_token: token,
    })
    if (rpcError) {
      // Chỉ lỗi invalid_session (token sai/hết hạn/bị thu hồi — server
      // gộp chung một lỗi) mới hết phiên. Lỗi khác (mất mạng chớp
      // nhoáng, server bận...) thì GIỮ nguyên danh sách hiện tại và
      // chờ nhịp poll sau thử lại, như handleSend đã làm — không đá
      // con ra khỏi phiên vì một lần fetch lỗi tạm thời.
      if (rpcError.message.includes('invalid_session')) {
        expireSession()
      }
      return
    }
    const rows = (Array.isArray(data) ? data : []) as Message[]
    setMessages(rows)
    setPageState('ready')
    // Có tin của bố mẹ chưa đọc thì đóng mốc con đã đọc ngay.
    const hasUnreadFromParent = rows.some(
      (m) => m.sender_role === 'parent' && m.child_read_at === null,
    )
    if (hasUnreadFromParent) {
      const { error: markError } = await supabase.rpc('safepc_chat_mark_read', {
        p_session_token: token,
      })
      if (markError && markError.message.includes('invalid_session')) {
        expireSession()
        return
      }
      if (!markError) {
        const nowIso = new Date().toISOString()
        setMessages((prev) =>
          prev.map((m) =>
            m.sender_role === 'parent' && m.child_read_at === null
              ? { ...m, child_read_at: nowIso }
              : m,
          ),
        )
      }
    }
  }, [expireSession])

  // Khởi tạo: ưu tiên token trong URL (Service vừa mở), không có thì
  // dùng token đã lưu trong tab (tải lại trang không mất phiên).
  useEffect(() => {
    const fromHash = readTokenFromHash()
    if (fromHash) {
      try {
        sessionStorage.setItem(TOKEN_STORAGE_KEY, fromHash)
      } catch {
        // Không lưu được thì vẫn dùng token trong bộ nhớ cho phiên này.
      }
      // Xóa token khỏi thanh địa chỉ để không bị chụp/lưu nhầm.
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
      tokenRef.current = fromHash
    } else {
      try {
        tokenRef.current = sessionStorage.getItem(TOKEN_STORAGE_KEY)
      } catch {
        tokenRef.current = null
      }
    }
    if (!supabase || !tokenRef.current) {
      setPageState('expired')
      return
    }
    void fetchMessages()
    const timer = setInterval(() => void fetchMessages(), POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [fetchMessages])

  // Luôn cuộn xuống tin mới nhất: trang chat của con đơn giản, không
  // có nhu cầu đọc lại dài như phía phụ huynh.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const handleSend = async () => {
    const token = tokenRef.current
    if (!supabase || !token || sending) return
    const body = draft.trim()
    if (body === '') return
    if (body.length > 2000) {
      setSendError('Tin nhắn dài quá 2000 ký tự, con rút gọn lại nhé.')
      return
    }
    setSending(true)
    setSendError(null)
    try {
      const { data, error: rpcError } = await supabase.rpc('safepc_chat_send', {
        p_session_token: token,
        p_body: body,
      })
      if (rpcError) {
        if (rpcError.message.includes('invalid_session')) {
          expireSession()
          return
        }
        throw rpcError
      }
      setDraft('')
      const sent = data as Message | null
      if (sent && typeof sent === 'object' && typeof sent.id === 'string') {
        setMessages((prev) => (prev.some((m) => m.id === sent.id) ? prev : [...prev, sent]))
      } else {
        void fetchMessages()
      }
    } catch {
      setSendError('Không gửi được tin nhắn, con thử lại nhé.')
    } finally {
      setSending(false)
    }
  }

  if (pageState === 'expired') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <img src="/icons/icon.svg" alt="Logo SafePC" className="mx-auto h-12 w-12" />
          <h1 className="mt-3 text-base font-semibold text-slate-900">Phiên nhắn tin đã hết hạn</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            Phiên nhắn tin đã hết hạn. Con mở lại từ khay hệ thống SafePC trên máy tính nhé.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <header className="border-b border-slate-200 bg-white px-4 py-3">
        <div className="mx-auto flex w-full max-w-2xl items-center gap-2">
          <img src="/icons/icon.svg" alt="Logo SafePC" className="h-8 w-8" />
          <h1 className="text-base font-semibold text-slate-900">Nhắn tin với bố mẹ</h1>
        </div>
      </header>
      <div ref={listRef} className="mx-auto w-full max-w-2xl flex-1 space-y-2 overflow-y-auto px-4 py-4">
        {pageState === 'loading' ? (
          <p className="py-10 text-center text-sm text-slate-500">Đang tải tin nhắn…</p>
        ) : messages.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-500">
            Chưa có tin nhắn nào. Con nhắn cho bố mẹ ở ô dưới nhé.
          </p>
        ) : (
          messages.map((m) => {
            const fromChild = m.sender_role === 'child'
            return (
              <div key={m.id} className={`flex ${fromChild ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
                    fromChild
                      ? 'rounded-br-sm bg-indigo-600 text-white'
                      : 'rounded-bl-sm border border-slate-200 bg-white text-slate-800'
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                  <p
                    className={`mt-1 text-right text-[11px] ${
                      fromChild ? 'text-indigo-200' : 'text-slate-400'
                    }`}
                  >
                    {formatTimeVi(m.created_at)}
                  </p>
                </div>
              </div>
            )
          })
        )}
      </div>
      <div className="border-t border-slate-200 bg-white px-4 py-3">
        <div className="mx-auto w-full max-w-2xl">
          {sendError && (
            <p className="mb-2 text-sm text-red-600" role="alert">
              {sendError}
            </p>
          )}
          <div className="flex items-end gap-2">
            <label htmlFor="chat-child-input" className="sr-only">
              Nội dung tin nhắn
            </label>
            <textarea
              id="chat-child-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void handleSend()
                }
              }}
              rows={2}
              maxLength={2000}
              placeholder="Nhắn cho bố mẹ…"
              className="min-h-[44px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            />
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={sending || draft.trim() === ''}
              className="inline-flex min-h-[44px] items-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
            >
              {sending ? 'Đang gửi…' : 'Gửi'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
