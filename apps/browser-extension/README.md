# SafePC — Browser Extension (Chrome / Edge)

> **Trạng thái: đã triển khai thật ở Sprint 2 đợt 2 (chặn domain, giới hạn
> thời gian theo domain, SafeSearch, báo cáo domain đã thăm).** Extension
> chạy Manifest V3, JavaScript thuần, **không có bước build** — load trực
> tiếp dạng unpacked từ thư mục này.

## 1. Mục đích

Extension là lớp lọc web trên trình duyệt của máy con, chạy cùng PC Agent
và Dashboard phụ huynh (xem `docs/02-ARCHITECTURE.md` mục 4.5).

Extension làm:

- Chặn domain trong danh sách chặn, chặn theo khung giờ, chỉ cho phép danh
  sách domain (chế độ allowlist), chỉ cho phép danh sách domain theo khung
  giờ (chế độ allowlist theo giờ), chặn tạm thời / cho phép tạm thời.
- Chặn theo danh mục (từ 0.1.8): phụ huynh chọn danh mục (nội dung người
  lớn, cờ bạc, mạng xã hội) trong rule "Chặn website" thay vì gõ từng
  domain; Agent mở rộng danh mục thành domain và extension hiện đúng lý do
  theo danh mục trên trang chặn. Danh sách domain của từng danh mục là
  danh sách hạt giống trong Agent (xem mục 7), không phải danh sách đầy đủ.
- Nút xin mở trang trên trang chặn (từ 0.1.9): con bấm nút để gửi yêu cầu
  mở tên miền đang bị chặn tới phụ huynh (chỉ tên miền, không URL); phụ
  huynh duyệt trên trang Yêu cầu kèm thời lượng, lệnh cho phép tạm thời
  xuống máy trong ~15 giây và extension làm mới trong ~1 phút, con quay
  lại rồi mở lại trang thì vào được.
- Giờ học tập trung: trong khung giờ học, chỉ các website học tập được phép
  mới mở được (xem mục 7).
- Giới hạn thời gian xem theo domain (ví dụ: YouTube 30 phút/ngày), tính
  theo ngày địa phương của máy con.
- Bật SafeSearch cho Google/Bing và chế độ hạn chế (Restricted Mode) cho
  YouTube.
- Báo cáo **chỉ domain + thời lượng xem** về backend để phụ huynh xem báo
  cáo.

Extension không thay thế PC Agent: giới hạn giờ dùng máy, chặn app, khóa
máy vẫn do Agent trên Windows đảm nhiệm.

## 2. Luồng quy tắc và dữ liệu

```
Dashboard (phụ huynh đặt rule type=website)
  -> Supabase (bảng rules)
  -> PC Agent Service (đồng bộ rules mỗi phút, cache SQLite)
  -> DomainRulesPublisher ghi %ProgramData%\SafePC\shared\domain_rules.json
  -> NativeHost (SafePC.Agent.NativeHost.exe, giao thức stdio)
  -> Extension (getRules mỗi phút) -> declarativeNetRequest dynamic rules

Extension đếm thời gian xem theo domain
  -> NativeHost (reportUsage mỗi phút) -> web_usage.jsonl
  -> PC Agent (đọc mỗi 5 phút) -> RPC safepc_push_web_visits -> bảng web_visits

Lượt web bị chặn (từ 0.1.7) đi cùng kênh reportUsage đó, với `blocked: true`
và thời lượng 0. Cả hai đường tới trang chặn đều ghi theo domain của rule
đã khớp (đơn vị phụ huynh đã đặt): watcher đánh giá lại URL vừa chuyển để
lấy domain rule (dự phòng hostname khi không xác định được rule); redirect
DNR thì quy chiếu domain qua rule vừa khớp (`getMatchedRules`). Không quy
chiếu được (rule chặn-tất-cả của focus / allowlist) thì bỏ qua, không đoán
domain — số lượt chặn là cận dưới.
```

Extension **không** nói chuyện trực tiếp với Supabase, không có secret/key
nào, không đọc được database hay token của Agent. NativeHost chỉ đọc/ghi
trong thư mục `shared/` — xem `docs/03-SECURITY.md`.

## 3. Cài đặt (load unpacked)

Yêu cầu: đã cài SafePC Agent trên máy (bộ cài đăng ký native messaging host
cho Chrome/Edge). Nếu chưa cài Agent, extension vẫn load được nhưng popup
báo "chưa kết nối" và không chặn gì (fail-open — xem mục 7).

