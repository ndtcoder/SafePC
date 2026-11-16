import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { createFamily, getMyFamily } from '../lib/family'
import type { Child, Command, Device, Family, Rule, TemporaryOverrideAction } from '../lib/types'
import {
  bedtimeConfigToDraft,
  bedtimeDraftToConfig,
  dailyLimitConfigToDraft,
  dailyLimitDraftToConfig,
  emptyBedtimeDraft,
  emptyDailyLimitDraft,
  emptyTimeWindowDraft,
  parseBedtimeConfig,
  parseDailyLimitConfig,
  parseTimeWindowConfig,
  timeWindowConfigToDraft,
  timeWindowDraftToConfig,
  validateBedtimeDraft,
  validateDailyLimitDraft,
  validateTimeWindowDraft,
  type BedtimeDraft,
  type DailyLimitDraft,
  type TimeWindowDraft,
} from '../lib/ruleConfig'
import {
  describeRuleConfig,
  formatDateTimeVi,
  formatDurationVi,
  formatTimeVi,
  overrideActionLabel,
  ruleTypeLabel,
  toVietnameseError,
} from '../lib/format'
import { BedtimeForm, DailyLimitForm, TimeWindowForm } from '../components/RuleForms'
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

/** Các loại quy tắc có form thêm/sửa trên trang này (đợt 1). */
type EditableRuleType = 'daily_limit' | 'time_window' | 'bedtime'

type OverrideSendAction = Exclude<TemporaryOverrideAction, 'cancel'>

const OVERRIDE_DURATIONS = [15, 30, 60, 120]

interface ActiveOverride {
  action: OverrideSendAction
  minutes: number
  expiresAt: Date
}

/**
 * Suy ra ghi đè đang hiệu lực của một máy từ các lệnh temporary_override
 * mới nhất (mới nhất thắng; lệnh cancel hoặc lệnh đã hết hạn nghĩa là
 * không còn ghi đè nào hiệu lực). `commands` phải xếp mới nhất trước.
 * Đây là hiển thị tham khảo — Agent trên máy con mới là nơi thi hành
 * thật, dựa trên bản ghi đè nó đã lưu local và thời gian hết hạn.
 */
function getActiveOverride(commands: Command[], deviceId: string, nowMs: number): ActiveOverride | null {
  for (const command of commands) {
    if (command.device_id !== deviceId) continue
    const action = command.payload['action']
    if (action === 'cancel') return null
    if (action !== 'bonus_minutes' && action !== 'lock' && action !== 'unlock') continue
    const expiresRaw = command.payload['expires_at']
    const expiresAt = typeof expiresRaw === 'string' ? new Date(expiresRaw) : null
    if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= nowMs) return null
    const minutes = typeof command.payload['minutes'] === 'number' ? command.payload['minutes'] : 0
    return { action, minutes, expiresAt }
  }
  return null
}

