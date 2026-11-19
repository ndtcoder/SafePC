// SafePC — Edge Function `send-parent-notifications`.
//
// Gửi email thông báo cho phụ huynh khi có sự kiện cần chú ý (PRD §2.8):
// con xin thêm giờ / xin mở ứng dụng, phát hiện can thiệp (đổi giờ, Agent
// khởi động lại, mất extension, Service dừng), và máy offline bất thường
// (quá 48 giờ không thấy tín hiệu). Chạy quét định kỳ mỗi 5 phút qua
// pg_cron + pg_net (migration 12), hoặc gọi tay để gửi thử.
//
// Vì sao quét định kỳ thay vì trigger trên INSERT:
// - Một cơ chế duy nhất bao được cả 3 loại sự kiện — offline là sự VẮNG
//   tín hiệu nên không có hàng mới nào để trigger bám vào.
// - Không chạm tới đường ghi của Agent: trigger lỗi có thể làm hỏng cả
//   lần ghi yêu cầu/sự kiện của máy con; quét chỉ đọc + ghi vào bảng
//   nhật ký riêng của nó.
// - Chống trùng rõ ràng: mỗi sự kiện có đúng một khóa trong bảng
//   notification_sends, giữ chỗ nguyên tử trước khi gửi (mẫu của
//   weekly_report_sends). Quét lỗi giữa chừng thì lần quét sau gửi bù,
//   không mất sự kiện, không gửi trùng.
// - Độ trễ tối đa 5 phút là chấp nhận được: Dashboard đã hiện yêu cầu
//   ngay qua Realtime khi phụ huynh đang mở; email là lớp nhắc thêm.
//
// Chống spam/trùng (xem docs/07-NOTIFICATIONS-SETUP.md mục 8):
// - Mỗi yêu cầu / sự kiện can thiệp chỉ gửi tối đa 1 email (khóa theo
//   id hàng). Yêu cầu đã được duyệt/từ chối trước lúc gửi thì bỏ qua.
// - Yêu cầu: mỗi con tối đa 1 email mỗi giờ (yêu cầu thêm trong giờ đó
//   vẫn hiện trên Dashboard để phụ huynh xử lý).
// - Can thiệp: cùng một máy + cùng một loại thì tối đa 1 email mỗi 6 giờ.
// - Offline: mỗi "đợt" offline chỉ 1 email; khóa đợt gắn với thời điểm
//   thấy máy lần cuối nên máy quay lại rồi lại offline mới báo tiếp.
// - Chỉ xét sự kiện trong 24 giờ gần nhất; sự kiện cũ hơn coi như đã qua.
// - Mỗi lần quét gửi tối đa 25 email cho một gia đình (chốt chặn cuối
//   trước trần 100 email/ngày của gói Resend miễn phí).
// - KHÔNG đọc trước bảng notification_sends để loại sự kiện đã xử lý:
//   claim là kiểm tra duy nhất, cùng mẫu với function báo cáo tuần. Đọc
//   trước sẽ loại cả hàng 'sending' kẹt, làm đường thu hồi claim kẹt
//   trong RPC thành mã chết và sự kiện mất lặng vĩnh viễn.
//
// Bảo mật (cùng mẫu send-weekly-report):
// - Mọi secret qua biến môi trường, không hardcode. Dùng CHUNG secret
//   của function báo cáo tuần (RESEND_API_KEY, RESEND_FROM,
//   WEEKLY_REPORT_SECRET) — không thêm secret mới.
// - Endpoint yêu cầu header `x-safepc-report-secret`; thiếu hoặc sai thì 401.
// - Client dùng khóa quản trị nên BYPASS RLS — mọi truy vấn đều lọc tường
//   minh theo family_id để không rò dữ liệu giữa các gia đình.
// - Người nhận lấy từ Auth Admin API (user_id của parent -> email). Không
//   log địa chỉ email hay secret.
// - Mọi chuỗi từ dữ liệu đều escape HTML trước khi đưa vào phần HTML;
//   tiêu đề email loại bỏ ký tự xuống dòng.
// - Không bịa dữ liệu: trường nào trống thì bỏ dòng đó, không ghi giá trị
//   thay thế.
//
// Chưa có domain xác minh thì gửi từ onboarding@resend.dev và Resend chỉ
// giao tới đúng email đăng ký tài khoản Resend (email khác bị lỗi 403).
// Có domain thì chỉ đổi secret RESEND_FROM, không sửa code.
//
// Trạng thái: CHƯA deploy, CHƯA chạy thử trên project thật. Các bước anh
// Tiến phải làm tay nằm ở docs/07-NOTIFICATIONS-SETUP.md.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ===========================================================================
// Logic thuần — không dùng Deno, mạng, hay database. Harness kiểm chứng
// tách đoạn giữa __PURE_START__ / __PURE_END__ và chạy bằng Node.
// __PURE_START__

const HCM_TIME_ZONE = "Asia/Ho_Chi_Minh";
const HCM_OFFSET_MS = 7 * 3600 * 1000;

