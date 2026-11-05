'use strict';
// b155 — SEN child panel: register overview, SMART targets, APDR cycles, Play Plan.
// Shared component mounted on both the EY child profile (cp-panel-sen) and the
// Roost SEN register page's expanded child view — same API, same markup, so the
// two portals never drift. Requires window.Wren (api/toast) to already be loaded.
(function () {
  var SEND_AREAS = ['Communication & Interaction', 'Cognition & Learning',
    'Social, Emotional & Mental Health', 'Sensory/Physical'];
  var STYLE_ID = 'wren-sen-panel-style';

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function api(u, o) { return Wren.api(u, o); }
  function toast(m, k) { if (window.Wren && Wren.toast) Wren.toast(m, k); }
  function fmtD(d) { return d ? new Date(d).toLocaleDateString('en-GB') : ''; }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent =
      '.sen-p-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;border-bottom:1px solid var(--c-border,#2d3748);padding-bottom:8px}' +
      '.sen-p-tab{padding:7px 12px;border-radius:8px 8px 0 0;font-size:.82rem;background:transparent;border:none;color:var(--c-muted,#94a3b8);cursor:pointer}' +
      '.sen-p-tab.active{background:var(--c-surface,#1e293b);color:var(--c-text,#f1f5f9);font-weight:600;box-shadow:inset 0 -2px 0 var(--c-blue,#4a9abf)}' +
      '.sen-p-panel{display:none}.sen-p-panel.active{display:block}' +
      '.sen-p-card{background:var(--c-surface,#1e293b);border:1px solid var(--c-border,#2d3748);border-radius:12px;padding:14px 16px;margin-bottom:12px}' +
      '.sen-p-area-head{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--c-blue,#7dd3fc);margin-bottom:6px}' +
      '.sen-p-field label{display:block;font-size:.76rem;color:var(--c-muted,#94a3b8);margin:8px 0 3px}' +
      '.sen-p-field input,.sen-p-field select,.sen-p-field textarea{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:7px;' +
      'border:1px solid var(--c-border,#2d3748);background:var(--c-bg,#0f172a);color:var(--c-text,#f1f5f9);font-size:.85rem}' +
      '.sen-p-checks{display:flex;gap:10px;flex-wrap:wrap;margin-top:4px}.sen-p-checks label{display:flex;align-items:center;gap:5px;font-size:.8rem;margin:0}' +
      '.sen-p-badge{display:inline-block;font-size:.68rem;font-weight:700;padding:3px 9px;border-radius:6px;margin-right:6px}' +
      '.st-active{background:#4a9abf22;color:#7dd3fc}.st-achieved{background:#22c55e22;color:#86efac}.st-discontinued{background:#64748b22;color:#94a3b8}' +
      '.st-open{background:#f59e0b22;color:#fbbf24}.st-closed{background:#64748b22;color:#94a3b8}' +
      '.sen-p-btn{font-size:.78rem;padding:6px 12px;border-radius:7px;border:1px solid var(--c-border,#2d3748);background:var(--c-surface,#1e293b);color:var(--c-text,#cbd5e1);cursor:pointer}' +
      '.sen-p-btn:hover{border-color:var(--c-blue,#4a9abf)}.sen-p-btn-primary{background:var(--c-blue,#4a9abf);color:#fff;border-color:var(--c-blue,#4a9abf)}' +
      '.sen-p-muted{color:var(--c-muted,#64748b);font-size:.82rem}' +
      '.sen-p-playplan{background:#fff;color:#1a2e23;border-radius:12px;padding:20px}' +
      '.sen-p-playplan h3{font-family:Georgia,serif;color:#2d5a4a;margin:0 0 4px}' +
      '.sen-p-playplan .pp-area{border:1px solid #e5decf;border-radius:10px;padding:12px;margin-bottom:10px}' +
      '.sen-p-playplan .pp-area h4{margin:0 0 6px;color:#2d5a4a}' +
      '@media print{.sen-p-tabs,.sen-p-noprint{display:none!important}.sen-p-playplan{color:#000}}';
    document.head.appendChild(s);
  }

  function State(childId, opts) {
    this.childId = childId;
    this.opts = opts || {};
    this.canEditRegister = !!this.opts.isSenco;
  }

  function shell() {
    return (
      '<div class="sen-p-tabs">' +
        '<button class="sen-p-tab active" data-t="overview">Overview</button>' +
        '<button class="sen-p-tab" data-t="targets">Targets</button>' +
        '<button class="sen-p-tab" data-t="apdr">APDR</button>' +
        '<button class="sen-p-tab" data-t="playplan">Play Plan</button>' +
        // b256 — what we are actually TRYING, from the toolkit. Added as a fifth
        // tab; the four above are untouched.
        '<button class="sen-p-tab" data-t="strategies">Strategies</button>' +
      '</div>' +
      '<div class="sen-p-panel active" data-p="overview"></div>' +
      '<div class="sen-p-panel" data-p="targets"></div>' +
      '<div class="sen-p-panel" data-p="apdr"></div>' +
      '<div class="sen-p-panel" data-p="playplan"></div>' +
      '<div class="sen-p-panel" data-p="strategies"></div>'
    );
  }

  function wireTabs(root, st) {
    root.querySelectorAll('.sen-p-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        root.querySelectorAll('.sen-p-tab').forEach(function (b) { b.classList.toggle('active', b === btn); });
        var t = btn.dataset.t;
        root.querySelectorAll('.sen-p-panel').forEach(function (p) { p.classList.toggle('active', p.dataset.p === t); });
        if (t === 'targets' && !root._targetsLoaded) { root._targetsLoaded = true; loadTargets(root, st); }
        if (t === 'apdr' && !root._apdrLoaded) { root._apdrLoaded = true; loadApdr(root, st); }
        if (t === 'playplan' && !root._ppLoaded) { root._ppLoaded = true; loadPlayPlan(root, st); }
        if (t === 'strategies' && !root._stratLoaded) { root._stratLoaded = true; loadStrategies(root, st); }
      });
    });
  }

  // ── Overview ─────────────────────────────────────────────────────────────────
  function loadOverview(root, st) {
    var panel = root.querySelector('[data-p="overview"]');
    panel.innerHTML = '<p class="sen-p-muted">Loading…</p>';
    api('/api/sen/child/' + st.childId).then(function (r) {
      st.register = r;
      renderOverview(panel, st);
    }).catch(function () { panel.innerHTML = '<p class="sen-p-muted">Could not load.</p>'; });
  }

  function renderOverview(panel, st) {
    var r = st.register;
    if (!r) {
      panel.innerHTML = '<div class="sen-p-card"><p class="sen-p-muted">Not currently on the SEND register.</p>' +
        (st.canEditRegister ? '<button class="sen-p-btn sen-p-btn-primary" id="sen-p-add">+ Add to register</button>' : '') +
        '</div>';
      var addBtn = panel.querySelector('#sen-p-add');
      if (addBtn) addBtn.addEventListener('click', function () { addToRegister(panel, st); });
      return;
    }
    var areas = (r.areas_of_need || []).map(function (a) { return '<span class="sen-p-badge st-active">' + esc(a) + '</span>'; }).join('');
    var agencies = Object.keys(r.outside_agencies || {}).filter(function (k) { return r.outside_agencies[k] === true; });
    var termly = (r.termly_updates || []).slice(-3).reverse().map(function (t) {
      return '<div class="sen-p-muted">' + esc(t.term) + ' ' + esc(t.year) + ' — ' + fmtD(t.date) + (t.note ? ': ' + esc(t.note) : '') + '</div>';
    }).join('');
    panel.innerHTML =
      '<div class="sen-p-card">' +
        '<span class="sen-p-badge st-active">' + esc(r.status || 'monitoring') + '</span>' +
        (r.sen_type === 'ehcp' ? '<span class="sen-p-badge" style="background:#ef444422;color:#fca5a5">EHCP</span>' : '') +
        '<div style="margin-top:8px">' + areas + '</div>' +
        (r.primary_need ? '<div style="margin-top:8px">' + esc(r.primary_need) + '</div>' : '') +
        '<div class="sen-p-muted" style="margin-top:8px">' +
          'Added ' + fmtD(r.date_added_to_register) +
          (r.review_date ? ' · Review ' + fmtD(r.review_date) : '') +
          (r.first_plan_date ? ' · First plan ' + fmtD(r.first_plan_date) : '') +
          ' · Plan #' + (r.current_plan_number || 1) +
        '</div>' +
        '<div class="sen-p-muted" style="margin-top:6px">' +
          'Parental consent: ' + (r.parental_consent ? '✓ ' + fmtD(r.parental_consent_date) : '✕') +
          ' · SENIF: ' + (r.senif_applied ? '✓' : '✕') + ' · EHCNA: ' + (r.ehcna_applied ? '✓' : '✕') +
        '</div>' +
        (agencies.length ? '<div class="sen-p-muted" style="margin-top:6px">Outside agencies: ' + agencies.map(esc).join(', ') + '</div>' : '') +
        (termly ? '<div style="margin-top:10px"><div class="sen-p-area-head">Termly updates</div>' + termly + '</div>' : '') +
        (st.canEditRegister ? '<div style="margin-top:12px"><button class="sen-p-btn" id="sen-p-termly">+ Termly update</button></div>' : '') +
      '</div>';
    var termlyBtn = panel.querySelector('#sen-p-termly');
    if (termlyBtn) termlyBtn.addEventListener('click', function () { addTermlyUpdate(panel, st); });
  }

  function addToRegister(panel, st) {
    var term = SEND_AREAS.map(function (a) {
      return '<label style="display:block;margin:4px 0"><input type="checkbox" value="' + esc(a) + '"> ' + esc(a) + '</label>';
    }).join('');
    Wren.modal('Add to SEND register',
      '<div class="sen-p-field">' +
        '<label>Status</label><select id="sen-p-rstatus"><option value="monitoring">Monitoring</option><option value="diagnosed">Diagnosed</option></select>' +
        '<label>SEN type</label><select id="sen-p-rtype"><option value="sen_support">SEN Support</option><option value="ehcp">EHCP</option><option value="monitoring">Monitoring</option></select>' +
        '<label>Area(s) of need</label>' + term +
        '<label>Primary need</label><textarea id="sen-p-rneed" rows="2"></textarea>' +
        '<div style="margin-top:12px;text-align:right"><button class="sen-p-btn sen-p-btn-primary" id="sen-p-rsave">Add</button></div>' +
      '</div>');
    var overlay = document.querySelector('.wren-modal-overlay');
    overlay.querySelector('#sen-p-rsave').addEventListener('click', function () {
      var areas = Array.from(overlay.querySelectorAll('input[type=checkbox]:checked')).map(function (i) { return i.value; });
      api('/api/sen', { method: 'POST', body: {
        child_id: st.childId, status: overlay.querySelector('#sen-p-rstatus').value,
        sen_type: overlay.querySelector('#sen-p-rtype').value, areas_of_need: areas,
        primary_need: overlay.querySelector('#sen-p-rneed').value.trim() || null,
      }}).then(function (res) {
        if (res && res.id) { toast('Added to register', 'success'); overlay.querySelector('.modal-close').click(); loadOverview(panel.parentNode, st); }
        else toast((res && res.error) || 'Could not add', 'error');
      });
    });
  }

  function addTermlyUpdate(panel, st) {
    var now = new Date();
    var term = (now.getMonth() >= 8 || now.getMonth() <= 0) ? 'Autumn' : (now.getMonth() <= 3 ? 'Spring' : 'Summer');
    Wren.modal('Termly update',
      '<div class="sen-p-field">' +
        '<label>Term</label><select id="sen-p-tuterm"><option>Autumn</option><option>Spring</option><option>Summer</option></select>' +
        '<label>Note</label><textarea id="sen-p-tunote" rows="3"></textarea>' +
        '<div style="margin-top:12px;text-align:right"><button class="sen-p-btn sen-p-btn-primary" id="sen-p-tusave">Save</button></div>' +
      '</div>');
    var overlay = document.querySelector('.wren-modal-overlay');
    overlay.querySelector('#sen-p-tuterm').value = term;
    overlay.querySelector('#sen-p-tusave').addEventListener('click', function () {
      api('/api/sen/' + st.register.id + '/termly-update', { method: 'POST', body: {
        term: overlay.querySelector('#sen-p-tuterm').value, note: overlay.querySelector('#sen-p-tunote').value.trim() || null
      }}).then(function (res) {
        if (res && res.id) { toast('Termly update saved', 'success'); overlay.querySelector('.modal-close').click(); loadOverview(panel.parentNode, st); }
        else toast((res && res.error) || 'Could not save', 'error');
      });
    });
  }

  // ── Targets ──────────────────────────────────────────────────────────────────
  function loadTargets(root, st) {
    var panel = root.querySelector('[data-p="targets"]');
    panel.innerHTML = '<p class="sen-p-muted">Loading…</p>';
    Promise.all([
      api('/api/sen/child/' + st.childId + '/targets').catch(function () { return []; }),
      api('/api/sen/child/' + st.childId + '/suggested-activities').catch(function () { return null; }),
    ]).then(function (res) { renderTargets(panel, st, res[0], res[1]); });
  }

  function renderTargets(panel, st, targets, suggestions) {
    var byArea = {};
    SEND_AREAS.forEach(function (a) { byArea[a] = []; });
    (targets || []).forEach(function (t) { (byArea[t.area] = byArea[t.area] || []).push(t); });

    var html = '<div class="sen-p-card sen-p-noprint"><button class="sen-p-btn sen-p-btn-primary" id="sen-p-addtarget">+ Add target</button></div>';
    SEND_AREAS.forEach(function (area) {
      var list = byArea[area] || [];
      html += '<div class="sen-p-card"><div class="sen-p-area-head">' + esc(area) + '</div>';
      if (!list.length) html += '<p class="sen-p-muted">No targets yet.</p>';
      list.forEach(function (t) {
        html += '<div style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--c-border,#2d3748)" data-target-id="' + t.id + '">' +
          '<span class="sen-p-badge st-' + esc(t.status) + '">' + esc(t.status) + '</span>' + esc(t.target_text) +
          (t.measure_text ? '<div class="sen-p-muted">📏 How we will know: ' + esc(t.measure_text) + '</div>' : '') +
          (t.review_date || t.review_term ? '<div class="sen-p-muted">Review ' +
            (t.review_term ? esc(t.review_term) + ' term' : '') +
            (t.review_date ? (t.review_term ? ' · ' : '') + fmtD(t.review_date) : '') + '</div>' : '') +
          (t.ways_to_help_nursery ? '<div class="sen-p-muted">🏫 ' + esc(t.ways_to_help_nursery) + '</div>' : '') +
          (t.ways_to_help_home ? '<div class="sen-p-muted">🏠 ' + esc(t.ways_to_help_home) + '</div>' : '') +
          (t.status === 'active' ? '<div style="margin-top:6px"><button class="sen-p-btn" data-achieve="' + t.id + '">✓ Achieved</button> ' +
            '<button class="sen-p-btn" data-discontinue="' + t.id + '">Discontinue</button></div>' : '') +
        '</div>';
      });
      html += '</div>';
    });

    if (suggestions && suggestions.activities && suggestions.activities.length) {
      html += '<div class="sen-p-card sen-p-noprint"><div class="sen-p-area-head">💡 Suggested from activity bank (' + esc((suggestions.focus_areas || []).join(', ')) + ')</div>' +
        suggestions.activities.map(function (a) {
          return '<div style="margin-bottom:6px">' + esc(a.title) + '</div>';
        }).join('') + '</div>';
    }
    html += '<div class="sen-p-card sen-p-noprint"><div class="sen-p-area-head">💡 Generate an original idea</div>' +
      '<select id="sen-p-genarea">' + SEND_AREAS.map(function (a) { return '<option value="' + esc(a) + '">' + esc(a) + '</option>'; }).join('') + '</select> ' +
      '<button class="sen-p-btn" id="sen-p-genbtn" style="margin-top:8px">Generate</button>' +
      '<div id="sen-p-genresult" style="margin-top:10px"></div></div>';

    panel.innerHTML = html;

    panel.querySelector('#sen-p-addtarget').addEventListener('click', function () { addTarget(panel, st); });
    panel.querySelectorAll('[data-achieve]').forEach(function (b) {
      b.addEventListener('click', function () { patchTarget(panel, st, b.dataset.achieve, { status: 'achieved' }); });
    });
    panel.querySelectorAll('[data-discontinue]').forEach(function (b) {
      b.addEventListener('click', function () { patchTarget(panel, st, b.dataset.discontinue, { status: 'discontinued' }); });
    });
    panel.querySelector('#sen-p-genbtn').addEventListener('click', function () {
      var area = panel.querySelector('#sen-p-genarea').value;
      var out = panel.querySelector('#sen-p-genresult');
      out.innerHTML = '<p class="sen-p-muted">Thinking (local AI, may take up to a minute)…</p>';
      api('/api/sen/child/' + st.childId + '/suggested-activities/generate', { method: 'POST', body: { area: area } })
        .then(function (idea) {
          if (!idea || idea.error) { out.innerHTML = '<p class="sen-p-muted">AI unavailable right now.</p>'; return; }
          out.innerHTML = '<div style="font-weight:700">' + esc(idea.title) + '</div>' +
            '<div style="margin:4px 0">' + esc(idea.description) + '</div>' +
            (idea.ways_to_help_nursery ? '<div class="sen-p-muted">🏫 ' + esc(idea.ways_to_help_nursery) + '</div>' : '') +
            (idea.ways_to_help_home ? '<div class="sen-p-muted">🏠 ' + esc(idea.ways_to_help_home) + '</div>' : '') +
            '<div class="sen-p-muted" style="margin-top:6px;font-style:italic">' + esc(idea.disclaimer || '') + '</div>';
        }).catch(function () { out.innerHTML = '<p class="sen-p-muted">AI unavailable right now.</p>'; });
    });
  }

  function addTarget(panel, st) {
    Wren.modal('Add SMART target',
      '<div class="sen-p-field">' +
        '<label>Area</label><select id="sen-p-tarea">' + SEND_AREAS.map(function (a) { return '<option value="' + esc(a) + '">' + esc(a) + '</option>'; }).join('') + '</select>' +
        '<label>Target (specific, measurable, achievable, relevant, time-bound)</label><textarea id="sen-p-ttext" rows="2"></textarea>' +
        // b256 §2 — Abbey's SMART sheet: "Measurable — you can observe the
        // improvement/progress in this area". b155 named SMART in the label above
        // and then captured no measure at all, so nothing on screen said how
        // anybody would know. This is the field that makes a target reviewable.
        '<label>How will you know it is working? (the M in SMART)</label><textarea id="sen-p-tmeasure" rows="2" placeholder="e.g. uses the board at two transitions a day without being asked"></textarea>' +
        '<label>Review date</label><input type="date" id="sen-p-trev">' +
        // b256 §2 — "Time related: reviewed at least termly".
        '<label>Review term</label><select id="sen-p-tterm"><option value="">—</option><option>Autumn</option><option>Spring</option><option>Summer</option></select>' +
        '<label>Ways to help — Nursery</label><textarea id="sen-p-tnursery" rows="2"></textarea>' +
        '<label>Ways to help — Home</label><textarea id="sen-p-thome" rows="2"></textarea>' +
        '<div style="margin-top:12px;text-align:right"><button class="sen-p-btn sen-p-btn-primary" id="sen-p-tsave">Add</button></div>' +
      '</div>');
    var overlay = document.querySelector('.wren-modal-overlay');
    overlay.querySelector('#sen-p-tsave').addEventListener('click', function () {
      var text = overlay.querySelector('#sen-p-ttext').value.trim();
      if (!text) { toast('Target text required', 'warning'); return; }
      api('/api/sen/child/' + st.childId + '/targets', { method: 'POST', body: {
        area: overlay.querySelector('#sen-p-tarea').value, target_text: text,
        measure_text: overlay.querySelector('#sen-p-tmeasure').value.trim() || null,
        review_term: overlay.querySelector('#sen-p-tterm').value || null,
        review_date: overlay.querySelector('#sen-p-trev').value || null,
        ways_to_help_nursery: overlay.querySelector('#sen-p-tnursery').value.trim() || null,
        ways_to_help_home: overlay.querySelector('#sen-p-thome').value.trim() || null,
      }}).then(function (res) {
        if (res && res.id) { toast('Target added', 'success'); overlay.querySelector('.modal-close').click(); loadTargets(panel.parentNode, st); }
        else toast((res && res.error) || 'Could not add', 'error');
      });
    });
  }

  function patchTarget(panel, st, id, body) {
    api('/api/sen/targets/' + id, { method: 'PATCH', body: body }).then(function (res) {
      if (res && res.id) { toast('Updated', 'success'); loadTargets(panel.parentNode, st); }
      else toast((res && res.error) || 'Could not update', 'error');
    });
  }

  // ── APDR ─────────────────────────────────────────────────────────────────────
  function loadApdr(root, st) {
    var panel = root.querySelector('[data-p="apdr"]');
    panel.innerHTML = '<p class="sen-p-muted">Loading…</p>';
    api('/api/sen/child/' + st.childId + '/apdr').then(function (cycles) { renderApdr(panel, st, cycles); })
      .catch(function () { panel.innerHTML = '<p class="sen-p-muted">Could not load.</p>'; });
  }

  function renderApdr(panel, st, cycles) {
    var html = '<div class="sen-p-card sen-p-noprint"><button class="sen-p-btn sen-p-btn-primary" id="sen-p-newcycle">+ Open new APDR cycle</button></div>';
    (cycles || []).forEach(function (c) {
      html += '<div class="sen-p-card" data-cycle="' + c.id + '">' +
        '<span class="sen-p-badge st-' + esc(c.status) + '">' + esc(c.status) + '</span>' +
        '<b>Cycle ' + c.cycle_number + '</b>' +
        // b256 §2 — the review DUE date. b155 only ever had a review_date written
        // at close, so an open cycle had no due date and nothing could say it was
        // overdue. Overdue is called out here rather than left for someone to
        // notice.
        (c.review_due_date ? '<div class="sen-p-muted">Review due ' + fmtD(c.review_due_date) +
          (c.status === 'open' && new Date(c.review_due_date) < new Date()
            ? ' <span class="sen-p-badge" style="border:1px solid var(--c-red,#ef4444);color:var(--c-red,#ef4444)">overdue</span>' : '') +
          '</div>' : '') +
        '<div class="sen-p-field"><label>Assess — what we know about their skills</label><div>' + esc(c.assess_text || '—') + '</div></div>' +
        (c.parent_views ? '<div class="sen-p-field"><label>Parents’ views</label><div>' + esc(c.parent_views) + '</div></div>' : '') +
        (c.practitioner_views ? '<div class="sen-p-field"><label>Other practitioners’ views</label><div>' + esc(c.practitioner_views) + '</div></div>' : '') +
        '<div class="sen-p-field"><label>Plan — the outcomes they are working towards</label><div>' + esc(c.plan_text || '—') + '</div></div>' +
        '<div class="sen-p-field"><label>Do — the who/what/when/how</label><div>' + esc(c.do_text || '—') + '</div></div>' +
        (c.review_text ? '<div class="sen-p-field"><label>Review</label><div>' + esc(c.review_text) + '</div></div>' : '') +
        // b256 §2 — "Your APDR should be shared with parents and relevant staff
        // members." An inspector asks when; b155 could only evidence that for a
        // Play Plan.
        '<div class="sen-p-muted" style="margin-top:6px">Shared with parents: ' +
          (c.shared_with_parents_on ? fmtD(c.shared_with_parents_on) : 'not yet') +
          ' · with staff: ' + (c.shared_with_staff_on ? fmtD(c.shared_with_staff_on) : 'not yet') + '</div>' +
        (c.targets && c.targets.length ? '<div class="sen-p-muted" style="margin-top:6px">Targets in this cycle: ' + c.targets.map(function (t) { return esc(t.target_text); }).join('; ') + '</div>' : '') +
        (c.reviews && c.reviews.length ? '<div style="margin-top:8px"><div class="sen-p-area-head">Review log</div>' +
          c.reviews.map(function (r) { return '<div class="sen-p-muted">' + fmtD(r.review_date) + ' — ' + esc(r.notes || '') + (r.staff_name ? ' (' + esc(r.staff_name) + ')' : '') + '</div>'; }).join('') +
          '</div>' : '') +
        (c.status === 'open' ? '<div class="sen-p-noprint" style="margin-top:10px">' +
          '<button class="sen-p-btn" data-log="' + c.id + '">+ Review note</button> ' +
          (c.shared_with_parents_on ? '' : '<button class="sen-p-btn" data-shareparents="' + c.id + '">Shared with parents today</button> ') +
          (c.shared_with_staff_on ? '' : '<button class="sen-p-btn" data-sharestaff="' + c.id + '">Shared with staff today</button> ') +
          '<button class="sen-p-btn sen-p-btn-primary" data-close="' + c.id + '">Close cycle (formal review)</button></div>' : '') +
      '</div>';
    });
    if (!cycles || !cycles.length) html += '<p class="sen-p-muted">No APDR cycles yet.</p>';
    panel.innerHTML = html;
    var newBtn = panel.querySelector('#sen-p-newcycle');
    if (newBtn) newBtn.addEventListener('click', function () { openCycle(panel, st); });
    panel.querySelectorAll('[data-log]').forEach(function (b) { b.addEventListener('click', function () { logReview(panel, st, b.dataset.log); }); });
    panel.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', function () { closeCycle(panel, st, b.dataset.close); }); });
    // b256 §2 — stamp today's date against "shared with parents / staff".
    function stampShare(id, field) {
      var body = {}; body[field] = new Date().toISOString().slice(0, 10);
      api('/api/sen/apdr/' + id, { method: 'PATCH', body: body }).then(function (res) {
        if (res && res.id) { toast('Recorded', 'success'); loadApdr(panel.parentNode, st); }
        else toast((res && res.error) || 'Could not record that', 'error');
      });
    }
    panel.querySelectorAll('[data-shareparents]').forEach(function (b) {
      b.addEventListener('click', function () { stampShare(b.dataset.shareparents, 'shared_with_parents_on'); });
    });
    panel.querySelectorAll('[data-sharestaff]').forEach(function (b) {
      b.addEventListener('click', function () { stampShare(b.dataset.sharestaff, 'shared_with_staff_on'); });
    });
  }

  function openCycle(panel, st) {
    // b256 §2 — Abbey's IEP header carries "Date of review" (set when the cycle
    // OPENS, not when it closes), and the form itself prompts for the parents'
    // and other practitioners' views BEFORE the plan is written: "you should use
    // these to prioritise your plans". b155 had none of the three.
    Wren.modal('Open APDR cycle',
      '<div class="sen-p-field">' +
        '<label>Assess — what we know about their skills</label><textarea id="sen-p-ca" rows="2"></textarea>' +
        '<label>Parents’ views</label><textarea id="sen-p-cpv" rows="2" placeholder="What the family have told you — this is what you prioritise the plan against"></textarea>' +
        '<label>Other practitioners’ views</label><textarea id="sen-p-cprv" rows="2" placeholder="Key person, room team, SALT/OT if involved"></textarea>' +
        '<label>Plan — the outcomes they are working towards</label><textarea id="sen-p-cp" rows="2"></textarea>' +
        '<label>Do — the who/what/when/how</label><textarea id="sen-p-cd" rows="2"></textarea>' +
        '<label>Date of review</label><input type="date" id="sen-p-cdue">' +
        '<div style="margin-top:12px;text-align:right"><button class="sen-p-btn sen-p-btn-primary" id="sen-p-csave">Open</button></div>' +
      '</div>');
    var overlay = document.querySelector('.wren-modal-overlay');
    overlay.querySelector('#sen-p-csave').addEventListener('click', function () {
      api('/api/sen/child/' + st.childId + '/apdr', { method: 'POST', body: {
        assess_text: overlay.querySelector('#sen-p-ca').value.trim() || null,
        plan_text: overlay.querySelector('#sen-p-cp').value.trim() || null,
        do_text: overlay.querySelector('#sen-p-cd').value.trim() || null,
        parent_views: overlay.querySelector('#sen-p-cpv').value.trim() || null,
        practitioner_views: overlay.querySelector('#sen-p-cprv').value.trim() || null,
        review_due_date: overlay.querySelector('#sen-p-cdue').value || null,
      }}).then(function (res) {
        if (res && res.id) { toast('Cycle opened', 'success'); overlay.querySelector('.modal-close').click(); loadApdr(panel.parentNode, st); }
        else toast((res && res.error) || 'Could not open', 'error');
      });
    });
  }

  function logReview(panel, st, cycleId) {
    Wren.modal('Review note',
      '<div class="sen-p-field"><label>Notes</label><textarea id="sen-p-lognotes" rows="3"></textarea>' +
      '<div style="margin-top:12px;text-align:right"><button class="sen-p-btn sen-p-btn-primary" id="sen-p-logsave">Save</button></div></div>');
    var overlay = document.querySelector('.wren-modal-overlay');
    overlay.querySelector('#sen-p-logsave').addEventListener('click', function () {
      api('/api/sen/apdr/' + cycleId + '/review-log', { method: 'POST', body: { notes: overlay.querySelector('#sen-p-lognotes').value.trim() || null } })
        .then(function (res) {
          if (res && res.id) { toast('Saved', 'success'); overlay.querySelector('.modal-close').click(); loadApdr(panel.parentNode, st); }
          else toast((res && res.error) || 'Could not save', 'error');
        });
    });
  }

  function closeCycle(panel, st, cycleId) {
    var cycle = (st._cycles || []).find ? null : null;
    api('/api/sen/child/' + st.childId + '/targets').then(function (targets) {
      var active = (targets || []).filter(function (t) { return t.apdr_cycle_id == cycleId && t.status === 'active'; });
      var rows = active.map(function (t) {
        return '<div style="margin:6px 0"><div>' + esc(t.target_text) + '</div>' +
          '<select data-outcome-for="' + t.id + '"><option value="continue">Continue</option><option value="achieved">Achieved</option><option value="discontinued">Discontinued</option></select></div>';
      }).join('') || '<p class="sen-p-muted">No open targets linked to this cycle.</p>';
      Wren.modal('Close APDR cycle — formal review',
        '<div class="sen-p-field">' +
          '<label>Review notes</label><textarea id="sen-p-closereview" rows="3"></textarea>' +
          '<div class="sen-p-area-head" style="margin-top:10px">Target outcomes</div>' + rows +
          '<div style="margin-top:12px;text-align:right"><button class="sen-p-btn sen-p-btn-primary" id="sen-p-closesave">Close &amp; open next cycle</button></div>' +
        '</div>');
      var overlay = document.querySelector('.wren-modal-overlay');
      overlay.querySelector('#sen-p-closesave').addEventListener('click', function () {
        var outcomes = active.map(function (t) {
          var sel = overlay.querySelector('[data-outcome-for="' + t.id + '"]');
          return { target_id: t.id, outcome: sel ? sel.value : 'continue' };
        });
        api('/api/sen/apdr/' + cycleId + '/close', { method: 'POST', body: {
          review_text: overlay.querySelector('#sen-p-closereview').value.trim() || null, target_outcomes: outcomes
        }}).then(function (res) {
          if (res && res.closed_cycle) { toast('Cycle closed, next cycle opened', 'success'); overlay.querySelector('.modal-close').click(); loadApdr(panel.parentNode, st); }
          else toast((res && res.error) || 'Could not close', 'error');
        });
      });
    });
  }

  // ── Play Plan ────────────────────────────────────────────────────────────────
  function loadPlayPlan(root, st) {
    var panel = root.querySelector('[data-p="playplan"]');
    panel.innerHTML = '<p class="sen-p-muted">Loading…</p>';
    api('/api/sen/child/' + st.childId + '/play-plan/latest').then(function (pp) { renderPlayPlan(panel, st, pp); })
      .catch(function () { panel.innerHTML = '<p class="sen-p-muted">Could not load.</p>'; });
  }

  function renderPlayPlan(panel, st, pp) {
    var actions = '<div class="sen-p-card sen-p-noprint">' +
      '<button class="sen-p-btn sen-p-btn-primary" id="sen-p-genplan">Generate new Play Plan</button> ';
    if (pp) {
      actions += '<button class="sen-p-btn" id="sen-p-printplan">🖨️ Print</button> ';
      if (!pp.shared_with_parent) actions += '<button class="sen-p-btn" id="sen-p-shareplan">Share with parent</button>';
      else actions += '<span class="sen-p-muted">Shared with parent ' + fmtD(pp.shared_at) + '</span>';
    }
    actions += '</div>';

    if (!pp) { panel.innerHTML = actions + '<p class="sen-p-muted">No Play Plan generated yet.</p>'; wirePlanActions(panel, st, pp); return; }

    var s = pp.snapshot;
    // b256 §2 — Abbey's review page has a SETTING column and a HOME column, and
    // her "Parental view on progress" is FOUR boxes, one per area. b155 built
    // only the setting side and stored one free-text blob. Both live on the plan
    // ROW (the family fills them in after the plan is generated), so they are
    // merged over the snapshot here rather than baked into it.
    var homeByArea = pp.home_achieved_by_area || {};
    var pvByArea = pp.parent_feedback_by_area || {};

    var areasHtml = (s.areas || []).map(function (a) {
      var home = homeByArea[a.area];
      var pv = pvByArea[a.area];
      return '<div class="pp-area">' +
        '<h4>' + esc(a.area) + '</h4>' +
        (a.targets.length ? '<div><b>Targets:</b><ul>' + a.targets.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>' : '<div class="sen-p-muted">No active targets</div>') +
        (a.measures && a.measures.length ? '<div><b>How we will know:</b> ' + a.measures.map(esc).join('; ') + '</div>' : '') +
        (a.ways_to_help_nursery.length ? '<div><b>Nursery:</b> ' + a.ways_to_help_nursery.map(esc).join('; ') + '</div>' : '') +
        (a.ways_to_help_home.length ? '<div><b>Home:</b> ' + a.ways_to_help_home.map(esc).join('; ') + '</div>' : '') +
        (a.achieved.length ? '<div style="margin-top:6px"><b>Achieved at nursery:</b> ' + a.achieved.map(esc).join('; ') + '</div>' : '') +
        (home ? '<div style="margin-top:6px"><b>Achieved at home:</b> ' + esc(home) + '</div>' : '') +
        (pv ? '<div style="margin-top:6px"><b>Parents’ view:</b> ' + esc(pv) + '</div>' : '') +
      '</div>';
    }).join('');

    panel.innerHTML = actions +
      '<div class="sen-p-playplan">' +
        // b256 §2 — "Picture of Child" is a box on page 1 of Abbey's template.
        // Only present where photo consent is recorded (the server decides).
        ((pp.child_photo_url || s.child_photo_url)
          ? '<img src="' + esc(pp.child_photo_url || s.child_photo_url) + '" alt="" ' +
            'style="width:96px;height:96px;object-fit:cover;border-radius:12px;float:right;margin:0 0 10px 12px">'
          : '') +
        '<h3>I’m ' + esc(s.child_name) + ', this is my Play Plan</h3>' +
        '<p>' + esc(s.key_person_name || '') + ' is my key person · Generated ' + fmtD(s.generated_on) +
          (pp.target_date ? ' · Targets to achieve by ' + fmtD(pp.target_date) : '') +
          (pp.review_date ? ' · Review ' + fmtD(pp.review_date) : '') + '</p>' +
        areasHtml +
        (pp.parent_feedback ? '<div class="pp-area"><h4>Parental view on progress</h4><p>' + esc(pp.parent_feedback) + '</p><p class="sen-p-muted">' + fmtD(pp.parent_feedback_at) + '</p></div>' : '') +
      '</div>';
    wirePlanActions(panel, st, pp);
  }

  function wirePlanActions(panel, st, pp) {
    var gen = panel.querySelector('#sen-p-genplan');
    if (gen) gen.addEventListener('click', function () {
      // b256 §2 — Abbey's plan is dated twice: "targets I want to achieve by
      // (date)" and "this is what I have achieved (review date)". b155 asked for
      // neither and sent an empty body.
      Wren.modal('Generate a Play Plan',
        '<div class="sen-p-field">' +
          '<label>Targets to be achieved by</label><input type="date" id="sen-p-pptarget">' +
          '<label>Review date</label><input type="date" id="sen-p-pprev">' +
          '<div style="margin-top:12px;text-align:right"><button class="sen-p-btn sen-p-btn-primary" id="sen-p-ppgo">Generate</button></div>' +
        '</div>');
      var ov = document.querySelector('.wren-modal-overlay');
      ov.querySelector('#sen-p-ppgo').addEventListener('click', function () {
        api('/api/sen/child/' + st.childId + '/play-plan/generate', { method: 'POST', body: {
          target_date: ov.querySelector('#sen-p-pptarget').value || null,
          review_date: ov.querySelector('#sen-p-pprev').value || null,
        }}).then(function (res) {
          if (res && res.id) {
            toast('Play Plan generated', 'success');
            var c = ov.querySelector('.modal-close'); if (c) c.click();
            loadPlayPlan(panel.parentNode, st);
          } else toast((res && res.error) || 'Could not generate', 'error');
        });
      });
    });
    var pr = panel.querySelector('#sen-p-printplan');
    if (pr) pr.addEventListener('click', function () { window.print(); });
    var sh = panel.querySelector('#sen-p-shareplan');
    if (sh) sh.addEventListener('click', function () {
      api('/api/sen/play-plan/' + pp.id + '/share', { method: 'POST' }).then(function (res) {
        if (res && res.id) { toast('Shared with parent', 'success'); loadPlayPlan(panel.parentNode, st); }
        else toast((res && res.error) || 'Could not share', 'error');
      });
    });
  }

  // ── Strategies (b256) ────────────────────────────────────────────────────────
  // What we are TRYING with this child, from the toolkit. The link runs one way:
  // this child's plan → a strategy. Nothing here writes to the toolkit, and the
  // toolkit never learns whose plan it is on.
  var LINK_STATUS_LABEL = { trying: 'Trying', working: 'Helping',
    not_working: 'Not helping', stopped: 'Stopped' };

  function loadStrategies(root, st) {
    var panel = root.querySelector('[data-p="strategies"]');
    panel.innerHTML = '<p class="sen-p-muted">Loading…</p>';
    api('/api/sen/child/' + st.childId + '/strategies')
      .then(function (rows) { renderStrategies(panel, st, rows); })
      .catch(function () { panel.innerHTML = '<p class="sen-p-muted">Could not load.</p>'; });
  }

  function renderStrategies(panel, st, rows) {
    rows = rows || [];
    var html = '<div class="sen-p-card sen-p-noprint">' +
      '<div class="sen-p-area-head">🧰 From the SEN toolkit</div>' +
      '<p class="sen-p-muted">Strategies attached to this child’s Play Plan targets and APDR cycles. ' +
      'Browse the whole library and attach one from the toolkit itself.</p>' +
      '<a class="sen-p-btn sen-p-btn-primary" style="display:inline-block;text-decoration:none;margin-top:8px" ' +
      'href="/ey/sen-toolkit">Open the toolkit</a></div>';

    if (!rows.length) {
      html += '<p class="sen-p-muted">Nothing attached yet.</p>';
      panel.innerHTML = html;
      return;
    }

    rows.forEach(function (r) {
      html += '<div class="sen-p-card" data-link="' + r.id + '">' +
        '<span class="sen-p-badge st-' + (r.status === 'working' ? 'achieved'
          : r.status === 'stopped' ? 'discontinued' : 'active') + '">' +
          esc(LINK_STATUS_LABEL[r.status] || r.status) + '</span>' +
        '<b>' + esc(r.title) + '</b>' +
        (r.strategy_is_active === false ? ' <span class="sen-p-badge st-discontinued">retired from the toolkit</span>' : '') +
        '<div class="sen-p-muted" style="margin-top:4px">' + esc(r.area) + '</div>' +
        (r.target_text ? '<div class="sen-p-muted">🎯 ' + esc(r.target_text) + '</div>' : '') +
        (r.cycle_number ? '<div class="sen-p-muted">APDR cycle ' + r.cycle_number + '</div>' : '') +
        (r.note ? '<div style="margin-top:6px">' + esc(r.note) + '</div>' : '') +
        (r.licensed ? '<div class="sen-p-muted" style="margin-top:6px">⚠️ ' + esc(r.licence_note || 'Licensed / training needed') + '</div>' : '') +
        // The escalation line travels with the attached strategy on purpose:
        // knowing when to stop is the half a busy practitioner forgets.
        '<div class="sen-p-muted" style="margin-top:6px"><b>When to escalate:</b> ' + esc(r.when_to_escalate) + '</div>' +
        '<div class="sen-p-muted" style="margin-top:4px">Added ' + fmtD(r.created_at) +
          (r.created_by_name ? ' by ' + esc(r.created_by_name) : '') +
          (r.shared_with_parent ? ' · shared with the family ' + fmtD(r.shared_at) : '') + '</div>' +
        '<div class="sen-p-noprint" style="margin-top:8px">' +
          (r.status !== 'working' ? '<button class="sen-p-btn" data-mark="working" data-id="' + r.id + '">✓ It is helping</button> ' : '') +
          (r.status !== 'not_working' ? '<button class="sen-p-btn" data-mark="not_working" data-id="' + r.id + '">Not helping</button> ' : '') +
          (r.status !== 'stopped' ? '<button class="sen-p-btn" data-mark="stopped" data-id="' + r.id + '">Stop</button> ' : '') +
          '<button class="sen-p-btn" data-share="' + r.id + '" data-to="' + (r.shared_with_parent ? '0' : '1') + '">' +
            (r.shared_with_parent ? 'Stop sharing with the family' : 'Share with the family') + '</button> ' +
          '<a class="sen-p-btn" style="text-decoration:none" href="/ey/sen-toolkit?s=' + encodeURIComponent(r.slug) + '">Read it</a>' +
        '</div>' +
      '</div>';
    });
    panel.innerHTML = html;

    function patch(id, body) {
      api('/api/sen/strategies/link/' + id, { method: 'PATCH', body: body }).then(function (res) {
        if (res && res.id) { toast('Updated', 'success'); loadStrategies(panel.parentNode, st); }
        else toast((res && res.error) || 'Could not update', 'error');
      });
    }
    panel.querySelectorAll('[data-mark]').forEach(function (b) {
      b.addEventListener('click', function () { patch(b.dataset.id, { status: b.dataset.mark }); });
    });
    panel.querySelectorAll('[data-share]').forEach(function (b) {
      b.addEventListener('click', function () {
        patch(b.dataset.share, { shared_with_parent: b.dataset.to === '1' });
      });
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  function mount(container, childId, opts) {
    ensureStyle();
    var st = new State(childId, opts);
    container.innerHTML = shell();
    wireTabs(container, st);
    loadOverview(container, st);
  }

  window.WrenSenPanel = { mount: mount };
}());
