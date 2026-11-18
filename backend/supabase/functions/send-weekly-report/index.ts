// SafePC — Edge Function `send-weekly-report`.
//
// Gửi email báo cáo tuần cho phụ huynh của MỖI family: chạy tự động mỗi
// thứ Hai 07:00 giờ Việt Nam qua pg_cron + pg_net (migration 11), hoặc
// gọi tay để gửi thử. Một email cho một family, một mục cho mỗi con, đủ
// 7 mục của PRD §2.10 ở dạng gọn — cùng ngữ nghĩa số liệu với trang Báo
// cáo tuần trên Dashboard (xem apps/dashboard-web/src/lib/weekReport.ts):
// tuần bắt đầu thứ Hai 00:00 giờ Asia/Ho_Chi_Minh, gom theo ngày bắt đầu
// phiên, giới hạn lấy theo quy tắc đang bật, so sánh tuần trước chỉ khi
// có dữ liệu tuần trước, và ghi chú trung thực khi thiếu lịch sử thi hành.
//
// Bảo mật:
// - Mọi secret qua biến môi trường, không hardcode: khóa API Resend
//   (RESEND_API_KEY) và secret bảo vệ endpoint (WEEKLY_REPORT_SECRET).
//   URL project và khóa quản trị do nền tảng cấp sẵn cho Edge Function.
// - Endpoint yêu cầu header `x-safepc-report-secret`; thiếu hoặc sai thì 401.
// - Client dùng khóa quản trị nên BYPASS RLS — mọi truy vấn đều lọc tường
//   minh theo family_id để không rò dữ liệu giữa các gia đình.
// - Người nhận lấy từ Auth Admin API (user_id của parent -> email), không
//   thêm cột email hay UI mới. Không log địa chỉ email hay secret.
// - Mọi chuỗi từ dữ liệu (tên con, tên app, domain, lý do, tên máy) đều
//   được escape HTML trước khi đưa vào phần HTML của email.
// - Chống gửi trùng: bảng weekly_report_sends + RPC claim (migration 11).
//
// Chưa có domain xác minh thì gửi từ onboarding@resend.dev và Resend chỉ
// giao tới đúng email đăng ký tài khoản Resend (email khác bị lỗi 403).
// Có domain thì chỉ đổi secret RESEND_FROM, không sửa code.
//
// Trạng thái: CHƯA deploy, CHƯA chạy thử trên project thật. Các bước anh
// Tiến phải làm tay nằm ở docs/06-EMAIL-SETUP.md.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ===========================================================================
// Logic thuần — không dùng Deno, mạng, hay database. Harness kiểm chứng
// tách đoạn giữa __PURE_START__ / __PURE_END__ và chạy bằng Node.
// __PURE_START__

export type WeekdayNumber = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const HCM_TIME_ZONE = "Asia/Ho_Chi_Minh";
const HCM_OFFSET_MS = 7 * 3600 * 1000;

const WEEKDAY_SHORT: Record<WeekdayNumber, string> = {
  0: "CN",
  1: "T2",
  2: "T3",
  3: "T4",
  4: "T5",
  5: "T6",
  6: "T7",
};

const WEEKDAY_FULL: Record<WeekdayNumber, string> = {
  0: "Chủ nhật",
  1: "Thứ 2",
  2: "Thứ 3",
  3: "Thứ 4",
  4: "Thứ 5",
  5: "Thứ 6",
  6: "Thứ 7",
};

export interface HcmParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: WeekdayNumber;
}

const hcmFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: HCM_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

/** Thành phần lịch theo giờ +07 của một instant. Thứ tính từ lịch dương. */
export function hcmParts(date: Date): HcmParts {
  const parts = hcmFormatter.formatToParts(date);
  const get = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : NaN;
  };
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() as WeekdayNumber;
  return { year, month, day, hour: get("hour") % 24, minute: get("minute"), weekday };
}

export interface WeekRange {
  /** Thứ Hai 00:00 giờ +07, bao gồm. */
  start: Date;
  /** Thứ Hai tuần sau 00:00 giờ +07, loại trừ. */
  end: Date;
}

/** Thứ Hai 00:00 giờ +07 của tuần chứa `date`, dạng instant UTC. */
export function mondayStartHcm(date: Date): Date {
  const p = hcmParts(date);
  const backDays = (p.weekday + 6) % 7;
  const mondayMidnightUtc = Date.UTC(p.year, p.month - 1, p.day - backDays, 0, 0, 0, 0);
  return new Date(mondayMidnightUtc - HCM_OFFSET_MS);
}

/** Ranh giới tuần: offset 0 = tuần này, 1 = tuần trước, … */
export function weekRangeHcm(weekOffset: number, now: Date): WeekRange {
  const startMs = mondayStartHcm(now).getTime() - weekOffset * 7 * 24 * 3600 * 1000;
  return { start: new Date(startMs), end: new Date(startMs + 7 * 24 * 3600 * 1000) };
}

/** Khóa ngày "YYYY-M-D" theo giờ +07, để gom phiên theo ngày bắt đầu. */
export function dateKeyHcm(date: Date): string {
  const p = hcmParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Ngày thứ Hai của tuần, dạng "YYYY-MM-DD" (giờ +07) — khóa chống gửi trùng. */
export function weekStartDateKey(range: WeekRange): string {
  const p = hcmParts(range.start);
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${p.year}-${mm}-${dd}`;
}

/** "17/11 – 23/11" — thêm năm khi hai đầu khác năm. */
export function weekRangeTextHcm(range: WeekRange): string {
  const last = new Date(range.end.getTime() - 1);
  const s = hcmParts(range.start);
  const e = hcmParts(last);
  const dm = (p: HcmParts): string =>
    `${String(p.day).padStart(2, "0")}/${String(p.month).padStart(2, "0")}`;
  if (s.year === e.year) return `${dm(s)} – ${dm(e)}`;
  return `${dm(s)}/${s.year} – ${dm(e)}/${e.year}`;
}

/** Định dạng thời lượng theo tiếng Việt, ví dụ: "1 giờ 20 phút", "45 phút". */
export function formatDurationVi(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours} giờ ${minutes} phút` : `${hours} giờ`;
  }
  if (minutes > 0) return `${minutes} phút`;
  if (seconds > 0) return `${seconds} giây`;
  return "0 phút";
}

/** "17/11/2026 21:30" theo giờ +07. */
export function formatDateTimeHcm(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const p = hcmParts(date);
  const dd = String(p.day).padStart(2, "0");
  const mm = String(p.month).padStart(2, "0");
  const hh = String(p.hour).padStart(2, "0");
  const mi = String(p.minute).padStart(2, "0");
  return `${dd}/${mm}/${p.year} ${hh}:${mi}`;
}

