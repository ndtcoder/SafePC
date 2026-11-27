import type { SupabaseClient } from '@supabase/supabase-js'
import type { Command, Device, DeviceChildAccount, SeenWindowsAccount } from './types'

// ===========================================================================
// Sprint 5 đợt Dashboard — quản lý nhiều con trên một máy chung
// (PRD §2.11, phương án 2: một phiên active).
//
// Các hàm đọc ở đây đều best-effort theo đúng mẫu của trang Thiết bị:
// bảng device_child_accounts chỉ có sau migration 24, bảng
// device_seen_accounts chỉ có sau migration 25 (đợt sau) — truy vấn lỗi
// (bảng chưa tồn tại) thì trả available: false và trang hiển thị ghi chú,
// KHÔNG làm hỏng cả trang, KHÔNG bịa dữ liệu.
// ===========================================================================

/**
 * Ánh xạ con ↔ tài khoản Windows của cả gia đình (bảng
 * device_child_accounts, migration 24). Trả available: false khi bảng
 * chưa tồn tại (migration 24 chưa áp dụng) hoặc truy vấn lỗi vì lý do
 * khác — hai trường hợp không phân biệt được qua PostgREST, trang gọi
 * hàm này hiển thị cùng một ghi chú "cần áp migration 24".
 */
export async function fetchDeviceChildAccounts(
  client: SupabaseClient,
): Promise<{ accounts: DeviceChildAccount[]; available: boolean }> {
  try {
    const { data, error } = await client
      .from('device_child_accounts')
      .select('id, family_id, device_id, child_id, windows_sid, windows_username, created_at')
      .order('created_at', { ascending: true })
    if (error) return { accounts: [], available: false }
    return { accounts: (data ?? []) as DeviceChildAccount[], available: true }
  } catch {
    return { accounts: [], available: false }
  }
}

// ---------------------------------------------------------------------------
// Tài khoản Windows mà Tray đã "nhìn thấy" — migration 25 ĐÃ VIẾT
// (backend/supabase/migrations/20261121100000_sprint5_seen_accounts.sql,
// theo đúng thiết kế dưới đây; áp sau migration 24). Phía Service ĐÃ
// NỐI: SupabaseApiClient.ReportSeenAccountAsync, Service gọi ở điểm
// hello của mỗi phiên Tray (throttle 10 phút/SID trong bộ nhớ). Tới
// khi migration 25 được ÁP trên server, hàm dưới trả available: false
// và giao diện hiện ghi chú thay vì danh sách.
//
// Vấn đề: danh sách tài khoản Tray-nhìn-thấy hiện chỉ nằm trong bộ nhớ
// của Service (phiên hello: SessionId / UserName / IsAdmin / SID), chưa
// có gì trong database nên Dashboard không thể liệt kê để phụ huynh
// chọn khi gắn. Thay đổi nhỏ nhất đúng kiến trúc đợt 1 (migration 24
// + RPC, Service chỉ đọc ánh xạ, Dashboard ghi ánh xạ):
//
//   Bảng mới `device_seen_accounts` (migration 25):
//     id uuid PK default gen_random_uuid(),
//     family_id uuid NOT NULL references families(id) on delete cascade,
//     device_id uuid NOT NULL references devices(id) on delete cascade,
//     windows_sid text NOT NULL,
//     windows_username text,
//     is_admin boolean NOT NULL default false,
//     last_seen_at timestamptz NOT NULL default now(),
//     UNIQUE (device_id, windows_sid),
//     index trên device_id, RLS "family access" như device_child_accounts.
//
//   RPC mới `safepc_report_seen_account(p_device_id, p_token_hash,
//   p_windows_sid, p_windows_username, p_is_admin)` — security definer,
//   upsert theo (device_id, windows_sid), cập nhật username/is_admin/
//   last_seen_at; grant cho anon/authenticated/service_role như các RPC
//   khác của Agent. Service gọi RPC này mỗi khi Tray hello (một phiên),
//   khi phát hiện đổi phiên console, và làm mới định kỳ (vd mỗi giờ)
//   để hàng không ươn. Hàng cũ (last_seen_at quá 30 ngày) có thể dọn
//   bằng cron dọn dẹp, hoặc chỉ hiển thị kèm "lần cuối thấy".
//
//   Dashboard (đã viết sẵn trong đợt này): đọc thẳng bảng qua RLS như
//   mọi bảng khác, không cần RPC đọc riêng.
//
// (Thiết kế trên đã thành migration 25 ở file ghi ở đầu mục này, kèm
// lịch cron dọn hàng quá 30 ngày không thấy lại — nhánh "có thể dọn
// bằng cron" của thiết kế.)
// ---------------------------------------------------------------------------

