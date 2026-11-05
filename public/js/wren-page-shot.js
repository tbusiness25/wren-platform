/* ─────────────────────────────────────────────────────────────────────────────
 * wren-page-shot.js — b360 (2026-09-29).
 *
 * "Take a picture of this screen." Toby: "Maybe add a screenshot button."
 *
 *   WrenPageShot.capture()            -> Promise<dataURL>   (image/jpeg)
 *   WrenPageShot.capture({ target })  -> capture one element instead of the page
 *   WrenPageShot.supported()          -> boolean, cheap
 *
 * ── WHY THIS FILE EXISTS RATHER THAN html2canvas ────────────────────────────
 * The brief says "bundled locally; no CDN", and it is right to: the tablets in
 * the rooms run on the nursery's own network against an on-site server, Wren
 * pulls nothing from a third party at runtime, and adding a 200KB script from
 * somebody else's CDN to every page would be the first exception to that. This
 * is ~180 lines and does the one thing the button needs.
 *
 * ── HOW IT WORKS ────────────────────────────────────────────────────────────
 * A browser will not hand a page a picture of itself. What it WILL do is render
 * an <svg> containing a <foreignObject> — and a foreignObject can hold ordinary
 * HTML. So: clone the DOM, inline the CSS, inline the images, wrap the lot in an
 * SVG the size of the viewport, load that SVG into an <img>, draw the <img> onto
 * a canvas, and read the canvas back as a data URL.
 *
 * ── WHAT IT CANNOT DO, SAID PLAINLY ─────────────────────────────────────────
 * An SVG loaded as an image runs in a restricted mode: it may not fetch ANY
 * external resource. That is a security rule and it is not negotiable, so —
 *   • fonts fall back to the system font. public/css/wren.css @imports Nunito
 *     from fonts.googleapis.com, which is cross-origin, so its rules cannot be
 *     read and would not load inside the SVG even if they could. The picture is
 *     of the right screen in the wrong typeface. For "this button is in the
 *     wrong place" that is fine, and it is the reason the page ALSO offers a
 *     plain upload from the tablet's gallery.
 *   • CSS background-images do not appear, and a gradient or a color-mix() fill
 *     can flatten, so cards come out plainer than they look on screen. Text,
 *     layout and position are right, which is what a report needs. <img>
 *     elements DO appear — they are inlined below, one by one, as data URLs.
 *   • <canvas>, <video> and cross-origin images are skipped. A cross-origin
 *     image drawn to a canvas taints it and toDataURL() then throws, which would
 *     lose the whole capture rather than one picture.
 *   • iframes render empty.
 * Every one of those degrades the picture. None of them throws: capture()
 * rejects only if the browser refuses the whole thing, and the caller falls back
 * to "add a picture from the tablet instead".
 *
 * ── AND WHAT IT MUST NOT DO ─────────────────────────────────────────────────
 * A screenshot of a Wren page can show a child's name. This file NEVER uploads,
 * stores or transmits anything — it returns a data URL to its caller and forgets
 * it. The upload is /api/feedback's job, the resulting file is manager-only
 * (GET /api/feedback/:id/shots), and the page warns the person before they send.
 * Anything carrying data-no-capture is removed from the clone first, which is
 * how the feedback panel keeps itself out of its own screenshot.
 * ───────────────────────────────────────────────────────────────────────────── */
