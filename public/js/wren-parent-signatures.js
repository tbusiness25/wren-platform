/* wren-parent-signatures.js — b343 (2026-09-21)
 * "Signed by the parent, in the app" on the staff side. Where a form used to show an empty line (or nothing) for the parent's
 * signature, Roost and the EY app now show who signed, and when — or that the form is still waiting for them.
 *
 *   WrenParentSig.load(childId)                       → Promise<map>   one call per child page; never rejects
 *   WrenParentSig.badge(map, kind, table, id)         → HTML string ('' when the form is not one a parent is asked to sign)
 *   WrenParentSig.reportKey(report_type)              → { kind, table } for a row of the `reports` table, or null
 *
 * `kind` is medicine | accident | summative_report | two_year_check; `table` is the staff-side table the form lives in.
 * The endpoint (GET /api/parent-forms/child/:id) returns WHO and WHEN only — never what the parent was shown. A signature is
 * append-only, so this is a read-only view; nothing here can change one.
 *
 * Colours are the shared tokens (--c-*), so it follows Roost's and the EY app's themes. No emoji.
 */
(function () {
  'use strict';
  if (window.WrenParentSig) return;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function when(iso) {
    try { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' }); } catch (e) { return ''; }
  }
  function css() {
    if (document.querySelector('style[data-wps]')) return;
    var s = document.createElement('style'); s.setAttribute('data-wps', '1');
    s.textContent =
      '.wps{display:inline-flex;align-items:center;gap:5px;font-size:.72rem;font-weight:700;line-height:1.3;margin-top:4px;padding:2px 8px;border-radius:999px;border:1px solid currentColor}' +
      '.wps svg{width:12px;height:12px;flex:0 0 auto}' +
      '.wps-ok{color:var(--c-green)}.wps-wait{color:var(--c-amber)}.wps-old{color:var(--c-muted)}';
    (document.head || document.documentElement).appendChild(s);
  }
  var TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  var CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';

  function api(url) {
    if (window.Wren && typeof Wren.api === 'function') return Wren.api(url);
    var h = {};
    try {
      var tok = sessionStorage.getItem('wrenToken'); if (tok) h.Authorization = 'Bearer ' + tok;
      var dev = localStorage.getItem('wrenDevice'); if (dev) h['X-Wren-Device'] = dev;
    } catch (e) {}
    return fetch(url, { headers: h, credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  window.WrenParentSig = {
    load: function (childId) {
      css();
      return api('/api/parent-forms/child/' + encodeURIComponent(childId)).then(function (d) { return (d && d.items) || {}; }).catch(function () { return {}; });
    },
    reportKey: function (type) {
      if (type === 'two_year_check') return { kind: 'two_year_check', table: 'reports' };
      if (type === 'termly_update') return { kind: 'summative_report', table: 'reports' };
      return null;
    },
    badge: function (map, kind, table, id) {
      var o = map && map[kind + '|' + table + '|' + id];
      if (!o) return '';
      if (o.signed) {
        var stale = o.waiting ? ' — the form has changed since; waiting for a new signature' : '';
        return '<div><span class="wps ' + (o.waiting ? 'wps-old' : 'wps-ok') + '" title="Signed in the parents app">' + TICK +
          'Signed by ' + esc(o.signed.by) + ' · ' + esc(when(o.signed.at)) + esc(stale) + '</span></div>';
      }
      if (o.waiting) return '<div><span class="wps wps-wait" title="Waiting for the parent to sign in the app">' + CLOCK + 'Waiting for parent to sign' + (o.since ? ' since ' + esc(when(o.since)) : '') + '</span></div>';
      return '';
    }
  };
})();
