import { useState } from 'react'
import {
  WEEKDAY_OPTIONS,
  type BedtimeDraft,
  type BlockDomainsByTimeDraft,
  type DailyLimitDraft,
  type DomainTimeLimitDraft,
  type SafeSearchDraft,
  type TimeRangeValue,
  type TimeWindowDraft,
  type WebsiteDomainsDraft,
  type WeekdayNumber,
} from '../lib/ruleConfig'
import { inputClassName, secondaryButtonClassName } from './ui'

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
        <div>
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
                  <div>
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
                  <div>
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
                    className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
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
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-800">
              <input
                type="checkbox"
                checked={day.enabled}
                onChange={(e) => setDay(value, { enabled: e.target.checked })}
                className="h-4 w-4 rounded border-slate-300 accent-indigo-600"
              />
              {label}
            </label>
            <div>
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
            <div>
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
// Quy tắc website (đợt 2). Các form dùng chung DomainsField; kiểm tra hợp
// lệ ở lib/ruleConfig.ts (parseDomainsInput).
// ---------------------------------------------------------------------------

/**
 * Ô nhập danh sách domain, dùng chung cho mọi form website và thẻ ghi đè
 * website tạm thời. Định dạng: mỗi dòng một domain (dấu phẩy cũng được
 * chấp nhận). Có thể dán cả đường link — hệ thống chỉ lấy phần tên miền.
 */
export function DomainsField({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
}) {
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
        placeholder={'youtube.com\nfacebook.com'}
        className={inputClassName}
      />
      <p className="mt-1 text-xs text-slate-500">
        {hint ??
          'Mỗi dòng một domain (phân tách bằng dấu phẩy cũng được). Có thể dán cả đường link, ví dụ https://www.youtube.com/ — hệ thống chỉ lấy phần tên miền.'}
      </p>
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
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Các website dưới đây sẽ bị chặn mọi lúc. Quy tắc áp dụng cả cho tên miền con — chặn youtube.com thì cả
        www.youtube.com cũng bị chặn.
      </p>
      <DomainsField
        id="website-domains"
        label="Domain bị chặn"
        value={draft.domainsText}
        onChange={(domainsText) => onChange({ ...draft, domainsText })}
      />
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
        value={draft.domainsText}
        onChange={(domainsText) => onChange({ ...draft, domainsText })}
      />
      <WeekdayWindowsEditor
        draft={draft.windows}
        onChange={(windows) => onChange({ ...draft, windows })}
        idPrefix="domain-window"
        emptyDayText="Không có khung giờ nào — các domain trên không bị chặn ngày này."
      />
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
        value={draft.domainsText}
        onChange={(domainsText) => onChange({ ...draft, domainsText })}
      />
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
      <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-800">
        <input
          type="checkbox"
          checked={draft.searchProviders}
          onChange={(e) => onChange({ ...draft, searchProviders: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300 accent-indigo-600"
        />
        Bật SafeSearch cho công cụ tìm kiếm (Google, Bing…)
      </label>
      <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-800">
        <input
          type="checkbox"
          checked={draft.youtubeRestricted}
          onChange={(e) => onChange({ ...draft, youtubeRestricted: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300 accent-indigo-600"
        />
        Bật chế độ hạn chế của YouTube (Restricted Mode)
      </label>
    </div>
  )
}
