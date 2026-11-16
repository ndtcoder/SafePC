using System.Security.Cryptography;
using System.Text;

namespace SafePC.Agent.Shared;

/// <summary>
/// Lưu và đọc device token bằng DPAPI (Windows Data Protection API).
/// Token chỉ tồn tại ở dạng mã hóa trong file; khóa do Windows quản lý theo máy
/// (DataProtectionScope.LocalMachine) vì Service chạy quyền SYSTEM.
/// Không bao giờ ghi token ra log (docs/03-SECURITY.md mục 2 và 4).
///
/// TODO Sprint 1: luồng pairing (đổi pairing code 6 số lấy device token qua
/// Edge Function) sẽ gọi <see cref="SaveToken"/> sau khi nhận token.
/// </summary>
public sealed class TokenStore
{
    // Entropy phụ thêm cho DPAPI. Đây KHÔNG phải secret (chỉ là chuỗi phân biệt
    // ứng dụng); khóa thật do DPAPI của Windows quản lý.
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("SafePC.Agent.v1");

    private readonly string _filePath;

    public TokenStore(string filePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(filePath);
        _filePath = filePath;
    }

    /// <summary>Đã có token được lưu hay chưa (dùng để biết máy đã pairing chưa).</summary>
    public bool HasToken() => File.Exists(_filePath);

    /// <summary>Mã hóa token bằng DPAPI và ghi ra file.</summary>
    public void SaveToken(string token)
    {
        ArgumentException.ThrowIfNullOrEmpty(token);

        string? directory = Path.GetDirectoryName(_filePath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        byte[] plain = Encoding.UTF8.GetBytes(token);
        try
        {
            byte[] cipher = ProtectedData.Protect(plain, Entropy, DataProtectionScope.LocalMachine);
            try
            {
                File.WriteAllBytes(_filePath, cipher);
            }
            finally
            {
                Array.Clear(cipher, 0, cipher.Length);
            }
        }
        finally
        {
            Array.Clear(plain, 0, plain.Length);
        }
    }

    /// <summary>
    /// Đọc và giải mã token. Trả về null khi chưa có token hoặc giải mã thất bại
    /// (VD: file bị sửa, máy đã cài lại Windows). Không throw, không log token.
    /// </summary>
    public string? TryLoadToken()
    {
        try
        {
            if (!File.Exists(_filePath))
            {
                return null;
            }

            byte[] cipher = File.ReadAllBytes(_filePath);
            byte[] plain = ProtectedData.Unprotect(cipher, Entropy, DataProtectionScope.LocalMachine);
            try
            {
                return Encoding.UTF8.GetString(plain);
            }
            finally
            {
                Array.Clear(plain, 0, plain.Length);
            }
        }
        catch (CryptographicException)
        {
            return null;
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>Xóa token đã lưu (VD: khi phụ huynh bấm "Xóa máy" / thu hồi token).</summary>
    public void DeleteToken()
    {
        try
        {
            if (File.Exists(_filePath))
            {
                File.Delete(_filePath);
            }
        }
        catch (IOException)
        {
            // File đang bị khóa: lần chạy sau sẽ thử lại. Không throw.
        }
        catch (UnauthorizedAccessException)
        {
            // Không đủ quyền: ghi log ở nơi gọi nếu cần. Không throw.
        }
    }
}
