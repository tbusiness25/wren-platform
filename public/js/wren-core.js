/* wren-core.js v20260515
 * Shared Wren API — loaded by wren-app-shell.js and (future) wren-shell-v2.js.
 * Defines window.Wren: api, toast, modal, confirm, drawer, actionSheet, logout, etc.
 * No shell chrome here — only helpers shared across all shell variants.
 */
;(function () {
  'use strict';

  window.Wren = window.Wren || {};
  const W = window.Wren;

  const TOKEN_KEY = 'wrenToken';
  const USER_KEY  = 'wrenUser';

  W.edition   = document.querySelector('meta[name="wren-edition"]')?.content || 'ladn';
  W.TOKEN_KEY = TOKEN_KEY;
  W.USER_KEY  = USER_KEY;


  // ── device_required — make the silent 403 impossible to miss ─────────────────
  // The EY portal gates the WHOLE /api prefix on an enrolment token
  // (server-unified.js `app.use('/api', _deviceGate(...))`). Until 2026-09-04
  // nothing in the frontend looked at that 403, so a tablet whose token had been
  // cleared just... stopped working: pages rendered empty, diary entries looked
  // saved and were not, photos vanished after upload. Five tablets sat like that
  // for five weeks and it was reported as "diaries not saving".
  // A save that is not happening must never look like a save that happened.
  function wrenShowDeviceBlocked() {
    if (document.getElementById('wren-device-blocked')) return;   // once per page
    var bar = document.createElement('div');
    bar.id = 'wren-device-blocked';
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
      'background:#b91c1c;color:#fff;padding:14px 18px;font:600 15px/1.45 system-ui,sans-serif;' +
      'box-shadow:0 2px 12px rgba(0,0,0,.35);display:flex;gap:14px;align-items:center;' +
      'flex-wrap:wrap;justify-content:center;text-align:center';
    bar.innerHTML =
      '<span>⚠️ This device is not set up for Wren — <u>nothing you save here is being kept</u>.</span>' +
      '<a href="/ey/enrol-device" style="background:#fff;color:#b91c1c;padding:7px 14px;' +
      'border-radius:8px;text-decoration:none;font-weight:700;white-space:nowrap">Set this device up</a>' +
      '<span style="font-weight:400;opacity:.9">A manager or deputy needs to sign in on this device.</span>';
    (document.body || document.documentElement).appendChild(bar);
    try {
      var pad = parseInt(getComputedStyle(document.body).paddingTop, 10) || 0;
      document.body.style.paddingTop = (pad + bar.offsetHeight) + 'px';
    } catch (_) { /* styling only */ }
  }

  // ── totp_required — same flood as device_required, different gate ────────────
  // weeklybugs-20261030: mirrors wrenShowDeviceBlocked for the two-factor scope gate
  // (server-unified.js b491) — a 'totp_only'/'totp_enroll_required' token 403s every
  // /api call outside /api/auth/*, so W.api callers need the same "once per page" banner.
  // See the fuller comment on wrenShowTotpRequired in wren-shell-v2.js.
  function wrenShowTotpRequired(d) {
    if (document.getElementById('wren-totp-required')) return;
    var bar = document.createElement('div');
    bar.id = 'wren-totp-required';
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
      'background:#b45309;color:#fff;padding:14px 18px;font:600 15px/1.45 system-ui,sans-serif;' +
      'box-shadow:0 2px 12px rgba(0,0,0,.35);display:flex;gap:14px;align-items:center;' +
      'flex-wrap:wrap;justify-content:center;text-align:center';
    bar.innerHTML =
      '<span>' + ((d && d.message) || 'Finish two-factor sign-in before continuing.') + '</span>' +
      '<a href="/totp-setup.html" style="background:#fff;color:#b45309;padding:7px 14px;' +
      'border-radius:8px;text-decoration:none;font-weight:700;white-space:nowrap">Finish set-up</a>';
    (document.body || document.documentElement).appendChild(bar);
    try {
      var pad = parseInt(getComputedStyle(document.body).paddingTop, 10) || 0;
      document.body.style.paddingTop = (pad + bar.offsetHeight) + 'px';
    } catch (_) { /* styling only */ }
  }

  // ── authHeaders — the ONE place Authorization + X-Wren-Device get built ───────
  // b495: raw fetch() calls across ~30 EY-loaded files each rolled their own
  // Authorization-only header object, so none of them sent X-Wren-Device — on an
  // enrolled tablet every one of those calls 403'd with device_required (silently,
  // since only W.api knew to show wrenShowDeviceBlocked()). Anything that can't go
  // through W.api (FormData uploads, blob/image fetches, non-JSON responses) should
  // call Wren.authHeaders() instead of hand-building headers.
  W.authHeaders = function (extra) {
    const token = sessionStorage.getItem(TOKEN_KEY);
    const deviceToken = localStorage.getItem('wrenDevice') || '';
    return Object.assign({},
      token ? { Authorization: 'Bearer ' + token } : {},
      deviceToken ? { 'X-Wren-Device': deviceToken } : {},
      extra || {});
  };

  // ── api — JSON fetch with Bearer token, device token, 401 → logout ────────────────
  W.api = function (url, opts = {}) {
    opts.headers = Object.assign({}, opts.headers, { 'Content-Type': 'application/json' }, W.authHeaders());
    if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    return fetch(url, opts).then(r => {
      if (r.status === 401) { W.logout(); return; }
      if (!r.ok) return r.json().catch(() => ({})).then(d => {
        if (r.status === 403 && d && d.error === 'device_required') wrenShowDeviceBlocked();
        if (r.status === 403 && d && d.error === 'totp_required') wrenShowTotpRequired(d);
        return Promise.reject(d);
      });
      return r.json();
    });
  };

  // ── Token / user storage ──────────────────────────────────────────────────────
  W.showDeviceBlocked = wrenShowDeviceBlocked;

  W.getToken = function () { return sessionStorage.getItem(TOKEN_KEY); };
  W.getUser  = function () {
    try { return JSON.parse(sessionStorage.getItem(USER_KEY)) || null; }
    catch { return null; }
  };
  W.setUser  = function (u) { sessionStorage.setItem(USER_KEY, JSON.stringify(u)); };
  W.logout   = function () {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
    const ret = encodeURIComponent(location.pathname + location.search);
    location.href = '/login.html?return=' + ret;
  };
  // ── confirmLogout — USER-INITIATED sign out (EyLog parity, 2026-07-29) ─────────
  // Signing out is deliberate: always confirm first so a stray tap / Back press
  // can't drop a shared tablet back to the PIN screen. AUTOMATIC logouts (a 401 in
  // W.api, the idle-timeout in the app shell) must keep calling W.logout() directly —
  // do NOT route those through here (nobody is present to click "Yes").
  W.confirmLogout = function (message) {
    return W.confirm(message || 'Are you sure you want to log out?').then(function (ok) {
      if (ok) W.logout();
      return ok;
    });
  };

  // ── navigate — MPA path navigation (consistent cross-shell API) ───────────────
  W.navigate = function (path) { location.href = path; };

  // ── toast — lightweight stacked notification ──────────────────────────────────
  // Verbatim from wren-shell-v2.js
  W.toast = function (message, type = 'info', duration = 3500) {
    let container = document.getElementById('wren-toasts');
    if (!container) {
      container = document.createElement('div');
      container.id = 'wren-toasts';
      document.body.appendChild(container);
    }
    const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
    const toast = document.createElement('div');
    toast.className = `wren-toast wren-toast-${type}`;
    toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span>${message}</span>`;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  };

  // ── modal — returns Promise resolving to button index (or null if dismissed) ──
  // Core logic from wren-shell-v2.js; adapted to return Promise for Wren.confirm.
  W.modal = function (title, content, buttons = []) {
    return new Promise(resolve => {
      document.querySelectorAll('.wren-modal-overlay').forEach(el => el.remove());
      const overlay = document.createElement('div');
      overlay.className = 'wren-modal-overlay';
      const btnHtml = buttons.map((b, i) =>
        `<button class="btn ${b.class || 'btn-ghost'}" data-idx="${i}">${b.label}</button>`
      ).join('');
      overlay.innerHTML = `
        <div class="wren-modal" role="dialog" aria-modal="true" aria-labelledby="wren-modal-title">
          <div class="modal-header">
            <span class="modal-title" id="wren-modal-title">${title}</span>
            <button class="modal-close" aria-label="Close">✕</button>
          </div>
          <div class="modal-body">${typeof content === 'string' ? content : ''}</div>
          ${buttons.length ? `<div class="modal-footer">${btnHtml}</div>` : ''}
        </div>`;
      if (typeof content !== 'string' && content instanceof Element) {
        overlay.querySelector('.modal-body').appendChild(content);
      }
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('open'));

      function _close(idx) {
        overlay.classList.remove('open');
        setTimeout(() => overlay.remove(), 200);
        resolve(idx == null ? null : idx);
      }

      overlay.querySelector('.modal-close').onclick = () => _close(null);
      overlay.addEventListener('click', e => { if (e.target === overlay) _close(null); });
      buttons.forEach((b, i) => {
        overlay.querySelector(`[data-idx="${i}"]`).onclick = () => {
          if (typeof b.action === 'function') b.action();
          if (b.close !== false) _close(i);
        };
      });
    });
  };

  // ── confirm — convenience wrapper ─────────────────────────────────────────────
  W.confirm = function (message) {
    return W.modal('Confirm', message, [
      { label: 'Cancel' },
      { label: 'Yes', class: 'btn-primary' },
    ]).then(i => i === 1);
  };

  // ── drawer — open a slide-in drawer built by app-shell ────────────────────────
  // App-shell creates #wren-app-drawer-left (and -right if needed).
  // Core only opens/closes them by toggling .open class.
  W.drawer = function (side, content) {
    const drawer   = document.getElementById(`wren-app-drawer-${side}`);
    const backdrop = document.getElementById('wren-app-drawer-backdrop');
    if (!drawer) return;
    if (content) {
      const body = drawer.querySelector('.wren-app-drawer-body') || drawer;
      if (typeof content === 'string') body.innerHTML = content;
      else if (content instanceof Element) body.appendChild(content);
    }
    requestAnimationFrame(() => {
      if (backdrop) backdrop.classList.add('open');
      drawer.classList.add('open');
      drawer.setAttribute('aria-hidden', 'false');
    });
  };

  W.closeDrawer = function (side) {
    const sel = side ? `#wren-app-drawer-${side}` : '.wren-app-drawer';
    document.querySelectorAll(sel).forEach(d => {
      d.classList.remove('open');
      d.setAttribute('aria-hidden', 'true');
    });
    const backdrop = document.getElementById('wren-app-drawer-backdrop');
    if (backdrop) backdrop.classList.remove('open');
  };

  // ── actionSheet — open bottom sheet built by app-shell ───────────────────────
  // items: [{icon, label, onClick}]
  W.actionSheet = function (items) {
    const sheet    = document.getElementById('wren-action-sheet');
    const grid     = document.getElementById('wren-action-sheet-grid');
    const backdrop = document.getElementById('wren-action-sheet-backdrop');
    if (!sheet) return;
    if (grid && Array.isArray(items)) {
      grid.innerHTML = items.map((item, i) =>
        `<button class="wren-app-action-sheet-item" data-as-idx="${i}">
          <span class="wren-app-action-sheet-item-icon" aria-hidden="true" data-wren-icon="${(window.WrenIcons && WrenIcons.keyFor(item.label)) || ''}">${item.icon || ''}</span>
          <span>${item.label}</span>
        </button>`
      ).join('');
      if (window.WrenIcons) WrenIcons.hydrate(grid);
      grid.querySelectorAll('[data-as-idx]').forEach(btn => {
        const idx = parseInt(btn.dataset.asIdx, 10);
        btn.addEventListener('click', () => {
          W.closeActionSheet();
          if (typeof items[idx]?.onClick === 'function') items[idx].onClick();
        });
      });
    }
    requestAnimationFrame(() => {
      if (backdrop) backdrop.classList.add('open');
      sheet.classList.add('open');
      sheet.setAttribute('aria-hidden', 'false');
    });
  };

  W.closeActionSheet = function () {
    const sheet    = document.getElementById('wren-action-sheet');
    const backdrop = document.getElementById('wren-action-sheet-backdrop');
    if (sheet)    { sheet.classList.remove('open');    sheet.setAttribute('aria-hidden', 'true'); }
    if (backdrop) backdrop.classList.remove('open');
  };

  // ── Device helpers ────────────────────────────────────────────────────────────
  W.isMobile = function () { return window.matchMedia('(max-width: 767px)').matches; };
  W.isTablet = function () { return window.matchMedia('(min-width: 768px) and (max-width: 1023px)').matches; };

})();

