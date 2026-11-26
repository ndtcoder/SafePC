# AGENTS.md — Luật vận hành workspace SafePC (gói bàn giao)

Gói bàn giao SafePC — tạo 2026-11-26.

File này là luật vận hành khi làm việc trên dự án SafePC trong workspace này. Mỗi mục: **quy tắc** — lý do — ngày chốt/ghi nhận. Nguồn: `~/AGENTS.md` (bản gốc đang sống, cập nhật liên tục) và bộ nhớ dự án. Nếu hai nơi vênh nhau, ưu tiên `~/AGENTS.md` và hỏi lại anh Tiến.

## A. Cây làm việc & Git

- **Cây local KHÔNG có `.git`** — xác minh 2026-11-25: `~/workspace/projects/safepc` (145 MB) không có thư mục `.git`; toàn bộ lịch sử commit chỉ nằm trên GitHub (repo `ndtcoder/SafePC`, Private, nhánh `main`). Hệ quả: không có commit local nào "chưa đẩy" để mất; đừng áp các quy tắc bảo vệ `.git` local vào cây này.
- **KHÔNG rsync/đồng bộ đè cây live, không giải nén đè cây live** — cây live chứa việc chỉ-có-ở-local (đợt Dashboard Sprint 5 + migration 27 đang chờ đẩy tính đến 26/11/2026); đè là mất việc không khôi phục được.
- **Khôi phục từ snapshot: giải nén vào THƯ MỤC TẠM, kiểm tra trước, rồi mới dùng** — tránh phá trạng thái cây live đang chạy (quy tắc anh Tiến chốt 25/11/2026).
- **Script backup chỉ ĐỌC cây live, không bao giờ ghi/sửa/xóa trong cây live** — backup hỏng không được phép kéo theo hỏng cây gốc (25/11/2026).

## B. Tuyến đẩy code lên GitHub (DUY NHẤT một tuyến)

- **Chỉ đẩy bằng upload qua giao diện web GitHub bằng trình duyệt cloud** — các tuyến khác đã chứng minh không dùng được: `push_files` (Git Trees API) trả 403 "Resource not accessible by integration" kể cả khi đã cấp All repositories (thử lại nhiều lần 16/11/2026, gồm cả CLI snapshot — KHÔNG thử lại nữa); SSH git bị egress proxy chặn (port 22 reset, tunnel 443 đóng); `create_or_update_file` (Contents API) chạy được nhưng mỗi file một thẻ phê duyệt — chỉ dùng khi thật cần.
- **Mỗi commit chỉ gồm file của MỘT thư mục** — trang Upload files của GitHub ghim đích theo thư mục bắt đầu upload, không đặt được file vào hai thư mục trong một commit (xác minh thực nghiệm 19/11/2026). Đợt nhiều thư mục = nhiều commit liên tiếp, cùng commit message cũng được.
- **Tối đa ~12 file mỗi lượt upload** — 84 file một lượt bị trình duyệt từ chối (16/11/2026); chia nhỏ còn tránh race commit đồng thời trên `main`.
- **Sau mỗi commit: kiểm chứng đường dẫn file trên trang commit đó rồi mới làm commit tiếp theo** — bắt lỗi sai thư mục ngay tại chỗ (19/11/2026).
- **Sau mỗi tác vụ browser hoàn thành: đóng cửa sổ/tab của tác vụ đó** — giảm tải máy (anh Tiến dặn 16/11/2026). Không bao giờ đóng tác vụ đang chạy.
- **Hạn chế tối đa số lần xin phép khi đẩy GitHub; ưu tiên cách tự động/chạy nền** — anh Tiến đã ủy quyền tự làm các bước tiếp theo của SafePC, chỉ báo khi ra sản phẩm (16/11/2026).
- **KHÔNG thử lại nút xóa artifact trên trang run bằng browser tự động** — nút thùng rác không bao giờ mở hộp xác nhận trong browser tự động (thử đủ cách 19/11/2026, không xóa được gì). Xóa artifact: anh Tiến tự bấm bằng chuột thật (live-browser takeover) hoặc qua REST API; GitHub MCP không có tool xóa artifact.

## C. Đọc kết quả CI

