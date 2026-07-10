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

  let _token = null;
  let _portal = (document.querySelector('meta[name="wren-edition"]') && 'ey') || (document.body && document.body.dataset.portal) || 'unknown';
  function token() {
    if (_token) return _token;
    try { if (window.Wren && Wren.getToken) return Wren.getToken(); } catch (e) {}
    try { return sessionStorage.getItem('wrenToken'); } catch (e) { return null; }
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
#wfb-panel h3{margin:0 0 10px;font-size:1rem}
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
    const payload = {
      kind, title, body,
      portal: _portal,
      page_path: location.pathname + (location.hash || ''),
      screenshot: (shotDataUrl && canvas) ? canvas.toDataURL('image/jpeg', 0.85) : null,
    };
    try {
      const r = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
      panel.innerHTML = '<h3>🙌 Thank you!</h3><p style="font-size:.85rem;color:#94a3b8">Sent to the manager\'s board.</p>';
      setTimeout(close, 1600);
    } catch (e) {
      alert('Could not send: ' + e.message);
      btn.disabled = false; btn.textContent = 'Send';
    }
  }

  function close() { if (panel) { panel.remove(); panel = null; } shotDataUrl = null; ctx2d = null; }

  function open() {
    if (panel) { close(); return; }
    if (!token()) { alert('Log in first to send feedback.'); return; }
    kind = 'bug';
    panel = document.createElement('div');
    panel.id = 'wfb-panel';
    panel.innerHTML = `
      <h3>Tell Toby what's up</h3>
      <div class="wfb-kinds">${KINDS.map(([k, l]) => `<button class="wfb-kind${k === 'bug' ? ' on' : ''}" data-k="${k}">${l}</button>`).join('')}</div>
      <input class="wfb-in" id="wfb-title" maxlength="200" placeholder="One line — what happened / what should change?">
      <textarea class="wfb-in" id="wfb-body" rows="3" placeholder="Details (optional) — what did you expect, what would be better?"></textarea>
      <div class="wfb-row">
        <label class="wfb-ghost" style="cursor:pointer">📷 Attach screenshot<input type="file" id="wfb-file" accept="image/*" style="display:none"></label>
        <button class="wfb-ghost" id="wfb-clear" style="display:none">↺ Redo drawing</button>
      </div>
      <div id="wfb-canvas-wrap"><canvas id="wfb-canvas"></canvas></div>
      <button id="wfb-submit">Send</button>
      <div class="wfb-note">Attach a screenshot then draw on it in red — circle things, point where stuff should move.</div>`;
    document.body.appendChild(panel);
    panel.querySelectorAll('.wfb-kind').forEach(b => b.addEventListener('click', () => {
      kind = b.dataset.k;
      panel.querySelectorAll('.wfb-kind').forEach(x => x.classList.toggle('on', x === b));
    }));
    let lastFile = null;
    document.getElementById('wfb-file').addEventListener('change', e => { if (e.target.files[0]) { lastFile = e.target.files[0]; loadShot(lastFile); } });
    document.getElementById('wfb-clear').addEventListener('click', () => { if (lastFile) loadShot(lastFile); });
    document.getElementById('wfb-submit').addEventListener('click', submit);
    wireCanvas();
  }

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

  function boot() {
    if (document.getElementById('wfb-btn')) return;
    try { if (sessionStorage.getItem('wfbHidden') === '1') return; } catch (e) {}
    if (!_explicitPortal && window.Wren && Wren.edition) _portal = Wren.edition;
    css();
    const b = document.createElement('button');
    b.id = 'wfb-btn';
    b.title = 'Report a bug / send feedback — drag to move, long-press to hide';
    b.setAttribute('aria-label', 'Report a bug or send feedback');
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
  };

  // Auto-boot on shell-v2 portals (they set Wren.getToken); parents portal calls
  // WrenFeedback.init({token, portal}) explicitly after login instead.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { if (window.Wren) boot(); });
  } else if (window.Wren) {
    boot();
  }
})();
