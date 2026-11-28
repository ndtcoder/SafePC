# Nghiên cứu Hướng 1: Chụp ảnh màn hình máy con theo định kỳ

> Tài liệu nghiên cứu trong docs/ — CHƯA phải quyết định triển khai.
> Ngày nghiên cứu: 28/11/2026. Người yêu cầu: anh Tiến.
> Yêu cầu gốc: chụp màn hình định kỳ (mức 1/2/5/10/15/30 phút); phụ huynh cân nhắc kỹ và đồng ý về lưu trữ dữ liệu; nén ảnh < 1MB/ảnh; lưu Google Drive, giữ tối đa 1–6 tháng, "có kèm thanh toán nếu muốn lưu dài hơn 2 tuần".

---

## 0. Điểm xuất phát quan trọng nhất: đây là thay đổi ranh giới riêng tư

SafePC hiện đứng trên cam kết **"thu thập tối thiểu — chỉ tên app, thời lượng, tên miền; KHÔNG chụp màn hình, không ghi phím, không đọc nội dung"**. Ngày 17/11/2026 anh Tiến đã **loại chụp màn hình khỏi kế hoạch** vì lý do riêng tư.

Hướng này, nếu làm, là **đảo ngược một quyết định đã chốt** và phá vỡ cam kết riêng tư hiện tại (trang Chính sách riêng tư công khai của SafePC đang tuyên bố không chụp màn hình). Vì vậy nghiên cứu này thiết kế theo nguyên tắc:

- **Opt-in tuyệt đối**: mặc định TẮT cho mọi hồ sơ con, kể cả hồ sơ đã tồn tại. Không bao giờ tự bật sau cập nhật.
- **Đồng ý 2 lớp** (mục 5), có ghi vết (audit) thời điểm + nội dung phiên bản điều khoản đã đồng ý.
- **Minh bạch với con**: không chụp lén — Tray luôn hiển thị trạng thái đang chụp.
- Nếu triển khai phải sửa đồng thời: PRD, trang Chính sách riêng tư công khai, tài liệu hướng dẫn cài đặt — và cân nhắc thông báo lại cho phụ huynh đang dùng.

Mọi số liệu dưới đây: số có ghi nguồn là đã kiểm chứng web ngày 28/11/2026; số còn lại ghi rõ "ước lượng".

---

## 1. Kỹ thuật chụp trên Windows

### 1.1 Chụp ở đâu: Tray, không phải Service

- Service chạy quyền SYSTEM ở session 0 — **không nhìn thấy desktop của người dùng**, không chụp được màn hình phiên con.
- Tray đã chạy sẵn trong phiên người dùng (mỗi tài khoản Windows một Tray) → **module chụp đặt ở Tray** là đúng kiến trúc hiện tại. Tray chụp → gửi ảnh qua IPC pipe xuống Service → Service xếp hàng (outbox như các luồng usage hiện tại) → đẩy lên Drive (mục 3). Cách này giữ nguyên mô hình "Tray là tai mắt trong phiên, Service là nơi giữ token và nói chuyện với bên ngoài" như hiện nay.
- Sprint 5 (nhiều con chung một máy): chụp gắn với **con đang active ở console**, đúng ngữ nghĩa thi hành hiện tại; phiên nền không chụp (không active, và cũng không nên ghi hình người dùng khác đang không bị quản lý).

### 1.2 API chụp

| Cách | Đánh giá |
|---|---|
| GDI `BitBlt` / .NET `Graphics.CopyFromScreen` | Đơn giản nhất, có sẵn trong .NET, đủ cho mọi mức ≥ 1 phút. Chụp được gần như mọi cửa sổ thường. **Đề xuất dùng cho v1.** |
| Windows Graphics Capture (`Windows.Graphics.Capture`, Win10 1803+) | Hiện đại, chụp được từng cửa sổ/màn hình, nhưng từ app desktop/WPF cần interop WinRT, phức tạp hơn; một số trường hợp hiện viền vàng quanh vùng chụp (minh bạch — thực ra là điểm cộng về minh bạch). Để dành nếu cần chụp theo cửa sổ. |
| DXGI Desktop Duplication | Nhanh nhất, hợp quay video/stream; quá mức cần thiết cho ảnh tĩnh mỗi vài phút, xử lý lỗi khi đổi độ phân giải/fullscreen phiền. Không cần. |

### 1.3 Các trường hợp KHÔNG chụp được — phải xử lý trung thực

