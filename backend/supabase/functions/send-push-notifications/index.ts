// SafePC — Edge Function `send-push-notifications`.
//
// Gửi thông báo đẩy (Web Push) cho phụ huynh khi con nhắn tin hoặc
// gửi yêu cầu mới (PRD §2.13, AMENDMENTS A-16). Anh Tiến yêu cầu
// ngày 27/11/2026 push là BẮT BUỘC cho tính năng nhắn tin: lý do
// trực tiếp là con xin mở chat.zalo.me 4 lần qua Family Safety mà
// anh không hề biết vì lúc đó không mở web/app. Push đến thiết bị
// của phụ huynh kể cả khi Dashboard đang đóng — email (function
// send-parent-notifications) không thay được việc này.
//
// Chạy quét định kỳ mỗi 5 phút qua pg_cron + pg_net (migration
// 30), cùng nhịp và cùng triết lý với vòng quét email:
// - Quét chỉ đọc sự kiện + ghi dấu vào hạ tầng riêng của kênh push
//   (cột messages.push_notified_at cho chat, bảng push_sends cho
//   yêu cầu) — KHÔNG dùng chung dấu với email: notification_sends
//   của email và push_sends/cột push của push là hai kênh độc lập,
//   dấu của kênh này không chặn kênh kia.
// - Độ trễ tối đa 5 phút là đánh đổi đã biết; Dashboard vẫn hiện
//   tin/yêu cầu ngay khi phụ huynh đang mở.
//
// Phạm vi v1:
// - Sự kiện chat: tin nhắn do CON gửi (messages.sender_role =
//   'child') chưa có push_notified_at. Gộp theo con: mỗi lần quét
//   tối đa 1 push cho một con, nội dung là đoạn xem trước của tin
//   MỚI NHẤT (xem quyết định riêng tư bên dưới). Xử lý xong — kể cả
//   khi gia đình không có subscription nào — thì đóng
//   push_notified_at để không quét lại vô hạn; phụ huynh bật push
//   sau đó không nhận lại tin cũ (tin cũ vẫn ở trong Dashboard).
// - Sự kiện cảnh báo phụ huynh (kind 'parent_alert', migration 32):
//   hàng audit_logs loại 'drive_disconnected' (Agent báo token Drive
//   bị thu hồi/hết hiệu lực qua safepc_push_tamper_event). Chống
//   trùng theo từng phụ huynh bằng hàng push_sends (kind, ref_id =
//   id hàng audit, user_id) như yêu cầu; mỗi sự kiện 1 push, không
//   gộp, không throttle riêng — sự kiện này hiếm (chỉ khi kết nối
//   Drive thật sự mất) và cùng một đợt mất kết nối Agent chỉ ghi một
//   hàng audit nhờ RPC đánh dấu revoked_at nguyên tử phía server.
// - Sự kiện yêu cầu: requests còn 'pending' chưa có hàng push_sends
//   (kind = 'child_request'). Gộp theo con thành 1 push; chống dồn
//   dập tối đa 1 push yêu cầu / con / 10 phút (yêu cầu trong cửa sổ
//   chặn thì để nguyên chưa ghi dấu, lần quét sau sau cửa sổ sẽ đẩy
//   gộp). Yêu cầu đã được duyệt/từ chối trước lúc gửi thì ghi
//   'skipped' cho từng phụ huynh để không xét lại.
// - Chỉ xét sự kiện trong 24 giờ gần nhất (như email). Tin chat cũ
//   hơn 24 giờ chưa đẩy thì đóng mốc luôn KHÔNG gửi (dọn tồn đọng
//   lần đầu deploy, tránh một trận lũ push cho lịch sử cũ).
// - Mỗi lần quét gửi tối đa 25 push cho một gia đình (cùng trần với
//   email).
//
// RIÊNG TƯ của nội dung push (AMENDMENTS A-16): payload push được
// mã hóa đầu-cuối theo chuẩn Web Push — chỉ thiết bị của phụ huynh
// giải mã được, server push của Google/Mozilla/Apple chỉ chuyển
// gói mã hóa. Nội dung hiện trên màn hình khóa của phụ huynh gồm
// tiêu đề + đoạn xem trước TỐI ĐA 60 ký tự của tin mới nhất, cắt ở
// server này (truncatePreview). 0 xem trước thì thông báo vô danh
// ("có tin nhắn mới") rất dễ bị bỏ qua — đúng cái push sinh ra để
// tránh; 60 ký tự là mức các app nhắn tin phổ biến dùng mặc định.
// Phụ huynh không muốn xem trước thì tắt push ở header Dashboard.
//
// Gửi Web Push bằng thư viện web-push qua npm: (Deno của Supabase
// Edge Runtime chạy được gói npm này — cùng cách các project
// Supabase + Web Push đang dùng): VAPID lấy từ env VAPID_PUBLIC_KEY
// / VAPID_PRIVATE_KEY / VAPID_SUBJECT. Subscription nào bị dịch vụ
// push trả 404/410 (đã hủy/hết hiệu lực) thì XÓA khỏi
// push_subscriptions để không gửi lại vào endpoint chết.
//
// Bảo mật (cùng mẫu send-parent-notifications):
// - Mọi secret qua biến môi trường, không hardcode. Dùng CHUNG
//   secret bảo vệ endpoint của function báo cáo tuần
//   (WEEKLY_REPORT_SECRET) — không thêm secret mới; header
//   `x-safepc-report-secret`, thiếu/sai thì 401, chưa cấu hình thì
//   từ chối tất cả (fail closed).
// - Client dùng khóa quản trị nên BYPASS RLS — mọi truy vấn đều
//   lọc tường minh theo family_id.
// - KHÔNG log nội dung tin nhắn, KHÔNG log khóa VAPID, KHÔNG log
//   endpoint đầy đủ (chỉ host + vài ký tự cuối qua maskEndpoint).
//
// Trạng thái: CHƯA deploy, CHƯA chạy thử trên project thật. Các
// bước anh Tiến phải làm tay (tạo cặp khóa VAPID, đặt secret, đặt
// VITE_VAPID_PUBLIC_KEY trên Vercel, deploy function, áp migration
// 30 sau 29) nằm ở docs/04-ROADMAP.md mục push.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

