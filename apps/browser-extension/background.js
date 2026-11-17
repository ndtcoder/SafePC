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
  limits: "safepc_limits",
  status: "safepc_status",
  dnr: "safepc_dnr",
};
const MAX_PENDING = 1000;
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
//     redirect được đánh giá lại, và rule chặn (khớp hậu tố ||domain^,
//     kể cả host restrict.youtube.com — nó là tên miền con của youtube.com)
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
let activeTabId = null;
let activeHostname = null;
let activeSince = 0;
let windowFocused = true;
let initStarted = false;

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

function redirectRule(id, priority, domain, reason) {
  return {
    id,
    priority,
    action: {
      type: "redirect",
      redirect: { url: chrome.runtime.getURL("blocked.html?reason=" + reason) },
    },
    condition: { urlFilter: "||" + domain + "^", resourceTypes: ["main_frame"] },
  };
}

function blockRule(id, priority, domain) {
  return {
    id,
    priority,
    action: { type: "block" },
    condition: { urlFilter: "||" + domain + "^", resourceTypes: SUB_RESOURCE_TYPES },
  };
}

function allowRule(id, priority, domain) {
  return {
    id,
    priority,
    action: { type: "allow" },
    condition: { urlFilter: "||" + domain + "^" },
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

  // Chẩn đoán cho popup (đợt sửa 17/11/2026): số rule thực tế trình duyệt
  // đang áp dụng (đọc lại sau khi cập nhật), số domain đang chặn (hợp các
  // domain chặn + chặn tạm thời chưa hết hạn, sau chuẩn hóa), lỗi của lần
  // rebuild gần nhất. Chỉ ghi storage + console.warn, không throw, không
  // hiện gì khác cho user.
  let appliedCount = 0;
  try {
    appliedCount = (await chrome.declarativeNetRequest.getDynamicRules()).length;
  } catch (readError) {
    console.warn("[SafePC] Không đọc lại được dynamic rules:", readError);
    if (error === null) error = errorMessage(readError);
  }
  const blockedDomains = normalizeDomainSet(currentRules ? currentRules.blocked : null);
  const tempBlocked = unexpiredTempDomains(
    currentRules ? currentRules.tempBlock : null,
    now.getTime(),
  );
  const blockedCount = new Set([...blockedDomains, ...tempBlocked]).size;
  try {
    await chrome.storage.local.set({
      [STORE_KEYS.dnr]: {
        appliedCount,
        blockedCount,
        error,
        updatedAt: now.toISOString(),
      },
    });
  } catch (storeError) {
    console.warn("[SafePC] Không lưu được chẩn đoán DNR:", storeError);
  }
}

async function refreshRulesAndRebuild() {
  await fetchRules();
  // Dù fetch thất bại vẫn rebuild từ rules cũ: khung giờ/ngân sách/ghi đè
  // tạm thời được đánh giá lại theo thời gian hiện tại.
  await rebuildDynamicRules();
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
    await chrome.storage.local.set({ [STORE_KEYS.usage]: usage, [STORE_KEYS.pending]: pending });
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

async function loadState() {
  try {
    const stored = await chrome.storage.local.get([STORE_KEYS.usage, STORE_KEYS.pending]);
    if (isValidUsage(stored[STORE_KEYS.usage])) usage = stored[STORE_KEYS.usage];
    if (isValidPending(stored[STORE_KEYS.pending])) pending = stored[STORE_KEYS.pending];
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
  if (entries.length === 0) return;
  const visits = entries.map(([domain, entry]) => ({
    domain,
    startedAt: entry.startedAt,
    durationSec: entry.seconds,
  }));
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
