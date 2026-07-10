/* wren-module-renderer.js — shared form/record renderer across all Wren portals
 * Exposes window.WrenModuleRenderer with renderForm, renderRecord, renderFieldPreview.
 * Pure vanilla JS, no framework, no build step. Works on admin, ey, parents, hr editions.
 */
(function () {
  'use strict';

  // ── Auth ─────────────────────────────────────────────────────────────────────

  function getToken() {
    if (window.Wren && typeof Wren.getToken === 'function') return Wren.getToken();
    return sessionStorage.getItem('wrenToken') || '';
  }

  // ── Style injection (idempotent) ─────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('wmr-styles')) return;
    const s = document.createElement('style');
    s.id = 'wmr-styles';
    s.textContent = `
      .wmr-form { display:flex; flex-direction:column; gap:14px; }
      .wmr-field { display:flex; flex-direction:column; gap:5px; }
      .wmr-label {
        font-size:.73rem; font-weight:700; color:var(--c-muted,#94a3b8);
        text-transform:uppercase; letter-spacing:.05em;
        display:flex; align-items:center; gap:5px;
      }
      .wmr-required { color:var(--c-red,#ef4444); font-size:.85em; }
      .wmr-help { font-size:.72rem; color:var(--c-muted,#94a3b8); line-height:1.4; }
      .wmr-error { font-size:.73rem; color:var(--c-red,#ef4444); margin-top:2px; }
      .wmr-input {
        width:100%; padding:9px 11px;
        background:rgba(255,255,255,.04);
        border:1px solid var(--c-border,#2d3748);
        border-radius:8px; color:var(--c-text,#f1f5f9);
        font-size:.88rem; font-family:system-ui,Arial,sans-serif;
        transition:border-color .15s; box-sizing:border-box; min-height:44px;
      }
      .wmr-input:focus { outline:none; border-color:var(--c-blue,#4a9abf); }
      .wmr-input:disabled { opacity:.5; cursor:not-allowed; }
      textarea.wmr-input { resize:vertical; min-height:88px; }
      select.wmr-input { cursor:pointer; }
      .wmr-yes-no { display:flex; gap:8px; }
      .wmr-yn-btn {
        flex:1; padding:9px 14px; border-radius:12px;
        border:1px solid var(--c-border,#2d3748);
        background:transparent; color:var(--c-text,#f1f5f9);
        font-size:.88rem; cursor:pointer; transition:.15s; min-height:44px;
        font-family:system-ui,Arial,sans-serif;
      }
      .wmr-yn-btn:hover:not(:disabled) { border-color:var(--c-blue,#4a9abf); }
      .wmr-yn-btn.wmr-yn-yes { background:var(--c-blue,#4a9abf); border-color:var(--c-blue,#4a9abf); color:#fff; }
      .wmr-yn-btn.wmr-yn-no  { background:var(--c-red,#ef4444);  border-color:var(--c-red,#ef4444);  color:#fff; }
      .wmr-radio-group { display:flex; flex-direction:column; gap:6px; }
      .wmr-radio-label {
        display:flex; align-items:center; gap:10px; cursor:pointer;
        padding:8px 11px; border-radius:8px;
        border:1px solid var(--c-border,#2d3748);
        font-size:.88rem; color:var(--c-text,#f1f5f9);
        min-height:44px; transition:border-color .15s; user-select:none;
      }
      .wmr-radio-label:hover { border-color:var(--c-blue,#4a9abf); }
      .wmr-radio-label input[type=radio] { accent-color:var(--c-blue,#4a9abf); width:16px; height:16px; flex-shrink:0; }
      .wmr-radio-label.wmr-checked { border-color:var(--c-blue,#4a9abf); background:rgba(74,154,191,.08); }
      .wmr-photo-btn {
        padding:10px 16px; border-radius:10px;
        border:1px dashed var(--c-border,#2d3748);
        background:rgba(255,255,255,.03); color:var(--c-text,#f1f5f9);
        cursor:pointer; font-size:.85rem; width:100%; min-height:54px;
        display:flex; align-items:center; justify-content:center; gap:8px;
        transition:.15s; font-family:system-ui,Arial,sans-serif; box-sizing:border-box;
      }
      .wmr-photo-btn:hover { border-color:var(--c-blue,#4a9abf); background:rgba(74,154,191,.06); }
      .wmr-photo-grid { display:flex; flex-wrap:wrap; gap:8px; margin-top:6px; }
      .wmr-photo-thumb {
        position:relative; width:76px; height:76px;
        border-radius:8px; overflow:hidden;
        border:1px solid var(--c-border,#2d3748); flex-shrink:0;
      }
      .wmr-photo-thumb img { width:100%; height:100%; object-fit:cover; display:block; }
      .wmr-thumb-rm {
        position:absolute; top:2px; right:2px; background:rgba(0,0,0,.72);
        border:none; color:#fff; font-size:.65rem; cursor:pointer;
        border-radius:3px; padding:2px 5px; line-height:1.3; font-family:system-ui,Arial,sans-serif;
      }
      .wmr-sig-wrap { display:flex; flex-direction:column; gap:5px; }
      .wmr-sig-canvas {
        width:100%; display:block; border-radius:8px;
        border:2px dashed var(--c-border,#2d3748); background:#fff;
        touch-action:none; cursor:crosshair;
      }
      .wmr-sig-hint { font-size:.72rem; color:var(--c-muted,#94a3b8); text-align:center; }
      .wmr-sig-actions { display:flex; gap:8px; }
      .wmr-sig-preview { display:block; border-radius:8px; max-width:100%; border:1px solid var(--c-border,#2d3748); }
      .wmr-ts-note {
        font-size:.75rem; color:var(--c-muted,#94a3b8);
        padding:9px 11px; background:rgba(255,255,255,.03);
        border-radius:8px; border:1px solid var(--c-border,#2d3748);
        display:flex; align-items:center; gap:7px;
      }
      .wmr-disabled { opacity:.45; pointer-events:none; cursor:not-allowed; }
      .wmr-actions { display:flex; gap:10px; margin-top:6px; flex-wrap:wrap; }
      .wmr-btn {
        padding:9px 20px; border-radius:12px; border:none; cursor:pointer;
        font-size:.88rem; font-weight:600; font-family:system-ui,Arial,sans-serif;
        min-height:44px; transition:.2s ease; display:inline-flex; align-items:center;
      }
      .wmr-btn-primary { background:var(--c-blue,#4a9abf); color:#fff; }
      .wmr-btn-primary:hover:not(:disabled) { filter:brightness(1.1); }
      .wmr-btn-primary:disabled { opacity:.5; cursor:not-allowed; }
      .wmr-btn-orange  { background:var(--c-orange,#e07820); color:#fff; }
      .wmr-btn-ghost {
        background:rgba(255,255,255,.06); color:var(--c-text,#f1f5f9);
        border:1px solid var(--c-border,#2d3748);
      }
      .wmr-btn-ghost:hover { background:rgba(255,255,255,.11); }
      .wmr-banner {
        padding:11px 14px; border-radius:8px; font-size:.85rem; margin-top:4px;
      }
      .wmr-banner-success { background:rgba(34,197,94,.14); color:#22c55e; border:1px solid rgba(34,197,94,.3); }
      .wmr-banner-error   { background:rgba(239,68,68,.14);  color:#ef4444;  border:1px solid rgba(239,68,68,.3); }
      .wmr-view-row {
        padding:9px 0; border-bottom:1px solid var(--c-border,#2d3748);
        display:flex; flex-direction:column; gap:3px;
      }
      .wmr-view-label { font-size:.7rem; color:var(--c-muted,#94a3b8); font-weight:700; text-transform:uppercase; letter-spacing:.05em; }
      .wmr-view-value { font-size:.88rem; color:var(--c-text,#f1f5f9); white-space:pre-wrap; word-break:break-word; }
      .wmr-meta { font-size:.71rem; color:var(--c-muted,#94a3b8); margin-top:14px; padding-top:10px; border-top:1px solid var(--c-border,#2d3748); }
      .wmr-field-error .wmr-input,
      .wmr-field-error .wmr-photo-btn,
      .wmr-field-error .wmr-sig-canvas { border-color:var(--c-red,#ef4444) !important; }
      .wmr-field-error .wmr-yn-btn { border-color:var(--c-red,#ef4444) !important; }
      .wmr-view-img { max-width:200px; max-height:200px; border-radius:8px; border:1px solid var(--c-border,#2d3748); display:block; margin:3px 0; }
    `;
    document.head.appendChild(s);
  }

  // ── Utilities ────────────────────────────────────────────────────────────────

  function relativeTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const s = Math.floor(diff / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    const days = Math.floor(h / 24);
    if (days < 7) return days + 'd ago';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function fmtDate(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }

  function fmtDatetime(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    const date = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return date + ' at ' + time;
  }

  // Client-side image compression via canvas (used when file exceeds max_file_size_mb)
  function compressImage(file, maxDim, quality) {
    maxDim = maxDim || 1920;
    quality = quality || 0.85;
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function (e) {
        var img = new Image();
        img.onload = function () {
          var w = img.width, h = img.height;
          if (w <= maxDim && h <= maxDim) { resolve(file); return; }
          var ratio = Math.min(maxDim / w, maxDim / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
          var canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          canvas.toBlob(function (blob) {
            var name = file.name.replace(/\.[^.]+$/, '.jpg');
            resolve(new File([blob], name, { type: 'image/jpeg' }));
          }, 'image/jpeg', quality);
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // POST a single file to the uploads endpoint
  async function uploadFile(moduleId, recordId, fieldKey, file) {
    var fd = new FormData();
    fd.append('file', file);
    var token = getToken();
    var headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    var resp = await fetch(
      '/api/modules/' + moduleId + '/records/' + recordId + '/uploads?field_key=' + encodeURIComponent(fieldKey),
      { method: 'POST', headers: headers, body: fd }
    );
    if (!resp.ok) throw new Error('Upload failed (' + resp.status + ')');
    return resp.json();
  }

  // ── Field type registry ──────────────────────────────────────────────────────
  // Each entry: render(field, id) → Element
  //             validate(field, value) → string|null
  //             serialize(field, fieldWrap) → value
  //             deserialize(field, fieldWrap, value) → void
  //             format(field, value) → string (for view mode)

  var fieldTypes = {};

  // text ───────────────────────────────────────────────────────────────────────
  fieldTypes.text = {
    render: function (field, id) {
      var inp = document.createElement('input');
      inp.type = 'text'; inp.id = id; inp.className = 'wmr-input';
      if (field.placeholder) inp.placeholder = field.placeholder;
      inp.maxLength = 500;
      return inp;
    },
    validate: function (field, value) {
      if (field.required && !value) return (field.label || 'This field') + ' is required';
      if (value && value.length > 500) return 'Maximum 500 characters';
      return null;
    },
    serialize: function (field, wrap) {
      var inp = wrap.querySelector('input[type=text]');
      return inp ? inp.value : '';
    },
    deserialize: function (field, wrap, value) {
      var inp = wrap.querySelector('input[type=text]');
      if (inp) inp.value = value || '';
    },
    format: function (field, value) { return value || '—'; }
  };

  // long_text ──────────────────────────────────────────────────────────────────
  fieldTypes.long_text = {
    render: function (field, id) {
      var ta = document.createElement('textarea');
      ta.id = id; ta.className = 'wmr-input'; ta.rows = 4;
      if (field.placeholder) ta.placeholder = field.placeholder;
      return ta;
    },
    validate: function (field, value) {
      if (field.required && !value) return (field.label || 'This field') + ' is required';
      if (value && value.length > 5000) return 'Maximum 5000 characters';
      return null;
    },
    serialize: function (field, wrap) {
      var ta = wrap.querySelector('textarea');
      return ta ? ta.value : '';
    },
    deserialize: function (field, wrap, value) {
      var ta = wrap.querySelector('textarea');
      if (ta) ta.value = value || '';
    },
    format: function (field, value) { return value || '—'; }
  };

  // number ─────────────────────────────────────────────────────────────────────
  fieldTypes.number = {
    render: function (field, id) {
      var inp = document.createElement('input');
      inp.type = 'number'; inp.id = id; inp.className = 'wmr-input';
      if (field.min !== null && field.min !== undefined) inp.min = field.min;
      if (field.max !== null && field.max !== undefined) inp.max = field.max;
      if (field.placeholder) inp.placeholder = field.placeholder;
      return inp;
    },
    validate: function (field, value) {
      var empty = (value === '' || value === null || value === undefined);
      if (field.required && empty) return (field.label || 'This field') + ' is required';
      if (!empty) {
        var n = Number(value);
        if (isNaN(n)) return 'Must be a valid number';
        if (field.min !== null && field.min !== undefined && n < Number(field.min)) return 'Minimum value is ' + field.min;
        if (field.max !== null && field.max !== undefined && n > Number(field.max)) return 'Maximum value is ' + field.max;
      }
      return null;
    },
    serialize: function (field, wrap) {
      var inp = wrap.querySelector('input[type=number]');
      if (!inp || inp.value === '') return null;
      return Number(inp.value);
    },
    deserialize: function (field, wrap, value) {
      var inp = wrap.querySelector('input[type=number]');
      if (inp) inp.value = (value !== null && value !== undefined) ? value : '';
    },
    format: function (field, value) {
      if (value === null || value === undefined) return '—';
      return Number(value).toLocaleString();
    }
  };

  // date ───────────────────────────────────────────────────────────────────────
  fieldTypes.date = {
    render: function (field, id) {
      var inp = document.createElement('input');
      inp.type = 'date'; inp.id = id; inp.className = 'wmr-input';
      return inp;
    },
    validate: function (field, value) {
      if (field.required && !value) return (field.label || 'This field') + ' is required';
      if (value && isNaN(new Date(value).getTime())) return 'Invalid date';
      return null;
    },
    serialize: function (field, wrap) {
      var inp = wrap.querySelector('input[type=date]');
      return inp ? (inp.value || null) : null;
    },
    deserialize: function (field, wrap, value) {
      var inp = wrap.querySelector('input[type=date]');
      if (inp && value) {
        // Keep only YYYY-MM-DD portion
        inp.value = String(value).slice(0, 10);
      }
    },
    format: function (field, value) { return fmtDate(value); }
  };

  // datetime ───────────────────────────────────────────────────────────────────
  fieldTypes.datetime = {
    render: function (field, id) {
      var inp = document.createElement('input');
      inp.type = 'datetime-local'; inp.id = id; inp.className = 'wmr-input';
      return inp;
    },
    validate: function (field, value) {
      if (field.required && !value) return (field.label || 'This field') + ' is required';
      if (value && isNaN(new Date(value).getTime())) return 'Invalid date/time';
      return null;
    },
    serialize: function (field, wrap) {
      var inp = wrap.querySelector('input[type=datetime-local]');
      if (!inp || !inp.value) return null;
      return new Date(inp.value).toISOString();
    },
    deserialize: function (field, wrap, value) {
      var inp = wrap.querySelector('input[type=datetime-local]');
      if (inp && value) {
        var d = new Date(value);
        if (!isNaN(d.getTime())) {
          inp.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        }
      }
    },
    format: function (field, value) { return fmtDatetime(value); }
  };

  // timestamp_auto ─────────────────────────────────────────────────────────────
  // In renderForm: invisible — handled in serialize/submit logic, not rendered in form.
  // In renderFieldPreview: shows a clock placeholder.
  fieldTypes.timestamp_auto = {
    render: function (field, id) {
      // Only reaches here via renderFieldPreview
      var div = document.createElement('div');
      div.className = 'wmr-ts-note'; div.id = id;
      div.innerHTML = '&#x23F1; <em>Auto-filled on submit</em>';
      return div;
    },
    validate: function () { return null; },
    serialize: function () { return new Date().toISOString(); },
    deserialize: function () {},
    format: function (field, value) { return fmtDatetime(value); }
  };

  // yes_no ─────────────────────────────────────────────────────────────────────
  fieldTypes.yes_no = {
    render: function (field, id) {
      var wrap = document.createElement('div');
      wrap.className = 'wmr-yes-no'; wrap.id = id;

      var yBtn = document.createElement('button');
      yBtn.type = 'button'; yBtn.className = 'wmr-yn-btn'; yBtn.textContent = 'Yes';
      var nBtn = document.createElement('button');
      nBtn.type = 'button'; nBtn.className = 'wmr-yn-btn'; nBtn.textContent = 'No';

      function setVal(v) {
        yBtn.classList.toggle('wmr-yn-yes', v === true);
        nBtn.classList.toggle('wmr-yn-no', v === false);
        wrap._value = v;
      }
      yBtn.addEventListener('click', function () { setVal(wrap._value === true ? null : true); });
      nBtn.addEventListener('click', function () { setVal(wrap._value === false ? null : false); });

      wrap._value = null;
      wrap.appendChild(yBtn); wrap.appendChild(nBtn);
      return wrap;
    },
    validate: function (field, value) {
      if (field.required && (value === null || value === undefined)) return (field.label || 'This field') + ' is required';
      return null;
    },
    serialize: function (field, wrap) {
      var yn = wrap.querySelector('.wmr-yes-no');
      return yn ? yn._value : null;
    },
    deserialize: function (field, wrap, value) {
      var yn = wrap.querySelector('.wmr-yes-no');
      if (!yn) return;
      var boolVal = (value === true || value === 'true') ? true : (value === false || value === 'false') ? false : null;
      if (boolVal !== null) {
        var yBtn = yn.querySelector('.wmr-yn-btn:first-child');
        var nBtn = yn.querySelector('.wmr-yn-btn:last-child');
        yn._value = boolVal;
        if (yBtn) yBtn.classList.toggle('wmr-yn-yes', boolVal === true);
        if (nBtn) nBtn.classList.toggle('wmr-yn-no', boolVal === false);
      }
    },
    format: function (field, value) {
      if (value === true || value === 'true') return 'Yes';
      if (value === false || value === 'false') return 'No';
      return '—';
    }
  };

  // dropdown ───────────────────────────────────────────────────────────────────
  fieldTypes.dropdown = {
    render: function (field, id) {
      var sel = document.createElement('select');
      sel.id = id; sel.className = 'wmr-input';
      if (!field.required) {
        var blank = document.createElement('option');
        blank.value = ''; blank.textContent = '— Select —';
        sel.appendChild(blank);
      }
      (field.options || []).forEach(function (opt) {
        var o = document.createElement('option');
        o.value = opt; o.textContent = opt;
        sel.appendChild(o);
      });
      return sel;
    },
    validate: function (field, value) {
      if (field.required && !value) return (field.label || 'This field') + ' is required';
      if (value && field.options && !field.options.includes(String(value))) return 'Invalid selection';
      return null;
    },
    serialize: function (field, wrap) {
      var sel = wrap.querySelector('select');
      return sel ? (sel.value || null) : null;
    },
    deserialize: function (field, wrap, value) {
      var sel = wrap.querySelector('select');
      if (sel && value) sel.value = String(value);
    },
    format: function (field, value) { return value || '—'; }
  };

  // radio ──────────────────────────────────────────────────────────────────────
  fieldTypes.radio = {
    render: function (field, id) {
      var group = document.createElement('div');
      group.className = 'wmr-radio-group'; group.id = id;
      (field.options || []).forEach(function (opt) {
        var lbl = document.createElement('label');
        lbl.className = 'wmr-radio-label';
        var inp = document.createElement('input');
        inp.type = 'radio'; inp.name = id; inp.value = opt;
        inp.addEventListener('change', function () {
          group.querySelectorAll('.wmr-radio-label').forEach(function (l) { l.classList.remove('wmr-checked'); });
          lbl.classList.add('wmr-checked');
        });
        lbl.appendChild(inp);
        lbl.appendChild(document.createTextNode(' ' + opt));
        group.appendChild(lbl);
      });
      return group;
    },
    validate: function (field, value) {
      if (field.required && !value) return (field.label || 'This field') + ' is required';
      return null;
    },
    serialize: function (field, wrap) {
      var checked = wrap.querySelector('input[type=radio]:checked');
      return checked ? checked.value : null;
    },
    deserialize: function (field, wrap, value) {
      wrap.querySelectorAll('input[type=radio]').forEach(function (inp) {
        if (inp.value === value) {
          inp.checked = true;
          var lbl = inp.closest('.wmr-radio-label');
          if (lbl) lbl.classList.add('wmr-checked');
        }
      });
    },
    format: function (field, value) { return value || '—'; }
  };

  // photo (single) ─────────────────────────────────────────────────────────────
  fieldTypes.photo = {
    render: function (field, id) {
      var wrap = document.createElement('div'); wrap.id = id;
      wrap._files = [];
      var maxMb = field.max_file_size_mb || 5;
      var maxBytes = maxMb * 1024 * 1024;

      var fileInput = document.createElement('input');
      fileInput.type = 'file'; fileInput.accept = 'image/*';
      fileInput.setAttribute('capture', 'environment');
      fileInput.style.display = 'none';
      wrap.appendChild(fileInput);

      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'wmr-photo-btn';
      btn.innerHTML = '&#x1F4F7; Take photo or upload';
      btn.addEventListener('click', function () { fileInput.click(); });
      wrap.appendChild(btn);

      var grid = document.createElement('div'); grid.className = 'wmr-photo-grid';
      wrap.appendChild(grid);

      fileInput.addEventListener('change', async function () {
        var file = fileInput.files[0]; if (!file) return;
        fileInput.value = '';
        if (file.size > maxBytes) file = await compressImage(file, 1920, 0.85);
        wrap._files = [file];
        renderGrid();
      });

      function renderGrid() {
        grid.innerHTML = '';
        wrap._files.forEach(function (f, i) {
          var thumb = document.createElement('div'); thumb.className = 'wmr-photo-thumb';
          var img = document.createElement('img'); img.src = URL.createObjectURL(f);
          var rm = document.createElement('button'); rm.type = 'button'; rm.className = 'wmr-thumb-rm'; rm.textContent = '✕';
          rm.addEventListener('click', function () { wrap._files.splice(i, 1); renderGrid(); });
          thumb.appendChild(img); thumb.appendChild(rm); grid.appendChild(thumb);
        });
        btn.style.display = wrap._files.length ? 'none' : 'flex';
      }
      return wrap;
    },
    validate: function (field, value) {
      if (field.required && (!value || value === '__pending_upload__' && false))
        return (field.label || 'Photo') + ' is required';
      // value is null when no file, '__pending_upload__' when file pending
      if (field.required && !value) return (field.label || 'Photo') + ' is required';
      return null;
    },
    serialize: function (field, wrap) {
      var photoWrap = wrap.querySelector('[id^="wmr-f-"]') || wrap.querySelector('[id^="preview-f-"]');
      if (photoWrap && photoWrap._files && photoWrap._files.length) return '__pending_upload__';
      // Also check wrap itself (for cases where wrap IS the photoWrap)
      if (wrap._files && wrap._files.length) return '__pending_upload__';
      return null;
    },
    deserialize: function (field, wrap, value) {
      // In edit mode, existing uploads shown via _uploads in renderRecord
    },
    format: function (field, value) {
      if (!value) return '—';
      if (Array.isArray(value)) return value.length + ' photo(s)';
      return '(photo)';
    }
  };

  // photo_multi ────────────────────────────────────────────────────────────────
  fieldTypes.photo_multi = {
    render: function (field, id) {
      var wrap = document.createElement('div'); wrap.id = id;
      wrap._files = [];
      var maxPhotos = field.max_photos || 5;
      var maxMb = field.max_file_size_mb || 5;
      var maxBytes = maxMb * 1024 * 1024;

      var fileInput = document.createElement('input');
      fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.multiple = true;
      fileInput.setAttribute('capture', 'environment');
      fileInput.style.display = 'none';
      wrap.appendChild(fileInput);

      var grid = document.createElement('div'); grid.className = 'wmr-photo-grid';
      wrap.appendChild(grid);

      var addBtn = document.createElement('button');
      addBtn.type = 'button'; addBtn.className = 'wmr-photo-btn';
      addBtn.innerHTML = '&#x1F4F7; Add photos';
      addBtn.addEventListener('click', function () {
        if (wrap._files.length < maxPhotos) fileInput.click();
      });
      wrap.appendChild(addBtn);

      fileInput.addEventListener('change', async function () {
        var files = Array.from(fileInput.files); fileInput.value = '';
        for (var i = 0; i < files.length; i++) {
          if (wrap._files.length >= maxPhotos) break;
          var f = files[i];
          if (f.size > maxBytes) f = await compressImage(f, 1920, 0.85);
          wrap._files.push(f);
        }
        renderGrid();
      });

      function renderGrid() {
        grid.innerHTML = '';
        wrap._files.forEach(function (f, i) {
          var thumb = document.createElement('div'); thumb.className = 'wmr-photo-thumb';
          var img = document.createElement('img'); img.src = URL.createObjectURL(f);
          var rm = document.createElement('button'); rm.type = 'button'; rm.className = 'wmr-thumb-rm'; rm.textContent = '✕';
          rm.addEventListener('click', function () { wrap._files.splice(i, 1); renderGrid(); });
          thumb.appendChild(img); thumb.appendChild(rm); grid.appendChild(thumb);
        });
        var remaining = maxPhotos - wrap._files.length;
        addBtn.style.display = remaining <= 0 ? 'none' : 'flex';
        addBtn.innerHTML = wrap._files.length ? '&#x1F4F7; Add another (' + remaining + ' left)' : '&#x1F4F7; Add photos';
      }
      return wrap;
    },
    validate: function (field, value) {
      if (field.required && !value) return (field.label || 'Photos') + ' required';
      return null;
    },
    serialize: function (field, wrap) {
      var photoWrap = wrap.querySelector('[id^="wmr-f-"]') || wrap.querySelector('[id^="preview-f-"]') || wrap;
      if (photoWrap._files && photoWrap._files.length) return '__pending_upload__';
      return null;
    },
    deserialize: function (field, wrap, value) {},
    format: function (field, value) {
      if (!value) return '—';
      if (Array.isArray(value)) return value.length + ' photo(s)';
      return '(photos)';
    }
  };

  // signature ──────────────────────────────────────────────────────────────────
  fieldTypes.signature = {
    render: function (field, id) {
      var wrap = document.createElement('div');
      wrap.className = 'wmr-sig-wrap'; wrap.id = id;
      wrap._confirmed = false; wrap._blob = null;

      // Canvas
      var canvas = document.createElement('canvas');
      canvas.className = 'wmr-sig-canvas';
      canvas.width = 600; canvas.height = 180;
      wrap.appendChild(canvas);

      var hint = document.createElement('div');
      hint.className = 'wmr-sig-hint'; hint.textContent = 'Sign with finger or mouse';
      wrap.appendChild(hint);

      var actions = document.createElement('div'); actions.className = 'wmr-sig-actions';
      var clearBtn = document.createElement('button'); clearBtn.type = 'button';
      clearBtn.className = 'wmr-btn wmr-btn-ghost'; clearBtn.textContent = 'Clear';
      clearBtn.style.cssText = 'font-size:.8rem;padding:5px 12px;min-height:34px;';
      var confirmBtn = document.createElement('button'); confirmBtn.type = 'button';
      confirmBtn.className = 'wmr-btn wmr-btn-primary'; confirmBtn.textContent = 'Confirm';
      confirmBtn.style.cssText = 'font-size:.8rem;padding:5px 12px;min-height:34px;';
      actions.appendChild(clearBtn); actions.appendChild(confirmBtn);
      wrap.appendChild(actions);

      // Drawing
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';

      var drawing = false, lx = 0, ly = 0;

      function getPos(e) {
        var rect = canvas.getBoundingClientRect();
        var sx = canvas.width / rect.width, sy = canvas.height / rect.height;
        var cx = (e.clientX !== undefined ? e.clientX : e.touches[0].clientX);
        var cy = (e.clientY !== undefined ? e.clientY : e.touches[0].clientY);
        return [(cx - rect.left) * sx, (cy - rect.top) * sy];
      }
      function startDraw(e) { e.preventDefault(); drawing = true; var p = getPos(e); lx = p[0]; ly = p[1]; }
      function moveDraw(e) {
        if (!drawing) return; e.preventDefault();
        var p = getPos(e);
        ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(p[0], p[1]); ctx.stroke();
        lx = p[0]; ly = p[1];
        wrap._confirmed = false; wrap._blob = null;
        // Restore canvas if was hidden after confirm
        canvas.style.display = ''; hint.style.display = ''; actions.style.display = '';
        var prev = wrap.querySelector('.wmr-sig-preview'); if (prev) prev.remove();
      }
      function endDraw() { drawing = false; }

      canvas.addEventListener('mousedown', startDraw);
      canvas.addEventListener('mousemove', moveDraw);
      canvas.addEventListener('mouseup', endDraw);
      canvas.addEventListener('mouseleave', endDraw);
      canvas.addEventListener('touchstart', startDraw, { passive: false });
      canvas.addEventListener('touchmove', moveDraw, { passive: false });
      canvas.addEventListener('touchend', endDraw);

      clearBtn.addEventListener('click', function () {
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        wrap._confirmed = false; wrap._blob = null;
        canvas.style.display = ''; hint.style.display = ''; actions.style.display = '';
        var prev = wrap.querySelector('.wmr-sig-preview'); if (prev) prev.remove();
      });

      confirmBtn.addEventListener('click', function () {
        // Check if any pixels were drawn (non-white)
        var imgData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        var hasInk = false;
        for (var i = 0; i < imgData.length; i += 4) {
          if (imgData[i] < 250 || imgData[i+1] < 250 || imgData[i+2] < 250) { hasInk = true; break; }
        }
        if (!hasInk) { return; } // Nothing drawn yet
        canvas.toBlob(function (blob) {
          wrap._blob = blob; wrap._confirmed = true;
          var prev = wrap.querySelector('.wmr-sig-preview'); if (prev) prev.remove();
          var previewImg = document.createElement('img');
          previewImg.className = 'wmr-sig-preview';
          previewImg.src = URL.createObjectURL(blob);
          wrap.insertBefore(previewImg, canvas);
          canvas.style.display = 'none'; hint.style.display = 'none'; actions.style.display = 'none';
        }, 'image/png');
      });

      return wrap;
    },
    validate: function (field, value) {
      if (field.required && !value) return (field.label || 'Signature') + ' is required';
      return null;
    },
    serialize: function (field, wrap) {
      var sw = wrap.querySelector('.wmr-sig-wrap') || (wrap.classList.contains('wmr-sig-wrap') ? wrap : null);
      if (sw && sw._confirmed && sw._blob) return '__pending_upload__';
      return null;
    },
    deserialize: function (field, wrap, value) {
      // Existing signatures shown via _uploads in view mode
    },
    format: function (field, value) { return value ? '(signature)' : '—'; }
  };

  // ── Internal helpers ─────────────────────────────────────────────────────────

  function canSubmit(mod, portal, role) {
    if (!portal || !role) return true;
    var perms = mod.permissions || {};
    var portalPerms = perms[portal] || {};
    var rolePerms = portalPerms[role] || [];
    if (['admin', 'manager', 'deputy_manager'].includes(role)) return true;
    return rolePerms.includes('submit');
  }

  function parseFields(mod) {
    var f = mod.fields;
    if (Array.isArray(f)) return f;
    if (typeof f === 'string') { try { return JSON.parse(f); } catch (e) { return []; } }
    return [];
  }

  function buildWrapper(field, id) {
    var wrap = document.createElement('div');
    wrap.className = 'wmr-field';
    wrap.dataset.fieldKey = field.key;
    if (field.type !== 'timestamp_auto') {
      var lbl = document.createElement('label');
      lbl.className = 'wmr-label'; lbl.htmlFor = id;
      lbl.appendChild(document.createTextNode(field.label || field.key));
      if (field.required) {
        var req = document.createElement('span'); req.className = 'wmr-required'; req.textContent = ' *';
        lbl.appendChild(req);
      }
      wrap.appendChild(lbl);
    }
    return wrap;
  }

  function addHelpText(wrap, field) {
    if (field.help_text) {
      var help = document.createElement('div'); help.className = 'wmr-help';
      help.textContent = field.help_text; wrap.appendChild(help);
    }
  }

  // Get the primary child element (the actual input widget) within a field wrapper
  function getFieldEl(wrap, field) {
    return wrap.querySelector('#wmr-f-' + field.key) ||
           wrap.querySelector('#preview-f-' + field.key) ||
           wrap.querySelector('.wmr-yes-no') ||
           wrap.querySelector('.wmr-radio-group') ||
           wrap.querySelector('.wmr-sig-wrap');
  }

  function serializeField(field, fieldWrap) {
    if (field.type === 'timestamp_auto') return new Date().toISOString();
    var ft = fieldTypes[field.type]; if (!ft) return null;
    return ft.serialize(field, fieldWrap);
  }

  function validateAndMark(fields, formEl) {
    // Clear old errors
    formEl.querySelectorAll('.wmr-error').forEach(function (el) { el.remove(); });
    formEl.querySelectorAll('.wmr-field-error').forEach(function (el) { el.classList.remove('wmr-field-error'); });

    var errors = {};
    fields.forEach(function (field) {
      if (field.type === 'timestamp_auto') return;
      var ft = fieldTypes[field.type]; if (!ft) return;
      var fieldWrap = formEl.querySelector('[data-field-key="' + field.key + '"]');
      if (!fieldWrap) return;

      var value;
      if (field.type === 'photo' || field.type === 'photo_multi') {
        var pw = getFieldEl(fieldWrap, field) || fieldWrap;
        value = (pw && pw._files && pw._files.length) ? '__pending_upload__' : null;
      } else if (field.type === 'signature') {
        var sw = fieldWrap.querySelector('.wmr-sig-wrap') || getFieldEl(fieldWrap, field);
        value = (sw && sw._confirmed) ? '__pending_upload__' : null;
      } else {
        value = ft.serialize(field, fieldWrap);
      }

      var err = ft.validate(field, value);
      if (err) {
        errors[field.key] = err;
        fieldWrap.classList.add('wmr-field-error');
        var errEl = document.createElement('div'); errEl.className = 'wmr-error'; errEl.textContent = err;
        fieldWrap.appendChild(errEl);
      }
    });
    return errors;
  }

  // ── renderForm ───────────────────────────────────────────────────────────────

  async function renderForm(mod, container, options) {
    injectStyles();
    options = options || {};
    container.innerHTML = '';

    var fields = parseFields(mod);
    var portal = options.portal || '';
    var role = options.role || '';
    var prefill = options.prefill || {};
    var onSubmit = options.onSubmit;
    var onCancel = options.onCancel;
    var allowSubmit = canSubmit(mod, portal, role);

    var formEl = document.createElement('div'); formEl.className = 'wmr-form';

    fields.forEach(function (field) {
      if (field.type === 'timestamp_auto') return; // invisible in form
      var ft = fieldTypes[field.type];
      if (!ft) return;

      var id = 'wmr-f-' + field.key;
      var fieldWrap = buildWrapper(field, id);
      var fieldEl = ft.render(field, id);
      fieldWrap.appendChild(fieldEl);
      addHelpText(fieldWrap, field);

      if (!allowSubmit) {
        fieldWrap.classList.add('wmr-disabled');
        fieldWrap.title = 'You do not have permission to submit this form';
      }

      if (prefill[field.key] !== undefined && ft.deserialize) {
        ft.deserialize(field, fieldWrap, prefill[field.key]);
      }

      formEl.appendChild(fieldWrap);
    });

    // Actions row
    var actions = document.createElement('div'); actions.className = 'wmr-actions';

    var submitBtn = document.createElement('button');
    submitBtn.type = 'button'; submitBtn.className = 'wmr-btn wmr-btn-primary';
    submitBtn.textContent = 'Submit';
    if (!allowSubmit) submitBtn.disabled = true;
    actions.appendChild(submitBtn);

    if (onCancel) {
      var cancelBtn = document.createElement('button');
      cancelBtn.type = 'button'; cancelBtn.className = 'wmr-btn wmr-btn-ghost';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', onCancel);
      actions.appendChild(cancelBtn);
    }

    var bannerEl = document.createElement('div'); bannerEl.style.display = 'none';

    formEl.appendChild(actions);
    formEl.appendChild(bannerEl);
    container.appendChild(formEl);

    submitBtn.addEventListener('click', async function () {
      var errors = validateAndMark(fields, formEl);
      if (Object.keys(errors).length) {
        bannerEl.className = 'wmr-banner wmr-banner-error';
        bannerEl.textContent = 'Please fix the errors above before submitting.';
        bannerEl.style.display = '';
        return;
      }

      // Serialize
      var data = {};
      fields.forEach(function (field) {
        if (field.type === 'timestamp_auto') { data[field.key] = new Date().toISOString(); return; }
        var ft = fieldTypes[field.type]; if (!ft) return;
        var fw = formEl.querySelector('[data-field-key="' + field.key + '"]');
        if (fw) data[field.key] = ft.serialize(field, fw);
      });

      submitBtn.disabled = true; submitBtn.textContent = 'Submitting…';
      bannerEl.style.display = 'none';

      try {
        var result = onSubmit ? await onSubmit(data) : null;

        // Upload pending files if record was created
        if (result && result.id && mod.id) {
          for (var fi = 0; fi < fields.length; fi++) {
            var field = fields[fi];
            if (!['photo', 'photo_multi', 'signature'].includes(field.type)) continue;
            var fw = formEl.querySelector('[data-field-key="' + field.key + '"]');
            if (!fw) continue;

            if (field.type === 'photo' || field.type === 'photo_multi') {
              var pw = fw.querySelector('#wmr-f-' + field.key) || fw;
              var files = (pw && pw._files) ? Array.from(pw._files) : [];
              var uploadIds = [];
              for (var uf = 0; uf < files.length; uf++) {
                var up = await uploadFile(mod.id, result.id, field.key, files[uf]);
                uploadIds.push(up.id);
              }
              if (uploadIds.length) data[field.key] = uploadIds;
            }

            if (field.type === 'signature') {
              var sw = fw.querySelector('.wmr-sig-wrap') || fw;
              if (sw && sw._confirmed && sw._blob) {
                var sigFile = new File([sw._blob], field.key + '_signature.png', { type: 'image/png' });
                var sigUp = await uploadFile(mod.id, result.id, field.key, sigFile);
                data[field.key] = sigUp.id;
              }
            }
          }

          // Update record with file references
          var hasFiles = fields.some(function (f) { return ['photo','photo_multi','signature'].includes(f.type); });
          if (hasFiles) {
            var tok = getToken();
            var h2 = { 'Content-Type': 'application/json' };
            if (tok) h2['Authorization'] = 'Bearer ' + tok;
            await fetch('/api/modules/' + mod.id + '/records/' + result.id, {
              method: 'PUT',
              headers: h2,
              body: JSON.stringify({ data: data })
            });
          }
        }

        bannerEl.className = 'wmr-banner wmr-banner-success';
        bannerEl.textContent = '✓ Submitted successfully';
        bannerEl.style.display = '';
        submitBtn.textContent = 'Submitted ✓';
      } catch (e) {
        bannerEl.className = 'wmr-banner wmr-banner-error';
        bannerEl.textContent = '✕ ' + (e && (e.error || e.message) ? (e.error || e.message) : 'Submission failed. Please try again.');
        bannerEl.style.display = '';
        submitBtn.disabled = false; submitBtn.textContent = 'Submit';
      }
    });
  }

  // ── renderRecord ─────────────────────────────────────────────────────────────

  async function renderRecord(mod, record, container, options) {
    injectStyles();
    options = options || {};
    container.innerHTML = '';

    var fields = parseFields(mod);
    var data = typeof record.data === 'string' ? JSON.parse(record.data) : (record.data || {});
    var uploads = record._uploads || [];
    var mode = options.mode || 'view';

    if (mode === 'edit') {
      return renderForm(mod, container, {
        portal: options.portal, role: options.role,
        prefill: data,
        onSubmit: options.onSave,
        onCancel: options.onCancel
      });
    }

    var viewEl = document.createElement('div'); viewEl.className = 'wmr-form';

    fields.forEach(function (field) {
      var ft = fieldTypes[field.type]; if (!ft) return;
      var row = document.createElement('div'); row.className = 'wmr-view-row';
      var lbl = document.createElement('div'); lbl.className = 'wmr-view-label';
      lbl.textContent = field.label || field.key;
      row.appendChild(lbl);

      var valDiv = document.createElement('div'); valDiv.className = 'wmr-view-value';
      var fieldUploads = uploads.filter(function (u) { return u.field_key === field.key; });

      if (fieldUploads.length) {
        fieldUploads.forEach(function (up) {
          var img = document.createElement('img');
          img.src = up.url || '/api/module-uploads/' + up.id;
          img.className = 'wmr-view-img';
          valDiv.appendChild(img);
        });
      } else {
        var raw = data[field.key];
        if (field.type === 'long_text') {
          valDiv.style.whiteSpace = 'pre-wrap';
        }
        valDiv.textContent = ft.format(field, raw);
      }

      row.appendChild(valDiv);
      viewEl.appendChild(row);
    });

    // Metadata
    var meta = document.createElement('div'); meta.className = 'wmr-meta';
    var byName = record.submitted_by_name ? ' by ' + record.submitted_by_name : '';
    var p = record.submitted_portal ? ' · ' + record.submitted_portal : '';
    var t = record.submitted_at ? ' · ' + relativeTime(record.submitted_at) : '';
    meta.textContent = 'Submitted' + byName + p + t;
    viewEl.appendChild(meta);

    // Edit/delete actions
    var canEdit = options.canEdit === true;
    var canDelete = options.canDelete === true;
    if (canEdit || canDelete) {
      var actions = document.createElement('div'); actions.className = 'wmr-actions';
      actions.style.marginTop = '12px';
      if (canEdit) {
        var editBtn = document.createElement('button'); editBtn.type = 'button';
        editBtn.className = 'wmr-btn wmr-btn-primary'; editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', function () {
          renderRecord(mod, record, container, Object.assign({}, options, { mode: 'edit' }));
        });
        actions.appendChild(editBtn);
      }
      if (canDelete && options.onDelete) {
        var delBtn = document.createElement('button'); delBtn.type = 'button';
        delBtn.className = 'wmr-btn wmr-btn-ghost'; delBtn.textContent = 'Delete';
        delBtn.style.color = 'var(--c-red,#ef4444)';
        delBtn.addEventListener('click', options.onDelete);
        actions.appendChild(delBtn);
      }
      viewEl.appendChild(actions);
    }

    container.appendChild(viewEl);
  }

  // ── renderFieldPreview ───────────────────────────────────────────────────────
  // Renders a single field standalone — used by the module-builder Preview tab.

  function renderFieldPreview(field, container) {
    injectStyles();
    container.innerHTML = '';

    if (field.type === 'timestamp_auto') {
      var note = document.createElement('div'); note.className = 'wmr-ts-note';
      note.innerHTML = '&#x23F1; <em>Auto-filled on submit — not shown to user</em>';
      container.appendChild(note);
      return;
    }

    var ft = fieldTypes[field.type];
    if (!ft) {
      container.textContent = 'Unknown field type: ' + field.type;
      return;
    }

    var id = 'preview-f-' + field.key;
    var wrap = buildWrapper(field, id);
    var fieldEl = ft.render(field, id);
    wrap.appendChild(fieldEl);
    addHelpText(wrap, field);
    container.appendChild(wrap);
  }

  // ── renderList ───────────────────────────────────────────────────────────────
  // Renders a filterable/sortable table of module records.
  // options: { portal, role, onRowClick, onEdit, onDelete, showFilters, columns }

  function renderList(mod, records, container, options) {
    injectStyles();
    if (!document.getElementById('wmr-list-styles')) {
      var ls = document.createElement('style');
      ls.id = 'wmr-list-styles';
      ls.textContent = `
        .wmr-list-filters { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px; }
        .wmr-list-filter-field { display:flex; flex-direction:column; gap:3px; min-width:110px; }
        .wmr-list-filter-label { font-size:.68rem; font-weight:700; color:var(--c-muted,#94a3b8); text-transform:uppercase; letter-spacing:.05em; }
        .wmr-list-filter-input {
          padding:5px 8px; background:rgba(255,255,255,.04);
          border:1px solid var(--c-border,#2d3748); border-radius:7px;
          color:var(--c-text,#f1f5f9); font-size:.8rem; font-family:system-ui,Arial,sans-serif;
          min-height:34px;
        }
        .wmr-list-filter-input:focus { outline:none; border-color:var(--c-blue,#4a9abf); }
        .wmr-list-table-wrap { overflow-x:auto; border-radius:8px; border:1px solid var(--c-border,#2d3748); }
        .wmr-list-table { width:100%; border-collapse:collapse; font-size:.82rem; }
        .wmr-list-table thead tr { background:var(--c-surface,#1e293b); border-bottom:1px solid var(--c-border,#2d3748); }
        .wmr-list-table th {
          padding:8px 11px; text-align:left; font-size:.67rem; font-weight:800;
          color:var(--c-muted,#94a3b8); text-transform:uppercase; letter-spacing:.06em;
          white-space:nowrap; cursor:pointer; user-select:none;
        }
        .wmr-list-table th:hover { color:var(--c-blue,#4a9abf); }
        .wmr-list-table td {
          padding:8px 11px; border-bottom:1px solid var(--c-border,#2d3748);
          color:var(--c-text,#f1f5f9); max-width:240px;
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        }
        .wmr-list-table tr:last-child td { border-bottom:none; }
        .wmr-list-table tr:hover td { background:rgba(255,255,255,.025); cursor:pointer; }
        .wmr-list-empty { padding:28px 16px; text-align:center; color:var(--c-muted,#94a3b8); font-size:.83rem; }
      `;
      document.head.appendChild(ls);
    }

    options = options || {};
    container.innerHTML = '';

    var fields = parseFields(mod);
    var colFields = options.columns
      ? fields.filter(function(f) { return options.columns.indexOf(f.key) >= 0; })
      : fields.filter(function(f) { return ['photo','photo_multi','signature','long_text','timestamp_auto'].indexOf(f.type) < 0; }).slice(0, 7);

    // Filter bar
    if (options.showFilters !== false) {
      var filterableFields = fields.filter(function(f) {
        return ['text','dropdown','radio','yes_no','date'].indexOf(f.type) >= 0;
      }).slice(0, 5);

      if (filterableFields.length) {
        var filterBar = document.createElement('div');
        filterBar.className = 'wmr-list-filters';

        var activeFilters = {};

        filterableFields.forEach(function(f) {
          var wrap = document.createElement('div'); wrap.className = 'wmr-list-filter-field';
          var lbl = document.createElement('div'); lbl.className = 'wmr-list-filter-label'; lbl.textContent = f.label || f.key;
          var inp;
          if (f.type === 'dropdown' || f.type === 'radio') {
            inp = document.createElement('select'); inp.className = 'wmr-list-filter-input';
            var blank = document.createElement('option'); blank.value = ''; blank.textContent = 'Any'; inp.appendChild(blank);
            (f.options || []).forEach(function(o) {
              var opt = document.createElement('option'); opt.value = o; opt.textContent = o; inp.appendChild(opt);
            });
          } else if (f.type === 'yes_no') {
            inp = document.createElement('select'); inp.className = 'wmr-list-filter-input';
            ['','true','false'].forEach(function(v, i) {
              var opt = document.createElement('option'); opt.value = v; opt.textContent = ['Any','Yes','No'][i]; inp.appendChild(opt);
            });
          } else if (f.type === 'date') {
            inp = document.createElement('input'); inp.type = 'date'; inp.className = 'wmr-list-filter-input';
          } else {
            inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = 'Filter…'; inp.className = 'wmr-list-filter-input';
          }
          inp.dataset.fkey = f.key;
          inp.addEventListener('change', function() { applyListFilters(); });
          wrap.appendChild(lbl); wrap.appendChild(inp); filterBar.appendChild(wrap);
        });

        container.appendChild(filterBar);

        var filteredRecords = records;
        var tableWrap = document.createElement('div'); tableWrap.className = 'wmr-list-table-wrap';
        container.appendChild(tableWrap);

        function applyListFilters() {
          var filters = {};
          filterBar.querySelectorAll('[data-fkey]').forEach(function(el) {
            if (el.value) filters[el.dataset.fkey] = el.value;
          });
          filteredRecords = records.filter(function(rec) {
            var data = typeof rec.data === 'string' ? JSON.parse(rec.data) : (rec.data || {});
            return Object.keys(filters).every(function(k) {
              return String(data[k]) === filters[k] || (data[k] !== undefined && String(data[k]).toLowerCase().includes(filters[k].toLowerCase()));
            });
          });
          buildTable(filteredRecords, tableWrap);
        }

        buildTable(filteredRecords, tableWrap);
        return;
      }
    }

    // No filter bar
    var tableWrap2 = document.createElement('div'); tableWrap2.className = 'wmr-list-table-wrap';
    container.appendChild(tableWrap2);
    buildTable(records, tableWrap2);

    function buildTable(recs, wrap) {
      wrap.innerHTML = '';
      if (!recs.length) {
        wrap.innerHTML = '<div class="wmr-list-empty">No records found.</div>';
        return;
      }

      var table = document.createElement('table'); table.className = 'wmr-list-table';

      var thead = document.createElement('thead');
      var hrow = document.createElement('tr');
      colFields.forEach(function(col) {
        var th = document.createElement('th'); th.textContent = col.label || col.key; hrow.appendChild(th);
      });
      var thDate = document.createElement('th'); thDate.textContent = 'Submitted'; hrow.appendChild(thDate);
      if (options.onEdit || options.onDelete) {
        var thAct = document.createElement('th'); hrow.appendChild(thAct);
      }
      thead.appendChild(hrow);
      table.appendChild(thead);

      var tbody = document.createElement('tbody');
      recs.forEach(function(rec) {
        var tr = document.createElement('tr');
        var data = typeof rec.data === 'string' ? JSON.parse(rec.data) : (rec.data || {});
        colFields.forEach(function(col) {
          var td = document.createElement('td');
          var raw = data[col.key];
          var ft = fieldTypes[col.type];
          td.textContent = ft ? ft.format(col, raw) : (raw !== undefined && raw !== null ? String(raw) : '—');
          td.title = td.textContent;
          tr.appendChild(td);
        });
        var tdDate = document.createElement('td');
        tdDate.textContent = rec.submitted_at ? new Date(rec.submitted_at).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : '—';
        tr.appendChild(tdDate);

        if (options.onEdit || options.onDelete) {
          var tdAct = document.createElement('td');
          tdAct.style.cssText = 'white-space:nowrap;text-align:right';
          if (options.onEdit) {
            var eb = document.createElement('button'); eb.className = 'wmr-btn wmr-btn-ghost'; eb.textContent = 'Edit';
            eb.style.cssText = 'font-size:.75rem;padding:4px 10px;min-height:30px;margin-right:4px';
            eb.onclick = function(e) { e.stopPropagation(); options.onEdit(rec); };
            tdAct.appendChild(eb);
          }
          if (options.onDelete) {
            var db2 = document.createElement('button'); db2.className = 'wmr-btn wmr-btn-ghost'; db2.textContent = 'Delete';
            db2.style.cssText = 'font-size:.75rem;padding:4px 10px;min-height:30px;color:var(--c-red,#ef4444)';
            db2.onclick = function(e) { e.stopPropagation(); options.onDelete(rec); };
            tdAct.appendChild(db2);
          }
          tr.appendChild(tdAct);
        }

        if (options.onRowClick) {
          tr.onclick = function() { options.onRowClick(rec); };
        }
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  window.WrenModuleRenderer = {
    renderForm:         renderForm,
    renderRecord:       renderRecord,
    renderFieldPreview: renderFieldPreview,
    renderList:         renderList,
    fieldTypes:         fieldTypes,
  };

})();
