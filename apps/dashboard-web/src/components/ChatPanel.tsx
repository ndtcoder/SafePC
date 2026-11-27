import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { formatTimeVi, isMissingTableError, toVietnameseError } from '../lib/format'
import type { Message } from '../lib/types'
import {
  AlertBox,
  Card,
  ErrorState,
  LoadingState,
  MigrationMissingState,
  primaryButtonClassName,
} from './ui'

/**
 * Tab Nhắn tin trong hồ sơ con (PRD §2.13, migration 29): kênh nhắn
 * tin hai chiều CHỈ trong gia đình, để con khỏi dùng ứng dụng nhắn
 * tin bên ngoài gây xao lãng.
 *
 * - Phụ huynh (đã đăng nhập) đọc/gửi qua RLS trên bảng messages:
 *   gửi = insert sender_role 'parent' + sender_user_id của chính
 *   mình (policy "parent send" kiểm tra đúng điều này ở server).
 * - Con nhắn từ trang /nhan-tin trên máy của con bằng token phiên —
 *   phía con không qua component này.
 * - Polling 5 giây (nhịp chung của các màn hình gần-thời-gian-thực
 *   trong app). Mở tab hoặc thấy tin mới của con chưa đọc thì gọi
 *   RPC safepc_parent_mark_read để đóng mốc phụ huynh đã đọc.
 * - Trạng thái dưới tin phụ huynh gửi gần nhất: "Đã xem" khi con đã
 *   đọc (child_read_at), "Đã gửi" khi chưa — chỉ hiện ở tin gần nhất
 *   cho gọn, như các ứng dụng chat phổ biến.
 */

const POLL_INTERVAL_MS = 5000
const MAX_MESSAGES = 200
const MESSAGE_COLUMNS =
  'id, family_id, child_id, device_id, sender_role, sender_user_id, body, parent_read_at, child_read_at, created_at'

type LoadState = 'loading' | 'ready' | 'error'

