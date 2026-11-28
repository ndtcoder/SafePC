import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import type { ChildScreenSettings, DriveConnectionStatus, ScreenshotMetadata } from '../lib/types'
import { formatDateTimeVi, formatTimeVi, isMissingTableError, toVietnameseError } from '../lib/format'
import {
  SCREEN_INTERVAL_OPTIONS,
  SCREEN_RETENTION_OPTIONS,
  driveErrorReasonLabel,
  estimateStorage,
  formatGb,
  formatSizeKb,
} from '../lib/screenCapture'
import {
  AlertBox,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  MigrationMissingState,
  NotConfiguredState,
  checkboxClassName,
  chipClassName,
  dangerOutlineButtonClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
} from '../components/ui'

type LoadState = 'loading' | 'ready' | 'error'

/** Số ảnh tải mỗi trang trong danh sách theo ngày. */
const SHOTS_PAGE_SIZE = 60

/** sessionStorage: đánh dấu "vừa bấm kết nối Drive, đang chờ quay về". */
const DRIVE_PENDING_KEY = 'safepc_drive_connect_pending'

interface DriveReturnNotice {
  tone: 'success' | 'error'
  text: string
}

/** Đọc tham số ?drive=... lúc mount (Edge Function chuyển hướng về sau OAuth). */
function readDriveReturnNotice(): DriveReturnNotice | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const drive = params.get('drive')
  if (drive === 'connected') {
    return { tone: 'success', text: 'Đã kết nối Google Drive. Ảnh chụp màn hình sẽ được lưu vào Drive của bạn.' }
  }
  if (drive === 'error') {
    return { tone: 'error', text: driveErrorReasonLabel(params.get('reason')) }
  }
  return null
}

/**
 * Tab Chụp màn hình trong hồ sơ của một con (migration 32, PRD
 * §2.16): phụ huynh bật/tắt chụp màn hình định kỳ cho con, chọn mức
 * chụp + hạn giữ, kết nối Google Drive RIÊNG của phụ huynh để lưu
 * ảnh, và xem danh mục ảnh đã chụp theo ngày.
 *
 * Mô hình đã chốt (anh Tiến, 28/11/2026): phụ huynh quyết định cứng
 * bật/tắt — KHÔNG có bước đồng ý của con. Minh bạch với con bằng
 * THÔNG BÁO HÀNG TUẦN trên máy con (Tray hiện thông báo rằng màn
 * hình đang được chụp; thông báo không nêu tần suất). Ảnh lưu trên
 * Drive của phụ huynh với scope drive.file (app chỉ thấy file nó
 * tạo); SafePC không thu tiền — muốn giữ lâu/dung lượng lớn hơn thì
 * phụ huynh tự nâng Google One của mình.
 *
 * Ghi cài đặt qua bảng child_screen_settings theo RLS (chỉ role
 * 'parent' ghi được); trạng thái Drive đọc qua RPC
 * safepc_get_drive_connection (không bao giờ kèm token); ngắt kết
 * nối qua RPC safepc_disconnect_drive. Chưa áp migration 32 thì
 * hiện MigrationMissingState thay vì lỗi thô.
 */
