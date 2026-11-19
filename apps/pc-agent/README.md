# SafePC Agent (Windows)

Agent chạy trên máy tính của con (Windows 10/11 64-bit).

**Stack:** C# .NET 8 — Windows Service (SYSTEM) + Tray App WPF (user session) + thư viện dùng chung.

> ⚠️ **CHƯA KIỂM CHỨNG BUILD TẠI CHỖ.** Code trong thư mục này được viết trên môi trường Linux không có .NET SDK và không phải Windows, nên **chưa từng được build hay chạy thử tại chỗ**. Việc build chỉ được kiểm chứng bởi job `build-agent` trên runner `windows-latest` của GitHub Actions (xem `.github/workflows/ci.yml`). Chưa kiểm chứng: build dotnet trên Windows, chạy Service/Tray thật, installer thật. Đừng coi skeleton này là đã chạy được cho tới khi CI Windows báo xanh và có người cài thử trên máy Windows thật.

## Kiến trúc 3 project

Solution: `SafePC.Agent.sln`

| Project | Loại | Chạy ở đâu | Việc chính |
|---|---|---|---|
| `src/SafePC.Agent.Shared` | Class Library (`net8.0-windows`) | Dùng chung | Token DPAPI, hash SHA-256, theo dõi app foreground (Win32), model khớp bảng Supabase, hằng số, logger local, message IPC |
| `src/SafePC.Agent.Service` | Worker Service (`net8.0-windows`, `Microsoft.Extensions.Hosting.WindowsServices`) | Windows Service, quyền SYSTEM | Heartbeat 60s, poll commands 15s, hàng đợi offline SQLite + retry backoff, cache rules, thi hành rules (skeleton), IPC Named Pipe server |
| `src/SafePC.Agent.Tray` | WPF (`net8.0-windows`, `UseWPF` + `UseWindowsForms`) | User session của con | Tray icon (WinForms `NotifyIcon`), cảnh báo 15/5/1 phút, màn hình khóa toàn màn hình, form xin thêm giờ, lấy mẫu foreground, IPC client |

```
[Máy con - Windows]
  Service (SYSTEM, session 0)  <--Named Pipe (ACL)-->  Tray App (user session)
    | heartbeat/poll/batch -> Supabase (TODO Sprint 1)     | lấy mẫu foreground
    | SQLite: outbox + rules_cache + usage_samples         | cảnh báo, khóa, xin thêm giờ
```

**Vì sao foreground tracking nằm ở Tray:** Service chạy ở session 0 nên `GetForegroundWindow()` không nhìn thấy cửa sổ của người dùng. Tray App (chạy trong user session) lấy mẫu mỗi 15 giây rồi gửi về Service qua IPC. Xem ghi chú trong `ForegroundTracker.cs`.

## Nguyên tắc dữ liệu (chỉ thu metadata)

Theo `docs/01-PRD.md` mục 5 và `docs/03-SECURITY.md`:

- **Chỉ thu:** tên process, hash đường dẫn exe, thời lượng, domain (giai đoạn extension).
- **KHÔNG:** keylogger, đọc nội dung/tin nhắn/file, mic/camera. **KHÔNG thu tiêu đề cửa sổ** — code cố tình không gọi `GetWindowText`.
- **Đường dẫn exe chỉ lưu dạng hash SHA-256** (đường dẫn thô có thể lộ username Windows).
- **Device token** lưu bằng DPAPI (`DataProtectionScope.LocalMachine`), chỉ lưu hash ở DB. Không hardcode URL/key, không ghi token vào log.
- **IPC Named Pipe có ACL:** chỉ SYSTEM và nhóm Users được kết nối (xem `IpcPipeServer.cs`).
- **Log local** xoay vòng, tối đa 10MB/file, không chứa token/mật khẩu.
- **Mã PIN** (thoát Tray / gỡ Agent) khác mật khẩu đăng nhập và khác device token. Mã PIN thật đã là PBKDF2-SHA256 100.000 vòng (`PinHash.cs`, định dạng `v1$100000$<salt>$<hash>`); mã PIN thoát Tray dùng một lần (nhập đúng → gỡ khỏi server qua RPC migration 8), mã PIN gỡ cài đặt dùng chung mã này nhưng kiểm tra CHỈ xác minh, KHÔNG tiêu thụ (`Service.exe verify-pin`, xem `VerifyPinCli.cs`).

## Build trên Windows

Yêu cầu: **Windows 10/11 64-bit + .NET 8 SDK** (8.0.x).

```powershell
# Từ thư mục apps/pc-agent/
dotnet restore SafePC.Agent.sln
dotnet build SafePC.Agent.sln -c Release
```

