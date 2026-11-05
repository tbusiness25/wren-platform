/* Wren IT Settings page — shared across all editions */
;(function () {
  'use strict';

  // ── Edition-specific module definitions ──────────────────────────────────
  const MODULES = {
    eyfs: [
      { key: 'daily_register',  label: 'Daily Register',                  desc: 'Morning and afternoon register for all children', nav: '/attendance.html' },
      { key: 'observations',    label: 'Observations & Learning Journeys', desc: 'Record observations linked to EYFS areas of learning', nav: '/observations.html' },
      { key: 'sleep_checks',    label: 'Sleep Checks',                    desc: 'Timed sleep checks with full audit trail', nav: '/sleep-checks.html' },
      { key: 'medicine',        label: 'Medicine Records',                 desc: 'Consent forms, administration records, parental sign-off', nav: '/medicine.html' },
      { key: 'safeguarding',    label: 'Safeguarding Log',                 desc: 'Confidential concern records and DSL alerts', nav: '/safeguarding.html' },
      { key: 'incidents',       label: 'Incident Reports',                 desc: 'Accidents, near-misses and behaviour incidents', nav: '/incidents.html' },
      { key: 'staff_rota',      label: 'Staff Rota',                      desc: 'Weekly rota planning and room ratio management', nav: '/staff.html' },
      { key: 'absence',         label: 'Absence Management',               desc: 'Staff and child absence tracking and requests', nav: '/absence.html' },
      { key: 'hr',              label: 'HR & Compliance',                  desc: 'Supervisions, CPD, DBS checks and HR records', nav: '/hr.html' },
      { key: 'parent_portal',   label: 'Parent Portal',                   desc: 'Portal access and messaging for parents', nav: '/messages.html' },
      { key: 'messaging',       label: 'Messaging',                       desc: 'Internal staff messaging and notice board', nav: '/messages.html' },
      { key: 'reports',         label: 'Reports & Data Export',            desc: 'Generate and download management reports', nav: '/reports.html' },
      { key: 'waiting_list',    label: 'Waiting List',                    desc: 'Manage enquiries and waiting list workflow', nav: null },
      { key: 'invoicing',       label: 'Invoicing & Fees',                 desc: 'Generate and track parent invoices', nav: null },
      { key: 'kitchen',         label: 'Kitchen & Meals',                  desc: 'Meal planning, dietary requirements, menus', nav: null },
      { key: 'cctv',            label: 'CCTV / Camera Feed',               desc: 'Live camera feed and recording access', nav: null },
      { key: 'telegram',        label: 'Telegram Integration',             desc: 'Automated Telegram alerts and staff notifications', nav: null },
      { key: 'ai_assistant',    label: 'AI Assistant',                    desc: 'AI-powered writing and planning assistant', nav: null },
    ],
    primary: [
      { key: 'daily_register',  label: 'Daily Register',                  desc: 'Attendance register for all pupils', nav: '/attendance.html' },
      { key: 'assessments',     label: 'Assessments & Tracking',           desc: 'Progress tracking and assessment grids', nav: '/assessments.html' },
      { key: 'phonics',         label: 'Phonics',                         desc: 'Phonics screening and progress tracking', nav: '/phonics.html' },
      { key: 'behaviour',       label: 'Behaviour',                       desc: 'Behaviour incidents and positive recognition', nav: '/behaviour.html' },
      { key: 'incidents',       label: 'Incident Reports',                 desc: 'Accidents and formal incident reports', nav: '/incidents.html' },
      { key: 'safeguarding',    label: 'Safeguarding Log',                 desc: 'DSL concerns and case management records', nav: '/safeguarding.html' },
      { key: 'send',            label: 'SEN / SEND',                      desc: 'Special educational needs records and plans', nav: '/send.html' },
      { key: 'hr',              label: 'HR & Compliance',                  desc: 'Supervisions, CPD, DBS and HR records', nav: '/hr.html' },
      { key: 'curriculum',      label: 'Curriculum Planning',              desc: 'Medium-term plans and learning sequences', nav: '/curriculum.html' },
      { key: 'staff_rota',      label: 'Staff Rota',                      desc: 'Weekly rota planning and cover management', nav: null },
      { key: 'absence',         label: 'Absence Management',               desc: 'Staff and pupil absence tracking', nav: null },
      { key: 'reports',         label: 'Reports & Data Export',            desc: 'Data reports, cohort analysis and exports', nav: '/reports.html' },
      { key: 'cpd',             label: 'CPD',                             desc: 'Continuing professional development log', nav: '/cpd.html' },
      { key: 'messaging',       label: 'Messaging',                       desc: 'Internal messaging and notice board', nav: null },
      { key: 'ai_assistant',    label: 'AI Assistant',                    desc: 'AI-powered writing and planning assistant', nav: null },
    ],
    secondary: [
      { key: 'daily_register',  label: 'Daily Register',                  desc: 'Attendance register for all pupils', nav: '/attendance.html' },
      { key: 'assessments',     label: 'Markbook & Assessments',           desc: 'Progress data, markbooks and assessment grids', nav: '/assessments.html' },
      { key: 'behaviour',       label: 'Behaviour',                       desc: 'Behaviour incidents, referrals and recognition', nav: '/behaviour.html' },
      { key: 'exclusions',      label: 'Exclusions',                      desc: 'Fixed-term and permanent exclusion records', nav: '/exclusions.html' },
      { key: 'incidents',       label: 'Incident Reports',                 desc: 'Accidents and formal incident records', nav: '/incidents.html' },
      { key: 'safeguarding',    label: 'Safeguarding Log',                 desc: 'DSL concerns and case management', nav: '/safeguarding.html' },
      { key: 'send',            label: 'SEND',                            desc: 'Special educational needs and EHCP records', nav: '/send.html' },
      { key: 'hr',              label: 'HR & Compliance',                  desc: 'Supervisions, CPD, DBS and HR records', nav: '/hr.html' },
      { key: 'curriculum',      label: 'Curriculum Planning',              desc: 'Schemes of work and medium-term plans', nav: '/curriculum.html' },
      { key: 'staff_rota',      label: 'Staff Rota',                      desc: 'Timetable and supply cover management', nav: null },
      { key: 'absence',         label: 'Absence Management',               desc: 'Staff and pupil absence tracking', nav: null },
      { key: 'reports',         label: 'Reports & Data Export',            desc: 'Cohort data, progress reports and exports', nav: '/reports.html' },
      { key: 'cpd',             label: 'CPD',                             desc: 'CPD log and performance management', nav: '/cpd.html' },
      { key: 'messaging',       label: 'Messaging',                       desc: 'Internal messaging and notice board', nav: null },
      { key: 'ai_assistant',    label: 'AI Assistant',                    desc: 'AI-powered writing and planning assistant', nav: null },
    ],
  };

  // ── Boot ──────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    // Guard: manager/IT only
    const token = sessionStorage.getItem('wrenToken');
    if (!token) return; // wren-shell will redirect
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (!['manager', 'deputy_manager', 'admin', 'headteacher', 'it_technician', 'business_manager'].includes(payload.role)) {
        document.getElementById('wren-content').innerHTML =
          `<div class="alert" style="background:#1e293b;border:1px solid #ef4444;color:#ef4444;padding:20px;border-radius:10px">
             <strong>Access denied.</strong> IT Settings requires manager or IT role.
           </div>`;
        return;
      }
    } catch {}

    const edition = (document.querySelector('meta[name="wren-edition"]')?.content || 'eyfs').toLowerCase();
    buildPage(edition);
  });

  // ── Page shell ────────────────────────────────────────────────────────────
  function buildPage(edition) {
    const content = document.getElementById('wren-content');
    content.innerHTML = `
      <div class="page-header">
        <div class="page-title">IT Settings</div>
      </div>
      <div id="it-tabs-bar" style="display:flex;gap:4px;margin-bottom:20px;flex-wrap:wrap;border-bottom:2px solid #2d3748;padding-bottom:0">
        ${['Modules','Fields','Design','Frameworks','Backup','Permissions'].map((t,i) =>
          `<button class="it-tab-btn${i===0?' active':''}" data-tab="${i}" onclick="ITSettings.switchTab(${i})"
            style="padding:10px 18px;background:none;border:none;color:${i===0?'#4a9abf':'#94a3b8'};
            font-size:.88rem;font-weight:600;cursor:pointer;border-bottom:${i===0?'2px solid #4a9abf':'2px solid transparent'};
            margin-bottom:-2px;transition:.15s ease">${t}</button>`
        ).join('')}
      </div>
      <div id="it-tab-content"></div>
    `;

    window.ITSettings = { switchTab, edition };
    switchTab(0, edition);
  }

  function switchTab(idx, ed) {
    const edition = ed || window.ITSettings.edition;
    document.querySelectorAll('.it-tab-btn').forEach((btn, i) => {
      const active = i === idx;
      btn.style.color = active ? '#4a9abf' : '#94a3b8';
      btn.style.borderBottom = active ? '2px solid #4a9abf' : '2px solid transparent';
    });
    const panel = document.getElementById('it-tab-content');
    panel.innerHTML = `<div class="loading-state"><div class="spinner"></div></div>`;

    const loaders = [
      () => loadModules(edition, panel),
      () => loadFields(panel),
      () => loadBranding(panel),
      () => loadFrameworks(panel),
      () => loadBackup(panel),
      () => loadPermissions(panel),
    ];
    loaders[idx]();
  }

  // ── Tab 1: Modules ────────────────────────────────────────────────────────
  async function loadModules(edition, panel) {
    let state = {};
    try { state = await Wren.api('/api/it-settings/modules') || {}; } catch {}
    const mods = MODULES[edition] || MODULES.eyfs;

    panel.innerHTML = `
      <div style="margin-bottom:16px;color:#94a3b8;font-size:.85rem">
        Toggle modules on or off. When a module is disabled, its nav link is hidden for all users.
      </div>
      <div class="card" style="padding:0">
        ${mods.map(m => {
          const enabled = state[m.key] !== false;
          return `
            <div class="module-row" data-key="${m.key}" style="display:flex;align-items:center;gap:16px;padding:14px 18px;border-bottom:1px solid #1e293b">
              <div style="flex:1">
                <div style="font-weight:600;font-size:.92rem;color:#f1f5f9">${m.label}</div>
                <div style="font-size:.8rem;color:#94a3b8;margin-top:2px">${m.desc}</div>
              </div>
              <label class="it-toggle" title="${enabled?'Enabled — click to disable':'Disabled — click to enable'}">
                <input type="checkbox" ${enabled ? 'checked' : ''} onchange="ITSettings.toggleModule('${m.key}', this.checked)">
                <span class="it-toggle-slider"></span>
              </label>
            </div>`;
        }).join('')}
      </div>
      <div style="margin-top:16px;display:flex;gap:10px">
        <button class="btn btn-primary" onclick="ITSettings.saveModules()">Save Modules</button>
        <button class="btn btn-ghost" onclick="ITSettings.enableAllModules()">Enable All</button>
      </div>`;

    // Expose module state on ITSettings
    ITSettings._moduleState = { ...state };
    ITSettings.toggleModule = (key, val) => { ITSettings._moduleState[key] = val; };
    ITSettings.saveModules = async () => {
      try {
        await Wren.api('/api/it-settings/modules', { method: 'POST', body: ITSettings._moduleState });
        Wren.toast('Modules saved', 'success');
      } catch (e) { Wren.toast('Failed to save modules', 'error'); }
    };
    ITSettings.enableAllModules = () => {
      panel.querySelectorAll('.it-toggle input').forEach(cb => {
        cb.checked = true;
        const key = cb.closest('.module-row').dataset.key;
        ITSettings._moduleState[key] = true;
      });
      Wren.toast('All modules enabled — click Save to apply', 'info');
    };
  }

  // ── Tab 2: Fields & Dropdowns ─────────────────────────────────────────────
  async function loadFields(panel) {
    let config = {};
    try { config = await Wren.api('/api/it-settings/fields') || {}; } catch {}

    panel.innerHTML = `
      <div style="margin-bottom:16px;color:#94a3b8;font-size:.85rem">
        Customise dropdown options across the system. Changes take effect immediately.
      </div>
      <div id="fields-list" style="display:flex;flex-direction:column;gap:16px"></div>
      <div style="margin-top:20px">
        <button class="btn btn-primary" onclick="ITSettings.saveFields()">Save All Changes</button>
      </div>`;

    ITSettings._fieldConfig = JSON.parse(JSON.stringify(config));
    renderFields(config, document.getElementById('fields-list'));

    ITSettings.saveFields = async () => {
      try {
        await Wren.api('/api/it-settings/fields', { method: 'POST', body: ITSettings._fieldConfig });
        Wren.toast('Field options saved', 'success');
      } catch { Wren.toast('Failed to save fields', 'error'); }
    };
  }

  function renderFields(config, container) {
    container.innerHTML = '';
    for (const [key, field] of Object.entries(config)) {
      const card = document.createElement('div');
      card.className = 'card';
      card.style.cssText = 'padding:16px;';
      card.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div>
            <div style="font-weight:700;font-size:.92rem;color:#f1f5f9">${field.label}</div>
            <div style="font-size:.8rem;color:#94a3b8">${field.description}</div>
          </div>
        </div>
        <div class="field-tags" data-key="${key}" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">
          ${(field.options||[]).map((opt,i) => optionTag(key, opt, i)).join('')}
        </div>
        <div style="display:flex;gap:8px">
          <input type="text" class="form-control" id="new-opt-${key}" placeholder="Add option…"
            style="flex:1;background:#0f172a;border:1px solid #2d3748;color:#f1f5f9;padding:8px 12px;border-radius:8px;font-size:.85rem"
            onkeydown="if(event.key==='Enter'){ITSettings.addOption('${key}');event.preventDefault()}">
          <button class="btn btn-ghost" onclick="ITSettings.addOption('${key}')" style="flex-shrink:0">+ Add</button>
        </div>`;
      container.appendChild(card);
    }

    ITSettings.addOption = (key) => {
      const inp = document.getElementById(`new-opt-${key}`);
      const val = inp.value.trim();
      if (!val) return;
      if (!ITSettings._fieldConfig[key].options.includes(val)) {
        ITSettings._fieldConfig[key].options.push(val);
      }
      inp.value = '';
      renderFields(ITSettings._fieldConfig, container);
    };

    ITSettings.removeOption = (key, idx) => {
      ITSettings._fieldConfig[key].options.splice(idx, 1);
      renderFields(ITSettings._fieldConfig, container);
    };

    ITSettings.moveOption = (key, idx, dir) => {
      const arr = ITSettings._fieldConfig[key].options;
      const newIdx = idx + dir;
      if (newIdx < 0 || newIdx >= arr.length) return;
      [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
      renderFields(ITSettings._fieldConfig, container);
    };
  }

  function optionTag(key, opt, i) {
    return `<div style="display:inline-flex;align-items:center;gap:4px;background:#1e293b;border:1px solid #2d3748;
      border-radius:20px;padding:4px 10px;font-size:.82rem;color:#f1f5f9">
      <button onclick="ITSettings.moveOption('${key}',${i},-1)" title="Move up"
        style="background:none;border:none;color:#64748b;cursor:pointer;padding:0 2px;font-size:.75rem;line-height:1">↑</button>
      <span>${esc(opt)}</span>
      <button onclick="ITSettings.moveOption('${key}',${i},1)" title="Move down"
        style="background:none;border:none;color:#64748b;cursor:pointer;padding:0 2px;font-size:.75rem;line-height:1">↓</button>
      <button onclick="ITSettings.removeOption('${key}',${i})" title="Remove"
        style="background:none;border:none;color:#ef4444;cursor:pointer;padding:0 2px;font-size:.8rem;line-height:1;margin-left:2px">✕</button>
    </div>`;
  }

  // ── Tab 3: Design & Branding ──────────────────────────────────────────────
  async function loadBranding(panel) {
    let branding = {};
    try { branding = await Wren.api('/api/it-settings/branding') || {}; } catch {}

    panel.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px">

        <div class="card settings-section">
          <div class="settings-section-title">🏫 Setting Details</div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Setting / School Name</label>
              <input type="text" class="form-control" id="brand-name" placeholder="e.g. Your Nursery"
                value="${esc(branding.setting_name||'')}">
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Manager Name</label>
              <input type="text" class="form-control" id="brand-manager" placeholder="Full name"
                value="${esc(branding.manager_name||'')}">
            </div>
            <div class="form-group">
              <label class="form-label">Contact Email</label>
              <input type="email" class="form-control" id="brand-email" placeholder="manager@yoursetting.co.uk"
                value="${esc(branding.contact_email||'')}">
            </div>
          </div>
        </div>

        <div class="card settings-section">
          <div class="settings-section-title">📱 Devices & Enrolment</div>
          <div style="font-size:.85rem;color:#94a3b8;margin-bottom:12px">
            Enrol THIS tablet/computer so it's a known device for EY child data.
            Tap below on the device you want to enrol — your current login is carried automatically.
          </div>
          <button type="button" class="btn"
            style="background:var(--c-blue,#4a9abf);color:#fff;border:none;padding:10px 18px;border-radius:8px;cursor:pointer;font-weight:600"
            onclick="window.location.href='/ey/enrol-device'">
            ＋ Enrol this device
          </button>
          <div style="margin-top:10px;font-size:.78rem;color:#64748b">
            Opens the enrol page in this session. Manage/revoke enrolled devices from the Admin portal → Devices &amp; Security.
          </div>
        </div>

        <div class="card settings-section">
          <div class="settings-section-title">🎨 Primary Colour</div>
          <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
            <input type="color" id="brand-color" value="${branding.primary_color||'#4a9abf'}"
              style="width:48px;height:48px;border:none;border-radius:8px;cursor:pointer;padding:2px;background:#1e293b"
              oninput="document.getElementById('brand-color-hex').value=this.value;updateColorPreview(this.value)">
            <input type="text" id="brand-color-hex" class="form-control" placeholder="#4a9abf"
              value="${branding.primary_color||'#4a9abf'}"
              style="width:120px;font-family:monospace"
              oninput="if(/^#[0-9a-fA-F]{6}$/.test(this.value)){document.getElementById('brand-color').value=this.value;updateColorPreview(this.value)}">
            <div id="color-preview" style="flex:1;min-width:180px;padding:14px 18px;border-radius:10px;
              background:${branding.primary_color||'#4a9abf'};color:#fff;font-weight:600;font-size:.9rem;text-align:center">
              Preview button / link colour
            </div>
          </div>
          <div style="margin-top:10px;font-size:.8rem;color:#94a3b8">
            Updates the <code style="color:#f1f5f9;background:#0f172a;padding:1px 5px;border-radius:4px">--c-blue</code> CSS variable across all pages. Reload to see changes take effect.
          </div>
        </div>

        <div class="card settings-section">
          <div class="settings-section-title">🖼 Setting Logo</div>
          ${branding.logo_url
            ? `<div style="margin-bottom:12px"><img src="${branding.logo_url}" alt="Current logo"
                style="max-height:80px;max-width:240px;object-fit:contain;background:#fff;padding:8px;border-radius:8px"></div>`
            : `<div style="margin-bottom:12px;color:#94a3b8;font-size:.85rem">No custom logo set — using the Wren text logo.</div>`}
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <label class="btn btn-ghost" style="cursor:pointer">
              📁 Choose File
              <input type="file" id="logo-file" accept="image/png,image/jpeg,image/svg+xml"
                style="display:none" onchange="ITSettings.previewLogo(this)">
            </label>
            <span id="logo-filename" style="color:#94a3b8;font-size:.85rem">No file chosen</span>
          </div>
          <div id="logo-preview-wrap" style="margin-top:12px;display:none">
            <img id="logo-preview-img" style="max-height:80px;max-width:240px;object-fit:contain;background:#fff;padding:8px;border-radius:8px">
          </div>
          <div style="margin-top:10px;font-size:.8rem;color:#94a3b8">
            PNG or JPG recommended. Logo will appear in the top-left of all pages alongside the Wren name.
          </div>
        </div>

        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-primary" onclick="ITSettings.saveBranding()" style="flex:1;padding:13px">Save Branding</button>
          ${branding.logo_url ? `<button class="btn btn-ghost" onclick="ITSettings.removeLogo()">Remove Logo</button>` : ''}
        </div>
      </div>`;

    window.updateColorPreview = (color) => {
      document.getElementById('color-preview').style.background = color;
    };

    ITSettings.previewLogo = (input) => {
      const file = input.files[0];
      if (!file) return;
      document.getElementById('logo-filename').textContent = file.name;
      const reader = new FileReader();
      reader.onload = e => {
        const wrap = document.getElementById('logo-preview-wrap');
        document.getElementById('logo-preview-img').src = e.target.result;
        wrap.style.display = 'block';
      };
      reader.readAsDataURL(file);
    };

    ITSettings.saveBranding = async () => {
      const payload = {
        setting_name:  document.getElementById('brand-name').value,
        manager_name:  document.getElementById('brand-manager').value,
        contact_email: document.getElementById('brand-email').value,
        primary_color: document.getElementById('brand-color-hex').value,
        logo_url:      branding.logo_url || null,
      };
      try {
        // Upload logo if selected
        const file = document.getElementById('logo-file').files[0];
        if (file) {
          const b64 = await toBase64(file);
          const res = await Wren.api('/api/it-settings/logo', {
            method: 'POST',
            body: { data: b64, mimeType: file.type }
          });
          payload.logo_url = res.url;
        }
        await Wren.api('/api/it-settings/branding', { method: 'POST', body: payload });
        Wren.toast('Branding saved — reload to see colour changes', 'success');
      } catch { Wren.toast('Failed to save branding', 'error'); }
    };

    ITSettings.removeLogo = async () => {
      try {
        const current = await Wren.api('/api/it-settings/branding') || {};
        current.logo_url = null;
        await Wren.api('/api/it-settings/branding', { method: 'POST', body: current });
        Wren.toast('Logo removed', 'success');
        loadBranding(panel);
      } catch { Wren.toast('Failed', 'error'); }
    };
  }

  function toBase64(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = e => res(e.target.result.split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }

  // ── Tab 4: Framework Versions ─────────────────────────────────────────────
  async function loadFrameworks(panel) {
    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:18px">
        <div style="color:#94a3b8;font-size:.85rem">UK statutory frameworks — checked weekly on Sunday at 2am.</div>
        <button class="btn btn-ghost" id="check-now-btn" onclick="ITSettings.checkNow()">Check Now</button>
      </div>
      <div id="fw-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px">
        <div class="loading-state"><div class="spinner"></div></div>
      </div>`;

    await renderFrameworks();

    ITSettings.checkNow = async () => {
      const btn = document.getElementById('check-now-btn');
      btn.disabled = true; btn.textContent = '⏳ Checking…';
      try {
        await Wren.api('/api/it-settings/check-frameworks', { method: 'POST', body: {} });
        Wren.toast('Framework check started — refreshing in 35 seconds…', 'info');
        setTimeout(async () => {
          await renderFrameworks();
          btn.disabled = false; btn.textContent = 'Check Now';
        }, 35000);
      } catch {
        Wren.toast('Failed to start check', 'error');
        btn.disabled = false; btn.textContent = 'Check Now';
      }
    };
  }

  async function renderFrameworks() {
    const grid = document.getElementById('fw-grid');
    if (!grid) return;
    try {
      const data = await Wren.api('/api/frameworks');
      const entries = Object.entries(data);
      if (!entries.length) { grid.innerHTML = '<div style="color:#94a3b8">No frameworks configured</div>'; return; }
      grid.innerHTML = entries.map(([, fw]) => {
        const { badge, style } = statusBadge(fw.status);
        const checked = fw.last_checked
          ? new Date(fw.last_checked).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })
          : 'Never';
        return `
          <div class="card" style="padding:16px">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px">
              <div style="font-weight:700;font-size:.9rem;color:#f1f5f9;line-height:1.3">${esc(fw.name)}</div>
              <span style="${style};padding:3px 10px;border-radius:20px;font-size:.75rem;font-weight:700;white-space:nowrap">${badge}</span>
            </div>
            <div style="font-size:.8rem;color:#94a3b8;margin-bottom:4px">
              Version: <span style="color:#f1f5f9">${esc(fw.current_version || '—')}</span>
            </div>
            <div style="font-size:.8rem;color:#94a3b8">
              Last checked: <span style="color:#f1f5f9">${checked}</span>
            </div>
            <a href="${esc(fw.url)}" target="_blank" rel="noopener"
              style="display:inline-block;margin-top:10px;font-size:.8rem;color:#4a9abf">
              View on GOV.UK →
            </a>
          </div>`;
      }).join('');
    } catch { if (grid) grid.innerHTML = '<div class="alert alert-warning">Failed to load frameworks</div>'; }
  }

  function statusBadge(status) {
    switch (status) {
      case 'current':
        return { badge: 'Current', style: 'background:rgba(34,197,94,.15);color:#22c55e;border:1px solid rgba(34,197,94,.3)' };
      case 'update_available':
        return { badge: 'Update Available', style: 'background:rgba(245,158,11,.15);color:#f59e0b;border:1px solid rgba(245,158,11,.3)' };
      default:
        return { badge: 'Not checked', style: 'background:rgba(148,163,184,.1);color:#94a3b8;border:1px solid rgba(148,163,184,.2)' };
    }
  }

  // ── Tab 5: Backup & Recovery ──────────────────────────────────────────────
  async function loadBackup(panel) {
    panel.innerHTML = `
      <div id="backup-status-area"><div class="loading-state"><div class="spinner"></div></div></div>
      <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="ITSettings.runBackup()" id="run-backup-btn">Run Backup Now</button>
        <button class="btn btn-ghost" onclick="ITSettings.loadBackup()">Refresh Status</button>
      </div>
      <div style="margin-top:18px">
        <div style="font-size:.75rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Recovery Guide</div>
        <div style="background:#0f172a;border:1px solid #2d3748;border-radius:10px;padding:16px">
          <ol style="color:#94a3b8;font-size:.82rem;line-height:1.9;padding-left:1.4em;margin:0">
            <li>SSH into the Wren server: <code style="color:#f1f5f9;background:#1e293b;padding:1px 6px;border-radius:4px">ssh &lt;user&gt;@&lt;your-wren-server&gt;</code></li>
            <li>Run: <code style="color:#f1f5f9;background:#1e293b;padding:1px 6px;border-radius:4px">bash scripts/recover.sh</code> (from the Wren install directory)</li>
            <li>Confirm when prompted — the script lists snapshots and restores the latest</li>
            <li>Containers restart automatically after restore</li>
            <li>If database is unrecoverable, restore from USB: <code style="color:#f1f5f9;background:#1e293b;padding:1px 6px;border-radius:4px">rsync -a /media/wren-backup/ /var/backups/wren/</code></li>
          </ol>
        </div>
      </div>`;

    ITSettings.loadBackup = async () => {
      const el = document.getElementById('backup-status-area');
      try {
        const d = await Wren.api('/api/admin/backup-status');
        if (d.error) { el.innerHTML = `<div class="alert alert-warning">${esc(d.error)}</div>`; return; }
        const usbBadge = d.usb_mounted
          ? `<span style="color:#22c55e;font-weight:700">Connected</span>`
          : `<span style="color:#f59e0b;font-weight:700">Not connected</span>`;
        const bb = d.backblaze_configured
          ? `<span style="color:#22c55e;font-weight:700">Configured</span>`
          : `<span style="color:#94a3b8">Not configured</span>`;
        el.innerHTML = `
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px">
            ${statBox(d.snapshots, 'Daily Snapshots', '#4a9abf')}
            ${statBox(d.weekly_snapshots, 'Weekly Snapshots', '#4a9abf')}
            ${statBox(d.total_size || '—', 'Total Size', '#22c55e')}
          </div>
          <div style="font-size:.83rem;display:flex;flex-direction:column;gap:6px">
            <div><span style="color:#94a3b8">USB Drive:</span> ${usbBadge}</div>
            <div><span style="color:#94a3b8">Backblaze:</span> ${bb}</div>
            <div><span style="color:#94a3b8">Next run:</span> <span style="color:#f1f5f9">${esc(d.next_run||'—')}</span></div>
            <div><span style="color:#94a3b8">Latest snapshot:</span> <span style="color:#f1f5f9">${esc(d.latest_date||'—')} (${esc(d.latest_size||'—')})</span></div>
          </div>
          ${d.last_log ? `
            <div style="margin-top:14px">
              <div style="font-size:.72rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Last 10 log lines</div>
              <pre style="font-size:.75rem;color:#94a3b8;background:#0f172a;border:1px solid #2d3748;border-radius:6px;
                padding:10px;margin:0;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow-y:auto">${esc(d.last_log)}</pre>
            </div>` : ''}`;
      } catch {
        el.innerHTML = '<div style="color:#94a3b8;font-size:.85rem">Backup status unavailable — check that the admin route is mounted.</div>';
      }
    };

    ITSettings.runBackup = async () => {
      const btn = document.getElementById('run-backup-btn');
      btn.disabled = true; btn.textContent = '⏳ Starting…';
      try {
        await Wren.api('/api/admin/run-backup', { method: 'POST', body: {} });
        Wren.toast('Backup started — check log in ~60 seconds', 'success');
        btn.textContent = 'Backup started';
        setTimeout(() => { btn.textContent = 'Run Backup Now'; btn.disabled = false; ITSettings.loadBackup(); }, 65000);
      } catch (e) {
        Wren.toast('Failed: ' + (e.error || 'unknown error'), 'error');
        btn.textContent = 'Run Backup Now'; btn.disabled = false;
      }
    };

    ITSettings.loadBackup();
  }

  function statBox(val, label, color) {
    return `<div style="background:#0f172a;border:1px solid #2d3748;border-radius:8px;padding:12px;text-align:center">
      <div style="font-size:1.5rem;font-weight:800;color:${color}">${esc(String(val ?? '—'))}</div>
      <div style="font-size:.72rem;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-top:2px">${label}</div>
    </div>`;
  }

  // ── Tab 6: Staff Permissions ──────────────────────────────────────────────
  async function loadPermissions(panel) {
    panel.innerHTML = `<div class="loading-state"><div class="spinner"></div></div>`;

    let staffList = [], groups = [];
    try { staffList = await Wren.api('/api/staff/permissions/all') || []; } catch {}
    try { groups = await Wren.api('/api/staff/permissions/groups') || []; } catch {}

    const yearGroups = groups.filter(g => /year/i.test(g.value));
    const classGroups = groups.filter(g => !/year/i.test(g.value) && g.value);

    const scopeOptions = [
      { val: 'all',        label: 'All — sees everyone' },
      { val: 'year_group', label: 'Year Group — filtered to one year' },
      { val: 'class',      label: 'Class / Room — filtered to one class or room' },
    ];

    function scopeBadge(scope, val) {
      if (!scope || scope === 'all') {
        return `<span style="padding:2px 10px;border-radius:20px;font-size:.75rem;font-weight:700;
          background:rgba(34,197,94,.12);color:#22c55e;border:1px solid rgba(34,197,94,.3)">All</span>`;
      }
      return `<span style="padding:2px 10px;border-radius:20px;font-size:.75rem;font-weight:700;
        background:rgba(245,158,11,.12);color:#f59e0b;border:1px solid rgba(245,158,11,.3)" title="Restricted to ${esc(val||'')}">
        ${esc(scope.replace('_',' '))}${val ? ': ' + esc(val) : ''}</span>`;
    }

    panel.innerHTML = `
      <div style="margin-bottom:16px;color:#94a3b8;font-size:.85rem">
        Control which staff members can see all pupils or only those in their year group / class.
        Managers, headteachers, SENCOs and admins always see everything regardless of this setting.
      </div>
      <div class="card" style="padding:0">
        <table style="width:100%;border-collapse:collapse;font-size:.88rem">
          <thead>
            <tr style="border-bottom:1px solid #2d3748">
              <th style="padding:12px 16px;text-align:left;color:#94a3b8;font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em">Staff Member</th>
              <th style="padding:12px 16px;text-align:left;color:#94a3b8;font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em">Role</th>
              <th style="padding:12px 16px;text-align:left;color:#94a3b8;font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em">Current Scope</th>
              <th style="padding:12px 16px;text-align:left;color:#94a3b8;font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em">Change Scope</th>
              <th style="padding:12px 16px;text-align:left;color:#94a3b8;font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em">Group / Class</th>
              <th style="padding:12px 8px"></th>
            </tr>
          </thead>
          <tbody>
            ${staffList.map(s => `
              <tr data-staff-id="${s.id}" style="border-bottom:1px solid #1e293b">
                <td style="padding:12px 16px;color:#f1f5f9;font-weight:600">${esc(s.first_name)} ${esc(s.last_name)}</td>
                <td style="padding:12px 16px;color:#94a3b8;text-transform:capitalize">${esc((s.role||'').replace(/_/g,' '))}</td>
                <td style="padding:12px 16px" class="scope-badge-cell">${scopeBadge(s.scope, s.scope_value)}</td>
                <td style="padding:10px 12px">
                  <select class="perm-scope-sel form-control" data-id="${s.id}"
                    style="background:#0f172a;border:1px solid #2d3748;color:#f1f5f9;padding:6px 10px;border-radius:8px;font-size:.83rem;width:100%"
                    onchange="ITSettings.onScopeChange(${s.id}, this.value)">
                    ${scopeOptions.map(o => `<option value="${o.val}"${(s.scope||'all')===o.val?' selected':''}>${o.label}</option>`).join('')}
                  </select>
                </td>
                <td style="padding:10px 12px">
                  <select class="perm-val-sel form-control" data-id="${s.id}"
                    style="background:#0f172a;border:1px solid #2d3748;color:#f1f5f9;padding:6px 10px;border-radius:8px;font-size:.83rem;width:100%;
                    display:${(s.scope&&s.scope!=='all')?'block':'none'}"
                    id="scope-val-${s.id}">
                    <option value="">— select —</option>
                    ${yearGroups.map(g => `<option value="${esc(g.value)}"${s.scope_value===g.value?' selected':''}>${esc(g.label)}</option>`).join('')}
                    ${classGroups.length ? '<optgroup label="Classes / Rooms">' +
                      classGroups.map(g => `<option value="${esc(g.value)}"${s.scope_value===g.value?' selected':''}>${esc(g.label)}</option>`).join('') +
                      '</optgroup>' : ''}
                  </select>
                </td>
                <td style="padding:10px 8px">
                  <button class="btn btn-primary" style="padding:6px 14px;font-size:.82rem"
                    onclick="ITSettings.savePermission(${s.id})">Save</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    ITSettings.onScopeChange = (id, scope) => {
      const valSel = document.getElementById(`scope-val-${id}`);
      if (valSel) valSel.style.display = scope === 'all' ? 'none' : 'block';
    };

    ITSettings.savePermission = async (id) => {
      const row = document.querySelector(`tr[data-staff-id="${id}"]`);
      const scope = row.querySelector('.perm-scope-sel').value;
      const valSel = row.querySelector('.perm-val-sel');
      const scope_value = (scope !== 'all' && valSel) ? valSel.value : null;
      try {
        const updated = await Wren.api(`/api/staff/${id}/permissions`, {
          method: 'PUT',
          body: { scope, scope_value }
        });
        // Update badge in-place
        const badgeCell = row.querySelector('.scope-badge-cell');
        if (badgeCell) badgeCell.innerHTML = scopeBadge(updated.scope, updated.scope_value);
        Wren.toast(`${updated.first_name} ${updated.last_name} — scope updated`, 'success');
      } catch (e) {
        Wren.toast('Failed to save: ' + (e.error || 'unknown error'), 'error');
      }
    };
  }

  // ── Util ──────────────────────────────────────────────────────────────────
  function esc(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

})();