- **Chỉ trạng thái của HEAD run mới có ý nghĩa** — khi đẩy nhiều commit liên tiếp, run của commit trung gian đỏ là BÌNH THƯỜNG nếu commit sau bổ sung file mà code của commit trước tham chiếu (ví dụ run trên b699159 đỏ, head run #94 xanh, 16/11/2026). Không đuổi theo lỗi của run đã bị thay thế.
- **Cổng Agent = run của commit CUỐI CÙNG chạm `apps/pc-agent/`** — job `changes` diff `github.event.before` → `github.sha`, mà web upload tạo 1 push cho mỗi commit nên diff thực tế là đơn commit: run của commit chỉ-sửa-Dashboard sẽ bỏ qua build-agent một cách hợp lệ. Bản cài hiện hành là artifact của run Agent-gate đó (bài học runs #264/#267, 18/11/2026).
- **Trang run CI dạng live view có thể hiển thị trạng thái "đang chạy" CŨ** — run #131 thực tế xong lúc 12:03 nhưng tab vẫn báo running hơn 26 phút. Luôn reload trang run (hoặc mở trang job) để lấy trạng thái thật; không tin đồng hồ elapsed của live view (17/11/2026).
- **Job-level `if:` muốn fail-safe phải viết `!cancelled() && (...)`** — `if:` không có status function sẽ bị GitHub tự thêm `success()` ở đầu, khiến biểu thức fail-safe không bao giờ kích hoạt khi job phụ thuộc đã fail (reviewer bắt lỗi ở ci.yml, 18/11/2026).
- **Lọc thay đổi file phải dùng `git diff --no-renames`** — diff mặc định chỉ in tên MỚI của file đổi tên, file đổi tên ra khỏi cây theo dõi sẽ bị sót; và không pipe thẳng `git diff` có thể lỗi vào `grep -q` trong `if !` (diff lỗi → không output → `!` lật thành "không đổi") — bắt output trước, chỉ kết luận "không đổi" khi diff chạy thành công và không khớp gì (18/11/2026).

## D. Build & kiểm tra TRƯỚC khi đẩy

- **Luôn biên dịch local trước khi đẩy, không dùng CI làm trình biên dịch đầu tiên** — .NET 8 SDK 8.0.416 ở `~/dotnet`: trong `apps/pc-agent/` chạy `~/dotnet/dotnet build SafePC.Agent.sln -p:EnableWindowsTargeting=true` (build được cả project net8.0-windows WPF/Service trên Linux; lần đầu ~60s, tăng dần ~10s). Lưu ý: dotnet build KHÔNG biên dịch file `.iss` — lỗi Inno Setup chỉ lộ ở CI (17/11/2026).
- **Dashboard: kiểm tra kiểu bằng `tsc --noEmit -p .` trong `apps/dashboard-web`** (có dấu cách sau `-p`); `npm run build`/`vite build` phải chạy với CWD đúng là `apps/dashboard-web`.
- **Secret scan phải trả 0 trên mọi đợt** — chạy đúng lệnh ở `.github/workflows/ci.yml` dòng 62 (`grep -rInE` với pattern trong file đó). Scan này **PHÂN BIỆT hoa thường** — KHÔNG có cờ `-i` (chữ `-I` là "bỏ qua file nhị phân"; đã kiểm chứng thực nghiệm 18/11/2026, đính chính một ghi nhận sai trước đó). Trong comment nên tránh hẳn các cụm chữ nhạy cảm (ví dụ viết "khóa quản trị" thay cho tên key) để lần sửa chữ thường sau này không vấp scan.
- **Version Agent = `0.1.<số run CI>`, KHÔNG BAO GIỜ hardcode chuỗi version** — CI tự đóng dấu: `dotnet publish -p:Version=0.1.${{ github.run_number }}` + ISCC `/DAppVersion=0.1.${{ github.run_number }}`; `AgentConstants.AgentVersion` đọc AssemblyInformationalVersion của entry assembly (dự phòng "0.1.0-dev") (anh Tiến yêu cầu 17/11/2026).
- **Mọi con số báo cáo (số test, version, commit) phải lấy bằng lệnh chạy thật** — không nhớ mang máng (nguyên tắc gói bàn giao, 26/11/2026).

## E. Quy trình mỗi đợt (không bỏ bước review)

- **Builder xây + tự kiểm → reviewer ĐỘC LẬP review → sửa phát hiện → re-review → mới đẩy → kiểm head qua GitHub API** — các vòng review độc lập đã liên tục bắt được lỗi thật (kể cả lỗi MAJOR); bỏ review là bỏ cổng chất lượng chính.
- **Reviewer phải do agent chính sinh ra, KHÔNG dùng reviewer do builder tự sinh** — reviewer của builder không độc lập.
- **Việc cần kiểm chứng khóa/mở phải qua cổng kiểm tra trước khi báo anh Tiến test máy thật** — anh Tiến yêu cầu 17/11/2026: chỉ nhờ anh kiểm chứng cuối trên máy thật sau khi cổng khóa/mở đã xanh, kèm danh sách ngắn; không nhờ anh chạy các bước chẩn đoán vòng đời Service/Tray.
- **Khi anh Tiến vắng mặt: cứ tự build & test tiếp** (định hướng mobile-first), chỉ dừng chờ ở phần cần anh review/quyết định (anh dặn 16/11/2026, tái khẳng định 19/11/2026).

## F. Supabase & migration

- **Browser tự động KHÔNG paste được vào Supabase SQL Editor (Monaco)** — Ctrl+V bị lớp tự động hóa từ chối, chuột phải → Paste không có tác dụng (xác minh hai lần 16/11/2026). Migration do **anh Tiến tự paste + chạy** qua live-browser takeover, kèm kiểm tra fidelity trước khi Run (file phải chứa đúng tên hàm kỳ vọng, KHÔNG chứa định danh bịa — một migration từng bị gõ tay sai thành định danh không tồn tại và chạy lỗi).
- **KHÔNG bắt worker browser gõ lại SQL bằng tay** — xem mục trên.
- **pg_dump/psql trực tiếp từ VM này là KHÔNG THỂ** — egress proxy chỉ cho HTTP CONNECT tới port 443; cả host trực tiếp :5432 lẫn pooler :6543 đều hỏng bắt tay Postgres. Dùng API qua HTTPS 443 (PostgREST / Management API) hoặc anh Tiến tự chạy pg_dump trên máy của anh (bài học MyHome, 19/11/2026 — áp dụng chung cho mọi project Supabase trên VM này).
- **Kiểm tra DNS dùng DNS-over-HTTPS, KHÔNG dùng dig** — truy vấn UDP DNS từ VM này bị egress trả REFUSED kể cả với tên miền đang live. Dùng `curl -s "https://dns.google/resolve?name=<domain>&type=A"`: Status 3 = NXDOMAIN (chưa live), Status 0 + Answer = live (23/11/2026).

## G. Giao tiếp & gửi link

- **Link quan trọng: gửi URL trong backtick trên dòng riêng, KÈM hướng dẫn điều hướng bằng chữ** — link markdown và URL trần trong chat từng bị lược ÂM THẦM hai lần khi gửi (đã kiểm chứng bằng cách đọc lại tin đã lưu). Mẫu dự phòng: "GitHub → repo → Actions → số run → Artifacts → SafePCAgentSetup" (17/11/2026).
- **Luôn trao đổi bằng tiếng Việt, gọi user là anh Tiến, AI tự xưng TraMuse hoặc em My** — anh Tiến chốt 18/11/2026 (xem AMENDMENTS.md).

## H. Đối chứng log CI — worker trình duyệt có thể BỊA

- **KHÔNG tin bản chép log CI do worker trình duyệt trả về nếu chưa đối chứng** — hai worker từng trả hai bản log khay bịa khác nhau cho run #129, chứa chuỗi không tồn tại trong codebase (tên pipe bịa, tên check bịa; tên pipe thật là `SafePCAgentPipe`, tên check thật nằm trong `App.xaml.cs`) (17/11/2026).
- **Cách đối chứng bắt buộc:** (1) grep cây local tìm chuỗi đặc trưng worker trả — 0 kết quả = bịa; (2) fetch lại bằng truy vấn tìm kiếm hẹp trên chuỗi ĐÃ BIẾT đúng, trích nguyên văn hoặc báo NOT FOUND, kèm một truy vấn điều khiển vô nghĩa (bắt buộc phải NOT FOUND) để phát hiện bịa; (3) không tin tên check bị diễn giải lại; (4) hai worker độc lập trùng nhau ở một chuỗi đặc trưng là tín hiệu đáng tin, lệch nhau nghĩa là ít nhất một bên bịa.

## I. Quy tắc kỹ thuật cứng (đã trả giá bằng CI/máy thật — không lặp lại)

- **KHÔNG BAO GIỜ đặt `AutoFlush = true` trên StreamWriter bọc NamedPipeStream** — setter gọi Flush() → FlushFileBuffers chặn cho tới khi phía bên kia ĐỌC hết dữ liệu; hai phía cùng đặt trước khi luồng đọc khởi động = deadlock lẫn nhau. Đây là NGUYÊN NHÂN GỐC của vụ IPC không giao được dữ liệu từ ngày đầu (chứng minh bằng breadcrumb CI run #133, 17/11/2026). Mọi điểm ghi phải `FlushAsync` tường minh sau `WriteLineAsync`.
- **Vòng đọc pipe không bao giờ chạy trên UI thread; timeout đọc pipe không dùng CancelAfter + ReadLineAsync(token)** — hủy token KHÔNG hủy được ReadLineAsync đang chờ trên NamedPipeStream (chứng minh cả hai phía, Tray kẹt 37 phút). Timeout phải là `Task.WhenAny(readTask, Task.Delay(...))` + dispose stream để giải phóng read đang chờ (17/11/2026).
- **KHÔNG đặt `Owner` là anchor window ẩn cho BẤT KỲ cửa sổ Tray nào** — log build #111: menu mất activation trong 300ms, dialog hiển thị nhưng nút không nhận click. Mọi cửa sổ Tray là top-level độc lập, không Owner; anchor window chỉ giữ vai trò neo vòng đời (17/11/2026).
- **Menu khay là một WPF Window borderless thật, KHÔNG dùng ContextMenu (WinForms hay WPF)** — ContextMenuStrip cần message filter của WinForms (đơ trên máy thật); WPF ContextMenu phụ thuộc activation của owner và kẹt qua 3 vòng sửa. Menu đóng bằng Deactivated/Escape/click chọn/click phải lần nữa; click phải trong 500ms sau khi mở phải bị bỏ qua (open-grace); handler Deactivated phải bọc try/catch(InvalidOperationException) vì Close() có thể đua nhau (16–17/11/2026).
- **`_lockSent` chỉ được đặt khi lệnh gửi thật sự tới ≥1 writer** — `SendToTrayAsync` trả về số writer đã nhận; đặt cờ trước khi gửi làm mất lệnh khóa đầu tiên sau mỗi lần Service khởi động lại (17/11/2026).
- **Inno Setup: `PrepareToInstall` phải đúng nguyên mẫu `function PrepareToInstall(var NeedsRestart: Boolean): String;`** — sai nguyên mẫu là ISCC lỗi "Invalid prototype" (CI run #47, 16/11/2026). Tra docs trước khi thêm event handler `[Code]` bất kỳ.
- **Inno Setup: `CreateCustomForm` BẮT BUỘC 4 tham số** `CreateCustomForm(ClientWidth, ClientHeight: Integer; KeepSizeX, KeepSizeY: Boolean): TSetupForm` từ bản 6.6.0; dạng không tham số đã bị bỏ — gọi không tham số đều lỗi "Invalid number of parameters" (CI runs #307/#308). CI cài bản mới nhất qua choco nên luôn dùng dạng 4 tham số, truyền kích thước vào hàm thay vì gán ClientWidth/ClientHeight sau (xác minh từ docs chính thức jrsoftware.org, 19/11/2026).
- **Inno Pascal Script: KHÔNG dùng `StringChange` lẫn `StringChangeEx`** — cả hai đều lỗi "Type mismatch" dưới ISCC 6.7.1 (CI runs #80/#81). Thay chuỗi bằng vòng lặp thủ công chỉ dùng Length/chỉ số chuỗi/nối chuỗi (xem `DoubleBackslashes` trong SafePCAgent.iss) (16/11/2026).
- **`JsonIgnoreCondition` không có member `WhenNull`** (CS0117, CI run #108) — member đúng để bỏ qua property null là `WhenWritingNull` (16/11/2026).
- **Tên attribute đúng là `System.Reflection.AssemblyInformationalVersionAttribute`** — không phải `AssemblyInformationalAttribute` (CS0234, CI run #119, 17/11/2026).
- **Kiểm tra tài khoản admin phải tính token UAC bị lọc** — `WindowsPrincipal.IsInRole(Administrator)` trả FALSE cho tiến trình không nâng quyền dù tài khoản thuộc Administrators. Muốn biết TÀI KHOẢN có phải admin: truy vấn `TokenElevationType` qua P/Invoke GetTokenInformation (class 18): Full (2) hoặc Limited (3) = admin; Default (1) = standard. Giữ IsInRole làm đường nhanh, dự phòng bằng truy vấn token (reviewer bắt lỗi, 17/11/2026; đường Limited đã chứng minh trên máy thật).
- **Fake pipe server trong self-test phải VỪA phát lệnh chờ kết nối VỪA poll `IsConnected`** — poll một mình đọc False mãi nếu chưa phát lệnh chờ; lệnh chờ một mình có thể không thấy kết nối đã thiết lập trước (CI runs #127/#129/#131/#133, 17/11/2026). Production IpcPipeServer dùng WaitForConnectionAsync theo thứ tự server-first nên ổn; race tiềm ẩn khi Tray nối đúng micro-giây giữa lúc tạo instance và đăng ký chờ vẫn là việc cứng hóa riêng.
- **Watchdog vòng accept IPC không được cảnh báo khi vòng lặp đang ngồi ở WaitForConnectionAsync** — đó là trạng thái nghỉ bình thường, không phải kẹt; theo dõi cờ `_waitingForConnection` và bỏ qua cảnh báo khi cờ đang bật (17/11/2026).
- **Extension: KHÔNG BAO GIỜ gỡ `host_permissions` khỏi manifest** — rule DNR dạng `redirect`/`modifyHeaders` cần host permissions khớp URL; thiếu thì trình duyệt ÂM THẦM bỏ qua mọi rule redirect (không lỗi ở đâu cả). Đây là nguyên nhân gốc vụ trang bị chặn vẫn mở được (extension 0.1.3, sửa ở 0.1.4 bằng `["http://*/*", "https://*/*"]`, 18/11/2026). Khi rule "cài thành công mà không bao giờ kích hoạt", kiểm tra host permissions TRƯỚC khi nghi ngờ cú pháp điều kiện.

## J. Hai việc nền định kỳ (anh Tiến giao 25/11/2026)

- **Backup cây làm việc mỗi 30 phút** — script `~/workspace/scripts/backup-safepc.sh`: nén tar.gz cây `~/workspace/projects/safepc` CHỈ khi hash nội dung đổi (state `~/workspace/backups/safepc/.last-hash`), giữ 12 snapshot mới nhất ở `~/workspace/backups/safepc/`, loại trừ node_modules/coverage/test-results/.turbo/user-chat. Cron `backup-safepc-30m`. Im lặng khi bình thường; chỉ báo khi script lỗi, hoặc snapshot mới nhất quá 2 giờ (cây không đổi = bình thường, báo đúng 1 lần cho mỗi trạng thái nội dung qua marker `.stale-notified`).
- **Chat log mỗi 30 phút** — log lưu ở `~/workspace/projects/safepc/user-chat/` (`main.md` cho main chat + một `<slug>.md` cho mỗi side chat), CHỈ gồm tin nhắn user + reply của AI, append ngay trong cùng lượt trao đổi. Cron `chatlog-push-safepc-30m` đẩy file đã đổi lên GitHub repo `ndtcoder/SafePC` nhánh riêng **`chat-logs`** qua trình duyệt cloud (state `~/workspace/chat-log-push-state.json`, guard mtime 2 phút, chỉ ghi state sau khi upload thành công). **KHÔNG BAO GIỜ đẩy log lên main/develop** — log không phải source.
- **Khi anh Tiến hỏi "lên repo chưa": đối chiếu bằng sha256** — hash file local so với nội dung file đọc từ nhánh `chat-logs` trên GitHub, không chỉ nhìn state file (25/11/2026).
