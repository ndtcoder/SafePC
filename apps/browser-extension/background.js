// SafePC Browser Extension — Sprint 2 đợt 2 (chặn domain thật qua
// declarativeNetRequest + báo cáo thời gian xem theo domain).
//
// Luồng quy tắc: Dashboard -> Supabase -> PC Agent (đồng bộ rules, xuất bản
// domain_rules.json) -> NativeHost (stdio) -> extension (getRules mỗi phút)
// -> declarativeNetRequest dynamic rules. Extension KHÔNG gọi Supabase, không
// có secret/key, không đọc nội dung trang.
//
// Luồng báo cáo: extension đếm thời gian tab đang hiển thị theo domain,
// gửi về NativeHost (reportUsage mỗi phút) -> web_usage.jsonl -> Agent
// đẩy lên bảng web_visits. LƯỢT XEM THƯỜNG mang DOMAIN + ĐƯỜNG DẪN +
// THỜI LƯỢNG (từ 0.1.10, theo quyết định của phụ huynh 18/11/2026): đường
// dẫn đã cắt bỏ phần truy vấn (query) và fragment ngay tại điểm thu thập
// (xem pathFromUrl trong domainUtils.js), trần 500 ký tự; không bao giờ
// gửi/lưu/log full URL, query, fragment, tiêu đề trang hay nội dung.
// Hostname + đường dẫn lấy từ tab.url rồi bỏ URL ngay. Lượt web bị chặn
// vẫn CHỈ DOMAIN (xem mục 0.1.7 dưới đây). Lịch sử web tự xóa sau 90
// ngày (lịch dọn dẹp migration 19).
//
// Tab watcher (0.1.5): DNR không thấy điều hướng trong trang (SPA đổi URL
// bằng history.pushState, ví dụ bấm từ trang chủ YouTube vào Shorts) hay
// trang đang hiển thị từ bộ nhớ đệm, nên background.js nghe
// chrome.tabs.onUpdated và đánh giá lại mọi tab sau mỗi lần rebuild rule,
// chuyển tab thuộc diện chặn sang trang chặn. Watcher chỉ đánh giá URL
// trong bộ nhớ (không gửi/lưu/log full URL, path, query) và chỉ thi hành
// tập con vô điều kiện (chặn domain, mẫu URL, chặn tạm thời, trừ cho phép
// tạm thời) — xem isTabUrlBlocked.
//
// Tự kiểm tra quyền host (0.1.6): redirect DNR chết lặng khi thiếu host
// permission (bài học 0.1.4), nên background.js kiểm tra định kỳ bằng
// chrome.permissions.contains và ghi kết quả vào chẩn đoán để popup cảnh
// báo — xem checkHostPermissions.
//
// Báo cáo lượt web bị chặn (0.1.7): mỗi lần tab tới trang chặn, background
// ghi nhận một lượt chặn CHỈ DOMAIN (không path/query/URL) vào hàng đợi
// riêng, gửi kèm lượt xem thường qua reportUsage với blocked = true và
// durationSec = 0. Cả hai đường tới trang chặn đều ghi theo domain của
// rule đã khớp: watcher đánh giá lại URL vừa chuyển, redirect DNR thì tra
// rule vừa khớp bằng getMatchedRules. Không quy chiếu được (rule
// chặn-tất-cả của focus/allowlist, getMatchedRules trống) thì bỏ qua —
// không đoán domain từ URL cũ của tab vì sẽ ghi nhầm domain trang trước.
//
// Chặn theo danh mục (0.1.8): rule "Chặn website" có thể chọn danh mục
// (người lớn, cờ bạc, mạng xã hội) thay vì gõ từng domain. Agent mở rộng
// danh mục thành domain trong `blocked` (cùng mức ưu tiên chặn 30, không
// đổi thang DNR) và ghi rõ domain nào thuộc danh mục nào trong
// `blockedCategories`; extension chỉ dùng trường này để hiện đúng lý do
// theo danh mục trên trang chặn (cả đường DNR lẫn tab watcher). Extension
// cũ không đọc trường này vẫn chặn đúng nhờ `blocked`.
//
// Nút xin mở trang trên trang chặn (0.1.9): trang chặn hỏi background
// domain bị chặn của tab mình (đường watcher: tham số domain trong URL
// chuyển hướng; đường DNR: quy chiếu rule vừa khớp như lượt chặn 0.1.7),
// rồi gửi yêu cầu mở qua NativeHost (message `requestUnblock`) để Agent
// đẩy lên bảng requests cho phụ huynh duyệt. Chỉ tên miền được gửi —
// không URL/path/query. Duyệt xong, lệnh cho phép tạm thời đi theo đúng
// đường ghi đè domain hiện có (tempAllow); con quay lại rồi mở lại trang thì mở được.
//
// Lịch sử web lưu đường dẫn (0.1.10): lượt xem thường ghi thêm đường dẫn
// (đã cắt query/fragment) để phụ huynh tìm kiếm/kiểm tra nội dung trong
// mục Báo cáo tuần. Hàng đợi `pending` tách theo cặp (domain, đường dẫn)
// để thời lượng không gộp nhầm giữa các trang cùng domain; ngân sách theo
// domain (`usage.seconds`) vẫn gộp theo domain như trước, và lượt bị chặn
// vẫn chỉ ghi tên miền.
//
// Kiểm duyệt từ khóa tìm kiếm (0.1.11, quyết định của phụ huynh
// 27/11/2026, kiểu Microsoft Family Safety): rule website mode
// 'block_search_keywords' trên Dashboard -> Agent hợp từ khóa vào
// `searchGuard.blockedKeywords` trong domain_rules.json. Hai lớp thi
// hành: (1) rule redirect DNR cho mỗi cặp (công cụ x từ khóa) ở ưu tiên
// searchBlock (65) chuyển thẳng tới trang chặn lý do "search-keyword" —
// khớp trên URL THÔ còn mã hóa nên chỉ bắt được biến thể mã hóa mà
// buildSearchBlockRegex diễn đạt được; (2) watcher trích cụm từ đã
// GIẢI MÃ từ URL điều hướng (extractSearchTerm, chỉ 5 công cụ: Google,
// Bing, DuckDuckGo, Yahoo, Cốc Cốc), đối chiếu đã bỏ dấu
// (searchKeywordHit) và tự chuyển tab sang trang chặn khi DNR trượt.
// Điểm ghi chính của lớp (2) là chrome.webNavigation.onBeforeNavigate
// — chạy khi điều hướng bắt đầu, TRƯỚC khi DNR chuyển hướng, nên lượt
// bị DNR chặn vẫn ghi được; chrome.tabs.onUpdated là lưới phụ (bắt
// pushState + thực hiện chuyển hướng dự phòng). Mọi lượt tìm (kể cả bị
// chặn) được ghi qua NativeHost bằng message `reportSearch` để thống
// kê vào Báo cáo tuần như lịch sử web (bảng search_terms, giữ 90 ngày
// — migration 28). NGOẠI LỆ RIÊNG TƯ do phụ huynh quyết định: chỉ cụm
// từ trên các công cụ tìm kiếm mới được trích/gửi; cụm từ KHÔNG bao
// giờ vào URL trang chặn (chỉ có reason), không vào log.
//
// Mọi giờ giấc tính theo GIỜ ĐỊA PHƯƠNG của máy con. Khung giờ/ngân sách/
// ghi đè tạm thời được đánh giá lại mỗi phút (alarm), nên thay đổi có hiệu
// lực trong vòng ~1 phút. Khi chưa nối được NativeHost, extension mở (không
// chặn gì) và popup báo "chưa kết nối" — xem README.md về giới hạn này.

"use strict";

importScripts("domainUtils.js");

const { normalizeDomain, domainMatches, hostnameFromUrl, pathFromUrl, localDateKey, hhmmToMinutes } =
  globalThis.SafePCDomain;
const {
  extractSearchTerm,
  normalizeSearchText,
  searchKeywordHit,
  buildSearchBlockRegex,
  searchEngineIds,
} = globalThis.SafePCDomain;

const NATIVE_HOST = "com.safepc.agent";
const ALARM_REFRESH = "safepc-refresh";
const ALARM_TICK = "safepc-tick";
const STORE_KEYS = {
  usage: "safepc_usage",
  pending: "safepc_pending",
  pendingBlocked: "safepc_pending_blocked",
  pendingSearch: "safepc_pending_search",
  limits: "safepc_limits",
  status: "safepc_status",
  dnr: "safepc_dnr",
};
const MAX_PENDING = 1000;
// Trần hàng đợi lượt chặn: mỗi lượt là một sự kiện rời rạc (không gộp theo
// domain như usage), dedupe 60 giây/domain đã chặn spam tải lại trang.
const MAX_PENDING_BLOCKED = 200;
// Trần hàng đợi cụm từ tìm kiếm chưa gửi (0.1.11): mỗi lượt tìm là một
// mẫu rời rạc {engine, term, blocked}; quá trần thì bỏ mẫu cũ nhất.
const MAX_PENDING_SEARCH = 200;
const MAX_DNR_RULES = 4500;
// Ngân sách rule regex DNR cho chặn từ khóa tìm kiếm (0.1.11, sửa theo
// review 27/11/2026): Chrome giới hạn 1000 rule regex trong bộ rule
// động; mỗi từ khóa tốn 5 rule (một cho mỗi công cụ tìm kiếm). Chỉ dựng
// rule DNR cho tối đa 150 từ khóa đầu tiên (150 x 5 = 750 rule), chừa
// khoảng cho rule redirect SafeSearch và rule mẫu URL. Từ khóa ngoài
// ngân sách VẪN bị thi hành bởi tab watcher (đối chiếu đã bỏ dấu trên
// danh sách ĐẦY ĐỦ trong currentRules.searchGuard), chỉ là không có
// rule DNR chặn ngay ở tầng request.
const MAX_SEARCH_DNR_KEYWORDS = 150;
// Đoạn xem dài nhất tính trong một lần tick (10 phút): service worker có thể
// ngủ đông (máy sleep), đoạn dài hơn thế chắc chắn không phải xem thật.
const MAX_SEGMENT_SECONDS = 600;

// Loại tài nguyên phụ (mọi thứ trừ main_frame) cho rule chặn: khung con,
// script, ảnh, media... của domain bị chặn cũng không được tải.
const SUB_RESOURCE_TYPES = [
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "media",
  "websocket",
  "other",
];

// Thứ tự ưu tiên DNR (số lớn thắng) — THANG ƯU TIÊN ĐÃ KHÓA, khớp hợp
// đồng với Dashboard/PC Agent:
//   chặn tạm thời 100 > focus 60 > allowlist theo giờ 55 > allowlist 50
//   > chặn theo giờ 40 > chặn 30 > hết ngân sách 20.
// Các mức phụ (không nằm trong thang đã khóa nhưng bắt buộc để thang hoạt
// động đúng):
//   - redirect SafeSearch/YouTube 65: cao hơn mọi mức allow (60/55/50) để
//     tham số an toàn vẫn được thêm cho domain được phép, nhưng thấp hơn
//     chặn tạm thời (100). Redirect không mở thêm website nào: URL sau
//     redirect được đánh giá lại, và rule chặn (requestDomains khớp cả
//     tên miền con — kể cả host restrict.youtube.com của youtube.com)
//     vẫn chặn được nó.
//   - cho phép tạm thời 57: chọc thủng chặn/chặn theo giờ/allowlist/
//     allowlist theo giờ/hết ngân sách (mọi mức <= 55 và cặp chặn-tất-cả
//     15/14), nhưng KHÔNG chọc thủng focus (cặp chặn-tất-cả của focus ở
//     59/58, cao hơn 57).
//   - chặn từ khóa tìm kiếm 65 (0.1.11): cùng mức với redirect
//     SafeSearch/YouTube — đều là redirect main_frame và không xung đột
//     đích (một bên thêm tham số an toàn, một bên về trang chặn; URL sau
//     redirect SafeSearch vẫn chứa cụm từ nên rule chặn từ khóa vẫn khớp
//     ở lần đánh giá sau). Thấp hơn chặn tạm thời (100), cao hơn mọi mức
//     allow để từ khóa cấm không bị allowlist mở qua.
//   - cặp chặn-tất-cả của focus 59/58: dưới mức allow của focus (60) để
//     domain học tập vẫn mở được, trên cho phép tạm thời (57) để cho phép
//     tạm thời không chọc thủng giờ tập trung.
//   - cặp chặn-tất-cả của allowlist/allowlist theo giờ 15/14: dưới mọi
//     mức chặn cụ thể (40/30/20) để domain bị chặn/hết ngân sách hiện
//     đúng lý do của nó thay vì lý do "allowlist".
// Chặn tạm thời (100) luôn dựng, kể cả trong giờ tập trung. Khi focus
// đang hiệu lực, các bộ rule thường (chặn, chặn theo giờ, hết ngân sách,
// allowlist, allowlist theo giờ) và cho phép tạm thời đều KHÔNG dựng —
// focus áp đảo bằng cấu trúc, không chỉ bằng số ưu tiên. Tương tự, khi
// allowlist theo giờ đang hiệu lực, nó THAY cho allowlist thường (mức
// 55 > 50): chỉ domain trong danh sách theo giờ mới mở được.
// Mọi mức khác nhau hoàn toàn để không phụ thuộc luật hòa của trình duyệt.
const PRIORITY = {
  tempBlock: 100,
  redirect: 65,
  searchBlock: 65,
  focusAllow: 60,
  focusBlockAllRedirect: 59,
  focusBlockAll: 58,
  tempAllow: 57,
  allowlistByTimeAllow: 55,
  allowlistAllow: 50,
  time: 40,
  blocked: 30,
  limit: 20,
  blockAllRedirect: 15,
  blockAll: 14,
};

