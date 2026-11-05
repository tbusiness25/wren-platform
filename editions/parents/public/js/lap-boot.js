/* lap-boot.js (b339, 2026-09-18) — the part of the parents shell that has to run
 * BEFORE first paint. Loaded synchronously from <head> on every /welcome page,
 * ahead of the deferred /pwa.js.
 *
 * It does exactly three things and nothing else:
 *   1. marks <html> as the app shell (lap-shell + lap-home / lap-page) so the
 *      website chrome (nav, hero, footer) is hidden from the first frame;
 *   2. decides light or dark and writes it to <html data-lap-theme>, so a parent
 *      on a dark phone never sees a cream flash before the dark palette lands;
 *   3. steps aside when the parent has saved their own colours in Appearance.
 *
 * Light/dark is a per-device choice: localStorage 'lap.colour' = light | dark,
 * absent = follow the phone (prefers-color-scheme). A palette saved in the older
 * Appearance editor ('wren.theme') is an explicit, more specific choice and keeps
 * winning — it paints its own colours inline, so the dark token set is switched
 * off for that device (html.lap-custom) rather than fought. The one exception is a
 * saved palette identical to the stock Classic-green look: that is not a choice,
 * it is the default written down, so it is cleared and dark mode can work.
 * Everything is try/catch — private browsing may throw on any storage call. */
(function () {
  'use strict';
  try {
    var de = document.documentElement, p = location.pathname;
    de.classList.add('lap-shell', (p === '/welcome' || p === '/') ? 'lap-home' : 'lap-page');

    var custom = false;
    try {
      var raw = localStorage.getItem('wren.theme');
      if (raw) {
        var t = JSON.parse(raw);
        if (t && t.bg && t.text && t.accent) {
          var stock = String(t.bg).toLowerCase() === '#fefcf8' &&
                      String(t.text).toLowerCase() === '#2a2a2a' &&
                      String(t.accent).toLowerCase() === '#2d5a4a';
          // 2026-10-01 — an old three-colour palette could save light text on a light page
          // (the outstanding balance read as near-white on cream). A palette whose text and
          // page colours don't reach 3:1 is not a preference anyone can read: drop it and
          // let the normal light/dark theme draw the page.
          var lum = function (h) {
            h = String(h || '').replace('#', '');
            if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
            var c = [0, 2, 4].map(function (i) { var v = parseInt(h.slice(i, i + 2), 16) / 255;
              return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
            return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
          };
          var lb = lum(t.bg), lt = lum(t.text);
          var unreadable = !isFinite(lb) || !isFinite(lt) ||
            (Math.max(lb, lt) + 0.05) / (Math.min(lb, lt) + 0.05) < 3;
          if (stock || unreadable) localStorage.removeItem('wren.theme'); else custom = true;
        }
      }
    } catch (e) {}
    if (custom) { de.classList.add('lap-custom'); return; }

    var pref = 'auto';
    try { var v = localStorage.getItem('lap.colour'); if (v === 'light' || v === 'dark') pref = v; } catch (e) {}
    var dark = pref === 'dark' ||
      (pref === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    de.setAttribute('data-lap-theme', dark ? 'dark' : 'light');
    if (dark) de.classList.add('lap-dark');
  } catch (e) { /* the page still renders — just without the shell head-start */ }
})();