**Chrome:**

1. Mở `chrome://extensions/`.
2. Bật **Developer mode** (Chế độ dành cho nhà phát triển) ở góc trên bên phải.
3. Bấm **Load unpacked** (Tải tiện ích đã giải nén).
4. Chọn thư mục `apps/browser-extension/` (thư mục chứa `manifest.json`).
5. Extension `SafePC` xuất hiện trong danh sách. Bấm icon SafePC trên thanh
   công cụ: nếu Agent đã chạy, popup hiện "SafePC đang bảo vệ trình duyệt
   này".

**Edge:**

1. Mở `edge://extensions/`.
2. Bật **Developer mode** ở góc dưới bên trái.
3. Bấm **Load unpacked**, chọn thư mục `apps/browser-extension/`.
4. Kiểm tra tương tự như Chrome.

> Chưa kiểm chứng: các bước trên chưa được load thử trên Chrome/Edge thật
> trong đợt này (môi trường làm việc không có trình duyệt để test). Người
> kiểm tra tự làm trên máy thật và ghi lại lỗi nếu có.

## 4. Extension ID và manifest của NativeHost (quan trọng)

Manifest của NativeHost (`com.safepc.agent.json`, do bộ cài sinh ra) có
trường `allowed_origins` liệt kê extension ID được phép kết nối. Hiện tại
manifest dùng **ID placeholder `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`** (32 ký
tự `a`, đúng định dạng ID của Chrome).

**ID placeholder này KHÔNG khớp với bản load unpacked**: Chrome sinh ID cho
bản unpacked từ đường dẫn thư mục, nên bản unpacked sẽ bị NativeHost từ
chối cho tới khi một trong hai việc xảy ra:

- Đăng extension lên Chrome Web Store / Edge Add-ons: store cấp ID thật,
  cập nhật ID đó vào script bộ cài (`SafePCAgent.iss`,
  `WriteNativeHostManifest`) rồi cài lại Agent; hoặc
- Đóng gói extension với key cố định (file `.pem` riêng, giữ bí mật): ID
  suy ra từ public key, ổn định qua các lần cài — cập nhật ID đó vào script
  bộ cài như trên.

Cho tới khi có ID thật, muốn test đầu-cuối trên máy thật thì sửa
`allowed_origins` trong file manifest đã cài
(`C:\Program Files\SafePC Agent\NativeHost\com.safepc.agent.json`) thành ID
của bản unpacked (xem ở `chrome://extensions/`), rồi khởi động lại trình
duyệt. Đây là bước test thủ công, không phải cấu hình phân phối.

## 5. Quyền (permissions) và lý do

`manifest.json` xin đúng 5 quyền:

| Quyền | Lý do |
|---|---|
| `declarativeNetRequest` | Chặn/chuyển hướng theo rules khai báo, không đọc nội dung request. Không xin `declarativeNetRequestFeedback` (không cần đếm rule khớp). |
| `tabs` | Đọc `tab.url` của tab đang hiển thị để lấy **hostname** phục vụ đếm thời gian xem. URL đầy đủ bị bỏ ngay sau khi lấy hostname; không lưu, không log, không gửi URL. |
| `alarms` | Lấy rules mỗi phút, đánh giá khung giờ/ngân sách, báo cáo usage mỗi phút. Service worker MV3 không chạy liên tục nên cần alarm để tỉnh dậy. |
| `storage` | Lưu thời gian đã dùng hôm nay, hàng đợi usage chưa gửi, limits và trạng thái kết nối cho popup. Chỉ lưu trên máy, không đồng bộ cloud. |
| `nativeMessaging` | Trao đổi message với NativeHost của Agent (lấy rules, gửi usage). |

**Không xin thêm:** không `webRequest`, không `cookies`, không quyền đọc
nội dung trang, không quyền đọc lịch sử.

