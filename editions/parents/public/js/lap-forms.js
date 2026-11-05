/* lap-forms.js — b343 (2026-09-21)
 * The standing "Waiting for you" card on the home screen: paperwork a parent is asked to read and sign
 * (medicine, accident, reports, two-year checks) and the funding declaration when one is owed.
 *
 *   mounts itself into every [data-forms-prompt] on DOMContentLoaded
 *
 * It only ever COUNTS. The server decides what is waiting (GET /welcome/forms/api/prompt) and the card links to the
 * Forms screen. Empty (and invisible) when nothing is waiting. It never blocks anything: it is a card, not a gate,
 * and the parent can scroll straight past it to the diary, the journey or an invoice.
 * No emoji, inline stroke icon (currentColor), the parents-portal tokens — light and dark follow lap-boot.js.
 */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var ICON = '<svg class="lfm-i" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M7 3.5h7l4 4V20.5H7z"/><path d="M14 3.5v4h4"/><path d="m9.5 14 2 2 3.5-4"/></svg>';

  function css() {
    if (document.querySelector('style[data-lfm]')) return;
    var s = document.createElement('style'); s.setAttribute('data-lfm', '1');
    s.textContent =
      '.lfm{display:flex;gap:12px;align-items:flex-start;background:var(--surface,#fff);border:1px solid var(--orange,#f0a050);border-left:5px solid var(--orange,#f0a050);' +
        'border-radius:14px;padding:14px 16px;margin:0 0 14px;text-decoration:none;color:var(--text,#2a2a2a)}' +
      '.lfm:focus-visible{outline:3px solid var(--orange,#f0a050);outline-offset:2px}' +
      '.lfm .lfm-i{width:24px;height:24px;flex:0 0 auto;margin-top:1px;color:var(--lap-ink,var(--green,#2d5a4a))}' +
      '.lfm-t{font-weight:800;font-size:1rem;line-height:1.3;color:var(--text,#2a2a2a)}' +
      '.lfm-s{font-size:.88rem;line-height:1.5;color:var(--text-m,#5a5a5a);margin-top:3px}' +
      '.lfm-go{display:inline-block;margin-top:8px;font-weight:800;font-size:.88rem;color:var(--lap-ink,var(--green,#2d5a4a))}';
    document.head.appendChild(s);
  }

  function mount(el) {
    fetch('/welcome/forms/api/prompt', { credentials: 'same-origin' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (d) {
      if (!d || !d.count) { el.innerHTML = ''; return; }
      css();
      var n = d.count, t = n === 1 ? 'One thing is waiting for you' : n + ' things are waiting for you';
      el.innerHTML = '<a class="lfm" href="' + esc(d.href || '/welcome/forms') + '">' + ICON +
        '<div><div class="lfm-t">' + esc(t) + '</div>' +
        '<div class="lfm-s">A form to read and sign. It only takes a minute, and nothing else in the app is held up by it.</div>' +
        '<span class="lfm-go">Open Forms →</span></div></a>';
    }).catch(function () { /* a card that cannot load simply is not there */ });
  }

  document.addEventListener('DOMContentLoaded', function () {
    Array.prototype.forEach.call(document.querySelectorAll('[data-forms-prompt]'), mount);
  });
  window.LapForms = { mount: mount };
})();
