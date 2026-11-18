/**
 * Logic xác thực hai lớp (MFA) TOTP cho tài khoản phụ huynh.
 *
 * Mọi thao tác MFA đều qua Supabase Auth (`supabase.auth.mfa.*`): factor
 * TOTP nằm trong schema auth của Supabase, Dashboard không tự lưu secret
 * hay mã khôi phục ở bất kỳ bảng nào. File này chỉ chứa logic thuần
 * (chuẩn hóa mã, chọn factor, quyết định có cần bước MFA không) để kiểm
 * chứng được mà không cần gọi API thật; các component gọi API trực tiếp
 * qua client Supabase.
 */

/** Mã TOTP của app authenticator luôn có đúng 6 chữ số. */
export const MFA_CODE_LENGTH = 6

/** Mức đảm bảo xác thực (AAL) của phiên Supabase. */
export type AalLevel = 'aal1' | 'aal2'

/**
 * Phiên có cần bước nhập mã MFA không: tài khoản đã có factor đã xác minh
 * (mức tiếp theo là aal2) nhưng phiên hiện tại chưa đạt aal2. Khi không có
 * phiên (cả hai đều null) thì không cần — trang đăng nhập xử lý như cũ.
 */
export function needsMfaStep(
  currentLevel: AalLevel | string | null,
  nextLevel: AalLevel | string | null,
): boolean {
  return nextLevel === 'aal2' && currentLevel !== 'aal2'
}

/**
 * Chuẩn hóa mã người dùng nhập/dán: chỉ giữ chữ số, bỏ khoảng trắng, dấu
 * gạch ngang và mọi ký tự khác. Mã dán từ app authenticator đôi khi kèm
 * khoảng trắng (VD "123 456").
 */
export function normalizeMfaCode(input: string): string {
  return input.replace(/[^0-9]/g, '')
}

/** Mã hợp lệ để gửi lên server: đúng 6 chữ số, không gì khác. */
export function isValidMfaCode(code: string): boolean {
  return code.length === MFA_CODE_LENGTH && /^[0-9]{6}$/.test(code)
}

/**
 * Ảnh QR trả về từ `mfa.enroll()` là chuỗi SVG thô; theo ghi chú trong
 * kiểu của supabase-js, muốn dùng làm `src` của `<img>` thì thêm tiền tố
 * `data:image/svg+xml;utf-8,` vào trước giá trị. encodeURIComponent để
 * các ký tự đặc biệt trong SVG (VD `#`) không phá hỏng data URL.
 * Không cần thêm thư viện QR nào: mã QR do chính Supabase Auth sinh ra.
 */
export function buildQrCodeDataUrl(qrCodeSvg: string): string {
  return `data:image/svg+xml;utf-8,${encodeURIComponent(qrCodeSvg)}`
}

/**
 * Hiển thị secret TOTP theo nhóm 4 ký tự để dễ nhập tay vào app
 * authenticator (VD "ABCD EFGH IJKL MNOP"). Chỉ dùng để hiển thị và
 * sao chép cho dễ đọc; giá trị gốc không có khoảng trắng.
 */
export function groupMfaSecret(secret: string): string {
  const compact = secret.replace(/\s+/g, '').toUpperCase()
  const groups: string[] = []
  for (let i = 0; i < compact.length; i += 4) {
    groups.push(compact.slice(i, i + 4))
  }
  return groups.join(' ')
}

/**
 * Hình dạng tối thiểu của một MFA factor mà Dashboard cần. Khớp về mặt
 * cấu trúc với kiểu `Factor` của supabase-js nên dùng được trực tiếp với
 * dữ liệu từ `mfa.listFactors()` mà không cần import kiểu của thư viện.
 */
export interface MfaFactorView {
  id: string
  factor_type: string
  status: string
  friendly_name?: string
  created_at: string
}

/** Factor TOTP đã xác minh (đang bảo vệ tài khoản). */
export function isVerifiedTotpFactor(factor: MfaFactorView): boolean {
  return factor.factor_type === 'totp' && factor.status === 'verified'
}

/** Factor TOTP đăng ký dở (đã tạo nhưng chưa nhập mã xác nhận lần đầu). */
export function isUnverifiedTotpFactor(factor: MfaFactorView): boolean {
  return factor.factor_type === 'totp' && factor.status === 'unverified'
}

/**
 * Tài khoản có factor ĐÃ xác minh loại khác TOTP (phone, webauthn,
 * recovery_code — tạo từ nơi khác) không. Dashboard không thách thức
 * được các factor này nên bước đăng nhập phải hướng tới đường khôi phục
 * qua quản trị Supabase thay vì gợi ý đăng nhập lại.
 */
export function hasVerifiedNonTotpFactor(factors: MfaFactorView[]): boolean {
  return factors.some((f) => f.factor_type !== 'totp' && f.status === 'verified')
}

/**
 * Chọn factor để thách thức ở bước đăng nhập: factor TOTP đã xác minh
 * lâu đời nhất (tạo trước nhất). Dashboard chỉ hỗ trợ factor TOTP của
 * app authenticator; factor loại khác (phone, webauthn) — nếu có do tạo
 * từ nơi khác — không được chọn, và bước đăng nhập sẽ báo rõ giới hạn
 * này thay vì im lặng bỏ qua MFA.
 */
export function selectChallengeFactor(factors: MfaFactorView[]): MfaFactorView | null {
  const verified = factors.filter(isVerifiedTotpFactor)
  if (verified.length === 0) return null
  verified.sort((a, b) => a.created_at.localeCompare(b.created_at))
  return verified[0]
}
