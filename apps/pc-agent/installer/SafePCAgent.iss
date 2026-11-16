; SafePC Agent — Inno Setup script (skeleton Sprint 0)
;
; Cách dùng (trên Windows, sau khi publish — xem apps/pc-agent/README.md):
;   1. Publish Service, Tray và NativeHost vào thư mục publish\Service,
;      publish\Tray và publish\NativeHost.
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
; Native messaging host cho extension trình duyệt (Sprint 2 đợt 2). Manifest
; com.safepc.agent.json KHÔNG đóng gói sẵn: [Code] sinh ra lúc cài đặt xong vì
; nó phải chứa đường dẫn tuyệt đối tới exe (xem WriteNativeHostManifest).
Source: "..\publish\NativeHost\*"; DestDir: "{app}\NativeHost"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\SafePC Agent"; Filename: "{app}\Tray\SafePC.Agent.Tray.exe"

[Registry]
; Tray App tự chạy khi bất kỳ user nào đăng nhập (All Users).
Root: HKLM; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "SafePC Agent"; ValueData: """{app}\Tray\SafePC.Agent.Tray.exe"""; Flags: uninsdeletevalue
; Native messaging host cho extension (Sprint 2 đợt 2): Chrome và Edge đọc
; giá trị mặc định của khóa này để tìm file manifest com.safepc.agent.json.
; Bộ cài chạy ở chế độ 64-bit (ArchitecturesInstallIn64BitMode) nên khóa ghi
; vào registry view 64-bit mà Chrome/Edge 64-bit đọc. uninsdeletekey: gỡ cài
; đặt thì xóa cả khóa. ID extension trong manifest hiện là placeholder
; "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" (32 ký tự, đúng định dạng); ID thật lấy
; từ lúc đăng extension lên store (xem apps/browser-extension/README.md).
Root: HKLM; Subkey: "SOFTWARE\Google\Chrome\NativeMessagingHosts\com.safepc.agent"; ValueType: string; ValueName: ""; ValueData: "{app}\NativeHost\com.safepc.agent.json"; Flags: uninsdeletekey
Root: HKLM; Subkey: "SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.safepc.agent"; ValueType: string; ValueName: ""; ValueData: "{app}\NativeHost\com.safepc.agent.json"; Flags: uninsdeletekey

[UninstallDelete]
; Manifest do [Code] sinh ra lúc cài đặt (không nằm trong [Files]) nên phải
; xóa tường minh khi gỡ; các file còn lại trong {app} Inno tự xóa.
Type: files; Name: "{app}\NativeHost\com.safepc.agent.json"

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
; Dừng và xóa Service khi gỡ cài đặt. net stop chờ dừng hẳn (sc.exe stop thì
; không). TODO Sprint 4: yêu cầu mã PIN trước.
Filename: "{sys}\net.exe"; Parameters: "stop SafePCAgent /y"; Flags: runhidden
Filename: "{sys}\sc.exe"; Parameters: "delete SafePCAgent"; Flags: runhidden

[Code]
// Trước khi cài (kể cả cài đè bản cũ): dừng Tray và Service đang chạy, và
// ĐỢI chúng thoát/dừng hẳn rồi mới ghi đè file. Lỗi (không có
// process/service) thì bỏ qua.
// Ghi chú 2026-11-16: trước đây gỡ cài đặt không dừng Tray nên icon vẫn còn
// sau khi gỡ, và cài đè lên process đang chạy gây ra bản cài chắp vá
// (thiếu file UIAutomationTypes.dll trên máy thật). Ngoài ra sc.exe stop
// trả về ngay khi vừa YÊU CẦU dừng, file Service vẫn bị khóa lúc ghi đè —
// nên dùng net stop (chờ dừng hẳn) và vòng đợi Tray thoát hẳn.
// Lưu ý: prototype phải đúng dạng event function của Inno Setup
// (var NeedsRestart: Boolean), khai báo không tham số thì ISCC báo
// "Invalid prototype" (gặp ở CI run #47, 2026-11-16).

// Kiểm tra process Tray còn chạy không (qua tasklist).
function IsTrayRunning(): Boolean;
var
  ResultCode: Integer;
  TempFile: String;
  Lines: TArrayOfString;
  I: Integer;
begin
  Result := False;
  TempFile := ExpandConstant('{tmp}\safepc_tasklist.txt');
  Exec(ExpandConstant('{cmd}'), '/C tasklist /FI "IMAGENAME eq SafePC.Agent.Tray.exe" /NH > "' + TempFile + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if LoadStringsFromFile(TempFile, Lines) then
  begin
    for I := 0 to GetArrayLength(Lines) - 1 do
    begin
      if Pos('SafePC.Agent.Tray.exe', Lines[I]) > 0 then
      begin
        Result := True;
        Break;
      end;
    end;
  end;
  DeleteFile(TempFile);
end;

// Đợi Tray thoát hẳn, tối đa TimeoutMs. Trả về True nếu đã thoát.
function WaitForTrayExit(TimeoutMs: Integer): Boolean;
var
  Elapsed: Integer;
begin
  Elapsed := 0;
  while IsTrayRunning() and (Elapsed < TimeoutMs) do
  begin
    Sleep(500);
    Elapsed := Elapsed + 500;
  end;
  Result := not IsTrayRunning();
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  // Dừng Tray ở mọi session rồi đợi thoát hẳn (tối đa 10 giây).
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM SafePC.Agent.Tray.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  WaitForTrayExit(10000);
  // net stop CHỜ service dừng hẳn mới trả về (sc.exe stop thì không).
  Exec(ExpandConstant('{sys}\net.exe'), 'stop SafePCAgent /y', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;

// Native messaging host (Sprint 2 đợt 2): sinh file manifest
// com.safepc.agent.json sau khi cài đặt xong, vì trường "path" trong manifest
// phải là đường dẫn TUYỆT ĐỐI tới exe. Cài đè cũng sinh lại (ghi đè) nên
// manifest luôn khớp vị trí cài đặt hiện tại.
// Extension ID "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" là placeholder 32 ký tự
// đúng định dạng; ID thật lấy từ lúc đăng extension lên Chrome Web Store /
// Edge Add-ons (hoặc key cố định khi đóng gói), rồi cập nhật cả chỗ này và
// README của extension.
procedure WriteNativeHostManifest();
var
  ExePath: String;
  Manifest: String;
begin
  ExePath := ExpandConstant('{app}\NativeHost\SafePC.Agent.NativeHost.exe');
  // JSON yêu cầu backslash nhân đôi trong chuỗi đường dẫn Windows.
  ExePath := StringChange(ExePath, '\', '\\');
  Manifest :=
    '{' + #13#10 +
    '  "name": "com.safepc.agent",' + #13#10 +
    '  "description": "SafePC Agent native messaging host",' + #13#10 +
    '  "path": "' + ExePath + '",' + #13#10 +
    '  "type": "stdio",' + #13#10 +
    '  "allowed_origins": [' + #13#10 +
    '    "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"' + #13#10 +
    '  ]' + #13#10 +
    '}' + #13#10;
  SaveStringToFile(ExpandConstant('{app}\NativeHost\com.safepc.agent.json'), Manifest, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    WriteNativeHostManifest();
  end;
end;