- **Màn hình khóa (Lock screen) / màn hình đăng nhập / secure desktop (hộp thoại UAC, Ctrl+Alt+Del)**: từ phiên người dùng **không chụp được** — kết quả là ảnh đen hoặc lỗi. Thiết kế đúng: Tray lắng nghe sự kiện khóa/mở phiên (đã có cơ chế theo dõi phiên cho watchdog) → **đang khóa thì bỏ qua lượt chụp**, ghi metadata "đã bỏ qua — máy đang khóa" nếu phụ huynh muốn thấy dòng thời gian liên tục. Đây cũng là một bảo vệ riêng tư tốt: màn hình khóa không có nội dung gì đáng xem.
- **Nội dung được bảo vệ bản quyền (DRM)**: video Netflix/ứng dụng dùng protected media path có thể ra hình đen trong ảnh chụp. Không có cách hợp lệ để vượt qua — ghi nhận là giới hạn.
- **Đa màn hình**: chụp toàn bộ màn hình ảo (virtual screen) gộp tất cả màn hình thành 1 ảnh, hoặc chụp riêng màn hình chính. Đề xuất v1: **chỉ màn hình chính** (nơi con tương tác chính), giảm dung lượng và giảm xâm phạm; đa màn hình để tùy chọn sau.
- **Máy đang ngủ/không có phiên console active**: không chụp.

### 1.4 Thu nhỏ + nén: đạt < 1MB rất dễ, thực tế nhẹ hơn nhiều

Quy trình: chụp ở độ phân giải gốc → thu nhỏ về **chiều rộng 1280px** (giữ tỷ lệ; 1080p → 1280×720, chữ vẫn đọc được ở mức liếc xem nội dung) → mã hóa:

| Định dạng | Kích thước ước lượng, ảnh desktop 1280×720 | Ghi chú |
|---|---|---|
| JPEG chất lượng 70–75 | ~80–250 KB (ước lượng) | Màn hình học tập/văn bản nén rất tốt (~80–150 KB); màn hình nhiều ảnh/video thì cao hơn (~200–300 KB) |
| WebP chất lượng 70 | ~60–180 KB (ước lượng) | Nhỏ hơn JPEG ~25–35% ở cùng chất lượng nhìn; .NET cần thư viện thêm (ImageSharp/libwebp) vì GDI+ không ghi WebP |
| PNG | 500 KB – 2 MB | Không phù hợp — loại |

Kết luận: trần "<1MB/ảnh" đạt dễ dàng; **mức làm việc thực tế nên tính theo trung bình 150–300 KB/ảnh**. Đề xuất mặc định: **JPEG q72** cho v1 (thuần .NET, không thêm dependency), cân nhắc WebP ở đợt sau nếu muốn tiết kiệm thêm ~30%.

### 1.5 Khử trùng lặp — giảm mạnh số ảnh phải lưu

Màn hình học tập thường đứng yên lâu (đọc tài liệu, xem một trang). Cơ chế:

- Tính **perceptual hash (dHash)** trên bản thu nhỏ 32×32 grayscale của ảnh vừa chụp, so với ảnh gần nhất đã lưu: khoảng cách Hamming dưới ngưỡng (ảnh gần như không đổi) → **bỏ qua, không upload**, chỉ ghi nhận "không đổi" vào bộ đếm.
- Bổ sung luật cứng: nếu cửa sổ foreground + tiêu đề tiến trình không đổi AND hash gần giống → bỏ qua.
- Hiệu quả ước lượng: giảm **30–60%** số ảnh trong ngày học tập tĩnh (ước lượng — phụ thuộc thói quen dùng máy; xem video/chơi game thì gần như không giảm). Các bảng dung lượng ở mục 2 tính theo **chưa khử trùng** (kịch bản xấu nhất), phần khử trùng coi là khoản tiết kiệm cộng thêm.

### 1.6 Mức 1 phút có khả thi không?

- **Hiệu năng**: một lượt chụp + thu nhỏ + nén JPEG 1280px tốn ~50–200 ms CPU (ước lượng, máy phổ thông) — ở mức 1 phút là không đáng kể (< 0,5% CPU trung bình). Pin laptop: ảnh hưởng nhỏ nhưng không bằng 0; mức 1 phút liên tục cả ngày là mức "soi" rất cao.
- **Băng thông**: mức 1 phút ở 300 KB ≈ 180 MB/ngày upload — bình thường với mạng gia đình.
- **Kết luận**: 1 phút khả thi về kỹ thuật, nhưng là mức xâm phạm riêng tư cao nhất và tốn dung lượng nhất (mục 2). Nên có nhưng kèm cảnh báo mạnh trong UI; **không đặt làm mặc định**.

---

## 2. Toán dung lượng

Giả định: ngày dùng máy **10 giờ** (khoảng 8–12 giờ theo yêu cầu; số ở 8h = ×0,8, ở 12h = ×1,2). Chưa tính khử trùng lặp.

### 2.1 Số ảnh và dung lượng theo mức chụp

| Mức chụp | Ảnh/ngày | MB/ngày @150KB | MB/ngày @300KB | MB/ngày @500KB | GB/tháng @300KB |
|---|---|---|---|---|---|
| 1 phút | 600 | 90 | 180 | 300 | 5,4 GB |
| 2 phút | 300 | 45 | 90 | 150 | 2,7 GB |
| 5 phút | 120 | 18 | 36 | 60 | ~1,1 GB |
| 10 phút | 60 | 9 | 18 | 30 | 0,54 GB |
| 15 phút | 40 | 6 | 12 | 20 | 0,36 GB |
| 30 phút | 20 | 3 | 6 | 10 | 0,18 GB |

