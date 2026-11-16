; SafePC Agent — Inno Setup script (skeleton Sprint 0)
;
; Cách dùng (trên Windows, sau khi publish — xem apps/pc-agent/README.md):
;   1. Publish Service và Tray vào thư mục publish\Service và publish\Tray.
;   2. Mở file này bằng Inno Setup 6 và chọn Build > Compile.
;   3. File cài đặt ra tại installer-output\SafePCAgentSetup-0.1.0.exe
;
; LƯU Ý BẢO MẬT (docs/03-SECURITY.md):
; - CHƯA có code signing: installer và file .exe chưa được ký số. Theo roadmap,
;   ký số (EV/Code Signing) sẽ mua sau khi có pháp nhân/budget; trước mắt chỉ
;   kiểm tra hash + tải qua HTTPS. Windows SmartScreen có thể cảnh báo.
; - TODO Sprint 4: gỡ cài đặt yêu cầu mã PIN phụ huynh (hiện gỡ bình thường
;   bằng quyền Admin, vì Standard User không gỡ được app cài All Users).

#define AppVersion "0.1.0"

[Setup]
AppName=SafePC Agent
AppVersion={#AppVersion}
AppPublisher=SafePC
DefaultDirName={commonpf64}\SafePC Agent
DefaultGroupName=SafePC
; Cài All Users, bắt buộc quyền Admin (Standard User không cài/gỡ được).
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\installer-output
OutputBaseFilename=SafePCAgentSetup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
DisableProgramGroupPage=yes
UninstallDisplayName=SafePC Agent

[Files]
; Thư mục publish phải tồn tại trước khi biên dịch script này.
Source: "..\publish\Service\*"; DestDir: "{app}\Service"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\publish\Tray\*"; DestDir: "{app}\Tray"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\SafePC Agent"; Filename: "{app}\Tray\SafePC.Agent.Tray.exe"

[Registry]
; Tray App tự chạy khi bất kỳ user nào đăng nhập (All Users).
Root: HKLM; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "SafePC Agent"; ValueData: """{app}\Tray\SafePC.Agent.Tray.exe"""; Flags: uninsdeletevalue

[Run]
; Đăng ký Windows Service chạy quyền SYSTEM, tự động khi khởi động.
; Lưu ý: sau "binPath=" và "start=" bắt buộc có khoảng trắng (cú pháp sc.exe).
Filename: "{sys}\sc.exe"; Parameters: "create SafePCAgent binPath= ""{app}\Service\SafePC.Agent.Service.exe"" start= auto DisplayName= ""SafePC Agent"""; Flags: runhidden
; Recovery: Service bị dừng bất thường thì tự khởi động lại sau 60 giây.
Filename: "{sys}\sc.exe"; Parameters: "failure SafePCAgent reset= 86400 actions= restart/60000/restart/60000/restart/60000"; Flags: runhidden
Filename: "{sys}\sc.exe"; Parameters: "start SafePCAgent"; Flags: runhidden
; Khởi động Tray App ngay sau khi cài (trong session hiện tại).
Filename: "{app}\Tray\SafePC.Agent.Tray.exe"; Description: "Khởi động SafePC Tray"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Dừng Tray đang chạy trước: nếu không, icon Tray vẫn còn sau khi gỡ và
; process cũ giữ khóa file khi cài đè (lỗi gặp trên máy thật ngày 2026-11-16).
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM SafePC.Agent.Tray.exe"; Flags: runhidden
; Dừng và xóa Service khi gỡ cài đặt. TODO Sprint 4: yêu cầu mã PIN trước.
Filename: "{sys}\sc.exe"; Parameters: "stop SafePCAgent"; Flags: runhidden
Filename: "{sys}\sc.exe"; Parameters: "delete SafePCAgent"; Flags: runhidden

[Code]
// Trước khi cài (kể cả cài đè bản cũ): dừng Tray và Service đang chạy để
// file không bị khóa khi ghi đè. Lỗi (không có process/service) thì bỏ qua.
// Ghi chú 2026-11-16: trước đây gỡ cài đặt không dừng Tray nên icon vẫn còn
// sau khi gỡ, và cài đè lên process đang chạy gây ra bản cài chắp vá.
function PrepareToInstall(): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM SafePC.Agent.Tray.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\sc.exe'), 'stop SafePCAgent', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;
