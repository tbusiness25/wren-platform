/* Your Nursery — Parents PWA + mobile shell.
 * Loaded (deferred) on every /welcome/* page. Self-contained, no dependencies.
 * Responsibilities:
 *   1. Inject PWA <head> tags (manifest, theme-color, apple touch icon + meta).
 *   2. Register the service worker (/sw.js) — guarded to the parents origin.
 *   3. "Add to Home Screen" install banner (Android/desktop) + iOS hint.
 *   4. A consistent mobile bottom-nav + "More" drawer (the top nav is preserved
 *      and made horizontally scrollable on mobile — nothing is removed).
 * Brand: green #2d5a4a / cream — matches the live parent hub.
 */
(function () {
  'use strict';

  // ── Origin guard — only ever run on the parents portal ──────────────────────
  var p = location.pathname;
  var onParents = (p === '/welcome' || p.indexOf('/welcome/') === 0 || p === '/' ||
                   location.hostname.indexOf('parents.') === 0);
  if (!onParents) return;

  var GREEN = '#2d5a4a';

  // ── 1. Head tags ────────────────────────────────────────────────────────────
  function head() { return document.head || document.getElementsByTagName('head')[0]; }
  function ensureLink(rel, href, extra) {
    if (document.querySelector('link[rel="' + rel + '"]')) return;
    var l = document.createElement('link'); l.rel = rel; l.href = href;
    if (extra) Object.keys(extra).forEach(function (k) { l.setAttribute(k, extra[k]); });
    head().appendChild(l);
  }
  function ensureMeta(name, content) {
    if (document.querySelector('meta[name="' + name + '"]')) return;
    var m = document.createElement('meta'); m.name = name; m.content = content; head().appendChild(m);
  }
  ensureLink('manifest', '/manifest.webmanifest');
  ensureLink('apple-touch-icon', '/icons/apple-touch-icon.png');
  ensureMeta('theme-color', GREEN);
  ensureMeta('apple-mobile-web-app-capable', 'yes');
  ensureMeta('apple-mobile-web-app-status-bar-style', 'black-translucent');
  ensureMeta('apple-mobile-web-app-title', 'LA Parents');
  ensureMeta('mobile-web-app-capable', 'yes');

  // ── 2. Service worker ─────────────────────────────────────────────────────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function (e) {
        console.warn('[pwa] SW registration failed:', e && e.message);
      });
    });
  }

  // ── Styles (prefixed lap- to avoid clashing with page CSS) ──────────────────
  var css = '' +
    /* keep top nav usable on small screens — scroll instead of wrap/overflow */
    '@media(max-width:768px){' +
      '.nav-links{flex-wrap:nowrap !important;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;max-width:100%}' +
      '.nav-links::-webkit-scrollbar{display:none}' +
      '.nav-link{white-space:nowrap;flex:0 0 auto}' +
      'body{padding-bottom:calc(58px + env(safe-area-inset-bottom,0px))}' +
      '.lap-bn{display:flex}' +
    '}' +
    /* z-index kept below page modals (records 200 / resources preview 100) so an open
       modal correctly covers the bottom nav; well above normal page content. */
    '.lap-bn{position:fixed;left:0;right:0;bottom:0;z-index:90;display:none;' +
      'background:' + GREEN + ';box-shadow:0 -2px 10px rgba(0,0,0,.18);' +
      'padding-bottom:env(safe-area-inset-bottom,0px)}' +
    '.lap-bn a,.lap-bn button{flex:1;background:none;border:0;cursor:pointer;' +
      'color:rgba(255,255,255,.78);text-decoration:none;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;gap:2px;min-height:54px;font:600 .66rem/1 Nunito,system-ui,sans-serif;padding:6px 2px}' +
    '.lap-bn a.lap-active{color:#fff}' +
    '.lap-bn a.lap-active .lap-i{transform:translateY(-1px)}' +
    '.lap-bn .lap-i{font-size:1.35rem;line-height:1}' +
    /* the More sheet only opens when no page modal is present, so it sits above the
       sticky top nav (z-index 100) to fully cover the page while open. */
    '.lap-sheet{position:fixed;inset:0;z-index:500;display:none;background:rgba(15,30,25,.55)}' +
    '.lap-sheet.lap-open{display:block}' +
    '.lap-sheet-card{position:absolute;left:0;right:0;bottom:0;background:#fefcf8;' +
      'border-radius:18px 18px 0 0;padding:10px 16px calc(20px + env(safe-area-inset-bottom,0px));' +
      'max-height:80vh;overflow-y:auto;box-shadow:0 -6px 24px rgba(0,0,0,.25)}' +
    '.lap-sheet-grip{width:40px;height:4px;background:#d8d0c0;border-radius:3px;margin:6px auto 12px}' +
    '.lap-sheet h4{font:700 1rem/1.2 "Crimson Pro",Georgia,serif;color:' + GREEN + ';margin:0 0 12px;text-align:center}' +
    '.lap-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}' +
    '.lap-grid a{display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 6px;' +
      'border:1px solid #e8e0d0;border-radius:12px;background:#fff;color:#2a2a2a;text-decoration:none;' +
      'font:600 .72rem/1.2 Nunito,system-ui,sans-serif;text-align:center;min-height:74px;justify-content:center}' +
    '.lap-grid a .lap-i{font-size:1.5rem}' +
    '.lap-grid a.lap-active{border-color:' + GREEN + ';background:#f0f8f5;color:' + GREEN + '}' +
    '.lap-install{position:fixed;left:12px;right:12px;bottom:70px;z-index:95;display:none;' +
      'background:#fff;border:1px solid #e8e0d0;border-left:4px solid #f0a050;border-radius:12px;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.18);padding:12px 14px;align-items:center;gap:12px;' +
      'font:600 .85rem/1.4 Nunito,system-ui,sans-serif;color:#2a2a2a}' +
    '.lap-install.lap-show{display:flex}' +
    '.lap-install .lap-ico{font-size:1.6rem}' +
    '.lap-install .lap-txt{flex:1}' +
    '.lap-install .lap-txt small{display:block;color:#5a5a5a;font-weight:500}' +
    '.lap-install button{border:0;border-radius:9px;padding:9px 14px;font:700 .8rem Nunito,sans-serif;cursor:pointer;min-height:40px}' +
    '.lap-install .lap-go{background:' + GREEN + ';color:#fff}' +
    '.lap-install .lap-no{background:transparent;color:#8a8a8a;padding:9px 6px}' +
    '@media(min-width:769px){.lap-install{left:auto;right:20px;bottom:20px;max-width:380px}}';

  // ── Nav model ────────────────────────────────────────────────────────────────
  var PRIMARY = [
    { href: '/welcome',                  i: '🏠', t: 'Home' },
    { href: '/welcome/learning-journey', i: '🌱', t: 'Journey' },
    { href: '/welcome/diary',            i: '📔', t: 'Diary' },
    { href: '/welcome/menu',             i: '🍽', t: 'Menu' }
  ];
  var ALL = [
    { href: '/welcome',                  i: '🏠', t: 'Home' },
    { href: '/welcome/learning-journey', i: '🌱', t: 'Learning Journey' },
    { href: '/welcome/diary',            i: '📔', t: 'Diary' },
    { href: '/welcome/baby-log',         i: '🍼', t: 'Baby Log' },
    { href: '/welcome/memory-box',       i: '💝', t: 'Memory Box' },
    { href: '/welcome/planning',         i: '📚', t: 'Planning' },
    { href: '/welcome/phonics',          i: '🔤', t: 'Phonics' },
    { href: '/welcome/study',            i: '🎓', t: 'Study' },
    { href: '/welcome/resources',        i: '📁', t: 'Resources' },
    { href: '/welcome/records',          i: '🗂️', t: 'Records' },
    { href: '/welcome/menu',             i: '🍽', t: 'Menu' },
    { href: '/welcome/surveys',          i: '📝', t: 'Surveys' },
    { href: '/welcome/newsletter',       i: '📰', t: 'Newsletter' },
    { href: '/welcome/payments',         i: '💳', t: 'Payments' }
  ];
  function isActive(href) {
    if (href === '/welcome') return p === '/welcome' || p === '/';
    return p === href || p.indexOf(href + '/') === 0;
  }

  function build() {
    if (document.querySelector('.lap-bn')) return;       // idempotent
    var style = document.createElement('style'); style.textContent = css; head().appendChild(style);

    var primaryActive = PRIMARY.some(function (n) { return isActive(n.href); });

    // bottom nav
    var bn = document.createElement('nav'); bn.className = 'lap-bn'; bn.setAttribute('aria-label', 'Primary');
    bn.innerHTML = PRIMARY.map(function (n) {
      return '<a href="' + n.href + '"' + (isActive(n.href) ? ' class="lap-active"' : '') +
             '><span class="lap-i">' + n.i + '</span><span>' + n.t + '</span></a>';
    }).join('') +
      '<button type="button" id="lap-more"' + (!primaryActive ? ' class="lap-active"' : '') +
      ' aria-label="More"><span class="lap-i">☰</span><span>More</span></button>';
    document.body.appendChild(bn);

    // more sheet
    var sheet = document.createElement('div'); sheet.className = 'lap-sheet'; sheet.id = 'lap-sheet';
    sheet.innerHTML = '<div class="lap-sheet-card" role="dialog" aria-label="All sections">' +
      '<div class="lap-sheet-grip"></div><h4>All sections</h4><div class="lap-grid">' +
      ALL.map(function (n) {
        return '<a href="' + n.href + '"' + (isActive(n.href) ? ' class="lap-active"' : '') +
               '><span class="lap-i">' + n.i + '</span><span>' + n.t + '</span></a>';
      }).join('') + '</div></div>';
    document.body.appendChild(sheet);

    function openSheet() { sheet.classList.add('lap-open'); }
    function closeSheet() { sheet.classList.remove('lap-open'); }
    document.getElementById('lap-more').addEventListener('click', openSheet);
    sheet.addEventListener('click', function (e) { if (e.target === sheet) closeSheet(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
  }

  // ── 3. Install banner + iOS hint ───────────────────────────────────────────
  function installUI() {
    if (localStorage.getItem('lap.install.dismissed') === '1') return;
    var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (standalone) return;

    var banner = document.createElement('div'); banner.className = 'lap-install'; banner.id = 'lap-install';
    var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;

    function dismiss() { banner.classList.remove('lap-show'); localStorage.setItem('lap.install.dismissed', '1'); }

    if (isIOS) {
      banner.innerHTML = '<span class="lap-ico">📲</span><div class="lap-txt">Add Your Nursery to your Home Screen' +
        '<small>Tap the Share icon, then “Add to Home Screen”.</small></div>' +
        '<button class="lap-no" id="lap-no">Got it</button>';
      document.body.appendChild(banner);
      document.getElementById('lap-no').addEventListener('click', dismiss);
      setTimeout(function () { banner.classList.add('lap-show'); }, 1500);
      return;
    }

    var deferred = null;
    document.body.appendChild(banner);
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault(); deferred = e;
      banner.innerHTML = '<span class="lap-ico">📲</span><div class="lap-txt">Install the Your Nursery app' +
        '<small>Quick access from your Home Screen.</small></div>' +
        '<button class="lap-go" id="lap-go">Install</button><button class="lap-no" id="lap-no">Not now</button>';
      banner.classList.add('lap-show');
      document.getElementById('lap-no').addEventListener('click', dismiss);
      document.getElementById('lap-go').addEventListener('click', function () {
        banner.classList.remove('lap-show');
        if (deferred) { deferred.prompt(); deferred.userChoice.finally(function () { deferred = null; localStorage.setItem('lap.install.dismissed', '1'); }); }
      });
    });
    window.addEventListener('appinstalled', function () { dismiss(); });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────
  function boot() { build(); installUI(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
