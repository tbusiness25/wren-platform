/* Wren — the RANGE picker (b278, 2026-09-04)
 * ────────────────────────────────────────────────────────────────────────────
 * Toby, 2026-09-04:
 *   "when we are doing observations, we are tagging the statements from the 7
 *    areas, we are NOT TAGGING when we do, just the range for — the termly
 *    updates, progress reports, and 2 year checks. Same with birth25 matters.
 *    tagging statements in obs, and ranges in reports."
 *
 * So this component is what a TERMLY UPDATE, a PROGRESS REPORT and a 2-YEAR
 * CHECK offer. It never lists statements. Its counterpart — the statement
 * picker in the observation form — never lists ranges. One screen, one kind.
 *
 * The range vocabulary is fetched, never hard-coded: Birth to 5 Matters has six
 * numbered ranges, Fledge has five named bands, and a framework added later has
 * whatever its own statements say it has.
 *
 *   WrenRangePicker.mount(hostEl, {
 *     childId, framework, context,          // context ∈ termly_update |
 *                                           //   progress_report | two_year_check
 *     areas,                                // optional: restrict to these areas
 *                                           //   (a 2-year check = prime areas)
 *     onChange                              // fn(values) after every tap
 *   }) -> { values(), setValues(), save(opts), reload(), destroy() }
 *
 * ── b291 (2026-09-08): the range now carries HOW SECURE ────────────────────
 * Toby: "when we're tagging the ranges … we should also be tagging how secure
 * they are in that range." So each area that has a range chosen also offers
 * Emerging / Developing / Secure (WrenSecurity, public/js/wren-security-rating.js).
 *
 * It is still the RANGE being tagged, never a statement — b278's rule is
 * untouched. The security rating is OPTIONAL: choosing a range and no rating is
 * a legitimate, complete answer and saves as NULL, which reads everywhere as
 * "not yet rated". Nothing here ever defaults it to Emerging.
 *
 * ── b296 (2026-09-09): layout:'compact' ────────────────────────────────────
 * Toby: "all the tick lists for all the areas down below looks really long to do
 * — replace it with a free text box where they could type in, or ... make it
 * similar to the observations on the EY portal."
 *
 * The second one. A free-text box would lose the link to the framework that the
 * tracker, the reports and the planner all depend on; and staff already know the
 * observation statement picker, so a third interaction pattern would be one too
 * many. So `layout: 'compact'` borrows that picker's interaction exactly:
 *
 *   · what is chosen shows as CHIPS, one per area, and nothing else is on screen
 *   · "＋ Add an area" opens a SHEET with a SEARCH box over every area × range
 *   · picking one closes the sheet and adds the chip
 *   · a FREE-TEXT box sits alongside for anything the ranges do not carry
 *
 * Seven areas × six ranges (plus seven security rows) collapses to however many
 * areas the practitioner has actually judged — usually two or three.
 *
 * The default layout is unchanged, so the two-year check and the progress report
 * keep the grid they have today. Values, save(), setValues() and reload() are
 * identical in both: this is a layout, not a second data model.
 */