/**
 * Tài khoản Windows đã thấy trên các máy (bảng device_seen_accounts,
 * migration 25 — xem ghi chú thiết kế ở trên). Trả available: false
 * khi bảng chưa tồn tại.
 */
export async function fetchSeenWindowsAccounts(
  client: SupabaseClient,
): Promise<{ accounts: SeenWindowsAccount[]; available: boolean }> {
  try {
    const { data, error } = await client
      .from('device_seen_accounts')
      .select('device_id, windows_sid, windows_username, is_admin, last_seen_at')
      .order('last_seen_at', { ascending: false })
    if (error) return { accounts: [], available: false }
    return { accounts: (data ?? []) as SeenWindowsAccount[], available: true }
  } catch {
    return { accounts: [], available: false }
  }
}

/**
 * Gắn một tài khoản Windows trên máy với một hồ sơ con (ghi một hàng
 * vào device_child_accounts). UNIQUE (device_id, windows_sid) chặn một
 * tài khoản gắn hai con; RLS "family access" chặn ghi sang gia đình khác.
 *
 * Đồng bộ trạng thái thi hành lúc gắn — ĐÃ CHỐT phương án (a) ngày
 * 21/11/2026 (PRD §2.11): sau khi tạo ánh xạ, Dashboard gọi RPC
 * safepc_sync_enforcement_state_to_device (migration 27) để sao chép
 * khóa cưỡng chế + ghi đè đang hiệu lực của con (kể cả tổng ngân hàng
 * giờ đã có trước lúc gắn) sang máy này, tái dùng khối sao chép của
 * migration 21. Gọi best-effort (xem syncEnforcementStateToDevice) —
 * migration 27 chưa áp thì gắn vẫn thành công, chỉ hiện ghi chú.
 */
export async function linkChildAccount(
  client: SupabaseClient,
  input: {
    familyId: string
    deviceId: string
    childId: string
    windowsSid: string
    windowsUsername: string | null
  },
): Promise<void> {
  const { error } = await client.from('device_child_accounts').insert({
    family_id: input.familyId,
    device_id: input.deviceId,
    child_id: input.childId,
    windows_sid: input.windowsSid,
    windows_username: input.windowsUsername,
  })
  if (error) throw error
}

/**
 * Kết quả đồng bộ trạng thái thi hành lúc gắn (RPC
 * safepc_sync_enforcement_state_to_device, migration 27 — phương án (a)
 * đã chốt 21/11/2026, PRD §2.11). synced: false nghĩa là RPC chưa chạy
 * được — việc gắn đã thành công, chỉ trạng thái chưa đồng bộ sang máy.
 */
export type LinkSyncOutcome =
  | {
      synced: true
      locked: boolean
      overrideAction: string | null
      overrideMinutes: number | null
      overrideExpiresAt: string | null
    }
  | { synced: false; missingMigration: boolean }

/**
 * Đồng bộ trạng thái thi hành của con sang máy vừa gắn (khóa cưỡng chế +
 * ghi đè đang hiệu lực, kể cả tổng ngân hàng giờ đã có trước lúc gắn).
 * BEST-EFFORT: RPC chưa có (migration 27 chưa áp → PostgREST báo
 * function không tồn tại) thì trả synced: false để nơi gọi hiện ghi
 * chú, KHÔNG ném lỗi làm hỏng việc gắn. Lỗi khác (không có quyền, con
 * chưa gắn...) cũng không ném — việc gắn đã thành công, chỉ trạng thái
 * chưa đồng bộ.
 */
export async function syncEnforcementStateToDevice(
  client: SupabaseClient,
  input: { deviceId: string; childId: string },
): Promise<LinkSyncOutcome> {
  try {
    const { data, error } = await client.rpc('safepc_sync_enforcement_state_to_device', {
      p_device_id: input.deviceId,
      p_child_id: input.childId,
    })
    if (error) {
      return { synced: false, missingMigration: isMissingRpcError(error) }
    }
    const result = (data ?? {}) as {
      locked?: unknown
      override_action?: unknown
      override_minutes?: unknown
      override_expires_at?: unknown
    }
    return {
      synced: true,
      locked: result.locked === true,
      overrideAction: typeof result.override_action === 'string' ? result.override_action : null,
      overrideMinutes: typeof result.override_minutes === 'number' ? result.override_minutes : null,
      overrideExpiresAt: typeof result.override_expires_at === 'string' ? result.override_expires_at : null,
    }
  } catch {
    return { synced: false, missingMigration: false }
  }
}