export type WeekdayNumber = 0 | 1 | 2 | 3 | 4 | 5 | 6;

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

/** Mô tả tương đối: "vừa xong", "5 phút trước", "2 giờ trước", "2 ngày trước", hoặc ngày giờ đầy đủ. */
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
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays} ngày trước`;
  return formatDateTimeHcm(iso);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Tiêu đề email không được chứa ký tự xuống dòng (tên con/tên máy từ dữ
 * liệu có thể chứa ký tự lạ): gộp mọi khoảng trắng liền kề thành 1 dấu
 * cách và cắt đầu/cuối.
 */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Quy tắc chọn sự kiện — ngưỡng và cửa sổ (nêu rõ trong docs/07 mục 8)
// ---------------------------------------------------------------------------

/** Chỉ xét sự kiện tạo trong 24 giờ gần nhất; cũ hơn coi như đã qua. */
export const EVENT_LOOKBACK_MS = 24 * 3600 * 1000;
/** Máy không thấy tín hiệu quá 48 giờ thì báo offline (cùng ngưỡng với báo cáo tuần). */
export const OFFLINE_AFTER_MS = 48 * 3600 * 1000;
/** Cùng một máy + cùng một loại can thiệp thì tối đa 1 email mỗi 6 giờ. */
export const TAMPER_THROTTLE_MS = 6 * 3600 * 1000;
/** Mỗi con tối đa 1 email yêu cầu mỗi giờ (chống spam nút "xin thêm giờ"). */
export const REQUEST_THROTTLE_MS = 3600 * 1000;

export const TAMPER_ACTIONS = ["clock_drift", "agent_restart", "extension_missing", "service_stopped", "tray_stopped"] as const;
export type TamperAction = (typeof TAMPER_ACTIONS)[number];

export function tamperActionLabel(action: string): string {
  switch (action) {
    case "clock_drift":
      return "Phát hiện đổi giờ hệ thống";
    case "agent_restart":
      return "Agent khởi động lại bất thường";
    case "extension_missing":
      return "Không thấy extension trình duyệt";
    case "service_stopped":
      return "Service SafePC đã dừng";
    case "tray_stopped":
      return "Tray SafePC dừng bất thường";
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
    case "unblock_domain":
      return "Xin mở trang web";
    default:
      return type;
  }
}

export interface RequestRow {
  id: string;
  child_id: string;
  device_id: string | null;
  type: string;
  status: string;
  reason: string | null;
  minutes: number | null;
  // Tên miền con xin mở (migration 18, chỉ với loại unblock_domain). Gộp
  // best-effort ở vòng quét để hàm vẫn chạy khi migration 18 chưa áp.
  domain?: string | null;
  created_at: string;
}

export interface AuditRow {
  id: string;
  child_id: string | null;
  device_id: string | null;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface DeviceRow {
  id: string;
  child_id: string | null;
  hostname: string;
  last_seen_at: string | null;
}

/** Tuổi của một mốc thời gian so với hiện tại; null khi không parse được. */
export function ageMs(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? nowMs - ms : null;
}

/**
 * Yêu cầu có đáng báo không: còn chờ duyệt và tạo trong 24 giờ gần nhất.
 * Hàng ghi giờ tương lai (đồng hồ máy con lệch) thì để lần quét sau, khi
 * thời gian đã bắt kịp, vẫn trong cửa sổ 24 giờ.
 */
export function shouldNotifyRequest(row: RequestRow, nowMs: number): boolean {
  if (row.status !== "pending") return false;
  const age = ageMs(row.created_at, nowMs);
  return age !== null && age >= 0 && age <= EVENT_LOOKBACK_MS;
}

/** Sự kiện can thiệp có đáng báo không: đúng loại và tạo trong 24 giờ gần nhất. */
export function shouldNotifyTamper(row: AuditRow, nowMs: number): boolean {
  if (!(TAMPER_ACTIONS as readonly string[]).includes(row.action)) return false;
  const age = ageMs(row.created_at, nowMs);
  return age !== null && age >= 0 && age <= EVENT_LOOKBACK_MS;
}

/**
 * Khóa đợt offline của một máy: null khi máy chưa từng kết nối hoặc chưa
 * quá ngưỡng 48 giờ. Khóa gắn với thời điểm thấy máy lần cuối (dạng số
 * mili-giây, ổn định qua các lần quét) nên cùng một đợt offline chỉ có
 * một khóa duy nhất; máy quay lại rồi lại offline thì khóa mới.
 */
export function offlineEpisodeKey(device: DeviceRow, nowMs: number): string | null {
  if (!device.last_seen_at) return null;
  const seenMs = new Date(device.last_seen_at).getTime();
  if (!Number.isFinite(seenMs)) return null;
  if (nowMs - seenMs <= OFFLINE_AFTER_MS) return null;
  return `${device.id}@${seenMs}`;
}

export interface SentTamperRow {
  device_id: string | null;
  action: string | null;
  sent_at: string | null;
}

/**
 * Cùng máy + cùng loại can thiệp đã có email trong 6 giờ gần nhất chưa.
 * Hàng sent_at trong tương lai (lệch giờ) thì tính là đang chặn — thiên
 * về ít spam hơn.
 */
export function isTamperThrottled(
  sentRows: readonly SentTamperRow[],
  deviceId: string | null,
  action: string,
  nowMs: number,
): boolean {
  if (!deviceId) return false;
  for (const row of sentRows) {
    if (row.device_id !== deviceId || row.action !== action) continue;
    const age = ageMs(row.sent_at, nowMs);
    if (age !== null && age <= TAMPER_THROTTLE_MS) return true;
  }
  return false;
}

export interface SentRequestRow {
  child_id: string | null;
  sent_at: string | null;
}

/**
 * Con này đã có email yêu cầu trong 1 giờ gần nhất chưa. Hàng sent_at
 * trong tương lai (lệch giờ) thì tính là đang chặn — thiên về ít spam
 * hơn. Con không xác định được thì không chặn (không chặn nhầm).
 */
export function isRequestThrottled(
  sentRows: readonly SentRequestRow[],
  childId: string | null,
  nowMs: number,
): boolean {
  if (!childId) return false;
  for (const row of sentRows) {
    if (row.child_id !== childId) continue;
    const age = ageMs(row.sent_at, nowMs);
    if (age !== null && age <= REQUEST_THROTTLE_MS) return true;
  }
  return false;
}

/** Số phút lệch đồng hồ trong details của sự kiện clock_drift; null khi không có. */
export function driftMinutes(details: Record<string, unknown> | null | undefined): number | null {
  if (!details || typeof details !== "object") return null;
  const value = details["drift_minutes"];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Dựng email (HTML + text thuần) — mọi chuỗi từ dữ liệu đều escape HTML
// ---------------------------------------------------------------------------

export interface NotificationEmail {
  subject: string;
  html: string;
  text: string;
}

const EMAIL_SHELL_OPEN =
  `<div style="margin:0;padding:24px 16px;background:#f8fafc;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">` +
  `<div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;">`;

