/* Wren — Fledge Profile icon lookup (b278, 2026-09-04)
 * ────────────────────────────────────────────────────────────────────────────
 * THE single source of truth for how a Fledge Profile statement is identified
 * in the UI. Toby, 2026-09-04:
 *
 *   "With fledge, where it links to the profile statement — use icons/emojis
 *    rather than letters, so book and note for 'rich bank of stories and songs'."
 *
 * So P-02 renders as 📖 + 🎵, never as the bare string "P-02" or "2".
 *
 * Rules this module exists to keep in ONE place:
 *   • Every one of the 19 profile statements has EXACTLY ONE icon set.
 *   • The letter code (P-02) survives as title/aria-label — inspectors and
 *     reports still need it, and a screen reader must never read out
 *     "book note". It is never the only visible identifier, and it is never
 *     the only accessible one either.
 *   • A real Mulberry symbol (public/symbols/mulberry/) is preferred; the emoji
 *     is the fallback for browsers/contexts that cannot load the SVG, and the
 *     alt text is always a WORD, never the glyph.
 *
 * Usage (browser):   FledgeProfile.html(2)          -> icon markup for P-02
 *                    FledgeProfile.refsHtml('→ 1, 2, 14')
 * Usage (node):      require('.../public/js/fledge-profile-icons.js')
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FledgeProfile = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var SYMBOL_BASE = '/symbols/mulberry/';

  /* Each icon: sym = Mulberry filename (no .svg) or null; emoji = fallback
   * glyph; label = the WORD a screen reader / tooltip gets for this icon. */
  function I(sym, emoji, label) { return { sym: sym, emoji: emoji, label: label }; }

  /* The 19 Fledge Profile statements. `code` matches
   * ladn.framework_statements.statement_code WHERE framework='fledge'
   * AND area='Fledge Profile'. `num` matches the "→ 1, 2, 14" profile_refs
   * notation used by the progression rows and the framework document. */
  var STATEMENTS = [
    { num: 1,  code: 'P-01', aspect: 'Communication & connection',
      short: 'Speaks up and is understood',
      icons: [ I('talk_1_,_to', '💬', 'talking'), I('ear', '👂', 'listening') ] },
    { num: 2,  code: 'P-02', aspect: 'Communication & connection',
      short: 'A rich bank of stories and songs',
      /* Toby's own example: "book and note for 'rich bank of stories and songs'".
       * The book is a real Mulberry symbol. There is no music-note symbol in the
       * set (sing_,_to is a singing PERSON, not a note), so the note is the
       * emoji — which is exactly what he asked for. */
      icons: [ I('read_book_,_to', '📖', 'book'), I(null, '🎵', 'note') ] },
    { num: 3,  code: 'P-03', aspect: 'Communication & connection',
      short: 'Resolves a squabble with words first',
      icons: [ I('talk_2_,_to', '🗣️', 'words'), I('share_,_to', '🤝', 'sharing') ] },
    { num: 4,  code: 'P-04', aspect: 'Independence & self',
      short: 'Manages their own body and belongings',
      icons: [ I('coat', '🧥', 'coat'), I('toilet_,_go_to_the', '🚽', 'toilet') ] },
    { num: 5,  code: 'P-05', aspect: 'Independence & self',
      short: "Keeps trying when it's hard",
      icons: [ I('jigsaw_puzzle', '🧩', 'puzzle'), I('star', '⭐', 'sticking at it') ] },
    { num: 6,  code: 'P-06', aspect: 'Independence & self',
      short: 'Makes real choices and owns them',
      icons: [ I('point_,_to', '👉', 'choosing'), I('think_,_to', '💡', 'own idea') ] },
    { num: 7,  code: 'P-07', aspect: 'Independence & self',
      short: 'Knows their own feelings have names',
      icons: [ I('sad_man', '😢', 'feelings'), I('happy_man', '😊', 'calm again') ] },
    { num: 8,  code: 'P-08', aspect: 'Kindness & community',
      short: 'Notices how others feel — and acts on it',
      icons: [ I('hug_,_to', '🤗', 'comfort'), I('tissues', '🤧', 'helping') ] },
    { num: 9,  code: 'P-09', aspect: 'Kindness & community',
      short: 'Treats living things gently',
      icons: [ I('snail', '🐌', 'minibeasts'), I('water_plants_,_to', '🪴', 'watering') ] },
    { num: 10, code: 'P-10', aspect: 'Kindness & community',
      short: 'Understands fairness and has a voice',
      icons: [ I('vote_,_to', '🗳️', 'having a say'), I('share_,_to', '🤝', 'taking turns') ] },
    { num: 11, code: 'P-11', aspect: 'Kindness & community',
      short: 'Respects people who are different from them',
      icons: [ I('family_2', '👪', 'families'), I('world', '🌍', 'many cultures') ] },
    { num: 12, code: 'P-12', aspect: 'Curiosity & the world',
      short: 'Has grown, cooked and cared for something living',
      icons: [ I('grow_,_to', '🌱', 'growing'), I('cook_,_to', '🍳', 'cooking') ] },
    { num: 13, code: 'P-13', aspect: 'Curiosity & the world',
      short: 'Knows their local patch',
      icons: [ I('park_,_to', '🏞️', 'the park'), I('shop', '🏪', 'the shops') ] },
    { num: 14, code: 'P-14', aspect: 'Curiosity & the world',
      short: 'Asks real questions and expects real answers',
      icons: [ I('why', '❓', 'why?'), I('think_,_to', '🤔', 'thinking') ] },
    { num: 15, code: 'P-15', aspect: 'Early literacy & maths',
      short: 'Loves books enough to choose them',
      icons: [ I('book_shelf', '📚', 'books'), I('read_book_,_to', '📖', 'reading') ] },
    { num: 16, code: 'P-16', aspect: 'Early literacy & maths',
      short: 'Makes marks with meaning',
      icons: [ I('write_,_to', '✏️', 'mark making'), I('paint_,_to', '🎨', 'painting') ] },
    { num: 17, code: 'P-17', aspect: 'Early literacy & maths',
      short: 'Plays with number naturally',
      icons: [ I('count_2_,_to', '🔢', 'counting'), I('maths', '➕', 'maths') ] },
    { num: 18, code: 'P-18', aspect: 'Body & wellbeing',
      short: 'Moves with confidence',
      icons: [ I('run_,_to', '🏃', 'running'), I('climb_up_,_to', '🧗', 'climbing') ] },
    { num: 19, code: 'P-19', aspect: 'Body & wellbeing',
      short: 'Knows what their body needs',
      icons: [ I('hungry', '🍽️', 'hungry'), I('thirsty', '💧', 'thirsty') ] }
  ];

  var _byNum = {}, _byCode = {};
  STATEMENTS.forEach(function (s) { _byNum[s.num] = s; _byCode[s.code] = s; });

  function _e(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* Accepts 2, '2', 'P-02', 'P-2'. Returns the statement record or null. */
  function get(ref) {
    if (ref == null) return null;
    if (typeof ref === 'object') return ref.code ? (_byCode[ref.code] || null) : null;
    var s = String(ref).trim();
    if (_byCode[s]) return _byCode[s];
    var m = s.match(/^P-?0*(\d{1,2})$/i) || s.match(/^0*(\d{1,2})$/);
    return m ? (_byNum[parseInt(m[1], 10)] || null) : null;
  }

  function iconsFor(ref) { var s = get(ref); return s ? s.icons : []; }

  /* "→ 1, 2, 14" / "1,2,14" / "Profile 1, 2" → [1, 2, 14] (valid nums only). */
  function parseRefs(str) {
    if (Array.isArray(str)) str = str.join(',');
    var out = [], seen = {};
    String(str == null ? '' : str).replace(/\d{1,2}/g, function (d) {
      var n = parseInt(d, 10);
      if (_byNum[n] && !seen[n]) { seen[n] = 1; out.push(n); }
      return d;
    });
    return out;
  }

  /* Markup for ONE profile statement.
   * opts.size  — px for the symbol (default 18)
   * opts.text  — 'sr' (visually-hidden, default) | 'inline' (visible words) | 'none'
   * opts.href  — wrap in a link
   * The group is role="img" with the full aria-label ("Fledge Profile P-02 —
   * A rich bank of stories and songs"), so the code is never lost and the
   * reader never hears "book note". */
  function html(ref, opts) {
    var s = get(ref);
    if (!s) return '';
    opts = opts || {};
    var size = opts.size || 18;
    var mode = opts.text || 'sr';
    var label = 'Fledge Profile ' + s.code + ' — ' + s.short;
    var words = s.icons.map(function (i) { return i.label; }).join(' + ');

    /* Inline px, not the class's em: the stylesheet rule would otherwise win and
     * `size` would silently do nothing. */
    var dim = 'width:' + size + 'px;height:' + size + 'px';
    var glyphs = s.icons.map(function (i) {
      if (!i.sym) {
        return '<span class="fp-ic fp-ic-emoji" aria-hidden="true" style="font-size:' +
               size + 'px;line-height:1">' + i.emoji + '</span>';
      }
      /* A missing symbol must still show something meaningful, so the img
       * falls back to its emoji. alt is empty: the group carries the name. */
      return '<img class="fp-ic" src="' + SYMBOL_BASE + encodeURIComponent(i.sym) + '.svg"' +
             ' width="' + size + '" height="' + size + '" style="' + dim + '"' +
             ' alt="" aria-hidden="true" loading="lazy"' +
             ' data-fp-emoji="' + _e(i.emoji) + '" onerror="FledgeProfile._fallback(this)">';
    }).join('');

    var textBit =
      mode === 'none'   ? '' :
      mode === 'inline' ? '<span class="fp-words">' + _e(words) + '</span>'
                        : '<span class="fp-sr">' + _e(label) + ' (' + _e(words) + ')</span>';

    var inner =
      '<span class="fledge-profile-icon" role="img" data-profile-code="' + _e(s.code) + '"' +
      ' data-profile-num="' + s.num + '" aria-label="' + _e(label) + '" title="' + _e(label) + '">' +
      glyphs + textBit + '</span>';

    return opts.href
      ? '<a class="fp-link" href="' + _e(opts.href) + '">' + inner + '</a>'
      : inner;
  }

  /* Markup for a whole "→ 1, 2, 14" reference string. */
  function refsHtml(str, opts) {
    var nums = parseRefs(str);
    if (!nums.length) return '';
    opts = opts || {};
    return '<span class="fledge-profile-refs" data-profile-refs="' + _e(nums.join(',')) + '">' +
      (opts.arrow === false ? '' : '<span class="fp-arrow" aria-hidden="true">→</span>') +
      nums.map(function (n) { return html(n, opts); }).join('') +
      '</span>';
  }

  /* Swap every [data-fledge-profile="<ref>"] element for its icons. Idempotent. */
  function hydrate(root, opts) {
    var scope = root || document;
    var els = scope.querySelectorAll('[data-fledge-profile]:not([data-fp-done])');
    Array.prototype.forEach.call(els, function (el) {
      var m = html(el.getAttribute('data-fledge-profile'), opts);
      if (m) { el.innerHTML = m; el.setAttribute('data-fp-done', '1'); }
    });
    var rs = scope.querySelectorAll('[data-fledge-profile-refs]:not([data-fp-done])');
    Array.prototype.forEach.call(rs, function (el) {
      var m = refsHtml(el.getAttribute('data-fledge-profile-refs'), opts);
      if (m) { el.innerHTML = m; el.setAttribute('data-fp-done', '1'); }
    });
    return els.length + rs.length;
  }

  /* ── Styles ──────────────────────────────────────────────────────────────
   * Injected from here so the icons are styled wherever the module is loaded —
   * one place for the data AND its presentation. Tokens only, so the chip
   * inverts correctly on a light card and a dark one. The symbols are colour
   * line-art on transparent, so on a dark surface they get a light plate
   * behind them; on a light surface the plate is a hairline tint. */
  var CSS = [
    '.fledge-profile-icon{display:inline-flex;align-items:center;gap:2px;vertical-align:-.22em;',
    '  padding:2px 4px;border-radius:7px;background:var(--fp-plate,rgba(255,255,255,.86));',
    '  border:1px solid var(--c-border);line-height:1;white-space:nowrap}',
    '.fledge-profile-icon+.fledge-profile-icon{margin-left:4px}',
    '.fledge-profile-icon .fp-ic{display:block;width:1.15em;height:1.15em;flex:0 0 auto}',
    /* An inline width/height from opts.size overrides the em default above. */
    '.fledge-profile-icon{gap:3px}',
    '.fledge-profile-icon .fp-ic-emoji{font-size:1em;line-height:1;font-style:normal}',
    '.fledge-profile-icon .fp-words{margin-left:4px;font-size:.72rem;color:var(--c-muted);font-weight:600}',
    '.fledge-profile-refs{display:inline-flex;align-items:center;gap:3px;flex-wrap:wrap;vertical-align:-.22em}',
    '.fledge-profile-refs .fp-arrow{color:var(--c-muted);font-size:.85em;margin-right:1px}',
    '.fp-link{text-decoration:none}',
    '.fp-link:hover .fledge-profile-icon{border-color:var(--c-blue)}',
    /* The accessible name lives here. Never display:none — that removes it
     * from the accessibility tree along with everything else. */
    '.fp-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;',
    '  clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}',
    /* Light surfaces: the plate becomes a hairline tint rather than a white
     * card, so the chip does not glow against the page. */
    '@media (prefers-color-scheme: light){.fledge-profile-icon{--fp-plate:rgba(15,26,52,.04)}}',
    '[data-theme="light"] .fledge-profile-icon,.theme-light .fledge-profile-icon,',
    '.wren-light .fledge-profile-icon{--fp-plate:rgba(15,26,52,.04)}',
    '@media print{.fledge-profile-icon{background:#fff;border-color:#ccc}}'
  ].join('');

  function injectStyles() {
    if (typeof document === 'undefined') return false;
    if (document.getElementById('fledge-profile-icon-css')) return false;
    var st = document.createElement('style');
    st.id = 'fledge-profile-icon-css';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
    return true;
  }
  injectStyles();

  /* img onerror hook — swap a missing Mulberry symbol for its emoji. */
  function _fallback(img) {
    if (!img || !img.parentNode) return;
    var span = document.createElement('span');
    span.className = 'fp-ic fp-ic-emoji';
    span.setAttribute('aria-hidden', 'true');
    // Inherit the size of the symbol it is standing in for.
    var w = img.getAttribute('width');
    if (w) span.style.cssText = 'font-size:' + w + 'px;line-height:1';
    span.textContent = img.getAttribute('data-fp-emoji') || '';
    img.parentNode.replaceChild(span, img);
  }

  return {
    VERSION: 'b278',
    _fallback: _fallback,
    CSS: CSS,
    injectStyles: injectStyles,
    SYMBOL_BASE: SYMBOL_BASE,
    STATEMENTS: STATEMENTS,
    get: get,
    byNum: function (n) { return _byNum[n] || null; },
    byCode: function (c) { return _byCode[c] || null; },
    iconsFor: iconsFor,
    parseRefs: parseRefs,
    html: html,
    refsHtml: refsHtml,
    hydrate: hydrate
  };
});
