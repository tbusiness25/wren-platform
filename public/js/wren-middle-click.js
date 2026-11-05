/* wren-middle-click.js — 2026-10-28 (Toby: "I can't middle click to open something in a new tab").
 * Real links already work. Most of Wren's rows, cards and sidebar buttons navigate in JavaScript
 * (data-href, data-section, or an inline onclick that sets location.href), so the browser has no
 * URL to open in a new tab. This finds that URL and opens it — middle click, or Ctrl/Cmd + click.
 * The page can add its own: window.WrenMiddleClick.resolvers.push(el => url | null).
 * Never acts on a real <a href> (the browser does that itself) or on a form control. */
(function () {
  if (window.WrenMiddleClick) return;
  var resolvers = [];
  function fromOnclick(code) {
    if (!code) return null;
    // location.href = '/x' (+ 'y' + 12 …) — string and number literals only, nothing evaluated.
    var m = code.match(/location(?:\.href)?\s*=\s*((?:\s*(?:'[^']*'|"[^"]*"|`[^`$]*`|\d+)\s*\+?)+)/);
    if (!m) m = code.match(/location\.assign\(\s*((?:\s*(?:'[^']*'|"[^"]*"|`[^`$]*`|\d+)\s*\+?)+)\)/);
    if (m) {
      var parts = m[1].match(/'[^']*'|"[^"]*"|`[^`$]*`|\d+/g) || [];
      var url = parts.map(function (p) { return /^\d+$/.test(p) ? p : p.slice(1, -1); }).join('');
      return url || null;
    }
    var n = code.match(/Wren\.navigate\(\s*['"]([\w-]+)['"](?:\s*,\s*['"]([\w-]+)['"])?/);
    if (n && window.Wren && Wren.sectionUrl) return Wren.sectionUrl(n[1], n[2]);
    return null;
  }
  function urlFor(target) {
    var el = target && target.closest ? target : null;
    if (!el) return null;
    if (el.closest('input, textarea, select, [contenteditable="true"]')) return null;
    var a = el.closest('a[href]');
    if (a) {
      var h = a.getAttribute('href') || '';
      if (h && h !== '#' && !/^javascript:/i.test(h)) return { native: true };
    }
    for (var i = 0; i < resolvers.length; i++) {
      try { var r = resolvers[i](el); if (r) return { url: r }; } catch (e) { /* next */ }
    }
    var dh = el.closest('[data-href]');
    if (dh && dh.getAttribute('data-href')) return { url: dh.getAttribute('data-href') };
    var ds = el.closest('[data-section]');
    if (ds && window.Wren && Wren.sectionUrl) {
      var su = Wren.sectionUrl(ds.getAttribute('data-section'), ds.getAttribute('data-tab'));
      if (su) return { url: su };
    }
    var node = el;
    for (var depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      var u = fromOnclick(node.getAttribute && node.getAttribute('onclick'));
      if (u) return { url: u };
    }
    return null;
  }
  function open(e) {
    var hit = urlFor(e.target);
    if (!hit || hit.native) return false;
    e.preventDefault(); e.stopPropagation();
    window.open(new URL(hit.url, location.href).href, '_blank', 'noopener');
    return true;
  }
  // Middle button: stop Linux/Windows autoscroll on a target we can open.
  document.addEventListener('mousedown', function (e) {
    if (e.button === 1) { var hit = urlFor(e.target); if (hit && !hit.native) e.preventDefault(); }
  }, true);
  document.addEventListener('auxclick', function (e) { if (e.button === 1) open(e); }, true);
  // Ctrl/Cmd + click opens in a new tab too, as on any web page.
  document.addEventListener('click', function (e) { if (e.button === 0 && (e.ctrlKey || e.metaKey)) open(e); }, true);
  window.WrenMiddleClick = { resolvers: resolvers, urlFor: urlFor };
})();
