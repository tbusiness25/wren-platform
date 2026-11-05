/* wren-task-detail.js — b501 (Tasks v2). ONE task detail + ONE create/edit form + the manager accountability panel,
 * shared by every surface: Roost tasks pages, the Cockpit board and "What have I missed", EY My Tasks and HR My Tasks.
 * Not copies: every page just calls WrenTaskDetail.open(id).
 *
 *   WrenTaskDetail.open(id, { onChange })        full detail: description, SMART fields, timeline, sub-tasks, files, evidence,
 *                                                 comments, history, assignees and where each is up to
 *   WrenTaskDetail.create({ onSaved, parentId }) quick or SMART, one person / several / a role / a room / the team
 *   WrenTaskDetail.edit(id, { onSaved })
 *   WrenTaskDetail.accountability(el)            per-person counts (4 / 12 weeks) + "Overdue by person" (managers, deputies)
 *   WrenTaskDetail.wire(root, { onChange })      any element with data-task-open="<id>" opens the detail
 *   WrenTaskDetail.autoOpen({ onChange })        opens ?task=<id> (the link inside a task notification)
 *
 * Colours are tokens only (public/css/wren-tokens.css) — no literal colour anywhere in this file. */
(function () {
  'use strict';
  if (window.WrenTaskDetail) return;

  var CSS = [
    '.wtd-bg{position:fixed;inset:0;background:color-mix(in srgb,var(--c-bg) 70%,transparent);z-index:2000;display:flex;align-items:flex-end;justify-content:center}',
    '@media(min-width:720px){.wtd-bg{align-items:center;padding:20px}}',
    '.wtd-card{background:var(--c-surface-solid);color:var(--c-text);border:1px solid var(--c-border-strong);border-radius:18px 18px 0 0;width:100%;max-width:680px;max-height:92vh;overflow-y:auto;padding:18px 16px calc(18px + env(safe-area-inset-bottom,0px));font-family:inherit}',
    '@media(min-width:720px){.wtd-card{border-radius:18px}}',
    '.wtd-card *{box-sizing:border-box}',
    '.wtd-head{display:flex;gap:10px;align-items:flex-start}',
    '.wtd-title{flex:1;font-size:19px;font-weight:800;line-height:1.25;margin:0}',
    '.wtd-x{background:transparent;border:1px solid var(--c-border-strong);color:var(--c-text);border-radius:10px;min-width:44px;min-height:44px;font-size:18px;cursor:pointer}',
    '.wtd-pills{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}',
    '.wtd-pill{font-size:11px;font-weight:700;padding:4px 10px;border-radius:9px;background:var(--c-tint-neutral);color:var(--c-muted)}',
    '.wtd-pill.due{background:var(--c-blue-soft);color:var(--c-blue)}.wtd-pill.late{background:var(--c-danger-soft);color:var(--c-danger)}',
    '.wtd-pill.ok{background:var(--c-ok-soft);color:var(--c-ok)}.wtd-pill.warn{background:var(--c-warn-soft);color:var(--c-warn)}',
    '.wtd-pill.brand{background:color-mix(in srgb,var(--c-orange) 16%,transparent);color:var(--c-orange)}',
    '.wtd-sec{margin-top:16px}',
    '.wtd-sec>h4{margin:0 0 6px;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--c-muted)}',
    '.wtd-box{background:var(--c-surface-2);border:1px solid var(--c-border);border-radius:12px;padding:10px 12px}',
    '.wtd-smart{display:grid;gap:8px}.wtd-smart b{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--c-blue)}',
    '.wtd-smart span.wtd-q{display:block;font-size:11px;color:var(--c-muted);font-weight:400;text-transform:none;letter-spacing:0}',
    '.wtd-bar{height:8px;border-radius:6px;background:var(--c-tint-neutral);overflow:hidden}.wtd-bar>i{display:block;height:100%;background:var(--c-ok)}',
    '.wtd-row{display:flex;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--c-border)}.wtd-row:last-child{border-bottom:0}',
    '.wtd-row .wtd-grow{flex:1;min-width:0}.wtd-sub{font-size:12px;color:var(--c-muted)}',
    '.wtd-tick{width:26px;height:26px;border-radius:8px;border:2px solid var(--c-border-strong);background:transparent;color:var(--c-on-fill);cursor:pointer;flex:none;font-size:15px;line-height:1;padding:0}',
    '.wtd-tick.on{background:var(--c-ok);border-color:var(--c-ok)}.wtd-tick[disabled]{opacity:.45;cursor:default}',
    '.wtd-btn{border:1px solid var(--c-border-strong);background:var(--c-surface-2);color:var(--c-text);border-radius:12px;min-height:44px;padding:0 16px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit}',
    '.wtd-btn.pri{background:var(--c-orange);border-color:var(--c-orange);color:var(--c-on-orange)}.wtd-btn.ok{background:var(--c-ok);border-color:var(--c-ok);color:var(--c-on-fill)}',
    '.wtd-btn.danger{color:var(--c-danger);border-color:var(--c-danger)}.wtd-btn[disabled]{opacity:.5}',
    '.wtd-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}',
    '.wtd-in,.wtd-card input[type=text],.wtd-card input[type=date],.wtd-card input[type=time],.wtd-card select,.wtd-card textarea{width:100%;min-height:44px;padding:10px 12px;border-radius:12px;border:1px solid var(--c-border-strong);background:var(--c-bg);color:var(--c-text);font:inherit;font-size:15px}',
    '.wtd-card textarea{min-height:76px;resize:vertical}',
    '.wtd-card label.wtd-l{display:block;margin:12px 0 5px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--c-muted)}',
    '.wtd-hint{font-size:12px;color:var(--c-muted);margin-top:4px;line-height:1.4}.wtd-err{color:var(--c-danger);font-size:13px;margin-top:8px;font-weight:600}',
    '.wtd-chips{display:flex;flex-wrap:wrap;gap:6px}.wtd-chip{padding:8px 12px;min-height:40px;border-radius:12px;border:1px solid var(--c-border-strong);background:var(--c-surface-2);color:var(--c-text);font-size:13px;cursor:pointer}',
    '.wtd-chip.on{background:var(--c-blue-soft);border-color:var(--c-blue);color:var(--c-blue);font-weight:700}.wtd-chip.grp{border-style:dashed}',
    '.wtd-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
    '.wtd-tl{position:relative;height:74px;margin:6px 34px 0}.wtd-tl:before{content:"";position:absolute;left:0;right:0;top:30px;height:3px;border-radius:2px;background:var(--c-border-strong)}',
    '.wtd-dot{position:absolute;top:23px;width:17px;height:17px;margin-left:-8px;border-radius:50%;background:var(--c-surface-solid);border:3px solid var(--c-blue)}',
    '.wtd-dot.done{background:var(--c-ok);border-color:var(--c-ok)}.wtd-dot.od{border-color:var(--c-danger)}.wtd-dot.end{border-radius:4px;border-color:var(--c-orange)}',
    '.wtd-dot em{position:absolute;left:50%;transform:translateX(-50%);font-style:normal;font-size:10px;color:var(--c-muted);white-space:nowrap}',
    '.wtd-dot em.up{bottom:20px}.wtd-dot em.dn{top:20px}',
    '.wtd-today{position:absolute;top:14px;bottom:12px;width:2px;background:var(--c-orange)}',
    '.wtd-table{width:100%;border-collapse:collapse;font-size:13px}.wtd-table th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--c-muted);padding:7px 8px;border-bottom:1px solid var(--c-border)}',
    '.wtd-table td{padding:8px;border-bottom:1px solid var(--c-border)}.wtd-table .wtd-num{text-align:center;font-size:14px;font-weight:600;color:var(--c-text)}.wtd-table td.bad{color:var(--c-danger);font-weight:800}',
    '.wtd-seg{display:inline-flex;border:1px solid var(--c-border-strong);border-radius:12px;overflow:hidden}.wtd-seg button{background:transparent;border:0;color:var(--c-muted);padding:0 16px;min-height:44px;font:inherit;font-weight:700;cursor:pointer}',
    '.wtd-seg button.on{background:var(--c-blue);color:var(--c-on-blue)}',
    '.wtd-ms{display:grid;grid-template-columns:1fr 130px 130px 36px;gap:6px;margin-bottom:6px}@media(max-width:560px){.wtd-ms{grid-template-columns:1fr 1fr}}',
    '.wtd-link{background:none;border:0;color:var(--c-blue);cursor:pointer;font:inherit;padding:0;text-align:left}',
    '.wtd-card details>summary{cursor:pointer;color:var(--c-muted);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}',
    '.wtd-open-title{cursor:pointer}'
  ].join('\n');
  function ensureCss() {
    if (document.getElementById('wtd-css')) return;
    var s = document.createElement('style'); s.id = 'wtd-css'; s.textContent = CSS; document.head.appendChild(s);
  }

  // ── tiny helpers ───────────────────────────────────────────────────────────
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function day(d) { return d ? String(d).split('T')[0] : ''; }
  function fmt(d, withYear) {
    if (!d) return '';
    try { return new Date(day(d) + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: withYear ? 'numeric' : undefined }); } catch (e) { return day(d); }
  }
  function fmtDT(d) {
    try { return new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  function time(t) { var m = String(t || '').match(/(\d{1,2})[:.](\d{2})/); return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : ''; }
  function api(url, opts) { return window.Wren.api(url, opts || {}); }
  function toast(m, t) { try { window.Wren.toast(m, t || 'info'); } catch (e) { /* no toast host */ } }
  function myId() {
    try { var u = window.Wren.getUser && window.Wren.getUser(); if (u && u.id) return Number(u.id); } catch (e) { /* fall through */ }
    try { return Number(JSON.parse(atob(window.Wren.getToken().split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).id) || 0; } catch (e) { return 0; }
  }
  function myRole() {
    try { var u = window.Wren.getUser && window.Wren.getUser(); if (u && u.role) return u.role; } catch (e) { /* fall through */ }
    try { return JSON.parse(atob(window.Wren.getToken().split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role || ''; } catch (e) { return ''; }
  }
  function isMgr() { return ['manager', 'deputy_manager', 'admin'].indexOf(myRole()) >= 0; }
  var HOST = null;
  function host() { if (!HOST) { HOST = document.createElement('div'); HOST.id = 'wtd-host'; document.body.appendChild(HOST); } return HOST; }
  function shell(inner, onClose) {
    ensureCss();
    var bg = document.createElement('div'); bg.className = 'wtd-bg'; bg.setAttribute('role', 'dialog'); bg.setAttribute('aria-modal', 'true');
    bg.innerHTML = '<div class="wtd-card">' + inner + '</div>';
    function close() { if (bg.parentNode) bg.parentNode.removeChild(bg); document.removeEventListener('keydown', onKey); if (onClose) onClose(); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    bg.addEventListener('click', function (e) { if (e.target === bg) close(); });
    document.addEventListener('keydown', onKey);
    host().appendChild(bg);
    return { bg: bg, card: bg.firstChild, close: close };
  }
  var REPEAT = [['', 'Does not repeat'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['fortnightly', 'Fortnightly'], ['monthly', 'Monthly'], ['termly', 'Termly'], ['yearly', 'Yearly']];
  var KINDS = [['', 'No link'], ['eyfs_area', 'EYFS area'], ['ofsted_area', 'Ofsted area'], ['policy', 'Policy'], ['child', 'A child (id)'], ['room', 'A room'], ['other', 'Other']];

  // ═══════════════════════════════════════════════════════════════════════════
  // DETAIL
  // ═══════════════════════════════════════════════════════════════════════════
  function timeline(d) {
    var t = d.task, subs = d.subtasks || [];
    var start = day(t.start_date || t.created_at), end = day(t.due_date);
    if (!end) return '';
    var pts = subs.filter(function (s) { return s.due_date; });
    if (!pts.length && !t.start_date) return '';
    var a = new Date(start + 'T00:00:00').getTime(), b = new Date(end + 'T00:00:00').getTime();
    pts.forEach(function (s) { var x = new Date(day(s.due_date) + 'T00:00:00').getTime(); if (x < a) a = x; if (x > b) b = x; });
    var span = Math.max(b - a, 86400000);
    function pos(dt) { return Math.max(0, Math.min(100, ((new Date(day(dt) + 'T00:00:00').getTime() - a) / span) * 100)); }
    var html = '<div class="wtd-tl" aria-label="Timeline">';
    var nowP = pos(new Date().toISOString());
    if (nowP > 0 && nowP < 100) html += '<div class="wtd-today" style="left:' + nowP + '%" title="Today"></div>';
    html += '<div class="wtd-dot" style="left:0" title="Start ' + esc(fmt(start)) + '"><em class="dn">' + esc(fmt(start)) + '</em></div>';
    pts.forEach(function (s, i) {
      html += '<div class="wtd-dot ' + (s.status === 'done' ? 'done' : s.is_overdue ? 'od' : '') + '" style="left:' + pos(s.due_date) + '%" title="' + esc(s.title) + ' — ' + esc(fmt(s.due_date)) + '">'
        + '<em class="' + (i % 2 ? 'dn' : 'up') + '">' + esc((s.title || '').slice(0, 14)) + '</em></div>';
    });
    html += '<div class="wtd-dot end" style="left:100%" title="Deadline ' + esc(fmt(end)) + '"><em class="dn">' + esc(fmt(end)) + '</em></div></div>';
    return '<div class="wtd-sec"><h4>Timeline</h4>' + html + '</div>';
  }

  function render(d, ctx) {
    var t = d.task, p = d.perms, me = myId();
    var smart = t.mode === 'smart' || t.smart_specific || t.smart_measurable || t.smart_achievable || t.smart_relevant;
    var pills = '';
    if (t.status === 'done') pills += '<span class="wtd-pill ok">Done</span>';
    else if (t.is_overdue) pills += '<span class="wtd-pill late">Overdue</span>';
    if (t.due_date) pills += '<span class="wtd-pill due">Due ' + esc(fmt(t.due_date)) + (time(t.time_of_day) ? ' · ' + esc(time(t.time_of_day)) : '') + '</span>';
    if (t.priority === 'urgent') pills += '<span class="wtd-pill late">Urgent</span>'; else if (t.priority === 'high') pills += '<span class="wtd-pill warn">High</span>';
    if (smart) pills += '<span class="wtd-pill brand">SMART</span>';
    if (t.is_project || (d.subtasks || []).length) pills += '<span class="wtd-pill brand">Project</span>';
    if (t.linked_to === 'action_plan') pills += '<span class="wtd-pill">Action plan</span>';
    if (t.repeat_rule) pills += '<span class="wtd-pill">Repeats ' + esc(t.repeat_rule) + (t.skip_non_open_days ? ' · nursery days only' : '') + '</span>';
    if (t.evidence_required) pills += '<span class="wtd-pill warn">Evidence needed</span>';
    if (t.room_name) pills += '<span class="wtd-pill">' + esc(t.room_name) + '</span>';
    if (t.created_by_name) pills += '<span class="wtd-pill">set by ' + esc(t.created_by_name) + '</span>';

    var h = '<div class="wtd-head"><h3 class="wtd-title">' + esc(t.title) + '</h3><button class="wtd-x" data-w="close" aria-label="Close">✕</button></div>';
    if (t.project_title) h += '<div class="wtd-sub">Part of <button class="wtd-link" data-w="open" data-id="' + t.parent_task_id + '">' + esc(t.project_title) + '</button></div>';
    h += '<div class="wtd-pills">' + pills + '</div>';

    // actions
    var act = '';
    var line = p.my_line;
    if (t.status !== 'done' && p.can_tick && (!line || line.status !== 'done')) act += '<button class="wtd-btn ok" data-w="tick">✓ Mark done</button>';
    if (line && line.status === 'done') act += '<button class="wtd-btn" data-w="untick">Undo my tick</button>';
    if (t.status === 'done' && !line && p.can_edit) act += '<button class="wtd-btn" data-w="untick">Reopen</button>';
    if (p.can_edit) act += '<button class="wtd-btn" data-w="edit">Edit</button>';
    act += '<button class="wtd-btn" data-w="pin">' + (t.pinned_at ? 'Unpin' : '📌 Pin') + '</button>';
    if (p.can_delete) act += '<button class="wtd-btn danger" data-w="delete">Delete</button>';
    h += '<div class="wtd-actions">' + act + '</div><div id="wtd-tick-host"></div>';

    if (t.description) h += '<div class="wtd-sec"><div class="wtd-box">' + esc(t.description).replace(/\n/g, '<br>') + '</div></div>';

    if (smart) {
      h += '<div class="wtd-sec"><h4>SMART objective</h4><div class="wtd-box wtd-smart">'
        + (t.smart_specific ? '<div><b>Specific <span class="wtd-q">what exactly is to be done</span></b>' + esc(t.smart_specific) + '</div>' : '')
        + (t.smart_measurable ? '<div><b>Measurable <span class="wtd-q">how we will know it is done</span></b>' + esc(t.smart_measurable) + '</div>' : '')
        + (t.smart_achievable ? '<div><b>Achievable <span class="wtd-q">the support or resources you have</span></b>' + esc(t.smart_achievable) + '</div>' : '')
        + (t.smart_relevant || t.relevant_kind ? '<div><b>Relevant <span class="wtd-q">why it matters</span></b>' + esc(t.smart_relevant || '')
            + (t.relevant_kind ? ' <span class="wtd-pill">' + esc((KINDS.filter(function (k) { return k[0] === t.relevant_kind; })[0] || [0, t.relevant_kind])[1]) + (t.relevant_ref ? ': ' + esc(t.relevant_ref) : '') + '</span>' : '') + '</div>' : '')
        + '<div><b>Time-bound <span class="wtd-q">start, deadline and milestones</span></b>' + (t.start_date ? esc(fmt(t.start_date)) + ' → ' : '') + (t.due_date ? esc(fmt(t.due_date, true)) : 'no deadline set') + '</div>'
        + '</div></div>';
    }

    if (d.progress.total) {
      var pc = Math.round((d.progress.done / d.progress.total) * 100);
      h += '<div class="wtd-sec"><h4>Progress — ' + d.progress.done + ' of ' + d.progress.total + ' ' + esc(d.progress.of) + ' done</h4><div class="wtd-bar"><i style="width:' + pc + '%"></i></div></div>';
    }
    h += timeline(d);

    // sub-tasks / milestones
    var subs = d.subtasks || [];
    if (subs.length || p.can_add_subtasks) {
      h += '<div class="wtd-sec"><h4>Milestones &amp; sub-tasks</h4><div class="wtd-box">';
      subs.forEach(function (s) {
        var mine = (s.assignees || []).some(function (a) { return Number(a.staff_id) === me; });
        var canTick = mine || (!(s.assignees || []).length) || isMgr();
        var names = (s.assignees || []).map(function (a) { return esc(a.name) + (a.status === 'done' ? ' ✓' : ''); }).join(', ');
        h += '<div class="wtd-row"><button class="wtd-tick ' + (s.status === 'done' ? 'on' : '') + '" data-w="subtick" data-id="' + s.id + '" data-done="' + (s.status === 'done' ? 1 : 0) + '" ' + (canTick ? '' : 'disabled') + ' aria-label="Tick">' + (s.status === 'done' ? '✓' : '') + '</button>'
          + '<div class="wtd-grow"><button class="wtd-link" data-w="open" data-id="' + s.id + '"' + (s.status === 'done' ? ' style="text-decoration:line-through"' : '') + '>' + esc(s.title) + '</button>'
          + '<div class="wtd-sub">' + (s.due_date ? 'Due ' + esc(fmt(s.due_date)) : 'no date') + (names ? ' · ' + names : '') + (s.is_overdue ? ' · <span style="color:var(--c-danger)">overdue</span>' : '') + '</div></div></div>';
      });
      if (!subs.length) h += '<div class="wtd-sub">No milestones yet.</div>';
      if (p.can_add_subtasks) h += '<div class="wtd-actions"><button class="wtd-btn" data-w="addsub">+ Add a milestone</button></div><div id="wtd-sub-host"></div>';
      h += '</div></div>';
    }

    // assignees
    if ((d.assignees || []).length) {
      h += '<div class="wtd-sec"><h4>Who &amp; where they are up to</h4><div class="wtd-box">';
      d.assignees.forEach(function (a) {
        var seen = a.first_seen_at ? 'opened ' + esc(fmtDT(a.first_seen_at)) : '<span style="color:var(--c-warn)">not opened yet</span>';
        var status = a.status === 'done' ? '<span class="wtd-pill ok">Done' + (a.late ? ' late' : '') + (a.completed_at ? ' ' + esc(fmtDT(a.completed_at)) : '') + '</span>' : '<span class="wtd-pill ' + (t.is_overdue ? 'late' : '') + '">Open</span>';
        h += '<div class="wtd-row"><div class="wtd-grow"><b>' + esc(a.name) + '</b> <span class="wtd-sub">' + esc(String(a.via || '').replace('person', '').replace('role:', 'as ').replace('room:', 'room ').replace('team', 'whole team')) + '</span>'
          + '<div class="wtd-sub">' + seen + (a.note ? ' · “' + esc(a.note) + '”' : '') + '</div></div>' + status
          + (p.can_tick_for_others && a.status !== 'done' && Number(a.staff_id) !== me && t.status !== 'done' ? '<button class="wtd-btn" data-w="tickfor" data-id="' + a.staff_id + '">Tick for them</button>' : '') + '</div>';
      });
      h += '</div></div>';
    }

    // materials + evidence
    var mats = (d.attachments || []).filter(function (a) { return a.kind !== 'evidence'; });
    var evs = (d.attachments || []).filter(function (a) { return a.kind === 'evidence'; });
    function fileRow(f) { return '<div class="wtd-row"><span>📎</span><a class="wtd-grow" style="color:var(--c-blue)" href="' + esc(f.file_url) + '" target="_blank" rel="noopener">' + esc(f.title || f.filename) + '</a><span class="wtd-sub">' + esc(f.uploaded_by_name || '') + '</span></div>'; }
    if (mats.length || p.can_add_materials) {
      h += '<div class="wtd-sec"><h4>Materials &amp; guidance</h4><div class="wtd-box">' + (mats.length ? mats.map(fileRow).join('') : '<div class="wtd-sub">Nothing attached.</div>')
        + (p.can_add_materials ? '<div style="margin-top:8px"><input type="file" id="wtd-f-mat" accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg,.heic,.mp4"><button class="wtd-btn" data-w="upload" data-kind="material" style="margin-left:6px">Add</button></div>' : '') + '</div></div>';
    }
    if (evs.length || t.evidence_required || line) {
      h += '<div class="wtd-sec"><h4>Evidence' + (t.evidence_required ? ' — required before you can tick this' : '') + '</h4><div class="wtd-box">' + (evs.length ? evs.map(fileRow).join('') : '<div class="wtd-sub">No evidence uploaded yet.</div>')
        + (line ? '<div style="margin-top:8px"><input type="file" id="wtd-f-ev" accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg,.heic,.mp4"><button class="wtd-btn" data-w="upload" data-kind="evidence" style="margin-left:6px">Upload</button></div>' : '') + '</div></div>';
    }

    // comments
    h += '<div class="wtd-sec"><h4>Comments</h4><div class="wtd-box">'
      + ((d.comments || []).length ? d.comments.map(function (c) { return '<div class="wtd-row"><div class="wtd-grow"><b>' + esc(c.author_name || 'Someone') + '</b> <span class="wtd-sub">' + esc(fmtDT(c.created_at)) + '</span><div>' + esc(c.body).replace(/\n/g, '<br>') + '</div></div></div>'; }).join('') : '<div class="wtd-sub">No comments yet.</div>')
      + '<div style="margin-top:8px"><textarea id="wtd-comment" placeholder="Add a comment"></textarea><div class="wtd-actions"><button class="wtd-btn" data-w="comment">Comment</button></div></div></div></div>';

    // history
    if ((d.history || []).length) {
      h += '<div class="wtd-sec"><details><summary>History (' + d.history.length + ')</summary><div class="wtd-box" style="margin-top:6px">'
        + d.history.map(function (x) { return '<div class="wtd-sub">' + esc(fmtDT(x.created_at)) + ' · ' + esc(x.actor_name || 'Wren') + ' · ' + esc(String(x.action).replace(/_/g, ' ')) + '</div>'; }).join('') + '</div></details></div>';
    }
    h += '<div class="wtd-err" id="wtd-err"></div>';
    return h;
  }

  function open(id, opts) {
    opts = opts || {};
    // A page that wires its own click AND a list that wires one must not stack two dialogs for one tap.
    var now = Date.now(); if (window.__wtdLast && window.__wtdLast.id === id && now - window.__wtdLast.t < 500) return Promise.resolve();
    window.__wtdLast = { id: id, t: now };
    ensureCss();
    var S = shell('<div class="wtd-sub" style="padding:24px 0">Loading…</div>', function () { if (opts.onClose) opts.onClose(); });
    var state = null;
    function changed() { if (opts.onChange) { try { opts.onChange(); } catch (e) { /* page callback */ } } }
    function err(m) { var e = S.card.querySelector('#wtd-err'); if (e) e.textContent = m || ''; }
    function load() {
      return api('/api/tasks/' + id + '/detail').then(function (d) {
        state = d; S.card.innerHTML = render(d, opts);
      }).catch(function (e) {
        S.card.innerHTML = '<div class="wtd-head"><h3 class="wtd-title">Task</h3><button class="wtd-x" data-w="close">✕</button></div><div class="wtd-err">'
          + esc((e && (e.error === 'Forbidden' ? 'This task is not one of yours.' : (e.message || e.error))) || 'Could not load that task.') + '</div>';
      });
    }
    function afterError(e, fallback) {
      if (e && e.error === 'evidence_required') { err(e.message); var f = S.card.querySelector('#wtd-f-ev'); if (f) f.focus(); return; }
      err((e && (e.message || e.error)) || fallback);
    }
    function tickForm(who) {
      var t = state.task, overdue = t.is_overdue;
      var hostEl = S.card.querySelector('#wtd-tick-host');
      hostEl.innerHTML = '<div class="wtd-box" style="margin-top:10px"><label class="wtd-l" style="margin-top:0">Note' + (overdue ? ' — required, this is overdue' : ' (optional)') + '</label>'
        + '<textarea id="wtd-note" placeholder="' + (overdue ? 'It was due already. What happened?' : 'Anything worth recording?') + '"></textarea>'
        + '<div class="wtd-actions"><button class="wtd-btn ok" data-w="tickgo"' + (who ? ' data-id="' + who + '"' : '') + '>Confirm done</button><button class="wtd-btn" data-w="tickno">Cancel</button></div></div>';
      var n = hostEl.querySelector('#wtd-note'); if (n) n.focus();
    }
    S.card.addEventListener('click', function (ev) {
      var el = ev.target.closest('[data-w]'); if (!el) return;
      var w = el.dataset.w;
      if (w === 'close') return S.close();
      if (w === 'open') return open(Number(el.dataset.id), opts), S.close();
      if (w === 'tick') return tickForm(null);
      if (w === 'tickfor') return tickForm(el.dataset.id);
      if (w === 'tickno') { S.card.querySelector('#wtd-tick-host').innerHTML = ''; return; }
      if (w === 'tickgo') {
        var note = (S.card.querySelector('#wtd-note').value || '').trim();
        el.disabled = true;
        var body = { note: note }; if (el.dataset.id) body.on_behalf_of = Number(el.dataset.id);
        return api('/api/tasks/' + id + '/complete', { method: 'POST', body: body }).then(function () { toast('Marked done', 'success'); changed(); return load(); })
          .catch(function (e) { el.disabled = false; afterError(e, 'Could not save that.'); });
      }
      if (w === 'untick') return api('/api/tasks/' + id + '/uncomplete', { method: 'POST', body: {} }).then(function () { changed(); return load(); }).catch(function (e) { afterError(e, 'Could not undo that.'); });
      if (w === 'subtick') {
        var sid = el.dataset.id, done = el.dataset.done === '1';
        return api('/api/tasks/' + sid + (done ? '/uncomplete' : '/complete'), { method: 'POST', body: {} }).then(function () { changed(); return load(); })
          .catch(function (e) {
            if (e && e.error === 'note_required_overdue') { var n = window.prompt('This milestone is overdue. What happened?'); if (n) return api('/api/tasks/' + sid + '/complete', { method: 'POST', body: { note: n } }).then(function () { changed(); return load(); }); return; }
            if (e && e.error === 'evidence_required') { err('That milestone needs evidence first — open it and upload a photo or file.'); return; }
            afterError(e, 'Could not tick that.');
          });
      }
      if (w === 'pin') return api('/api/tasks/' + id + '/pin', { method: state.task.pinned_at ? 'DELETE' : 'POST' }).then(function () { changed(); return load(); }).catch(function (e) { afterError(e, 'Could not pin that.'); });
      if (w === 'delete') {
        if (!window.confirm('Delete this task for good?')) return;
        return api('/api/tasks/' + id, { method: 'DELETE' }).then(function () { toast('Deleted'); changed(); S.close(); })
          .catch(function (e) {
            if (e && e.error === 'has_subtasks' && window.confirm(e.message)) return api('/api/tasks/' + id + '?with_subtasks=1', { method: 'DELETE' }).then(function () { changed(); S.close(); });
            afterError(e, 'Could not delete that.');
          });
      }
      if (w === 'edit') { S.close(); return edit(id, { onSaved: function () { changed(); open(id, opts); } }); }
      if (w === 'comment') {
        var ta = S.card.querySelector('#wtd-comment'), body2 = (ta.value || '').trim(); if (!body2) return;
        return api('/api/tasks/' + id + '/comments', { method: 'POST', body: { body: body2 } }).then(function () { return load(); }).catch(function (e) { afterError(e, 'Could not post that.'); });
      }
      if (w === 'upload') {
        var kind = el.dataset.kind, inp = S.card.querySelector(kind === 'evidence' ? '#wtd-f-ev' : '#wtd-f-mat');
        if (!inp || !inp.files || !inp.files[0]) { err('Choose a file first.'); return; }
        var fd = new FormData(); fd.append('file', inp.files[0]); fd.append('kind', kind);
        el.disabled = true;
        // Raw fetch (not Wren.api): Wren.api forces a JSON content-type, which breaks the multipart boundary.
        return fetch('/api/tasks/' + id + '/attachments', { method: 'POST', body: fd, headers: window.Wren.authHeaders() }).then(function (r) {
          if (!r.ok) return r.json().catch(function () { return {}; }).then(function (d) { throw d; });
          toast(kind === 'evidence' ? 'Evidence uploaded' : 'File added', 'success'); changed(); return load();
        }).catch(function (e) { el.disabled = false; afterError(e, 'Upload failed.'); });
      }
      if (w === 'addsub') {
        var hostEl = S.card.querySelector('#wtd-sub-host');
        hostEl.innerHTML = '<div style="margin-top:8px"><input type="text" id="wtd-s-title" placeholder="Milestone, e.g. Order the resources"><div class="wtd-two"><div><label class="wtd-l">Due</label><input type="date" id="wtd-s-due"></div><div><label class="wtd-l">For (optional)</label><select id="wtd-s-who"><option value="">Anyone on the task</option></select></div></div>'
          + '<div class="wtd-actions"><button class="wtd-btn pri" data-w="addsubgo">Add</button><button class="wtd-btn" data-w="addsubno">Cancel</button></div></div>';
        api('/api/tasks/assignable-staff').then(function (r) { var sel = hostEl.querySelector('#wtd-s-who'); (r.staff || []).forEach(function (s) { var o = document.createElement('option'); o.value = s.id; o.textContent = s.first_name + ' ' + s.last_name; sel.appendChild(o); }); }).catch(function () {});
        return;
      }
      if (w === 'addsubno') { S.card.querySelector('#wtd-sub-host').innerHTML = ''; return; }
      if (w === 'addsubgo') {
        var title = (S.card.querySelector('#wtd-s-title').value || '').trim(); if (!title) { err('Give the milestone a name.'); return; }
        var who = S.card.querySelector('#wtd-s-who').value, body3 = { title: title, due_date: S.card.querySelector('#wtd-s-due').value || null };
        if (who) body3.assign = { people: [Number(who)] };
        return api('/api/tasks/' + id + '/subtasks', { method: 'POST', body: body3 }).then(function () { changed(); return load(); }).catch(function (e) { afterError(e, 'Could not add that.'); });
      }
    });
    return load();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CREATE / EDIT
  // ═══════════════════════════════════════════════════════════════════════════
  function form(cfg) {
    cfg = cfg || {};
    var editing = cfg.task || null;
    var S = shell('<div class="wtd-sub" style="padding:24px 0">Loading…</div>');
    Promise.all([api('/api/tasks/assignable-staff').catch(function () { return { staff: [], scope: 'self' }; }),
                 api('/api/tasks/assignable-groups').catch(function () { return {}; })]).then(function (r) {
      var staff = r[0].staff || [], grp = r[1] || {}, scope = r[0].scope;
      var t = editing || {}, mode = t.mode === 'smart' || cfg.mode === 'smart' ? 'smart' : 'quick';
      var tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
      var h = '<div class="wtd-head"><h3 class="wtd-title">' + (editing ? 'Edit task' : cfg.parentId ? 'Add a milestone' : 'New task') + '</h3><button class="wtd-x" data-w="close">✕</button></div>';
      h += '<div style="margin-top:10px" class="wtd-seg" role="tablist"><button data-w="mode" data-m="quick" class="' + (mode === 'quick' ? 'on' : '') + '">Quick task</button><button data-w="mode" data-m="smart" class="' + (mode === 'smart' ? 'on' : '') + '">SMART objective</button></div>';
      h += '<div class="wtd-hint" id="wtd-modehint"></div>';
      h += '<label class="wtd-l" for="wtd-title">What needs doing?</label><input type="text" id="wtd-title" value="' + esc(t.title || '') + '" placeholder="e.g. Weekly fire-drill check">';
      h += '<label class="wtd-l" for="wtd-desc">Detail (optional)</label><textarea id="wtd-desc">' + esc(t.description || '') + '</textarea>';
      if (staff.length > 1 || scope !== 'self') {
        h += '<label class="wtd-l">Who is it for?</label><div class="wtd-chips" id="wtd-who">';
        if (grp.team) h += '<span class="wtd-chip grp" data-g="team">Everyone (' + grp.team.count + ')</span>';
        (grp.roles || []).forEach(function (x) { h += '<span class="wtd-chip grp" data-g="role" data-v="' + esc(x.role) + '">All ' + esc(x.label.toLowerCase()) + ' (' + x.count + ')</span>'; });
        (grp.rooms || []).forEach(function (x) { h += '<span class="wtd-chip grp" data-g="room" data-v="' + x.id + '">' + esc(x.name) + ' (' + x.count + ')</span>'; });
        staff.forEach(function (s) { h += '<span class="wtd-chip" data-g="person" data-v="' + s.id + '">' + esc(s.first_name + ' ' + s.last_name) + '</span>'; });
        h += '</div><div class="wtd-hint" id="wtd-who-hint">A group is turned into the people in it now, so the task shows exactly who was asked.</div>';
      }
      h += '<div class="wtd-two"><div><label class="wtd-l" for="wtd-due">Deadline</label><input type="date" id="wtd-due" value="' + esc(day(t.due_date) || (editing ? '' : tomorrow.toISOString().split('T')[0])) + '"></div>'
        + '<div><label class="wtd-l" for="wtd-time">Due time</label><input type="time" id="wtd-time" value="' + esc(time(t.time_of_day) || '09:00') + '" step="300"></div></div>';
      h += '<div class="wtd-two"><div><label class="wtd-l" for="wtd-pri">Priority</label><select id="wtd-pri">'
        + ['low', 'medium', 'high', 'urgent'].map(function (p) { return '<option value="' + p + '"' + ((t.priority || 'medium') === p ? ' selected' : '') + '>' + p[0].toUpperCase() + p.slice(1) + '</option>'; }).join('') + '</select></div>'
        + '<div><label class="wtd-l" for="wtd-rep">Repeat</label><select id="wtd-rep">' + REPEAT.map(function (p) { return '<option value="' + p[0] + '"' + ((t.repeat_rule || '') === p[0] ? ' selected' : '') + '>' + p[1] + '</option>'; }).join('') + '</select></div></div>';
      h += '<label class="wtd-l" style="display:flex;gap:8px;align-items:center;text-transform:none;font-size:14px;color:var(--c-text)"><input type="checkbox" id="wtd-skip" style="width:auto;min-height:0"' + (t.skip_non_open_days ? ' checked' : '') + '> Repeats skip weekends and nursery closures</label>';
      h += '<label class="wtd-l" style="display:flex;gap:8px;align-items:center;text-transform:none;font-size:14px;color:var(--c-text)"><input type="checkbox" id="wtd-ev" style="width:auto;min-height:0"' + (t.evidence_required ? ' checked' : '') + '> A photo or file must be uploaded before it can be ticked</label>';
      // SMART block
      h += '<div id="wtd-smartbox" ' + (mode === 'smart' ? '' : 'hidden') + '>'
        + '<label class="wtd-l" for="wtd-S">Specific</label><textarea id="wtd-S" placeholder="What exactly will be done? Who, what, where.">' + esc(t.smart_specific || '') + '</textarea>'
        + '<label class="wtd-l" for="wtd-M">Measurable</label><textarea id="wtd-M" placeholder="How will we know it is done? e.g. 3 children use it unprompted in a week.">' + esc(t.smart_measurable || '') + '</textarea>'
        + '<label class="wtd-l" for="wtd-A">Achievable</label><textarea id="wtd-A" placeholder="What support, time or resources are being given?">' + esc(t.smart_achievable || '') + '</textarea>'
        + '<label class="wtd-l" for="wtd-R">Relevant</label><textarea id="wtd-R" placeholder="Why does this matter? Link it to the framework, Ofsted or a policy.">' + esc(t.smart_relevant || '') + '</textarea>'
        + '<div class="wtd-two"><div><label class="wtd-l" for="wtd-rk">Link to</label><select id="wtd-rk">' + KINDS.map(function (k) { return '<option value="' + k[0] + '"' + ((t.relevant_kind || '') === k[0] ? ' selected' : '') + '>' + k[1] + '</option>'; }).join('') + '</select></div>'
        + '<div><label class="wtd-l" for="wtd-rr">Which one</label><input type="text" id="wtd-rr" value="' + esc(t.relevant_ref || '') + '" placeholder="e.g. Communication and Language"></div></div>'
        + '<label class="wtd-l" for="wtd-start">Time-bound: start date</label><input type="date" id="wtd-start" value="' + esc(day(t.start_date) || '') + '">'
        + (editing || cfg.parentId ? '' : '<label class="wtd-l">Milestones (each with its own date)</label><div id="wtd-ms"></div><button class="wtd-btn" data-w="msadd" type="button">+ Add a milestone</button>')
        + '</div>';
      if (!editing && !cfg.parentId) h += '<label class="wtd-l" for="wtd-file">Attach guidance or a template (optional)</label><input type="file" id="wtd-file" accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg,.heic,.mp4">';
      h += '<div class="wtd-hint" id="wtd-remhint"></div>';
      h += '<div class="wtd-actions"><button class="wtd-btn pri" data-w="save">' + (editing ? 'Save changes' : 'Assign') + '</button><button class="wtd-btn" data-w="close">Cancel</button></div><div class="wtd-err" id="wtd-err"></div>';
      S.card.innerHTML = h;

      var picked = {}; // key -> true
      function hint() {
        S.card.querySelector('#wtd-modehint').textContent = mode === 'quick'
          ? 'A reminder with a deadline: a title, who it is for, and a date. They tick it when it is done.'
          : 'A SMART objective: say exactly what, how we will know, what support is given, why, and by when. Add milestones if it is a bigger piece of work.';
        S.card.querySelector('#wtd-remhint').textContent = 'Each person is told when it is set, 24 hours before, and at the deadline. If it slips, they get one nudge a day, and after two days it goes to whoever set it and their line manager.';
        S.card.querySelector('#wtd-smartbox').hidden = mode !== 'smart';
      }
      hint();
      function msRow() {
        var row = document.createElement('div'); row.className = 'wtd-ms';
        row.innerHTML = '<input type="text" class="ms-t" placeholder="Milestone"><input type="date" class="ms-d"><select class="ms-w"><option value="">Anyone</option>' + staff.map(function (s) { return '<option value="' + s.id + '">' + esc(s.first_name) + '</option>'; }).join('') + '</select><button class="wtd-btn" type="button" data-w="msdel" style="padding:0">✕</button>';
        S.card.querySelector('#wtd-ms').appendChild(row);
      }
      S.card.addEventListener('click', function (ev) {
        var el = ev.target.closest('[data-w],[data-g]'); if (!el) return;
        if (el.dataset.g) { el.classList.toggle('on'); return; }
        var w = el.dataset.w;
        if (w === 'close') return S.close();
        if (w === 'mode') { mode = el.dataset.m; S.card.querySelectorAll('[data-w=mode]').forEach(function (b) { b.classList.toggle('on', b === el); }); return hint(); }
        if (w === 'msadd') return msRow();
        if (w === 'msdel') return el.parentNode.remove();
        if (w === 'save') return save(el);
      });
      function val(id) { var e = S.card.querySelector(id); return e ? (e.value || '').trim() : ''; }
      function save(btn) {
        var err = S.card.querySelector('#wtd-err'); err.textContent = '';
        var title = val('#wtd-title'); if (!title) { err.textContent = 'Give the task a title.'; return; }
        var spec = { people: [], roles: [], rooms: [], team: false };
        S.card.querySelectorAll('[data-g].on').forEach(function (c) {
          var g = c.dataset.g, v = c.dataset.v;
          if (g === 'team') spec.team = true; else if (g === 'role') spec.roles.push(v); else if (g === 'room') spec.rooms.push(Number(v)); else spec.people.push(Number(v));
        });
        var hasWho = !!S.card.querySelector('#wtd-who');
        var body = {
          title: title, description: val('#wtd-desc') || null, due_date: val('#wtd-due') || null, time_of_day: val('#wtd-time') || null,
          priority: val('#wtd-pri'), repeat_rule: val('#wtd-rep') || null, skip_non_open_days: S.card.querySelector('#wtd-skip').checked,
          evidence_required: S.card.querySelector('#wtd-ev').checked, mode: mode
        };
        if (mode === 'smart') {
          body.smart_specific = val('#wtd-S') || null; body.smart_measurable = val('#wtd-M') || null; body.smart_achievable = val('#wtd-A') || null; body.smart_relevant = val('#wtd-R') || null;
          body.relevant_kind = val('#wtd-rk') || null; body.relevant_ref = val('#wtd-rr') || null; body.start_date = val('#wtd-start') || null;
        }
        if (hasWho && (spec.people.length || spec.roles.length || spec.rooms.length || spec.team)) body.assign = spec;
        else if (hasWho && !editing && !cfg.parentId && scope !== 'all') { err.textContent = 'Choose who it is for.'; return; }
        if (cfg.parentId) body.parent_task_id = cfg.parentId;
        if (cfg.preset) Object.keys(cfg.preset).forEach(function (k) { if (body[k] == null) body[k] = cfg.preset[k]; });
        var ms = [];
        S.card.querySelectorAll('.wtd-ms').forEach(function (row) {
          var mt = (row.querySelector('.ms-t').value || '').trim(); if (!mt) return;
          var m = { title: mt, due_date: row.querySelector('.ms-d').value || null }; var wv = row.querySelector('.ms-w').value; if (wv) m.assign = { people: [Number(wv)] }; ms.push(m);
        });
        if (ms.length) body.subtasks = ms;
        btn.disabled = true; btn.textContent = 'Saving…';
        var p = editing ? api('/api/tasks/' + editing.id, { method: 'PUT', body: body }) : api('/api/tasks', { method: 'POST', body: body });
        p.then(function (res) {
          var f = S.card.querySelector('#wtd-file');
          if (f && f.files && f.files[0] && res && res.id) {
            var fd = new FormData(); fd.append('file', f.files[0]); fd.append('kind', 'material');
            return fetch('/api/tasks/' + res.id + '/attachments', { method: 'POST', body: fd, headers: window.Wren.authHeaders() }).then(function () { return res; });
          }
          return res;
        }).then(function (res) {
          toast(editing ? 'Saved' : 'Task assigned', 'success'); S.close(); if (cfg.onSaved) cfg.onSaved(res);
        }).catch(function (e) { btn.disabled = false; btn.textContent = editing ? 'Save changes' : 'Assign'; err.textContent = (e && (e.error || e.message)) || 'Could not save that.'; });
      }
    });
    return S;
  }
  function create(cfg) { return form(cfg || {}); }
  function edit(id, cfg) {
    return api('/api/tasks/' + id + '/detail').then(function (d) { return form(Object.assign({}, cfg || {}, { task: d.task })); })
      .catch(function (e) { toast((e && (e.message || e.error)) || 'Could not open that task', 'error'); });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ACCOUNTABILITY (managers, deputies)
  // ═══════════════════════════════════════════════════════════════════════════
  function accountability(el, opts) {
    ensureCss(); opts = opts || {};
    var weeks = 4;
    el.innerHTML = '<div class="wtd-sub">Loading…</div>';
    api('/api/tasks/accountability').then(function (d) {
      function draw() {
        var k = weeks === 4 ? 'w4' : 'w12';
        var h = '<div class="wtd-actions" style="margin:0 0 8px"><div class="wtd-seg"><button data-a="w" data-v="4" class="' + (weeks === 4 ? 'on' : '') + '">4 weeks</button><button data-a="w" data-v="12" class="' + (weeks === 12 ? 'on' : '') + '">12 weeks</button></div></div>';
        h += '<table class="wtd-table"><tr><th>Person</th><th class="wtd-num">Assigned</th><th class="wtd-num">On time</th><th class="wtd-num">Late</th><th class="wtd-num">Overdue</th></tr>';
        if (!d.people.length) h += '<tr><td colspan="5" class="wtd-sub">Nothing with a deadline in this period.</td></tr>';
        d.people.filter(function (p) { return p[k].assigned > 0; }).forEach(function (p) {
          h += '<tr><td>' + esc(p.name) + ' <span class="wtd-sub">' + esc(p.room_name || p.role || '') + '</span></td><td class="wtd-num">' + p[k].assigned + '</td><td class="wtd-num">' + p[k].done_on_time + '</td><td class="wtd-num">' + p[k].done_late + '</td><td class="wtd-num ' + (p[k].overdue ? 'bad' : '') + '">' + p[k].overdue + '</td></tr>';
        });
        h += '</table>';
        h += '<h4 style="margin:18px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--c-muted)">Overdue by person</h4>';
        if (!d.overdue_by_person.length) h += '<div class="wtd-box wtd-sub">Nobody has anything overdue.</div>';
        d.overdue_by_person.forEach(function (p) {
          h += '<details class="wtd-box" style="margin-bottom:8px"><summary style="text-transform:none;letter-spacing:0;font-size:14px;color:var(--c-text)"><b>' + esc(p.name) + '</b> — <span style="color:var(--c-danger);font-weight:800">' + p.count + ' overdue</span>, oldest ' + p.oldest_days + ' day' + (p.oldest_days === 1 ? '' : 's') + '</summary>'
            + p.tasks.map(function (t) { return '<div class="wtd-row"><div class="wtd-grow"><button class="wtd-link" data-a="open" data-id="' + t.id + '">' + esc(t.title) + '</button><div class="wtd-sub">due ' + esc(fmt(t.due_date)) + ' · ' + t.days_over + ' day' + (t.days_over === 1 ? '' : 's') + ' over · ' + (t.seen ? 'opened' : '<span style="color:var(--c-warn)">never opened</span>') + '</div></div></div>'; }).join('') + '</details>';
        });
        el.innerHTML = h;
      }
      draw();
      el.onclick = function (ev) {
        var b = ev.target.closest('[data-a]'); if (!b) return;
        if (b.dataset.a === 'w') { weeks = Number(b.dataset.v); return draw(); }
        if (b.dataset.a === 'open') return open(Number(b.dataset.id), { onChange: opts.onChange });
      };
    }).catch(function (e) { el.innerHTML = '<div class="wtd-err">' + esc((e && (e.message || e.error)) || 'Could not load the accountability view.') + '</div>'; });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROJECTS (what used to be Action Plans)
  // ═══════════════════════════════════════════════════════════════════════════
  function projects(el, opts) {
    ensureCss(); opts = opts || {};
    return api('/api/tasks/projects').then(function (rows) {
      if (!rows.length) { el.innerHTML = ''; return; }
      el.innerHTML = '<div class="wtd-sec" style="margin-top:0"><h4>Projects &amp; action plans (' + rows.length + ')</h4>' + rows.map(function (r) {
        var pc = r.subtasks_total ? Math.round((r.subtasks_done / r.subtasks_total) * 100) : (r.status === 'done' ? 100 : 0);
        return '<div class="wtd-box" data-task-open="' + r.id + '" style="margin-bottom:8px;cursor:pointer"><div class="wtd-pills" style="margin:0 0 6px">'
          + (r.is_overdue ? '<span class="wtd-pill late">Overdue</span>' : '')
          + (r.linked_to === 'action_plan' ? '<span class="wtd-pill">Action plan</span>' : '')
          + (r.due_date ? '<span class="wtd-pill due">Due ' + esc(fmt(r.due_date)) + '</span>' : '')
          + (r.subtasks_overdue ? '<span class="wtd-pill late">' + r.subtasks_overdue + ' overdue</span>' : '')
          + (r.owner_name ? '<span class="wtd-pill">' + esc(r.owner_name) + '</span>' : '') + '</div>'
          + '<b>' + esc(r.title) + '</b><div class="wtd-sub" style="margin:4px 0">' + r.subtasks_done + ' of ' + r.subtasks_total + ' done</div><div class="wtd-bar"><i style="width:' + pc + '%"></i></div></div>';
      }).join('') + '</div>';
      el.onclick = function (ev) { var c = ev.target.closest('[data-task-open]'); if (c) { ev.stopPropagation(); open(Number(c.dataset.taskOpen), { onChange: opts.onChange }); } };
    }).catch(function () { el.innerHTML = ''; });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // wiring
  // ═══════════════════════════════════════════════════════════════════════════
  function wire(root, opts) {
    (root || document).addEventListener('click', function (ev) {
      var el = ev.target.closest('[data-task-open]'); if (!el) return;
      if (ev.target.closest('button,a,input,select,textarea') && ev.target.closest('button,a,input,select,textarea') !== el) return; // a real control inside the card keeps its own job
      ev.preventDefault(); open(Number(el.dataset.taskOpen), opts || {});
    });
  }
  function autoOpen(opts) {
    try {
      var id = new URLSearchParams(location.search).get('task');
      if (id && /^\d+$/.test(id)) open(Number(id), opts || {});
    } catch (e) { /* no query string */ }
  }

  window.WrenTaskDetail = { open: open, create: create, edit: edit, accountability: accountability, projects: projects, wire: wire, autoOpen: autoOpen, role: myRole, isManager: isMgr };
}());
