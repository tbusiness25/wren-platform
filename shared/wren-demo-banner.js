(function () {
  'use strict';

  const TIER_SPEEDS = {
    '1': { label: 'Tier 1 · Solo AI',        name: 'Mini PC',       speed: '~8s thinking, then steady output (~8 tok/s)' },
    '2': { label: 'Tier 2 · Live AI',         name: 'AI Mini PC',    speed: '~1.5s thinking, fast streaming (~35 tok/s)' },
    '3': { label: 'Tier 3 · Whole-school AI', name: 'Strix Halo',    speed: '~0.6s thinking, steady stream (~22 tok/s)' },
  };

  // Roles available per edition
  const EDITION_ROLES = {
    eyfs: [
      { id: 'admin',        label: 'Manager',      emoji: '👩‍💼', desc: 'Admin & funding' },
      { id: 'practitioner', label: 'Practitioner', emoji: '📝', desc: 'Observations & diary' },
      { id: 'parent',       label: 'Parent',       emoji: '💛', desc: 'Child updates' },
    ],
    primary: [
      { id: 'admin',   label: 'Admin',   emoji: '📊', desc: 'MIS & compliance' },
      { id: 'teacher', label: 'Teacher', emoji: '📝', desc: 'Register & marks' },
      { id: 'parent',  label: 'Parent',  emoji: '💛', desc: 'Child updates' },
    ],
    secondary: [
      { id: 'admin',   label: 'Admin',   emoji: '📊', desc: 'MIS & compliance' },
      { id: 'teacher', label: 'Teacher', emoji: '📝', desc: 'Register & marks' },
      { id: 'parent',  label: 'Parent',  emoji: '💛', desc: 'Child updates' },
      { id: 'student', label: 'Student', emoji: '🎒', desc: 'Homework & points' },
    ],
    admin: [
      { id: 'admin', label: 'Manager', emoji: '👩‍💼', desc: 'Full admin view' },
    ],
  };

  const ROLE_DISPLAY = {
    manager:        { label: 'Manager',      emoji: '👩‍💼' },
    deputy_manager: { label: 'Deputy',       emoji: '👩‍💼' },
    admin:          { label: 'Admin',        emoji: '📊' },
    room_leader:    { label: 'Room Leader',  emoji: '📝' },
    practitioner:   { label: 'Practitioner',emoji: '📝' },
    parent:         { label: 'Parent',       emoji: '💛' },
    student:        { label: 'Student',      emoji: '🎒' },
  };

  const SK = 'wren-demo-tier';
  let _tier = sessionStorage.getItem(SK) || '2';
  let _callbacks = [];
  let _switching = false;

  function getTier() { return _tier; }

  function setTier(t) {
    if (!TIER_SPEEDS[t]) return;
    _tier = t;
    sessionStorage.setItem(SK, t);
    _callbacks.forEach(fn => { try { fn(t); } catch (_) {} });
    document.dispatchEvent(new CustomEvent('wren-demo-tier-change', { detail: { tier: t } }));
    _renderTiers();
    _renderSpeed();
  }

  function onChange(cb) { _callbacks.push(cb); }

  window.WrenDemo = { getTier, setTier, onChange };

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function _getEdition() {
    const meta = document.querySelector('meta[name="wren-edition"]');
    return meta ? meta.getAttribute('content') : null;
  }

  function _getCurrentRole() {
    try {
      const token = sessionStorage.getItem('wrenToken') || sessionStorage.getItem('wren_token');
      if (!token) return null;
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.exp * 1000 < Date.now()) return null;
      return payload.role || null;
    } catch (_) { return null; }
  }

  function _getBadgeLabel() {
    const role = _getCurrentRole();
    if (!role) return '<span class="badge-bird">🐦</span><span>Demo</span>';
    const info = ROLE_DISPLAY[role] || { label: role, emoji: '👤' };
    return `<span class="badge-bird">${info.emoji}</span><span>${info.label}</span><span class="badge-caret">▾</span>`;
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  function _buildBanner() {
    const root = document.createElement('div');
    root.id = 'wren-demo-banner';

    // Collapsed badge
    const badge = document.createElement('div');
    badge.id = 'wren-demo-badge';
    badge.innerHTML = _getBadgeLabel();
    badge.addEventListener('click', _togglePanel);
    root.appendChild(badge);

    // Expanded panel
    const panel = document.createElement('div');
    panel.id = 'wren-demo-panel';

    const edition = _getEdition();
    const roles = (edition && EDITION_ROLES[edition]) || [];
    const roleSection = roles.length > 0 ? `
      <div class="wdb-section-label">Viewing as</div>
      <div class="wdb-roles" id="wdb-roles"></div>
      <div class="wdb-divider"></div>
    ` : '';

    panel.innerHTML = `
      <div class="wdb-header">
        <span class="wdb-title">🐦 Demo controls</span>
        <button class="wdb-close" aria-label="Close">✕</button>
      </div>
      ${roleSection}
      <div class="wdb-section-label">AI hardware tier</div>
      <div class="wdb-tiers" id="wdb-tiers"></div>
      <div class="wdb-speed" id="wdb-speed"></div>
      <div class="wdb-footer">
        <a href="https://getwren.co.uk/#hardware" target="_blank" class="wdb-learn">Learn more →</a>
        <button class="wdb-reset-btn" id="wdb-reset-btn" title="Reset demo data">↺ Reset</button>
      </div>
    `;
    panel.querySelector('.wdb-close').addEventListener('click', _closePanel);
    root.appendChild(panel);

    document.body.appendChild(root);

    _renderRoles();
    _renderTiers();
    _renderSpeed();
    _wireReset();
  }

  function _renderRoles() {
    const container = document.getElementById('wdb-roles');
    if (!container) return;
    const edition = _getEdition();
    const roles = (edition && EDITION_ROLES[edition]) || [];
    const currentRole = _getCurrentRole();

    container.innerHTML = roles.map(r => {
      const active = _isRoleActive(r.id, currentRole) ? 'active' : '';
      return `<button class="wdb-role-btn ${active}" data-role="${r.id}" title="${r.desc}">
        <span class="role-emoji">${r.emoji}</span>
        <span class="role-label">${r.label}</span>
      </button>`;
    }).join('');

    container.querySelectorAll('.wdb-role-btn').forEach(btn => {
      btn.addEventListener('click', () => _switchRole(btn.dataset.role, btn));
    });
  }

  function _isRoleActive(roleId, currentDbRole) {
    if (!currentDbRole) return false;
    const map = {
      admin: ['manager', 'deputy_manager', 'admin'],
      manager: ['manager', 'deputy_manager'],
      practitioner: ['practitioner', 'room_leader'],
      teacher: ['practitioner', 'room_leader'],
      parent: ['parent'],
      student: ['student'],
      hr: ['manager', 'deputy_manager'],
    };
    return (map[roleId] || [roleId]).includes(currentDbRole);
  }

  async function _switchRole(roleId, btn) {
    if (_switching) return;
    _switching = true;

    // Optimistic: mark button as switching
    const prev = document.querySelector('.wdb-role-btn.active');
    if (prev) prev.classList.remove('active');
    btn.classList.add('active', 'switching');

    try {
      const res = await fetch('/api/auth/demo-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: roleId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');

      sessionStorage.setItem('wrenToken', data.token);
      sessionStorage.setItem('wren_token', data.token);

      // Small delay so the user sees the active state before navigation
      setTimeout(() => {
        window.location.href = data.redirect || '/';
      }, 200);
    } catch (e) {
      btn.classList.remove('active', 'switching');
      if (prev) prev.classList.add('active');
      _switching = false;
      // Show brief error on the button
      btn.textContent = '✕ Failed';
      setTimeout(() => _renderRoles(), 1500);
    }
  }

  function _renderTiers() {
    const container = document.getElementById('wdb-tiers');
    if (!container) return;
    container.innerHTML = Object.entries(TIER_SPEEDS).map(([t, info]) => `
      <button class="wdb-tier-btn ${t === _tier ? 'active' : ''}" data-tier="${t}">
        <span class="tier-label">Tier ${t}</span>
        <span class="tier-name">${info.name}</span>
      </button>
    `).join('');
    container.querySelectorAll('.wdb-tier-btn').forEach(btn => {
      btn.addEventListener('click', () => setTier(btn.dataset.tier));
    });
  }

  function _renderSpeed() {
    const el = document.getElementById('wdb-speed');
    if (!el) return;
    const info = TIER_SPEEDS[_tier];
    el.innerHTML = `<strong>${info.label}</strong><br>${info.speed}`;
  }

  function _wireReset() {
    const btn = document.getElementById('wdb-reset-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (btn.dataset.busy) return;
      btn.dataset.busy = '1';
      btn.textContent = '↺ Resetting…';
      try {
        const res = await fetch('/api/demo/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json',
                     'x-demo-reset': 'wren-demo-2026' }
        });
        const data = await res.json();
        if (res.ok) {
          btn.textContent = '✓ Done';
          setTimeout(() => window.location.reload(), 800);
        } else {
          btn.textContent = '✕ ' + (data.error || 'Failed');
          setTimeout(() => { btn.textContent = '↺ Reset'; delete btn.dataset.busy; }, 2000);
        }
      } catch (e) {
        btn.textContent = '✕ Error';
        setTimeout(() => { btn.textContent = '↺ Reset'; delete btn.dataset.busy; }, 2000);
      }
    });
  }

  let _panelOpen = false;

  function _togglePanel() {
    _panelOpen ? _closePanel() : _openPanel();
  }

  function _openPanel() {
    _panelOpen = true;
    const badge = document.getElementById('wren-demo-badge');
    const panel = document.getElementById('wren-demo-panel');
    if (badge) badge.style.display = 'none';
    if (panel) panel.classList.add('open');
    _renderRoles(); // re-render in case JWT changed
  }

  function _closePanel() {
    _panelOpen = false;
    const badge = document.getElementById('wren-demo-badge');
    const panel = document.getElementById('wren-demo-panel');
    if (badge) {
      badge.innerHTML = _getBadgeLabel();
      badge.style.display = '';
    }
    if (panel) panel.classList.remove('open');
  }

  // ── Init ─────────────────────────────────────────────────────────────────────

  function _init() {
    if (document.getElementById('wren-demo-banner')) return;
    _buildBanner();
  }

  // DEMO_MODE gate: the floating "Demo controls" panel (Viewing as / AI hardware
  // tier / Reset) and the demo badge are sales-demo affordances only. They must
  // render ONLY when the backend reports it is a demo environment. Self-host
  // builds set DEMO_MODE=false (or leave it unset) -> /api/edition returns
  // demo:false -> nothing is injected. The live sales demo runs DEMO_MODE=true
  // -> demo:true -> controls render exactly as before.
  function _gateThenInit() {
    fetch('/api/edition', { credentials: 'same-origin', cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(info => { if (info && info.demo === true) _init(); })
      .catch(() => { /* no /api/edition or fetch failed -> stay hidden (fail closed) */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _gateThenInit);
  } else {
    _gateThenInit();
  }
})();
