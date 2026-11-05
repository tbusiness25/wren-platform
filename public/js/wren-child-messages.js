/* Wren — parent messaging panel for Roost (2026-10-01)
 *
 * Toby: "We can't send messages from the admin portal … ideally in the messaging
 * section in Comms. Also allow us to view and create new messages on the child
 * profile screen."
 *
 * WHY THIS FILE EXISTS
 * Roost's Comms → Messaging tab read and replied through /api/comms/messages, an
 * early route that only INSERTs the row: no parent push, no email-reply gateway,
 * no audit, no hold/undo, no read receipts. So a reply "sent" from Roost sat in
 * the table and the family never heard about it. The EY app has always used
 * /api/messages (src/routes/messages.js), which does all of that. This panel
 * uses only /api/messages for anything that sends, and is the ONE messaging UI
 * Roost mounts — in Comms → Messaging (every family) and on the child profile
 * (that child's family). One place, one version.
 *
 *   WrenChildMessages.mount(el, { childId?, childName? })
 *
 * Reads the Roost token from sessionStorage['wrenToken'] like the other Roost
 * standalone pages, so it works inside the SPA and on /child-profile.html alike.
 * Colours are theme tokens only.
 */
(function () {
  'use strict';
  if (window.WrenChildMessages) return;

  var FAMILY_FIELD_LABELS = {
    parent_1_phone: 'Parent 1 phone', parent_2_phone: 'Parent 2 phone', parent_2_email: 'Parent 2 email',
    address_line1: 'Address', address_line2: 'Address (line 2)', postcode: 'Postcode', town: 'Town', parent_phone: 'Phone'
  };

  var CSS = '' +
    '.wcm{display:flex;flex-direction:column;gap:12px;min-width:0}' +
    '.wcm-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}' +
    '.wcm-head h3{margin:0;font-size:1rem;color:var(--c-text)}' +
    '.wcm-sub{font-size:.8rem;color:var(--c-muted);margin:2px 0 0}' +
    '.wcm-btn{display:inline-flex;align-items:center;gap:6px;min-height:40px;padding:8px 14px;border-radius:10px;border:1px solid var(--c-border-strong);background:var(--c-surface-2);color:var(--c-text);font-weight:700;cursor:pointer;font:inherit;font-weight:700}' +
    '.wcm-btn.primary{background:var(--c-blue);border-color:var(--c-blue);color:var(--c-on-blue)}' +
    '.wcm-btn[disabled]{opacity:.55;cursor:not-allowed}' +
    '.wcm-bar{display:flex;gap:8px;flex-wrap:wrap}' +
    '.wcm-bar input,.wcm-bar select,.wcm-form input,.wcm-form select,.wcm-form textarea,.wcm-reply textarea{background:var(--c-surface-2);border:1px solid var(--c-border-strong);border-radius:10px;color:var(--c-text);padding:9px 10px;font:inherit;min-height:40px}' +
    '.wcm-bar input{flex:1;min-width:180px}' +
    '.wcm-form{display:grid;gap:10px;background:var(--c-surface);border:1px solid var(--c-border);border-radius:14px;padding:14px}' +
    '.wcm-form label{font-size:.74rem;font-weight:700;color:var(--c-muted);display:block;margin-bottom:4px;text-transform:uppercase;letter-spacing:.04em}' +
    '.wcm-form textarea,.wcm-reply textarea{min-height:110px;resize:vertical;width:100%}' +
    '.wcm-form input,.wcm-form select{width:100%}' +
    '.wcm-hint{font-size:.78rem;color:var(--c-muted)}' +
    '.wcm-list{display:grid;gap:6px}' +
    '.wcm-row{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;padding:10px 12px;border-radius:12px;background:var(--c-surface);border:1px solid var(--c-border);cursor:pointer;text-align:left;width:100%;color:var(--c-text);font:inherit}' +
    '.wcm-row:hover{border-color:var(--c-blue)}' +
    '.wcm-row b{display:block;font-size:.9rem}' +
    '.wcm-row .p{font-size:.82rem;color:var(--c-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}' +
    '.wcm-row .r{display:flex;flex-direction:column;align-items:flex-end;gap:4px;font-size:.75rem;color:var(--c-muted);white-space:nowrap}' +
    '.wcm-badge{background:var(--c-blue);color:var(--c-on-blue);border-radius:999px;padding:1px 8px;font-weight:800;font-size:.72rem}' +
    '.wcm-empty{color:var(--c-muted);font-size:.86rem;padding:14px;text-align:center}' +
    '.wcm-thread{display:flex;flex-direction:column;gap:8px;max-height:460px;overflow-y:auto;padding:4px 2px}' +
    '.wcm-msg{max-width:78%;display:flex;flex-direction:column;gap:2px}' +
    '.wcm-msg.staff{align-self:flex-end;align-items:flex-end}' +
    '.wcm-msg .b{padding:9px 12px;border-radius:14px;font-size:.9rem;white-space:pre-wrap;word-break:break-word}' +
    '.wcm-msg.staff .b{background:var(--c-blue-soft);border:1px solid var(--c-blue)}' +
    '.wcm-msg.parent .b{background:var(--c-surface-2);border:1px solid var(--c-border)}' +
    '.wcm-msg .m{font-size:.72rem;color:var(--c-muted)}' +
    '.wcm-reply{display:grid;gap:8px}';

  function css() {
    if (document.getElementById('wcm-css')) return;
    var s = document.createElement('style'); s.id = 'wcm-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function when(ts) {
    if (!ts) return '';
    var d = new Date(ts), now = new Date(), mins = Math.round((now - d) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  function toast(msg, kind) {
    if (window.Wren && Wren.toast) Wren.toast(msg, kind || 'info');
  }
  async function api(path, opts) {
    opts = opts || {};
    var token = null;
    try { token = sessionStorage.getItem('wrenToken'); } catch (_) {}
    var res = await fetch(path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: Object.assign({ Authorization: 'Bearer ' + (token || '') }, opts.body ? { 'Content-Type': 'application/json' } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    var data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
    return data;
  }

  function mount(target, opts) {
    css();
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return null;
    opts = opts || {};
    var childId = opts.childId ? Number(opts.childId) : null;
    var state = { threads: [], q: '', unread: false, recipients: null };

    function shell() {
      el.innerHTML =
        '<div class="wcm">' +
          '<div class="wcm-head"><div><h3>' + (childId ? 'Messages with ' + esc(opts.childName ? opts.childName + "'s family" : 'the family') : 'Parent messages') + '</h3>' +
          '<p class="wcm-sub">Parents see these in the parent app, and by email if they have chosen email.</p></div>' +
          '<button class="wcm-btn primary" type="button" data-wcm="new">New message</button></div>' +
          '<div data-wcm="compose" hidden></div>' +
          (childId ? '<div data-wcm="family-notes" hidden></div>' : '') +
          (childId ? '' : '<div class="wcm-bar"><input type="search" data-wcm="q" placeholder="Search by child or subject" aria-label="Search messages">' +
            '<select data-wcm="filter" aria-label="Filter"><option value="">All threads</option><option value="unread">Unread only</option></select></div>') +
          '<div data-wcm="body"><div class="wcm-empty">Loading\u2026</div></div>' +
          // b532 — the family's emails, from the Inbox (staff@ / toby@), under the Wren messages.
          (childId ? '<div class="wcm-head" style="margin-top:18px"><div><h3>Emails</h3>' +
            '<p class="wcm-sub">Emails to and from this family that reached the nursery inbox (from June 2026). Replies sent straight from Gmail are not included.</p></div></div>' +
            '<div data-wcm="emails"><div class="wcm-empty">Loading\u2026</div></div>' : '') +
        '</div>';
      el.querySelector('[data-wcm="new"]').addEventListener('click', compose);
      var q = el.querySelector('[data-wcm="q"]'), f = el.querySelector('[data-wcm="filter"]');
      if (q) q.addEventListener('input', function () { state.q = q.value.toLowerCase(); renderList(); });
      if (f) f.addEventListener('change', function () { state.unread = f.value === 'unread'; renderList(); });
    }

    async function loadList() {
      var body = el.querySelector('[data-wcm="body"]');
      body.innerHTML = '<div class="wcm-empty">Loading\u2026</div>';
      try {
        var d = await api('/api/comms/messages?page=1' + (childId ? '&child_id=' + childId : ''));
        state.threads = (d && d.threads) || [];
        renderList();
      } catch (e) {
        body.innerHTML = '<div class="wcm-empty">Could not load messages: ' + esc(e.message) + '</div>';
      }
    }

    function renderList() {
      var body = el.querySelector('[data-wcm="body"]');
      var rows = state.threads.filter(function (t) {
        if (state.unread && !(parseInt(t.unread_count, 10) > 0)) return false;
        if (state.q && ((t.child_name || '') + ' ' + (t.subject || '')).toLowerCase().indexOf(state.q) === -1) return false;
        return true;
      });
      if (!rows.length) {
        body.innerHTML = '<div class="wcm-empty">' + (state.threads.length ? 'No threads match.' : 'No messages yet. Press New message to start one.') + '</div>';
        return;
      }
      body.innerHTML = '<div class="wcm-list">' + rows.map(function (t) {
        var un = parseInt(t.unread_count, 10) || 0;
        var who = t.last_sender_type === 'parent' ? 'Parent: ' : 'Us: ';
        return '<button class="wcm-row" type="button" data-thread="' + t.id + '"><span style="min-width:0"><b>' +
          esc(childId ? (t.subject || 'Message') : (t.child_name || 'No child') + ' \u00b7 ' + (t.subject || 'Message')) + '</b>' +
          '<span class="p">' + esc(who + (t.last_body || '').slice(0, 120)) + '</span></span>' +
          '<span class="r">' + esc(when(t.last_message_at)) + (un ? '<span class="wcm-badge">' + un + ' new</span>' : '') + '</span></button>';
      }).join('') + '</div>';
      body.querySelectorAll('[data-thread]').forEach(function (b) {
        b.addEventListener('click', function () { openThread(Number(b.getAttribute('data-thread'))); });
      });
    }

    async function openThread(id) {
      var body = el.querySelector('[data-wcm="body"]');
      body.innerHTML = '<div class="wcm-empty">Loading\u2026</div>';
      try {
        var d = await api('/api/messages/thread/' + id);
        api('/api/messages/thread/' + id + '/read', { method: 'POST' }).catch(function () {});
        var msgs = (d && d.messages) || [];
        var t = (d && d.thread) || {};
        body.innerHTML =
          '<div class="wcm-head"><button class="wcm-btn" type="button" data-wcm="back">&larr; All messages</button>' +
          '<span class="wcm-hint">' + esc(t.subject || 'Message') + '</span></div>' +
          '<div class="wcm-thread" data-wcm="thread">' + (msgs.length ? msgs.map(function (m) {
            var staff = m.sender_type === 'staff';
            var flags = [];
            if (m.pending_review) flags.push('awaiting review');
            if (m.held_until && new Date(m.held_until) > new Date()) flags.push('sending shortly');
            if (m.retracted_at) flags.push('withdrawn');
            return '<div class="wcm-msg ' + (staff ? 'staff' : 'parent') + '"><div class="b">' + esc(m.body) + '</div>' +
              '<div class="m">' + esc(staff ? (m.staff_name || 'Nursery') : 'Parent') + ' \u00b7 ' + esc(when(m.created_at)) + (flags.length ? ' \u00b7 ' + esc(flags.join(', ')) : '') + '</div></div>';
          }).join('') : '<div class="wcm-empty">No messages in this thread.</div>') + '</div>' +
          '<div class="wcm-reply"><label class="wcm-hint" for="wcm-reply-' + id + '">Reply</label>' +
          '<textarea id="wcm-reply-' + id + '" data-wcm="reply" placeholder="Write your reply"></textarea>' +
          '<div class="wcm-bar"><button class="wcm-btn primary" type="button" data-wcm="send">Send reply</button></div></div>';
        var th = body.querySelector('[data-wcm="thread"]'); th.scrollTop = th.scrollHeight;
        body.querySelector('[data-wcm="back"]').addEventListener('click', loadList);
        body.querySelector('[data-wcm="send"]').addEventListener('click', async function (ev) {
          var btn = ev.currentTarget, ta = body.querySelector('[data-wcm="reply"]');
          var text = (ta.value || '').trim();
          if (!text) { ta.focus(); return; }
          btn.disabled = true; btn.textContent = 'Sending\u2026';
          try {
            await api('/api/messages/thread/' + id + '/reply', { method: 'POST', body: { body: text } });
            toast('Reply sent', 'success');
            openThread(id);
          } catch (e) {
            toast('Could not send: ' + e.message, 'error');
            btn.disabled = false; btn.textContent = 'Send reply';
          }
        });
      } catch (e) {
        body.innerHTML = '<div class="wcm-empty">Could not open this thread: ' + esc(e.message) + '</div>';
      }
    }

    async function compose() {
      var box = el.querySelector('[data-wcm="compose"]');
      if (!box.hidden) { box.hidden = true; return; }
      var pick = '';
      if (!childId) {
        if (!state.recipients) {
          try { state.recipients = ((await api('/api/messages/recipients')) || {}).parents || []; }
          catch (e) { toast('Could not load families: ' + e.message, 'error'); return; }
        }
        pick = '<div><label for="wcm-child">Child</label><select id="wcm-child" data-wcm="child"><option value="">Choose a child</option>' +
          state.recipients.map(function (r) { return '<option value="' + r.child_id + '">' + esc(r.child_name) + '</option>'; }).join('') +
          '</select><div class="wcm-hint">Only children with a parent email on file are listed.</div></div>';
      }
      box.innerHTML = '<div class="wcm-form">' + pick +
        '<div><label for="wcm-subject">Subject</label><input id="wcm-subject" data-wcm="subject" maxlength="140" placeholder="e.g. Tomorrow\u2019s outing"></div>' +
        '<div><label for="wcm-body">Message</label><textarea id="wcm-body" data-wcm="text" placeholder="Write your message"></textarea></div>' +
        '<div class="wcm-bar"><button class="wcm-btn primary" type="button" data-wcm="go">Send to parents</button><button class="wcm-btn" type="button" data-wcm="cancel">Cancel</button></div></div>';
      box.hidden = false;
      box.querySelector('[data-wcm="cancel"]').addEventListener('click', function () { box.hidden = true; });
      box.querySelector('[data-wcm="go"]').addEventListener('click', async function (ev) {
        var btn = ev.currentTarget;
        var cid = childId || Number((box.querySelector('[data-wcm="child"]') || {}).value || 0);
        var subject = (box.querySelector('[data-wcm="subject"]').value || '').trim();
        var text = (box.querySelector('[data-wcm="text"]').value || '').trim();
        if (!cid) { toast('Choose a child first', 'error'); return; }
        if (!text) { toast('Write a message first', 'error'); return; }
        btn.disabled = true; btn.textContent = 'Sending\u2026';
        try {
          var t = await api('/api/messages/thread', { method: 'POST', body: { child_id: cid, subject: subject || 'Message from Your Nursery', body: text } });
          toast('Message sent', 'success');
          box.hidden = true;
          if (t && t.id) openThread(t.id); else loadList();
        } catch (e) {
          toast('Could not send: ' + e.message, 'error');
          btn.disabled = false; btn.textContent = 'Send to parents';
        }
      });
    }

    // b532 — emails for this child's family (GET /api/comms/child-emails). Click a row to read it.
    async function loadEmails() {
      var box = el.querySelector('[data-wcm="emails"]');
      if (!box) return;
      try {
        var d = await api('/api/comms/child-emails?child_id=' + childId);
        var rows = (d && d.emails) || [];
        var hidden = (d && d.hidden) || 0;
        var note = hidden ? '<div class="wcm-hint" style="margin-top:6px">' + hidden + ' more in a mailbox you don\u2019t have access to.</div>' : '';
        if (!rows.length) {
          box.innerHTML = '<div class="wcm-empty">' + ((d && d.family_addresses) ? 'No emails from this family in the inbox yet.' : 'No family email address on file, so no emails can be matched.') + '</div>' + note;
          return;
        }
        box.innerHTML = '<div class="wcm-list">' + rows.map(function (m) {
          var out = m.direction !== 'in';
          var tags = [];
          if (m.safeguarding) tags.push('<span class="wcm-badge" style="background:#b91c1c">Safeguarding</span>');
          if (m.matched_by === 'local-model') tags.push('<span class="wcm-badge" style="background:#64748b" title="Matched by the nursery\u2019s own AI, not by email address">matched</span>');
          return '<div><button class="wcm-row" type="button" data-email="' + m.id + '"><span style="min-width:0"><b>' +
            esc((out ? 'Us \u2192 ' + (m.to_email || '') : (m.from_email || '')) + ' \u00b7 ' + (m.subject || '(no subject)')) + '</b>' +
            '<span class="p">' + esc((m.snippet || '').slice(0, 140)) + '</span></span>' +
            '<span class="r">' + esc(when(m.at)) + tags.join('') + '</span></button>' +
            '<div data-email-body="' + m.id + '" hidden style="white-space:pre-wrap;font-size:.84rem;padding:10px 12px;border:1px solid var(--c-border);border-top:0;border-radius:0 0 12px 12px;max-height:420px;overflow:auto"></div></div>';
        }).join('') + '</div>' + note;
        box.querySelectorAll('[data-email]').forEach(function (b) {
          b.addEventListener('click', async function () {
            var id = b.getAttribute('data-email');
            var pane = box.querySelector('[data-email-body="' + id + '"]');
            if (!pane) return;
            if (!pane.hidden) { pane.hidden = true; return; }
            pane.hidden = false;
            if (pane.getAttribute('data-loaded')) return;
            pane.textContent = 'Loading\u2026';
            try {
              var e = await api('/api/comms/emails/' + id);
              pane.textContent = (e && (e.body_text || e.snippet)) || '(no text)';
              pane.setAttribute('data-loaded', '1');
            } catch (err) { pane.textContent = 'Could not open this email: ' + err.message; }
          });
        });
      } catch (e) {
        box.innerHTML = '<div class="wcm-empty">Could not load emails: ' + esc(e.message) + '</div>';
      }
    }

    // b534 — family details/notes pulled from the Inbox by the local model
    // (scripts/family-context-from-email.js). Managers only; a practitioner's 403
    // just leaves the card hidden rather than showing an error.
    async function loadFamilyNotes() {
      var box = el.querySelector('[data-wcm="family-notes"]');
      if (!box) return;
      try {
        var d = await api('/api/comms/family-notes?child_id=' + childId);
        renderFamilyNotes(box, d || {});
        box.hidden = false;
      } catch (e) {
        if (!/manager/i.test(e.message || '')) box.hidden = false;
        if (box.hidden) return;
        box.innerHTML = '<div class="wcm-empty">Could not load family notes: ' + esc(e.message) + '</div>';
      }
    }

    function renderFamilyNotes(box, d) {
      var note = d.note || {};
      var important = Array.isArray(note.important) ? note.important : [];
      var fills = (Array.isArray(d.fills) ? d.fills : []).filter(function (f) { return !f.undone_at; });
      box.innerHTML = '<div class="wcm-form">' +
        '<div class="wcm-head" style="margin:0"><h3 style="font-size:.95rem;margin:0">📝 Family notes</h3>' +
        '<span class="wcm-hint">' + (note.edited_at ? 'Edited by staff — won’t be overwritten automatically' : 'From emails, via the nursery’s own local AI') + '</span></div>' +
        (note.note ? '<p style="margin:0;white-space:pre-wrap;font-size:.9rem">' + esc(note.note) + '</p>' : '<p class="wcm-hint" style="margin:0">No relationship note yet.</p>') +
        (important.length ? '<div><label>Important messages</label><ul style="margin:4px 0 0;padding-left:18px;font-size:.86rem">' +
          important.map(function (m) { return '<li>' + esc((m.date || '') + ' — ' + (m.line || '')) + '</li>'; }).join('') + '</ul></div>' : '') +
        (fills.length ? '<div><label>Details found in emails</label><div class="wcm-list">' +
          fills.map(function (f) {
            return '<div class="wcm-row" style="cursor:default"><span style="min-width:0"><b>' + esc(FAMILY_FIELD_LABELS[f.target_column] || f.target_column) + '</b>' +
              '<span class="p">' + esc(f.value) + '</span></span>' +
              '<button class="wcm-btn" type="button" data-undo-fill="' + f.id + '">Undo</button></div>';
          }).join('') + '</div></div>' : '') +
        '<div><label for="wcm-fn-note">Edit note</label><textarea id="wcm-fn-note" data-wcm="fn-text" placeholder="Context about this family’s relationship with us">' + esc(note.note || '') + '</textarea>' +
        '<div class="wcm-bar"><button class="wcm-btn primary" type="button" data-wcm="fn-save">Save note</button></div></div>' +
        '</div>';
      box.querySelectorAll('[data-undo-fill]').forEach(function (b) {
        b.addEventListener('click', async function () {
          var id = b.getAttribute('data-undo-fill');
          b.disabled = true;
          try { await api('/api/comms/family-fills/' + id + '/undo', { method: 'POST' }); toast('Reverted', 'success'); loadFamilyNotes(); }
          catch (e) { toast('Could not undo: ' + e.message, 'error'); b.disabled = false; }
        });
      });
      var saveBtn = box.querySelector('[data-wcm="fn-save"]');
      saveBtn.addEventListener('click', async function () {
        var text = box.querySelector('[data-wcm="fn-text"]').value;
        saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
        try {
          await api('/api/comms/family-notes/' + (note.id || 'new'), { method: 'PUT', body: note.id ? { note: text } : { note: text, child_id: childId } });
          toast('Note saved', 'success');
          loadFamilyNotes();
        } catch (e) { toast('Could not save: ' + e.message, 'error'); saveBtn.disabled = false; saveBtn.textContent = 'Save note'; }
      });
    }

    shell();
    loadList();
    if (childId) { loadEmails(); loadFamilyNotes(); }
    return { reload: loadList, open: openThread };
  }

  window.WrenChildMessages = { mount: mount };
})();
