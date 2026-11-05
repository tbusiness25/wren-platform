/* b363 (2026-09-29) — Staff → Payroll → Import details (CSV).
 *
 * BrightHR exports a CSV; this turns it into the tax codes, NI numbers,
 * addresses and pay rates that are missing from ladn.staff, in four steps that
 * are deliberately separate:
 *
 *   1. choose the file
 *   2. say which column is which  (guessed, correctable, remembered)
 *   3. see exactly what would change, per person per field
 *   4. apply — blanks by default, an existing value only if that field is ticked
 *
 * and then step 5, which is the reason the screen exists at all: the list of
 * what payroll is STILL missing, so the gaps can be watched closing.
 *
 * Why a mapping step rather than a fixed format: BrightHR's export headers are
 * not known until Toby runs the export, and they will change again the next time
 * BrightHR redesigns that screen. So the mapping is data — guessed from the
 * header names, corrected here, and stored against a fingerprint of the header
 * row so next month's export maps itself.
 *
 * Nothing in step 2 or 3 writes anything. A preview touches no table at all,
 * which is what makes it safe to keep re-running on a file you are unsure about.
 *
 * Colours are var(--c-*) tokens only — wren-theme.js rewrites those at runtime
 * per portal and per user preset, so a bare hex here would survive exactly one
 * theme. Class prefix is `wpi-` (NOT `wc-`, which the chat widget claims —
 * reference_wc_prefix_collides_with_chat_widget).
 */
