'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Leavers keepsake — PUBLIC, token-gated delivery (PROMPT 46)
// NO login. An unguessable per-child token (minted by staff in Roost) gates a
// self-contained download + an installable, offline-capable mini-PWA that shows
// JUST that child's memories. Mounted BEFORE the auth/offsite gates so it is
// reachable without a JWT or Cloudflare-Access session, on any portal host.
//
// PII stance (deliberate, and OPPOSITE to the parents-portal SW): this keepsake
// IS the family's own child's data, gifted to them — so the SW caches it offline
// on purpose ("yours to keep forever"). The unguessable token + expiry + revoke
// are the access control; every access is written to audit_log.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const fs   = require('fs');
const router = express.Router();
const { getPool } = require('../db/pool');
const { recordAudit } = require('../utils/audit');
const K = require('../lib/keepsake');

// Resolve + validate a token → the package row (snapshot included) or null.
async function loadPackage(token) {
  if (!token || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const db = getPool();
  const { rows } = await db.query(
    `SELECT id, child_id, token, status, title, snapshot, expires_at FROM leavers_gift_packages WHERE token=$1`, [token]);
  if (!rows.length) return null;
  const p = rows[0];
  if (p.status === 'revoked') return { ...p, _gone: 'revoked' };
  if (p.expires_at && new Date(p.expires_at) < new Date()) {
    if (p.status !== 'expired') db.query(`UPDATE leavers_gift_packages SET status='expired' WHERE id=$1`, [p.id]).catch(() => {});
    return { ...p, _gone: 'expired' };
  }
  return p;
}

function goneResponse(res, why) {
  res.status(410).type('html').send(K.wrapDocument(
    `<div class="kbook"><section class="kcard" style="text-align:center;margin-top:40px">
       <h2>💛 This keepsake link is no longer available</h2>
       <p class="kprose">This memory link has ${why === 'expired' ? 'expired' : 'been withdrawn'}. If you'd like it re-issued, please contact Your Nursery.</p>
       <p class="kfoot-info">${K.esc(K.NURSERY.phone)} &middot; ${K.esc(K.NURSERY.email)}</p>
     </section></div>`, 'Keepsake unavailable'));
}

async function touch(pkg, req, extra) {
  getPool().query(`UPDATE leavers_gift_packages SET access_count=access_count+1, last_accessed_at=now() WHERE id=$1`, [pkg.id]).catch(() => {});
  recordAudit({ req, action: 'view', entity_type: 'leavers_gift', entity_id: pkg.id,
    actor_type: 'anonymous', meta: { child_id: pkg.child_id, ...(extra || {}) } });
}

// ── App shell (the installable PWA) — matches both /keepsake/:token and …/ ────
// A <base href> makes every ./relative URL (data, book, media, sw.js, manifest,
// download) resolve under /keepsake/:token/ regardless of trailing slash, so we
// don't need a redirect (which would loop under Express non-strict routing).
router.get('/keepsake/:token', async (req, res) => {
  const pkg = await loadPackage(req.params.token);
  if (!pkg) return res.status(404).type('html').send(K.wrapDocument(
    `<div class="kbook"><section class="kcard" style="text-align:center;margin-top:40px"><h2>Keepsake not found</h2><p class="kprose">Please check the link from your nursery.</p></section></div>`, 'Not found'));
  if (pkg._gone) return goneResponse(res, pkg._gone);
  const name = pkg.snapshot?.child?.display_name || 'Memory book';
  res.type('html').send(APP_SHELL(name, pkg.title || name, req.params.token));
});

// ── Dynamic manifest (per child) ──────────────────────────────────────────────
router.get('/keepsake/:token/manifest.webmanifest', async (req, res) => {
  const pkg = await loadPackage(req.params.token);
  if (!pkg || pkg._gone) return res.status(404).json({ error: 'gone' });
  const name = pkg.snapshot?.child?.display_name || 'Memory Book';
  res.type('application/manifest+json').json({
    name: `${name} — Memory Book`,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    description: `${name}'s Your Nursery keepsake — photos, memories and learning journey.`,
    id: `/keepsake/${req.params.token}/`,
    start_url: './',
    scope: './',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#fbf7f0',
    theme_color: '#e07820',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  });
});

// ── Service worker (scoped to /keepsake/:token/ by its own path) ──────────────
router.get('/keepsake/:token/sw.js', (req, res) => {
  res.type('application/javascript').set('Service-Worker-Allowed', `/keepsake/${req.params.token}/`).send(KEEPSAKE_SW);
});

// ── JSON snapshot (the data the PWA renders) ──────────────────────────────────
router.get('/keepsake/:token/data', async (req, res) => {
  const pkg = await loadPackage(req.params.token);
  if (!pkg) return res.status(404).json({ error: 'not_found' });
  if (pkg._gone) return res.status(410).json({ error: pkg._gone });
  touch(pkg, req, { via: 'data' });
  res.json(pkg.snapshot);
});

// ── Server-rendered book fragment (media via ./media?b=…) ─────────────────────
router.get('/keepsake/:token/book', async (req, res) => {
  const pkg = await loadPackage(req.params.token);
  if (!pkg) return res.status(404).send('Not found');
  if (pkg._gone) return goneResponse(res, pkg._gone);
  res.type('html').send(K.renderBookFragment(pkg.snapshot, './media?b='));
});

// ── Media file (allow-listed to this snapshot's manifest — blocks IDOR/traversal) ──
router.get('/keepsake/:token/media', async (req, res) => {
  const pkg = await loadPackage(req.params.token);
  if (!pkg || pkg._gone) return res.status(404).end();
  const b = String(req.query.b || '');
  const snap = pkg.snapshot || {};
  const allowed = new Set([
    ...((snap.media || []).map(m => m.basename)),
    ...(snap.child?.photo ? [snap.child.photo.basename] : []),
  ]);
  if (!allowed.has(b)) return res.status(404).end();
  const p = K.resolveMediaPath(b);
  if (!p) return res.status(404).end();
  try {
    res.setHeader('Content-Type', K.mimeFor(b));
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    fs.createReadStream(p).on('error', () => { if (!res.headersSent) res.status(404).end(); }).pipe(res);
  } catch (_) { res.status(404).end(); }
});

// ── Download — self-contained HTML memory book (media inlined, keeps forever) ──
router.get('/keepsake/:token/download', async (req, res) => {
  const pkg = await loadPackage(req.params.token);
  if (!pkg) return res.status(404).send('Not found');
  if (pkg._gone) return goneResponse(res, pkg._gone);
  touch(pkg, req, { via: 'download' });
  const html = K.renderStandaloneBook(pkg.snapshot);
  const fname = (pkg.title || 'memory-book').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}.html"`);
  res.send(html);
});

