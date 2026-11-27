import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { createFamily, getMyFamily } from '../lib/family'
import { hashPin, isValidPin } from '../lib/pinHash'
import type { Child, Command, Device, DeviceChildAccount, EnforcementSnapshot, Family, SeenWindowsAccount } from '../lib/types'
import {
  accountsForDevice,
  commandTargetsChild,
  describeCommandInsertError,
  describePendingCommand,
  fetchDeviceChildAccounts,
  fetchSeenWindowsAccounts,
  linkChildAccount,
  overrideActionLabel,
  pendingCommandLabel,
  seenAccountsForDevice,
  shortSid,
  syncEnforcementStateToDevice,
  targetChildrenForDevice,
  unlinkChildAccount,
  unmappedSeenAccountsForDevice,
  type LinkSyncOutcome,
} from '../lib/deviceChildren'
import {
  deviceStatusLabel,
  enforcementDecisionLabel,
  enforcementReasonLabel,
  formatDateTimeVi,
  formatRelativeVi,
  formatTimeVi,
  parseEnforcementSnapshot,
  toVietnameseError,
} from '../lib/format'
import {
  AlertBox,
  Card,
  DEVICE_STATUS_BADGE_TONE,
  ENFORCEMENT_BADGE_TONE,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  NotConfiguredState,
  PageHeader,
  badgeBaseClassName,
  chipClassName,
  dangerButtonClassName,
  dangerOutlineButtonClassName,
  inputClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
  warningButtonClassName,
} from '../components/ui'

/** Các thời lượng mở khóa tạm thời (phút), cùng bộ với ghi đè tạm thời ở trang Quy tắc. */
const UNLOCK_DURATIONS = [15, 30, 60, 120]
const LOCK_DELAYS = [0, 1, 2, 3, 4, 5]

type LoadState = 'loading' | 'ready' | 'error'

type PairingStatus = 'waiting' | 'paired' | 'expired'

interface PairingSession {
  code: string
  childId: string
  expiresAtMs: number
  createdAtIso: string
  status: PairingStatus
  pairedDevice: Device | null
}

const PAIRING_CODE_TTL_MS = 5 * 60 * 1000

/** Mã ghép nối 6 số (100000–999999) từ nguồn ngẫu nhiên của trình duyệt. */
function generatePairingCode(): string {
  const values = new Uint32Array(1)
  crypto.getRandomValues(values)
  return String(100000 + (values[0] % 900000))
}

/** SHA-256 hex CHỮ THƯỜNG của chuỗi mã — đúng quy ước Agent dùng để đổi mã. */
async function sha256HexLower(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** Máy coi là mất kết nối khi chưa từng thấy hoặc đã quá 10 phút không thấy heartbeat. */
function isDisconnected(device: Device, nowMs: number): boolean {
  if (!device.last_seen_at) return true
  const seenMs = new Date(device.last_seen_at).getTime()
  if (Number.isNaN(seenMs)) return true
  return nowMs - seenMs > 10 * 60 * 1000
}

/**
 * Trạng thái extension trình duyệt từ `last_extension_seen_at` (cột do
 * migration 5 thêm). `undefined` = chưa có dữ liệu (truy vấn cột thất bại
 * vì migration 5 chưa áp dụng, hoặc máy chưa có trong kết quả); `null` =
 * cột có nhưng chưa từng ghi nhận. Cả hai đều hiển thị "Chưa có dữ liệu".
 */
function extensionStatus(seenAt: string | null | undefined, nowMs: number): {
  label: string
  className: string
} {
  if (!seenAt) return { label: 'Chưa có dữ liệu', className: 'text-slate-500' }
  const seenMs = new Date(seenAt).getTime()
  if (Number.isNaN(seenMs)) return { label: 'Chưa có dữ liệu', className: 'text-slate-500' }
  if (nowMs - seenMs < 15 * 60 * 1000) {
    return { label: 'Đang hoạt động', className: 'font-medium text-emerald-700' }
  }
  return { label: `Không thấy từ ${formatTimeVi(seenAt)}`, className: 'font-medium text-amber-700' }
}

/**
 * Thời điểm hết hạn của ghi đè "mở khóa" đang hiệu lực trên một máy, suy
 * ra từ các lệnh mới nhất theo luật mới-nhất-thắng (cùng luật với
 * getActiveOverride ở trang Quy tắc): lệnh mới nhất cho máy đó quyết
 * định — lock_now (đã hủy ghi đè mở khóa phía Service), cancel hoặc đã
 * hết hạn nghĩa là không còn ghi đè; ghi đè khác loại (khóa, cộng giờ,
 * chặn/mở website/ứng dụng) nghĩa là ghi đè mở khóa đã bị thay thế.
 * Lệnh unlock trần không tạo ghi đè nên bỏ qua. `commands` phải xếp mới
 * nhất trước và gồm cả lệnh lock_now (đợt sửa 17/11/2026: truy vấn cũ
 * chỉ lấy temporary_override nên lệnh khóa tàng hình với hàm này).
 *
 * Sprint 5: `childId` lọc theo con (undefined = mọi con trên máy — dùng
 * cho đồng hồ đếm ngược chung của trang). Lệnh có child_id chỉ tính cho
 * đúng con đó; lệnh cũ (child_id null) tính cho con mặc định của máy
 * (cùng ngữ nghĩa với ShouldApplyCommand phía Service).
 */
function getActiveUnlock(commands: Command[], deviceId: string, nowMs: number, childId?: string, defaultChildId?: string | null): Date | null {
  for (const command of commands) {
    if (command.device_id !== deviceId) continue
    if (childId !== undefined) {
      // Chỉ xét lệnh nhắm tới đúng con đang chọn (lệnh cũ không có
      // child_id thì tính cho con mặc định của máy — cùng ngữ nghĩa
      // với commandTargetsChild; lệnh chưa có trường child_id vì truy
      // vấn best-effort chưa có cột thì cũng tính như lệnh cũ).
      if (!commandTargetsChild(command, childId, defaultChildId ?? null)) {
        continue
      }
    }
    // Lệnh khóa mới nhất đã hủy ghi đè mở khóa phía Service (luật
    // hành-động-sau-thắng) nên không còn mở khóa nữa, dù lệnh ghi đè
    // cũ vẫn nằm trong danh sách và chưa hết hạn.
    if (command.type === 'lock_now') return null
    // Lệnh unlock trần không tạo ghi đè, không ảnh hưởng trạng thái
    // mở khóa — bỏ qua, xét lệnh tiếp theo.
    if (command.type !== 'temporary_override') continue
    const action = command.payload['action']
    if (action === 'cancel') return null
    if (
      action !== 'bonus_minutes' &&
      action !== 'lock' &&
      action !== 'unlock' &&
      action !== 'allow_domain' &&
      action !== 'block_domain' &&
      action !== 'block_app' &&
      action !== 'allow_app'
    )
      continue
    const expiresRaw = command.payload['expires_at']
    const expiresAt = typeof expiresRaw === 'string' ? new Date(expiresRaw) : null
    if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= nowMs) return null
    return action === 'unlock' ? expiresAt : null
  }
  return null
}

