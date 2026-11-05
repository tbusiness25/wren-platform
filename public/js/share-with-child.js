'use strict';
// b155 — "Share with child" widget: a small reusable control used on next-steps,
// phonics, story-studio and activity-bank pages to push an item onto a child's
// parent-portal "Home activities" card. Shared static file — same script on the
// EY (Nest) and Roost portals; both already load wren-core.js providing Wren.api/toast.
(function () {
  var STYLE_ID = 'wren-share-widget-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent =
      '.wren-share-btn{font-size:.75rem;padding:5px 10px;border-radius:7px;border:1px solid var(--c-border,#2d3748);' +
      'background:var(--c-surface,#1e293b);color:var(--c-muted,#94a3b8);cursor:pointer;white-space:nowrap}' +
      '.wren-share-btn:hover{border-color:var(--c-blue,#4a9abf);color:var(--c-blue,#4a9abf)}' +
      '.wren-share-btn.shared{background:#22c55e22;border-color:#22c55e55;color:#86efac}' +
      '.wren-share-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9000;display:none}' +
      '.wren-share-modal-backdrop.open{display:block}' +
      '.wren-share-modal{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9001;' +
      'background:var(--c-surface,#1e293b);border:1px solid var(--c-border,#2d3748);border-radius:14px;' +
      'padding:18px;width:min(420px,92vw);display:none}' +
      '.wren-share-modal.open{display:block}' +
      '.wren-share-modal h3{margin:0 0 10px;font-size:1rem;color:var(--c-text,#f1f5f9)}' +
      '.wren-share-modal select,.wren-share-modal input{width:100%;box-sizing:border-box;padding:8px 10px;' +
      'border-radius:8px;border:1px solid var(--c-border,#2d3748);background:var(--c-bg,#0f172a);' +
      'color:var(--c-text,#f1f5f9);margin-bottom:10px;font-size:.88rem}' +
      '.wren-share-modal .row{display:flex;gap:8px;justify-content:flex-end;margin-top:6px}';
    document.head.appendChild(s);
  }

  function api(url, opts) {
    if (window.Wren && Wren.api) return Wren.api(url, opts);
    return fetch(url, opts).then(function (r) { return r.json(); });
  }
  function toast(msg, kind) {
    if (window.Wren && Wren.toast) Wren.toast(msg, kind);
  }

  // Renders an inline "Share to home" button HTML string. Call WrenShare.wire()
  // after inserting it into the DOM so its click handler gets attached.
  function btn(opts) {
    var attrs = ['data-wren-share="1"',
      'data-child-id="' + opts.childId + '"',
      'data-item-type="' + opts.itemType + '"',
      'data-item-id="' + (opts.itemId != null ? opts.itemId : '') + '"',
      'data-title="' + String(opts.title || '').replace(/"/g, '&quot;') + '"',
      'data-description="' + String(opts.description || '').replace(/"/g, '&quot;') + '"'];
    return '<button type="button" class="wren-share-btn" ' + attrs.join(' ') + '>📤 Share to home</button>';
  }

  // For pages where the child isn't known yet (e.g. activity bank cards, story
  // sessions) — opens a tiny modal to pick a child from a supplied list first.
  function btnPickChild(opts) {
    var attrs = ['data-wren-share-pick="1"',
      'data-item-type="' + opts.itemType + '"',
      'data-item-id="' + (opts.itemId != null ? opts.itemId : '') + '"',
      'data-title="' + String(opts.title || '').replace(/"/g, '&quot;') + '"',
      'data-description="' + String(opts.description || '').replace(/"/g, '&quot;') + '"'];
    return '<button type="button" class="wren-share-btn" ' + attrs.join(' ') + '>📤 Share to a child</button>';
  }

  function doShare(childId, itemType, itemId, title, description, btnEl, attachments) {
    return api('/api/shared-items', { method: 'POST', body: {
      child_id: childId, item_type: itemType, item_id: itemId || null, title: title,
      description: description, attachments: attachments || []
    }}).then(function (r) {
      if (r && r.id) {
        toast('Shared to home learning', 'success');
        if (btnEl) { btnEl.classList.add('shared'); btnEl.textContent = '✓ Shared'; btnEl.disabled = true; }
      } else {
        toast((r && r.error) || 'Could not share', 'error');
      }
      return r;
    }).catch(function () { toast('Could not share', 'error'); });
  }

  function openPicker(itemType, itemId, title, description) {
    ensureStyle();
    var backdrop = document.getElementById('wren-share-backdrop');
    var modal = document.getElementById('wren-share-modal');
    if (!backdrop) {
      backdrop = document.createElement('div'); backdrop.id = 'wren-share-backdrop'; backdrop.className = 'wren-share-modal-backdrop';
      document.body.appendChild(backdrop);
    }
    if (!modal) {
      modal = document.createElement('div'); modal.id = 'wren-share-modal'; modal.className = 'wren-share-modal';
      document.body.appendChild(modal);
    }
    modal.innerHTML =
      '<h3>Share to a child’s home learning</h3>' +
      '<select id="wren-share-child-select"><option value="">Loading children…</option></select>' +
      // item 6 (2026-07-29) — optional doc to attach to this home activity (resource
      // card, phonics sound sheet, …). Paste a link or a /resources path; left blank = none.
      '<input id="wren-share-doc-name" type="text" placeholder="Attach a document — label (optional), e.g. “Phonics sound mat”">' +
      '<input id="wren-share-doc-url" type="text" placeholder="…and its link / path (optional), e.g. /resources/s-sound.pdf">' +
      '<div class="row">' +
      '<button type="button" class="wren-share-btn" id="wren-share-cancel">Cancel</button>' +
      '<button type="button" class="wren-share-btn" id="wren-share-confirm">Share</button>' +
      '</div>';
    backdrop.classList.add('open'); modal.classList.add('open');
    function close() { backdrop.classList.remove('open'); modal.classList.remove('open'); }
    backdrop.onclick = close;
    document.getElementById('wren-share-cancel').onclick = close;
    api('/api/children?is_active=true').then(function (rows) {
      var sel = document.getElementById('wren-share-child-select');
      var list = Array.isArray(rows) ? rows : (rows && rows.children) || [];
      if (!list.length) { sel.innerHTML = '<option value="">No children found</option>'; return; }
      sel.innerHTML = list.map(function (c) {
        var name = (c.first_name || '') + ' ' + (c.last_name || '');
        return '<option value="' + c.id + '">' + name.trim() + '</option>';
      }).join('');
    }).catch(function () {
      document.getElementById('wren-share-child-select').innerHTML = '<option value="">Could not load children</option>';
    });
    document.getElementById('wren-share-confirm').onclick = function () {
      var childId = document.getElementById('wren-share-child-select').value;
      if (!childId) return;
      var docUrl = (document.getElementById('wren-share-doc-url').value || '').trim();
      var docName = (document.getElementById('wren-share-doc-name').value || '').trim();
      var attachments = docUrl ? [{ name: docName || docUrl, url: docUrl, kind: 'document' }] : [];
      doShare(childId, itemType, itemId, title, description, null, attachments).then(close);
    };
  }

  function wire(root) {
    ensureStyle();
    (root || document).querySelectorAll('[data-wren-share]:not([data-wired])').forEach(function (el) {
      el.setAttribute('data-wired', '1');
      el.addEventListener('click', function () {
        doShare(el.getAttribute('data-child-id'), el.getAttribute('data-item-type'),
          el.getAttribute('data-item-id') || null, el.getAttribute('data-title'),
          el.getAttribute('data-description'), el);
      });
    });
    (root || document).querySelectorAll('[data-wren-share-pick]:not([data-wired])').forEach(function (el) {
      el.setAttribute('data-wired', '1');
      el.addEventListener('click', function () {
        openPicker(el.getAttribute('data-item-type'), el.getAttribute('data-item-id') || null,
          el.getAttribute('data-title'), el.getAttribute('data-description'));
      });
    });
  }

  window.WrenShare = { btn: btn, btnPickChild: btnPickChild, wire: wire, share: doShare, pickChild: openPicker };
}());
