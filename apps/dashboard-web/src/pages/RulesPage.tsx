import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { createFamily, getMyFamily } from '../lib/family'
import { buildRuleSummary, logRuleChange } from '../lib/ruleAudit'
import type { Child, Command, Device, DeviceChildAccount, Family, Rule, TemporaryOverrideAction } from '../lib/types'
import {
  commandTargetsChild,
  describeCommandInsertError,
  fetchDeviceChildAccounts,
  targetChildrenForDevice,
} from '../lib/deviceChildren'
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
  buildBlockSearchKeywordsConfig,
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
  emptySearchKeywordsDraft,
  emptyTimeWindowDraft,
  emptyWebsiteDomainsDraft,
  parseAppConfig,
  parseBedtimeConfig,
  parseDailyLimitConfig,
  parseDomainsInput,
  parseTimeWindowConfig,
  parseWebsiteConfig,
  parseWebsiteEntriesInput,
  rejectUrlPatternsError,
  timeWindowConfigToDraft,
  timeWindowDraftToConfig,
  validateAllowlistByTimeDraft,
  validateAppAllowlistByTimeDraft,
  validateAppBlockByTimeDraft,
  validateAppListDraft,
  validateAppTimeLimitDraft,
  validateBedtimeDraft,
  validateBlockDomainsByTimeDraft,
  validateBlockDomainsDraft,
  validateDailyLimitDraft,
  validateDomainTimeLimitDraft,
  validateFocusDraft,
  validateForcedBreakDraft,
  validateSearchKeywordsDraft,
  validateTimeWindowDraft,
  websiteConfigToAllowlistByTimeDraft,
  websiteConfigToBlockByTimeDraft,
  websiteConfigToDomainsDraft,
  websiteConfigToFocusDraft,
  websiteConfigToSafeSearchDraft,
  websiteConfigToSearchKeywordsDraft,
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
  type SearchKeywordsDraft,
  type TimeKind,
  type TimeWindowDraft,
  type WebsiteDomainsDraft,
} from '../lib/ruleConfig'
import {
  describeRuleConfig,
  formatDurationVi,
  formatTimeVi,
  overrideActionLabel,
  parseEnforcementSnapshot,
  ruleTypeLabel,
  toVietnameseError,
} from '../lib/format'
import {
  EDGE_ONLY_TEMPLATE_NAME,
  KNOWN_BROWSERS,
  RULE_CATEGORY_OF,
  RULE_CATEGORY_ORDER,
  RULE_CATEGORY_THEME,
  SEARCH_KEYWORDS_TEMPLATE_NAME,
  buildEdgeOnlyTemplateItems,
  buildSearchKeywordsTemplateItems,
  parseRuleTemplateRow,
  ruleDisplayName,
  ruleToTemplateItem,
  type RuleCategoryKey,
  type RuleTemplate,
  type RuleTemplateItem,
} from '../lib/ruleTemplates'
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
  SearchKeywordsForm,
  TimeKindPicker,
  TimeWindowForm,
} from '../components/RuleForms'
import { RuleCard } from '../components/RuleCard'
import {
  AlertBox,
  Card,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  NotConfiguredState,
  PageHeader,
  checkboxClassName,
  chipClassName,
  dangerButtonClassName,
  dangerOutlineButtonClassName,
  inputClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
  warningButtonClassName,
} from '../components/ui'

type LoadState = 'loading' | 'ready' | 'error'

/** Các loại quy tắc có form thêm/sửa trên trang này: cả 5 loại đều sửa được (đợt 3 thêm quy tắc ứng dụng). */
type EditableRuleType = 'daily_limit' | 'time_window' | 'bedtime' | 'website' | 'app'

/**
 * Nhóm form của quy tắc website/ứng dụng. 'list' là nhóm danh sách
 * (chặn/cho phép × luôn luôn/theo giờ/tạm thời); các nhóm còn lại giữ
 * form riêng như trước.
 */
type WebsiteFormKind = 'list' | 'domain_time_limit' | 'safe_search' | 'block_search_keywords' | 'focus'
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
 * Suy ra ghi đè đang hiệu lực của một máy từ các lệnh mới nhất (mới nhất
 * thắng — kể cả khác loại: ghi đè website mới nhất sẽ thay thế ghi đè
 * giờ giấc trước đó và ngược lại; lệnh cancel hoặc lệnh đã hết hạn nghĩa
 * là không còn ghi đè nào hiệu lực). `commands` phải xếp mới nhất trước
 * và phải gồm cả lệnh `lock_now`: Service hủy ghi đè MỞ KHÓA khi nhận
 * lock_now, nên một lệnh lock_now mới hơn ghi đè mở khóa nghĩa là ghi đè
 * đó đã chết (các ghi đè khác — cộng giờ, chặn/mở domain/app — lock_now
 * không hủy nên vẫn hiệu lực). Đây là hiển thị tham khảo — Agent trên
 * máy con mới là nơi thi hành thật, dựa trên bản ghi đè nó đã lưu local
 * và thời gian hết hạn.
 */
