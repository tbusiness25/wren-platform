/* wren-safeguarding-form.js v20260520
 * Shared safeguarding concern entry form — mounts on admin and EY portals.
 * Usage: window.WrenSafeguardingForm.mount(containerEl, options)
 *   options.preselectChildId  — optional integer; locks child picker
 *   options.onSaved(concern)  — callback after successful POST
 *   options.onCancel()        — callback for cancel button
 */
(function (global) {
  'use strict';

  // ── Helpers ────────────────────────────────────────────────────────────────
  function _e(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _userId() {
    try {
      const tok = sessionStorage.getItem('wrenToken');
      if (!tok) return 'anon';
      return JSON.parse(atob(tok.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')))?.id || 'anon';
    } catch { return 'anon'; }
  }

  const DRAFT_KEY = () => `wren-sg-draft-${_userId()}`;

  function _saveDraft(data) {
    try { localStorage.setItem(DRAFT_KEY(), JSON.stringify(data)); } catch {}
  }

  function _loadDraft() {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY()) || 'null'); } catch { return null; }
  }

  function _clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY()); } catch {}
  }

  // ── Settings cache ─────────────────────────────────────────────────────────
  let _settingsCache = null;

  async function _getSettings() {
    if (_settingsCache) return _settingsCache;
    try {
      const s = await Wren.api('/api/admin/settings');
      _settingsCache = s;
      return s;
    } catch { return {}; }
  }

  // ── Main mount ─────────────────────────────────────────────────────────────
  async function mount(container, opts) {
    opts = opts || {};
    const onSaved  = opts.onSaved  || function() {};
    const onCancel = opts.onCancel || function() {};
    const preselectChildId = opts.preselectChildId ? parseInt(opts.preselectChildId) : null;

    container.innerHTML = '<div class="sgf-loading">Loading form…</div>';

    // Load settings and categories in parallel
    let settings = {}, categories = [], children = [], staff = [];
    try {
      [settings, categories, children, staff] = await Promise.all([
        _getSettings().catch(() => ({})),
        Wren.api('/api/safeguarding/categories').catch(() => []),
        Wren.api('/api/children?status=active&limit=200').catch(() => []),
        Wren.api('/api/admin/staff').catch(() => []),
      ]);
    } catch {}

    const bodyMapEnabled = settings.safeguarding_body_map_enabled !== 'false';
    const photosEnabled  = settings.safeguarding_photos_enabled   !== 'false';

    // Group categories
    const statutory   = categories.filter(c => c.is_statutory);
    const contextual  = categories.filter(c => !c.is_statutory);

    // Restore draft if any
    const draft = _loadDraft();

    const childList = Array.isArray(children) ? children : (children.children || []);
    const staffList = Array.isArray(staff) ? staff : [];

    container.innerHTML = _renderForm({
      preselectChildId, bodyMapEnabled, photosEnabled,
      statutory, contextual, childList, staffList, draft,
    });

    _attachBehaviour(container, {
      preselectChildId, bodyMapEnabled, photosEnabled,
      onSaved, onCancel, childList, draft,
    });
  }

  // ── Render form HTML ───────────────────────────────────────────────────────
  function _renderForm(ctx) {
    const { preselectChildId, bodyMapEnabled, photosEnabled,
            statutory, contextual, childList, staffList, draft } = ctx;

    const selChild = preselectChildId
      ? childList.find(c => c.id === preselectChildId)
      : null;

    const childrenOpts = childList.map(c =>
      `<option value="${c.id}">${_e(c.first_name + ' ' + c.last_name)}</option>`
    ).join('');

    const staffOpts = '<option value="">— Not specified —</option>' +
      staffList.map(s =>
        `<option value="${s.id}">${_e(s.first_name + ' ' + s.last_name)}</option>`
      ).join('');

    const catStatutory = statutory.map(c =>
      `<button type="button" class="sgf-cat-chip" data-cat="${_e(c.id)}">${_e(c.label)}</button>`
    ).join('');

    const catContextual = contextual.map(c =>
      `<button type="button" class="sgf-cat-chip" data-cat="${_e(c.id)}">${_e(c.label)}</button>`
    ).join('');

    const now = new Date();
    const localISO = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0,16);
    const draftDate = draft?.concern_date || localISO;
    const draftDesc = draft?.description || '';
    const draftAction = draft?.immediate_action || '';

    return `
<style>
.sgf-form { font-family: system-ui, -apple-system, sans-serif; max-width: 680px; }
.sgf-field { margin-bottom: 18px; }
.sgf-label { display: block; font-size: .82rem; font-weight: 700; color: var(--c-muted,#64748b); margin-bottom: 6px; text-transform: uppercase; letter-spacing: .04em; }
.sgf-label .sgf-req { color: #ef4444; margin-left: 2px; }
.sgf-input, .sgf-textarea, .sgf-select {
  width: 100%; box-sizing: border-box;
  background: var(--c-bg,#0f172a); border: 1px solid var(--c-border,#1e2d45);
  border-radius: 8px; color: var(--c-text,#f1f5f9);
  font-size: .9rem; padding: 10px 12px;
  transition: border-color .15s;
}
.sgf-input:focus, .sgf-textarea:focus, .sgf-select:focus { outline: none; border-color: var(--c-blue,#5b8fff); }
.sgf-textarea { min-height: 90px; resize: vertical; font-family: inherit; line-height: 1.5; }
.sgf-child-chip {
  display: inline-flex; align-items: center; gap: 6px;
  background: rgba(91,143,255,.15); border: 1px solid rgba(91,143,255,.4);
  border-radius: 8px; padding: 6px 12px; font-size: .88rem; font-weight: 600; color: var(--c-blue,#5b8fff);
  margin-right: 6px; margin-bottom: 6px;
}
.sgf-child-chip .sgf-remove { cursor: pointer; color: var(--c-muted,#64748b); }
.sgf-child-chip .sgf-remove:hover { color: #ef4444; }
.sgf-cat-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.sgf-cat-chip {
  height: 32px; padding: 0 12px; border-radius: 16px;
  background: var(--c-surface,#1e2d45); border: 1px solid var(--c-border,#1e2d45);
  color: var(--c-muted,#64748b); font-size: .82rem; font-weight: 600; cursor: pointer;
  transition: all .15s;
}
.sgf-cat-chip:hover { border-color: var(--c-blue,#5b8fff); color: var(--c-text,#f1f5f9); }
.sgf-cat-chip.selected { background: var(--c-blue,#5b8fff); border-color: var(--c-blue,#5b8fff); color: #fff; }
.sgf-cat-group-label { font-size: .75rem; font-weight: 700; color: var(--c-muted,#64748b); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 6px; margin-top: 4px; }
.sgf-severity { display: flex; gap: 0; border: 1px solid var(--c-border,#1e2d45); border-radius: 8px; overflow: hidden; }
.sgf-sev-btn {
  flex: 1; height: 38px; border: none; cursor: pointer;
  font-size: .85rem; font-weight: 600; transition: all .15s;
  background: var(--c-surface,#1e2d45); color: var(--c-muted,#64748b);
}
.sgf-sev-btn + .sgf-sev-btn { border-left: 1px solid var(--c-border,#1e2d45); }
.sgf-sev-btn.active-standard { background: rgba(91,143,255,.2); color: var(--c-blue,#5b8fff); }
.sgf-sev-btn.active-urgent   { background: rgba(245,158,11,.2); color: #f59e0b; }
.sgf-sev-btn.active-serious  { background: rgba(245,158,11,.2); color: #f59e0b; }
.sgf-sev-btn.active-critical { background: rgba(239,68,68,.2);  color: #ef4444; }
.sgf-body-map-wrap { position: relative; }
.sgf-body-map-wrap svg .bm-zone { cursor: crosshair; transition: fill .15s; }
.sgf-body-map-wrap svg .bm-zone:hover { fill: rgba(91,143,255,.18); }
.sgf-mark {
  position: absolute; width: 18px; height: 18px; margin: -9px 0 0 -9px;
  border-radius: 50%; background: #ef4444; border: 2px solid #fff;
  cursor: pointer; font-size: .65rem; display: flex; align-items: center; justify-content: center;
  color: #fff; font-weight: 700; pointer-events: all;
  box-shadow: 0 1px 4px rgba(0,0,0,.4);
}
.sgf-photo-warn {
  font-size: .78rem; color: #f59e0b; background: rgba(245,158,11,.1);
  border: 1px solid rgba(245,158,11,.3); border-radius: 6px; padding: 8px 10px;
  margin-bottom: 8px; line-height: 1.4;
}
.sgf-photo-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.sgf-photo-thumb {
  width: 64px; height: 64px; border-radius: 6px; object-fit: cover;
  border: 1px solid var(--c-border,#1e2d45); cursor: pointer;
  position: relative;
}
.sgf-checkbox-row { display: flex; align-items: center; gap: 10px; cursor: pointer; font-size: .88rem; color: var(--c-text,#f1f5f9); }
.sgf-checkbox-row input[type=checkbox] { width: 18px; height: 18px; cursor: pointer; accent-color: var(--c-blue,#5b8fff); }
.sgf-referral-fields { display: none; margin-top: 12px; }
.sgf-referral-fields.visible { display: block; }
.sgf-footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--c-border,#1e2d45); }
.sgf-btn-cancel { height: 42px; padding: 0 20px; border-radius: 8px; background: transparent; border: 1px solid var(--c-border,#1e2d45); color: var(--c-muted,#64748b); font-size: .9rem; font-weight: 600; cursor: pointer; }
.sgf-btn-submit { min-width: 160px; height: 42px; padding: 0 20px; border-radius: 8px; background: var(--c-blue,#5b8fff); border: none; color: #fff; font-size: .9rem; font-weight: 700; cursor: pointer; transition: opacity .15s; }
.sgf-btn-submit:hover { opacity: .88; }
.sgf-btn-submit:disabled { opacity: .5; cursor: not-allowed; }
.sgf-error { color: #ef4444; font-size: .82rem; margin-top: 4px; }
.sgf-section-divider { border: none; border-top: 1px solid var(--c-border,#1e2d45); margin: 20px 0; }
@media(max-width:480px){ .sgf-footer { flex-direction: column; } .sgf-btn-submit, .sgf-btn-cancel { width: 100%; } }
</style>

<div class="sgf-form" id="sgf-root">

  <!-- 1. Child picker -->
  <div class="sgf-field">
    <label class="sgf-label">Child <span class="sgf-req">*</span></label>
    <div id="sgf-selected-children"></div>
    ${preselectChildId && selChild
      ? `<div class="sgf-child-chip" data-child-id="${selChild.id}">
           ${_e(selChild.first_name + ' ' + selChild.last_name)}
           ${!preselectChildId ? '<span class="sgf-remove" data-remove-child="' + selChild.id + '">✕</span>' : ''}
         </div>`
      : `<select class="sgf-select" id="sgf-child-picker">
           <option value="">— Select child —</option>
           ${childrenOpts}
         </select>`
    }
    <div id="sgf-child-error" class="sgf-error" role="alert"></div>
  </div>

  <!-- 2. Date/time -->
  <div class="sgf-field">
    <label class="sgf-label" for="sgf-date">Date & time of concern <span class="sgf-req">*</span></label>
    <input type="datetime-local" class="sgf-input" id="sgf-date" value="${_e(draftDate)}" max="${_e(localISO)}">
  </div>

  <!-- 3. Categories -->
  <div class="sgf-field">
    <label class="sgf-label">Category <span class="sgf-req">*</span> <span style="font-size:.75rem;text-transform:none;letter-spacing:0">(select all that apply)</span></label>
    <div class="sgf-cat-group-label">Statutory — Working Together 2023</div>
    <div class="sgf-cat-chips" id="sgf-statutory-chips">${catStatutory}</div>
    <div class="sgf-cat-group-label" style="margin-top:10px">Contextual safeguarding</div>
    <div class="sgf-cat-chips" id="sgf-contextual-chips">${catContextual}</div>
    <div id="sgf-cat-error" class="sgf-error" role="alert"></div>
  </div>

  <!-- 4. Severity -->
  <div class="sgf-field">
    <label class="sgf-label">Severity</label>
    <div class="sgf-severity">
      <button type="button" class="sgf-sev-btn active-standard" data-sev="standard">Standard</button>
      <button type="button" class="sgf-sev-btn" data-sev="serious">Urgent / Serious</button>
      <button type="button" class="sgf-sev-btn" data-sev="critical">Critical</button>
    </div>
  </div>

  <hr class="sgf-section-divider">

  <!-- 5. What happened -->
  <div class="sgf-field">
    <label class="sgf-label" for="sgf-description">What happened — description <span class="sgf-req">*</span></label>
    <textarea class="sgf-textarea" id="sgf-description" placeholder="Describe what was observed, heard, or reported. Include direct quotes where possible. Use factual language." style="min-height:130px">${_e(draftDesc)}</textarea>
    <div id="sgf-desc-error" class="sgf-error" role="alert"></div>
    <div id="sgf-draft-status" style="font-size:.75rem;color:var(--c-muted,#64748b);margin-top:3px"></div>
  </div>

  <!-- 6. Body map -->
  ${bodyMapEnabled ? `
  <div class="sgf-field" id="sgf-body-map-section">
    <label class="sgf-label">Body map <span style="font-size:.75rem;text-transform:none;letter-spacing:0">(optional — tap to mark injuries)</span></label>
    <div class="sgf-body-map-wrap" id="sgf-body-map-wrap" style="position:relative;display:inline-block;width:100%;max-width:340px">
      <img src="/img/body-map.svg" id="sgf-body-map-svg" style="width:100%;display:block;border:1px solid var(--c-border,#1e2d45);border-radius:10px;cursor:crosshair" alt="Body map front and back" draggable="false">
      <div id="sgf-marks-layer" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none"></div>
    </div>
    <div style="font-size:.75rem;color:var(--c-muted,#64748b);margin-top:4px">Tap anywhere on the figure to mark. Tap a mark to add a note or remove it.</div>
    <div id="sgf-marks-list" style="margin-top:8px"></div>
  </div>` : ''}

  <!-- 7. Photos -->
  ${photosEnabled ? `
  <div class="sgf-field" id="sgf-photos-section">
    <label class="sgf-label">Injury photos <span style="font-size:.75rem;text-transform:none;letter-spacing:0">(optional)</span></label>
    <div class="sgf-photo-warn">⚠️ Photos of a child's injury require DSL approval before sharing. Consider whether a written description is sufficient. Photos are encrypted at rest.</div>
    <input type="file" class="sgf-input" id="sgf-photo-input" accept="image/*" capture="environment" multiple style="padding:8px">
    <div id="sgf-photo-list" class="sgf-photo-list"></div>
    <div id="sgf-photo-status" style="font-size:.75rem;color:var(--c-muted,#64748b);margin-top:4px"></div>
  </div>` : ''}

  <hr class="sgf-section-divider">

  <!-- 8. Immediate action -->
  <div class="sgf-field">
    <label class="sgf-label" for="sgf-action">Immediate action taken <span style="font-size:.75rem;text-transform:none;letter-spacing:0">(optional)</span></label>
    <textarea class="sgf-textarea" id="sgf-action" placeholder="e.g. Spoke to child, contacted parent, called LADO…" style="min-height:70px">${_e(draftAction)}</textarea>
  </div>

  <!-- 9. Witnessed by -->
  <div class="sgf-field">
    <label class="sgf-label" for="sgf-witnessed-by">Witnessed by <span style="font-size:.75rem;text-transform:none;letter-spacing:0">(optional)</span></label>
    <select class="sgf-select" id="sgf-witnessed-by">${staffOpts}</select>
  </div>

  <!-- 10. Persons involved -->
  <div class="sgf-field">
    <label class="sgf-label" for="sgf-persons-involved">Other persons involved <span style="font-size:.75rem;text-transform:none;letter-spacing:0">(names of adults, e.g. parent, visitor — optional)</span></label>
    <input type="text" class="sgf-input" id="sgf-persons-involved" placeholder="e.g. John Smith (parent), unknown adult">
  </div>

  <hr class="sgf-section-divider">

  <!-- 11. Referral -->
  <div class="sgf-field">
    <label class="sgf-checkbox-row">
      <input type="checkbox" id="sgf-is-referral">
      <span>This concern has been referred to an external agency</span>
    </label>
    <div class="sgf-referral-fields" id="sgf-referral-fields">
      <div class="sgf-field" style="margin-top:10px;margin-bottom:10px">
        <label class="sgf-label" for="sgf-referral-agency">Agency / organisation</label>
        <input type="text" class="sgf-input" id="sgf-referral-agency" placeholder="e.g. MASH, LADO, NSPCC, Police">
      </div>
      <div class="sgf-field" style="margin-bottom:10px">
        <label class="sgf-label" for="sgf-referral-date">Date of referral</label>
        <input type="date" class="sgf-input" id="sgf-referral-date">
      </div>
      <div class="sgf-field" style="margin-bottom:10px">
        <label class="sgf-label" for="sgf-referral-ref">Reference number</label>
        <input type="text" class="sgf-input" id="sgf-referral-ref" placeholder="e.g. LADO ref number">
      </div>
      <label class="sgf-checkbox-row" style="margin-top:4px">
        <input type="checkbox" id="sgf-requires-lado">
        <span>Requires LADO referral</span>
      </label>
    </div>
  </div>

  <!-- 12. Confidential -->
  <div class="sgf-field">
    <label class="sgf-checkbox-row">
      <input type="checkbox" id="sgf-confidential" checked>
      <span>Confidential (restrict to DSL/manager only)</span>
    </label>
  </div>

  <div id="sgf-submit-error" class="sgf-error" style="margin-bottom:10px" role="alert"></div>

  <div class="sgf-footer">
    <button type="button" class="sgf-btn-cancel" id="sgf-cancel">Cancel</button>
    <button type="button" class="sgf-btn-submit" id="sgf-submit">Submit Concern</button>
  </div>

</div>`;
  }

  // ── Attach behaviour ───────────────────────────────────────────────────────
  function _attachBehaviour(container, ctx) {
    const { preselectChildId, bodyMapEnabled, photosEnabled, onSaved, onCancel, childList } = ctx;

    let _severity    = 'standard';
    let _selectedCats = [];
    let _marks       = [];
    let _attachments = [];
    let _selectedChildId = preselectChildId || null;
    let _draftTimer;

    // ── Child picker ──────────────────────────────────────────────────────────
    const childPicker = container.querySelector('#sgf-child-picker');
    if (childPicker) {
      childPicker.addEventListener('change', () => {
        _selectedChildId = parseInt(childPicker.value) || null;
        container.querySelector('#sgf-child-error').textContent = '';
      });
    }

    // ── Category chips ────────────────────────────────────────────────────────
    container.querySelectorAll('.sgf-cat-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const cat = btn.dataset.cat;
        if (_selectedCats.includes(cat)) {
          _selectedCats = _selectedCats.filter(c => c !== cat);
          btn.classList.remove('selected');
        } else {
          _selectedCats.push(cat);
          btn.classList.add('selected');
        }
        container.querySelector('#sgf-cat-error').textContent = '';
      });
    });

    // ── Severity ──────────────────────────────────────────────────────────────
    container.querySelectorAll('.sgf-sev-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _severity = btn.dataset.sev;
        container.querySelectorAll('.sgf-sev-btn').forEach(b => {
          b.classList.remove('active-standard','active-serious','active-critical');
        });
        btn.classList.add('active-' + (_severity === 'serious' ? 'urgent' : _severity));
      });
    });

    // ── Draft auto-save ───────────────────────────────────────────────────────
    const descEl   = container.querySelector('#sgf-description');
    const actionEl = container.querySelector('#sgf-action');
    const dateEl   = container.querySelector('#sgf-date');

    function _doSaveDraft() {
      if (!descEl) return;
      const status = container.querySelector('#sgf-draft-status');
      _saveDraft({
        description:      descEl?.value,
        immediate_action: actionEl?.value,
        concern_date:     dateEl?.value,
        category_ids:     _selectedCats,
        severity:         _severity,
      });
      if (status) { status.textContent = 'Draft saved'; setTimeout(() => { status.textContent = ''; }, 2000); }
    }

    if (descEl) {
      descEl.addEventListener('input', () => {
        clearTimeout(_draftTimer);
        _draftTimer = setTimeout(_doSaveDraft, 2000);
      });
    }
    if (actionEl) actionEl.addEventListener('input', () => {
      clearTimeout(_draftTimer); _draftTimer = setTimeout(_doSaveDraft, 2000);
    });

    // ── Body map ──────────────────────────────────────────────────────────────
    if (bodyMapEnabled) {
      const mapImg   = container.querySelector('#sgf-body-map-svg');
      const mapLayer = container.querySelector('#sgf-marks-layer');
      const markList = container.querySelector('#sgf-marks-list');

      if (mapImg && mapLayer) {
        mapImg.addEventListener('click', e => {
          const rect = mapImg.getBoundingClientRect();
          const x = Math.round(((e.clientX - rect.left) / rect.width) * 100);
          const y = Math.round(((e.clientY - rect.top)  / rect.height) * 100);
          const side = x < 50 ? 'front' : 'back';
          const mark = { id: Date.now(), x, y, side, note: '' };
          _marks.push(mark);
          _renderMarks(mapLayer, markList, _marks, e);
        });
      }
    }

    function _renderMarks(layer, listEl, marks) {
      layer.innerHTML = '';
      marks.forEach(m => {
        const dot = document.createElement('div');
        dot.className = 'sgf-mark';
        dot.style.left = m.x + '%';
        dot.style.top  = m.y + '%';
        dot.title = m.note || 'No note';
        dot.textContent = _marks.indexOf(m) + 1;
        dot.style.pointerEvents = 'all';
        dot.addEventListener('click', e => {
          e.stopPropagation();
          _editMark(m, layer, listEl, marks);
        });
        layer.appendChild(dot);
      });
      if (listEl) {
        listEl.innerHTML = marks.length
          ? marks.map((m,i) => `<div style="font-size:.78rem;color:var(--c-muted,#64748b);display:flex;align-items:center;gap:6px;margin-bottom:2px">
              <span style="background:#ef4444;color:#fff;border-radius:50%;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;font-size:.65rem;font-weight:700;flex-shrink:0">${i+1}</span>
              ${_e(m.side)} — ${m.note ? _e(m.note) : '<em style="color:#475569">no note</em>'}
            </div>`).join('')
          : '';
      }
    }

    function _editMark(mark, layer, listEl, marks) {
      if (!window.Wren?.modal) {
        const note = window.prompt('Injury note (blank to clear, type REMOVE to delete):', mark.note);
        if (note === null) return;
        if (note.toUpperCase() === 'REMOVE') { const idx = marks.indexOf(mark); if (idx > -1) marks.splice(idx,1); }
        else mark.note = note;
        _renderMarks(layer, listEl, marks);
        return;
      }
      Wren.modal('Mark note', `
        <p style="font-size:.85rem;color:var(--c-muted,#64748b);margin-bottom:10px">Location: ${mark.side} (${mark.x}%, ${mark.y}%)</p>
        <textarea class="wren-textarea" id="sgf-mark-note" placeholder="Describe injury at this location (optional)…" style="width:100%;min-height:70px">${_e(mark.note)}</textarea>`, [
        { label: 'Save note', class: 'btn-primary', close: true, action: () => {
          mark.note = document.getElementById('sgf-mark-note')?.value || '';
          _renderMarks(layer, listEl, marks);
        }},
        { label: 'Remove mark', class: 'btn-ghost', close: true, action: () => {
          const idx = marks.indexOf(mark);
          if (idx > -1) marks.splice(idx,1);
          _renderMarks(layer, listEl, marks);
        }},
        { label: 'Cancel', class: 'btn-ghost' },
      ]);
    }

    // ── Photo upload ──────────────────────────────────────────────────────────
    if (photosEnabled) {
      const photoInput  = container.querySelector('#sgf-photo-input');
      const photoList   = container.querySelector('#sgf-photo-list');
      const photoStatus = container.querySelector('#sgf-photo-status');

      if (photoInput) {
        photoInput.addEventListener('change', async () => {
          const files = Array.from(photoInput.files);
          if (!files.length) return;
          if (photoStatus) photoStatus.textContent = 'Uploading…';
          const fd = new FormData();
          files.forEach(f => fd.append('photos', f));
          try {
            const tok = sessionStorage.getItem('wrenToken');
            const resp = await fetch('/api/safeguarding/upload', {
              method: 'POST',
              headers: tok ? { 'Authorization': 'Bearer ' + tok } : {},
              body: fd,
            });
            if (!resp.ok) throw new Error('Upload failed');
            const data = await resp.json();
            _attachments.push(...data.files);
            if (photoStatus) photoStatus.textContent = `${_attachments.length} photo(s) attached`;
            if (photoList) {
              photoList.innerHTML = _attachments.map(a =>
                `<img class="sgf-photo-thumb" src="${_e(a.url)}" alt="Uploaded photo" title="${_e(a.filename)}">`
              ).join('');
            }
          } catch(err) {
            if (photoStatus) photoStatus.textContent = 'Upload failed. Please try again.';
          }
          photoInput.value = '';
        });
      }
    }

    // ── Referral toggle ────────────────────────────────────────────────────────
    const referralChk = container.querySelector('#sgf-is-referral');
    const referralFlds = container.querySelector('#sgf-referral-fields');
    if (referralChk && referralFlds) {
      referralChk.addEventListener('change', () => {
        referralFlds.classList.toggle('visible', referralChk.checked);
      });
    }

    // ── Cancel ────────────────────────────────────────────────────────────────
    const cancelBtn = container.querySelector('#sgf-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', onCancel);

    // ── Submit ────────────────────────────────────────────────────────────────
    const submitBtn = container.querySelector('#sgf-submit');
    if (submitBtn) {
      submitBtn.addEventListener('click', async () => {
        // Validation
        let valid = true;

        const childId = _selectedChildId || (childPicker ? parseInt(childPicker.value) || null : null);
        if (!childId) {
          container.querySelector('#sgf-child-error').textContent = 'Please select a child';
          valid = false;
        }

        if (!_selectedCats.length) {
          container.querySelector('#sgf-cat-error').textContent = 'Please select at least one category';
          valid = false;
        }

        const desc = descEl?.value?.trim() || '';
        if (desc.length < 10) {
          container.querySelector('#sgf-desc-error').textContent = 'Description must be at least 10 characters';
          valid = false;
        } else {
          container.querySelector('#sgf-desc-error').textContent = '';
        }

        if (!valid) return;

        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting…';
        container.querySelector('#sgf-submit-error').textContent = '';

        const isReferral = container.querySelector('#sgf-is-referral')?.checked || false;
        const bodyMapMarks = _marks.length
          ? { marks: _marks.map(m => ({ x: m.x, y: m.y, side: m.side, note: m.note })), drawn_at: new Date().toISOString() }
          : null;

        // Parse persons_involved as array
        const piText = container.querySelector('#sgf-persons-involved')?.value?.trim() || '';
        const personsInvolved = piText ? piText.split(',').map(p => ({ name: p.trim(), type: 'other' })).filter(p => p.name) : [];

        const payload = {
          child_id:          childId,
          category:          _selectedCats[0],
          category_ids:      _selectedCats,
          severity:          _severity,
          description:       desc,
          immediate_action:  actionEl?.value?.trim() || null,
          witnessed_by:      parseInt(container.querySelector('#sgf-witnessed-by')?.value) || null,
          concern_date:      dateEl?.value ? new Date(dateEl.value).toISOString() : new Date().toISOString(),
          is_confidential:   container.querySelector('#sgf-confidential')?.checked !== false,
          is_referral:       isReferral,
          referral_agency:   isReferral ? (container.querySelector('#sgf-referral-agency')?.value?.trim() || null) : null,
          referral_date:     isReferral ? (container.querySelector('#sgf-referral-date')?.value || null) : null,
          referral_reference:isReferral ? (container.querySelector('#sgf-referral-ref')?.value?.trim() || null) : null,
          requires_lado:     isReferral ? (container.querySelector('#sgf-requires-lado')?.checked || false) : false,
          body_map_data:     bodyMapMarks,
          attachments:       _attachments.length ? _attachments : null,
          is_multi_child:    false,
          persons_involved:  personsInvolved,
        };

        try {
          const concern = await Wren.api('/api/safeguarding', { method: 'POST', body: payload });
          _clearDraft();
          if (window.Wren?.toast) Wren.toast('Safeguarding concern logged. DSL has been notified.', 'success');
          onSaved(concern);
        } catch(err) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit Concern';
          const msg = err?.message || 'Could not submit concern';
          container.querySelector('#sgf-submit-error').textContent = msg;
          // Save failed-submission to localStorage for recovery
          try {
            localStorage.setItem(
              `wren-sg-failed-${Date.now()}`,
              JSON.stringify(payload)
            );
          } catch {}
          if (window.Wren?.toast) Wren.toast('Submission failed. Draft saved locally for retry.', 'error');
        }
      });
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  global.WrenSafeguardingForm = { mount };

}(window));