`host_permissions` xin `http://*/*` + `https://*/*` **vì rule chuyển hướng
(redirect) BẮT BUỘC phải có** (tìm ra 18/11/2026 khi rule
tse.edu.vn/p không chặn được dù đã nằm trong bộ máy DNR): theo tài liệu
của Chromium, quyền `declarativeNetRequest` chỉ cho chặn (block) và nâng cấp scheme mà không
cần host permissions; muốn chuyển hướng request (hoặc sửa header) thì
extension phải có host permission khớp URL của request — thiếu thì trình
duyệt BỎ QUA rule chuyển hướng một cách lặng lẽ (rule vẫn cài thành công,
`getDynamicRules()` vẫn liệt kê, không lỗi nào được báo). Triệu chứng trên
máy thật: rule chặn đường dẫn (regexFilter) "nằm trong bộ máy" nhưng trang
vẫn mở, và trang chặn SafePC không bao giờ hiện. Host permissions ở đây chỉ
cho phép bộ máy DNR áp rule chuyển hướng; extension vẫn không đọc nội dung
trang hay lịch sử. Trang chặn `blocked.html` được khai báo trong
`web_accessible_resources` (khớp `http://*/*`, `https://*/*`) để trình
duyệt được phép chuyển hướng tới.

## 6. Nguyên tắc chỉ domain

- Chỉ xử lý, lưu và gửi **domain** (hostname đã chữ thường), ví dụ
  `youtube.com`, kèm thời lượng xem (giây). Cắt bỏ path và query trước khi
  lưu/log/gửi: từ `https://www.youtube.com/results?search_query=...` chỉ
  giữ `www.youtube.com`.
- **Không bỏ tiền tố `www`**: `www.youtube.com` và `youtube.com` là hai
  hostname khác nhau, được ghi nhận đúng như hostname thật. Rule
  `youtube.com` vẫn khớp cả hai nhờ khớp hậu tố (rule khớp hostname bằng
  chính nó hoặc kết thúc bằng `.` + rule), nhưng **không** khớp
  `notyoutube.com`.
- Không gửi full URL lên server. Không log full URL (kể cả `console`).
- Không đọc tiêu đề cửa sổ, nội dung trang, phím gõ, mic, camera.
- Bảng đích ở backend là `web_visits` (`device_id`, `child_id`, `domain`,
  `visited_at`, `duration_sec`, `blocked`) — xem `docs/02-ARCHITECTURE.md`
  mục 3. Bảng này chỉ có cột `domain`, không có cột full URL.

## 7. Cách hoạt động (chi tiết) và giới hạn thành thật

**Chặn:** background service worker lấy rules mỗi phút và dựng lại toàn bộ
dynamic rules (xóa cũ, thêm mới). Chặn theo giờ được đánh giá theo giờ
địa phương lúc dựng rules; ranh giới khung giờ có hiệu lực trong vòng ~1
phút. Trang bị chặn chuyển hướng tới `blocked.html` với lý do tiếng Việt.
Ghi đè tạm thời (cho phép/chặn domain xx phút) do Agent đưa vào file rules
kèm thời điểm hết hạn tuyệt đối; extension chỉ áp dụng khi còn hạn.

**Ngân sách theo domain:** extension đếm thời gian tab đang hiển thị *và*
cửa sổ trình duyệt đang focus, cộng dồn theo hostname trong ngày địa
phương. Hết ngân sách thì domain bị chặn tới ngày hôm sau. Thời lượng tính
bằng hiệu timestamp nên tổng vẫn đúng dù service worker ngủ đông; mỗi đoạn
xem tính tối đa 10 phút để máy sleep không làm phình số liệu.

**SafeSearch:** tìm kiếm Google được redirect thêm `safe=active` vào đầu
query (giữ nguyên phần còn lại) bằng `regexSubstitution`; rule chỉ khớp URL
chưa có `safe=active` ở đầu query nên không lặp redirect (RE2 không có
lookahead — xem chú thích trong `background.js`). Bing không dùng tham số
`safe` mà dùng `adlt=strict` (cơ chế chính thức của Bing) nên rule cho Bing
thêm `adlt=strict`. YouTube (`www`/`m`) được redirect sang
`restrict.youtube.com` giữ nguyên path+query (cơ chế Restricted Mode chính
thức của Google).

