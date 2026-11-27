import { useState } from 'react'
import {
  DOMAIN_CATEGORIES,
  KEYWORD_GROUPS,
  MAX_SEARCH_KEYWORD_LENGTH,
  MAX_SEARCH_KEYWORDS,
  WEEKDAY_OPTIONS,
  effectiveSearchKeywords,
  normalizeSearchKeyword,
  parseWebsiteEntriesInput,
  type AllowlistByTimeDraft,
  type AppAllowlistByTimeDraft,
  type AppBlockByTimeDraft,
  type AppListDraft,
  type AppTimeLimitDraft,
  type BedtimeDraft,
  type BlockDomainsByTimeDraft,
  type DailyLimitDraft,
  type DomainCategoryId,
  type DomainTimeLimitDraft,
  type FocusDraft,
  type ForcedBreakDraft,
  type KeywordGroupId,
  type ListKind,
  type SafeSearchDraft,
  type SearchKeywordsDraft,
  type TimeKind,
  type TimeRangeValue,
  type TimeWindowDraft,
  type WebsiteDomainsDraft,
  type WeekdayNumber,
} from '../lib/ruleConfig'
import {
  checkboxClassName,
  chipClassName,
  dangerOutlineButtonClassName,
  inputClassName,
  secondaryButtonClassName,
} from './ui'

// Các form nhập quy tắc theo từng loại. Component chỉ quản lý hiển thị;
// dữ liệu (draft) do trang cha giữ, kiểm tra hợp lệ ở lib/ruleConfig.ts.
// Giờ giấc nhập theo GIỜ ĐỊA PHƯƠNG trên máy của con (Agent thi hành theo
// giờ máy con, xem docs/02-ARCHITECTURE.md mục 4.2).

