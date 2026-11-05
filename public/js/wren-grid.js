/* ─────────────────────────────────────────────────────────────────────────────
   Wren Grid — b489 (2026-10-12)
   Shared sort + filter + search + CSV + mobile-card engine for plain HTML
   <table> elements. Supersedes ad-hoc per-page sorting; wren-table-sort.js
   (b170) is left untouched and still works for any page that only loads it.

   USAGE
   ------
   <table id="my-table">...</table>
   <script>WrenGrid.attach(document.getElementById('my-table'));</script>

   Call attach() again every time you re-render the table's rows (e.g. after a
   fetch rebuilds <tbody> via innerHTML) — it is cheap and idempotent. Search,
   filter values and sort column/direction are restored from localStorage on
   every call, so a full table rebuild does not lose the viewer's place.

   Give the <table> a stable `id` (or `data-grid-id="some-key"` if the id
   changes across renders) so its saved state has a stable key. Without
   either, a key is derived from the header text, which is fine as long as
   the columns don't change.

   PER-COLUMN OVERRIDES (on <th>)
   --------------------------------
   data-sort-type="text|number|money|date|fraction|none"   — force the sort/compare type;
                                                               "none" disables sort+filter for that column
   data-filter="text|select|number|date|none"              — force the filter control type;
                                                               "none" shows no filter for that column
   (left unset → auto-detected from the column's cell values: a column whose
   header is blank or whose cells are mostly buttons/links/inputs is treated
   as an actions column — "none" for both sort and filter.)

   PER-CELL OVERRIDES (on <td>)
   ------------------------------
   data-sort="raw value"      — value used for sort/filter comparisons instead of textContent
   data-export="raw value"    — value written to the CSV export instead of textContent/data-sort
   (a <tr data-sort-child> stays glued to the row above it — used for inline
   drill-down rows; it is not independently sortable or filterable, and
   follows its parent's visibility.)

   OPTIONS
   -------
   WrenGrid.attach(table, {
     id: 'explicit-key',      // overrides data-grid-id/id/derived key
     csv: false,              // hide the CSV export button
     search: false,           // hide the global search box
   });
──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.WrenGrid) return;

  // ── value parsing (shared by sort + filter + type detection) ──────────────
  function rawCellValue(td) {
    if (!td) return '';
    if (td.dataset && td.dataset.sort !== undefined) return td.dataset.sort;
    return (td.textContent || '').trim();
  }

  function detectType(raw) {
    const v = String(raw).trim();
    if (v === '' || v === '—' || v === '-' || v === '–') return { t: 'empty', v: null };
    const num = v.replace(/[£,%\s]/g, '').replace(/−/g, '-').replace(/[▲▼]/g, '');
    if (/^[+-]?\d+(\.\d+)?h?$/.test(num)) return { t: /£/.test(v) ? 'money' : 'number', v: parseFloat(num) };
    const frac = num.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (frac) return { t: 'fraction', v: parseInt(frac[1], 10), d: parseInt(frac[2], 10) };
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) { const d = Date.parse(v.slice(0, 10)); if (!isNaN(d)) return { t: 'date', v: d }; }
    if (/^\d{1,2} [A-Za-z]{3} \d{2,4}$/.test(v)) { const d = Date.parse(v); if (!isNaN(d)) return { t: 'date', v: d }; }
    return { t: 'text', v: v.toLowerCase() };
  }

  function parseAs(raw, type) {
    const v = String(raw).trim();
    if (v === '' || v === '—' || v === '-' || v === '–') return { v: null };
    if (type === 'number' || type === 'money') {
      const n = parseFloat(v.replace(/[£,%\s]/g, '').replace(/−/g, '-'));
      return { v: isNaN(n) ? null : n };
    }
    if (type === 'date') { const d = Date.parse(v.slice(0, 10)); return { v: isNaN(d) ? Date.parse(v) : d }; }
    if (type === 'fraction') { const m = v.replace(/[▲▼]/g, '').match(/^(\d+)\s*\/\s*(\d+)/); return { v: m ? parseInt(m[1], 10) : null }; }
    return { v: v.toLowerCase() };
  }

  function headerCells(table) {
    const thead = table.tHead;
    return thead && thead.rows.length ? Array.from(thead.rows[0].cells) : [];
  }

  function headerText(th) { return (th.textContent || '').trim(); }

  function ownText(td) {
    // textContent minus anything that lives inside an interactive control —
    // a cell holding only "<a>View</a> <button>Edit</button>" has non-empty
    // textContent but no text of its own, so it is still an actions column.
    const clone = td.cloneNode(true);
    clone.querySelectorAll('button,a,input,select').forEach(n => n.remove());
    return (clone.textContent || '').trim();
  }

  function isActionsHeader(th, table, idx) {
    if (th.dataset.sortType === 'none' || th.dataset.filter === 'none') return true;
    if (!headerText(th)) return true;
    if (th.querySelector('input,button,select')) return true;
    // sample cells: an actions column has no text of its own outside its controls
    const tbody = table.tBodies[0];
    if (!tbody) return false;
    let sampled = 0, interactive = 0;
    for (const row of tbody.rows) {
      if (row.hasAttribute('data-sort-child')) continue;
      const td = row.cells[idx];
      if (!td) continue;
      sampled++;
      // b500 — an editable grid cell (input/select, no own text) carries its real
      // value in data-sort, so it is NOT an actions cell even though it holds a
      // control. An ordinary actions cell (buttons/links) never sets data-sort.
      if (!ownText(td) && td.dataset.sort === undefined && td.querySelector('button,a,input,select')) interactive++;
      if (sampled >= 12) break;
    }
    return sampled > 0 && interactive === sampled;
  }

  // ── column metadata: type + (for filters) distinct values ─────────────────
  function buildColumns(table) {
    const ths = headerCells(table);
    const tbody = table.tBodies[0];
    const cols = ths.map((th, idx) => ({ th, idx, label: headerText(th) }));
    cols.forEach(col => {
      if (isActionsHeader(col.th, table, col.idx)) { col.sortType = 'none'; col.filterType = 'none'; return; }
      const forced = col.th.dataset.sortType;
      const seen = new Map(); // value text -> count
      const types = {};
      let sampled = 0;
      if (tbody) {
        for (const row of tbody.rows) {
          if (row.hasAttribute('data-sort-child')) continue;
          const td = row.cells[col.idx];
          if (!td) continue;
          const raw = rawCellValue(td);
          const text = String(raw).trim();
          if (text) seen.set(text, (seen.get(text) || 0) + 1);
          const d = detectType(raw);
          if (d.t !== 'empty') types[d.t] = (types[d.t] || 0) + 1;
          sampled++;
          if (sampled >= 300) break;
        }
      }
      let autoType = 'text';
      let best = 0;
      Object.keys(types).forEach(t => { if (types[t] > best) { best = types[t]; autoType = t; } });
      if (best === 0) autoType = 'text';
      col.sortType = forced || autoType;

      const forcedFilter = col.th.dataset.filter;
      if (forcedFilter) { col.filterType = forcedFilter; }
      else if (col.sortType === 'number' || col.sortType === 'money') col.filterType = 'number';
      else if (col.sortType === 'date') col.filterType = 'date';
      else if (col.sortType === 'text' && seen.size > 0 && seen.size <= 8 && seen.size < sampled * 0.6) col.filterType = 'select';
      else if (col.sortType === 'fraction') col.filterType = 'text';
      else col.filterType = 'text';
      col.distinct = Array.from(seen.keys()).sort((a, b) => a.localeCompare(b));
    });
    return cols;
  }

  // ── row grouping (parent row + glued [data-sort-child] rows) ──────────────
  function groupRows(tbody) {
    const groups = [];
    Array.from(tbody.rows).forEach(r => {
      // review fix: the "No rows match" placeholder is not a data row (it was counted, sorted and exported as one)
      if (r.classList.contains('wgrid-empty-row')) return;
      if (r.hasAttribute('data-sort-child') && groups.length) groups[groups.length - 1].push(r);
      else groups.push([r]);
    });
    return groups;
  }

  // ── storage ─────────────────────────────────────────────────────────────
  function storageKey(table, gid) { return 'wgrid:' + location.pathname + ':' + gid; }
  function loadState(key) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : {}; }
    catch (e) { return {}; }
  }
  function saveState(key, state) {
    try { localStorage.setItem(key, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  function simpleHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return Math.abs(h).toString(36);
  }
  function gridId(table, opts) {
    if (opts && opts.id) return opts.id;
    if (table.getAttribute('data-grid-id')) return table.getAttribute('data-grid-id');
    if (table.id) return table.id;
    return 'h' + simpleHash(headerCells(table).map(headerText).join('|'));
  }

  // ── styles (injected once) ─────────────────────────────────────────────
  function ensureStyles() {
    if (document.getElementById('wgrid-styles')) return;
    const style = document.createElement('style');
    style.id = 'wgrid-styles';
    style.textContent = `
.wgrid { margin-bottom: 4px; }
.wgrid-toolbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
.wgrid-search { flex:1 1 220px; min-width:140px; max-width:320px; background:var(--c-surface); border:1px solid var(--c-border-strong); color:var(--c-text); border-radius:8px; padding:7px 10px; font-size:.85rem; font-family:inherit; }
.wgrid-search:focus { outline:2px solid var(--c-blue); outline-offset:1px; }
.wgrid-count { color:var(--c-muted); font-size:.78rem; white-space:nowrap; }
.wgrid-btn { background:var(--c-surface); border:1px solid var(--c-border-strong); color:var(--c-text); border-radius:8px; padding:6px 12px; font-size:.8rem; font-family:inherit; cursor:pointer; white-space:nowrap; }
.wgrid-btn:hover { background:var(--c-surface-2); }
.wgrid-btn:focus-visible { outline:2px solid var(--c-blue); outline-offset:1px; }
.wgrid-btn.active { background:color-mix(in srgb, var(--c-blue) 16%, var(--c-surface)); border-color:var(--c-blue); color:var(--c-blue); }
.wgrid-filters { display:none; flex-wrap:wrap; gap:10px; padding:10px; margin-bottom:10px; background:var(--c-surface); border:1px solid var(--c-border); border-radius:10px; }
.wgrid-filters.open { display:flex; }
.wgrid-fgroup { display:flex; flex-direction:column; gap:3px; min-width:120px; }
.wgrid-fgroup label { font-size:.68rem; text-transform:uppercase; letter-spacing:.03em; color:var(--c-muted); font-weight:600; }
.wgrid-fgroup .wgrid-frow { display:flex; gap:4px; align-items:center; }
.wgrid-fgroup input, .wgrid-fgroup select { background:var(--c-surface-solid); border:1px solid var(--c-border-strong); color:var(--c-text); border-radius:6px; padding:5px 7px; font-size:.8rem; font-family:inherit; min-width:0; }
.wgrid-fgroup input[type=date] { min-width:118px; }
.wgrid-fgroup input[type=number] { width:76px; }
.wgrid-clear { font-size:.72rem; color:var(--c-blue); background:none; border:none; cursor:pointer; text-decoration:underline; padding:2px; align-self:flex-start; }
.wgrid thead th[data-wg-sortable] { cursor:pointer; }
.wgrid thead th[data-wg-sortable]:focus-visible { outline:2px solid var(--c-blue); outline-offset:1px; }
.wgrid .wgrid-arrow { margin-left:4px; font-size:.82em; opacity:.9; }
.wgrid-empty-row td { text-align:center; color:var(--c-muted); padding:22px !important; }
@media (max-width:600px) {
  .wgrid table, .wgrid tbody, .wgrid tr, .wgrid td { display:block; width:100%; box-sizing:border-box; }
  .wgrid thead { display:block; border-bottom:1px solid var(--c-border); margin-bottom:10px; padding-bottom:8px; }
  .wgrid thead tr { display:flex; flex-wrap:wrap; gap:6px; }
  .wgrid thead th { display:inline-flex; align-items:center; width:auto; box-sizing:border-box; padding:6px 10px; margin:0; border-top:none !important; background:var(--c-surface-2); border-radius:999px; font-size:.72rem; white-space:nowrap; }
  .wgrid thead th[data-wg-sortable] { background:var(--c-surface-2); }
  .wgrid thead th[aria-sort]{ background:color-mix(in srgb, var(--c-blue) 18%, var(--c-surface-2)); color:var(--c-blue); }
  .wgrid tbody tr { border:1px solid var(--c-border); border-radius:10px; padding:4px 10px; margin-bottom:10px; background:var(--c-surface); }
  .wgrid tbody tr.wgrid-empty-row { border:none; background:none; }
  .wgrid tbody td { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:7px 2px; border-top:1px solid var(--c-border); text-align:right; }
  .wgrid tbody tr > td:first-child { border-top:none; }
  .wgrid tbody td[data-wg-label]::before { content: attr(data-wg-label); font-weight:600; color:var(--c-muted); font-size:.7rem; text-transform:uppercase; letter-spacing:.03em; text-align:left; margin-right:8px; }
}
`;
    document.head.appendChild(style);
  }

  // ── CSV ─────────────────────────────────────────────────────────────────
  function csvEscape(s) {
    s = String(s == null ? '' : s);
    // review fix: neutralise spreadsheet formulas (=, @, tab/CR always; +/- unless the cell is a plain number like -2.5h or +3)
    if (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+-]\s?[£$€]?\d[\d,.]*\s?[A-Za-z%]*$/.test(s))) s = "'" + s;
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function exportCsv(table, cols, groups) {
    const exportCols = cols.filter(c => c.sortType !== 'none' || c.label);
    const header = exportCols.map(c => c.label || '').join(',');
    const lines = [header];
    groups.forEach(g => {
      const row = g[0];
      if (row.style.display === 'none') return;
      const cells = exportCols.map(c => {
        const td = row.cells[c.idx];
        if (!td) return '';
        const v = (td.dataset && td.dataset.export !== undefined) ? td.dataset.export : rawCellValue(td);
        return csvEscape(v);
      });
      lines.push(cells.join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const name = (document.title || 'export').replace(/[^\w-]+/g, '_').slice(0, 60);
    a.href = url;
    a.download = name + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ── main attach ─────────────────────────────────────────────────────────
  function attach(table, opts) {
    if (!table || !table.tBodies.length) return;
    opts = opts || {};
    ensureStyles();

    const gid = gridId(table, opts);
    const key = storageKey(table, gid);
    const state = Object.assign({ search: '', filters: {}, sort: null, filtersOpen: false }, loadState(key));

    const cols = buildColumns(table);

    // wrap table (move it inside a .wgrid if not already)
    let wrap = table.parentElement && table.parentElement.classList.contains('wgrid') ? table.parentElement : null;
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'wgrid';
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    } else {
      wrap.innerHTML = '';
      wrap.appendChild(table);
    }

    // toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'wgrid-toolbar';
    let searchInput = null;
    if (opts.search !== false) {
      searchInput = document.createElement('input');
      searchInput.type = 'search';
      searchInput.className = 'wgrid-search';
      searchInput.placeholder = 'Search…';
      searchInput.setAttribute('aria-label', 'Search ' + (document.title || 'table'));
      searchInput.value = state.search || '';
      toolbar.appendChild(searchInput);
    }
    const filterable = cols.filter(c => c.filterType !== 'none');
    let filterToggle = null;
    if (filterable.length) {
      filterToggle = document.createElement('button');
      filterToggle.type = 'button';
      filterToggle.className = 'wgrid-btn';
      filterToggle.textContent = 'Filters';
      toolbar.appendChild(filterToggle);
    }
    const countSpan = document.createElement('span');
    countSpan.className = 'wgrid-count';
    toolbar.appendChild(countSpan);
    let csvBtn = null;
    if (opts.csv !== false) {
      csvBtn = document.createElement('button');
      csvBtn.type = 'button';
      csvBtn.className = 'wgrid-btn';
      csvBtn.textContent = '⬇ CSV';
      csvBtn.style.marginLeft = 'auto';
      toolbar.appendChild(csvBtn);
    }
    wrap.insertBefore(toolbar, table);

    // filter panel
    let filterPanel = null;
    const fieldEls = {}; // idx -> {type, el(s)}
    if (filterable.length) {
      filterPanel = document.createElement('div');
      filterPanel.className = 'wgrid-filters';
      filterable.forEach(col => {
        const group = document.createElement('div');
        group.className = 'wgrid-fgroup';
        const label = document.createElement('label');
        label.textContent = col.label;
        group.appendChild(label);
        const rowEl = document.createElement('div');
        rowEl.className = 'wgrid-frow';
        const saved = state.filters[col.idx] || {};
        if (col.filterType === 'select') {
          const sel = document.createElement('select');
          sel.appendChild(new Option('All', ''));
          col.distinct.forEach(v => sel.appendChild(new Option(v, v)));
          sel.value = saved.eq || '';
          rowEl.appendChild(sel);
          fieldEls[col.idx] = { type: 'select', select: sel };
        } else if (col.filterType === 'date') {
          const from = document.createElement('input'); from.type = 'date'; from.value = saved.from || '';
          const to = document.createElement('input'); to.type = 'date'; to.value = saved.to || '';
          const sep = document.createElement('span'); sep.textContent = '–'; sep.style.color = 'var(--c-muted)';
          rowEl.appendChild(from); rowEl.appendChild(sep); rowEl.appendChild(to);
          fieldEls[col.idx] = { type: 'date', from, to };
        } else if (col.filterType === 'number') {
          const min = document.createElement('input'); min.type = 'number'; min.step = 'any'; min.placeholder = 'min'; min.value = saved.min != null ? saved.min : '';
          const max = document.createElement('input'); max.type = 'number'; max.step = 'any'; max.placeholder = 'max'; max.value = saved.max != null ? saved.max : '';
          const sep = document.createElement('span'); sep.textContent = '–'; sep.style.color = 'var(--c-muted)';
          rowEl.appendChild(min); rowEl.appendChild(sep); rowEl.appendChild(max);
          fieldEls[col.idx] = { type: 'number', min, max };
        } else {
          const txt = document.createElement('input'); txt.type = 'text'; txt.placeholder = 'contains…'; txt.value = saved.contains || '';
          rowEl.appendChild(txt);
          fieldEls[col.idx] = { type: 'text', input: txt };
        }
        group.appendChild(rowEl);
        filterPanel.appendChild(group);
      });
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'wgrid-clear';
      clear.textContent = 'Clear filters';
      filterPanel.appendChild(clear);
      wrap.insertBefore(filterPanel, table);

      clear.addEventListener('click', () => {
        Object.keys(fieldEls).forEach(idx => {
          const f = fieldEls[idx];
          if (f.type === 'select') f.select.value = '';
          else if (f.type === 'date') { f.from.value = ''; f.to.value = ''; }
          else if (f.type === 'number') { f.min.value = ''; f.max.value = ''; }
          else f.input.value = '';
        });
        update();
      });

      const hasActiveSaved = Object.keys(state.filters).length > 0;
      if (state.filtersOpen || hasActiveSaved) { filterPanel.classList.add('open'); if (filterToggle) filterToggle.classList.add('active'); }
      filterToggle.addEventListener('click', () => {
        const open = filterPanel.classList.toggle('open');
        filterToggle.classList.toggle('active', open);
        state.filtersOpen = open;
        saveState(key, state);
      });
    }

    // thead click-to-sort
    const thead = table.tHead;
    if (thead && thead.rows.length) {
      Array.from(thead.rows[0].cells).forEach((th, idx) => {
        const col = cols[idx];
        if (!col || col.sortType === 'none') return;
        th.setAttribute('data-wg-sortable', '1');
        th.setAttribute('tabindex', '0');
        th.setAttribute('role', 'button');
        th.title = 'Click to sort';
        const trigger = () => sortBy(idx);
        th.addEventListener('click', trigger);
        th.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); trigger(); } });
      });
    }

    // data-wg-label for mobile cards
    const tbody = table.tBodies[0];
    Array.from(tbody.rows).forEach(row => {
      Array.from(row.cells).forEach((td, idx) => {
        const col = cols[idx];
        if (col && col.label && !td.hasAttribute('data-wg-label')) td.setAttribute('data-wg-label', col.label);
      });
    });

    // ── b500 — editable mode ───────────────────────────────────────────────
    // Opt in with <table data-wg-editable="1">. A cell's control (input/select/
    // checkbox) keeps td.dataset.sort in sync as the viewer types/picks, so sort
    // and filter never go stale against an unsaved edit, and emits 'wgrid:cellcommit'
    // on the table (bubbles) when a value is actually committed (blur or Enter
    // for text/date/number, change for select/checkbox) — the host page owns
    // autosave, validation and undo; this file only keeps the grid's own state
    // (sort/filter/search/CSV) agreeing with what's on screen.
    if (table.dataset.wgEditable === '1') {
      const controlValue = (ctrl) => ctrl.type === 'checkbox' ? (ctrl.checked ? '1' : '') : ctrl.value;
      const syncAndNotify = (ctrl, commit) => {
        const td = ctrl.closest('td');
        if (!td) return;
        const value = controlValue(ctrl);
        td.dataset.sort = value;
        if (commit) {
          const tr = ctrl.closest('tr');
          const idx = Array.prototype.indexOf.call(tr.cells, td);
          table.dispatchEvent(new CustomEvent('wgrid:cellcommit', { bubbles: true, detail: {
            td, tr, colIdx: idx, field: td.dataset.field || ctrl.name || null, value,
          } }));
          update();
        }
      };
      tbody.addEventListener('input', (e) => {
        const ctrl = e.target.closest('input,select');
        if (ctrl && (ctrl.tagName === 'SELECT' ? false : ctrl.type !== 'checkbox')) syncAndNotify(ctrl, false);
      });
      tbody.addEventListener('change', (e) => {
        const ctrl = e.target.closest('input,select');
        if (ctrl && (ctrl.tagName === 'SELECT' || ctrl.type === 'checkbox')) syncAndNotify(ctrl, true);
      });
      tbody.addEventListener('blur', (e) => {
        const ctrl = e.target.closest('input');
        if (ctrl && ctrl.type !== 'checkbox') syncAndNotify(ctrl, true);
      }, true);
      tbody.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const ctrl = e.target.closest('input');
        if (ctrl && ctrl.type !== 'checkbox') { e.preventDefault(); ctrl.blur(); }
      });
    }

    function currentGroups() { return groupRows(table.tBodies[0]); }

    function sortBy(idx) {
      const col = cols[idx];
      const dir = (state.sort && state.sort.idx === idx && state.sort.dir === 'asc') ? 'desc' : 'asc';
      state.sort = { idx, dir };
      saveState(key, state);
      applySortIndicators();
      runSort();
      update();
    }

    function applySortIndicators() {
      if (!thead || !thead.rows.length) return;
      Array.from(thead.rows[0].cells).forEach(h => {
        h.removeAttribute('aria-sort');
        const a = h.querySelector('.wgrid-arrow');
        if (a) a.remove();
      });
      if (!state.sort) return;
      const th = thead.rows[0].cells[state.sort.idx];
      if (!th) return;
      th.setAttribute('aria-sort', state.sort.dir === 'asc' ? 'ascending' : 'descending');
      const arrow = document.createElement('span');
      arrow.className = 'wgrid-arrow';
      arrow.textContent = state.sort.dir === 'asc' ? '▲' : '▼';
      th.appendChild(arrow);
    }

    function runSort() {
      if (!state.sort) return;
      const col = cols[state.sort.idx];
      if (!col || col.sortType === 'none') return;
      const mul = state.sort.dir === 'asc' ? 1 : -1;
      const groups = currentGroups();
      if (groups.length < 2) return;
      groups.map((g, i) => ({ g, i, k: parseAs(rawCellValue(g[0].cells[col.idx]), col.sortType) }))
        .sort((a, b) => {
          const aE = a.k.v === null, bE = b.k.v === null;
          if (aE || bE) return aE && bE ? a.i - b.i : (aE ? 1 : -1);
          let c;
          if (typeof a.k.v === 'number' && typeof b.k.v === 'number') c = a.k.v - b.k.v;
          else c = a.k.v < b.k.v ? -1 : (a.k.v > b.k.v ? 1 : 0);
          return (c * mul) || (a.i - b.i);
        })
        .forEach(({ g }) => g.forEach(r => tbody.appendChild(r)));
    }

    function rowMatchesFilters(row) {
      for (const idxStr of Object.keys(state.filters)) {
        const idx = Number(idxStr);
        const f = state.filters[idx];
        if (!f) continue;
        const td = row.cells[idx];
        const raw = rawCellValue(td);
        if (f.eq !== undefined) {
          if (String(raw).trim() !== f.eq) return false;
        } else if (f.contains !== undefined) {
          if (!String(raw).toLowerCase().includes(f.contains.toLowerCase())) return false;
        } else if (f.from !== undefined || f.to !== undefined) {
          const d = parseAs(raw, 'date').v;
          if (d === null) return false;
          if (f.from && d < Date.parse(f.from)) return false;
          if (f.to && d > Date.parse(f.to) + 86399999) return false;
        } else if (f.min !== undefined || f.max !== undefined) {
          const n = parseAs(raw, 'number').v;
          if (n === null) return false;
          if (f.min !== '' && f.min != null && n < f.min) return false;
          if (f.max !== '' && f.max != null && n > f.max) return false;
        }
      }
      return true;
    }

    function groupText(g) {
      return g.map(r => (r.textContent || '')).join(' ').toLowerCase();
    }

    function readFilterState() {
      const filters = {};
      Object.keys(fieldEls).forEach(idxStr => {
        const idx = Number(idxStr);
        const f = fieldEls[idx];
        if (f.type === 'select') { if (f.select.value) filters[idx] = { eq: f.select.value }; }
        else if (f.type === 'date') { if (f.from.value || f.to.value) filters[idx] = { from: f.from.value, to: f.to.value }; }
        else if (f.type === 'number') {
          const min = f.min.value !== '' ? parseFloat(f.min.value) : undefined;
          const max = f.max.value !== '' ? parseFloat(f.max.value) : undefined;
          if (min !== undefined || max !== undefined) filters[idx] = { min, max };
        } else { if (f.input.value) filters[idx] = { contains: f.input.value }; }
      });
      return filters;
    }

    function update() {
      state.filters = readFilterState();
      state.search = searchInput ? searchInput.value : '';
      saveState(key, state);

      const groups = currentGroups();
      const search = (state.search || '').toLowerCase();
      let visible = 0;
      groups.forEach(g => {
        const matches = rowMatchesFilters(g[0]) && (!search || groupText(g).includes(search));
        g.forEach((r, i) => { r.style.display = matches ? '' : 'none'; });
        if (matches) visible++;
      });

      let emptyRow = tbody.querySelector('tr.wgrid-empty-row');
      if (visible === 0 && groups.length > 0) {
        if (!emptyRow) {
          emptyRow = document.createElement('tr');
          emptyRow.className = 'wgrid-empty-row';
          const td = document.createElement('td');
          td.colSpan = cols.length || 1;
          td.textContent = 'No rows match your search/filters.';
          emptyRow.appendChild(td);
          tbody.appendChild(emptyRow);
        }
        emptyRow.style.display = '';
      } else if (emptyRow) {
        emptyRow.style.display = 'none';
      }

      countSpan.textContent = groups.length ? (visible + ' of ' + groups.length) : '';
    }

    if (searchInput) {
      let t;
      searchInput.addEventListener('input', () => { clearTimeout(t); t = setTimeout(update, 150); });
    }
    Object.keys(fieldEls).forEach(idxStr => {
      const f = fieldEls[idxStr];
      const els = f.type === 'select' ? [f.select] : f.type === 'date' ? [f.from, f.to] : f.type === 'number' ? [f.min, f.max] : [f.input];
      els.forEach(el => el.addEventListener(f.type === 'select' ? 'change' : 'input', () => update()));
    });
    if (csvBtn) csvBtn.addEventListener('click', () => exportCsv(table, cols, currentGroups()));

    // restore saved sort
    if (state.sort && cols[state.sort.idx] && cols[state.sort.idx].sortType !== 'none') {
      applySortIndicators();
      runSort();
    }
    update();
  }

  window.WrenGrid = { attach };
})();
