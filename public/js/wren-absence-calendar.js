/* ===========================================================================
 * Wren — shared absence calendar (b229, 2026-08-25)
 * ---------------------------------------------------------------------------
 * One BrightHR-shaped absence grid, mounted by three callers:
 *   editions/hr/public/absences.html            — staff team calendar (HR/Seed)
 *   editions/admin/public/staff/absence-mgmt.html — manager view (Roost)
 *   editions/hr/public/my-absences.html         — inline in the booking form
 *
 * SHAPE. Staff down the side, days across, one bar per absence — the layout
 * BrightHR uses, chosen because Toby's team already read it fluently and the
 * October cutover is not the moment to teach them a new one. Every active staff
 * member gets a row, including the ones who are in, because "who is available"
 * is the actual question.
 *
 * Wren's existing day-cell month calendar (the 7-column grid on Roost's absence
 * screen) is left exactly where it is. This is an addition beside it, not a
 * replacement.
 *
 * NOT COLOUR ALONE. Type is carried by a letter in each cell (H/S/T/M/P/C/O)
 * as well as by hue, and pending is drawn as a dashed outline plus diagonal
 * hatching, so the grid still reads correctly in greyscale or with any of the
 * common colour-vision deficiencies.
 *
 * DATA. GET /api/absence/calendar?view=grid, which b229 extended additively —
 * month/year as before, or from/to for an arbitrary range, plus the active
 * staff roster. No second calendar endpoint was created.
 *
 * THEME. var(--c-*) tokens only, no literal colours, so it follows whatever
 * palette the portal is running.
 * ======================================================================== */