export function DailyLimitForm({
  draft,
  onChange,
}: {
  draft: DailyLimitDraft
  onChange: (draft: DailyLimitDraft) => void
}) {
  const [fillAll, setFillAll] = useState('120')

  const setDay = (day: WeekdayNumber, text: string) => {
    const next = { ...draft }
    next[day] = text
    onChange(next)
  }

  const applyToAll = () => {
    const next = { ...draft }
    for (const { value } of WEEKDAY_OPTIONS) next[value] = fillAll.trim()
    onChange(next)
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-3">
        <div className="min-w-[11rem] flex-1">
          <label htmlFor="daily-fill-all" className="mb-1 block text-sm font-medium text-slate-700">
            Đặt cùng một số phút cho cả tuần
          </label>
          <input
            id="daily-fill-all"
            type="number"
            inputMode="numeric"
            min={0}
            max={1440}
            step={5}
            value={fillAll}
            onChange={(e) => setFillAll(e.target.value)}
            className={inputClassName}
          />
        </div>
        <button type="button" onClick={applyToAll} className={secondaryButtonClassName}>
          Áp dụng cho tất cả các ngày
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {WEEKDAY_OPTIONS.map(({ value, label }) => (
          <div key={value}>
            <label htmlFor={`daily-minutes-${value}`} className="mb-1 block text-sm font-medium text-slate-700">
              {label} (phút)
            </label>
            <input
              id={`daily-minutes-${value}`}
              type="number"
              inputMode="numeric"
              min={0}
              max={1440}
              step={5}
              value={draft[value]}
              onChange={(e) => setDay(value, e.target.value)}
              placeholder="Không giới hạn"
              className={inputClassName}
            />
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-500">
        Để trống một ngày nghĩa là ngày đó không giới hạn tổng giờ. Nhập 0 nghĩa là ngày đó không được dùng máy
        (máy sẽ khóa ngay khi con đăng nhập).
      </p>
    </div>
  )
}

/**
 * Trình sửa khung giờ theo từng thứ trong tuần, dùng chung cho quy tắc
 * khung giờ được dùng máy (TimeWindowForm) và quy tắc chặn website theo
 * giờ. `emptyDayText` là câu hiển thị khi một ngày chưa có khung giờ nào —
 * ý nghĩa khác nhau theo từng loại quy tắc nên do nơi dùng truyền vào.
 */
export function WeekdayWindowsEditor({
  draft,
  onChange,
  idPrefix,
  emptyDayText,
}: {
  draft: TimeWindowDraft
  onChange: (draft: TimeWindowDraft) => void
  idPrefix: string
  emptyDayText: string
}) {
  const setRanges = (day: WeekdayNumber, ranges: TimeRangeValue[]) => {
    const next = { ...draft }
    next[day] = ranges
    onChange(next)
  }

  const updateRange = (day: WeekdayNumber, index: number, patch: Partial<TimeRangeValue>) => {
    setRanges(
      day,
      draft[day].map((range, i) => (i === index ? { ...range, ...patch } : range)),
    )
  }

  const addRange = (day: WeekdayNumber) => {
    setRanges(day, [...draft[day], { start: '07:00', end: '21:00' }])
  }

  const removeRange = (day: WeekdayNumber, index: number) => {
    setRanges(
      day,
      draft[day].filter((_, i) => i !== index),
    )
  }

  return (
    <div className="space-y-4">
      {WEEKDAY_OPTIONS.map(({ value, label }) => (
        <div key={value} className="rounded-lg border border-slate-200 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-slate-800">{label}</p>
            <button type="button" onClick={() => addRange(value)} className={secondaryButtonClassName}>
              Thêm khung giờ
            </button>
          </div>
          {draft[value].length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">{emptyDayText}</p>
          ) : (
            <div className="mt-2 space-y-2">
              {draft[value].map((range, index) => (
                <div key={index} className="flex flex-wrap items-end gap-2">
                  <div className="min-w-[9rem] flex-1">
                    <label htmlFor={`${idPrefix}-start-${value}-${index}`} className="mb-1 block text-xs text-slate-500">
                      Từ giờ
                    </label>
                    <input
                      id={`${idPrefix}-start-${value}-${index}`}
                      type="time"
                      required
                      value={range.start}
                      onChange={(e) => updateRange(value, index, { start: e.target.value })}
                      className={inputClassName}
                    />
                  </div>
                  <div className="min-w-[9rem] flex-1">
                    <label htmlFor={`${idPrefix}-end-${value}-${index}`} className="mb-1 block text-xs text-slate-500">
                      Đến giờ
                    </label>
                    <input
                      id={`${idPrefix}-end-${value}-${index}`}
                      type="time"
                      required
                      value={range.end}
                      onChange={(e) => updateRange(value, index, { end: e.target.value })}
                      className={inputClassName}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeRange(value, index)}
                    className={dangerOutlineButtonClassName}
                  >
                    Xoá khung giờ
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

export function TimeWindowForm({
  draft,
  onChange,
}: {
  draft: TimeWindowDraft
  onChange: (draft: TimeWindowDraft) => void
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Ngoài các khung giờ dưới đây, máy sẽ bị khóa. <strong>Ngày nào không có khung giờ nào thì con không được
        dùng máy ngày đó.</strong> Giờ tính theo giờ địa phương trên máy của con. Khung giờ không được qua đêm
        (giờ bắt đầu phải sớm hơn giờ kết thúc) — muốn khóa qua đêm, dùng quy tắc giờ ngủ.
      </p>
      <WeekdayWindowsEditor
        draft={draft}
        onChange={onChange}
        idPrefix="window"
        emptyDayText="Không có khung giờ nào — con không được dùng máy ngày này."
      />
    </div>
  )
}

export function BedtimeForm({
  draft,
  onChange,
}: {
  draft: BedtimeDraft
  onChange: (draft: BedtimeDraft) => void
}) {
  const setDay = (day: WeekdayNumber, patch: Partial<BedtimeDraft[WeekdayNumber]>) => {
    const next = { ...draft }
    next[day] = { ...draft[day], ...patch }
    onChange(next)
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Trong khung giờ ngủ, máy sẽ bị khóa. Giờ kết thúc nhỏ hơn giờ bắt đầu nghĩa là khóa qua đêm sang ngày
        hôm sau (ví dụ 21:00–07:00: khóa từ 21:00 hôm nay đến 07:00 hôm sau). Giờ tính theo giờ địa phương
        trên máy của con.
      </p>
      {WEEKDAY_OPTIONS.map(({ value, label }) => {
        const day = draft[value]
        return (
          <div key={value} className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 p-3">
            <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm font-medium text-slate-800">
              <input
                type="checkbox"
                checked={day.enabled}
                onChange={(e) => setDay(value, { enabled: e.target.checked })}
                className={checkboxClassName}
              />
              {label}
            </label>
            <div className="min-w-[9rem] flex-1">
              <label htmlFor={`bedtime-start-${value}`} className="mb-1 block text-xs text-slate-500">
                Bắt đầu khóa
              </label>
              <input
                id={`bedtime-start-${value}`}
                type="time"
                disabled={!day.enabled}
                value={day.start}
                onChange={(e) => setDay(value, { start: e.target.value })}
                className={inputClassName}
              />
            </div>
            <div className="min-w-[9rem] flex-1">
              <label htmlFor={`bedtime-end-${value}`} className="mb-1 block text-xs text-slate-500">
                Kết thúc khóa
              </label>
              <input
                id={`bedtime-end-${value}`}
                type="time"
                disabled={!day.enabled}
                value={day.end}
                onChange={(e) => setDay(value, { end: e.target.value })}
                className={inputClassName}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Form danh sách (chặn/cho phép × luôn luôn/theo giờ/tạm thời). Phụ huynh
// chọn LOẠI DANH SÁCH trước, rồi chọn THỜI GIAN; trang cha ánh xạ lựa
// chọn thành mode của rule (hoặc lệnh ghi đè tạm thời khi chọn "Tạm
// thời"). Mọi form danh sách đều mang gợi ý "đến khi bật/tắt": quy tắc
// có hiệu lực cho đến khi phụ huynh tắt bằng công tắc trong danh sách.
// ---------------------------------------------------------------------------

/** Gợi ý chuẩn cho mọi form danh sách: quy tắc áp dụng đến khi tắt bằng công tắc. */
export function UntilToggledOffHint() {
  return (
    <p className="text-xs text-slate-500">
      Quy tắc có hiệu lực cho đến khi bạn tắt hoặc xóa nó trong danh sách quy tắc bên dưới.
    </p>
  )
}

export function ListKindPicker({
  value,
  onChange,
  disabled = false,
  hint,
}: {
  value: ListKind
  onChange: (value: ListKind) => void
  disabled?: boolean
  hint?: string
}) {
  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-slate-700">Loại danh sách</span>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Loại danh sách">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange('block')}
          aria-pressed={value === 'block'}
          className={`${chipClassName(value === 'block')} disabled:cursor-not-allowed disabled:opacity-50`}
        >
          Danh sách chặn
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange('allow')}
          aria-pressed={value === 'allow'}
          className={`${chipClassName(value === 'allow')} disabled:cursor-not-allowed disabled:opacity-50`}
        >
          Danh sách cho phép
        </button>
      </div>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  )
}

export function TimeKindPicker({
  value,
  onChange,
  disabled = false,
  hint,
}: {
  value: TimeKind
  onChange: (value: TimeKind) => void
  disabled?: boolean
  hint?: string
}) {
  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-slate-700">Thời gian áp dụng</span>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Thời gian áp dụng">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange('always')}
          aria-pressed={value === 'always'}
          className={`${chipClassName(value === 'always')} disabled:cursor-not-allowed disabled:opacity-50`}
        >
          Luôn luôn
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange('by_time')}
          aria-pressed={value === 'by_time'}
          className={`${chipClassName(value === 'by_time')} disabled:cursor-not-allowed disabled:opacity-50`}
        >
          Theo giờ
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange('temporary')}
          aria-pressed={value === 'temporary'}
          className={`${chipClassName(value === 'temporary')} disabled:cursor-not-allowed disabled:opacity-50`}
        >
          Tạm thời — đếm ngược
        </button>
      </div>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Quy tắc website (đợt 2). Các form dùng chung DomainsField; kiểm tra hợp
// lệ ở lib/ruleConfig.ts (parseDomainsInput cho domain thuần,
// parseWebsiteEntriesInput cho form quy tắc có cả đường dẫn — đợt 4).
// ---------------------------------------------------------------------------

/**
 * Ô nhập danh sách domain, dùng chung cho mọi form website và thẻ ghi đè
 * website tạm thời. Định dạng: mỗi dòng một domain (dấu phẩy cũng được
 * chấp nhận). Có thể dán cả đường link — hệ thống chỉ lấy phần tên miền.
 *
 * `allowUrlPatterns` (đợt 4, CHỈ form "Chặn website"): mục có dấu /
 * như bing.com/videos được giữ làm quy tắc đường dẫn (chỉ link bắt đầu
 * bằng phần đó) thay vì bị cắt thành domain, và ô nhập hiển thị tách
 * riêng hai danh sách đã nhận dạng. Các form website khác (theo giờ,
 * allowlist, giới hạn thời gian) KHÔNG bật vì Agent chưa thi hành đường
 * dẫn ở các mode đó — chúng từ chối mục có dấu / lúc lưu. Ghi đè tạm thời
 * và giờ học tập trung cũng KHÔNG bật: chúng chỉ làm việc với toàn bộ
 * domain.
 */
export function DomainsField({
  id,
  label,
  value,
  onChange,
  hint,
  allowUrlPatterns = false,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
  allowUrlPatterns?: boolean
}) {
  const split = allowUrlPatterns ? parseWebsiteEntriesInput(value) : null
  const showSplit =
    split !== null &&
    split.error === null &&
    (split.domains.length > 0 || split.urlPatterns.length > 0)
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      <textarea
        id={id}
        rows={4}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          allowUrlPatterns ? 'youtube.com\nbing.com/videos' : 'youtube.com\nfacebook.com'
        }
        className={inputClassName}
      />
      <p className="mt-1 text-xs text-slate-500">
        {hint ??
          (allowUrlPatterns
            ? 'Mỗi dòng một mục (phân tách bằng dấu phẩy cũng được). Mục có dấu / như bing.com/videos chỉ áp dụng cho các link bắt đầu bằng phần đó, và phần đường dẫn phân biệt chữ hoa/thường — hãy gõ đúng như đường link thật; mục không có dấu / như youtube.com áp dụng cho cả domain (kể cả tên miền con).'
            : 'Mỗi dòng một domain (phân tách bằng dấu phẩy cũng được). Có thể dán cả đường link, ví dụ https://www.youtube.com/ — hệ thống chỉ lấy phần tên miền.')}
      </p>
      {showSplit && (
        <div className="mt-2 space-y-1 text-xs text-slate-600">
          {split.domains.length > 0 && <p>Cả domain: {split.domains.join(', ')}</p>}
          {split.urlPatterns.length > 0 && (
            <p>Đường dẫn (chỉ link bắt đầu bằng phần này): {split.urlPatterns.join(', ')}</p>
          )}
        </div>
      )}
    </div>
  )
}

export function BlockDomainsForm({
  draft,
  onChange,
}: {
  draft: WebsiteDomainsDraft
  onChange: (draft: WebsiteDomainsDraft) => void
}) {
  const toggleCategory = (category: DomainCategoryId, checked: boolean) => {
    const categories = checked
      ? [...draft.categories, category]
      : draft.categories.filter((c) => c !== category)
    onChange({ ...draft, categories })
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Các website dưới đây sẽ bị chặn mọi lúc. Quy tắc áp dụng cả cho tên miền con — chặn youtube.com thì cả
        www.youtube.com cũng bị chặn.
      </p>
      <DomainsField
        id="website-domains"
        label="Domain bị chặn"
        allowUrlPatterns
        value={draft.domainsText}
        onChange={(domainsText) => onChange({ ...draft, domainsText })}
      />
      <fieldset>
        <legend className="mb-1 block text-sm font-medium text-slate-800">
          Hoặc chặn theo danh mục
        </legend>
        <p className="mb-2 text-sm text-slate-600">
          Chọn danh mục để chặn các website phổ biến trong danh mục đó mà không cần gõ từng domain. Có thể kết
          hợp cả danh mục và domain gõ tay trong cùng một quy tắc. Danh mục chỉ chặn các website phổ biến nhất —
          website mới hoặc ít tên tuổi có thể chưa có trong danh sách.
        </p>
        <div className="space-y-1">
          {DOMAIN_CATEGORIES.map((category) => (
            <label
              key={category.value}
              className="flex min-h-[44px] cursor-pointer items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
            >
              <input
                type="checkbox"
                checked={draft.categories.includes(category.value)}
                onChange={(e) => toggleCategory(category.value, e.target.checked)}
                className={`mt-0.5 ${checkboxClassName}`}
              />
              <span>
                <span className="block font-medium">{category.label}</span>
                <span className="block text-slate-600">{category.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <UntilToggledOffHint />
    </div>
  )
}

export function BlockDomainsByTimeForm({
  draft,
  onChange,
}: {
  draft: BlockDomainsByTimeDraft
  onChange: (draft: BlockDomainsByTimeDraft) => void
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Trong các khung giờ dưới đây, các website trong danh sách sẽ bị chặn. Ngoài khung giờ, con vẫn mở được
        các website này. <strong>Ngày nào không có khung giờ nào thì các website không bị chặn ngày đó.</strong>{' '}
        Giờ tính theo giờ địa phương trên máy của con.
      </p>
      <DomainsField
        id="website-domains"
        label="Domain bị chặn theo giờ"
        hint="Mỗi dòng một domain (phân tách bằng dấu phẩy cũng được). Quy tắc đường dẫn (mục có dấu /, ví dụ bing.com/videos) hiện chỉ dùng được trong quy tắc “Chặn website”."
        value={draft.domainsText}
        onChange={(domainsText) => onChange({ ...draft, domainsText })}
      />
      <WeekdayWindowsEditor
        draft={draft.windows}
        onChange={(windows) => onChange({ ...draft, windows })}
        idPrefix="domain-window"
        emptyDayText="Không có khung giờ nào — các domain trên không bị chặn ngày này."
      />
      <UntilToggledOffHint />
    </div>
  )
}

export function AllowlistForm({
  draft,
  onChange,
}: {
  draft: WebsiteDomainsDraft
  onChange: (draft: WebsiteDomainsDraft) => void
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        <strong>Chỉ</strong> các website dưới đây được mở; mọi website khác đều bị chặn. Quy tắc áp dụng cả cho
        tên miền con — cho phép youtube.com thì cả www.youtube.com cũng được mở. Hãy chắc chắn đã liệt kê đủ
        các trang con cần cho việc học.
      </p>
      <DomainsField
        id="website-domains"
        label="Domain được phép"
        hint="Mỗi dòng một domain (phân tách bằng dấu phẩy cũng được). Quy tắc đường dẫn (mục có dấu /, ví dụ bing.com/videos) hiện chỉ dùng được trong quy tắc “Chặn website”."
        value={draft.domainsText}
        onChange={(domainsText) => onChange({ ...draft, domainsText })}
      />
      <UntilToggledOffHint />
    </div>
  )
}

export function AllowlistByTimeForm({
  draft,
  onChange,
}: {
  draft: AllowlistByTimeDraft
  onChange: (draft: AllowlistByTimeDraft) => void
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Trong các khung giờ dưới đây, <strong>chỉ</strong> các website trong danh sách được mở; ngoài khung
        giờ, mọi website đều mở được. <strong>Ngày nào không có khung giờ nào thì ngày đó không giới
        hạn.</strong> Giờ tính theo giờ địa phương trên máy của con. Quy tắc áp dụng cả cho tên miền con.
      </p>
      <DomainsField
        id="website-domains"
        label="Domain được phép theo giờ"
        hint="Mỗi dòng một domain (phân tách bằng dấu phẩy cũng được). Quy tắc đường dẫn (mục có dấu /, ví dụ bing.com/videos) hiện chỉ dùng được trong quy tắc “Chặn website”."
        value={draft.domainsText}
        onChange={(domainsText) => onChange({ ...draft, domainsText })}
      />
      <WeekdayWindowsEditor
        draft={draft.windows}
        onChange={(windows) => onChange({ ...draft, windows })}
        idPrefix="allowlist-window"
        emptyDayText="Không có khung giờ nào — các website không bị giới hạn ngày này."
      />
      <UntilToggledOffHint />
    </div>
  )
}

export function DomainTimeLimitForm({
  draft,
  onChange,
}: {
  draft: DomainTimeLimitDraft
  onChange: (draft: DomainTimeLimitDraft) => void
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Tổng thời gian con được xem các website dưới đây mỗi ngày (cộng chung cho tất cả các domain trong danh
        sách). Hết giờ, các website này sẽ bị chặn tới hết ngày.
      </p>
      <DomainsField
        id="website-domains"
        label="Domain bị giới hạn thời gian"
        hint="Mỗi dòng một domain (phân tách bằng dấu phẩy cũng được). Quy tắc đường dẫn (mục có dấu /, ví dụ bing.com/videos) hiện chỉ dùng được trong quy tắc “Chặn website”."
        value={draft.domainsText}
        onChange={(domainsText) => onChange({ ...draft, domainsText })}
      />
      <div>
        <label htmlFor="website-minutes" className="mb-1 block text-sm font-medium text-slate-700">
          Giới hạn mỗi ngày (phút)
        </label>
        <input
          id="website-minutes"
          type="number"
          inputMode="numeric"
          min={1}
          max={1440}
          step={5}
          value={draft.minutes}
          onChange={(e) => onChange({ ...draft, minutes: e.target.value })}
          className={inputClassName}
        />
      </div>
    </div>
  )
}

export function SafeSearchForm({
  draft,
  onChange,
}: {
  draft: SafeSearchDraft
  onChange: (draft: SafeSearchDraft) => void
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Ép chế độ tìm kiếm an toàn trên trình duyệt của con. Quy tắc này không chặn website nào — nó chỉ lọc
        kết quả tìm kiếm và video không phù hợp.
      </p>
      <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm font-medium text-slate-800">
        <input
          type="checkbox"
          checked={draft.searchProviders}
          onChange={(e) => onChange({ ...draft, searchProviders: e.target.checked })}
          className={checkboxClassName}
        />
        Bật SafeSearch cho công cụ tìm kiếm (Google, Bing…)
      </label>
      <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm font-medium text-slate-800">
        <input
          type="checkbox"
          checked={draft.youtubeRestricted}
          onChange={(e) => onChange({ ...draft, youtubeRestricted: e.target.checked })}
          className={checkboxClassName}
        />
        Bật chế độ hạn chế của YouTube (Restricted Mode)
      </label>
    </div>
  )
}

/**
 * Form chặn từ khóa tìm kiếm (v2 — nhóm chủ đề): khu 1 là 6 NHÓM TỪ KHÓA
 * CÓ SẴN theo chủ đề, tích chọn cả nhóm (KEYWORD_GROUPS ở
 * lib/ruleConfig.ts); khu 2 là editor chip cho TỪ KHÓA RIÊNG của phụ
 * huynh (Enter hoặc nút Thêm để thêm, nút × để xóa từng từ). Dòng tổng
 * kết cuối form đếm danh sách hiệu lực thật (hợp nhất nhóm + từ riêng)
 * bằng `effectiveSearchKeywords` nên luôn khớp thứ sẽ lưu. Từ khóa riêng
 * được chuẩn hoá ngay khi thêm (trim + chữ thường, khớp validate/build
 * ở lib/ruleConfig.ts); lỗi nhập (trùng, quá dài, đầy danh sách) hiện
 * ngay dưới ô nhập thay vì chờ tới lúc lưu.
 */
export function SearchKeywordsForm({
  draft,
  onChange,
}: {
  draft: SearchKeywordsDraft
  onChange: (draft: SearchKeywordsDraft) => void
}) {
  const [input, setInput] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)

  const toggleGroup = (groupId: KeywordGroupId, checked: boolean) => {
    const groups = checked
      ? [...draft.groups, groupId]
      : draft.groups.filter((id) => id !== groupId)
    // Giữ thứ tự chuẩn của KEYWORD_GROUPS để draft/config luôn ổn định.
    onChange({
      ...draft,
      groups: KEYWORD_GROUPS.map((g) => g.id).filter((id) => groups.includes(id)),
    })
  }

  const addKeyword = (raw: string) => {
    const keyword = normalizeSearchKeyword(raw)
    if (keyword === '') return
    if (keyword.length > MAX_SEARCH_KEYWORD_LENGTH) {
      setInputError(
        `Từ khóa “${keyword}” quá dài (tối đa ${MAX_SEARCH_KEYWORD_LENGTH} ký tự). Hãy rút gọn rồi thêm lại.`,
      )
      return
    }
    if (draft.customKeywords.includes(keyword)) {
      setInputError(`Từ khóa “${keyword}” đã có trong danh sách từ khóa riêng.`)
      return
    }
    if (draft.customKeywords.length >= MAX_SEARCH_KEYWORDS) {
      setInputError(
        `Danh sách từ khóa riêng đã đủ ${MAX_SEARCH_KEYWORDS} từ. Hãy xóa bớt trước khi thêm.`,
      )
      return
    }
    setInputError(null)
    setInput('')
    onChange({ ...draft, customKeywords: [...draft.customKeywords, keyword] })
  }

  const removeKeyword = (keyword: string) => {
    setInputError(null)
    onChange({ ...draft, customKeywords: draft.customKeywords.filter((item) => item !== keyword) })
  }

  const effectiveCount = effectiveSearchKeywords(draft.groups, draft.customKeywords).length

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Khi con tìm kiếm trên Google, Bing, DuckDuckGo, Yahoo hoặc Cốc Cốc mà cụm từ tìm kiếm chứa
        một từ khóa bị cấm, lượt tìm kiếm đó bị chặn và trình duyệt hiện trang cảnh báo của SafePC.
        Mọi cụm từ đã tìm (kể cả lượt bị chặn) được ghi lại để phụ huynh xem trong Báo cáo tuần; dữ
        liệu giữ 90 ngày.
      </p>

      <fieldset>
        <legend className="mb-1 text-sm font-medium text-slate-700">
          Nhóm từ khóa có sẵn — tích để áp dụng cả nhóm
        </legend>
        <div className="space-y-2">
          {KEYWORD_GROUPS.map((group) => {
            const preview =
              group.keywords.length <= 3
                ? group.keywords.join(', ')
                : `${group.keywords.slice(0, 3).join(', ')}, … và ${group.keywords.length - 3} từ khác`
            return (
              <label
                key={group.id}
                className="flex min-h-[44px] cursor-pointer items-start gap-2 rounded-lg border border-slate-200 p-3"
              >
                <input
                  type="checkbox"
                  checked={draft.groups.includes(group.id)}
                  onChange={(e) => toggleGroup(group.id, e.target.checked)}
                  className={`${checkboxClassName} mt-0.5`}
                />
                <span>
                  <span className="block text-sm font-medium text-slate-800">
                    {group.label} ({group.keywords.length} từ khóa)
                  </span>
                  <span className="mt-0.5 block text-sm text-slate-600">{group.description}</span>
                  <span className="mt-0.5 block text-xs text-slate-500">{preview}</span>
                </span>
              </label>
            )
          })}
        </div>
        <p className="mt-1 text-xs text-slate-500">
          Các nhóm là danh sách mẫu do SafePC gợi ý — phụ huynh tự cân nhắc theo gia đình mình; bỏ
          tích một nhóm là gỡ toàn bộ từ khóa của nhóm đó khỏi danh sách bị cấm.
        </p>
      </fieldset>

      <div>
        <span className="mb-1 block text-sm font-medium text-slate-700">
          Từ khóa riêng của phụ huynh ({draft.customKeywords.length}/{MAX_SEARCH_KEYWORDS})
        </span>
        {draft.customKeywords.length === 0 ? (
          <p className="text-sm text-slate-500">
            Chưa có từ khóa riêng nào. Gõ từ khóa vào ô dưới đây để thêm từ ngoài các nhóm có sẵn.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2" aria-label="Danh sách từ khóa riêng">
            {draft.customKeywords.map((keyword) => (
              <li
                key={keyword}
                className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 py-1 pl-3 pr-1 text-sm text-red-800"
              >
                <span className="break-all">{keyword}</span>
                <button
                  type="button"
                  onClick={() => removeKeyword(keyword)}
                  aria-label={`Xóa từ khóa ${keyword}`}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-red-700 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <label htmlFor="search-keyword-input" className="mb-1 block text-sm font-medium text-slate-700">
          Thêm từ khóa riêng
        </label>
        <div className="flex gap-2">
          <input
            id="search-keyword-input"
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                // Enter trong ô này chỉ thêm từ khóa, không gửi cả form quy tắc.
                e.preventDefault()
                addKeyword(input)
              }
            }}
            placeholder="Ví dụ: cá cược"
            maxLength={MAX_SEARCH_KEYWORD_LENGTH + 20}
            className={inputClassName}
          />
          <button
            type="button"
            onClick={() => addKeyword(input)}
            className={`${secondaryButtonClassName} shrink-0`}
          >
            Thêm
          </button>
        </div>
        {inputError && (
          <p role="alert" className="mt-1 text-sm text-red-600">
            {inputError}
          </p>
        )}
        <p className="mt-1 text-xs text-slate-500">
          Mỗi từ khóa tối đa {MAX_SEARCH_KEYWORD_LENGTH} ký tự; không phân biệt hoa/thường (hệ thống
          tự chuyển thành chữ thường). Từ khóa riêng trùng với từ trong nhóm đã chọn chỉ tính một
          lần trong tổng số.
        </p>
      </div>

      <p className="rounded-lg bg-slate-50 p-3 text-sm font-medium text-slate-800" aria-live="polite">
        Tổng số từ khóa sẽ bị chặn: {effectiveCount}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Quy tắc ứng dụng + giờ học tập trung (đợt 3). AppsField dùng chung cho
// 3 form ứng dụng và form focus; kiểm tra hợp lệ ở lib/ruleConfig.ts.
// ---------------------------------------------------------------------------

/**
 * Danh sách ứng dụng có thể sửa: mỗi dòng gồm tên file .exe + tên hiển
 * thị (+ ô số phút khi `showMinutes`). `Row` là kiểu dòng của draft nơi
 * dùng (dòng giới hạn thời gian có thêm `minutes`, các dòng khác không) —
 * component chỉ đọc/ghi `minutes` khi `showMinutes` bật.
 */
export function AppsField<Row extends { exe: string; name: string }>({
  apps,
  onChange,
  showMinutes = false,
  minutesLabel = 'Giới hạn mỗi ngày (phút)',
  idPrefix = 'app',
}: {
  apps: Row[]
  onChange: (apps: Row[]) => void
  showMinutes?: boolean
  minutesLabel?: string
  idPrefix?: string
}) {
  const updateRow = (index: number, patch: Partial<Row>) => {
    onChange(apps.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const removeRow = (index: number) => {
    onChange(apps.filter((_, i) => i !== index))
  }

  const addRow = () => {
    const blank = showMinutes
      ? { exe: '', name: '', minutes: '60' }
      : { exe: '', name: '' }
    onChange([...apps, blank as Row])
  }

  return (
    <div className="space-y-2">
      {apps.map((row, index) => {
        const minutes = (row as { minutes?: string }).minutes ?? ''
        return (
          <div key={index} className="flex flex-wrap items-end gap-2">
            <div className="w-full sm:w-auto sm:flex-1">
              <label
                htmlFor={`${idPrefix}-exe-${index}`}
                className="mb-1 block text-xs text-slate-500"
              >
                Tên file .exe
              </label>
              <input
                id={`${idPrefix}-exe-${index}`}
                type="text"
                maxLength={100}
                value={row.exe}
                onChange={(e) => updateRow(index, { exe: e.target.value } as Partial<Row>)}
                placeholder="game.exe"
                className={inputClassName}
              />
            </div>
            <div className="w-full sm:w-auto sm:flex-1">
              <label
                htmlFor={`${idPrefix}-name-${index}`}
                className="mb-1 block text-xs text-slate-500"
              >
                Tên hiển thị (không bắt buộc)
              </label>
              <input
                id={`${idPrefix}-name-${index}`}
                type="text"
                maxLength={100}
                value={row.name}
                onChange={(e) => updateRow(index, { name: e.target.value } as Partial<Row>)}
                placeholder="Ví dụ: Game"
                className={inputClassName}
              />
            </div>
            {showMinutes && (
              <div className="w-full sm:w-32">
                <label
                  htmlFor={`${idPrefix}-minutes-${index}`}
                  className="mb-1 block text-xs text-slate-500"
                >
                  {minutesLabel}
                </label>
                <input
                  id={`${idPrefix}-minutes-${index}`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={1440}
                  step={5}
                  value={minutes}
                  onChange={(e) =>
                    updateRow(index, { minutes: e.target.value } as unknown as Partial<Row>)
                  }
                  className={inputClassName}
                />
              </div>
            )}
            <button
              type="button"
              onClick={() => removeRow(index)}
              aria-label={`Xoá ứng dụng ${row.exe.trim() || index + 1}`}
              className={dangerOutlineButtonClassName}
            >
              Xoá
            </button>
          </div>
        )
      })}
      <button type="button" onClick={addRow} className={secondaryButtonClassName}>
        Thêm ứng dụng
      </button>
      <p className="text-xs text-slate-500">
        Tên file .exe, ví dụ: game.exe. Chỉ nhập tên file, không nhập đường dẫn. Tên hiển thị để
        trống thì lấy theo tên file.
      </p>
    </div>
  )
}

export function AppTimeLimitForm({
  draft,
  onChange,
}: {
  draft: AppTimeLimitDraft
  onChange: (draft: AppTimeLimitDraft) => void
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Mỗi ứng dụng dưới đây chỉ được dùng tối đa số phút đã đặt mỗi ngày. Hết giờ, ứng dụng sẽ
        bị đóng tới hết ngày.
      </p>
      <AppsField
        apps={draft.apps}
        onChange={(apps) => onChange({ ...draft, apps })}
        showMinutes
        minutesLabel="Giới hạn mỗi ngày (phút)"
        idPrefix="app-limit"
      />
    </div>
  )
}

export function AppBlockForm({
  draft,
  onChange,
}: {
  draft: AppListDraft
  onChange: (draft: AppListDraft) => void
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Các ứng dụng dưới đây sẽ bị đóng mọi lúc, cho đến khi bạn tắt quy tắc.
      </p>
      <AppsField
        apps={draft.apps}
        onChange={(apps) => onChange({ ...draft, apps })}
        idPrefix="app-block-list"
      />
      <UntilToggledOffHint />
    </div>
  )
}

export function AppAllowlistForm({
  draft,
  onChange,
}: {
  draft: AppListDraft
  onChange: (draft: AppListDraft) => void
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        <strong>Chỉ</strong> các ứng dụng dưới đây được mở; mọi ứng dụng khác đều bị đóng (trừ các
        tiến trình hệ thống). Hãy chắc chắn đã liệt kê đủ các ứng dụng con cần dùng.
      </p>
      <AppsField
        apps={draft.apps}
        onChange={(apps) => onChange({ ...draft, apps })}
        idPrefix="app-allowlist"
      />
      <UntilToggledOffHint />
    </div>
  )
}

export function AppBlockByTimeForm({
  draft,
  onChange,
}: {
  draft: AppBlockByTimeDraft
  onChange: (draft: AppBlockByTimeDraft) => void
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Các ứng dụng dưới đây <strong>chỉ được dùng trong các khung giờ</strong> đã đặt; ngoài
        khung giờ, ứng dụng sẽ bị đóng. <strong>Ngày nào không có khung giờ nào thì các ứng
        dụng trên bị chặn cả ngày.</strong> Giờ tính theo giờ địa phương trên máy của con.
      </p>
      <AppsField
        apps={draft.apps}
        onChange={(apps) => onChange({ ...draft, apps })}
        idPrefix="app-block"
      />
      <WeekdayWindowsEditor
        draft={draft.windows}
        onChange={(windows) => onChange({ ...draft, windows })}
        idPrefix="app-window"
        emptyDayText="Không có khung giờ nào — các ứng dụng trên bị chặn cả ngày này."
      />
      <UntilToggledOffHint />
    </div>
  )
}

export function AppAllowlistByTimeForm({
  draft,
  onChange,
}: {
  draft: AppAllowlistByTimeDraft
  onChange: (draft: AppAllowlistByTimeDraft) => void
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Trong các khung giờ dưới đây, <strong>chỉ</strong> các ứng dụng trong danh sách được mở; ngoài
        khung giờ, quy tắc không đóng ứng dụng nào. <strong>Ngày nào không có khung giờ nào thì ngày đó
        không giới hạn.</strong> Giờ tính theo giờ địa phương trên máy của con.
      </p>
      <AppsField
        apps={draft.apps}
        onChange={(apps) => onChange({ ...draft, apps })}
        idPrefix="app-allowlist-time"
      />
      <WeekdayWindowsEditor
        draft={draft.windows}
        onChange={(windows) => onChange({ ...draft, windows })}
        idPrefix="app-allowlist-window"
        emptyDayText="Không có khung giờ nào — ngày này không giới hạn ứng dụng."
      />
      <UntilToggledOffHint />
    </div>
  )
}

export function ForcedBreakForm({
  draft,
  onChange,
}: {
  draft: ForcedBreakDraft
  onChange: (draft: ForcedBreakDraft) => void
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Nghỉ bắt buộc được thi hành bằng cách khóa phiên làm việc khi con dùng máy liên tục đủ
        số phút; máy sẽ khóa trong thời gian nghỉ.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="forced-break-work" className="mb-1 block text-sm font-medium text-slate-700">
            Dùng liên tục (phút)
          </label>
          <input
            id="forced-break-work"
            type="number"
            inputMode="numeric"
            min={15}
            max={180}
            step={5}
            value={draft.workMinutes}
            onChange={(e) => onChange({ ...draft, workMinutes: e.target.value })}
            className={inputClassName}
          />
          <p className="mt-1 text-xs text-slate-500">Từ 15 đến 180 phút.</p>
        </div>
        <div>
          <label htmlFor="forced-break-break" className="mb-1 block text-sm font-medium text-slate-700">
            Nghỉ (phút)
          </label>
          <input
            id="forced-break-break"
            type="number"
            inputMode="numeric"
            min={5}
            max={60}
            step={5}
            value={draft.breakMinutes}
            onChange={(e) => onChange({ ...draft, breakMinutes: e.target.value })}
            className={inputClassName}
          />
          <p className="mt-1 text-xs text-slate-500">Từ 5 đến 60 phút.</p>
        </div>
      </div>
    </div>
  )
}

export function FocusForm({
  draft,
  onChange,
}: {
  draft: FocusDraft
  onChange: (draft: FocusDraft) => void
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Trong giờ tập trung, chỉ các website và ứng dụng được phép mới mở được. Chặn tạm thời
        vẫn thắng; cho phép tạm thời không mở được website ngoài danh sách trong giờ tập trung.
        Giờ tính theo giờ địa phương trên máy của con.
      </p>
      <WeekdayWindowsEditor
        draft={draft.windows}
        onChange={(windows) => onChange({ ...draft, windows })}
        idPrefix="focus-window"
        emptyDayText="Không có khung giờ nào — ngày này không phải giờ học tập trung."
      />
      <DomainsField
        id="focus-domains"
        label="Website học tập được phép"
        value={draft.allowedDomainsText}
        onChange={(allowedDomainsText) => onChange({ ...draft, allowedDomainsText })}
        hint="Mỗi dòng một domain (phân tách bằng dấu phẩy cũng được). Trong giờ tập trung, mọi website ngoài danh sách này đều bị chặn."
      />
      <div>
        <p className="mb-1 block text-sm font-medium text-slate-700">Ứng dụng được phép</p>
        <AppsField
          apps={draft.apps}
          onChange={(apps) => onChange({ ...draft, apps })}
          idPrefix="focus-app"
        />
        <p className="mt-1 text-xs text-slate-500">
          Trong giờ tập trung, mọi ứng dụng ngoài danh sách này đều bị đóng — cần ít nhất một
          ứng dụng được phép.
        </p>
      </div>
    </div>
  )
}
