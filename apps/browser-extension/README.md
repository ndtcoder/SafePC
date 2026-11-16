# SafePC — Browser Extension (Chrome / Edge)

> **Trạng thái: khung stub Sprint 3 — chưa có logic chặn/báo cáo thật.**
>
> Mọi file trong thư mục này hiện chỉ là khung tĩnh để kiểm tra cấu trúc
> Manifest V3. Extension chưa chặn domain nào, chưa báo cáo gì lên server,
> chưa kết nối Supabase, chưa thu thập URL hay nội dung nào.

## 1. Mục đích

Extension là lớp lọc web trên trình duyệt của máy con, chạy cùng PC Agent
và Dashboard phụ huynh (xem `docs/02-ARCHITECTURE.md`).

Nhiệm vụ khi hoàn thiện ở Sprint 3:

- Chặn domain nằm trong blocklist do phụ huynh đặt.
- Cho phép domain nằm trong allowlist do phụ huynh đặt.
- Báo cáo **chỉ domain** đã thăm về backend để phụ huynh xem báo cáo.

Extension không thay thế PC Agent: giới hạn giờ, chặn app, khóa máy vẫn
do Agent trên Windows đảm nhiệm.

## 2. Phạm vi MVP và ngoài phạm vi

Theo `docs/01-PRD.md` mục 2.5:

### Trong phạm vi MVP

- Browser Extension cho Chrome/Edge, Manifest V3.
- Chặn domain trong blocklist, chặn category người lớn (danh sách có sẵn).
- Blocklist/Allowlist do phụ huynh tự thêm (ví dụ: chặn `tiktok.com`,
  cho phép `hocmai.vn`).
- Báo cáo domain đã thăm — **chỉ domain, không full URL có tham số nhạy cảm**.
- DNS filtering dự phòng (hướng dẫn đặt DNS gia đình trên máy con, ví dụ
  Cloudflare for Families `1.1.1.3`) là lớp bổ sung, không thay extension.

### Ngoài phạm vi MVP

- Lọc HTTPS toàn hệ thống bằng MITM proxy.
- Chặn VPN.
- Chặn mọi trình duyệt lạ.

Các mục ngoài phạm vi cần đánh giá riêng ở giai đoạn 2 vì rủi ro
bảo mật/pháp lý và có thể bị antivirus chặn. Stub này không làm bất kỳ
mục nào trong số đó.

### Không làm — theo PRD mục 5 và `docs/03-SECURITY.md`

- Không ghi phím (keylogger), không đọc tin nhắn/email/file.
- Không nghe mic, không bật camera.
- Không đọc nội dung trang web.

## 3. Quyền tối thiểu

Theo `docs/03-SECURITY.md` mục 4 (Extension), extension chỉ xin đúng
2 quyền trong `manifest.json`:

```json
"permissions": ["declarativeNetRequest", "storage"]
```

- `declarativeNetRequest`: chặn/cho phép theo rules khai báo, không cần
  đọc nội dung request.
- `storage`: lưu trạng thái/rules cục bộ khi Sprint 3 cần (stub hiện tại
  chưa lưu gì).

**Không xin thêm:** không `tabs`, không `webRequest`, không `cookies`,
không các quyền đọc URL đầy đủ hay đọc nội dung trang.

`host_permissions` hiện để mảng rỗng (`[]`) vì stub chưa cần truy cập
host nào và chưa gọi API nào. Sprint 3 chỉ bổ sung host thật sự cần,
sau khi rà soát lại theo nguyên tắc quyền tối thiểu.

## 4. Nguyên tắc chỉ domain

- Chỉ xử lý và (khi Sprint 3 làm thật) chỉ lưu **domain**, ví dụ `youtube.com`.
- **Cắt bỏ path và query** trước khi lưu/log/gửi. Ví dụ, từ
  `https://www.youtube.com/results?search_query=...` chỉ giữ lại domain,
  không giữ path `/results` và không giữ query `search_query=...`,
  vì path/query có thể lộ nội dung tìm kiếm của con.
- Không gửi full URL lên server. Không log full URL.
- Bảng đích ở backend là `web_visits` (`device_id`, `child_id`, `domain`,
  `visited_at`, `blocked`) — xem `docs/02-ARCHITECTURE.md` mục 3.
  Bảng này chỉ có cột `domain`, không có cột full URL.

Stub hiện tại chưa thu thập domain nào; nguyên tắc trên là ràng buộc
bắt buộc cho mọi code Sprint 3 viết thêm.

## 5. Cấu trúc khung stub

```
apps/browser-extension/
├── README.md          — Tài liệu này.
├── manifest.json      — Manifest V3 (Chrome + Edge), quyền tối thiểu.
├── background.js      — Service worker stub: chỉ log khởi động, seed
│                        dynamic rules rỗng. Không fetch, không Supabase.
├── rules.json         — Mảng rỗng: chưa có rule chặn nào.
├── popup.html         — Popup stub tiếng Việt.
├── popup.js           — Popup stub: không gọi API, không đọc tab.
└── icons/
    └── icon.svg       — Icon khiên đơn giản tự vẽ (stub).
```

