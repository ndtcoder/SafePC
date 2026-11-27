// SafePC — trang chặn (blocked.html). Chỉ đọc tham số reason/domain trong
// URL của chính trang này để hiển thị lý do và nút xin mở; gửi yêu cầu mở
// về background.js qua chrome.runtime.sendMessage. Chỉ tên miền được gửi
// đi — không URL đầy đủ, path hay query. Không gọi API, không tải tài
// nguyên ngoài.
//
// Nguồn domain, theo thứ tự: tham số domain trong URL (đường tab watcher
// đặt lúc chuyển hướng), rồi hỏi background (đường redirect DNR quy chiếu
// rule vừa khớp). Không xác định được domain thì nút xin mở được ẩn —
// không đoán.

"use strict";

const REASONS = {
  blocked: "Trang web này đã bị chặn theo quy tắc của phụ huynh.",
  time: "Trang web này đang ngoài khung giờ được phép mở.",
  allowlist: "Trang web này không nằm trong danh sách được phép mở.",
  limit: "Con đã dùng hết thời gian cho phép hôm nay cho trang web này.",
  tempblock: "Trang web này đang bị chặn tạm thời theo yêu cầu của phụ huynh.",
  focus: "Đang giờ học tập trung. Chỉ các website học tập được phép mới mở được.",
  // Lý do theo danh mục chặn (0.1.8): id danh mục khớp đúng
  // DomainCategoryLists phía Agent ("category-<id>").
  "category-adult": "Trang web này thuộc danh mục nội dung người lớn, đã bị chặn theo quy tắc của phụ huynh.",
  "category-gambling": "Trang web này thuộc danh mục cờ bạc, cá cược, đã bị chặn theo quy tắc của phụ huynh.",
  "category-social": "Trang web này thuộc danh mục mạng xã hội, đã bị chặn theo quy tắc của phụ huynh.",
  // Kiểm duyệt từ khóa tìm kiếm (0.1.11): URL trang chặn chỉ mang
  // reason này — KHÔNG mang cụm từ đã tìm. Tiêu đề cũng đổi thành
  // "Tìm kiếm bị chặn" (xem dưới) và nút xin mở bị ẩn: yêu cầu mở theo
  // tên miền không áp dụng cho một lượt tìm kiếm.
  "search-keyword": "Tìm kiếm này chứa từ khóa không phù hợp theo quy định của phụ huynh nên đã bị chặn.",
};

function normalizeBlockedDomain(raw) {
  try {
    const normalize = globalThis.SafePCDomain && globalThis.SafePCDomain.normalizeDomain;
    if (typeof normalize !== "function") return null;
    return normalize(raw);
  } catch {
    return null;
  }
}

// Hỏi background domain bị chặn của tab này. Trả về null khi background
// không trả lời/không xác định được — nút sẽ ẩn, không đoán.
function askBackgroundForDomain() {
  return new Promise((resolve) => {
    try {
      if (
        typeof chrome === "undefined" ||
        !chrome.runtime ||
        typeof chrome.runtime.sendMessage !== "function"
      ) {
        resolve(null);
        return;
      }
      chrome.runtime.sendMessage({ type: "getBlockedDomain" }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        const domain =
          response && typeof response.domain === "string"
            ? normalizeBlockedDomain(response.domain)
            : null;
        resolve(domain);
      });
    } catch {
      resolve(null);
    }
  });
}

function sendUnblockRequest(domain) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "requestUnblock", domain }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false });
          return;
        }
        resolve(response && typeof response === "object" ? response : { ok: false });
      });
    } catch {
      resolve({ ok: false });
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(window.location.search);
  const reason = params.get("reason");
  const message = REASONS[reason] || REASONS.blocked;
  const element = document.getElementById("reason");
  if (element) element.textContent = message;

  // Tìm kiếm bị chặn (0.1.11): đổi tiêu đề cho đúng ngữ cảnh và DỪNG ở
  // đây — nút "Xin phép mở trang này" chỉ dành cho trang web bị chặn
  // theo tên miền, không áp dụng cho một lượt tìm kiếm (khung yêu cầu
  // giữ nguyên trạng thái ẩn).
  if (reason === "search-keyword") {
    const heading = document.querySelector("h1");
    if (heading) heading.textContent = "Tìm kiếm bị chặn";
    return;
  }

  const requestBox = document.getElementById("request-box");
  const button = document.getElementById("request-button");
  const status = document.getElementById("request-status");
  const errorBox = document.getElementById("request-error");
  if (!requestBox || !button || !status || !errorBox) return;

  const showError = (text) => {
    errorBox.textContent = text;
    errorBox.hidden = false;
  };

  (async () => {
    let domain = normalizeBlockedDomain(params.get("domain"));
    if (!domain) domain = await askBackgroundForDomain();
    if (!domain) return; // Không xác định được trang: ẩn nút, giữ câu hỏi phụ huynh.
    button.textContent = "Xin phép mở " + domain;
    requestBox.hidden = false;

    button.addEventListener("click", async () => {
      button.disabled = true;
      errorBox.hidden = true;
      status.hidden = true;
      const result = await sendUnblockRequest(domain);
      if (result.ok) {
        button.textContent = "Đã gửi, đang chờ phụ huynh duyệt";
        status.textContent =
          "Yêu cầu mở " +
          domain +
          " đã gửi tới phụ huynh. Sau khi phụ huynh duyệt, con bấm Quay lại rồi mở lại trang web đó nhé.";
        status.hidden = false;
      } else {
        button.disabled = false;
        showError("Chưa gửi được yêu cầu. Con thử lại nhé, hoặc hỏi trực tiếp phụ huynh.");
      }
    });
  })();
});
