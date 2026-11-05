// Parent app feedback widget (b129, 2026-07-21) — "a feedback button right
// inside the app", as promised in the Summer newsletter. Distinct from the
// staff bug-tracker widget (wren-feedback.js, 🐞 "Tell Toby what's up") —
// warmer copy, a parent-relevant category set (like/change/idea/bug/other),
// and it's reached from the parents "More" sheet (pwa.js), not a floating FAB
// — the parents portal deliberately moved away from hovering FABs in favour
// of the More-sheet "Help & tools" grid (see pwa.js comment, 2026-07-hover-fix).
//
// Mints its own token on open via /api/auth/cf-auto-login (credentials:'include')
// — each welcome/*.html page keeps its own in-memory token, nothing global to
// borrow from the shared pwa.js shell, so this widget is fully self-sufficient.
;(function () {
  'use strict';
  if (window.__wrenPAFLoaded) return;
  window.__wrenPAFLoaded = true;

  const CATS = [
    ['like',   '💚 Something I like'],
    ['change', '🔧 Something to change'],
    ['idea',   '💡 An idea'],
    ['bug',    "🐞 Something's broken"],
    ['other',  '💬 Other'],
  ];
  let panel = null, cat = 'idea', _token = null, _child = null;

  function css() {
    if (document.getElementById('paf-css')) return;
    const s = document.createElement('style');
    s.id = 'paf-css';
    s.textContent = `
#paf-panel{position:fixed;inset:0;z-index:9500;display:flex;align-items:flex-end;justify-content:center;
  background:rgba(20,30,25,.5)}
#paf-card{width:100%;max-width:480px;background:#fefcf8;color:#2a2a2a;border-radius:18px 18px 0 0;
  padding:18px 20px calc(22px + env(safe-area-inset-bottom,0px));max-height:88vh;overflow-y:auto;
  box-shadow:0 -6px 30px rgba(0,0,0,.3);font-family:Nunito,system-ui,sans-serif}
@media(min-width:560px){#paf-panel{align-items:center}#paf-card{border-radius:18px;max-height:80vh}}
#paf-card h3{margin:0 0 4px;font:700 1.15rem/1.2 "Crimson Pro",Georgia,serif;color:#2d5a4a}
.paf-sub{color:#6b7a72;font-size:.85rem;margin:0 0 14px}
#paf-close{position:absolute;top:14px;right:14px;background:transparent;border:0;font-size:1.4rem;
  color:#8a8a8a;cursor:pointer;line-height:1;padding:4px}
.paf-cats{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:12px}
.paf-cat{padding:8px 12px;border-radius:999px;border:1px solid #e0dcd0;background:#fff;color:#4a4a4a;
  cursor:pointer;font-size:.8rem;font-family:inherit}
.paf-cat.on{background:#2d5a4a;border-color:#2d5a4a;color:#fff;font-weight:700}
.paf-in{width:100%;box-sizing:border-box;background:#fff;border:1px solid #e0dcd0;border-radius:10px;
  color:#2a2a2a;padding:11px;margin-bottom:10px;font-family:inherit;font-size:.92rem}
#paf-submit{width:100%;padding:13px;border-radius:10px;border:none;background:#2d5a4a;color:#fff;
  font-weight:700;cursor:pointer;font-size:.98rem;min-height:44px}
#paf-submit:disabled{opacity:.6}
.paf-note{font-size:.75rem;color:#8a8a8a;margin:8px 0 0;text-align:center}
.paf-thanks{text-align:center;padding:20px 0}
.paf-thanks .paf-big{font-size:2.2rem;margin-bottom:8px}`;
    document.head.appendChild(s);
  }

  function pagePath() { return location.pathname + (location.hash || ''); }

  async function ensureToken() {
    if (_token) return _token;
    try {
      const r = await fetch('/api/auth/cf-auto-login', { credentials: 'include' });
      if (!r.ok) return null;
      const d = await r.json();
      _token = d.token || null;
      _child = d.child || null;
      return _token;
    } catch (e) { return null; }
  }

  function close() { if (panel) { panel.remove(); panel = null; } }

  async function submit() {
    const body = document.getElementById('paf-body').value.trim();
    if (!body) { document.getElementById('paf-body').focus(); return; }
    const btn = document.getElementById('paf-submit');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const token = await ensureToken();
      if (!token) throw new Error('Could not sign you in');
      const r = await fetch('/api/parent-app-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          category: cat, body,
          page_context: pagePath(),
          child_id: _child ? _child.id : null,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
      const card = document.getElementById('paf-card');
      card.innerHTML = '<div class="paf-thanks"><div class="paf-big">🙌</div>' +
        '<h3>Thank you!</h3><p class="paf-sub">This app is built for you — we\'ve had your note, and it\'s straight on the team\'s to-do list.</p></div>';
      setTimeout(close, 1800);
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Send';
      alert('Could not send right now: ' + e.message);
    }
  }

  function open() {
    if (panel) return;
    css();
    cat = 'idea';
    panel = document.createElement('div');
    panel.id = 'paf-panel';
    panel.innerHTML = `
      <div id="paf-card" role="dialog" aria-label="Tell us what to change">
        <button id="paf-close" type="button" aria-label="Close">✕</button>
        <h3>Tell us what to change</h3>
        <p class="paf-sub">This app is built for you — tell us what you like, what to change, or an idea. It goes straight to our team.</p>
        <div class="paf-cats">${CATS.map(([k, l]) => `<button type="button" class="paf-cat${k === 'idea' ? ' on' : ''}" data-k="${k}">${l}</button>`).join('')}</div>
        <textarea class="paf-in" id="paf-body" rows="4" maxlength="2000" placeholder="What's on your mind?"></textarea>
        <button id="paf-submit" type="button">Send</button>
        <p class="paf-note">Only our team sees this — never other parents.</p>
      </div>`;
    document.body.appendChild(panel);
    document.getElementById('paf-close').addEventListener('click', close);
    panel.addEventListener('click', e => { if (e.target === panel) close(); });
    document.addEventListener('keydown', escToClose);
    panel.querySelectorAll('.paf-cat').forEach(b => b.addEventListener('click', () => {
      cat = b.dataset.k;
      panel.querySelectorAll('.paf-cat').forEach(x => x.classList.toggle('on', x === b));
    }));
    document.getElementById('paf-submit').addEventListener('click', submit);
    ensureToken();
  }
  function escToClose(e) { if (e.key === 'Escape') close(); }

  window.WrenParentAppFeedback = { open, close };
})();