let currentRules = null;
let lastSyncAt = null;
let usage = { date: localDateKey(new Date()), seconds: {} };
// Hàng đợi lượt xem chưa gửi: khóa "domain\nđường dẫn" (từ 0.1.10; khóa
// cũ chỉ domain vẫn đọc được, xem pendingKeyParts) -> {startedAt,
// seconds}. Lưu bền vững cùng usage để service worker ngủ đông không
// làm mất dữ liệu chưa gửi.
let pending = {};
// Hàng đợi lượt web bị chặn chưa gửi: [{domain, startedAt}] — rời rạc từng
// lượt, không gộp theo domain như usage. Lưu bền vững cùng usage để
// service worker ngủ đông không làm mất lượt chặn chưa gửi.
let pendingBlocked = [];
// Hàng đợi cụm từ tìm kiếm chưa gửi (0.1.11): [{engine, term, blocked}]
// — rời rạc từng lượt tìm, term là cụm từ GỐC đã giải mã (cắt 200 ký
// tự). Lưu bền vững cùng usage; gửi qua message reportSearch trong cùng
// chu kỳ flush với reportUsage (xem flushSearchTerms).
let pendingSearch = [];
// Map ruleId -> {domain, isRedirect} của các rule chặn đang áp dụng, dựng
// từ read-back getDynamicRules sau mỗi lần rebuild — dùng để quy chiếu
// domain khi tab tới trang chặn qua redirect DNR (xem handleBlockedPageShown).
// Chỉ rule có domain cụ thể mới vào map: rule chặn-tất-cả (focus/allowlist)
// không có domain nên lượt chặn đó không quy chiếu được và bị bỏ qua.
let blockingRuleDomains = new Map();
// Domain bị chặn của từng tab đang ở trang chặn (tabId -> domain), ghi khi
// watcher chuyển tab hoặc khi quy chiếu DNR thành công — để trang chặn hỏi
// lại khi con bấm nút xin mở (0.1.9). Chỉ sống trong bộ nhớ: service worker
// ngủ đông rồi tỉnh lại thì map rỗng, trang chặn sẽ hỏi lại qua
// getMatchedRules (cửa sổ 10 giây) hoặc dùng tham số domain trong URL.
const blockedDomainByTab = new Map();
const BLOCKED_DOMAIN_BY_TAB_CAP = 200;
// Chống spam nút xin mở (0.1.9): cùng một domain chỉ gửi một yêu cầu trong
// 5 phút (con bấm lại, tải lại trang rồi bấm tiếp). Lớp chống trùng thật
// nằm ở RPC phía server; đây chỉ tránh gửi message native vô ích.
const UNBLOCK_REQUEST_DEDUPE_MS = 5 * 60 * 1000;
const UNBLOCK_REQUEST_DEDUPE_CAP = 200;
const unblockRequestDedupe = new Map();
// Tiền tố URL trang chặn của chính extension, tính lười ở isBlockedPageUrl.
let blockedPagePrefix = null;
let activeTabId = null;
let activeHostname = null;
// Đường dẫn của tab đang hiển thị (đã cắt query/fragment, xem
// pathFromUrl): null khi tab không phải trang http/https, cùng lúc với
// activeHostname = null. Đổi đường dẫn trong cùng domain cũng đóng đoạn
// xem cũ để thời lượng không gộp nhầm sang trang khác.
let activePath = null;
let activeSince = 0;
let windowFocused = true;
let initStarted = false;
// Kết quả tự kiểm tra quyền host gần nhất (xem checkHostPermissions):
// mặc định true (fail-open) cho tới khi kiểm tra lần đầu.
let lastHostPermissionCheckMs = 0;
let lastHostPermissionOk = true;
let hostPermissionCheckPromise = null;

// ---------------------------------------------------------------------------
// Native messaging (callback -> Promise, để chạy giống nhau trên Chrome/Edge)
// ---------------------------------------------------------------------------

function sendNativeMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response === undefined ? null : response);
      });
    } catch {
      resolve(null);
    }
  });
}

async function fetchRules() {
  const response = await sendNativeMessage({ type: "getRules" });
  if (
    !response ||
    response.type !== "rules" ||
    typeof response.rules !== "object" ||
    response.rules === null ||
    Array.isArray(response.rules)
  ) {
    await saveStatus(false);
    return false;
  }
  currentRules = response.rules;
  lastSyncAt = new Date().toISOString();
  await saveStatus(true);
  try {
    await chrome.storage.local.set({ [STORE_KEYS.limits]: extractLimits(currentRules) });
  } catch (error) {
    console.warn("[SafePC] Không lưu được limits cho popup:", error);
  }
  return true;
}

async function saveStatus(connected) {
  try {
    await chrome.storage.local.set({
      [STORE_KEYS.status]: { connected, updatedAt: lastSyncAt },
    });
  } catch (error) {
    console.warn("[SafePC] Không lưu được trạng thái kết nối:", error);
  }
}

// Chỉ giữ hình dạng popup cần: các giới hạn theo domain đã chuẩn hóa.
function extractLimits(rules) {
  const limits = [];
  const entries = Array.isArray(rules.domainLimits) ? rules.domainLimits : [];
  for (const entry of entries) {
    if (!entry || !Number.isInteger(entry.minutesPerDay) || entry.minutesPerDay <= 0) continue;
    const domains = [];
    const raw = Array.isArray(entry.domains) ? entry.domains : [];
    for (const item of raw) {
      const domain = normalizeDomain(item);
      if (domain && !domains.includes(domain)) domains.push(domain);
    }
    if (domains.length > 0) limits.push({ domains, minutesPerDay: entry.minutesPerDay });
  }
  return limits;
}

// ---------------------------------------------------------------------------
// Dựng declarativeNetRequest dynamic rules từ domain_rules.json
// ---------------------------------------------------------------------------

// Khớp domain bằng requestDomains (đợt sửa 18/11/2026): dạng urlFilter
// "||domain^" trước đây đã cài rule thành công nhưng KHÔNG khớp request nào
// trên máy thật (tab mới, 2 rule, không lỗi — youtube.com vẫn tải đủ). Theo
// tài liệu API của Chromium, requestDomains khớp domain và mọi tên miền con
// của nó, không phụ thuộc cú pháp mẫu chuỗi. Chỉ 3 helper dưới đây đổi;
// rule chặn-tất-cả và rule redirect SafeSearch/YouTube vẫn dùng regexFilter.
function redirectRule(id, priority, domain, reason) {
  return {
    id,
    priority,
    action: {
      type: "redirect",
      redirect: { url: chrome.runtime.getURL("blocked.html?reason=" + reason) },
    },
    condition: { requestDomains: [domain], resourceTypes: ["main_frame"] },
  };
}

function blockRule(id, priority, domain) {
  return {
    id,
    priority,
    action: { type: "block" },
    condition: { requestDomains: [domain], resourceTypes: SUB_RESOURCE_TYPES },
  };
}

function allowRule(id, priority, domain) {
  return {
    id,
    priority,
    action: { type: "allow" },
    condition: { requestDomains: [domain] },
  };
}

// Mẫu URL "host/path" (batch 4): chỉ chặn đúng đường dẫn đó, các đường
// dẫn khác cùng host vẫn mở được. requestDomains không diễn đạt được
// đường dẫn, còn urlFilter đã chứng minh không đáng tin trên máy thật
// (xem ghi chú ở redirectRule) nên mẫu URL dùng regexFilter (RE2).
// Trả về null khi mẫu sai hình dạng (rỗng, thiếu "/", host xấu) —
// caller bỏ qua lặng lẽ (fail-open), không bao giờ throw.
function buildUrlPatternRegex(pattern) {
  if (typeof pattern !== "string") return null;
  const trimmed = pattern.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return null;
  const host = normalizeDomain(trimmed.slice(0, slash));
  if (!host) return null;
  const path = trimmed.slice(slash);
  if (path.length === 0) return null;
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Ranh giới host: ([^/]*\.)? chỉ cho phép tên miền con thật — "notbing.com"
  // và "bing.com.evil.com" đều không khớp (cùng kiểu chặn như
  // youtubeRestrictedRule). Cổng显式 tùy chọn (?::\d+)? sau host (0.1.6,
  // sửa MINOR-6): "bing.com:443/videos" phải khớp mẫu "bing.com/videos" —
  // trước đây URL có cổng thoát khỏi mẫu đường dẫn. Nhóm cổng chỉ nhận
  // ":số" nên "bing.com:443.evil.com" vẫn bị loại (sau ":443" là "." chứ
  // không phải path). Ranh giới path: mẫu kết thúc bằng "/" là tiền tố
  // thư mục (khớp mọi thứ bên dưới); ngược lại, sau path phải hết URL hoặc
  // bắt đầu bằng / ? # — "/videos" không khớp "/videosabc".
  const boundary = path.endsWith("/") ? ".*" : "((?:[/?#].*)?)$";
  return "^https?://([^/]*\\.)?" + escapeRe(host) + "(?::\\d+)?" + escapeRe(path) + boundary;
}

function redirectRegexRule(id, priority, regexFilter, reason) {
  return {
    id,
    priority,
    action: {
      type: "redirect",
      redirect: { url: chrome.runtime.getURL("blocked.html?reason=" + reason) },
    },
    condition: { regexFilter, resourceTypes: ["main_frame"] },
  };
}

function blockRegexRule(id, priority, regexFilter) {
  return {
    id,
    priority,
    action: { type: "block" },
    condition: { regexFilter, resourceTypes: SUB_RESOURCE_TYPES },
  };
}

// RE2 (regex của DNR) không có lookahead nên không viết được "URL chưa có
// safe=active". Mẹo: chỉ khớp URL mà phần query KHÔNG bắt đầu đúng bằng
// "<param>&" — sau redirect, query bắt đầu đúng bằng "<param>&" nên rule
// không khớp nữa, không lặp redirect. Liệt kê mọi vị trí mà query có thể
// khác với prefix: tại vị trí i, i ký tự đầu khớp prefix, ký tự thứ i khác.
function notStartingWithAlternation(prefix) {
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = [];
  for (let i = 0; i < prefix.length; i++) {
    parts.push(escapeRe(prefix.slice(0, i)) + "[^" + escapeRe(prefix[i]) + "]");
  }
  return parts.join("|");
}

// Redirect tìm kiếm sang cùng URL nhưng có thêm tham số SafeSearch ở đầu
// query, giữ nguyên phần còn lại của query (nhóm 1 = đầu URL tới '?', nhóm
// 2 = phần đầu query khác prefix, nhóm 3 = phần còn lại).
function safeSearchRule(id, hostPattern, paramPair) {
  const prefix = paramPair + "&";
  const filter =
    "^(https://" +
    hostPattern +
    "/search\\?)(" +
    notStartingWithAlternation(prefix) +
    ")(.*)$";
  return {
    id,
    priority: PRIORITY.redirect,
    action: {
      type: "redirect",
      redirect: { regexSubstitution: "\\1" + paramPair + "&\\2\\3" },
    },
    condition: { regexFilter: filter, resourceTypes: ["main_frame"] },
  };
}

function youtubeRestrictedRule(id) {
  // Cơ chế chính thức của Google: restrict.youtube.com ép chế độ hạn chế
  // (Restricted Mode). Giữ nguyên path+query (nhóm 1). Host đích khác host
  // nguồn nên không lặp redirect.
  return {
    id,
    priority: PRIORITY.redirect,
    action: {
      type: "redirect",
      redirect: { regexSubstitution: "https://restrict.youtube.com\\1" },
    },
    condition: {
      // Sau youtube.com phải là hết URL hoặc bắt đầu path/query/fragment
      // ([/?#]) — nếu không, "youtube.com.evil.com" cũng khớp (lỗi đã bắt
      // được bằng kiểm thử). Nhóm 1 luôn tham gia (có thể rỗng) để \1 an toàn.
      regexFilter: "^https://(?:www\\.|m\\.)youtube\\.com((?:[/?#].*)?)$",
      resourceTypes: ["main_frame", "sub_frame"],
    },
  };
}

function unexpiredTempDomains(entries, nowMs) {
  const domains = new Set();
  const list = Array.isArray(entries) ? entries : [];
  for (const entry of list) {
    if (!entry || typeof entry.expiresAt !== "string") continue;
    const expiresMs = Date.parse(entry.expiresAt);
    if (Number.isNaN(expiresMs) || expiresMs <= nowMs) continue;
    const raw = Array.isArray(entry.domains) ? entry.domains : [];
    for (const item of raw) {
      const domain = normalizeDomain(item);
      if (domain) domains.add(domain);
    }
  }
  return domains;
}

function isWindowActiveNow(windowsByWeekday, now) {
  if (!windowsByWeekday || typeof windowsByWeekday !== "object") return false;
  const ranges = windowsByWeekday[String(now.getDay())];
  if (!Array.isArray(ranges)) return false;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  for (const range of ranges) {
    if (!range) continue;
    const start = hhmmToMinutes(range.start);
    const end = hhmmToMinutes(range.end);
    if (start === null || end === null || start >= end) continue;
    if (nowMinutes >= start && nowMinutes < end) return true;
  }
  return false;
}

