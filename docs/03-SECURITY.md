# Bảo mật — SafePC

Dữ liệu này là dữ liệu nhạy cảm về trẻ em. Mặc định phải ở chế độ an toàn nhất, thu thập ít nhất có thể.

## 1. Nguyên tắc

1. **Thu thập tối thiểu:** Chỉ metadata cần cho quy tắc (tên app, thời lượng, domain). Không keylogger, không nội dung, không mic/camera.
2. **Minh bạch với con:** Con luôn thấy Agent đang chạy, thấy quy tắc của mình, thấy lý do bị chặn. Không chạy ẩn hoàn toàn.
3. **Phân tách quyền:** Mật khẩu phụ huynh != mã PIN gỡ Agent != device token. Lộ 1 cái không lộ tất cả.
4. **Mặc định từ chối:** API/DB từ chối nếu không có quyền. Không tin tưởng client (Agent/Dashboard) — mọi kiểm tra quyền làm ở server + RLS.
5. **Mã hóa:** TLS mọi nơi, mã hóa dữ liệu nhạy cảm khi lưu, hash mọi token/mã.

## 2. Xác thực & phân quyền

- [ ] Supabase Auth: email + mật khẩu mạnh (tối thiểu 10 ký tự, kiểm tra HaveIBeenPwned qua Supabase), khóa tài khoản sau 5 lần sai trong 15 phút.
- [ ] MFA TOTP cho phụ huynh (giai đoạn 1.5, khuyến nghị bật).
- [ ] Session: JWT ngắn hạn, refresh token rotation, đăng xuất mọi thiết bị khi đổi mật khẩu.
- [ ] RLS trên mọi bảng: `family_id` là ranh giới. Kiểm thử RLS bằng test: user gia đình A không đọc được dữ liệu gia đình B.
- [ ] Device token: chuỗi ngẫu nhiên 256-bit, chỉ gửi 1 lần lúc pairing, lưu hash (SHA-256) ở DB, lưu bản gốc bằng DPAPI trên máy con. Thu hồi được từ Dashboard ("Xóa máy").
- [ ] Pairing code: 6 số, hết hạn 10 phút, tối đa 5 lần thử, dùng 1 lần.
- [ ] Mã PIN gỡ Agent: 6 số, do phụ huynh đặt riêng, lưu hash bcrypt/argon2, nhập sai 5 lần khóa 30 phút.
- [ ] Mọi hành động quan trọng ghi audit log: đổi quy tắc, khóa/mở, duyệt yêu cầu, thêm/xóa máy, đăng nhập lạ.

## 3. Dữ liệu nhạy cảm — xử lý cụ thể

| Dữ liệu | Cách xử lý |
|---|---|
| Mật khẩu | Không tự lưu. Dùng Supabase Auth (bcrypt). Không log. |
| Device token, pairing code, PIN | Chỉ lưu hash. Không log giá trị thô. |
| Tên app / đường dẫn exe | Hash đường dẫn, chỉ lưu tên hiển thị + hash. Tránh lộ username Windows. |
| Domain web | Chỉ lưu domain (vd: youtube.com), cắt bỏ path/query để tránh lộ nội dung tìm kiếm. |
| Tiêu đề cửa sổ | MVP: KHÔNG thu thập. Chỉ lấy tên process. Nếu giai đoạn 3 cần, phải có opt-in + lọc từ khóa tại chỗ, không gửi nguyên văn lên server. |
| Ảnh chụp màn hình | Mặc định TẮT. Nếu bật: mã hóa, tự xóa sau 7 ngày, con thấy rõ khi nào bị chụp. |
| IP | Chỉ lưu hash IP cho audit, không lưu IP thô quá 30 ngày. |
| Sao lưu | Backup DB mã hóa, kiểm tra khôi phục 1 lần/tháng. |

## 4. Checklist OWASP (chạy trước mỗi release)

**Web / API (OWASP Top 10):**
- [ ] Không SQL injection (dùng prepared statement / Supabase client, không nối chuỗi SQL).
- [ ] Không XSS (React escape mặc định, không dùng dangerouslySetInnerHTML với dữ liệu user).
- [ ] CSRF: Supabase dùng Bearer token, không dùng cookie auth cho API cross-site nếu không có SameSite + CSRF token.
- [ ] IDOR: Mọi API kiểm tra family_id + RLS, test truy cập chéo gia đình.
- [ ] Không lộ secret trong code/client: dùng biến môi trường, quét secret bằng Gitleaks trong CI.
- [ ] Rate limiting cho login/pairing/API nhạy cảm (Supabase + Edge Function).
- [ ] Headers bảo mật: CSP, HSTS, X-Content-Type-Options, Referrer-Policy (cấu hình trên Vercel).
- [ ] Dependency scan: Dependabot + `npm audit` / `dotnet list package --vulnerable` trong CI, không release khi có Critical chưa vá.

**PC Agent (OWASP Mobile/Desktop tương đương):**
- [ ] Không lưu secret dạng plaintext trong file/registry. Dùng DPAPI + Credential Manager.
- [ ] Cập nhật Agent có chữ ký số + kiểm tra hash trước khi cài. MVP: kiểm tra hash + HTTPS; ký số EV/Code Signing mua sau khi có pháp nhân/budget (ghi rõ trong roadmap).
- [ ] IPC giữa Service và Tray App: Named Pipe có ACL, chỉ session của con + SYSTEM được kết nối, xác thực message.
- [ ] Không chạy lệnh từ server mà không xác thực chữ ký/nguồn. Commands chỉ nhận từ Supabase qua TLS + device token.
- [ ] Log local không chứa token/mật khẩu. Log tự xoay vòng, tối đa 10MB.

**Extension:**
- [ ] Quyền tối thiểu: chỉ `declarativeNetRequest` + `storage`, không `tabs` đọc URL đầy đủ nếu không cần. Không gửi full URL lên server.

## 5. Quyền riêng tư & tuân thủ

- Viết Privacy Policy + Terms ngắn gọn, tiếng Việt, trước khi mời user ngoài gia đình dùng thử: thu thập gì, giữ bao lâu, xóa thế nào, liên hệ ai.
- Tính năng "Xóa toàn bộ dữ liệu của con" + "Xuất dữ liệu" (GDPR-style) — làm ở giai đoạn 1.5.
- Dữ liệu trẻ em: không bán, không chia sẻ cho bên thứ ba quảng cáo, không dùng để train AI. Supabase/Vercel chỉ là hạ tầng lưu trữ/xử lý theo hợp đồng của họ.
- Lưu ý pháp lý Việt Nam: Luật Bảo vệ dữ liệu cá nhân 2023 + Luật Trẻ em — phụ huynh là người giám hộ, nhưng vẫn cần minh bạch và chỉ dùng trong phạm vi gia đình. Khi mở rộng trên 100 user / thương mại hóa, cần tư vấn pháp lý riêng.

## 6. Ứng phó sự cố (Incident Response — bản rút gọn)

1. Phát hiện lộ token/DB: thu hồi ngay token bị ảnh hưởng, ép đăng nhập lại, xoay khóa API.
2. Thông báo cho gia đình bị ảnh hưởng trong 72h, ghi rõ dữ liệu nào bị ảnh hưởng.
3. Ghi postmortem: nguyên nhân, khắc phục, phòng ngừa. Không xóa log.
4. Danh sách liên hệ + quy trình khôi phục backup được lưu trong repo private, không public.
