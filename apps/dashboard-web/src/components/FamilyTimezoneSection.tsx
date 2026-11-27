import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { getMyFamily } from '../lib/family'
import type { Family } from '../lib/types'
import { isMissingColumnError, toVietnameseError } from '../lib/format'
import {
  AlertBox,
  Card,
  Field,
  LoadingState,
  MigrationMissingState,
  inputClassName,
  primaryButtonClassName,
} from '../components/ui'

type LoadState = 'loading' | 'ready' | 'error'

/** Múi giờ mặc định khi gia đình chưa đặt (khớp DEFAULT của cột families.timezone, migration 31). */
export const DEFAULT_FAMILY_TIMEZONE = 'Asia/Ho_Chi_Minh'

/**
 * Các múi giờ cho phụ huynh chọn: Việt Nam lên đầu (mặc định), thêm
 * các múi giờ phổ biến để gia đình ở nước ngoài vẫn đặt đúng. Giá trị
 * là tên IANA — Agent tra cứu bằng TimeZoneInfo phía máy con.
 */
const TIMEZONE_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'Asia/Ho_Chi_Minh', label: 'Việt Nam (Asia/Ho_Chi_Minh)' },
  { id: 'Asia/Bangkok', label: 'Thái Lan (Asia/Bangkok)' },
  { id: 'Asia/Singapore', label: 'Singapore (Asia/Singapore)' },
  { id: 'Asia/Tokyo', label: 'Nhật Bản (Asia/Tokyo)' },
  { id: 'Asia/Seoul', label: 'Hàn Quốc (Asia/Seoul)' },
  { id: 'Asia/Shanghai', label: 'Trung Quốc (Asia/Shanghai)' },
  { id: 'Asia/Kolkata', label: 'Ấn Độ (Asia/Kolkata)' },
  { id: 'Europe/London', label: 'Anh (Europe/London)' },
  { id: 'Europe/Paris', label: 'Pháp / Đức (Europe/Paris)' },
  { id: 'America/New_York', label: 'Mỹ — Bờ Đông (America/New_York)' },
  { id: 'America/Chicago', label: 'Mỹ — Trung tâm (America/Chicago)' },
  { id: 'America/Denver', label: 'Mỹ — Miền núi (America/Denver)' },
  { id: 'America/Los_Angeles', label: 'Mỹ — Bờ Tây (America/Los_Angeles)' },
  { id: 'Australia/Sydney', label: 'Úc — Sydney (Australia/Sydney)' },
  { id: 'UTC', label: 'UTC' },
]

/**
 * Mục "Múi giờ gia đình" trên trang Hồ sơ (migration 31, PRD §2.14 —
 * giờ tin cậy). Mọi luật theo giờ (giờ ngủ, khung giờ, giới hạn ngày,
 * giờ tập trung, nghỉ bắt buộc) được Agent thi hành bằng GIỜ SERVER
 * đã đồng bộ, quy đổi sang múi giờ này — con chỉnh giờ hệ thống hay
 * đổi múi giờ trên máy cũng không lách được luật.
 *
 * Truy vấn cột timezone là best-effort RIÊNG của mục này (không đưa
 * vào các truy vấn family dùng chung ở lib/family.ts): chưa áp dụng
 * migration 31 thì cột chưa có, mục hiện trạng thái "cần migration"
 * thay vì làm lỗi các phần khác của trang. Người chưa có gia đình
 * thì không thấy gì (như FamilyInviteSection).
 */
