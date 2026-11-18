# Nghiên cứu 18/11/2026 — Ép cài extension + Email báo cáo tuần

Chỉ đọc tài liệu, không tạo tài khoản. Nguồn chính thức được ghi rõ; mục "chưa chắc" nằm cuối.

## 1. Ép cài extension bằng chính sách

### ExtensionInstallForcelist (đã xác minh — Microsoft Learn / Google)

- Edge: `HKLM\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist`, value `1`, `2`… kiểu REG_SZ, định dạng `extension_id;update_url`. Người dùng không gỡ/tắt được; xóa khỏi danh sách thì Edge tự gỡ. Dynamic Policy Refresh: có.
- **Giới hạn quyết định: máy Windows KHÔNG join Active Directory domain thì chỉ ép cài được extension đã lên Microsoft Edge Add-ons.** Chrome tương tự (chỉ Web Store, trừ khi join domain/Azure AD/Chrome Enterprise Core).
- Policy không áp dụng cho chế độ InPrivate → cần thêm policy tắt InPrivate (`InPrivateModeAvailability`), nếu không con mở InPrivate là thoát chặn web.
- Registry policy có hiệu lực trên mọi edition Windows (kể cả Home — chỉ thiếu gpedit.msc; trình duyệt đọc thẳng registry). Ghi HKLM cần quyền Admin → tài khoản Standard của con không xóa được. Chưa có câu xác nhận trực tiếp từ Microsoft/Google — kiểm chứng trên máy test là xong.

### Self-hosted CRX (đã xác minh phần lớn — tài liệu Chromium)

- Đóng gói: `chrome.exe --pack-extension=<thư-mục> --pack-extension-key=<key.pem>`; khóa riêng `.pem` phải giữ bí mật, mất là không cập nhật cùng ID được nữa.
- ID suy ra từ khóa công khai (SHA-256 DER, 128 bit đầu, hex→a–p, 32 ký tự). Cùng khóa → cùng ID mãi.
- Update manifest: XML Omaha, `codebase` phải HTTPS, trình duyệt kiểm tra "every few hours".
- **Kết luận: self-hosted KHÔNG dùng được để ép cài trên máy gia đình** (giới hạn non-domain ở trên). Chỉ khả thi khi máy join domain hoặc đăng ký quản lý tập trung.

### Xuất bản lên cửa hàng (đã xác minh — Microsoft Learn)

- **Edge Add-ons: miễn phí**, cần tài khoản Microsoft cá nhân (MSA) làm Primary Owner; loại tài khoản + quốc gia không đổi được sau khi đăng ký. Duyệt tối đa 7 ngày làm việc (thực tế thường 1–2 ngày, giai thoại). ID do Partner Center gán sau lần nộp đầu. Cập nhật qua Partner Center (có API), trình duyệt tự cập nhật. Khi đóng gói cho Edge: bỏ trường `update_url`, không dùng chữ "Chrome" trong tên/mô tả.
- Chrome Web Store: phí đăng ký một lần $5 (mọi nguồn thứ cấp thống nhất; Google không in con số trong tài liệu), cần bật 2-Step Verification, khai Non-Trader cho cá nhân phi thương mại. Thời gian duyệt chưa chắc (3 ngày – 3 tuần).

### Hệ quả đổi ID (đã xác minh)

- ID hiện tại `djcgbhjbmcccdgedbmfihdpeeanmldbd` suy ra từ đường dẫn cài tay. **Không có cách giữ nguyên ID khi lên cửa hàng** (Partner Center gán ID mới; Edge Add-ons từ chối gói có trường `key`). Trường `key` chỉ giúp bản unpacked mang cùng ID với bản cửa hàng SAU KHI cửa hàng đã gán ID.
- NativeHost: `allowed_origins` phải chứa `chrome-extension://<ID-mới>/`. Installer SafePC đã tự sinh manifest này — chỉ cần nướng ID mới vào; mảng `allowed_origins` liệt kê cả ID cũ + mới trong giai đoạn chuyển đổi.
- `chrome.storage` gắn với ID → đổi ID = bộ nhớ cục bộ trống (giờ dùng trong ngày, chẩn đoán). **Không mất dữ liệu báo cáo** (usage đã đẩy lên Supabase); extension đồng bộ lại.

### Phương án

- **Dùng ngay cho máy gia đình: không có cách ép cài thật sự** cho tới khi bản cửa hàng lên sóng. Biện pháp giảm thiểu tạm thời: phát hiện gỡ extension qua heartbeat (đã có), policy `ExtensionInstallBlocklist=*` (con không cài extension khác), chặn trình duyệt khác (đã có), policy tắt InPrivate.
- **Dài hạn:** Edge Add-ons (miễn phí) + installer ghi policy `ExtensionInstallForcelist` với ID mới + URL cửa hàng, gỡ bản cài tay. Cân nhắc thêm `DeveloperToolsAvailability` (chặn devtools sửa mã extension; đánh đổi: admin cũng mất devtools).
- Chrome Web Store ($5) chỉ khi cần hỗ trợ Chrome — hiện SafePC chặn Chrome, chỉ cho Edge.