// Domain nào đã dùng hết ngân sách hôm nay (cộng dồn mọi hostname khớp hậu
// tố với rule; nhiều rule cùng domain thì lấy ngân sách nhỏ nhất).
function computeExhaustedDomains(rules, usageSeconds) {
  const budgets = new Map();
  const entries = Array.isArray(rules.domainLimits) ? rules.domainLimits : [];
  for (const entry of entries) {
    if (!entry || !Number.isInteger(entry.minutesPerDay) || entry.minutesPerDay <= 0) continue;
    const raw = Array.isArray(entry.domains) ? entry.domains : [];
    for (const item of raw) {
      const domain = normalizeDomain(item);
      if (!domain) continue;
      if (!budgets.has(domain) || entry.minutesPerDay < budgets.get(domain)) {
        budgets.set(domain, entry.minutesPerDay);
      }
    }
  }
  const exhausted = new Set();
  for (const [ruleDomain, minutes] of budgets) {
    let used = 0;
    for (const [host, sec] of Object.entries(usageSeconds)) {
      if (domainMatches(host, ruleDomain)) used += sec;
    }
    if (used >= minutes * 60) exhausted.add(ruleDomain);
  }
  return exhausted;
}

function normalizeDomainSet(rawList) {
  const domains = new Set();
  const list = Array.isArray(rawList) ? rawList : [];
  for (const item of list) {
    const domain = normalizeDomain(item);
    if (domain) domains.add(domain);
  }
  return domains;
}

// Thứ tự chuẩn của danh mục chặn (0.1.8) — khớp đúng
// DomainCategoryLists.OrderedIds phía Agent: một domain thuộc hai danh
// mục thì hiện lý do của danh mục đứng trước. Id lạ (Agent mới hơn
// extension) thì bỏ qua, domain đó vẫn bị chặn với lý do "blocked"
// chung — fail-open, không bao giờ hiện lý do mà blocked.js không có.
const CATEGORY_REASON_ORDER = ["adult", "gambling", "social"];

// Map domain -> lý do theo danh mục ("category-<id>") từ
// rules.blockedCategories = { "<id>": [domain, ...], ... }. Hàm thuần,
// không bao giờ throw: dữ liệu thiếu/sai hình dạng thì trả map rỗng
// (mọi domain chặn đều dùng lý do "blocked" như trước).
function buildCategoryReasonMap(rules) {
  const map = new Map();
  try {
    const byCategory =
      rules && rules.blockedCategories && typeof rules.blockedCategories === "object" &&
      !Array.isArray(rules.blockedCategories)
        ? rules.blockedCategories
        : null;
    if (!byCategory) return map;
    for (const category of CATEGORY_REASON_ORDER) {
      const raw = byCategory[category];
      if (!Array.isArray(raw)) continue;
      for (const item of raw) {
        const domain = normalizeDomain(item);
        if (domain && !map.has(domain)) map.set(domain, "category-" + category);
      }
    }
  } catch {
    // Dữ liệu lạ: trả map đã dựng dở (an toàn vì chỉ ảnh hưởng lý do hiển thị).
  }
  return map;
}

function buildDnrRules(rules, usageSeconds, now) {
  // Chưa có rules (chưa nối được NativeHost lần nào): không chặn gì
  // (fail-open, popup báo chưa kết nối). Rules cũ vẫn giữ khi fetch lỗi.
  if (!rules) return [];
  const nowMs = now.getTime();
  const rulesOut = [];
  let nextId = 1;

  const tempBlock = unexpiredTempDomains(rules.tempBlock, nowMs);
  const tempAllow = unexpiredTempDomains(rules.tempAllow, nowMs);
  const blocked = normalizeDomainSet(rules.blocked);
  const allowlist = Array.isArray(rules.allowlist) ? normalizeDomainSet(rules.allowlist) : null;

  // Giờ học tập trung: DomainRulesPublisher gộp các rule focus thành
  // rules.focus = {"windowsByWeekday": {...}, "allowedDomains": [...]} hoặc
  // null khi không có rule focus nào. Focus thiếu/sai hình dạng, khung giờ
  // không hợp lệ, hoặc danh sách cho phép rỗng đều nghĩa là "không focus"
  // (fail-open, không bao giờ throw): danh sách cho phép rỗng mà vẫn chặn
  // tất cả thì sẽ khóa cả trình duyệt.
  const focus =
    rules.focus && typeof rules.focus === "object" && !Array.isArray(rules.focus)
      ? rules.focus
      : null;
  const focusAllowed = focus ? normalizeDomainSet(focus.allowedDomains) : new Set();
  const focusActive =
    focus !== null &&
    focusAllowed.size > 0 &&
    isWindowActiveNow(focus.windowsByWeekday, now);

  const timeBlocked = new Set();
  const timeEntries = Array.isArray(rules.blockedByTime) ? rules.blockedByTime : [];
  for (const entry of timeEntries) {
    if (!entry || !isWindowActiveNow(entry.windowsByWeekday, now)) continue;
    for (const domain of normalizeDomainSet(entry.domains)) timeBlocked.add(domain);
  }

  const exhausted = computeExhaustedDomains(rules, usageSeconds);

  // Danh sách cho phép theo giờ: DomainRulesPublisher xuất
  // rules.allowlistByTime = [{"domains": [...], "windowsByWeekday": {...}},
  // ...] (mỗi phần tử là một rule allowlist_by_time). Chỉ các phần tử
  // đang trong khung giờ (giờ địa phương, cùng helper isWindowActiveNow
  // với blockedByTime, đánh giá lại mỗi phút theo chu kỳ alarm) mới góp
  // domain; hợp các danh sách đang hiệu lực lại. Dữ liệu thiếu/sai hình
  // dạng, khung giờ không hợp lệ, hoặc không còn domain nào sau khi chuẩn
  // hóa đều nghĩa là "không hiệu lực" (fail-open, không bao giờ throw):
  // danh sách cho phép rỗng mà vẫn chặn tất cả thì sẽ khóa cả trình
  // duyệt — cùng nguyên tắc với focus.
  const allowlistByTimeAllowed = new Set();
  const allowlistByTimeEntries = Array.isArray(rules.allowlistByTime)
    ? rules.allowlistByTime
    : [];
  for (const entry of allowlistByTimeEntries) {
    if (!entry || !isWindowActiveNow(entry.windowsByWeekday, now)) continue;
    for (const domain of normalizeDomainSet(entry.domains)) allowlistByTimeAllowed.add(domain);
  }
  const allowlistByTimeActive = allowlistByTimeAllowed.size > 0;

  const addPair = (domains, priority, reason) => {
    for (const domain of domains) {
      rulesOut.push(redirectRule(nextId++, priority, domain, reason));
      rulesOut.push(blockRule(nextId++, priority, domain));
    }
  };

  // Cặp chặn-tất-cả của một chế độ allowlist: mọi request http/https còn
  // lại (không khớp rule allow nào ở mức cao hơn) đều chuyển tới trang
  // chặn. Trang chặn của chính extension (chrome-extension://...) không
  // bị ảnh hưởng vì regex chỉ khớp http/https.
  const addBlockAll = (reason, redirectPriority, blockPriority) => {
    rulesOut.push({
      id: nextId++,
      priority: redirectPriority,
      action: {
        type: "redirect",
        redirect: { url: chrome.runtime.getURL("blocked.html?reason=" + reason) },
      },
      condition: { regexFilter: "^https?://", resourceTypes: ["main_frame"] },
    });
    rulesOut.push({
      id: nextId++,
      priority: blockPriority,
      action: { type: "block" },
      condition: { regexFilter: "^https?://", resourceTypes: SUB_RESOURCE_TYPES },
    });
  };

  // Chặn tạm thời LUÔN áp dụng (ưu tiên 100, thắng cả danh sách cho phép
  // của focus). Khi focus đang hiệu lực, các bộ rule thường (chặn, chặn
  // theo giờ, hết ngân sách, allowlist, allowlist theo giờ) và cho phép
  // tạm thời đều BỎ QUA: cho phép tạm thời không được chọc thủng giờ tập
  // trung (xem thang ưu tiên ở PRIORITY).
  addPair(tempBlock, PRIORITY.tempBlock, "tempblock");
  if (!focusActive) {
    for (const domain of tempAllow) rulesOut.push(allowRule(nextId++, PRIORITY.tempAllow, domain));
    // Chặn domain (kể cả domain thuộc danh mục đã chọn — Agent đã hợp
    // vào `blocked`): mỗi domain một cặp rule ở mức ưu tiên chặn (30),
    // lý do theo danh mục khi domain thuộc danh mục (xem
    // buildCategoryReasonMap), ngược lại lý do "blocked" chung. Một
    // domain chỉ có đúng một cặp rule nên không phụ thuộc luật hòa của
    // trình duyệt khi domain vừa gõ tay vừa thuộc danh mục.
    const categoryReasons = buildCategoryReasonMap(rules);
    for (const domain of blocked) {
      const reason = categoryReasons.get(domain) || "blocked";
      rulesOut.push(redirectRule(nextId++, PRIORITY.blocked, domain, reason));
      rulesOut.push(blockRule(nextId++, PRIORITY.blocked, domain));
    }
    // Mẫu URL (batch 4): rules.urlPatterns = ["host/path", ...] từ
    // DomainRulesPublisher (chỉ mode block_domains). Cùng nhánh
    // !focusActive và cùng mức ưu tiên chặn domain (30) với cặp chặn
    // domain — focus áp đảo bằng cấu trúc nên mẫu URL cũng bỏ qua khi
    // focus hiệu lực. Mẫu sai hình dạng bị bỏ qua lặng lẽ (fail-open);
    // khử trùng lặp theo chuỗi regex để không phí quota rule.
    const urlPatternFilters = new Set();
    const rawPatterns = Array.isArray(rules.urlPatterns) ? rules.urlPatterns : [];
    for (const pattern of rawPatterns) {
      const filter = buildUrlPatternRegex(pattern);
      if (!filter || urlPatternFilters.has(filter)) continue;
      urlPatternFilters.add(filter);
      rulesOut.push(redirectRegexRule(nextId++, PRIORITY.blocked, filter, "blocked"));
      rulesOut.push(blockRegexRule(nextId++, PRIORITY.blocked, filter));
    }
    addPair(timeBlocked, PRIORITY.time, "time");
    addPair(exhausted, PRIORITY.limit, "limit");
  }

  // Chặn từ khóa tìm kiếm (0.1.11): rules.searchGuard.blockedKeywords
  // (Agent hợp từ mọi rule mode 'block_search_keywords', đã chuẩn hóa
  // trim + chữ thường) -> một rule redirect cho mỗi cặp (công cụ x từ
  // khóa) ở ưu tiên searchBlock (65), đích là trang chặn lý do
  // "search-keyword" (chỉ reason — KHÔNG kèm cụm từ vào URL). Regex
  // khớp trên URL thô còn mã hóa (xem buildSearchBlockRegex); biến thể
  // mã hóa mà regex không diễn đạt được (gõ khác hoa/thường ở ký tự có
  // dấu, gõ không dấu...) do tab watcher bắt dự phòng bằng đối chiếu
  // đã bỏ dấu. searchGuard vắng/rỗng -> không dựng rule nào, và vì mỗi
  // lần rebuild thay toàn bộ dynamic rules nên rule search cũ cũng
  // biến mất. Khử trùng lặp theo chuỗi regex (nhiều từ khóa chuẩn hóa
  // có thể cho cùng một mẫu).
  // NGÂN SÁCH REGEX (sửa theo review 27/11/2026): chỉ dựng rule cho
  // tối đa MAX_SEARCH_DNR_KEYWORDS từ khóa đầu tiên — xem hằng số đó.
  // Rule search được áp bằng lời gọi updateDynamicRules RIÊNG (nhóm
  // thứ ba trong rebuildDynamicRules, nhận diện qua isSearchBlockRule)
  // để lỗi trần regex của nhóm này không đóng băng nhóm chặn chính.
  const searchGuard =
    rules.searchGuard && typeof rules.searchGuard === "object" && !Array.isArray(rules.searchGuard)
      ? rules.searchGuard
      : null;
  const allSearchKeywords = searchGuard && Array.isArray(searchGuard.blockedKeywords)
    ? searchGuard.blockedKeywords
    : [];
  const searchKeywords = allSearchKeywords.slice(0, MAX_SEARCH_DNR_KEYWORDS);
  if (allSearchKeywords.length > searchKeywords.length) {
    console.warn(
      "[SafePC] Danh sách từ khóa tìm kiếm có " + allSearchKeywords.length +
      " từ, vượt ngân sách rule DNR: chỉ dựng rule cho " + searchKeywords.length +
      " từ đầu; " + (allSearchKeywords.length - searchKeywords.length) +
      " từ còn lại vẫn bị tab watcher thi hành (đối chiếu đã bỏ dấu).",
    );
  }
  if (searchKeywords.length > 0) {
    const seenSearchFilters = new Set();
    for (const keyword of searchKeywords) {
      for (const engineId of searchEngineIds) {
        const filter = buildSearchBlockRegex(engineId, keyword);
        if (!filter || seenSearchFilters.has(filter)) continue;
        seenSearchFilters.add(filter);
        rulesOut.push(redirectRegexRule(nextId++, PRIORITY.searchBlock, filter, "search-keyword"));
      }
    }
  }

  if (rules.safeSearch) {
    // Google dùng tham số safe=active. Bing không dùng tham số này mà dùng
    // adlt=strict (cơ chế chính thức của Bing) — xem README.md.
    const googleHost = "(?:www\\.)?google\\.(?:com|com\\.[a-z]{2}|co\\.[a-z]{2}|[a-z]{2,3})";
    rulesOut.push(safeSearchRule(nextId++, googleHost, "safe=active"));
    rulesOut.push(safeSearchRule(nextId++, "(?:www\\.)?bing\\.com", "adlt=strict"));
  }
  if (rules.youtubeRestricted) {
    rulesOut.push(youtubeRestrictedRule(nextId++));
  }

  if (focusActive) {
    // Giờ tập trung: chỉ các domain học tập được phép mới mở được; mọi
    // website còn lại chuyển tới trang chặn (lý do "focus").
    for (const domain of focusAllowed) rulesOut.push(allowRule(nextId++, PRIORITY.focusAllow, domain));
    addBlockAll("focus", PRIORITY.focusBlockAllRedirect, PRIORITY.focusBlockAll);
  } else if (allowlistByTimeActive) {
    // Allowlist theo giờ đang hiệu lực: THAY cho allowlist thường (mức
    // 55 > 50) — chỉ các domain trong danh sách theo giờ mới mở được;
    // mọi website còn lại chuyển tới trang chặn với lý do "allowlist"
    // (dùng chung mục REASONS.allowlist trong blocked.js, không thêm
    // chuỗi lý do mới). Ngoài khung giờ, nhánh này không dựng nên hành
    // vi trở lại như cũ (allowlist thường nếu có).
    for (const domain of allowlistByTimeAllowed) {
      rulesOut.push(allowRule(nextId++, PRIORITY.allowlistByTimeAllow, domain));
    }
    addBlockAll("allowlist", PRIORITY.blockAllRedirect, PRIORITY.blockAll);
  } else if (allowlist !== null) {
    // Chế độ allowlist: chỉ các domain trong danh sách mới mở được.
    for (const domain of allowlist) rulesOut.push(allowRule(nextId++, PRIORITY.allowlistAllow, domain));
    addBlockAll("allowlist", PRIORITY.blockAllRedirect, PRIORITY.blockAll);
  }

  if (rulesOut.length > MAX_DNR_RULES) {
    console.warn("[SafePC] Quá nhiều DNR rules, đã cắt xuống " + MAX_DNR_RULES + ".");
    return rulesOut.slice(0, MAX_DNR_RULES);
  }
  return rulesOut;
}