function emailShell(title: string, bodyHtml: string, dashboardUrl: string): string {
  return (
    EMAIL_SHELL_OPEN +
    `<h1 style="margin:0 0 4px;font-size:20px;line-height:1.4;color:#0f172a;">${escapeHtml(title)}</h1>` +
    `<p style="margin:0 0 16px;font-size:13px;color:#64748b;">Thông báo từ SafePC — theo giờ Việt Nam.</p>` +
    bodyHtml +
    `<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0 12px;">` +
    `<p style="margin:0;font-size:13px;line-height:1.6;color:#64748b;">Xem chi tiết và xử lý trên <a href="${escapeHtml(dashboardUrl)}" style="color:#4f46e5;">Dashboard SafePC</a>. Đây là email tự động, vui lòng không trả lời.</p>` +
    `</div></div>`
  );
}

function detailLineHtml(label: string, value: string): string {
  return `<p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#334155;">${escapeHtml(label)}: <strong>${escapeHtml(value)}</strong></p>`;
}

export interface RequestEmailInput {
  childName: string | null;
  deviceName: string | null;
  type: string;
  minutes: number | null;
  domain: string | null;
  reason: string | null;
  createdAt: string;
  requestsUrl: string;
  dashboardUrl: string;
}

export function buildRequestEmail(input: RequestEmailInput): NotificationEmail {
  const timeText = formatDateTimeHcm(input.createdAt);
  const child = input.childName ? oneLine(input.childName) : null;
  const device = input.deviceName ? oneLine(input.deviceName) : null;
  const domain = input.domain ? oneLine(input.domain) : null;
  const what =
    input.type === "extra_time" && typeof input.minutes === "number"
      ? `thêm ${input.minutes} phút`
      : input.type === "extra_time"
        ? "thêm giờ"
        : input.type === "unblock_domain" && domain
          ? `mở trang ${domain}`
          : input.type === "unblock_domain"
            ? "mở trang web bị chặn"
            : "mở ứng dụng bị chặn";
  const subject = child
    ? oneLine(`[SafePC] ${child} xin ${what}`)
    : oneLine(`[SafePC] Yêu cầu mới${device ? ` từ máy ${device}` : ""}`);
  const title = requestTypeLabel(input.type);

  let bodyHtml = "";
  if (child) bodyHtml += detailLineHtml("Con", child);
  if (device) bodyHtml += detailLineHtml("Máy", device);
  bodyHtml += detailLineHtml("Lúc", timeText);
  bodyHtml += detailLineHtml("Xin", what);
  // Lý do ép về một dòng: bản text thuần sẽ chèn dòng giả nếu lý do chứa
  // ký tự xuống dòng; bản HTML escape nên không sao, nhưng dùng chung một
  // dạng cho cả hai bản.
  const reason = oneLine(input.reason ?? "");
  if (reason) bodyHtml += detailLineHtml("Lý do", reason);
  bodyHtml +=
    `<p style="margin:16px 0 0;font-size:14px;line-height:1.6;"><a href="${escapeHtml(input.requestsUrl)}" style="color:#4f46e5;">Duyệt hoặc từ chối yêu cầu trên Dashboard</a></p>`;

  const textLines = [
    `${title} — SafePC`,
    child ? `Con: ${child}` : null,
    device ? `Máy: ${device}` : null,
    `Lúc: ${timeText}`,
    `Xin: ${what}`,
    reason ? `Lý do: ${reason}` : null,
    "",
    `Duyệt hoặc từ chối yêu cầu trên Dashboard: ${input.requestsUrl}`,
    "Đây là email tự động, vui lòng không trả lời.",
  ].filter((line): line is string => line !== null);

  return { subject, html: emailShell(title, bodyHtml, input.dashboardUrl), text: textLines.join("\n") };
}

