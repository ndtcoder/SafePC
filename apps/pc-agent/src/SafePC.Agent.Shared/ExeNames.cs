namespace SafePC.Agent.Shared;

/// <summary>
/// Chuẩn hóa tên exe/process để so khớp quy tắc theo app (Sprint 2 đợt 3).
///
/// Vấn đề: cùng một app xuất hiện dưới nhiều dạng tên khác nhau — config của
/// phụ huynh ghi "game.exe", <c>Process.ProcessName</c> trả về "game" (không
/// có ".exe"), tên file exe là "Game.EXE". Mọi chỗ so khớp (đếm usage, khớp
/// foreground, nhắm mục tiêu kill, kiểm tra denylist) PHẢI dùng chung helper
/// này, không tự viết lại phép chuẩn hóa ở từng nơi.
/// </summary>
public static class ExeNames
{
    /// <summary>
    /// Chuẩn hóa một tên exe/process: bỏ khoảng trắng hai đầu, rồi bỏ ĐÚNG
    /// MỘT hậu tố ".exe" (không phân biệt hoa thường). Trả về null khi tên
    /// rỗng hoặc chỉ còn ".exe". Không hạ thấp chữ hoa — phép so sánh dùng
    /// <see cref="StringComparison.OrdinalIgnoreCase"/>.
    /// </summary>
    public static string? Normalize(string? name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return null;
        }

        string value = name.Trim();
        if (value.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
        {
            value = value[..^4];
        }

        return value.Length == 0 ? null : value;
    }

    /// <summary>
    /// Hai tên có chỉ cùng một exe không: chuẩn hóa cả hai phía rồi so sánh
    /// không phân biệt hoa thường. Một phía null/rỗng thì không khớp.
    /// </summary>
    public static bool Matches(string? left, string? right)
    {
        string? a = Normalize(left);
        string? b = Normalize(right);
        return a is not null && b is not null
            && string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
    }
}
