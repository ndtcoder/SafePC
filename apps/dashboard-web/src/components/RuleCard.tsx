import { describeRuleConfig, formatDateTimeVi, ruleTypeLabel } from '../lib/format'
import {
  RULE_CATEGORY_THEME,
  hasCustomRuleName,
  ruleDisplayName,
  type RuleCategoryKey,
} from '../lib/ruleTemplates'
import type { Rule } from '../lib/types'
import {
  dangerButtonClassName,
  dangerOutlineButtonClassName,
  secondaryButtonClassName,
} from './ui'

/**
 * Một thẻ quy tắc trong danh sách "Quy tắc hiện hành": viền trái màu
 * theo nhóm, tên rule lớn + mô tả 1 dòng khi thu gọn, badge "Đang thi
 * hành" khi Agent báo rule đang thi hành, công tắc bật/tắt, mở rộng để
 * xem chi tiết và Sửa/Xoá. Màu không phải kênh duy nhất: nhóm luôn có
 * nhãn chữ ở tiêu đề nhóm, loại rule luôn có chip chữ khi rule có tên
 * riêng.
 */
export function RuleCard({
  rule,
  category,
  enforcing,
  expanded,
  toggling,
  confirmingDelete,
  deleting,
  onToggleExpand,
  onToggleEnabled,
  onEdit,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  rule: Rule
  category: RuleCategoryKey
  enforcing: boolean
  expanded: boolean
  toggling: boolean
  confirmingDelete: boolean
  deleting: boolean
  onToggleExpand: () => void
  onToggleEnabled: () => void
  onEdit: () => void
  onRequestDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
}) {
  const theme = RULE_CATEGORY_THEME[category]
  const displayName = ruleDisplayName(rule)
  const customName = hasCustomRuleName(rule)
  const summary = describeRuleConfig(rule)[0] ?? ''
  return (
    <div
      className={`rounded-xl border border-l-4 bg-white shadow-sm ${theme.borderL} ${
        enforcing ? 'ring-2 ring-indigo-200' : ''
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Thu hẹp' : 'Mở rộng'} quy tắc ${displayName}`}
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
              {displayName}
            </span>
            <span className="block truncate text-xs text-slate-500">{summary}</span>
          </span>
        </button>
        {customName && (
          <span
            className={`hidden shrink-0 rounded-full px-2.5 py-1 text-xs font-medium sm:inline-block ${theme.badge}`}
          >
            {ruleTypeLabel(rule.type)}
          </span>
        )}
        {enforcing && (
          <span className="shrink-0 rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-medium text-indigo-800">
            Đang thi hành
          </span>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={rule.enabled}
          aria-label={`${rule.enabled ? 'Tắt' : 'Bật'} quy tắc ${displayName}`}
          onClick={onToggleEnabled}
          disabled={toggling}
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
            {describeRuleConfig(rule).map((line, index) => (
              <li key={`${line}-${index}`}>{line}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-500">Tạo lúc {formatDateTimeVi(rule.created_at)}</p>
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer py-3 text-indigo-600 hover:underline">
              Xem cấu hình JSON gốc
            </summary>
            <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-700">
              {JSON.stringify(rule.config, null, 2)}
            </pre>
          </details>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={onEdit} className={secondaryButtonClassName}>
              Sửa
            </button>
            {confirmingDelete ? (
              <>
                <button
                  type="button"
                  onClick={onConfirmDelete}
                  disabled={deleting}
                  className={dangerButtonClassName}
                >
                  {deleting ? 'Đang xoá…' : 'Xác nhận xoá'}
                </button>
                <button type="button" onClick={onCancelDelete} className={secondaryButtonClassName}>
                  Huỷ
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={onRequestDelete}
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
}
