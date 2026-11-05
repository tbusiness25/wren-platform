/* wren-hermes-inbox.js — b364 (2026-09-29)
 *
 * The inbox in sections, with the context already worked out.
 *
 * Toby, 2026-09-28: "I'd like to view in sections based on who it's addressed to,
 * or what it's about, i.e. all the parent emails, all the Ealing team emails, all
 * the apprenticeship emails … summarise etc."
 *
 * ── THREE THINGS THIS FILE IS CAREFUL ABOUT ─────────────────────────────────
 *
 *  1. IT NEVER SENDS ANYTHING BY ITSELF. The draft sits in a textarea. It becomes
 *     an email when the person presses Send, which POSTs to the b338 send-draft
 *     endpoint — the one send path in Wren. There is no auto-save-and-send, no
 *     "send in 10 seconds", no keyboard shortcut that sends.
 *
 *  2. IT LABELS A GUESS AS A GUESS. A section decided by the sender's domain and
 *     a section decided by the model look different on the screen, because they
 *     have different standing. Same for the card: the facts come from SQL and are
 *     rendered as a table; the context, draft and reasoning are the model's prose
 *     and are rendered as prose, under headings that say so.
 *
 *  3. AN UNREACHABLE ASCENT IS A STATE, NOT AN ERROR. When the local box is down
 *     the sections still work (they are rules and SQL) and the draft area says
 *     drafting is unavailable. The page does not break and does not pretend.
 *
 * Usage:  WrenHermesInbox.mount('hi-mount')
 */