Không có `package.json`, không có bước build: MV3 stub chạy trực tiếp
bằng file tĩnh. Sprint 3 sẽ quyết định có cần TypeScript/build hay giữ
file tĩnh, theo `docs/02-ARCHITECTURE.md` (Extension: Manifest V3,
TypeScript). Nếu thêm build, phải cập nhật README này.

### Về `rules.json` (mảng rỗng)

JSON không có comment nên file `rules.json` hiện chỉ là mảng rỗng `[]`,
nghĩa là chưa chặn domain nào. Định dạng rule Sprint 3 sẽ dùng là
định dạng `declarativeNetRequest` chuẩn của Manifest V3, ví dụ về hình
thức (chưa áp dụng, chỉ minh họa cấu trúc):

```json
[
  {
    "id": 1,
    "priority": 1,
    "action": { "type": "block" },
    "condition": {
      "urlFilter": "||example.com",
      "resourceTypes": ["main_frame"]
    }
  }
]
```

Sprint 3 sẽ sinh rules từ blocklist trong bảng `rules` (xem mục 7),
không hard-code domain chặn trong code. Rule ví dụ trên dùng domain
`example.com` chỉ để minh họa cấu trúc, không phải blocklist thật.

### Về icon

`icons/icon.svg` là khiên đơn giản tự vẽ, được tham chiếu trong
`manifest.json` ở cả `icons` và `action.default_icon`. Đây là icon
placeholder; trước khi phân phối thật cần kiểm tra hiển thị trên
Chrome/Edge và xuất bản PNG theo kích thước yêu cầu nếu trình duyệt
cần (xem mục 6 — chưa kiểm chứng).

## 6. Cách load tạm thời (unpacked) để xem manifest hợp lệ

> Chỉ hướng dẫn — người làm khung này không chạy trình duyệt trong
> nhiệm vụ này, và **chưa load thử extension trên Chrome/Edge thật**.
> Các bước dưới đây để người kiểm tra tự làm trên máy của mình.

**Chrome:**

1. Mở `chrome://extensions/`.
2. Bật **Developer mode** (Chế độ dành cho nhà phát triển) ở góc trên bên phải.
3. Bấm **Load unpacked** (Tải tiện ích đã giải nén).
4. Chọn thư mục `apps/browser-extension/` (thư mục chứa `manifest.json`).
5. Nếu manifest hợp lệ, extension `SafePC` xuất hiện trong danh sách,
   không báo lỗi. Bấm icon SafePC trên thanh công cụ để xem popup stub:
   "SafePC đang bảo vệ" + "Chưa kết nối — Sprint 3".
6. Sau khi kiểm tra xong, bấm **Remove** (Xóa) để gỡ bản unpacked.

**Edge:**

1. Mở `edge://extensions/`.
2. Bật **Developer mode** ở góc dưới bên trái.
3. Bấm **Load unpacked**, chọn thư mục `apps/browser-extension/`.
4. Kiểm tra tương tự như Chrome, rồi gỡ bản unpacked sau khi xong.

Nếu trình duyệt báo lỗi manifest/rules/icon, ghi lại đúng thông báo lỗi
và sửa ở Sprint 3 — không "chữa cháy" bằng cách xin thêm quyền.

## 7. Các bước Sprint 3 sẽ làm

1. **Blocklist từ `rules`:** lấy danh sách chặn/cho phép website từ bảng
   `rules` (`type = website`, `config` JSONB, `enabled`) theo đúng gia
   đình/con qua RLS, qua kênh an toàn do Backend/Agent cung cấp.
   Không nhúng secret/key vào extension. Không hard-code blocklist.
2. **DeclarativeNetRequest rules:** chuyển blocklist/allowlist thành
   rules tĩnh (`rules.json`) và/hoặc dynamic rules trong `background.js`,
   chỉ chặn theo domain, ưu tiên allowlist trước blocklist theo quy tắc
   phụ huynh đặt. Cập nhật rules khi phụ huynh đổi quy tắc.
3. **Báo cáo domain về `web_visits`:** ghi nhận domain đã thăm
   (chỉ domain, đã cắt path/query) kèm `blocked: true/false`,
   gửi theo batch qua kênh an toàn, có hàng đợi khi mất mạng nếu cần.
   Không gửi full URL, không gửi nội dung.
4. **Trạng thái ghép nối:** popup hiển thị trạng thái kết nối thật
   (đã ghép nối với máy/con nào, rules đã đồng bộ lúc nào) mà không
   hiển thị URL đầy đủ và không đọc tab.
5. **Kiểm thử:** load unpacked trên cả Chrome và Edge thật; kiểm tra
   1 domain bị chặn có log, 1 domain được phép vẫn mở được; kiểm tra
   không có full URL nào rời khỏi máy; rà soát lại quyền tối thiểu
   theo `docs/03-SECURITY.md` trước khi release.

## 8. Tài liệu tham chiếu

- `docs/01-PRD.md` mục 2.5 (lọc web MVP) và mục 5 (không làm).
- `docs/02-ARCHITECTURE.md` (extension MV3, chạy Chrome + Edge;
  bảng `web_visits` chỉ lưu domain).
- `docs/03-SECURITY.md` mục 3 (chỉ lưu domain, cắt path/query)
  và mục 4 (quyền tối thiểu cho Extension).