### 2.2 Drive miễn phí 15 GB giữ được bao lâu (ở mức trung bình 300 KB/ảnh, chưa khử trùng)

| Mức chụp | 15 GB giữ được | Ghi chú |
|---|---|---|
| 1 phút | ~83 ngày (~2,7 tháng) | Muốn giữ 6 tháng phải mua thêm dung lượng |
| 2 phút | ~166 ngày (~5,5 tháng) | Sát ngưỡng 6 tháng |
| 5 phút | ~416 ngày (> 1 năm) | Miễn phí thừa sức cho mọi hạn giữ ≤ 6 tháng |
| 10 phút | ~2,3 năm | — |
| 15 phút | ~3,4 năm | — |
| 30 phút | ~6,8 năm | — |

Lưu ý trung thực:
- 15 GB là dung lượng **dùng chung Gmail + Drive + Photos** của tài khoản Google phụ huynh — phần trống thực tế thường ít hơn 15 GB. Dashboard nên hiển thị dung lượng Drive còn trống (Drive API trả về được) và cảnh báo khi sắp đầy.
- Khử trùng lặp (mục 1.5) có thể kéo dài các con số trên thêm ~1,4–2,5 lần (ước lượng).
- Nhiều con/máy: mỗi con một thư mục riêng trên cùng Drive phụ huynh → cộng dồn. Hai con cùng mức 1 phút ≈ 10,8 GB/tháng — vượt khả năng gói miễn phí nếu giữ lâu.

### 2.3 Vì sao không dùng Supabase Storage

Supabase Free chỉ có **1 GB** Storage (giới hạn gói Free hiện hành) — ở mức 5 phút/300 KB, một con dùng ~36 MB/ngày thì 1 GB hết trong ~27 ngày cho MỘT con, và đó là hạn mức chung toàn hệ thống (mọi gia đình). Không khả thi ở bất kỳ mức chụp nào trừ 30 phút. Supabase chỉ nên lưu **metadata** (mục 3.4).

---

## 3. Kiến trúc lưu trữ Google Drive

### 3.1 Quyết định gốc: Drive của phụ huynh hay Drive của nhà vận hành?

| Tiêu chí | Mỗi phụ huynh tự kết nối Drive của mình (OAuth) | Một Drive trung tâm của nhà vận hành |
|---|---|---|
| Chi phí vận hành | ~0 — dung lượng là của phụ huynh | Nhà vận hành phải mua dung lượng cho mọi gia đình — phá vỡ mô hình "dịch vụ free, < 100 user" hiện tại |
| Riêng tư/pháp lý | Ảnh con nằm trong tài sản số của chính phụ huynh; SafePC không "giữ" dữ liệu nhạy cảm nhất | SafePC trở thành bên lưu trữ ảnh trẻ em của nhiều gia đình — rủi ro pháp lý + rủi ro rò rỉ tập trung rất lớn |
| Quyền kiểm soát của phụ huynh | Tự xóa, tự tải, tự ngắt kết nối bất cứ lúc nào | Phụ thuộc nhà vận hành |
| Độ phức tạp kỹ thuật | Cần luồng OAuth + quản lý token cho từng phụ huynh | Đơn giản hơn về code |
| Rủi ro | Phụ huynh xóa nhầm thư mục; hết dung lượng; thu hồi quyền | Một sự cố = lộ ảnh của mọi gia đình |

**Khuyến nghị: Drive của từng phụ huynh qua OAuth.** Đây cũng là mô hình khớp với câu "phụ huynh tự mua Google One nếu muốn lưu lâu hơn" ở mục 4.

### 3.2 Quyền truy cập xin tối thiểu: scope `drive.file`

- Xin scope **`https://www.googleapis.com/auth/drive.file`**: ứng dụng **chỉ nhìn thấy file/thư mục do chính nó tạo ra** trong Drive phụ huynh — không đọc được tài liệu khác của họ. Đây là điểm bán hàng về riêng tư rất quan trọng và phải ghi rõ ở màn hình đồng ý của Google lẫn của SafePC.
- Đánh đổi: phụ huynh mở Drive bằng trình duyệt vẫn thấy thư mục SafePC bình thường (file do app tạo vẫn là file của họ); nhưng nếu họ đổi tên/di chuyển file, app vẫn theo được qua file ID.
- Phát hành công khai với scope này vẫn cần Google xác minh OAuth consent screen (nhẹ hơn nhiều so với scope `drive` toàn quyền — loại restricted, phải qua thẩm định bảo mật CASA tốn kém). Giai đoạn < 100 user: app chưa xác minh vẫn chạy được với giới hạn 100 người dùng + màn hình cảnh báo "ứng dụng chưa được xác minh" — chấp nhận được cho quy mô hiện tại, cần xác minh khi mở rộng.

### 3.3 Upload từ đâu — ai giữ token?

