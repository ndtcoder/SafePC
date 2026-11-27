# import-category-lists — nhập domain theo 6 nhóm cho SafePC

Script Node (`import.mjs`, không cần dependency ngoài — chỉ dùng `curl`,
`tar`, `unzip` của hệ thống) tải các filter list công khai có **giấy phép
sạch**, chuẩn hoá, chọn lọc theo ngân sách và sinh 6 file dữ liệu danh
mục cho Agent. Xem thêm `docs/10-DATA-SOURCES.md`.

## Nguồn (chỉ 3 nguồn sạch — quyết định của chủ sản phẩm 27/11/2026)

| Nguồn | Giấy phép | Dùng cho |
|---|---|---|
| StevenBlack/hosts (`alternates/{porn,gambling,social}-only/hosts`) | MIT | adult, gambling, social |
| UT1 Blocklist — Université Toulouse Capitole (`<category>.tar.gz`) | CC BY-SA 4.0 (ghi công) | gambling, games, audio-video+warez (movies), agressif+dangerous_material (violence), social_networks+chat (social), adult (chỉ đối chiếu dạng stream) |
| The Block List Project (`<list>.txt`) | Unlicense | adult (Porn), gambling (Gambling), social (Facebook/TikTok/Twitter/WhatsApp) |

TUYỆT ĐỐI KHÔNG dùng HaGeZi / OISD (GPL-3.0) và Energized (CC BY-NC-SA)
theo quyết định giấy phép đã chốt.

Tín hiệu phổ biến: Tranco top-1M (https://tranco-list.eu) — chỉ dùng để
xếp hạng ứng viên, không phải nguồn phân loại.

## Cách chạy

```bash
cd tools/import-category-lists
node import.mjs           # dùng lại .cache/ nếu đã tải
node import.mjs --force   # tải lại mọi file nguồn
```

Đầu ra:

- `apps/pc-agent/src/SafePC.Agent.Shared/CategoryData/{adult,gambling,violence,games,movies,social}.txt`
  — mỗi file 3 dòng comment header (nguồn + giấy phép + ngày nhập) rồi
  mỗi dòng 1 domain đã sắp xếp. Agent nạp qua embedded resource
  (`DomainCategoryLists.cs`); KHÔNG sửa tay các file này.
- `manifest.json` (thư mục này) — thống kê: số domain từng nguồn, kích
  thước pool từng nhóm, số domain ≥2 nguồn, số bị nhóm ưu tiên cao hơn
  lấy mất, số tên miền con bị gộp, số bị danh sách bảo vệ loại (kèm tên),
  số domain "nhạy cảm dễ chặn nhầm" có mặt trong đầu ra.

## Quy tắc chọn lọc (minh bạch, theo thứ tự)

1. **Hạt giống** (`seeds.json` — 54 domain viết tay ban đầu của SafePC):
   luôn giữ, thuộc nhóm của chúng, tính vào ngân sách.
2. **Giao nhau ≥2 nguồn độc lập** trong cùng nhóm (stevenblack / ut1 /
   blp là ba biên tập độc lập) được ưu tiên trước.
3. **Hạng Tranco top-1M** (domain phổ biến trước).
4. **Thứ tự xuất hiện** trong list nguồn (StevenBlack > UT1 > BLP).

Ngân sách mỗi nhóm (trần ~30.000 dynamic rules của DNR phía extension):
adult 8.000 / gambling 4.000 / social 2.500 / movies 2.000 /
games 2.500 / violence 500 (tổng 19.500).

Mỗi domain chỉ thuộc **đúng một nhóm**: xử lý theo thứ tự ưu tiên
adult > gambling > violence > games > movies > social. Tên miền con bị
gộp bỏ khi domain cha đã có trong cùng nhóm (extension khớp theo hậu
tố). Sau chọn lọc, áp **danh sách bảo vệ** (`exclude.txt`: công cụ tìm
kiếm, Wikipedia, domain giáo dục/học tập Việt Nam, tin tức lớn — kể cả
mọi tên miền con của chúng) rồi lấp lại ngân sách từ ứng viên còn lại.

## File trong thư mục

- `import.mjs` — script chính.
- `seeds.json` — 54 domain hạt giống (bản chụp từ DomainCategoryLists.cs
  trước đợt nhập; chỉ sửa khi chủ sản phẩm chốt thêm hạt giống tay).
- `exclude.txt` — danh sách bảo vệ, sửa tay được.
- `manifest.json` — kết quả lần chạy gần nhất (sinh tự động).
- `.cache/` — file nguồn đã tải + bản LDNOOBW tham khảo cho từ khóa
  (không phải đầu ra; xóa được, script tải lại).
