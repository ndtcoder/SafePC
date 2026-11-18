# Email thông báo cho phụ huynh — các bước anh Tiến làm tay

Edge Function `send-parent-notifications` gửi email cho phụ huynh khi có
sự kiện cần chú ý (PRD §2.8): con xin thêm giờ / xin mở ứng dụng / xin mở
trang web, phát hiện can thiệp (đổi giờ, Agent khởi động lại, mất extension, Service
dừng), và máy offline bất thường (quá 48 giờ). Function quét mỗi 5 phút
qua lịch cron nên email tới chậm tối đa 5 phút sau khi sự kiện xảy ra.
Code đã viết sẵn trong repo
(`backend/supabase/functions/send-parent-notifications/index.ts`); lịch
quét nằm trong migration 12. Anh chỉ cần làm 4 bước dưới đây, theo đúng
thứ tự. Quy tắc gửi/chống trùng chi tiết xem mục 8.

## 0. Trước khi bắt đầu

- Đã có tài khoản Resend (miễn phí) và một API key loại **send-only**,
  cùng chuỗi secret bảo vệ endpoint — cả hai đã đặt khi cài email báo
  cáo tuần (docs/06 mục 2). Đợt này **không cần secret mới**: function
  mới dùng chung đúng hai giá trị đó.
- Nếu email báo cáo tuần chưa từng được cài đặt thì đặt hai secret đó
  trước (xem docs/06 mục 2), rồi quay lại đây.
- Chưa có domain cũng chạy được ngay: email gửi từ
  `onboarding@resend.dev` và Resend chỉ giao tới **đúng email đăng ký tài
  khoản Resend**. Gia đình chỉ có một phụ huynh (email đó) thì đủ dùng.
  Gia đình có phụ huynh thứ hai với email khác thì lần gửi sẽ bị Resend
  từ chối (lỗi 403) cho tới khi xác minh domain — xem mục 6.
- URL project và khóa quản trị đã có sẵn trong Edge Function, anh không
  cần đặt thêm hai giá trị đó.

## 1. Deploy Edge Function

1. Mở project SafePC trên Dashboard, vào **Edge Functions** > **Create
   a new function** (hoặc **New function**).
2. Tên function phải đúng: `send-parent-notifications` (lịch cron gọi
   đúng tên này — sai tên thì lịch gọi hụt).
3. Mở file
   `backend/supabase/functions/send-parent-notifications/index.ts`
   trong repo, copy toàn bộ nội dung, dán vào khung code, bấm **Deploy**.
4. **Bắt buộc: tắt JWT verification cho function này.** Function xác
   thực bằng header secret chung (`x-safepc-report-secret`) thay vì
   JWT — nếu để JWT verification bật thì lịch cron (không gửi JWT) sẽ
   bị chặn 401 trước khi tới code. Trong Dashboard: mở function >
   **Settings** > tắt **Verify JWT** (hoặc deploy bằng CLI với cờ
   `--no-verify-jwt`). Chỉ tắt cho function này, không tắt cho function
   khác.

## 2. Secrets — không cần thêm gì

Function mới đọc đúng các secret đã đặt cho email báo cáo tuần:

| Tên secret | Dùng làm gì ở đây |
|---|---|
| `RESEND_API_KEY` | Khóa API send-only để gửi email qua Resend. |
| `WEEKLY_REPORT_SECRET` | Chuỗi bí mật bảo vệ endpoint; lịch cron gửi kèm trong header. Dùng chung với function báo cáo tuần. |
| `RESEND_FROM` | **Để trống lúc này** nếu chưa có domain (xem mục 6). |

Nếu anh đổi secret nào thì phải **deploy lại function** thì secret mới
có hiệu lực (deploy lại cùng code, không cần sửa gì).

## 3. Gửi thử khô (không gửi email thật)

Bước này kiểm tra function quét đúng dữ liệu mà không tốn lượt gửi và
không cần migration 12. Chạy trong PowerShell/Terminal (thay
`<SECRET>` bằng chuỗi secret ở mục 2):

```bash
curl -X POST "https://fzknvolkxnwfxdcfmops.supabase.co/functions/v1/send-parent-notifications" \
  -H "Content-Type: application/json" \
  -H "x-safepc-report-secret: <SECRET>" \
  -d '{"dry_run": true}'
```