Luồng OAuth: phụ huynh bấm "Kết nối Google Drive" trên Dashboard → đăng nhập Google → Google trả **refresh token**. Câu hỏi là refresh token nằm ở đâu và ai upload:

**Phương án A — Agent upload thẳng lên Drive (đề xuất)**
- Refresh token được Service lưu trên **máy con**, mã hóa DPAPI + ACL SYSTEM/Admins — cùng cơ chế đang bảo vệ `device_token.dat` hiện tại (đã có từ Sprint 4).
- Phụ huynh cấp quyền một lần trên Dashboard; token được chuyển xuống máy con qua kênh lệnh/thiết bị hiện có (cùng đường device token), Supabase chỉ giữ trạng thái "đã kết nối" + email Drive (không giữ refresh token, hoặc giữ bản mã hóa dự phòng — cân nhắc thêm).
- Service tự đổi refresh token → access token (hạn 1 giờ) khi cần upload; xếp hàng outbox khi mất mạng, đẩy bù khi có mạng.
- Ưu: ảnh đi thẳng máy con → Google, **không qua Supabase** (không tốn băng thông Supabase Free, không thêm một bên chạm vào ảnh). Token không nằm trên server trung tâm.
- Nhược/rủi ro: token nằm trên máy con. Giảm thiểu: (1) scope `drive.file` — token bị lộ cũng chỉ chạm được thư mục SafePC, không chạm tài liệu khác của phụ huynh; (2) lưu cùng chuẩn ACL + DPAPI như device token; (3) con dùng tài khoản Standard (đúng mô hình SafePC hiện tại) thì không đọc được file token; (4) phụ huynh **thu hồi quyền bất cứ lúc nào** từ Dashboard hoặc từ trang quyền Google — thu hồi là cắt đứt hoàn toàn.

**Phương án B — Upload qua Supabase Edge Function trung gian**
- Agent gửi ảnh lên Edge Function (xác thực bằng device token), Function giữ refresh token (mã hóa, lưu server) và đẩy sang Drive.
- Ưu: token không ở máy con; kiểm soát tập trung (giới hạn tần suất, chặn khi hết hạn giữ…).
- Nhược lớn: **toàn bộ ảnh chạy qua Supabase** — băng thông gói Free rất hạn chế (ảnh mức 5 phút của vài gia đình đã có thể vượt), độ trễ + điểm nghẽn mới, và SafePC trở thành bên "chạm" vào mọi ảnh — đi ngược nguyên tắc giảm bề mặt dữ liệu. **Không đề xuất.**

### 3.4 Cấu trúc dữ liệu

- Trên Drive phụ huynh:
  ```
  SafePC/
    <tên con>/
      2026-11-28/
        073015.jpg
        073515.jpg
        ...
  ```
  Tên file = giờ chụp (HHmmss, giờ địa phương gia đình). Một thư mục/ngày giúp dọn dẹp theo hạn giữ cực rẻ (xóa cả thư mục ngày).
- Trên Supabase — bảng metadata mới (ước lượng tên `screenshot_index`): `child_id, device_id, taken_at, size_bytes, drive_file_id, drive_folder_date, width, skipped_reason (null nếu có ảnh)`. Metadata nhẹ (~vài trăm byte/dòng); mức 1 phút = 600 dòng/ngày/con — nằm trong khả năng Postgres Free, và dọn cùng hạn giữ.
- Ảnh xem trên Dashboard: Dashboard xin link qua Drive API (file ID → thumbnail/link tạm qua access token của phụ huynh — chính phụ huynh đang đăng nhập Google đó). Không proxy ảnh qua Supabase.

### 3.5 Dọn dẹp theo hạn giữ

- Hạn giữ là cài đặt theo hồ sơ con: **14 ngày (mặc định) / 1 tháng / 3 tháng / 6 tháng** (ánh xạ yêu cầu "1–6 tháng, > 2 tuần thì trả phí" — xem mục 4).
- Cơ chế: Edge Function chạy cron hằng ngày (cùng mẫu cron báo cáo tuần hiện có): với mỗi hồ sơ bật chụp, liệt kê thư mục ngày cũ hơn hạn giữ trong Drive phụ huynh (dùng refresh token — **đây là một điểm cần token ở server**: nếu chọn Phương án A thuần túy, việc dọn dẹp có thể giao cho **chính Agent** làm khi máy con online: Service tự xóa thư mục ngày quá hạn bằng token nó giữ, mỗi lần khởi động + mỗi ngày một lần. Cách này giữ nguyên tắc "token không lên server". Nếu máy con tắt nhiều ngày, dọn trễ — chấp nhận được, và Dashboard hiển thị "sẽ dọn khi máy con online". **Đề xuất: Agent tự dọn**, Edge Function chỉ nhắc khi phát hiện metadata quá hạn lâu bất thường.)
- Xóa trên Drive = chuyển vào thùng rác Drive (Google giữ 30 ngày rồi xóa hẳn) hoặc xóa vĩnh viễn ngay bằng API `files.delete` — đề xuất **xóa vĩnh viễn ngay** cho dữ liệu trẻ em, tránh "đã xóa mà vẫn khôi phục được" gây hiểu nhầm. Đồng thời xóa dòng metadata trên Supabase.
- Khi phụ huynh **tắt opt-in hoặc rút đồng ý**: dừng chụp ngay từ lượt kế tiếp; hỏi rõ "xóa toàn bộ ảnh đã chụp?" — mặc định đề xuất xóa hết, và việc xóa phải hoàn tất + ghi vết audit (yêu cầu pháp lý ở mục 5.3).

