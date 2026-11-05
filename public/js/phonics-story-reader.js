/* Wren Phonics — shared decodable-story reader (b157).
 * Self-contained (inline styles) so it drops into any portal (parents/EY/primary)
 * without depending on that page's CSS variables. Fetches from the content-pack
 * API (/api/phonics/content/stories, /api/phonics/content/stories/:slug) — the
 * same JSON that backs the tracker's "what's next" suggestions.
 *
 * Usage: <script src="/js/phonics-story-reader.js"></script>
 *   WrenPhonicsStoryReader.mount()      -> injects the modal shell (call once)
 *   WrenPhonicsStoryReader.listInto(el) -> fetches story list, renders cards into el
 *   WrenPhonicsStoryReader.open(slug)   -> fetches + opens one story
 */
(function (global) {
  'use strict';

  var API_BASE = '/api/phonics/content';
  var mounted = false;

  function mount() {
    if (mounted) return;
    mounted = true;
    var style = document.createElement('style');
    style.textContent = [
      '.wps-overlay{display:none;position:fixed;inset:0;background:rgba(15,23,42,.78);z-index:9000;align-items:flex-start;justify-content:center;padding:24px 16px;overflow-y:auto}',
      '.wps-overlay.wps-open{display:flex}',
      '.wps-book{background:#fffdf8;border-radius:14px;max-width:480px;width:100%;padding:0;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.35);font-family:Nunito,system-ui,Arial,sans-serif}',
      '.wps-close{position:absolute;top:10px;right:10px;background:#0f172a;color:#fff;border:none;border-radius:50%;width:34px;height:34px;font-size:1rem;cursor:pointer;z-index:2}',
      '.wps-head{padding:20px 22px 6px;text-align:center}',
      '.wps-head h2{margin:0 0 4px;font-size:1.3rem;color:#2d5a4a}',
      '.wps-head .wps-checkpoint{font-size:.76rem;color:#94765a;font-weight:700;text-transform:uppercase;letter-spacing:.03em}',
      '.wps-note{margin:10px 20px;background:#fff7e6;border:1px solid #f0d9a8;border-radius:10px;padding:8px 12px;font-size:.78rem;color:#8a6d1e;line-height:1.4}',
      '.wps-pages{padding:10px 22px 22px}',
      '.wps-joinin{margin-top:8px;font-size:.86rem;font-weight:600;color:#7a5c3e;background:#fdf3e3;border-radius:9px;padding:8px 11px}',
      '.wps-art{margin-top:8px;font-size:.74rem;line-height:1.45;color:#8a8a8a;font-style:italic}',
      '@media print{.wps-art{display:none}}',
      // b248: the page illustration. Sized by the page, not by a fixed pixel box,
      // so the same SVG fills a tablet page and an A5 sheet from one source.
      '.wps-illus{margin:0 0 12px;border-radius:10px;overflow:hidden;background:#fff}',
      '.wps-illus svg{width:100%;height:auto;display:block}',
      '.wps-page{border:2px solid #e8e0d0;border-radius:12px;padding:22px 18px;margin-bottom:14px;text-align:center;background:#fff}',
      '.wps-page .wps-icon{width:56px;height:56px;margin:0 auto 10px}',
      '.wps-page .wps-icon svg{width:100%;height:100%}',
      '.wps-page .wps-icon img{width:100%;height:100%;object-fit:contain}',
      '.wps-page .wps-text{font-size:1.35rem;font-weight:700;color:#2a2a2a;line-height:1.5}',
      '.wps-page .wps-num{margin-top:10px;font-size:.68rem;color:#aaa}',
      '.wps-actions{display:flex;gap:10px;justify-content:center;padding:0 22px 22px}',
      '.wps-btn{border:none;border-radius:10px;padding:11px 20px;font-weight:700;cursor:pointer;font-size:.88rem;min-height:44px}',
      '.wps-btn-primary{background:#2d5a4a;color:#fff}',
      '.wps-btn-secondary{background:#f0ede8;color:#2a2a2a}',
      '.wps-list{display:flex;flex-direction:column;gap:8px}',
      '.wps-card{display:flex;align-items:center;gap:12px;border:2px solid #e8e0d0;border-radius:12px;padding:10px 12px;cursor:pointer;background:#fff;text-align:left}',
      '.wps-card:hover{border-color:#2d5a4a}',
      '.wps-card .wps-card-icon{width:36px;height:36px;flex-shrink:0}',
      '.wps-card .wps-card-icon svg{width:100%;height:100%}',
      '.wps-card .wps-card-icon img{width:100%;height:100%;object-fit:contain}',
      '.wps-card-title{font-weight:800;font-size:.92rem;color:#2d5a4a}',
      '.wps-card-sub{font-size:.72rem;color:#8a8a8a;margin-top:1px}',
      '@media print{',
      '  body *{visibility:hidden}',
      '  .wps-overlay,.wps-overlay *{visibility:visible}',
      '  .wps-overlay{position:absolute;inset:0;background:#fff;padding:0}',
      '  .wps-close,.wps-actions{display:none!important}',
      '  .wps-book{box-shadow:none;max-width:none}',
      '  .wps-page{page-break-after:always;border:none;min-height:120mm}',
      '  .wps-illus{margin-bottom:8mm;break-inside:avoid}',
      '  .wps-illus svg{width:100%;height:auto}',
      '  @page{size:A5;margin:12mm}',
      '}',
    ].join('\n');
    document.head.appendChild(style);

    var overlay = document.createElement('div');
    overlay.className = 'wps-overlay';
    overlay.id = 'wps-overlay';
    overlay.innerHTML = '<div class="wps-book"><button class="wps-close" type="button" aria-label="Close">✕</button><div id="wps-body"></div></div>';
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    overlay.querySelector('.wps-close').addEventListener('click', close);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  }

  function close() {
    var overlay = document.getElementById('wps-overlay');
    if (overlay) overlay.classList.remove('wps-open');
  }

  function creatureIcon(key) {
    if (global.WrenPhonicsCreatures) {
      var svg = global.WrenPhonicsCreatures.get(key);
      if (svg) return svg;
    }
    return '';
  }

  // b221: a character can carry a real illustration (characters.json `image`).
  // Prefer it when the API resolved one; otherwise fall back to the generated
  // line-icon motif, so books still render while artwork is outstanding.
  function castVisual(story) {
    var c = (story.cast && story.cast[0]) || null;
    if (c && c.image_url) {
      return '<img src="' + escapeHtml(c.image_url) + '" alt="' +
             escapeHtml(c.image_alt || c.name || '') + '" loading="lazy">';
    }
    var id = c ? c.id : (story.characters && story.characters[0]);
    return id ? creatureIcon('cast-' + id) : '';
  }

  function authHeaders() {
    var h = {};
    try {
      var t = sessionStorage.getItem('wrenToken') || localStorage.getItem('wrenToken');
      if (t) h['Authorization'] = 'Bearer ' + t;
      var d = localStorage.getItem('wrenDevice');
      if (d) h['X-Wren-Device'] = d;
    } catch (e) { /* ignore */ }
    return h;
  }

  function open(slug) {
    mount();
    fetch(API_BASE + '/stories/' + encodeURIComponent(slug), { credentials: 'include', headers: authHeaders() })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(renderStory)
      .catch(function () {
        var body = document.getElementById('wps-body');
        if (body) body.innerHTML = '<div class="wps-head"><h2>Could not load this book</h2></div>';
        var overlay = document.getElementById('wps-overlay');
        if (overlay) overlay.classList.add('wps-open');
      });
  }

  function renderStory(story) {
    var body = document.getElementById('wps-body');
    var castIcon = castVisual(story);
    var pagesHtml = (story.pages || []).map(function (p, i) {
      // b248: a page with its own illustration shows that. The cast icon stays as
      // the fallback for books not yet illustrated, so nothing regresses while the
      // set is being drawn.
      // 2026-10-09: the reviewed page painting (same art as the printed booklets) wins over the SVG.
      var art = p.illustration_url
        ? '<div class="wps-illus"><img src="' + escapeHtml(p.illustration_url) + '" alt="' + escapeHtml(p.illustration_alt || '') + '" loading="lazy" style="display:block;width:100%;height:auto;border-radius:12px"></div>'
        : p.illustration_svg
        ? '<div class="wps-illus" role="img" aria-label="' + escapeHtml(p.illustration_alt || '') + '">' + p.illustration_svg + '</div>'
        : (castIcon ? '<div class="wps-icon">' + castIcon + '</div>' : '');
      return '<div class="wps-page">' + art +
        '<div class="wps-text">' + escapeHtml(p.text) + '</div>' +
        // b182: Introduction-phase books have nothing to decode — the child joins in
        // with a sound instead, so that line has to be on the page, not in the notes.
        (p.join_in ? '<div class="wps-joinin">👐 ' + escapeHtml(p.join_in) + '</div>' : '') +
        // b182: art-brief per page. Not printed — it is a commissioning note for staff.
        (p.illustration && !p.illustration_svg && !p.illustration_url ? '<div class="wps-art">🎨 ' + escapeHtml(p.illustration) + '</div>' : '') +
        '<div class="wps-num">Page ' + (i + 1) + '</div>' +
        '</div>';
    }).join('');
    body.innerHTML =
      '<div class="wps-head"><h2>' + escapeHtml(story.title || '') + '</h2>' +
      '<div class="wps-checkpoint">' + escapeHtml(story.checkpoint || '') + '</div></div>' +
      (story.note_for_grown_ups ? '<div class="wps-note">💬 For grown-ups: ' + escapeHtml(story.note_for_grown_ups) + '</div>' : '') +
      '<div class="wps-pages">' + pagesHtml + '</div>' +
      '<div class="wps-actions">' +
      '<button class="wps-btn wps-btn-secondary" type="button" onclick="window.print()">🖶️ Print A5 booklet</button>' +
      '<button class="wps-btn wps-btn-primary" type="button" id="wps-done-btn">Done reading</button>' +
      '</div>';
    document.getElementById('wps-done-btn').addEventListener('click', close);
    document.getElementById('wps-overlay').classList.add('wps-open');
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function listInto(el, opts) {
    mount();
    opts = opts || {};
    fetch(API_BASE + '/stories', { credentials: 'include', headers: authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (stories) {
        if (!stories.length) { el.innerHTML = '<p style="font-size:.85rem;color:#94a3b8">More Wren storybooks are on the way — check back soon!</p>'; return; }
        el.innerHTML = '<div class="wps-list">' + stories.map(function (s) {
          var icon = castVisual(s);
          return '<button type="button" class="wps-card" data-slug="' + s.slug + '">' +
            (icon ? '<span class="wps-card-icon">' + icon + '</span>' : '') +
            '<span><span class="wps-card-title">' + escapeHtml(s.title) + '</span>' +
            '<div class="wps-card-sub">' + escapeHtml(s.checkpoint || '') + ' · ' + s.pages + ' pages' +
            (s.read_aloud ? ' · read aloud' : '') +
            (s.illustrated ? ' · illustrated' : '') + '</div></span>' +
            '</button>';
        }).join('') + '</div>';
        el.querySelectorAll('.wps-card').forEach(function (btn) {
          btn.addEventListener('click', function () { open(btn.dataset.slug); });
        });
      })
      .catch(function () { el.innerHTML = '<p style="font-size:.85rem;color:#94a3b8">Could not load storybooks right now.</p>'; });
  }

  global.WrenPhonicsStoryReader = { mount: mount, open: open, listInto: listInto, close: close };
})(window);
