# Gửi email báo cáo tuần — các bước anh Tiến làm tay

Edge Function `send-weekly-report` gửi email báo cáo tuần cho phụ huynh
của mỗi gia đình, mỗi thứ Hai 07:00 giờ Việt Nam, đủ 7 mục như trang Báo
cáo trên Dashboard. Code đã viết sẵn trong repo
(`backend/supabase/functions/send-weekly-report/index.ts`); lịch gửi nằm
trong migration 11. Anh chỉ cần làm 5 bước dưới đây, theo đúng thứ tự.

## 0. Trước khi bắt đầu

- Đã có tài khoản Resend (miễn phí) và một API key loại **send-only**.
  Key này anh tự dán vào mục Secrets ở bước 2 — không gửi key trong chat,
  không ghi key vào file nào trong repo.
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
2. Tên function phải đúng: `send-weekly-report` (lịch cron gọi đúng tên
   này — sai tên thì lịch gọi hụt).
3. Mở file `backend/supabase/functions/send-weekly-report/index.ts`
   trong repo, copy toàn bộ nội dung, dán vào khung code, bấm **Deploy**.
4. **Bắt buộc: tắt JWT verification cho function này.** Function xác
   thực bằng header secret chung (`x-safepc-report-secret`) thay vì
   JWT — nếu để JWT verification bật thì lịch cron (không gửi JWT) sẽ
   bị chặn 401 trước khi tới code. Trong Dashboard: mở function >
   **Settings** > tắt **Verify JWT** (hoặc deploy bằng CLI với cờ
   `--no-verify-jwt`). Chỉ tắt cho function này, không tắt cho function
   khác.

## 2. Đặt Secrets cho Edge Function

Vào **Edge Functions** > **Secrets** (hoặc **Manage secrets**), thêm:

| Tên secret | Giá trị |
|---|---|
| `RESEND_API_KEY` | Khóa API send-only của tài khoản Resend (bắt đầu bằng `re_`). Anh tự dán, không nhờ ai khác dán hộ. |
| `WEEKLY_REPORT_SECRET` | Chuỗi bí mật do anh tự nghĩ (khuyến nghị: chuỗi ngẫu nhiên dài, vd 32 ký tự chữ+số). Chuỗi này dùng chung cho bước 4 — ghi nhớ để dán vào SQL. |
| `RESEND_FROM` | **Để trống lúc này.** Khi nào domain xác minh xong mới đặt (xem mục 6). Để trống thì function gửi từ `SafePC <onboarding@resend.dev>`. |

Đổi secret xong phải **deploy lại function** thì secret mới có hiệu lực
(Deploy lại cùng code, không cần sửa gì).

## 3. Gửi thử khô (không gửi email thật)

Bước này kiểm tra function đọc đúng dữ liệu mà không tốn lượt gửi và
không cần migration 11. Chạy trong PowerShell/Terminal (thay
`<SECRET>` bằng chuỗi ở bước 2):

```bash
curl -X POST "https://fzknvolkxnwfxdcfmops.supabase.co/functions/v1/send-weekly-report" \
  -H "Content-Type: application/json" \
  -H "x-safepc-report-secret: <SECRET>" \
  -d '{"dry_run": true, "week_offset": 1}'
```

Kỳ vọng: HTTP 200, JSON trả về có `"dry_run": true` và một mục
`results` với `status: "dry_run"` cho gia đình của anh. Nếu thấy
`401` thì secret sai; `500 not_configured` thì thiếu secret ở bước 2;
`failed` thì đọc `reason` và xem log của function (mục 5).

`week_offset: 1` nghĩa là tuần trước (tuần vừa kết thúc). Muốn thử tuần
này (dữ liệu một phần) thì đổi thành `0`.

## 4. Áp migration 11 (lịch gửi + chống gửi trùng)

1. Mở file `backend/supabase/migrations/20261118160000_weekly_report_sends.sql`.
2. **Thay placeholder** `<DAT_SECRET_CUA_ANH>` (chỉ xuất hiện đúng một
   chỗ, trong câu lệnh tạo lịch cron) bằng đúng chuỗi secret đã đặt ở
   bước 2. Kiểm tra trước khi chạy: file phải chứa tên function
   `safepc_claim_weekly_report` và KHÔNG còn chuỗi `<DAT_SECRET_CUA_ANH>`.
3. Copy toàn bộ nội dung, dán vào **SQL Editor** > **New query**, bấm
   **Run**. Kết quả mong đợi: 1 dòng chứa id của job vừa tạo (câu
   cuối của file là `select cron.schedule(...)`).
4. Kiểm chứng bằng các truy vấn ở cuối file migration (chạy riêng
   từng câu): extension đủ 2, bảng + 2 hàm đã tạo, lịch
   `safepc-weekly-report` đang bật với schedule `0 0 * * 1` và command
   chứa secret thật (không còn placeholder), múi giờ database là UTC.

Nếu câu `CREATE EXTENSION` lỗi: bật `pg_cron` và `pg_net` trong
**Database** > **Extensions** trước, rồi chạy lại file (file chạy lại
được an toàn).

