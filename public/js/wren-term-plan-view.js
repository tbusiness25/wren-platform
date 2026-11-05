/* wren-term-plan-view.js — b302 (2026-09-10)
 *
 * The half-term plan, read-only, laid out the way the parents app lays it out.
 *
 * Toby, 2026-09-10: "I want the exact planning I uploaded put on there — the
 * intentions, the activities, everything. Just like how it is on the parents
 * app. I want it like that for Autumn 1 on EY and admin."
 *
 * The parents surfaces show a plan as four cards — Learning Intentions, Books,
 * Songs & Rhymes, Special Events — and then the activities. Roost and EY showed
 * the same plan as a bank of editing controls, and the section that should have
 * held five imported intentions was empty because those two screens read the
 * wrong column. The reading is fixed in src/lib/term-plan-view.js; this file is
 * the other half: the same content, presented the same way, on both staff
 * screens, above the controls that edit it.
 *
 * ── WHY A SHARED RENDERER AND NOT TWO ───────────────────────────────────────
 * Because three portals each rendering a plan their own way is the defect this
 * build exists to close, and doing it again in the presentation layer would just
 * move the drift somewhere harder to spot. One function, both screens.
 *
 * ── THEME ───────────────────────────────────────────────────────────────────
 * var(--c-*) only, with fallbacks for the older Roost pages that predate some of
 * the tokens. Roost is light, EY is dark, and both are checked.
 *
 * Usage:
 *   WrenTermPlanView.render('#mount', view, { editable:false, note:'…' });
 * where `view` is the object GET /api/planning/termly/plan returns as `.view`.
 */
