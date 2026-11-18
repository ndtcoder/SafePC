import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import type { AppRequest, AppUsage, Device, Rule } from '../lib/types'
import {
  formatDateTimeVi,
  formatDurationVi,
  formatRelativeVi,
  requestTypeLabel,
  startOfTodayIso,
  toVietnameseError,
} from '../lib/format'
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  NotConfiguredState,
} from '../components/ui'

type LoadState = 'loading' | 'ready' | 'error'

interface TopApp {
  appName: string
  totalSec: number
}

/**
 * Tab Báo cáo trong hồ sơ của một con: tổng hợp riêng của con đó — giờ
 * dùng hôm nay, top ứng dụng, trạng thái thiết bị, yêu cầu gần đây và số
 * quy tắc đang bật. Chỉ dùng các cột của migration 1 (+ cột minutes của
 * migration 7 thì KHÔNG chọn, để tab sống cả khi migration 7 chưa áp).
 */
export default function ProfileReportTab({ childId, childName }: { childId: string; childName: string }) {
  const { configured, user } = useAuth()
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [usage, setUsage] = useState<AppUsage[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [requests, setRequests] = useState<AppRequest[]>([])
  const [rules, setRules] = useState<Rule[]>([])

  const load = useCallback(async () => {
    if (!supabase || !user) {
      setState('ready')
      return
    }
    setState('loading')
    setError('')
    try {
      const [usageResult, devicesResult, requestsResult, rulesResult] = await Promise.all([
        supabase
          .from('app_usage')
          .select('id, family_id, device_id, child_id, app_name, exe_path_hash, started_at, duration_sec, created_at')
          .eq('child_id', childId)
          .gte('started_at', startOfTodayIso())
          .order('started_at', { ascending: false })
          .limit(500),
        supabase
          .from('devices')
          .select('id, family_id, child_id, hostname, os_version, agent_version, last_seen_at, status, created_at')
          .eq('child_id', childId),
        supabase
          .from('requests')
          .select('id, family_id, child_id, type, status, reason, decided_by, decided_at, created_at')
          .eq('child_id', childId)
          .order('created_at', { ascending: false })
          .limit(10),
        supabase.from('rules').select('id, family_id, child_id, type, config, enabled, created_at').eq('child_id', childId),
      ])
      if (usageResult.error) throw usageResult.error
      if (devicesResult.error) throw devicesResult.error
      if (requestsResult.error) throw requestsResult.error
      if (rulesResult.error) throw rulesResult.error
      setUsage((usageResult.data ?? []) as AppUsage[])
      setDevices((devicesResult.data ?? []) as Device[])
      setRequests((requestsResult.data ?? []) as AppRequest[])
      setRules((rulesResult.data ?? []) as Rule[])
      setState('ready')
    } catch (err) {
      setError(toVietnameseError(err))
      setState('error')
    }
  }, [user, childId])

  useEffect(() => {
    void load()
  }, [load])

  const totalSec = useMemo(() => usage.reduce((sum, row) => sum + row.duration_sec, 0), [usage])
  const topApps = useMemo(() => {
    const byApp = new Map<string, number>()
    for (const row of usage) byApp.set(row.app_name, (byApp.get(row.app_name) ?? 0) + row.duration_sec)
    return [...byApp.entries()]
      .map(([appName, totalSec]) => ({ appName, totalSec }) satisfies TopApp)
      .sort((a, b) => b.totalSec - a.totalSec)
      .slice(0, 5)
  }, [usage])
  const pendingCount = useMemo(() => requests.filter((r) => r.status === 'pending').length, [requests])
  const enabledRules = useMemo(() => rules.filter((r) => r.enabled).length, [rules])

  if (!configured) return <NotConfiguredState />
  if (state === 'loading') return <LoadingState />
  if (state === 'error') return <ErrorState message={error} onRetry={() => void load()} />

  const nowMs = Date.now()

  return (
    <div className="grid gap-3 sm:gap-4">
      <div>
        <Link
          to={`/bao-cao?child=${childId}`}
          className="inline-flex min-h-[44px] items-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Xem báo cáo tuần của {childName}
        </Link>
      </div>
      <Card title={`Hôm nay của ${childName}`}>
        <dl className="grid gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-slate-600">Tổng giờ dùng máy</dt>
            <dd className="mt-0.5 text-lg font-semibold text-slate-900">{formatDurationVi(totalSec)}</dd>
          </div>
          <div>
            <dt className="text-sm text-slate-600">Quy tắc đang bật</dt>
            <dd className="mt-0.5 text-lg font-semibold text-slate-900">
              {enabledRules}/{rules.length}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-slate-600">Yêu cầu đang chờ duyệt</dt>
            <dd className="mt-0.5 text-lg font-semibold text-slate-900">{pendingCount}</dd>
          </div>
        </dl>
      </Card>

      <Card title="Ứng dụng dùng nhiều nhất hôm nay">
        {topApps.length === 0 ? (
          <EmptyState
            title="Chưa có dữ liệu dùng máy hôm nay"
            description="Khi con dùng máy, thời lượng theo từng ứng dụng sẽ hiện ở đây."
          />
        ) : (
          <ul className="space-y-2">
            {topApps.map((app) => (
              <li key={app.appName} className="flex items-center justify-between gap-4 text-sm">
                <span className="min-w-0 truncate font-medium text-slate-900">{app.appName}</span>
                <span className="shrink-0 text-slate-600">{formatDurationVi(app.totalSec)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Thiết bị">
        {devices.length === 0 ? (
          <EmptyState
            title="Chưa ghép nối máy nào"
            description="Ghép nối máy của con ở tab Thiết bị để bắt đầu theo dõi."
          />
        ) : (
          <ul className="space-y-2">
            {devices.map((device) => {
              const online =
                device.last_seen_at != null && nowMs - new Date(device.last_seen_at).getTime() <= 10 * 60 * 1000
              return (
                <li key={device.id} className="flex items-center justify-between gap-4 text-sm">
                  <span className="min-w-0 truncate font-medium text-slate-900">{device.hostname}</span>
                  <span className="shrink-0 text-slate-600">
                    {online ? 'Đang trực tuyến' : `Thấy lần cuối ${formatRelativeVi(device.last_seen_at)}`}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <Card title="Yêu cầu gần đây">
        {requests.length === 0 ? (
          <EmptyState title="Chưa có yêu cầu nào" description="Yêu cầu xin thêm giờ hoặc xin mở ứng dụng của con sẽ hiện ở đây." />
        ) : (
          <ul className="space-y-2">
            {requests.map((request) => (
              <li key={request.id} className="flex items-center justify-between gap-4 text-sm">
                <span className="min-w-0 truncate text-slate-900">
                  {requestTypeLabel(request.type)}
                  {request.reason ? ` — ${request.reason}` : ''}
                </span>
                <span className="shrink-0 text-slate-600">
                  {request.status === 'pending'
                    ? 'Đang chờ'
                    : request.status === 'approved'
                      ? 'Đã duyệt'
                      : 'Đã từ chối'}{' '}
                  · {formatDateTimeVi(request.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4">
          <Link
            to="/yeu-cau"
            className="inline-flex min-h-[44px] items-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Tới trang Yêu cầu để duyệt
          </Link>
        </div>
      </Card>
    </div>
  )
}
