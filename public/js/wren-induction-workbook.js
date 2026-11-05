/* Wren — the induction workbook, one copy of the logic (b313, 2026-09-10)
 *
 * WHY THIS FILE EXISTS
 * The same induction workbook is now readable and writable from three places:
 *
 *   • /onboard/induction?token=…          the tokened welcome page (b275/b288) —
 *                                        for somebody with no account yet.
 *                                        READ-ONLY, rendered server-side.
 *   • HR   → editions/hr/public/my-induction.html
 *   • EY   → editions/ladn/public/ey/my-induction.html      (b313, the tablets)
 *
 * All three read and write the SAME induction_assignments / induction_item_progress
 * rows. There is no second store and no sync step: a tick on a tablet is a row a
 * room leader sees on HR on their next load.
 *
 * What the two logged-in pages must NOT do is each carry their own copy of the
 * rules, because the rules are where the bugs were:
 *
 *   1. WHICH ID TO SEND. The workbook GET returns item_id (the template item)
 *      AND progress_id (the induction_item_progress row, null until one exists).
 *      PATCH /item-progress/:id wants the second. The HR page sent the first, so
 *      every "Mark done" and "Sign off" 404'd — and because Wren.api() rejects
 *      with the response BODY rather than an Error, the page said "Could not
 *      update: undefined". (memory/reference_wren_api_rejects_with_body.md)
 *      setStatus() below uses the id-agnostic PUT that b313 added, which upserts
 *      on (assignment, item) and so also reaches an item added to the template
 *      after the assignment was created.
 *
 *   2. WHO MAY TICK WHAT. The HR page decided that by comparing item.title to
 *      the literal 'Induction formally signed off by manager'. A hidden button
 *      is not a rule: the starter's own JWT could set that row to done and got
 *      200. It is now induction_template_items.signoff_only, enforced in
 *      src/routes/induction.js on both write paths, and plan() below is the ONE
 *      place either page asks what an item offers.
 *
 * The pages own their layout — HR is a desk page with expanding week cards, EY is
 * a 7" tablet held one-handed — and this file owns the decisions, the writes, and
 * the two readers (course + policy) that are identical wherever you open them.
 *
 * EVERY fetch goes through Wren.api(), which carries X-Wren-Device. The EY portal
 * gates the whole /api prefix on device enrolment, and b280/b306 each found call
 * sites that used bare fetch() and failed silently.
 * (memory/project_ey_device_gate_silent_403.md)
 *
 * Depends on: /js/wren-core.js (Wren.api). No other library.
 */
