/* wren-plan-view.js — the planning view, ONE renderer for the parents app and the EY tablet app.
 *
 * the office manager, 27 Oct 2026: "How the parents see the planning in the parents app is exactly how the staff should
 * see it in the EY portal." The parents' page (editions/parents/welcome/planning.html) and the staff page
 * (editions/ladn/public/ey/planning.html) both build their plan from here, with public/css/wren-plan-view.css,
 * so there is no second copy that can drift: change the layout once and both portals change.
 *
 * ── THE MODEL ───────────────────────────────────────────────────────────────────────────────────────
 *   render(target, { rooms: [ { key:'baby', active:true, blocks:[ …blocks… ] } ] }, { before:true })
 * A room's chrome (emoji, name, age range, the "How we plan" fold) is WrenPlanView.ROOMS — one place.
 * A room's body is an ordered list of blocks:
 *   { type:'header', title, meta, tag? }                       term-header: heading, dates/room, state tag
 *   { type:'sub', text }                                       a section heading ("Weekly Activities")
 *   { type:'tabs', prefix, tabs:[ { label, badge?, active?, panel } ] }
 *        panel = { kind:'week',  theme, days:[ {n,day,focus,title,adult,resources?} ] }   day cards, Mon–Fri
 *              | { kind:'ht',    theme, period, cards:[ {title, cells:[[label,text]…]} ] } activity cards
 *              | { kind:'blocks', blocks:[…] }                  any blocks (the staff half-term tabs)
 *              | { kind:'lazy' }                                filled later: fillPanel(id, blocks)
 *   { type:'cards', cards:[ {title, cells:[[label,text]…]} ] }  activity cards, not in a tab
 *   { type:'overview', cards:[ {title, items:[…]} ], events:[ {date,title} ] }
 *   { type:'note', html }                                      an empty state
 *
 * Parents' plan content is data in the page; staff plan content is the live plan from
 * GET /api/planning/termly/plan, turned into the same blocks by blocksFromPlan(). Both end up in
 * the same builders below.
 *
 * Interaction (room tabs, week/half-term tabs) is bind(); lazy tabs announce themselves with a bubbling
 * "wpv:tab" CustomEvent { prefix, idx, panel } so a page can fetch what a tab needs the first time it opens.
 * No inline handlers anywhere — the portals' CSP forbids them.
 */
