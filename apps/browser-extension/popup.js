// SafePC — popup: chỉ hiển thị trạng thái + thời gian đã dùng hôm nay cho
// các domain bị giới hạn. Không có giao diện cài đặt (quy tắc đặt trên
// Dashboard). Chỉ đọc chrome.storage.local, không đọc tab, không gọi API,
// không hiển thị URL (chỉ domain đã chuẩn hóa từ quy tắc).

"use strict";

const { domainMatches, localDateKey } = globalThis.SafePCDomain;

document.addEventListener("DOMContentLoaded", () => {
  void render();
});

async function render() {
  const titleEl = document.getElementById("title");
  const statusEl = document.getElementById("status");
  const listEl = document.getElementById("limits");
  const emptyEl = document.getElementById("empty");
  const syncEl = document.getElementById("sync");
  const dnrBlockedEl = document.getElementById("dnr-blocked");
  const dnrAppliedEl = document.getElementById("dnr-applied");
  const dnrErrorEl = document.getElementById("dnr-error");
  const dnrHostPermissionsEl = document.getElementById("dnr-host-permissions");
  const dnrDomainsEl = document.getElementById("dnr-domains");
  const dnrRulesEl = document.getElementById("dnr-rules");

  // Hiện phiên bản extension cạnh tên (đợt sửa 18/11/2026): đọc từ
  // manifest lúc chạy, không hardcode. Lỗi thì giữ tiêu đề mặc định.
  if (titleEl) {
    try {
      const version = chrome.runtime.getManifest().version;
      if (typeof version === "string" && version) {
        titleEl.textContent = "SafePC " + version;
      }
    } catch {
      // Giữ tiêu đề mặc định "SafePC" trong HTML.
    }
  }

  let stored;
  try {
    stored = await chrome.storage.local.get([
      "safepc_status",
      "safepc_limits",
      "safepc_usage",
      "safepc_dnr",
    ]);
  } catch {
    if (statusEl) {
      statusEl.textContent = "Không đọc được trạng thái.";
      statusEl.className = "status off";
    }
    return;
  }

  const status = stored.safepc_status;
  const connected = Boolean(status && status.connected);
  if (statusEl) {
    statusEl.textContent = connected
      ? "SafePC đang bảo vệ trình duyệt này"
      : "Chưa kết nối tới SafePC Agent — trình duyệt chưa được bảo vệ.";
    statusEl.className = "status " + (connected ? "ok" : "off");
  }

  if (syncEl) {
    if (status && typeof status.updatedAt === "string" && status.updatedAt) {
      const when = new Date(status.updatedAt);
      syncEl.textContent = Number.isNaN(when.getTime())
        ? ""
        : "Đồng bộ quy tắc lần cuối: " +
          String(when.getHours()).padStart(2, "0") +
          ":" +
          String(when.getMinutes()).padStart(2, "0") +
          " hôm nay.";
    } else {
      syncEl.textContent = "Chưa đồng bộ quy tắc lần nào.";
    }
  }

  // Chẩn đoán DNR (đợt sửa 17/11/2026): số domain đang chặn + số rule thực
  // tế trình duyệt đang áp dụng + lỗi của lần áp quy tắc gần nhất (nếu có).
  // Dữ liệu do background.js ghi sau mỗi lần rebuild; chưa có dữ liệu thì
  // báo chưa áp quy tắc lần nào, không suy đoán.
  const dnr = stored.safepc_dnr;
  const dnrOk =
    dnr &&
    typeof dnr === "object" &&
    Number.isInteger(dnr.blockedCount) &&
    Number.isInteger(dnr.appliedCount);
  if (dnrBlockedEl) {
    dnrBlockedEl.textContent = dnrOk
      ? "Đang chặn: " + dnr.blockedCount + " domain."
      : "Chưa áp quy tắc chặn lần nào.";
  }
  if (dnrAppliedEl) {
    dnrAppliedEl.textContent = dnrOk
      ? "Quy tắc trình duyệt đang áp dụng: " + dnr.appliedCount + "."
      : "";
    dnrAppliedEl.hidden = !dnrOk;
  }
  if (dnrErrorEl) {
    if (dnrOk && typeof dnr.error === "string" && dnr.error) {
      dnrErrorEl.textContent = "Lỗi áp quy tắc chặn: " + dnr.error;
      dnrErrorEl.className = "note dnr off";
      dnrErrorEl.hidden = false;
    } else {
      dnrErrorEl.textContent = "";
      dnrErrorEl.hidden = true;
    }
  }

  // Cảnh báo thiếu quyền host (0.1.6): chỉ hiện khi chẩn đoán ghi rõ
  // hostPermissionsOk === false (redirect DNR chết lặng khi thiếu quyền).
  // Chẩn đoán cũ (trước 0.1.6) không có trường này thì không hiện —
  // fail-open, không báo động giả.
  if (dnrHostPermissionsEl) {
    if (dnrOk && dnr.hostPermissionsOk === false) {
      dnrHostPermissionsEl.textContent =
        "Thiếu quyền truy cập trang web — trang chặn có thể không hiện.";
      dnrHostPermissionsEl.hidden = false;
    } else {
      dnrHostPermissionsEl.textContent = "";
      dnrHostPermissionsEl.hidden = true;
    }
  }

  // Chẩn đoán sâu (đợt sửa 18/11/2026): domain nào đang chặn + rule nào
  // đang áp dụng (id, ưu tiên, mẫu khớp, hành động). Dữ liệu do background.js ghi
  // kèm mỗi lần rebuild; vắng thì báo "không có", không suy đoán.
  if (dnrDomainsEl) {
    const domains = Array.isArray(dnr && dnr.blockedDomains)
      ? dnr.blockedDomains.filter((domain) => typeof domain === "string" && domain)
      : [];
    dnrDomainsEl.textContent = dnrOk
      ? "Domain đang chặn: " + (domains.length > 0 ? domains.join(", ") : "không có") + "."
      : "";
    dnrDomainsEl.hidden = !dnrOk;
  }
  if (dnrRulesEl) {
    const entries = Array.isArray(dnr && dnr.ruleSummary) ? dnr.ruleSummary : [];
    const parts = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (!Number.isInteger(entry.id) || typeof entry.action !== "string") continue;
      const pattern =
        typeof entry.pattern === "string" && entry.pattern ? entry.pattern : "(không có mẫu)";
      const priority = Number.isInteger(entry.priority) ? " p" + entry.priority : "";
      parts.push("#" + entry.id + priority + " " + pattern + " -> " + entry.action);
    }
    dnrRulesEl.textContent = dnrOk
      ? "Rule đang áp: " + (parts.length > 0 ? parts.join("; ") : "không có") + "."
      : "";
    dnrRulesEl.hidden = !dnrOk;
  }

  // Thời gian đã dùng: chỉ tính khi usage thuộc ngày hôm nay (giờ địa phương).
  const usage = stored.safepc_usage;
  const secondsByHost =
    usage &&
    typeof usage === "object" &&
    usage.date === localDateKey(new Date()) &&
    usage.seconds &&
    typeof usage.seconds === "object"
      ? usage.seconds
      : {};

  // Nhiều rule cùng domain thì lấy ngân sách nhỏ nhất (khớp background.js).
  const budgets = new Map();
  const limits = Array.isArray(stored.safepc_limits) ? stored.safepc_limits : [];
  for (const entry of limits) {
    if (!entry || !Number.isInteger(entry.minutesPerDay) || entry.minutesPerDay <= 0) continue;
    const domains = Array.isArray(entry.domains) ? entry.domains : [];
    for (const domain of domains) {
      if (typeof domain !== "string") continue;
      if (!budgets.has(domain) || entry.minutesPerDay < budgets.get(domain)) {
        budgets.set(domain, entry.minutesPerDay);
      }
    }
  }

  if (listEl) listEl.replaceChildren();
  if (budgets.size === 0) {
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;

  const rows = [...budgets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ruleDomain, minutesPerDay] of rows) {
    let usedSeconds = 0;
    for (const [host, seconds] of Object.entries(secondsByHost)) {
      if (domainMatches(host, ruleDomain)) usedSeconds += seconds;
    }
    const usedMinutes = Math.floor(usedSeconds / 60);
    const item = document.createElement("li");
    const domainEl = document.createElement("span");
    domainEl.className = "domain";
    domainEl.textContent = ruleDomain;
    const minutesEl = document.createElement("span");
    minutesEl.className = "minutes";
    minutesEl.textContent = usedMinutes + "/" + minutesPerDay + " phút";
    item.append(domainEl, minutesEl);
    if (listEl) listEl.append(item);
  }
}
