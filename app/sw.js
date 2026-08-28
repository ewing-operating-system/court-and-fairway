const CACHE = 'caf-v1';
const ASSETS = [
  './', 'index.html', 'app.css', 'app.js', 'data.js', 'manifest.webmanifest',
  'icons/icon-120.png','icons/icon-152.png','icons/icon-167.png','icons/icon-180.png',
  'icons/icon-192.png','icons/icon-512.png','icons/icon-512-maskable.png'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // YouTube links leave the app by design
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit =>
      hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('./', { ignoreSearch: true }))
    )
  );
});