// Rule redirect SafeSearch/YouTube là nhóm duy nhất dùng regexSubstitution
// (xem safeSearchRule/youtubeRestrictedRule); mọi rule chặn/cho phép khác
// dùng redirect { url } tới trang chặn hoặc action block/allow. Dấu hiệu
// này dùng để tách 2 nhóm khi áp rule (xem rebuildDynamicRules), không
// đổi logic dựng rule.
function isSafeSearchRedirectRule(rule) {
  return (
    rule &&
    rule.action &&
    rule.action.type === "redirect" &&
    rule.action.redirect &&
    typeof rule.action.redirect.regexSubstitution === "string"
  );
}

// Rule chặn từ khóa tìm kiếm (0.1.11) nhận diện bằng mức ưu tiên riêng
// searchBlock (65) — không rule nào khác dùng mức này cho redirect về
// trang chặn (mức 65 còn lại là redirect SafeSearch, đã tách bằng
// regexSubstitution ở trên). Dùng để tách rule search thành lời gọi
// updateDynamicRules riêng trong rebuildDynamicRules (sửa theo review
// 27/11/2026) và để ẩn pattern chứa từ khóa trong tóm tắt chẩn đoán
// (buildRuleSummary).
function isSearchBlockRule(rule) {
  return !!rule && rule.priority === PRIORITY.searchBlock && !isSafeSearchRedirectRule(rule);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// Tóm tắt rule DNR đang áp dụng cho popup chẩn đoán (đợt sửa 18/11/2026):
// mỗi rule một mục {id, priority, action, pattern}. Bỏ qua mục sai hình
// dạng, không bao giờ throw — chẩn đoán không được làm hỏng lần rebuild.
// Pattern là mẫu của rule (urlFilter/regexFilter/requestDomains), không phải URL đã duyệt.
// Không giới hạn số mục (0.1.6, sửa MINOR-5): danh sách phải bao hết mọi
// rule đang áp — kể cả rule regex của mẫu URL — để khớp đúng với số lượng
// appliedCount mà popup hiển thị; giới hạn cũ (10 mục) khiến danh sách
// hiện ngắn hơn số lượng khi có hơn 10 rule.
function buildRuleSummary(rules) {
  const summary = [];
  const list = Array.isArray(rules) ? rules : [];
  for (const rule of list) {
    if (!rule || typeof rule !== "object") continue;
    if (!Number.isInteger(rule.id) || !Number.isInteger(rule.priority)) continue;
    const condition = rule.condition;
    const action = rule.action;
    if (!condition || typeof condition !== "object") continue;
    if (!action || typeof action !== "object" || typeof action.type !== "string") continue;
    const urlFilter = typeof condition.urlFilter === "string" ? condition.urlFilter : "";
    const regexFilter = typeof condition.regexFilter === "string" ? condition.regexFilter : "";
    const requestDomains = Array.isArray(condition.requestDomains)
      ? condition.requestDomains.filter((d) => typeof d === "string" && d.length > 0).join(",")
      : "";
    // Rule chặn từ khóa tìm kiếm (0.1.11, sửa theo review 27/11/2026):
    // regexFilter của chúng CHỨA TỪ KHÓA CẤM của phụ huynh ở dạng đọc
    // được — popup chẩn đoán mở được ngay trên máy con nên không lộ
    // pattern này, thay bằng nhãn cố định. Số lượng rule vẫn đếm đủ.
    const pattern = isSearchBlockRule(rule)
      ? "(từ khóa tìm kiếm)"
      : urlFilter || regexFilter || requestDomains;
    summary.push({
      id: rule.id,
      priority: rule.priority,
      action: action.type,
      pattern,
    });
  }
  return summary;
}

// Tự kiểm tra quyền host (0.1.6, bài học 0.1.4): rule DNR redirect BẮT
// BUỘC phải có host permission khớp URL request — thiếu thì trình duyệt bỏ
// qua rule lặng lẽ, không lỗi, không dấu hiệu. Hàm này kiểm tra bằng
// chrome.permissions.contains (API này không cần khai báo thêm quyền nào
// trong manifest) và kết quả được ghi vào chẩn đoán safepc_dnr để popup
// cảnh báo khi thiếu. Throttle 3 phút: trạng thái quyền chỉ đổi khi người
// dùng thu hồi thủ công trong chrome://extensions, nên không cần kiểm tra
// mỗi lần rebuild (30 giây) hay mỗi lần điều hướng. Fail-open: API lỗi,
// API vắng, hoặc trả về khác false đều coi như đủ quyền — chẩn đoán không
// được báo động giả. Không bao giờ throw.
const HOST_PERMISSION_ORIGINS = ["http://*/*", "https://*/*"];
const HOST_PERMISSION_CHECK_INTERVAL_MS = 3 * 60 * 1000;

async function checkHostPermissions() {
  const nowMs = Date.now();
  if (nowMs - lastHostPermissionCheckMs < HOST_PERMISSION_CHECK_INTERVAL_MS) {
    return lastHostPermissionOk;
  }
  // Đang có lần kiểm tra chạy dở (rebuild chồng nhau): chờ nó thay vì gọi
  // thêm API. Lỗi thì dùng kết quả cũ, lần sau thử lại.
  if (hostPermissionCheckPromise) {
    try {
      await hostPermissionCheckPromise;
    } catch {
      // Dùng kết quả cũ (fail-open).
    }
    return lastHostPermissionOk;
  }
  hostPermissionCheckPromise = (async () => {
    try {
      if (chrome.permissions && typeof chrome.permissions.contains === "function") {
        const granted = await chrome.permissions.contains({ origins: HOST_PERMISSION_ORIGINS });
        lastHostPermissionOk = granted !== false;
      }
    } catch (error) {
      console.warn("[SafePC] Không kiểm tra được host permissions:", error);
    } finally {
      lastHostPermissionCheckMs = Date.now();
    }
  })();
  try {
    await hostPermissionCheckPromise;
  } finally {
    hostPermissionCheckPromise = null;
  }
  return lastHostPermissionOk;
}

async function rebuildDynamicRules() {
  const now = new Date();
  let error = null;
  try {
    const rules = buildDnrRules(currentRules, usage.seconds, now);
    const searchRules = rules.filter(isSearchBlockRule);
    const mainRules = rules.filter((rule) => !isSafeSearchRedirectRule(rule) && !isSearchBlockRule(rule));
    const redirectRules = rules.filter(isSafeSearchRedirectRule);
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing.map((r) => r.id);
    // Áp thành các lời gọi riêng theo nhóm (đợt sửa 17/11/2026, mở rộng
    // 27/11/2026): updateDynamicRules là nguyên tử theo từng lần gọi,
    // nên 1 rule hỏng trong một nhóm không kéo sập các nhóm còn lại.
    // Nhóm chặn/cho phép áp trước, kèm xóa TOÀN BỘ rule cũ (gồm cả rule
    // search + redirect cũ); các nhóm sau chỉ addRules và chỉ áp khi
    // nhóm chính đã đứng. Nhóm search tách riêng vì nó ăn ngân sách
    // rule regex riêng của Chrome (1000 rule động): lỗi trần regex ở
    // nhóm này không được đóng băng nhóm chặn domain.
    let mainApplied = false;
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds,
        addRules: mainRules,
      });
      mainApplied = true;
    } catch (groupError) {
      error = errorMessage(groupError);
      console.warn("[SafePC] Không áp được nhóm rule chặn/cho phép:", groupError);
    }
    if (mainApplied && redirectRules.length > 0) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ addRules: redirectRules });
      } catch (groupError) {
        error = errorMessage(groupError);
        console.warn("[SafePC] Không áp được nhóm rule redirect SafeSearch/YouTube:", groupError);
      }
    }
    if (mainApplied && searchRules.length > 0) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ addRules: searchRules });
      } catch (groupError) {
        if (error === null) error = errorMessage(groupError);
        console.warn("[SafePC] Không áp được nhóm rule chặn từ khóa tìm kiếm:", groupError);
      }
    }
  } catch (buildError) {
    error = errorMessage(buildError);
    console.warn("[SafePC] Không rebuild được dynamic rules:", buildError);
  }

  // Chẩn đoán cho popup (đợt sửa 17/11/2026, mở rộng 18/11/2026): số rule
  // thực tế trình duyệt đang áp dụng (đọc lại sau khi cập nhật), số domain
  // đang chặn (hợp các domain chặn + chặn tạm thời chưa hết hạn, sau chuẩn
  // hóa), danh sách domain đang chặn, tóm tắt các rule đang áp dụng, lỗi
  // của lần rebuild gần nhất, và kết quả tự kiểm tra quyền host (0.1.6).
  // Chỉ ghi storage + console.warn, không throw, không hiện gì khác cho user.
  let appliedRules = [];
  let readBackOk = false;
  try {
    appliedRules = await chrome.declarativeNetRequest.getDynamicRules();
    if (!Array.isArray(appliedRules)) appliedRules = [];
    readBackOk = true;
  } catch (readError) {
    console.warn("[SafePC] Không đọc lại được dynamic rules:", readError);
    if (error === null) error = errorMessage(readError);
  }
  const appliedCount = appliedRules.length;
  // Map quy chiếu domain cho lượt chặn DNR (0.1.7): dựng từ read-back —
  // dữ liệu thật đang áp dụng, không phải danh sách vừa dựng (nhóm áp có
  // thể lỗi một phần). Read-back lỗi thì giữ map cũ (mô tả đúng rule đang
  // áp dụng hơn là map rỗng): chỉ gán map mới khi read-back thành công.
  if (readBackOk) {
    try {
      blockingRuleDomains = buildBlockingRuleMap(appliedRules, currentRules);
    } catch (mapError) {
      console.warn("[SafePC] Không cập nhật được map rule chặn:", mapError);
    }
  }
  const blockedDomains = normalizeDomainSet(currentRules ? currentRules.blocked : null);
  const tempBlocked = unexpiredTempDomains(
    currentRules ? currentRules.tempBlock : null,
    now.getTime(),
  );
  const blockedUnion = new Set([...blockedDomains, ...tempBlocked]);
  const blockedCount = blockedUnion.size;
  // Không cắt danh sách: popup hiện "Đang chặn: N domain." kèm liệt kê,
  // cắt ở 10 mục từng khiến số lượng và danh sách lệch nhau (cùng lớp
  // lỗi MINOR-5 của ruleSummary, sửa chung ở 0.1.6).
  const blockedDomainsList = [...blockedUnion].sort();
  let ruleSummary = [];
  try {
    ruleSummary = buildRuleSummary(appliedRules);
  } catch (summaryError) {
    console.warn("[SafePC] Không tóm tắt được dynamic rules:", summaryError);
    ruleSummary = [];
  }
  // Tự kiểm tra quyền host (0.1.6): có throttle bên trong nên lần rebuild
  // nào cũng gọi được (khởi động + định kỳ theo alarm, không gọi mỗi lần
  // điều hướng). Lỗi thì fail-open (true) — xem checkHostPermissions.
  let hostPermissionsOk = true;
  try {
    hostPermissionsOk = await checkHostPermissions();
  } catch (checkError) {
    console.warn("[SafePC] Không kiểm tra được host permissions:", checkError);
  }
  try {
    await chrome.storage.local.set({
      [STORE_KEYS.dnr]: {
        appliedCount,
        blockedCount,
        blockedDomains: blockedDomainsList,
        ruleSummary,
        error,
        hostPermissionsOk,
        updatedAt: now.toISOString(),
      },
    });
  } catch (storeError) {
    console.warn("[SafePC] Không lưu được chẩn đoán DNR:", storeError);
  }

  // Tab watcher (0.1.5): rule vừa áp thành công thì đánh giá lại mọi tab
  // đang mở để lật trang từ bộ nhớ đệm sang trang chặn. Chỉ chạy khi cả
  // hai nhóm rule đã áp được (error === null); fire-and-forget, không throw.
  if (error === null) void sweepOpenTabs();
}