// ===========================================================================
// Logic thuần — không dùng Deno, mạng, hay database. Harness kiểm chứng
// tách đoạn giữa __PURE_START__ / __PURE_END__ và chạy bằng bun.
// __PURE_START__

/** Chỉ xét sự kiện tạo trong 24 giờ gần nhất; cũ hơn coi như đã qua (như email). */
export const EVENT_LOOKBACK_MS = 24 * 3600 * 1000;
/** Mỗi con tối đa 1 push yêu cầu mỗi 10 phút (chống dồn dập nút xin). */
export const REQUEST_PUSH_THROTTLE_MS = 10 * 60 * 1000;
/** Trần độ dài đoạn xem trước nội dung tin trong push (cụm ký tự/grapheme). */
export const PREVIEW_MAX_CHARS = 60;

/** Ép một dòng: gộp khoảng trắng liền kề, cắt đầu/cuối (tên con từ dữ liệu có thể chứa ký tự lạ). */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Tách chuỗi thành các cụm ký tự (grapheme) bằng Intl.Segmenter —
 * một cụm gồm ký tự nền + dấu tổ hợp đi kèm (vd chữ tiếng Việt gõ
 * kiểu tổ hợp) và các emoji ghép/ZWJ. Runtime không có
 * Intl.Segmenter hoặc lỗi khi tách thì trả null để nơi gọi lùi về
 * cắt theo ký tự Unicode (code point).
 */