// ── b164 (2026-07-27): activity beacons — page views, clicks, session end ─────
// Feeds POST /api/audit/beacon so the manager's audit/usage page can answer
// "how long are staff using it, and are they using it correctly?". Batched
// (15s / 20 events / pagehide), fire-and-forget, no-ops when signed out.
(function () {
  var q = [], t0 = Date.now(), flushTimer = null;
  // 2026-10-29 (log-watch 8/9): a view-as session is read-only and a two-factor set-up or
  // challenge token only reaches /api/auth/*, so both get a 403 here by design — and the
  // clicks aren't the signed-in person's to record. Don't send for either.
  function tok() {
    var t = null;
    try { t = sessionStorage.getItem('wrenToken'); } catch (e) { return null; }
    if (!t || (window.__wrenViewAs && window.__wrenViewAs.active)) return null;
    try {
      var p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (p && (p.vas || p.scope === 'totp_only' || p.scope === 'totp_enroll_required')) return null;
    } catch (e) { /* not a JWT we can read — send as before */ }
    return t;
  }
  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    var t = tok();
    if (!q.length || !t) { q = []; return; }
    var events = q.splice(0, 50);
    try {
      var dev = (function () { try { return localStorage.getItem('wrenDevice') || ''; } catch (e) { return ''; } })();
      fetch('/api/audit/beacon', {
        method: 'POST', keepalive: true,
        headers: Object.assign({ 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t }, dev ? { 'X-Wren-Device': dev } : {}),
        body: JSON.stringify({ events: events })
      }).catch(function () {});
    } catch (e) { /* never break the page */ }
  }
  function push(ev) {
    if (!tok()) return;
    q.push(ev);
    if (q.length >= 20) flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, 15000);
  }
  push({ t: 'page_view', page: location.pathname });
  document.addEventListener('wren:section-loaded', function (e) {
    push({ t: 'page_view', page: '/admin/' + ((e.detail && e.detail.section) || '') });
  });
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest && e.target.closest('a,button,[role="button"],[role="tab"]');
    if (!el) return;
    // b345: anything inside [data-no-audit] is never recorded. The anonymous "tell management"
    // card uses it — a click label logged against the signed-in person would name the writer.
    if (el.closest('[data-no-audit]')) return;
    var label = (el.getAttribute('aria-label') || el.title || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 48);
    if (!label) label = el.id || (el.className && String(el.className).slice(0, 30)) || '?';
    push({ t: 'click', label: label, page: location.pathname });
  }, true);
  window.addEventListener('pagehide', function () {
    push({ t: 'session_end', page: location.pathname, dur_s: (Date.now() - t0) / 1000 });
    flush();
  });
})();

// ── fledge-off (2026-10-26): the Fledge switch on every page this core serves ──
// public/js/wren-fledge.js is the one browser reader of ladn.settings.fledge_enabled
// (via /api/features/public). Pages with Fledge markup load it in <head> themselves so
// it is in place before paint; this makes sure every other page has it too.
;(function () {
  if (window.WrenFledge || document.getElementById('wren-fledge-js')) return;
  var s = document.createElement('script');
  s.id = 'wren-fledge-js';
  s.src = '/js/wren-fledge.js?v=fledgeoff1';
  (document.head || document.documentElement).appendChild(s);
})();
