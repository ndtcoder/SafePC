// SafePC — trang chặn (blocked.html). Chỉ đọc tham số reason trong URL của
// chính trang này để hiển thị lý do; không gọi API, không gửi dữ liệu,
// không tải tài nguyên ngoài.

"use strict";

const REASONS = {
  blocked: "Trang web này đã bị chặn theo quy tắc của phụ huynh.",
  time: "Trang web này đang ngoài khung giờ được phép mở.",
  allowlist: "Trang web này không nằm trong danh sách được phép mở.",
  limit: "Con đã dùng hết thời gian cho phép hôm nay cho trang web này.",
  tempblock: "Trang web này đang bị chặn tạm thời theo yêu cầu của phụ huynh.",
  focus: "Đang giờ học tập trung. Chỉ các website học tập được phép mới mở được.",
};

document.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(window.location.search);
  const reason = params.get("reason");
  const message = REASONS[reason] || REASONS.blocked;
  const element = document.getElementById("reason");
  if (element) element.textContent = message;
});