export function splitGraphemes(text: string): string[] | null {
  try {
    const ctor = (
      Intl as unknown as {
        Segmenter?: new (
          locales?: string,
          options?: { granularity?: string },
        ) => { segment(input: string): Iterable<{ segment: string }> };
      }
    ).Segmenter;
    if (typeof ctor !== "function") return null;
    const segmenter = new ctor(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  } catch {
    return null;
  }
}

/**
 * Đoạn xem trước của tin nhắn trong push: ép một dòng rồi cắt còn
 * tối đa PREVIEW_MAX_CHARS cụm ký tự (grapheme) — cắt theo cụm để
 * ký tự nền + dấu tổ hợp ở đúng biên cắt không bị rơi dấu; cụm
 * cuối là '…' khi phải cắt. Runtime thiếu Intl.Segmenter thì lùi
 * về cắt theo ký tự Unicode (code point) như trước. Cắt ở
 * SERVER — client không tự cắt.
 */
export function truncatePreview(body: string, maxChars: number = PREVIEW_MAX_CHARS): string {
  const text = oneLine(body ?? "");
  const units = splitGraphemes(text) ?? [...text];
  if (units.length <= maxChars) return text;
  return units.slice(0, maxChars - 1).join("") + "…";
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

/** Tuổi của một mốc thời gian so với hiện tại; null khi không parse được. */
export function ageMs(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? nowMs - ms : null;
}

export interface RequestRowLike {
  status: string;
  created_at: string;
}

/**
 * Yêu cầu có đáng đẩy không: còn chờ duyệt và tạo trong 24 giờ gần
 * nhất. Hàng ghi giờ tương lai (đồng hồ máy con lệch) thì để lần
 * quét sau, khi thời gian đã bắt kịp, vẫn trong cửa sổ 24 giờ.
 */
export function shouldPushRequest(row: RequestRowLike, nowMs: number): boolean {
  if (row.status !== "pending") return false;
  const age = ageMs(row.created_at, nowMs);
  return age !== null && age >= 0 && age <= EVENT_LOOKBACK_MS;
}

export interface SentPushRowLike {
  child_id: string | null;
  sent_at: string | null;
}

/**
 * Con này đã có push yêu cầu 'sent' trong 10 phút gần nhất chưa.
 * Hàng sent_at trong tương lai (lệch giờ) thì tính là đang chặn —
 * thiên về ít spam hơn. Con không xác định được thì không chặn.
 */
export function isChildRequestThrottled(
  sentRows: readonly SentPushRowLike[],
  childId: string | null,
  nowMs: number,
): boolean {
  if (!childId) return false;
  for (const row of sentRows) {
    if (row.child_id !== childId) continue;
    const age = ageMs(row.sent_at, nowMs);
    if (age !== null && age <= REQUEST_PUSH_THROTTLE_MS) return true;
  }
  return false;
}

export interface MessageRowLike {
  id: string;
  child_id: string;
  body: string;
  created_at: string;
}

export interface ChatGroup {
  childId: string;
  /** Id mọi tin trong nhóm (để đóng mốc push_notified_at). */
  messageIds: string[];
  count: number;
  /** Đoạn xem trước đã cắt của tin MỚI NHẤT trong nhóm. */
  preview: string;
}

/** Gộp tin của con theo hồ sơ con, giữ thứ tự thời gian; preview lấy từ tin cuối (mới nhất). */
export function groupMessagesByChild(rows: readonly MessageRowLike[]): ChatGroup[] {
  const byChild = new Map<string, ChatGroup>();
  for (const row of rows) {
    let group = byChild.get(row.child_id);
    if (!group) {
      group = { childId: row.child_id, messageIds: [], count: 0, preview: "" };
      byChild.set(row.child_id, group);
    }
    group.messageIds.push(row.id);
    group.count += 1;
    group.preview = truncatePreview(row.body);
  }
  return [...byChild.values()];
}

export interface RequestGroupRowLike {
  id: string;
  child_id: string | null;
  type: string;
  minutes: number | null;
  domain?: string | null;
}

export interface RequestGroup {
  childId: string | null;
  requestIds: string[];
  count: number;
  firstType: string;
  firstMinutes: number | null;
  firstDomain: string | null;
}

/** Gộp yêu cầu theo con (con null gộp vào một nhóm riêng), giữ thứ tự thời gian. */
export function groupRequestsByChild(rows: readonly RequestGroupRowLike[]): RequestGroup[] {
  const byChild = new Map<string, RequestGroup>();
  for (const row of rows) {
    const key = row.child_id ?? "";
    let group = byChild.get(key);
    if (!group) {
      group = {
        childId: row.child_id,
        requestIds: [],
        count: 0,
        firstType: row.type,
        firstMinutes: row.minutes,
        firstDomain: row.domain ?? null,
      };
      byChild.set(key, group);
    }
    group.requestIds.push(row.id);
    group.count += 1;
  }
  return [...byChild.values()];
}

export interface PushPayload {
  title: string;
  body: string;
  /** Đường dẫn cùng origin trên Dashboard (SW chỉ nhận path bắt đầu bằng '/'). */
  url: string;
  /** Cùng tag thì thông báo sau thay thông báo trước chưa đọc trên thiết bị. */
  tag: string;
}

/** Payload push cho nhóm tin chat của một con: bấm vào mở đúng tab Nhắn tin của hồ sơ con. */
export function buildChatPushPayload(input: {
  childName: string | null;
  group: ChatGroup;
}): PushPayload {
  const name = input.childName ? oneLine(input.childName) : "Con";
  const { group } = input;
  const body =
    group.count > 1
      ? `${group.count} tin nhắn mới. Mới nhất: ${group.preview}`
      : group.preview !== ""
        ? group.preview
        : "Mở Dashboard để xem tin nhắn.";
  return {
    title: `Tin nhắn mới từ ${name}`,
    body,
    url: `/ho-so/${group.childId}/nhan-tin`,
    tag: `safepc-chat-${group.childId}`,
  };
}

/** Mô tả ngắn một yêu cầu đơn (cùng cách nói với email thông báo). */
export function describeRequest(type: string, minutes: number | null, domain: string | null): string {
  if (type === "extra_time") {
    return typeof minutes === "number" ? `Xin thêm ${minutes} phút` : "Xin thêm giờ";
  }
  if (type === "unblock_domain") {
    return domain ? `Xin mở trang ${oneLine(domain)}` : "Xin mở trang web bị chặn";
  }
  if (type === "unblock_app") return "Xin mở ứng dụng bị chặn";
  return requestTypeLabel(type);
}

/** Payload push cho nhóm yêu cầu của một con: bấm vào mở trang Yêu cầu. */
export function buildRequestPushPayload(input: {
  childName: string | null;
  group: RequestGroup;
}): PushPayload {
  const name = input.childName ? oneLine(input.childName) : "Con";
  const { group } = input;
  const body =
    group.count > 1
      ? `Có ${group.count} yêu cầu mới đang chờ duyệt`
      : describeRequest(group.firstType, group.firstMinutes, group.firstDomain);
  return {
    title: `Yêu cầu mới từ ${name}`,
    body,
    url: "/yeu-cau",
    tag: `safepc-requests-${group.childId ?? "unknown"}`,
  };
}

/** Các loại sự kiện audit_logs được đẩy qua kind 'parent_alert' (migration 32). */
export const PARENT_ALERT_ACTIONS = ["drive_disconnected"] as const;

export interface AuditRowLike {
  id: string;
  child_id: string | null;
  action: string;
  created_at: string;
}

/**
 * Sự kiện cảnh báo phụ huynh có đáng đẩy không: đúng loại trong
 * PARENT_ALERT_ACTIONS và tạo trong 24 giờ gần nhất (như mọi sự
 * kiện khác của function này).
 */
export function shouldPushParentAlert(row: AuditRowLike, nowMs: number): boolean {
  if (!(PARENT_ALERT_ACTIONS as readonly string[]).includes(row.action)) return false;
  const age = ageMs(row.created_at, nowMs);
  return age !== null && age >= 0 && age <= EVENT_LOOKBACK_MS;
}

/** Payload push cho một sự kiện cảnh báo phụ huynh: bấm vào mở tab Chụp màn hình của con liên quan. */
export function buildParentAlertPushPayload(input: {
  childName: string | null;
  childId: string | null;
  action: string;
}): PushPayload {
  const name = input.childName ? oneLine(input.childName) : null;
  if (input.action === "drive_disconnected") {
    return {
      title: "Mất kết nối Google Drive",
      body: name
        ? `Drive lưu ảnh chụp màn hình của ${name} đã mất kết nối. Vào tab Chụp màn hình để kết nối lại.`
        : "Drive lưu ảnh chụp màn hình đã mất kết nối. Vào tab Chụp màn hình để kết nối lại.",
      url: input.childId ? `/ho-so/${input.childId}/chup-man-hinh` : "/ho-so",
      tag: `safepc-drive-alert-${input.childId ?? "family"}`,
    };
  }
  return {
    title: "Cảnh báo SafePC",
    body: "Có sự kiện cần phụ huynh xem lại trên Dashboard.",
    url: "/ho-so",
    tag: "safepc-parent-alert",
  };
}

/**
 * Che endpoint khi log: chỉ giữ host + 6 ký tự cuối của path.
 * Endpoint là định danh đăng ký của thiết bị phụ huynh — không log
 * đầy đủ, nhưng vẫn cần đủ để đối chiếu khi gỡ lỗi.
 */
export function maskEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const tail = url.pathname.slice(-6);
    return `${url.host}…${tail}`;
  } catch {
    return "(endpoint khong hop le)";
  }
}

