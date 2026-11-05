/* Wren — the Fledge switch, browser side (fledge-off, 2026-10-26)
 *
 * Toby, 26 Oct 2026: "we're not launching [Fledge] yet, so don't mention it, turn
 * it off and everything's Birth to 5 and they're allowed to tag the statements."
 *
 * ONE switch: ladn.settings.fledge_enabled, read on the server by
 * src/lib/fledge-switch.js and handed to staff pages as `fledge_enabled` on
 * GET /api/features/public. This file is the only browser code that fetches it.
 *
 *   WrenFledge.enabled()  → boolean now (false until the answer arrives — FAIL CLOSED)
 *   WrenFledge.ready()    → Promise<boolean>, resolves once the server has answered
 *   document event 'wren:fledge' (detail: {enabled}) fires when the answer lands
 *
 * Markup: anything carrying a `data-fledge` attribute is hidden unless Fledge is on
 * (<html class="wren-fledge-on">). Hidden, never deleted — nav items, cards and
 * chips come back the moment the setting is switched on. Load this file WITHOUT
 * defer (in <head>) on a page that has such markup, so the rule is in place before
 * anything paints. wren-core.js also loads it on every page that uses that core.
 */
(function () {
  'use strict';
  if (window.WrenFledge) return;

  var root = document.documentElement;
  var CK = 'wrenFledgeOn';

  try {
    var st = document.createElement('style');
    st.id = 'wren-fledge-css';
    st.textContent = 'html:not(.wren-fledge-on) [data-fledge]{display:none !important}';
    (document.head || root).appendChild(st);
  } catch (_) { /* styling only */ }

  var on = false;
  try { on = sessionStorage.getItem(CK) === '1'; } catch (_) { on = false; }
  if (on) root.classList.add('wren-fledge-on');

  function apply(v) {
    on = !!v;
    root.classList.toggle('wren-fledge-on', on);
    try { sessionStorage.setItem(CK, on ? '1' : '0'); } catch (_) {}
    try { document.dispatchEvent(new CustomEvent('wren:fledge', { detail: { enabled: on } })); } catch (_) {}
    return on;
  }

  var p = null;
  function ready() {
    if (p) return p;
    var token = null, device = '';
    try { token = sessionStorage.getItem('wrenToken'); } catch (_) {}
    try { device = localStorage.getItem('wrenDevice') || ''; } catch (_) {}
    if (!token) { p = Promise.resolve(apply(false)); return p; }
    var h = { Authorization: 'Bearer ' + token };
    if (device) h['X-Wren-Device'] = device;
    /* Raw fetch, not Wren.api: a 401 here must not log anybody out. */
    p = fetch('/api/features/public', { headers: h, credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (f) { return apply(!!(f && f.fledge_enabled === true)); })
      .catch(function () { return apply(false); });
    return p;
  }

  window.WrenFledge = { enabled: function () { return on; }, ready: ready };
  ready();
})();
