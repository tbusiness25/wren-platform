/* b294 (2026-09-09) — bulk edit staff and children by CSV round-trip.
 *
 * One shared panel, opened from the Staff list and the Children list:
 *
 *   download what is on screen  →  edit it in a spreadsheet  →  upload
 *   →  a preview of EXACTLY which cells will change, old → new
 *   →  a second, deliberate press to apply
 *   →  what actually landed, and an Undo that is good the next morning.
 *
 * The preview is the whole point. Nothing here writes on the first press, the
 * Apply button does not exist until a preview has been rendered, and a preview
 * carrying any rejected row disables it: the server refuses a part-applied
 * spreadsheet, and the screen has to say so rather than let Toby press a button
 * that will 409.
 *
 * Colours are var(--c-*) tokens only — wren-theme.js rewrites those at runtime
 * per portal and per user preset, so a bare hex here would survive exactly one
 * theme.
 */
(function () {
  'use strict';
  if (window.WrenBulkEdit) return;

  var CSS = `
  .wbe-wrap { font-size: .86rem; color: var(--c-text); }
  .wbe-lede { color: var(--c-muted); line-height: 1.55; margin: 0 0 14px; }
  .wbe-step { border: 1px solid var(--c-border); border-radius: 10px; padding: 14px; margin-bottom: 12px; background: var(--c-surface); }
  .wbe-step-h { font-weight: 700; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
  .wbe-step-n { width: 20px; height: 20px; border-radius: 50%; background: var(--c-blue); color: var(--c-bg);
                display: inline-flex; align-items: center; justify-content: center; font-size: .72rem; font-weight: 800; flex: 0 0 auto; }
  .wbe-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .wbe-note { color: var(--c-muted); font-size: .78rem; line-height: 1.5; margin-top: 8px; }
  .wbe-drop { border: 1.5px dashed var(--c-border); border-radius: 10px; padding: 18px; text-align: center;
              color: var(--c-muted); cursor: pointer; transition: border-color .15s, background .15s; }
  .wbe-drop:hover, .wbe-drop.over { border-color: var(--c-blue); background: var(--c-surface); }
  .wbe-counts { display: flex; gap: 8px; flex-wrap: wrap; margin: 4px 0 12px; }
  .wbe-count { border: 1px solid var(--c-border); border-radius: 8px; padding: 6px 10px; min-width: 84px; }
  .wbe-count b { display: block; font-size: 1.15rem; line-height: 1.2; }
  .wbe-count span { color: var(--c-muted); font-size: .72rem; }
  .wbe-count.changed b { color: var(--c-blue); }
  .wbe-count.bad b     { color: var(--c-red); }
  .wbe-tablewrap { max-height: 340px; overflow: auto; border: 1px solid var(--c-border); border-radius: 8px; }
  .wbe-table { width: 100%; border-collapse: collapse; font-size: .8rem; }
  .wbe-table th { position: sticky; top: 0; background: var(--c-bg); color: var(--c-muted);
                  text-align: left; font-weight: 600; padding: 7px 10px; border-bottom: 1px solid var(--c-border); z-index: 1; }
  .wbe-table td { padding: 7px 10px; border-bottom: 1px solid var(--c-border); vertical-align: top; }
  .wbe-table tr:last-child td { border-bottom: 0; }
  .wbe-old { color: var(--c-muted); text-decoration: line-through; }
  .wbe-new { color: var(--c-green); font-weight: 600; }
  .wbe-empty-val { color: var(--c-muted); font-style: italic; }
  .wbe-bad { color: var(--c-red); }
  .wbe-banner { border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; line-height: 1.5; font-size: .82rem; border: 1px solid; }
  .wbe-banner.err  { border-color: var(--c-red);   color: var(--c-red); }
  .wbe-banner.warn { border-color: var(--c-amber); color: var(--c-amber); }
  .wbe-banner.ok   { border-color: var(--c-green); color: var(--c-green); }
  .wbe-hist { font-size: .8rem; }
  .wbe-hist-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-top: 1px solid var(--c-border); }
  .wbe-hist-row:first-child { border-top: 0; }
  .wbe-hist-main { flex: 1; min-width: 0; }
  .wbe-hist-sub { color: var(--c-muted); font-size: .74rem; }
  .wbe-cols { font-size: .74rem; color: var(--c-muted); margin-top: 8px; line-height: 1.6; }
  .wbe-cols code { background: var(--c-bg); border: 1px solid var(--c-border); border-radius: 4px; padding: 1px 5px; }
  `;

  function injectCSS() {
    if (document.getElementById('wbe-css')) return;
    var st = document.createElement('style');
    st.id = 'wbe-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function val(v) {
    return (v === '' || v == null) ? '<span class="wbe-empty-val">(empty)</span>' : esc(v);
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  // Downloads go through fetch so the bearer token travels with them — the
  // endpoint is authenticated, so a plain <a href> would 401. The response is
  // still sent as an attachment with no-store, which is what matters if anyone
  // ever opens the URL directly.
  function download(url, fallbackName) {
    var t = (window.Wren && Wren.getToken && Wren.getToken()) || '';
    return fetch(url, { headers: t ? { Authorization: 'Bearer ' + t } : {} })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (b) { throw new Error(b || ('HTTP ' + r.status)); });
        var cd = r.headers.get('Content-Disposition') || '';
        var m = cd.match(/filename="?([^";]+)"?/);
        var name = (m && m[1]) || fallbackName;
        return r.blob().then(function (blob) {
          var u = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = u; a.download = name;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(u); }, 4000);
          return name;
        });
      });
  }

  function api(path, opts) {
    return Wren.api(path, opts);
  }

  // ── The panel ──────────────────────────────────────────────────────────────
  function open(opts) {
    injectCSS();
    var entity = opts.entity;                       // 'staff' | 'children'
    var noun   = entity === 'staff' ? 'staff' : 'children';
    var ids    = Array.isArray(opts.ids) ? opts.ids.filter(function (n) { return Number.isFinite(+n); }) : null;
    var total  = opts.total != null ? opts.total : (ids ? ids.length : null);
    var filtered = !!(ids && total != null && ids.length < total);
    var onDone = opts.onDone || function () {};

    var body = document.createElement('div');
    body.className = 'wbe-wrap';
    body.innerHTML =
      '<p class="wbe-lede">Download the rows you can see, change them in a spreadsheet, and upload the file back. ' +
      'You will see exactly which cells would change before anything is saved.</p>' +

      '<div class="wbe-step">' +
        '<div class="wbe-step-h"><span class="wbe-step-n">1</span>Download</div>' +
        '<div class="wbe-row">' +
          '<button class="btn btn-sm btn-primary" data-wbe="dl-filtered"></button>' +
          (filtered ? '<button class="btn btn-sm btn-ghost" data-wbe="dl-all"></button>' : '') +
        '</div>' +
        '<div class="wbe-note">Keep the <code>id</code> column — it is how each row is matched back. ' +
          'A blank cell means <em>no change</em>; to empty a field on purpose, type <code>--CLEAR--</code>.</div>' +
        '<div class="wbe-cols" data-wbe="cols"></div>' +
      '</div>' +

      '<div class="wbe-step">' +
        '<div class="wbe-step-h"><span class="wbe-step-n">2</span>Upload and check</div>' +
        '<div class="wbe-drop" data-wbe="drop">Drop the edited CSV here, or click to choose it' +
          '<input type="file" accept=".csv,text/csv" data-wbe="file" style="display:none">' +
        '</div>' +
        '<div data-wbe="result" style="margin-top:12px"></div>' +
      '</div>' +

      '<div class="wbe-step">' +
        '<div class="wbe-step-h"><span class="wbe-step-n">3</span>Recent uploads</div>' +
        '<div class="wbe-hist" data-wbe="history">Loading…</div>' +
      '</div>';

    var q = function (n) { return body.querySelector('[data-wbe="' + n + '"]'); };

    q('dl-filtered').textContent = '↓ Download ' +
      (ids ? plural(ids.length, 'row') + (filtered ? ' on screen' : '') : 'CSV');
    if (filtered) q('dl-all').textContent = '↓ Download all ' + total;

    var modal = Wren.modal('Bulk edit ' + noun + ' by CSV', body, [{ label: 'Close', class: 'btn-ghost' }]);

    // What may and may not be edited — read from the server so this panel and the
    // validator can never drift into disagreeing about the allowlist.
    api('/api/bulk-edit/' + entity + '/fields').then(function (d) {
      var editable = (d.columns || []).filter(function (c) { return c.editable; });
      q('cols').innerHTML =
        '<strong>You can change:</strong> ' + editable.map(function (c) { return '<code>' + esc(c.key) + '</code>'; }).join(' ') +
        '<br><strong>Refused:</strong> ' + esc(d.blocked_note || '');
    }).catch(function () { q('cols').textContent = ''; });

    function doDownload(useIds) {
      var url = '/api/bulk-edit/' + entity + '/export.csv' + (useIds && ids ? '?ids=' + ids.join(',') : '');
      download(url, entity + '-bulk-edit.csv')
        .then(function (n) { Wren.toast('Downloaded ' + n, 'success'); })
        .catch(function (e) { Wren.toast('Could not download — ' + (e.message || 'error'), 'error'); });
    }
    q('dl-filtered').addEventListener('click', function () { doDownload(true); });
    if (filtered) q('dl-all').addEventListener('click', function () { doDownload(false); });

    // ── Upload → preview ────────────────────────────────────────────────────
    var drop = q('drop'), file = q('file'), result = q('result');
    drop.addEventListener('click', function () { file.click(); });
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
    file.addEventListener('change', function () { if (file.files[0]) readFile(file.files[0]); });

    function readFile(f) {
      var reader = new FileReader();
      reader.onload = function () { preview(String(reader.result || ''), f.name); };
      reader.onerror = function () { Wren.toast('Could not read that file', 'error'); };
      reader.readAsText(f, 'utf-8');
    }

    function preview(csv, filename) {
      result.innerHTML = '<div class="wbe-note">Checking ' + esc(filename) + '…</div>';
      api('/api/bulk-edit/' + entity + '/preview', { method: 'POST', body: { csv: csv } })
        .then(function (d) { renderPreview(d, csv, filename); })
        .catch(function (e) { renderFatal(e); });
    }

    function renderFatal(e) {
      // A file-level refusal: a blocked column, no id column, a duplicate header.
      // These name the problem rather than showing a half-usable preview.
      result.innerHTML =
        '<div class="wbe-banner err"><strong>This file was not read.</strong><br>' +
        esc((e && (e.message || e.error)) || 'Something went wrong reading that file.') + '</div>';
    }

    function renderPreview(d, csv, filename) {
      var c = d.counts || {};
      var canApply = c.cells_changed > 0 && !(d.rejects || []).length;

      var html = '';

      if ((d.rejects || []).length) {
        html += '<div class="wbe-banner err"><strong>' + plural(c.rows_rejected, 'row') +
          ' could not be read, so nothing can be applied yet.</strong><br>' +
          'An upload is all-or-nothing — a half-applied spreadsheet is worse than a rejected one. ' +
          'Fix the cells below and upload the file again.</div>';
      }
      if ((d.ignored_columns || []).length) {
        html += '<div class="wbe-banner warn">Ignored ' +
          plural(d.ignored_columns.length, 'column') + ' that Wren does not recognise: ' +
          d.ignored_columns.map(esc).join(', ') + '. Nothing in ' +
          (d.ignored_columns.length === 1 ? 'it' : 'them') + ' will be saved.</div>';
      }

      html += '<div class="wbe-counts">' +
        '<div class="wbe-count"><b>' + (c.rows_in_file || 0) + '</b><span>rows in file</span></div>' +
        '<div class="wbe-count changed"><b>' + (c.cells_changed || 0) + '</b><span>cells to change</span></div>' +
        '<div class="wbe-count"><b>' + (c.rows_changed || 0) + '</b><span>rows affected</span></div>' +
        '<div class="wbe-count"><b>' + (c.rows_unchanged || 0) + '</b><span>unchanged</span></div>' +
        '<div class="wbe-count' + (c.rows_rejected ? ' bad' : '') + '"><b>' + (c.rows_rejected || 0) + '</b><span>rejected</span></div>' +
        '</div>';

      if ((d.rejects || []).length) {
        html += '<div class="wbe-tablewrap"><table class="wbe-table"><thead><tr>' +
          '<th>Line</th><th>Cell</th><th>Why it was rejected</th></tr></thead><tbody>' +
          d.rejects.map(function (r) {
            return '<tr><td>' + esc(r.line) + '</td><td><code>' + esc(r.cell) + '</code></td>' +
              '<td class="wbe-bad">' + esc(r.reason) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }

      if (c.cells_changed) {
        html += '<div class="wbe-note" style="margin-top:12px"><strong>These cells, and nothing else, will change:</strong></div>' +
          '<div class="wbe-tablewrap" style="margin-top:6px"><table class="wbe-table"><thead><tr>' +
          '<th>Line</th><th>Who</th><th>Field</th><th>Now</th><th>Becomes</th></tr></thead><tbody>' +
          d.changes.map(function (ch) {
            return '<tr><td>' + esc(ch.line) + '</td><td>' + esc(ch.name) + '</td><td>' + esc(ch.label) + '</td>' +
              '<td class="wbe-old">' + val(ch.old) + '</td><td class="wbe-new">' + val(ch.new) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      } else if (!(d.rejects || []).length) {
        html += '<div class="wbe-banner ok">Nothing to change — every cell in that file already matches what Wren holds.</div>';
      }

      html += '<div class="wbe-row" style="margin-top:12px">' +
        (canApply
          ? '<button class="btn btn-sm btn-primary" data-wbe="apply">Apply ' + plural(c.cells_changed, 'change') + '</button>'
          : '') +
        '<button class="btn btn-sm btn-ghost" data-wbe="again">Choose a different file</button></div>';

      result.innerHTML = html;
      var againBtn = result.querySelector('[data-wbe="again"]');
      if (againBtn) againBtn.addEventListener('click', function () { file.value = ''; file.click(); });

      var applyBtn = result.querySelector('[data-wbe="apply"]');
      if (applyBtn) applyBtn.addEventListener('click', function () {
        applyBtn.disabled = true;
        applyBtn.textContent = 'Applying…';
        api('/api/bulk-edit/' + entity + '/apply', {
          method: 'POST',
          body: { csv: csv, checksum: d.checksum, filename: filename },
        }).then(function (r) {
          renderApplied(r);
          loadHistory();
          onDone();
        }).catch(function (e) {
          applyBtn.disabled = false;
          applyBtn.textContent = 'Apply ' + plural(c.cells_changed, 'change');
          renderApplyError(e);
        });
      });
    }

    function renderApplyError(e) {
      var banner = document.createElement('div');
      banner.className = 'wbe-banner err';
      var msg = (e && (e.message || e.error)) || 'Nothing was applied.';
      banner.innerHTML = '<strong>Nothing was applied.</strong><br>' + esc(msg);
      result.insertBefore(banner, result.firstChild);
      Wren.toast('Nothing was applied', 'error');
    }

    function renderApplied(r) {
      result.innerHTML =
        '<div class="wbe-banner ok"><strong>Saved.</strong> ' +
        plural(r.applied, 'cell') + ' changed across ' + plural(r.rows, 'row') + '. ' +
        'Upload #' + esc(r.batch_id) + ' — you can undo it below.</div>' +
        (r.changes && r.changes.length
          ? '<div class="wbe-tablewrap"><table class="wbe-table"><thead><tr>' +
            '<th>Who</th><th>Field</th><th>Was</th><th>Now</th></tr></thead><tbody>' +
            r.changes.map(function (ch) {
              return '<tr><td>' + esc(ch.name) + '</td><td>' + esc(ch.label) + '</td>' +
                '<td class="wbe-old">' + val(ch.old) + '</td><td class="wbe-new">' + val(ch.new) + '</td></tr>';
            }).join('') + '</tbody></table></div>'
          : '') +
        '<div class="wbe-row" style="margin-top:12px">' +
        '<button class="btn btn-sm btn-ghost" data-wbe="again">Upload another file</button></div>';
      result.querySelector('[data-wbe="again"]').addEventListener('click', function () { file.value = ''; file.click(); });
      Wren.toast(plural(r.applied, 'change') + ' saved', 'success');
    }

    // ── History ─────────────────────────────────────────────────────────────
    function loadHistory() {
      var host = q('history');
      api('/api/bulk-edit/batches?entity=' + entity + '&limit=10').then(function (d) {
        var rows = (d.batches || []).filter(function (b) { return b.kind === 'apply'; });
        if (!rows.length) { host.innerHTML = '<div class="wbe-note">No CSV uploads yet.</div>'; return; }
        host.innerHTML = rows.map(function (b) {
          var when = b.created_at ? new Date(b.created_at).toLocaleString('en-GB') : '';
          return '<div class="wbe-hist-row">' +
            '<div class="wbe-hist-main"><div>#' + esc(b.id) + ' · ' + plural(b.cells_changed, 'cell') +
              ' across ' + plural(b.rows_changed, 'row') + '</div>' +
            '<div class="wbe-hist-sub">' + esc(when) + (b.actor_display ? ' · ' + esc(b.actor_display) : '') +
              (b.filename ? ' · ' + esc(b.filename) : '') + '</div></div>' +
            (b.undone_at
              ? '<span class="wbe-hist-sub">undone</span>'
              : '<button class="btn btn-sm btn-ghost" data-undo="' + esc(b.id) + '">Undo</button>') +
            '</div>';
        }).join('');
        host.querySelectorAll('[data-undo]').forEach(function (btn) {
          btn.addEventListener('click', function () { confirmUndo(btn.dataset.undo, btn); });
        });
      }).catch(function () { host.innerHTML = '<div class="wbe-note">Could not load recent uploads.</div>'; });
    }

    function confirmUndo(id, btn) {
      btn.disabled = true; btn.textContent = 'Undoing…';
      api('/api/bulk-edit/batches/' + id + '/undo', { method: 'POST' }).then(function (r) {
        Wren.toast('Upload #' + id + ' undone — ' + plural(r.reverted, 'cell') + ' put back', 'success');
        loadHistory();
        onDone();
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = 'Undo';
        // The commonest refusal is "someone has changed this again since" — say
        // which, rather than a bare failure.
        var msg = (e && (e.message || e.error)) || 'Could not undo that upload.';
        Wren.modal('Nothing was undone', '<div style="font-size:.85rem;line-height:1.6;color:var(--c-muted)">' +
          esc(msg) +
          ((e && e.drifted && e.drifted.length)
            ? '<ul style="margin-top:10px">' + e.drifted.slice(0, 12).map(function (x) {
                return '<li>' + esc(x.name || ('#' + x.id)) + ' — ' + esc(x.field) + ': ' + esc(x.reason) + '</li>';
              }).join('') + '</ul>'
            : '') +
          '</div>', [{ label: 'Close' }]);
      });
    }

    loadHistory();
    return modal;
  }

  window.WrenBulkEdit = { open: open };
})();
