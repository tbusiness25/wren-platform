/* wren-missed.js — b364 (2026-09-29)
 *
 * "What have I missed" — one card on the Cockpit.
 *
 * Toby, 2026-09-24: "When I log on it should have a 'what have I missed' since
 * last time I logged on."
 *
 * ── THE TWO RULES, INHERITED FROM b232's LIGHTS AND b235's CARD ──────────────
 *
 *  1. FAILURE RENDERS NOTHING. Not an error, not a spinner, not an empty state.
 *     The card simply does not appear. So this file is safe on a portal where
 *     /api/inbox-hermes is not mounted, on a schema without the b364 migration,
 *     and — most often — for a manager who is not on the email-reading list and
 *     gets a clean 403. A broken card must never be the loudest thing on the
 *     page Toby opens first.
 *
 *  2. IT IS A WINDOW, NOT A FEED. The server keeps the clock (per person, in
 *     inbox_last_seen) so this is right on a new phone and right after a week
 *     off. Nothing here reads or writes a date in the browser.
 *
 * ── WHY "MARK AS READ" IS A BUTTON AND NOT AUTOMATIC ────────────────────────
 * The window runs from the PREVIOUS stamp, so loading the Cockpit twice in a
 * minute shows the same thing twice rather than blanking the second time. The
 * stamp only moves when the person says they have read it. An ADHD-support
 * surface that empties itself because you glanced at it is the thing this build
 * is supposed to prevent.
 *
 * Usage:  WrenMissed.mount(element)
 */
