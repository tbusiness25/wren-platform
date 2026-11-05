/* wren-ask.js — b527 (2026-10-26). The "Ask Wren" chat panel.
 *
 * ONE renderer, two surfaces: editions/ladn/public/ey/ask-wren.html (the room
 * tablets) and editions/hr/public/ask-wren.html (staff phones). Both pages are
 * nothing but a <div id="aw-root"> and this file — there is no second copy of
 * the panel, per memory feedback_one_place_one_version.
 *
 * ── THE CONVERSATION LIVES IN THE BROWSER AND NOWHERE ELSE ───────────────────
 * v1 keeps no server-side transcript. The thread is held in a module-local array
 * and in sessionStorage (so a tap through to a linked page and back does not
 * lose it), and sessionStorage dies with the tab — which on a shared room tablet
 * is the point. The server stores an audit row per question (who, which tools,
 * how many records, how long) and the question text only when it names nobody.
 * Nothing here ever writes the ANSWER anywhere.
 *
 * ── Wren.user AT CALL TIME, NEVER AT PARSE TIME ──────────────────────────────
 * Every read of Wren.user in this file is inside a function. A top-level
 * `const ROLE = Wren.user.role` would be '' for everybody, because wren-core.js
 * and the shell load with `defer` and so run AFTER the document is parsed
 * (memory reference_parse_time_wren_user_is_always_empty — it cost b521 a whole
 * "permission check broken for the owner" bug). The role comes from the server's
 * /status response anyway, which is the only version of it that decides anything.
 *
 * ── STREAMING ────────────────────────────────────────────────────────────────
 * POST /api/ask-wren/ask streams plain text (chunked, not SSE — the same shape
 * as /api/assistant/chat and /api/away-assistant/ask). The meta — which tools
 * ran, the citations, the links, a proposed suggestion — arrives in the
 * X-Ask-Meta-B64 response header BEFORE the first byte of the body, so the
 * footer is built from what the server retrieved and never from what the model
 * wrote. Wren.api() cannot stream, so this uses fetch() with
 * Wren.authHeaders(), which is the one place the Authorization and
 * X-Wren-Device headers are built (b495).
 */
