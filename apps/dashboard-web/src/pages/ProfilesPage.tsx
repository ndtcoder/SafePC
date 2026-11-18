import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import type { Child, Device } from '../lib/types'
import { formatRelativeVi, toVietnameseError } from '../lib/format'
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  NotConfiguredState,
  PageHeader,
  primaryButtonClassName,
  secondaryButtonClassName,
} from '../components/ui'
import FamilyInviteSection from '../components/FamilyInviteSection'

type LoadState = 'loading' | 'ready' | 'error'

/** Máy coi là đang trực tuyến khi heartbeat chưa quá 10 phút (cùng ngưỡng với trang Thiết bị). */
function isOnline(device: Device, nowMs: number): boolean {
  if (!device.last_seen_at) return false
  return nowMs - new Date(device.last_seen_at).getTime() <= 10 * 60 * 1000
}

/**
 * Trang Hồ sơ: một thẻ cho mỗi con, bấm vào để xem Thiết bị, Quy tắc và
 * Báo cáo của riêng con đó (theo hướng Family Safety, yêu cầu 17/11/2026).
 * Trang Thiết bị/Quy tắc cũ vẫn hoạt động ở đường dẫn riêng cho mọi con.
 */
export default function ProfilesPage() {
  const { configured, user } = useAuth()
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [children, setChildren] = useState<Child[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [pendingByChild, setPendingByChild] = useState<Map<string, number>>(new Map())

  const load = useCallback(async () => {
    if (!supabase || !user) {
      setState('ready')
      return
    }
    setState('loading')
    setError('')
    try {
      const [childrenResult, devicesResult, requestsResult] = await Promise.all([
        supabase
          .from('children')
          .select('id, family_id, display_name, birth_year, avatar_url, created_at')
          .order('created_at', { ascending: true }),
        supabase
          .from('devices')
          .select('id, family_id, child_id, hostname, os_version, agent_version, last_seen_at, status, created_at'),
        supabase.from('requests').select('id, child_id, status').eq('status', 'pending'),
      ])
      if (childrenResult.error) throw childrenResult.error
      if (devicesResult.error) throw devicesResult.error
      if (requestsResult.error) throw requestsResult.error
      setChildren((childrenResult.data ?? []) as Child[])
      setDevices((devicesResult.data ?? []) as Device[])
      const counts = new Map<string, number>()
      for (const row of (requestsResult.data ?? []) as Array<{ child_id: string }>) {
        counts.set(row.child_id, (counts.get(row.child_id) ?? 0) + 1)
      }
      setPendingByChild(counts)
      setState('ready')
    } catch (err) {
      setError(toVietnameseError(err))
      setState('error')
    }
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  if (!configured) {
    return (
      <div>
        <PageHeader title="Hồ sơ các con" />
        <NotConfiguredState />
      </div>
    )
  }

  if (state === 'loading') return <LoadingState />
  if (state === 'error') return <ErrorState message={error} onRetry={() => void load()} />

  if (children.length === 0) {
    return (
      <div>
        <PageHeader
          title="Hồ sơ các con"
          description="Mỗi con có một hồ sơ riêng: thiết bị, quy tắc và báo cáo của con đó."
        />
        <EmptyState
          title="Chưa có hồ sơ con nào"
          description="Hãy làm 3 bước sau để bắt đầu quản lý máy tính của con. Các bước này chỉ cần làm một lần cho mỗi con."
        >
          <ol className="mx-auto max-w-xl list-decimal space-y-1 pl-5 text-left text-sm text-slate-600">
            <li>Tạo gia đình và hồ sơ cho con ở trang Thiết bị (nút “Thêm hồ sơ con”).</li>
            <li>Cài PC Agent lên máy của con rồi ghép nối máy bằng mã ghép nối.</li>
            <li>Chọn mẫu quy tắc phù hợp ở trang Quy tắc, hoặc tạo quy tắc riêng cho con.</li>
          </ol>
          <Link to="/thiet-bi" className={`${primaryButtonClassName} mt-4`}>
            Tới trang Thiết bị để thêm hồ sơ con
          </Link>
        </EmptyState>
        <div className="mt-6">
          <FamilyInviteSection />
        </div>
      </div>
    )
  }

  const nowMs = Date.now()

  return (
    <div>
      <PageHeader
        title="Hồ sơ các con"
        description="Chọn một hồ sơ để xem thiết bị, quy tắc và báo cáo tổng hợp của riêng con đó."
      />
      <div className="grid gap-3 sm:gap-4 md:grid-cols-2">
        {children.map((child) => {
          const childDevices = devices.filter((d) => d.child_id === child.id)
          const onlineCount = childDevices.filter((d) => isOnline(d, nowMs)).length
          const pending = pendingByChild.get(child.id) ?? 0
          const lastSeenMs = Math.max(
            0,
            ...childDevices.map((d) => (d.last_seen_at ? new Date(d.last_seen_at).getTime() : 0)),
          )
          return (
            <Card key={child.id} title={child.display_name}>
              <dl className="space-y-1.5 text-sm text-slate-600">
                {child.birth_year != null && (
                  <div className="flex justify-between gap-4">
                    <dt>Năm sinh</dt>
                    <dd className="font-medium text-slate-900">{child.birth_year}</dd>
                  </div>
                )}
                <div className="flex justify-between gap-4">
                  <dt>Thiết bị</dt>
                  <dd className="font-medium text-slate-900">
                    {childDevices.length === 0
                      ? 'Chưa ghép nối máy nào'
                      : `${onlineCount}/${childDevices.length} đang trực tuyến`}
                  </dd>
                </div>
                {lastSeenMs > 0 && (
                  <div className="flex justify-between gap-4">
                    <dt>Thấy lần cuối</dt>
                    <dd className="font-medium text-slate-900">
                      {formatRelativeVi(new Date(lastSeenMs).toISOString())}
                    </dd>
                  </div>
                )}
                <div className="flex justify-between gap-4">
                  <dt>Yêu cầu đang chờ</dt>
                  <dd className="font-medium text-slate-900">
                    {pending === 0 ? 'Không có' : `${pending} yêu cầu`}
                  </dd>
                </div>
              </dl>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link
                  to={`/ho-so/${child.id}/thiet-bi`}
                  className={primaryButtonClassName}
                >
                  Vào hồ sơ
                </Link>
                <Link
                  to={`/ho-so/${child.id}/bao-cao`}
                  className={secondaryButtonClassName}
                >
                  Xem báo cáo
                </Link>
              </div>
            </Card>
          )
        })}
      </div>
      <div className="mt-6">
        <FamilyInviteSection />
      </div>
    </div>
  )
}
