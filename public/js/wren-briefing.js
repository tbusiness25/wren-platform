/* wren-briefing.js — b503. ONE briefing page component for Roost, HR and EY.
 *   WrenBriefing.mount(el, { portal: 'roost' | 'hr' | 'ey' })
 * A readable briefing: counts, then collapsible sections, each item marked urgent / this period / for information (urgent ones say WHY), every item
 * linking to its screen, the archive of past briefings, a printable layout, "Send me this week's now", and (managers) a toggle per period.
 * Colours are tokens only. The HR portal gets a server-trimmed briefing (no child data); this file never has to decide that. */
(function () {
  'use strict';
  if (window.WrenBriefing) return;
  var CSS = [
    '.wb{max-width:900px;margin:0 auto;color:var(--c-text)}',
    '.wb *{box-sizing:border-box}',
    '.wb-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 14px}',
    '.wb-seg{display:inline-flex;border:1px solid var(--c-border-strong);border-radius:12px;overflow:hidden}',
    '.wb-seg button{background:transparent;border:0;color:var(--c-muted);padding:0 16px;min-height:44px;font:inherit;font-weight:700;cursor:pointer}',
    '.wb-seg button.on{background:var(--c-blue);color:var(--c-on-blue)}',
    '.wb-btn{border:1px solid var(--c-border-strong);background:var(--c-surface-2);color:var(--c-text);border-radius:12px;min-height:44px;padding:0 16px;font:inherit;font-weight:700;cursor:pointer}',
    '.wb-btn.pri{background:var(--c-orange);border-color:var(--c-orange);color:var(--c-on-orange)}',
    '.wb-chips{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:0 0 16px}',
    '.wb-chip{background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;padding:12px;text-align:center}',
    '.wb-chip b{display:block;font-size:26px;line-height:1}',
    '.wb-chip span{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--c-muted)}',
    '.wb-chip.urgent{border-color:var(--c-danger);background:var(--c-danger-soft)}.wb-chip.urgent b{color:var(--c-danger)}',
    '.wb-chip.period b{color:var(--c-blue)}',
    '.wb-sec{background:var(--c-surface);border:1px solid var(--c-border);border-radius:14px;margin:0 0 10px}',
    '.wb-sec>summary{cursor:pointer;list-style:none;padding:12px 14px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}',
    '.wb-sec>summary::-webkit-details-marker{display:none}',
    '.wb-sec>summary b{font-size:15px}.wb-sec>summary span{color:var(--c-muted);font-size:13px}',
    '.wb-body{padding:0 14px 12px}',
    '.wb-grp{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--c-muted);margin:10px 0 4px}',
    '.wb-item{padding:8px 0;border-top:1px solid var(--c-border);font-size:14px;line-height:1.45}',
    '.wb-item:first-of-type{border-top:0}',
    '.wb-item.urgent{border-left:4px solid var(--c-danger);padding-left:10px}',
    '.wb-item.period{border-left:4px solid var(--c-blue);padding-left:10px}',
    '.wb-why{display:block;font-size:12px;color:var(--c-danger);margin-top:2px}',
    '.wb-item a{color:var(--c-blue)}',
    '.wb-arch{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 0}',
    '.wb-arch button{background:var(--c-surface-2);border:1px solid var(--c-border);color:var(--c-text);border-radius:10px;min-height:40px;padding:0 12px;font:inherit;font-size:13px;cursor:pointer}',
    '.wb-arch button.on{border-color:var(--c-blue);color:var(--c-blue);font-weight:700}',
    '.wb-h{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--c-muted);margin:22px 0 8px}',
    '.wb-empty{background:var(--c-surface);border:1px solid var(--c-border);border-radius:14px;padding:22px;text-align:center;color:var(--c-muted)}',
    '.wb-set label{display:flex;gap:8px;align-items:center;min-height:44px;font-size:14px}',
    '.wb-print-title{display:none}',
    '@media print{body *{visibility:hidden}.wb,.wb *{visibility:visible}.wb{position:absolute;left:0;top:0;width:100%;color:var(--c-text)}.wb-bar,.wb-arch,.wb-set,.wb-h,.wb-nopr{display:none!important}.wb-print-title{display:block;font-size:20px;font-weight:800;margin-bottom:8px}.wb-sec{break-inside:avoid}}'
  ].join('\n');
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function api(u, o) { return window.Wren.api(u, o || {}); }
  function role() { try { var u = window.Wren.getUser && window.Wren.getUser(); if (u && u.role) return u.role; } catch (e) { /* fall */ } try { return JSON.parse(atob(window.Wren.getToken().split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role || ''; } catch (e) { return ''; } }
  // key -> URL, per portal. A key with no URL on a portal is shown as plain text (HR has no child screens; EY has only some).
  var LINKS = {
    roost: { tasks: '/staff-tasks.html', missing_details: '/missing-details.html', staff: '/admin/staff', supervisions: '/admin/staff', absence: '/admin/staff', finance: '/admin/finance', funding: '/admin/finance', payroll: '/admin/payroll', children: '/admin/children', attendance: '/admin/children', observations: '/admin/children', incidents: '/admin/safeguarding', events: '/admin/cockpit', planning: '/admin/planning', environment: '/admin/planning', compliance: '/admin/operations', fire: '/admin/operations', policies: '/admin/staff' },
    hr: { tasks: '/my-tasks.html', staff: '/staff.html', supervisions: '/supervisions.html', absence: '/absence-mgmt.html', policies: '/policies-admin.html' },
    ey: { tasks: '/ey/my-tasks', planning: '/ey/planning', supervisions: '/ey/supervisions', observations: '/ey/obs-tracker' }
  };
  function mount(el, opts) {
    opts = opts || {};
    var portal = opts.portal || 'roost', links = LINKS[portal] || {};
    if (!document.getElementById('wb-css')) { var s = document.createElement('style'); s.id = 'wb-css'; s.textContent = CSS; document.head.appendChild(s); }
    var state = { period: 'week', list: [], current: null, settings: null };
    var isMgr = ['manager', 'admin', 'headteacher'].indexOf(role()) >= 0;

    function itemHtml(i) {
      var cls = i.urgency === 'urgent' ? 'urgent' : (i.urgency === 'this_period' ? 'period' : '');
      var u = i.link && links[i.link];
      return '<div class="wb-item ' + cls + '">' + esc(i.text) + (u ? ' <a href="' + esc(u) + '">Open &rarr;</a>' : '') + (i.reason ? '<span class="wb-why">Why it is urgent: ' + esc(i.reason) + '</span>' : '') + '</div>';
    }
    function secHtml(sec) {
      var g = { urgent: [], this_period: [], info: [] };
      sec.items.forEach(function (i) { (g[i.urgency] || g.info).push(i); });
      var openIt = g.urgent.length ? ' open' : '';
      return '<details class="wb-sec"' + openIt + ' data-sec="' + esc(sec.key) + '"><summary><b>' + esc(sec.title) + '</b><span>' + esc(sec.headline) + '</span></summary><div class="wb-body">'
        + (g.urgent.length ? '<div class="wb-grp">Urgent</div>' + g.urgent.map(itemHtml).join('') : '')
        + (g.this_period.length ? '<div class="wb-grp">Not so urgent, this period</div>' + g.this_period.map(itemHtml).join('') : '')
        + (g.info.length ? '<div class="wb-grp">For information</div>' + g.info.map(itemHtml).join('') : '')
        + (!sec.items.length ? '<div class="wb-item">Nothing to flag.</div>' : '') + '</div></details>';
    }
    function draw() {
      var b = state.current && state.current.briefing, h = '';
      h += '<div class="wb-bar wb-nopr"><div class="wb-seg" role="group" aria-label="Period">'
        + ['week', 'month', 'term'].map(function (p) { return '<button data-p="' + p + '" class="' + (state.period === p ? 'on' : '') + '">' + { week: 'Weekly', month: 'Monthly', term: 'Termly' }[p] + '</button>'; }).join('') + '</div>'
        + '<button class="wb-btn pri" data-a="send">Send me this ' + { week: "week's", month: "month's", term: "term's" }[state.period] + ' now</button>'
        + '<button class="wb-btn" data-a="refresh">Refresh</button><button class="wb-btn" data-a="print">Print</button></div>';
      if (!b) {
        h += '<div class="wb-empty">No ' + state.period + 'ly briefing yet. Press <b>Refresh</b> to build one now.</div>';
      } else {
        h += '<div class="wb-print-title">' + esc(b.title) + '</div>';
        h += '<div class="wb-chips"><div class="wb-chip urgent"><b>' + b.counts.urgent + '</b><span>Urgent</span></div><div class="wb-chip period"><b>' + b.counts.this_period + '</b><span>Not so urgent</span></div><div class="wb-chip"><b>' + b.counts.info + '</b><span>For information</span></div></div>';
        h += '<div class="wb-nopr" style="font-size:13px;color:var(--c-muted);margin:-6px 0 12px">' + esc(b.title) + (b.hr_version ? ' · staff items only' : '') + ' · covers ' + esc(b.window.lastFrom) + ' to ' + esc(b.window.thisTo) + '</div>';
        // urgent first, then the rest in order
        var secs = b.sections.slice().sort(function (a, c) { var ua = a.items.some(function (i) { return i.urgency === 'urgent'; }) ? 0 : 1, uc = c.items.some(function (i) { return i.urgency === 'urgent'; }) ? 0 : 1; return ua - uc; });
        h += secs.map(secHtml).join('');
      }
      h += '<div class="wb-h wb-nopr">Past briefings</div><div class="wb-arch wb-nopr">' + (state.list.length ? state.list.map(function (r) {
        return '<button data-id="' + r.id + '" class="' + (state.current && state.current.id === r.id ? 'on' : '') + '">' + esc(r.as_of) + '</button>'; }).join('') : '<span style="color:var(--c-muted);font-size:13px">None yet.</span>') + '</div>';
      if (isMgr && state.settings) {
        h += '<div class="wb-h wb-nopr">Settings</div><div class="wb-set wb-nopr">' + ['week', 'month', 'term'].map(function (p) {
          return '<label><input type="checkbox" data-set="' + p + '"' + (state.settings[p] ? ' checked' : '') + '> Send the ' + { week: 'weekly (every Monday 07:00)', month: 'monthly (first Monday)', term: 'termly (first Monday of each funding term, and a mid-term check)' }[p] + ' briefing automatically</label>'; }).join('')
          + '<div style="font-size:12px;color:var(--c-muted)">Off until you switch it on. The notification says only how many items there are; the briefing itself is read in Wren and is never emailed.</div></div>';
      }
      el.innerHTML = '<div class="wb">' + h + '</div>';
    }
    function loadList() { return api('/api/briefings?period=' + state.period).then(function (d) { state.list = d.briefings || []; }).catch(function () { state.list = []; }); }
    function loadOne(id) { return api('/api/briefings/' + id).then(function (d) { state.current = d; }); }
    function loadLatest() {
      return loadList().then(function () { if (state.list.length) return loadOne(state.list[0].id); state.current = null; }).then(draw).catch(function (e) {
        el.innerHTML = '<div class="wb"><div class="wb-empty">' + esc((e && (e.error || e.message)) || 'Could not load briefings.') + '</div></div>'; });
    }
    function generate() {
      return api('/api/briefings/generate', { method: 'POST', body: { period: state.period } }).then(function (d) { return loadList().then(function () { return loadOne(d.id); }); }).then(draw)
        .catch(function (e) { window.Wren.toast((e && (e.error || e.message)) || 'Could not build that.', 'error'); });
    }
    el.addEventListener('click', function (ev) {
      var t = ev.target.closest('[data-p],[data-a],[data-id]'); if (!t) return;
      if (t.dataset.p) { state.period = t.dataset.p; return loadLatest(); }
      if (t.dataset.id) { return loadOne(Number(t.dataset.id)).then(draw); }
      if (t.dataset.a === 'refresh') return generate();
      if (t.dataset.a === 'print') { el.querySelectorAll('details').forEach(function (d) { d.open = true; }); return window.print(); }
      if (t.dataset.a === 'send') return api('/api/briefings/send-now', { method: 'POST', body: { period: state.period } }).then(function () { window.Wren.toast('Sent. Look at your notifications.', 'success'); return loadList().then(draw); }).catch(function (e) { window.Wren.toast((e && (e.error || e.message)) || 'Could not send that.', 'error'); });
    });
    el.addEventListener('change', function (ev) {
      var c = ev.target.closest('[data-set]'); if (!c) return;
      var body = {}; body[c.dataset.set] = c.checked;
      api('/api/briefings/settings', { method: 'PATCH', body: body }).then(function (d) { state.settings = d; window.Wren.toast('Saved', 'success'); }).catch(function () { c.checked = !c.checked; });
    });
    var q = new URLSearchParams(location.search), want = q.get('id');
    var settingsP = isMgr ? api('/api/briefings/settings').then(function (d) { state.settings = d; }).catch(function () {}) : Promise.resolve();
    settingsP.then(function () {
      if (want && /^\d+$/.test(want)) { return loadOne(Number(want)).then(function () { state.period = state.current.briefing.period; return loadList(); }).then(draw).catch(loadLatest); }
      return loadLatest();
    });
  }
  window.WrenBriefing = { mount: mount };
}());
