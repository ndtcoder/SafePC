# PRD — SafePC v0.1

## 0. Trạng thái hiện tại (18/11/2026)

Bản v0.1.136 đã kiểm chứng trên máy thật: ghép nối, đồng bộ quy tắc, khóa/mở máy từ Dashboard đều hoạt động. Các mục dưới đây ghi rõ trạng thái thật: ✅ đã triển khai (ghi rõ đã kiểm chứng trên máy thật hay chưa), 🔨 đang làm, ⏳ chưa làm. Chi tiết lộ trình xem `04-ROADMAP.md`.

| Hạng mục | Trạng thái |
|---|---|
| Tài khoản, ghép nối, đồng bộ quy tắc | ✅ Đã triển khai, đã kiểm chứng trên máy thật |
| Theo dõi thời gian dùng app + web | ✅ Đã triển khai (app đã kiểm chứng; web chờ extension được cài) |
| Quy tắc giờ giấc, theo app, focus, nghỉ bắt buộc | ✅ Đã triển khai; khóa theo quy tắc đã kiểm chứng (giờ ngủ), các mode app chờ kiểm chứng thêm |
| Khóa/mở từ xa, ghi đè tạm thời | ✅ Đã triển khai, đã kiểm chứng trên máy thật |
| Khóa có độ trễ + khóa theo phiên | ✅ Đã triển khai, đã kiểm chứng trên máy thật (tối 17/11: độ trễ + cảnh báo nhỏ đúng, phiên admin miễn khóa qua đường Limited-token; sáng 18/11: đăng nhập lại khi đang khóa thì khóa ngay không đếm ngược); lệnh sau thắng lệnh trước, hết độ trễ khóa ngay không đếm ngược; khóa do phụ huynh bấm (Khóa ngay độ trễ 0 + khóa tạm thời) giờ khóa ngay không đếm ngược (v0.1.183, CI xanh run #183) — chờ kiểm chứng lại |
| PIN thoát, xin thêm giờ đầu-cuối, xem giờ còn lại | ✅ Đã triển khai, CI xanh (run #183, v0.1.183); PIN một lần đã kiểm chứng trên máy thật (lần dùng thứ 2 bị từ chối; migration 8 đã áp sáng 18/11 nên lệnh gỡ PIN chờ từ tối qua đã hoàn tất trên server); duyệt xin giờ = mở khóa đúng N phút, máy mở ngay đã kiểm chứng sáng 18/11 — thẻ thiết bị từng xung đột khóa/mở, đã sửa (ưu tiên trạng thái mở khóa + snapshot đẩy ngay khi đổi từ vòng tick) trong v0.1.183, chờ kiểm chứng lại; migration 8 + 9 đã áp lên Supabase |
| Hồ sơ theo con (Dashboard) | ✅ Đã triển khai, CI xanh (run #159, 17/11): Tổng quan / Hồ sơ / Yêu cầu; mỗi hồ sơ có tab Thiết bị / Quy tắc / Báo cáo riêng; mã ghép nối hết hạn sau 5 phút. Thiết kế lại trang Quy tắc (quy tắc hiện hành lên đầu, form thu gọn, tên rule, mẫu của phụ huynh, mẫu Chỉ cho phép Edge) — CI xanh run #170, migration 9 đã áp sáng 18/11, chờ kiểm chứng trên điện thoại thật |
| Chặn/cho phép domain qua extension | ✅ Chặn domain đã kiểm chứng trên máy thật sáng 18/11 (extension 0.1.2, khớp domain bằng requestDomains: youtube.com không xem được nữa, popup hiện đúng version + domain + rule đang áp; trang chặn SafePC chưa hiện thay vỏ trang đệm — chỉ khác hiển thị, chức năng chặn đạt). Extension 0.1.3 thêm chặn theo đường dẫn (bing.com/videos) — CI xanh run #183, chờ kiểm chứng trên máy thật. Chặn app / mẫu Chỉ cho phép Edge cũng đã kiểm chứng sáng 18/11 (Chrome cài bằng quyền user của con bị đóng 2 lần + hộp cảnh báo Tray) |
| Tính năng nâng cao + giao diện chuyên nghiệp | ⏳ Đã phê duyệt 17/11/2026, thực hiện dần (xem §2.8) |
| Flow cài đặt cho phụ huynh khác | ⏳ Đã phê duyệt 17/11/2026, thực hiện dần (xem §2.9) |
| Báo cáo tuần | ⏳ Đã phê duyệt 17/11/2026, thực hiện dần (xem §2.10) |
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
- [x] Ghép nối máy con bằng mã pairing 6 số, hết hạn sau 5 phút, dùng 1 lần. — Đã triển khai và kiểm chứng trên máy thật (16–17/11/2026). Hạn rút từ 10 xuống 5 phút theo yêu cầu test 17/11/2026. QR chưa làm; mã nhập bằng lệnh PowerShell (sẽ thay bằng giao diện ghép nối trong bộ cài — xem roadmap).
- [x] Agent lưu device token an toàn (DPAPI LocalMachine), không lưu mật khẩu phụ huynh trên máy con. — Đã triển khai; token thô không bao giờ rời máy, server chỉ lưu hash SHA-256.

### 2.2. Theo dõi thời gian sử dụng (Usage Tracking)
- [x] Ghi nhận app đang chạy ở foreground (tên process, thời lượng), tổng hợp theo mẫu 15 giây. — Đã triển khai; Service lưu SQLite local, đẩy batch lên server mỗi 5 phút.
- [x] Ghi nhận thời gian online/offline (heartbeat 60s, trạng thái thiết bị trên Dashboard). — Đã triển khai. Thời gian khóa màn hình chưa tách riêng.
- [x] Gửi dữ liệu lên server theo batch, có hàng đợi offline (SQLite local), đồng bộ khi có mạng. — Đã triển khai.
- [ ] Dashboard hiển thị: tổng thời gian hôm nay/tuần, top app, biểu đồ theo giờ. — Trang Hôm nay hiện dữ liệu cơ bản; tổng quan thật + biểu đồ đã phê duyệt 17/11/2026 (xem §2.8).

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

**Ghi đè tạm thời** (không phải rule — là lệnh trong bảng `commands`, loại `temporary_override`, payload gồm `action`, `minutes`, `expires_at` ISO 8601). Lệnh mới nhất trên cùng một máy thay thế lệnh trước đó; hết hạn thì tự vô hiệu, kể cả khi Service khởi động lại (Agent lưu ghi đè vào SQLite local và kiểm tra hết hạn ở mỗi lần đánh giá rules):

| Hành động (`action`) | Tác dụng |
|---|---|
| `bonus_minutes` | Cộng `minutes` vào hạn mức giờ hôm nay; `expires_at` = hết ngày hôm nay. |
| `lock` | Khóa máy tới `expires_at` (hiệu lực `minutes` phút). |
| `unlock` | Tạm ngưng các quy tắc giờ giấc tới `expires_at` (hiệu lực `minutes` phút). |
| `cancel` | Hủy ghi đè đang hiệu lực (không cần `minutes`/`expires_at`). |

Thứ tự thi hành trong Agent: ghi đè (khóa/mở) → giờ ngủ → khung giờ → giới hạn ngày. Các loại quy tắc khác (theo app, website/domain, giờ học, nghỉ bắt buộc, cảnh báo chống phá, mẫu sẵn) thuộc các đợt tiếp theo theo thứ tự đã chốt với phụ huynh.

#### 2.3.2. Khóa có độ trễ + khóa theo phiên (đợt 17/11/2026 — đã kiểm chứng trên máy thật tối 17/11; đồng bộ Immediate đợt 18/11, CI xanh run #167, chờ kiểm chứng lại)

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
- [x] Browser Extension cho Chrome/Edge (Manifest V3): chặn domain trong blocklist, chặn theo giờ, allowlist, giới hạn thời gian theo domain, SafeSearch, YouTube Restricted, báo cáo domain đã thăm (chỉ domain, không full URL). — Code đã xong (Sprint 2 đợt 2); extension đã cài trên Edge máy thật tối 17/11/2026, native messaging đã nối (popup báo đang bảo vệ + đồng bộ quy tắc), ID thật đã nướng vào installer từ v0.1.167 (không còn placeholder). Đã kiểm chứng chặn được trên máy thật sáng 18/11/2026 với extension 0.1.2 (khớp domain bằng requestDomains thay cho mẫu urlFilter cũ — mẫu cũ cài rule nhưng không khớp gì cả; YouTube hiện "You're offline", popup hiện đúng version + chẩn đoán rule). Trang chặn SafePC chưa hiện thay vỏ trang đệm (chỉ khác hiển thị, chức năng chặn đạt).
- [x] Blocklist/Allowlist do phụ huynh tự thêm (VD: chặn tiktok.com, cho phép hocmai.vn) + cho phép/chặn tạm thời. — Đã triển khai trên Dashboard + đồng bộ xuống file `domain_rules.json` (đã thấy file xuất bản đúng trên máy thật); thi hành trong trình duyệt chờ kiểm chứng extension.
- [x] Rule mẫu URL có đường dẫn (VD: `bing.com/videos` chỉ chặn link bắt đầu bằng phần đó, `bing.com/abc` không chặn) bên cạnh rule domain — chỉ mode block_domains đợt này, các mode khác từ chối mục đường dẫn lúc lưu (Agent chưa thi hành ở các mode đó). — Đã triển khai (đợt 4: Dashboard tách domain/đường dẫn, publisher xuất urlPatterns, extension 0.1.3 dựng rule regexFilter với ranh giới đường dẫn; CI xanh run #183, v0.1.183), chờ kiểm chứng trên máy thật.
- [ ] DNS filtering dự phòng: hướng dẫn đặt DNS gia đình trên máy con (VD: Cloudflare for Families 1.1.1.3) — ghi rõ đây là lớp bổ sung, không thay extension.
- [ ] **Ngoài phạm vi MVP:** lọc HTTPS toàn hệ thống bằng MITM proxy, chặn VPN, chặn mọi trình duyệt lạ. Các mục này cần đánh giá riêng ở giai đoạn 2 vì rủi ro bảo mật/pháp lý và bị antivirus chặn.

### 2.6. Yêu cầu từ con & thông báo
- [x] Con bấm "Xin thêm giờ" / "Xin mở app" từ màn hình khóa/tray, nhập lý do. — Đã triển khai đầu-cuối (Tray → IPC → outbox Service → RPC Supabase → Dashboard); yêu cầu xin giờ đã kiểm chứng lên server trên máy thật (log 17/11/2026). Yêu cầu xin mở app chưa có thông tin app trong yêu cầu nên duyệt mới chỉ đổi trạng thái.
- [x] Phụ huynh nhận yêu cầu trên Dashboard (Realtime), Duyệt/Từ chối + ghi chú. — Đã triển khai: duyệt xin thêm giờ gửi MỘT lệnh ghi đè mở khóa đúng N phút (đổi từ mẫu unlock + cộng giờ sau test máy thật 17/11: cộng giờ chỉ nới mức trần ngày nên không có tác dụng khi con đã dùng vượt mức trần); CI xanh run #167, chưa kiểm chứng lại trên máy thật. Ghi chú khi duyệt chưa có.
- [x] Agent nhận lệnh trong vòng < 30 giây khi online (polling 15s). — Đã triển khai và kiểm chứng (lệnh khóa/mở tới trong ~15s).
- [x] PIN thoát Tray (mã PIN riêng của phụ huynh, khác mật khẩu đăng nhập). — Đã triển khai: PIN đặt trên Dashboard (băm PBKDF2 tại trình duyệt), Service giữ hash và xác thực, sai 5 lần khóa 5 phút (đã thấy khóa nhập hoạt động trong log máy thật 17/11/2026); mã chỉ dùng một lần — nhập đúng và thoát xong thì mã tự gỡ khỏi server (RPC migration 8, đối sánh hash nên không xóa nhầm mã mới), đã kiểm chứng trên máy thật tối 17/11 (lần dùng thứ 2 bị từ chối); CI xanh run #167. Cần migration 8 áp lên Supabase thì việc gỡ trên server mới chạy; trước đó mã vẫn bị xóa khỏi bộ nhớ Service ngay khi dùng đúng và lệnh gỡ thử lại mỗi phút.
- [x] Xem thời gian còn lại thật trên Tray. — Đã triển khai: Tray hỏi Service qua IPC, Service trả quyết định mới nhất kèm số phút còn lại thật (giới hạn ngày/khung giờ/giờ ngủ); khi đang mở khóa tạm thời thì hiện rõ lý do thay vì "không giới hạn". CI xanh run #167, chưa kiểm chứng trên máy thật.

### 2.7. Báo cáo
- [x] Trạng thái thi hành realtime trên Dashboard: luật nào đang khóa máy/khóa app/khóa domain, chip "Đang thi hành", thời gian cập nhật. — Đã triển khai (snapshot enforcement, migration 6).
- [x] Hồ sơ theo con: Dashboard điều hướng Tổng quan / Hồ sơ / Yêu cầu; vào hồ sơ của một con có 3 tab Thiết bị / Quy tắc / Báo cáo chỉ hiện dữ liệu của con đó; tab Báo cáo tổng hợp tổng phút hôm nay, top 5 app, trạng thái máy, yêu cầu chờ duyệt, số quy tắc đang bật (chỉ dùng cột migration 1). — Đã triển khai (đợt sửa 17/11/2026, CI xanh run #159); đường dẫn cũ `/thiet-bi`, `/quy-tac` vẫn hoạt động. Thiết kế lại trang Quy tắc đợt 18/11 (quy tắc hiện hành lên đầu, nhóm theo con/danh mục với màu riêng, form tạo thu gọn accordion, đặt tên quy tắc, mẫu của phụ huynh lưu trên server + áp nhanh, mẫu Chỉ cho phép Edge; CI xanh run #170; migration 9 đã áp sáng 18/11/2026).
- [ ] Báo cáo ngày/tuần: tổng giờ, giờ theo app, số lần bị chặn, số lần xin thêm giờ. — Đã phê duyệt 17/11/2026 (xem §2.10).
- [ ] Xuất CSV (giai đoạn 1.5).

### 2.8. Tính năng nâng cao + giao diện chuyên nghiệp (đã phê duyệt 17/11/2026, thực hiện dần theo thứ tự)

- [ ] Trang Hôm nay thành tổng quan thật: thẻ trạng thái máy, giờ còn lại, biểu đồ giờ dùng trong ngày, top app/domain. Dữ liệu đã có sẵn, chỉ thiếu giao diện.
- [ ] Thông báo cho phụ huynh: email khi con xin thêm giờ, khi phát hiện can thiệp (đổi giờ, agent offline bất thường). Đẩy thông báo (push) để sau cùng app Android.
- [ ] Nhật ký hoạt động: ai đổi rule nào, khóa/mở lúc nào, duyệt yêu cầu nào. Bảng dữ liệu đã có, chưa có giao diện xem.
- [ ] Ngân hàng giờ: phụ huynh thưởng thêm giờ kèm lý do và lịch sử, con thấy được giờ thưởng của mình.
- [ ] Chặn theo danh mục domain (người lớn, cờ bạc, mạng xã hội) từ danh sách công khai, thay vì gõ từng domain.
- [ ] Mời phụ huynh thứ hai cùng quản lý gia đình. Cấu trúc dữ liệu đã hỗ trợ sẵn.
- [ ] Xuất dữ liệu và xóa toàn bộ dữ liệu của con (theo cam kết riêng tư ở `03-SECURITY.md` mục 5).
- [ ] Giao diện chuyên nghiệp: chuẩn hóa trạng thái rỗng/đang tải/lỗi/mất mạng; hướng dẫn lần đầu (tạo con, ghép nối, chọn mẫu quy tắc).
- [x] Xác thực 2 lớp (MFA) cho tài khoản phụ huynh (Supabase đã hỗ trợ sẵn). — Đã triển khai: TOTP tự nguyện qua Supabase Auth, bật/tắt ở mục Bảo mật tài khoản trên trang Hồ sơ (quét QR hoặc nhập secret, nhập mã 6 số để xác nhận; tắt phải nhập mã hiện tại). Đăng nhập khi đã bật thì sau mật khẩu phải nhập mã, sai mã không vào được; tài khoản chưa bật đăng nhập như cũ. Không migration, không đổi luồng đăng ký/xác minh email. Khôi phục khi mất thiết bị: xem `03-SECURITY.md` §2 (gỡ factor bởi quản trị dự án Supabase, không có mã khôi phục tự phục vụ). Chưa kiểm chứng đầu-cuối trên tài khoản thật.

Ranh giới giữ nguyên (quyết định 17/11/2026): không chụp màn hình, không ghi phím, không đọc nội dung chat hay file của con. Mục chụp màn hình opt-in ở §4 đã loại khỏi kế hoạch.

### 2.9. Cài đặt cho phụ huynh khác — không cần biết code (đã phê duyệt 17/11/2026)

Luồng mục tiêu, từ góc nhìn phụ huynh mới:

1. Vào website, đăng ký, tạo gia đình và hồ sơ con.
2. Bấm Thêm máy, tải 1 file cài đặt, chạy, nhập mã 6 số hiện trên web. Không còn bước PowerShell. Máy hiện Online là xong.
3. Bấm link cài extension trên Dashboard, 1 click từ cửa hàng của Chrome/Edge, tự nối với agent.
4. Chọn mẫu quy tắc Ngày học hoặc Cuối tuần, dùng ngay.
5. Sau này: tải app Android từ Play Store, đăng nhập cùng tài khoản, khóa/mở và duyệt yêu cầu.

Việc cần làm để đạt luồng này:

- [ ] Một bản triển khai dùng chung cho mọi gia đình (1 Supabase + 1 web), dữ liệu tách nhau bằng RLS. Người vận hành giữ khóa quản trị.
- [ ] Bộ cài có giao diện nhập mã ghép nối, thay cho lệnh PowerShell hiện tại.
- [ ] Extension đăng lên cửa hàng Chrome/Edge (Chrome phí đăng ký 5 USD một lần, Edge miễn phí) để có ID thật và tự cập nhật.
- [ ] Ký số bộ cài. Chưa có chứng chỉ thì Windows hiện cảnh báo SmartScreen, cần hướng dẫn phụ huynh bấm "vẫn chạy". Chứng chỉ ký số có phí, để sau cũng được.
- [ ] Agent tự cập nhật khi có bản mới, có kiểm tra hash.
- [ ] Trang hướng dẫn + chính sách riêng tư tiếng Việt, bắt buộc có trước khi mời gia đình ngoài dùng thử. Domain riêng là tùy chọn.

Quyết định còn mở (chưa chốt): ai vận hành bản dùng chung, có mua domain không, tài khoản đăng ký cửa hàng extension đứng tên ai, có mua chứng chỉ ký số không.

### 2.10. Báo cáo tuần (đã phê duyệt 17/11/2026)

Nội dung 7 mục:

1. Tổng quan: tổng giờ dùng tuần, tăng/giảm so với tuần trước, số ngày dùng máy.
2. Giờ dùng theo từng ngày, kèm đường giới hạn để thấy ngày nào vượt.
3. Top 5 app và top 5 domain, kèm giờ và tỉ lệ.
4. Quy tắc đã thi hành: số lần khóa theo từng loại, số lần chặn app/domain, số cảnh báo, số giờ nghỉ bắt buộc.
5. Yêu cầu xin thêm giờ: bao nhiêu yêu cầu, đã duyệt/từ chối/chờ bao nhiêu.
6. Cảnh báo: đổi giờ, agent khởi động lại, extension mất tín hiệu, offline bất thường.
7. Gợi ý tự động, ví dụ "Thứ 7 con dùng gấp đôi ngày thường" hay "YouTube chiếm 60% thời gian".

Hình thức đã chốt: trang Báo cáo ngay trên Dashboard với biểu đồ (thư viện Recharts, miễn phí, cùng công nghệ hiện tại) kèm email tóm tắt gửi mỗi tuần (Edge Function + Resend gói free). KHÔNG dùng Power BI làm hướng chính: cần gói trả phí, phải xuất dữ liệu trẻ em ra khỏi Supabase, phức tạp mà không hơn biểu đồ trong Dashboard. Xuất PDF để sau; in trực tiếp từ trang báo cáo là đủ. Toàn bộ dữ liệu đã có trong các bảng `app_usage`, `web_visits`, `audit_logs`, `requests`.

## 3. Giai đoạn 2: App Android cho phụ huynh

Tính năng nâng cao đã chốt ngày 17/11/2026 (xem §2.8) — sẵn sàng thảo luận Android khi bắt đầu, để khỏi làm lại.

- [ ] Đóng gói Dashboard PWA bằng Capacitor -> APK/AAB, thêm push notification (Supabase + FCM free).
- [ ] Hoặc xây Flutter app riêng nếu cần UX native tốt hơn — quyết định sau khi Dashboard Web ổn định.
- [ ] Tính năng: xem nhanh trạng thái máy (online/offline, còn bao nhiêu phút), khóa/mở nhanh, duyệt yêu cầu, đổi quy tắc cơ bản.

## 4. Giai đoạn 3: Nâng cao (chỉ làm khi giai đoạn 1-2 ổn định)

- [ ] ~~Chụp màn hình theo lịch (opt-in, phụ huynh bật rõ ràng, ảnh mã hóa, tự xóa sau 7 ngày)~~ — **ĐÃ LOẠI KHỎI KẾ HOẠCH ngày 17/11/2026** theo quyết định giữ ranh giới riêng tư (không chụp màn hình, không ghi phím, không đọc nội dung).
- [x] Giới hạn theo website (thời gian cho từng domain). — Đã triển khai (chế độ giới hạn thời gian theo domain của extension, Sprint 2 đợt 2); chờ kiểm chứng đầu-cuối cùng extension.
- [ ] Nhiều con/nhiều máy, quy tắc theo nhóm tuổi.
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
2. 🔨 Phụ huynh đặt giới hạn 30 phút, Agent khóa đúng giờ, con thấy lý do và xin thêm giờ được. — Khóa đúng giờ đã kiểm chứng (giờ ngủ + khóa ngay); xin thêm giờ đầu-cuối đang làm.
3. 🔨 Chặn 1 app (VD: game) và 1 domain (qua extension) hoạt động đúng, có log. — Chặn app đã triển khai, chờ kiểm chứng đầy đủ; chặn domain chờ extension được cài và kiểm chứng đầu-cuối.
4. ✅ Mất mạng, dữ liệu không mất, đồng bộ lại khi có mạng. — Thiết kế offline-first đã triển khai (SQLite + hàng đợi); kiểm chứng mất mạng có chủ đích chưa chạy đầy đủ.
5. 🔨 Con (Standard User) không tắt/gỡ được Agent nếu không có mã PIN phụ huynh. — Standard User không dừng được Service SYSTEM / không gỡ được (cần quyền Admin) — đã đúng theo thiết kế; mã PIN gỡ là việc Sprint 4, mã PIN thoát Tray đang làm.
6. ✅ Dashboard load nhanh, hiển thị đúng dữ liệu trong ngày. — Bản live hoạt động; đo hiệu năng chính thức chưa chạy.
