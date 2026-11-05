/* wren-install.js — "put this app on your Home Screen" for the staff portals (Seed / Nest / Roost).
 *
 * 2026-11-01 (Toby: "some of the staff on iOS didn't have Seed popping up as installable").
 * Nothing was broken on the server: Seed's manifest, icons and service worker all load. An iPhone
 * simply never offers to install a web app — there is no prompt, only Share → Add to Home Screen —
 * and the staff portals had no pop-up saying so (only the parents app had one, in
 * editions/parents/public/pwa.js; this is the staff copy of that, as a slim bar rather than a modal
 * because staff hit it on the sign-in page).
 *
 *   • Chrome/Edge/Samsung with the browser's install offer ready → "Install" runs the real prompt.
 *   • iPhone/iPad (Safari, Chrome, Edge, Firefox) → the Share-sheet steps.
 *   • In-app browsers (WhatsApp, Gmail, Facebook…) → "open it in your browser first".
 *   • Already running from the Home Screen → never shown.
 * "✕" hides it for 14 days; "Done" / an accepted install hides it for good on this browser.
 * WrenInstall.open() shows the steps on demand (e.g. from a menu row).
 *
 * Loaded by the three login pages and injected by wren-app-shell.js / wren-shell-v2.js;
 * idempotent, no dependencies, every path swallows its own errors.
 */
