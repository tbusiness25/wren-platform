// Wren feedback widget (2026-07-09) — floating 🐞 button on every portal.
// Staff/parents pick bug / idea / works / feedback, describe it, optionally
// attach a screenshot and DRAW on it (red pen) to say "this should move here".
// Submits to /api/feedback, which drops a card on the manager's cockpit kanban.
//
// Token sources (in order): explicit WrenFeedback.init({token}), Wren.getToken()
// (shell-v2 portals), sessionStorage wrenToken. Never renders inside iframes.
;(function () {
  'use strict';
  if (window.self !== window.top) return;
  if (window.__wrenFeedbackLoaded) return;
  window.__wrenFeedbackLoaded = true;

  // b395 — the last 20 console errors since this widget loaded, for the weekly
  // fixer. window.onerror/console.error TEXT only, never a form field — this
  // runs before the panel exists and has nothing to do with what anyone typed.
  const _consoleErrors = [];
  function _pushConsoleErr(msg) {
    try {
      _consoleErrors.push(String(msg).slice(0, 500));
      if (_consoleErrors.length > 20) _consoleErrors.shift();
    } catch (e) {}
  }
  window.addEventListener('error', e => _pushConsoleErr((e && e.message) || 'error'));
  window.addEventListener('unhandledrejection', e => {
    const reason = e && e.reason;
    _pushConsoleErr('unhandledrejection: ' + ((reason && reason.message) || reason));
  });
  const _origConsoleError = console.error.bind(console);
  console.error = function (...args) {
    try { _pushConsoleErr(args.map(a => (a && a.message) || String(a)).join(' ')); } catch (e) {}
    return _origConsoleError(...args);
  };

  let _token = null;
  // b395 (D12): Roost and HR carry the same wren-edition meta as EY, and every one of them used to
  // report as 'ey' — so a Roost or HR report could not be told apart in reports_inbox. Say which it is.
  let _portal = (function () {
    var m = document.querySelector('meta[name="wren-edition"]');
    if (m) return m.content === 'admin' ? 'admin' : /^(ladn-)?hr$/.test(m.content || '') ? 'hr' : 'ey';
    return (document.body && document.body.dataset.portal) || 'unknown';
  })();
  function token() {
    if (_token) return _token;
    try { if (window.Wren && Wren.getToken) return Wren.getToken(); } catch (e) {}
    try { return sessionStorage.getItem('wrenToken'); } catch (e) { return null; }
  }

  // 2026-10-20 (fix-feedback-voice): every request this widget makes must carry
  // X-Wren-Device as well as the bearer token. With EY device enforcement on, the
  // gate in server-unified.js 403s ANY /api call from a tablet without it — and
  // this widget built an Authorization-only header, so every report sent from an
  // enrolled EY tablet since 2026-07-27 came back "Could not send: device_required"
  // (prod nginx: 3 of 3 POST /api/feedback in the last 6 days = 403, all from
  // /ey/more). b495 swept ~30 raw fetches for this and missed this file.
  function headers(extra) {
    var h = {};
    var t = token();
    if (t) h.Authorization = 'Bearer ' + t;
    try { var d = localStorage.getItem('wrenDevice'); if (d) h['X-Wren-Device'] = d; } catch (e) {}
    return Object.assign(h, extra || {});
  }

  // A screenshot is sent as a base64 data URL inside the JSON body. nginx gives the
  // HR and parents portals the 1 MB default client_max_body_size (Roost 6m, EY 16m),
  // so a phone photo that is fine on a tablet 413s on a phone before Wren sees it.
  // Keep the picture comfortably under that: recompress, then shrink, until it fits.
  var SHOT_MAX_CHARS = 700 * 1024;
  function shotForUpload() {
    if (!(shotDataUrl && canvas)) return null;
    var src = canvas, q = 0.85, url = src.toDataURL('image/jpeg', q);
    var guard = 0;
    while (url.length > SHOT_MAX_CHARS && guard++ < 8) {
      if (q > 0.55) { q = Math.round((q - 0.15) * 100) / 100; }
      else {
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(src.width * 0.75));
        c.height = Math.max(1, Math.round(src.height * 0.75));
        c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
        src = c;
      }
      url = src.toDataURL('image/jpeg', q);
    }
    return url.length > SHOT_MAX_CHARS ? null : url;
  }

  // Turn a failed response into words a practitioner can act on.
  function failureText(status, body) {
    var code = body && body.error;
    if (code === 'device_required') return 'this tablet is not enrolled with Wren any more. Ask Toby to re-enrol it (Roost → Security → Devices).';
    if (status === 413) return 'the picture was too big to send. Try again without the screenshot.';
    if (status === 401) return 'you have been signed out. Sign in again and resend.';
    return (body && (body.message || body.error)) || ('error ' + status);
  }

  const KINDS = [['bug', '🐞 Bug'], ['idea', '💡 Idea'], ['works', '✅ Works well'], ['feedback', '💬 Feedback']];
  let panel = null, kind = 'bug', shotDataUrl = null, drawing = false, ctx2d = null, canvas = null;

  function css() {
    if (document.getElementById('wfb-css')) return;
    const s = document.createElement('style');
    s.id = 'wfb-css';
    s.textContent = `
#wfb-btn{position:fixed;bottom:150px;right:22px;z-index:9000;width:44px;height:44px;border-radius:50%;
  border:none;background:#e07820;color:#fff;font-size:1.2rem;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35)}
#wfb-panel{position:fixed;bottom:120px;right:20px;z-index:9001;width:min(400px,calc(100vw - 32px));
  background:#0f172a;color:#f1f5f9;border:1px solid #334155;border-radius:16px;padding:16px;
  box-shadow:0 10px 40px rgba(0,0,0,.5);max-height:80vh;overflow-y:auto}
#wfb-panel h3{margin:0 0 10px;font-size:1rem;display:flex;align-items:center;justify-content:space-between;gap:8px}
#wfb-close{background:transparent;border:none;color:#94a3b8;font-size:1.3rem;line-height:1;cursor:pointer;padding:4px 6px;border-radius:8px}
#wfb-close:hover{color:#f1f5f9;background:#1e293b}
.wfb-kinds{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.wfb-kind{padding:7px 11px;border-radius:999px;border:1px solid #334155;background:transparent;color:#cbd5e1;
  cursor:pointer;font-size:.8rem}
.wfb-kind.on{background:#e07820;border-color:#e07820;color:#fff}
.wfb-in{width:100%;background:#080f1e;border:1px solid #334155;border-radius:10px;color:#f1f5f9;
  padding:10px;margin-bottom:8px;font-family:inherit;font-size:.9rem}
.wfb-row{display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.wfb-ghost{padding:9px 13px;border-radius:10px;border:1px solid #334155;background:transparent;color:#cbd5e1;
  cursor:pointer;font-size:.82rem}
#wfb-canvas-wrap{display:none;margin-bottom:8px;border:1px solid #334155;border-radius:10px;overflow:hidden}
#wfb-canvas{width:100%;display:block;touch-action:none;cursor:crosshair}
#wfb-submit{width:100%;padding:12px;border-radius:10px;border:none;background:#e07820;color:#fff;
  font-weight:700;cursor:pointer;font-size:.95rem}
.wfb-note{font-size:.72rem;color:#64748b;margin:6px 0 0;text-align:center}`;
    document.head.appendChild(s);
  }

  // ── b360 (2026-09-29) — "Take a picture of this page" ───────────────────────
  // Toby: "Maybe add a screenshot button." This is the one that matters most,
  // because it is the button you press WHILE looking at the thing that is wrong,
  // so there is no "go and find it again to photograph it" step.
  //
  // /js/wren-page-shot.js is lazy-loaded the first time it is pressed — the
  // widget is on every page of four portals and most reports never attach a
  // picture, so it is not worth a second script tag everywhere.
  //
  // Captures straight into the SAME canvas the file upload uses, so the red-pen
  // annotation below works on a captured page exactly as on an uploaded photo.
  function loadPageShot() {
    return new Promise(function (resolve, reject) {
      function go() {
        if (!window.WrenPageShot || !WrenPageShot.supported()) {
          return reject(new Error('this browser cannot photograph itself'));
        }
        WrenPageShot.capture().then(function (dataUrl) {
          var img = new Image();
          img.onload = function () {
            canvas = document.getElementById('wfb-canvas');
            if (!canvas) return reject(new Error('panel closed'));
            var scale = Math.min(1, 1200 / img.width);
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            ctx2d = canvas.getContext('2d');
            ctx2d.drawImage(img, 0, 0, canvas.width, canvas.height);
            ctx2d.strokeStyle = '#ff2222'; ctx2d.lineWidth = 4; ctx2d.lineCap = 'round';  // colour-ok: annotation ink, must stay red on any theme
            document.getElementById('wfb-canvas-wrap').style.display = 'block';
            document.getElementById('wfb-clear').style.display = 'none';   // nothing to redo from
            shotDataUrl = 'pending';
            resolve();
          };
          img.onerror = function () { reject(new Error('could not read the picture')); };
          img.src = dataUrl;
        }).catch(reject);
      }
      if (window.WrenPageShot) return go();
      var s = document.createElement('script');
      s.src = '/js/wren-page-shot.js?v=b360';
      s.onload = go;
      s.onerror = function () { reject(new Error('could not load the screenshot tool')); };
      document.head.appendChild(s);
    });
  }

  function loadShot(file) {
    const img = new Image();
    img.onload = () => {
      canvas = document.getElementById('wfb-canvas');
      const maxW = 1200;
      const scale = Math.min(1, maxW / img.width);
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      ctx2d = canvas.getContext('2d');
      ctx2d.drawImage(img, 0, 0, canvas.width, canvas.height);
      ctx2d.strokeStyle = '#ff2222'; ctx2d.lineWidth = 4; ctx2d.lineCap = 'round';
      document.getElementById('wfb-canvas-wrap').style.display = 'block';
      document.getElementById('wfb-clear').style.display = '';
      shotDataUrl = 'pending';
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  }

  function pos(e) {
    const r = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return [(t.clientX - r.left) * canvas.width / r.width, (t.clientY - r.top) * canvas.height / r.height];
  }

  function wireCanvas() {
    const wrap = document.getElementById('wfb-canvas-wrap');
    wrap.addEventListener('mousedown', start); wrap.addEventListener('touchstart', start, { passive: false });
    wrap.addEventListener('mousemove', move);  wrap.addEventListener('touchmove', move, { passive: false });
    ['mouseup', 'mouseleave', 'touchend'].forEach(ev => wrap.addEventListener(ev, () => { drawing = false; }));
    function start(e) { if (!ctx2d) return; e.preventDefault(); drawing = true; const [x, y] = pos(e); ctx2d.beginPath(); ctx2d.moveTo(x, y); }
    function move(e) { if (!drawing || !ctx2d) return; e.preventDefault(); const [x, y] = pos(e); ctx2d.lineTo(x, y); ctx2d.stroke(); }
  }

  async function submit() {
    const title = document.getElementById('wfb-title').value.trim();
    const body = document.getElementById('wfb-body').value.trim();
    if (!title) { alert('Give it a one-line title'); return; }
    const btn = document.getElementById('wfb-submit');
    btn.disabled = true; btn.textContent = 'Sending…';
    // b395 — diagnostics for the weekly fixer. app_build is best-effort: a
    // failed /api/build must never block sending the words someone typed.
    let appBuild = null;
    try {
      const b = await fetch('/api/build', { headers: headers() }).then(r => r.json());
      appBuild = (b && (b.build || b.commit)) || null;
    } catch (e) {}
    const payload = {
      kind, title, body,
      portal: _portal,
      page_path: location.pathname + (location.hash || ''),
      screenshot: shotForUpload(),
      user_agent: navigator.userAgent,
      viewport: window.innerWidth + 'x' + window.innerHeight,
      app_build: appBuild,
      console_errors: _consoleErrors.slice(),
    };
    try {
      const r = await fetch('/api/feedback', {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(failureText(r.status, await r.json().catch(() => ({}))));
      // b395 (D12): the weekly-release promise (updates go live early Friday morning, 00:00 — the weekly bug
      // release). 2026-10-17: staff can follow it — Staff Feedback lists their reports with how far each has got.
      panel.innerHTML = '<h3>🙌 Thank you!</h3><p style="font-size:.85rem;color:#94a3b8">Thanks — we fix reported problems every week; updates go live early Friday morning (00:00).'
        + (location.pathname.indexOf('/ey') === 0 ? ' See where it is up to in <a href="/ey/staff-feedback" style="color:inherit;text-decoration:underline">Staff Feedback</a>.' : '')
        + '</p>';
      setTimeout(close, 2600);
    } catch (e) {
      alert('Could not send: ' + e.message);
      btn.disabled = false; btn.textContent = 'Send';
    }
  }

  function close() { if (panel) { panel.remove(); panel = null; } shotDataUrl = null; ctx2d = null; document.removeEventListener('keydown', escToClose); }

  function open() {
    if (panel) { close(); return; }
    if (!token()) { alert('Log in first to send feedback.'); return; }
    kind = 'bug';
    panel = document.createElement('div');
    panel.id = 'wfb-panel';
    // b360 — keep the panel out of its own screenshot. wren-page-shot.js drops
    // anything carrying data-no-capture from the clone before it renders.
    panel.setAttribute('data-no-capture', '');
    panel.innerHTML = `
      <h3>Tell Toby what's up <button id="wfb-close" type="button" aria-label="Close">✕</button></h3>
      <div class="wfb-kinds">${KINDS.map(([k, l]) => `<button class="wfb-kind${k === 'bug' ? ' on' : ''}" data-k="${k}">${l}</button>`).join('')}</div>
      <input class="wfb-in" id="wfb-title" maxlength="200" placeholder="One line — what happened / what should change?">
      <textarea class="wfb-in" id="wfb-body" rows="3" placeholder="Details (optional) — what did you expect, what would be better?"></textarea>
      <div class="wfb-row">
        <button class="wfb-ghost" id="wfb-capture">📸 Picture of this page</button>
        <label class="wfb-ghost" style="cursor:pointer">📷 Attach screenshot<input type="file" id="wfb-file" accept="image/*" style="display:none"></label>
        <button class="wfb-ghost" id="wfb-clear" style="display:none">↺ Redo drawing</button>
      </div>
      <div id="wfb-canvas-wrap"><canvas id="wfb-canvas"></canvas></div>
      <button id="wfb-submit">Send</button>
      <div class="wfb-note">Attach a screenshot then draw on it in red — circle things, point where stuff should move.</div>`;
    document.body.appendChild(panel);
    document.getElementById('wfb-close').addEventListener('click', close);
    document.addEventListener('keydown', escToClose);
    panel.querySelectorAll('.wfb-kind').forEach(b => b.addEventListener('click', () => {
      kind = b.dataset.k;
      panel.querySelectorAll('.wfb-kind').forEach(x => x.classList.toggle('on', x === b));
    }));
    let lastFile = null;
    document.getElementById('wfb-file').addEventListener('change', e => { if (e.target.files[0]) { lastFile = e.target.files[0]; loadShot(lastFile); } });
    document.getElementById('wfb-clear').addEventListener('click', () => { if (lastFile) loadShot(lastFile); });
    // b360 — capture the page behind the panel.
    document.getElementById('wfb-capture').addEventListener('click', function () {
      const b = this;
      const was = b.textContent;
      b.disabled = true; b.textContent = 'Taking it…';
      loadPageShot()
        .then(() => { lastFile = null; b.textContent = '✓ Picture added'; })
        .catch((e) => {
          b.textContent = was;
          alert('Could not photograph this page (' + (e && e.message ? e.message : 'unknown') +
                '). Use "Attach screenshot" instead.');
        })
        .then(() => { b.disabled = false; });
    });
    document.getElementById('wfb-submit').addEventListener('click', submit);
    wireCanvas();
  }

  function escToClose(e) { if (e.key === 'Escape') close(); }

  let _explicitPortal = false;

  // Draggable + hideable (2026-07-10): the 🐞 was pinned and overlapped other
  // FABs with no way to move or dismiss it. Now: drag to reposition (persists),
  // and it can be hidden until next login. A tap that isn't a drag opens it.
  function makeDraggable(b) {
    try {
      const saved = JSON.parse(localStorage.getItem('wfbPos') || 'null');
      if (saved && typeof saved.top === 'number') { b.style.top = saved.top + 'px'; b.style.bottom = 'auto'; b.style.right = 'auto'; b.style.left = saved.left + 'px'; }
    } catch (e) {}
    let sx, sy, ox, oy, moved = false, dragging = false;
    function down(e) {
      const t = e.touches ? e.touches[0] : e;
      dragging = true; moved = false;
      sx = t.clientX; sy = t.clientY;
      const r = b.getBoundingClientRect(); ox = r.left; oy = r.top;
      document.addEventListener('mousemove', move); document.addEventListener('touchmove', move, { passive: false });
      document.addEventListener('mouseup', up); document.addEventListener('touchend', up);
    }
    function move(e) {
      if (!dragging) return;
      const t = e.touches ? e.touches[0] : e;
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 6) { moved = true; e.preventDefault && e.preventDefault(); }
      let nl = Math.max(4, Math.min(window.innerWidth - 48, ox + dx));
      let nt = Math.max(4, Math.min(window.innerHeight - 48, oy + dy));
      b.style.left = nl + 'px'; b.style.top = nt + 'px'; b.style.right = 'auto'; b.style.bottom = 'auto';
    }
    function up() {
      dragging = false;
      document.removeEventListener('mousemove', move); document.removeEventListener('touchmove', move);
      document.removeEventListener('mouseup', up); document.removeEventListener('touchend', up);
      if (moved) { try { localStorage.setItem('wfbPos', JSON.stringify({ top: parseInt(b.style.top), left: parseInt(b.style.left) })); } catch (e) {} }
    }
    b.addEventListener('mousedown', down);
    b.addEventListener('touchstart', down, { passive: true });
    // Click opens only if it wasn't a drag.
    b.addEventListener('click', function (e) { if (moved) { e.stopImmediatePropagation(); moved = false; return; } open(); });
    // Long-press / right-click hides it until next login.
    b.addEventListener('contextmenu', function (e) { e.preventDefault(); hideBtn(); });
    let lpTimer = null;
    b.addEventListener('touchstart', () => { lpTimer = setTimeout(hideBtn, 650); }, { passive: true });
    b.addEventListener('touchend', () => clearTimeout(lpTimer));
    b.addEventListener('touchmove', () => clearTimeout(lpTimer));
  }
  function hideBtn() {
    const b = document.getElementById('wfb-btn');
    if (b) b.remove();
    try { sessionStorage.setItem('wfbHidden', '1'); } catch (e) {}
  }

  // LADN hosts hide the floating 🐞 by default (2026-07-15, Toby) — it lives in
  // EY → More instead. Demo hosts (*.getwren.co.uk) keep it visible.
  // b395 (2026-10-05) — Roost is the exception: Toby wants it visible there by
  // default too, same as the demo hosts, since he is the one testing most.
  // HR/EY/parents are unchanged by this — they keep the menu-item entry point.
  const _onRoost = (document.querySelector('meta[name="wren-edition"]') || {}).content === 'admin';
  const DEFAULT_FAB_HIDDEN = !_onRoost && !/\.getwren\.co\.uk$/i.test(location.hostname);

  // parentsapp-20261023 (Toby: "I don't want the little floating ladybird anymore, I just want the dedicated section in settings"):
  // the parents app NEVER draws the floating 🐞, whatever a stored preference says. "Report a bug" stays in the parents app's
  // More → Help & tools (pwa.js openFeedback → WrenFeedback.open(), which needs no button). Staff portals are unchanged.
  function _isParentsApp() {
    return _portal === 'parents' || /^parents\./i.test(location.hostname) || /^\/welcome(\/|$)/.test(location.pathname)
      || (document.querySelector('meta[name="wren-edition"]') || {}).content === 'parents';
  }

  function boot() {
    if (document.getElementById('wfb-btn')) return;
    if (_isParentsApp()) return;
    try { if (sessionStorage.getItem('wfbHidden') === '1') return; } catch (e) {}
    try {
      const pref = localStorage.getItem('wfbFab');
      if (pref === 'hide') return;
      if (DEFAULT_FAB_HIDDEN && pref !== 'show') return;
    } catch (e) {}
    if (!_explicitPortal && window.Wren && Wren.edition) _portal = Wren.edition;
    css();
    const b = document.createElement('button');
    b.id = 'wfb-btn';
    b.title = 'Report a bug / send feedback — drag to move, long-press to hide';
    b.setAttribute('aria-label', 'Report a bug or send feedback');
    b.setAttribute('data-no-capture', '');   // b360 — keep the 🐞 out of its own screenshot
    b.textContent = '🐞';
    document.body.appendChild(b);
    makeDraggable(b);
  }

  window.WrenFeedback = {
    init(opts) {
      opts = opts || {};
      if (opts.token) _token = opts.token;
      if (opts.portal) { _portal = opts.portal; _explicitPortal = true; }
      boot();
    },
    // Open the feedback panel directly (EY → More), without needing the floating 🐞.
    open() {
      if (!_explicitPortal && window.Wren && Wren.edition) _portal = Wren.edition;
      css();
      open();
    },
    setFabVisible(v) {
      try { localStorage.setItem('wfbFab', v ? 'show' : 'hide'); } catch (e) {}
      if (v) { try { sessionStorage.removeItem('wfbHidden'); } catch (e) {} boot(); }   // boot() still refuses on the parents app
      else hideBtn();
    },
    isFabHidden() {
      try {
        if (sessionStorage.getItem('wfbHidden') === '1') return true;
        const pref = localStorage.getItem('wfbFab');
        return pref === 'hide' || (pref == null && DEFAULT_FAB_HIDDEN);
      } catch (e) { return false; }
    },
  };

  // Auto-boot on shell-v2 portals (they set Wren.getToken); parents portal calls
  // WrenFeedback.init({token, portal}) explicitly after login instead.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { if (window.Wren) boot(); });
  } else if (window.Wren) {
    boot();
  }
})();
