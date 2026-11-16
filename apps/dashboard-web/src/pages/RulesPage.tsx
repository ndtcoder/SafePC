import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { createFamily, getMyFamily } from '../lib/family'
import type { Child, Command, Device, Family, Rule, TemporaryOverrideAction } from '../lib/types'
import {
  PRESET_OPTIONS,
  appConfigToAllowlistByTimeDraft,
  appConfigToBlockByTimeDraft,
  appConfigToForcedBreakDraft,
  appConfigToListDraft,
  appConfigToTimeLimitDraft,
  appListDraftToExeList,
  appModeFromListSelection,
  appListSelectionFromMode,
  appTempOverrideAction,
  bedtimeConfigToDraft,
  bedtimeDraftToConfig,
  buildAllowlistByTimeConfig,
  buildAllowlistConfig,
  buildAppAllowlistByTimeConfig,
  buildAppAllowlistConfig,
  buildAppBlockByTimeConfig,
  buildAppBlockConfig,
  buildAppTimeLimitConfig,
  buildBlockDomainsByTimeConfig,
  buildBlockDomainsConfig,
  buildDomainTimeLimitConfig,
  buildFocusConfig,
  buildForcedBreakConfig,
  buildPresetRules,
  buildSafeSearchConfig,
  dailyLimitConfigToDraft,
  dailyLimitDraftToConfig,
  emptyAllowlistByTimeDraft,
  emptyAppAllowlistByTimeDraft,
  emptyAppBlockByTimeDraft,
  emptyAppListDraft,
  emptyAppTimeLimitDraft,
  emptyBedtimeDraft,
  emptyBlockDomainsByTimeDraft,
  emptyDailyLimitDraft,
  emptyDomainTimeLimitDraft,
  emptyFocusDraft,
  emptyForcedBreakDraft,
  emptySafeSearchDraft,
  emptyTimeWindowDraft,
  emptyWebsiteDomainsDraft,
  parseAppConfig,
  parseBedtimeConfig,
  parseDailyLimitConfig,
  parseDomainsInput,
  parseTimeWindowConfig,
  parseWebsiteConfig,
  timeWindowConfigToDraft,
  timeWindowDraftToConfig,
  validateAllowlistByTimeDraft,
  validateAppAllowlistByTimeDraft,
  validateAppBlockByTimeDraft,
  validateAppListDraft,
  validateAppTimeLimitDraft,
  validateBedtimeDraft,
  validateBlockDomainsByTimeDraft,
  validateDailyLimitDraft,
  validateDomainTimeLimitDraft,
  validateFocusDraft,
  validateForcedBreakDraft,
  validateTimeWindowDraft,
  validateWebsiteDomainsText,
  websiteConfigToAllowlistByTimeDraft,
  websiteConfigToBlockByTimeDraft,
  websiteConfigToDomainsDraft,
  websiteConfigToFocusDraft,
  websiteConfigToSafeSearchDraft,
  websiteConfigToTimeLimitDraft,
  websiteListSelectionFromMode,
  websiteModeFromListSelection,
  websiteTempOverrideAction,
  type AllowlistByTimeDraft,
  type AppAllowlistByTimeDraft,
  type AppBlockByTimeDraft,
  type AppListDraft,
  type AppTimeLimitDraft,
  type BedtimeDraft,
  type BlockDomainsByTimeDraft,
  type DailyLimitDraft,
  type DomainTimeLimitDraft,
  type FocusDraft,
  type ForcedBreakDraft,
  type ListKind,
  type PresetId,
  type SafeSearchDraft,
  type TimeKind,
  type TimeWindowDraft,
  type WebsiteDomainsDraft,
} from '../lib/ruleConfig'
import {
  describeRuleConfig,
  formatDateTimeVi,
  formatDurationVi,
  formatTimeVi,
  overrideActionLabel,
  parseEnforcementSnapshot,
  ruleTypeLabel,
  toVietnameseError,
} from '../lib/format'
import {
  AllowlistByTimeForm,
  AllowlistForm,
  AppAllowlistByTimeForm,
  AppAllowlistForm,
  AppBlockByTimeForm,
  AppBlockForm,
  AppTimeLimitForm,
  AppsField,
  BedtimeForm,
  BlockDomainsByTimeForm,
  BlockDomainsForm,
  DailyLimitForm,
  DomainTimeLimitForm,
  DomainsField,
  FocusForm,
  ForcedBreakForm,
  ListKindPicker,
  SafeSearchForm,
  TimeKindPicker,
  TimeWindowForm,
} from '../components/RuleForms'
import {
  Card,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  NotConfiguredState,
  PageHeader,
  chipClassName,
  dangerButtonClassName,
  dangerOutlineButtonClassName,
  inputClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
} from '../components/ui'

type LoadState = 'loading' | 'ready' | 'error'

/** Các loại quy tắc có form thêm/sửa trên trang này: cả 5 loại đều sửa được (đợt 3 thêm quy tắc ứng dụng). */
type EditableRuleType = 'daily_limit' | 'time_window' | 'bedtime' | 'website' | 'app'

/**
 * Nhóm form của quy tắc website/ứng dụng. 'list' là nhóm danh sách
 * (chặn/cho phép × luôn luôn/theo giờ/tạm thời); các nhóm còn lại giữ
 * form riêng như trước.
 */
type WebsiteFormKind = 'list' | 'domain_time_limit' | 'safe_search' | 'focus'
type AppFormKind = 'list' | 'app_time_limit' | 'forced_break'

type OverrideSendAction = Exclude<TemporaryOverrideAction, 'cancel'>

const OVERRIDE_DURATIONS = [15, 30, 60, 120]

interface ActiveOverride {
  action: OverrideSendAction
  minutes: number
  expiresAt: Date
  /** Chỉ có với ghi đè website (allow_domain/block_domain). */
  domains?: string[]
  /** Chỉ có với ghi đè ứng dụng (allow_app/block_app): danh sách tên exe. */
  apps?: string[]
}

/**
 * Suy ra ghi đè đang hiệu lực của một máy từ các lệnh temporary_override
 * mới nhất (mới nhất thắng — kể cả khác loại: ghi đè website mới nhất sẽ
 * thay thế ghi đè giờ giấc trước đó và ngược lại; lệnh cancel hoặc lệnh
 * đã hết hạn nghĩa là không còn ghi đè nào hiệu lực). `commands` phải xếp
 * mới nhất trước. Đây là hiển thị tham khảo — Agent trên máy con mới là
 * nơi thi hành thật, dựa trên bản ghi đè nó đã lưu local và thời gian hết hạn.
 */
