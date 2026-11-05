/* wren-report-evidence.js — b528 (2026-10-26)
 *
 * "Whenever they're doing reports they should be able to see the data that
 * they're writing about." — Toby, 2026-10-26.
 *
 * A collapsible "What we know about this child" panel that sits ABOVE the text
 * boxes on a report-writing screen: the child's framework tracking in the prime
 * areas, the statements actually judged (with dates), their open next steps, the
 * last few observations with photo thumbnails, and their age and room. Every
 * item has an INSERT button that drops a short reference into whichever text box
 * the practitioner was last typing in.
 *
 * Reusable on purpose. It knows nothing about the two-year check: it takes a
 * child id and an onInsert callback, and the server half
 * (src/routes/report-evidence.js) decides what counts as evidence for a scope.
 *
 *   WrenReportEvidence.mount(hostElement, {
 *     childId: 123,
 *     scope: 'two_year_check',      // optional, server default
 *     obs: 5,                       // optional, 1..10 recent observations
 *     open: false,                  // start expanded?
 *     storageKey: 'wren.tyc.evidence', // optional: remember open/closed
 *     onInsert: function (text) { ... }  // REQUIRED for the insert buttons to show
 *   });
 *
 * ── TWO THINGS THIS FILE IS CAREFUL ABOUT ───────────────────────────────────
 *
 * 1. LOAD ORDER. Every Wren page loads wren-core.js and wren-app-shell.js with
 *    `defer`, and the shell fires `wren:ready` SYNCHRONOUSLY during its own
 *    deferred execution. A script listed after the shell therefore misses it
 *    (b527: "Starting Ask Wren…" forever, no console error). This file does not
 *    listen for wren:ready at all — the page calls mount() when it is ready —
 *    but it MUST still be listed BEFORE wren-app-shell.js in the HTML so that
 *    `WrenReportEvidence` exists by the time a page's own wren:ready handler
 *    runs. See the memory reference_parse_time_wren_user_is_always_empty.
 *
 * 2. THE DEVICE GATE. On EY, media paths come back signed by the response
 *    signer, but an <img src> cannot send the x-wren-device header the gate
 *    wants, so the enrolled-device token is appended as ?dev= — the same
 *    _attUrl() the observation viewer uses. Without it the thumbnails 403.
 */