## 5. Gửi thử thật một email

Chạy lệnh như bước 3 nhưng không có `dry_run`:

```bash
curl -X POST "https://fzknvolkxnwfxdcfmops.supabase.co/functions/v1/send-weekly-report" \
  -H "Content-Type: application/json" \
  -H "x-safepc-report-secret: <SECRET>" \
  -d '{"week_offset": 1}'
```

Kỳ vọng: `status: "sent"` và email tới hộp thư trong vài phút (kiểm tra
cả mục Spam — email từ `onboarding@resend.dev` dễ vào spam). Muốn gửi
lại cùng tuần để thử tiếp thì xóa hàng chống trùng rồi gọi lại:

```sql
delete from public.weekly_report_sends where week_start = '2026-11-09';
```

(thay ngày thứ Hai của tuần muốn gửi lại; lấy đúng ngày từ kết quả
`week_start` mà function trả về).

Từ đây trở đi không cần làm gì thêm: lịch cron tự gửi mỗi thứ Hai 07:00
giờ Việt Nam cho tuần vừa kết thúc. Email đầu tiên tự động sẽ tới vào
thứ Hai sau khi setup xong.

## 6. Khi mua domain (ndtcoder.io.vn) — làm sau

1. Trong Resend: **Domains** > **Add Domain**, nhập domain, làm theo
   hướng dẫn: thêm các bản ghi DNS mà Resend cấp (SPF + DKIM, nên thêm
   cả DMARC) tại nhà đăng ký tên miền (tino.vn). Đợi Resend báo domain
   đã xác minh (thường trong vài phút tới vài giờ sau khi DNS lan).
2. Đặt secret `RESEND_FROM` thành địa chỉ thuộc domain đã xác minh, vd:
   `SafePC <bao-cao@ndtcoder.io.vn>` (phần trước `@` do anh chọn).
3. Deploy lại function (xem bước 2). Từ lần gửi sau, email sẽ gửi từ
   địa chỉ đẹp này tới **mọi** phụ huynh trong gia đình, không còn giới
   hạn chỉ gửi tới email đăng ký Resend nữa.

## 7. Theo dõi và xử lý sự cố

- **Log của function:** Dashboard > **Edge Functions** >
  `send-weekly-report` > **Logs**. Mọi lỗi gửi đều ghi rõ family và lý
  do; địa chỉ email và secret không bao giờ ghi vào log.
- **Lịch có chạy không:** `select jobname, schedule, active from
  cron.job where jobname = 'safepc-weekly-report';` — phải có 1 dòng,
  `active` là true. Kết quả gọi HTTP của lần chạy gần nhất: xem bảng
  `net._http_response` (câu truy vấn ở cuối file migration 11).
- **Nhật ký đã gửi:** `select family_id, week_start, status, sent_at
  from public.weekly_report_sends order by created_at desc limit 10;`
- **Email đã gửi nhưng nhật ký vẫn `sending`:** đừng xóa hàng đó
  (xóa sẽ làm lần gọi sau gửi trùng). Khôi phục bằng cách đánh dấu
  đã gửi kèm id trong log của function: `update
  public.weekly_report_sends set status = 'sent', resend_id =
  '<id trong log của function>' where family_id = '<id family>' and
  week_start = '<ngày đầu tuần>';`
- **401 từ function:** secret trong header không khớp secret đã đặt —
  kiểm tra lại bước 2 và placeholder ở bước 4 (hai chỗ phải giống hệt
  nhau).
- **Resend 403:** đang gửi từ `onboarding@resend.dev` tới email không
  phải email đăng ký tài khoản Resend — xem mục 6 (cần domain), hoặc
  kiểm tra tài khoản Resend đăng ký bằng đúng email phụ huynh.
- **Project bị tạm dừng:** gói Free tạm dừng project sau 7 ngày không
  hoạt động, lịch cron dừng theo. Agent trên máy con gửi heartbeat hàng
  ngày nên rủi ro thấp; nếu project bị tạm dừng thì vào Dashboard bấm
  khôi phục, lịch sẽ chạy lại từ thứ Hai sau đó.

## 8. Nâng cao (tùy chọn): giấu secret trong Vault

Mặc định, secret nằm trong định nghĩa job cron (người đọc được database
sẽ thấy). Muốn giấu kỹ hơn: bật extension `Vault` trong **Database** >
**Extensions** trước (mặc định chưa bật), tạo secret trong **Vault**
tên `weekly_report_secret`, rồi sửa job cron để đọc secret từ Vault
thay vì ghi trực tiếp:

```sql
select cron.unschedule(jobid) from cron.job where jobname = 'safepc-weekly-report';
select cron.schedule(
  'safepc-weekly-report',
  '0 0 * * 1',
  $$
  select net.http_post(
    url := 'https://fzknvolkxnwfxdcfmops.supabase.co/functions/v1/send-weekly-report',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-safepc-report-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'weekly_report_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
```

Không bắt buộc — bản mặc định đã đủ cho một gia đình.