(function () {
  'use strict';

  var ENDPOINT = '/api/inbox-hermes/missed';
  var SEEN = '/api/inbox-hermes/seen';
  var CSS_ID = 'wren-missed-css';

  var CSS = [
    '.wm-card{border:1px solid var(--c-border);border-radius:12px;background:var(--c-surface,var(--c-card));',
    '  padding:14px 16px;margin-bottom:12px}',
    '.wm-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:4px}',
    '.wm-title{font-size:1rem;font-weight:700;margin:0;color:var(--c-text)}',
    '.wm-sub{font-size:.74rem;color:var(--c-muted)}',
    '.wm-spacer{flex:1}',
    '.wm-chips{display:flex;gap:6px;flex-wrap:wrap;margin:9px 0 4px}',
    '.wm-chip{display:inline-flex;align-items:center;gap:5px;font-size:.76rem;',
    '  border:1px solid var(--c-border);border-radius:999px;padding:3px 10px;color:var(--c-text);',
    '  background:var(--c-bg);text-decoration:none;min-height:26px}',
    '.wm-chip:hover{border-color:var(--c-blue)}',
    '.wm-chip b{font-variant-numeric:tabular-nums}',
    '.wm-chip.urgent{border-color:var(--c-amber);color:var(--c-amber)}',
    '.wm-group{margin-top:10px;border-top:1px solid var(--c-border);padding-top:9px}',
    '.wm-group:first-of-type{border-top:0}',
    '.wm-gtitle{font-size:.76rem;font-weight:700;color:var(--c-muted);',
    '  text-transform:uppercase;letter-spacing:.04em;margin:0 0 6px}',
    '.wm-row{display:flex;gap:9px;align-items:flex-start;padding:5px 0;text-decoration:none;color:inherit}',
    '.wm-row:hover .wm-rt{color:var(--c-blue)}',
    '.wm-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:var(--c-border);margin-top:6px}',
    '.wm-dot.needs{background:var(--c-amber)}',
    '.wm-rb{flex:1;min-width:0}',
    // block, not inline: these are spans (a <span> inside an <a> is the only
    // legal nesting here), so without this the title, the gist and the meta all
    // run into one another — "…fire doorby Staff · due 2026-09-30".
    '.wm-rt{display:block;font-size:.84rem;color:var(--c-text);line-height:1.4}',
    '.wm-rg{font-size:.76rem;color:var(--c-muted);line-height:1.45;margin-top:1px;',
    '  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
    '.wm-rm{display:block;font-size:.7rem;color:var(--c-muted);margin-top:2px}',
    '.wm-foot{display:flex;gap:8px;align-items:center;flex-wrap:wrap;',
    '  margin-top:11px;padding-top:9px;border-top:1px solid var(--c-border)}',
    '.wm-note{font-size:.72rem;color:var(--c-muted);flex:1}',
    '.wm-quiet{font-size:.84rem;color:var(--c-muted);line-height:1.5;margin:6px 0 0}',
    '.wm-btn{font:inherit;font-size:.78rem;min-height:32px;padding:5px 12px;border-radius:8px;',
    '  border:1px solid var(--c-border);background:var(--c-bg);color:var(--c-text);cursor:pointer}',
    '.wm-btn:hover{border-color:var(--c-blue);color:var(--c-blue)}',
    '.wm-more{font-size:.76rem;color:var(--c-blue);text-decoration:none}',
    '.wm-exp{cursor:pointer}.wm-exp:hover .wm-rt{color:var(--c-blue)}.wm-exp:focus-visible{outline:2px solid var(--c-blue);outline-offset:2px;border-radius:6px}',
    '.wm-caret{font-size:.7rem;color:var(--c-muted)}',
    '.wm-desc{display:block;margin-top:6px;font-size:.8rem;line-height:1.5;color:var(--c-text);white-space:pre-wrap;',
    '  background:var(--c-bg);border:1px solid var(--c-border);border-radius:8px;padding:8px 10px}',
    '.wm-desc[hidden]{display:none}',
  ].join('');

  function injectCSS() {
    if (document.getElementById(CSS_ID)) return;
    var st = document.createElement('style');
    st.id = CSS_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function token() {
    try { return sessionStorage.getItem('wrenToken') || ''; } catch (e) { return ''; }
  }

  function call(url, method) {
    var t = token();
    if (!t) return Promise.reject(new Error('no token'));
    return fetch(url, {
      method: method || 'GET',
      headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /* "since 2 days ago" reads better than a timestamp for a window. */
  function ago(iso) {
    var t = Date.parse(iso);
    if (!t) return '';
    var mins = Math.round((Date.now() - t) / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return mins + ' minutes ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + ' hour' + (hrs === 1 ? '' : 's') + ' ago';
    var days = Math.round(hrs / 24);
    return days + ' day' + (days === 1 ? '' : 's') + ' ago';
  }

  function sectionLabel(key) {
    return ({
      parents: 'Parents', ealing: 'Ealing', finance: 'Finance',
      admissions: 'Prospective families', apprenticeships: 'Apprenticeships',
      suppliers: 'Suppliers', staff: 'Staff', other: 'Other',
    })[key] || key;
  }

  function emailRows(items) {
    return items.slice(0, 8).map(function (e) {
      return '<a class="wm-row" href="/hermes-inbox.html?email=' + encodeURIComponent(e.id) + '">'
        + '<span class="wm-dot' + (e.action_state === 'needs_reply' ? ' needs' : '') + '"></span>'
        + '<span class="wm-rb">'
        + '<span class="wm-rt">' + esc(e.from_name || e.from_email || 'Unknown sender')
        + ' — ' + esc(e.subject || '(no subject)') + '</span>'
        + (e.gist ? '<span class="wm-rg">' + esc(e.gist) + '</span>' : '')
        + '<span class="wm-rm">' + esc(sectionLabel(e.section || 'other'))
        + (e.section_source === 'model' ? ' · Wren’s guess' : '')
        + (e.has_draft ? ' · draft ready' : '')
        + ' · ' + esc(ago(e.received_at)) + '</span>'
        + '</span></a>';
    }).join('');
  }

  function render(slot, d) {
    injectCSS();
    var parts = [];
    var total = (d.emails && d.emails.total) || 0;

    parts.push('<div class="wm-head">'
      + '<h3 class="wm-title">👁️ What have I missed</h3>'
      + '<span class="wm-sub">since ' + esc(d.first_ever ? 'we started keeping track' : ago(d.since)) + '</span>'
      + '<span class="wm-spacer"></span>'
      + '<a class="wm-more" href="/hermes-inbox.html">Open the inbox →</a>'
      + '</div>');

    if (d.nothing_missed) {
      parts.push('<p class="wm-quiet">Nothing new since you last looked. No email, no tasks finished, '
        + 'no invoices paid, nothing flagged.</p>');
    } else {
      if (total) {
        parts.push('<div class="wm-chips">' + (d.emails.by_section || []).map(function (s) {
          return '<a class="wm-chip' + (s.needs_reply ? ' urgent' : '') + '" '
            + 'href="/hermes-inbox.html?section=' + encodeURIComponent(s.section) + '">'
            + esc(sectionLabel(s.section)) + ' <b>' + s.n + '</b>'
            + (s.needs_reply ? ' <span>· ' + s.needs_reply + ' need a reply</span>' : '')
            + '</a>';
        }).join('') + '</div>');
        parts.push('<div class="wm-group"><p class="wm-gtitle">' + total + ' new email'
          + (total === 1 ? '' : 's') + '</p>' + emailRows(d.emails.items || []) + '</div>');
      }

      var tc = (d.tasks && d.tasks.created) || [];
      var td = (d.tasks && d.tasks.completed) || [];
      if (tc.length || td.length) {
        parts.push('<div class="wm-group"><p class="wm-gtitle">Tasks</p>'
          + tc.slice(0, 5).map(function (t) {
              // 2026-10-15 (Toby: "I can't click on the task to expand it"): a task with details opens in place.
              var hasDesc = t.description && String(t.description).trim();
              return '<div class="wm-row' + (hasDesc ? ' wm-exp' : '') + '"' + (hasDesc ? ' role="button" tabindex="0" aria-expanded="false"' : '') + '>'
                + '<span class="wm-dot"></span><span class="wm-rb">'
                + '<span class="wm-rt">Created: ' + esc(t.title) + (hasDesc ? ' <span class="wm-caret">▸</span>' : '') + '</span>'
                + '<span class="wm-rm">' + (t.created_by_name ? 'by ' + esc(t.created_by_name) + ' · ' : '')
                + (t.due_date ? 'due ' + esc(String(t.due_date).slice(0, 10)) : 'no deadline') + '</span>'
                + (hasDesc ? '<span class="wm-desc" hidden>' + esc(t.description) + '</span>' : '')
                + '</span></div>';
            }).join('')
          + td.slice(0, 5).map(function (t) {
              return '<div class="wm-row"><span class="wm-dot"></span><span class="wm-rb">'
                + '<span class="wm-rt">Finished: ' + esc(t.title) + '</span>'
                + '<span class="wm-rm">' + (t.owner_name ? esc(t.owner_name) + ' · ' : '')
                + esc(ago(t.completed_at)) + '</span></span></div>';
            }).join('')
          + '</div>');
      }

      var paid = d.invoices_paid || [];
      if (paid.length) {
        var sum = paid.reduce(function (s, i) {
          return s + (parseFloat(String(i.amount || '0').replace(/[^0-9.]/g, '')) || 0);
        }, 0);
        parts.push('<div class="wm-group"><p class="wm-gtitle">' + paid.length + ' invoice'
          + (paid.length === 1 ? '' : 's') + ' paid · £' + sum.toFixed(2) + '</p>'
          + paid.slice(0, 5).map(function (i) {
              return '<div class="wm-row"><span class="wm-dot"></span><span class="wm-rb">'
                + '<span class="wm-rt">' + esc(i.number) + ' — ' + esc(i.amount || '') + '</span>'
                + '<span class="wm-rm">' + esc(i.period || '') + ' · paid '
                + esc(String(i.paid_on).slice(0, 10)) + '</span></span></div>';
            }).join('') + '</div>');
      }

      var sig = d.signals || [];
      if (sig.length) {
        parts.push('<div class="wm-group"><p class="wm-gtitle">' + sig.length + ' signal'
          + (sig.length === 1 ? '' : 's') + ' raised</p>'
          + sig.slice(0, 5).map(function (s) {
              return '<div class="wm-row"><span class="wm-dot' + (s.cleared_at ? '' : ' needs') + '"></span>'
                + '<span class="wm-rb"><span class="wm-rt">' + esc(s.said || s.signal_key) + '</span>'
                + '<span class="wm-rm">' + esc(ago(s.fired_at))
                + (s.cleared_at ? ' · since cleared' : '') + '</span></span></div>';
            }).join('') + '</div>');
      }
    }

    parts.push('<div class="wm-foot">'
      + '<span class="wm-note">' + (d.clamped_to_days
          ? 'Only the last ' + d.clamped_to_days + ' days are shown.'
          : 'The clock is kept per person on the server, so this is right on any device.')
      + '</span>'
      + '<button type="button" class="wm-btn" data-wm-seen>Mark as read</button>'
      + '</div>');

    slot.innerHTML = '<div class="wm-card">' + parts.join('') + '</div>';

    var btn = slot.querySelector('[data-wm-seen]');
    if (btn) btn.addEventListener('click', function () {
      btn.disabled = true;
      btn.textContent = 'Marking…';
      call(SEEN, 'POST').then(function () {
        // Reloading straight away would show the same window again (the server
        // keeps the previous stamp on purpose), so say what happened instead.
        slot.innerHTML = '<div class="wm-card"><div class="wm-head">'
          + '<h3 class="wm-title">👁️ What have I missed</h3>'
          + '<span class="wm-spacer"></span>'
          + '<a class="wm-more" href="/hermes-inbox.html">Open the inbox →</a></div>'
          + '<p class="wm-quiet">Marked as read. The next time you open the Cockpit this shows '
          + 'everything since now.</p></div>';
      }).catch(function () {
        btn.disabled = false;
        btn.textContent = 'Mark as read';
      });
    });
  }

  // 2026-10-15: expand a created task's details in place (click or Enter/Space).
  function wireExpand(slot) {
    if (slot.__wmExp) return; slot.__wmExp = true;
    function toggle(row) {
      var d = row.querySelector('.wm-desc'); if (!d) return;
      var open = d.hidden; d.hidden = !open;
      row.setAttribute('aria-expanded', String(open));
      var c = row.querySelector('.wm-caret'); if (c) c.textContent = open ? '▾' : '▸';
    }
    slot.addEventListener('click', function (e) { var r = e.target.closest('.wm-exp'); if (r && slot.contains(r)) toggle(r); });
    slot.addEventListener('keydown', function (e) { if (e.key !== 'Enter' && e.key !== ' ') return; var r = e.target.closest('.wm-exp'); if (r) { e.preventDefault(); toggle(r); } });
  }

  function mount(slot) {
    if (!slot) return;
    call(ENDPOINT).then(function (d) {
      if (!d || !d.emails) return;                 // not the b364 shape: render nothing
      render(slot, d);
      wireExpand(slot);
    }).catch(function () { /* silent by design — rule 1 */ });
  }

  window.WrenMissed = { mount: mount };
})();
