/* wren-attention-lights.js — b232 (2026-08-26)
 *
 * Three dots with counts: red / amber / green, from the b232 attention board.
 * Mounted on the Roost landing page (in the topbar, so it is there whichever
 * section you land on after signing in) and again as a strip at the top of the
 * Cockpit.
 *
 * ── THE TWO RULES ───────────────────────────────────────────────────────────
 *
 *  1. ONE CHEAP CALL. GET /api/attention/summary returns four integers and
 *     nothing else — a single GROUP BY over one small table. It must never be
 *     the reason a page feels slow, so it is fired after paint and nothing waits
 *     on it.
 *
 *  2. FAILURE RENDERS NOTHING. Not an error, not a spinner, not a zero — the
 *     strip simply does not appear. It is a glance, not a report; a broken
 *     glance should be invisible rather than alarming. That also means the whole
 *     file is safe on any page where /api/attention is not mounted, which is
 *     every portal except Roost.
 *
 * Usage:  WrenAttentionLights.mount(element)      element is emptied and filled
 *         WrenAttentionLights.mount(element, { compact: true })   topbar size
 */
(function () {
  'use strict';

  var ENDPOINT = '/api/attention/summary';
  var SECTION_URL = '/admin/attention/board';
  var CSS_ID = 'wren-attention-lights-css';

  var CSS = [
    '.wren-lights{display:inline-flex;align-items:center;gap:10px;text-decoration:none;color:inherit;',
    '  border:1px solid var(--c-border);border-radius:999px;padding:5px 12px;background:var(--c-card);',
    '  font-size:.78rem;line-height:1;white-space:nowrap}',
    '.wren-lights:hover{border-color:var(--c-muted)}',
    '.wren-lights .wl{display:inline-flex;align-items:center;gap:5px;font-variant-numeric:tabular-nums}',
    '.wren-lights .wl i{width:8px;height:8px;border-radius:50%;display:inline-block;font-style:normal}',
    '.wren-lights .wl.red i{background:var(--c-red)}',
    '.wren-lights .wl.amber i{background:var(--c-amber)}',
    '.wren-lights .wl.green i{background:var(--c-green)}',
    '.wren-lights .wl.red{color:var(--c-red);font-weight:700}',
    '.wren-lights .wl.amber{color:var(--c-amber)}',
    '.wren-lights .wl.green{color:var(--c-muted)}',
    '.wren-lights .wl-label{color:var(--c-muted);margin-right:2px}',
    '.wren-lights.compact{padding:4px 10px;gap:8px;font-size:.74rem}',
    '.wren-lights.compact .wl-label{display:none}',
    /* The topbar is tight on a phone and the Cockpit strip says the same thing
       one screen below, so the topbar copy stands down rather than crowding. */
    '@media (max-width:900px){.wren-lights.compact{display:none}}',
    '.wren-lights-strip{margin-bottom:12px}',
  ].join('\n');

  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    var st = document.createElement('style');
    st.id = CSS_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function token() {
    try { return sessionStorage.getItem('wrenToken') || ''; } catch (e) { return ''; }
  }

  function fetchSummary() {
    var t = token();
    if (!t) return Promise.reject(new Error('no token'));
    return fetch(ENDPOINT, {
      headers: { Authorization: 'Bearer ' + t },
      credentials: 'same-origin',
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function render(el, s, opts) {
    var red = s.red | 0, amber = s.amber | 0, green = s.green | 0;
    var a = document.createElement('a');
    a.className = 'wren-lights' + (opts && opts.compact ? ' compact' : ' wren-lights-strip');
    a.href = SECTION_URL;
    a.title = 'Wren is watching: ' + red + ' need you now, ' + amber + ' this week, ' + green + ' on track';   // b504 — relabelled; My list is the list
    a.setAttribute('aria-label', a.title);
    a.innerHTML =
        '<span class="wl-label">What needs me</span>'
      + '<span class="wl red"><i></i>' + red + '</span>'
      + '<span class="wl amber"><i></i>' + amber + '</span>'
      + '<span class="wl green"><i></i>' + green + '</span>';

    // The SPA owns its own routing; a full page load would throw away the shell.
    a.addEventListener('click', function (ev) {
      if (window.Wren && typeof Wren.navigate === 'function') {
        ev.preventDefault();
        Wren.navigate('attention', 'board');
      }
    });

    el.innerHTML = '';
    el.appendChild(a);
  }

  function mount(el, opts) {
    if (!el) return Promise.resolve(null);
    injectCss();
    return fetchSummary().then(function (s) {
      if (!s || typeof s.red !== 'number') { el.innerHTML = ''; return null; }
      render(el, s, opts);
      return s;
    }).catch(function () {
      // Rule 2. Nothing at all.
      el.innerHTML = '';
      return null;
    });
  }

  window.WrenAttentionLights = { mount: mount, ENDPOINT: ENDPOINT };
})();
