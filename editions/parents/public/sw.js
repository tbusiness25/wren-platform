// Your Nursery — Parents PWA service worker.
// Origin-scoped (parents.example-nursery.co.uk only — registered solely by /pwa.js
// which guards on the parents origin). Behind Cloudflare Access (email OTP).
//
// PII SAFETY (non-negotiable):
//   • Anything containing "/api/" (incl. /welcome/<x>/api/<y>) is NETWORK-ONLY and is
//     NEVER written to the cache — these carry child-scoped, per-parent data.
//   • Resource file downloads (/welcome/resources/file) are also never cached.
//   • Only the app SHELL (HTML — which holds NO child data; data is fetched by JS
//     after load) and versioned static assets (css/js/icons/images) are cached.
// Bump CACHE to roll a new shell/asset set out to installed clients.
// b339 (2026-09-18): new shell (lap-boot.js, wren-parent-empty.js, parents-app.css §10-17, pwa.js) —
// bumped so installed clients drop the old cache-first copies of all four.
// b340 (2026-09-18): the push handlers below now do real work (notification settings page + subscribe flow), and
// the settings page adds a script — bumped for the same reason.
// b341 (2026-09-21): pwa.js gained the "Leaving us" row and there are two new pages/scripts (leaving, lap-keepsake-card) —
// bumped so an installed app drops the old shell and picks the new one up.
// b342 (2026-09-21): Your account now draws the family's parents + emergency contacts from js/lap-family.js, and the home screen
// carries the standing emergency-contact card — bumped so an installed app drops the old pages and picks the new ones up.
// b343 (2026-09-21): pwa.js gained the "Forms" row and there is one new page (forms) and one new script (lap-forms) — bumped so installed apps drop the old shell.
const CACHE = 'la-parents-v20261028-install';  // 2026-10-28: install pop-up; manifest/icons now reachable without the CF cookie — drop any stale cached copy

// Precached so the very first offline load already has a shell + branding.
const PRECACHE = [
  '/offline.html',
  '/manifest.webmanifest',
  '/pwa.js',
  '/css/parents-app.css',
  '/js/lap-boot.js',
  '/js/wren-parent-empty.js',
  '/js/wren-theme.js',
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
  // 2026-10-08 — scripts & styles are NETWORK-FIRST. Cache-first kept browsers on a weeks-old
  // shell (Toby: Finance → Invoices "sometimes loads the old dash"): ?v= tags weren't bumped
  // when files changed (the Roost shell said ?v=20260922 for weeks), and on some portals even
  // unversioned files were cache-first. Online: always the deployed file (the server sends
  // no-store, so this is one quick request). Offline: the cached copy.
  if (/^\/(js|css)\//.test(url.pathname) || url.pathname === '/pwa.js') {
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.ok) { const clone = res.clone(); caches.open(CACHE).then(c => c.put(req, clone)); }
        return res;
      }).catch(() => caches.match(req).then(c => c || new Response('', { status: 504 })))
    );
    return;
  }

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
    const tryNav = () => fetch(req).then(res => {
      if (res && res.ok) { const clone = res.clone(); caches.open(CACHE).then(c => c.put(req, clone)); }
      return res;
    });
    // ONE retry after ~2s before giving up — rides out a brief tunnel blip or a deploy
    // restart so parents don't get bounced to the offline screen for a momentary hiccup.
    e.respondWith(
      tryNav().catch(() => new Promise(r => setTimeout(r, 2000)).then(tryNav))
        .catch(() => caches.match(req).then(c => c || caches.match('/offline.html')))
    );
    return;
  }

  // 4) Everything else → straight to network, no caching.
});

// ── Web Push (parents) ──────────────────────────────────────────────────────────
// b340: parents turn push on themselves, on an explicit tap, at /welcome/notifications/settings — one row per
// device in parent_push_subscriptions. What arrives is FIXED text per category ("There is something new in your
// child's learning journey."): never a child's name, never message text — it lands on a lock screen.
// A link in the payload may only ever take the parent somewhere in THIS app.
function safeUrl(u) {
  try {
    const x = new URL(u || '/welcome/notifications', self.location.origin);
    return x.origin === self.location.origin ? x.pathname + x.search + x.hash : '/welcome/notifications';
  } catch (_) { return '/welcome/notifications'; }
}

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = { body: e.data && e.data.text ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Your Nursery', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'la-parents',
    data: { url: safeUrl(data.url) },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = safeUrl(e.notification.data && e.notification.data.url);
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
      for (const w of wins) { if ('focus' in w) { w.focus(); if ('navigate' in w) { try { w.navigate(target); } catch (_) {} } return; } }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});

// The browser can rotate or expire a subscription on its own. Re-subscribe with the same server key and hand the
// new one to Wren, so a phone does not go quiet without the parent knowing. If the browser does not supply the old
// key we cannot — the Notifications screen shows the phone as not set up and the parent turns it on again.
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    try {
      const old = e.oldSubscription;
      const key = old && old.options && old.options.applicationServerKey;
      if (!key) return;
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await fetch('/welcome/notifications/api/push/subscribe', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
    } catch (_) { /* nothing to do: the parent re-enables it on the settings screen */ }
  })());
});
