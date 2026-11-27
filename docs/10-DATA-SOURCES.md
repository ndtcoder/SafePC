# 10 — Nguồn dữ liệu danh mục domain & từ khóa (Data Sources)

Tài liệu này ghi lại nguồn gốc, giấy phép và phương pháp chọn lọc của
dữ liệu phân loại dùng trong SafePC: (a) danh sách **domain theo 6 nhóm**
chặn (người lớn, cờ bạc, bạo lực, game, phim, mạng xã hội) phía Agent và
(b) phần bổ sung **từ khóa tìm kiếm** phía Dashboard. Mọi dữ liệu đều
được nhập ở bước build bằng script `tools/import-category-lists/`
(không tải trực tiếp trên máy con), theo quyết định giấy phép của chủ
sản phẩm ngày 27/11/2026: **chỉ dùng nguồn sạch** — StevenBlack (MIT),
UT1 Toulouse (CC BY-SA 4.0), Block List Project (Unlicense); **không**
dùng HaGeZi/OISD (GPL-3.0) và Energized (CC BY-NC-SA — yếu tố cấm thương
mại).

## 1. Nguồn domain

| Nguồn | URL | Giấy phép | Phần được dùng |
|---|---|---|---|
| StevenBlack/hosts | https://github.com/StevenBlack/hosts — file `alternates/porn-only/hosts`, `alternates/gambling-only/hosts`, `alternates/social-only/hosts` | MIT | adult, gambling, social |
| UT1 Blocklist — Université Toulouse Capitole | https://dsi.ut-capitole.fr/blacklists/download/`<category>.tar.gz` | **CC BY-SA 4.0** — bắt buộc ghi công; phần dữ liệu phái sinh (đã chọn lọc) của SafePC cũng phát hành theo CC BY-SA 4.0 | gambling; games; audio-video + warez (→ movies); agressif + dangerous_material (→ violence); social_networks + chat (→ social); adult (chỉ đối chiếu) |
| The Block List Project | https://blocklistproject.github.io/Lists/ (`porn.txt`, `gambling.txt`, `facebook.txt`, `tiktok.txt`, `twitter.txt`, `whatsapp.txt`) | Unlicense (public domain) | adult, gambling, social |
| Tranco top-1M | https://tranco-list.eu/top-1m.csv.zip | Dữ liệu xếp hạng công khai (chỉ dùng làm tín hiệu phổ biến khi chọn lọc, không phân phối lại) | xếp hạng ứng viên |

**Ghi công UT1 (attribution):** dữ liệu phân loại của các nhóm gambling,
violence, games, movies và một phần social trong SafePC được trích từ
**UT1 Blocklist — Université Toulouse Capitole**
(http://dsi.ut-capitole.fr/blacklists/), phát hành theo giấy phép
Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA
4.0). Dòng ghi công này cũng nằm trong header của từng file dữ liệu
`CategoryData/*.txt` trong bộ cài Agent.

Ngày nhập lần đầu: **27/11/2026**. Số liệu thô của lần nhập này nằm ở
`tools/import-category-lists/manifest.json`.

## 2. Phương pháp chọn lọc

Ngân sách đóng gói do trần rule của Declarative Net Request phía
extension: tổng ngân sách 19.500 domain (adult 8.000 / gambling 4.000 /
social 2.500 / movies 2.000 / games 2.500 / violence 500). Cách thi
hành hai tầng (extension 0.1.12):

- **Tầng DNR (chặn ở request, gồm cả tài nguyên phụ):** mỗi domain tốn
  2 rule (redirect + block). Nhóm rule chính có trần 10.000 rule —
  các loại rule khác (chặn theo giờ, giới hạn thời gian, SafeSearch,
  focus/allowlist, tạm thời) được dựng TRƯỚC và không bao giờ bị cắt;
  cặp rule domain dựng trong phần ngân sách còn lại, ưu tiên domain
  phụ huynh gõ tay rồi tới domain danh mục theo thứ tự ưu tiên nhóm.
  Trần 10.000 áp cho TỔNG cả ba nhóm rule DNR (chính + search ≤750 +
  SafeSearch ≤3 nằm trong cùng tổng đó) — tức tổng dynamic rules tối
  đa **10.000 < 30.000** (trần tối thiểu Chrome bảo đảm).
- **Tầng tab watcher (chặn ở điều hướng):** đối chiếu trên TOÀN BỘ
  danh sách domain đã phát xuống, nên mọi domain trong dữ liệu — kể cả
  phần vượt ngân sách DNR — vẫn bị chặn khi con điều hướng tới, với
  đúng lý do theo danh mục. Khác biệt duy nhất: trang có thể bắt đầu
  tải trong tích tắc trước khi bị chuyển hướng, và tài nguyên phụ của
  trang chưa kịp bị cắt ở tầng request.

