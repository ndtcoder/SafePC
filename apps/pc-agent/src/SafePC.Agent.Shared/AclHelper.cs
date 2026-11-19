using System.Security.AccessControl;
using System.Security.Principal;

namespace SafePC.Agent.Shared;

/// <summary>
/// Hạn chế ACL của một FILE nhạy cảm trên máy con (device token, hash mã
/// PIN, SQLite agent.db) chỉ còn SYSTEM + Administrators toàn quyền.
///
/// Bối cảnh (Sprint 4, docs/03-SECURITY.md §4): các file này nằm dưới
/// %ProgramData%\SafePC và trước đây mang ACL kế thừa mặc định — tài khoản
/// Standard User (con) ĐỌC được file. DPAPI scope LocalMachine không cứu
/// được: bất kỳ user nào trên máy cũng giải mã được dữ liệu DPAPI
/// LocalMachine, nên "DPAPI + file đọc được" tương đương với "con đọc
/// được token/hash". Khóa ACL ở cấp file mới là lớp bảo vệ thật (Service
/// chạy SYSTEM ghi file, CLI gỡ cài đặt chạy quyền Admin đọc file — cả hai
/// đều nằm trong SYSTEM + Administrators nên không bị ảnh hưởng).
///
/// Best-effort: mọi lỗi (kể cả PlatformNotSupportedException khi chạy trên
/// Linux, file không tồn tại, không đủ quyền) đều trả về false, không ném.
/// Hàm kiểm tra trước rồi mới ghi nên gọi lặp không nhân đôi ACE.
/// </summary>
public static class AclHelper
{
    /// <summary>
    /// Khóa file: chặn kế thừa, xóa mọi rule tường minh, chỉ giữ SYSTEM +
    /// Administrators toàn quyền. Trả về true khi file đã ở đúng trạng thái
    /// (hoặc vừa được khóa xong), false khi không khóa được.
    /// </summary>
    public static bool RestrictFileToSystemAndAdmins(string filePath)
    {
        try
        {
            var fileInfo = new FileInfo(filePath);
            if (!fileInfo.Exists)
            {
                return false;
            }

            FileSecurity security = fileInfo.GetAccessControl();
            if (IsAlreadyRestricted(security))
            {
                return true;
            }

            security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);

            // Xóa mọi rule tường minh còn lại để lần gọi sau không nhân đôi ACE.
            List<FileSystemAccessRule> existing = security
                .GetAccessRules(includeExplicit: true, includeInherited: false, targetType: typeof(SecurityIdentifier))
                .OfType<FileSystemAccessRule>()
                .ToList();
            foreach (FileSystemAccessRule rule in existing)
            {
                security.RemoveAccessRule(rule);
            }

            security.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                FileSystemRights.FullControl,
                AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                FileSystemRights.FullControl,
                AccessControlType.Allow));

            fileInfo.SetAccessControl(security);
            return true;
        }
        catch (Exception)
        {
            // Không khóa được (VD: chạy trên Linux, file đang bị khóa):
            // file vẫn dùng được với ACL cũ — lớp DPAPI còn lại.
            return false;
        }
    }

    /// <summary>True khi DACL đã bị chặn kế thừa và chỉ còn đúng 2 rule SYSTEM + Administrators toàn quyền.</summary>
    private static bool IsAlreadyRestricted(FileSecurity security)
    {
        try
        {
            if (!security.AreAccessRulesProtected)
            {
                return false;
            }

            List<FileSystemAccessRule> rules = security
                .GetAccessRules(includeExplicit: true, includeInherited: false, targetType: typeof(SecurityIdentifier))
                .OfType<FileSystemAccessRule>()
                .ToList();
            if (rules.Count != 2)
            {
                return false;
            }

            string systemSid = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null).Value;
            string adminsSid = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null).Value;
            foreach (FileSystemAccessRule rule in rules)
            {
                if (rule.AccessControlType != AccessControlType.Allow
                    || rule.FileSystemRights != FileSystemRights.FullControl
                    || (rule.IdentityReference.Value != systemSid && rule.IdentityReference.Value != adminsSid))
                {
                    return false;
                }
            }

            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }
}
