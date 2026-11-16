import { useState } from 'react'
import {
  WEEKDAY_OPTIONS,
  type BedtimeDraft,
  type DailyLimitDraft,
  type TimeRangeValue,
  type TimeWindowDraft,
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

export function TimeWindowForm({
  draft,
  onChange,
}: {
  draft: TimeWindowDraft
  onChange: (draft: TimeWindowDraft) => void
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
      <p className="text-sm text-slate-600">
        Ngoài các khung giờ dưới đây, máy sẽ bị khóa. <strong>Ngày nào không có khung giờ nào thì con không được
        dùng máy ngày đó.</strong> Giờ tính theo giờ địa phương trên máy của con. Khung giờ không được qua đêm
        (giờ bắt đầu phải sớm hơn giờ kết thúc) — muốn khóa qua đêm, dùng quy tắc giờ ngủ.
      </p>
      {WEEKDAY_OPTIONS.map(({ value, label }) => (
        <div key={value} className="rounded-lg border border-slate-200 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-slate-800">{label}</p>
            <button type="button" onClick={() => addRange(value)} className={secondaryButtonClassName}>
              Thêm khung giờ
            </button>
          </div>
          {draft[value].length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">Không có khung giờ nào — con không được dùng máy ngày này.</p>
          ) : (
            <div className="mt-2 space-y-2">
              {draft[value].map((range, index) => (
                <div key={index} className="flex flex-wrap items-end gap-2">
                  <div>
                    <label htmlFor={`window-start-${value}-${index}`} className="mb-1 block text-xs text-slate-500">
                      Từ giờ
                    </label>
                    <input
                      id={`window-start-${value}-${index}`}
                      type="time"
                      required
                      value={range.start}
                      onChange={(e) => updateRange(value, index, { start: e.target.value })}
                      className={inputClassName}
                    />
                  </div>
                  <div>
                    <label htmlFor={`window-end-${value}-${index}`} className="mb-1 block text-xs text-slate-500">
                      Đến giờ
                    </label>
                    <input
                      id={`window-end-${value}-${index}`}
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
