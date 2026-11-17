// Mẫu quy tắc + nhóm/màu trình bày của trang Quy tắc (không phụ thuộc
// React/Supabase): hình dạng JSON của rule_templates.rules, đọc phòng thủ,
// tên hiển thị của rule, và bảng màu nhất quán theo nhóm.
//
// Nhóm quy tắc (dùng chung cho danh sách hiện hành, accordion tạo mới và
// mẫu): Giờ giấc / Website / Ứng dụng. Màu chỉ là kênh phụ — mỗi nhóm
// luôn có nhãn chữ đi kèm, không dùng màu làm kênh thông tin duy nhất.

import { ruleTypeLabel } from './format'
import type { Rule, RuleType } from './types'

// ---------------------------------------------------------------------------
// Nhóm quy tắc + bảng màu
// ---------------------------------------------------------------------------

export type RuleCategoryKey = 'time' | 'website' | 'app'

export const RULE_CATEGORY_ORDER: RuleCategoryKey[] = ['time', 'website', 'app']

export const RULE_CATEGORY_OF: Record<RuleType, RuleCategoryKey> = {
  daily_limit: 'time',
  time_window: 'time',
  bedtime: 'time',
  website: 'website',
  app: 'app',
}

export interface RuleCategoryTheme {
  /** Nhãn nhóm hiển thị (luôn đi kèm màu). */
  label: string
  /** Chữ tiêu đề nhóm trên nền sáng. */
  headingText: string
  /** Viền trái thẻ rule / tiêu đề nhóm. */
  borderL: string
  /** Badge nhỏ (số lượng, loại rule). */
  badge: string
  /** Nền + viền của tiêu đề accordion khi mở. */
  accordionOpen: string
  /** Nền + viền của tiêu đề accordion khi đóng. */
  accordionClosed: string
}

/**
 * Bảng màu theo nhóm — class Tailwind viết tường minh từng chuỗi để
 * Tailwind quét được (không ghép chuỗi động). Tương phản: chữ *-800
 * trên nền *-100, viền *-600 trên nền trắng.
 */
export const RULE_CATEGORY_THEME: Record<RuleCategoryKey, RuleCategoryTheme> = {
  time: {
    label: 'Giờ giấc',
    headingText: 'text-indigo-800',
    borderL: 'border-l-indigo-600',
    badge: 'bg-indigo-100 text-indigo-800',
    accordionOpen: 'border-indigo-300 bg-indigo-50',
    accordionClosed: 'border-slate-200 bg-white hover:bg-indigo-50',
  },
  website: {
    label: 'Website',
    headingText: 'text-emerald-800',
    borderL: 'border-l-emerald-600',
    badge: 'bg-emerald-100 text-emerald-800',
    accordionOpen: 'border-emerald-300 bg-emerald-50',
    accordionClosed: 'border-slate-200 bg-white hover:bg-emerald-50',
  },
  app: {
    label: 'Ứng dụng',
    headingText: 'text-amber-800',
    borderL: 'border-l-amber-600',
    badge: 'bg-amber-100 text-amber-800',
    accordionOpen: 'border-amber-300 bg-amber-50',
    accordionClosed: 'border-slate-200 bg-white hover:bg-amber-50',
  },
}

/**
 * Tên hiển thị của quy tắc: tên do phụ huynh đặt (đã trim, khác rỗng) thì
 * dùng tên đó; ngược lại dùng tên tự sinh từ loại quy tắc như trước.
 */
export function ruleDisplayName(rule: Pick<Rule, 'name' | 'type'>): string {
  const custom = rule.name?.trim()
  return custom ? custom : ruleTypeLabel(rule.type)
}

/** true khi rule có tên do phụ huynh đặt (để hiện thêm chip loại rule). */
export function hasCustomRuleName(rule: Pick<Rule, 'name'>): boolean {
  return (rule.name?.trim() ?? '') !== ''
}

// ---------------------------------------------------------------------------
// Mẫu quy tắc của phụ huynh (bảng rule_templates, migration 9)
// ---------------------------------------------------------------------------

/**
 * Một quy tắc trong mẫu (một phần tử của rule_templates.rules).
 * Không mang child_id: con đích được chọn lúc áp dụng. Không mang
 * device_scope: quy tắc SafePC theo con, không theo máy.
 */
