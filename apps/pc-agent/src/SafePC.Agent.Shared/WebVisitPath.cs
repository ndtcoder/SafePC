namespace SafePC.Agent.Shared;

/// <summary>
/// Cắt gọn đường dẫn của lượt thăm web về đúng ranh giới phụ huynh đã
/// chốt (18/11/2026): chỉ đường dẫn (path), bỏ phần truy vấn (query) và
/// fragment, trần 500 ký tự. Dùng chung cho NativeHost (lúc ghi dòng
/// JSONL) và Service (lúc đọc dòng JSONL) để hai tầng cắt giống hệt nhau;
/// RPC <c>safepc_push_web_visits</c> (migration 19) cắt lại lần nữa —
/// phòng thủ theo chiều sâu, vì file JSONL nằm ở thư mục chia sẻ.
///
/// File này được biên dịch vào CẢ hai assembly: Shared (glob mặc định)
/// và NativeHost (linked file trong csproj — NativeHost là net8.0 thuần
/// nên không tham chiếu được Shared net8.0-windows). Vì vậy file CHỈ
/// được dùng BCL, không dùng API chỉ có trên Windows hay package ngoài.
///
/// Trả về null khi không có đường dẫn dùng được (rỗng, không bắt đầu
/// bằng '/', chứa ký tự điều khiển, hoặc là URL đầy đủ trá hình) — nơi
/// gọi khi đó giữ lượt thăm ở dạng chỉ-domain, không vứt cả lượt thăm.
/// </summary>
public static class WebVisitPath
{
    /// <summary>Trần độ dài đường dẫn (ký tự) — cùng trần với extension
    /// (pathFromUrl) và cột <c>web_visits.path</c> (migration 19).</summary>
    public const int MaxLength = 500;

    public static string? Sanitize(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        string path = raw.Trim();

        // Bỏ phần truy vấn và fragment: cắt ở '?'/'#' đầu tiên. Đường
        // dẫn thật không bao giờ chứa hai ký tự này (URL API đã tách
        // chúng khỏi pathname); cắt ở đây để dòng JSONL viết tay cũng
        // không lọt query/fragment vào database.
        int queryAt = path.IndexOf('?');
        if (queryAt >= 0)
        {
            path = path[..queryAt];
        }

        int hashAt = path.IndexOf('#');
        if (hashAt >= 0)
        {
            path = path[..hashAt];
        }

        // Đường dẫn thật luôn bắt đầu bằng '/'. Chuỗi không bắt đầu bằng
        // '/' (kể cả URL đầy đủ "https://...") thì bỏ, không đoán.
        if (path.Length == 0 || path[0] != '/')
        {
            return null;
        }

        foreach (char c in path)
        {
            if (char.IsControl(c))
            {
                return null;
            }
        }

        if (path.Length > MaxLength)
        {
            path = path[..MaxLength];
            // Không chẻ đôi cặp surrogate ở cuối chuỗi đã cắt.
            if (char.IsHighSurrogate(path[^1]))
            {
                path = path[..^1];
            }
        }

        return path;
    }
}
