// SafePC — Service Worker của Dashboard phụ huynh.
//
// VAI TRÒ DUY NHẤT ở v1: nhận Web Push (sự kiện 'push') cho phụ huynh
// và mở đúng trang khi phụ huynh bấm vào thông báo
// ('notificationclick') — xem migration 30 và Edge Function
// send-push-notifications.
//
// CỐ Ý không có handler 'fetch' và không cache bất cứ thứ gì: hành
// vi tải trang giữ nguyên như trước khi có SW (trình duyệt tải thẳng
// từ mạng như bình thường). Thêm cache/offline là việc riêng, không
// gộp vào đợt push này.
//
// Payload push (JSON, do server dựng — đã mã hóa đầu-cuối theo chuẩn
// Web Push nên chỉ thiết bị của phụ huynh giải mã được):
//   { title, body, url (đường dẫn cùng origin, vd /yeu-cau), tag }
// body của tin nhắn chat chỉ là đoạn xem trước tối đa 60 ký tự do
// server cắt (quyết định riêng tư ở AMENDMENTS A-16).

self.addEventListener('install', () => {
  // Kích hoạt ngay bản SW mới, không chờ đóng hết tab cũ.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title =
    typeof payload.title === 'string' && payload.title !== ''
      ? payload.title
      : 'SafePC';
  const body = typeof payload.body === 'string' ? payload.body : '';
  // Chỉ nhận đường dẫn cùng origin (bắt đầu bằng '/'): payload lạ
  // không được dẫn phụ huynh ra ngoài Dashboard.
  const url =
    typeof payload.url === 'string' && payload.url.startsWith('/')
      ? payload.url
      : '/thong-bao';
  const options = {
    body,
    icon: '/icons/icon.svg',
    badge: '/icons/icon.svg',
    data: { url },
  };
  if (typeof payload.tag === 'string' && payload.tag !== '') {
    // Cùng tag thì thông báo mới thay thông báo cũ chưa đọc (vd
    // nhiều tin chat của cùng một con chỉ hiện một thông báo).
    options.tag = payload.tag;
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url =
    (event.notification.data && event.notification.data.url) || '/thong-bao';
  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of windowClients) {
        let sameOrigin = false;
        try {
          sameOrigin = new URL(client.url).origin === self.location.origin;
        } catch {
          sameOrigin = false;
        }
        if (sameOrigin) {
          // Đã có tab Dashboard: đưa lên trước và điều hướng tới
          // đúng trang của sự kiện (tab chat của con / trang Yêu cầu).
          await client.focus();
          if ('navigate' in client) {
            try {
              await client.navigate(url);
            } catch {
              // Điều hướng lỗi (hiếm): tab đã được focus là đủ.
            }
          }
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
