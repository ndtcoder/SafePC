import { useCallback, useEffect, useState } from 'react'
import { Link, Navigate, NavLink, useParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import type { Child } from '../lib/types'
import { toVietnameseError } from '../lib/format'
import { ErrorState, LoadingState, NotConfiguredState, PageHeader, primaryButtonClassName, secondaryButtonClassName } from '../components/ui'
import DevicesPage from './DevicesPage'
import RulesPage from './RulesPage'
import ProfileReportTab from './ProfileReportTab'
import TimeBankTab from './TimeBankTab'
import ScreenCaptureTab from './ScreenCaptureTab'
import ChildDataTab from './ChildDataTab'
import ChatPanel from '../components/ChatPanel'

type LoadState = 'loading' | 'ready' | 'error'

const TABS = [
  { key: 'thiet-bi', label: 'Thiết bị' },
  { key: 'quy-tac', label: 'Quy tắc' },
  { key: 'bao-cao', label: 'Báo cáo' },
  { key: 'ngan-hang-gio', label: 'Ngân hàng giờ' },
  { key: 'nhan-tin', label: 'Nhắn tin' },
  { key: 'chup-man-hinh', label: 'Chụp màn hình' },
  { key: 'du-lieu', label: 'Dữ liệu' },
] as const

type TabKey = (typeof TABS)[number]['key']

function isTabKey(value: string | undefined): value is TabKey {
  return TABS.some((t) => t.key === value)
}

function tabClassName({ isActive }: { isActive: boolean }): string {
  return isActive
    ? 'inline-flex min-h-[44px] items-center rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 motion-reduce:transition-none'
    : 'inline-flex min-h-[44px] items-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 motion-reduce:transition-none'
}

/**
 * Hồ sơ của một con: các tab Thiết bị / Quy tắc / Báo cáo / Ngân hàng
 * giờ / Nhắn tin / Chụp màn hình / Dữ liệu, tất cả lọc theo đúng con đó. Tab Thiết bị và Quy tắc tái dùng
 * trang cũ với childIdFilter nên mọi thao tác (khóa/mở, PIN, ghép nối,
 * thêm quy tắc, ghi đè) đều như trang độc lập, chỉ khác là không lẫn
 * sang con khác. Tab Dữ liệu xuất/xóa dữ liệu của đúng con này.
 */
export default function ProfilePage() {
  const { configured, user } = useAuth()
  const { childId, tab } = useParams<{ childId: string; tab: string }>()
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [child, setChild] = useState<Child | null>(null)

  const load = useCallback(async () => {
    if (!supabase || !user || !childId) {
      setState('ready')
      return
    }
    setState('loading')
    setError('')
    try {
      const { data, error: childError } = await supabase
        .from('children')
        .select('id, family_id, display_name, birth_year, avatar_url, created_at')
        .eq('id', childId)
        .maybeSingle()
      if (childError) throw childError
      setChild((data ?? null) as Child | null)
      setState('ready')
    } catch (err) {
      setError(toVietnameseError(err))
      setState('error')
    }
  }, [user, childId])

  useEffect(() => {
    void load()
  }, [load])

  if (!isTabKey(tab)) {
    return <Navigate to={childId ? `/ho-so/${childId}/thiet-bi` : '/ho-so'} replace />
  }

  if (!configured) {
    return (
      <div>
        <PageHeader title="Hồ sơ" />
        <NotConfiguredState />
      </div>
    )
  }

  if (state === 'loading') return <LoadingState />
  if (state === 'error') return <ErrorState message={error} onRetry={() => void load()} />

  if (!child) {
    return (
      <div>
        <PageHeader title="Không tìm thấy hồ sơ" description="Hồ sơ này không tồn tại hoặc không thuộc gia đình của bạn." />
        <Link
          to="/ho-so"
          className={primaryButtonClassName}
        >
          Quay lại danh sách hồ sơ
        </Link>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title={`Hồ sơ: ${child.display_name}`}
        description={
          child.birth_year != null ? `Sinh năm ${child.birth_year}. Thiết bị, quy tắc và báo cáo dưới đây chỉ thuộc về ${child.display_name}.` : undefined
        }
        actions={
          <Link
            to="/ho-so"
            className={secondaryButtonClassName}
          >
            ← Tất cả hồ sơ
          </Link>
        }
      />
      <nav aria-label="Mục trong hồ sơ" className="mb-5 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <NavLink key={t.key} to={`/ho-so/${child.id}/${t.key}`} className={tabClassName} end>
            {t.label}
          </NavLink>
        ))}
      </nav>
      {tab === 'thiet-bi' && <DevicesPage childIdFilter={child.id} />}
      {tab === 'quy-tac' && <RulesPage childIdFilter={child.id} />}
      {tab === 'bao-cao' && <ProfileReportTab childId={child.id} childName={child.display_name} />}
      {tab === 'ngan-hang-gio' && (
        <TimeBankTab key={child.id} childId={child.id} childName={child.display_name} />
      )}
      {tab === 'nhan-tin' && (
        <ChatPanel
          key={child.id}
          childId={child.id}
          childName={child.display_name}
          familyId={child.family_id}
        />
      )}
      {tab === 'chup-man-hinh' && (
        <ScreenCaptureTab
          key={child.id}
          childId={child.id}
          childName={child.display_name}
          familyId={child.family_id}
        />
      )}
      {tab === 'du-lieu' && (
        <ChildDataTab key={child.id} childId={child.id} childName={child.display_name} />
      )}
    </div>
  )
}