(function () {
  'use strict';
  if (window.WrenInstall) return;
  try { if (window.self !== window.top) return; } catch (e) { return; }   // never inside a frame

  var DONE = 'wren.install.done', SNOOZE = 'wren.install.snooze';
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function standalone() {
    try { if (window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches) return true; } catch (e) {}
    return window.navigator.standalone === true;
  }

  function appName() {
    var h = location.hostname, ed = (document.querySelector('meta[name="wren-edition"]') || {}).content || '';
    if (ed === 'hr' || ed === 'ladn-hr' || /^(hr|[a-z]+-hr|ht-seed)\./.test(h)) return 'Seed';
    if (ed === 'admin' || /^(admin|[a-z]+-admin|ht-roost)\./.test(h)) return 'Roost';
    if (ed === 'ladn' || ed === 'learning' || ed === 'eyfs' || /^(ey|ht-nest)\./.test(h) || location.pathname.indexOf('/ey/') === 0) return 'Nest';
    return 'Wren';
  }
  // What the icon will actually be called on the Home Screen (iOS takes the apple title, others the manifest).
  function homeLabel() {
    var m = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    return (m && m.content) || appName();
  }

  var deferred = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); deferred = e;
    var go = document.querySelector('#wren-install-bar [data-act="how"]');
    if (go) go.textContent = 'Install';
  });
  window.addEventListener('appinstalled', function () { lsSet(DONE, '1'); close(); });

  function steps() {
    var ua = navigator.userAgent || '', label = homeLabel();
    var iOS = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    if (/FBAN|FBAV|Instagram|Line\/|GSA\/|WhatsApp|; wv\)/i.test(ua)) return { inApp: true, list: [
      'Tap the <b>⋮</b> or <b>…</b> menu at the top of this screen.',
      'Choose <b>Open in browser</b> (or <b>Open in Safari / Chrome</b>).',
      'Then come back to this page and follow the steps there.'] };
    if (iOS) {
      var where = /CriOS|EdgiOS/.test(ua) ? 'next to the address bar (top right)'
                : /FxiOS/.test(ua) ? 'in the <b>☰</b> menu'
                : 'at the bottom of Safari (on iPad: top right)';
      return { list: [
        'Tap the <b>Share</b> button <span aria-hidden="true">(□↑)</span> ' + where + '.',
        'Scroll down and tap <b>Add to Home Screen</b>. (Not there? Tap <b>Edit Actions</b> at the bottom and add it.)',
        'Make sure <b>Open as Web App</b> is on, then tap <b>Add</b>.',
        'From now on open <b>' + label + '</b> from your Home Screen. You sign in once more there.'] };
    }
    if (/SamsungBrowser/i.test(ua)) return { list: [
      'Tap the <b>☰</b> menu at the bottom right.',
      'Tap <b>Add page to</b>, then <b>Home screen</b>.',
      'Open <b>' + label + '</b> from that icon from now on.'] };
    if (/Firefox/i.test(ua)) return { list: [
      'Tap the <b>⋮</b> menu.', 'Tap <b>Install</b> (or <b>Add to Home screen</b>).',
      'Open <b>' + label + '</b> from that icon from now on.'] };
    if (/Android/i.test(ua)) return { list: [
      'Tap the <b>⋮</b> menu at the top right.',
      'Tap <b>Install app</b> (or <b>Add to Home screen</b>, then <b>Install</b>).',
      'Open <b>' + label + '</b> from that icon from now on.'] };
    return { list: [
      'In the address bar, click the <b>install</b> icon (a screen with a down arrow), or open the browser menu.',
      'Choose <b>Install ' + appName() + '</b> (Edge: <b>Apps → Install this site as an app</b>; Safari on Mac: <b>File → Add to Dock</b>).',
      'Open it from your dock or start menu from now on.'] };
  }

  var CSS =
    '#wren-install-bar{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:9400;' +
    'display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:14px;background:#0f172a;color:#fff;' +
    'box-shadow:0 8px 28px rgba(0,0,0,.28);font:500 14px/1.3 "DM Sans",system-ui,sans-serif;max-width:520px;margin:0 auto}' +
    'body.wren-app-shell:not(.no-bottom-nav) #wren-install-bar{bottom:calc(76px + env(safe-area-inset-bottom,0px))}' +
    '#wren-install-bar img{width:36px;height:36px;border-radius:9px;flex:none}' +
    '#wren-install-bar .wi-t{flex:1;min-width:0}#wren-install-bar .wi-t small{display:block;opacity:.75;font-weight:400}' +
    '#wren-install-bar button{border:0;border-radius:10px;min-height:40px;min-width:40px;padding:0 14px;font:700 14px "DM Sans",system-ui,sans-serif;cursor:pointer}' +
    '#wren-install-bar .wi-go{background:#38bdf8;color:#0f172a}#wren-install-bar .wi-x{background:transparent;color:#fff;opacity:.8;padding:0 8px;font-size:18px}' +
    '#wren-install-sheet{position:fixed;inset:0;z-index:9450;background:rgba(15,23,42,.55);display:flex;align-items:flex-end;justify-content:center}' +
    '#wren-install-sheet .wi-card{background:#fff;color:#0f172a;width:100%;max-width:520px;border-radius:18px 18px 0 0;' +
    'padding:20px 20px calc(20px + env(safe-area-inset-bottom,0px));font:400 15px/1.45 "DM Sans",system-ui,sans-serif;max-height:90vh;overflow:auto}' +
    '@media(min-width:600px){#wren-install-sheet{align-items:center}#wren-install-sheet .wi-card{border-radius:18px}}' +
    '#wren-install-sheet h2{margin:0 0 6px;font:700 19px/1.25 "DM Sans",system-ui,sans-serif}' +
    '#wren-install-sheet ol{margin:12px 0 16px;padding-left:22px}#wren-install-sheet li{margin:0 0 8px}' +
    '#wren-install-sheet .wi-acts{display:flex;gap:10px;flex-wrap:wrap}' +
    '#wren-install-sheet button{border:0;border-radius:10px;min-height:44px;padding:0 18px;font:700 15px "DM Sans",system-ui,sans-serif;cursor:pointer}' +
    '#wren-install-sheet .wi-go{background:#0f172a;color:#fff}#wren-install-sheet .wi-later{background:#e2e8f0;color:#0f172a}';

  function css() {
    if (document.getElementById('wren-install-css')) return;
    var s = document.createElement('style'); s.id = 'wren-install-css'; s.textContent = CSS;
    document.head.appendChild(s);
  }
  function close() {
    ['wren-install-bar', 'wren-install-sheet'].forEach(function (id) { var el = document.getElementById(id); if (el) el.remove(); });
  }

  function sheet() {
    css();
    var old = document.getElementById('wren-install-sheet'); if (old) old.remove();
    var how = steps(), name = appName();
    var box = document.createElement('div'); box.id = 'wren-install-sheet';
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'wren-install-h');
    box.innerHTML = '<div class="wi-card">' +
      '<h2 id="wren-install-h">' + (how.inApp ? 'Open this in your browser first' : 'Put ' + name + ' on your Home Screen') + '</h2>' +
      '<div>It opens like an app — full screen, one tap, and it can send you notifications.</div>' +
      '<ol>' + how.list.map(function (t) { return '<li>' + t + '</li>'; }).join('') + '</ol>' +
      '<div class="wi-acts">' +
        (how.inApp ? '<button type="button" class="wi-go" data-act="later">OK</button>'
                   : '<button type="button" class="wi-go" data-act="done">Done, it\'s on my Home Screen</button>' +
                     '<button type="button" class="wi-later" data-act="later">Not now</button>') +
      '</div></div>';
    document.body.appendChild(box);
    var f = box.querySelector('.wi-go'); if (f) f.focus();
    box.addEventListener('click', function (e) {
      var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
      if (e.target === box) act = 'later';
      if (act === 'done') { lsSet(DONE, '1'); close(); }
      else if (act === 'later') { lsSet(SNOOZE, String(Date.now() + 14 * 864e5)); close(); }
    });
  }

  function install() {
    if (!deferred) return sheet();
    var d = deferred; deferred = null;
    d.prompt();
    d.userChoice.then(function (c) {
      if (c && c.outcome === 'accepted') { lsSet(DONE, '1'); close(); }
    }).catch(function () {});
  }

  function bar() {
    if (standalone() || document.getElementById('wren-install-bar') || !document.body) return;
    if (lsGet(DONE) === '1') return;
    var until = Number(lsGet(SNOOZE) || 0);
    if (until && Date.now() < until) return;
    css();
    var el = document.createElement('div'); el.id = 'wren-install-bar'; el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Install the app');
    el.innerHTML = '<img src="/icons/icon-192.png" alt="">' +
      '<div class="wi-t">Use ' + appName() + ' as an app<small>Add it to your Home Screen</small></div>' +
      '<button type="button" class="wi-go" data-act="how">' + (deferred ? 'Install' : 'How?') + '</button>' +
      '<button type="button" class="wi-x" data-act="x" aria-label="Not now">✕</button>';
    el.addEventListener('click', function (e) {
      var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'how') install();
      else if (act === 'x') { lsSet(SNOOZE, String(Date.now() + 14 * 864e5)); close(); }
    });
    document.body.appendChild(el);
  }

  // Sign-in page and each portal's home only — not over a form someone is half-way through.
  function onEntryPage() {
    var p = location.pathname.replace(/\/+$/, '') || '/';
    return /^\/(login(\.html)?|index\.html|app\.html|ey\/home|hr\/?)?$/.test(p) || p === '/' ||
           /^\/admin\/cockpit/.test(p);
  }

  window.WrenInstall = { open: function () { if (standalone()) return; sheet(); }, show: bar };
  if (standalone()) { lsSet(DONE, '1'); return; }
  if (!onEntryPage()) return;
  function boot() { setTimeout(bar, 1500); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