/** Lỗi PostgREST khi gọi một RPC chưa tồn tại (function chưa được tạo).
 *  KHÔNG match theo tên hàm: lỗi "permission denied for function
 *  public.safepc_sync_enforcement_state_to_device(...)" (GRANT thiếu sau
 *  khi áp migration dở dang) cũng chứa tên hàm nhưng migration ĐÃ áp —
 *  match tên sẽ xếp nhầm thành "chưa áp migration 27" và che mất nguyên
 *  nhân thật. */
function isMissingRpcError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const code = (error as { code?: unknown } | null)?.code
  return (
    code === 'PGRST202' ||
    message.includes('PGRST202') ||
    message.includes('Could not find the function')
  )
}

/**
 * Gỡ ánh xạ của một tài khoản Windows trên máy (xóa hàng
 * device_child_accounts). Gỡ xong, phiên của tài khoản đó không còn
 * được quản lý (Service chỉ ghi log cảnh báo, xem PRD §2.11); các quy
 * tắc / ngân hàng giờ / báo cáo của hồ sơ con vẫn giữ nguyên. Lệnh
 * đang pending cho con đó trên máy này vẫn nằm trong bảng commands và
 * sẽ được áp dụng nếu tài khoản được gắn lại rồi con đăng nhập.
 */
export async function unlinkChildAccount(
  client: SupabaseClient,
  input: { deviceId: string; windowsSid: string },
): Promise<void> {
  const { error } = await client
    .from('device_child_accounts')
    .delete()
    .eq('device_id', input.deviceId)
    .eq('windows_sid', input.windowsSid)
  if (error) throw error
}

/**
 * Các hồ sơ con được quản lý trên một máy, theo thứ tự: con mặc định
 * của máy (devices.child_id) trước, rồi các con đã gắn thêm qua ánh xạ
 * (không trùng con mặc định). Máy chưa gán con nào và chưa có ánh xạ
 * thì trả rỗng — lệnh không gắn được với con nào.
 */
export function targetChildrenForDevice(
  device: Device,
  accounts: readonly DeviceChildAccount[],
): string[] {
  const ids: string[] = []
  if (device.child_id) ids.push(device.child_id)
  for (const account of accounts) {
    if (account.device_id === device.id && !ids.includes(account.child_id)) {
      ids.push(account.child_id)
    }
  }
  return ids
}

/** Các ánh xạ của một máy, theo thứ tự tạo. */
export function accountsForDevice(
  deviceId: string,
  accounts: readonly DeviceChildAccount[],
): DeviceChildAccount[] {
  return accounts.filter((a) => a.device_id === deviceId)
}

/** Tài khoản Windows đã thấy trên một máy, theo thứ tự thấy gần nhất. */
export function seenAccountsForDevice(
  deviceId: string,
  accounts: readonly SeenWindowsAccount[],
): SeenWindowsAccount[] {
  return accounts.filter((a) => a.device_id === deviceId)
}

/** Tài khoản Windows đã thấy nhưng chưa gắn với hồ sơ con nào trên máy. */
export function unmappedSeenAccountsForDevice(
  deviceId: string,
  seen: readonly SeenWindowsAccount[],
  linked: readonly DeviceChildAccount[],
): SeenWindowsAccount[] {
  const linkedSids = new Set(linked.filter((a) => a.device_id === deviceId).map((a) => a.windows_sid))
  return seen.filter((a) => a.device_id === deviceId && !linkedSids.has(a.windows_sid))
}

/**
 * Lệnh này có nhắm tới hồ sơ con đã cho trên máy này không. Lệnh có
 * child_id thì so trực tiếp; lệnh cũ (child_id null) thuộc về con mặc
 * định của máy (cùng ngữ nghĩa với ShouldApplyCommand phía Service).
 */
export function commandTargetsChild(
  command: Command,
  childId: string,
  defaultChildId: string | null,
): boolean {
  if (command.child_id !== undefined && command.child_id !== null) {
    return command.child_id === childId
  }
  return defaultChildId !== null && childId === defaultChildId
}

