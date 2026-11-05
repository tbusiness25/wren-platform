'use strict';
/* ===========================================================================
 * wren-leave-card.js — b522 (2026-10-20)
 *
 * ONE allowance card, rendered the same way everywhere it appears: the Roost
 * leave dashboard, the Roost person page, HR (a practitioner's own), and EY
 * My Day. There is no second copy — if the figures are laid out wrongly they
 * are laid out wrongly in one file.
 *
 * It also owns the ABSENCE-TYPE COLOURS, for the same reason: a calendar whose
 * holiday blue is not the holiday blue on the card beside it is worse than no
 * colour at all. Every one is a --c-* token, per LADN-DESIGN-GUIDELINES.md —
 * there is no hex in this file, and the theme picks each hue per palette so all
 * four palettes (Wren dark, Wren light, high-contrast dark, high-contrast
 * light) stay legible without this file knowing which is active.
 *
 * LAYOUT
 * ------
 * The shape follows the conventions Toby is used to after years in BrightHR —
 * a percentage-remaining meter, the four figures (allowance / taken / booked /
 * remaining) on one row, and how much of the leave year is left — because the
 * point of this build is that he does not have to relearn where to look. It is
 * built in Wren's own design system from Wren's own tokens; no BrightHR asset,
 * string or styling is used or reproduced.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * Print a number it was not given. When `balance.set` is false the card shows
 * the reason in words and no figures at all. A dash is honest; a zero is not.
 *
 * API
 * ---
 *   WrenLeaveCard.render(el, card, opts)   card = GET /api/leave/allowance/...
 *     opts.compact   one tight row, for a list
 *     opts.href      make the whole card a link (the dashboard → person page)
 *     opts.showDays  print the hours-to-days line (default true)
 *   WrenLeaveCard.TYPES          absence-type -> {label, token}
 *   WrenLeaveCard.typeStyle(t)   CSS for a chip/bar of that type
 *   WrenLeaveCard.hours(n)       '37.5 h', or an em dash for null
 *   WrenLeaveCard.legend(types)  an HTML legend
 *   WrenLeaveCard.renderLedger(el, ledger, opts)
 * ===========================================================================*/