Publish để đóng gói installer (self-contained, không cần cài .NET runtime trên máy con):

```powershell
dotnet publish src/SafePC.Agent.Service/SafePC.Agent.Service.csproj -c Release -r win-x64 --self-contained true -o publish/Service
dotnet publish src/SafePC.Agent.Tray/SafePC.Agent.Tray.csproj -c Release -r win-x64 --self-contained true -o publish/Tray
```

Sau đó mở `installer/SafePCAgent.iss` bằng **Inno Setup 6** và Build để ra file cài đặt tại `installer-output\SafePCAgentSetup-0.1.0.exe`.

## Cài thử (khi đã có installer)

1. Chạy file cài đặt bằng quyền **Admin** (cài All Users vào `C:\Program Files\SafePC Agent`).
2. Installer đăng ký Service `SafePCAgent` (tự chạy khi khởi động, quyền SYSTEM), bật recovery tự khởi động lại sau 60 giây nếu Service chết, và đăng ký Tray App tự chạy khi đăng nhập.
3. Kiểm tra: mở `services.msc` thấy "SafePC Agent" đang chạy; tray icon SafePC hiện ở khay hệ thống.
4. Dữ liệu local nằm ở `%ProgramData%\SafePC` (Service) và `%LocalAppData%\SafePC\logs` (Tray).
5. **Pairing bằng mã 6 số đã làm:** Service có lệnh `SafePC.Agent.Service.exe pair <mã 6 số> [--force]` (đổi mã lấy device token qua RPC, lưu token bằng DPAPI xuống `%ProgramData%\SafePC`); từ 19/11/2026 bộ cài có trang nhập mã ghép nối (chạy lệnh này trong trình cài, nhập sai được nhập lại, có "Bỏ qua, ghép nối sau"). Cấu hình URL Supabase trong `appsettings.json` của Service (bản publish) — không ghi secret/key vào file này.

## Chống can thiệp & watchdog (ghi chú)

- Service chạy quyền SYSTEM + recovery restart sau 60 giây (cấu hình bằng `sc.exe failure` trong installer). Standard User không dừng được Service SYSTEM, không gỡ được app cài All Users nếu không có Admin.
- Tray App tự kết nối lại IPC sau 5 giây nếu mất kết nối tới Service.
- Gỡ cài đặt yêu cầu mã PIN phụ huynh (Sprint 4): bộ gỡ hỏi mã bằng form che ký tự (tối đa 3 lần nhập), kiểm tra bằng `Service.exe verify-pin`; chưa đặt mã PIN thì gỡ bằng quyền Admin như trước; gỡ im lặng khi đã đặt mã PIN thì bị chặn (gỡ mã PIN trên Dashboard trước rồi gỡ im lặng).
- **Giới hạn thành thật** (docs/02 mục 5): nếu con có quyền Admin / boot Safe Mode / cài lại Windows thì mọi biện pháp phần mềm đều có thể bị vượt qua. Phụ huynh giữ quyền Admin, bật BitLocker + Secure Boot.
- **Chưa có code signing:** installer và file .exe chưa được ký số (theo roadmap, mua chứng chỉ sau). Windows SmartScreen có thể cảnh báo khi cài.

## Trạng thái skeleton — cái gì chưa làm thật

Mọi chỗ skeleton đều có ghi `TODO` trong code. Tóm tắt:

| Hạng mục | Trạng thái |
|---|---|
| Gọi Supabase thật (heartbeat, poll, rules, batch) | TODO Sprint 1 — `SupabaseApiClient` chỉ trả về rỗng |
| Pairing bằng mã 6 số | Đã làm — lệnh `pair` + trang nhập mã trong bộ cài (19/11/2026) |
| Thi hành rules thật (chặn app, `LockWorkStation` sau đếm ngược 60s) | TODO Sprint 2 |
| Gửi yêu cầu xin thêm giờ lên bảng `requests`, nhận quyết định | TODO Sprint 2 |
| Rule theo app / website, daily_limit theo thứ | TODO Sprint 1–2 |
| PIN thật (PBKDF2, khóa sau 5 lần sai), PIN khi gỡ cài đặt | Đã triển khai (Sprint 4: `verify-pin` + form PIN trong bộ gỡ; chưa kiểm chứng trên máy thật) |
| Icon Tray riêng, đếm ngược cảnh báo trực tiếp | TODO Sprint 1 |
| Code signing | Sau khi có pháp nhân/budget |

## Đọc thêm

- `../../docs/01-PRD.md` (mục 2.1–2.4, 2.6, mục 5)
- `../../docs/02-ARCHITECTURE.md` (mục 1–2, 4.1–4.2, mục 5)
- `../../docs/03-SECURITY.md` (mục 2–4)
