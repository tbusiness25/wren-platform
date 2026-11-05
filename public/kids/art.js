/* art.js — Wren Kids picture helper (b507, 2026-10-18).
 *
 * Every picture in Wren Kids is a human-reviewed clipart illustration from Wren's own library
 * (scripts/kids/build-art.py copies them out of wren-media/illustrations/printables, which has
 * already been through the OCR and CLIP gates and a human pick). No third-party or copyrighted
 * art, ever. art.json is written by that script.
 *
 * Kids.art.ready()     promise that resolves once art.json is in (or has failed)
 * Kids.art.url(id)     'art/cat.webp', or null if that picture did not publish
 * Kids.art.img(id,alt) an <img> element, or an inline SVG placeholder if the picture is missing
 * Kids.art.families()  { 'at': ['cat','hat','mat','bat'], ... } — rhyme families that have pictures
 *
 * A missing picture is never fatal: the placeholder keeps the layout and the word is always
 * spoken and (for readers) printed, so a game stays playable with no art at all.
 */
(function (W) {
  'use strict';
  var Kids = W.Kids = W.Kids || {};
  var data = { pictures: {}, rhyme_families: {}, gpu: {} };
  var loaded = null;

  function load() {
    if (loaded) return loaded;
    loaded = fetch('art/art.json', { cache: 'force-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j) data = j; return data; })
      .catch(function () { return data; });
    return loaded;
  }

  function url(id) {
    var p = data.pictures[id] || data.gpu[id];
    return p ? 'art/' + p.file : null;
  }

  function placeholder(alt) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 100 100');
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', alt || '');
    s.innerHTML =
      '<rect x="6" y="6" width="88" height="88" rx="16" fill="none" ' +
      'stroke="currentColor" stroke-width="4" stroke-dasharray="8 7" opacity="0.45"/>' +
      '<circle cx="38" cy="40" r="8" fill="currentColor" opacity="0.35"/>' +
      '<path d="M16 78 L40 50 L58 68 L70 58 L84 78 Z" fill="currentColor" opacity="0.35"/>';
    return s;
  }

  function img(id, alt) {
    var u = url(id);
    if (!u) return placeholder(alt);
    var i = document.createElement('img');
    i.src = u;
    i.alt = alt || '';
    i.width = 320; i.height = 320;
    i.decoding = 'async';
    i.loading = 'lazy';
    return i;
  }

  Kids.art = {
    ready: load,
    url: url,
    img: img,
    has: function (id) { return !!url(id); },
    families: function () { return data.rhyme_families || {}; },
    all: function () { return data; }
  };
})(window);
