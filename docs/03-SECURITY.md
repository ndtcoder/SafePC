# Bảo mật — SafePC

Dữ liệu này là dữ liệu nhạy cảm về trẻ em. Mặc định phải ở chế độ an toàn nhất, thu thập ít nhất có thể.

## 1. Nguyên tắc

1. **Thu thập tối thiểu:** Chỉ metadata cần cho quy tắc (tên app, thời lượng, domain + đường dẫn web đã bỏ query/fragment, giữ 90 ngày). Không keylogger, không nội dung, không mic/camera.
2. **Minh bạch với con:** Con luôn thấy Agent đang chạy, thấy quy tắc của mình, thấy lý do bị chặn. Không chạy ẩn hoàn toàn.
3. **Phân tách quyền:** Mật khẩu phụ huynh != mã PIN gỡ Agent != device token. Lộ 1 cái không lộ tất cả.
4. **Mặc định từ chối:** API/DB từ chối nếu không có quyền. Không tin tưởng client (Agent/Dashboard) — mọi kiểm tra quyền làm ở server + RLS.
5. **Mã hóa:** TLS mọi nơi, mã hóa dữ liệu nhạy cảm khi lưu, hash mọi token/mã.

## 2. Xác thực & phân quyền

- [x] Supabase Auth: email + mật khẩu (Supabase quản lý hash, xác minh email qua link). — Đã triển khai. Khóa tài khoản sau 5 lần sai / kiểm tra HaveIBeenPwned là cấu hình Supabase, chưa rà soát.
- [x] MFA TOTP cho phụ huynh (giai đoạn 1.5, khuyến nghị bật). — Đã triển khai 18/11/2026: tự nguyện (opt-in), bật/tắt ở mục Bảo mật tài khoản trên trang Hồ sơ; factor TOTP nằm trong schema auth của Supabase, Dashboard không lưu secret hay mã khôi phục; mã QR do Supabase Auth sinh, không thêm thư viện. Gỡ factor đã xác minh đòi phiên aal2 nên luồng tắt yêu cầu nhập mã hiện tại trước. Khôi phục khi mất thiết bị xác thực: KHÔNG có mã khôi phục tự phục vụ (recovery codes của Supabase là tính năng thử nghiệm, cần bật cờ trên server, chưa dùng); đặt lại mật khẩu qua email không bỏ qua bước MFA; người giữ quyền quản trị dự án Supabase gỡ factor trong Supabase Dashboard (Authentication → Users → chọn tài khoản → gỡ factor ở mục MFA) hoặc qua Auth Admin API; phụ huynh còn lại không gỡ được từ Dashboard SafePC. Chưa kiểm chứng đầu-cuối trên tài khoản thật.
- [x] Session: JWT ngắn hạn, refresh token rotation (Supabase Auth mặc định). — Đã triển khai theo mặc định Supabase.
- [x] RLS trên mọi bảng: `family_id` là ranh giới. — Đã bật trên 12 bảng (migration 1). Kiểm thử truy cập chéo gia đình (2 tài khoản) chưa chạy — xem `RLS_TESTING.md`.
- [x] Device token: chuỗi ngẫu nhiên 256-bit, chỉ gửi 1 lần lúc pairing, lưu hash (SHA-256) ở DB, lưu bản gốc bằng DPAPI trên máy con. Thu hồi được từ Dashboard ("Xóa máy"). — Đã triển khai và kiểm chứng.
- [x] Pairing code: 6 số, hết hạn 10 phút, dùng 1 lần. — Đã triển khai. Giới hạn 5 lần thử chưa triển khai (RPC đổi mã chưa đếm số lần thử sai).
- Agent gọi server qua RPC SECURITY DEFINER (`safepc_*`, migration 3), xác thực bằng cặp (device_id, SHA-256 của device token); PostgREST xác thực bằng khóa publishable (AnonKey) trong `appsettings.json` của Service — khóa này được thiết kế để lộ ra phía client. Khóa quản trị (bypass RLS) không bao giờ vào Agent, Dashboard hay repo.
- [ ] Mã PIN gỡ Agent: 6 số, do phụ huynh đặt riêng, lưu hash bcrypt/argon2, nhập sai 5 lần khóa 30 phút. — Chưa triển khai (Sprint 4). Mã PIN thoát Tray đang làm (đợt tiếp theo, hash PBKDF2 + giới hạn số lần thử tại chỗ).
- [ ] Mọi hành động quan trọng ghi audit log: đổi quy tắc, khóa/mở, duyệt yêu cầu, thêm/xóa máy, đăng nhập lạ. — Mới có audit cho sự kiện can thiệp + heartbeat extension; lệnh từ xa chưa ghi audit (TODO).

