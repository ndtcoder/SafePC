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
  const statusEl = document.getElementById("status");
  const listEl = document.getElementById("limits");
  const emptyEl = document.getElementById("empty");
  const syncEl = document.getElementById("sync");

  let stored;
  try {
    stored = await chrome.storage.local.get([
      "safepc_status",
      "safepc_limits",
      "safepc_usage",
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
