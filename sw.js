// Service worker: เก็บไฟล์หน้าแอพไว้ในเครื่อง เปิดได้แม้ไม่มีเน็ต
// เวลาแก้โค้ดแล้วอัปโหลดใหม่ ให้เปลี่ยนเลขเวอร์ชันด้านล่าง
const CACHE = 'ttm-v4';
const FONT_CACHE = 'ttm-fonts';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== FONT_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // ฟอนต์จาก Google: เก็บไว้ในเครื่องถาวร (ไม่ต้องโหลดใหม่ และออฟไลน์ก็ได้ฟอนต์เดิม)
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONT_CACHE).then((c) => c.match(e.request).then((hit) => hit ||
      fetch(e.request).then((res) => { if (res.ok || res.type === 'opaque') c.put(e.request, res.clone()); return res; }))));
    return;
  }

  // คำขอไป Apps Script และที่อื่น: ไม่ยุ่ง ปล่อยผ่านตามปกติ
  if (url.origin !== self.location.origin) return;

  // ไฟล์ของแอพ: เปิดจากของในเครื่องทันที (เร็ว แม้เน็ตช้า) แล้วโหลดเวอร์ชันใหม่เก็บไว้เบื้องหลัง
  // เวอร์ชันใหม่จะเห็นตอนเปิดแอพครั้งถัดไป
  e.respondWith(caches.open(CACHE).then((c) => c.match(e.request, { ignoreSearch: true }).then((hit) => {
    const net = fetch(e.request).then((res) => { if (res.ok) c.put(e.request, res.clone()); return res; });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net.catch(() => c.match('index.html'));
  })));
});
