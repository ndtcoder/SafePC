# Hướng dẫn cài đặt SafePC (dành cho phụ huynh)

SafePC giúp phụ huynh quản lý máy tính Windows của con: giới hạn giờ dùng,
khóa máy theo lịch, chặn ứng dụng và trang web, nhận báo cáo tuần. Tài liệu
này hướng dẫn cài đặt từ đầu tới khi máy con hiện trên Dashboard.

> Bản web công khai của tài liệu này: Dashboard → trang đăng nhập →
> "Hướng dẫn cài đặt" (`/huong-dan-cai-dat`).

## 1. Trước khi cài: chuẩn bị gì

| Mục | Yêu cầu |
|---|---|
| Máy con | Windows 10 hoặc Windows 11 (64-bit), có mạng |
| Tài khoản trên máy con | Con dùng tài khoản **Standard User** (người dùng chuẩn). Phụ huynh giữ tài khoản **Admin** duy nhất. Đây là điều kiện quan trọng nhất: nếu con có quyền Admin thì con gỡ/tắt được SafePC. |
| Tài khoản phụ huynh | Đăng ký trên Dashboard tại `https://safe-pc.vercel.app` (email + mật khẩu), đã xác minh email |
| Trình duyệt trên máy con | Microsoft Edge (khuyến nghị) hoặc Chrome, để cài extension chặn web |

## 2. Tạo hồ sơ con và lấy mã ghép nối

1. Đăng nhập Dashboard, mở trang **Hồ sơ** → thêm hồ sơ con (tên hiển thị, VD: Diệu Linh).
2. Mở trang **Thiết bị** → bấm **Ghép nối máy mới** → tạo mã cho con.
3. Màn hình hiện **mã 6 số** (chỉ hiển thị một lần tại đây) và đồng hồ đếm
   ngược. Mã chỉ có hiệu lực **5 phút** — tạo mã ngay trước khi chạy bộ cài.

## 3. Cài đặt trên máy con (bằng tài khoản Admin)

1. Đăng nhập máy con bằng **tài khoản Admin của phụ huynh** (không cài từ
   tài khoản của con).
2. Lấy file bộ cài `SafePCAgentSetup-0.1.N.exe` do người quản trị SafePC
   của gia đình cung cấp (hiện chưa có link tải công khai trên Dashboard —
   kênh tải công khai là việc riêng sau này), chạy file.
   - Windows SmartScreen có thể cảnh báo vì bộ cài chưa được ký số (xem mục 8).
     Bấm **More info → Run anyway** để tiếp tục.
3. Làm theo trình hướng dẫn. Sau bước chép file, bộ cài hiện **trang ghép
   nối**: nhập mã 6 số đã tạo ở bước 2 rồi bấm Tiếp theo.
   - Nhập đúng mã: hiện "Ghép nối thành công!" kèm tên máy → bấm Finish.
     Máy sẽ hiện trên Dashboard (trạng thái Online trong vòng 1 phút).
   - Nhập sai mã / mã hết hạn: bộ cài báo lỗi, nhập lại mã mới (lấy mã mới
     trên Dashboard nếu mã cũ đã hết 5 phút).
   - Chưa có mã: tích **"Bỏ qua, ghép nối sau"** — cài đặt vẫn hoàn tất,
     máy chạy ở trạng thái chờ ghép nối; ghép nối sau bằng lệnh PowerShell
     (xem mục 7) hoặc chạy lại bộ cài.
4. Cài xong, đăng xuất tài khoản Admin, đăng nhập bằng tài khoản Standard
   của con. Icon SafePC hiện ở khay hệ thống (góc phải thanh taskbar).

## 4. Cài extension chặn web (Edge/Chrome)

1. Trên máy con (tài khoản nào cũng được), mở Edge → `edge://extensions`
   (Chrome: `chrome://extensions`) → bật **Developer mode**.
2. Giải nén file `SafePC-Extension-0.1.N.zip` (do người quản trị SafePC của
   gia đình cung cấp) ra `C:\SafePC\extension`
   (giữ nguyên đường dẫn này — đổi đường dẫn sẽ đổi ID extension và hỏng
   kết nối với Agent).
3. Bấm **Load unpacked** → chọn thư mục `C:\SafePC\extension`.
4. Kiểm tra: mở trang `https://www.youtube.com` khi đang bị chặn theo quy
   tắc — phải hiện trang chặn của SafePC. Bấm vào icon extension để xem
   phiên bản và quy tắc đang áp dụng.

> Giới hạn đã biết: bản cài tay (unpacked) có thể bị tắt/gỡ từ trình duyệt.
> SafePC phát hiện extension mất dấu và báo phụ huynh (xem mục 6). Ép cài
> qua cửa hàng Edge (không gỡ được) sẽ bật sau khi extension ổn định.

## 5. Đặt mã PIN, đặt quy tắc