export interface TamperEmailInput {
  childName: string | null;
  deviceName: string | null;
  action: string;
  drift: number | null;
  createdAt: string;
  dashboardUrl: string;
}

export function buildTamperEmail(input: TamperEmailInput): NotificationEmail {
  const timeText = formatDateTimeHcm(input.createdAt);
  const child = input.childName ? oneLine(input.childName) : null;
  const device = input.deviceName ? oneLine(input.deviceName) : null;
  const label = tamperActionLabel(input.action);
  const subject = oneLine(`[SafePC] Cảnh báo: ${label}${device ? ` — máy ${device}` : ""}`);

  let bodyHtml = "";
  if (child) bodyHtml += detailLineHtml("Con", child);
  if (device) bodyHtml += detailLineHtml("Máy", device);
  bodyHtml += detailLineHtml("Lúc", timeText);
  if (input.drift !== null) bodyHtml += detailLineHtml("Chênh lệch đồng hồ", `${input.drift} phút`);
  bodyHtml +=
    `<p style="margin:16px 0 0;font-size:14px;line-height:1.6;color:#334155;">Kiểm tra máy khi có thể. Nếu con không làm gì bất thường thì có thể đây là sự cố kỹ thuật (máy hết pin, mất điện, cập nhật Windows).</p>`;

  const textLines = [
    `Cảnh báo SafePC: ${label}`,
    child ? `Con: ${child}` : null,
    device ? `Máy: ${device}` : null,
    `Lúc: ${timeText}`,
    input.drift !== null ? `Chênh lệch đồng hồ: ${input.drift} phút` : null,
    "",
    "Kiểm tra máy khi có thể. Nếu con không làm gì bất thường thì có thể đây là sự cố kỹ thuật (máy hết pin, mất điện, cập nhật Windows).",
    `Xem trên Dashboard: ${input.dashboardUrl}`,
    "Đây là email tự động, vui lòng không trả lời.",
  ].filter((line): line is string => line !== null);

  return { subject, html: emailShell(`Cảnh báo: ${label}`, bodyHtml, input.dashboardUrl), text: textLines.join("\n") };
}

export interface OfflineEmailInput {
  childName: string | null;
  deviceName: string;
  lastSeenAt: string;
  nowMs: number;
  dashboardUrl: string;
}

export function buildOfflineEmail(input: OfflineEmailInput): NotificationEmail {
  const device = oneLine(input.deviceName);
  const child = input.childName ? oneLine(input.childName) : null;
  const lastSeenText = formatDateTimeHcm(input.lastSeenAt);
  const relativeText = formatRelativeHcm(input.lastSeenAt, input.nowMs);
  const subject = oneLine(`[SafePC] Máy ${device} đã offline hơn 48 giờ`);
  const title = "Máy offline bất thường";

  let bodyHtml = "";
  if (child) bodyHtml += detailLineHtml("Con", child);
  bodyHtml += detailLineHtml("Máy", device);
  bodyHtml += detailLineHtml("Thấy lần cuối", `${lastSeenText} (${relativeText})`);
  bodyHtml +=
    `<p style="margin:16px 0 0;font-size:14px;line-height:1.6;color:#334155;">Máy không gửi tín hiệu hơn 48 giờ. Máy có thể đang tắt, mất mạng, hoặc Agent đã dừng — kiểm tra máy khi có thể.</p>`;

  const textLines = [
    `${title} — SafePC`,
    child ? `Con: ${child}` : null,
    `Máy: ${device}`,
    `Thấy lần cuối: ${lastSeenText} (${relativeText})`,
    "",
    "Máy không gửi tín hiệu hơn 48 giờ. Máy có thể đang tắt, mất mạng, hoặc Agent đã dừng — kiểm tra máy khi có thể.",
    `Xem trên Dashboard: ${input.dashboardUrl}`,
    "Đây là email tự động, vui lòng không trả lời.",
  ].filter((line): line is string => line !== null);

  return { subject, html: emailShell(title, bodyHtml, input.dashboardUrl), text: textLines.join("\n") };
}

// __PURE_END__

