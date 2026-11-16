import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { createFamily, getMyFamily } from '../lib/family'
import type { Child, Device, Family } from '../lib/types'
import {
  deviceStatusLabel,
  formatDateTimeVi,
  formatRelativeVi,
  formatTimeVi,
  toVietnameseError,
} from '../lib/format'
import {
  Card,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  NotConfiguredState,
  PageHeader,
  inputClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
} from '../components/ui'

const STATUS_BADGE: Record<Device['status'], string> = {
  online: 'bg-emerald-100 text-emerald-800',
  offline: 'bg-slate-200 text-slate-700',
  locked: 'bg-red-100 text-red-800',
}

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

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000

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

export default function DevicesPage() {
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
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [lockingId, setLockingId] = useState<string | null>(null)
  const [creatingFamily, setCreatingFamily] = useState(false)

  // Form tạo hồ sơ con (tối thiểu): tên hiển thị + năm sinh.
  const [showChildForm, setShowChildForm] = useState(false)
  const [childName, setChildName] = useState('')
  const [birthYear, setBirthYear] = useState('')
  const [savingChild, setSavingChild] = useState(false)

  // Ghép nối máy mới: mã 6 số dùng một lần, hiệu lực 10 phút. Mã dạng
  // plaintext chỉ hiển thị ở đây, một lần duy nhất; xuống database chỉ
  // lưu SHA-256 hex của mã (xem handleCreatePairingCode).
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
      const [familyResult, devicesResult, childrenResult] = await Promise.all([
        getMyFamily(supabase, user.id),
        supabase
          .from('devices')
          .select('id, family_id, child_id, hostname, os_version, agent_version, last_seen_at, status, created_at')
          .order('created_at', { ascending: true }),
        supabase
          .from('children')
          .select('id, family_id, display_name, birth_year, avatar_url, created_at')
          .order('created_at', { ascending: true }),
      ])
      if (devicesResult.error) throw devicesResult.error
      if (childrenResult.error) throw childrenResult.error
      setFamily(familyResult)
      setDevices((devicesResult.data ?? []) as Device[])
      setChildren((childrenResult.data ?? []) as Child[])
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
      setState('ready')
    } catch (err) {
      setError(toVietnameseError(err))
      setState('error')
    }
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  // Mặc định chọn con đầu tiên cho dropdown ghép nối (giống trang Quy tắc).
  useEffect(() => {
    if (!pairChildId && children.length > 0) setPairChildId(children[0].id)
  }, [children, pairChildId])

  // Đồng hồ đếm ngược khi đang chờ ghép nối; hết giờ thì đánh dấu hết hạn.
  useEffect(() => {
    if (pairing?.status !== 'waiting') return
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [pairing?.status])

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

  const handleLockNow = async (device: Device) => {
    if (!supabase || !user) return
    if (!family) {
      setActionError('Bạn chưa có gia đình. Vui lòng tạo gia đình trước khi gửi lệnh khóa máy.')
      return
    }
    setLockingId(device.id)
    setActionError(null)
    setActionMessage(null)
    try {
      const { error: insertError } = await supabase.from('commands').insert({
        family_id: device.family_id,
        device_id: device.id,
        type: 'lock_now',
        payload: {},
        status: 'pending',
      })
      if (insertError) throw insertError
      setActionMessage(
        `Đã gửi lệnh khóa máy tới "${device.hostname}". Agent trên máy con sẽ nhận lệnh khi online (polling/Realtime, Sprint 1).`,
      )
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setLockingId(null)
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
          <button
            type="button"
            onClick={() => setShowChildForm((v) => !v)}
            disabled={!family}
            className={secondaryButtonClassName}
            title={family ? undefined : 'Cần tạo gia đình trước'}
          >
            Thêm hồ sơ con
          </button>
        }
      />

      {actionMessage && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800" role="status">
          {actionMessage}
        </div>
      )}
      {actionError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
          {actionError}
        </div>
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
        <div className="space-y-6">
          {showChildForm && (
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
                <div className="flex gap-2 sm:col-span-2">
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

          {devices.length === 0 ? (
            <EmptyState
              title="Chưa có thiết bị nào"
              description="Chưa có máy tính nào được ghép nối với gia đình của bạn. Sau khi cài PC Agent lên máy của con và ghép nối thành công, máy sẽ xuất hiện tại đây."
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {devices.map((device) => {
                const extension = extensionStatus(extensionSeenByDevice.get(device.id), Date.now())
                const disconnected = isDisconnected(device, Date.now())
                const extensionSeenAt = extensionSeenByDevice.get(device.id)
                return (
                <Card key={device.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-semibold text-slate-900">{device.hostname}</h2>
                      <p className="mt-0.5 text-sm text-slate-600">
                        {device.child_id ? (childNameById.get(device.child_id) ?? 'Chưa gán cho con nào') : 'Chưa gán cho con nào'}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-2">
                      <span
                        className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_BADGE[device.status]}`}
                      >
                        {deviceStatusLabel(device.status)}
                      </span>
                      {disconnected && (
                        <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">
                          Mất kết nối
                        </span>
                      )}
                    </div>
                  </div>
                  <dl className="mt-4 space-y-1.5 text-sm">
                    <div className="flex justify-between gap-4">
                      <dt className="text-slate-500">Hệ điều hành</dt>
                      <dd className="text-slate-800">{device.os_version ?? '—'}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-slate-500">Phiên bản Agent</dt>
                      <dd className="text-slate-800">{device.agent_version ?? '—'}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-slate-500">Hoạt động gần nhất</dt>
                      <dd className="text-slate-800" title={formatDateTimeVi(device.last_seen_at)}>
                        {formatRelativeVi(device.last_seen_at)}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-slate-500">Extension trình duyệt</dt>
                      <dd
                        className={extension.className}
                        title={extensionSeenAt ? formatDateTimeVi(extensionSeenAt) : undefined}
                      >
                        {extension.label}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-slate-500">Ngày thêm</dt>
                      <dd className="text-slate-800">{formatDateTimeVi(device.created_at)}</dd>
                    </div>
                  </dl>
                  <div className="mt-4 border-t border-slate-100 pt-4">
                    <button
                      type="button"
                      onClick={() => void handleLockNow(device)}
                      disabled={lockingId === device.id}
                      className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {lockingId === device.id ? 'Đang gửi lệnh…' : 'Khóa ngay'}
                    </button>
                    <p className="mt-2 text-xs text-slate-500">
                      Lệnh khóa được ghi vào bảng commands để Agent trên máy con nhận và thi hành.
                    </p>
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
                      disabled={pairing?.status === 'waiting'}
                      className={inputClassName}
                    >
                      {children.map((child) => (
                        <option key={child.id} value={child.id}>
                          {child.display_name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                {pairError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
                    Không tạo được mã ghép nối: {pairError}
                  </div>
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
                      <li>Cài PC Agent lên máy Windows của con bằng tài khoản Admin (nếu chưa cài).</li>
                      <li>
                        Trên máy của con, mở PowerShell bằng quyền Administrator (chuột phải PowerShell → Run as
                        administrator) rồi chạy lệnh sau:
                      </li>
                    </ol>
                    <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-sm text-slate-100">
                      {`& 'C:\\Program Files\\SafePC Agent\\Service\\SafePC.Agent.Service.exe' pair ${pairing.code}`}
                    </pre>
                    <p className="text-sm text-slate-600">
                      Dashboard đang chờ máy con ghép nối và tự kiểm tra mỗi 5 giây. Mã hết hạn sau 10 phút.
                    </p>
                    <button type="button" onClick={handleCancelPairing} className={secondaryButtonClassName}>
                      Huỷ mã này
                    </button>
                  </div>
                )}

                {pairing?.status === 'paired' && (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800" role="status">
                    Đã ghép nối: {pairing.pairedDevice?.hostname ?? 'máy mới'}. Máy đã xuất hiện trong danh sách
                    thiết bị ở trên.
                  </div>
                )}

                {pairing?.status === 'expired' && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800" role="status">
                    Mã đã hết hạn, hãy tạo mã mới.
                  </div>
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
