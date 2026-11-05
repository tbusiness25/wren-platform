/* b104 — shared Documents panel widget (Roost / Nest / Egg).
 * Portal-agnostic + theme-aware. Renders a document list + upload + (manager)
 * visibility/delete for a staff or child subject, talking to /api/person-documents.
 *
 * Usage:
 *   WrenPersonDocs.mount({
 *     el:            HTMLElement | '#id',
 *     subjectType:   'staff' | 'child',
 *     subjectId:     123,
 *     getToken:      () => sessionStorage.getItem('wrenToken'),   // or a string
 *     canUpload:     true,
 *     canManage:     true,    // managers: set visibility + delete any
 *     canDeleteOwn:  true,    // uploader may delete their own
 *     mode:          'admin' | 'staff' | 'parent',
 *     theme:         'dark' | 'light',   // default 'dark' (Roost/Nest); 'light' = Egg welcome portal
 *   });
 */
(function () {
  'use strict';
  var CAT_LABELS = {
    certificate: 'Certificate', contract: 'Contract', report: 'Report',
    medical: 'Medical', photo_consent: 'Photo consent', other: 'Other',
    /* b155 */ ehcp: 'EHCP',
    /* b321 — what a family sends when their child starts */
    family_photo: '🖼️ Family photo', peg_portrait: '🧥 Peg portrait',
    allergy_doc: '🥜 Allergy document', medicine_doc: '💊 Medicine / health',
    health_care_plan: '🩺 Health care plan',
    /* b422 (2026-10-08) — registration welcome pack checklist item */
    red_book: '📕 Red book / immunisation record'
  };
  /* b321 — the retention clock, shown on the row. The point of b308 was that a
     peg photo and a health care plan cannot share one expiry; showing the class
     is what makes that visible to the person deciding whether to delete. */
  var RET_BADGE = {
    handover:  { t: 'Handover',  bg: '#134e4a', fg: '#99f6e4', title: 'Offered back and deleted when the child leaves' },
    ordinary:  { t: '3 years',   bg: '#1e3a8a', fg: '#bfdbfe', title: '3 years after leaving, or the next Ofsted inspection' },
    consent:   { t: '21y 6m',    bg: '#713f12', fg: '#fde68a', title: '21 years and 6 months from the permission' },
    protected: { t: '25 years',  bg: '#7f1d1d', fg: '#fecaca', title: '25 years from date of birth' }
  };
  /* The family-facing set, for the parents portal and any caller that passes
     categories:'family'. Roost and Nest keep the full list. */
  var FAMILY_CATS = ['family_photo','peg_portrait','allergy_doc','medicine_doc','health_care_plan','red_book','other'];
  /* What the SERVER will accept for each b321 category (src/lib/child-documents.js).
     Advertising "PDF, DOCX, XLSX, MP4" under a peg-photo picker is a promise the
     route then refuses to keep, and the parent finds out after the upload. */
  var CAT_ACCEPT = {
    family_photo:     { exts: '.png,.jpg,.jpeg', say: 'JPG or PNG photo · max 15MB' },
    peg_portrait:     { exts: '.png,.jpg,.jpeg', say: 'JPG or PNG photo · max 15MB' },
    allergy_doc:      { exts: '.pdf,.png,.jpg,.jpeg,.webp', say: 'PDF or photo · max 20MB' },
    medicine_doc:     { exts: '.pdf,.png,.jpg,.jpeg,.webp', say: 'PDF or photo · max 20MB' },
    health_care_plan: { exts: '.pdf,.png,.jpg,.jpeg,.webp', say: 'PDF or photo · max 20MB' },
    red_book:         { exts: '.pdf,.png,.jpg,.jpeg,.webp', say: 'PDF or photo · max 20MB' }
  };
  var ANY_ACCEPT = { exts: '.pdf,.docx,.xlsx,.png,.jpg,.jpeg,.webp,.mp4',
                     say: 'PDF, DOCX, XLSX, PNG, JPG, WebP, MP4 · max 30MB' };
  var VIS_LABELS = {
    confidential: '🔒 Confidential (managers)', staff: '👤 Staff',
    parents: '👪 Parents', staff_and_parents: '👥 Staff & parents'
  };
  var VIS_BADGE = {
    confidential: { t: 'Confidential', bg: '#7f1d1d', fg: '#fecaca' },
    staff:        { t: 'Staff',        bg: '#1e3a8a', fg: '#bfdbfe' },
    parents:      { t: 'Parents',      bg: '#713f12', fg: '#fde68a' },
    staff_and_parents: { t: 'Staff & parents', bg: '#134e4a', fg: '#99f6e4' }
  };

  var THEMES = {
    dark:  { card: '#1e293b', border: '#2d3748', input: '#0f172a', text: '#f1f5f9', muted: '#94a3b8', accent: '#e07820', link: '#4a9abf', ok: '#22c55e', err: '#ef4444' },
    light: { card: '#ffffff', border: '#e8e0d0', input: '#ffffff', text: '#2a2a2a', muted: '#5a5a5a', accent: '#f0a050', link: '#2d5a4a', ok: '#2d5a4a', err: '#c0392b' }
  };

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function fmtBytes(b) { if (b == null) return ''; if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(0) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }
  function fmtDate(d) { if (!d) return ''; try { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; } }

  function acceptFor(cat) { return CAT_ACCEPT[cat] || ANY_ACCEPT; }

  function visOptions(subjectType) {
    if (subjectType === 'staff') return ['confidential', 'staff', 'staff_and_parents'];
    return ['confidential', 'staff', 'parents', 'staff_and_parents'];
  }

  function mount(opts) {
    var el = typeof opts.el === 'string' ? document.querySelector(opts.el) : opts.el;
    if (!el) { console.warn('[person-docs] mount element not found', opts.el); return; }
    var subjectType = opts.subjectType, subjectId = opts.subjectId;
    var mode = opts.mode || 'staff';
    var canManage = !!opts.canManage;
    var canUpload = opts.canUpload !== false;
    var canDeleteOwn = !!opts.canDeleteOwn;
    /* b321 — which categories this caller may file under. 'family' = the five a
       family is asked for; an array = exactly those; anything else = all. */
    var catList = opts.categories === 'family' ? FAMILY_CATS
                : (Array.isArray(opts.categories) && opts.categories.length ? opts.categories
                : Object.keys(CAT_LABELS));
    var canPrint = !!opts.canPrint;
    var P = THEMES[opts.theme === 'light' ? 'light' : 'dark'];
    var tokenFn = typeof opts.getToken === 'function' ? opts.getToken : function () { return opts.getToken; };
    var API = '/api/person-documents';
    var inputStyle = 'width:100%;margin-top:2px;padding:8px;border-radius:8px;background:' + P.input + ';color:' + P.text + ';border:1px solid ' + P.border + ';font-family:inherit';

    function authHeaders(extra) {
      var h = { 'Authorization': 'Bearer ' + (tokenFn() || '') };
      var dev = null;
      try { dev = localStorage.getItem('wrenDevice'); } catch (e) {}
      if (dev) h['X-Wren-Device'] = dev;
      if (extra) for (var k in extra) h[k] = extra[k];
      return h;
    }

    el.innerHTML =
      '<div class="wpd-root" style="font-family:inherit">' +
        (canUpload ? uploadFormHtml() : '') +
        '<div class="wpd-list" style="margin-top:12px"><div style="color:' + P.muted + ';font-size:.85rem;padding:8px 0">Loading documents…</div></div>' +
      '</div>';

    function uploadFormHtml() {
      var visSel = '';
      if (mode !== 'parent') {
        var selDefault = (mode === 'admin' ? 'confidential' : 'staff');
        var opts2 = visOptions(subjectType).map(function (v) {
          return '<option value="' + v + '"' + (v === selDefault ? ' selected' : '') + '>' + VIS_LABELS[v] + '</option>';
        }).join('');
        visSel = '<label style="font-size:.75rem;color:' + P.muted + ';display:block;margin-top:6px">Who can see this' +
          '<select class="wpd-vis" style="' + inputStyle + '">' + opts2 + '</select></label>';
      }
      var catOpts = catList.map(function (c) { return '<option value="' + c + '">' + (CAT_LABELS[c] || c) + '</option>'; }).join('');
      return '' +
        '<div class="wpd-upload" style="border:1px dashed ' + P.border + ';border-radius:12px;padding:14px;background:' + P.card + '">' +
          '<div class="wpd-drop" style="text-align:center;color:' + P.muted + ';font-size:.85rem;padding:10px;border-radius:8px;cursor:pointer">' +
            '📎 <strong style="color:' + P.text + '">Choose a file</strong> or drag &amp; drop here' +
            '<div class="wpd-accept" style="font-size:.72rem;margin-top:4px">' + acceptFor(catList[0]).say + '</div>' +
            /* b321 — HEIC dropped from the hint on purpose: it is refused for the
               photo types because its EXIF cannot be stripped losslessly, and
               advertising a format we reject wastes a parent's upload. */
            '</div>' +
          '<input type="file" class="wpd-file" style="display:none" accept="' + acceptFor(catList[0]).exts + '">' +
          '<div class="wpd-fname" style="font-size:.8rem;color:' + P.accent + ';margin:6px 0 0;display:none"></div>' +
          '<input type="text" class="wpd-title" placeholder="Title (optional)" style="' + inputStyle + ';margin-top:8px">' +
          '<label style="font-size:.75rem;color:' + P.muted + ';display:block;margin-top:6px">Category' +
            '<select class="wpd-cat" style="' + inputStyle + '">' + catOpts + '</select></label>' +
          visSel +
          '<button class="wpd-submit" style="margin-top:10px;width:100%;padding:10px;border:none;border-radius:10px;background:' + P.accent + ';color:#fff;font-weight:700;cursor:pointer;font-family:inherit">Upload</button>' +
          '<div class="wpd-msg" style="font-size:.8rem;margin-top:6px"></div>' +
        '</div>';
    }

    var listEl = el.querySelector('.wpd-list');

    /* b321 — keep the picker honest as the category changes. */
    if (canUpload) {
      var catSel = el.querySelector('.wpd-cat');
      if (catSel) catSel.addEventListener('change', function () {
        var a = acceptFor(catSel.value);
        var f = el.querySelector('.wpd-file'), h = el.querySelector('.wpd-accept');
        if (f) f.setAttribute('accept', a.exts);
        if (h) h.textContent = a.say;
      });
    }

    function badge(text, bg, fg) {
      return '<span style="display:inline-block;padding:1px 8px;border-radius:999px;font-size:.68rem;background:' + bg + ';color:' + fg + '">' + esc(text) + '</span>';
    }

    async function load() {
      try {
        var res = await fetch(API + '?subject_type=' + subjectType + '&subject_id=' + subjectId, { headers: authHeaders() });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var docs = await res.json();
        render(docs);
      } catch (e) {
        listEl.innerHTML = '<div style="color:' + P.err + ';font-size:.85rem;padding:8px 0">Could not load documents (' + esc(e.message) + ')</div>';
      }
    }

    function render(docs) {
      if (!docs.length) { listEl.innerHTML = '<div style="color:' + P.muted + ';font-size:.85rem;padding:8px 0">No documents yet.</div>'; return; }
      listEl.innerHTML = docs.map(function (d) {
        var vb = VIS_BADGE[d.visibility] || { t: d.visibility, bg: '#334155', fg: '#cbd5e1' };
        /* "Staff" is staff vocabulary. To a family the useful fact is who can
           see the file they just sent, so say that instead. */
        if (mode === 'parent' && d.visibility === 'staff') vb = { t: 'Nursery only', bg: '#134e4a', fg: '#99f6e4' };
        /* b321 — 'registration' is a third uploader kind: a family sending files
           through the token-gated registration form, with no login at all. */
        var uploader = d.uploaded_by_kind === 'registration' ? 'Sent at registration'
                     : d.uploaded_by_kind === 'parent' ? (mode === 'parent' ? 'You' : 'Parent')
                     : 'Staff';
        var visCtl = '';
        if (canManage) {
          var opts2 = visOptions(d.subject_type).map(function (v) {
            return '<option value="' + v + '"' + (v === d.visibility ? ' selected' : '') + '>' + VIS_LABELS[v] + '</option>';
          }).join('');
          visCtl = '<select data-vis-for="' + d.id + '" style="padding:5px;border-radius:6px;background:' + P.input + ';color:' + P.text + ';border:1px solid ' + P.border + ';font-size:.72rem;font-family:inherit">' + opts2 + '</select>';
        }
        var delBtn = (canManage || canDeleteOwn) ? '<button data-del="' + d.id + '" title="Delete" style="background:none;border:none;color:' + P.err + ';cursor:pointer;font-size:1rem">🗑️</button>' : '';
        var openBtn = d.file_url ? '<button data-open="' + d.id + '" style="background:none;border:none;color:' + P.link + ';cursor:pointer;font-size:.8rem;text-decoration:underline;font-family:inherit">Open</button>' : '';
        /* b321 — the A4 print. Only offered where the server will actually serve
           it (d.print_url is set by the route, not guessed here), so the button
           cannot promise something a parent's token will be refused. */
        var printBtn = (canPrint && d.print_url) ? '<button data-print="' + d.id + '" title="Print at A4" style="background:none;border:none;color:' + P.link + ';cursor:pointer;font-size:.8rem;text-decoration:underline;font-family:inherit">Print A4</button>' : '';
        var rb = RET_BADGE[d.retention_class];
        var retB = rb ? '<span title="' + esc(rb.title) + '" style="display:inline-block;padding:1px 8px;border-radius:999px;font-size:.68rem;background:' + rb.bg + ';color:' + rb.fg + '">' + rb.t + '</span>' : '';
        /* An empty 44px box that fillThumbs() paints into afterwards. The file
           route needs an Authorization header, so a plain <img src> 401s — the
           same trap the child-profile observation photos hit. */
        var thumb = d.is_photo
          ? '<div data-thumb="' + d.id + '" style="width:44px;height:44px;flex:0 0 44px;border-radius:8px;border:1px solid ' + P.border + ';background:' + P.input + ';overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:1rem">🖼️</div>'
          : '';
        return '<div class="wpd-row" style="display:flex;gap:10px;align-items:center;padding:10px 4px;border-bottom:1px solid ' + P.border + '">' +
            thumb +
            '<div style="flex:1;min-width:0">' +
              '<div style="font-weight:700;color:' + P.text + ';font-size:.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(d.title) + '</div>' +
              '<div style="font-size:.72rem;color:' + P.muted + ';margin-top:2px">' + esc(CAT_LABELS[d.category] || d.category) + ' · ' + fmtBytes(d.size_bytes) + ' · ' + fmtDate(d.uploaded_at) + ' · ' + uploader + '</div>' +
              (d.retention_note ? '<div style="font-size:.68rem;color:' + P.muted + ';margin-top:2px;opacity:.85">' + esc(d.retention_note) + '</div>' : '') +
            '</div>' +
            '<div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">' +
              (visCtl || badge(vb.t, vb.bg, vb.fg)) +
              retB +
              '<div style="display:flex;gap:8px;align-items:center">' + openBtn + printBtn + delBtn + '</div>' +
            '</div>' +
          '</div>';
      }).join('');

      listEl.querySelectorAll('[data-print]').forEach(function (b) { b.onclick = function () { openUrl('/api/person-documents/' + b.getAttribute('data-print') + '/print/a4'); }; });
      fillThumbs(docs);
      listEl.querySelectorAll('[data-open]').forEach(function (b) { b.onclick = function () { openDoc(b.getAttribute('data-open')); }; });
      listEl.querySelectorAll('[data-del]').forEach(function (b) { b.onclick = function () { delDoc(b.getAttribute('data-del')); }; });
      listEl.querySelectorAll('[data-vis-for]').forEach(function (s) { s.onchange = function () { setVis(s.getAttribute('data-vis-for'), s.value); }; });
    }

    /* b321 — every authed binary this panel opens goes through a blob: the file
       and print routes both need a Bearer header, and window.open() on a bare
       URL sends none. */
    async function openUrl(url) {
      try {
        var res = await fetch(url, { headers: authHeaders() });
        if (!res.ok) { var j = await res.json().catch(function () { return {}; }); throw new Error(j.error || ('HTTP ' + res.status)); }
        var blob = await res.blob();
        var u = URL.createObjectURL(blob);
        window.open(u, '_blank');
        setTimeout(function () { URL.revokeObjectURL(u); }, 60000);
      } catch (e) { alert('Could not open: ' + e.message); }
    }

    function fillThumbs(docs) {
      docs.filter(function (d) { return d.is_photo && d.file_url; }).forEach(function (d) {
        var box = listEl.querySelector('[data-thumb="' + d.id + '"]');
        if (!box) return;
        fetch(d.file_url, { headers: authHeaders() })
          .then(function (r) { return r.ok ? r.blob() : null; })
          .then(function (b) {
            if (!b) return;
            var u = URL.createObjectURL(b);
            box.innerHTML = '<img src="' + u + '" alt="" style="width:100%;height:100%;object-fit:cover">';
          }).catch(function () { /* the emoji placeholder stays */ });
      });
    }

    async function openDoc(id) {
      try {
        var res = await fetch(API + '/' + id + '/file', { headers: authHeaders() });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var blob = await res.blob();
        var url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      } catch (e) { alert('Could not open document: ' + e.message); }
    }

    async function delDoc(id) {
      if (!confirm('Delete this document? The file is kept but hidden from the list.')) return;
      try {
        var res = await fetch(API + '/' + id, { method: 'DELETE', headers: authHeaders() });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        load();
      } catch (e) { alert('Delete failed: ' + e.message); }
    }

    async function setVis(id, v) {
      try {
        var res = await fetch(API + '/' + id, { method: 'PATCH', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ visibility: v }) });
        if (!res.ok) { var j = await res.json().catch(function () { return {}; }); throw new Error(j.error || ('HTTP ' + res.status)); }
        load();
      } catch (e) { alert('Could not change visibility: ' + e.message); load(); }
    }

    // ── Upload wiring ──
    if (canUpload) {
      var fileInput = el.querySelector('.wpd-file');
      var drop = el.querySelector('.wpd-drop');
      var fnameEl = el.querySelector('.wpd-fname');
      var msg = el.querySelector('.wpd-msg');
      var chosen = null;
      function setFile(f) { chosen = f; if (f) { fnameEl.style.display = 'block'; fnameEl.textContent = f.name; } }
      drop.onclick = function () { fileInput.click(); };
      fileInput.onchange = function () { if (fileInput.files[0]) setFile(fileInput.files[0]); };
      ['dragover', 'dragenter'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.style.background = P.input; }); });
      ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.style.background = ''; }); });
      drop.addEventListener('drop', function (e) { if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });
      el.querySelector('.wpd-submit').onclick = async function () {
        if (!chosen) { msg.style.color = P.err; msg.textContent = 'Choose a file first.'; return; }
        var fd = new FormData();
        fd.append('subject_type', subjectType);
        fd.append('subject_id', subjectId);
        fd.append('file', chosen);
        fd.append('title', (el.querySelector('.wpd-title').value || '').trim());
        fd.append('category', el.querySelector('.wpd-cat').value);
        var visSel = el.querySelector('.wpd-vis');
        if (visSel) fd.append('visibility', visSel.value);
        msg.style.color = P.muted; msg.textContent = 'Uploading…';
        try {
          var res = await fetch(API, { method: 'POST', headers: authHeaders(), body: fd });
          /* b321 — a 413 is nginx's, not Wren's, and its body is an HTML error
             page. Parsing that as JSON throws "Unexpected token <", which reads
             as a broken app rather than as a file that is too big. */
          var txt = await res.text();
          var j = {}; try { j = JSON.parse(txt); } catch (e) {}
          if (res.status === 413) throw new Error('That file is too large to upload here. Please choose a smaller one.');
          if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
          msg.style.color = P.ok; msg.textContent = 'Uploaded ✓';
          chosen = null; fileInput.value = ''; fnameEl.style.display = 'none'; el.querySelector('.wpd-title').value = '';
          load();
          setTimeout(function () { msg.textContent = ''; }, 2500);
        } catch (e) { msg.style.color = P.err; msg.textContent = 'Upload failed: ' + e.message; }
      };
    }

    load();
    return { reload: load };
  }

  window.WrenPersonDocs = { mount: mount };
})();
