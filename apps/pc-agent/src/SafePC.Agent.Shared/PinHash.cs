using System.Security.Cryptography;

namespace SafePC.Agent.Shared;

/// <summary>
/// Băm và kiểm tra mã PIN thoát Tray (6 số) bằng PBKDF2-SHA256.
///
/// Định dạng chuỗi hash (KHỚP cả Dashboard — xem
/// <c>apps/dashboard-web/src/lib/pinHash.ts</c>):
/// <c>v1$100000$&lt;salt base64&gt;$&lt;hash base64&gt;</c> — salt 16 byte
/// ngẫu nhiên, khóa dẫn xuất 32 byte, 100.000 vòng. PIN thô không bao giờ
/// được lưu hay ghi log; chỉ hash này mới rời khỏi máy (qua cột
/// <c>devices.exit_pin_hash</c>) và chỉ Service mới giữ nó trong bộ nhớ —
/// Tray KHÔNG bao giờ nhận hash, mà gửi PIN nhập vào lên Service để kiểm
/// tra qua IPC (xem <c>PinVerifyRequest</c>).
///
/// Mọi lỗi phân tích hash đều trả về false (fail-closed): hash hỏng thì
/// không PIN nào đúng, Tray không thoát được.
/// </summary>
public static class PinHash
{
    /// <summary>Số vòng PBKDF2. Đủ chậm để vét cạn 1 triệu PIN 6 số là bất khả thi trong thực tế.</summary>
    public const int Iterations = 100_000;

    private const int SaltSizeBytes = 16;
    private const int KeySizeBytes = 32;
    private const int MinIterations = 1;
    private const int MaxIterations = 1_000_000;

    /// <summary>Tạo chuỗi hash cho một PIN. Dùng trong self-test và công cụ; Dashboard băm phía trình duyệt.</summary>
    public static string Hash(string pin)
    {
        ArgumentException.ThrowIfNullOrEmpty(pin);

        byte[] salt = RandomNumberGenerator.GetBytes(SaltSizeBytes);
        byte[] key = Rfc2898DeriveBytes.Pbkdf2(pin, salt, Iterations, HashAlgorithmName.SHA256, KeySizeBytes);
        return "v1$" + Iterations.ToString(System.Globalization.CultureInfo.InvariantCulture)
            + "$" + Convert.ToBase64String(salt)
            + "$" + Convert.ToBase64String(key);
    }

    /// <summary>Kiểm tra PIN nhập vào với chuỗi hash đã lưu. So sánh trong thời gian hằng số.</summary>
    public static bool Verify(string pin, string storedHash)
    {
        if (string.IsNullOrEmpty(pin) || string.IsNullOrEmpty(storedHash))
        {
            return false;
        }

        try
        {
            string[] parts = storedHash.Split('$');
            if (parts.Length != 4 || parts[0] != "v1")
            {
                return false;
            }

            if (!int.TryParse(parts[1], System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out int iterations)
                || iterations < MinIterations || iterations > MaxIterations)
            {
                return false;
            }

            byte[] salt = Convert.FromBase64String(parts[2]);
            byte[] expectedKey = Convert.FromBase64String(parts[3]);
            if (salt.Length != SaltSizeBytes || expectedKey.Length != KeySizeBytes)
            {
                return false;
            }

            byte[] actualKey = Rfc2898DeriveBytes.Pbkdf2(pin, salt, iterations, HashAlgorithmName.SHA256, KeySizeBytes);
            return CryptographicOperations.FixedTimeEquals(actualKey, expectedKey);
        }
        catch (FormatException)
        {
            return false;
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch (CryptographicException)
        {
            // Lỗi nền tảng cực hiếm khi dẫn xuất khóa — vẫn fail-closed.
            return false;
        }
    }
}
