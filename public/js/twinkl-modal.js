/**
 * TwinklModal — shared Twinkl resource search/attach component.
 *
 * Usage:
 *   const modal = new TwinklModal({ onAttach: (resource) => { ... } });
 *   modal.open({ entityType: 'homework', entityId: 42, title: 'Fractions' });
 *
 * onAttach receives: { id, entity_type, entity_id, provider, external_url, title, description, thumbnail_url, tags }
 */
class TwinklModal {
  constructor({ onAttach } = {}) {
    this.onAttach = onAttach || (() => {});
    this._entityType = null;
    this._entityId = null;
    this._mode = 'api'; // 'api' | 'fallback'
    this._inject();
  }

  _inject() {
    if (document.getElementById('twinkl-modal-overlay')) return;
    const style = document.createElement('style');
    style.textContent = `
      #twinkl-modal-overlay {
        position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:2000;
        display:none;align-items:center;justify-content:center;padding:16px;
      }
      #twinkl-modal-overlay.open { display:flex; }
      #twinkl-modal-box {
        background:#1e293b;border:1px solid #2d3748;border-radius:16px;
        padding:24px;width:100%;max-width:680px;max-height:90vh;
        overflow-y:auto;display:flex;flex-direction:column;gap:0;
      }
      .tw-header { display:flex;justify-content:space-between;align-items:center;margin-bottom:18px; }
      .tw-logo-row { display:flex;align-items:center;gap:10px; }
      .tw-brand {
        background:#00b3e1;color:#fff;font-size:13px;font-weight:800;
        padding:3px 10px;border-radius:6px;letter-spacing:.02em;
      }
      .tw-brand-sub { font-size:12px;color:#94a3b8; }
      .tw-close-btn {
        background:none;border:none;color:#94a3b8;font-size:22px;cursor:pointer;
        line-height:1;padding:4px 8px;border-radius:6px;
      }
      .tw-close-btn:hover { color:#f1f5f9;background:#334155; }
      .tw-tabs { display:flex;gap:0;border-bottom:2px solid #2d3748;margin-bottom:18px; }
      .tw-tab {
        background:none;border:none;color:#94a3b8;padding:8px 16px;cursor:pointer;
        font-size:13px;font-weight:600;border-bottom:3px solid transparent;margin-bottom:-2px;transition:.15s;
      }
      .tw-tab.active { color:#4a9abf;border-bottom-color:#4a9abf; }
      .tw-tab:hover:not(.active) { color:#f1f5f9; }
      .tw-search-row { display:flex;gap:8px;margin-bottom:16px; }
      .tw-search-input {
        flex:1;padding:10px 14px;border-radius:10px;border:1px solid #2d3748;
        background:#0f172a;color:#f1f5f9;font-size:14px;outline:none;
      }
      .tw-search-input:focus { border-color:#4a9abf; }
      .tw-search-btn {
        padding:10px 18px;border-radius:10px;border:none;
        background:#4a9abf;color:#fff;font-size:13px;font-weight:700;cursor:pointer;
        white-space:nowrap;transition:.15s;
      }
      .tw-search-btn:hover { background:#3b87aa; }
      .tw-search-btn:disabled { opacity:.5;cursor:not-allowed; }
      .tw-results { display:flex;flex-direction:column;gap:10px;margin-bottom:8px; }
      .tw-resource-card {
        display:flex;gap:12px;align-items:flex-start;
        background:#0f172a;border:1px solid #2d3748;border-radius:10px;padding:12px;
        cursor:pointer;transition:.15s;
      }
      .tw-resource-card:hover { border-color:#4a9abf;background:#0f2133; }
      .tw-thumb {
        width:64px;height:64px;border-radius:6px;object-fit:cover;flex-shrink:0;
        background:#1e293b;border:1px solid #2d3748;
      }
      .tw-thumb-placeholder {
        width:64px;height:64px;border-radius:6px;flex-shrink:0;
        background:#1e293b;border:1px solid #2d3748;
        display:flex;align-items:center;justify-content:center;
        font-size:22px;color:#475569;
      }
      .tw-resource-info { flex:1;min-width:0; }
      .tw-resource-title { font-weight:700;font-size:14px;color:#f1f5f9;margin-bottom:4px;line-height:1.3; }
      .tw-resource-desc { font-size:12px;color:#94a3b8;line-height:1.5;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical; }
      .tw-resource-tags { display:flex;flex-wrap:wrap;gap:4px;margin-top:6px; }
      .tw-tag { background:#1e293b;border:1px solid #2d3748;border-radius:4px;padding:1px 7px;font-size:10px;color:#94a3b8; }
      .tw-attach-btn {
        padding:6px 14px;border-radius:8px;border:none;background:#e07820;color:#fff;
        font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;
        align-self:center;transition:.15s;
      }
      .tw-attach-btn:hover { background:#c96e1a; }
      .tw-attach-btn:disabled { opacity:.5;cursor:not-allowed; }
      .tw-empty { text-align:center;color:#64748b;padding:32px 16px;font-size:14px; }
      .tw-paste-panel { display:flex;flex-direction:column;gap:14px; }
      .tw-paste-label { font-size:12px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px; }
      .tw-paste-input {
        width:100%;padding:10px 14px;border-radius:10px;border:1px solid #2d3748;
        background:#0f172a;color:#f1f5f9;font-size:13px;outline:none;box-sizing:border-box;
      }
      .tw-paste-input:focus { border-color:#4a9abf; }
      .tw-paste-preview {
        background:#0f172a;border:1px solid #2d3748;border-radius:10px;padding:14px;
        display:none;flex-direction:column;gap:10px;
      }
      .tw-paste-preview.visible { display:flex; }
      .tw-paste-meta { display:flex;gap:12px;align-items:flex-start; }
      .tw-settings-panel { display:flex;flex-direction:column;gap:14px; }
      .tw-settings-info { background:#0f172a;border:1px solid #2d3748;border-radius:10px;padding:14px;font-size:13px;color:#94a3b8;line-height:1.6; }
      .tw-settings-input {
        width:100%;padding:10px 14px;border-radius:10px;border:1px solid #2d3748;
        background:#0f172a;color:#f1f5f9;font-size:13px;outline:none;box-sizing:border-box;
      }
      .tw-settings-input:focus { border-color:#4a9abf; }
      .tw-settings-btn {
        padding:10px 20px;border-radius:10px;border:none;
        background:#4a9abf;color:#fff;font-size:13px;font-weight:700;cursor:pointer;transition:.15s;
      }
      .tw-settings-btn:hover { background:#3b87aa; }
      .tw-settings-btn.danger { background:#7f1d1d;color:#fca5a5; }
      .tw-settings-btn.danger:hover { background:#991b1b; }
      .tw-status-ok { color:#4ade80;font-weight:700;font-size:12px; }
      .tw-status-none { color:#f59e0b;font-weight:700;font-size:12px; }
      .tw-notice { background:#4a9abf18;border:1px solid #4a9abf44;border-radius:8px;padding:10px 14px;font-size:13px;color:#7dd3fc;text-align:center; }
      .tw-attribution { display:flex;align-items:center;justify-content:center;gap:6px;margin-top:14px;padding-top:12px;border-top:1px solid #1e293b;font-size:11px;color:#475569; }
    `;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.id = 'twinkl-modal-overlay';
    overlay.innerHTML = `
      <div id="twinkl-modal-box" role="dialog" aria-modal="true" aria-label="Search Twinkl Resources">
        <div class="tw-header">
          <div class="tw-logo-row">
            <span class="tw-brand">twinkl</span>
            <span class="tw-brand-sub">Resource Library</span>
          </div>
          <button class="tw-close-btn" id="tw-close-btn" aria-label="Close">&times;</button>
        </div>
        <div class="tw-tabs">
          <button class="tw-tab active" id="tw-tab-search" onclick="TwinklModal._inst._showTab('search')">Search</button>
          <button class="tw-tab" id="tw-tab-paste" onclick="TwinklModal._inst._showTab('paste')">Paste URL</button>
          <button class="tw-tab" id="tw-tab-settings" onclick="TwinklModal._inst._showTab('settings')">Settings</button>
        </div>

        <!-- Search tab -->
        <div id="tw-panel-search">
          <div id="tw-not-configured-notice" class="tw-notice" style="display:none;margin-bottom:14px">
            Twinkl API not configured — search results will be limited. Use <strong>Paste URL</strong> or configure your API key in <strong>Settings</strong>.
          </div>
          <div class="tw-search-row">
            <input type="text" class="tw-search-input" id="tw-search-input"
              placeholder="e.g. Year 4 fractions worksheet" autocomplete="off"
              onkeydown="if(event.key==='Enter')TwinklModal._inst._doSearch()">
            <button class="tw-search-btn" id="tw-search-btn" onclick="TwinklModal._inst._doSearch()">Search</button>
          </div>
          <div id="tw-results" class="tw-results">
            <div class="tw-empty">Enter a search term above to find Twinkl resources.</div>
          </div>
        </div>

        <!-- Paste URL tab -->
        <div id="tw-panel-paste" style="display:none">
          <div class="tw-paste-panel">
            <div>
              <div class="tw-paste-label">Paste a Twinkl resource URL</div>
              <input type="url" class="tw-paste-input" id="tw-paste-input"
                placeholder="https://www.twinkl.co.uk/resource/..."
                oninput="TwinklModal._inst._onPasteInput(this.value)">
            </div>
            <div id="tw-paste-preview" class="tw-paste-preview">
              <div class="tw-paste-meta">
                <div id="tw-paste-thumb-wrap"></div>
                <div style="flex:1">
                  <div class="tw-resource-title" id="tw-paste-title">Loading…</div>
                  <div class="tw-resource-desc" id="tw-paste-desc"></div>
                </div>
              </div>
              <button class="tw-attach-btn" id="tw-paste-attach-btn"
                onclick="TwinklModal._inst._attachFromPaste()" style="align-self:flex-end">
                Attach to lesson
              </button>
            </div>
          </div>
        </div>

        <!-- Settings tab -->
        <div id="tw-panel-settings" style="display:none">
          <div class="tw-settings-panel">
            <div class="tw-settings-info">
              Enter your <strong>Twinkl Partner API key</strong> to enable live resource search.
              Without an API key, you can still attach resources by pasting a Twinkl URL.<br><br>
              API keys are stored encrypted — Wren staff cannot read your key.
            </div>
            <div>
              <div class="tw-paste-label">Current status</div>
              <div id="tw-settings-status" style="font-size:13px;color:#94a3b8">Checking…</div>
            </div>
            <div>
              <div class="tw-paste-label">API Key</div>
              <input type="password" class="tw-settings-input" id="tw-api-key-input"
                placeholder="Paste your Twinkl API key here" autocomplete="new-password">
            </div>
            <div style="display:flex;gap:10px">
              <button class="tw-settings-btn" onclick="TwinklModal._inst._saveApiKey()">Save API Key</button>
              <button class="tw-settings-btn danger" onclick="TwinklModal._inst._clearApiKey()">Remove Key</button>
            </div>
          </div>
        </div>

        <div class="tw-attribution">
          <img src="https://www.twinkl.co.uk/favicon.ico" width="14" height="14" alt="">
          Resources provided by <a href="https://www.twinkl.co.uk" target="_blank" rel="noopener" style="color:#4a9abf">Twinkl</a>
          — click any resource to open on Twinkl.co.uk
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => { if (e.target === overlay) this.close(); });
    document.getElementById('tw-close-btn').addEventListener('click', () => this.close());

    // Store singleton ref so inline onclick handlers can reach it
    TwinklModal._inst = this;
  }

  open({ entityType, entityId, title = '' } = {}) {
    this._entityType = entityType;
    this._entityId = entityId;
    document.getElementById('tw-search-input').value = title || '';
    document.getElementById('twinkl-modal-overlay').classList.add('open');
    this._showTab('search');
    this._loadSettings();
    if (title) this._doSearch();
  }

  close() {
    document.getElementById('twinkl-modal-overlay').classList.remove('open');
    this._entityType = null;
    this._entityId = null;
  }

  _showTab(name) {
    ['search', 'paste', 'settings'].forEach(t => {
      document.getElementById(`tw-panel-${t}`).style.display = t === name ? '' : 'none';
      document.getElementById(`tw-tab-${t}`).classList.toggle('active', t === name);
    });
    if (name === 'settings') this._loadSettings();
  }

  async _loadSettings() {
    try {
      const data = await fetch('/api/twinkl/settings').then(r => r.json());
      const el = document.getElementById('tw-settings-status');
      if (el) {
        el.innerHTML = data.configured
          ? `<span class="tw-status-ok">Configured</span> &nbsp; Key: <code style="font-size:11px">${data.masked_key}</code>`
          : `<span class="tw-status-none">Not configured</span> — paste URL mode only`;
      }
      const notice = document.getElementById('tw-not-configured-notice');
      if (notice) notice.style.display = data.configured ? 'none' : '';
    } catch { /* network */ }
  }

  async _doSearch() {
    const q = document.getElementById('tw-search-input').value.trim();
    if (!q) return;
    const btn = document.getElementById('tw-search-btn');
    btn.disabled = true; btn.textContent = 'Searching…';
    const container = document.getElementById('tw-results');
    container.innerHTML = '<div class="tw-empty">Searching Twinkl…</div>';
    try {
      const data = await fetch(`/api/twinkl/search?${new URLSearchParams({ q })}`).then(r => r.json());
      if (data.mode === 'fallback' || !data.results.length) {
        container.innerHTML = `<div class="tw-empty">${this._esc(data.message || 'No results found.')}<br><br>
          <button class="tw-search-btn" style="margin:0 auto"
            onclick="TwinklModal._inst._showTab('paste')">Paste a Twinkl URL instead</button>
        </div>`;
        document.getElementById('tw-not-configured-notice').style.display = '';
      } else {
        container.innerHTML = '';
        data.results.forEach(r => container.appendChild(this._buildCard(r)));
      }
    } catch (e) {
      container.innerHTML = `<div class="tw-empty">Search failed: ${this._esc(e.message)}</div>`;
    } finally {
      btn.disabled = false; btn.textContent = 'Search';
    }
  }

  _buildCard(r) {
    const card = document.createElement('div');
    card.className = 'tw-resource-card';

    const thumbHtml = r.thumbnail_url
      ? `<img class="tw-thumb" src="${this._esc(r.thumbnail_url)}" alt="" loading="lazy" onerror="this.parentNode.replaceChild(Object.assign(document.createElement('div'),{className:'tw-thumb-placeholder',textContent:'📄'}),this)">`
      : `<div class="tw-thumb-placeholder">📄</div>`;

    const tagsHtml = (r.tags || []).slice(0, 4).map(t => `<span class="tw-tag">${this._esc(t)}</span>`).join('');

    card.innerHTML = `
      ${thumbHtml}
      <div class="tw-resource-info">
        <div class="tw-resource-title">${this._esc(r.title)}</div>
        ${r.description ? `<div class="tw-resource-desc">${this._esc(r.description)}</div>` : ''}
        ${tagsHtml ? `<div class="tw-resource-tags">${tagsHtml}</div>` : ''}
      </div>
      <button class="tw-attach-btn" data-url="${this._esc(r.external_url)}">Attach</button>
    `;

    card.querySelector('.tw-resource-title').addEventListener('click', () => {
      window.open(r.external_url, '_blank', 'noopener');
    });

    card.querySelector('.tw-attach-btn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = 'Attaching…';
      await this._attachResource(r);
      btn.textContent = 'Attached ✓';
    });

    return card;
  }

  _pasteDebounce = null;
  _onPasteInput(url) {
    clearTimeout(this._pasteDebounce);
    if (!url || !url.includes('twinkl.co.uk')) {
      document.getElementById('tw-paste-preview').classList.remove('visible');
      return;
    }
    this._pasteDebounce = setTimeout(() => this._resolveUrl(url), 600);
  }

  async _resolveUrl(url) {
    const preview = document.getElementById('tw-paste-preview');
    const titleEl = document.getElementById('tw-paste-title');
    const descEl = document.getElementById('tw-paste-desc');
    const thumbWrap = document.getElementById('tw-paste-thumb-wrap');

    titleEl.textContent = 'Fetching…';
    descEl.textContent = '';
    thumbWrap.innerHTML = '<div class="tw-thumb-placeholder">⏳</div>';
    preview.classList.add('visible');

    try {
      const data = await fetch('/api/twinkl/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      }).then(r => r.json());

      if (data.error) throw new Error(data.error);

      this._resolvedMeta = data;
      titleEl.textContent = data.title;
      descEl.textContent = data.description || '';
      thumbWrap.innerHTML = data.thumbnail_url
        ? `<img class="tw-thumb" src="${this._esc(data.thumbnail_url)}" alt="" loading="lazy">`
        : '<div class="tw-thumb-placeholder">📄</div>';
    } catch (e) {
      titleEl.textContent = 'Could not fetch resource details';
      descEl.textContent = e.message;
      thumbWrap.innerHTML = '<div class="tw-thumb-placeholder">⚠️</div>';
      this._resolvedMeta = { external_url: url, title: url, provider: 'twinkl' };
    }
  }

  async _attachFromPaste() {
    const url = document.getElementById('tw-paste-input').value.trim();
    if (!url) return;
    const meta = this._resolvedMeta || { external_url: url, title: url, provider: 'twinkl' };
    const btn = document.getElementById('tw-paste-attach-btn');
    btn.disabled = true; btn.textContent = 'Attaching…';
    await this._attachResource(meta);
    btn.disabled = false; btn.textContent = 'Attached ✓';
    setTimeout(() => { btn.textContent = 'Attach to lesson'; }, 2000);
  }

  async _attachResource(resource) {
    if (!this._entityType || !this._entityId) {
      console.warn('TwinklModal: no entity context set');
      return;
    }
    try {
      const row = await fetch('/api/twinkl/resources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_type: this._entityType,
          entity_id: this._entityId,
          external_url: resource.external_url,
          title: resource.title,
          description: resource.description || null,
          thumbnail_url: resource.thumbnail_url || null,
          tags: resource.tags || [],
        }),
      }).then(r => r.json());
      this.onAttach(row);
    } catch (e) {
      console.error('TwinklModal attach error:', e);
    }
  }

  async _saveApiKey() {
    const key = document.getElementById('tw-api-key-input').value.trim();
    if (!key) return;
    try {
      await fetch('/api/twinkl/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key }),
      });
      document.getElementById('tw-api-key-input').value = '';
      await this._loadSettings();
      // Show feedback inline
      const el = document.getElementById('tw-settings-status');
      el.innerHTML += ' &nbsp; <span style="color:#4ade80;font-size:12px">Saved ✓</span>';
    } catch (e) {
      alert('Failed to save API key: ' + e.message);
    }
  }

  async _clearApiKey() {
    if (!confirm('Remove Twinkl API key? You can still use URL paste mode.')) return;
    await fetch('/api/twinkl/settings', { method: 'DELETE' });
    await this._loadSettings();
  }

  _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
}

// Static singleton slot — inline onclick handlers use TwinklModal._inst
TwinklModal._inst = null;

// Convenience: render attached Twinkl resources into a container element.
// container: DOM element | selector string
// resources: array from GET /api/twinkl/resources
// onRemove(resourceId): called when X is clicked (optional)
TwinklModal.renderAttached = function renderAttached(container, resources, onRemove) {
  const el = typeof container === 'string' ? document.querySelector(container) : container;
  if (!el) return;
  if (!resources || !resources.length) { el.innerHTML = ''; return; }

  el.innerHTML = resources.map(r => `
    <div class="tw-attached-card" data-rid="${r.id}" style="
      display:flex;align-items:center;gap:10px;
      background:#0f172a;border:1px solid #2d3748;border-radius:8px;
      padding:8px 10px;margin-bottom:6px;
    ">
      ${r.thumbnail_url
        ? `<img src="${String(r.thumbnail_url||'').replace(/"/g,'')}" width="36" height="36" style="border-radius:4px;object-fit:cover;flex-shrink:0" alt="" loading="lazy">`
        : `<div style="width:36px;height:36px;border-radius:4px;background:#1e293b;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:16px">📄</div>`
      }
      <div style="flex:1;min-width:0">
        <a href="${String(r.external_url||'').replace(/"/g,'')}" target="_blank" rel="noopener"
          style="font-weight:700;font-size:13px;color:#f1f5f9;text-decoration:none;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          title="${String(r.title||'').replace(/"/g,'')}">${String(r.title||'').replace(/</g,'&lt;')}
        </a>
        <div style="display:flex;align-items:center;gap:6px;margin-top:2px">
          <img src="https://www.twinkl.co.uk/favicon.ico" width="12" height="12" alt="">
          <span style="font-size:11px;color:#94a3b8">Twinkl</span>
        </div>
      </div>
      ${onRemove
        ? `<button onclick="TwinklModal._removeAttached(${r.id})" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:16px;padding:4px 6px;flex-shrink:0" title="Remove">×</button>`
        : ''
      }
    </div>
  `).join('');

  if (onRemove) TwinklModal._removeAttached = async (id) => {
    await fetch(`/api/twinkl/resources/${id}`, { method: 'DELETE' });
    onRemove(id);
  };
};
