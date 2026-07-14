// Little Angels — Parents PWA service worker.
// Origin-scoped (parents.littleangelsealing.co.uk only — registered solely by /pwa.js
// which guards on the parents origin). Behind Cloudflare Access (email OTP).
//
// PII SAFETY (non-negotiable):
//   • Anything containing "/api/" (incl. /welcome/<x>/api/<y>) is NETWORK-ONLY and is
//     NEVER written to the cache — these carry child-scoped, per-parent data.
//   • Resource file downloads (/welcome/resources/file) are also never cached.
//   • Only the app SHELL (HTML — which holds NO child data; data is fetched by JS
//     after load) and versioned static assets (css/js/icons/images) are cached.
// Bump CACHE to roll a new shell/asset set out to installed clients.
const CACHE = 'la-parents-v20260706a';

// Precached so the very first offline load already has a shell + branding.
const PRECACHE = [
  '/offline.html',
  '/manifest.webmanifest',
  '/pwa.js',
  '/little-angels-logo.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

const STATIC_RE    = [/^\/css\//, /^\/js\//, /^\/icons\//, /^\/images\//];
const STATIC_EXACT = new Set(['/little-angels-logo.png', '/manifest.webmanifest', '/pwa.js']);

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      // best-effort: a single 404 must not abort the whole precache
      Promise.allSettled(PRECACHE.map(u =>
        fetch(u, { credentials: 'same-origin' }).then(r => r.ok && c.put(u, r))
      ))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // never touch writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // same-origin only

  // 1) Anything dynamic / authenticated → network-only, NEVER cached (PII).
  if (url.pathname.includes('/api/') || url.pathname.startsWith('/welcome/resources/file')) {
    e.respondWith(
      fetch(req).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), {
          status: 503, headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // 2) Versioned static assets → cache-first (survive offline, instant repeat loads).
  const isStatic = STATIC_EXACT.has(url.pathname) || STATIC_RE.some(p => p.test(url.pathname));
  if (isStatic) {
    e.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(res => {
        if (res && res.ok) { const clone = res.clone(); caches.open(CACHE).then(c => c.put(req, clone)); }
        return res;
      }).catch(() => cached))
    );
    return;
  }

  // 3) Top-level navigations (the app shell — PII-free) → network-first, cache the
  //    shell as an offline fallback; serve cached shell or /offline.html when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.ok) { const clone = res.clone(); caches.open(CACHE).then(c => c.put(req, clone)); }
        return res;
      }).catch(() => caches.match(req).then(c => c || caches.match('/offline.html')))
    );
    return;
  }

  // 4) Everything else → straight to network, no caching.
});

// ── Web Push (parents) — optional; harmless if never used ──────────────────────
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = { body: e.data && e.data.text ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Little Angels', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'la-parents',
    data: { url: data.url || '/welcome' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/welcome';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
      for (const w of wins) { if ('focus' in w) { w.focus(); if ('navigate' in w) { try { w.navigate(target); } catch (_) {} } return; } }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});