export default function FamilyTimezoneSection() {
  const { user } = useAuth()
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [missingMigration, setMissingMigration] = useState(false)
  const [family, setFamily] = useState<Family | null>(null)
  const [current, setCurrent] = useState(DEFAULT_FAMILY_TIMEZONE)
  const [draft, setDraft] = useState(DEFAULT_FAMILY_TIMEZONE)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const loadSeqRef = useRef(0)

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
      if (!myFamily) {
        setState('ready')
        return
      }
      const tzResult = await supabase
        .from('families')
        .select('timezone')
        .eq('id', myFamily.id)
        .maybeSingle()
      if (seq !== loadSeqRef.current) return
      if (tzResult.error) {
        if (isMissingColumnError(tzResult.error, 'timezone')) {
          setMissingMigration(true)
          setState('ready')
          return
        }
        throw tzResult.error
      }
      const tz =
        (tzResult.data as { timezone?: string } | null)?.timezone ?? DEFAULT_FAMILY_TIMEZONE
      setCurrent(tz)
      setDraft(tz)
      setState('ready')
    } catch (err) {
      if (seq !== loadSeqRef.current) return
      setError(toVietnameseError(err))
      setState('error')
    }
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  const handleSave = async () => {
    if (!supabase || !family || draft === current) return
    setBusy(true)
    setMessage(null)
    setActionError(null)
    try {
      // Phải .select() để biết có dòng nào thật sự được cập nhật
      // không: policy bảng families (migration 1) chỉ cho OWNER ghi,
      // thành viên khác bị RLS lọc lặng lẽ thành 0 dòng mà không lỗi
      // — thiếu bước này giao diện sẽ báo "Đã lưu" giả.
      const { data: updated, error: updateError } = await supabase
        .from('families')
        .update({ timezone: draft })
        .eq('id', family.id)
        .select('timezone')
      if (updateError) throw updateError
      if (!updated || updated.length === 0) {
        setActionError('Không lưu được — chỉ chủ gia đình mới đổi được múi giờ.')
        return
      }
      setCurrent(draft)
      setMessage(
        'Đã lưu múi giờ gia đình. Máy của con sẽ áp dụng ở lần đồng bộ tiếp theo (khoảng 1 phút).',
      )
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setBusy(false)
    }
  }

  if (state === 'loading') {
    return (
      <Card title="Múi giờ gia đình">
        <LoadingState label="Đang tải cài đặt múi giờ..." />
      </Card>
    )
  }

  if (!family) return null

  if (missingMigration) {
    return (
      <MigrationMissingState
        title="Chưa áp dụng migration 31"
        detail="Cột múi giờ gia đình (families.timezone) chưa có trên máy chủ. Sau khi áp dụng migration 31, mục này sẽ cho phép đặt múi giờ thi hành luật cho cả gia đình. Trước lúc đó Agent dùng mặc định Asia/Ho_Chi_Minh."
        file="backend/supabase/migrations/20261127210000_trusted_time_rule_observations.sql"
        onRetry={() => void load()}
      />
    )
  }

  if (state === 'error') {
    return (
      <Card title="Múi giờ gia đình">
        <AlertBox tone="error">{error}</AlertBox>
      </Card>
    )
  }

  // Giữ giá trị hiện tại trong danh sách chọn kể cả khi nó không nằm
  // trong danh sách gợi ý (gia đình đã đặt múi giờ khác từ trước).
  const options = TIMEZONE_OPTIONS.some((option) => option.id === current)
    ? TIMEZONE_OPTIONS
    : [{ id: current, label: current }, ...TIMEZONE_OPTIONS]

  // Chỉ chủ gia đình (families.owner_id) mới ghi được cột timezone
  // theo policy migration 1; thành viên khác chỉ xem.
  const isOwner = user != null && family.owner_id === user.id

  return (
    <Card title="Múi giờ gia đình">
      <p className="mb-4 text-sm text-slate-600">
        Mọi luật theo giờ (giờ ngủ, khung giờ được dùng máy, giới hạn mỗi ngày, giờ tập
        trung, nghỉ bắt buộc) được thi hành bằng giờ máy chủ đã đồng bộ, quy đổi sang múi
        giờ này. Con chỉnh giờ hệ thống hay đổi múi giờ trên máy cũng không lách được
        luật; nếu đồng hồ máy lệch quá 2 phút so với giờ tin cậy, trang Thiết bị sẽ hiện
        cảnh báo.
      </p>
      {!isOwner ? (
        <p className="mb-4 text-sm text-slate-500">
          Chỉ chủ gia đình đổi được múi giờ này.
        </p>
      ) : null}
      <Field label="Múi giờ thi hành luật" htmlFor="family-timezone">
        <select
          id="family-timezone"
          className={inputClassName}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={busy || !isOwner}
        >
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
      {message ? (
        <AlertBox tone="success" className="mt-3">
          {message}
        </AlertBox>
      ) : null}
      {actionError ? (
        <AlertBox tone="error" className="mt-3">
          {actionError}
        </AlertBox>
      ) : null}
      <div className="mt-4">
        <button
          type="button"
          className={primaryButtonClassName}
          onClick={() => void handleSave()}
          disabled={busy || !isOwner || draft === current}
        >
          {busy ? 'Đang lưu...' : 'Lưu múi giờ'}
        </button>
      </div>
    </Card>
  )
}