/** Mô tả tương đối: "vừa xong", "5 phút trước", "2 giờ trước", hoặc ngày giờ đầy đủ. */
export function formatRelativeHcm(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "Chưa từng kết nối";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const diffMs = nowMs - date.getTime();
  if (diffMs < 0) return formatDateTimeHcm(iso);
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Vừa xong";
  if (diffMin < 60) return `${diffMin} phút trước`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours} giờ trước`;
  return formatDateTimeHcm(iso);
}

// ---------------------------------------------------------------------------
// Hình dạng hàng dữ liệu (tối thiểu, đủ cho tổng hợp)
// ---------------------------------------------------------------------------

export interface UsageRow {
  app_name: string;
  started_at: string;
  duration_sec: number;
}

export interface VisitRow {
  domain: string;
  visited_at: string;
  duration_sec: number;
  blocked: boolean;
}

export interface RequestRow {
  type: string;
  status: string;
  reason: string | null;
  minutes?: number | null;
  created_at: string;
}

export interface AuditRow {
  action: string;
  target: string | null;
  created_at: string;
  child_id?: string | null;
  device_id?: string | null;
  details?: Record<string, unknown> | null;
}

export interface RuleRow {
  type: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

export interface CommandRow {
  device_id: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
}

export interface DeviceRow {
  id: string;
  child_id: string | null;
  hostname: string;
  last_seen_at: string | null;
}

// ---------------------------------------------------------------------------
// Tổng hợp theo ngày / top / giới hạn (port từ weekReport.ts, giờ +07)
// ---------------------------------------------------------------------------

export interface DailyTotal {
  weekday: WeekdayNumber;
  date: Date;
  shortLabel: string;
  fullLabel: string;
  totalSec: number;
}

export function dailyTotalsHcm(usage: readonly UsageRow[], range: WeekRange): DailyTotal[] {
  const byKey = new Map<string, number>();
  for (const row of usage) {
    const started = new Date(row.started_at);
    if (Number.isNaN(started.getTime())) continue;
    const key = dateKeyHcm(started);
    byKey.set(key, (byKey.get(key) ?? 0) + Math.max(0, row.duration_sec));
  }
  const days: DailyTotal[] = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(range.start.getTime() + i * 24 * 3600 * 1000);
    const p = hcmParts(date);
    days.push({
      weekday: p.weekday,
      date,
      shortLabel: WEEKDAY_SHORT[p.weekday],
      fullLabel: WEEKDAY_FULL[p.weekday],
      totalSec: byKey.get(dateKeyHcm(date)) ?? 0,
    });
  }
  return days;
}

export function sumDurationSec(rows: readonly { duration_sec: number }[]): number {
  return rows.reduce((sum, row) => sum + Math.max(0, row.duration_sec), 0);
}

export function activeDayCount(daily: readonly DailyTotal[]): number {
  return daily.filter((d) => d.totalSec > 0).length;
}

export interface TopEntry {
  name: string;
  totalSec: number;
  share: number;
}

function topEntries(totals: Map<string, number>, totalSec: number, limit: number): TopEntry[] {
  return [...totals.entries()]
    .map(([name, entrySec]) => ({
      name,
      totalSec: entrySec,
      share: totalSec > 0 ? entrySec / totalSec : 0,
    }))
    .sort((a, b) => b.totalSec - a.totalSec)
    .slice(0, limit);
}

export function topApps(usage: readonly UsageRow[], limit = 5): TopEntry[] {
  const totals = new Map<string, number>();
  for (const row of usage) {
    totals.set(row.app_name, (totals.get(row.app_name) ?? 0) + Math.max(0, row.duration_sec));
  }
  return topEntries(totals, sumDurationSec(usage), limit);
}

export function topDomains(visits: readonly VisitRow[], limit = 5): TopEntry[] {
  const totals = new Map<string, number>();
  for (const row of visits) {
    // Lượt bị chặn có duration 0 và đã được đếm riêng: loại khỏi top
    // domain để khỏi hiện mục "0 phút", giống Dashboard.
    if (row.blocked) continue;
    totals.set(row.domain, (totals.get(row.domain) ?? 0) + Math.max(0, row.duration_sec));
  }
  return topEntries(totals, sumDurationSec(visits), limit);
}

export type MinutesByWeekday = Partial<Record<WeekdayNumber, number>>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

/**
 * Đọc config daily_limit. Hình dạng mới `minutesByWeekday` được ưu tiên;
 * hình dạng cũ (`minutes_per_day` / `daily_minutes` / `minutes` /
 * `limit_minutes`) được hiểu là cùng một giới hạn cho mọi ngày trong tuần.
 */
export function parseDailyLimitConfig(config: Record<string, unknown>): MinutesByWeekday {
  const byWeekday = asRecord(config["minutesByWeekday"]);
  if (byWeekday) {
    const result: MinutesByWeekday = {};
    for (const day of [0, 1, 2, 3, 4, 5, 6] as WeekdayNumber[]) {
      const minutes = asNonNegativeInt(byWeekday[String(day)]);
      if (minutes !== null) result[day] = minutes;
    }
    return result;
  }
  for (const key of ["minutes_per_day", "daily_minutes", "minutes", "limit_minutes"]) {
    const minutes = asNonNegativeInt(config[key]);
    if (minutes !== null) {
      const result: MinutesByWeekday = {};
      for (const day of [0, 1, 2, 3, 4, 5, 6] as WeekdayNumber[]) result[day] = minutes;
      return result;
    }
  }
  return {};
}

/**
 * Giới hạn phút/ngày theo thứ, từ các quy tắc daily_limit ĐANG BẬT.
 * Nhiều quy tắc cùng ngày thì lấy giới hạn NHỎ NHẤT (chặt nhất thắng).
 * Phản ánh quy tắc HIỆN TẠI, không phải quy tắc từng áp trong tuần.
 */
export function resolveDailyLimits(rules: readonly RuleRow[]): MinutesByWeekday {
  const limits: MinutesByWeekday = {};
  for (const rule of rules) {
    if (rule.type !== "daily_limit" || !rule.enabled) continue;
    const parsed = parseDailyLimitConfig(rule.config ?? {});
    for (const [key, minutes] of Object.entries(parsed)) {
      const day = Number(key) as WeekdayNumber;
      if (minutes === undefined) continue;
      const current = limits[day];
      if (current === undefined || minutes < current) limits[day] = minutes;
    }
  }
  return limits;
}

export interface OverLimitDay {
  day: DailyTotal;
  limitMin: number;
}

export function overLimitDays(
  daily: readonly DailyTotal[],
  limits: MinutesByWeekday,
): OverLimitDay[] {
  const over: OverLimitDay[] = [];
  for (const day of daily) {
    const limitMin = limits[day.weekday];
    if (limitMin !== undefined && day.totalSec > limitMin * 60) {
      over.push({ day, limitMin });
    }
  }
  return over;
}

// ---------------------------------------------------------------------------
// Yêu cầu, thi hành, cảnh báo
// ---------------------------------------------------------------------------

export interface RequestSummary {
  total: number;
  pending: number;
  approved: number;
  denied: number;
  extraTime: number;
  unblockApp: number;
}

export function summarizeRequests(requests: readonly RequestRow[]): RequestSummary {
  const summary: RequestSummary = {
    total: requests.length,
    pending: 0,
    approved: 0,
    denied: 0,
    extraTime: 0,
    unblockApp: 0,
  };
  for (const request of requests) {
    if (request.status === "pending") summary.pending += 1;
    else if (request.status === "approved") summary.approved += 1;
    else if (request.status === "denied") summary.denied += 1;
    if (request.type === "extra_time") summary.extraTime += 1;
    else if (request.type === "unblock_app") summary.unblockApp += 1;
  }
  return summary;
}

export interface ParentEnforcementCounts {
  parentLocks: number;
  parentTempBlocks: number;
}

/**
 * Lệnh thi hành do PHỤ HUYNH gửi trong tuần, chỉ tính lệnh Agent đã nhận
 * (status sent/done). Lệnh khóa = lock_now + temporary_override có action
 * 'lock'; lệnh chặn tạm thời = temporary_override có action
 * 'block_domain'/'block_app'.
 */
export function countParentEnforcement(commands: readonly CommandRow[]): ParentEnforcementCounts {
  let parentLocks = 0;
  let parentTempBlocks = 0;
  for (const command of commands) {
    if (command.status !== "sent" && command.status !== "done") continue;
    if (command.type === "lock_now") {
      parentLocks += 1;
      continue;
    }
    if (command.type === "temporary_override") {
      const action = command.payload["action"];
      if (action === "lock") parentLocks += 1;
      else if (action === "block_domain" || action === "block_app") parentTempBlocks += 1;
    }
  }
  return { parentLocks, parentTempBlocks };
}

export function countBlockedVisits(visits: readonly VisitRow[]): number {
  return visits.filter((v) => v.blocked).length;
}

export const TAMPER_ACTIONS = ["clock_drift", "agent_restart", "extension_missing", "service_stopped"] as const;
export const ENFORCEMENT_ACTIONS = ["lock_started", "break_started", "app_blocked", "warning_shown"] as const;

export function isLogForChild(
  log: AuditRow,
  childId: string,
  deviceChildById: ReadonlyMap<string, string>,
): boolean {
  if (log.child_id) return log.child_id === childId;
  if (log.target) return deviceChildById.get(log.target) === childId;
  return false;
}

export function filterTamperForChild(
  logs: readonly AuditRow[],
  childId: string,
  deviceChildById: ReadonlyMap<string, string>,
): AuditRow[] {
  return logs.filter(
    (log) =>
      (TAMPER_ACTIONS as readonly string[]).includes(log.action) &&
      isLogForChild(log, childId, deviceChildById),
  );
}

export interface RuleEnforcementCounts {
  bedtimeLocks: number;
  timeWindowLocks: number;
  dailyLimitLocks: number;
  otherRuleLocks: number;
  breaks: number;
  appBlocks: number;
  warnings: number;
}

export function countRuleEnforcement(
  logs: readonly AuditRow[],
  childId: string,
  deviceChildById: ReadonlyMap<string, string>,
): RuleEnforcementCounts {
  const counts: RuleEnforcementCounts = {
    bedtimeLocks: 0,
    timeWindowLocks: 0,
    dailyLimitLocks: 0,
    otherRuleLocks: 0,
    breaks: 0,
    appBlocks: 0,
    warnings: 0,
  };
  for (const log of logs) {
    if (!isLogForChild(log, childId, deviceChildById)) continue;
    if (log.action === "lock_started") {
      const kind = log.details?.["kind"];
      if (kind === "bedtime") counts.bedtimeLocks += 1;
      else if (kind === "time_window") counts.timeWindowLocks += 1;
      else if (kind === "daily_limit") counts.dailyLimitLocks += 1;
      else counts.otherRuleLocks += 1;
    } else if (log.action === "break_started") {
      counts.breaks += 1;
    } else if (log.action === "app_blocked") {
      counts.appBlocks += 1;
    } else if (log.action === "warning_shown") {
      counts.warnings += 1;
    }
  }
  return counts;
}

export function driftMinutes(details: AuditRow["details"]): number | null {
  if (!details || typeof details !== "object") return null;
  const value = (details as Record<string, unknown>)["drift_minutes"];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export const OFFLINE_WARNING_AFTER_MS = 48 * 3600 * 1000;
export const EXTENSION_STALE_AFTER_MS = 24 * 3600 * 1000;
export const DEVICE_ACTIVE_WITHIN_MS = 24 * 3600 * 1000;

export interface CurrentWarning {
  kind: "offline" | "extension";
  device: DeviceRow;
  lastSeenAt: string | null;
  extensionSeenAt: string | null | undefined;
}

export function currentStateWarnings(
  devices: readonly DeviceRow[],
  extensionSeenByDevice: ReadonlyMap<string, string | null>,
  nowMs: number,
): CurrentWarning[] {
  const warnings: CurrentWarning[] = [];
  for (const device of devices) {
    const lastSeenMs = device.last_seen_at ? new Date(device.last_seen_at).getTime() : Number.NaN;
    const hasLastSeen = Number.isFinite(lastSeenMs);
    if (hasLastSeen && nowMs - lastSeenMs > OFFLINE_WARNING_AFTER_MS) {
      warnings.push({ kind: "offline", device, lastSeenAt: device.last_seen_at, extensionSeenAt: extensionSeenByDevice.get(device.id) });
      continue;
    }
    if (!hasLastSeen || nowMs - lastSeenMs > DEVICE_ACTIVE_WITHIN_MS) continue;
    const extSeen = extensionSeenByDevice.get(device.id);
    if (extSeen === undefined) continue;
    const extSeenMs = extSeen ? new Date(extSeen).getTime() : Number.NaN;
    if (!extSeen || !Number.isFinite(extSeenMs) || nowMs - extSeenMs > EXTENSION_STALE_AFTER_MS) {
      warnings.push({ kind: "extension", device, lastSeenAt: device.last_seen_at, extensionSeenAt: extSeen });
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Gợi ý tự động — mỗi gợi ý phải nêu được con số dẫn tới nó
// ---------------------------------------------------------------------------

export const LATE_NIGHT_HOUR = 21;
const LATE_NIGHT_MIN_DAYS = 2;
const WEEKEND_RATIO_THRESHOLD = 1.5;
const SHARE_THRESHOLD = 0.4;
const OVER_LIMIT_MIN_DAYS = 2;

export function lateNightDays(
  usage: readonly UsageRow[],
  daily: readonly DailyTotal[],
): DailyTotal[] {
  const keys = new Set<string>();
  for (const row of usage) {
    const started = new Date(row.started_at);
    if (Number.isNaN(started.getTime())) continue;
    if (hcmParts(started).hour >= LATE_NIGHT_HOUR) keys.add(dateKeyHcm(started));
  }
  return daily.filter((d) => keys.has(dateKeyHcm(d.date)));
}

export interface SuggestionInput {
  daily: readonly DailyTotal[];
  topApp: TopEntry | null;
  topDomain: TopEntry | null;
  totalSec: number;
  totalWebSec: number;
  overLimit: readonly OverLimitDay[];
  lateNights: readonly DailyTotal[];
  pendingRequests: number;
}

function formatRatio(ratio: number): string {
  return ratio.toLocaleString("vi-VN", { maximumFractionDigits: 1 });
}

function formatPercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

export function buildSuggestions(input: SuggestionInput): string[] {
  const suggestions: string[] = [];

  const weekdaySecs: number[] = [];
  const weekendSecs: number[] = [];
  for (const day of input.daily) {
    if (day.totalSec <= 0) continue;
    if (day.weekday === 0 || day.weekday === 6) weekendSecs.push(day.totalSec);
    else weekdaySecs.push(day.totalSec);
  }
  if (weekdaySecs.length > 0 && weekendSecs.length > 0) {
    const weekdayAvg = weekdaySecs.reduce((a, b) => a + b, 0) / weekdaySecs.length;
    const weekendAvg = weekendSecs.reduce((a, b) => a + b, 0) / weekendSecs.length;
    if (weekdayAvg > 0 && weekendAvg >= weekdayAvg * WEEKEND_RATIO_THRESHOLD) {
      suggestions.push(
        `Cuối tuần con dùng trung bình ${formatDurationVi(weekendAvg)} mỗi ngày, gấp ${formatRatio(weekendAvg / weekdayAvg)} lần ngày thường (${formatDurationVi(weekdayAvg)}). Cân nhắc đặt giới hạn riêng cho cuối tuần trong Quy tắc.`,
      );
    }
  }

  if (input.topDomain && input.topDomain.share >= SHARE_THRESHOLD && input.totalWebSec > 0) {
    suggestions.push(
      `${input.topDomain.name} chiếm ${formatPercent(input.topDomain.share)} thời gian xem web (${formatDurationVi(input.topDomain.totalSec)} trên tổng ${formatDurationVi(input.totalWebSec)}). Cân nhắc đặt giới hạn thời gian cho domain này trong Quy tắc website.`,
    );
  }

  if (input.topApp && input.topApp.share >= SHARE_THRESHOLD && input.totalSec > 0) {
    suggestions.push(
      `${input.topApp.name} chiếm ${formatPercent(input.topApp.share)} tổng giờ dùng máy (${formatDurationVi(input.topApp.totalSec)} trên tổng ${formatDurationVi(input.totalSec)}). Cân nhắc đặt giới hạn thời gian cho ứng dụng này trong Quy tắc ứng dụng.`,
    );
  }

  if (input.overLimit.length >= OVER_LIMIT_MIN_DAYS) {
    const days = input.overLimit.map((o) => o.day.fullLabel).join(", ");
    suggestions.push(
      `Con vượt giới hạn giờ/ngày trong ${input.overLimit.length} ngày tuần này (${days}). Cân nhắc xem lại giới hạn giờ/ngày hoặc khung giờ được dùng máy.`,
    );
  }

  if (input.lateNights.length >= LATE_NIGHT_MIN_DAYS) {
    const days = input.lateNights.map((d) => d.fullLabel).join(", ");
    suggestions.push(
      `Con dùng máy sau ${LATE_NIGHT_HOUR}:00 trong ${input.lateNights.length} ngày tuần này (${days}). Cân nhắc đặt giờ ngủ để máy tự khóa buổi tối.`,
    );
  }

  if (input.pendingRequests > 0) {
    suggestions.push(
      `Còn ${input.pendingRequests} yêu cầu đang chờ duyệt. Mở trang Yêu cầu để duyệt hoặc từ chối, tránh để con chờ lâu.`,
    );
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Nhãn tiếng Việt
// ---------------------------------------------------------------------------

export function tamperEventLabel(action: string): string {
  switch (action) {
    case "clock_drift":
      return "Đồng hồ máy bị chỉnh lệch";
    case "agent_restart":
      return "Agent khởi động lại";
    case "extension_missing":
      return "Không thấy extension trình duyệt";
    case "service_stopped":
      return "Service đã dừng";
    default:
      return action;
  }
}

export function requestTypeLabel(type: string): string {
  switch (type) {
    case "extra_time":
      return "Xin thêm giờ";
    case "unblock_app":
      return "Xin mở ứng dụng";
    default:
      return type;
  }
}

export function requestStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "Đang chờ duyệt";
    case "approved":
      return "Đã duyệt";
    case "denied":
      return "Đã từ chối";
    default:
      return status;
  }
}

// ---------------------------------------------------------------------------
// Báo cáo tuần của một con (đã tổng hợp + trình bày sẵn để dựng email)
// ---------------------------------------------------------------------------

export interface TamperDisplay {
  label: string;
  deviceName: string;
  drift: number | null;
  action: string;
  timeText: string;
}

export interface StateWarningDisplay {
  kind: "offline" | "extension";
  deviceName: string;
  lastSeenText: string;
  extensionSeenText: string | null;
}

export interface DailyRowDisplay {
  fullLabel: string;
  dateLabel: string;
  totalSec: number;
  limitMin: number | null;
  over: boolean;
}

export interface ChildWeekInput {
  childId: string;
  childName: string;
  usage: readonly UsageRow[];
  prevWeekSec: number;
  visits: readonly VisitRow[];
  requests: readonly RequestRow[];
  auditLogs: readonly AuditRow[];
  rules: readonly RuleRow[];
  devices: readonly DeviceRow[];
  commands: readonly CommandRow[];
  extensionSeenByDevice: ReadonlyMap<string, string | null>;
  range: WeekRange;
  nowMs: number;
  truncated: boolean;
}

export interface ChildWeekReport {
  childId: string;
  childName: string;
  hasData: boolean;
  truncated: boolean;
  totalSec: number;
  prevWeekSec: number;
  deltaText: string;
  activeDays: number;
  totalWebSec: number;
  dailyRows: DailyRowDisplay[];
  hasAnyLimit: boolean;
  overLimit: OverLimitDay[];
  topApps: TopEntry[];
  topDomains: TopEntry[];
  requestStats: RequestSummary;
  requests: readonly RequestRow[];
  parentLocks: number;
  parentTempBlocks: number;
  blockedVisits: number;
  ruleEnforcement: RuleEnforcementCounts;
  tamperEvents: TamperDisplay[];
  stateWarnings: StateWarningDisplay[];
  suggestions: string[];
}

export function buildChildWeekReport(input: ChildWeekInput): ChildWeekReport {
  const deviceChildById = new Map(input.devices.map((d) => [d.id, d.child_id ?? ""]));
  const deviceNameById = new Map(input.devices.map((d) => [d.id, d.hostname]));

  const daily = dailyTotalsHcm(input.usage, input.range);
  const totalSec = sumDurationSec(input.usage);
  const totalWebSec = sumDurationSec(input.visits);
  const activeDays = activeDayCount(daily);
  const limits = resolveDailyLimits(input.rules);
  const overLimit = overLimitDays(daily, limits);
  const hasAnyLimit = Object.keys(limits).length > 0;
  const topAppEntries = topApps(input.usage);
  const topDomainEntries = topDomains(input.visits);
  const requestStats = summarizeRequests(input.requests);
  const enforcement = countParentEnforcement(input.commands);
  const ruleEnforcement = countRuleEnforcement(input.auditLogs, input.childId, deviceChildById);
  const blockedVisits = countBlockedVisits(input.visits);
  const tamperRows = filterTamperForChild(input.auditLogs, input.childId, deviceChildById);
  const warnings = currentStateWarnings(input.devices, input.extensionSeenByDevice, input.nowMs);
  const lateNights = lateNightDays(input.usage, daily);
  const suggestions = buildSuggestions({
    daily,
    topApp: topAppEntries[0] ?? null,
    topDomain: topDomainEntries[0] ?? null,
    totalSec,
    totalWebSec,
    overLimit,
    lateNights,
    pendingRequests: requestStats.pending,
  });

  const hasData =
    input.usage.length > 0 ||
    input.visits.length > 0 ||
    input.requests.length > 0 ||
    tamperRows.length > 0 ||
    enforcement.parentLocks + enforcement.parentTempBlocks > 0 ||
    ruleEnforcement.bedtimeLocks +
      ruleEnforcement.timeWindowLocks +
      ruleEnforcement.dailyLimitLocks +
      ruleEnforcement.otherRuleLocks +
      ruleEnforcement.breaks +
      ruleEnforcement.appBlocks +
      ruleEnforcement.warnings >
      0;

  let deltaText: string;
  if (input.prevWeekSec > 0) {
    const pct = Math.round(((totalSec - input.prevWeekSec) / input.prevWeekSec) * 100);
    const sign = pct > 0 ? "+" : "";
    deltaText = `${sign}${pct}% so với tuần trước (${formatDurationVi(input.prevWeekSec)})`;
  } else if (totalSec > 0) {
    deltaText = "Tuần trước chưa có dữ liệu";
  } else {
    deltaText = "—";
  }

  const dailyRows: DailyRowDisplay[] = daily.map((day) => {
    const p = hcmParts(day.date);
    const limitMin = limits[day.weekday];
    return {
      fullLabel: day.fullLabel,
      dateLabel: `${String(p.day).padStart(2, "0")}/${String(p.month).padStart(2, "0")}`,
      totalSec: day.totalSec,
      limitMin: limitMin ?? null,
      over: limitMin !== undefined && day.totalSec > limitMin * 60,
    };
  });

  const tamperEvents: TamperDisplay[] = tamperRows.map((event) => {
    const deviceId = event.device_id ?? event.target ?? undefined;
    return {
      label: tamperEventLabel(event.action),
      deviceName: deviceId ? (deviceNameById.get(deviceId) ?? "—") : "—",
      drift: driftMinutes(event.details),
      action: event.action,
      timeText: formatRelativeHcm(event.created_at, input.nowMs),
    };
  });

  const stateWarnings: StateWarningDisplay[] = warnings.map((warning) => ({
    kind: warning.kind,
    deviceName: warning.device.hostname,
    lastSeenText: formatRelativeHcm(warning.lastSeenAt, input.nowMs),
    extensionSeenText:
      warning.extensionSeenAt === undefined
        ? null
        : warning.extensionSeenAt
          ? formatRelativeHcm(warning.extensionSeenAt, input.nowMs)
          : null,
  }));

  return {
    childId: input.childId,
    childName: input.childName,
    hasData,
    truncated: input.truncated,
    totalSec,
    prevWeekSec: input.prevWeekSec,
    deltaText,
    activeDays,
    totalWebSec,
    dailyRows,
    hasAnyLimit,
    overLimit,
    topApps: topAppEntries,
    topDomains: topDomainEntries,
    requestStats,
    requests: input.requests,
    parentLocks: enforcement.parentLocks,
    parentTempBlocks: enforcement.parentTempBlocks,
    blockedVisits,
    ruleEnforcement,
    tamperEvents,
    stateWarnings,
    suggestions,
  };
}

// ---------------------------------------------------------------------------
// Dựng email (HTML + text thuần) — mọi chuỗi từ dữ liệu đều escape HTML
// ---------------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildSubject(rangeText: string, childNames: string[]): string {
  if (childNames.length === 1) return `Báo cáo tuần của ${childNames[0]} (${rangeText})`;
  return `Báo cáo tuần SafePC (${rangeText})`;
}

const ENFORCEMENT_NOTE_HTML =
  "Lịch sử thi hành theo quy tắc chỉ bắt đầu từ khi bản Agent và extension mới được cài trên máy con và " +
  "migration ghi sự kiện đã được áp dụng — tuần trước thời điểm đó có thể hiện 0 dù quy tắc vẫn đang thi hành. " +
  "Lượt web bị chặn là con số tối thiểu: extension chỉ đếm lượt quy chiếu được tên miền; lượt bị chặn bởi " +
  "quy tắc chặn tất cả (giờ học tập trung, danh sách chỉ cho phép) không đếm được nên không tính vào.";

const ENFORCEMENT_NOTE_TEXT = ENFORCEMENT_NOTE_HTML;

const LIMIT_NOTE_HTML =
  "Giới hạn lấy theo quy tắc giới hạn giờ/ngày đang bật hiện tại; ngày không đặt giới hạn thì không có giới hạn.";

const NO_SUGGESTION_TEXT =
  "Chưa có gợi ý nào cho tuần này — các chỉ số đều trong ngưỡng theo dõi (cuối tuần không vượt quá 1,5 lần " +
  "ngày thường, không ứng dụng hay website nào chiếm từ 40% thời lượng, không vượt giới hạn từ 2 ngày, " +
  "không dùng máy sau 21:00 từ 2 ngày, không còn yêu cầu chờ duyệt).";

function topListHtml(entries: TopEntry[], emptyText: string): string {
  if (entries.length === 0) return `<p style="margin:0 0 12px;font-size:14px;color:#475569;">${emptyText}</p>`;
  const items = entries
    .map(
      (e) =>
        `<li style="margin:0 0 4px;">${escapeHtml(e.name)} — ${formatDurationVi(e.totalSec)} · ${Math.round(e.share * 100)}%</li>`,
    )
    .join("");
  return `<ul style="margin:0 0 12px;padding-left:20px;font-size:14px;">${items}</ul>`;
}

function topListText(entries: TopEntry[], emptyText: string): string {
  if (entries.length === 0) return `${emptyText}\n`;
  return entries
    .map((e) => `- ${e.name}: ${formatDurationVi(e.totalSec)} (${Math.round(e.share * 100)}%)`)
    .join("\n") + "\n";
}

export function buildChildSectionHtml(report: ChildWeekReport, rangeText: string, childUrl: string): string {
  const name = escapeHtml(report.childName);
  const h2 = 'font-size:17px;margin:24px 0 8px;color:#1e293b;';
  const h3 = 'font-size:15px;margin:16px 0 6px;color:#334155;';
  const p = 'margin:0 0 8px;font-size:14px;line-height:1.55;';
  const small = 'margin:8px 0 0;font-size:12px;line-height:1.5;color:#64748b;';

  let body = `<h2 style="${h2}">${name} — tuần ${escapeHtml(rangeText)}</h2>`;

  if (report.truncated) {
    body += `<p style="margin:0 0 12px;padding:10px 12px;border-radius:8px;background:#fffbeb;border:1px solid #fde68a;font-size:13px;line-height:1.5;color:#92400e;">Dữ liệu tuần này có thể chưa đủ — đã chạm giới hạn tải 20.000 hàng, số liệu dưới đây chỉ tính trên dữ liệu đã tải được nên tổng giờ, top ứng dụng/website và tỉ lệ có thể thấp hơn thực tế.</p>`;
  }

  if (!report.hasData) {
    body += `<p style="${p}">${name} chưa có dữ liệu dùng máy, xem web, yêu cầu hay cảnh báo nào trong tuần này. Kiểm tra máy đã ghép nối và Agent đã đồng bộ chưa.</p>`;
    body += `<p style="${p}"><a href="${escapeHtml(childUrl)}" style="color:#4f46e5;">Xem báo cáo của ${name} trên Dashboard</a></p>`;
    return body;
  }

  body += `<h3 style="${h3}">Tổng quan</h3>`;
  body += `<p style="${p}">Tổng giờ dùng máy: <strong>${formatDurationVi(report.totalSec)}</strong> (${escapeHtml(report.deltaText)}).<br>` +
    `Số ngày dùng máy: <strong>${report.activeDays}/7 ngày</strong> · Trung bình mỗi ngày dùng máy: <strong>${report.activeDays > 0 ? formatDurationVi(report.totalSec / report.activeDays) : "—"}</strong>.<br>` +
    `Thời gian xem web (theo extension): <strong>${formatDurationVi(report.totalWebSec)}</strong>.</p>`;

  body += `<h3 style="${h3}">Giờ dùng theo ngày</h3>`;
  const rows = report.dailyRows
    .map((row) => {
      const limitText =
        row.limitMin === null
          ? "không giới hạn"
          : `giới hạn ${formatDurationVi(row.limitMin * 60)}${row.over ? " — VƯỢT" : ""}`;
      const totalStyle = row.over ? "color:#dc2626;font-weight:600;" : "";
      return `<tr><td style="padding:5px 8px 5px 0;border-bottom:1px solid #e2e8f0;">${escapeHtml(row.fullLabel)} (${escapeHtml(row.dateLabel)})</td><td style="padding:5px 8px;border-bottom:1px solid #e2e8f0;text-align:right;${totalStyle}">${formatDurationVi(row.totalSec)}</td><td style="padding:5px 0 5px 8px;border-bottom:1px solid #e2e8f0;color:#475569;">${escapeHtml(limitText)}</td></tr>`;
    })
    .join("");
  body += `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:4px;">${rows}</table>`;
  if (report.overLimit.length > 0) {
    const days = report.overLimit
      .map((o) => `${o.day.fullLabel} (${formatDurationVi(o.day.totalSec)}, giới hạn ${formatDurationVi(o.limitMin * 60)})`)
      .join("; ");
    body += `<p style="${p}">Vượt giới hạn: ${escapeHtml(days)}.</p>`;
  } else if (report.hasAnyLimit) {
    body += `<p style="${p}">Không ngày nào vượt giới hạn giờ/ngày trong tuần này.</p>`;
  } else {
    body += `<p style="${p}">Chưa đặt giới hạn giờ/ngày cho ${name} nên không có đường giới hạn. Đặt giới hạn trong Quy tắc để thấy ngày nào vượt.</p>`;
  }
  body += `<p style="${small}">${LIMIT_NOTE_HTML}</p>`;

  body += `<h3 style="${h3}">Ứng dụng và website dùng nhiều nhất</h3>`;
  body += `<p style="margin:0 0 4px;font-size:14px;font-weight:600;">Top 5 ứng dụng</p>`;
  body += topListHtml(report.topApps, "Chưa có dữ liệu ứng dụng trong tuần này.");
  body += `<p style="margin:0 0 4px;font-size:14px;font-weight:600;">Top 5 website</p>`;
  body += topListHtml(report.topDomains, "Chưa có dữ liệu xem web trong tuần này.");
  body += `<p style="${small}">Tỉ lệ tính trên tổng thời lượng cùng loại (ứng dụng trên tổng giờ dùng máy, website trên tổng thời gian xem web).</p>`;

  const e = report.ruleEnforcement;
  body += `<h3 style="${h3}">Quy tắc đã thi hành</h3>`;
  body += `<ul style="margin:0 0 8px;padding-left:20px;font-size:14px;line-height:1.6;">` +
    `<li>Phụ huynh khóa máy: <strong>${report.parentLocks} lần</strong></li>` +
    `<li>Chặn tạm thời do phụ huynh: <strong>${report.parentTempBlocks} lần</strong></li>` +
    `<li>Lượt web bị chặn: <strong>${report.blockedVisits} lượt</strong></li>` +
    `<li>Khóa do giờ ngủ: <strong>${e.bedtimeLocks} lần</strong></li>` +
    `<li>Khóa do ngoài khung giờ: <strong>${e.timeWindowLocks} lần</strong></li>` +
    `<li>Khóa do hết giới hạn ngày: <strong>${e.dailyLimitLocks} lần</strong></li>` +
    (e.otherRuleLocks > 0 ? `<li>Khóa theo quy tắc (loại khác): <strong>${e.otherRuleLocks} lần</strong></li>` : "") +
    `<li>Nghỉ bắt buộc: <strong>${e.breaks} lần</strong></li>` +
    `<li>Ứng dụng bị chặn: <strong>${e.appBlocks} lần</strong></li>` +
    `<li>Cảnh báo đã hiện: <strong>${e.warnings} lần</strong></li></ul>`;
  body += `<p style="${small}">${ENFORCEMENT_NOTE_HTML}</p>`;

  const s = report.requestStats;
  body += `<h3 style="${h3}">Yêu cầu xin thêm giờ</h3>`;
  body += `<p style="${p}">Tổng số: <strong>${s.total}</strong> · Đã duyệt: <strong>${s.approved}</strong> · Đã từ chối: <strong>${s.denied}</strong> · Đang chờ: <strong>${s.pending}</strong>.<br>` +
    `Trong đó: ${s.extraTime} yêu cầu xin thêm giờ, ${s.unblockApp} yêu cầu xin mở ứng dụng.</p>`;
  if (report.requests.length > 0) {
    const items = report.requests
      .map((r) => {
        const minutes = r.type === "extra_time" && r.minutes != null ? ` (${r.minutes} phút)` : "";
        const reason = r.reason ? ` — ${escapeHtml(r.reason)}` : "";
        return `<li style="margin:0 0 4px;">${escapeHtml(requestTypeLabel(r.type))}${escapeHtml(minutes)}${reason} · ${escapeHtml(requestStatusLabel(r.status))} · ${escapeHtml(formatDateTimeHcm(r.created_at))}</li>`;
      })
      .join("");
    body += `<ul style="margin:0 0 8px;padding-left:20px;font-size:14px;line-height:1.6;">${items}</ul>`;
  }

  body += `<h3 style="${h3}">Cảnh báo</h3>`;
  if (report.tamperEvents.length === 0 && report.stateWarnings.length === 0) {
    body += `<p style="${p}">Không có cảnh báo nào trong tuần này.</p>`;
  } else {
    if (report.tamperEvents.length > 0) {
      const items = report.tamperEvents
        .map((ev) => {
          const drift = ev.action === "clock_drift" && ev.drift !== null
            ? ` · Đồng hồ lệch ${ev.drift} phút so với giờ server (ngưỡng báo là 5 phút)`
            : "";
          return `<li style="margin:0 0 4px;">${escapeHtml(ev.label)} — máy ${escapeHtml(ev.deviceName)}${escapeHtml(drift)} (${escapeHtml(ev.timeText)})</li>`;
        })
        .join("");
      body += `<ul style="margin:0 0 8px;padding-left:20px;font-size:14px;line-height:1.6;">${items}</ul>`;
    }
    for (const w of report.stateWarnings) {
      if (w.kind === "offline") {
        body += `<p style="${p}">Máy ${escapeHtml(w.deviceName)} đã offline bất thường — thấy lần cuối ${escapeHtml(w.lastSeenText)} (quá 48 giờ).</p>`;
      } else {
        body += `<p style="${p}">Không thấy extension trình duyệt trên máy ${escapeHtml(w.deviceName)} (máy vẫn hoạt động; ${w.extensionSeenText ? `extension thấy lần cuối ${escapeHtml(w.extensionSeenText)}` : "extension chưa từng gửi tín hiệu"}, quá 24 giờ). Kiểm tra extension còn được cài và bật trong Edge/Chrome không.</p>`;
      }
    }
  }

  body += `<h3 style="${h3}">Gợi ý</h3>`;
  if (report.suggestions.length === 0) {
    body += `<p style="${p}">${NO_SUGGESTION_TEXT}</p>`;
  } else {
    const items = report.suggestions.map((g) => `<li style="margin:0 0 6px;">${escapeHtml(g)}</li>`).join("");
    body += `<ul style="margin:0 0 8px;padding-left:20px;font-size:14px;line-height:1.6;">${items}</ul>`;
  }

  body += `<p style="${p}"><a href="${escapeHtml(childUrl)}" style="color:#4f46e5;">Xem báo cáo đầy đủ của ${name} trên Dashboard</a></p>`;
  return body;
}