export interface RuleTemplateItem {
  type: RuleType
  /** Tên hiển thị của quy tắc sẽ tạo; null/vắng = tên tự sinh. */
  name?: string | null
  config: Record<string, unknown>
}

export interface RuleTemplate {
  id: string
  family_id: string
  name: string
  description: string | null
  rules: RuleTemplateItem[]
  created_at: string
  updated_at: string
}

const RULE_TYPES: RuleType[] = ['daily_limit', 'bedtime', 'time_window', 'app', 'website']

function isRuleType(value: unknown): value is RuleType {
  return typeof value === 'string' && (RULE_TYPES as string[]).includes(value)
}

/**
 * Đọc phòng thủ mảng rule_templates.rules: chỉ giữ phần tử có type hợp
 * lệ và config là object; phần tử lạ bị bỏ qua, không throw. Trả về
 * mảng rỗng khi giá trị không phải mảng.
 */
export function parseTemplateRules(value: unknown): RuleTemplateItem[] {
  if (!Array.isArray(value)) return []
  const items: RuleTemplateItem[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (!isRuleType(record['type'])) continue
    if (typeof record['config'] !== 'object' || record['config'] === null) continue
    const name = record['name']
    items.push({
      type: record['type'],
      name: typeof name === 'string' ? name : null,
      config: record['config'] as Record<string, unknown>,
    })
  }
  return items
}

/**
 * Đọc phòng thủ một dòng rule_templates từ Supabase. Trả null khi dòng
 * thiếu id/family_id/name (không hiển thị mẫu hỏng).
 */
export function parseRuleTemplateRow(row: unknown): RuleTemplate | null {
  if (typeof row !== 'object' || row === null) return null
  const record = row as Record<string, unknown>
  if (
    typeof record['id'] !== 'string' ||
    typeof record['family_id'] !== 'string' ||
    typeof record['name'] !== 'string'
  ) {
    return null
  }
  const description = record['description']
  const createdAt = record['created_at']
  const updatedAt = record['updated_at']
  return {
    id: record['id'],
    family_id: record['family_id'],
    name: record['name'],
    description: typeof description === 'string' ? description : null,
    rules: parseTemplateRules(record['rules']),
    created_at: typeof createdAt === 'string' ? createdAt : '',
    updated_at: typeof updatedAt === 'string' ? updatedAt : '',
  }
}

/** Chuyển một rule hiện có thành phần tử mẫu (giữ nguyên type/name/config). */
export function ruleToTemplateItem(rule: Rule): RuleTemplateItem {
  return { type: rule.type, name: rule.name ?? null, config: rule.config }
}

// ---------------------------------------------------------------------------
// Mẫu nhanh "Chỉ cho phép Edge": chặn các trình duyệt đã biết theo tên exe.
// Dùng đúng cơ chế rule chặn ứng dụng hiện có (mode app_block) — Service
// đã kill process theo tên exe nên không cần sửa Agent.
// ---------------------------------------------------------------------------

export interface KnownBrowser {
  exe: string
  name: string
}

export const KNOWN_BROWSERS: KnownBrowser[] = [
  { exe: 'chrome.exe', name: 'Chrome' },
  { exe: 'firefox.exe', name: 'Firefox' },
  { exe: 'brave.exe', name: 'Brave' },
  // Opera GX cũng chạy dưới tên opera.exe nên một mục này chặn cả hai.
  { exe: 'opera.exe', name: 'Opera' },
  { exe: 'vivaldi.exe', name: 'Vivaldi' },
  { exe: 'arc.exe', name: 'Arc' },
  { exe: 'chromium.exe', name: 'Chromium' },
  { exe: 'whale.exe', name: 'Whale' },
  { exe: 'coccoc.exe', name: 'Cốc Cốc' },
  { exe: 'comet.exe', name: 'Comet' },
]

export const EDGE_ONLY_TEMPLATE_NAME = 'Chỉ cho phép Edge'

/** Quy tắc duy nhất của mẫu "Chỉ cho phép Edge": chặn mọi trình duyệt đã biết, Edge (msedge.exe) không nằm trong danh sách nên vẫn mở được. */
export function buildEdgeOnlyTemplateItems(): RuleTemplateItem[] {
  return [
    {
      type: 'app',
      name: EDGE_ONLY_TEMPLATE_NAME,
      config: {
        mode: 'app_block',
        apps: KNOWN_BROWSERS.map((browser) => ({ exe: browser.exe, name: browser.name })),
      },
    },
  ]
}