;(function () {
  'use strict';
  if (window.WrenPageShot) return;

  var MAX_W = 1400;          // cap the drawn width; tablets are 1280 or less
  var MAX_H = 2200;          // a very tall viewport is cropped rather than refused
  var MAX_IMAGES = 60;       // inlining is the slow part
  var MAX_IMAGE_PX = 1600;   // downscale a huge photo before inlining it
  var TIMEOUT_MS = 12000;

  function supported() {
    return !!(window.XMLSerializer && document.createElement('canvas').getContext &&
              window.Blob && window.Promise);
  }

  // ── The CSS ────────────────────────────────────────────────────────────────
  // Same-origin sheets only: reading .cssRules on a cross-origin sheet throws a
  // SecurityError, which is exactly what happens to the Google Fonts @import.
  // Skipped, not fatal — see the header.
  function collectCss() {
    var out = [];
    for (var i = 0; i < document.styleSheets.length; i++) {
      var sheet = document.styleSheets[i];
      var rules = null;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      if (!rules) continue;
      for (var j = 0; j < rules.length; j++) {
        var t = rules[j].cssText;
        // @import cannot resolve inside the SVG and @font-face would need the
        // font file inlined; dropping both keeps the SVG parseable.
        if (/^@import/i.test(t) || /^@font-face/i.test(t)) continue;
        out.push(t);
      }
    }
    return out.join('\n');
  }

  // ── The images ─────────────────────────────────────────────────────────────
  // Draw each already-loaded <img> onto a scratch canvas and read it back. Same
  // origin only; a cross-origin one taints the canvas and toDataURL() throws, so
  // it is left alone and simply renders blank inside the SVG.
  function inlineImages(original, clone) {
    var src = original.querySelectorAll('img');
    var dst = clone.querySelectorAll('img');
    var n = Math.min(src.length, dst.length, MAX_IMAGES);
    for (var i = 0; i < n; i++) {
      var im = src[i];
      if (!im.complete || !im.naturalWidth) { dst[i].removeAttribute('src'); continue; }
      try {
        var w = im.naturalWidth, h = im.naturalHeight;
        var s = Math.min(1, MAX_IMAGE_PX / Math.max(w, h));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * s));
        c.height = Math.max(1, Math.round(h * s));
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        dst[i].setAttribute('src', c.toDataURL('image/png'));
      } catch (e) {
        dst[i].removeAttribute('src');      // tainted or cross-origin — leave it blank
      }
    }
    for (var k = n; k < dst.length; k++) dst[k].removeAttribute('src');
  }

  // A clone does not carry what somebody has typed — value / checked / selected
  // live on the element, not in the attribute. Copy them across, or the picture
  // shows an empty form.
  function copyFormState(original, clone) {
    var pairs = [['input', 1], ['textarea', 2], ['select', 3]];
    pairs.forEach(function (p) {
      var a = original.querySelectorAll(p[0]);
      var b = clone.querySelectorAll(p[0]);
      for (var i = 0; i < Math.min(a.length, b.length); i++) {
        if (p[1] === 1) {
          if (a[i].type === 'checkbox' || a[i].type === 'radio') {
            if (a[i].checked) b[i].setAttribute('checked', 'checked');
            else b[i].removeAttribute('checked');
          } else if (a[i].type !== 'password' && a[i].type !== 'file') {
            b[i].setAttribute('value', a[i].value || '');
          }
        } else if (p[1] === 2) {
          b[i].textContent = a[i].value || '';
        } else {
          var opts = b[i].querySelectorAll('option');
          for (var j = 0; j < opts.length; j++) {
            if (j === a[i].selectedIndex) opts[j].setAttribute('selected', 'selected');
            else opts[j].removeAttribute('selected');
          }
        }
      }
    });
  }

  function capture(opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      if (!supported()) return reject(new Error('This browser cannot take a picture of the screen.'));

      var source = opts.target || document.documentElement;
      var rect = opts.target ? opts.target.getBoundingClientRect() : null;
      var w = Math.min(MAX_W, Math.round(rect ? rect.width : (window.innerWidth || 1024)));
      var h = Math.min(MAX_H, Math.round(rect ? rect.height : (window.innerHeight || 768)));
      if (w < 1 || h < 1) return reject(new Error('Nothing on screen to capture.'));

      var clone;
      try {
        clone = source.cloneNode(true);

        // Things that must not be in the picture, and things that cannot be.
        Array.prototype.forEach.call(
          clone.querySelectorAll('script, link[rel="stylesheet"], noscript, [data-no-capture]'),
          function (el) { if (el.parentNode) el.parentNode.removeChild(el); });

        copyFormState(source, clone);
        inlineImages(source, clone);

        // Scroll position. The clone starts at the top of the document, so the
        // whole thing is shifted up by however far down the page the person is —
        // which is what makes this a picture of THEIR screen, not of the header.
        if (!opts.target) {
          var top = window.pageYOffset || document.documentElement.scrollTop || 0;
          var left = window.pageXOffset || document.documentElement.scrollLeft || 0;
          clone.setAttribute('style', (clone.getAttribute('style') || '') +
            ';margin:' + (-top) + 'px 0 0 ' + (-left) + 'px !important;width:' + w + 'px;' +
            'overflow:hidden;');
        }
      } catch (e) { return reject(e); }

      var css, markup;
      try {
        css = collectCss().replace(/\]\]>/g, ']]&gt;');
        markup = new XMLSerializer().serializeToString(clone);
      } catch (e) { return reject(e); }

      // The background. An SVG is transparent and a JPEG renders transparent as
      // black, so the page's own background colour is painted onto the canvas
      // first rather than letting the picture come out on a black field.
      var bg = 'var(--c-bg)';   // replaced below by the RESOLVED colour — canvas cannot read a token
      var TRANSPARENT = 'rgba(0, 0, 0, 0)';   // colour-ok: the string getComputedStyle RETURNS for "no background"; a comparison, not a colour choice
      try {
        bg = getComputedStyle(document.body).backgroundColor;
        if (!bg || bg === TRANSPARENT || bg === 'transparent') {
          bg = getComputedStyle(document.documentElement).backgroundColor;
        }
        // Last resort only. A token cannot be resolved here — this is a canvas
        // fillStyle, not CSS — and a transparent fill renders the JPEG on black.
        if (!bg || bg === TRANSPARENT || bg === 'transparent') bg = '#0f172a';  // colour-ok: canvas fillStyle fallback, no token is resolvable at this point
      } catch (e) { bg = '#0f172a'; }  // colour-ok: canvas fillStyle fallback, as above

      var svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
        '<style type="text/css"><![CDATA[' + css + ']]></style>' +
        '<foreignObject x="0" y="0" width="' + w + '" height="' + h + '">' +
        markup +
        '</foreignObject></svg>';

      var url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      var img = new Image();
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('Taking the picture took too long.'));
      }, TIMEOUT_MS);

      img.onload = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          var ratio = Math.min(2, window.devicePixelRatio || 1);
          var c = document.createElement('canvas');
          c.width = Math.round(w * ratio);
          c.height = Math.round(h * ratio);
          var ctx = c.getContext('2d');
          ctx.fillStyle = bg;
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          // JPEG at 0.85: a 1280x800 Wren page lands around 150-250KB, well
          // inside the 6MB-per-shot server cap and the EY portal's 16m nginx
          // limit even with four of them.
          resolve(c.toDataURL('image/jpeg', 0.85));
        } catch (e) { reject(e); }
      };
      img.onerror = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error('This screen could not be turned into a picture.'));
      };
      img.src = url;
    });
  }

  window.WrenPageShot = { capture: capture, supported: supported };
}());
