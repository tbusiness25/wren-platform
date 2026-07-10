// Wren EYFS Service Worker — offline support for register, observations, diary
const CACHE = 'wren-eyfs-v2';
const STATIC = [
  '/css/wren.css',
  '/js/wren-shell.js',
  '/js/device-detect.js',
  '/images/little-angels-logo.png',
  '/manifest.webmanifest',
  '/portal.html',
  '/login.html',
  '/index.html',
  '/admin.html',
  '/parent.html',
  '/hr.html',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC.map(u => new Request(u, {cache:'reload'}))))
      .catch(() => {}) // Don't block install on cache errors
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Skip non-GET, API calls, and cross-origin
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.origin !== self.location.origin) return;

  // Cache-first for static assets; network-first for HTML pages
  const isHtml = e.request.headers.get('accept')?.includes('text/html') || url.pathname.endsWith('.html');
  const isStatic = url.pathname.match(/\.(css|js|png|jpg|jpeg|svg|webp|ico|woff2?)$/);

  if (isStatic) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }))
    );
  } else if (isHtml) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  }
});
