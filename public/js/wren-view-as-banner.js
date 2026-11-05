/* ─────────────────────────────────────────────────────────────────────────────
 * b320 — the "view as" banner.
 *
 * Injected server-side into every text/html response on Finch (parents) and
 * Seed (HR) while a view-as session is open — see the injector in
 * editions/ladn/server-unified.js. It is NOT referenced by any HTML file,
 * deliberately: eighty pages across two portals is eighty chances to miss one,
 * and the page that gets missed is the page where a manager forgets they are
 * not themselves.
 *
 * What it is and is not:
 *   IS   — the reminder. Undismissable, always on top, counting down.
 *   IS NOT — the control. Read-only is enforced on the server, in
 *            src/lib/view-as.js, ahead of every route. If this script never
 *            loaded, nothing could still be written.
 *
 * Colours: this bar declares its own three, once, rather than reading the
 * theme. --c-red resolves to a pale #f87171 on dark themes, which is the wrong
 * thing for white text on a warning bar, and Finch's pages do not load
 * wren-theme.js at all so the tokens are simply absent there. A warning that
 * renders differently depending on where it lands is a warning you cannot rely
 * on; this one reads the same everywhere. Same reasoning, same treatment as the
 * device-blocked bar in wren-core.js.
 * ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.__wrenViewAs) return;
  window.__wrenViewAs = { active: false };

  var BAR_ID = 'wren-view-as-bar';
  var CSS =
    '#' + BAR_ID + '{' +
      '--wva-bg:#7c2d12;--wva-fg:#fff8f2;--wva-chip:rgba(255,255,255,.16);' +
      'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
      'background:var(--wva-bg);color:var(--wva-fg);' +
      'font:600 14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;' +
      'padding:9px 14px;display:flex;gap:12px;align-items:center;justify-content:center;' +
      'flex-wrap:wrap;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,.3);' +
      'letter-spacing:.01em}' +
    '#' + BAR_ID + ' .wva-chip{background:var(--wva-chip);border-radius:999px;' +
      'padding:2px 10px;font-weight:700;white-space:nowrap}' +
    '#' + BAR_ID + ' .wva-sub{font-weight:400;opacity:.85;white-space:nowrap}' +
    '#' + BAR_ID + ' button{background:var(--wva-fg);color:var(--wva-bg);border:0;' +
      'border-radius:8px;padding:6px 14px;font:700 13px/1 system-ui,sans-serif;' +
      'cursor:pointer;white-space:nowrap}' +
    '#' + BAR_ID + ' button:hover{opacity:.88}' +
    '#wren-view-as-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:24px;' +
      'z-index:2147483647;background:#7c2d12;color:#fff8f2;border-radius:10px;' +
      'padding:11px 16px;font:600 14px/1.4 system-ui,sans-serif;max-width:90vw;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.34)}';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function firstName(s) {
    s = String(s || '').trim();
    if (!s) return 'this person';
    if (s.indexOf('@') > -1) return s.split('@')[0];
    return s.split(/\s+/)[0];
  }

  function minutesLeft(iso) {
    if (!iso) return null;
    var ms = new Date(iso).getTime() - Date.now();
    if (!isFinite(ms)) return null;
    return Math.max(0, Math.ceil(ms / 60000));
  }

  var state = null, bar = null, timer = null;

  function build() {
    var style = document.getElementById('wren-view-as-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'wren-view-as-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-live', 'polite');
    document.body.appendChild(bar);
    paint();
    pad();

    // Undismissable in the only sense that matters here: if anything removes it
    // — a page script rewriting document.body, a stray innerHTML — it comes
    // straight back.
    try {
      new MutationObserver(function () {
        if (!document.getElementById(BAR_ID) && document.body) {
          document.body.appendChild(bar);
          pad();
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* observer is a nicety, not the control */ }
  }

  function paint() {
    var mins = minutesLeft(state.expires_at);
    var who = esc(firstName(state.subject_label));
    var left = mins == null ? '' :
      (mins <= 0 ? '<span class="wva-sub">session over</span>'
                 : '<span class="wva-sub">' + mins + ' min' + (mins === 1 ? '' : 's') + ' left</span>');
    bar.innerHTML =
      '<span>👁️ Viewing as <span class="wva-chip">' + who + '</span> — <b>read only</b></span>' +
      left +
      '<button type="button" id="wva-exit">Exit</button>';
    var btn = document.getElementById('wva-exit');
    if (btn) btn.addEventListener('click', exit);
    if (mins === 0) ended();
  }

  function pad() {
    try {
      var h = bar.offsetHeight || 40;
      if (!document.body.dataset.wvaPad) {
        document.body.dataset.wvaPad = String(parseInt(getComputedStyle(document.body).paddingTop, 10) || 0);
      }
      document.body.style.paddingTop = (Number(document.body.dataset.wvaPad) + h) + 'px';
    } catch (e) { /* layout only */ }
  }

  function ended() {
    if (timer) { clearInterval(timer); timer = null; }
    bar.innerHTML =
      '<span>👁️ This view-as session has ended.</span>' +
      '<button type="button" id="wva-close">Close</button>';
    var b = document.getElementById('wva-close');
    if (b) b.addEventListener('click', function () { window.close(); location.replace('about:blank'); });
  }

  function exit() {
    fetch('/api/view-as/exit', { method: 'POST', credentials: 'include' })
      .catch(function () { /* the cookie is cleared either way on the server */ })
      .then(function () {
        try { sessionStorage.removeItem('wrenToken'); sessionStorage.removeItem('wrenUser'); } catch (e) {}
        window.close();               // works when Roost opened this tab
        location.replace('about:blank');
      });
  }

  function toast(msg) {
    var t = document.getElementById('wren-view-as-toast');
    if (t) t.remove();
    t = document.createElement('div');
    t.id = 'wren-view-as-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.remove(); }, 5000);
  }

  // A refused write must say so. Without this the page simply does nothing when
  // a manager taps Send, which reads as a bug rather than as the rule working.
  function hookFetch() {
    if (!window.fetch || window.__wrenViewAsFetch) return;
    window.__wrenViewAsFetch = true;
    var orig = window.fetch;
    window.fetch = function () {
      return orig.apply(this, arguments).then(function (r) {
        if (r && r.status === 403) {
          var c = r.clone();
          c.json().then(function (d) {
            if (d && d.error === 'view_as_read_only') {
              toast('Read only — you are viewing ' + firstName(state && state.subject_label) + '’s account, so nothing can be saved or sent.');
            }
          }).catch(function () {});
        } else if (r && r.status === 401) {
          var c2 = r.clone();
          c2.json().then(function (d) {
            if (d && d.error === 'view_as_ended' && bar) ended();
          }).catch(function () {});
        }
        return r;
      });
    };
  }

  function start(d) {
    state = d;
    window.__wrenViewAs = { active: true, subject_label: d.subject_label, expires_at: d.expires_at };
    var go = function () { build(); hookFetch(); timer = setInterval(paint, 30000); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
    else go();
  }

  fetch('/api/view-as/session', { credentials: 'include' })
    .then(function (r) { return r.json(); })
    .then(function (d) { if (d && d.active) start(d); })
    .catch(function () { /* no session, nothing to show */ });
})();