Thứ tự ưu tiên khi chọn (minh bạch, script ghi thống kê vào manifest):

1. **54 domain hạt giống** viết tay ban đầu của SafePC — luôn giữ, thuộc
   nhóm của chúng, tính vào ngân sách.
2. Domain xuất hiện ở **≥2 nguồn độc lập** trong cùng nhóm.
3. Domain có **hạng Tranco top-1M** cao (phổ biến) trước.
4. **Thứ tự xuất hiện** trong list nguồn (StevenBlack > UT1 > BLP).

Chuẩn hoá: lowercase, bỏ tiền tố `www.`, chỉ giữ domain hợp lệ (bỏ IP,
bỏ domain nội bộ/một nhãn), khử trùng. Mỗi domain chỉ thuộc **đúng một
nhóm** — khi trùng giữa các nhóm, phân nhà theo thứ tự ưu tiên
adult > gambling > violence > games > movies > social. Tên miền con bị
gộp bỏ khi domain cha đã có trong cùng nhóm (extension khớp theo hậu
tố nên giữ bản con là thừa). Riêng UT1 `adult` (4,6 triệu domain do
crawl tự động): **chỉ đối chiếu dạng stream** — domain nào của pool
adult (StevenBlack ∪ Block List Project) có mặt trong UT1 adult thì
được tính thêm một nguồn cho tiêu chí (2); không nạp domain chỉ-có-ở-UT1
vào nhóm adult.

### Danh sách bảo vệ (không bao giờ bị chặn theo nhóm)

File `tools/import-category-lists/exclude.txt`: script loại các domain
này (và mọi tên miền con của chúng) khỏi mọi nhóm sau bước chọn lọc,
rồi lấp lại ngân sách. Gồm: công cụ tìm kiếm (google.com, google.com.vn,
bing.com, duckduckgo.com, cococ.com), youtube.com (đã có cơ chế riêng),
wikipedia.org + wikimedia.org, domain giáo dục/học tập (vio.edu.vn,
olm.vn, hocmai.vn, tuyensinh247.com, loigiaihay.com, vietjack.com,
khanacademy.org) và tin tức lớn (vnexpress.net, tuoitre.vn,
thannien.vn, dantri.com.vn, bbc.com, cnn.com). Lần nhập 27/11/2026,
danh sách bảo vệ đã loại: `youtube.com` khỏi nhóm movies và 5 tên miền
con của Google (plus.google.com, plusone.google.com, talk.google.com,
talkgadget.google.com, chatenabled.mail.google.com) khỏi nhóm social.

## 3. Số lượng mỗi nhóm (trước → sau đợt nhập 27/11/2026)

| Nhóm | Trước (hạt giống tay) | Pool ứng viên | Sau chọn lọc | Ngân sách |
|---|---|---|---|---|
| adult | 14 | 983.597 | **8.000** | 8.000 |
| gambling | 23 | 386.738 | **4.000** | 4.000 |
| violence | 0 (chưa có nhóm) | 301 | **296** | 500 |
| games | 0 (chưa có nhóm) | 33.652 | **2.500** | 2.500 |
| movies | 0 (chưa có nhóm) | 5.096 | **2.000** | 2.000 |
| social | 17 | 28.523 | **1.543** | 2.500 |
| **Tổng** | **54** | | **18.339** | **19.500** |

Ghi chú trung thực:

- Nhóm social đạt 1.543/2.500 dù pool 28.523: phần lớn pool là **tên
  miền con** của vài nền tảng lớn (riêng list Facebook của Block List
  Project có ~21 nghìn tên miền con) — sau khi gộp theo domain cha
  (26.929 mục bị gộp) chỉ còn 1.543 domain hiệu lực, và chừng đó đã phủ
  toàn bộ pool vì extension khớp theo hậu tố. Đây là giới hạn của dữ
  liệu nguồn, không phải lỗi chọn lọc.
- Nhóm violence chỉ có 296/500 vì toàn bộ dữ liệu nguồn sạch hiện có
  (UT1 agressif 266 + dangerous_material 35 sau chuẩn hoá) chỉ có 301
  domain; 5 domain bị nhóm ưu tiên cao hơn (adult/gambling) nhận trước.
