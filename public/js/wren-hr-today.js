/* Wren — the HR app's "today" panels, written once (b525, 2026-10-22)
 *
 * Home, the Calendar tab and the Request tab all need the same four answers:
 * am I clocked in, when is my next shift, how much holiday is left, and who is
 * off. Before b525 the Home page asked a different question from the one the
 * absence page asked and got a different-looking answer. These are the single
 * renderers, so the figure on Home is the figure on the page behind it.
 *
 * WHO IS OFF — NAMES AND DATES ONLY.
 * GET /api/absence/calendar returns `request_type` (the reason) and
 * `staff_name`. Every renderer here drops request_type on the floor on purpose:
 * Toby's rule for this build is "who's off today (team, names only, no
 * reasons)", which is also what staff see of each other elsewhere. If you add a
 * panel, do not print the type. The route is shared with the manager screens,
 * which legitimately show reasons — the restraint has to live here, at the
 * point of render, which is why there is only one of these functions.
 *
 * Every figure is fetched live and nothing is cached across pages: a holiday
 * balance remembered from the last page load is a balance that can be wrong.
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(path) {
    if (window.Wren && Wren.api) return Wren.api(path);
    var t = '';
    try { t = sessionStorage.getItem('wrenToken') || ''; } catch (_) {}
    return fetch(path, { headers: t ? { Authorization: 'Bearer ' + t } : {} })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  /* ── Dates. London, and never a UTC round-trip that can slip a day ─────── */
  function ymd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
         + '-' + String(d.getDate()).padStart(2, '0');
  }
  function today() { return ymd(new Date()); }
  function plusDays(n) { var d = new Date(); d.setDate(d.getDate() + n); return ymd(d); }

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function prettyDate(iso) {
    if (!iso) return '';
    var d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return iso;
    var t = today();
    if (iso === t) return 'Today';
    if (iso === plusDays(1)) return 'Tomorrow';
    return DAYS[d.getDay()].slice(0, 3) + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
  }
  function hhmm(t) { return t ? String(t).substring(0, 5) : null; }

  /* ── 1. Clock status ─────────────────────────────────────────────────────
   * Wren has NO web self-clock-in: POST /api/clockin/event needs a fob_uid and
   * /manual is manager-only, because the real clock is the NFC fob on the door.
   * So this is an honest status tile that says where you stand and links to the
   * full record — not a button that would pretend to clock you in and fail. */
  function clockStatus(el, opts) {
    if (!el) return Promise.resolve();
    opts = opts || {};
    el.innerHTML = '<div class="hrt-skel" aria-busy="true">Checking the clock…</div>';
    return api('/api/clockin/my').then(function (d) {
      d = d || {};
      var state = d.status || 'not_arrived';
      var mins = Number(d.today_worked_minutes) || 0;
      var worked = mins ? (Math.floor(mins / 60) + 'h ' + String(mins % 60).padStart(2, '0') + 'm') : null;
      var since = null;
      if (state === 'in' && d.since) {
        var s = new Date(d.since);
        if (!isNaN(s)) since = String(s.getHours()).padStart(2, '0') + ':' + String(s.getMinutes()).padStart(2, '0');
      }
      var label, tone, sub;
      if (state === 'in') {
        label = 'Clocked in'; tone = 'ok';
        sub = (since ? 'Since ' + since : 'In now') + (worked ? ' · ' + worked + ' today' : '');
      } else if (state === 'out') {
        label = 'Clocked out'; tone = 'muted';
        sub = worked ? worked + ' today' : 'You have tapped out';
      } else {
        label = 'Not clocked in'; tone = 'warn';
        sub = 'Tap your fob on the door reader';
      }
      var open = (d.queries || []).length;
      el.innerHTML =
        '<a href="/my-clock.html" class="hrt-clock hrt-tone-' + tone + '">'
        + '<span class="hrt-clock-dot" aria-hidden="true"></span>'
        + '<span class="hrt-clock-main">'
        + '<span class="hrt-clock-label">' + esc(label) + '</span>'
        + '<span class="hrt-sub">' + esc(sub) + '</span>'
        + '</span>'
        + (open ? '<span class="hrt-pill hrt-pill-warn">' + open + ' to answer</span>' : '')
        + '<span class="hrt-chev" aria-hidden="true">›</span>'
        + '</a>';
    }).catch(function () {
      el.innerHTML = '<a href="/my-clock.html" class="hrt-clock hrt-tone-muted">'
        + '<span class="hrt-clock-dot" aria-hidden="true"></span>'
        + '<span class="hrt-clock-main"><span class="hrt-clock-label">My Hours</span>'
        + '<span class="hrt-sub">Could not read the clock just now</span></span>'
        + '<span class="hrt-chev" aria-hidden="true">›</span></a>';
    });
  }

  /* ── 2. Next shift ──────────────────────────────────────────────────────── */
  function nextShift(el, opts) {
    if (!el) return Promise.resolve();
    opts = opts || {};
    el.innerHTML = '<div class="hrt-skel" aria-busy="true">Looking up your shifts…</div>';
    return api('/api/rota/my').then(function (rows) {
      var list = Array.isArray(rows) ? rows : [];
      var t = today();
      // /my already filters to published weeks from today forward, in date order.
      var next = list.filter(function (s) { return s.shift_date && String(s.shift_date).slice(0, 10) >= t && !s.is_absent; })[0];
      if (!next) {
        el.innerHTML = '<a href="/my-shifts.html" class="hrt-row">'
          + '<span class="hrt-row-main"><span class="hrt-row-title">No shift published yet</span>'
          + '<span class="hrt-sub">Nothing on the published rota for the next two weeks</span></span>'
          + '<span class="hrt-chev" aria-hidden="true">›</span></a>';
        return;
      }
      var iso = String(next.shift_date).slice(0, 10);
      var a = hhmm(next.planned_start), b = hhmm(next.planned_end);
      var when = prettyDate(iso) + (a && b ? ' · ' + a + '–' + b : '');
      var bits = [];
      if (next.room_name) bits.push(next.room_name);
      if (next.label) bits.push(next.label);
      if (next.break_mins) bits.push(next.break_mins + ' min break');
      el.innerHTML = '<a href="/my-shifts.html" class="hrt-row' + (iso === t ? ' hrt-row-now' : '') + '">'
        + '<span class="hrt-row-main">'
        + '<span class="hrt-row-kicker">' + (iso === t ? 'Today’s shift' : 'Next shift') + '</span>'
        + '<span class="hrt-row-title">' + esc(when) + '</span>'
        + (bits.length ? '<span class="hrt-sub">' + esc(bits.join(' · ')) + '</span>' : '')
        + (next.acceptance === 'pending' ? '<span class="hrt-sub">Waiting for you to accept it</span>' : '')
        + '</span>'
        + '<span class="hrt-chev" aria-hidden="true">›</span></a>';
    }).catch(function () {
      el.innerHTML = '<a href="/my-shifts.html" class="hrt-row"><span class="hrt-row-main">'
        + '<span class="hrt-row-title">My Shifts</span>'
        + '<span class="hrt-sub">Could not load the rota just now</span></span>'
        + '<span class="hrt-chev" aria-hidden="true">›</span></a>';
    });
  }

  /* ── 3. Holiday left, in hours AND days ─────────────────────────────────
   * Rendered by public/js/wren-leave-card.js (b522) — the component the Roost
   * dashboard, the person page and my-absences.html already use. One renderer
   * means Home cannot quietly disagree with the page behind it. b522's decision
   * 1 is still open (two leave engines), so this shows the HOURS card and says
   * which it is, exactly as my-absences.html does. */
  function holidayLeft(el, opts) {
    if (!el) return Promise.resolve();
    opts = opts || {};
    el.innerHTML = '<div class="hrt-skel" aria-busy="true">Working out your allowance…</div>';
    return api('/api/leave/allowance/my').then(function (card) {
      if (window.WrenLeaveCard && WrenLeaveCard.render) {
        WrenLeaveCard.render(el, card, { compact: true, href: '/my-absences.html' });
        return;
      }
      // No component on the page: print the two figures plainly rather than
      // nothing. Never invents a number — an absent figure stays an em dash.
      var b = (card && card.balance) || {};
      var dys = (card && card.in_days) || {};
      if (!b.set) {
        el.innerHTML = '<div class="hrt-row"><span class="hrt-row-main">'
          + '<span class="hrt-row-title">Holiday allowance not set</span>'
          + '<span class="hrt-sub">' + esc(b.notSetReason || 'Ask Toby to add your working pattern.') + '</span>'
          + '</span></div>';
        return;
      }
      el.innerHTML = '<a href="/my-absences.html" class="hrt-row"><span class="hrt-row-main">'
        + '<span class="hrt-row-kicker">Holiday left</span>'
        + '<span class="hrt-row-title">'
        + (b.remainingHours == null ? '—' : esc(b.remainingHours) + ' h')
        + (dys.remaining == null ? '' : ' · ' + esc(dys.remaining) + ' days')
        + '</span>'
        + '<span class="hrt-sub">of ' + esc(b.totalAvailableHours) + ' h this leave year</span>'
        + '</span><span class="hrt-chev" aria-hidden="true">›</span></a>';
    }).catch(function () {
      el.innerHTML = '<a href="/my-absences.html" class="hrt-row"><span class="hrt-row-main">'
        + '<span class="hrt-row-title">My Holiday &amp; Absence</span>'
        + '<span class="hrt-sub">Could not work out the allowance just now</span></span>'
        + '<span class="hrt-chev" aria-hidden="true">›</span></a>';
    });
  }

  /* ── 4. Who is off ──────────────────────────────────────────────────────
   * NAMES AND DATES ONLY — see this file's header. `from`/`to` default to today.
   * One person off across several rows (an absence_requests row and a matching
   * historical hr_absences row both land here) is printed once: the route's own
   * NOT EXISTS clause dedupes most of it, and this collapses the rest by id. */
  function whosOff(el, opts) {
    if (!el) return Promise.resolve();
    opts = opts || {};
    var from = opts.from || today();
    var to = opts.to || from;
    el.innerHTML = '<div class="hrt-skel" aria-busy="true">Checking who is off…</div>';
    return api('/api/absence/calendar?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to))
      .then(function (rows) {
        var list = Array.isArray(rows) ? rows : [];
        var byStaff = {};
        list.forEach(function (r) {
          var id = String(r.staff_id);
          var s = String(r.start_date || '').slice(0, 10);
          var e = String(r.end_date || r.start_date || '').slice(0, 10);
          if (!byStaff[id]) {
            byStaff[id] = { name: r.staff_name || 'A colleague', room: r.room_name || null,
                            from: s, to: e, pending: r.status === 'pending' };
          } else {
            // Widen the window rather than printing the same person twice.
            if (s && s < byStaff[id].from) byStaff[id].from = s;
            if (e && e > byStaff[id].to) byStaff[id].to = e;
            if (r.status !== 'pending') byStaff[id].pending = false;
          }
        });
        var people = Object.keys(byStaff).map(function (k) { return byStaff[k]; })
          .sort(function (a, b) { return a.name.localeCompare(b.name); });

        if (!people.length) {
          el.innerHTML = '<div class="hrt-empty">'
            + esc(opts.emptyText || (to === from ? 'Nobody is off today.' : 'Nobody is off in this period.'))
            + '</div>';
          return people;
        }
        el.innerHTML = '<ul class="hrt-off" role="list">' + people.map(function (p) {
          var span = (p.from === p.to)
            ? prettyDate(p.from)
            : prettyDate(p.from) + ' – ' + prettyDate(p.to);
          return '<li class="hrt-off-item">'
            + '<span class="hrt-off-name">' + esc(p.name) + '</span>'
            + '<span class="hrt-off-when">' + esc(span)
            + (p.pending ? ' <span class="hrt-pill">requested</span>' : '') + '</span>'
            + '</li>';
        }).join('') + '</ul>'
        // Said in words, because the omission is deliberate and a colleague
        // will otherwise wonder whether Wren simply failed to load the reason.
        + '<p class="hrt-note">Names and dates only — Wren never shows you why a colleague is off.</p>';
        return people;
      })
      .catch(function () {
        el.innerHTML = '<div class="hrt-empty">Could not load the team calendar just now.</div>';
        return [];
      });
  }

  /* ── 5. My tasks due ────────────────────────────────────────────────────── */
  function myTasks(el, opts) {
    if (!el) return Promise.resolve();
    opts = opts || {};
    var limit = opts.limit || 4;
    el.innerHTML = '<div class="hrt-skel" aria-busy="true">Loading your list…</div>';
    return api('/api/tasks/mine').then(function (d) {
      var rows = Array.isArray(d) ? d : ((d && (d.tasks || d.items)) || []);
      var open = rows.filter(function (t) {
        var s = String(t.status || '').toLowerCase();
        return s !== 'done' && s !== 'complete' && s !== 'completed' && s !== 'cancelled';
      });
      if (!open.length) {
        el.innerHTML = '<div class="hrt-empty">Nothing on your list. </div>';
        return;
      }
      var t = today();
      open.sort(function (a, b) {
        var ad = String(a.due_date || a.due || '9999-99-99').slice(0, 10);
        var bd = String(b.due_date || b.due || '9999-99-99').slice(0, 10);
        return ad < bd ? -1 : (ad > bd ? 1 : 0);
      });
      el.innerHTML = '<ul class="hrt-off" role="list">' + open.slice(0, limit).map(function (k) {
        var due = String(k.due_date || k.due || '').slice(0, 10);
        var late = due && due < t;
        return '<li class="hrt-off-item">'
          + '<span class="hrt-off-name">' + esc(k.title || k.name || 'Task') + '</span>'
          + '<span class="hrt-off-when">'
          + (due ? (late ? '<span class="hrt-pill hrt-pill-warn">overdue ' + esc(prettyDate(due)) + '</span>'
                         : esc(prettyDate(due))) : '')
          + '</span></li>';
      }).join('') + '</ul>'
        + (open.length > limit
            ? '<p class="hrt-note">' + (open.length - limit) + ' more on <a href="/my-tasks.html">My Action Plan</a>.</p>'
            : '');
    }).catch(function () {
      el.innerHTML = '<div class="hrt-empty">Could not load your list just now.</div>';
    });
  }

  window.WrenHrToday = {
    clockStatus: clockStatus,
    nextShift: nextShift,
    holidayLeft: holidayLeft,
    whosOff: whosOff,
    myTasks: myTasks,
    today: today,
    plusDays: plusDays,
    prettyDate: prettyDate,
    ymd: ymd,
    esc: esc,
    api: api,
  };
}());
