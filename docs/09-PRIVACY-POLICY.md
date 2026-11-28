# Chính sách riêng tư — SafePC

Cập nhật lần cuối: 28/11/2026. Áp dụng cho gia đình sử dụng SafePC (bản dùng
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
| Cụm từ tìm kiếm trên các công cụ tìm kiếm (Google, Bing, DuckDuckGo, Yahoo, Cốc Cốc) + dấu hiệu bị chặn hay không | Thi hành chặn từ khóa tìm kiếm, thống kê trong báo cáo tuần | Chỉ cụm từ con gõ vào ô tìm kiếm của các công cụ này mới được lưu (quyết định của phụ huynh ngày 27/11/2026, xem AMENDMENTS A-14). Phần truy vấn của mọi link khác vẫn bị bỏ như lịch sử web ở trên. |
| Ghi nhận khi luật không chặn (tên luật do phụ huynh đặt, ứng dụng/trang web/khung giờ thuộc diện luật, số lần, tổng thời lượng, ngữ cảnh luật đang tắt / được cho phép tạm thời / không chặn được) | Báo cáo tuần cho phụ huynh: thấy hoạt động thuộc diện luật mà luật không chặn lúc đó | **Không phải loại dữ liệu mới**: suy ra từ dữ liệu sử dụng vốn đã thu ở các hàng trên, chỉ gắn thêm liên kết tới luật (quyết định của phụ huynh ngày 27/11/2026, xem AMENDMENTS A-18). Giữ 90 ngày; có trong xuất/xóa dữ liệu của con. |
| Tin nhắn giữa phụ huynh và con trong SafePC (nội dung + mốc đã đọc) | Kênh liên lạc hai chiều trong gia đình ngay trong sản phẩm, để con khỏi dùng ứng dụng nhắn tin bên ngoài | Nội dung do CHÍNH phụ huynh và con chủ động gửi trong kênh của SafePC (quyết định của phụ huynh ngày 27/11/2026, xem AMENDMENTS A-15) — khác với nội dung chat ở ứng dụng khác, mà SafePC không đọc (mục 2). Tin nhắn có trong file xuất dữ liệu của con và bị xóa khi xóa dữ liệu của con. |
| Đăng ký thông báo đẩy của phụ huynh (điểm nhận push trên trình duyệt/thiết bị + khóa công khai mã hóa của điểm nhận) | Gửi thông báo đẩy tới thiết bị của phụ huynh khi con nhắn tin hoặc gửi yêu cầu mới, kể cả khi Dashboard đang đóng | Chỉ có khi phụ huynh tự BẬT công tắc "Thông báo đẩy" trên Dashboard (quyết định của phụ huynh ngày 27/11/2026, xem AMENDMENTS A-16). Đây là dữ liệu của PHỤ HUYNH, không phải của con. Tắt công tắc thì đăng ký bị xóa ngay. Thông báo đẩy hiện tiêu đề + đoạn xem trước tối đa 60 ký tự của tin nhắn mới nhất; nội dung push được mã hóa theo chuẩn Web Push, chỉ thiết bị của phụ huynh giải mã được. |
| Quy tắc phụ huynh đặt (giờ giấc, danh sách chặn, giới hạn) | Thi hành trên máy con | Do phụ huynh nhập trên Dashboard. |
| Trạng thái máy (online/offline, đang khóa hay mở, phiên bản Agent) | Hiển thị trên Dashboard, cảnh báo khi máy offline | Heartbeat mỗi 60 giây. |
| Yêu cầu của con (xin thêm giờ, xin mở ứng dụng/trang web) + quyết định của phụ huynh | Duyệt yêu cầu, nhật ký hoạt động | Nội dung do con/phụ huynh tự nhập (số phút, lý do ngắn). |
| Sự kiện can thiệp (đổi giờ hệ thống, Agent/Tray/extension dừng bất thường) | Cảnh báo phụ huynh | Chỉ loại sự kiện + thời điểm, không nội dung. Ghi chú giờ tin cậy (AMENDMENTS A-17): luật theo giờ được thi hành bằng giờ máy chủ đã đồng bộ quy đổi sang múi giờ gia đình do phụ huynh đặt — con chỉnh giờ hệ thống hay đổi múi giờ trên máy không thay đổi được thi hành, chỉ tạo sự kiện can thiệp khi lệch quá 120 giây. |
| Email phụ huynh, tên hồ sơ con, tên máy | Đăng nhập, phân biệt các con/máy | Tên con do phụ huynh đặt (tên hiển thị, không bắt buộc tên thật). |
| Ảnh chụp màn hình định kỳ của máy con + metadata (thời điểm chụp, kích thước, định danh file) | Để phụ huynh xem lại hoạt động trên màn hình của con | **Chỉ khi phụ huynh tự BẬT** tính năng này cho hồ sơ con (mặc định tắt; quyết định của phụ huynh ngày 28/11/2026, xem AMENDMENTS A-19 và mục riêng ngay dưới đây). Ảnh lưu trên Google Drive của chính phụ huynh — SafePC chỉ giữ metadata, không lưu ảnh trên server. |

### Ảnh chụp màn hình định kỳ (chỉ khi phụ huynh bật)

- Tính năng này **mặc định TẮT**; chỉ thu khi phụ huynh chủ động bật cho
  từng hồ sơ con và đã xác nhận hiểu rằng ảnh có thể chứa nội dung nhạy
  cảm con đang xem hoặc gõ trên màn hình.
- Ảnh được chụp theo chu kỳ phụ huynh chọn, lưu trên **Google Drive của
  chính phụ huynh** (kết nối qua OAuth, SafePC chỉ truy cập thư mục do
  chính SafePC tạo). **SafePC không lưu ảnh chụp trên server của mình** —
  server chỉ giữ metadata (thời điểm chụp, kích thước, định danh file)
  để hiển thị danh mục cho phụ huynh.
- **Con được thông báo 1 lần mỗi tuần ngay trên máy con** rằng màn hình
  đang được chụp và bố mẹ có quyền xem ảnh; biểu tượng khay hệ thống luôn
  hiển thị trạng thái chụp. Không chụp khi màn hình đang khóa.
- Phụ huynh **tắt tính năng bất cứ lúc nào** trên Dashboard; việc chụp
  dừng ngay từ lượt kế tiếp.
- Ảnh tự xóa sau hạn giữ phụ huynh chọn (mặc định 14 ngày). Khi phụ
  huynh xóa dữ liệu của con, SafePC xóa metadata và cài đặt chụp; **file
  ảnh trên Google Drive do phụ huynh tự quản** (xóa thư mục SafePC
  trong Drive của mình nếu muốn xóa hẳn).

## 2. SafePC KHÔNG thu thập

- **Không** ghi phím (keylogger), **không** đọc nội dung chat, email,
  file của con. Chụp màn hình chỉ diễn ra trong đúng phạm vi mục "Ảnh
  chụp màn hình định kỳ" ở trên (phụ huynh bật, con được thông báo,
  không chụp lén, không chụp khi màn hình khóa).
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
- **Từ khóa tìm kiếm** (cụm từ trên các công cụ tìm kiếm): giữ **90 ngày**,
  tự xóa các hàng cũ hơn mỗi ngày.
