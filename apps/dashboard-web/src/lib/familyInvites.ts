/**
 * Logic thuần của lời mời phụ huynh thứ hai (migration 14): sinh token,
 * băm token, chuẩn hóa email, trạng thái hiển thị, và kiểm tra đường dẫn
 * quay lại sau đăng nhập. Không gọi API — mọi ghi/đọc đi qua RPC
 * safepc_create_family_invite / safepc_accept_family_invite /
 * safepc_revoke_family_invite và bảng family_invites.
 *
 * Quy ước token: 32 byte ngẫu nhiên từ crypto.getRandomValues, mã hóa
 * base64url (43 ký tự, không đệm). Xuống database chỉ lưu SHA-256 hex
 * CHỮ THƯỜNG của token — cùng quy ước mã ghép nối trong DevicesPage.
 * Token thô chỉ tồn tại trong link lời mời người mời tự gửi đi.
 */

/** Thời hạn mặc định của lời mời: 7 ngày (server chặn hạn quá 30 ngày). */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Giới hạn độ dài email theo RFC 5321 (đường gửi tối đa 254 ký tự). */
export const MAX_EMAIL_LENGTH = 254

/** Chuẩn hóa email: cắt khoảng trắng hai đầu + chữ thường toàn bộ. */
export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Email hợp lệ cho lời mời: đã chuẩn hóa, không khoảng trắng, có một @
 * và phần domain có dấu chấm. Cùng chính sách với CHECK trong migration
 * 14 (phía server kiểm tra lại — đây chỉ là kiểm tra sớm ở giao diện).
 */
export function isValidInviteEmail(email: string): boolean {
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return false
  if (email !== email.trim() || email !== email.toLowerCase()) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

/** Sinh token lời mời: 32 byte ngẫu nhiên, base64url, 43 ký tự. */
export function generateInviteToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/** Token hợp lệ đúng định dạng sinh ra: 43 ký tự base64url, không đệm. */
export function isValidInviteTokenFormat(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token)
}

/** SHA-256 hex CHỮ THƯỜNG của chuỗi — đúng quy ước hash phía server. */
export async function sha256HexLower(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** Link lời mời đầy đủ từ origin của Dashboard và token thô. */
export function buildInviteLink(origin: string, token: string): string {
  return `${origin.replace(/\/$/, '')}/moi/${token}`
}

/** Trạng thái hiển thị của một lời mời, suy ra từ các mốc thời gian. */
export type FamilyInviteDisplayStatus = 'pending' | 'accepted' | 'revoked' | 'expired'

export function inviteDisplayStatus(
  invite: { accepted_at: string | null; revoked_at: string | null; expires_at: string },
  nowMs: number,
): FamilyInviteDisplayStatus {
  if (invite.accepted_at) return 'accepted'
  if (invite.revoked_at) return 'revoked'
  if (nowMs >= new Date(invite.expires_at).getTime()) return 'expired'
  return 'pending'
}

/** Nhãn tiếng Việt cho từng trạng thái hiển thị của lời mời. */
export const INVITE_STATUS_LABELS: Record<FamilyInviteDisplayStatus, string> = {
  pending: 'Chờ chấp nhận',
  accepted: 'Đã chấp nhận',
  revoked: 'Đã thu hồi',
  expired: 'Hết hạn',
}

/**
 * Đường dẫn quay lại sau đăng nhập có được phép không: CHỈ đường dẫn chấp
 * nhận lời mời cùng origin (/moi/<token 43 ký tự>). Mọi thứ khác — đường
 * dẫn tuyệt đối, URL ngoài, đường dẫn khác trong app — đều bị từ chối để
 * tham số ?next= không thành chuyển hướng mở.
 */
export function isValidInviteNextPath(next: string): boolean {
  return /^\/moi\/[A-Za-z0-9_-]{43}$/.test(next)
}