export default function ScreenCaptureTab({
  childId,
  childName,
  familyId,
}: {
  childId: string
  childName: string
  familyId: string
}) {
  const { configured, user } = useAuth()
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [missingMigration, setMissingMigration] = useState(false)

  const [saved, setSaved] = useState<ChildScreenSettings | null>(null)
  const [draftEnabled, setDraftEnabled] = useState(false)
  const [draftInterval, setDraftInterval] = useState<number>(5)
  const [draftRetention, setDraftRetention] = useState<number>(14)
  const [ackPrivate, setAckPrivate] = useState(false)
  const [ackResponsible, setAckResponsible] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  const [drive, setDrive] = useState<DriveConnectionStatus | null>(null)
  const [driveNotConfigured, setDriveNotConfigured] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [driveMessage, setDriveMessage] = useState<string | null>(null)
  const [driveError, setDriveError] = useState<string | null>(null)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [returnNotice, setReturnNotice] = useState<DriveReturnNotice | null>(() => readDriveReturnNotice())

  const [shots, setShots] = useState<ScreenshotMetadata[]>([])
  const [shotsHasMore, setShotsHasMore] = useState(false)
  const [loadingMoreShots, setLoadingMoreShots] = useState(false)

  const loadSeqRef = useRef(0)

  const loadShots = useCallback(
    async (client: NonNullable<typeof supabase>, offset: number): Promise<ScreenshotMetadata[]> => {
      const { data, error: shotsError } = await client
        .from('screenshot_metadata')
        .select('id, family_id, child_id, device_id, captured_at, day, drive_file_id, size_bytes, width, height, created_at')
        .eq('child_id', childId)
        .order('captured_at', { ascending: false })
        .range(offset, offset + SHOTS_PAGE_SIZE) // thừa 1 hàng để biết còn trang sau
      if (shotsError) throw shotsError
      return (data ?? []) as ScreenshotMetadata[]
    },
    [childId],
  )

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
      const client = supabase
      const [settingsResult, driveResult] = await Promise.all([
        client
          .from('child_screen_settings')
          .select('child_id, family_id, enabled, interval_minutes, retention_days, updated_by, updated_at')
          .eq('child_id', childId)
          .maybeSingle(),
        client.rpc('safepc_get_drive_connection'),
      ])
      if (seq !== loadSeqRef.current) return
      if (settingsResult.error) throw settingsResult.error
      if (driveResult.error) throw driveResult.error
      const settings = (settingsResult.data ?? null) as ChildScreenSettings | null
      setSaved(settings)
      setDraftEnabled(settings?.enabled ?? false)
      setDraftInterval(settings?.interval_minutes ?? 5)
      setDraftRetention(settings?.retention_days ?? 14)
      setDrive((driveResult.data ?? null) as DriveConnectionStatus | null)

      const firstPage = await loadShots(client, 0)
      if (seq !== loadSeqRef.current) return
      setShotsHasMore(firstPage.length > SHOTS_PAGE_SIZE)
      setShots(firstPage.slice(0, SHOTS_PAGE_SIZE))
      setState('ready')

      // Quay về từ Google mà tham số ?drive= không còn trên URL (đã
      // điều hướng trong app): nếu trước đó phụ huynh vừa bấm kết
      // nối và giờ Drive đã hiện "đã kết nối" thì báo thành công.
      if (!readDriveReturnNotice() && sessionStorage.getItem(DRIVE_PENDING_KEY) === '1') {
        sessionStorage.removeItem(DRIVE_PENDING_KEY)
        const status = (driveResult.data ?? null) as DriveConnectionStatus | null
        if (status?.connected) {
          setReturnNotice({
            tone: 'success',
            text: 'Đã kết nối Google Drive. Ảnh chụp màn hình sẽ được lưu vào Drive của bạn.',
          })
        }
      }
    } catch (err) {
      if (seq !== loadSeqRef.current) return
      const message = err instanceof Error ? err.message : String(err)
      if (
        message.includes('child_screen_settings') ||
        message.includes('screenshot_metadata') ||
        message.includes('safepc_get_drive_connection') ||
        isMissingTableError(err, 'child_screen_settings')
      ) {
        setMissingMigration(true)
        setState('ready')
        return
      }
      setError(toVietnameseError(err))
      setState('error')
    }
  }, [user, childId, loadShots])

  useEffect(() => {
    void load()
  }, [load])

  const handleLoadMoreShots = async () => {
    if (!supabase || loadingMoreShots) return
    setLoadingMoreShots(true)
    try {
      const next = await loadShots(supabase, shots.length)
      setShotsHasMore(next.length > SHOTS_PAGE_SIZE)
      setShots((prev) => [...prev, ...next.slice(0, SHOTS_PAGE_SIZE)])
    } catch (err) {
      setSaveError(toVietnameseError(err))
    } finally {
      setLoadingMoreShots(false)
    }
  }

  // Bật từ trạng thái đang tắt = quyết định nhạy cảm: bắt buộc phụ
  // huynh tích đủ hai ô xác nhận hiểu trước khi nút Lưu bật được.
  const turningOn = draftEnabled && !(saved?.enabled ?? false)
  const ackComplete = ackPrivate && ackResponsible
  const settingsDirty =
    draftEnabled !== (saved?.enabled ?? false) ||
    draftInterval !== (saved?.interval_minutes ?? 5) ||
    draftRetention !== (saved?.retention_days ?? 14)

  const handleSave = async () => {
    if (!supabase || !user) return
    if (turningOn && !ackComplete) return
    setSaving(true)
    setSaveMessage(null)
    setSaveError(null)
    try {
      // .select() để biết có dòng nào thật sự được ghi không: RLS chỉ
      // cho role 'parent' ghi — thành viên không phải phụ huynh bị
      // lọc lặng lẽ thành 0 dòng, thiếu bước này sẽ báo "Đã lưu" giả.
      const { data: written, error: writeError } = await supabase
        .from('child_screen_settings')
        .upsert(
          {
            child_id: childId,
            family_id: familyId,
            enabled: draftEnabled,
            interval_minutes: draftInterval,
            retention_days: draftRetention,
            updated_by: user.id,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'child_id' },
        )
        .select('child_id, family_id, enabled, interval_minutes, retention_days, updated_by, updated_at')
      if (writeError) throw writeError
      if (!written || written.length === 0) {
        setSaveError('Không lưu được — chỉ phụ huynh mới bật/tắt được tính năng này.')
        return
      }
      const row = written[0] as ChildScreenSettings
      setSaved(row)
      setAckPrivate(false)
      setAckResponsible(false)
      setSaveMessage(
        row.enabled
          ? `Đã bật chụp màn hình cho ${childName} (mỗi ${row.interval_minutes} phút, giữ ${row.retention_days} ngày). Máy của con sẽ áp dụng ở lần đồng bộ tiếp theo khi máy online và Drive đã kết nối.`
          : `Đã tắt chụp màn hình cho ${childName}. Máy của con sẽ dừng chụp ở lần đồng bộ tiếp theo.`,
      )
    } catch (err) {
      setSaveError(toVietnameseError(err))
    } finally {
      setSaving(false)
    }
  }

  const handleConnectDrive = async () => {
    if (!supabase) return
    setConnecting(true)
    setDriveError(null)
    setDriveMessage(null)
    setDriveNotConfigured(false)
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('connect-google-drive', {
        body: { action: 'start' },
      })
      if (invokeError) throw invokeError
      const result = (data ?? null) as { url?: string; error?: string } | null
      if (result?.error === 'not_configured') {
        setDriveNotConfigured(true)
        return
      }
      if (result?.url) {
        // Đánh dấu để khi quay về (kể cả khi tham số URL bị mất lúc
        // điều hướng trong app) tab vẫn báo được kết quả kết nối.
        sessionStorage.setItem(DRIVE_PENDING_KEY, '1')
        window.location.href = result.url
        return
      }
      setDriveError('Máy chủ chưa trả về link kết nối Google. Vui lòng thử lại.')
    } catch (err) {
      setDriveError(toVietnameseError(err))
    } finally {
      setConnecting(false)
    }
  }

  const handleDisconnectDrive = async () => {
    if (!supabase) return
    setDisconnecting(true)
    setDriveError(null)
    setDriveMessage(null)
    try {
      const { error: rpcError } = await supabase.rpc('safepc_disconnect_drive')
      if (rpcError) throw rpcError
      setConfirmDisconnect(false)
      setDriveMessage(
        'Đã ngắt kết nối Google Drive cho cả gia đình. Ảnh đã lưu trên Drive của bạn không bị xóa; chụp màn hình sẽ dừng cho tới khi kết nối lại.',
      )
      await load()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('safepc_disconnect_drive')) {
        setMissingMigration(true)
      } else {
        setDriveError(toVietnameseError(err))
      }
    } finally {
      setDisconnecting(false)
    }
  }

  if (!configured) {
    return <NotConfiguredState />
  }

  if (missingMigration) {
    return (
      <MigrationMissingState
        title="Chụp màn hình chưa sẵn sàng"
        detail="migration 32 (bảng cài đặt chụp màn hình, danh mục ảnh và trạng thái kết nối Drive)"
        file="20261128120000_screen_capture.sql"
        onRetry={() => void load()}
      />
    )
  }

  if (state === 'loading') {
    return <LoadingState label="Đang tải cài đặt chụp màn hình…" />
  }

  if (state === 'error') {
    return <ErrorState message={error} onRetry={() => void load()} />
  }

  const estimate = estimateStorage(draftInterval, draftRetention)
  const driveConnected = drive?.connected === true
  const driveRevoked = !driveConnected && drive?.revoked === true

  // Nhóm ảnh theo ngày (day đã là ngày theo giờ gia đình), mới nhất trước.
  const shotsByDay = new Map<string, ScreenshotMetadata[]>()
  for (const shot of shots) {
    const list = shotsByDay.get(shot.day) ?? []
    list.push(shot)
    shotsByDay.set(shot.day, list)
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      {returnNotice && (
        <AlertBox tone={returnNotice.tone}>
          {returnNotice.text}
        </AlertBox>
      )}

      <Card title="Chụp màn hình định kỳ là gì?">
        <div className="space-y-2 text-sm leading-relaxed text-slate-700">
          <p>
            Khi bật, SafePC chụp <strong>toàn bộ màn hình chính</strong> của máy {childName} đang dùng, theo
            mức thời gian bạn chọn bên dưới. Máy đang khóa hoặc đang tắt thì không chụp.
          </p>
          <p>
            Ảnh được lưu vào <strong>Google Drive riêng của chính bạn</strong> — SafePC chỉ nhìn thấy các file
            do chính SafePC tạo ra trong Drive của bạn (quyền truy cập drive.file), không đọc được tài liệu
            khác của bạn. Ảnh không đi qua máy chủ SafePC; SafePC chỉ giữ danh mục thời điểm chụp để hiện
            danh sách ở trang này.
          </p>
          <p>
            <strong>Ai xem được:</strong> các phụ huynh trong gia đình có quyền xem hồ sơ của {childName}.{' '}
            <strong>Cách dừng:</strong> tắt công tắc bên dưới là dừng hẳn — máy của con ngừng chụp từ lần đồng
            bộ tiếp theo.
          </p>
          <p>
            <strong>Minh bạch với con:</strong> khi tính năng đang bật, máy của con hiện{' '}
            <strong>thông báo hàng tuần</strong> cho con biết màn hình đang được chụp và bố mẹ có quyền xem
            ảnh. Thông báo không nêu tần suất chụp.
          </p>
          <p>
            <strong>Chi phí:</strong> SafePC không thu tiền cho tính năng này. Ảnh nằm trong dung lượng Drive
            của bạn (tài khoản Google miễn phí có 15 GB dùng chung với Gmail/Photos). Muốn giữ lâu hơn hoặc
            chụp dày hơn mức dung lượng miễn phí cho phép, bạn tự nâng cấp gói Google One cho tài khoản của
            mình nếu cần.
          </p>
        </div>
      </Card>

      <Card title="Kết nối Google Drive của gia đình">
        <div className="space-y-3">
          {driveNotConfigured ? (
            <AlertBox tone="warning">
              Tính năng kết nối Google Drive <strong>chưa được cấu hình</strong> trên máy chủ SafePC (thiếu
              thông tin OAuth). Vui lòng liên hệ người quản trị SafePC để hoàn tất cấu hình rồi thử lại.
            </AlertBox>
          ) : driveConnected ? (
            <p className="text-sm text-slate-700">
              Đã kết nối Google Drive
              {drive?.google_email ? (
                <>
                  {' '}
                  với tài khoản <strong>{drive.google_email}</strong>
                </>
              ) : null}
              {drive?.connected_at ? <> từ {formatDateTimeVi(drive.connected_at)}</> : null}. Kết nối này dùng
              chung cho cả gia đình (mọi hồ sơ con đều lưu vào Drive này, mỗi con một thư mục riêng).
            </p>
          ) : driveRevoked ? (
            <AlertBox tone="warning">
              Drive <strong>đã mất kết nối</strong> (quyền truy cập đã bị thu hồi hoặc hết hiệu lực) — ảnh mới
              không tải lên được. Bấm “Kết nối lại Google Drive” để cấp quyền lại.
            </AlertBox>
          ) : (
            <p className="text-sm text-slate-700">
              Chưa kết nối Google Drive. Hãy kết nối Drive của bạn trước khi bật chụp — chưa có Drive thì máy
              của con không có nơi để lưu ảnh.
            </p>
          )}
          {driveMessage && <AlertBox tone="success">{driveMessage}</AlertBox>}
          {driveError && <AlertBox tone="error">{driveError}</AlertBox>}
          <div className="flex flex-wrap gap-2">
            {!driveConnected && (
              <button
                type="button"
                onClick={() => void handleConnectDrive()}
                disabled={connecting}
                className={primaryButtonClassName}
              >
                {connecting ? 'Đang mở Google…' : driveRevoked ? 'Kết nối lại Google Drive' : 'Kết nối Google Drive'}
              </button>
            )}
            {(driveConnected || driveRevoked) &&
              (confirmDisconnect ? (
                <>
                  <button
                    type="button"
                    onClick={() => void handleDisconnectDrive()}
                    disabled={disconnecting}
                    className={dangerOutlineButtonClassName}
                  >
                    {disconnecting ? 'Đang ngắt…' : 'Chắc chắn ngắt kết nối'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDisconnect(false)}
                    disabled={disconnecting}
                    className={secondaryButtonClassName}
                  >
                    Hủy
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDisconnect(true)}
                  className={secondaryButtonClassName}
                >
                  Ngắt kết nối
                </button>
              ))}
          </div>
          {confirmDisconnect && (
            <p className="text-sm text-amber-700">
              Ngắt kết nối sẽ xóa quyền lưu ảnh của SafePC cho <strong>cả gia đình</strong> và dừng chụp trên
              mọi máy cho tới khi kết nối lại. Ảnh đã lưu trên Drive của bạn vẫn còn nguyên — bạn tự quản lý
              hoặc xóa chúng trong Google Drive.
            </p>
          )}
        </div>
      </Card>

      <Card title={`Cài đặt chụp màn hình cho ${childName}`}>
        <div className="space-y-4">
          <label className="flex min-h-[44px] cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={draftEnabled}
              onChange={(e) => setDraftEnabled(e.target.checked)}
              className={checkboxClassName}
            />
            <span className="text-sm font-medium text-slate-800">
              {draftEnabled ? 'Đang bật chụp màn hình' : 'Bật chụp màn hình cho con này'}
            </span>
          </label>

          <div>
            <span className="mb-1 block text-sm font-medium text-slate-700">Mức chụp</span>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Mức chụp">
              {SCREEN_INTERVAL_OPTIONS.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setDraftInterval(value)}
                  aria-pressed={draftInterval === value}
                  className={chipClassName(draftInterval === value)}
                >
                  {value} phút
                </button>
              ))}
            </div>
            {draftInterval === 1 && (
              <p className="mt-2 text-sm text-amber-700">
                Mức 1 phút là mức dày nhất: ảnh chụp gần như liên tục khi con dùng máy và tốn dung lượng
                nhanh nhất. Chỉ chọn khi bạn thật sự cần.
              </p>
            )}
          </div>

          <div>
            <span className="mb-1 block text-sm font-medium text-slate-700">Giữ ảnh trong</span>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Hạn giữ ảnh">
              {SCREEN_RETENTION_OPTIONS.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setDraftRetention(value)}
                  aria-pressed={draftRetention === value}
                  className={chipClassName(draftRetention === value)}
                >
                  {value} ngày
                </button>
              ))}
            </div>
          </div>

          <AlertBox tone="warning">
            Ước tính dung lượng: chụp mỗi {draftInterval} phút trong ngày dùng máy 10 giờ ≈{' '}
            <strong>{estimate.shotsPerDay} ảnh/ngày</strong>, giữ {draftRetention} ngày ≈{' '}
            <strong>{estimate.totalShots.toLocaleString('vi-VN')} ảnh ≈ {formatGb(estimate.totalGb)}</strong>{' '}
            trên Drive của bạn. Đây là ước tính với ~300 KB/ảnh; thực tế thường nhẹ hơn vì các ảnh giống nhau
            liên tiếp được bỏ qua. Quá hạn giữ, máy của con tự xóa ảnh cũ trên Drive khi máy còn online.
          </AlertBox>

          {turningOn && (
            <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-sm font-medium text-slate-800">Xác nhận trước khi bật</p>
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={ackPrivate}
                  onChange={(e) => setAckPrivate(e.target.checked)}
                  className={`${checkboxClassName} mt-0.5`}
                />
                <span className="text-sm text-slate-700">
                  Tôi hiểu ảnh chụp màn hình có thể chứa nội dung riêng tư của con (tin nhắn, nội dung con
                  đang xem hoặc đang gõ).
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={ackResponsible}
                  onChange={(e) => setAckResponsible(e.target.checked)}
                  className={`${checkboxClassName} mt-0.5`}
                />
                <span className="text-sm text-slate-700">
                  Tôi chịu trách nhiệm về việc bật tính năng này và đã cân nhắc kỹ trước khi bật.
                </span>
              </label>
              {!ackComplete && (
                <p className="text-xs text-slate-500">Tích đủ hai ô trên thì nút Lưu mới bấm được.</p>
              )}
            </div>
          )}

          {draftEnabled && !driveConnected && (
            <AlertBox tone="warning">
              Bạn đang bật chụp nhưng Google Drive {driveRevoked ? 'đã mất kết nối' : 'chưa được kết nối'} —
              máy của con sẽ chưa tải ảnh lên được cho tới khi Drive kết nối xong.
            </AlertBox>
          )}

          {saveMessage && <AlertBox tone="success">{saveMessage}</AlertBox>}
          {saveError && <AlertBox tone="error">{saveError}</AlertBox>}

          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !settingsDirty || (turningOn && !ackComplete)}
            className={primaryButtonClassName}
          >
            {saving ? 'Đang lưu…' : 'Lưu cài đặt'}
          </button>
        </div>
      </Card>

      <Card title={`Ảnh đã chụp của ${childName}`}>
        {shots.length === 0 ? (
          <EmptyState
            title="Chưa có ảnh nào"
            description="Ảnh sẽ xuất hiện ở đây sau khi bạn bật chụp màn hình, máy của con online và Google Drive đã kết nối. Ảnh đầu tiên có thể mất vài phút mới hiện."
          />
        ) : (
          <div className="space-y-5">
            {[...shotsByDay.entries()].map(([day, dayShots]) => (
              <div key={day}>
                <h3 className="mb-2 text-sm font-semibold text-slate-800">
                  Ngày {day.split('-').reverse().join('/')} — {dayShots.length} ảnh
                </h3>
                <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {dayShots.map((shot) => (
                    <li key={shot.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                      <span className="text-sm text-slate-700">
                        {formatTimeVi(shot.captured_at)} · {formatSizeKb(shot.size_bytes)}
                        {shot.width && shot.height ? (
                          <span className="text-slate-500">
                            {' '}
                            · {shot.width}×{shot.height}
                          </span>
                        ) : null}
                      </span>
                      <a
                        href={`https://drive.google.com/file/d/${shot.drive_file_id}/view`}
                        target="_blank"
                        rel="noreferrer"
                        className={secondaryButtonClassName}
                      >
                        Mở trong Drive
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {shotsHasMore && (
              <button
                type="button"
                onClick={() => void handleLoadMoreShots()}
                disabled={loadingMoreShots}
                className={secondaryButtonClassName}
              >
                {loadingMoreShots ? 'Đang tải…' : 'Tải thêm ảnh cũ hơn'}
              </button>
            )}
          </div>
        )}
      </Card>

      <p className="text-xs text-slate-500">
        Ảnh thật nằm trên Google Drive của bạn (thư mục SafePC / {childName} / theo ngày). Danh sách ở đây
        chỉ là danh mục thời điểm chụp do máy của con báo về; xóa dữ liệu của con ở tab Dữ liệu chỉ xóa cài
        đặt và danh mục này — file ảnh trên Drive do bạn tự quản lý.
      </p>
    </div>
  )
}
