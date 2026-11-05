/* Your Nursery — Parents PWA + mobile shell.
 * Loaded (deferred) on every /welcome/* page. Self-contained, no dependencies.
 * Responsibilities:
 *   1. Inject PWA <head> tags (manifest, theme-color, apple touch icon + meta).
 *   2. Register the service worker (/sw.js) — guarded to the parents origin.
 *   3. "Add to Home Screen" install banner (Android/desktop) + iOS hint.
 *   4. A consistent mobile bottom-nav + "More" drawer (the top nav is preserved
 *      and made horizontally scrollable on mobile — nothing is removed).
 * Brand: green #2d5a4a / cream — matches the live parent hub.
 *
 * b339 (2026-09-18): this file is now also the parents APP SHELL — a single compact
 * title row (back · name · action · child · bell), the tab bar, the More sheet with
 * the nursery's contact card, light/dark, and the first-run intro. Pages reach it
 * through window.LapShell (see the block above build()). Its CSS is in
 * /css/parents-app.css; the part that must run before first paint is /js/lap-boot.js.
 */
(function () {
  'use strict';

  // ── Origin guard — only ever run on the parents portal ──────────────────────
  var p = location.pathname;
  var onParents = (p === '/welcome' || p.indexOf('/welcome/') === 0 || p === '/' ||
                   location.hostname.indexOf('parents.') === 0);
  if (!onParents) return;

  // ── 2026-10-29 — signed out mid-visit → the sign-in page, then back here ─────
  // The server answers an /api call that has no parent identity with 401 and
  // X-Wren-Login: required (editions/ladn/server-unified.js, parents gate). A page
  // load without one is already redirected server-side; this covers a session
  // that runs out while a page is open, instead of leaving an empty screen.
  (function loginOn401() {
    if (!window.fetch || window.fetch.__lapLogin) return;
    var realFetch = window.fetch, going = false;
    var wrapped = function () {
      return realFetch.apply(this, arguments).then(function (r) {
        try {
          if (r && r.status === 401 && !going && r.headers.get('X-Wren-Login') === 'required') {
            going = true;
            location.href = '/login.html?return=' + encodeURIComponent(location.pathname + location.search);
          }
        } catch (e) {}
        return r;
      });
    };
    wrapped.__lapLogin = true;
    window.fetch = wrapped;
  })();

  // ── b161 — mark the shell + pull in the shared app stylesheet ASAP so the
  //    marketing chrome (heroes / nav rows) is hidden and the modern-app look
  //    applies before first paint, not after build() on DOMContentLoaded. The
  //    home page keeps its serif greeting (lap-home); sub-pages go Nunito
  //    (lap-page). All of parents-app.css is scoped under html.lap-shell. ─────
  (function appChrome() {
    try {
      var de = document.documentElement;
      de.classList.add('lap-shell');
      de.classList.add((p === '/welcome' || p === '/') ? 'lap-home' : 'lap-page');
      if (!document.querySelector('link[data-parents-app-css]')) {
        var l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = '/css/parents-app.css';
        l.setAttribute('data-parents-app-css', '1');
        (document.head || document.documentElement).appendChild(l);
      }
    } catch (e) {}
  })();

  var GREEN = '#2d5a4a';
  // Theme colour used by the shell chrome — follows the live theme editor.
  var THEME = 'var(--green,#2d5a4a)';

  // ── b131 — App lock: load ASAP so it can gate content before anything else
  //    boots (it self-manages a localStorage cache so it can lock instantly on
  //    return visits without waiting on the status fetch). ────────────────────
  (function () {
    if (document.querySelector('script[data-wren-applock]')) return;
    var s = document.createElement('script');
    s.src = '/js/wren-parent-app-lock.js'; s.setAttribute('data-wren-applock', '1');
    (document.head || document.documentElement).appendChild(s);
  })();

  // ── Live theme: apply the saved palette ASAP (reduces flash), then load the
  //    full theme engine + editor. Additive; no-op if nothing saved. ──────────
  (function themeBoot() {
    try {
      var raw = localStorage.getItem('wren.theme');
      if (raw) {
        var t = JSON.parse(raw);
        if (t && t.bg && t.text && t.accent) {
          var root = document.documentElement.style;
          var setp = function (n, v) { try { root.setProperty(n, v); } catch (e) {} };
          setp('--green', t.accent); setp('--cream', t.bg);
          setp('--text', t.text); setp('--navy', t.accent); setp('--blue', t.accent);
          // b297 — the card surface and the .lap-dark marker have to land in this
          // same pre-paint pass, not when wren-theme.js finishes loading: they are
          // what decides whether every card on the page is white or dark, and a
          // flash of white cards under light text is the exact bug being fixed.
          var _dark = (function (h) {
            h = String(h || '').replace('#', '');
            if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
            var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
            return !isNaN(r) && (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
          })(t.bg);
          setp('--surface', _dark ? 'rgba(255,255,255,.06)' : '#ffffff');
          // b297 — the topbar and tab bar are painted in the ACCENT, and their
          // labels were a hardcoded white. Wren's own 'Dark' preset uses a pale
          // orange accent (#f2a34d), which put every tab label at about 2:1.
          // Pick the ink from the accent's luminance instead of assuming white.
          setp('--lap-on-accent', (function (h) {
            h = String(h || '').replace('#', '');
            if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
            var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b2 = parseInt(h.slice(4, 6), 16);
            return (!isNaN(r) && (0.2126 * r + 0.7152 * g + 0.0722 * b2) >= 128) ? '#1c1508' : '#ffffff';  // same 128 cut as wren-theme.js isDark()
          })(t.accent));
          try { document.documentElement.classList.toggle('lap-dark', _dark); } catch (e) {}
        }
      }
    } catch (e) {}
    if (!document.querySelector('script[data-wren-theme]')) {
      var s = document.createElement('script');
      s.src = '/js/wren-theme.js'; s.setAttribute('data-wren-theme', '1');
      (document.head || document.documentElement).appendChild(s);
    }
  })();

  // ── Lazy-load an assistant widget script, then run a callback ───────────────
  var _loaded = {};
  function loadScript(src, cb) {
    if (_loaded[src]) { cb(); return; }
    var s = document.createElement('script');
    s.src = src;
    s.onload = function () { _loaded[src] = true; cb(); };
    s.onerror = function () { cb(); };
    (document.head || document.documentElement).appendChild(s);
  }
  function openChat() {
    if (window.WrenChat && WrenChat.open) return WrenChat.open();
    loadScript('/js/wren-chat.js', function () {
      // FIX (parents readiness pass, 2026-07-28): this passed { portal: 'parents' } —
      // WrenChat.init() only reads opts.persona, so the key mismatch meant cfg.persona
      // stayed at its default 'eyfs' (practitioner) prompt for every parents-portal
      // chat. wren-chat.js's own auto-init meta-tag map already has parents -> 'parents'
      // correct; this explicit init() call just needed the same key.
      try { if (window.WrenChat) { WrenChat.init ? WrenChat.init({ persona: 'parents' }) : null; WrenChat.open(); } } catch (e) {}
    });
  }
  // parentsapp-20261023: the widget needs the parent's bearer to send anything. This passed none, so on /welcome every press of
  // "Report a bug" ended in "Log in first to send feedback." (only the old index.html, which passed TOKEN, ever worked). It now hands
  // over the shell's own minted token. init() no longer draws the floating 🐞 on the parents app (wren-feedback.js).
  function openFeedback() {
    token().then(function (t) {
      var go = function () {
        try { if (window.WrenFeedback) { WrenFeedback.init && WrenFeedback.init(t ? { portal: 'parents', token: t } : { portal: 'parents' }); WrenFeedback.open(); } } catch (e) {}
      };
      if (window.WrenFeedback && WrenFeedback.open) return go();
      loadScript('/js/wren-feedback.js', go);
    });
  }
  // b129 — parent app feedback ("tell us what to change"), distinct from the
  // staff bug-tracker widget above: warm copy, like/change/idea/bug/other.
  function openAppFeedback() {
    if (window.WrenParentAppFeedback && WrenParentAppFeedback.open) return WrenParentAppFeedback.open();
    loadScript('/js/wren-parent-app-feedback.js', function () {
      try { window.WrenParentAppFeedback && WrenParentAppFeedback.open(); } catch (e) {}
    });
  }
  function openTheme() {
    if (window.WrenTheme && WrenTheme.open) return WrenTheme.open();
    loadScript('/js/wren-theme.js', function () { try { window.WrenTheme && WrenTheme.open(); } catch (e) {} });
  }
  // b131 — App Lock settings (PIN / biometric). wren-parent-app-lock.js is already
  // loaded eagerly above; only the settings-panel script is lazy.
  function openAppLock() {
    if (window.WrenParentAppLockSettings && WrenParentAppLockSettings.open) return WrenParentAppLockSettings.open();
    loadScript('/js/wren-parent-app-lock-settings.js', function () {
      try { window.WrenParentAppLockSettings && WrenParentAppLockSettings.open(); } catch (e) {}
    });
  }

  // ── 1. Head tags ────────────────────────────────────────────────────────────
  function head() { return document.head || document.getElementsByTagName('head')[0]; }
  function ensureLink(rel, href, extra) {
    if (document.querySelector('link[rel="' + rel + '"]')) return;
    var l = document.createElement('link'); l.rel = rel; l.href = href;
    if (extra) Object.keys(extra).forEach(function (k) { l.setAttribute(k, extra[k]); });
    head().appendChild(l);
  }
  function ensureMeta(name, content) {
    if (document.querySelector('meta[name="' + name + '"]')) return;
    var m = document.createElement('meta'); m.name = name; m.content = content; head().appendChild(m);
  }
  ensureLink('manifest', '/manifest.webmanifest', { crossorigin: 'use-credentials' });
  ensureLink('apple-touch-icon', '/icons/apple-touch-icon.png');
  ensureMeta('theme-color', GREEN);
  ensureMeta('apple-mobile-web-app-capable', 'yes');
  ensureMeta('apple-mobile-web-app-status-bar-style', 'black-translucent');
  ensureMeta('apple-mobile-web-app-title', 'LA Parents');
  ensureMeta('mobile-web-app-capable', 'yes');

  // ── 2. Service worker ─────────────────────────────────────────────────────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function (e) {
        console.warn('[pwa] SW registration failed:', e && e.message);
      });
    });
  }

  // ── Styles ────────────────────────────────────────────────────────────────────
  // b339 (2026-09-18): the shell CSS (top bar, tab bar, More sheet, install banner) was a
  // string in this file, injected on DOMContentLoaded, so the page jumped as it built.
  // It lives in /css/parents-app.css §10-14 now and arrives with the first paint.


  // ── Tab icons (2026-09-18) ───────────────────────────────────────────────────
  // Emoji in the tab bar is the single loudest "this is a web page" tell: it
  // renders differently on every phone, sits at a different baseline, and carries
  // another vendor's illustration style. These are plain stroked icons that take
  // the active colour from currentColor, the same shape language every parent
  // already knows from the apps on their home screen.
  function ico(d) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
           'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  }
  var ICONS = {
    quick:    ico('<path d="M4 7h16M4 12h16M4 17h16"/>'),
    home:     ico('<path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M9.8 20v-5.4h4.4V20"/>'),
    journey:  ico('<path d="M12 21c0-5 2.2-8.4 6.6-9.6"/><path d="M12 21c0-4.2-1.8-7-5.5-8.2"/>' +
                  '<path d="M19.5 4.2c.6 4.2-1.4 7-5 7.4-1.6.2-2.6-.6-2.8-2-.4-3 2.8-5.4 7.8-5.4z"/>' +
                  '<path d="M4 8.4c2.8.2 4.6 1.8 4.8 4 .1 1.2-.6 1.9-1.8 1.8-2.2-.2-3.6-2.2-3-5.8z"/>'),
    diary:    ico('<path d="M5 4.5h11.5a2.5 2.5 0 0 1 2.5 2.5v13H7.5A2.5 2.5 0 0 1 5 17.5z"/>' +
                  '<path d="M5 17.5A2.5 2.5 0 0 1 7.5 15H19"/><path d="M9 8.5h6"/>'),
    messages: ico('<path d="M20.5 12.2c0 3.9-3.8 7-8.5 7a9.8 9.8 0 0 1-2.6-.35L4.5 20.5l1.2-3.4A6.6 6.6 0 0 1 3.5 12.2c0-3.9 3.8-7 8.5-7s8.5 3.1 8.5 7z"/>'),
    more:     ico('<path d="M4 7h16M4 12h16M4 17h16"/>'),
    // b341 (2026-09-21): a door with an arrow going out — "Leaving us". Stroked like the rest, no emoji.
    leaving:  ico('<path d="M14 4.5H7A1.5 1.5 0 0 0 5.5 6v12A1.5 1.5 0 0 0 7 19.5h7"/><path d="M10 12h10"/><path d="m16.5 8.5 3.5 3.5-3.5 3.5"/>'),
    // b343 (2026-09-21): a page with a tick — "Forms" (paperwork to read and sign).
    forms:    ico('<path d="M7 3.5h7l4 4V20.5H7z"/><path d="M14 3.5v4h4"/><path d="m9.5 14 2 2 3.5-4"/>')
  };

  // ── Nav model ────────────────────────────────────────────────────────────────
  var PRIMARY = [
    { href: '/welcome',                  i: ICONS.home,     t: 'Home' },
    { href: '/welcome/learning-journey', i: ICONS.journey,  t: 'Journey' },
    { href: '/welcome/diary',            i: ICONS.diary,    t: 'Diary' },
    { href: '/welcome/messages',         i: ICONS.messages, t: 'Messages' }
  ];
  // The "More" sheet — grouped so every destination the old top nav / home
  // card-grid reached stays one tap away (bottom tabs cover Home/Journey/Diary/
  // Messages). b161 ADDED the money/admin + account rows; nothing was removed.
  //
  // b370 (2026-10-01, Toby): "break it down into sections ... have them as icons
  // rather than a really long list." The THREE groups from item 13 (2026-07-29)
  // rendered every item as one long scrolling list of rows — up to 18 in "My
  // child & nursery" alone. SECTIONS below re-groups the same destinations (every
  // one of the 29 links below is preserved, none removed) into SIX named
  // sections, each a tile on the sheet's first screen; tapping a tile opens a
  // second screen of that section's items as icon tiles (see renderSheet()).
  // "Fees" is renamed "Invoices / Payments" per the same brief (payments is
  // being folded into the invoices screen — see /welcome/invoices).
  var SECTIONS = [
    { key: 'money', label: 'Invoices / Payments', icon: '💷', items: [
      { href: '/welcome/invoices',         i: '💷', t: 'Invoices / Payments' },
      { href: '/welcome/declaration',      i: '📝', t: 'Funding Declaration' }
    ] },
    { key: 'learning', label: 'Home Learning', icon: '🎓', items: [
      { href: '/welcome/learning-journey', i: '🌱', t: 'Learning Journey' },
      // b243 (2026-08-28): the statutory progress check at age two. It stays
      // visible for every family rather than only 24-36 month olds: the page
      // itself explains when the check applies to their child.
      { href: '/welcome/two-year-check',   i: '🩺', t: '2 Year Check' },
      { href: '/welcome/planning',         i: '📚', t: 'Planning' },
      // b247 (2026-08-28): hidden until this family has a child whose phonics
      // switch is on. `gated:'phonics'` renders the tile display:none and
      // gatePhonics() below un-hides it — same mechanism as the leaving
      // Keepsake, and it fails closed for the same reason.
      { href: '/welcome/phonics',          i: '🔤', t: 'Phonics', gated: 'phonics' },
      // b393 (2026-10-05): "What we're working on" — hidden until
      // settings.parents_see_next_steps is on (Toby's to switch on).
      // Same gated mechanism as Phonics/Keepsake; gateNextSteps() below.
      { href: '/welcome/working-on',       i: '🎯', t: 'What we’re working on', gated: 'next-steps' },
      { href: '/welcome/study',            i: '🎓', t: 'Study' },
      { href: '/welcome/home-activities',  i: '🎨', t: 'Home Activities' },
      { href: '/welcome/resources',        i: '📁', t: 'Resources' },
      // b425 (2026-10-08): the Reading Room catalogue — policies, guides and the
      // Study modules above, now browsable together by area. /welcome/study
      // redirects here; added, nothing above it changed.
      { href: '/welcome/library',          i: '📖', t: 'Reading Room' }
    ] },
    { key: 'life', label: 'Nursery life', icon: '🏡', items: [
      { href: '/welcome/diary',            i: '📔', t: 'Diary' },
      { href: '/welcome/menu',             i: '🍽', t: 'Menu' },
      { href: '/welcome/events',           i: '📅', t: 'Events' },
      { href: '/welcome/newsletter',       i: '📰', t: 'Newsletter' },
      { href: '/welcome/bookings',         i: '📆', t: 'Bookings' },
      { href: '/welcome/absence',          i: '🏝️', t: 'Report Absence' }
    ] },
    { key: 'records', label: 'Records & Forms', icon: '🗂️', items: [
      { href: '/welcome/records',          i: '🗂️', t: 'Records' },
      // b343 (2026-09-21): paperwork a parent reads and signs — medicine, accident forms, reports, two-year checks.
      { href: '/welcome/forms',            i: ICONS.forms, t: 'Forms' },
      { href: '/welcome/consents',         i: '✅', t: 'Consents' },
      // b249 (2026-09-01): the parents portal had no policies surface at all. Sits beside Consents.
      { href: '/welcome/policies',         i: '✍️', t: 'Policies to Sign' },
      { href: '/welcome/documents',        i: '📄', t: 'Document Upload' }
    ] },
    { key: 'settings', label: 'Settings', icon: '⚙️', items: [
      { href: '/welcome/details',          i: '📋', t: 'Your account' },
      { href: '/welcome/notifications',    i: '🔔', t: 'Notifications' },
      // b340 (2026-09-18): how we tell you — push / email / both / off per category.
      { href: '/welcome/notifications/settings', i: '⚙️', t: 'Notification settings' },
      // item 2 (2026-07-29): the leaving Keepsake is hidden until the family is
      // actually leaving. `gated:'leaving'` renders the tile hidden; gateKeepsake()
      // below un-hides it after /welcome/keepsake/api/visible confirms it.
      { href: '/welcome/keepsake',         i: '💛', t: 'Keepsake', gated: 'leaving' },
      // b341 (2026-09-21): a family gives notice here — always visible (it is how a
      // family BECOMES leaving, so it cannot sit behind the leaving gate).
      { href: '/welcome/leaving',          i: ICONS.leaving, t: 'Leaving us' },
      { href: '/welcome/surveys',          i: '🗳️', t: 'Surveys' },
      { href: '/welcome/data-request',     i: '🔐', t: 'My Data' },
      // b249 (2026-09-01): a sibling of My Data, not a replacement for it — a
      // SAR asks for a child's RECORDS, this asks for one clip overwritten in seven days.
      { href: '/welcome/cctv-request',     i: '📹', t: 'Request CCTV Footage' },
      { href: '/welcome/about',            i: '🛡️', t: 'About & Security' }
    ] }
  ];
  // Flat list (bottom tabs + every item in every section) — used only to resolve
  // the active page's title for the topbar.
  var ALL = PRIMARY.concat(SECTIONS.reduce(function (a, g) { return a.concat(g.items); }, []));
  function isActive(href) {
    if (href === '/welcome') return p === '/welcome' || p === '/';
    return p === href || p.indexOf(href + '/') === 0;
  }

  // ═══ b339 (2026-09-18) — the shell that pages talk to ══════════════════════════
  // Toby put this next to the EYParent app and said it "looks more like a website".
  // Three things an app has that a website does not: it knows WHICH CHILD you are
  // looking at (and lets you switch), it tells you when something needs you (the
  // bell), and it follows your phone's light/dark setting. That state is here, once,
  // and pages read it through window.LapShell instead of each inventing their own.
  //
  //   LapShell.child()            selected child id, or null = all of this family's children
  //   LapShell.kids()             [{id, first_name}]  (first names only — that is all the shell keeps)
  //   LapShell.setKids(list)      a page that has already fetched the children can hand them over
  //   LapShell.choose(id|null)    switch child; every listening page re-renders
  //   LapShell.onChild(fn)        fn(id) whenever the selection changes
  //   LapShell.token()            Promise<bearer|null> — one minted token per tab, not one per call
  //   LapShell.setTitle(t) / setAction({label,href|onClick}) / bell(n)
  //   LapShell.colour.{get,set,refresh,custom}   'auto' | 'light' | 'dark'
  //   LapShell.contactHtml()      the nursery's contact card — the website footer, once
  //
  // Storage: the selected child is localStorage 'lap.child' ('all' or an id) — one key
  // for the whole app. The child list is sessionStorage only (names do not outlive the
  // tab). Every storage call is try/catch: private browsing throws on all of them.
  var CONTACT = {
    name: 'Your Nursery', phone: '020 7946 0000', tel: '02079460000',
    email: 'info@example-nursery.co.uk', addr: '123 Example Lane, Your Town, AB1 2CD',
    hours: 'Mon–Fri 8:00am–6:00pm', web: 'www.example-nursery.co.uk'
  };
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var SVG = {
    back:  ico('<path d="M15 5l-7 7 7 7"/>'),
    bell:  ico('<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.6 2H4.4z"/><path d="M10 21a2.2 2.2 0 0 0 4 0"/>'),
    caret: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.5l3 3 3-3"/></svg>',
    phone: ico('<path d="M6.6 3.5h2.7l1.3 3.4-1.7 1.2a10 10 0 0 0 5.7 5.7l1.2-1.7 3.4 1.3v2.7a1.9 1.9 0 0 1-2 1.9A15.6 15.6 0 0 1 4.7 5.5a1.9 1.9 0 0 1 1.9-2z"/>'),
    mail:  ico('<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M4 7.5l8 6 8-6"/>'),
    people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8.5" r="3.2"/><path d="M3.2 19.5c.4-3.2 2.8-5 5.8-5s5.4 1.8 5.8 5"/><circle cx="17.2" cy="9.5" r="2.4"/><path d="M16.5 14.6c2.6-.2 4.3 1.2 4.6 3.9"/></svg>',
    pin:   ico('<path d="M12 21s6.5-5.6 6.5-11a6.5 6.5 0 0 0-13 0c0 5.4 6.5 11 6.5 11z"/><circle cx="12" cy="10" r="2.3"/>')
  };

  // ── colour: light · dark · follow the phone ──────────────────────────────────
  // lap-boot.js does this before first paint; this is the same decision made again
  // when the parent flips the switch in Your account or the phone changes theme.
  function colourPref() { var v = lsGet('lap.colour'); return (v === 'light' || v === 'dark') ? v : 'auto'; }
  function customPalette() {
    try { var t = JSON.parse(lsGet('wren.theme') || 'null'); return !!(t && t.bg && t.text && t.accent); } catch (e) { return false; }
  }
  function applyColour() {
    var de = document.documentElement;
    if (customPalette()) { de.classList.add('lap-custom'); de.removeAttribute('data-lap-theme'); return; }
    de.classList.remove('lap-custom');
    var pref = colourPref(), dark = pref === 'dark' ||
      (pref === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    de.setAttribute('data-lap-theme', dark ? 'dark' : 'light');
    de.classList.toggle('lap-dark', dark);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', dark ? '#13201a' : GREEN);
  }
  function setColour(v) {
    if (v === 'light' || v === 'dark') lsSet('lap.colour', v); else lsDel('lap.colour');
    applyColour();
  }
  try {
    var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    var onMq = function () { if (colourPref() === 'auto') applyColour(); };
    if (mq) { if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq); }
  } catch (e) {}

  // ── one bearer token per tab ─────────────────────────────────────────────────
  // /api/notifications wants a bearer token and the parents pages do not send one
  // (the session cookie is the credential everywhere else). The pages that need a
  // token mint one via /api/auth/cf-auto-login — which is rate-limited to 5 a
  // minute — so a shell that minted its own on every page would lock a parent out
  // of the pages that need it. Cached per tab for at most ten minutes (and never past its own
  // expiry), and a failed mint is not retried for a minute.
  var _tokP = null, _tokFailAt = 0;
  function jwtExpMs(t) {
    try { var b = String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(atob(b)).exp * 1000; }
    catch (e) { return 0; }
  }
  function token() {
    if (window.TOKEN) return Promise.resolve(window.TOKEN);
    try {
      var c = JSON.parse(ssGet('lap.tok') || 'null');
      if (c && c.t && c.x > Date.now() + 30000) return Promise.resolve(c.t);
    } catch (e) {}
    if (_tokP) return _tokP;
    if (Date.now() - _tokFailAt < 60000) return Promise.resolve(null);
    _tokP = fetch('/api/auth/cf-auto-login', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.token) { _tokFailAt = Date.now(); return null; }
        // ten minutes at most, whatever the token's own life: on a shared family tablet a different
        // parent can sign in inside the same tab, and their bell must not read the last parent's token
        ssSet('lap.tok', JSON.stringify({ t: j.token, x: Math.min(jwtExpMs(j.token) || Infinity, Date.now() + 600000) }));
        if (j.children) setKids(j.children);
        if (typeof j.enquiry_mode === 'boolean') setEnquiryMode(j.enquiry_mode);
        return j.token;
      })
      .catch(function () { _tokFailAt = Date.now(); return null; })
      .then(function (t) { _tokP = null; return t; });
    return _tokP;
  }

  // ── which child ──────────────────────────────────────────────────────────────
  function kids() {
    try {
      return (JSON.parse(ssGet('lap.kids') || 'null') || []).map(function (k) { return { id: k[0], first_name: k[1] }; });
    } catch (e) { return []; }
  }
  function selected() {
    var v = lsGet('lap.child');
    if (v == null || v === 'all') {
      // b405 (2026-10-06): a single-child family never sees the switcher sheet
      // (openKidSheet() below returns early under 2 children, and the chip
      // renders static) — so `lap.child` is never written and this used to
      // return null forever, which pages like meet-the-team.html and
      // working-on.html treated as "no child chosen yet" and blocked on
      // permanently. There is no actual ambiguity with exactly one child —
      // "all children" and "this one child" are the same set — so resolve it
      // to that child directly, same as paintChip() already does for display.
      var list = kids();
      return list.length === 1 ? list[0].id : null;
    }
    var n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  }
  function emitChild() {
    try { document.dispatchEvent(new CustomEvent('lap:child', { detail: { id: selected() } })); } catch (e) {}
  }
  function setKids(list) {
    var clean = (list || []).filter(function (c) { return c && c.id != null && c.first_name; })
      .map(function (c) { return [Number(c.id), String(c.first_name)]; });
    if (!clean.length) return;
    var now = JSON.stringify(clean);
    if (ssGet('lap.kids') === now) return;
    ssSet('lap.kids', now);
    var sel = selected(), changed = false;
    // a remembered child who is no longer one of theirs falls back to "all"
    if (sel !== null && !clean.some(function (c) { return c[0] === sel; })) { lsSet('lap.child', 'all'); changed = true; }
    paintChip();
    if (changed) emitChild();
  }
  function choose(id) {
    lsSet('lap.child', id == null ? 'all' : String(id));
    paintChip(); emitChild();
  }
  // when neither a page nor cf-auto-login has told us who the children are (a browser
  // that reaches the portal by session cookie alone), ask the diary once per tab
  function kidsFallback() {
    if (kids().length || ssGet('lap.kids.tried') === '1') return;
    ssSet('lap.kids.tried', '1');
    fetch('/welcome/diary/api/days', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.children) setKids(d.children); })
      .catch(function () {});
  }
  function initial(name) { var c = String(name || '?').trim().charAt(0); return c ? c.toUpperCase() : '?'; }
  function paintChip() {
    var el = document.getElementById('lap-chip');
    if (!el) return;
    var list = kids();
    if (!list.length) { el.hidden = true; return; }
    var one = list.length === 1, sel = selected();
    var who = one ? list[0] : (sel == null ? null : list.filter(function (c) { return c.id === sel; })[0] || null);
    el.hidden = false;
    el.className = 'lap-chip' + (one ? ' lap-static' : '');
    el.setAttribute('aria-label', one ? 'Showing ' + list[0].first_name : 'Showing ' + (who ? who.first_name : 'all children') + '. Switch child');
    el.innerHTML = '<span class="lap-av' + (who ? '' : ' all') + '">' + (who ? esc(initial(who.first_name)) : SVG.people) + '</span>' +
      '<span class="lap-chip-n">' + esc(who ? who.first_name : 'All children') + '</span>' + (one ? '' : SVG.caret);
  }
  function openKidSheet() {
    var list = kids();
    if (list.length < 2) return;
    var sel = selected();
    var s = document.getElementById('lap-kidsheet');
    if (!s) {
      s = document.createElement('div'); s.className = 'lap-sheet'; s.id = 'lap-kidsheet';
      s.addEventListener('click', function (e) { if (e.target === s) s.classList.remove('lap-open'); });
      document.body.appendChild(s);
    }
    function row(id, name, all) {
      return '<button type="button" role="radio" class="lap-kid-row" data-id="' + (id == null ? 'all' : id) + '" aria-checked="' + ((id == null ? sel == null : sel === id) ? 'true' : 'false') + '">' +
        '<span class="lap-av' + (all ? ' all' : '') + '">' + (all ? SVG.people : esc(initial(name))) + '</span><span>' + esc(name) + '</span></button>';
    }
    s.innerHTML = '<div class="lap-sheet-card" role="dialog" aria-label="Choose a child"><div class="lap-sheet-grip"></div><h4>Choose a child</h4>' +
      '<div class="lap-grid" role="radiogroup">' + row(null, 'All children', true) +
      list.map(function (c) { return row(c.id, c.first_name, false); }).join('') + '</div></div>';
    Array.prototype.forEach.call(s.querySelectorAll('.lap-kid-row'), function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-id');
        choose(v === 'all' ? null : parseInt(v, 10));
        s.classList.remove('lap-open');
      });
    });
    s.classList.add('lap-open');
  }

  // ── the bell ─────────────────────────────────────────────────────────────────
  // Wired to whatever /api/notifications already says for a parent. (Its recipient
  // key is the parent token's primary child, so a family with two children sees the
  // first child's notifications — a server-side limit this build does not change.)
  function paintBell(n) {
    var d = document.getElementById('lap-bell-dot'), b = document.getElementById('lap-bell');
    n = parseInt(n, 10) || 0;
    if (d) d.hidden = !(n > 0);
    if (b) b.setAttribute('aria-label', n > 0 ? 'Notifications, ' + n + ' unread' : 'Notifications');
  }
  function pollBell() {
    if (!document.getElementById('lap-bell')) return;
    token().then(function (t) {
      if (!t) return null;
      return fetch('/api/notifications/unread-count', { headers: { Authorization: 'Bearer ' + t } })
        .then(function (r) { if (r.status === 401) { ssSet('lap.tok', ''); return null; } return r.ok ? r.json() : null; });
    }).then(function (j) { if (j) paintBell(j.count); }).catch(function () {});
  }

  // ── title row: back · name · (one action) ────────────────────────────────────
  function setTitle(t) { var el = document.querySelector('.lap-top .lap-title'); if (el && t) el.textContent = t; }
  function setAction(a) {
    var top = document.querySelector('.lap-top');
    if (!top) return;
    var old = top.querySelector('.lap-act'); if (old) old.parentNode.removeChild(old);
    top.classList.toggle('has-act', !!(a && a.label));
    if (!a || !a.label) return;
    var el = document.createElement(a.href ? 'a' : 'button');
    el.className = 'lap-act'; el.textContent = a.label;
    if (a.href) el.href = a.href; else { el.type = 'button'; el.addEventListener('click', a.onClick || function () {}); }
    top.insertBefore(el, top.querySelector('#lap-chip') || top.querySelector('#lap-bell'));
  }

  // ── the nursery's contact card (the website footer, once) ────────────────────
  function contactHtml() {
    return '<div class="lap-contact">' +
      '<a href="tel:' + CONTACT.tel + '"><span class="lap-ci">' + SVG.phone + '</span><span><b>' + CONTACT.phone + '</b>' +
        '<small>Press 1 for the Baby Room, 2 for Pre-school</small></span></a>' +
      '<a href="mailto:' + CONTACT.email + '"><span class="lap-ci">' + SVG.mail + '</span><span><b>' + CONTACT.email + '</b>' +
        '<small>Write to the office</small></span></a>' +
      '<div class="lap-addr"><strong>' + CONTACT.name + '</strong><br>' + CONTACT.addr + '<br>' + CONTACT.hours +
        ' · <a href="https://' + CONTACT.web + '" style="display:inline;padding:0;border:0;min-height:0">' + CONTACT.web + '</a></div></div>';
  }
  function fillContactSlots() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-lap-contact]'), function (el) { el.innerHTML = contactHtml(); });
  }

  window.LapShell = {
    child: selected, kids: kids, setKids: setKids, choose: choose,
    onChild: function (fn) { document.addEventListener('lap:child', function (e) { fn(e.detail.id); }); },
    token: token, setTitle: setTitle, setAction: setAction, bell: paintBell,
    contactHtml: contactHtml, CONTACT: CONTACT,
    // b399 (2026-10-06) — enquiryMode() is the cached answer (sync, from this
    // tab's last cf-auto-login); onEnquiryMode(fn) fires again once the real
    // answer comes back, for a page (home.html) that renders differently.
    enquiryMode: function () { return _enquiryMode; },
    onEnquiryMode: function (fn) { document.addEventListener('lap:enquirymode', function (e) { fn(e.detail.on); }); },
    colour: { get: colourPref, set: setColour, refresh: applyColour, custom: customPalette }
  };
  applyColour();

  function build() {
    if (document.querySelector('.lap-bn')) return;       // idempotent

    var primaryActive = PRIMARY.some(function (n) { return isActive(n.href); });
    function tabHtml(n) {
      return '<a href="' + n.href + '"' + (isActive(n.href) ? ' class="lap-active"' : '') +
             '><span class="lap-i">' + n.i + '</span><span>' + n.t + '</span></a>';
    }

    // bottom nav — b370 (2026-10-01): a raised centre "quick menu" button sits between
    // Journey and Diary, EYParent's big "+" redrawn as a hamburger per Toby's brief.
    var bn = document.createElement('nav'); bn.className = 'lap-bn'; bn.setAttribute('aria-label', 'Primary');
    bn.innerHTML = PRIMARY.slice(0, 2).map(tabHtml).join('') +
      '<button type="button" id="lap-quick" class="lap-quick" aria-label="Quick menu">' +
      '<span class="lap-i">' + ICONS.quick + '</span></button>' +
      PRIMARY.slice(2).map(tabHtml).join('') +
      '<button type="button" id="lap-more"' + (!primaryActive ? ' class="lap-active"' : '') +
      ' aria-label="More"><span class="lap-i">' + ICONS.more + '</span><span>More</span></button>';
    document.body.appendChild(bn);
    applyEnquiryMode(bn); // b399 — hides Journey/Diary tabs for a cached enquiry-mode family

    // ── More sheet (b370, 2026-10-01) — two screens, not one long list: SECTIONS
    //    tiles first, then that section's own items as icon tiles. gatePhonics()/
    //    gateKeepsake() cache what they learn so a re-render (switching section)
    //    still shows an already-unlocked gated tile without re-fetching. ─────────
    var sheet = document.createElement('div'); sheet.className = 'lap-sheet'; sheet.id = 'lap-sheet';
    sheet.innerHTML = '<div class="lap-sheet-card" role="dialog" aria-label="All sections"></div>';
    document.body.appendChild(sheet);
    var sheetCard = sheet.querySelector('.lap-sheet-card');
    var sheetView = 'sections';

    function sectionTile(key, icon, label) {
      return '<button type="button" class="lap-tile lap-tile-sec" data-open-section="' + key + '">' +
        '<span class="lap-tile-i" aria-hidden="true">' + icon + '</span><span class="lap-tile-t">' + esc(label) + '</span></button>';
    }
    // parentsapp-20261023 (Toby: "say what's in each setting, so nursery life should say what's in there so you can click and
    // see"): the first screen lists each section as a ROW with a one-line "what's inside", built from the section's own items so
    // it can never fall out of step. Gated items (Phonics, Keepsake, What we're working on) are left out of the line, since a
    // family may not have them. Tapping the row opens the section exactly as the tile did. Nothing is removed.
    function sectionSub(s) {
      return s.items.filter(function (it) { return !it.gated && (!_enquiryMode || enquiryAllowed(it.href)); })
        .map(function (it) { return it.t; }).join(', ');
    }
    function sectionRow(key, icon, label, sub) {
      return '<button type="button" class="lap-sec-row" data-open-section="' + key + '">' +
        '<span class="lap-sec-i" aria-hidden="true">' + icon + '</span>' +
        '<span class="lap-sec-text"><span class="lap-sec-t">' + esc(label) + '</span>' +
        (sub ? '<span class="lap-sec-sub">' + esc(sub) + '</span>' : '') + '</span>' +
        '<span class="lap-sec-chev" aria-hidden="true">›</span></button>';
    }
    function itemTile(n) {
      var gated = n.gated ? ' data-gated="' + n.gated + '" style="display:none"' : '';
      return '<a class="lap-tile' + (isActive(n.href) ? ' lap-active' : '') + '" href="' + n.href + '"' + gated + '>' +
        '<span class="lap-tile-i" aria-hidden="true">' + n.i + '</span><span class="lap-tile-t">' + esc(n.t) + '</span></a>';
    }
    function toolTile(id, icon, label) {
      return '<button type="button" class="lap-tile" id="' + id + '">' +
        '<span class="lap-tile-i" aria-hidden="true">' + icon + '</span><span class="lap-tile-t">' + esc(label) + '</span></button>';
    }
    function sheetHead(label) {
      return '<div class="lap-sheet-head"><button type="button" class="lap-sheet-back" id="lap-sheet-back" ' +
        'aria-label="Back to all sections">' + SVG.back + '</button><h4>' + esc(label) + '</h4></div>';
    }
    function renderSheet() {
      var html = '<div class="lap-sheet-grip"></div>';
      if (sheetView === 'sections') {
        // b399 — a section with nothing an enquiry-mode family can open is not offered at all.
        var secList = !_enquiryMode ? SECTIONS : SECTIONS.filter(function (s) {
          return s.items.some(function (it) { return enquiryAllowed(it.href); });
        });
        html += '<h4>All sections</h4><div class="lap-sec-list">' +
          secList.map(function (s) { return sectionRow(s.key, s.icon, s.label, sectionSub(s)); }).join('') +
          sectionRow('help', '🧭', 'Help & tools', 'Ask Wren, Appearance, App Lock, Tell us what to change, Report a bug, My reports, Take a tour') +
          sectionRow('contact', '☎️', 'Contact us', 'Phone, email, address and opening hours') + '</div>';
      } else if (sheetView === 'help') {
        /* Help & tools — the assistant chat, feedback and theme editor live here
           rather than as separate always-hovering floating buttons. */
        html += sheetHead('Help & tools') + '<div class="lap-tiles">' +
          toolTile('lap-tool-chat', '🐦', 'Ask Wren') + toolTile('lap-tool-theme', '🎨', 'Appearance') +
          toolTile('lap-tool-applock', '🔒', 'App Lock') + toolTile('lap-tool-appfeedback', '💭', 'Tell us what to change') +
          toolTile('lap-tool-feedback', '🐞', 'Report a bug') +
          /* b395 (2026-10-05, D12) — ADDED, nothing above removed or reordered. */
          itemTile({ i: '📋', t: 'My reports', href: '/welcome/my-reports' }) +
          toolTile('lap-tool-tour', '🧭', 'Take a tour') + '</div>';
      } else if (sheetView === 'contact') {
        html += sheetHead('Contact us') + contactHtml();
      } else {
        var s = SECTIONS.filter(function (x) { return x.key === sheetView; })[0];
        if (!s) { sheetView = 'sections'; return renderSheet(); }
        html += sheetHead(s.label) + '<div class="lap-tiles">' + s.items.map(itemTile).join('') + '</div>';
      }
      sheetCard.innerHTML = html;
      applyGates(sheetCard);
      applyEnquiryMode(sheetCard); // b399
    }
    renderSheet();

    function openSheet() { sheetView = 'sections'; renderSheet(); sheet.classList.add('lap-open'); }
    function closeSheet() { sheet.classList.remove('lap-open'); }
    document.getElementById('lap-more').addEventListener('click', openSheet);
    sheet.addEventListener('click', function (e) {
      if (e.target === sheet) return closeSheet();
      var openBtn = e.target.closest('[data-open-section]');
      if (openBtn) { sheetView = openBtn.getAttribute('data-open-section'); renderSheet(); sheetCard.scrollTop = 0; return; }
      if (e.target.closest('#lap-sheet-back')) { sheetView = 'sections'; renderSheet(); return; }
      if (e.target.closest('#lap-tool-chat'))  { closeSheet(); openChat(); return; }
      if (e.target.closest('#lap-tool-theme')) { closeSheet(); openTheme(); return; }
      if (e.target.closest('#lap-tool-applock')) { closeSheet(); openAppLock(); return; }
      if (e.target.closest('#lap-tool-appfeedback')) { closeSheet(); openAppFeedback(); return; }
      if (e.target.closest('#lap-tool-feedback')) { closeSheet(); openFeedback(); return; }
      if (e.target.closest('#lap-tool-tour')) {
        closeSheet();
        // b201: open the track chooser (Finch: daily / everything) rather than the
        // three-step 2026-07 walk; that walk is still there as "Quick tour".
        try {
          if (window.WrenTour && WrenTour.chooser) WrenTour.chooser('parents');
          else if (window.WrenTour) WrenTour.start('parents', { force: true });
        } catch (e2) {}
      }
    });

    // ── Quick menu (b370, 2026-10-01) — the raised hamburger button. First and
    //    largest: the Invoices / Payments balance; then the handful of things a
    //    parent reaches for most. Loaded lazily (only when opened). ────────────
    function quickSheet() {
      var s = document.getElementById('lap-quicksheet');
      if (s) return s;
      s = document.createElement('div'); s.className = 'lap-sheet'; s.id = 'lap-quicksheet';
      s.innerHTML = '<div class="lap-sheet-card" role="dialog" aria-label="Quick menu">' +
        '<div class="lap-sheet-grip"></div><h4>Quick menu</h4>' +
        '<div id="lap-qbal"><div class="lap-qbal-skel" aria-hidden="true"></div></div>' +
        '<div class="lap-sheet-sub">Quick actions</div><div class="lap-tiles">' +
          '<a class="lap-tile" href="/welcome/absence"><span class="lap-tile-i" aria-hidden="true">🏝️</span><span class="lap-tile-t">Report Absence</span></a>' +
          '<a class="lap-tile" href="/welcome/messages"><span class="lap-tile-i" aria-hidden="true">' + ICONS.messages + '</span><span class="lap-tile-t">Messages</span></a>' +
          '<a class="lap-tile" href="/welcome/diary"><span class="lap-tile-i" aria-hidden="true">' + ICONS.diary + '</span><span class="lap-tile-t">Diary</span></a>' +
          '<a class="lap-tile" href="/welcome/menu"><span class="lap-tile-i" aria-hidden="true">🍽</span><span class="lap-tile-t">Menu</span></a>' +
        '</div></div>';
      s.addEventListener('click', function (e) { if (e.target === s) s.classList.remove('lap-open'); });
      document.body.appendChild(s);
      applyEnquiryMode(s); // b399
      return s;
    }
    function fmtGbp(pence) { return '£' + ((pence || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function loadQuickBalance() {
      var box = document.getElementById('lap-qbal');
      if (!box) return;
      Promise.all([
        fetch('/welcome/invoices/api/summary', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
        fetch('/welcome/pay/api/methods', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
      ]).then(function (res) {
        var box2 = document.getElementById('lap-qbal');
        if (!box2) return;
        var sum = res[0], methods = res[1] || {};
        if (!sum) { box2.innerHTML = '<a class="lap-qbal" href="/welcome/invoices"><span class="lap-qbal-k">Invoices / Payments</span><span class="lap-qbal-s">Open Invoices / Payments ›</span></a>'; return; }
        var owed = sum.outstanding_pence || 0;
        box2.innerHTML = '<a class="lap-qbal' + (owed > 0 ? ' owed' : '') + '" href="/welcome/invoices">' +
          '<span class="lap-qbal-k">Invoices / Payments</span><span class="lap-qbal-amt">' + fmtGbp(owed) + '</span>' +
          '<span class="lap-qbal-s">' + (owed > 0 ? (methods.card ? 'Tap to pay by card' : 'Outstanding balance') : 'All paid up') + '</span></a>';
        applyEnquiryMode(box2); // b399 — invoices are refused in enquiry mode
      });
    }
    document.getElementById('lap-quick').addEventListener('click', function () {
      var s = quickSheet();
      s.classList.add('lap-open');
      loadQuickBalance();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      closeSheet();
      var qs = document.getElementById('lap-quicksheet'); if (qs) qs.classList.remove('lap-open');
    });

    // ── Title row (b339) ──────────────────────────────────────────────────────────
    // ONE compact row, EYParent-shaped: [back | logo] · screen name · (one action) ·
    // who this is for · the bell. It replaces the tall hero and the website nav.
    // The name comes from, in order: <meta name="lap-title">, the nav item this page
    // is, the page's own <h1> (the hero the shell hides still holds it), the <title>.
    var isHome = (p === '/welcome' || p === '/');
    var activeItem = ALL.filter(function (n) { return isActive(n.href); })[0];
    var metaTitle = document.querySelector('meta[name="lap-title"]');
    var h1 = document.querySelector('.hero h1, .page-hero h1, h1');
    var docTitle = (document.title || '').split(/\s[—·]\s/).filter(function (x) { return x && !/^Your Nursery$/i.test(x.trim()); })[0];
    var title = (metaTitle && metaTitle.content) || (activeItem && activeItem.t) ||
      (h1 && h1.textContent.trim()) || (docTitle && docTitle.trim()) || 'Your Nursery';
    var actMeta = document.querySelector('meta[name="lap-action"]');
    var onNotif = (p === '/welcome/notifications');
    var top = document.createElement('div'); top.className = 'lap-top'; top.setAttribute('role', 'banner');
    top.innerHTML =
      (isHome ? '<img class="lap-logo" src="/little-angels-logo.png" alt="Your Nursery">'
              : '<button type="button" class="lap-back" aria-label="Back">' + SVG.back + '</button>') +
      '<div class="lap-title">' + (isHome ? 'Your Nursery' : esc(title)) + '</div>' +
      (onNotif ? '' : '<button type="button" class="lap-chip" id="lap-chip" hidden></button>') +
      (onNotif ? '' : '<a class="lap-bell" id="lap-bell" href="/welcome/notifications" aria-label="Notifications">' + SVG.bell +
        '<span class="lap-bell-dot" id="lap-bell-dot" hidden></span></a>');
    document.body.insertBefore(top, document.body.firstChild);
    if (actMeta && actMeta.content) {
      setAction({ label: actMeta.content, href: actMeta.getAttribute('data-href') || null,
                  onClick: function () { document.dispatchEvent(new CustomEvent('lap:action')); } });
    }
    var backBtn = top.querySelector('.lap-back');
    if (backBtn) backBtn.addEventListener('click', function () {
      if (history.length > 1) history.back(); else location.href = '/welcome';
    });
    var chipEl = top.querySelector('#lap-chip'); if (chipEl) chipEl.addEventListener('click', openKidSheet);
    paintChip();

    // ── Onboarding tour (2026-07-16): load engine + register the parents walkthrough.
    //    First-visit offer shows automatically; re-launchable from the More sheet. ──
    ['/js/wren-tour.js', '/js/wren-wizard.js'].forEach(function (src) {
      if (!document.querySelector('script[src^="' + src + '"]')) {
        var sc = document.createElement('script'); sc.src = src + '?v=b201';
        (head() || document.documentElement).appendChild(sc);
      }
    });
    (function regParentsTour() {
      if (!window.WrenTour) { return setTimeout(regParentsTour, 200); }
      window.Wren = window.Wren || { edition: 'parents' };
      WrenTour.register('parents', [
        { sel: '.lap-top', title: 'Welcome to your parent hub', body: "Everything about your child lives here — this bar shows where you are." },
        { sel: '.lap-bn', title: 'Getting around', body: "Home, your child's Journey, the daily Diary and Messages are along the bottom." },
        { sel: '#lap-more', title: 'More', body: "Tap More for menus, consents, invoices, surveys, your child's records and everything else." }
      ]);
    })();
  }

  // ── 3. Install pop-up (2026-10-28, Toby: "parents could get the browser but not the
  //    app — they have to tap the hamburger menu rather than going to install, can you
  //    have the install pop-up as default"). Root cause was not the banner: Chrome fetches
  //    the manifest WITHOUT cookies, Cloudflare Access answered with its login page, so the
  //    manifest was invalid and Chrome never offered "Install" (beforeinstallprompt never
  //    fired, the old banner never appeared). Fixed by a CF Access bypass for
  //    /manifest.webmanifest + /icons/* (no personal data) and use-credentials on the link.
  //    Now a pop-up opens on the home screen by default until the app is installed:
  //      • Chrome/Edge (prompt available) → one "Install" button, the browser's own prompt;
  //      • anything else → the exact taps for that browser (Samsung, Chrome menu, Firefox,
  //        iPhone Share sheet, or "open this in your browser" from an in-app browser).
  //    "Not now" hides it for 3 days, not for ever (the old banner's dismissal was permanent,
  //    so parents who tapped it once never saw it again). "Done, it's installed" hides it
  //    for good; so does the app being opened from the home screen.
  var INSTALL_DONE = 'lap.install.done', INSTALL_SNOOZE = 'lap.install.snooze';
  var _deferredInstall = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); _deferredInstall = e;
    document.dispatchEvent(new CustomEvent('lap:installable'));
  });
  window.addEventListener('appinstalled', function () {
    lsSet(INSTALL_DONE, '1');
    var m = document.getElementById('lap-install'); if (m) m.remove();
  });
  function installSteps() {
    var ua = navigator.userAgent || '';
    var iOS = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    var inApp = /FBAN|FBAV|Instagram|Line\/|GSA\/|WhatsApp|; wv\)/i.test(ua);
    if (inApp) return { inApp: true, h: 'Open this in your browser first',
      steps: ['Tap the <b>⋮</b> or <b>…</b> menu at the top of this screen.',
              'Choose <b>Open in browser</b> (or <b>Open in Chrome / Safari</b>).',
              'Sign in, and this pop-up will show you how to install the app.'] };
    if (iOS) {
      if (/CriOS|FxiOS|EdgiOS/.test(ua)) return { h: 'Add Your Nursery to your Home Screen',
        steps: ['Tap the <b>Share</b> button <span aria-hidden="true">(⬆)</span> next to the address bar.',
                'Scroll down and tap <b>Add to Home Screen</b>.',
                'Tap <b>Add</b>. Open Your Nursery from your Home Screen from now on.'] };
      return { h: 'Add Your Nursery to your Home Screen',
        steps: ['Tap the <b>Share</b> button <span aria-hidden="true">(⬆)</span> at the bottom of Safari.',
                'Scroll down and tap <b>Add to Home Screen</b>.',
                'Tap <b>Add</b>. Open Your Nursery from your Home Screen from now on.'] };
    }
    if (/SamsungBrowser/i.test(ua)) return { h: 'Install the Your Nursery app',
      steps: ['Tap the <b>☰</b> menu at the bottom right.',
              'Tap <b>Add page to</b>, then <b>Apps screen</b> or <b>Home screen</b>.',
              'Open Your Nursery from that icon from now on.'] };
    if (/Firefox/i.test(ua)) return { h: 'Install the Your Nursery app',
      steps: ['Tap the <b>⋮</b> menu.', 'Tap <b>Install</b> (or <b>Add to Home screen</b>).',
              'Open Your Nursery from that icon from now on.'] };
    return { h: 'Install the Your Nursery app',
      steps: ['Tap the <b>⋮</b> menu at the top right.', 'Tap <b>Install app</b> (or <b>Add to Home screen</b>, then <b>Install</b>).',
              'Open Your Nursery from that icon from now on.'] };
  }
  function installUI(force) {
    var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (standalone) { lsSet(INSTALL_DONE, '1'); return; }
    if (!force) {
      if (lsGet(INSTALL_DONE) === '1') return;
      var snooze = Number(lsGet(INSTALL_SNOOZE) || 0);
      if (snooze && Date.now() < snooze) return;
      // Home only: it is where a parent is browsing, not reading one thing (2026-09-18).
      var onHome = /^\/welcome\/?$/.test(location.pathname) || location.pathname === '/';
      if (!onHome) return;
    }
    if (document.getElementById('lap-install')) return;

    function open() {
      // Never on top of the first-run intro cards: wait until they are gone.
      if (!force && document.getElementById('lap-intro')) return setTimeout(open, 1200);
      if (document.getElementById('lap-install')) return;
      var native = !!_deferredInstall;
      var how = installSteps();
      var box = document.createElement('div'); box.className = 'lap-install-modal'; box.id = 'lap-install';
      box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'lap-install-h');
      box.innerHTML = '<div class="lap-install-card">' +
        '<img src="/icons/icon-192.png" alt="" class="lap-install-icon" width="64" height="64">' +
        '<h2 id="lap-install-h">' + (native ? 'Install the Your Nursery app' : how.h) + '</h2>' +
        '<p class="lap-install-why">It opens straight to your child\'s day, keeps you signed in, and can send you notifications, with no browser bars.</p>' +
        (native ? '' : '<ol class="lap-install-steps">' + how.steps.map(function (t) { return '<li>' + t + '</li>'; }).join('') + '</ol>') +
        '<div class="lap-install-actions">' +
          (native ? '<button type="button" class="lap-install-go" data-act="go">Install</button>'
                  : how.inApp ? '<button type="button" class="lap-install-go" data-act="later">OK</button>'
                  : '<button type="button" class="lap-install-go" data-act="done">Done, it\'s installed</button>') +
          '<button type="button" class="lap-install-later" data-act="later">Not now</button>' +
        '</div></div>';
      document.body.appendChild(box);
      requestAnimationFrame(function () { box.classList.add('lap-show'); });
      var first = box.querySelector('.lap-install-go'); if (first) first.focus();
      function close() { box.remove(); }
      box.addEventListener('click', function (e) {
        var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
        if (e.target === box) act = 'later';
        if (!act) return;
        if (act === 'later') { lsSet(INSTALL_SNOOZE, String(Date.now() + 3 * 864e5)); close(); }
        else if (act === 'done') { lsSet(INSTALL_DONE, '1'); close(); }
        else if (act === 'go' && _deferredInstall) {
          var d = _deferredInstall; _deferredInstall = null; close();
          d.prompt();
          d.userChoice.then(function (c) {
            if (c && c.outcome === 'accepted') lsSet(INSTALL_DONE, '1');
            else lsSet(INSTALL_SNOOZE, String(Date.now() + 3 * 864e5));
          }).catch(function () {});
        }
      });
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape' && document.getElementById('lap-install')) { lsSet(INSTALL_SNOOZE, String(Date.now() + 3 * 864e5)); close(); document.removeEventListener('keydown', esc); }
      });
    }
    // Give Chrome a moment to say the app is installable, so it gets the one-tap version.
    if (_deferredInstall || force) return setTimeout(open, force ? 0 : 1200);
    var t = setTimeout(open, 2500);
    document.addEventListener('lap:installable', function () { clearTimeout(t); setTimeout(open, 300); }, { once: true });
  }
  // Re-open it from anywhere (the More sheet / getting-started guide can call this).
  window.lapShowInstall = function () { installUI(true); };

  // ── item 2 (2026-07-29) / b247 (2026-08-28) — gated tiles: the leaving Keepsake
  //    and Phonics stay hidden until the server confirms this family can see them.
  //    b370 (2026-10-01): the More sheet now renders a section's tiles (and any
  //    data-gated="…" among them) only once the parent drills into that section,
  //    so the old "skip the fetch if nothing is in the DOM yet" guard would mean
  //    a section opened after boot never gets gated — the fetch always runs now,
  //    its answer is cached, and applyGates() re-applies it to whatever is in the
  //    DOM right now (a page's own static nav row, or whichever sheet screen is
  //    showing). Fails closed (stays hidden) on any error/false answer. ──────────
  // ── b399 (2026-10-06) — "enquiry mode": a family on the pipeline but not
  // yet enrolled. The SAME allow-list as the server-side gate
  // (src/lib/parent-enquiry-mode.js) — kept here only to stop the nav
  // offering a tile that would 403, never the actual control (that is the
  // server gate; this is a UI nicety on top of it). Default-shown, hidden
  // once /api/auth/cf-auto-login confirms enquiry mode — the opposite
  // direction to the gated:'phonics' tiles above (default-hidden, revealed),
  // because most families are NOT in enquiry mode and should never see a
  // flash-then-hide on every page.
  var _enquiryMode = ssGet('lap.enqmode') === '1';
  var ENQUIRY_ALLOWED_HREFS = ['/welcome', '/welcome/messages', '/welcome/baby-log',
    '/welcome/notifications', '/welcome/notifications/settings', '/welcome/menu',
    '/welcome/policies', '/welcome/fees', '/welcome/about', '/welcome/details',
    // b400 (2026-10-06) — study/home-activities/resources/planning opened to
    // enquiry-mode families, same allow-list as src/lib/parent-enquiry-mode.js.
    '/welcome/study', '/welcome/home-activities', '/welcome/resources', '/welcome/planning'];
  function enquiryAllowed(href) { return ENQUIRY_ALLOWED_HREFS.indexOf(href) !== -1; }
  function setEnquiryMode(on) {
    on = !!on;
    if (ssGet('lap.enqmode') !== (on ? '1' : '0')) ssSet('lap.enqmode', on ? '1' : '0');
    _enquiryMode = on;
    if (on) applyEnquiryMode();
    try { document.dispatchEvent(new CustomEvent('lap:enquirymode', { detail: { on: on } })); } catch (e) {}
  }
  function applyEnquiryMode(root) {
    root = root || document;
    if (!_enquiryMode) return;
    var tiles = root.querySelectorAll('a[href^="/welcome"]');
    for (var i = 0; i < tiles.length; i++) {
      var href = tiles[i].getAttribute('href');
      if (href && !enquiryAllowed(href)) tiles[i].style.display = 'none';
    }
  }

  // b405 (2026-10-06, D08) — the parents-portal nav hide list (same mechanism b403 built
  // for the EY More menu: ladn.nav_layout, edition-scoped). A page marks a row
  // data-nav-key="some-id"; a manager hides that id via the existing
  // PUT /api/nav-layout/cell {edition:'parents-welcome', role:'*', section_id, hidden}.
  // Presentation-only, same as b403's — a hidden row's URL still works.
  function applyNavHide(root) {
    root = root || document;
    fetch('/welcome/nav-hidden/api/list', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var hidden = (d && d.hidden) || [];
        if (!hidden.length) return;
        for (var i = 0; i < hidden.length; i++) {
          var els = root.querySelectorAll('[data-nav-key="' + hidden[i].replace(/"/g, '') + '"]');
          for (var j = 0; j < els.length; j++) els[j].style.display = 'none';
        }
      })
      .catch(function () { /* fail open — nothing hides */ });
  }

  var _leavingVisible = false, _phonicsVisible = false, _nextStepsVisible = false;
  function applyGates(root) {
    root = root || document;
    if (_leavingVisible) {
      var a = root.querySelectorAll('[data-gated="leaving"],[data-keepsake-gate]');
      for (var i = 0; i < a.length; i++) a[i].style.display = '';
    }
    if (_phonicsVisible) {
      var b = root.querySelectorAll('[data-gated="phonics"]');
      for (var i = 0; i < b.length; i++) b[i].style.display = '';
    }
    if (_nextStepsVisible) {
      var c = root.querySelectorAll('[data-gated="next-steps"]');
      for (var i = 0; i < c.length; i++) c[i].style.display = '';
    }
  }
  function gateKeepsake() {
    fetch('/welcome/keepsake/api/visible', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.visible) { _leavingVisible = true; applyGates(); } })
      .catch(function () {});
  }
  function gatePhonics() {
    fetch('/api/phonics/parent/switch', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.enabled) { _phonicsVisible = true; applyGates(); } })
      .catch(function () {});
  }
  // b393 (2026-10-05) — "What we're working on", off until Toby switches it on.
  function gateNextSteps() {
    fetch('/api/parents/next-steps/switch', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.enabled) { _nextStepsVisible = true; applyGates(); } })
      .catch(function () {});
  }

  // ── b339 — first-run intro: three cards, once ───────────────────────────────
  // EYParent opens on a six-screen carousel; three is enough for what a parent needs
  // (what is here, how the diary fills in, how to reach us). It must never greet a
  // parent who has used the app before. The signal is the service worker: this script
  // registers it on every visit's load event, so a device that has ever opened the
  // portal already has a registration by the time it opens the next page — and a
  // brand-new device does not yet. No registration and no 'lap.intro.seen' = first run.
  // A browser that cannot tell (no service workers) is treated as returning: the safe
  // side of "never shown twice". Dismissing writes 'lap.intro.seen' and it is never
  // shown again on this device.
  function maybeIntro() {
    if (lsGet('lap.intro.seen') === '1') return;
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.getRegistration) return;
    navigator.serviceWorker.getRegistration('/').then(function (reg) {
      if (reg) { lsSet('lap.intro.seen', '1'); return; }        // returning device — never show
      // the guided-tour offer would pop up over this on the same first visit; the tour
      // stays one tap away in More → Take a tour, so hold that offer back for now
      lsSet('wren.tour.parents.offered', '1');
      var tries = 0;
      (function go() {
        if (document.getElementById('lap-lock') && tries++ < 60) return setTimeout(go, 1000);  // never over the PIN screen
        loadScript('/js/wren-parent-empty.js', function () {
          if (window.WrenParentEmpty && WrenParentEmpty.art) showIntro();
        });
      })();
    }).catch(function () {});
  }
  function showIntro() {
    if (document.getElementById('lap-intro')) return;
    var art = WrenParentEmpty.art;
    var cards = [
      { k: 'journey',  h: 'Everything for your child, in one place',
        t: 'Photos and moments from their day, their learning journey, invoices, forms and more.' },
      { k: 'diary',    h: 'The diary fills in through the day',
        t: 'Meals, naps and nappies appear as the team log them. The bell tells you when there is something new.' },
      { k: 'messages', h: 'We\u2019re always here',
        t: 'Message your child\u2019s key person, or call the office on ' + CONTACT.phone + ', ' + CONTACT.hours + '.' }
    ];
    var box = document.createElement('div'); box.className = 'lap-intro'; box.id = 'lap-intro';
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Welcome to the Your Nursery app');
    box.innerHTML = '<button type="button" class="lap-intro-skip">Skip</button><div class="lap-intro-track">' +
      cards.map(function (c) { return '<section class="lap-intro-card">' + art(c.k) + '<h2>' + esc(c.h) + '</h2><p>' + esc(c.t) + '</p></section>'; }).join('') +
      '</div><div class="lap-intro-foot"><div class="lap-intro-dots">' + cards.map(function (_, i) { return '<i' + (i ? '' : ' class="on"') + '></i>'; }).join('') +
      '</div><button type="button" class="lap-intro-go">Next</button></div>';
    document.body.appendChild(box);
    var prevOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    var track = box.querySelector('.lap-intro-track'), dots = box.querySelectorAll('.lap-intro-dots i'), go = box.querySelector('.lap-intro-go');
    function idx() { return Math.max(0, Math.min(cards.length - 1, Math.round(track.scrollLeft / Math.max(1, track.clientWidth)))); }
    function paint() {
      var i = idx();
      Array.prototype.forEach.call(dots, function (d, n) { d.className = n === i ? 'on' : ''; });
      go.textContent = i === cards.length - 1 ? 'Get started' : 'Next';
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    function close() {
      lsSet('lap.intro.seen', '1');
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey);
      if (box.parentNode) box.parentNode.removeChild(box);
    }
    document.addEventListener('keydown', onKey);
    track.addEventListener('scroll', paint);
    go.addEventListener('click', function () {
      var i = idx();
      if (i >= cards.length - 1) return close();
      track.scrollTo({ left: track.clientWidth * (i + 1), behavior: 'smooth' });
    });
    box.querySelector('.lap-intro-skip').addEventListener('click', close);
    go.focus();
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────
  function boot() {
    build(); installUI(); gateKeepsake(); gatePhonics(); gateNextSteps(); fillContactSlots();
    applyNavHide(); // b405 (D08) — the parents-portal nav hide list (ladn.nav_layout, edition 'parents-welcome')
    applyEnquiryMode(); // b399 — catches a page's own static /welcome links (e.g. home.html's nav-groups) for a tab that already knows
    // who the children are: from this tab's cache, else from the token mint, else the diary
    paintChip();
    token().then(function () { kidsFallback(); });
    pollBell();
    setInterval(function () { if (document.visibilityState === 'visible') pollBell(); }, 60000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') pollBell(); });
    maybeIntro();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

// First-party traffic beacon (2026-07-30) — anonymous page-view + dwell, no cookies/PII.
// Same-origin POST to /api/analytics/beacon (gate-exempt); records host+path+per-tab id.
(function () {
  try {
    var sid = sessionStorage.getItem('wren_an_sid');
    if (!sid) { sid = Date.now().toString(36) + Math.random().toString(36).slice(2, 10); sessionStorage.setItem('wren_an_sid', sid); }
    var body = function () { return JSON.stringify({ host: location.hostname, path: location.pathname, sid: sid }); };
    var send = function () {
      try {
        if (navigator.sendBeacon) navigator.sendBeacon('/api/analytics/beacon', new Blob([body()], { type: 'application/json' }));
        else fetch('/api/analytics/beacon', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(), keepalive: true });
      } catch (e) {}
    };
    send();
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') send(); });
    window.addEventListener('pagehide', send);
  } catch (e) {}
})();
