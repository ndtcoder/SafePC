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
; - Gỡ cài đặt yêu cầu mã PIN phụ huynh (Sprint 4, xem InitializeUninstall ở
;   cuối [Code]): mã PIN thoát Tray của máy, kiểm tra bằng lệnh
;   Service.exe verify-pin. Chưa đặt mã PIN thì gỡ bằng quyền Admin như trước.

#ifndef AppVersion
#define AppVersion "0.1.0"
#endif

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
; đặt thì xóa cả khóa. ID extension trong manifest là ID thật của
; extension SafePC trên Edge (djcgbhjbmcccdgedbmfihdpeeanmldbd), lấy từ
; máy test 17/11/2026.
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
; không). Mã PIN được kiểm tra TRƯỚC bước này (InitializeUninstall ở cuối
; [Code]) nên tới đây gỡ đã được phép.
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

// Biến toàn cục cho trang ghép nối (tạo trong InitializeWizard).
var
  PairPage: TInputQueryWizardPage;
  PairSkipCheckBox: TCheckBox;
  PairStatusLabel: TLabel;
  // True sau khi ghép nối thành công (hoặc máy đã ghép nối từ trước và
  // người dùng chọn giữ nguyên): bấm Tiếp theo sẽ đi tiếp mà không
  // chạy lại PairingCli.
  PairingDone: Boolean;
  // Device id đọc được từ output của PairingCli khi thành công.
  PairingDeviceId: String;

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
// Extension ID "djcgbhjbmcccdgedbmfihdpeeanmldbd" là ID thật của extension
// SafePC trên Edge, lấy từ máy test 17/11/2026 (xem
// apps/browser-extension/README.md). Nướng ID này vào bộ cài để cài đè
// không ghi đè manifest bằng placeholder và phá native messaging.
// Nhân đôi backslash trong đường dẫn Windows để đưa vào JSON.
// KHÔNG dùng StringChange/StringChangeEx: cả hai đều làm ISCC 6.7.1 báo
// "Type mismatch" (CI run #80/#81). Vòng lặp thủ công chỉ dùng Length,
// chỉ số chuỗi và nối chuỗi — không phụ thuộc hàm thư viện nào.
function DoubleBackslashes(const S: String): String;
var
  I: Integer;
begin
  Result := '';
  for I := 1 to Length(S) do
  begin
    if S[I] = '\' then
      Result := Result + '\\'
    else
      Result := Result + S[I];
  end;
end;

procedure WriteNativeHostManifest();
var
  ExePath: String;
  Manifest: String;
begin
  ExePath := ExpandConstant('{app}\NativeHost\SafePC.Agent.NativeHost.exe');
  // JSON yêu cầu backslash nhân đôi trong chuỗi đường dẫn Windows.
  ExePath := DoubleBackslashes(ExePath);
  Manifest :=
    '{' + #13#10 +
    '  "name": "com.safepc.agent",' + #13#10 +
    '  "description": "SafePC Agent native messaging host",' + #13#10 +
    '  "path": "' + ExePath + '",' + #13#10 +
    '  "type": "stdio",' + #13#10 +
    '  "allowed_origins": [' + #13#10 +
    '    "chrome-extension://djcgbhjbmcccdgedbmfihdpeeanmldbd/"' + #13#10 +
    '  ]' + #13#10 +
    '}' + #13#10;
  SaveStringToFile(ExpandConstant('{app}\NativeHost\com.safepc.agent.json'), Manifest, False);
end;

