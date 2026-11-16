using System.Windows;

namespace SafePC.Agent.Tray;

/// <summary>
/// Hộp nhập mã PIN khi thoát Tray App (mã PIN khác mật khẩu đăng nhập,
/// khác device token — docs/03-SECURITY.md mục 1).
///
/// SKELETON — Sprint 0: chưa có PIN nào được cấu hình nên luôn từ chối
/// (fail closed: không thoát được). Khi dev/test, dừng Tray qua Task Manager
/// hoặc dừng từ IDE.
/// TODO Sprint 4: đọc salt + hash PIN từ nơi lưu an toàn (DPAPI), kiểm tra
/// bằng PinHash.Verify, khóa 30 phút sau 5 lần nhập sai.
/// </summary>
public partial class PinDialog : Window
{
    public PinDialog()
    {
        InitializeComponent();
        _ = PinBox.Focus();
    }

    private void OkButton_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(PinBox.Password))
        {
            ErrorText.Text = "Hãy nhập mã PIN.";
            return;
        }

        // TODO Sprint 4: PinHash.Verify(PinBox.Password, salt, hash) rồi mới
        // đặt DialogResult = true. Skeleton: chưa cấu hình PIN nên từ chối.
        ErrorText.Text = "Chưa cấu hình mã PIN (skeleton). Không thể thoát.";
        PinBox.Clear();
    }

    private void CancelButton_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
    }
}
