/* lap-outstanding.js — b502 (2026-10-17)
 * The persistent "To do" card on the parents' home screen: the details THIS family still has to give the nursery, each one linking to the
 * screen that fixes it. It stays until the items are done (it is a card, not a gate: nothing else in the app waits on it) and it disappears
 * by itself when the last item is filled in.
 *
 *   mounts itself into every [data-outstanding-prompt] on DOMContentLoaded
 *
 * The server decides what is outstanding (GET /welcome/forms/api/outstanding): only this family's own children, only things a parent can
 * supply. No emoji, inline stroke icon, parents-portal tokens (light and dark follow lap-boot.js). */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var ICON = '<svg class="lot-i" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="4" y="3.5" width="16" height="17" rx="2.5"/><path d="m8 9 1.6 1.6L12.5 7.7"/><path d="M14 9.5h3.5M8 15h9.5"/></svg>';

  function css() {
    if (document.querySelector('style[data-lot]')) return;
    var s = document.createElement('style'); s.setAttribute('data-lot', '1');
    s.textContent =
      '.lot{background:var(--surface);border:1px solid var(--orange);border-left:5px solid var(--orange);border-radius:14px;padding:14px 16px;margin:0 0 14px;color:var(--text)}' +
      '.lot-h{display:flex;gap:12px;align-items:flex-start}' +
      '.lot .lot-i{width:24px;height:24px;flex:0 0 auto;margin-top:1px;color:var(--lap-ink,var(--green))}' +
      '.lot-t{font-weight:800;font-size:1rem;line-height:1.3}' +
      '.lot-s{font-size:.88rem;line-height:1.5;color:var(--text-m);margin-top:3px}' +
      '.lot-l{list-style:none;margin:10px 0 0;padding:0}' +
      '.lot-l li{border-top:1px solid var(--border)}' +
      '.lot-l a{display:flex;justify-content:space-between;gap:10px;align-items:center;min-height:44px;padding:8px 2px;color:var(--text);text-decoration:none;font-size:.92rem}' +
      '.lot-l a:focus-visible{outline:3px solid var(--orange);outline-offset:2px}' +
      '.lot-go{font-weight:800;color:var(--lap-ink,var(--green));white-space:nowrap}';
    document.head.appendChild(s);
  }

  function mount(el) {
    fetch('/welcome/forms/api/outstanding', { credentials: 'same-origin' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (d) {
      if (!d || !d.count) { el.innerHTML = ''; return; }
      css();
      var many = {}; d.items.forEach(function (i) { many[i.child_id] = true; });
      var multi = Object.keys(many).length > 1;
      var n = d.count, t = n === 1 ? 'To do: one thing is still needed' : 'To do: ' + n + ' things are still needed';
      var when = d.deadline ? ' Please finish them by ' + new Date(d.deadline + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) + '.' : '';
      el.innerHTML = '<div class="lot" role="region" aria-label="To do"><div class="lot-h">' + ICON + '<div><div class="lot-t">' + esc(t) + '</div>' +
        '<div class="lot-s">The nursery needs these details. Each one takes a minute and nothing else in the app is held up by it.' + esc(when) + '</div></div></div>' +
        '<ul class="lot-l">' + d.items.map(function (i) {
          return '<li><a href="' + esc(i.href) + '"><span>' + esc(i.label) + (multi ? ' <span style="opacity:.75">(' + esc(i.child_name) + ')</span>' : '') + '</span><span class="lot-go">Do it →</span></a></li>';
        }).join('') + '</ul></div>';
    }).catch(function () { /* a card that cannot load simply is not there */ });
  }

  document.addEventListener('DOMContentLoaded', function () {
    Array.prototype.forEach.call(document.querySelectorAll('[data-outstanding-prompt]'), mount);
  });
  window.LapOutstanding = { mount: mount };
})();
