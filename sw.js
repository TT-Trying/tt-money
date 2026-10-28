// Service worker: เก็บไฟล์หน้าแอพไว้ในเครื่อง เปิดได้แม้ไม่มีเน็ต
// เวลาแก้โค้ดแล้วอัปโหลดใหม่ ให้เปลี่ยนเลขเวอร์ชันด้านล่าง
const CACHE = 'ttm-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// ไฟล์ของแอพ: ลองเน็ตก่อน (ได้เวอร์ชันล่าสุด) ถ้าไม่มีเน็ตใช้ของในเครื่อง
// คำขอไป Apps Script และที่อื่น: ไม่ยุ่ง ปล่อยผ่านตามปกติ
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
