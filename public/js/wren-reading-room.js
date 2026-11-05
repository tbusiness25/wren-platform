/* b425 — The Reading Room: one shared renderer for the catalogue, used by every
 * portal's page (Roost /library.html, EY /ey/library, HR /library.html, Parents
 * /welcome/library). The API (/api/library) already forces audience server-side,
 * so this file never needs to know which portal it's running in — it just fetches
 * and renders. Admin-only controls (Needs review tab, upload) are shown only when
 * the host page passes { admin: true }, which the host page itself only does on
 * Roost.
 *
 * b482 — adds the bookshelf: Browse is now books (grouped chapters), not a flat
 * card list, with a facet sidebar (For/About/Source/Date added/Unread), three
 * view modes (shelf/grid/list, remembered per browser), and an in-page reader.
 * The Needs-review / Upload / Overview admin tabs below are UNCHANGED from
 * b425/b426/b427 — they operate on raw reading_documents rows, which books are
 * built FROM but don't replace; a manager still reviews/uploads/sees coverage
 * exactly as before.
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ── b482b fix F1 — the chapter body sink ────────────────────────────────
  // chapterBody() on the server returns raw content straight off the source
  // row: policies.content (every one of the 68 prod policies is PLAIN TEXT —
  // paragraphs separated by line breaks, same as every other policy viewer in
  // Wren renders it) and resources.content_html (genuinely-authored HTML —
  // links, headings, lists). Neither had ever been through anything here; a
  // policy with an <iframe srcdoc> or a javascript: link ran on every portal,
  // Parents included. The two sources get two different safe treatments
  // below — never innerHTML with untrusted content either way.
  const WRS_DANGEROUS_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'BASE', 'FORM', 'FRAME', 'FRAMESET']);
  const WRS_ALLOWED_TAGS = new Set(['P', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI', 'STRONG', 'EM', 'B', 'I', 'BR', 'A']);
  // Allow-list, not block-list: only an exact https:// or same-origin-relative
  // '/...' href is kept (never '//host' protocol-relative, which is how you'd
  // sneak a cross-origin link past a naive "doesn't start with javascript:"
  // check) — anything else just loses its href and renders as plain text.
  function wrsSafeHref(href) {
    href = String(href || '');
    if (/^https:\/\//i.test(href)) return href;
    if (/^\/(?!\/)/.test(href)) return href;
    return null;
  }
  function wrsSanitiseInto(parent, sourceNode) {
    sourceNode.childNodes.forEach(child => {
      if (child.nodeType === 3) { // Node.TEXT_NODE
        parent.appendChild(document.createTextNode(child.data));
        return;
      }
      if (child.nodeType !== 1) return; // skip comments etc.
      const tag = child.tagName;
      if (WRS_DANGEROUS_TAGS.has(tag)) return; // drop the element AND its content
      if (!WRS_ALLOWED_TAGS.has(tag)) { wrsSanitiseInto(parent, child); return; } // unwrap: keep the text inside, drop the wrapper
      const el = document.createElement(tag.toLowerCase());
      if (tag === 'A') {
        const href = wrsSafeHref(child.getAttribute('href'));
        if (href) { el.setAttribute('href', href); el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
      }
      // No other attribute, on any allowed tag, is ever copied — that's what
      // keeps a style=/on*= attribute on a <p> or <li> from ever reaching the
      // live DOM, with no attribute-by-attribute blocklist to keep up to date.
      wrsSanitiseInto(el, child);
      parent.appendChild(el);
    });
  }
  // Renders untrusted HTML into `container` using the browser's own HTML
  // parser (DOMParser never executes scripts or runs handlers on what it
  // parses), then walks that parsed, still-detached tree and rebuilds only
  // the allowed shape into `container` via real DOM calls — container.innerHTML
  // is never assigned from this string at any point.
  function appendSanitisedHtml(container, html) {
    let doc;
    try { doc = new DOMParser().parseFromString(String(html == null ? '' : html), 'text/html'); }
    catch (_) { container.appendChild(document.createTextNode(String(html == null ? '' : html))); return; }
    wrsSanitiseInto(container, doc.body);
  }
  // Policy content is plain text (no markup, ever) — textContent plus
  // white-space:pre-wrap is the exact pattern every other policy viewer in
  // Wren already uses (parents/welcome/policies.html, ey/policies.html,
  // hr/policies.html) so paragraph breaks still show instead of collapsing
  // into one wall of text.
  // b519 — `body` now also arrives as { text } (the handbook's content_md, a Reading
  // Corner item's body_md, a study module's content_json), which is plain text with its
  // paragraphs intact. It goes in via textContent, never innerHTML — same guarantee the
  // policy branch below has had since b482b fix F1 — and .wrs-plaintext keeps the line
  // breaks (white-space: pre-wrap).
  function renderChapterBody(container, source, rawHtml, chapter, rawText) {
    if (rawText) {
      container.classList.add('wrs-plaintext');
      container.textContent = rawText;
      return;
    }
    if (!rawHtml) {
      if (chapter.summary) container.textContent = chapter.summary;
      else container.innerHTML = '<em>No preview available.</em>';
      return;
    }
    if (source === 'policy') {
      container.classList.add('wrs-plaintext');
      container.textContent = rawHtml;
    } else {
      appendSanitisedHtml(container, rawHtml);
    }
  }

  // ── b519: where it came from, and whether this is all of it ────────────────
  // Toby: "Is that the whole thing? … I just wanted to make sure I'm not missing
  // anything." Both answers come from the server (item.provenance / item.extent) so the
  // page never guesses, and `kind` picks the word in front of the source.
  const PROV_WORD = {
    external_url: 'Source',
    wren_docs_file: 'File',
    drive_file: 'Source',
    stored_file: 'Source',
    wren_record: 'Source',
  };
  function provenanceHtml(chapter) {
    const p = chapter && chapter.provenance;
    if (!p) return '';
    const bits = [`<span class="wrs-prov-label">${esc(PROV_WORD[p.kind] || 'Source')}</span>`,
      `<span class="wrs-prov-value">${esc(p.label || 'Wren')}</span>`];
    if (p.detail) bits.push(`<span>· ${esc(p.detail)}</span>`);
    // The wren-docs path only ever reaches a manager (the server strips it otherwise), and
    // it is the thing you need in order to decide whether to delete the file.
    const pathLine = p.path ? `<div class="wrs-prov-path">wren-docs/${esc(p.path)}</div>` : '';
    return `<div class="wrs-prov">${bits.join(' ')}</div>${pathLine}`;
  }
  function extentHtml(chapter) {
    const e = chapter && chapter.extent;
    if (!e || !e.label) return '';
    return `<div class="wrs-extent${e.full ? '' : ' partial'}">${esc(e.label)}</div>`;
  }
  function soWhatHtml(chapter) {
    if (!chapter || !chapter.so_what) return '';
    return `<div class="wrs-sowhat"><span class="wrs-sowhat-label">What it means for us</span>${esc(chapter.so_what)}</div>`;
  }
  function openOriginalHtml(chapter) {
    const open = chapter && chapter.provenance && chapter.provenance.open;
    if (!open || !open.url) return '';
    const label = esc(open.label || 'Open original');
    // 'blob' needs the fetch-with-Bearer dance (an <a href> carries no token), so it is a
    // button; everything else is an ordinary link, which middle-click and long-press both
    // understand.
    if (open.how === 'blob') {
      return `<button type="button" class="wrs-btn primary" data-open-blob="${esc(open.url)}">${label} ↗</button>`;
    }
    const external = /^https?:/i.test(open.url);
    return `<a class="wrs-btn primary" href="${esc(open.url)}" style="text-decoration:none;display:inline-flex;align-items:center"` +
      `${external ? ' target="_blank" rel="noopener noreferrer"' : ''} data-open-original="1">${label} ↗</a>`;
  }

  // ── b482b fix F8 — generated cover text contrast ────────────────────────
  // var(--c-cat-*) is themed per-portal (Parents recolours all eight to its
  // own palette — see parents/welcome/library.html — and any portal can
  // re-theme them again later); white title/footer text looks fine against
  // the darker/more saturated ones but fails WCAG on the lighter ones (5 of
  // 24 Parents covers measured below 3:1). Rather than hand-picking which
  // tokens need dark text today (and re-finding this the next time a palette
  // changes), resolve the actual rendered colour once per cover and pick
  // whichever of the two existing text tokens — var(--c-on-fill) (white) or
  // var(--c-text) (the page's own body text colour) — passes against it.
  const wrsContrastCache = {};
  function wrsResolveColor(cssExpr) {
    const probe = document.createElement('span');
    probe.style.position = 'absolute'; probe.style.opacity = '0'; probe.style.pointerEvents = 'none';
    probe.style.color = cssExpr;
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color;
    document.body.removeChild(probe);
    return rgb;
  }
  function wrsRelativeLuminance(rgbStr) {
    const m = String(rgbStr || '').match(/[\d.]+/g);
    if (!m || m.length < 3) return 1;
    const lin = (c) => { c = c / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * lin(+m[0]) + 0.7152 * lin(+m[1]) + 0.0722 * lin(+m[2]);
  }
  function wrsContrastOnColor(bgCssExpr) {
    if (wrsContrastCache[bgCssExpr]) return wrsContrastCache[bgCssExpr];
    let onColor = 'var(--c-on-fill)';
    try {
      const bgL = wrsRelativeLuminance(wrsResolveColor(bgCssExpr));
      const textL = wrsRelativeLuminance(wrsResolveColor('var(--c-text)'));
      const contrastWith = (fgL) => (Math.max(fgL, bgL) + 0.05) / (Math.min(fgL, bgL) + 0.05);
      if (contrastWith(textL) > contrastWith(1)) onColor = 'var(--c-text)';
    } catch (_) {}
    wrsContrastCache[bgCssExpr] = onColor;
    return onColor;
  }

  // Roost/EY/HR authenticate with a bearer token held in sessionStorage — plain
  // fetch() sends no header at all there, so those three MUST go through
  // Wren.api() (wren-core.js), which attaches it (including X-Wren-Device on EY —
  // b425c fix D3). Parents has no Wren.api (its own shell, pwa.js, never loads
  // wren-core.js) and authenticates with the wren_parent cookie instead, which a
  // same-origin fetch() already sends by default — so the plain-fetch fallback
  // below is correct there, not a gap.
  function api(url, opts) {
    if (window.Wren && typeof Wren.api === 'function') return Wren.api(url, opts);
    opts = opts || {};
    // b482b fix F2 — every caller below passes `body` as a plain object (the
    // Wren.api() convention). fetch() itself does NOT serialise that: it just
    // calls String(body), so the request landed on the server as the literal
    // text "[object Object]" and 400ed. Stringify it ourselves and set the
    // header fetch() would otherwise never add.
    if (opts.body != null && typeof opts.body !== 'string') {
      opts = Object.assign({}, opts, {
        body: JSON.stringify(opts.body),
        headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}),
      });
    }
    return fetch(url, opts).then(r => {
      if (!r.ok) return r.json().catch(() => ({})).then(d => Promise.reject(d));
      return r.json();
    });
  }
  function fmtDate(d) {
    if (!d) return '';
    try { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (_) { return ''; }
  }
  const TYPE_LABEL = {
    policy: 'Policy', guide: 'Guide', course: 'Course', study_module: 'Study module',
    article: 'Article', document: 'Document', procedure: 'Procedure', form: 'Form',
    report: 'Report', letter: 'Letter',
    analysis: 'Analysis', decision: 'Decision', runbook: 'Runbook', // b427 — wren-docs import
  };
  const CHECKLIST_STATUS_LABEL = { paper: 'Still paper', in_progress: 'In progress', done: 'Done', not_needed: 'Not needed' };

  // ── b482: localStorage is per-viewer convenience only (which view mode you
  // last used) — never state anyone else needs to see, so a throw here (private
  // browsing, blocked storage) just means it doesn't persist, not a broken page.
  function lsGet(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : v; } catch (_) { return fallback; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (_) {} }

  // ── b482: generated book covers — no external images, a colour per area (the
  // same --c-cat-* categorical tokens charts already use, so it's themed and
  // accessible for free) and the title wrapped onto the cover by hand.
  const AREA_COLOR_INDEX = {
    'safeguarding': 1, 'daily-rhythm': 2, 'curriculum-assessment': 3, 'parent-communication': 4,
    'admissions': 5, 'money': 6, 'staffing-hr': 7, 'training-cpd': 8,
    'kitchen-food': 1, 'health-safety-premises': 2, 'compliance-ofsted': 3, 'systems-it': 4,
  };
  function coverColor(book) {
    const a = book.areas && book.areas[0];
    const n = a && AREA_COLOR_INDEX[a];
    return n ? `var(--c-cat-${n})` : 'var(--c-blue)';
  }
  function wrapTitle(title, maxChars, maxLines) {
    const words = String(title || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (test.length > maxChars && cur) { lines.push(cur); cur = w; if (lines.length === maxLines) break; }
      else cur = test;
    }
    if (lines.length < maxLines && cur) lines.push(cur);
    if (lines.length === maxLines) {
      const consumed = lines.join(' ').length;
      if (consumed < words.join(' ').length) {
        const last = lines[maxLines - 1];
        lines[maxLines - 1] = last.length > maxChars - 1 ? last.slice(0, maxChars - 1).trimEnd() + '…' : last + '…';
      }
    }
    return lines.length ? lines : [''];
  }
  function svgId(key) { return 'wrsg' + String(key).replace(/[^a-zA-Z0-9]/g, '') || 'wrsgx'; }
  function renderCoverSvg(book) {
    const color = coverColor(book);
    const onColor = wrsContrastOnColor(color); // b482b fix F8
    const gid = svgId(book.book_key);
    const lines = wrapTitle(book.title, 15, 5);
    const footer = book.chapter_count > 1 ? `${book.chapter_count} chapters` : (TYPE_LABEL[book.type] || book.type || '');
    return `
      <svg viewBox="0 0 140 196" class="wrs-cover-svg" role="img" aria-label="${esc(book.title)}">
        <defs>
          <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="${color}" stop-opacity="0.95"></stop>
            <stop offset="1" stop-color="${color}" stop-opacity="0.6"></stop>
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="140" height="196" rx="6" fill="url(#${gid})"></rect>
        <rect x="0" y="0" width="9" height="196" fill="${color}" opacity="0.85"></rect>
        <rect x="0.5" y="0.5" width="139" height="195" rx="6" fill="none" stroke="var(--c-border)" stroke-opacity="0.35"></rect>
        ${lines.map((l, i) => `<text x="19" y="${36 + i * 17}" font-size="12" font-weight="700" fill="${onColor}" font-family="inherit">${esc(l)}</text>`).join('')}
        <text x="19" y="180" font-size="8.5" fill="${onColor}" opacity="0.85" font-family="inherit">${esc(footer)}</text>
      </svg>`;
  }

  function init(root, opts) {
    opts = opts || {};
    const initial = new URLSearchParams(location.search);
    const state = {
      area: initial.get('area') || null,
      persona: initial.get('persona') || null,
      // b482b fix F4 — '/welcome/study' (the old Study link) redirects to
      // '?type=study_module'; the bookshelf has no 'type' concept of its own,
      // only 'source', so that param was silently dropped and families landed
      // on the whole shelf instead of just study modules. 'source' still wins
      // if both are somehow present.
      source: initial.get('source') || initial.get('type') || null,
      date: initial.get('date') || null,
      unread: initial.get('unread') === '1',
      q: initial.get('q') || '',
      sort: initial.get('sort') || 'newest',
      view: (['shelf', 'grid', 'list'].includes(lsGet('wrr.view', 'shelf'))) ? lsGet('wrr.view', 'shelf') : 'shelf',
      tab: 'browse',
      folder: null,   // b426 — needs-review only; which Drive folder (if any)
      book: initial.get('book') || null,
      chapter: initial.get('chapter') || null,
      // b519 — the Archived shelf is a view of the same list, not a second page.
      archived: initial.get('archived') === '1',
      deletedView: false,
    };
    let lastFacets = null;
    let lastBook = null; // the currently open book's full detail (with chapters), for prev/next

    root.innerHTML = `
      ${opts.admin ? `
      <div class="wrr-toolbar">
        <div class="wrr-tabs" role="tablist">
          <button class="wrr-tab active" data-tab="browse" type="button">Browse</button>
          <button class="wrr-tab" data-tab="review" type="button">Needs review</button>
          <button class="wrr-tab" data-tab="upload" type="button">Upload</button>
          <button class="wrr-tab" data-tab="overview" type="button">Overview</button>
        </div>
      </div>` : ''}

      <div id="wrs-browse">
        <div class="wrs-wrap">
          <div class="wrs-toolbar">
            <button type="button" class="wrs-filter-toggle" id="wrs-filter-toggle">🔎 Filters</button>
            <input class="wrs-search" id="wrs-q" type="search" placeholder="Search the Reading Room…" aria-label="Search" value="${esc(state.q)}">
            <select class="wrs-select" id="wrs-sort" aria-label="Sort">
              <option value="newest"${state.sort === 'newest' ? ' selected' : ''}>Newest first</option>
              <option value="oldest"${state.sort === 'oldest' ? ' selected' : ''}>Oldest first</option>
              <option value="az"${state.sort === 'az' ? ' selected' : ''}>A–Z</option>
              <option value="relevance"${state.sort === 'relevance' ? ' selected' : ''}>Most relevant to me</option>
              <option value="unread"${state.sort === 'unread' ? ' selected' : ''}>Unread first</option>
            </select>
            <div class="wrs-viewtoggle" role="group" aria-label="View">
              <button type="button" data-view="shelf" title="Shelf view">📚</button>
              <button type="button" data-view="grid" title="Grid view">▦</button>
              <button type="button" data-view="list" title="List view">☰</button>
            </div>
          </div>
          <div class="wrs-layout">
            <div class="wrs-sidebar" id="wrs-sidebar">
              <button type="button" class="wrs-sidebar-close" id="wrs-sidebar-close" style="display:none">Close ✕</button>
              <div id="wrs-facets"></div>
            </div>
            <div id="wrs-main">
              ${opts.admin ? `
              <div class="wrs-shelf-tools">
                <button type="button" class="wrs-btn" id="wrs-archive-read">📦 Archive all read</button>
                <button type="button" class="wrs-btn" id="wrs-show-deleted">🗑️ Deleted</button>
                <span class="wrs-note" id="wrs-tools-note" hidden></span>
              </div>` : ''}
              <div id="wrs-shelf-area"><div class="wrs-empty">Loading…</div></div>
              <div class="wrs-footer-count" id="wrs-count"></div>
              ${opts.admin ? '<div id="wrs-deleted" hidden></div>' : ''}
            </div>
          </div>
        </div>
      </div>

      <div id="wrs-reader" class="wrs-reader" hidden></div>

      ${opts.admin ? `
      <div class="wrs-move-picker" id="wrs-move-picker" hidden>
        <div class="wrs-move-picker-card">
          <div class="wrs-move-picker-head">
            <span>Move into book…</span>
            <button type="button" class="wrs-facet-clear" id="wrs-move-picker-close">Close ✕</button>
          </div>
          <input type="search" class="wrs-search" id="wrs-move-picker-q" placeholder="Search books…" aria-label="Search books">
          <div class="wrs-move-picker-list" id="wrs-move-picker-list"></div>
        </div>
      </div>` : ''}

      ${opts.admin ? `<div class="wrr-upload" id="wrr-upload" hidden>
        <form id="wrr-upload-form">
          <input type="file" name="file" required>
          <input type="text" name="title" placeholder="Title" required>
          <input type="text" name="summary" placeholder="Summary (optional)">
          <select name="doc_type">
            <option value="document">Document</option><option value="policy">Policy</option>
            <option value="procedure">Procedure</option><option value="form">Form</option>
            <option value="guide">Guide</option><option value="report">Report</option>
            <option value="letter">Letter</option>
          </select>
          <button type="submit" class="wrr-btn primary">Upload to Needs review</button>
        </form>
      </div>` : ''}
      ${opts.admin ? `<div class="wrr-review-tools" id="wrr-review-tools" hidden>
        <div class="wrr-areas" id="wrr-areas"></div>
        <select class="wrr-select" id="wrr-folder" aria-label="Filter by Drive folder"><option value="">All folders</option></select>
        <div class="wrr-bulk" id="wrr-bulk" hidden>
          <span id="wrr-bulk-count"></span>
          <label><input type="checkbox" id="wrr-pub-admin">Admin</label>
          <label><input type="checkbox" id="wrr-pub-staff" checked>Staff</label>
          <label><input type="checkbox" id="wrr-pub-parents">Parents</label>
          <button type="button" class="wrr-btn primary small" id="wrr-bulk-publish">Accept &amp; publish</button>
          <button type="button" class="wrr-btn small" id="wrr-bulk-discard">Discard</button>
        </div>
      </div>` : ''}
      <div id="wrr-list" class="wrr-list" hidden></div>
      ${opts.admin ? `<div id="wrr-overview" class="wro-wrap" hidden></div>` : ''}
      ${(opts.extraLinks && opts.extraLinks.length) ? `
      <div class="wrr-extra">
        <div class="wrr-extra-label">Related tools</div>
        ${opts.extraLinks.map(l => `<a class="wrr-extra-link" href="${esc(l.href)}">${esc(l.icon || '')} ${esc(l.label)}</a>`).join('')}
      </div>` : ''}
      ${opts.shelf ? `
      <div class="wrr-shelf">
        <a class="wrr-shelf-link" href="${esc(opts.shelf.href)}">${esc(opts.shelf.icon || '📚')} ${esc(opts.shelf.label)}</a>
      </div>` : ''}
    `;

    const elBrowse = root.querySelector('#wrs-browse');
    const elReader = root.querySelector('#wrs-reader');
    const elShelfArea = root.querySelector('#wrs-shelf-area');
    const elFacets = root.querySelector('#wrs-facets');
    const elCount = root.querySelector('#wrs-count');
    const elQ = root.querySelector('#wrs-q');
    const elSort = root.querySelector('#wrs-sort');
    const elList = root.querySelector('#wrr-list'); // admin Needs-review only, from here on

    function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
    elQ.addEventListener('input', debounce(() => { state.q = elQ.value.trim(); loadBooks(); }, 250));
    elSort.addEventListener('change', () => { state.sort = elSort.value; loadBooks(); });
    root.querySelectorAll('.wrs-viewtoggle button').forEach(btn => {
      btn.addEventListener('click', () => { state.view = btn.dataset.view; lsSet('wrr.view', state.view); renderShelfArea(); });
    });
    const elSidebar = root.querySelector('#wrs-sidebar');
    const elFilterToggle = root.querySelector('#wrs-filter-toggle');
    const elSidebarClose = root.querySelector('#wrs-sidebar-close');
    if (elFilterToggle) elFilterToggle.addEventListener('click', () => { elSidebar.classList.add('open'); elSidebarClose.style.display = ''; });
    if (elSidebarClose) elSidebarClose.addEventListener('click', () => elSidebar.classList.remove('open'));

    function syncUrl() {
      const qs = new URLSearchParams();
      if (state.area) qs.set('area', state.area);
      if (state.persona) qs.set('persona', state.persona);
      if (state.source) qs.set('source', state.source);
      if (state.date) qs.set('date', state.date);
      if (state.unread) qs.set('unread', '1');
      if (state.archived) qs.set('archived', '1');
      if (state.q) qs.set('q', state.q);
      if (state.sort !== 'newest') qs.set('sort', state.sort);
      if (state.book) qs.set('book', state.book);
      if (state.chapter) qs.set('chapter', state.chapter);
      const s = qs.toString();
      history.replaceState(null, '', location.pathname + (s ? '?' + s : ''));
    }

    // ── Facets ───────────────────────────────────────────────────────────────
    function facetGroup(title, items, activeKey, onClick, clearable) {
      const rows = items.map(it => `
        <button type="button" class="wrs-facet-item${it.key === activeKey ? ' active' : ''}" data-key="${esc(it.key == null ? '' : it.key)}">
          <span>${esc(it.label)}</span><span class="wrs-fc-count">${it.count}</span>
        </button>`).join('');
      return `<div class="wrs-facet-group" data-group="${esc(title)}">
        <div class="wrs-facet-title">${esc(title)}${clearable && activeKey ? ` <button type="button" class="wrs-facet-clear" data-clear="1">Clear</button>` : ''}</div>
        ${rows || '<div class="wrs-empty" style="padding:4px 2px">Nothing yet</div>'}
      </div>`;
    }
    function renderFacets(facets) {
      lastFacets = facets;
      const aboutItems = facets.about.map(a => ({ key: a.slug == null ? '__none__' : a.slug, label: a.name, count: a.count }));
      const forItems = facets.for.map(p => ({ key: p.key, label: p.label, count: p.count }));
      const sourceItems = facets.source.map(s => ({ key: s.key, label: s.label, count: s.count }));
      const dateItems = facets.date.map(d => ({ key: d.key, label: d.label, count: d.count }));
      const unreadItems = [{ key: '1', label: 'Unread only', count: facets.unread }];
      // b519 — its own group rather than another row in "Unread", because it is a different
      // question (what is on the shelf at all vs what have I read) and because the Unread
      // group's click handler is keyed by its title.
      // …and only on Roost: archiving is a manager's decision about the whole setting's
      // reading room, so an "Archived (0)" filter on the EY/HR/Parents shelves would be a
      // control nobody there can act on. Those three pages are unchanged by b519 apart from
      // the provenance and extent lines in the pane.
      const shelfItems = [{ key: '1', label: 'Archived', count: facets.archived || 0 }];
      elFacets.innerHTML =
        facetGroup('For', forItems, state.persona, null, true) +
        facetGroup('About', aboutItems, state.area, null, true) +
        facetGroup('Source', sourceItems, state.source, null, true) +
        facetGroup('Date added', dateItems, state.date, null, true) +
        facetGroup('Unread', unreadItems, state.unread ? '1' : null, null, true) +
        (opts.admin ? facetGroup('Shelf', shelfItems, state.archived ? '1' : null, null, true) : '');

      elFacets.querySelectorAll('.wrs-facet-group').forEach(group => {
        const title = group.dataset.group;
        group.querySelectorAll('.wrs-facet-item').forEach(btn => {
          btn.addEventListener('click', () => {
            const key = btn.dataset.key;
            if (title === 'For') state.persona = (state.persona === key) ? null : key;
            else if (title === 'About') state.area = (state.area === key) ? null : key;
            else if (title === 'Source') state.source = (state.source === key) ? null : key;
            else if (title === 'Date added') state.date = (state.date === key) ? null : key;
            else if (title === 'Unread') state.unread = !state.unread;
            else if (title === 'Shelf') { state.archived = !state.archived; hideDeleted(); }
            if (window.innerWidth <= 860) elSidebar.classList.remove('open');
            loadBooks();
          });
        });
        const clearBtn = group.querySelector('[data-clear]');
        if (clearBtn) clearBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (title === 'For') state.persona = null;
          else if (title === 'About') state.area = null;
          else if (title === 'Source') state.source = null;
          else if (title === 'Date added') state.date = null;
          else if (title === 'Unread') state.unread = false;
          else if (title === 'Shelf') state.archived = false;
          loadBooks();
        });
        // Admin-only: rename a persona's label / remit, in place — a configurable
        // "Settings" edit without a separate Settings page (see NOTES on scope).
        if (title === 'For' && opts.admin) {
          const titleEl = group.querySelector('.wrs-facet-title');
          const editBtn = document.createElement('button');
          editBtn.type = 'button'; editBtn.className = 'wrs-facet-clear'; editBtn.style.marginLeft = '6px';
          editBtn.textContent = '✏️ Edit';
          editBtn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const key = prompt('Persona key to edit (e.g. accountant, manager, deputy):', 'accountant');
            if (!key) return;
            // b482b fix F12 — both prompts used to default to blank rather than
            // the persona's CURRENT label/areas, so clicking OK without typing
            // anything (the normal way to leave a field alone) silently wiped
            // it — same class of bug as b425b #9. Pre-fill with what's there
            // now so "didn't touch it" really means "didn't touch it".
            let current = null;
            try { current = (await api('/api/library/personas')).find(p => p.persona_key === key) || null; } catch (_) {}
            const label = prompt('Display label:', (current && current.label) || '');
            const areasCsv = prompt('Relevant areas (comma-separated slugs, blank = everything):', (current && current.relevant_areas || []).join(','));
            const patch = {};
            if (label) patch.label = label;
            if (areasCsv != null) patch.relevant_areas = areasCsv.split(',').map(s => s.trim()).filter(Boolean);
            try {
              await api(`/api/library/personas/${encodeURIComponent(key)}`, { method: 'PATCH', body: patch });
              if (window.Wren && Wren.toast) Wren.toast('Persona updated');
              loadBooks();
            } catch (err) {
              const msg = (err && (err.message || err.error)) || 'Could not update persona';
              if (window.Wren && Wren.toast) Wren.toast(msg); else alert(msg);
            }
          });
          titleEl.appendChild(editBtn);
        }
      });
    }

    // ── Shelf / grid / list rendering ───────────────────────────────────────
    let lastBooks = [];
    function renderShelfArea() {
      root.querySelectorAll('.wrs-viewtoggle button').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
      if (!lastBooks.length) {
        elShelfArea.innerHTML = state.archived
          ? '<div class="wrs-empty">Nothing is archived. Archive something you have read and will not need again, and it lands here.</div>'
          : '<div class="wrs-empty">Nothing here yet.</div>';
        return;
      }
      if (state.view === 'shelf') elShelfArea.innerHTML = `<div class="wrs-shelf">${lastBooks.map(coverCell).join('')}</div>`;
      else if (state.view === 'grid') elShelfArea.innerHTML = `<div class="wrs-grid">${lastBooks.map(gridCell).join('')}</div>`;
      else elShelfArea.innerHTML = `<div class="wrs-rows">${lastBooks.map(listRow).join('')}</div>`;
      elShelfArea.querySelectorAll('[data-open-book]').forEach(el => {
        el.addEventListener('click', () => openBook(el.dataset.openBook));
      });
    }
    function coverCell(b) {
      return `<button type="button" class="wrs-cover-btn" data-open-book="${esc(b.book_key)}">
        <div class="wrs-cover-wrap">
          ${renderCoverSvg(b)}
          ${b.unread_chapters > 0 ? '<span class="wrs-badge-unread" title="Unread"></span>' : ''}
          ${b.pinned ? '<span class="wrs-badge-pin" title="Pinned">📌</span>' : ''}
        </div>
        <div class="wrs-cover-title">${esc(b.title)}</div>
        <div class="wrs-cover-sub">${b.chapter_count > 1 ? b.chapter_count + ' chapters' : (TYPE_LABEL[b.type] || esc(b.type))}</div>
      </button>`;
    }
    function gridCell(b) {
      return `<button type="button" class="wrs-gcard" data-open-book="${esc(b.book_key)}">
        ${renderCoverSvg(b)}
        <div class="wrs-gcard-body">
          <div class="wrs-gcard-title">${esc(b.title)}${b.pinned ? ' 📌' : ''}</div>
          <div class="wrs-gcard-meta">
            <span>${b.chapter_count > 1 ? b.chapter_count + ' chapters' : (TYPE_LABEL[b.type] || esc(b.type))}</span>
            ${b.updated_at ? `<span>Updated ${fmtDate(b.updated_at)}</span>` : ''}
            ${b.unread_chapters > 0 ? `<span>${b.unread_chapters} unread</span>` : ''}
          </div>
        </div>
      </button>`;
    }
    function listRow(b) {
      return `<button type="button" class="wrs-row" data-open-book="${esc(b.book_key)}">
        <span class="wrs-row-dot" style="background:${coverColor(b)}"></span>
        <span class="wrs-row-title">${esc(b.title)}${b.pinned ? ' 📌' : ''}</span>
        <span class="wrs-row-meta">${b.chapter_count > 1 ? b.chapter_count + ' ch.' : (TYPE_LABEL[b.type] || esc(b.type))}${b.unread_chapters > 0 ? ' · unread' : ''}</span>
      </button>`;
    }

    async function loadBooks() {
      syncUrl();
      elShelfArea.innerHTML = '<div class="wrs-empty">Loading…</div>';
      try {
        const qs = new URLSearchParams();
        if (state.area) qs.set('area', state.area);
        if (state.persona) qs.set('persona', state.persona);
        if (state.source) qs.set('source', state.source);
        if (state.date) qs.set('date', state.date);
        if (state.unread) qs.set('unread', '1');
        if (state.archived) qs.set('archived', '1');
        if (state.q) qs.set('q', state.q);
        qs.set('sort', state.sort);
        const data = await api('/api/library/books?' + qs.toString());
        lastBooks = data.books || [];
        renderFacets(data.facets || { for: [], about: [], source: [], date: [], unread: 0 });
        renderShelfArea();
        elCount.textContent = lastBooks.length + (lastBooks.length === 1 ? ' book' : ' books')
          + (data.total_books && data.total_books !== lastBooks.length ? ` of ${data.total_books}` : '')
          + (state.archived ? ' · archived' : '');
      } catch (e) {
        elShelfArea.innerHTML = `<div class="wrs-empty">Could not load the Reading Room (${esc(e && (e.message || e.error) || 'unknown error')}).</div>`;
      }
    }

    // ── b519: shelf-level tools — "Archive all read", and the Deleted list ────
    const elDeleted = root.querySelector('#wrs-deleted');
    const elToolsNote = root.querySelector('#wrs-tools-note');

    function toolsNote(text, kind) {
      if (!elToolsNote) return;
      elToolsNote.className = 'wrs-note' + (kind ? ' ' + kind : '');
      elToolsNote.hidden = !text;
      elToolsNote.textContent = text || '';
    }

    function hideDeleted() {
      state.deletedView = false;
      if (elDeleted) { elDeleted.hidden = true; elDeleted.innerHTML = ''; }
      elShelfArea.hidden = false;
      elCount.hidden = false;
    }

    // Two clicks, not a confirm(): the first says how many it is about to archive, the
    // second does it. Nothing is archived by a single stray tap, and the number is the
    // server's, not a guess (it comes back from the call).
    let archiveReadArmed = false;
    const elArchiveRead = root.querySelector('#wrs-archive-read');
    if (elArchiveRead) elArchiveRead.addEventListener('click', async () => {
      if (!archiveReadArmed) {
        archiveReadArmed = true;
        elArchiveRead.textContent = '📦 Archive all read — tap again to confirm';
        toolsNote('Everything you have ticked as read will be archived: hidden from the shelf, kept in Archived, and put back from there any time.');
        return;
      }
      elArchiveRead.disabled = true;
      try {
        const out = await api('/api/library/archive-read', { method: 'POST', body: {} });
        toolsNote(out.archived
          ? `Archived ${out.archived} item${out.archived === 1 ? '' : 's'} you had read. They are on the Archived shelf.`
          : 'Nothing to archive — you have not ticked anything as read yet.', out.archived ? 'good' : null);
        await loadBooks();
      } catch (err) {
        toolsNote((err && (err.message || err.error)) || 'Could not archive those.', 'bad');
      } finally {
        elArchiveRead.disabled = false;
        archiveReadArmed = false;
        elArchiveRead.textContent = '📦 Archive all read';
      }
    });

    const elShowDeleted = root.querySelector('#wrs-show-deleted');
    if (elShowDeleted) elShowDeleted.addEventListener('click', () => {
      if (state.deletedView) { hideDeleted(); return; }
      loadDeleted();
    });

    async function loadDeleted() {
      if (!elDeleted) return;
      state.deletedView = true;
      elShelfArea.hidden = true;
      elCount.hidden = true;
      elDeleted.hidden = false;
      elDeleted.innerHTML = '<div class="wrs-empty">Loading…</div>';
      try {
        const rows = await api('/api/library/deletions');
        if (!rows.length) {
          elDeleted.innerHTML = '<div class="wrs-empty">Nothing has been deleted from the reading room. <button type="button" class="wrs-btn" data-close-deleted="1">Back to the shelf</button></div>';
        } else {
          elDeleted.innerHTML = `
            <div class="wrs-shelf-tools">
              <button type="button" class="wrs-btn" data-close-deleted="1">← Back to the shelf</button>
              <span class="wrs-note">${rows.length} deleted. Restoring puts the item back in the reading room; a file that was already moved stays in wren-docs/_deleted/.</span>
            </div>
            <div class="wrs-deleted-list">
              ${rows.map(r => `
                <div class="wrs-deleted-row">
                  <div class="wrs-deleted-main">
                    <div class="wrs-deleted-title">${esc(r.title || r.fingerprint || (r.source + ':' + r.source_id))}</div>
                    <div class="wrs-deleted-meta">${esc(r.source)} · deleted ${esc(fmtDate(r.deleted_at))}${r.deleted_by_name ? ' by ' + esc(r.deleted_by_name) : ''}${r.file_rel_path ? ` · file ${esc(r.file_rel_path)}: ${esc(r.file_status || 'queued')}${r.moved_to ? ' → ' + esc(r.moved_to) : ''}` : ''}</div>
                  </div>
                  <button type="button" class="wrs-btn" data-restore="${esc(r.id)}">↩️ Restore</button>
                </div>`).join('')}
            </div>`;
        }
        elDeleted.querySelectorAll('[data-close-deleted]').forEach(b => b.addEventListener('click', hideDeleted));
        elDeleted.querySelectorAll('[data-restore]').forEach(btn => {
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
              const out = await api(`/api/library/deletions/${btn.dataset.restore}/restore`, { method: 'POST', body: {} });
              if (window.Wren && Wren.toast) Wren.toast(out.note || 'Back in the reading room');
              await loadDeleted();
              await loadBooks();
            } catch (err) {
              btn.disabled = false;
              if (window.Wren && Wren.toast) Wren.toast((err && (err.message || err.error)) || 'Could not restore that.');
            }
          });
        });
      } catch (e) {
        elDeleted.innerHTML = `<div class="wrs-empty">Could not load the deleted list (${esc(e && (e.message || e.error) || 'unknown error')}). <button type="button" class="wrs-btn" data-close-deleted="1">Back to the shelf</button></div>`;
        elDeleted.querySelectorAll('[data-close-deleted]').forEach(b => b.addEventListener('click', hideDeleted));
      }
    }

    // ── Reader ───────────────────────────────────────────────────────────────
    function closeReader() {
      elReader.hidden = true; elReader.innerHTML = '';
      elBrowse.hidden = false;
      state.book = null; state.chapter = null;
      syncUrl();
    }
    async function openBook(bookKey, chapterId) {
      state.book = bookKey;
      elBrowse.hidden = true;
      elReader.hidden = false;
      elReader.innerHTML = '<div class="wrs-empty">Loading…</div>';
      try {
        const book = await api('/api/library/books/' + encodeURIComponent(bookKey) + (state.archived ? '?archived=1' : ''));
        lastBook = book;
        const firstUnread = book.chapters.find(c => !c.read);
        state.chapter = chapterId || state.chapter || (firstUnread || book.chapters[0] || {}).source && `${(firstUnread || book.chapters[0]).source}:${(firstUnread || book.chapters[0]).source_id}`;
        renderReader(book);
        if (state.chapter) await openChapter(state.chapter, true);
      } catch (e) {
        elReader.innerHTML = `<div class="wrs-empty">Could not open this book (${esc(e && (e.message || e.error) || 'unknown error')}). <button type="button" class="wrs-btn" id="wrs-reader-back-err">← Back</button></div>`;
        const b = root.querySelector('#wrs-reader-back-err');
        if (b) b.addEventListener('click', closeReader);
      }
      syncUrl();
    }
    function renderReader(book) {
      const readCount = book.chapters.filter(c => c.read).length;
      elReader.innerHTML = `
        <button type="button" class="wrs-reader-back" id="wrs-reader-back">← Back to shelf</button>
        <div class="wrs-reader-head">
          <div>
            <div class="wrs-reader-title">${esc(book.title)}${book.subtitle ? ` <span style="font-weight:400;color:var(--c-muted);font-size:.85rem">— ${esc(book.subtitle)}</span>` : ''}</div>
            <div class="wrs-reader-sub">${book.chapter_count} chapter${book.chapter_count === 1 ? '' : 's'} · ${readCount} read${opts.admin ? ` · <button type="button" class="wrs-facet-clear" id="wrs-rename-book">✏️ Rename</button>` : ''}</div>
          </div>
        </div>
        <div class="wrs-reader-body-grid">
          <div class="wrs-chapterlist" id="wrs-chapterlist"></div>
          <div class="wrs-chapter-pane" id="wrs-chapter-pane"></div>
        </div>`;
      root.querySelector('#wrs-reader-back').addEventListener('click', closeReader);
      const renameBtn = root.querySelector('#wrs-rename-book');
      if (renameBtn) renameBtn.addEventListener('click', async () => {
        const title = prompt('Book title:', book.title);
        if (title == null) return;
        const subtitle = prompt('Subtitle (optional):', book.subtitle || '');
        try {
          await api('/api/library/books/' + encodeURIComponent(book.book_key), { method: 'PATCH', body: { title, subtitle: subtitle || null } });
          if (window.Wren && Wren.toast) Wren.toast('Renamed');
          await openBook(book.book_key, state.chapter);
        } catch (err) {
          const msg = (err && (err.message || err.error)) || 'Could not rename';
          if (window.Wren && Wren.toast) Wren.toast(msg); else alert(msg);
        }
      });
      renderChapterList(book);
    }
    function renderChapterList(book) {
      const el = root.querySelector('#wrs-chapterlist');
      if (!el) return;
      el.innerHTML = book.chapters.map(c => {
        const id = `${c.source}:${c.source_id}`;
        return `<div class="wrs-chapter-item${id === state.chapter ? ' active' : ''}${c.read ? ' read' : ''}${c.archived_at ? ' archived' : ''}" data-chapter="${esc(id)}">
          <span class="wrs-chapter-read-dot"></span>
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.chapter_title || c.title)}</span>
          ${c.archived_at ? '<span class="wrs-tag" title="Archived">Archived</span>' : ''}
          ${opts.admin ? `<button type="button" class="wrs-facet-clear" data-move="${esc(id)}" data-move-title="${esc(c.chapter_title || c.title)}" title="Move into a different book">Move</button>` : ''}
          ${opts.admin && book.chapter_count > 1 ? `<button type="button" class="wrs-facet-clear" data-split="${esc(id)}" title="Split out into its own book">Split</button>` : ''}
        </div>`;
      }).join('');
      el.querySelectorAll('[data-chapter]').forEach(row => {
        row.addEventListener('click', (ev) => { if (ev.target.closest('[data-split],[data-move]')) return; openChapter(row.dataset.chapter); });
      });
      if (opts.admin) el.querySelectorAll('[data-split]').forEach(btn => {
        btn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const [source, id] = btn.dataset.split.split(':');
          if (!confirm('Split this chapter out into its own 1-chapter book?')) return;
          try {
            await api('/api/library/books/split', { method: 'POST', body: { source, source_id: id } });
            if (window.Wren && Wren.toast) Wren.toast('Split out');
            closeReader(); loadBooks();
          } catch (err) {
            const msg = (err && (err.message || err.error)) || 'Could not split';
            if (window.Wren && Wren.toast) Wren.toast(msg); else alert(msg);
          }
        });
      });
      // b482b fix F5 — "Move into book…" had no on-screen control, only the
      // raw POST /books/move API (Rename and Split already had one each).
      if (opts.admin) el.querySelectorAll('[data-move]').forEach(btn => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const [moveSource, moveId] = btn.dataset.move.split(':');
          openMovePicker(moveSource, moveId, btn.dataset.moveTitle || '');
        });
      });
    }
    // b482b fix F5 — lists every existing book, filterable by title, so a
    // manager can combine a chapter into one without knowing its book_key by
    // heart. Deliberately picks among EXISTING books only — creating a brand
    // new combined book by hand is still a two-step "Split, then rename"
    // (Rename already covers it) rather than something this adds a second way
    // to do.
    function openMovePicker(source, sourceId, chapterTitle) {
      const picker = root.querySelector('#wrs-move-picker');
      const listEl = root.querySelector('#wrs-move-picker-list');
      const qEl = root.querySelector('#wrs-move-picker-q');
      if (!picker || !listEl || !qEl) return;
      qEl.value = '';
      picker.hidden = false;
      let allBooks = [];
      function closePicker() { picker.hidden = true; }
      async function doMove(bookKey) {
        try {
          await api('/api/library/books/move', { method: 'POST', body: { source, source_id: sourceId, book_key: bookKey, chapter_title: chapterTitle || null } });
          if (window.Wren && Wren.toast) Wren.toast('Moved');
          closePicker();
          closeReader(); loadBooks();
        } catch (err) {
          const msg = (err && (err.message || err.error)) || 'Could not move';
          if (window.Wren && Wren.toast) Wren.toast(msg); else alert(msg);
        }
      }
      function renderList() {
        const needle = qEl.value.trim().toLowerCase();
        const shown = (needle ? allBooks.filter(b => b.title.toLowerCase().includes(needle)) : allBooks).slice(0, 200);
        listEl.innerHTML = shown.length
          ? shown.map(b => `<button type="button" class="wrs-move-picker-item" data-pick="${esc(b.book_key)}"><span>${esc(b.title)}</span><span class="wrs-fc-count">${b.chapter_count}</span></button>`).join('')
          : '<div class="wrs-empty">No books match.</div>';
        listEl.querySelectorAll('[data-pick]').forEach(pickBtn => {
          pickBtn.addEventListener('click', () => doMove(pickBtn.dataset.pick));
        });
      }
      root.querySelector('#wrs-move-picker-close').onclick = closePicker;
      qEl.oninput = renderList;
      listEl.innerHTML = '<div class="wrs-empty">Loading…</div>';
      api('/api/library/books?sort=az').then(data => { allBooks = data.books || []; renderList(); })
        .catch(() => { listEl.innerHTML = '<div class="wrs-empty">Could not load the book list.</div>'; });
    }
    async function openChapter(chapterId, skipUrlSync) {
      state.chapter = chapterId;
      if (!skipUrlSync) syncUrl();
      root.querySelectorAll('.wrs-chapter-item').forEach(r => r.classList.toggle('active', r.dataset.chapter === chapterId));
      const pane = root.querySelector('#wrs-chapter-pane');
      if (!pane || !lastBook) return;
      const [source, id] = chapterId.split(':');
      const chapter = lastBook.chapters.find(c => c.source === source && String(c.source_id) === id);
      if (!chapter) { pane.innerHTML = '<div class="wrs-empty">Chapter not found.</div>'; return; }
      pane.innerHTML = '<div class="wrs-empty">Loading…</div>';

      // A reading_document chapter is a file — open it the existing b425b/c way
      // (fetch-with-Bearer → blob → tab) rather than trying to show it inline.
      if (source === 'reading_document') {
        pane.innerHTML = `
          <div class="wrs-chapter-pane-title">${esc(chapter.chapter_title || chapter.title)}</div>
          ${archivedBanner(chapter)}
          ${provenanceHtml(chapter)}
          ${extentHtml(chapter)}
          <div class="wrs-chapter-pane-body">${chapter.summary ? esc(chapter.summary) : 'This chapter is a document.'}</div>
          <div class="wrs-chapter-nav">
            <button type="button" class="wrs-btn primary" id="wrs-open-doc">Open original ↗</button>
            <button type="button" class="wrs-btn" id="wrs-toggle-read">${chapter.read ? 'Mark as unread' : 'Mark as read'}</button>
          </div>
          ${itemAdminHtml(chapter)}`;
        root.querySelector('#wrs-open-doc').addEventListener('click', () => openDocument(chapter.href));
        wireReadToggle(pane, chapter);
        wireChapterNav(pane, chapterId);
        wireItemAdmin(pane, chapter);
        return;
      }

      try {
        const data = await api(`/api/library/books/${encodeURIComponent(state.book)}/chapter/${source}/${id}`);
        const rawHtml = data.body && data.body.html;
        const rawText = data.body && data.body.text;
        // b519 — the chapter object from the book detail already carries provenance/extent;
        // the chapter endpoint sends them too, so merge whichever arrived (a pasted
        // ?chapter=… link can land here with the book's copy missing a field).
        if (data.item) {
          if (!chapter.provenance && data.item.provenance) chapter.provenance = data.item.provenance;
          if (!chapter.extent && data.item.extent) chapter.extent = data.item.extent;
          if (!chapter.so_what && data.item.so_what) chapter.so_what = data.item.so_what;
        }
        const openRow = openOriginalHtml(chapter);
        pane.innerHTML = `
          <div class="wrs-chapter-pane-title">${esc(chapter.chapter_title || chapter.title)}</div>
          ${archivedBanner(chapter)}
          ${provenanceHtml(chapter)}
          ${extentHtml(chapter)}
          ${soWhatHtml(chapter)}
          <div class="wrs-chapter-pane-body" id="wrs-chapter-pane-body"></div>
          ${openRow ? `<div class="wrs-open-row">${openRow}</div>` : ''}
          <div class="wrs-chapter-nav">
            <span></span>
            <button type="button" class="wrs-btn" id="wrs-toggle-read">${chapter.read ? 'Mark as unread' : 'Mark as read'}</button>
          </div>
          ${itemAdminHtml(chapter)}`;
        // b482b fix F1 — built as an empty placeholder above, filled in here
        // via real DOM calls, never via a string dropped into innerHTML.
        renderChapterBody(pane.querySelector('#wrs-chapter-pane-body'), source, rawHtml, chapter, rawText);
        wireOpenOriginal(pane);
        wireReadToggle(pane, chapter);
        wireChapterNav(pane, chapterId);
        wireItemAdmin(pane, chapter);
      } catch (e) {
        pane.innerHTML = `<div class="wrs-empty">Could not open this chapter (${esc(e && (e.message || e.error) || 'unknown error')}).</div>`;
      }
    }
    // ── b519: archive + delete, per item, inside the pane ──────────────────
    function archivedBanner(chapter) {
      if (!chapter || !chapter.archived_at) return '';
      return `<div class="wrs-note">📦 Archived${chapter.archived_by ? ` by ${esc(chapter.archived_by)}` : ''} on ${esc(fmtDate(chapter.archived_at))} — it is hidden from the shelf until you put it back.</div>`;
    }

    function itemAdminHtml(chapter) {
      if (!opts.admin) return '';
      const archived = !!chapter.archived_at;
      const fd = (chapter.provenance && chapter.provenance.file_delete) || null;
      const relPath = (chapter.provenance && chapter.provenance.path) || null;
      const fileOpt = relPath
        ? (fd && fd.ok
            ? `<label class="wrs-confirm-opt"><input type="radio" name="wrs-del-mode" value="file">
                 <span>Also delete the file.<span class="wrs-confirm-why">wren-docs/${esc(relPath)} is moved to wren-docs/_deleted/ — not erased — by the next run of the host sweep. It is in git as well, so there are two ways back.</span></span></label>`
            : `<label class="wrs-confirm-opt off"><input type="radio" name="wrs-del-mode" value="file" disabled>
                 <span>Also delete the file.<span class="wrs-confirm-why">Not for this one: ${esc((fd && fd.reason) || 'the file is kept.')}</span></span></label>`)
        : `<label class="wrs-confirm-opt off"><input type="radio" name="wrs-del-mode" value="file" disabled>
             <span>Also delete the file.<span class="wrs-confirm-why">There is no file behind this item — it is a record inside Wren.</span></span></label>`;
      return `
        <div class="wrs-admin-row">
          <button type="button" class="wrs-btn" id="wrs-archive">${archived ? '↩️ Put back on the shelf' : '📦 Archive'}</button>
          <button type="button" class="wrs-btn danger" id="wrs-delete">🗑️ Delete from reading room…</button>
        </div>
        <div class="wrs-confirm" id="wrs-del-confirm" hidden>
          <div class="wrs-confirm-title">Delete “${esc(chapter.chapter_title || chapter.title)}” from the reading room?</div>
          <label class="wrs-confirm-opt"><input type="radio" name="wrs-del-mode" value="item" checked>
            <span>Take it out of the reading room.<span class="wrs-confirm-why">It stops being listed, the scanners will not put it back, and you can restore it from <b>Deleted</b>. Nothing on disk changes.</span></span></label>
          ${fileOpt}
          <div class="wrs-confirm-actions">
            <button type="button" class="wrs-btn danger" id="wrs-del-go">Delete</button>
            <button type="button" class="wrs-btn" id="wrs-del-cancel">Cancel</button>
          </div>
          <div class="wrs-note" id="wrs-del-note" hidden></div>
        </div>`;
    }

    function wireOpenOriginal(pane) {
      pane.querySelectorAll('[data-open-blob]').forEach(btn => {
        btn.addEventListener('click', () => openDocument(btn.dataset.openBlob));
      });
    }

    function wireItemAdmin(pane, chapter) {
      if (!opts.admin) return;
      const archiveBtn = pane.querySelector('#wrs-archive');
      if (archiveBtn) archiveBtn.addEventListener('click', async () => {
        const want = !chapter.archived_at;
        archiveBtn.disabled = true;
        try {
          const out = await api(`/api/library/${chapter.source}/${chapter.source_id}/archive`, { method: 'POST', body: { archived: want } });
          chapter.archived_at = out.archived_at || null;
          chapter.archived_by = out.archived_by || null;
          // Archiving unpins, both here and on the server — so drop the badge now rather
          // than leaving a 📌 on something that has just been filed away.
          if (chapter.archived_at) chapter.pinned = false;
          if (window.Wren && Wren.toast) Wren.toast(want ? 'Archived' : 'Back on the shelf');
          // The shelf it came from no longer contains it (or now does), so reload both.
          await loadBooks();
          await openBook(state.book, `${chapter.source}:${chapter.source_id}`);
        } catch (err) {
          archiveBtn.disabled = false;
          showPaneNote(pane, (err && (err.message || err.error)) || 'Could not archive this.', 'bad');
        }
      });

      const delBtn = pane.querySelector('#wrs-delete');
      const confirmEl = pane.querySelector('#wrs-del-confirm');
      if (delBtn && confirmEl) {
        delBtn.addEventListener('click', () => { confirmEl.hidden = !confirmEl.hidden; });
        const cancel = confirmEl.querySelector('#wrs-del-cancel');
        if (cancel) cancel.addEventListener('click', () => { confirmEl.hidden = true; });
        const go = confirmEl.querySelector('#wrs-del-go');
        if (go) go.addEventListener('click', async () => {
          const mode = (confirmEl.querySelector('input[name="wrs-del-mode"]:checked') || {}).value || 'item';
          go.disabled = true;
          try {
            const out = await api(`/api/library/${chapter.source}/${chapter.source_id}/delete`, {
              method: 'POST', body: { confirm: true, also_delete_file: mode === 'file' },
            });
            // Say exactly what happened, including the half that was refused.
            let msg = 'Deleted from the reading room.';
            if (out.file && out.file.queued) msg += ' The file is queued to be moved to wren-docs/_deleted/.';
            else if (out.file && out.file.refused) msg += ' The file was NOT deleted: ' + out.file.refused;
            if (window.Wren && Wren.toast) Wren.toast(msg);
            closeReader();
            await loadBooks();
          } catch (err) {
            go.disabled = false;
            showPaneNote(pane, (err && (err.message || err.error)) || 'Could not delete this.', 'bad');
          }
        });
      }
    }

    // One place for an in-pane message, so nothing here reaches for alert().
    function showPaneNote(pane, text, kind) {
      let el = pane.querySelector('#wrs-del-note');
      if (!el) {
        el = document.createElement('div');
        el.id = 'wrs-del-note';
        pane.appendChild(el);
      }
      el.className = 'wrs-note' + (kind ? ' ' + kind : '');
      el.hidden = false;
      el.textContent = text;
    }

    function wireReadToggle(pane, chapter) {
      const btn = pane.querySelector('#wrs-toggle-read');
      if (!btn) return;
      btn.addEventListener('click', async () => {
        const nextRead = !chapter.read;
        try {
          await api('/api/library/progress', { method: 'POST', body: { source: chapter.source, source_id: chapter.source_id, book_key: state.book, read: nextRead } });
          chapter.read = nextRead;
          btn.textContent = nextRead ? 'Mark as unread' : 'Mark as read';
          const row = root.querySelector(`.wrs-chapter-item[data-chapter="${chapter.source}:${chapter.source_id}"]`);
          if (row) row.classList.toggle('read', nextRead);
        } catch (err) {
          const msg = (err && (err.message || err.error)) || 'Could not save progress';
          if (window.Wren && Wren.toast) Wren.toast(msg); else alert(msg);
        }
      });
    }
    function wireChapterNav(pane, chapterId) {
      if (!lastBook) return;
      const idx = lastBook.chapters.findIndex(c => `${c.source}:${c.source_id}` === chapterId);
      const prev = idx > 0 ? lastBook.chapters[idx - 1] : null;
      const next = idx >= 0 && idx < lastBook.chapters.length - 1 ? lastBook.chapters[idx + 1] : null;
      const nav = document.createElement('div');
      nav.className = 'wrs-chapter-nav';
      nav.innerHTML = `
        <button type="button" class="wrs-btn" id="wrs-prev-ch"${prev ? '' : ' disabled'}>← Previous</button>
        <button type="button" class="wrs-btn" id="wrs-next-ch"${next ? '' : ' disabled'}>Next →</button>`;
      pane.appendChild(nav);
      if (prev) nav.querySelector('#wrs-prev-ch').addEventListener('click', () => openChapter(`${prev.source}:${prev.source_id}`));
      if (next) nav.querySelector('#wrs-next-ch').addEventListener('click', () => openChapter(`${next.source}:${next.source_id}`));
    }

    // b425b fix #2 / b425c fix D3 — fetch with the Bearer header (+ X-Wren-Device
    // on EY), open as a blob in a tab opened synchronously inside the click (so
    // popup blockers don't eat it). Unchanged from b425/b425c; reused by the
    // reader above for any reading_document chapter.
    async function openDocument(url) {
      const w = window.open('', '_blank');
      if (w) { try { w.document.write('<p style="font-family:sans-serif;padding:24px;color:#666">Loading…</p>'); } catch (_) {} }
      try {
        const token = (window.Wren && Wren.getToken) ? Wren.getToken() : null;
        let device = '';
        try { device = localStorage.getItem('wrenDevice') || ''; } catch (_) {}
        const headers = {};
        if (token) headers.Authorization = 'Bearer ' + token;
        if (device) headers['X-Wren-Device'] = device;
        const r = await fetch(url, { headers });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const blob = await r.blob();
        const blobUrl = URL.createObjectURL(blob);
        if (w) w.location = blobUrl; else window.open(blobUrl, '_blank');
      } catch (e) {
        const msg = 'Could not open the document (' + esc((e && e.message) || e) + ').';
        if (w) { try { w.document.open(); w.document.write('<p style="font-family:sans-serif;padding:24px;color:#b3261e">' + msg + '</p>'); w.document.close(); } catch (_) {} }
        else if (window.Wren && Wren.toast) Wren.toast(msg); else alert(msg);
      }
    }

    // ── Admin-only tabs: Needs review / Upload / Overview — UNCHANGED from
    // b425/b426/b427, operating on raw reading_documents rows via /api/library
    // (not /api/library/books). ──────────────────────────────────────────────
    if (opts.admin) {
      const elReviewTools = root.querySelector('#wrr-review-tools');
      const elFolder = root.querySelector('#wrr-folder');
      const elBulk = root.querySelector('#wrr-bulk');
      const elAreas = root.querySelector('#wrr-areas');
      elFolder.addEventListener('change', () => { state.folder = elFolder.value || null; loadReview(); });

      const elOverview = root.querySelector('#wrr-overview');
      root.querySelectorAll('.wrr-tab').forEach(btn => btn.addEventListener('click', () => {
        root.querySelectorAll('.wrr-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.tab = btn.dataset.tab;
        elBrowse.hidden = state.tab !== 'browse';
        elReader.hidden = true; // leaving Browse always closes any open reader
        root.querySelector('#wrr-upload').hidden = state.tab !== 'upload';
        elReviewTools.hidden = state.tab !== 'review';
        elList.hidden = state.tab !== 'review';
        if (elOverview) elOverview.hidden = state.tab !== 'overview';
        if (state.tab === 'review') loadReview();
        else if (state.tab === 'browse') loadBooks();
        else if (state.tab === 'overview') loadOverview();
      }));

      const UNCATEGORISED = '__none__';
      function renderReviewAreas(areas) {
        elAreas.innerHTML = areas.map(a => {
          const slug = a.slug || UNCATEGORISED;
          return `
          <button class="wrr-area${state.area === slug ? ' active' : ''}" data-slug="${esc(slug)}" type="button">
            <span class="wrr-area-name">${esc(a.name)}</span><span class="wrr-area-count">${a.count}</span>
          </button>`;
        }).join('');
        elAreas.querySelectorAll('.wrr-area').forEach(btn => btn.addEventListener('click', () => {
          const slug = btn.dataset.slug;
          state.area = state.area === slug ? null : slug;
          renderReviewAreas(areas);
          loadReview();
        }));
      }

      // b426 — the bulk toolbar: selection count, publish (to whichever
      // audiences are ticked) or discard, for every checked reading_document.
      function selectedIds() {
        return Array.from(elList.querySelectorAll('.wrr-review-check:checked')).map(c => c.dataset.id);
      }
      function updateBulkBar() {
        const n = selectedIds().length;
        elBulk.hidden = n === 0;
        root.querySelector('#wrr-bulk-count').textContent = n + (n === 1 ? ' selected' : ' selected');
      }
      elList.addEventListener('change', (e) => { if (e.target.classList.contains('wrr-review-check')) updateBulkBar(); });
      root.querySelector('#wrr-bulk-publish').addEventListener('click', async () => {
        const ids = selectedIds();
        if (!ids.length) return;
        const audiences = ['admin', 'staff', 'parents'].filter(a => root.querySelector('#wrr-pub-' + a).checked);
        try {
          await api('/api/library/documents/bulk', { method: 'POST', body: { ids, audiences, publish: true } });
          if (window.Wren && Wren.toast) Wren.toast(`Published ${ids.length} document(s)`);
          loadReview();
        } catch (err) { if (window.Wren && Wren.toast) Wren.toast(err.message || err.error || 'Could not publish'); }
      });
      root.querySelector('#wrr-bulk-discard').addEventListener('click', async () => {
        const ids = selectedIds();
        if (!ids.length) return;
        if (!confirm(`Discard ${ids.length} document(s)? This archives them — they will no longer appear in Needs review.`)) return;
        try {
          await api('/api/library/documents/bulk', { method: 'POST', body: { ids, discard: true } });
          if (window.Wren && Wren.toast) Wren.toast(`Discarded ${ids.length} document(s)`);
          loadReview();
        } catch (err) { if (window.Wren && Wren.toast) Wren.toast(err.message || err.error || 'Could not discard'); }
      });
      // b427 — "What's in the Reading Room": counts by area x audience, what's due for
      // review soon, what has no area set, and the paperless checklist (ticked here only —
      // never writes anywhere else in Wren).
      async function loadOverview() {
        if (!elOverview) return;
        elOverview.innerHTML = '<div class="wrr-empty">Loading…</div>';
        try {
          const data = await api('/api/library/overview');
          elOverview.innerHTML = renderOverview(data);
          wireChecklist();
        } catch (e) {
          elOverview.innerHTML = `<div class="wrr-empty">Could not load the overview (${esc(e && (e.message || e.error) || 'unknown error')}).</div>`;
        }
      }

      function renderOverview(data) {
        const audCols = [['admin', 'Admin'], ['staff', 'Staff'], ['parents', 'Parents'], ['pupils', 'Pupils']];
        const grid = `
          <div class="wro-section">
            <h3 class="wro-h">By area &amp; audience <span class="wro-total">${data.total_items} items total</span></h3>
            <div class="wro-table-wrap"><table class="wro-table">
              <thead><tr><th>Area</th>${audCols.map(([, l]) => `<th>${esc(l)}</th>`).join('')}</tr></thead>
              <tbody>${data.areas.map(a => `
                <tr><td>${esc(a.name)}</td>${audCols.map(([k]) => `<td>${a[k] || 0}</td>`).join('')}</tr>`).join('')}
              </tbody>
            </table></div>
          </div>`;

        const dueSoon = `
          <div class="wro-section">
            <h3 class="wro-h">Due for review in the next 30 days <span class="wro-total">${data.due_soon.length}</span></h3>
            ${data.due_soon.length ? `<ul class="wro-list">${data.due_soon.map(i => `
              <li><a href="${esc(i.href || '#')}">${esc(i.title)}</a> <span class="wro-muted">— due ${fmtDate(i.review_date)}</span></li>`).join('')}</ul>`
              : '<div class="wrr-empty">Nothing due.</div>'}
          </div>`;

        const noArea = `
          <div class="wro-section">
            <h3 class="wro-h">Items with no area set <span class="wro-total">${data.no_area.length}</span></h3>
            ${data.no_area.length ? `<ul class="wro-list">${data.no_area.slice(0, 50).map(i => `
              <li><a href="${esc(i.href || '#')}">${esc(i.title)}</a> <span class="wro-muted">(${esc(TYPE_LABEL[i.type] || i.type)})</span></li>`).join('')}</ul>${data.no_area.length > 50 ? `<div class="wro-muted">…and ${data.no_area.length - 50} more.</div>` : ''}`
              : '<div class="wrr-empty">Every item has an area.</div>'}
          </div>`;

        const areaNameOf = (slug) => (data.areas.find(a => a.slug === slug) || {}).name || slug;
        const checklistAreas = Object.keys(data.checklist || {});
        const checklist = `
          <div class="wro-section">
            <h3 class="wro-h">Paperless checklist <span class="wro-total">${checklistAreas.reduce((n, s) => n + data.checklist[s].length, 0)} items</span></h3>
            <div class="wro-muted" style="margin-bottom:10px">Paper forms and processes with no Wren equivalent yet — tick them off as that changes. A tick here only updates this checklist.</div>
            ${checklistAreas.map(areaSlug => `
              <div class="wro-check-area">
                <div class="wro-check-area-name">${esc(areaNameOf(areaSlug))}</div>
                ${data.checklist[areaSlug].map(row => `
                  <div class="wro-check-row" data-id="${row.id}">
                    <div class="wro-check-item">
                      <div>${esc(row.item)}</div>
                      ${row.detail ? `<div class="wro-muted">${esc(row.detail)}</div>` : ''}
                    </div>
                    <select class="wrr-select wro-check-status" data-id="${row.id}">
                      ${Object.keys(CHECKLIST_STATUS_LABEL).map(s => `<option value="${s}"${s === row.status ? ' selected' : ''}>${esc(CHECKLIST_STATUS_LABEL[s])}</option>`).join('')}
                    </select>
                  </div>`).join('')}
              </div>`).join('')}
          </div>`;

        return grid + dueSoon + noArea + checklist;
      }

      function wireChecklist() {
        elOverview.querySelectorAll('.wro-check-status').forEach(sel => {
          sel.addEventListener('change', async () => {
            try {
              await api(`/api/library/checklist/${sel.dataset.id}`, { method: 'PATCH', body: { status: sel.value } });
              if (window.Wren && Wren.toast) Wren.toast('Updated');
            } catch (err) {
              if (window.Wren && Wren.toast) Wren.toast(err.message || err.error || 'Could not update');
            }
          });
        });
      }

      const form = root.querySelector('#wrr-upload-form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        try {
          // A multipart upload can't go through Wren.api() — it force-sets
          // Content-Type: application/json, which would break the FormData
          // boundary. Same manual-header pattern reading-corner.html's own
          // magazine upload uses.
          const token = (window.Wren && Wren.getToken) ? Wren.getToken() : (sessionStorage.getItem('wrenToken') || '');
          let device = '';
          try { device = localStorage.getItem('wrenDevice') || ''; } catch (_) {}
          const headers = {};
          if (token) headers.Authorization = 'Bearer ' + token;
          if (device) headers['X-Wren-Device'] = device;
          const r = await fetch('/api/library/documents', {
            method: 'POST', body: fd,
            headers,
          });
          if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'Upload failed'); }
          form.reset();
          if (window.Wren && Wren.toast) Wren.toast('Uploaded — now in Needs review');
          root.querySelector('[data-tab="review"]').click();
        } catch (err) {
          if (window.Wren && Wren.toast) Wren.toast(err.message); else alert(err.message);
        }
      });

      function card(item, admin, reviewMode) {
        const badge = item.pinned ? '<span class="wrr-pin" title="Pinned">📌</span>' : '';
        const review = item.review_date ? `<span class="wrr-review">Review due ${fmtDate(item.review_date)}</span>` : '';
        const needsReview = item.needs_review ? '<span class="wrr-needs">Needs review</span>' : '';
        const folder = (admin && item.drive_folder) ? `<span class="wrr-folder" title="${esc(item.drive_path || '')}">📁 ${esc(item.drive_folder)}</span>` : '';
        const link = item.href || '#';
        const openAttr = item.source === 'reading_document' ? ` data-open-doc="${esc(link)}"` : '';
        const bulkCheck = (reviewMode && item.source === 'reading_document')
          ? `<label class="wrr-check-wrap"><input type="checkbox" class="wrr-review-check" data-id="${esc(item.source_id)}"></label>` : '';
        return `
          <a class="wrr-card" href="${esc(link)}"${openAttr}>
            <div class="wrr-card-top">
              ${bulkCheck}
              <span class="wrr-type">${esc(TYPE_LABEL[item.type] || item.type)}</span>
              ${badge}${needsReview}${folder}
            </div>
            <div class="wrr-card-title">${esc(item.title)}</div>
            ${item.summary ? `<div class="wrr-card-summary">${esc(item.summary)}</div>` : ''}
            ${(admin && reviewMode && item.proposed_audiences && item.proposed_audiences.length) ? `<div class="wrr-proposed">Suggested audience: ${item.proposed_audiences.map(esc).join(', ')}</div>` : ''}
            <div class="wrr-card-meta">
              ${item.updated_at ? `<span>Updated ${fmtDate(item.updated_at)}</span>` : ''}
              ${item.version ? `<span>v${esc(item.version)}</span>` : ''}
              ${review}
            </div>
            ${admin ? `<div class="wrr-card-admin" data-id="${esc(item.source)}:${esc(item.source_id)}" data-areas="${esc((item.areas || []).join(','))}" data-audiences="${esc((item.audiences || []).join(','))}">
              <button type="button" class="wrr-btn small" data-act="meta">Set area / audience</button>
            </div>` : ''}
          </a>`;
      }
      function wireDocLinks() {
        elList.querySelectorAll('[data-open-doc]').forEach(a => {
          if (!(window.Wren && typeof Wren.getToken === 'function')) return; // Parents: let the normal link happen
          a.addEventListener('click', (ev) => {
            if (ev.target.closest('.wrr-check-wrap')) return;
            ev.preventDefault(); openDocument(a.dataset.openDoc);
          });
        });
      }
      function wireMetaButtons() {
        elList.querySelectorAll('[data-act="meta"]').forEach(btn => {
          btn.addEventListener('click', async (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            const adminEl = btn.closest('.wrr-card-admin');
            const [source, id] = adminEl.dataset.id.split(':');
            const areasCsv = prompt('Areas (comma-separated slugs), e.g. safeguarding,training-cpd', adminEl.dataset.areas || '');
            if (areasCsv == null) return;
            const audCsv = prompt('Audiences (comma-separated: admin,staff,parents,pupils)', adminEl.dataset.audiences || '');
            if (audCsv == null) return;
            const body = {
              areas: areasCsv.split(',').map(s => s.trim()).filter(Boolean),
              audiences: audCsv.split(',').map(s => s.trim()).filter(Boolean),
              needs_review: false,
            };
            try {
              await api(`/api/library/${source}/${id}/meta`, { method: 'PATCH', body });
              if (window.Wren && Wren.toast) Wren.toast('Updated');
            } catch (err) {
              const msg = (err && (err.message || err.error)) || 'Could not update area/audience';
              if (window.Wren && Wren.toast) Wren.toast(msg); else alert(msg);
            }
            loadReview();
          });
        });
      }

      async function loadReview() {
        elList.innerHTML = '<div class="wrr-empty">Loading…</div>';
        try {
          const qs = new URLSearchParams();
          if (state.area) qs.set('area', state.area);
          if (state.folder) qs.set('folder', state.folder);
          const items = await api('/api/library/needs-review?' + qs.toString());
          const elFolderSel = root.querySelector('#wrr-folder');
          if (elFolderSel) {
            const folders = Array.from(new Set((items || []).map(i => i.drive_folder).filter(Boolean))).sort();
            elFolderSel.innerHTML = '<option value="">All folders</option>' + folders.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
            elFolderSel.value = state.folder || '';
          }
          elList.innerHTML = (items || []).length
            ? items.map(i => card(i, true, true)).join('')
            : '<div class="wrr-empty">Nothing waiting for review.</div>';
          wireMetaButtons();
          wireDocLinks();
          const elBulkEl = root.querySelector('#wrr-bulk');
          if (elBulkEl) { elBulkEl.hidden = true; root.querySelector('#wrr-bulk-count').textContent = ''; }
        } catch (e) {
          elList.innerHTML = `<div class="wrr-empty">Could not load the queue (${esc(e && (e.message || e.error) || 'unknown error')}).</div>`;
        }
        api('/api/library/areas').then(renderReviewAreas).catch(() => {});
      }
    }

    loadBooks();
    if (state.book) openBook(state.book, state.chapter);
  }

  window.WrenReadingRoom = { init };
})();
