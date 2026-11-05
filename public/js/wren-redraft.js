/* wren-redraft.js — "✨ Redraft" for long text boxes (Aimey / Gmail-Polish style). 2026-11-02
 *
 * Opt-in: a page includes this script. It then offers a small "✨ Redraft" button on
 *   - every <textarea data-redraft>, and
 *   - by default every other multi-line, editable <textarea> on the page
 *     (opt one out with data-redraft="off").
 * Textareas added later (drawers, modals) are picked up automatically — the button is
 * a single floating element that follows the focused box, so no page layout changes.
 *
 * The rule is "how much to change": the default mode is a LIGHT polish (spelling,
 * grammar, clarity) that keeps the practitioner's own words. Nothing is ever replaced
 * automatically — the sheet shows a before/after diff and the user taps Use this.
 * Undo is offered afterwards. The text goes to POST /api/redraft, which only talks
 * to the local model on the Ascent (src/lib/sovereign-model.js).
 *
 * API: window.WrenRedraft.attach(textarea) / .open(textarea, mode)
 */
(function () {
  'use strict';
  if (window.WrenRedraft) return;

  var MODES = [
    { mode: 'polish',  label: 'Polish',             hint: 'Light touch — spelling, grammar and clarity. Your words stay yours.' },
    { mode: 'warmer',  label: 'Warmer for parents', hint: 'Friendlier wording for a parent to read. Same facts.' },
    { mode: 'shorter', label: 'Shorter',            hint: 'Trims repetition and filler. Keeps every fact.' },
    { mode: 'expand',  label: 'Full sentences',     hint: 'Turns quick notes into full sentences — only what you wrote.' },
  ];
  var MIN_WORDS = 3;

  // ── styles (tokens only — LADN-DESIGN-GUIDELINES colour rule) ────────────────
  var css = '' +
    '.wrd-btn{position:fixed;z-index:9990;display:none;align-items:center;gap:4px;min-height:32px;padding:4px 12px;' +
    'border-radius:16px;border:1px solid var(--c-border-strong);background:var(--c-surface-solid);color:var(--c-blue);' +
    'font:600 13px system-ui,Arial,sans-serif;cursor:pointer;box-shadow:0 2px 8px color-mix(in srgb,var(--c-text) 18%,transparent);transition:opacity .2s ease}' +
    '.wrd-btn:hover{background:color-mix(in srgb,var(--c-blue) 14%,var(--c-surface-solid))}' +
    '.wrd-ov{position:fixed;inset:0;z-index:9995;background:color-mix(in srgb,var(--c-bg) 70%,transparent);display:flex;align-items:flex-end;justify-content:center}' +
    '@media(min-width:700px){.wrd-ov{align-items:center}}' +
    '.wrd-sheet{width:100%;max-width:640px;max-height:90vh;overflow:auto;background:var(--c-surface-solid);color:var(--c-text);' +
    'border:1px solid var(--c-border);border-radius:16px 16px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom));font:15px/1.5 system-ui,Arial,sans-serif}' +
    '@media(min-width:700px){.wrd-sheet{border-radius:16px}}' +
    '.wrd-h{display:flex;align-items:center;justify-content:space-between;margin:0 0 10px;font:700 17px "Arial Rounded MT Bold",Nunito,Arial,sans-serif}' +
    '.wrd-x{background:none;border:0;color:var(--c-muted);font-size:22px;min-width:44px;min-height:44px;cursor:pointer}' +
    '.wrd-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px}' +
    '.wrd-chip{min-height:36px;padding:4px 12px;border-radius:18px;border:1px solid var(--c-border-strong);background:var(--c-surface);color:var(--c-text);font:600 13px system-ui,Arial,sans-serif;cursor:pointer}' +
    '.wrd-chip[aria-pressed="true"]{background:var(--c-blue);color:var(--c-on-blue);border-color:var(--c-blue)}' +
    '.wrd-hint{color:var(--c-muted);font-size:13px;margin:0 0 10px}' +
    '.wrd-diff{white-space:pre-wrap;word-wrap:break-word;background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;padding:12px;min-height:80px}' +
    '.wrd-diff del{color:var(--c-danger);background:var(--c-danger-soft);text-decoration:line-through}' +
    '.wrd-diff ins{color:var(--c-ok);background:var(--c-ok-soft);text-decoration:none}' +
    '.wrd-meta{color:var(--c-muted);font-size:13px;margin:8px 0 0}' +
    '.wrd-warn{color:var(--c-warn);background:var(--c-warn-soft);border-radius:10px;padding:8px 10px;margin-top:8px;font-size:13px}' +
    '.wrd-note{color:var(--c-muted);font-size:12px;margin-top:8px}' +
    '.wrd-acts{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:12px}' +
    '.wrd-b{min-height:44px;padding:8px 16px;border-radius:12px;border:1px solid var(--c-border-strong);background:var(--c-surface);color:var(--c-text);font:600 14px system-ui,Arial,sans-serif;cursor:pointer;transition:background .2s ease}' +
    '.wrd-b.pri{background:var(--c-blue);color:var(--c-on-blue);border-color:var(--c-blue)}' +
    '.wrd-b[disabled]{opacity:.5;cursor:default}' +
    '.wrd-toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:9996;display:flex;gap:12px;align-items:center;' +
    'background:var(--c-surface-solid);color:var(--c-text);border:1px solid var(--c-border-strong);border-radius:12px;padding:8px 8px 8px 14px;font:14px system-ui,Arial,sans-serif;box-shadow:0 4px 14px color-mix(in srgb,var(--c-text) 20%,transparent)}';
  var st = document.createElement('style');
  st.id = 'wren-redraft-css';
  st.textContent = css;
  (document.head || document.documentElement).appendChild(st);

  // ── helpers ──────────────────────────────────────────────────────────────────
  function wordCount(s) { return (String(s || '').match(/[\p{L}\p{N}']+/gu) || []).length; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /** Word-level diff (LCS over word/space/punct tokens) → HTML with <del>/<ins>. */
  function diffHtml(a, b) {
    var A = String(a).match(/\s+|[\p{L}\p{N}']+|[^\s\p{L}\p{N}']/gu) || [];
    var B = String(b).match(/\s+|[\p{L}\p{N}']+|[^\s\p{L}\p{N}']/gu) || [];
    var n = A.length, m = B.length;
    if (n * m > 4e6) return '<ins>' + esc(b) + '</ins>';
    var L = []; for (var i = 0; i <= n; i++) L.push(new Uint16Array(m + 1));
    for (i = n - 1; i >= 0; i--) for (var j = m - 1; j >= 0; j--)
      L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    var out = [], del = '', ins = '';
    function flush() { if (del) out.push('<del>' + esc(del) + '</del>'); if (ins) out.push('<ins>' + esc(ins) + '</ins>'); del = ins = ''; }
    i = 0; j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { flush(); out.push(esc(A[i])); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) del += A[i++];
      else ins += B[j++];
    }
    while (i < n) del += A[i++];
    while (j < m) ins += B[j++];
    flush();
    return out.join('');
  }

  function eligible(el) {
    if (!el || el.tagName !== 'TEXTAREA') return false;
    var flag = el.getAttribute('data-redraft');
    if (flag === 'off' || flag === 'false') return false;
    if (el.readOnly || el.disabled) return false;
    if (flag !== null) return true;
    var rows = parseInt(el.getAttribute('rows') || '2', 10);
    return rows >= 2;
  }

  function api(body) {
    if (window.Wren && typeof window.Wren.api === 'function') {
      return window.Wren.api('/api/redraft', { method: 'POST', body: body });
    }
    var tok = null; try { tok = sessionStorage.getItem('wrenToken'); } catch (_) {}
    return fetch('/api/redraft', { method: 'POST', credentials: 'same-origin',
      headers: Object.assign({ 'Content-Type': 'application/json' }, tok ? { Authorization: 'Bearer ' + tok } : {}),
      body: JSON.stringify(body) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return r.ok ? d : Promise.reject(d); });
    });
  }

  // ── the floating button ──────────────────────────────────────────────────────
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'wrd-btn';
  btn.setAttribute('aria-label', 'Redraft this text');
  btn.innerHTML = '<span aria-hidden="true">✨</span> Redraft';
  var current = null;

  function place() {
    if (!current || !document.contains(current) || wordCount(current.value) < MIN_WORDS) { btn.style.display = 'none'; return; }
    var r = current.getBoundingClientRect();
    if (r.width < 120 || r.bottom < 0 || r.top > window.innerHeight) { btn.style.display = 'none'; return; }
    btn.style.display = 'inline-flex';
    var bw = btn.offsetWidth || 96, bh = btn.offsetHeight || 32;
    btn.style.left = Math.max(4, Math.min(window.innerWidth - bw - 4, r.right - bw - 6)) + 'px';
    btn.style.top = Math.max(4, Math.min(window.innerHeight - bh - 4, r.bottom - bh - 6)) + 'px';
  }
  function ready() { if (!btn.parentNode) document.body.appendChild(btn); }

  document.addEventListener('focusin', function (e) {
    if (eligible(e.target)) { ready(); current = e.target; place(); }
  });
  document.addEventListener('focusout', function (e) {
    if (e.target === current) setTimeout(function () { if (document.activeElement !== current) { btn.style.display = 'none'; } }, 150);
  });
  document.addEventListener('input', function (e) { if (e.target === current) place(); });
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  // keep focus in the textarea when the button is pressed
  btn.addEventListener('pointerdown', function (e) { e.preventDefault(); });
  btn.addEventListener('click', function () { if (current) open(current, 'polish'); });

  // ── the sheet ────────────────────────────────────────────────────────────────
  function open(el, mode) {
    var original = el.value;
    if (wordCount(original) < MIN_WORDS) return;
    btn.style.display = 'none';
    var ov = document.createElement('div');
    ov.className = 'wrd-ov';
    ov.innerHTML =
      '<div class="wrd-sheet" role="dialog" aria-modal="true" aria-label="Redraft">' +
      '<div class="wrd-h"><span>✨ Redraft</span><button type="button" class="wrd-x" aria-label="Close">×</button></div>' +
      '<div class="wrd-chips" role="group" aria-label="How to redraft">' +
      MODES.map(function (m) { return '<button type="button" class="wrd-chip" data-mode="' + m.mode + '">' + esc(m.label) + '</button>'; }).join('') +
      '</div><p class="wrd-hint"></p>' +
      '<div class="wrd-diff" aria-live="polite"></div><div class="wrd-meta"></div><div class="wrd-warns"></div>' +
      '<div class="wrd-note">Red = removed, green = added. Read it through — nothing changes until you tap “Use this”. Runs on Wren’s own local AI — never a cloud service.</div>' +
      '<div class="wrd-acts"><button type="button" class="wrd-b" data-a="cancel">Keep mine</button>' +
      '<button type="button" class="wrd-b" data-a="again">Try again</button>' +
      '<button type="button" class="wrd-b pri" data-a="use" disabled>Use this</button></div></div>';
    document.body.appendChild(ov);
    var $ = function (s) { return ov.querySelector(s); };
    var result = null, seq = 0;

    function close() { ov.remove(); document.removeEventListener('keydown', onKey); try { el.focus(); } catch (_) {} }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);

    function run(m) {
      mode = m; result = null;
      var my = ++seq;
      ov.querySelectorAll('.wrd-chip').forEach(function (c) { c.setAttribute('aria-pressed', c.dataset.mode === m ? 'true' : 'false'); });
      $('.wrd-hint').textContent = (MODES.filter(function (x) { return x.mode === m; })[0] || {}).hint || '';
      $('.wrd-diff').textContent = 'Redrafting…';
      $('.wrd-meta').textContent = ''; $('.wrd-warns').innerHTML = '';
      $('[data-a="use"]').disabled = true; $('[data-a="again"]').disabled = true;
      api({ mode: m, text: original }).then(function (d) {
        if (my !== seq || !d) return;
        result = String(d.result || '');
        if (result.trim() === original.trim()) {
          $('.wrd-diff').textContent = original;
          $('.wrd-meta').textContent = 'No changes needed — it reads well as it is.';
        } else {
          $('.wrd-diff').innerHTML = diffHtml(original, result);
          $('.wrd-meta').textContent = 'Changed about ' + (d.changed_pct || 0) + '% of the words.';
          $('[data-a="use"]').disabled = false;
        }
        (d.warnings || []).forEach(function (w) {
          var div = document.createElement('div'); div.className = 'wrd-warn'; div.textContent = '⚠ ' + w; $('.wrd-warns').appendChild(div);
        });
        $('[data-a="again"]').disabled = false;
      }, function (err) {
        if (my !== seq) return;
        $('.wrd-diff').textContent = (err && err.error) || 'Redraft is unavailable right now.';
        $('[data-a="again"]').disabled = false;
      });
    }

    ov.addEventListener('click', function (e) {
      if (e.target === ov || e.target.closest('.wrd-x') || e.target.closest('[data-a="cancel"]')) return close();
      var chip = e.target.closest('.wrd-chip'); if (chip) return run(chip.dataset.mode);
      if (e.target.closest('[data-a="again"]')) return run(mode);
      if (e.target.closest('[data-a="use"]') && result != null) {
        if (el.value !== original) { // the box changed under us (outbox restore, voice)
          $('.wrd-meta').textContent = 'The text changed while redrafting — close and try again.'; return;
        }
        el.value = result;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        close();
        undoToast(el, original, result);
      }
    });
    run(mode || 'polish');
  }

  function undoToast(el, before, after) {
    var old = document.querySelector('.wrd-toast'); if (old) old.remove();
    var t = document.createElement('div');
    t.className = 'wrd-toast'; t.setAttribute('role', 'status');
    t.innerHTML = '<span>Redraft applied.</span><button type="button" class="wrd-b">Undo</button>';
    document.body.appendChild(t);
    var timer = setTimeout(function () { t.remove(); }, 10000);
    t.querySelector('button').addEventListener('click', function () {
      clearTimeout(timer); t.remove();
      if (el.value === after) {
        el.value = before;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      try { el.focus(); } catch (_) {}
    });
  }

  window.WrenRedraft = {
    attach: function (el) { if (el) el.setAttribute('data-redraft', ''); },
    open: open,
    _diffHtml: diffHtml,
  };
})();
