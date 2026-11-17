using System.Windows;

namespace SafePC.Agent.Tray;

/// <summary>Kết quả kiểm tra mã PIN do App trả về sau khi hỏi Service qua IPC.</summary>
/// <param name="Verified">PIN đúng.</param>
/// <param name="LockedOut">Đã sai quá số lần cho phép, đang bị khóa nhập.</param>
/// <param name="RemainingAttempts">Số lần thử còn lại trước khi bị khóa.</param>
/// <param name="PinConfigured">Phụ huynh đã đặt PIN hay chưa.</param>
/// <param name="Error">Lỗi kỹ thuật (không nối được Service...), null khi kiểm tra bình thường.</param>
public sealed record PinVerifyOutcome(bool Verified, bool LockedOut, int RemainingAttempts, bool PinConfigured, string? Error);

/// <summary>
/// Hộp nhập mã PIN khi thoát Tray App (mã PIN khác mật khẩu đăng nhập,
/// khác device token — docs/03-SECURITY.md mục 1).
///
/// PIN được kiểm tra bởi Service (giữ hash đã đồng bộ từ server): hộp này
/// chỉ gửi PIN nhập vào lên qua delegate và nhận kết quả, không bao giờ
/// thấy hash. Không nối được Service thì không thoát được (fail-closed).
/// </summary>
public partial class PinDialog : Window
{
    private readonly Func<string, Task<PinVerifyOutcome>> _verifyPin;
    private bool _verifying;

    public PinDialog(Func<string, Task<PinVerifyOutcome>> verifyPin)
    {
        _verifyPin = verifyPin;
        InitializeComponent();
        _ = PinBox.Focus();
    }

    private async void OkButton_Click(object sender, RoutedEventArgs e)
    {
        if (_verifying)
        {
            return;
        }

        string pin = PinBox.Password;
        if (string.IsNullOrWhiteSpace(pin))
        {
            ErrorText.Text = "Hãy nhập mã PIN.";
            return;
        }

        _verifying = true;
        OkButton.IsEnabled = false;
        ErrorText.Text = "Đang kiểm tra mã PIN...";
        try
        {
            PinVerifyOutcome outcome = await _verifyPin(pin);
            if (outcome.Error is not null)
            {
                ErrorText.Text = outcome.Error;
            }
            else if (!outcome.PinConfigured)
            {
                ErrorText.Text = "Phụ huynh chưa đặt mã PIN. Không thể thoát.";
            }
            else if (outcome.LockedOut)
            {
                ErrorText.Text = "Đã nhập sai quá nhiều lần. Hãy thử lại sau vài phút.";
            }
            else if (outcome.Verified)
            {
                DialogResult = true;
                return;
            }
            else
            {
                ErrorText.Text = outcome.RemainingAttempts > 0
                    ? "Mã PIN chưa đúng. Còn " + outcome.RemainingAttempts + " lần thử."
                    : "Mã PIN chưa đúng.";
            }

            PinBox.Clear();
            _ = PinBox.Focus();
        }
        finally
        {
            _verifying = false;
            OkButton.IsEnabled = true;
        }
    }

    private void CancelButton_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
    }
}