/** Máy coi là đang online khi heartbeat chưa quá 10 phút (cùng ngưỡng với trang Thiết bị). */
export function isDeviceOnline(device: Device, nowMs: number): boolean {
  if (!device.last_seen_at) return false
  const seenMs = new Date(device.last_seen_at).getTime()
  if (Number.isNaN(seenMs)) return false
  return nowMs - seenMs <= 10 * 60 * 1000
}

// Lệnh pending trên máy đang online mà quá ngưỡng này chưa được áp dụng
// thì coi như Service đang hoãn nó vì con đích chưa active: Agent poll
// lệnh mỗi 15 giây nên lệnh cho con đang active đã được áp dụng (ack)
// từ lâu. Ngưỡng 2 phút chừa chỗ cho trễ mạng / Service vừa khởi động.
const DEFERRED_AFTER_MS = 2 * 60 * 1000

export type PendingCommandState =
  | { kind: 'waiting-device'; text: string }
  | { kind: 'inflight'; text: string }
  | { kind: 'waiting-child'; text: string }
  | { kind: 'expired'; text: string }
  | { kind: 'stuck'; text: string }

/**
 * Lỗi ghi lệnh / gắn ánh xạ do thiếu cột `commands.child_id` hoặc bảng
 * `device_child_accounts` (migration 24 chưa áp dụng) thì dịch thành câu
 * tiếng Việt nói rõ cần làm gì, thay vì để lỗi PostgREST tiếng Anh thô
 * ("Could not find the 'child_id' column...") lọt ra giao diện. Chỉ nhận
 * đúng hai mẫu lỗi thiếu schema của PostgREST — lỗi trùng lặp UNIQUE
 * (`device_child_accounts_device_id_windows_sid_key`) và lỗi khóa ngoại
 * (`commands_child_id_fkey`) đều nhắc tới `child_id` /
 * `device_child_accounts` nhưng KHÔNG phải lỗi thiếu migration nên trả
 * null để nơi gọi hiện lỗi gốc. Trả null khi lỗi không liên quan tới
 * migration 24 — nơi gọi dùng
 * `describeCommandInsertError(err) ?? toVietnameseError(err)`.
 */
export function describeCommandInsertError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (/duplicate key/i.test(message) || /violates foreign key/i.test(message)) {
    return null
  }
  if (
    message.includes("Could not find the 'child_id' column") ||
    message.includes("Could not find the table 'public.device_child_accounts'")
  ) {
    return 'Cần áp dụng migration 24 (Sprint 5) trên Supabase rồi thử lại — lệnh theo từng con cần cột child_id và bảng device_child_accounts.'
  }
  return null
}

// Agent từ bản nào thì biết hoãn lệnh cho con chưa active
// (ShouldApplyCommand, đợt 1 backend Sprint 5, CI #317 → v0.1.317).
// Agent cũ hơn không có logic hoãn: lệnh pending quá 2 phút khi máy
// online nghĩa là Agent kẹt / ack rớt, không phải "đang chờ con đăng
// nhập". Phiên bản không đọc được (null) thì coi như bản mới để khỏi
// đổi hành vi với máy chưa từng báo phiên bản.
const DEFERRED_COMMANDS_MIN_AGENT_RUN = 317

export function agentSupportsDeferredCommands(agentVersion: string | null): boolean {
  if (!agentVersion) return true
  const match = /^0\.1\.(\d+)$/.exec(agentVersion.trim())
  if (!match) return true
  return Number(match[1]) >= DEFERRED_COMMANDS_MIN_AGENT_RUN
}

/**
 * Trạng thái hiển thị của một lệnh đang pending, suy ra từ dữ liệu hiện
 * có (trạng thái lệnh + heartbeat máy + tuổi lệnh). Chưa có trường
 * trạng thái riêng từ Agent (snapshot thi hành v1 không mang con đang
 * active), nên "đang chờ con đăng nhập" là SUY LUẬN, không phải trạng
 * thái do Agent báo — xem TODO dưới.
 *
 * TODO (đợt Service sau, cải tiến tối thiểu): thêm `activeChildId`
 * vào snapshot thi hành (devices.enforcement_json, v2) để Dashboard
 * biết chắc con nào đang active trên máy, thay vì suy ra từ tuổi lệnh.
 * Khi đó hàm này nhận thêm activeChildId và chỉ báo "waiting-child"
 * khi con đích khác con đang active; lệnh pending cho đúng con đang
 * active mà quá ngưỡng thì báo "máy chưa nhận lệnh" để phụ huynh biết
 * mà kiểm tra Agent. Trước mắt, Agent cũ (trước v0.1.317, không có
 * logic hoãn) thì lệnh pending quá ngưỡng được báo kind 'stuck' thay
 * vì 'waiting-child' (xem agentSupportsDeferredCommands).
 */
