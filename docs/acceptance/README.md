Gói bàn giao SafePC — tạo 2026-11-26.

# Gói nghiệm thu (acceptance) — cách đọc

Mỗi file trong thư mục này là gói nghiệm thu của một milestone: danh sách tiêu chí, bằng chứng đã có, và trạng thái trung thực của từng tiêu chí.

Quy ước trạng thái:

- **ĐẠT** — có bằng chứng cụ thể (kiểm chứng trên máy thật, hoặc lệnh đã chạy + kết quả nguyên văn được ghi lại).
- **CHƯA ĐẠT** — đã kiểm và thấy chưa đúng.
- **CẦN KIỂM TAY** — phần code/CI đã xong nhưng chưa kiểm chứng trên máy thật hoặc tài khoản thật; không được coi là xong cho tới khi anh Tiến chạy kịch bản kiểm chứng và báo kết quả.

Nguyên tắc: CI xanh hoặc harness PASS chỉ chứng minh phần tự động. Luồng nào chạm máy Windows thật, trình duyệt thật, hộp thư thật thì chỉ "ĐẠT" khi đã có bằng chứng từ môi trường thật.

## Các gói hiện có

| File | Milestone | Tóm tắt trạng thái |
|---|---|---|
| `M1-core.md` | Sprint 0–2 — lõi: ghép nối, đồng bộ rules, khóa/mở, chặn app, chặn domain | Các luồng lõi ĐẠT trên máy thật 17–18/11/2026 |
| `M2-advanced-features.md` | Đợt tính năng nâng cao 18–19/11/2026 | Code ĐẠT (CI xanh từng đợt); máy thật phần lớn CẦN KIỂM TAY; email thông báo phụ huynh ĐẠT 25/11/2026 |
| `M3-sprint4.md` | Sprint 4 — cứng hóa, bản cài v0.1.309 | Code/CI ĐẠT (CI #309); máy thật CẦN KIỂM TAY toàn bộ |

## Chưa có gói nghiệm thu

- **Sprint 5 (đa con trên máy chung): CHƯA có gói nghiệm thu** — milestone chưa xong: đợt 1 backend đã lên `main` nhưng chưa có bản cài (chờ chạy lại CI #317 sau 01/12/2026), đợt Dashboard + migration 27 còn giữ ở cây local, migration 24/27 chưa áp, và kiểm thử bắt buộc phải làm trên máy thật với 2 tài khoản con + chuyển đổi nhanh. Khi Sprint 5 xong phần code và có bản cài, tạo `M4-sprint5.md` tại thư mục này.
- **Giai đoạn 2 (Android):** chưa bắt đầu, chưa có gói.
