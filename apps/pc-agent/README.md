# SafePC Agent (Windows)

Agent chạy trên máy tính của con (Windows 10/11 64-bit).

**Stack:** C# .NET 8 — Windows Service (SYSTEM) + Tray App (user session).

**Trạng thái:** Sprint 0 — chưa có code. Xem `../../docs/01-PRD.md` và `../../docs/02-ARCHITECTURE.md` trước khi code.

**Sprint 1 sẽ làm:**
- Windows Service: heartbeat, ghi app foreground, đồng bộ usage.
- Tray App: cảnh báo, màn hình khóa, xin thêm giờ.
- Installer: Inno Setup, cài All Users, yêu cầu Admin lúc cài.
