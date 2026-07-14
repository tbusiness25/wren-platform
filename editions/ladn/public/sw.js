// Wren LADN EY portal — offline-first service worker
// Cache version: bump CACHE_NAME to force clients to update
const CACHE_NAME = 'wren-ey-v20260706a';

// Versioned assets (css/js/images carry ?v= query strings) are cache-first.
// EY HTML pages are deliberately NOT here: they fall through to the network-first
// branch (fresh online, cached only as an offline-reload fallback) so a docker-cp
// deploy is never masked by a stale cached page.
const STATIC_RE = [/^\/css\//, /^\/js\//, /^\/images\//];

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  // Delete all caches whose name !== current; then claim all clients immediately
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;

  // Only intercept same-origin GETs
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Auth endpoints: always hit the network, never cache
  if (url.pathname.startsWith('/api/auth/')) return;

  const isStatic = STATIC_RE.some(p => p.test(url.pathname));
  const isApi    = url.pathname.startsWith('/api/');

  if (isStatic) {
    // Cache-first: shell assets survive offline
    e.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, clone));
          }
          return res;
        });
      })
    );
  } else {
    // Network-first: navigations + API calls return live data when online;
    // fall back to cache on network failure so offline page loads don't blank
    e.respondWith(
      fetch(req).then(res => {
        // Cache successful non-API navigation responses so they survive reload offline
        if (res && res.ok && !isApi) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, clone));
        }
        return res;
      }).catch(() => caches.match(req))
    );
  }
});

// ── Web Push ─────────────────────────────────────────────────────────────────
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = { body: e.data && e.data.text ? e.data.text() : '' }; }
  const title = data.title || 'Wren';
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/little-angels-logo.png',
    badge: '/little-angels-logo.png',
    tag: data.tag || 'wren',
    data: { url: data.url || '/ey/inbox' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/ey/inbox';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
      for (const w of wins) {
        if ('focus' in w) { w.focus(); if ('navigate' in w) { try { w.navigate(url); } catch (_) {} } return; }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