(function () {
  'use strict';
  if (window.WrenPayrollImport) return;

  var API = '/api/payroll/import';

  var CSS = `
  .wpi-wrap { font-size: .86rem; color: var(--c-text); }
  .wpi-card { background: var(--c-card); border: 1px solid var(--c-border); border-radius: 12px;
              padding: 16px; margin-bottom: 14px; }
  .wpi-card > h3 { font-size: 1rem; margin: 0 0 4px; color: var(--c-text); display: flex;
                   align-items: center; gap: 9px; flex-wrap: wrap; }
  .wpi-step-n { width: 21px; height: 21px; border-radius: 50%; background: var(--c-blue);
                color: var(--c-bg); display: inline-flex; align-items: center; justify-content: center;
                font-size: .72rem; font-weight: 800; flex: 0 0 auto; }
  .wpi-sub { font-size: .79rem; color: var(--c-muted); line-height: 1.55; margin: 0 0 12px; }
  .wpi-rules { margin: 0 0 12px; padding-left: 18px; font-size: .78rem; color: var(--c-muted); line-height: 1.6; }
  .wpi-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .wpi-drop { border: 1.5px dashed var(--c-border); border-radius: 10px; padding: 20px; text-align: center;
              color: var(--c-muted); cursor: pointer; min-height: 40px; transition: border-color .15s, background .15s; }
  .wpi-drop:hover, .wpi-drop.over { border-color: var(--c-blue); background: var(--c-bg); }
  .wpi-drop b { color: var(--c-text); }
  .wpi-file { font-size: .8rem; color: var(--c-text); }
  .wpi-file b { font-weight: 700; }
  .wpi-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 9px; margin: 2px 0 14px; }
  .wpi-tile { background: var(--c-bg); border: 1px solid var(--c-border); border-radius: 10px; padding: 10px 12px; }
  .wpi-tile .k { font-size: .66rem; text-transform: uppercase; letter-spacing: .05em; color: var(--c-muted); }
  .wpi-tile .v { font-size: 1.25rem; font-weight: 700; color: var(--c-text); font-variant-numeric: tabular-nums; }
  .wpi-tile.good .v { color: var(--c-green); } .wpi-tile.warn .v { color: var(--c-amber); }
  .wpi-tile.bad .v  { color: var(--c-red); }   .wpi-tile.blue .v { color: var(--c-blue); }
  .wpi-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; border: 1px solid var(--c-border);
                border-radius: 8px; max-height: 420px; overflow-y: auto; }
  .wpi-table { width: 100%; border-collapse: collapse; font-size: .81rem; }
  .wpi-table th { position: sticky; top: 0; z-index: 1; background: var(--c-bg); color: var(--c-muted);
                  text-align: left; font-size: .67rem; text-transform: uppercase; letter-spacing: .04em;
                  font-weight: 600; padding: 8px 10px; border-bottom: 1px solid var(--c-border); white-space: nowrap; }
  .wpi-table td { padding: 8px 10px; border-bottom: 1px solid var(--c-border); color: var(--c-text); vertical-align: top; }
  .wpi-table tr:last-child td { border-bottom: 0; }
  .wpi-table tr.wpi-person td { background: var(--c-bg); font-weight: 700; }
  .wpi-old { color: var(--c-muted); }
  .wpi-new { color: var(--c-green); font-weight: 600; }
  .wpi-none { color: var(--c-muted); font-style: italic; }
  .wpi-bad { color: var(--c-red); }
  .wpi-warn { color: var(--c-amber); font-size: .74rem; line-height: 1.45; display: block; margin-top: 3px; }
  .wpi-note { background: var(--c-bg); border: 1px solid var(--c-border); border-left: 3px solid var(--c-blue);
              border-radius: 8px; padding: 11px 13px; font-size: .79rem; color: var(--c-muted);
              line-height: 1.55; margin-bottom: 12px; }
  .wpi-note.warn { border-left-color: var(--c-amber); }
  .wpi-note.bad  { border-left-color: var(--c-red); }
  .wpi-note.ok   { border-left-color: var(--c-green); }
  .wpi-note b { color: var(--c-text); }
  .wpi-pill { display: inline-block; font-size: .65rem; font-weight: 700; padding: 2px 8px; border-radius: 20px;
              background: var(--c-navy-light); color: var(--c-muted); white-space: nowrap; }
  .wpi-pill.green { background: rgba(52,211,153,.16); color: var(--c-green); }
  .wpi-pill.amber { background: rgba(251,191,36,.16); color: var(--c-amber); }
  .wpi-pill.red   { background: rgba(248,113,113,.16); color: var(--c-red); }
  .wpi-pill.blue  { background: rgba(91,143,255,.16); color: var(--c-blue); }
  .wpi-in { background: var(--c-bg); border: 1px solid var(--c-border); border-radius: 8px;
            padding: 8px 10px; color: var(--c-text); font-family: inherit; font-size: .84rem; min-height: 40px; }
  .wpi-map { display: grid; gap: 8px; }
  .wpi-maprow { display: grid; grid-template-columns: minmax(130px, 1.1fr) minmax(110px, 1fr) minmax(170px, 1.2fr);
                gap: 9px; align-items: center; padding: 8px; border: 1px solid var(--c-border); border-radius: 9px; }
  .wpi-maphdr { font-weight: 700; word-break: break-word; }
  .wpi-mapex { color: var(--c-muted); font-size: .76rem; word-break: break-word; }
  .wpi-maprow.wpi-unmapped { opacity: .72; }
  .wpi-maprow select { width: 100%; }
  .wpi-tick { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; cursor: pointer; }
  .wpi-tick input { width: 17px; height: 17px; accent-color: var(--c-amber); cursor: pointer; }
  .wpi-gapchips { display: flex; flex-wrap: wrap; gap: 5px; }
  .wpi-empty { color: var(--c-muted); padding: 20px; text-align: center; font-size: .85rem; }
  .wpi-spin { color: var(--c-muted); font-size: .8rem; padding: 8px 0; }
  .wpi-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
  .wpi-hist-row { display: flex; gap: 10px; align-items: baseline; padding: 7px 0;
                  border-top: 1px solid var(--c-border); font-size: .8rem; }
  .wpi-hist-row:first-child { border-top: 0; }
  .wpi-hist-sub { color: var(--c-muted); font-size: .74rem; }
  @media (max-width: 640px) {
    .wpi-maprow { grid-template-columns: 1fr; }
    .wpi-tile .v { font-size: 1.1rem; }
  }
  `;

  function injectCSS() {
    if (document.getElementById('wpi-css')) return;
    var st = document.createElement('style');
    st.id = 'wpi-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function val(v) {
    return (v === '' || v == null) ? '<span class="wpi-none">(empty)</span>' : esc(v);
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  // Wren.api rejects with the PARSED BODY, so `e.message` is only there because
  // this API always sends one (reference_wren_api_rejects_with_body).
  function errText(e) {
    return (e && (e.message || e.error)) || 'something went wrong';
  }
  function when(ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleString('en-GB',
        { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch (_) { return String(ts).slice(0, 16); }
  }

  function mount(root) {
    injectCSS();

    var CTX = null;                  // /context
    var FILE = null;                 // { name, text }
    var PREVIEW = null;              // /preview
    var MAPPING = null;              // { header: field key }
    var OVERWRITE = {};              // { "<staffId>:<field>": true }
    var previewTimer = null;
    // The Roost SPA scrolls an INNER container, and the mapping table is 17 rows
    // tall, so a preview rendered below it is off-screen unless we say otherwise.
    // Only on a new file and after an apply — scrolling on every tick would yank
    // the page away from the box just ticked.
    var SCROLL_NEXT = false;
    function reveal(el) {
      if (!el) return;
      try { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (_) { el.scrollIntoView(); }
    }

    root.innerHTML =
      '<div class="wpi-wrap">' +
        '<div data-wpi="intro"></div>' +
        '<div class="wpi-card">' +
          '<h3><span class="wpi-step-n">1</span>Choose the file</h3>' +
          '<div class="wpi-sub" data-wpi="rules"></div>' +
          '<div class="wpi-drop" data-wpi="drop" tabindex="0" role="button" ' +
               'aria-label="Choose a CSV of payroll details">' +
            '<b>Drop the CSV here, or click to choose it</b>' +
            '<div style="margin-top:5px;font-size:.78rem">A BrightHR employee export, or any CSV with one row per person</div>' +
            '<input type="file" accept=".csv,text/csv,text/plain" data-wpi="file" style="display:none">' +
          '</div>' +
          '<div class="wpi-actions">' +
            '<button class="btn btn-sm btn-ghost" data-wpi="dl-template" type="button">↓ Blank template CSV</button>' +
            '<span class="wpi-file" data-wpi="filename"></span>' +
          '</div>' +
        '</div>' +
        '<div data-wpi="map"></div>' +
        '<div data-wpi="preview"></div>' +
        '<div data-wpi="result"></div>' +
        '<div data-wpi="gaps"><div class="wpi-card"><div class="wpi-spin">Loading what payroll is still missing…</div></div></div>' +
        '<div data-wpi="history"></div>' +
      '</div>';

    var q = function (n) { return root.querySelector('[data-wpi="' + n + '"]'); };

    // ── context ──────────────────────────────────────────────────────────────
    Wren.api(API + '/context').then(function (d) {
      CTX = d;
      q('rules').innerHTML = '<ul class="wpi-rules">' +
        (d.rules || []).map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>';
      q('intro').innerHTML = '<div class="wpi-note"><b>Import payroll details.</b> ' +
        esc(d.not_a_filing || '') + '</div>';
      renderGaps(d.gaps);
      renderHistory(d.recent_imports || []);
    }).catch(function (e) {
      root.innerHTML = '<div class="wpi-empty">' +
        (e && e.error === 'salary_view_forbidden'
          ? esc(errText(e))
          : 'Could not open the importer — ' + esc(errText(e))) + '</div>';
    });

    // ── step 1: the file ─────────────────────────────────────────────────────
    var drop = q('drop'), fileInput = q('file');
    drop.addEventListener('click', function () { fileInput.click(); });
    drop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) readFile(f);
    });
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) readFile(fileInput.files[0]);
    });

    q('dl-template').addEventListener('click', function () {
      Wren.download(API + '/template.csv', 'wren-payroll-details-template.csv')
        .then(function (r) { Wren.toast('Downloaded ' + r.filename, 'success'); })
        .catch(function (e) { Wren.toast('Could not download the template — ' + errText(e), 'error'); });
    });

    function readFile(f) {
      var reader = new FileReader();
      reader.onload = function () {
        FILE = { name: f.name, text: String(reader.result || '') };
        MAPPING = null; OVERWRITE = {}; PREVIEW = null;
        q('result').innerHTML = '';
        q('filename').innerHTML = 'Reading <b>' + esc(f.name) + '</b>…';
        SCROLL_NEXT = true;          // a new file: take them to what it would do
        doPreview();
      };
      reader.onerror = function () { Wren.toast('Could not read that file', 'error'); };
      reader.readAsText(f, 'utf-8');
    }

    // ── steps 2 + 3: preview (writes nothing) ────────────────────────────────
    function schedulePreview() {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(doPreview, 300);
    }

    function doPreview() {
      if (!FILE) return;
      q('preview').innerHTML = '<div class="wpi-card"><div class="wpi-spin">Working out what this file would change…</div></div>';
      Wren.api(API + '/preview', {
        method: 'POST',
        body: { csv: FILE.text, mapping: MAPPING || undefined, overwrite: OVERWRITE },
      }).then(function (d) {
        PREVIEW = d;
        if (!MAPPING) MAPPING = d.saved_mapping || d.mapping;
        q('filename').innerHTML = 'Read <b>' + esc(FILE.name) + '</b> — ' +
          plural(d.counts.rows_in_file, 'row') + ', ' + plural(d.headers.length, 'column');
        renderMap(d);
        renderPreview(d);
      }).catch(function (e) {
        // A 422 with columns on it is a mapping problem, not a broken file: show
        // the mapping step so it can be fixed in place.
        if (e && e.columns) {
          PREVIEW = null;
          if (!MAPPING) MAPPING = e.mapping || {};
          renderMap(e, errText(e));
          q('preview').innerHTML = '';
        } else {
          q('map').innerHTML = '';
          q('preview').innerHTML = '<div class="wpi-card"><div class="wpi-note bad"><b>That file was not read.</b><br>' +
            esc(errText(e)) + '</div></div>';
        }
      });
    }

    function optionsHtml(selected) {
      var groups = {};
      (CTX && CTX.options || []).forEach(function (o) {
        (groups[o.group] = groups[o.group] || { label: o.group_label, items: [] }).items.push(o);
      });
      var html = '<option value=""' + (selected ? '' : ' selected') + '>— not imported —</option>';
      Object.keys(groups).forEach(function (g) {
        html += '<optgroup label="' + esc(groups[g].label) + '">';
        groups[g].items.forEach(function (o) {
          html += '<option value="' + esc(o.key) + '"' + (o.key === selected ? ' selected' : '') + '>' +
            esc(o.label) + (o.role === 'match' ? ' (identify only)' : '') + '</option>';
        });
        html += '</optgroup>';
      });
      return html;
    }

    function renderMap(d, problem) {
      // Each column carries a `sample` — the first non-empty value in it — which
      // is what makes a wrong guess obvious at a glance.
      var html = '<div class="wpi-card">' +
        '<h3><span class="wpi-step-n">2</span>Say which column is which</h3>' +
        '<div class="wpi-sub">Wren has guessed from the column names. Correct anything it got wrong — ' +
        'the mapping is remembered against this report\'s columns, so next month\'s export maps itself. ' +
        'Dates are read as day/month/year.</div>';

      if (problem) html += '<div class="wpi-note bad"><b>Not ready yet.</b><br>' + esc(problem) + '</div>';
      if (d.saved_mapping) {
        html += '<div class="wpi-note ok"><b>Wren has seen this report before</b> — ' +
          (d.saved_mapping_label ? esc(d.saved_mapping_label) + ', ' : '') +
          'used ' + plural(d.saved_mapping_times_used || 1, 'time') +
          '. Its saved mapping has been applied.</div>';
      }
      var dupes = (d.columns || []).filter(function (c) { return c.duplicate_of; });
      if (dupes.length) {
        html += '<div class="wpi-note warn"><b>Two columns wanted the same field.</b> ' +
          dupes.map(function (c) {
            return esc(c.header) + ' (already taken by ' + esc(c.duplicate_of) + ')';
          }).join('; ') + '. Pick a different field for one of them, or leave it out.</div>';
      }

      html += '<div class="wpi-map">' + (d.columns || []).filter(function (c) { return c.header; })
        .map(function (c) {
          return '<div class="wpi-maprow' + (c.field_key ? '' : ' wpi-unmapped') + '">' +
            '<div class="wpi-maphdr">' + esc(c.header) +
              (c.guessed && c.guessed === c.field_key ? ' <span class="wpi-pill blue">guessed</span>' : '') +
            '</div>' +
            '<div class="wpi-mapex">' + esc(c.sample == null ? '' : c.sample) + '</div>' +
            '<div><label class="sr-only" for="wpi-map-' + esc(c.index) + '">' + esc(c.header) + ' maps to</label>' +
            '<select class="wpi-in" id="wpi-map-' + esc(c.index) + '" data-wpi-map="' + esc(c.header) + '">' +
              optionsHtml(c.field_key) + '</select></div>' +
          '</div>';
        }).join('') + '</div>';

      html += '<div class="wpi-actions">' +
        '<label class="wpi-file">What is this report? ' +
          '<input class="wpi-in" data-wpi="label" type="text" maxlength="120" ' +
            'placeholder="BrightHR — employee export" style="min-width:220px">' +
        '</label></div>';
      html += '</div>';
      q('map').innerHTML = html;

      root.querySelectorAll('[data-wpi-map]').forEach(function (sel) {
        sel.addEventListener('change', function () {
          MAPPING = MAPPING || {};
          var h = sel.getAttribute('data-wpi-map');
          if (sel.value) MAPPING[h] = sel.value; else delete MAPPING[h];
          OVERWRITE = {};                       // the ticks belonged to the old mapping
          schedulePreview();
        });
      });
    }

    function tile(k, v, tone, s) {
      return '<div class="wpi-tile' + (tone ? ' ' + tone : '') + '"><div class="k">' + esc(k) + '</div>' +
        '<div class="v">' + esc(v) + '</div>' + (s ? '<div class="wpi-mapex">' + esc(s) + '</div>' : '') + '</div>';
    }

    function renderPreview(d) {
      var c = d.counts;
      var html = '<div class="wpi-card">' +
        '<h3><span class="wpi-step-n">3</span>What would change' +
        '<span class="wpi-pill">nothing is written yet</span></h3>' +
        '<div class="wpi-sub">Blanks are filled in. A value Wren already holds is left alone unless you ' +
        'tick that field — the amber rows below.</div>' +
        '<div class="wpi-tiles">' +
          tile('Rows matched', c.rows_matched + ' / ' + c.rows_in_file,
               c.rows_unmatched ? 'warn' : 'good',
               c.rows_unmatched ? plural(c.rows_unmatched, 'row') + ' unmatched' : 'every row placed') +
          tile('Blanks to fill', c.fields_to_fill, c.fields_to_fill ? 'blue' : '') +
          tile('Ticked to replace', c.fields_to_overwrite,
               c.fields_to_overwrite ? 'warn' : '',
               c.overwrites_available ? c.overwrites_available + ' offered' : 'none offered') +
          tile('Refused', c.fields_rejected, c.fields_rejected ? 'bad' : 'good',
               c.fields_rejected ? 'not the right shape' : 'every value valid') +
          tile('Already correct', c.fields_same) +
        '</div>';

      if (c.columns_unmapped) {
        html += '<div class="wpi-note">' + plural(c.columns_unmapped, 'column') +
          ' in the file ' + (c.columns_unmapped === 1 ? 'is' : 'are') +
          ' not mapped to anything, so nothing in ' + (c.columns_unmapped === 1 ? 'it' : 'them') +
          ' will be imported.</div>';
      }

      if ((d.unmatched || []).length) {
        html += '<div class="wpi-note warn"><b>' + plural(d.unmatched.length, 'row') +
          ' could not be matched to anybody</b> and ' +
          (d.unmatched.length === 1 ? 'is' : 'are') + ' listed below. Nothing is guessed: ' +
          'add the employee id, payroll number or email address to those rows, or fix the name.</div>' +
          '<div class="wpi-scroll"><table class="wpi-table"><thead><tr>' +
          '<th>Line</th><th>The row says</th><th>Why it was not matched</th></tr></thead><tbody>' +
          d.unmatched.map(function (u) {
            return '<tr><td>' + esc(u.line) + '</td><td>' + esc(u.shown) + '</td>' +
              '<td class="wpi-bad">' + esc(u.reason) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }

      if ((d.rejects || []).length) {
        html += '<div class="wpi-note bad" style="margin-top:12px"><b>' +
          plural(d.rejects.length, 'value') + ' refused.</b> ' +
          'These are not written; everything else in the file still applies.</div>' +
          '<div class="wpi-scroll"><table class="wpi-table"><thead><tr>' +
          '<th>Line</th><th>Who</th><th>Field</th><th>In the file</th><th>Why it was refused</th>' +
          '</tr></thead><tbody>' +
          d.rejects.map(function (r) {
            return '<tr><td>' + esc(r.line) + '</td><td>' + esc(r.name) + '</td>' +
              '<td>' + esc(r.label) + '</td><td>' + esc(r.given) + '</td>' +
              '<td class="wpi-bad">' + esc(r.reason) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }

      var rowsWithWork = (d.rows || []).filter(function (r) {
        return !r.withdrawn && r.fields.some(function (f) { return f.state === 'fill' || f.state === 'overwrite'; });
      });

      if (rowsWithWork.length) {
        html += '<div class="wpi-sub" style="margin-top:14px"><b>Person by person, field by field.</b> ' +
          'A tick is needed only where Wren already holds a different value.</div>' +
          '<div class="wpi-scroll"><table class="wpi-table"><thead><tr>' +
          '<th>Who</th><th>Field</th><th>Now in Wren</th><th>From the file</th><th>Replace?</th>' +
          '</tr></thead><tbody>' +
          rowsWithWork.map(function (r) {
            var head = '<tr class="wpi-person"><td colspan="5">' + esc(r.name) +
              ' <span class="wpi-pill blue">matched on ' + esc(r.matched_by_label) + '</span>' +
              (r.notes || []).map(function (n) { return ' <span class="wpi-pill amber">' + esc(n) + '</span>'; }).join('') +
              '</td></tr>';
            return head + r.fields.filter(function (f) {
              return f.state === 'fill' || f.state === 'overwrite';
            }).map(function (f) {
              var warn = (f.warnings || []).map(function (w) {
                return '<span class="wpi-warn">⚠ ' + esc(w) + '</span>';
              }).join('');
              return '<tr><td></td><td>' + esc(f.label) +
                (f.also_fill_blank ? ' <span class="wpi-pill">also fills ' + esc(f.also_fill_blank) + '</span>' : '') +
                '</td>' +
                '<td class="wpi-old">' + val(f.old) + '</td>' +
                '<td class="wpi-new">' + val(f.new) + warn + '</td>' +
                '<td>' + (f.state === 'overwrite'
                  ? '<label class="wpi-tick"><input type="checkbox" data-wpi-tick="' + esc(f.tick_key) + '"' +
                    (f.ticked ? ' checked' : '') + '> replace</label>'
                  : '<span class="wpi-pill green">filling a blank</span>') + '</td></tr>';
            }).join('');
          }).join('') + '</tbody></table></div>';
      } else if (!(d.rejects || []).length && !(d.unmatched || []).length) {
        html += '<div class="wpi-note ok">Nothing to do — every value in that file already matches what Wren holds.</div>';
      }

      var n = c.fields_to_write;
      html += '<div class="wpi-actions">' +
        '<button class="btn btn-primary" data-wpi="apply"' + (n ? '' : ' disabled') + ' type="button">' +
          (n ? 'Apply ' + plural(n, 'change') : 'Nothing to apply') + '</button>' +
        (c.overwrites_available && c.fields_to_overwrite < c.overwrites_available
          ? '<button class="btn btn-sm btn-ghost" data-wpi="tick-all" type="button">Tick all ' +
            plural(c.overwrites_available, 'replacement') + '</button>' : '') +
        (c.fields_to_overwrite
          ? '<button class="btn btn-sm btn-ghost" data-wpi="untick-all" type="button">Untick all</button>' : '') +
        '<button class="btn btn-sm btn-ghost" data-wpi="again" type="button">Choose a different file</button>' +
        '</div></div>';

      q('preview').innerHTML = html;

      root.querySelectorAll('[data-wpi-tick]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var k = cb.getAttribute('data-wpi-tick');
          if (cb.checked) OVERWRITE[k] = true; else delete OVERWRITE[k];
          schedulePreview();
        });
      });
      var tickAll = q('tick-all');
      if (tickAll) tickAll.addEventListener('click', function () {
        (PREVIEW.changes || []).forEach(function (ch) {
          if (ch.state === 'overwrite') OVERWRITE[ch.tick_key] = true;
        });
        doPreview();
      });
      var untickAll = q('untick-all');
      if (untickAll) untickAll.addEventListener('click', function () { OVERWRITE = {}; doPreview(); });
      var again = q('again');
      if (again) again.addEventListener('click', function () { fileInput.value = ''; fileInput.click(); });
      var apply = q('apply');
      if (apply) apply.addEventListener('click', function () { doApply(apply); });

      if (SCROLL_NEXT) { SCROLL_NEXT = false; reveal(q('preview')); }
    }

    // ── step 4: apply ────────────────────────────────────────────────────────
    function doApply(btn) {
      if (!FILE || !PREVIEW) return;
      var labelEl = q('label');
      btn.disabled = true;
      btn.textContent = 'Applying…';
      Wren.api(API + '/apply', {
        method: 'POST',
        body: {
          csv: FILE.text, mapping: MAPPING || undefined, overwrite: OVERWRITE,
          filename: FILE.name, checksum: PREVIEW.checksum,
          source_label: labelEl && labelEl.value ? labelEl.value : undefined,
        },
      }).then(function (r) {
        renderResult(r);
        reveal(q('result'));
        if (r.gaps) renderGaps(r.gaps);
        // Re-read the context for the history list; the gaps came back with the
        // apply so the list is already current.
        Wren.api(API + '/context').then(function (d) {
          CTX = d; renderHistory(d.recent_imports || []);
        }).catch(function () { /* the history keeps what it has */ });
        if (r.applied) {
          q('preview').innerHTML = '';
          PREVIEW = null; OVERWRITE = {};
          Wren.toast(plural(r.fields_written, 'field') + ' updated for ' +
            plural(r.staff_touched, 'person', 'people'), 'success');
        } else {
          btn.disabled = false;
          btn.textContent = 'Apply';
        }
      }).catch(function (e) {
        btn.disabled = false;
        btn.textContent = 'Apply';
        q('result').innerHTML = '<div class="wpi-card"><div class="wpi-note bad">' +
          '<b>Nothing was written.</b><br>' + esc(errText(e)) +
          (e && e.error === 'file_changed'
            ? '<br>Press “Choose a different file” and load it again.' : '') +
          '</div></div>';
      });
    }

    function renderResult(r) {
      if (!r.applied) {
        q('result').innerHTML = '<div class="wpi-card"><div class="wpi-note">' +
          '<b>Nothing to write.</b><br>' + esc(r.message || '') + '</div></div>';
        return;
      }
      var html = '<div class="wpi-card"><h3>✓ Imported</h3>' +
        '<div class="wpi-sub">' + plural(r.fields_written, 'field') + ' updated across ' +
        plural(r.staff_touched, 'person', 'people') + ' at ' + esc(when(r.applied_at)) +
        '. Every field is logged with who changed it; NI numbers and tax codes appear in that log ' +
        'as their last two characters only.</div>' +
        '<div class="wpi-tiles">' +
          tile('Blanks filled', r.fields_filled, 'good') +
          tile('Values replaced', r.fields_overwritten, r.fields_overwritten ? 'warn' : '') +
          tile('Refused', r.fields_rejected, r.fields_rejected ? 'bad' : '') +
          tile('Rows unmatched', r.rows_unmatched, r.rows_unmatched ? 'warn' : '') +
        '</div>' +
        '<div class="wpi-scroll"><table class="wpi-table"><thead><tr>' +
        '<th>Who</th><th>Field</th><th>Was</th><th>Now</th></tr></thead><tbody>' +
        (r.landed || []).map(function (p) {
          return p.fields.map(function (f, i) {
            return '<tr><td>' + (i === 0 ? esc(p.name) : '') + '</td><td>' + esc(f.label) +
              (f.masked ? ' <span class="wpi-pill">masked in the log</span>' : '') + '</td>' +
              '<td class="wpi-old">' + val(f.old) + '</td>' +
              '<td class="wpi-new">' + val(f.new) + '</td></tr>';
          }).join('');
        }).join('') + '</tbody></table></div></div>';
      q('result').innerHTML = html;
    }

    // ── step 5: the gaps that are left ───────────────────────────────────────
    function renderGaps(g) {
      if (!g) return;
      var byField = g.by_field || {};
      var order = ['tax_code', 'pay_rate', 'ni_number', 'date_of_birth', 'contract_type',
                   'pension_eligible', 'payroll_reference', 'contracted_hours',
                   'address_line1', 'postcode'];
      var LABEL = {
        tax_code: 'tax code', pay_rate: 'pay rate', ni_number: 'NI number',
        date_of_birth: 'date of birth', contract_type: 'pay basis',
        pension_eligible: 'pension status', payroll_reference: 'payroll number',
        contracted_hours: 'contracted hours', address_line1: 'home address', postcode: 'postcode',
      };
      var html = '<div class="wpi-card"><h3>Still missing for the next payroll run' +
        (g.people.length ? '' : ' <span class="wpi-pill green">nothing</span>') + '</h3>' +
        '<div class="wpi-sub">' + esc(g.basis) + '</div>' +
        '<div class="wpi-tiles">' +
          tile('People complete', g.complete + ' / ' + g.checked, g.complete === g.checked ? 'good' : '') +
          tile('Payroll blocked', g.blocking_people, g.blocking_people ? 'bad' : 'good',
               g.blocking_people ? 'no tax code or no pay rate' : 'nothing blocking a run') +
        order.filter(function (k) { return byField[k]; }).map(function (k) {
          return tile('No ' + LABEL[k], byField[k], k === 'tax_code' || k === 'pay_rate' ? 'bad' : 'warn');
        }).join('') +
        '</div>';

      if (g.people.length) {
        html += '<div class="wpi-scroll"><table class="wpi-table"><thead><tr>' +
          '<th>Who</th><th>Still needed</th></tr></thead><tbody>' +
          g.people.map(function (p) {
            return '<tr><td>' + esc(p.name) +
              (p.blocking ? ' <span class="wpi-pill red">blocks payroll</span>' : '') +
              '<div class="wpi-mapex">' + esc(p.job_title || '') + '</div></td>' +
              '<td><div class="wpi-gapchips">' + p.missing.map(function (m) {
                return '<span class="wpi-pill' + (m.blocking ? ' red' : ' amber') + '">' + esc(m.label) + '</span>';
              }).join('') + '</div></td></tr>';
          }).join('') + '</tbody></table></div>';
      } else {
        html += '<div class="wpi-note ok">Every active member of staff has everything payroll needs.</div>';
      }
      if ((g.excluded_from_payroll || []).length) {
        html += '<div class="wpi-sub" style="margin:10px 0 0">Not counted: staff ' +
          esc(g.excluded_from_payroll.join(', ')) + ', excluded from payroll runs by the template.</div>';
      }
      html += '</div>';
      q('gaps').innerHTML = html;
    }

    function renderHistory(list) {
      if (!list.length) { q('history').innerHTML = ''; return; }
      q('history').innerHTML = '<div class="wpi-card"><h3>Previous imports</h3>' +
        list.map(function (b) {
          return '<div class="wpi-hist-row"><div style="flex:1;min-width:0">' +
            '<b>' + esc(b.filename || b.source_label || 'CSV import') + '</b>' +
            '<div class="wpi-hist-sub">' + esc(when(b.applied_at)) +
            (b.applied_by_name ? ' · ' + esc(b.applied_by_name) : '') +
            ' · ' + plural(b.fields_filled, 'blank') + ' filled' +
            (b.fields_overwritten ? ', ' + plural(b.fields_overwritten, 'value') + ' replaced' : '') +
            (b.fields_rejected ? ', ' + plural(b.fields_rejected, 'value') + ' refused' : '') +
            (b.rows_unmatched ? ', ' + plural(b.rows_unmatched, 'row') + ' unmatched' : '') +
            '</div></div>' +
            '<span class="wpi-pill">' + plural(b.staff_touched, 'person', 'people') + '</span></div>';
        }).join('') + '</div>';
    }
  }

  window.WrenPayrollImport = { mount: mount };
})();
