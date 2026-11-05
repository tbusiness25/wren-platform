// Wren Roost (admin) portal — service worker (b148)
// Copied from editions/ladn/public/sw.js (EY) with admin scope/defaults; push +
// notificationclick handlers mirror the EY/HR approach for consistency.
// Bump CACHE_NAME to force clients to update.
const CACHE_NAME = 'wren-admin-v3-20261008-netfirst';

// Versioned assets (css/js/images carry ?v= query strings) are cache-first.
// HTML pages are deliberately NOT here: they fall through to the network-first
// branch (fresh online, cached only as an offline-reload fallback) so a deploy
// is never masked by a stale cached page.
const STATIC_RE = [/^\/css\//, /^\/js\//, /^\/images\//, /^\/icons\//];

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
  // 2026-10-08 — scripts & styles are NETWORK-FIRST. Cache-first kept browsers on a weeks-old
  // shell (Toby: Finance → Invoices "sometimes loads the old dash"): ?v= tags weren't bumped
  // when files changed (the Roost shell said ?v=20260922 for weeks), and on some portals even
  // unversioned files were cache-first. Online: always the deployed file (the server sends
  // no-store, so this is one quick request). Offline: the cached copy.
  if (/^\/(js|css)\//.test(url.pathname)) {
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.ok) { const clone = res.clone(); caches.open(CACHE_NAME).then(c => c.put(req, clone)); }
        return res;
      }).catch(() => caches.match(req).then(c => c || new Response('', { status: 504 })))
    );
    return;
  }


  const isStatic = STATIC_RE.some(p => p.test(url.pathname));
  const isApi    = url.pathname.startsWith('/api/');
  // 2026-09-21 — the comment at the top of this file has always said "versioned
  // assets (css/js/images carry ?v= query strings) are cache-first", but the rule
  // below cached EVERY /js/ and /css/ URL forever, version or no version. So a
  // change to wren-shell-v2.js — a new sidebar entry, a new section — did not
  // reach a browser that had been here before, and Toby kept seeing a page from
  // before the feature existed ("I go back to Children and it shows the cached
  // page from before the keepsakes section was added"). Bumping CACHE_NAME fixed
  // it once each time; this fixes the rule.
  //
  //   versioned (?v=…) → cache-first, because the URL changes when the file does
  //   unversioned      → stale-while-revalidate: instant from cache, and the next
  //                      load has the new one. Never more than one load stale.
  const isVersioned = url.search.includes('v=');

  if (isStatic && isVersioned) {
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
  } else if (isStatic) {
    e.respondWith(
      caches.match(req).then(cached => {
        const fresh = fetch(req).then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, clone));
          }
          return res;
        }).catch(() => cached);          // offline: whatever we already had
        return cached || fresh;          // online + cached: serve now, refresh behind
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
      }).catch(async () => {
        // b328 (2026-09-11) — this used to be `.catch(() => caches.match(req))`.
        // API responses are never cached (see above), so for a failed API call
        // caches.match resolved to undefined and respondWith(undefined) threw
        // "TypeError: Failed to convert value to 'Response'" — a service-worker
        // crash in place of the page's own error. Toby saw it on "Download
        // planning". Now: the cached copy if there is one, otherwise a real
        // error the page can handle.
        const cached = await caches.match(req);
        if (cached) return cached;
        return isApi
          ? new Response(JSON.stringify({ error: 'You appear to be offline — please try again.' }),
              { status: 503, headers: { 'Content-Type': 'application/json' } })
          : Response.error();
      })
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
    data: { url: data.url || '/admin/cockpit/comms' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/admin/cockpit/comms';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
      for (const w of wins) {
        if ('focus' in w) { w.focus(); if ('navigate' in w) { try { w.navigate(url); } catch (_) {} } return; }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