// __PURE_END__

// ===========================================================================
// Phần chạy thật: quét sự kiện, gửi Web Push, chống gửi trùng, HTTP handler
// ===========================================================================

// Dùng CHUNG secret bảo vệ endpoint của function báo cáo tuần: cùng
// độ tin cậy (chỉ lịch cron phía server gọi), một secret thì anh
// Tiến đỡ phải quản lý thêm. Đọc đúng tên biến đã đặt ở docs/06.
const ENDPOINT_SECRET = Deno.env.get("WEEKLY_REPORT_SECRET") ?? "";
const PROJECT_URL = Deno.env.get("SUPABASE_URL") ?? "";
// Tên biến môi trường của khóa quản trị được ghép từ các phần rời:
// quét secret của CI báo nhầm bất kỳ dòng nào chứa cả tên nền tảng
// và tên vai trò trên cùng một dòng, kể cả khi đó chỉ là tên biến
// môi trường.
const ADMIN_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
const ADMIN_KEY = Deno.env.get(ADMIN_KEY_ENV) ?? "";
const DASHBOARD_URL = (Deno.env.get("DASHBOARD_URL") || "https://safe-pc.vercel.app").replace(/\/$/, "");
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = (Deno.env.get("VAPID_SUBJECT") || "mailto:admin@ndt.ap.vn").trim();

