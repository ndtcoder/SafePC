// SafePC — helper domain dùng chung cho background.js (importScripts) và
// popup.js (thẻ <script>). Không có bước build: file JS thuần, chạy trực
// tiếp trong cả service worker và popup.
//
// NGUYÊN TẮC THU THẬP: mọi helper ở đây chỉ nhận/trả về DOMAIN (hostname
// đã chữ thường), trừ pathFromUrl chỉ trả về ĐƯỜNG DẪN (pathname) cho
// lịch sử web và nhóm hàm tìm kiếm ở cuối file (extractSearchTerm và các
// hàm đi kèm, 0.1.11). Không hàm nào nhận, lưu, log hay gửi full URL — URL đầy
// đủ chỉ xuất hiện thoáng qua trong hostnameFromUrl/pathFromUrl để lấy
// hostname/đường dẫn rồi bỏ. Đường dẫn lấy ra đã cắt bỏ phần truy vấn
// (query) và fragment, trần 500 ký tự (quyết định của phụ huynh ngày
// 18/11/2026: lịch sử web lưu tên miền + đường dẫn, bỏ query/fragment,
// giữ 90 ngày; lượt web bị chặn vẫn chỉ ghi tên miền — xem background.js).
// NGOẠI LỆ ĐÃ ĐƯỢC PHỤ HUYNH QUYẾT ĐỊNH (27/11/2026, kiểu Microsoft
// Family Safety): riêng CỤM TỪ TÌM KIẾM trên các công cụ tìm kiếm được
// trích ra từ phần truy vấn — để chặn theo từ khóa cấm và thống kê vào
// Báo cáo tuần (giữ 90 ngày như lịch sử web). extractSearchTerm là điểm
// trích duy nhất: chỉ nhận đúng 5 công cụ đã liệt kê, chỉ lấy đúng tham
// số chứa cụm từ, và cụm từ không bao giờ xuất hiện trong URL trang
// chặn hay log (xem background.js).
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

// ---------------------------------------------------------------------------
// Kiểm duyệt từ khóa tìm kiếm (0.1.11, quyết định của phụ huynh 27/11/2026)
//
// Chỉ 5 công cụ tìm kiếm được hỗ trợ ở v1. Mỗi công cụ: id engine (gửi
// lên server qua reportSearch), mẫu host (đã bỏ tiền tố "www."), đường
// dẫn trang kết quả và tên tham số chứa cụm từ. hostPattern là regex
// (dạng chuỗi) dùng cho buildSearchBlockRegex; extractSearchTerm đối
// chiếu hostname bằng cách biên dịch chính mẫu đó nên hai đường không
// bao giờ lệch nhau.
// ---------------------------------------------------------------------------

const SAFEPC_SEARCH_ENGINES = [
  // Google: google.com, google.com.vn, google.co.uk, google.de...
  // (hostPattern khớp cả tên miền con như www./m. qua nhóm đầu).
  { id: "google", hostPattern: "(?:[^/]*\\.)?google\\.[a-z]{2,3}(?:\\.[a-z]{2})?", paths: ["/search"], param: "q" },
  { id: "bing", hostPattern: "(?:[^/]*\\.)?bing\\.com", paths: ["/search"], param: "q" },
  // DuckDuckGo: trang kết quả ở "/" (bản đầy đủ) hoặc "/html/" (bản HTML).
  // Bản HTML chạy trên tên miền con html.duckduckgo.com (và bản rút gọn
  // lite.duckduckgo.com, đường dẫn "/lite/") nên hostPattern cần tiền tố
  // tên miền con tùy chọn như coccoc — neo ^...$ ở extractSearchTerm vẫn
  // chặn host giả mạo kiểu duckduckgo.com.evil.com (sửa theo review
  // 27/11/2026).
  { id: "duckduckgo", hostPattern: "(?:[^/]*\\.)?duckduckgo\\.com", paths: ["/", "/html/", "/html", "/lite/", "/lite"], param: "q" },
  { id: "yahoo", hostPattern: "search\\.yahoo\\.com", paths: ["/search", "/search/"], param: "p" },
  { id: "coccoc", hostPattern: "(?:[^/]*\\.)?coccoc\\.com", paths: ["/search"], param: "q" },
];