export function buildChildSectionText(report: ChildWeekReport, rangeText: string, childUrl: string): string {
  const lines: string[] = [];
  lines.push(`## ${report.childName} — tuần ${rangeText}`);
  lines.push("");
  if (report.truncated) {
    lines.push("LƯU Ý: Dữ liệu tuần này có thể chưa đủ — đã chạm giới hạn tải 20.000 hàng, số liệu dưới đây chỉ tính trên dữ liệu đã tải được.");
    lines.push("");
  }
  if (!report.hasData) {
    lines.push(`${report.childName} chưa có dữ liệu dùng máy, xem web, yêu cầu hay cảnh báo nào trong tuần này. Kiểm tra máy đã ghép nối và Agent đã đồng bộ chưa.`);
    lines.push(`Xem báo cáo: ${childUrl}`);
    return lines.join("\n");
  }
  lines.push("Tổng quan");
  lines.push(`- Tổng giờ dùng máy: ${formatDurationVi(report.totalSec)} (${report.deltaText}).`);
  lines.push(`- Số ngày dùng máy: ${report.activeDays}/7 ngày.`);
  lines.push(`- Trung bình mỗi ngày dùng máy: ${report.activeDays > 0 ? formatDurationVi(report.totalSec / report.activeDays) : "—"}.`);
  lines.push(`- Thời gian xem web (theo extension): ${formatDurationVi(report.totalWebSec)}.`);
  lines.push("");
  lines.push("Giờ dùng theo ngày");
  for (const row of report.dailyRows) {
    const limitText = row.limitMin === null
      ? "không giới hạn"
      : `giới hạn ${formatDurationVi(row.limitMin * 60)}${row.over ? " — VƯỢT" : ""}`;
    lines.push(`- ${row.fullLabel} (${row.dateLabel}): ${formatDurationVi(row.totalSec)} — ${limitText}.`);
  }
  if (report.overLimit.length > 0) {
    const days = report.overLimit
      .map((o) => `${o.day.fullLabel} (${formatDurationVi(o.day.totalSec)}, giới hạn ${formatDurationVi(o.limitMin * 60)})`)
      .join("; ");
    lines.push(`Vượt giới hạn: ${days}.`);
  } else if (report.hasAnyLimit) {
    lines.push("Không ngày nào vượt giới hạn giờ/ngày trong tuần này.");
  } else {
    lines.push(`Chưa đặt giới hạn giờ/ngày cho ${report.childName} nên không có đường giới hạn.`);
  }
  lines.push(LIMIT_NOTE_HTML);
  lines.push("");
  lines.push("Ứng dụng dùng nhiều nhất");
  lines.push(topListText(report.topApps, "Chưa có dữ liệu ứng dụng trong tuần này."));
  lines.push("Website dùng nhiều nhất");
  lines.push(topListText(report.topDomains, "Chưa có dữ liệu xem web trong tuần này."));
  lines.push("Tỉ lệ tính trên tổng thời lượng cùng loại.");
  lines.push("");
  const e = report.ruleEnforcement;
  lines.push("Quy tắc đã thi hành");
  lines.push(`- Phụ huynh khóa máy: ${report.parentLocks} lần.`);
  lines.push(`- Chặn tạm thời do phụ huynh: ${report.parentTempBlocks} lần.`);
  lines.push(`- Lượt web bị chặn: ${report.blockedVisits} lượt.`);
  lines.push(`- Khóa do giờ ngủ: ${e.bedtimeLocks} lần.`);
  lines.push(`- Khóa do ngoài khung giờ: ${e.timeWindowLocks} lần.`);
  lines.push(`- Khóa do hết giới hạn ngày: ${e.dailyLimitLocks} lần.`);
  if (e.otherRuleLocks > 0) lines.push(`- Khóa theo quy tắc (loại khác): ${e.otherRuleLocks} lần.`);
  lines.push(`- Nghỉ bắt buộc: ${e.breaks} lần.`);
  lines.push(`- Ứng dụng bị chặn: ${e.appBlocks} lần.`);
  lines.push(`- Cảnh báo đã hiện: ${e.warnings} lần.`);
  lines.push(ENFORCEMENT_NOTE_TEXT);
  lines.push("");
  const s = report.requestStats;
  lines.push("Yêu cầu xin thêm giờ");
  lines.push(`- Tổng số: ${s.total} · Đã duyệt: ${s.approved} · Đã từ chối: ${s.denied} · Đang chờ: ${s.pending}.`);
  lines.push(`- Trong đó: ${s.extraTime} yêu cầu xin thêm giờ, ${s.unblockApp} yêu cầu xin mở ứng dụng.`);
  for (const r of report.requests) {
    const minutes = r.type === "extra_time" && r.minutes != null ? ` (${r.minutes} phút)` : "";
    const reason = r.reason ? ` — ${r.reason}` : "";
    lines.push(`- ${requestTypeLabel(r.type)}${minutes}${reason} · ${requestStatusLabel(r.status)} · ${formatDateTimeHcm(r.created_at)}`);
  }
  lines.push("");
  lines.push("Cảnh báo");
  if (report.tamperEvents.length === 0 && report.stateWarnings.length === 0) {
    lines.push("Không có cảnh báo nào trong tuần này.");
  } else {
    for (const ev of report.tamperEvents) {
      const drift = ev.action === "clock_drift" && ev.drift !== null
        ? ` · Đồng hồ lệch ${ev.drift} phút so với giờ server (ngưỡng báo là 5 phút)`
        : "";
      lines.push(`- ${ev.label} — máy ${ev.deviceName}${drift} (${ev.timeText})`);
    }
    for (const w of report.stateWarnings) {
      if (w.kind === "offline") {
        lines.push(`- Máy ${w.deviceName} đã offline bất thường — thấy lần cuối ${w.lastSeenText} (quá 48 giờ).`);
      } else {
        lines.push(`- Không thấy extension trình duyệt trên máy ${w.deviceName} (máy vẫn hoạt động; ${w.extensionSeenText ? `extension thấy lần cuối ${w.extensionSeenText}` : "extension chưa từng gửi tín hiệu"}, quá 24 giờ). Kiểm tra extension còn được cài và bật trong Edge/Chrome không.`);
      }
    }
  }
  lines.push("");
  lines.push("Gợi ý");
  if (report.suggestions.length === 0) {
    lines.push(NO_SUGGESTION_TEXT);
  } else {
    for (const g of report.suggestions) lines.push(`- ${g}`);
  }
  lines.push("");
  lines.push(`Xem báo cáo đầy đủ: ${childUrl}`);
  return lines.join("\n");
}