### 3.6 Giới hạn Drive API — không phải vấn đề

Đã kiểm chứng (Google Drive API quotas, developers.google.com): mỗi user upload tối đa **750 GB/ngày**, hạn mức request theo phút rất cao (325.000 quota units/phút/user) — mức chụp dày nhất của SafePC (600 ảnh/ngày, ~180 MB) chỉ là phần rất nhỏ. Không cần lo quota; chỉ cần xử lý lỗi 403 khi **hết dung lượng Drive** (dừng upload, báo Dashboard "Drive đã đầy") và backoff khi lỗi mạng.

---

## 4. Mô hình "thanh toán nếu lưu > 2 tuần" — làm rõ bản chất

Yêu cầu gốc nói "có kèm thanh toán nếu muốn lưu dài hơn 2 tuần". Cần nói thẳng cơ chế thật:

- **Dung lượng là của phụ huynh** (Drive của họ) → **SafePC không thu tiền và không nên thu tiền trung gian.** "Trả phí" ở đây = **phụ huynh tự mua Google One cho tài khoản Google của chính họ** nếu 15 GB miễn phí không đủ cho hạn giữ + mức chụp họ chọn.
- Giá Google One tại Việt Nam (kiểm chứng web 28/11/2026, nhiều nguồn bán lẻ/ tin tức công nghệ VN thống nhất; giá chính thức xem tại one.google.com):
  - 100 GB: **45.000đ/tháng** (450.000đ/năm)
  - 200 GB: **69.000đ/tháng** (690.000đ/năm)
  - 2 TB: **225.000đ/tháng** (2.250.000đ/năm)
- Thiết kế gói trong SafePC:
  - **Mặc định miễn phí: giữ 14 ngày** — ở mọi mức chụp ≤ 5 phút, 14 ngày tốn ≤ ~0,5 GB (300 KB/ảnh) → vừa thoải mái trong 15 GB miễn phí kể cả Drive đã dùng một phần.
  - Phụ huynh tự nâng hạn giữ lên 1/3/6 tháng trong cài đặt; Dashboard **tính trước dung lượng ước tính** theo mức chụp × hạn giữ và cảnh báo "cấu hình này cần khoảng X GB — Drive của bạn còn Y GB" kèm gợi ý gói Google One phù hợp nếu thiếu. SafePC không bán gói, không affiliate ở v1.
  - Nếu Drive đầy giữa chừng: hệ thống tự rút hạn giữ hiệu lực xuống mức vừa dung lượng (xóa cũ nhất trước) và báo phụ huynh — không để mất ảnh mới nhất một cách im lặng.

Nói cách khác: "thanh toán" là **chi phí Google One do phụ huynh tự trả cho Google**, SafePC chỉ làm nhiệm vụ tính toán + cảnh báo trung thực. Điều này giữ đúng mô hình "SafePC dùng dịch vụ free" hiện tại.

---

## 5. Riêng tư, đồng ý và pháp lý — phần quan trọng nhất của hướng này

### 5.1 Thiết kế đồng ý 2 lớp

**Lớp 1 — Bật opt-in theo từng hồ sơ con** (không bật theo tài khoản, không bật toàn gia đình):
- Trong trang hồ sơ con, mục riêng "Chụp màn hình định kỳ" với công tắc mặc định TẮT.
- Bật lên → bắt buộc qua **màn hình đồng ý riêng** (không phải checkbox nhỏ), trình bày bằng tiếng Việt dễ hiểu:
  - Chụp **cái gì**: toàn bộ màn hình chính của máy con khi con đang dùng, mỗi X phút.
  - **Không** chụp khi máy đang khóa; không ghi phím; không ghi âm/hình webcam.
  - Ảnh lưu ở **Google Drive của chính phụ huynh** (kèm email), thư mục SafePC; SafePC chỉ giữ danh mục thời điểm chụp.
  - **Ai xem được**: các phụ huynh trong gia đình có quyền xem hồ sơ con (gồm phụ huynh thứ hai nếu đã mời).
  - **Giữ bao lâu**: hạn giữ đã chọn, xóa vĩnh viễn tự động sau đó; phụ huynh xóa tay bất cứ lúc nào; tắt tính năng = được hỏi xóa toàn bộ.
  - **Rủi ro nói thẳng**: ảnh có thể chứa nội dung nhạy cảm con đang xem/gõ dở (tin nhắn, thông tin cá nhân) — phụ huynh xác nhận đã cân nhắc.
  - Với con **từ đủ 7 tuổi**: theo pháp lý (mục 5.3), cần cả sự đồng ý của con — thiết kế thực tế: sau khi phụ huynh bật, **Tray trên máy con hiện hộp thoại cho con** giải thích và yêu cầu con bấm "Con đã hiểu và đồng ý" ở lần đầu (và mỗi lần phụ huynh đổi mức chụp sang dày hơn). Con không đồng ý → không chụp, Dashboard báo "con chưa đồng ý". (Đây vừa là yêu cầu pháp lý vừa là ranh giới đạo đức của sản phẩm.)