async function refreshRulesAndRebuild() {
  await fetchRules();
  // Dù fetch thất bại vẫn rebuild từ rules cũ: khung giờ/ngân sách/ghi đè
  // tạm thời được đánh giá lại theo thời gian hiện tại.
  await rebuildDynamicRules();
}

// ---------------------------------------------------------------------------
// Tab watcher (0.1.5): lưới dự phòng cho DNR.
//
// DNR chỉ đánh giá request mạng. Hai trường hợp DNR không bao giờ thấy:
//  (1) tab đang mở hiển thị trang từ bộ nhớ đệm (đệm HTTP / service worker /
//      trang tải trước): không có request main_frame mới nên trang cũ vẫn
//      hiện dù rule đã đổi;
//  (2) điều hướng trong trang (SPA đổi URL bằng history.pushState, ví dụ
//      bấm từ trang chủ YouTube vào Shorts): URL đổi nhưng không có request
//      main_frame mới nên rule đường dẫn không chặn được.
// Watcher lấp hai lỗ này: nghe chrome.tabs.onUpdated (changeInfo.url xuất
// hiện cả khi pushState) và đánh giá lại mọi tab sau mỗi lần rebuild rule
// thành công; tab nào thuộc diện chặn thì chuyển sang trang chặn bằng
// chrome.tabs.update.
//
// CHỈ thi hành tập con vô điều kiện (xem isTabUrlBlocked): chặn domain,
// mẫu URL, chặn tạm thời — trừ cho phép tạm thời. Chặn theo giờ, giới hạn
// thời gian, focus, allowlist KHÔNG thi hành ở đây: chúng phụ thuộc thời
// gian/ngữ cảnh mà DNR đã lo ở request mới; watcher chỉ là lưới dự phòng,
// không được đoán sai và chặn nhầm trang được phép.
// ---------------------------------------------------------------------------

// Làm tươi rule khi điều hướng: alarm 1 phút có thể bị trình duyệt trì hoãn
// (đã thấy giờ đồng bộ cũ hơn 3 phút trên máy thật), nên mỗi lần tab đổi URL
// thì làm tươi rule nếu lần fetch thành công gần nhất đã quá 15 giây.
// Throttle này tránh spawn NativeHost liên tục khi đổi tab nhanh; alarm 1
// phút vẫn là dự phòng. lastSyncAt chỉ được fetchRules cập nhật khi fetch
// thành công nên mốc này đo đúng "lần fetch thành công gần nhất".
const NAVIGATION_REFRESH_MIN_INTERVAL_MS = 15000;
let navigationRefreshPromise = null;

async function maybeRefreshRulesForNavigation() {
  const lastOkMs = lastSyncAt ? Date.parse(lastSyncAt) : Number.NaN;
  if (!Number.isNaN(lastOkMs) && Date.now() - lastOkMs <= NAVIGATION_REFRESH_MIN_INTERVAL_MS) {
    return;
  }
  // Đang có lần làm tươi chạy dở (điều hướng dồn dập): chờ nó thay vì spawn
  // thêm NativeHost. Lỗi thì bỏ qua, dùng rules cũ.
  if (navigationRefreshPromise) {
    try {
      await navigationRefreshPromise;
    } catch {
      // Dùng rules cũ, lần điều hướng sau thử lại.
    }
    return;
  }
  navigationRefreshPromise = (async () => {
    try {
      await fetchRules();
    } catch (error) {
      console.warn("[SafePC] Làm tươi rule khi điều hướng lỗi:", error);
    }
  })();
  try {
    await navigationRefreshPromise;
  } finally {
    navigationRefreshPromise = null;
  }
}

// Host của một mẫu URL dạng "host/path" (chuẩn hóa, chữ thường), null
// khi mẫu không có phần host. Dùng chung cho map quy chiếu DNR và đường
// watcher để hai đường ghi lượt chặn cùng một đơn vị domain.
function urlPatternHost(pattern) {
  if (typeof pattern !== "string") return null;
  const trimmed = pattern.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return null;
  return normalizeDomain(trimmed.slice(0, slash));
}

// Quyết định watcher có phải chặn URL này không, kèm domain của rule đã
// khớp. Trả về {reason, ruleDomain} khi phải chặn, null khi không chặn.
// ruleDomain là ĐƠN VỊ GHI LƯỢT CHẶN: domain của rule đã khớp (mục chặn
// domain/chặn tạm thời, hoặc host của mẫu URL) — cùng đơn vị với đường
// quy chiếu DNR (buildBlockingRuleMap), để dedupe 60s chung gộp được
// một lần chặn dù cả hai đường cùng ghi. ruleDomain có thể null khi
// mẫu khớp nhưng không tách được host — khi đó bên gọi dùng hostname
// làm dự phòng. Hàm thuần (không chạm chrome.*) để kiểm thử được ngoài
// trình duyệt.
//
// TẬP CON THI HÀNH — khớp đúng ngữ nghĩa DNR cho tập con này, theo thang
// ưu tiên đã khóa ở PRIORITY:
//   1. tempBlock chưa hết hạn thắng mọi thứ trong tập con (ưu tiên 100,
//      cao hơn cả cho phép tạm thời 57) -> lý do "tempblock".
//   2. tempAllow chưa hết hạn thắng chặn domain/mẫu URL (ưu tiên 57 > 30)
//      -> không chặn. (Trong giờ tập trung, DNR không dựng rule tempAllow;
//      watcher không đánh giá focus nên trường hợp đó DNR vẫn chặn ở
//      request mới — watcher chỉ bỏ qua, không mở thêm gì.)
//   3. Hostname thuộc `blocked` (ngữ nghĩa requestDomains: domain + mọi
//      tên miền con) -> lý do "blocked", hoặc lý do theo danh mục
//      ("category-<id>") khi domain của rule thuộc một danh mục đã chọn
//      (cùng map buildCategoryReasonMap với đường DNR, để hai đường hiện
//      cùng lý do cho cùng một domain).
//   4. URL khớp một mẫu trong `urlPatterns`, dùng ĐÚNG regex mà DNR dùng
//      (buildUrlPatternRegex) -> lý do "blocked".
// KHÔNG thi hành: chặn theo giờ, giới hạn thời gian, focus, allowlist.
// Guard: chỉ URL http/https có hostname; mọi URL khác (chrome://,
// chrome-extension://, edge://, about:, file://, URL hỏng) đều bỏ qua.
// Không bao giờ throw: dữ liệu lạ -> fail-open (null).
function evaluateTabUrl(url, rules, now) {
  if (typeof url !== "string" || url.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) return null;
  if (!rules || typeof rules !== "object") return null;
  const nowMs = now instanceof Date ? now.getTime() : Date.now();

  const tempBlocked = unexpiredTempDomains(rules.tempBlock, nowMs);
  for (const domain of tempBlocked) {
    if (domainMatches(hostname, domain)) return { reason: "tempblock", ruleDomain: domain };
  }

  const tempAllowed = unexpiredTempDomains(rules.tempAllow, nowMs);
  for (const domain of tempAllowed) {
    if (domainMatches(hostname, domain)) return null;
  }

  const blocked = normalizeDomainSet(rules.blocked);
  const categoryReasons = buildCategoryReasonMap(rules);
  for (const domain of blocked) {
    if (domainMatches(hostname, domain)) {
      return { reason: categoryReasons.get(domain) || "blocked", ruleDomain: domain };
    }
  }

  const rawPatterns = Array.isArray(rules.urlPatterns) ? rules.urlPatterns : [];
  for (const pattern of rawPatterns) {
    const filter = buildUrlPatternRegex(pattern);
    if (!filter) continue;
    try {
      if (new RegExp(filter).test(url)) return { reason: "blocked", ruleDomain: urlPatternHost(pattern) };
    } catch {
      // Regex do builder sinh ra không thể hỏng; phòng thủ, bỏ qua mẫu này.
      continue;
    }
  }
  return null;
}

// Chỉ lý do chặn (hợp đồng cũ của isTabUrlBlocked), dùng cho quyết định
// chuyển tab của watcher.
function isTabUrlBlocked(url, rules, now) {
  const result = evaluateTabUrl(url, rules, now);
  return result ? result.reason : null;
}

// Domain của rule đã khớp URL này (đơn vị ghi lượt chặn — xem
// evaluateTabUrl), null khi URL không thuộc diện chặn hoặc không xác
// định được rule. Hàm thuần, không bao giờ throw (fail-open: null).
function matchedBlockRuleDomain(url, rules, now) {
  const result = evaluateTabUrl(url, rules, now);
  return result ? result.ruleDomain : null;
}

// Chống lặp chuyển hướng: không chuyển cùng một tab tới cùng một URL đích
// 2 lần trong 5 giây. Bình thường sau khi chuyển, URL tab thành
// chrome-extension://... nên không khớp nữa; throttle này phòng trường hợp
// tabs.update lỗi rồi watcher thử lại liên tục. Ghi dấu cả khi chuyển lỗi
// để lần thử lại cũng bị chặn trong cửa sổ throttle.
const WATCHER_REDIRECT_THROTTLE_MS = 5000;
const watcherRedirectThrottle = new Map();

function watcherRedirectAllowed(tabId, target) {
  const key = tabId + "\n" + target;
  const nowMs = Date.now();
  const last = watcherRedirectThrottle.get(key);
  if (last !== undefined && nowMs - last < WATCHER_REDIRECT_THROTTLE_MS) return false;
  watcherRedirectThrottle.set(key, nowMs);
  if (watcherRedirectThrottle.size > 200) {
    for (const [oldKey, oldMs] of watcherRedirectThrottle) {
      if (nowMs - oldMs >= WATCHER_REDIRECT_THROTTLE_MS) watcherRedirectThrottle.delete(oldKey);
    }
  }
  return true;
}

// Đánh giá tab và chuyển sang trang chặn nếu thuộc diện chặn. candidateUrl
// là URL quan sát được (từ sự kiện hoặc từ tabs.query); trước khi chuyển,
// đọc lại URL hiện tại của tab để không hành động trên URL đã cũ (tab có
// thể đã điều hướng đi nơi khác trong lúc chờ làm tươi rule). Mọi lỗi tabs
// API bắt tại chỗ, không throw. Log chỉ ghi tab id + hostname + lý do,
// không bao giờ ghi full URL.
async function redirectTabIfBlocked(tabId, candidateUrl) {
  let liveUrl = candidateUrl;
  try {
    const tab = await chrome.tabs.get(tabId);
    // Không xác minh được URL hiện tại thì fail-open: lần sweep/sự kiện
    // sau sẽ đánh giá lại, thay vì hành động trên URL có thể đã cũ.
    if (!tab || typeof tab.url !== "string") return;
    liveUrl = tab.url;
  } catch {
    return; // Tab đã đóng trước khi đọc được.
  }
  const reason = isTabUrlBlocked(liveUrl, currentRules, new Date());
  if (!reason) return;
  // Domain bị chặn của URL này (đánh giá một lần, dùng cho cả tham số URL
  // trang chặn lẫn lượt chặn): rule khớp thì lấy domain của rule, không thì
  // lấy hostname của URL vừa chuyển làm dự phòng.
  const hostname = hostnameFromUrl(liveUrl);
  const blockedDomain = matchedBlockRuleDomain(liveUrl, currentRules, new Date()) || hostname;
  let target = chrome.runtime.getURL("blocked.html?reason=" + reason);
  if (blockedDomain) target += "&domain=" + encodeURIComponent(blockedDomain);
  if (liveUrl === target) return;
  if (!watcherRedirectAllowed(tabId, target)) return;
  try {
    await chrome.tabs.update(tabId, { url: target });
    console.warn(
      "[SafePC] Tab watcher: đã chuyển tab #" +
        tabId +
        " (" +
        (hostname || "?") +
        ") sang trang chặn (lý do: " +
        reason +
        ").",
    );
    // Lượt web bị chặn (0.1.7) ghi theo DOMAIN CỦA RULE đã khớp, cùng đơn
    // vị với đường quy chiếu DNR, để dedupe 60s chung gộp được một lần
    // chặn dù cả hai đường cùng ghi. Chỉ ghi khi chuyển thành công (tab
    // đã tới trang chặn). Đồng thời ghi domain vào map theo tab để nút
    // xin mở trên trang chặn (0.1.9) hỏi lại được.
    if (blockedDomain) {
      recordBlockedDomainForTab(tabId, blockedDomain);
      recordBlockedVisit(blockedDomain, Date.now());
    }
  } catch (error) {
    console.warn("[SafePC] Tab watcher: không chuyển được tab #" + tabId + ":", error);
  }
}

async function handleTabUrlChange(tabId, eventUrl) {
  try {
    await maybeRefreshRulesForNavigation();
    await redirectTabIfBlocked(tabId, eventUrl);
  } catch (error) {
    console.warn("[SafePC] Tab watcher lỗi:", error);
  }
}

// Đánh giá lại mọi tab đang mở sau mỗi lần rebuild rule thành công: tab
// nào đang hiển thị trang từ bộ nhớ đệm mà nay thuộc diện chặn sẽ bị lật
// sang trang chặn. Không throw.
async function sweepOpenTabs() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch (error) {
    console.warn("[SafePC] Tab watcher: không đọc được danh sách tab:", error);
    return;
  }
  if (!Array.isArray(tabs)) return;
  for (const tab of tabs) {
    if (!tab || !Number.isInteger(tab.id) || typeof tab.url !== "string") continue;
    await redirectTabIfBlocked(tab.id, tab.url);
  }
}

