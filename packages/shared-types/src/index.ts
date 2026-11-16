// SafePC — Shared Types (chỉ kiểu dữ liệu, không có code runtime).
//
// Nguồn sự thật duy nhất: backend/supabase/migrations/20261116102900_init_safepc.sql
// (bản đã rà soát Sprint 1, ngày 16/11/2026). Tên bảng, tên cột và các giá trị
// enum trong file này phải khớp ĐÚNG migration. Khi migration thay đổi, cập
// nhật file này trong cùng thay đổi đó.
//
// Quy ước:
// - UUID và timestamptz đều là `string` (thời gian ở dạng ISO 8601).
// - Cột nullable trong DB có kiểu `... | null`; cột NOT NULL không có `null`.
// - Các kiểu dưới đây mô tả DÒNG DỮ LIỆU đọc từ DB (đủ mọi cột). Khi cần kiểu
//   dữ liệu để insert, dùng `Omit<..., "id" | "created_at">` ở phía consumer.

// ---------------------------------------------------------------------------
// Kiểu dùng chung
// ---------------------------------------------------------------------------

/** Tên các bảng trong schema public (theo migration). */
export type TableName =
  | "families"
  | "family_members"
  | "children"
  | "devices"
  | "device_tokens"
  | "pairing_codes"
  | "rules"
  | "app_usage"
  | "web_visits"
  | "requests"
  | "commands"
  | "audit_logs";

/** Thứ trong tuần theo quy ước của `Date.getDay()`: 0 = Chủ nhật, 6 = Thứ 7. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

// ---------------------------------------------------------------------------
// families / family_members
// ---------------------------------------------------------------------------

export interface Family {
  id: string;
  owner_id: string;
  name: string;
  created_at: string;
}

export type FamilyMemberRole = "parent" | "child";

export interface FamilyMember {
  family_id: string;
  user_id: string;
  role: FamilyMemberRole;
  created_at: string;
}

// ---------------------------------------------------------------------------
// children / devices
// ---------------------------------------------------------------------------

export interface Child {
  id: string;
  family_id: string;
  display_name: string;
  birth_year: number | null;
  avatar_url: string | null;
  created_at: string;
}

export type DeviceStatus = "online" | "offline" | "locked";

export interface Device {
  id: string;
  family_id: string;
  child_id: string | null;
  hostname: string;
  os_version: string | null;
  agent_version: string | null;
  last_seen_at: string | null;
  status: DeviceStatus;
  created_at: string;
}

/**
 * Chỉ lưu HASH của token (docs/03-SECURITY.md mục 2). Token thô không bao
 * giờ xuất hiện trong kiểu này — nó chỉ được trả đúng 1 lần khi pairing.
 */
export interface DeviceToken {
  device_id: string;
  token_hash: string;
  created_at: string;
  revoked_at: string | null;
}

/** Mã pairing 6 số: chỉ lưu hash, hết hạn 10 phút, dùng 1 lần, tối đa 5 lần thử. */
export interface PairingCode {
  id: string;
  family_id: string;
  child_id: string | null;
  code_hash: string;
  attempts: number;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// rules — config JSONB theo từng loại (cột `config`)
// ---------------------------------------------------------------------------

export type RuleType = "daily_limit" | "bedtime" | "app" | "website";

/** Hành động của rule chặn app/website. MVP chủ yếu dùng `"block"`. */
export type RuleAction = "block" | "allow";

/** Giới hạn số phút dùng máy mỗi ngày. Ngày vắng mặt = không giới hạn ngày đó. */
export interface DailyLimitRuleConfig {
  minutesByWeekday: Partial<Record<Weekday, number>>;
}

/** Giờ đi ngủ: khóa máy từ `start` đến `end`, dạng "HH:MM" (24h). */
export interface BedtimeRuleConfig {
  start: string;
  end: string;
}

/** Chặn/cho phép 1 app. `exePathHash` là SHA-256 của đường dẫn exe (tránh lộ username Windows). */
export interface AppRuleConfig {
  appName: string;
  exePathHash?: string;
  action: RuleAction;
}

/** Chặn/cho phép 1 domain. Chỉ lưu domain, không lưu path/query. */
export interface WebsiteRuleConfig {
  domain: string;
  action: RuleAction;
}

/** Ánh xạ loại rule -> hình dạng `config` tương ứng. */
export interface RuleConfigMap {
  daily_limit: DailyLimitRuleConfig;
  bedtime: BedtimeRuleConfig;
  app: AppRuleConfig;
  website: WebsiteRuleConfig;
}

/** Hợp của mọi hình dạng `config` (dùng khi loại rule chưa xác định). */
export type RuleConfig = RuleConfigMap[RuleType];

/**
 * Rule gắn với đúng hình dạng `config` của loại đó:
 * `Rule<"daily_limit">["config"]` là `DailyLimitRuleConfig`.
 * `Rule` (không tham số) chấp nhận mọi loại với `config: RuleConfig`.
 */
export interface Rule<T extends RuleType = RuleType> {
  id: string;
  family_id: string;
  child_id: string;
  type: T;
  config: RuleConfigMap[T];
  enabled: boolean;
  created_at: string;
}

// ---------------------------------------------------------------------------
// app_usage / web_visits
// ---------------------------------------------------------------------------

export interface AppUsage {
  id: string;
  family_id: string;
  device_id: string;
  child_id: string;
  app_name: string;
  /** Hash đường dẫn exe, tránh lộ username Windows. */
  exe_path_hash: string | null;
  started_at: string;
  duration_sec: number;
  created_at: string;
}

export interface WebVisit {
  id: string;
  family_id: string;
  device_id: string;
  child_id: string;
  /** Chỉ domain (vd: "youtube.com"), đã cắt bỏ path/query. */
  domain: string;
  visited_at: string;
  blocked: boolean;
  created_at: string;
}

// ---------------------------------------------------------------------------
// requests — đặt tên RequestItem để tránh đụng `Request` của DOM
// ---------------------------------------------------------------------------

export type RequestType = "extra_time" | "unblock_app";
export type RequestStatus = "pending" | "approved" | "denied";

export interface RequestItem {
  id: string;
  family_id: string;
  child_id: string;
  type: RequestType;
  status: RequestStatus;
  reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

export type CommandType = "lock_now" | "unlock" | "refresh_rules" | "update";
export type CommandStatus = "pending" | "sent" | "done" | "failed";

/**
 * Payload JSONB của lệnh (cột `payload`). Các trường đã biết:
 * - `message`: thông báo hiển thị cho con (vd: kèm lệnh `lock_now`).
 * - `target_version`: phiên bản Agent đích (lệnh `update`).
 * Kiểu để mở (index signature) để Dashboard/Agent bổ sung trường mà không vỡ
 * contract; siết chặt dần khi 2 bên chốt hình dạng payload từng loại lệnh.
 */
export interface CommandPayload {
  message?: string;
  target_version?: string;
  [key: string]: unknown;
}

export interface Command {
  id: string;
  family_id: string;
  device_id: string;
  type: CommandType;
  payload: CommandPayload;
  status: CommandStatus;
  created_at: string;
}

// ---------------------------------------------------------------------------
// audit_logs
// ---------------------------------------------------------------------------

export interface AuditLog {
  id: string;
  family_id: string;
  actor: string | null;
  action: string;
  target: string | null;
  /** Chỉ lưu hash IP, không lưu IP thô. */
  ip_hash: string | null;
  created_at: string;
}
