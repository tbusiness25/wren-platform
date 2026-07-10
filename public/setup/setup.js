/* Wren first-run setup wizard — client (prompt 67). CSP-safe: no inline handlers. */
(function () {
  'use strict';

  var API = '/api/setup';
  var state = {
    status: null,
    order: [],           // ordered step names for this edition
    idx: 0,
    frameworks: null,
    phonics: null,
    modules: null,
    counts: { staff: 0, rooms: 0, children: 0 },
    lastManagerCount: 0,
  };

  // ── tiny fetch helper (plain fetch — no auth needed on the setup API) ─────────
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    return fetch(API + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) { var e = new Error(d.error || ('HTTP ' + r.status)); e.data = d; throw e; }
        return d;
      });
    });
  }
  function toast(msg, type) {
    if (window.Wren && Wren.toast) Wren.toast(msg, type || 'info');
    else if (type === 'error') alert(msg);
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

  var FAMILY_LABEL = { eyfs: 'Early Years / Nursery', primary: 'Primary School', secondary: 'Secondary School' };
  var STAFF_ROLES = [
    ['manager', 'Manager'], ['deputy_manager', 'Deputy manager'],
    ['practitioner', 'Practitioner'], ['teacher', 'Teacher'], ['ta', 'Teaching assistant'],
    ['senco', 'SENCO'], ['business_manager', 'Business manager'],
  ];

  // ── boot ──────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    api('/status').then(function (st) {
      state.status = st;
      $('#setup-loading').hidden = true;
      $('#setup-root').hidden = false;
      if (st.setup_complete) { showDone(); return; }
      buildOrder();
      wireChrome();
      return Promise.all([loadFrameworks(), loadPhonics(), loadModules()]).then(function () {
        renderStaticSteps();
        resume();
      });
    }).catch(function (e) {
      $('#setup-loading').textContent = 'Could not load setup: ' + (e.message || e);
    });
  });

  function showDone() {
    $('#wz-footer').hidden = true;
    $('.wz-progress').style.visibility = 'hidden';
    showStep('done');
  }

  function buildOrder() {
    var o = ['welcome', 'framework'];
    if (state.status.phonics_enabled) o.push('phonics');
    o = o.concat(['staff', 'rooms', 'children', 'modules', 'review']);
    state.order = o;
    var inst = state.status.setting_name;
    if (inst) $('#wz-instance').textContent = inst;
    $('#f-setting-type').textContent = FAMILY_LABEL[state.status.edition_family] || state.status.edition_family || '—';
  }

  // ── data loaders ────────────────────────────────────────────────────────────
  function loadFrameworks() { return api('/frameworks').then(function (d) { state.frameworks = d; }); }
  function loadPhonics() {
    if (!state.status.phonics_enabled) return Promise.resolve();
    return api('/phonics-schemes').then(function (d) { state.phonics = d; });
  }
  function loadModules() { return api('/modules').then(function (d) { state.modules = d; }); }

  // ── render steps that are data-driven ───────────────────────────────────────
  function renderStaticSteps() {
    renderFramework();
    if (state.status.phonics_enabled) renderPhonics();
    renderModules();
    renderStaffRow();     // seed one staff row
    renderRoomRow();      // seed one room row
    wireImports();
    wireLogo();
    // prefill welcome
    if (state.status.setting_name) $('#f-setting-name').value = state.status.setting_name;
  }

  function renderFramework() {
    var fw = state.frameworks;
    var ul = $('#f-statutory'); ul.innerHTML = '';
    fw.statutory.forEach(function (s) { ul.appendChild(el('li', null, s.label)); });
    var grid = $('#f-overlays'); grid.innerHTML = '';
    fw.overlays.forEach(function (o) {
      var lab = el('label', 'wz-check' + (o.available ? '' : ' is-disabled'));
      var cb = el('input'); cb.type = 'checkbox'; cb.value = o.key;
      cb.checked = !!o.checked && o.available; cb.disabled = !o.available;
      cb.dataset.overlay = '1';
      lab.appendChild(cb);
      lab.appendChild(el('span', null, o.label + (o.available ? '' : ' (not seeded)')));
      grid.appendChild(lab);
    });
  }

  function renderPhonics() {
    var list = $('#f-phonics'); list.innerHTML = '';
    var current = state.phonics.scheme;
    (state.phonics.schemes || []).forEach(function (s) {
      var lab = el('label', 'wz-radio');
      var r = el('input'); r.type = 'radio'; r.name = 'phonics'; r.value = s.id;
      if (current === s.id) { r.checked = true; lab.classList.add('is-selected'); }
      lab.appendChild(r);
      lab.appendChild(el('span', null, s.name));
      var badge = el('span', 'wz-badge' + (s.validated ? ' ok' : ''), s.validated ? 'DfE validated' : '');
      lab.appendChild(badge);
      r.addEventListener('change', function () {
        list.querySelectorAll('.wz-radio').forEach(function (x) { x.classList.remove('is-selected'); });
        lab.classList.add('is-selected');
      });
      list.appendChild(lab);
    });
  }

  function renderModules() {
    var grid = $('#f-modules'); grid.innerHTML = '';
    (state.modules.optional || []).forEach(function (m) {
      var lab = el('label', 'wz-check');
      var cb = el('input'); cb.type = 'checkbox'; cb.value = m.key; cb.checked = m.enabled !== false;
      cb.dataset.module = '1';
      lab.appendChild(cb); lab.appendChild(el('span', null, m.label));
      grid.appendChild(lab);
    });
    var lgrid = $('#f-modules-locked'); lgrid.innerHTML = '';
    (state.modules.locked || []).forEach(function (m) {
      var lab = el('label', 'wz-check is-disabled');
      var cb = el('input'); cb.type = 'checkbox'; cb.checked = true; cb.disabled = true;
      lab.appendChild(cb); lab.appendChild(el('span', null, m.label));
      lgrid.appendChild(lab);
    });
  }

  // ── staff / rooms manual rows ───────────────────────────────────────────────
  function renderStaffRow(prefillManager) {
    var wrap = $('#staff-rows');
    var row = el('div', 'wz-entry');
    row.innerHTML =
      '<input class="wz-input j-first" placeholder="First name" autocomplete="off">' +
      '<input class="wz-input j-last" placeholder="Last name" autocomplete="off">' +
      '<input class="wz-input wz-full j-email" placeholder="Email (optional)" autocomplete="off">' +
      '<select class="wz-input j-role"></select>' +
      '<input class="wz-input j-pin" placeholder="PIN (4 or 6 digits)" inputmode="numeric" autocomplete="off">';
    var sel = row.querySelector('.j-role');
    STAFF_ROLES.forEach(function (r) { var o = el('option', null, r[1]); o.value = r[0]; sel.appendChild(o); });
    if (prefillManager || wrap.children.length === 0) sel.value = 'manager';
    var del = el('button', 'wz-entry-del', '✕'); del.type = 'button';
    del.addEventListener('click', function () { row.remove(); });
    row.appendChild(del);
    wrap.appendChild(row);
  }
  function renderRoomRow() {
    var wrap = $('#rooms-rows');
    var row = el('div', 'wz-entry');
    row.innerHTML =
      '<input class="wz-input wz-full j-name" placeholder="Room / class name" autocomplete="off">' +
      '<input class="wz-input j-cap" placeholder="Capacity" inputmode="numeric" autocomplete="off">' +
      '<input class="wz-input j-yg" placeholder="Year group (optional)" autocomplete="off">';
    var del = el('button', 'wz-entry-del', '✕'); del.type = 'button';
    del.addEventListener('click', function () { row.remove(); });
    row.appendChild(del);
    wrap.appendChild(row);
  }

  // ── CSV import wiring ───────────────────────────────────────────────────────
  var csvData = { staff: null, rooms: null, children: null };
  function parseCSV(text) {
    var lines = text.replace(/\r/g, '').split('\n').filter(function (l) { return l.trim() !== ''; });
    if (!lines.length) return [];
    function splitLine(l) {
      var out = [], cur = '', q = false;
      for (var i = 0; i < l.length; i++) {
        var ch = l[i];
        if (q) { if (ch === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
        else { if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; }
      }
      out.push(cur); return out.map(function (s) { return s.trim(); });
    }
    var headers = splitLine(lines[0]).map(function (h) { return h.toLowerCase().replace(/\s+/g, '_'); });
    return lines.slice(1).map(function (l) {
      var cols = splitLine(l), obj = {};
      headers.forEach(function (h, i) { obj[h] = cols[i] != null ? cols[i] : ''; });
      return obj;
    });
  }
  function previewTable(container, rows) {
    container.innerHTML = '';
    if (!rows.length) { container.textContent = 'No rows found.'; return; }
    var keys = Object.keys(rows[0]);
    var tbl = el('table'), thead = el('thead'), htr = el('tr');
    keys.forEach(function (k) { htr.appendChild(el('th', null, k)); });
    thead.appendChild(htr); tbl.appendChild(thead);
    var tb = el('tbody');
    rows.slice(0, 20).forEach(function (r) {
      var tr = el('tr'); keys.forEach(function (k) { tr.appendChild(el('td', null, r[k] || '')); });
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); container.appendChild(tbl);
    container.appendChild(el('div', null, rows.length + ' row(s) ready to import.'));
  }
  function wireImports() {
    [['staff-csv-file', 'staff-csv-preview', 'staff'],
     ['rooms-csv-file', 'rooms-csv-preview', 'rooms'],
     ['children-csv-file', 'children-csv-preview', 'children']].forEach(function (t) {
      var input = document.getElementById(t[0]); if (!input) return;
      input.addEventListener('change', function () {
        var f = input.files[0]; if (!f) return;
        var rd = new FileReader();
        rd.onload = function () {
          var rows = parseCSV(String(rd.result));
          csvData[t[2]] = rows;
          previewTable(document.getElementById(t[1]), rows);
        };
        rd.readAsText(f);
      });
    });
    // mode tabs
    document.querySelectorAll('.wz-mode-tabs').forEach(function (tabs) {
      var group = tabs.parentElement;
      tabs.querySelectorAll('.wz-tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
          tabs.querySelectorAll('.wz-tab').forEach(function (x) { x.classList.remove('is-active'); });
          tab.classList.add('is-active');
          group.querySelectorAll('.wz-mode').forEach(function (m) { m.hidden = (m.dataset.mode !== tab.dataset.mode); });
        });
      });
    });
    $('#staff-add-row').addEventListener('click', function () { renderStaffRow(); });
    $('#rooms-add-row').addEventListener('click', function () { renderRoomRow(); });
  }

  function wireLogo() {
    var file = $('#f-logo-file'), img = $('#f-logo-preview'), clear = $('#f-logo-clear');
    var stored = { logo: null };
    file.addEventListener('change', function () {
      var f = file.files[0]; if (!f) return;
      if (f.size > 1600000) { toast('Logo too large (max ~1.5MB)', 'error'); return; }
      var rd = new FileReader();
      rd.onload = function () { stored.logo = String(rd.result); img.src = stored.logo; img.hidden = false; clear.hidden = false; };
      rd.readAsDataURL(f);
    });
    clear.addEventListener('click', function () { stored.logo = null; img.hidden = true; clear.hidden = true; file.value = ''; });
    state._logo = stored;
  }

  // ── chrome / navigation ─────────────────────────────────────────────────────
  function wireChrome() {
    $('#wz-back').addEventListener('click', goBack);
    $('#wz-next').addEventListener('click', goNext);
    $('#wz-skip').addEventListener('click', function () { advance(); });
  }

  function currentStep() { return state.order[state.idx]; }

  function showStep(name) {
    document.querySelectorAll('.wz-step').forEach(function (s) { s.hidden = (s.dataset.step !== name); });
  }

  function renderNav() {
    var name = currentStep();
    var isFirst = state.idx === 0;
    var isReview = name === 'review';
    $('#wz-back').style.visibility = isFirst ? 'hidden' : 'visible';
    $('#wz-next').textContent = isReview ? 'Finish setup' : 'Next';
    var skippable = ['phonics', 'staff', 'rooms', 'children'];
    $('#wz-skip').hidden = skippable.indexOf(name) === -1;
    // progress
    var total = state.order.length;
    $('#wz-progress-fill').style.width = Math.round((state.idx) / (total - 1) * 100) + '%';
    $('#wz-progress-label').textContent = 'Step ' + (state.idx + 1) + ' of ' + total;
  }

  function gotoIdx(i) {
    state.idx = Math.max(0, Math.min(state.order.length - 1, i));
    var name = currentStep();
    showStep(name);
    if (name === 'review') renderReview();
    renderNav();
    window.scrollTo(0, 0);
  }
  function goBack() { if (state.idx > 0) gotoIdx(state.idx - 1); }
  function advance() { if (state.idx < state.order.length - 1) gotoIdx(state.idx + 1); else finish(); }

  function resume() {
    var done = state.status.steps_done || [];
    var i = 0;
    for (; i < state.order.length; i++) {
      if (state.order[i] === 'review') break;
      if (done.indexOf(state.order[i]) === -1) break;
    }
    gotoIdx(i);
  }

  // ── Next: validate + persist the current step, then advance ─────────────────
  function goNext() {
    var name = currentStep();
    var btn = $('#wz-next'); btn.disabled = true;
    var p;
    switch (name) {
      case 'welcome':   p = saveWelcome(); break;
      case 'framework': p = saveFramework(); break;
      case 'phonics':   p = savePhonics(); break;
      case 'staff':     p = saveStaff(); break;
      case 'rooms':     p = saveRooms(); break;
      case 'children':  p = saveChildren(); break;
      case 'modules':   p = saveModules(); break;
      case 'review':    p = finish().then(function () { return { _noAdvance: true }; }); break;
      default:          p = Promise.resolve();
    }
    p.then(function (r) {
      btn.disabled = false;
      if (r && r._noAdvance) return;
      advance();
    }).catch(function (e) {
      btn.disabled = false;
      toast(e.message || 'Something went wrong', 'error');
    });
  }

  // ── per-step save ───────────────────────────────────────────────────────────
  function saveWelcome() {
    var name = $('#f-setting-name').value.trim();
    var body = {
      setting_name: name,
      timezone: $('#f-timezone').value,
      term_dates: $('#f-term-dates').value.trim(),
    };
    if (state._logo && state._logo.logo) body.logo = state._logo.logo;
    return api('/step/welcome', { method: 'POST', body: body }).then(function () {
      if (name) $('#wz-instance').textContent = name;
    });
  }
  function saveFramework() {
    var overlays = [];
    document.querySelectorAll('#f-overlays input[data-overlay]').forEach(function (cb) { if (cb.checked) overlays.push(cb.value); });
    return api('/step/framework', { method: 'POST', body: { overlays: overlays } });
  }
  function savePhonics() {
    var sel = document.querySelector('#f-phonics input[name="phonics"]:checked');
    if (!sel) return Promise.resolve();               // nothing chosen — allowed
    return api('/step/phonics', { method: 'POST', body: { scheme: sel.value } });
  }
  function saveModules() {
    var mods = {};
    document.querySelectorAll('#f-modules input[data-module]').forEach(function (cb) { mods[cb.value] = cb.checked; });
    return api('/step/modules', { method: 'POST', body: { modules: mods } });
  }
  function collectStaff() {
    var rows = [];
    document.querySelectorAll('#staff-rows .wz-entry').forEach(function (r) {
      var first = r.querySelector('.j-first').value.trim();
      var last = r.querySelector('.j-last').value.trim();
      if (!first && !last) return;
      rows.push({ first_name: first, last_name: last,
        email: r.querySelector('.j-email').value.trim(),
        role: r.querySelector('.j-role').value,
        pin: r.querySelector('.j-pin').value.trim() });
    });
    return rows;
  }
  function saveStaff() {
    var mode = document.querySelector('.wz-mode-tabs[data-group="staff"] .wz-tab.is-active').dataset.mode;
    var rows = mode === 'csv' ? (csvData.staff || []) : collectStaff();
    if (!rows.length) return Promise.resolve();       // nothing entered — user can skip/continue
    return api('/staff', { method: 'POST', body: { staff: rows } }).then(function (d) {
      state.counts.staff += (d.created || []).length;
      state.lastManagerCount = d.manager_count || 0;
      var st = $('#staff-status');
      st.className = 'wz-status ok';
      st.textContent = 'Added ' + (d.created || []).length + ' staff (' + (d.manager_count || 0) + ' manager account(s)).' +
        ((d.errors && d.errors.length) ? ' ' + d.errors.length + ' row(s) skipped.' : '');
      if (mode === 'manual') { $('#staff-rows').innerHTML = ''; renderStaffRow(); }
    });
  }
  function collectRooms() {
    var rows = [];
    document.querySelectorAll('#rooms-rows .wz-entry').forEach(function (r) {
      var name = r.querySelector('.j-name').value.trim();
      if (!name) return;
      rows.push({ name: name, capacity: r.querySelector('.j-cap').value.trim(), year_group: r.querySelector('.j-yg').value.trim() });
    });
    return rows;
  }
  function saveRooms() {
    var mode = document.querySelector('.wz-mode-tabs[data-group="rooms"] .wz-tab.is-active').dataset.mode;
    var rows = mode === 'csv' ? (csvData.rooms || []) : collectRooms();
    if (!rows.length) return Promise.resolve();
    return api('/rooms', { method: 'POST', body: { rooms: rows } }).then(function (d) {
      state.counts.rooms += (d.created || []).length;
      var st = $('#rooms-status'); st.className = 'wz-status ok';
      st.textContent = 'Added ' + (d.created || []).length + ' room(s).';
      if (mode === 'manual') { $('#rooms-rows').innerHTML = ''; renderRoomRow(); }
    });
  }
  function saveChildren() {
    var rows = csvData.children || [];
    if (!rows.length) return Promise.resolve();
    return api('/children', { method: 'POST', body: { children: rows } }).then(function (d) {
      state.counts.children += (d.created || []).length;
      var st = $('#children-status'); st.className = 'wz-status ok';
      st.textContent = 'Imported ' + (d.created || []).length + ' pupil(s).' +
        ((d.errors && d.errors.length) ? ' ' + d.errors.length + ' skipped.' : '');
    });
  }

  // ── review + finish ─────────────────────────────────────────────────────────
  function renderReview() {
    var overlays = [];
    document.querySelectorAll('#f-overlays input[data-overlay]:checked').forEach(function (cb) { overlays.push(cb.value); });
    var phonicsSel = document.querySelector('#f-phonics input[name="phonics"]:checked');
    var modsOn = 0;
    document.querySelectorAll('#f-modules input[data-module]:checked').forEach(function () { modsOn++; });
    var rows = [
      ['Setting name', $('#f-setting-name').value.trim() || '(not set)'],
      ['Type', FAMILY_LABEL[state.status.edition_family] || state.status.edition_family],
      ['Optional overlays', overlays.length ? overlays.join(', ') : 'none'],
    ];
    if (state.status.phonics_enabled) rows.push(['Phonics scheme', phonicsSel ? phonicsSel.parentElement.querySelector('span').textContent : '(not set)']);
    rows.push(['Staff added', String(state.counts.staff)]);
    rows.push(['Rooms/classes added', String(state.counts.rooms)]);
    rows.push(['Pupils imported', String(state.counts.children)]);
    rows.push(['Optional modules on', modsOn + ' of ' + (state.modules.optional || []).length]);
    var box = $('#f-review'); box.innerHTML = '';
    rows.forEach(function (r) {
      var d = el('div', 'row');
      d.appendChild(el('span', 'k', r[0]));
      d.appendChild(el('span', 'v', r[1]));
      box.appendChild(d);
    });
    // manager warning
    api('/status').then(function (st) {
      state.lastManagerCount = st.manager_count || 0;
      var warn = $('#review-warn');
      if ((st.manager_count || 0) < 1) {
        warn.hidden = false;
        warn.innerHTML = '⚠ No manager account yet. Go back to <strong>Staff</strong> and add at least ' +
          'one manager — that\'s who logs in after setup.';
      } else { warn.hidden = true; }
    });
  }

  function finish() {
    return api('/finish', { method: 'POST', body: {} }).then(function (d) {
      // Queue the first-login guided tour (2026-07-09) — picked up by the admin
      // portal shell after they log in, and it only covers enabled modules.
      try { localStorage.setItem('wrenTourPending', '1'); localStorage.removeItem('wrenTourDone'); } catch (e) {}
      toast('Setup complete!', 'success');
      setTimeout(function () { window.location.href = (d && d.redirect) || '/login.html'; }, 700);
    }).catch(function (e) {
      if (e.data && e.data.error === 'no_manager') {
        var warn = $('#review-warn'); warn.hidden = false;
        warn.innerHTML = '⚠ ' + (e.data.message || 'Add at least one manager before finishing.');
        toast(e.data.message || 'Add a manager first', 'error');
        return { _noAdvance: true };   // handled — stay on review
      }
      throw e;
    });
  }
})();
