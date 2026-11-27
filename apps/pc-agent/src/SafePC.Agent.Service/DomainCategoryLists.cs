using System.Reflection;
using SafePC.Agent.Shared;

namespace SafePC.Agent.Service;

/// <summary>
/// Danh sách domain theo danh mục chặn (PRD §2.8: chặn theo danh mục
/// domain thay vì gõ từng domain). Sáu danh mục: người lớn, cờ bạc, bạo
/// lực, game, phim, mạng xã hội.
///
/// NGUỒN DỮ LIỆU (đợt nhập list công khai 27/11/2026 — xem
/// docs/10-DATA-SOURCES.md): dữ liệu KHÔNG còn viết tay trong code. Mỗi
/// danh mục là một file text nhúng (embedded resource) trong assembly
/// SafePC.Agent.Shared — thư mục CategoryData cạnh project Shared — sinh
/// tự động bởi script tools/import-category-lists/import.mjs từ ba nguồn
/// giấy phép sạch: StevenBlack/hosts (MIT), UT1 Blocklist của Université
/// Toulouse Capitole (CC BY-SA 4.0, ghi công trong header từng file dữ
/// liệu) và The Block List Project (Unlicense). Script chọn lọc theo
/// ngân sách từng nhóm (tổng ~19.500 domain vì trần ~30.000 dynamic
/// rules của Declarative Net Request phía extension), luôn giữ 54 domain
/// hạt giống viết tay ban đầu, và áp danh sách bảo vệ (domain học tập /
/// tin tức / tìm kiếm không bao giờ bị xếp vào nhóm chặn). Cập nhật dữ
/// liệu = chạy lại script rồi build lại Agent, KHÔNG sửa file dữ liệu
/// bằng tay.
///
/// GIỚI HẠN ĐÃ BIẾT (ghi rõ để không ai hiểu nhầm là chặn tuyệt đối):
/// - Website cờ bạc châu Á đổi domain mirror liên tục; danh sách chỉ phủ
///   các domain phổ biến nhất tại thời điểm nhập, mirror mới sẽ lọt cho
///   tới lần cập nhật dữ liệu kế tiếp hoặc khi phụ huynh gõ thêm tay.
/// - Hai nhóm game/phim lấy từ dữ liệu PHÂN LOẠI của UT1 (không phải
///   danh sách "phải chặn"): có lẫn nền tảng hợp lệ (ví dụ Steam,
///   Netflix) — chỉ bật khi phụ huynh chủ động chọn nhóm, và allowlist /
///   duyệt xin mở của phụ huynh luôn thắng. Danh sách domain nhạy cảm
///   tiêu biểu nằm trong docs/10-DATA-SOURCES.md.
/// - Khớp theo hậu tố như mọi rule domain khác (rule "facebook.com" chặn
///   cả "www.facebook.com"), nhờ extension khớp requestDomains; vì vậy
///   dữ liệu đã gộp bỏ các tên miền con bị domain cha phủ.
///
/// HỢP ĐỒNG LIÊN DỰ ÁN: id danh mục phải khớp đúng với metadata danh mục
/// phía Dashboard (apps/dashboard-web/src/lib/ruleConfig.ts,
/// DOMAIN_CATEGORIES) và với lý do trang chặn phía extension (blocked.js,
/// "category-&lt;id&gt;"), kể cả THỨ TỰ ưu tiên lý do khi một domain
/// thuộc nhiều nhóm. Thêm danh mục mới thì thêm ở cả ba nơi. Id lạ trong
/// config rule thì DomainRulesPublisher bỏ qua kèm Warning (fail-open,
/// không vỡ lần xuất bản). Mọi domain trong dữ liệu đều đã chuẩn hoá
/// (chữ thường, đúng điều kiện IsValidDomain của publisher) bởi script
/// nhập — kiểm tra bằng cổng của đợt này, không chuẩn hóa lại lúc chạy.
/// </summary>
internal static class DomainCategoryLists
{
    /// <summary>
    /// Thứ tự chuẩn của danh mục — đồng thời là thứ tự ƯU TIÊN: khi một
    /// domain xuất hiện ở nhiều nhóm nguồn, script nhập chỉ xếp nó vào
    /// nhóm đứng trước nhất trong thứ tự này. Publisher dùng thứ tự này
    /// để xuất file determinist; extension dùng thứ tự này để giải
    /// quyết chồng lấn lý do trên trang chặn.
    /// </summary>
    public static readonly string[] OrderedIds = { "adult", "gambling", "violence", "games", "movies", "social" };

    /// <summary>Nhãn tiếng Việt của từng danh mục (khớp nhãn phía Dashboard).</summary>
    public static readonly IReadOnlyDictionary<string, string> Labels =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["adult"] = "Nội dung người lớn",
            ["gambling"] = "Cờ bạc, cá cược",
            ["violence"] = "Bạo lực",
            ["games"] = "Game",
            ["movies"] = "Phim",
            ["social"] = "Mạng xã hội",
        };

    /// <summary>Danh sách domain theo id danh mục, nạp từ embedded resource lúc khởi tạo. Chỉ đọc, không sửa lúc chạy.</summary>
    public static readonly IReadOnlyDictionary<string, string[]> ById = LoadAll();

    private static IReadOnlyDictionary<string, string[]> LoadAll()
    {
        var result = new Dictionary<string, string[]>(StringComparer.Ordinal);
        Assembly assembly = typeof(AgentConstants).Assembly;
        foreach (string id in OrderedIds)
        {
            result[id] = LoadOne(assembly, id);
        }

        return result;
    }

    /// <summary>
    /// Đọc một file dữ liệu danh mục từ embedded resource của assembly
    /// Shared: bỏ 3 dòng comment đầu (mọi dòng bắt đầu bằng '#'), bỏ dòng
    /// trống, giữ nguyên thứ tự đã sắp xếp trong file. Resource thiếu
    /// (lỗi đóng gói) thì trả mảng rỗng để Service vẫn chạy — danh mục đó
    /// coi như không có domain nào, publisher ghi log số lượng 0.
    /// </summary>
    private static string[] LoadOne(Assembly assembly, string id)
    {
        string resourceName = "SafePC.Agent.Shared.CategoryData." + id + ".txt";
        using Stream? stream = assembly.GetManifestResourceStream(resourceName);
        if (stream is null)
        {
            return Array.Empty<string>();
        }

        using var reader = new StreamReader(stream);
        var domains = new List<string>();
        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            string value = line.Trim();
            if (value.Length == 0 || value.StartsWith('#'))
            {
                continue;
            }

            domains.Add(value);
        }

        return domains.ToArray();
    }

    /// <summary>Id danh mục có trong danh sách không.</summary>
    public static bool IsKnown(string? id) => id is not null && ById.ContainsKey(id);
}