// =====================================================================
// Ghép nối máy trong trình cài đặt (flow cài đặt cho phụ huynh khác).
//
// Trang nhập mã xuất hiện SAU trang Installing (CreateInputQueryPage
// với AfterID = wpInstalling), ngay trước trang Finished. Lý do chọn
// vị trí này:
// - Lệnh ghép nối CHÍNH LÀ file Service đã cài
//   ({app}\Service\SafePC.Agent.Service.exe pair <mã 6 số>); file này
//   chỉ tồn tại trên đĩa sau bước chép file. Đặt trang trước khi cài
//   thì phải giải nén tạm cả thư mục publish self-contained (~90 MB,
//   hàng trăm file DLL + appsettings.json) — giòn và lãng phí.
// - Khi trang này hiện, các mục [Run] không có cờ postinstall đã chạy
//   xong (Service đã được tạo + khởi động; Tray thì chờ tới khi bấm
//   Finish). PairingCli được thiết kế để chạy trong lúc Service đang
//   chạy: Service tự nhận token mới trong vòng 1 phút nên không cần
//   khởi động lại (xem PairingCli.cs).
// - Nhập sai mã thì NextButtonClick trả về False: wizard ở lại trang
//   để nhập lại, không phải cài lại từ đầu.
// - Cài đặt im lặng (/SILENT, /VERYSILENT): không có người nhập mã,
//   trang bị bỏ qua và máy được cài ở trạng thái chờ ghép nối như
//   trước (xem NextButtonClick).
//
// Mã thoát của PairingCli (xem PairingCli.cs): 0 = thành công,
// 1 = sai cú pháp (không xảy ra vì mã đã kiểm tra 6 chữ số trước),
// 2 = máy đã ghép nối rồi, 3 = mã sai/hết hạn/mất mạng/không đủ quyền.
// =====================================================================

// Mã ghép nối hợp lệ: đúng 6 chữ số.
function IsSixDigitCode(const Code: String): Boolean;
var
  I: Integer;
begin
  Result := False;
  if Length(Code) <> 6 then
    Exit;
  for I := 1 to Length(Code) do
  begin
    if (Code[I] < '0') or (Code[I] > '9') then
      Exit;
  end;
  Result := True;
end;

// Trích device id từ output của PairingCli ("Device id: <guid>").
// Chỉ tìm chuỗi ASCII nên không bị ảnh hưởng nếu console ghi UTF-8.
function ExtractDeviceIdFromPairOutput(const OutFile: String): String;
var
  Lines: TArrayOfString;
  I: Integer;
  P: Integer;
  Marker: String;
begin
  Result := '';
  Marker := 'Device id: ';
  if LoadStringsFromFile(OutFile, Lines) then
  begin
    for I := 0 to GetArrayLength(Lines) - 1 do
    begin
      P := Pos(Marker, Lines[I]);
      if P > 0 then
      begin
        Result := Trim(Copy(Lines[I], P + Length(Marker), Length(Lines[I])));
        Break;
      end;
    end;
  end;
end;

// Chạy PairingCli với mã đã nhập. Trả về exit code của CLI (0/1/2/3).
// Output của CLI được chuyển vào file tạm để trích device id khi thành
// công. Lưu ý: đường dẫn exe và file output đều đặt trong dấu nháy kép
// vì có thể chứa khoảng trắng.
function RunPairingCli(const Code: String; Force: Boolean): Integer;
var
  ExePath: String;
  OutFile: String;
  Params: String;
  Started: Boolean;
  ResultCode: Integer;
