Gói bàn giao SafePC — tạo 2026-11-26.

# verify-owner-guide.md — Việc chỉ anh Tiến làm được

Các việc trong file này đều cần tay anh: trình duyệt tự động không paste được vào Supabase SQL Editor, không bấm được nút xóa artifact trên GitHub, không giữ mã authenticator, và kiểm chứng thật phải chạy trên máy Windows của con. Mỗi mục ghi rõ: làm gì, ở đâu, kỳ vọng thấy gì, báo lại bằng cách nào. Danh sách việc dạng quyết định nhanh nằm ở `docs/OWNER-INBOX.md`.

**Quy tắc gửi link trong chat:** link quan trọng luôn được gửi dạng URL trong dấu backtick trên dòng riêng, kèm đường đi bằng chữ (vì link markdown từng bị lược khi gửi). Anh cứ theo đường đi bằng chữ nếu link không bấm được.

---

## 1. Chạy migration trong Supabase SQL Editor (kèm kiểm fidelity)

**Làm gì:** Áp một file migration `.sql` lên database SafePC. Thứ tự hiện tại: migration 24 trước, migration 27 sau (27 phụ thuộc 24).

**Ở đâu:** Supabase Dashboard → project SafePC (ref `fzknvolkxnwfxdcfmops`) → SQL Editor. File migration nằm ở `backend/supabase/migrations/` trong repo/cây local; trợ lý sẽ đưa đúng file cho anh khi tới lượt.

**Các bước:**
1. Mở file migration, copy toàn bộ nội dung, paste vào SQL Editor.
2. **Kiểm fidelity TRƯỚC khi bấm Run** (bắt buộc — đã từng có migration bị chép tay làm sai nội dung):
   - File phải chứa đúng tên hàm/RPC kỳ vọng (ví dụ migration 27 phải có `safepc_sync_enforcement_state_to_device`; migration 24 phải có `device_child_accounts` và `safepc_fetch_device_child_rules`).
   - File KHÔNG được chứa định danh lạ không có trong bản gốc (tên bảng/hàm tự chế). Thấy chữ lạ thì dừng, gửi ảnh cho trợ lý.
   - Riêng migration 11/12 (đã áp): nếu chạy lại từ file trên GitHub thì phải thay chuỗi placeholder secret bằng secret thật của anh trước khi chạy — file gốc chứa placeholder có chủ đích.
3. Bấm Run. Kỳ vọng: thông báo chạy thành công, không lỗi đỏ.
4. **Báo lại:** chụp màn hình kết quả Run (thành công hay lỗi nguyên văn) gửi vào chat. Lỗi thì gửi nguyên văn dòng lỗi, đừng tự sửa SQL.

**Kỳ vọng sau khi áp xong:** trợ lý kiểm chứng lại qua REST (RPC tồn tại, bảng truy vấn được) và báo anh.

---

## 2. Cài bản v0.1.309 + extension 0.1.10 và chạy kịch bản kiểm chứng

**Làm gì:** Cài bản Sprint 4 lên máy con và chạy kịch bản test 3 phần đã giao ngày 20/11/2026.

**Chuẩn bị:**
1. Tải bản cài: GitHub → repo SafePC → Actions → run #309 → Artifacts → `SafePCAgentSetup` (94,8 MB). Đây là artifact duy nhất còn trên GitHub — đừng xóa (xem mục 5).
2. Cài từ **tài khoản admin của anh** (bộ cài yêu cầu quyền Admin, cài cho cả máy: Service chạy nền từ lúc khởi động, Tray tự chạy mỗi lần đăng nhập kể cả tài khoản Standard của con). Không cài từ tài khoản của con.
3. Cập nhật extension lên 0.1.10 (file zip trợ lý đã đưa; cài tay dạng unpacked như hiện tại, giữ nguyên thư mục `C:\SafePC\extension` để ID không đổi).

