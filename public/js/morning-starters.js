/* b353 — Morning Starters browser renderer. Mounts into #ms-root.
 * Reads /api/morning-starters (index), /weeks (picker grid), /day/:t/:w/:d
 * (one day's slides). Draws slides using the SAME engine the print pack uses
 * (window.WrenMorningStartersRender, loaded from morning-starters-render.js)
 * so the on-screen view and the printed page are never two implementations.
 */
(function () {
  'use strict';
  var ROOT_ID = 'ms-root';
  var RENDER = window.WrenMorningStartersRender;
  var state = { weeks: [], index: [], term: null, week: null, day: null, slides: [], teacherMode: false };

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) { return RENDER.esc(s); }
  function api(path) {
    return fetch(path, { cache: 'no-cache', credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  var DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

  function weekPicker() {
    var wrap = el('div');
    wrap.appendChild(el('h3', 'ms-section-title', 'Choose a week'));
    var grid = el('div', 'ms-week-grid');
    state.weeks.forEach(function (w) {
      var card = el('div', 'ms-week-card', '<h4>' + esc(w.year_group || '') + ' — Term ' + w.term + ', Week ' + w.week + '</h4><p>' + w.slide_count + ' slide' + (w.slide_count === 1 ? '' : 's') + ' · ' + w.day_count + ' day' + (w.day_count === 1 ? '' : 's') + '</p>');
      card.onclick = function () { state.term = w.term; state.week = w.week; state.day = null; render(); };
      grid.appendChild(card);
    });
    wrap.appendChild(grid);
    return wrap;
  }

  function dayStrip() {
    var strip = el('div', 'ms-day-strip');
    var days = state.index.filter(function (it) { return it.term === state.term && it.week === state.week; })
      .map(function (it) { return it.day; })
      .filter(function (d, i, arr) { return arr.indexOf(d) === i; })
      .sort(function (a, b) { return DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b); });
    days.forEach(function (d) {
      var btn = el('button', 'ms-day-btn' + (state.day === d ? ' ms-day-active' : ''), esc(d));
      btn.onclick = function () { state.day = d; loadDay(); };
      strip.appendChild(btn);
    });
    return { el: strip, days: days };
  }

  function loadDay() {
    return api('/api/morning-starters/day/' + state.term + '/' + state.week + '/' + encodeURIComponent(state.day))
      .then(function (slides) { state.slides = slides; renderSlides(); });
  }

  function toolbar() {
    var bar = el('div', 'ms-toolbar');
    var back = el('button', 'ms-btn ms-btn-ghost', '← All weeks');
    back.onclick = function () { state.term = null; state.week = null; state.day = null; render(); };
    bar.appendChild(back);

    var teacherToggle = el('button', 'ms-btn ms-btn-ghost', state.teacherMode ? 'Hide teacher notes' : 'Show teacher notes');
    teacherToggle.onclick = function () { state.teacherMode = !state.teacherMode; renderSlides(); };
    bar.appendChild(teacherToggle);

    var printBtn = el('button', 'ms-btn ms-btn-primary', '🖨 Print this day');
    printBtn.onclick = function () { window.print(); };
    bar.appendChild(printBtn);

    // Pre-built packs only exist for the weeks the generator has been run
    // for (scripts/morning-starters/generate-pdfs.js / generate_pptx.py —
    // see the b353 NOTES for which weeks are currently built). A missing
    // pack just 404s in a new tab rather than needing a live check here.
    var year = document.getElementById(ROOT_ID).dataset.year;
    if (year) {
      var base = '/downloads/morning-starters/' + year + '-t' + state.term + 'w' + String(state.week).padStart(2, '0');
      var pdfLink = el('a', 'ms-btn ms-btn-ghost', '📄 Week pack (PDF)');
      pdfLink.href = base + '.pdf'; pdfLink.target = '_blank';
      bar.appendChild(pdfLink);
      var pptxLink = el('a', 'ms-btn ms-btn-ghost', '📊 Week pack (PPTX)');
      pptxLink.href = base + '.pptx';
      bar.appendChild(pptxLink);
    }
    return bar;
  }

  var slidesEl = null;
  function renderSlides() {
    if (!slidesEl) return;
    slidesEl.innerHTML = '';
    if (!state.slides.length) { slidesEl.appendChild(el('p', 'ms-empty', 'No slides for this day yet.')); return; }
    state.slides.forEach(function (slide) {
      var wrap = el('div');
      wrap.innerHTML = RENDER.renderSlideHTML(slide, { teacherMode: state.teacherMode });
      slidesEl.appendChild(wrap.firstElementChild);
    });
    var toggle = document.querySelector('.ms-toolbar .ms-btn-ghost:nth-child(2)');
    if (toggle) toggle.textContent = state.teacherMode ? 'Hide teacher notes' : 'Show teacher notes';
  }

  function render() {
    var root = document.getElementById(ROOT_ID);
    if (!root) return;
    root.innerHTML = '';

    if (state.term == null) { root.appendChild(weekPicker()); return; }

    root.appendChild(toolbar());
    var strip = dayStrip();
    root.appendChild(strip.el);
    if (!state.day && strip.days.length) state.day = strip.days[0];

    var area = el('div', 'ms-print-area');
    slidesEl = el('div', 'ms-slides');
    area.appendChild(slidesEl);
    root.appendChild(area);

    if (state.day) loadDay(); else renderSlides();
  }

  function boot() {
    var root = document.getElementById(ROOT_ID);
    if (!root) return;
    if (!RENDER) { root.innerHTML = '<p class="ms-empty">Renderer failed to load.</p>'; return; }
    root.innerHTML = '<p class="ms-empty">Loading morning starters…</p>';
    Promise.all([api('/api/morning-starters'), api('/api/morning-starters/weeks')])
      .then(function (res) {
        state.index = res[0]; state.weeks = res[1];
        render();
      })
      .catch(function (e) { root.innerHTML = '<p class="ms-empty">Could not load morning starters (' + esc(e.message) + ').</p>'; });
  }

  if (window.Wren && document.getElementById(ROOT_ID)) { boot(); }
  else {
    document.addEventListener('wren:ready', boot);
    document.addEventListener('DOMContentLoaded', function () { setTimeout(function () {
      var r = document.getElementById(ROOT_ID);
      if (r && !r.dataset.booted) { r.dataset.booted = '1'; boot(); }
    }, 600); });
  }
})();
