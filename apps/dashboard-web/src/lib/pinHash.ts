// Băm mã PIN thoát Tray (6 số) phía trình duyệt bằng WebCrypto PBKDF2-SHA256.
// PIN thô không bao giờ rời trình duyệt: chỉ chuỗi hash mới được gửi lên
// server (cột devices.exit_pin_hash, migration 7).
//
// Định dạng chuỗi hash KHỚP phía Agent (SafePC.Agent.Shared/PinHash.cs):
//   v1$100000$<salt base64>$<hash base64>
// salt 16 byte ngẫu nhiên, khóa dẫn xuất 32 byte, 100.000 vòng.

const ITERATIONS = 100000
const SALT_BYTES = 16
const KEY_BYTES = 32

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    KEY_BYTES * 8,
  )
  return `v1$${ITERATIONS}$${toBase64(salt)}$${toBase64(new Uint8Array(bits))}`
}

export function isValidPin(pin: string): boolean {
  return /^[0-9]{6}$/.test(pin)
}