## 3. Dữ liệu nhạy cảm — xử lý cụ thể

| Dữ liệu | Cách xử lý |
|---|---|
| Mật khẩu | Không tự lưu. Dùng Supabase Auth (bcrypt). Không log. |
| Device token, pairing code, PIN | Chỉ lưu hash. Không log giá trị thô. |
| Tên app / đường dẫn exe | Hash đường dẫn, chỉ lưu tên hiển thị + hash. Tránh lộ username Windows. |
| Domain web | Lưu domain (vd: youtube.com) + đường dẫn (vd: /watch, đã cắt bỏ query/fragment, trần 500 ký tự) + thời lượng xem (giây), tự xóa sau 90 ngày (migration 19). Extension chỉ gửi domain + đường dẫn + thời lượng qua NativeHost; không gửi URL đầy đủ, không đọc nội dung trang. Lượt web bị chặn chỉ lưu domain, không có đường dẫn. |
| Tiêu đề cửa sổ | MVP: KHÔNG thu thập. Chỉ lấy tên process. Nếu giai đoạn 3 cần, phải có opt-in + lọc từ khóa tại chỗ, không gửi nguyên văn lên server. |
| Ảnh chụp màn hình | Mặc định TẮT. Nếu bật: mã hóa, tự xóa sau 7 ngày, con thấy rõ khi nào bị chụp. |
| IP | Chỉ lưu hash IP cho audit, không lưu IP thô quá 30 ngày. |
| Heartbeat extension | File `extension_heartbeat.txt` chỉ chứa timestamp UTC lúc extension liên hệ gần nhất — không domain, không URL, không secret. |
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

