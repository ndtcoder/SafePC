# Chính sách riêng tư — SafePC

Cập nhật lần cuối: 19/11/2026. Áp dụng cho gia đình sử dụng SafePC (bản dùng
trong gia đình, dưới 100 người dùng).

> Bản web công khai của tài liệu này: Dashboard → trang đăng nhập →
> "Chính sách riêng tư" (`/chinh-sach-rieng-tu`).

SafePC là ứng dụng quản lý máy tính của con trong gia đình (tương tự
Microsoft Family Safety / Google Family Link). Người vận hành là **phụ huynh
quản trị gia đình** — phụ huynh tạo tài khoản, đặt quy tắc, xem báo cáo.
SafePC không bán dữ liệu, không chia sẻ dữ liệu cho bên thứ ba quảng cáo,
không dùng dữ liệu để huấn luyện AI.

## 1. SafePC thu thập dữ liệu gì

| Dữ liệu | Mục đích | Ghi chú |
|---|---|---|
| Tên ứng dụng + thời lượng dùng (giây) | Tính giờ dùng, thi hành giới hạn theo ứng dụng, báo cáo tuần | Chỉ tên process (VD: chrome.exe, notepad.exe). **Không** tiêu đề cửa sổ, **không** nội dung trong ứng dụng. |
| Tên miền + đường dẫn web đã xem + thời lượng (giây) | Đếm giờ web, thi hành chặn website, báo cáo tuần | Chỉ domain + đường dẫn (VD: youtube.com/watch). **Đã bỏ phần truy vấn (?...) và fragment (#...)** — không lưu link đầy đủ, không đọc nội dung trang. Lượt web bị chặn chỉ lưu tên miền, không có đường dẫn. |
| Quy tắc phụ huynh đặt (giờ giấc, danh sách chặn, giới hạn) | Thi hành trên máy con | Do phụ huynh nhập trên Dashboard. |
| Trạng thái máy (online/offline, đang khóa hay mở, phiên bản Agent) | Hiển thị trên Dashboard, cảnh báo khi máy offline | Heartbeat mỗi 60 giây. |
| Yêu cầu của con (xin thêm giờ, xin mở ứng dụng/trang web) + quyết định của phụ huynh | Duyệt yêu cầu, nhật ký hoạt động | Nội dung do con/phụ huynh tự nhập (số phút, lý do ngắn). |
| Sự kiện can thiệp (đổi giờ hệ thống, Agent/Tray/extension dừng bất thường) | Cảnh báo phụ huynh | Chỉ loại sự kiện + thời điểm, không nội dung. |
| Email phụ huynh, tên hồ sơ con, tên máy | Đăng nhập, phân biệt các con/máy | Tên con do phụ huynh đặt (tên hiển thị, không bắt buộc tên thật). |

## 2. SafePC KHÔNG thu thập

- **Không** chụp màn hình, **không** ghi phím (keylogger), **không** đọc
  nội dung chat, email, file của con.
- **Không** bật micro, camera, định vị.
- **Không** tiêu đề cửa sổ, **không** nội dung trang web, **không** mật khẩu
  (mật khẩu phụ huynh do Supabase Auth quản lý, SafePC không tự lưu).
- **Không** quảng cáo, **không** theo dõi hành vi ngoài phạm vi quản lý máy
  tính trong gia đình.

## 3. Dữ liệu được lưu ở đâu và bảo vệ ra sao

- **Lưu trữ**: cơ sở dữ liệu Supabase (khu vực Singapore) và Dashboard
  trên Vercel. Mọi kết nối đều qua TLS (HTTPS).
- **Phân tách theo gia đình**: mỗi gia đình chỉ thấy dữ liệu của mình
  (Row Level Security theo `family_id` trên mọi bảng).
- **Trên máy con**: device token mã hóa bằng DPAPI của Windows, file khóa
  chỉ tài khoản SYSTEM + Administrators đọc được; mã PIN chỉ lưu dạng băm
  PBKDF2 (không lưu mã thô); quy tắc website khóa ACL chỉ SYSTEM + Admins
  ghi được.
- **Tài khoản Standard của con** không dừng được Service (chạy quyền
  SYSTEM), không gỡ được ứng dụng nếu không có quyền Admin, không sửa
  được quy tắc.
- **Nhân viên vận hành hạ tầng** (Supabase/Vercel) chỉ là bên xử lý dữ liệu
  theo hợp đồng của họ, không dùng dữ liệu SafePC cho mục đích riêng.

## 4. Dữ liệu được giữ bao lâu

- **Lịch sử web** (domain + đường dẫn): giữ **90 ngày**, tự xóa các hàng
  cũ hơn mỗi ngày.
- **Mẫu dùng ứng dụng**: mẫu chi tiết giữ 7 ngày cho việc tính giờ; số liệu
  tổng hợp theo ngày giữ 90 ngày.
- **Nhật ký hoạt động / sự kiện can thiệp / yêu cầu**: giữ theo nhu cầu quản
  lý của gia đình; phụ huynh xóa được toàn bộ dữ liệu của con bất cứ lúc nào
  (xem mục 5).
- **Bản sao lưu**: Supabase gói Free không có sao lưu tự động — phụ huynh
  quản trị tự xuất dữ liệu định kỳ (mục 5) nếu cần.

## 5. Quyền của phụ huynh và của con

- **Xuất dữ liệu**: phụ huynh xuất toàn bộ dữ liệu của một con ra một file
  JSON trên Dashboard (trang Hồ sơ con → tab Dữ liệu).
- **Xóa dữ liệu**: phụ huynh xóa toàn bộ dữ liệu của một con (kèm hồ sơ và
  máy) trên Dashboard — thao tác này không thể hoàn tác, cần gõ đúng tên
  con để xác nhận. Xóa xong, dữ liệu không còn trên server; bản sao local
  trên máy con bị xóa khi gỡ cài đặt.
- **Minh bạch với con**: con luôn thấy Agent đang chạy (icon khay hệ thống),
  thấy quy tắc của mình trên Tray (thời gian còn lại, lý do bị chặn) và
  được thông báo khi bị khóa. SafePC không chạy ẩn hoàn toàn.
- **Độ tuổi / giám hộ**: SafePC dùng trong gia đình, phụ huynh là người
  giám hộ của con và chịu trách nhiệm đặt quy tắc phù hợp với độ tuổi của
  con, theo Luật Trẻ em và Luật Bảo vệ dữ liệu cá nhân 2023 của Việt Nam.

## 6. Liên hệ và thay đổi chính sách

- Mọi thắc mắc về dữ liệu của gia đình mình: liên hệ **phụ huynh quản trị
  gia đình** (người tạo tài khoản SafePC) qua Dashboard.
- Khi SafePC thay đổi cách thu thập dữ liệu (VD: thêm loại dữ liệu mới),
  chính sách này được cập nhật kèm ngày cập nhật ở đầu trang và phụ huynh
  được thông báo trên Dashboard trước khi thay đổi có hiệu lực.
- SafePC là sản phẩm gia đình, chưa thương mại hóa. Khi mở rộng trên 100
  người dùng hoặc thương mại hóa, chính sách này sẽ được rà soát lại cùng
  tư vấn pháp lý riêng.
