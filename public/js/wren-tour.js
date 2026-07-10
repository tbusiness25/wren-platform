// Wren first-run guided tour (2026-07-09) — after the setup wizard, walk the
// manager through every section of the admin portal, one page at a time.
// SMART: steps are built from the sidebar buttons that are actually VISIBLE,
// so sections switched off in Setup & Features (module_* flags) are skipped
// automatically — a childminder-preset instance gets a five-stop tour, a full
// nursery gets the lot.
//
// Triggers: location.hash === '#tour' (System → "Take the tour"), or a pending
// flag set by either setup wizard's finish step. Runs once; Skip ends it.
;(function () {
  'use strict';
  if (window.self !== window.top) return;

  const PENDING = 'wrenTourPending';
  const DONE = 'wrenTourDone';

  const BLURBS = {
    cockpit:        ['🛩️ Cockpit', 'Your command centre — comms feed, kanban to-do board (feedback reports land here), health checks and timeline. Start every day here.'],
    admissions:     ['🌱 Admissions', 'Enquiries pipeline, waiting list, occupancy forecasts and the yield engine — from first phone call to first day.'],
    'action-plans': ['⭐ Action Plans', 'Room and management action plans — track improvement actions and share selected ones with parents.'],
    staff:          ['👥 Staff', 'The staff hub — list, calendar, rota builder (Auto-Generate fills it from work patterns), Bradford scores, training and performance.'],
    children:       ['👶 Children', 'Every child\'s profile — details, allergies, key person, reports and per-child trackers.'],
    family:         ['👪 Family', 'Parent-facing admin — events with RSVP, absences parents report, consents, and parent change requests waiting for your approval.'],
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
    system:         ['⚙️ System', 'Settings, integrations, backups, permissions and Setup & Features — where you switch modules on and off. The feedback reports viewer lives here too.'],
    intelligence:   ['📡 Intelligence', 'Workflows, search across everything, and AI chat over your setting\'s data.'],
    assistant:      ['🪺 Wren AI', 'The assistant — ask it about your children, staff, emails or anything EYFS. It runs on your own hardware, not the cloud.'],
    'data-governance': ['🗄️ Data Governance', 'GDPR housekeeping — retention schedules, records maps, archives and subject access requests.'],
  };

  function shouldStart() {
    try {
      if (location.hash === '#tour') return true;
      return localStorage.getItem(PENDING) === '1' && localStorage.getItem(DONE) !== '1';
    } catch (e) { return false; }
  }

  function visibleSteps() {
    const list = document.querySelector('.v2-section-list');
    if (!list) return [];
    return Array.from(list.querySelectorAll('li'))
      .filter(li => li.style.display !== 'none' && li.offsetParent !== null)
      .map(li => li.querySelector('[data-section]'))
      .filter(Boolean);
  }

  let idx = 0, steps = [], card = null, lastBtn = null;

  function css() {
    if (document.getElementById('wtour-css')) return;
    const s = document.createElement('style');
    s.id = 'wtour-css';
    s.textContent = `
#wtour-card{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9500;
  width:min(460px,calc(100vw - 32px));background:#0f172a;color:#f1f5f9;border:1px solid #4a9abf;
  border-radius:16px;padding:18px;box-shadow:0 12px 44px rgba(0,0,0,.55)}
#wtour-card h3{margin:0 0 6px;font-size:1.05rem}
#wtour-card p{margin:0 0 12px;font-size:.88rem;color:#cbd5e1;line-height:1.45}
.wtour-row{display:flex;gap:8px;align-items:center}
.wtour-btn{padding:9px 16px;border-radius:10px;border:1px solid #334155;background:transparent;
  color:#cbd5e1;cursor:pointer;font-size:.85rem}
.wtour-btn.primary{background:#4a9abf;border-color:#4a9abf;color:#04101c;font-weight:700}
.wtour-prog{margin-left:auto;font-size:.75rem;color:#64748b}
.wtour-hl{outline:3px solid #4a9abf !important;outline-offset:2px;border-radius:10px}`;
    document.head.appendChild(s);
  }

  function showStep() {
    const btn = steps[idx];
    if (!btn) return finish(true);
    if (lastBtn) lastBtn.classList.remove('wtour-hl');
    btn.classList.add('wtour-hl');
    lastBtn = btn;
    btn.click(); // navigate the SPA to this section so they SEE it, not just hear about it
    const id = btn.dataset.section;
    const [title, blurb] = BLURBS[id] || [btn.title || id, 'Part of your Wren portal.'];
    card.innerHTML = `
      <h3>${title}</h3>
      <p>${blurb}</p>
      <div class="wtour-row">
        <button class="wtour-btn" id="wtour-back" ${idx === 0 ? 'disabled' : ''}>← Back</button>
        <button class="wtour-btn primary" id="wtour-next">${idx === steps.length - 1 ? 'Finish ✓' : 'Next →'}</button>
        <button class="wtour-btn" id="wtour-skip">Skip tour</button>
        <span class="wtour-prog">${idx + 1} / ${steps.length}</span>
      </div>`;
    document.getElementById('wtour-next').onclick = () => { idx++; idx >= steps.length ? finish(true) : showStep(); };
    document.getElementById('wtour-back').onclick = () => { if (idx > 0) { idx--; showStep(); } };
    document.getElementById('wtour-skip').onclick = () => finish(false);
  }

  function finish(completed) {
    if (lastBtn) lastBtn.classList.remove('wtour-hl');
    try { localStorage.setItem(DONE, '1'); localStorage.removeItem(PENDING); } catch (e) {}
    if (card) {
      card.innerHTML = `
        <h3>${completed ? '🎉 That\'s the tour!' : 'Tour skipped'}</h3>
        <p>You can run it again any time from <b>System → Settings → Take the tour</b>. The 🐞 button on every page sends feedback straight to the manager's board.</p>
        <div class="wtour-row"><button class="wtour-btn primary" id="wtour-close">Start using Wren</button></div>`;
      document.getElementById('wtour-close').onclick = () => { card.remove(); card = null; };
      setTimeout(() => { if (card) { card.remove(); card = null; } }, 12000);
    }
    if (location.hash === '#tour') { try { history.replaceState(null, '', location.pathname); } catch (e) {} }
  }

  function start() {
    steps = visibleSteps();
    if (!steps.length) return;
    css();
    card = document.createElement('div');
    card.id = 'wtour-card';
    document.body.appendChild(card);
    idx = 0;
    showStep();
  }

  function boot() {
    if (!shouldStart()) return;
    // Wait for the sidebar to exist AND for the async module filter to hide
    // switched-off sections, so the tour only covers what this setting uses.
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if (document.querySelector('.v2-section-list') && tries >= 3) { clearInterval(iv); start(); }
      else if (tries > 25) clearInterval(iv);
    }, 400);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  window.addEventListener('hashchange', () => { if (location.hash === '#tour' && !card) { try { localStorage.removeItem(DONE); } catch (e) {} boot(); } });
})();
