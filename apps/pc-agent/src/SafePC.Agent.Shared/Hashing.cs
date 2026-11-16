using System.Security.Cryptography;
using System.Text;

namespace SafePC.Agent.Shared;

/// <summary>
/// Hash SHA-256 dùng chung. Nguyên tắc (docs/03-SECURITY.md): chỉ lưu hash của
/// token/code/PIN và của đường dẫn exe, không lưu giá trị thô, không ghi vào log.
// </summary>
public static class Hashing
{
    /// <summary>SHA-256 của một chuỗi, trả về hex lowercase.</summary>
    public static string Sha256Hex(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        return Sha256Hex(Encoding.UTF8.GetBytes(value));
    }

    /// <summary>SHA-256 của một mảng byte, trả về hex lowercase.</summary>
    public static string Sha256Hex(byte[] bytes)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    }

    /// <summary>
    /// Hash đường dẫn file exe: chuẩn hóa (trim + lowercase) rồi SHA-256.
    /// Trả về null khi đường dẫn rỗng. Đường dẫn thô không bao giờ được lưu hay gửi đi.
    /// </summary>
    public static string? HashExePath(string? exePath)
    {
        if (string.IsNullOrWhiteSpace(exePath))
        {
            return null;
        }

        return Sha256Hex(exePath.Trim().ToLowerInvariant());
    }

    /// <summary>Hash của token/code bí mật. Chỉ hash này mới được lưu ở DB hoặc so sánh.</summary>
    public static string HashSecret(string secret) => Sha256Hex(secret);
}