**Phần 1 — Sprint 4:** Làm đúng mục "Kịch bản kiểm chứng trên máy thật (Sprint 4)" trong `docs/03-SECURITY.md`, gồm:
- A. PIN gỡ cài đặt (6 bước: sai mã 3 lần bị hủy, đúng mã gỡ được, chưa đặt PIN gỡ bằng Admin, gỡ im lặng khi đã đặt PIN bị chặn, mất mạng vẫn kiểm được bằng cache).
- B. Watchdog Tray (4 bước: thoát bằng PIN thì không mở lại trong 30 phút ân hạn — đúng thiết kế; kill bằng Task Manager thì tự mở lại trong ~5 phút; cảnh báo `tray_stopped` chỉ khi không mở lại được sau 5 lần/giờ; khởi động lại máy thì Service + Tray tự chạy).
- C. Cảnh báo extension_missing (tắt extension nhưng giữ trình duyệt mở 15 phút → có cảnh báo, tối đa 1 lần/giờ; đóng hẳn trình duyệt thì không có cảnh báo — đúng thiết kế).
- D. ACL file: đăng nhập tài khoản Standard của con, mở PowerShell chạy `Get-Content $env:ProgramData\SafePC\device_token.dat` → kỳ vọng bị từ chối truy cập; kiểm tương tự với `exit_pin_hash.dat` và `agent.db`.

**Phần 2 — Hồi quy lõi (tóm tắt):**
- Khóa/mở khóa từ Dashboard: máy khóa đúng lệnh, mở khóa tạm thời chỉ hoãn khóa theo giờ giấc (chặn app/focus/nghỉ bắt buộc vẫn thi hành trong lúc mở khóa).
- Mẫu "Chỉ cho phép Edge": Chrome bị đóng, Edge dùng bình thường.
- Chặn domain: mở trang bị chặn → hiện trang chặn SafePC thật (không phải trang lỗi của trình duyệt).
- Xin thêm giờ từ Tray → email/Dashboard nhận được yêu cầu.

**Phần 3 — Các đợt mới (làm sau cũng được):** ngân hàng giờ (thưởng 30 + 30 → Tray hiện tổng 60), chặn theo danh mục (Mạng xã hội / Cờ bạc / Người lớn), nút xin mở domain trên trang chặn, tìm kiếm lịch sử web trong Báo cáo tuần, chuông thông báo trên Dashboard, nhật ký audit đổi luật, xuất dữ liệu (chỉ thử trên hồ sơ con THỬ — tuyệt đối không thử xóa trên hồ sơ Diệu Linh), MFA (tùy chọn).

**Báo lại:** Gửi kết quả theo từng mục (đạt / lỗi + ảnh chụp hoặc log). Log khi cần: Service ở `%ProgramData%\SafePC`, Tray ở `%LocalAppData%\SafePC\logs\agent-tray.log` của từng user.

---

## 3. Chạy lại job lỗi của CI #317 sau 01/12/2026 (lấy bản cài v0.1.317)

**Làm gì:** Chạy lại đúng job `build-agent` đã lỗi của run #317 để GitHub tải artifact lên (lần đầu lỗi vì hết hạn mức lưu trữ, không phải lỗi code).

**Ở đâu:** GitHub → repo SafePC → Actions → run #317.

**Các bước:**
1. Chỉ làm **sau ngày 01/12/2026** (hạn mức Actions reset ngày này).
2. Mở run #317 → nút **Re-run jobs** → chọn **Re-run failed jobs** (chỉ chạy lại job lỗi, không chạy lại cả run).
3. Chờ job xong; tải lại trang run nếu trạng thái "đang chạy" đứng quá lâu (trang live từng hiển thị cũ — mở trang job để xem trạng thái thật).

**Kỳ vọng:** Job xanh; mục Artifacts của run xuất hiện `SafePCAgentSetup` — đó là bản cài **v0.1.317** (bản Sprint 5 đầu tiên). Nếu vẫn báo lỗi hạn mức lưu trữ: mức dùng được GitHub tính lại mỗi 6–12 giờ, chờ rồi thử lại sau, đừng bấm lặp liên tục.

