/* wren-inbox-prevention.js — b235 (2026-08-26)
 *
 * One card in the Cockpit: "How to stop this happening", ranked by hours saved.
 *
 * ── THE TWO RULES, INHERITED FROM b232's LIGHTS ─────────────────────────────
 *
 *  1. FAILURE RENDERS NOTHING. Not an error, not a spinner, not an empty state.
 *     The card simply does not appear. That makes the file safe on any portal
 *     where /api/inbox-intel is not mounted, and it means a broken card never
 *     becomes the most alarming thing on the page.
 *
 *  2. EVERY LINE CITES A NUMBER. The endpoint only ever returns recommendations
 *     that a computed figure triggered, so there is no code path here that can
 *     render generic advice — if `figure` is missing the row is dropped.
 *     Which is the point: Toby has read enough productivity advice.
 *
 * The prevention endpoint runs a model call for its narrative, so this is fired
 * lazily and nothing waits on it.
 *
 * Usage:  WrenInboxPrevention.mount(element)
 */
(function () {
  'use strict';

  var ENDPOINT = '/api/inbox-intel/prevention';
  var CSS_ID = 'wren-inbox-prevention-css';

  var CSS = [
    '.wip-card{border:1px solid var(--c-border);border-radius:12px;background:var(--c-card);',
    '  padding:14px 16px;margin-bottom:12px}',
    '.wip-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px}',
    '.wip-title{font-size:1rem;font-weight:700;margin:0;color:var(--c-text)}',
    '.wip-sub{font-size:.76rem;color:var(--c-muted)}',
    '.wip-spacer{flex:1}',
    '.wip-saved{font-size:.76rem;color:var(--c-green);font-weight:700;font-variant-numeric:tabular-nums}',
    '.wip-narr{font-size:.83rem;line-height:1.5;color:var(--c-text);margin:8px 0 10px;',
    '  padding-left:10px;border-left:2px solid var(--c-blue)}',
    '.wip-list{list-style:none;margin:0;padding:0}',
    '.wip-item{padding:9px 0;border-top:1px solid var(--c-border)}',
    '.wip-item:first-child{border-top:0}',
    '.wip-it-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}',
    '.wip-it-title{font-weight:600;font-size:.86rem;color:var(--c-text)}',
    '.wip-badge{font-size:.7rem;color:var(--c-muted);border:1px solid var(--c-border);',
    '  border-radius:999px;padding:1px 7px;white-space:nowrap}',
    '.wip-fig{font-size:.79rem;color:var(--c-blue);margin-top:3px}',
    '.wip-why{font-size:.79rem;color:var(--c-muted);margin-top:2px;line-height:1.45}',
    '.wip-do{font-size:.79rem;color:var(--c-text);margin-top:3px;line-height:1.45}',
    '.wip-do b{color:var(--c-green);font-weight:700}',
    '.wip-money{color:var(--c-amber);font-weight:700}',
    '.wip-foot{margin-top:10px;font-size:.72rem;color:var(--c-muted)}',
  ].join('');

  function injectCSS() {
    if (document.getElementById(CSS_ID)) return;
    var st = document.createElement('style');
    st.id = CSS_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function token() {
    try { return sessionStorage.getItem('wrenToken') || ''; } catch (e) { return ''; }
  }

  function fetchReport() {
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

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function money(n) {
    return '£' + Number(n).toLocaleString('en-GB');
  }

  function render(host, rep) {
    // Rule 2 — a recommendation with no figure behind it is not rendered.
    var recs = (rep.recommendations || []).filter(function (r) { return r && r.figure; });
    if (!recs.length) return false;

    var card = el('div', 'wip-card');

    var head = el('div', 'wip-head');
    head.appendChild(el('h3', 'wip-title', 'How to stop this happening'));
    var basis = rep.based_on || {};
    head.appendChild(el('span', 'wip-sub',
      'from ' + (basis.gmail_threads_swept || 0).toLocaleString('en-GB') + ' email threads and '
      + (basis.conversations_examined || 0).toLocaleString('en-GB') + ' Wren conversations'));
    head.appendChild(el('span', 'wip-spacer'));
    if (rep.total_hours_saved_per_month) {
      head.appendChild(el('span', 'wip-saved', '~' + rep.total_hours_saved_per_month + ' hrs/month'));
    }
    card.appendChild(head);

    if (rep.narrative) card.appendChild(el('p', 'wip-narr', rep.narrative));

    var ul = el('ul', 'wip-list');
    recs.forEach(function (r) {
      var li = el('li', 'wip-item');

      var h = el('div', 'wip-it-head');
      h.appendChild(el('span', 'wip-it-title', r.title));
      if (r.effort) h.appendChild(el('span', 'wip-badge', r.effort));
      if (r.hours_saved_per_month) h.appendChild(el('span', 'wip-badge', r.hours_saved_per_month + ' hrs/mo'));
      li.appendChild(h);

      li.appendChild(el('div', 'wip-fig', r.figure));
      if (r.why) li.appendChild(el('div', 'wip-why', r.why));
      if (r.change) {
        var d = el('div', 'wip-do');
        d.appendChild(el('b', null, 'Do: '));
        d.appendChild(document.createTextNode(r.change));
        li.appendChild(d);
      }
      if (r.revenue_protected_annual_gbp) {
        var m = el('div', 'wip-do');
        var s = el('span', 'wip-money', money(r.revenue_protected_annual_gbp) + ' a year');
        m.appendChild(document.createTextNode('Protects roughly '));
        m.appendChild(s);
        li.appendChild(m);
      }
      ul.appendChild(li);
    });
    card.appendChild(ul);

    var foot = 'Analysed on the local model' + (rep.narrative_model ? ' (' + rep.narrative_model + ')' : '')
      + ' — nothing left the network.';
    card.appendChild(el('div', 'wip-foot', foot));

    host.innerHTML = '';
    host.appendChild(card);
    return true;
  }

  function mount(host) {
    if (!host) return;
    injectCSS();
    fetchReport().then(function (rep) {
      try { render(host, rep); } catch (e) { /* rule 1 */ }
    }).catch(function () { /* rule 1 — nothing renders */ });
  }

  window.WrenInboxPrevention = { mount: mount };
})();