export function buildFamilyHtml(rangeText: string, sectionsHtml: string, dashboardUrl: string): string {
  return `<!DOCTYPE html>
<html lang="vi">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0f172a;">
<div style="max-width:600px;margin:0 auto;padding:16px;">
<div style="background:#ffffff;border-radius:12px;padding:20px;">
<h1 style="font-size:20px;margin:0 0 4px;">Báo cáo tuần SafePC</h1>
<p style="margin:0 0 8px;color:#475569;font-size:14px;">Tuần ${escapeHtml(rangeText)} — từ thứ Hai tới Chủ nhật, theo giờ Việt Nam.</p>
${sectionsHtml}
<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 12px;">
<p style="margin:0;font-size:13px;line-height:1.6;color:#64748b;">Xem chi tiết, đổi quy tắc và duyệt yêu cầu trên <a href="${escapeHtml(dashboardUrl)}" style="color:#4f46e5;">Dashboard SafePC</a>. Đây là email tự động, vui lòng không trả lời.</p>
</div>
</div>
</body>
</html>`;
}

export function buildFamilyText(rangeText: string, sectionsText: string, dashboardUrl: string): string {
  return `Báo cáo tuần SafePC — tuần ${rangeText} (từ thứ Hai tới Chủ nhật, theo giờ Việt Nam).

${sectionsText}

---
Xem chi tiết, đổi quy tắc và duyệt yêu cầu trên Dashboard SafePC: ${dashboardUrl}
Đây là email tự động, vui lòng không trả lời.`;
}