- Ghi vết đồng ý: thời điểm, tài khoản phụ huynh, phiên bản nội dung đồng ý, mức chụp + hạn giữ tại thời điểm đồng ý — lưu server, đưa vào xuất dữ liệu.

**Lớp 2 — Nhắc lại định kỳ + khi thay đổi nhạy cảm:**
- Mỗi **90 ngày**, Dashboard nhắc phụ huynh xem lại: "Tính năng chụp màn hình vẫn đang bật cho <con> ở mức X phút — Tiếp tục / Tắt". Không trả lời thì **tự tạm dừng chụp** sau 7 ngày từ lúc nhắc (fail-safe về phía riêng tư, không phải về phía giám sát).
- Đổi mức chụp sang **dày hơn** (vd 10 → 2 phút) hoặc tăng hạn giữ: phải qua lại màn hình đồng ý rút gọn + (với con ≥ 7 tuổi) xác nhận lại phía con.
- Email tóm tắt tuần (đã có) thêm một dòng: "Tuần này đã chụp N ảnh màn hình của <con>" — để tính năng không bao giờ trở thành "bật rồi quên".

### 5.2 Minh bạch với con — không chụp lén

- Tray hiển thị trạng thái thường trực khi tính năng bật: biểu tượng + dòng chữ trong menu khay **"Màn hình đang được chụp mỗi X phút để bố mẹ xem lại"**; tại thời điểm chụp có thể nháy biểu tượng nhẹ (không phát âm thanh, không popup gây phiền).
- Trang "Giờ tin cậy"/thông tin trên máy con giải thích bằng ngôn ngữ phù hợp tuổi.
- Nguyên tắc sản phẩm: SafePC là công cụ **đồng hành minh bạch**, không phải phần mềm gián điệp. Nếu một tính năng chỉ "hiệu quả" khi con không biết, tính năng đó không thuộc về SafePC.

### 5.3 Pháp lý Việt Nam

- **Nghị định 13/2023/NĐ-CP, Điều 20** (kiểm chứng web 28/11/2026, thuvienphapluat.vn + cổng thông tin Bộ TT&TT):
  - Xử lý dữ liệu cá nhân của trẻ em phải theo nguyên tắc **vì lợi ích tốt nhất của trẻ em**.
  - Phải có **sự đồng ý của cha, mẹ hoặc người giám hộ**; với trẻ **từ đủ 7 tuổi trở lên phải có thêm sự đồng ý của chính trẻ**. Bên kiểm soát/xử lý phải **xác minh tuổi** của trẻ trước khi xử lý. → Hồ sơ con của SafePC cần có **ngày sinh/tuổi** để biết khi nào cần đồng ý hai phía (hiện hồ sơ chưa bắt buộc trường này — một việc phải bổ sung nếu làm hướng này).
  - Phải **ngừng xử lý, xóa không thể khôi phục** khi: xử lý sai mục đích/đã xong mục đích, hoặc **cha mẹ rút lại sự đồng ý**. → Cơ chế tắt + xóa toàn bộ ở mục 3.5/5.1 không phải "nice to have" mà là nghĩa vụ.
  - Ảnh chụp màn hình là **dữ liệu cá nhân** (hình ảnh gắn với một người cụ thể — Điều 2), và có thể tình cờ chứa **dữ liệu nhạy cảm** (nội dung tin nhắn, thông tin tài khoản, hình ảnh riêng tư của con hoặc của người khác đang chat với con — lưu ý: ảnh còn có thể chứa dữ liệu của **bên thứ ba**, vd bạn của con trong cuộc trò chuyện — người không hề đồng ý với SafePC).
- **Lưu ý thời hiệu**: từ 01/01/2026, Luật Bảo vệ dữ liệu cá nhân 2025 có hiệu lực và sẽ thay thế/kế thừa khung Nghị định 13/2023 — khi triển khai thật phải rà soát lại điều khoản tương ứng trong luật mới (điểm cần kiểm chứng lại tại thời điểm làm, không dựa hẳn vào bản nghiên cứu này).
- Đây là nghiên cứu kỹ thuật/sản phẩm, **không phải tư vấn pháp lý**; trước khi phát hành tính năng này cho gia đình khác ngoài gia đình anh Tiến, nên có một lượt rà soát pháp lý thật.

### 5.4 Rủi ro nội dung nhạy cảm trong ảnh và giảm thiểu

