// Kiểu dữ liệu khớp với migration:
// backend/supabase/migrations/20261116102900_init_safepc.sql
// (tên bảng, tên cột và giá trị enum phải giữ đúng như schema này.)

export type DeviceStatus = 'online' | 'offline' | 'locked'
export type RuleType = 'daily_limit' | 'bedtime' | 'time_window' | 'app' | 'website'
export type RequestType = 'extra_time' | 'unblock_app' | 'unblock_domain'
export type RequestStatus = 'pending' | 'approved' | 'denied'
export type CommandType = 'lock_now' | 'unlock' | 'refresh_rules' | 'update' | 'temporary_override'
export type CommandStatus = 'pending' | 'sent' | 'done' | 'failed'
/** Hành động của lệnh temporary_override; allow_domain/block_domain mang thêm `domains`, block_app/allow_app mang thêm `apps` (danh sách tên exe) trong payload. */
export type TemporaryOverrideAction = 'bonus_minutes' | 'lock' | 'unlock' | 'allow_domain' | 'block_domain' | 'block_app' | 'allow_app' | 'cancel'

export interface Family {
  id: string
  owner_id: string
  name: string
  created_at: string
}

/**
 * Lời mời phụ huynh thứ hai (bảng family_invites, migration 14).
 * Không có trường token_hash: Dashboard không bao giờ SELECT cột hash
 * khi liệt kê lời mời — token thô chỉ tồn tại trong link lúc tạo.
 */
export interface FamilyInvite {
  id: string
  family_id: string
  invited_email: string
  invited_by: string
  expires_at: string
  accepted_at: string | null
  accepted_by: string | null
  revoked_at: string | null
  created_at: string
}

export interface Child {
  id: string
  family_id: string
  display_name: string
  birth_year: number | null
  avatar_url: string | null
  created_at: string
}

export interface Device {
  id: string
  family_id: string
  child_id: string | null
  hostname: string
  os_version: string | null
  agent_version: string | null
  last_seen_at: string | null
  // Lần cuối Agent thấy extension trình duyệt (thêm ở migration 5).
  last_extension_seen_at: string | null
  // Ảnh chụp thi hành mới nhất do Agent ghi (thêm ở migration 6, cột
  // enforcement_json / enforcement_updated_at). Truy vấn best-effort
  // riêng — chưa áp dụng migration 6 thì hai trường này vắng mặt.
  enforcement_json?: EnforcementSnapshot | Record<string, unknown> | string | null
  enforcement_updated_at?: string | null
  // Hash PBKDF2 của mã PIN thoát Tray (thêm ở migration 7). Dashboard chỉ
  // kiểm tra có/không để hiển thị trạng thái, không bao giờ in hash ra.
  exit_pin_hash?: string | null
  status: DeviceStatus
  created_at: string
}

/**
 * Ảnh chụp quyết định thi hành của Agent trên máy con (devices.
 * enforcement_json, migration 6). Agent ghi sau mỗi lần đánh giá rules;
 * Dashboard chỉ đọc để hiển thị. `reasons` là các chuỗi loại rule
 * (vd 'daily_limit', 'website'); `ruleIds` là id các rule đang thi hành.
 */
export type EnforcementDecision = 'allow' | 'warn' | 'lock'
export type EnforcementLockedBy = 'forced' | 'rule' | 'override' | 'break'

export interface EnforcementSnapshot {
  v: number
  at: string
  decision: EnforcementDecision
  lockedBy: EnforcementLockedBy | null
  reasons: string[]
  ruleIds: string[]
  appBlocks: string[]
  domainRulesActive: boolean
  focusActive: boolean
}

export interface Rule {
  id: string
  family_id: string
  child_id: string
  type: RuleType
  config: Record<string, unknown>
  // Tên do phụ huynh đặt (thêm ở migration 9). Truy vấn best-effort
  // riêng — chưa áp dụng migration 9 thì trường này vắng mặt, hiển thị
  // tên tự sinh từ loại quy tắc.
  name?: string | null
  enabled: boolean
  created_at: string
}

