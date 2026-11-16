using System.Security.Cryptography;
using System.Text;

namespace SafePC.Agent.Shared;

/// <summary>
/// Hash mã PIN (dùng khi thoát Tray / gỡ Agent).
///
/// SKELETON: hiện dùng SHA-256(salt + PIN). Theo docs/03-SECURITY.md mục 2,
/// PIN phải lưu bằng bcrypt/argon2 — TODO Sprint 4: thay bằng thư viện
/// Argon2/bcrypt, lưu salt + hash bằng DPAPI, khóa 30 phút sau 5 lần sai.
/// Không bao giờ lưu hay log PIN thô.
/// </summary>
public static class PinHash
{
    /// <summary>Tạo salt ngẫu nhiên và hash PIN. Lưu cả salt và hash, không lưu PIN.</summary>
    public static string CreateHash(string pin, out string salt)
    {
        ArgumentNullException.ThrowIfNull(pin);
        salt = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        return Compute(pin, salt);
    }

    /// <summary>Tính hash của PIN với salt cho trước (để so sánh).</summary>
    public static string Compute(string pin, string salt)
    {
        ArgumentNullException.ThrowIfNull(pin);
        ArgumentNullException.ThrowIfNull(salt);
        return Hashing.Sha256Hex(salt + ":" + pin);
    }

    /// <summary>So sánh PIN nhập vào với hash đã lưu, dùng so sánh cố định thời gian.</summary>
    public static bool Verify(string pin, string salt, string expectedHash)
    {
        ArgumentNullException.ThrowIfNull(pin);
        ArgumentNullException.ThrowIfNull(salt);
        ArgumentNullException.ThrowIfNull(expectedHash);
        byte[] actual = Encoding.UTF8.GetBytes(Compute(pin, salt));
        byte[] expected = Encoding.UTF8.GetBytes(expectedHash);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }
}
