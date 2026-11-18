import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatDurationVi } from '../lib/format'

export interface HourChartRow {
  hour: number
  label: string
  totalSec: number
  minutes: number
}

function HourTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ payload: HourChartRow }>
}) {
  if (!active || !payload || payload.length === 0) return null
  const row = payload[0].payload
  const nextHour = row.hour === 23 ? 24 : row.hour + 1
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-md">
      <p className="font-medium text-slate-900">
        {row.hour}h–{nextHour}h
      </p>
      <p className="mt-0.5 text-slate-700">Đã dùng: {formatDurationVi(row.totalSec)}</p>
    </div>
  )
}

/**
 * Biểu đồ cột giờ dùng trong ngày (24 giờ, đơn vị phút). Tách riêng để
 * trang Hôm nay tải lười Recharts (nặng) như trang Báo cáo tuần — trang
 * tổng quan không được bắt mọi lượt xem trả thêm ~108KB gzip (đo từ build thật).
 */
export default function TodayHourChart({ data }: { data: HourChartRow[] }) {
  return (
    <div className="h-60 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            interval={2}
            tick={{ fontSize: 12 }}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={40}
            tick={{ fontSize: 12 }}
            allowDecimals={false}
          />
          <Tooltip content={<HourTooltip />} />
          <Bar dataKey="minutes" fill="#4f46e5" radius={[4, 4, 0, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
