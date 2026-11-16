import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import type { AppUsage, Child, Device } from '../lib/types'
import {
  formatDurationVi,
  formatRelativeVi,
  formatTimeVi,
  startOfTodayIso,
  toVietnameseError,
} from '../lib/format'
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  NotConfiguredState,
  PageHeader,
  secondaryButtonClassName,
} from '../components/ui'

interface TopApp {
  appName: string
  totalSec: number
  sessions: number
}

type LoadState = 'loading' | 'ready' | 'error'

export default function TodayPage() {
  const { configured, user } = useAuth()
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [usage, setUsage] = useState<AppUsage[]>([])
  const [children, setChildren] = useState<Child[]>([])
  const [devices, setDevices] = useState<Device[]>([])

  const load = useCallback(async () => {
    if (!supabase || !user) {
      setState('ready')
      return
    }
    setState('loading')
    setError('')
    try {
      const [usageResult, childrenResult, devicesResult] = await Promise.all([
        supabase
          .from('app_usage')
          .select('id, family_id, device_id, child_id, app_name, exe_path_hash, started_at, duration_sec, created_at')
          .gte('started_at', startOfTodayIso())
          .order('started_at', { ascending: false })
          .limit(500),
        supabase
          .from('children')
          .select('id, family_id, display_name, birth_year, avatar_url, created_at'),
        supabase
          .from('devices')
          .select('id, family_id, child_id, hostname, os_version, agent_version, last_seen_at, status, created_at'),
      ])
      if (usageResult.error) throw usageResult.error
      if (childrenResult.error) throw childrenResult.error
      if (devicesResult.error) throw devicesResult.error
      setUsage((usageResult.data ?? []) as AppUsage[])
      setChildren((childrenResult.data ?? []) as Child[])
      setDevices((devicesResult.data ?? []) as Device[])
      setState('ready')
    } catch (err) {
      setError(toVietnameseError(err))
      setState('error')
    }
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  const childNameById = useMemo(
    () => new Map(children.map((c) => [c.id, c.display_name])),
    [children],
  )
  const deviceNameById = useMemo(
    () => new Map(devices.map((d) => [d.id, d.hostname])),
    [devices],
  )

  const totalSec = useMemo(
    () => usage.reduce((sum, row) => sum + (row.duration_sec ?? 0), 0),
    [usage],
  )

  const topApps = useMemo<TopApp[]>(() => {
    const byApp = new Map<string, TopApp>()
    for (const row of usage) {
      const current = byApp.get(row.app_name) ?? { appName: row.app_name, totalSec: 0, sessions: 0 }
      current.totalSec += row.duration_sec ?? 0
      current.sessions += 1
      byApp.set(row.app_name, current)
    }
    return [...byApp.values()].sort((a, b) => b.totalSec - a.totalSec).slice(0, 8)
  }, [usage])

  const maxTopSec = topApps.length > 0 ? topApps[0].totalSec : 0
  const todayLabel = new Date().toLocaleDateString('vi-VN', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })

  if (!configured) {
    return (
      <>
        <PageHeader title="Hôm nay" description={`Tổng quan thời gian sử dụng máy tính — ${todayLabel}.`} />
        <NotConfiguredState />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Hôm nay"
        description={`Tổng quan thời gian sử dụng máy tính — ${todayLabel}. Số liệu được tính từ dữ liệu thật do Agent gửi lên.`}
        actions={
          <button type="button" onClick={() => void load()} className={secondaryButtonClassName}>
            Tải lại
          </button>
        }
      />

      {state === 'loading' && <LoadingState label="Đang tải dữ liệu hôm nay…" />}
      {state === 'error' && <ErrorState message={error} onRetry={() => void load()} />}

      {state === 'ready' && usage.length === 0 && (
        <EmptyState
          title="Chưa có dữ liệu hôm nay"
          description="Agent chưa gửi dữ liệu sử dụng nào cho ngày hôm nay. Có thể máy con chưa được dùng, chưa ghép nối, hoặc Agent chưa đồng bộ dữ liệu lên."
        />
      )}

      {state === 'ready' && usage.length > 0 && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <p className="text-sm text-slate-500">Tổng thời gian hôm nay</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{formatDurationVi(totalSec)}</p>
            </Card>
            <Card>
              <p className="text-sm text-slate-500">Số ứng dụng đã dùng</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{topApps.length}</p>
            </Card>
            <Card>
              <p className="text-sm text-slate-500">Số phiên sử dụng</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{usage.length}</p>
            </Card>
          </div>

          <Card title="Ứng dụng dùng nhiều nhất hôm nay">
            {topApps.length === 0 ? (
              <p className="text-sm text-slate-600">Chưa có ứng dụng nào được ghi nhận.</p>
            ) : (
              <ul className="space-y-3">
                {topApps.map((app) => (
                  <li key={app.appName}>
                    <div className="flex items-baseline justify-between gap-4 text-sm">
                      <span className="min-w-0 truncate font-medium text-slate-800">{app.appName}</span>
                      <span className="shrink-0 text-slate-600">
                        {formatDurationVi(app.totalSec)} · {app.sessions} phiên
                      </span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-indigo-600"
                        style={{ width: `${maxTopSec > 0 ? Math.round((app.totalSec / maxTopSec) * 100) : 0}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Hoạt động mới nhất">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="pb-2 pr-4 font-medium">Ứng dụng</th>
                    <th className="pb-2 pr-4 font-medium">Con</th>
                    <th className="pb-2 pr-4 font-medium">Máy</th>
                    <th className="pb-2 pr-4 font-medium">Bắt đầu</th>
                    <th className="pb-2 font-medium">Thời lượng</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.slice(0, 20).map((row) => (
                    <tr key={row.id} className="border-b border-slate-100 last:border-0">
                      <td className="py-2 pr-4 font-medium text-slate-800">{row.app_name}</td>
                      <td className="py-2 pr-4 text-slate-600">
                        {childNameById.get(row.child_id) ?? '—'}
                      </td>
                      <td className="py-2 pr-4 text-slate-600">
                        {deviceNameById.get(row.device_id) ?? '—'}
                      </td>
                      <td className="py-2 pr-4 text-slate-600" title={formatRelativeVi(row.started_at)}>
                        {formatTimeVi(row.started_at)}
                      </td>
                      <td className="py-2 text-slate-800">{formatDurationVi(row.duration_sec)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {usage.length > 20 && (
              <p className="mt-3 text-xs text-slate-500">
                Đang hiển thị 20 hoạt động mới nhất trong tổng số {usage.length} phiên hôm nay.
              </p>
            )}
          </Card>
        </div>
      )}
    </>
  )
}
