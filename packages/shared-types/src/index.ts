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
  /** Lần cuối Agent thấy extension trình duyệt (thêm ở migration 5). */
  last_extension_seen_at: string | null;
  /** Ảnh chụp thi hành mới nhất do Agent ghi (thêm ở migration 6). */
  enforcement_json?: EnforcementSnapshot | Record<string, unknown> | string | null;
  /** Thời điểm Agent ghi enforcement_json gần nhất (thêm ở migration 6). */
  enforcement_updated_at?: string | null;
  /** Hash PBKDF2 của mã PIN thoát Tray (thêm ở migration 7). */
  exit_pin_hash?: string | null;
  status: DeviceStatus;
  created_at: string;
}

/**
 * Ảnh chụp quyết định thi hành của Agent trên máy con (devices.
 * enforcement_json, migration 6). Agent ghi sau mỗi lần đánh giá rules;
 * Dashboard chỉ đọc để hiển thị. `reasons` là các chuỗi loại rule
 * (vd "daily_limit", "website"); `ruleIds` là id các rule đang thi hành.
 */
export type EnforcementDecision = "allow" | "warn" | "lock";
export type EnforcementLockedBy = "forced" | "rule" | "override" | "break";

export interface EnforcementSnapshot {
  v: number;
  at: string;
  decision: EnforcementDecision;
  lockedBy: EnforcementLockedBy | null;
  reasons: string[];
  ruleIds: string[];
  appBlocks: string[];
  domainRulesActive: boolean;
  focusActive: boolean;
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

export type RuleType = "daily_limit" | "bedtime" | "time_window" | "app" | "website";

/** Hành động của rule chặn app/website. MVP chủ yếu dùng `"block"`. */
export type RuleAction = "block" | "allow";

/**
 * Một khoảng giờ trong ngày, dạng "HH:MM" (24h), theo GIỜ ĐỊA PHƯƠNG của
 * máy con. `start < end` là khoảng trong ngày; riêng bedtime cho phép
 * `end <= start` nghĩa là khoảng chạy qua đêm sang ngày hôm sau.
 */
export interface TimeRange {
  start: string;
  end: string;
}

/**
 * Giới hạn số phút dùng máy mỗi ngày. Ngày vắng mặt = không giới hạn ngày đó.
 * Agent vẫn chấp nhận hình dạng cũ `{"minutes_per_day": N}` /
 * `{"daily_minutes": N}` (áp cho mọi ngày) để tương thích rule đã lưu trước
 * Sprint 2; Dashboard chỉ ghi hình dạng mới này.
 */
export interface DailyLimitRuleConfig {
  minutesByWeekday: Partial<Record<Weekday, number>>;
}

/**
 * Giờ đi ngủ / giờ cấm theo từng thứ. Ngày vắng mặt = không khóa ngày đó.
 * Khoảng qua đêm (`end <= start`, vd 21:00–07:00) khóa từ `start` hôm nay
 * tới `end` hôm sau. Agent vẫn chấp nhận hình dạng cũ `{"start","end"}`
 * (áp cho mọi ngày) để tương thích rule đã lưu trước Sprint 2.
 */
export interface BedtimeRuleConfig {
  bedtimeByWeekday: Partial<Record<Weekday, TimeRange>>;
}

/**
 * Khung giờ ĐƯỢC dùng máy theo từng thứ (giờ địa phương của máy con).
 * Ngoài mọi khung giờ của ngày hôm đó, máy bị khóa. Ngày vắng mặt hoặc
 * mảng rỗng = KHÔNG được dùng máy ngày đó. Mỗi khoảng phải có
 * `start < end` (không qua đêm — muốn khóa qua đêm thì dùng `bedtime`).
 * Khi có nhiều rule time_window, các khung giờ được hợp (union) lại.
 */
export interface TimeWindowRuleConfig {
  windowsByWeekday: Partial<Record<Weekday, TimeRange[]>>;
}

/**
 * Quy tắc ứng dụng (Sprint 2 đợt 3): một dòng rule type='app' mang đúng
 * 1 chế độ (`mode`). Ứng dụng nhận dạng bằng tên file .exe (`exe`, đã
 * trim, không chứa dấu phân tách đường dẫn hay ký tự cấm của tên file
 * Windows); `name` chỉ để hiển thị, trống thì lấy theo tên exe.
 */
export type AppMode =
  | "app_time_limit"
  | "app_block"
  | "app_block_by_time"
  | "app_allowlist"
  | "app_allowlist_by_time"
  | "forced_break";

/** Một ứng dụng, nhận dạng bằng tên file .exe; `name` chỉ để hiển thị. */
export interface AppEntry {
  exe: string;
  name: string;
}

/** Một ứng dụng kèm giới hạn số phút mỗi ngày (1..1440). */
export interface AppTimeLimitEntry {
  exe: string;
  name: string;
  minutesPerDay: number;
}

/** Giới hạn số phút mỗi ngày cho từng ứng dụng trong danh sách. */
export interface AppTimeLimitConfig {
  mode: "app_time_limit";
  apps: AppTimeLimitEntry[];
}

/**
 * Chặn các ứng dụng trong danh sách NGOÀI các khung giờ theo thứ (khung
 * giờ = thời gian được phép dùng, giờ địa phương của máy con). Ngày nào
 * không có khung giờ nào thì các ứng dụng trên bị chặn cả ngày.
 */
export interface AppBlockByTimeConfig {
  mode: "app_block_by_time";
  apps: AppEntry[];
  windowsByWeekday: Partial<Record<Weekday, TimeRange[]>>;
}

/** Chặn các ứng dụng trong danh sách mọi lúc (cho đến khi tắt quy tắc). */
export interface AppBlockConfig {
  mode: "app_block";
  apps: AppEntry[];
}

/**
 * Chỉ cho phép các ứng dụng trong danh sách; mọi ứng dụng khác đều bị
 * đóng (trừ các tiến trình hệ thống trong denylist của Agent).
 */
export interface AppAllowlistConfig {
  mode: "app_allowlist";
  apps: AppEntry[];
}

/**
 * Chỉ cho phép các ứng dụng trong danh sách, chỉ trong các khung giờ theo
 * thứ (khung giờ = thời gian danh sách cho phép có hiệu lực, giờ địa
 * phương của máy con). Ngoài khung giờ, quy tắc không đóng ứng dụng nào.
 * Ngày nào không có khung giờ nào thì ngày đó không giới hạn.
 */
export interface AppAllowlistByTimeConfig {
  mode: "app_allowlist_by_time";
  apps: AppEntry[];
  windowsByWeekday: Partial<Record<Weekday, TimeRange[]>>;
}

/**
 * Dùng máy liên tục đủ `workMinutes` (15..180) thì khóa máy trong
 * `breakMinutes` (5..60).
 */
export interface ForcedBreakConfig {
  mode: "forced_break";
  workMinutes: number;
  breakMinutes: number;
}

export type AppRuleConfig =
  | AppTimeLimitConfig
  | AppBlockConfig
  | AppBlockByTimeConfig
  | AppAllowlistConfig
  | AppAllowlistByTimeConfig
  | ForcedBreakConfig;

/**
 * Quy tắc website (Sprint 2 đợt 2): một dòng rule type='website' mang đúng
 * 1 chế độ (`mode`). `domains` lưu tên miền (kể cả tên miền con);
 * `urlPatterns` (đợt 4, tùy chọn) lưu các mục "host/path" chỉ khớp link
 * bắt đầu bằng phần đó (vd "bing.com/videos"). Hình dạng cũ
 * `{"domain","action"}` (1 domain) vẫn được Dashboard đọc như
 * `block_domains` (hoặc `allowlist` khi action là "allow") để tương thích
 * dữ liệu cũ; Dashboard chỉ ghi hình dạng mới này.
 */
export type WebsiteMode =
  | "block_domains"
  | "block_domains_by_time"
  | "allowlist"
  | "allowlist_by_time"
  | "domain_time_limit"
  | "safe_search"
  | "focus";

/** Chặn các domain trong danh sách (kể cả tên miền con). */
export interface BlockDomainsConfig {
  mode: "block_domains";
  domains: string[];
  /** Đường dẫn chặn theo tiền tố (đợt 4): "host/path", vd "bing.com/videos". Vắng mặt = không có quy tắc đường dẫn. */
  urlPatterns?: string[];
}

/** Chặn các domain trong danh sách, chỉ trong các khung giờ theo thứ (giờ địa phương của máy con). */
export interface BlockDomainsByTimeConfig {
  mode: "block_domains_by_time";
  domains: string[];
  /** Đường dẫn chặn theo tiền tố (đợt 4), cùng khung giờ với `domains`. Vắng mặt = không có quy tắc đường dẫn. */
  urlPatterns?: string[];
  windowsByWeekday: Partial<Record<Weekday, TimeRange[]>>;
}

/** Chỉ cho phép các domain trong danh sách; mọi website khác đều bị chặn. */
export interface AllowlistConfig {
  mode: "allowlist";
  domains: string[];
  /** Đường dẫn cho phép theo tiền tố (đợt 4): "host/path". Vắng mặt = không có quy tắc đường dẫn. */
  urlPatterns?: string[];
}

/**
 * Chỉ cho phép các domain trong danh sách, chỉ trong các khung giờ theo
 * thứ (khung giờ = thời gian danh sách cho phép có hiệu lực, giờ địa
 * phương của máy con). Ngoài khung giờ, quy tắc không giới hạn website
 * nào. Ngày nào không có khung giờ nào thì ngày đó không giới hạn.
 * Extension thi hành qua `allowlistByTime` trong domain_rules.json.
 */
export interface AllowlistByTimeConfig {
  mode: "allowlist_by_time";
  domains: string[];
  /** Đường dẫn cho phép theo tiền tố (đợt 4), cùng khung giờ với `domains`. Vắng mặt = không có quy tắc đường dẫn. */
  urlPatterns?: string[];
  windowsByWeekday: Partial<Record<Weekday, TimeRange[]>>;
}

/** Tổng số phút mỗi ngày cho tất cả các domain trong danh sách cộng lại. */
export interface DomainTimeLimitConfig {
  mode: "domain_time_limit";
  domains: string[];
  /** Đường dẫn giới hạn theo tiền tố (đợt 4): "host/path". Vắng mặt = không có quy tắc đường dẫn. */
  urlPatterns?: string[];
  minutes_per_day: number;
}

/** Ép SafeSearch / chế độ hạn chế của YouTube. Cả hai đều mặc định bật khi rule tồn tại. */
export interface SafeSearchConfig {
  mode: "safe_search";
  searchProviders: boolean;
  youtubeRestricted: boolean;
}

/**
 * Giờ học tập trung: trong các khung giờ theo thứ, chỉ các website trong
 * `allowedDomains` (do extension thi hành) và các ứng dụng trong
 * `allowedApps` (do Agent đóng các ứng dụng còn lại) mới mở được.
 * Thứ tự ưu tiên: chặn tạm thời thắng danh sách cho phép của focus;
 * cho phép tạm thời KHÔNG mở được website ngoài danh sách trong giờ tập trung.
 */
export interface FocusConfig {
  mode: "focus";
  windowsByWeekday: Partial<Record<Weekday, TimeRange[]>>;
  allowedApps: AppEntry[];
  allowedDomains: string[];
}

export type WebsiteRuleConfig =
  | BlockDomainsConfig
  | BlockDomainsByTimeConfig
  | AllowlistConfig
  | AllowlistByTimeConfig
  | DomainTimeLimitConfig
  | SafeSearchConfig
  | FocusConfig;

/** Ánh xạ loại rule -> hình dạng `config` tương ứng. */
export interface RuleConfigMap {
  daily_limit: DailyLimitRuleConfig;
  bedtime: BedtimeRuleConfig;
  time_window: TimeWindowRuleConfig;
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
  /** Tên do phụ huynh đặt (thêm ở migration 9, cột rules.name, nullable). Vắng mặt/NULL = chưa đặt tên, hiển thị tên tự sinh từ loại rule. */
  name?: string | null;
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
  /** Số giây đã xem domain trong lần thăm này (thêm ở migration 4). */
  duration_sec: number;
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
  /** Số phút con xin thêm (thêm ở migration 7). */
  minutes?: number | null;
  /** Máy đã gửi yêu cầu (thêm ở migration 7). */
  device_id?: string | null;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

export type CommandType = "lock_now" | "unlock" | "refresh_rules" | "update" | "temporary_override";
export type CommandStatus = "pending" | "sent" | "done" | "failed";

/**
 * Hành động của lệnh `temporary_override` (ghi đè tạm thời, tự hết hạn):
 * - `bonus_minutes`: cộng thêm `minutes` vào hạn mức hôm nay.
 * - `lock`: khóa máy tới `expires_at`.
 * - `unlock`: tạm ngưng các quy tắc giờ giấc tới `expires_at`.
 * - `allow_domain` / `block_domain`: cho phép/chặn `domains` tới `expires_at`.
 * - `allow_app` / `block_app`: cho phép/chặn `apps` (tên exe) tới `expires_at`.
 * - `cancel`: hủy ghi đè đang hiệu lực (không cần `minutes`/`expires_at`).
 * Agent lưu ghi đè đang hiệu lực vào SQLite local và kiểm tra `expires_at`
 * ở mỗi lần đánh giá rules, nên ghi đè vẫn hết hạn đúng giờ kể cả khi
 * Service khởi động lại. Ghi đè mới nhất sẽ thay thế ghi đè trước đó.
 */
export type TemporaryOverrideAction =
  | "bonus_minutes"
  | "lock"
  | "unlock"
  | "allow_domain"
  | "block_domain"
  | "block_app"
  | "allow_app"
  | "cancel";

/**
 * Payload JSONB của lệnh (cột `payload`). Các trường đã biết:
 * - `message`: thông báo hiển thị cho con (vd: kèm lệnh `lock_now`).
 * - `target_version`: phiên bản Agent đích (lệnh `update`).
 * - `action` / `minutes` / `expires_at`: lệnh `temporary_override` (xem
 *   `TemporaryOverrideAction`); `expires_at` là ISO 8601 có múi giờ.
 * - `domains`: lệnh `temporary_override` với action `allow_domain` /
 *   `block_domain` (ghi đè website tạm thời, Sprint 2 đợt 2).
 * - `apps`: lệnh `temporary_override` với action `allow_app` / `block_app`
 *   (ghi đè ứng dụng tạm thời: danh sách tên file .exe).
 * Kiểu để mở (index signature) để Dashboard/Agent bổ sung trường mà không vỡ
 * contract; siết chặt dần khi 2 bên chốt hình dạng payload từng loại lệnh.
 */
export interface CommandPayload {
  message?: string;
  target_version?: string;
  /** Độ trễ trước khi khóa (phút, 0–5) cho lệnh lock_now; > 0 thì Agent gửi cảnh báo nhỏ trước, hết trễ mới khóa. */
  delay_minutes?: number;
  action?: TemporaryOverrideAction;
  minutes?: number;
  expires_at?: string;
  domains?: string[];
  apps?: string[];
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
  // Các cột dưới đây do migration 5 thêm; chưa áp dụng migration 5 thì không có.
  child_id?: string | null;
  device_id?: string | null;
  details?: Record<string, unknown> | null;
}