| Rủi ro | Giảm thiểu khả thi | Phần không giảm được (nói thẳng) |
|---|---|---|
| Ảnh chứa mật khẩu con gõ dở, OTP, thông tin tài chính của gia đình | Thu nhỏ 1280px làm giảm khả năng đọc chi tiết nhỏ; hạn giữ ngắn mặc định 14 ngày; ảnh nằm trong Drive phụ huynh (không qua server SafePC) | Vẫn có thể đọc được phần lớn nội dung — đây là bản chất của tính năng |
| Ảnh chứa tin nhắn riêng tư của con với bạn bè (kèm dữ liệu của bên thứ ba) | Minh bạch với con; đồng ý của con ≥ 7 tuổi; khuyến nghị mức chụp thưa (≥ 5 phút) | Không lọc được nội dung trước khi chụp bằng kỹ thuật đơn giản đáng tin cậy |
| Con mở tài liệu/ảnh riêng tư của chính con | Tùy chọn "tạm dừng chụp theo ứng dụng" (danh sách app mà khi đang ở foreground thì bỏ qua lượt chụp — khả thi vì Tray biết app foreground) + nút **tạm dừng chụp 30 phút** trên Tray cho con (giờ tạm dừng hiện rõ trên Dashboard của phụ huynh — minh bạch hai chiều) | Không thể tự động nhận biết "nội dung nhạy cảm" một cách đáng tin |
| Rò rỉ tài khoản Google của phụ huynh → lộ toàn bộ ảnh | Scope `drive.file`; khuyến nghị phụ huynh bật 2FA Google (đã có tiền lệ hướng dẫn 2FA trong sản phẩm) | Ngoài tầm kiểm soát của SafePC |
| Phụ huynh dùng ảnh sai mục đích / xung đột gia đình | Điều khoản sử dụng; thiết kế minh bạch với con làm giảm tính "theo dõi lén" | SafePC không kiểm soát được hành vi người dùng — rủi ro sản phẩm phải chấp nhận và ghi rõ |

**Về "tạm dừng theo lịch/ứng dụng nhạy cảm"**: khả thi một phần — tạm dừng theo **ứng dụng foreground** (danh sách phụ huynh đặt, vd ứng dụng chat, ứng dụng ngân hàng) và theo **khung giờ** (vd không chụp sau 21h) làm được bằng dữ kiện Tray đã có. Nhận biết nội dung nhạy cảm bằng AI trên ảnh trước khi lưu: không khả thi tin cậy ở quy mô này (và tự nó lại là một lớp xử lý dữ liệu nữa) — **không hứa**.

### 5.5 Quan hệ với xuất/xóa dữ liệu con hiện có

- Xuất dữ liệu (migration 15): bổ sung mục "Ảnh chụp màn hình": xuất **danh mục metadata + link Drive** (ảnh thật nằm ở Drive phụ huynh — họ tự tải trực tiếp từ Drive; SafePC không tải hộ toàn bộ ảnh qua server).
- Xóa dữ liệu con: phải xóa cả thư mục Drive của con + metadata, ghi vết vào audit như các mục khác. Nếu phụ huynh đã thu hồi quyền Drive trước đó, hệ thống báo rõ "không còn quyền xóa trên Drive — vui lòng xóa thư mục SafePC/<con> thủ công" thay vì báo thành công giả (bài học từ lỗi "Đã lưu giả" của đợt múi giờ).

---

## 6. Giao diện xem trên Dashboard

- Trong trang hồ sơ con, thêm tab/mục **"Ảnh màn hình"** (chỉ hiện khi tính năng đã bật hoặc từng bật).
- **Dòng thời gian theo ngày**: chọn ngày → lưới thumbnail theo giờ (thumbnail lấy từ Drive API — Google tự sinh thumbnail cho ảnh), cuộn dọc; các khoảng "đã bỏ qua vì màn hình khóa / ảnh không đổi" hiển thị thành vệt mờ ghi lý do, để phụ huynh không hiểu lầm là mất dữ liệu.
- Xem từng ảnh: bấm → xem lớn (link xem trực tiếp từ Drive, mở trong khung Dashboard), có nút: **Tải về**, **Xóa ảnh này** (xóa cả trên Drive + metadata, ghi audit), chuyển ảnh trước/sau bằng phím mũi tên.
- Đầu trang luôn có thanh trạng thái: mức chụp hiện tại, hạn giữ, dung lượng Drive còn trống, nút Tạm dừng / Tắt hẳn / Đổi cài đặt.
- Trên điện thoại (Dashboard là PWA mobile-first): lưới 2 cột, xem ảnh toàn màn hình — không cần tính năng riêng.

---

## 7. Kết luận và khuyến nghị

### 7.1 Khuyến nghị cấu hình mặc định (nếu anh quyết làm)