(function () {
  'use strict';

  var CONTEXTS = ['termly_update', 'progress_report', 'two_year_check'];

  var CSS = [
    '.wrp{display:flex;flex-direction:column;gap:10px}',
    '.wrp-note{font-size:.78rem;color:var(--c-muted);line-height:1.5}',
    '.wrp-row{background:var(--c-card);border:1px solid var(--c-border);border-radius:10px;padding:10px 12px}',
    '.wrp-head{display:flex;align-items:baseline;gap:8px;margin-bottom:8px;flex-wrap:wrap}',
    '.wrp-area{font-size:.86rem;font-weight:700;color:var(--c-text);flex:1;min-width:150px}',
    '.wrp-hint{font-size:.7rem;color:var(--c-muted)}',
    '.wrp-hint b{color:var(--c-orange);font-weight:700}',
    '.wrp-seg{display:flex;gap:6px;flex-wrap:wrap}',
    '.wrp-opt{min-height:40px;padding:6px 12px;border-radius:9px;border:1px solid var(--c-border);',
    '  background:transparent;color:var(--c-muted);font-size:.8rem;font-weight:600;cursor:pointer;',
    '  transition:border-color .15s,background .15s,color .15s;line-height:1.25;text-align:center}',
    '.wrp-opt:hover{border-color:var(--c-blue);color:var(--c-text)}',
    '.wrp-opt[aria-pressed="true"]{background:var(--c-blue);border-color:var(--c-blue);color:#fff}',
    '.wrp-opt .wrp-sub{display:block;font-size:.66rem;font-weight:500;opacity:.8}',
    '.wrp-opt.wrp-sug{border-color:var(--c-orange)}',
    '.wrp-clear{background:none;border:0;color:var(--c-muted);font-size:.72rem;cursor:pointer;padding:4px 2px;text-decoration:underline}',
    '.wrp-empty{padding:14px;font-size:.82rem;color:var(--c-muted);text-align:center}',
    '.wrp-legend{font-size:.72rem;color:var(--c-muted);display:flex;gap:12px;flex-wrap:wrap;align-items:center}',
    '.wrp-legend i{display:inline-block;width:9px;height:9px;border-radius:3px;border:1px solid var(--c-orange);margin-right:4px}',
    /* b291 — the security row, shown under the range once one is chosen. */
    '.wrp-sec{margin-top:9px;padding-top:9px;border-top:1px dashed var(--c-border);',
    '  display:flex;gap:10px;flex-wrap:wrap;align-items:center}',
    '.wrp-sec-label{font-size:.72rem;color:var(--c-muted);font-weight:600}',
    /* b296 — compact layout: chips + a search sheet, the same shape as the
       observation statement picker. Tokens only, so both themes work. */
    '.wrp-chips{display:flex;flex-direction:column;gap:8px}',
    '.wrp-chip{background:var(--c-card);border:1px solid var(--c-border);border-radius:11px;padding:10px 12px}',
    '.wrp-chip-top{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
    '.wrp-chip-area{font-size:.85rem;font-weight:700;color:var(--c-text);flex:1;min-width:120px}',
    '.wrp-chip-range{font-size:.76rem;font-weight:700;color:#fff;background:var(--c-blue);',
    '  border-radius:999px;padding:2px 9px}',
    '.wrp-chip-x{background:none;border:0;color:var(--c-red);font-size:1rem;cursor:pointer;',
    '  min-width:40px;min-height:40px;font-family:inherit}',
    '.wrp-add{min-height:44px;padding:0 14px;border-radius:11px;cursor:pointer;font-family:inherit;',
    '  background:transparent;border:1px dashed var(--c-border);color:var(--c-blue);',
    '  font-size:.85rem;font-weight:600;width:100%}',
    '.wrp-add:hover{border-color:var(--c-blue)}',
    '.wrp-none{padding:12px;font-size:.8rem;color:var(--c-muted);font-style:italic;text-align:center;',
    '  border:1px dashed var(--c-border);border-radius:11px}',
    '.wrp-notes{margin-top:12px;display:flex;flex-direction:column;gap:6px}',
    '.wrp-notes label{font-size:.78rem;font-weight:700;color:var(--c-muted)}',
    '.wrp-notes textarea{width:100%;box-sizing:border-box;min-height:74px;padding:10px 12px;',
    '  border:1px solid var(--c-border);border-radius:11px;background:var(--c-bg,var(--c-surface));',
    '  color:var(--c-text);font-family:inherit;font-size:.9rem;line-height:1.5}',
    '.wrp-sheet{position:fixed;inset:0;background:rgba(8,15,30,.75);z-index:1300;display:none;overflow-y:auto;padding:14px}',
    '.wrp-sheet.open{display:block}',
    '.wrp-sheet-inner{max-width:640px;margin:16px auto;background:var(--c-bg);border:1px solid var(--c-border);',
    '  border-radius:16px;padding:14px}',
    '.wrp-sheet-hd{display:flex;align-items:center;gap:10px;margin-bottom:10px}',
    '.wrp-sheet-hd h3{margin:0;font-size:1rem;color:var(--c-text);flex:1}',
    '.wrp-sheet input[type=search]{width:100%;box-sizing:border-box;min-height:44px;padding:10px 12px;',
    '  border:1px solid var(--c-border);border-radius:11px;background:var(--c-surface);color:var(--c-text);',
    '  font-family:inherit;font-size:.9rem;margin-bottom:10px}',
    '.wrp-hits{display:flex;flex-direction:column;gap:6px;max-height:56vh;overflow-y:auto}',
    '.wrp-grp{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;',
    '  color:var(--c-muted);padding:8px 2px 2px}',
    '.wrp-hit{text-align:left;padding:10px 12px;border-radius:11px;cursor:pointer;min-height:44px;',
    '  background:var(--c-surface);border:1px solid var(--c-border);color:var(--c-text);font-family:inherit}',
    '.wrp-hit:hover{border-color:var(--c-blue)}',
    '.wrp-hit.on{border-color:var(--c-blue);background:rgba(74,154,191,.12)}',
    '.wrp-hit.sug{border-color:var(--c-orange)}',
    '.wrp-hit .t{font-weight:600;font-size:.87rem}',
    '.wrp-hit .m{font-size:.72rem;color:var(--c-muted);margin-top:2px}'
  ].join('');

  function injectStyles() {
    if (document.getElementById('wren-range-picker-css')) return;
    var st = document.createElement('style');
    st.id = 'wren-range-picker-css';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  /* b291 — the three security terms live in one place. If the component has not
   * been loaded on the page, the picker still works and simply does not offer a
   * rating: a range with no rating is a complete, valid answer. */
  function sec() { return window.WrenSecurity || null; }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* Use the app's fetch wrapper when it is on the page (it carries the token and
   * unwraps errors); fall back to a cookie-credentialed fetch otherwise. */
  function api(path, opts) {
    if (window.Wren && typeof Wren.api === 'function') return Wren.api(path, opts);
    var init = { credentials: 'include', headers: { 'Content-Type': 'application/json' } };
    if (opts && opts.method) init.method = opts.method;
    if (opts && opts.body) init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    return fetch(path, init).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw j; return j; });
    });
  }

  function mount(host, opts) {
    opts = opts || {};
    if (!host) throw new Error('WrenRangePicker.mount: no host element');
    if (CONTEXTS.indexOf(opts.context) === -1) {
      throw new Error('WrenRangePicker: context must be one of ' + CONTEXTS.join(', ') +
                      ' — observations tag statements, not ranges');
    }
    injectStyles();

    var state = {
      childId: opts.childId, framework: opts.framework || 'birth_to_5_la',
      context: opts.context, restrict: opts.areas || null,
      // b296 — 'compact' is the chips + search-sheet layout; anything else is
      // the original grid, which the 2-year check and progress report still use.
      layout: opts.layout === 'compact' ? 'compact' : 'grid',
      notes: '', sheetOpen: false, sheetQ: '',
      mode: 'none', ranges: [], areas: [], chosen: {}, suggested: {}, loaded: false,
      // b291 — area -> 'emerging'|'developing'|'secure'. An area absent from
      // this map is NOT YET RATED, which is a different thing from Emerging.
      security: {}
    };

    function visibleAreas() {
      return state.restrict
        ? state.areas.filter(function (a) { return state.restrict.indexOf(a) > -1; })
        : state.areas;
    }
    function rangeByOrd(o) {
      return state.ranges.filter(function (r) { return r.ordinal === o; })[0] || null;
    }

    function render() {
      if (!state.loaded) { host.innerHTML = '<div class="wrp-empty">Loading ranges…</div>'; return; }
      if (!state.ranges.length || !state.areas.length) {
        host.innerHTML = '<div class="wrp-empty">This framework has no age bands to record against.</div>';
        return;
      }
      if (state.layout === 'compact') return renderCompact();
      var areas = state.restrict
        ? state.areas.filter(function (a) { return state.restrict.indexOf(a) > -1; })
        : state.areas;

      var html =
        '<div class="wrp-note">Record the <strong>best-fit range</strong> for each area. ' +
        'Individual statements are tagged on observations — not here.</div>';

      html += areas.map(function (area) {
        var sel = state.chosen[area] || null;
        var sug = state.suggested[area] || null;
        var opts_ = state.ranges.map(function (r) {
          var isSel = sel === r.ordinal;
          var isSug = !sel && sug === r.ordinal;
          var sub = r.label && r.label !== r.short
            ? '<span class="wrp-sub">' + esc(String(r.label).replace(/^.*?\(/, '').replace(/\)$/, '')) + '</span>'
            : '';
          return '<button type="button" class="wrp-opt' + (isSug ? ' wrp-sug' : '') + '"' +
                 ' data-area="' + esc(area) + '" data-ord="' + r.ordinal + '"' +
                 ' aria-pressed="' + (isSel ? 'true' : 'false') + '"' +
                 ' title="' + esc(r.label) + '">' + esc(r.short) + sub + '</button>';
        }).join('');
        /* b291 — how secure in that range. Only offered once a range is chosen:
         * there is nothing to be secure IN until then. */
        var S = sec();
        var secRow = (sel && S)
          ? '<div class="wrp-sec"><span class="wrp-sec-label">How secure in ' +
            esc((state.ranges.filter(function (r) { return r.ordinal === sel; })[0] || {}).short || 'this range') +
            '?</span>' + S.segmented(state.security[area] || null, { 'sec-area': area }) + '</div>'
          : '';

        return '<div class="wrp-row" data-area-row="' + esc(area) + '">' +
          '<div class="wrp-head"><span class="wrp-area">' + esc(area) + '</span>' +
          (sug && !sel ? '<span class="wrp-hint">tracker suggests <b>' +
            esc((state.ranges.filter(function (r) { return r.ordinal === sug; })[0] || {}).short || '') +
            '</b></span>' : '') +
          (sel ? '<button type="button" class="wrp-clear" data-clear="' + esc(area) + '">clear</button>' : '') +
          '</div><div class="wrp-seg" role="group" aria-label="' + esc(area) + ' range">' + opts_ + '</div>' +
          secRow + '</div>';
      }).join('');

      /* Don't name the colour: wren-theme.js remaps --c-orange per theme, so a
       * legend that says "orange" is wrong the moment anyone picks a preset. */
      html += '<div class="wrp-legend"><span><i></i>outlined = suggested by the ' +
              'statements already evidenced on the tracker</span></div>';
      var S0 = sec();
      if (S0) html += '<div style="margin-top:6px">' + S0.legend() + '</div>';
      host.innerHTML = html;
    }

    /* ── b296: the compact layout ──────────────────────────────────────────
     * What is chosen, and nothing else. Everything not yet judged lives behind
     * one "＋ Add an area" button, which opens the search sheet. */
    function renderCompact() {
      var areas = visibleAreas();
      var chosen = areas.filter(function (a) { return state.chosen[a]; });
      var S = sec();

      var html = '<div class="wrp-note">Record the <strong>best-fit range</strong> for each area you can ' +
        'judge. Individual statements are tagged on observations — not here.</div>';

      html += '<div class="wrp-chips">';
      if (!chosen.length) {
        html += '<div class="wrp-none">No areas recorded yet — add the ones you can judge.</div>';
      } else {
        html += chosen.map(function (area) {
          var r = rangeByOrd(state.chosen[area]);
          var secRow = S
            ? '<div class="wrp-sec"><span class="wrp-sec-label">How secure in ' +
              esc(r ? r.short : 'this range') + '?</span>' +
              S.segmented(state.security[area] || null, { 'sec-area': area }) + '</div>'
            : '';
          return '<div class="wrp-chip" data-area-row="' + esc(area) + '">' +
            '<div class="wrp-chip-top">' +
              '<span class="wrp-chip-area">' + esc(area) + '</span>' +
              '<span class="wrp-chip-range" title="' + esc(r ? r.label : '') + '">' +
                esc(r ? r.short : ('Range ' + state.chosen[area])) + '</span>' +
              '<button type="button" class="wrp-chip-x" data-clear="' + esc(area) + '"' +
              ' aria-label="Remove ' + esc(area) + '">✕</button>' +
            '</div>' + secRow + '</div>';
        }).join('');
      }
      html += '</div>';

      if (chosen.length < areas.length) {
        html += '<button type="button" class="wrp-add" data-wrp-open="1">＋ Add an area</button>';
      }

      /* Toby: "Keep a free-text box alongside for anything that does not map to
       * a statement." It rides along on the same save as the ranges. */
      html += '<div class="wrp-notes"><label for="wrp-notes-' + esc(state.context) + '">' +
        'Anything the ranges do not cover</label>' +
        '<textarea id="wrp-notes-' + esc(state.context) + '" data-wrp-notes="1" ' +
        'placeholder="Optional — in your own words">' + esc(state.notes) + '</textarea></div>';

      if (S) html += '<div style="margin-top:8px">' + S.legend() + '</div>';

      host.innerHTML = html + sheetHtml();
    }

    /* The search sheet — every area × range in one searchable list, grouped by
     * area, with the tracker's suggestion outlined and the current pick ticked.
     * Same interaction as the observation statement picker: type, tap, done. */
    function sheetHtml() {
      var q = String(state.sheetQ || '').trim().toLowerCase();
      var areas = visibleAreas();
      var body = '';
      areas.forEach(function (area) {
        var hits = state.ranges.filter(function (r) {
          if (!q) return true;
          return (area + ' ' + r.short + ' ' + r.label).toLowerCase().indexOf(q) !== -1;
        });
        if (!hits.length) return;
        body += '<div class="wrp-grp">' + esc(area) + '</div>';
        body += hits.map(function (r) {
          var on  = state.chosen[area] === r.ordinal;
          var sug = !state.chosen[area] && state.suggested[area] === r.ordinal;
          return '<button type="button" class="wrp-hit' + (on ? ' on' : '') + (sug ? ' sug' : '') + '"' +
            ' data-wrp-pick="' + r.ordinal + '" data-wrp-area="' + esc(area) + '">' +
            '<div class="t">' + (on ? '✓ ' : '') + esc(r.short) + '</div>' +
            '<div class="m">' + esc(r.label) + (sug ? ' · suggested by the tracker' : '') + '</div></button>';
        }).join('');
      });
      if (!body) body = '<div class="wrp-empty">Nothing matched.</div>';
      return '<div class="wrp-sheet' + (state.sheetOpen ? ' open' : '') + '" role="dialog" aria-modal="true"' +
        ' aria-label="Choose an area and range">' +
        '<div class="wrp-sheet-inner">' +
          '<div class="wrp-sheet-hd"><h3>Choose an area and its range</h3>' +
          '<button type="button" class="wrp-opt" data-wrp-close="1">Close</button></div>' +
          '<input type="search" data-wrp-q="1" placeholder="Search areas and ranges…" ' +
            'value="' + esc(state.sheetQ) + '" aria-label="Search areas and ranges">' +
          '<div class="wrp-hits">' + body + '</div>' +
        '</div></div>';
    }

    /* Re-render only the sheet, so typing in the search box does not blow away
     * the notes textarea (and the caret in it) on every keystroke. */
    function repaintSheet() {
      var old = host.querySelector('.wrp-sheet');
      if (!old) { render(); return; }
      var tmp = document.createElement('div');
      tmp.innerHTML = sheetHtml();
      old.replaceWith(tmp.firstChild);
      var q = host.querySelector('[data-wrp-q]');
      if (q && state.sheetOpen) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    }

    function onCompactInput(e) {
      var q = e.target.closest && e.target.closest('[data-wrp-q]');
      if (q && host.contains(q)) { state.sheetQ = q.value; repaintSheet(); return; }
      var n = e.target.closest && e.target.closest('[data-wrp-notes]');
      if (n && host.contains(n)) { state.notes = n.value; fire(); }
    }

    /* Returns true when it handled the click. */
    function onCompactClick(e) {
      var open = e.target.closest && e.target.closest('[data-wrp-open]');
      if (open && host.contains(open)) {
        state.sheetOpen = true; state.sheetQ = ''; repaintSheet();
        var q = host.querySelector('[data-wrp-q]'); if (q) q.focus();
        return true;
      }
      var close = e.target.closest && e.target.closest('[data-wrp-close]');
      if (close && host.contains(close)) { state.sheetOpen = false; repaintSheet(); return true; }
      var pick = e.target.closest && e.target.closest('[data-wrp-pick]');
      if (pick && host.contains(pick)) {
        var area = pick.getAttribute('data-wrp-area');
        var ord  = parseInt(pick.getAttribute('data-wrp-pick'), 10);
        if (state.chosen[area] === ord) { delete state.chosen[area]; delete state.security[area]; }
        else state.chosen[area] = ord;
        state.sheetOpen = false;
        render(); fire();
        return true;
      }
      /* Tapping the dim behind the sheet closes it. */
      if (state.sheetOpen && e.target.classList && e.target.classList.contains('wrp-sheet')) {
        state.sheetOpen = false; repaintSheet(); return true;
      }
      return false;
    }

    function onClick(e) {
      if (state.layout === 'compact' && onCompactClick(e)) return;
      var clr = e.target.closest && e.target.closest('[data-clear]');
      if (clr && host.contains(clr)) {
        var ca = clr.getAttribute('data-clear');
        delete state.chosen[ca];
        // A security rating with no range behind it means nothing — clearing the
        // range clears the rating with it rather than leaving it orphaned.
        delete state.security[ca];
        render(); fire(); return;
      }
      /* b291 — the security buttons. Pressing the value that is already on
       * clears it back to "not yet rated", the same toggle the range uses. */
      var sbtn = e.target.closest && e.target.closest('.wsec-btn[data-sec-area]');
      if (sbtn && host.contains(sbtn)) {
        var sArea = sbtn.getAttribute('data-sec-area');
        var sVal  = sbtn.getAttribute('data-sec');
        if (state.security[sArea] === sVal) delete state.security[sArea];
        else state.security[sArea] = sVal;
        render(); fire(); return;
      }
      var btn = e.target.closest && e.target.closest('.wrp-opt');
      if (!btn || !host.contains(btn)) return;
      var area = btn.getAttribute('data-area');
      var ord  = parseInt(btn.getAttribute('data-ord'), 10);
      if (state.chosen[area] === ord) { delete state.chosen[area]; delete state.security[area]; }
      else state.chosen[area] = ord;
      render(); fire();
    }
    function fire() { if (typeof opts.onChange === 'function') opts.onChange(values()); }

    function values() {
      return Object.keys(state.chosen).map(function (a) {
        // `security` is always present on the wire, explicitly null when the
        // practitioner has not rated it — so the server can tell "not rated"
        // apart from "this client is too old to send a rating".
        return { area: a, range_ordinal: state.chosen[a], security: state.security[a] || null };
      });
    }
    function setValues(list) {
      state.chosen = {}; state.security = {};
      (list || []).forEach(function (v) {
        if (!v || !v.area) return;
        state.chosen[v.area] = v.range_ordinal;
        var S = sec();
        var sv = S ? S.normalise(v.security) : (v.security || null);
        if (sv) state.security[v.area] = sv;
      });
      render();
    }

    function reload() {
      state.loaded = false; render();
      var url = '/api/observations/child-ranges/' + encodeURIComponent(state.childId) +
                '?framework=' + encodeURIComponent(state.framework);
      return api(url).then(function (d) {
        state.mode = d.mode; state.ranges = d.ranges || []; state.areas = d.areas || [];
        state.suggested = d.suggested || {};
        state.chosen = {}; state.security = {};
        var S = sec();
        state.notes = '';
        (d.recorded || []).forEach(function (r) {
          if (r.context !== state.context) return;
          state.chosen[r.area] = r.range_ordinal;
          /* One note is saved against every area of a judgement, so the first
           * one found is the note — not a per-area value to concatenate. */
          if (!state.notes && r.notes) state.notes = r.notes;
          // A row saved before b291 has security = null. Leave it unset so it
          // renders as "not yet rated" rather than being read as Emerging.
          var sv = S ? S.normalise(r.security) : (r.security || null);
          if (sv) state.security[r.area] = sv;
        });
        state.loaded = true; render(); fire();
        return d;
      }).catch(function (e) {
        state.loaded = true;
        host.innerHTML = '<div class="wrp-empty">Could not load ranges — ' +
                         esc((e && (e.error || e.message)) || 'unknown error') + '</div>';
        throw e;
      });
    }

    function save(extra) {
      var vals = values();
      if (!vals.length) return Promise.reject({ error: 'Choose a range for at least one area' });
      var body = {
        child_id: state.childId, framework: state.framework, context: state.context,
        areas: vals
      };
      if (extra && extra.context_id != null) body.context_id = extra.context_id;
      /* b296 — the compact layout's free-text box rides along on the same save.
       * An explicit extra.notes still wins, so existing callers are unchanged. */
      if (extra && extra.notes) body.notes = extra.notes;
      else if (state.notes && state.notes.trim()) body.notes = state.notes.trim();
      if (extra && extra.judged_on) body.judged_on = extra.judged_on;
      return api('/api/observations/child-ranges', { method: 'POST', body: body });
    }

    host.addEventListener('click', onClick);
    host.addEventListener('input', onCompactInput);
    host.setAttribute('data-wren-range-picker', state.context);
    host.setAttribute('data-wren-range-layout', state.layout);
    render();
    if (state.childId) reload();

    return {
      values: values, setValues: setValues, save: save, reload: reload,
      framework: function () { return state.framework; },
      context: function () { return state.context; },
      layout: function () { return state.layout; },
      // b296 — the free-text box alongside the ranges.
      notes: function () { return state.notes; },
      setNotes: function (v) { state.notes = v == null ? '' : String(v); render(); },
      setChild: function (id) { state.childId = id; return reload(); },
      destroy: function () {
        host.removeEventListener('click', onClick);
        host.removeEventListener('input', onCompactInput);
        host.innerHTML = '';
      }
    };
  }

  window.WrenRangePicker = { VERSION: 'b296', CONTEXTS: CONTEXTS, mount: mount, CSS: CSS };
})();