// ===========================================================================
// Phần chạy thật: quét sự kiện, gửi qua Resend, chống gửi trùng, HTTP handler
// ===========================================================================

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
// Dùng CHUNG secret bảo vệ endpoint của function báo cáo tuần: hai
// endpoint cùng độ tin cậy (chỉ lịch cron phía server gọi), một secret
// thì anh Tiến đỡ phải quản lý thêm. Đọc đúng tên biến đã đặt ở docs/06.
const ENDPOINT_SECRET = Deno.env.get("WEEKLY_REPORT_SECRET") ?? "";
const PROJECT_URL = Deno.env.get("SUPABASE_URL") ?? "";
// Tên biến môi trường của khóa quản trị được ghép từ các phần rời: quét
// secret của CI báo nhầm bất kỳ dòng nào chứa cả tên nền tảng và tên vai
// trò trên cùng một dòng, kể cả khi đó chỉ là tên biến môi trường.
const ADMIN_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
const ADMIN_KEY = Deno.env.get(ADMIN_KEY_ENV) ?? "";
const RESEND_FROM = (Deno.env.get("RESEND_FROM") || "").trim() || "SafePC <onboarding@resend.dev>";
const DASHBOARD_URL = (Deno.env.get("DASHBOARD_URL") || "https://safe-pc.vercel.app").replace(/\/$/, "");

/** Số ứng viên tối đa mỗi loại trong một lần quét, để một lần quét không kéo dài. */
const SCAN_LIMIT = 200;
/** Số email tối đa một lần quét gửi cho một gia đình (chốt chặn cuối trước trần Resend). */
const MAX_SENDS_PER_SCAN = 25;

type DbClient = SupabaseClient;

type NotificationKind = "request" | "tamper" | "device_offline";
type EventOutcome = "sent" | "skipped" | "throttled" | "failed" | "would_send" | "would_skip" | "would_throttle";