export default function ChatPanel({
  childId,
  childName,
  familyId,
}: {
  childId: string
  childName: string
  familyId: string
}) {
  const { user } = useAuth()
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [loadError, setLoadError] = useState('')
  const [migrationMissing, setMigrationMissing] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  const listRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const markingReadRef = useRef(false)

  const markChildMessagesRead = useCallback(
    async (current: Message[]) => {
      if (!supabase || markingReadRef.current) return
      const hasUnread = current.some((m) => m.sender_role === 'child' && m.parent_read_at === null)
      if (!hasUnread) return
      markingReadRef.current = true
      try {
        const { error: rpcError } = await supabase.rpc('safepc_parent_mark_read', {
          p_child_id: childId,
        })
        if (rpcError) throw rpcError
        const nowIso = new Date().toISOString()
        setMessages((prev) =>
          prev.map((m) =>
            m.sender_role === 'child' && m.parent_read_at === null
              ? { ...m, parent_read_at: nowIso }
              : m,
          ),
        )
      } catch {
        // Đánh dấu đã đọc lỗi (vd RPC chưa có vì migration 29 chưa áp)
        // không được làm hỏng việc đọc/gửi tin — lần poll sau thử lại.
      } finally {
        markingReadRef.current = false
      }
    },
    [childId],
  )

  const load = useCallback(
    async (initial: boolean) => {
      if (!supabase || !user) {
        if (initial) setLoadState('ready')
        return
      }
      try {
        // Lấy MAX_MESSAGES tin gần nhất (mới nhất trước) rồi đảo lại
        // thành thứ tự cũ → mới để hiển thị kiểu chat.
        const { data, error: queryError } = await supabase
          .from('messages')
          .select(MESSAGE_COLUMNS)
          .eq('child_id', childId)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(MAX_MESSAGES)
        if (queryError) throw queryError
        const rows = ((data ?? []) as Message[]).slice().reverse()
        setMessages(rows)
        setMigrationMissing(false)
        setLoadState('ready')
        void markChildMessagesRead(rows)
      } catch (err) {
        if (isMissingTableError(err, 'messages')) {
          setMigrationMissing(true)
          setLoadState('ready')
          return
        }
        // Poll lỗi tạm thời thì giữ nguyên danh sách đang có, chỉ lần
        // tải đầu mới hiện màn hình lỗi.
        if (initial) {
          setLoadError(toVietnameseError(err))
          setLoadState('error')
        }
      }
    },
    [user, childId, markChildMessagesRead],
  )

  useEffect(() => {
    void load(true)
    const timer = setInterval(() => void load(false), POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [load])

  // Tự cuộn xuống tin mới nhất khi đang ở gần đáy (phụ huynh chủ động
  // cuộn lên đọc tin cũ thì không giật xuống).
  useEffect(() => {
    const el = listRef.current
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  const handleSend = async () => {
    if (!supabase || !user || sending) return
    const body = draft.trim()
    if (body === '') return
    if (body.length > 2000) {
      setSendError('Tin nhắn dài quá 2000 ký tự. Hãy rút gọn lại giúp em.')
      return
    }
    setSending(true)
    setSendError(null)
    try {
      const { error: insertError } = await supabase.from('messages').insert({
        family_id: familyId,
        child_id: childId,
        sender_role: 'parent',
        sender_user_id: user.id,
        body,
      })
      if (insertError) throw insertError
      setDraft('')
      stickToBottomRef.current = true
      await load(false)
    } catch (err) {
      setSendError(toVietnameseError(err))
    } finally {
      setSending(false)
    }
  }

  if (migrationMissing) {
    return (
      <MigrationMissingState
        title="Chưa bật được nhắn tin"
        detail="migration 29 (bảng messages + chat_sessions và các RPC nhắn tin trong gia đình)"
        file="20261127160000_family_messaging.sql"
        onRetry={() => void load(true)}
      />
    )
  }

  if (loadState === 'loading') return <LoadingState label="Đang tải tin nhắn…" />
  if (loadState === 'error') {
    return <ErrorState message={loadError} onRetry={() => void load(true)} />
  }

  const lastParentMessage = [...messages].reverse().find((m) => m.sender_role === 'parent')

  return (
    <Card title={`Nhắn tin với ${childName}`}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          Kênh nhắn tin riêng trong gia đình: {childName} mở nhắn tin từ khay hệ thống SafePC trên
          máy tính, không cần dùng ứng dụng nhắn tin bên ngoài. Tin nhắn chỉ hai phía trong gia
          đình thấy được.
        </p>
        <div
          ref={listRef}
          onScroll={() => {
            const el = listRef.current
            if (el) {
              stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
            }
          }}
          className="h-96 space-y-2 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-3"
          aria-live="polite"
        >
          {messages.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-500">
              Chưa có tin nhắn nào. Hãy gửi tin đầu tiên cho {childName} nhé.
            </p>
          ) : (
            messages.map((m) => {
              const fromParent = m.sender_role === 'parent'
              return (
                <div key={m.id} className={`flex ${fromParent ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
                      fromParent
                        ? 'rounded-br-sm bg-indigo-600 text-white'
                        : 'rounded-bl-sm border border-slate-200 bg-white text-slate-800'
                    }`}
                  >
                    <p className="whitespace-pre-wrap break-words">{m.body}</p>
                    <p
                      className={`mt-1 text-right text-[11px] ${
                        fromParent ? 'text-indigo-200' : 'text-slate-400'
                      }`}
                    >
                      {formatTimeVi(m.created_at)}
                      {fromParent && lastParentMessage?.id === m.id
                        ? m.child_read_at
                          ? ' · Đã xem'
                          : ' · Đã gửi'
                        : ''}
                    </p>
                  </div>
                </div>
              )
            })
          )}
        </div>
        {sendError && <AlertBox tone="error">{sendError}</AlertBox>}
        <div className="flex items-end gap-2">
          <label htmlFor="chat-parent-input" className="sr-only">
            Nội dung tin nhắn
          </label>
          <textarea
            id="chat-parent-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter gửi, Shift+Enter xuống dòng. Đang gõ dấu tiếng
              // Việt (IME composition) thì Enter là để chốt dấu, không
              // gửi — nativeEvent.isComposing là dấu hiệu chuẩn.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void handleSend()
              }
            }}
            rows={2}
            maxLength={2000}
            placeholder={`Nhắn cho ${childName}…`}
            className="min-h-[44px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={sending || draft.trim() === ''}
            className={primaryButtonClassName}
          >
            {sending ? 'Đang gửi…' : 'Gửi'}
          </button>
        </div>
      </div>
    </Card>
  )
}