**Giờ học tập trung (focus mode):** phụ huynh đặt rule website chế độ
`focus` trên Dashboard (khung giờ theo thứ + website và ứng dụng được phép).
Agent gộp các rule focus thành `rules.focus = {"windowsByWeekday": {...},
"allowedDomains": [...]}` (hoặc `null` khi không có rule nào) trong
`domain_rules.json`; phần ứng dụng được phép (`allowedApps`) do Agent thi
hành (đóng ứng dụng ngoài danh sách), extension chỉ nhận danh sách domain.
Trong khung giờ focus (giờ địa phương, đánh giá lại mỗi ~1 phút cùng chu kỳ
alarm), extension bỏ qua các bộ rule thường (chặn, chặn theo giờ, hết ngân
sách, allowlist) và chỉ cho phép các domain trong danh sách focus — mọi
website còn lại chuyển tới `blocked.html` với lý do "focus". Thứ tự ưu tiên:
**chặn tạm thời vẫn thắng** danh sách cho phép của focus (domain bị chặn tạm
thời thì vẫn bị chặn); **cho phép tạm thời không chọc thủng focus** (website
ngoài danh sách focus vẫn bị chặn dù đang được cho phép tạm thời). Redirect
SafeSearch và YouTube Restricted vẫn áp dụng trong giờ focus (chúng chỉ thêm
tham số an toàn, không mở thêm website nào). Ngoài khung giờ focus, mọi hành
vi trở lại như cũ. Khi `rules.focus` thiếu, `null`, sai hình dạng hoặc danh
sách cho phép rỗng, extension coi như không có focus (fail-open, không chặn
thêm gì vì focus). Trang chặn của chính extension không bị ảnh hưởng vì rule
chặn-tất-cả chỉ khớp URL http/https.

**Danh sách cho phép theo giờ (allowlist theo giờ):** phụ huynh đặt rule
website chế độ `allowlist_by_time` trên Dashboard (danh sách domain + khung
giờ theo thứ). Agent xuất các rule này thành
`rules.allowlistByTime = [{"domains": [...], "windowsByWeekday": {...}}, ...]`
trong `domain_rules.json`. Trong khung giờ (giờ địa phương, đánh giá lại mỗi
~1 phút cùng chu kỳ alarm), extension chỉ cho phép các domain trong danh
sách — mọi website còn lại chuyển tới `blocked.html` với lý do "allowlist"
(dùng chung thông báo với chế độ allowlist thường). Ngoài khung giờ, rule
không giới hạn website nào. Khi allowlist theo giờ đang hiệu lực, nó THAY
cho allowlist thường (chỉ domain trong danh sách theo giờ mới mở được); khi
hết khung giờ, allowlist thường (nếu có) áp dụng lại. Giờ học tập trung vẫn
áp đảo allowlist theo giờ (xem thang ưu tiên bên dưới). Khi
`rules.allowlistByTime` thiếu, sai hình dạng, khung giờ không hợp lệ hoặc
không còn domain nào sau khi chuẩn hóa, extension coi như không có
allowlist theo giờ (fail-open, không chặn thêm gì).

**Chặn theo danh mục (từ 0.1.8):** rule website chế độ `block_domains` có
thể mang mảng `categories` (id danh mục: `adult`, `gambling`, `social`).
Agent mở rộng mỗi danh mục thành danh sách domain hạt giống
(`DomainCategoryLists` trong `SafePC.Agent.Service`), hợp vào `blocked`
(cùng mức ưu tiên chặn 30 — không đổi thang DNR) và ghi riêng vào
`rules.blockedCategories` (domain theo từng danh mục) để extension hiện
đúng lý do trên trang chặn (`category-adult`, `category-gambling`,
`category-social`), cả đường DNR lẫn tab watcher. Danh mục chỉ có ở chế
độ "Chặn website"; danh mục trong mode khác bị Agent bỏ qua kèm Warning.
Giới hạn thành thật: danh sách hạt giống chỉ gồm các website nổi tiếng
nhất, không phải danh sách đầy đủ — website cờ bạc đổi domain mirror liên
tục và website mới sẽ lọt; nhập danh sách công khai đầy đủ là việc riêng
sau này. Danh mục không thay thế được việc phụ huynh gõ thêm domain cụ
thể trong cùng quy tắc.

**Thang ưu tiên DNR (đã khóa — số lớn thắng):** số ưu tiên trong
`background.js` (`PRIORITY`) khớp đúng thang này; Dashboard/PC Agent dùng
cùng thang khi nói về thứ tự thi hành.