// ---------------------------------------------------------------------------
// Báo cáo lượt web bị chặn (0.1.7): ghi nhận mỗi lần tab tới trang chặn.
//
// Hai đường tới trang chặn, CÙNG đơn vị domain: domain của rule đã khớp
// (đơn vị phụ huynh đã đặt — vd rule "youtube.com" thì ghi "youtube.com"
// kể cả khi tab đang ở "www.youtube.com"):
//   (1) Watcher chuyển tab: redirectTabIfBlocked đánh giá lại URL vừa
//       chuyển bằng matchedBlockRuleDomain để lấy domain của rule đã
//       khớp; không xác định được rule (rule đổi trong lúc chuyển) thì
//       dùng hostname của URL làm dự phòng.
//   (2) Redirect DNR: đích redirect chỉ mang tham số reason, KHÔNG mang
//       domain, và blocked.js cũng không biết gì thêm. Khi tab tới trang
//       chặn, handleBlockedPageShown tra rule vừa khớp bằng
//       declarativeNetRequest.getMatchedRules và lấy domain của rule đó
//       từ blockingRuleDomains (dựng từ read-back getDynamicRules sau mỗi
//       lần rebuild). Chỉ xét rule REDIRECT: rule block (tài nguyên phụ)
//       không bao giờ đưa tab tới trang chặn, xét cả nó sẽ quy chiếu nhầm
//       từ lượt khớp cũ của trang trước trong cùng tab.
// Đơn vị này KHÁC với lượt xem thường (ghi hostname đầy đủ, vd
// "www.youtube.com" — xem addUsage): lượt chặn ghi theo rule vì DNR chỉ
// biết rule đã khớp, và hai đường chặn phải cùng đơn vị thì dedupe mới
// gộp được. Khác đơn vị không ảnh hưởng báo cáo: lượt chặn mang
// durationSec = 0 nên không vào tổng giờ theo domain, và số lượt chặn
// chỉ đếm tổng chứ không tách theo domain.
// Không quy chiếu được thì BỎ QUA, không đoán: URL cũ của tab là trang
// trước (trang giới thiệu), không phải domain bị chặn — ghi nó sẽ ghi
// nhầm. Trường hợp bỏ qua: rule chặn-tất-cả của focus/allowlist (không
// có domain cụ thể), getMatchedRules trống/lỗi, service worker vừa khởi
// động lại chưa rebuild xong. Số đếm vì vậy là cận dưới, trang Báo cáo
// tuần ghi rõ điều này.
// Dedupe: cùng domain trong 60 giây chỉ ghi 1 lượt (cả hai đường dùng
// chung map) — tải lại trang chặn liên tục không thổi phồng số đếm.
// ---------------------------------------------------------------------------

// Cửa sổ dedupe lượt chặn theo domain (60 giây — cùng cửa sổ với dedupe
// sự kiện chặn app phía Agent, để số liệu hai phía có cùng ngữ nghĩa).
const BLOCKED_VISIT_DEDUPE_MS = 60 * 1000;
// Chỉ xét lượt khớp rule trong 10 giây gần nhất: lượt redirect vừa xảy ra
// mới là nguyên nhân tab đang ở trang chặn; lượt cũ hơn là của trang trước.
const BLOCKED_MATCH_WINDOW_MS = 10 * 1000;
const BLOCKED_VISIT_DEDUPE_CAP = 200;
const blockedVisitDedupe = new Map();

// Dựng map ruleId -> {domain, isRedirect} từ các rule DNR đang áp dụng
// (read-back, dữ liệu thật của trình duyệt). Hàm thuần, không throw.
//   - Rule requestDomains (chặn domain/chặn theo giờ/hết ngân sách/chặn
//     tạm thời): domain là phần tử đầu của requestDomains — rule khớp
//     domain + tên miền con, nên lượt chặn ghi theo domain của rule (đơn
//     vị phụ huynh đã đặt), không phải hostname con cụ thể.
//   - Rule regexFilter của mẫu URL: tra host bằng cách dựng lại filter của
//     từng mẫu trong rules.urlPatterns và so chuỗi — không parse ngược
//     chuỗi regex (dễ sai). Rule chặn-tất-cả ("^https?://") không khớp
//     mẫu nào nên không vào map (không quy chiếu được).
//   - Rule redirect SafeSearch/YouTube (regexSubstitution) và rule allow
//     không vào map: chúng không đưa tab tới trang chặn.
function buildBlockingRuleMap(appliedRules, rules) {
  const map = new Map();
  try {
    const patternHostByFilter = new Map();
    const rawPatterns = rules && Array.isArray(rules.urlPatterns) ? rules.urlPatterns : [];
    for (const pattern of rawPatterns) {
      if (typeof pattern !== "string") continue;
      const filter = buildUrlPatternRegex(pattern);
      if (!filter || patternHostByFilter.has(filter)) continue;
      const host = urlPatternHost(pattern);
      if (host) patternHostByFilter.set(filter, host);
    }
    const list = Array.isArray(appliedRules) ? appliedRules : [];
    for (const rule of list) {
      if (!rule || typeof rule !== "object" || !Number.isInteger(rule.id)) continue;
      const action = rule.action;
      const condition = rule.condition;
      if (!action || typeof action !== "object" || !condition || typeof condition !== "object") continue;
      if (isSafeSearchRedirectRule(rule)) continue;
      const isRedirect = action.type === "redirect";
      if (!isRedirect && action.type !== "block") continue;
      let domain = null;
      if (
        Array.isArray(condition.requestDomains) &&
        condition.requestDomains.length > 0 &&
        typeof condition.requestDomains[0] === "string"
      ) {
        domain = normalizeDomain(condition.requestDomains[0]);
      } else if (typeof condition.regexFilter === "string") {
        domain = patternHostByFilter.get(condition.regexFilter) || null;
      }
      if (domain) map.set(rule.id, { domain, isRedirect });
    }
  } catch (error) {
    // Map lỗi thì trả map rỗng (bỏ qua quy chiếu) thay vì ném.
    console.warn("[SafePC] Không dựng được map rule chặn:", error);
    return new Map();
  }
  return map;
}

// Ghi nhận một lượt chặn cho domain. Trả về true khi lượt được ghi vào
// hàng đợi (sẽ gửi kèm lượt xem thường ở lần flush sau, với blocked = true
// và durationSec = 0). Domain lạ, rỗng, hoặc vừa ghi trong 60 giây thì trả
// về false và không ghi. Không bao giờ throw. Chỉ domain được lưu —
// không URL, path, query.
function recordBlockedVisit(domain, nowMs) {
  try {
    const normalized = normalizeDomain(domain);
    if (!normalized) return false;
    const last = blockedVisitDedupe.get(normalized);
    if (last !== undefined && nowMs - last < BLOCKED_VISIT_DEDUPE_MS) return false;
    blockedVisitDedupe.set(normalized, nowMs);
    if (blockedVisitDedupe.size > BLOCKED_VISIT_DEDUPE_CAP) {
      for (const [oldDomain, oldMs] of blockedVisitDedupe) {
        if (nowMs - oldMs >= BLOCKED_VISIT_DEDUPE_MS) blockedVisitDedupe.delete(oldDomain);
      }
    }
    pendingBlocked.push({ domain: normalized, startedAt: new Date(nowMs).toISOString() });
    if (pendingBlocked.length > MAX_PENDING_BLOCKED) {
      pendingBlocked.splice(0, pendingBlocked.length - MAX_PENDING_BLOCKED);
    }
    void saveState();
    return true;
  } catch (error) {
    console.warn("[SafePC] Không ghi được lượt chặn:", error);
    return false;
  }
}

function isBlockedPageUrl(url) {
  if (typeof url !== "string" || url.length === 0) return false;
  try {
    if (blockedPagePrefix === null) blockedPagePrefix = chrome.runtime.getURL("blocked.html");
  } catch {
    return false;
  }
  return url.startsWith(blockedPagePrefix);
}

// Ghi domain bị chặn của một tab đang ở trang chặn, để nút xin mở hỏi lại
// được (0.1.9). Map có trần: quá trần thì xóa mục cũ nhất (Map giữ thứ tự
// chèn). Không bao giờ throw.
function recordBlockedDomainForTab(tabId, domain) {
  try {
    if (!Number.isInteger(tabId) || typeof domain !== "string" || domain.length === 0) return;
    blockedDomainByTab.set(tabId, domain);
    if (blockedDomainByTab.size > BLOCKED_DOMAIN_BY_TAB_CAP) {
      const oldest = blockedDomainByTab.keys().next().value;
      if (oldest !== undefined) blockedDomainByTab.delete(oldest);
    }
  } catch (error) {
    console.warn("[SafePC] Không ghi được domain theo tab:", error);
  }
}

// Chọn domain của rule redirect vừa khớp gần nhất trong các mục
// getMatchedRules: chỉ xét mục trong cửa sổ thời gian, có ruleId trong map
// rule chặn và là rule redirect. Hàm thuần, không throw — trả về null khi
// không quy chiếu được.
function pickMatchedBlockedDomain(matched, ruleMap, minTimeStamp) {
  try {
    if (!Array.isArray(matched) || !ruleMap || typeof ruleMap.get !== "function") return null;
    let best = null;
    for (const entry of matched) {
      if (!entry || typeof entry !== "object") continue;
      if (!Number.isInteger(entry.ruleId) || typeof entry.timeStamp !== "number") continue;
      if (entry.timeStamp < minTimeStamp) continue;
      const info = ruleMap.get(entry.ruleId);
      if (!info || !info.isRedirect) continue;
      if (!best || entry.timeStamp > best.timeStamp) best = { timeStamp: entry.timeStamp, domain: info.domain };
    }
    return best ? best.domain : null;
  } catch (error) {
    console.warn("[SafePC] Không chọn được rule chặn vừa khớp:", error);
    return null;
  }
}

// Tab vừa tới trang chặn qua redirect DNR: tra rule redirect vừa khớp
// trong 10 giây gần nhất và ghi lượt chặn theo domain của rule đó, đồng
// thời ghi domain vào map theo tab để nút xin mở hỏi lại được. Không có
// rule nào khớp (watcher chuyển tab, rule chặn-tất-cả, API trống/lỗi)
// thì bỏ qua lặng lẽ — không đoán domain. Không bao giờ throw.
async function handleBlockedPageShown(tabId) {
  try {
    if (blockingRuleDomains.size === 0) return;
    if (
      !chrome.declarativeNetRequest ||
      typeof chrome.declarativeNetRequest.getMatchedRules !== "function"
    ) {
      return;
    }
    const minTimeStamp = Date.now() - BLOCKED_MATCH_WINDOW_MS;
    const matched = await chrome.declarativeNetRequest.getMatchedRules({ tabId, minTimeStamp });
    const domain = pickMatchedBlockedDomain(matched, blockingRuleDomains, minTimeStamp);
    if (domain) {
      recordBlockedDomainForTab(tabId, domain);
      recordBlockedVisit(domain, Date.now());
    }
  } catch (error) {
    console.warn("[SafePC] Không quy chiếu được domain cho trang chặn:", error);
  }
}

// ---------------------------------------------------------------------------
// Kiểm duyệt từ khóa tìm kiếm (0.1.11): ghi nhận lượt tìm + lưới dự phòng
// cho DNR.
//
// ĐIỂM GHI CHÍNH là chrome.webNavigation.onBeforeNavigate (sửa theo
// review 27/11/2026): sự kiện chạy khi điều hướng BẮT ĐẦU, TRƯỚC khi
// rule DNR kịp chuyển hướng — nên URL tìm kiếm gốc luôn đến được đây,
// kể cả lượt bị DNR chặn (nếu chỉ nghe tabs.onUpdated như bản đầu, tab
// commit thẳng tới trang chặn và URL gốc không bao giờ xuất hiện, lượt
// bị chặn quan trọng nhất lại không được ghi). Listener
// tabs.onUpdated giữ vai trò lưới phụ: bắt điều hướng trong trang
// (pushState, không sinh onBeforeNavigate mới) và thực hiện chuyển
// hướng dự phòng bên dưới; chống trùng 30 giây gộp hai lưới thành một
// lượt ghi duy nhất.
//
// Mỗi điều hướng tới trang kết quả của một trong 5 công cụ (Google,
// Bing, DuckDuckGo, Yahoo, Cốc Cốc) đều được trích cụm từ (đã giải mã)
// và ghi vào hàng đợi pendingSearch để gửi qua reportSearch — kể cả
// lượt KHÔNG bị chặn (phụ huynh cần thống kê mọi cụm từ đã tìm trong
// Báo cáo tuần, như lịch sử web). Cờ blocked tính bằng đối chiếu đã bỏ
// dấu (searchKeywordHit) trên cụm từ đã giải mã, nên biến thể gõ không
// dấu/khác hoa thường vẫn bị đánh dấu đúng dù rule DNR (khớp trên URL
// thô còn mã hóa) có thể trượt.
//
// Khi blocked mà DNR đã trượt (tab vẫn đang ở URL tìm kiếm sau khi sự
// kiện điều hướng tới), watcher tự chuyển tab sang trang chặn — cùng
// mẫu với redirectTabIfBlocked: đọc lại URL hiện tại của tab trước khi
// hành động, throttle chống lặp, đích chỉ mang reason (KHÔNG mang cụm
// từ). Nếu DNR đã chặn trước, URL hiện tại của tab là trang chặn nên
// nhánh này tự bỏ qua. (Ở sự kiện onBeforeNavigate, URL hiện tại của
// tab còn là trang TRƯỚC nên nhánh chuyển hướng tự bỏ qua — việc ghi
// nhận đã xong ở đó, còn chặn thì DNR lo; biến thể DNR trượt được lưới
// tabs.onUpdated chuyển hướng khi URL commit.)
//
// Chống trùng: cùng (tab, cụm từ đã chuẩn hóa) chỉ ghi 1 lần trong 30
// giây — một lượt tìm sinh nhiều sự kiện onUpdated (đổi trạng thái, tải
// thêm tham số...) và trang kết quả tự làm mới cũng không được nhân
// đôi số liệu. Hàng đợi lưu bền vững trong chrome.storage.local (trần
// 200, bỏ cũ nhất) và flush theo cùng chu kỳ với reportUsage; Native
// Host chưa trả lời thì giữ lại gửi sau.
// ---------------------------------------------------------------------------

