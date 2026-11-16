# Shared Types (`@safepc/shared-types`)

Type contract dùng chung giữa Dashboard, PC Agent và Backend — **chỉ
TypeScript types, không có code runtime, không dependency runtime**.

**Nguồn sự thật:** `backend/supabase/migrations/20261116102900_init_safepc.sql`.
Tên bảng, tên cột và các giá trị enum trong package này khớp đúng migration
(bản đã rà soát Sprint 1, 16/11/2026). Khi migration thay đổi, cập nhật
`src/index.ts` trong cùng thay đổi đó.

## Nội dung (`src/index.ts`)

| Kiểu | Mô tả |
|---|---|
| `Family`, `FamilyMember`, `FamilyMemberRole` | Gia đình và thành viên (`parent` \| `child`) |
| `Child`, `Device`, `DeviceStatus` | Con và máy tính (`online` \| `offline` \| `locked`) |
| `DeviceToken`, `PairingCode` | Chỉ chứa hash — không bao giờ chứa token/mã thô |
| `Rule`, `RuleType`, `RuleConfig`, `RuleConfigMap`, `DailyLimitRuleConfig`, `BedtimeRuleConfig`, `AppRuleConfig`, `WebsiteRuleConfig`, `RuleAction` | Quy tắc + `config` JSONB theo từng loại; `Rule<T>` gắn đúng config với loại rule |
| `AppUsage`, `WebVisit` | Lịch sử dùng app (hash đường dẫn exe) và web (chỉ domain) |
| `RequestItem`, `RequestType`, `RequestStatus` | Yêu cầu của con (đặt tên `RequestItem` để tránh đụng `Request` của DOM) |
| `Command`, `CommandType`, `CommandStatus`, `CommandPayload` | Lệnh từ phụ huynh xuống Agent |
| `AuditLog` | Nhật ký kiểm tra (chỉ lưu hash IP) |
| `TableName`, `Weekday` | Tên bảng và thứ trong tuần (0 = Chủ nhật, theo `Date.getDay()`) |

Quy ước: UUID và thời gian đều là `string` (thời gian dạng ISO 8601); cột
nullable trong DB có kiểu `... | null`. Các kiểu mô tả dòng dữ liệu đọc từ DB;
khi cần kiểu insert, dùng `Omit<..., "id" | "created_at">` ở phía consumer.

## Cách dùng

Package không cần build: `types` trong `package.json` trỏ thẳng tới
`src/index.ts`, consumer import trực tiếp từ source.

```ts
import type { Child, Device, Rule } from "@safepc/shared-types";

const rule: Rule<"daily_limit"> = {
  id: "...",
  family_id: "...",
  child_id: "...",
  type: "daily_limit",
  config: { minutesByWeekday: { 1: 120 } },
  enabled: true,
  created_at: "...",
};
```

## Kiểm tra kiểu

```bash
npm install   # cài typescript (devDependency duy nhất)
npm run check # tsc --noEmit, strict
```

Đã kiểm chứng bằng `tsc --noEmit` (strict) với TypeScript 5.9.3 ngày
16/11/2026 — xem báo cáo của task Backend + Shared Types Sprint 1.
