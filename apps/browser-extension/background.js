// SafePC Browser Extension — STUB Sprint 3.
// Đây là khung stub, CHƯA có logic chặn/báo cáo thật.
// File này không thu thập gì, không gửi dữ liệu đi đâu, không gọi fetch,
// không kết nối Supabase, không đọc URL đầy đủ, không đọc nội dung trang.

// TODO (Sprint 3): tải blocklist/allowlist từ bảng `rules` (type = website)
// qua kênh an toàn do Agent/Backend cung cấp, rồi chuyển thành
// declarativeNetRequest rules. Không nhúng secret/key vào extension.
// TODO (Sprint 3): chỉ xử lý DOMAIN (cắt bỏ path/query). Không lưu,
// không log, không gửi full URL lên server. Xem README.md và docs/03-SECURITY.md.
// TODO (Sprint 3): báo cáo domain đã thăm về bảng `web_visits`
// (chỉ domain + blocked: bool), tuân thủ nguyên tắc thu thập tối thiểu.
// TODO (Sprint 3): xử lý cập nhật rules khi phụ huynh đổi quy tắc,
// và xử lý khi extension chưa được ghép nối với thiết bị nào.

console.log("[SafePC] Stub Sprint 3 — background service worker đã khởi động. Chưa có logic chặn/báo cáo thật.");

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener((details) => {
    console.log("[SafePC] Đã cài đặt/cập nhật (stub):", details.reason);

    // Seed declarativeNetRequest rules rỗng (stub): không thêm rule chặn nào.
    // Chỉ giữ đường dây API để Sprint 3 thay bằng rules thật từ blocklist.
    // Không thu thập, không gửi dữ liệu.
    if (
      chrome.declarativeNetRequest &&
      typeof chrome.declarativeNetRequest.updateDynamicRules === "function"
    ) {
      chrome.declarativeNetRequest
        .updateDynamicRules({ removeRuleIds: [], addRules: [] })
        .then(() => {
          console.log("[SafePC] Dynamic rules rỗng đã được seed (stub). Chưa chặn domain nào.");
        })
        .catch((error) => {
          console.warn("[SafePC] Không seed được dynamic rules rỗng (stub):", error);
        });
    } else {
      console.log("[SafePC] declarativeNetRequest không khả dụng trong môi trường này (stub).");
    }
  });
}
