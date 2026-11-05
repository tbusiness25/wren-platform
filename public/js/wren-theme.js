/* ============================================================================
 * wren-theme.js — Wren appearance engine + editor (b351, 2026-09-22)
 * ----------------------------------------------------------------------------
 * ONE engine and ONE editor for Roost, EY and HR. (The parents app still runs its own
 * three-knob editor — legacyParents() below, byte-for-byte the pre-b351 code — until its
 * pages move to the shared tokens; see logs/b351-one-palette-everywhere.NOTES.md.)
 *
 * Loaded synchronously in <head> on every Roost, EY and HR page, so a saved palette is
 * on the page before first paint. With nothing saved it does nothing at all.
 *
 *   WrenTheme.open()          the editor as a sheet (EY / HR "Appearance")
 *   WrenTheme.mount(el)       the same editor inline (Roost → System → Appearance)
 *   WrenTheme.applySaved()    re-apply whoever is signed in (called automatically)
 *   WrenTheme.reset()         back to the Wren palette (or the setting's default)
 *   WrenTheme.current()       the active preferences, or null
 *   WrenTheme.gate(state)     the WCAG check on an editor state (used by scripts/tests)
 *
 * Palette VALUES live in /css/wren-tokens.css only. Saving is refused below WCAG AA —
 * here (public/js/wren-contrast.js) and again on the server (src/routes/appearance.js).
 * ==========================================================================*/
