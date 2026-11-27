# PRD — SafePC v0.1

## 0. Trạng thái hiện tại (18/11/2026)

Bản v0.1.136 đã kiểm chứng trên máy thật: ghép nối, đồng bộ quy tắc, khóa/mở máy từ Dashboard đều hoạt động. Các mục dưới đây ghi rõ trạng thái thật: ✅ đã triển khai (ghi rõ đã kiểm chứng trên máy thật hay chưa), 🔨 đang làm, ⏳ chưa làm. Chi tiết lộ trình xem `04-ROADMAP.md`.

| Hạng mục | Trạng thái |
|---|---|
| Tài khoản, ghép nối, đồng bộ quy tắc | ✅ Đã triển khai, đã kiểm chứng trên máy thật |
| Theo dõi thời gian dùng app + web | ✅ Đã triển khai, đã kiểm chứng trên máy thật (app + web đều chảy qua NativeHost hai chiều, bản v0.1.167 ngày 18/11); lượt web bị chặn báo cáo từ extension 0.1.7 (xem §2.10) |
| Quy tắc giờ giấc, theo app, focus, nghỉ bắt buộc | ✅ Đã triển khai; khóa theo quy tắc đã kiểm chứng (giờ ngủ), các mode app chờ kiểm chứng thêm |
| Khóa/mở từ xa, ghi đè tạm thời | ✅ Đã triển khai, đã kiểm chứng trên máy thật |
| Khóa có độ trễ + khóa theo phiên | ✅ Đã triển khai, đã kiểm chứng trên máy thật (tối 17/11: độ trễ + cảnh báo nhỏ đúng, phiên admin miễn khóa qua đường Limited-token; sáng 18/11: đăng nhập lại khi đang khóa thì khóa ngay không đếm ngược); lệnh sau thắng lệnh trước, hết độ trễ khóa ngay không đếm ngược; khóa do phụ huynh bấm (Khóa ngay độ trễ 0 + khóa tạm thời) giờ khóa ngay không đếm ngược (v0.1.183, CI xanh run #183) — chờ kiểm chứng lại |
| PIN thoát, xin thêm giờ đầu-cuối, xem giờ còn lại | ✅ Đã triển khai, CI xanh (run #183, v0.1.183); PIN một lần đã kiểm chứng trên máy thật (lần dùng thứ 2 bị từ chối; migration 8 đã áp sáng 18/11 nên lệnh gỡ PIN chờ từ tối qua đã hoàn tất trên server); duyệt xin giờ = mở khóa đúng N phút, máy mở ngay đã kiểm chứng sáng 18/11 — thẻ thiết bị từng xung đột khóa/mở, đã sửa (ưu tiên trạng thái mở khóa + snapshot đẩy ngay khi đổi từ vòng tick) trong v0.1.183, chờ kiểm chứng lại; migration 8 + 9 đã áp lên Supabase |
| Hồ sơ theo con (Dashboard) | ✅ Đã triển khai, CI xanh (run #159, 17/11): Tổng quan / Hồ sơ / Yêu cầu; mỗi hồ sơ có tab Thiết bị / Quy tắc / Báo cáo riêng; mã ghép nối hết hạn sau 5 phút. Thiết kế lại trang Quy tắc (quy tắc hiện hành lên đầu, form thu gọn, tên rule, mẫu của phụ huynh, mẫu Chỉ cho phép Edge) — CI xanh run #170, migration 9 đã áp sáng 18/11, chờ kiểm chứng trên điện thoại thật |
| Chặn/cho phép domain qua extension | ✅ Chặn domain đã kiểm chứng trên máy thật sáng 18/11 (khớp domain bằng requestDomains; trang chặn SafePC thật đã hiện từ extension 0.1.4 sau khi sửa gốc rễ thiếu host_permissions cho rule redirect — kiểm chứng 13:32). Chặn theo đường dẫn + tab watcher (0.1.5) đã kiểm chứng cả 3 trường hợp chiều 18/11. Extension hiện ở 0.1.10 (0.1.6 tự kiểm tra host permission, 0.1.7 báo cáo lượt bị chặn, 0.1.8 lý do theo danh mục, 0.1.9 nút xin mở domain trên trang chặn, 0.1.10 lưu đường dẫn lịch sử web) — các bản 0.1.6–0.1.10 chưa kiểm chứng trên máy thật. Chặn app / mẫu Chỉ cho phép Edge cũng đã kiểm chứng sáng 18/11 (Chrome cài bằng quyền user của con bị đóng 2 lần + hộp cảnh báo Tray) |
| Tính năng nâng cao + giao diện chuyên nghiệp | ✅ Cả 9 mục đã triển khai xong phần code ngày 18/11/2026 (xem §2.8); kiểm chứng trên máy thật / điện thoại thật / tài khoản thật còn chờ anh Tiến |
| Flow cài đặt cho phụ huynh khác | ⏳ Đã phê duyệt 17/11/2026, thực hiện dần (xem §2.9) |
| Báo cáo tuần | ✅ Trang Báo cáo đã live trên Dashboard; email báo cáo tuần đã giao phần code (Edge Function + migration 11 đã áp) — chưa kiểm chứng đầu-cuối, còn các bước tay (xem §2.10) |
| App Android | ⏳ Chưa làm (tính năng nâng cao đã chốt 17/11 — sẵn sàng thảo luận khi bắt đầu) |

## 1. Người dùng và vai trò

| Vai trò | Mô tả | Quyền |
|---|---|---|
| Phụ huynh (Parent/Admin) | Người tạo gia đình, cài Agent, đặt quy tắc | Toàn quyền: xem báo cáo, đổi quy tắc, khóa/mở máy, phê duyệt xin thêm giờ |
| Con (Child) | Người dùng máy PC | Xem thời gian còn lại, xem quy tắc của mình, gửi yêu cầu xin thêm giờ / mở app bị chặn |
| Hệ thống (Agent) | Chạy trên máy con | Thu thập usage, thi hành quy tắc, gửi heartbeat |

Một gia đình: 1-2 phụ huynh, 1-3 con, 1-3 máy PC (MVP: 1 phụ huynh, 1 con, 1 máy).

## 2. MVP — Giai đoạn 1: PC Agent + Dashboard Web (Ưu tiên cao nhất)

### 2.1. Tài khoản & liên kết thiết bị
- [x] Đăng ký/đăng nhập phụ huynh bằng email + mật khẩu (Supabase Auth), xác minh email. — Đã triển khai; tài khoản phụ huynh đầu tiên đã đăng ký và đăng nhập thành công trên bản live (16/11/2026). Site URL/redirect đã cấu hình đúng (`https://safe-pc.vercel.app`).
- [x] Tạo hồ sơ con (tên, ngày sinh/độ tuổi, avatar). — Đã triển khai (tên + hồ sơ con trên Dashboard; avatar chưa có UI).
- [x] Ghép nối máy con bằng mã pairing 6 số, hết hạn sau 5 phút, dùng 1 lần. — Đã triển khai và kiểm chứng trên máy thật (16–17/11/2026). Hạn rút từ 10 xuống 5 phút theo yêu cầu test 17/11/2026. QR chưa làm; mã nhập ngay trong bộ cài (trang ghép nối sau bước chép file — xem §2.9), lệnh PowerShell vẫn giữ để debug. Máy mới ghép nối nhận trạng thái thi hành của con lúc redeem: khóa cưỡng chế + tối đa 1 ghi đè đang hiệu lực (migration 17 ngân hàng giờ + migration 21; kiểm chứng PGlite 42/42 pass, 34 kịch bản, chưa áp migration 21, chưa kiểm chứng trên máy thật).
- [x] Agent lưu device token an toàn (DPAPI LocalMachine), không lưu mật khẩu phụ huynh trên máy con. — Đã triển khai; token thô không bao giờ rời máy, server chỉ lưu hash SHA-256.

### 2.2. Theo dõi thời gian sử dụng (Usage Tracking)
- [x] Ghi nhận app đang chạy ở foreground (tên process, thời lượng), tổng hợp theo mẫu 15 giây. — Đã triển khai; Service lưu SQLite local, đẩy batch lên server mỗi 5 phút.
- [x] Ghi nhận thời gian online/offline (heartbeat 60s, trạng thái thiết bị trên Dashboard). — Đã triển khai. Thời gian khóa màn hình chưa tách riêng.
- [x] Gửi dữ liệu lên server theo batch, có hàng đợi offline (SQLite local), đồng bộ khi có mạng. — Đã triển khai.
- [x] Dashboard hiển thị: tổng thời gian hôm nay/tuần, top app, biểu đồ theo giờ. — Đã triển khai: trang Hôm nay thành tổng quan thật (thẻ trạng thái máy, giờ còn lại từng con, biểu đồ 24 cột giờ dùng, top app/domain), CI xanh run #215; chưa xem với dữ liệu thật / trên điện thoại thật.

### 2.3. Giới hạn thời gian (Screen Time)
- [x] Giới hạn tổng thời gian/ngày theo thứ trong tuần (VD: T2-T6: 2h, T7-CN: 3h). — Xong Sprint 2 đợt 1 (Dashboard + Agent, xem 2.3.1).
- [x] Lịch giờ ngủ / giờ cấm theo từng thứ (VD: 21:30-07:00 không dùng máy, qua đêm được). — Xong Sprint 2 đợt 1 (xem 2.3.1).
- [x] Khung giờ được dùng máy theo từng thứ (VD: T2-T6 chỉ 07:00-21:00, ngoài khung giờ thì khóa). — Xong Sprint 2 đợt 1 (xem 2.3.1).
- [x] Cảnh báo trước 15/5/1 phút khi sắp hết giờ. — Đã triển khai: Service gửi cảnh báo theo ngưỡng, Tray hiện cửa sổ nhỏ có đếm ngược trực tiếp (đợt khóa có độ trễ, 17/11).
- [x] Khi hết giờ: hiển thị màn hình khóa toàn màn hình, khóa phiên làm việc (LockWorkStation), đếm ngược 60s để con kịp lưu bài. — Đã triển khai và kiểm chứng trên máy thật (v0.1.136). Khóa có độ trễ do phụ huynh chọn (0–5 phút, hết độ trễ khóa ngay không đếm ngược), khóa theo phiên, lệnh sau thắng lệnh trước, đồng bộ trạng thái khi Tray nối lại — khóa có độ trễ + khóa theo phiên đã kiểm chứng trên máy thật tối 17/11/2026 (kể cả đường Limited-token); đồng bộ trạng thái khóa ngay không đếm ngược đã kiểm chứng trên máy thật sáng 18/11/2026; khóa do phụ huynh bấm (Khóa ngay độ trễ 0 + khóa tạm thời) giờ cũng khóa ngay không đếm ngược (v0.1.183, CI xanh run #183) — chờ kiểm chứng lại (xem 2.3.2).
- [x] Phụ huynh có thể "Khóa ngay" / "Mở thêm 15/30/60 phút" từ xa. — Xong Sprint 2 đợt 1 dưới dạng ghi đè tạm thời tự hết hạn (cộng thêm giờ / khóa tạm thời / tạm mở máy, 15/30/60/120 phút, xem 2.3.1). Lệnh khóa/mở đã kiểm chứng trên máy thật.

#### 2.3.1. Danh mục quy tắc giờ giấc — Sprint 2 đợt 1 (đã triển khai)

Quy tắc lưu trong bảng `rules` (cột `config` JSONB). Mọi giờ giấc theo **giờ địa phương trên máy của con**. Quy ước thứ: số 0–6 khớp `Date.getDay()` và C# `DayOfWeek` (0 = Chủ nhật, 6 = Thứ 7). Hình dạng config chi tiết (TypeScript) xem `packages/shared-types/src/index.ts`.

| Loại (`type`) | Config JSONB | Ngữ nghĩa |
|---|---|---|
| `daily_limit` | `{"minutesByWeekday": {"1": 120, "2": 120, "3": 120, "4": 120, "5": 120, "6": 180, "0": 180}}` | Tổng số phút được dùng mỗi ngày, theo thứ. Ngày vắng mặt = không giới hạn ngày đó. Agent vẫn chấp nhận hình dạng cũ `{"minutes_per_day": N}` / `{"daily_minutes": N}` (mọi ngày) cho rule đã lưu trước Sprint 2. |
| `time_window` | `{"windowsByWeekday": {"1": [{"start": "07:00", "end": "21:00"}]}}` | Chỉ được dùng máy trong các khung giờ liệt kê. Ngoài mọi khung giờ thì khóa. **Ngày vắng mặt hoặc mảng rỗng = không được dùng máy ngày đó.** Mỗi khoảng phải có `start < end` (không qua đêm). Nhiều rule thì hợp (union) các khung giờ. |
| `bedtime` | `{"bedtimeByWeekday": {"1": {"start": "21:00", "end": "07:00"}}}` | Khung giờ cấm theo thứ. Khoảng qua đêm (`end <= start`) khóa từ `start` hôm nay tới `end` hôm sau (vd: bedtime Thứ 2 21:00–07:00 khóa tới 07:00 Thứ 3). Ngày vắng mặt = không khóa. Agent vẫn chấp nhận hình dạng cũ `{"start", "end"}` (mọi ngày). |

**Ghi đè tạm thời** (không phải rule — là lệnh trong bảng `commands`, loại `temporary_override`, payload gồm `action`, `minutes`, `expires_at` ISO 8601). Lệnh mới nhất trên cùng một máy thay thế lệnh trước đó (từ Sprint 5: phạm vi thay thế là cùng một máy + cùng một con, xem §2.11); hết hạn thì tự vô hiệu, kể cả khi Service khởi động lại (Agent lưu ghi đè vào SQLite local và kiểm tra hết hạn ở mỗi lần đánh giá rules):

| Hành động (`action`) | Tác dụng |
|---|---|
| `bonus_minutes` | Cộng `minutes` vào hạn mức giờ hôm nay; `expires_at` = hết ngày hôm nay. |
| `lock` | Khóa máy tới `expires_at` (hiệu lực `minutes` phút). |
| `unlock` | Tạm ngưng các quy tắc giờ giấc tới `expires_at` (hiệu lực `minutes` phút). |
| `cancel` | Hủy ghi đè đang hiệu lực (không cần `minutes`/`expires_at`). |

Thứ tự thi hành trong Agent: ghi đè (khóa/mở) → giờ ngủ → khung giờ → giới hạn ngày. Các loại quy tắc khác (theo app, website/domain, giờ học, nghỉ bắt buộc, cảnh báo chống phá, mẫu sẵn) thuộc các đợt tiếp theo theo thứ tự đã chốt với phụ huynh.

#### 2.3.2. Khóa có độ trễ + khóa theo phiên (đợt 17/11/2026 — đã kiểm chứng trên máy thật tối 17/11; đồng bộ Immediate đã kiểm chứng sáng 18/11: đăng nhập lại khi đang khóa thì khóa ngay không đếm ngược)

- Phụ huynh chọn độ trễ 0–5 phút khi bấm "Khóa ngay" trên Dashboard (`delay_minutes` trong payload lệnh `lock_now`). Độ trễ > 0: Tray chỉ hiện cửa sổ cảnh báo nhỏ (không full màn, con vẫn làm việc/lưu bài), hết đếm ngược mới hiện màn hình khóa full màn kèm nút xin thêm giờ. Độ trễ 0: khóa ngay như trước.
- Lệnh khóa/cảnh báo chỉ giao tới phiên Windows của con: Tray tự giới thiệu (phiên, tài khoản, quyền admin qua `TokenElevationType`); Service miễn trừ phiên admin. Ghép nối vẫn ở mức máy (cài một lần bằng quyền Admin, Service chạy quyền SYSTEM); chỉ phần giao lệnh là theo phiên. Phiên chưa giới thiệu vẫn nhận lệnh (fail-closed).
- Trạng thái thi hành trong lúc chờ khóa: Dashboard báo "cảnh báo" thay vì "đang khóa" cho tới khi khóa thật sự có hiệu lực.
- Hết độ trễ thì khóa ngay (Immediate): màn hình khóa full màn hiện không đếm ngược 60s và khóa phiên ngay, vì con đã có cả thời gian độ trễ để lưu bài. Khóa không độ trễ và khóa do quy tắc vẫn giữ đếm ngược 60s.
- Hành động sau thắng hành động trước: lệnh `lock_now` xóa ghi đè mở khóa (unlock) đang hiệu lực trước khi đặt khóa cưỡng chế; ghi đè cộng giờ/chặn app/chặn domain không bị ảnh hưởng.
- Đồng bộ trạng thái khi Tray nối lại: Tray gửi hello thì Service đẩy ngay quyết định hiện tại tới phiên đó (khóa/cảnh báo miễn phiên admin, mở tới mọi phiên) — Tray thoát rồi chạy lại hoặc đăng nhập lại vẫn nhận đúng trạng thái khóa, không chờ tới lần đánh giá sau. Lệnh khóa đồng bộ mang Immediate=true (khóa ngay, không đếm ngược 60s) từ v0.1.167, vì lệnh khóa đã có hiệu lực từ trước — đã kiểm chứng trên máy thật sáng 18/11/2026.

### 2.4. Chặn / cho phép app (App Rules)
- [x] Danh sách chặn/cho phép theo app với thời gian hiệu lực (luôn luôn / theo giờ / tạm thời). — Đã triển khai (Dashboard + Agent, Sprint 2 đợt 3 + bản sửa lỗi): 5 mode `app_time_limit`, `app_block_by_time`, `app_block`, `app_allowlist`, `app_allowlist_by_time` + ghi đè app tạm thời (`block_app`/`allow_app`). Chưa kiểm chứng đầy đủ trên máy thật.
- [x] Chặn theo tên exe (chuẩn hóa chung, không phân biệt hoa thường). Khi app bị chặn đang chạy -> kết thúc process + hiện thông báo lý do. — Đã triển khai (đóng đúng session, denylist hệ thống, fail-open khi không có báo cáo foreground tươi).
- [x] Giới hạn theo app: VD: game tối đa 45 phút/ngày. — Đã triển khai (`app_time_limit`, cảnh báo khi còn ≤ 5 phút).
- [x] Chế độ Allowlist (chỉ cho phép app trong danh sách). — Đã triển khai (`app_allowlist`, `app_allowlist_by_time`).
- [x] Giờ học tập trung (focus) + nghỉ bắt buộc (forced_break) + mẫu quy tắc một chạm (Ngày học/Cuối tuần/Kỳ nghỉ). — Đã triển khai (Sprint 2 đợt 3). Mẫu nhanh "Chỉ cho phép Edge" (chặn 10 trình duyệt đã biết theo tên exe, Dashboard đợt 18/11; trình duyệt lạ/đổi tên không chặn được bằng lớp này — xem §2.5 về DNS dự phòng).

### 2.5. Lọc web — Phạm vi MVP (nói rõ giới hạn)
- [x] Browser Extension cho Chrome/Edge (Manifest V3): chặn domain trong blocklist, chặn theo giờ, allowlist, giới hạn thời gian theo domain, SafeSearch, YouTube Restricted, báo cáo domain đã thăm (domain + đường dẫn, bỏ query/fragment, giữ 90 ngày — quyết định của phụ huynh 18/11/2026, nới ranh giới "chỉ domain" trước đây; không full URL). — Đã triển khai, hiện ở 0.1.10: extension đã cài trên Edge máy thật tối 17/11/2026, native messaging đã nối (popup báo đang bảo vệ + đồng bộ quy tắc), ID thật đã nướng vào installer từ v0.1.167 (không còn placeholder). Chặn domain đã kiểm chứng sáng 18/11/2026 (khớp domain bằng requestDomains); trang chặn SafePC thật đã hiện từ 0.1.4 sau khi sửa gốc rễ thiếu host_permissions cho rule redirect (kiểm chứng 13:32 ngày 18/11) — nhận định cũ rằng mẫu urlFilter "cài rule nhưng không khớp gì" chưa từng được cô lập và không còn dùng làm giải thích (xem `02-ARCHITECTURE.md` §4.5 và extension README). Tab watcher (0.1.5) xử lý điều hướng trong trang, đã kiểm chứng cả 3 trường hợp chiều 18/11. 0.1.6 (tự kiểm tra host permission), 0.1.7 (báo cáo lượt web bị chặn, xem §2.10), 0.1.8 (lý do chặn theo danh mục), 0.1.9 (nút xin mở trang web), 0.1.10 (lịch sử web lưu đường dẫn + tìm kiếm trong Báo cáo tuần, giữ 90 ngày) đã giao, chưa kiểm chứng trên máy thật.
- [x] Blocklist/Allowlist do phụ huynh tự thêm (VD: chặn tiktok.com, cho phép hocmai.vn) + cho phép/chặn tạm thời. — Đã triển khai trên Dashboard + đồng bộ xuống file `domain_rules.json` (đã thấy file xuất bản đúng trên máy thật); thi hành trong trình duyệt chờ kiểm chứng extension.
- [x] Rule mẫu URL có đường dẫn (VD: `bing.com/videos` chỉ chặn link bắt đầu bằng phần đó, `bing.com/abc` không chặn) bên cạnh rule domain — chỉ mode block_domains đợt này, các mode khác từ chối mục đường dẫn lúc lưu (Agent chưa thi hành ở các mode đó). — Đã triển khai (đợt 4: Dashboard tách domain/đường dẫn, publisher xuất urlPatterns, extension 0.1.3 dựng rule regexFilter với ranh giới đường dẫn; CI xanh run #183, v0.1.183), chờ kiểm chứng trên máy thật.
- [ ] DNS filtering dự phòng: hướng dẫn đặt DNS gia đình trên máy con (VD: Cloudflare for Families 1.1.1.3) — ghi rõ đây là lớp bổ sung, không thay extension.
- [ ] **Ngoài phạm vi MVP:** lọc HTTPS toàn hệ thống bằng MITM proxy, chặn VPN, chặn mọi trình duyệt lạ. Các mục này cần đánh giá riêng ở giai đoạn 2 vì rủi ro bảo mật/pháp lý và bị antivirus chặn.

### 2.6. Yêu cầu từ con & thông báo
- [x] Con bấm "Xin thêm giờ" / "Xin mở app" từ màn hình khóa/tray, nhập lý do. — Đã triển khai đầu-cuối (Tray → IPC → outbox Service → RPC Supabase → Dashboard); yêu cầu xin giờ đã kiểm chứng lên server trên máy thật (log 17/11/2026). Yêu cầu xin mở app chưa có thông tin app trong yêu cầu nên duyệt mới chỉ đổi trạng thái.
- [x] Phụ huynh nhận yêu cầu trên Dashboard (tải lúc mở trang), Duyệt/Từ chối + ghi chú. — Đã triển khai: duyệt xin thêm giờ gửi MỘT lệnh ghi đè mở khóa đúng N phút (đổi từ mẫu unlock + cộng giờ sau test máy thật 17/11: cộng giờ chỉ nới mức trần ngày nên không có tác dụng khi con đã dùng vượt mức trần); CI xanh run #167, chưa kiểm chứng lại trên máy thật. Ghi chú khi duyệt chưa có.
- [x] Agent nhận lệnh trong vòng < 30 giây khi online (polling 15s). — Đã triển khai và kiểm chứng (lệnh khóa/mở tới trong ~15s).
- [x] PIN thoát Tray (mã PIN riêng của phụ huynh, khác mật khẩu đăng nhập). — Đã triển khai: PIN đặt trên Dashboard (băm PBKDF2 tại trình duyệt), Service giữ hash và xác thực, sai 5 lần khóa 5 phút (đã thấy khóa nhập hoạt động trong log máy thật 17/11/2026); mã chỉ dùng một lần — nhập đúng và thoát xong thì mã tự gỡ khỏi server (RPC migration 8, đối sánh hash nên không xóa nhầm mã mới), đã kiểm chứng trên máy thật tối 17/11 (lần dùng thứ 2 bị từ chối); CI xanh run #167. Cần migration 8 áp lên Supabase thì việc gỡ trên server mới chạy; trước đó mã vẫn bị xóa khỏi bộ nhớ Service ngay khi dùng đúng và lệnh gỡ thử lại mỗi phút.
- [x] Xem thời gian còn lại thật trên Tray. — Đã triển khai: Tray hỏi Service qua IPC, Service trả quyết định mới nhất kèm số phút còn lại thật (giới hạn ngày/khung giờ/giờ ngủ); khi đang mở khóa tạm thời thì hiện rõ lý do thay vì "không giới hạn". CI xanh run #167, chưa kiểm chứng trên máy thật.

### 2.7. Báo cáo
- [x] Trạng thái thi hành realtime trên Dashboard: luật nào đang khóa máy/khóa app/khóa domain, chip "Đang thi hành", thời gian cập nhật. — Đã triển khai (snapshot enforcement, migration 6).
- [x] Hồ sơ theo con: Dashboard điều hướng Tổng quan / Hồ sơ / Yêu cầu; vào hồ sơ của một con có 3 tab Thiết bị / Quy tắc / Báo cáo chỉ hiện dữ liệu của con đó; tab Báo cáo tổng hợp tổng phút hôm nay, top 5 app, trạng thái máy, yêu cầu chờ duyệt, số quy tắc đang bật (chỉ dùng cột migration 1). — Đã triển khai (đợt sửa 17/11/2026, CI xanh run #159); đường dẫn cũ `/thiet-bi`, `/quy-tac` vẫn hoạt động. Thiết kế lại trang Quy tắc đợt 18/11 (quy tắc hiện hành lên đầu, nhóm theo con/danh mục với màu riêng, form tạo thu gọn accordion, đặt tên quy tắc, mẫu của phụ huynh lưu trên server + áp nhanh, mẫu Chỉ cho phép Edge; CI xanh run #170; migration 9 đã áp sáng 18/11/2026).
- [x] Báo cáo ngày/tuần: tổng giờ, giờ theo app, số lần bị chặn, số lần xin thêm giờ. — Đã triển khai: trang Báo cáo tuần đủ 7 mục + email tóm tắt hàng tuần (xem §2.10); chưa kiểm chứng với dữ liệu thật.
- [ ] Xuất CSV (giai đoạn 1.5).

### 2.8. Tính năng nâng cao + giao diện chuyên nghiệp (đã phê duyệt 17/11/2026; cả 9 mục đã triển khai xong phần code ngày 18/11/2026, kiểm chứng thật còn chờ)

- [x] Trang Hôm nay thành tổng quan thật: thẻ trạng thái máy, giờ còn lại, biểu đồ giờ dùng trong ngày, top app/domain. — Đã triển khai (head f29b937, CI #215 xanh); chưa xem với dữ liệu thật / trên điện thoại thật.
- [x] Thông báo cho phụ huynh: email khi con xin thêm giờ, khi phát hiện can thiệp (đổi giờ, agent offline bất thường). — Đã triển khai phần code: Edge Function `send-parent-notifications` quét mỗi 5 phút + migration 12 (head a40a51a, CI #218 xanh); migration 12 chưa áp, chưa kiểm chứng thật. Mục Thông báo trong Dashboard (chuông ở header + trang /thong-bao, cùng 3 nguồn sự kiện, mốc đã đọc riêng theo user qua migration 20) cũng đã triển khai phần code, chưa kiểm chứng thật. Đẩy thông báo (push): v1 cho PWA đã xây ở cây local ngày 27/11/2026 — phụ huynh được push khi con nhắn tin hoặc gửi yêu cầu mới, kể cả khi Dashboard đang đóng (xem §2.13 + AMENDMENTS A-16); phía Android/FCM để giai đoạn app Android.
- [x] Nhật ký hoạt động: ai đổi rule nào, khóa/mở lúc nào, duyệt yêu cầu nào. — Đã triển khai giao diện (route `/nhat-ky`, tab thứ 5; head 2838181, CI #222 xanh); chưa xem với dữ liệu thật. PHÁT HIỆN: lịch sử đổi rule KHÔNG có nguồn dữ liệu (`rules` không có lịch sử, Dashboard không ghi audit khi sửa rule) — giao diện ghi chú trung thực, follow-up riêng cần Dashboard tự ghi audit với actor = id user.
- [x] Ngân hàng giờ: phụ huynh thưởng thêm giờ kèm lý do và lịch sử, con thấy được giờ thưởng của mình. — Đã triển khai (migration 13 + tab Ngân hàng giờ + Tray hiện câu giờ thưởng; head eda2c5b, CI #228 xanh, installer v0.1.228 — cài thẳng v0.1.229); migration 13 chưa áp, chưa kiểm chứng thật. Ngữ nghĩa: thưởng cộng vào mức trần tới hết ngày, nhiều lần cộng dồn.
- [x] Chặn theo danh mục domain (người lớn, cờ bạc, mạng xã hội) từ danh sách công khai, thay vì gõ từng domain. — Đã triển khai với danh sách hạt giống chọn tay 54 domain (thêm zalo.me ngày 24/11 theo quyết định của anh Tiến — Zalo Web thuộc danh mục "Mạng xã hội"; Diệu Linh xin mở Zalo Web 3 lần ngày 21/11) (head bb632b6, run #229 xanh, installer v0.1.229 + extension 0.1.8); chưa kiểm chứng thật. GIỚI HẠN TRUNG THỰC: chỉ chặn website phổ biến nhất, website mới/mirror sẽ lọt; nhập danh sách công khai đầy đủ là đợt riêng. Câu hỏi đã chốt (anh Tiến trả lời 22:49, 18/11): GIỮ NGUYÊN — WhatsApp Web/Telegram Web + LinkedIn vẫn thuộc danh mục "Mạng xã hội", không tách nhắn tin ra. Không cần sửa code.
- [x] Mở rộng danh mục domain lên 6 nhóm từ filter list công khai (đợt 27/11/2026, xây ở cây local): thêm 3 nhóm bạo lực / game / phim và nhập dữ liệu thật cho cả 6 nhóm — tổng 18.339 domain (adult 8.000, gambling 4.000, violence 296, games 2.500, movies 2.000, social 1.543) thay cho 54 domain hạt giống (hạt giống vẫn được giữ trong dữ liệu mới). CHỈ dùng nguồn sạch theo quyết định giấy phép của anh Tiến (27/11/2026): StevenBlack (MIT), UT1 Blocklist — Université Toulouse Capitole (CC BY-SA 4.0, có ghi công), Block List Project (Unlicense); không dùng HaGeZi/OISD (GPL-3.0) và Energized (NC). Dữ liệu đóng gói dạng file nhúng trong Agent (CategoryData/*.txt) do script tools/import-category-lists sinh, có danh sách bảo vệ (domain học tập/tin tức/tìm kiếm không bao giờ bị xếp nhóm) và ngân sách theo trần ~30.000 rule DNR. Cùng đợt: bổ sung từ khóa tìm kiếm nhóm adult (+47 EN từ LDNOOBW CC BY 4.0, +13 cụm VI) và violence (+10), nâng trần từ khóa hiệu lực 200 → 400; extension 0.1.12 thêm nhãn lý do cho 3 nhóm mới và sửa ngân sách DNR (trần tổng 10.000 rule cho cả ba nhóm rule, rule khác không bao giờ bị cắt vì danh mục lớn, domain vượt ngân sách DNR do tab watcher thi hành — 10.000 < 30.000 trần Chrome bảo đảm). Chi tiết nguồn/phương pháp/cảnh báo chặn nhầm (games gồm Steam, movies gồm Netflix — chỉ bật khi phụ huynh chọn, allowlist luôn thắng): docs/10-DATA-SOURCES.md. Chưa kiểm chứng trên máy thật.
- [x] Mời phụ huynh thứ hai cùng quản lý gia đình. — Đã triển khai (migration 14 + link mời token hiện một lần, anh Tiến tự gửi link qua nhắn tin/Zalo; head c7b5a4c, CI #238 xanh); migration 14 chưa áp, chưa kiểm chứng thật. CHƯA có giao diện gỡ phụ huynh đã tham gia.
- [x] Xuất dữ liệu và xóa toàn bộ dữ liệu của con (theo cam kết riêng tư ở `03-SECURITY.md` mục 5). — Đã triển khai (migration 15 + tab Dữ liệu: xuất một file JSON 10 mục, xóa phải gõ đúng tên con; head 4d713f3, CI #241 xanh); migration 15 chưa áp, chưa kiểm chứng thật — chỉ thử xóa trên hồ sơ con thử, không bao giờ dùng hồ sơ thật. Xóa là xóa cả hồ sơ + cả máy của con; chưa có xóa gia đình/tài khoản.
- [x] Giao diện chuyên nghiệp: chuẩn hóa trạng thái rỗng/đang tải/lỗi/mất mạng; hướng dẫn lần đầu (tạo con, ghép nối, chọn mẫu quy tắc). — Đã triển khai (18 file, bộ component dùng chung + biểu ngữ mất mạng + hướng dẫn 3 bước khi trang Hồ sơ rỗng; head 40fa948, CI #245 xanh; không đổi route/luồng nào); chưa kiểm chứng bằng mắt trên điện thoại thật.
- [x] Xác thực 2 lớp (MFA) cho tài khoản phụ huynh (Supabase đã hỗ trợ sẵn). — Đã triển khai: TOTP tự nguyện qua Supabase Auth, bật/tắt ở mục Bảo mật tài khoản trên trang Hồ sơ (quét QR hoặc nhập secret, nhập mã 6 số để xác nhận; tắt phải nhập mã hiện tại). Đăng nhập khi đã bật thì sau mật khẩu phải nhập mã, sai mã không vào được; tài khoản chưa bật đăng nhập như cũ. Không migration, không đổi luồng đăng ký/xác minh email. Khôi phục khi mất thiết bị: xem `03-SECURITY.md` §2 (gỡ factor bởi quản trị dự án Supabase, không có mã khôi phục tự phục vụ). Chưa kiểm chứng đầu-cuối trên tài khoản thật.

Ranh giới giữ nguyên (quyết định 17/11/2026): không chụp màn hình, không ghi phím, không đọc nội dung chat hay file của con. Mục chụp màn hình opt-in ở §4 đã loại khỏi kế hoạch.

### 2.9. Cài đặt cho phụ huynh khác — không cần biết code (đã phê duyệt 17/11/2026)

Luồng mục tiêu, từ góc nhìn phụ huynh mới:

1. Vào website, đăng ký, tạo gia đình và hồ sơ con.
2. Bấm Thêm máy, tải 1 file cài đặt, chạy, nhập mã 6 số hiện trên web vào trang ghép nối của bộ cài. Không còn bước PowerShell (lệnh PowerShell vẫn dùng được để debug). Máy hiện Online là xong.
3. Bấm link cài extension trên Dashboard, 1 click từ cửa hàng của Chrome/Edge, tự nối với agent.
4. Chọn mẫu quy tắc Ngày học hoặc Cuối tuần, dùng ngay.
5. Sau này: tải app Android từ Play Store, đăng nhập cùng tài khoản, khóa/mở và duyệt yêu cầu.

Việc cần làm để đạt luồng này:

- [ ] Một bản triển khai dùng chung cho mọi gia đình (1 Supabase + 1 web), dữ liệu tách nhau bằng RLS. Người vận hành giữ khóa quản trị.
- [x] Bộ cài có giao diện nhập mã ghép nối, thay cho lệnh PowerShell hiện tại. — Đã triển khai 19/11/2026 (SafePCAgent.iss: trang CreateInputQueryPage sau wpInstalling, chạy PairingCli, nhập sai được nhập lại, có "Bỏ qua, ghép nối sau"; CI chờ chạy sau khi push, chưa kiểm chứng trên máy thật).
- [ ] Extension đăng lên cửa hàng Chrome/Edge (Chrome phí đăng ký 5 USD một lần, Edge miễn phí) để có ID thật và tự cập nhật.
- [ ] Ký số bộ cài. Chưa có chứng chỉ thì Windows hiện cảnh báo SmartScreen, cần hướng dẫn phụ huynh bấm "vẫn chạy". Chứng chỉ ký số có phí, để sau cũng được.
- [ ] Agent tự cập nhật khi có bản mới, có kiểm tra hash.
- [ ] Trang hướng dẫn + chính sách riêng tư tiếng Việt, bắt buộc có trước khi mời gia đình ngoài dùng thử. Domain riêng là tùy chọn.

Quyết định còn mở (chưa chốt): ai vận hành bản dùng chung, có mua domain không, tài khoản đăng ký cửa hàng extension đứng tên ai, có mua chứng chỉ ký số không.

### 2.10. Báo cáo tuần (đã phê duyệt 17/11/2026; trang Báo cáo đã live, email đã giao phần code — kiểm chứng thật còn chờ)

Nội dung 7 mục (tuần = thứ Hai 00:00 giờ địa phương tới thứ Hai sau; chọn con + chọn tuần, tuần này + 7 tuần trước):

1. Tổng quan: tổng giờ dùng tuần, tăng/giảm so với tuần trước, số ngày dùng máy.
2. Giờ dùng theo từng ngày, kèm đường giới hạn để thấy ngày nào vượt.
3. Top 5 app và top 5 domain, kèm giờ và tỉ lệ.
4. Quy tắc đã thi hành: số lần khóa theo từng loại, số lần chặn app/domain, số cảnh báo, số giờ nghỉ bắt buộc.
5. Yêu cầu xin thêm giờ: bao nhiêu yêu cầu, đã duyệt/từ chối/chờ bao nhiêu.
6. Cảnh báo: đổi giờ, agent khởi động lại, extension mất tín hiệu, offline bất thường.
7. Gợi ý tự động, ví dụ "Thứ 7 con dùng gấp đôi ngày thường" hay "YouTube chiếm 60% thời gian".

Hình thức đã chốt: trang Báo cáo ngay trên Dashboard với biểu đồ (thư viện Recharts, miễn phí, cùng công nghệ hiện tại) kèm email tóm tắt gửi mỗi tuần (Edge Function + Resend gói free). KHÔNG dùng Power BI làm hướng chính: cần gói trả phí, phải xuất dữ liệu trẻ em ra khỏi Supabase, phức tạp mà không hơn biểu đồ trong Dashboard. Xuất PDF để sau; in trực tiếp từ trang báo cáo là đủ.

**Trang Báo cáo đã triển khai** (route `/bao-cao`, tab Báo cáo; head 126f7765): đủ 7 mục, logic thuần ở `weekReport.ts`, phân trang thật + ghi chú khi dữ liệu bị cắt. Mục 4 đếm từ nguồn mới sau đợt ghi sự kiện thi hành (xem `02-ARCHITECTURE.md` §4.10): Agent ghi chuyển trạng thái qua RPC `safepc_push_enforcement_event` (migration 10, 4 action `lock_started`/`break_started`/`app_blocked`/`warning_shown`), khóa của phụ huynh đếm riêng từ bảng `commands` để không đếm trùng, lượt web bị chặn đếm từ `web_visits.blocked` (extension 0.1.7 báo cáo, chỉ domain). Ghi chú trung thực trong giao diện: lịch sử thi hành chỉ bắt đầu từ khi migration 10 được áp + bản Agent/extension mới được cài (migration 10 đã áp 18/11/2026, bản mới chưa cài lên máy thật), và số lượt web bị chặn là con số tối thiểu (lượt bị chặn bởi quy tắc chặn tất cả không quy chiếu được domain nên không đếm). Trang chưa kiểm chứng với dữ liệu thật.

**Email báo cáo tuần đã giao phần code** (head 4485d5e, CI #212 xanh): Edge Function `send-weekly-report` một file, gửi mỗi thứ Hai 07:00 giờ +07 qua pg_cron + pg_net (migration 11, đã áp), một email cho một family tới mọi phụ huynh (người nhận qua Auth Admin API), đủ 7 mục ở dạng gọn, chống gửi trùng bằng bảng `weekly_report_sends` + RPC claim/finish, bảo vệ bằng header secret dùng chung với email thông báo. Chi tiết luồng + hợp đồng secret xem `02-ARCHITECTURE.md` §4.11; các bước tay (deploy function, tắt JWT, đặt secret, gửi thử) xem `docs/06-EMAIL-SETUP.md`. CHƯA kiểm chứng đầu-cuối: chưa chạy thật, chưa gửi thật, dòng lịch cron + múi giờ UTC chưa xác nhận. Chưa có domain đã xác minh thì email chỉ giao tới đúng email đăng ký tài khoản Resend; domain `ndt.ap.vn` đã mua nhưng chưa thêm vào Resend và chưa xác minh DNS.

Dữ liệu cho cả hai hình thức nằm trong các bảng `app_usage`, `web_visits`, `audit_logs`, `requests`, `commands`.

### 2.11. Quản lý riêng biệt nhiều con trên một máy — phương án 2: một phiên active (đã phê duyệt 20/11/2026)

**Trạng thái: đã phê duyệt hướng đi ngày 20/11/2026, CHƯA bắt đầu code (Sprint 5, xem `04-ROADMAP.md`).**

**Vấn đề.** Một máy có thể có nhiều tài khoản con (ví dụ máy dùng chung của Diệu Linh và Đức Dũng). Hiện tại một thiết bị chỉ ghép nối với một hồ sơ con (token thiết bị duy nhất, rules lấy theo `device_id`), nên mọi con dùng chung máy phải dùng chung luật, giờ giấc và báo cáo của hồ sơ được ghép nối.

**Ngữ nghĩa đã chốt (phương án 2 — một phiên active).**

- Chỉ phiên console đang hoạt động mới bị thi hành luật. Phiên nền không bị thi hành cho tới khi quay lại console; giờ dùng máy chỉ tính cho phiên console. Tray ở phiên nền hiện trạng thái tạm dừng.
- Giết app ĐÃ theo phiên từ trước (`KillProcessesInSession` lọc theo `SessionId` của phiên báo cáo) — Sprint 5 không đổi đường giết app; app ở phiên nền không bị giết nhầm khi thi hành luật ở phiên active.
- Một file `domain_rules.json` dùng chung cho cả máy, mang luật của con đang active; Service ghi lại file mỗi khi đổi phiên console. Trình duyệt ở phiên nền chịu luật của con đang ngồi — chấp nhận được vì không ai tương tác với phiên nền.
- Lệnh (khóa/mở/ghi đè) gắn theo từng con: bảng `commands` cần thêm `child_id`. Lệnh cho con chưa active thì hoãn lại và áp dụng ngay khi con đó lên console; Dashboard hiện "sẽ áp dụng khi con đăng nhập" thay vì báo đã thi hành.
- Mô hình dữ liệu: bảng ánh xạ mới thiết bị ↔ hồ sơ con ↔ tài khoản Windows, lưu theo SID cho bền — Tray gửi thêm SID (`WindowsIdentity.GetCurrent().User.Value`) trong bản tin hello (bản tin hiện tại chỉ mang `SessionId`/`UserName`/`IsAdmin`, chưa có SID); tên hiển thị lấy từ bản tin hello của Tray. Usage (app/web) ghi theo (thiết bị, tài khoản Windows) rồi suy ra hồ sơ con — riêng lịch sử web và yêu cầu xin mở trang: NativeHost gắn thêm username/SID vào mỗi dòng `web_usage.jsonl` và `domain_requests.jsonl` (hiện các dòng này chưa có trường phân biệt user, hai NativeHost của hai user ghi chung một file); watermark chống lệnh cũ tách theo (thiết bị, con) thay vì theo thiết bị.
- Đồng bộ trạng thái khi gắn thêm con vào máy chung: **ĐÃ CHỐT phương án (a) ngày 21/11/2026.** Máy chung chưa từng tiêu thụ lệnh của con B nên lệnh khóa cưỡng chế / ghi đè đang hiệu lực / tổng ngân hàng giờ của B (đã `done` trên máy khác của B) sẽ không tự tới được máy này qua vòng poll lệnh — B có thể ngồi vào máy chung mà không bị khóa dù đang bị khóa cưỡng chế. Cơ chế: migration 27, RPC `safepc_sync_enforcement_state_to_device` — Dashboard gọi ngay sau khi tạo ánh xạ, tái dùng khối sao chép của migration 21 (đi bộ lệnh của con ở mức con, bao cả lệnh legacy lẫn lệnh Sprint 5, chèn tối đa 1 lệnh khóa + 1 ghi đè, mang mốc `created_at` gốc, khóa trước ghi đè sau); gọi best-effort — migration 27 chưa áp thì gắn vẫn thành công, chỉ hiện ghi chú. Giới hạn còn lại: gắn lại thì sao chép lại (bản sao pending cũ bị xóa); lệnh phụ huynh chèn đúng giữa lúc RPC đọc trạng thái và commit có thể lỡ (như giới hạn migration 21); thu hồi giờ thưởng vẫn chỉ tới máy mặc định của con (tới migration 26).
- Dashboard: trang thiết bị liệt kê các con đang gắn với máy kèm tài khoản Windows tương ứng. Gắn/gỡ bằng cách chọn từ danh sách tài khoản Windows mà Tray đã "nhìn thấy" trên máy — không gõ tay (tên tài khoản Microsoft suy ra từ email nên gõ tay dễ sai). Lệnh khóa/mở và duyệt yêu cầu phải chọn đúng con trên đúng máy.
- Tài khoản Standard chưa gắn với hồ sơ con nào: **ĐÃ CHỐT 20/11/2026:** không quản lý nhưng hiện lên Dashboard để phụ huynh thấy (phần hiện cảnh báo trên Dashboard làm ở đợt Dashboard của Sprint 5; Service chỉ ghi log cảnh báo). Tùy chọn "tài khoản chưa gắn = con còn lại" (chỉ cho gia đình đúng 2 con) không làm.
- Không đổi: bộ cài (một lần, quyền Admin, cả máy), giao diện Tray theo phiên, mã PIN, ngân hàng giờ (đã tính theo từng con), RLS, báo cáo tuần theo từng con.

**Đa máy theo hồ sơ con.** Mỗi con vẫn có thể có nhiều máy; một máy có thể dùng chung giữa các con hoặc riêng một con. Luật, ngân hàng giờ và báo cáo tính theo hồ sơ con trên mọi máy của con đó. Máy dùng chung thi hành luật của con đang active; máy riêng một con hoạt động như hiện nay. Ghép nối không đổi: một token duy nhất cho mỗi máy; bước ánh xạ (máy, tài khoản Windows) → hồ sơ con làm sau bước ghép nối.

**Vì sao không chọn phương án 1 (thi hành đầy đủ theo từng phiên).** Phương án 1 phải giữ cache luật riêng cho từng con, xuất file domain rules riêng cho từng tài khoản Windows, và ca khóa máy cho phiên nền là không xác định ở tầng Win32 (`LockWorkStation` chỉ khóa console). Phương án 2 tránh được cả ba điểm này với cái giá chấp nhận được là phiên nền không bị thi hành cho tới khi quay lại console.

**Kiểm thử.** Bắt buộc trên máy thật với 2 tài khoản con + chuyển đổi nhanh (fast user switching); CI không mô phỏng được đa phiên.

**Độ lớn ước lượng:** khoảng 60–70% so với phương án 1 đầy đủ (chỉ là ước lượng, không phải cam kết).

### 2.12. Kiểm duyệt từ khóa tìm kiếm (anh Tiến yêu cầu 27/11/2026 — đã xây ở cây local, chờ đẩy cùng đợt sau khi anh test xong v0.1.309)

Kiểu Microsoft Family Safety: chặn ngay tại lúc con tìm kiếm, và thống kê lại cho phụ huynh xem.

**Chặn theo từ khóa.** Quy tắc website mới, mode `block_search_keywords`, đặt theo từng hồ sơ con. Config dạng `{"keywords": [...], "groups": [...], "customKeywords": [...]}`: `keywords` LUÔN là danh sách hiệu lực duy nhất mà backend/extension đọc (tối đa 400 từ hiệu lực — nâng từ 200 ngày 27/11/2026 khi bổ sung từ khóa từ danh sách công khai, từ khóa riêng vẫn tối đa 200; mỗi từ tối đa 60 ký tự, chuẩn hoá chữ thường) — bằng hợp nhất từ khóa của các nhóm chủ đề đã chọn cộng từ khóa riêng, nên hợp đồng với backend không đổi khi thêm cơ chế nhóm. Khi cụm từ con gõ vào ô tìm kiếm chứa một từ khóa trong danh sách hiệu lực, lượt tìm kiếm bị chặn và trình duyệt hiện trang cảnh báo của SafePC. Phạm vi v1: 5 công cụ tìm kiếm — Google, Bing, DuckDuckGo, Yahoo, Cốc Cốc. Backend phát danh sách xuống extension qua trường `searchGuard.blockedKeywords` trong `domain_rules.json`.

**Nhóm từ khóa theo chủ đề (anh Tiến bổ sung 27/11/2026).** Danh sách từ cấm mẫu được chia thành 6 nhóm chủ đề để phụ huynh TÍCH CHỌN cả nhóm thay vì thêm từng từ: Nội dung người lớn (16+/18+), Cờ bạc / cá cược, Bạo lực, Game, Phim, Mạng xã hội — mỗi nhóm là một danh sách mẫu song ngữ Anh/Việt do SafePC gợi ý, phụ huynh tự sửa được. (Ban đầu bộ mẫu gốc gộp cả từ cờ bạc vào nhóm người lớn; đã tách thành nhóm "Cờ bạc / cá cược" riêng theo review 27/11/2026 để nhãn nhóm nói đúng nội dung, khớp cách tách danh mục domain phía Agent.) Ngoài nhóm, phụ huynh thêm từ khóa riêng của gia đình (editor dạng chip). Form sửa quy tắc có khu tích chọn 6 nhóm (kèm mô tả + số từ + xem trước vài từ đầu), khu từ khóa riêng, và dòng tổng kết "Tổng số từ khóa sẽ bị chặn" tính từ danh sách hiệu lực thật. Mẫu sẵn một chạm "Chặn từ khóa tìm kiếm" tạo quy tắc với nhóm Nội dung người lớn (16+/18+) đã tích sẵn (khớp mặc định kiểu Family Safety); câu xác nhận 2 bước nêu rõ nhóm nào đang bật. Quy tắc cũ chỉ có `keywords` vẫn đọc được — toàn bộ được hiểu là từ khóa riêng, `groups` rỗng.

**Thống kê trong Báo cáo tuần.** Mọi lượt tìm kiếm trên 5 công cụ trên (cả lượt được phép lẫn lượt bị chặn) được ghi vào bảng `search_terms` (migration 28: `family_id`, `child_id`, `device_id`, `engine`, `term`, `blocked`, `created_at`). Trang Báo cáo tuần có mục riêng "Từ khóa tìm kiếm" theo tuần + con đang chọn: bảng cụm từ × công cụ, tổng số lượt, số lượt bị chặn nổi bật, sắp xếp theo tổng lượt giảm dần, tối đa 50 dòng, có ô lọc text — cùng mẫu với mục tìm kiếm lịch sử web.

**Ranh giới riêng tư (nới có ý thức, xem AMENDMENTS A-14).** CHỈ cụm từ tìm kiếm trên các công cụ tìm kiếm mới được trích ra và lưu; mọi URL khác vẫn bỏ phần truy vấn (query) và fragment như quyết định lịch sử web ngày 18/11/2026. Dữ liệu từ khóa tìm kiếm giữ 90 ngày như lịch sử web rồi tự xóa. Chính sách riêng tư (trang công khai + docs/09) đã bổ sung mục dữ liệu này kèm ngày cập nhật 27/11/2026.

**Trạng thái.** Đã xây ở cây local ngày 27/11/2026 (Dashboard + extension + backend/Agent do các builder song song phụ trách); migration 28 cần anh chạy tay qua SQL Editor sau migration 24 và 27. Đẩy GitHub cùng đợt sau khi anh test xong v0.1.309; chưa kiểm chứng trên máy thật.

### 2.13. Nhắn tin giữa con và phụ huynh (anh Tiến yêu cầu 27/11/2026 — đã xây ở cây local, chờ đẩy cùng đợt sau khi anh test xong v0.1.309)

**Mục đích.** Con cần liên lạc với bố mẹ mà không phải mở ứng dụng nhắn tin bên ngoài (Telegram/Zalo/WhatsApp...) — các ứng dụng đó vừa gây xao lãng vừa không giới hạn được người liên lạc. SafePC có kênh nhắn tin riêng, CHỈ trong gia đình: con chỉ nhắn được với phụ huynh của mình, không có danh bạ mở, không có người lạ.

**Vì sao không dùng phần mềm bên thứ ba.** Anh Tiến có nêu phương án dùng Telegram/WhatsApp sao cho con chỉ nhắn/gọi được với người trong danh bạ được phép. Đường này KHÔNG khả thi: các ứng dụng đó không cho bên thứ ba kiểm soát danh bạ hay giới hạn đối tác liên lạc — SafePC chỉ chặn/mở được cả ứng dụng như mọi app khác, không can thiệp được vào bên trong. Kênh tích hợp là cách duy nhất đáp ứng đúng yêu cầu "chỉ nhắn với người được phép".

**Phạm vi v1 (chỉ trên web).** Chỉ tin nhắn chữ. Gọi thoại/video để giai đoạn app Android (Giai đoạn 2), không làm ở đợt này.

- **Phía phụ huynh:** tab "Nhắn tin" trong hồ sơ con trên Dashboard — đọc/gửi qua RLS trên bảng `messages` (migration 29), polling 5 giây, trạng thái "Đã xem / Đã gửi" ở tin phụ huynh gần nhất, mở tab hoặc thấy tin mới của con thì tự đánh dấu phụ huynh đã đọc.
- **Phía con:** con bấm mở nhắn tin từ menu khay SafePC trên máy → Service (giữ token thiết bị) mint một TOKEN PHIÊN 12 giờ qua RPC `safepc_mint_chat_session` (phân giải đúng hồ sơ con theo tài khoản Windows như Sprint 5) → mở trang chat riêng `/nhan-tin` trong trình duyệt kèm token ở fragment URL. Con không cần tài khoản. Trang chat chỉ gọi 3 RPC theo token phiên (`safepc_chat_fetch` / `safepc_chat_send` / `safepc_chat_mark_read`), polling 5 giây. Mỗi (máy, con) chỉ có một phiên hiệu lực — mint mới thì thu hồi phiên cũ; phụ huynh thu hồi toàn bộ phiên của con bằng `safepc_revoke_chat_sessions`. Token phiên sai/hết hạn/thu hồi → trang hiện "Phiên nhắn tin đã hết hạn. Con mở lại từ khay hệ thống SafePC trên máy tính nhé."
- **Dữ liệu:** bảng `messages` (hai chiều, mốc đã đọc hai phía, tin tối đa 2000 ký tự) + bảng `chat_sessions` (chỉ lưu hash SHA-256 của token phiên; RLS không có policy cho user thường — chỉ RPC SECURITY DEFINER chạm vào).

**Ranh giới riêng tư (nới có ý thức, xem AMENDMENTS A-15).** Đây là lần đầu SafePC LƯU NỘI DUNG liên lạc — nhưng là nội dung do chính phụ huynh và con chủ động tạo ra trong kênh của sản phẩm, cả hai phía đều là người tham gia; ranh giới cũ "không đọc nội dung chat/email/file của con ở ứng dụng khác" vẫn giữ nguyên. Tin nhắn nằm trong file xuất dữ liệu của con (mục "Tin nhắn") và bị xóa khi phụ huynh xóa dữ liệu con (RPC xóa của migration 15 đã được migration 29 mở rộng). Phiên nhắn tin (hash token) là thông tin xác thực nên KHÔNG xuất, như device token.

**Trạng thái.** Đã xây ở cây local ngày 27/11/2026: migration 29 + Dashboard (tab Nhắn tin + trang /nhan-tin + xuất/xóa) do builder backend/Dashboard phụ trách; móc nối phía Agent (menu khay → Service mint phiên → mở trình duyệt) do builder Agent phụ trách theo đúng hợp đồng RPC của migration 29. Migration 29 cần anh chạy tay qua SQL Editor SAU migration 24. Đẩy GitHub cùng đợt sau khi anh test xong v0.1.309; chưa kiểm chứng trên máy thật.

**Thông báo đẩy cho phụ huynh (anh Tiến yêu cầu bổ sung 27/11/2026 — BẮT BUỘC, xem AMENDMENTS A-16).** Động cơ trực tiếp: con xin mở chat.zalo.me 4 lần qua Family Safety mà anh không hề biết vì lúc đó không mở web/app — push là điều kiện để kênh nhắn tin này thay được các kênh ngoài. Phạm vi v1 (Web Push cho Dashboard PWA): (a) tin nhắn chat mới do CON gửi — gộp theo con, mỗi lần quét một push, nội dung là đoạn xem trước tối đa 60 ký tự của tin mới nhất (cắt ở server; payload Web Push được mã hóa đầu-cuối tới thiết bị của phụ huynh); (b) yêu cầu mới của con (`extra_time` / `unblock_app` / `unblock_domain`) — gộp theo con, tối đa 1 push / con / 10 phút. Hạ tầng: migration 30 (bảng `push_subscriptions` — đăng ký của phụ huynh: điểm nhận + khóa công khai mã hóa của điểm nhận, RLS chỉ chủ sở hữu; cột `messages.push_notified_at`; bảng `push_sends` chống gửi trùng theo người nhận) + Edge Function `send-push-notifications` quét mỗi 5 phút qua pg_cron (kênh độc lập với email: dấu đã gửi của kênh này không chặn kênh kia; subscription bị dịch vụ push trả 404/410 thì tự xóa) + service worker và công tắc "Thông báo đẩy" cạnh chuông thông báo trên header Dashboard. Phụ huynh bấm thông báo thì mở đúng tab Nhắn tin của hồ sơ con (tin nhắn) hoặc trang Yêu cầu. Phía Android/FCM: cấu trúc dữ liệu đã để sẵn (cột `platform`), build ở giai đoạn app Android — cùng backend, không làm lại. Trạng thái: đã xây ở cây local ngày 27/11/2026 (harness migration 30 đạt 26/26), CHƯA deploy — các bước tay của anh (tạo cặp khóa VAPID, đặt secret Supabase, đặt `VITE_VAPID_PUBLIC_KEY` trên Vercel, deploy function, áp migration 30 SAU 29) xem `04-ROADMAP.md` mục push.

## 3. Giai đoạn 2: App Android cho phụ huynh

Tính năng nâng cao đã chốt ngày 17/11/2026 (xem §2.8) — sẵn sàng thảo luận Android khi bắt đầu, để khỏi làm lại.

- [ ] Đóng gói Dashboard PWA bằng Capacitor -> APK/AAB, thêm push notification (Supabase + FCM free).
- [ ] Hoặc xây Flutter app riêng nếu cần UX native tốt hơn — quyết định sau khi Dashboard Web ổn định.
- [ ] Tính năng: xem nhanh trạng thái máy (online/offline, còn bao nhiêu phút), khóa/mở nhanh, duyệt yêu cầu, đổi quy tắc cơ bản.

## 4. Giai đoạn 3: Nâng cao (chỉ làm khi giai đoạn 1-2 ổn định)

- [ ] ~~Chụp màn hình theo lịch (opt-in, phụ huynh bật rõ ràng, ảnh mã hóa, tự xóa sau 7 ngày)~~ — **ĐÃ LOẠI KHỎI KẾ HOẠCH ngày 17/11/2026** theo quyết định giữ ranh giới riêng tư (không chụp màn hình, không ghi phím, không đọc nội dung).
- [x] Giới hạn theo website (thời gian cho từng domain). — Đã triển khai (chế độ giới hạn thời gian theo domain của extension, Sprint 2 đợt 2); chờ kiểm chứng đầu-cuối cùng extension.
- [ ] Nhiều con/nhiều máy — đã có hướng đi ở §2.11 / Sprint 5 (phương án 2: một phiên active; phê duyệt 20/11/2026, chưa bắt đầu code). Quy tắc theo nhóm tuổi: chưa làm.
- [ ] Cảnh báo nội dung nguy hiểm theo từ khóa trên tiêu đề cửa sổ — **CẦN ĐÁNH GIÁ LẠI**: đọc tiêu đề cửa sổ mâu thuẫn với nguyên tắc thu thập tối thiểu hiện tại (Agent cố tình không đọc tiêu đề cửa sổ, không gọi `GetWindowText`); chỉ làm khi có quyết định riêng, sau khi đánh giá quyền riêng tư kỹ.
- [ ] Báo cáo AI tóm tắt tuần (dùng API free/low-cost, dữ liệu đã ẩn danh hóa).

## 5. Không làm (Non-goals)

- Không ghi phím (keylogger), không đọc tin nhắn/email/file, không nghe mic/bật camera.
- Không chụp màn hình (đã loại khỏi kế hoạch ngày 17/11/2026, xem §4).
- Không quản lý điện thoại Android/iOS của con trong MVP (chỉ PC).
- Không thanh toán trong MVP.
- Không hỗ trợ macOS/Linux trong MVP.

## 6. Tiêu chí chấp nhận MVP (Definition of Done)

1. ✅ Cài Agent trên máy Windows Standard User, Agent tự chạy khi khởi động, không cần phụ huynh can thiệp. — Đã kiểm chứng (Service chạy từ lúc khởi động, Tray tự chạy mỗi lần đăng nhập).
2. 🔨 Phụ huynh đặt giới hạn 30 phút, Agent khóa đúng giờ, con thấy lý do và xin thêm giờ được. — Khóa đúng giờ đã kiểm chứng (giờ ngủ + khóa ngay); xin thêm giờ đầu-cuối đã kiểm chứng sáng 18/11 (duyệt = mở khóa đúng N phút, máy mở ngay). Khóa đúng giới hạn phút/ngày chưa kiểm chứng riêng.
3. ✅ Chặn 1 app (VD: game) và 1 domain (qua extension) hoạt động đúng, có log. — Đã kiểm chứng: chặn app (Chrome/Notepad bị đóng trong lúc mở khóa, trưa 18/11) và chặn domain (trang chặn SafePC thật, 13:32 ngày 18/11); log thi hành ghi qua sự kiện thi hành + lượt web bị chặn (xem §2.10).
4. ✅ Mất mạng, dữ liệu không mất, đồng bộ lại khi có mạng. — Thiết kế offline-first đã triển khai (SQLite + hàng đợi); kiểm chứng mất mạng có chủ đích chưa chạy đầy đủ.
5. ✅ Con (Standard User) không tắt/gỡ được Agent nếu không có mã PIN phụ huynh. — Standard User không dừng được Service SYSTEM / không gỡ được (cần quyền Admin) — đã đúng theo thiết kế; mã PIN thoát Tray đã triển khai và kiểm chứng (dùng một lần, lần 2 bị từ chối). **PIN gỡ cài đặt đã triển khai ở Sprint 4 (19/11/2026, CI chờ chạy sau khi push, chưa kiểm chứng trên máy thật): gỡ SafePC khỏi máy cũng yêu cầu nhập đúng mã PIN thoát Tray (dùng chung một mã, kiểm tra không tiêu thụ mã — khác thoát Tray dùng một lần); chưa đặt PIN thì gỡ bằng quyền Admin như trước; gỡ im lặng khi đã đặt PIN thì bị chặn.**
6. ✅ Dashboard load nhanh, hiển thị đúng dữ liệu trong ngày. — Bản live hoạt động; đo hiệu năng chính thức chưa chạy.