- **Mã PIN thoát Tray**: trên Dashboard (trang Thiết bị → máy → "Mã PIN
  thoát Tray"), đặt mã 6 số. Muốn thoát Tray trên máy con phải nhập đúng mã;
  mỗi mã chỉ dùng được một lần (nhập đúng và thoát xong, mã tự gỡ, cần đặt
  mã mới). Chưa đặt mã PIN thì không ai thoát được Tray.
- **Mã PIN gỡ cài đặt**: chính là mã PIN trên — gỡ SafePC khỏi máy cũng yêu
  cầu nhập đúng mã PIN này (xem mục 7). Chưa đặt mã PIN thì gỡ bằng quyền
  Admin như trước.
- **Quy tắc**: trang **Quy tắc** — giờ giấc (giới hạn theo thứ, khung giờ,
  giờ ngủ), chặn ứng dụng, chặn website (kèm danh mục: người lớn, cờ bạc,
  mạng xã hội), giờ học tập trung, nghỉ bắt buộc. Quy tắc đồng bộ xuống máy
  con trong vòng ~1 phút; mất mạng máy vẫn thi hành quy tắc đã đồng bộ.

## 6. Cách SafePC báo cho phụ huynh

- **Yêu cầu của con**: con xin thêm giờ / xin mở ứng dụng / xin mở trang web
  từ Tray (khay hệ thống) hoặc trang bị chặn → phụ huynh duyệt trên Dashboard
  (trang Yêu cầu) hoặc qua email thông báo.
- **Cảnh báo can thiệp** (trang Nhật ký + email): đổi giờ hệ thống, Agent
  khởi động lại bất thường, extension trình duyệt mất dấu, Tray dừng bất
  thường, Service dừng.
- **Máy offline hơn 48 giờ**: email + mục Thông báo trên Dashboard (máy có
  thể đang tắt, mất mạng, hoặc Agent đã dừng).
- **Báo cáo tuần**: trang Báo cáo trên Dashboard + email sáng thứ Hai hàng
  tuần (giờ Việt Nam).

## 7. Gỡ cài đặt / gỡ mã PIN / khắc phục sự cố

### Gỡ cài đặt SafePC khỏi máy con

1. Đăng nhập máy con bằng tài khoản Admin.
2. Mở **Settings → Apps → SafePC Agent → Uninstall**.
3. Bộ gỡ hỏi **mã PIN phụ huynh** (mã PIN thoát Tray của máy). Nhập đúng mã
   thì gỡ tiếp; nhập sai 3 lần trong một lần gỡ thì hủy gỡ (nhập sai 5 lần
   liên tiếp thì khóa nhập 30 phút).
4. Chưa đặt mã PIN thì gỡ bằng quyền Admin như trước (không hỏi mã).
5. Gỡ im lặng (`unins000.exe /SILENT`) khi đã đặt mã PIN sẽ **bị chặn**:
   muốn gỡ im lặng thì gỡ mã PIN trên Dashboard trước (đợi ~1 phút để Agent
   đồng bộ), rồi gỡ im lặng.

> Lưu ý: mã PIN chỉ bảo vệ đường gỡ được hỗ trợ. Tài khoản Admin vẫn xóa
> tay được file và service (`sc delete SafePCAgent`) nếu thật sự cần — mã
> PIN là rào chắn chống gỡ vô tình hoặc bị con gỡ khi có quyền Admin, không
> phải khóa chống lại admin quyết tâm. Gỡ xong, nhớ xóa hồ sơ máy trên
> Dashboard (trang Thiết bị → Xóa thiết bị) và thu hồi token.

### Sự cố thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| Máy không hiện Online sau khi ghép nối | Đợi 1 phút; kiểm tra mạng máy con; kiểm tra Service có chạy không (`services.msc` → SafePCAgent). Mất mạng thì máy vẫn thi hành quy tắc cũ. |
| Extension báo "chưa kết nối" | Kiểm tra ID extension và đường dẫn `C:\SafePC\extension`; tải lại extension ở `edge://extensions`; kiểm tra Service có chạy không. |
| Tray biến mất khỏi khay hệ thống | Service tự khởi động lại Tray trong ~5 phút (watchdog). Nếu Tray không trở lại sau 10 phút, đăng xuất rồi đăng nhập lại; vẫn không được thì kiểm tra log `%LocalAppData%\SafePC\logs\agent-tray.log`. |
| Nhập mã PIN thoát Tray bị khóa | Sai 5 lần liên tiếp thì khóa nhập 5 phút. Đợi hết khóa rồi nhập lại; nhập đúng mã rồi thì mã tự gỡ — đặt mã mới trên Dashboard. |
| Đồng hồ máy con lệch | Agent so giờ máy với giờ server, lệch quá 5 phút thì báo phụ huynh và vẫn thi hành theo giờ máy + quy tắc đã đồng bộ. Chỉnh lại giờ máy cho đúng. |
| Quên mã PIN | Đặt mã PIN mới trên Dashboard (trang Thiết bị → máy → Lưu mã PIN). Mã mới đồng bộ xuống máy trong ~1 phút; mã cũ (nếu còn) bị thay thế. |

## 8. Bảo mật và giới hạn đã biết

- Bộ cài và file Agent **chưa được ký số** (cần chứng chỉ ký số có phí):
  Windows SmartScreen có thể cảnh báo khi chạy bộ cài. Chỉ chạy bộ cài do
  người quản trị SafePC của gia đình cung cấp (không tải từ link lạ),
  kiểm tra tên file `SafePCAgentSetup-0.1.N.exe` trước khi chạy.
- Con dùng **Standard User**: không dừng được Service (chạy quyền SYSTEM),
  không gỡ được app cài All Users nếu không có Admin, không sửa được quy tắc
  (file quy tắc khóa ACL chỉ SYSTEM + Admins ghi được).
- SafePC **không** chụp màn hình, không ghi phím, không đọc nội dung chat/
  file, không bật mic/camera. Chỉ thu thập tên ứng dụng, thời lượng dùng,
  tên miền + đường dẫn web (đã bỏ phần truy vấn), xem chi tiết trong
  [Chính sách riêng tư](09-PRIVACY-POLICY.md).
- Dữ liệu lưu trên Supabase (Singapore) và Vercel (Dashboard), truyền qua
  TLS. Xem chi tiết trong Chính sách riêng tư.