begin
  Result := 3;
  PairingDeviceId := '';
  ExePath := ExpandConstant('{app}\Service\SafePC.Agent.Service.exe');
  OutFile := ExpandConstant('{tmp}\safepc_pair_out.txt');
  Params := '/C ""' + ExePath + '" pair ' + Code;
  if Force then
    Params := Params + ' --force';
  Params := Params + ' > "' + OutFile + '" 2>&1"';
  Started := Exec(ExpandConstant('{cmd}'), Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if not Started then
    Exit;
  Result := ResultCode;
  if Result = 0 then
    PairingDeviceId := ExtractDeviceIdFromPairOutput(OutFile);
  DeleteFile(OutFile);
end;

procedure ShowPairSuccess(const RePaired: Boolean);
var
  Msg: String;
begin
  if RePaired then
    Msg := 'Ghép nối lại thành công! Máy "'
  else
    Msg := 'Ghép nối thành công! Máy "';
  Msg := Msg + ExpandConstant('{computername}') + '" đã được ghép nối với tài khoản phụ huynh và sẽ hiện trên Dashboard (trạng thái Online trong vòng 1 phút).';
  if PairingDeviceId <> '' then
    Msg := Msg + #13#10 + 'Device id: ' + PairingDeviceId;
  PairStatusLabel.Caption := 'Ghép nối thành công.';
  MsgBox(Msg, mbInformation, MB_OK);
end;

procedure ShowPairFailure;
begin
  PairStatusLabel.Caption := 'Ghép nối thất bại. Mã có thể đã sai, hết hạn (chỉ 5 phút) hoặc máy mất mạng. Lấy mã mới trên Dashboard rồi nhập lại, hoặc tích "Bỏ qua" để cài đặt xong rồi ghép nối sau.';
  MsgBox('Ghép nối thất bại. Mã có thể đã sai, hết hạn (mã chỉ có hiệu lực 5 phút) hoặc máy mất mạng.' + #13#10 + 'Lấy mã mới trên Dashboard (trang Thiết bị, "Ghép nối máy mới") rồi nhập lại, hoặc tích "Bỏ qua, ghép nối sau" để cài đặt xong rồi ghép nối sau.', mbError, MB_OK);
end;

// Thử ghép nối với mã trên trang. Trả True nếu wizard được đi tiếp
// (thành công, đã ghép nối từ trước, hoặc người dùng chọn bỏ qua);
// trả False nếu phải ở lại trang để nhập lại mã.
function TryPairOnPage: Boolean;
var
  Code: String;
  ExitCode: Integer;
begin
  Result := False;
  if PairingDone then
  begin
    Result := True;
    Exit;
  end;
  Code := Trim(PairPage.Values[0]);
  if PairSkipCheckBox.Checked then
  begin
    PairStatusLabel.Caption := 'Đã bỏ qua ghép nối. Máy sẽ chạy ở trạng thái chờ ghép nối; ghép nối sau bằng lệnh PowerShell.';
    Result := True;
    Exit;
  end;
  if Code = '' then
  begin
    if MsgBox('Chưa nhập mã ghép nối. Máy sẽ được cài đặt nhưng chưa ghép nối với tài khoản phụ huynh. Ghép nối sau bằng lệnh PowerShell hoặc chạy lại bộ cài.' + #13#10 + #13#10 + 'Tiếp tục cài đặt mà không ghép nối?', mbConfirmation, MB_YESNO) = IDYES then
    begin
      PairStatusLabel.Caption := 'Đã bỏ qua ghép nối. Máy sẽ chạy ở trạng thái chờ ghép nối; ghép nối sau bằng lệnh PowerShell.';
      Result := True;
    end
    else
      PairStatusLabel.Caption := 'Chưa nhập mã ghép nối. Nhập mã 6 số rồi bấm Tiếp theo để ghép nối.';
    Exit;
  end;
  if not IsSixDigitCode(Code) then
  begin
    PairStatusLabel.Caption := 'Mã ghép nối phải gồm đúng 6 chữ số. Kiểm tra lại mã trên Dashboard rồi nhập lại.';
    MsgBox('Mã ghép nối phải gồm đúng 6 chữ số.' + #13#10 + 'Kiểm tra lại mã trên Dashboard (trang Thiết bị, "Ghép nối máy mới") rồi nhập lại.', mbError, MB_OK);
    Exit;
  end;
  PairStatusLabel.Caption := 'Đang ghép nối, vui lòng đợi...';
  ExitCode := RunPairingCli(Code, False);
  if ExitCode = 0 then
  begin
    PairingDone := True;
    ShowPairSuccess(False);
    Result := True;
  end
  else if ExitCode = 2 then
  begin
    if MsgBox('Máy này đã ghép nối rồi. Ghép nối lại với mã mới sẽ thay thiết bị đã ghép nối trước đây (thiết bị cũ vẫn còn trên Dashboard, phụ huynh có thể xóa nếu không dùng nữa).' + #13#10 + #13#10 + 'Ghép nối lại với mã mới?', mbConfirmation, MB_YESNO) = IDYES then
    begin
      PairStatusLabel.Caption := 'Đang ghép nối lại, vui lòng đợi...';
      ExitCode := RunPairingCli(Code, True);
      if ExitCode = 0 then
      begin
        PairingDone := True;
        ShowPairSuccess(True);
        Result := True;
      end
      else
        ShowPairFailure;
    end
    else
    begin
      PairingDone := True;
      PairStatusLabel.Caption := 'Máy đã ghép nối từ trước, giữ nguyên.';
      Result := True;
    end;
  end
  else
    ShowPairFailure;
end;

procedure InitializeWizard;
begin
  PairPage := CreateInputQueryPage(wpInstalling,
    'Ghép nối máy với SafePC',
    'Nhập mã ghép nối để máy này hiện trên Dashboard của phụ huynh.',
    'Lấy mã trên Dashboard: mở trang Thiết bị, bấm "Ghép nối máy mới" rồi tạo mã cho con. Mã 6 số chỉ có hiệu lực 5 phút, nên tạo mã ngay trước khi chạy bộ cài. Để trống ô mã rồi bấm Tiếp theo để bỏ qua và ghép nối sau.');
  PairPage.Add('Mã ghép nối (6 số):', False);

  PairStatusLabel := TLabel.Create(PairPage);
  PairStatusLabel.Parent := PairPage.Surface;
  PairStatusLabel.Left := 0;
  PairStatusLabel.Top := PairPage.SurfaceHeight - 84;
  PairStatusLabel.Width := PairPage.SurfaceWidth;
  PairStatusLabel.Height := 40;
  PairStatusLabel.AutoSize := False;
  PairStatusLabel.WordWrap := True;
  PairStatusLabel.Caption := 'Chưa ghép nối. Nhập mã rồi bấm Tiếp theo, hoặc tích "Bỏ qua" để cài đặt xong rồi ghép nối sau.';

  PairSkipCheckBox := TCheckBox.Create(PairPage);
  PairSkipCheckBox.Parent := PairPage.Surface;
  PairSkipCheckBox.Left := 0;
  PairSkipCheckBox.Top := PairPage.SurfaceHeight - 40;
  PairSkipCheckBox.Width := PairPage.SurfaceWidth;
  PairSkipCheckBox.Height := 17;
  PairSkipCheckBox.Caption := 'Bỏ qua, ghép nối sau (cài đặt xong, máy chưa ghép nối)';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = PairPage.ID then
  begin
    // Cài đặt im lặng (/SILENT, /VERYSILENT): không có người nhập mã.
    // Không hiện hộp thoại nào, luôn bỏ qua ghép nối để cài đặt hoàn
    // tất như trước (máy chạy ở trạng thái chờ ghép nối).
    if WizardSilent() then
      Result := True
    else
      Result := TryPairOnPage();
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  // Trang ghép nối nằm sau trang Installing: không cho quay lại trang
  // Installing (cài đặt đã xong; quay lại sẽ chạy lại bước cài).
  if CurPageID = PairPage.ID then
    WizardForm.BackButton.Enabled := False;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    WriteNativeHostManifest();
  end;
end;

// =====================================================================
// Mã PIN gỡ cài đặt (Sprint 4).
//
// Gỡ SafePC khỏi máy phải nhập đúng mã PIN phụ huynh — chính là mã PIN
// thoát Tray của máy đó (cột devices.exit_pin_hash, đặt trên Dashboard),
// không phải một mã riêng (một mã để phụ huynh nhớ; xem VerifyPinCli.cs).
// Bộ gỡ hỏi mã bằng form nhập có che ký tự (PasswordChar), tối đa 3 lần
// nhập trong một lần gỡ; kiểm tra bằng lệnh
//   {app}\Service\SafePC.Agent.Service.exe verify-pin <mã>
// (PBKDF2 trong Service.exe — Pascal Script không làm được PBKDF2).
// Mã thoát của verify-pin (xem VerifyPinCli.cs):
//   0 = được gỡ (đúng mã; hoặc máy chưa ghép nối; hoặc chưa đặt mã PIN —
//       mã PIN là lớp tự nguyện, chưa đặt thì gỡ bằng quyền Admin như trước)
//   3 = sai mã | 5 = không kiểm tra được (mất mạng + không cache) |
//   6 = khóa nhập sau 5 lần sai (30 phút).
// Mã riêng của bộ gỡ (không phải mã của verify-pin):
//   7 = không tìm thấy file Service.exe (bản cài có thể đã hỏng).
//
// Gỡ im lặng (/SILENT, /VERYSILENT): không có người nhập mã. Nếu máy đã
// đặt mã PIN thì gỡ im lặng BỊ CHẶN (InitializeUninstall trả False, không
// hiện hộp thoại nào — MsgBox trong gỡ im lặng sẽ treo bộ gỡ). Muốn gỡ im
// lặng thì gỡ mã PIN trên Dashboard trước (đợi ~1 phút để Agent đồng bộ),
// rồi gỡ im lặng; hoặc gỡ có giao diện và nhập mã PIN.
//
// Giới hạn đã biết (nói thẳng):
// - Mã PIN đi trên dòng lệnh của verify-pin nên process khác trên máy có
//   thể thấy nó trong Task Manager trong ~1 giây lúc kiểm tra (cùng mẫu
//   với mã ghép nối ở trang PairingCli). Lệnh không ghi mã PIN ra log/file.
// - PIN sai 3 lần trong form thì hủy gỡ; khóa nhập 30 phút do verify-pin
//   đếm bền vững (5 lần sai liên tiếp, kể cả qua các lần gỡ khác nhau).
// - Mã PIN chỉ bảo vệ đường gỡ được hỗ trợ (Control Panel / unins000.exe).
//   Tài khoản Admin vẫn xóa tay được file + service (sc delete) — mã PIN
//   là rào chắn chống gỡ vô tình/bị con gỡ khi có quyền Admin, không phải
//   khóa DRM chống lại admin quyết tâm (xem docs/08-HUONG-DAN-CAI-DAT.md).
// =====================================================================

// Chạy verify-pin với tham số cho trước, trả về mã thoát (0/2/3/5/6/7).
// Mặc định 5 (không kiểm tra được — fail-closed) khi không chạy được lệnh;
// 7 = không tìm thấy file Service.exe (bản cài có thể đã hỏng) — mã riêng
// để bộ gỡ báo đúng sự thật thay vì gộp vào "mất mạng" như mã 5.
function RunVerifyPinCli(const Args: String): Integer;
var
  ExePath: String;
  OutFile: String;
  Params: String;
  Started: Boolean;
  ResultCode: Integer;
begin
  Result := 5;
  ExePath := ExpandConstant('{app}\Service\SafePC.Agent.Service.exe');
  if not FileExists(ExePath) then
  begin
    Result := 7;
    Exit;
  end;
  OutFile := ExpandConstant('{tmp}\safepc_verify_pin_out.txt');
  Params := '/C ""' + ExePath + '" verify-pin ' + Args + ' > "' + OutFile + '" 2>&1"';
  Started := Exec(ExpandConstant('{cmd}'), Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  DeleteFile(OutFile);
  if not Started then
    Exit;
  Result := ResultCode;
end;

// Hỏi mã PIN bằng form nhập có che ký tự, tối đa 3 lần nhập. Trả True khi
// mã đúng (được gỡ), False khi hủy/khóa/không kiểm tra được/sai 3 lần.
function PromptUninstallPin: Boolean;
var
  Form: TForm;
  PromptLabel: TLabel;
  StatusLabel: TLabel;
  PinEdit: TEdit;
  OkButton: TButton;
  CancelButton: TButton;
  Attempts: Integer;
  Pin: String;
  ExitCode: Integer;
begin
  Result := False;
  Attempts := 0;
  Form := CreateCustomForm;
  { LƯU Ý: gọi KHÔNG có dấu () — ISCC báo "Invalid number of parameters"
    ở CreateCustomForm() (CI run #307). Hàm dựng sẵn này đăng ký không
    có () trong prototype nên Pascal Script bắt gọi không (). }
  try
    Form.Caption := 'Nhập mã PIN để gỡ SafePC Agent';
    Form.ClientWidth := 420;
    Form.ClientHeight := 190;

    PromptLabel := TLabel.Create(Form);
    PromptLabel.Parent := Form;
    PromptLabel.Left := 16;
    PromptLabel.Top := 16;
    PromptLabel.Width := 388;
    PromptLabel.Height := 40;
    PromptLabel.AutoSize := False;
    PromptLabel.WordWrap := True;
    PromptLabel.Caption := 'Gỡ SafePC Agent khỏi máy này cần mã PIN phụ huynh (mã PIN thoát Tray của máy, đặt trên Dashboard). Nhập mã rồi bấm OK.';

    PinEdit := TEdit.Create(Form);
    PinEdit.Parent := Form;
    PinEdit.Left := 16;
    PinEdit.Top := 64;
    PinEdit.Width := 200;
    PinEdit.Height := 23;
    PinEdit.PasswordChar := '*';
    PinEdit.MaxLength := 6;

    StatusLabel := TLabel.Create(Form);
    StatusLabel.Parent := Form;
    StatusLabel.Left := 16;
    StatusLabel.Top := 96;
    StatusLabel.Width := 388;
    StatusLabel.Height := 32;
    StatusLabel.AutoSize := False;
    StatusLabel.WordWrap := True;
    StatusLabel.Caption := '';

    OkButton := TButton.Create(Form);
    OkButton.Parent := Form;
    OkButton.Left := 232;
    OkButton.Top := 140;
    OkButton.Width := 80;
    OkButton.Height := 26;
    OkButton.Caption := 'OK';
    OkButton.ModalResult := mrOk;
    OkButton.Default := True;

    CancelButton := TButton.Create(Form);
    CancelButton.Parent := Form;
    CancelButton.Left := 320;
    CancelButton.Top := 140;
    CancelButton.Width := 80;
    CancelButton.Height := 26;
    CancelButton.Caption := 'Hủy';
    CancelButton.ModalResult := mrCancel;
    CancelButton.Cancel := True;

    while Attempts < 3 do
    begin
      if Form.ShowModal() <> mrOk then
        Exit;
      Pin := Trim(PinEdit.Text);
      if not IsSixDigitCode(Pin) then
      begin
        StatusLabel.Caption := 'Mã PIN phải gồm đúng 6 chữ số. Kiểm tra lại mã trên Dashboard rồi nhập lại.';
        PinEdit.Text := '';
        Continue;
      end;
      Attempts := Attempts + 1;
      ExitCode := RunVerifyPinCli(Pin);
      if ExitCode = 0 then
      begin
        Result := True;
        Exit;
      end;
      if ExitCode = 6 then
      begin
        MsgBox('Nhập sai mã PIN quá 5 lần liên tiếp. Nhập mã PIN đã bị khóa 30 phút — thử gỡ lại sau.', mbError, MB_OK);
        Exit;
      end;
      if ExitCode = 5 then
      begin
        MsgBox('Không kiểm tra được mã PIN (máy mất mạng và không có bản lưu mã trên máy). Kiểm tra mạng rồi thử gỡ lại.', mbError, MB_OK);
        Exit;
      end;
      if ExitCode = 7 then
      begin
        MsgBox('Không tìm thấy file Service của SafePC trên máy (bản cài có thể đã hỏng). Cài đè bản mới nhất rồi gỡ lại.', mbError, MB_OK);
        Exit;
      end;
      if ExitCode <> 3 then
      begin
        // Mã lạ (ví dụ mã thoát crash của CLR khi Service.exe hỏng nặng):
        // fail-closed nhưng báo đúng là lỗi không xác định, không đổ cho
        // "sai mã PIN" và không tiêu lượt thử của form.
        MsgBox('Không kiểm tra được mã PIN gỡ cài đặt (lỗi không xác định). Thử gỡ lại sau.', mbError, MB_OK);
        Exit;
      end;
      PinEdit.Text := '';
      if Attempts >= 3 then
      begin
        MsgBox('Nhập sai mã PIN 3 lần. Đã hủy gỡ cài đặt.', mbError, MB_OK);
        Exit;
      end;
      StatusLabel.Caption := 'Sai mã PIN. Còn ' + IntToStr(3 - Attempts) + ' lần thử trong lần gỡ này.';
    end;
  finally
    Form.Free();
  end;
end;

// Chạy trước khi gỡ bắt đầu (sau khi người dùng xác nhận gỡ): trả False
// để hủy gỡ, True để gỡ tiếp. Không hiện hộp thoại nào khi gỡ im lặng.
function InitializeUninstall(): Boolean;
var
  ProbeCode: Integer;
begin
  Result := False;
  ProbeCode := RunVerifyPinCli('--probe');
  if ProbeCode = 0 then
  begin
    // Máy chưa ghép nối, hoặc phụ huynh chưa đặt mã PIN: gỡ bằng quyền
    // Admin như trước Sprint 4, không hỏi mã.
    Result := True;
    Exit;
  end;
  if ProbeCode = 5 then
  begin
    // Không xác định được có mã PIN không (mất mạng + không cache):
    // fail-closed, chặn gỡ.
    if not UninstallSilent() then
      MsgBox('Không kiểm tra được mã PIN gỡ cài đặt (máy mất mạng và không có bản lưu mã trên máy). Kiểm tra mạng rồi thử gỡ lại.', mbError, MB_OK);
    Exit;
  end;
  if ProbeCode = 6 then
  begin
    // Đang khóa nhập sau 5 lần sai liên tiếp (30 phút): báo đúng lý do,
    // không gộp vào "lỗi không xác định" như trước.
    if not UninstallSilent() then
      MsgBox('Nhập sai mã PIN quá 5 lần nên đang khóa nhập 30 phút. Vui lòng thử gỡ lại sau khi hết khóa.', mbError, MB_OK);
    Exit;
  end;
  if ProbeCode = 7 then
  begin
    // Không tìm thấy file Service.exe: bản cài có thể đã hỏng.
    if not UninstallSilent() then
      MsgBox('Không tìm thấy file Service của SafePC trên máy (bản cài có thể đã hỏng). Cài đè bản mới nhất rồi gỡ lại.', mbError, MB_OK);
    Exit;
  end;
  if ProbeCode <> 2 then
  begin
    // Mã lạ, không nằm trong hợp đồng của verify-pin: fail-closed.
    if not UninstallSilent() then
      MsgBox('Không kiểm tra được mã PIN gỡ cài đặt (lỗi không xác định). Thử gỡ lại sau.', mbError, MB_OK);
    Exit;
  end;
  // Máy đã đặt mã PIN.
  if UninstallSilent() then
  begin
    // Gỡ im lặng không có người nhập mã: chặn. Muốn gỡ im lặng thì gỡ mã
    // PIN trên Dashboard trước (đợi ~1 phút để Agent đồng bộ), rồi gỡ im lặng.
    Exit;
  end;
  Result := PromptUninstallPin();
end;