function getActiveOverride(commands: Command[], deviceId: string, nowMs: number, childId?: string, defaultChildId?: string | null): ActiveOverride | null {
  // Có lệnh lock_now mới hơn ghi đè đang xét hay không (duyệt mới nhất
  // trước nên lock_now gặp trước ghi đè nghĩa là mới hơn ghi đè đó).
  let sawNewerLockNow = false
  for (const command of commands) {
    if (command.device_id !== deviceId) continue
    // Sprint 5: chỉ xét ghi đè nhắm tới đúng con đang chọn (lệnh cũ
    // không có child_id thì tính cho con mặc định của máy). Ghi đè là
    // theo từng con phía Service nên ghi đè của con khác không được
    // tính là "đang hiệu lực" cho con này.
    if (childId !== undefined && !commandTargetsChild(command, childId, defaultChildId ?? null)) {
      continue
    }
    if (command.type === 'lock_now') {
      sawNewerLockNow = true
      continue
    }
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
    // Ghi đè mở khóa đã bị lock_now mới hơn hủy phía Service thì không
    // còn hiệu lực — không hiển thị ghi đè đã chết.
    if (action === 'unlock' && sawNewerLockNow) return null
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
 * Nhãn ô chọn máy: tên máy + TẤT CẢ con được quản lý trên máy đó (con mặc
 * định trước, rồi các con gắn thêm qua ánh xạ — xem targetChildrenForDevice),
 * không chỉ con mặc định. Máy chưa gán con nào thì chỉ hiện tên máy.
 */
function deviceOptionLabel(
  device: Device,
  childAccounts: readonly DeviceChildAccount[],
  childNameById: Map<string, string>,
): string {
  const names = targetChildrenForDevice(device, childAccounts)
    .map((id) => childNameById.get(id) ?? '')
    .filter((name) => name !== '')
  return names.length > 0 ? `${device.hostname} — ${names.join(', ')}` : device.hostname
}

/**
 * Ô chọn máy nhận ghi đè + thời lượng, dùng trong form quy tắc khi chọn
 * "Tạm thời — đếm ngược". Cùng mẫu với thẻ ghi đè tạm thời: chọn máy
 * (kèm tên con), chọn số phút trong 15/30/60/120.
 */
function TempOverrideTargetFields({
  devices,
  childAccounts,
  childNameById,
  deviceId,
  onDeviceChange,
  minutes,
  onMinutesChange,
}: {
  devices: Device[]
  childAccounts: readonly DeviceChildAccount[]
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
              {deviceOptionLabel(device, childAccounts, childNameById)}
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

/**
 * Một nhóm trong accordion "Tạo quy tắc mới": tiêu đề màu theo nhóm
 * (kèm nhãn chữ + mô tả, không dùng màu làm kênh duy nhất), click để
 * mở/đóng; nội dung form chỉ render khi mở.
 */
function CreateSection({
  category,
  description,
  open,
  disabled,
  onToggle,
  children,
}: {
  category: RuleCategoryKey
  description: string
  open: boolean
  disabled: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const theme = RULE_CATEGORY_THEME[category]
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200">
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-expanded={open}
        className={`flex min-h-[56px] w-full items-center justify-between gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 ${
          open ? theme.accordionOpen : theme.accordionClosed
        }`}
      >
        <span className="min-w-0">
          <span className={`block text-sm font-semibold ${theme.headingText}`}>{theme.label}</span>
          <span className="block truncate text-xs font-normal text-slate-500">{description}</span>
        </span>
        <span
          aria-hidden="true"
          className={`shrink-0 text-lg leading-none text-slate-400 transition-transform motion-reduce:transition-none ${
            open ? 'rotate-90' : ''
          }`}
        >
          ›
        </span>
      </button>
      {open && <div className="space-y-4 border-t border-slate-100 p-4">{children}</div>}
    </div>
  )
}

export default function RulesPage({ childIdFilter }: { childIdFilter?: string } = {}) {
  const { configured, user } = useAuth()
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [family, setFamily] = useState<Family | null>(null)
  const [rules, setRules] = useState<Rule[]>([])
  const [children, setChildren] = useState<Child[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [overrideCommands, setOverrideCommands] = useState<Command[]>([])
  // Ánh xạ con ↔ tài khoản Windows (bảng device_child_accounts,
  // migration 24) — best-effort (xem load()): chưa áp migration 24 thì
  // rỗng và trang chạy như trước (chỉ con mặc định của máy).
  const [childAccounts, setChildAccounts] = useState<DeviceChildAccount[]>([])
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
  // Tên quy tắc do phụ huynh đặt (không bắt buộc; trống thì hiển thị tên
  // tự sinh từ loại rule). Chỉ lưu được khi cột rules.name đã có
  // (migration 9) — xem namesAvailable.
  const [ruleName, setRuleName] = useState('')
  // Nhóm form tạo mới đang mở trong accordion; null = tất cả đóng (mặc
  // định). Mở một nhóm thì các nhóm khác đóng. Khi sửa rule thì nhóm của
  // rule đó tự mở và không chuyển nhóm được.
  const [createOpen, setCreateOpen] = useState<RuleCategoryKey | null>(null)
  // Cột rules.name có tồn tại không (truy vấn best-effort trong load()).
  // Chưa áp migration 9 thì ô tên rule ẩn đi, trang vẫn chạy bình thường.
  const [namesAvailable, setNamesAvailable] = useState(false)
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
  const [searchKeywordsDraft, setSearchKeywordsDraft] =
    useState<SearchKeywordsDraft>(emptySearchKeywordsDraft())
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

  // Rule đang thi hành mà bằng chứng mới nhất đã quá cũ (hơn 5 phút, cùng
  // ngưỡng trang Thiết bị), tính THEO TỪNG RULE — khi cũ thì highlight
  // "Đang thi hành" chỉ còn là dữ liệu cũ (RuleCard bớt đậm + gắn nhãn
  // "Dữ liệu cũ"). Tính theo từng rule vì snapshot mới của một máy không
  // chứng minh được rule của máy khác vẫn đang thi hành.
  const [staleEnforcingRuleIds, setStaleEnforcingRuleIds] = useState<ReadonlySet<string>>(new Set())

  // Thẻ quy tắc đang mở rộng trong danh sách nhóm; mặc định tất cả đóng.
  const [expandedRuleIds, setExpandedRuleIds] = useState<ReadonlySet<string>>(new Set())

  // Mẫu sẵn một chạm: chọn con riêng, xác nhận 2 bước cho từng mẫu.
  const [presetChildId, setPresetChildId] = useState('')
  const [confirmPresetId, setConfirmPresetId] = useState<PresetId | null>(null)
  const [applyingPreset, setApplyingPreset] = useState(false)

  // Mẫu của phụ huynh (bảng rule_templates, migration 9): truy vấn
  // best-effort — bảng chưa tồn tại thì templatesState = 'unavailable'
  // và mục mẫu ẩn đi kèm ghi chú, trang không vỡ.
  const [templates, setTemplates] = useState<RuleTemplate[]>([])
  const [templatesState, setTemplatesState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  // Form tạo mẫu mới từ các rule hiện có (mặc định đóng).
  const [showTemplateForm, setShowTemplateForm] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [templateDescription, setTemplateDescription] = useState('')
  const [templateSelectedIds, setTemplateSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [savingTemplate, setSavingTemplate] = useState(false)
  // Sửa mẫu: bản làm việc của các mục trong mẫu (xóa mục / thêm rule
  // hiện có), lưu đè lên mẫu khi bấm Lưu.
  const [editingTemplate, setEditingTemplate] = useState<RuleTemplate | null>(null)
  const [editingTemplateName, setEditingTemplateName] = useState('')
  const [editingTemplateDescription, setEditingTemplateDescription] = useState('')
  const [editingTemplateItems, setEditingTemplateItems] = useState<RuleTemplateItem[]>([])
  const [editingTemplateAddRuleId, setEditingTemplateAddRuleId] = useState('')
  // Xoá mẫu: bấm 2 lần như xoá rule.
  const [confirmDeleteTemplateId, setConfirmDeleteTemplateId] = useState<string | null>(null)
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(null)
  // Áp mẫu (mẫu của phụ huynh + mẫu "Chỉ cho phép Edge"): xác nhận 2
  // bước với tóm tắt tên mẫu + số rule + con đích, như mẫu một chạm.
  const [confirmTemplateId, setConfirmTemplateId] = useState<string | null>(null)
  const [confirmEdgeTemplate, setConfirmEdgeTemplate] = useState(false)
  const [confirmSearchKeywordsTemplate, setConfirmSearchKeywordsTemplate] = useState(false)
  const [applyingTemplate, setApplyingTemplate] = useState(false)

  // Xoá quy tắc: bấm 2 lần (bấm "Xoá" rồi "Xác nhận xoá") để tránh xoá nhầm.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Ghi đè tạm thời (gửi tới từng máy, tự hết hạn).
  const [overrideDeviceId, setOverrideDeviceId] = useState('')
  // Con đích của ghi đè tạm thời trên máy đã chọn (Sprint 5: ghi đè gắn
  // theo từng con). Mặc định: con trong hồ sơ đang xem (childIdFilter),
  // nếu không thì con mặc định của máy.
  const [overrideChildId, setOverrideChildId] = useState('')
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
          .in('type', ['temporary_override', 'lock_now'])
          .order('created_at', { ascending: false })
          .limit(200),
      ])
      if (rulesResult.error) throw rulesResult.error
      if (childrenResult.error) throw childrenResult.error
      if (devicesResult.error) throw devicesResult.error
      if (commandsResult.error) throw commandsResult.error
      setFamily(familyResult)
      setChildren((childrenResult.data ?? []) as Child[])
      setDevices((devicesResult.data ?? []) as Device[])
      setOverrideCommands((commandsResult.data ?? []) as Command[])
      // Truy vấn RIÊNG, best-effort: cột commands.child_id chỉ có sau
      // migration 24 (cùng lý do như trang Thiết bị: không gộp vào truy
      // vấn chính để khỏi vỡ trang trước khi migration 24 được áp).
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
      // sau migration 24. Truy vấn lỗi thì coi như chưa có ánh xạ — trang
      // chạy như trước (chỉ con mặc định của máy), KHÔNG làm hỏng trang.
      const mappingsResult = await fetchDeviceChildAccounts(supabase)
      setChildAccounts(mappingsResult.accounts)
      // Truy vấn RIÊNG, best-effort: cột rules.name chỉ có sau migration
      // 9. Truy vấn lỗi (cột chưa tồn tại) thì tên rule vắng mặt và ô đặt
      // tên ẩn đi, KHÔNG làm hỏng cả trang.
      let loadedRules = (rulesResult.data ?? []) as Rule[]
      try {
        const namesResult = await supabase.from('rules').select('id, name')
        if (namesResult.error) {
          setNamesAvailable(false)
        } else {
          const nameById = new Map(
            (namesResult.data ?? []).map((row) => [row.id as string, row.name as string | null]),
          )
          loadedRules = loadedRules.map((rule) => ({ ...rule, name: nameById.get(rule.id) ?? null }))
          setNamesAvailable(true)
        }
      } catch {
        setNamesAvailable(false)
      }
      setRules(loadedRules)
      // Truy vấn RIÊNG, best-effort: bảng rule_templates chỉ có sau
      // migration 9. Truy vấn lỗi (bảng chưa tồn tại) thì mục "Mẫu của
      // tôi" ẩn đi kèm ghi chú, KHÔNG làm hỏng cả trang.
      try {
        const templatesResult = await supabase
          .from('rule_templates')
          .select('id, family_id, name, description, rules, created_at, updated_at')
          .order('created_at', { ascending: true })
        if (templatesResult.error) {
          setTemplates([])
          setTemplatesState('unavailable')
        } else {
          const parsed = (templatesResult.data ?? [])
            .map((row) => parseRuleTemplateRow(row))
            .filter((template): template is RuleTemplate => template !== null)
          setTemplates(parsed)
          setTemplatesState('ready')
        }
      } catch {
        setTemplates([])
        setTemplatesState('unavailable')
      }
      // Truy vấn RIÊNG, best-effort: cột enforcement_json /
      // enforcement_updated_at chỉ có sau migration 6. Truy vấn lỗi (cột
      // chưa tồn tại) thì coi như chưa biết rule nào đang thi hành, KHÔNG
      // làm hỏng cả trang.
      try {
        const enforcementResult = await supabase
          .from('devices')
          .select('id, enforcement_json, enforcement_updated_at')
        if (enforcementResult.error) {
          setEnforcingRuleIds(new Set())
          setStaleEnforcingRuleIds(new Set())
        } else {
          const ids = new Set<string>()
          // updated_at mới nhất theo từng rule — snapshot mới của một máy
          // không làm tươi bằng chứng của rule chỉ thi hành trên máy khác.
          const newestUpdatedByRule = new Map<string, number>()
          for (const row of (enforcementResult.data ?? []) as Array<{
            id: string
            enforcement_json: unknown
            enforcement_updated_at: string | null
          }>) {
            const snapshot = parseEnforcementSnapshot(row.enforcement_json)
            const updatedMs = row.enforcement_updated_at
              ? new Date(row.enforcement_updated_at).getTime()
              : Number.NaN
            if (snapshot) {
              for (const ruleId of snapshot.ruleIds) {
                ids.add(ruleId)
                if (!Number.isNaN(updatedMs)) {
                  const prev = newestUpdatedByRule.get(ruleId)
                  if (prev === undefined || updatedMs > prev) {
                    newestUpdatedByRule.set(ruleId, updatedMs)
                  }
                }
              }
            }
          }
          setEnforcingRuleIds(ids)
          // Rule mà bằng chứng mới nhất quá 5 phút (cùng ngưỡng trang
          // Thiết bị) thì highlight "Đang thi hành" là dữ liệu cũ — RuleCard
          // bớt đậm và gắn nhãn "Dữ liệu cũ" thay vì tô đậm như dữ liệu
          // tươi. Rule không rõ thời điểm (updated_at trống) thì không tính
          // là cũ.
          const staleIds = new Set<string>()
          for (const [ruleId, newestMs] of newestUpdatedByRule) {
            if (Date.now() - newestMs > 5 * 60 * 1000) staleIds.add(ruleId)
          }
          setStaleEnforcingRuleIds(staleIds)
        }
      } catch {
        setEnforcingRuleIds(new Set())
        setStaleEnforcingRuleIds(new Set())
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
    if (childIdFilter) {
      setFormChildId(childIdFilter)
    } else if (!formChildId && children.length > 0) {
      setFormChildId(children[0].id)
    }
  }, [children, formChildId, childIdFilter])

  useEffect(() => {
    if (childIdFilter) {
      setPresetChildId(childIdFilter)
    } else if (!presetChildId && children.length > 0) {
      setPresetChildId(children[0].id)
    }
  }, [children, presetChildId, childIdFilter])

  // Sprint 5: máy của một con là máy mà con là hồ sơ mặc định HOẶC đã
  // gắn qua ánh xạ tài khoản Windows (máy chung hiện trong hồ sơ của cả
  // hai con, không chỉ con mặc định như trước).
  const devicesForChild = useCallback(
    (childId: string) =>
      devices.filter(
        (d) =>
          d.child_id === childId ||
          childAccounts.some((a) => a.device_id === d.id && a.child_id === childId),
      ),
    [devices, childAccounts],
  )

  // Sprint 5: khi đổi hồ sơ con thì máy đã chọn phải thuộc pool máy
  // của con mới — nếu không, lệnh của con mới sẽ gửi nhầm sang máy của
  // con cũ (component được tái dùng khi chuyển tab hồ sơ, state cũ sống
  // sót). Reset về máy đầu tiên của pool mới khi máy cũ không còn trong
  // pool (hoặc chưa chọn máy nào).
  useEffect(() => {
    const pool = childIdFilter ? devicesForChild(childIdFilter) : devices
    if (pool.length === 0) {
      if (overrideDeviceId) setOverrideDeviceId('')
      return
    }
    if (!overrideDeviceId || !pool.some((d) => d.id === overrideDeviceId)) {
      setOverrideDeviceId(pool[0].id)
    }
  }, [devices, devicesForChild, overrideDeviceId, childIdFilter])

  useEffect(() => {
    // Pool máy của form ghi đè tạm thời theo đúng con đã chọn trong form
    // (cùng pool với TempOverrideTargetFields) — đổi con thì máy đã chọn
    // phải thuộc pool mới, nếu không ô chọn máy sẽ trống vì tempDeviceId
    // không nằm trong danh sách.
    const pool = formChildId
      ? devicesForChild(formChildId)
      : childIdFilter
        ? devicesForChild(childIdFilter)
        : devices
    if (pool.length === 0) {
      if (tempDeviceId) setTempDeviceId('')
      return
    }
    if (!tempDeviceId || !pool.some((d) => d.id === tempDeviceId)) {
      setTempDeviceId(pool[0].id)
    }
  }, [devices, devicesForChild, tempDeviceId, childIdFilter, formChildId])

  // Con đích của ghi đè tạm thời: trong hồ sơ của một con thì luôn là
  // con đó; trang độc lập thì mặc định theo máy đã chọn (con mặc định
  // của máy, fallback: con gắn đầu tiên) và đổi theo khi đổi máy.
  const overrideDevice = devices.find((d) => d.id === overrideDeviceId)
  const overrideTargetChildIds = overrideDevice
    ? targetChildrenForDevice(overrideDevice, childAccounts)
    : []
  useEffect(() => {
    if (childIdFilter) {
      setOverrideChildId(childIdFilter)
      return
    }
    if (overrideTargetChildIds.length === 0) return
    if (!overrideChildId || !overrideTargetChildIds.includes(overrideChildId)) {
      setOverrideChildId(overrideTargetChildIds[0])
    }
  }, [childIdFilter, overrideTargetChildIds, overrideChildId])

  const childNameById = new Map(children.map((c) => [c.id, c.display_name]))

  // Khi nhúng trong hồ sơ của một con (tab Quy tắc) thì chỉ hiện quy tắc,
  // máy và lựa chọn của con đó; trang độc lập (/quy-tac) hiện mọi con.
  const visibleChildren = childIdFilter ? children.filter((c) => c.id === childIdFilter) : children
  const visibleDevices = childIdFilter ? devicesForChild(childIdFilter) : devices
  const visibleRules = childIdFilter ? rules.filter((r) => r.child_id === childIdFilter) : rules

  const resetDrafts = () => {
    setRuleName('')
    setDailyDraft(emptyDailyLimitDraft())
    setWindowDraft(emptyTimeWindowDraft())
    setBedtimeDraft(emptyBedtimeDraft())
    setWebsiteDomainsDraft(emptyWebsiteDomainsDraft())
    setBlockByTimeDraft(emptyBlockDomainsByTimeDraft())
    setAllowlistByTimeDraft(emptyAllowlistByTimeDraft())
    setTimeLimitDraft(emptyDomainTimeLimitDraft())
    setSafeSearchDraft(emptySafeSearchDraft())
    setSearchKeywordsDraft(emptySearchKeywordsDraft())
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
      // Ghi nhật ký best-effort: không bao giờ làm hỏng thao tác bật/tắt.
      await logRuleChange({
        familyId: rule.family_id,
        childId: rule.child_id,
        action: nextEnabled ? 'rule_enabled' : 'rule_disabled',
        target: rule.id,
        details: { rule_name: ruleDisplayName(rule), rule_type: rule.type },
      })
      setActionMessage(
        `Đã ${nextEnabled ? 'bật' : 'tắt'} quy tắc “${ruleDisplayName(rule)}” cho ${childNameById.get(rule.child_id) ?? 'con'}.`,
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
        parsed?.mode === 'block_search_keywords' ||
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
      setSearchKeywordsDraft(websiteConfigToSearchKeywordsDraft(parsed))
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
    setRuleName(rule.name ?? '')
    setEditingRule(rule)
    // Mở đúng nhóm accordion của rule và cuộn tới form (danh sách hiện
    // hành đang ở đầu trang, form tạo/sửa ở phía dưới).
    setCreateOpen(RULE_CATEGORY_OF[rule.type])
    setActionError(null)
    setActionMessage(null)
    setConfirmDeleteId(null)
    document.getElementById('rule-form-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
    // Con đích của form phải có hồ sơ (không gửi ghi đè "vô chủ") và
    // phải được quản lý trên máy đã chọn (mặc định hoặc đã gắn qua ánh
    // xạ) — nếu không lệnh sẽ pending tới hết hạn mà không bao giờ được
    // thi hành cho con đó trên máy này.
    if (!formChildId) {
      setActionError('Chưa chọn hồ sơ con nhận ghi đè. Hãy chọn con trước rồi gửi lại.')
      return
    }
    if (!targetChildrenForDevice(device, childAccounts).includes(formChildId)) {
      setActionError(
        `${childNameById.get(formChildId) ?? 'Con'} chưa được quản lý trên máy "${device.hostname}" (chưa phải con mặc định của máy và chưa gắn tài khoản Windows với máy này). Hãy chọn máy khác hoặc gắn tài khoản Windows của con với máy này (xem trang Thiết bị).`,
      )
      return
    }
    const parsedDomains =
      formType === 'website' ? parseDomainsInput(websiteDomainsDraft.domainsText) : null
    if (parsedDomains?.error) {
      setActionError(parsedDomains.error)
      return
    }
    // Ghi đè tạm thời chỉ làm việc với toàn bộ domain (đợt 4): ô nhập
    // dùng chung với form quy tắc nên có thể mang mục đường dẫn
    // ("bing.com/videos"); từ chối rõ ràng thay vì lặng lẽ cắt thành
    // domain và chặn/cho phép cả domain.
    if (formType === 'website') {
      const splitEntries = parseWebsiteEntriesInput(websiteDomainsDraft.domainsText)
      if (splitEntries.urlPatterns.length > 0) {
        setActionError(
          'Ghi đè tạm thời chỉ áp dụng cho toàn bộ domain, chưa hỗ trợ theo đường dẫn. Hãy bỏ các mục có dấu / (ví dụ: bing.com/videos) rồi gửi lại, hoặc tạo quy tắc chặn theo đường dẫn.',
        )
        return
      }
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
      // Sprint 5: ghi đè gắn với hồ sơ con của form (formChildId) trên
      // đúng máy đã chọn — Agent chỉ thi hành khi đúng con đó active;
      // lệnh cho con chưa active thì giữ pending tới khi con đăng nhập.
      const { error: insertError } = await supabase.from('commands').insert({
        family_id: device.family_id,
        device_id: device.id,
        child_id: formChildId,
        type: 'temporary_override',
        payload,
        status: 'pending',
      })
      if (insertError) throw insertError
      setActionMessage(
        `Đã gửi "${overrideActionLabel(action)}" (${targets.join(', ')}) cho ${childNameById.get(formChildId) ?? 'con'} trên máy "${device.hostname}". Agent sẽ nhận lệnh trong vòng ~15 giây khi máy online; ghi đè tự hết hạn lúc ${formatTimeVi(expiresAt.toISOString())}. Nếu con chưa đăng nhập trên máy này, lệnh sẽ áp dụng khi con đăng nhập.`,
      )
      await load()
    } catch (err) {
      setActionError(describeCommandInsertError(err) ?? toVietnameseError(err))
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
      } else if (websiteFormKind === 'block_search_keywords') {
        const validationError = validateSearchKeywordsDraft(searchKeywordsDraft)
        if (validationError) {
          setActionError(validationError)
          return
        }
        config = buildBlockSearchKeywordsConfig(searchKeywordsDraft)
      } else {
        const mode = websiteModeFromListSelection(
          websiteListKind,
          websiteTimeKind === 'by_time' ? 'by_time' : 'always',
        )
        if (mode === 'block_domains') {
          // Rule hợp lệ khi có domain/đường dẫn HOẶC danh mục đã chọn
          // (đợt danh mục) — mục gõ tay sai vẫn bị từ chối dù đã chọn
          // danh mục, để không lặng lẽ bỏ mục sai.
          const validationError = validateBlockDomainsDraft(websiteDomainsDraft)
          if (validationError) {
            setActionError(validationError)
            return
          }
          config = buildBlockDomainsConfig(websiteDomainsDraft.domainsText, websiteDomainsDraft.categories)
        } else if (mode === 'allowlist') {
          // Allowlist chưa thi hành đường dẫn: từ chối mục có dấu / thay vì
          // lưu lặng lẽ rồi không chặn (đợt 4 chỉ thi hành ở block_domains).
          const validationError = rejectUrlPatternsError(websiteDomainsDraft.domainsText)
          if (validationError) {
            setActionError(validationError)
            return
          }
          config = buildAllowlistConfig(websiteDomainsDraft.domainsText)
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
      // Tên quy tắc: chỉ gửi lên khi cột rules.name đã có (migration 9);
      // tên trống thì lưu NULL để hiển thị tên tự sinh.
      const trimmedName = ruleName.trim()
      const nameField = namesAvailable ? { name: trimmedName === '' ? null : trimmedName } : {}
      if (editingRule) {
        const { error: updateError } = await supabase
          .from('rules')
          .update({ child_id: formChildId, config, ...nameField })
          .eq('id', editingRule.id)
        if (updateError) throw updateError
        // Ghi nhật ký best-effort: tên mới (chưa lưu thì tên cũ), tóm
        // tắt cấu hình mới + cũ, tên cũ khi đổi tên, con cũ khi chuyển con.
        const newName = namesAvailable ? (trimmedName === '' ? null : trimmedName) : (editingRule.name ?? null)
        const oldCustomName = editingRule.name?.trim() ?? ''
        const newCustomName = namesAvailable ? trimmedName : oldCustomName
        await logRuleChange({
          familyId: editingRule.family_id,
          childId: formChildId,
          action: 'rule_updated',
          target: editingRule.id,
          details: {
            rule_name: ruleDisplayName({ name: newName, type: editingRule.type }),
            rule_type: editingRule.type,
            summary: buildRuleSummary(editingRule.type, config),
            previous_summary: buildRuleSummary(editingRule.type, editingRule.config),
            ...(oldCustomName !== '' && newCustomName !== '' && oldCustomName !== newCustomName
              ? { previous_name: oldCustomName }
              : {}),
            ...(editingRule.child_id !== formChildId ? { previous_child_id: editingRule.child_id } : {}),
          },
        })
        setActionMessage('Đã cập nhật quy tắc.')
        setEditingRule(null)
        // Sửa xong thì đóng accordion để phụ huynh nhìn lại danh sách.
        setCreateOpen(null)
      } else {
        // Đọc lại id hàng vừa tạo để nhật ký gắn đúng quy tắc; đọc lại
        // thất bại thì target để null, nhật ký vẫn ghi được.
        const { data: insertedRule, error: insertError } = await supabase
          .from('rules')
          .insert({
            family_id: family.id,
            child_id: formChildId,
            type: formType,
            config,
            enabled: true,
            ...nameField,
          })
          .select('id')
          .maybeSingle()
        if (insertError) throw insertError
        // Ghi nhật ký best-effort: không bao giờ làm hỏng thao tác thêm.
        await logRuleChange({
          familyId: family.id,
          childId: formChildId,
          action: 'rule_created',
          target: (insertedRule as { id: string } | null)?.id ?? null,
          details: {
            rule_name: ruleDisplayName({
              name: namesAvailable ? (trimmedName === '' ? null : trimmedName) : null,
              type: formType,
            }),
            rule_type: formType,
            summary: buildRuleSummary(formType, config),
          },
        })
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
      // Ghi nhật ký best-effort kèm ảnh chụp tên/loại/tóm tắt của quy
      // tắc vừa xóa (hàng đã mất nên không đọc lại được).
      await logRuleChange({
        familyId: rule.family_id,
        childId: rule.child_id,
        action: 'rule_deleted',
        target: rule.id,
        details: {
          rule_name: ruleDisplayName(rule),
          rule_type: rule.type,
          summary: buildRuleSummary(rule.type, rule.config),
        },
      })
      if (editingRule?.id === rule.id) {
        setEditingRule(null)
        resetDrafts()
      }
      setConfirmDeleteId(null)
      setActionMessage(`Đã xoá quy tắc “${ruleDisplayName(rule)}”.`)
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
      // Ghi nhật ký best-effort: MỘT hàng cho cả lần áp mẫu (không ghi
      // từng quy tắc) để nhật ký không bị ngập.
      await logRuleChange({
        familyId: family.id,
        childId: presetChildId,
        action: 'preset_applied',
        target: presetId,
        details: { template_name: preset.label, rule_count: bundle.length },
      })
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

  // Mẫu của phụ huynh chỉ THÊM quy tắc mới như mẫu một chạm. Chèn cả
  // gói trong một lần gọi insert để không áp dụng dở dang. Tên của từng
  // rule trong mẫu chỉ gửi lên khi cột rules.name đã có (migration 9).
  // Tham số audit cho biết lần áp này là mẫu của phụ huynh (ghi id mẫu)
  // hay mẫu sẵn "Chỉ cho phép Edge" (ghi id ổn định 'edge_only') để
  // nhật ký phân biệt được hai nguồn.
  const handleApplyTemplateItems = async (
    items: RuleTemplateItem[],
    templateLabel: string,
    audit: { action: 'template_applied' | 'preset_applied'; target: string },
  ) => {
    if (!supabase || !family || !presetChildId) return
    if (items.length === 0) {
      setActionError('Mẫu này không có quy tắc nào để áp dụng.')
      return
    }
    setApplyingTemplate(true)
    setActionError(null)
    setActionMessage(null)
    try {
      const { error: insertError } = await supabase.from('rules').insert(
        items.map((item) => ({
          family_id: family.id,
          child_id: presetChildId,
          type: item.type,
          config: item.config,
          enabled: true,
          ...(namesAvailable && item.name ? { name: item.name } : {}),
        })),
      )
      if (insertError) throw insertError
      // Ghi nhật ký best-effort: MỘT hàng cho cả lần áp mẫu.
      await logRuleChange({
        familyId: family.id,
        childId: presetChildId,
        action: audit.action,
        target: audit.target,
        details: { template_name: templateLabel, rule_count: items.length },
      })
      setConfirmTemplateId(null)
      setConfirmEdgeTemplate(false)
      setConfirmSearchKeywordsTemplate(false)
      setActionMessage(
        `Đã áp dụng mẫu “${templateLabel}” cho ${childNameById.get(presetChildId) ?? 'con'}: thêm ${items.length} quy tắc mới.`,
      )
      await load()
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setApplyingTemplate(false)
    }
  }

  const handleSaveTemplate = async () => {
    if (!supabase || !family) return
    const name = templateName.trim()
    if (name === '') {
      setActionError('Hãy đặt tên cho mẫu (vd: Giờ học, Ngày nghỉ).')
      return
    }
    const selected = rules.filter((rule) => templateSelectedIds.has(rule.id))
    if (selected.length === 0) {
      setActionError('Hãy chọn ít nhất một quy tắc hiện có để lưu thành mẫu.')
      return
    }
    setSavingTemplate(true)
    setActionError(null)
    setActionMessage(null)
    try {
      // Đọc lại id hàng vừa tạo để nhật ký gắn đúng mẫu; đọc lại thất
      // bại thì target để null, nhật ký vẫn ghi được.
      const { data: insertedTemplate, error: insertError } = await supabase
        .from('rule_templates')
        .insert({
          family_id: family.id,
          name,
          description: templateDescription.trim() === '' ? null : templateDescription.trim(),
          rules: selected.map(ruleToTemplateItem),
        })
        .select('id')
        .maybeSingle()
      if (insertError) throw insertError
      // Ghi nhật ký best-effort: sự kiện ở cấp mẫu nên không gắn con.
      await logRuleChange({
        familyId: family.id,
        childId: null,
        action: 'template_created',
        target: (insertedTemplate as { id: string } | null)?.id ?? null,
        details: { template_name: name, rule_count: selected.length },
      })
      setShowTemplateForm(false)
      setTemplateName('')
      setTemplateDescription('')
      setTemplateSelectedIds(new Set())
      setActionMessage(`Đã lưu mẫu “${name}” (${selected.length} quy tắc).`)
      await load()
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setSavingTemplate(false)
    }
  }

  const startEditTemplate = (template: RuleTemplate) => {
    setEditingTemplate(template)
    setEditingTemplateName(template.name)
    setEditingTemplateDescription(template.description ?? '')
    setEditingTemplateItems(template.rules)
    setEditingTemplateAddRuleId('')
    setActionError(null)
    setActionMessage(null)
  }

  const cancelEditTemplate = () => {
    setEditingTemplate(null)
    setEditingTemplateItems([])
  }

  const handleUpdateTemplate = async () => {
    if (!supabase || !editingTemplate) return
    const name = editingTemplateName.trim()
    if (name === '') {
      setActionError('Tên mẫu không được để trống.')
      return
    }
    if (editingTemplateItems.length === 0) {
      setActionError('Mẫu phải còn ít nhất một quy tắc.')
      return
    }
    setSavingTemplate(true)
    setActionError(null)
    setActionMessage(null)
    try {
      const { error: updateError } = await supabase
        .from('rule_templates')
        .update({
          name,
          description: editingTemplateDescription.trim() === '' ? null : editingTemplateDescription.trim(),
          rules: editingTemplateItems,
          updated_at: new Date().toISOString(),
        })
        .eq('id', editingTemplate.id)
      if (updateError) throw updateError
      // Ghi nhật ký best-effort: tên cũ khi đổi tên, số quy tắc mới.
      await logRuleChange({
        familyId: editingTemplate.family_id,
        childId: null,
        action: 'template_updated',
        target: editingTemplate.id,
        details: {
          template_name: name,
          rule_count: editingTemplateItems.length,
          ...(name !== editingTemplate.name ? { previous_name: editingTemplate.name } : {}),
        },
      })
      setEditingTemplate(null)
      setEditingTemplateItems([])
      setActionMessage(`Đã cập nhật mẫu “${name}”.`)
      await load()
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setSavingTemplate(false)
    }
  }

  const handleDeleteTemplate = async (template: RuleTemplate) => {
    if (!supabase) return
    setDeletingTemplateId(template.id)
    setActionError(null)
    try {
      const { error: deleteError } = await supabase.from('rule_templates').delete().eq('id', template.id)
      if (deleteError) throw deleteError
      // Ghi nhật ký best-effort kèm ảnh chụp tên/số quy tắc của mẫu vừa
      // xóa (hàng đã mất nên không đọc lại được).
      await logRuleChange({
        familyId: template.family_id,
        childId: null,
        action: 'template_deleted',
        target: template.id,
        details: { template_name: template.name, rule_count: template.rules.length },
      })
      if (editingTemplate?.id === template.id) cancelEditTemplate()
      setConfirmDeleteTemplateId(null)
      setActionMessage(`Đã xoá mẫu “${template.name}”.`)
      await load()
    } catch (err) {
      setActionError(toVietnameseError(err))
    } finally {
      setDeletingTemplateId(null)
    }
  }

  const handleSendOverride = async () => {
    if (!supabase || !family || !overrideDeviceId) return
    const device = devices.find((d) => d.id === overrideDeviceId)
    if (!device) return
    // Sprint 5: ghi đè gắn với con đích đã chọn trên máy này. Máy chưa
    // gán con nào thì không gửi (lệnh không có con đích sẽ bị hoãn mãi
    // phía Service vì không có con mặc định để áp).
    if (!overrideChildId) {
      setActionError(
        `Máy "${device.hostname}" chưa gán cho hồ sơ con nào nên ghi đè không gắn được với con nào. Hãy ghép nối máy cho một con, hoặc gắn tài khoản Windows của con với máy này (xem trang Thiết bị).`,
      )
      return
    }
    const targetChildName = childNameById.get(overrideChildId) ?? 'con'
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
        child_id: overrideChildId,
        type: 'temporary_override',
        payload: { action: overrideAction, minutes: overrideMinutes, expires_at: expiresAt.toISOString() },
        status: 'pending',
      })
      if (insertError) throw insertError
      setActionMessage(
        `Đã gửi "${overrideActionLabel(overrideAction)}" cho ${targetChildName} trên máy "${device.hostname}". Agent sẽ nhận lệnh trong vòng ~15 giây khi máy online; ghi đè tự hết hạn lúc ${formatTimeVi(expiresAt.toISOString())}. Nếu ${targetChildName} chưa đăng nhập trên máy này, lệnh sẽ áp dụng khi con đăng nhập.`,
      )
      await load()
    } catch (err) {
      setActionError(describeCommandInsertError(err) ?? toVietnameseError(err))
    } finally {
      setSendingOverride(false)
    }
  }

  const handleCancelOverride = async () => {
    if (!supabase || !family || !overrideDeviceId) return
    const device = devices.find((d) => d.id === overrideDeviceId)
    if (!device) return
    // Hủy đúng ghi đè của con đích đã chọn (cancel mang child_id để
    // Service chỉ hủy ghi đè của con đó, không chạm ghi đè của con khác
    // trên cùng máy chung).
    if (!overrideChildId) {
      setActionError(`Máy "${device.hostname}" chưa gán cho hồ sơ con nào nên không có ghi đè nào để hủy.`)
      return
    }
    const targetChildName = childNameById.get(overrideChildId) ?? 'con'
    setCancellingOverride(true)
    setActionError(null)
    setActionMessage(null)
    try {
      const { error: insertError } = await supabase.from('commands').insert({
        family_id: device.family_id,
        device_id: device.id,
        child_id: overrideChildId,
        type: 'temporary_override',
        payload: { action: 'cancel' },
        status: 'pending',
      })
      if (insertError) throw insertError
      setActionMessage(`Đã gửi lệnh hủy ghi đè cho ${targetChildName} trên máy "${device.hostname}". Các quy tắc bình thường sẽ áp dụng lại như cũ. Nếu ${targetChildName} chưa đăng nhập trên máy này, lệnh sẽ áp dụng khi con đăng nhập.`)
      await load()
    } catch (err) {
      setActionError(describeCommandInsertError(err) ?? toVietnameseError(err))
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
    if (!overrideChildId) {
      setActionError(
        `Máy "${device.hostname}" chưa gán cho hồ sơ con nào nên ghi đè website không gắn được với con nào. Hãy ghép nối máy cho một con, hoặc gắn tài khoản Windows của con với máy này (xem trang Thiết bị).`,
      )
      return
    }
    const targetChildName = childNameById.get(overrideChildId) ?? 'con'
    setSendingDomainOverride(true)
    setActionError(null)
    setActionMessage(null)
    try {
      const expiresAt = new Date(Date.now() + domainOverrideMinutes * 60000)
      const { error: insertError } = await supabase.from('commands').insert({
        family_id: device.family_id,
        device_id: device.id,
        child_id: overrideChildId,
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
        `Đã gửi "${overrideActionLabel(domainOverrideAction)}" (${parsed.domains.join(', ')}) cho ${targetChildName} trên máy "${device.hostname}". Agent sẽ nhận lệnh trong vòng ~15 giây khi máy online; ghi đè tự hết hạn lúc ${formatTimeVi(expiresAt.toISOString())}. Nếu ${targetChildName} chưa đăng nhập trên máy này, lệnh sẽ áp dụng khi con đăng nhập.`,
      )
      await load()
    } catch (err) {
      setActionError(describeCommandInsertError(err) ?? toVietnameseError(err))
    } finally {
      setSendingDomainOverride(false)
    }
  }

  // Ghi đè đang hiệu lực của ĐÚNG con đích đã chọn trên máy đã chọn
  // (Sprint 5: ghi đè theo từng con — ghi đè của con khác trên cùng máy
  // chung không tính là "đang hiệu lực" cho con này).
  const activeOverride = overrideDeviceId
    ? getActiveOverride(
        overrideCommands,
        overrideDeviceId,
        Date.now(),
        overrideChildId === '' ? undefined : overrideChildId,
        overrideDevice?.child_id ?? null,
      )
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
  // nhóm "Không rõ con" cuối danh sách — không bỏ rule nào. Nhãn + màu
  // nhóm lấy từ RULE_CATEGORY_THEME (dùng chung cho cả trang).
  const groupRulesByCategory = (childRules: Rule[]) =>
    RULE_CATEGORY_ORDER.map((key) => ({
      key,
      label: RULE_CATEGORY_THEME[key].label,
      rules: childRules.filter((rule) => RULE_CATEGORY_OF[rule.type] === key),
    })).filter((category) => category.rules.length > 0)
  const childSections = [
    ...visibleChildren.map((child) => ({
      childId: child.id,
      childName: child.display_name,
      categories: groupRulesByCategory(rules.filter((rule) => rule.child_id === child.id)),
    })),
    // Mục "không rõ con" chỉ hiện ở trang độc lập — trong hồ sơ của một
    // con thì các quy tắc lạ không thuộc về con đó.
    ...(childIdFilter
      ? []
      : [
          {
            childId: '__unknown__',
            childName: 'Không rõ con',
            categories: groupRulesByCategory(
              rules.filter((rule) => !children.some((child) => child.id === rule.child_id)),
            ),
          },
        ]),
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

  const toggleTemplateRule = (ruleId: string) => {
    setTemplateSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(ruleId)) next.delete(ruleId)
      else next.add(ruleId)
      return next
    })
  }

  // Accordion tạo mới: bấm nhóm đang mở thì đóng; bấm nhóm khác thì mở
  // nhóm đó (nhóm cũ tự đóng) và chuyển loại form sang nhóm đó. Khi đang
  // sửa thì các tiêu đề nhóm bị khóa nên hàm này không chạy.
  const toggleCreateSection = (category: RuleCategoryKey) => {
    if (editingRule) return
    if (createOpen === category) {
      setCreateOpen(null)
      return
    }
    setCreateOpen(category)
    if (category === 'time') {
      if (formType !== 'daily_limit' && formType !== 'time_window' && formType !== 'bedtime') {
        setFormType('daily_limit')
      }
    } else if (category === 'website') {
      setFormType('website')
    } else {
      setFormType('app')
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
        description="Giới hạn giờ dùng máy, khung giờ được dùng, giờ ngủ, quy tắc website và ghi đè tạm thời cho từng con."
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
          {/* Quy tắc hiện hành lên ĐẦU trang: phụ huynh nhìn thấy ngay
              những gì đang áp dụng, trước các form tạo mới và mẫu. Nhóm
              theo con, trong mỗi con nhóm theo danh mục với màu riêng. */}
          <section aria-label="Quy tắc hiện hành" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-slate-900">
                Quy tắc hiện hành
                {visibleRules.length > 0 && (
                  <span className="ml-2 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                    {visibleRules.length} quy tắc
                  </span>
                )}
              </h2>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={expandAllRules} className={secondaryButtonClassName}>
                  Mở rộng tất cả
                </button>
                <button type="button" onClick={collapseAllRules} className={secondaryButtonClassName}>
                  Thu hẹp tất cả
                </button>
                <button type="button" onClick={() => void load()} className={secondaryButtonClassName}>
                  Tải lại
                </button>
              </div>
            </div>
            {childSections.length === 0 ? (
              <EmptyState
                title="Chưa có quy tắc nào"
                description={
                  childIdFilter
                    ? 'Chưa có quy tắc nào cho con này. Tạo quy tắc mới ở mục bên dưới hoặc áp dụng một mẫu sẵn để bắt đầu.'
                    : 'Chưa có quy tắc nào cho gia đình của bạn. Tạo quy tắc mới ở mục bên dưới hoặc áp dụng một mẫu sẵn để bắt đầu.'
                }
              />
            ) : (
              childSections.map((section) => (
                <section
                  key={section.childId}
                  className="space-y-3"
                  aria-label={`Quy tắc của ${section.childName}`}
                >
                  <h3 className="text-base font-semibold text-slate-900">
                    {section.childName}
                    <span className="ml-2 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                      {section.categories.reduce((total, category) => total + category.rules.length, 0)}{' '}
                      quy tắc
                    </span>
                  </h3>
                  {section.categories.map((category) => {
                    const theme = RULE_CATEGORY_THEME[category.key]
                    return (
                      <div key={category.key} className="space-y-2">
                        <h4
                          className={`border-l-4 py-0.5 pl-2 text-sm font-semibold ${theme.borderL} ${theme.headingText}`}
                        >
                          {category.label}
                          <span
                            className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${theme.badge}`}
                          >
                            {category.rules.length}
                          </span>
                        </h4>
                        {category.rules.map((rule) => (
                          <RuleCard
                            key={rule.id}
                            rule={rule}
                            category={category.key}
                            enforcing={enforcingRuleIds.has(rule.id)}
                            enforcingStale={staleEnforcingRuleIds.has(rule.id)}
                            expanded={expandedRuleIds.has(rule.id)}
                            toggling={togglingId === rule.id}
                            confirmingDelete={confirmDeleteId === rule.id}
                            deleting={deletingId === rule.id}
                            onToggleExpand={() => toggleRuleExpanded(rule.id)}
                            onToggleEnabled={() => void handleToggle(rule)}
                            onEdit={() => startEdit(rule)}
                            onRequestDelete={() => setConfirmDeleteId(rule.id)}
                            onConfirmDelete={() => void handleDeleteRule(rule)}
                            onCancelDelete={() => setConfirmDeleteId(null)}
                          />
                        ))}
                      </div>
                    )
                  })}
                </section>
              ))
            )}
          </section>

          <div id="rule-form-card">
          <Card title={editingRule ? 'Sửa quy tắc' : 'Tạo quy tắc mới'}>
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
                      disabled={!!childIdFilter}
                      className={inputClassName}
                    >
                      {visibleChildren.map((child) => (
                        <option key={child.id} value={child.id}>
                          {child.display_name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {namesAvailable ? (
                    <Field
                      label="Tên quy tắc"
                      htmlFor="rule-name"
                      hint="Không bắt buộc — để trống thì dùng tên tự sinh từ loại quy tắc."
                    >
                      <input
                        id="rule-name"
                        type="text"
                        value={ruleName}
                        maxLength={60}
                        onChange={(e) => setRuleName(e.target.value)}
                        placeholder="vd: Giờ học, Giờ ngủ"
                        className={inputClassName}
                      />
                    </Field>
                  ) : (
                    <p className="text-sm text-slate-500 sm:self-center">
                      Đặt tên quy tắc cần migration 9 (file 20261117230000_rule_names_templates.sql
                      trong backend/supabase/migrations). Quy tắc vẫn tạo và chạy bình thường, chỉ
                      chưa đặt tên được.
                    </p>
                  )}
                </div>

                {/* Accordion tạo mới: mặc định tất cả đóng; mở một nhóm
                    thì các nhóm khác đóng. Khi sửa thì nhóm của rule tự
                    mở và các tiêu đề nhóm bị khóa. */}
                <div className="space-y-3">
                  <CreateSection
                    category="time"
                    description="Giới hạn giờ mỗi ngày, khung giờ được dùng, giờ ngủ"
                    open={createOpen === 'time'}
                    disabled={editingRule !== null}
                    onToggle={() => toggleCreateSection('time')}
                  >
                    <Field
                      label="Loại quy tắc giờ giấc"
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

                {formType === 'daily_limit' && <DailyLimitForm draft={dailyDraft} onChange={setDailyDraft} />}
                {formType === 'time_window' && <TimeWindowForm draft={windowDraft} onChange={setWindowDraft} />}
                {formType === 'bedtime' && <BedtimeForm draft={bedtimeDraft} onChange={setBedtimeDraft} />}
                  </CreateSection>
                  <CreateSection
                    category="website"
                    description="Chặn/cho phép website, giới hạn giờ, SafeSearch, chặn từ khóa tìm kiếm, giờ học tập trung"
                    open={createOpen === 'website'}
                    disabled={editingRule !== null}
                    onToggle={() => toggleCreateSection('website')}
                  >
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
                        <option value="block_search_keywords">Chặn từ khóa tìm kiếm</option>
                        <option value="focus">Giờ học tập trung</option>
                      </select>
                    </Field>

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
                        devices={formChildId ? devicesForChild(formChildId) : visibleDevices}
                        childAccounts={childAccounts}
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
                {formType === 'website' && websiteFormKind === 'block_search_keywords' && (
                  <SearchKeywordsForm draft={searchKeywordsDraft} onChange={setSearchKeywordsDraft} />
                )}
                {formType === 'website' && websiteFormKind === 'focus' && (
                  <FocusForm draft={focusDraft} onChange={setFocusDraft} />
                )}
                  </CreateSection>
                  <CreateSection
                    category="app"
                    description="Chặn/cho phép ứng dụng, giới hạn giờ, nghỉ bắt buộc"
                    open={createOpen === 'app'}
                    disabled={editingRule !== null}
                    onToggle={() => toggleCreateSection('app')}
                  >
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
                      devices={formChildId ? devicesForChild(formChildId) : visibleDevices}
                      childAccounts={childAccounts}
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
                  </CreateSection>
                </div>

                {/* Nút gửi chỉ hiện khi có nhóm đang mở (khi sửa thì nhóm
                    của rule luôn mở) — tránh bấm gửi khi chưa thấy form. */}
                {createOpen !== null && (
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
                )}
              </form>
            )}
          </Card>
          </div>

          <Card title="Mẫu quy tắc">
            {children.length === 0 ? (
              <p className="text-sm text-slate-700">
                Cần tạo hồ sơ con trước khi áp dụng mẫu. Hãy tạo hồ sơ con tại trang{' '}
                <Link to="/thiet-bi" className="font-medium text-indigo-600 hover:underline">
                  Thiết bị
                </Link>{' '}
                (nút “Thêm hồ sơ con”).
              </p>
            ) : (
              <div className="space-y-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Áp dụng mẫu cho con" htmlFor="template-child">
                    <select
                      id="template-child"
                      value={presetChildId}
                      onChange={(e) => setPresetChildId(e.target.value)}
                      disabled={!!childIdFilter}
                      className={inputClassName}
                    >
                      {visibleChildren.map((child) => (
                        <option key={child.id} value={child.id}>
                          {child.display_name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <p className="text-sm text-slate-600">
                  Mẫu chỉ THÊM quy tắc mới, không xóa hay sửa quy tắc hiện có — bạn có thể
                  tắt/xóa từng quy tắc trong danh sách hiện hành ở đầu trang. Trước khi áp dụng,
                  hệ thống luôn hiện tóm tắt để bạn xác nhận.
                </p>

                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-slate-900">Mẫu có sẵn</h3>
                  <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
                    {PRESET_OPTIONS.map((preset) => {
                      const confirming = confirmPresetId === preset.id
                      const ruleCount = buildPresetRules(preset.id).length
                      return (
                        <div key={preset.id} className="rounded-lg border border-slate-200 p-4">
                          <h4 className="text-sm font-semibold text-slate-900">{preset.label}</h4>
                          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
                            {preset.summary.map((line) => (
                              <li key={line}>{line}</li>
                            ))}
                          </ul>
                          {confirming && (
                            <p className="mt-3 rounded-lg bg-slate-50 p-2 text-sm text-slate-700">
                              Sẽ thêm {ruleCount} quy tắc cho{' '}
                              {childNameById.get(presetChildId) ?? 'con'} (chỉ thêm mới, không xóa
                              quy tắc cũ).
                            </p>
                          )}
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

                    <div className="rounded-lg border border-slate-200 p-4">
                      <h4 className="text-sm font-semibold text-slate-900">{EDGE_ONLY_TEMPLATE_NAME}</h4>
                      <p className="mt-2 text-sm text-slate-600">
                        Chặn {KNOWN_BROWSERS.length} trình duyệt đã biết (
                        {KNOWN_BROWSERS.map((browser) => browser.name).join(', ')}) để con chỉ duyệt
                        web qua Edge — nơi đã cài extension SafePC.
                      </p>
                      <p className="mt-2 text-xs text-slate-500">
                        Chỉ chặn được trình duyệt có tên trong danh sách; trình duyệt lạ hoặc đã
                        đổi tên file không chặn được bằng cách này.
                      </p>
                      {confirmEdgeTemplate && (
                        <p className="mt-3 rounded-lg bg-slate-50 p-2 text-sm text-slate-700">
                          Sẽ thêm 1 quy tắc chặn ứng dụng cho{' '}
                          {childNameById.get(presetChildId) ?? 'con'} (chỉ thêm mới, không xóa quy
                          tắc cũ).
                        </p>
                      )}
                      <div className="mt-3 flex flex-wrap gap-2">
                        {confirmEdgeTemplate ? (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                void handleApplyTemplateItems(
                                  buildEdgeOnlyTemplateItems(),
                                  EDGE_ONLY_TEMPLATE_NAME,
                                  { action: 'preset_applied', target: 'edge_only' },
                                )
                              }
                              disabled={applyingTemplate}
                              className={primaryButtonClassName}
                            >
                              {applyingTemplate ? 'Đang áp dụng…' : 'Xác nhận áp dụng'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmEdgeTemplate(false)}
                              disabled={applyingTemplate}
                              className={secondaryButtonClassName}
                            >
                              Huỷ
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmEdgeTemplate(true)}
                            className={secondaryButtonClassName}
                          >
                            Áp dụng
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="rounded-lg border border-slate-200 p-4">
                      <h4 className="text-sm font-semibold text-slate-900">{SEARCH_KEYWORDS_TEMPLATE_NAME}</h4>
                      <p className="mt-2 text-sm text-slate-600">
                        Tạo quy tắc chặn lượt tìm kiếm chứa từ khóa bị cấm trên Google, Bing,
                        DuckDuckGo, Yahoo và Cốc Cốc. Mẫu này bật sẵn nhóm “Nội dung người lớn
                        (16+/18+)” (15 từ khóa mẫu song ngữ Anh/Việt). Sau khi áp dụng, bạn tích
                        thêm các nhóm khác (Cờ bạc / cá cược, Bạo lực, Game, Phim, Mạng xã hội)
                        hoặc thêm từ khóa riêng trong quy tắc ở danh sách hiện hành.
                      </p>
                      <p className="mt-2 text-xs text-slate-500">
                        Cụm từ đã tìm được ghi lại để xem trong Báo cáo tuần (giữ 90 ngày) — xem
                        Chính sách riêng tư.
                      </p>
                      {confirmSearchKeywordsTemplate && (
                        <p className="mt-3 rounded-lg bg-slate-50 p-2 text-sm text-slate-700">
                          Sẽ thêm 1 quy tắc chặn từ khóa tìm kiếm cho{' '}
                          {childNameById.get(presetChildId) ?? 'con'} với nhóm “Nội dung người lớn
                          (16+/18+)” đang bật (15 từ khóa mẫu), chưa có từ khóa riêng (chỉ thêm
                          mới, không xóa quy tắc cũ).
                        </p>
                      )}
                      <div className="mt-3 flex flex-wrap gap-2">
                        {confirmSearchKeywordsTemplate ? (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                void handleApplyTemplateItems(
                                  buildSearchKeywordsTemplateItems(),
                                  SEARCH_KEYWORDS_TEMPLATE_NAME,
                                  { action: 'preset_applied', target: 'search_keywords' },
                                )
                              }
                              disabled={applyingTemplate}
                              className={primaryButtonClassName}
                            >
                              {applyingTemplate ? 'Đang áp dụng…' : 'Xác nhận áp dụng'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmSearchKeywordsTemplate(false)}
                              disabled={applyingTemplate}
                              className={secondaryButtonClassName}
                            >
                              Huỷ
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmSearchKeywordsTemplate(true)}
                            className={secondaryButtonClassName}
                          >
                            Áp dụng
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-3 border-t border-slate-100 pt-4">
                  <h3 className="text-sm font-semibold text-slate-900">Mẫu của tôi</h3>
                  {templatesState === 'unavailable' ? (
                    <p className="text-sm text-slate-600">
                      Mẫu của riêng bạn cần migration 9 (file 20261117230000_rule_names_templates.sql
                      trong backend/supabase/migrations). Sau khi áp migration, bạn có thể lưu các
                      quy tắc hiện có thành mẫu, sửa mẫu và áp dụng nhanh cho bất kỳ con nào.
                    </p>
                  ) : (
                    <>
                      {templates.length === 0 ? (
                        <p className="text-sm text-slate-600">
                          Chưa có mẫu nào. Lưu các quy tắc hiện có thành mẫu để áp dụng nhanh cho
                          con khác hoặc lúc khác.
                        </p>
                      ) : (
                        <div className="grid gap-3 sm:grid-cols-2 sm:gap-4">
                          {templates.map((template) => {
                            const isEditing = editingTemplate?.id === template.id
                            const confirming = confirmTemplateId === template.id
                            const confirmingDelete = confirmDeleteTemplateId === template.id
                            return (
                              <div
                                key={template.id}
                                className="rounded-lg border border-slate-200 p-4"
                              >
                                {isEditing ? (
                                  <div className="space-y-3">
                                    <Field
                                      label="Tên mẫu"
                                      htmlFor={`template-edit-name-${template.id}`}
                                    >
                                      <input
                                        id={`template-edit-name-${template.id}`}
                                        type="text"
                                        value={editingTemplateName}
                                        maxLength={60}
                                        onChange={(e) => setEditingTemplateName(e.target.value)}
                                        className={inputClassName}
                                      />
                                    </Field>
                                    <Field
                                      label="Ghi chú"
                                      htmlFor={`template-edit-desc-${template.id}`}
                                    >
                                      <input
                                        id={`template-edit-desc-${template.id}`}
                                        type="text"
                                        value={editingTemplateDescription}
                                        maxLength={120}
                                        onChange={(e) =>
                                          setEditingTemplateDescription(e.target.value)
                                        }
                                        className={inputClassName}
                                      />
                                    </Field>
                                    <div>
                                      <span className="mb-1 block text-sm font-medium text-slate-700">
                                        Quy tắc trong mẫu ({editingTemplateItems.length})
                                      </span>
                                      {editingTemplateItems.length === 0 ? (
                                        <p className="text-sm text-slate-500">
                                          Mẫu đang trống — hãy thêm ít nhất một quy tắc.
                                        </p>
                                      ) : (
                                        <ul className="space-y-1">
                                          {editingTemplateItems.map((item, index) => (
                                            <li
                                              key={`${item.type}-${index}`}
                                              className="flex items-center gap-2 rounded-lg bg-slate-50 px-2 py-1.5"
                                            >
                                              <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
                                                {ruleTypeLabel(item.type)}
                                                {item.name ? ` — ${item.name}` : ''}
                                              </span>
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  setEditingTemplateItems((prev) =>
                                                    prev.filter((_, i) => i !== index),
                                                  )
                                                }
                                                aria-label={`Bỏ quy tắc ${ruleTypeLabel(item.type)} khỏi mẫu`}
                                                className="inline-flex min-h-[44px] shrink-0 items-center rounded-lg px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
                                              >
                                                Bỏ
                                              </button>
                                            </li>
                                          ))}
                                        </ul>
                                      )}
                                    </div>
                                    <div className="flex flex-wrap items-end gap-2">
                                      <div className="min-w-0 flex-1">
                                        <Field
                                          label="Thêm quy tắc hiện có"
                                          htmlFor={`template-edit-add-${template.id}`}
                                        >
                                          <select
                                            id={`template-edit-add-${template.id}`}
                                            value={editingTemplateAddRuleId}
                                            onChange={(e) =>
                                              setEditingTemplateAddRuleId(e.target.value)
                                            }
                                            className={inputClassName}
                                          >
                                            <option value="">Chọn quy tắc…</option>
                                            {visibleRules
                                              .filter(
                                                (rule) =>
                                                  !editingTemplateItems.some(
                                                    (item) =>
                                                      item.type === rule.type &&
                                                      (item.name ?? null) ===
                                                        (rule.name ?? null) &&
                                                      JSON.stringify(item.config) ===
                                                        JSON.stringify(rule.config),
                                                  ),
                                              )
                                              .map((rule) => (
                                              <option key={rule.id} value={rule.id}>
                                                {ruleDisplayName(rule)}
                                                {!childIdFilter &&
                                                  ` — ${childNameById.get(rule.child_id) ?? ''}`}
                                              </option>
                                            ))}
                                          </select>
                                        </Field>
                                      </div>
                                      <button
                                        type="button"
                                        disabled={!editingTemplateAddRuleId}
                                        onClick={() => {
                                          const rule = rules.find(
                                            (r) => r.id === editingTemplateAddRuleId,
                                          )
                                          if (rule) {
                                            setEditingTemplateItems((prev) => [
                                              ...prev,
                                              ruleToTemplateItem(rule),
                                            ])
                                            setEditingTemplateAddRuleId('')
                                          }
                                        }}
                                        className={secondaryButtonClassName}
                                      >
                                        Thêm
                                      </button>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                      <button
                                        type="button"
                                        onClick={() => void handleUpdateTemplate()}
                                        disabled={savingTemplate}
                                        className={primaryButtonClassName}
                                      >
                                        {savingTemplate ? 'Đang lưu…' : 'Lưu mẫu'}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={cancelEditTemplate}
                                        disabled={savingTemplate}
                                        className={secondaryButtonClassName}
                                      >
                                        Huỷ
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <>
                                    <h4 className="text-sm font-semibold text-slate-900">
                                      {template.name}
                                    </h4>
                                    {template.description && (
                                      <p className="mt-1 text-sm text-slate-600">
                                        {template.description}
                                      </p>
                                    )}
                                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
                                      {template.rules.length === 0 ? (
                                        <li>Mẫu trống (chưa có quy tắc nào).</li>
                                      ) : (
                                        template.rules.map((item, index) => (
                                          <li key={`${item.type}-${index}`}>
                                            {ruleTypeLabel(item.type)}
                                            {item.name ? ` — ${item.name}` : ''}
                                          </li>
                                        ))
                                      )}
                                    </ul>
                                    {confirming && (
                                      <p className="mt-3 rounded-lg bg-slate-50 p-2 text-sm text-slate-700">
                                        Sẽ thêm {template.rules.length} quy tắc cho{' '}
                                        {childNameById.get(presetChildId) ?? 'con'} (chỉ thêm mới,
                                        không xóa quy tắc cũ).
                                      </p>
                                    )}
                                    <div className="mt-3 flex flex-wrap gap-2">
                                      {confirming ? (
                                        <>
                                          <button
                                            type="button"
                                            onClick={() =>
                                              void handleApplyTemplateItems(
                                                template.rules,
                                                template.name,
                                                { action: 'template_applied', target: template.id },
                                              )
                                            }
                                            disabled={applyingTemplate}
                                            className={primaryButtonClassName}
                                          >
                                            {applyingTemplate ? 'Đang áp dụng…' : 'Xác nhận áp dụng'}
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => setConfirmTemplateId(null)}
                                            disabled={applyingTemplate}
                                            className={secondaryButtonClassName}
                                          >
                                            Huỷ
                                          </button>
                                        </>
                                      ) : (
                                        <>
                                          <button
                                            type="button"
                                            onClick={() => setConfirmTemplateId(template.id)}
                                            disabled={template.rules.length === 0}
                                            className={secondaryButtonClassName}
                                          >
                                            Áp dụng
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => startEditTemplate(template)}
                                            className={secondaryButtonClassName}
                                          >
                                            Sửa
                                          </button>
                                          {confirmingDelete ? (
                                            <>
                                              <button
                                                type="button"
                                                onClick={() => void handleDeleteTemplate(template)}
                                                disabled={deletingTemplateId === template.id}
                                                className={dangerButtonClassName}
                                              >
                                                {deletingTemplateId === template.id
                                                  ? 'Đang xoá…'
                                                  : 'Xác nhận xoá'}
                                              </button>
                                              <button
                                                type="button"
                                                onClick={() => setConfirmDeleteTemplateId(null)}
                                                className={secondaryButtonClassName}
                                              >
                                                Huỷ
                                              </button>
                                            </>
                                          ) : (
                                            <button
                                              type="button"
                                              onClick={() => setConfirmDeleteTemplateId(template.id)}
                                              className={dangerOutlineButtonClassName}
                                            >
                                              Xoá
                                            </button>
                                          )}
                                        </>
                                      )}
                                    </div>
                                  </>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}

                      {showTemplateForm ? (
                        <div className="space-y-4 rounded-lg border border-slate-200 p-4">
                          <Field
                            label="Tên mẫu"
                            htmlFor="template-name"
                            hint="vd: Giờ học, Giờ ngủ, Ngày học, Ngày nghỉ."
                          >
                            <input
                              id="template-name"
                              type="text"
                              value={templateName}
                              maxLength={60}
                              onChange={(e) => setTemplateName(e.target.value)}
                              placeholder="vd: Giờ học"
                              className={inputClassName}
                            />
                          </Field>
                          <Field label="Ghi chú (không bắt buộc)" htmlFor="template-description">
                            <input
                              id="template-description"
                              type="text"
                              value={templateDescription}
                              maxLength={120}
                              onChange={(e) => setTemplateDescription(e.target.value)}
                              placeholder="vd: Dùng cho các ngày đi học"
                              className={inputClassName}
                            />
                          </Field>
                          <fieldset>
                            <legend className="mb-1 text-sm font-medium text-slate-700">
                              Quy tắc đưa vào mẫu
                            </legend>
                            {visibleRules.length === 0 ? (
                              <p className="text-sm text-slate-600">
                                Chưa có quy tắc nào để lưu thành mẫu. Hãy tạo quy tắc ở mục bên
                                trên trước.
                              </p>
                            ) : (
                              <ul className="space-y-1">
                                {visibleRules.map((rule) => (
                                  <li key={rule.id}>
                                    <label className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-slate-50">
                                      <input
                                        type="checkbox"
                                        className={checkboxClassName}
                                        checked={templateSelectedIds.has(rule.id)}
                                        onChange={() => toggleTemplateRule(rule.id)}
                                      />
                                      <span className="min-w-0">
                                        <span className="block truncate text-sm font-medium text-slate-900">
                                          {ruleDisplayName(rule)}
                                          {!childIdFilter &&
                                            ` — ${childNameById.get(rule.child_id) ?? ''}`}
                                        </span>
                                        <span className="block truncate text-xs text-slate-500">
                                          {describeRuleConfig(rule)[0] ?? ''}
                                        </span>
                                      </span>
                                    </label>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </fieldset>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => void handleSaveTemplate()}
                              disabled={savingTemplate}
                              className={primaryButtonClassName}
                            >
                              {savingTemplate ? 'Đang lưu…' : 'Lưu mẫu'}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setShowTemplateForm(false)
                                setTemplateName('')
                                setTemplateDescription('')
                                setTemplateSelectedIds(new Set())
                              }}
                              disabled={savingTemplate}
                              className={secondaryButtonClassName}
                            >
                              Huỷ
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setShowTemplateForm(true)}
                          className={secondaryButtonClassName}
                        >
                          Tạo mẫu từ quy tắc hiện có
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </Card>

          <Card title="Ghi đè tạm thời (tự hết hạn)">
            {visibleDevices.length === 0 ? (
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
                      {visibleDevices.map((device) => (
                        <option key={device.id} value={device.id}>
                          {deviceOptionLabel(device, childAccounts, childNameById)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Áp dụng cho con" htmlFor="override-child">
                    <select
                      id="override-child"
                      value={overrideChildId}
                      onChange={(e) => setOverrideChildId(e.target.value)}
                      disabled={!!childIdFilter || overrideTargetChildIds.length <= 1}
                      className={inputClassName}
                    >
                      {overrideTargetChildIds.map((id) => (
                        <option key={id} value={id}>
                          {childNameById.get(id) ?? 'Không rõ con'}
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
                  Ghi đè mới nhất sẽ thay thế ghi đè trước đó trên cùng một máy và cùng một con.
                </p>

                {activeOverride && (
                  <AlertBox tone="warning">
                    <p>
                      <span className="font-medium">
                        Đang hiệu lực cho {childNameById.get(overrideChildId) ?? 'con'} trên máy này:{' '}
                      </span>
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
                      className={`mt-2 ${warningButtonClassName}`}
                    >
                      {cancellingOverride ? 'Đang gửi…' : 'Huỷ ghi đè này'}
                    </button>
                  </AlertBox>
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
            {visibleDevices.length === 0 ? (
              <p className="text-sm text-slate-700">
                Chưa có thiết bị nào được ghép nối. Ghi đè website tạm thời được gửi tới từng máy, nên cần ghép
                nối máy của con trước (xem trang Thiết bị).
              </p>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Máy" htmlFor="domain-override-device">
                    <select
                      id="domain-override-device"
                      value={overrideDeviceId}
                      onChange={(e) => setOverrideDeviceId(e.target.value)}
                      className={inputClassName}
                    >
                      {visibleDevices.map((device) => (
                        <option key={device.id} value={device.id}>
                          {deviceOptionLabel(device, childAccounts, childNameById)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Áp dụng cho con" htmlFor="domain-override-child">
                    <select
                      id="domain-override-child"
                      value={overrideChildId}
                      onChange={(e) => setOverrideChildId(e.target.value)}
                      disabled={!!childIdFilter || overrideTargetChildIds.length <= 1}
                      className={inputClassName}
                    >
                      {overrideTargetChildIds.map((id) => (
                        <option key={id} value={id}>
                          {childNameById.get(id) ?? 'Không rõ con'}
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
                  Ghi đè mới nhất sẽ thay thế ghi đè trước đó trên cùng một máy và cùng một con (kể cả ghi đè giờ giấc).
                </p>

                {activeDomainOverride && (
                  <AlertBox tone="warning">
                    <p>
                      <span className="font-medium">
                        Đang hiệu lực cho {childNameById.get(overrideChildId) ?? 'con'} trên máy này:{' '}
                      </span>
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
                      className={`mt-2 ${warningButtonClassName}`}
                    >
                      {cancellingOverride ? 'Đang gửi…' : 'Huỷ ghi đè này'}
                    </button>
                  </AlertBox>
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

        </div>
      )}
    </>
  )
}
