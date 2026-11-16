// Kiểu dữ liệu khớp với migration:
// backend/supabase/migrations/20261116102900_init_safepc.sql
// (tên bảng, tên cột và giá trị enum phải giữ đúng như schema này.)

export type DeviceStatus = 'online' | 'offline' | 'locked'
export type RuleType = 'daily_limit' | 'bedtime' | 'time_window' | 'app' | 'website'
export type RequestType = 'extra_time' | 'unblock_app'
export type RequestStatus = 'pending' | 'approved' | 'denied'
export type CommandType = 'lock_now' | 'unlock' | 'refresh_rules' | 'update' | 'temporary_override'
export type CommandStatus = 'pending' | 'sent' | 'done' | 'failed'
/** Hành động của lệnh temporary_override; allow_domain/block_domain mang thêm `domains` trong payload. */
export type TemporaryOverrideAction = 'bonus_minutes' | 'lock' | 'unlock' | 'allow_domain' | 'block_domain' | 'cancel'

export interface Family {
  id: string
  owner_id: string
  name: string
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
  status: DeviceStatus
  created_at: string
}

export interface Rule {
  id: string
  family_id: string
  child_id: string
  type: RuleType
  config: Record<string, unknown>
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
