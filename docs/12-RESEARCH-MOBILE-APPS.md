# Nghiên cứu Hướng 2 — App điện thoại SafePC (Android + iPhone)

> Tài liệu nghiên cứu trong docs/, lập ngày 28/11/2026. CHỈ là tài liệu nghiên cứu — chưa phải quyết định triển khai.
> Yêu cầu của anh Tiến: tạo app SafePC trên Android và iPhone để khóa điện thoại của con; app cho bố mẹ quản lý cũng có trên Android + iPhone; có lựa chọn áp CHUNG chính sách bảo vệ như trên máy tính hoặc chính sách RIÊNG cho điện thoại (thời gian dùng, app cho phép, web cho phép...).
> Bối cảnh: SafePC hiện quản lý máy tính Windows (Agent C#.NET + extension trình duyệt), backend Supabase dùng chung, Dashboard React PWA trên Vercel. Mục tiêu <100 user, dịch vụ free là chính.
> Quy ước: dòng nào ghi **GIỚI HẠN CỨNG** là trần do nền tảng áp đặt — không có cách lập trình hợp lệ nào vượt qua, chỉ có cách đi vòng yếu hơn hoặc bỏ tính năng.

---

## 0. Tóm tắt 30 giây

| Câu hỏi | Trả lời ngắn |
|---|---|
| Android khóa điện thoại con được tới đâu? | Gần như ngang máy tính NẾU chấp nhận chế độ Device Owner (phải cài lúc máy mới/reset máy). Không reset thì làm được nhưng con có thể tắt quyền — chỉ là "khóa mềm". |
| iPhone khóa cứng từ xa được không? | **Không (GIỚI HẠN CỨNG).** Chỉ có bộ Screen Time API của Apple: app trên máy con tự áp lịch khóa app/downtime theo chính sách tải từ server. Không có lệnh "khóa máy ngay" kiểu MDM cho gia đình thường. |
| App phụ huynh trên điện thoại? | Dễ nhất: bọc Dashboard PWA hiện có bằng Capacitor → 1 codebase cho cả Android + iOS, có push native. |
| Chính sách chung/riêng? | Khả thi và nên làm ở mức **hồ sơ con**: một lõi chung (giờ ngủ, hạn mức, domain, từ khóa) + ghi đè theo nền tảng/thiết bị cho danh sách app (vì app không ánh xạ 1-1 giữa các hệ). |
| Chi phí tiền mặt bắt buộc | Google Play Console **25 USD một lần**; Apple Developer Program **99 USD/năm** (ngừng trả = app bị gỡ khỏi App Store). Đây là khoản ngoài "free" — cần anh quyết (mục 6). |
| Điều kiện ẩn hay quên | Build/ký app iOS **bắt buộc có macOS + Xcode** (GIỚI HẠN CỨNG của Apple). Hiện hệ thống làm việc của mình là Windows + VM Linux — phải tính phương án Mac (máy thật hoặc Mac cloud/CI) ngay từ đầu. |

---

## 1. Android — app cho con

### 1.1 Ba đường kỹ thuật

**(a) Device Owner / DPC (Device Policy Controller)**
- App của mình đăng ký làm "chủ thiết bị" qua `DevicePolicyManager`. Đây là cấp quyền cao nhất Android dành cho app quản lý, cũng là cơ chế các hệ MDM doanh nghiệp dùng.
- **GIỚI HẠN CỨNG về cài đặt:** Device Owner chỉ gán được khi máy ở trạng thái **mới xuất xưởng / vừa factory reset và chưa có tài khoản nào trên máy**. Các cách provision chính thức: quét QR ở màn hình Welcome (gõ 6 lần vào màn hình để mở trình quét QR), NFC, hoặc lệnh `adb shell dpm set-device-owner` qua USB khi chưa hoàn tất thiết lập (đường này hợp cho tự cài trong gia đình, không phải đường phân phối đại trà).
- Hệ quả thực tế: điện thoại con **đang dùng dở sẽ phải reset trắng** để bật chế độ này (mất dữ liệu trên máy nếu không sao lưu trước). Đây là câu hỏi quyết định số 2 ở mục 6.
- Sau khi là Device Owner: quyền sống còn qua cập nhật hệ điều hành (OTA), app không bị gỡ theo cách thường, chặn được cả factory reset từ menu Cài đặt (`DISALLOW_FACTORY_RESET`) — lưu ý con vẫn có thể reset từ Recovery Mode ngoài hệ điều hành; khi đó máy khởi động lại sẽ bắt đăng nhập tài khoản Google cũ (FRP) và mất Device Owner — tức reset lén = máy thành "cục gạch phải xin bố mẹ đăng nhập lại", vẫn là một lớp răn đe có thật.
- API chính: `lockNow()` (khóa màn hình ngay), `setPackagesSuspended()` (đóng băng app: icon xám, bấm vào hiện thông báo của quản trị viên — trải nghiệm tốt nhất cho chặn app), `setApplicationHidden()` (ẩn hẳn app), `setUninstallBlocked()` (chặn gỡ từng app, gồm chính app SafePC), các user restriction (cấm cài app ngoài Play, cấm gỡ tài khoản, cấm sửa VPN...), `setAlwaysOnVpnPackage()` (ép VPN lọc web luôn bật), cài/gỡ app lặng, đặt chính sách cập nhật hệ thống.

**(b) Device Admin (kế thừa) + UsageStats + Accessibility — "cài không cần reset"**
- Device Admin là cấp quyền cũ, **đã bị Google đánh dấu deprecated từ Android 9**; còn dùng được cho `lockNow()` nhưng **con vào Cài đặt tắt quyền admin được** (trừ khi kết hợp mẹo cản trở — các mẹo "chồng màn hình chặn tắt quyền" là vùng xám chính sách, dễ bị Play từ chối và bị Android vá dần).
- `UsageStatsManager` (quyền "quyền truy cập sử dụng" do người dùng bật tay trong Cài đặt): cho biết app nào đang ở foreground và tổng thời gian dùng → tự tính hạn mức ngày/khung giờ; khi vượt hạn thì chồng màn hình khóa (overlay) hoặc gọi `lockNow()`.
- `AccessibilityService`: phát hiện app bị cấm vừa mở để phản ứng tức thì, đọc được sự kiện cửa sổ. Đây là API nhạy cảm nhất về mặt duyệt store (xem 1.4).
- Điểm yếu chung của đường (b): mọi quyền đều **thu hồi được từ Cài đặt** (tắt Accessibility, tắt Usage Access, tắt Device Admin, buộc dừng app, gỡ app sau khi tắt admin). Thêm rủi ro thực tế: nhiều hãng (Xiaomi, Samsung, Oppo...) có trình quản lý pin hung hãn giết tiến trình nền → app phải xin thêm quyền "bỏ qua tối ưu pin" và tự khởi động, vẫn không đảm bảo 100%. Đường (b) phù hợp làm **mức cơ bản**: đủ với trẻ nhỏ/hợp tác, không chống được trẻ lớn cố tình phá.

**(c) App thường + VPN cục bộ (chỉ lọc web)**
- Dùng `VpnService` tạo VPN ngay trên máy: mọi lưu lượng đi qua app → lọc theo domain/DNS, chặn theo danh mục, ghi nhật ký domain (đúng mô hình dữ liệu web hiện có của SafePC). Play **cho phép rõ ràng** VpnService cho app có chức năng cốt lõi là parental control (xem 1.4).
- Không khóa máy được, không chặn app được (chỉ cắt được mạng của app qua cấu hình VPN theo-app — app vẫn mở và dùng offline bình thường).
- Con tắt VPN được trong Cài đặt (trừ khi Device Owner ép always-on). Chỉ **một VPN được chạy tại một thời điểm** — nhà nào dùng VPN khác sẽ xung đột.
- Đường (c) đứng một mình thì yếu, nhưng là **lớp lọc web bắt buộc phải có** trong cả (a) và (b), vì DevicePolicyManager không có API lọc web theo domain (chỉ có lọc URL trong Chrome quản lý ở mức doanh nghiệp rất hạn chế).

**Kiến trúc đề xuất cho Android:** một app con duy nhất, chạy **hai chế độ**: chế độ thường (b)+(c) khi cài nhanh không reset; chế độ tăng cường (a)+(c) nếu gia đình chấp nhận provision Device Owner. Cùng một mã nguồn, Device Owner chỉ mở thêm quyền — giống cách SafePC Windows có Tray (giao diện) + Service (thi hành).

### 1.2 Bảng khả năng Android theo từng đường

| Khả năng | (a) Device Owner | (b) Admin+UsageStats+Accessibility | (c) VPN cục bộ |
|---|---|---|---|
| Khóa máy ngay từ xa (lockNow) | ✅ Có, tức thì khi lệnh tới | ⚠️ Có qua Device Admin, nhưng con tắt admin được | ❌ Không |
| Hạn mức phút/ngày + tự khóa khi hết | ✅ Có (tự đếm + lockNow/suspend) | ✅ Có (UsageStats), dễ bị phá khi tắt quyền | ❌ Không |
| Khung giờ khóa (giờ ngủ/downtime) | ✅ Có | ✅ Có (mềm) | ❌ Không |
| Chặn app theo package | ✅ Cứng: suspend/hide, không mở được | ⚠️ Mềm: overlay/đá về home, có độ trễ và cách lách | ❌ Chỉ cắt mạng của app |
| Giới hạn từng app (phút/ngày/app) | ✅ Có | ✅ Có (UsageStats) | ❌ Không |
| Chặn gỡ cài đặt app SafePC | ✅ Có (`setUninstallBlocked` + restriction) | ❌ Không (tắt admin là gỡ được) | ❌ Không |
| Chặn cài app mới ngoài ý muốn | ✅ Có (chặn nguồn lạ; giới hạn Play theo chính sách) | ❌ Không | ❌ Không |
| Lọc web theo domain/danh mục | ✅ Qua VPN always-on đi kèm | ✅ Qua VPN đi kèm (tắt được) | ✅ Đây là chức năng chính |
| Báo cáo sử dụng (app nào, bao lâu) | ✅ Đầy đủ (UsageStats + sự kiện DPM) | ✅ Đầy đủ khi quyền còn bật | ⚠️ Chỉ lưu lượng web |
| Chống factory reset lén | ⚠️ Chặn trong hệ điều hành; reset qua Recovery vẫn được nhưng dính FRP | ❌ Không | ❌ Không |
| Điều kiện cài đặt | **Reset máy/máy mới** (GIỚI HẠN CỨNG) | Cài thường + bật 3–4 quyền tay | Cài thường + chấp nhận VPN |

### 1.3 Đối chiếu Google Family Link (chuẩn trải nghiệm)

Family Link là mốc so sánh vì miễn phí và do chính Google làm: hạn mức ngày + giờ ngủ (downtime), giới hạn/chặn từng app, lọc Chrome và Google Search, phê duyệt tải app trên Play, báo cáo hoạt động, định vị. Hai điểm SafePC Android **không sao chép được nguyên vẹn**:

1. Family Link gắn với **tài khoản Google của con** và tích hợp sẵn vào Play/Chrome ở tầng hệ thống — nó không cần factory reset vì Google tự provision "supervision" khi đăng nhập tài khoản con lúc thiết lập máy. App bên thứ ba không có đặc quyền đó: muốn cứng ngang phải qua Device Owner (reset máy), muốn nhẹ nhàng thì yếu hơn.
2. Family Link lọc được nội dung **bên trong** Play/Chrome (xếp hạng độ tuổi app, SafeSearch bắt buộc) — SafePC chỉ lọc ở tầng domain/app, không can thiệp được xếp hạng trong Play (trừ Device Owner đặt được một số chính sách Play hạn chế).

Ngược lại, SafePC thắng Family Link ở điểm anh Tiến đang xây: **một chính sách + một báo cáo chung cho cả máy tính Windows và điện thoại**, nhắn tin gia đình và ngân hàng giờ trong cùng hệ — Family Link không quản lý được máy tính Windows.

### 1.4 Chính sách Google Play cho nhóm app này (đã kiểm chứng)

- **Accessibility API:** Play yêu cầu khai báo (declaration) trong Play Console + công bố nổi bật trong app + xin đồng ý rõ ràng. Điểm quan trọng: chính sách ghi rõ Accessibility **không được dùng để ngăn gỡ app "trừ khi được phụ huynh/người giám hộ ủy quyền qua app parental control"** — tức parental control là ngoại lệ được phép một cách tường minh. Không được đặt cờ `isAccessibilityTool=true` (cờ đó chỉ dành cho app hỗ trợ người khuyết tật). *(Nguồn: Play Console Help — "Permissions and APIs that Access Sensitive Information", kiểm chứng 28/11/2026.)*
- **VpnService:** Play chỉ cho phép app có chức năng cốt lõi cần VPN, và liệt kê tường minh **parental control, app usage tracking** là trường hợp hợp lệ. *(Cùng nguồn trên.)*
- **App theo dõi/giám sát:** chính sách Monitoring yêu cầu app **không được tự trình bày như giải pháp theo dõi bí mật**, phải có **thông báo thường trực (persistent notification)** và icon nhận diện rõ ràng khi đang chạy. SafePC Windows vốn đã minh bạch (Tray icon + thông báo) nên hợp sẵn triết lý này — app con trên Android cũng phải hiện diện rõ, không "ẩn mình".
- **Families policy:** nếu khai đối tượng người dùng có trẻ em, Play áp thêm: không quảng cáo nhắm đối tượng, không thu AAID/IMEI/vị trí chính xác của trẻ, cổng phụ huynh (parental gate) cho liên kết ngoài, tuân thủ COPPA/GDPR. App con SafePC nên được khai báo là **công cụ dành cho phụ huynh** (người vận hành là bố mẹ) — nhưng khai báo phải trung thực; đây là điểm cần chốt khi nộp store (mục 6, rủi ro duyệt).
- **Tài khoản nhà phát triển mới (cá nhân):** từ 13/11/2023, tài khoản cá nhân mới phải chạy **closed testing với ≥12 tester trong 14 ngày liên tục** mới được xin phát hành production. Với quy mô gia đình dùng thật thì đây là thủ tục chờ 2 tuần, không phải rào cản tiền — nhưng phải tính vào lịch. *(Nguồn: Play Console Help — App testing requirements.)*
- **Android developer verification:** Google đang triển khai xác minh danh tính nhà phát triển cả cho app phân phối **ngoài** Play (bắt đầu ở một số nước từ 30/09/2026, mở rộng toàn cầu 2027) — phân phối APK trực tiếp để né store sẽ ngày càng khó; nên đi đường Play chính thức ngay từ đầu. *(Nguồn: tổng hợp chính sách Android, kiểm chứng 28/11/2026.)*


---

## 2. iPhone — app cho con: nói thẳng về giới hạn của Apple

### 2.1 Nguyên tắc nền tảng

**GIỚI HẠN CỨNG số 1:** iOS không cho app bên thứ ba khóa cứng thiết bị, chặn gỡ app tùy ý, hay đọc danh sách app đã cài. Mọi khả năng quản lý đều phải đi qua đúng một cửa Apple mở cho parental control: bộ **Screen Time API** gồm 3 framework:

| Framework | Vai trò |
|---|---|
| **FamilyControls** | Xin ủy quyền (`AuthorizationCenter`) và cho chọn app/danh mục/web qua `FamilyActivityPicker` — trả về **token mờ (opaque token)**, app không biết đó là app gì |
| **DeviceActivity** | Đặt lịch theo dõi (khung giờ lặp lại) và ngưỡng dùng (dùng đủ X phút thì phát sự kiện); một app extension (`DeviceActivityMonitor`) nhận sự kiện kể cả khi app chính không chạy |
| **ManagedSettings** | Áp thi hành: `ManagedSettingsStore` chứa shield (che app), lọc web, cấm gỡ app, cấm cài app... Hệ điều hành tự thi hành, app chết vẫn còn hiệu lực |

**GIỚI HẠN CỨNG số 2 — quyền riêng tư theo thiết kế của Apple:** token từ FamilyActivityPicker là mờ tuyệt đối. App (và do đó server SafePC, và bố mẹ) **không bao giờ biết con đã cài app gì, tên app là gì** qua kênh này. Giao diện chọn app là của Apple vẽ (hiện icon + tên cho người chọn xem tại chỗ), nhưng dữ liệu trả về chỉ là token. Hệ quả trực tiếp:

- Không có "danh sách app theo tên" đồng bộ lên Dashboard như Windows/Android.
- **Báo cáo sử dụng chi tiết không xuất ra được:** `DeviceActivityReport` là một extension bị nhốt sandbox — nó vẽ biểu đồ ngay trên máy con, **không có mạng, dữ liệu không được mang ra ngoài**. App chính chỉ biết các sự kiện do chính nó định nghĩa trước (vd "đã đạt ngưỡng 2 giờ của nhóm đã chọn") chứ không truy vấn được lịch sử dùng app. → Báo cáo tuần phía iOS sẽ **nghèo hơn hẳn** Windows/Android: tối đa là số lần chạm ngưỡng/khung giờ đã khóa, không có bảng "app nào dùng bao lâu". (Từ iOS 26.4, riêng khu vực EU có thêm chế độ data-access cho thấy bundle id/domain thật — phụ thuộc luật EU, chỉ 1 app/máy được cấp, không phải nền để thiết kế sản phẩm cho gia đình ở Việt Nam.)

**GIỚI HẠN CỨNG số 3 — điều kiện phân phối:** muốn phát hành (kể cả TestFlight) phải được Apple **cấp entitlement `com.apple.developer.family-controls` (bản Distribution)** qua đơn xin riêng trên trang Apple Developer, **từng bundle ID một** (app chính và từng extension đều phải xin), thời gian duyệt thường vài ngày đến vài tuần và có thể bị từ chối nếu giải trình use case không thuyết phục. Bản Development thì dùng ngay được để tự build/test trên máy thật. *(Nguồn: tài liệu hướng dẫn Family Controls entitlement + trang yêu cầu của Apple, kiểm chứng 28/11/2026.)*

**GIỚI HẠN CỨNG số 4 — môi trường phát triển:** build và test Screen Time API **bắt buộc Mac + Xcode + iPhone thật** (Simulator không hỗ trợ). Không có đường vòng hợp lệ.

### 2.2 Mô hình khả thi trên iOS

Không có "điều khiển từ xa" kiểu MDM cho gia đình thường (xem 2.4). Mô hình đúng là:

1. **Ủy quyền một lần trên máy con:** app SafePC con cài trên iPhone của con; phụ huynh phê duyệt `AuthorizationCenter.requestAuthorization(for: .child)` ngay trên máy con bằng Apple ID của phụ huynh (yêu cầu con nằm trong nhóm **Family Sharing** của phụ huynh). Chế độ `.child` này có thêm một lợi ích lớn: **app SafePC không bị xóa nếu không có thông tin đăng nhập của phụ huynh**, và việc đăng xuất iCloud bị chặn — đây là lớp chống gỡ duy nhất Apple cho phép, và nó khá chắc.
2. **Chọn app cần quản lý tại máy con:** phụ huynh (hoặc con, dưới sự có mặt của phụ huynh) mở FamilyActivityPicker trong app để chọn app/danh mục bị giới hạn. Token lưu **ngay trên máy con** (App Group dùng chung giữa app và extension). Server chỉ lưu metadata dạng "đã cấu hình nhóm MXH: có" — không lưu token (token vô dụng ngoài máy đó, và đẩy token lên server cũng không giúp điều khiển thêm được gì).
3. **Chính sách từ Supabase:** app con tải cùng bộ luật SafePC như máy tính (khung giờ, hạn mức, domain) → dịch sang DeviceActivity schedule + ManagedSettings shield trên máy. Phụ huynh sửa luật trên Dashboard như bình thường; app con tự áp khi đồng bộ (khi mở app, qua push APNs đánh thức, và các mốc schedule do hệ điều hành tự chạy qua extension — kể cả lúc app không mở).
4. **"Khóa ngay" thay bằng "shield toàn bộ":** khi phụ huynh bấm khóa, server gửi push; app con (hoặc lần đồng bộ kế) áp shield `.all(except:)` cho mọi app trừ danh sách luôn-được-phép (điện thoại, SafePC, app học tập được miễn trừ). Trải nghiệm gần giống khóa máy nhưng **không phải khóa máy**: màn hình chính, cuộc gọi, thông báo vẫn sống; mở app bị shield sẽ thấy màn hình chặn tùy biến được (ShieldConfiguration — ghi được dòng chữ kiểu "Máy đang bị khóa bởi SafePC, bấm xin thêm giờ" và nút gửi yêu cầu). Độ trễ phụ thuộc push — không tức thì tuyệt đối như lockNow của Android/Windows.

### 2.3 iOS làm được / không làm được — đặt cạnh Android

| Khả năng | Android Device Owner | Android chế độ thường | iPhone (Screen Time API) |
|---|---|---|---|
| Khóa máy ngay từ xa | ✅ lockNow thật | ⚠️ Có nhưng phá được | ❌ **GIỚI HẠN CỨNG** — chỉ shield toàn bộ app qua push, có độ trễ |
| Khung giờ khóa (downtime) | ✅ | ✅ mềm | ✅ Rất tốt — DeviceActivity schedule + shield, hệ điều hành tự thi hành |
| Hạn mức phút/ngày theo nhóm/app đã chọn | ✅ Từng package | ✅ Từng package | ✅ Theo token/danh mục đã chọn (ngưỡng DeviceActivity) |
| Chặn app cụ thể theo tên | ✅ Theo package, server biết tên | ✅ Theo package | ❌ **GIỚI HẠN CỨNG** — chỉ theo token mờ; server/Dashboard không biết tên app; phải chọn tại máy con |
| Chặn theo danh mục app | ⚠️ Tự phân loại theo package | ⚠️ Tự phân loại | ✅ Danh mục có sẵn của Apple (Social, Games, Entertainment...) qua picker |
| Lọc web theo domain | ✅ VPN/DNS toàn hệ | ✅ VPN (tắt được) | ⚠️ `webContent.blockedByFilter`: chặn domain cụ thể + lọc nội dung người lớn tự động của Apple; áp cho Safari/WebKit — trình duyệt bên thứ ba có nhân riêng vẫn có thể lọt, phải shield luôn app trình duyệt đó nếu muốn chắc |
| Chặn gỡ app SafePC | ✅ | ❌ | ✅ Gián tiếp: chế độ `.child` của Family Sharing khiến app không bị xóa thiếu thông tin đăng nhập phụ huynh; thêm `denyAppRemoval` trong ManagedSettings chặn gỡ app nói chung khi đang áp |
| Báo cáo sử dụng chi tiết lên server | ✅ | ✅ | ❌ **GIỚI HẠN CỨNG** — report extension bị nhốt sandbox, không xuất dữ liệu; chỉ có sự kiện ngưỡng tự định nghĩa |
| Chặn cài app mới | ✅ | ❌ | ⚠️ ManagedSettings có cấm cài app/cấm App Store theo độ tuổi, nhưng là công tắc toàn cục, không có duyệt từng app từ xa |
| Điều kiện bắt đầu | Reset máy | Cài thường | Family Sharing + phê duyệt trên máy con + entitlement Apple cấp cho nhà phát triển |

### 2.4 Vì sao không dùng MDM cho iPhone gia đình

MDM (Mobile Device Management) đúng là khóa được iPhone cứng (supervised mode, khóa từ xa thật, lọc web toàn hệ). Nhưng: máy phải được "supervised" qua Apple Configurator/Automated Device Enrollment (vốn cho tổ chức sở hữu máy), cần máy chủ MDM + chứng chỉ APNs MDM riêng, và App Store cấm dùng MDM để quản lý thiết bị người tiêu dùng không thuộc tổ chức của nhà phát triển (các app parental control dùng hồ sơ cấu hình/MDM lách luật đã bị Apple gỡ hàng loạt từ 2019). Với quy mô gia đình <100 user, MDM là sai công cụ — chỉ nêu để loại trừ.

---

## 3. App phụ huynh (Android + iPhone)

### 3.1 Phương án: Capacitor bọc Dashboard hiện có — khuyến nghị

Dashboard SafePC vốn là React PWA đã chạy production (đã có service worker, đã có Web Push qua VAPID — migration 30). Bọc bằng **Capacitor** là đường ngắn nhất:

- **Tái dùng gần như 100%:** cùng codebase React; Capacitor thêm lớp native mỏng: push notification native, deep link, lưu token an toàn (Keychain/Keystore), sinh trắc học mở khóa app (nâng cấp trải nghiệm hơn PWA).
- **Push:** Android qua **FCM**, iOS qua **APNs** (có thể đi qua FCM làm cổng chung). Backend push hiện tại (bảng `push_subscriptions` đã có cột `platform` = 'web'/'android') mở rộng thêm 'ios' + lưu FCM token là dùng tiếp được — Edge Function gửi push cần thêm nhánh FCM/APNs bên cạnh Web Push hiện có.
- **Không cần** Family Controls entitlement cho app phụ huynh (nó chỉ là giao diện quản lý + API Supabase).
- Rủi ro duyệt store cần biết: Apple có guideline **4.2 (Minimum Functionality)** — app chỉ là WebView bọc website trơn có thể bị từ chối. Giảm rủi ro bằng các phần native thật: push native, đăng nhập sinh trắc học, điều hướng native, xử lý offline. App phụ huynh SafePC có đủ chất liệu để qua (nó là console điều khiển có push + lệnh thời gian thực), nhưng phải ý thức khi nộp.
- Google Play phía app phụ huynh: không vướng Accessibility/VPN/Families (khai đối tượng người lớn), duyệt nhẹ nhàng nhất trong 3 app.

### 3.2 So sánh nhanh với viết riêng / giữ PWA

| Phương án | Công sức | Trải nghiệm | Khi nào chọn |
|---|---|---|---|
| Giữ PWA (hiện tại) | 0 | iOS phải "Add to Home Screen" mới có push; không có mặt trên store | Đang dùng tạm trong lúc chờ các giai đoạn sau |
| **Capacitor bọc Dashboard** | Nhỏ–vừa | Có mặt trên store, push native FCM/APNs, sinh trắc học | **Khuyến nghị** — giá trị/công sức tốt nhất |
| Viết native riêng (Kotlin/Swift hoặc Flutter/React Native viết lại UI) | Lớn | Tốt nhất về hiệu năng | Chỉ khi Dashboard có tính năng native sâu — hiện chưa có lý do |

Lưu ý: app **con trên iPhone không thể dùng Capacitor** cho phần thi hành (FamilyControls/DeviceActivity là Swift native + app extension) — app con iOS là dự án Swift riêng, chỉ chia sẻ được API Supabase và mô hình dữ liệu, không chia sẻ code giao diện thi hành. App con Android thì viết Kotlin native (DevicePolicyManager không qua được lớp web).

### 3.3 Chi phí tài khoản nhà phát triển (đã kiểm chứng 28/11/2026)

| Khoản | Số tiền | Tính chất | Nguồn kiểm chứng |
|---|---|---|---|
| Google Play Console | **25 USD, một lần duy nhất** | Không gia hạn, không phí theo app. Tài khoản cá nhân mới phải qua closed testing 12 tester × 14 ngày trước production | Play Console Help (support.google.com) |
| Apple Developer Program | **99 USD / năm** | Phải duy trì liên tục; **hết hạn là app bị gỡ khỏi App Store** và không nộp bản cập nhật được. Miễn phí chỉ cho tổ chức phi lợi nhuận/giáo dục/chính phủ đủ điều kiện — cá nhân không thuộc diện miễn | developer.apple.com/programs (trang Become a member) |

Tổng năm đầu cho cả 3 app (phụ huynh Android + phụ huynh iPhone + con Android/iPhone dùng chung tài khoản): **124 USD**, các năm sau **99 USD/năm**. Đây là chi phí cố định duy nhất của hướng mobile — cần anh Tiến chấp nhận rõ vì nó nằm ngoài nguyên tắc "dịch vụ free" từ đầu dự án. Ngoài tiền: cần **máy Mac hoặc Mac cloud** để build iOS (mục 2.1, giới hạn cứng số 4) — GitHub Actions có runner macOS (tốn phút CI gấp nhiều lần Linux/Windows và hạn mức free của repo private có giới hạn), hoặc dịch vụ như Codemagic/MacinCloud có gói free giới hạn — đủ cho quy mô này nhưng phải thử sớm.

---

## 4. Mô hình chính sách CHUNG / RIÊNG (phần anh Tiến nhấn mạnh)

### 4.1 Hiện trạng dữ liệu (đối chiếu thật trong cây mã nguồn)

- Bảng `rules`: gắn theo **hồ sơ con** (`child_id`), KHÔNG gắn thiết bị. Cột `type` (daily_limit, bedtime, time_window, app, website...) + `config jsonb` chứa mode chi tiết (block_apps, block_domains + danh mục, focus, nghỉ bắt buộc, block_search_keywords...), `enabled`. Tức hiện tại luật đã là "theo con" — mọi máy tính của con đều nhận cùng bộ luật khi đồng bộ.
- Bảng `devices`: `hostname`, `os_version` (text tự do, đang chứa kiểu 'Windows 10 22H2'), `agent_version`, `child_id` + bảng nối Sprint 5 `device_child_accounts` (một máy ↔ nhiều con theo tài khoản đăng nhập). **Chưa có cột platform** — thiết bị hiện mặc định hiểu là Windows.
- `commands` đã có sẵn các lệnh theo thiết bị (`lock_now`, `unlock`, `temporary_override`...) — dùng lại cho mobile, chỉ khác kênh đánh thức (push thay vì poll).
- `app_usage.app_name` là text tự do (đang lưu tên app Windows); `web_visits.domain` là domain thuần — cả hai dùng lại được cho Android; iOS bị giới hạn ở tầng thu thập (mục 2.1) chứ không phải tầng lưu.

### 4.2 Nguyên tắc thiết kế đề xuất

**Một lõi chung theo hồ sơ con + hai lớp ghi đè.** Đừng tách thành "bộ luật máy tính" và "bộ luật điện thoại" độc lập hoàn toàn — phụ huynh sẽ phải sửa hai nơi và hai bộ sẽ trôi lệch nhau. Thay vào đó:

- **Lớp 1 — Lõi chung (mặc định, theo hồ sơ con):** những luật có ngữ nghĩa giống hệt mọi nền tảng: khung giờ ngủ, hạn mức phút/ngày (tổng), giờ học tập trung, nghỉ bắt buộc, chặn domain + danh mục domain, từ khóa tìm kiếm bị cấm, ngân hàng giờ, mở khóa tạm thời. Đây là phần lớn luật hiện có — giữ nguyên bảng `rules` như hiện tại, hiểu là "áp cho mọi thiết bị của con".
- **Lớp 2 — Ghi đè theo nền tảng:** cùng một luật lõi nhưng cho phép chỉnh tham số riêng theo platform khi cần (vd hạn mức điện thoại 120 phút nhưng máy tính 180 phút). Hiện thực bằng cột `rules.platform` nullable: `NULL` = mọi nền tảng (luật lõi), có giá trị ('windows'/'android'/'ios') = bản ghi đè cho nền tảng đó, app lấy bản ghi đè nếu có, không thì lấy bản lõi.
- **Lớp 3 — Ghi đè theo thiết bị (ngoại lệ):** cột `rules.device_id` nullable cho trường hợp đặc biệt (máy học ở trường khác máy ở nhà). Chỉ nên mở khi thật cần để giao diện không rối.

Trên Dashboard: mỗi thẻ luật thêm một hàng chọn phạm vi **"Áp dụng: Tất cả thiết bị ▾"** (Tất cả / Chỉ máy tính / Chỉ điện thoại / Thiết bị cụ thể...) — đúng tinh thần "áp chung hay riêng" anh yêu cầu, nhưng đặt ở **mức từng luật** thay vì một công tắc toàn cục, vì thực tế luôn có luật muốn chung (giờ ngủ) và luật muốn riêng (chặn game trên điện thoại nhưng không trên máy tính học lập trình).

### 4.3 Bài toán danh sách app — phần không ánh xạ 1-1 được

| Nền tảng | Định danh app | Server biết tên app không |
|---|---|---|
| Windows | Tên exe (chrome.exe) | Có |
| Android | Package name (com.android.chrome) | Có |
| iOS | Token mờ của Apple | **Không bao giờ** |

Giải pháp đề xuất — **"nhóm app theo ý định" (app groups)**:

- Tạo khái niệm nhóm do phụ huynh định nghĩa hoặc có sẵn: *Trình duyệt, Mạng xã hội, Nhắn tin, Game, Video/Phim, Học tập...* Luật chặn/giới hạn tham chiếu **nhóm**, không tham chiếu app lẻ ở lớp lõi.
- Mỗi nhóm có danh sách thành viên **theo từng nền tảng**: Windows = danh sách exe, Android = danh sách package (có sẵn bộ gợi ý mặc định cho các app phổ biến ở Việt Nam: Zalo, TikTok, Facebook, YouTube, Chrome... để phụ huynh khỏi tự tra package name).
- **iOS là ngoại lệ có chủ đích:** nhóm trên iOS tương ứng gần nhất với **danh mục của Apple** trong FamilyActivityPicker (Social, Games, Entertainment, Education...) cộng với các token app lẻ phụ huynh chọn tay trên máy con. Tức "nhóm Mạng xã hội" trên iOS = danh mục Social của Apple — bao phủ tương đương về ý định dù không trùng tuyệt đối từng app. Giao diện phải ghi rõ điều này ("trên iPhone, nhóm được chọn ngay trên máy của con qua bộ chọn của Apple").
- Hai bảng mới là đủ: `app_groups` (id, family_id, child_id, name, icon/color) và `app_group_members` (group_id, platform, identifier) — identifier là exe/package; hàng iOS không tồn tại (token ở trên máy con). Luật app hiện tại (`config` chứa danh sách exe) chuyển dần sang tham chiếu group_id, giữ tương thích ngược bằng cách coi danh sách exe cũ là "nhóm riêng của Windows".

### 4.4 Đồng bộ qua Supabase hiện có — cần thêm gì

| Hạng mục | Thêm/sửa | Độ lớn |
|---|---|---|
| `devices.platform` | Cột mới: 'windows' / 'android' / 'ios' (+ `os_version` dùng lại, `agent_version` dùng lại) | Nhỏ |
| Ghép nối thiết bị mobile | Dùng lại pairing code 6 số + `device_tokens` (lưu hash): app con nhập mã hiện trên Dashboard thay cho installer Windows | Nhỏ |
| `rules.platform`, `rules.device_id` | 2 cột nullable + cập nhật các RPC fetch rules theo thiết bị (lọc: luật lõi OR đúng platform OR đúng device) | Vừa |
| `app_groups`, `app_group_members` | 2 bảng mới + RLS theo family như các bảng khác | Vừa |
| Kênh lệnh cho mobile | Dùng lại `commands`; đánh thức bằng push FCM/APNs (hạ tầng push đã có từ migration 30 — mở rộng platform 'ios' và token FCM) thay cho poll 1 phút của Windows | Vừa |
| Báo cáo | `app_usage`/`web_visits` dùng lại; Android ghi package vào `app_name` + thêm cột `package_name` nếu muốn tách bạch; iOS chỉ ghi được sự kiện tổng hợp (đạt ngưỡng, vào/ra downtime) — cần chấp nhận báo cáo iOS là một loại bản ghi riêng, không ép vào khuôn app_usage | Vừa |
| RPC/API cho mobile | Bộ RPC "device API" hiện tại (auth bằng device token) dùng lại được phần lớn: fetch rules, push usage, heartbeat, xin thêm giờ, nhắn tin. App con mobile đăng nhập bằng đúng device token như Agent Windows | Nhỏ–vừa |

Điểm đáng mừng: **không cần backend mới**. Supabase + RLS theo family_id + device token là đủ cho cả 3 nền tảng; phần việc lớn nằm ở 2 app con native, không nằm ở server.

---

## 5. Lộ trình đề xuất

Nguyên tắc sắp xếp: (1) việc mở khóa các việc sau thì làm trước dù vô hình (đơn xin entitlement Apple, tài khoản store); (2) giá trị thấy được sớm với công sức nhỏ trước; (3) phần cứng nhất (Device Owner, iOS native) để sau khi khung chính sách đa nền tảng đã ổn.

| Giai đoạn | Nội dung | Độ lớn | Điều kiện tiên quyết | Rủi ro duyệt store |
|---|---|---|---|---|
| **GĐ 0 — Chuẩn bị** (làm ngay, song song mọi thứ) | Mở tài khoản Play Console (25 USD) + Apple Developer (99 USD/năm) nếu anh duyệt chi phí; **nộp đơn Family Controls (Distribution) entitlement cho bundle id app con iOS**; chốt phương án Mac build (CI macOS/Mac cloud/máy thật); thêm `devices.platform` + thiết kế app groups vào roadmap | Nhỏ (chủ yếu là chờ duyệt) | Anh quyết chi phí (câu hỏi 1) | Entitlement Apple có thể chậm vài tuần — nộp càng sớm càng tốt, chưa cần code |
| **GĐ 1 — App phụ huynh Capacitor** (Android + iOS) | Bọc Dashboard, push FCM/APNs, sinh trắc học; phát hành cả 2 store | Vừa | GĐ 0 (tài khoản store) | Thấp ở Play; **trung bình ở Apple (guideline 4.2)** — cần phần native thật |
| **GĐ 2 — Chính sách đa nền tảng trên Dashboard** | `rules.platform/device_id`, app groups + members, UI chọn phạm vi áp dụng, RPC fetch theo platform. Máy tính Windows dùng ngay được (scope "chỉ máy tính" có ý nghĩa từ đây) | Vừa | Không | Không (web) |
| **GĐ 3 — App con Android chế độ thường** | Kotlin: UsageStats + Device Admin lockNow + overlay hết giờ + VPN lọc domain/danh mục + pairing + đồng bộ luật + báo cáo + xin thêm giờ/nhắn tin. Cài không cần reset | Lớn | GĐ 2; Play Console + khai báo Accessibility/VPN | **Trung bình–cao:** khai báo Accessibility là điểm bị soi nhất; phải có video demo + mô tả rõ use case parental control |
| **GĐ 4 — Android Device Owner (chế độ tăng cường)** | Cùng app GĐ 3, thêm DPC đầy đủ: provision QR, suspend/hide app, chống gỡ, always-on VPN, chặn cài app. Tài liệu hướng dẫn phụ huynh reset + provision máy con | Vừa (nền GĐ 3 đã có) | GĐ 3; gia đình chấp nhận reset máy (câu hỏi 2) | Thấp hơn GĐ 3 (Device Policy là use case được Play công nhận cho DPC), nhưng phải khai báo đúng trong Console |
| **GĐ 5 — App con iPhone (Swift native)** | FamilyControls + DeviceActivity + ManagedSettings: downtime, giới hạn theo danh mục/token, shield toàn bộ khi khóa, lọc web có sẵn; đồng bộ luật lõi từ Supabase; báo cáo dạng sự kiện | Lớn | GĐ 0 (entitlement đã duyệt) + GĐ 2 + có Mac build | **Cao:** entitlement là cổng riêng trước cả review thường; review App Store cho app parental control kỹ hơn trung bình |

**Ưu tiên Android-con trước hay phụ huynh-app trước?** Đề xuất **phụ huynh-app (GĐ 1) trước**, vì: (a) nó biến push native thành hiện thực cho cả hệ hiện tại (kể cả quản lý máy tính — giải quyết triệt để nỗi đau "con xin mở Zalo 4 lần mà bố không biết" ở kênh mobile); (b) rủi ro thấp, thời gian ra sản phẩm ngắn, kiểm chứng được toàn bộ đường store + chi phí trước khi đầu tư lớn; (c) GĐ 2 (chính sách đa nền tảng) đi ngay sau để khi app con Android ra đời (GĐ 3) nó có ngay khung luật chung/riêng để dùng. Nếu anh Tiến ưu tiên "khóa được điện thoại con càng sớm càng tốt" hơn tiện ích cho phụ huynh, có thể hoán đổi GĐ 1 ↔ GĐ 3 — nhưng GĐ 0 và GĐ 2 không nên hoán đổi.

Một lựa chọn trung gian đáng cân nhắc ở GĐ 3: phát hành nội bộ gia đình qua **APK trực tiếp / Play closed track** trước (không cần production review đầy đủ) để dùng thật trong nhà và kiểm chứng, rồi mới nộp production — giảm rủi ro bị từ chối khi chưa có kinh nghiệm duyệt Accessibility.

---

## 6. Kết luận + câu hỏi cần anh Tiến quyết

### Kết luận

1. **Android làm được gần trọn vẹn như máy tính** — với cái giá là Device Owner phải cài lúc máy trắng. Chế độ cài thường vẫn hữu ích nhưng phải nói thật với phụ huynh là "khóa mềm".
2. **iPhone là một sản phẩm rút gọn một cách trung thực**: downtime + giới hạn theo danh mục/app-đã-chọn + lọc web cơ bản thì tốt ngang Screen Time gốc; nhưng khóa cứng từ xa, danh sách app theo tên và báo cáo chi tiết là **giới hạn cứng của Apple** — không app parental control hợp lệ nào trên App Store vượt qua được (kể cả Qustodio/Bark bản iOS đều rút gọn tương tự; bản nào quảng cáo làm được hơn là đang dùng MDM/hồ sơ lách — đường Apple đã cấm).
3. **Chính sách chung/riêng khả thi** với thiết kế "lõi chung theo hồ sơ con + ghi đè theo platform/thiết bị + nhóm app theo ý định" — tận dụng được bảng `rules` hiện tại, backend Supabase không phải làm lại.
4. **Chi phí tiền mặt duy nhất nhưng bắt buộc:** 25 USD một lần (Google) + 99 USD/năm (Apple) + bài toán máy Mac để build iOS.

### Câu hỏi cần anh quyết

1. **Chi phí store:** chấp nhận 25 USD một lần cho Google Play Console và **99 USD/năm cho Apple Developer Program** (ngừng trả là app iOS bị gỡ khỏi App Store) không? Nếu không chấp nhận phía Apple: app phụ huynh iPhone quay về PWA, và app con iPhone **không làm được** (không có đường phân phối hợp lệ nào khác cho Family Controls).
2. **Device Owner trên Android:** điện thoại của con có chấp nhận **factory reset để provision Device Owner** (khóa cứng, chống gỡ) không — hay ưu tiên cài không reset và chấp nhận con có thể tắt quyền/gỡ app (khóa mềm)? (Có thể chọn cả hai: mặc định mềm, hướng dẫn tăng cường cho nhà nào muốn.)
3. **iOS rút gọn:** chấp nhận bộ khả năng iPhone như bảng 2.3 không — đặc biệt 3 điểm: không khóa cứng từ xa (chỉ shield app qua push), không thấy tên app/báo cáo chi tiết, và phải dùng Family Sharing + chọn app ngay trên máy con?
4. **Máy Mac build iOS:** nhà mình có sẵn máy Mac nào không? Nếu không, anh chọn phương án nào: dùng CI macOS/Mac cloud (có giới hạn free, cấu hình phức tạp hơn) hay tính mua Mac mini cũ làm máy build? (Không có Mac ở bất kỳ dạng nào = không có app iOS, kể cả app phụ huynh bản store.)
5. **Thiết bị thật của các con:** mỗi con đang dùng điện thoại gì (Android hãng nào/phiên bản Android mấy, hay iPhone đời nào/iOS mấy)? Thông tin này quyết định thứ tự làm trước (hãng Android có Knox/quản lý pin riêng; iPhone cần iOS 16+ cho Family Controls đầy đủ) — và quyết định GĐ 3 hay GĐ 5 nên ưu tiên.
6. **Thứ tự ưu tiên:** đồng ý thứ tự đề xuất (phụ huynh-app → chính sách đa nền tảng → Android con → Device Owner → iPhone con) hay muốn "khóa điện thoại con Android" lên trước app phụ huynh?

---

## Phụ lục — nguồn kiểm chứng (truy cập 28/11/2026)

- Apple Developer — Become a member: Apple Developer Program 99 USD/năm. `developer.apple.com/programs/enroll/`
- Play Console Help — Get started with Play Console: phí đăng ký 25 USD một lần. `support.google.com/googleplay/android-developer/answer/6112435`
- Play Console Help — Permissions and APIs that Access Sensitive Information: chính sách Accessibility API (ngoại lệ parental control), VpnService (parental control là use case hợp lệ). `support.google.com/googleplay/android-developer/answer/16558241` và `answer/16324062`
- Play Console Help — App testing requirements: tài khoản cá nhân mới cần closed testing 12 tester/14 ngày.
- Hướng dẫn Family Controls entitlement (newly.app/how-to/family-controls-entitlement) + tài liệu kỹ thuật cộng đồng về FamilyControls/DeviceActivity/ManagedSettings: entitlement Distribution phải xin riêng từng bundle ID, duyệt vài ngày–vài tuần; token mờ; DeviceActivityReport bị sandbox không xuất dữ liệu.
- Android Developers — DevicePolicyManager / Building a Device Policy Controller: Device Owner chỉ provision được trên thiết bị chưa thiết lập; các API lockNow, setPackagesSuspended, setApplicationHidden.
- Schema SafePC đối chiếu trực tiếp trong cây mã nguồn local: `backend/supabase/migrations/20261116102900_init_safepc.sql` (bảng devices, rules), các migration Sprint 5 (device_child_accounts) và migration 30 (push_subscriptions có cột platform).
