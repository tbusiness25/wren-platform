/* wren-mylist.js — b504 (2026-10-17). "My list": one list, three jobs a day.
 *
 *   WrenMyList.mount(el, { compact })   the list (compact = Dashboard card: countdown + Do now only)
 *   WrenMyList.chip(el)                 the top-bar chip  "My list 1/3 · 9d"
 *
 * Data: GET /api/attention/mylist (Roost + manager only). Every row prints
 *   "Your date (Real deadline) — owner"
 * because the two dates are two different facts: "Your date" is the date Wren holds
 * you to, "Real deadline" is the date somebody else will enforce. Never merged.
 *
 * Rules kept: colours are tokens only; no unprompted modal (inline editors and a
 * toast with Undo); one delegated click handler; failure shows a toast and reverts.
 */
(function () {
  'use strict';

  var API = '/api/attention';
  var CSS_ID = 'wren-mylist-css';
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  var CSS = [
    '.ml{display:block;color:var(--c-text);font-size:.9rem;line-height:1.45;max-width:980px}',
    '.ml *{box-sizing:border-box}',
    '.ml h2,.ml h3{margin:0}',
    /* countdown */
    '.ml-count{display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:var(--c-surface);border:1px solid var(--c-border);',
    '  border-left:5px solid var(--c-orange);border-radius:12px;padding:12px 16px;margin-bottom:14px}',
    '.ml-count.hot{border-left-color:var(--c-danger)}',
    '.ml-count-n{font-size:2rem;font-weight:800;line-height:1;color:var(--c-orange);font-variant-numeric:tabular-nums}',
    '.ml-count.hot .ml-count-n{color:var(--c-danger)}',
    '.ml-count-t{font-weight:700}',
    '.ml-count-sub{color:var(--c-muted);font-size:.8rem}',
    '.ml-count-r{margin-left:auto;text-align:right;font-size:.8rem;color:var(--c-muted)}',
    '.ml-count-r b{color:var(--c-text)}',
    /* sections */
    '.ml-sec{margin:0 0 18px}',
    '.ml-h{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin:0 0 8px;font-size:.74rem;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:var(--c-muted)}',
    '.ml-h .ml-h-n{color:var(--c-text);letter-spacing:0;text-transform:none;font-weight:700;font-size:.8rem}',
    '.ml-h .ml-h-r{margin-left:auto;letter-spacing:0;text-transform:none;font-weight:600}',
    '.ml-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}',
    /* rows */
    '.ml-row{display:flex;gap:12px;align-items:flex-start;background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;padding:12px 14px}',
    '.ml-row.ml-now{border-color:var(--c-border-strong,var(--c-border))}',
    '.ml-row.ml-done{opacity:.7}',
    '.ml-row.ml-done .ml-title-t{text-decoration:line-through;color:var(--c-muted)}',
    '.ml-row.ml-stuck{border-left:4px solid var(--c-warn)}',
    '.ml-row.ml-small{padding:9px 12px;align-items:center}',
    '.ml-tick{flex:none;width:30px;height:30px;min-width:30px;min-height:30px;border-radius:50%;border:2px solid var(--c-border-strong,var(--c-muted));background:transparent;color:var(--c-on-fill,var(--c-text));',
    '  cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:.95rem;padding:0;margin-top:1px}',
    '.ml-tick:hover{border-color:var(--c-ok);background:var(--c-ok-soft)}',
    '.ml-tick:focus-visible,.ml-btn:focus-visible,.ml a:focus-visible,.ml summary:focus-visible{outline:2px solid var(--c-focus,var(--c-blue));outline-offset:2px}',
    '.ml-done .ml-tick{background:var(--c-ok);border-color:var(--c-ok)}',
    '.ml-main{flex:1;min-width:0}',
    '.ml-title{font-weight:700;font-size:.95rem;overflow-wrap:anywhere}',
    '.ml-small .ml-title{font-weight:600;font-size:.88rem}',
    '.ml-meta{margin-top:3px;color:var(--c-muted);font-size:.8rem;overflow-wrap:anywhere}',
    '.ml-dates b{color:var(--c-text);font-weight:700}',
    '.ml-real{color:var(--c-muted)}',
    '.ml-reason{margin-top:3px;font-size:.8rem;color:var(--c-text)}',
    '.ml-why{margin-top:3px;font-size:.78rem;color:var(--c-muted);overflow-wrap:anywhere}',
    '.ml-badge{display:inline-block;margin-left:6px;padding:1px 8px;border-radius:999px;font-size:.66rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase;vertical-align:1px;',
    '  background:var(--c-tint-blue,var(--c-blue-soft));color:var(--c-blue)}',
    '.ml-badge.launch{background:var(--c-warn-soft);color:var(--c-warn)}',
    '.ml-badge.stuck{background:var(--c-danger-soft);color:var(--c-danger)}',
    '.ml-badge.starter{background:var(--c-ok-soft);color:var(--c-ok)}',
    /* buttons */
    '.ml-acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px;align-items:center}',
    '.ml-btn{min-height:36px;padding:6px 13px;border-radius:10px;border:1.5px solid var(--c-border-strong,var(--c-border));background:transparent;color:var(--c-text);font:inherit;font-size:.82rem;font-weight:600;cursor:pointer;white-space:nowrap;text-decoration:none;display:inline-flex;align-items:center}',
    '.ml-btn:hover{background:var(--c-blue-soft);border-color:var(--c-muted)}',
    '.ml-btn.pri{background:var(--c-blue);border-color:var(--c-blue);color:var(--c-on-blue,var(--c-on-fill))}',
    '.ml-btn.pri:hover{background:var(--c-blue-dark,var(--c-blue));opacity:.92}',
    '.ml-btn.on{background:var(--c-tint-blue,var(--c-blue-soft));border-color:var(--c-blue);color:var(--c-blue)}',
    '.ml-btn.sm{min-height:30px;padding:3px 10px;font-size:.76rem}',
    '.ml-btn[disabled]{opacity:.5;cursor:not-allowed}',
    '.ml-menu{position:relative;display:inline-block}',
    '.ml-menu>summary{list-style:none}',
    '.ml-menu>summary::-webkit-details-marker{display:none}',
    '.ml-menu-p{position:absolute;z-index:20;top:100%;left:0;margin-top:4px;min-width:170px;background:var(--c-surface-solid,var(--c-surface));border:1px solid var(--c-border-strong,var(--c-border));border-radius:10px;padding:5px;box-shadow:0 8px 24px var(--c-shadow,transparent);display:flex;flex-direction:column;gap:2px}',
    '.ml-menu-p button{text-align:left;border:0;background:transparent;color:var(--c-text);font:inherit;font-size:.82rem;padding:8px 10px;border-radius:7px;cursor:pointer;min-height:36px}',
    '.ml-menu-p button:hover{background:var(--c-blue-soft)}',
    '.ml-edit{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-top:9px;padding:9px;border-radius:10px;background:var(--c-surface-2,var(--c-surface));border:1px dashed var(--c-border-strong,var(--c-border))}',
    '.ml-edit label{display:flex;flex-direction:column;gap:3px;font-size:.72rem;color:var(--c-muted);font-weight:700}',
    '.ml-edit input,.ml-edit select,.ml-add input,.ml-set input[type=text],.ml-set select{background:var(--c-bg);border:1px solid var(--c-border-strong,var(--c-border));color:var(--c-text);border-radius:9px;padding:7px 10px;font:inherit;font-size:.85rem;min-height:38px}',
    /* stages */
    '.ml-stages{display:flex;gap:5px;flex-wrap:wrap;margin-top:9px;align-items:center}',
    '.ml-stages .lbl{font-size:.7rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--c-muted);margin-right:3px}',
    /* collapsibles */
    '.ml-box{background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;overflow:hidden}',
    '.ml-box>summary{cursor:pointer;padding:11px 14px;font-weight:700;font-size:.88rem;list-style:none;display:flex;gap:10px;align-items:center;flex-wrap:wrap;min-height:44px}',
    '.ml-box>summary::-webkit-details-marker{display:none}',
    '.ml-box>summary::before{content:"\\25B8";color:var(--c-muted);font-size:.8rem}',
    '.ml-box[open]>summary::before{content:"\\25BE"}',
    '.ml-box>summary .ml-sum-n{color:var(--c-muted);font-weight:600;font-size:.8rem}',
    '.ml-box-b{padding:2px 14px 12px}',
    '.ml-line{display:flex;gap:10px;align-items:baseline;padding:7px 0;border-top:1px solid var(--c-border);font-size:.85rem}',
    '.ml-line:first-child{border-top:0}',
    '.ml-line .ml-lt{flex:1;min-width:0;overflow-wrap:anywhere}',
    '.ml-line .ml-lm{color:var(--c-muted);font-size:.76rem;text-align:right;max-width:46%}',
    '.ml-line input[type=checkbox]{width:20px;height:20px;flex:none;align-self:center;accent-color:var(--c-blue)}',
    '.ml-area{margin-top:8px;border:1px solid var(--c-border);border-radius:10px;background:var(--c-surface-2,var(--c-surface))}',
    '.ml-area>summary{padding:8px 12px;font-weight:700;font-size:.82rem;cursor:pointer;min-height:40px;display:flex;gap:8px;align-items:center}',
    '.ml-area .ml-box-b{padding:0 12px 8px}',
    /* misc */
    '.ml-add{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px}',
    '.ml-add input{flex:1 1 260px}',
    '.ml-empty{padding:16px;color:var(--c-muted);background:var(--c-surface);border:1px dashed var(--c-border-strong,var(--c-border));border-radius:12px}',
    '.ml-watch{display:flex;gap:12px;flex-wrap:wrap;align-items:center;padding:10px 14px;border-radius:12px;border:1px solid var(--c-border);background:var(--c-surface);color:inherit;text-decoration:none;font-size:.82rem}',
    '.ml-watch:hover{border-color:var(--c-muted)}',
    '.ml-watch b.r{color:var(--c-danger)}.ml-watch b.a{color:var(--c-warn)}.ml-watch b.g{color:var(--c-ok)}',
    '.ml-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:9999;max-width:min(92vw,520px);display:flex;gap:12px;align-items:center;',
    '  background:var(--c-surface-solid,var(--c-surface));color:var(--c-text);border:1px solid var(--c-border-strong,var(--c-border));border-radius:12px;padding:10px 14px;box-shadow:0 8px 28px var(--c-shadow,transparent)}',
    '.ml-toast.err{border-color:var(--c-danger)}',
    '.ml-note{font-size:.78rem;color:var(--c-muted)}',
    '.ml-set{display:flex;gap:14px;flex-wrap:wrap;align-items:center;padding:6px 0}',
    '.ml-set label{display:flex;gap:6px;align-items:center;font-size:.84rem}',
    '.ml-set input[type=checkbox]{width:18px;height:18px;accent-color:var(--c-blue)}',
    /* compact (Dashboard) */
    '.ml.compact .ml-count{margin-bottom:10px;padding:9px 14px}',
    '.ml.compact .ml-count-n{font-size:1.5rem}',
    '.ml.compact .ml-sec{margin-bottom:8px}',
    /* chip */
    '.ml-chip{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--c-border);border-radius:999px;padding:5px 12px;background:var(--c-card,var(--c-surface));color:inherit;text-decoration:none;font-size:.76rem;line-height:1;white-space:nowrap;margin-right:8px}',
    '.ml-chip:hover{border-color:var(--c-muted)}',
    '.ml-chip b{font-variant-numeric:tabular-nums}',
    '.ml-chip .hot{color:var(--c-danger);font-weight:800}',
    '@media (max-width:900px){.ml-chip .ml-chip-l{display:none}}',
    '@media (max-width:560px){',
    '  .ml-row{padding:11px 11px;gap:10px}.ml-btn{min-height:44px}.ml-btn.sm{min-height:40px}.ml-tick{width:40px;height:40px;min-width:40px;min-height:40px}',
    '  .ml-count-r{margin-left:0;text-align:left;width:100%}.ml-line{flex-wrap:wrap}.ml-line .ml-lm{max-width:100%;text-align:left}',
    '  .ml-menu-p{min-width:200px}}',
  ].join('\n');

  // ── helpers ────────────────────────────────────────────────────────────────
  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    var st = document.createElement('style');
    st.id = CSS_ID; st.textContent = CSS;
    document.head.appendChild(st);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(path, opts) {
    if (window.Wren && typeof Wren.api === 'function') return Wren.api(path, opts || {});
    return Promise.reject({ error: 'wren_not_ready' });
  }
  function toDate(s) { return new Date(String(s).slice(0, 10) + 'T12:00:00'); }
  function dayDiff(a, b) { return Math.round((toDate(b) - toDate(a)) / 86400000); }
  function label(s) { if (!s) return ''; var d = toDate(s); return DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON[d.getMonth()]; }
  function rel(s, asOf) {
    if (!s) return '';
    var n = dayDiff(asOf, s);
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n < 0) return 'passed ' + label(s);
    return label(s);
  }
  function hhmm(d) { return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }

  // ── one line, everywhere: "Your date (Real deadline) — owner" ─────────────
  function datesLine(it, asOf) {
    var mine = it.plan_due ? esc(rel(it.plan_due, asOf)) : 'no date';
    var real = it.due_date ? esc(rel(it.due_date, asOf)) : 'none';
    return '<span class="ml-dates"><b>Your date</b> ' + mine + ' <span class="ml-real">(Real deadline ' + real + ')</span>' +
      ' &mdash; ' + esc(it.owner_label || 'Toby') + '</span>';
  }
  function badges(it) {
    var b = '';
    if (it.kind === 'decision') b += '<span class="ml-badge">decision</span>';
    if ((it.tags || []).indexOf('launch') > -1) b += '<span class="ml-badge launch">launch</span>';
    if (it.starter && !it.done) b += '<span class="ml-badge starter">starter</span>';
    if (it.stuck && !it.done) b += '<span class="ml-badge stuck">stuck ' + (it.carried_days | 0) + 'd</span>';
    return b;
  }

  // ── the view ───────────────────────────────────────────────────────────────
  function Inst(el, opts) {
    this.el = el; this.compact = !!(opts && opts.compact); this.d = null;
    this.open = {};      // remembered <details> state across re-renders
    this.showAllNext = false; this.showAllClaude = false;
    this.edit = null;    // {id, mode: 'dates'|'swap'}
    this.closeSel = null; // Set of ids ticked in the CLOSE section
  }

  Inst.prototype.load = function () {
    var self = this;
    var q = this.compact ? '?compact=1' : '?' + (this.showAllNext ? 'next_all=1&' : '') + (this.showAllClaude ? 'claude_all=1' : '');
    return api(API + '/mylist' + q).then(function (d) {
      if (!d || !d.ok) throw d || new Error('empty');
      self.d = d; self.render();
      return d;
    });
  };

  Inst.prototype.render = function () {
    var d = this.d, asOf = d.as_of, h = [];
    h.push(this.renderCount(d));
    if (this.compact) {
      h.push(this.renderDoNow(d, true));
      h.push('<div class="ml-note"><a href="/admin/cockpit/mylist" data-nav="cockpit,mylist">Open My list &rarr;</a></div>');
      this.el.className = 'ml compact';
      this.el.innerHTML = h.join('');
      return;
    }
    h.push('<form class="ml-add" data-form="capture"><input type="text" maxlength="300" placeholder="Add something to Next&hellip; (it gets tomorrow as your date)" aria-label="Add a job to Next" id="ml-add-in"><button class="ml-btn pri" type="submit">Add</button></form>');
    h.push(this.renderDoNow(d, false));
    h.push(this.renderNext(d));
    h.push(this.renderClaude(d));
    h.push(this.renderWaiting(d));
    h.push(this.renderLater(d));
    h.push(this.renderParked(d));
    h.push(this.renderClose(d));
    h.push(this.renderWatching(d));
    h.push(this.renderSettings(d));
    this.el.className = 'ml';
    this.el.innerHTML = h.join('');
    this.restoreOpen();
  };

  Inst.prototype.renderCount = function (d) {
    var c = d.countdown || {};
    var hot = c.days_left != null && c.days_left <= 2;
    var n = c.days_left, word = n === 1 ? 'day' : 'days';
    var big = n < 0 ? 'Passed' : (n === 0 ? 'TODAY' : String(n));
    var sub = n < 0 ? '' : (n === 0 ? '' : ' ' + word);
    var s = '<div class="ml-count' + (hot ? ' hot' : '') + '" role="status"><div class="ml-count-n">' + esc(big) + '<span style="font-size:.9rem;font-weight:700">' + esc(sub) + '</span></div>' +
      '<div><div class="ml-count-t">to ' + esc(c.label || 'launch') + ' &middot; ' + esc(c.date_label || label(c.date)) + '</div>' +
      '<div class="ml-count-sub">Today ' + esc(label(d.as_of)) + '. Everything else is parked and safe.</div></div>';
    if (c.launch_open != null) {
      s += '<div class="ml-count-r">Launch jobs: <b>' + c.launch_open + ' open</b> &middot; ' + c.launch_done + ' done<br>' +
        'you ' + (c.launch_open_toby | 0) + ' &middot; Claude ' + (c.launch_open_claude | 0) + ' &middot; others ' + (c.launch_open_others | 0) + '</div>';
    }
    return s + '</div>';
  };

  Inst.prototype.tick = function (it) {
    return '<button class="ml-tick" type="button" data-act="done" data-id="' + it.id + '" aria-label="' + (it.done ? 'Done' : 'Mark done: ' + esc(it.title)) + '"' + (it.done ? ' disabled' : '') + '>' + (it.done ? '&#10003;' : '') + '</button>';
  };

  Inst.prototype.renderDoNow = function (d, compact) {
    var list = d.do_now || [], self = this;
    var h = '<section class="ml-sec" aria-labelledby="ml-h-now"><div class="ml-h" id="ml-h-now">Do now <span class="ml-h-n">' + (d.today ? d.today.done + ' of ' + d.today.of + ' done' : '') + '</span></div>';
    if (!list.length) {
      h += '<div class="ml-empty">Nothing left today. It will keep.</div></section>';
      return h;
    }
    h += '<ol class="ml-list">';
    list.forEach(function (it, i) {
      var cls = 'ml-row ml-now' + (it.done ? ' ml-done' : '') + (it.stuck ? ' ml-stuck' : '');
      h += '<li class="' + cls + '" data-id="' + it.id + '">' + self.tick(it) + '<div class="ml-main">' +
        '<div class="ml-title"><span class="ml-title-t">' + (i + 1) + '. ' + esc(it.title) + '</span>' + badges(it) + '</div>' +
        '<div class="ml-meta">' + datesLine(it, d.as_of) + (it.effort_minutes ? ' &middot; ' + it.effort_minutes + ' min' : '') + '</div>';
      if (compact) { h += '</div></li>'; return; }
      // The picker's reason is shown when it says something the dates line does not (an estimate, a carry).
      if (it.reason && (it.effort_minutes || it.stuck)) h += '<div class="ml-reason">' + esc(it.reason) + '</div>';
      if (it.why) h += '<div class="ml-why">Why: ' + esc(it.why) + '</div>';
      if (it.done) {
        h += '<div class="ml-acts"><span class="ml-note">Done' + (it.done_at ? ' ' + esc(hhmm(new Date(it.done_at))) : '') + '.</span>' +
          '<button class="ml-btn sm" type="button" data-act="undo" data-id="' + it.id + '">Undo</button></div>';
      } else {
        h += self.actions(it, d, true);
      }
      h += '</div></li>';
    });
    return h + '</ol></section>';
  };

  Inst.prototype.stagesHtml = function (it) {
    if (it.kind !== 'decision') return '';
    var names = ['Read', 'Discussed with the office manager', 'Decided'];
    var h = '<div class="ml-stages"><span class="lbl">Decision</span>';
    names.forEach(function (n, i) {
      var st = i + 1;
      h += '<button class="ml-btn sm' + (it.stage >= st ? ' on' : '') + '" type="button" data-act="stage" data-id="' + it.id + '" data-stage="' + (it.stage === st ? st - 1 : st) + '" aria-pressed="' + (it.stage >= st) + '">' + (it.stage >= st ? '&#10003; ' : '') + n + '</button>';
    });
    return h + '<span class="ml-note">then tick Done</span></div>';
  };

  Inst.prototype.actions = function (it, d, full) {
    var h = this.stagesHtml(it);
    var focusing = it.focus_started_at;
    h += '<div class="ml-acts">' +
      '<button class="ml-btn pri" type="button" data-act="done" data-id="' + it.id + '">Done</button>';
    if (full) {
      h += focusing
        ? '<button class="ml-btn on" type="button" data-act="focus_end" data-id="' + it.id + '">Focusing since ' + esc(hhmm(new Date(it.focus_started_at))) + ' &middot; stop</button>'
        : '<button class="ml-btn" type="button" data-act="focus_start" data-id="' + it.id + '">Start 25 min</button>';
      h += '<details class="ml-menu" data-menu><summary class="ml-btn">Not today &#9662;</summary><div class="ml-menu-p">' +
        '<button type="button" data-act="tomorrow" data-id="' + it.id + '">Tomorrow</button>' +
        '<button type="button" data-act="later" data-id="' + it.id + '">Later (take it off my list for now)</button>' +
        '<button type="button" data-act="park" data-id="' + it.id + '">Park until November</button>' +
        '<button type="button" data-act="drop" data-id="' + it.id + '">Drop it</button></div></details>';
      if ((d.next || []).length) h += '<button class="ml-btn" type="button" data-act="swap_open" data-id="' + it.id + '">Swap&hellip;</button>';
    }
    h += '<button class="ml-btn" type="button" data-act="dates_open" data-id="' + it.id + '">Dates&hellip;</button>';
    if (it.due_date && it.plan_due && it.plan_due < it.due_date) h += '<button class="ml-btn" type="button" data-act="use_buffer" data-id="' + it.id + '" title="Move your date to the real deadline">Use my buffer</button>';
    if (it.action_url && it.action_url !== '/admin/cockpit/kanban') h += '<a class="ml-btn" href="' + esc(it.action_url) + '">Open</a>';
    h += '</div>';
    if (this.edit && this.edit.id === it.id) h += this.editor(it, d);
    if (it.detail && full) h += '<details class="ml-more" style="margin-top:8px"><summary class="ml-note" style="cursor:pointer">Details</summary><div class="ml-why">' + esc(it.detail) + '</div></details>';
    return h;
  };

  Inst.prototype.editor = function (it, d) {
    if (this.edit.mode === 'swap') {
      var opts = (d.next || []).map(function (n) { return '<option value="' + n.id + '">' + esc(n.title.slice(0, 80)) + '</option>'; }).join('');
      return '<div class="ml-edit" data-edit="' + it.id + '"><label>Swap with<select data-f="with">' + opts + '</select></label>' +
        '<button class="ml-btn pri sm" type="button" data-act="swap_go" data-id="' + it.id + '">Swap</button><button class="ml-btn sm" type="button" data-act="edit_close">Cancel</button></div>';
    }
    return '<div class="ml-edit" data-edit="' + it.id + '"><label>Your date<input type="date" data-f="plan_due" value="' + esc(it.plan_due || '') + '"></label>' +
      '<label>Real deadline<input type="date" data-f="due_date" value="' + esc(it.due_date || '') + '"></label>' +
      '<button class="ml-btn pri sm" type="button" data-act="dates_save" data-id="' + it.id + '">Save</button><button class="ml-btn sm" type="button" data-act="edit_close">Cancel</button></div>';
  };

  Inst.prototype.smallRow = function (it, d, withActs) {
    var h = '<li class="ml-row ml-small' + (it.done ? ' ml-done' : '') + '" data-id="' + it.id + '">' + this.tick(it) + '<div class="ml-main">' +
      '<div class="ml-title"><span class="ml-title-t">' + esc(it.title) + '</span>' + badges(it) + '</div>' +
      '<div class="ml-meta">' + datesLine(it, d.as_of) + (it.effort_minutes ? ' &middot; ' + it.effort_minutes + ' min' : '') + '</div>';
    if (withActs) {
      h += '<div class="ml-acts" style="margin-top:6px"><button class="ml-btn sm" type="button" data-act="dates_open" data-id="' + it.id + '">Dates&hellip;</button>' +
        '<button class="ml-btn sm" type="button" data-act="later" data-id="' + it.id + '">Later</button>' +
        '<button class="ml-btn sm" type="button" data-act="park" data-id="' + it.id + '">Park</button></div>';
      if (this.edit && this.edit.id === it.id) h += this.editor(it, d);
    }
    return h + '</div></li>';
  };

  Inst.prototype.renderNext = function (d) {
    var self = this, list = d.next || [];
    var h = '<section class="ml-sec" aria-labelledby="ml-h-next"><div class="ml-h" id="ml-h-next">Next <span class="ml-h-n">' + list.length + ' of ' + d.next_total + '</span>';
    if (d.next_total > list.length) h += '<button class="ml-btn sm ml-h-r" type="button" data-act="next_all">Show all ' + d.next_total + '</button>';
    else if (this.showAllNext && d.next_total > 7) h += '<button class="ml-btn sm ml-h-r" type="button" data-act="next_less">Show 7</button>';
    h += '</div>';
    if (!list.length) return h + '<div class="ml-empty">Nothing queued. Add something above, or enjoy it.</div></section>';
    h += '<ul class="ml-list">';
    list.forEach(function (it) { h += self.smallRow(it, d, true); });
    return h + '</ul></section>';
  };

  Inst.prototype.renderClaude = function (d) {
    var c = d.claude || { n: 0, top: [] }, self = this;
    var items = this.showAllClaude && c.items ? c.items : c.top;
    var h = '<section class="ml-sec" aria-labelledby="ml-h-claude"><div class="ml-h" id="ml-h-claude">Claude is doing <span class="ml-h-n">' + c.n + ' job' + (c.n === 1 ? '' : 's') + '</span>';
    if (c.n > 5 && !this.showAllClaude) h += '<button class="ml-btn sm ml-h-r" type="button" data-act="claude_all">Show all ' + c.n + '</button>';
    else if (this.showAllClaude) h += '<button class="ml-btn sm ml-h-r" type="button" data-act="claude_less">Top 5</button>';
    h += '</div>';
    if (!items.length) return h + '<div class="ml-empty">Nothing with Claude right now.</div></section>';
    h += '<div class="ml-box"><div class="ml-box-b">';
    items.forEach(function (it) {
      h += '<div class="ml-line"><span class="ml-lt">' + esc(it.title) + badges(it) + '</span><span class="ml-lm">' + datesLine(it, d.as_of) + '</span></div>';
    });
    return h + '</div></div></section>';
  };

  Inst.prototype.renderWaiting = function (d) {
    var w = d.waiting || { n: 0, items: [] };
    var h = '<section class="ml-sec" aria-labelledby="ml-h-wait"><div class="ml-h" id="ml-h-wait">Waiting on others <span class="ml-h-n">' + w.n + (w.next_chase ? ' &middot; next chase ' + esc(label(w.next_chase)) : '') + '</span></div>';
    if (!w.n) return h + '<div class="ml-empty">Nobody is holding anything up.</div></section>';
    h += '<div class="ml-box"><div class="ml-box-b">';
    w.items.forEach(function (it) {
      h += '<div class="ml-line"><span class="ml-lt">' + esc(it.title) + '</span><span class="ml-lm">' + datesLine(it, d.as_of) + '</span></div>';
    });
    return h + '</div></div></section>';
  };

  Inst.prototype.renderLater = function (d) {
    var h = '<section class="ml-sec"><details class="ml-box" data-open="later"' + (this.open.later ? ' open' : '') + '><summary>Later <span class="ml-sum-n">' + d.later_total + ' &middot; collapsed by area</span></summary><div class="ml-box-b">';
    (d.later_by_area || []).forEach(function (a) {
      h += '<details class="ml-area" data-open="area-' + esc(a.area) + '"><summary>' + esc(a.area) + ' <span class="ml-sum-n">' + a.n + '</span></summary><div class="ml-box-b">';
      a.items.forEach(function (it) {
        h += '<div class="ml-line"><span class="ml-lt">' + esc(it.title) + (it.launch ? '<span class="ml-badge launch">launch</span>' : '') + '</span><span class="ml-lm">' + datesLine(it, d.as_of) + '</span></div>';
      });
      h += '</div></details>';
    });
    return h + '</div></details></section>';
  };

  Inst.prototype.renderParked = function (d) {
    return '<section class="ml-sec"><div class="ml-box" style="padding:11px 14px"><b>Parked until ' + esc(d.parked_until_label || 'November') + '</b> &middot; ' + d.parked_total +
      ' <span class="ml-note">&mdash; ignore them for now; nothing is deleted.</span></div></section>';
  };

  Inst.prototype.renderClose = function (d) {
    var c = d.close || { n: 0, items: [] };
    if (!c.n) return '';
    if (!this.closeSel) { this.closeSel = {}; c.items.forEach(function (i) { this.closeSel[i.id] = true; }, this); }
    var self = this, ticked = c.items.filter(function (i) { return self.closeSel[i.id]; }).length;
    var groups = {};
    c.items.forEach(function (i) { var k = (i.owner || 'Other'); (groups[k] = groups[k] || []).push(i); });
    var h = '<section class="ml-sec"><details class="ml-box" data-open="close"' + (this.open.close ? ' open' : '') + '><summary>Close <span class="ml-sum-n">' + c.n + ' to confirm &middot; done or stale</span></summary><div class="ml-box-b">' +
      '<p class="ml-note" style="margin:6px 0 8px">The audit found these finished, superseded or stale. Everything is ticked: press <b>Close</b> to tick them off in one go, or untick any you want to keep.</p>' +
      '<div class="ml-acts" style="margin:0 0 6px"><button class="ml-btn pri" type="button" data-act="close_go" id="ml-close-go">Close ' + ticked + ' ticked</button>' +
      '<button class="ml-btn sm" type="button" data-act="close_all">Tick all</button><button class="ml-btn sm" type="button" data-act="close_none">Untick all</button></div>';
    Object.keys(groups).forEach(function (g) {
      h += '<div class="ml-h" style="margin:10px 0 2px">' + esc(g) + ' <span class="ml-h-n">' + groups[g].length + '</span></div>';
      groups[g].forEach(function (i) {
        h += '<label class="ml-line"><input type="checkbox" data-close="' + i.id + '"' + (self.closeSel[i.id] ? ' checked' : '') + '><span class="ml-lt">' + esc(i.title) + (i.why ? '<span class="ml-why" style="display:block">' + esc(i.why) + '</span>' : '') + '</span><span class="ml-lm">' + esc(i.area || '') + '</span></label>';
      });
    });
    return h + '</div></details></section>';
  };

  Inst.prototype.renderWatching = function (d) {
    var w = d.watching || {};
    var h = '<section class="ml-sec"><a class="ml-watch" href="/admin/attention/board" data-nav="attention,board"><b>Wren is watching</b>' +
      '<span><b class="r">' + (w.red | 0) + '</b> need a person</span><span><b class="a">' + (w.amber | 0) + '</b> this week</span><span><b class="g">' + (w.green | 0) + '</b> fine</span>' +
      '<span class="ml-note" style="margin-left:auto">Open the full board &rarr;</span></a>';
    if (w.top && w.top.length) h += '<div class="ml-note" style="padding:6px 14px">' + w.top.map(function (t) { return esc(t.title); }).join(' &middot; ') + '</div>';
    return h + '</section>';
  };

  Inst.prototype.renderSettings = function () {
    return '<section class="ml-sec"><details class="ml-box" data-open="settings" data-settings><summary>Settings <span class="ml-sum-n">nudges and the off switch</span></summary><div class="ml-box-b" id="ml-settings-b"><span class="ml-note">Loading&hellip;</span></div></details></section>';
  };

  Inst.prototype.loadSettings = function () {
    var self = this, box = this.el.querySelector('#ml-settings-b');
    if (!box) return;
    api(API + '/mylist/settings').then(function (r) {
      var s = r.settings || {};
      box.innerHTML = '<p class="ml-note" style="margin:6px 0">Telegram nudges (Part B) are not switched on yet. These switches are stored now so they are already in place.</p>' +
        '<div class="ml-set">' +
        '<label><input type="checkbox" data-set="mylist_enabled"' + (s.mylist_enabled === 'true' ? ' checked' : '') + '> Nudges on</label>' +
        '<label><input type="checkbox" data-set="mylist_launch_mode"' + (s.mylist_launch_mode === 'true' ? ' checked' : '') + '> Launch mode (to 26 Oct)</label>' +
        '<label><input type="checkbox" data-set="mylist_urgent_tone"' + (s.mylist_urgent_tone === 'true' ? ' checked' : '') + '> Urgent tone</label>' +
        '<label>Transport <select data-set="mylist_transport"><option value="dispatcher"' + (s.mylist_transport === 'dispatcher' ? ' selected' : '') + '>Wren bot (links)</option><option value="bot"' + (s.mylist_transport === 'bot' ? ' selected' : '') + '>My list bot (buttons)</option></select></label>' +
        '<label>Pause <select data-set-pause><option value="">Off</option><option value="today">Today</option><option value="monday">Until Monday</option></select></label>' +
        '</div>';
      var p = box.querySelector('[data-set-pause]');
      if (p && s.mylist_paused_until) p.insertAdjacentHTML('beforeend', '<option value="" selected hidden>Until ' + esc(label(s.mylist_paused_until)) + '</option>');
    }).catch(function () { box.innerHTML = '<span class="ml-note">Settings could not be loaded.</span>'; });
  };

  Inst.prototype.restoreOpen = function () {
    var self = this;
    this.el.querySelectorAll('details[data-open]').forEach(function (dt) {
      var k = dt.getAttribute('data-open');
      if (self.open[k]) dt.open = true;
      dt.addEventListener('toggle', function () {
        self.open[k] = dt.open;
        if (k === 'settings' && dt.open && !dt.getAttribute('data-loaded')) { dt.setAttribute('data-loaded', '1'); self.loadSettings(); }
      });
    });
  };

  // ── toast with Undo ────────────────────────────────────────────────────────
  var toastTimer = null;
  function toast(msg, opts) {
    opts = opts || {};
    var old = document.getElementById('ml-toast'); if (old) old.remove();
    var t = document.createElement('div');
    t.id = 'ml-toast'; t.className = 'ml-toast' + (opts.error ? ' err' : ''); t.setAttribute('role', opts.error ? 'alert' : 'status');
    t.innerHTML = '<span>' + esc(msg) + '</span>' + (opts.undo ? '<button class="ml-btn sm" type="button" id="ml-toast-undo">Undo</button>' : '');
    document.body.appendChild(t);
    if (opts.undo) t.querySelector('#ml-toast-undo').addEventListener('click', function () { t.remove(); opts.undo(); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { if (t.parentNode) t.remove(); }, opts.error ? 6000 : 12000);
  }
  function errMsg(e) { return (e && (e.message || e.error)) || 'something went wrong'; }

  // ── actions ────────────────────────────────────────────────────────────────
  Inst.prototype.patch = function (id, body, okMsg, undoable) {
    var self = this;
    return api(API + '/items/' + id, { method: 'PATCH', body: body }).then(function () {
      return self.load().then(function () {
        if (okMsg) toast(okMsg, undoable ? { undo: function () { self.patch(id, { action: 'undo' }, 'Put back.'); } } : {});
      });
    }).catch(function (e) { toast('Could not do that: ' + errMsg(e), { error: true }); self.load().catch(function () {}); });
  };

  Inst.prototype.click = function (ev) {
    var self = this;
    var btn = ev.target.closest('[data-act]');
    if (!btn || !this.el.contains(btn)) return;
    var act = btn.getAttribute('data-act'), id = parseInt(btn.getAttribute('data-id'), 10);
    var menu = btn.closest('details[data-menu]'); if (menu) menu.open = false;
    switch (act) {
      case 'done': {
        var row = btn.closest('.ml-row'); if (row) { row.classList.add('ml-done'); btn.disabled = true; }   // optimistic
        api(API + '/items/' + id, { method: 'PATCH', body: { action: 'done' } }).then(function () {
          return self.load().then(function () { toast('Done. Nice.', { undo: function () { self.patch(id, { action: 'undo' }, 'Put back.'); } }); });
        }).catch(function (e) {
          if (row) { row.classList.remove('ml-done'); btn.disabled = false; }                              // revert
          toast('Could not tick it: ' + errMsg(e), { error: true });
        });
        break;
      }
      case 'undo': this.patch(id, { action: 'undo' }, 'Put back.'); break;
      case 'stage': this.patch(id, { action: 'stage', stage: parseInt(btn.getAttribute('data-stage'), 10) }); break;
      case 'tomorrow': this.patch(id, { action: 'tomorrow' }, 'Moved to tomorrow.'); break;
      case 'later': this.patch(id, { action: 'later' }, 'Moved to Later.'); break;
      case 'park': this.patch(id, { action: 'park' }, 'Parked until November.'); break;
      case 'drop': this.patch(id, { action: 'drop' }, 'Dropped.', true); break;
      case 'use_buffer': this.patch(id, { action: 'use_buffer' }, 'Your date is now the real deadline.'); break;
      case 'focus_start': this.patch(id, { action: 'focus_start', minutes: 25 }, 'Go. Back at ' + hhmm(new Date(Date.now() + 25 * 60000)) + '.'); break;
      case 'focus_end': this.patch(id, { action: 'focus_end' }, 'Stopped.'); break;
      case 'dates_open': this.edit = { id: id, mode: 'dates' }; this.render(); break;
      case 'swap_open': this.edit = { id: id, mode: 'swap' }; this.render(); break;
      case 'edit_close': this.edit = null; this.render(); break;
      case 'dates_save': {
        var box = this.el.querySelector('[data-edit="' + id + '"]');
        var body = { action: 'date', plan_due: box.querySelector('[data-f=plan_due]').value || null, due_date: box.querySelector('[data-f=due_date]').value || null };
        this.edit = null; this.patch(id, body, 'Dates saved.'); break;
      }
      case 'swap_go': {
        var sel = this.el.querySelector('[data-edit="' + id + '"] [data-f=with]');
        this.edit = null; if (sel) this.patch(id, { action: 'swap', with: parseInt(sel.value, 10) }, 'Swapped.'); break;
      }
      case 'next_all': this.showAllNext = true; this.load(); break;
      case 'next_less': this.showAllNext = false; this.load(); break;
      case 'claude_all': this.showAllClaude = true; this.load(); break;
      case 'claude_less': this.showAllClaude = false; this.render(); break;
      case 'close_all': Object.keys(this.closeSel).forEach(function (k) { self.closeSel[k] = true; }); this.open.close = true; this.render(); break;
      case 'close_none': Object.keys(this.closeSel).forEach(function (k) { self.closeSel[k] = false; }); this.open.close = true; this.render(); break;
      case 'close_go': {
        var close = [], keep = [];
        this.d.close.items.forEach(function (i) { (self.closeSel[i.id] ? close : keep).push(i.id); });
        if (!close.length && !keep.length) return;
        btn.disabled = true;
        api(API + '/mylist/close', { method: 'POST', body: { close: close, keep: keep } }).then(function (r) {
          self.closeSel = null; self.open.close = true;
          return self.load().then(function () { toast('Closed ' + r.closed + (r.kept ? ', kept ' + r.kept + ' on your list' : '') + '.'); });
        }).catch(function (e) { btn.disabled = false; toast('Could not close them: ' + errMsg(e), { error: true }); });
        break;
      }
    }
  };

  Inst.prototype.change = function (ev) {
    var self = this, t = ev.target;
    if (t.matches('[data-close]')) {
      this.closeSel[t.getAttribute('data-close')] = t.checked;
      var n = this.d.close.items.filter(function (i) { return self.closeSel[i.id]; }).length;
      var b = this.el.querySelector('#ml-close-go'); if (b) b.textContent = 'Close ' + n + ' ticked';
      return;
    }
    var key = t.getAttribute('data-set');
    if (key) {
      var val = t.type === 'checkbox' ? String(t.checked) : t.value;
      var body = {}; body[key] = val;
      api(API + '/mylist/settings', { method: 'PATCH', body: body }).then(function () { toast('Saved.'); self.load().catch(function () {}); })
        .catch(function (e) { toast('Could not save: ' + errMsg(e), { error: true }); });
      return;
    }
    if (t.matches('[data-set-pause]')) {
      var now = new Date(), until = '';
      if (t.value === 'today') until = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
      if (t.value === 'monday') { var m = new Date(now); m.setDate(m.getDate() + ((8 - m.getDay()) % 7 || 7)); until = m.toISOString().slice(0, 10); }
      api(API + '/mylist/settings', { method: 'PATCH', body: { mylist_paused_until: until } }).then(function () { toast(until ? 'Paused.' : 'Pause off.'); })
        .catch(function (e) { toast('Could not save: ' + errMsg(e), { error: true }); });
    }
  };

  Inst.prototype.submit = function (ev) {
    var form = ev.target.closest('[data-form=capture]');
    if (!form) return;
    ev.preventDefault();
    var inp = form.querySelector('input'), text = (inp.value || '').trim(), self = this;
    if (!text) return;
    api(API + '/mylist/capture', { method: 'POST', body: { text: text, via: 'roost' } }).then(function (r) {
      inp.value = '';
      return self.load().then(function () { toast('Added to Next: ' + (r.item ? r.item.title : text).slice(0, 80)); });
    }).catch(function (e) { toast('Could not add it: ' + errMsg(e), { error: true }); });
  };

  Inst.prototype.nav = function (ev) {
    var a = ev.target.closest('a[data-nav]');
    if (!a || !(window.Wren && typeof Wren.navigate === 'function')) return;
    ev.preventDefault();
    var p = a.getAttribute('data-nav').split(',');
    Wren.navigate(p[0], p[1]);
  };

  function mount(el, opts) {
    if (!el) return Promise.resolve(null);
    injectCss();
    if (el.__mylist) { return el.__mylist.load().catch(function () {}); }
    var inst = new Inst(el, opts);
    el.__mylist = inst;
    el.classList.add('ml');
    el.addEventListener('click', function (ev) { inst.nav(ev); inst.click(ev); });
    el.addEventListener('change', function (ev) { inst.change(ev); });
    el.addEventListener('submit', function (ev) { inst.submit(ev); });
    el.innerHTML = '<div class="ml-note" role="status">Loading your list&hellip;</div>';
    return inst.load().catch(function (e) {
      // "Unavailable" = this instance has no My list at all: the route is not mounted (the SPA answers with a
      // login page, so r.json() throws a SyntaxError rather than rejecting with {error}) or the role is not
      // allowed (403 forbidden_*). The Dashboard card renders nothing; the Cockpit tab hides itself and hands
      // over to Comms (demo editions and non-manager roles). A real server error is still shown below.
      var unavailable = !(e && typeof e === 'object' && typeof e.error === 'string') || /^forbidden/.test(e.error);
      if (opts && opts.compact) { el.innerHTML = ''; return null; }
      if (unavailable && opts && typeof opts.onUnavailable === 'function') { el.innerHTML = ''; opts.onUnavailable(e); return null; }
      // Failure is visible here (unlike the traffic lights): this IS the page.
      el.innerHTML = '<div class="ml-empty" role="alert">My list could not load (' + esc(errMsg(e)) + '). <button class="ml-btn sm" type="button" id="ml-retry">Try again</button></div>';
      var r = el.querySelector('#ml-retry'); if (r) r.addEventListener('click', function () { el.__mylist = null; mount(el, opts); });
    });
  }

  // ── the top-bar chip: "My list 1/3 · 9d" ───────────────────────────────────
  function chip(el) {
    if (!el) return Promise.resolve(null);
    injectCss();
    return api(API + '/mylist?compact=1').then(function (d) {
      if (!d || !d.ok) { el.innerHTML = ''; return null; }
      var n = d.countdown ? d.countdown.days_left : null;
      var hot = n != null && n <= 2;
      var a = document.createElement('a');
      a.className = 'ml-chip'; a.href = '/admin/cockpit/mylist';
      a.title = 'My list: ' + d.today.done + ' of ' + d.today.of + ' done today' + (n != null && n >= 0 ? '; ' + n + ' day' + (n === 1 ? '' : 's') + ' to ' + d.countdown.label : '');
      a.setAttribute('aria-label', a.title);
      a.innerHTML = '<span class="ml-chip-l">My list</span><b>' + d.today.done + '/' + d.today.of + '</b>' + (n != null && n >= 0 ? '<span class="' + (hot ? 'hot' : '') + '">' + n + 'd</span>' : '');
      a.addEventListener('click', function (ev) {
        if (window.Wren && typeof Wren.navigate === 'function') { ev.preventDefault(); Wren.navigate('cockpit', 'mylist'); }
      });
      el.innerHTML = ''; el.appendChild(a);
      return d;
    }).catch(function () { el.innerHTML = ''; return null; });
  }

  window.WrenMyList = { mount: mount, chip: chip, API: API };
})();