(function () {
  'use strict';

  if (window.WrenTheme) return;                       // idempotent

  var _host = location.hostname || '', _path = location.pathname || '';
  var IS_PARENTS = _host.indexOf('parents.') === 0 || _path === '/welcome' || _path.indexOf('/welcome') === 0;
  var PORTAL = IS_PARENTS ? 'parents' : ((_path.indexOf('/ey') === 0 || _host.indexOf('hr.') === 0 || _host.indexOf('ey.') === 0) ? 'ey' : 'roost');
  if (IS_PARENTS) { legacyParents(); return; }

  /* ══════════════════════════════════════════════════════════════════════════════════════════════
   * b351 — the shared engine: Roost, EY and HR. (Parents runs legacyParents() above, unchanged.)
   *
   * A person's appearance is  { v:2, mode:'auto'|'light'|'dark', palette:'wren'|'contrast',
   *                             ov:{dark:{token:colour}, light:{…}}      what the person picked
   *                             inline:{dark:{…}, light:{…}}             ov + derived inks — what boot applies
   *                             owner: staff id }
   * There is NO palette data in this file. The four palettes live in /css/wren-tokens.css and are
   * selected by  <html data-wren-theme="dark|light|contrast-dark|contrast-light">; a saved override is
   * an inline custom property on <html>. Preview and the contrast gate read base values from a
   * [data-wren-scope=…] scratch element, so the CSS stays the only definition of a palette.
   *
   * Nothing is applied unless somebody chose something (or a manager set a default): with no
   * preference the page carries no attribute at all and renders exactly as it did before b351.
   * ══════════════════════════════════════════════════════════════════════════════════════════════ */
  var KEY = 'wren.appearance', DEF_KEY = 'wren.appearance.default', LEGACY_KEY = 'wren.theme';
  var FAM = {
    wren:     { label: 'Wren',          blurb: 'The Roost look: deep navy, or a soft light.', dark: 'dark',          light: 'light' },
    contrast: { label: 'High contrast', blurb: 'Black and white with strong edges.',           dark: 'contrast-dark', light: 'contrast-light' }
  };
  var READ = ['--c-bg', '--c-surface', '--c-surface-2', '--c-surface-solid', '--c-text', '--c-muted', '--c-blue', '--c-on-blue',
    '--c-orange', '--c-on-orange', '--c-on-fill', '--c-ok', '--c-warn', '--c-danger', '--c-bar', '--c-on-bar', '--c-focus',
    '--c-border', '--c-border-strong', '--c-paper', '--c-paper-ink'];
  var EDIT = [
    ['--c-bg',      'Page',           'Behind everything'],
    ['--c-surface', 'Cards',          'Cards and panels'],
    ['--c-text',    'Text',           'Main text'],
    ['--c-muted',   'Secondary text', 'Labels and hints'],
    ['--c-blue',    'Blue',           'Links, buttons and highlights'],
    ['--c-orange',  'Orange',         'Warm accents'],
    ['--c-ok',      'Good',           'Ticks and “OK” badges'],
    ['--c-warn',    'Warning',        'Amber alerts'],
    ['--c-danger',  'Problem',        'Errors and overdue items']
  ];
  var EDIT_KEYS = EDIT.map(function (e) { return e[0]; });

  function readJSON(k) { try { var r = localStorage.getItem(k); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
  function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function dropKey(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function sessionTok() { try { return sessionStorage.getItem('wrenToken'); } catch (e) { return null; } }
  function sessionUser() {
    try { var u = JSON.parse(sessionStorage.getItem('wrenUser') || 'null'); if (u && u.id != null) return u; } catch (e) {}
    try {
      var t = sessionTok();
      if (t) { var p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); if (p && p.id != null) return p; }
    } catch (e) {}
    return null;
  }
  function sessionId() { var u = sessionUser(); return u ? String(u.id) : null; }
  function isManagerRole() { var u = sessionUser(); return !!u && /^(manager|deputy_manager|admin|owner|headteacher)$/.test(String(u.role || '')); }

  /* whose preference applies on THIS device: a person's own (only if they are the one signed in — an EY
   * tablet is shared), else the manager's default for the setting, else nothing (the pre-b351 look) */
  function activePrefs() {
    var sid = sessionId(), mine = readJSON(KEY);
    if (mine && mine.v === 2 && sid && String(mine.owner) === sid) return mine;
    var d = readJSON(DEF_KEY);
    return d && d.v === 2 ? d : null;
  }
  function schemeOf(p) {
    if (p.mode === 'light' || p.mode === 'dark') return p.mode;
    return (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }

  var applied = [], metaOrig = null;
  function applyPrefs(p) {
    var de = document.documentElement;
    applied.forEach(function (n) { try { de.style.removeProperty(n); } catch (e) {} });
    applied = [];
    if (!p) { de.removeAttribute('data-wren-theme'); setMeta(null); return null; }
    var scheme = schemeOf(p), fam = FAM[p.palette] || FAM.wren;
    de.setAttribute('data-wren-theme', fam[scheme]);
    var inl = (p.inline && p.inline[scheme]) || {};
    Object.keys(inl).forEach(function (n) {
      if (/^--c-[a-z0-9-]+$/.test(n) && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%\/]+\))$/i.test(String(inl[n]))) { de.style.setProperty(n, inl[n]); applied.push(n); }
    });
    setMeta(true);
    return scheme;
  }
  function setMeta(on) {
    try {
      var m = document.querySelector('meta[name="theme-color"]'); if (!m) return;
      if (metaOrig === null) metaOrig = m.getAttribute('content') || '';
      if (!on) { m.setAttribute('content', metaOrig); return; }
      var v = getComputedStyle(document.documentElement).getPropertyValue('--c-bar').trim();
      if (v) m.setAttribute('content', v);
    } catch (e) {}
  }
  function applySaved() { applyPrefs(activePrefs()); }
  applySaved();                                                    // before first paint where this script is synchronous
  try {                                                            // Auto follows the device, live
    if (window.matchMedia) {
      var mq = matchMedia('(prefers-color-scheme: light)');
      var onChange = function () { var p = activePrefs(); if (p && p.mode === 'auto') applyPrefs(p); };
      if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
    }
  } catch (e) {}

  /* ── talking to the server (staff only; every failure is silent — a theme must never log anyone out) ── */
  function hdrs(json) {
    var h = { Accept: 'application/json' }, t = sessionTok();
    if (t) h.Authorization = 'Bearer ' + t;
    try { var d = localStorage.getItem('wrenDevice'); if (d) h['X-Wren-Device'] = d; } catch (e) {}
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }
  function call(method, url, body) {
    return fetch(url, { method: method, headers: hdrs(body !== undefined), credentials: 'same-origin', body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, ok: r.ok, body: j }; }); });
  }
  var synced = false;
  function sync() {
    if (!sessionTok()) return Promise.resolve(false);
    return call('GET', '/api/appearance').then(function (r) {
      if (!r.ok) return false;
      var j = r.body || {}, sid = j.staffId != null ? String(j.staffId) : sessionId();
      if (j.default && j.default.v === 2) writeJSON(DEF_KEY, j.default); else dropKey(DEF_KEY);
      var local = readJSON(KEY);
      if (j.mine && j.mine.v === 2) { j.mine.owner = sid; writeJSON(KEY, j.mine); }
      else if (local && String(local.owner) === sid) dropKey(KEY);      // reset elsewhere → follow it
      applySaved();
      return true;
    }).catch(function () { return false; });
  }
  function syncOnce() { if (synced) return; synced = true; migrateLegacy().then(sync); }
  document.addEventListener('wren:ready', syncOnce);
  if (document.readyState !== 'loading') setTimeout(syncOnce, 0); else document.addEventListener('DOMContentLoaded', function () { setTimeout(syncOnce, 0); });

  /* ── the contrast library, loaded only when somebody opens the editor (or has an old palette to convert) ── */
  var cLib = null;
  function needC() {
    if (window.WrenContrast) return Promise.resolve(window.WrenContrast);
    if (cLib) return cLib;
    cLib = new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = '/js/wren-contrast.js?v=b351';
      s.onload = function () { res(window.WrenContrast); }; s.onerror = function () { cLib = null; rej(new Error('contrast library did not load')); };
      (document.head || document.documentElement).appendChild(s);
    });
    return cLib;
  }

  /* base values of one palette variant, read off a scratch element — the CSS is the only definition */
  function baseTokens(theme) {
    var d = document.createElement('div');
    d.setAttribute('data-wren-scope', theme); d.style.cssText = 'display:none';
    (document.body || document.documentElement).appendChild(d);
    var cs = getComputedStyle(d), out = {};
    READ.forEach(function (n) { out[n] = cs.getPropertyValue(n).trim(); });
    d.parentNode.removeChild(d);
    return out;
  }

  /* colour arithmetic for the derived tokens. Built from a person's own picks, so it cannot be a literal. */
  /* colour-ok-begin: colours computed at run time from the person's own picks — there is no fixed literal here */
  function mixc(a, b, t) { return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: 1 }; }
  function rgbaStr(c, al) { return 'rgba(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ',' + al + ')'; }
  /* colour-ok-end */
  function bestInk(C, fills, paper, ink) {
    var minP = 99, minI = 99;
    fills.forEach(function (f) { minP = Math.min(minP, C.ratio(paper, f)); minI = Math.min(minI, C.ratio(ink, f)); });
    return minP >= minI ? paper : ink;
  }

  /** ov → the full set of inline custom properties to apply on top of a base variant */
  function deriveInline(C, base, ov) {
    var P = function (n) { var c = C.parse(base[n]); return c; };
    var cur = {}; Object.keys(base).forEach(function (n) { cur[n] = base[n]; });
    var set = {};
    EDIT_KEYS.forEach(function (k) { if (ov[k] && C.parse(ov[k])) { cur[k] = C.hex(C.parse(ov[k])); set[k] = cur[k]; } });
    var bg = C.parse(cur['--c-bg']), txt = C.parse(cur['--c-text']), paper = P('--c-paper'), ink = P('--c-paper-ink');
    var flat = function (c, over) { return c.a < 1 ? C.over(c, over) : c; };
    if (set['--c-bg']) {
      set['--c-navy'] = C.hex(bg); set['--c-navy-mid'] = C.hex(mixc(bg, txt, 0.05)); set['--c-navy-light'] = C.hex(mixc(bg, txt, 0.12));
      if (!set['--c-surface']) { set['--c-surface'] = C.hex(mixc(bg, txt, 0.06)); cur['--c-surface'] = set['--c-surface']; }
      set['--c-bar'] = C.hex(bg); set['--c-on-bar'] = C.hex(txt); cur['--c-bar'] = set['--c-bar']; cur['--c-on-bar'] = set['--c-on-bar'];
    }
    if (set['--c-surface']) {
      var s = flat(C.parse(cur['--c-surface']), bg);
      set['--c-surface-solid'] = C.hex(s); set['--c-surface-2'] = C.hex(mixc(s, txt, 0.07));
    }
    if (set['--c-text']) { set['--c-border'] = rgbaStr(txt, 0.14); set['--c-border-strong'] = rgbaStr(txt, 0.42); }
    if (set['--c-blue'])   { var b = C.parse(cur['--c-blue']);   set['--c-on-blue']   = C.hex(bestInk(C, [b], paper, ink)); set['--c-blue-dark'] = C.hex(mixc(b, ink, 0.2)); set['--c-focus'] = set['--c-blue']; }
    if (set['--c-orange']) { var o = C.parse(cur['--c-orange']); set['--c-on-orange'] = C.hex(bestInk(C, [o], paper, ink)); set['--c-orange-dark'] = C.hex(mixc(o, ink, 0.2)); }
    if (set['--c-ok'] || set['--c-warn'] || set['--c-danger']) {
      set['--c-on-fill'] = C.hex(bestInk(C, ['--c-ok', '--c-warn', '--c-danger'].map(function (n) { return C.parse(cur[n]); }), paper, ink));
    }
    return set;
  }
  function tokensOf(C, base, inline) {
    var t = {}; Object.keys(base).forEach(function (n) { t[n] = base[n]; });
    Object.keys(inline || {}).forEach(function (n) { t[n] = inline[n]; });
    return t;
  }
  function schemesFor(p) { return p.mode === 'auto' ? ['dark', 'light'] : [p.mode]; }

  /** build the storable prefs from an editor state, and gate every scheme it can produce */
  function build(C, st) {
    var p = { v: 2, mode: st.mode, palette: st.palette, ov: { dark: {}, light: {} }, inline: { dark: {}, light: {} } };
    var res = { ok: true, bySchemeResults: {}, failures: [] };
    ['dark', 'light'].forEach(function (sch) {
      var base = baseTokens((FAM[st.palette] || FAM.wren)[sch]);
      var ov = st.ov[sch] || {};
      p.ov[sch] = ov;
      p.inline[sch] = deriveInline(C, base, ov);
      var r = C.check(tokensOf(C, base, p.inline[sch]));
      res.bySchemeResults[sch] = r;
      if (schemesFor(p).indexOf(sch) >= 0 && !r.ok) { res.ok = false; r.failures.forEach(function (f) { res.failures.push({ scheme: sch, f: f }); }); }
    });
    return { prefs: p, gate: res };
  }

  /* ── an old 3-knob palette (pre-b351 editor, EY/HR) → the new shape, once, and only if it is readable ── */
  function migrateLegacy() {
    var old = readJSON(LEGACY_KEY);
    if (!old || !old.bg || !old.text || !old.accent || readJSON(KEY)) return Promise.resolve();
    return needC().then(function (C) {
      var bg = C.parse(old.bg), sch = C.luminance(bg) < 0.4 ? 'dark' : 'light';
      var st = { mode: sch, palette: 'wren', ov: { dark: {}, light: {} } };
      st.ov[sch] = { '--c-bg': old.bg, '--c-text': old.text, '--c-blue': old.accent, '--c-orange': old.accent };
      var b = build(C, st);
      if (b.gate.ok && sessionId()) { b.prefs.owner = sessionId(); writeJSON(KEY, b.prefs); applySaved(); }
      dropKey(LEGACY_KEY);                                          // converted, or too unreadable to keep
    }).catch(function () {});
  }

  /* ── save / reset / default ── */
  function saveMine(prefs) {
    prefs.at = new Date().toISOString();
    if (!sessionTok()) { prefs.owner = null; writeJSON(KEY, prefs); applySaved(); return Promise.resolve({ ok: true, local: true }); }
    return call('PUT', '/api/appearance', prefs).then(function (r) {
      if (r.ok) {
        var mine = r.body && r.body.mine ? r.body.mine : prefs;
        mine.owner = sessionId(); writeJSON(KEY, mine); applySaved();
        return { ok: true };
      }
      return { ok: false, message: (r.body && (r.body.message || r.body.error)) || ('The server said ' + r.status), refused: r.status === 422 };
    }).catch(function () { return { ok: false, message: 'Could not reach Wren just now — nothing was saved.' }; });
  }
  function resetMine() {
    dropKey(KEY); dropKey(LEGACY_KEY);
    var done = function () { applySaved(); return { ok: true }; };
    if (!sessionTok()) return Promise.resolve(done());
    return call('DELETE', '/api/appearance').then(done).catch(done);
  }
  function setDefault(prefs) { return call('PUT', '/api/appearance/default', prefs).then(function (r) { if (r.ok) { writeJSON(DEF_KEY, r.body.default || prefs); applySaved(); } return { ok: r.ok, message: r.body && (r.body.message || r.body.error) }; }).catch(function () { return { ok: false, message: 'Could not reach Wren.' }; }); }
  function clearDefault() { return call('DELETE', '/api/appearance/default').then(function (r) { if (r.ok) { dropKey(DEF_KEY); applySaved(); } return { ok: r.ok }; }).catch(function () { return { ok: false }; }); }

  /* ══ the editor ══════════════════════════════════════════════════════════════════════════════
   * The same panel is mounted inline (Roost → System → Appearance) and shown as a sheet
   * (WrenTheme.open(), from the EY/HR "Appearance" buttons). Its own chrome uses the page's tokens only. */
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k]; else if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }
  function injectStyle() {
    if (document.getElementById('wtx-css')) return;
    var s = document.createElement('style'); s.id = 'wtx-css';
    s.textContent = [
      '.wtx{font-family:var(--font,system-ui,sans-serif);color:var(--c-text);max-width:760px}',
      '.wtx *{box-sizing:border-box}',
      '.wtx [hidden]{display:none !important}',      /* an author display: beats the hidden attribute otherwise (the empty pill under Fine-tune) */
      '.wtx-sec{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:.72rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--c-muted);margin:20px 0 8px}',
      '.wtx-sec small{font-weight:600;letter-spacing:0;text-transform:none;font-size:.78rem}',
      '.wtx-seg{display:inline-flex;padding:3px;gap:2px;border-radius:12px;background:var(--c-surface-2);border:1px solid var(--c-border-strong)}',
      '.wtx-seg button{min-height:40px;min-width:76px;padding:0 14px;border:0;border-radius:9px;background:none;color:var(--c-text);font:700 .88rem var(--font,system-ui,sans-serif);cursor:pointer}',
      '.wtx-seg button[aria-checked="true"]{background:var(--c-blue);color:var(--c-on-blue)}',
      '.wtx button:focus-visible,.wtx input:focus-visible{outline:2px solid var(--c-focus);outline-offset:2px}',
      '.wtx-note{font-size:.82rem;color:var(--c-muted);margin-top:6px;line-height:1.45}',
      '.wtx-pals{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}',
      '.wtx-pal{display:flex;flex-direction:column;gap:6px;text-align:left;border:2px solid var(--c-border-strong);background:var(--c-surface);color:var(--c-text);border-radius:14px;padding:12px;cursor:pointer;font:inherit;min-height:44px}',
      '.wtx-pal[aria-checked="true"]{border-color:var(--c-blue);box-shadow:0 0 0 2px var(--c-blue-soft)}',
      '.wtx-pal b{font-size:.92rem}.wtx-pal span{font-size:.78rem;color:var(--c-muted)}',
      '.wtx-sw{display:flex;gap:3px}.wtx-sw i{width:22px;height:22px;border-radius:6px;display:block;border:1px solid var(--c-border-strong)}',
      '.wtx-rows{border:1px solid var(--c-border-strong);border-radius:14px;overflow:hidden;background:var(--c-surface)}',
      '.wtx-row{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--c-border)}',
      '.wtx-row:last-child{border-bottom:0}.wtx-row>div{flex:1;min-width:0}',
      '.wtx-row b{font-size:.9rem}.wtx-row span{display:block;font-size:.76rem;color:var(--c-muted)}',
      '.wtx-row input[type=color]{width:48px;height:36px;padding:2px;border:1px solid var(--c-border-strong);border-radius:9px;background:var(--c-surface-2);cursor:pointer;flex:none}',
      '.wtx-row .wtx-undo{flex:none;min-width:44px;min-height:44px;border:0;background:none;color:var(--c-ink);font-size:1.1rem;cursor:pointer;border-radius:10px}',
      '.wtx-row .wtx-undo[hidden]{display:none}',
      '.wtx-prev{border-radius:14px;overflow:hidden;border:1px solid var(--c-border-strong);background:var(--c-bg);color:var(--c-text)}',
      '.wtx-prev-bar{padding:10px 14px;background:var(--c-bar);color:var(--c-on-bar);font-weight:800;display:flex;justify-content:space-between;gap:8px}',
      '.wtx-prev-body{padding:14px;display:grid;gap:10px}',
      '.wtx-prev-card{background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;padding:12px}',
      '.wtx-prev-card h4{margin:0 0 4px;font-size:1rem}.wtx-prev-card p{margin:0;font-size:.85rem}',
      '.wtx-prev-card .m{color:var(--c-muted)}.wtx-prev-card a{color:var(--c-blue);font-weight:700}',
      '.wtx-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}',
      '.wtx-chip{font-size:.74rem;font-weight:800;padding:3px 9px;border-radius:99px}',
      '.wtx-chip.ok{background:var(--c-ok-soft);color:var(--c-ok)}.wtx-chip.warn{background:var(--c-warn-soft);color:var(--c-warn)}.wtx-chip.bad{background:var(--c-danger-soft);color:var(--c-danger)}',
      '.wtx-prev-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}',
      '.wtx-prev-btns span{border-radius:10px;padding:8px 14px;font-weight:800;font-size:.85rem}',
      '.wtx-prev-btns .b{background:var(--c-blue);color:var(--c-on-blue)}.wtx-prev-btns .o{background:var(--c-orange);color:var(--c-on-orange)}',
      '.wtx-checks{display:grid;gap:4px;font-size:.84rem}',
      '.wtx-check{display:grid;grid-template-columns:1fr auto 1.6em;gap:8px;align-items:center;padding:6px 10px;border-radius:9px;background:var(--c-surface);border:1px solid var(--c-border)}',
      '.wtx-check.bad{border-color:var(--c-danger);background:var(--c-danger-soft)}',
      '.wtx-check b{font-variant-numeric:tabular-nums}.wtx-check .ok{color:var(--c-ok)}.wtx-check .no{color:var(--c-danger)}',
      '.wtx-msg{margin-top:12px;padding:10px 12px;border-radius:10px;font-size:.86rem;line-height:1.45;background:var(--c-surface-2);border:1px solid var(--c-border)}',
      '.wtx-msg.bad{border-color:var(--c-danger);background:var(--c-danger-soft)}.wtx-msg.good{border-color:var(--c-ok);background:var(--c-ok-soft)}',
      '.wtx-msg ul{margin:6px 0 0 18px;padding:0}',
      '.wtx-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}',
      '.wtx-btn{min-height:46px;padding:0 18px;border-radius:12px;border:1px solid var(--c-border-strong);background:var(--c-surface);color:var(--c-text);font:800 .9rem var(--font,system-ui,sans-serif);cursor:pointer}',
      '.wtx-btn.primary{background:var(--c-blue);border-color:var(--c-blue);color:var(--c-on-blue)}',
      '.wtx-btn[disabled]{opacity:.5;cursor:not-allowed}',
      '.wtx-mgr{margin-top:22px;padding:14px;border-radius:14px;border:1px dashed var(--c-border-strong);background:var(--c-surface)}',
      '.wtx-mgr h4{margin:0 0 4px;font-size:.95rem}',
      '.wtx-ov{position:fixed;inset:0;z-index:100000;display:none;background:var(--c-scrim);align-items:flex-end;justify-content:center}',
      '.wtx-ov.open{display:flex}',
      '@media(min-width:640px){.wtx-ov.open{align-items:center}}',
      '.wtx-sheet{background:var(--c-surface-solid);color:var(--c-text);width:100%;max-width:640px;max-height:92vh;overflow-y:auto;border-radius:18px 18px 0 0;padding:16px 18px calc(20px + env(safe-area-inset-bottom,0px));border:1px solid var(--c-border-strong)}',
      '@media(min-width:640px){.wtx-sheet{border-radius:18px}}',
      '.wtx-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}',
      '.wtx-head h3{margin:0;font-size:1.15rem}',
      '.wtx-x{min-width:44px;min-height:44px;border:0;background:none;color:var(--c-text);font-size:1.6rem;cursor:pointer;border-radius:10px}'
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }

  var STATE = null;   // the panel currently on screen, for the "preview on this page" revert
  function panel(opts) {
    opts = opts || {};
    injectStyle();
    var root = el('div', { class: 'wtx' });
    var C = null, st = null, editScheme = 'dark', previewTimer = null;
    var seg = el('div', { class: 'wtx-seg', role: 'radiogroup', 'aria-label': 'Light or dark' });
    var pals = el('div', { class: 'wtx-pals', role: 'radiogroup', 'aria-label': 'Palette' });
    var rows = el('div', { class: 'wtx-rows' });
    var editSeg = el('div', { class: 'wtx-seg', role: 'radiogroup', 'aria-label': 'Which colours you are editing' });
    var modeNote = el('div', { class: 'wtx-note' });
    var editLbl = el('small');
    var prev = el('div', { class: 'wtx-prev', 'data-wren-scope': 'dark', 'aria-label': 'Preview' });
    var checks = el('div', { class: 'wtx-checks' });
    var msg = el('div', { class: 'wtx-msg', role: 'status', 'aria-live': 'polite' });
    var bSave = el('button', { class: 'wtx-btn primary', type: 'button', text: 'Save my appearance' });
    var bTry = el('button', { class: 'wtx-btn', type: 'button', text: 'Try it on this page' });
    var bReset = el('button', { class: 'wtx-btn', type: 'button', text: 'Back to the Wren palette' });
    var mgr = el('div', { class: 'wtx-mgr' });
    var mgrState = el('div', { class: 'wtx-note' });

    root.appendChild(el('div', { class: 'wtx-sec', text: 'Light or dark' }));
    root.appendChild(seg); root.appendChild(modeNote);
    root.appendChild(el('div', { class: 'wtx-sec', text: 'Palette' })); root.appendChild(pals);
    var fineSec = el('div', { class: 'wtx-sec' }, [el('span', { text: 'Fine-tune' }), editLbl]);
    root.appendChild(fineSec); root.appendChild(editSeg); root.appendChild(rows);
    root.appendChild(el('div', { class: 'wtx-sec', text: 'Preview' })); root.appendChild(prev);
    root.appendChild(el('div', { class: 'wtx-sec', text: 'Readability check' })); root.appendChild(checks);
    root.appendChild(msg);
    root.appendChild(el('div', { class: 'wtx-actions' }, [bSave, bTry, bReset]));
    if (isManagerRole()) {
      mgr.appendChild(el('h4', { text: 'Default for new sign-ins' }));
      mgr.appendChild(el('div', { class: 'wtx-note', text: 'Anyone who has not picked their own look gets this. It never overrides somebody’s own choice.' }));
      mgr.appendChild(mgrState);
      var bDef = el('button', { class: 'wtx-btn', type: 'button', text: 'Use this as the default' });
      var bClr = el('button', { class: 'wtx-btn', type: 'button', text: 'Clear the default' });
      mgr.appendChild(el('div', { class: 'wtx-actions' }, [bDef, bClr]));
      root.appendChild(mgr);
      bDef.addEventListener('click', function () {
        var b = build(C, st); if (!b.gate.ok) return show(b.gate);
        setDefault(b.prefs).then(function (r) { note(r.ok ? 'good' : 'bad', r.ok ? 'Saved as the default for new sign-ins.' : (r.message || 'Could not save the default.')); paintMgr(); });
      });
      bClr.addEventListener('click', function () { clearDefault().then(function () { note('good', 'Default cleared — new sign-ins get the Wren palette.'); paintMgr(); }); });
    }

    function paintMgr() {
      var d = readJSON(DEF_KEY);
      mgrState.textContent = d && d.v === 2 ? 'Current default: ' + (FAM[d.palette] || FAM.wren).label + ' · ' + ({ auto: 'Auto', light: 'Light', dark: 'Dark' }[d.mode] || 'Auto') + '.' : 'No default set — new sign-ins get Wren dark.';
    }
    function note(kind, text, list) {
      msg.className = 'wtx-msg ' + (kind || '');
      msg.textContent = text;
      if (list && list.length) { var ul = el('ul'); list.forEach(function (t) { ul.appendChild(el('li', { text: t })); }); msg.appendChild(ul); }
    }
    function optBtn(label, checked, onClick) {
      var b = el('button', { type: 'button', role: 'radio', 'aria-checked': checked ? 'true' : 'false', text: label });
      b.addEventListener('click', onClick); return b;
    }

    function draw() {
      seg.textContent = '';
      [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].forEach(function (o) {
        seg.appendChild(optBtn(o[1], st.mode === o[0], function () { st.mode = o[0]; if (o[0] !== 'auto') editScheme = o[0]; draw(); }));
      });
      modeNote.textContent = st.mode === 'auto' ? 'Auto follows this device — it is ' + (schemeOf({ mode: 'auto' }) === 'light' ? 'light' : 'dark') + ' right now, and you can tune both looks below.'
        : st.mode === 'light' ? 'Always light, whatever this device is set to.' : 'Always dark, whatever this device is set to.';
      pals.textContent = '';
      Object.keys(FAM).forEach(function (k) {
        var b = base(k, editScheme), card = el('button', { class: 'wtx-pal', type: 'button', role: 'radio', 'aria-checked': st.palette === k ? 'true' : 'false' });
        var sw = el('div', { class: 'wtx-sw' });
        ['--c-bg', '--c-surface-solid', '--c-text', '--c-blue', '--c-orange'].forEach(function (n) { var i = el('i'); i.style.background = b[n]; sw.appendChild(i); });
        card.appendChild(sw); card.appendChild(el('b', { text: FAM[k].label })); card.appendChild(el('span', { text: FAM[k].blurb }));
        card.addEventListener('click', function () { st.palette = k; st.ov = { dark: {}, light: {} }; draw(); });
        pals.appendChild(card);
      });
      editSeg.textContent = '';
      editSeg.hidden = st.mode !== 'auto';
      if (st.mode === 'auto') [['dark', 'Dark look'], ['light', 'Light look']].forEach(function (o) {
        editSeg.appendChild(optBtn(o[1], editScheme === o[0], function () { editScheme = o[0]; draw(); }));
      });
      editLbl.textContent = 'editing the ' + editScheme + ' colours';
      var bs = base(st.palette, editScheme), ov = st.ov[editScheme] || (st.ov[editScheme] = {});
      rows.textContent = '';
      EDIT.forEach(function (e) {
        var name = e[0], val = ov[name] || flatHex(bs[name], bs['--c-bg']);
        var inp = el('input', { type: 'color', 'aria-label': e[1] }); inp.value = val;
        var undo = el('button', { class: 'wtx-undo', type: 'button', 'aria-label': 'Undo ' + e[1], title: 'Back to the palette’s own', text: '↺' }); undo.hidden = !ov[name];
        inp.addEventListener('input', function () { ov[name] = inp.value; undo.hidden = false; refresh(); });
        undo.addEventListener('click', function () { delete ov[name]; draw(); });
        rows.appendChild(el('div', { class: 'wtx-row' }, [el('div', null, [el('b', { text: e[1] }), el('span', { text: e[2] })]), inp, undo]));
      });
      refresh();
    }
    var baseCache = {};
    function base(pal, sch) { var k = pal + '/' + sch; return baseCache[k] || (baseCache[k] = baseTokens((FAM[pal] || FAM.wren)[sch])); }
    function flatHex(v, over) { var c = C.parse(v) || C.parse(base('wren', 'dark')['--c-paper-ink']); if (c.a < 1) c = C.over(c, C.parse(over) || c); return C.hex(c); }

    var lastBuild = null;
    function refresh() {
      lastBuild = build(C, st);
      var p = lastBuild.prefs, gate = lastBuild.gate;
      // preview: the edited scheme, on a scope element, with this scheme's inline overrides
      prev.setAttribute('data-wren-scope', (FAM[st.palette] || FAM.wren)[editScheme]);
      prev.removeAttribute('style');
      var inl = p.inline[editScheme] || {};
      Object.keys(inl).forEach(function (n) { prev.style.setProperty(n, inl[n]); });
      prev.textContent = '';
      prev.appendChild(el('div', { class: 'wtx-prev-bar' }, [el('span', { text: 'Your Nursery' }), el('span', { text: '☰' })]));
      var card = el('div', { class: 'wtx-prev-card' }, [el('h4', { text: 'Today’s register' }), el('p', { text: '14 children in. 2 still to arrive.' }),
        el('p', { class: 'm', text: 'Secondary text looks like this.' }), el('p', null, [el('a', { href: '#', text: 'A link looks like this' })]),
        el('div', { class: 'wtx-chips' }, [el('span', { class: 'wtx-chip ok', text: 'On time' }), el('span', { class: 'wtx-chip warn', text: 'Due soon' }), el('span', { class: 'wtx-chip bad', text: 'Overdue' })]),
        el('div', { class: 'wtx-prev-btns' }, [el('span', { class: 'b', text: 'Save' }), el('span', { class: 'o', text: 'Add' })])]);
      prev.appendChild(el('div', { class: 'wtx-prev-body' }, [card]));
      prev.querySelector('a').addEventListener('click', function (e) { e.preventDefault(); });
      // the contrast table for the edited scheme
      checks.textContent = '';
      var r = gate.bySchemeResults[editScheme];
      r.results.forEach(function (x) {
        checks.appendChild(el('div', { class: 'wtx-check' + (x.ok ? '' : ' bad') }, [el('span', { text: x.label }), el('b', { text: x.ratio.toFixed(1) + ' : 1' }), el('span', { class: x.ok ? 'ok' : 'no', text: x.ok ? '✓' : '✗', 'aria-label': x.ok ? 'passes' : 'fails' })]));
      });
      if (gate.ok) note('good', 'Every pair clears WCAG AA (' + Math.min.apply(null, r.results.map(function (x) { return x.ratio; })).toFixed(1) + ' : 1 at the lowest). This can be saved.');
      else show(gate);
      bSave.disabled = !gate.ok; bTry.disabled = !gate.ok;
    }
    function show(gate) {
      var lines = gate.failures.slice(0, 5).map(function (x) { return (st.mode === 'auto' ? (x.scheme === 'dark' ? 'Dark look: ' : 'Light look: ') : '') + C.explain(x.f); });
      note('bad', 'This palette cannot be saved — some text would be hard to read:', lines);
    }

    bSave.addEventListener('click', function () {
      var b = build(C, st); if (!b.gate.ok) return show(b.gate);
      bSave.disabled = true;
      saveMine(b.prefs).then(function (r) {
        bSave.disabled = false;
        if (r.ok) note('good', r.local ? 'Saved on this device.' : 'Saved to your account — it follows you to any device you sign in on.');
        else note('bad', r.refused ? 'Wren refused that palette: ' + r.message : (r.message || 'Could not save.'));
      });
    });
    bReset.addEventListener('click', function () {
      resetMine().then(function () { st = fromPrefs(activePrefs()); editScheme = st.mode === 'light' ? 'light' : 'dark'; draw(); note('good', 'Back to the Wren palette' + (readJSON(DEF_KEY) ? ' (your setting’s default)' : '') + '.'); });
    });
    bTry.addEventListener('click', function () {
      var b = build(C, st); if (!b.gate.ok) return show(b.gate);
      clearTimeout(previewTimer); applyPrefs(b.prefs);
      var left = 10; bTry.textContent = 'Reverting in ' + left + 's — tap to revert now';
      var tick = function () { left--; if (left <= 0) return stop(); bTry.textContent = 'Reverting in ' + left + 's — tap to revert now'; previewTimer = setTimeout(tick, 1000); };
      var stop = function () { clearTimeout(previewTimer); previewTimer = null; applySaved(); bTry.textContent = 'Try it on this page'; bTry.removeEventListener('click', stopOnce); };
      var stopOnce = function () { if (previewTimer) stop(); };
      previewTimer = setTimeout(tick, 1000); setTimeout(function () { bTry.addEventListener('click', stopOnce); }, 50);
    });

    function fromPrefs(p) {
      var s = { mode: 'auto', palette: 'wren', ov: { dark: {}, light: {} } };
      if (p) { s.mode = p.mode || 'auto'; s.palette = FAM[p.palette] ? p.palette : 'wren'; s.ov = { dark: Object.assign({}, p.ov && p.ov.dark), light: Object.assign({}, p.ov && p.ov.light) }; }
      // nothing chosen yet: start from what is on screen, so "Auto" does not surprise a dark-mode Roost user
      else s.mode = document.documentElement.getAttribute('data-wren-theme') ? 'auto' : 'dark';
      return s;
    }
    needC().then(function (lib) {
      C = lib; st = fromPrefs(activePrefs()); editScheme = st.mode === 'light' ? 'light' : (st.mode === 'dark' ? 'dark' : (schemeOf({ mode: 'auto' })));
      paintMgr(); draw();
    }).catch(function () { note('bad', 'The colour checker did not load, so nothing can be saved right now. Reload the page and try again.'); bSave.disabled = true; bTry.disabled = true; });
    STATE = root;
    return root;
  }

  var overlay = null;
  function open() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', open, { once: true }); return; }
    injectStyle();
    if (overlay) overlay.parentNode.removeChild(overlay);
    overlay = el('div', { class: 'wtx-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Appearance' });
    var x = el('button', { class: 'wtx-x', type: 'button', 'aria-label': 'Close', text: '×' });
    x.addEventListener('click', close);
    var sheet = el('div', { class: 'wtx-sheet' }, [el('div', { class: 'wtx-head' }, [el('h3', { text: 'Appearance' }), x]), panel()]);
    overlay.appendChild(sheet);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape' && overlay && overlay.classList.contains('open')) { close(); document.removeEventListener('keydown', esc); } });
    document.body.appendChild(overlay); overlay.classList.add('open');
  }
  function close() { if (overlay) overlay.classList.remove('open'); }
  function mount(target) { if (!target) return null; target.textContent = ''; var p = panel(); target.appendChild(p); return p; }

  /* ── public API (the old names keep working) ───────────────────────────────────────────────── */
  window.WrenTheme = {
    portal: PORTAL === 'ey' ? 'ey' : 'roost',
    open: open, close: close, mount: mount,
    apply: function (p) { if (p && p.v === 2) applyPrefs(p); },
    applySaved: applySaved,
    reset: function () { return resetMine(); },
    current: activePrefs,
    sync: sync, gate: function (st) { return needC().then(function (C) { return build(C, st); }); }
  };

  /* colour-ok-begin: the pre-b351 parents editor, kept verbatim until the parents pages move to the shared tokens (NOTES §Parents) */
  function legacyParents() {
  var STORE_KEY = 'wren.theme';

  /* ── Portal detection ───────────────────────────────────────────────────── */
  function detectPortal() {
    var host = location.hostname || '';
    var p = location.pathname || '';
    if (host.indexOf('parents.') === 0) return 'parents';
    if (p === '/welcome' || p.indexOf('/welcome') === 0) return 'parents';
    if (p.indexOf('/ey') === 0) return 'ey';
    if (document.body && document.body.getAttribute('data-portal') === 'ey') return 'ey';
    // b297 — HR is the --c-* variable family, same as EY, NOT the parents
    // green/cream one. Named explicitly rather than left to the CSS sniff below:
    // this file is a synchronous <script> in each page's <head>, so wren.css may
    // not have applied yet when the sniff runs, and guessing 'parents' would have
    // written --green/--cream onto a portal that reads neither.
    if (host.indexOf('hr.') === 0) return 'ey';
    if (document.body && document.body.getAttribute('data-portal') === 'hr') return 'ey';
    // Fallback: sniff a defining CSS var.
    try {
      var rs = getComputedStyle(document.documentElement);
      if (rs.getPropertyValue('--c-bg').trim()) return 'ey';
      if (rs.getPropertyValue('--green').trim()) return 'parents';
    } catch (e) {}
    return 'parents';
  }
  var PORTAL = detectPortal();

  /* ── Colour helpers ─────────────────────────────────────────────────────── */
  function clamp(n) { return Math.max(0, Math.min(255, Math.round(n))); }
  function toRGB(hex) {
    if (!hex) return { r: 0, g: 0, b: 0 };
    hex = String(hex).trim().replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(hex, 16);
    if (isNaN(n)) return { r: 0, g: 0, b: 0 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function toHex(rgb) {
    return '#' + [rgb.r, rgb.g, rgb.b].map(function (v) {
      var s = clamp(v).toString(16); return s.length === 1 ? '0' + s : s;
    }).join('');
  }
  function mix(a, b, t) {               // t=0 -> a, t=1 -> b
    var x = toRGB(a), y = toRGB(b);
    return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
  }
  function darken(hex, t) { return mix(hex, '#000000', t); }
  function lighten(hex, t) { return mix(hex, '#ffffff', t); }
  function rgba(hex, a) { var c = toRGB(hex); return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')'; }
  function luminance(hex) {              // perceived brightness 0..255
    var c = toRGB(hex); return 0.2126 * c.r + 0.7152 * c.g + 0.114 * c.b;
  }
  function isDark(hex) { return luminance(hex) < 128; }
  // A muted/dim text colour that sits between text and background.
  function muted(text, bg) { return mix(text, bg, 0.42); }
  // A subtle surface: nudge the background toward the text a touch.
  function surface(bg, text, t) { return mix(bg, text, t); }

  /* ── Presets: portal-agnostic {bg, text, accent} ────────────────────────── */
  var PRESETS = {
    parents: { label: 'Classic green', bg: '#fefcf8', text: '#2a2a2a', accent: '#2d5a4a' },
    ey:      { label: 'Wren dark',     bg: '#080f1e', text: '#eaf0ff', accent: '#f0c34a' }
  };
  var PRESET_LIST = [
    { key: 'default',   label: '',                bg: null,      text: null,      accent: null },   // filled per-portal below
    { key: 'green',     label: 'Classic green',   bg: '#fefcf8', text: '#2a2a2a', accent: '#2d5a4a' },
    { key: 'neutral',   label: 'Calm neutral',    bg: '#f5f3ee', text: '#33302b', accent: '#7d8471' },
    { key: 'contrast',  label: 'High contrast',   bg: '#ffffff', text: '#111111', accent: '#0047ab' },
    { key: 'pastel',    label: 'Soft pastel',     bg: '#fdf5fb', text: '#4a3f52', accent: '#c07bb0' },
    { key: 'dark',      label: 'Dark',            bg: '#0f1622', text: '#e9eefc', accent: '#f2a34d' }
  ];

  function defaultTheme() {
    var d = PRESETS[PORTAL];
    return { bg: d.bg, text: d.text, accent: d.accent };
  }

  /* ── Apply a theme by writing CSS custom properties on :root ─────────────── */
  function setVar(name, val) {
    try { document.documentElement.style.setProperty(name, val); } catch (e) {}
  }

  function applyParents(t) {
    var bg = t.bg, text = t.text, accent = t.accent;
    // Secondary accent (orange) — keep a warm complementary derived from accent
    // when the accent is coolish; otherwise derive a lighter warm tint.
    var accent2 = '#f0a050';
    // Welcome-page inline vars
    setVar('--green',   accent);
    setVar('--green-d', darken(accent, 0.28));
    setVar('--green-l', lighten(accent, 0.22));
    setVar('--orange',  accent2);
    setVar('--orange-d', darken(accent2, 0.18));
    setVar('--cream',   bg);
    setVar('--cream-d', mix(bg, text, 0.06));
    setVar('--text',    text);
    setVar('--text-m',  muted(text, bg));
    setVar('--border',  mix(bg, text, 0.14));
    // nginx-injected parents-theme.css vars (prod legacy shell) — belt & braces
    setVar('--navy',    accent);
    setVar('--blue',    accent);
    setVar('--surface', isDark(bg) ? surface(bg, text, 0.08) : '#ffffff');
    setVar('--muted',   muted(text, bg));
    setVar('--success', accent);
    // b297 — the parents pages paint their cards with var(--surface, #fff) and
    // their info panels with var(--lap-tint-*). Both need to know whether the
    // chosen background is dark, and CSS cannot ask. One class on <html>, which
    // parents-app.css keys the whole dark palette off.
    try { document.documentElement.classList.toggle('lap-dark', isDark(bg)); } catch (e) {}
    // Ink for anything painted ON the accent (the topbar, the tab bar). A pale
    // accent — which is exactly what the built-in 'Dark' preset uses — cannot
    // carry white text; see pwa.js for the same calculation pre-paint.
    setVar('--lap-on-accent', isDark(accent) ? '#ffffff' : '#1c1508');
    // PWA status-bar colour
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', accent);
  }

  function applyEY(t) {
    var bg = t.bg, text = t.text, accent = t.accent;
    var dark = isDark(bg);
    // Background family
    setVar('--c-bg',         bg);
    setVar('--c-navy',       bg);
    setVar('--c-navy-mid',   dark ? lighten(bg, 0.05) : darken(bg, 0.04));
    setVar('--c-navy-light', dark ? lighten(bg, 0.12) : darken(bg, 0.10));
    setVar('--c-surface',    rgba(surface(bg, text, 0.08), 0.85));
    setVar('--c-card',       rgba(surface(bg, text, 0.08), 0.85));
    // Text family
    setVar('--c-text',       text);
    setVar('--c-muted',      muted(text, bg));
    setVar('--c-text-muted', muted(text, bg));
    setVar('--c-text-dim',   muted(text, bg));
    setVar('--c-border',     rgba(text, dark ? 0.12 : 0.16));
    // Accent — drives active tabs, buttons, links (blue + orange unified)
    setVar('--c-orange',      accent);
    setVar('--c-orange-dark', darken(accent, 0.18));
    setVar('--c-orange-light', lighten(accent, 0.60));
    setVar('--c-blue',        accent);
    setVar('--c-blue-dark',   darken(accent, 0.18));
    setVar('--c-blue-light',  lighten(accent, 0.55));
    // b297 — the three status hues are deliberately NOT aliases of the accent:
    // green/amber/red carry a judgement the accent must not overwrite. But their
    // dark-theme values (#34d399 / #fbbf24 / #f87171) are chosen to sit on navy,
    // and on a light background amber lands around 1.9:1 — the "62 unread
    // policies" figure on the HR dashboard was effectively unreadable the moment
    // a light preset was picked. Same hue, darkened until it clears 4.5:1 on
    // white; the dark theme keeps the values wren.css already ships.
    if (dark) {
      setVar('--c-green', '#34d399'); setVar('--c-amber', '#fbbf24'); setVar('--c-red', '#f87171');
    } else {
      setVar('--c-green', '#047857'); setVar('--c-amber', '#a16207'); setVar('--c-red', '#b91c1c');
    }
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', bg);
  }

  function apply(t) {
    if (!t) return;
    if (PORTAL === 'ey') applyEY(t); else applyParents(t);
  }

  /* ── Persistence ────────────────────────────────────────────────────────── */
  function current() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (o && o.bg && o.text && o.accent) return o;
    } catch (e) {}
    return null;
  }
  function save(t) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ bg: t.bg, text: t.text, accent: t.accent, preset: t.preset || null, v: 1 })); } catch (e) {}
  }
  function applySaved() { var t = current(); if (t) apply(t); }
  function reset() {
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    // Clear inline overrides so the stylesheet defaults win again.
    var names = ['--green', '--green-d', '--green-l', '--orange', '--orange-d', '--cream',
      '--cream-d', '--text', '--text-m', '--border', '--navy', '--blue', '--surface',
      '--muted', '--success', '--c-bg', '--c-navy', '--c-navy-mid', '--c-navy-light',
      '--c-surface', '--c-card', '--c-text', '--c-muted', '--c-text-muted', '--c-text-dim',
      '--c-border', '--c-orange', '--c-orange-dark', '--c-orange-light', '--c-blue',
      '--c-blue-dark', '--c-blue-light'];
    names.forEach(function (n) { try { document.documentElement.style.removeProperty(n); } catch (e) {} });
  }

  /* ── Apply immediately (before paint where the script is synchronous) ────── */
  applySaved();

  /* ── Editor UI ──────────────────────────────────────────────────────────── */
  var overlay = null;

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'style') e.style.cssText = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { e.appendChild(c); });
    return e;
  }

  function injectStyle() {
    if (document.getElementById('wren-theme-css')) return;
    var s = document.createElement('style');
    s.id = 'wren-theme-css';
    s.textContent = [
      '.wt-ov{position:fixed;inset:0;z-index:100000;display:none;background:rgba(10,15,25,.55);',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif}',
      '.wt-ov.wt-open{display:flex;align-items:flex-end;justify-content:center}',
      '@media(min-width:640px){.wt-ov.wt-open{align-items:center}}',
      '.wt-card{background:#ffffff;color:#1a2230;width:100%;max-width:440px;max-height:90vh;overflow-y:auto;',
        'border-radius:18px 18px 0 0;box-shadow:0 -8px 40px rgba(0,0,0,.35);padding:18px 18px calc(20px + env(safe-area-inset-bottom,0px))}',
      '@media(min-width:640px){.wt-card{border-radius:18px}}',
      '.wt-grip{width:40px;height:4px;background:#d8dae0;border-radius:3px;margin:2px auto 14px}',
      '.wt-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}',
      '.wt-title{font-size:1.15rem;font-weight:800;margin:0}',
      '.wt-sub{font-size:.82rem;color:#68707e;margin:0 0 16px}',
      '.wt-x{background:none;border:none;font-size:1.5rem;line-height:1;color:#8a92a0;cursor:pointer;padding:2px 6px;border-radius:8px}',
      '.wt-x:hover{background:#f0f1f4}',
      '.wt-sec{font-size:.72rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#8a92a0;margin:16px 0 8px}',
      '.wt-presets{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}',
      '.wt-preset{display:flex;flex-direction:column;align-items:center;gap:6px;border:1px solid #e4e6ec;background:#fafbfc;',
        'border-radius:12px;padding:10px 6px;cursor:pointer;font:600 .72rem/1.2 inherit;color:#3a4250;text-align:center;transition:.12s}',
      '.wt-preset:hover{border-color:#b9c0cc;transform:translateY(-1px)}',
      '.wt-preset.wt-active{border-color:#2d5a4a;box-shadow:0 0 0 2px rgba(45,90,74,.18)}',
      '.wt-swatch{display:flex;gap:2px}',
      '.wt-swatch i{width:16px;height:16px;border-radius:5px;display:block;border:1px solid rgba(0,0,0,.08)}',
      '.wt-rows{border:1px solid #e4e6ec;border-radius:14px;overflow:hidden}',
      '.wt-row{display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid #eef0f3}',
      '.wt-row:last-child{border-bottom:none}',
      '.wt-row-body{flex:1;min-width:0}',
      '.wt-row-label{font-size:.9rem;font-weight:700;color:#1a2230}',
      '.wt-row-desc{font-size:.76rem;color:#78808e;margin-top:1px}',
      '.wt-color{width:46px;height:34px;padding:0;border:1px solid #d5d8e0;border-radius:9px;background:none;cursor:pointer;flex-shrink:0}',
      '.wt-color::-webkit-color-swatch-wrapper{padding:2px}',
      '.wt-color::-webkit-color-swatch{border:none;border-radius:6px}',
      '.wt-actions{display:flex;gap:10px;margin-top:18px}',
      '.wt-btn{flex:1;border:none;border-radius:11px;padding:13px;font:700 .9rem inherit;cursor:pointer;min-height:46px}',
      '.wt-btn-primary{background:#2d5a4a;color:#fff}',
      '.wt-btn-ghost{background:#f0f1f4;color:#3a4250}',
      '.wt-prev{margin-top:14px;border-radius:12px;overflow:hidden;border:1px solid #e4e6ec}',
      '.wt-prev-top{padding:12px 14px;font-weight:800}',
      '.wt-prev-body{padding:14px}',
      '.wt-prev-btn{display:inline-block;border-radius:9px;padding:8px 16px;font-weight:700;font-size:.85rem}'
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }

  var pickers = {};

  function readPickers() {
    return { bg: pickers.bg.value, text: pickers.text.value, accent: pickers.accent.value };
  }

  function refreshPreview() {
    var t = readPickers();
    var prevTop = document.getElementById('wt-prev-top');
    var prevBody = document.getElementById('wt-prev-body');
    var prevBtn = document.getElementById('wt-prev-btn');
    if (prevTop) { prevTop.style.background = t.accent; prevTop.style.color = isDark(t.accent) ? '#fff' : '#1a1a1a'; }
    if (prevBody) { prevBody.style.background = t.bg; prevBody.style.color = t.text; }
    if (prevBtn) { prevBtn.style.background = t.accent; prevBtn.style.color = isDark(t.accent) ? '#fff' : '#1a1a1a'; }
  }

  function markActivePreset(key) {
    Array.prototype.forEach.call(document.querySelectorAll('.wt-preset'), function (b) {
      b.classList.toggle('wt-active', b.getAttribute('data-key') === key);
    });
  }

  function liveApply(preset) {
    var t = readPickers();
    t.preset = preset || null;
    apply(t);
    save(t);
    refreshPreview();
  }

  function build() {
    injectStyle();
    if (overlay) return overlay;

    overlay = el('div', { class: 'wt-ov', id: 'wren-theme-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Theme editor' });
    var card = el('div', { class: 'wt-card' });
    card.appendChild(el('div', { class: 'wt-grip' }));

    var head = el('div', { class: 'wt-head' });
    head.appendChild(el('h3', { class: 'wt-title', text: 'Appearance' }));
    var x = el('button', { class: 'wt-x', 'aria-label': 'Close', text: '×' });
    x.addEventListener('click', close);
    head.appendChild(x);
    card.appendChild(head);
    card.appendChild(el('p', { class: 'wt-sub', text: 'Pick your colours — the page updates as you go. Your choice is saved on this device.' }));

    // Presets
    card.appendChild(el('div', { class: 'wt-sec', text: 'Quick themes' }));
    var grid = el('div', { class: 'wt-presets' });
    var list = PRESET_LIST.map(function (p) {
      if (p.key === 'default') {
        var d = PRESETS[PORTAL];
        return { key: 'default', label: 'Default', bg: d.bg, text: d.text, accent: d.accent };
      }
      return p;
    });
    list.forEach(function (p) {
      var b = el('button', { class: 'wt-preset', type: 'button', 'data-key': p.key });
      var sw = el('div', { class: 'wt-swatch' });
      [p.bg, p.text, p.accent].forEach(function (c) { var i = el('i'); i.style.background = c; sw.appendChild(i); });
      b.appendChild(sw);
      b.appendChild(el('span', { text: p.label }));
      b.addEventListener('click', function () {
        pickers.bg.value = p.bg; pickers.text.value = p.text; pickers.accent.value = p.accent;
        markActivePreset(p.key);
        liveApply(p.key);
      });
      grid.appendChild(b);
    });
    card.appendChild(grid);

    // Colour rows
    card.appendChild(el('div', { class: 'wt-sec', text: 'Fine-tune' }));
    var rows = el('div', { class: 'wt-rows' });
    var defs = [
      { key: 'bg',     label: 'Background',      desc: 'Page background' },
      { key: 'text',   label: 'Text',            desc: 'Main text colour' },
      { key: 'accent', label: 'Accent',          desc: 'Buttons, headers, highlights' }
    ];
    defs.forEach(function (d) {
      var row = el('div', { class: 'wt-row' });
      var body = el('div', { class: 'wt-row-body' });
      body.appendChild(el('div', { class: 'wt-row-label', text: d.label }));
      body.appendChild(el('div', { class: 'wt-row-desc', text: d.desc }));
      row.appendChild(body);
      var input = el('input', { class: 'wt-color', type: 'color', 'aria-label': d.label });
      pickers[d.key] = input;
      input.addEventListener('input', function () { markActivePreset(null); liveApply(null); });
      row.appendChild(input);
      rows.appendChild(row);
    });
    card.appendChild(rows);

    // Live preview
    var prev = el('div', { class: 'wt-prev' });
    // b297 — the preview strip showed a hardcoded 'Your Nursery' on every
    // tenant's theme editor. The page title is the setting's own, and this is
    // only sample text for a colour swatch.
    var _brand = (document.title || '').split(/[—–|]/)[0].trim() || 'Your setting';
    var pt = el('div', { class: 'wt-prev-top', id: 'wt-prev-top', text: _brand.slice(0, 28) });
    var pb = el('div', { class: 'wt-prev-body', id: 'wt-prev-body' });
    pb.appendChild(el('div', { style: 'margin-bottom:10px;font-weight:700', text: 'Preview' }));
    pb.appendChild(el('span', { class: 'wt-prev-btn', id: 'wt-prev-btn', text: 'Button' }));
    prev.appendChild(pt); prev.appendChild(pb);
    card.appendChild(prev);

    // Actions
    var actions = el('div', { class: 'wt-actions' });
    var resetBtn = el('button', { class: 'wt-btn wt-btn-ghost', type: 'button', text: 'Reset to default' });
    resetBtn.addEventListener('click', function () {
      reset();
      var d = PRESETS[PORTAL];
      pickers.bg.value = d.bg; pickers.text.value = d.text; pickers.accent.value = d.accent;
      markActivePreset('default');
      refreshPreview();
    });
    var doneBtn = el('button', { class: 'wt-btn wt-btn-primary', type: 'button', text: 'Done' });
    doneBtn.addEventListener('click', close);
    actions.appendChild(resetBtn); actions.appendChild(doneBtn);
    card.appendChild(actions);

    overlay.appendChild(card);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay && overlay.classList.contains('wt-open')) close(); });
    (document.body || document.documentElement).appendChild(overlay);
    return overlay;
  }

  function open() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', open, { once: true }); return; }
    build();
    var t = current() || defaultTheme();
    pickers.bg.value = t.bg; pickers.text.value = t.text; pickers.accent.value = t.accent;
    markActivePreset(t.preset || (current() ? null : 'default'));
    refreshPreview();
    overlay.classList.add('wt-open');
  }
  function close() { if (overlay) overlay.classList.remove('wt-open'); }

  /* ── Public API ─────────────────────────────────────────────────────────── */
  window.WrenTheme = {
    portal: PORTAL,
    open: open,
    close: close,
    apply: apply,
    applySaved: applySaved,
    reset: function () { reset(); },
    current: current
  };
  }
  /* colour-ok-end */
})();
