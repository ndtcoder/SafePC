import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { createFamily, getMyFamily } from '../lib/family'
import type { Child, Device, Family } from '../lib/types'
import {
  deviceStatusLabel,
  formatDateTimeVi,
  formatRelativeVi,
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

export default function DevicesPage() {
  const { configured, user } = useAuth()
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [family, setFamily] = useState<Family | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [children, setChildren] = useState<Child[]>([])
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [lockingId, setLockingId] = useState<string | null>(null)
  const [creatingFamily, setCreatingFamily] = useState(false)

  // Form tạo hồ sơ con (tối thiểu): tên hiển thị + năm sinh.
  const [showChildForm, setShowChildForm] = useState(false)
  const [childName, setChildName] = useState('')
  const [birthYear, setBirthYear] = useState('')
  const [savingChild, setSavingChild] = useState(false)

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
      setState('ready')
    } catch (err) {
      setError(toVietnameseError(err))
      setState('error')
    }
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

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
              {devices.map((device) => (
                <Card key={device.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-semibold text-slate-900">{device.hostname}</h2>
                      <p className="mt-0.5 text-sm text-slate-600">
                        {device.child_id ? (childNameById.get(device.child_id) ?? 'Chưa gán cho con nào') : 'Chưa gán cho con nào'}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_BADGE[device.status]}`}
                    >
                      {deviceStatusLabel(device.status)}
                    </span>
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
              ))}
            </div>
          )}

          <Card title="Ghép nối máy mới">
            <ol className="list-decimal space-y-1.5 pl-5 text-sm text-slate-700">
              <li>Tạo hồ sơ con (nút “Thêm hồ sơ con” ở trên) nếu chưa có.</li>
              <li>Cài PC Agent lên máy Windows của con bằng tài khoản Admin.</li>
              <li>Trên máy con, nhập mã ghép nối 6 số hiển thị trên Dashboard để liên kết máy với gia đình.</li>
            </ol>
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <p className="font-medium">Tính năng ghép nối đầy đủ thuộc Sprint 1.</p>
              <p className="mt-1">
                Mã ghép nối thật cần Edge Function phía Supabase (tạo mã, kiểm tra hết hạn 10 phút, đổi mã lấy
                device token). Edge Function chưa được triển khai nên hiện tại chưa tạo được mã thật trên
                Dashboard này — không hiển thị mã giả.
              </p>
            </div>
            <button type="button" disabled className={`${primaryButtonClassName} mt-4`} title="Cần Edge Function ở Sprint 1">
              Tạo mã ghép nối (Sprint 1)
            </button>
          </Card>
        </div>
      )}
    </>
  )
}