Kỳ vọng: HTTP 200, JSON trả về có `"dry_run": true` và một mục
`results` cho gia đình của anh; mục `events` liệt kê các sự kiện SẼ
được gửi (trạng thái `would_send`) hoặc sẽ bị bỏ qua
(`would_skip`/`would_throttle`), kèm lý do. Nếu chưa có sự kiện nào thì
`events` rỗng — vẫn là kết quả đúng. Nếu thấy `401` thì secret sai;
`500 not_configured` thì thiếu secret ở mục 2; `failed` thì đọc
`reason` và xem log của function (mục 7).

Muốn thử riêng một gia đình thì thêm `"family_id": "<id gia đình>"`
vào phần dữ liệu gửi đi.

## 4. Áp migration 12 (nhật ký gửi + lịch quét)

1. Mở file `backend/supabase/migrations/20261118170000_parent_notifications.sql`.
2. **Thay placeholder** `<DAT_SECRET_CUA_ANH>` (chỉ xuất hiện đúng một
   chỗ, trong câu lệnh tạo lịch cron) bằng đúng chuỗi secret đã đặt ở
   mục 2 — **cùng một chuỗi đã dùng cho lịch báo cáo tuần** ở migration
   11. Kiểm tra trước khi chạy: file phải chứa tên function
   `safepc_claim_notification` và KHÔNG còn chuỗi `<DAT_SECRET_CUA_ANH>`.
3. Copy toàn bộ nội dung, dán vào **SQL Editor** > **New query**, bấm
   **Run**. Kết quả mong đợi: 1 dòng chứa id của job vừa tạo (câu
   cuối của file là `select cron.schedule(...)`).
4. Kiểm chứng bằng các truy vấn ở cuối file migration (chạy riêng
   từng câu): extension đủ 2, bảng + 3 hàm đã tạo, lịch
   `safepc-parent-notifications` đang bật với schedule `*/5 * * * *`
   và command chứa secret thật (không còn placeholder).

Nếu câu `CREATE EXTENSION` lỗi: bật `pg_cron` và `pg_net` trong
**Database** > **Extensions** trước, rồi chạy lại file (file chạy lại
được an toàn).

## 5. Gửi thử thật một email

Cách thử đầu-cuối đơn giản nhất: nhờ con gửi một yêu cầu xin thêm giờ
từ màn hình khóa hoặc Tray trên máy con, rồi chờ tối đa 5 phút cho lần
quét tiếp theo. Email phải tới hộp thư của phụ huynh (kiểm tra cả mục
Spam). Mở email và kiểm tra: tên con, tên máy, số phút xin, lý do và
giờ gửi đều đúng, link dẫn tới trang Yêu cầu trên Dashboard.

Sự kiện can thiệp và offline không có cách thử giả an toàn nên không
thử ép — hai loại đó sẽ được kiểm chứng khi xảy ra thật; nhật ký gửi ở
mục 7 cho thấy function có quét đều hay không.

Muốn gửi lại một email thông báo đã gửi rồi (vd gửi thử lần hai) thì
xóa hàng tương ứng trong bảng `notification_sends` trước, rồi chờ lần
quét sau hoặc gọi tay như mục 3 nhưng bỏ `"dry_run"`. Chỉ làm khi cần
thử nghiệm — xóa hàng sẽ làm lần quét sau gửi lại email đó.

## 6. Sau này: dùng domain riêng

Khi domain đã xác minh xong trong Resend (xem docs/06 mục 6): đặt
secret `RESEND_FROM` thành địa chỉ gửi trên domain đó, rồi deploy lại
function. Không sửa code, không sửa migration. Chưa có domain thì cứ
để trống như mục 2.

## 7. Theo dõi và xử lý sự cố

- **Log của function:** Dashboard > **Edge Functions** >
  `send-parent-notifications` > **Logs**. Mọi lỗi gửi đều ghi rõ sự
  kiện và lý do; địa chỉ email và secret không bao giờ ghi vào log.
- **Lịch có chạy không:** `select jobname, schedule, active from
  cron.job where jobname = 'safepc-parent-notifications';` — phải có 1
  dòng, `active` là true. Kết quả gọi HTTP của lần chạy gần nhất: xem
  bảng `net._http_response` (câu truy vấn ở cuối file migration 12).
  `404` nghĩa là function chưa được deploy; `401` nghĩa là secret
  trong lịch không khớp secret đã đặt.
