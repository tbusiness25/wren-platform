/* Wren Admin Shell — CSS Grid layout, no sticky/fixed for topbar/sidebar
   Build: 20260512-v2
   Replaces wren-shell-v2.js for the admin portal only.
   HR/EY/Parents portals keep wren-shell-v2.js unchanged.
*/
;(function () {
  'use strict';

  const BUILD              = '20260512-v2';
  const TOKEN_KEY          = 'wrenToken';
  const SESSION_TIMEOUT_MS = 4 * 60 * 60 * 1000;
  const SESSION_WARN_MS    = (4 * 60 * 60 - 60) * 1000;
  const BASE               = window.WREN_BASE || '/admin';

  // ── Admin SPA section registry ──────────────────────────────────────────────
  const SECTIONS = window.WREN_SECTIONS || {
    dashboard:      { id: 'dashboard',      icon: '🏠', label: 'Dashboard',       tabs: ['today', 'alerts', 'summary'] },
    admissions:     { id: 'admissions',     icon: '🌱', label: 'Admissions',      tabs: ['pipeline', 'list', 'trends', 'forecast', 'occupancy', 'ai-scoring'] },
    'action-plans': { id: 'action-plans',   icon: '⭐', label: 'Action Plans',    tabs: ['management', 'baby-room', 'pre-school', 'shared-with-parents'] },
    staff:          { id: 'staff',          icon: '👥', label: 'Staff',           tabs: ['list', 'calendar', 'rota', 'bradford', 'training', 'documents', 'observations', 'performance', 'reports'] },
    children:       { id: 'children',       icon: '👶', label: 'Children',        tabs: ['list', 'reports'] },
    curriculum:     { id: 'curriculum',     icon: '📚', label: 'Curriculum',      tabs: ['planning', 'next-steps', 'events', 'trips', 'calendar'] },
    finance:        { id: 'finance',        icon: '💷', label: 'Finance',         tabs: ['dashboard', 'forecast', 'invoices', 'reconcile', 'payments', 'funding', 'wages', 'payroll'] },
    communications: { id: 'communications', icon: '💬', label: 'Comms',           tabs: ['inbox', 'messaging', 'newsletters', 'aria', 'content-creator', 'message-review'] },
    safeguarding:   { id: 'safeguarding',   icon: '🛡️', label: 'Safeguarding',    tabs: ['concerns', 'sign-off-queue', 'log', 'audit'] },
    inspection:     { id: 'inspection',     icon: '📋', label: 'Inspection',      tabs: ['overview', 'action-items', 'briefings', 'gap-analysis', 'evidence', 'history'], requiresRole: 'manager' },
    operations:     { id: 'operations',     icon: '🔧', label: 'Operations',      tabs: ['kitchen', 'repairs', 'clock-in-out', 'compliance', 'health-safety'] },
    modules:        { id: 'modules',        icon: '🧩', label: 'Module Builder',  tabs: ['list', 'builder', 'records'] },
    system:         { id: 'system',         icon: '⚙️', label: 'System',          tabs: ['settings', 'integrations', 'backups', 'tech', 'support', 'docs', 'security', 'permissions', 'approvals', 'audit-log'], requiresRole: 'manager' },
  };

  // ── Sidebar navigation groups ────────────────────────────────────────────────
  const NAV_GROUPS = [
    { label: 'HOME',       sections: ['dashboard'] },
    { label: 'PEOPLE',     sections: ['admissions', 'children'] },
    { label: 'STAFF MGMT', sections: ['staff'] },
    { label: 'CARE',       sections: ['curriculum', 'action-plans', 'safeguarding'] },
    { label: 'OPERATIONS', sections: ['operations', 'finance', 'inspection'] },
    { label: 'COMMS',      sections: ['communications'] },
    { label: 'BUILDER',    sections: ['modules'] },
    { label: 'SYSTEM',     sections: ['system'] },
  ];

  // ── Session timers ───────────────────────────────────────────────────────────
  let sessionTimer, sessionWarnTimer;
  let _loadSection;

  // ── Sidebar collapse state ───────────────────────────────────────────────────
  let _sidebarCollapsed = false;

  function _setSidebarCollapsed(collapsed) {
    _sidebarCollapsed = collapsed;
    document.body.classList.toggle('as-sidebar-collapsed', collapsed);
    const btn = document.getElementById('as-hamburger');
    if (btn) btn.setAttribute('aria-expanded', String(!collapsed));
    try { sessionStorage.setItem('wren-sidebar-collapsed', collapsed ? '1' : '0'); } catch {}
  }

  // ── Public Wren API (same surface as wren-shell-v2.js) ─────────────────────
  window.Wren = {
    edition: 'admin',
    user: null,

    api(url, opts = {}) {
      const token = sessionStorage.getItem(TOKEN_KEY);
      opts.headers = Object.assign({}, opts.headers, {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      });
      if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
      return fetch(url, opts).then(r => {
        if (r.status === 401) { Wren.logout(); return; }
        if (!r.ok) return r.json().then(d => Promise.reject(d));
        return r.json();
      });
    },

    toast(message, type = 'info', duration = 3500) {
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
      setTimeout(() => { toast.classList.remove('visible'); setTimeout(() => toast.remove(), 300); }, duration);
    },

    modal(title, content, buttons = []) {
      document.querySelectorAll('.wren-modal-overlay').forEach(el => el.remove());
      const overlay = document.createElement('div');
      overlay.className = 'wren-modal-overlay';
      const btnHtml = buttons.map((b, i) => `<button class="btn ${b.class || 'btn-ghost'}" data-idx="${i}">${b.label}</button>`).join('');
      overlay.innerHTML = `
        <div class="wren-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <div class="modal-header">
            <span class="modal-title" id="modal-title">${title}</span>
            <button class="modal-close" aria-label="Close">✕</button>
          </div>
          <div class="modal-body">${typeof content === 'string' ? content : ''}</div>
          ${buttons.length ? `<div class="modal-footer">${btnHtml}</div>` : ''}
        </div>`;
      if (typeof content !== 'string') overlay.querySelector('.modal-body').appendChild(content);
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('open'));
      overlay.querySelector('.modal-close').onclick = () => { overlay.classList.remove('open'); setTimeout(() => overlay.remove(), 200); };
      overlay.addEventListener('click', e => { if (e.target === overlay) overlay.querySelector('.modal-close').click(); });
      buttons.forEach((b, i) => {
        overlay.querySelector(`[data-idx="${i}"]`).onclick = () => { if (b.action) b.action(); if (b.close !== false) overlay.querySelector('.modal-close').click(); };
      });
      return overlay;
    },

    logout() {
      sessionStorage.removeItem(TOKEN_KEY);
      window.location.href = '/login.html';
    },

    getToken() { return sessionStorage.getItem(TOKEN_KEY); },

    setToken(token) {
      sessionStorage.setItem(TOKEN_KEY, token);
      Wren._parseUser();
      Wren._resetSessionTimer();
    },

    _parseUser() {
      const token = sessionStorage.getItem(TOKEN_KEY);
      if (!token) return;
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        if (!payload || !payload.id) throw new Error('malformed');
        if (payload.exp && payload.exp * 1000 < Date.now()) throw new Error('expired');
        Wren.user = payload;
      } catch {
        sessionStorage.removeItem(TOKEN_KEY);
        if (!window.location.pathname.includes('login.html')) window.location.replace('/login.html');
      }
    },

    _resetSessionTimer() {
      clearTimeout(sessionTimer); clearTimeout(sessionWarnTimer);
      const warn = document.getElementById('wren-session-warning');
      if (warn) warn.hidden = true;
      sessionWarnTimer = setTimeout(() => {
        const w = document.getElementById('wren-session-warning');
        if (w) w.hidden = false;
      }, SESSION_WARN_MS);
      sessionTimer = setTimeout(() => { Wren.toast('Session expired — please sign in again', 'warning'); Wren.logout(); }, SESSION_TIMEOUT_MS);
    },

    navigate(section, tab) {
      const def = SECTIONS[section];
      if (!def) { Wren.navigate('dashboard', null); return; }
      const resolvedTab = tab || def.tabs[0];
      const url = `${BASE}/${section}/${resolvedTab}`;
      if (window.location.pathname !== url) history.pushState({ section, tab: resolvedTab }, '', url);
      _loadSection(section, resolvedTab);
    },

    openDrawer(content, title = '') { if (typeof _openDrawerFn === 'function') _openDrawerFn(content, title); },
    closeDrawer()                   { if (typeof _closeDrawerFn === 'function') _closeDrawerFn(); },
  };

  let _openDrawerFn, _closeDrawerFn;

  // ── Route parsing ────────────────────────────────────────────────────────────
  function _parseRoute() {
    const m = window.location.pathname.match(/^\/(?:admin-new|admin)\/([^/?#]+)(?:\/([^/?#]+))?/);
    if (!m) return { section: 'dashboard', tab: null };
    return { section: m[1], tab: m[2] || null };
  }

  // ── Build grouped sidebar HTML ───────────────────────────────────────────────
  function _buildGroupedNav(isMgr) {
    return NAV_GROUPS.map(group => {
      const items = group.sections
        .filter(id => SECTIONS[id])
        .filter(id => !(SECTIONS[id].requiresRole === 'manager' && !isMgr))
        .map(id => {
          const s = SECTIONS[id];
          return `<li role="none">
            <button class="as-nav-btn" data-section="${s.id}" aria-label="${s.label}" title="${s.label}" role="menuitem">
              <span class="as-nav-icon" aria-hidden="true">${s.icon}</span>
              <span class="as-label">${s.label}</span>
            </button>
          </li>`;
        }).join('');
      if (!items) return '';
      return `<li class="as-nav-group" role="none">
        <div class="as-nav-group-label" aria-hidden="true">${group.label}</div>
        <ul role="list" class="as-nav-group-items">${items}</ul>
      </li>`;
    }).join('');
  }

  // ── Build the CSS Grid shell ─────────────────────────────────────────────────
  function buildAdminShell() {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) { if (!window.location.pathname.includes('login')) window.location.replace('/login.html'); return; }

    Wren._parseUser();
    Wren._resetSessionTimer();
    const user = Wren.user;
    if (!user) return;

    const role  = user.role || 'practitioner';
    const isMgr = ['manager', 'deputy_manager', 'admin'].includes(role);

    // Restore sidebar collapse preference
    const savedCollapsed = sessionStorage.getItem('wren-sidebar-collapsed') === '1';

    // Grid shell class on html + body
    document.documentElement.classList.add('admin-page');
    document.body.classList.add('admin-shell');
    if (savedCollapsed) document.body.classList.add('as-sidebar-collapsed');
    _sidebarCollapsed = savedCollapsed;

    // Session warning bar
    const warnBar = document.createElement('div');
    warnBar.id = 'wren-session-warning';
    warnBar.hidden = true;
    warnBar.setAttribute('role', 'alert');
    warnBar.innerHTML = `⏱ Your session expires in 1&nbsp;minute. <a href="#" onclick="Wren._resetSessionTimer();this.closest('#wren-session-warning').hidden=true;return false">Stay signed in</a>`;
    document.body.appendChild(warnBar);

    // ── Topbar (grid-area: topbar) ──────────────────────────────────────────
    const topbar = document.createElement('header');
    topbar.id = 'admin-topbar';
    topbar.setAttribute('role', 'banner');
    topbar.innerHTML = `
      <button id="as-hamburger" class="as-topbar-btn as-hamburger" aria-label="Collapse sidebar" aria-expanded="${String(!savedCollapsed)}" aria-controls="admin-sidebar">
        <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
      </button>
      <a href="${BASE}/dashboard" class="as-logo" aria-label="Wren admin home" onclick="Wren.navigate('dashboard');return false">
        <div class="wren-logo"><span class="logo-w">w</span><span class="logo-ren">ren</span></div>
      </a>
      <nav class="as-breadcrumb" aria-label="Location">
        <a class="as-bc-home" href="${BASE}/dashboard" onclick="Wren.navigate('dashboard');return false">Admin</a>
        <span class="as-bc-sep" aria-hidden="true">›</span>
        <span class="as-bc-current" id="as-breadcrumb-section" aria-live="polite" aria-atomic="true"></span>
      </nav>
      <div class="as-spacer"></div>
      <button id="as-search-btn" class="as-topbar-btn as-search-btn" aria-label="Search (Ctrl+K)" title="Search (Ctrl+K)">
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        <span class="as-search-label">Search</span>
        <kbd class="as-kbd">Ctrl K</kbd>
      </button>
      <button id="as-notif-btn" class="as-topbar-btn as-notif-btn" aria-label="Notifications" aria-haspopup="true">
        <span aria-hidden="true" style="font-size:1.1rem">🔔</span>
        <span id="as-notif-count" class="as-notif-badge" hidden aria-label="unread notifications"></span>
      </button>
      <button class="as-avatar" aria-label="Account menu" aria-haspopup="true" id="as-account-btn">
        ${(user.name || '?').charAt(0).toUpperCase()}
      </button>`;
    document.body.prepend(topbar);

    // ── Sidebar (grid-area: sidebar) ────────────────────────────────────────
    const sidebar = document.createElement('nav');
    sidebar.id = 'admin-sidebar';
    sidebar.setAttribute('role', 'navigation');
    sidebar.setAttribute('aria-label', 'Main navigation');
    sidebar.innerHTML = `
      <ul class="as-nav-list" role="list" aria-label="Sections">
        ${_buildGroupedNav(isMgr)}
      </ul>`;
    document.body.insertBefore(sidebar, topbar.nextSibling);

    // ── Main area (grid-area: main) ──────────────────────────────────────────
    let mainEl = document.getElementById('admin-main');
    if (!mainEl) {
      mainEl = document.createElement('main');
      mainEl.id = 'admin-main';
      mainEl.setAttribute('role', 'main');
      mainEl.setAttribute('tabindex', '-1');
      const contentEl = document.getElementById('section-content') || (() => {
        const d = document.createElement('div');
        d.id = 'section-content';
        return d;
      })();
      mainEl.appendChild(contentEl);
      document.body.appendChild(mainEl);
    }

    // ── Hamburger / sidebar toggle ─────────────────────────────────────────
    const hamburger = topbar.querySelector('#as-hamburger');
    hamburger.addEventListener('click', () => {
      if (window.innerWidth >= 768) {
        // Desktop: toggle collapsed
        _setSidebarCollapsed(!_sidebarCollapsed);
      } else {
        // Mobile: toggle overlay
        const open = sidebar.classList.toggle('as-expanded');
        hamburger.setAttribute('aria-expanded', String(open));
      }
    });
    document.addEventListener('click', e => {
      if (window.innerWidth >= 768) return;
      if (!sidebar.contains(e.target) && !hamburger.contains(e.target)) {
        sidebar.classList.remove('as-expanded');
        hamburger.setAttribute('aria-expanded', 'false');
      }
    });

    // ── Sidebar nav: section clicks ─────────────────────────────────────────
    sidebar.querySelectorAll('[data-section]').forEach(btn => {
      btn.addEventListener('click', () => {
        Wren.navigate(btn.dataset.section, null);
        // On mobile, close overlay after selection
        if (window.innerWidth < 768) {
          sidebar.classList.remove('as-expanded');
          hamburger.setAttribute('aria-expanded', 'false');
        }
      });
    });

    // Keyboard nav within sidebar
    sidebar.addEventListener('keydown', e => {
      const btns = [...sidebar.querySelectorAll('.as-nav-btn')];
      const cur  = btns.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); btns[Math.min(cur + 1, btns.length - 1)]?.focus(); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); btns[Math.max(cur - 1, 0)]?.focus(); }
      if (e.key === 'Home')      { e.preventDefault(); btns[0]?.focus(); }
      if (e.key === 'End')       { e.preventDefault(); btns[btns.length - 1]?.focus(); }
    });

    // ── Section loader ───────────────────────────────────────────────────────
    function _updateSidebarActive(sectionId) {
      sidebar.querySelectorAll('[data-section]').forEach(btn => {
        const active = btn.dataset.section === sectionId;
        btn.classList.toggle('as-active', active);
        btn.setAttribute('aria-current', active ? 'page' : 'false');
      });
      const bcEl = document.getElementById('as-breadcrumb-section');
      if (bcEl) bcEl.textContent = SECTIONS[sectionId]?.label || '';
    }

    const _sectionCache = {};

    _loadSection = async function (sectionId, tabId) {
      const def = SECTIONS[sectionId];
      if (!def) { Wren.navigate('dashboard', null); return; }
      _updateSidebarActive(sectionId);
      const container = document.getElementById('section-content');
      if (!container) return;
      if (!_sectionCache[sectionId]) {
        container.innerHTML = `<div class="v2-section-loading"><div class="v2-sk-bar wide"></div><div class="v2-sk-tabs"></div><div class="v2-sk-body"></div></div>`;
      }
      mainEl.scrollTop = 0;
      try {
        let html;
        if (_sectionCache[sectionId]) {
          html = _sectionCache[sectionId];
        } else {
          const res = await fetch(`/sections/${sectionId}.html`, { cache: 'no-store', credentials: 'same-origin' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          html = await res.text();
          _sectionCache[sectionId] = html;
        }
        container.innerHTML = html;
        container.querySelectorAll('script').forEach(old => {
          const s = document.createElement('script');
          [...old.attributes].forEach(a => s.setAttribute(a.name, a.value));
          s.textContent = old.textContent;
          old.replaceWith(s);
        });
        _wireTabBar(container, sectionId, tabId || def.tabs[0]);
        document.dispatchEvent(new CustomEvent('wren:section-loaded', { detail: { section: sectionId } }));
      } catch (err) {
        console.error('Section load error:', err);
        container.innerHTML = `
          <div class="v2-section-error">
            <div style="font-size:2.5rem">⚠️</div>
            <h2>Section unavailable</h2>
            <p>Could not load <strong>${sectionId}</strong>. <a href="${BASE}/dashboard">Go to dashboard</a></p>
          </div>`;
      }
    };

    // ── Tab bar wiring ───────────────────────────────────────────────────────
    function _wireTabBar(container, sectionId, activeTabId) {
      const tabList = container.querySelector('[role="tablist"]');
      if (!tabList) return;
      const tabs   = [...tabList.querySelectorAll('[role="tab"]')];
      const panels = [...container.querySelectorAll('[role="tabpanel"]')];
      const track      = container.querySelector('.tab-bar-track');
      const leftArrow  = container.querySelector('.tab-scroll-arrow.left');
      const rightArrow = container.querySelector('.tab-scroll-arrow.right');
      if (track && leftArrow && rightArrow) {
        const scroll = dir => track.scrollBy({ left: dir * 180, behavior: 'smooth' });
        leftArrow.addEventListener('click',  () => scroll(-1));
        rightArrow.addEventListener('click', () => scroll(1));
        const upd = () => {
          leftArrow.style.visibility  = track.scrollLeft > 1 ? 'visible' : 'hidden';
          rightArrow.style.visibility = (track.scrollLeft + track.clientWidth + 1) < track.scrollWidth ? 'visible' : 'hidden';
        };
        track.addEventListener('scroll', upd, { passive: true });
        requestAnimationFrame(upd);
        new ResizeObserver(upd).observe(track);
      }
      function _activateTab(tabId) {
        const activeTab = tabs.find(t => t.dataset.tab === tabId);
        if (!activeTab) return;
        tabs.forEach(t => {
          const isActive = t.dataset.tab === tabId;
          t.classList.toggle('wren-tab-active', isActive);
          t.setAttribute('aria-selected', String(isActive));
          t.setAttribute('tabindex', isActive ? '0' : '-1');
        });
        panels.forEach(p => {
          const isActive = p.dataset.tab === tabId;
          p.hidden = !isActive;
          if (isActive) {
            const fn = window[`wrenLoadTab_${sectionId}_${tabId}`];
            if (typeof fn === 'function') { fn(p); window[`wrenLoadTab_${sectionId}_${tabId}`] = null; }
          }
        });
        activeTab.scrollIntoView({ inline: 'nearest', behavior: 'smooth' });
        const newUrl = `${BASE}/${sectionId}/${tabId}`;
        if (window.location.pathname !== newUrl) history.replaceState({ section: sectionId, tab: tabId }, '', newUrl);
      }
      tabs.forEach(tab => tab.addEventListener('click', () => _activateTab(tab.dataset.tab)));
      tabList.addEventListener('keydown', e => {
        const cur = tabs.findIndex(t => t === document.activeElement);
        if (cur < 0) return;
        const map = { ArrowRight: 1, ArrowLeft: -1 };
        if (e.key in map) {
          e.preventDefault();
          const next = Math.max(0, Math.min(tabs.length - 1, cur + map[e.key]));
          tabs[next].focus(); _activateTab(tabs[next].dataset.tab);
        } else if (e.key === 'Home') { e.preventDefault(); tabs[0].focus(); _activateTab(tabs[0].dataset.tab); }
        else if (e.key === 'End')   { e.preventDefault(); tabs[tabs.length-1].focus(); _activateTab(tabs[tabs.length-1].dataset.tab); }
      });
      const valid = tabs.find(t => t.dataset.tab === activeTabId);
      _activateTab(valid ? activeTabId : tabs[0]?.dataset.tab);
    }

    // ── Popstate ─────────────────────────────────────────────────────────────
    window.addEventListener('popstate', e => {
      const state = e.state || _parseRoute();
      _loadSection(state.section, state.tab);
    });

    // ── Search (Ctrl+K) ──────────────────────────────────────────────────────
    function _openSearch() {
      if (document.getElementById('wren-search-overlay')) return;
      const overlay = document.createElement('div');
      overlay.id = 'wren-search-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', 'Global search');
      overlay.innerHTML = `
        <div class="search-backdrop"></div>
        <div class="search-panel">
          <div class="search-input-row">
            <svg class="search-input-icon" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
            <input type="text" id="wren-search-input" class="search-input" placeholder="Search sections, tabs…" autocomplete="off" spellcheck="false" aria-label="Search">
            <kbd class="search-esc">Esc</kbd>
          </div>
          <div id="wren-search-results" class="search-results" role="listbox" aria-label="Search results">
            <p class="search-hint">Jump to any section or tab</p>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('open'));
      const input = overlay.querySelector('#wren-search-input');
      setTimeout(() => input.focus(), 30);
      function close() { overlay.classList.remove('open'); setTimeout(() => overlay.remove(), 180); }
      overlay.querySelector('.search-backdrop').addEventListener('click', close);
      function escHandler(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); } }
      document.addEventListener('keydown', escHandler);
      input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        const resultsEl = overlay.querySelector('#wren-search-results');
        if (!q) { resultsEl.innerHTML = '<p class="search-hint">Jump to any section or tab</p>'; return; }
        const hits = [];
        Object.values(SECTIONS).forEach(s => {
          if (s.label.toLowerCase().includes(q)) hits.push({ label: s.label, icon: s.icon, section: s.id, tab: s.tabs[0] });
          s.tabs.forEach(t => {
            if (t.includes(q) || t.replace(/-/g, ' ').includes(q)) hits.push({ label: `${s.label} → ${t.replace(/-/g, ' ')}`, icon: s.icon, section: s.id, tab: t });
          });
        });
        if (!hits.length) { resultsEl.innerHTML = '<p class="search-hint">No results</p>'; return; }
        resultsEl.innerHTML = hits.slice(0, 8).map((h, i) => `
          <button class="search-result" role="option" aria-selected="false" data-idx="${i}" data-section="${h.section}" data-tab="${h.tab}">
            <span class="search-result-icon">${h.icon}</span>
            <span class="search-result-label">${h.label}</span>
          </button>`).join('');
        resultsEl.querySelectorAll('[data-section]').forEach(btn => {
          btn.addEventListener('click', () => { close(); Wren.navigate(btn.dataset.section, btn.dataset.tab); });
        });
      });
    }
    topbar.querySelector('#as-search-btn').addEventListener('click', _openSearch);
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); _openSearch(); }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'I') {
        e.preventDefault();
        if (typeof WrenInspection !== 'undefined') WrenInspection.openLauncher();
        else Wren.navigate('inspection', 'overview');
      }
    });

    // ── Notifications ────────────────────────────────────────────────────────
    _wireNotifications(topbar, user);

    // ── Account menu ─────────────────────────────────────────────────────────
    _wireAccountMenu(topbar, user, role);

    // ── Drawer ───────────────────────────────────────────────────────────────
    _wireDrawer();

    // ── Activity keeps session alive ─────────────────────────────────────────
    ['click', 'keydown', 'touchstart'].forEach(ev => {
      document.addEventListener(ev, () => { if (sessionStorage.getItem(TOKEN_KEY)) Wren._resetSessionTimer(); }, { passive: true });
    });

    // ── Fonts ─────────────────────────────────────────────────────────────────
    _injectFonts();

    // ── Inspection countdown bar (pre-announced) ─────────────────────────────
    if (isMgr) {
      (async function _initInspectionBar() {
        try {
          const data = await Wren.api('/api/inspection/active');
          if (!data?.inspection) return;
          const insp = data.inspection;
          if (insp.type !== 'pre_announced' || !insp.expected_arrival) return;
          const arrival = new Date(insp.expected_arrival);
          if (arrival < new Date()) return;
          const bar = document.createElement('div');
          bar.id = 'wren-inspection-bar';
          bar.setAttribute('role', 'status');
          bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:2000;background:#7c3aed;color:#fff;text-align:center;padding:6px 16px;font-size:0.8rem;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:12px';
          bar.onclick = () => Wren.navigate('inspection', 'overview');
          function _updateBar() {
            const diff = arrival - new Date();
            if (diff <= 0) { bar.remove(); return; }
            const h = Math.floor(diff / 3600000);
            const m = Math.floor((diff % 3600000) / 60000);
            const s = Math.floor((diff % 60000) / 1000);
            const pad = n => String(n).padStart(2, '0');
            bar.innerHTML = `<span>📋 Inspection — ${insp.inspector_name ? insp.inspector_name + ' — ' : ''}Arrival in</span><span style="font-variant-numeric:tabular-nums;font-size:1rem;letter-spacing:1px">${h}:${pad(m)}:${pad(s)}</span><span style="opacity:0.7;font-size:0.7rem">Click to open</span>`;
          }
          _updateBar();
          document.body.appendChild(bar);
          const tick = setInterval(() => { if (!document.getElementById('wren-inspection-bar')) { clearInterval(tick); return; } _updateBar(); }, 1000);
        } catch {}
      })();
    }

    // ── Initial route ────────────────────────────────────────────────────────
    const { section, tab } = _parseRoute();
    const initSection = SECTIONS[section] ? section : 'dashboard';
    const initTab     = tab || SECTIONS[initSection].tabs[0];
    const initUrl     = `${BASE}/${initSection}/${initTab}`;
    if (window.location.pathname !== initUrl) history.replaceState({ section: initSection, tab: initTab }, '', initUrl);
    _loadSection(initSection, initTab);

    // ── Ready ────────────────────────────────────────────────────────────────
    window._wrenReady = true;
    document.dispatchEvent(new CustomEvent('wren:ready', { detail: { user: Wren.user } }));
    if (typeof WrenChat !== 'undefined') WrenChat.init({ persona: 'admin', greeting: "Hi! I'm Wren." });
  }

  // ── Shared helpers ───────────────────────────────────────────────────────────

  function _wireNotifications(topbar, user) {
    let _notifItems = [];

    async function _refreshNotifCount() {
      try {
        const data = await Wren.api('/api/notifications/unread');
        _notifItems = data.items || [];
        const cnt   = data.count || 0;
        const badge = document.getElementById('as-notif-count');
        if (badge) { badge.textContent = cnt > 99 ? '99+' : String(cnt); badge.hidden = cnt === 0; }
      } catch {}
    }

    function _relTime(ts) {
      const m = Math.floor((Date.now() - new Date(ts)) / 60000);
      if (m < 1) return 'Just now';
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      return new Date(ts).toLocaleDateString('en-GB');
    }

    Wren._toggleNotifPanel = function () {
      const existing = document.getElementById('wren-notif-panel');
      if (existing) { existing.remove(); return; }
      const catIcon = { repair: '🔧', message: '💬', calendar: '📅', 'action-plan': '📋', safeguarding: '🛡️', medicine: '💊', incident: '🚨', system: 'ℹ️', gmail: '📧', enquiry: '📩', 'waiting-list': '📝' };
      const panel = document.createElement('div');
      panel.id = 'wren-notif-panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Notifications');
      panel.innerHTML = `
        <div class="notif-panel-header">
          <span>Notifications</span>
          <button class="notif-mark-all" onclick="Wren._markAllRead()">Mark all read</button>
        </div>
        <div id="wren-notif-list">
          ${_notifItems.length
            ? _notifItems.map(n => `
                <div class="notif-item ${n.read_at ? 'read' : ''}" data-nid="${n.id}" onclick="Wren._openNotif(${n.id},${JSON.stringify(n.link || '')})">
                  <span class="notif-cat">${catIcon[n.category] || '🔔'}</span>
                  <div class="notif-body">
                    <div class="notif-title">${n.title}</div>
                    ${n.body ? `<div class="notif-text">${n.body}</div>` : ''}
                    <div class="notif-time">${_relTime(n.created_at)}</div>
                  </div>
                </div>`).join('')
            : '<div class="notif-empty">All caught up 👍</div>'}
        </div>`;
      document.body.appendChild(panel);
      setTimeout(() => {
        document.addEventListener('click', e => {
          if (!panel.contains(e.target) && !document.getElementById('as-notif-btn')?.contains(e.target)) panel.remove();
        }, { once: true });
      }, 50);
    };

    topbar.querySelector('#as-notif-btn').addEventListener('click', Wren._toggleNotifPanel);
    topbar.querySelector('#as-notif-btn').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); Wren._toggleNotifPanel(); } });

    Wren._openNotif = async function (id, link) {
      try { await Wren.api(`/api/notifications/${id}/read`, { method: 'POST' }); } catch {}
      document.getElementById('wren-notif-panel')?.remove();
      _refreshNotifCount();
      if (link) window.location.href = link;
    };
    Wren._markAllRead = async function () {
      try { await Wren.api('/api/notifications/read-all', { method: 'POST' }); } catch {}
      document.getElementById('wren-notif-panel')?.remove();
      _refreshNotifCount();
    };

    _refreshNotifCount();
    setInterval(_refreshNotifCount, 30000);
  }

  function _wireAccountMenu(topbar, user, role) {
    Wren._showUserMenu = function () {
      const existing = document.getElementById('user-menu-popup');
      if (existing) { existing.remove(); return; }
      const popup = document.createElement('div');
      popup.id = 'user-menu-popup';
      popup.setAttribute('role', 'menu');
      const ls = 'display:flex;align-items:center;gap:10px;padding:10px 12px;font-size:.875rem;color:var(--c-text);text-decoration:none;border-radius:6px;cursor:pointer;background:none;border:none;width:100%;text-align:left;font-family:inherit;transition:background .15s;white-space:nowrap;';
      const hs = `onmouseenter="this.style.background='rgba(74,154,191,.12)'" onmouseleave="this.style.background=''"`;
      popup.innerHTML = `
        <div style="padding:8px 12px 6px;border-bottom:1px solid var(--c-border);font-size:.82rem;color:var(--c-muted);font-weight:600">${user.name || 'User'} <span style="font-weight:400">(${role})</span></div>
        <a href="/my-profile.html"           style="${ls}" ${hs} role="menuitem">👤 My Profile</a>
        <a href="/ey-legacy/totp-setup.html" style="${ls}" ${hs} role="menuitem">🔐 Two-Factor Auth</a>
        <a href="/admin/system/settings"    style="${ls}" ${hs} role="menuitem">⚙️ Settings</a>
        <a href="/admin/system/tech"        style="${ls}" ${hs} role="menuitem">💻 IT Settings</a>
        <a href="/admin/system/permissions" style="${ls}" ${hs} role="menuitem">🛡️ Permissions</a>
        <a href="/admin/system/approvals"   style="${ls}" ${hs} role="menuitem">✅ Approvals</a>
        <div style="border-top:1px solid var(--c-border);margin:4px 0"></div>
        <button onclick="Wren.logout()" style="${ls}color:var(--c-red);" ${hs} role="menuitem">🚪 Sign Out</button>`;
      popup.style.cssText = 'position:fixed;top:56px;right:12px;background:var(--c-card);border:1px solid var(--c-border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.5);padding:8px;z-index:9000;min-width:210px;';
      document.body.appendChild(popup);
      setTimeout(() => document.addEventListener('click', e => { if (!popup.contains(e.target)) popup.remove(); }, { once: true }), 50);
    };
    topbar.querySelector('#as-account-btn').addEventListener('click', Wren._showUserMenu);
  }

  function _wireDrawer() {
    let _drawerEl = null;
    function _open(content, title) {
      _close();
      _drawerEl = document.createElement('div');
      _drawerEl.className = 'wren-drawer';
      _drawerEl.setAttribute('role', 'dialog');
      _drawerEl.setAttribute('aria-modal', 'true');
      _drawerEl.setAttribute('aria-label', title || 'Details');
      _drawerEl.innerHTML = `
        <div class="drawer-backdrop"></div>
        <div class="drawer-panel" tabindex="-1">
          <div class="drawer-header">
            <span class="drawer-title">${title || ''}</span>
            <button class="drawer-close" aria-label="Close">✕</button>
          </div>
          <div class="drawer-body"></div>
        </div>`;
      const body = _drawerEl.querySelector('.drawer-body');
      if (typeof content === 'string') body.innerHTML = content;
      else if (content instanceof Element) body.appendChild(content);
      document.body.appendChild(_drawerEl);
      requestAnimationFrame(() => _drawerEl.classList.add('open'));
      _drawerEl.querySelector('.drawer-backdrop').addEventListener('click', _close);
      _drawerEl.querySelector('.drawer-close').addEventListener('click', _close);
      _drawerEl.querySelector('.drawer-panel').focus();
    }
    function _close() {
      if (!_drawerEl) return;
      _drawerEl.classList.remove('open');
      const el = _drawerEl;
      setTimeout(() => el.remove(), 260);
      _drawerEl = null;
    }
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && _drawerEl) _close(); });
    _openDrawerFn  = _open;
    _closeDrawerFn = _close;
    Wren.openDrawer  = (c, t) => _open(c, t);
    Wren.closeDrawer = () => _close();
  }

  function _injectFonts() {
    if (document.querySelector('link[data-wren-fonts]')) return;
    const pc = document.createElement('link'); pc.rel = 'preconnect'; pc.href = 'https://fonts.gstatic.com'; pc.crossOrigin = 'anonymous'; document.head.appendChild(pc);
    const fl = document.createElement('link'); fl.rel = 'stylesheet'; fl.href = 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=DM+Sans:wght@400;500;600&display=swap'; fl.setAttribute('data-wren-fonts', '1'); document.head.appendChild(fl);
  }

  // ── Entry point ──────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildAdminShell);
  else buildAdminShell();

})();