(function (w) {
  // ── Absence-type colours. One definition, every surface. ──────────────────
  // Deliberately the SEMANTIC tokens rather than --c-cat-1..8: these are not
  // chart series, they are kinds of day, and a reader should be able to guess
  // which is the one that costs them money (danger) without the legend.
  var TYPES = {
    holiday:      { label: 'Holiday',       token: '--c-blue' },
    bank_holiday: { label: 'Bank holiday',  token: '--c-purple' },
    closure:      { label: 'Closure',       token: '--c-info' },
    sick:         { label: 'Sickness',      token: '--c-danger' },
    toil:         { label: 'TOIL',          token: '--c-orange' },
    unpaid:       { label: 'Unpaid',        token: '--c-muted' },
    adjustment:   { label: 'Adjustment',    token: '--c-ok' },
    accrual:      { label: 'Accrued',       token: '--c-ok' },
    other:        { label: 'Other',         token: '--c-muted' },
  };

  /** Normalise the many spellings the two absence tables use into one key. */
  function typeKey(t) {
    var s = String(t || '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
    if (!s) return 'other';
    if (/^annual leave$|^holiday$|^hol$/.test(s)) return 'holiday';
    if (/bank holiday|public holiday/.test(s)) return 'bank_holiday';
    if (/closure|shutdown/.test(s)) return 'closure';
    if (/^sick|sickness|illness|medical/.test(s)) return 'sick';
    if (/lieu|toil|time off in lieu/.test(s)) return 'toil';
    if (/unpaid/.test(s)) return 'unpaid';
    if (/^adjust/.test(s)) return 'adjustment';
    if (/^accrual$|accrued/.test(s)) return 'accrual';
    return TYPES[s.replace(/ /g, '_')] ? s.replace(/ /g, '_') : 'other';
  }

  function typeOf(t) { return TYPES[typeKey(t)] || TYPES.other; }

  /** A soft fill + readable ink for a chip or a calendar cell of this type. */
  function typeStyle(t) {
    var v = typeOf(t).token;
    return 'background:color-mix(in srgb, var(' + v + ') 20%, transparent);'
         + 'border:1px solid color-mix(in srgb, var(' + v + ') 55%, transparent);'
         + 'color:var(--c-text);';
  }
  /** A solid bar of this type, for a stacked meter. */
  function typeBar(t) { return 'background:var(' + typeOf(t).token + ');'; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; });
  }
  var DASH = '—';
  function hours(n) {
    if (n == null || !isFinite(n)) return DASH;
    var v = Math.round(Number(n) * 100) / 100;
    return (v % 1 === 0 ? v.toFixed(0) : String(v)) + ' h';
  }
  function days(n) {
    if (n == null || !isFinite(n)) return null;
    var v = Math.round(Number(n) * 100) / 100;
    return (v % 1 === 0 ? v.toFixed(0) : String(v)) + (Math.abs(v) === 1 ? ' day' : ' days');
  }

  /** How much of the leave year is left, in the words BrightHR users expect. */
  function yearLeft(year) {
    if (!year || !year.yearEnd) return null;
    var end = new Date(year.yearEnd + 'T00:00:00Z');
    var now = new Date();
    var ms = end - now;
    if (ms <= 0) return 'this leave year has ended';
    var d = Math.ceil(ms / 86400000);
    if (d <= 31) return d + (d === 1 ? ' day' : ' days') + ' of the leave year left';
    var m = Math.round(d / 30.44);
    return m + (m === 1 ? ' month' : ' months') + ' of the leave year left';
  }

  function legend(keys) {
    var ks = keys && keys.length ? keys : ['holiday', 'bank_holiday', 'closure', 'sick', 'toil'];
    return '<div class="wlc-legend">' + ks.map(function (k) {
      var t = typeOf(k);
      return '<span class="wlc-leg"><i style="' + typeBar(k) + '"></i>' + esc(t.label) + '</span>';
    }).join('') + '</div>';
  }

  // ── The card ─────────────────────────────────────────────────────────────
  function render(el, card, opts) {
    opts = opts || {};
    if (!el) return;
    if (!card) { el.innerHTML = '<div class="wlc-empty">No leave record.</div>'; return; }

    var b = card.balance || {};
    var a = card.allowance || {};
    var p = card.pattern || {};
    var inDays = card.in_days || {};
    var name = card.staff_name || 'This person';
    var tag = opts.href ? 'a' : 'div';
    var attrs = opts.href ? ' href="' + esc(opts.href) + '"' : '';

    // ── Not set: the reason, and nothing that could be mistaken for a figure ─
    if (!b.set) {
      el.innerHTML =
        '<' + tag + attrs + ' class="wlc wlc-notset' + (opts.compact ? ' wlc-compact' : '') + '">'
        + '<div class="wlc-top"><div class="wlc-name">' + esc(name) + '</div>'
        + (card.role ? '<div class="wlc-role">' + esc(card.role) + '</div>' : '') + '</div>'
        + '<div class="wlc-reason">' + esc(b.notSetReason || a.notSetReason || 'No allowance set.') + '</div>'
        + (p.note ? '<div class="wlc-sub">' + esc(p.note) + '</div>' : '')
        + '</' + tag + '>';
      return;
    }

    var pct = b.percentRemaining == null ? null : Math.max(0, Math.min(100, b.percentRemaining));
    // The meter runs out as the year does: green while there is plenty, amber
    // under a quarter, red under a tenth. It is a prompt to BOOK leave, not a
    // warning — most of these people under-take rather than over-take.
    var meterTok = pct == null ? '--c-muted' : (pct <= 10 ? '--c-danger' : (pct <= 25 ? '--c-warn' : '--c-ok'));

    var figs = [
      { k: 'Allowance', v: b.totalAvailableHours, d: inDays.allowance,
        t: 'What this person is entitled to this leave year, bank holidays included.' },
      { k: 'Taken',     v: b.takenHours,  d: inDays.taken,
        t: 'Already happened: holiday, bank holidays and closures up to today.' },
      { k: 'Booked',    v: b.bookedHours, d: inDays.booked,
        t: 'Approved and still to come.' },
      { k: 'Remaining', v: b.remainingHours, d: inDays.remaining, strong: true,
        t: 'Allowance less everything taken and booked.' },
    ];

    var parts = [];
    if (b.holidayHours)     parts.push({ k: 'holiday',      v: b.holidayHours });
    if (b.bankHolidayHours) parts.push({ k: 'bank_holiday', v: b.bankHolidayHours });
    if (b.closureHours)     parts.push({ k: 'closure',      v: b.closureHours });

    var html = '<' + tag + attrs + ' class="wlc' + (opts.compact ? ' wlc-compact' : '') + '">';
    html += '<div class="wlc-top">'
          + '<div class="wlc-name">' + esc(name) + '</div>'
          + (card.role ? '<div class="wlc-role">' + esc(card.role) + '</div>' : '')
          + (a.accrualMode === 'irregular_1207'
              ? '<span class="wlc-flag" title="This person accrues 12.07% of the hours they actually work, rather than a fixed yearly figure.">12.07% accrual</span>' : '')
          + (card.manual_override
              ? '<span class="wlc-flag" title="A manager set this figure by hand. The calculation is still shown in the workings.">Set by hand</span>' : '')
          + (card.opening_balance
              ? '<span class="wlc-flag" title="An opening balance was imported for the switch from BrightHR.">Opening balance</span>' : '')
          + '</div>';

    // The meter.
    html += '<div class="wlc-meter" role="img" aria-label="'
          + (pct == null ? 'Remaining not known' : pct + '% of the allowance remaining') + '">'
          + '<i style="width:' + (pct == null ? 0 : pct) + '%;background:var(' + meterTok + ');"></i></div>'
          + '<div class="wlc-meterlbl">'
          + (pct == null ? DASH : pct + '% left')
          + (yearLeft(card.year) ? '<span>' + esc(yearLeft(card.year)) + '</span>' : '')
          + '</div>';

    // The four figures.
    html += '<div class="wlc-figs">' + figs.map(function (f) {
      return '<div class="wlc-fig' + (f.strong ? ' wlc-fig-strong' : '') + '" title="' + esc(f.t) + '">'
           + '<b>' + hours(f.v) + '</b>'
           + (opts.showDays === false || f.d == null ? '' : '<em>' + esc(days(f.d)) + '</em>')
           + '<span>' + esc(f.k) + '</span></div>';
    }).join('') + '</div>';

    // What the allowance went on, and anything still waiting for a decision.
    if (parts.length || b.pendingHours || b.adjustmentHours) {
      html += '<div class="wlc-parts">';
      html += parts.map(function (x) {
        return '<span class="wlc-chip" style="' + typeStyle(x.k) + '">'
             + esc(typeOf(x.k).label) + ' ' + hours(x.v) + '</span>';
      }).join('');
      if (b.adjustmentHours) {
        html += '<span class="wlc-chip" style="' + typeStyle('adjustment') + '">Adjustments '
             + (b.adjustmentHours > 0 ? '+' : '') + hours(b.adjustmentHours) + '</span>';
      }
      if (b.pendingHours) {
        html += '<span class="wlc-chip wlc-chip-pending" title="Requested, not yet decided. Not taken off the remaining figure until it is approved.">'
             + hours(b.pendingHours) + ' awaiting a decision</span>';
      }
      html += '</div>';
    }

    if (!opts.compact) {
      html += '<div class="wlc-sub">'
            + esc(p.weekly_hours ? p.weekly_hours + ' h a week over ' + p.days_per_week
                  + (p.days_per_week === 1 ? ' day' : ' days') : 'Working pattern not set')
            + (a.contractWeeks ? ' · ' + a.contractWeeks + ' weeks’ leave, bank holidays included' : '')
            + (card.year ? ' · ' + esc(card.year.label) : '')
            + '</div>';
      if (!p.has_times) {
        html += '<div class="wlc-warn">This pattern records which days are worked but not the hours, '
              + 'so bank holidays cannot be costed. Set the times on the working pattern.</div>';
      }
    }
    html += '</' + tag + '>';
    el.innerHTML = html;
  }

  // ── The ledger ───────────────────────────────────────────────────────────
  /**
   * Every movement, newest-last, with the reason beside each. A VOIDED line is
   * struck through and kept — the point of a ledger is that nothing disappears
   * from it, so a deduction that stopped applying still shows that it once did.
   */
  function renderLedger(el, ledger, opts) {
    opts = opts || {};
    if (!el) return;
    var rows = (ledger || []).slice();
    if (opts.kind) rows = rows.filter(function (r) { return r.kind === opts.kind; });
    // Voided rows are ALWAYS shown, struck through. A ledger from which lines
    // vanish is not a ledger, and "why is this 7 hours different from last
    // week" has to be answerable from the page.
    if (!rows.length) {
      el.innerHTML = '<div class="wlc-empty">Nothing has come off this allowance yet.</div>';
      return;
    }
    el.innerHTML = '<table class="wlc-ledger"><thead><tr>'
      + '<th>Date</th><th>What</th><th class="wlc-num">Hours</th><th>Why</th><th></th>'
      + '</tr></thead><tbody>'
      + rows.map(function (r) {
        var t = typeOf(r.kind);
        var h = Number(r.hours) || 0;
        return '<tr class="' + (r.is_void ? 'wlc-void' : '') + '" data-ledger-id="' + esc(r.id) + '"'
             + ' data-kind="' + esc(r.kind) + '">'
          + '<td class="wlc-date">' + esc(r.entry_date || DASH)
            + (r.end_date && r.end_date !== r.entry_date ? ' → ' + esc(r.end_date) : '') + '</td>'
          + '<td><span class="wlc-chip" style="' + typeStyle(r.kind) + '">' + esc(t.label) + '</span>'
            + (r.label && r.label !== t.label ? ' <span class="wlc-lbl">' + esc(r.label) + '</span>' : '')
            + (r.status === 'pending' ? ' <span class="wlc-chip wlc-chip-pending">awaiting a decision</span>' : '')
            + (r.estimated ? ' <span class="wlc-chip wlc-chip-est" title="No hours were recorded on this booking, so it was costed from the working pattern.">estimated</span>' : '')
            + '</td>'
          + '<td class="wlc-num ' + (h > 0 ? 'wlc-credit' : 'wlc-debit') + '">'
            + (h > 0 ? '+' : '−') + hours(Math.abs(h)) + '</td>'
          + '<td class="wlc-why">' + esc(r.is_void ? (r.void_reason || 'No longer applies') : (r.detail || '')) + '</td>'
          + '<td class="wlc-act">'
            // Only a STORED row can be exempted, and a stored row is the one
            // with a plain numeric id. A derived holiday line's id is
            // 'absence_requests:12' — it belongs to the booking, so it is
            // changed by changing the booking, not by a button here.
            + (opts.canEdit && /^\d+$/.test(String(r.id))
                ? '<button type="button" class="wlc-btn" data-act="' + (r.is_void ? 'unvoid' : 'void') + '"'
                  + ' data-id="' + esc(r.id) + '">' + (r.is_void ? 'Reinstate' : 'Exempt') + '</button>'
                : '')
            + '</td>'
          + '</tr>';
      }).join('')
      + '</tbody></table>';
  }

  // ── The workings ─────────────────────────────────────────────────────────
  /** The ordered steps that produced the figure. The reason this is worth a
   *  component: it is the answer to "why is my balance that", and it must read
   *  identically wherever the question is asked. */
  function renderWorkings(el, workings) {
    if (!el) return;
    var w = workings || [];
    if (!w.length) { el.innerHTML = '<div class="wlc-empty">No workings.</div>'; return; }
    el.innerHTML = '<ol class="wlc-work">' + w.map(function (s) {
      return '<li><div class="wlc-work-l">' + esc(s.label) + '</div>'
           + '<div class="wlc-work-d">' + esc(s.detail || '') + '</div>'
           + '<div class="wlc-work-v">' + esc(s.value == null ? '' : s.value) + '</div></li>';
    }).join('') + '</ol>';
  }

  // ── The one stylesheet, injected once ────────────────────────────────────
  // Every colour is a token or a color-mix() of one. Nothing here is a hex.
  var CSS = ''
  + '.wlc{display:block;background:var(--c-surface);border:1px solid var(--c-border);border-radius:14px;'
  +   'padding:16px;color:var(--c-text);text-decoration:none;transition:border-color .15s ease;}'
  + 'a.wlc:hover,a.wlc:focus-visible{border-color:var(--c-blue);outline:none;}'
  + '.wlc-compact{padding:12px 14px;border-radius:12px;}'
  + '.wlc-notset{border-style:dashed;border-color:color-mix(in srgb, var(--c-warn) 55%, transparent);}'
  + '.wlc-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;}'
  + '.wlc-name{font-weight:700;font-size:1rem;flex:1;min-width:120px;}'
  + '.wlc-role{font-size:11px;color:var(--c-muted);text-transform:capitalize;}'
  + '.wlc-flag{font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;'
  +   'background:color-mix(in srgb, var(--c-info) 18%, transparent);color:var(--c-text);'
  +   'border:1px solid color-mix(in srgb, var(--c-info) 45%, transparent);}'
  + '.wlc-meter{height:8px;border-radius:999px;overflow:hidden;'
  +   'background:color-mix(in srgb, var(--c-text) 10%, transparent);}'
  + '.wlc-meter>i{display:block;height:100%;border-radius:999px;transition:width .25s ease;}'
  + '.wlc-meterlbl{display:flex;justify-content:space-between;gap:10px;margin:6px 0 12px;'
  +   'font-size:11px;font-weight:700;color:var(--c-muted);}'
  + '.wlc-meterlbl>span{font-weight:500;}'
  + '.wlc-figs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;}'
  + '.wlc-fig{text-align:center;padding:8px 4px;border-radius:10px;background:var(--c-surface-2);}'
  + '.wlc-fig b{display:block;font-size:1.1rem;font-weight:800;line-height:1.1;}'
  + '.wlc-fig em{display:block;font-size:10px;color:var(--c-muted);font-style:normal;margin-top:1px;}'
  + '.wlc-fig span{display:block;font-size:9px;text-transform:uppercase;letter-spacing:.05em;'
  +   'color:var(--c-muted);font-weight:700;margin-top:3px;}'
  + '.wlc-fig-strong{background:color-mix(in srgb, var(--c-blue) 14%, var(--c-surface-2));}'
  + '.wlc-fig-strong b{color:var(--c-blue);}'
  + '.wlc-parts{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;}'
  + '.wlc-chip{display:inline-block;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;'
  +   'background:color-mix(in srgb, var(--c-muted) 18%, transparent);color:var(--c-text);'
  +   'border:1px solid color-mix(in srgb, var(--c-muted) 40%, transparent);white-space:nowrap;}'
  + '.wlc-chip-pending{background:color-mix(in srgb, var(--c-warn) 20%, transparent);'
  +   'border-color:color-mix(in srgb, var(--c-warn) 55%, transparent);}'
  + '.wlc-chip-est{background:color-mix(in srgb, var(--c-muted) 14%, transparent);font-weight:500;}'
  + '.wlc-sub{font-size:11px;color:var(--c-muted);margin-top:10px;}'
  + '.wlc-reason{font-size:.9rem;color:var(--c-warn);font-weight:600;}'
  + '.wlc-warn{font-size:11px;color:var(--c-warn);margin-top:8px;}'
  + '.wlc-empty{color:var(--c-muted);font-size:13px;padding:18px;text-align:center;}'
  + '.wlc-legend{display:flex;flex-wrap:wrap;gap:12px;font-size:11px;color:var(--c-muted);}'
  + '.wlc-leg{display:inline-flex;align-items:center;gap:5px;}'
  + '.wlc-leg>i{width:11px;height:11px;border-radius:3px;display:inline-block;}'
  + '.wlc-ledger{width:100%;border-collapse:collapse;font-size:12px;}'
  + '.wlc-ledger th{text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.05em;'
  +   'color:var(--c-muted);padding:6px 8px;border-bottom:1px solid var(--c-border);}'
  + '.wlc-ledger td{padding:7px 8px;border-bottom:1px solid var(--c-border);vertical-align:top;}'
  + '.wlc-ledger tr:last-child td{border-bottom:none;}'
  + '.wlc-ledger .wlc-num{text-align:right;font-variant-numeric:tabular-nums;font-weight:700;white-space:nowrap;}'
  + '.wlc-credit{color:var(--c-ok);} .wlc-debit{color:var(--c-text);}'
  + '.wlc-date{white-space:nowrap;color:var(--c-muted);font-variant-numeric:tabular-nums;}'
  + '.wlc-why{color:var(--c-muted);}'
  + '.wlc-lbl{font-weight:600;}'
  + '.wlc-void{opacity:.55;} .wlc-void .wlc-num,.wlc-void .wlc-lbl{text-decoration:line-through;}'
  + '.wlc-btn{background:var(--c-surface-2);border:1px solid var(--c-border-strong);color:var(--c-text);'
  +   'border-radius:8px;padding:4px 9px;font-size:11px;font-family:inherit;cursor:pointer;white-space:nowrap;}'
  + '.wlc-btn:hover{border-color:var(--c-blue);}'
  + '.wlc-work{list-style:none;margin:0;padding:0;}'
  + '.wlc-work>li{display:grid;grid-template-columns:1fr auto;gap:2px 14px;padding:9px 0;'
  +   'border-bottom:1px solid var(--c-border);}'
  + '.wlc-work>li:last-child{border-bottom:none;}'
  + '.wlc-work-l{font-weight:700;font-size:12px;}'
  + '.wlc-work-d{font-size:11px;color:var(--c-muted);grid-column:1;}'
  + '.wlc-work-v{grid-row:1 / span 2;grid-column:2;align-self:center;font-weight:800;font-size:13px;'
  +   'white-space:nowrap;font-variant-numeric:tabular-nums;}'
  + '@media(max-width:560px){.wlc-figs{grid-template-columns:repeat(2,minmax(0,1fr));}'
  +   '.wlc-ledger .wlc-why{display:none;}}';

  function inject() {
    if (document.getElementById('wlc-css')) return;
    var st = document.createElement('style');
    st.id = 'wlc-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  if (document.head) inject();
  else document.addEventListener('DOMContentLoaded', inject);

  w.WrenLeaveCard = {
    render: render, renderLedger: renderLedger, renderWorkings: renderWorkings,
    TYPES: TYPES, typeKey: typeKey, typeOf: typeOf, typeStyle: typeStyle, typeBar: typeBar,
    hours: hours, days: days, legend: legend, yearLeft: yearLeft, esc: esc, inject: inject,
  };
})(window);