// Trích cụm từ tìm kiếm từ URL: trả về {engine, term} khi URL là trang
// kết quả của một trong 5 công cụ và tham số cụm từ khác rỗng; ngược
// lại null. term là cụm từ GỐC đã giải mã (URLSearchParams tự giải mã
// %XX và '+'), đã cắt khoảng trắng thừa ở hai đầu. URL đầy đủ chỉ xuất
// hiện thoáng qua trong URL API rồi bỏ — như hostnameFromUrl. Chỉ
// http/https. Không bao giờ throw.
function safepcExtractSearchTerm(urlString) {
  if (typeof urlString !== "string" || urlString.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) return null;
  for (const engine of SAFEPC_SEARCH_ENGINES) {
    let hostOk = false;
    try {
      hostOk = new RegExp("^" + engine.hostPattern + "$").test(hostname);
    } catch {
      hostOk = false;
    }
    if (!hostOk) continue;
    if (!engine.paths.includes(parsed.pathname)) return null;
    const raw = parsed.searchParams.get(engine.param);
    if (typeof raw !== "string") return null;
    const term = raw.trim();
    if (term.length === 0) return null;
    return { engine: engine.id, term };
  }
  return null;
}

// Chuẩn hóa văn bản để ĐỐI CHIẾU từ khóa (không dùng để hiển thị/lưu):
// chữ thường, bỏ dấu tiếng Việt (NFD + bỏ dấu thanh/dấu mũ đi kèm, đ/Đ
// -> d), gộp khoảng trắng, cắt hai đầu. Nhờ bỏ dấu, từ khóa phụ huynh
// gõ có dấu vẫn khớp cụm từ con gõ không dấu và ngược lại.
function safepcNormalizeSearchText(value) {
  if (typeof value !== "string") return "";
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/\s+/g, " ")
    .trim();
}

// Cụm từ có chứa từ khóa cấm nào không: đối chiếu trên văn bản ĐÃ
// CHUẨN HÓA hai phía, theo chuỗi con. Từ khóa rỗng sau chuẩn hóa bị bỏ
// qua. Danh sách từ khóa lạ (không phải mảng/chuỗi) thì coi như không
// có từ khóa nào — fail-open, không bao giờ throw.
function safepcSearchKeywordHit(term, keywords) {
  const normalizedTerm = safepcNormalizeSearchText(term);
  if (normalizedTerm.length === 0) return false;
  if (!Array.isArray(keywords)) return false;
  for (const keyword of keywords) {
    const normalizedKeyword = safepcNormalizeSearchText(keyword);
    if (normalizedKeyword.length === 0) continue;
    if (normalizedTerm.includes(normalizedKeyword)) return true;
  }
  return false;
}

function safepcEscapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Mã hóa một từ khóa thành mẫu regex khớp dạng MÃ HÓA của nó trong URL
// thô: duyệt từng ký tự, áp encodeURIComponent —
//   - khoảng trắng khớp cả '+' lẫn '%20' (hai cách trình duyệt mã hóa
//     khoảng trắng trong query);
//   - ký tự encodeURIComponent giữ nguyên (chữ/số ASCII và vài dấu):
//     chữ cái khớp cả hai dạng hoa/thường (từ khóa đã chữ thường nhưng
//     cụm từ con gõ có thể viết hoa), ký tự khác thoát regex;
//   - ký tự bị mã hóa %XX: khớp đúng dãy %XX đó, chữ cái hex khớp cả
//     hai dạng hoa/thường; ký tự ASCII còn có thêm lựa chọn dạng thô
//     (một số luồng giữ nguyên ký tự trong URL).
// Từ khóa chứa dấu tiếng Việt chỉ khớp khi con gõ ĐÚNG dấu và đúng
// thường/hoa của ký tự có dấu (dạng mã hóa của 'Ế' khác 'ế'); các biến
// thể còn lại do tab watcher bắt bằng đối chiếu đã bỏ dấu
// (searchKeywordHit) — xem background.js.
function safepcEncodeKeywordForRegex(keyword) {
  let out = "";
  for (const ch of keyword) {
    if (ch === " ") {
      out += "(?:\\+|%20)";
      continue;
    }
    const encoded = encodeURIComponent(ch);
    if (encoded === ch) {
      if (/^[a-zA-Z]$/.test(ch)) {
        out += "[" + ch.toLowerCase() + ch.toUpperCase() + "]";
      } else {
        out += safepcEscapeRegExp(ch);
      }
      continue;
    }
    let encodedPattern = "";
    for (const e of encoded) {
      if (/^[a-zA-Z]$/.test(e)) {
        encodedPattern += "[" + e.toLowerCase() + e.toUpperCase() + "]";
      } else {
        encodedPattern += safepcEscapeRegExp(e);
      }
    }
    if (ch.length === 1 && ch.charCodeAt(0) < 0x80) {
      out += "(?:" + encodedPattern + "|" + safepcEscapeRegExp(ch) + ")";
    } else {
      out += encodedPattern;
    }
  }
  return out;
}

// Dựng regexFilter (RE2, cho declarativeNetRequest) khớp URL tìm kiếm
// THÔ (đang còn mã hóa) của một công cụ khi tham số cụm từ CHỨA từ khóa
// (dạng mã hóa của từ khóa là chuỗi con của giá trị tham số). Tham số
// có thể đứng sau các tham số khác (vd SafeSearch chèn safe=active lên
// đầu). Trả về null khi engine lạ hoặc từ khóa rỗng — caller bỏ qua.
// Từ khóa được trim + chữ thường trước khi mã hóa (khớp chuẩn hóa phía
// Agent trong domain_rules.json).
function safepcBuildSearchBlockRegex(engineId, keyword) {
  const engine = SAFEPC_SEARCH_ENGINES.find((e) => e.id === engineId);
  if (!engine) return null;
  if (typeof keyword !== "string") return null;
  const normalized = keyword.trim().toLowerCase();
  if (normalized.length === 0) return null;
  // Đường dẫn dạng regex: "/" của DuckDuckGo đứng một mình, "/html/"
  // và "/lite/" là lựa chọn dài hơn phải đứng trước; các công cụ khác
  // chỉ có một đường dẫn cố định nên thoát regex là đủ.
  let pathPattern;
  if (engine.id === "duckduckgo") {
    pathPattern = "/(?:html/|lite/)?";
  } else {
    pathPattern = safepcEscapeRegExp(engine.paths[0]);
  }
  const keywordPattern = safepcEncodeKeywordForRegex(normalized);
  return (
    "^https://" +
    engine.hostPattern +
    pathPattern +
    "\\?(?:[^&#]*&)*" +
    engine.param +
    "=[^&#]*" +
    keywordPattern +
    "[^&#]*"
  );
}

globalThis.SafePCDomain = {
  normalizeDomain: safepcNormalizeDomain,
  domainMatches: safepcDomainMatches,
  hostnameFromUrl: safepcHostnameFromUrl,
  pathFromUrl: safepcPathFromUrl,
  maxPathLength: SAFEPC_MAX_PATH_LENGTH,
  localDateKey: safepcLocalDateKey,
  hhmmToMinutes: safepcHhmmToMinutes,
  extractSearchTerm: safepcExtractSearchTerm,
  normalizeSearchText: safepcNormalizeSearchText,
  searchKeywordHit: safepcSearchKeywordHit,
  buildSearchBlockRegex: safepcBuildSearchBlockRegex,
  searchEngineIds: SAFEPC_SEARCH_ENGINES.map((e) => e.id),
};