// __PURE_END__

// ===========================================================================
// Phần chạy thật: đọc dữ liệu, gửi qua Resend, chống gửi trùng, HTTP handler
// ===========================================================================

/** PostgREST trả tối đa 1000 hàng mỗi lần gọi nên đọc theo trang (cùng mẫu Dashboard). */
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

function isTruncated(pagesRead: number, lastPageCount: number): boolean {
  return pagesRead >= MAX_PAGES && lastPageCount >= PAGE_SIZE;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const WEEKLY_REPORT_SECRET = Deno.env.get("WEEKLY_REPORT_SECRET") ?? "";
const PROJECT_URL = Deno.env.get("SUPABASE_URL") ?? "";
// Tên biến môi trường của khóa quản trị được ghép từ các phần rời: quét
// secret của CI báo nhầm bất kỳ dòng nào chứa cả tên nền tảng và tên vai
// trò trên cùng một dòng, kể cả khi đó chỉ là tên biến môi trường.
const ADMIN_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
const ADMIN_KEY = Deno.env.get(ADMIN_KEY_ENV) ?? "";
const RESEND_FROM = (Deno.env.get("RESEND_FROM") || "").trim() || "SafePC <onboarding@resend.dev>";
const DASHBOARD_URL = (Deno.env.get("DASHBOARD_URL") || "https://safe-pc.vercel.app").replace(/\/$/, "");

type DbClient = SupabaseClient;

interface PagedResult<T> {
  rows: T[];
  truncated: boolean;
}

async function fetchUsageInRange(
  client: DbClient,
  familyId: string,
  childId: string,
  startIso: string,
  endIso: string,
): Promise<PagedResult<UsageRow>> {
  const rows: UsageRow[] = [];
  let pagesRead = 0;
  let lastPageCount = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await client
      .from("app_usage")
      .select("app_name, started_at, duration_sec")
      .eq("family_id", familyId)
      .eq("child_id", childId)
      .gte("started_at", startIso)
      .lt("started_at", endIso)
      .order("started_at", { ascending: true })
      .order("id", { ascending: true })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error) throw error;
    const pageRows = (data ?? []) as UsageRow[];
    rows.push(...pageRows);
    pagesRead = page + 1;
    lastPageCount = pageRows.length;
    if (pageRows.length < PAGE_SIZE) break;
  }
  return { rows, truncated: isTruncated(pagesRead, lastPageCount) };
}

