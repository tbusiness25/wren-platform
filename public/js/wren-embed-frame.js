/* Wren — embedded-page frames (b296, 2026-09-09)
 * ────────────────────────────────────────────────────────────────────────────
 * Toby, 2026-09-09, on the "Open full screen ↗" buttons:
 *   "is there a reason why we just can't have it on that screen in the first
 *    place? It just saves us an extra click. Why do we have the pop-ups —
 *    let's get rid."
 *
 * The pop-out existed because an embedded page used to sit in a frame of fixed
 * height and became a scroller inside a scroller. b220 embedded the pages;
 * 2026-09-08 sized the frames to their content; and the commit of 2026-09-09
 * ("the framework frame stops growing") stopped that sizing from oscillating.
 * With the frame the right height, the pop-out is a click that buys nothing.
 *
 * That working measurement logic lived inside two section files. Removing the
 * buttons means every other embedded tab needs it too, so it lives here now —
 * one implementation, not five copies drifting apart.
 *
 *   WrenEmbed.mount('frame-id')      // lazy: sets src from data-src on first call
 *   WrenEmbed.bind(frameElement)     // auto-height only, src already set
 *
 * Both are idempotent, so a tab loader can call mount() on every activation.
 *
 * Same-origin only. A cross-origin src throws on contentDocument, which is
 * caught: the frame keeps whatever height its CSS gives it rather than
 * collapsing to nothing.
 */
(function () {
  'use strict';

  var STYLE_ID = 'cur-embed-autoheight';   // kept: the two section files used this id

  /* The embedded page loads wren-shell-v2, whose CSS sets #wren-main to 100vh.
   * Inside a frame, 100vh IS the frame's height — so growing the frame grows the
   * inner document, which fires the observer, which grows the frame again. Kill
   * the viewport-relative heights before measuring anything. */
  function neutralise(d) {
    if (!d || d.getElementById(STYLE_ID)) return;
    var st = d.createElement('style');
    st.id = STYLE_ID;
    st.textContent =
      'html,body{height:auto!important;min-height:0!important;overflow:visible!important}' +
      '#wren-main{height:auto!important;min-height:0!important;overflow:visible!important}' +
      '#wren-sidebar,#wren-topbar{display:none!important}' +
      '#wren-main{margin-left:0!important;max-width:100%!important;padding-top:0!important}' +
      /* b521 — the same for pages built on wren-app-shell (focus-block.html,
       * planning-half-term.html). Those now skip their chrome inside a frame
       * (see _isEmbedded in wren-app-shell.js), so these ids should not exist;
       * this is the belt-and-braces half, so a page that has not been rebuilt
       * can never draw a second topbar/bottom nav inside the Roost content area. */
      '#wren-app-topbar,#wren-app-bottom,#wren-app-drawer,#wren-session-warning{display:none!important}' +
      '#wren-app-content{padding-top:0!important;padding-bottom:0!important;min-height:0!important}';
    (d.head || d.documentElement).appendChild(st);
  }

  function autoHeight(f) {
    var last = 0;
    function fit() {
      try {
        var d = f.contentDocument;
        if (!d || !d.body) return;
        neutralise(d);
        /* body only — documentElement inherits the viewport height and would
         * reopen the loop. And ignore sub-9px churn, or the observer and the
         * resize handler trade 1px changes forever. */
        var h = d.body.scrollHeight;
        if (h > 200 && Math.abs(h - last) > 8) {
          last = h;
          f.style.height = (h + 24) + 'px';
        }
      } catch (_) { /* cross-origin or not ready — leave the CSS height */ }
    }

    f.addEventListener('load', function () {
      fit();
      /* The inner page fetches and renders after load, so its height at load is
       * not its final height. Watch rather than guess a delay. */
      try {
        var d = f.contentDocument;
        if (d && window.ResizeObserver) new ResizeObserver(fit).observe(d.body);
        else [250, 800, 2000].forEach(function (t) { setTimeout(fit, t); });
      } catch (_) { [250, 800, 2000].forEach(function (t) { setTimeout(fit, t); }); }
    });
    window.addEventListener('resize', fit);
  }

  function bind(f) {
    if (!f || f.dataset.autoHeightBound) return f;
    autoHeight(f);
    f.dataset.autoHeightBound = '1';
    return f;
  }

  /* Lazy mount: bind the sizing, then set src from data-src the first time. A
   * second call is a no-op, so a tab loader may call it on every activation. */
  function mount(frameOrId, src) {
    var f = (typeof frameOrId === 'string') ? document.getElementById(frameOrId) : frameOrId;
    if (!f) return null;
    bind(f);
    var want = src || f.dataset.src;
    if (want && f.getAttribute('src') !== want) f.src = want;
    return f;
  }

  window.WrenEmbed = { mount: mount, bind: bind, VERSION: 'b521' };
})();