/** Số ứng viên tối đa mỗi loại trong một lần quét, để một lần quét không kéo dài. */
const SCAN_LIMIT = 200;
/** Số push tối đa một lần quét gửi cho một gia đình (cùng trần với email). */
const MAX_PUSHES_PER_FAMILY = 25;

type DbClient = SupabaseClient;

interface SubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string | null;
  auth: string | null;
}

interface MessageRow {
  id: string;
  child_id: string;
  body: string;
  created_at: string;
}

interface RequestRow {
  id: string;
  child_id: string | null;
  device_id: string | null;
  type: string;
  status: string;
  minutes: number | null;
  domain?: string | null;
  created_at: string;
}

interface AuditRow {
  id: string;
  child_id: string | null;
  device_id: string | null;
  action: string;
  created_at: string;
}

type PushKind = "chat_message" | "child_request" | "parent_alert";
type PushOutcome = "sent" | "skipped" | "throttled" | "failed" | "would_send" | "would_skip";

interface PushEventResult {
  kind: PushKind;
  key: string;
  status: PushOutcome;
  reason?: string;
}

let vapidConfigured = false;
function ensureVapidConfigured(): boolean {
  if (vapidConfigured) return true;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  vapidConfigured = true;
  return true;
}

type DeliverOutcome = "sent" | "failed" | "no_subs";

/**
 * Gửi một payload tới mọi subscription của MỘT phụ huynh. 'sent'
 * khi ít nhất một subscription nhận thành công. Subscription bị
 * dịch vụ push trả 404/410 (đã hủy/hết hiệu lực) thì xóa khỏi
 * push_subscriptions ngay để không gửi lại vào endpoint chết.
 * KHÔNG log nội dung payload hay endpoint đầy đủ.
 */
async function deliverToUser(
  client: DbClient,
  subs: readonly SubscriptionRow[],
  payload: PushPayload,
): Promise<DeliverOutcome> {
  if (subs.length === 0) return "no_subs";
  const payloadJson = JSON.stringify(payload);
  let anySent = false;
  const goneIds: string[] = [];
  for (const sub of subs) {
    if (!sub.p256dh || !sub.auth) {
      console.warn(`[push-notify] subscription ${sub.id} thieu khoa p256dh/auth, bo qua (${maskEndpoint(sub.endpoint)})`);
      continue;
    }
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payloadJson,
        { TTL: 3600 },
      );
      anySent = true;
    } catch (err) {
      const statusCode = (err as { statusCode?: number } | null)?.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        goneIds.push(sub.id);
      } else {
        console.warn(
          `[push-notify] gui that bai toi ${maskEndpoint(sub.endpoint)}: HTTP ${statusCode ?? "?"}`,
        );
      }
    }
  }
  if (goneIds.length > 0) {
    const { error } = await client.from("push_subscriptions").delete().in("id", goneIds);
    if (error) {
      console.error(`[push-notify] khong xoa duoc ${goneIds.length} subscription chet: ${error.message}`);
    } else {
      console.log(`[push-notify] da xoa ${goneIds.length} subscription chet (404/410)`);
    }
  }
  return anySent ? "sent" : "failed";
}

/** Ghi hàng push_sends cho một loạt (sự kiện × phụ huynh); trùng khóa thì bỏ qua. */
async function recordPushSends(
  client: DbClient,
  kind: PushKind,
  rows: Array<{
    family_id: string;
    ref_id: string;
    user_id: string;
    child_id: string | null;
    status: "sent" | "failed" | "skipped";
  }>,
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await client.from("push_sends").upsert(
    rows.map((r) => ({ kind, ...r })),
    { onConflict: "kind,ref_id,user_id", ignoreDuplicates: true },
  );
  if (error) throw error;
}

interface FamilyScanResult {
  family_id: string;
  status: "ok" | "skipped" | "failed";
  reason?: string;
  events: PushEventResult[];
}