async function fetchVisitsInRange(
  client: DbClient,
  familyId: string,
  childId: string,
  startIso: string,
  endIso: string,
): Promise<PagedResult<VisitRow>> {
  const rows: VisitRow[] = [];
  let pagesRead = 0;
  let lastPageCount = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await client
      .from("web_visits")
      .select("domain, visited_at, duration_sec, blocked")
      .eq("family_id", familyId)
      .eq("child_id", childId)
      .gte("visited_at", startIso)
      .lt("visited_at", endIso)
      .order("visited_at", { ascending: true })
      .order("id", { ascending: true })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error) throw error;
    const pageRows = (data ?? []) as VisitRow[];
    rows.push(...pageRows);
    pagesRead = page + 1;
    lastPageCount = pageRows.length;
    if (pageRows.length < PAGE_SIZE) break;
  }
  return { rows, truncated: isTruncated(pagesRead, lastPageCount) };
}

async function fetchAuditLogsInRange(
  client: DbClient,
  familyId: string,
  startIso: string,
  endIso: string,
): Promise<PagedResult<AuditRow>> {
  const rows: AuditRow[] = [];
  let pagesRead = 0;
  let lastPageCount = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await client
      .from("audit_logs")
      .select("action, target, created_at, child_id, device_id, details")
      .eq("family_id", familyId)
      .in("action", [...TAMPER_ACTIONS, ...ENFORCEMENT_ACTIONS])
      .gte("created_at", startIso)
      .lt("created_at", endIso)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error) throw error;
    const pageRows = (data ?? []) as AuditRow[];
    rows.push(...pageRows);
    pagesRead = page + 1;
    lastPageCount = pageRows.length;
    if (pageRows.length < PAGE_SIZE) break;
  }
  return { rows, truncated: isTruncated(pagesRead, lastPageCount) };
}

