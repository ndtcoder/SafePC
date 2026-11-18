// SafePC — helper domain dùng chung cho background.js (importScripts) và
// popup.js (thẻ <script>). Không có bước build: file JS thuần, chạy trực
// tiếp trong cả service worker và popup.
//
// NGUYÊN TẮC THU THẬP: mọi helper ở đây chỉ nhận/trả về DOMAIN (hostname
// đã chữ thường), trừ pathFromUrl chỉ trả về ĐƯỜNG DẪN (pathname) cho
// lịch sử web. Không hàm nào nhận, lưu, log hay gửi full URL — URL đầy
// đủ chỉ xuất hiện thoáng qua trong hostnameFromUrl/pathFromUrl để lấy
// hostname/đường dẫn rồi bỏ. Đường dẫn lấy ra đã cắt bỏ phần truy vấn
// (query) và fragment, trần 500 ký tự (quyết định của phụ huynh ngày
// 18/11/2026: lịch sử web lưu tên miền + đường dẫn, bỏ query/fragment,
// giữ 90 ngày; lượt web bị chặn vẫn chỉ ghi tên miền — xem background.js).
// Không bỏ tiền tố "www": www.youtube.com và youtube.com là hai hostname
// khác nhau; rule "youtube.com" khớp cả hai nhờ khớp hậu tố (domainMatches),
// còn "notyoutube.com" thì KHÔNG khớp (xem domainMatches).

"use strict";

// Trần độ dài đường dẫn ghi vào lịch sử web (ký tự). Đường dẫn dài hơn
// thì cắt — cùng trần với cột web_visits.path (migration 19) và hàm cắt
// phía Agent, để ba tầng không lệch nhau.
const SAFEPC_MAX_PATH_LENGTH = 500;

function safepcNormalizeDomain(raw) {
  if (typeof raw !== "string") return null;
  let value = raw.trim().toLowerCase();
  const scheme = value.indexOf("://");
  if (scheme >= 0) value = value.slice(scheme + 3);
  const cut = value.search(/[/?#]/);
  if (cut >= 0) value = value.slice(0, cut);
  const colon = value.indexOf(":");
  if (colon >= 0) value = value.slice(0, colon);
  value = value.trim().replace(/^\.+/, "").replace(/\.+$/, "");
  if (value.length === 0 || value.length > 253) return null;
  const labels = value.split(".");
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return null;
    if (label.startsWith("-") || label.endsWith("-")) return null;
    if (!/^[a-z0-9-]+$/.test(label)) return null;
  }
  return value;
}

// Khớp hậu tố: rule "youtube.com" khớp "youtube.com" và "www.youtube.com",
// nhưng KHÔNG khớp "notyoutube.com" (phải có ranh giới dấu chấm).
function safepcDomainMatches(hostname, ruleDomain) {
  if (typeof hostname !== "string" || typeof ruleDomain !== "string") return false;
  return hostname === ruleDomain || hostname.endsWith("." + ruleDomain);
}

// Lấy hostname từ URL, chỉ chấp nhận http/https. Trả về null cho chrome://,
// file://, about:blank, URL hỏng... — các trang này không tính thời gian xem.
function safepcHostnameFromUrl(url) {
  if (typeof url !== "string" || url.length === 0) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const hostname = parsed.hostname.toLowerCase();
    return hostname.length > 0 ? hostname : null;
  } catch {
    return null;
  }
}

// Lấy ĐƯỜNG DẪN (pathname) từ URL, chỉ chấp nhận http/https — dùng cho
// lịch sử web (0.1.10). Phần truy vấn (query) và fragment KHÔNG BAO GIỜ
// xuất hiện trong kết quả: URL API tách chúng khỏi pathname theo cấu
// trúc, và hàm vẫn cắt phòng thủ ở '?'/'#' đầu tiên nếu có. Trả về null
// cho URL không phải http/https hoặc URL hỏng (cùng tập hợp với
// hostnameFromUrl, để một tab hoặc được tính cả hostname + đường dẫn,
// hoặc không được tính gì). Kết quả luôn bắt đầu bằng '/', trần 500 ký
// tự (cắt ở ranh giới ký tự, không chẻ đôi cặp surrogate).
function safepcPathFromUrl(url) {
  if (typeof url !== "string" || url.length === 0) return null;
  let pathname;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    pathname = parsed.pathname;
  } catch {
    return null;
  }
  if (typeof pathname !== "string" || pathname.length === 0) return null;
  // Cắt phòng thủ: pathname của URL API không chứa '?'/'#', nhưng cắt
  // thêm một lần để hàm đúng ngay cả khi đầu vào không qua URL API.
  const queryAt = pathname.indexOf("?");
  if (queryAt >= 0) pathname = pathname.slice(0, queryAt);
  const hashAt = pathname.indexOf("#");
  if (hashAt >= 0) pathname = pathname.slice(0, hashAt);
  if (pathname.length === 0 || !pathname.startsWith("/")) return null;
  if (pathname.length > SAFEPC_MAX_PATH_LENGTH) {
    pathname = pathname.slice(0, SAFEPC_MAX_PATH_LENGTH);
    // Không chẻ đôi cặp surrogate ở cuối chuỗi đã cắt.
    const last = pathname.charCodeAt(pathname.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) pathname = pathname.slice(0, -1);
  }
  return pathname;
}

// Khóa ngày theo GIỜ ĐỊA PHƯƠNG ("YYYY-MM-DD"): ngân sách theo domain tính
// theo ngày địa phương của máy con, khớp cách Agent tính daily_limit.
function safepcLocalDateKey(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

function safepcHhmmToMinutes(hhmm) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

globalThis.SafePCDomain = {
  normalizeDomain: safepcNormalizeDomain,
  domainMatches: safepcDomainMatches,
  hostnameFromUrl: safepcHostnameFromUrl,
  pathFromUrl: safepcPathFromUrl,
  maxPathLength: SAFEPC_MAX_PATH_LENGTH,
  localDateKey: safepcLocalDateKey,
  hhmmToMinutes: safepcHhmmToMinutes,
};