// ── Download — PDF keepsake ───────────────────────────────────────────────────
router.get('/keepsake/:token/book.pdf', async (req, res) => {
  const pkg = await loadPackage(req.params.token);
  if (!pkg) return res.status(404).send('Not found');
  if (pkg._gone) return goneResponse(res, pkg._gone);
  touch(pkg, req, { via: 'pdf' });
  try {
    const pdf = await K.renderBookPDF(pkg.snapshot);
    const fname = (pkg.title || 'memory-book').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}.pdf"`);
    res.send(pdf);
  } catch (e) { console.error('[keepsake] pdf:', e.message); res.status(500).send('PDF generation failed'); }
});

// ── The PWA app shell (thin wrapper that loads ./book + install + offline) ────
function APP_SHELL(name, title, token) {
  const esc = K.esc;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<base href="/keepsake/${esc(token)}/">
<title>${esc(title)}</title>
<link rel="manifest" href="./manifest.webmanifest">
<meta name="theme-color" content="#e07820">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="${esc(name)}">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;700;800&display=swap" rel="stylesheet">
<style>${K.BOOK_CSS}
.kbar-top{position:sticky;top:0;z-index:50;display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap;padding:8px 10px;background:rgba(251,247,240,.92);backdrop-filter:blur(6px);border-bottom:1px solid var(--k-line)}
.kbtn{border:0;border-radius:20px;padding:8px 16px;font-family:inherit;font-weight:800;font-size:.86rem;cursor:pointer;background:#fff;color:var(--k-blue);border:1px solid var(--k-line)}
.kbtn--cta{background:linear-gradient(135deg,var(--k-blue),var(--k-orange));color:#fff;border:0}
.koff{display:none;text-align:center;padding:6px;background:#fff3e0;color:#a15c14;font-size:.8rem}
.kloading{text-align:center;color:var(--k-soft);padding:60px 20px}
.kspin{width:34px;height:34px;border:4px solid #eadfce;border-top-color:var(--k-orange);border-radius:50%;animation:ksp 1s linear infinite;margin:0 auto 14px}
@keyframes ksp{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="koff" id="koff">You're offline — showing your saved memory book 💛</div>
<div class="kbar-top">
  <button class="kbtn kbtn--cta" id="kinstall" hidden>⬇️ Install app</button>
  <a class="kbtn" href="./download">💾 Save (HTML)</a>
  <a class="kbtn" href="./book.pdf">📄 PDF</a>
</div>
<div id="kroot"><div class="kloading"><div class="kspin"></div>Opening ${esc(name)}'s memory book…</div></div>
<script>
(function(){
  var root=document.getElementById('kroot');
  fetch('./book',{credentials:'same-origin'}).then(function(r){return r.ok?r.text():Promise.reject();})
    .then(function(html){root.innerHTML=html;})
    .catch(function(){root.innerHTML='<div class="kloading">We couldn\\'t open the book right now. Please check your connection and try again.</div>';});
  // offline banner
  function upd(){document.getElementById('koff').style.display=navigator.onLine?'none':'block';}
  window.addEventListener('online',upd);window.addEventListener('offline',upd);upd();
  // install prompt
  var dp=null,ib=document.getElementById('kinstall');
  window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();dp=e;ib.hidden=false;});
  ib.addEventListener('click',function(){if(!dp)return;dp.prompt();dp.userChoice.then(function(){dp=null;ib.hidden=true;});});
  window.addEventListener('appinstalled',function(){ib.hidden=true;});
  // service worker (offline-capable, scoped to this keepsake)
  if('serviceWorker' in navigator){navigator.serviceWorker.register('./sw.js',{scope:'./'}).catch(function(){});}
})();
</script>
</body></html>`;
}

// ── The keepsake service worker (offline-first for a frozen gift) ──────────────
const KEEPSAKE_SW = `
// Your Nursery keepsake SW — offline-first for a single child's memory book.
// Scope is /keepsake/<token>/ (set by this file's own path). Caching the child's
// own media offline is the whole point of the gift ("yours to keep forever").
const CACHE = 'la-keepsake-v20260702a';
const SHELL = ['./', './book', './data', './manifest.webmanifest'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c =>
    Promise.allSettled(SHELL.map(u => fetch(u, {credentials:'same-origin'}).then(r => r.ok && c.put(u, r))))
  ).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.includes('/keepsake/')) return;   // only our scope
  // Stale-while-revalidate: instant offline, refresh in the background while online.
  e.respondWith(caches.open(CACHE).then(cache =>
    cache.match(req).then(cached => {
      const net = fetch(req).then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => cached);
      return cached || net;
    })
  ));
});
`;

module.exports = router;