- Số domain thô từng nguồn (sau chuẩn hoá, lần nhập 27/11/2026):
  StevenBlack porn 64.305 / gambling 5.186 / social 3.724; Block List
  Project porn 952.054 / gambling 342.623 / facebook 21.334 / tiktok
  3.694 / twitter 1.185 / whatsapp 225; UT1 gambling 95.180 / games
  33.652 / audio-video 3.620 / warez 1.532 / agressif 266 /
  dangerous_material 35 / social_networks 715 / chat 195; UT1 adult đối
  chiếu 4.599.292 dòng, khớp 589.996 domain của pool adult. (Số của UT1
  gambling cao hơn con số 38.262 trên trang web của UT1 — số ở đây đếm
  trực tiếp từ file `domains` tải về ngày nhập.)

## 4. Cảnh báo chặn nhầm (games / movies)

UT1 là dữ liệu **phân loại**, không phải danh sách "phải chặn". Hai
nhóm games và movies vì vậy chứa cả nền tảng/dịch vụ hợp lệ. Các domain
nhạy cảm tiêu biểu **có mặt** trong dữ liệu đã nhập (kiểm tự động mỗi
lần chạy script, ghi vào manifest):

- games: steampowered.com (Steam), itch.io, roblox.com, epicgames.com,
  battle.net, gog.com, origin.com.
- movies: netflix.com, hulu.com, disneyplus.com, spotify.com,
  twitch.tv, vimeo.com, dailymotion.com.

Cách SafePC xử lý: hai nhóm này **chỉ chặn khi phụ huynh chủ động tích
chọn** trong quy tắc; cơ chế allowlist và duyệt yêu cầu xin mở của phụ
huynh luôn thắng danh mục. Phụ huynh muốn con vẫn vào được một dịch vụ
hợp lệ trong nhóm thì thêm domain đó vào allowlist hoặc bỏ chọn nhóm.

## 5. Từ khóa tìm kiếm (bổ sung 27/11/2026)

- Nhóm **adult**: bổ sung 47 từ/cụm tiếng Anh + 13 cụm tiếng Việt vào
  danh sách mẫu trong `apps/dashboard-web/src/lib/ruleConfig.ts`. Phần
  tiếng Anh chọn lọc từ **LDNOOBW** (List of Dirty, Naughty, Obscene
  and Otherwise Bad Words — dự án do Shutterstock khởi xướng,
  https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words,
  giấy phép **CC BY 4.0** — ghi công Shutterstock/LDNOOBW tại đây).
  Kế hoạch ban đầu dùng bản LDNOOBW V2 (CC0) trên HuggingFace nhưng
  dataset đó bị giới hạn truy cập (gated) tại thời điểm nhập, nên dùng
  bản gốc kèm ghi công thay thế — cùng tiêu chí lọc. Tiêu chí: CHỈ lấy
  từ/cụm có nghĩa tình dục/tục tĩu là nghĩa duy nhất; loại từ đa nghĩa
  và loại cả từ ngắn có nguy cơ chặn nhầm vì extension đối chiếu theo
  chuỗi con trên cụm tìm kiếm đã bỏ dấu (ví dụ loại "anal" vì nằm trong
  "analysis", loại "địt" vì bỏ dấu thành "dit" nằm trong "credit").
  Phần tiếng Việt (13 cụm tường minh như "phim con heo", "phim cấp 3",
  "mại dâm", "truyện sex") do SafePC biên tập theo cùng tiêu chí.
- Nhóm **violence**: bổ sung 10 cụm tường minh (trong đó "how to kill"
  và "how to murder" cũng lấy từ LDNOOBW).
- Các nhóm **gambling / games / movies / social**: GIỮ NGUYÊN danh sách
  biên tập tay — không tồn tại danh sách từ khóa công khai đáng tin cho
  các chủ đề này (chúng là cụm từ theo ngữ cảnh, không phải "từ bẩn").
- Trần hiệu lực của một quy tắc từ khóa nâng từ 200 lên **400** từ
  (trần từ khóa riêng giữ nguyên 200): extension dùng DNR cho 150 từ
  đầu, tab watcher đối chiếu toàn bộ danh sách nên phần vượt 150 vẫn
  được thi hành.

## 6. Cách cập nhật lại dữ liệu

```bash
cd tools/import-category-lists
node import.mjs --force   # tải lại nguồn mới nhất và sinh lại dữ liệu
```

Sau đó build lại Agent (`dotnet build`) và Dashboard như quy trình
thường lệ, kiểm manifest mới (số lượng từng nhóm, danh sách domain nhạy
cảm, số bị danh sách bảo vệ loại) trước khi phát hành. Dữ liệu đóng gói
tĩnh theo bản Agent nên độ phủ giảm dần giữa hai lần cập nhật — nhóm cờ
bạc (mirror thay đổi nhanh) vẫn cần hạt giống tay bổ sung khi phụ huynh
báo domain lọt.