const SEARCH_TERM_DEDUPE_MS = 30 * 1000;
const SEARCH_TERM_DEDUPE_CAP = 200;
// NativeHost chỉ nhận tối đa 50 mẫu mỗi message reportSearch: flush
// theo từng đoạn 50, đoạn nào lỗi thì dừng và giữ phần còn lại.
const SEARCH_FLUSH_BATCH = 50;
const searchTermDedupe = new Map();

// Danh sách từ khóa cấm hiện hành (đã chuẩn hóa phía Agent). Rules
// thiếu/sai hình dạng thì coi như không có từ khóa nào (fail-open cho
// việc ĐÁNH DẤU blocked; việc ghi nhận lượt tìm không phụ thuộc danh
// sách này). Không bao giờ throw.
function currentSearchKeywords() {
  try {
    const guard = currentRules && currentRules.searchGuard;
    if (!guard || typeof guard !== "object" || Array.isArray(guard)) return [];
    return Array.isArray(guard.blockedKeywords) ? guard.blockedKeywords : [];
  } catch {
    return [];
  }
}

// Ghi nhận một lượt tìm vào hàng đợi. Trả về true khi đã ghi (false khi
// bị chống trùng hoặc dữ liệu lạ). Chỉ engine + cụm từ + cờ blocked
// được lưu — không URL. Không bao giờ throw.
function recordSearchTerm(tabId, engine, term, blocked) {
  try {
    if (!Number.isInteger(tabId)) return false;
    if (typeof engine !== "string" || engine.length === 0) return false;
    if (typeof term !== "string" || term.trim().length === 0) return false;
    const nowMs = Date.now();
    const key = tabId + "\n" + normalizeSearchText(term);
    const last = searchTermDedupe.get(key);
    if (last !== undefined && nowMs - last < SEARCH_TERM_DEDUPE_MS) return false;
    searchTermDedupe.set(key, nowMs);
    if (searchTermDedupe.size > SEARCH_TERM_DEDUPE_CAP) {
      for (const [oldKey, oldMs] of searchTermDedupe) {
        if (nowMs - oldMs >= SEARCH_TERM_DEDUPE_MS) searchTermDedupe.delete(oldKey);
      }
    }
    pendingSearch.push({ engine, term: term.slice(0, 200), blocked: blocked === true });
    if (pendingSearch.length > MAX_PENDING_SEARCH) {
      pendingSearch.splice(0, pendingSearch.length - MAX_PENDING_SEARCH);
    }
    void saveState();
    return true;
  } catch (error) {
    console.warn("[SafePC] Không ghi được lượt tìm kiếm:", error);
    return false;
  }
}

// Xử lý một điều hướng tới URL tìm kiếm: ghi nhận lượt tìm, và khi cụm
// từ chứa từ khóa cấm mà DNR chưa chuyển hướng (tab vẫn ở URL tìm
// kiếm) thì tự chuyển sang trang chặn. Không bao giờ throw; log chỉ
// ghi tab id + lý do, KHÔNG ghi cụm từ.
async function handleSearchNavigation(tabId, url) {
  try {
    const found = extractSearchTerm(url);
    if (!found) return;
    const blocked = searchKeywordHit(found.term, currentSearchKeywords());
    recordSearchTerm(tabId, found.engine, found.term, blocked);
    if (!blocked) return;

    let liveUrl = null;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && typeof tab.url === "string") liveUrl = tab.url;
    } catch {
      return; // Tab đã đóng trước khi đọc được.
    }
    if (liveUrl === null || isBlockedPageUrl(liveUrl)) return;
    const still = extractSearchTerm(liveUrl);
    if (!still || still.engine !== found.engine) return;
    if (normalizeSearchText(still.term) !== normalizeSearchText(found.term)) return;
    if (!searchKeywordHit(still.term, currentSearchKeywords())) return;
    const target = chrome.runtime.getURL("blocked.html?reason=search-keyword");
    if (!watcherRedirectAllowed(tabId, target)) return;
    try {
      await chrome.tabs.update(tabId, { url: target });
      console.warn(
        "[SafePC] Tab watcher: đã chuyển tab #" + tabId + " sang trang chặn (lý do: search-keyword).",
      );
    } catch (error) {
      console.warn("[SafePC] Tab watcher: không chuyển được tab #" + tabId + " (search-keyword):", error);
    }
  } catch (error) {
    console.warn("[SafePC] Kiểm duyệt từ khóa tìm kiếm lỗi:", error);
  }
}

// Gửi hàng đợi cụm từ tìm kiếm về NativeHost (message reportSearch),
// theo từng đoạn 50 mẫu (trần mỗi message của host). Đoạn nào gửi lỗi
// thì dừng, giữ phần chưa gửi để chu kỳ sau gửi lại — cùng ngữ nghĩa
// với flushUsage. Không hiện lỗi cho user.
async function flushSearchTerms() {
  const entries = pendingSearch.slice();
  if (entries.length === 0) return;
  let sentCount = 0;
  for (let i = 0; i < entries.length; i += SEARCH_FLUSH_BATCH) {
    const chunk = entries.slice(i, i + SEARCH_FLUSH_BATCH);
    const response = await sendNativeMessage({ type: "reportSearch", terms: chunk });
    if (!response || response.ok !== true) break;
    sentCount += chunk.length;
  }
  if (sentCount > 0) {
    // Xóa đúng số mẫu đã gửi: mẫu ghi thêm trong lúc gửi còn lại.
    pendingSearch.splice(0, sentCount);
    await saveState();
  }
}

// ---------------------------------------------------------------------------
// Nút xin mở trang trên trang chặn (0.1.9)
// ---------------------------------------------------------------------------

// Domain bị chặn của tab gửi message: ưu tiên map theo tab (ghi lúc
// watcher chuyển tab hoặc lúc quy chiếu DNR), rồi tra trực tiếp rule vừa
// khớp (trường hợp map rỗng vì service worker vừa tỉnh lại). Trả về null
// khi không xác định được — không đoán. Không bao giờ throw.
async function resolveBlockedDomainForTab(sender) {
  try {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!Number.isInteger(tabId)) return null;
    const mapped = blockedDomainByTab.get(tabId);
    if (typeof mapped === "string" && mapped.length > 0) return mapped;
    if (blockingRuleDomains.size === 0) return null;
    if (
      !chrome.declarativeNetRequest ||
      typeof chrome.declarativeNetRequest.getMatchedRules !== "function"
    ) {
      return null;
    }
    const minTimeStamp = Date.now() - BLOCKED_MATCH_WINDOW_MS;
    const matched = await chrome.declarativeNetRequest.getMatchedRules({ tabId, minTimeStamp });
    const domain = pickMatchedBlockedDomain(matched, blockingRuleDomains, minTimeStamp);
    if (domain) recordBlockedDomainForTab(tabId, domain);
    return domain;
  } catch (error) {
    console.warn("[SafePC] Không xác định được domain bị chặn của tab:", error);
    return null;
  }
}

// Cùng một domain có được gửi yêu cầu mở không: chưa gửi, hoặc lần gửi
// trước đã quá 5 phút. Chỉ kiểm tra, không ghi dấu — ghi dấu do
// recordUnblockRequestSent, chỉ sau khi gửi thành công, để gửi lỗi thì
// con bấm lại được ngay thay vì bị báo "đã gửi" oan.
function unblockRequestAllowed(domain, nowMs) {
  const last = unblockRequestDedupe.get(domain);
  return last === undefined || nowMs - last >= UNBLOCK_REQUEST_DEDUPE_MS;
}

// Ghi dấu một lần gửi yêu cầu mở thành công. Chỉ gọi khi NativeHost đã
// ack ok.
function recordUnblockRequestSent(domain, nowMs) {
  unblockRequestDedupe.set(domain, nowMs);
  if (unblockRequestDedupe.size > UNBLOCK_REQUEST_DEDUPE_CAP) {
    for (const [oldDomain, oldMs] of unblockRequestDedupe) {
      if (nowMs - oldMs >= UNBLOCK_REQUEST_DEDUPE_MS) unblockRequestDedupe.delete(oldDomain);
    }
  }
}

// Xử lý yêu cầu xin mở từ trang chặn. Domain dùng để gửi là domain
// background tự quy chiếu cho tab (đáng tin nhất); khi không quy chiếu
// được thì dùng domain trang chặn gửi kèm (đến từ tham số URL do chính
// background đặt lúc chuyển hướng, hoặc từ lần hỏi getBlockedDomain
// trước) sau khi chuẩn hóa. Chỉ tên miền được gửi đi — không URL. Trả về
// {ok} và cờ alreadySent khi yêu cầu đã gửi trong cửa sổ dedupe.
async function handleUnblockRequest(message, sender) {
  try {
    const resolved = await resolveBlockedDomainForTab(sender);
    const domain = resolved || normalizeDomain(message && message.domain);
    if (!domain) return { ok: false, reason: "no-domain" };
    if (!unblockRequestAllowed(domain, Date.now())) return { ok: true, alreadySent: true };
    const response = await sendNativeMessage({ type: "requestUnblock", domain });
    if (response && response.ok === true) {
      recordUnblockRequestSent(domain, Date.now());
      return { ok: true };
    }
    return { ok: false, reason: "native" };
  } catch (error) {
    console.warn("[SafePC] Không gửi được yêu cầu xin mở:", error);
    return { ok: false, reason: "error" };
  }
}

// ---------------------------------------------------------------------------
// Đếm thời gian xem theo domain (tab đang hiển thị + cửa sổ đang focus)
// ---------------------------------------------------------------------------

function rolloverIfNeeded(now) {
  const key = localDateKey(now);
  if (usage.date !== key) {
    usage = { date: key, seconds: {} };
  }
}

function enforcePendingCap() {
  const keys = Object.keys(pending);
  if (keys.length <= MAX_PENDING) return;
  keys.sort((a, b) => (pending[a].startedAt < pending[b].startedAt ? -1 : 1));
  for (let i = 0; i < keys.length - MAX_PENDING; i++) delete pending[keys[i]];
}

// Tách khóa hàng đợi pending thành {domain, path}. Khóa mới (0.1.10) có
// dạng "domain\nđường dẫn"; đường dẫn không bao giờ chứa ký tự xuống
// dòng (pathname của URL API — ký tự điều khiển được percent-encode
// thành ASCII, không còn ký tự xuống dòng literal) nên "\n" là ranh
// giới an toàn. Khóa cũ (chỉ domain, lưu từ bản trước 0.1.10) không có
// "\n" → đường dẫn null, lượt đó gửi đi không có path như trước.
function pendingKeyParts(key) {
  const sep = key.indexOf("\n");
  if (sep < 0) return { domain: key, path: null };
  const path = key.slice(sep + 1);
  return { domain: key.slice(0, sep), path: path.length > 0 ? path : null };
}

function addUsage(hostname, path, seconds, nowMs) {
  rolloverIfNeeded(new Date(nowMs));
  // Ngân sách theo domain vẫn gộp theo hostname (giới hạn theo domain
  // tính trên mọi đường dẫn của domain đó, không đổi).
  usage.seconds[hostname] = (usage.seconds[hostname] || 0) + seconds;
  // Hàng đợi gửi lên tách theo cặp (domain, đường dẫn) để thời lượng
  // không gộp nhầm giữa các trang cùng domain.
  const key = typeof path === "string" && path.length > 0 ? hostname + "\n" + path : hostname;
  let entry = pending[key];
  if (!entry) {
    entry = { startedAt: new Date(nowMs - seconds * 1000).toISOString(), seconds: 0 };
    pending[key] = entry;
  }
  entry.seconds += seconds;
  enforcePendingCap();
}

// Đóng đoạn xem hiện tại: cộng thời gian từ activeSince tới nowMs vào domain
// đang hiển thị, rồi bắt đầu đoạn mới tại nowMs.
function closeSegment(nowMs) {
  if (activeHostname !== null && windowFocused && activeSince > 0 && nowMs > activeSince) {
    const elapsed = Math.min(MAX_SEGMENT_SECONDS, Math.floor((nowMs - activeSince) / 1000));
    if (elapsed > 0) addUsage(activeHostname, activePath, elapsed, nowMs);
  }
  activeSince = nowMs;
}

async function syncActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    const nowMs = Date.now();
    closeSegment(nowMs);
    if (tab) {
      activeTabId = tab.id === undefined ? null : tab.id;
      activeHostname = hostnameFromUrl(tab.url);
      activePath = pathFromUrl(tab.url);
    } else {
      activeTabId = null;
      activeHostname = null;
      activePath = null;
    }
    activeSince = nowMs;
  } catch {
    // tabs API lỗi: giữ trạng thái cũ, lần tick sau thử lại.
  }
}

