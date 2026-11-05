/* wren-morning-board.js — b286 (2026-09-08)
 *
 * The morning board, rendered. ONE implementation, mounted by two pages:
 *   /ey/my-morning        the EY tablet (44px tap targets, dark navy house style)
 *   /my-morning.html      Roost, where a manager can change the practitioner filter
 *
 * Two copies of this would have drifted the first time a strand changed, so the
 * pages are chrome only: they set WrenMorningBoard.mount({ portal, root }) and
 * this file does the rest. The only per-portal difference is where a row LINKS
 * to — a practitioner goes to the page that does the work, a manager on Roost
 * goes to the child's profile — and that is one lookup table at the bottom.
 *
 * ── RULES THIS FILE ENFORCES ────────────────────────────────────────────────
 * 1. A strand with outstanding === null is NEVER drawn as a number. It draws the
 *    words "not tracked yet" and the reason. A false zero reads as "done" and is
 *    the one failure mode that matters here.
 * 2. Every count is a button that opens the children behind it. No count is
 *    displayed that the response cannot itemise.
 * 3. All network calls go through Wren.api(), never a bare fetch() with a
 *    hand-rolled Authorization header — b280 found five call sites that 403
 *    silently under device enforcement and there is not going to be a sixth.
 */
;(function () {
  'use strict';

  var W = window;
  var STATE = {
    portal: 'ey',
    root: null,
    filters: null,
    data: null,
    q: { scope: 'mine', room_id: '', age_band: '', staff_id: '' },
    open: {},          // strand key -> expanded?
    loading: false,
  };

  // ── State vocabulary ──────────────────────────────────────────────────────
  // Said in words on every row, so the board needs no colour key to be readable
  // — and so it still reads correctly in a high-contrast or monochrome setting.
  var ITEM_WORDS = {
    overdue: 'overdue', due: 'due now', in_progress: 'started',
    not_started: 'not started', upcoming: 'coming up',
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Where a row goes when you tap it ──────────────────────────────────────
  // EY sends a practitioner to the page that DOES the work. Roost sends a
  // manager to the child's record, because that is the manager's job on this
  // board: look, then talk to the key person — not do the practitioner's task.
  var LINKS = {
    ey: {
      termly:       function (i) { return '/ey/termly-update?child=' + i.child_id; },
      two_year:     function (i) { return '/ey/two-year-check?child=' + i.child_id; },
      messages:     function (i) { return '/ey/messages?thread=' + i.thread_id; },
      observations: function (i) { return '/ey/observation-new?child=' + i.child_id; },
      tracking:     function (i) { return '/ey/trackers?child=' + i.child_id; },
      phonics:      function (i) { return '/ey/phonics-tracker?child=' + i.child_id; },
      activities:   function ()  { return '/ey/activities'; },
      planning:     function ()  { return '/ey/termly-plan'; },
    },
    admin: {
      // A manager's job on this board is to look, then talk to the key person —
      // not to do the practitioner's task — so a child row opens that child's
      // record. The three strands with no child behind them open the screen that
      // owns the work instead.
      messages:   function ()  { return '/messages.html'; },
      activities: function ()  { return '/termly-plan.html'; },
      planning:   function ()  { return '/termly-plan.html'; },
      _child:     function (i) { return '/child-profile.html?id=' + i.child_id; },
    },
  };
  function hrefFor(strandKey, item) {
    if (STATE.portal === 'admin') {
      var f = LINKS.admin[strandKey];
      if (f) return f(item);
      return item.child_id ? LINKS.admin._child(item) : null;
    }
    var g = LINKS.ey[strandKey];
    if (!g) return null;
    if (strandKey === 'messages' && !item.thread_id) return null;
    if (strandKey !== 'messages' && strandKey !== 'activities' && strandKey !== 'planning'
        && !item.child_id) return null;
    return g(item);
  }

  // ── Header line for a strand ──────────────────────────────────────────────
  function strandCount(s) {
    if (s.outstanding === null || s.outstanding === undefined) {
      return '<span class="mb-n mb-n-unknown" aria-label="not tracked">—</span>';
    }
    return '<span class="mb-n' + (s.outstanding ? ' mb-n-open' : ' mb-n-clear') + '">'
         + s.outstanding + '</span>';
  }
  function strandStatusLine(s) {
    if (s.state === 'not_tracked') return 'Not tracked yet';
    if (s.state === 'error') return 'Could not be read';
    if (s.state === 'none') return 'Nothing expected';
    if (!s.outstanding) return 'All done';
    return s.outstanding + (s.outstanding === 1 ? ' thing to do' : ' things to do');
  }

  function renderItems(s) {
    if (!s.items || !s.items.length) return '';
    return '<ul class="mb-items" role="list">' + s.items.map(function (i) {
      var href = hrefFor(s.key, i);
      var word = ITEM_WORDS[i.state] || '';
      var inner =
        '<span class="mb-i-main">' + esc(i.label) + '</span>'
        + (i.sub ? '<span class="mb-i-sub">' + esc(i.sub) + '</span>' : '')
        + (word ? '<span class="mb-i-state mb-s-' + esc(i.state) + '">' + word + '</span>' : '');
      return '<li>' + (href
        ? '<a class="mb-i" href="' + esc(href) + '">' + inner + '<span class="mb-i-go" aria-hidden="true">›</span></a>'
        : '<span class="mb-i mb-i-flat">' + inner + '</span>') + '</li>';
    }).join('') + '</ul>';
  }

  function renderStrand(s) {
    var open = !!STATE.open[s.key];
    var canOpen = !!(s.items && s.items.length);
    var cls = ['mb-card', 'mb-st-' + s.state, open ? 'is-open' : ''].join(' ');
    return ''
      + '<section class="' + cls + '" data-strand="' + esc(s.key) + '">'
      +   '<button class="mb-head" type="button" data-toggle="' + esc(s.key) + '"'
      +     (canOpen ? ' aria-expanded="' + (open ? 'true' : 'false') + '"' : ' disabled')
      +     '>'
      +     strandCount(s)
      +     '<span class="mb-head-text">'
      +       '<span class="mb-title">' + esc(s.label) + '</span>'
      +       '<span class="mb-status">' + esc(strandStatusLine(s)) + '</span>'
      +     '</span>'
      +     (canOpen ? '<span class="mb-chev" aria-hidden="true">›</span>' : '')
      +   '</button>'
      +   (s.note ? '<p class="mb-note">' + esc(s.note) + '</p>' : '')
      +   (open ? renderItems(s) : '')
      +   (s.definition
          ? '<details class="mb-def"><summary>How is this counted?</summary><p>'
            + esc(s.definition) + '</p></details>'
          : '')
      + '</section>';
  }

  function renderFilterBar() {
    var f = STATE.filters || { rooms: [], age_bands: [], practitioners: [], is_lead: false };
    var q = STATE.q;
    var rooms = (f.rooms || []).map(function (r) {
      return '<option value="' + r.id + '"' + (String(q.room_id) === String(r.id) ? ' selected' : '') + '>'
           + esc(r.name) + '</option>';
    }).join('');
    var bands = (f.age_bands || []).map(function (b) {
      return '<option value="' + esc(b.key) + '"' + (q.age_band === b.key ? ' selected' : '') + '>'
           + esc(b.label) + '</option>';
    }).join('');
    var people = (f.practitioners || []).map(function (p) {
      return '<option value="' + p.id + '"' + (String(q.staff_id) === String(p.id) ? ' selected' : '') + '>'
           + esc(p.name) + ' (' + p.key_children + ')</option>';
    }).join('');

    return ''
      + '<div class="mb-filters">'
      +   '<div class="mb-seg" role="group" aria-label="Whose children">'
      +     ['mine', 'room'].concat(f.is_lead ? ['all'] : []).map(function (m) {
              var label = m === 'mine' ? 'My children' : (m === 'room' ? 'My room' : 'Whole setting');
              if (f.is_lead && m === 'room') label = 'A room';
              return '<button type="button" class="mb-seg-b' + (q.scope === m ? ' on' : '') + '"'
                   + ' data-scope="' + m + '">' + label + '</button>';
            }).join('')
      +   '</div>'
      +   '<div class="mb-selects">'
      +     (f.is_lead && people
            ? '<label class="mb-f"><span>Key person</span><select id="mb-staff">'
              + '<option value="">Anyone</option>' + people + '</select></label>' : '')
      +     '<label class="mb-f"><span>Room</span><select id="mb-room">'
      +       '<option value="">' + (q.scope === 'room' ? 'All my rooms' : 'Any room') + '</option>'
      +       rooms + '</select></label>'
      +     '<label class="mb-f"><span>Age</span><select id="mb-age">'
      +       '<option value="">Any age</option>' + bands + '</select></label>'
      +   '</div>'
      + '</div>';
  }

  function render() {
    var d = STATE.data;
    var el = STATE.root;
    if (!el) return;
    if (STATE.loading && !d) { el.innerHTML = '<p class="mb-loading">Getting your morning together…</p>'; return; }
    if (!d) { el.innerHTML = '<p class="mb-loading">Nothing loaded.</p>'; return; }

    var unknown = d.unknown_strands || [];
    var head = ''
      + '<div class="mb-top">'
      +   '<div class="mb-tally">'
      +     '<span class="mb-tally-n">' + d.total_outstanding + '</span>'
      +     '<span class="mb-tally-l">' + (d.total_outstanding === 1 ? 'thing to do' : 'things to do')
      +       ' · ' + d.children_in_scope + ' child' + (d.children_in_scope === 1 ? '' : 'ren')
      +     '</span>'
      +   '</div>'
      +   (unknown.length
          ? '<p class="mb-warn">' + unknown.length + ' strand' + (unknown.length === 1 ? ' is' : 's are')
            + ' not counted below — they are shown as “—”, not as zero. Nothing in them is claimed to be done.</p>'
          : '')
      +   (d.scope && d.scope.empty_reason
          ? '<p class="mb-warn">' + esc(d.scope.empty_reason) + '</p>' : '')
      +   (d.scope && d.scope.denied ? '<p class="mb-warn">' + esc(d.scope.denied) + '</p>' : '')
      + '</div>';

    el.innerHTML = renderFilterBar() + head
      + '<div class="mb-grid">' + (d.strands || []).map(renderStrand).join('') + '</div>'
      + '<p class="mb-foot">As at ' + esc(d.on) + '. Week from ' + esc(d.week_start) + '. '
      + 'Read-only — every row opens the page that does the work.</p>';
  }

  // ── Data ──────────────────────────────────────────────────────────────────
  function qs() {
    var q = STATE.q, p = [];
    p.push('scope=' + encodeURIComponent(q.scope));
    if (q.room_id)  p.push('room_id=' + encodeURIComponent(q.room_id));
    if (q.age_band) p.push('age_band=' + encodeURIComponent(q.age_band));
    if (q.staff_id) p.push('staff_id=' + encodeURIComponent(q.staff_id));
    return p.join('&');
  }

  function load() {
    STATE.loading = true;
    render();
    return W.Wren.api('/api/my-morning/board?' + qs()).then(function (d) {
      STATE.loading = false;
      STATE.data = d;
      render();
    }).catch(function (e) {
      STATE.loading = false;
      STATE.root.innerHTML = '<p class="mb-warn">The board could not be loaded: '
        + esc((e && e.error) || 'unknown error')
        + '. Nothing here is being reported as done.</p>';
    });
  }

  function onClick(ev) {
    var t = ev.target;
    var seg = t.closest && t.closest('[data-scope]');
    if (seg) { STATE.q.scope = seg.getAttribute('data-scope'); STATE.open = {}; return load(); }
    var tog = t.closest && t.closest('[data-toggle]');
    if (tog && !tog.disabled) {
      var k = tog.getAttribute('data-toggle');
      STATE.open[k] = !STATE.open[k];
      return render();
    }
  }
  function onChange(ev) {
    var id = ev.target && ev.target.id;
    if (id === 'mb-room')  { STATE.q.room_id = ev.target.value; return load(); }
    if (id === 'mb-age')   { STATE.q.age_band = ev.target.value; return load(); }
    if (id === 'mb-staff') { STATE.q.staff_id = ev.target.value; return load(); }
  }

  function mount(opts) {
    opts = opts || {};
    STATE.portal = opts.portal || 'ey';
    STATE.root = typeof opts.root === 'string' ? document.querySelector(opts.root) : opts.root;
    if (!STATE.root) return;

    // A deep link may pre-set the filters (Roost's group cards do this).
    var url = new URLSearchParams(location.search);
    if (['mine', 'room', 'all'].indexOf(url.get('scope')) >= 0) STATE.q.scope = url.get('scope');
    if (url.get('room_id'))  STATE.q.room_id = url.get('room_id');
    if (url.get('age_band')) STATE.q.age_band = url.get('age_band');
    if (url.get('staff_id')) STATE.q.staff_id = url.get('staff_id');

    STATE.root.addEventListener('click', onClick);
    STATE.root.addEventListener('change', onChange);

    return W.Wren.api('/api/my-morning/filters').then(function (f) {
      STATE.filters = f;
      // A manager landing on Roost is not a key person — "my children" would be
      // an empty board for Toby. Open on the whole setting instead, which is the
      // view he asked for, and leave the toggle free.
      if (STATE.portal === 'admin' && f.is_lead && !url.get('scope')) STATE.q.scope = 'all';
      return load();
    }).catch(function () {
      // Filters are chrome; the board is the point. Draw it without them rather
      // than showing an empty page.
      return load();
    });
  }

  W.WrenMorningBoard = { mount: mount, _state: STATE };
})();
