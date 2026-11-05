/* wren-message-drafts.js — 2026-10-28 (Toby: "we don't have a draft feature but we should …
 * if staff want me to see a message before sending it they could press Send to Toby and then when
 * I click OK it sends on their behalf … and allow us to attach documents and images").
 *
 * One add-on for every staff message composer (Roost /messages.html, EY /ey/messages):
 *   WrenDrafts.mount({ threadId, textarea, host, attach, onSent })
 *     → under the reply box: [📎 Attach] (optional) [💾 Save draft] [👀 Send to Toby] (non-managers)
 *       and this conversation's drafts: edit, send, delete — managers see "OK & send" on drafts
 *       waiting for their approval; the message goes out as the person who wrote it.
 *   WrenDrafts.mountApprovals(host, { openThread }) → managers: every message waiting for an OK.
 * API: POST/PUT/DELETE /api/messages/draft, POST /api/messages/draft/:id/confirm-send,
 *      GET /api/messages/drafts?thread_id=, POST /api/messages/thread/:id/reply-photo (attachments).
 * Drafts and held messages are never shown to parents (VISIBLE_SQL in src/routes/messages.js). */
(function () {
  if (window.WrenDrafts) return;
  var MGR = ['manager', 'deputy_manager', 'admin', 'owner', 'headteacher'];
  var ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,application/pdf,.doc,.docx,.xls,.xlsx,' +
    'application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,' +
    'application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  function me() { try { return (window.Wren && Wren.getUser && Wren.getUser()) || (window.Wren && Wren.user) || JSON.parse(sessionStorage.getItem('wrenUser') || 'null') || {}; } catch (e) { return {}; } }
  function isManager() { return MGR.indexOf(String(me().role || '').toLowerCase()) !== -1; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function api(path, method, body) { return Wren.api('/api/messages' + path, method ? { method: method, body: body || {} } : undefined); }
  function toast(t, kind) { try { if (Wren.toast) return Wren.toast(t, kind); } catch (e) {} }
  function when(ts) { try { return new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
  function css() {
    if (document.getElementById('wren-drafts-css')) return;
    var st = document.createElement('style'); st.id = 'wren-drafts-css';
    st.textContent = '.wd-bar{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}' +
      '.wd-btn{min-height:38px;padding:6px 12px;border-radius:9px;border:1px solid var(--c-border,#334155);background:var(--c-surface,#fff);color:var(--c-text,#111);font:600 .85rem system-ui,sans-serif;cursor:pointer}' +
      '.wd-btn.primary{background:var(--c-blue,#2563eb);border-color:var(--c-blue,#2563eb);color:#fff}' +
      '.wd-list{display:flex;flex-direction:column;gap:8px;margin:6px 0}' +
      '.wd-item{border:1px dashed var(--c-border,#94a3b8);border-radius:10px;padding:10px 12px;background:color-mix(in srgb,var(--c-blue,#2563eb) 6%,var(--c-surface,#fff))}' +
      '.wd-meta{font-size:.75rem;color:var(--c-muted,#64748b);margin-bottom:4px}' +
      '.wd-body{white-space:pre-wrap;font-size:.9rem;margin-bottom:8px}' +
      '.wd-badge{display:inline-block;padding:1px 8px;border-radius:9px;font-size:.72rem;font-weight:700;background:#fef3c7;color:#92400e;margin-right:6px}' +
      '.wd-badge.mine{background:#e0e7ff;color:#3730a3}' +
      '.wd-msg{font-size:.8rem;margin:4px 0;color:var(--c-muted,#64748b)}';
    document.head.appendChild(st);
  }

  function itemHtml(d, opts) {
    var mine = Number(d.sender_id) === Number(me().id);
    var approval = (d.draft_kind || 'approval') === 'approval';
    var mgr = isManager();
    var badge = approval
      ? '<span class="wd-badge">' + (mine && !mgr ? 'Waiting for Toby’s OK' : 'Waiting for your OK') + '</span>'
      : '<span class="wd-badge mine">Your draft</span>';
    var who = d.sender_name && !mine ? esc(d.sender_name) + ' · ' : '';
    var child = opts && opts.showChild && d.child_name ? ' · to ' + esc(d.child_name.split(' ')[0]) + '’s family' : '';
    var canSend = approval ? mgr : (mine || mgr);
    return '<div class="wd-item" data-id="' + d.id + '" data-thread="' + d.thread_id + '">'
      + '<div class="wd-meta">' + badge + who + esc(when(d.created_at)) + child + '</div>'
      + '<div class="wd-body">' + esc(d.body) + '</div>'
      + '<div class="wd-bar" style="margin:0">'
      + (canSend ? '<button type="button" class="wd-btn primary" data-wd="send">' + (approval ? 'OK & send' : 'Send') + '</button>' : '')
      + ((mine || mgr) ? '<button type="button" class="wd-btn" data-wd="edit">Edit</button><button type="button" class="wd-btn" data-wd="delete">Delete</button>' : '')
      + (opts && opts.openThread ? '<button type="button" class="wd-btn" data-wd="open">Open conversation</button>' : '')
      + '</div></div>';
  }

  function mount(o) {
    css();
    var host = o.host, ta = o.textarea, threadId = o.threadId;
    if (!host || !ta || !threadId) return null;
    var editingId = null;
    var mgr = isManager();
    host.innerHTML = '<div class="wd-bar">'
      + (o.attach ? '<button type="button" class="wd-btn" data-wd="attach" title="Photo, PDF, Word or Excel, up to 10MB">📎 Attach</button>' : '')
      + '<button type="button" class="wd-btn" data-wd="save">💾 Save draft</button>'
      + (mgr ? '' : '<button type="button" class="wd-btn" data-wd="toby" title="Toby checks it, then it goes out from you">👀 Send to Toby to check</button>')
      + '</div><div class="wd-msg" role="status" aria-live="polite"></div><div class="wd-list"></div>'
      + (o.attach ? '<input type="file" hidden accept="' + ACCEPT + '">' : '');
    var msg = host.querySelector('.wd-msg'), list = host.querySelector('.wd-list');
    function say(t) { msg.textContent = t || ''; }
    function load() {
      api('/drafts?thread_id=' + encodeURIComponent(threadId)).then(function (rows) {
        list.innerHTML = (rows || []).map(function (d) { return itemHtml(d); }).join('');
      }).catch(function () { list.innerHTML = ''; });
    }
    function done(t) { ta.value = ''; editingId = null; say(t); load(); }
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-wd]'); if (!b) return;
      var act = b.getAttribute('data-wd'), item = b.closest('.wd-item'), id = item && item.getAttribute('data-id');
      var text = (ta.value || '').trim();
      if (act === 'save' || act === 'toby') {
        if (!text) { say('Write the message first.'); ta.focus(); return; }
        var p = editingId && act === 'save'
          ? api('/draft/' + editingId, 'PUT', { body: text })
          : (editingId ? api('/draft/' + editingId, 'DELETE') : Promise.resolve()).then(function () {
              return api('/draft', 'POST', { thread_id: threadId, body: text, kind: act === 'toby' ? 'approval' : 'draft' });
            });
        b.disabled = true;
        p.then(function () { done(act === 'toby' ? 'Sent to Toby. It goes to the family once he OKs it.' : 'Draft saved. Only you can see it.'); })
         .catch(function (er) { say((er && (er.message || er.error)) || 'Could not save that.'); })
         .then(function () { b.disabled = false; });
      } else if (act === 'attach') {
        host.querySelector('input[type=file]').click();
      } else if (act === 'edit') {
        ta.value = item.querySelector('.wd-body').textContent; editingId = id; ta.focus();
        say('Editing a draft: change it, then Save draft (or Send to Toby).');
      } else if (act === 'delete') {
        if (!confirm('Delete this draft?')) return;
        api('/draft/' + id, 'DELETE').then(function () { if (editingId === id) { editingId = null; ta.value = ''; } say('Draft deleted.'); load(); });
      } else if (act === 'send') {
        b.disabled = true;
        api('/draft/' + id + '/confirm-send', 'POST', {}).then(function () {
          say('Sent.'); load(); if (o.onSent) o.onSent();
        }).catch(function (er) { b.disabled = false; say((er && (er.message || er.error)) || 'Could not send that.'); });
      }
    });
    var fi = host.querySelector('input[type=file]');
    if (fi) fi.addEventListener('change', function () {
      var f = fi.files && fi.files[0]; if (!f) return;
      if (f.size > 10 * 1024 * 1024) { say('That file is over 10MB.'); fi.value = ''; return; }
      var fd = new FormData(); fd.append('photo', f); if ((ta.value || '').trim()) fd.append('body', ta.value.trim());
      say('Uploading ' + f.name + '…');
      var headers = (Wren.authHeaders && Wren.authHeaders()) || { Authorization: 'Bearer ' + (Wren.getToken ? Wren.getToken() : '') };
      fetch('/api/messages/thread/' + threadId + '/reply-photo', { method: 'POST', headers: headers, body: fd })
        .then(function (r) { return r.ok ? r.json() : r.json().then(function (e) { return Promise.reject(e); }); })
        .then(function (r) {
          ta.value = ''; fi.value = '';
          say(r && r.status === 'pending_review' ? 'Attached. A manager checks it before the family sees it.' : 'Attached and sent.');
          if (o.onSent) o.onSent();
        })
        .catch(function (e) { fi.value = ''; say((e && (e.error || e.message)) || 'Could not attach that file (photos, PDF, Word or Excel only).'); });
    });
    load();
    return { reload: load };
  }

  function mountApprovals(host, opts) {
    css(); opts = opts || {};
    if (!host || !isManager()) return;
    function load() {
      api('/drafts').then(function (rows) {
        var wait = (rows || []).filter(function (d) { return (d.draft_kind || 'approval') === 'approval'; });
        host.hidden = !wait.length;
        host.innerHTML = wait.length ? '<h3 style="margin:0 0 8px;font-size:1rem">👀 Waiting for your OK (' + wait.length + ')</h3>'
          + '<div class="wd-list">' + wait.map(function (d) { return itemHtml(d, { showChild: true, openThread: !!opts.openThread }); }).join('') + '</div>' : '';
      }).catch(function () { host.hidden = true; });
    }
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-wd]'); if (!b) return;
      var item = b.closest('.wd-item'), id = item.getAttribute('data-id'), act = b.getAttribute('data-wd');
      if (act === 'open' && opts.openThread) return opts.openThread(Number(item.getAttribute('data-thread')));
      if (act === 'delete') { if (!confirm('Turn this message down? It will not be sent.')) return; api('/draft/' + id, 'DELETE').then(load); }
      if (act === 'send') { b.disabled = true; api('/draft/' + id + '/confirm-send', 'POST', {}).then(function () { toast('Sent on their behalf', 'success'); load(); }).catch(function () { b.disabled = false; }); }
      if (act === 'edit') {
        var body = item.querySelector('.wd-body');
        var nv = prompt('Edit the message before it goes:', body.textContent);
        if (nv && nv.trim()) api('/draft/' + id, 'PUT', { body: nv.trim() }).then(load);
      }
    });
    load();
    return { reload: load };
  }

  window.WrenDrafts = { mount: mount, mountApprovals: mountApprovals, isManager: isManager };
})();
