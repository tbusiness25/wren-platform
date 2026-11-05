/* b159 — Resource Curriculum Cards shared renderer (v2, 2026-07-28: hero pictures,
 * per-category colour theming, light + dark screen themes).
 * Usage:
 *   WrenResourceCards.renderCard(card)                          -> DOM element, screen theme
 *       (theme = opts.theme || localStorage['wrenRcTheme'] || 'dark')
 *   WrenResourceCards.renderCard(card, { theme:'light' })       -> light screen variant
 *   WrenResourceCards.renderCard(card, { print:true })          -> light print variant (A4)
 *   WrenResourceCards.injectPrintStyles() / printCards(cards) / printCSS  -> as v1
 * Pictures: each card gets a hero illustration from the Mulberry symbol set
 * (/symbols/mulberry/<name>.svg, licence in public/symbols/MULBERRY-LICENCE.txt),
 * mapped per-slug below; cards without a mapping fall back to the category icon
 * from the WrenIcons registry. All optional — missing assets degrade silently.
 */
(function () {
  'use strict';

  // Per-category accent colour (the commercial-card look: each area a colour family).
  var CATEGORY_META = {
    small_world:         { label: 'Small World',             icon: 'globe',      acc: '#3aa76d' },
    role_play:           { label: 'Role Play',               icon: 'family',     acc: '#e0559a' },
    malleable_sensory:   { label: 'Malleable & Sensory',     icon: 'flask',      acc: '#8b5cf6' },
    construction:        { label: 'Construction',            icon: 'toolbox',    acc: '#d97706' },
    creative:            { label: 'Creative',                icon: 'palette',    acc: '#ef5844' },
    literacy_maths:      { label: 'Literacy & Maths',        icon: 'book',       acc: '#4a9abf' },
    understanding_world: { label: 'Understanding the World', icon: 'binoculars', acc: '#14b8a6' },
    physical_outdoor:    { label: 'Physical & Outdoor',      icon: 'tree',       acc: '#65a30d' },
    baby_room:           { label: 'Baby Room',               icon: 'child',      acc: '#eab308' },
    // b380 (2026-10-02): the other 17 categories in the library. Before this, 168 of
    // 327 cards showed their raw slug ("transport_journeys"), no icon and default blue.
    literacy:               { label: 'Literacy',                icon: 'book',       acc: '#2563eb' },
    literacy_markmaking:    { label: 'Literacy & Mark-Making',  icon: 'pencil',     acc: '#0284c7' },
    maths_provocations:     { label: 'Maths Provocations',      icon: 'puzzle',     acc: '#6366f1' },
    festivals_celebrations: { label: 'Festivals & Celebrations',icon: 'confetti',   acc: '#db2777' },
    community_people:       { label: 'Community & People',      icon: 'users',      acc: '#0e7490' },
    transport_journeys:     { label: 'Transport & Journeys',    icon: 'map',        acc: '#c2410c' },
    food_cooking:           { label: 'Food & Cooking',          icon: 'kitchen',    acc: '#ea580c' },
    science_exploration:    { label: 'Science & Exploration',   icon: 'search',     acc: '#0d9488' },
    outdoor_forest_school:  { label: 'Outdoor & Forest School', icon: 'leaf',       acc: '#15803d' },
    nature_seasons:         { label: 'Nature & Seasons',        icon: 'sprout',     acc: '#16a34a' },
    music_sound:            { label: 'Music & Sound',           icon: 'bell',       acc: '#9333ea' },
    inclusive_send:         { label: 'Inclusive / SEND',        icon: 'handshake',  acc: '#be123c' },
    wellbeing_regulation:   { label: 'Wellbeing & Regulation',  icon: 'heart',      acc: '#e11d48' },
    loose_parts:            { label: 'Loose Parts',             icon: 'box',        acc: '#a16207' },
    schemas:                { label: 'Schemas',                 icon: 'repeat',     acc: '#7c3aed' },
    self_care:              { label: 'Self-Care',               icon: 'mirror',     acc: '#c026d3' },
    toddler_play:           { label: 'Toddler Play',            icon: 'sparkles',   acc: '#d97706' }
  };

  // slug -> Mulberry symbol file (no .svg). Verified against the library 2026-07-28.
  var HERO = {
    'airport-and-planes':'aeroplane', 'arctic-and-polar':'penguin', 'baby-dolls':'doll',
    'bikes-and-trikes':'bicycle', 'book-corner':'carry_books_,_to', 'builders-site':'hammer',
    'cafe':'cafe', 'castles-and-knights':'castle', 'celebrations-party':'birthday_cake',
    'clay':'clay', 'climbing-and-balancing':'slide', 'collage-and-craft':'glue',
    'cooking-and-baking':'cake', 'den-building':'blanket', 'dinosaurs':'dinosaur',
    'doctors':'doctor_1a', 'dolls-house':'doll', 'farm':'tractor',
    'fine-motor-and-threading':'beads', 'forest-school':'tree', 'garden-centre':'watering_can',
    'gardening-and-growing':'watering_can', 'gloop-and-messy':'bubble_mixture', 'hairdressers':'hairbrush',
    'herbs-and-smell-garden':'plant', 'heuristic-play':'saucepan', 'home-corner':'house',
    'ice-and-frozen':'snow', 'ice-cream-parlour':'ice_cream', 'ict-and-beebots':'laptop',
    'investigation-station':'magnet', 'jungle-animals':'lion', 'junk-modelling':'glue',
    'large-construction':'crane', 'light-and-shadow':'torch', 'loose-parts':'shells',
    'maps-and-journeys':'globe', 'marble-runs-and-ramps':'marbles', 'mark-making':'pencil',
    'maths-area':'maths', 'minibeasts':'butterfly', 'mud-kitchen':'saucepan',
    'music-and-sound':'musical_instruments', 'natural-materials':'acorn', 'number-hunt-outdoors':'maths_class',
    'painting':'paint', 'parachute-and-ball-games':'parachute', 'pirates':'boat',
    'pizza-kitchen':'pizza', 'playdough':'playdough', 'post-office':'post_van',
    'printing-and-stamping':'print', 'puppets-and-storytelling':'puppet', 'puzzles':'jigsaw_puzzle',
    'sand':'sand_pit', 'sensory-bags-and-bottles':'milk_bottle', 'sewing-and-weaving':'wool',
    'shaving-foam-and-bubbles':'bubble_mixture', 'shop':'shop', 'sorting-and-pattern':'shapesorter',
    'space':'rocket', 'trains':'steam_train', 'transient-art':'shells',
    'treasure-baskets':'basket', 'under-the-sea':'fish', 'vehicles-and-diggers':'tractor',
    'vets':'dog', 'water':'water', 'wooden-blocks':'bricks',
    'woodwork-bench':'hammer', 'writing-shed':'pencil', 'zoo-animals':'elephant'
  };

  var AGE_LABELS = { '6m-2': '6m–2 yrs', '2-5': '2–5 yrs', 'all': 'All ages' };
  // b380: any other "a-b" range ("3-5", "0-2", "1-4") reads as "3–5 yrs" rather than raw.
  function ageLabel(r) {
    if (!r) return '';
    if (AGE_LABELS[r]) return AGE_LABELS[r];
    var m = /^(\d+m?)-(\d+)$/.exec(String(r));
    return m ? m[1] + '–' + m[2] + ' yrs' : String(r);
  }
  function hasItems(a) { return Array.isArray(a) && a.some(function (x) { return x && (typeof x === 'string' ? x.trim() : true); }); }

  var COEL_GROUPS = [
    ['playing_exploring', 'Playing & Exploring'],
    ['active_learning',   'Active Learning'],
    ['creating_thinking', 'Creating & Thinking Critically']
  ];

  // ── Screen stylesheet — themed via CSS vars set per theme class ─────────────
  // Dark = LADN navy per design guidelines; light = warm paper. Accent (--wrc-acc)
  // is set inline per card from CATEGORY_META.
  var SCREEN_CSS = [
    '.wrc-card{--wrc-bg:#1e293b;--wrc-panel:#0f172a;--wrc-bd:#2d3748;--wrc-txt:#f1f5f9;--wrc-mut:#94a3b8;',
    '  --wrc-soft:rgba(255,255,255,.06);--wrc-plate:#ffffff;',
    '  background:var(--wrc-bg);border:1px solid var(--wrc-bd);border-top:5px solid var(--wrc-acc,#4a9abf);',
    '  border-radius:12px;padding:18px;color:var(--wrc-txt);font-family:system-ui,Arial,sans-serif;line-height:1.4;}',
    '.wrc-card.wrc-theme-light{--wrc-bg:#fffdf8;--wrc-panel:#ffffff;--wrc-bd:#e2e0d8;--wrc-txt:#1f2937;--wrc-mut:#6b7280;',
    '  --wrc-soft:rgba(0,0,0,.045);--wrc-plate:#ffffff;box-shadow:0 2px 10px rgba(0,0,0,.07);}',
    '.wrc-head{display:flex;gap:14px;align-items:flex-start;border-bottom:2px solid var(--wrc-acc,#4a9abf);padding-bottom:12px;margin-bottom:14px;}',
    '.wrc-cat-icon{flex:0 0 auto;font-size:2.1rem;color:var(--wrc-acc,#4a9abf);display:inline-flex;align-items:center;justify-content:center;',
    '  width:52px;height:52px;background:var(--wrc-soft);border-radius:12px;}',
    '.wrc-cat-icon svg{width:1.3em;height:1.3em;}',
    '.wrc-hero{flex:0 0 auto;width:92px;height:92px;background:var(--wrc-plate);border:2px solid var(--wrc-acc,#4a9abf);',
    '  border-radius:14px;display:flex;align-items:center;justify-content:center;overflow:hidden;margin-left:auto;}',
    '.wrc-hero img{width:82%;height:82%;object-fit:contain;display:block;}',
    '.wrc-head-text{flex:1;min-width:0;}',
    '.wrc-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
    '.wrc-title{margin:0;font-size:1.35rem;color:var(--wrc-txt);font-family:\'Arial Rounded MT Bold\',\'Nunito\',Arial,sans-serif;}',
    '.wrc-age-badge{font-size:.72rem;font-weight:700;padding:3px 10px;border-radius:999px;background:rgba(224,120,32,.16);color:#e07820;white-space:nowrap;}',
    '.wrc-cat-badge{font-size:.72rem;font-weight:700;padding:3px 10px;border-radius:999px;background:var(--wrc-acc,#4a9abf);color:#fff;white-space:nowrap;}',
    '.wrc-strapline{margin:5px 0 8px;font-size:.92rem;color:var(--wrc-mut);font-style:italic;}',
    '.wrc-area-chips{display:flex;gap:6px;flex-wrap:wrap;}',
    '.wrc-area-chip{font-size:.7rem;font-weight:600;padding:2px 9px;border-radius:999px;border:1px solid var(--wrc-bd);color:var(--wrc-mut);background:var(--wrc-panel);}',
    '.wrc-cols{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:14px;}',
    '@media(max-width:820px){.wrc-cols{grid-template-columns:1fr;}}',
    '.wrc-section{background:var(--wrc-panel);border:1px solid var(--wrc-bd);border-radius:10px;padding:12px 14px;}',
    '.wrc-section-title{margin:0 0 8px;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--wrc-acc,#4a9abf);',
    '  font-family:\'Arial Rounded MT Bold\',\'Nunito\',Arial,sans-serif;}',
    '.wrc-impl .wrc-section-title{color:#e07820;}',
    '.wrc-list{margin:0;padding-left:18px;font-size:.84rem;color:var(--wrc-txt);}',
    '.wrc-list li{margin-bottom:6px;}',
    '.wrc-list li:last-child{margin-bottom:0;}',
    '.wrc-fledge-chip{display:inline-block;font-size:.66rem;font-weight:700;font-family:ui-monospace,Menlo,Consolas,monospace;',
    '  padding:1px 6px;margin:0 3px 2px 0;border-radius:6px;background:var(--wrc-soft);color:var(--wrc-acc,#7dd3fc);border:1px solid var(--wrc-acc,#4a9abf);white-space:nowrap;}',
    '.wrc-fledge-icon{display:inline-block;margin:0 3px 2px 0;}',
    '.wrc-fledge-icon .fledge-profile-icon{background:var(--wrc-soft);border-color:var(--wrc-acc,#4a9abf);}',
    '.wrc-questions{margin-bottom:14px;border-left:3px solid #e07820;}',
    '.wrc-questions .wrc-section-title{color:#e07820;}',
    '.wrc-q-list li{font-style:italic;color:var(--wrc-mut);}',
    '.wrc-enhancements{margin-bottom:14px;}',
    '.wrc-enh-row{display:flex;gap:8px;flex-wrap:wrap;}',
    '.wrc-enh-chip{font-size:.78rem;padding:6px 12px;border-radius:10px;background:var(--wrc-bg);border:1px solid var(--wrc-bd);color:var(--wrc-txt);}',
    '.wrc-coel{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;background:var(--wrc-panel);border:1px solid var(--wrc-bd);',
    '  border-radius:10px;padding:12px 14px;}',
    '@media(max-width:820px){.wrc-coel{grid-template-columns:1fr;}}',
    '.wrc-coel-group{min-width:0;}',
    '.wrc-coel-title{margin:0 0 5px;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:var(--wrc-mut);}',
    '.wrc-coel-list{margin:0;padding-left:16px;font-size:.78rem;color:var(--wrc-mut);}',
    '.wrc-coel-list li{margin-bottom:3px;}',
    // b257 — downloads + attribution. Only setting-supplied cards carry these:
    // a shipped Wren card has no files attached and renders exactly as before.
    '.wrc-files{margin-top:14px;background:var(--wrc-panel);border:1px solid var(--wrc-bd);border-radius:10px;padding:12px 14px;}',
    '.wrc-files-row{display:flex;gap:8px;flex-wrap:wrap;}',
    '.wrc-file{display:inline-flex;align-items:center;gap:7px;font-size:.8rem;text-decoration:none;padding:7px 12px;border-radius:10px;',
    '  background:var(--wrc-bg);border:1px solid var(--wrc-acc,#4a9abf);color:var(--wrc-txt);}',
    '.wrc-file:hover{background:var(--wrc-soft);}',
    '.wrc-file-size{font-size:.7rem;color:var(--wrc-mut);}',
    '.wrc-attrib{margin:10px 0 0;font-size:.7rem;line-height:1.45;color:var(--wrc-mut);}',
    '.wrc-hero.wrc-hero-art{width:120px;height:120px;background:#fff;}',
    '.wrc-hero.wrc-hero-art img{width:94%;height:94%;object-fit:contain;}'
  ].join('\n');

  // ── Print stylesheet — light/ink-friendly, A4 landscape, category accents ───
  var PRINT_CSS = [
    '@page{size:A4 landscape;margin:10mm;}',
    '#wren-rc-print-root{display:none;}',
    '@media print{',
    '  body>*:not(#wren-rc-print-root){display:none !important;}',
    '  html,body{background:#fff !important;margin:0;padding:0;}',
    '  #wren-rc-print-root{display:block !important;}',
    '  .wrc-card.wrc-print{background:#fff;border:none;border-top:5px solid var(--wrc-acc,#4a9abf);border-radius:0;padding:6px 0 0;color:#1a1a1a;',
    '    font-family:system-ui,Arial,sans-serif;line-height:1.35;break-after:page;page-break-after:always;',
    '    -webkit-print-color-adjust:exact;print-color-adjust:exact;}',
    '  .wrc-card.wrc-print:last-child{break-after:auto;page-break-after:auto;}',
    '  .wrc-print .wrc-head{display:flex;gap:12px;align-items:flex-start;border-bottom:2.5px solid var(--wrc-acc,#4a9abf);padding-bottom:8px;margin-bottom:10px;}',
    '  .wrc-print .wrc-cat-icon{flex:0 0 auto;width:44px;height:44px;color:var(--wrc-acc,#4a9abf);background:none;border:1.5px solid var(--wrc-acc,#4a9abf);',
    '    border-radius:10px;display:inline-flex;align-items:center;justify-content:center;font-size:1.7rem;}',
    '  .wrc-print .wrc-cat-icon svg{width:1.3em;height:1.3em;}',
    '  .wrc-print .wrc-hero{flex:0 0 auto;width:76px;height:76px;border:2px solid var(--wrc-acc,#4a9abf);border-radius:12px;',
    '    display:flex;align-items:center;justify-content:center;overflow:hidden;margin-left:auto;background:#fff;}',
    '  .wrc-print .wrc-hero img{width:84%;height:84%;object-fit:contain;display:block;}',
    '  .wrc-print .wrc-hero.wrc-hero-art{width:118px;height:118px;}',
    '  .wrc-print .wrc-hero.wrc-hero-art img{width:96%;height:96%;}',
    '  .wrc-print .wrc-head-text{flex:1;min-width:0;}',
    '  .wrc-print .wrc-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
    '  .wrc-print .wrc-title{margin:0;font-size:17pt;color:#1a1a1a;font-family:\'Arial Rounded MT Bold\',\'Nunito\',Arial,sans-serif;}',
    '  .wrc-print .wrc-age-badge{font-size:8pt;font-weight:700;padding:2px 9px;border-radius:999px;border:1.5px solid #e07820;color:#e07820;background:none;}',
    '  .wrc-print .wrc-cat-badge{font-size:8pt;font-weight:700;padding:2px 9px;border-radius:999px;border:none;color:#fff;background:var(--wrc-acc,#4a9abf);}',
    '  .wrc-print .wrc-strapline{margin:3px 0 5px;font-size:10pt;color:#555;font-style:italic;}',
    '  .wrc-print .wrc-area-chips{display:flex;gap:5px;flex-wrap:wrap;}',
    '  .wrc-print .wrc-area-chip{font-size:7pt;font-weight:600;padding:1px 8px;border-radius:999px;border:1px solid #999;color:#444;background:none;}',
    '  .wrc-print .wrc-cols{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-bottom:9px;}',
    '  .wrc-print .wrc-section{background:none;border:1px solid #bbb;border-radius:8px;padding:8px 10px;break-inside:avoid;}',
    '  .wrc-print .wrc-section-title{margin:0 0 5px;font-size:8pt;text-transform:uppercase;letter-spacing:.06em;color:var(--wrc-acc,#2a6f92);',
    '    font-family:\'Arial Rounded MT Bold\',\'Nunito\',Arial,sans-serif;}',
    '  .wrc-print .wrc-impl .wrc-section-title{color:#b05c12;}',
    '  .wrc-print .wrc-list{margin:0;padding-left:14px;font-size:8.5pt;color:#1a1a1a;}',
    '  .wrc-print .wrc-list li{margin-bottom:3px;}',
    '  .wrc-print .wrc-fledge-icon{display:inline-block;margin:0 2pt 1pt 0;}',
    '  .wrc-print .wrc-fledge-icon .fledge-profile-icon{background:#fff;border:1px solid #bbb;padding:1pt 2pt;}',
    '  .wrc-print .wrc-fledge-icon .fp-ic{width:9pt;height:9pt;}',
    '  .wrc-print .wrc-fledge-chip{display:inline-block;font-size:6.5pt;font-weight:700;font-family:ui-monospace,Menlo,Consolas,monospace;',
    '    padding:0 4px;margin:0 2px 1px 0;border-radius:4px;border:1px solid var(--wrc-acc,#4a9abf);color:var(--wrc-acc,#2a6f92);background:none;white-space:nowrap;}',
    '  .wrc-print .wrc-questions{margin-bottom:9px;border-left:3px solid #e07820;}',
    '  .wrc-print .wrc-questions .wrc-section-title{color:#b05c12;}',
    '  .wrc-print .wrc-q-list li{font-style:italic;color:#333;}',
    '  .wrc-print .wrc-enhancements{margin-bottom:9px;}',
    '  .wrc-print .wrc-enh-row{display:flex;gap:5px;flex-wrap:wrap;}',
    '  .wrc-print .wrc-enh-chip{font-size:8pt;padding:3px 9px;border-radius:8px;border:1px solid #999;color:#1a1a1a;background:none;}',
    '  .wrc-print .wrc-coel{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;border:1px solid #bbb;',
    '    border-radius:8px;padding:8px 10px;background:none;break-inside:avoid;}',
    '  .wrc-print .wrc-coel-title{margin:0 0 3px;font-size:7pt;text-transform:uppercase;letter-spacing:.05em;color:#555;}',
    '  .wrc-print .wrc-coel-list{margin:0;padding-left:13px;font-size:7.5pt;color:#333;}',
    '  .wrc-print .wrc-coel-list li{margin-bottom:2px;}',
    '  .wrc-print .wrc-files{margin-top:9px;border:1px solid #bbb;border-radius:6px;padding:6px 8px;}',
    '  .wrc-print .wrc-file{display:inline;border:0;background:none;padding:0;font-size:8pt;color:#333;}',
    '  .wrc-print .wrc-file:after{content:"  ";}',
    '  .wrc-print .wrc-file-size{display:none;}',
    '  .wrc-print .wrc-attrib{font-size:6.5pt;color:#555;margin-top:5px;}',
    '}'
  ].join('\n');

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function iconSvg(key) {
    try {
      if (key && window.WrenIcons && typeof window.WrenIcons.get === 'function') {
        return window.WrenIcons.get(key) || '';
      }
    } catch (e) { /* icons are optional decoration */ }
    return '';
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text; // textContent — never innerHTML for card content
    return n;
  }

  function list(items, cls) {
    var ul = el('ul', cls);
    (Array.isArray(items) ? items : []).forEach(function (t) {
      ul.appendChild(el('li', null, String(t)));
    });
    return ul;
  }

  function section(title, cls) {
    var s = el('section', 'wrc-section' + (cls ? ' ' + cls : ''));
    s.appendChild(el('h3', 'wrc-section-title', title));
    return s;
  }

  function ensureScreenStyles() {
    if (document.getElementById('wren-rc-screen-css')) return;
    var s = document.createElement('style');
    s.id = 'wren-rc-screen-css';
    s.textContent = SCREEN_CSS;
    document.head.appendChild(s);
  }

  function injectPrintStyles() {
    if (document.getElementById('wren-rc-print-css')) return;
    var s = document.createElement('style');
    s.id = 'wren-rc-print-css';
    s.textContent = PRINT_CSS;
    document.head.appendChild(s);
  }

  function currentTheme() {
    try { return localStorage.getItem('wrenRcTheme') === 'light' ? 'light' : 'dark'; }
    catch (e) { return 'dark'; }
  }

  // ── Main renderer ───────────────────────────────────────────────────────────
  function renderCard(card, opts) {
    opts = opts || {};
    if (!opts.print) ensureScreenStyles();
    card = card || {};

    var meta = CATEGORY_META[card.category] || { label: card.category || '', icon: null, acc: '#4a9abf' };
    var theme = opts.print ? 'light' : (opts.theme || currentTheme());
    var root = el('article', 'wrc-card' + (opts.print ? ' wrc-print' : '') + (theme === 'light' && !opts.print ? ' wrc-theme-light' : ''));
    root.setAttribute('data-slug', card.slug || '');
    if (meta.acc) root.style.setProperty('--wrc-acc', meta.acc);

    // Header: category icon + title/badges/strapline/areas + hero illustration
    var head = el('header', 'wrc-head');
    var svg = iconSvg(meta.icon);
    if (svg) {
      var ic = el('span', 'wrc-cat-icon');
      ic.innerHTML = svg; // trusted markup from our own icon registry
      head.appendChild(ic);
    }
    var ht = el('div', 'wrc-head-text');
    var titleRow = el('div', 'wrc-title-row');
    titleRow.appendChild(el('h2', 'wrc-title', card.title || card.slug || 'Untitled card'));
    var ageText = ageLabel(card.age_range);
    if (ageText) titleRow.appendChild(el('span', 'wrc-age-badge', ageText));
    if (meta.label) titleRow.appendChild(el('span', 'wrc-cat-badge', meta.label));
    ht.appendChild(titleRow);
    if (card.strapline) ht.appendChild(el('p', 'wrc-strapline', card.strapline));
    var chips = el('div', 'wrc-area-chips');
    (Array.isArray(card.areas) ? card.areas : []).forEach(function (a) {
      chips.appendChild(el('span', 'wrc-area-chip', a));
    });
    ht.appendChild(chips);
    head.appendChild(ht);
    // 2026-10-08: a card's own illustration (ComfyUI clipart, reviewed) wins over the
    // Mulberry symbol. hero_url is set by the API (/card-art/<slug>.jpg) or, for the public
    // PDFs, a data: URI. The symbol stays as the fallback.
    if (card.hero_url) {
      var heroA = el('span', 'wrc-hero wrc-hero-art');
      var imgA = document.createElement('img');
      imgA.alt = ''; imgA.loading = 'lazy'; imgA.src = card.hero_url;
      imgA.onerror = function () { if (heroA.parentNode) heroA.parentNode.removeChild(heroA); };
      heroA.appendChild(imgA);
      head.appendChild(heroA);
    }
    var heroFile = card.hero_url ? null : (card.hero || HERO[card.slug]);
    if (heroFile) {
      var hero = el('span', 'wrc-hero');
      var img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = '/symbols/mulberry/' + encodeURIComponent(heroFile) + '.svg';
      img.onerror = function () { if (hero.parentNode) hero.parentNode.removeChild(hero); };
      hero.appendChild(img);
      head.appendChild(hero);
    }
    root.appendChild(head);

    // Three-column main: Intent / How Adults Support / What Learning Looks Like
    var cols = el('div', 'wrc-cols');

    // b380: a section with nothing in it is left out rather than shown as an
    // empty headed box (18 imported cards have no CoEL / enhancements / intent).
    if (hasItems(card.intent)) {
      var sIntent = section('Curriculum Intent', 'wrc-intent');
      sIntent.appendChild(list(card.intent, 'wrc-list'));
      cols.appendChild(sIntent);
    }

    if (hasItems(card.implementation)) {
      var sImpl = section('How Adults Support', 'wrc-impl');
      sImpl.appendChild(list(card.implementation, 'wrc-list'));
      cols.appendChild(sImpl);
    }

    var sImpact = section('What Learning Looks Like', 'wrc-impact');
    var impactUl = el('ul', 'wrc-list wrc-impact-list');
    (Array.isArray(card.impact) ? card.impact : []).forEach(function (entry) {
      if (!entry) return;
      var li = el('li');
      li.appendChild(document.createTextNode((entry.text || '') + ' '));
      /* b278 — a Fledge Profile link renders as ICONS, not the bare letter code
       * (Toby, 2026-09-04). The code survives as title/aria-label so inspectors
       * and reports can still read it. Falls back to the old code chip only if
       * the lookup module is not on the page. */
      /* fledge-off (2026-10-26): the codes are Fledge statement codes, so they are only
       * drawn while the one Fledge switch is on (public/js/wren-fledge.js). The card's
       * own sentence always shows; the data on the card is untouched. */
      var _fledgeOn = (typeof window !== 'undefined') && window.WrenFledge && window.WrenFledge.enabled();
      (_fledgeOn && Array.isArray(entry.fledge) ? entry.fledge : []).forEach(function (code) {
        var FP = (typeof window !== 'undefined') && window.FledgeProfile;
        var stmt = FP && FP.get(code);
        if (stmt) {
          var span = el('span', 'wrc-fledge-icon');
          span.innerHTML = FP.html(stmt.num, { size: 15 });
          li.appendChild(span);
        } else {
          li.appendChild(el('code', 'wrc-fledge-chip', String(code)));
        }
      });
      impactUl.appendChild(li);
    });
    sImpact.appendChild(impactUl);
    if (impactUl.childNodes.length) cols.appendChild(sImpact);
    if (cols.childNodes.length) {
      // Fewer than three sections: share the width instead of leaving a gap.
      if (cols.childNodes.length < 3) cols.style.gridTemplateColumns = 'repeat(' + cols.childNodes.length + ',1fr)';
      root.appendChild(cols);
    }

    // Key Questions box
    if (hasItems(card.key_questions)) {
      var kq = section('Key Questions', 'wrc-questions');
      kq.appendChild(list(card.key_questions, 'wrc-list wrc-q-list'));
      root.appendChild(kq);
    }

    // Enhancements row
    if (hasItems(card.enhancements)) {
      var en = section('Enhancements & Provocations', 'wrc-enhancements');
      var enhRow = el('div', 'wrc-enh-row');
      card.enhancements.forEach(function (e) {
        enhRow.appendChild(el('span', 'wrc-enh-chip', String(e)));
      });
      en.appendChild(enhRow);
      root.appendChild(en);
    }

    // CoEL strip — three labelled groups (only the groups that have content)
    var coel = card.coel || {};
    var groups = COEL_GROUPS.filter(function (pair) { return hasItems(coel[pair[0]]); });
    if (groups.length) {
      var strip = el('div', 'wrc-coel');
      if (groups.length < 3) strip.style.gridTemplateColumns = 'repeat(' + groups.length + ',1fr)';
      groups.forEach(function (pair) {
        var g = el('div', 'wrc-coel-group');
        g.appendChild(el('h4', 'wrc-coel-title', pair[1]));
        g.appendChild(list(coel[pair[0]], 'wrc-coel-list'));
        strip.appendChild(g);
      });
      root.appendChild(strip);
    }

    // b257 — printables + attribution, for cards that come from the setting's own
    // content store rather than Wren's shipped library. Files stream through
    // /api/setting-content/file, which is staff-authenticated and range-capable.
    var files = Array.isArray(card.downloads) ? card.downloads : [];
    if (files.length) ensureMediaTicket();   // b257 — see the note on that function
    if (files.length || card.attribution) {
      var fs = section(files.length === 1 ? 'Printable' : 'Printables', 'wrc-files');
      if (files.length) {
        var frow = el('div', 'wrc-files-row');
        files.forEach(function (f) {
          if (!f || !f.path) return;
          var a = el('a', 'wrc-file');
          a.href = fileHref(f.path);
          a.target = '_blank';
          a.rel = 'noopener';
          a.dataset.scPath = f.path;
          // Re-stamp at click time in case the ticket landed after render, or an
          // old one has expired while the overlay sat open.
          a.addEventListener('click', function () { this.href = fileHref(this.dataset.scPath); });
          a.appendChild(document.createTextNode(String(f.label || f.path)));
          if (f.bytes) a.appendChild(el('span', 'wrc-file-size', fileSize(f.bytes)));
          frow.appendChild(a);
        });
        fs.appendChild(frow);
      }
      if (card.attribution) fs.appendChild(el('p', 'wrc-attrib', String(card.attribution)));
      root.appendChild(fs);
    }

    return root;
  }

  // b257 — a plain <a> cannot send an Authorization header, so a setting-content
  // download needs a short-lived media ticket in the URL. Fetched once, lazily,
  // the first time a card with files is rendered, and re-fetched when it is about
  // to expire. Until it arrives the link is still emitted (and re-stamped on
  // click), so nothing depends on the fetch having finished.
  var _ticket = null, _ticketAt = 0, _ticketPending = false;
  var TICKET_REFRESH_MS = 20 * 60 * 1000;   // route issues 30 min; refresh well before

  function ensureMediaTicket() {
    if (_ticketPending) return;
    if (_ticket && (Date.now() - _ticketAt) < TICKET_REFRESH_MS) return;
    if (!(window.Wren && typeof window.Wren.api === 'function')) return;
    _ticketPending = true;
    window.Wren.api('/api/setting-content/media-ticket').then(function (r) {
      _ticket = (r && r.ticket) || null;
      _ticketAt = Date.now();
      _ticketPending = false;
      // Stamp any links already on the page.
      document.querySelectorAll('a.wrc-file[data-sc-path]').forEach(function (a) {
        a.href = fileHref(a.dataset.scPath);
      });
    }).catch(function () { _ticketPending = false; });
  }

  function fileHref(path) {
    return '/api/setting-content/file?path=' + encodeURIComponent(path) + '&download=1'
         + (_ticket ? '&t=' + encodeURIComponent(_ticket) : '');
  }

  // Human-readable byte size — a room lead deciding whether to open something on
  // nursery wifi wants to know it is 3 MB and not 300.
  function fileSize(n) {
    n = Number(n) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  // ── Print helper: render cards into a print-only root and print ─────────────
  function printCards(cardOrCards) {
    injectPrintStyles();
    var root = document.getElementById('wren-rc-print-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'wren-rc-print-root';
      root.style.display = 'none'; // hidden on screen; print CSS shows it
      document.body.appendChild(root);
    }
    root.innerHTML = '';
    var cards = Array.isArray(cardOrCards) ? cardOrCards : [cardOrCards];
    cards.forEach(function (c) { root.appendChild(renderCard(c, { print: true })); });
    window.print();
  }

  // Theme helper for the pages' toggle buttons.
  function setTheme(t) {
    try { localStorage.setItem('wrenRcTheme', t === 'light' ? 'light' : 'dark'); } catch (e) {}
  }

  window.WrenResourceCards = {
    renderCard: renderCard,
    printCards: printCards,
    injectPrintStyles: injectPrintStyles,
    printCSS: PRINT_CSS,
    screenCSS: SCREEN_CSS,
    CATEGORY_META: CATEGORY_META,
    AGE_LABELS: AGE_LABELS,
    ageLabel: ageLabel,
    HERO: HERO,
    theme: currentTheme,
    setTheme: setTheme
  };
})();