- **Ghi nhận khi luật không chặn** (bảng rule_observations): giữ **90 ngày**,
  tự xóa các hàng cũ hơn mỗi ngày.
- **Ảnh chụp màn hình định kỳ**: file ảnh nằm trên Google Drive của phụ
  huynh, tự xóa sau hạn giữ phụ huynh chọn (mặc định **14 ngày**; chọn
  được 14 / 30 / 90 / 180 ngày). Metadata chụp trên server giữ cùng hạn
  giữ đó; khi phụ huynh xóa dữ liệu của con thì metadata và cài đặt
  chụp bị xóa, còn file ảnh trên Drive do phụ huynh tự quản.
- **Tin nhắn trong SafePC**: giữ tới khi phụ huynh xóa dữ liệu của con
  (không tự hết hạn theo ngày như lịch sử web).
- **Đăng ký thông báo đẩy của phụ huynh**: giữ tới khi phụ huynh tắt
  thông báo đẩy trên Dashboard (xóa ngay khi tắt) hoặc điểm nhận bị
  dịch vụ push báo đã hết hiệu lực (server tự xóa). Lịch sử đã gửi
  push (loại sự kiện + thời điểm, không nội dung tin) giữ theo nhu
  cầu đối soát của gia đình như nhật ký hoạt động.
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
