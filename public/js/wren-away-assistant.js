/* wren-away-assistant.js — b512 (2026-10-18). ONE "when Toby's away" screen for Roost and HR.
 *
 *   WrenAwayAssistant.mount(el, { portal: 'roost' | 'hr' })
 *
 * A chat with a big mode picker, the mode's own boundaries on screen, citations that open the
 * cited passage in place, "Copy as message", the decision-rights table, and the list of questions
 * nothing could answer. One file so the two portals cannot drift (feedback_one_place_one_version).
 *
 * Colours are var(--c-*) tokens only — no colour literal anywhere in this file — so it follows
 * whatever palette the portal is wearing in light and in dark. Roost ignores prefers-color-scheme
 * (b511): wren-theme.js decides, and these tokens follow it.
 *
 * The answer streams as plain chunked text (not SSE), and the meta — citations, who decides, the
 * gap flag — arrives in the base64 X-Away-Meta-B64 header BEFORE the first byte. So the sources
 * shown under an answer are always the RETRIEVED labels and never anything the model wrote. Same
 * rule as the apprentice chat, for the same reason.
 */
(function () {
  'use strict';
  if (window.WrenAwayAssistant) return;

  var CSS = [
    '.awx{max-width:900px;margin:0 auto;color:var(--c-text);font-size:14px}',
    '.awx *{box-sizing:border-box}',
    '.awx-head{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:flex-start;justify-content:space-between;margin:0 0 14px}',
    '.awx-head h1{font-size:21px;margin:0 0 3px;line-height:1.25}',
    '.awx-sub{color:var(--c-muted);font-size:13px;margin:0;max-width:58ch;line-height:1.5}',
    '.awx-chips{display:flex;flex-wrap:wrap;gap:6px}',
    '.awx-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--c-border);background:var(--c-surface);color:var(--c-text);border-radius:999px;padding:4px 10px;font-size:11px;line-height:1.4}',
    '.awx-chip.ok{border-color:var(--c-green)}.awx-chip.warn{border-color:var(--c-amber)}.awx-chip.bad{border-color:var(--c-red)}',
    // the away-mode banner. ONE Away Mode: this reads /api/away-mode's state through /status.
    '.awx-banner{border:1px solid var(--c-amber);border-left-width:4px;background:var(--c-surface);border-radius:12px;padding:12px 14px;margin:0 0 14px}',
    '.awx-banner.off{border-color:var(--c-border)}',
    '.awx-banner h2{font-size:15px;margin:0 0 4px}',
    '.awx-banner p{margin:0;font-size:13px;line-height:1.55}.awx-banner p+p{margin-top:6px}',
    // the mode picker — big, because a person under pressure should not have to aim
    '.awx-modes{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin:0 0 12px}',
    '.awx-mode{display:flex;flex-direction:column;gap:3px;text-align:left;border:1px solid var(--c-border);background:var(--c-surface);color:var(--c-text);border-radius:14px;padding:11px 13px;font:inherit;cursor:pointer;min-height:78px}',
    '.awx-mode:hover{border-color:var(--c-blue)}',
    '.awx-mode:focus-visible{outline:2px solid var(--c-blue);outline-offset:2px}',
    '.awx-mode[aria-pressed="true"]{border-color:var(--c-blue);border-width:2px;padding:10px 12px}',
    '.awx-mode .m-top{display:flex;align-items:center;gap:7px;font-weight:700;font-size:14px}',
    '.awx-mode .m-ico{font-size:18px;line-height:1}',
    '.awx-mode .m-blurb{color:var(--c-muted);font-size:12px;line-height:1.4}',
    '.awx-bounds{background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;padding:10px 14px;margin:0 0 12px;font-size:12.5px;color:var(--c-muted)}',
    '.awx-bounds summary{cursor:pointer;color:var(--c-text);font-size:13px;min-height:32px;display:flex;align-items:center;gap:7px;list-style:none}',
    '.awx-bounds summary::-webkit-details-marker{display:none}',
    '.awx-bounds ul{margin:8px 0 0;padding-left:20px;line-height:1.55}.awx-bounds li+li{margin-top:4px}',
    '.awx-bounds .order{margin-top:8px;padding-top:8px;border-top:1px dashed var(--c-border);line-height:1.6}',
    '.awx-bounds .order code{background:var(--c-bg);border:1px solid var(--c-border);border-radius:5px;padding:0 5px;font-size:11.5px}',
    // the thread
    '.awx-thread{display:flex;flex-direction:column;gap:14px;min-height:190px;padding:4px 0 12px}',
    '.awx-empty{color:var(--c-muted);text-align:center;padding:22px 8px}',
    '.awx-empty p{margin:0 0 12px;line-height:1.55}',
    '.awx-sugg{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}',
    '.awx-sugg button{min-height:44px;text-align:left;border:1px solid var(--c-border);background:var(--c-surface);color:var(--c-text);border-radius:12px;padding:0 13px;font:inherit;font-size:13px;cursor:pointer}',
    '.awx-sugg button:hover{border-color:var(--c-blue)}',
    '.awx-msg{max-width:94%;border-radius:14px;padding:11px 14px;line-height:1.6;word-break:break-word}',
    '.awx-msg.user{align-self:flex-end;background:var(--c-blue);color:var(--c-on-blue);font-weight:500;border-bottom-right-radius:4px;max-width:86%}',
    '.awx-msg.bot{align-self:flex-start;background:var(--c-surface);border:1px solid var(--c-border);border-bottom-left-radius:4px}',
    '.awx-msg.bot.em{border-color:var(--c-red);border-left-width:4px}',
    '.awx-msg.bot.gap{border-color:var(--c-amber);border-left-width:4px}',
    '.awx-msg p{margin:0 0 9px}.awx-msg p:last-child{margin-bottom:0}',
    '.awx-msg ul,.awx-msg ol{margin:4px 0 9px;padding-left:21px}.awx-msg li{margin:0 0 4px}',
    '.awx-msg strong{font-weight:700}',
    '.awx-msg code{background:var(--c-bg);border:1px solid var(--c-border);border-radius:5px;padding:0 4px;font-size:.86em}',
    '.awx-owner{margin-top:10px;padding:8px 11px;border:1px solid var(--c-blue);border-radius:10px;background:var(--c-bg);font-size:13px;line-height:1.5}',
    '.awx-owner b{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--c-muted);margin-bottom:2px}',
    '.awx-owner.draft{border-color:var(--c-amber)}',
    '.awx-owner .dflag{display:block;margin-top:4px;color:var(--c-muted);font-size:12px}',
    '.awx-srcs{margin-top:10px;padding-top:8px;border-top:1px dashed var(--c-border)}',
    '.awx-srcs .lbl{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--c-muted);margin-bottom:5px}',
    '.awx-src{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--c-border);background:var(--c-bg);color:var(--c-text);border-radius:8px;padding:4px 9px;margin:0 5px 5px 0;font:inherit;font-size:12px;cursor:pointer;min-height:32px;text-align:left}',
    '.awx-src:hover{border-color:var(--c-blue)}.awx-src:focus-visible{outline:2px solid var(--c-blue);outline-offset:1px}',
    '.awx-src .k{color:var(--c-muted);font-size:10px;text-transform:uppercase;letter-spacing:.04em}',
    '.awx-actions{margin-top:9px;display:flex;flex-wrap:wrap;gap:6px}',
    '.awx-actions button{min-height:36px;font-size:12.5px;padding:0 11px;border:1px solid var(--c-border);background:var(--c-surface);color:var(--c-text);border-radius:10px;font:inherit;font-size:12.5px;cursor:pointer}',
    '.awx-actions button:hover{border-color:var(--c-blue)}',
    '.awx-think{display:inline-flex;gap:5px;align-items:center;color:var(--c-muted)}',
    '.awx-think i{width:7px;height:7px;border-radius:50%;background:var(--c-muted);animation:awxp 1s infinite ease-in-out}',
    '.awx-think i:nth-child(2){animation-delay:.15s}.awx-think i:nth-child(3){animation-delay:.3s}',
    '@keyframes awxp{0%,80%,100%{opacity:.25}40%{opacity:1}}',
    '@media (prefers-reduced-motion:reduce){.awx-think i{animation:none;opacity:.7}}',
    // the composer
    '.awx-composer{position:sticky;bottom:0;z-index:5;display:flex;gap:8px;align-items:flex-end;background:var(--c-bg);padding:10px 0 8px;border-top:1px solid var(--c-border)}',
    '.awx-composer textarea{flex:1;min-width:0;resize:none;min-height:46px;max-height:150px;background:var(--c-surface);border:1px solid var(--c-border);color:var(--c-text);border-radius:12px;padding:12px;font:inherit;font-size:14px;line-height:1.4;overflow:hidden}',
    '.awx-composer textarea::placeholder{color:var(--c-muted)}',
    '.awx-btn{min-height:44px;min-width:44px;border:1px solid var(--c-border);background:var(--c-surface);color:var(--c-text);border-radius:12px;padding:0 15px;font:inherit;font-size:13.5px;font-weight:700;cursor:pointer}',
    '.awx-btn:hover{border-color:var(--c-blue)}',
    '.awx-btn.pri{border-color:var(--c-blue);color:var(--c-blue)}',
    '.awx-btn:disabled{opacity:.5;cursor:default}',
    '.awx-btn:focus-visible,.awx-composer textarea:focus-visible{outline:2px solid var(--c-blue);outline-offset:2px}',
    // the panels
    '.awx-panel{background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;padding:10px 14px;margin:14px 0 0;font-size:13px}',
    '.awx-panel summary{cursor:pointer;min-height:38px;display:flex;align-items:center;gap:8px;font-size:13.5px;list-style:none}',
    '.awx-panel summary::-webkit-details-marker{display:none}',
    // A summary set to display:flex drops its own disclosure triangle, so all
    // three panels read as inert boxes. This puts the affordance back explicitly.
    '.awx-bounds summary::before,.awx-panel summary::before{content:"\\25B8";display:inline-block;color:var(--c-muted);font-size:11px;transition:transform .15s ease;flex:0 0 auto}',
    'details[open]>summary::before{transform:rotate(90deg)}',
    '.awx-panel table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12.5px}',
    '.awx-panel th,.awx-panel td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--c-border);vertical-align:top}',
    '.awx-panel th{color:var(--c-muted);font-weight:700;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em}',
    '.awx-panel .wrapn{min-width:140px}',
    '.tag{display:inline-block;border:1px solid var(--c-border);border-radius:6px;padding:0 6px;font-size:10.5px;line-height:1.7;white-space:nowrap}',
    '.tag.draft{border-color:var(--c-amber)}.tag.em{border-color:var(--c-red)}.tag.ok{border-color:var(--c-green)}',
    '.awx-gap{border:1px solid var(--c-amber);border-radius:10px;padding:9px 11px;margin:8px 0 0;font-size:13px;line-height:1.5}',
    '.awx-gap .meta{color:var(--c-muted);font-size:11.5px;margin-bottom:3px}',
    '.awx-gap .acts{margin-top:6px}',
    // the source dialog
    '.awx-dlg{max-width:min(760px,94vw);width:100%;border:1px solid var(--c-border);border-radius:14px;background:var(--c-surface);color:var(--c-text);padding:0}',
    '.awx-dlg::backdrop{background:rgba(0,0,0,.5)}',
    '.awx-dh{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;padding:13px 16px;border-bottom:1px solid var(--c-border)}',
    '.awx-dh h3{margin:0;font-size:15px;line-height:1.35}',
    '.awx-dh .where{color:var(--c-muted);font-size:12px;margin-top:3px}',
    '.awx-db{padding:14px 16px;max-height:60vh;overflow:auto;font-size:13.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word}',
    '.awx-df{padding:11px 16px;border-top:1px solid var(--c-border);display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}',
    '.awx-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
    '@media (max-width:520px){',
    '  .awx-modes{grid-template-columns:1fr 1fr}.awx-mode{min-height:70px}.awx-msg{max-width:100%}',
    // The composer becomes two rows: the textarea full width, the buttons under it.
    // On HR the app shell injects its own dictation button into this row, so three
    // controls plus a textarea do not fit in 390px and "Clear" was clipped off the
    // right edge. Wrapping is better than shrinking the tap targets.
    '  .awx-composer{flex-wrap:wrap}',
    // .awx-fullrow is set in JS on whichever DIRECT CHILD holds the textarea — on
    // HR the app shell wraps the textarea in its own div and injects a mic button
    // beside it, so a rule written against `textarea` stops matching a flex child
    // and the row overflows. See layoutComposer().
    '  .awx-composer>.awx-fullrow{flex:1 0 100%;order:-1}',
    '  .awx-composer>*:not(.awx-fullrow){flex:1 1 auto;min-width:0}',
    '}',
  ].join('\n');

  function injectCss() {
    if (document.getElementById('awx-css')) return;
    var st = document.createElement('style');
    st.id = 'awx-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // ── small helpers ───────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function token() { return (window.Wren && window.Wren.getToken && window.Wren.getToken()) || sessionStorage.getItem('wrenToken') || ''; }
  function headers(extra) {
    var h = extra || {};
    var t = token();
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }
  function toast(msg, kind) {
    if (window.Wren && window.Wren.toast) window.Wren.toast(msg, kind || 'info');
  }

  /** The minimum markdown the model actually produces: **bold**, `code`, lists, paragraphs.
   *  Everything is escaped FIRST, so no model output can introduce markup. */
  function md(src) {
    var text = esc(src).replace(/\r/g, '');
    var blocks = text.split(/\n{2,}/);
    var out = [];
    blocks.forEach(function (b) {
      var lines = b.split('\n');
      var isUl = lines.every(function (l) { return !l.trim() || /^\s*[-*•]\s+/.test(l); });
      var isOl = lines.every(function (l) { return !l.trim() || /^\s*\d+[.)]\s+/.test(l); });
      function inline(s) {
        // [text](/path) or [text](https://…) only — the text is already escaped, and any
        // other scheme stays as plain text. Pages in another app open in a new tab, so
        // the answer stays on screen.
        s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, label, href) {
          if (/^\/(?!\/)/.test(href)) return '<a href="' + href + '" target="_blank" rel="noopener">' + label + '</a>';
          if (/^https:\/\//i.test(href)) return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
          return label;
        });
        return s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
                .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
                .replace(/`([^`]+)`/g, '<code>$1</code>');
      }
      if (isUl && /[-*•]/.test(b)) {
        out.push('<ul>' + lines.filter(function (l) { return l.trim(); })
          .map(function (l) { return '<li>' + inline(l.replace(/^\s*[-*•]\s+/, '')) + '</li>'; }).join('') + '</ul>');
      } else if (isOl && /\d/.test(b)) {
        out.push('<ol>' + lines.filter(function (l) { return l.trim(); })
          .map(function (l) { return '<li>' + inline(l.replace(/^\s*\d+[.)]\s+/, '')) + '</li>'; }).join('') + '</ol>');
      } else {
        out.push('<p>' + inline(lines.join('<br>')) + '</p>');
      }
    });
    return out.join('');
  }

  /** "Who decides: …" is pulled OUT of the body and shown as its own block. */
  function splitOwner(text) {
    var m = /\n*^who decides:\s*(.+)$/im.exec(text);
    if (!m) return { body: text, owner: null };
    return { body: text.slice(0, m.index).trim(), owner: m[1].trim() };
  }

  var KIND_WORD = {
    bible: 'Managers Bible', 'bible-answers': "Toby's answers", 'bus-manual': 'Business manual',
    policy: 'Policy', handbook: 'Handbook', cctv: 'CCTV pack', terms: 'T&Cs',
    runbook: 'Runbook', research: 'Research', decision: 'Decision', analysis: 'Analysis',
    'wren-page': 'Wren page', 'wren-guide': 'Wren guide',
  };

  // ── the component ───────────────────────────────────────────────────────────
  function mount(root, opts) {
    if (!root) return;
    opts = opts || {};
    injectCss();
    var portal = opts.portal === 'hr' ? 'hr' : 'roost';
    var S = { mode: 'away', modes: [], busy: false, status: null, lastAnswer: null, lastQ: null };

    root.innerHTML =
      '<div class="awx">'
      + '<div class="awx-head"><div>'
      +   '<h1>When Toby\'s away</h1>'
      +   '<p class="awx-sub">Ask it what to do. It answers from the Managers Bible, the business manual, the '
      +   'setting\'s own policies and the staff handbook — nothing else — cites what it used, and tells you '
      +   '<strong>who decides</strong>.</p>'
      + '</div><div class="awx-chips" id="awx-status" aria-live="polite"></div></div>'
      + '<div id="awx-banner"></div>'
      + '<h2 class="awx-sr">Choose a mode</h2>'
      + '<div class="awx-modes" id="awx-modes" role="group" aria-label="Which adviser"></div>'
      + '<details class="awx-bounds" id="awx-bounds"><summary>What this mode will and will not do</summary>'
      +   '<div id="awx-bounds-body"></div></details>'
      + '<div class="awx-thread" id="awx-thread" aria-live="polite"></div>'
      + '<form class="awx-composer" id="awx-form">'
      +   '<label class="awx-sr" for="awx-input">Your question</label>'
      +   '<textarea id="awx-input" rows="1" placeholder="What do I do about…"></textarea>'
      +   '<button class="awx-btn pri" type="submit" id="awx-send">Ask</button>'
      +   '<button class="awx-btn" type="button" id="awx-clear" title="Start again">Clear</button>'
      + '</form>'
      + '<details class="awx-panel" id="awx-rights"><summary>Who decides what — the decision-rights table</summary>'
      +   '<div id="awx-rights-body"><p class="awx-sub">Opening…</p></div></details>'
      + '<details class="awx-panel" id="awx-gaps"><summary>Questions nothing could answer <span id="awx-gapn" class="tag"></span></summary>'
      +   '<div id="awx-gaps-body"><p class="awx-sub">Opening…</p></div></details>'
      + '<dialog class="awx-dlg" id="awx-dlg" aria-labelledby="awx-dlg-title">'
      +   '<div class="awx-dh"><div><h3 id="awx-dlg-title">Source</h3><div class="where" id="awx-dlg-where"></div></div>'
      +     '<button class="awx-btn" type="button" id="awx-dlg-x" aria-label="Close">Close</button></div>'
      +   '<div class="awx-db" id="awx-dlg-body"></div>'
      +   '<div class="awx-df"><button class="awx-btn" type="button" id="awx-dlg-copy">Copy this passage</button>'
      +     '<a class="awx-btn" id="awx-dlg-open" href="#" style="text-decoration:none;display:inline-flex;align-items:center">Open the document</a></div>'
      + '</dialog>'
      + '</div>';

    var $ = function (id) { return root.querySelector('#' + id); };
    var thread = $('awx-thread'), input = $('awx-input'), sendBtn = $('awx-send');

    // ── status + banner ──────────────────────────────────────────────────────
    function renderStatus() {
      var s = S.status;
      var box = $('awx-status');
      if (!s) { box.innerHTML = '<span class="awx-chip">checking…</span>'; return; }
      var c = s.corpus || {};
      var bits = [];
      if (c.note) {
        bits.push('<span class="awx-chip bad">' + esc(c.note) + '</span>');
      } else {
        bits.push('<span class="awx-chip ok"><b>' + (c.chunks - (c.withheld || 0)) + '</b> passages from <b>'
          + (c.docs || 0) + '</b> documents</span>');
        if (c.withheld) bits.push('<span class="awx-chip warn"><b>' + c.withheld
          + '</b> withheld by the family-data guard</span>');
        bits.push('<span class="awx-chip ' + (s.qdrant ? 'ok' : 'warn') + '">'
          + (s.qdrant ? 'semantic search on' : 'keyword search only') + '</span>');
      }
      bits.push('<span class="awx-chip ' + (s.ollama ? 'ok' : 'bad') + '">'
        + (s.ollama ? esc(s.model || 'the nursery\'s model') : 'the model is unreachable') + '</span>');
      if (s.decision_rights && s.decision_rights.n) {
        var dr = s.decision_rights;
        bits.push('<span class="awx-chip ' + (dr.approved === dr.n ? 'ok' : 'warn') + '"><b>'
          + (dr.n - dr.approved) + '</b> of <b>' + dr.n + '</b> decision rules are drafts</span>');
      }
      box.innerHTML = bits.join('');
    }

    function renderBanner() {
      var s = S.status, box = $('awx-banner');
      if (!s) { box.innerHTML = ''; return; }
      if (s.enabled === false) {
        box.innerHTML = '<div class="awx-banner"><h2>This adviser is switched off</h2>'
          + '<p>Somebody has set <code>away_assistant_enabled</code> to false. Nothing will answer until it is '
          + 'set back.</p></div>';
        return;
      }
      var a = s.away || {};
      if (a.show) {
        var who = a.cover_name ? esc(a.cover_name) + (a.cover_role ? ', our ' + esc(a.cover_role) : '') : 'the deputy manager';
        box.innerHTML = '<div class="awx-banner"><h2>🕊️ Away Mode is on — The manager is away'
          + (a.return_date ? ', back on <strong>' + esc(a.return_date) + '</strong>' : '') + '</h2>'
          + '<p>Cover is <strong>' + who + '</strong>. This page is what it is for: ask it what to do, and it will '
          + 'tell you who decides.</p>'
          + '<p>Anything it cannot answer from a written document is logged, and Toby sees it on his board when '
          + 'he is back — so a question you had to guess at is not wasted.</p></div>';
      } else {
        box.innerHTML = '<div class="awx-banner off"><h2>Away Mode is off — Toby is here</h2>'
          + '<p>You can still use this: it is the fastest way to find what the Bible, the manual, the policies '
          + 'and the handbook actually say. Turn Away Mode on from Roost when he goes away, and the banner, the '
          + 'out-of-office and the cover person all follow.</p></div>';
      }
    }

    // ── mode picker ──────────────────────────────────────────────────────────
    function renderModes() {
      $('awx-modes').innerHTML = S.modes.map(function (m) {
        return '<button class="awx-mode" type="button" data-mode="' + esc(m.key) + '" aria-pressed="'
          + (m.key === S.mode ? 'true' : 'false') + '">'
          + '<span class="m-top"><span class="m-ico" aria-hidden="true">' + esc(m.icon) + '</span>'
          + esc(m.label) + '</span>'
          + '<span class="m-blurb">' + esc(m.blurb) + '</span></button>';
      }).join('');
      root.querySelectorAll('.awx-mode').forEach(function (b) {
        b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); });
      });
      renderBounds();
    }

    function renderBounds() {
      var m = S.modes.filter(function (x) { return x.key === S.mode; })[0];
      if (!m) { $('awx-bounds-body').innerHTML = ''; return; }
      $('awx-bounds-body').innerHTML =
        '<ul>' + m.boundaries.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul>'
        + (!m.order.length && m.sources_note
          ? '<div class="order"><strong>Where answers come from:</strong> ' + esc(m.sources_note) + '</div>'
          : '<div class="order"><strong>Order of authority in this mode:</strong> '
        + m.order.map(function (k) { return '<code>' + esc(KIND_WORD[k] || k) + '</code>'; }).join(' → ')
        + '. A passage from the first of those outranks one from the last even when it matches your words less '
        + 'closely — which is the point of having modes at all.</div>');
    }

    function setMode(key) {
      if (!key || key === S.mode) return;
      S.mode = key;
      root.querySelectorAll('.awx-mode').forEach(function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-mode') === key ? 'true' : 'false');
      });
      renderBounds();
      if (!thread.querySelector('.awx-msg')) renderEmpty();
      try { localStorage.setItem('awx.mode', key); } catch (e) {}
    }

    // ── the thread ───────────────────────────────────────────────────────────
    function renderEmpty() {
      var m = S.modes.filter(function (x) { return x.key === S.mode; })[0];
      var sug = (m && m.suggestions) || [];
      thread.innerHTML = '<div class="awx-empty"><p>Ask it anything you would otherwise ring Toby about.'
        + (sug.length ? ' For example:' : '') + '</p>'
        + '<div class="awx-sugg">' + sug.map(function (s) {
            return '<button type="button" data-q="' + esc(s) + '">' + esc(s) + '</button>'; }).join('')
        + '</div></div>';
      thread.querySelectorAll('.awx-sugg button').forEach(function (b) {
        b.addEventListener('click', function () { ask(b.getAttribute('data-q')); });
      });
    }

    function addUser(q) {
      if (thread.querySelector('.awx-empty')) thread.innerHTML = '';
      var n = el('div', 'awx-msg user', esc(q));
      thread.appendChild(n);
      n.scrollIntoView({ block: 'nearest' });
    }

    function addBot() {
      var n = el('div', 'awx-msg bot');
      n.innerHTML = '<span class="awx-think" aria-label="Thinking"><i></i><i></i><i></i></span>';
      thread.appendChild(n);
      n.scrollIntoView({ block: 'nearest' });
      return n;
    }

    function finishBot(node, text, meta, question) {
      var split = splitOwner(text);
      var html = md(split.body);
      if (meta && meta.emergency) node.classList.add('em');
      if (meta && meta.gap) node.classList.add('gap');

      // THE DRAFT FLAG COMES FROM THE META, not from the model's prose. The UI
      // check caught the model writing a good "Who decides:" line and silently
      // omitting that the rule behind it is unapproved, even though its prompt
      // asked for it. The route knows the answer and now says so, so the warning
      // no longer depends on a 27B remembering an instruction.
      var draft = !!(meta && meta.decision_is_draft);
      if (split.owner || draft) {
        html += '<div class="awx-owner' + (draft ? ' draft' : '') + '"><b>Who decides</b>'
          + esc(split.owner || 'nothing written down says — treat it as Toby\u2019s')
          + (draft ? '<span class="dflag">This is a <strong>draft</strong> rule'
                   + (meta.decision_topic ? ' (\u201c' + esc(meta.decision_topic) + '\u201d)' : '')
                   + '. Toby has not approved it yet \u2014 it is this build\u2019s best reading of the Bible '
                   + 'and the business manual, not his decision. Act on it if you must, and tell him.</span>' : '')
          + '</div>';
      }

      var cites = (meta && meta.citations) || [];
      if (cites.length) {
        html += '<div class="awx-srcs"><div class="lbl">Where this came from</div>'
          + cites.map(function (c, i) {
              return '<button class="awx-src" type="button" data-src="' + (c.id == null ? '' : c.id) + '" '
                + 'data-open="' + esc(c.open_url || '') + '">'
                + '<span class="k">' + esc(KIND_WORD[c.kind] || c.kind) + '</span>'
                + esc(c.section || c.label) + '</button>';
            }).join('')
          + '</div>';
      } else if (meta && !meta.emergency && !meta.gap) {
        html += '<div class="awx-srcs"><div class="lbl">Where this came from</div>'
          + '<span class="awx-sub">No source was cited, which should not happen — treat this answer with '
          + 'suspicion and tell Toby.</span></div>';
      }

      html += '<div class="awx-actions">'
        + '<button type="button" data-act="copy">Copy as message</button>'
        + (meta && meta.gap ? '' : '<button type="button" data-act="copyfull">Copy with sources</button>')
        + '</div>';

      node.innerHTML = html;

      node.querySelectorAll('.awx-src').forEach(function (b) {
        b.addEventListener('click', function () {
          // A Wren page or guide has no stored passage; the useful thing is the page itself.
          if (!b.getAttribute('data-src') && b.getAttribute('data-open')) {
            window.open(b.getAttribute('data-open'), '_blank', 'noopener');
            return;
          }
          openSource(b.getAttribute('data-src'), b.getAttribute('data-open'), b.textContent);
        });
      });
      node.querySelectorAll('[data-act]').forEach(function (b) {
        b.addEventListener('click', function () {
          var act = b.getAttribute('data-act');
          var out = text;
          if (act === 'copyfull' && cites.length) {
            out += '\n\nSources:\n' + cites.map(function (c) {
              return '- ' + (c.label || '') + (c.section ? ' — ' + c.section : ''); }).join('\n');
          }
          copy(out);
        });
      });
      node.scrollIntoView({ block: 'nearest' });
      S.lastAnswer = text; S.lastQ = question;
    }

    function copy(text) {
      // "Copy as message": the whole point is pasting it into a staff message or
      // a WhatsApp, so copy the PLAIN text, not the rendered HTML.
      function fallback() {
        var ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.left = '-9999px';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); toast('Copied', 'success'); }
        catch (e) { toast('Could not copy — select the text and copy it by hand', 'warning'); }
        ta.remove();
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast('Copied', 'success'); }, fallback);
      } else fallback();
    }

    // ── asking ───────────────────────────────────────────────────────────────
    function ask(q) {
      q = String(q || '').trim();
      if (!q || S.busy) return;
      S.busy = true; sendBtn.disabled = true; sendBtn.textContent = '…';
      addUser(q);
      var node = addBot();

      fetch('/api/away-assistant/ask', {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ question: q, mode: S.mode }),
      }).then(function (r) {
        if (r.status === 401) { if (window.Wren && window.Wren.logout) window.Wren.logout(); throw new Error('unauthorised'); }
        var meta = {};
        var b64 = r.headers.get('X-Away-Meta-B64');
        if (b64) { try { meta = JSON.parse(decodeURIComponent(escape(atob(b64)))); } catch (e) { try { meta = JSON.parse(atob(b64)); } catch (e2) {} } }
        if (!r.ok && !b64) {
          return r.json().catch(function () { return {}; }).then(function (d) {
            throw new Error((d && (d.error || d.message)) || ('HTTP ' + r.status));
          });
        }
        if (!r.body || !r.body.getReader) {
          return r.text().then(function (t) { finishBot(node, t, meta, q); });
        }
        var reader = r.body.getReader(), dec = new TextDecoder(), text = '';
        var first = true;
        return (function pump() {
          return reader.read().then(function (res) {
            if (res.done) { finishBot(node, text, meta, q); return; }
            text += dec.decode(res.value, { stream: true });
            if (first) { node.innerHTML = ''; first = false; }
            // While streaming, show escaped plain text; the markdown pass runs once at the end,
            // so a half-written **bold** never renders as stray asterisks-then-markup.
            node.textContent = text;
            node.scrollIntoView({ block: 'nearest' });
            return pump();
          });
        })();
      }).catch(function (e) {
        node.classList.add('em');
        node.innerHTML = md('**That did not work.** ' + esc(e && e.message ? e.message : 'Unknown error')
          + '\n\nNothing has been answered, so do not treat this as "there is no policy". '
          + 'If it is urgent, ring Toby.');
      }).then(function () {
        S.busy = false; sendBtn.disabled = false; sendBtn.textContent = 'Ask';
        input.focus();
        loadGapCount();
      });
    }

    // ── the source dialog ────────────────────────────────────────────────────
    var dlg = $('awx-dlg');
    function openSource(id, openUrl, label) {
      var title = $('awx-dlg-title'), where = $('awx-dlg-where'), body = $('awx-dlg-body'), open = $('awx-dlg-open');
      title.textContent = label || 'Source';
      where.textContent = '';
      body.textContent = 'Loading…';
      open.style.display = openUrl ? '' : 'none';
      if (openUrl) open.setAttribute('href', openUrl);
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
      if (!id) { body.textContent = 'This citation has no stored passage — open the document instead.'; return; }
      fetch('/api/away-assistant/source/' + encodeURIComponent(id), { headers: headers() })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) {
          title.textContent = d.title || label || 'Source';
          where.textContent = [KIND_WORD[d.source_kind] || d.source_kind, d.section_path].filter(Boolean).join(' · ');
          body.textContent = d.content || '(no text stored)';
          if (d.open_url) { open.style.display = ''; open.setAttribute('href', d.open_url); }
        })
        .catch(function () { body.textContent = 'That passage could not be loaded. It may have been withdrawn by the family-data guard since the answer was given.'; });
    }
    $('awx-dlg-x').addEventListener('click', function () { dlg.close ? dlg.close() : dlg.removeAttribute('open'); });
    $('awx-dlg-copy').addEventListener('click', function () { copy($('awx-dlg-body').textContent || ''); });

    // ── the decision-rights panel ────────────────────────────────────────────
    var rightsLoaded = false;
    $('awx-rights').addEventListener('toggle', function () {
      if (!$('awx-rights').open || rightsLoaded) return;
      rightsLoaded = true;
      fetch('/api/away-assistant/rights?mode=' + encodeURIComponent(S.mode), { headers: headers() })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var rows = d.rights || [];
          if (!rows.length) {
            $('awx-rights-body').innerHTML = '<p class="awx-sub">'
              + esc(d.note || 'Nothing is recorded for this mode yet.') + '</p>';
            return;
          }
          $('awx-rights-body').innerHTML =
            '<p class="awx-sub">The Managers Bible has <strong>no decision-rights table</strong> — §12 lists who to '
            + '<em>call</em>, which is contacts, not authority, and improvement 12.4 asks for exactly this. So these '
            + 'rows were drafted from what the Bible and the business manual do say, and <strong>every one marked '
            + 'DRAFT is waiting for Toby</strong>. They are still used in answers, because a stand-in needs an answer '
            + 'at 6:15pm — but an answer always says when it is leaning on a draft.</p>'
            + '<table><thead><tr><th>Situation</th><th class="wrapn">Who decides</th><th>Then</th><th>When</th><th></th></tr></thead><tbody>'
            + rows.map(function (r) {
                return '<tr><td><strong>' + esc(r.topic) + '</strong>'
                  + (r.notes ? '<br><span class="awx-sub">' + esc(r.notes) + '</span>' : '')
                  + (r.basis ? '<br><span class="awx-sub">Basis: ' + esc(r.basis) + '</span>' : '')
                  + '</td>'
                  + '<td class="wrapn">' + esc(r.decided_by) + (r.wait_for_toby ? '<br><span class="tag">waits for Toby</span>' : '') + '</td>'
                  + '<td>' + esc(r.escalate_to || '—') + '</td>'
                  + '<td><span class="tag' + (r.urgency === 'emergency' ? ' em' : '') + '">' + esc(r.urgency.replace('_', ' ')) + '</span></td>'
                  + '<td><span class="tag ' + (r.approved ? 'ok' : 'draft') + '">' + (r.approved ? 'approved' : 'DRAFT') + '</span></td></tr>';
              }).join('')
            + '</tbody></table>';
        })
        .catch(function () { $('awx-rights-body').innerHTML = '<p class="awx-sub">Could not load the table.</p>'; });
    });

    // ── the gaps panel ───────────────────────────────────────────────────────
    function loadGapCount() {
      fetch('/api/away-assistant/log?gaps=1&limit=1', { headers: headers() })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var n = d.open_gaps || 0;
          var tag = $('awx-gapn');
          tag.textContent = n ? String(n) : '';
          tag.className = 'tag' + (n ? ' draft' : '');
        }).catch(function () {});
    }

    function loadGaps() {
      fetch('/api/away-assistant/log?gaps=1&limit=50', { headers: headers() })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var rows = d.entries || [];
          if (!rows.length) {
            $('awx-gaps-body').innerHTML = '<p class="awx-sub">'
              + esc(d.note || 'Nothing has been asked that no document could answer. That is the good outcome.')
              + '</p>';
            return;
          }
          $('awx-gaps-body').innerHTML =
            '<p class="awx-sub">Each of these is a section the Bible is missing, written by the person who needed '
            + 'it at the moment they needed it. They also appear as one card on the Cockpit board.</p>'
            + rows.map(function (r) {
                return '<div class="awx-gap"><div class="meta">'
                  + esc(new Date(r.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))
                  + ' · ' + esc(r.mode) + ' · ' + esc(r.asked_by || 'someone') + ' on ' + esc(r.portal || '?')
                  + '</div>'
                  + (r.question_withheld
                      ? '<em>The question is not stored: the family-data guard matched a name in it.</em>'
                      : esc(r.question))
                  + '<div class="acts"><button class="awx-btn" type="button" data-clear="' + r.id + '" '
                  + 'style="min-height:34px;font-size:12px;padding:0 10px">Dealt with</button></div></div>';
              }).join('');
          $('awx-gaps-body').querySelectorAll('[data-clear]').forEach(function (b) {
            b.addEventListener('click', function () {
              fetch('/api/away-assistant/log/' + b.getAttribute('data-clear') + '/clear',
                { method: 'POST', headers: headers() })
                .then(function (r) { if (!r.ok) throw new Error(); toast('Marked as dealt with', 'success'); loadGaps(); loadGapCount(); })
                .catch(function () { toast('Only a manager can clear a gap', 'warning'); });
            });
          });
        })
        .catch(function () { $('awx-gaps-body').innerHTML = '<p class="awx-sub">Could not load the list.</p>'; });
    }
    $('awx-gaps').addEventListener('toggle', function () { if ($('awx-gaps').open) loadGaps(); });

    // ── wiring ───────────────────────────────────────────────────────────────
    function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 150) + 'px'; }

    /**
     * Mark whichever DIRECT child of the composer contains the textarea, so the
     * narrow-width rule can give it the whole first row.
     *
     * On Roost that child IS the textarea. On HR it is not: wren-app-shell's
     * dictation widget wraps the textarea in a div of its own and inserts a
     * .wren-mic-btn as a sibling, which took the child count from 3 to 4 and
     * pushed "Ask" into an overlap with the mic at 390px. Walking up from the
     * textarea works whatever the shell decides to wrap it in, which a CSS
     * selector written against a fixed shape does not.
     */
    function layoutComposer() {
      var form = $('awx-form');
      if (!form || !input) return;
      Array.prototype.forEach.call(form.children, function (c) { c.classList.remove('awx-fullrow'); });
      var n = input;
      while (n && n.parentNode !== form) n = n.parentNode;
      if (n && n.classList) n.classList.add('awx-fullrow');
    }
    $('awx-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var v = input.value; input.value = ''; autosize(); ask(v);
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); $('awx-form').requestSubmit
        ? $('awx-form').requestSubmit() : ask(input.value); }
    });
    input.addEventListener('input', autosize);
    layoutComposer();
    // The shell injects its mic asynchronously, so re-mark once it has landed and
    // again on resize.
    setTimeout(layoutComposer, 400);
    setTimeout(layoutComposer, 1500);
    window.addEventListener('resize', layoutComposer);
    $('awx-clear').addEventListener('click', function () { renderEmpty(); input.value = ''; autosize(); input.focus(); });

    // Deep links: ?mode=finance opens that mode, ?gaps=1 opens the gap list
    // (the Cockpit card's action_url).
    var qs = new URLSearchParams(location.search);
    try { var saved = localStorage.getItem('awx.mode'); if (saved) S.mode = saved; } catch (e) {}
    if (qs.get('mode')) S.mode = qs.get('mode');

    fetch('/api/away-assistant/modes', { headers: headers() })
      .then(function (r) {
        if (r.status === 403) throw new Error('This is for managers, the deputy and the office managers.');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        S.modes = d.modes || [];
        if (!S.modes.some(function (m) { return m.key === S.mode; })) S.mode = d.default || 'away';
        renderModes();
        renderEmpty();
        if (qs.get('gaps')) { $('awx-gaps').open = true; }
        if (qs.get('q')) ask(qs.get('q'));
      })
      .catch(function (e) {
        root.querySelector('.awx').innerHTML = '<div class="awx-banner"><h2>Not available</h2><p>'
          + esc(e && e.message ? e.message : 'Could not load.') + '</p></div>';
      });

    fetch('/api/away-assistant/status', { headers: headers() })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { S.status = d; renderStatus(); renderBanner(); })
      .catch(function () { S.status = null; });

    loadGapCount();
  }

  window.WrenAwayAssistant = { mount: mount, __md: md, __splitOwner: splitOwner };
})();