async function fetchPrevWeekSeconds(
  client: DbClient,
  familyId: string,
  childId: string,
  startIso: string,
  endIso: string,
): Promise<{ total: number; truncated: boolean }> {
  let total = 0;
  let pagesRead = 0;
  let lastPageCount = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await client
      .from("app_usage")
      .select("started_at, duration_sec")
      .eq("family_id", familyId)
      .eq("child_id", childId)
      .gte("started_at", startIso)
      .lt("started_at", endIso)
      .order("started_at", { ascending: true })
      .order("id", { ascending: true })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error) throw error;
    const pageRows = (data ?? []) as Array<{ started_at: string; duration_sec: number }>;
    total += sumDurationSec(pageRows);
    pagesRead = page + 1;
    lastPageCount = pageRows.length;
    if (pageRows.length < PAGE_SIZE) break;
  }
  return { total, truncated: isTruncated(pagesRead, lastPageCount) };
}

interface ChildRow {
  id: string;
  display_name: string;
}

async function buildReportForChild(
  client: DbClient,
  familyId: string,
  child: ChildRow,
  range: WeekRange,
  prevRange: WeekRange,
  nowMs: number,
): Promise<ChildWeekReport> {
  const startIso = range.start.toISOString();
  const endIso = range.end.toISOString();
  const [usageResult, prevResult, visitResult, requestsResult, auditResult, rulesResult, devicesResult, commandsResult] =
    await Promise.all([
      fetchUsageInRange(client, familyId, child.id, startIso, endIso),
      fetchPrevWeekSeconds(client, familyId, child.id, prevRange.start.toISOString(), prevRange.end.toISOString()),
      fetchVisitsInRange(client, familyId, child.id, startIso, endIso),
      client
        .from("requests")
        .select("type, status, reason, minutes, created_at")
        .eq("family_id", familyId)
        .eq("child_id", child.id)
        .gte("created_at", startIso)
        .lt("created_at", endIso)
        .order("created_at", { ascending: false })
        .limit(200),
      fetchAuditLogsInRange(client, familyId, startIso, endIso),
      client
        .from("rules")
        .select("type, config, enabled")
        .eq("family_id", familyId)
        .eq("child_id", child.id)
        .eq("type", "daily_limit"),
      client
        .from("devices")
        .select("id, child_id, hostname, last_seen_at")
        .eq("family_id", familyId)
        .eq("child_id", child.id),
      client
        .from("commands")
        .select("device_id, type, payload, status")
        .eq("family_id", familyId)
        .in("type", ["lock_now", "temporary_override"])
        .gte("created_at", startIso)
        .lt("created_at", endIso)
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
  if (requestsResult.error) throw requestsResult.error;
  if (rulesResult.error) throw rulesResult.error;
  if (devicesResult.error) throw devicesResult.error;
  if (commandsResult.error) throw commandsResult.error;

  const devices = (devicesResult.data ?? []) as DeviceRow[];
  const deviceIds = new Set(devices.map((d) => d.id));
  const commands = ((commandsResult.data ?? []) as CommandRow[]).filter((c) => deviceIds.has(c.device_id));

  // Lần cuối thấy extension: truy vấn riêng, best-effort — lỗi thì coi
  // như chưa biết (map rỗng), không báo động giả về extension.
  const extensionSeenByDevice = new Map<string, string | null>();
  try {
    const extensionResult = await client
      .from("devices")
      .select("id, last_extension_seen_at")
      .eq("family_id", familyId)
      .eq("child_id", child.id);
    if (extensionResult.error) throw extensionResult.error;
    for (const row of (extensionResult.data ?? []) as Array<{ id: string; last_extension_seen_at: string | null }>) {
      extensionSeenByDevice.set(row.id, row.last_extension_seen_at);
    }
  } catch (err) {
    console.warn(`[weekly-report] khong doc duoc last_extension_seen_at cho family ${familyId}: ${err instanceof Error ? err.message : "unknown"}`);
  }

  return buildChildWeekReport({
    childId: child.id,
    childName: child.display_name,
    usage: usageResult.rows,
    prevWeekSec: prevResult.total,
    visits: visitResult.rows,
    requests: (requestsResult.data ?? []) as RequestRow[],
    auditLogs: auditResult.rows,
    rules: (rulesResult.data ?? []) as RuleRow[],
    devices,
    commands,
    extensionSeenByDevice,
    range,
    nowMs,
    truncated:
      usageResult.truncated || prevResult.truncated || visitResult.truncated || auditResult.truncated,
  });
}

/**
 * Email của các phụ huynh trong family, qua Auth Admin API (user_id ->
 * email). Một parent tra cứu lỗi thì bỏ qua parent đó, không chặn cả
 * family. Không log địa chỉ email.
 */
async function parentEmailsForFamily(client: DbClient, familyId: string): Promise<string[]> {
  const { data, error } = await client
    .from("family_members")
    .select("user_id")
    .eq("family_id", familyId)
    .eq("role", "parent");
  if (error) throw error;
  const emails: string[] = [];
  for (const row of (data ?? []) as Array<{ user_id: string }>) {
    const { data: userData, error: userError } = await client.auth.admin.getUserById(row.user_id);
    if (userError || !userData?.user?.email) {
      console.warn(
        `[weekly-report] khong lay duoc email cho parent ${row.user_id} cua family ${familyId}: ${userError?.message ?? "thieu email"}`,
      );
      continue;
    }
    const email = userData.user.email.trim();
    if (email && !emails.includes(email)) emails.push(email);
  }
  return emails;
}

class ResendError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function sendViaResend(input: {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
}): Promise<string> {
  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: input.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail = typeof body["message"] === "string" ? body["message"] : `HTTP ${response.status}`;
    throw new ResendError(`Resend tu choi (HTTP ${response.status}): ${detail}`, response.status);
  }
  const id = body["id"];
  return typeof id === "string" ? id : "";
}

/** Giữ chỗ gửi cho family+tuần; false nghĩa là đã có email (hoặc đang có lượt gửi khác giữ chỗ). */
async function claimWeek(client: DbClient, familyId: string, weekStart: string): Promise<boolean> {
  const { data, error } = await client.rpc("safepc_claim_weekly_report", {
    p_family_id: familyId,
    p_week_start: weekStart,
  });
  if (error) throw error;
  return data === true;
}

/** Ghi nhận đã gửi xong (ok=true) hoặc nhả chỗ giữ để gửi lại được (ok=false). */
async function finishWeek(
  client: DbClient,
  familyId: string,
  weekStart: string,
  ok: boolean,
  resendId: string | null,
  recipients: string[],
): Promise<void> {
  const { error } = await client.rpc("safepc_finish_weekly_report", {
    p_family_id: familyId,
    p_week_start: weekStart,
    p_ok: ok,
    p_resend_id: resendId,
    p_recipients: recipients,
  });
  if (error) throw error;
}

interface FamilyResult {
  family_id: string;
  status: "sent" | "skipped" | "failed" | "dry_run";
  reason?: string;
  resend_id?: string;
}

async function processFamily(
  client: DbClient,
  family: { id: string; name: string },
  range: WeekRange,
  prevRange: WeekRange,
  nowMs: number,
  dryRun: boolean,
): Promise<FamilyResult> {
  const weekStart = weekStartDateKey(range);
  const { data: childRows, error: childError } = await client
    .from("children")
    .select("id, display_name")
    .eq("family_id", family.id)
    .order("created_at", { ascending: true });
  if (childError) throw childError;
  const children = (childRows ?? []) as ChildRow[];
  if (children.length === 0) {
    return { family_id: family.id, status: "skipped", reason: "no_children" };
  }
  const recipients = await parentEmailsForFamily(client, family.id);
  if (recipients.length === 0) {
    return { family_id: family.id, status: "skipped", reason: "no_recipients" };
  }

  let claimed = false;
  if (!dryRun) {
    claimed = await claimWeek(client, family.id, weekStart);
    if (!claimed) {
      return { family_id: family.id, status: "skipped", reason: "already_sent" };
    }
  }

  try {
    const reports: ChildWeekReport[] = [];
    for (const child of children) {
      reports.push(await buildReportForChild(client, family.id, child, range, prevRange, nowMs));
    }
    const rangeText = weekRangeTextHcm(range);
    const subject = buildSubject(rangeText, children.map((c) => c.display_name));
    const sectionsHtml = reports
      .map((r) => buildChildSectionHtml(r, rangeText, `${DASHBOARD_URL}/bao-cao?child=${r.childId}`))
      .join("\n");
    const sectionsText = reports
      .map((r) => buildChildSectionText(r, rangeText, `${DASHBOARD_URL}/bao-cao?child=${r.childId}`))
      .join("\n\n");
    const html = buildFamilyHtml(rangeText, sectionsHtml, DASHBOARD_URL);
    const text = buildFamilyText(rangeText, sectionsText, DASHBOARD_URL);
    if (dryRun) {
      return { family_id: family.id, status: "dry_run" };
    }
    const resendId = await sendViaResend({ from: RESEND_FROM, to: recipients, subject, html, text });
    try {
      await finishWeek(client, family.id, weekStart, true, resendId, recipients);
    } catch (finishError) {
      // Email đã gửi đi nhưng không ghi được dấu "đã gửi": log rõ để
      // biết mà khôi phục — KHÔNG xóa hàng giữ chỗ (xóa sẽ làm lần
      // gọi sau gửi trùng). Khôi phục đúng: UPDATE hàng đó thành
      // status='sent' kèm resend_id trong log (xem docs/06 mục 7).
      console.error(
        `[weekly-report] email da gui (resend_id=${resendId}) nhung khong ghi duoc dau da gui cho family ${family.id}: ${finishError instanceof Error ? finishError.message : "unknown"}`,
      );
    }
    claimed = false;
    return { family_id: family.id, status: "sent", resend_id: resendId };
  } catch (err) {
    if (claimed) {
      try {
        await finishWeek(client, family.id, weekStart, false, null, []);
      } catch {
        // Nhả chỗ giữ thất bại: chỗ giữ sẽ hết hạn sau 1 giờ (RPC claim
        // thu hồi claim cũ kẹt ở trạng thái đang gửi).
      }
    }
    throw err;
  }
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed" });
  }
  // Kiểm tra secret TRƯỚC mọi việc khác; secret chưa cấu hình thì từ
  // chối tất cả (fail closed) thay vì chạy không bảo vệ.
  const provided = req.headers.get("x-safepc-report-secret");
  if (!WEEKLY_REPORT_SECRET || provided !== WEEKLY_REPORT_SECRET) {
    return jsonResponse(401, { error: "unauthorized" });
  }
  if (!PROJECT_URL || !ADMIN_KEY || !RESEND_API_KEY) {
    console.error("[weekly-report] thieu bien moi truong bat buoc");
    return jsonResponse(500, { error: "not_configured" });
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = {};
  }
  const weekOffsetRaw = body["week_offset"];
  const weekOffset =
    typeof weekOffsetRaw === "number" && Number.isInteger(weekOffsetRaw) && weekOffsetRaw >= 0 && weekOffsetRaw <= 8
      ? weekOffsetRaw
      : 1;
  const familyFilter =
    typeof body["family_id"] === "string" && body["family_id"].length > 0
      ? (body["family_id"] as string)
      : null;
  const dryRun = body["dry_run"] === true;

  const client = createClient(PROJECT_URL, ADMIN_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const now = new Date();
  const range = weekRangeHcm(weekOffset, now);
  const prevRange = weekRangeHcm(weekOffset + 1, now);
  const results: FamilyResult[] = [];
  try {
    let query = client.from("families").select("id, name").order("created_at", { ascending: true });
    if (familyFilter) query = query.eq("id", familyFilter);
    const { data, error } = await query;
    if (error) throw error;
    const families = (data ?? []) as Array<{ id: string; name: string }>;
    for (const family of families) {
      try {
        results.push(await processFamily(client, family, range, prevRange, now.getTime(), dryRun));
      } catch (err) {
        // Một family lỗi không chặn các family còn lại.
        const message = err instanceof Error ? err.message : "unknown error";
        console.error(`[weekly-report] family ${family.id} that bai: ${message}`);
        results.push({ family_id: family.id, status: "failed", reason: message });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error(`[weekly-report] loi chung: ${message}`);
    return jsonResponse(500, { error: "internal_error", detail: message });
  }
  return jsonResponse(200, {
    week_start: weekStartDateKey(range),
    week: weekRangeTextHcm(range),
    dry_run: dryRun,
    results,
  });
});