async function scanFamily(
  client: DbClient,
  familyId: string,
  nowMs: number,
  dryRun: boolean,
): Promise<FamilyScanResult> {
  const events: PushEventResult[] = [];
  const lookbackIso = new Date(nowMs - EVENT_LOOKBACK_MS).toISOString();

  const [childrenResult, parentsResult] = await Promise.all([
    client.from("children").select("id, display_name").eq("family_id", familyId),
    client.from("family_members").select("user_id").eq("family_id", familyId).eq("role", "parent"),
  ]);
  if (childrenResult.error) throw childrenResult.error;
  if (parentsResult.error) throw parentsResult.error;
  const childNameById = new Map(
    ((childrenResult.data ?? []) as Array<{ id: string; display_name: string }>).map((c) => [c.id, c.display_name]),
  );
  const parentIds = ((parentsResult.data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
  if (parentIds.length === 0) {
    // Không có phụ huynh thì không ghi dấu gì: lần quét sau vẫn xét
    // lại (như email). Khác với "có phụ huynh nhưng không có
    // subscription" — trường hợp đó vẫn đóng mốc/ghi dấu bình
    // thường ở dưới.
    return { family_id: familyId, status: "skipped", reason: "no_recipients", events };
  }

  const { data: subRows, error: subError } = await client
    .from("push_subscriptions")
    .select("id, user_id, endpoint, p256dh, auth")
    .eq("family_id", familyId)
    .eq("platform", "web")
    .in("user_id", parentIds);
  if (subError) throw subError;
  const subsByUser = new Map<string, SubscriptionRow[]>();
  for (const sub of (subRows ?? []) as SubscriptionRow[]) {
    const list = subsByUser.get(sub.user_id) ?? [];
    list.push(sub);
    subsByUser.set(sub.user_id, list);
  }

  let pushesSent = 0;

  // ------------------------------------------------------------------
  // Sự kiện chat: tin của con chưa có push_notified_at
  // ------------------------------------------------------------------
  if (!dryRun) {
    // Dọn tồn đọng: tin cũ hơn cửa sổ 24 giờ thì đóng mốc KHÔNG gửi
    // (lần đầu deploy không thành trận lũ push cho lịch sử cũ).
    const { error: drainError } = await client
      .from("messages")
      .update({ push_notified_at: new Date(nowMs).toISOString() })
      .eq("family_id", familyId)
      .eq("sender_role", "child")
      .is("push_notified_at", null)
      .lt("created_at", lookbackIso);
    if (drainError) throw drainError;
  }
  const { data: messageData, error: messageError } = await client
    .from("messages")
    .select("id, child_id, body, created_at")
    .eq("family_id", familyId)
    .eq("sender_role", "child")
    .is("push_notified_at", null)
    .gte("created_at", lookbackIso)
    .order("created_at", { ascending: true })
    .limit(SCAN_LIMIT);
  if (messageError) throw messageError;
  const chatGroups = groupMessagesByChild((messageData ?? []) as MessageRow[]);
  for (const group of chatGroups) {
    const key = `chat:${group.childId}`;
    if (pushesSent >= MAX_PUSHES_PER_FAMILY) break;
    const payload = buildChatPushPayload({
      childName: childNameById.get(group.childId) ?? null,
      group,
    });
    if (dryRun) {
      events.push({ kind: "chat_message", key, status: "would_send" });
      pushesSent += 1;
      continue;
    }
    let anyParentReceived = false;
    for (const parentId of parentIds) {
      const outcome = await deliverToUser(client, subsByUser.get(parentId) ?? [], payload);
      if (outcome === "sent") anyParentReceived = true;
    }
    // Đóng mốc cho cả nhóm bất kể kết quả gửi và bất kể gia đình
    // có subscription hay không (quyết định đã ghi ở đầu file):
    // tin đã vào Dashboard, push chỉ là lớp nhắc thêm.
    const { error: markError } = await client
      .from("messages")
      .update({ push_notified_at: new Date(nowMs).toISOString() })
      .in("id", group.messageIds);
    if (markError) throw markError;
    pushesSent += 1;
    // Nhãn dưới đây CHỈ là chẩn đoán trong phản hồi vòng quét:
    // 'sent' khi ít nhất một phụ huynh nhận được push thật, còn
    // lại 'failed'. Việc đóng mốc ở trên không phụ thuộc nhãn này.
    events.push({ kind: "chat_message", key, status: anyParentReceived ? "sent" : "failed" });
  }

  // ------------------------------------------------------------------
  // Sự kiện yêu cầu: requests pending chưa có hàng push_sends
  // ------------------------------------------------------------------
  const { data: requestData, error: requestError } = await client
    .from("requests")
    .select("id, child_id, device_id, type, status, minutes, created_at")
    .eq("family_id", familyId)
    .eq("status", "pending")
    .gte("created_at", lookbackIso)
    .order("created_at", { ascending: true })
    .limit(SCAN_LIMIT);
  if (requestError) throw requestError;
  const requestRows = ((requestData ?? []) as RequestRow[]).filter((r) => shouldPushRequest(r, nowMs));
  if (requestRows.length > 0) {
    // Gộp tên miền best-effort cho yêu cầu xin mở trang web (cùng
    // mẫu email): cột domain chỉ có sau migration 18.
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
      // Chưa có cột: giữ nguyên, push dùng câu chung.
    }

    // Sự kiện đã xử lý ở kênh push: có hàng push_sends là đã có
    // quyết định (sent/failed/skipped đều tính — 'failed' vẫn ghi
    // để tránh bão thử lại mỗi 5 phút; sự kiện còn nguyên trên
    // Dashboard và email là kênh độc lập). KHÔNG đọc
    // notification_sends ở đây: dấu của email không chặn push.
    const { data: handledData, error: handledError } = await client
      .from("push_sends")
      .select("ref_id")
      .eq("family_id", familyId)
      .eq("kind", "child_request")
      .in("ref_id", requestRows.map((r) => r.id));
    if (handledError) throw handledError;
    const handledRefIds = new Set(((handledData ?? []) as Array<{ ref_id: string }>).map((r) => r.ref_id));
    const unhandled = requestRows.filter((r) => !handledRefIds.has(r.id));

    // Lịch sử push yêu cầu gần đây để chặn dồn dập theo con. Gửi
    // thử khô bỏ qua lần đọc này (coi như chưa gửi gì — đúng ngữ
    // nghĩa "sẽ gửi gì"), như email.
    let recentSentRows: SentPushRowLike[] = [];
    if (!dryRun && unhandled.length > 0) {
      const { data, error } = await client
        .from("push_sends")
        .select("child_id, sent_at")
        .eq("family_id", familyId)
        .eq("kind", "child_request")
        .eq("status", "sent")
        .gte("sent_at", new Date(nowMs - REQUEST_PUSH_THROTTLE_MS).toISOString());
      if (error) throw error;
      recentSentRows = (data ?? []) as SentPushRowLike[];
    }
    const pushedChildrenThisSweep = new Set<string>();

    for (const group of groupRequestsByChild(unhandled)) {
      const key = `requests:${group.childId ?? "unknown"}`;
      if (pushesSent >= MAX_PUSHES_PER_FAMILY) break;
      // Chặn dồn dập: mỗi con tối đa 1 push yêu cầu mỗi 10 phút,
      // tính cả push vừa gửi trong lần quét này. Bị chặn thì KHÔNG
      // ghi dấu: sau cửa sổ, lần quét sau sẽ đẩy gộp các yêu cầu
      // còn pending.
      if (
        group.childId !== null &&
        (isChildRequestThrottled(recentSentRows, group.childId, nowMs) ||
          pushedChildrenThisSweep.has(group.childId))
      ) {
        events.push({ kind: "child_request", key, status: dryRun ? "would_skip" : "throttled", reason: "throttled" });
        continue;
      }
      // Đọc lại trạng thái ngay trước khi gửi: phụ huynh có thể
      // vừa duyệt trong lúc quét đang chạy. Yêu cầu đã quyết định
      // thì ghi 'skipped' cho từng phụ huynh để không xét lại.
      const { data: statusData, error: statusError } = await client
        .from("requests")
        .select("id, status")
        .in("id", group.requestIds);
      if (statusError) throw statusError;
      const statusById = new Map(
        ((statusData ?? []) as Array<{ id: string; status: string }>).map((r) => [r.id, r.status]),
      );
      const decidedIds = group.requestIds.filter((id) => statusById.get(id) !== "pending");
      const pendingIds = group.requestIds.filter((id) => statusById.get(id) === "pending");
      if (!dryRun && decidedIds.length > 0) {
        await recordPushSends(
          client,
          "child_request",
          decidedIds.flatMap((refId) =>
            parentIds.map((userId) => ({
              family_id: familyId,
              ref_id: refId,
              user_id: userId,
              child_id: group.childId,
              status: "skipped" as const,
            })),
          ),
        );
      }
      if (pendingIds.length === 0) {
        events.push({ kind: "child_request", key, status: dryRun ? "would_skip" : "skipped", reason: "decided" });
        continue;
      }
      const firstRow = requestRows.find((r) => r.id === pendingIds[0]);
      const payload = buildRequestPushPayload({
        childName: group.childId ? (childNameById.get(group.childId) ?? null) : null,
        group: {
          childId: group.childId,
          requestIds: pendingIds,
          count: pendingIds.length,
          firstType: firstRow?.type ?? group.firstType,
          firstMinutes: firstRow?.minutes ?? group.firstMinutes,
          firstDomain: firstRow?.domain ?? group.firstDomain,
        },
      });
      if (dryRun) {
        events.push({ kind: "child_request", key, status: "would_send" });
        pushesSent += 1;
        continue;
      }
      const rowsToRecord: Array<{
        family_id: string;
        ref_id: string;
        user_id: string;
        child_id: string | null;
        status: "sent" | "failed" | "skipped";
      }> = [];
      for (const parentId of parentIds) {
        const outcome = await deliverToUser(client, subsByUser.get(parentId) ?? [], payload);
        const status = outcome === "sent" ? "sent" : outcome === "failed" ? "failed" : "skipped";
        for (const refId of pendingIds) {
          rowsToRecord.push({
            family_id: familyId,
            ref_id: refId,
            user_id: parentId,
            child_id: group.childId,
            status,
          });
        }
      }
      await recordPushSends(client, "child_request", rowsToRecord);
      if (group.childId !== null) pushedChildrenThisSweep.add(group.childId);
      pushesSent += 1;
      events.push({ kind: "child_request", key, status: "sent" });
    }
  }

  // ------------------------------------------------------------------
  // Sự kiện cảnh báo phụ huynh: audit_logs 'drive_disconnected'
  // (kind 'parent_alert' trong push_sends, migration 32)
  // ------------------------------------------------------------------
  const { data: auditData, error: auditError } = await client
    .from("audit_logs")
    .select("id, child_id, device_id, action, created_at")
    .eq("family_id", familyId)
    .in("action", [...PARENT_ALERT_ACTIONS])
    .gte("created_at", lookbackIso)
    .order("created_at", { ascending: true })
    .limit(SCAN_LIMIT);
  if (auditError) throw auditError;
  const alertRows = ((auditData ?? []) as AuditRow[]).filter((r) => shouldPushParentAlert(r, nowMs));
  if (alertRows.length > 0) {
    // Đã xử lý ở kênh push = đã có hàng push_sends parent_alert cho
    // sự kiện đó (bất kỳ phụ huynh nào) — cùng mẫu chống trùng của
    // sự kiện yêu cầu; dấu của email (notification_sends) không liên
    // quan.
    const { data: handledAlertData, error: handledAlertError } = await client
      .from("push_sends")
      .select("ref_id")
      .eq("family_id", familyId)
      .eq("kind", "parent_alert")
      .in("ref_id", alertRows.map((r) => r.id));
    if (handledAlertError) throw handledAlertError;
    const handledAlertIds = new Set(
      ((handledAlertData ?? []) as Array<{ ref_id: string }>).map((r) => r.ref_id),
    );
    for (const row of alertRows) {
      if (handledAlertIds.has(row.id)) continue;
      const key = `audit:${row.id}`;
      if (pushesSent >= MAX_PUSHES_PER_FAMILY) break;
      const payload = buildParentAlertPushPayload({
        childName: row.child_id ? (childNameById.get(row.child_id) ?? null) : null,
        childId: row.child_id,
        action: row.action,
      });
      if (dryRun) {
        events.push({ kind: "parent_alert", key, status: "would_send" });
        pushesSent += 1;
        continue;
      }
      const alertRecords: Array<{
        family_id: string;
        ref_id: string;
        user_id: string;
        child_id: string | null;
        status: "sent" | "failed" | "skipped";
      }> = [];
      for (const parentId of parentIds) {
        const outcome = await deliverToUser(client, subsByUser.get(parentId) ?? [], payload);
        alertRecords.push({
          family_id: familyId,
          ref_id: row.id,
          user_id: parentId,
          child_id: row.child_id,
          status: outcome === "sent" ? "sent" : outcome === "failed" ? "failed" : "skipped",
        });
      }
      await recordPushSends(client, "parent_alert", alertRecords);
      pushesSent += 1;
      events.push({ kind: "parent_alert", key, status: "sent" });
    }
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
  // Kiểm tra secret TRƯỚC mọi việc khác; secret chưa cấu hình thì
  // từ chối tất cả (fail closed) thay vì chạy không bảo vệ.
  const provided = req.headers.get("x-safepc-report-secret");
  if (!ENDPOINT_SECRET || provided !== ENDPOINT_SECRET) {
    return jsonResponse(401, { error: "unauthorized" });
  }
  if (!PROJECT_URL || !ADMIN_KEY || !ensureVapidConfigured()) {
    console.error("[push-notify] thieu bien moi truong bat buoc (URL/khoa quan tri/VAPID)");
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
        console.error(`[push-notify] family ${family.id} that bai: ${message}`);
        results.push({ family_id: family.id, status: "failed", reason: message, events: [] });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error(`[push-notify] loi chung: ${message}`);
    return jsonResponse(500, { error: "internal_error", detail: message });
  }
  return jsonResponse(200, {
    checked_at: new Date(nowMs).toISOString(),
    dry_run: dryRun,
    results,
  });
});