(function (global) {
  'use strict';

  var CSS_ID = 'wren-absence-calendar-css';

  // Absence types → token, letter, label. The letter is what makes the grid
  // legible without colour.
  var TYPES = {
    holiday:       { token: '--c-green',  letter: 'H', label: 'Holiday' },
    sick:          { token: '--c-red',    letter: 'S', label: 'Sick' },
    toil:          { token: '--c-purple', letter: 'T', label: 'TOIL' },
    training:      { token: '--c-blue',   letter: 'R', label: 'Training' },
    maternity:     { token: '--c-orange', letter: 'M', label: 'Maternity' },
    paternity:     { token: '--c-blue',   letter: 'P', label: 'Paternity' },
    compassionate: { token: '--c-amber',  letter: 'C', label: 'Compassionate' },
    bank:          { token: '--c-muted',  letter: 'B', label: 'Public holiday' },
    unpaid:        { token: '--c-muted',  letter: 'U', label: 'Unpaid' },
    appointment:   { token: '--c-blue',   letter: 'A', label: 'Appointment' },
    other:         { token: '--c-amber',  letter: 'O', label: 'Other' }
  };

  // TWO vocabularies arrive on the same endpoint and both have to render.
  //   absence_requests uses Wren's four values: holiday | sick | toil | other.
  //   hr_absences carries BrightHR's own sixteen, verbatim from the export —
  //   "Annual leave", "Public holiday", "Time off in lieu", "Sickness",
  //   "Mandatory leave", "Unpaid leave", "Training / events",
  //   "Medical appointment", "Bereavement leave", "Antenatal leave",
  //   "Parental leave", "Dental appointment", "Self-isolation",
  //   "Compassionate leave", "Time off for dependants", "Other".
  // Matching on exact keys alone sent every BrightHR row to the amber "Other"
  // bucket — 1,357 annual-leave days rendering as "O". Match on substrings
  // instead, most specific first, so both vocabularies land in the right bucket
  // and any type BrightHR adds later degrades to Other rather than breaking.
  var MATCH = [
    [/self.?isolat|sick/i,            'sick'],
    [/public holiday|bank holiday/i,  'bank'],
    [/time off in lieu|toil/i,        'toil'],
    [/matern|antenatal/i,             'maternity'],
    [/patern|parental/i,              'paternity'],
    [/compassion|bereave|dependant/i, 'compassionate'],
    [/train|course|event/i,           'training'],
    [/appointment|medical|dental/i,   'appointment'],
    [/unpaid/i,                       'unpaid'],
    [/annual|holiday|leave/i,         'holiday']    // last: "…leave" is the catch-all suffix
  ];
  function typeKey(t) {
    var raw = String(t == null ? '' : t).trim();
    if (!raw) return 'other';
    if (TYPES[raw.toLowerCase()]) return raw.toLowerCase();
    for (var i = 0; i < MATCH.length; i++) if (MATCH[i][0].test(raw)) return MATCH[i][1];
    return 'other';
  }
  function typeInfo(t) { return TYPES[typeKey(t)] || TYPES.other; }

  // ── date helpers. All dates are handled as plain YYYY-MM-DD strings and only
  // ever built with Date.UTC, because a local-midnight Date on a BST day shifts
  // backwards an hour and lands the bar on the wrong column.
  function iso(d) { return d.toISOString().slice(0, 10); }
  function parseISO(s) {
    var p = String(s || '').slice(0, 10).split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  }
  function addDays(s, n) {
    var d = parseISO(s); d.setUTCDate(d.getUTCDate() + n); return iso(d);
  }
  function eachDay(from, to) {
    var out = [], d = parseISO(from), end = parseISO(to);
    while (d <= end) { out.push(iso(d)); d.setUTCDate(d.getUTCDate() + 1); }
    return out;
  }
  function monthBounds(year, month) {
    return {
      from: year + '-' + String(month).padStart(2, '0') + '-01',
      to: iso(new Date(Date.UTC(year, month, 0)))
    };
  }
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  var DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function fmtDay(s) {
    var d = parseISO(s);
    return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()].slice(0, 3);
  }

  function injectCSS() {
    if (document.getElementById(CSS_ID)) return;
    var st = document.createElement('style');
    st.id = CSS_ID;
    st.textContent = [
      '.wac{font-size:12px;color:var(--c-text)}',
      '.wac-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}',
      '.wac-bar select,.wac-bar input{background:var(--c-navy-mid);border:1px solid var(--c-border);',
      '  color:var(--c-text);border-radius:6px;padding:5px 9px;font-size:12px;font-family:inherit}',
      '.wac-navbtn{background:var(--c-navy-mid);border:1px solid var(--c-border);color:var(--c-text);',
      '  border-radius:6px;padding:5px 11px;font-size:12px;cursor:pointer;font-family:inherit}',
      '.wac-navbtn:hover{border-color:var(--c-blue)}',
      '.wac-label{font-weight:700;font-size:14px;color:var(--c-text);padding:0 6px;min-width:150px;text-align:center}',
      // The scroll container. Wide months must scroll HERE, never move the page.
      // Both axes are explicit: CSS forces overflow-y to auto anyway once
      // overflow-x is auto, and leaving it implicit meant the grid grew past the
      // fold and the sticky "Off that day" row ended up underneath the portal's
      // bottom tab bar. Capping the height puts the day header and the daily
      // totals permanently in view with the staff rows scrolling between them —
      // which is how BrightHR's own grid behaves.
      '.wac-scroll{overflow:auto;max-height:min(70vh,620px);border:1px solid var(--c-border);',
      '  border-radius:10px;background:var(--c-card);overscroll-behavior:contain}',
      // Inside a modal there is nowhere near that much room.
      '.wac-compact .wac-scroll{max-height:230px}',
      '.wac-grid{display:grid;min-width:max-content}',
      '.wac-cell{border-right:1px solid var(--c-border);border-bottom:1px solid var(--c-border);',
      '  min-height:26px;position:relative}',
      // Sticky name column — the whole point of the layout is reading across a
      // row, which needs the name pinned while the days scroll under it.
      '.wac-name{position:sticky;left:0;z-index:2;background:var(--c-navy-mid);padding:5px 9px;',
      '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:190px;',
      '  border-right:1px solid var(--c-border);border-bottom:1px solid var(--c-border);',
      '  font-size:12px;display:flex;align-items:center;gap:6px}',
      '.wac-name-room{color:var(--c-muted);font-size:10px}',
      '.wac-head{position:sticky;top:0;z-index:3;background:var(--c-navy-light);text-align:center;',
      '  font-size:10px;font-weight:700;color:var(--c-muted);padding:3px 0;line-height:1.25;',
      '  border-right:1px solid var(--c-border);border-bottom:1px solid var(--c-border)}',
      '.wac-head.wac-corner{left:0;z-index:4;text-align:left;padding-left:9px}',
      '.wac-weekend{background:color-mix(in srgb, var(--c-muted) 12%, transparent)}',
      '.wac-today{box-shadow:inset 2px 0 0 var(--c-blue),inset -2px 0 0 var(--c-blue)}',
      '.wac-head.wac-today{color:var(--c-blue)}',
      // Selected booking window, used by the request form.
      '.wac-sel{background:color-mix(in srgb, var(--c-blue) 22%, transparent)}',
      '.wac-head.wac-sel{color:var(--c-blue);background:color-mix(in srgb, var(--c-blue) 30%, transparent)}',
      '.wac-chip{position:absolute;inset:2px;border-radius:4px;display:flex;align-items:center;',
      '  justify-content:center;font-size:9px;font-weight:800;line-height:1;color:var(--c-navy);',
      '  letter-spacing:.02em}',
      // Pending: dashed outline + hatch, so status never depends on hue. The
      // text-shadow is what keeps the type letter readable where a stripe runs
      // straight through it.
      '.wac-chip.wac-pending{color:var(--c-text);border:1px dashed currentColor;',
      '  text-shadow:0 0 3px var(--c-navy),0 0 3px var(--c-navy),0 0 2px var(--c-navy)}',
      '.wac-foot{position:sticky;bottom:0;background:var(--c-navy-light);text-align:center;',
      '  font-size:10px;font-weight:700;color:var(--c-muted);padding:3px 0;',
      '  border-right:1px solid var(--c-border);border-top:1px solid var(--c-border)}',
      '.wac-foot.wac-corner{left:0;z-index:4;text-align:left;padding-left:9px;color:var(--c-text)}',
      '.wac-foot.wac-busy{color:var(--c-amber)}',
      '.wac-foot.wac-heavy{color:var(--c-red)}',
      '.wac-legend{display:flex;gap:12px;flex-wrap:wrap;margin-top:9px;font-size:11px;color:var(--c-muted)}',
      '.wac-key{display:inline-flex;align-items:center;gap:5px}',
      '.wac-key i{width:13px;height:13px;border-radius:3px;display:inline-flex;align-items:center;',
      '  justify-content:center;font-size:8px;font-weight:800;font-style:normal;color:var(--c-navy)}',
      '.wac-empty{padding:26px;text-align:center;color:var(--c-muted);font-size:12px}',
      '.wac-note{margin-top:8px;font-size:11px;color:var(--c-muted);line-height:1.5}',
      '@media (max-width:640px){.wac-name{max-width:112px;font-size:11px}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  // A chip's background. Approved is a solid fill; pending is diagonal hatching
  // in the same hue, so the two stay distinguishable with colour removed.
  //
  // The hatch needs a tinted base underneath it. Left transparent, the stripe
  // gaps show the page through and the type letter sitting on top becomes
  // unreadable — which defeats the point of putting a letter there in the first
  // place. background-color carries the base, background-image the stripes.
  function chipStyle(info, pending) {
    var c = 'var(' + info.token + ')';
    return pending
      ? 'background-image:repeating-linear-gradient(45deg,' + c + ',' + c + ' 3px,transparent 3px,transparent 6px);' +
        'background-color:color-mix(in srgb, ' + c + ' 20%, var(--c-navy-mid));'
      : 'background:' + c + ';';
  }

  function Calendar(el, opts) {
    this.el = el;
    this.opts = opts || {};
    this.mode = this.opts.from && this.opts.to ? 'range' : 'month';
    var now = new Date();
    this.year = this.opts.year || now.getFullYear();
    this.month = this.opts.month || (now.getMonth() + 1);
    this.from = this.opts.from || null;
    this.to = this.opts.to || null;
    this.selFrom = this.opts.selectFrom || null;
    this.selTo = this.opts.selectTo || null;
    this.roomFilter = '';
    this.typeFilter = '';
    this.data = null;
    injectCSS();
    this.render();
    this.load();
  }

  Calendar.prototype.bounds = function () {
    return this.mode === 'range'
      ? { from: this.from, to: this.to }
      : monthBounds(this.year, this.month);
  };

  // Point the grid at an explicit date range (the booking form does this every
  // time the staff member changes a date). Pads by a few days either side so the
  // colleague on leave the day before yours is visible too.
  Calendar.prototype.setRange = function (from, to, pad) {
    if (!from || !to) return;
    var p = pad == null ? 3 : pad;
    this.mode = 'range';
    this.selFrom = from; this.selTo = to;
    this.from = addDays(from, -p);
    this.to = addDays(to, p);
    this.load();
  };

  Calendar.prototype.setMonth = function (year, month) {
    this.mode = 'month'; this.year = year; this.month = month; this.load();
  };

  Calendar.prototype.step = function (n) {
    if (this.mode === 'range') {
      this.from = addDays(this.from, n * 28); this.to = addDays(this.to, n * 28);
    } else {
      this.month += n;
      if (this.month < 1) { this.month = 12; this.year--; }
      if (this.month > 12) { this.month = 1; this.year++; }
    }
    this.load();
  };

  Calendar.prototype.load = function () {
    var self = this, b = this.bounds();
    var q = this.mode === 'range'
      ? 'from=' + b.from + '&to=' + b.to
      : 'month=' + this.month + '&year=' + this.year;
    var body = this.el.querySelector('[data-wac-body]');
    if (body) body.innerHTML = '<div class="wac-empty">Loading…</div>';
    return global.Wren.api('/api/absence/calendar?view=grid&' + q)
      .then(function (d) { self.data = d; self.render(); })
      .catch(function (e) {
        self.data = null;
        self.render();
        var b2 = self.el.querySelector('[data-wac-body]');
        if (b2) b2.innerHTML = '<div class="wac-empty">Could not load the absence calendar.' +
          (e && (e.error || e.message) ? ' ' + esc(e.error || e.message) : '') + '</div>';
      });
  };

  Calendar.prototype.render = function () {
    var self = this;
    var b = this.bounds();
    var showFilters = this.opts.showFilters !== false;
    var showNav = this.opts.showNav !== false;

    var label = this.mode === 'range'
      ? fmtDay(b.from) + ' – ' + fmtDay(b.to)
      : MONTHS[this.month - 1] + ' ' + this.year;

    var rooms = [];
    if (this.data && this.data.staff) {
      var seen = {};
      this.data.staff.forEach(function (s) {
        if (s.room_id && !seen[s.room_id]) { seen[s.room_id] = 1; rooms.push({ id: s.room_id, name: s.room_name || ('Room ' + s.room_id) }); }
      });
    }

    var head = '';
    if (showNav || showFilters) {
      head += '<div class="wac-bar">';
      if (showNav) {
        head += '<button type="button" class="wac-navbtn" data-wac-prev>‹</button>' +
                '<span class="wac-label">' + esc(label) + '</span>' +
                '<button type="button" class="wac-navbtn" data-wac-next>›</button>';
      }
      if (showFilters) {
        head += '<select data-wac-room aria-label="Filter by room"><option value="">All rooms</option>' +
          rooms.map(function (r) {
            return '<option value="' + esc(r.id) + '"' + (String(self.roomFilter) === String(r.id) ? ' selected' : '') + '>' + esc(r.name) + '</option>';
          }).join('') + '</select>';
        head += '<select data-wac-type aria-label="Filter by absence type"><option value="">All types</option>' +
          ['holiday', 'sick', 'toil', 'training', 'bank', 'appointment', 'unpaid',
           'maternity', 'paternity', 'compassionate', 'other'].map(function (t) {
            return '<option value="' + t + '"' + (self.typeFilter === t ? ' selected' : '') + '>' + esc(typeInfo(t).label) + '</option>';
          }).join('') + '</select>';
      }
      head += '</div>';
    }

    this.el.className = 'wac' + (this.opts.onlyAbsent || this.opts.compact ? ' wac-compact' : '');
    this.el.innerHTML = head + '<div data-wac-body></div>' +
      '<div class="wac-legend">' +
        ['holiday', 'sick', 'toil', 'training', 'bank', 'appointment', 'other'].map(function (t) {
          var i = typeInfo(t);
          return '<span class="wac-key"><i style="' + chipStyle(i, false) + '">' + i.letter + '</i>' + esc(i.label) + '</span>';
        }).join('') +
        '<span class="wac-key"><i style="' + chipStyle(typeInfo('holiday'), true) + 'border:1px dashed var(--c-text);color:var(--c-text);text-shadow:0 0 3px var(--c-navy),0 0 3px var(--c-navy)">?</i>Pending approval</span>' +
      '</div>';

    var bodyEl = this.el.querySelector('[data-wac-body]');
    bodyEl.innerHTML = this.data ? this.grid(b) : '<div class="wac-empty">Loading…</div>';

    var prev = this.el.querySelector('[data-wac-prev]');
    if (prev) prev.addEventListener('click', function () { self.step(-1); });
    var next = this.el.querySelector('[data-wac-next]');
    if (next) next.addEventListener('click', function () { self.step(1); });
    var rm = this.el.querySelector('[data-wac-room]');
    if (rm) rm.addEventListener('change', function () { self.roomFilter = this.value; self.render(); });
    var tp = this.el.querySelector('[data-wac-type]');
    if (tp) tp.addEventListener('change', function () { self.typeFilter = this.value; self.render(); });
  };

  Calendar.prototype.grid = function (b) {
    var self = this;
    var days = eachDay(b.from, b.to);
    if (!days.length) return '<div class="wac-empty">No dates to show.</div>';

    var staff = (this.data.staff || []).slice();
    var absences = (this.data.absences || []).filter(function (a) {
      // Compare normalised KEYS, not letters — Training and TOIL would collide
      // on letter alone once BrightHR's vocabulary is folded in.
      return !self.typeFilter || typeKey(a.request_type) === typeKey(self.typeFilter);
    });

    if (this.roomFilter) {
      staff = staff.filter(function (s) { return String(s.room_id) === String(self.roomFilter); });
    }
    // Only-those-off mode: the booking form has no room for 19 rows, and the
    // question there is specifically "who is already off", not "who is in".
    if (this.opts.onlyAbsent) {
      var withAbs = {};
      absences.forEach(function (a) { withAbs[a.staff_id] = 1; });
      staff = staff.filter(function (s) { return withAbs[s.id]; });
    }
    // Pin the viewer's own row to the top — they look for themselves first.
    if (this.opts.focusStaffId) {
      var fid = String(this.opts.focusStaffId);
      staff.sort(function (a, c) { return (String(c.id) === fid) - (String(a.id) === fid); });
    }

    if (!staff.length) {
      return '<div class="wac-empty">' +
        (this.opts.onlyAbsent ? 'Nobody is booked off in this window.' : 'No staff match this filter.') +
        '</div>';
    }

    // staff_id → date → absence. Overlaps are rare; last one wins, and the
    // title attribute still lists everything for that day.
    var byStaffDay = {};
    absences.forEach(function (a) {
      var s = a.start_date > b.from ? String(a.start_date).slice(0, 10) : b.from;
      var e = a.end_date < b.to ? String(a.end_date).slice(0, 10) : b.to;
      if (e < b.from || s > b.to) return;
      eachDay(s, e).forEach(function (d) {
        (byStaffDay[a.staff_id] = byStaffDay[a.staff_id] || {})[d] = a;
      });
    });

    var today = iso(new Date());
    var cols = 'grid-template-columns:minmax(120px,190px) repeat(' + days.length + ',minmax(26px,1fr))';
    var html = '<div class="wac-scroll"><div class="wac-grid" role="table" ' +
      'aria-label="Staff absence calendar" style="' + cols + '">';

    // ── header: day number over weekday initial
    html += '<div class="wac-head wac-corner" role="columnheader">Staff</div>';
    days.forEach(function (d) {
      var dt = parseISO(d), dow = dt.getUTCDay();
      var cls = 'wac-head' +
        (dow === 0 || dow === 6 ? ' wac-weekend' : '') +
        (d === today ? ' wac-today' : '') +
        (self.selFrom && d >= self.selFrom && d <= self.selTo ? ' wac-sel' : '');
      html += '<div class="' + cls + '" role="columnheader" title="' + esc(fmtDay(d)) + '">' +
        dt.getUTCDate() + '<br>' + DOW[dow] + '</div>';
    });

    // ── one row per staff member
    staff.forEach(function (s) {
      var isMe = self.opts.focusStaffId && String(s.id) === String(self.opts.focusStaffId);
      html += '<div class="wac-name" role="rowheader" title="' + esc(s.name) + '">' +
        '<span style="overflow:hidden;text-overflow:ellipsis' + (isMe ? ';font-weight:700;color:var(--c-blue)' : '') + '">' +
        esc(s.name) + (isMe ? ' (you)' : '') + '</span>' +
        (s.room_name ? '<span class="wac-name-room">' + esc(s.room_name) + '</span>' : '') +
        '</div>';
      days.forEach(function (d) {
        var dt = parseISO(d), dow = dt.getUTCDay();
        var cls = 'wac-cell' +
          (dow === 0 || dow === 6 ? ' wac-weekend' : '') +
          (d === today ? ' wac-today' : '') +
          (self.selFrom && d >= self.selFrom && d <= self.selTo ? ' wac-sel' : '');
        var a = (byStaffDay[s.id] || {})[d];
        var chip = '';
        if (a) {
          var info = typeInfo(a.request_type);
          var pending = a.status === 'pending';
          chip = '<span class="wac-chip' + (pending ? ' wac-pending' : '') + '" style="' + chipStyle(info, pending) + '" ' +
            'title="' + esc(s.name + ' — ' + info.label + (pending ? ' (pending approval)' : ' (approved)') +
              ', ' + fmtDay(String(a.start_date).slice(0, 10)) + ' to ' + fmtDay(String(a.end_date).slice(0, 10))) + '">' +
            (pending ? info.letter + '?' : info.letter) + '</span>';
        }
        html += '<div class="' + cls + '" role="cell">' + chip + '</div>';
      });
    });

    // ── footer: how many are off each day. This is the ratio-risk line — a
    // manager scanning for trouble reads this row, not the grid above it.
    html += '<div class="wac-foot wac-corner">Off that day</div>';
    days.forEach(function (d) {
      var n = 0;
      staff.forEach(function (s) { if ((byStaffDay[s.id] || {})[d]) n++; });
      var dow = parseISO(d).getUTCDay(), weekend = dow === 0 || dow === 6;
      var cls = 'wac-foot' + (weekend ? ' wac-weekend' : '') +
        (!weekend && n >= 3 ? ' wac-heavy' : !weekend && n === 2 ? ' wac-busy' : '');
      html += '<div class="' + cls + '">' + (n || '') + '</div>';
    });

    html += '</div></div>';
    return html;
  };

  global.WrenAbsenceCalendar = {
    mount: function (elOrId, opts) {
      var el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
      if (!el) return null;
      return new Calendar(el, opts);
    },
    typeInfo: typeInfo,
    typeKey: typeKey
  };
}(window));
