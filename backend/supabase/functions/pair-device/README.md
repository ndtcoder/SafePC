# Edge Function `pair-device` (stub Sprint 1)

> **ĐÃ THAY THẾ (16/11/2026):** luồng pairing thật dùng Postgres RPC
> `safepc_redeem_pairing_code` (migration `20261116170000_device_rpc.sql`),
> gọi qua PostgREST từ lệnh CLI `SafePC.Agent.Service.exe pair <mã>`.
> Function này KHÔNG deploy. Giữ lại làm tài liệu tham khảo cho hợp đồng hash.

Đổi pairing code 6 số thành device token cho PC Agent, theo luồng pairing ở
`docs/02-ARCHITECTURE.md` mục 4.1 và quy tắc bảo mật ở `docs/03-SECURITY.md`
mục 2 (chỉ lưu hash token/mã, pairing code hết hạn 10 phút, tối đa 5 lần thử,
dùng 1 lần).

**Trạng thái: STUB — chưa deploy, chưa kiểm chứng.** Project Supabase SafePC
đã tạo (16/11/2026) nhưng migration chưa áp dụng và function chưa deploy, nên
code này chưa chạy thử lần nào. Đừng dùng trong môi trường thật cho tới khi
đã deploy và kiểm thử trên project thật.

## Luồng xử lý

1. Agent gửi `POST` với `{ code, hostname, os_version, agent_version }`.
2. Function hash `code` bằng SHA-256, đối chiếu với `pairing_codes.code_hash`.
3. Kiểm tra: chưa hết hạn (`expires_at`), chưa dùng (`used_at` null),
   `attempts < 5`. Mã đã dùng/hết hạn thì tăng `attempts` (tối đa 5, theo
   CHECK constraint trong DB) rồi từ chối; mã đã chạm trần 5 lần thì trả 429.
4. Đánh dấu `used_at` bằng UPDATE có điều kiện (chống 2 request đồng thời đổi
   cùng 1 mã), tạo `devices` + token ngẫu nhiên 256-bit.
5. Chỉ lưu SHA-256 hash của token vào `device_tokens`; trả token thô đúng
   1 lần trong response. Agent phải lưu token bằng DPAPI trên máy con.

Không log code thô, token thô hay request body. Thông báo lỗi cố ý chung chung
(không phân biệt mã sai / mã hết hạn / mã đã dùng).

## Request / Response (ví dụ)

Request:

```json
{
  "code": "123456",
  "hostname": "PC-CUA-CON",
  "os_version": "Windows 11 24H2",
  "agent_version": "0.1.0"
}
```

Response thành công (200) — `token` chỉ xuất hiện đúng 1 lần này:

```json
{
  "device_id": "00000000-0000-0000-0000-000000000000",
  "token": "<64 ký tự hex>"
}
```

Response lỗi: `{ "error": "<thông báo tiếng Việt>" }` với mã 400 (mã không hợp
lệ/hết hạn), 405 (không phải POST), 429 (mã bị khóa do quá 5 lần thử), 500
(lỗi máy chủ, không lộ chi tiết).

## Hợp đồng hash (bắt buộc, Dashboard và Function phải giống nhau)

- `code_hash` = SHA-256 hex **chữ thường** của đúng chuỗi 6 chữ số, không
  khoảng trắng, không salt (schema hiện tại không có cột salt).
- `token_hash` = SHA-256 hex chữ thường của token hex 64 ký tự.
- Dashboard khi tạo pairing code phải hash theo đúng quy ước này rồi mới
  insert vào `pairing_codes` (kèm `expires_at` = thời điểm tạo + 10 phút).

## Biến môi trường

Function đọc từ môi trường do Supabase cấp sẵn khi deploy, không hardcode:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (bypass RLS — pairing chưa có phiên đăng nhập;
  không bao giờ đưa key này vào Dashboard/Agent hay commit vào repo)

## Deploy (chỉ sau khi migration đã áp dụng)

```bash
supabase functions deploy pair-device
```

Kiểm tra bằng `deno check` trước khi deploy (cần cài Deno — môi trường viết
stub này chưa có Deno nên chưa chạy được):

```bash
deno check functions/pair-device/index.ts
```

## Giới hạn đã biết (TODO Sprint 2+)

- Chưa có rate limiting riêng: mã đoán sai không khớp dòng nào nên không tăng
  được `attempts`; chống brute-force cần thêm giới hạn tần suất ở tầng Edge
  Function/Supabase.
- "Đánh dấu used + tạo device + tạo token" chưa nằm trong 1 transaction: nếu
  tạo device/token thất bại sau khi mã đã bị đánh dấu used, phụ huynh phải tạo
  mã mới. Bản production nên gom vào 1 Postgres function/RPC.
- Chưa ghi `audit_logs` cho sự kiện pairing (cần thêm sau khi chốt ai/điều gì
  được ghi log).