export function describePendingCommand(
  command: Command,
  device: Device,
  childNameById: Map<string, string>,
  nowMs: number,
): PendingCommandState | null {
  if (command.status !== 'pending') return null
  const targetChildId =
    command.child_id ?? (device.child_id as string | null)
  const targetName = targetChildId
    ? (childNameById.get(targetChildId) ?? 'con')
    : 'con mặc định của máy'
  // Lệnh ghi đè có expires_at mà đã qua hạn thì Service sẽ tiêu thụ và
  // ack done mà không có tác dụng gì (kể cả khi con đăng nhập sau đó) —
  // báo hết hạn thay vì hứa "sẽ áp dụng khi con đăng nhập". lock_now /
  // cancel không có expires_at nên không bị ảnh hưởng.
  const expiresAtRaw = command.payload['expires_at']
  if (typeof expiresAtRaw === 'string') {
    const expiresMs = new Date(expiresAtRaw).getTime()
    if (!Number.isNaN(expiresMs) && expiresMs <= nowMs) {
      return {
        kind: 'expired',
        text: 'Lệnh đã hết hạn trước khi con đăng nhập — hãy gửi lại lệnh mới.',
      }
    }
  }
  if (!isDeviceOnline(device, nowMs)) {
    return {
      kind: 'waiting-device',
      text: `Máy đang offline — lệnh sẽ được áp dụng khi máy online trở lại và con đăng nhập.`,
    }
  }
  const ageMs = nowMs - new Date(command.created_at).getTime()
  if (Number.isNaN(ageMs) || ageMs < DEFERRED_AFTER_MS) {
    return { kind: 'inflight', text: 'Đang chờ máy nhận lệnh…' }
  }
  // Agent cũ (trước v0.1.317) không có logic hoãn lệnh: lệnh cho con
  // đang active phải được áp trong ~1 vòng poll 15 giây, nên pending
  // quá 2 phút là Agent kẹt / ack rớt — báo rõ để phụ huynh kiểm tra
  // máy, không dán nhãn "chờ con đăng nhập".
  if (!agentSupportsDeferredCommands(device.agent_version)) {
    return {
      kind: 'stuck',
      text: 'Lệnh đã chờ hơn 2 phút mà máy chưa nhận — Agent trên máy có thể đang kẹt hoặc đang chạy bản cũ (chưa có logic hoãn lệnh Sprint 5). Hãy kiểm tra máy con và cập nhật Agent mới nhất.',
    }
  }
  return {
    kind: 'waiting-child',
    text: `Sẽ áp dụng khi ${targetName} đăng nhập trên máy này (lệnh đang chờ vì con chưa active).`,
  }
}

/** Nhãn ngắn cho một action ghi đè (dùng chung cho lệnh chờ và kết quả đồng bộ lúc gắn). */
export function overrideActionLabel(action: string): string {
  switch (action) {
    case 'unlock':
      return 'Mở khóa tạm thời'
    case 'lock':
      return 'Khóa máy tạm thời'
    case 'bonus_minutes':
      return 'Cộng thêm giờ'
    case 'allow_domain':
      return 'Cho phép website tạm thời'
    case 'block_domain':
      return 'Chặn website tạm thời'
    case 'block_app':
      return 'Chặn ứng dụng tạm thời'
    case 'allow_app':
      return 'Cho phép ứng dụng tạm thời'
    case 'cancel':
      return 'Hủy ghi đè'
    default:
      return `Ghi đè (${action})`
  }
}

/** Nhãn ngắn cho loại lệnh, dùng trong danh sách lệnh đang chờ. */
export function pendingCommandLabel(command: Command): string {
  if (command.type === 'lock_now') {
    const delay = command.payload['delay_minutes']
    if (typeof delay === 'number' && delay > 0) return `Khóa máy ngay (sau ${delay} phút)`
    return 'Khóa máy ngay'
  }
  const action = command.payload['action']
  if (typeof action === 'string') {
    return overrideActionLabel(action)
  }
  return 'Ghi đè tạm thời'
}

/** SID rút gọn để hiển thị (đủ phân biệt, không in toàn bộ SID dài). */
export function shortSid(sid: string): string {
  if (sid.length <= 24) return sid
  return `${sid.slice(0, 12)}…${sid.slice(-8)}`
}
