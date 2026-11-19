import { Link } from 'react-router-dom'
import { textLinkClassName } from '../components/ui'

/**
 * Trang công khai "Hướng dẫn cài đặt" (/huong-dan-cai-dat): nằm NGOÀI
 * RequireAuth (như trang đăng nhập) để phụ huynh mới đọc được trước khi
 * đăng nhập. Bản đầy đủ nằm trong repo: docs/08-HUONG-DAN-CAI-DAT.md.
 * Nội dung rút gọn nhưng đủ các bước: chuẩn bị, ghép nối, cài đặt, extension,
 * mã PIN, gỡ cài đặt, sự cố thường gặp.
 */
export default function InstallGuidePage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10">
      <div className="mb-6 flex flex-col items-center gap-2 text-center">
        <img src="/icons/icon.svg" alt="Logo SafePC" className="h-14 w-14" />
        <p className="text-xl font-bold tracking-tight text-slate-900">SafePC</p>
        <p className="text-sm text-slate-600">Hướng dẫn cài đặt (dành cho phụ huynh)</p>
      </div>
      <div className="space-y-6 rounded-xl border border-slate-200 bg-white p-5 text-sm leading-relaxed text-slate-700 shadow-sm sm:p-6">
        <section>
          <h2 className="mb-2 text-base font-semibold text-slate-900">1. Trước khi cài</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>Máy con chạy Windows 10 hoặc Windows 11 (64-bit), có mạng.</li>
            <li>
              Con dùng tài khoản <strong>Standard User</strong>; phụ huynh giữ tài khoản{' '}
              <strong>Admin</strong> duy nhất. Đây là điều kiện quan trọng nhất: nếu con có
              quyền Admin thì con gỡ/tắt được SafePC.
            </li>
            <li>Phụ huynh đã đăng ký tài khoản trên Dashboard và xác minh email.</li>
            <li>Trình duyệt trên máy con: Microsoft Edge (khuyến nghị) hoặc Chrome.</li>
          </ul>
        </section>
        <section>
          <h2 className="mb-2 text-base font-semibold text-slate-900">2. Lấy mã ghép nối</h2>
          <p>
            Đăng nhập Dashboard → trang <strong>Hồ sơ</strong> thêm hồ sơ con → trang{' '}
            <strong>Thiết bị</strong> → <strong>Ghép nối máy mới</strong> → tạo mã cho con.
            Mã 6 số chỉ hiển thị một lần và chỉ có hiệu lực <strong>5 phút</strong> — tạo mã
            ngay trước khi chạy bộ cài.
          </p>
        </section>
        <section>
          <h2 className="mb-2 text-base font-semibold text-slate-900">3. Cài đặt trên máy con</h2>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Đăng nhập máy con bằng <strong>tài khoản Admin của phụ huynh</strong> (không cài
              từ tài khoản của con).
            </li>
            <li>
              Lấy file bộ cài do người quản trị SafePC của gia đình cung cấp
              (hiện chưa có link tải công khai trên Dashboard), chạy file{' '}
              <code>SafePCAgentSetup-0.1.N.exe</code>. Windows SmartScreen có thể cảnh báo vì
              bộ cài chưa được ký số — bấm <strong>More info → Run anyway</strong>.
            </li>
            <li>
              Sau bước chép file, bộ cài hiện <strong>trang ghép nối</strong>: nhập mã 6 số rồi
              bấm Tiếp theo. Nhập đúng mã thì hiện “Ghép nối thành công!” — máy sẽ hiện trên
              Dashboard (Online trong vòng 1 phút). Nhập sai mã hoặc mã hết hạn thì nhập lại
              mã mới; chưa có mã thì tích “Bỏ qua, ghép nối sau”.
            </li>
            <li>
              Cài xong, đăng xuất tài khoản Admin, đăng nhập bằng tài khoản Standard của con.
              Icon SafePC hiện ở khay hệ thống.
            </li>
          </ol>
        </section>
        <section>
          <h2 className="mb-2 text-base font-semibold text-slate-900">4. Cài extension chặn web</h2>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Mở Edge → <code>edge://extensions</code> (Chrome:{' '}
              <code>chrome://extensions</code>) → bật <strong>Developer mode</strong>.
            </li>
            <li>
              Giải nén file <code>SafePC-Extension-0.1.N.zip</code> (do người quản trị
              SafePC của gia đình cung cấp) ra{' '}
              <code>C:\SafePC\extension</code> (giữ nguyên đường dẫn này).
            </li>
            <li>
              Bấm <strong>Load unpacked</strong> → chọn thư mục{' '}
              <code>C:\SafePC\extension</code>.
            </li>
          </ol>
          <p className="mt-2">
            Giới hạn đã biết: bản cài tay có thể bị tắt/gỡ từ trình duyệt — SafePC phát hiện
            extension mất dấu và báo phụ huynh. Ép cài qua cửa hàng Edge sẽ bật sau khi
            extension ổn định.
          </p>
        </section>
        <section>
          <h2 className="mb-2 text-base font-semibold text-slate-900">5. Mã PIN và quy tắc</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Mã PIN thoát Tray</strong>: đặt trên Dashboard (trang Thiết bị → máy).
              Muốn thoát Tray phải nhập đúng mã; mỗi mã chỉ dùng được một lần. Chưa đặt mã
              thì không ai thoát được Tray.
            </li>
            <li>
              <strong>Mã PIN gỡ cài đặt</strong>: chính là mã PIN trên — gỡ SafePC khỏi máy
              cũng yêu cầu nhập đúng mã PIN này. Chưa đặt mã PIN thì gỡ bằng quyền Admin như
              trước.
            </li>
            <li>
              <strong>Quy tắc</strong>: trang Quy tắc — giờ giấc, chặn ứng dụng, chặn website,
              giờ học tập trung, nghỉ bắt buộc. Quy tắc đồng bộ xuống máy con trong vòng ~1
              phút; mất mạng máy vẫn thi hành quy tắc đã đồng bộ.
            </li>
          </ul>
        </section>
        <section>
          <h2 className="mb-2 text-base font-semibold text-slate-900">6. Gỡ cài đặt</h2>
          <p>
            Đăng nhập máy con bằng tài khoản Admin → Settings → Apps → SafePC Agent →
            Uninstall → nhập mã PIN phụ huynh khi được hỏi. Nhập sai 3 lần trong một lần
            gỡ thì hủy gỡ (sai 5 lần liên tiếp thì khóa nhập 30 phút). Gỡ im lặng khi đã
            đặt mã PIN sẽ bị chặn — muốn gỡ im lặng thì gỡ mã PIN trên Dashboard trước
            (đợi ~1 phút), rồi gỡ im lặng.
          </p>
        </section>
        <section>
          <h2 className="mb-2 text-base font-semibold text-slate-900">7. Sự cố thường gặp</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Máy không hiện Online sau ghép nối: đợi 1 phút; kiểm tra mạng và Service
              SafePCAgent có chạy không (<code>services.msc</code>).
            </li>
            <li>
              Extension báo “chưa kết nối”: kiểm tra đường dẫn{' '}
              <code>C:\SafePC\extension</code>, tải lại extension, kiểm tra Service.
            </li>
            <li>
              Tray biến mất khỏi khay hệ thống: Service tự khởi động lại Tray trong ~5 phút.
              Không trở lại sau 10 phút thì đăng xuất rồi đăng nhập lại.
            </li>
            <li>
              Quên mã PIN: đặt mã mới trên Dashboard (trang Thiết bị → máy → Lưu mã PIN);
              mã mới đồng bộ xuống máy trong ~1 phút.
            </li>
          </ul>
        </section>
        <p className="border-t border-slate-100 pt-4 text-xs text-slate-500">
          Bản đầy đủ: docs/08-HUONG-DAN-CAI-DAT.md trong repo SafePC. SafePC không chụp màn
          hình, không ghi phím, không đọc nội dung chat/file, không bật mic/camera — xem{' '}
          <Link to="/chinh-sach-rieng-tu" className={textLinkClassName}>
            Chính sách riêng tư
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
