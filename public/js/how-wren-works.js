/*!
 * how-wren-works.js — "How Wren Works" visual architecture explainer + self-training hub.
 * b113 (2026-07-21). Single source of truth, rendered by both the Roost host page
 * (/how-wren-works.html) and the Nest INSET page (/ey/how-wren-works.html).
 *
 * Self-contained: no external dependencies, injects its own <style> (scoped to .hww),
 * renders into a mount element, wires tap/keyboard interactions, and is print-friendly
 * (A3 landscape, switches to ink-saving light + reveals every card).
 *
 * Copy is deliberately warm and jargon-free — audience is nursery staff, for self-training
 * and for Toby's support/reasoning page. Grounded in wren-docs/02-TECH-MANUAL.md decision
 * log + the live stack (verified 2026-07-21).
 */
(function () {
  'use strict';

  // ── Content model (edit here — both portals pick it up) ─────────────────────────
  // Each layer: a band in the stack. The four "detail" fields answer Toby's brief:
  // what it does / why it's there / what we'd do without it / what happens if it fails.
  var LAYERS = [
    {
      key: 'hardware', icon: '🏢', accent: '#e07820',
      title: 'The box in the office', tag: 'Your data’s home',
      summary: 'Everything Wren does runs on a small computer here in the nursery — not out on the internet.',
      what: 'A little computer in the office (about the size of a paperback) quietly runs the whole system, and a second small computer does the clever AI work. Both sit on the nursery’s own network.',
      why: 'Because a child’s information should live where you can see it — on-site, behind your own front door. Nothing about a child is stored on someone else’s servers.',
      without: 'We’d be renting space on a big company’s cloud, sending family data off-site and paying every month for the privilege.',
      fail: 'The data is copied every night (see the safety net below). If the box ever had a problem, a spare is swapped in and last night’s backup restored — nothing is lost to “the cloud” because it was never there. And as it only holds your nursery, a wobble here can never affect anyone else.'
    },
    {
      key: 'docker', icon: '📦', accent: '#4a9abf',
      title: 'Sealed compartments', tag: 'One breaks, the rest carry on',
      summary: 'Each part of Wren runs in its own sealed box, so a problem in one can’t spread to the others.',
      what: 'The database, the AI, the front door and the apps each run inside their own sealed container. They talk through tidy, agreed doorways, but they don’t share their insides.',
      why: 'Like the watertight compartments in a ship. If one part hiccups it can be restarted on its own, without disturbing everything else.',
      without: 'One giant program doing everything means one small bug can bring the whole lot down at once.',
      fail: 'A container that stops is spotted and restarted automatically within seconds by a watchdog that never sleeps. The other parts usually never even notice.'
    },
    {
      key: 'database', icon: '🗄️', accent: '#22c55e',
      title: 'The database', tag: 'Replaces the spreadsheets',
      summary: 'One trusted database holds everything — instead of scattered Excel sheets, paper diaries and duplicate lists.',
      what: 'Every child, observation, invoice and register mark lives in one organised place. It hands the right information to the right app — and to the AI — whenever it’s asked.',
      why: 'It replaces the tangle of spreadsheets and paper. One place, one true version — so the office, the room and the parent all see exactly the same thing.',
      without: 'Back to five copies of the register that never quite agree, and re-typing the same child’s details into six different sheets.',
      fail: 'It is built to guard your data above all else. Every change is saved as an all-or-nothing step (a “transaction”), so a half-finished save can never leave a muddled record — and it’s backed up every few hours.'
    },
    {
      key: 'engine', icon: '⚙️', accent: '#a78bfa',
      title: 'One shared engine', tag: 'One rulebook for every app',
      summary: 'A single engine powers all four apps, so the rules are identical everywhere.',
      what: 'Behind every button, one program does the real work — saving an observation, checking a staffing ratio, working out funding. All four apps ask this same engine.',
      why: 'One engine means one set of rules. A safeguarding step or a ratio check is written once and applies the same on the tablet, the office PC and a parent’s phone.',
      without: 'Four separate systems that each do things slightly differently — and four places to fix every time a rule changes.',
      fail: 'If the engine is restarted (say, after an update) the apps simply wait a moment and reconnect. Your tablet keeps your half-written observation safe in the meantime.'
    },
    {
      key: 'frontdoor', icon: '🚪', accent: '#38bdf8',
      title: 'The front door', tag: 'The doorman',
      summary: 'Every request comes in through one guarded front door that sends it to the right place.',
      what: 'A single “doorman” greets every visit and points it the right way: office staff to Roost, room staff to Nest, parents to Egg, HR to Seed.',
      why: 'One well-guarded entrance is far easier to secure and keep an eye on than lots of little side doors.',
      without: 'Every app exposed separately to the internet — more doors, and more locks to worry about.',
      fail: 'The doorman is tiny and rock-solid; if it’s reloaded it picks up instantly. Nothing behind it is exposed directly, so it’s also your first line of defence.'
    },
    {
      key: 'apps', icon: '📱', accent: '#f472b6',
      title: 'The four apps', tag: 'Install like an app · work offline',
      summary: 'Roost, Nest, Egg and Seed — four friendly apps for four jobs, each installable and offline-ready.',
      what: 'Roost (office & manager), Nest (room staff tablet), Egg (parents) and Seed (HR & your own record). Each “adds to home screen” like a proper app and keeps working even if the wifi drops.',
      why: 'Different jobs need different screens — a big office dashboard, a tap-friendly tablet, a parent’s phone. Splitting them also means a parent can never land on a staff screen.',
      without: 'One cramped website trying to be everything to everyone, with no offline safety net in the rooms.',
      fail: 'If the wifi drops mid-observation, the app quietly saves your work on the device and sends it up the moment you’re back online. Nothing you typed is lost.'
    },
    {
      key: 'ai', icon: '🧠', accent: '#f59e0b',
      title: 'On-site AI & memory', tag: 'Clever, but private',
      summary: 'The AI runs on our own computer — family data is never sent to ChatGPT or any cloud AI.',
      what: 'Wren’s AI helps draft observations, summarise reports and answer questions. It runs entirely on the nursery’s own AI computer, with a private “memory” of your own approved documents.',
      why: 'So you get the help of AI without ever handing a child’s name or photo to an outside company. Private by design, not just by promise.',
      without: 'Either no AI help at all, or sending sensitive family information off to a third-party service — which we will not do.',
      fail: 'If the AI computer is busy or off, Wren simply carries on without the suggestions. You can always write things yourself — the AI is a helper, never a gatekeeper.'
    },
    {
      key: 'integrations', icon: '🔌', accent: '#2dd4bf',
      title: 'Trusted connections', tag: 'The useful links out',
      summary: 'Wren links to a few trusted services for money, messages and the phone — carefully and on purpose.',
      what: 'Xero (the accounts), GoCardless (parents’ direct-debit fees), Telegram (instant staff alerts), the AI phone receptionist and the door intercom / clock-in. Each is a deliberate, limited connection.',
      why: 'These are jobs best done by specialists — collecting fees, keeping the books, answering the door. Wren hands each one exactly what it needs and nothing more.',
      without: 'Chasing fees by hand, re-keying every payment into the accounts, and missing calls at the front door.',
      fail: 'Each link is optional and kept separate. If Xero or the phone service is down, the rest of Wren carries on completely as normal — nothing essential depends on them.'
    },
    {
      key: 'backups', icon: '💾', accent: '#22c55e',
      title: 'Safety net & secure support', tag: 'Nightly backups, tested weekly',
      summary: 'Everything is backed up every night, the restore is rehearsed weekly, and the box is reachable securely for support.',
      what: 'The whole database is copied every night (and every few hours), kept safe, and a full restore is test-run once a week to prove the backups really work. The office can reach the box securely from anywhere over a private, encrypted network to help.',
      why: 'A backup you’ve never restored isn’t really a backup. Rehearsing it every week means a bad day is an inconvenience, not a disaster.',
      without: 'One failure and you’re rebuilding records from paper and memory.',
      fail: 'The private network has no open doors to the internet, so “remote support” never means “exposed to strangers”. And if a weekly restore test ever failed, we’d know straight away and fix it.'
    }
  ];

  // "Life of a child registration" — each step notes why it can't half-happen.
  var JOURNEY = [
    { icon: '📝', title: 'Parent submits the form', detail: 'A parent — or the office — fills in the child’s registration once.', guarantee: 'One form, entered one time.' },
    { icon: '🔒', title: 'Saved as one transaction', detail: 'Wren writes the new child in a single all-or-nothing step.', guarantee: 'It fully saves or not at all — never a half-made child.' },
    { icon: '👀', title: 'Appears everywhere at once', detail: 'The child instantly shows on the daily register, the room diary and the kitchen’s list.', guarantee: 'One source of truth — no screen is left out of date.' },
    { icon: '🧑‍🏫', title: 'A key person is assigned', detail: 'The child is linked to their key person and their room.', guarantee: 'The link lives in the database, so every screen agrees who’s responsible.' },
    { icon: '✉️', title: 'Parent gets their Egg invite', detail: 'The parent is invited to the parents’ app, matched to their child by email.', guarantee: 'Access is granted by the record — a parent only ever sees their own child.' },
    { icon: '💷', title: 'Funding is checked', detail: 'Any funded hours are picked up, ready for the next return.', guarantee: 'It’s all one record, so funding can’t point at a child who doesn’t exist.' }
  ];

  // "Why it rarely goes wrong" — the safety principles.
  var PRINCIPLES = [
    { icon: '🔒', title: 'All-or-nothing saves', body: 'Every change is a “transaction” — it completes fully or not at all. A dropped connection mid-save can never leave a half-written, corrupted record.' },
    { icon: '➕', title: 'We only ever add', body: 'Updates add new things; they don’t rewrite what already works. Existing registers, menus and data are left untouched — the golden rule of every Wren build.' },
    { icon: '💾', title: 'Backed up & rehearsed', body: 'Copied every night, and a restore is actually rehearsed each week — so we know the safety net works before we ever need it.' },
    { icon: '📴', title: 'Offline-first', body: 'The room apps keep working without wifi and sync up later, so a flaky signal in the garden never loses an observation.' },
    { icon: '🏠', title: 'Your data stays here', body: 'Everything lives on-site, on your own hardware. No third-party cloud, no outside AI — a genuinely simple GDPR story.' },
    { icon: '🛡️', title: 'Everyone sees only their part', body: 'Roles decide what each person can open. Parents can’t reach staff screens; only managers sign off medicine and safeguarding.' }
  ];

  // ── Styles (scoped under .hww) ──────────────────────────────────────────────────
  var CSS = [
    '.hww{--hww-bg:#0f172a;--hww-card:#1e293b;--hww-card2:#172033;--hww-bd:#2d3748;--hww-tx:#f1f5f9;--hww-mut:#94a3b8;--hww-blue:#4a9abf;--hww-org:#e07820;--hww-grn:#22c55e;--hww-amb:#f59e0b;--hww-red:#ef4444;',
    'font-family:system-ui,Arial,sans-serif;color:var(--hww-tx);max-width:1180px;margin:0 auto;line-height:1.5}',
    '.hww *{box-sizing:border-box}',
    '.hww h2,.hww h3,.hww .hww-hh{font-family:"Arial Rounded MT Bold","Nunito",Arial,sans-serif}',
    /* intro */
    '.hww-intro{background:linear-gradient(135deg,#12243a,#0f172a);border:1px solid var(--hww-bd);border-radius:14px;padding:18px 20px;margin:0 0 14px;color:#cbd5e1;font-size:.95rem}',
    '.hww-intro b{color:var(--hww-blue)}',
    '.hww-controls{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px}',
    '.hww-btn{appearance:none;cursor:pointer;background:var(--hww-card);border:1px solid var(--hww-bd);color:var(--hww-tx);border-radius:12px;padding:9px 15px;font-size:.85rem;font-weight:700;min-height:44px;transition:.15s ease}',
    '.hww-btn:hover{border-color:var(--hww-blue);background:#243247}',
    '.hww-btn.hww-primary{background:var(--hww-blue);border-color:var(--hww-blue);color:#fff}',
    '.hww-btn.hww-primary:hover{background:#3d87ab}',
    /* section titles */
    '.hww-sec{margin:30px 0 12px}',
    '.hww-sec h2{font-size:1.28rem;margin:0 0 3px;color:var(--hww-tx)}',
    '.hww-sec p{margin:0;color:var(--hww-mut);font-size:.9rem}',
    /* the stack */
    '.hww-stack{display:flex;flex-direction:column;gap:0}',
    '.hww-band{background:var(--hww-card);border:1px solid var(--hww-bd);border-left:5px solid var(--band,#4a9abf);border-radius:12px;overflow:hidden}',
    '.hww-band-head{width:100%;display:flex;align-items:center;gap:14px;padding:14px 16px;background:none;border:0;color:inherit;cursor:pointer;text-align:left;font:inherit;min-height:44px}',
    '.hww-band-head:hover{background:#22304a}',
    '.hww-chip{flex:0 0 auto;width:46px;height:46px;border-radius:12px;display:grid;place-items:center;font-size:1.5rem;background:color-mix(in srgb,var(--band) 20%,transparent);border:1px solid color-mix(in srgb,var(--band) 45%,transparent)}',
    '.hww-band-t{flex:1 1 auto;min-width:0}',
    '.hww-band-title{font-weight:800;font-size:1.04rem;display:flex;align-items:center;gap:9px;flex-wrap:wrap}',
    '.hww-tag{font-size:.66rem;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--band);border:1px solid color-mix(in srgb,var(--band) 45%,transparent);border-radius:20px;padding:2px 9px;white-space:nowrap}',
    '.hww-band-sum{color:#cbd5e1;font-size:.88rem;margin-top:3px}',
    '.hww-caret{flex:0 0 auto;color:var(--hww-mut);font-size:1.1rem;transition:transform .2s ease}',
    '.hww-band.hww-open .hww-caret{transform:rotate(90deg)}',
    '.hww-detail{max-height:0;overflow:hidden;transition:max-height .28s ease;background:var(--hww-card2)}',
    '.hww-band.hww-open .hww-detail{max-height:1600px}',
    '.hww-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:6px 16px 16px}',
    '.hww-cell{background:var(--hww-bg);border:1px solid var(--hww-bd);border-radius:10px;padding:11px 13px}',
    '.hww-cell .hww-lab{font-size:.7rem;font-weight:800;text-transform:uppercase;letter-spacing:.05em;margin:0 0 4px;display:flex;align-items:center;gap:6px}',
    '.hww-cell p{margin:0;font-size:.86rem;color:#dbe4ef;line-height:1.5}',
    '.hww-c-what .hww-lab{color:var(--hww-grn)} .hww-c-why .hww-lab{color:var(--hww-blue)}',
    '.hww-c-without .hww-lab{color:var(--hww-amb)} .hww-c-fail .hww-lab{color:#f9a8d4}',
    '.hww-c-fail{border-color:#3a2a3a;background:#1a1420}',
    /* connector between bands */
    '.hww-conn{height:20px;display:grid;place-items:center;color:var(--hww-bd)}',
    '.hww-conn::before{content:"";width:2px;height:100%;background:linear-gradient(var(--hww-bd),var(--hww-bd))}',
    /* journey strip */
    '.hww-journey{display:flex;gap:10px;flex-wrap:wrap;align-items:stretch}',
    '.hww-step{flex:1 1 300px;background:var(--hww-card);border:1px solid var(--hww-bd);border-radius:12px;padding:13px 14px;position:relative;display:flex;flex-direction:column;gap:6px}',
    '.hww-step-top{display:flex;align-items:center;gap:10px}',
    '.hww-num{flex:0 0 auto;width:26px;height:26px;border-radius:50%;background:var(--hww-blue);color:#fff;font-weight:800;font-size:.85rem;display:grid;place-items:center}',
    '.hww-step-ic{font-size:1.25rem}',
    '.hww-step h4{margin:0;font-size:.94rem;font-weight:800;flex:1}',
    '.hww-step p{margin:0;font-size:.83rem;color:#cbd5e1}',
    '.hww-guar{margin-top:auto;font-size:.76rem;color:#bbf7d0;background:#0f2318;border:1px solid #14532d;border-radius:8px;padding:6px 9px;display:flex;gap:6px;align-items:flex-start}',
    '.hww-guar::before{content:"✓";color:var(--hww-grn);font-weight:900}',
    /* principles */
    '.hww-princ{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}',
    '.hww-pcard{background:var(--hww-card);border:1px solid var(--hww-bd);border-radius:12px;padding:15px 16px}',
    '.hww-pcard .hww-pic{font-size:1.5rem}',
    '.hww-pcard h4{margin:6px 0 4px;font-size:.98rem;font-weight:800}',
    '.hww-pcard p{margin:0;font-size:.85rem;color:#cbd5e1}',
    /* footer */
    '.hww-foot{margin:26px 0 4px;padding:14px 16px;border:1px dashed var(--hww-bd);border-radius:12px;color:var(--hww-mut);font-size:.78rem;text-align:center;line-height:1.7}',
    '.hww-foot b{color:var(--hww-blue)}',
    /* narrow screens */
    '@media (max-width:640px){.hww-grid{grid-template-columns:1fr}.hww-band-sum{font-size:.85rem}}',
    /* ── PRINT: A3 landscape, ink-saving light, reveal everything ── */
    '@media print{',
    '  @page{size:A3 landscape;margin:12mm}',
    '  .hww{max-width:none;color:#0f172a}',
    '  .hww-controls,.hww-caret{display:none!important}',
    '  .hww-intro{background:#eef4fb!important;color:#1e293b;border-color:#c9d8e8}',
    '  .hww-intro b{color:#1d6c8c}',
    '  .hww-sec h2{color:#0f172a} .hww-sec p{color:#475569}',
    '  .hww-band,.hww-step,.hww-pcard{background:#fff!important;border-color:#cbd5e1;break-inside:avoid;page-break-inside:avoid}',
    '  .hww-band-title,.hww-step h4,.hww-pcard h4{color:#0f172a}',
    '  .hww-band-sum,.hww-step p,.hww-pcard p,.hww-cell p{color:#1e293b!important}',
    '  .hww-detail{max-height:none!important;overflow:visible!important;background:#f8fafc!important}',
    '  .hww-cell{background:#fff!important;border-color:#d7dee7}',
    '  .hww-c-fail{background:#fff7fb!important;border-color:#e6cdd9}',
    '  .hww-guar{background:#eefaf0!important;color:#14532d;border-color:#bbe6c4}',
    '  .hww-conn{height:10px} .hww-conn::before{background:#cbd5e1}',
    '  .hww-foot{color:#475569;border-color:#cbd5e1}',
    '}'
  ].join('\n');

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function bandHTML(l, i) {
    return (
      (i > 0 ? '<div class="hww-conn" aria-hidden="true"></div>' : '') +
      '<section class="hww-band" style="--band:' + l.accent + '" data-key="' + l.key + '">' +
        '<button class="hww-band-head" type="button" aria-expanded="false">' +
          '<span class="hww-chip" aria-hidden="true">' + l.icon + '</span>' +
          '<span class="hww-band-t">' +
            '<span class="hww-band-title">' + esc(l.title) + ' <span class="hww-tag">' + esc(l.tag) + '</span></span>' +
            '<span class="hww-band-sum">' + esc(l.summary) + '</span>' +
          '</span>' +
          '<span class="hww-caret" aria-hidden="true">›</span>' +
        '</button>' +
        '<div class="hww-detail">' +
          '<div class="hww-grid">' +
            '<div class="hww-cell hww-c-what"><p class="hww-lab">✓ What it does</p><p>' + esc(l.what) + '</p></div>' +
            '<div class="hww-cell hww-c-why"><p class="hww-lab">★ Why it’s here</p><p>' + esc(l.why) + '</p></div>' +
            '<div class="hww-cell hww-c-without"><p class="hww-lab">✗ Without it</p><p>' + esc(l.without) + '</p></div>' +
            '<div class="hww-cell hww-c-fail"><p class="hww-lab">\u{1F6E1} If it fails</p><p>' + esc(l.fail) + '</p></div>' +
          '</div>' +
        '</div>' +
      '</section>'
    );
  }

  function journeyHTML(s, i) {
    return (
      '<div class="hww-step">' +
        '<div class="hww-step-top">' +
          '<span class="hww-num">' + (i + 1) + '</span>' +
          '<span class="hww-step-ic" aria-hidden="true">' + s.icon + '</span>' +
          '<h4>' + esc(s.title) + '</h4>' +
        '</div>' +
        '<p>' + esc(s.detail) + '</p>' +
        '<div class="hww-guar">' + esc(s.guarantee) + '</div>' +
      '</div>'
    );
  }

  function princHTML(p) {
    return (
      '<div class="hww-pcard">' +
        '<div class="hww-pic" aria-hidden="true">' + p.icon + '</div>' +
        '<h4>' + esc(p.title) + '</h4>' +
        '<p>' + esc(p.body) + '</p>' +
      '</div>'
    );
  }

  // b144 — the footer names a real nursery (Your Nursery), which is correct for
  // LADN's own internal staff-training copy but must not leak into a prospect
  // demo. window.HWW_DEMO (set inline by the EY page, sync, no flicker) takes
  // priority; the shared Roost admin page has no per-edition HTML so it falls
  // back to an /api/edition fetch (every edition's route reports `demo`).
  // Default (no signal at all) stays LADN's real footer — current behaviour,
  // zero risk if this never resolves.
  function footerHTML(demo) {
    return demo
      ? ('<div class="hww-foot">' +
          '<b>Your Nursery</b> — runs on Wren, on your own hardware. Your data stays in the building. ' +
          '<span style="opacity:.8">This page is for staff training.</span>' +
        '</div>')
      : ('<div class="hww-foot">' +
          '<b>Your Nursery</b> — 123 Example Lane, Your Town, AB1 2CD<br>' +
          'Runs on Wren, on your own hardware. Your data stays in the building. ' +
          '<span style="opacity:.8">This page is for staff training — as at July 2026.</span>' +
        '</div>');
  }

  function render(target) {
    var root = typeof target === 'string' ? document.querySelector(target) : target;
    if (!root) return;
    if (document.getElementById('hww-styles') == null) {
      var st = document.createElement('style');
      st.id = 'hww-styles';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    var demo = window.HWW_DEMO === true;
    root.classList.add('hww');
    root.innerHTML =
      '<div class="hww-intro">' +
        '<b>What is this?</b> A plain-English tour of the system that runs your nursery — every part, what it does, ' +
        'why it’s there, and why there are so few ways for it to go wrong. Tap any block to see the detail. ' +
        'Great for INSET and for reassuring yourself (or a parent) that the data is safe. ' +
        '<span style="white-space:nowrap">Use “Print” for an A3 handout.</span>' +
      '</div>' +

      '<div class="hww-controls">' +
        '<button class="hww-btn hww-primary" type="button" data-act="toggle-all">Expand all</button>' +
        '<button class="hww-btn" type="button" data-act="print">\u{1F5A8} Print / Save as PDF</button>' +
      '</div>' +

      '<div class="hww-sec"><h2>The layers, top to bottom</h2><p>Each layer rests on the one below it. Tap a block for what it does, why we chose it, and why a failure stays contained.</p></div>' +
      '<div class="hww-stack">' + LAYERS.map(bandHTML).join('') + '</div>' +

      '<div class="hww-sec"><h2>Life of a child registration</h2><p>Follow one new child through the system — and see why each step can’t half-happen.</p></div>' +
      '<div class="hww-journey">' + JOURNEY.map(journeyHTML).join('') + '</div>' +

      '<div class="hww-sec"><h2>Why it rarely goes wrong</h2><p>The safety habits built into every part of Wren.</p></div>' +
      '<div class="hww-princ">' + PRINCIPLES.map(princHTML).join('') + '</div>' +

      footerHTML(demo);

    // If no explicit signal was set (shared Roost admin page, no per-edition HTML),
    // ask the server once and patch the footer if this turns out to be a demo.
    if (window.HWW_DEMO === undefined) {
      fetch('/api/edition').then(function (r) { return r.json(); }).then(function (d) {
        if (d && d.demo === true) {
          var foot = root.querySelector('.hww-foot');
          if (foot) foot.outerHTML = footerHTML(true);
        }
      }).catch(function () {});
    }

    // ── Interactions ──────────────────────────────────────────────────────────────
    var heads = root.querySelectorAll('.hww-band-head');
    function setBand(band, open) {
      band.classList.toggle('hww-open', open);
      var h = band.querySelector('.hww-band-head');
      if (h) h.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    heads.forEach(function (h) {
      h.addEventListener('click', function () {
        var band = h.closest('.hww-band');
        setBand(band, !band.classList.contains('hww-open'));
        syncToggleLabel();
      });
    });

    var toggleBtn = root.querySelector('[data-act="toggle-all"]');
    function allOpen() {
      var bands = root.querySelectorAll('.hww-band');
      return bands.length > 0 && Array.prototype.every.call(bands, function (b) { return b.classList.contains('hww-open'); });
    }
    function syncToggleLabel() { if (toggleBtn) toggleBtn.textContent = allOpen() ? 'Collapse all' : 'Expand all'; }
    if (toggleBtn) toggleBtn.addEventListener('click', function () {
      var open = !allOpen();
      root.querySelectorAll('.hww-band').forEach(function (b) { setBand(b, open); });
      syncToggleLabel();
    });

    var printBtn = root.querySelector('[data-act="print"]');
    if (printBtn) printBtn.addEventListener('click', function () { window.print(); });

    // Open the first band by default so the page never looks empty.
    var first = root.querySelector('.hww-band');
    if (first) setBand(first, true);
    syncToggleLabel();
  }

  window.HowWrenWorks = { render: render, LAYERS: LAYERS };

  // Auto-render if a mount point is already on the page (both host pages provide #hww-root).
  function auto() {
    var el = document.getElementById('hww-root');
    if (el && !el.classList.contains('hww')) render(el);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto);
  else auto();
})();