(function (w) {
  'use strict';

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function niceDate(ymd) {
    if (!ymd) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd));
    if (!m) return String(ymd);
    return parseInt(m[3], 10) + ' ' + MON[parseInt(m[2], 10) - 1] + ' ' + m[1];
  }
  function dateRange(a, b) {
    if (!a && !b) return '';
    if (a && b) return niceDate(a) + ' – ' + niceDate(b);
    return niceDate(a || b);
  }

  /* The b276 import writes descriptions as "Art & Design · Autumn 1 weeks 1-2 —
     <the actual idea>". The prefix repeats the heading the card already sits
     under, so it is trimmed off for display. The stored row is not touched. */
  function activityBody(a) {
    var d = String(a.description || '').trim();
    if (!d) return '';
    var i = d.indexOf(' — ');
    if (i > 0 && i < 80) d = d.slice(i + 3);
    if (d.toLowerCase() === String(a.title || '').toLowerCase() + '.') return '';
    return d;
  }

  function css() {
    return [
      /* --tpv-dim is the secondary-text colour for this panel, and it is NOT a
         plain --c-muted. wren-theme.js derives --c-muted from the chosen text
         and background, and on the "High contrast" light preset that lands at
         4.00:1 — under WCAG AA, measured, on the note and every "none yet" line.
         Pulling it partway back toward --c-text fixes it in BOTH directions at
         once: darker against a light background, lighter against a dark one,
         from one declaration. scripts/b302-render-probe.js measures it. */
      '.tpv{border:1px solid var(--c-border,#2d3748);border-radius:14px;',
      '--tpv-dim:color-mix(in srgb,var(--c-muted,#94a3b8) 55%,var(--c-text,#e2e8f0));',
      'background:var(--c-surface,#1e293b);padding:16px 16px 4px;margin:0 0 16px}',
      '.tpv-h{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin:0 0 4px}',
      '.tpv-h h2{margin:0;font-size:1.15rem;color:var(--c-text,#f1f5f9);font-weight:700}',
      '.tpv-meta{font-size:.8rem;color:var(--tpv-dim,#94a3b8)}',
      '.tpv-note{font-size:.82rem;color:var(--tpv-dim,#94a3b8);line-height:1.55;margin:6px 0 14px}',
      '.tpv-tag{display:inline-block;font-size:.68rem;font-weight:700;letter-spacing:.05em;',
      'text-transform:uppercase;border-radius:999px;padding:2px 9px;border:1px solid var(--c-border,#2d3748);',
      'color:var(--tpv-dim,#94a3b8)}',
      '.tpv-tag.live{color:var(--c-green,#4ea87a);border-color:var(--c-green,#4ea87a);',
      'background:color-mix(in srgb,var(--c-green,#4ea87a) 12%,transparent)}',
      '.tpv-tag.draft{color:var(--c-amber,#d99a2b);border-color:var(--c-amber,#d99a2b);',
      'background:color-mix(in srgb,var(--c-amber,#d99a2b) 12%,transparent)}',
      '.tpv-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:0 0 16px}',
      '@media(max-width:640px){.tpv-grid{grid-template-columns:1fr}}',
      /* A card must read as a card in EVERY theme. wren-theme.js sets --c-card
         and --c-surface to the SAME value, so painting the card with --c-card
         over a --c-surface panel gives two identical rectangles the moment
         anyone picks a preset. Mixing a little of the TEXT colour into the
         surface instead lifts the card on a dark theme and deepens it on a
         light one, from the same one declaration. */
      '.tpv-card{background:color-mix(in srgb,var(--c-text,#e2e8f0) 5%,var(--c-surface,#1e293b));',
      'border:1px solid var(--c-border,#2d3748);',
      'border-radius:12px;padding:13px 15px}',
      '.tpv-card.wide{grid-column:1/-1}',
      '.tpv-card h3{margin:0 0 8px;font-size:.72rem;font-weight:800;letter-spacing:.07em;',
      'text-transform:uppercase;color:var(--c-blue,#4a9abf)}',
      '.tpv-card ul{margin:0;padding-left:18px}',
      '.tpv-card li{font-size:.87rem;line-height:1.6;color:var(--c-text,#e2e8f0);margin-bottom:3px}',
      '.tpv-empty{font-size:.84rem;color:var(--tpv-dim,#94a3b8);font-style:italic;line-height:1.55}',
      '.tpv-ev{width:100%;border-collapse:collapse;font-size:.85rem}',
      '.tpv-ev td{padding:6px 10px;border-bottom:1px solid var(--c-border,#2d3748);color:var(--c-text,#e2e8f0)}',
      '.tpv-ev tr:last-child td{border-bottom:none}',
      '.tpv-ev td.d{white-space:nowrap;color:var(--tpv-dim,#94a3b8);width:1%}',
      '.tpv-wk{margin:0 0 14px}',
      '.tpv-wk-h{font-size:.78rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;',
      'color:var(--tpv-dim,#94a3b8);margin:0 0 8px}',
      '.tpv-acts{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
      '@media(max-width:640px){.tpv-acts{grid-template-columns:1fr}}',
      '.tpv-act{background:color-mix(in srgb,var(--c-text,#e2e8f0) 5%,var(--c-surface,#1e293b));',
      'border:1px solid var(--c-border,#2d3748);',
      'border-radius:10px;padding:11px 13px}',
      '.tpv-act .t{font-weight:700;font-size:.9rem;color:var(--c-text,#f1f5f9);line-height:1.4}',
      '.tpv-act .c{font-size:.68rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;',
      'color:var(--c-blue,#4a9abf);margin-bottom:3px}',
      '.tpv-act .b{font-size:.84rem;color:var(--tpv-dim,#94a3b8);line-height:1.55;margin-top:5px}',
      '.tpv-act .a{margin-top:6px}',
      '.tpv-area{display:inline-block;font-size:.7rem;border-radius:6px;padding:1px 7px;margin:3px 4px 0 0;',
      'background:color-mix(in srgb,var(--c-blue,#4a9abf) 14%,transparent);color:var(--c-blue,#4a9abf)}',
      '.tpv-day{border-left:3px solid var(--c-blue,#4a9abf);padding:2px 0 2px 11px;margin-bottom:9px}',
      '.tpv-day .dn{font-size:.7rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;',
      'color:var(--tpv-dim,#94a3b8)}',
      '.tpv-day .dt{font-size:.88rem;font-weight:600;color:var(--c-text,#f1f5f9);line-height:1.45}',
      '.tpv-day .da{font-size:.82rem;color:var(--tpv-dim,#94a3b8);line-height:1.5;margin-top:3px}',
      '.tpv-toggle{background:none;border:none;color:var(--c-blue,#4a9abf);font:inherit;font-size:.82rem;',
      'font-weight:600;cursor:pointer;padding:6px 0;min-height:40px}',
      /* ── b521: the planning SHEET, in the format Kat wrote ────────────────
         Toby, 2026-10-20: "it doesn't look like the most recent pre-school
         planning I gave you from Kat ... I wanted it in that exact format. It
         was quite pretty, A4, with light autumn colours."

         The five hues are MEASURED off that sheet (/app/uploads/
         PS yearly.pdf, the Autumn 2 and Spring 2 card pages) — green
         rgb(125,172,80), peach rgb(225,172,131), slate rgb(192,205,214), sand
         rgb(211,204,144), teal rgb(134,177,186). They are the document's own
         identity, like a brand colour, so they are declared here as tokens of
         their own rather than taken from --c-*, which carries Wren's palette
         and not Kat's. Everything derived from them — the card body, the rule
         between rows — is a color-mix against --c-surface, so the same five
         hues sit correctly on light Roost AND dark EY without a second set.
         The band keeps dark ink in both themes: these are pale autumn pastels,
         and a printed sheet is what it is meant to look like. */
      '.tpv-sheet{--k1:#e1ac83;--k2:#7dac50;--k3:#d3cc90;--k4:#c0cdd6;--k5:#86b1ba;',
      '--k-ink:#1f2a24;margin:0 0 16px}',
      '.tpv-sheet .kcard{border:1px solid var(--c-border,#2d3748);border-radius:10px;overflow:hidden;',
      'margin:0 0 10px;background:color-mix(in srgb,var(--kc) 16%,var(--c-surface,#1e293b))}',
      '.tpv-sheet .kcard-h{background:var(--kc);color:var(--k-ink);font-weight:700;font-size:.95rem;',
      'line-height:1.35;padding:7px 13px}',
      '.tpv-sheet .krow{font-size:.85rem;line-height:1.55;color:var(--c-text,#e2e8f0);padding:6px 13px;',
      'border-top:1px solid color-mix(in srgb,var(--c-surface,#1e293b) 55%,transparent)}',
      '.tpv-sheet .krow:first-of-type{border-top:none}',
      /* The label is a dark version of the card hue: mixing the hue with the
         TEXT colour keeps it readable on a light and a dark theme alike. */
      '.tpv-sheet .krow b{color:color-mix(in srgb,var(--kc) 45%,var(--c-text,#e2e8f0));font-weight:800}',
      '.tpv-sheet .kc1{--kc:var(--k1)}.tpv-sheet .kc2{--kc:var(--k2)}.tpv-sheet .kc3{--kc:var(--k3)}',
      '.tpv-sheet .kc4{--kc:var(--k4)}.tpv-sheet .kc5{--kc:var(--k5)}',
      '@media print{.tpv-sheet{break-inside:auto}.tpv-sheet .kcard{break-inside:avoid}}'
    ].join('');
  }

  function ensureCss() {
    if (document.getElementById('tpv-css')) return;
    var st = document.createElement('style');
    st.id = 'tpv-css';
    st.textContent = css();
    document.head.appendChild(st);
  }

  function listCard(title, items, emptyText, wide) {
    var body = (items && items.length)
      ? '<ul>' + items.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul>'
      : '<div class="tpv-empty">' + esc(emptyText) + '</div>';
    return '<div class="tpv-card' + (wide ? ' wide' : '') + '"><h3>' + esc(title) + '</h3>' + body + '</div>';
  }

  function eventsCard(events) {
    if (!events || !events.length) {
      return '<div class="tpv-card wide"><h3>Special events</h3>' +
        '<div class="tpv-empty">No events from the setting calendar are attached to this half-term.</div></div>';
    }
    return '<div class="tpv-card wide"><h3>Special events</h3><table class="tpv-ev"><tbody>' +
      events.map(function (e) {
        return '<tr><td class="d">' + esc(niceDate(e.date) || '—') + '</td><td>' + esc(e.title) +
          (e.location ? ' <span class="tpv-empty">· ' + esc(e.location) + '</span>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function actCard(a) {
    var body = activityBody(a);
    return '<div class="tpv-act">' +
      (a.category ? '<div class="c">' + esc(String(a.category).replace(/_/g, ' ')) + '</div>' : '') +
      '<div class="t">' + esc(a.title) + '</div>' +
      (body ? '<div class="b">' + esc(body) + '</div>' : '') +
      (a.eyfs_areas && a.eyfs_areas.length
        ? '<div class="a">' + a.eyfs_areas.map(function (x) {
            return '<span class="tpv-area">' + esc(x) + '</span>'; }).join('') + '</div>'
        : '') +
      '</div>';
  }

  function dayRow(d) {
    return '<div class="tpv-day">' +
      '<div class="dn">' + esc(d.weekday_name || '') + (d.category ? ' · ' + esc(d.category) : '') + '</div>' +
      '<div class="dt">' + esc(d.title || '—') + '</div>' +
      (d.role_of_adult ? '<div class="da"><b>Adult role:</b> ' + esc(d.role_of_adult) + '</div>' : '') +
      '</div>';
  }

  /* Bands, not weeks. The setting's yearly plan is written in two-week bands and
     b276 wrote the same four activities against both weeks of each; and the baby
     room's week-level activity_ids are the union of its own five day rows. Left
     alone, every activity printed two or three times, which is most of what
     "looks weird" meant. src/lib/term-plan-view.js collapses both — this renders
     what it hands back, and falls back to the raw weeks on an older response. */
  function weeksHtml(view) {
    var bands = view.bands;
    if (!bands) {
      bands = (view.weeks || []).filter(function (wk) {
        return (wk.activities && wk.activities.length) || (wk.days && wk.days.length);
      }).map(function (wk) {
        return { label: wk.label, week_nos: [wk.week_no], days: wk.days, activities: wk.activities };
      });
    }
    if (!bands.length) {
      return '<div class="tpv-empty" style="margin:0 0 14px">No activities have been planned into the weeks of '
        + 'this half-term yet — add them under the weeks step below.</div>';
    }
    return bands.map(function (b) {
      var inner = '';
      if (b.days && b.days.length) inner += b.days.map(dayRow).join('');
      if (b.activities && b.activities.length) {
        inner += '<div class="tpv-acts">' + b.activities.map(actCard).join('') + '</div>';
      }
      if (!inner) return '';
      return '<div class="tpv-wk"><div class="tpv-wk-h">' +
        esc(b.label || ('Week ' + (b.week_nos || []).join(', '))) + '</div>' + inner + '</div>';
    }).join('');
  }

  /**
   * @param {string|Element} mount
   * @param {object|null} view  the `.view` object from GET /termly/plan
   * @param {object} [opts]  { note: string }
   */
  /* ── b521: the planning sheet, in Kat's format ──────────────────────────────
   * One coloured card per activity, headed with its name, carrying Intent /
   * Implementation / Impact / Adult Role — the shape of the pre-school sheet
   * Toby wants the screen to match. The cards come from view.focus_activities,
   * resolved server-side by src/lib/term-plan-view.js focusSheet(), so this
   * renderer never has to know whether they were typed or read off the
   * provision grid. Five hues rotate, or a card may name its own.
   *
   * It lives in THIS file, not on a page, so Roost's termly planner and both EY
   * termly planners get it from the one place they already share. */
  var KAT_COLOURS = ['kc1', 'kc2', 'kc3', 'kc4', 'kc5'];
  var KAT_LINES = [
    ['intent', 'Intent:'], ['implementation', 'Implementation:'],
    ['impact', 'Impact:'], ['adult_role', 'Adult Role:']
  ];
  function sheetHtml(view) {
    var cards = (view && view.focus_activities) || [];
    if (!cards.length) return '';
    var body = cards.map(function (c, i) {
      var cls = (c.colour && KAT_COLOURS.indexOf('kc' + c.colour) >= 0)
        ? 'kc' + c.colour : KAT_COLOURS[i % KAT_COLOURS.length];
      var rows = KAT_LINES.map(function (pair) {
        var v = c[pair[0]];
        if (!v) return '';           // a labelled blank line reads as a gap in the plan
        return '<div class="krow"><b>' + esc(pair[1]) + '</b> ' + esc(v) + '</div>';
      }).join('');
      return '<div class="kcard ' + cls + '">' +
        '<div class="kcard-h">' + esc(c.title || ('Activity ' + (i + 1))) + '</div>' +
        rows + '</div>';
    }).join('');
    /* Say where the cards came from. A grid-derived card has only an
       Implementation line, and without this note that reads as a plan with three
       fields missing rather than three fields nobody has written yet. */
    var note = view.focus_source === 'grid'
      ? '<div class="tpv-empty" style="margin:2px 0 12px">Read straight from the continuous-provision ' +
        'grid, so the Implementation line is the room\u2019s own plan text. Intent, Impact and Adult Role ' +
        'are blank because nobody has written them yet.</div>'
      : '';
    return '<div class="tpv-wk-h">Our activities this half-term</div>' + note +
           '<div class="tpv-sheet">' + body + '</div>';
  }

  function render(mount, view, opts) {
    var el = (typeof mount === 'string') ? document.querySelector(mount) : mount;
    if (!el) return;
    ensureCss();
    opts = opts || {};

    if (!view || view.plan_id == null) {
      el.innerHTML = '<div class="tpv"><div class="tpv-h"><h2>The plan, as parents see it</h2></div>' +
        '<div class="tpv-note">Nothing is saved for this half-term and room yet. Fill in the theme, ' +
        'intentions, books and songs below and save — it starts as a draft, so nothing reaches parents ' +
        'until it is published.</div></div>';
      return;
    }

    var stateTag = view.status === 'published'
      ? '<span class="tpv-tag live">Published</span>'
      : (view.status ? '<span class="tpv-tag draft">Draft</span>' : '');

    var meta = [
      view.room_name,
      [view.term_name, view.academic_year].filter(Boolean).join(' '),
      dateRange(view.starts, view.ends)
    ].filter(Boolean).join(' · ');

    /* An imported plan's intentions are sentences the setting wrote, not ticked
       framework statements. Say which it is: it explains why the tick list below
       is empty on a half-term that plainly has intentions, which is exactly the
       thing that read as broken. */
    var intentNote = '';
    if (view.intentions_source === 'imported') {
      intentNote = 'These came from the plan the setting uploaded, so they are written as sentences ' +
        'rather than ticked framework statements — which is why the tick list below shows none picked. ' +
        'They are the intentions parents see.';
    } else if (view.intentions_source === 'picked') {
      intentNote = 'Ticked from the framework below.';
    }

    var body = '';
    if (view.unplanned) {
      body = '<div class="tpv-empty">This half-term is not in the setting\'s yearly plan yet — there is ' +
        'nothing here for parents to see. Fill it in below and save.</div>';
    } else {
      body =
        '<div class="tpv-grid">' +
          listCard('Learning intentions', view.intentions,
            'None recorded for this half-term yet.') +
          listCard('Key books', view.key_books,
            'No books listed — the paper planning this half-term came from did not name any.') +
          listCard('Songs & rhymes', view.songs,
            'No songs listed yet. Add the ones the room actually sings.') +
          listCard('Carry forward', view.carry_forward ? [view.carry_forward] : [],
            'Nothing carried forward from the last half-term.') +
          eventsCard(view.events) +
        '</div>' +
        sheetHtml(view) +
        '<div class="tpv-wk-h" style="margin-bottom:10px">Planned activities' +
          (view.activity_count ? ' · ' + view.activity_count + ' across the half-term' : '') + '</div>' +
        weeksHtml(view);
    }

    el.innerHTML =
      '<div class="tpv">' +
        '<div class="tpv-h"><h2>🌿 ' + esc(view.theme || 'No theme yet') + '</h2>' + stateTag + '</div>' +
        '<div class="tpv-meta">' + esc(meta) + '</div>' +
        '<div class="tpv-note">' +
          esc(opts.note || 'The whole of this half-term\'s plan, exactly as it reaches parents.') +
          (intentNote ? ' ' + esc(intentNote) : '') +
        '</div>' +
        body +
      '</div>';
  }

  w.WrenTermPlanView = { render: render, esc: esc, niceDate: niceDate, sheetHtml: sheetHtml };
})(window);