(function () {
  'use strict';

  var API = '/api/inbox-hermes';

  var S = {
    sections: [], urgent: [], mailboxes: [],
    view: 'section',        // 'section' | 'recipient'
    section: 'all',
    addressed: null,
    mailbox: null,
    q: '',
    items: [], total: 0,
    openId: null, card: null, email: null, thread: [],
    staff: [],
    model: null,
    draftTouched: false, draftOriginal: '',
  };

  // ── helpers ───────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(url, opts) { return window.Wren.api(url, opts || {}); }
  // Wren.api rejects with the RESPONSE BODY, not an Error — e.message is
  // undefined on a 4xx. Always read both.
  function why(e) { return (e && (e.message || e.error)) || 'Something went wrong'; }
  function toast(m, kind) { try { window.Wren.toast(m, kind || 'info'); } catch (_) { /* no shell */ } }
  function $(id) { return document.getElementById(id); }

  function ago(iso) {
    var t = Date.parse(iso);
    if (!t) return '';
    var m = Math.round((Date.now() - t) / 60000);
    if (m < 2) return 'just now';
    if (m < 60) return m + 'm ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    var d = Math.round(h / 24);
    if (d < 8) return d + 'd ago';
    return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  function labelFor(key) {
    var hit = S.sections.filter(function (s) { return s.key === key; })[0];
    return hit ? hit.label : (key === '_unclassified' ? 'Not yet filed' : key);
  }
  /* How a section was decided, in words, because "0.99" means nothing on its own. */
  function sourceWords(src, conf) {
    var pct = conf == null ? null : Math.round(Number(conf) * 100) + '%';
    return ({
      domain:   'from the sender’s domain — a rule, not a guess',
      contact:  'the sender is on file — looked up, not guessed',
      rule:     'one of your routing rules had already filed it',
      model:    'Wren’s guess' + (pct ? ' (' + pct + ' sure)' : ''),
      manual:   'set by hand',
      fallback: 'nothing matched — filed under Other',
    })[src] || (src || 'unknown');
  }

  // ── the section switcher ─────────────────────────────────────────────────
  function renderSwitch() {
    var box = $('hi-switch');
    if (!box) return;
    var html = '';
    if (S.view === 'section') {
      var all = S.sections.reduce(function (n, s) { return n + (s.total || 0); }, 0);
      html += chip('all', 'All', all, 0, false);
      S.sections.forEach(function (s) {
        if (!s.total && s.key === 'other') return;         // an empty Other is noise
        html += chip(s.key, s.label, s.total, s.needs_reply, s.urgent);
      });
      if (S.unclassified && S.unclassified.total) {
        html += chip('_unclassified', 'Not yet filed', S.unclassified.total, 0, false);
      }
    } else {
      // Two groupings that usually carry the SAME address, so each chip says which
      // it is: the mailbox Wren polled (and the access boundary) versus the To line
      // the sender actually typed. Unlabelled they read as one chip repeated.
      html += chipTo(null, 'Everything', S.total, false);
      (S.byMailbox || []).forEach(function (m) {
        html += chipTo({ mailbox: m.mailbox }, 'Mailbox: ' + m.mailbox, m.total, S.mailbox === m.mailbox);
      });
      (S.byAddressee || []).forEach(function (a) {
        html += chipTo({ addressed: a.addressed_to }, 'To: ' + a.addressed_to, a.total,
                       S.addressed === a.addressed_to);
      });
      if (S.addresseeUnknown) {
        html += '<span class="hi-badge">' + S.addresseeUnknown + ' older email with no To recorded</span>';
      }
    }
    html += '<span class="hi-viewtoggle">'
      + '<button type="button" class="hi-chip" id="hi-view-toggle" aria-pressed="'
      + (S.view === 'recipient') + '">'
      + (S.view === 'recipient' ? '← By subject matter' : 'By who it’s addressed to →')
      + '</button></span>';
    box.innerHTML = html;

    Array.prototype.forEach.call(box.querySelectorAll('[data-sec]'), function (b) {
      b.addEventListener('click', function () {
        S.section = b.dataset.sec; S.openId = null;
        renderSwitch(); loadList(); renderDetail();
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-to]'), function (b) {
      b.addEventListener('click', function () {
        var v = b.dataset.to ? JSON.parse(b.dataset.to) : {};
        S.mailbox = v.mailbox || null; S.addressed = v.addressed || null; S.openId = null;
        renderSwitch(); loadList(); renderDetail();
      });
    });
    var tg = $('hi-view-toggle');
    if (tg) tg.addEventListener('click', function () {
      S.view = S.view === 'section' ? 'recipient' : 'section';
      S.mailbox = null; S.addressed = null; S.section = 'all'; S.openId = null;
      if (S.view === 'recipient' && !S.byMailbox) loadRecipients();
      else { renderSwitch(); loadList(); renderDetail(); }
    });
  }

  function chip(key, label, total, needs, urgent) {
    return '<button type="button" class="hi-chip' + (urgent ? ' hi-urgent' : '') + '" data-sec="'
      + esc(key) + '" aria-pressed="' + (S.section === key) + '">'
      + esc(label) + ' <b>' + (total || 0) + '</b>'
      + (needs ? ' <span class="hi-need">' + needs + ' to answer</span>' : '') + '</button>';
  }
  function chipTo(val, label, total, on) {
    return '<button type="button" class="hi-chip" data-to="' + esc(JSON.stringify(val || {}))
      + '" aria-pressed="' + (!!on) + '">' + esc(label) + ' <b>' + (total || 0) + '</b></button>';
  }

  // ── the list ─────────────────────────────────────────────────────────────
  function renderList() {
    var box = $('hi-items');
    if (!box) return;
    if (!S.items.length) {
      box.innerHTML = '<div style="padding:22px 14px;font-size:.85rem;line-height:1.6" class="hi-empty">'
        + 'Nothing in ' + esc(S.view === 'section' ? labelFor(S.section === 'all' ? 'all' : S.section) : 'this view')
        + (S.q ? ' matching “' + esc(S.q) + '”' : '') + '.</div>';
      return;
    }
    box.innerHTML = S.items.map(function (e) {
      var tags = [];
      if (e.action_state === 'needs_reply') tags.push('<span class="hi-tag need">needs a reply</span>');
      if (e.has_draft) tags.push('<span class="hi-tag draft">draft ready</span>');
      else if (e.card_unavailable) tags.push('<span class="hi-tag">facts only</span>');
      if (e.section_source === 'model' || e.section_source === 'fallback') {
        tags.push('<span class="hi-tag guess">' + esc(labelFor(e.section)) + '? — a guess</span>');
      } else if (S.section === 'all' || S.view === 'recipient') {
        tags.push('<span class="hi-tag">' + esc(labelFor(e.section)) + '</span>');
      }
      if (e.has_attachments) tags.push('<span class="hi-tag">📎</span>');
      if (e.assigned_to_name) tags.push('<span class="hi-tag">with ' + esc(e.assigned_to_name) + '</span>');
      return '<button type="button" class="hi-item" data-id="' + e.id + '" aria-current="'
        + (S.openId === e.id) + '">'
        + '<span class="hi-item-top"><span class="hi-from">' + esc(e.from_name || e.from_email || 'Unknown')
        + '</span><span class="hi-when">' + esc(ago(e.received_at)) + '</span></span>'
        + '<div class="hi-subj">' + esc(e.subject || '(no subject)') + '</div>'
        + (e.summary || e.snippet ? '<div class="hi-gist">' + esc(e.summary || e.snippet) + '</div>' : '')
        + (tags.length ? '<div class="hi-tags">' + tags.join('') + '</div>' : '')
        + '</button>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-id]'), function (b) {
      b.addEventListener('click', function () { open(parseInt(b.dataset.id, 10)); });
    });
  }

  // ── the detail pane ──────────────────────────────────────────────────────
  function factsTable(f) {
    if (!f) return '';
    var rows = [];
    (f.children || []).forEach(function (c) {
      rows.push(['Child on the roll', esc(c.first_name) + (c.room ? ' — ' + esc(c.room) : '')
        + (c.on_roll ? '' : ' (not active)')]);
    });
    (f.funding || []).forEach(function (fn) {
      rows.push(['Funding this term',
        esc(fn.type || 'type not set')
        + (fn.funded_hours_week != null ? ' · ' + fn.funded_hours_week + ' funded hours/week' : '')
        + (fn.weeks_in_term ? ' over ' + fn.weeks_in_term + ' weeks' : '')
        + (fn.declaration_signed ? '' : ' · declaration NOT signed')]);
    });
    (f.invoices || []).forEach(function (i) {
      rows.push(['Invoice ' + esc(i.number),
        (i.period ? esc(i.period) + ' · ' : '')
        + 'total ' + esc(i.total || '—')
        + (i.funding_deducted && i.funding_deducted !== '£0.00' ? ' (funding −' + esc(i.funding_deducted) + ')' : '')
        + ' · paid ' + esc(i.paid || '£0.00')
        + ' · outstanding ' + esc(i.outstanding || '£0.00')
        + ' · ' + esc(i.status || 'status unknown')]);
    });
    (f.payments || []).forEach(function (p) {
      rows.push(['Payment', esc(p.amount) + ' on ' + esc(String(p.on).slice(0, 10))
        + (p.method ? ' by ' + esc(p.method) : '')]);
    });
    if (f.outstanding) rows.push(['Outstanding in total', esc(f.outstanding)]);
    if (f.supplier) rows.push(['Supplier on file', esc(f.supplier.name)
      + (f.supplier.account_ref ? ' · account ' + esc(f.supplier.account_ref) : '')]);
    if (f.staff) rows.push(['Member of staff', esc(f.staff.first_name) + ' · '
      + esc(f.staff.job_title || f.staff.role || '')]);
    if (f.enquiry) rows.push(['Enquiry on file', esc(f.enquiry.child_first_name || 'child')
      + ' · ' + esc(f.enquiry.room_needed || f.enquiry.preferred_room || 'room not stated')
      + ' · ' + (f.enquiry.replied_at ? 'replied' : 'NOT replied to')]);
    if (f.thread_message_count > 1) rows.push(['This conversation',
      f.thread_message_count + ' messages, ' + (f.thread_replies_sent || 0) + ' of them ours']);
    if (f.history) rows.push(['Before today',
      f.history.emails_from_them + ' email(s) from this address, ' + f.history.we_replied + ' answered']);
    if (!rows.length) return '';
    return '<table class="hi-facts"><tbody>' + rows.map(function (r) {
      return '<tr><th>' + r[0] + '</th><td>' + r[1] + '</td></tr>';
    }).join('') + '</tbody></table>';
  }

  function renderDetail() {
    var box = $('hi-detail');
    if (!box) return;
    var panes = $('hi-panes');
    if (panes) panes.classList.toggle('detail-open', !!S.openId);

    if (!S.openId) {
      box.innerHTML = '<p class="hi-empty">Pick an email. Wren will have already looked up '
        + 'whatever it is about — the invoice, the funding line, the enquiry — and drafted a reply '
        + 'you can edit.</p>';
      return;
    }
    if (!S.email) {
      box.innerHTML = '<div class="hi-skel"><div></div><div></div><div></div><div></div></div>';
      return;
    }

    var e = S.email, c = S.card || {}, f = (c && c.facts) || null;
    var h = [];
    h.push('<button type="button" class="hi-btn small hi-back" id="hi-back">← Back to the list</button>');

    h.push('<div class="hi-d-head">'
      + '<p class="hi-d-subj">' + esc(e.subject || '(no subject)') + '</p>'
      + '<div class="hi-d-meta">From <strong>' + esc(e.from_name || '') + '</strong> &lt;'
      + esc(e.from_email || '') + '&gt;'
      + (e.addressed_to ? ' · to ' + esc(e.addressed_to) : '')
      // Only when it differs: for most mail the To line IS the mailbox, and printing
      // both reads as a stutter.
      + (e.mailbox && e.mailbox !== e.addressed_to ? ' · in ' + esc(e.mailbox) : '')
      + ' · ' + esc(ago(e.received_at))
      + (e.has_attachments ? ' · 📎 has attachments' : '') + '</div>'
      + '<div class="hi-d-sect">'
      + '<span class="hi-badge">' + esc(labelFor(e.section)) + '</span>'
      + '<span class="hi-d-meta">' + esc(sourceWords(e.section_source, e.section_confidence)) + '</span>'
      + '<select class="hi-select" id="hi-sec-fix" aria-label="Move this email to another section">'
      + '<option value="">Move to…</option>'
      + S.sections.map(function (s) {
          return '<option value="' + esc(s.key) + '"' + (s.key === e.section ? ' disabled' : '') + '>'
            + esc(s.label) + '</option>';
        }).join('')
      + '</select></div></div>');

    if (c.context) {
      h.push('<div class="hi-block"><p class="hi-blabel">What Wren knows · written by the local model</p>'
        + '<div class="hi-context">' + esc(c.context) + '</div></div>');
    }
    if (c.unavailable) {
      h.push('<div class="hi-block"><div class="hi-unavail">' + esc(c.unavailable) + '</div></div>');
    }

    var ft = factsTable(f);
    if (ft) {
      h.push('<div class="hi-block"><p class="hi-blabel">The facts · read straight out of Wren</p>'
        + ft + '<p class="hi-fact-note">Every figure above comes from the nursery’s own records. '
        + 'The model is shown these and is not allowed to invent any others.</p></div>');
    }

    h.push('<div class="hi-block"><p class="hi-blabel">Suggested reply · a draft until you press send</p>'
      + '<textarea class="hi-draft" id="hi-draft" spellcheck="true" '
      + 'placeholder="' + esc(c.unavailable ? 'Drafting is unavailable — type a reply here.'
                                            : 'Type a reply here.') + '">'
      + esc(c.suggested_reply || '') + '</textarea>'
      + '<div class="hi-actions">'
      + '<button type="button" class="hi-btn primary" id="hi-send">Send this reply</button>'
      + '<button type="button" class="hi-btn" id="hi-task">Give it to someone</button>'
      + '<button type="button" class="hi-btn" id="hi-handled">Mark handled</button>'
      + '<button type="button" class="hi-btn" id="hi-snooze">Snooze</button>'
      + '<button type="button" class="hi-btn small" id="hi-reask">Ask Hermes again</button>'
      + (e.thread_id ? '<button type="button" class="hi-btn small" id="hi-sumthread">Summarise this thread</button>' : '')
      + '<p class="hi-hint">Nothing is sent until you press <strong>Send this reply</strong>. It goes out from '
      + esc(e.mailbox || 'this mailbox') + ', and Wren records that you sent it.</p>'
      + '</div></div>');

    if (c.reasoning) {
      h.push('<div class="hi-block"><p class="hi-blabel">Why it suggested that</p>'
        + '<div class="hi-reason">' + esc(c.reasoning) + '</div></div>');
    }
    if (c.model) {
      h.push('<p class="hi-d-meta" style="margin-bottom:12px">Drafted by <strong>' + esc(c.model)
        + '</strong> on ' + esc(c.host || 'the local box')
        + (c.duration_ms ? ' in ' + (c.duration_ms / 1000).toFixed(1) + 's' : '')
        + '. No part of this email left the building.</p>');
    }

    h.push('<div class="hi-block"><p class="hi-blabel">The email itself</p>'
      + '<div class="hi-summary">' + esc(e.body_text || e.snippet || '(no body stored)') + '</div></div>');

    if (S.thread && S.thread.length > 1) {
      h.push('<div class="hi-block"><p class="hi-blabel">' + S.thread.length
        + ' messages in this conversation</p><div class="hi-thread">'
        + S.thread.map(function (t) {
            return '<div class="hi-tmsg"><span class="hi-tdir">'
              + (t.direction === 'out' ? 'Us' : esc(t.from_name || t.from_email || 'Them'))
              + '</span> · ' + esc(ago(t.received_at || t.sent_at)) + ' — '
              + esc(t.subject || '') + (t.gist ? '<br>' + esc(t.gist) : '') + '</div>';
          }).join('') + '</div></div>');
    }

    h.push('<div id="hi-scratch"></div>');
    box.innerHTML = h.join('');
    wireDetail();
  }

  function wireDetail() {
    var back = $('hi-back');
    if (back) back.addEventListener('click', function () { S.openId = null; S.email = null; renderDetail(); renderList(); });

    var draft = $('hi-draft');
    S.draftOriginal = (S.card && S.card.suggested_reply) || '';
    S.draftTouched = false;
    if (draft) draft.addEventListener('input', function () { S.draftTouched = true; });

    var fix = $('hi-sec-fix');
    if (fix) fix.addEventListener('change', function () {
      if (!fix.value) return;
      var want = fix.value;
      api(API + '/emails/' + S.openId + '/section', { method: 'PUT', body: { section: want } })
        .then(function (r) {
          S.email.section = r.section; S.email.section_source = r.section_source;
          S.email.section_confidence = r.section_confidence;
          toast('Moved to ' + labelFor(want), 'success');
          return loadSections().then(loadList);
        })
        .then(renderDetail)
        .catch(function (e) { toast(why(e), 'warning'); });
    });

    var send = $('hi-send');
    if (send) send.addEventListener('click', doSend);

    var handled = $('hi-handled');
    if (handled) handled.addEventListener('click', function () {
      api('/api/comms/emails/' + S.openId, { method: 'PATCH', body: { action_state: 'done' } })
        .then(function () { toast('Marked handled', 'success'); S.openId = null; S.email = null; return refresh(); })
        .catch(function (e) { toast(why(e), 'warning'); });
    });

    var snooze = $('hi-snooze');
    if (snooze) snooze.addEventListener('click', function () {
      var when = prompt('Hide it until when? (YYYY-MM-DD)',
        new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10));
      if (!when) return;
      api('/api/comms/emails/' + S.openId, { method: 'PATCH', body: { snoozed_until: when } })
        .then(function () { toast('Snoozed until ' + when, 'success'); S.openId = null; S.email = null; return refresh(); })
        .catch(function (e) { toast(why(e), 'warning'); });
    });

    var reask = $('hi-reask');
    if (reask) reask.addEventListener('click', function () {
      reask.disabled = true; reask.textContent = 'Asking…';
      api(API + '/emails/' + S.openId + '/card', { method: 'POST' })
        .then(function (r) { S.card = r.card; renderDetail(); })
        .catch(function (e) { toast(why(e), 'warning'); reask.disabled = false; reask.textContent = 'Ask Hermes again'; });
    });

    var st = $('hi-sumthread');
    if (st) st.addEventListener('click', function () {
      st.disabled = true; st.textContent = 'Summarising…';
      api(API + '/summary/thread/' + encodeURIComponent(S.email.thread_id))
        .then(function (r) {
          $('hi-scratch').innerHTML = '<div class="hi-block"><p class="hi-blabel">This conversation, summarised</p>'
            + '<div class="hi-summary">' + esc(r.summary || r.unavailable || 'No summary.') + '</div>'
            + (r.cached ? '<p class="hi-fact-note">From earlier today — the same summary is not generated twice.</p>' : '')
            + '</div>';
        })
        .catch(function (e) { toast(why(e), 'warning'); })
        .then(function () { st.disabled = false; st.textContent = 'Summarise this thread'; });
    });

    var task = $('hi-task');
    if (task) task.addEventListener('click', openTaskForm);
  }

  /* Send: the only path that turns a draft into an email, and it needs a click. */
  function doSend() {
    var draft = $('hi-draft');
    var text = draft ? draft.value.trim() : '';
    if (!text) { toast('There is nothing to send', 'warning'); return; }
    if (!confirm('Send this reply to ' + (S.email.from_email || 'the sender') + ' from '
      + (S.email.mailbox || 'this mailbox') + '?')) return;
    var btn = $('hi-send');
    btn.disabled = true; btn.textContent = 'Sending…';
    var source = !S.draftOriginal ? 'typed'
      : (text === S.draftOriginal.trim() ? 'hermes' : 'hermes-edited');
    api('/api/comms/emails/' + S.openId + '/send-draft', { method: 'POST', body: { draft_text: text } })
      .then(function () {
        // Label which draft went out. The send is already logged server-side, so a
        // failure here loses a label, never the audit row.
        return api(API + '/emails/' + S.openId + '/sent', { method: 'POST', body: { draft_source: source } })
          .catch(function () { /* label only */ });
      })
      .then(function () {
        toast('Sent', 'success');
        S.openId = null; S.email = null;
        return refresh();
      })
      .catch(function (e) {
        toast(why(e), 'warning');
        btn.disabled = false; btn.textContent = 'Send this reply';
      });
  }

  function openTaskForm() {
    var slot = $('hi-scratch');
    if (!slot) return;
    slot.innerHTML = '<div class="hi-block"><p class="hi-blabel">Give it to someone</p>'
      + '<div class="hi-row-form">'
      + '<div class="hi-field"><label for="hi-t-who">Who</label>'
      + '<select id="hi-t-who">' + S.staff.map(function (s) {
          return '<option value="' + s.id + '">' + esc(s.name) + '</option>';
        }).join('') + '</select></div>'
      + '<div class="hi-field"><label for="hi-t-when">Deadline</label>'
      + '<input type="date" id="hi-t-when" value="'
      + new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) + '"></div>'
      + '<div class="hi-field" style="flex:1 1 220px"><label for="hi-t-what">What they need to do</label>'
      + '<input type="text" id="hi-t-what" maxlength="200" value="'
      + esc('Deal with: ' + (S.email.subject || 'this email')) + '"></div>'
      + '<button type="button" class="hi-btn primary" id="hi-t-go">Assign it</button>'
      + '</div>'
      + '<p class="hi-fact-note">This creates an Action Plan task with a deadline and tells them. '
      + 'The email itself is not copied into the task — whoever you assign it to may not be able to '
      + 'read the mailbox.</p></div>';
    var go = $('hi-t-go');
    go.addEventListener('click', function () {
      var who = parseInt($('hi-t-who').value, 10);
      if (!who) { toast('Say who it is for', 'warning'); return; }
      go.disabled = true; go.textContent = 'Assigning…';
      api(API + '/emails/' + S.openId + '/task', {
        method: 'POST',
        body: { assignees: [who], deadline: $('hi-t-when').value || null, title: $('hi-t-what').value },
      }).then(function (r) {
        toast('Assigned · task ' + (r.task_id || r.item.id), 'success');
        S.openId = null; S.email = null; return refresh();
      }).catch(function (e) {
        toast(why(e), 'warning'); go.disabled = false; go.textContent = 'Assign it';
      });
    });
  }

  // ── loaders ──────────────────────────────────────────────────────────────
  function loadSections() {
    return api(API + '/sections').then(function (d) {
      S.sections = d.sections || [];
      S.urgent = d.urgent_sections || [];
      S.mailboxes = d.mailboxes || [];
      S.unclassified = d.unclassified || null;
      renderSwitch();
      var mb = $('hi-mailboxes');
      if (mb) mb.textContent = S.mailboxes.join(' · ') || 'no mailbox granted';
    });
  }

  function loadRecipients() {
    return api(API + '/recipients').then(function (d) {
      S.byMailbox = d.by_mailbox || [];
      S.byAddressee = d.by_addressee || [];
      S.addresseeUnknown = d.addressee_not_recorded || 0;
      S.total = S.byMailbox.reduce(function (n, m) { return n + m.total; }, 0);
      renderSwitch(); loadList(); renderDetail();
    }).catch(function (e) { toast(why(e), 'warning'); });
  }

  function loadList() {
    var qs = ['limit=40'];
    if (S.view === 'section' && S.section && S.section !== 'all') qs.push('section=' + encodeURIComponent(S.section));
    if (S.mailbox) qs.push('mailbox=' + encodeURIComponent(S.mailbox));
    if (S.addressed) qs.push('addressed_to=' + encodeURIComponent(S.addressed));
    if (S.q) qs.push('q=' + encodeURIComponent(S.q));
    var box = $('hi-items');
    if (box) box.innerHTML = '<div class="hi-skel"><div></div><div></div><div></div></div>';
    return api(API + '/emails?' + qs.join('&')).then(function (d) {
      S.items = d.emails || [];
      S.total = d.total || 0;
      var n = $('hi-count');
      if (n) n.textContent = S.total + (S.total === 1 ? ' email' : ' emails');
      renderList();
    }).catch(function (e) {
      if (box) box.innerHTML = '<div class="hi-empty" style="padding:20px 14px">' + esc(why(e)) + '</div>';
    });
  }

  function open(id) {
    S.openId = id; S.email = null; S.card = null; S.thread = [];
    renderList(); renderDetail();
    api(API + '/emails/' + id).then(function (d) {
      if (S.openId !== id) return;                   // they clicked something else
      S.email = d.email; S.card = d.card; S.thread = d.thread || [];
      renderDetail();
      // "N opened this" — the b338 activity trail, so two managers working the
      // same mailbox can see each other.
      api('/api/comms/emails/' + id + '/open', { method: 'POST' }).catch(function () {});
    }).catch(function (e) {
      if (S.openId !== id) return;
      $('hi-detail').innerHTML = '<p class="hi-unavail">' + esc(why(e)) + '</p>';
    });
  }

  function refresh() { return loadSections().then(loadList).then(renderDetail); }

  function loadStaff() {
    return api('/api/staff?active=1').then(function (d) {
      var list = Array.isArray(d) ? d : (d.staff || []);
      S.staff = list.map(function (s) {
        return { id: s.id, name: (s.first_name || '') + ' ' + (s.last_name || '') };
      }).filter(function (s) { return s.id; });
    }).catch(function () { S.staff = []; });
  }

  function loadModel() {
    return api(API + '/model').then(function (d) {
      S.model = d;
      var b = $('hi-model');
      if (b) {
        b.className = 'hi-badge ok';
        b.textContent = '🧠 ' + d.reasoning_model + ' on the Ascent · nothing leaves the building';
      }
    }).catch(function (e) {
      var b = $('hi-model');
      if (b) {
        b.className = 'hi-badge warn';
        b.textContent = '⚠️ The Ascent is not answering — sections still work, drafts do not';
        b.title = why(e);
      }
    });
  }

  function wireTop() {
    var s = $('hi-search');
    if (s) {
      var t = null;
      s.addEventListener('input', function () {
        clearTimeout(t);
        t = setTimeout(function () { S.q = s.value.trim(); loadList(); }, 280);
      });
    }
    var r = $('hi-refresh');
    if (r) r.addEventListener('click', function () { refresh(); loadModel(); });
    var sm = $('hi-sumsection');
    if (sm) sm.addEventListener('click', function () {
      var key = S.view === 'section' && S.section !== 'all' ? S.section : null;
      if (!key) { toast('Pick a section first', 'warning'); return; }
      sm.disabled = true; sm.textContent = 'Summarising…';
      api(API + '/summary/section/' + encodeURIComponent(key) + '?days=7').then(function (d) {
        $('hi-detail').innerHTML = '<div class="hi-block"><p class="hi-blabel">'
          + esc(labelFor(key)) + ' · the last ' + d.days + ' days · '
          + d.email_count + ' email' + (d.email_count === 1 ? '' : 's') + '</p>'
          + '<div class="hi-summary">' + esc(d.summary || d.unavailable || 'No summary.') + '</div>'
          + (d.cached ? '<p class="hi-fact-note">Generated earlier today.</p>' : '')
          + '</div>';
        S.openId = null;
      }).catch(function (e) { toast(why(e), 'warning'); })
        .then(function () { sm.disabled = false; sm.textContent = 'Summarise this section'; });
    });
    var cb = $('hi-classify');
    if (cb) cb.addEventListener('click', function () {
      cb.disabled = true; cb.textContent = 'Filing…';
      api(API + '/classify-backlog', { method: 'POST', body: { limit: 50 } })
        .then(function (d) {
          toast('Filed ' + d.classified + (d.remaining ? ' · ' + d.remaining + ' still to do' : ''), 'success');
          return refresh();
        })
        .catch(function (e) { toast(why(e), 'warning'); })
        .then(function () { cb.disabled = false; cb.textContent = 'File the older email'; });
    });
  }

  function mount(id) {
    var root = typeof id === 'string' ? $(id) : id;
    if (!root) return;
    root.innerHTML = template();
    wireTop();
    var p = new URLSearchParams(location.search);
    if (p.get('section')) S.section = p.get('section');
    loadStaff();
    loadModel();
    loadSections().then(loadList).then(function () {
      var want = parseInt(p.get('email'), 10);
      if (want) open(want);
      else renderDetail();
    }).catch(function (e) {
      root.innerHTML = '<div class="hi-wrap"><div class="hi-unavail">' + esc(why(e)) + '</div></div>';
    });
  }

  function template() {
    return '<div class="hi-wrap">'
      + '<div class="hi-top"><div>'
      + '<h1>Inbox</h1>'
      + '<p>Every email filed by who it is from, with what Wren already knows about it, a draft reply '
      + 'and the reasoning. Nothing is sent until you press send.</p>'
      + '</div><span class="hi-top-spacer"></span><div class="hi-top-right">'
      + '<span class="hi-badge" id="hi-mailboxes">…</span>'
      + '<span class="hi-badge" id="hi-model">checking the local model…</span>'
      + '<button type="button" class="hi-btn small" id="hi-refresh">↺ Refresh</button>'
      + '</div></div>'
      + '<div class="hi-switch" id="hi-switch"></div>'
      + '<div class="hi-panes" id="hi-panes">'
      + '<div class="hi-list"><div class="hi-list-head">'
      + '<input class="hi-search" id="hi-search" type="search" placeholder="Search sender or subject…">'
      + '<span class="hi-badge" id="hi-count"></span>'
      + '<button type="button" class="hi-btn small" id="hi-sumsection">Summarise this section</button>'
      + '<button type="button" class="hi-btn small" id="hi-classify">File the older email</button>'
      + '</div><div class="hi-items" id="hi-items"></div></div>'
      + '<div class="hi-detail" id="hi-detail"></div>'
      + '</div></div>';
  }

  window.WrenHermesInbox = { mount: mount, _state: S };
})();
