// SafePC — helper domain dùng chung cho background.js (importScripts) và
// popup.js (thẻ <script>). Không có bước build: file JS thuần, chạy trực
// tiếp trong cả service worker và popup.
//
// NGUYÊN TẮC CHỈ DOMAIN: mọi helper ở đây chỉ nhận/trả về DOMAIN (hostname
// đã chữ thường). Không hàm nào nhận, lưu, log hay gửi full URL — URL đầy
// đủ chỉ xuất hiện thoáng qua trong hostnameFromUrl để lấy hostname rồi bỏ.
// Không bỏ tiền tố "www": www.youtube.com và youtube.com là hai hostname
// khác nhau; rule "youtube.com" khớp cả hai nhờ khớp hậu tố (domainMatches),
// còn "notyoutube.com" thì KHÔNG khớp (xem domainMatches).

"use strict";

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
  localDateKey: safepcLocalDateKey,
  hhmmToMinutes: safepcHhmmToMinutes,
};