(function (window, document) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }

  function niceDate(v) {
    if (!v) return '';
    var d = new Date(v);
    return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /* The enrolled-device token, for <img>/<video> that cannot send the header. */
  function attUrl(p) {
    if (!p) return p;
    try {
      var d = localStorage.getItem('wrenDevice') || '';
      return d ? (p + (p.indexOf('?') === -1 ? '?' : '&') + 'dev=' + encodeURIComponent(d)) : p;
    } catch (e) { return p; }
  }

  function isVideo(u) { return /\.(mp4|webm|mov|m4v|3gp|mkv)(\?|$)/i.test(String(u).split('?')[0]); }

  /* Wren.api when the shell is present, plain fetch when it is not (so the
     panel also works on a page that has not booted the app shell). */
  function api(path) {
    if (window.Wren && typeof Wren.api === 'function') return Wren.api(path);
    return fetch(path, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw j && j.error ? j : new Error('HTTP ' + r.status); });
      return r.json();
    });
  }

  var CSS_ID = 'wren-report-evidence-css';
  /* Tokens only — no colour literal anywhere (LADN-DESIGN-GUIDELINES colour
     rule / scripts/b351-colour-audit.js). Works on the Roost/EY dark shell and
     the light one without a second palette. */
  var CSS = [
    '.wre{border:1px solid var(--c-border);border-radius:14px;background:var(--c-surface);overflow:hidden}',
    '.wre summary{cursor:pointer;padding:12px 14px;font-weight:700;color:var(--c-text);font-size:.95rem;',
    '  display:flex;align-items:center;gap:8px;min-height:44px;list-style:none}',
    '.wre summary::-webkit-details-marker{display:none}',
    '.wre summary .wre-chev{margin-left:auto;color:var(--c-muted);font-size:.8rem;font-weight:600}',
    '.wre[open] summary{border-bottom:1px solid var(--c-border)}',
    '.wre-body{padding:12px 14px;display:flex;flex-direction:column;gap:14px}',
    '.wre-sub{color:var(--c-muted);font-size:.8rem}',
    '.wre-grp{display:flex;flex-direction:column;gap:6px}',
    '.wre-grp > h4{margin:0;font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:var(--c-muted)}',
    '.wre-item{display:flex;gap:8px;align-items:flex-start;border:1px solid var(--c-border);border-radius:10px;',
    '  padding:8px 10px;background:var(--c-bg)}',
    '.wre-item .wre-txt{flex:1;min-width:0;font-size:.85rem;color:var(--c-text);line-height:1.45}',
    '.wre-item .wre-meta{display:block;color:var(--c-muted);font-size:.75rem;margin-top:2px}',
    '.wre-ins{flex:0 0 auto;border:1px solid var(--c-border);background:transparent;color:var(--c-blue);',
    '  border-radius:8px;padding:6px 10px;font-size:.78rem;font-weight:700;cursor:pointer;min-height:36px;font-family:inherit}',
    '.wre-ins:hover{border-color:var(--c-blue)}',
    '.wre-ins:disabled{opacity:.5;cursor:default}',
    '.wre-pill{display:inline-block;border-radius:999px;padding:2px 8px;font-size:.7rem;font-weight:700;',
    '  border:1px solid var(--c-border);color:var(--c-muted);margin-right:4px}',
    '.wre-pill.judge{color:var(--c-ok);border-color:var(--c-ok)}',
    '.wre-pill.soft{color:var(--c-muted)}',
    '.wre-pill.none{color:var(--c-warn);border-color:var(--c-warn)}',
    '.wre-none{background:color-mix(in srgb, var(--c-warn) 14%, transparent);border:1px solid var(--c-border);',
    '  border-radius:10px;padding:10px 12px;font-size:.84rem;color:var(--c-text)}',
    '.wre-photos{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}',
    '.wre-photos img,.wre-photos video{width:64px;height:64px;object-fit:cover;border-radius:8px;',
    '  border:1px solid var(--c-border);cursor:pointer;background:var(--c-surface-2,var(--c-surface))}',
    '.wre-err{color:var(--c-danger);font-size:.85rem}',
    '@media (max-width:420px){.wre-item{flex-direction:column}.wre-ins{align-self:flex-start}}'
  ].join('\n');

  function ensureCss() {
    if (document.getElementById(CSS_ID)) return;
    var st = document.createElement('style');
    st.id = CSS_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* ── The one-line reference an insert drops into the text box ─────────────
     Short on purpose. The practitioner is writing prose for a parent; what
     helps is the fact and its date, not a citation they then have to delete.
     b243's own citation checker only recognises [OBS-12]-shaped refs, so an
     inserted ref stays traceable through the draft without inventing a new
     format. */
  function obsRef(o) {
    var bits = [];
    if (o.date) bits.push(niceDate(o.date));
    var t = (o.excerpt || o.title || '').trim();
    if (t.length > 160) t = t.slice(0, 157).replace(/\s+\S*$/, '') + '…';
    return (bits.length ? bits.join(' ') + ' — ' : '') + t + ' [' + o.ref + ']';
  }
  function trkRef(j) {
    return j.statement + ' (' + j.status_label + (j.date ? ', ' + niceDate(j.date) : '') + ') [' + j.ref + ']';
  }
  function nsRef(n) {
    return 'Next step: ' + n.description + (n.created ? ' (set ' + niceDate(n.created) + ')' : '') + ' [' + n.ref + ']';
  }

  function itemHtml(text, meta, insertText, canInsert) {
    return '<div class="wre-item">' +
      '<span class="wre-txt">' + text + (meta ? '<span class="wre-meta">' + meta + '</span>' : '') + '</span>' +
      (canInsert ? '<button type="button" class="wre-ins" data-ins="' + esc(insertText) + '">Insert</button>' : '') +
      '</div>';
  }

  function render(host, data, opts) {
    var canInsert = typeof opts.onInsert === 'function';
    var c = data.child || {};
    var parts = [];

    /* Who, how old, which room — the brief's "age in months and the room". */
    var head = [];
    if (c.age_months != null) head.push(c.age_months + ' months old');
    if (c.room_name) head.push(esc(c.room_name));
    if (data.key_person && data.key_person.name) head.push('key person ' + esc(data.key_person.name));
    if (c.corrected_age_label) head.push('corrected age ' + esc(c.corrected_age_label));
    if (c.send_needs) head.push('SEND support recorded');
    parts.push('<div class="wre-sub">' + head.join(' · ') +
      (data.window && data.window.from ? ' · records from ' + esc(niceDate(data.window.from)) : '') + '</div>');

    /* ── Tracking, honestly ────────────────────────────────────────────────
       tracking.recorded is false when every tracker cell is the b25m import
       default. Saying "no tracking recorded yet" is the whole point: a wall of
       'observed' read as achievement is how a made-up developmental claim gets
       written about a real child. */
    var tr = data.tracking || {};
    if (!tr.recorded) {
      parts.push('<div class="wre-grp"><h4>Framework tracking</h4>' +
        '<div class="wre-none">No tracking recorded yet.' +
        (tr.note ? ' ' + esc(tr.note) : '') + '</div></div>');
    }
    (tr.areas || []).forEach(function (a) {
      var rows = [];
      (a.judgements || []).forEach(function (j) {
        rows.push(itemHtml(
          '<span class="wre-pill judge">' + esc(j.status_label) + '</span>' + esc(j.statement),
          [j.aspect, j.age_range, j.date ? niceDate(j.date) : null].filter(Boolean).map(esc).join(' · '),
          trkRef(j), canInsert));
      });
      var flags = [];
      if (a.evidence_only) {
        flags.push('<span class="wre-pill soft">' + a.evidence_only +
          ' statement' + (a.evidence_only === 1 ? '' : 's') + ' with evidence but no judgement</span>');
      }
      if (a.not_met) flags.push('<span class="wre-pill soft">' + a.not_met + ' not yet</span>');
      if (!a.judgements.length) {
        flags.push('<span class="wre-pill none">nothing judged in this area</span>');
      }
      if (a.sufficiency && a.sufficiency.sufficient === false) {
        flags.push('<span class="wre-pill none">not enough to write from</span>');
      }
      parts.push('<div class="wre-grp"><h4>' + esc(a.heading) + '</h4>' +
        '<div class="wre-sub">' + esc(a.plain) + ' · ' + a.observation_count +
          ' observation' + (a.observation_count === 1 ? '' : 's') + '</div>' +
        (flags.length ? '<div>' + flags.join('') + '</div>' : '') +
        rows.join('') +
        ((a.not_met_examples || []).length
          ? '<div class="wre-sub">Not yet seen: ' + a.not_met_examples.map(esc).join('; ') + '</div>'
          : '') +
        '</div>');
    });

    /* ── Open next steps ──────────────────────────────────────────────────── */
    var ns = data.open_next_steps || [];
    parts.push('<div class="wre-grp"><h4>Open next steps</h4>' +
      (ns.length
        ? ns.map(function (n) {
            return itemHtml(esc(n.description),
              [n.area, n.created ? 'set ' + niceDate(n.created) : null, n.due_by ? 'due ' + niceDate(n.due_by) : null]
                .filter(Boolean).map(esc).join(' · '),
              nsRef(n), canInsert);
          }).join('')
        : '<div class="wre-sub">None open.</div>') +
      '</div>');

    /* ── Recent observations, with thumbnails ─────────────────────────────── */
    var obs = data.observations || [];
    parts.push('<div class="wre-grp"><h4>Recent observations</h4>' +
      (obs.length
        ? obs.map(function (o) {
            var photos = (o.photos || []).map(function (u) {
              var su = attUrl(u);
              return isVideo(u)
                ? '<video src="' + esc(su) + '" muted playsinline preload="metadata" data-photo="' + esc(su) + '"></video>'
                : '<img src="' + esc(su) + '" alt="" loading="lazy" data-photo="' + esc(su) + '">';
            }).join('');
            return '<div class="wre-item">' +
              '<span class="wre-txt">' +
                (o.title ? '<b>' + esc(o.title) + '</b><br>' : '') +
                esc(o.excerpt) + (o.truncated ? '…' : '') +
                (o.analysis ? '<span class="wre-meta">Analysis: ' + esc(o.analysis) + '</span>' : '') +
                '<span class="wre-meta">' + esc(niceDate(o.date)) +
                  ((o.areas || []).length ? ' · ' + o.areas.map(esc).join(', ') : '') +
                  (o.author ? ' · ' + esc(o.author) : '') +
                  ' · <a href="' + esc(o.link) + '">open</a></span>' +
                (photos ? '<span class="wre-photos">' + photos + '</span>' : '') +
              '</span>' +
              (canInsert ? '<button type="button" class="wre-ins" data-ins="' + esc(obsRef(o)) + '">Insert</button>' : '') +
              '</div>';
          }).join('')
        : '<div class="wre-sub">No observations recorded in this window.</div>') +
      '</div>');

    /* ── How they learn (COEL), when any is tracked ───────────────────────── */
    var coel = data.coel || [];
    if (coel.length) {
      parts.push('<div class="wre-grp"><h4>How they learn</h4>' +
        coel.map(function (k) {
          return itemHtml(esc(k.statement),
            [k.characteristic, k.status, k.assessed ? niceDate(k.assessed) : null].filter(Boolean).map(esc).join(' · '),
            k.statement + ' (' + k.status + ') [' + k.ref + ']', canInsert);
        }).join('') + '</div>');
    }

    host.querySelector('.wre-body').innerHTML = parts.join('');
    var sum = host.querySelector('.wre-count');
    if (sum) {
      var n = (data.counts || {});
      sum.textContent = '· ' + (n.observations || 0) + ' obs · ' +
        (tr.judgement_count || 0) + ' judged · ' + ns.length + ' next step' + (ns.length === 1 ? '' : 's');
    }
  }

  function mount(host, opts) {
    if (!host) return null;
    opts = opts || {};
    ensureCss();

    var openDefault = !!opts.open;
    if (opts.storageKey) {
      try {
        var v = localStorage.getItem(opts.storageKey);
        if (v === '1') openDefault = true;
        else if (v === '0') openDefault = false;
      } catch (e) { /* private mode: the default stands */ }
    }

    host.innerHTML = '';
    var det = document.createElement('details');
    det.className = 'wre';
    if (openDefault) det.open = true;
    det.innerHTML =
      '<summary>📋 What we know about ' + esc((opts.childName || 'this child')) +
        ' <span class="wre-count wre-sub"></span><span class="wre-chev">tap to open</span></summary>' +
      '<div class="wre-body"><div class="wre-sub">Loading their records…</div></div>';
    host.appendChild(det);

    var chev = det.querySelector('.wre-chev');
    function syncChev() { if (chev) chev.textContent = det.open ? 'tap to close' : 'tap to open'; }
    syncChev();
    det.addEventListener('toggle', function () {
      syncChev();
      if (!opts.storageKey) return;
      try { localStorage.setItem(opts.storageKey, det.open ? '1' : '0'); } catch (e) {}
    });

    /* Insert → the page decides where it lands (the focused text box). */
    det.addEventListener('click', function (e) {
      var ph = e.target.closest ? e.target.closest('[data-photo]') : null;
      if (ph) {
        if (typeof opts.onPhoto === 'function') opts.onPhoto(ph.getAttribute('data-photo'));
        else window.open(ph.getAttribute('data-photo'), '_blank', 'noopener');
        return;
      }
      var btn = e.target.closest ? e.target.closest('[data-ins]') : null;
      if (!btn) return;
      e.preventDefault();
      if (typeof opts.onInsert !== 'function') return;
      var ok = opts.onInsert(btn.getAttribute('data-ins'));
      if (ok === false) return;
      var was = btn.textContent;
      btn.textContent = 'Inserted';
      btn.disabled = true;
      setTimeout(function () { btn.textContent = was; btn.disabled = false; }, 1400);
    });

    var qs = [];
    if (opts.scope) qs.push('scope=' + encodeURIComponent(opts.scope));
    if (opts.obs) qs.push('obs=' + encodeURIComponent(opts.obs));
    var url = '/api/report-evidence/child/' + encodeURIComponent(opts.childId) +
      (qs.length ? '?' + qs.join('&') : '');

    var inst = { el: det, data: null, reload: function () { return load(); } };

    function load() {
      return api(url).then(function (data) {
        inst.data = data;
        if (data.child && data.child.known_as) {
          var s = det.querySelector('summary');
          if (s) s.firstChild.textContent = '📋 What we know about ' + data.child.known_as + ' ';
        }
        render(det, data, opts);
        return data;
      }).catch(function (err) {
        var body = det.querySelector('.wre-body');
        var msg = (err && (err.error || err.message)) || 'Could not load this child\'s records.';
        body.innerHTML = '<div class="wre-err">' + esc(msg) + '</div>';
      });
    }

    load();
    return inst;
  }

  window.WrenReportEvidence = { mount: mount, attUrl: attUrl };
}(window, document));
