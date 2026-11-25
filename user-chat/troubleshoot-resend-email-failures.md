# Chat log — Troubleshoot Resend email failures

## [2026-11-19 09:44 +07] Anh Tiến

[image:image/png workspace/user/media_library/image/image-51.png]
[image:image/png workspace/user/media_library/image/image-52.png]
a muốn gửi mail từ resend. A có domain đưa vào làm theo hướng dẫn của resend (ảnh) nhưng tại sao toàn báo failed. Em ktra giúp anh nhé

## [2026-11-19 09:46 +07] TraMuse

Anh Tiến ơi, em kiểm tra rồi, nguyên nhân chính không phải anh ghi sai bản ghi đâu.

Em tra DNS công khai qua cả Google lẫn Cloudflare thì `ndt.ap.vn` trả về **không tồn tại** — cả bản thân tên miền, `www`, DKIM, `send`, `rsend`, `_dmarc`, MX đều như vậy. Bên Resend em gọi API cũng thấy domain `ndt.ap.vn` đang ở trạng thái `failed`.

Tức là các bản ghi anh tạo trong panel Tino hiện chỉ nằm trong panel đó, chưa được xuất bản ra DNS công khai nên Resend không nhìn thấy gì hết, thành ra DKIM, SPF, MX đều Failed cùng lúc. Bản thân các bản ghi DKIM và 2 CNAME SPF anh tạo trong panel thì nhìn đúng tên và giá trị Resend yêu cầu rồi.

Anh làm giúp em 2 việc:

**1. Kiểm tra ở Tino trước**
Vào chỗ quản lý tên miền của Tino, xem `ndt.ap.vn` đang ở trạng thái gì và nameserver đang trỏ về đâu. Nếu tên miền chưa kích hoạt, hoặc nameserver chưa trỏ về Tino, thì nhờ bên Tino kích hoạt/ủy quyền giúp. Anh có thể tự kiểm tra nhanh ở đây sau khi sửa:

`https://dnschecker.org/#A/ndt.ap.vn`

Khi nào trang này hiện ra địa chỉ IP thay vì lỗi là DNS đã live.

**2. Sửa 2 lỗi phụ trong lúc chờ, để sau này khỏi Failed tiếp**
- Trong Resend, tắt **Enable receiving** đi. SafePC mình chỉ cần gửi mail báo cáo và thông báo, không cần nhận mail. Hiện MX ở Tino đang trỏ về `mx.tino.vn`, còn Resend đòi `receive-apne1.forge.rmta.net`, nên cứ để receiving bật là MX mãi Failed.
- Trong panel Tino, `_dmarc.ndt.ap.vn` đang có **2 bản TXT trùng nhau**, DMARC chỉ được có 1 bản thôi. Anh xóa bớt 1 bản, giữ lại 1 bản là được.

Sau khi DNS đã live, anh vào Resend bấm Verify lại, chờ một lúc rồi báo em, em kiểm tra lại DNS và gửi thử một mail từ `ndt.ap.vn` giúp anh.
