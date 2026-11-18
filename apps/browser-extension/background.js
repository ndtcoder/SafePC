// SafePC Browser Extension — Sprint 2 đợt 2 (chặn domain thật qua
// declarativeNetRequest + báo cáo thời gian xem theo domain).
//
// Luồng quy tắc: Dashboard -> Supabase -> PC Agent (đồng bộ rules, xuất bản
// domain_rules.json) -> NativeHost (stdio) -> extension (getRules mỗi phút)
// -> declarativeNetRequest dynamic rules. Extension KHÔNG gọi Supabase, không
// có secret/key, không đọc nội dung trang.
//
// Luồng báo cáo: extension đếm thời gian tab đang hiển thị theo domain, gửi
// về NativeHost (reportUsage mỗi phút) -> web_usage.jsonl -> Agent đẩy lên
// bảng web_visits. CHỈ DOMAIN + THỜI LƯỢNG: không bao giờ gửi/lưu/log full
// URL, path, query, tiêu đề trang hay nội dung. Hostname lấy từ tab.url rồi
// bỏ URL ngay (xem domainUtils.js).
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
// Mọi giờ giấc tính theo GIỜ ĐỊA PHƯƠNG của máy con. Khung giờ/ngân sách/
// ghi đè tạm thời được đánh giá lại mỗi phút (alarm), nên thay đổi có hiệu
// lực trong vòng ~1 phút. Khi chưa nối được NativeHost, extension mở (không
// chặn gì) và popup báo "chưa kết nối" — xem README.md về giới hạn này.

"use strict";

importScripts("domainUtils.js");

const { normalizeDomain, domainMatches, hostnameFromUrl, localDateKey, hhmmToMinutes } =
  globalThis.SafePCDomain;

