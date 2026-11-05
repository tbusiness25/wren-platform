/* wren-whats-new.js — the "What's new" popup (2026-10-09).
 * Loaded by wren-shell-v2.js (Roost), wren-app-shell.js (EY, HR) and the Parents app home.
 * Asks for the newest update meant for this portal that this person hasn't dismissed, and
 * shows it once. "Got it" records that; closing with × or Esc only hides it for this page
 * view, so it comes back next time until someone actually reads it. */
(function () {
  'use strict';
  if (window.__wrenWhatsNewLoaded) return;
  window.__wrenWhatsNewLoaded = true;

  var isParents = location.pathname.indexOf('/welcome') === 0;
  var BASE = isParents ? '/welcome/whats-new/api' : '/api/whats-new';

  function _rawHeaders(extra) {
    // Fallback path only (Wren.api unavailable) — still send the device token
    // directly so an EY tablet doesn't 403 with device_required here either.
    var h = Object.assign({}, extra || {});
    try {
      var t = sessionStorage.getItem('wrenToken');
      if (t) h.Authorization = 'Bearer ' + t;
      var d = localStorage.getItem('wrenDevice');
      if (d) h['X-Wren-Device'] = d;
    } catch (e) { /* ignore */ }
    return h;
  }
  function get(url) {
    if (!isParents && window.Wren && typeof Wren.api === 'function') return Wren.api(url);
    return fetch(url, { credentials: 'same-origin', headers: isParents ? {} : _rawHeaders() })
      .then(function (r) { return r.ok ? r.json() : null; });
  }
  function post(url) {
    if (!isParents && window.Wren && typeof Wren.api === 'function') return Wren.api(url, { method: 'POST' });
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: isParents ? { 'Content-Type': 'application/json' } : _rawHeaders({ 'Content-Type': 'application/json' }), body: '{}' });
  }
  function fmt(d) {
    try { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }); }
    catch (_) { return ''; }
  }

  function css() {
    if (document.getElementById('wwn-style')) return;
    var s = document.createElement('style');
    s.id = 'wwn-style';
    s.textContent =
      // b496 — var() fallback chains also try the Parents app's own token names
      // (--surface/--text/--border/--text-m/--green/--orange, set by parents-app.css
      // and themed via data-lap-theme) before the hard literal: on Roost/EY the
      // first --c-* var always resolves so nothing changes there, but on /welcome
      // this modal used to ignore dark mode entirely and show hard-coded white.
      '.wwn-back{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:99990;display:flex;align-items:center;justify-content:center;padding:16px}' +
      '.wwn-card{background:var(--c-surface,var(--surface,#ffffff));color:var(--c-text,var(--text,#1f2937));border:1px solid var(--c-border,var(--border,#e5e7eb));border-radius:16px;' +
      'max-width:620px;width:100%;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.35);font-family:inherit}' +
      '.wwn-head{padding:18px 20px 10px;display:flex;gap:12px;align-items:flex-start}' +
      '.wwn-badge{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--c-orange,var(--orange-d,#e07820))}' +
      '.wwn-title{font-size:19px;font-weight:800;margin:2px 0 0;line-height:1.3}' +
      '.wwn-date{font-size:12px;color:var(--c-muted,var(--text-m,#6b7280));margin-top:3px}' +
      '.wwn-x{margin-left:auto;background:none;border:0;font-size:22px;line-height:1;color:var(--c-muted,var(--text-m,#6b7280));cursor:pointer;padding:4px 8px}' +
      '.wwn-body{padding:4px 20px 8px;overflow:auto;font-size:14.5px;line-height:1.6}' +
      '.wwn-body h3{font-size:15px;margin:16px 0 6px}.wwn-body ul{margin:4px 0 8px;padding-left:20px}.wwn-body li{margin:3px 0}' +
      '.wwn-body p{margin:6px 0}' +
      '.wwn-body .wu-pill{display:inline-block;font-size:11px;font-weight:700;padding:1px 8px;border-radius:999px;vertical-align:middle;margin-left:6px}' +
      '.wwn-body .wu-pill.live{background:rgba(16,185,129,.15);color:var(--c-ok,var(--success,#047857))}.wwn-body .wu-pill.soon{background:rgba(224,120,32,.15);color:var(--c-warn,var(--orange-d,#b45309))}' +
      '.wwn-foot{padding:12px 20px 18px;display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;border-top:1px solid var(--c-border,var(--border,#e5e7eb))}' +
      '.wwn-btn{border-radius:10px;padding:10px 18px;font-weight:700;font-size:14px;cursor:pointer;border:1px solid var(--c-border,var(--border,#d1d5db));background:transparent;color:inherit;text-decoration:none}' +
      '.wwn-btn.primary{background:var(--c-blue,var(--green,#4a9abf));border-color:var(--c-blue,var(--green,#4a9abf));color:var(--c-on-blue,var(--lap-on-accent,#fff))}';
      // b496 — dropped the old `@media (prefers-color-scheme: dark)` block: Wren's
      // theme is an explicit app-level choice (data-wren-theme / data-lap-theme),
      // never OS preference, and the var() chains above already resolve correctly
      // per theme on every portal. The media query could fire opposite to the
      // app's actual theme (OS dark + app light, or vice versa) and repaint this
      // modal out of sync with the page around it.
    document.head.appendChild(s);
  }

  function show(u) {
    css();
    var back = document.createElement('div');
    back.className = 'wwn-back';
    back.setAttribute('role', 'dialog');
    back.setAttribute('aria-modal', 'true');
    back.setAttribute('aria-labelledby', 'wwn-title');
    var allLink = !isParents && document.body && location.hostname.indexOf('admin.') === 0
      ? '<a class="wwn-btn" href="/wren-updates.html">See all updates</a>' : '';
    back.innerHTML =
      '<div class="wwn-card">' +
        '<div class="wwn-head"><div><div class="wwn-badge">✨ What\'s new</div>' +
        '<h2 class="wwn-title" id="wwn-title"></h2><div class="wwn-date"></div></div>' +
        '<button class="wwn-x" type="button" aria-label="Close">×</button></div>' +
        '<div class="wwn-body"></div>' +
        '<div class="wwn-foot">' + allLink + '<button class="wwn-btn primary" type="button">Got it</button></div>' +
      '</div>';
    back.querySelector('.wwn-title').textContent = u.title || "What's new";
    back.querySelector('.wwn-date').textContent = u.published_at ? fmt(u.published_at) : '';
    back.querySelector('.wwn-body').innerHTML = u.html || '';   // rendered + escaped server-side
    function close() { document.removeEventListener('keydown', onKey); back.remove(); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    back.querySelector('.wwn-x').addEventListener('click', close);
    back.querySelector('.wwn-btn.primary').addEventListener('click', function () {
      post(BASE + '/' + encodeURIComponent(u.id) + '/seen').catch(function () {});
      close();
    });
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(back);
    var btn = back.querySelector('.wwn-btn.primary'); if (btn) btn.focus();
  }

  function run() {
    // Don't pop over the login screen or an embedded frame.
    if (/login/i.test(location.pathname) || window.top !== window.self) return;
    get(BASE + '/popup').then(function (d) { if (d && d.update) show(d.update); }).catch(function () {});
  }
  setTimeout(run, 1500);
})();
