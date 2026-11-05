/* wren-branding.js — b297 (2026-09-09)
 * ---------------------------------------------------------------------------
 * One job: make a shared page say the name of the setting it is actually
 * serving, instead of the name of the first setting Wren was built for.
 *
 * Why it exists: the four-portal `ht` image serves editions/admin/public,
 * editions/parents/public and the shared public/ tree straight off the same host
 * checkout LADN uses. The parents shell therefore opened with "Your Nursery Day
 * Nursery" and Your Nursery' logo across the top — on two demos shown to other
 * settings. That is a lost sale, and arguably a GDPR question about the logo.
 *
 * Usage — mark up the elements and load the script:
 *     <h1 data-wren-brand="name">Your Nursery</h1>
 *     <img data-wren-brand="logo" src="/little-angels-logo.png" alt="">
 *     <title> is updated too, via data-wren-brand-title on <html> or a meta.
 *
 * The markup keeps its existing content as the fallback, so a page renders
 * exactly as it did before if the request fails. Additive; removes nothing.
 * Reads GET /api/public/branding, which returns a name and nothing else.
 */
(function () {
  'use strict';
  if (window.__wrenBranding) return;
  window.__wrenBranding = true;

  function apply(name) {
    if (!name) return;
    document.querySelectorAll('[data-wren-brand="name"]').forEach(function (el) {
      // Pages split the name across two coloured spans ("Your Nursery" +
      // "Day Nursery"). Collapse to one span so any name fits, and keep the
      // first span's colour so the wordmark still reads as a wordmark.
      el.textContent = name;
    });
    // Pages that split the wordmark into two coloured halves mark the second one
    // as name-tail: with a real setting name in the first span, "… Day Nursery"
    // trailing it would read "Hawthorn Tree Primary School Day Nursery".
    document.querySelectorAll('[data-wren-brand="name-tail"]').forEach(function (el) {
      el.textContent = '';
    });
    document.querySelectorAll('[data-wren-brand="name-text"]').forEach(function (el) {
      el.textContent = (el.dataset.wrenBrandPrefix || '') + name + (el.dataset.wrenBrandSuffix || '');
    });
    var t = document.querySelector('meta[name="wren-brand-title"]');
    if (t) document.title = t.content.replace('{setting}', name);
  }

  function applyLogo(logo, hasKey) {
    if (!hasKey) return;                      // older server: leave the markup alone
    document.querySelectorAll('img[data-wren-brand="logo"]').forEach(function (img) {
      if (logo) { img.src = logo; return; }
      // No logo for this setting. Remove the <img> rather than leaving a 1x1
      // stretched into a coloured tile where somebody else's mark used to be.
      img.remove();
    });
  }

  function run() {
    fetch('/api/public/branding', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        apply(d.name);
        applyLogo(d.logo, Object.prototype.hasOwnProperty.call(d, 'logo'));
      })
      .catch(function () { /* keep whatever the markup says */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
