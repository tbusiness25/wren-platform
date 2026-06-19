/* wren-app-shell.js v20260523
 * Tablet / phone MPA shell — EYLog-style bottom nav + left drawer.
 * Requires wren-core.js (window.Wren) loaded before this script.
 * Opts-in via meta tags: wren-edition, wren-app-page, wren-app-title.
 *
 * Pages that need the shell include:
 *   <meta name="wren-edition"  content="ladn">
 *   <meta name="wren-app-page" content="home">   ← drives active tab
 *   <meta name="wren-app-title" content="Children">
 *   <link rel="stylesheet" href="/css/wren-app-shell.css?v=20260515">
 *   <script src="/js/wren-core.js?v=20260515" defer></script>
 *   <script src="/js/wren-app-shell.js?v=20260515" defer></script>
 *
 * EY portal: add data-portal="ey" to <body> to suppress the left drawer.
 * The hamburger button is omitted from the topbar on EY pages.
 */

// ── Cross-shell guard ─────────────────────────────────────────────────────────
if (window.__wrenShellLoaded === 'v2') {
  console.error('[wren-app-shell] CONFLICT: wren-shell-v2.js is already loaded on this page. Only one shell per page!');
}
window.__wrenShellLoaded = 'app';

;(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────────
  const TOKEN_KEY          = 'wrenToken';
  const SESSION_TIMEOUT_MS = 15 * 60 * 1000;  // 15-minute idle window for EY tablets
  const SESSION_WARN_MS    = 14 * 60 * 1000;  // warn 1 min before

  let _sessionTimer, _sessionWarnTimer;

  // ── Quick-add actions for +Add button ─────────────────────────────────────────
  function _childContextParam() {
    // If on /ey/child/:id, pass ?child=:id to observation forms
    const m = location.pathname.match(/\/ey\/child\/(\d+)/);
    return m ? '?child=' + m[1] : '';
  }

  const ADD_ACTIONS = [
    { icon: '📝', label: 'Quick Observation', onClick: () => Wren.navigate('/ey/observation/new' + _childContextParam()) },
    { icon: '👥', label: 'Group Log',         onClick: () => Wren.navigate('/ey/log/select-action') },
    { icon: '😴', label: 'Sleep Check',       onClick: () => Wren.navigate('/ey/log/select-action') },
    { icon: '💊', label: 'Medicine',          onClick: () => Wren.navigate('/ey/log/select-action') },
    { icon: '🚑', label: 'Accident Report',   onClick: () => Wren.navigate('/ey/log/select-action') },
    { icon: '🛡️', label: 'Log Concern',       onClick: () => Wren.navigate('/ey/safeguarding/new' + _childContextParam()) },
  ];

  // EY "+" log menu — single entry point for everything you can log (EyLog-style).
  const LOG_ACTIONS = [
    { icon: '📖', label: 'Diary',        onClick: () => Wren.navigate('/ey/diary') },
    { icon: '📝', label: 'Observation',  onClick: () => Wren.navigate('/ey/observation/new' + _childContextParam()) },
    { icon: '💊', label: 'Medicine',     onClick: () => Wren.navigate('/ey/medicine/new' + _childContextParam()) },
    { icon: '🚑', label: 'Accident',     onClick: () => Wren.navigate('/ey/incident/new' + _childContextParam()) },
    { icon: '🛡️', label: 'Safeguarding', onClick: () => Wren.navigate('/ey/safeguarding/new' + _childContextParam()) },
    { icon: '📄', label: 'Report',       onClick: () => Wren.navigate('/ey/reports/summative') },
  ];

  const FRAMEWORKS = ['EYFS', 'B25', 'CFE', 'COEL', 'SEND', 'Phonics', 'Montessori'];

  // ── Meta helper ───────────────────────────────────────────────────────────────
  const _meta = name => document.querySelector(`meta[name="${name}"]`)?.content ?? null;

  // ── HTML escape ───────────────────────────────────────────────────────────────
  const _esc = s => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ── Auth gate ─────────────────────────────────────────────────────────────────
  function _authGate() {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) {
      const ret = encodeURIComponent(location.pathname + location.search);
      location.replace('/login.html?return=' + ret);
      return null;
    }
    let payload;
    try {
      payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    } catch {
      payload = null;
    }
    if (!payload || (payload.exp && payload.exp * 1000 < Date.now())) {
      sessionStorage.removeItem(TOKEN_KEY);
      const ret = encodeURIComponent(location.pathname + location.search);
      location.replace('/login.html?return=' + ret);
      return null;
    }
    return payload;
  }

  // ── Session idle timer ────────────────────────────────────────────────────────
  function _resetIdleTimer() {
    clearTimeout(_sessionTimer);
    clearTimeout(_sessionWarnTimer);
    const warn = document.getElementById('wren-session-warning');
    if (warn) warn.hidden = true;
    _sessionWarnTimer = setTimeout(() => {
      const w = document.getElementById('wren-session-warning');
      if (w) w.hidden = false;
    }, SESSION_WARN_MS);
    _sessionTimer = setTimeout(() => {
      if (window.Wren) {
        Wren.toast('Session expired — please sign in again', 'warning');
        Wren.logout();
      } else {
        sessionStorage.removeItem(TOKEN_KEY);
        location.href = '/login.html';
      }
    }, SESSION_TIMEOUT_MS);
  }

  function _attachIdleListeners() {
    ['click', 'touchstart', 'keydown', 'scroll'].forEach(ev =>
      document.addEventListener(ev, _resetIdleTimer, { passive: true })
    );
  }

  // ── Topbar ────────────────────────────────────────────────────────────────────
  function _buildTopbar(user) {
    const title   = _meta('wren-app-title') || 'Wren';
    const initial = (user?.first_name || user?.name || '?').charAt(0).toUpperCase();
    const isEY    = document.body.dataset.portal === 'ey' || location.pathname.startsWith('/ey/');

    const el = document.createElement('header');
    el.id = 'wren-app-topbar';
    el.setAttribute('role', 'banner');

    // EY portal: no hamburger — logo left, actions right only
    const hamburgerHtml = isEY ? '' : `
      <button id="wren-app-hamburger" class="wren-app-hamburger" aria-label="Open navigation"
              aria-expanded="false" aria-controls="wren-app-drawer-left">
        <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5"
             viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 12h18M3 6h18M3 18h18"/>
        </svg>
      </button>`;

    // EY: a Back button on every page except Home (returns to the previous page,
    // e.g. back to the More menu instead of jumping Home). (Wrentest 2026-06-18.)
    const _onEYHome = /^\/ey\/home\/?$/.test(location.pathname);
    const backHtml = (isEY && !_onEYHome) ? `
      <button id="wren-app-back" class="wren-app-hamburger" aria-label="Back" style="font-size:1.6rem;line-height:1;font-weight:700">‹</button>` : '';

    el.innerHTML = `
      ${hamburgerHtml}${backHtml}
      <a href="/ey/home" class="wren-app-logo" aria-label="Wren home">
        <div class="wren-logo"><span class="logo-w">w</span><span class="logo-ren">ren</span></div>
      </a>
      <span id="wren-app-title" class="wren-app-title" aria-live="polite" aria-atomic="true">
        ${_esc(title)}
      </span>
      <div class="wren-app-topbar-actions">
        <button id="wren-app-notif-btn" class="wren-app-topbar-btn" aria-label="Notifications" aria-haspopup="true">
          <span aria-hidden="true" style="font-size:1.2rem">🔔</span>
          <span id="wren-app-notif-badge" class="wren-app-badge" hidden aria-label="unread notifications"></span>
        </button>
        <a href="/ey/settings" id="wren-app-avatar" class="wren-app-avatar" aria-label="My account">
          ${_esc(initial)}
        </a>
      </div>`;

    var _backBtn = el.querySelector('#wren-app-back');
    if (_backBtn) _backBtn.addEventListener('click', function () {
      if (history.length > 1) history.back(); else Wren.navigate('/ey/home');
    });

    // Keep --topbar-h CSS var in sync (matches wren-shell-v2 pattern)
    requestAnimationFrame(() => {
      const h = el.offsetHeight;
      if (h > 0) document.documentElement.style.setProperty('--topbar-h', h + 'px');
    });
    new ResizeObserver(() => {
      const h = el.offsetHeight;
      if (h > 0) document.documentElement.style.setProperty('--topbar-h', h + 'px');
    }).observe(el);

    return el;
  }

  // ── Bottom nav ────────────────────────────────────────────────────────────────
  function _buildBottomNav() {
    const current = _meta('wren-app-page') || '';
    // 'home' meta also lights the Children tab (the child grid is the home landing).
    const active  = (...tabs) => tabs.indexOf(current) !== -1 ? ' active' : '';

    const el = document.createElement('nav');
    el.id = 'wren-app-bottom';
    el.setAttribute('role', 'navigation');
    el.setAttribute('aria-label', 'Main tabs');
    // EyLog mental model: Children · Diary · ＋Observation (priority FAB) · Journey · More
    el.innerHTML = `
      <a href="/ey/home"  class="wren-app-tab${active('home','children')}"  data-tab="children"  aria-label="Children">
        <span class="wren-app-tab-icon" aria-hidden="true">👶</span>
        <span class="wren-app-tab-label">Children</span>
      </a>
      <a href="/ey/diary" class="wren-app-tab${active('diary')}" data-tab="diary" aria-label="Diary">
        <span class="wren-app-tab-icon" aria-hidden="true">📖</span>
        <span class="wren-app-tab-label">Diary</span>
      </a>
      <div class="wren-app-tab wren-app-tab-add" role="presentation">
        <button id="wren-app-add-btn" class="wren-app-tab-add-btn" aria-label="New observation" aria-haspopup="true">
          <span aria-hidden="true" style="font-size:1.7rem;font-weight:700;line-height:1">+</span>
        </button>
      </div>
      <a href="/ey/journey" class="wren-app-tab${active('journey')}" data-tab="journey" aria-label="Learning Journey">
        <span class="wren-app-tab-icon" aria-hidden="true">🌱</span>
        <span class="wren-app-tab-label">Journey</span>
      </a>
      <a href="/ey/more"  class="wren-app-tab${active('more')}"  data-tab="more"  aria-label="More">
        <span class="wren-app-tab-icon" aria-hidden="true" style="letter-spacing:-0.05em">•••</span>
        <span class="wren-app-tab-label">More</span>
      </a>`;
    return el;
  }

  // ── Left drawer ───────────────────────────────────────────────────────────────
  function _buildDrawer() {
    const backdrop = document.createElement('div');
    backdrop.className = 'wren-app-drawer-backdrop';
    backdrop.id = 'wren-app-drawer-backdrop';

    const activeFramework = localStorage.getItem('wrenActiveFramework') || 'EYFS';
    const chips = FRAMEWORKS.map(f =>
      `<button class="wren-app-drawer-framework-chip${f === activeFramework ? ' active' : ''}"
               data-fw="${f}" aria-pressed="${f === activeFramework}">${f}</button>`
    ).join('');

    const drawer = document.createElement('nav');
    drawer.id = 'wren-app-drawer-left';
    drawer.className = 'wren-app-drawer left';
    drawer.setAttribute('role', 'navigation');
    drawer.setAttribute('aria-label', 'Side navigation');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.innerHTML = `
      <div class="wren-app-drawer-header">
        <div class="wren-logo">
          <span class="logo-w">w</span><span class="logo-ren">ren</span>
        </div>
        <button id="wren-app-drawer-close" class="wren-app-drawer-close-btn" aria-label="Close navigation">✕</button>
      </div>
      <div class="wren-app-drawer-body">
        <div class="wren-app-drawer-group">
          <div class="wren-app-drawer-group-label">Framework</div>
          <div class="wren-app-drawer-framework-chips">${chips}</div>
        </div>
        <div class="wren-app-drawer-group">
          <div class="wren-app-drawer-group-label">Pages</div>
          <a href="/ey/drafts"     class="wren-app-drawer-item" role="menuitem">
            <span class="wren-app-drawer-item-icon" aria-hidden="true">✏️</span>Drafts
            <span id="wren-app-draft-badge" class="wren-app-drawer-item-badge" hidden>0</span>
          </a>
          <a href="/ey/trackers"   class="wren-app-drawer-item" role="menuitem">
            <span class="wren-app-drawer-item-icon" aria-hidden="true">📊</span>Trackers
          </a>
          <a href="/ey/activities" class="wren-app-drawer-item" role="menuitem">
            <span class="wren-app-drawer-item-icon" aria-hidden="true">🎨</span>Activities
          </a>
          <a href="/ey/reports"    class="wren-app-drawer-item" role="menuitem">
            <span class="wren-app-drawer-item-icon" aria-hidden="true">📄</span>Reports
          </a>
        </div>
        <div class="wren-app-drawer-group">
          <div class="wren-app-drawer-group-label">Settings</div>
          <a href="/ey/settings"       class="wren-app-drawer-item" role="menuitem">
            <span class="wren-app-drawer-item-icon" aria-hidden="true">👤</span>Profile
          </a>
          <a href="/ey/inbox"          class="wren-app-drawer-item" role="menuitem">
            <span class="wren-app-drawer-item-icon" aria-hidden="true">🔔</span>Notifications
          </a>
          <button class="wren-app-drawer-item wren-app-drawer-signout" role="menuitem">
            <span class="wren-app-drawer-item-icon" aria-hidden="true">🚪</span>Sign Out
          </button>
        </div>
      </div>`;

    return { backdrop, drawer };
  }

  // ── Action sheet ──────────────────────────────────────────────────────────────
  function _buildActionSheet() {
    const backdrop = document.createElement('div');
    backdrop.className = 'wren-app-drawer-backdrop';
    backdrop.id = 'wren-action-sheet-backdrop';

    const sheet = document.createElement('div');
    sheet.id = 'wren-action-sheet';
    sheet.className = 'wren-app-action-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Quick actions');
    sheet.setAttribute('aria-hidden', 'true');
    sheet.innerHTML =
      '<div class="wren-app-action-sheet-handle" role="presentation"></div>' +
      '<div class="wren-app-action-sheet-grid" id="wren-action-sheet-grid"></div>';

    return { backdrop, sheet };
  }

  // ── Session warning bar ───────────────────────────────────────────────────────
  function _buildSessionWarning() {
    const el = document.createElement('div');
    el.id = 'wren-session-warning';
    el.hidden = true;
    el.setAttribute('role', 'alert');
    el.setAttribute('aria-live', 'assertive');
    el.innerHTML =
      '⏱ Your session expires in 1 minute. ' +
      '<button id="wren-session-stay" class="wren-session-stay-btn">Stay signed in</button>';
    return el;
  }

  // ── Drawer open / close ───────────────────────────────────────────────────────
  function _openDrawer(drawer, backdrop) {
    backdrop.classList.add('open');
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    const hamburger = document.getElementById('wren-app-hamburger');
    if (hamburger) hamburger.setAttribute('aria-expanded', 'true');
    // Focus first focusable item in drawer
    const first = drawer.querySelector('button, a, [tabindex]');
    if (first) requestAnimationFrame(() => first.focus());
  }

  function _closeDrawer(drawer, backdrop) {
    backdrop.classList.remove('open');
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    const hamburger = document.getElementById('wren-app-hamburger');
    if (hamburger) {
      hamburger.setAttribute('aria-expanded', 'false');
      hamburger.focus();
    }
  }

  // ── Swipe-left-to-close gesture ───────────────────────────────────────────────
  function _attachSwipeClose(drawer, backdrop) {
    let startX = 0, startY = 0;
    drawer.addEventListener('touchstart', e => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });
    drawer.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - startX;
      const dy = Math.abs(e.changedTouches[0].clientY - startY);
      if (dx < -60 && dy < Math.abs(dx)) _closeDrawer(drawer, backdrop);
    }, { passive: true });
  }

  // ── Async loaders ─────────────────────────────────────────────────────────────
  function _loadNotificationCount() {
    if (!window.Wren) return;
    Wren.api('/api/notifications/unread-count').then(data => {
      const count = data?.count ?? 0;
      if (count > 0) {
        const badge = document.getElementById('wren-app-notif-badge');
        if (badge) { badge.textContent = count > 99 ? '99+' : String(count); badge.hidden = false; }
      }
    }).catch(() => {});
  }

  function _loadDraftCount() {
    if (!window.Wren) return;
    Wren.api('/api/observations?status=draft&limit=0').then(data => {
      const count = data?.total ?? data?.count ?? 0;
      if (count > 0) {
        const badge = document.getElementById('wren-app-draft-badge');
        if (badge) { badge.textContent = count > 99 ? '99+' : String(count); badge.hidden = false; }
      }
    }).catch(() => {});
  }

  // ── Offline outbox badge (offlineobs-20260608) ────────────────────────────────
  // Reflects the IndexedDB obs-outbox queue on the Drafts drawer badge so staff
  // always see how many observations are waiting to sync. Purely additive — only
  // active on pages that load wren-obs-outbox.js (the EY observation flow).
  function _setOutboxBadge(detail) {
    const badge = document.getElementById('wren-app-draft-badge');
    if (!badge) return;
    const c = detail || { pending: 0, syncing: 0, failed: 0 };
    const n = (c.pending || 0) + (c.syncing || 0) + (c.failed || 0);
    if (n > 0) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.hidden = false;
      badge.style.background = c.failed ? 'var(--c-red, #ef4444)' : '';
    } else {
      badge.hidden = true;
      badge.style.background = '';
    }
  }
  function _initOutboxBadge() {
    if (!window.WrenObsOutbox) return;
    window.addEventListener('wren:outbox-changed', e => _setOutboxBadge(e.detail));
    WrenObsOutbox.counts().then(_setOutboxBadge).catch(() => {});
  }

  // ── Chat widget ───────────────────────────────────────────────────────────────
  function _loadChatWidget() {
    const chatMeta = _meta('wren-app-chat');
    if (chatMeta === 'off') return;
    const script = document.createElement('script');
    script.src = '/js/wren-chat.js?v=2026060801';
    document.head.appendChild(script);
  }

  // ── Voice capture widget ──────────────────────────────────────────────────────
  function _loadVoiceCaptureWidget() {
    if (document.getElementById('wren-vc-btn')) return;
    const script = document.createElement('script');
    script.src = '/js/wren-voice-capture.js?v=2026061601';
    document.head.appendChild(script);
  }

  // ── Main init ─────────────────────────────────────────────────────────────────
  function _init() {
    // 1. Auth gate — redirects if not authenticated
    const jwtPayload = _authGate();
    if (!jwtPayload) return;

    const user = (window.Wren ? Wren.getUser() : null) || jwtPayload;

    document.body.classList.add('wren-app-shell');
    if (_meta('wren-app-no-bottom-nav') === 'true') document.body.classList.add('no-bottom-nav');

    // 2. Session warning bar — prepended first so it's always visible
    const sessionWarning = _buildSessionWarning();
    document.body.prepend(sessionWarning);

    // 3. Snapshot body children before we restructure (excludes session warning)
    const existingChildren = [...document.body.childNodes].filter(n => n !== sessionWarning);

    // 4. Build topbar
    const topbar = _buildTopbar(user);
    document.body.prepend(topbar);

    // 5. Wrap existing content in <main>
    const main = document.createElement('main');
    main.id = 'wren-app-content';
    main.setAttribute('role', 'main');
    main.setAttribute('tabindex', '-1');
    existingChildren.forEach(child => main.appendChild(child));
    document.body.appendChild(main);

    // 6. Bottom nav
    const bottomNav = _buildBottomNav();
    document.body.appendChild(bottomNav);

    // 7. Drawer — only for non-EY portals
    const isEY = document.body.dataset.portal === 'ey' || location.pathname.startsWith('/ey/');
    let drawer = null, drawerBackdrop = null;

    if (!isEY) {
      const drawerResult = _buildDrawer();
      drawerBackdrop = drawerResult.backdrop;
      drawer = drawerResult.drawer;
      document.body.appendChild(drawerBackdrop);
      document.body.appendChild(drawer);
    }

    // 8. Action sheet
    const { backdrop: sheetBackdrop, sheet } = _buildActionSheet();
    document.body.appendChild(sheetBackdrop);
    document.body.appendChild(sheet);

    // ── Wire up hamburger (non-EY only) ────────────────────────────────────────
    if (!isEY && drawer && drawerBackdrop) {
      const hamburger = topbar.querySelector('#wren-app-hamburger');
      if (hamburger) hamburger.addEventListener('click', () => _openDrawer(drawer, drawerBackdrop));

      drawerBackdrop.addEventListener('click', () => _closeDrawer(drawer, drawerBackdrop));

      drawer.querySelector('#wren-app-drawer-close').addEventListener('click', () =>
        _closeDrawer(drawer, drawerBackdrop)
      );

      // ── Framework chips ─────────────────────────────────────────────────────
      drawer.querySelectorAll('[data-fw]').forEach(chip => {
        chip.addEventListener('click', () => {
          const fw = chip.dataset.fw;
          localStorage.setItem('wrenActiveFramework', fw);
          drawer.querySelectorAll('[data-fw]').forEach(c => {
            const isActive = c.dataset.fw === fw;
            c.classList.toggle('active', isActive);
            c.setAttribute('aria-pressed', String(isActive));
          });
          _closeDrawer(drawer, drawerBackdrop);
          if (window.Wren) Wren.toast('Switched to ' + fw, 'success', 2000);
        });
      });

      // ── Sign out button ─────────────────────────────────────────────────────
      drawer.querySelector('.wren-app-drawer-signout').addEventListener('click', () => {
        if (window.Wren) Wren.logout();
        else { sessionStorage.removeItem(TOKEN_KEY); location.href = '/login.html'; }
      });

      // ── Swipe-left-to-close ───────────────────────────────────────────────
      _attachSwipeClose(drawer, drawerBackdrop);
    }

    // ── Center FAB = ＋Observation (priority action, EyLog-style) ────────────────
    // EY portal: jump straight into the observation flow, carrying child context.
    // Non-EY portals keep the multi-action quick-add sheet.
    bottomNav.querySelector('#wren-app-add-btn').addEventListener('click', e => {
      e.stopPropagation();
      if (isEY) {
        Wren.actionSheet(LOG_ACTIONS);   // + opens the log menu (Diary/Obs/Medicine/Accident/Safeguarding/Report)
      } else if (window.Wren) {
        Wren.actionSheet(ADD_ACTIONS);
      }
    });

    sheetBackdrop.addEventListener('click', () => {
      if (window.Wren) Wren.closeActionSheet();
    });

    // ── Session warning stay button ─────────────────────────────────────────────
    sessionWarning.querySelector('#wren-session-stay').addEventListener('click', () => {
      _resetIdleTimer();
      sessionWarning.hidden = true;
    });

    // ── Keyboard: Escape closes overlays ───────────────────────────────────────
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (!isEY && drawer && drawer.classList.contains('open')) {
          _closeDrawer(drawer, drawerBackdrop);
        } else if (window.Wren) {
          Wren.closeActionSheet();
        }
      }
    });

    // ── Async background loads ──────────────────────────────────────────────────
    _loadNotificationCount();
    setInterval(_loadNotificationCount, 60000);   // live-refresh the bell badge (was load-once)
    if (!isEY) _loadDraftCount();  // draft badge lives in the left drawer (non-EY only)
    _initOutboxBadge();            // offline obs-outbox queue → drawer badge (when present)
    _loadChatWidget();
    _loadVoiceCaptureWidget();

    // ── Session idle timer ──────────────────────────────────────────────────────
    _attachIdleListeners();
    _resetIdleTimer();

    // ── Expose reset for external use ───────────────────────────────────────────
    window.WrenAppShell = { resetIdleTimer: _resetIdleTimer };

    // ── PWA head tags (EY app installability) ────────────────────────────────────
    // The /ey/* pages don't carry the manifest / apple meta in their own <head>, so
    // inject them here (idempotent). Without this the app isn't installable from its
    // real entry point and iOS gets no Add-to-Home-Screen icon.
    if (isEY) {
      try {
        var _head = document.head;
        var _ensureHead = function (sel, make) { if (!_head.querySelector(sel)) _head.appendChild(make()); };
        var _meta = function (name, content) { var m = document.createElement('meta'); m.name = name; m.content = content; return m; };
        _ensureHead('link[rel="manifest"]', function () { var l = document.createElement('link'); l.rel = 'manifest'; l.href = '/manifest.webmanifest'; return l; });
        _ensureHead('meta[name="theme-color"]', function () { return _meta('theme-color', '#0f172a'); });
        _ensureHead('meta[name="apple-mobile-web-app-capable"]', function () { return _meta('apple-mobile-web-app-capable', 'yes'); });
        _ensureHead('meta[name="apple-mobile-web-app-status-bar-style"]', function () { return _meta('apple-mobile-web-app-status-bar-style', 'black-translucent'); });
        _ensureHead('meta[name="apple-mobile-web-app-title"]', function () { return _meta('apple-mobile-web-app-title', 'Your Nursery EY'); });
        _ensureHead('link[rel="apple-touch-icon"]', function () { var l = document.createElement('link'); l.rel = 'apple-touch-icon'; l.href = '/little-angels-logo.png'; return l; });
      } catch (e) { /* non-fatal */ }
    }

    // ── Web Push helpers ─────────────────────────────────────────────────────────
    function _urlB64ToUint8(b64) {
      const pad = '='.repeat((4 - (b64.length % 4)) % 4);
      const s = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
      const raw = atob(s); const out = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
      return out;
    }
    async function _syncPushSubscription(force) {
      try {
        if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
        if (Notification.permission === 'denied') return;
        if (Notification.permission === 'default') {
          if (!force) return;                       // never auto-prompt — only on explicit opt-in
          if ((await Notification.requestPermission()) !== 'granted') return;
        }
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          const k = await Wren.api('/api/notifications/vapid-public-key').catch(() => null);
          if (!k || !k.key) return;
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: _urlB64ToUint8(k.key) });
        }
        await Wren.api('/api/notifications/push-subscribe', { method: 'POST', body: { subscription: sub, user_agent: navigator.userAgent } });
        if (force && window.Wren && Wren.toast) Wren.toast('Notifications enabled on this device', 'success');
      } catch (e) { console.warn('[wren-push] subscribe failed', e); }
    }
    if (window.Wren) window.Wren.enablePush = function () { return _syncPushSubscription(true); };

    // ── Service worker (EY portal offline-first) ─────────────────────────────────
    if (isEY && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then(() => { _syncPushSubscription(false); })   // re-sync silently if already granted
        .catch(err => { console.warn('[wren-sw] SW registration failed', err); });
    }

    // ── Fire wren:ready (same event wren-shell-v2 fires — page JS hooks this) ───
    document.dispatchEvent(new CustomEvent('wren:ready', { detail: { user } }));
  }

  // Run after DOM + defer scripts are ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

})();
