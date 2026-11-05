/* wren-deadline-banner.js — 28 Oct 2026
 *
 * Toby, after the November invoices did not go out: "When things like this go
 * past due date I need a banner reminder."
 *
 * A strip at the top of every Roost page, for managers, showing whatever
 * GET /api/signals/banners returns — the deadline signals a manager has chosen
 * (Roost → Signals → "Show as a banner"). Invoices are on by default.
 *
 * Same two rules as wren-attention-lights.js:
 *   1. One call, fired after paint; nothing waits on it.
 *   2. Failure renders nothing. A 403, a missing route or a network error and
 *      the strip simply is not there.
 *
 * "Hide for today" is per browser and per finding: it comes back tomorrow, and
 * straight away if the finding changes (a new fingerprint).
 *
 * Usage: WrenDeadlineBanner.mount(containerElement)   — strip is prepended to it
 */
(function () {
  'use strict';

  var ENDPOINT = '/api/signals/banners';
  var CSS_ID = 'wren-deadline-banner-css';
  var CSS = [
    '.wdb-wrap{display:flex;flex-direction:column;gap:8px;margin:0 0 14px}',
    '.wdb{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:11px 14px;border-radius:12px;',
    '  border:1px solid var(--c-border-strong);border-left:5px solid var(--c-warn);',
    '  background:var(--c-tint-amber);color:var(--c-text);',
    '  font-size:.9rem;line-height:1.45}',
    '.wdb.overdue{border-left-color:var(--c-danger);',
    '  background:var(--c-tint-red)}',
    '.wdb .wdb-ico{font-size:1.15rem;line-height:1}',
    '.wdb .wdb-txt{flex:1 1 260px;min-width:0}',
    '.wdb .wdb-txt b{display:block;font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;color:var(--c-muted);margin-bottom:2px}',
    '.wdb.overdue .wdb-txt b{color:var(--c-danger)}',
    '.wdb .wdb-acts{display:flex;gap:8px;flex-wrap:wrap}',
    '.wdb a.wdb-go,.wdb button{font:inherit;font-size:.82rem;font-weight:700;border-radius:8px;padding:6px 12px;cursor:pointer;text-decoration:none}',
    '.wdb a.wdb-go{background:var(--c-blue);color:var(--c-on-blue);border:1px solid var(--c-blue)}',
    '.wdb button{background:transparent;color:var(--c-text);border:1px solid var(--c-border-strong)}',
  ].join('\n');

  function css() {
    if (document.getElementById(CSS_ID)) return;
    var st = document.createElement('style');
    st.id = CSS_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function token() {
    try { return sessionStorage.getItem('wrenToken') || localStorage.getItem('wrenToken') || ''; } catch (e) { return ''; }
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }
  function hideKey(b) { return 'wrenBannerHide:' + b.key + ':' + (b.fingerprint || '') + ':' + today(); }
  function hidden(b) { try { return localStorage.getItem(hideKey(b)) === '1'; } catch (e) { return false; } }
  function hide(b) { try { localStorage.setItem(hideKey(b), '1'); } catch (e) { /* the strip still goes for this page */ } }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function render(host, banners) {
    var show = banners.filter(function (b) { return !hidden(b); });
    var old = document.getElementById('wren-deadline-banners');
    if (old) old.remove();
    if (!show.length) return;
    css();
    var wrap = document.createElement('div');
    wrap.id = 'wren-deadline-banners';
    wrap.className = 'wdb-wrap';
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', 'Deadlines');
    show.forEach(function (b) {
      var el = document.createElement('div');
      el.className = 'wdb' + (b.overdue ? ' overdue' : '');
      el.setAttribute('role', 'alert');
      el.innerHTML =
        '<span class="wdb-ico" aria-hidden="true">' + (b.overdue ? '⚠️' : '⏰') + '</span>' +
        '<div class="wdb-txt"><b>' + (b.overdue ? 'Past due' : 'Coming up') + '</b>' + esc(b.headline) + '</div>' +
        '<div class="wdb-acts">' +
          (b.link ? '<a class="wdb-go" href="' + esc(b.link) + '">Open</a>' : '') +
          '<button type="button" data-hide>Hide for today</button>' +
        '</div>';
      el.querySelector('[data-hide]').addEventListener('click', function () {
        hide(b);
        el.remove();
        if (!wrap.children.length) wrap.remove();
      });
      wrap.appendChild(el);
    });
    host.insertBefore(wrap, host.firstChild);
  }

  function mount(host) {
    if (!host) return;
    var t = token();
    if (!t) return;
    fetch(ENDPOINT, { headers: { Authorization: 'Bearer ' + t }, credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { render(host, (d && d.banners) || []); })
      .catch(function () { /* nothing renders, by design */ });
  }

  window.WrenDeadlineBanner = { mount: mount };
})();
