using System.Windows;

namespace SafePC.Agent.Tray;

/// <summary>
/// Cửa sổ THÔNG BÁO MINH BẠCH về chụp màn hình (quyết định anh Tiến
/// 28/11/2026, mô hình sửa 11:16): KHÔNG phải cửa sổ đồng ý — phụ huynh
/// quyết định bật/tắt trên Dashboard, con chỉ được thông báo. Hiện lần
/// đầu khi chụp bắt đầu hiệu lực trên phiên và sau đó mỗi 7 ngày (mốc
/// theo từng con lưu cục bộ phía Tray, xem App.CheckScreenNotice).
/// Nội dung CỐ Ý không nêu tần suất/khoảng chụp. Cửa sổ top-level độc
/// lập, KHÔNG đặt Owner như mọi cửa sổ Tray khác; một nút "Đã hiểu" —
/// bấm nút mới tính là đã thông báo (đóng bằng nút X thì lần sau hiện
/// lại), qua <see cref="Acknowledged"/>.
/// </summary>
public partial class ScreenNoticeWindow : Window
{
    public ScreenNoticeWindow()
    {
        InitializeComponent();
    }

    /// <summary>True khi con đã bấm "Đã hiểu" (App ghi mốc 7 ngày chỉ khi cờ này bật).</summary>
    public bool Acknowledged { get; private set; }

    private void OkButton_Click(object sender, RoutedEventArgs e)
    {
        Acknowledged = true;
        Close();
    }
}