### Quyết định cần anh Tiến

1. Tài khoản Microsoft cá nhân nào đứng tên Partner Center (sẵn có hay tạo mới)?
2. Loại tài khoản: cá nhân (khuyên dùng) hay công ty — không đổi được sau này.
3. Tên hiển thị nhà phát hành trên cửa hàng.
4. Đồng ý đổi ID extension (bản cài tay cũ bị thay bằng bản cửa hàng; bộ nhớ cục bộ reset, dữ liệu server không mất).
5. URL chính sách riêng tư cho trang cửa hàng — đề xuất: trang riêng tư tiếng Việt trên chính Dashboard (đã nằm trong roadmap, bắt buộc trước khi mời gia đình ngoài).
6. Chỉ Edge hay nộp luôn Chrome Web Store ($5)?

## 2. Gửi email (báo cáo tuần + thông báo)

### Resend gói free (đã xác minh — resend.com/pricing, đọc trực tiếp)

- $0/tháng: 3.000 email/tháng, tối đa 100 email/ngày, 3 domain.
- **Gửi từ `onboarding@resend.dev` chỉ gửi được tới đúng email của tài khoản Resend** (gửi người khác lỗi 403). Muốn gửi tới bất kỳ ai khác bắt buộc xác minh domain riêng (SPF + DKIM, nên thêm DMARC).
- API key loại send-only; gọi từ Edge Function bằng `fetch` tới `https://api.resend.com/emails`, header `Authorization: Bearer <key>`; không cần SDK Deno. Key lưu trong Edge Function Secrets (tài liệu Supabase có ví dụ mẫu này).

### Lên lịch (khuyên dùng pg_cron + pg_net)

- `pg_cron` có sẵn trên gói Free; mẫu chính thức: pg_cron + pg_net gọi Edge Function, key trong Vault. Edge Function Free: 500.000 lượt/tháng — thừa.
- Cảnh báo: project Free bị tạm dừng sau 7 ngày không hoạt động → pg_cron dừng theo. Agent gửi heartbeat hàng ngày nên rủi ro thấp.
- Vercel Cron (Hobby): tối đa 1 lần/ngày, lệch trong khung 1 giờ, chỉ giờ UTC; Dashboard là SPA tĩnh nên phải thêm Vercel Function + service_role key — thêm một lớp so với pg_cron.

### Phương án thay thế

- Gmail SMTP + App Password từ Edge Function: **không khả thi đáng tin** — Supabase chặn cổng SMTP 25/587 trên Edge Functions (hai nguồn thứ cấp khớp nhau, chưa có văn bản chính thức). Gmail SMTP vẫn dùng được từ Vercel Function hoặc từ agent — kiến trúc khác, phức tạp hơn.
- Supabase Auth SMTP: chỉ phục vụ luồng xác thực, không có API gửi email tự do.

### Kết luận

Đường đơn giản nhất, miễn phí, cho 1 gia đình: Edge Function + Resend + pg_cron. **Chưa có domain thì vẫn chạy được ngay** (gửi từ `onboarding@resend.dev` tới đúng email của anh; nhược điểm: tên người gửi lạ, dễ vào spam). Muốn gửi đẹp + gửi cho phụ huynh khác thì cần mua domain (~vài trăm nghìn/năm, vượt mục tiêu free — cần anh quyết). Phương án không-domain thay thế: Gmail SMTP từ Vercel Function (miễn phí, gửi từ Gmail của anh, 500/ngày) — thêm code + quản lý App Password.

### Việc anh Tiến phải làm (đường Resend)

1. Tạo tài khoản Resend (Google/GitHub/email, không cần thẻ).
2. Tạo API key send-only, cấp qua kênh bảo mật (không gửi key trong chat) để lưu vào Edge Function Secrets.
3. Quyết định domain: (a) chưa mua — gửi tạm từ `onboarding@resend.dev` tới email của anh; hoặc (b) mua domain + thêm bản ghi DNS SPF/DKIM do Resend cấp.
4. Lịch gửi (pg_cron) cấu hình bằng SQL trong migration — em làm, anh chỉ paste + chạy như mọi migration.

## Chưa chắc (kiểm chứng khi triển khai)

1. Policy registry trên Windows Home — bằng chứng mạnh, chưa có câu xác nhận trực tiếp; kiểm chứng trên máy test.
2. Thời gian duyệt Chrome Web Store (3 ngày – 3 tuần).
3. Chặn cổng SMTP trên Edge Functions — hai nguồn thứ cấp, chưa có văn bản Supabase.
4. Chrome Enterprise Core (miễn phí) có mở đường ép cài ngoài cửa hàng cho Chrome trên máy Home không — chưa nghiên cứu.