async function saveState() {
  try {
    await chrome.storage.local.set({
      [STORE_KEYS.usage]: usage,
      [STORE_KEYS.pending]: pending,
      [STORE_KEYS.pendingBlocked]: pendingBlocked,
      [STORE_KEYS.pendingSearch]: pendingSearch,
    });
  } catch (error) {
    console.warn("[SafePC] Không lưu được trạng thái usage:", error);
  }
}

function isValidUsage(value) {
  if (!value || typeof value !== "object" || typeof value.date !== "string") return false;
  if (!value.seconds || typeof value.seconds !== "object") return false;
  return Object.values(value.seconds).every(
    (sec) => typeof sec === "number" && Number.isFinite(sec) && sec >= 0,
  );
}

function isValidPending(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      typeof entry.startedAt === "string" &&
      !Number.isNaN(Date.parse(entry.startedAt)) &&
      typeof entry.seconds === "number" &&
      Number.isFinite(entry.seconds) &&
      entry.seconds >= 0,
  );
}

// Hàng đợi lượt chặn đã lưu phải là mảng các {domain, startedAt} hợp lệ;
// domain phải chuẩn hóa được (chỉ domain, không URL). Dữ liệu lạ thì bỏ
// toàn bộ hàng đợi (fail-open, không chặn lần ghi sau).
function isValidPendingBlocked(value) {
  if (!Array.isArray(value)) return false;
  return value.every(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      typeof entry.domain === "string" &&
      normalizeDomain(entry.domain) !== null &&
      typeof entry.startedAt === "string" &&
      !Number.isNaN(Date.parse(entry.startedAt)),
  );
}

// Hàng đợi cụm từ tìm kiếm đã lưu (0.1.11) phải là mảng các
// {engine, term, blocked} hợp lệ. Dữ liệu lạ thì bỏ toàn bộ hàng đợi
// (fail-open, không chặn lần ghi sau) — cùng mẫu isValidPendingBlocked.
function isValidPendingSearch(value) {
  if (!Array.isArray(value)) return false;
  return value.every(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      typeof entry.engine === "string" &&
      entry.engine.length > 0 &&
      typeof entry.term === "string" &&
      entry.term.length > 0 &&
      typeof entry.blocked === "boolean",
  );
}

async function loadState() {
  try {
    const stored = await chrome.storage.local.get([
      STORE_KEYS.usage,
      STORE_KEYS.pending,
      STORE_KEYS.pendingBlocked,
      STORE_KEYS.pendingSearch,
    ]);
    if (isValidUsage(stored[STORE_KEYS.usage])) usage = stored[STORE_KEYS.usage];
    if (isValidPending(stored[STORE_KEYS.pending])) pending = stored[STORE_KEYS.pending];
    if (isValidPendingBlocked(stored[STORE_KEYS.pendingBlocked])) {
      pendingBlocked = stored[STORE_KEYS.pendingBlocked];
    }
    if (isValidPendingSearch(stored[STORE_KEYS.pendingSearch])) {
      pendingSearch = stored[STORE_KEYS.pendingSearch];
    }
    rolloverIfNeeded(new Date());
  } catch (error) {
    console.warn("[SafePC] Không đọc được trạng thái đã lưu:", error);
  }
}

// ---------------------------------------------------------------------------
// Báo cáo usage về NativeHost (giữ lại khi lỗi, không báo lỗi cho user)
// ---------------------------------------------------------------------------

async function flushUsage() {
  const entries = Object.entries(pending);
  // Chụp hàng đợi lượt chặn (0.1.7): lượt ghi thêm trong lúc đang gửi
  // nằm sau vị trí đã chụp và được giữ lại, cùng nguyên tắc với usage.
  const blockedEntries = pendingBlocked.slice();
  if (entries.length === 0 && blockedEntries.length === 0) return;
  const visits = entries.map(([key, entry]) => {
    const { domain, path } = pendingKeyParts(key);
    const visit = { domain, startedAt: entry.startedAt, durationSec: entry.seconds };
    // Đường dẫn chỉ có ở lượt xem thường ghi từ 0.1.10; lượt từ trạng
    // thái cũ (khóa chỉ domain) gửi đi không có path như trước.
    if (path !== null) visit.path = path;
    return visit;
  });
  // Lượt bị chặn đi cùng batch reportUsage, mang blocked = true và
  // durationSec = 0 (không xem được gì). Không cần message type mới:
  // NativeHost và Service đều đọc thêm trường blocked tùy chọn.
  for (const entry of blockedEntries) {
    visits.push({ domain: entry.domain, startedAt: entry.startedAt, durationSec: 0, blocked: true });
  }
  // Chụp số giây đã gửi thành số nguyên (không giữ tham chiếu tới entry):
  // entry trong pending có thể được cộng thêm trong lúc đang gửi, và phép
  // trừ sau đó phải trừ đúng số đã gửi, không phải số đã bị cộng thêm.
  const sentSeconds = entries.map(([key, entry]) => ({ key, seconds: entry.seconds }));
  const response = await sendNativeMessage({ type: "reportUsage", visits });
  if (response && response.ok === true) {
    // Trừ đúng số giây đã gửi: dữ liệu cộng thêm trong lúc gửi được giữ lại.
    for (const { key, seconds } of sentSeconds) {
      const current = pending[key];
      if (!current) continue;
      current.seconds -= seconds;
      if (current.seconds <= 0) delete pending[key];
    }
    // Xóa đúng số lượt chặn đã gửi: lượt ghi thêm trong lúc gửi còn lại.
    pendingBlocked.splice(0, blockedEntries.length);
    await saveState();
  }
  // Gửi lỗi: giữ nguyên hàng đợi để chu kỳ sau gửi lại, không hiện lỗi.
}

// ---------------------------------------------------------------------------
// Alarm + sự kiện tab/cửa sổ (đăng ký ở top-level để service worker tỉnh
// dậy đúng khi sự kiện tới)
// ---------------------------------------------------------------------------

async function handleTick() {
  try {
    const nowMs = Date.now();
    closeSegment(nowMs);
    rolloverIfNeeded(new Date(nowMs));
    await saveState();
    await rebuildDynamicRules();
  } catch (error) {
    console.warn("[SafePC] Tick lỗi:", error);
  }
}

async function handleRefresh() {
  try {
    await refreshRulesAndRebuild();
    await flushUsage();
    // Cụm từ tìm kiếm flush cùng chu kỳ với lượt xem (0.1.11): cùng
    // nhịp alarm làm tươi rule, cùng nguyên tắc giữ lại khi lỗi.
    await flushSearchTerms();
  } catch (error) {
    console.warn("[SafePC] Refresh lỗi:", error);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_TICK) void handleTick();
  else if (alarm.name === ALARM_REFRESH) void handleRefresh();
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void (async () => {
    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      const nowMs = Date.now();
      closeSegment(nowMs);
      activeTabId = tab.id === undefined ? null : tab.id;
      activeHostname = hostnameFromUrl(tab.url);
      activePath = pathFromUrl(tab.url);
      activeSince = nowMs;
    } catch {
      // Tab đã đóng trước khi đọc được: bỏ qua.
    }
  })();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.active || typeof changeInfo.url !== "string") return;
  const nowMs = Date.now();
  closeSegment(nowMs);
  activeTabId = tabId;
  activeHostname = hostnameFromUrl(changeInfo.url);
  activePath = pathFromUrl(changeInfo.url);
  activeSince = nowMs;
});

// Tab watcher (0.1.5) — listener RIÊNG với listener đếm usage ở trên: mọi
// tab (không chỉ tab đang hiển thị), chỉ khi changeInfo.url xuất hiện (bao
// gồm điều hướng pushState của SPA). Không chạy khi chỉ đổi trạng thái,
// title hay favicon. Tab vừa tới trang chặn (0.1.7) thì quy chiếu domain
// qua rule DNR vừa khớp thay vì đánh giá watcher (trang chặn không thuộc
// diện chặn, watcher sẽ bỏ qua).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (typeof changeInfo.url !== "string") return;
  if (isBlockedPageUrl(changeInfo.url)) {
    void handleBlockedPageShown(tabId);
    return;
  }
  // Kiểm duyệt từ khóa tìm kiếm (0.1.11): ở listener này vai trò là
  // LƯỚI PHỤ — ghi nhận lượt tìm + chuyển hướng dự phòng khi DNR trượt.
  // Điểm ghi chính là webNavigation.onBeforeNavigate ngay dưới (thấy
  // URL gốc trước khi DNR chuyển hướng); listener này bắt các điều
  // hướng không sinh onBeforeNavigate (pushState trong trang) và là
  // nơi nhánh chuyển hướng dự phòng chạy được (URL đã commit). Chống
  // trùng 30 giây gộp hai lưới thành một lượt ghi. Chạy độc lập với
  // watcher domain ở dưới; URL không phải trang kết quả tìm kiếm thì
  // tự bỏ qua ngay.
  void handleSearchNavigation(tabId, changeInfo.url);
  void handleTabUrlChange(tabId, changeInfo.url);
});

// Kiểm duyệt từ khóa tìm kiếm (0.1.11, sửa theo review 27/11/2026) —
// ĐIỂM GHI CHÍNH: chrome.webNavigation.onBeforeNavigate chạy khi điều
// hướng khung chính BẮT ĐẦU, trước khi rule DNR chuyển hướng tới trang
// chặn, nên handleSearchNavigation luôn thấy URL tìm kiếm gốc và ghi
// được cả lượt bị DNR chặn (blocked=true do chính hàm tính bằng đối
// chiếu đã bỏ dấu trên cụm từ đã giải mã — không phụ thuộc DNR có khớp
// hay không). Chỉ khung chính (frameId 0); điều hướng tới trang chặn
// tự nó cũng sinh sự kiện này nhưng URL trang chặn không trích được
// cụm từ nên là no-op. API vắng (bản trình duyệt lạ) thì lưới phụ
// tabs.onUpdated ở trên vẫn ghi như bản 0.1.11 đầu.
if (
  chrome.webNavigation &&
  chrome.webNavigation.onBeforeNavigate &&
  typeof chrome.webNavigation.onBeforeNavigate.addListener === "function"
) {
  chrome.webNavigation.onBeforeNavigate.addListener((details) => {
    if (!details || details.frameId !== 0 || typeof details.url !== "string") return;
    void handleSearchNavigation(details.tabId, details.url);
  });
}

// Trang chặn tải xong (0.1.7): bắt trường hợp tab điều hướng từ một trang
// chặn sang domain bị chặn khác với cùng lý do — URL không đổi nên
// listener trên không chạy, nhưng lần tải này vẫn là một lượt chặn mới
// (dedupe 60 giây/domain chặn trùng với lần ghi từ listener trên).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab || typeof tab.url !== "string" || !isBlockedPageUrl(tab.url)) return;
  void handleBlockedPageShown(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  blockedDomainByTab.delete(tabId);
  // Dọn dấu chống trùng lượt tìm của tab đã đóng (0.1.11): khóa dedupe
  // mang tiền tố "<tabId>\n"; tab id có thể được tái dùng nên để sót
  // sẽ chặn nhầm lượt tìm của tab mới trong 30 giây.
  for (const key of searchTermDedupe.keys()) {
    if (key.startsWith(tabId + "\n")) searchTermDedupe.delete(key);
  }
  if (tabId !== activeTabId) return;
  const nowMs = Date.now();
  closeSegment(nowMs);
  activeTabId = null;
  activeHostname = null;
  activePath = null;
  activeSince = nowMs;
});

// Trang chặn (0.1.9): hỏi domain bị chặn của tab mình (getBlockedDomain)
// và gửi yêu cầu xin mở (requestUnblock). Trả lời bất đồng bộ nên trả về
// true để giữ kênh message mở; message lạ thì bỏ qua.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object" || typeof message.type !== "string") return false;
  if (message.type === "getBlockedDomain") {
    void resolveBlockedDomainForTab(sender).then((domain) => sendResponse({ domain }));
    return true;
  }
  if (message.type === "requestUnblock") {
    void handleUnblockRequest(message, sender).then((result) => sendResponse(result));
    return true;
  }
  return false;
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  const nowMs = Date.now();
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    closeSegment(nowMs);
    windowFocused = false;
    activeSince = nowMs;
    return;
  }
  windowFocused = true;
  activeSince = nowMs;
  void syncActiveTab();
});

// ---------------------------------------------------------------------------
// Khởi tạo: nạp trạng thái, lập alarm, lấy rules lần đầu, đồng bộ tab đang mở
// ---------------------------------------------------------------------------

async function doInit() {
  await loadState();
  // Tick 30 giây: Chrome có thể kẹp period dưới 1 phút về 1 phút; thời lượng
  // tính bằng hiệu timestamp nên tổng vẫn đúng, chỉ độ trễ đánh giá khung
  // giờ/ngân sách thành ~1 phút (đúng như thiết kế).
  chrome.alarms.create(ALARM_REFRESH, { periodInMinutes: 1 });
  chrome.alarms.create(ALARM_TICK, { periodInMinutes: 0.5 });
  await refreshRulesAndRebuild();
  await syncActiveTab();
}

function init() {
  if (initStarted) return;
  initStarted = true;
  doInit().catch((error) => {
    console.warn("[SafePC] Khởi tạo lỗi:", error);
  });
}

chrome.runtime.onInstalled.addListener(() => init());
chrome.runtime.onStartup.addListener(() => init());
init();
