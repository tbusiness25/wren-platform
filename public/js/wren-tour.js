// Wren guided tour — generic, config-driven onboarding walkthrough (rewritten
// 2026-07-16 from the admin-only sidebar walk into a reusable spotlight engine).
//
// One engine serves every portal. Each portal registers a step list against a
// key (portalKey(): admin→'roost', otherwise Wren.edition — 'hr','eyfs','ladn',
// 'parents'…). A step spotlights a real element by selector, shows a titled card
// with Next / Back / Skip, a step counter and a "don't show again" control.
//
// Public API (window.WrenTour):
//   register(key, stepsOrFn)  — stepsOrFn: array, or a fn() returning an array
//                               (evaluated at start time, so it can read the live DOM)
//   start(key, {force})       — run the tour; force ignores the done flag
//   available(key)            — is a config registered for this key?
//   isDone(key) / reset(key)  — persistence helpers
//   portalKey()               — the current portal's key
//
// Persistence: localStorage 'wren.tour.<key>.done' (per portal). For back-compat
// the legacy 'wrenTourPending' / 'wrenTourDone' flags (set by setup.js and the
// System → "Take the tour" card, which points at /app.html#tour) still trigger
// and record the 'roost' tour.
//
// Step shape:
//   { sel:'CSS'|el|fn, title:'…', body:'html', nav:'data-section',
//     center:true, optional:true }
//   - sel/el/fn: element to spotlight. Omit (or center:true) for a centred card.
//   - nav: admin-SPA convenience — clicks the sidebar [data-section] button first.
//   - a step whose target is missing or hidden is skipped automatically (so a
//     switched-off module, or a manager-only card, never dead-ends the tour).
;(function () {
  'use strict';
  if (window.self !== window.top) return; // never run inside an embedded iframe

  // ── Portal detection ─────────────────────────────────────────────────────────
  function portalKey() {
    const ed = (window.Wren && Wren.edition)
      || (document.querySelector('meta[name="wren-edition"]') || {}).content || '';
    if (ed === 'admin' || window.WREN_SECTIONS) return 'roost';
    // b201: the parents portal (/welcome/*) has no wren shell and therefore no
    // edition meta — detect it by path/host so it gets a tour like the rest.
    if (/^\/welcome(\/|$)/.test(location.pathname) || /^parents\./.test(location.hostname)) return 'parents';
    if (!ed && /^\/ey\//.test(location.pathname)) return 'ey';
    return ed || 'unknown';
  }
  // 'ladn' is the EY portal's edition string; the corpus keys it as 'ey'.
  function contentKey(k) { return (k === 'ladn') ? 'ey' : k; }

  // ── Persistence ──────────────────────────────────────────────────────────────
  const doneKey  = k => 'wren.tour.' + k + '.done';
  const offerKey = k => 'wren.tour.' + k + '.offered';
  function isDone(k) { try { return localStorage.getItem(doneKey(k)) === '1'; } catch (e) { return false; } }
  function markDone(k) {
    try { localStorage.setItem(doneKey(k), '1'); } catch (e) {}
    if (k === 'roost') { try { localStorage.setItem('wrenTourDone', '1'); localStorage.removeItem('wrenTourPending'); } catch (e) {} }
  }
  function reset(k) {
    try { localStorage.removeItem(doneKey(k)); } catch (e) {}
    if (k === 'roost') { try { localStorage.removeItem('wrenTourDone'); } catch (e) {} }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // b201 — corpus, tracks, cross-page resume, per-staff progress
  // ═══════════════════════════════════════════════════════════════════════════
  // The step CONTENT lives in wren-tour-content.js (411 entries covering every
  // page and every tab across Roost / Nest / Finch / Seed). This engine turns an
  // entry into a spotlight step, walks a named TRACK, survives full page loads,
  // and records progress against the signed-in staff id so a long track resumes.
  const CONTENT_SRC = '/js/wren-tour-content.js?v=b201';
  const RUN_KEY = 'wren.tour.run';          // sessionStorage: the in-flight walk
  const PROG_KEY = 'wren.tour.progress';    // localStorage: offline mirror of the API

  function content() { return window.WrenTourContent || null; }

  function loadContent(cb) {
    if (content()) return cb(content());
    let sc = document.querySelector('script[data-wren-tour-content]');
    if (!sc) {
      sc = document.createElement('script');
      sc.src = CONTENT_SRC;
      sc.setAttribute('data-wren-tour-content', '1');
      document.head.appendChild(sc);
    }
    let n = 0;
    const iv = setInterval(() => {
      if (content()) { clearInterval(iv); cb(content()); }
      else if (++n > 60) { clearInterval(iv); cb(null); }
    }, 60);
  }

  // ── Rendering one corpus entry ───────────────────────────────────────────────
  function bodyFor(step) {
    let html = '';
    if (step.status && step.status !== 'ok') {
      html += '<span class="wtour-flag wtour-flag-' + step.status + '">'
        + (step.status === 'broken' ? '⚠️ Known issue' : '⚠️ Partly broken')
        + '</span><span class="wtour-issue">' + (step.issue || '') + '</span>';
    }
    html += '<b>What it\u2019s for:</b> ' + (step.what || '')
         + '<br><b>You\u2019ll usually:</b> ' + (step.does || '')
         + '<br><b>Watch out:</b> ' + (step.gotcha || '');
    return html;
  }

  function toStep(entry) {
    return {
      id: entry.id, title: entry.title, body: bodyFor(entry),
      sel: entry.sel, nav: entry.nav, tab: entry.tab,
      url: entry.url, portal: entry.portal, status: entry.status,
    };
  }

  // ── Track resolution ─────────────────────────────────────────────────────────
  function tracksFor(key) {
    const C = content(); if (!C) return [];
    return C.tracksFor(contentKey(key)) || [];
  }
  function trackSteps(key, trackId) {
    const C = content(); if (!C) return [];
    return (C.stepsFor(contentKey(key), trackId) || []).map(toStep);
  }
  function defaultTrack(key) {
    const t = tracksFor(key);
    return t.length ? t[0].id : 'everything';
  }

  // ── Cross-page run state ─────────────────────────────────────────────────────
  // A 276-step Roost track spans real page loads. The run is parked in
  // sessionStorage before navigating and picked up again by boot().
  function saveRun(run) { try { sessionStorage.setItem(RUN_KEY, JSON.stringify(run)); } catch (e) {} }
  function readRun() { try { return JSON.parse(sessionStorage.getItem(RUN_KEY) || 'null'); } catch (e) { return null; } }
  function clearRun() { try { sessionStorage.removeItem(RUN_KEY); } catch (e) {} }

  // ── Progress (per staff member, server-backed, localStorage mirror) ──────────
  function localProgress() {
    try { return JSON.parse(localStorage.getItem(PROG_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveLocalProgress(key, track, patch) {
    const all = localProgress();
    const k = key + '::' + track;
    all[k] = Object.assign({ portal: key, track: track, completed_steps: [] }, all[k], patch);
    try { localStorage.setItem(PROG_KEY, JSON.stringify(all)); } catch (e) {}
    return all[k];
  }
  function getLocalProgress(key, track) { return localProgress()[key + '::' + track] || null; }

  function api(url, opts) {
    // Reuse the shell's authenticated fetch when present; otherwise plain fetch
    // (the parents portal has no Wren.api and no staff session — it falls back
    // to localStorage-only progress, which is the correct behaviour there).
    if (window.Wren && typeof Wren.api === 'function') return Wren.api(url, opts);
    // 2026-10-08: the plain fetch below carries no token, so on the parents portal it
    // only ever produced a 401 (~36 a day in the logs). Progress there is localStorage-only
    // by design — don't ask the server at all.
    if (/^\/api\/tour\//.test(url)) return Promise.reject(new Error('no staff session'));
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    return fetch(url, opts).then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))));
  }

  let _progressCache = null;
  function fetchProgress() {
    if (_progressCache) return Promise.resolve(_progressCache);
    return api('/api/tour/progress')
      .then(d => { _progressCache = (d && d.entries) || []; return _progressCache; })
      .catch(() => { _progressCache = []; return _progressCache; });
  }
  function serverProgress(key, track) {
    return (_progressCache || []).find(e => e.portal === contentKey(key) && e.track === track) || null;
  }
  function pushProgress(key, track, patch) {
    saveLocalProgress(contentKey(key), track, patch);
    const body = Object.assign({ portal: contentKey(key), track: track }, patch);
    return api('/api/tour/progress', { method: 'POST', body: body })
      .then(d => { if (d && d.entry) { _progressCache = null; } return d; })
      .catch(() => null);   // offline / no staff session — the local mirror stands
  }

  // ── Config registry ──────────────────────────────────────────────────────────
  const registry = {};
  function register(key, stepsOrFn) { registry[key] = stepsOrFn; }
  function available(key) { return !!registry[key]; }
  function resolveSteps(key) {
    const cfg = registry[key];
    const arr = typeof cfg === 'function' ? cfg() : cfg;
    return Array.isArray(arr) ? arr.slice() : [];
  }

  // ── Element resolution ───────────────────────────────────────────────────────
  function stepEl(step) {
    if (!step) return null;
    if (step.el instanceof Element) return step.el;
    if (typeof step.sel === 'function') { try { return step.sel(); } catch (e) { return null; } }
    if (typeof step.sel === 'string') return document.querySelector(step.sel);
    return null;
  }
  function visible(el) { return el && el.offsetParent !== null && el.getClientRects().length > 0; }

  // ── Styles ───────────────────────────────────────────────────────────────────
  function css() {
    if (document.getElementById('wtour-css')) return;
    const s = document.createElement('style');
    s.id = 'wtour-css';
    s.textContent = `
#wtour-spot{position:fixed;z-index:9490;border-radius:12px;pointer-events:none;
  box-shadow:0 0 0 9999px rgba(2,8,20,.62);transition:all .22s cubic-bezier(.4,0,.2,1);
  outline:3px solid #4a9abf;outline-offset:0}
#wtour-spot.no-target{box-shadow:0 0 0 9999px rgba(2,8,20,.62);outline:none;width:0;height:0}
#wtour-card{position:fixed;z-index:9500;width:min(420px,calc(100vw - 28px));
  background:#0f172a;color:#f1f5f9;border:1px solid #4a9abf;border-radius:16px;padding:18px;
  box-shadow:0 12px 44px rgba(0,0,0,.55);transition:top .2s ease,left .2s ease}
#wtour-card h3{margin:0 0 6px;font-size:1.05rem;line-height:1.25}
#wtour-card p{margin:0 0 12px;font-size:.88rem;color:#cbd5e1;line-height:1.45}
.wtour-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.wtour-btn{padding:8px 15px;border-radius:10px;border:1px solid #334155;background:transparent;
  color:#cbd5e1;cursor:pointer;font-size:.85rem;font-family:inherit}
.wtour-btn:hover{border-color:#4a9abf;color:#fff}
.wtour-btn.primary{background:#4a9abf;border-color:#4a9abf;color:#04101c;font-weight:700}
.wtour-btn:disabled{opacity:.4;cursor:default}
.wtour-prog{margin-left:auto;font-size:.75rem;color:#64748b;font-variant-numeric:tabular-nums}
.wtour-dsa{display:flex;align-items:center;gap:6px;margin-top:11px;font-size:.75rem;color:#94a3b8;cursor:pointer}
.wtour-dsa input{cursor:pointer}
#wtour-offer{position:fixed;bottom:22px;right:22px;z-index:9490;width:min(320px,calc(100vw - 28px));
  background:#0f172a;color:#f1f5f9;border:1px solid #4a9abf;border-radius:14px;padding:16px;
  box-shadow:0 12px 40px rgba(0,0,0,.5)}
#wtour-offer h4{margin:0 0 5px;font-size:.96rem}
#wtour-offer p{margin:0 0 12px;font-size:.82rem;color:#cbd5e1;line-height:1.4}
#wren-help-btn .wren-help-ico{font-size:1.05rem;line-height:1}
#wtour-help-menu{position:fixed;background:#0f172a;border:1px solid #334155;border-radius:12px;
  box-shadow:0 8px 28px rgba(0,0,0,.5);padding:7px;z-index:9600;min-width:196px}
#wtour-help-menu button{display:flex;align-items:center;gap:9px;width:100%;text-align:left;
  background:none;border:none;color:#e2e8f0;font-family:inherit;font-size:.85rem;padding:9px 11px;
  border-radius:8px;cursor:pointer}
#wtour-help-menu button:hover{background:rgba(74,154,191,.14)}
/* b201 — honesty flags, track name, track chooser */
.wtour-flag{display:inline-block;font-size:.68rem;font-weight:700;letter-spacing:.03em;text-transform:uppercase;
  padding:2px 7px;border-radius:99px;margin-bottom:7px}
.wtour-flag-broken{background:#7f1d1d;color:#fecaca}
.wtour-flag-partial{background:#78350f;color:#fde68a}
.wtour-issue{display:block;font-size:.78rem;color:#fca5a5;line-height:1.4;margin:0 0 9px;
  border-left:2px solid #7f1d1d;padding-left:8px}
.wtour-track{display:block;font-size:.7rem;color:#64748b;letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px}
.wtour-where{display:block;font-size:.72rem;color:#7dd3fc;margin:-6px 0 10px;word-break:break-all}
#wtour-pick{position:fixed;inset:0;z-index:9600;display:flex;align-items:center;justify-content:center;
  background:rgba(2,8,20,.72);padding:16px}
#wtour-pick-box{background:#0f172a;color:#f1f5f9;border:1px solid #4a9abf;border-radius:16px;padding:20px;
  width:min(520px,100%);max-height:min(78vh,720px);overflow:auto;box-shadow:0 16px 52px rgba(0,0,0,.6)}
#wtour-pick-box h3{margin:0 0 4px;font-size:1.1rem}
#wtour-pick-box .wtour-sub{margin:0 0 14px;font-size:.82rem;color:#94a3b8}
.wtour-track-btn{display:block;width:100%;text-align:left;background:rgba(74,154,191,.08);border:1px solid #334155;
  border-radius:12px;padding:12px 13px;margin-bottom:9px;color:#e2e8f0;font-family:inherit;cursor:pointer}
.wtour-track-btn:hover{border-color:#4a9abf;background:rgba(74,154,191,.16)}
.wtour-track-btn .tt{display:block;font-weight:700;font-size:.92rem;margin-bottom:2px}
.wtour-track-btn .tb{display:block;font-size:.78rem;color:#94a3b8;line-height:1.4}
.wtour-track-btn .tp{display:block;font-size:.74rem;color:#4ade80;margin-top:5px}
.wtour-bar{height:4px;border-radius:99px;background:#1e293b;margin-top:6px;overflow:hidden}
.wtour-bar i{display:block;height:100%;background:#4a9abf}
@media (prefers-reduced-motion: reduce){#wtour-spot,#wtour-card{transition:none}}`;
    document.head.appendChild(s);
  }

  // ── Runner ───────────────────────────────────────────────────────────────────
  let active = null; // { key, steps, idx, spot, card, onKey, onResize, prevFocus }

  function positionSpot(el) {
    const spot = active.spot, card = active.card;
    if (!el) {
      spot.className = 'no-target';
      spot.style.top = '50%'; spot.style.left = '50%';
      spot.style.width = '0'; spot.style.height = '0';
      card.style.top = '50%'; card.style.left = '50%';
      card.style.transform = 'translate(-50%,-50%)';
      return;
    }
    spot.className = '';
    const r = el.getBoundingClientRect();
    const pad = 6;
    const top = Math.max(4, r.top - pad), left = Math.max(4, r.left - pad);
    const w = Math.min(window.innerWidth - left - 4, r.width + pad * 2);
    const h = Math.min(window.innerHeight - top - 4, r.height + pad * 2);
    spot.style.top = top + 'px'; spot.style.left = left + 'px';
    spot.style.width = w + 'px'; spot.style.height = h + 'px';
    // Place the card: prefer below the target, else above, else beside.
    card.style.transform = 'none';
    const ch = card.offsetHeight || 180, cw = card.offsetWidth || 380;
    let ct, cl;
    if (r.bottom + 14 + ch < window.innerHeight) ct = r.bottom + 14;
    else if (r.top - 14 - ch > 0) ct = r.top - 14 - ch;
    else ct = Math.max(10, (window.innerHeight - ch) / 2);
    cl = r.left + r.width / 2 - cw / 2;
    cl = Math.min(Math.max(10, cl), window.innerWidth - cw - 10);
    card.style.top = ct + 'px'; card.style.left = cl + 'px';
  }

  function render() {
    const { steps, idx, card } = active;
    const step = steps[idx];
    const last = idx === steps.length - 1;
    const trackLabel = active.trackLabel
      ? `<span class="wtour-track">${active.trackLabel}</span>` : '';
    const where = (step.url && active.track)
      ? `<span class="wtour-where">${step.url}</span>` : '';
    // b201: a long track is meant to be left and come back to, so "Skip" becomes
    // "Pause" once we are walking a track — it saves the position server-side.
    const stopLabel = active.track ? 'Pause' : 'Skip';
    card.innerHTML = `
      ${trackLabel}
      <h3>${step.title || ''}</h3>
      ${where}
      <p>${step.body || ''}</p>
      <div class="wtour-row">
        <button class="wtour-btn" id="wtour-back" ${idx === 0 ? 'disabled' : ''}>← Back</button>
        <button class="wtour-btn primary" id="wtour-next">${last ? 'Finish ✓' : 'Next →'}</button>
        <button class="wtour-btn" id="wtour-skip">${stopLabel}</button>
        <span class="wtour-prog">${idx + 1} / ${steps.length}</span>
      </div>
      ${active.track ? `<div class="wtour-bar"><i style="width:${Math.round(((idx + 1) / steps.length) * 100)}%"></i></div>` : ''}
      <label class="wtour-dsa"><input type="checkbox" id="wtour-dsa"> Don't show this tour again</label>`;
    card.querySelector('#wtour-next').onclick = () => go(1);
    card.querySelector('#wtour-back').onclick = () => go(-1);
    card.querySelector('#wtour-skip').onclick = () => finish(false);
    card.querySelector('#wtour-dsa').onchange = e => { active.dsa = e.target.checked; };
    setTimeout(() => { const n = card.querySelector('#wtour-next'); if (n) n.focus(); }, 30);
  }

  // b201: is this step describing a page we are not currently on?
  function needsNavigation(step) {
    if (!step || !step.url) return false;
    const C = content();
    if (!C) return false;
    const here = C.normPath(location.pathname);
    const want = C.normPath(step.url);
    if (here === want) return false;
    // A section URL is satisfied by any of its tabs: the Roost shell redirects
    // /admin/cockpit → /admin/cockpit/comms, so a strict equality check sent the
    // walk round and round that redirect instead of showing the card.
    if (here.indexOf(want + '/') === 0) return false;
    // Roost SPA tabs are reachable in-page via Wren.navigate — not a page load.
    if (step.nav && document.getElementById('section-content')) return false;
    return true;
  }

  function showStep() {
    const step = active.steps[active.idx];
    // ── Cross-page walk: park the run, then load the page this step describes.
    // boot() picks the run back up and carries on at the same index. This is what
    // makes a 276-step "Manager: everything" track possible at all.
    if (active.track && needsNavigation(step)) {
      saveRun({ key: active.key, track: active.track, idx: active.idx, dir: active._dir || 1, ts: Date.now() });
      recordStep(step);
      const dest = step.url;
      teardown();
      try { window.location.href = dest; } catch (e) {}
      return;
    }
    // Keep the parked run in step with where we actually are, so a reload (or a
    // link the user follows themselves) resumes at the right card rather than at
    // wherever the last cross-page hop happened to leave it.
    if (active.track) saveRun({ key: active.key, track: active.track, idx: active.idx, dir: active._dir || 1, ts: Date.now() });
    const proceed = () => {
      const el = stepEl(step);
      // Auto-skip a targeted step whose element is absent/hidden (disabled module,
      // manager-only card, wrong page). Centred steps (no sel) always show.
      const targeted = step.sel || step.el;
      if (targeted && !visible(el)) {
        // In a track we still want the card — the page IS the step, even when the
        // selector missed. Only the legacy static configs auto-skip. A ONE-step
        // run is contextual help ("? → Help for this page"): auto-skipping it
        // just closed the card again, which is what happened on Seed's dashboard
        // where the step's selector targets a topbar the mobile shell has not got.
        if (!active.track && active.steps.length > 1) return go(active._dir || 1, true);
      }
      const useEl = visible(el) ? el : null;
      if (useEl) try { useEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
      setTimeout(() => { positionSpot(useEl); render(); active._pos = () => positionSpot(visible(el) ? el : null); }, useEl ? 180 : 0);
      recordStep(step);
    };
    // Admin SPA: navigate to the section/tab this step describes before spotlighting.
    if (step.nav && window.Wren && typeof Wren.navigate === 'function' && document.getElementById('section-content')) {
      try { Wren.navigate(step.nav, step.tab || null); } catch (e) {}
      return setTimeout(proceed, 420);
    }
    if (step.nav) {
      const btn = document.querySelector(`.v2-section-list [data-section="${step.nav}"]`);
      if (btn) { btn.click(); return setTimeout(proceed, 340); }
    }
    proceed();
  }

  // Fire-and-forget progress write for the step just shown.
  function recordStep(step) {
    if (!active || !active.track || !step || !step.id) return;
    if (active._lastRecorded === step.id) return;
    active._lastRecorded = step.id;
    pushProgress(active.key, active.track, { step_id: step.id, completed_step: step.id });
  }

  function go(dir, autoskip) {
    active._dir = dir;
    const ni = active.idx + dir;
    if (ni < 0) { active.idx = 0; return showStep(); }
    if (ni >= active.steps.length) { if (autoskip) return finish(true); return finish(true); }
    active.idx = ni;
    showStep();
  }

  function teardown() {
    if (!active) return;
    document.removeEventListener('keydown', active.onKey, true);
    window.removeEventListener('resize', active.onScroll, true);
    window.removeEventListener('scroll', active.onScroll, true);
    if (active.spot) active.spot.remove();
    if (active.card) active.card.remove();
    if (active.prevFocus && active.prevFocus.focus) { try { active.prevFocus.focus(); } catch (e) {} }
    active = null;
  }

  function finish(completed) {
    if (!active) return;
    const key = active.key;
    const track = active.track;
    const idx = active.idx;
    const step = active.steps[idx];
    if (track) {
      clearRun();
      pushProgress(key, track, {
        step_id: (step && step.id) || null,
        completed: !!completed,
      });
    }
    if (completed || active.dsa) markDone(key);
    teardown();
    if (completed) {
      // brief confirmation toast (uses Wren.toast if present, else a tiny card)
      if (window.Wren && Wren.toast) Wren.toast('That\'s the tour — relaunch any time from the ? button.', 'success', 4000);
    }
    if (location.hash === '#tour') { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {} }
  }

  function start(key, opts) {
    key = key || portalKey();
    opts = opts || {};
    if (active) teardown();
    // b201: opts.steps lets a track (or a single contextual-help step) drive the
    // engine without going through the legacy per-portal registry.
    const steps = opts.steps || (available(key) ? resolveSteps(key) : []);
    if (!opts.steps) {
      if (!available(key)) return false;
      if (!opts.force && isDone(key)) return false;
    }
    if (!steps.length) return false;
    css();
    const spot = document.createElement('div'); spot.id = 'wtour-spot';
    const card = document.createElement('div'); card.id = 'wtour-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-live', 'polite');
    card.setAttribute('aria-label', 'Guided tour');
    document.body.appendChild(spot);
    document.body.appendChild(card);
    active = {
      key, steps, spot, card, dsa: false, _dir: opts.dir || 1,
      idx: Math.min(Math.max(0, opts.idx || 0), steps.length - 1),
      track: opts.track || null, trackLabel: opts.trackLabel || null,
      prevFocus: document.activeElement,
      onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
        else if (e.key === 'Enter') { if (e.target.tagName !== 'BUTTON') { e.preventDefault(); go(1); } }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      },
      onScroll() { if (active && active._pos) active._pos(); },
    };
    document.addEventListener('keydown', active.onKey, true);
    window.addEventListener('resize', active.onScroll, true);
    window.addEventListener('scroll', active.onScroll, true);
    showStep();
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // b201 — public track / chooser / contextual-help entry points
  // ═══════════════════════════════════════════════════════════════════════════

  // Run a named track. Resumes from stored progress unless opts.restart.
  function startTrack(key, trackId, opts) {
    key = key || portalKey();
    opts = opts || {};
    const C = content();
    if (!C) { loadContent(() => startTrack(key, trackId, opts)); return true; }
    trackId = trackId || defaultTrack(key);
    const steps = trackSteps(key, trackId);
    if (!steps.length) return false;
    const meta = (tracksFor(key) || []).find(t => t.id === trackId) || { label: trackId };
    let idx = typeof opts.idx === 'number' ? opts.idx : 0;
    if (!opts.restart && typeof opts.idx !== 'number') {
      const prog = serverProgress(key, trackId) || getLocalProgress(contentKey(key), trackId);
      if (prog && prog.step_id && !prog.completed) {
        const at = steps.findIndex(st => st.id === prog.step_id);
        if (at > -1) idx = at;
      }
    }
    return start(key, {
      force: true, steps: steps, idx: idx, dir: opts.dir || 1,
      track: trackId, trackLabel: meta.label,
    });
  }

  // Contextual help: one card describing the page you are standing on.
  function helpHere(key) {
    key = key || portalKey();
    const C = content();
    if (!C) { loadContent(() => helpHere(key)); return true; }
    const entry = C.forUrl(contentKey(key), location.pathname + location.hash) ||
                  C.forUrl(contentKey(key), _spaPath()) ||
                  C.forUrl(contentKey(key), location.pathname);
    if (!entry) {
      if (window.Wren && Wren.toast) Wren.toast('No help written for this page yet — try the ? menu → Choose a tour.', 'info', 4000);
      else chooser(key);
      return false;
    }
    return start(key, { force: true, steps: [toStep(entry)], idx: 0 });
  }

  // Roost SPA: the meaningful path is the pushState route, which is already
  // location.pathname — but on a legacy standalone page the shell may not have
  // pushed one, so fall back to the section/tab the shell thinks it is showing.
  function _spaPath() {
    try {
      const m = location.pathname.match(/^\/admin\/([^/?#]+)(?:\/([^/?#]+))?/);
      if (m) return '/admin/' + m[1] + (m[2] ? '/' + m[2] : '');
    } catch (e) {}
    return location.pathname;
  }

  // Track chooser — "Manager: everything" vs "Nest: daily routine", with the
  // resume position shown for each.
  function chooser(key) {
    key = key || portalKey();
    const C = content();
    if (!C) { loadContent(() => chooser(key)); return; }
    const tracks = tracksFor(key);
    if (!tracks.length) { start(key, { force: true }); return; }
    const portal = C.portalOf(contentKey(key)) || { label: 'Wren', subtitle: '' };
    css();
    const old = document.getElementById('wtour-pick'); if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.id = 'wtour-pick';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', 'Choose a tour');

    const rows = tracks.map(t => {
      const total = trackSteps(key, t.id).length;
      const prog = serverProgress(key, t.id) || getLocalProgress(contentKey(key), t.id);
      const doneN = prog && prog.completed_steps ? prog.completed_steps.length : 0;
      const pct = total ? Math.min(100, Math.round((doneN / total) * 100)) : 0;
      let note = `${total} steps`;
      if (prog && prog.completed) note = `${total} steps · finished ✓`;
      else if (doneN) note = `${total} steps · ${pct}% done — resumes where you left off`;
      return `<button class="wtour-track-btn" data-track="${t.id}">
        <span class="tt">${t.label}</span>
        <span class="tb">${t.blurb || ''}</span>
        <span class="tp">${note}</span>
        ${doneN ? `<span class="wtour-bar"><i style="width:${pct}%"></i></span>` : ''}
      </button>`;
    }).join('');

    wrap.innerHTML = `<div id="wtour-pick-box">
      <h3>🧭 ${portal.label} — choose a tour</h3>
      <p class="wtour-sub">${portal.subtitle}. Every step says what the screen is for, what you normally do there, and the thing people get wrong. Long tracks remember where you got to.</p>
      ${rows}
      <div class="wtour-row" style="margin-top:12px">
        <button class="wtour-btn" id="wtour-pick-here">❔ Just this page</button>
        <button class="wtour-btn" id="wtour-pick-close" style="margin-left:auto">Close</button>
      </div>
    </div>`;
    document.body.appendChild(wrap);
    wrap.querySelectorAll('[data-track]').forEach(b => {
      b.onclick = () => { const t = b.dataset.track; wrap.remove(); startTrack(key, t); };
    });
    wrap.querySelector('#wtour-pick-here').onclick = () => { wrap.remove(); helpHere(key); };
    wrap.querySelector('#wtour-pick-close').onclick = () => wrap.remove();
    wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { const w = document.getElementById('wtour-pick'); if (w) w.remove(); document.removeEventListener('keydown', esc); }
    });
  }

  // Resume a run parked by showStep() before a page navigation.
  function resumeRun() {
    const run = readRun();
    if (!run || !run.key || !run.track) return false;
    if (Date.now() - (run.ts || 0) > 6 * 60 * 60 * 1000) { clearRun(); return false; }  // stale
    if (contentKey(run.key) !== contentKey(portalKey())) return false;                  // different portal
    loadContent(C => {
      if (!C) return;
      startTrack(run.key, run.track, { idx: run.idx, dir: run.dir, restart: true });
    });
    return true;
  }

  // ── First-visit offer (non-blocking) ─────────────────────────────────────────
  function offer(key) {
    key = key || portalKey();
    const hasAny = available(key) || (content() && (tracksFor(key) || []).length);
    if (!hasAny || isDone(key) || active) return;
    if (document.getElementById('wtour-offer') || document.getElementById('wwiz-overlay')) return;
    css();
    const box = document.createElement('div');
    box.id = 'wtour-offer';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Take a tour');
    box.innerHTML = `
      <h4>👋 New here, or been away?</h4>
      <p>Guided tours cover every screen in this portal — what it is for, what you normally do, and what people get wrong. Long ones remember where you got to.</p>
      <div class="wtour-row">
        <button class="wtour-btn primary" id="wtour-offer-yes">Choose a tour</button>
        <button class="wtour-btn" id="wtour-offer-no">Not now</button>
        <button class="wtour-btn" id="wtour-offer-never" style="margin-left:auto">Don't ask again</button>
      </div>`;
    document.body.appendChild(box);
    try { localStorage.setItem(offerKey(key), '1'); } catch (e) {}
    box.querySelector('#wtour-offer-yes').onclick = () => {
      box.remove();
      loadContent(C => { if (C) fetchProgress().then(() => chooser(key)); else start(key, { force: true }); });
    };
    box.querySelector('#wtour-offer-no').onclick = () => box.remove();
    box.querySelector('#wtour-offer-never').onclick = () => { markDone(key); box.remove(); };
  }
  function offered(key) { try { return localStorage.getItem(offerKey(key)) === '1'; } catch (e) { return false; } }

  // ── Help (?) trigger in the topbar — offers Tour + (if present) Setup wizard ──
  function installHelpButton() {
    const key = portalKey();
    const hasTour = available(key) || !!content() || contentKey(key) !== 'unknown';
    const hasWiz = window.WrenWizard && WrenWizard.available && WrenWizard.available(key);
    if (!hasTour && !hasWiz) return;
    if (document.getElementById('wren-help-btn')) return;
    css();
    const btn = document.createElement('button');
    btn.id = 'wren-help-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Help and tour for this page');
    btn.setAttribute('aria-haspopup', 'true');
    btn.title = 'Help & tour (this page)';
    btn.innerHTML = '<span class="wren-help-ico" aria-hidden="true">❓</span>';

    // b201: three chromes to live in.
    //  1. shell-v2 topbar   (#wren-topbar)      — Roost, HR desktop
    //  2. app-shell topbar  (#wren-app-topbar)  — Nest tablets, HR mobile
    //  3. no shell at all                        — the parents portal: float it
    const topbar = document.getElementById('wren-topbar');
    const appbar = document.getElementById('wren-app-topbar');
    if (topbar) {
      btn.className = 'topbar-icon-btn';
      const anchor = topbar.querySelector('#wren-notif-btn') || topbar.querySelector('#wren-account-btn');
      if (anchor) topbar.insertBefore(btn, anchor); else topbar.appendChild(btn);
    } else if (appbar) {
      btn.className = 'wren-app-topbar-btn';
      const actions = appbar.querySelector('.wren-app-topbar-actions') || appbar;
      const anchor = actions.querySelector('#wren-app-notif-btn') || actions.querySelector('#wren-app-avatar');
      if (anchor) actions.insertBefore(btn, anchor); else actions.appendChild(btn);
    } else {
      btn.className = 'wtour-float-help';
      btn.style.cssText = 'position:fixed;right:14px;bottom:86px;z-index:9400;width:42px;height:42px;'
        + 'border-radius:50%;border:1px solid rgba(255,255,255,.25);background:#0f172a;color:#f1f5f9;'
        + 'font-size:1.1rem;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.35)';
      document.body.appendChild(btn);
    }

    btn.addEventListener('click', () => {
      const existing = document.getElementById('wtour-help-menu');
      if (existing) { existing.remove(); return; }
      const menu = document.createElement('div');
      menu.id = 'wtour-help-menu';
      menu.setAttribute('role', 'menu');
      const items = ['<button role="menuitem" data-act="here">❔ Help for this page</button>',
                     '<button role="menuitem" data-act="pick">🧭 Choose a tour</button>'];
      if (available(key)) items.push('<button role="menuitem" data-act="tour">▶️ Quick tour</button>');
      if (window.WrenWizard && WrenWizard.available(key)) items.push('<button role="menuitem" data-act="wizard">🚀 Setup wizard</button>');
      // 2026-11-03: Roost only — the "Using Wren" mode of the away assistant (manager-only, like Roost).
      if (key === 'roost') items.push('<button role="menuitem" data-act="ask">🧭 Ask how to do something</button>');
      menu.innerHTML = items.join('');
      document.body.appendChild(menu);
      const r = btn.getBoundingClientRect();
      const top = r.bottom + 6 + 200 > window.innerHeight ? Math.max(8, r.top - 206) : r.bottom + 6;
      menu.style.top = top + 'px';
      menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
      menu.querySelectorAll('[data-act]').forEach(mi => {
        mi.onclick = () => {
          menu.remove();
          const act = mi.dataset.act;
          if (act === 'here') helpHere(key);
          else if (act === 'pick') fetchProgress().then(() => chooser(key));
          else if (act === 'tour') start(key, { force: true });
          else if (act === 'wizard' && window.WrenWizard) WrenWizard.start(key, { force: true });
          else if (act === 'ask') location.href = '/away-assistant.html?mode=wren';
        };
      });
      setTimeout(() => document.addEventListener('click', function h(e) {
        if (!menu.contains(e.target) && e.target !== btn) { menu.remove(); document.removeEventListener('click', h); }
      }), 40);
    });
  }

  // ── Section blurbs (roost sidebar walk) ──────────────────────────────────────
  const BLURBS = {
    cockpit:        ['🛩️ Cockpit', 'Your command centre — comms feed, kanban to-do board (feedback reports land here), health checks and timeline. Start every day here.'],
    admissions:     ['🌱 Admissions', 'Enquiries pipeline, waiting list, occupancy forecasts and the yield engine — from first phone call to first day.'],
    'action-plans': ['⭐ Action Plans', 'Room and management action plans — track improvement actions and share selected ones with parents.'],
    staff:          ['👥 Staff', 'The staff hub — list, calendar, rota builder (Auto-Generate fills it from work patterns), Bradford scores, training and performance.'],
    children:       ['👶 Children', 'Every child\'s profile — details, allergies, key person, reports and per-child trackers.'],
    family:         ['👪 Family', 'Parent-facing admin — events with RSVP, absences parents report, consents, and parent change requests waiting for approval.'],
    'next-steps':   ['➡️ Next Steps', 'Every child\'s next steps in one list — what\'s open, done and overdue across the setting.'],
    curriculum:     ['📚 Curriculum', 'Planning, activities, trips and the curriculum calendar — what\'s happening in each room and why.'],
    finance:        ['💷 Finance', 'Invoices, payments, funding claims, wages and the Xero bank reconciliation — the money end to end.'],
    communications: ['💬 Comms', 'The nursery inbox, parent messaging, newsletters, surveys, permission slips — and the email gateway review queue.'],
    safeguarding:   ['🛡️ Safeguarding', 'Concerns, the sign-off queue and the audit trail. Locked on for every setting — this one never switches off.'],
    inspection:     ['📋 Inspection', 'Ofsted readiness — evidence, gap analysis, briefings and action items so an inspection is never a surprise.'],
    checklist:      ['✅ Checklist', 'The monthly compliance checklist — tick through statutory jobs and see what\'s slipping.'],
    operations:     ['🔧 Operations', 'The building — kitchen & food safety, repairs, clock-in/out and health & safety compliance.'],
    cpd:            ['🎓 CPD', 'The training academy and CPD records — courses staff can take in-app, with certificates.'],
    review:         ['✅ Review', 'The review queue — AI-drafted and staff-submitted items waiting for a manager decision.'],
    system:         ['⚙️ System', 'Settings, integrations, backups, permissions and Setup & Features — where you switch modules on and off.'],
    intelligence:   ['📡 Intelligence', 'Workflows, search across everything, and AI chat over your setting\'s data.'],
    assistant:      ['🪺 Wren AI', 'The assistant — ask it about your children, staff, emails or anything EYFS. It runs on your own hardware, not the cloud.'],
    'data-governance': ['🗄️ Data Governance', 'GDPR housekeeping — retention schedules, records maps, archives and subject access requests.'],
  };

  // ── Portal configs ───────────────────────────────────────────────────────────
  // ROOST (admin SPA): a smart sidebar walk — one step per VISIBLE section, so a
  // childminder-preset instance (modules switched off) gets a shorter tour. Built
  // as a function so it reads the live, module-filtered sidebar at start time.
  register('roost', function () {
    const steps = [{
      sel: '.topbar-logo, #wren-topbar .wren-logo',
      title: '🐦 Welcome to Roost',
      body: 'This is your admin command centre. Let\'s walk through the main areas — click <b>Next</b>, or <b>Skip</b> at any time. You can relaunch this from the <b>?</b> button.',
    }];
    const list = document.querySelector('.v2-section-list');
    if (list) {
      Array.from(list.querySelectorAll('[data-section]'))
        .filter(b => { const li = b.closest('li'); return b.offsetParent !== null && (!li || li.style.display !== 'none'); })
        .forEach(btn => {
          const id = btn.dataset.section;
          const [title, body] = BLURBS[id] || [btn.title || id, 'Part of your Wren portal.'];
          steps.push({ el: btn, nav: id, title, body });
        });
    }
    steps.push({ sel: '#wren-search-btn', title: '🔍 Search everything', body: 'Press <b>Ctrl + K</b> anywhere to jump to a section, child, staff member or parent.' });
    steps.push({ sel: '#wren-account-btn', title: '👤 Your account', body: 'Profile, two-factor auth and settings live here. And the <b>?</b> button (top bar) reopens this tour whenever you like.' });
    return steps;
  });

  // HR (Seed): static walk of the dashboard + nav. Steps whose element is missing
  // on the current page (e.g. the manager-only card, or a non-dashboard page) skip
  // themselves automatically.
  register('hr', [
    { sel: '.topbar-logo, #wren-topbar .wren-logo', title: '🌱 Welcome to Seed', body: 'This is your HR portal — your personal and employment records in one place. Here\'s a quick look around.' },
    { sel: '#card-leave', title: '🏖️ Holiday balance', body: 'Your remaining annual leave at a glance. Book time off from <b>Absences</b>.' },
    { sel: '#card-toil', title: '⏰ TOIL', body: 'Time off in lieu you\'ve accrued. Managers adjust balances; you can spend it as leave.' },
    { sel: '#card-policies', title: '📄 Policies', body: 'Policies waiting for your acknowledgement. Tap through to read and sign them off.' },
    { sel: '#card-supervisions', title: '🤝 Supervisions', body: 'Your next scheduled supervision. Notes and targets live under Supervisions.' },
    { sel: '#wren-sidebar .v2-section-list', title: '🧭 Getting around', body: 'Everything HR is in this sidebar — profile, absences, CPD, wellbeing, and (for managers) rota, policies admin and the team.' },
    { sel: '#manager-section', title: '👥 Team overview', body: 'As a manager you also see pending absences, policy compliance and wellbeing concerns for your team.', optional: true },
    { sel: '#wren-account-btn', title: '👤 Your account', body: 'Profile and sign-out live here. Reopen this tour any time from the <b>?</b> button in the top bar.' },
  ]);

  // ── Public API ───────────────────────────────────────────────────────────────
  window.WrenTour = {
    register, start, available, isDone, reset, portalKey, offer,
    // b201
    startTrack, chooser, helpHere, tracksFor, trackSteps, loadContent, contentKey,
    progress: fetchProgress, resumeRun,
  };

  // ── Boot ─────────────────────────────────────────────────────────────────────
  function boot() {
    const key = portalKey();
    // Install the ? trigger once the topbar exists.
    installHelpButton();
    // b201: pull the corpus + this staff member's progress in the background so
    // the chooser can show "resumes where you left off" without a spinner.
    loadContent(() => { installHelpButton(); });
    fetchProgress();

    // b201: a walk parked before a page navigation takes priority over everything.
    if (resumeRun()) return;

    // b201 deep links: #tour → chooser, #tour=<track> → that track, #help → this page.
    const hash = (location.hash || '').replace(/^#/, '');
    if (hash === 'help') { loadContent(() => helpHere(key)); return; }
    if (hash.indexOf('tour=') === 0) {
      const t = hash.slice(5);
      loadContent(() => fetchProgress().then(() => startTrack(key, t)));
      return;
    }

    // Legacy / explicit triggers → run immediately (force).
    let forced = false;
    try {
      if (location.hash === '#tour') { reset(key); forced = true; }
      // 2026-10-09: the setup page's "tour after setup" flag used to force the chooser on EVERY
      // Roost load until a tour was finished. Clear it instead; the tour stays on the ? button.
      else if (localStorage.getItem('wrenTourPending') === '1') { localStorage.removeItem('wrenTourPending'); }
    } catch (e) {}
    if (forced) {
      // wait for the module-filtered sidebar to settle, then offer the tracks.
      // (Pre-b201 this ran the short sidebar walk; that is now the "Quick tour"
      // item in the ? menu, and System → "Take the tour" opens the chooser.)
      let n = 0;
      const iv = setInterval(() => {
        const ready = key !== 'roost' || document.querySelector('.v2-section-list');
        if (ready && ++n >= 2) {
          clearInterval(iv);
          loadContent(() => fetchProgress().then(() => chooser(key)));
        } else if (n > 25) { clearInterval(iv); loadContent(() => chooser(key)); }
      }, 350);
      return;
    }
    // 2026-09-25 (Toby) — NO unprompted offer, on any portal. It was meant to appear once
    // ever, guarded by a localStorage flag, but a flag that lives in one browser on one
    // device comes back empty often enough that staff met it again and again. Every portal
    // already carries the ? button in the topbar, which opens the same chooser on demand.
    // offer() is kept and still reachable through WrenTour.offer() — it just never
    // self-starts.
    void offer;
  }

  function onReady() {
    // The topbar is built by the shell on wren:ready; install the ? button then.
    // b201 FIX: this used to wait only for #wren-topbar or a wren:ready it could
    // never hear. wren-app-shell (Nest tablets, HR mobile) DISPATCHES wren:ready
    // and only afterwards appends this script — so the listener was always too
    // late and boot() never ran, which is why the ? button never appeared on the
    // EY portal. The parents portal has no shell at all. Poll briefly for either
    // chrome, then boot regardless.
    if (document.getElementById('wren-topbar') || document.getElementById('wren-app-topbar')) return boot();
    let booted = false;
    const go = () => { if (!booted) { booted = true; boot(); } };
    document.addEventListener('wren:ready', go, { once: true });
    let n = 0;
    const iv = setInterval(() => {
      if (booted) return clearInterval(iv);
      if (document.getElementById('wren-topbar') || document.getElementById('wren-app-topbar') || ++n > 20) {
        clearInterval(iv); go();
      }
    }, 150);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();

  // Re-arm on hash change (System → "Take the tour" sets #tour without reload).
  window.addEventListener('hashchange', () => {
    if (active) return;
    const h = (location.hash || '').replace(/^#/, '');
    const k = portalKey();
    if (h === 'tour') { reset(k); loadContent(() => fetchProgress().then(() => chooser(k))); }
    else if (h.indexOf('tour=') === 0) { loadContent(() => startTrack(k, h.slice(5))); }
    else if (h === 'help') { loadContent(() => helpHere(k)); }
  });
})();
