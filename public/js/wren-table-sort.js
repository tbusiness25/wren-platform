/* ─────────────────────────────────────────────────────────────────────────────
   Wren Table Sort — b170 (2026-07-28)
   Dependency-free click-to-sort for plain HTML tables (thead th → sorts tbody).

   Usage:  WrenTableSort.attach(document.getElementById('my-table'));
   - Click a header to sort asc, click again for desc. Arrow indicator + aria-sort.
   - Skips blank headers and headers containing inputs/buttons (checkbox cols).
   - Cell value: td.dataset.sort if present, else trimmed textContent.
   - Auto-detects money (£1,234.56), numbers, "x / y" fractions, and dates;
     falls back to case-insensitive text. Empty cells ("—", "-", "") sort last.
   - Rows carrying [data-sort-child] stay glued below the row above them
     (used for inline drill-down/expansion rows).
   - attach() is idempotent (safe to call on every section load).
──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.WrenTableSort) return;

  function cellValue(row, idx) {
    const td = row.cells[idx];
    if (!td) return '';
    if (td.dataset && td.dataset.sort !== undefined) return td.dataset.sort;
    return (td.textContent || '').trim();
  }

  // → { t: 2=numeric | 1=text, v: value|null (null = empty, always sorts last) }
  function parseVal(raw) {
    const v = String(raw).trim();
    if (v === '' || v === '—' || v === '-' || v === '–') return { t: 1, v: null };
    const num = v.replace(/[£,%\s]/g, '').replace(/−/g, '-').replace(/[▸▾]/g, '');
    if (/^[+-]?\d+(\.\d+)?h?$/.test(num)) return { t: 2, v: parseFloat(num) };
    const frac = num.match(/^(\d+)\/(\d+)$/);
    if (frac) return { t: 2, v: parseInt(frac[1], 10) };
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return { t: 2, v: Date.parse(v.slice(0, 10)) };
    if (/^\d{1,2} [A-Za-z]{3} \d{4}$/.test(v)) {
      const d = Date.parse(v);
      if (!isNaN(d)) return { t: 2, v: d };
    }
    return { t: 1, v: v.toLowerCase() };
  }

  function sortBy(table, th) {
    const idx   = th.cellIndex;
    const tbody = table.tBodies[0];
    if (!tbody) return;
    const dir = th.dataset.wtsDir === 'asc' ? 'desc' : 'asc';
    const mul = dir === 'asc' ? 1 : -1;

    Array.from(th.parentNode.cells).forEach(h => {
      delete h.dataset.wtsDir;
      h.removeAttribute('aria-sort');
      const a = h.querySelector('.wts-arrow');
      if (a) a.remove();
    });
    th.dataset.wtsDir = dir;
    th.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : 'descending');
    const arrow = document.createElement('span');
    arrow.className = 'wts-arrow';
    arrow.style.cssText = 'margin-left:4px;font-size:.85em;opacity:.9';
    arrow.textContent = dir === 'asc' ? '▲' : '▼';
    th.appendChild(arrow);

    // Group rows: [data-sort-child] rows stay glued to the row above.
    const groups = [];
    Array.from(tbody.rows).forEach(r => {
      if (r.hasAttribute('data-sort-child') && groups.length) groups[groups.length - 1].push(r);
      else groups.push([r]);
    });
    if (groups.length < 2) return;

    groups.map((g, i) => ({ g, i, k: parseVal(cellValue(g[0], idx)) }))
      .sort((a, b) => {
        const aE = a.k.v === null, bE = b.k.v === null;
        if (aE || bE) return aE && bE ? a.i - b.i : (aE ? 1 : -1); // empties last, always
        let c;
        if (a.k.t !== b.k.t) c = a.k.t === 2 ? -1 : 1;             // numbers before text
        else if (a.k.t === 1) c = a.k.v < b.k.v ? -1 : (a.k.v > b.k.v ? 1 : 0);
        else c = a.k.v - b.k.v;
        return (c * mul) || (a.i - b.i);                            // stable
      })
      .forEach(({ g }) => g.forEach(r => tbody.appendChild(r)));
  }

  function sortableHeader(th) {
    return (th.textContent || '').trim() && !th.querySelector('input,button,select');
  }

  function attach(table) {
    if (!table || table.dataset.wtsSortable) return;
    const thead = table.tHead;
    if (!thead || !thead.rows.length) return;
    table.dataset.wtsSortable = '1';
    thead.addEventListener('click', e => {
      const th = e.target.closest('th');
      if (!th || !thead.contains(th) || !sortableHeader(th)) return;
      sortBy(table, th);
    });
    Array.from(thead.rows[0].cells).forEach(th => {
      if (sortableHeader(th)) { th.style.cursor = 'pointer'; th.title = 'Click to sort'; }
    });
  }

  window.WrenTableSort = { attach };
})();