export default function DevicesPage({ childIdFilter }: { childIdFilter?: string } = {}) {
  const { configured, user } = useAuth()
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [family, setFamily] = useState<Family | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [children, setChildren] = useState<Child[]>([])
  // Lần cuối thấy extension theo từng máy (truy vấn riêng, best-effort —
  // xem load()). Map rỗng nghĩa là chưa biết gì về extension của máy nào.
  const [extensionSeenByDevice, setExtensionSeenByDevice] = useState<Map<string, string | null>>(
    new Map(),
  )
  // Ảnh chụp thi hành mới nhất theo từng máy (truy vấn riêng, best-effort
  // — cột enforcement_json/enforcement_updated_at chỉ có sau migration
  // 6). Snapshot null nghĩa là máy chưa có dữ liệu thi hành hợp lệ.
  const [enforcementByDevice, setEnforcementByDevice] = useState<
    Map<string, { snapshot: EnforcementSnapshot | null; updatedAt: string | null }>
  >(new Map())
  // Các lệnh ghi đè tạm thời mới nhất của gia đình, để suy ra máy nào
  // đang được mở khóa tạm thời (cùng mẫu truy vấn với trang Quy tắc).
  const [overrideCommands, setOverrideCommands] = useState<Command[]>([])
  // Ánh xạ con ↔ tài khoản Windows theo từng máy (bảng
  // device_child_accounts, migration 24) + tài khoản Windows mà Tray
  // đã "nhìn thấy" (bảng device_seen_accounts, migration 25 — xem
  // lib/deviceChildren.ts). Cả hai truy vấn đều best-effort (xem
  // load()): `*Available` false nghĩa là bảng chưa tồn tại, giao diện
  // hiện ghi chú thay vì vỡ trang.
  const [childAccounts, setChildAccounts] = useState<DeviceChildAccount[]>([])
  const [childAccountsAvailable, setChildAccountsAvailable] = useState(true)
  const [seenAccounts, setSeenAccounts] = useState<SeenWindowsAccount[]>([])
  const [seenAccountsAvailable, setSeenAccountsAvailable] = useState(true)
  // Con đích cho lệnh khóa/mở trên từng máy (mặc định: con mặc định của
  // máy; phụ huynh đổi được trong thẻ máy). Lệnh luôn mang child_id của
  // con đã chọn (Sprint 5: lệnh gắn theo từng con).
  const [targetChildByDevice, setTargetChildByDevice] = useState<Record<string, string>>({})
  // Form gắn thêm con vào máy (theo từng máy): con chưa gắn + tài khoản
  // Windows đã thấy nhưng chưa gắn (chọn, không gõ tay).
  const [linkChildIdByDevice, setLinkChildIdByDevice] = useState<Record<string, string>>({})
  const [linkSidByDevice, setLinkSidByDevice] = useState<Record<string, string>>({})
  const [linkingDeviceId, setLinkingDeviceId] = useState<string | null>(null)
  // Gỡ ánh xạ: bấm 2 lần (cùng mẫu xóa thiết bị) để tránh gỡ nhầm.
  const [confirmUnlinkKey, setConfirmUnlinkKey] = useState<string | null>(null)
  const [unlinkingKey, setUnlinkingKey] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [lockingId, setLockingId] = useState<string | null>(null)
  const [creatingFamily, setCreatingFamily] = useState(false)

  // Mở khóa ngay: thời lượng đã chọn theo từng máy (mặc định 30 phút).
  const [unlockMinutesByDevice, setUnlockMinutesByDevice] = useState<Record<string, number>>({})
  const [lockDelayByDevice, setLockDelayByDevice] = useState<Record<string, number>>({})
  const [sendingUnlockId, setSendingUnlockId] = useState<string | null>(null)
  const [cancellingUnlockId, setCancellingUnlockId] = useState<string | null>(null)

  // Xoá thiết bị: bấm 2 lần (bấm "Xóa thiết bị" rồi "Xác nhận xóa") để
  // tránh xoá nhầm (cùng mẫu với xoá quy tắc ở trang Quy tắc).
  const [confirmDeleteDeviceId, setConfirmDeleteDeviceId] = useState<string | null>(null)
  const [deletingDeviceId, setDeletingDeviceId] = useState<string | null>(null)

  // Mã PIN thoát Tray theo từng máy: chỉ băm mới lên server, PIN thô
  // không rời trình duyệt (xem pinHash.ts).
  const [pinByDevice, setPinByDevice] = useState<Record<string, string>>({})
  const [pinConfirmByDevice, setPinConfirmByDevice] = useState<Record<string, string>>({})
  const [savingPinId, setSavingPinId] = useState<string | null>(null)
  const [removingPinId, setRemovingPinId] = useState<string | null>(null)

  // Form tạo hồ sơ con (tối thiểu): tên hiển thị + năm sinh.
  const [showChildForm, setShowChildForm] = useState(false)
  const [childName, setChildName] = useState('')
  const [birthYear, setBirthYear] = useState('')
  const [savingChild, setSavingChild] = useState(false)

  // Ghép nối máy mới: mã PIN tạm thời 6 số dùng một lần, hiệu lực 5 phút
  // (rút từ 10 phút theo yêu cầu 17/11/2026: mã ngắn hạn, ghép nối xong là
  // hết giá trị). Mã dạng plaintext chỉ hiển thị ở đây, một lần duy nhất;
  // xuống database chỉ lưu SHA-256 hex của mã (xem handleCreatePairingCode).
  const [pairChildId, setPairChildId] = useState('')
  const [pairing, setPairing] = useState<PairingSession | null>(null)
  const [pairError, setPairError] = useState<string | null>(null)
  const [creatingCode, setCreatingCode] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const load = useCallback(async () => {
    if (!supabase || !user) {
      setState('ready')
      return
    }
    setState('loading')
    setError('')
    try {
      const [familyResult, devicesResult, childrenResult, commandsResult] = await Promise.all([
        getMyFamily(supabase, user.id),
        supabase
          .from('devices')
          .select('id, family_id, child_id, hostname, os_version, agent_version, last_seen_at, status, created_at')
          .order('created_at', { ascending: true }),
        supabase
          .from('children')
          .select('id, family_id, display_name, birth_year, avatar_url, created_at')
          .order('created_at', { ascending: true }),
        supabase
          .from('commands')
          .select('id, family_id, device_id, type, payload, status, created_at')
          .in('type', ['temporary_override', 'lock_now'])
          .order('created_at', { ascending: false })
          .limit(200),
      ])
      if (devicesResult.error) throw devicesResult.error
      if (childrenResult.error) throw childrenResult.error
      if (commandsResult.error) throw commandsResult.error
      setFamily(familyResult)
      setDevices((devicesResult.data ?? []) as Device[])
      setChildren((childrenResult.data ?? []) as Child[])
      setOverrideCommands((commandsResult.data ?? []) as Command[])
      // Truy vấn RIÊNG, best-effort: cột last_extension_seen_at chỉ có sau
      // migration 5. Truy vấn lỗi (cột chưa tồn tại) thì coi extension là
      // chưa biết với mọi máy, KHÔNG làm hỏng cả trang.
      try {
        const extensionResult = await supabase
          .from('devices')
          .select('id, last_extension_seen_at')
        if (extensionResult.error) {
          setExtensionSeenByDevice(new Map())
        } else {
          const seen = new Map<string, string | null>()
          for (const row of (extensionResult.data ?? []) as Array<{ id: string; last_extension_seen_at: string | null }>) {
            seen.set(row.id, row.last_extension_seen_at)
          }
          setExtensionSeenByDevice(seen)
        }
      } catch {
        setExtensionSeenByDevice(new Map())
      }
      // Truy vấn RIÊNG, best-effort: cột enforcement_json /
      // enforcement_updated_at chỉ có sau migration 6. Truy vấn lỗi (cột
      // chưa tồn tại) thì coi mọi máy là chưa có dữ liệu thi hành, KHÔNG
      // làm hỏng cả trang. JSON hỏng hoặc '{}' cũng coi là chưa có dữ
      // liệu (xem parseEnforcementSnapshot).
      try {
        const enforcementResult = await supabase
          .from('devices')
          .select('id, enforcement_json, enforcement_updated_at')
        if (enforcementResult.error) {
          setEnforcementByDevice(new Map())
        } else {
          const snapshots = new Map<string, { snapshot: EnforcementSnapshot | null; updatedAt: string | null }>()
          for (const row of (enforcementResult.data ?? []) as Array<{
            id: string
            enforcement_json: unknown
            enforcement_updated_at: string | null
          }>) {
            snapshots.set(row.id, {
              snapshot: parseEnforcementSnapshot(row.enforcement_json),
              updatedAt: row.enforcement_updated_at,
            })
          }
          setEnforcementByDevice(snapshots)
        }
      } catch {
        setEnforcementByDevice(new Map())
      }
      // Truy vấn RIÊNG, best-effort: cột exit_pin_hash chỉ có sau
      // migration 7. Truy vấn lỗi (cột chưa tồn tại) thì coi mọi máy là
      // chưa đặt PIN, KHÔNG làm hỏng cả trang (Vercel deploy theo push,
      // migration do phụ huynh paste sau — trang Thiết bị không được vỡ
      // trong khoảng giữa). Gộp theo id vào state devices đã tải.
      try {
        const pinResult = await supabase
          .from('devices')
          .select('id, exit_pin_hash')
        if (!pinResult.error) {
          const pinById = new Map<string, string | null>()
          for (const row of (pinResult.data ?? []) as Array<{ id: string; exit_pin_hash: string | null }>) {
            pinById.set(row.id, row.exit_pin_hash)
          }
          setDevices((prev) => prev.map((d) => ({ ...d, exit_pin_hash: pinById.get(d.id) ?? null })))
        }
      } catch {
        // Chưa có cột → giữ nguyên trạng thái "chưa đặt PIN".
      }
      // Truy vấn RIÊNG, best-effort: cột commands.child_id chỉ có sau
      // migration 24. Truy vấn thành công thì thay danh sách lệnh bằng
      // bản có child_id (để hiển thị mở khóa / lệnh chờ theo từng con);
      // truy vấn lỗi (cột chưa tồn tại) thì giữ bản đã tải ở trên
      // (không có child_id — hành vi cũ, lệnh tính cho con mặc định).
      // KHÔNG gộp cột vào truy vấn chính: cột chưa tồn tại sẽ làm hỏng
      // cả trang trong khoảng giữa deploy Dashboard và áp migration 24.
      try {
        const childCommandsResult = await supabase
          .from('commands')
          .select('id, family_id, device_id, child_id, type, payload, status, created_at')
          .in('type', ['temporary_override', 'lock_now'])
          .order('created_at', { ascending: false })
          .limit(200)
        if (!childCommandsResult.error) {
          setOverrideCommands((childCommandsResult.data ?? []) as Command[])
        }
      } catch {
        // Chưa có cột → giữ bản lệnh không có child_id.
      }
      // Truy vấn RIÊNG, best-effort: bảng device_child_accounts chỉ có
      // sau migration 24; bảng device_seen_accounts chỉ có sau migration
      // 25 (xem lib/deviceChildren.ts). Truy vấn lỗi thì coi như chưa có
      // dữ liệu, giao diện hiện ghi chú, KHÔNG làm hỏng cả trang.
      const mappingsResult = await fetchDeviceChildAccounts(supabase)
      setChildAccounts(mappingsResult.accounts)
      setChildAccountsAvailable(mappingsResult.available)
      const seenResult = await fetchSeenWindowsAccounts(supabase)
      setSeenAccounts(seenResult.accounts)
      setSeenAccountsAvailable(seenResult.available)
      setState('ready')
    } catch (err) {
      setError(toVietnameseError(err))
      setState('error')
    }
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  // Khi nhúng trong hồ sơ của một con (tab Thiết bị) thì chỉ hiện máy của
  // con đó — máy mà con là hồ sơ mặc định HOẶC đã gắn qua ánh xạ tài
  // khoản Windows (Sprint 5: máy chung hiện trong hồ sơ của cả hai con);
  // trang độc lập (/thiet-bi) hiện mọi máy như trước.
  const visibleDevices = childIdFilter
    ? devices.filter(
        (d) =>
          d.child_id === childIdFilter ||
          childAccounts.some((a) => a.device_id === d.id && a.child_id === childIdFilter),
      )
    : devices

  // Mặc định chọn con đầu tiên cho dropdown ghép nối (giống trang Quy tắc).
  // Trong hồ sơ của một con thì luôn ghép cho con đó, không cho đổi.
  useEffect(() => {
    if (childIdFilter) {
      setPairChildId(childIdFilter)
    } else if (!pairChildId && children.length > 0) {
      setPairChildId(children[0].id)
    }
  }, [children, pairChildId, childIdFilter])

  // Đồng hồ đếm ngược khi đang chờ ghép nối; hết giờ thì đánh dấu hết hạn.
  useEffect(() => {
    if (pairing?.status !== 'waiting') return
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [pairing?.status])

  // Đồng hồ đếm ngược "đang mở khóa": chỉ chạy khi có ít nhất một máy
  // đang được mở khóa tạm thời, để con số MM:SS cập nhật từng giây. Hết
  // giờ thì đếm ngược tự biến mất ở lần render sau.
  const anyUnlockActive = devices.some(
    (device) => getActiveUnlock(overrideCommands, device.id, Date.now()) !== null,
  )
  useEffect(() => {
    if (!anyUnlockActive) return
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [anyUnlockActive])

  useEffect(() => {
    if (pairing?.status === 'waiting' && nowMs >= pairing.expiresAtMs) {
      setPairing((prev) => (prev && prev.status === 'waiting' ? { ...prev, status: 'expired' } : prev))
    }
  }, [nowMs, pairing])

  // Poll thiết bị mới mỗi 5 giây trong lúc chờ ghép nối; dừng khi đã ghép
  // nối, hết hạn hoặc unmount. Lỗi truy vấn thoáng qua thì bỏ qua, lần
  // poll sau sẽ thử lại.
  useEffect(() => {
    if (!supabase || !family || !pairing || pairing.status !== 'waiting') return
    const client = supabase
    let cancelled = false
    const checkForNewDevice = async () => {
      const { data, error: queryError } = await client
        .from('devices')
        .select('id, family_id, child_id, hostname, os_version, agent_version, last_seen_at, status, created_at')
        .eq('family_id', family.id)
        .eq('child_id', pairing.childId)
        .gt('created_at', pairing.createdAtIso)
        .order('created_at', { ascending: false })
        .limit(1)
      if (cancelled) return
      if (queryError) return
      const found = (data ?? [])[0] as Device | undefined
      if (found) {
        setPairing((prev) => (prev ? { ...prev, status: 'paired', pairedDevice: found } : prev))
        await load()
      }
    }
    void checkForNewDevice()
    const timer = window.setInterval(() => void checkForNewDevice(), 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [family, pairing, load])

  const childNameById = new Map(children.map((c) => [c.id, c.display_name]))

  const handleCreateFamily = async () => {
    if (!supabase || !user) return
    setCreatingFamily(true)
    setActionError(null)
    try {
      const created = await createFamily(supabase, user.id)
      setFamily(created)
      setActionMessage('Đã tạo gia đình của bạn. Bây giờ bạn có thể thêm hồ sơ con và ghép nối máy.')
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setCreatingFamily(false)
    }
  }

  /**
   * Con đích cho lệnh khóa/mở trên một máy: lựa chọn tường minh của phụ
   * huynh, mặc định là con mặc định của máy (fallback: con gắn đầu tiên).
   * Trong hồ sơ của một con (tab Thiết bị) thì lệnh luôn nhắm tới con
   * đó, không cho đổi sang con khác. Máy không có con nào thì trả rỗng
   * — lệnh không gắn được với con nào.
   */
  const targetChildIdForDevice = (device: Device): string => {
    const targets = targetChildrenForDevice(device, childAccounts)
    if (childIdFilter) return targets.includes(childIdFilter) ? childIdFilter : ''
    const chosen = targetChildByDevice[device.id]
    if (chosen && targets.includes(chosen)) return chosen
    return targets[0] ?? ''
  }

  const handleLockNow = async (device: Device) => {
    if (!supabase || !user) return
    if (!family) {
      setActionError('Bạn chưa có gia đình. Vui lòng tạo gia đình trước khi gửi lệnh khóa máy.')
      return
    }
    const targetChildId = targetChildIdForDevice(device)
    if (!targetChildId) {
      setActionError(
        `Máy "${device.hostname}" chưa gán cho hồ sơ con nào nên lệnh khóa không gắn được với con nào. Hãy ghép nối máy cho một con, hoặc gắn tài khoản Windows của con với máy này.`,
      )
      return
    }
    const targetChildName = childNameById.get(targetChildId) ?? 'con'
    setLockingId(device.id)
    setActionError(null)
    setActionMessage(null)
    const delayMinutes = lockDelayByDevice[device.id] ?? 0
    try {
      const { error: insertError } = await supabase.from('commands').insert({
        family_id: device.family_id,
        device_id: device.id,
        child_id: targetChildId,
        type: 'lock_now',
        payload: { delay_minutes: delayMinutes },
        status: 'pending',
      })
      if (insertError) throw insertError
      setActionMessage(
        delayMinutes > 0
          ? `Đã gửi lệnh khóa máy cho ${targetChildName} trên máy "${device.hostname}" sau ${delayMinutes} phút. Trong lúc chờ, máy con hiện cửa sổ cảnh báo nhỏ để lưu bài làm. Nếu ${targetChildName} chưa đăng nhập trên máy này, lệnh sẽ áp dụng khi con đăng nhập.`
          : `Đã gửi lệnh khóa máy cho ${targetChildName} trên máy "${device.hostname}". Agent trên máy con sẽ nhận lệnh khi online (polling 15 giây). Nếu ${targetChildName} chưa đăng nhập trên máy này, lệnh sẽ áp dụng khi con đăng nhập.`,
      )
      // Tải lại như 2 handler mở khóa/hủy ghi đè: lệnh lock_now mới phải
      // vào danh sách commands ngay để getActiveUnlock thôi báo "đang mở
      // khóa" (đợt sửa 17/11/2026).
      await load()
    } catch (err) {
      setActionError(describeCommandInsertError(err) ?? toVietnameseError(err))
    } finally {
      setLockingId(null)
    }
  }

  const handleUnlockNow = async (device: Device) => {
    if (!supabase || !user) return
    if (!family) {
      setActionError('Bạn chưa có gia đình. Vui lòng tạo gia đình trước khi gửi lệnh mở khóa.')
      return
    }
    const targetChildId = targetChildIdForDevice(device)
    if (!targetChildId) {
      setActionError(
        `Máy "${device.hostname}" chưa gán cho hồ sơ con nào nên lệnh mở khóa không gắn được với con nào. Hãy ghép nối máy cho một con, hoặc gắn tài khoản Windows của con với máy này.`,
      )
      return
    }
    const targetChildName = childNameById.get(targetChildId) ?? 'con'
    const minutes = unlockMinutesByDevice[device.id] ?? 30
    setSendingUnlockId(device.id)
    setActionError(null)
    setActionMessage(null)
    try {
      const expiresAt = new Date(Date.now() + minutes * 60000)
      const { error: insertError } = await supabase.from('commands').insert({
        family_id: device.family_id,
        device_id: device.id,
        child_id: targetChildId,
        type: 'temporary_override',
        payload: { action: 'unlock', minutes, expires_at: expiresAt.toISOString() },
        status: 'pending',
      })
      if (insertError) throw insertError
      setActionMessage(
        `Đã gửi lệnh mở khóa tạm thời (${minutes} phút) cho ${targetChildName} trên máy "${device.hostname}". Agent sẽ nhận lệnh trong vòng ~15 giây khi máy online; các quy tắc giờ giấc tạm ngưng tới ${formatTimeVi(expiresAt.toISOString())}. Nếu ${targetChildName} chưa đăng nhập trên máy này, lệnh sẽ áp dụng khi con đăng nhập.`,
      )
      await load()
    } catch (err) {
      setActionError(describeCommandInsertError(err) ?? toVietnameseError(err))
    } finally {
      setSendingUnlockId(null)
    }
  }

  const handleCancelDeviceOverride = async (device: Device) => {
    if (!supabase || !user) return
    if (!family) {
      setActionError('Bạn chưa có gia đình. Vui lòng tạo gia đình trước khi gửi lệnh hủy ghi đè.')
      return
    }
    const targetChildId = targetChildIdForDevice(device)
    if (!targetChildId) {
      setActionError(
        `Máy "${device.hostname}" chưa gán cho hồ sơ con nào nên lệnh hủy ghi đè không gắn được với con nào.`,
      )
      return
    }
    const targetChildName = childNameById.get(targetChildId) ?? 'con'
    setCancellingUnlockId(device.id)
    setActionError(null)
    setActionMessage(null)
    try {
      const { error: insertError } = await supabase.from('commands').insert({
        family_id: device.family_id,
        device_id: device.id,
        child_id: targetChildId,
        type: 'temporary_override',
        payload: { action: 'cancel' },
        status: 'pending',
      })
      if (insertError) throw insertError
      setActionMessage(
        `Đã gửi lệnh hủy ghi đè cho ${targetChildName} trên máy "${device.hostname}". Các quy tắc bình thường sẽ áp dụng lại như cũ. Nếu ${targetChildName} chưa đăng nhập trên máy này, lệnh sẽ áp dụng khi con đăng nhập.`,
      )
      await load()
    } catch (err) {
      setActionError(describeCommandInsertError(err) ?? toVietnameseError(err))
    } finally {
      setCancellingUnlockId(null)
    }
  }

  // Mô tả kết quả đồng bộ trạng thái lúc gắn (migration 27, phương án (a))
  // để gắn vào thông báo sau khi gắn thành công.
  const describeLinkSync = (sync: LinkSyncOutcome, childName: string): string => {
    if (!sync.synced) {
      return sync.missingMigration
        ? 'Trạng thái thi hành của con chưa đồng bộ sang máy này (chưa áp migration 27) — sau khi áp migration 27, hãy gỡ rồi gắn lại tài khoản này để đồng bộ.'
        : 'Chưa đồng bộ được trạng thái thi hành của con sang máy này — hãy thử gắn lại hoặc kiểm tra lại sau.'
    }
    if (sync.locked && sync.overrideAction === 'unlock' && sync.overrideExpiresAt) {
      return `${childName} đang bị khóa cưỡng chế trên máy khác nhưng đã sao chép lệnh mở tạm tới ${formatTimeVi(sync.overrideExpiresAt)} — trạng thái cuối cùng trên máy này tùy theo lệnh mới nhất của con.`
    }
    if (sync.locked) {
      return `${childName} đang bị khóa cưỡng chế trên máy khác nên máy này cũng sẽ khóa khi ${childName} đăng nhập.`
    }
    if (sync.overrideAction) {
      const detail =
        sync.overrideMinutes !== null && sync.overrideExpiresAt
          ? ` (còn ${sync.overrideMinutes} phút, tới ${formatTimeVi(sync.overrideExpiresAt)})`
          : ''
      return `Đã đồng bộ trạng thái của ${childName} sang máy này: ${overrideActionLabel(sync.overrideAction)} đang hiệu lực${detail}.`
    }
    return `${childName} hiện không có trạng thái khóa/ghi đè nào cần đồng bộ.`
  }

  const handleLinkChildAccount = async (device: Device) => {
    if (!supabase || !user || !family) return
    // Mặc định: con chưa gắn đầu tiên + tài khoản đã thấy nhưng chưa gắn
    // đầu tiên (ô chọn trong thẻ máy cũng dùng cùng mặc định này).
    const linkableChildIds = (childIdFilter
      ? children.filter((c) => c.id === childIdFilter)
      : children
    )
      .map((c) => c.id)
      .filter((id) => !targetChildrenForDevice(device, childAccounts).includes(id))
    const unmapped = unmappedSeenAccountsForDevice(device.id, seenAccounts, childAccounts)
    const childId = linkChildIdByDevice[device.id] ?? linkableChildIds[0] ?? ''
    const sid = linkSidByDevice[device.id] ?? unmapped[0]?.windows_sid ?? ''
    if (!childId || !sid) {
      setActionError('Hãy chọn hồ sơ con và tài khoản Windows cần gắn với máy này.')
      return
    }
    const seen = seenAccountsForDevice(device.id, seenAccounts).find((a) => a.windows_sid === sid)
    const childName = childNameById.get(childId) ?? 'con'
    setLinkingDeviceId(device.id)
    setActionError(null)
    setActionMessage(null)
    try {
      await linkChildAccount(supabase, {
        familyId: family.id,
        deviceId: device.id,
        childId,
        windowsSid: sid,
        windowsUsername: seen?.windows_username ?? null,
      })
      // Đồng bộ trạng thái thi hành lúc gắn (phương án (a), migration 27)
      // — best-effort: RPC chưa có thì gắn vẫn thành công, chỉ hiện ghi
      // chú (xem syncEnforcementStateToDevice).
      const sync = await syncEnforcementStateToDevice(supabase, {
        deviceId: device.id,
        childId,
      })
      setActionMessage(
        `Đã gắn tài khoản Windows "${seen?.windows_username ?? sid}" trên máy "${device.hostname}" với hồ sơ ${childName}. ` +
          describeLinkSync(sync, childName),
      )
      // Xóa lựa chọn form gắn của máy này để lần gắn sau không giữ lại
      // con/tài khoản vừa gắn (đã rời khỏi danh sách lựa chọn).
      setLinkChildIdByDevice((prev) => {
        const next = { ...prev }
        delete next[device.id]
        return next
      })
      setLinkSidByDevice((prev) => {
        const next = { ...prev }
        delete next[device.id]
        return next
      })
      await load()
    } catch (err) {
      setActionError(describeCommandInsertError(err) ?? toVietnameseError(err))
    } finally {
      setLinkingDeviceId(null)
    }
  }

  const handleUnlinkChildAccount = async (device: Device, account: DeviceChildAccount) => {
    if (!supabase) return
    const key = `${device.id}:${account.windows_sid}`
    setUnlinkingKey(key)
    setActionError(null)
    try {
      await unlinkChildAccount(supabase, { deviceId: device.id, windowsSid: account.windows_sid })
      setConfirmUnlinkKey(null)
      setActionMessage(
        `Đã gỡ tài khoản Windows "${account.windows_username ?? account.windows_sid}" trên máy "${device.hostname}" khỏi hồ sơ ${childNameById.get(account.child_id) ?? 'con'}. Tài khoản này không còn được quản lý trên máy này; các quy tắc và ngân hàng giờ của hồ sơ con vẫn giữ nguyên.`,
      )
      await load()
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setUnlinkingKey(null)
    }
  }

  const handleSavePin = async (device: Device) => {
    if (!supabase || !user) return
    const pin = pinByDevice[device.id] ?? ''
    const confirm = pinConfirmByDevice[device.id] ?? ''
    setActionError(null)
    setActionMessage(null)
    if (!isValidPin(pin)) {
      setActionError('Mã PIN phải gồm đúng 6 chữ số.')
      return
    }
    if (pin !== confirm) {
      setActionError('Hai lần nhập mã PIN chưa khớp nhau.')
      return
    }
    setSavingPinId(device.id)
    try {
      const exitPinHash = await hashPin(pin)
      const { error: updateError } = await supabase
        .from('devices')
        .update({ exit_pin_hash: exitPinHash })
        .eq('id', device.id)
      if (updateError) throw updateError
      setDevices((prev) =>
        prev.map((d) => (d.id === device.id ? { ...d, exit_pin_hash: exitPinHash } : d)),
      )
      setPinByDevice((prev) => ({ ...prev, [device.id]: '' }))
      setPinConfirmByDevice((prev) => ({ ...prev, [device.id]: '' }))
      setActionMessage(
        `Đã đặt mã PIN thoát cho máy "${device.hostname}". Agent sẽ nhận mã mới trong vòng ~1 phút khi máy online.`,
      )
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setSavingPinId(null)
    }
  }

  const handleRemovePin = async (device: Device) => {
    if (!supabase || !user) return
    setRemovingPinId(device.id)
    setActionError(null)
    setActionMessage(null)
    try {
      const { error: updateError } = await supabase
        .from('devices')
        .update({ exit_pin_hash: null })
        .eq('id', device.id)
      if (updateError) throw updateError
      setDevices((prev) => prev.map((d) => (d.id === device.id ? { ...d, exit_pin_hash: null } : d)))
      setActionMessage(`Đã gỡ mã PIN thoát của máy "${device.hostname}".`)
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setRemovingPinId(null)
    }
  }

  const handleDeleteDevice = async (device: Device) => {
    if (!supabase) return
    setDeletingDeviceId(device.id)
    setActionError(null)
    try {
      // Policy "family access" (FOR ALL) trên bảng devices cho phép thành
      // viên gia đình xóa máy của gia đình mình. Các hàng con (token,
      // lịch sử dùng máy/web, lệnh chờ) tự xóa theo ON DELETE CASCADE;
      // audit_logs.device_id chuyển thành NULL (ON DELETE SET NULL).
      const { error: deleteError } = await supabase.from('devices').delete().eq('id', device.id)
      if (deleteError) throw deleteError
      setConfirmDeleteDeviceId(null)
      setActionMessage(
        `Đã xóa thiết bị "${device.hostname}" khỏi Dashboard. Thiết bị đã mất quyền đồng bộ; Agent trên máy vẫn thi hành các quy tắc đã đồng bộ lần cuối cho đến khi được gỡ cài đặt.`,
      )
      await load()
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setDeletingDeviceId(null)
    }
  }

  const handleCreateChild = async (event: FormEvent) => {
    event.preventDefault()
    if (!supabase || !family) return
    const year = birthYear.trim() === '' ? null : Number(birthYear)
    if (year !== null && (!Number.isInteger(year) || year < 2000 || year > 2030)) {
      setActionError('Năm sinh phải từ 2000 đến 2030 (theo ràng buộc của cơ sở dữ liệu).')
      return
    }
    setSavingChild(true)
    setActionError(null)
    try {
      const { error: insertError } = await supabase.from('children').insert({
        family_id: family.id,
        display_name: childName.trim(),
        birth_year: year,
      })
      if (insertError) throw insertError
      setChildName('')
      setBirthYear('')
      setShowChildForm(false)
      setActionMessage('Đã tạo hồ sơ con.')
      await load()
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setSavingChild(false)
    }
  }

  const handleCreatePairingCode = async () => {
    if (!supabase || !family || !pairChildId) return
    setCreatingCode(true)
    setPairError(null)
    try {
      const code = generatePairingCode()
      const codeHash = await sha256HexLower(code)
      const createdAt = new Date()
      const expiresAt = new Date(createdAt.getTime() + PAIRING_CODE_TTL_MS)
      const { error: insertError } = await supabase.from('pairing_codes').insert({
        family_id: family.id,
        child_id: pairChildId,
        code_hash: codeHash,
        expires_at: expiresAt.toISOString(),
      })
      if (insertError) throw insertError
      // Trừ 30 giây khi poll theo created_at để tránh lệch đồng hồ giữa
      // trình duyệt và database làm lỡ mất thiết bị vừa ghép nối.
      setPairing({
        code,
        childId: pairChildId,
        expiresAtMs: expiresAt.getTime(),
        createdAtIso: new Date(createdAt.getTime() - 30_000).toISOString(),
        status: 'waiting',
        pairedDevice: null,
      })
      setNowMs(Date.now())
    } catch (err) {
      setPairError(toVietnameseError(err))
    } finally {
      setCreatingCode(false)
    }
  }

  const handleCancelPairing = () => {
    setPairing(null)
    setPairError(null)
  }

  if (!configured) {
    return (
      <>
        <PageHeader
          title="Thiết bị"
          description="Danh sách máy tính của con đã ghép nối với SafePC."
        />
        <NotConfiguredState />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Thiết bị"
        description="Danh sách máy tính của con đã ghép nối với SafePC."
        actions={
          !childIdFilter ? (
            <button
              type="button"
              onClick={() => setShowChildForm((v) => !v)}
              disabled={!family}
              className={secondaryButtonClassName}
              title={family ? undefined : 'Cần tạo gia đình trước'}
            >
              Thêm hồ sơ con
            </button>
          ) : undefined
        }
      />

      {actionMessage && (
        <AlertBox tone="success" className="mb-4">
          {actionMessage}
        </AlertBox>
      )}
      {actionError && (
        <AlertBox tone="error" className="mb-4">
          {actionError}
        </AlertBox>
      )}

      {state === 'loading' && <LoadingState label="Đang tải danh sách thiết bị…" />}
      {state === 'error' && <ErrorState message={error} onRetry={() => void load()} />}

      {state === 'ready' && !family && (
        <EmptyState
          title="Bạn chưa có gia đình nào"
          description="Mỗi tài khoản phụ huynh cần một gia đình để quản lý hồ sơ con, thiết bị và quy tắc. Hãy tạo gia đình để bắt đầu."
        >
          <button
            type="button"
            onClick={() => void handleCreateFamily()}
            disabled={creatingFamily}
            className={primaryButtonClassName}
          >
            {creatingFamily ? 'Đang tạo…' : 'Tạo gia đình của tôi'}
          </button>
        </EmptyState>
      )}

      {state === 'ready' && family && (
        <div className="space-y-4 sm:space-y-6">
          {showChildForm && !childIdFilter && (
            <Card title="Thêm hồ sơ con">
              <form onSubmit={(e) => void handleCreateChild(e)} className="grid gap-4 sm:grid-cols-2">
                <Field label="Tên hiển thị của con" htmlFor="child-name">
                  <input
                    id="child-name"
                    type="text"
                    required
                    maxLength={100}
                    value={childName}
                    onChange={(e) => setChildName(e.target.value)}
                    placeholder="Ví dụ: Minh Anh"
                    className={inputClassName}
                  />
                </Field>
                <Field label="Năm sinh (không bắt buộc)" htmlFor="child-birth-year" hint="Từ 2000 đến 2030.">
                  <input
                    id="child-birth-year"
                    type="number"
                    inputMode="numeric"
                    min={2000}
                    max={2030}
                    value={birthYear}
                    onChange={(e) => setBirthYear(e.target.value)}
                    placeholder="Ví dụ: 2016"
                    className={inputClassName}
                  />
                </Field>
                <div className="flex flex-wrap gap-2 sm:col-span-2">
                  <button type="submit" disabled={savingChild} className={primaryButtonClassName}>
                    {savingChild ? 'Đang lưu…' : 'Lưu hồ sơ con'}
                  </button>
                  <button type="button" onClick={() => setShowChildForm(false)} className={secondaryButtonClassName}>
                    Huỷ
                  </button>
                </div>
              </form>
            </Card>
          )}

          {visibleDevices.length === 0 ? (
            <EmptyState
              title="Chưa có thiết bị nào"
              description="Chưa có máy tính nào được ghép nối với gia đình của bạn. Sau khi cài PC Agent lên máy của con và ghép nối thành công, máy sẽ xuất hiện tại đây."
            />
          ) : (
            <div className="grid gap-3 sm:gap-4 md:grid-cols-2">
              {visibleDevices.map((device) => {
                const extension = extensionStatus(extensionSeenByDevice.get(device.id), Date.now())
                const disconnected = isDisconnected(device, Date.now())
                const extensionSeenAt = extensionSeenByDevice.get(device.id)
                const enforcement = enforcementByDevice.get(device.id)
                const enforcementSnapshot = enforcement?.snapshot ?? null
                const enforcementUpdatedMs = enforcement?.updatedAt
                  ? new Date(enforcement.updatedAt).getTime()
                  : Number.NaN
                const enforcementStale =
                  !Number.isNaN(enforcementUpdatedMs) && Date.now() - enforcementUpdatedMs > 5 * 60 * 1000
                // Sprint 5: các con được quản lý trên máy này (mặc định
                // trước, rồi các con gắn thêm qua ánh xạ) + tài khoản
                // Windows đã thấy / chưa gắn. Con đích cho lệnh khóa/mở
                // là lựa chọn của phụ huynh (mặc định: con mặc định).
                const deviceTargetChildIds = targetChildrenForDevice(device, childAccounts)
                const targetChildId = targetChildIdForDevice(device)
                const deviceLinkedAccounts = accountsForDevice(device.id, childAccounts)
                const deviceUnmappedSeen = unmappedSeenAccountsForDevice(
                  device.id,
                  seenAccounts,
                  childAccounts,
                )
                const unmappedStandardAccounts = deviceUnmappedSeen.filter((a) => !a.is_admin)
                const activeUnlockExpiresAt = getActiveUnlock(
                  overrideCommands,
                  device.id,
                  Date.now(),
                  targetChildId === '' ? undefined : targetChildId,
                  device.child_id,
                )
                // Lệnh đang pending của máy này (khóa + ghi đè tạm thời,
                // mới nhất trước — cùng danh sách đã tải cho trạng thái
                // mở khóa). Hiển thị trạng thái chờ của từng lệnh để phụ
                // huynh biết lệnh nào chưa tới được con đích.
                const pendingCommandsForDevice = overrideCommands.filter(
                  (c) => c.device_id === device.id && c.status === 'pending',
                )
                // Lựa chọn cho form gắn thêm con: con chưa gắn trên máy
                // này + tài khoản đã thấy nhưng chưa gắn (chọn, không gõ
                // tay). Mặc định là mục đầu tiên của mỗi danh sách.
                // Ô chọn con đích cho lệnh khóa/mở: trong hồ sơ của một
                // con thì chỉ có con đó (không cho đổi sang con khác).
                const pickerChildIds = childIdFilter
                  ? deviceTargetChildIds.filter((id) => id === childIdFilter)
                  : deviceTargetChildIds
                const linkableChildren = (childIdFilter
                  ? children.filter((c) => c.id === childIdFilter)
                  : children
                ).filter((c) => !deviceTargetChildIds.includes(c.id))
                const effectiveLinkChildId =
                  linkChildIdByDevice[device.id] ?? linkableChildren[0]?.id ?? ''
                const effectiveLinkSid =
                  linkSidByDevice[device.id] ?? deviceUnmappedSeen[0]?.windows_sid ?? ''
                // Ghi đè mở khóa đang hiệu lực (suy ra từ lệnh mới nhất
                // trong bảng commands — dữ liệu tươi, tải lại ngay sau mỗi
                // thao tác) thắng trạng thái khóa cũ: devices.status và
                // snapshot thi hành cập nhật chậm hơn (Agent đẩy khi chữ
                // ký đổi, từ vòng tick 15 giây hoặc chu kỳ heartbeat 60
                // giây), nên sau khi duyệt thêm giờ thẻ sẽ hiện đồng thời
                // "Đang bị khóa"/"Đang khóa" và "Đang mở khóa" nếu không
                // ưu tiên trạng thái mở khóa ở đây (test máy thật
                // 18/11/2026). Snapshot "Cho phép" thì không mâu thuẫn
                // nên vẫn hiển thị như thường.
                const unlockActive = activeUnlockExpiresAt !== null
                const enforcementSupersededByUnlock =
                  unlockActive && enforcementSnapshot !== null && enforcementSnapshot.decision !== 'allow'
                const unlockMinutes = unlockMinutesByDevice[device.id] ?? 30
                const lockDelay = lockDelayByDevice[device.id] ?? 0
                const confirmingDeleteDevice = confirmDeleteDeviceId === device.id
                return (
                <Card key={device.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-semibold text-slate-900">{device.hostname}</h2>
                      <p className="mt-0.5 text-sm text-slate-600">
                        {deviceTargetChildIds.length > 0
                          ? deviceTargetChildIds.map((id) => childNameById.get(id) ?? 'Không rõ con').join(', ')
                          : 'Chưa gán cho con nào'}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-2">
                      {unlockActive ? (
                        <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">
                          Đang mở khóa
                        </span>
                      ) : (
                        <span
                          className={`${badgeBaseClassName} ${DEVICE_STATUS_BADGE_TONE[device.status]}`}
                        >
                          {deviceStatusLabel(device.status)}
                        </span>
                      )}
                      {disconnected && (
                        <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">
                          Mất kết nối
                        </span>
                      )}
                    </div>
                  </div>
                  <dl className="mt-4 space-y-1.5 text-sm">
                    <div className="flex justify-between gap-4">
                      <dt className="shrink-0 text-slate-500">Hệ điều hành</dt>
                      <dd className="min-w-0 break-words text-right text-slate-800">{device.os_version ?? '—'}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="shrink-0 text-slate-500">Phiên bản Agent</dt>
                      <dd className="min-w-0 break-words text-right text-slate-800">{device.agent_version ?? '—'}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="shrink-0 text-slate-500">Hoạt động gần nhất</dt>
                      <dd className="min-w-0 break-words text-right text-slate-800" title={formatDateTimeVi(device.last_seen_at)}>
                        {formatRelativeVi(device.last_seen_at)}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="shrink-0 text-slate-500">Extension trình duyệt</dt>
                      <dd
                        className={`min-w-0 break-words text-right ${extension.className}`}
                        title={extensionSeenAt ? formatDateTimeVi(extensionSeenAt) : undefined}
                      >
                        {extension.label}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="shrink-0 text-slate-500">Thi hành</dt>
                      <dd className="min-w-0 break-words text-right text-slate-800">
                        {enforcementSnapshot ? (
                          <span className="inline-flex flex-col items-end gap-1">
                            <span
                              className={`${badgeBaseClassName} ${enforcementSupersededByUnlock ? 'bg-amber-100 text-amber-800' : ENFORCEMENT_BADGE_TONE[enforcementSnapshot.decision]}`}
                            >
                              {enforcementSupersededByUnlock
                                ? 'Đang mở khóa'
                                : enforcementDecisionLabel(enforcementSnapshot.decision)}
                            </span>
                            {!enforcementSupersededByUnlock && enforcementSnapshot.reasons.length > 0 && (
                              <span className="text-xs text-slate-500">
                                Theo luật:{' '}
                                {enforcementSnapshot.reasons.map(enforcementReasonLabel).join(', ')}
                              </span>
                            )}
                            <span className="text-xs text-slate-500">
                              {enforcementSupersededByUnlock ? (
                                <>
                                  Trước khi mở khóa: {enforcementDecisionLabel(enforcementSnapshot.decision)}
                                  {', cập nhật '}
                                  {enforcement?.updatedAt
                                    ? formatRelativeVi(enforcement.updatedAt)
                                    : 'không rõ thời điểm'}
                                </>
                              ) : (
                                <>
                                  Cập nhật{' '}
                                  {enforcement?.updatedAt
                                    ? formatRelativeVi(enforcement.updatedAt)
                                    : 'không rõ thời điểm'}
                                </>
                              )}
                              {!enforcementSupersededByUnlock && enforcementStale && (
                                <span className="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                                  Dữ liệu cũ
                                </span>
                              )}
                            </span>
                          </span>
                        ) : (
                          <span className="text-slate-500">Chưa có dữ liệu thi hành</span>
                        )}
                        <span className="mt-1 block text-xs text-slate-500">
                          Trạng thái thi hành của con đang ngồi trên máy — chưa phân biệt được con nào.
                        </span>
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="shrink-0 text-slate-500">Ngày thêm</dt>
                      <dd className="min-w-0 break-words text-right text-slate-800">{formatDateTimeVi(device.created_at)}</dd>
                    </div>
                  </dl>
                  <div className="mt-4 border-t border-slate-100 pt-4">
                    <p className="mb-2 text-sm font-medium text-slate-700">Con dùng máy này</p>
                    {!childAccountsAvailable ? (
                      <p className="text-sm text-slate-600">
                        Chưa có dữ liệu gắn con cho máy này — cần áp migration 24 (Sprint 5 đợt 1) rồi tải
                        lại trang. Tới lúc đó máy chỉ quản lý theo hồ sơ mặc định như trước.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {device.child_id && (
                          <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm">
                            <span>
                              <span className="font-medium text-slate-900">
                                {childNameById.get(device.child_id) ?? 'Không rõ con'}
                              </span>{' '}
                              <span className="text-slate-500">— hồ sơ mặc định của máy</span>
                            </span>
                            <span className="shrink-0 rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800">
                              Mặc định
                            </span>
                          </div>
                        )}
                        {deviceLinkedAccounts
                          .filter((a) => a.child_id !== device.child_id)
                          .map((account) => {
                            const unlinkKey = `${device.id}:${account.windows_sid}`
                            const confirmingUnlink = confirmUnlinkKey === unlinkKey
                            return (
                              <div
                                key={account.id}
                                className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm"
                              >
                                <span className="min-w-0">
                                  <span className="font-medium text-slate-900">
                                    {childNameById.get(account.child_id) ?? 'Không rõ con'}
                                  </span>{' '}
                                  <span className="break-words text-slate-500">
                                    — tài khoản Windows {account.windows_username ?? 'không rõ tên'}{' '}
                                    <span title={account.windows_sid} className="text-xs">
                                      ({shortSid(account.windows_sid)})
                                    </span>
                                  </span>
                                </span>
                                {confirmingUnlink ? (
                                  <span className="flex shrink-0 gap-2">
                                    <button
                                      type="button"
                                      onClick={() => void handleUnlinkChildAccount(device, account)}
                                      disabled={unlinkingKey === unlinkKey}
                                      className={dangerButtonClassName}
                                    >
                                      {unlinkingKey === unlinkKey ? 'Đang gỡ…' : 'Xác nhận gỡ'}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setConfirmUnlinkKey(null)}
                                      className={secondaryButtonClassName}
                                    >
                                      Huỷ
                                    </button>
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setConfirmUnlinkKey(unlinkKey)}
                                    className={dangerOutlineButtonClassName}
                                  >
                                    Gỡ
                                  </button>
                                )}
                              </div>
                            )
                          })}
                        {deviceTargetChildIds.length === 0 && (
                          <p className="text-sm text-slate-600">
                            Máy này chưa gán cho hồ sơ con nào. Hãy ghép nối máy cho một con ở cuối trang, hoặc
                            gắn tài khoản Windows của con với máy này ở dưới.
                          </p>
                        )}
                        {linkableChildren.length > 0 && (
                          <div className="grid gap-3 pt-1 sm:grid-cols-2">
                            <Field label="Gắn thêm hồ sơ con" htmlFor={`link-child-${device.id}`}>
                              <select
                                id={`link-child-${device.id}`}
                                value={effectiveLinkChildId}
                                onChange={(e) =>
                                  setLinkChildIdByDevice((prev) => ({ ...prev, [device.id]: e.target.value }))
                                }
                                disabled={linkingDeviceId === device.id}
                                className={inputClassName}
                              >
                                {linkableChildren.map((child) => (
                                  <option key={child.id} value={child.id}>
                                    {child.display_name}
                                  </option>
                                ))}
                              </select>
                            </Field>
                            <Field label="Tài khoản Windows" htmlFor={`link-account-${device.id}`}>
                              <select
                                id={`link-account-${device.id}`}
                                value={effectiveLinkSid}
                                onChange={(e) =>
                                  setLinkSidByDevice((prev) => ({ ...prev, [device.id]: e.target.value }))
                                }
                                disabled={linkingDeviceId === device.id || deviceUnmappedSeen.length === 0}
                                className={inputClassName}
                              >
                                {deviceUnmappedSeen.map((seen) => (
                                  <option key={seen.windows_sid} value={seen.windows_sid}>
                                    {seen.windows_username ?? 'Không rõ tên'}
                                    {seen.is_admin ? ' (quản trị)' : ''}
                                  </option>
                                ))}
                              </select>
                            </Field>
                          </div>
                        )}
                        {linkableChildren.length > 0 && (
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void handleLinkChildAccount(device)}
                              disabled={
                                linkingDeviceId === device.id ||
                                !seenAccountsAvailable ||
                                deviceUnmappedSeen.length === 0
                              }
                              className={secondaryButtonClassName}
                              title={
                                !seenAccountsAvailable
                                  ? 'Chưa có dữ liệu tài khoản Windows — cần migration 25 + bản Agent mới'
                                  : undefined
                              }
                            >
                              {linkingDeviceId === device.id ? 'Đang gắn…' : 'Gắn tài khoản với con'}
                            </button>
                            {seenAccountsAvailable && deviceUnmappedSeen.length === 0 && (
                              <p className="text-xs text-slate-500">
                                Không còn tài khoản Windows nào chưa gắn trên máy này.
                              </p>
                            )}
                          </div>
                        )}
                        {!seenAccountsAvailable && (
                          <p className="text-xs text-slate-500">
                            Chưa có dữ liệu tài khoản Windows trên máy này — cần migration 25 + bản Agent
                            mới để liệt kê tài khoản và gắn (xem ghi chú thiết kế trong mã nguồn).
                          </p>
                        )}
                      </div>
                    )}
                    {seenAccountsAvailable && unmappedStandardAccounts.length > 0 && (
                      <AlertBox tone="warning" className="mt-3">
                        <p className="font-medium">
                          Tài khoản chưa gắn — không được quản lý trên máy này:
                        </p>
                        <ul className="mt-1 list-disc space-y-1 pl-5">
                          {unmappedStandardAccounts.map((seen) => (
                            <li key={seen.windows_sid}>
                              {seen.windows_username ?? 'Không rõ tên'} — tài khoản Standard này đang dùng máy
                              nhưng chưa gắn với hồ sơ con nào nên không áp quy tắc, không tính giờ. Hãy gắn
                              tài khoản với hồ sơ con ở trên.
                            </li>
                          ))}
                        </ul>
                      </AlertBox>
                    )}
                  </div>
                  <div className="mt-4 border-t border-slate-100 pt-4">
                    <p className="mb-2 text-sm font-medium text-slate-700">Khóa máy ngay</p>
                    {pickerChildIds.length > 0 ? (
                      <div className="mb-3">
                        <Field label="Áp dụng cho con" htmlFor={`target-child-${device.id}`}>
                          <select
                            id={`target-child-${device.id}`}
                            value={targetChildId}
                            onChange={(e) =>
                              setTargetChildByDevice((prev) => ({ ...prev, [device.id]: e.target.value }))
                            }
                            disabled={pickerChildIds.length === 1}
                            className={inputClassName}
                          >
                            {pickerChildIds.map((id) => (
                              <option key={id} value={id}>
                                {childNameById.get(id) ?? 'Không rõ con'}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <p className="mt-1 text-xs text-slate-500">
                          Lệnh khóa, mở khóa và hủy ghi đè dưới đây đều áp dụng cho con này trên máy này.
                        </p>
                      </div>
                    ) : (
                      <p className="mb-3 text-sm text-slate-600">
                        Máy chưa gán cho hồ sơ con nào — lệnh khóa/mở sẽ không gắn được với con nào.
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2" role="group" aria-label="Độ trễ trước khi khóa">
                      {LOCK_DELAYS.map((delay) => (
                        <button
                          key={delay}
                          type="button"
                          onClick={() =>
                            setLockDelayByDevice((prev) => ({ ...prev, [device.id]: delay }))
                          }
                          aria-pressed={lockDelay === delay}
                          className={chipClassName(lockDelay === delay)}
                        >
                          {delay === 0 ? 'Khóa ngay' : `${delay} phút`}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleLockNow(device)}
                      disabled={lockingId === device.id}
                      className={`${dangerButtonClassName} mt-3`}
                    >
                      {lockingId === device.id ? 'Đang gửi lệnh…' : 'Khóa ngay'}
                    </button>
                    <p className="mt-2 text-xs text-slate-500">
                      {lockDelay > 0
                        ? `Máy con sẽ hiện cửa sổ cảnh báo nhỏ trong ${lockDelay} phút để lưu bài làm, sau đó mới khóa.`
                        : 'Lệnh khóa được ghi vào bảng commands để Agent trên máy con nhận và thi hành.'}
                    </p>
                  </div>
                  <div className="mt-4 border-t border-slate-100 pt-4">
                    <p className="mb-2 text-sm font-medium text-slate-700">Mở khóa ngay</p>
                    {activeUnlockExpiresAt ? (
                      <AlertBox tone="warning">
                        <p>
                          Đang mở khóa, còn{' '}
                          {formatCountdown(
                            Math.max(0, Math.floor((activeUnlockExpiresAt.getTime() - Date.now()) / 1000)),
                          )}
                        </p>
                        <button
                          type="button"
                          onClick={() => void handleCancelDeviceOverride(device)}
                          disabled={cancellingUnlockId === device.id}
                          className={`mt-2 ${warningButtonClassName}`}
                        >
                          {cancellingUnlockId === device.id ? 'Đang gửi…' : 'Hủy'}
                        </button>
                      </AlertBox>
                    ) : (
                      <>
                        <div className="flex flex-wrap gap-2" role="group" aria-label="Thời lượng mở khóa">
                          {UNLOCK_DURATIONS.map((minutes) => (
                            <button
                              key={minutes}
                              type="button"
                              onClick={() =>
                                setUnlockMinutesByDevice((prev) => ({ ...prev, [device.id]: minutes }))
                              }
                              aria-pressed={unlockMinutes === minutes}
                              className={chipClassName(unlockMinutes === minutes)}
                            >
                              {minutes} phút
                            </button>
                          ))}
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleUnlockNow(device)}
                          disabled={sendingUnlockId === device.id}
                          className={`${primaryButtonClassName} mt-3`}
                        >
                          {sendingUnlockId === device.id ? 'Đang gửi…' : 'Mở khóa ngay'}
                        </button>
                        <p className="mt-2 text-xs text-slate-500">
                          Các quy tắc giờ giấc tạm ngưng trong thời gian đã chọn, sau đó áp dụng lại như cũ.
                        </p>
                      </>
                    )}
                  </div>
                  {pendingCommandsForDevice.length > 0 && (
                    <div className="mt-4 border-t border-slate-100 pt-4">
                      <p className="mb-2 text-sm font-medium text-slate-700">Lệnh đang chờ trên máy này</p>
                      <ul className="space-y-1.5 text-sm">
                        {pendingCommandsForDevice.map((command) => {
                          const pendingState = describePendingCommand(
                            command,
                            device,
                            childNameById,
                            Date.now(),
                          )
                          const commandTargetId =
                            command.child_id ?? device.child_id ?? null
                          return (
                            <li
                              key={command.id}
                              className="rounded-lg bg-slate-50 px-3 py-2 text-slate-700"
                            >
                              <span className="font-medium text-slate-900">
                                {pendingCommandLabel(command)}
                              </span>
                              {commandTargetId && (
                                <> cho {childNameById.get(commandTargetId) ?? 'con'}</>
                              )}{' '}
                              <span className="text-slate-500">
                                · gửi lúc {formatTimeVi(command.created_at)}
                              </span>
                              {pendingState && (
                                <span
                                  className={
                                    pendingState.kind === 'waiting-child' ||
                                  pendingState.kind === 'expired' ||
                                  pendingState.kind === 'stuck'
                                      ? 'mt-0.5 block font-medium text-amber-700'
                                      : 'mt-0.5 block text-slate-500'
                                  }
                                >
                                  {pendingState.text}
                                </span>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                      <p className="mt-2 text-xs text-slate-500">
                        Trạng thái “sẽ áp dụng khi con đăng nhập” được suy ra từ lệnh còn chờ trong khi máy
                        vẫn online — Agent chưa báo riêng trạng thái hoãn.
                      </p>
                    </div>
                  )}
                  <div className="mt-4 border-t border-slate-100 pt-4">
                    <p className="mb-2 text-sm font-medium text-slate-700">Mã PIN thoát Tray</p>
                    <p className="text-sm text-slate-600">
                      {device.exit_pin_hash
                        ? 'Đã đặt mã PIN. Muốn thoát Tray trên máy này phải nhập đúng mã PIN. Mỗi mã chỉ dùng được một lần: nhập đúng và thoát xong, mã tự gỡ và cần đặt mã mới. Gỡ cài đặt không làm mất mã PIN.'
                        : 'Chưa đặt mã PIN. Khi chưa có PIN, không ai thoát được Tray trên máy này.'}
                    </p>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <Field label="Mã PIN mới (6 số)" htmlFor={`pin-${device.id}`}>
                        <input
                          id={`pin-${device.id}`}
                          type="password"
                          inputMode="numeric"
                          autoComplete="off"
                          maxLength={6}
                          value={pinByDevice[device.id] ?? ''}
                          onChange={(e) =>
                            setPinByDevice((prev) => ({ ...prev, [device.id]: e.target.value }))
                          }
                          className={inputClassName}
                          placeholder="6 chữ số"
                        />
                      </Field>
                      <Field label="Nhập lại mã PIN" htmlFor={`pin-confirm-${device.id}`}>
                        <input
                          id={`pin-confirm-${device.id}`}
                          type="password"
                          inputMode="numeric"
                          autoComplete="off"
                          maxLength={6}
                          value={pinConfirmByDevice[device.id] ?? ''}
                          onChange={(e) =>
                            setPinConfirmByDevice((prev) => ({ ...prev, [device.id]: e.target.value }))
                          }
                          className={inputClassName}
                          placeholder="Nhập lại 6 chữ số"
                        />
                      </Field>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void handleSavePin(device)}
                        disabled={savingPinId === device.id}
                        className={primaryButtonClassName}
                      >
                        {savingPinId === device.id ? 'Đang lưu…' : 'Lưu mã PIN'}
                      </button>
                      {device.exit_pin_hash && (
                        <button
                          type="button"
                          onClick={() => void handleRemovePin(device)}
                          disabled={removingPinId === device.id}
                          className={secondaryButtonClassName}
                        >
                          {removingPinId === device.id ? 'Đang gỡ…' : 'Gỡ mã PIN'}
                        </button>
                      )}
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      Mã PIN chỉ được lưu dạng băm, không lưu PIN thô. Đừng dùng chung với mật khẩu
                      đăng nhập. Mã PIN này cũng là mã gỡ cài đặt: gỡ SafePC khỏi máy (Control
                      Panel / bộ cài) cũng yêu cầu nhập đúng mã PIN này. Gỡ cài đặt không làm mất
                      mã PIN. Chưa đặt mã PIN thì gỡ bằng quyền Admin như trước.
                    </p>
                  </div>
                  <div className="mt-4 border-t border-slate-100 pt-4">
                    <div className="flex flex-wrap gap-2">
                      {confirmingDeleteDevice ? (
                        <>
                          <button
                            type="button"
                            onClick={() => void handleDeleteDevice(device)}
                            disabled={deletingDeviceId === device.id}
                            className={dangerButtonClassName}
                          >
                            {deletingDeviceId === device.id ? 'Đang xóa…' : 'Xác nhận xóa'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteDeviceId(null)}
                            className={secondaryButtonClassName}
                          >
                            Huỷ
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteDeviceId(device.id)}
                          className={dangerOutlineButtonClassName}
                        >
                          Xóa thiết bị
                        </button>
                      )}
                    </div>
                    {confirmingDeleteDevice && (
                      <p className="mt-2 text-xs text-slate-500">
                        Xóa thiết bị sẽ xóa cả lịch sử dùng máy, lịch sử web và lệnh chờ của máy này. Các
                        quy tắc của con vẫn giữ nguyên.
                      </p>
                    )}
                  </div>
                </Card>
                )
              })}
            </div>
          )}

          <Card title="Ghép nối máy mới">
            {children.length === 0 ? (
              <p className="text-sm text-slate-700">
                Cần tạo hồ sơ con trước khi ghép nối máy. Hãy bấm nút “Thêm hồ sơ con” ở trên.
              </p>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Ghép nối máy cho con" htmlFor="pair-child">
                    <select
                      id="pair-child"
                      value={pairChildId}
                      onChange={(e) => setPairChildId(e.target.value)}
                      disabled={pairing?.status === 'waiting' || !!childIdFilter}
                      className={inputClassName}
                    >
                      {(childIdFilter ? children.filter((c) => c.id === childIdFilter) : children).map((child) => (
                        <option key={child.id} value={child.id}>
                          {child.display_name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                {pairError && (
                  <AlertBox tone="error">
                    Không tạo được mã ghép nối: {pairError}
                  </AlertBox>
                )}

                {pairing?.status === 'waiting' && (
                  <div className="space-y-3">
                    <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 text-center">
                      <p className="text-sm text-indigo-800">Mã ghép nối (chỉ hiển thị một lần tại đây):</p>
                      <p className="mt-1 font-mono text-4xl font-bold tracking-[0.3em] text-indigo-900">
                        {pairing.code}
                      </p>
                      <p className="mt-2 text-sm font-medium text-indigo-800">
                        Còn hiệu lực: {formatCountdown(Math.max(0, Math.floor((pairing.expiresAtMs - nowMs) / 1000)))}
                      </p>
                    </div>
                    <ol className="list-decimal space-y-1.5 pl-5 text-sm text-slate-700">
                      <li>
                        Chạy bộ cài PC Agent trên máy Windows của con bằng tài khoản Admin (nếu chưa cài), rồi nhập
                        mã 6 số trên vào trang ghép nối hiện sau bước chép file.
                      </li>
                      <li>Hoặc ghép nối sau bằng PowerShell (quyền Administrator) với lệnh dưới đây — chỉ dùng để debug:</li>
                    </ol>
                    <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-sm text-slate-100">
                      {`& 'C:\\Program Files\\SafePC Agent\\Service\\SafePC.Agent.Service.exe' pair ${pairing.code}`}
                    </pre>
                    <p className="text-sm text-slate-600">
                      Dashboard đang chờ máy con ghép nối và tự kiểm tra mỗi 5 giây. Mã hết hạn sau 5 phút.
                    </p>
                    <button type="button" onClick={handleCancelPairing} className={secondaryButtonClassName}>
                      Huỷ mã này
                    </button>
                  </div>
                )}

                {pairing?.status === 'paired' && (
                  <AlertBox tone="success">
                    Đã ghép nối: {pairing.pairedDevice?.hostname ?? 'máy mới'}. Máy đã xuất hiện trong danh sách
                    thiết bị ở trên.
                  </AlertBox>
                )}

                {pairing?.status === 'expired' && (
                  <AlertBox tone="warning">
                    Mã đã hết hạn, hãy tạo mã mới.
                  </AlertBox>
                )}

                {pairing?.status !== 'waiting' && (
                  <button
                    type="button"
                    onClick={() => void handleCreatePairingCode()}
                    disabled={!pairChildId || creatingCode}
                    className={primaryButtonClassName}
                  >
                    {creatingCode ? 'Đang tạo mã…' : pairing ? 'Tạo mã ghép nối mới' : 'Tạo mã ghép nối'}
                  </button>
                )}
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  )
}
