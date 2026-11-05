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
  // HR is personal-device use at home (no child data) — 60-min idle; EY tablets stay at 15.
  const _IS_HR_PORTAL      = document.body.dataset.portal === 'hr';
  const SESSION_TIMEOUT_MS = (_IS_HR_PORTAL ? 60 : 15) * 60 * 1000;
  const SESSION_WARN_MS    = SESSION_TIMEOUT_MS - 60 * 1000;  // warn 1 min before

  let _sessionTimer, _sessionWarnTimer;

  // ── Quick-add actions for +Add button ─────────────────────────────────────────
  function _childContextParam() {
    // If on /ey/child/:id, pass ?child=:id to observation forms
    const m = location.pathname.match(/\/ey\/child\/(\d+)/);
    return m ? '?child=' + m[1] : '';
  }

  // Prompt 50: carry the live /ey/home child multi-select into nav links as
  // ?children=1,2,3 (same selection key Daily Diary / Learning Journey read).
  function _selectionChildrenParam() {
    try {
      const raw = sessionStorage.getItem('wren.ey.selection');
      if (!raw) return '';
      const sel = JSON.parse(raw);
      const ttl = 30 * 60 * 1000;
      if (sel && Array.isArray(sel.childIds) && sel.childIds.length &&
          (!sel.timestamp || (Date.now() - sel.timestamp) <= ttl)) {
        return '?children=' + sel.childIds.join(',');
      }
    } catch (_) {}
    return '';
  }

  // b238 (2026-08-27, Toby's walkthrough §10) — "More does not go back."
  // The More tab is a plain link, so tapping it while already on the More page
  // was a no-op and staff had to hunt for a way out. Make the second tap close:
  // history.back() when this page was actually navigated to from inside the app,
  // otherwise Children (a full reload / deep link has no in-app history to pop).
  function _wireMoreToggle(el) {
    const tab = el.querySelector('a[data-tab="more"]');
    if (!tab) return;
    const morePath = tab.getAttribute('href');
    tab.addEventListener('click', function (e) {
      const here = location.pathname.replace(/\/+$/, '');
      const there = String(morePath || '').replace(/\/+$/, '');
      if (here !== there && here !== there + '.html') return;   // not on More — normal navigation
      e.preventDefault();
      // history.length is 1 on a cold load/deep link; anything above means there
      // is a previous page in this tab worth returning to.
      if (window.history.length > 1 && document.referrer) window.history.back();
      else location.href = (there.indexOf('/ey/') === 0) ? '/ey/home' : '/index.html';
    });
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
  // diaryplus-20261028: staff reported "child → blue + → Diary doesn't work". On /ey/home
  // the picked children live in the grid selection, not the URL, so ＋ → Diary opened the
  // whole-room Group Diary for the first room with nobody chosen. Carry the selection the
  // same way home's own "Log → Diary" does: one child → ?child=, several → ?children=.
  // Only on /ey/home, where the selection is on screen; anywhere else a stale one is ignored.
  // inc-child-20261031: staff reported accidents "posting under a different child". The stored
  // selection outlives what is on screen (30-min TTL, restored on return to Home), so ＋ → Accident
  // pre-filled a child picked earlier. Carry it only while the selection bar is actually showing.
  function _diaryContextParam() {
    const own = _childContextParam();
    if (own || !/^\/ey\/home\/?$/.test(location.pathname)) return own;
    const bar = document.getElementById('ey-multiselect-bar');
    if (!bar || bar.hidden) return '';
    const sel = _selectionChildrenParam();
    if (!sel) return '';
    const ids = sel.slice('?children='.length).split(',');
    return ids.length === 1 ? '?child=' + ids[0] : sel;
  }

  const LOG_ACTIONS = [
    { icon: '📖', label: 'Diary',        onClick: () => Wren.navigate('/ey/diary/entry' + _diaryContextParam()) },
    { icon: '📝', label: 'Observation',  onClick: () => Wren.navigate('/ey/observation/new' + _childContextParam()) },
    // incpick-20261028: Medicine and Accident carry the Children-screen pick the same way —
    // the accident form had no child and refused to save when opened from here.
    { icon: '💊', label: 'Medicine',     onClick: () => Wren.navigate('/ey/medicine/new' + _diaryContextParam()) },
    { icon: '🚑', label: 'Accident',     onClick: () => Wren.navigate('/ey/incident/new' + _diaryContextParam()) },
    { icon: '🛡️', label: 'Safeguarding', onClick: () => Wren.navigate('/ey/safeguarding/new' + _childContextParam()) },
    // b193 — the third record: something happened to the SETTING (fire, intruder,
    // leak, lost child, outbreak, near miss), not to one child.
    { icon: '🏚️', label: 'Setting incident', onClick: () => Wren.navigate('/ey/setting-incident/new' + _childContextParam()) },
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
    // b95 (2026-07-17): HR portal (hr.example-nursery.co.uk, data-portal="hr")
    // adopts the app shell — EY-style chrome minus envelope + FAB. Every HR branch
    // below is gated on isHR so EY / parents / demo behaviour is unchanged.
    const isHR    = document.body.dataset.portal === 'hr';
    const homeHref = isHR ? '/index.html' : '/ey/home';

    // Same-tab visit breadcrumb for the back button below. document.referrer can't be
    // used here — this site sends Referrer-Policy: no-referrer (helmet default), so
    // document.referrer is always '' even for genuine in-app navigation. sessionStorage
    // persists across full-page (MPA) navigations within the same tab regardless of how
    // the user got here (link click, Wren.navigate, etc.), so "was this flag already set
    // before THIS page loaded" reliably means "reached via another page in this tab" vs.
    // a fresh tab's first load (bookmark / deep link / typed URL) — bughunt 2026-07-21.
    const _cameFromApp = sessionStorage.getItem('wrenAppVisited') === '1';
    sessionStorage.setItem('wrenAppVisited', '1');

    const el = document.createElement('header');
    el.id = 'wren-app-topbar';
    el.setAttribute('role', 'banner');

    // EY + HR portals: no hamburger — logo left, actions right only
    const hamburgerHtml = (isEY || isHR) ? '' : `
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
    const _onHRHome = isHR && /^\/(index\.html)?$/.test(location.pathname);
    const backHtml = ((isEY && !_onEYHome) || (isHR && !_onHRHome)) ? `
      <button id="wren-app-back" class="wren-app-hamburger" aria-label="Back" style="font-size:1.6rem;line-height:1;font-weight:700">‹</button>` : '';

    el.innerHTML = `
      ${hamburgerHtml}${backHtml}
      <a href="${homeHref}" class="wren-app-logo" aria-label="Wren home">
        <div class="wren-logo"><span class="logo-w">w</span><span class="logo-ren">ren</span></div>
      </a>
      <span id="wren-app-title" class="wren-app-title" aria-live="polite" aria-atomic="true">
        ${_esc(title)}
      </span>
      <div class="wren-app-topbar-actions">
        ${isEY ? `<a href="/ey/messages" id="wren-app-msg-btn" class="wren-app-topbar-btn" aria-label="Messages" style="position:relative;text-decoration:none">
          <span aria-hidden="true" style="font-size:1.2rem" data-wren-icon="message">✉️</span>
          <span id="wren-app-msg-badge" class="wren-app-badge" hidden aria-label="unread messages"></span>
        </a>` : ''}
        <button id="wren-app-ai-btn" class="wren-app-topbar-btn" aria-label="Wren AI" title="Wren AI">
          <span aria-hidden="true" style="font-size:1.2rem" data-wren-icon="bird">🪺</span>
        </button>
        <button id="wren-app-notif-btn" class="wren-app-topbar-btn" aria-label="Notifications" aria-haspopup="true">
          <span aria-hidden="true" style="font-size:1.2rem" data-wren-icon="bell">🔔</span>
          <span id="wren-app-notif-badge" class="wren-app-badge" hidden aria-label="unread notifications"></span>
        </button>
        <a href="${isHR ? '/my-profile.html' : '/ey/settings'}" id="wren-app-avatar" class="wren-app-avatar" aria-label="My account">
          ${_esc(initial)}
        </a>
      </div>`;
    if (window.WrenIcons) WrenIcons.hydrate(el);

    var _backBtn = el.querySelector('#wren-app-back');
    if (_backBtn) _backBtn.addEventListener('click', function () {
      // history.length > 1 is true even for a FRESH TAB whose only navigation was
      // straight to this page (bookmark / home-screen icon / deep link) — the
      // browser's initial blank document already counts as entry #1. history.back()
      // then lands on that blank about:blank doc, which has no chrome and no way out
      // (bughunt 2026-07-21). _cameFromApp (above) is a real same-tab breadcrumb.
      if (_cameFromApp && history.length > 1) history.back(); else Wren.navigate(homeHref);
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

    // Bottom-nav restructure (Prompt 27) — EY portal ONLY. Gate to data-portal="ey"
    // (or an /ey/ path) so parents/HR/admin bottom navs are untouched.
    const isEY = document.body.dataset.portal === 'ey' || location.pathname.startsWith('/ey/');
    // b95: HR variant gated separately — never reached on EY pages.
    const isHR = document.body.dataset.portal === 'hr';
    if (isEY) {
      // EY bar has 5 destinations split 2-left / 3-right of the ＋ FAB, so the fixed
      // FAB slot lands off-centre. Tag the bar so CSS can rebalance flex-grow (2026-07-11).
      el.classList.add('is-ey');
      // EyLog mental model, 5 tabs (2026-07-03, Toby item 8):
      //   Children · Observation Tracker · ＋(log) · Framework · Messages · More
      //  - Diary tab removed: ADD via the ＋ FAB menu, VIEW from the child profile.
      //  - Journey tab removed: a child's journey is viewed from their profile, not group-level.
      const path = location.pathname;
      const obsActive = /^\/ey\/obs-tracker/.test(path) ? ' active' : '';
      const fwActive  = (/^\/ey\/trackers/.test(path) || /^\/ey\/framework/.test(path)) ? ' active' : '';
      // diaryfix2 (2026-10-13): the Diary tab is removed — owner-requested (the office manager,
      // manager: "too many places for daily diary … get rid of the diary button at
      // the bottom and only use log diary"). Logging is child → Log → Diary; the
      // day's list + Publish to parents (/ey/diary) stays one tap away from the
      // diary page itself and from More → Children → "Today's Diary". Only this
      // one tab went; every other tab is unchanged.
      el.innerHTML = `
        <a href="/ey/home"  class="wren-app-tab${active('home','children')}"  data-tab="children"  aria-label="Children">
          <span class="wren-app-tab-icon" aria-hidden="true" data-wren-icon="child">👶</span>
          <span class="wren-app-tab-label">Children</span>
        </a>
        <a href="/ey/obs-tracker" class="wren-app-tab${obsActive}" data-tab="obstracker" aria-label="Observation Tracker">
          <span class="wren-app-tab-icon" aria-hidden="true" data-wren-icon="chart-up">📊</span>
          <span class="wren-app-tab-label">Obs Tracker</span>
        </a>
        <div class="wren-app-tab wren-app-tab-add" role="presentation">
          <button id="wren-app-add-btn" class="wren-app-tab-add-btn" aria-label="New observation" aria-haspopup="true">
            <span aria-hidden="true" style="font-size:1.7rem;font-weight:700;line-height:1">+</span>
          </button>
        </div>
        <a href="/ey/trackers" class="wren-app-tab${fwActive}" data-tab="frameworktracker" aria-label="Framework Tracker">
          <span class="wren-app-tab-icon" aria-hidden="true" data-wren-icon="tree">🌳</span>
          <span class="wren-app-tab-label">Framework</span>
        </a>
        <a href="/ey/more"  class="wren-app-tab${active('more')}"  data-tab="more"  aria-label="More">
          <span class="wren-app-tab-icon" aria-hidden="true" style="letter-spacing:-0.05em">•••</span>
          <span class="wren-app-tab-label">More</span>
        </a>`;
      if (window.WrenIcons) WrenIcons.hydrate(el);
      // Prompt 50: open the Obs Tracker tab already scoped to whatever children are
      // currently selected on /ey/home (rewrite href at click time — selection is live).
      const obsTab = el.querySelector('a[data-tab="obstracker"]');
      if (obsTab) obsTab.addEventListener('click', function () {
        obsTab.setAttribute('href', '/ey/obs-tracker' + _selectionChildrenParam());
      });
      // b238 (2026-08-27, Toby's walkthrough §10): "More does not go back."
      // Tapping More while already ON /ey/more closed nothing — staff had to find
      // another route out. Second tap now behaves like a close: step back if there
      // is somewhere to step back to, otherwise fall through to Children.
      _wireMoreToggle(el);
      return el;
    }

    // b95: HR portal bottom nav — Home / My Shifts / Absences / Policies / More.
    // No ＋ FAB (nothing to log in HR). Paths are root-relative: HR pages are
    // served at the root of hr.example-nursery.co.uk (no /hr/ prefix).
    //
    // b525 (2026-10-22): when public/js/wren-hr-nav.js is on the page, the bar is
    // rendered from WREN_HR_TABS instead — ONE declaration shared with the More
    // page and the desktop sidebar, so the three cannot drift. The b95 markup
    // below is kept verbatim as the fallback for any HR page that has not yet
    // added the script tag: nothing is removed, and such a page still gets a
    // working five-tab bar. See the header of wren-hr-nav.js for why.
    if (isHR && window.WREN_HR_TABS && window.WREN_HR_TABS.length) {
      el.classList.add('is-hr');
      el.innerHTML = window.WREN_HR_TABS.map(function (t) {
        var on = (t.page === current) ||
                 (Array.isArray(t.alsoActiveOn) && t.alsoActiveOn.indexOf(current) !== -1);
        var ic = '<span class="wren-app-tab-icon" aria-hidden="true"'
               + (t.icon ? ' data-wren-icon="' + t.icon + '"' : ' style="letter-spacing:-0.05em"')
               + '>' + (t.fallback || '') + '</span>';
        // The centre slot is the ＋ action BrightHR-shaped muscle memory reaches
        // for. It is an <a>, not the EY portal's <button>: there is one
        // destination, so it needs no JS and survives a failed script load.
        if (t.centre) {
          return '<div class="wren-app-tab wren-app-tab-add" role="presentation">'
               + '<a href="' + t.href + '" class="wren-app-tab-add-btn" aria-label="' + t.label + '"'
               + (on ? ' aria-current="page"' : '') + '>'
               + '<span aria-hidden="true" style="font-size:1.7rem;font-weight:700;line-height:1">+</span>'
               + '<span class="wren-sr-only">' + t.label + '</span></a></div>';
        }
        return '<a href="' + t.href + '" class="wren-app-tab' + (on ? ' active' : '') + '"'
             + ' data-tab="' + t.page + '" aria-label="' + t.label + '"'
             + (on ? ' aria-current="page"' : '') + '>'
             + ic
             + '<span class="wren-app-tab-label">' + t.label + '</span></a>';
      }).join('');
      if (window.WrenIcons) WrenIcons.hydrate(el);
      _wireMoreToggle(el);   // b238 — a second tap on More closes, as on EY
      return el;
    }
    if (isHR) {
      el.innerHTML = `
        <a href="/index.html" class="wren-app-tab${active('home')}" data-tab="home" aria-label="Home">
          <span class="wren-app-tab-icon" aria-hidden="true" data-wren-icon="home">🏠</span>
          <span class="wren-app-tab-label">Home</span>
        </a>
        <a href="/my-shifts.html" class="wren-app-tab${active('my-shifts')}" data-tab="my-shifts" aria-label="My Shifts">
          <span class="wren-app-tab-icon" aria-hidden="true" data-wren-icon="calendar">📆</span>
          <span class="wren-app-tab-label">My Shifts</span>
        </a>
        <a href="/my-absences.html" class="wren-app-tab${active('absences')}" data-tab="absences" aria-label="Absences">
          <span class="wren-app-tab-icon" aria-hidden="true" data-wren-icon="palm">🏖️</span>
          <span class="wren-app-tab-label">Absences</span>
        </a>
        <a href="/policies.html" class="wren-app-tab${active('policies')}" data-tab="policies" aria-label="Policies">
          <span class="wren-app-tab-icon" aria-hidden="true" data-wren-icon="document">📄</span>
          <span class="wren-app-tab-label">Policies</span>
        </a>
        <a href="/more.html" class="wren-app-tab${active('more')}" data-tab="more" aria-label="More">
          <span class="wren-app-tab-icon" aria-hidden="true" style="letter-spacing:-0.05em">•••</span>
          <span class="wren-app-tab-label">More</span>
        </a>`;
      if (window.WrenIcons) WrenIcons.hydrate(el);
      return el;
    }

    // Non-EY, non-HR portals: unchanged nav.
    el.innerHTML = `
      <a href="/ey/home"  class="wren-app-tab${active('home','children')}"  data-tab="children"  aria-label="Children">
        <span class="wren-app-tab-icon" aria-hidden="true" data-wren-icon="child">👶</span>
        <span class="wren-app-tab-label">Children</span>
      </a>
      <a href="/ey/diary" class="wren-app-tab${active('diary')}" data-tab="diary" aria-label="Diary">
        <span class="wren-app-tab-icon" aria-hidden="true" data-wren-icon="diary">📖</span>
        <span class="wren-app-tab-label">Diary</span>
      </a>
      <div class="wren-app-tab wren-app-tab-add" role="presentation">
        <button id="wren-app-add-btn" class="wren-app-tab-add-btn" aria-label="New observation" aria-haspopup="true">
          <span aria-hidden="true" style="font-size:1.7rem;font-weight:700;line-height:1">+</span>
        </button>
      </div>
      <a href="/ey/journey" class="wren-app-tab${active('journey')}" data-tab="journey" aria-label="All Observations">
        <span class="wren-app-tab-icon" aria-hidden="true" data-wren-icon="pencil">📝</span>
        <span class="wren-app-tab-label">All Obs</span>
      </a>
      <a href="/ey/more"  class="wren-app-tab${active('more')}"  data-tab="more"  aria-label="More">
        <span class="wren-app-tab-icon" aria-hidden="true" style="letter-spacing:-0.05em">•••</span>
        <span class="wren-app-tab-label">More</span>
      </a>`;
    if (window.WrenIcons) WrenIcons.hydrate(el);
    _wireMoreToggle(el);   // b238 — second tap on More closes, same as the EY nav
    return el;
  }

  // ── HR desktop sidebar (b525) ─────────────────────────────────────────────────
  // The HR portal has never had a sidebar: _buildTopBar drops the hamburger on
  // this portal, and NAV_MPA.hr in wren-shell-v2.js is rendered by nothing (see
  // the header of wren-hr-nav.js). On a phone the bottom bar plus More is the
  // whole menu and that is right; on an office PC it meant five tabs and a long
  // scrolling list, where every other Wren portal has a sidebar.
  //
  // So on a wide viewport the SAME declaration renders as a sidebar, with the
  // five tab destinations pinned at the top and the More groups beneath. CSS
  // swaps the two at 1024px: sidebar for the desk, tab bar for the thumb. Every
  // destination appears in both, so nothing is reachable in only one of them —
  // scripts/b525-verify-hr-nav.js asserts that.
  function _buildHrSidebar(user) {
    if (!window.WrenHrNav) return null;
    var role = (user && user.role) || '';
    var current = _meta('wren-app-page') || '';
    var path = location.pathname;

    var el = document.createElement('nav');
    el.id = 'wren-hr-sidebar';
    el.className = 'wren-hr-sidebar';
    el.setAttribute('role', 'navigation');
    el.setAttribute('aria-label', 'HR sections');

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function icon(it) {
      return '<span class="wren-hr-sb-icon" aria-hidden="true"'
           + (it.icon ? ' data-wren-icon="' + esc(it.icon) + '"' : '')
           + '>' + esc(it.fallback || '') + '</span>';
    }

    var tabs = (window.WREN_HR_TABS || []).map(function (t) {
      var on = (t.page === current) ||
               (Array.isArray(t.alsoActiveOn) && t.alsoActiveOn.indexOf(current) !== -1);
      return '<a href="' + esc(t.href) + '" class="wren-hr-sb-item wren-hr-sb-pinned'
           + (on ? ' active' : '') + '"' + (on ? ' aria-current="page"' : '') + '>'
           + icon(t) + '<span class="wren-hr-sb-label">' + esc(t.label) + '</span></a>';
    }).join('');

    var groups = window.WrenHrNav.groupsFor(role).map(function (g) {
      var items = g.items.map(function (it) {
        // `gate`d rows start hidden and are revealed by the same API call the
        // More page makes — a link that 403s is worse than no link (b512).
        var gated = it.gate ? ' hidden style="display:none"' : '';
        var attrs = ' data-nav-key="' + esc(it.key) + '"'
                  + (it.gate ? ' data-nav-gate="' + esc(it.gate) + '"' : '');
        if (!it.href) {
          return '<button type="button" class="wren-hr-sb-item'
               + (it.danger ? ' wren-hr-sb-danger' : '') + '" data-nav-action="'
               + esc(it.action) + '"' + attrs + gated + '>'
               + icon(it) + '<span class="wren-hr-sb-label">' + esc(it.label) + '</span></button>';
        }
        var on = path === it.href.split('?')[0];
        return '<a href="' + esc(it.href) + '" class="wren-hr-sb-item' + (on ? ' active' : '') + '"'
             + attrs + (on ? ' aria-current="page"' : '') + gated + '>'
             + icon(it) + '<span class="wren-hr-sb-label">' + esc(it.label) + '</span></a>';
      }).join('');
      return '<div class="wren-hr-sb-group" data-nav-group="' + esc(g.key) + '">'
           + '<div class="wren-hr-sb-group-label">' + esc(g.label) + '</div>'
           + items + '</div>';
    }).join('');

    el.innerHTML =
      // The two logo spans must NOT be flex children of the brand row: the row's
      // `gap` would fall between them and render the wordmark as "w ren".
      // They sit inside .wren-logo, which is the chrome's own wordmark wrapper.
      '<div class="wren-hr-sb-brand">'
      + '<span class="wren-logo"><span class="logo-w">w</span><span class="logo-ren">ren</span></span>'
      + '<span class="wren-hr-sb-portal">HR</span></div>'
      + '<div class="wren-hr-sb-body">'
      + '<div class="wren-hr-sb-group">' + tabs + '</div>'
      + groups
      + '</div>';
    if (window.WrenIcons) WrenIcons.hydrate(el);
    return el;
  }

  // Reorder / hide the sidebar from ladn.nav_layout, then reveal gated rows.
  // Both are best-effort: a failure leaves the shipped layout on screen.
  function _wireHrSidebar(el) {
    if (!el || !window.WrenHrNav) return;

    el.querySelectorAll('[data-nav-action]').forEach(function (btn) {
      btn.addEventListener('click', function () { _hrNavAction(btn.dataset.navAction); });
    });

    // The away-assistant row. WrenHrNav.awayGate() caches the server's answer
    // for the session, so the sidebar — which is on every HR page now — asks
    // once rather than logging an expected 403 on every screen.
    if (el.querySelector('[data-nav-gate="away-api"]')) {
      window.WrenHrNav.awayGate().then(function (allowed) {
        if (!allowed) return;
        el.querySelectorAll('[data-nav-gate="away-api"]').forEach(function (n) {
          // hidden alone loses to an inline display — set both.
          n.hidden = false; n.style.display = '';
        });
        el.querySelectorAll('.wren-hr-sb-group[data-nav-group]').forEach(function (g) {
          if (g.querySelector('[data-nav-gate="away-api"]')) { g.hidden = false; g.style.display = ''; }
        });
      });
    }

    window.WrenHrNav.fetchOverrides().then(function (sections) {
      if (!sections || !Object.keys(sections).length) return;
      Object.keys(sections).forEach(function (key) {
        var o = sections[key];
        if (o && o.hidden === true) {
          el.querySelectorAll('[data-nav-key="' + key + '"]').forEach(function (n) {
            n.hidden = true; n.style.display = 'none';
          });
        }
      });
      // A group every one of whose rows is now hidden would render as a dead
      // heading, so drop the heading too.
      el.querySelectorAll('.wren-hr-sb-group[data-nav-group]').forEach(function (g) {
        var live = Array.prototype.filter.call(g.querySelectorAll('.wren-hr-sb-item'), function (n) {
          return !n.hidden;
        });
        if (!live.length) { g.hidden = true; g.style.display = 'none'; }
      });
    });
  }

  // The three menu buttons that are an action rather than a destination. Shared
  // by the sidebar and the More page so "Sign Out" means one thing on this portal.
  function _hrNavAction(action) {
    if (action === 'sign-out') {
      if (window.Wren && Wren.confirmLogout) Wren.confirmLogout();
      else if (window.Wren) Wren.logout();
      else { sessionStorage.removeItem(TOKEN_KEY); location.href = '/login.html'; }
      return;
    }
    if (action === 'appearance') {
      if (window.WrenTheme && WrenTheme.open) WrenTheme.open();
      else if (window.Wren) Wren.toast('Still loading — try again in a second', 'warning');
      return;
    }
    if (action === 'report-bug') {
      if (window.WrenFeedback && WrenFeedback.open) WrenFeedback.open();
      else if (window.Wren) Wren.toast('Still loading — try again in a second', 'warning');
      return;
    }
    if (action === 'enable-push') {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        if (window.Wren) Wren.toast('Notifications are not supported on this device', 'warning');
        return;
      }
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then(function () { if (window.Wren && Wren.enablePush) return Wren.enablePush(); })
        .catch(function () { if (window.Wren) Wren.toast('Could not enable notifications', 'error'); });
    }
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
            <span class="wren-app-drawer-item-icon" aria-hidden="true" data-wren-icon="pencil">✏️</span>Drafts
            <span id="wren-app-draft-badge" class="wren-app-drawer-item-badge" hidden>0</span>
          </a>
          <a href="/ey/trackers"   class="wren-app-drawer-item" role="menuitem">
            <span class="wren-app-drawer-item-icon" aria-hidden="true" data-wren-icon="tree">📊</span>Trackers
          </a>
          <a href="/ey/activities" class="wren-app-drawer-item" role="menuitem">
            <span class="wren-app-drawer-item-icon" aria-hidden="true" data-wren-icon="palette">🎨</span>Activities
          </a>
          <a href="/ey/story-studio" class="wren-app-drawer-item" role="menuitem">
            <span class="wren-app-drawer-item-icon" aria-hidden="true" data-wren-icon="story">📖</span>Story Studio
          </a>
          <a href="/ey/reports"    class="wren-app-drawer-item" role="menuitem">
            <span class="wren-app-drawer-item-icon" aria-hidden="true" data-wren-icon="document-chart">📄</span>Reports
          </a>
          <a href="/ey/messages"   class="wren-app-drawer-item" role="menuitem">
            <span class="wren-app-drawer-item-icon" aria-hidden="true" data-wren-icon="message">💬</span>Messages
          </a>
        </div>
        <div class="wren-app-drawer-group">
          <div class="wren-app-drawer-group-label">Settings</div>
          <a href="/ey/settings"       class="wren-app-drawer-item" role="menuitem">
            <span class="wren-app-drawer-item-icon" aria-hidden="true" data-wren-icon="person">👤</span>Profile
          </a>
          <a href="/ey/inbox"          class="wren-app-drawer-item" role="menuitem">
            <span class="wren-app-drawer-item-icon" aria-hidden="true" data-wren-icon="bell">🔔</span>Notifications
          </a>
          <button class="wren-app-drawer-item wren-app-drawer-signout" role="menuitem">
            <span class="wren-app-drawer-item-icon" aria-hidden="true" data-wren-icon="logout">🚪</span>Sign Out
          </button>
        </div>
      </div>`;
    if (window.WrenIcons) WrenIcons.hydrate(drawer);

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
      const badge = document.getElementById('wren-app-notif-badge');
      if (!badge) return;
      if (count > 0) { badge.textContent = count > 99 ? '99+' : String(count); badge.hidden = false; }
      else badge.hidden = true;
    }).catch(() => {});
  }

  // ── Notifications panel (2026-07-03, Toby item 7 — the bell used to be inert) ──
  function _initNotifPanel() {
    const btn = document.getElementById('wren-app-notif-btn');
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = '1';

    let panel = null;
    function _close() { if (panel) { panel.remove(); panel = null; } }
    function _esc2(s) {
      return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function _ago(iso) {
      const s = (Date.now() - new Date(iso).getTime()) / 1000;
      if (s < 90) return 'just now';
      if (s < 3600) return Math.round(s / 60) + 'm ago';
      if (s < 86400) return Math.round(s / 3600) + 'h ago';
      return Math.round(s / 86400) + 'd ago';
    }

    btn.addEventListener('click', () => {
      if (panel) { _close(); return; }
      panel = document.createElement('div');
      panel.id = 'wren-app-notif-panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Notifications');
      panel.style.cssText =
        'position:fixed;top:calc(var(--topbar-h,56px) + 4px);right:8px;left:8px;max-width:420px;' +
        'margin-left:auto;z-index:500;background:var(--c-navy-mid,#0f172a);border:1px solid var(--c-border,#2d3748);' +
        'border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.5);max-height:70vh;display:flex;flex-direction:column;overflow:hidden';
      panel.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--c-border,#2d3748)">' +
        '<strong style="font-size:.92rem;color:var(--c-text,#f1f5f9)">Notifications</strong>' +
        '<button id="wren-notif-readall" style="background:none;border:none;color:var(--c-blue,#4a9abf);font-size:.78rem;font-weight:600;cursor:pointer">Mark all read</button>' +
        '</div><div id="wren-notif-list" style="overflow-y:auto;-webkit-overflow-scrolling:touch">' +
        '<div style="padding:20px;text-align:center;color:var(--c-muted,#94a3b8);font-size:.85rem">Loading…</div></div>';
      document.body.appendChild(panel);

      /* outside tap closes */
      setTimeout(() => {
        document.addEventListener('click', function _out(e) {
          if (panel && !panel.contains(e.target) && !btn.contains(e.target)) {
            _close(); document.removeEventListener('click', _out);
          }
        });
      }, 0);

      panel.querySelector('#wren-notif-readall').addEventListener('click', () => {
        Wren.api('/api/notifications/read-all', { method: 'POST' }).then(() => {
          _loadNotificationCount();
          panel.querySelectorAll('[data-notif-unread]').forEach(el => { el.style.opacity = '.55'; el.removeAttribute('data-notif-unread'); });
        }).catch(() => {});
      });

      Wren.api('/api/notifications?page=0').then(rows => {
        const list = panel && panel.querySelector('#wren-notif-list');
        if (!list) return;
        if (!Array.isArray(rows) || !rows.length) {
          list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--c-muted,#94a3b8);font-size:.85rem">🔕 Nothing yet — you\'re all caught up</div>';
          return;
        }
        list.innerHTML = rows.slice(0, 25).map(n =>
          '<div class="wren-notif-item" data-id="' + n.id + '"' + (n.read_at ? '' : ' data-notif-unread="1"') +
          (n.link ? ' data-link="' + _esc2(n.link) + '"' : '') +
          ' style="padding:11px 14px;border-bottom:1px solid rgba(45,55,72,.55);cursor:pointer;' + (n.read_at ? 'opacity:.55' : '') + '">' +
          '<div style="font-size:.85rem;font-weight:600;color:var(--c-text,#f1f5f9)">' + _esc2(n.title || n.category || 'Notification') + '</div>' +
          (n.body ? '<div style="font-size:.78rem;color:var(--c-muted,#94a3b8);margin-top:2px;line-height:1.35">' + _esc2(String(n.body).slice(0, 140)) + '</div>' : '') +
          '<div style="font-size:.7rem;color:var(--c-muted,#94a3b8);margin-top:3px">' + _ago(n.created_at) + '</div></div>'
        ).join('');
        list.querySelectorAll('.wren-notif-item').forEach(item => {
          item.addEventListener('click', () => {
            Wren.api('/api/notifications/' + item.dataset.id + '/read', { method: 'POST' }).catch(() => {});
            _loadNotificationCount();
            const link = item.dataset.link;
            if (link) { _close(); Wren.navigate(link); }
            else { item.style.opacity = '.55'; item.removeAttribute('data-notif-unread'); }
          });
        });
      }).catch(() => {
        const list = panel && panel.querySelector('#wren-notif-list');
        if (list) list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--c-muted,#94a3b8);font-size:.85rem">Could not load notifications</div>';
      });
    });
  }

  // ── Key Children nudge (2026-10-01) — EY portal only ─────────────────────────
  // A room's leaders (room_leader in that room, else its deputy — see
  // src/routes/key-children.js) get one card a day while their room still has a
  // child with no key person or no buddy. "Later" hides it until tomorrow for that
  // person on that device; the tablet is shared, so the key carries the staff id.
  function _initKeyChildrenNudge(user) {
    if (!window.Wren || !user || /\/ey\/key-children/.test(location.pathname)) return;
    const today = new Date().toLocaleDateString('en-CA');
    const key = 'wren.kcNudge.' + (user.id || user.staff_id || user.sub || 'me');
    try { if (localStorage.getItem(key) === today) return; } catch (_) {}
    Wren.api('/api/key-children/nudge').then(function (r) {
      if (!r || !r.show || !Array.isArray(r.rooms) || !r.rooms.length) return;
      if (document.getElementById('wren-doorbell-popup') || document.getElementById('wren-kc-nudge')) return;
      const esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
      const plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };
      const lines = r.rooms.map(function (g) {
        const bits = [];
        if (g.missing_kp) bits.push(plural(g.missing_kp, 'child has', 'children have') + ' no key person');
        if (g.missing_buddy) bits.push(plural(g.missing_buddy, 'child has', 'children have') + ' no buddy');
        return '<li style="margin:4px 0"><b>' + esc(g.room_name) + '</b>: ' + esc(bits.join(', ')) + '</li>';
      }).join('');
      const ov = document.createElement('div');
      ov.id = 'wren-kc-nudge';
      ov.setAttribute('role', 'dialog');
      ov.setAttribute('aria-label', 'Key Children need filling in');
      ov.style.cssText = 'position:fixed;inset:0;z-index:999;background:color-mix(in srgb, var(--c-bg) 72%, transparent);' +
        'display:flex;align-items:center;justify-content:center;padding:18px';
      ov.innerHTML =
        '<div style="width:100%;max-width:400px;background:var(--c-surface-solid);border:1px solid var(--c-border);' +
        'border-radius:16px;overflow:hidden">' +
          '<div style="padding:14px 16px;border-bottom:1px solid var(--c-border);display:flex;align-items:center;gap:10px">' +
            '<span style="font-size:1.5rem" aria-hidden="true">🔑</span>' +
            '<div style="font-weight:700;color:var(--c-text);font-size:.98rem">Key Children — please fill in your room</div></div>' +
          '<div style="padding:14px 16px;color:var(--c-text);font-size:.88rem;line-height:1.45">' +
            '<ul style="margin:0 0 10px;padding-left:18px">' + lines + '</ul>' +
            '<div style="color:var(--c-muted);font-size:.82rem">Every child needs a key person and a buddy. The list changes often, ' +
            'so Wren keeps it in one place: More → Children → Key Children. My Morning reads from it.</div></div>' +
          '<div style="padding:0 14px 14px;display:flex;flex-direction:column;gap:9px">' +
            '<button id="wren-kc-open" style="width:100%;border:none;border-radius:12px;padding:14px;font-weight:700;font-size:1rem;cursor:pointer;background:var(--c-blue);color:var(--c-on-blue);min-height:44px">Open Key Children</button>' +
            '<button id="wren-kc-later" style="width:100%;background:none;border:none;color:var(--c-muted);font-size:.85rem;padding:8px;cursor:pointer;min-height:44px">Later — remind me tomorrow</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(ov);
      function _close() { try { localStorage.setItem(key, today); } catch (_) {} if (ov.parentNode) ov.parentNode.removeChild(ov); }
      ov.querySelector('#wren-kc-later').addEventListener('click', _close);
      ov.querySelector('#wren-kc-open').addEventListener('click', function () {
        _close();
        if (Wren.navigate) Wren.navigate('/ey/key-children'); else location.href = '/ey/key-children';
      });
    }).catch(function () {});
  }

  // ── Door-ring popup (b99, 2026-07-17) — EY portal only ────────────────────────
  // Polls the intercom active-events feed and raises an urgent card when someone
  // rings the front door. Additive; reuses the notification-panel visual idiom.
  // Snapshot/stream degrade gracefully — the VTO isn't wired on-site yet.
  const _doorbellSeen = new Set();
  let _doorbellPopupOpen = false;
  function _initDoorbellWatcher() {
    if (!window.Wren) return;
    function _poll() {
      if (document.visibilityState === 'hidden' || _doorbellPopupOpen) return;
      Wren.api('/api/intercom/events/active').then(function (rows) {
        if (!Array.isArray(rows) || !rows.length) return;
        const ev = rows.find(function (e) { return !e.answered_by_staff_id && !_doorbellSeen.has(e.id); });
        if (ev) _showDoorbellPopup(ev);
      }).catch(function () {});
    }
    _poll();
    setInterval(_poll, 15000);
  }

  function _showDoorbellPopup(ev) {
    if (_doorbellPopupOpen) return;
    _doorbellPopupOpen = true;
    _doorbellSeen.add(ev.id);   // don't re-raise the same ring

    const ov = document.createElement('div');
    ov.id = 'wren-doorbell-popup';
    ov.setAttribute('role', 'alertdialog');
    ov.setAttribute('aria-label', 'Someone at the front door');
    ov.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(2,6,23,.72);' +
      'display:flex;align-items:center;justify-content:center;padding:18px';
    ov.innerHTML =
      '<div style="width:100%;max-width:380px;background:var(--c-navy-mid,#0f172a);border:1px solid var(--c-border,#2d3748);' +
      'border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.6);overflow:hidden">' +
        '<div style="padding:14px 16px;border-bottom:1px solid var(--c-border,#2d3748);display:flex;align-items:center;gap:10px">' +
          '<span style="font-size:1.5rem">🔔</span>' +
          '<div><div style="font-weight:700;color:var(--c-text,#f1f5f9);font-size:.98rem">Someone’s at the front door</div>' +
          '<div style="font-size:.74rem;color:var(--c-muted,#94a3b8)" id="wren-db-when"></div></div></div>' +
        '<div id="wren-db-snap" style="aspect-ratio:4/3;background:#0b1220;display:flex;align-items:center;justify-content:center;' +
        'color:var(--c-muted,#94a3b8);font-size:.82rem;text-align:center">' +
          '<div><div style="font-size:2rem">📷</div>No snapshot</div></div>' +
        '<div style="padding:14px;display:flex;flex-direction:column;gap:9px">' +
          '<button id="wren-db-answer" style="width:100%;border:none;border-radius:12px;padding:14px;font-weight:700;font-size:1rem;cursor:pointer;background:#22c55e;color:#0f172a">📞 Answer</button>' +
          '<button id="wren-db-open" style="width:100%;border:none;border-radius:12px;padding:14px;font-weight:700;font-size:1rem;cursor:pointer;background:var(--c-blue,#4a9abf);color:#0f172a">🔓 Buzz in</button>' +
          '<button id="wren-db-dismiss" style="width:100%;background:none;border:none;color:var(--c-muted,#94a3b8);font-size:.82rem;padding:6px;cursor:pointer">Dismiss</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);

    try {
      const s = (Date.now() - new Date(ev.triggered_at).getTime()) / 1000;
      const when = s < 90 ? 'just now' : (s < 3600 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago');
      const w = ov.querySelector('#wren-db-when'); if (w) w.textContent = 'Rang ' + when;
    } catch (_) {}

    // Best-effort snapshot (authed fetch → blob; <img src> can't carry the token).
    if (ev.snapshot_url) {
      fetch(ev.snapshot_url, { headers: Wren.authHeaders() })
        .then(function (r) { if (!r.ok) throw 0; return r.blob(); })
        .then(function (b) {
          const box = ov.querySelector('#wren-db-snap');
          if (box) box.innerHTML = '<img alt="Door snapshot" style="width:100%;height:100%;object-fit:cover" src="' + URL.createObjectURL(b) + '">';
        }).catch(function () {});
    }

    function _close() { if (ov.parentNode) ov.parentNode.removeChild(ov); _doorbellPopupOpen = false; }

    ov.querySelector('#wren-db-dismiss').addEventListener('click', _close);
    ov.querySelector('#wren-db-answer').addEventListener('click', function () {
      Wren.api('/api/intercom/events/' + ev.id + '/answer', { method: 'POST' }).catch(function () {});
      _close();
      Wren.navigate('/ey/door?event=' + ev.id);
    });
    ov.querySelector('#wren-db-open').addEventListener('click', function () {
      const btn = this; btn.disabled = true;
      Wren.api('/api/doorbell/open', { method: 'POST', body: { event_id: ev.id } }).then(function (r) {
        const ok = r && r.success;
        const msg = ok ? '🔓 Door opened' : (r && r.mode === 'dry_run' ? 'Simulated (logged) — door not wired' : 'Press logged');
        if (window.Wren && Wren.toast) Wren.toast(msg, ok ? 'success' : 'info', 3000);
        _close();
      }).catch(function () {
        if (window.Wren && Wren.toast) Wren.toast('Open failed', 'warning', 3000);
        btn.disabled = false;
      });
    });
  }

  // EY Messages tab badge — sum of unread across the user's threads.
  function _loadMessageBadge() {
    const badge = document.getElementById('wren-app-msg-badge');
    if (!badge || !window.Wren) return;
    Wren.api('/api/messages/threads').then(data => {
      const threads = (data && data.threads) || (Array.isArray(data) ? data : []);
      const n = threads.reduce((a, t) => a + (parseInt(t.unread_count, 10) || 0), 0);
      if (n > 0) { badge.textContent = n > 99 ? '99+' : String(n); badge.hidden = false; }
      else badge.hidden = true;
    }).catch(() => {});
  }

  // ── EY envelope dropdown (b97 2026-07-17) ─────────────────────────────────────
  // 2026-10-28 — middle-click / Ctrl-click opens rows and cards in a new tab (see wren-middle-click.js).
  if (!document.querySelector('script[src^="/js/wren-middle-click.js"]')) {
    const mc = document.createElement('script'); mc.src = '/js/wren-middle-click.js?v=1'; mc.defer = true;
    document.head.appendChild(mc);
  }
  // The topbar ✉️ used to hard-navigate to /ey/messages. It now opens a dropdown of
  // recent threads (unread bold + count), same idiom as the notifications panel next
  // to it, with an "Open messages" link at the bottom. Badge behaviour is unchanged
  // (_loadMessageBadge). EY-only: the button itself is only rendered on EY pages.
  function _initMsgPanel() {
    const btn = document.getElementById('wren-app-msg-btn');
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = '1';

    let panel = null;
    let _allThreads = [];   // full role-scoped list from the last fetch (badge math + mark-all/clear)
    function _close() { if (panel) { panel.remove(); panel = null; } }
    function _esc2(s) {
      return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function _ago(iso) {
      if (!iso) return '';
      const s = (Date.now() - new Date(iso).getTime()) / 1000;
      if (s < 90) return 'just now';
      if (s < 3600) return Math.round(s / 60) + 'm ago';
      if (s < 86400) return Math.round(s / 3600) + 'h ago';
      return Math.round(s / 86400) + 'd ago';
    }

    // "Mark all read" hits every unread thread (not just the 8 shown) via the
    // existing per-thread /thread/:id/read — there's no bulk endpoint.
    async function _markAllRead() {
      const unread = _allThreads.filter(t => (parseInt(t.unread_count, 10) || 0) > 0);
      try { await Promise.all(unread.map(t => Wren.api('/api/messages/thread/' + t.id + '/read', { method: 'POST' }))); } catch (e) {}
      _close();
      _loadMessageBadge();
    }
    // "Clear" archives the threads shown here (per-user flag, never deletes a
    // message — same /thread/:id/archive the full messages page uses). A new
    // reply un-archives it back into view naturally via the API's default filter.
    async function _clearThreads() {
      const shown = _allThreads.slice(0, 8);
      try { await Promise.all(shown.map(t => Wren.api('/api/messages/thread/' + t.id + '/archive', { method: 'POST' }))); } catch (e) {}
      _close();
      _loadMessageBadge();
    }

    btn.addEventListener('click', (e) => {
      e.preventDefault();          // the <a href="/ey/messages"> fallback stays for no-JS
      if (panel) { _close(); return; }
      panel = document.createElement('div');
      panel.id = 'wren-app-msg-panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Messages');
      panel.style.cssText =
        'position:fixed;top:calc(var(--topbar-h,56px) + 4px);right:8px;left:8px;max-width:420px;' +
        'margin-left:auto;z-index:500;background:var(--c-navy-mid,#0f172a);border:1px solid var(--c-border,#2d3748);' +
        'border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.5);max-height:70vh;display:flex;flex-direction:column;overflow:hidden';
      panel.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--c-border,#2d3748)">' +
        '<strong style="font-size:.92rem;color:var(--c-text,#f1f5f9)">Messages</strong>' +
        '<span style="display:flex;gap:10px">' +
        '<button id="wren-msg-markall" type="button" style="background:none;border:none;color:var(--c-blue,#4a9abf);font-size:.78rem;font-weight:600;cursor:pointer;padding:0">Mark all read</button>' +
        '<button id="wren-msg-clearall" type="button" style="background:none;border:none;color:var(--c-blue,#4a9abf);font-size:.78rem;font-weight:600;cursor:pointer;padding:0">Clear</button>' +
        '</span></div><div id="wren-msg-list" style="overflow-y:auto;-webkit-overflow-scrolling:touch;flex:1">' +
        '<div style="padding:20px;text-align:center;color:var(--c-muted,#94a3b8);font-size:.85rem">Loading…</div></div>' +
        '<a href="/ey/messages" id="wren-msg-open-all" style="display:block;padding:11px 14px;text-align:center;font-size:.85rem;' +
        'font-weight:600;color:var(--c-blue,#4a9abf);text-decoration:none;border-top:1px solid var(--c-border,#2d3748)">View all →</a>';
      document.body.appendChild(panel);

      panel.querySelector('#wren-msg-markall')?.addEventListener('click', ev => { ev.stopPropagation(); _markAllRead(); });
      panel.querySelector('#wren-msg-clearall')?.addEventListener('click', ev => { ev.stopPropagation(); _clearThreads(); });

      /* outside tap closes */
      setTimeout(() => {
        document.addEventListener('click', function _out(e2) {
          if (panel && !panel.contains(e2.target) && !btn.contains(e2.target)) {
            _close(); document.removeEventListener('click', _out);
          }
        });
      }, 0);

      Wren.api('/api/messages/threads').then(data => {
        const list = panel && panel.querySelector('#wren-msg-list');
        if (!list) return;
        const threads = (data && data.threads) || (Array.isArray(data) ? data : []);
        _allThreads = threads;
        if (!threads.length) {
          list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--c-muted,#94a3b8);font-size:.85rem">💬 No message threads yet</div>';
          return;
        }
        list.innerHTML = threads.slice(0, 8).map(t => {
          const unread = parseInt(t.unread_count, 10) || 0;
          return '<div class="wren-msg-item" data-id="' + t.id + '" role="button" tabindex="0"' +
            ' style="padding:11px 14px;border-bottom:1px solid rgba(45,55,72,.55);cursor:pointer;display:flex;align-items:center;gap:10px">' +
            '<div style="flex:1;min-width:0">' +
            '<div style="font-size:.85rem;color:var(--c-text,#f1f5f9);font-weight:' + (unread ? '700' : '500') + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
            _esc2(t.child_name || 'Thread') + '</div>' +
            '<div style="font-size:.78rem;color:var(--c-muted,#94a3b8);margin-top:2px;font-weight:' + (unread ? '600' : '400') + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
            _esc2(t.subject || '') + '</div>' +
            (t.last_message ? '<div style="font-size:.76rem;color:var(--c-muted,#94a3b8);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + _esc2(String(t.last_message).slice(0, 70)) + '</div>' : '') +
            '<div style="font-size:.7rem;color:var(--c-muted,#94a3b8);margin-top:3px">' + _ago(t.last_message_at || t.created_at) + '</div></div>' +
            (unread ? '<span style="background:var(--c-blue,#4a9abf);color:#fff;border-radius:99px;font-size:.68rem;padding:2px 8px;font-weight:700;flex-shrink:0">' + (unread > 99 ? '99+' : unread) + '</span>' : '') +
            '</div>';
        }).join('');
        list.querySelectorAll('.wren-msg-item').forEach(item => {
          const go = () => { _close(); Wren.navigate('/ey/messages?thread=' + item.dataset.id); };
          item.addEventListener('click', go);
          item.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
        });
      }).catch(() => {
        const list = panel && panel.querySelector('#wren-msg-list');
        if (list) list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--c-muted,#94a3b8);font-size:.85rem">Could not load messages</div>';
      });
    });
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
    script.src = '/js/wren-chat.js?v=20261020fbv';
    document.head.appendChild(script);
  }

  // ── Wren AI topbar button (b150) ─────────────────────────────────────────────
  // Opens the SAME chat surface as the floating widget (window.WrenChat, loaded by
  // _loadChatWidget() above) — never builds a second chat. Polls briefly in case
  // the async script hasn't finished loading/initing yet on a very fast click.
  function _initWrenAIButton() {
    const btn = document.getElementById('wren-app-ai-btn');
    if (!btn) return;
    function _tryOpen(attemptsLeft) {
      if (window.WrenChat) {
        if (!WrenChat.isReady()) WrenChat.init({});   // idempotent — builds the widget if not built yet
        if (WrenChat.isReady()) { WrenChat.open(); return; }
      }
      if (attemptsLeft <= 0) return;
      setTimeout(() => _tryOpen(attemptsLeft - 1), 150);
    }
    btn.addEventListener('click', () => _tryOpen(20));
  }

  // ── Voice capture widget ──────────────────────────────────────────────────────
  function _loadVoiceCaptureWidget() {
    if (document.getElementById('wren-vc-btn')) return;
    const script = document.createElement('script');
    script.src = '/js/wren-voice-capture.js?v=2026071501';
    document.head.appendChild(script);
  }

  // ── b354 (2026-09-24): a mic on every multi-line text field, app-wide ────────
  // Toby: "for all of the text entry boxes there can be the little microphones".
  // Loads wren-voice.js once (idempotent — most pages don't load it themselves;
  // observation-new.html already does and keeps working, attachTo() no-ops on a
  // textarea it's already touched) then sweeps the whole document, and again on
  // any DOM change so a form built by page JS after wren:ready still gets one.
  function _loadTextareaMic() {
    function sweep() { if (window.WrenVoice) WrenVoice.attachAll(document); }
    function afterLoad() {
      sweep();
      let pending = null;
      new MutationObserver(() => {
        clearTimeout(pending);
        pending = setTimeout(sweep, 200);
      }).observe(document.body, { childList: true, subtree: true });
    }
    if (window.WrenVoice) { afterLoad(); return; }
    const script = document.createElement('script');
    script.src = '/js/wren-voice.js?v=20261020fbv';
    script.addEventListener('load', afterLoad);
    document.head.appendChild(script);
  }

  // ── Embedded-page detection (b521, 2026-10-20) ────────────────────────────────
  // Toby, on Roost → Planning → This Half Term: "the planning section is inside the
  // frame rather than being its own page."
  //
  // The SPA embeds real pages in iframes (sections/planning.html etc). Every page it
  // embeds runs wren-shell-v2, which has skipped its chrome inside a frame since
  // build-77 — EXCEPT focus-block.html and planning-half-term.html, which were built
  // (b368/b371) on THIS shell, which had no such branch. So those two drew a second
  // full Wren shell — hamburger, logo, bell, avatar — inside the Roost content area.
  //
  // Same contract as wren-shell-v2's _init: no chrome, but the user IS parsed and
  // wren:ready IS fired, because the page's own JS waits for it (rule 7).
  function _isEmbedded() {
    try { if (window.self !== window.top) return true; } catch (e) { return true; }  // cross-origin frame
    try { return new URLSearchParams(location.search).get('embed') === '1'; } catch (e) { return false; }
  }

  // ── Main init ─────────────────────────────────────────────────────────────────
  function _init() {
    // 1. Auth gate — redirects if not authenticated
    const jwtPayload = _authGate();
    if (!jwtPayload) return;

    // 1b. Inside a frame: the parent already has the chrome. Signal and stop.
    if (_isEmbedded()) {
      document.body.classList.add('wren-embedded', 'wren-app-shell', 'wren-embedded-app');
      const _eu = (window.Wren ? Wren.getUser() : null) || jwtPayload;
      document.dispatchEvent(new CustomEvent('wren:ready', { detail: { user: _eu, embedded: true } }));
      return;
    }

    const user = (window.Wren ? Wren.getUser() : null) || jwtPayload;

    document.body.classList.add('wren-app-shell');
    if (_meta('wren-app-no-bottom-nav') === 'true') document.body.classList.add('no-bottom-nav');

    // b297 — HR portal marker + the fonts Roost already loads.
    //
    // Deliberately a SEPARATE test from the `isHR` further down (which gates the
    // left drawer). That one keys off data-portal="hr" alone, and two HR pages
    // (audit.html, cpd/ai-creator.html) carry a bare <body> — broadening it would
    // silently take the drawer away from them, which is a nav item. This one adds
    // a class and a stylesheet and can never remove anything, so it can safely
    // trust the hostname as well and cover every page the portal serves.
    //
    // The fonts: --font-heading is 'Playfair Display', Georgia, serif, and
    // wren-shell-v2.js (Roost) was the ONLY thing in the codebase loading the
    // webfont. Every HR heading was therefore falling back to Georgia — a serif,
    // against the design guideline and against how the same headings look in
    // Roost. EY is left alone: it has no <h1>s to speak of, and changing its body
    // font is not what was asked for.
    if (document.body.dataset.portal === 'hr' || location.hostname.indexOf('hr.') === 0) {
      document.body.classList.add('wren-hr');
      if (!document.querySelector('link[data-wren-fonts]')) {
        const pc = document.createElement('link');
        pc.rel = 'preconnect'; pc.href = 'https://fonts.gstatic.com'; pc.crossOrigin = 'anonymous';
        document.head.appendChild(pc);
        const fl = document.createElement('link');
        fl.rel = 'stylesheet';
        fl.href = 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=DM+Sans:wght@400;500;600&display=swap';
        fl.setAttribute('data-wren-fonts', '1');
        document.head.appendChild(fl);
      }
    }

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

    // 7. Drawer — only for non-EY, non-HR portals (HR uses bottom tabs + More page)
    const isEY = document.body.dataset.portal === 'ey' || location.pathname.startsWith('/ey/');
    const isHR = document.body.dataset.portal === 'hr';   // b95
    let drawer = null, drawerBackdrop = null;

    // ── Hardware/browser Back guard on the app root (EyLog parity, 2026-07-29) ──────
    // Bug (a practitioner/Toby): on the tablets, pressing the device Back button on the Home
    // screen unwound history past /login.html, which re-showed the PIN screen — i.e.
    // Back "logged you out". EyLog never leaves the app on Back; you must Sign Out
    // explicitly. So on Home we pin a sentinel history entry and re-assert it whenever
    // Back is pressed: the user stays on Home instead of exiting to the login page.
    // Deeper pages are untouched — their in-app Back button / device Back still walk
    // the history stack normally. Logout is now the confirmed Sign Out action only.
    const _onEYHome = /^\/ey\/home\/?$/.test(location.pathname);
    if (isEY && _onEYHome && !window.__wrenBackGuard) {
      window.__wrenBackGuard = true;
      try { history.pushState({ wrenHomeGuard: 1 }, ''); } catch (_) {}
      window.addEventListener('popstate', function () {
        // Re-pin the guard so Back on Home is a no-op rather than an exit-to-login.
        try { history.pushState({ wrenHomeGuard: 1 }, ''); } catch (_) {}
        if (window.Wren) Wren.toast('Use Sign Out (More menu) to log out', 'info', 2200);
      });
    }

    // b95: HR pages were written against wren-shell-v2, which exposed the decoded
    // JWT as Wren.user. wren-core doesn't set it, so mirror it here for HR only.
    if (isHR && window.Wren && !Wren.user) Wren.user = user;

    if (!isEY && !isHR) {
      const drawerResult = _buildDrawer();
      drawerBackdrop = drawerResult.backdrop;
      drawer = drawerResult.drawer;
      document.body.appendChild(drawerBackdrop);
      document.body.appendChild(drawer);
    }

    // b525 — HR gets a sidebar on a wide viewport instead of the drawer it has
    // never had. Mounted whatever the width (CSS decides which of the two
    // surfaces is visible), so a desk user who narrows the window gets the tab
    // bar back without a reload, and vice versa.
    if (isHR && window.WrenHrNav) {
      const hrSidebar = _buildHrSidebar(user);
      if (hrSidebar) {
        document.body.appendChild(hrSidebar);
        document.body.classList.add('has-hr-sidebar');
        _wireHrSidebar(hrSidebar);
      }
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
      // Confirmed sign-out (EyLog parity, 2026-07-29): logout is deliberate, never
      // a side effect of a stray tap. Falls back to a bare logout only if Wren core
      // failed to load (no confirm dialog available).
      drawer.querySelector('.wren-app-drawer-signout').addEventListener('click', () => {
        if (window.Wren) Wren.confirmLogout();
        else { sessionStorage.removeItem(TOKEN_KEY); location.href = '/login.html'; }
      });

      // ── Swipe-left-to-close ───────────────────────────────────────────────
      _attachSwipeClose(drawer, drawerBackdrop);
    }

    // ── Center FAB = ＋Observation (priority action, EyLog-style) ────────────────
    // EY portal: jump straight into the observation flow, carrying child context.
    // Non-EY portals keep the multi-action quick-add sheet.
    // b95: HR bottom nav has no ＋ FAB — guard the lookup (null on HR pages).
    const _addBtn = bottomNav.querySelector('#wren-app-add-btn');
    if (_addBtn) _addBtn.addEventListener('click', e => {
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
        // b150: Esc also dismisses the topbar messages/notifications dropdowns —
        // re-dispatch a click on the toggle button so each panel's own _close()
        // runs (resets its closure state), rather than removing the DOM directly.
        const msgPanel = document.getElementById('wren-app-msg-panel');
        if (msgPanel) document.getElementById('wren-app-msg-btn')?.click();
        const notifPanel = document.getElementById('wren-app-notif-panel');
        if (notifPanel) document.getElementById('wren-app-notif-btn')?.click();
      }
    });

    // ── Async background loads ──────────────────────────────────────────────────
    _loadNotificationCount();
    setInterval(_loadNotificationCount, 60000);   // live-refresh the bell badge (was load-once)
    _initNotifPanel();                            // bell opens the notifications panel (was inert)
    if (isEY) { _loadMessageBadge(); setInterval(_loadMessageBadge, 60000); _initMsgPanel(); }  // b97: ✉️ dropdown
    if (isEY) { _initDoorbellWatcher(); }         // b99: front-door ring popup
    if (isEY) { setTimeout(function () { _initKeyChildrenNudge(user); }, 1500); }  // 2026-10-01: key children gaps
    if (!isEY && !isHR) _loadDraftCount();  // draft badge lives in the left drawer (non-EY/HR only)
    _initOutboxBadge();            // offline obs-outbox queue → drawer badge (when present)
    _loadChatWidget();
    _loadVoiceCaptureWidget();
    _loadTextareaMic();            // b354: mic on every multi-line text field
    _initWrenAIButton();           // b150: topbar Wren AI icon — opens the same window.WrenChat surface

    // ── Session idle timer ──────────────────────────────────────────────────────
    _attachIdleListeners();
    _resetIdleTimer();

    // ── Expose reset for external use ───────────────────────────────────────────
    // b525 — hrNavAction is exported so editions/hr/public/more.html wires its
    // Appearance / notifications / bug-report / Sign Out rows through the SAME
    // function the desktop sidebar uses, rather than keeping a second copy.
    window.WrenAppShell = { resetIdleTimer: _resetIdleTimer, hrNavAction: _hrNavAction };

    // ── PWA head tags (EY + HR app installability, b148 extended to HR) ─────────
    // The /ey/* and HR pages don't carry the manifest / apple meta in their own
    // <head>, so inject them here (idempotent). Without this the app isn't
    // installable from its real entry point and iOS gets no Add-to-Home-Screen icon.
    if (isEY || isHR) {
      try {
        var _head = document.head;
        var _ensureHead = function (sel, make) { if (!_head.querySelector(sel)) _head.appendChild(make()); };
        var _makeMeta = function (name, content) { var m = document.createElement('meta'); m.name = name; m.content = content; return m; };
        _ensureHead('link[rel="manifest"]', function () { var l = document.createElement('link'); l.rel = 'manifest'; l.href = '/manifest.webmanifest'; return l; });
        _ensureHead('meta[name="theme-color"]', function () { return _makeMeta('theme-color', '#0f172a'); });
        _ensureHead('meta[name="apple-mobile-web-app-capable"]', function () { return _makeMeta('apple-mobile-web-app-capable', 'yes'); });
        _ensureHead('meta[name="apple-mobile-web-app-status-bar-style"]', function () { return _makeMeta('apple-mobile-web-app-status-bar-style', 'black-translucent'); });
        // b297 — was 'Your Nursery HR' / 'Your Nursery EY'. This file is shared by
        // every tenant, so that was the home-screen name a prospect got on a demo.
        _ensureHead('meta[name="apple-mobile-web-app-title"]', function () { return _makeMeta('apple-mobile-web-app-title', isHR ? 'Seed' : 'Nest'); });
        _ensureHead('meta[name="mobile-web-app-capable"]', function () { return _makeMeta('mobile-web-app-capable', 'yes'); });
        // b-pwa: portal-specific square icon (each edition serves its own /icons/*
        // from its own public root — EY -> editions/ladn/public/icons/, HR ->
        // editions/hr/public/icons/) — NOT the raw /little-angels-logo.png (2412x1760,
        // non-square) which iOS would squash into a distorted 180x180 tile.
        _ensureHead('link[rel="apple-touch-icon"]', function () { var l = document.createElement('link'); l.rel = 'apple-touch-icon'; l.sizes = '180x180'; l.href = '/icons/apple-touch-icon.png'; return l; });
        // 2026-11-01 — iPhones never offer to install; the "Add to Home Screen" bar (wren-install.js).
        _ensureHead('script[src^="/js/wren-install.js"]', function () { var s = document.createElement('script'); s.src = '/js/wren-install.js?v=20261101'; s.defer = true; return s; });
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

    // ── Service worker (EY + HR portals, offline-first — b148 extended to HR) ───
    if ((isEY || isHR) && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then(() => { _syncPushSubscription(false); })   // re-sync silently if already granted
        .catch(err => { console.warn('[wren-sw] SW registration failed', err); });
    }

    // ── Fire wren:ready (same event wren-shell-v2 fires — page JS hooks this) ───
    document.dispatchEvent(new CustomEvent('wren:ready', { detail: { user } }));

    // Feedback/bug-report widget (2026-07-09) — EY tablet pages, staff testing phase
    if (!document.querySelector('script[src^="/js/wren-feedback.js"]')) {
      var _fbs = document.createElement('script');
      _fbs.src = '/js/wren-feedback.js?v=20261020fbv';
      document.head.appendChild(_fbs);
    }

    // Onboarding tour + first-run wizard (2026-07-16) — EY only (demos untouched).
    // b201: ALSO loaded for the HR portal in mobile/app-shell mode. HR desktop
    // runs wren-shell-v2, which has always loaded the tour; HR on a phone runs
    // this shell, which did not — so Seed simply had no ? button on a phone.
    if (isEY || isHR) {
      // b201: version bumped so installed EY tablets pick up the corpus-driven
      // engine (tracks + per-page ? help + resume). wren-tour.js pulls
      // wren-tour-content.js in itself, so nothing else to load here.
      ['/js/wren-tour.js', '/js/wren-wizard.js'].forEach(function (src) {
        if (!document.querySelector('script[src^="' + src + '"]')) {
          var s = document.createElement('script'); s.src = src + '?v=b201'; document.head.appendChild(s);
        }
      });
    }
    if (isEY) {
      (function regEYTour() {
        if (!window.WrenTour) { return setTimeout(regEYTour, 200); }
        var k = (WrenTour.portalKey && WrenTour.portalKey()) || 'ey';
        WrenTour.register(k, [
          { sel: '#wren-topbar,.wren-topbar,header', title: '🪺 Welcome to Nest', body: 'This is your day-to-day EYFS workspace — observations, the diary, planning and registers all live here.' },
          { sel: '#wren-sidebar,.wren-sidebar,nav', title: 'Getting around', body: 'Use the menu to reach the register, diary, observations, sleep checks and reports.' }
        ]);
        if (window.WrenWizard) WrenWizard.register(k, {
          title: '🪺 Welcome to Nest', launchTourOnFinish: true,
          steps: [
            { title: 'Welcome to Nest', body: '<p>Your EYFS day-to-day, all in one place. Want a quick look around?</p>' },
            { title: "You're set", body: '<p>Head to the register or the diary to get started — the <strong>?</strong> button reopens this any time.</p>' }
          ]
        });
      })();
    }
  }

  // Run after DOM + defer scripts are ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

})();

/* ── Manager-away banner (2026-08-04) — self-contained, appended to portal shell.
   Fetches /api/away-mode/banner and shows a dismissible top bar when away mode is
   active + show_banner is on. Wrapped so it can never break the shell. */
(function () {
  try {
    function tok(){ try { return sessionStorage.getItem("wrenToken") || localStorage.getItem("wrenToken"); } catch(e){ return null; } }
    function esc(s){ return String(s||"").replace(/[<>&]/g, c=>({ "<":"&lt;",">":"&gt;","&":"&amp;" }[c])); }
    function render(d){
      if (!d || !d.show) return;
      if (document.getElementById("wren-away-banner")) return;
      var msg = "\u{1F3D6}️ Manager away" + (d.return_date ? " until " + esc(d.return_date) : "")
              + (d.cover_name ? " — " + esc(d.cover_name) + " (" + esc(d.cover_role||"deputy") + ") is covering" : "") + ".";
      var bar = document.createElement("div");
      bar.id = "wren-away-banner";
      bar.setAttribute("role","status");
      bar.style.cssText = "position:sticky;top:0;left:0;right:0;z-index:900;display:flex;align-items:center;justify-content:center;gap:12px;"
        + "padding:8px 14px;background:#7c2d12;color:#fed7aa;font-size:.82rem;font-weight:600;line-height:1.3;text-align:center;border-bottom:1px solid #9a3412";
      var span = document.createElement("span"); span.textContent = msg;
      var x = document.createElement("button"); x.textContent = "×";
      x.setAttribute("aria-label","Dismiss");
      x.style.cssText = "background:none;border:none;color:#fed7aa;font-size:1.1rem;cursor:pointer;line-height:1;padding:0 4px";
      x.onclick = function(){ try{ sessionStorage.setItem("wrenAwayBannerHidden","1"); }catch(e){} bar.remove(); };
      bar.appendChild(span); bar.appendChild(x);
      document.body.insertBefore(bar, document.body.firstChild);
    }
    function go(){
      try { if (sessionStorage.getItem("wrenAwayBannerHidden")==="1") return; } catch(e){}
      var t = tok(); if (!t) return;
      /* b306 — the EY shell is the portal device enforcement actually gates, so
         this is the call site where the missing X-Wren-Device bites first: a 403
         into a bare .catch() and the away banner silently never appears. */
      var _dev = ''; try { _dev = localStorage.getItem('wrenDevice') || ''; } catch (e) {}
      var _h = { Authorization: "Bearer " + t };
      if (_dev) _h['X-Wren-Device'] = _dev;
      fetch("/api/away-mode/banner", { headers: _h })
        .then(function(r){ return r.ok ? r.json() : null; }).then(render).catch(function(){});
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go();
  } catch (e) { /* never break the shell */ }
})();

/* ── b188 (2026-08-19): staff knowledge pop-quiz ─────────────────────────────
   One multiple-choice refresher per shift on the EY tablet, so that across a
   term practitioners revisit safeguarding, first aid, curriculum and SEN.

   Lives in the SHELL, not on a page, so it works on every EY page — but only
   ever fires at a natural break:
     * never on a data-entry page (observation/incident/medicine/safeguarding/
       diary entry/group logging) — those are mid-task by definition;
     * never while another dialog is open (b170's termly knowledge check owns
       /ey/home, and b93's report reminders pop there too) — it retries later;
     * never while the practitioner is typing.

   The once-per-shift cap, the 14-day no-repeat rule and the dismiss cooldown
   are all enforced SERVER-side in src/routes/knowledge.js. This file only
   decides whether now is a polite moment to ask. Wrapped so it can never break
   the shell. */
(function () {
  try {
    var API = '/api/knowledge';
    var FIRST_DELAY_MS = 7000;    // sit behind b170 (1.5s) and b93 on /ey/home
    var RETRY_MS       = 45000;   // a dialog was open / user was typing

    // Pages where a practitioner is part-way through recording something.
    var BUSY_PATHS = [
      /^\/ey\/observation\/new/, /^\/ey\/group\//, /^\/ey\/log\//,
      /^\/ey\/safeguarding\/new/, /^\/ey\/incident\/new/, /^\/ey\/medicine\/new/,
      /^\/ey\/diary\/entry/, /^\/ey\/drafts/
    ];

    function isEY() {
      return document.body.dataset.portal === 'ey' || /^\/ey\//.test(location.pathname);
    }
    function onBusyPage() {
      for (var i = 0; i < BUSY_PATHS.length; i++) if (BUSY_PATHS[i].test(location.pathname)) return true;
      return false;
    }
    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    /* Is another dialog actually ON SCREEN?

       A plain querySelector('[role="dialog"]') is NOT good enough here: the
       shell itself keeps three permanently-mounted dialogs in the DOM on every
       EY page (#wren-action-sheet, #wren-vc-panel, #wren-chat-panel), each
       hidden by a DIFFERENT mechanism — translated below the viewport,
       opacity:0, and display:none respectively. Matching on the selector alone
       means the pop-up is suppressed forever and never appears at all.
       So test for real visibility: painted, big enough to matter, and
       intersecting the viewport. */
    function anyVisibleDialog() {
      var nodes = document.querySelectorAll('[role="dialog"], dialog[open]');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (el.id === 'wren-knowledge-pop' || (el.closest && el.closest('#wren-knowledge-pop'))) continue;
        var cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.1) continue;
        var r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) continue;                       // collapsed
        if (r.bottom <= 0 || r.right <= 0) continue;                       // slid off top/left
        if (r.top >= (window.innerHeight || 0)) continue;                  // slid off bottom
        if (r.left >= (window.innerWidth || 0)) continue;                  // slid off right
        return true;
      }
      return false;
    }

    // A natural break = nothing else on screen and nobody mid-sentence.
    function badMoment() {
      if (anyVisibleDialog()) return true;
      var a = document.activeElement;
      if (!a) return false;
      var tag = (a.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || a.isContentEditable === true;
    }

    function shell(titleText) {
      var overlay = document.createElement('div');
      overlay.id = 'wren-knowledge-pop';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:445;background:rgba(0,0,0,.6);' +
        'display:flex;align-items:center;justify-content:center;padding:16px';
      overlay.innerHTML =
        '<div role="dialog" aria-label="' + esc(titleText) + '" style="background:var(--c-navy-mid,#0f172a);' +
        'border:1px solid var(--c-border,#2d3748);border-radius:16px;width:100%;max-width:440px;' +
        'max-height:86vh;overflow-y:auto;display:flex;flex-direction:column">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;' +
        'border-bottom:1px solid var(--c-border,#2d3748)">' +
        '<strong style="color:var(--c-text,#f1f5f9)">' + esc(titleText) + '</strong>' +
        '<button id="kq-close" aria-label="Not now" style="background:none;border:none;' +
        'color:var(--c-muted,#94a3b8);font-size:1.1rem;cursor:pointer;width:36px;height:36px">✕</button>' +
        '</div><div id="kq-body" style="padding:14px 16px"></div></div>';
      document.body.appendChild(overlay);
      return overlay;
    }

    /* Termly focus choice (b188 requirement 4). Shown once at the start of a
       term, before the first question, and skippable — a practitioner who
       skips simply gets an unweighted rotation. */
    function askFocus(topics, then) {
      var overlay = shell('🎯 Your focus this term');
      var body = overlay.querySelector('#kq-body');
      function close() { overlay.remove(); }
      overlay.querySelector('#kq-close').addEventListener('click', function () { close(); then(false); });

      body.innerHTML =
        '<div style="color:var(--c-text,#f1f5f9);font-size:.9rem;line-height:1.5;margin-bottom:12px">' +
        'Pick one area to sharpen up this term. You\'ll still get questions on everything &mdash; ' +
        'just more on the one you choose.</div>' +
        topics.map(function (t) {
          return '<button type="button" class="kq-topic" data-slug="' + esc(t.slug) + '" ' +
            'style="display:block;width:100%;text-align:left;padding:12px 14px;margin-bottom:8px;' +
            'border-radius:10px;border:1px solid var(--c-border,#2d3748);background:transparent;' +
            'color:var(--c-text,#f1f5f9);font-size:.9rem;font-weight:600;cursor:pointer">' +
            esc(t.name) + '</button>';
        }).join('') +
        '<button type="button" id="kq-skip" style="width:100%;height:40px;margin-top:4px;border-radius:10px;' +
        'background:none;border:1px solid var(--c-border,#2d3748);color:var(--c-muted,#94a3b8);cursor:pointer">' +
        'Decide later</button>';

      body.querySelector('#kq-skip').addEventListener('click', function () { close(); then(false); });
      Array.prototype.forEach.call(body.querySelectorAll('.kq-topic'), function (btn) {
        btn.addEventListener('click', function () {
          Array.prototype.forEach.call(body.querySelectorAll('.kq-topic'), function (b) { b.disabled = true; });
          Wren.api(API + '/focus', { method: 'PUT', body: { topic: btn.dataset.slug } })
            .then(function () { close(); then(true); })
            .catch(function () { close(); then(false); });
        });
      });
    }

    function askQuestion(d) {
      var q = d.question;
      var overlay = shell('🧠 Quick refresher');
      var body = overlay.querySelector('#kq-body');
      var started = Date.now();
      var answered = false;

      function dismiss() {
        overlay.remove();
        if (answered) return;
        // "Not now" is a cooldown, not an opt-out — the server re-offers later today.
        Wren.api(API + '/dismiss', { method: 'POST', body: { question_id: q.id } }).catch(function () {});
      }
      overlay.querySelector('#kq-close').addEventListener('click', dismiss);
      overlay.addEventListener('click', function (e) { if (e.target === overlay) dismiss(); });

      var opts = Array.isArray(q.options) ? q.options : [];
      body.innerHTML =
        '<div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;' +
        'color:var(--c-blue,#4a9abf)">' + esc(q.topic_name) +
        (d.focus && d.focus.slug === q.topic ? ' · your focus' : '') + '</div>' +
        '<div style="font-weight:600;color:var(--c-text,#f1f5f9);margin:8px 0 14px;line-height:1.45">' +
        esc(q.question) + '</div>' +
        opts.map(function (o, i) {
          return '<button type="button" class="kq-opt" data-i="' + i + '" ' +
            'style="display:block;width:100%;text-align:left;padding:11px 14px;margin-bottom:8px;' +
            'border-radius:10px;border:1px solid var(--c-border,#2d3748);background:transparent;' +
            'color:var(--c-text,#f1f5f9);font-size:.88rem;line-height:1.4;cursor:pointer">' + esc(o) + '</button>';
        }).join('') +
        '<div style="color:var(--c-muted,#94a3b8);font-size:.72rem;margin-top:4px">' +
        'One question a shift. Not a test &mdash; nobody is marked on this.</div>';

      Array.prototype.forEach.call(body.querySelectorAll('.kq-opt'), function (btn) {
        btn.addEventListener('click', function () {
          if (answered) return;
          answered = true;
          Array.prototype.forEach.call(body.querySelectorAll('.kq-opt'), function (b) {
            b.disabled = true; b.style.cursor = 'default';
          });
          var choice = parseInt(btn.dataset.i, 10);
          Wren.api(API + '/answer', {
            method: 'POST',
            body: { question_id: q.id, chosen_index: choice, ms_taken: Date.now() - started }
          })
            .then(function (r) { showResult(body, choice, r, overlay); })
            .catch(function () {
              answered = false;
              body.insertAdjacentHTML('beforeend',
                '<div style="color:var(--c-danger,#ef4444);font-size:.82rem;margin-top:8px">' +
                'Could not save your answer &mdash; it will come round again.</div>');
            });
        });
      });
    }

    function showResult(body, choice, r, overlay) {
      Array.prototype.forEach.call(body.querySelectorAll('.kq-opt'), function (b, i) {
        if (i === r.correct_index) {
          b.style.borderColor = 'var(--c-success,#22c55e)';
          b.style.background = 'rgba(34,197,94,.12)';
        } else if (i === choice && !r.correct) {
          b.style.borderColor = 'var(--c-danger,#ef4444)';
          b.style.background = 'rgba(239,68,68,.10)';
        }
      });
      body.insertAdjacentHTML('beforeend',
        '<div style="margin-top:12px;padding:12px;border-radius:10px;background:var(--c-card,#1e293b);' +
        'border:1px solid var(--c-border,#2d3748)">' +
        '<div style="font-weight:700;color:' +
        (r.correct ? 'var(--c-success,#22c55e)' : 'var(--c-danger,#ef4444)') + '">' +
        (r.correct ? '✓ Correct' : '✕ Not quite') + '</div>' +
        (r.explanation ? '<div style="color:var(--c-text,#f1f5f9);font-size:.85rem;margin-top:6px;' +
          'line-height:1.45">' + esc(r.explanation) + '</div>' : '') +
        // The citation is shown, not hidden: a practitioner who disagrees with
        // the marking can go and check the source themselves.
        (r.source_ref ? '<div style="color:var(--c-muted,#94a3b8);font-size:.72rem;margin-top:8px">' +
          'Source: ' + esc(r.source_ref) + '</div>' : '') +
        '</div>' +
        '<button type="button" id="kq-done" style="width:100%;height:42px;margin-top:12px;border-radius:10px;' +
        'background:var(--c-blue,#4a9abf);border:none;color:#fff;font-weight:700;cursor:pointer">Continue</button>');
      body.querySelector('#kq-done').addEventListener('click', function () { overlay.remove(); });
    }

    function go() {
      if (document.getElementById('wren-knowledge-pop')) return;
      if (badMoment()) { setTimeout(go, RETRY_MS); return; }
      Wren.api(API + '/next').then(function (d) {
        if (!d || !d.question) return;              // disabled / done this shift / dismissed
        if (badMoment()) { setTimeout(go, RETRY_MS); return; }
        if (d.needs_focus_choice) {
          Wren.api(API + '/focus')
            .then(function (f) {
              askFocus((f && f.topics) || [], function (picked) {
                // Re-fetch so the very FIRST question already honours the focus
                // they just chose — d was selected before the focus existed.
                if (!picked) return askQuestion(d);
                Wren.api(API + '/next')
                  .then(function (d2) { askQuestion(d2 && d2.question ? d2 : d); })
                  .catch(function () { askQuestion(d); });
              });
            })
            .catch(function () { askQuestion(d); });
        } else {
          askQuestion(d);
        }
      }).catch(function () { /* never surface as an error to a practitioner */ });
    }

    /* Bootstrap.

       Do NOT rely on catching 'wren:ready' alone. _init() above is SYNCHRONOUS
       and has already dispatched that event by the time this tail of the file
       executes, so a listener registered here would never fire — which is the
       same reason the manager-away banner below binds to DOMContentLoaded
       instead. Bind to both and let whichever comes first win. */
    var _started = false;
    function start() {
      if (_started) return;
      _started = true;
      try {
        if (!isEY() || onBusyPage()) return;
        setTimeout(function () { whenWrenReady(0); }, FIRST_DELAY_MS);
      } catch (e) { /* never break the shell */ }
    }
    // Wren.api comes from wren-core.js; give it a few seconds on a slow tablet.
    function whenWrenReady(tries) {
      if (window.Wren && Wren.api) { go(); return; }
      if (tries < 20) setTimeout(function () { whenWrenReady(tries + 1); }, 500);
    }

    document.addEventListener('wren:ready', start);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  } catch (e) { /* never break the shell */ }
})();

// 2026-10-09 — What's new popup: loaded once per page after the shell is ready.
// Shows the newest update meant for this portal that this person hasn't dismissed.
// The shell's init is synchronous and may already have fired 'wren:ready' by the time this
// tail runs (see the bootstrap note in wren-app-shell.js), so bind to both and to the DOM.
(function () {
  function loadWhatsNew() {
    if (window.__wrenWhatsNewTag) return; window.__wrenWhatsNewTag = true;
    var s = document.createElement('script'); s.src = '/js/wren-whats-new.js?v=20261009'; s.defer = true;
    document.head.appendChild(s);
  }
  document.addEventListener('wren:ready', loadWhatsNew);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadWhatsNew);
  else loadWhatsNew();
})();