**Extension (Sprint 2 đợt 2, đã triển khai):**
- Quyền tối thiểu: chỉ `declarativeNetRequest`, `tabs` (lấy hostname + đường dẫn của tab đang hiển thị để đếm giờ và ghi lịch sử web, bỏ query/fragment và URL ngay), `alarms`, `storage`, `nativeMessaging`. Không `host_permissions` (DNR không cần), không `declarativeNetRequestFeedback`, không `webRequest`, không `cookies`. Không gửi full URL lên server.
- Ranh giới NativeHost: host stdio (`com.safepc.agent`) chỉ đọc/ghi trong `%ProgramData%\SafePC\shared\`, không bao giờ chạm tới file token hay database của Service, không gọi mạng, không chạy lệnh. Input xấu không làm crash host (log stderr, trả ack false). Manifest `allowed_origins` hiện là ID extension placeholder — ID thật lấy từ store publishing (xem `apps/browser-extension/README.md`).
- ACL file chia sẻ: thư mục `shared/` có SYSTEM toàn quyền + Users chỉ đọc (kế thừa), cộng quyền tạo file chỉ ở mức thư mục để NativeHost ghi `web_usage.jsonl`; bản thân `domain_rules.json` có ACL riêng ở cấp file (SYSTEM + Administrators toàn quyền, Users chỉ đọc, không kế thừa) nên tài khoản Standard không sửa/xóa được quy tắc. Đặt ACL là best-effort, thất bại thì log cảnh báo.
- Thu thập tối thiểu: extension chỉ thu thập domain + đường dẫn (đã bỏ query/fragment) + thời lượng xem, tự xóa sau 90 ngày; không tiêu đề trang, không nội dung, không phím gõ, không mic/camera. Khi chưa nối được NativeHost thì fail-open và báo rõ trạng thái chưa kết nối.
- [ ] Cứng hóa sau: đăng extension lên store + ép cài bằng chính sách `ExtensionInstallForcelist` (bản unpacked hiện có thể bị Standard User tắt — giới hạn đã ghi rõ trong README của extension).

**Thi hành theo app / nghỉ bắt buộc / cảnh báo can thiệp (Sprint 2 đợt 3, đã triển khai):**
- An toàn khi đóng app: chỉ đóng tiến trình cùng tên exe (chuẩn hóa chung, bỏ `.exe`, không phân biệt hoa thường) trong đúng session đã báo cáo foreground; không bao giờ chạm session 0; denylist chặn tiến trình hệ thống (`explorer`, `taskmgr`, `dwm`, `csrss`, `winlogon`, `services`, `lsass`, ...) và chính exe của SafePC (tự bảo vệ); mỗi tiến trình bắt lỗi riêng (best-effort), chỉ đóng đúng tiến trình đó, không đóng cây tiến trình con. Không có báo cáo foreground tươi (≤ 90s) thì không đóng gì (fail-open). Log chỉ ghi tên exe + lý do, không tiêu đề cửa sổ, không đường dẫn.
- Nghỉ bắt buộc là khóa phiên, nói thành thật: Service khóa phiên làm việc của con trong thời gian nghỉ (`LockWorkStation` sau đếm ngược 60s, nhắc lại mỗi 15s); biện pháp này chỉ ngăn dùng máy này, không thể ép con nghỉ ngơi và không khóa được máy khác.
- RPC cảnh báo can thiệp (migration 5): `safepc_push_tamper_event` xác thực bằng `safepc_auth_device` (cặp device_id + hash token), chỉ nhận 4 loại sự kiện, `family_id`/`child_id`/`device_id` suy ra từ device đã xác thực (không tin client), `details` cắt tối đa 2KB và fallback `{}` khi JSON hỏng; `safepc_report_extension_heartbeat` chỉ cập nhật đúng cột `last_extension_seen_at`, kẹp giờ tương lai về giờ server. Cả hai đều `SECURITY DEFINER` với `search_path` cố định, GRANT cho `anon`/`authenticated`/`service_role` như các RPC khác. Agent chỉ tự đẩy `clock_drift` và `agent_restart` (tối đa 1 lần/giờ mỗi loại); `service_stopped` và `extension_missing` không do Agent đẩy.
- File heartbeat extension: NativeHost ghi đè timestamp UTC vào `shared\extension_heartbeat.txt` mỗi lần extension liên hệ; file chỉ chứa timestamp, không secret, Service đọc với `FileShare.ReadWrite` và không bao giờ tin timestamp tương lai (RPC kẹp về giờ server). Ghi heartbeat lỗi không làm lỗi message của extension.

**Giao lệnh theo phiên (đợt 17/11/2026, đã triển khai):**
- Miễn trừ khóa theo tài khoản admin: Tray báo quyền admin qua `TokenElevationType` (Full/Limited = admin); Service chỉ giao lệnh khóa/cảnh báo tới phiên không phải admin. Điều này ĐÚNG chỉ khi con dùng tài khoản Standard User — nếu con có quyền Admin, phiên của con cũng được miễn. Tài liệu cài đặt phải nhấn mạnh: con luôn dùng Standard User, phụ huynh giữ tài khoản Admin duy nhất.
- Thông tin hello (phiên, tên tài khoản, quyền admin) chỉ dùng để định tuyến lệnh khóa trong bộ nhớ của Service, không lưu DB, không gửi lên server. Phiên chưa giới thiệu vẫn nhận lệnh (fail-closed).
- Không đổi ranh giới tin cậy khác: ACL pipe, giới hạn 8 instance, DPAPI token, RPC xác thực device đều không đổi.

**Mode app mới / ghi đè app / báo cáo thi hành / cứng hóa Tray + IPC (bản sửa lỗi sau Sprint 2 đợt 3, đã triển khai):**
- Mode app mới (`app_block`, `app_allowlist`, `app_allowlist_by_time`) và ghi đè app (`block_app`/`allow_app`) không nới lỏng an toàn đóng app: mọi đường đóng vẫn qua đúng một hàm `KillAppAsync` (một điểm gọi `Process.Kill` duy nhất), denylist hệ thống + exe SafePC không đổi và được kiểm tra ở đầu hàm lẫn từng process; chỉ đóng đúng session đã báo cáo, không chạm session 0; so khớp exe vẫn qua helper `ExeNames` duy nhất. Ghi đè app được `RuleEngine` bỏ qua hoàn toàn (cùng chốt chặn với ghi đè domain) nên không bao giờ biến thành mở/khóa máy.
- Snapshot thi hành (migration 6) thu thập tối thiểu: chỉ quyết định, id rule, tên exe đang bị chặn và cờ focus/domain — không tiêu đề cửa sổ, không URL/path/query, không nội dung, không tên con. RPC `safepc_report_enforcement` xác thực bằng `safepc_auth_device`, chỉ cập nhật đúng 2 cột của đúng device đã xác thực, từ chối payload null/quá 4KB, `SECURITY DEFINER` với `search_path` cố định, GRANT như các RPC khác. Log chẩn đoán quyết định không ghi token/hash.
- Cứng hóa Tray không thêm bề mặt tấn công: global handler chỉ ghi log (stack của exception, không secret), khóa dự phòng gọi `LockWorkStation` của chính phiên, menu vẫn là cửa sổ WPF thật (không ContextMenu, không vòng lặp WinForms mới), mutex single-instance và cửa sổ neo không đổi.
- Chống kẹt IPC không đổi ranh giới tin cậy: idle timeout 120s hai bên chỉ đóng kết nối chết và giải phóng pipe instance; watchdog chỉ ghi log, không dispose hay tạo lại listener; ACL pipe và giới hạn 8 instance không đổi; không quyết định nối/rớt bằng cờ `IsConnected`.

## 5. Quyền riêng tư & tuân thủ

- Viết Privacy Policy + Terms ngắn gọn, tiếng Việt, trước khi mời user ngoài gia đình dùng thử: thu thập gì, giữ bao lâu, xóa thế nào, liên hệ ai.
- Tính năng "Xóa toàn bộ dữ liệu của con" + "Xuất dữ liệu" (GDPR-style) — đã phê duyệt 17/11/2026, thực hiện dần (xem PRD §2.8).
- MFA cho tài khoản phụ huynh — đã phê duyệt 17/11/2026 (Supabase đã hỗ trợ sẵn).
- Chụp màn hình đã LOẠI KHỎI KẾ HOẠCH ngày 17/11/2026: không chụp màn hình, không ghi phím, không đọc nội dung chat/file của con (xem PRD §4–§5).
- Dữ liệu trẻ em: không bán, không chia sẻ cho bên thứ ba quảng cáo, không dùng để train AI. Supabase/Vercel chỉ là hạ tầng lưu trữ/xử lý theo hợp đồng của họ.
- Lưu ý pháp lý Việt Nam: Luật Bảo vệ dữ liệu cá nhân 2023 + Luật Trẻ em — phụ huynh là người giám hộ, nhưng vẫn cần minh bạch và chỉ dùng trong phạm vi gia đình. Khi mở rộng trên 100 user / thương mại hóa, cần tư vấn pháp lý riêng.

## 6. Ứng phó sự cố (Incident Response — bản rút gọn)

1. Phát hiện lộ token/DB: thu hồi ngay token bị ảnh hưởng, ép đăng nhập lại, xoay khóa API.
2. Thông báo cho gia đình bị ảnh hưởng trong 72h, ghi rõ dữ liệu nào bị ảnh hưởng.
3. Ghi postmortem: nguyên nhân, khắc phục, phòng ngừa. Không xóa log.
4. Danh sách liên hệ + quy trình khôi phục backup được lưu trong repo private, không public.