**Báo lại:** Báo trợ lý khi artifact xuất hiện (hoặc gửi ảnh lỗi) — trợ lý sẽ ghi bản 317 vào file danh sách build thành công và cập nhật trạng thái.

---

## 4. Bật 2FA cho tài khoản GitHub (hạn 04/01/2027)

**Làm gì:** Bật xác thực hai yếu tố cho tài khoản `ndtcoder`. GitHub yêu cầu hoàn thành trước 04/01/2027 00:00 UTC; quá hạn tài khoản bị giới hạn truy cập cho tới khi bật.

**Ở đâu:** GitHub → ảnh đại diện → Settings → Password and authentication → Two-factor authentication.

**Các bước:**
1. Chọn thiết lập bằng app authenticator (dùng cùng app anh đang dùng cho Vercel).
2. Quét QR, nhập mã xác nhận để bật.
3. **Lưu mã khôi phục (recovery codes) GitHub cấp vào chỗ an toàn** — mất điện thoại mà không có mã này là mất đường vào tài khoản.

**Kỳ vọng:** Trang Settings hiện trạng thái 2FA đã bật. **Báo lại:** chỉ cần báo "đã bật" trong chat, KHÔNG gửi mã khôi phục hay mã 2FA cho trợ lý.

---

## 5. Xóa artifact GitHub khi cần dọn hạn mức

**Làm gì:** Xóa artifact `SafePCAgentSetup` của các run cũ để dọn dung lượng Actions.

**Ở đâu:** GitHub → repo SafePC → Actions → mở run cần xóa → kéo xuống mục Artifacts → nút thùng rác ở dòng `SafePCAgentSetup` → xác nhận.

**Lưu ý bắt buộc:**
- Nút thùng rác **chỉ bấm được bằng chuột thật của anh** — trình duyệt tự động của trợ lý bấm không mở được hộp xác nhận (đã thử nhiều cách ngày 19/11, đều không được).
- **Giữ lại bản run #309 (v0.1.309)** — hiện là bản cài duy nhất còn tải được. Các run #314–#317 không có artifact nào để xóa (lần tải lên đã lỗi vì hạn mức).
- Trước khi xóa, đối chiếu với file danh sách build: `~/workspace/goals/safepc-parental-control-app/files/danh-sach-build-thanh-cong.md` (trợ lý cập nhật file này mỗi lần có build thành công).
- Xóa artifact KHÔNG giải phóng hạn mức ngay: GitHub tính mức dùng trung bình theo thời gian, reset theo chu kỳ (đợt này là 01/12/2026).

**Báo lại:** Báo trợ lý run nào đã xóa để trợ lý cập nhật danh sách build.

---

## 6. Kiểm email báo cáo tuần tự động sáng thứ Hai

**Làm gì:** Xác nhận email báo cáo tuần đầu tiên do hệ thống tự gửi (cron thứ Hai 00:00 UTC = 07:00 giờ Việt Nam).

**Ở đâu:** Hộp thư phụ huynh (hộp thư đã nhận email thông báo máy offline ngày 25/11).

**Kỳ vọng:**
- Có email từ `SafePC <bao-cao@ndt.ap.vn>`, tiêu đề dạng báo cáo tuần SafePC, nội dung gồm 7 mục tóm tắt tuần của con.
- Email thông báo phụ huynh (xin thêm giờ, can thiệp, máy offline) đã được chứng minh gửi thật thành công ngày 25/11/2026 — mục này chỉ còn kiểm đường báo cáo tuần tự động.

**Nếu không thấy email:** Kiểm thư mục spam trước, rồi báo trợ lý. Trợ lý sẽ kiểm theo thứ tự: secret báo cáo đã đặt đúng chưa → 2 Edge Function đã deploy lại sau lần đổi secret gần nhất chưa → trạng thái claim trong bảng `weekly_report_sends` (nếu email đã gửi mà bước đánh dấu gửi bị lỗi thì sửa trạng thái thành `sent`, TUYỆT ĐỐI không xóa dòng — xóa sẽ gây gửi trùng).
