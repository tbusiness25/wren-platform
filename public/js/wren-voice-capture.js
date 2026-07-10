;(function () {
  'use strict';

  // Staff editions only — skip parents and any page without an edition meta tag.
  // 'ladn-hr' is the HR portal's edition meta value (the HR pages tag themselves
  // ladn-hr, not hr) — without it the mic never mounts on the HR portal.
  const STAFF_EDITIONS = ['admin', 'hr', 'ladn-hr', 'ladn', 'learning'];

  function _edition() {
    const m = document.querySelector('meta[name="wren-edition"]');
    return m ? m.content : null;
  }

  function shouldMount() {
    return STAFF_EDITIONS.includes(_edition());
  }

  // ── IndexedDB for failed-upload retry ─────────────────────────────────────
  let _idb = null;

  function openDB() {
    if (_idb) return Promise.resolve(_idb);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('wren-vc-pending', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('pending')) {
          db.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess  = e => { _idb = e.target.result; resolve(_idb); };
      req.onerror    = e => reject(e.target.error);
    });
  }

  function idbSave(blob, context) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction('pending', 'readwrite');
      tx.objectStore('pending').add({ blob, context, ts: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror    = e => reject(e.target.error);
    }));
  }

  function idbGetAll() {
    return openDB().then(db => new Promise((resolve, reject) => {
      const tx  = db.transaction('pending', 'readonly');
      const req = tx.objectStore('pending').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = e => reject(e.target.error);
    }));
  }

  function idbDelete(id) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction('pending', 'readwrite');
      tx.objectStore('pending').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror    = e => reject(e.target.error);
    }));
  }

  // ── Context capture ────────────────────────────────────────────────────────
  function captureContext() {
    const path  = window.location.pathname;
    const ed    = _edition() || 'unknown';

    let childId = null;
    const m1 = path.match(/\/child(?:ren)?\/(\d+)/);
    const m2 = path.match(/\/child-profile\/(\d+)/);
    if (m1) childId = parseInt(m1[1], 10);
    else if (m2) childId = parseInt(m2[1], 10);
    else {
      const p = new URLSearchParams(window.location.search);
      const cq = p.get('child') || p.get('child_id');
      if (cq) childId = parseInt(cq, 10) || null;
    }

    let userId = null;
    try { if (window.Wren && Wren.getUser) userId = (Wren.getUser() || {}).id; } catch {}

    return {
      source_url:  window.location.href,
      source_page: `${ed}:${path}`,
      user_id:     userId,
      child_id:    childId || null,
      recorded_at: new Date().toISOString(),
      duration_ms: null,
    };
  }

  // ── Minimal toast (falls back to Wren.toast if available) ─────────────────
  function toast(msg, type) {
    if (window.Wren && Wren.toast) { Wren.toast(msg, type); return; }
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;bottom:96px;left:50%;transform:translateX(-50%);' +
      'background:#1e293b;color:#f1f5f9;border:1px solid #2d3748;border-radius:8px;' +
      'padding:10px 16px;font-size:.85rem;z-index:9999;pointer-events:none;white-space:nowrap;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.4)';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2800);
  }

  // ── Styles ─────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('wren-vc-styles')) return;
    const s = document.createElement('style');
    s.id = 'wren-vc-styles';
    s.textContent = `
#wren-vc-btn {
  position: fixed; bottom: 24px; left: 24px;
  width: 56px; height: 56px; border-radius: 50%;
  background: #4a9abf; border: none; cursor: pointer;
  box-shadow: 0 4px 16px rgba(74,154,191,.45);
  z-index: 8900; display: flex; align-items: center; justify-content: center;
  transition: transform .2s ease, box-shadow .2s ease;
  color: #fff; padding: 0; -webkit-tap-highlight-color: transparent;
}
#wren-vc-btn:hover { transform: scale(1.08); box-shadow: 0 6px 20px rgba(74,154,191,.6); }
#wren-vc-btn svg { width: 26px; height: 26px; pointer-events: none; }
#wren-vc-panel {
  position: fixed; bottom: 92px; left: 24px;
  width: 230px;
  background: #0f172a; border-radius: 16px;
  box-shadow: 0 12px 40px rgba(0,0,0,.55);
  z-index: 8901; display: flex; flex-direction: column;
  overflow: hidden; border: 1px solid #2d3748;
  transition: opacity .2s ease, transform .2s ease;
  transform-origin: bottom left;
}
#wren-vc-panel.vc-hidden {
  opacity: 0; transform: scale(.92) translateY(8px); pointer-events: none;
}
.vc-header {
  background: #1e293b; padding: 10px 14px;
  display: flex; align-items: center; justify-content: space-between;
  border-bottom: 1px solid #2d3748; font-size: .78rem; color: #94a3b8;
}
.vc-close-btn {
  background: none; border: none; color: #64748b; cursor: pointer;
  font-size: 15px; padding: 3px 7px; border-radius: 4px; line-height: 1; min-width: 28px; min-height: 28px;
}
.vc-close-btn:hover { background: #2d3748; color: #f1f5f9; }
.vc-body {
  padding: 14px 16px 16px;
  display: flex; flex-direction: column; align-items: center; gap: 10px;
}
.vc-record-btn {
  width: 68px; height: 68px; border-radius: 50%;
  background: #1e293b; border: 3px solid #2d3748;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: all .15s ease; touch-action: none;
  user-select: none; -webkit-tap-highlight-color: transparent;
}
.vc-record-btn svg { pointer-events: none; }
.vc-record-btn.vc-recording {
  background: rgba(239,68,68,.12);
  border-color: #ef4444;
  animation: vc-pulse 1s ease-in-out infinite;
}
@keyframes vc-pulse {
  0%,100% { box-shadow: 0 0 0 0 rgba(239,68,68,.45); }
  50%      { box-shadow: 0 0 0 10px rgba(239,68,68,0); }
}
.vc-timer {
  font-size: .88rem; color: #94a3b8;
  font-variant-numeric: tabular-nums; letter-spacing: .04em;
}
.vc-timer.vc-active { color: #ef4444; }
.vc-page-ctx {
  font-size: .68rem; color: #475569; text-align: center;
  max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.vc-hint { font-size: .72rem; color: #475569; text-align: center; }
.vc-status { font-size: .78rem; color: #4a9abf; text-align: center; min-height: 1.2em; }
.vc-perm-msg { font-size: .75rem; color: #f59e0b; text-align: center; }
/* WREN-MICFIX-20260701: prominent, actionable permission / device error box */
.vc-perm {
  width: 100%; box-sizing: border-box;
  background: rgba(245,158,11,.10); border: 1px solid rgba(245,158,11,.45);
  border-radius: 10px; padding: 10px 12px; text-align: left; margin-top: 2px;
}
.vc-perm.vc-perm-err { background: rgba(239,68,68,.10); border-color: rgba(239,68,68,.5); }
.vc-perm-title { font-size: .82rem; font-weight: 600; color: #fbbf24; margin-bottom: 4px; }
.vc-perm.vc-perm-err .vc-perm-title { color: #f87171; }
.vc-perm-steps { font-size: .74rem; color: #cbd5e1; line-height: 1.55; }
.vc-perm-retry {
  margin-top: 8px; font-size: .74rem; color: #4a9abf; background: #1e293b;
  border: 1px solid #2d3748; cursor: pointer; padding: 6px 12px; border-radius: 8px;
  min-height: 32px; width: 100%;
}
.vc-perm-retry:hover { background: #2d3748; color: #f1f5f9; }
.vc-cancel-btn {
  font-size: .73rem; color: #64748b; background: none; border: none;
  cursor: pointer; padding: 5px 10px; border-radius: 6px;
  transition: color .15s; min-height: 30px;
}
.vc-cancel-btn:hover { color: #ef4444; }
.vc-result { display: none; width: 100%; margin-top: 2px; }
.vc-result.vc-show { display: block; }
.vc-result-text {
  background: #1e293b; border: 1px solid #2d3748; border-radius: 8px;
  padding: 8px 10px; font-size: .8rem; color: #e2e8f0; line-height: 1.5;
  max-height: 140px; overflow-y: auto; white-space: pre-wrap; word-wrap: break-word;
  text-align: left;
}
.vc-result-actions { display: flex; gap: 8px; justify-content: center; margin-top: 8px; }
.vc-result-btn {
  font-size: .74rem; color: #4a9abf; background: #1e293b; border: 1px solid #2d3748;
  cursor: pointer; padding: 6px 12px; border-radius: 8px; min-height: 32px;
}
.vc-result-btn:hover { background: #2d3748; color: #f1f5f9; }
.vc-retry-section {
  padding: 8px 12px; border-top: 1px solid #1e293b;
  font-size: .7rem; color: #64748b;
}
.vc-retry-item {
  display: flex; justify-content: space-between; align-items: center; padding: 3px 0;
}
.vc-retry-btn {
  font-size: .7rem; color: #4a9abf; background: none; border: none;
  cursor: pointer; padding: 2px 8px; border-radius: 4px; min-height: 26px;
}
.vc-retry-btn:hover { background: #1e293b; }
#wren-vc-btn.vc-dragging { transition: none; cursor: grabbing; opacity: .92; }
#wren-vc-btn.vc-positioned { bottom: auto; right: auto; }
#wren-vc-btn.vc-removed { display: none !important; }
#wren-vc-restore {
  position: fixed; left: 0; bottom: 120px;
  width: 26px; height: 46px; border-radius: 0 12px 12px 0;
  background: #1e293b; border: 1px solid #2d3748; border-left: none;
  color: #4a9abf; z-index: 8899; cursor: pointer; padding: 0;
  display: none; align-items: center; justify-content: center;
  box-shadow: 0 3px 12px rgba(0,0,0,.4); -webkit-tap-highlight-color: transparent;
}
#wren-vc-restore.vc-show { display: flex; }
#wren-vc-restore svg { width: 16px; height: 16px; pointer-events: none; }
@media (max-width: 480px) {
  #wren-vc-btn   { bottom: 80px; left: 16px; }
  #wren-vc-panel { bottom: 152px; left: 16px; width: 200px; }
}`;
    document.head.appendChild(s);
  }

  // ── Draggable / dismissible floating button helper ──────────────────────────
  // WREN-DRAG-V1: pointer-based drag with localStorage persistence + dismiss/restore.
  // WREN-MICFIX-20260607: removed long-press-to-hide on the floating button — it
  // collided with the old hold-to-record muscle memory and swallowed the record
  // gesture. The button is now a single clean TAP → open panel. Dismiss lives on
  // the panel ✕ / edge-tab restore only. Drag-to-move + position persistence kept.
  function makeDraggable(el, opts) {
    const POS_KEY     = opts.posKey;       // e.g. 'wren.voiceBtnPos'
    const HIDDEN_KEY  = opts.hiddenKey;    // e.g. 'wren.voiceBtnHidden'
    const onTap       = opts.onTap;        // called on a genuine tap (not a drag)
    const onShow      = opts.onShow || function () {};
    const onHide      = opts.onHide || function () {};
    const restoreEl   = opts.restoreEl;    // edge tab element to bring it back
    const DRAG_THRESH = 6;                 // px movement before it counts as a drag

    let startX = 0, startY = 0, originX = 0, originY = 0;
    let dragging = false, moved = false, pointerId = null;

    function clamp(x, y) {
      const r = el.getBoundingClientRect();
      const maxX = window.innerWidth  - r.width;
      const maxY = window.innerHeight - r.height;
      return [Math.max(0, Math.min(x, maxX)), Math.max(0, Math.min(y, maxY))];
    }

    function applyPos(x, y) {
      const [cx, cy] = clamp(x, y);
      el.classList.add('vc-positioned');
      el.style.left = cx + 'px';
      el.style.top  = cy + 'px';
      el.style.bottom = 'auto';
      el.style.right  = 'auto';
    }

    function savePos() {
      const r = el.getBoundingClientRect();
      try { localStorage.setItem(POS_KEY, JSON.stringify({ x: r.left, y: r.top })); } catch (e) {}
    }

    function restorePos() {
      try {
        const raw = localStorage.getItem(POS_KEY);
        if (!raw) return;
        const p = JSON.parse(raw);
        if (p && typeof p.x === 'number' && typeof p.y === 'number') applyPos(p.x, p.y);
      } catch (e) {}
    }

    function announce(visible) {
      if (!opts.widgetName) return;
      try {
        document.dispatchEvent(new CustomEvent('wren:widget-visibility-changed',
          { detail: { widget: opts.widgetName, visible: visible } }));
      } catch (e) {}
    }

    function hide() {
      el.classList.add('vc-removed');
      if (restoreEl) restoreEl.classList.add('vc-show');
      try { localStorage.setItem(HIDDEN_KEY, '1'); } catch (e) {}
      onHide();
      announce(false);
    }

    function show() {
      el.classList.remove('vc-removed');
      if (restoreEl) restoreEl.classList.remove('vc-show');
      try { localStorage.removeItem(HIDDEN_KEY); } catch (e) {}
      onShow();
      announce(true);
    }

    function onDown(e) {
      if (e.button != null && e.button !== 0) return;
      pointerId = e.pointerId;
      dragging = true; moved = false;
      const r = el.getBoundingClientRect();
      originX = r.left; originY = r.top;
      startX = e.clientX; startY = e.clientY;
      el.setPointerCapture && el.setPointerCapture(pointerId);
    }

    function onMove(e) {
      if (!dragging || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!moved && (Math.abs(dx) > DRAG_THRESH || Math.abs(dy) > DRAG_THRESH)) {
        moved = true;
        el.classList.add('vc-dragging');
      }
      if (moved) {
        e.preventDefault();
        applyPos(originX + dx, originY + dy);
      }
    }

    function cleanup() {
      dragging = false;
      el.classList.remove('vc-dragging');
      try { el.releasePointerCapture && el.releasePointerCapture(pointerId); } catch (e) {}
      pointerId = null;
    }

    function onUp(e) {
      if (!dragging || e.pointerId !== pointerId) return;
      const wasMoved = moved;
      cleanup();
      if (wasMoved) { savePos(); }
      else if (!el.classList.contains('vc-removed')) { onTap && onTap(); }
    }

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', cleanup);
    // Suppress the synthetic click that follows a drag so it never opens the panel.
    el.addEventListener('click', e => { if (moved) { e.stopPropagation(); e.preventDefault(); } }, true);

    if (restoreEl) restoreEl.addEventListener('click', show);

    // Restore persisted state
    restorePos();
    let startHidden = false;
    try { startHidden = localStorage.getItem(HIDDEN_KEY) === '1'; } catch (e) {}
    if (startHidden) { el.classList.add('vc-removed'); if (restoreEl) restoreEl.classList.add('vc-show'); }

    // Keep within viewport when the window resizes
    window.addEventListener('resize', () => {
      if (!el.classList.contains('vc-positioned')) return;
      const r = el.getBoundingClientRect();
      applyPos(r.left, r.top);
    });

    return { hide, show };
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let panel       = null;
  let isOpen      = false;
  let isRecording = false;
  let isTouch     = false;
  let mr          = null;   // MediaRecorder
  let chunks      = [];
  let startTime   = 0;
  let timerIv     = null;
  let maxTm       = null;
  let ctx         = null;   // captureContext() snapshot
  let dragHandle  = null;   // { hide, show } from makeDraggable

  // ── Build DOM ──────────────────────────────────────────────────────────────
  function buildWidget() {
    if (document.getElementById('wren-vc-btn')) return;
    injectStyles();

    const MIC_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="22"/>
      <line x1="8" y1="22" x2="16" y2="22"/>
    </svg>`;

    const btn = document.createElement('button');
    btn.id = 'wren-vc-btn';
    btn.setAttribute('aria-label', 'Open voice note recorder (tap to open, drag to move)');
    btn.style.touchAction = 'none';
    btn.innerHTML = MIC_SVG;
    document.body.appendChild(btn);

    // Edge tab to bring the button back after it's been hidden
    const restoreTab = document.createElement('button');
    restoreTab.id = 'wren-vc-restore';
    restoreTab.setAttribute('aria-label', 'Show voice note recorder');
    restoreTab.innerHTML = MIC_SVG;
    document.body.appendChild(restoreTab);

    // Drag / dismiss / persist — tap opens the panel, drag moves the button.
    // Dismiss (hide) is now only via the panel's "Hide" control and the edge tab
    // restores it — the floating button itself no longer hides on long-press.
    dragHandle = makeDraggable(btn, {
      posKey:     'wren.voiceBtnPos',
      hiddenKey:  'wren.voiceBtnHidden',
      widgetName: 'mic',
      restoreEl:  restoreTab,
      onTap:      onBtnClick,
      onHide:     function () { if (isOpen) closePanel(); }
    });

    panel = document.createElement('div');
    panel.id = 'wren-vc-panel';
    panel.classList.add('vc-hidden');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Voice note recorder');

    panel.innerHTML = `
      <div class="vc-header">
        <span>Voice note</span>
        <span style="display:flex;align-items:center;gap:2px">
          <button class="vc-close-btn" id="vc-hide" aria-label="Hide voice button" title="Hide the floating mic button">⤫</button>
          <button class="vc-close-btn" id="vc-close" aria-label="Close">✕</button>
        </span>
      </div>
      <div class="vc-body">
        <div class="vc-status" id="vc-status"></div>
        <button class="vc-record-btn" id="vc-rbtn" aria-label="Record" type="button">
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#94a3b8"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round" id="vc-mic-svg">
            <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="22"/>
            <line x1="8" y1="22" x2="16" y2="22"/>
          </svg>
        </button>
        <div class="vc-timer" id="vc-timer">0:00 / 1:00</div>
        <div class="vc-page-ctx" id="vc-ctx"></div>
        <div class="vc-hint" id="vc-hint"></div>
        <div class="vc-perm" id="vc-perm" style="display:none">
          <div class="vc-perm-title" id="vc-perm-title"></div>
          <div class="vc-perm-steps" id="vc-perm-steps"></div>
          <button class="vc-perm-retry" id="vc-perm-retry" type="button">Try again</button>
        </div>
        <div class="vc-result" id="vc-result">
          <div class="vc-result-text" id="vc-result-text"></div>
          <div class="vc-result-actions">
            <button class="vc-result-btn" id="vc-copy" type="button">Copy text</button>
            <button class="vc-result-btn" id="vc-again" type="button">New note</button>
          </div>
        </div>
        <button class="vc-cancel-btn" id="vc-cancel" type="button">Cancel</button>
      </div>
      <div class="vc-retry-section" id="vc-retry" style="display:none">
        <div style="color:#94a3b8;margin-bottom:5px">Pending uploads:</div>
        <div id="vc-retry-list"></div>
      </div>`;
    document.body.appendChild(panel);

    // Wire close + hide (dismiss the floating button from inside the panel)
    panel.querySelector('#vc-close').addEventListener('click', closePanel);
    panel.querySelector('#vc-hide').addEventListener('click', function () {
      closePanel();
      if (dragHandle && dragHandle.hide) dragHandle.hide();
    });
    panel.querySelector('#vc-cancel').addEventListener('click', cancelRecording);
    panel.querySelector('#vc-copy').addEventListener('click', copyTranscript);
    panel.querySelector('#vc-again').addEventListener('click', resetForNewNote);
    // WREN-MICFIX-20260701: "Try again" re-attempts getUserMedia straight from this
    // click gesture — if permission is still in the 'prompt' state the browser will
    // show the popup again; if it's persistently blocked the help text stays visible.
    panel.querySelector('#vc-perm-retry').addEventListener('click', function () {
      clearPermHelp();
      startRecording();
    });

    // Record button — detect touch vs pointer
    const rbtn = panel.querySelector('#vc-rbtn');
    isTouch = window.matchMedia('(pointer: coarse)').matches;

    if (isTouch) {
      // WREN-MICFIX-20260607: tablet flow is now a clean TAP-TO-TOGGLE on the
      // panel's record button (was fragile hold-to-record with a 1s minimum that
      // cancelled quick taps and never reached getUserMedia). startRecording()
      // fires synchronously on the touchstart user gesture, so the browser shows
      // the mic permission prompt on the first tap.
      panel.querySelector('#vc-hint').textContent = 'Tap to start · tap to stop';
      rbtn.addEventListener('touchstart', onTouchToggle, { passive: false });
    } else {
      panel.querySelector('#vc-hint').textContent = 'Click to start · click to stop · ESC to cancel';
      rbtn.addEventListener('click', onDesktopClick);
    }

    document.addEventListener('keydown', onEsc);
  }

  function onEsc(e) {
    if (e.key !== 'Escape' || !isOpen) return;
    if (isRecording) cancelRecording();
    else closePanel();
  }

  // ── Panel open/close ───────────────────────────────────────────────────────
  function onBtnClick() {
    isOpen ? closePanel() : openPanel();
  }

  function openPanel() {
    isOpen = true;
    ctx = captureContext();
    panel.querySelector('#vc-ctx').textContent = 'From: ' + ctx.source_page;
    setStatus('');
    hideTranscript();
    clearPermHelp();
    panel.classList.remove('vc-hidden');
    checkMicState();
    refreshPending();
  }

  function closePanel() {
    if (isRecording) cancelRecording();
    isOpen = false;
    panel.classList.add('vc-hidden');
  }

  // ── Touch (tap-to-toggle) ──────────────────────────────────────────────────
  // First tap calls startRecording() synchronously from the touchstart user
  // gesture → getUserMedia runs → browser shows the mic permission prompt.
  // Second tap stops and uploads. No hold, no minimum-duration cancel.
  function onTouchToggle(e) {
    e.preventDefault();
    if (!isRecording) startRecording();
    else stopRecording();
  }

  // ── Desktop (click-toggle) ─────────────────────────────────────────────────
  function onDesktopClick() {
    if (!isRecording) startRecording();
    else stopRecording();
  }

  // ── Recording lifecycle ────────────────────────────────────────────────────
  async function startRecording() {
    // getUserMedia only works in a secure context. Opened over plain HTTP (e.g. a
    // LAN / Tailscale IP) the browser blocks the mic and mediaDevices is undefined —
    // give an accurate, actionable message instead of the misleading "not supported".
    if (!window.isSecureContext) { showPermHelp('insecure'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { showPermHelp('unsupported'); return; }
    clearPermHelp();
    // NOTE: nothing async may run before getUserMedia or the browser drops the user
    // gesture and silently suppresses the permission prompt. hideTranscript() is pure
    // synchronous DOM, and getUserMedia is the first await — the gesture is preserved.
    try {
      hideTranscript();
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      } catch (e0) {
        // Some devices reject the mono constraint (OverconstrainedError) — retry with
        // a plain audio request before giving up, so a real mic still records.
        if (e0 && (e0.name === 'OverconstrainedError' || e0.name === 'ConstraintNotSatisfiedError')) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
          throw e0;
        }
      }
      chunks = [];

      const mime =
        MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' :
        MediaRecorder.isTypeSupported('audio/webm')             ? 'audio/webm' :
        MediaRecorder.isTypeSupported('audio/mp4')              ? 'audio/mp4'  : '';

      const opts = { audioBitsPerSecond: 64000 };
      if (mime) opts.mimeType = mime;
      mr = mime ? new MediaRecorder(stream, opts) : new MediaRecorder(stream, { audioBitsPerSecond: 64000 });

      mr.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      mr.onstop = () => stream.getTracks().forEach(t => t.stop());
      mr.start(250);

      isRecording = true;
      startTime = Date.now();

      const rbtn = panel.querySelector('#vc-rbtn');
      rbtn.classList.add('vc-recording');
      panel.querySelector('#vc-mic-svg').setAttribute('stroke', '#ef4444');
      setStatus('');
      startTimer();

      maxTm = setTimeout(() => {
        if (isRecording) { stopRecording(); toast('Max length reached (60s)', 'info'); }
      }, 60000);
    } catch (err) {
      const kind = classifyMediaError(err);
      if (kind === '__notallowed__') {
        // Distinguish a hard block (Permissions API says 'denied') from a one-off
        // dismissed prompt, so the guidance matches what the user is actually seeing.
        let resolved = false;
        try {
          if (navigator.permissions && navigator.permissions.query) {
            navigator.permissions.query({ name: 'microphone' }).then(function (st) {
              resolved = true;
              showPermHelp(st.state === 'denied' ? 'blocked' : 'dismissed');
            }).catch(function () { if (!resolved) showPermHelp('blocked'); });
          } else {
            showPermHelp('blocked');
          }
        } catch (e) { showPermHelp('blocked'); }
        // Fallback in case the Permissions API promise never settles.
        setTimeout(function () { if (!resolved) showPermHelp('blocked'); }, 400);
      } else {
        showPermHelp(kind);
      }
      // Include the DOMException name — "unavailable" alone is undiagnosable when the
      // browser permission is granted but the OS/device layer is the real blocker.
      toast('Microphone unavailable' + (err && err.name ? ' (' + err.name + ')' : ''), 'error');
    }
  }

  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    clearInterval(timerIv);
    clearTimeout(maxTm);

    const rbtn = panel.querySelector('#vc-rbtn');
    rbtn.classList.remove('vc-recording');
    panel.querySelector('#vc-mic-svg').setAttribute('stroke', '#94a3b8');
    panel.querySelector('#vc-timer').classList.remove('vc-active');

    ctx.duration_ms = Date.now() - startTime;

    if (mr && mr.state !== 'inactive') mr.stop();

    setStatus('Transcribing…');
    setTimeout(() => {
      if (!chunks.length) { setStatus('No audio captured'); return; }
      const mime = (mr && mr.mimeType) || 'audio/webm';
      const blob = new Blob(chunks, { type: mime });
      upload(blob, mime, Object.assign({}, ctx));
    }, 250);
  }

  function cancelRecording() {
    if (!isRecording) return;
    isRecording = false;
    clearInterval(timerIv);
    clearTimeout(maxTm);
    if (mr && mr.state !== 'inactive') { mr.onstop = null; mr.stop(); }
    chunks = [];
    const rbtn = panel.querySelector('#vc-rbtn');
    rbtn.classList.remove('vc-recording');
    panel.querySelector('#vc-mic-svg').setAttribute('stroke', '#94a3b8');
    panel.querySelector('#vc-timer').textContent = '0:00 / 1:00';
    panel.querySelector('#vc-timer').classList.remove('vc-active');
    setStatus('');
  }

  function startTimer() {
    const el = panel.querySelector('#vc-timer');
    el.classList.add('vc-active');
    timerIv = setInterval(() => {
      const s = Math.floor((Date.now() - startTime) / 1000);
      el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} / 1:00`;
    }, 500);
  }

  function setStatus(msg) {
    const el = panel && panel.querySelector('#vc-status');
    if (el) el.textContent = msg;
  }

  // ── Permission / device error UX ────────────────────────────────────────────
  // WREN-MICFIX-20260701: staff reported "asks for permission but no popup" on
  // tablets. The real cause is a persistently-blocked (or dismissed) mic: the
  // browser then rejects getUserMedia *immediately* with NotAllowedError and never
  // shows a prompt — the old code only put a tiny "check browser settings" line in
  // the status row, which reads as "nothing happened". This shows a clear, actionable
  // box telling staff exactly how to re-enable it, and distinguishes the failure modes.
  const PERM_HELP = {
    blocked: {
      err: true,
      title: '🎤 Microphone is blocked',
      steps: 'Your browser is blocking the mic, so no popup appears. Tap the site icon ' +
             '(🔒 / ⓘ / ⋮) next to the web address → <b>Microphone</b> → <b>Allow</b>, ' +
             'then reload this page and tap record again.<br><br>' +
             '<b>Already set to Allow?</b> Then the operating system is blocking the ' +
             'browser: on Windows open Settings → Privacy &amp; security → Microphone ' +
             'and turn ON <b>Microphone access</b>, <b>Let apps access your microphone</b> ' +
             'and <b>Let desktop apps access your microphone</b>, then restart the browser.',
      retry: true,
    },
    dismissed: {
      err: false,
      title: '🎤 Permission needed',
      steps: 'Tap <b>Try again</b> and choose <b>Allow</b> when the browser asks to use ' +
             'the microphone.',
      retry: true,
    },
    nodevice: {
      err: true,
      title: '🎤 No microphone found',
      steps: 'This device has no microphone the browser can use. Check a mic is connected ' +
             'and not disabled, then reload.',
      retry: true,
    },
    inuse: {
      err: true,
      title: '🎤 Microphone is busy',
      steps: 'Another app or browser tab is using the microphone. Close it, then tap ' +
             '<b>Try again</b>.',
      retry: true,
    },
    insecure: {
      err: true,
      title: '🎤 Needs a secure (https) connection',
      steps: 'The microphone only works over https. Open the portal via its ' +
             'https:// web address (not an IP), then try again.',
      retry: false,
    },
    unsupported: {
      err: true,
      title: '🎤 Recording not supported here',
      steps: 'This browser can’t record audio. Try the latest Chrome or Safari.',
      retry: false,
    },
  };

  function showPermHelp(kind) {
    const info = PERM_HELP[kind] || PERM_HELP.blocked;
    if (!panel) return;
    const box = panel.querySelector('#vc-perm');
    if (!box) return;
    box.classList.toggle('vc-perm-err', !!info.err);
    panel.querySelector('#vc-perm-title').textContent = info.title;
    panel.querySelector('#vc-perm-steps').innerHTML = info.steps;
    panel.querySelector('#vc-perm-retry').style.display = info.retry ? '' : 'none';
    box.style.display = 'block';
    setStatus('');
    const hint = panel.querySelector('#vc-hint');
    if (hint) hint.style.display = 'none';
  }

  function clearPermHelp() {
    if (!panel) return;
    const box = panel.querySelector('#vc-perm');
    if (box) box.style.display = 'none';
    const hint = panel.querySelector('#vc-hint');
    if (hint && !isRecording) hint.style.display = '';
  }

  // Map a getUserMedia rejection to one of the PERM_HELP kinds.
  function classifyMediaError(err) {
    const n = (err && err.name) || '';
    if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') {
      // A dismissed prompt and a persistent block both surface as NotAllowedError.
      // If the Permissions API says 'denied' it's a real block; otherwise treat it as
      // a dismissed prompt (retry can still show the popup).
      return '__notallowed__';
    }
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError') return 'nodevice';
    if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return 'inuse';
    return 'blocked';
  }

  // Proactively surface a blocked mic when the panel opens, so staff see the "how to
  // enable" guidance before they even tap record (Chrome/Android expose this state).
  function checkMicState() {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({ name: 'microphone' }).then(function (st) {
          if (!isRecording && st.state === 'denied') showPermHelp('blocked');
          st.onchange = function () {
            if (st.state === 'granted') clearPermHelp();
            else if (st.state === 'denied' && !isRecording) showPermHelp('blocked');
          };
        }).catch(function () {});
      }
    } catch (e) {}
  }

  // ── Transcript result display ───────────────────────────────────────────────
  function showTranscript(text) {
    if (!panel) return;
    const box  = panel.querySelector('#vc-result');
    const txt  = panel.querySelector('#vc-result-text');
    const hint = panel.querySelector('#vc-hint');
    if (txt) txt.textContent = text;
    if (box) box.classList.add('vc-show');
    if (hint) hint.style.display = 'none';
  }

  function hideTranscript() {
    if (!panel) return;
    const box  = panel.querySelector('#vc-result');
    const txt  = panel.querySelector('#vc-result-text');
    const hint = panel.querySelector('#vc-hint');
    if (box) box.classList.remove('vc-show');
    if (txt) txt.textContent = '';
    if (hint) hint.style.display = '';
  }

  function copyTranscript() {
    const txt = panel && panel.querySelector('#vc-result-text');
    const t = txt ? txt.textContent : '';
    if (!t) return;
    const done = () => toast('Copied to clipboard', 'success');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(done).catch(() => fallbackCopy(t, done));
    } else {
      fallbackCopy(t, done);
    }
  }

  function fallbackCopy(t, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand('copy'); ta.remove();
      done && done();
    } catch (e) { toast('Copy failed', 'error'); }
  }

  function resetForNewNote() {
    hideTranscript();
    setStatus('');
    const t = panel && panel.querySelector('#vc-timer');
    if (t) t.textContent = '0:00 / 1:00';
  }

  // ── Upload ─────────────────────────────────────────────────────────────────
  async function upload(blob, mime, context) {
    try {
      const ext  = mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : 'webm';
      const fd   = new FormData();
      fd.append('audio',   blob, `voice-note.${ext}`);
      fd.append('context', JSON.stringify(context));

      const tok = sessionStorage.getItem('wrenToken') || sessionStorage.getItem('wren_token') ||
                  sessionStorage.getItem('wren_jwt') || '';
      const headers = {};
      if (tok) headers['Authorization'] = 'Bearer ' + tok;

      const resp = await fetch('/api/voice-notes/upload', { method: 'POST', headers, body: fd });

      if (resp.status >= 500) throw new Error('server_error');
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        setStatus('Upload failed: ' + (e.error || resp.status));
        toast('Voice note upload failed', 'error');
        return;
      }

      const data = await resp.json().catch(() => ({}));
      if (data.transcript) {
        // Whisper returned text — show it so the user can read / copy it.
        showTranscript(data.transcript);
        setStatus('Transcribed ✓');
        toast('Voice note transcribed', 'success');
      } else {
        // Saved, but no transcript (whisper unreachable / silent clip).
        setStatus('Saved ✓' + (data.transcribe_error ? ' — could not transcribe' : ''));
        toast(data.transcribe_error ? 'Saved, but transcription failed' : 'Voice note saved',
              data.transcribe_error ? 'warning' : 'success');
        setTimeout(() => { if (isOpen) closePanel(); }, 1800);
      }
    } catch {
      await idbSave(blob, context).catch(() => {});
      setStatus('Saved locally — will retry when online');
      toast('Saved for retry', 'warning');
    }
  }

  // ── Pending retry list ─────────────────────────────────────────────────────
  async function refreshPending() {
    try {
      const items  = await idbGetAll();
      const sec    = panel.querySelector('#vc-retry');
      const list   = panel.querySelector('#vc-retry-list');
      if (!items.length) { sec.style.display = 'none'; return; }
      sec.style.display = 'block';
      list.innerHTML = '';
      items.forEach(item => {
        const lbl  = new Date(item.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        const row  = document.createElement('div');
        row.className = 'vc-retry-item';
        const span = document.createElement('span');
        span.textContent = lbl;
        const btn  = document.createElement('button');
        btn.className   = 'vc-retry-btn';
        btn.textContent = 'Retry';
        btn.type        = 'button';
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = '…';
          try {
            await upload(item.blob, item.blob.type || 'audio/webm', item.context);
            await idbDelete(item.id);
            refreshPending();
          } catch { btn.disabled = false; btn.textContent = 'Retry'; }
        });
        row.appendChild(span);
        row.appendChild(btn);
        list.appendChild(row);
      });
    } catch {}
  }

  // ── Mount ──────────────────────────────────────────────────────────────────
  function tryMount() {
    if (document.getElementById('wren-vc-btn')) return;
    if (!shouldMount()) return;
    buildWidget();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryMount);
  } else {
    tryMount();
  }
  document.addEventListener('wren:ready', tryMount);

  // ── Public visibility API + event hook (used by Settings toggles) ───────────
  // Source of truth is the localStorage flag the widget reads on load; these also
  // flip the live widget immediately when it's already mounted on the page.
  function setVisible(v) {
    if (v) { try { localStorage.removeItem('wren.voiceBtnHidden'); } catch (e) {} }
    else   { try { localStorage.setItem('wren.voiceBtnHidden', '1'); } catch (e) {} }
    if (dragHandle) { v ? dragHandle.show() : dragHandle.hide(); }
  }
  window.WrenVoiceCapture = {
    show()     { setVisible(true); },
    hide()     { setVisible(false); },
    setVisible: setVisible,
    isHidden() { try { return localStorage.getItem('wren.voiceBtnHidden') === '1'; } catch (e) { return false; } }
  };
  document.addEventListener('wren:set-widget-visibility', function (e) {
    if (e && e.detail && e.detail.widget === 'mic') setVisible(!!e.detail.visible);
  });

})();