| Hạng mục | Đề xuất |
|---|---|
| Trạng thái mặc định | **TẮT**, opt-in theo từng con, đồng ý 2 lớp như mục 5.1 |
| Mức chụp mặc định khi bật | **5 phút** (120 ảnh/ngày, ~36 MB/ngày ở 300 KB — nhẹ cả dung lượng lẫn mức độ xâm phạm) |
| Mức chụp cho phép | 2 / 5 / 10 / 15 / 30 phút; **1 phút chỉ mở khi phụ huynh xác nhận thêm một cảnh báo riêng** |
| Định dạng | Thu nhỏ 1280px, **JPEG q72** (ước lượng 80–250 KB/ảnh); khử trùng lặp bằng perceptual hash bật sẵn |
| Lưu trữ | Drive của phụ huynh, scope `drive.file`, Agent upload thẳng + tự dọn dẹp; Supabase chỉ giữ metadata |
| Hạn giữ mặc định | **14 ngày**, tự nâng tối đa 6 tháng kèm tính toán dung lượng + cảnh báo Google One |
| Minh bạch | Tray luôn hiện trạng thái chụp; con ≥ 7 tuổi xác nhận trên máy con; nhắc lại đồng ý mỗi 90 ngày, không xác nhận thì tự tạm dừng |

### 7.2 Rủi ro lớn nhất (xếp hạng)

1. **Rủi ro riêng tư/pháp lý** — đây là tính năng nhạy cảm nhất SafePC từng có; một sai sót (chụp khi chưa đồng ý đủ, xóa không sạch khi rút đồng ý, ảnh chứa dữ liệu bên thứ ba) gây hại lớn hơn mọi lợi ích giám sát. Cũng là tính năng dễ làm mất niềm tin của con nhất nếu cảm giác "bị soi lén" — thiết kế minh bạch là điều kiện sống còn, không phải trang trí.
2. **Đảo ngược cam kết đã công khai** — trang Chính sách riêng tư hiện tuyên bố không chụp màn hình; triển khai phải sửa tuyên bố + thông báo lại, và chấp nhận rằng một số phụ huynh chọn SafePC *vì* cam kết cũ.
3. **Phụ thuộc Google** — OAuth verification khi mở rộng quá 100 user, thay đổi chính sách Drive API, tài khoản phụ huynh hết dung lượng/khóa tài khoản.
4. Rủi ro kỹ thuật thuần túy (chụp, nén, upload) là **thấp nhất** — mọi khối kỹ thuật đều đã có tiền lệ trong Agent hiện tại (Tray trong phiên, IPC, outbox, DPAPI token, cron dọn dẹp).

### 7.3 Việc cần anh Tiến quyết (câu hỏi chốt)

1. **Có làm hay không** — chấp nhận đảo ngược quyết định 17/11/2026 và sửa cam kết riêng tư công khai của SafePC?
2. Nếu làm: mức chụp **tối thiểu cho phép** là 2 phút hay vẫn mở cả 1 phút (kèm cảnh báo riêng)?
3. Đồng ý phía con (≥ 7 tuổi) xử lý thế nào khi con **không đồng ý**: tôn trọng tuyệt đối (không chụp) — đúng luật — hay cần cơ chế khác? (Researcher khuyến nghị: tôn trọng tuyệt đối.)
4. Hạn giữ mặc định **14 ngày** và trần **6 tháng** có đúng ý anh không; khi Drive đầy, tự xóa cũ nhất + báo — chấp nhận?
5. Token Drive lưu ở **máy con** (Phương án A, ảnh không qua server SafePC) hay anh muốn token ở server (Phương án B, đổi lại ảnh phải chạy qua Supabase — researcher không khuyến nghị B)?
6. Có cho phép **tạm dừng theo ứng dụng** (vd không chụp khi con đang ở ứng dụng chat) không — tính năng này giảm xâm phạm nhưng cũng tạo "điểm mù" giám sát; anh chọn minh bạch riêng tư hay chọn bao phủ?
7. Phạm vi phát hành: chỉ gia đình anh dùng thử trước (chấp nhận màn hình "app chưa xác minh" của Google) hay làm hồ sơ xác minh OAuth Google ngay từ đầu để mở cho gia đình khác?

---

## Nguồn kiểm chứng (truy cập 28/11/2026)

- Giá Google One Việt Nam: tổng hợp các trang tin/bán lẻ công nghệ VN (FPT Shop, Tenten, Mytour — thống nhất 100GB 45.000đ, 200GB 69.000đ, 2TB 225.000đ/tháng); giá chính thức đối chiếu tại one.google.com.
- Google Drive API quotas & upload limits: developers.google.com/workspace/drive/api/guides/quotas (750 GB/ngày/user; 1.000.000 quota units/phút/project; 325.000/phút/user).
- Nghị định 13/2023/NĐ-CP Điều 20 (dữ liệu cá nhân trẻ em): thuvienphapluat.vn; cspl.mic.gov.vn (cổng thông tin Bộ Thông tin & Truyền thông).
- Giới hạn Supabase Storage gói Free (1 GB): theo thông số gói Free hiện hành của Supabase (đã dùng trong các nghiên cứu trước của dự án).