| Ưu tiên | Bộ rule | Ghi chú |
|---|---|---|
| 100 | Chặn tạm thời | Luôn áp dụng, kể cả trong giờ tập trung. |
| 65 | Redirect SafeSearch / YouTube Restricted | Chỉ thêm tham số an toàn; URL sau redirect được đánh giá lại nên rule chặn vẫn chặn được. |
| 60 | Giờ tập trung: domain được phép | |
| 59 / 58 | Giờ tập trung: chặn tất cả còn lại | Cao hơn cho phép tạm thời (57) nên cho phép tạm thời không chọc thủng giờ tập trung. |
| 57 | Cho phép tạm thời | Chọc thủng chặn/chặn theo giờ/allowlist/allowlist theo giờ/hết ngân sách, nhưng không chọc thủng giờ tập trung. |
| 55 | Allowlist theo giờ: domain được phép | Đang hiệu lực thì thay cho allowlist thường. |
| 50 | Allowlist: domain được phép | |
| 40 | Chặn theo giờ | |
| 30 | Chặn | Gồm cả domain thuộc danh mục đã chọn; lý do trên trang chặn hiện theo danh mục. |
| 20 | Hết ngân sách theo domain | |
| 15 / 14 | Allowlist / allowlist theo giờ: chặn tất cả còn lại | Thấp hơn mọi mức chặn cụ thể để domain bị chặn/hết ngân sách hiện đúng lý do của nó. |

Trong giờ tập trung, extension không dựng các bộ rule thường (chặn, chặn
theo giờ, hết ngân sách, allowlist, allowlist theo giờ) và không dựng rule
cho phép tạm thời — focus áp đảo bằng cấu trúc, không chỉ bằng số ưu tiên.
Chặn tạm thời là ngoại lệ duy nhất: luôn được dựng. Trang chặn của chính
extension không bị ảnh hưởng vì rule chặn-tất-cả chỉ khớp URL http/https.

**Báo cáo:** usage gửi mỗi phút qua NativeHost; gửi lỗi thì giữ lại trong
hàng đợi (tối đa 1000 domain, bỏ cũ nhất), không hiện lỗi cho user.

**Giới hạn thành thật:**

- Khi chưa nối được NativeHost (chưa cài Agent, manifest sai ID, Agent
  chưa chạy), extension **mở** (không chặn gì) và popup báo chưa kết nối.
  Đây là lựa chọn có chủ đích: chặn tất cả khi Agent lỗi sẽ khóa luôn trình
  duyệt khi Agent bị gỡ nhưng extension còn lại.
- Tài khoản Standard User **có thể tắt/gỡ bản unpacked** trong
  `chrome://extensions/`. Lộ trình cứng hóa: đăng extension lên store rồi
  ép cài bằng chính sách `ExtensionInstallForcelist` — **chưa triển khai**
  trong đợt này, không tự ý triển khai chính sách registry trong bộ cài.
- Extension chỉ bảo vệ Chrome/Edge có cài nó; trình duyệt khác, chế độ
  ẩn danh (nếu không bật "Allow in Incognito"), hoặc DNS/VPN đều nằm ngoài
  phạm vi đợt này.
- Đếm thời gian dựa vào tab hiển thị + focus: video chạy nền ở tab không
  hiển thị không được tính.

## 8. Cấu trúc

```
apps/browser-extension/
├── README.md          — Tài liệu này.
├── manifest.json      — Manifest V3 (Chrome + Edge), 5 quyền + host_permissions http/https (redirect bắt buộc phải có, xem §5).
├── domainUtils.js     — Helper domain dùng chung (chuẩn hóa, khớp hậu tố,
│                        lấy hostname, khóa ngày địa phương). Không build.
├── background.js      — Service worker: lấy rules, dựng DNR rules, đếm giờ,
│                        báo cáo usage. Không fetch, không Supabase.
├── blocked.html       — Trang chặn tiếng Việt (không tải tài nguyên ngoài).
├── blocked.js         — Hiển thị lý do chặn theo ?reason=.
├── popup.html         — Popup: trạng thái + phút đã dùng hôm nay.
├── popup.js           — Popup: chỉ đọc chrome.storage.local, không đọc tab.
└── icons/
    └── icon.svg       — Icon khiên đơn giản tự vẽ (placeholder).
```

Không có `package.json`, không có bước build. Kiểm tra cú pháp:
`node --check` từng file `.js`, và `manifest.json` phải parse được JSON.
File `rules.json` của khung stub cũ đã bỏ (rules giờ là dynamic rules do
`background.js` dựng từ file của Agent).

## 9. Tài liệu tham chiếu

- `docs/01-PRD.md` mục 2.5 (lọc web MVP) và mục 5 (không làm).
- `docs/02-ARCHITECTURE.md` mục 4.5 (luồng lọc web qua extension).
- `docs/03-SECURITY.md` mục 3 (chỉ lưu domain, cắt path/query)
  và mục 4 (quyền tối thiểu, ranh giới NativeHost, ACL file chia sẻ).
