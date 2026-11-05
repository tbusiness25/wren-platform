/* welcome-msg-badge.js (2026-08-04)
 * Parents (Egg) portal: surface unread messages as a badge on the "Messages"
 * nav link across every /welcome/* page. Self-contained + defensive: mints the
 * parent token via CF Access (same flow the messages page uses) and, if that
 * fails, silently does nothing (no nav change, no errors). Additive — never
 * rewrites the nav, only appends one <span> to the existing Messages link.
 */
(function () {
  'use strict';
  function attach(count) {
    if (!count || count < 1) return;
    var links = document.querySelectorAll('a.nav-link[href="/welcome/messages"], a[href="/welcome/messages"]');
    links.forEach(function (a) {
      if (a.querySelector('.welcome-msg-badge')) {
        a.querySelector('.welcome-msg-badge').textContent = count > 99 ? '99+' : String(count);
        return;
      }
      var b = document.createElement('span');
      b.className = 'welcome-msg-badge';
      b.setAttribute('aria-label', count + ' unread messages');
      b.textContent = count > 99 ? '99+' : String(count);
      b.style.cssText = 'display:inline-block;margin-left:6px;min-width:18px;padding:1px 6px;' +
        'border-radius:999px;background:#e8734a;color:#fff;font-size:.7rem;font-weight:800;' +
        'text-align:center;vertical-align:middle;line-height:16px';
      a.appendChild(b);
    });
  }

  function poll(token) {
    fetch('/api/messages/threads', { headers: { 'Authorization': 'Bearer ' + token } })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        var n = (Array.isArray(rows) ? rows : []).reduce(function (a, t) {
          return a + (parseInt(t.unread_count, 10) || 0);
        }, 0);
        attach(n);
      })
      .catch(function () {});
  }

  function boot() {
    // b339 (2026-09-18): the parents shell keeps ONE token per tab (cf-auto-login is rate-limited
    // to 5 a minute, and the bell in the top bar needs one too) — take it from there when present.
    if (window.LapShell && LapShell.token) {
      LapShell.token().then(function (t) {
        if (!t) return;
        poll(t);
        setInterval(function () { poll(t); }, 60000);
      });
      return;
    }
    // Reuse a token the page already minted if present, else mint one.
    if (window.TOKEN) { poll(window.TOKEN); setInterval(function () { poll(window.TOKEN); }, 60000); return; }
    fetch('/api/auth/cf-auto-login', { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.token) return;
        poll(j.token);
        setInterval(function () { poll(j.token); }, 60000);
      })
      .catch(function () {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}());
