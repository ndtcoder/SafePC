# Hướng dẫn cài extension SafePC (bản thử nghiệm, chưa qua cửa hàng)

Extension SafePC lọc web trên Chrome/Edge: chặn domain, chặn theo giờ,
allowlist, giới hạn thời gian theo domain, SafeSearch. Quy tắc do phụ huynh
đặt trên Dashboard, Agent đồng bộ xuống máy và xuất bản ra file
`domain_rules.json`, extension đọc qua NativeHost.

Bản này cài thủ công (load unpacked) để kiểm chứng đầu-cuối. Sau này
extension sẽ đăng lên cửa hàng Chrome/Edge thì chỉ cần 1 click, không còn
các bước dưới đây.

## Bước 1 — Giải nén vào đường dẫn cố định

Giải nén file `SafePC-Extension-0.1.0.zip` vào thư mục:

`C:\SafePC\extension`

Sao cho trong thư mục có trực tiếp file `manifest.json` (không lồng thêm
một thư mục con). **Không đổi tên, không di chuyển thư mục này sau khi cài:**
ID của extension gắn với đường dẫn, đổi đường dẫn là ID đổi theo và Agent
sẽ không nhận ra extension nữa.

## Bước 2 — Tải extension vào trình duyệt của con

Làm trên tài khoản Windows của con, trình duyệt con hay dùng (Chrome hoặc
Edge, làm giống nhau):

1. Mở `chrome://extensions` (Chrome) hoặc `edge://extensions` (Edge).
2. Bật **Chế độ nhà phát triển** (Developer mode) ở góc trên bên phải.
3. Bấm **Tải tiện ích đã giải nén** (Load unpacked), chọn thư mục
   `C:\SafePC\extension`.
4. Thẻ SafePC hiện ra. **Ghi lại ID 32 ký tự** trên thẻ (dạng
   `abcdefghijklmnop...`) và gửi cho em MyMuse — ID này cần để Agent nhận
   ra extension ở bước 3.
5. Ghim icon SafePC lên thanh công cụ (bấm hình mảnh ghép → ghim SafePC)
   để dễ kiểm tra trạng thái.

Giữ Chế độ nhà phát triển luôn bật. Tắt nó thì Chrome/Edge sẽ tắt
extension chưa qua cửa hàng.

## Bước 3 — Cho phép extension nối với Agent (sửa 1 dòng)

Agent chỉ cho phép đúng extension SafePC nối vào (danh sách
`allowed_origins` trong file manifest của NativeHost). Bản cài hiện tại
đang giữ ID placeholder, nên phải thay bằng ID thật ở bước 2:

1. Mở Notepad **bằng quyền Admin** (chuột phải Notepad → Run as
   administrator). Bắt buộc quyền Admin vì file nằm trong Program Files.
2. Mở file `C:\Program Files\SafePC Agent\NativeHost\com.safepc.agent.json`.
3. Thay chuỗi `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` bằng ID 32 ký tự ở bước 2.
   Chỉ thay đúng chuỗi đó, giữ nguyên dấu ngoặc kép và dấu `/` cuối.
4. Lưu file, khởi động lại trình duyệt.

Lưu ý: cài đè Agent bản mới sẽ ghi đè lại file này về placeholder. Sau khi
ID đã ổn định (đường dẫn cố định ở bước 1), em sẽ cập nhật bộ cài để tự
ghi ID thật, không cần sửa tay nữa.

## Bước 4 — Kiểm tra đã nối

1. Bấm icon SafePC trên thanh công cụ: phải hiện **"SafePC đang bảo vệ
   trình duyệt này"**. Nếu hiện "Chưa kết nối tới SafePC Agent" thì
   extension chưa nối được — kiểm tra lại ID ở bước 3 và khởi động lại
   trình duyệt.
2. File `C:\ProgramData\SafePC\shared\extension_heartbeat.txt` phải xuất
   hiện và cập nhật mỗi phút (mở bằng Notepad thấy thời gian mới nhất).
3. Log Service (`C:\ProgramData\SafePC\logs\agent-service.log`) không còn
   cảnh báo "Không thấy dấu hiệu extension trình duyệt".

## Bước 5 — Thử chặn thật

1. Trên Dashboard, trang Quy tắc, thêm rule chặn 1 domain (ví dụ
   `tiktok.com`) cho con.
2. Chờ khoảng 1 phút (Agent đồng bộ rules mỗi phút, extension lấy rules
   mới mỗi phút).
3. Mở domain đó trên trình duyệt của con: phải hiện trang chặn của SafePC.
4. Gỡ rule (hoặc cho phép tạm thời), chờ 1 phút, mở lại: vào được bình
   thường.

## Khắc phục nhanh

- **Popup báo chưa kết nối:** ID ở bước 3 sai hoặc chưa khởi động lại
  trình duyệt; hoặc thư mục extension đã bị đổi tên/di chuyển (ID đổi
  theo) — làm lại từ bước 2.
- **Extension biến mất sau khi khởi động lại máy:** Chế độ nhà phát triển
  đã bị tắt, hoặc thư mục `C:\SafePC\extension` đã bị xóa/di chuyển.
- **Chặn không có hiệu lực dù popup báo đã bảo vệ:** kiểm tra rule đã
  đồng bộ chưa — file `C:\ProgramData\SafePC\shared\domain_rules.json`
  phải có domain vừa chặn; nếu chưa có thì Agent chưa đồng bộ (xem log
  Service). Thay đổi rule có hiệu lực trong vòng ~1 phút.
- **Trình duyệt khác:** extension phải cài riêng cho từng trình duyệt con
  dùng (Chrome và Edge là 2 bản cài riêng, cùng ID nếu cùng thư mục).
  Firefox chưa hỗ trợ (chưa có bản extension cho Firefox).
