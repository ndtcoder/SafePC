import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { createFamily, getMyFamily } from '../lib/family'
import type { Child, Family, Rule } from '../lib/types'
import {
  describeRuleConfig,
  formatDateTimeVi,
  ruleTypeLabel,
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

type LoadState = 'loading' | 'ready' | 'error'

export default function RulesPage() {
  const { configured, user } = useAuth()
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [family, setFamily] = useState<Family | null>(null)
  const [rules, setRules] = useState<Rule[]>([])
  const [children, setChildren] = useState<Child[]>([])
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [creatingFamily, setCreatingFamily] = useState(false)

  // Form thêm rule daily_limit đơn giản: chọn con + số phút/ngày.
  const [selectedChildId, setSelectedChildId] = useState('')
  const [minutesPerDay, setMinutesPerDay] = useState('120')
  const [savingRule, setSavingRule] = useState(false)

  const load = useCallback(async () => {
    if (!supabase || !user) {
      setState('ready')
      return
    }
    setState('loading')
    setError('')
    try {
      const [familyResult, rulesResult, childrenResult] = await Promise.all([
        getMyFamily(supabase, user.id),
        supabase
          .from('rules')
          .select('id, family_id, child_id, type, config, enabled, created_at')
          .order('created_at', { ascending: false }),
        supabase
          .from('children')
          .select('id, family_id, display_name, birth_year, avatar_url, created_at')
          .order('created_at', { ascending: true }),
      ])
      if (rulesResult.error) throw rulesResult.error
      if (childrenResult.error) throw childrenResult.error
      setFamily(familyResult)
      setRules((rulesResult.data ?? []) as Rule[])
      const loadedChildren = (childrenResult.data ?? []) as Child[]
      setChildren(loadedChildren)
      if (!selectedChildId && loadedChildren.length > 0) {
        setSelectedChildId(loadedChildren[0].id)
      }
      setState('ready')
    } catch (err) {
      setError(toVietnameseError(err))
      setState('error')
    }
    // selectedChildId chỉ dùng để chọn mặc định lần đầu; không load lại khi đổi.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  const childNameById = useMemo(
    () => new Map(children.map((c) => [c.id, c.display_name])),
    [children],
  )

  const handleCreateFamily = async () => {
    if (!supabase || !user) return
    setCreatingFamily(true)
    setActionError(null)
    try {
      const created = await createFamily(supabase, user.id)
      setFamily(created)
      setActionMessage('Đã tạo gia đình của bạn.')
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setCreatingFamily(false)
    }
  }

  const handleToggle = async (rule: Rule) => {
    if (!supabase) return
    const nextEnabled = !rule.enabled
    setTogglingId(rule.id)
    setActionError(null)
    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, enabled: nextEnabled } : r)))
    try {
      const { error: updateError } = await supabase
        .from('rules')
        .update({ enabled: nextEnabled })
        .eq('id', rule.id)
      if (updateError) throw updateError
      setActionMessage(
        `Đã ${nextEnabled ? 'bật' : 'tắt'} quy tắc ${ruleTypeLabel(rule.type)} cho ${childNameById.get(rule.child_id) ?? 'con'}.`,
      )
    } catch (err) {
      // Khôi phục trạng thái cũ khi cập nhật thất bại.
      setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, enabled: rule.enabled } : r)))
      setActionError(toVietnameseError(err))
    } finally {
      setTogglingId(null)
    }
  }

  const handleAddRule = async (event: FormEvent) => {
    event.preventDefault()
    if (!supabase || !family || !selectedChildId) return
    const minutes = Number(minutesPerDay)
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) {
      setActionError('Số phút mỗi ngày phải là số nguyên từ 5 đến 1440 (24 giờ).')
      return
    }
    setSavingRule(true)
    setActionError(null)
    try {
      const { error: insertError } = await supabase.from('rules').insert({
        family_id: family.id,
        child_id: selectedChildId,
        type: 'daily_limit',
        config: { minutes_per_day: minutes },
        enabled: true,
      })
      if (insertError) throw insertError
      setActionMessage('Đã thêm quy tắc giới hạn giờ/ngày.')
      await load()
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setSavingRule(false)
    }
  }

  if (!configured) {
    return (
      <>
        <PageHeader title="Quy tắc" description="Giới hạn giờ dùng máy, giờ ngủ, chặn ứng dụng và website." />
        <NotConfiguredState />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Quy tắc"
        description="Giới hạn giờ dùng máy, giờ ngủ, chặn ứng dụng và website cho từng con."
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

      {state === 'loading' && <LoadingState label="Đang tải danh sách quy tắc…" />}
      {state === 'error' && <ErrorState message={error} onRetry={() => void load()} />}

      {state === 'ready' && !family && (
        <EmptyState
          title="Bạn chưa có gia đình nào"
          description="Hãy tạo gia đình trước khi đặt quy tắc cho con."
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
          <Card title="Thêm quy tắc giới hạn giờ/ngày">
            {children.length === 0 ? (
              <p className="text-sm text-slate-700">
                Cần tạo hồ sơ con trước khi thêm quy tắc. Hãy tạo hồ sơ con tại trang{' '}
                <Link to="/thiet-bi" className="font-medium text-indigo-600 hover:underline">
                  Thiết bị
                </Link>{' '}
                (nút “Thêm hồ sơ con”).
              </p>
            ) : (
              <form onSubmit={(e) => void handleAddRule(e)} className="grid gap-4 sm:grid-cols-3">
                <Field label="Con" htmlFor="rule-child">
                  <select
                    id="rule-child"
                    value={selectedChildId}
                    onChange={(e) => setSelectedChildId(e.target.value)}
                    className={inputClassName}
                  >
                    {children.map((child) => (
                      <option key={child.id} value={child.id}>
                        {child.display_name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Số phút mỗi ngày" htmlFor="rule-minutes" hint="Từ 5 đến 1440 phút. Ví dụ: 120 = 2 giờ.">
                  <input
                    id="rule-minutes"
                    type="number"
                    inputMode="numeric"
                    required
                    min={5}
                    max={1440}
                    step={5}
                    value={minutesPerDay}
                    onChange={(e) => setMinutesPerDay(e.target.value)}
                    className={inputClassName}
                  />
                </Field>
                <div className="flex items-end">
                  <button type="submit" disabled={savingRule} className={primaryButtonClassName}>
                    {savingRule ? 'Đang lưu…' : 'Thêm quy tắc'}
                  </button>
                </div>
              </form>
            )}
          </Card>

          {rules.length === 0 ? (
            <EmptyState
              title="Chưa có quy tắc nào"
              description="Chưa có quy tắc nào cho gia đình của bạn. Thêm quy tắc giới hạn giờ/ngày ở trên để bắt đầu — các loại quy tắc khác (giờ ngủ, chặn ứng dụng/website) sẽ có form riêng ở Sprint tiếp theo."
            />
          ) : (
            <div className="space-y-3">
              {rules.map((rule) => (
                <Card key={rule.id}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h2 className="text-base font-semibold text-slate-900">
                        {ruleTypeLabel(rule.type)} — {childNameById.get(rule.child_id) ?? 'Không rõ con'}
                      </h2>
                      <ul className="mt-1 space-y-0.5 text-sm text-slate-600">
                        {describeRuleConfig(rule).map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                      <p className="mt-2 text-xs text-slate-500">
                        Tạo lúc {formatDateTimeVi(rule.created_at)}
                      </p>
                      <details className="mt-2 text-xs">
                        <summary className="cursor-pointer text-indigo-600 hover:underline">
                          Xem cấu hình JSON gốc
                        </summary>
                        <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-700">
                          {JSON.stringify(rule.config, null, 2)}
                        </pre>
                      </details>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={rule.enabled}
                      aria-label={`${rule.enabled ? 'Tắt' : 'Bật'} quy tắc ${ruleTypeLabel(rule.type)}`}
                      onClick={() => void handleToggle(rule)}
                      disabled={togglingId === rule.id}
                      className={`flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
                        rule.enabled
                          ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                          : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-2.5 w-2.5 rounded-full ${rule.enabled ? 'bg-emerald-600' : 'bg-slate-500'}`}
                      />
                      {rule.enabled ? 'Đang bật' : 'Đang tắt'}
                    </button>
                  </div>
                </Card>
              ))}
              <p className="text-xs text-slate-500">
                Muốn sửa/xoá quy tắc phức tạp hơn (giờ ngủ, chặn ứng dụng/website)? Tính năng này sẽ có ở Sprint
                tiếp theo. Hiện tại bạn có thể bật/tắt quy tắc và thêm quy tắc giới hạn giờ/ngày.
              </p>
              <button type="button" onClick={() => void load()} className={secondaryButtonClassName}>
                Tải lại danh sách
              </button>
            </div>
          )}
        </div>
      )}
    </>
  )
}