export default function RulesPage() {
  const { configured, user } = useAuth()
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [family, setFamily] = useState<Family | null>(null)
  const [rules, setRules] = useState<Rule[]>([])
  const [children, setChildren] = useState<Child[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [overrideCommands, setOverrideCommands] = useState<Command[]>([])
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [creatingFamily, setCreatingFamily] = useState(false)

  // Form thêm/sửa quy tắc (3 loại của đợt 1). Khi đang sửa, form giữ nguyên
  // loại của rule; khi thêm mới, phụ huynh chọn loại.
  const [editingRule, setEditingRule] = useState<Rule | null>(null)
  const [formChildId, setFormChildId] = useState('')
  const [formType, setFormType] = useState<EditableRuleType>('daily_limit')
  const [dailyDraft, setDailyDraft] = useState<DailyLimitDraft>(emptyDailyLimitDraft())
  const [windowDraft, setWindowDraft] = useState<TimeWindowDraft>(emptyTimeWindowDraft())
  const [bedtimeDraft, setBedtimeDraft] = useState<BedtimeDraft>(emptyBedtimeDraft())
  const [savingRule, setSavingRule] = useState(false)

  // Xoá quy tắc: bấm 2 lần (bấm "Xoá" rồi "Xác nhận xoá") để tránh xoá nhầm.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Ghi đè tạm thời (gửi tới từng máy, tự hết hạn).
  const [overrideDeviceId, setOverrideDeviceId] = useState('')
  const [overrideAction, setOverrideAction] = useState<OverrideSendAction>('bonus_minutes')
  const [overrideMinutes, setOverrideMinutes] = useState(30)
  const [sendingOverride, setSendingOverride] = useState(false)
  const [cancellingOverride, setCancellingOverride] = useState(false)

  const load = useCallback(async () => {
    if (!supabase || !user) {
      setState('ready')
      return
    }
    setState('loading')
    setError('')
    try {
      const [familyResult, rulesResult, childrenResult, devicesResult, commandsResult] = await Promise.all([
        getMyFamily(supabase, user.id),
        supabase
          .from('rules')
          .select('id, family_id, child_id, type, config, enabled, created_at')
          .order('created_at', { ascending: false }),
        supabase
          .from('children')
          .select('id, family_id, display_name, birth_year, avatar_url, created_at')
          .order('created_at', { ascending: true }),
        supabase
          .from('devices')
          .select('id, family_id, child_id, hostname, os_version, agent_version, last_seen_at, status, created_at')
          .order('created_at', { ascending: true }),
        supabase
          .from('commands')
          .select('id, family_id, device_id, type, payload, status, created_at')
          .eq('type', 'temporary_override')
          .order('created_at', { ascending: false })
          .limit(50),
      ])
      if (rulesResult.error) throw rulesResult.error
      if (childrenResult.error) throw childrenResult.error
      if (devicesResult.error) throw devicesResult.error
      if (commandsResult.error) throw commandsResult.error
      setFamily(familyResult)
      setRules((rulesResult.data ?? []) as Rule[])
      setChildren((childrenResult.data ?? []) as Child[])
      setDevices((devicesResult.data ?? []) as Device[])
      setOverrideCommands((commandsResult.data ?? []) as Command[])
      setState('ready')
    } catch (err) {
      setError(toVietnameseError(err))
      setState('error')
    }
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!formChildId && children.length > 0) setFormChildId(children[0].id)
  }, [children, formChildId])

  useEffect(() => {
    if (!overrideDeviceId && devices.length > 0) setOverrideDeviceId(devices[0].id)
  }, [devices, overrideDeviceId])

  const childNameById = new Map(children.map((c) => [c.id, c.display_name]))

  const resetDrafts = () => {
    setDailyDraft(emptyDailyLimitDraft())
    setWindowDraft(emptyTimeWindowDraft())
    setBedtimeDraft(emptyBedtimeDraft())
  }

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

  const startEdit = (rule: Rule) => {
    if (rule.type === 'daily_limit') {
      setDailyDraft(dailyLimitConfigToDraft(parseDailyLimitConfig(rule.config)))
      setFormType('daily_limit')
    } else if (rule.type === 'time_window') {
      setWindowDraft(timeWindowConfigToDraft(parseTimeWindowConfig(rule.config)))
      setFormType('time_window')
    } else if (rule.type === 'bedtime') {
      setBedtimeDraft(bedtimeConfigToDraft(parseBedtimeConfig(rule.config)))
      setFormType('bedtime')
    } else {
      return
    }
    setFormChildId(rule.child_id)
    setEditingRule(rule)
    setActionError(null)
    setActionMessage(null)
    setConfirmDeleteId(null)
  }

  const cancelEdit = () => {
    setEditingRule(null)
    resetDrafts()
  }

  const handleSubmitRule = async (event: FormEvent) => {
    event.preventDefault()
    if (!supabase || !family || !formChildId) return

    let config: Record<string, unknown>
    if (formType === 'daily_limit') {
      const validationError = validateDailyLimitDraft(dailyDraft)
      if (validationError) {
        setActionError(validationError)
        return
      }
      config = dailyLimitDraftToConfig(dailyDraft)
    } else if (formType === 'time_window') {
      const validationError = validateTimeWindowDraft(windowDraft)
      if (validationError) {
        setActionError(validationError)
        return
      }
      config = timeWindowDraftToConfig(windowDraft)
    } else {
      const validationError = validateBedtimeDraft(bedtimeDraft)
      if (validationError) {
        setActionError(validationError)
        return
      }
      config = bedtimeDraftToConfig(bedtimeDraft)
    }

    setSavingRule(true)
    setActionError(null)
    try {
      if (editingRule) {
        const { error: updateError } = await supabase
          .from('rules')
          .update({ child_id: formChildId, config })
          .eq('id', editingRule.id)
        if (updateError) throw updateError
        setActionMessage('Đã cập nhật quy tắc.')
        setEditingRule(null)
      } else {
        const { error: insertError } = await supabase.from('rules').insert({
          family_id: family.id,
          child_id: formChildId,
          type: formType,
          config,
          enabled: true,
        })
        if (insertError) throw insertError
        setActionMessage('Đã thêm quy tắc mới.')
      }
      resetDrafts()
      await load()
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setSavingRule(false)
    }
  }

  const handleDeleteRule = async (rule: Rule) => {
    if (!supabase) return
    setDeletingId(rule.id)
    setActionError(null)
    try {
      const { error: deleteError } = await supabase.from('rules').delete().eq('id', rule.id)
      if (deleteError) throw deleteError
      if (editingRule?.id === rule.id) {
        setEditingRule(null)
        resetDrafts()
      }
      setConfirmDeleteId(null)
      setActionMessage(`Đã xoá quy tắc ${ruleTypeLabel(rule.type)}.`)
      await load()
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setDeletingId(null)
    }
  }

  const handleSendOverride = async () => {
    if (!supabase || !family || !overrideDeviceId) return
    const device = devices.find((d) => d.id === overrideDeviceId)
    if (!device) return
    setSendingOverride(true)
    setActionError(null)
    setActionMessage(null)
    try {
      const now = new Date()
      // Cộng thêm giờ: hiệu lực tới hết ngày hôm nay (theo giờ địa phương).
      // Khóa/tạm mở: hiệu lực trong đúng số phút đã chọn.
      const expiresAt =
        overrideAction === 'bonus_minutes'
          ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0)
          : new Date(now.getTime() + overrideMinutes * 60000)
      const { error: insertError } = await supabase.from('commands').insert({
        family_id: device.family_id,
        device_id: device.id,
        type: 'temporary_override',
        payload: { action: overrideAction, minutes: overrideMinutes, expires_at: expiresAt.toISOString() },
        status: 'pending',
      })
      if (insertError) throw insertError
      setActionMessage(
        `Đã gửi "${overrideActionLabel(overrideAction)}" tới máy "${device.hostname}". Agent sẽ nhận lệnh trong vòng ~15 giây khi máy online; ghi đè tự hết hạn lúc ${formatTimeVi(expiresAt.toISOString())}.`,
      )
      await load()
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setSendingOverride(false)
    }
  }

  const handleCancelOverride = async () => {
    if (!supabase || !family || !overrideDeviceId) return
    const device = devices.find((d) => d.id === overrideDeviceId)
    if (!device) return
    setCancellingOverride(true)
    setActionError(null)
    setActionMessage(null)
    try {
      const { error: insertError } = await supabase.from('commands').insert({
        family_id: device.family_id,
        device_id: device.id,
        type: 'temporary_override',
        payload: { action: 'cancel' },
        status: 'pending',
      })
      if (insertError) throw insertError
      setActionMessage(`Đã gửi lệnh hủy ghi đè tới máy "${device.hostname}". Các quy tắc giờ giấc sẽ áp dụng lại như cũ.`)
      await load()
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setCancellingOverride(false)
    }
  }

  const activeOverride = overrideDeviceId
    ? getActiveOverride(overrideCommands, overrideDeviceId, Date.now())
    : null

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
        description="Giới hạn giờ dùng máy, khung giờ được dùng, giờ ngủ và ghi đè tạm thời cho từng con."
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
          <Card title={editingRule ? 'Sửa quy tắc' : 'Thêm quy tắc'}>
            {children.length === 0 ? (
              <p className="text-sm text-slate-700">
                Cần tạo hồ sơ con trước khi thêm quy tắc. Hãy tạo hồ sơ con tại trang{' '}
                <Link to="/thiet-bi" className="font-medium text-indigo-600 hover:underline">
                  Thiết bị
                </Link>{' '}
                (nút “Thêm hồ sơ con”).
              </p>
            ) : (
              <form onSubmit={(e) => void handleSubmitRule(e)} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Con" htmlFor="rule-child">
                    <select
                      id="rule-child"
                      value={formChildId}
                      onChange={(e) => setFormChildId(e.target.value)}
                      className={inputClassName}
                    >
                      {children.map((child) => (
                        <option key={child.id} value={child.id}>
                          {child.display_name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label="Loại quy tắc"
                    htmlFor="rule-type"
                    hint={editingRule ? 'Không đổi được loại quy tắc khi sửa.' : undefined}
                  >
                    <select
                      id="rule-type"
                      value={formType}
                      disabled={editingRule !== null}
                      onChange={(e) => setFormType(e.target.value as EditableRuleType)}
                      className={inputClassName}
                    >
                      <option value="daily_limit">Giới hạn giờ/ngày theo thứ</option>
                      <option value="time_window">Khung giờ được dùng máy</option>
                      <option value="bedtime">Giờ ngủ / giờ cấm</option>
                    </select>
                  </Field>
                </div>

                {formType === 'daily_limit' && <DailyLimitForm draft={dailyDraft} onChange={setDailyDraft} />}
                {formType === 'time_window' && <TimeWindowForm draft={windowDraft} onChange={setWindowDraft} />}
                {formType === 'bedtime' && <BedtimeForm draft={bedtimeDraft} onChange={setBedtimeDraft} />}

                <div className="flex flex-wrap gap-2">
                  <button type="submit" disabled={savingRule} className={primaryButtonClassName}>
                    {savingRule ? 'Đang lưu…' : editingRule ? 'Lưu thay đổi' : 'Thêm quy tắc'}
                  </button>
                  {editingRule && (
                    <button type="button" onClick={cancelEdit} className={secondaryButtonClassName}>
                      Huỷ sửa
                    </button>
                  )}
                </div>
              </form>
            )}
          </Card>

          <Card title="Ghi đè tạm thời (tự hết hạn)">
            {devices.length === 0 ? (
              <p className="text-sm text-slate-700">
                Chưa có thiết bị nào được ghép nối. Ghi đè tạm thời được gửi tới từng máy, nên cần ghép nối máy
                của con trước (xem trang Thiết bị).
              </p>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Máy" htmlFor="override-device">
                    <select
                      id="override-device"
                      value={overrideDeviceId}
                      onChange={(e) => setOverrideDeviceId(e.target.value)}
                      className={inputClassName}
                    >
                      {devices.map((device) => (
                        <option key={device.id} value={device.id}>
                          {device.hostname}
                          {device.child_id ? ` — ${childNameById.get(device.child_id) ?? ''}` : ''}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Hành động" htmlFor="override-action">
                    <select
                      id="override-action"
                      value={overrideAction}
                      onChange={(e) => setOverrideAction(e.target.value as OverrideSendAction)}
                      className={inputClassName}
                    >
                      <option value="bonus_minutes">Cộng thêm giờ hôm nay</option>
                      <option value="lock">Khóa máy tạm thời</option>
                      <option value="unlock">Tạm mở máy (ngưng quy tắc giờ giấc)</option>
                    </select>
                  </Field>
                  <div>
                    <span className="mb-1 block text-sm font-medium text-slate-700">
                      {overrideAction === 'bonus_minutes' ? 'Số phút cộng thêm' : 'Hiệu lực trong'}
                    </span>
                    <div className="flex flex-wrap gap-2" role="group" aria-label="Thời lượng">
                      {OVERRIDE_DURATIONS.map((minutes) => (
                        <button
                          key={minutes}
                          type="button"
                          onClick={() => setOverrideMinutes(minutes)}
                          aria-pressed={overrideMinutes === minutes}
                          className={`rounded-lg px-3 py-2 text-sm font-medium ${
                            overrideMinutes === minutes
                              ? 'bg-indigo-600 text-white'
                              : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                          }`}
                        >
                          {minutes} phút
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <p className="text-sm text-slate-600">
                  {overrideAction === 'bonus_minutes'
                    ? 'Số phút này được cộng vào giới hạn giờ hôm nay của con, hiệu lực tới hết ngày.'
                    : overrideAction === 'lock'
                      ? 'Máy sẽ bị khóa trong thời gian đã chọn, sau đó các quy tắc bình thường áp dụng lại.'
                      : 'Các quy tắc giờ giấc (giới hạn ngày, khung giờ, giờ ngủ) tạm ngưng trong thời gian đã chọn, sau đó áp dụng lại như cũ.'}{' '}
                  Ghi đè mới nhất sẽ thay thế ghi đè trước đó trên cùng một máy.
                </p>

                {activeOverride && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                    <p>
                      <span className="font-medium">Đang hiệu lực trên máy này: </span>
                      {overrideActionLabel(activeOverride.action)}
                      {activeOverride.action === 'bonus_minutes'
                        ? ` (+${activeOverride.minutes} phút hôm nay)`
                        : ` (${activeOverride.minutes} phút)`}
                      {' — '}hết hạn lúc {formatTimeVi(activeOverride.expiresAt.toISOString())} (còn{' '}
                      {formatDurationVi(Math.max(0, (activeOverride.expiresAt.getTime() - Date.now()) / 1000))}).
                    </p>
                    <button
                      type="button"
                      onClick={() => void handleCancelOverride()}
                      disabled={cancellingOverride}
                      className="mt-2 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {cancellingOverride ? 'Đang gửi…' : 'Huỷ ghi đè này'}
                    </button>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => void handleSendOverride()}
                  disabled={sendingOverride || !overrideDeviceId}
                  className={primaryButtonClassName}
                >
                  {sendingOverride ? 'Đang gửi…' : 'Gửi ghi đè tạm thời'}
                </button>
              </div>
            )}
          </Card>

          {rules.length === 0 ? (
            <EmptyState
              title="Chưa có quy tắc nào"
              description="Chưa có quy tắc nào cho gia đình của bạn. Thêm quy tắc ở trên để bắt đầu — các loại quy tắc khác (chặn ứng dụng/website) sẽ có ở đợt tiếp theo."
            />
          ) : (
            <div className="space-y-3">
              {rules.map((rule) => {
                const editable =
                  rule.type === 'daily_limit' || rule.type === 'time_window' || rule.type === 'bedtime'
                const confirmingDelete = confirmDeleteId === rule.id
                return (
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
                        {!editable && (
                          <p className="mt-1 text-xs text-slate-500">
                            Sửa quy tắc này sẽ có ở đợt tiếp theo; hiện tại bạn có thể bật/tắt hoặc xoá.
                          </p>
                        )}
                        <details className="mt-2 text-xs">
                          <summary className="cursor-pointer text-indigo-600 hover:underline">
                            Xem cấu hình JSON gốc
                          </summary>
                          <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-700">
                            {JSON.stringify(rule.config, null, 2)}
                          </pre>
                        </details>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={rule.enabled}
                          aria-label={`${rule.enabled ? 'Tắt' : 'Bật'} quy tắc ${ruleTypeLabel(rule.type)}`}
                          onClick={() => void handleToggle(rule)}
                          disabled={togglingId === rule.id}
                          className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
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
                        {editable && (
                          <button
                            type="button"
                            onClick={() => startEdit(rule)}
                            className={secondaryButtonClassName}
                          >
                            Sửa
                          </button>
                        )}
                        {confirmingDelete ? (
                          <>
                            <button
                              type="button"
                              onClick={() => void handleDeleteRule(rule)}
                              disabled={deletingId === rule.id}
                              className="rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {deletingId === rule.id ? 'Đang xoá…' : 'Xác nhận xoá'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className={secondaryButtonClassName}
                            >
                              Huỷ
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(rule.id)}
                            className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
                          >
                            Xoá
                          </button>
                        )}
                      </div>
                    </div>
                  </Card>
                )
              })}
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
