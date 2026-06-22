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

  // ── api — JSON fetch with Bearer token, device token, 401 → logout ────────────────
  W.api = function (url, opts = {}) {
    const token = sessionStorage.getItem(TOKEN_KEY);
    const deviceToken = localStorage.getItem('wrenDevice') || '';
    opts.headers = Object.assign({}, opts.headers, {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(deviceToken ? { 'X-Wren-Device': deviceToken } : {}),
    });
    if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    return fetch(url, opts).then(r => {
      if (r.status === 401) { W.logout(); return; }
      if (!r.ok) return r.json().then(d => Promise.reject(d));
      return r.json();
    });
  };

  // ── Token / user storage ──────────────────────────────────────────────────────
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
          <span class="wren-app-action-sheet-item-icon" aria-hidden="true">${item.icon || ''}</span>
          <span>${item.label}</span>
        </button>`
      ).join('');
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