- **Nhật ký đã gửi:** `select kind, event_key, status, sent_at from
  public.notification_sends order by created_at desc limit 20;`
- **401 từ function:** secret trong header không khớp secret đã đặt —
  kiểm tra lại mục 2 và placeholder ở bước 4 (hai chỗ phải giống hệt
  nhau, và giống secret của lịch báo cáo tuần).
- **Resend 403:** đang gửi từ `onboarding@resend.dev` tới email không
  phải email đăng ký tài khoản Resend — xem mục 6 (cần domain), hoặc
  kiểm tra tài khoản Resend đăng ký bằng đúng email phụ huynh.
- **Email đã gửi nhưng nhật ký vẫn `sending`:** đừng xóa hàng đó
  (xóa sẽ làm lần quét sau gửi trùng). Khôi phục bằng cách đánh dấu
  đã gửi kèm id trong log của function: `update
  public.notification_sends set status = 'sent', sent_at = now(),
  resend_id = '<id trong log của function>' where kind = '<loại sự
  kiện>' and event_key = '<khóa sự kiện>';` (phải đặt cả `sent_at` thì
  hàng khôi phục mới được tính vào chặn spam).
- **Project bị tạm dừng:** gói Free tạm dừng project sau 7 ngày không
  hoạt động, lịch cron dừng theo. Agent trên máy con gửi heartbeat hàng
  ngày nên rủi ro thấp; nếu project bị tạm dừng thì vào Dashboard bấm
  khôi phục, lịch sẽ chạy lại từ lần quét 5 phút tiếp theo.

Muốn giấu secret trong Vault thay vì để trong định nghĩa job cron thì
làm theo mục nâng cao trong docs/06 (cùng một cách, áp cho cả hai lịch).

## 8. Quy tắc gửi thông báo (để tham khảo)

| Sự kiện | Khi nào gửi | Chống trùng / chống spam |
|---|---|---|
| Con xin thêm giờ / xin mở ứng dụng / xin mở trang web | Có yêu cầu mới còn chờ duyệt | Mỗi yêu cầu tối đa 1 email. Mỗi con tối đa 1 email yêu cầu mỗi giờ (yêu cầu thêm trong giờ đó vẫn hiện trên Dashboard). Yêu cầu đã duyệt/từ chối trước lúc quét thì không gửi. Chỉ xét yêu cầu tạo trong 24 giờ gần nhất. Email cho yêu cầu xin mở trang web ghi tên miền con xin (cột `domain`, migration 18); khi migration 18 chưa áp thì email dùng câu chung "mở trang web bị chặn". |
| Phát hiện can thiệp (đổi giờ, Agent khởi động lại, mất extension, Service dừng) | Có sự kiện can thiệp mới | Mỗi sự kiện tối đa 1 email. Cùng một máy + cùng một loại thì tối đa 1 email mỗi 6 giờ (các sự kiện sau trong cửa sổ đó bị bỏ qua). Chỉ xét sự kiện trong 24 giờ gần nhất. |
| Máy offline bất thường | Máy quá 48 giờ không gửi tín hiệu | Mỗi đợt offline tối đa 1 email. Máy quay lại rồi lại offline quá 48 giờ thì báo tiếp. Máy chưa từng kết nối thì không báo. |

Một email cho một sự kiện (không gộp nhiều sự kiện vào một email) để
mỗi email nêu rõ một việc cần làm. Mỗi lần quét gửi tối đa 25 email
cho một gia đình (chốt chặn cuối trước giới hạn 100 email/ngày của gói
Resend miễn phí); sự kiện vượt trần không mất đi, lần quét sau xét
lại. Nhờ các chốt chặn trên, gia đình bình thường chỉ vài email mỗi
ngày. Rủi ro còn lại: việc tạo yêu cầu trên máy con chưa bị giới hạn
tốc độ — con bấm "xin thêm giờ" liên tục vẫn tạo nhiều yêu cầu trên
Dashboard (chỉ email bị chặn), cần cứng hóa thêm ở phía Agent/Tray nếu
bị lạm dụng.
