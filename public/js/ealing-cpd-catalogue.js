/* ═══════════════════════════════════════════════════════════════════════════
 * b322 — the staff-facing Ealing CPD catalogue.  2026-09-11.
 *
 * ONE module, TWO host pages: Nest (/ey/cpd-catalogue) and Seed
 * (/cpd-catalogue.html). The content, the wording and the rules live here so
 * the two portals cannot drift — the same precedent as how-wren-works.js (b113).
 *
 * ── LOAD ORDER MATTERS ──────────────────────────────────────────────────────
 * Both host pages list this script BEFORE wren-app-shell.js. Deferred scripts
 * run in document order, and the shell dispatches `wren:ready` SYNCHRONOUSLY at
 * the end of buildShell() — so a module listed after the shell has not executed
 * when the event fires, and its listener is never registered. Listed first, it
 * registers, then the shell fires. Do not reorder the tags.
 *
 * ── THE WORDING IS THE FEATURE ──────────────────────────────────────────────
 * Wren cannot book a place on ealingcpd.org.uk. Every string a staff member
 * reads here says what is actually true at that moment: "asked", "approved —
 * your manager is booking it", "booked". Nothing on this page ever tells
 * somebody they have a place until a manager has said they booked one.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var MOUNT_ID = 'ealing-cpd-root';

  var CSS = [
    '#' + MOUNT_ID + '{padding:6px 12px env(safe-area-inset-bottom,24px);max-width:760px;margin:0 auto}',
    '.ecc-intro{font-size:.83rem;color:var(--c-muted);line-height:1.6;padding:4px 2px 12px}',
    '.ecc-intro b{color:var(--c-text)}',
    '.ecc-tabs{display:flex;gap:6px;margin-bottom:12px}',
    '.ecc-tab{flex:1;background:var(--c-surface);border:1px solid var(--c-border);color:var(--c-muted);',
    '  border-radius:10px;padding:9px 8px;font-size:.82rem;font-weight:700;cursor:pointer}',
    '.ecc-tab.on{background:var(--c-blue);border-color:var(--c-blue);color:var(--c-surface)}',
    '.ecc-filters{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}',
    '.ecc-filters input,.ecc-filters select{flex:1 1 140px;background:var(--c-surface);',
    '  border:1px solid var(--c-border);color:var(--c-text);border-radius:10px;padding:9px 11px;font-size:.85rem}',
    '.ecc-card{background:var(--c-surface);border:1px solid var(--c-border);border-radius:14px;',
    '  padding:13px 15px;margin-bottom:11px}',
    '.ecc-title{font-weight:700;font-size:.97rem;color:var(--c-text);line-height:1.35}',
    '.ecc-meta{font-size:.79rem;color:var(--c-muted);margin-top:6px;line-height:1.6}',
    '.ecc-meta b{color:var(--c-text)}',
    '.ecc-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}',
    '.ecc-chip{font-size:.68rem;font-weight:700;border-radius:999px;padding:3px 9px;',
    '  border:1px solid currentColor;white-space:nowrap}',
    '.c-ok{color:var(--c-green,var(--c-blue))}.c-warn{color:var(--c-amber)}',
    '.c-info{color:var(--c-blue)}.c-mute{color:var(--c-muted)}',
    '.ecc-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}',
    '.ecc-btn{border:1px solid var(--c-border);background:var(--c-surface);color:var(--c-text);',
    '  border-radius:10px;padding:10px 15px;font-size:.85rem;font-weight:700;cursor:pointer;',
    '  text-decoration:none;display:inline-block;min-height:42px;line-height:22px}',
    '.ecc-btn.primary{background:var(--c-blue);border-color:var(--c-blue);color:var(--c-surface)}',
    '.ecc-btn:disabled{opacity:.55;cursor:not-allowed}',
    '.ecc-empty{background:var(--c-surface);border:1px dashed var(--c-border);border-radius:14px;',
    '  padding:26px 16px;text-align:center;color:var(--c-muted);font-size:.85rem;line-height:1.65}',
    '.ecc-empty b{color:var(--c-text)}',
    '.ecc-note{font-size:.76rem;color:var(--c-muted);margin-top:8px;line-height:1.55}',
    '.ecc-flag{color:var(--c-amber)}',
    '.ecc-status{border-left:3px solid var(--c-border);padding-left:10px;margin-top:10px;',
    '  font-size:.8rem;color:var(--c-muted);line-height:1.6}',
    '.ecc-status.ok{border-left-color:var(--c-green,var(--c-blue))}',
    '.ecc-status.info{border-left-color:var(--c-blue)}',
    '.ecc-status.warn{border-left-color:var(--c-amber)}',
    '.ecc-status.mute{border-left-color:var(--c-muted)}',
  ].join('\n');

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtDate(d) {
    if (!d) return 'date not stated';
    var p = String(d).slice(0, 10).split('-');
    return Number(p[2]) + ' ' + MONTHS[Number(p[1]) - 1] + ' ' + p[0];
  }
  function modeWord(m) {
    return m === 'online' ? 'Online' : m === 'in_person' ? 'In person'
         : m === 'hybrid' ? 'Online or in person' : 'Venue not stated';
  }
  /* Ealing's venue cell for an online course literally reads "Online, via MS
     Teams", so printing the mode word AND the venue gave "Online — Online, via
     MS Teams". When the venue already says it, the venue alone is better. */
  function placeWord(mode, venue) {
    var w = modeWord(mode);
    if (!venue) return w;
    return venue.toLowerCase().indexOf(w.toLowerCase()) >= 0 ? venue : w + ' — ' + venue;
  }
  // Wren.api rejects with the response BODY, so e.message is often undefined.
  function errText(e, fb) {
    if (e && e.error === 'capability_forbidden') return 'You do not have access to this.';
    return (e && (e.message || e.error)) || fb || 'Something went wrong.';
  }

  /* What a staff member is told, per status. Each line is true of the server
     state it describes — see the header note on why that matters here. */
  var MINE = {
    pending:   { cls: 'warn', word: 'You have asked to do this',
                 line: 'Your manager is checking whether cover works on that date.' },
    approved:  { cls: 'info', word: 'Approved',
                 line: 'Your manager is booking your place on Ealing CPD Online. You are not booked until they confirm it here.' },
    booked:    { cls: 'ok',   word: 'Booked',
                 line: 'Your place is booked. It is on the nursery calendar.' },
    attended:  { cls: 'ok',   word: 'Attended',
                 line: 'This is on your CPD record.' },
    declined:  { cls: 'mute', word: 'Not this time', line: '' },
    cancelled: { cls: 'mute', word: 'Cancelled', line: '' },
    withdrawn: { cls: 'mute', word: 'You withdrew this', line: '' },
  };

  var state = { tab: 'browse', courses: [], mine: [], today: null };

  function courseCard(c) {
    var dates = (c.sessions || []).map(function (s) { return fmtDate(s.date); }).join(', ')
             || fmtDate(c.first_date);
    var parts = Number(c.parts_total) > 1
      ? '<span class="ecc-chip c-warn">' + esc(c.parts_total) + ' sessions</span>' : '';
    var price = c.is_free === true
      ? '<span class="ecc-chip c-ok">Free</span>'
      : (c.price_text ? '<span class="ecc-chip c-mute">' + esc(c.price_text) + '</span>'
                      : '<span class="ecc-chip c-mute">Price not stated</span>');
    var st = c.my_request_status ? MINE[c.my_request_status] : null;

    var action;
    if (st && ['pending', 'approved', 'booked', 'attended'].indexOf(c.my_request_status) >= 0) {
      action = '<div class="ecc-status ' + st.cls + '"><b>' + esc(st.word) + '.</b> ' + esc(st.line) + '</div>'
        + (c.my_request_status === 'pending'
            ? '<div class="ecc-actions"><button class="ecc-btn" data-ecc="withdraw" data-req="'
              + esc(c.my_request_id) + '">Withdraw</button></div>' : '');
    } else {
      action = '<div class="ecc-actions">'
        + '<button class="ecc-btn primary" data-ecc="ask" data-id="' + esc(c.id) + '">Ask to do this</button>'
        + (c.booking_url ? '<a class="ecc-btn" href="' + esc(c.booking_url)
            + '" target="_blank" rel="noopener">What it covers ↗</a>' : '')
        + '</div>';
      if (st) {
        action = '<div class="ecc-status mute"><b>' + esc(st.word) + '.</b> '
          + esc(st.line || 'You can ask again if it runs another time.') + '</div>' + action;
      }
    }

    return '<div class="ecc-card">'
      + '<div class="ecc-title">' + esc(c.title) + '</div>'
      + '<div class="ecc-meta"><b>' + esc(dates) + '</b>'
      + (c.start_time ? ' · ' + esc(c.start_time) + (c.end_time ? '–' + esc(c.end_time) : '') : '')
      + '<br>' + esc(placeWord(c.delivery_mode, c.venue))
      + (c.course_code ? '<br>Course code ' + esc(c.course_code) : '')
      + '</div>'
      + '<div class="ecc-chips">' + price + parts
      + (Number(c.interest_count) > 0
          ? '<span class="ecc-chip c-info">' + esc(c.interest_count) + ' interested</span>' : '')
      + '</div>'
      + (c.booking_deadline
          ? '<div class="ecc-note">Ealing close bookings on <b>' + esc(fmtDate(c.booking_deadline)) + '</b></div>' : '')
      /* Ealing publish one date for a multi-part course. Say so rather than
         letting "30 Sep 2026" look like the whole commitment. */
      + (Number(c.parts_total) > 1 && (c.sessions || []).length < Number(c.parts_total)
          ? '<div class="ecc-note ecc-flag">Ealing run this over ' + esc(c.parts_total)
            + ' sessions but only gave ' + ((c.sessions || []).length || 1)
            + ' date in their email — check the rest before you commit.</div>' : '')
      + (c.price_note ? '<div class="ecc-note ecc-flag">' + esc(c.price_note) + '</div>' : '')
      + action
      + '</div>';
  }

  function mineCard(r) {
    var st = MINE[r.status] || { cls: 'mute', word: r.status, line: '' };
    var dates = r.first_date === r.last_date ? fmtDate(r.first_date)
              : fmtDate(r.first_date) + ' – ' + fmtDate(r.last_date);
    return '<div class="ecc-card">'
      + '<div class="ecc-title">' + esc(r.title) + '</div>'
      + '<div class="ecc-meta"><b>' + esc(dates) + '</b> · '
      + esc(placeWord(r.delivery_mode, r.venue)) + '</div>'
      + '<div class="ecc-status ' + st.cls + '"><b>' + esc(st.word) + '.</b> ' + esc(st.line) + '</div>'
      + (r.decision_reason
          ? '<div class="ecc-note">Your manager said: “' + esc(r.decision_reason) + '”</div>' : '')
      + (r.status === 'pending'
          ? '<div class="ecc-actions"><button class="ecc-btn" data-ecc="withdraw" data-req="'
            + esc(r.id) + '">Withdraw</button></div>' : '')
      + '</div>';
  }

  function render() {
    var body = document.getElementById('ecc-body');
    if (!body) return;
    if (state.tab === 'browse') {
      body.innerHTML = state.courses.length
        ? state.courses.map(courseCard).join('')
        : '<div class="ecc-empty"><b>No courses listed just now.</b><br>'
          + 'Wren fills this in from Ealing’s training emails as they arrive, and courses drop off '
          + 'once they have run.</div>';
    } else {
      body.innerHTML = state.mine.length
        ? state.mine.map(mineCard).join('')
        : '<div class="ecc-empty"><b>You haven’t asked about any courses yet.</b><br>'
          + 'Browse what Ealing are running and press “Ask to do this” on anything you fancy.</div>';
    }
  }

  function loadCourses() {
    var q = (document.getElementById('ecc-q') || {}).value || '';
    var mode = (document.getElementById('ecc-mode') || {}).value || '';
    var qs = [];
    if (q.trim()) qs.push('q=' + encodeURIComponent(q.trim()));
    if (mode) qs.push('mode=' + encodeURIComponent(mode));
    return Wren.api('/api/ealing-cpd/catalogue' + (qs.length ? '?' + qs.join('&') : ''))
      .then(function (d) { state.courses = d.courses || []; state.today = d.today; render(); })
      .catch(function (e) {
        var body = document.getElementById('ecc-body');
        if (body) body.innerHTML = '<div class="ecc-empty">' + esc(errText(e, 'Could not load the catalogue.')) + '</div>';
      });
  }

  function loadMine() {
    return Wren.api('/api/ealing-cpd/my-requests')
      .then(function (rows) { state.mine = rows || []; render(); })
      .catch(function () { state.mine = []; render(); });
  }

  function ask(courseId, btn) {
    btn.disabled = true;
    var note = window.prompt('Anything to say to your manager? (optional)') || null;
    Wren.api('/api/ealing-cpd/courses/' + courseId + '/request', { method: 'POST', body: { note: note } })
      .then(function () {
        // Reload rather than patch the card: the server decides the status word,
        // and this page must never display a state the server did not confirm.
        return Promise.all([loadCourses(), loadMine()]);
      })
      .catch(function (e) { window.alert(errText(e, 'Could not send that request.')); })
      .then(function () { btn.disabled = false; });
  }

  function withdraw(reqId) {
    if (!window.confirm('Withdraw this request?')) return;
    Wren.api('/api/ealing-cpd/requests/' + reqId + '/withdraw', { method: 'POST', body: {} })
      .then(function () { return Promise.all([loadCourses(), loadMine()]); })
      .catch(function (e) { window.alert(errText(e, 'Could not withdraw that.')); });
  }

  function mount() {
    var root = document.getElementById(MOUNT_ID);
    if (!root) return;

    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    root.innerHTML =
      '<div class="ecc-intro">Training Ealing Council are running for early-years settings, read straight '
      + 'from their emails. Press <b>Ask to do this</b> and your manager will check cover for that day and '
      + 'come back to you. <b>Most of it is free</b> to Ealing settings.</div>'
      + '<div class="ecc-tabs">'
      + '  <button class="ecc-tab on" data-ecc="tab" data-tab="browse">What’s on</button>'
      + '  <button class="ecc-tab" data-ecc="tab" data-tab="mine">My requests</button>'
      + '</div>'
      + '<div class="ecc-filters" id="ecc-filters">'
      + '  <input id="ecc-q" type="search" placeholder="Search courses…">'
      + '  <select id="ecc-mode">'
      + '    <option value="">Anywhere</option><option value="online">Online</option>'
      + '    <option value="in_person">In person</option>'
      + '  </select>'
      + '</div>'
      + '<div id="ecc-body"><div class="ecc-empty">Loading…</div></div>';

    root.addEventListener('click', function (ev) {
      var t = ev.target.closest('[data-ecc]');
      if (!t) return;
      var kind = t.getAttribute('data-ecc');
      if (kind === 'ask') return ask(t.getAttribute('data-id'), t);
      if (kind === 'withdraw') return withdraw(t.getAttribute('data-req'));
      if (kind === 'tab') {
        state.tab = t.getAttribute('data-tab');
        root.querySelectorAll('.ecc-tab').forEach(function (b) { b.classList.toggle('on', b === t); });
        var f = document.getElementById('ecc-filters');
        if (f) f.style.display = state.tab === 'browse' ? '' : 'none';
        render();
      }
    });

    var timer = null;
    ['ecc-q', 'ecc-mode'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('input', function () {
        clearTimeout(timer); timer = setTimeout(loadCourses, 250);
      });
    });

    loadCourses();
    loadMine();
  }

  document.addEventListener('wren:ready', mount);
  window.WrenEalingCpd = { mount: mount };
})();
