// wren-anon-toggle.js — b402 (2026-10-06).
//
// One shared "Anonymise (for sharing outside the nursery)" checkbox for every
// export/print button that wants anon mode (src/lib/pii-anon-mode.js on the
// server). Remembers the viewer's own last choice in localStorage — a per-
// person convenience only; it is never read by the server and never implies
// consent on its own, it just saves a click next time.
//
//   <span id="my-anon-slot"></span>
//   WrenAnonToggle.mount('my-anon-slot');
//   ...
//   fetch('/api/x/export' + (WrenAnonToggle.isOn() ? '?anon=1' : ''))
'use strict';
(function (global) {
  var STORAGE_KEY = 'wren-anon-toggle';

  function remembered() {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch (e) { return false; }
  }
  function remember(on) {
    try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch (e) { /* private window etc — harmless */ }
  }

  /**
   * @param {string|HTMLElement} container  an element, or an id to find one
   * @param {object} [opts]
   * @param {string} [opts.label]      checkbox label text
   * @param {string} [opts.id]         element id for the <input>
   * @param {string} [opts.className]  extra class on the wrapping <label>
   * @param {(on: boolean) => void} [opts.onChange]
   * @returns {{isOn: () => boolean, el: HTMLElement}|null}
   */
  function mount(container, opts) {
    opts = opts || {};
    var el = typeof container === 'string' ? document.getElementById(container) : container;
    if (!el) return null;

    var id = opts.id || ('wren-anon-toggle-' + Math.random().toString(36).slice(2, 8));
    var wrap = document.createElement('label');
    wrap.className = 'wren-anon-toggle' + (opts.className ? ' ' + opts.className : '');
    wrap.setAttribute('for', id);
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-size:.82rem;'
      + 'color:var(--c-muted);cursor:pointer;user-select:none;white-space:nowrap;';

    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = id;
    cb.checked = remembered();

    var span = document.createElement('span');
    span.textContent = opts.label || 'Anonymise (for sharing outside the nursery)';
    span.title = 'Replaces names, emails, phone numbers, addresses and other personal '
      + 'details with labels like "Child C-4F2A" before the download. Nothing on screen changes.';

    wrap.appendChild(cb);
    wrap.appendChild(span);
    el.appendChild(wrap);

    cb.addEventListener('change', function () {
      remember(cb.checked);
      if (typeof opts.onChange === 'function') opts.onChange(cb.checked);
    });

    return { isOn: function () { return cb.checked; }, el: wrap };
  }

  global.WrenAnonToggle = { mount: mount, isOn: remembered };
})(window);