export interface AppUsage {
  id: string
  family_id: string
  device_id: string
  child_id: string
  app_name: string
  exe_path_hash: string | null
  started_at: string
  duration_sec: number
  created_at: string
}

// Dòng web_visits theo migration 1 + cột duration_sec của migration 4.
// Chỉ lưu domain (không path/query). Cột `blocked` là true với lượt web
// bị chặn (extension 0.1.7 báo cáo qua RPC, migration 10), kèm
// duration_sec = 0; lượt xem thường có blocked = false.
export interface WebVisit {
  id: string
  family_id: string
  device_id: string
  child_id: string
  domain: string
  visited_at: string
  blocked: boolean
  duration_sec: number
  created_at: string
}

export interface AppRequest {
  id: string
  family_id: string
  child_id: string
  type: RequestType
  status: RequestStatus
  reason: string | null
  decided_by: string | null
  decided_at: string | null
  created_at: string
  // Số phút con xin thêm + máy đã gửi (thêm ở migration 7). Vắng mặt với
  // yêu cầu cũ hoặc khi migration 7 chưa áp dụng.
  minutes?: number | null
  device_id?: string | null
  // Tên miền con xin mở (thêm ở migration 18, chỉ với loại
  // unblock_domain). CHỈ tên miền — không path/query/URL. Vắng mặt với
  // yêu cầu loại khác hoặc khi migration 18 chưa áp dụng.
  domain?: string | null
}

export interface Command {
  id: string
  family_id: string
  device_id: string
  type: CommandType
  payload: Record<string, unknown>
  status: CommandStatus
  created_at: string
}

/** Trạng thái một lần thưởng giờ (bảng time_bank_grants, migration 13). */
export type TimeBankGrantStatus = 'active' | 'voided'

/**
 * Một lần phụ huynh thưởng giờ cho con (bảng time_bank_grants, migration
 * 13). Phút thưởng cộng vào mức trần giờ hôm nay, hiệu lực tới
 * expires_at (hết ngày); hết hạn thì không tính vào tổng nữa nhưng hàng
 * lịch sử vẫn giữ. Chỉ ghi qua RPC safepc_grant_time_bank /
 * safepc_void_time_bank_grant — Dashboard chỉ đọc bảng này.
 */
export interface TimeBankGrant {
  id: string
  family_id: string
  child_id: string
  minutes: number
  reason: string | null
  granted_by: string
  status: TimeBankGrantStatus
  expires_at: string
  created_at: string
}

// Dòng audit_logs theo migration 1: loại sự kiện nằm ở cột `action`
// (vd 'clock_drift'), `target` giữ id thiết bị dạng text. Các cột tùy
// chọn phía dưới do migration 5 thêm; chưa áp dụng migration 5 thì các
// truy vấn chỉ được chọn các cột của migration 1.
export interface AuditLog {
  id: string
  family_id: string
  actor: string | null
  action: string
  target: string | null
  ip_hash: string | null
  created_at: string
  child_id?: string | null
  device_id?: string | null
  details?: Record<string, unknown> | null
}

// Dòng notification_sends theo migration 12: nhật ký giữ chỗ/gửi email
// thông báo cho phụ huynh. Chỉ đọc qua policy "family read"; ghi chỉ qua
// các RPC claim/finish/mark của Edge Function gửi thông báo.
export interface NotificationSend {
  id: string
  family_id: string
  kind: 'request' | 'tamper' | 'device_offline'
  event_key: string
  status: 'sending' | 'sent' | 'skipped' | 'throttled'
  device_id: string | null
  action: string | null
  child_id: string | null
  claimed_at: string
  sent_at: string | null
  resend_id: string | null
  recipients: string[]
  created_at: string
}

// Dòng pairing_codes theo migration 1: mã ghép nối 6 số, chỉ lưu hash.
// Dashboard KHÔNG bao giờ SELECT cột code_hash (xem ChildDataTab): mã
// thô chỉ tồn tại lúc tạo, hash không có giá trị xuất dữ liệu.
export interface PairingCode {
  id: string
  family_id: string
  child_id: string | null
  attempts: number
  expires_at: string
  used_at: string | null
  created_at: string
}
