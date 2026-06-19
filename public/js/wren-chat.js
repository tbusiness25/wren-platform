;(function () {
  'use strict';

  const PERSONA_CONFIG = {
    eyfs: {
      name: 'Wren',
      subtitle: 'EYFS Assistant',
      suggestions: [
        'What are the exclusion periods for chickenpox?',
        'Help me write an observation for a 2-year-old',
        'What should I do if a child makes a disclosure?',
        'Activity ideas for Communication and Language'
      ]
    },
    admin: {
      name: 'Wren',
      subtitle: 'Admin Assistant',
      suggestions: [
        'What does Ofsted look for in leadership?',
        'How do I calculate funded hours for a term?',
        "What's required for a staff supervision?",
        'Help me write a self-evaluation comment'
      ]
    },
    hr: {
      name: 'Wren',
      subtitle: 'HR Assistant',
      suggestions: [
        'How much holiday am I entitled to?',
        "What's the sickness absence procedure?",
        'When should I have a supervision?'
      ]
    },
    parents: {
      name: 'Wren',
      subtitle: 'Family Helper',
      suggestions: [
        'How do I help my child get ready for school?',
        'My child won\'t get dressed themselves — help!',
        'How can I support their talking at home?',
        'What phonics stage should they be at?'
      ]
    }
  };

  let cfg = { persona: 'eyfs', greeting: "Hi! I'm Wren. How can I help today?" };
  let history = [];
  let panel = null;
  let msgList = null;
  let suggestionsBar = null;
  let input = null;
  let isOpen = false;
  let firstMessageSent = false;

  // ── CSS ──────────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('wren-chat-styles')) return;
    const s = document.createElement('style');
    s.id = 'wren-chat-styles';
    s.textContent = `
#wren-chat-btn {
  position: fixed; bottom: 24px; right: 24px;
  width: 56px; height: 56px; border-radius: 50%;
  background: #4a9abf; border: none; cursor: pointer;
  box-shadow: 0 4px 16px rgba(74,154,191,.45);
  z-index: 8900; display: flex; align-items: center; justify-content: center;
  font-size: 24px; transition: transform .2s ease, box-shadow .2s ease;
  color: #fff;
}
#wren-chat-btn:hover { transform: scale(1.08); box-shadow: 0 6px 20px rgba(74,154,191,.6); }
#wren-chat-btn .chat-badge {
  position: absolute; top: -2px; right: -2px;
  width: 14px; height: 14px; border-radius: 50%;
  background: #e07820; border: 2px solid #fff;
  display: none;
}
#wren-chat-panel {
  position: fixed; bottom: 92px; right: 24px;
  width: 320px; height: 480px;
  background: #0f172a; border-radius: 16px;
  box-shadow: 0 16px 48px rgba(0,0,0,.5);
  z-index: 8900; display: flex; flex-direction: column;
  overflow: hidden; border: 1px solid #2d3748;
  transition: opacity .2s ease, transform .2s ease;
  transform-origin: bottom right;
}
#wren-chat-panel.hidden {
  opacity: 0; transform: scale(.92) translateY(8px); pointer-events: none;
}
.wc-header {
  background: #1e293b; padding: 12px 16px;
  display: flex; align-items: center; gap: 10px;
  border-bottom: 1px solid #2d3748; flex-shrink: 0;
}
.wc-avatar {
  width: 36px; height: 36px; border-radius: 50%;
  background: #4a9abf; display: flex; align-items: center;
  justify-content: center; font-size: 18px; flex-shrink: 0;
}
.wc-header-info { flex: 1; min-width: 0; }
.wc-header-name { font-weight: 700; font-size: .875rem; color: #f1f5f9; line-height: 1.2; }
.wc-header-sub { font-size: .72rem; color: #64748b; }
.wc-close {
  background: none; border: none; cursor: pointer;
  color: #64748b; font-size: 18px; padding: 4px; line-height: 1;
  border-radius: 6px; transition: background .15s;
}
.wc-close:hover { background: #2d3748; color: #f1f5f9; }
.wc-messages {
  flex: 1; overflow-y: auto; padding: 12px;
  display: flex; flex-direction: column; gap: 8px;
  scroll-behavior: smooth;
}
.wc-messages::-webkit-scrollbar { width: 4px; }
.wc-messages::-webkit-scrollbar-track { background: transparent; }
.wc-messages::-webkit-scrollbar-thumb { background: #2d3748; border-radius: 2px; }
.wc-msg {
  max-width: 86%; padding: 8px 11px; border-radius: 12px;
  font-size: .82rem; line-height: 1.55; word-wrap: break-word;
}
.wc-msg.user {
  background: #e07820; color: #fff;
  align-self: flex-end; border-bottom-right-radius: 4px;
}
.wc-msg.ai {
  background: #1e293b; color: #e2e8f0; border: 1px solid #2d3748;
  align-self: flex-start; border-bottom-left-radius: 4px;
}
.wc-msg.ai a { color: #4a9abf; }
.wc-loading {
  background: #1e293b; border: 1px solid #2d3748;
  align-self: flex-start; padding: 10px 14px;
  border-radius: 12px; border-bottom-left-radius: 4px;
  display: flex; gap: 5px; align-items: center;
}
.wc-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #4a9abf; animation: wc-bounce .9s ease-in-out infinite;
}
.wc-dot:nth-child(2) { animation-delay: .15s; }
.wc-dot:nth-child(3) { animation-delay: .3s; }
@keyframes wc-bounce { 0%,80%,100% { transform: translateY(0); } 40% { transform: translateY(-6px); } }
.wc-suggestions {
  padding: 8px 10px; display: flex; flex-wrap: wrap; gap: 6px;
  border-top: 1px solid #1e293b; flex-shrink: 0;
}
.wc-suggestion {
  background: #1e293b; border: 1px solid #2d3748;
  color: #94a3b8; font-size: .72rem; padding: 5px 10px;
  border-radius: 20px; cursor: pointer; transition: all .15s;
  text-align: left; line-height: 1.3;
}
.wc-suggestion:hover { background: #2d3748; color: #f1f5f9; border-color: #4a9abf; }
.wc-input-area {
  padding: 10px; border-top: 1px solid #2d3748;
  display: flex; gap: 8px; align-items: flex-end; flex-shrink: 0;
}
.wc-input {
  flex: 1; background: #1e293b; border: 1px solid #2d3748;
  border-radius: 10px; color: #f1f5f9; padding: 8px 10px;
  font-size: .83rem; resize: none; max-height: 80px;
  min-height: 36px; outline: none; line-height: 1.4;
  font-family: inherit; transition: border-color .15s;
}
.wc-input:focus { border-color: #4a9abf; }
.wc-input::placeholder { color: #475569; }
.wc-send {
  background: #4a9abf; border: none; border-radius: 10px;
  color: #fff; cursor: pointer; padding: 8px 12px;
  font-size: 16px; flex-shrink: 0; transition: background .15s;
  height: 36px; display: flex; align-items: center; justify-content: center;
}
.wc-send:hover { background: #357a9a; }
.wc-send:disabled { background: #334155; cursor: not-allowed; }
#wren-chat-btn.wc-dragging { transition: none; cursor: grabbing; opacity: .92; }
#wren-chat-btn.wc-positioned { bottom: auto; right: auto; }
#wren-chat-btn.wc-removed { display: none !important; }
#wren-chat-restore {
  position: fixed; right: 0; bottom: 120px;
  width: 26px; height: 46px; border-radius: 12px 0 0 12px;
  background: #1e293b; border: 1px solid #2d3748; border-right: none;
  color: #4a9abf; z-index: 8899; cursor: pointer; padding: 0;
  display: none; align-items: center; justify-content: center; font-size: 16px;
  box-shadow: 0 3px 12px rgba(0,0,0,.4); -webkit-tap-highlight-color: transparent;
}
#wren-chat-restore.wc-show { display: flex; }
@media (max-width: 480px) {
  #wren-chat-panel {
    width: 100vw; height: 100dvh;
    bottom: 0; right: 0; border-radius: 0;
  }
  #wren-chat-btn { bottom: 16px; right: 16px; }
}`;
    document.head.appendChild(s);
  }

  // ── Draggable / dismissible floating button helper ──────────────────────────
  // WREN-DRAG-V1: pointer-based drag with localStorage persistence + dismiss/restore.
  function makeDraggable(el, opts) {
    const POS_KEY     = opts.posKey;
    const HIDDEN_KEY  = opts.hiddenKey;
    const onTap       = opts.onTap;
    const onShow      = opts.onShow || function () {};
    const onHide      = opts.onHide || function () {};
    const restoreEl   = opts.restoreEl;
    const DRAG_THRESH = 6;
    const LONGPRESS   = 600;

    let startX = 0, startY = 0, originX = 0, originY = 0;
    let dragging = false, moved = false, pointerId = null, lpTimer = null;

    function clamp(x, y) {
      const r = el.getBoundingClientRect();
      const maxX = window.innerWidth  - r.width;
      const maxY = window.innerHeight - r.height;
      return [Math.max(0, Math.min(x, maxX)), Math.max(0, Math.min(y, maxY))];
    }

    function applyPos(x, y) {
      const [cx, cy] = clamp(x, y);
      el.classList.add('wc-positioned');
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

    function hide() {
      el.classList.add('wc-removed');
      if (restoreEl) restoreEl.classList.add('wc-show');
      try { localStorage.setItem(HIDDEN_KEY, '1'); } catch (e) {}
      onHide();
    }

    function show() {
      el.classList.remove('wc-removed');
      if (restoreEl) restoreEl.classList.remove('wc-show');
      try { localStorage.removeItem(HIDDEN_KEY); } catch (e) {}
      onShow();
    }

    function onDown(e) {
      if (e.button != null && e.button !== 0) return;
      pointerId = e.pointerId;
      dragging = true; moved = false;
      const r = el.getBoundingClientRect();
      originX = r.left; originY = r.top;
      startX = e.clientX; startY = e.clientY;
      el.setPointerCapture && el.setPointerCapture(pointerId);
      lpTimer = setTimeout(() => { if (!moved) { hide(); cleanup(); } }, LONGPRESS);
    }

    function onMove(e) {
      if (!dragging || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!moved && (Math.abs(dx) > DRAG_THRESH || Math.abs(dy) > DRAG_THRESH)) {
        moved = true;
        clearTimeout(lpTimer);
        el.classList.add('wc-dragging');
      }
      if (moved) {
        e.preventDefault();
        applyPos(originX + dx, originY + dy);
      }
    }

    function cleanup() {
      dragging = false;
      clearTimeout(lpTimer);
      el.classList.remove('wc-dragging');
      try { el.releasePointerCapture && el.releasePointerCapture(pointerId); } catch (e) {}
      pointerId = null;
    }

    function onUp(e) {
      if (!dragging || e.pointerId !== pointerId) return;
      const wasMoved = moved;
      clearTimeout(lpTimer);
      cleanup();
      if (wasMoved) { savePos(); }
      else if (!el.classList.contains('wc-removed')) { onTap && onTap(); }
    }

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', cleanup);
    el.addEventListener('click', e => { if (moved) { e.stopPropagation(); e.preventDefault(); } }, true);

    if (restoreEl) restoreEl.addEventListener('click', show);

    restorePos();
    let startHidden = false;
    try { startHidden = localStorage.getItem(HIDDEN_KEY) === '1'; } catch (e) {}
    if (startHidden) { el.classList.add('wc-removed'); if (restoreEl) restoreEl.classList.add('wc-show'); }

    window.addEventListener('resize', () => {
      if (!el.classList.contains('wc-positioned')) return;
      const r = el.getBoundingClientRect();
      applyPos(r.left, r.top);
    });

    return { hide, show };
  }

  // ── Build widget DOM ──────────────────────────────────────────────────────────
  function buildWidget() {
    if (document.getElementById('wren-chat-btn')) return;
    injectStyles();

    const p = PERSONA_CONFIG[cfg.persona] || PERSONA_CONFIG.eyfs;

    // Floating button
    const btn = document.createElement('button');
    btn.id = 'wren-chat-btn';
    btn.setAttribute('aria-label', 'Chat with Wren (drag to move, hold to hide)');
    btn.style.touchAction = 'none';
    btn.innerHTML = '🐦<span class="chat-badge"></span>';
    document.body.appendChild(btn);

    // Edge tab to bring the launcher back after it's been hidden
    const restoreTab = document.createElement('button');
    restoreTab.id = 'wren-chat-restore';
    restoreTab.setAttribute('aria-label', 'Show Wren chat');
    restoreTab.textContent = '🐦';
    document.body.appendChild(restoreTab);

    // Drag / dismiss / persist — tap opens the chat, drag moves, hold hides.
    makeDraggable(btn, {
      posKey:    'wren.chatBtnPos',
      hiddenKey: 'wren.chatBtnHidden',
      restoreEl: restoreTab,
      onTap:     toggleChat,
      onHide:    function () { if (isOpen) { isOpen = false; panel.classList.add('hidden'); } }
    });

    // Chat panel
    panel = document.createElement('div');
    panel.id = 'wren-chat-panel';
    panel.classList.add('hidden');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Wren AI Chat');

    panel.innerHTML = `
      <div class="wc-header">
        <div class="wc-avatar">🐦</div>
        <div class="wc-header-info">
          <div class="wc-header-name">${esc(p.name)}</div>
          <div class="wc-header-sub">${esc(p.subtitle)}</div>
        </div>
        <button class="wc-close" title="Close">✕</button>
      </div>
      <div class="wc-messages" id="wc-messages"></div>
      <div class="wc-suggestions" id="wc-suggestions"></div>
      <div class="wc-input-area">
        <textarea class="wc-input" id="wc-input" placeholder="Ask Wren…" rows="1"></textarea>
        <button class="wc-send" id="wc-send">➤</button>
      </div>`;

    document.body.appendChild(panel);

    msgList = panel.querySelector('#wc-messages');
    suggestionsBar = panel.querySelector('#wc-suggestions');
    input = panel.querySelector('#wc-input');
    const sendBtn = panel.querySelector('#wc-send');

    panel.querySelector('.wc-close').addEventListener('click', () => { isOpen = false; panel.classList.add('hidden'); });

    // Auto-grow textarea
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 80) + 'px';
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });
    sendBtn.addEventListener('click', handleSend);

    // Build suggestions
    buildSuggestions(p.suggestions);

    // Greeting
    addMessage('ai', cfg.greeting);
  }

  function buildSuggestions(suggestions) {
    suggestionsBar.innerHTML = '';
    suggestions.forEach(s => {
      const chip = document.createElement('button');
      chip.className = 'wc-suggestion';
      chip.textContent = s;
      chip.addEventListener('click', () => {
        hideSuggestions();
        input.value = s;
        handleSend();
      });
      suggestionsBar.appendChild(chip);
    });
  }

  function hideSuggestions() {
    firstMessageSent = true;
    suggestionsBar.style.display = 'none';
  }

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function addMessage(role, text) {
    const el = document.createElement('div');
    el.className = `wc-msg ${role}`;
    el.textContent = text;
    msgList.appendChild(el);
    msgList.scrollTop = msgList.scrollHeight;
    return el;
  }

  function addLoading() {
    const el = document.createElement('div');
    el.className = 'wc-loading';
    el.innerHTML = '<div class="wc-dot"></div><div class="wc-dot"></div><div class="wc-dot"></div>';
    msgList.appendChild(el);
    msgList.scrollTop = msgList.scrollHeight;
    return el;
  }

  function toggleChat() {
    isOpen = !isOpen;
    if (isOpen) {
      panel.classList.remove('hidden');
      input.focus();
    } else {
      panel.classList.add('hidden');
    }
  }

  async function handleSend() {
    const text = (input.value || '').trim();
    if (!text) return;

    if (!firstMessageSent) hideSuggestions();

    input.value = '';
    input.style.height = 'auto';
    panel.querySelector('#wc-send').disabled = true;

    addMessage('user', text);
    history.push({ role: 'user', content: text });

    const loader = addLoading();

    try {
      const token = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem('wrenToken') : null;
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const resp = await fetch('/api/ai/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({ message: text, history: history.slice(0, -1), persona: cfg.persona })
      });

      loader.remove();

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        if (resp.status === 401) {
          addMessage('ai', "I'm sorry, you need to be signed in to chat with me.");
        } else {
          addMessage('ai', err.error || 'Sorry, something went wrong. Please try again.');
        }
        history.pop();
      } else {
        const data = await resp.json();
        const reply = data.reply || 'Sorry, I didn\'t get a response.';
        addMessage('ai', reply);
        history.push({ role: 'assistant', content: reply });
        // Keep history to last 10 messages
        if (history.length > 10) history = history.slice(history.length - 10);
      }
    } catch (e) {
      loader.remove();
      addMessage('ai', 'Sorry, I\'m having trouble connecting right now. Please try again.');
      history.pop();
    }

    panel.querySelector('#wc-send').disabled = false;
    input.focus();
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  window.WrenChat = {
    init(opts) {
      cfg = Object.assign({}, cfg, opts);
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', buildWidget);
      } else {
        buildWidget();
      }
    }
  };

  // Auto-init from meta tag if no explicit init within 800ms
  setTimeout(function () {
    if (!document.getElementById('wren-chat-btn')) {
      const meta = document.querySelector('meta[name="wren-edition"]');
      if (meta) {
        const edition = meta.content;
        const personaMap = { ladn: 'eyfs', eyfs: 'eyfs', primary: 'eyfs', secondary: 'eyfs', admin: 'admin', 'ladn-hr': 'hr', parents: 'parents' };
        cfg.persona = personaMap[edition] || 'eyfs';
        buildWidget();
      }
    }
  }, 800);

})();
