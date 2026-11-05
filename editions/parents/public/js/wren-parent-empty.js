/* wren-parent-empty.js (b339, 2026-09-18) — one empty state for the whole parents app.
 *
 * Every list screen used to print its own bare sentence ("No diary entries yet…"),
 * each worded, sized and coloured differently. EYParent draws an illustration and
 * says one line on every empty screen, and a parent learns that shape once. This is
 * the only place those are made, so they cannot drift:
 *
 *   WrenParentEmpty.render(el, 'diary');                              // defaults
 *   WrenParentEmpty.render(el, 'messages', { action: { label: 'New message', onClick: fn } });
 *   el.innerHTML = WrenParentEmpty.html('invoices', { text: 'Nothing due this month.' });
 *
 * kind    diary journey messages invoices events newsletters surveys resources
 *         bookings notifications payments nochild offline error generic
 * opts    title, text        override the default one-liners
 *         action             { label, href } or { label, onClick } — one button, optional
 *         compact            smaller, for a section inside a page rather than a whole screen
 *
 * Pictures are inline SVG drawn with three roles (outline / soft fill / warm accent)
 * that read from the page's colour tokens, so the same drawing is right in the light
 * and the dark theme. No images, no network, no dependencies. */
(function () {
  'use strict';
  if (window.WrenParentEmpty) return;

  var W = '<svg class="lap-ill" viewBox="0 0 120 96" role="img" aria-hidden="true" focusable="false">' +
          '<circle class="bg" cx="60" cy="50" r="40"/>';
  var SPARK = '<path class="wm" d="M18 26l1.6 4 4 1.6-4 1.6-1.6 4-1.6-4-4-1.6 4-1.6z"/>' +
              '<circle class="wm" cx="100" cy="24" r="2.6"/><circle class="ln-dot" cx="102" cy="72" r="2"/>';
  function svg(inner) { return W + inner + SPARK + '</svg>'; }

  var ART = {
    diary: svg(
      '<path class="fl ln" d="M60 30C50 24 34 24 26 28v42c8-4 24-4 34 2z"/>' +
      '<path class="fl ln" d="M60 30c10-6 26-6 34-2v42c-8-4-24-4-34 2z"/>' +
      '<path class="ln" d="M60 30v42M34 38h18M34 46h18M34 54h12M68 38h18M68 46h12"/>' +
      '<path class="wm" d="M78 25v17l5.5-4 5.5 4V25z"/>'),
    journey: svg(
      '<path class="fl ln" d="M44 62h32l-4 20H48z"/><path class="ln" d="M42 62h36"/>' +
      '<path class="ln" d="M60 62V40"/>' +
      '<path class="fl ln" d="M60 52C50 52 42 46 42 36c10 0 18 6 18 16z"/>' +
      '<path class="wm ln" d="M60 46c0-10 8-18 20-18 0 12-8 20-20 18z"/>'),
    messages: svg(
      '<path class="fl ln" d="M30 28h38a6 6 0 0 1 6 6v16a6 6 0 0 1-6 6H50L38 66V56h-8a6 6 0 0 1-6-6V34a6 6 0 0 1 6-6z"/>' +
      '<circle class="ln-dot" cx="36" cy="42" r="2.2"/><circle class="ln-dot" cx="47" cy="42" r="2.2"/><circle class="ln-dot" cx="58" cy="42" r="2.2"/>' +
      '<path class="wm ln" d="M58 46h30a6 6 0 0 1 6 6v14a6 6 0 0 1-6 6h-2v9l-10-9H58a6 6 0 0 1-6-6V52a6 6 0 0 1 6-6z"/>'),
    invoices: svg(
      '<path class="fl ln" d="M40 22h40v54l-5-4-5 4-5-4-5 4-5-4-5 4-5-4-5 4z"/>' +
      '<path class="ln" d="M48 33h24M48 42h24"/>' +
      '<circle class="wm" cx="60" cy="58" r="9"/>' +
      '<text x="60" y="62.5" text-anchor="middle" font-size="12" font-weight="800" fill="#3a2a12" font-family="Nunito,system-ui,sans-serif">£</text>'),
    events: svg(
      '<rect class="fl ln" x="30" y="28" width="60" height="48" rx="7"/>' +
      '<path class="wm ln" d="M30 43h60v-8a7 7 0 0 0-7-7H37a7 7 0 0 0-7 7z"/>' +
      '<path class="ln" d="M44 22v9M76 22v9"/>' +
      '<path class="wm" d="M60 49l3.2 6.6 7.2 1-5.2 5 1.2 7.2-6.4-3.4-6.4 3.4 1.2-7.2-5.2-5 7.2-1z"/>'),
    newsletters: svg(
      '<path class="fl ln" d="M34 26h44a4 4 0 0 1 4 4v42H38a4 4 0 0 1-4-4z"/>' +
      '<path class="fl ln" d="M82 40h10v28a4 4 0 0 1-4 4h-6"/>' +
      '<rect class="wm" x="42" y="34" width="18" height="12" rx="2"/>' +
      '<path class="ln" d="M65 36h10M65 44h10M42 54h32M42 62h22"/>'),
    surveys: svg(
      '<rect class="fl ln" x="34" y="26" width="52" height="52" rx="7"/>' +
      '<rect class="wm ln" x="47" y="19" width="26" height="12" rx="4"/>' +
      '<path class="ln" d="M44 46l4 4 7-8M62 46h16M44 62l4 4 7-8M62 62h16"/>'),
    resources: svg(
      '<path class="fl ln" d="M28 36a5 5 0 0 1 5-5h17l7 8h30a5 5 0 0 1 5 5v26a5 5 0 0 1-5 5H33a5 5 0 0 1-5-5z"/>' +
      '<path class="wm ln" d="M42 30h30v20H42z"/>' +
      '<path class="fl ln" d="M28 46a5 5 0 0 1 5-5h54a5 5 0 0 1 5 5v24a5 5 0 0 1-5 5H33a5 5 0 0 1-5-5z"/>' +
      '<path class="ln" d="M40 56h22M40 64h14"/>'),
    bookings: svg(
      '<rect class="fl ln" x="26" y="26" width="56" height="46" rx="7"/>' +
      '<path class="wm ln" d="M26 41h56v-8a7 7 0 0 0-7-7H33a7 7 0 0 0-7 7z"/>' +
      '<path class="ln" d="M40 20v9M68 20v9M38 52h12M58 52h12M38 62h12"/>' +
      '<circle class="fl ln" cx="84" cy="66" r="13"/><path class="ln" d="M84 58v8l5 3"/>'),
    notifications: svg(
      '<path class="fl ln" d="M60 26c-13 0-20 9-20 22v10l-6 8h52l-6-8V48c0-13-7-22-20-22z"/>' +
      '<path class="wm ln" d="M53 72a7 7 0 0 0 14 0"/><circle class="wm" cx="60" cy="21" r="3.5"/>'),
    payments: svg(
      '<rect class="fl ln" x="26" y="32" width="68" height="42" rx="7"/>' +
      '<path class="wm" d="M26 43h68v9H26z"/><path class="ln" d="M36 64h18"/>'),
    nochild: svg(
      '<circle class="fl ln" cx="54" cy="44" r="20"/><path class="ln" d="M69 59l17 17" style="stroke-width:4.5"/>' +
      '<path class="wm" d="M54 55c-10-7-12-14-7-18 3-3 7-1 7 2 0-3 4-5 7-2 5 4 3 11-7 18z"/>'),
    offline: svg(
      '<path class="fl ln" d="M40 68a14 14 0 0 1 1-28 18 18 0 0 1 34 5 12 12 0 0 1-2 23z"/>' +
      '<path class="wm ln" d="M34 30l54 48"/>'),
    error: svg(
      '<path class="fl ln" d="M40 68a14 14 0 0 1 1-28 18 18 0 0 1 34 5 12 12 0 0 1-2 23z"/>' +
      '<path class="wm ln" d="M60 44v12"/><circle class="wm" cx="60" cy="63" r="1.6"/>'),
    generic: svg(
      '<circle class="fl ln" cx="60" cy="50" r="24"/>' +
      '<path class="wm" d="M60 34l4.4 9 9.9 1.4-7.2 7 1.7 9.8-8.8-4.6-8.8 4.6 1.7-9.8-7.2-7 9.9-1.4z"/>')
  };

  // One line to say what this is, one to say what will happen. Warm, not clinical.
  var COPY = {
    diary:         ['Nothing in the diary yet', 'Meals, naps and nappies appear here as the team log them through the day.'],
    journey:       ['No moments shared yet', 'When your child’s key person shares a photo or an observation, you’ll find it here.'],
    messages:      ['No messages yet', 'Say hello to your child’s key person, the office or the manager.'],
    invoices:      ['All paid up', 'Nothing outstanding — thank you! New invoices will appear here.'],
    events:        ['No events coming up', 'Trips, celebrations and open days will be listed here.'],
    newsletters:   ['No newsletters yet', 'Every newsletter we send is kept here so you can read it again.'],
    surveys:       ['No surveys right now', 'When we’d like your views we’ll ask here — it only takes a couple of minutes.'],
    resources:     ['Nothing here yet', 'Guides, policies and documents from the nursery will appear here.'],
    bookings:      ['No bookings to show', 'Your child’s sessions and any extra days will be listed here.'],
    notifications: ['You’re all caught up', 'Updates from the nursery will appear here.'],
    payments:      ['No payments yet', 'Payments you make will be listed here.'],
    nochild:       ['We can’t find your child yet', 'Please check the office has your email address on file.'],
    offline:       ['You’re offline', 'Check your connection and we’ll pick up where you left off.'],
    error:         ['We couldn’t load that', 'Please try again in a moment.'],
    generic:       ['Nothing to show yet', 'Check back soon.']
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var CSS = '' +
    '.lap-empty{display:flex;flex-direction:column;align-items:center;text-align:center;padding:40px 24px 28px;color:var(--text,#2a2a2a)}' +
    '.lap-empty.compact{padding:22px 16px 14px}' +
    '.lap-empty .lap-ill{width:132px;height:auto;max-width:60%;margin-bottom:6px;overflow:visible}' +
    '.lap-empty.compact .lap-ill{width:96px}' +
    '.lap-ill .bg{fill:var(--lap-ill-bg,color-mix(in srgb,var(--green,#2d5a4a) 11%,transparent))}' +
    '.lap-ill .fl{fill:var(--surface,#fff)}' +
    '.lap-ill .ln{stroke:var(--lap-ink,var(--green,#2d5a4a));stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}' +
    '.lap-ill path.ln:not(.fl):not(.wm){fill:none}' +
    '.lap-ill .wm{fill:var(--lap-warm,#f0a050)}' +
    '.lap-ill .wm.ln{fill:var(--lap-warm,#f0a050)}' +
    '.lap-ill .ln-dot{fill:var(--lap-ink,var(--green,#2d5a4a))}' +
    '.lap-empty-t{font:800 1.08rem/1.25 Nunito,system-ui,-apple-system,Arial,sans-serif;letter-spacing:-.01em;color:var(--text,#2a2a2a);margin:8px 0 4px}' +
    '.lap-empty-p{font:500 .92rem/1.5 Nunito,system-ui,-apple-system,Arial,sans-serif;color:var(--text-m,#5a5a5a);max-width:290px;margin:0}' +
    '.lap-empty-a{display:inline-flex;align-items:center;justify-content:center;min-height:44px;margin-top:16px;padding:0 22px;' +
      'border:0;border-radius:12px;background:var(--green,#2d5a4a);color:var(--lap-on-fill,var(--lap-on-accent,#fff));' +
      'font:800 .92rem/1 Nunito,system-ui,sans-serif;text-decoration:none;cursor:pointer}';

  function ensureCss() {
    if (document.getElementById('lap-empty-css')) return;
    var s = document.createElement('style'); s.id = 'lap-empty-css'; s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function html(kind, opts) {
    opts = opts || {};
    var k = ART[kind] ? kind : 'generic';
    var copy = COPY[k];
    var a = opts.action;
    var act = '';
    if (a && a.label) {
      act = a.href
        ? '<a class="lap-empty-a" href="' + esc(a.href) + '">' + esc(a.label) + '</a>'
        : '<button type="button" class="lap-empty-a" data-lap-empty-act>' + esc(a.label) + '</button>';
    }
    return '<div class="lap-empty' + (opts.compact ? ' compact' : '') + '" role="status">' + ART[k] +
      '<div class="lap-empty-t">' + esc(opts.title || copy[0]) + '</div>' +
      '<p class="lap-empty-p">' + esc(opts.text || copy[1]) + '</p>' + act + '</div>';
  }

  function render(el, kind, opts) {
    if (!el) return;
    ensureCss();
    el.innerHTML = html(kind, opts);
    var a = opts && opts.action;
    if (a && a.onClick) {
      var b = el.querySelector('[data-lap-empty-act]');
      if (b) b.addEventListener('click', a.onClick);
    }
  }

  ensureCss();
  window.WrenParentEmpty = { html: html, render: render, kinds: Object.keys(ART),
    // the bare drawing, for screens that pair it with their own words (the first-run intro)
    art: function (kind) { return ART[kind] || ART.generic; } };
})();