function getActiveOverride(commands: Command[], deviceId: string, nowMs: number): ActiveOverride | null {
  for (const command of commands) {
    if (command.device_id !== deviceId) continue
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
    const minutes = typeof command.payload['minutes'] === 'number' ? command.payload['minutes'] : 0
    const rawDomains = command.payload['domains']
    const domains = Array.isArray(rawDomains)
      ? rawDomains.filter((d): d is string => typeof d === 'string')
      : []
    const rawApps = command.payload['apps']
    const apps = Array.isArray(rawApps) ? rawApps.filter((a): a is string => typeof a === 'string') : []
    return {
      action,
      minutes,
      expiresAt,
      domains: domains.length > 0 ? domains : undefined,
      apps: apps.length > 0 ? apps : undefined,
    }
  }
  return null
}

/**
 * Ô chọn máy nhận ghi đè + thời lượng, dùng trong form quy tắc khi chọn
 * "Tạm thời — đếm ngược". Cùng mẫu với thẻ ghi đè tạm thời: chọn máy
 * (kèm tên con), chọn số phút trong 15/30/60/120.
 */
function TempOverrideTargetFields({
  devices,
  childNameById,
  deviceId,
  onDeviceChange,
  minutes,
  onMinutesChange,
}: {
  devices: Device[]
  childNameById: Map<string, string>
  deviceId: string
  onDeviceChange: (deviceId: string) => void
  minutes: number
  onMinutesChange: (minutes: number) => void
}) {
  if (devices.length === 0) {
    return (
      <p className="text-sm text-slate-700">
        Chưa có thiết bị nào được ghép nối. Ghi đè tạm thời được gửi tới từng máy, nên cần ghép nối máy của
        con trước (xem trang Thiết bị).
      </p>
    )
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Máy nhận ghi đè" htmlFor="temp-override-device">
        <select
          id="temp-override-device"
          value={deviceId}
          onChange={(e) => onDeviceChange(e.target.value)}
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
      <div>
        <span className="mb-1 block text-sm font-medium text-slate-700">Hiệu lực trong</span>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Thời lượng">
          {OVERRIDE_DURATIONS.map((duration) => (
            <button
              key={duration}
              type="button"
              onClick={() => onMinutesChange(duration)}
              aria-pressed={minutes === duration}
              className={chipClassName(minutes === duration)}
            >
              {duration} phút
            </button>
          ))}
        </div>
      </div>
    </div>
  )
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

  // Form thêm/sửa quy tắc. Khi đang sửa, form giữ nguyên loại (và nhóm
  // form + lựa chọn danh sách/thời gian) của rule; khi thêm mới, phụ
  // huynh chọn loại rồi chọn tiếp nhóm form và lựa chọn danh sách.
  const [editingRule, setEditingRule] = useState<Rule | null>(null)
  const [formChildId, setFormChildId] = useState('')
  const [formType, setFormType] = useState<EditableRuleType>('daily_limit')
  const [dailyDraft, setDailyDraft] = useState<DailyLimitDraft>(emptyDailyLimitDraft())
  const [windowDraft, setWindowDraft] = useState<TimeWindowDraft>(emptyTimeWindowDraft())
  const [bedtimeDraft, setBedtimeDraft] = useState<BedtimeDraft>(emptyBedtimeDraft())
  // Quy tắc website: một dòng rule type='website' mang đúng 1 chế độ.
  // Nhóm 'list' chọn loại danh sách + thời gian rồi ánh xạ thành chế độ
  // (block_domains / block_domains_by_time / allowlist / allowlist_by_time
  // hoặc ghi đè tạm thời khi chọn "Tạm thời").
  const [websiteFormKind, setWebsiteFormKind] = useState<WebsiteFormKind>('list')
  const [websiteListKind, setWebsiteListKind] = useState<ListKind>('block')
  const [websiteTimeKind, setWebsiteTimeKind] = useState<TimeKind>('always')
  const [websiteDomainsDraft, setWebsiteDomainsDraft] =
    useState<WebsiteDomainsDraft>(emptyWebsiteDomainsDraft())
  const [blockByTimeDraft, setBlockByTimeDraft] =
    useState<BlockDomainsByTimeDraft>(emptyBlockDomainsByTimeDraft())
  const [allowlistByTimeDraft, setAllowlistByTimeDraft] =
    useState<AllowlistByTimeDraft>(emptyAllowlistByTimeDraft())
  const [timeLimitDraft, setTimeLimitDraft] = useState<DomainTimeLimitDraft>(emptyDomainTimeLimitDraft())
  const [safeSearchDraft, setSafeSearchDraft] = useState<SafeSearchDraft>(emptySafeSearchDraft())
  const [focusDraft, setFocusDraft] = useState<FocusDraft>(emptyFocusDraft())
  // Quy tắc ứng dụng: một dòng rule type='app' mang đúng 1 chế độ. Nhóm
  // 'list' ánh xạ thành app_block / app_block_by_time / app_allowlist /
  // app_allowlist_by_time (hoặc ghi đè tạm thời khi chọn "Tạm thời").
  const [appFormKind, setAppFormKind] = useState<AppFormKind>('list')
  const [appListKind, setAppListKind] = useState<ListKind>('block')
  const [appTimeKind, setAppTimeKind] = useState<TimeKind>('always')
  const [appListDraft, setAppListDraft] = useState<AppListDraft>(emptyAppListDraft())
  const [appTimeLimitDraft, setAppTimeLimitDraft] =
    useState<AppTimeLimitDraft>(emptyAppTimeLimitDraft())
  const [appBlockByTimeDraft, setAppBlockByTimeDraft] =
    useState<AppBlockByTimeDraft>(emptyAppBlockByTimeDraft())
  const [appAllowlistByTimeDraft, setAppAllowlistByTimeDraft] =
    useState<AppAllowlistByTimeDraft>(emptyAppAllowlistByTimeDraft())
  const [forcedBreakDraft, setForcedBreakDraft] = useState<ForcedBreakDraft>(emptyForcedBreakDraft())
  const [savingRule, setSavingRule] = useState(false)

  // Ghi đè tạm thời gửi từ form quy tắc (khi chọn "Tạm thời — đếm ngược"):
  // máy nhận + số phút, dùng chung cho form website và form ứng dụng.
  const [tempDeviceId, setTempDeviceId] = useState('')
  const [tempMinutes, setTempMinutes] = useState(30)

  // Id các rule đang được thi hành trên ít nhất một máy (hợp các ruleIds
  // trong enforcement snapshot của mọi máy; truy vấn best-effort — xem
  // load()). Rỗng nghĩa là chưa biết rule nào đang thi hành.
  const [enforcingRuleIds, setEnforcingRuleIds] = useState<ReadonlySet<string>>(new Set())

  // Thẻ quy tắc đang mở rộng trong danh sách nhóm; mặc định tất cả đóng.
  const [expandedRuleIds, setExpandedRuleIds] = useState<ReadonlySet<string>>(new Set())

  // Mẫu sẵn một chạm: chọn con riêng, xác nhận 2 bước cho từng mẫu.
  const [presetChildId, setPresetChildId] = useState('')
  const [confirmPresetId, setConfirmPresetId] = useState<PresetId | null>(null)
  const [applyingPreset, setApplyingPreset] = useState(false)

  // Xoá quy tắc: bấm 2 lần (bấm "Xoá" rồi "Xác nhận xoá") để tránh xoá nhầm.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Ghi đè tạm thời (gửi tới từng máy, tự hết hạn).
  const [overrideDeviceId, setOverrideDeviceId] = useState('')
  const [overrideAction, setOverrideAction] = useState<OverrideSendAction>('bonus_minutes')
  const [overrideMinutes, setOverrideMinutes] = useState(30)
  const [sendingOverride, setSendingOverride] = useState(false)
  const [cancellingOverride, setCancellingOverride] = useState(false)

  // Ghi đè website tạm thời (cho phép/chặn domain, tự hết hạn). Dùng chung
  // máy đã chọn (overrideDeviceId) và lệnh hủy (cancel) với ghi đè giờ giấc.
  const [domainOverrideAction, setDomainOverrideAction] = useState<'allow_domain' | 'block_domain'>('allow_domain')
  const [domainOverrideText, setDomainOverrideText] = useState('')
  const [domainOverrideMinutes, setDomainOverrideMinutes] = useState(30)
  const [sendingDomainOverride, setSendingDomainOverride] = useState(false)

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
      // Truy vấn RIÊNG, best-effort: cột enforcement_json chỉ có sau
      // migration 6. Truy vấn lỗi (cột chưa tồn tại) thì coi như chưa biết
      // rule nào đang thi hành, KHÔNG làm hỏng cả trang.
      try {
        const enforcementResult = await supabase.from('devices').select('id, enforcement_json')
        if (enforcementResult.error) {
          setEnforcingRuleIds(new Set())
        } else {
          const ids = new Set<string>()
          for (const row of (enforcementResult.data ?? []) as Array<{
            id: string
            enforcement_json: unknown
          }>) {
            const snapshot = parseEnforcementSnapshot(row.enforcement_json)
            if (snapshot) {
              for (const ruleId of snapshot.ruleIds) ids.add(ruleId)
            }
          }
          setEnforcingRuleIds(ids)
        }
      } catch {
        setEnforcingRuleIds(new Set())
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

  useEffect(() => {
    if (!formChildId && children.length > 0) setFormChildId(children[0].id)
  }, [children, formChildId])

  useEffect(() => {
    if (!presetChildId && children.length > 0) setPresetChildId(children[0].id)
  }, [children, presetChildId])

  useEffect(() => {
    if (!overrideDeviceId && devices.length > 0) setOverrideDeviceId(devices[0].id)
  }, [devices, overrideDeviceId])

  useEffect(() => {
    if (!tempDeviceId && devices.length > 0) setTempDeviceId(devices[0].id)
  }, [devices, tempDeviceId])

  const childNameById = new Map(children.map((c) => [c.id, c.display_name]))

  const resetDrafts = () => {
    setDailyDraft(emptyDailyLimitDraft())
    setWindowDraft(emptyTimeWindowDraft())
    setBedtimeDraft(emptyBedtimeDraft())
    setWebsiteDomainsDraft(emptyWebsiteDomainsDraft())
    setBlockByTimeDraft(emptyBlockDomainsByTimeDraft())
    setAllowlistByTimeDraft(emptyAllowlistByTimeDraft())
    setTimeLimitDraft(emptyDomainTimeLimitDraft())
    setSafeSearchDraft(emptySafeSearchDraft())
    setFocusDraft(emptyFocusDraft())
    setAppListDraft(emptyAppListDraft())
    setAppTimeLimitDraft(emptyAppTimeLimitDraft())
    setAppBlockByTimeDraft(emptyAppBlockByTimeDraft())
    setAppAllowlistByTimeDraft(emptyAppAllowlistByTimeDraft())
    setForcedBreakDraft(emptyForcedBreakDraft())
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
    } else if (rule.type === 'website') {
      const parsed = parseWebsiteConfig(rule.config)
      setFormType('website')
      const selection = parsed ? websiteListSelectionFromMode(parsed.mode) : null
      if (selection) {
        setWebsiteFormKind('list')
        setWebsiteListKind(selection.listKind)
        setWebsiteTimeKind(selection.timeKind)
      } else if (
        parsed?.mode === 'domain_time_limit' ||
        parsed?.mode === 'safe_search' ||
        parsed?.mode === 'focus'
      ) {
        setWebsiteFormKind(parsed.mode)
      } else {
        setWebsiteFormKind('list')
        setWebsiteListKind('block')
        setWebsiteTimeKind('always')
      }
      setWebsiteDomainsDraft(websiteConfigToDomainsDraft(parsed))
      setBlockByTimeDraft(websiteConfigToBlockByTimeDraft(parsed))
      setAllowlistByTimeDraft(websiteConfigToAllowlistByTimeDraft(parsed))
      setTimeLimitDraft(websiteConfigToTimeLimitDraft(parsed))
      setSafeSearchDraft(websiteConfigToSafeSearchDraft(parsed))
      setFocusDraft(websiteConfigToFocusDraft(parsed))
    } else if (rule.type === 'app') {
      const parsed = parseAppConfig(rule.config)
      setFormType('app')
      const selection = parsed ? appListSelectionFromMode(parsed.mode) : null
      if (selection) {
        setAppFormKind('list')
        setAppListKind(selection.listKind)
        setAppTimeKind(selection.timeKind)
      } else if (parsed?.mode === 'forced_break') {
        setAppFormKind('forced_break')
      } else {
        setAppFormKind('app_time_limit')
      }
      setAppListDraft(appConfigToListDraft(parsed))
      setAppTimeLimitDraft(appConfigToTimeLimitDraft(parsed))
      setAppBlockByTimeDraft(appConfigToBlockByTimeDraft(parsed))
      setAppAllowlistByTimeDraft(appConfigToAllowlistByTimeDraft(parsed))
      setForcedBreakDraft(appConfigToForcedBreakDraft(parsed))
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

  // "Tạm thời — đếm ngược" trong form danh sách: KHÔNG tạo dòng rule, mà
  // gửi một lệnh ghi đè tạm thời tới máy đã chọn (website dùng action
  // allow_domain/block_domain kèm `domains`, ứng dụng dùng block_app/
  // allow_app kèm `apps`). Ghi đè tự hết hạn sau số phút đã chọn.
  const handleSubmitTempOverride = async () => {
    if (!supabase || !family) return
    if (formType !== 'website' && formType !== 'app') return
    const device = devices.find((d) => d.id === tempDeviceId)
    if (!device) {
      setActionError('Chưa chọn máy nhận ghi đè. Hãy ghép nối máy của con trước (xem trang Thiết bị).')
      return
    }
    const parsedDomains =
      formType === 'website' ? parseDomainsInput(websiteDomainsDraft.domainsText) : null
    if (parsedDomains?.error) {
      setActionError(parsedDomains.error)
      return
    }
    const appValidationError = formType === 'app' ? validateAppListDraft(appListDraft) : null
    if (appValidationError) {
      setActionError(appValidationError)
      return
    }
    const action =
      formType === 'website'
        ? websiteTempOverrideAction(websiteListKind)
        : appTempOverrideAction(appListKind)
    const targets =
      formType === 'website' ? (parsedDomains?.domains ?? []) : appListDraftToExeList(appListDraft)
    setSavingRule(true)
    setActionError(null)
    setActionMessage(null)
    try {
      const expiresAt = new Date(Date.now() + tempMinutes * 60000)
      const payload =
        formType === 'website'
          ? { action, domains: targets, minutes: tempMinutes, expires_at: expiresAt.toISOString() }
          : { action, apps: targets, minutes: tempMinutes, expires_at: expiresAt.toISOString() }
      const { error: insertError } = await supabase.from('commands').insert({
        family_id: device.family_id,
        device_id: device.id,
        type: 'temporary_override',
        payload,
        status: 'pending',
      })
      if (insertError) throw insertError
      setActionMessage(
        `Đã gửi "${overrideActionLabel(action)}" (${targets.join(', ')}) tới máy "${device.hostname}". Agent sẽ nhận lệnh trong vòng ~15 giây khi máy online; ghi đè tự hết hạn lúc ${formatTimeVi(expiresAt.toISOString())}.`,
      )
      await load()
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setSavingRule(false)
    }
  }

  const handleSubmitRule = async (event: FormEvent) => {
    event.preventDefault()
    if (!supabase || !family || !formChildId) return

    // Lựa chọn "Tạm thời — đếm ngược" không tạo quy tắc: gửi ghi đè tạm thời rồi dừng.
    const isTempSelection =
      (formType === 'website' && websiteFormKind === 'list' && websiteTimeKind === 'temporary') ||
      (formType === 'app' && appFormKind === 'list' && appTimeKind === 'temporary')
    if (isTempSelection) {
      await handleSubmitTempOverride()
      return
    }

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
    } else if (formType === 'bedtime') {
      const validationError = validateBedtimeDraft(bedtimeDraft)
      if (validationError) {
        setActionError(validationError)
        return
      }
      config = bedtimeDraftToConfig(bedtimeDraft)
    } else if (formType === 'app') {
      // Quy tắc ứng dụng: một dòng rule mang đúng 1 chế độ. Nhóm danh
      // sách ánh xạ lựa chọn (loại danh sách × thời gian) thành chế độ.
      if (appFormKind === 'app_time_limit') {
        const validationError = validateAppTimeLimitDraft(appTimeLimitDraft)
        if (validationError) {
          setActionError(validationError)
          return
        }
        config = buildAppTimeLimitConfig(appTimeLimitDraft)
      } else if (appFormKind === 'forced_break') {
        const validationError = validateForcedBreakDraft(forcedBreakDraft)
        if (validationError) {
          setActionError(validationError)
          return
        }
        config = buildForcedBreakConfig(forcedBreakDraft)
      } else {
        const mode = appModeFromListSelection(appListKind, appTimeKind === 'by_time' ? 'by_time' : 'always')
        if (mode === 'app_block' || mode === 'app_allowlist') {
          const validationError = validateAppListDraft(appListDraft)
          if (validationError) {
            setActionError(validationError)
            return
          }
          config =
            mode === 'app_block'
              ? buildAppBlockConfig(appListDraft)
              : buildAppAllowlistConfig(appListDraft)
        } else if (mode === 'app_block_by_time') {
          const validationError = validateAppBlockByTimeDraft(appBlockByTimeDraft)
          if (validationError) {
            setActionError(validationError)
            return
          }
          config = buildAppBlockByTimeConfig(appBlockByTimeDraft)
        } else {
          const validationError = validateAppAllowlistByTimeDraft(appAllowlistByTimeDraft)
          if (validationError) {
            setActionError(validationError)
            return
          }
          config = buildAppAllowlistByTimeConfig(appAllowlistByTimeDraft)
        }
      }
    } else {
      // Quy tắc website: một dòng rule mang đúng 1 chế độ. Nhóm danh sách
      // ánh xạ lựa chọn (loại danh sách × thời gian) thành chế độ.
      if (websiteFormKind === 'domain_time_limit') {
        const validationError = validateDomainTimeLimitDraft(timeLimitDraft)
        if (validationError) {
          setActionError(validationError)
          return
        }
        config = buildDomainTimeLimitConfig(timeLimitDraft)
      } else if (websiteFormKind === 'focus') {
        const validationError = validateFocusDraft(focusDraft)
        if (validationError) {
          setActionError(validationError)
          return
        }
        config = buildFocusConfig(focusDraft)
      } else if (websiteFormKind === 'safe_search') {
        config = buildSafeSearchConfig(safeSearchDraft)
      } else {
        const mode = websiteModeFromListSelection(
          websiteListKind,
          websiteTimeKind === 'by_time' ? 'by_time' : 'always',
        )
        if (mode === 'block_domains' || mode === 'allowlist') {
          const validationError = validateWebsiteDomainsText(websiteDomainsDraft.domainsText)
          if (validationError) {
            setActionError(validationError)
            return
          }
          config =
            mode === 'block_domains'
              ? buildBlockDomainsConfig(websiteDomainsDraft.domainsText)
              : buildAllowlistConfig(websiteDomainsDraft.domainsText)
        } else if (mode === 'block_domains_by_time') {
          const validationError = validateBlockDomainsByTimeDraft(blockByTimeDraft)
          if (validationError) {
            setActionError(validationError)
            return
          }
          config = buildBlockDomainsByTimeConfig(blockByTimeDraft)
        } else {
          const validationError = validateAllowlistByTimeDraft(allowlistByTimeDraft)
          if (validationError) {
            setActionError(validationError)
            return
          }
          config = buildAllowlistByTimeConfig(allowlistByTimeDraft)
        }
      }
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

  // Mẫu sẵn chỉ THÊM quy tắc mới, không xóa hay sửa quy tắc hiện có.
  // Chèn cả gói trong một lần gọi insert để không áp dụng dở dang.
  const handleApplyPreset = async (presetId: PresetId) => {
    if (!supabase || !family || !presetChildId) return
    const preset = PRESET_OPTIONS.find((option) => option.id === presetId)
    if (!preset) return
    const bundle = buildPresetRules(presetId)
    setApplyingPreset(true)
    setActionError(null)
    setActionMessage(null)
    try {
      const { error: insertError } = await supabase.from('rules').insert(
        bundle.map((presetRule) => ({
          family_id: family.id,
          child_id: presetChildId,
          type: presetRule.type,
          config: presetRule.config,
          enabled: true,
        })),
      )
      if (insertError) throw insertError
      setConfirmPresetId(null)
      setActionMessage(
        `Đã áp dụng mẫu “${preset.label}” cho ${childNameById.get(presetChildId) ?? 'con'}: thêm ${bundle.length} quy tắc mới.`,
      )
      await load()
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setApplyingPreset(false)
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
      setActionMessage(`Đã gửi lệnh hủy ghi đè tới máy "${device.hostname}". Các quy tắc bình thường sẽ áp dụng lại như cũ.`)
      await load()
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setCancellingOverride(false)
    }
  }

  const handleSendDomainOverride = async () => {
    if (!supabase || !family || !overrideDeviceId) return
    const parsed = parseDomainsInput(domainOverrideText)
    if (parsed.error) {
      setActionError(parsed.error)
      return
    }
    const device = devices.find((d) => d.id === overrideDeviceId)
    if (!device) return
    setSendingDomainOverride(true)
    setActionError(null)
    setActionMessage(null)
    try {
      const expiresAt = new Date(Date.now() + domainOverrideMinutes * 60000)
      const { error: insertError } = await supabase.from('commands').insert({
        family_id: device.family_id,
        device_id: device.id,
        type: 'temporary_override',
        payload: {
          action: domainOverrideAction,
          domains: parsed.domains,
          minutes: domainOverrideMinutes,
          expires_at: expiresAt.toISOString(),
        },
        status: 'pending',
      })
      if (insertError) throw insertError
      setActionMessage(
        `Đã gửi "${overrideActionLabel(domainOverrideAction)}" (${parsed.domains.join(', ')}) tới máy "${device.hostname}". Agent sẽ nhận lệnh trong vòng ~15 giây khi máy online; ghi đè tự hết hạn lúc ${formatTimeVi(expiresAt.toISOString())}.`,
      )
      await load()
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setSendingDomainOverride(false)
    }
  }

  const activeOverride = overrideDeviceId
    ? getActiveOverride(overrideCommands, overrideDeviceId, Date.now())
    : null

  // Ghi đè website đang hiệu lực (nếu lệnh mới nhất là ghi đè domain).
  const activeDomainOverride =
    activeOverride && (activeOverride.action === 'allow_domain' || activeOverride.action === 'block_domain')
      ? activeOverride
      : null

  // Form đang ở lựa chọn "Tạm thời — đếm ngược" thì nút gửi sẽ gửi ghi đè
  // thay vì tạo quy tắc (xem handleSubmitRule).
  const isTempFormSelection =
    (formType === 'website' && websiteFormKind === 'list' && websiteTimeKind === 'temporary') ||
    (formType === 'app' && appFormKind === 'list' && appTimeKind === 'temporary')

  // Danh sách quy tắc nhóm theo con, trong mỗi con nhóm theo danh mục.
  // Thứ tự: con theo thứ tự tạo hồ sơ, danh mục Giờ giấc → Website →
  // Ứng dụng, trong mỗi danh mục giữ nguyên thứ tự truy vấn (mới nhất
  // trước). Rule không gắn với hồ sơ con nào đã biết vẫn hiển thị ở
  // nhóm "Không rõ con" cuối danh sách — không bỏ rule nào.
  type RuleCategoryKey = 'time' | 'website' | 'app'
  const RULE_CATEGORY_OF: Record<Rule['type'], RuleCategoryKey> = {
    daily_limit: 'time',
    time_window: 'time',
    bedtime: 'time',
    website: 'website',
    app: 'app',
  }
  const RULE_CATEGORY_LABEL: Record<RuleCategoryKey, string> = {
    time: 'Giờ giấc',
    website: 'Website',
    app: 'Ứng dụng',
  }
  const CATEGORY_ORDER: RuleCategoryKey[] = ['time', 'website', 'app']
  const groupRulesByCategory = (childRules: Rule[]) =>
    CATEGORY_ORDER.map((key) => ({
      key,
      label: RULE_CATEGORY_LABEL[key],
      rules: childRules.filter((rule) => RULE_CATEGORY_OF[rule.type] === key),
    })).filter((category) => category.rules.length > 0)
  const childSections = [
    ...children.map((child) => ({
      childId: child.id,
      childName: child.display_name,
      categories: groupRulesByCategory(rules.filter((rule) => rule.child_id === child.id)),
    })),
    {
      childId: '__unknown__',
      childName: 'Không rõ con',
      categories: groupRulesByCategory(
        rules.filter((rule) => !children.some((child) => child.id === rule.child_id)),
      ),
    },
  ].filter((section) => section.categories.length > 0)

  const toggleRuleExpanded = (ruleId: string) => {
    setExpandedRuleIds((prev) => {
      const next = new Set(prev)
      if (next.has(ruleId)) next.delete(ruleId)
      else next.add(ruleId)
      return next
    })
  }
  const expandAllRules = () => setExpandedRuleIds(new Set(rules.map((rule) => rule.id)))
  const collapseAllRules = () => setExpandedRuleIds(new Set())

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
        description="Giới hạn giờ dùng máy, khung giờ được dùng, giờ ngủ, quy tắc website và ghi đè tạm thời cho từng con."
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
        <div className="space-y-4 sm:space-y-6">
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
                      <option value="website">Quy tắc website</option>
                      <option value="app">Quy tắc ứng dụng</option>
                    </select>
                  </Field>
                  {formType === 'app' && (
                    <Field
                      label="Loại quy tắc ứng dụng"
                      htmlFor="rule-app-kind"
                      hint={editingRule ? 'Không đổi được loại quy tắc khi sửa.' : undefined}
                    >
                      <select
                        id="rule-app-kind"
                        value={appFormKind}
                        disabled={editingRule !== null}
                        onChange={(e) => setAppFormKind(e.target.value as AppFormKind)}
                        className={inputClassName}
                      >
                        <option value="list">Danh sách ứng dụng (chặn / cho phép)</option>
                        <option value="app_time_limit">Giới hạn thời gian theo ứng dụng</option>
                        <option value="forced_break">Nghỉ bắt buộc</option>
                      </select>
                    </Field>
                  )}
                  {formType === 'website' && (
                    <Field
                      label="Loại quy tắc website"
                      htmlFor="rule-website-kind"
                      hint={editingRule ? 'Không đổi được loại quy tắc khi sửa.' : undefined}
                    >
                      <select
                        id="rule-website-kind"
                        value={websiteFormKind}
                        disabled={editingRule !== null}
                        onChange={(e) => setWebsiteFormKind(e.target.value as WebsiteFormKind)}
                        className={inputClassName}
                      >
                        <option value="list">Danh sách website (chặn / cho phép)</option>
                        <option value="domain_time_limit">Giới hạn thời gian theo website</option>
                        <option value="safe_search">Tìm kiếm an toàn (SafeSearch / YouTube)</option>
                        <option value="focus">Giờ học tập trung</option>
                      </select>
                    </Field>
                  )}
                </div>

                {formType === 'website' && websiteFormKind === 'list' && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <ListKindPicker
                      value={websiteListKind}
                      onChange={setWebsiteListKind}
                      disabled={editingRule !== null}
                      hint={editingRule ? 'Không đổi được loại danh sách khi sửa.' : undefined}
                    />
                    <TimeKindPicker
                      value={websiteTimeKind}
                      onChange={setWebsiteTimeKind}
                      disabled={editingRule !== null}
                      hint={editingRule ? 'Không đổi được thời gian khi sửa.' : undefined}
                    />
                  </div>
                )}
                {formType === 'app' && appFormKind === 'list' && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <ListKindPicker
                      value={appListKind}
                      onChange={setAppListKind}
                      disabled={editingRule !== null}
                      hint={editingRule ? 'Không đổi được loại danh sách khi sửa.' : undefined}
                    />
                    <TimeKindPicker
                      value={appTimeKind}
                      onChange={setAppTimeKind}
                      disabled={editingRule !== null}
                      hint={editingRule ? 'Không đổi được thời gian khi sửa.' : undefined}
                    />
                  </div>
                )}

                {formType === 'daily_limit' && <DailyLimitForm draft={dailyDraft} onChange={setDailyDraft} />}
                {formType === 'time_window' && <TimeWindowForm draft={windowDraft} onChange={setWindowDraft} />}
                {formType === 'bedtime' && <BedtimeForm draft={bedtimeDraft} onChange={setBedtimeDraft} />}
                {formType === 'website' &&
                  websiteFormKind === 'list' &&
                  websiteTimeKind === 'always' &&
                  websiteListKind === 'block' && (
                    <BlockDomainsForm draft={websiteDomainsDraft} onChange={setWebsiteDomainsDraft} />
                  )}
                {formType === 'website' &&
                  websiteFormKind === 'list' &&
                  websiteTimeKind === 'always' &&
                  websiteListKind === 'allow' && (
                    <AllowlistForm draft={websiteDomainsDraft} onChange={setWebsiteDomainsDraft} />
                  )}
                {formType === 'website' &&
                  websiteFormKind === 'list' &&
                  websiteTimeKind === 'by_time' &&
                  websiteListKind === 'block' && (
                    <BlockDomainsByTimeForm draft={blockByTimeDraft} onChange={setBlockByTimeDraft} />
                  )}
                {formType === 'website' &&
                  websiteFormKind === 'list' &&
                  websiteTimeKind === 'by_time' &&
                  websiteListKind === 'allow' && (
                    <AllowlistByTimeForm draft={allowlistByTimeDraft} onChange={setAllowlistByTimeDraft} />
                  )}
                {formType === 'website' &&
                  websiteFormKind === 'list' &&
                  websiteTimeKind === 'temporary' && (
                    <div className="space-y-4">
                      <p className="text-sm text-slate-600">
                        {websiteListKind === 'block'
                          ? 'Các domain dưới đây sẽ bị chặn tạm thời trên máy đã chọn, sau đó các quy tắc website bình thường áp dụng lại. Lựa chọn này không tạo quy tắc mới.'
                          : 'Các domain dưới đây sẽ được mở tạm thời (bỏ qua quy tắc chặn website) trên máy đã chọn, sau đó các quy tắc website bình thường áp dụng lại. Lựa chọn này không tạo quy tắc mới.'}{' '}
                        Ghi đè mới nhất sẽ thay thế ghi đè trước đó trên cùng một máy.
                      </p>
                      <DomainsField
                        id="website-temp-domains"
                        label="Domain"
                        value={websiteDomainsDraft.domainsText}
                        onChange={(domainsText) =>
                          setWebsiteDomainsDraft({ ...websiteDomainsDraft, domainsText })
                        }
                      />
                      <TempOverrideTargetFields
                        devices={devices}
                        childNameById={childNameById}
                        deviceId={tempDeviceId}
                        onDeviceChange={setTempDeviceId}
                        minutes={tempMinutes}
                        onMinutesChange={setTempMinutes}
                      />
                    </div>
                  )}
                {formType === 'website' && websiteFormKind === 'domain_time_limit' && (
                  <DomainTimeLimitForm draft={timeLimitDraft} onChange={setTimeLimitDraft} />
                )}
                {formType === 'website' && websiteFormKind === 'safe_search' && (
                  <SafeSearchForm draft={safeSearchDraft} onChange={setSafeSearchDraft} />
                )}
                {formType === 'website' && websiteFormKind === 'focus' && (
                  <FocusForm draft={focusDraft} onChange={setFocusDraft} />
                )}
                {formType === 'app' &&
                  appFormKind === 'list' &&
                  appTimeKind === 'always' &&
                  appListKind === 'block' && (
                    <AppBlockForm draft={appListDraft} onChange={setAppListDraft} />
                  )}
                {formType === 'app' &&
                  appFormKind === 'list' &&
                  appTimeKind === 'always' &&
                  appListKind === 'allow' && (
                    <AppAllowlistForm draft={appListDraft} onChange={setAppListDraft} />
                  )}
                {formType === 'app' &&
                  appFormKind === 'list' &&
                  appTimeKind === 'by_time' &&
                  appListKind === 'block' && (
                    <AppBlockByTimeForm draft={appBlockByTimeDraft} onChange={setAppBlockByTimeDraft} />
                  )}
                {formType === 'app' &&
                  appFormKind === 'list' &&
                  appTimeKind === 'by_time' &&
                  appListKind === 'allow' && (
                    <AppAllowlistByTimeForm
                      draft={appAllowlistByTimeDraft}
                      onChange={setAppAllowlistByTimeDraft}
                    />
                  )}
                {formType === 'app' && appFormKind === 'list' && appTimeKind === 'temporary' && (
                  <div className="space-y-4">
                    <p className="text-sm text-slate-600">
                      {appListKind === 'block'
                        ? 'Các ứng dụng dưới đây sẽ bị chặn tạm thời trên máy đã chọn, sau đó các quy tắc ứng dụng bình thường áp dụng lại. Lựa chọn này không tạo quy tắc mới.'
                        : 'Các ứng dụng dưới đây sẽ được mở tạm thời (bỏ qua quy tắc chặn ứng dụng) trên máy đã chọn, sau đó các quy tắc ứng dụng bình thường áp dụng lại. Lựa chọn này không tạo quy tắc mới.'}{' '}
                      Ghi đè mới nhất sẽ thay thế ghi đè trước đó trên cùng một máy.
                    </p>
                    <AppsField
                      apps={appListDraft.apps}
                      onChange={(apps) => setAppListDraft({ ...appListDraft, apps })}
                      idPrefix="app-temp"
                    />
                    <TempOverrideTargetFields
                      devices={devices}
                      childNameById={childNameById}
                      deviceId={tempDeviceId}
                      onDeviceChange={setTempDeviceId}
                      minutes={tempMinutes}
                      onMinutesChange={setTempMinutes}
                    />
                  </div>
                )}
                {formType === 'app' && appFormKind === 'app_time_limit' && (
                  <AppTimeLimitForm draft={appTimeLimitDraft} onChange={setAppTimeLimitDraft} />
                )}
                {formType === 'app' && appFormKind === 'forced_break' && (
                  <ForcedBreakForm draft={forcedBreakDraft} onChange={setForcedBreakDraft} />
                )}

                <div className="flex flex-wrap gap-2">
                  <button type="submit" disabled={savingRule} className={primaryButtonClassName}>
                    {savingRule
                      ? isTempFormSelection
                        ? 'Đang gửi…'
                        : 'Đang lưu…'
                      : editingRule
                        ? 'Lưu thay đổi'
                        : isTempFormSelection
                          ? 'Gửi ghi đè tạm thời'
                          : 'Thêm quy tắc'}
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

          <Card title="Mẫu sẵn">
            {children.length === 0 ? (
              <p className="text-sm text-slate-700">
                Cần tạo hồ sơ con trước khi áp dụng mẫu sẵn. Hãy tạo hồ sơ con tại trang{' '}
                <Link to="/thiet-bi" className="font-medium text-indigo-600 hover:underline">
                  Thiết bị
                </Link>{' '}
                (nút “Thêm hồ sơ con”).
              </p>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Áp dụng mẫu cho con" htmlFor="preset-child">
                    <select
                      id="preset-child"
                      value={presetChildId}
                      onChange={(e) => setPresetChildId(e.target.value)}
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
                <p className="text-sm text-slate-600">
                  Mẫu sẵn chỉ THÊM quy tắc mới, không xóa hay sửa quy tắc hiện có — bạn có thể
                  tắt/xóa từng quy tắc trong danh sách bên dưới.
                </p>
                <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
                  {PRESET_OPTIONS.map((preset) => {
                    const confirming = confirmPresetId === preset.id
                    return (
                      <div key={preset.id} className="rounded-lg border border-slate-200 p-4">
                        <h3 className="text-sm font-semibold text-slate-900">{preset.label}</h3>
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
                          {preset.summary.map((line) => (
                            <li key={line}>{line}</li>
                          ))}
                        </ul>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {confirming ? (
                            <>
                              <button
                                type="button"
                                onClick={() => void handleApplyPreset(preset.id)}
                                disabled={applyingPreset}
                                className={primaryButtonClassName}
                              >
                                {applyingPreset ? 'Đang áp dụng…' : 'Xác nhận áp dụng'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmPresetId(null)}
                                disabled={applyingPreset}
                                className={secondaryButtonClassName}
                              >
                                Huỷ
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmPresetId(preset.id)}
                              className={secondaryButtonClassName}
                            >
                              Áp dụng
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
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
                          className={chipClassName(overrideMinutes === minutes)}
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
                      {activeOverride.domains && activeOverride.domains.length > 0
                        ? `: ${activeOverride.domains.join(', ')}`
                        : ''}
                      {activeOverride.apps && activeOverride.apps.length > 0
                        ? `: ${activeOverride.apps.join(', ')}`
                        : ''}
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
                      className="mt-2 inline-flex min-h-[44px] items-center rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-800 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
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

          <Card title="Cho phép / chặn website tạm thời">
            {devices.length === 0 ? (
              <p className="text-sm text-slate-700">
                Chưa có thiết bị nào được ghép nối. Ghi đè website tạm thời được gửi tới từng máy, nên cần ghép
                nối máy của con trước (xem trang Thiết bị).
              </p>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Máy" htmlFor="domain-override-device">
                    <select
                      id="domain-override-device"
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
                  <Field label="Hành động" htmlFor="domain-override-action">
                    <select
                      id="domain-override-action"
                      value={domainOverrideAction}
                      onChange={(e) =>
                        setDomainOverrideAction(e.target.value as 'allow_domain' | 'block_domain')
                      }
                      className={inputClassName}
                    >
                      <option value="allow_domain">Cho phép tạm thời (bỏ chặn)</option>
                      <option value="block_domain">Chặn tạm thời</option>
                    </select>
                  </Field>
                </div>

                <DomainsField
                  id="domain-override-domains"
                  label="Domain"
                  value={domainOverrideText}
                  onChange={setDomainOverrideText}
                />

                <div>
                  <span className="mb-1 block text-sm font-medium text-slate-700">Hiệu lực trong</span>
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Thời lượng">
                    {OVERRIDE_DURATIONS.map((minutes) => (
                      <button
                        key={minutes}
                        type="button"
                        onClick={() => setDomainOverrideMinutes(minutes)}
                        aria-pressed={domainOverrideMinutes === minutes}
                        className={chipClassName(domainOverrideMinutes === minutes)}
                      >
                        {minutes} phút
                      </button>
                    ))}
                  </div>
                </div>

                <p className="text-sm text-slate-600">
                  {domainOverrideAction === 'allow_domain'
                    ? 'Các domain trên sẽ được mở tạm thời (bỏ qua quy tắc chặn website) trong thời gian đã chọn, sau đó các quy tắc website bình thường áp dụng lại.'
                    : 'Các domain trên sẽ bị chặn tạm thời trong thời gian đã chọn, sau đó các quy tắc website bình thường áp dụng lại.'}{' '}
                  Ghi đè mới nhất sẽ thay thế ghi đè trước đó trên cùng một máy (kể cả ghi đè giờ giấc).
                </p>

                {activeDomainOverride && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                    <p>
                      <span className="font-medium">Đang hiệu lực trên máy này: </span>
                      {overrideActionLabel(activeDomainOverride.action)}
                      {activeDomainOverride.domains && activeDomainOverride.domains.length > 0
                        ? `: ${activeDomainOverride.domains.join(', ')}`
                        : ''}
                      {` (${activeDomainOverride.minutes} phút)`}
                      {' — '}hết hạn lúc {formatTimeVi(activeDomainOverride.expiresAt.toISOString())} (còn{' '}
                      {formatDurationVi(
                        Math.max(0, (activeDomainOverride.expiresAt.getTime() - Date.now()) / 1000),
                      )}
                      ).
                    </p>
                    <button
                      type="button"
                      onClick={() => void handleCancelOverride()}
                      disabled={cancellingOverride}
                      className="mt-2 inline-flex min-h-[44px] items-center rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-800 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                    >
                      {cancellingOverride ? 'Đang gửi…' : 'Huỷ ghi đè này'}
                    </button>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => void handleSendDomainOverride()}
                  disabled={sendingDomainOverride || !overrideDeviceId}
                  className={primaryButtonClassName}
                >
                  {sendingDomainOverride ? 'Đang gửi…' : 'Gửi ghi đè website tạm thời'}
                </button>
              </div>
            )}
          </Card>

          {rules.length === 0 ? (
            <EmptyState
              title="Chưa có quy tắc nào"
              description="Chưa có quy tắc nào cho gia đình của bạn. Thêm quy tắc ở trên hoặc áp dụng một mẫu sẵn để bắt đầu."
            />
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={expandAllRules} className={secondaryButtonClassName}>
                  Mở rộng tất cả
                </button>
                <button type="button" onClick={collapseAllRules} className={secondaryButtonClassName}>
                  Thu hẹp tất cả
                </button>
              </div>
              {childSections.map((section) => (
                <section
                  key={section.childId}
                  className="space-y-3"
                  aria-label={`Quy tắc của ${section.childName}`}
                >
                  <h2 className="text-base font-semibold text-slate-900">{section.childName}</h2>
                  {section.categories.map((category) => (
                    <div key={category.key} className="space-y-2">
                      <h3 className="text-sm font-medium text-slate-700">{category.label}</h3>
                      {category.rules.map((rule) => {
                        const confirmingDelete = confirmDeleteId === rule.id
                        const expanded = expandedRuleIds.has(rule.id)
                        const enforcing = enforcingRuleIds.has(rule.id)
                        const summary = describeRuleConfig(rule)[0] ?? ''
                        return (
                          <div
                            key={rule.id}
                            className={`rounded-xl border bg-white shadow-sm ${
                              enforcing ? 'border-slate-200 border-l-4 border-l-indigo-600' : 'border-slate-200'
                            }`}
                          >
                            <div className="flex items-center gap-2 px-3 py-2">
                              <button
                                type="button"
                                onClick={() => toggleRuleExpanded(rule.id)}
                                aria-expanded={expanded}
                                aria-label={`${expanded ? 'Thu hẹp' : 'Mở rộng'} quy tắc ${ruleTypeLabel(rule.type)}`}
                                className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
                              >
                                <span
                                  aria-hidden="true"
                                  className={`inline-block shrink-0 text-slate-400 transition-transform motion-reduce:transition-none ${
                                    expanded ? 'rotate-90' : ''
                                  }`}
                                >
                                  ›
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span
                                    className={`block truncate text-sm text-slate-900 ${
                                      enforcing ? 'font-bold' : 'font-semibold'
                                    }`}
                                  >
                                    {ruleTypeLabel(rule.type)}
                                  </span>
                                  <span className="block truncate text-xs text-slate-500">{summary}</span>
                                </span>
                              </button>
                              {enforcing && (
                                <span className="shrink-0 rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-medium text-indigo-800">
                                  Đang thi hành
                                </span>
                              )}
                              <button
                                type="button"
                                role="switch"
                                aria-checked={rule.enabled}
                                aria-label={`${rule.enabled ? 'Tắt' : 'Bật'} quy tắc ${ruleTypeLabel(rule.type)}`}
                                onClick={() => void handleToggle(rule)}
                                disabled={togglingId === rule.id}
                                className={`flex min-h-[44px] items-center gap-2 rounded-full px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none ${
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
                            {expanded && (
                              <div className="border-t border-slate-100 px-3 py-3">
                                <ul className="space-y-0.5 text-sm text-slate-600">
                                  {describeRuleConfig(rule).map((line) => (
                                    <li key={line}>{line}</li>
                                  ))}
                                </ul>
                                <p className="mt-2 text-xs text-slate-500">
                                  Tạo lúc {formatDateTimeVi(rule.created_at)}
                                </p>
                                <details className="mt-2 text-xs">
                                  <summary className="cursor-pointer py-3 text-indigo-600 hover:underline">
                                    Xem cấu hình JSON gốc
                                  </summary>
                                  <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-700">
                                    {JSON.stringify(rule.config, null, 2)}
                                  </pre>
                                </details>
                                <div className="mt-3 flex flex-wrap items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => startEdit(rule)}
                                    className={secondaryButtonClassName}
                                  >
                                    Sửa
                                  </button>
                                  {confirmingDelete ? (
                                    <>
                                      <button
                                        type="button"
                                        onClick={() => void handleDeleteRule(rule)}
                                        disabled={deletingId === rule.id}
                                        className={dangerButtonClassName}
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
                                      className={dangerOutlineButtonClassName}
                                    >
                                      Xoá
                                    </button>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  ))}
                </section>
              ))}
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
