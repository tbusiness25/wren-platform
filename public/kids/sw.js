/* sw.js — Wren Kids offline support (b507, 2026-10-18).
 *
 * The whole app is small (about 700 KB including every picture), so the service worker simply
 * takes the lot on install. After the first visit the games work with no network at all, which is
 * the point: a tablet on a train, a nursery with flaky wifi, a family on a pay-as-you-go SIM.
 *
 * VERSION is bumped by scripts/kids/build-site.py on every publish so an installed copy picks up
 * a new game. There is nothing to cache from anywhere but this origin — the app loads no external
 * script, font or image at all, so the fetch handler ignores cross-origin requests entirely.
 */
const VERSION = '2026-10-17.7';
const SHELL = `wren-kids-${VERSION}`;

const SHELL_FILES = [
  './', 'index.html', 'curriculum.html',
  'tokens.css', 'app.css', 'games.css',
  'engine.js', 'art.js', 'app.js', 'audio-manifest.json',
  'games/subitise-snap.js', 'games/ten-town-train.js', 'games/pattern-path.js',
  'games/rhyme-time.js', 'games/bond-rally.js', 'games/spell-spotter.js',
  'games/tables-launch.js', 'games/fraction-forest.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png',
  'art/art.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL)
      /* one file failing (a new picture not yet published) must not fail the whole install */
      .then((c) => Promise.all(SHELL_FILES.map((f) => c.add(f).catch(() => null))))
      .then(() => fetch('art/art.json').then((r) => (r.ok ? r.json() : null)).catch(() => null))
      .then((art) => {
        if (!art) return null;
        const pics = Object.values(art.pictures || {}).concat(Object.values(art.gpu || {}));
        return caches.open(SHELL).then((c) =>
          Promise.all(pics.map((p) => c.add('art/' + p.file).catch(() => null))));
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('wren-kids-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       /* the staff-mode POST is never cached */
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        /* nothing is loaded cross-origin anyway */
  if (url.pathname.indexOf('/api/') === 0) return;        /* staff mode talks to the live server */

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('index.html')));
    return;
  }
  /* cache first: the app is versioned by the cache name, so a stale file cannot outlive a publish */
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => hit))
  );
});