(function () {
  'use strict';

  var API = '/api/ask-wren';
  var STORE = 'wrenAskThread';
  var MAX_KEEP = 12;                 // messages kept in the browser

  var state = { status: null, thread: [], busy: false, pending: null };

  // ── tiny helpers ──────────────────────────────────────────────────────────
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * The answers are markdown-ish: **bold**, *italic*, `code`, [text](/path),
   * bullets, numbered lists, paragraphs. Everything is escaped FIRST and only
   * these forms are then un-escaped, so a model (or a nursery record quoted by
   * one) cannot inject markup. A link is only rendered when its href is a
   * same-origin path or an http(s) URL — never javascript:, never data:.
   */
  function md(src) {
    var t = esc(src);
    t = t.replace(/`([^`]+)`/g, function (_, c) { return '<code>' + c + '</code>'; });
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, label, href) {
      if (/^\//.test(href)) return '<a href="' + href + '">' + label + '</a>';
      if (/^https?:\/\//i.test(href)) return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
      return label;
    });
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

    var out = [], list = null;
    t.split('\n').forEach(function (raw) {
      var line = raw.trim();
      var ul = /^[-•]\s+(.*)$/.exec(line);
      var ol = /^(\d+)[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        var want = ul ? 'ul' : 'ol';
        if (list !== want) { if (list) out.push('</' + list + '>'); out.push('<' + want + '>'); list = want; }
        out.push('<li>' + (ul ? ul[1] : ol[2]) + '</li>');
        return;
      }
      if (list) { out.push('</' + list + '>'); list = null; }
      if (line) out.push('<p>' + line + '</p>');
    });
    if (list) out.push('</' + list + '>');
    return out.join('');
  }

  function save() {
    try { sessionStorage.setItem(STORE, JSON.stringify(state.thread.slice(-MAX_KEEP))); }
    catch (_) { /* private window / full quota — the panel still works */ }
  }
  function restore() {
    try {
      var raw = sessionStorage.getItem(STORE);
      if (raw) state.thread = JSON.parse(raw) || [];
    } catch (_) { state.thread = []; }
    if (!Array.isArray(state.thread)) state.thread = [];
  }

  // ── render ────────────────────────────────────────────────────────────────
  function footer(meta) {
    if (!meta) return '';
    var rows = [];
    if (meta.citations && meta.citations.length) {
      rows.push('<div class="aw-foot-row"><span class="aw-foot-label">Source</span><br>' +
        meta.citations.map(function (c) {
          return c.url
            ? '<a class="aw-chip" href="' + esc(c.url) + '"' +
              (/^https?:/i.test(c.url) ? ' target="_blank" rel="noopener noreferrer"' : '') + '>' + esc(c.label) + '</a>'
            : '<span class="aw-chip is-plain">' + esc(c.label) + '</span>';
        }).join('') + '</div>');
    }
    if (meta.links && meta.links.length) {
      rows.push('<div class="aw-foot-row"><span class="aw-foot-label">Open</span><br>' +
        meta.links.map(function (l) {
          return '<a class="aw-chip" href="' + esc(l.url) + '">' + esc(l.label) + '</a>';
        }).join('') + '</div>');
    }
    // What it actually looked at, and whether anything refused. Shown because an
    // answer you cannot audit is an answer you cannot trust — and because a
    // refusal is a real part of the answer, not an error.
    var bits = [];
    if (meta.tools && meta.tools.length) bits.push('looked at ' + meta.tools.length + ' place' + (meta.tools.length === 1 ? '' : 's') + ' in Wren');
    if (meta.records) bits.push(meta.records + ' record' + (meta.records === 1 ? '' : 's'));
    if (meta.refusals) bits.push(meta.refusals + ' refused (you do not have access)');
    if (meta.ms) bits.push((meta.ms / 1000).toFixed(1) + 's');
    if (bits.length) rows.push('<div class="aw-foot-row">' + esc(bits.join(' · ')) + '</div>');
    return rows.length ? '<div class="aw-foot">' + rows.join('') + '</div>' : '';
  }

  function suggestBlock(p) {
    if (!p) return '';
    return '<div class="aw-suggest" data-aw-suggest="1">' +
      '<h4>' + (p.kind === 'works' ? 'Send this to Toby as something good you saw?' : 'Send this to Toby as a suggestion?') + '</h4>' +
      '<div class="aw-s-title">' + esc(p.title) + '</div>' +
      '<div class="aw-s-body">' + esc(p.body) + '</div>' +
      '<div class="aw-suggest-actions">' +
        '<button type="button" class="aw-btn is-warm" data-aw-send-suggestion="1">Send it to Toby</button>' +
        '<button type="button" class="aw-btn" data-aw-drop-suggestion="1">No, don\'t send</button>' +
      '</div></div>';
  }

  function render() {
    var thread = el('aw-thread');
    if (!thread) return;
    var html = state.thread.map(function (m) {
      if (m.who === 'me') return '<div class="aw-msg is-me">' + md(m.text) + '</div>';
      var cls = 'aw-msg is-wren' + (m.safeguarding ? ' is-safeguarding' : '') + (m.error ? ' is-error' : '');
      return '<div class="' + cls + '">' + md(m.text) + footer(m.meta) + suggestBlock(m.pending) + '</div>';
    }).join('');
    if (state.busy) {
      html += '<div class="aw-busy"><span class="aw-spin" aria-hidden="true"></span>' +
        '<span>' + esc(state.busyLabel || 'Looking it up in Wren…') + '</span></div>';
    }
    thread.innerHTML = html;
    var starters = el('aw-starters');
    if (starters) starters.hidden = state.thread.length > 0;
    var clear = el('aw-clear');
    if (clear) clear.hidden = state.thread.length === 0;
    thread.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }

  function say(who, text, extra) {
    state.thread.push(Object.assign({ who: who, text: text }, extra || {}));
    if (state.thread.length > MAX_KEEP) state.thread = state.thread.slice(-MAX_KEEP);
    save();
    render();
  }

  // ── ask ───────────────────────────────────────────────────────────────────
  function readMeta(res) {
    var b64 = res.headers.get('X-Ask-Meta-B64');
    if (!b64) return null;
    try { return JSON.parse(decodeURIComponent(escape(atob(b64)))); }
    catch (_) { try { return JSON.parse(atob(b64)); } catch (__) { return null; } }
  }

  function ask(question) {
    if (state.busy) return;
    var q = String(question || '').trim();
    if (!q) return;
    say('me', q);
    state.busy = true;
    state.busyLabel = 'Looking it up in Wren…';
    render();

    fetch(API + '/ask', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, Wren.authHeaders()),
      body: JSON.stringify({ question: q }),
    }).then(function (res) {
      var meta = readMeta(res);
      if (res.status === 401) { Wren.logout(); return; }
      if (!res.ok) {
        return res.text().then(function (t) {
          var msg = 'Wren could not answer that just now.';
          try { var j = JSON.parse(t); if (j && j.message) msg = j.message; } catch (_) {}
          if (res.status === 403 && /device/i.test(t)) {
            msg = 'This tablet is not set up for Wren, so I cannot look anything up on it. A manager needs to enrol it.';
          }
          state.busy = false;
          say('wren', msg, { error: true });
        });
      }
      if (meta && meta.tools && meta.tools.length) {
        state.busyLabel = 'Reading ' + meta.tools.length + ' thing' + (meta.tools.length === 1 ? '' : 's') + ' from Wren…';
        render();
      }
      // Stream the body into the last bubble as it arrives.
      state.busy = false;
      var idx = state.thread.push({
        who: 'wren', text: '', meta: meta,
        safeguarding: !!(meta && meta.safeguarding),
        pending: (meta && meta.pending_suggestion) || null,
      }) - 1;
      render();

      if (!res.body || !res.body.getReader) {
        return res.text().then(function (t) { state.thread[idx].text = t; save(); render(); });
      }
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      return (function pump() {
        return reader.read().then(function (r) {
          if (r.done) { save(); render(); return; }
          state.thread[idx].text += dec.decode(r.value, { stream: true });
          render();
          return pump();
        });
      })();
    }).catch(function (e) {
      state.busy = false;
      say('wren', 'I could not reach Wren just then (' + esc(e && e.message ? e.message : 'connection lost') +
        '). Nothing was sent anywhere — try again in a moment.', { error: true });
    });
  }

  // ── the one write, on the person's own tap ────────────────────────────────
  function sendSuggestion(btn) {
    var msg = null;
    for (var i = state.thread.length - 1; i >= 0; i--) { if (state.thread[i].pending) { msg = state.thread[i]; break; } }
    if (!msg) return;
    btn.disabled = true;
    btn.textContent = 'Sending…';
    Wren.api(API + '/suggest', {
      method: 'POST',
      body: { confirm: true, title: msg.pending.title, body: msg.pending.body, kind: msg.pending.kind },
    }).then(function () {
      msg.pending = null;
      save();
      say('wren', '**Sent.** It is on Toby\'s board now. Thank you — this is how Wren gets better.');
    }).catch(function (d) {
      btn.disabled = false;
      btn.textContent = 'Send it to Toby';
      Wren.toast((d && d.message) || 'That could not be sent. Nothing was filed.', 'error');
    });
  }

  function dropSuggestion() {
    for (var i = state.thread.length - 1; i >= 0; i--) {
      if (state.thread[i].pending) { state.thread[i].pending = null; break; }
    }
    save();
    say('wren', 'Nothing sent. Say the word if you change your mind.');
  }

  // ── boot ──────────────────────────────────────────────────────────────────
  function paint(status) {
    var root = el('aw-root');
    if (!root) return;
    var dot = status && status.reachable ? 'is-up' : 'is-down';
    var modelLine = status && status.model
      ? 'Your Nursery\' own server · ' + status.model + (status.reachable ? '' : ' · not responding')
      : 'the nursery\'s own server';
    root.innerHTML =
      '<div class="aw-top">' +
        '<span class="aw-dot ' + dot + '" aria-hidden="true"></span>' +
        '<span class="aw-local"><strong>Runs on Your Nursery\' own server</strong> — nothing you type here leaves the building.</span>' +
        '<span class="aw-model">' + esc(modelLine) + '</span>' +
      '</div>' +
      '<p class="aw-intro" id="aw-intro">Ask me about <strong>the children</strong>, <strong>their development</strong>, ' +
        '<strong>the day</strong>, <strong>the EYFS</strong>, <strong>our policies</strong> or <strong>how to do something in Wren</strong>. ' +
        'I can only see what you can see in Wren, and I will say so when I do not know.</p>' +
      '<div class="aw-actions">' +
        '<button type="button" class="aw-btn" id="aw-suggest-btn">💡 Suggest a change</button>' +
        '<button type="button" class="aw-btn" id="aw-clear" hidden>Start again</button>' +
      '</div>' +
      '<div class="aw-starters" id="aw-starters"></div>' +
      '<div class="aw-thread" id="aw-thread" aria-live="polite"></div>' +
      '<form class="aw-composer" id="aw-form">' +
        '<label class="aw-sr-only" for="aw-input">Your question</label>' +
        '<textarea class="aw-input" id="aw-input" rows="1" ' +
          'placeholder="Ask about a child, the day, the EYFS, or how to do something…" ' +
          'autocomplete="off" enterkeyhint="send"></textarea>' +
        '<button type="submit" class="aw-btn is-primary aw-send" id="aw-send">Ask</button>' +
      '</form>';

    var starters = el('aw-starters');
    starters.innerHTML = ((status && status.starters) || []).map(function (s) {
      return '<button type="button" class="aw-starter" data-aw-starter="' + esc(s) + '">' + esc(s) + '</button>';
    }).join('');

    el('aw-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = el('aw-input');
      var q = input.value;
      input.value = '';
      input.style.height = '';
      ask(q);
    });
    var input = el('aw-input');
    input.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 140) + 'px';
    });
    input.addEventListener('keydown', function (e) {
      // Enter sends, Shift+Enter is a new line — the shape every phone keyboard
      // already expects. On a tablet the on-screen Return key is "send" too
      // (enterkeyhint), which is why the composer has no separate newline button.
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el('aw-form').requestSubmit(); }
    });

    el('aw-suggest-btn').addEventListener('click', function () {
      el('aw-input').value = 'I would like to suggest a change to Wren: ';
      el('aw-input').focus();
    });
    el('aw-clear').addEventListener('click', function () {
      state.thread = [];
      try { sessionStorage.removeItem(STORE); } catch (_) {}
      render();
    });

    // Delegated, because the thread is re-rendered on every chunk.
    el('aw-root').addEventListener('click', function (e) {
      var s = e.target.closest('[data-aw-starter]');
      if (s) { ask(s.getAttribute('data-aw-starter')); return; }
      if (e.target.closest('[data-aw-send-suggestion]')) { sendSuggestion(e.target.closest('button')); return; }
      if (e.target.closest('[data-aw-drop-suggestion]')) { dropSuggestion(); return; }
    });

    restore();
    render();

    if (status && !status.available) {
      say('wren', (status.error || 'Ask Wren is not available on this edition.'), { error: true });
    }
  }

  /**
   * The floating Ask button, on the EY home and room screens.
   *
   * SAME FILE as the panel on purpose: a second script for one button is a
   * second place the destination can be wrong. If the page has an #aw-root it
   * IS the Ask page and gets the panel; otherwise it gets the button. The button
   * is never drawn on the Ask page (nothing points at where you already are),
   * never on a portal the route refuses, and never until /status says the
   * assistant is available — a button that opens a page saying "not available"
   * is worse than no button.
   *
   * It sits ABOVE the fixed bottom tab bar (see .aw-fab in wren-ask.css), so it
   * covers no tab and no content, and it is a link, not a dialog: the panel is a
   * page, with a back button, which is what a tablet wants.
   */
  function fab(status) {
    if (!status || !status.available) return;
    if (document.getElementById('aw-fab')) return;
    var a = document.createElement('a');
    a.id = 'aw-fab';
    a.className = 'aw-fab';
    a.href = '/ey/ask-wren';
    a.setAttribute('aria-label', 'Ask Wren a question');
    a.innerHTML = '<span class="aw-fab-ico" aria-hidden="true">✨</span><span class="aw-fab-label">Ask Wren</span>';
    document.body.appendChild(a);
  }

  function boot() {
    var isPanel = !!el('aw-root');
    if (!isPanel) {
      // The button only needs to know whether the feature is on, so this is the
      // same one request — no second endpoint, no duplicate status logic.
      Wren.api(API + '/status').then(fab).catch(function () { /* no button, no noise */ });
      return;
    }
    Wren.api(API + '/status').then(function (s) {
      state.status = s;
      paint(s);
    }).catch(function (d) {
      // A 503 body still carries the reason (and the privacy line), so paint it.
      state.status = d && d.portal ? d : null;
      paint(state.status || { available: false, error: (d && d.message) || 'Ask Wren could not be reached.', starters: [] });
    });
  }

  // ── BOOTING, AND THE TRAP b525 DOCUMENTED ────────────────────────────────
  // ABSOLUTE RULE 7: never call boot() straight from a script tag — the shell
  // fires wren:ready at the end of buildShell(), and a page that calls an API
  // before that never loads its data.
  //
  // But wren-app-shell.js fires wren:ready SYNCHRONOUSLY during its own
  // deferred execution, so a script listed after it in the document adds its
  // listener to an event that has already been and gone. Measured, not
  // theorised: the first cut of this file sat on "Starting Ask Wren…" forever,
  // on all eight role x viewport combinations, with no console error and with
  // Wren, WrenAsk and the shell's own chrome all present. Exactly b525's trap,
  // from the other direction.
  //
  // So: register the listener (the normal path — the ask pages load this file
  // BEFORE the shell), and if the shell's chrome is already on the page then
  // the event has fired and we boot now. Guarded, so it happens once. This is
  // not jumping the gun — the chrome existing IS the shell being ready, which
  // is the thing the rule is about.
  var booted = false;
  function bootOnce() {
    if (booted) return;
    booted = true;
    boot();
  }
  document.addEventListener('wren:ready', bootOnce);
  function shellIsUp() {
    return !!(document.getElementById('wren-app-bottom')
      || document.getElementById('wren-topbar')
      || document.querySelector('[data-wren-shell]'));
  }
  if (shellIsUp()) bootOnce();
  else if (document.readyState === 'complete' || document.readyState === 'interactive') {
    // The document is parsed and the shell has not announced itself yet. Give
    // it a tick, then boot anyway rather than leave a spinner on a tablet.
    setTimeout(function () { if (shellIsUp() || !booted) bootOnce(); }, 1200);
  } else {
    window.addEventListener('load', function () { setTimeout(bootOnce, 600); });
  }

  window.WrenAsk = { ask: ask, md: md };     // for the b527 browser check
}());
