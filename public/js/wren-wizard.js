// Wren first-run setup wizard — generic, config-driven, reusable across portals
// (new 2026-07-16). A short, non-blocking multi-step overlay that welcomes a new
// user, lets them sanity-check the setting's basics, and points them at the next
// thing to do. Skippable and resumable; completion persists per portal.
//
// This is deliberately LIGHTWEIGHT and read-only — it shows current data (rooms,
// nursery name) with links to edit, rather than writing anything. The heavy,
// authoritative first-run flow remains editions/admin/public/setup.html; this
// overlay is the friendly "you're in, here's the lay of the land" layer that any
// portal can opt into.
//
// Public API (window.WrenWizard):
//   register(key, config)   — config: { title, steps:[…], finishLinks:[…] }
//   start(key, {force})     — open the wizard; force ignores the done flag
//   available(key)          — is a config registered?
//   isDone(key) / reset(key)
//
// Step shape:
//   { title:'…', body:'html', render(bodyEl){…} }   render() is optional and may
//   populate the step body asynchronously (e.g. fetch + show rooms read-only).
//
// Persistence: localStorage 'wren.wizard.<key>.done'. On finish, the roost wizard
// also offers to launch the guided tour (WrenTour) for a smooth hand-off.
;(function () {
  'use strict';
  if (window.self !== window.top) return;

  function portalKey() {
    const ed = (window.Wren && Wren.edition)
      || (document.querySelector('meta[name="wren-edition"]') || {}).content || '';
    if (ed === 'admin' || window.WREN_SECTIONS) return 'roost';
    return ed || 'unknown';
  }

  const doneKey = k => 'wren.wizard.' + k + '.done';
  function isDone(k) { try { return localStorage.getItem(doneKey(k)) === '1'; } catch (e) { return false; } }
  function markDone(k) { try { localStorage.setItem(doneKey(k), '1'); } catch (e) {} }
  function reset(k) { try { localStorage.removeItem(doneKey(k)); } catch (e) {} }

  const registry = {};
  function register(key, cfg) { registry[key] = cfg; }
  function available(key) { return !!registry[key]; }

  function css() {
    if (document.getElementById('wwiz-css')) return;
    const s = document.createElement('style');
    s.id = 'wwiz-css';
    s.textContent = `
#wwiz-overlay{position:fixed;inset:0;z-index:9550;display:flex;align-items:center;justify-content:center;
  background:rgba(2,8,20,.6);padding:16px}
#wwiz-card{width:min(560px,calc(100vw - 24px));max-height:calc(100vh - 32px);overflow:auto;
  background:#0f172a;color:#f1f5f9;border:1px solid #4a9abf;border-radius:18px;padding:24px;
  box-shadow:0 20px 60px rgba(0,0,0,.6)}
#wwiz-card h2{margin:0 0 4px;font-size:1.25rem}
.wwiz-sub{margin:0 0 18px;font-size:.82rem;color:#64748b}
.wwiz-dots{display:flex;gap:7px;margin:0 0 20px}
.wwiz-dot{width:26px;height:6px;border-radius:3px;background:#334155;transition:background .2s}
.wwiz-dot.on{background:#4a9abf}
#wwiz-body h3{margin:0 0 8px;font-size:1.05rem}
#wwiz-body p{margin:0 0 12px;font-size:.9rem;color:#cbd5e1;line-height:1.5}
#wwiz-body ul{margin:0 0 12px;padding-left:20px;font-size:.88rem;color:#cbd5e1;line-height:1.6}
.wwiz-chips{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 14px}
.wwiz-chip{background:#1e293b;border:1px solid #334155;border-radius:999px;padding:6px 13px;font-size:.82rem;color:#e2e8f0}
.wwiz-links{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:6px 0 4px}
.wwiz-link{display:flex;align-items:center;gap:10px;text-decoration:none;background:#1e293b;
  border:1px solid #334155;border-radius:12px;padding:13px;color:#f1f5f9;font-size:.88rem;transition:border-color .15s}
.wwiz-link:hover{border-color:#4a9abf}
.wwiz-row{display:flex;gap:8px;align-items:center;margin-top:20px}
.wwiz-btn{padding:9px 17px;border-radius:10px;border:1px solid #334155;background:transparent;
  color:#cbd5e1;cursor:pointer;font-size:.88rem;font-family:inherit}
.wwiz-btn:hover{border-color:#4a9abf;color:#fff}
.wwiz-btn.primary{background:#4a9abf;border-color:#4a9abf;color:#04101c;font-weight:700}
.wwiz-skip{margin-left:auto;background:none;border:none;color:#64748b;cursor:pointer;font-size:.82rem;font-family:inherit;text-decoration:underline}
.wwiz-muted{font-size:.8rem;color:#64748b}`;
    document.head.appendChild(s);
  }

  let active = null; // { key, cfg, steps, idx, overlay }

  function renderStep() {
    const { cfg, steps, idx, overlay } = active;
    const step = steps[idx];
    const last = idx === steps.length - 1;
    overlay.querySelectorAll('.wwiz-dot').forEach((d, i) => d.classList.toggle('on', i <= idx));
    const body = overlay.querySelector('#wwiz-body');
    body.innerHTML = `<h3>${step.title || ''}</h3>${step.body || ''}`;
    if (typeof step.render === 'function') { try { step.render(body); } catch (e) {} }
    const row = overlay.querySelector('#wwiz-controls');
    row.innerHTML = `
      <button class="wwiz-btn" id="wwiz-back" ${idx === 0 ? 'disabled style=\"opacity:.4;cursor:default\"' : ''}>← Back</button>
      <button class="wwiz-btn primary" id="wwiz-next">${last ? 'Finish ✓' : 'Next →'}</button>
      <button class="wwiz-skip" id="wwiz-skip">Skip for now</button>`;
    row.querySelector('#wwiz-next').onclick = () => { if (last) finish(true); else { active.idx++; renderStep(); } };
    row.querySelector('#wwiz-back').onclick = () => { if (active.idx > 0) { active.idx--; renderStep(); } };
    row.querySelector('#wwiz-skip').onclick = () => finish(false);
    const nx = row.querySelector('#wwiz-next'); if (nx) setTimeout(() => nx.focus(), 30);
  }

  function teardown() {
    if (!active) return;
    document.removeEventListener('keydown', active.onKey, true);
    if (active.overlay) active.overlay.remove();
    if (active.prevFocus && active.prevFocus.focus) { try { active.prevFocus.focus(); } catch (e) {} }
    active = null;
  }

  function finish(completed) {
    if (!active) return;
    const key = active.key, cfg = active.cfg;
    if (completed) markDone(key);
    teardown();
    // Smooth hand-off: after completing, offer the guided tour.
    if (completed && cfg.launchTourOnFinish && window.WrenTour && WrenTour.available(key)) {
      if (window.Wren && Wren.toast) Wren.toast('Setup done — starting the guided tour…', 'success', 2500);
      setTimeout(() => WrenTour.start(key, { force: true }), 600);
    }
  }

  function start(key, opts) {
    key = key || portalKey();
    opts = opts || {};
    if (active) teardown();
    const cfg = registry[key];
    if (!cfg) return false;
    if (!opts.force && isDone(key)) return false;
    const steps = cfg.steps || [];
    if (!steps.length) return false;
    css();
    const overlay = document.createElement('div');
    overlay.id = 'wwiz-overlay';
    overlay.innerHTML = `
      <div id="wwiz-card" role="dialog" aria-modal="true" aria-label="${cfg.title || 'Setup'}">
        <h2>${cfg.title || 'Welcome'}</h2>
        <p class="wwiz-sub">${(cfg.subtitle || 'A quick first-run setup — you can skip and come back later.').replace('{setting}', 'Your setting')}</p>
        <div class="wwiz-dots">${steps.map(() => '<span class="wwiz-dot"></span>').join('')}</div>
        <div id="wwiz-body"></div>
        <div class="wwiz-row" id="wwiz-controls"></div>
      </div>`;
    document.body.appendChild(overlay);
    active = {
      key, cfg, steps, idx: 0, overlay, prevFocus: document.activeElement,
      onKey(e) { if (e.key === 'Escape') { e.preventDefault(); finish(false); } },
    };
    document.addEventListener('keydown', active.onKey, true);
    // b297 — fill in the setting's own name once it is known. Best-effort: if the
    // request fails the neutral placeholder above stays, which is still correct
    // for everyone.
    if (/\{setting\}/.test(cfg.subtitle || '')) {
      const sub = overlay.querySelector('.wwiz-sub');
      apiGet('/api/admin/settings').then(st => {
        const nm = st && (st.nursery_name || st.invoice_nursery_name);
        if (nm && sub) sub.textContent = cfg.subtitle.replace('{setting}', nm);
      });
    }
    // Click on the dim backdrop (outside the card) = skip.
    overlay.addEventListener('click', e => { if (e.target === overlay) finish(false); });
    // Wizard links open in a NEW TAB — navigating away in-tab would reload the page
    // and restart the wizard. Delegation covers async-populated links (e.g. rooms) too.
    overlay.addEventListener('click', e => {
      const a = e.target.closest('a[href]');
      if (a && overlay.contains(a) && !/^(#|javascript:)/.test(a.getAttribute('href') || '')) {
        e.preventDefault();
        window.open(a.href, '_blank', 'noopener');
      }
    });
    renderStep();
    return true;
  }

  // ── Helpers for data-backed steps (read-only, best-effort) ───────────────────
  function apiGet(url) {
    if (window.Wren && typeof Wren.api === 'function') return Wren.api(url).catch(() => null);
    return Promise.resolve(null);
  }

  // ── ROOST setup config ───────────────────────────────────────────────────────
  register('roost', {
    title: '🐦 Welcome to Roost',
    // b297 — this said "Your Nursery" for every tenant. wren-wizard.js
    // is shared, so the two prospect demos both opened with another setting's name
    // across the top of their very first screen. {setting} is substituted from
    // /api/admin/settings when the card renders; the placeholder text below is
    // what shows if that call fails, and names nobody.
    subtitle: '{setting} — admin portal first-run setup',
    launchTourOnFinish: true,
    steps: [
      {
        title: 'Let\'s get you set up',
        body: `<p>Roost is your command centre — children, staff, finance, safeguarding, compliance and comms in one place.</p>
               <p>This 4-step check makes sure the basics look right. It takes about a minute, and you can skip any part.</p>`,
      },
      {
        title: 'Your rooms',
        body: `<p>Wren has these rooms on file. If any are missing or the capacities are wrong, fix them in Settings — everything else (ratios, occupancy, invoicing) builds on this.</p>
               <div id="wwiz-rooms" class="wwiz-chips"><span class="wwiz-muted">Loading rooms…</span></div>
               <a class="wwiz-link" href="/admin/system/settings" style="max-width:260px">⚙️ <span>Edit rooms &amp; nursery details</span></a>`,
        render(body) {
          const box = body.querySelector('#wwiz-rooms');
          apiGet('/api/admin/rooms').then(rooms => {
            if (!box) return;
            if (Array.isArray(rooms) && rooms.length) {
              box.innerHTML = rooms.map(r => {
                const name = r.display_name || r.name || ('Room ' + r.id);
                const cap = (r.capacity != null) ? ` · max ${r.capacity}` : '';
                return `<span class="wwiz-chip">${String(name).replace(/</g, '&lt;')}${cap}</span>`;
              }).join('');
            } else {
              box.innerHTML = '<span class="wwiz-muted">No rooms found yet — add them in Settings.</span>';
            }
          });
        },
      },
      {
        title: 'Key contacts & people',
        body: `<p>Make sure your team and the right leads are set up:</p>
               <ul>
                 <li><b>Staff</b> — add your team, set roles and key persons.</li>
                 <li><b>Safeguarding lead (DSL)</b> — confirmed in Settings.</li>
                 <li><b>Children &amp; families</b> — import or add children and their parent contacts.</li>
               </ul>
               <div class="wwiz-links">
                 <a class="wwiz-link" href="/admin/staff/list">👥 <span>Staff</span></a>
                 <a class="wwiz-link" href="/admin/children/list">👶 <span>Children</span></a>
               </div>`,
      },
      {
        title: 'You\'re set up 🎉',
        body: `<p>That\'s the essentials. Here\'s where to go next — and you can reopen this wizard or the guided tour any time from the <b>?</b> button in the top bar.</p>
               <div class="wwiz-links">
                 <a class="wwiz-link" href="/admin/cockpit/comms">🛩️ <span>Open the Cockpit</span></a>
                 <a class="wwiz-link" href="/admin/system/settings">⚙️ <span>Settings &amp; modules</span></a>
                 <a class="wwiz-link" href="/admin/children/list">👶 <span>Children</span></a>
                 <a class="wwiz-link" href="/admin/staff/list">👥 <span>Staff</span></a>
               </div>
               <p class="wwiz-muted" style="margin-top:12px">Finish to start a quick guided tour of the sidebar.</p>`,
      },
    ],
  });

  // ── HR (Seed) setup config ───────────────────────────────────────────────────
  register('hr', {
    title: '🌱 Welcome to Seed',
    subtitle: 'Your HR portal — first-run setup',
    launchTourOnFinish: true,
    steps: [
      {
        title: 'This is your HR home',
        body: `<p>Seed holds your personal and employment records — holiday, TOIL, CPD, supervisions, wellbeing and policies. It works on your phone and at a desk.</p>
               <p>Two quick things to get you going.</p>`,
      },
      {
        title: 'Complete your profile',
        body: `<p>Check your details are right — contact info, emergency contact and qualifications. Your manager and payroll rely on it.</p>
               <div class="wwiz-links">
                 <a class="wwiz-link" href="/my-profile.html">👤 <span>My Profile</span></a>
                 <a class="wwiz-link" href="/my-cpd.html">🎓 <span>My CPD</span></a>
               </div>`,
      },
      {
        title: 'You\'re all set 🎉',
        body: `<p>Book leave, log TOIL, acknowledge policies and check in on your wellbeing whenever you need to. The <b>?</b> button in the top bar reopens this or the guided tour.</p>
               <div class="wwiz-links">
                 <a class="wwiz-link" href="/my-absences.html">🏖️ <span>Absences</span></a>
                 <a class="wwiz-link" href="/policies.html">📄 <span>Policies</span></a>
                 <a class="wwiz-link" href="/my-wellbeing.html">💚 <span>Wellbeing</span></a>
                 <a class="wwiz-link" href="/my-supervisions.html">🤝 <span>Supervisions</span></a>
               </div>`,
      },
    ],
  });

  window.WrenWizard = { register, start, available, isDone, reset, portalKey };

  // ── Boot: offer the wizard on genuine first run (before the tour offer) ───────
  function boot() {
    const key = portalKey();
    if (!available(key)) return;
    if (isDone(key)) return;
    // Only auto-open where it makes sense: the portal's home/dashboard, not deep
    // pages. Roost SPA always boots at its landing route; HR home is /index.html.
    const p = location.pathname;
    const atHome = key === 'roost'
      ? (/\/app\.html$/.test(p) || /^\/admin(\/(cockpit|staff)\b|\/?$)/.test(p) || p === '/' )
      : (/\/index\.html$/.test(p) || p === '/');
    if (!atHome) return;
    // Don't collide with an explicit tour trigger.
    try { if (location.hash === '#tour' || localStorage.getItem('wrenTourPending') === '1') return; } catch (e) {}
    // 2026-10-09 (Toby: "every time a new build comes on Roost I get the take a tour, it's getting
    // annoying, remove") — NO unprompted open, same decision as the tour on 2026-09-25: the
    // 'done' flag lives in one browser's localStorage and comes back empty often enough to
    // re-trigger. The wizard stays one click away (the ? button, System → Setup).
    void start; void atHome;
  }

  function onReady() {
    if (document.getElementById('wren-topbar')) boot();
    else document.addEventListener('wren:ready', boot, { once: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();
})();
