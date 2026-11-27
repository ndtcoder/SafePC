import { Link } from 'react-router-dom'
import { textLinkClassName } from '../components/ui'

/**
 * Trang công khai "Chính sách riêng tư" (/chinh-sach-rieng-tu): nằm NGOÀI
 * RequireAuth (như trang đăng nhập) để ai cũng đọc được. Bản đầy đủ nằm
 * trong repo: docs/09-PRIVACY-POLICY.md.
 */
export default function PrivacyPolicyPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10">
      <div className="mb-6 flex flex-col items-center gap-2 text-center">
        <img src="/icons/icon.svg" alt="Logo SafePC" className="h-14 w-14" />
        <p className="text-xl font-bold tracking-tight text-slate-900">SafePC</p>
        <p className="text-sm text-slate-600">Chính sách riêng tư — cập nhật 27/11/2026</p>
      </div>
      <div className="space-y-6 rounded-xl border border-slate-200 bg-white p-5 text-sm leading-relaxed text-slate-700 shadow-sm sm:p-6">
        <p>
          SafePC là ứng dụng quản lý máy tính của con trong gia đình. Người vận hành là{' '}
          <strong>phụ huynh quản trị gia đình</strong>. SafePC không bán dữ liệu, không chia
          sẻ dữ liệu cho bên thứ ba quảng cáo, không dùng dữ liệu để huấn luyện AI.
        </p>
        <section>
          <h2 className="mb-2 text-base font-semibold text-slate-900">1. SafePC thu thập dữ liệu gì</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Tên ứng dụng + thời lượng dùng</strong> (giây): tính giờ dùng, thi hành
              giới hạn theo ứng dụng, báo cáo tuần. Chỉ tên process — không tiêu đề cửa sổ,
              không nội dung trong ứng dụng.
            </li>
            <li>
              <strong>Tên miền + đường dẫn web + thời lượng</strong>: đếm giờ web, thi hành
              chặn website, báo cáo tuần. Đã bỏ phần truy vấn và fragment — không lưu link
              đầy đủ, không đọc nội dung trang. Lượt web bị chặn chỉ lưu tên miền.
            </li>
            <li>
              <strong>Cụm từ tìm kiếm trên các công cụ tìm kiếm</strong> (Google, Bing,
              DuckDuckGo, Yahoo, Cốc Cốc) kèm dấu hiệu bị chặn hay không, giữ 90 ngày: thi
              hành chặn từ khóa tìm kiếm và thống kê trong báo cáo tuần. Chỉ cụm từ con gõ
              vào ô tìm kiếm của các công cụ này mới được lưu — phần truy vấn của mọi link
              khác vẫn bị bỏ như lịch sử web ở trên.
            </li>
            <li>
              <strong>Tin nhắn giữa phụ huynh và con trong SafePC</strong>: nội dung tin nhắn
              hai chiều trong kênh nhắn tin riêng của gia đình (phụ huynh nhắn trên Dashboard,
              con nhắn từ máy của con qua SafePC) kèm mốc đã đọc. Đây là kênh liên lạc do cả
              hai phía chủ động gửi trong sản phẩm — khác với tin nhắn ở ứng dụng khác, mà
              SafePC không đọc (xem mục 2). Tin nhắn nằm trong file xuất dữ liệu của con và
              bị xóa khi phụ huynh xóa dữ liệu của con.
            </li>
            <li>
              <strong>Quy tắc phụ huynh đặt, trạng thái máy, yêu cầu của con</strong> và quyết
              định của phụ huynh, <strong>sự kiện can thiệp</strong> (đổi giờ hệ thống,
              Agent/Tray/extension dừng bất thường): chỉ loại sự kiện + thời điểm.
            </li>
            <li>
              <strong>Email phụ huynh, tên hồ sơ con, tên máy</strong>: đăng nhập, phân biệt
              các con/máy.
            </li>
          </ul>
        </section>
        <section>
          <h2 className="mb-2 text-base font-semibold text-slate-900">2. SafePC KHÔNG thu thập</h2>
          <p>
            Không chụp màn hình, không ghi phím, không đọc nội dung chat/email/file của con,
            không bật micro, camera, định vị; không tiêu đề cửa sổ, không nội dung trang web,
            không mật khẩu (mật khẩu do Supabase Auth quản lý); không quảng cáo, không theo
            dõi hành vi ngoài phạm vi quản lý máy tính trong gia đình.
          </p>
        </section>
        <section>
          <h2 className="mb-2 text-base font-semibold text-slate-900">3. Lưu trữ và bảo vệ</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Dữ liệu lưu trên Supabase (Singapore) và Dashboard trên Vercel, truyền qua TLS
              (HTTPS). Mỗi gia đình chỉ thấy dữ liệu của mình (Row Level Security theo{' '}
              <code>family_id</code>).
            </li>
            <li>
              Trên máy con: device token mã hóa bằng DPAPI của Windows, file khóa chỉ SYSTEM
              + Administrators đọc được; mã PIN chỉ lưu dạng băm PBKDF2; quy tắc website khóa
              ACL chỉ SYSTEM + Admins ghi được.
            </li>
            <li>
              Tài khoản Standard của con không dừng được Service (quyền SYSTEM), không gỡ
              được ứng dụng nếu không có quyền Admin, không sửa được quy tắc.
            </li>
          </ul>
        </section>
        <section>
          <h2 className="mb-2 text-base font-semibold text-slate-900">4. Giữ dữ liệu bao lâu</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Lịch sử web</strong>: giữ <strong>90 ngày</strong>, tự xóa các hàng cũ
              hơn mỗi ngày.
            </li>
            <li>
              <strong>Từ khóa tìm kiếm</strong>: giữ <strong>90 ngày</strong>, tự xóa các hàng
              cũ hơn mỗi ngày.
            </li>
            <li>
              <strong>Mẫu dùng ứng dụng</strong>: mẫu chi tiết giữ 7 ngày; số liệu tổng hợp
              theo ngày giữ 90 ngày.
            </li>
            <li>
              <strong>Tin nhắn trong SafePC</strong>: giữ tới khi phụ huynh xóa dữ liệu của
              con (không tự hết hạn theo ngày như lịch sử web).
            </li>
            <li>
              <strong>Nhật ký hoạt động / sự kiện can thiệp / yêu cầu</strong>: giữ theo nhu
              cầu quản lý của gia đình; phụ huynh xóa được toàn bộ dữ liệu của con bất cứ
              lúc nào.
            </li>
          </ul>
        </section>
        <section>
          <h2 className="mb-2 text-base font-semibold text-slate-900">5. Quyền của phụ huynh và của con</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Xuất dữ liệu</strong>: phụ huynh xuất toàn bộ dữ liệu của một con ra một
              file JSON trên Dashboard (trang Hồ sơ con → tab Dữ liệu).
            </li>
            <li>
              <strong>Xóa dữ liệu</strong>: phụ huynh xóa toàn bộ dữ liệu của một con (kèm hồ
              sơ và máy) — không thể hoàn tác, cần gõ đúng tên con để xác nhận.
            </li>
            <li>
              <strong>Minh bạch với con</strong>: con luôn thấy Agent đang chạy (icon khay hệ
              thống), thấy quy tắc của mình trên Tray và được thông báo khi bị khóa. SafePC
              không chạy ẩn hoàn toàn.
            </li>
            <li>
              SafePC dùng trong gia đình, phụ huynh là người giám hộ của con và chịu trách
              nhiệm đặt quy tắc phù hợp với độ tuổi của con, theo Luật Trẻ em và Luật Bảo vệ
              dữ liệu cá nhân 2023 của Việt Nam.
            </li>
          </ul>
        </section>
        <section>
          <h2 className="mb-2 text-base font-semibold text-slate-900">6. Liên hệ và thay đổi chính sách</h2>
          <p>
            Mọi thắc mắc về dữ liệu của gia đình mình: liên hệ{' '}
            <strong>phụ huynh quản trị gia đình</strong> (người tạo tài khoản SafePC) qua
            Dashboard. Khi SafePC thay đổi cách thu thập dữ liệu, chính sách này được cập
            nhật kèm ngày cập nhật và phụ huynh được thông báo trên Dashboard trước khi thay
            đổi có hiệu lực.
          </p>
        </section>
        <p className="border-t border-slate-100 pt-4 text-xs text-slate-500">
          Bản đầy đủ: docs/09-PRIVACY-POLICY.md trong repo SafePC. Hướng dẫn cài đặt:{' '}
          <Link to="/huong-dan-cai-dat" className={textLinkClassName}>
            xem tại đây
          </Link>
          .
        </p>
      </div>
      <p className="mt-4 text-center text-sm">
        <Link to="/dang-nhap" className={textLinkClassName}>
          ← Về trang đăng nhập
        </Link>
      </p>
    </div>
  )
}
