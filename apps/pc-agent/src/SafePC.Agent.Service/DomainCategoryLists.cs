namespace SafePC.Agent.Service;

/// <summary>
/// Danh sách domain hạt giống theo danh mục chặn (PRD §2.8: chặn theo danh
/// mục domain — người lớn, cờ bạc, mạng xã hội — thay vì gõ từng domain).
///
/// NGUỒN DANH SÁCH — ĐỌC KỸ TRƯỚC KHI SỬA: đây là danh sách HẠT GIỐNG do
/// người làm SafePC chọn tay từ các website nổi tiếng nhất của từng danh
/// mục, KHÔNG phải danh sách công khai đầy đủ (hàng nghìn domain). PRD ghi
/// "từ danh sách công khai" — việc nhập một danh sách công khai đầy đủ
/// (ví dụ StevenBlack unified hosts, hoặc danh sách phân loại của một dự
/// án lọc nội dung) là follow-up riêng, vì danh sách lớn cần quy trình cập
/// nhật + kiểm tra định kỳ, không thể nhét tay vào code. Hạt giống này đủ
/// để tính năng chạy đầu-cuối và chặn được các website phổ biến nhất; phụ
/// huynh vẫn gõ thêm domain tay trong cùng quy tắc.
///
/// GIỚI HẠN ĐÃ BIẾT (ghi rõ để không ai hiểu nhầm là chặn tuyệt đối):
/// - Website cờ bạc châu Á đổi domain mirror liên tục (w88/fun88/fb88/m88
///   dùng nhiều domain thay thế); danh sách chỉ có domain thương hiệu
///   chính, mirror mới sẽ lọt cho tới khi được thêm tay.
/// - Website mới / ít tên tuổi không có trong danh sách. Danh mục không
///   thay thế được việc phụ huynh gõ thêm domain cụ thể.
/// - Khớp theo hậu tố như mọi rule domain khác (rule "facebook.com" chặn
///   cả "www.facebook.com"), nhờ extension khớp requestDomains.
///
/// HỢP ĐỒNG LIÊN DỰ ÁN: id danh mục ("adult", "gambling", "social") phải
/// khớp đúng với metadata danh mục phía Dashboard
/// (apps/dashboard-web/src/lib/ruleConfig.ts, DOMAIN_CATEGORIES) và với
/// lý do trang chặn phía extension (blocked.js, "category-&lt;id&gt;").
/// Thêm danh mục mới thì thêm ở cả ba nơi. Id lạ trong config rule thì
/// DomainRulesPublisher bỏ qua kèm Warning (fail-open, không vỡ lần xuất
/// bản). Mọi domain trong danh sách đều đã là chữ thường, dạng hợp lệ
/// (đúng điều kiện IsValidDomain của publisher) — kiểm tra bằng harness
/// của đợt này, không chuẩn hóa lại lúc chạy.
/// </summary>
internal static class DomainCategoryLists
{
    /// <summary>
    /// Thứ tự chuẩn của danh mục. Publisher dùng thứ tự này để xuất file
    /// determinist; extension dùng thứ tự này để giải quyết chồng lấn (một
    /// domain thuộc hai danh mục thì hiện lý do của danh mục đứng trước).
    /// </summary>
    public static readonly string[] OrderedIds = { "adult", "gambling", "social" };

    /// <summary>Danh sách domain hạt giống theo id danh mục. Chỉ đọc, không sửa lúc chạy.</summary>
    public static readonly IReadOnlyDictionary<string, string[]> ById =
        new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            ["adult"] = new[]
            {
                "brazzers.com",
                "cam4.com",
                "chaturbate.com",
                "livejasmin.com",
                "onlyfans.com",
                "porn.com",
                "pornhub.com",
                "redtube.com",
                "spankbang.com",
                "stripchat.com",
                "xhamster.com",
                "xnxx.com",
                "xvideos.com",
                "youporn.com",
            },
            ["gambling"] = new[]
            {
                "12bet.com",
                "188bet.com",
                "1xbet.com",
                "888.com",
                "bet365.com",
                "betfair.com",
                "betfred.com",
                "betway.com",
                "bwin.com",
                "dafabet.com",
                "draftkings.com",
                "fanduel.com",
                "fb88.com",
                "fun88.com",
                "ladbrokes.com",
                "m88.com",
                "paddypower.com",
                "pokerstars.com",
                "skybet.com",
                "stake.com",
                "unibet.com",
                "w88.com",
                "williamhill.com",
            },
            ["social"] = new[]
            {
                "discord.com",
                "facebook.com",
                "instagram.com",
                "linkedin.com",
                "messenger.com",
                "pinterest.com",
                "reddit.com",
                "snapchat.com",
                "telegram.org",
                "threads.net",
                "tiktok.com",
                "tumblr.com",
                "twitter.com",
                "vk.com",
                "whatsapp.com",
                "x.com",
                "zalo.me",
            },
        };

    /// <summary>Id danh mục có trong danh sách hạt giống không.</summary>
    public static bool IsKnown(string? id) => id is not null && ById.ContainsKey(id);
}