const NATIVE_HOST = "com.safepc.agent";
const ALARM_REFRESH = "safepc-refresh";
const ALARM_TICK = "safepc-tick";
const STORE_KEYS = {
  usage: "safepc_usage",
  pending: "safepc_pending",
  pendingBlocked: "safepc_pending_blocked",
  limits: "safepc_limits",
  status: "safepc_status",
  dnr: "safepc_dnr",
};
const MAX_PENDING = 1000;
// Trần hàng đợi lượt chặn: mỗi lượt là một sự kiện rời rạc (không gộp theo
// domain như usage), dedupe 60 giây/domain đã chặn spam tải lại trang.
const MAX_PENDING_BLOCKED = 200;
const MAX_DNR_RULES = 4500;
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
let pending = {};
// Hàng đợi lượt web bị chặn chưa gửi: [{domain, startedAt}] — rời rạc từng
// lượt, không gộp theo domain như usage. Lưu bền vững cùng usage để
// service worker ngủ đông không làm mất lượt chặn chưa gửi.
let pendingBlocked = [];
// Map ruleId -> {domain, isRedirect} của các rule chặn đang áp dụng, dựng
// từ read-back getDynamicRules sau mỗi lần rebuild — dùng để quy chiếu
// domain khi tab tới trang chặn qua redirect DNR (xem handleBlockedPageShown).
// Chỉ rule có domain cụ thể mới vào map: rule chặn-tất-cả (focus/allowlist)
// không có domain nên lượt chặn đó không quy chiếu được và bị bỏ qua.
let blockingRuleDomains = new Map();
// Tiền tố URL trang chặn của chính extension, tính lười ở isBlockedPageUrl.
let blockedPagePrefix = null;
let activeTabId = null;
let activeHostname = null;
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
    addPair(blocked, PRIORITY.blocked, "blocked");
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
    summary.push({
      id: rule.id,
      priority: rule.priority,
      action: action.type,
      pattern: urlFilter || regexFilter || requestDomains,
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
    const mainRules = rules.filter((rule) => !isSafeSearchRedirectRule(rule));
    const redirectRules = rules.filter(isSafeSearchRedirectRule);
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing.map((r) => r.id);
    // Áp thành 2 lần gọi riêng (đợt sửa 17/11/2026): updateDynamicRules
    // là nguyên tử theo từng lần gọi, nên 1 rule hỏng trong nhóm redirect
    // không còn kéo sập cả nhóm chặn. Nhóm chặn/cho phép áp trước, kèm
    // xóa rule cũ; nhóm redirect chỉ áp khi nhóm chặn đã đứng.
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds,
        addRules: mainRules,
      });
    } catch (groupError) {
      error = errorMessage(groupError);
      console.warn("[SafePC] Không áp được nhóm rule chặn/cho phép:", groupError);
    }
    if (error === null && redirectRules.length > 0) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ addRules: redirectRules });
      } catch (groupError) {
        error = errorMessage(groupError);
        console.warn("[SafePC] Không áp được nhóm rule redirect SafeSearch/YouTube:", groupError);
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
//      tên miền con) -> lý do "blocked".
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
  for (const domain of blocked) {
    if (domainMatches(hostname, domain)) return { reason: "blocked", ruleDomain: domain };
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
  const target = chrome.runtime.getURL("blocked.html?reason=" + reason);
  if (liveUrl === target) return;
  if (!watcherRedirectAllowed(tabId, target)) return;
  try {
    await chrome.tabs.update(tabId, { url: target });
    const hostname = hostnameFromUrl(liveUrl);
    console.warn(
      "[SafePC] Tab watcher: đã chuyển tab #" +
        tabId +
        " (" +
        (hostname || "?") +
        ") sang trang chặn (lý do: " +
        reason +
        ").",
    );
    // Lượt web bị chặn (0.1.7): ghi theo DOMAIN CỦA RULE đã khớp
    // (matchedBlockRuleDomain), cùng đơn vị với đường quy chiếu DNR, để
    // dedupe 60s chung gộp được một lần chặn dù cả hai đường cùng ghi
    // (watcher chuyển tab xong, handleBlockedPageShown lại quy chiếu qua
    // DNR). Đánh giá lại ở đây — rule có thể đã đổi trong lúc chờ
    // tabs.update — nên không xác định được rule thì dùng hostname của
    // URL vừa chuyển làm dự phòng. Chỉ ghi khi chuyển thành công (tab
    // đã tới trang chặn).
    const blockedDomain = matchedBlockRuleDomain(liveUrl, currentRules, new Date()) || hostname;
    if (blockedDomain) recordBlockedVisit(blockedDomain, Date.now());
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

// Tab vừa tới trang chặn qua redirect DNR: tra rule redirect vừa khớp
// trong 10 giây gần nhất và ghi lượt chặn theo domain của rule đó. Không
// có rule nào khớp (watcher chuyển tab, rule chặn-tất-cả, API trống/lỗi)
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
    if (!Array.isArray(matched)) return;
    let best = null;
    for (const entry of matched) {
      if (!entry || typeof entry !== "object") continue;
      if (!Number.isInteger(entry.ruleId) || typeof entry.timeStamp !== "number") continue;
      if (entry.timeStamp < minTimeStamp) continue;
      const info = blockingRuleDomains.get(entry.ruleId);
      if (!info || !info.isRedirect) continue;
      if (!best || entry.timeStamp > best.timeStamp) best = { timeStamp: entry.timeStamp, domain: info.domain };
    }
    if (best) recordBlockedVisit(best.domain, Date.now());
  } catch (error) {
    console.warn("[SafePC] Không quy chiếu được domain cho trang chặn:", error);
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

function addUsage(hostname, seconds, nowMs) {
  rolloverIfNeeded(new Date(nowMs));
  usage.seconds[hostname] = (usage.seconds[hostname] || 0) + seconds;
  let entry = pending[hostname];
  if (!entry) {
    entry = { startedAt: new Date(nowMs - seconds * 1000).toISOString(), seconds: 0 };
    pending[hostname] = entry;
  }
  entry.seconds += seconds;
  enforcePendingCap();
}

// Đóng đoạn xem hiện tại: cộng thời gian từ activeSince tới nowMs vào domain
// đang hiển thị, rồi bắt đầu đoạn mới tại nowMs.
function closeSegment(nowMs) {
  if (activeHostname !== null && windowFocused && activeSince > 0 && nowMs > activeSince) {
    const elapsed = Math.min(MAX_SEGMENT_SECONDS, Math.floor((nowMs - activeSince) / 1000));
    if (elapsed > 0) addUsage(activeHostname, elapsed, nowMs);
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
    } else {
      activeTabId = null;
      activeHostname = null;
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

async function loadState() {
  try {
    const stored = await chrome.storage.local.get([
      STORE_KEYS.usage,
      STORE_KEYS.pending,
      STORE_KEYS.pendingBlocked,
    ]);
    if (isValidUsage(stored[STORE_KEYS.usage])) usage = stored[STORE_KEYS.usage];
    if (isValidPending(stored[STORE_KEYS.pending])) pending = stored[STORE_KEYS.pending];
    if (isValidPendingBlocked(stored[STORE_KEYS.pendingBlocked])) {
      pendingBlocked = stored[STORE_KEYS.pendingBlocked];
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
  const visits = entries.map(([domain, entry]) => ({
    domain,
    startedAt: entry.startedAt,
    durationSec: entry.seconds,
  }));
  // Lượt bị chặn đi cùng batch reportUsage, mang blocked = true và
  // durationSec = 0 (không xem được gì). Không cần message type mới:
  // NativeHost và Service đều đọc thêm trường blocked tùy chọn.
  for (const entry of blockedEntries) {
    visits.push({ domain: entry.domain, startedAt: entry.startedAt, durationSec: 0, blocked: true });
  }
  // Chụp số giây đã gửi thành số nguyên (không giữ tham chiếu tới entry):
  // entry trong pending có thể được cộng thêm trong lúc đang gửi, và phép
  // trừ sau đó phải trừ đúng số đã gửi, không phải số đã bị cộng thêm.
  const sentSeconds = entries.map(([domain, entry]) => ({ domain, seconds: entry.seconds }));
  const response = await sendNativeMessage({ type: "reportUsage", visits });
  if (response && response.ok === true) {
    // Trừ đúng số giây đã gửi: dữ liệu cộng thêm trong lúc gửi được giữ lại.
    for (const { domain, seconds } of sentSeconds) {
      const current = pending[domain];
      if (!current) continue;
      current.seconds -= seconds;
      if (current.seconds <= 0) delete pending[domain];
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
  void handleTabUrlChange(tabId, changeInfo.url);
});

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
  if (tabId !== activeTabId) return;
  const nowMs = Date.now();
  closeSegment(nowMs);
  activeTabId = null;
  activeHostname = null;
  activeSince = nowMs;
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