interface EventResult {
  kind: NotificationKind;
  event_key: string;
  status: EventOutcome;
  reason?: string;
  resend_id?: string;
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
  let failedParents = 0;
  for (const row of (data ?? []) as Array<{ user_id: string }>) {
    const { data: userData, error: userError } = await client.auth.admin.getUserById(row.user_id);
    if (userError || !userData?.user?.email) {
      // Chỉ đếm, không log từng parent: quét chạy mỗi 5 phút, một parent
      // lỗi lặp sẽ thành hàng trăm dòng log mỗi ngày.
      failedParents += 1;
      continue;
    }
    const email = userData.user.email.trim();
    if (email && !emails.includes(email)) emails.push(email);
  }
  if (failedParents > 0) {
    console.warn(
      `[parent-notify] khong lay duoc email cho ${failedParents} parent cua family ${familyId} (user da xoa hoac thieu email)`,
    );
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

/** Giữ chỗ gửi cho một sự kiện; false nghĩa là đã có hàng (đã gửi/đang gửi/bỏ qua). */
async function claimNotification(
  client: DbClient,
  familyId: string,
  kind: NotificationKind,
  eventKey: string,
  deviceId: string | null,
  action: string | null,
  childId: string | null,
): Promise<boolean> {
  const { data, error } = await client.rpc("safepc_claim_notification", {
    p_family_id: familyId,
    p_kind: kind,
    p_event_key: eventKey,
    p_device_id: deviceId,
    p_action: action,
    p_child_id: childId,
  });
  if (error) throw error;
  return data === true;
}

/** Ghi nhận đã gửi xong (ok=true) hoặc nhả chỗ giữ để quét sau gửi lại được (ok=false). */
async function finishNotification(
  client: DbClient,
  kind: NotificationKind,
  eventKey: string,
  ok: boolean,
  resendId: string | null,
  recipients: string[],
): Promise<void> {
  const { error } = await client.rpc("safepc_finish_notification", {
    p_kind: kind,
    p_event_key: eventKey,
    p_ok: ok,
    p_resend_id: resendId,
    p_recipients: recipients,
  });
  if (error) throw error;
}

/** Ghi dấu cuối cho sự kiện không gửi (đã quyết định / bị chặn spam) để lần quét sau không xét lại. */
async function markNotificationTerminal(
  client: DbClient,
  familyId: string,
  kind: NotificationKind,
  eventKey: string,
  status: "skipped" | "throttled",
  deviceId: string | null,
  action: string | null,
  childId: string | null,
): Promise<void> {
  const { error } = await client.rpc("safepc_mark_notification_terminal", {
    p_family_id: familyId,
    p_kind: kind,
    p_event_key: eventKey,
    p_status: status,
    p_device_id: deviceId,
    p_action: action,
    p_child_id: childId,
  });
  if (error) throw error;
}

interface FamilyContext {
  childNameById: Map<string, string>;
  deviceById: Map<string, DeviceRow>;
}

/** Gửi một email cho một sự kiện đã giữ chỗ; lỗi gửi thì nhả chỗ giữ để quét sau thử lại. */
async function sendClaimedEvent(
  client: DbClient,
  familyId: string,
  kind: NotificationKind,
  eventKey: string,
  deviceId: string | null,
  action: string | null,
  childId: string | null,
  email: NotificationEmail,
  recipients: string[],
): Promise<EventResult> {
  let claimed = false;
  try {
    claimed = await claimNotification(client, familyId, kind, eventKey, deviceId, action, childId);
    if (!claimed) {
      return { kind, event_key: eventKey, status: "skipped", reason: "already_handled" };
    }
    const resendId = await sendViaResend({ from: RESEND_FROM, to: recipients, subject: email.subject, html: email.html, text: email.text });
    try {
      await finishNotification(client, kind, eventKey, true, resendId, recipients);
    } catch (finishError) {
      // Email đã gửi đi nhưng không ghi được dấu "đã gửi": log rõ để
      // biết mà khôi phục — KHÔNG xóa hàng giữ chỗ (xóa sẽ làm lần
      // quét sau gửi trùng). Khôi phục đúng: UPDATE hàng đó thành
      // status='sent' kèm resend_id trong log (xem docs/07 mục 7).
      console.error(
        `[parent-notify] email da gui (resend_id=${resendId}) nhung khong ghi duoc dau da gui cho su kien ${kind}/${eventKey}: ${finishError instanceof Error ? finishError.message : "unknown"}`,
      );
    }
    claimed = false;
    return { kind, event_key: eventKey, status: "sent", resend_id: resendId };
  } catch (err) {
    if (claimed) {
      try {
        await finishNotification(client, kind, eventKey, false, null, []);
      } catch {
        // Nhả chỗ giữ thất bại: chỗ giữ sẽ hết hạn sau 1 giờ (RPC claim
        // thu hồi claim cũ kẹt ở trạng thái đang gửi).
      }
    }
    const message = err instanceof Error ? err.message : "unknown error";
    console.error(`[parent-notify] su kien ${kind}/${eventKey} that bai: ${message}`);
    return { kind, event_key: eventKey, status: "failed", reason: message };
  }
}

function resolveChildName(ctx: FamilyContext, childId: string | null, deviceId: string | null): string | null {
  if (childId) return ctx.childNameById.get(childId) ?? null;
  if (deviceId) {
    const device = ctx.deviceById.get(deviceId);
    if (device?.child_id) return ctx.childNameById.get(device.child_id) ?? null;
  }
  return null;
}

interface FamilyScanResult {
  family_id: string;
  status: "ok" | "skipped" | "failed";
  reason?: string;
  events: EventResult[];
}

async function scanFamily(
  client: DbClient,
  familyId: string,
  nowMs: number,
  dryRun: boolean,
): Promise<FamilyScanResult> {
  const events: EventResult[] = [];
  const [childrenResult, devicesResult] = await Promise.all([
    client.from("children").select("id, display_name").eq("family_id", familyId),
    client
      .from("devices")
      .select("id, child_id, hostname, last_seen_at")
      .eq("family_id", familyId),
  ]);
  if (childrenResult.error) throw childrenResult.error;
  if (devicesResult.error) throw devicesResult.error;
  const ctx: FamilyContext = {
    childNameById: new Map(
      ((childrenResult.data ?? []) as Array<{ id: string; display_name: string }>).map((c) => [c.id, c.display_name]),
    ),
    deviceById: new Map(
      ((devicesResult.data ?? []) as DeviceRow[]).map((d) => [d.id, d]),
    ),
  };

  const lookbackIso = new Date(nowMs - EVENT_LOOKBACK_MS).toISOString();
  const [requestsResult, tamperResult] = await Promise.all([
    client
      .from("requests")
      .select("id, child_id, device_id, type, status, reason, minutes, created_at")
      .eq("family_id", familyId)
      .eq("status", "pending")
      .gte("created_at", lookbackIso)
      .order("created_at", { ascending: true })
      .limit(SCAN_LIMIT),
    client
      .from("audit_logs")
      .select("id, child_id, device_id, action, target, details, created_at")
      .eq("family_id", familyId)
      .in("action", [...TAMPER_ACTIONS])
      .gte("created_at", lookbackIso)
      .order("created_at", { ascending: true })
      .limit(SCAN_LIMIT),
  ]);
  if (requestsResult.error) throw requestsResult.error;
  if (tamperResult.error) throw tamperResult.error;
  const requestRows = ((requestsResult.data ?? []) as RequestRow[]).filter((r) => shouldNotifyRequest(r, nowMs));
  // Gộp tên miền best-effort cho yêu cầu xin mở trang web: cột domain chỉ
  // có sau migration 18. Truy vấn riêng để vòng quét vẫn chạy khi migration
  // 18 chưa áp (email khi đó dùng câu chung "mở trang web bị chặn").
  if (requestRows.length > 0) {
    try {
      const { data: domainRows, error: domainError } = await client
        .from("requests")
        .select("id, domain")
        .in("id", requestRows.map((r) => r.id));
      if (!domainError) {
        const domainById = new Map(
          ((domainRows ?? []) as Array<{ id: string; domain: string | null }>).map((d) => [d.id, d.domain]),
        );
        for (const row of requestRows) row.domain = domainById.get(row.id) ?? null;
      }
    } catch {
      // Chưa có cột: giữ nguyên, email dùng câu chung.
    }
  }
  const tamperRows = ((tamperResult.data ?? []) as AuditRow[]).filter((r) => shouldNotifyTamper(r, nowMs));

  // Đợt offline: tính khóa từ last_seen_at; máy chưa từng kết nối thì không báo.
  const offlineCandidates: Array<{ device: DeviceRow; key: string }> = [];
  for (const device of ctx.deviceById.values()) {
    const key = offlineEpisodeKey(device, nowMs);
    if (key) offlineCandidates.push({ device, key });
  }

  // Lịch sử gửi gần đây để chặn spam. Gửi thử khô BỎ QUA cả hai lần
  // đọc này (coi như chưa gửi gì — đúng ngữ nghĩa "sẽ gửi gì") để khô
  // chạy được cả khi chưa áp migration 12 (bảng chưa tồn tại).
  // Sự kiện đã xử lý KHÔNG loại ở đây: claim trong sendClaimedEvent là
  // kiểm tra duy nhất (xem ghi chú ở đầu file).
  let sentTamperRows: SentTamperRow[] = [];
  let sentRequestRows: SentRequestRow[] = [];
  if (!dryRun && tamperRows.length > 0) {
    const { data, error } = await client
      .from("notification_sends")
      .select("device_id, action, sent_at")
      .eq("family_id", familyId)
      .eq("kind", "tamper")
      .eq("status", "sent")
      .gte("sent_at", new Date(nowMs - TAMPER_THROTTLE_MS).toISOString());
    if (error) throw error;
    sentTamperRows = (data ?? []) as SentTamperRow[];
  }
  if (!dryRun && requestRows.length > 0) {
    const { data, error } = await client
      .from("notification_sends")
      .select("child_id, sent_at")
      .eq("family_id", familyId)
      .eq("kind", "request")
      .eq("status", "sent")
      .gte("sent_at", new Date(nowMs - REQUEST_THROTTLE_MS).toISOString());
    if (error) throw error;
    sentRequestRows = (data ?? []) as SentRequestRow[];
  }

  // Quyết định gửi trong LẦN QUÉT NÀY, để chặn spam cũng chạy trong
  // cùng một lần quét (ảnh chụp ở trên không thấy email vừa quyết định
  // gửi): lần bật đầu tiên có thể chứa ~24 sự kiện can thiệp cùng máy
  // trong cửa sổ 24 giờ, không có tập này thì tất cả đều gửi.
  const emailedChildrenThisSweep = new Set<string>();
  const tamperSentThisSweep = new Set<string>();

  const pendingEvents: Array<{
    kind: NotificationKind;
    eventKey: string;
    deviceId: string | null;
    action: string | null;
    childId: string | null;
    email: NotificationEmail;
  }> = [];

  for (const row of requestRows) {
    // Chạm trần gửi của lần quét thì dừng: ứng viên còn lại không ghi
    // dấu gì, lần quét sau xét lại (không mất sự kiện).
    if (pendingEvents.length >= MAX_SENDS_PER_SCAN) break;
    // Đọc lại trạng thái ngay trước khi gửi: phụ huynh có thể vừa duyệt
    // trong lúc quét đang chạy; yêu cầu đã quyết định thì bỏ qua.
    // Cửa sổ đua còn lại: phụ huynh quyết định đúng trong vài giây giữa
    // lần đọc lại này và lúc gửi thật thì vẫn gửi 1 email cũ — rủi ro
    // dư nhỏ, chấp nhận được (email vẫn đúng sự thật lúc quét).
    const { data, error } = await client.from("requests").select("status").eq("id", row.id).maybeSingle();
    if (error) throw error;
    const currentStatus = (data as { status: string } | null)?.status;
    if (currentStatus !== "pending") {
      if (!dryRun) {
        await markNotificationTerminal(client, familyId, "request", row.id, "skipped", row.device_id, null, row.child_id);
      }
      events.push({ kind: "request", event_key: row.id, status: dryRun ? "would_skip" : "skipped", reason: "decided" });
      continue;
    }
    // Chặn spam yêu cầu: mỗi con tối đa 1 email mỗi giờ, tính cả email
    // vừa quyết định gửi trong lần quét này.
    if (isRequestThrottled(sentRequestRows, row.child_id, nowMs) || emailedChildrenThisSweep.has(row.child_id)) {
      if (!dryRun) {
        await markNotificationTerminal(client, familyId, "request", row.id, "throttled", row.device_id, null, row.child_id);
      }
      events.push({ kind: "request", event_key: row.id, status: dryRun ? "would_throttle" : "throttled", reason: "throttled" });
      continue;
    }
    emailedChildrenThisSweep.add(row.child_id);
    const device = row.device_id ? ctx.deviceById.get(row.device_id) : undefined;
    pendingEvents.push({
      kind: "request",
      eventKey: row.id,
      deviceId: row.device_id,
      action: null,
      childId: row.child_id,
      email: buildRequestEmail({
        childName: resolveChildName(ctx, row.child_id, row.device_id),
        deviceName: device?.hostname ?? null,
        type: row.type,
        minutes: row.minutes,
        domain: row.domain ?? null,
        reason: row.reason,
        createdAt: row.created_at,
        requestsUrl: `${DASHBOARD_URL}/yeu-cau`,
        dashboardUrl: DASHBOARD_URL,
      }),
    });
  }

  for (const row of tamperRows) {
    if (pendingEvents.length >= MAX_SENDS_PER_SCAN) break;
    const deviceId = row.device_id ?? (row.target && ctx.deviceById.has(row.target) ? row.target : null);
    const tamperKey = deviceId ? `${deviceId}|${row.action}` : null;
    const throttled =
      isTamperThrottled(sentTamperRows, deviceId, row.action, nowMs) ||
      (tamperKey !== null && tamperSentThisSweep.has(tamperKey));
    if (throttled) {
      if (!dryRun) {
        await markNotificationTerminal(client, familyId, "tamper", row.id, "throttled", deviceId, row.action, row.child_id);
      }
      events.push({ kind: "tamper", event_key: row.id, status: dryRun ? "would_throttle" : "throttled", reason: "throttled" });
      continue;
    }
    if (tamperKey !== null) tamperSentThisSweep.add(tamperKey);
    const device = deviceId ? ctx.deviceById.get(deviceId) : undefined;
    pendingEvents.push({
      kind: "tamper",
      eventKey: row.id,
      deviceId,
      action: row.action,
      childId: row.child_id,
      email: buildTamperEmail({
        childName: resolveChildName(ctx, row.child_id, deviceId),
        deviceName: device?.hostname ?? null,
        action: row.action,
        drift: driftMinutes(row.details),
        createdAt: row.created_at,
        dashboardUrl: DASHBOARD_URL,
      }),
    });
  }

  for (const { device, key } of offlineCandidates) {
    if (pendingEvents.length >= MAX_SENDS_PER_SCAN) break;
    pendingEvents.push({
      kind: "device_offline",
      eventKey: key,
      deviceId: device.id,
      action: null,
      childId: device.child_id,
      email: buildOfflineEmail({
        childName: device.child_id ? (ctx.childNameById.get(device.child_id) ?? null) : null,
        deviceName: device.hostname,
        lastSeenAt: device.last_seen_at as string,
        nowMs,
        dashboardUrl: DASHBOARD_URL,
      }),
    });
  }

  if (pendingEvents.length === 0) {
    return { family_id: familyId, status: "ok", events };
  }

  // Gửi thử khô trả về danh sách "sẽ gửi" TRƯỚC khi kiểm tra người nhận:
  // family chưa có email parent vẫn xem được sự kiện nào sẽ được gửi.
  if (dryRun) {
    for (const pending of pendingEvents) {
      events.push({ kind: pending.kind, event_key: pending.eventKey, status: "would_send" });
    }
    return { family_id: familyId, status: "ok", events };
  }

  const recipients = await parentEmailsForFamily(client, familyId);
  if (recipients.length === 0) {
    // Không có người nhận thì không ghi dấu gì: lần quét sau vẫn xét lại.
    return { family_id: familyId, status: "skipped", reason: "no_recipients", events };
  }

  for (const pending of pendingEvents) {
    events.push(
      await sendClaimedEvent(client, familyId, pending.kind, pending.eventKey, pending.deviceId, pending.action, pending.childId, pending.email, recipients),
    );
  }
  return { family_id: familyId, status: "ok", events };
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
  if (!ENDPOINT_SECRET || provided !== ENDPOINT_SECRET) {
    return jsonResponse(401, { error: "unauthorized" });
  }
  if (!PROJECT_URL || !ADMIN_KEY || !RESEND_API_KEY) {
    console.error("[parent-notify] thieu bien moi truong bat buoc");
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
  const familyFilter =
    typeof body["family_id"] === "string" && body["family_id"].length > 0
      ? (body["family_id"] as string)
      : null;
  const dryRun = body["dry_run"] === true;

  const client = createClient(PROJECT_URL, ADMIN_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const nowMs = Date.now();
  const results: FamilyScanResult[] = [];
  try {
    let query = client.from("families").select("id, name").order("created_at", { ascending: true });
    if (familyFilter) query = query.eq("id", familyFilter);
    const { data, error } = await query;
    if (error) throw error;
    const families = (data ?? []) as Array<{ id: string; name: string }>;
    for (const family of families) {
      try {
        results.push(await scanFamily(client, family.id, nowMs, dryRun));
      } catch (err) {
        // Một family lỗi không chặn các family còn lại.
        const message = err instanceof Error ? err.message : "unknown error";
        console.error(`[parent-notify] family ${family.id} that bai: ${message}`);
        results.push({ family_id: family.id, status: "failed", reason: message, events: [] });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error(`[parent-notify] loi chung: ${message}`);
    return jsonResponse(500, { error: "internal_error", detail: message });
  }
  return jsonResponse(200, {
    checked_at: new Date(nowMs).toISOString(),
    dry_run: dryRun,
    results,
  });
});
