/* b165 — Revision / flashcard cards renderer (demo primary & secondary).
 * Self-contained, no dependencies. Mounts into #revision-cards-root.
 * Reads /api/revision-cards (index) and /api/revision-cards/:slug (full card).
 * Features: key-stage + subject filters, expandable cards, tap-to-reveal quiz
 * answers (flashcard behaviour), and an A5 2-up print pack.
 */
(function () {
  'use strict';

  var ROOT_ID = 'revision-cards-root';
  var state = { index: [], full: {}, ks: '', subject: '', q: '' };

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function api(path) {
    return fetch(path, { cache: 'no-cache', credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  function subjects() {
    var seen = {}, out = [];
    state.index.forEach(function (c) { if (c.subject && !seen[c.subject]) { seen[c.subject] = 1; out.push(c.subject); } });
    return out.sort();
  }
  function keyStages() {
    var seen = {}, out = [];
    state.index.forEach(function (c) { if (c.key_stage && !seen[c.key_stage]) { seen[c.key_stage] = 1; out.push(c.key_stage); } });
    return out.sort();
  }
  function filtered() {
    var q = state.q.trim().toLowerCase();
    return state.index.filter(function (c) {
      if (state.ks && c.key_stage !== state.ks) return false;
      if (state.subject && c.subject !== state.subject) return false;
      if (q && (String(c.title).toLowerCase().indexOf(q) < 0 &&
                String(c.strapline).toLowerCase().indexOf(q) < 0 &&
                String(c.subject).toLowerCase().indexOf(q) < 0)) return false;
      return true;
    });
  }

  function toolbar() {
    var bar = el('div', 'rc-toolbar');

    var ksWrap = el('div', 'rc-chips');
    ksWrap.appendChild(chip('All stages', state.ks === '', function () { state.ks = ''; render(); }));
    keyStages().forEach(function (ks) {
      ksWrap.appendChild(chip(ks, state.ks === ks, function () { state.ks = ks; render(); }));
    });
    bar.appendChild(ksWrap);

    var sel = el('select', 'rc-select');
    sel.appendChild(new Option('All subjects', ''));
    subjects().forEach(function (s) { var o = new Option(s, s); if (s === state.subject) o.selected = true; sel.appendChild(o); });
    sel.onchange = function () { state.subject = sel.value; render(); };
    bar.appendChild(sel);

    var search = el('input', 'rc-search');
    search.type = 'search'; search.placeholder = 'Search cards…'; search.value = state.q;
    search.oninput = function () { state.q = search.value; renderGridOnly(); };
    bar.appendChild(search);

    var printBtn = el('button', 'rc-print-btn', '🖨 Print pack');
    printBtn.onclick = printPack;
    bar.appendChild(printBtn);

    return bar;
  }

  function chip(label, active, onClick) {
    var c = el('button', 'rc-chip' + (active ? ' rc-chip-active' : ''), esc(label));
    c.onclick = onClick;
    return c;
  }

  function cardTile(item) {
    var t = el('article', 'rc-card');
    t.appendChild(el('div', 'rc-badges',
      '<span class="rc-badge rc-badge-ks">' + esc(item.key_stage || '') + '</span>' +
      '<span class="rc-badge rc-badge-subj">' + esc(item.subject || '') + '</span>'));
    t.appendChild(el('h3', 'rc-title', esc(item.title)));
    t.appendChild(el('p', 'rc-strap', esc(item.strapline)));
    var body = el('div', 'rc-body');
    t.appendChild(body);

    var open = false;
    var toggle = el('button', 'rc-open-btn', 'Open card ▾');
    toggle.onclick = function () {
      open = !open;
      toggle.textContent = open ? 'Close ▴' : 'Open card ▾';
      if (open && !body.dataset.loaded) {
        body.innerHTML = '<p class="rc-loading">Loading…</p>';
        loadFull(item.slug).then(function (card) {
          body.dataset.loaded = '1';
          body.innerHTML = '';
          body.appendChild(cardDetail(card));
        }).catch(function () { body.innerHTML = '<p class="rc-loading">Could not load this card.</p>'; });
      }
      body.style.display = open ? 'block' : 'none';
    };
    body.style.display = 'none';
    t.appendChild(toggle);
    return t;
  }

  function section(heading, items) {
    var s = el('div', 'rc-section');
    var ul = el('ul', 'rc-list');
    (items || []).forEach(function (x) { ul.appendChild(el('li', null, esc(x))); });
    s.appendChild(el('h4', 'rc-subhead', esc(heading)));
    s.appendChild(ul);
    return s;
  }

  function cardDetail(card) {
    var d = el('div', 'rc-detail');
    if (Array.isArray(card.facts)) d.appendChild(section('Key facts', card.facts));

    if (Array.isArray(card.quick_quiz) && card.quick_quiz.length) {
      var qz = el('div', 'rc-section');
      qz.appendChild(el('h4', 'rc-subhead', 'Quick quiz (tap to reveal)'));
      card.quick_quiz.forEach(function (qa) {
        var row = el('div', 'rc-quiz');
        row.appendChild(el('div', 'rc-q', esc(qa.q)));
        var a = el('div', 'rc-a', esc(qa.a));
        a.style.display = 'none';
        var btn = el('button', 'rc-reveal', 'Show answer');
        btn.onclick = function () {
          var show = a.style.display === 'none';
          a.style.display = show ? 'block' : 'none';
          btn.textContent = show ? 'Hide answer' : 'Show answer';
        };
        row.appendChild(btn); row.appendChild(a);
        qz.appendChild(row);
      });
      d.appendChild(qz);
    }

    if (Array.isArray(card.teacher_tips)) d.appendChild(section('Teacher tips', card.teacher_tips));
    return d;
  }

  function loadFull(slug) {
    if (state.full[slug]) return Promise.resolve(state.full[slug]);
    return api('/api/revision-cards/' + encodeURIComponent(slug)).then(function (c) { state.full[slug] = c; return c; });
  }

  var gridEl = null;
  function renderGridOnly() {
    if (!gridEl) return;
    gridEl.innerHTML = '';
    var items = filtered();
    if (!items.length) { gridEl.appendChild(el('p', 'rc-empty', 'No cards match your filters.')); return; }
    items.forEach(function (it) { gridEl.appendChild(cardTile(it)); });
    var count = document.getElementById('rc-count');
    if (count) count.textContent = items.length + ' card' + (items.length === 1 ? '' : 's');
  }

  function render() {
    var root = document.getElementById(ROOT_ID);
    if (!root) return;
    root.innerHTML = '';
    root.appendChild(toolbar());
    root.appendChild(el('div', 'rc-count', '<span id="rc-count"></span>'));
    gridEl = el('div', 'rc-grid');
    root.appendChild(gridEl);
    renderGridOnly();
  }

  function printPack() {
    var items = filtered();
    Promise.all(items.map(function (i) { return loadFull(i.slug); })).then(function (cards) {
      var w = window.open('', '_blank');
      if (!w) { alert('Please allow pop-ups to print the pack.'); return; }
      var html = '<!doctype html><html><head><meta charset="utf-8"><title>Revision cards</title><style>' +
        '@page{size:A4;margin:10mm}' +
        'body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111}' +
        '.pk{display:grid;grid-template-columns:1fr 1fr;gap:8mm}' +
        '.pc{border:1px solid #333;border-radius:6px;padding:6mm;break-inside:avoid;page-break-inside:avoid}' +
        '.pc h2{font-size:13pt;margin:0 0 2mm}.pc .b{font-size:8pt;color:#555;text-transform:uppercase;letter-spacing:.5px}' +
        '.pc .s{font-style:italic;font-size:9pt;margin:1mm 0 3mm;color:#333}' +
        '.pc ul{margin:0 0 3mm;padding-left:5mm}.pc li{font-size:8.5pt;margin-bottom:1mm}' +
        '.pc h3{font-size:9pt;margin:2mm 0 1mm}.pc .qa{font-size:8.5pt;margin-bottom:1mm}.pc .qa b{color:#000}' +
        '</style></head><body><div class="pk">' +
        cards.map(function (c) {
          return '<div class="pc"><div class="b">' + esc(c.key_stage) + ' · ' + esc(c.subject) + '</div>' +
            '<h2>' + esc(c.title) + '</h2><div class="s">' + esc(c.strapline) + '</div>' +
            '<h3>Key facts</h3><ul>' + (c.facts || []).map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>' +
            '<h3>Quick quiz</h3>' + (c.quick_quiz || []).map(function (q) { return '<div class="qa"><b>Q:</b> ' + esc(q.q) + ' <b>A:</b> ' + esc(q.a) + '</div>'; }).join('') +
            '</div>';
        }).join('') + '</div></body></html>';
      w.document.write(html); w.document.close();
      w.focus();
      setTimeout(function () { w.print(); }, 300);
    });
  }

  function boot() {
    var root = document.getElementById(ROOT_ID);
    if (!root) return;
    root.innerHTML = '<p class="rc-loading">Loading revision cards…</p>';
    api('/api/revision-cards').then(function (idx) {
      state.index = Array.isArray(idx) ? idx : [];
      render();
    }).catch(function (e) {
      root.innerHTML = '<p class="rc-loading">Could not load cards (' + esc(e.message) + ').</p>';
    });
  }

  // Wait for the shell if present, else boot directly.
  if (window.Wren && document.getElementById(ROOT_ID)) { boot(); }
  else {
    document.addEventListener('wren:ready', boot);
    document.addEventListener('DOMContentLoaded', function () { setTimeout(function () {
      var r = document.getElementById(ROOT_ID);
      if (r && !r.dataset.booted) { r.dataset.booted = '1'; boot(); }
    }, 600); });
  }
})();