(function () {
  'use strict';

  var W = window.WrenInduction = {};

  // The title the HR page matched on before signoff_only existed. Still used for
  // ONE thing — the wording of the final tile ("Sign off induction", "Awaiting
  // your manager's sign-off"), which reads better than the generic line.
  var CLOSING_TITLE = 'Induction formally signed off by manager';

  W.ITEM_ICON = { form: '📋', course: '🎓', reading: '📖', task: '🧭', policy_ack: '📜', document: '📎' };
  W.ITEM_KIND_LABEL = {
    form: 'A form to fill in', course: 'A short course', reading: 'Something to read',
    task: 'Something to be shown', policy_ack: 'A policy to acknowledge', document: 'A document we need',
  };
  W.STATUS_LABEL = { pending: 'To do', in_progress: 'In progress', done: 'Done', signed_off: 'Signed off' };

  // ── small shared helpers ──────────────────────────────────────────────────
  W.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
  W.fmtDate = function (d) {
    if (!d) return '';
    try { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch (_) { return String(d); }
  };
  /* Wren.api() rejects with the parsed response body, so `e.message` is
     undefined and `String(e)` is "[object Object]". Both pages showed one of
     those to a practitioner at some point. One reader for both.
     (memory/reference_wren_api_rejects_with_body.md) */
  W.errText = function (e) {
    if (!e) return 'Something went wrong.';
    if (typeof e === 'string') return e;
    return e.message || e.error || (e.body && (e.body.message || e.body.error)) || 'Something went wrong.';
  };

  // ── reads ─────────────────────────────────────────────────────────────────
  /* Every workbook belonging to the signed-in person. A starter here typically
     has THREE (the main induction, the manager walkthrough, the fire induction),
     which is why this returns a list and not just the newest — the HR page used
     to show max(id) and leave the other two unreachable. Incomplete first, then
     newest, so `list[0]` is the one to open. */
  W.mine = function () {
    var user = (window.Wren && Wren.getUser) ? (Wren.getUser() || {}) : {};
    return Wren.api('/api/induction/assignments').then(function (list) {
      var rows = (Array.isArray(list) ? list : []).filter(function (a) {
        return Number(a.staff_id) === Number(user.id);
      });
      rows.sort(function (x, y) {
        var xc = x.status === 'complete' ? 1 : 0, yc = y.status === 'complete' ? 1 : 0;
        if (xc !== yc) return xc - yc;
        return (y.id || 0) - (x.id || 0);
      });
      return rows;
    });
  };

  W.detail = function (assignmentId) {
    return Wren.api('/api/induction/assignments/' + assignmentId);
  };

  W.sync = function (assignmentId) {
    return Wren.api('/api/induction/assignments/' + assignmentId + '/sync', { method: 'POST' })
      .catch(function () { return null; });   // best-effort: the reload re-syncs anyway
  };

  /* Group a detail's items into weeks, in order, with the counts each window
     shows. `sub` is the section's own subtitle where the template carries one
     ("Week 1 · The building and the basics" -> "The building and the basics"). */
  W.weeks = function (detail) {
    var bucket = {}, order = [];
    (detail && detail.items ? detail.items : []).forEach(function (it) {
      var w = it.week_number != null ? it.week_number : 0;
      if (!bucket[w]) { bucket[w] = []; order.push(w); }
      bucket[w].push(it);
    });
    order.sort(function (a, b) { return a - b; });
    return order.map(function (w) {
      var items = bucket[w];
      var done = items.filter(function (it) {
        return it.status === 'done' || it.status === 'signed_off';
      }).length;
      var first = items[0] || {};
      var sub = (first.section && String(first.section).indexOf('·') > -1)
        ? String(first.section).split('·').slice(1).join('·').trim() : '';
      return {
        w: w, label: w ? 'Week ' + w : 'Also', sub: sub, items: items,
        done: done, total: items.length, complete: done === items.length,
        open: items.some(function (it) { return it.status === 'pending' || it.status === 'in_progress'; }),
      };
    });
  };

  /* Which week to land on: the first with anything still open, else the last. */
  W.resumeIndex = function (weeks) {
    for (var i = 0; i < weeks.length; i++) if (weeks[i].open) return i;
    return weeks.length ? weeks.length - 1 : 0;
  };

  // ── the one decision ──────────────────────────────────────────────────────
  /* What does this item offer THIS person? Both pages ask here and neither
     re-derives it. Returns:
     {
       status, statusLabel, done, kind, signoffOnly, closing,
       actions: [{ type:'course'|'policy'|'tick'|'signoff', label, style }],
       note        // plain sentence to show INSTEAD of a control, or null
     }
     `kind` is what the item IS ('course' | 'policy' | 'self' | 'signoff'), which
     is what the EY page keys its "who ticks this" line off. The rule the API
     enforces and this mirrors: a signoff_only item is not the starter's to move,
     so it never renders a control for them — it says who does it. */
  W.plan = function (item, assignment) {
    var a = assignment || {};
    var st = item.status || 'pending';
    var done = st === 'done' || st === 'signed_off';
    var signoffOnly = item.signoff_only === true;
    var closing = item.title === CLOSING_TITLE;
    var canSignOff = !!a.can_sign_off;
    var isOwner = !!a.is_owner;
    // login-20261023 — Apprentice pathway items tick themselves (auto_rule); 'ready' is the manager's switch.
    var rule = String(item.auto_rule || '');
    var kind = rule ? 'auto'
      : signoffOnly ? 'signoff'
      : (item.item_type === 'course' && item.course_id) ? 'course'
      : (item.item_type === 'policy_ack' && item.policy_id) ? 'policy'
      : 'self';
    var out = {
      status: st, statusLabel: W.STATUS_LABEL[st] || st, done: done,
      kind: kind, signoffOnly: signoffOnly, closing: closing,
      actions: [], note: null,
    };

    if (kind === 'auto') {
      var ap = item.auto_progress;
      if (rule === 'ready') {
        if (!done && a.can_mark_ready) out.actions.push({ type: 'ready', style: 'manager', label: 'Ready to observe — switch observations on' });
        else if (done && a.can_mark_ready) out.actions.push({ type: 'not-ready', style: 'ghost', label: 'Not ready yet — switch observations off' });
        else if (!done) out.note = 'A manager switches this on when you and your mentor agree you are ready';
        return out;
      }
      if (!done && isOwner && /^practice_obs/.test(rule)) out.actions.push({ type: 'journal-practice', style: 'primary', label: 'Write a practice observation' });
      if (!done && isOwner && /^reflections/.test(rule)) out.actions.push({ type: 'journal-note', style: 'ghost', label: 'Write a note' });
      if (!done && ap) out.note = ap.have + ' of ' + ap.need + (ap.label ? ' ' + ap.label : '') + ' — this ticks itself';
      return out;
    }

    if (!done) {
      if (kind === 'course') {
        out.actions.push({ type: 'course', style: 'primary',
          label: st === 'in_progress' ? 'Continue course' : 'Start course' });
      } else if (kind === 'policy') {
        out.actions.push({ type: 'policy', style: 'primary', label: 'Read & acknowledge' });
      } else if (kind === 'signoff') {
        if (canSignOff) {
          out.actions.push({ type: 'signoff', style: 'manager',
            label: closing ? 'Sign off induction' : 'Sign off' });
        } else {
          out.note = closing
            ? "Awaiting your manager's sign-off"
            : 'Your room leader signs this off with you in person';
        }
      } else {
        if (isOwner) out.actions.push({ type: 'tick', style: 'ghost', label: 'Mark done' });
        if (canSignOff) out.actions.push({ type: 'signoff', style: 'manager', label: 'Sign off' });
        if (!isOwner && !canSignOff) out.note = 'Your room leader records this one';
      }
    } else if (st === 'done' && canSignOff && kind !== 'course' && kind !== 'policy') {
      out.actions.push({ type: 'signoff', style: 'manager', label: 'Sign off' });
    }
    return out;
  };

  // ── the one write ─────────────────────────────────────────────────────────
  /* Always the id-agnostic PUT: pass the ITEM (or its item_id), never a progress
     row id. Resolves to the updated progress row (with .assignment carrying the
     recomputed %). Rejects with the API body — use W.errText(). */
  W.setStatus = function (assignmentId, item, status, evidenceNote) {
    var itemId = (item && item.item_id != null) ? item.item_id : item;
    var body = { status: status };
    if (evidenceNote !== undefined) body.evidence_note = evidenceNote;
    return Wren.api('/api/induction/assignments/' + assignmentId + '/items/' + itemId + '/progress',
      { method: 'PUT', body: JSON.stringify(body) });
  };

  // ── the two readers (course + policy), rendered by this file for both pages ─
  var CSS_ID = 'wren-induction-workbook-css';
  /* All colour comes from var(--c-*), but NOT via the --c-*-light tokens. Those
     are fixed pale values meant for a white page, while --c-blue-dark is
     lighten/darken(accent) — pairing them gave 2.77:1 on the primary button and
     ~1.4:1 on the selected quiz option, measured in Chrome. Every coloured
     surface here is a translucent tint of its own token over the real page
     background, with that token (or --c-text) as the ink, so it composites
     correctly on navy and under a light preset alike. Each is declared twice —
     flat var() first, color-mix() second — so a tablet too old for color-mix
     keeps a readable fallback. Never white-on-accent: applyEY() sets --c-blue to
     the user's accent, which at the EY default is a pale yellow. */
  var CSS = [
    '.wib-backdrop{position:fixed;inset:0;background:var(--c-bg);z-index:1200;display:none;overflow-y:auto;}',
    '.wib-backdrop.open{display:block;}',
    '.wib-sheet{background:var(--c-surface);border:1px solid var(--c-border);border-radius:16px;',
      'max-width:680px;margin:0 auto;padding:18px 16px calc(24px + env(safe-area-inset-bottom,0px));}',
    '@media(min-width:600px){.wib-backdrop.open{padding:32px 16px;}}',
    '.wib-head{display:flex;align-items:flex-start;gap:12px;margin-bottom:14px;}',
    '.wib-head h2{margin:0;font-size:1.05rem;line-height:1.35;color:var(--c-text);flex:1;',
      'overflow-wrap:anywhere;}',
    '.wib-x{flex:0 0 auto;min-width:44px;min-height:44px;border-radius:12px;border:1px solid var(--c-border);',
      'background:transparent;color:var(--c-muted);font-size:1.1rem;cursor:pointer;font-family:inherit;}',
    '.wib-meta{font-size:.8rem;color:var(--c-muted);margin-bottom:10px;}',
    '.wib-bar{background:var(--c-bg);border-radius:6px;height:8px;overflow:hidden;margin:8px 0 14px;}',
    '.wib-bar i{display:block;height:100%;background:var(--c-blue);border-radius:6px;transition:.3s;}',
    '.wib-prose{background:var(--c-bg);border:1px solid var(--c-border);border-radius:12px;padding:14px;',
      'font-size:.95rem;line-height:1.7;color:var(--c-text);white-space:pre-wrap;overflow-wrap:anywhere;',
      'max-height:52vh;overflow-y:auto;}',
    '.wib-q{color:var(--c-text);font-weight:700;margin:0 0 14px;line-height:1.5;overflow-wrap:anywhere;}',
    '.wib-opt{display:flex;align-items:center;gap:12px;padding:14px;border-radius:12px;',
      'background:var(--c-bg);margin-bottom:8px;cursor:pointer;border:2px solid var(--c-border);',
      'min-height:56px;text-align:left;width:100%;font-family:inherit;font-size:.95rem;color:var(--c-text);}',
    '.wib-opt.on{border-color:var(--c-blue);color:var(--c-text);background:var(--c-surface);',
      'background:color-mix(in srgb,var(--c-blue) 18%,transparent);}',
    '.wib-opt .k{flex:0 0 auto;width:30px;height:30px;border-radius:50%;border:2px solid currentColor;',
      'display:flex;align-items:center;justify-content:center;font-weight:800;font-size:.8rem;}',
    '.wib-opt .t{flex:1;overflow-wrap:anywhere;}',
    '.wib-foot{display:flex;gap:10px;justify-content:space-between;margin-top:18px;}',
    '.wib-btn{min-height:52px;padding:12px 20px;border-radius:14px;font-weight:800;font-size:.95rem;',
      'cursor:pointer;font-family:inherit;border:2px solid var(--c-border);background:transparent;',
      'color:var(--c-text);flex:1 1 auto;}',
    '.wib-btn.primary{border-color:var(--c-blue);color:var(--c-text);background:var(--c-surface);',
      'background:color-mix(in srgb,var(--c-blue) 18%,transparent);}',
    '.wib-btn:disabled{opacity:.55;cursor:default;}',
    '.wib-ok{color:var(--c-green);font-weight:700;font-size:.9rem;margin-top:12px;}',
    '.wib-bad{color:var(--c-red);font-weight:600;font-size:.9rem;margin-top:12px;overflow-wrap:anywhere;}',
    '.wib-centre{text-align:center;padding:26px 8px;color:var(--c-muted);}',
    '.wib-score{font-size:2rem;font-weight:900;color:var(--c-text);}',
  ].join('');

  function ensureCss() {
    if (document.getElementById(CSS_ID)) return;
    var s = document.createElement('style');
    s.id = CSS_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  var host = null;      // the backdrop element, created once
  function sheet() {
    ensureCss();
    if (!host) {
      host = document.createElement('div');
      host.className = 'wib-backdrop';
      host.setAttribute('role', 'dialog');
      host.setAttribute('aria-modal', 'true');
      host.innerHTML = '<div class="wib-sheet"></div>';
      host.addEventListener('click', function (e) { if (e.target === host) W.close(); });
      document.body.appendChild(host);
    }
    return host.querySelector('.wib-sheet');
  }
  function open() { sheet(); host.classList.add('open'); document.body.style.overflow = 'hidden'; }
  W.close = function () {
    if (host) host.classList.remove('open');
    document.body.style.overflow = '';
  };

  function headHtml(title, meta) {
    return '<div class="wib-head"><h2>' + W.esc(title) + '</h2>' +
      '<button class="wib-x" type="button" aria-label="Close" data-wib-close>✕</button></div>' +
      (meta ? '<div class="wib-meta">' + W.esc(meta) + '</div>' : '');
  }
  function wire(el, onDone) {
    Array.prototype.forEach.call(el.querySelectorAll('[data-wib-close]'), function (b) {
      b.addEventListener('click', function () { W.close(); if (onDone) onDone(); });
    });
  }

  /* ── policy: read it, acknowledge it ────────────────────────────────────────
     Acknowledging writes to policy_acknowledgments (the setting's ONE policy
     register), then asks the induction auto-complete engine to re-run, which is
     what turns the workbook item done. The workbook never writes a policy item
     directly — that would be the second store this build exists to avoid. */
  W.openPolicy = function (o) {
    var el = sheet(); open();
    el.innerHTML = '<div class="wib-centre">Loading policy…</div>';
    Wren.api('/api/policies/' + o.policyId).then(function (p) {
      el.innerHTML = headHtml(p.title, [p.category, p.version ? 'v' + p.version : null]
          .filter(Boolean).join(' · ')) +
        '<div class="wib-prose">' + W.esc(p.content || 'No content on file.') + '</div>' +
        (p.acknowledged
          ? '<div class="wib-ok">✓ Already acknowledged' +
              (p.acknowledged_at ? ' · ' + W.esc(W.fmtDate(p.acknowledged_at)) : '') + '</div>' +
            '<div class="wib-foot"><button class="wib-btn" type="button" data-wib-close>Close</button></div>'
          : '<div class="wib-foot">' +
              '<button class="wib-btn" type="button" data-wib-close>Not yet</button>' +
              '<button class="wib-btn primary" type="button" id="wib-ack">I have read this</button>' +
            '</div><div class="wib-bad" id="wib-ack-err" style="display:none"></div>');
      wire(el, o.onDone);
      var btn = el.querySelector('#wib-ack');
      if (btn) btn.addEventListener('click', function () {
        btn.disabled = true; btn.textContent = 'Saving…';
        Wren.api('/api/policies/' + o.policyId + '/acknowledge', { method: 'POST' })
          .then(function () { return W.sync(o.assignmentId); })
          .then(function () { W.close(); if (o.onDone) o.onDone(); })
          .catch(function (e) {
            btn.disabled = false; btn.textContent = 'I have read this';
            var err = el.querySelector('#wib-ack-err');
            err.style.display = 'block'; err.textContent = W.errText(e);
          });
      });
    }).catch(function (e) {
      el.innerHTML = headHtml('Policy') + '<div class="wib-bad">Could not load it: ' +
        W.esc(W.errText(e)) + '</div>' +
        '<div class="wib-foot"><button class="wib-btn" type="button" data-wib-close>Close</button></div>';
      wire(el, o.onDone);
    });
  };

  /* ── login-20261023: a note for my mentor / a practice observation ──────────
     Saved to the apprentice's own staff_reflections, shared with their mentor. A practice observation
     is never attached to a child and never reaches a learning journey — the mentor reads it and
     replies on the pathway. */
  W.openJournal = function (o) {
    var el = sheet(); open();
    var practice = o.kind === 'practice_observation';
    el.innerHTML = headHtml(practice ? 'Practice observation' : 'A note for my mentor',
        practice ? 'Write it as if it were real: what you saw, which area of learning, and a next step. It is not added to any child’s journal.'
                 : 'Something you saw, what you learned, what you would like to try. Your mentor can read this one.') +
      '<input id="wib-j-title" class="wib-in" maxlength="200" placeholder="' + (practice ? 'e.g. Building a tower at the block area' : 'Title (optional)') + '" ' +
        'style="width:100%;box-sizing:border-box;margin:8px 0;padding:10px;border-radius:8px;border:1px solid var(--c-border);background:var(--c-surface);color:var(--c-text);font:inherit">' +
      '<textarea id="wib-j-body" rows="8" maxlength="8000" placeholder="' + (practice ? 'What did the child do and say? What does it tell you? What could come next?' : 'Write your note…') + '" ' +
        'style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid var(--c-border);background:var(--c-surface);color:var(--c-text);font:inherit"></textarea>' +
      '<div class="wib-foot"><button class="wib-btn" type="button" data-wib-close>Cancel</button>' +
        '<button class="wib-btn primary" type="button" id="wib-j-save">Save</button></div>' +
      '<div class="wib-bad" id="wib-j-err" style="display:none"></div>';
    wire(el);
    var btn = el.querySelector('#wib-j-save');
    btn.addEventListener('click', function () {
      var body = el.querySelector('#wib-j-body').value.trim();
      var err = el.querySelector('#wib-j-err');
      if (body.length < 3) { err.style.display = 'block'; err.textContent = 'Write something first.'; return; }
      btn.disabled = true; btn.textContent = 'Saving…';
      Wren.api('/api/induction/assignments/' + o.assignmentId + '/journal', { method: 'POST',
        body: JSON.stringify({ kind: o.kind, title: el.querySelector('#wib-j-title').value.trim(), body: body }) })
        .then(function () { W.close(); if (o.onDone) o.onDone(); })
        .catch(function (e) { btn.disabled = false; btn.textContent = 'Save'; err.style.display = 'block'; err.textContent = W.errText(e); });
    });
  };

  /* ── course: read the sections, then the quiz ───────────────────────────────
     A passing attempt is recorded by the courses engine (POST /attempt); the
     workbook item follows from the auto-complete sync, exactly as a policy does.
     Ported from the copy that was in editions/hr/public/my-induction.html (which
     had in turn been copied from my-cpd.html) so there is now one, not three. */
  W.openCourse = function (o) {
    var el = sheet(); open();
    el.innerHTML = '<div class="wib-centre">Loading course…</div>';
    Wren.api('/api/courses/' + o.courseId).then(function (course) {
      var sections = course.sections || [];
      var questions = course.questions || [];
      var answers = {};

      function bar(n, of) {
        return '<div class="wib-bar"><i style="width:' +
          (of ? Math.round((n / of) * 100) : 0) + '%"></i></div>';
      }

      function section(i) {
        var s = sections[i] || {};
        var last = i === sections.length - 1;
        el.innerHTML = headHtml(course.name, 'Section ' + (i + 1) + ' of ' + sections.length +
            (s.title ? ' · ' + s.title : '')) +
          bar(i + 1, sections.length) +
          '<div class="wib-prose">' + W.esc(s.content_md || s.body || s.content || '') + '</div>' +
          '<div class="wib-foot">' +
            (i > 0 ? '<button class="wib-btn" type="button" id="wib-back">← Back</button>'
                   : '<button class="wib-btn" type="button" data-wib-close>Close</button>') +
            '<button class="wib-btn primary" type="button" id="wib-next">' +
              (last && questions.length ? 'Take the quiz →' : last ? 'Done' : 'Next →') +
            '</button>' +
          '</div>';
        wire(el, o.onDone);
        var back = el.querySelector('#wib-back');
        if (back) back.addEventListener('click', function () { section(i - 1); });
        el.querySelector('#wib-next').addEventListener('click', function () {
          if (last && questions.length) question(0);
          else if (last) { W.close(); if (o.onDone) o.onDone(); }
          else section(i + 1);
        });
      }

      function question(i) {
        var q = questions[i];
        var opts = [['a', q.option_a], ['b', q.option_b], ['c', q.option_c], ['d', q.option_d]]
          .filter(function (p) { return p[1]; });
        var last = i === questions.length - 1;
        el.innerHTML = headHtml('Quiz: ' + course.name, 'Question ' + (i + 1) + ' of ' + questions.length) +
          bar(i + 1, questions.length) +
          '<p class="wib-q">' + W.esc(q.question_text) + '</p>' +
          opts.map(function (p) {
            return '<button class="wib-opt' + (answers[q.id] === p[0] ? ' on' : '') + '" type="button" ' +
              'data-k="' + p[0] + '"><span class="k">' + p[0].toUpperCase() + '</span>' +
              '<span class="t">' + W.esc(p[1]) + '</span></button>';
          }).join('') +
          '<div class="wib-foot">' +
            (i > 0 ? '<button class="wib-btn" type="button" id="wib-back">← Back</button>'
                   : '<button class="wib-btn" type="button" data-wib-close>Close</button>') +
            '<button class="wib-btn primary" type="button" id="wib-next">' +
              (last ? 'Submit' : 'Next →') + '</button>' +
          '</div>';
        wire(el, o.onDone);
        Array.prototype.forEach.call(el.querySelectorAll('.wib-opt'), function (b) {
          b.addEventListener('click', function () {
            Array.prototype.forEach.call(el.querySelectorAll('.wib-opt'), function (x) { x.classList.remove('on'); });
            b.classList.add('on');
            answers[q.id] = b.getAttribute('data-k');
          });
        });
        var back = el.querySelector('#wib-back');
        if (back) back.addEventListener('click', function () { question(i - 1); });
        var next = el.querySelector('#wib-next');
        next.addEventListener('click', function () {
          if (!answers[q.id]) {
            var was = next.textContent;
            next.textContent = 'Pick an answer first';
            setTimeout(function () { next.textContent = was; }, 1400);
            return;
          }
          if (!last) return question(i + 1);
          next.disabled = true; next.textContent = 'Submitting…';
          Wren.api('/api/courses/' + course.id + '/attempt',
            { method: 'POST', body: JSON.stringify({ answers: answers }) })
            .then(function (r) {
              return (r && r.passed ? W.sync(o.assignmentId) : Promise.resolve()).then(function () { return r; });
            })
            .then(function (r) { result(r, course); })
            .catch(function (e) {
              next.disabled = false; next.textContent = 'Submit';
              var bad = document.createElement('div');
              bad.className = 'wib-bad';
              bad.textContent = 'Could not submit: ' + W.errText(e);
              el.appendChild(bad);
            });
        });
      }

      function result(r, c) {
        var passed = !!(r && r.passed);
        el.innerHTML = headHtml(c.name) +
          '<div class="wib-centre">' +
            '<div style="font-size:2.6rem">' + (passed ? '🏅' : '📝') + '</div>' +
            '<div class="wib-score">' + W.esc(String(r && r.score_pct != null ? r.score_pct : '—')) + '%</div>' +
            '<div style="margin-top:8px;color:' + (passed ? 'var(--c-green)' : 'var(--c-amber)') +
              ';font-weight:800">' + (passed ? 'Passed' : 'Not quite yet') + '</div>' +
            '<div style="margin-top:8px">' + (passed
              ? 'This induction item is now marked done.'
              : 'The pass mark is ' + W.esc(String(c.pass_mark_pct || 80)) +
                '% — have another go whenever you like.') + '</div>' +
          '</div>' +
          '<div class="wib-foot">' +
            (passed ? '' : '<button class="wib-btn" type="button" id="wib-retry">Read it again</button>') +
            '<button class="wib-btn primary" type="button" data-wib-close>Done</button>' +
          '</div>';
        wire(el, o.onDone);
        var retry = el.querySelector('#wib-retry');
        if (retry) retry.addEventListener('click', function () {
          answers = {};
          if (sections.length) section(0); else question(0);
        });
      }

      if (sections.length) section(0);
      else if (questions.length) question(0);
      else {
        el.innerHTML = headHtml(course.name) +
          '<div class="wib-centre">There is no content on this course yet — ask your room leader.</div>' +
          '<div class="wib-foot"><button class="wib-btn primary" type="button" data-wib-close>Close</button></div>';
        wire(el, o.onDone);
      }
    }).catch(function (e) {
      el.innerHTML = headHtml('Course') + '<div class="wib-bad">Could not load it: ' +
        W.esc(W.errText(e)) + '</div>' +
        '<div class="wib-foot"><button class="wib-btn" type="button" data-wib-close>Close</button></div>';
      wire(el, o.onDone);
    });
  };

  /* One entry point for "the practitioner tapped this item's action". Keeps the
     course/policy/tick/sign-off branch in exactly one place. Resolves true when
     the caller should reload the workbook. */
  W.act = function (o) {
    // login-20261023 — Apprentice pathway actions.
    if (o.type === 'ready' || o.type === 'not-ready') {
      var on = o.type === 'ready';
      if (!window.confirm(on ? 'Switch observations on for this apprentice?\n\nThey will be able to write observations for children’s learning journeys.'
                             : 'Switch observations off again?')) return Promise.resolve(false);
      return Wren.api('/api/induction/assignments/' + o.assignmentId + '/ready', { method: 'POST', body: JSON.stringify({ ready: on }) })
        .then(function () { return true; });
    }
    if (o.type === 'journal-practice' || o.type === 'journal-note') {
      W.openJournal({ assignmentId: o.assignmentId, kind: o.type === 'journal-practice' ? 'practice_observation' : 'note', onDone: o.onDone });
      return Promise.resolve(false);
    }
    if (o.type === 'course') { W.openCourse({ assignmentId: o.assignmentId, courseId: o.item.course_id, onDone: o.onDone }); return Promise.resolve(false); }
    if (o.type === 'policy') { W.openPolicy({ assignmentId: o.assignmentId, policyId: o.item.policy_id, onDone: o.onDone }); return Promise.resolve(false); }
    var status = o.type === 'signoff' ? 'signed_off' : 'done';
    return W.setStatus(o.assignmentId, o.item, status).then(function (row) {
      // b317 — the moment the teaching happened is the only moment the recording
      // will actually get done. See offerOtj() below.
      return W.offerOtj(row && row.id).then(function () { return true; });
    });
  };

  /* ── b317: "record this as off-the-job training?" ───────────────────────────
     THE WHOLE POINT OF THE BUILD IS HERE, not on the Roost screen.

     Toby: "childcare is so practical, most of it is just staff showing you when
     you're on ratio... So it could just be all of the off-the-job training
     workbooks that they go through and tick that the staff help them with."

     Practical training, shadowing and mentoring ARE eligible off-the-job
     training. What is missing is the record, and a record that has to be made
     later, on a different screen, is a record that does not get made. So the
     offer appears where the teaching just finished: one tap, pre-filled from
     the item, and the minutes and the evidence line editable before it saves.

     It is SILENT unless there is something to offer. The server decides —
     GET /workbook-offer/:progressId answers false for anyone who is not an
     apprentice, for an item marked not eligible (onboarding, paperwork, a
     policy acknowledgement), for an item already recorded, and for anybody not
     entitled to see that training record. This function never guesses at any of
     those; it renders what it is told.

     Resolves when the offer is closed, either way. It NEVER rejects: failing to
     offer must not turn a successful sign-off into an error on the page. */
  W.offerOtj = function (progressId) {
    if (!progressId) return Promise.resolve(false);
    return Wren.api('/api/apprenticeships/workbook-offer/' + progressId)
      .then(function (d) {
        if (!d || !d.offer) return false;
        return showOtjSheet(progressId, d);
      })
      .catch(function () { return false; });   // no offer is not an error
  };

  function showOtjSheet(progressId, d) {
    return new Promise(function (resolve) {
      var el = sheet(); open();
      var pf = d.prefill || {};
      var mins = pf.minutes || 30;

      el.innerHTML =
        headHtml('Record this as off-the-job training?',
                 (d.staff_name || '') + (d.item_title ? ' · ' + d.item_title : '')) +
        '<div class="wib-prose" style="margin-bottom:4px">' +
          'You have just taught something and signed it off. Practical training, shadowing and ' +
          'mentoring all count towards off-the-job hours — provided the learning was <b>new</b> and ' +
          'it is written down. One tap and it is evidence.' +
        '</div>' +
        '<div style="margin:14px 0">' +
          '<label for="otj-mins" style="display:block;font-size:.72rem;font-weight:800;' +
            'letter-spacing:.05em;text-transform:uppercase;color:var(--c-muted);margin-bottom:5px">' +
            'How long did it take?</label>' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
            '<button class="wib-btn" type="button" data-otj-step="-15" aria-label="15 minutes less">−15</button>' +
            '<input id="otj-mins" type="number" min="5" step="5" value="' + mins + '" ' +
              'style="width:92px;text-align:center;background:var(--c-bg);border:1px solid var(--c-border);' +
              'color:var(--c-text);border-radius:10px;padding:10px;font-size:1rem;font-family:inherit;min-height:46px">' +
            '<button class="wib-btn" type="button" data-otj-step="15" aria-label="15 minutes more">+15</button>' +
            '<span style="color:var(--c-muted);font-size:.84rem">minutes</span>' +
          '</div>' +
        '</div>' +
        '<div style="margin:14px 0">' +
          '<label for="otj-new" style="display:block;font-size:.72rem;font-weight:800;' +
            'letter-spacing:.05em;text-transform:uppercase;color:var(--c-muted);margin-bottom:5px">' +
            'What was new for them?</label>' +
          '<textarea id="otj-new" rows="3" style="width:100%;box-sizing:border-box;background:var(--c-bg);' +
            'border:1px solid var(--c-border);color:var(--c-text);border-radius:10px;padding:11px;' +
            'font-size:.92rem;font-family:inherit;line-height:1.5;resize:vertical">' +
            W.esc(pf.what_was_new || '') + '</textarea>' +
          '<div style="font-size:.76rem;color:var(--c-muted);margin-top:6px;line-height:1.5">' +
            'This line is the evidence — say what they could not do before. ' +
            'A progress review, a test, or just doing the job they can already do does not count.' +
          '</div>' +
        '</div>' +
        '<div class="wib-bad" id="otj-err" style="display:none"></div>' +
        '<div class="wib-foot">' +
          '<button class="wib-btn primary" type="button" id="otj-save">Record it</button>' +
          '<button class="wib-btn" type="button" id="otj-skip">Not this one</button>' +
        '</div>';

      var minsEl = el.querySelector('#otj-mins');
      Array.prototype.forEach.call(el.querySelectorAll('[data-otj-step]'), function (b) {
        b.addEventListener('click', function () {
          var next = (parseInt(minsEl.value, 10) || 0) + parseInt(b.dataset.otjStep, 10);
          minsEl.value = Math.max(5, next);
        });
      });

      var done = function (v) { W.close(); resolve(v); };
      el.querySelector('#otj-skip').addEventListener('click', function () { done(false); });
      Array.prototype.forEach.call(el.querySelectorAll('[data-wib-close]'), function (b) {
        b.addEventListener('click', function () { done(false); });
      });

      el.querySelector('#otj-save').addEventListener('click', function () {
        var btn = this;
        var err = el.querySelector('#otj-err');
        err.style.display = 'none';
        btn.disabled = true;
        Wren.api('/api/apprenticeships/workbook-offer/' + progressId, {
          method: 'POST',
          body: JSON.stringify({
            minutes: parseInt(minsEl.value, 10) || 0,
            what_was_new: el.querySelector('#otj-new').value,
          }),
        }).then(function () { done(true); })
          .catch(function (e) {
            // The API's refusal explains itself — show it rather than a generic
            // failure. (Wren.api rejects with the BODY, not an Error.)
            err.textContent = W.errText(e, 'Could not record it.');
            err.style.display = '';
            btn.disabled = false;
          });
      });
    });
  }
}());