(function (w) {
  'use strict';

  var ROOMS = [
    { id: 1, key: 'baby', emoji: '🐣', name: 'Baby Room', ages: '6 months – 2 years',
      fold: { summary: 'How we plan in the Baby Room',
        text: 'We are led by the children in terms of activity planning and take our cue from what they show interest in. Each child\'s needs are met on an individual basis.' } },
    { id: 2, key: 'preschool', emoji: '🎨', name: 'Pre-school', ages: '2 – 5 years',
      fold: { summary: 'How Pre-school planning works',
        text: 'Pre-school planning runs as a half-term topic with related activities explored across the weeks. Each activity is shown with our intent, how we\'ll implement it, the expected impact on children\'s learning, and the adult\'s role in supporting it.' } }
  ];
  function roomByKey(k) { for (var i = 0; i < ROOMS.length; i++) if (ROOMS[i].key === k) return ROOMS[i]; return null; }
  function roomById(id) { for (var i = 0; i < ROOMS.length; i++) if (ROOMS[i].id === Number(id)) return ROOMS[i]; return null; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ── builders ───────────────────────────────────────────────────────────────────────────────────
  function headerHtml(b) {
    return '<div class="term-header"><h2>' + esc(b.title) + '</h2>' +
      '<div class="term-meta">' + esc(b.meta) + '</div>' +
      (b.tag ? '<span class="pv-tag ' + esc(b.tag.cls || '') + '">' + esc(b.tag.text) + '</span>' : '') + '</div>';
  }

  function dayItemHtml(d) {
    return (d.focus ? '<div class="day-focus">' + esc(d.focus) + '</div>' : '') +
      '<div class="day-title">' + esc(d.title) + '</div>' +
      (d.what ? '<div class="day-what">' + esc(d.what) + '</div>' : '') +
      (d.why ? '<div class="day-why">' + esc(d.why) + '</div>' : '') +
      (d.adult ? '<div class="day-adult"><strong>Adult role:</strong> ' + esc(d.adult) + '</div>' : '') +
      (d.resources ? '<div class="day-res"><strong>Resources:</strong> ' + esc(d.resources) + '</div>' : '');
  }
  /* A day is one card. Usually it holds one activity; a day with several (the room added extras) lists them
     in the same card, so the five-column grid stays five columns. */
  function dayCardsHtml(days) {
    return days.map(function (d) {
      return '<div class="day-card dc-' + esc(d.n) + '">' +
        '<div class="day-label">' + esc(d.day) + '</div>' +
        (d.items ? d.items.map(function (it) { return '<div class="day-item">' + dayItemHtml(it) + '</div>'; }).join('') : dayItemHtml(d)) +
        '</div>';
    }).join('');
  }

  function activityCardsHtml(cards) {
    return cards.map(function (c) {
      return '<div class="activity-card"><div class="activity-title">' + esc(c.title) + '</div>' +
        '<div class="activity-grid' + (c.cells.length === 1 ? ' pv-one' : '') + '">' + c.cells.map(function (cell) {
          return '<div class="activity-cell"><span class="cell-label">' + esc(cell[0]) + '</span><p>' + esc(cell[1]) + '</p></div>';
        }).join('') + '</div></div>';
    }).join('');
  }

  function overviewHtml(b) {
    var cards = (b.cards || []).map(function (c) {
      return '<div class="overview-card"><h3>' + esc(c.title) + '</h3><ul>' +
        c.items.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul></div>';
    }).join('');
    var ev = (b.events && b.events.length)
      ? '<div class="overview-card overview-card--events"><h3>Special Events</h3>' +
        '<table class="events-table"><thead><tr><th>Date</th><th>Event</th></tr></thead><tbody>' +
        b.events.map(function (e) { return '<tr><td>' + esc(e.date) + '</td><td>' + esc(e.title) + '</td></tr>'; }).join('') +
        '</tbody></table></div>' : '';
    return '<div class="term-overview"><div class="overview-grid">' + cards + ev + '</div></div>';
  }

  function panelInner(p) {
    if (p.kind === 'week') {
      return '<h3 class="week-theme">' + esc(p.theme) + '</h3><div class="day-grid">' + dayCardsHtml(p.days) + '</div>';
    }
    if (p.kind === 'ht') {
      return '<div class="ht-header"><h3>' + esc(p.theme) + '</h3><span class="ht-period">' + esc(p.period) + '</span></div>' +
        activityCardsHtml(p.cards);
    }
    if (p.kind === 'blocks') return blocksHtml(p.blocks);
    return '<div class="pv-note">Loading…</div>';
  }

  function tabsHtml(b) {
    var tabs = '<div class="week-tabs">' + b.tabs.map(function (t, i) {
      return '<button class="week-tab' + (t.active ? ' active' : '') + '" data-week-prefix="' + esc(b.prefix) +
        '" data-week-idx="' + i + '">' + esc(t.label) +
        (t.badge ? ' <span class="current-badge">' + esc(t.badge) + '</span>' : '') + '</button>';
    }).join('') + '</div>';
    var panels = b.tabs.map(function (t, i) {
      return '<div class="week-panel' + (t.active ? ' active' : '') + '" id="' + esc(b.prefix) + '-week-' + i + '">' +
        panelInner(t.panel) + '</div>';
    }).join('');
    return tabs + panels;
  }

  function blocksHtml(blocks) {
    return (blocks || []).map(function (b) {
      switch (b.type) {
        case 'header':   return headerHtml(b);
        case 'sub':      return '<h3 class="pv-sub">' + esc(b.text) + '</h3>';
        case 'tabs':     return tabsHtml(b);
        case 'cards':    return activityCardsHtml(b.cards);
        case 'overview': return overviewHtml(b);
        case 'note':     return '<div class="pv-note">' + b.html + '</div>';
        default:         return '';
      }
    }).join('');
  }

  function foldHtml(f) {
    return '<details class="lap-fold pv-fold"><summary>' + esc(f.summary) + '</summary>' +
      '<div class="lap-fold-body"><p>' + esc(f.text) + '</p></div></details>';
  }

  function roomTabsHtml(rooms) {
    return '<div class="room-tabs">' + rooms.map(function (r) {
      var info = roomByKey(r.key) || { emoji: '', name: r.name || r.key, ages: '' };
      return '<button class="room-tab' + (r.active ? ' active' : '') + '" data-room="' + esc(r.key) + '">' +
        esc(info.emoji) + ' ' + esc(r.name || info.name) +
        (info.ages ? ' <span class="rt-age">(' + esc(info.ages) + ')</span>' : '') + '</button>';
    }).join('') + '</div>';
  }

  function roomPanelHtml(r) {
    var info = roomByKey(r.key);
    return '<div class="room-panel' + (r.active ? ' active' : '') + '" id="room-' + esc(r.key) + '">' +
      blocksHtml(r.blocks) + (info && info.fold ? foldHtml(info.fold) : '') + '</div>';
  }

  /** The whole view: room tabs, then one panel per room. */
  function viewHtml(model) {
    var rooms = model.rooms || [];
    return roomTabsHtml(rooms) + rooms.map(roomPanelHtml).join('');
  }

  /**
   * @param {string|Element} target
   * @param {object} model   { rooms: [...] }
   * @param {object} [opts]  { before: true } inserts the view in front of target instead of inside it
   */
  function render(target, model, opts) {
    var el = (typeof target === 'string') ? document.querySelector(target) : target;
    if (!el) return null;
    var html = viewHtml(model);
    if (opts && opts.before) el.insertAdjacentHTML('beforebegin', html);
    else el.innerHTML = html;
    return el;
  }

  // ── interaction ────────────────────────────────────────────────────────────────────────────────
  function showRoom(key, root) {
    var scope = root || document;
    scope.querySelectorAll('.room-panel').forEach(function (p) { p.classList.remove('active'); });
    scope.querySelectorAll('.room-tab').forEach(function (t) { t.classList.remove('active'); });
    var panel = scope.querySelector('#room-' + key);
    var tab = scope.querySelector('.room-tab[data-room="' + key + '"]');
    if (panel) panel.classList.add('active');
    if (tab) tab.classList.add('active');
    if (panel) panel.dispatchEvent(new CustomEvent('wpv:room', { bubbles: true, detail: { key: key, panel: panel } }));
  }

  function showTab(btn) {
    var prefix = btn.getAttribute('data-week-prefix');
    var idx = parseInt(btn.getAttribute('data-week-idx'), 10);
    var group = btn.parentNode;
    group.querySelectorAll('.week-tab').forEach(function (t, i) { t.classList.toggle('active', i === idx); });
    var panel = null;
    group.querySelectorAll('.week-tab').forEach(function (t, i) {
      var p = document.getElementById(prefix + '-week-' + i);
      if (p) { p.classList.toggle('active', i === idx); if (i === idx) panel = p; }
    });
    if (panel) panel.dispatchEvent(new CustomEvent('wpv:tab', { bubbles: true, detail: { prefix: prefix, idx: idx, panel: panel } }));
  }

  /** One delegated listener for room tabs and week/half-term tabs inside `root`. */
  function bind(root) {
    var el = (typeof root === 'string') ? document.querySelector(root) : root;
    if (!el || el.__wpvBound) return;
    el.__wpvBound = true;
    el.addEventListener('click', function (e) {
      var rt = e.target.closest('[data-room]');
      if (rt && el.contains(rt)) { showRoom(rt.getAttribute('data-room'), el); return; }
      var wt = e.target.closest('[data-week-idx]');
      if (wt && el.contains(wt)) showTab(wt);
    });
  }

  /** Replace what is inside a tab panel (used when a lazy tab's data arrives). */
  function fillPanel(id, blocks) {
    var p = document.getElementById(id);
    if (p) p.innerHTML = blocksHtml(blocks);
    return p;
  }

  // ── staff data → blocks ────────────────────────────────────────────────────────────────────────
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function parseYmd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  }
  function dm(d) { return d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; }
  function dmy(d) { return dm(d) + ' ' + d.getUTCFullYear(); }
  function addDays(d, n) { return new Date(d.getTime() + n * 86400000); }
  function dateRange(a, b) {
    var x = parseYmd(a), y = parseYmd(b);
    if (x && y) return dmy(x) + ' – ' + dmy(y);
    return x ? dmy(x) : (y ? dmy(y) : '');
  }
  function eventDate(s) {
    var d = parseYmd(s);
    if (!d) return '';
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()] + ' ' + dm(d);
  }

  /* The label a week/band tab carries: the same "2 Jun – 13 Jun" the parents' page uses — Monday of the
     first week to Friday of the last. A band that knows no date falls back to the server's own label. */
  function bandLabel(b) {
    var start = parseYmd(b.week_commencing);
    if (!start) return b.label || 'Weeks';
    var weeks = (b.week_nos && b.week_nos.length) ? b.week_nos.length : 1;
    return dm(start) + ' – ' + dm(addDays(start, (weeks - 1) * 7 + 4));
  }

  function resourcesOf(day) {
    var seen = {}, out = [];
    (day.activities || []).forEach(function (a) {
      var r = a && a.resources_needed ? String(a.resources_needed).trim() : '';
      if (r && !seen[r]) { seen[r] = 1; out.push(r); }
    });
    (day.resource_cards || []).forEach(function (c) {
      if (c && c.title && !seen[c.title]) { seen[c.title] = 1; out.push(c.title); }
    });
    return out.join('; ');
  }

  function focusCells(c) {
    var cells = [];
    if (c.intent) cells.push(['Intent', c.intent]);
    if (c.implementation) cells.push(['How we\'ll do it', c.implementation]);
    if (c.impact) cells.push(['Expected impact', c.impact]);
    if (c.adult_role) cells.push(['Adult\'s role', c.adult_role]);
    return cells;
  }

  /**
   * One half-term's plan as blocks — the shape the parents' room panels have, in the same order:
   * heading, the activities (as activity cards and/or Mon–Fri week tabs), then the term overview.
   * @param {object} resp  the body of GET /api/planning/termly/plan  ({ term, view, … })
   * @param {object} [o]   { prefix, roomName, planUrl, hideTag }
   */
  function blocksFromPlan(resp, o) {
    o = o || {};
    var v = resp && resp.view;
    var term = (resp && resp.term) || {};
    if (!v || v.unplanned) {
      return [{ type: 'header', title: (term.name || 'This half-term'),
                meta: [o.roomName, dateRange(term.start_date, term.end_date)].filter(Boolean).join(' · ') },
              { type: 'note', html: 'There is no plan for this half-term yet.' +
                (o.planUrl ? ' <a href="' + esc(o.planUrl) + '">Open the termly plan to write it →</a>' : '') }];
    }
    var blocks = [{
      type: 'header',
      title: [v.term_name, v.theme || 'No theme yet'].filter(Boolean).join(' — '),
      meta: [v.room_name || o.roomName, dateRange(v.starts, v.ends)].filter(Boolean).join(' · '),
      // staff are told whether parents can see it; parents are not shown a state tag at all (o.hideTag)
      tag: o.hideTag ? null : (v.status === 'published' ? { cls: 'live', text: 'Shared with parents' }
         : { cls: 'draft', text: 'Draft — parents can\'t see this yet' })
    }];
    // ps-autumn2-20261030 — the overview sheet's one-line strapline, under the heading.
    var ovw = v.overview || null;
    if (ovw && ovw.summary) blocks.push({ type: 'note', html: '<em>' + esc(ovw.summary) + '</em>' });

    var bands = v.bands || [];
    var dayBands = bands.filter(function (b) { return b.days && b.days.length; });
    var focus = v.focus_activities || [];

    if (focus.length) {
      blocks.push({ type: 'sub', text: 'Half-Term Activities' });
      blocks.push({ type: 'cards', cards: focus.map(function (c) {
        return { title: c.title, cells: focusCells(c) };
      }) });
    }
    if (dayBands.length) {
      blocks.push({ type: 'sub', text: 'Weekly Activities' });
      blocks.push({ type: 'tabs', prefix: (o.prefix || 'wk'), tabs: dayBands.map(function (b, i) {
        return { label: bandLabel(b), active: i === 0, panel: { kind: 'week', theme: v.theme || '', days: b.days.map(function (d) {
          return { n: d.weekday, day: d.weekday_name, focus: d.category, title: d.title || '',
                   what: d.description || '', why: d.intention || '',
                   adult: d.role_of_adult, resources: resourcesOf(d) };
        }) } };
      }) });
    } else if (!focus.length) {
      // a room that plans in weeks, not named days, and has no activity cards written: show the week's activities
      var actBands = bands.filter(function (b) { return b.activities && b.activities.length; });
      if (actBands.length) {
        blocks.push({ type: 'sub', text: 'Weekly Activities' });
        blocks.push({ type: 'tabs', prefix: (o.prefix || 'wk'), tabs: actBands.map(function (b, i) {
          return { label: bandLabel(b), active: i === 0, panel: { kind: 'ht', theme: v.theme || '', period: b.label || '',
            cards: b.activities.map(function (a) {
              var cells = [];
              var body = String(a.description || '');
              var k = body.indexOf(' — ');
              if (k > 0 && k < 80) body = body.slice(k + 3);       // the importer's "Area · Autumn 1 weeks 1-2 — " prefix
              if (body) cells.push(['How we\'ll do it', body]);
              if (a.resources_needed) cells.push(['Resources', a.resources_needed]);
              return { title: a.title, cells: cells };
            }) } };
        }) });
      }
    }

    var ov = { type: 'overview', cards: [], events: [] };
    if (v.intentions && v.intentions.length) ov.cards.push({ title: 'Learning Intentions', items: v.intentions });
    if (v.key_books && v.key_books.length) ov.cards.push({ title: 'Books This Term', items: v.key_books });
    if (v.songs && v.songs.length) ov.cards.push({ title: 'Songs & Rhymes', items: v.songs });
    if (ovw && ovw.ongoing && ovw.ongoing.length) ov.cards.push({ title: 'Throughout the Half-Term', items: ovw.ongoing });
    (ovw && ovw.tuff_trays || []).forEach(function (t) {
      ov.cards.push({ title: 'Tuff Tray' + (t.label ? ' · ' + t.label : '') + (t.title ? ': ' + t.title : ''), items: t.items || [] });
    });
    ov.events = (v.events || []).map(function (e) {
      return { date: eventDate(e.date), title: e.title + (e.location ? ' — ' + e.location : '') };
    });
    if (ov.cards.length || ov.events.length) blocks.push(ov);
    return blocks;
  }

  w.WrenPlanView = {
    ROOMS: ROOMS, roomByKey: roomByKey, roomById: roomById,
    esc: esc, render: render, viewHtml: viewHtml, blocksHtml: blocksHtml, dayCardsHtml: dayCardsHtml,
    bind: bind, showRoom: showRoom, fillPanel: fillPanel,
    blocksFromPlan: blocksFromPlan, dateRange: dateRange
  };
})(window);
