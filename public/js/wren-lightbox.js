// Shared parent-app media lightbox (2026-07-30) — tap any content photo/video to preview
// full-screen. Self-injecting; attaches globally so every page that includes it gets it.
(function () {
  var css = document.createElement('style');
  css.textContent = '#wlb{position:fixed;inset:0;background:rgba(10,15,25,.92);z-index:9999;display:none;align-items:center;justify-content:center;padding:16px}#wlb.open{display:flex}#wlb img,#wlb video{max-width:96vw;max-height:90vh;border-radius:10px;box-shadow:0 8px 40px rgba(0,0,0,.5)}#wlb .wlb-x{position:absolute;top:14px;right:18px;background:rgba(255,255,255,.15);color:#fff;border:none;border-radius:50%;width:44px;height:44px;font-size:1.6rem;cursor:pointer;line-height:1;z-index:1}';
  document.head.appendChild(css);
  var ov = document.createElement('div');
  ov.id = 'wlb';
  ov.innerHTML = '<button class="wlb-x" aria-label="Close">×</button><div id="wlb-m"></div>';
  function mount() { if (!document.getElementById('wlb') && document.body) document.body.appendChild(ov); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();

  function isVid(u) { return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(u || ''); }
  function open(url) {
    mount();
    var m = document.getElementById('wlb-m');
    m.innerHTML = isVid(url) ? '<video src="' + url + '" controls autoplay playsinline></video>' : '<img src="' + url + '" alt="">';
    ov.classList.add('open'); document.body.style.overflow = 'hidden';
  }
  function close() { ov.classList.remove('open'); var m = document.getElementById('wlb-m'); if (m) m.innerHTML = ''; document.body.style.overflow = ''; }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && (t.id === 'wlb' || (t.className && String(t.className).indexOf('wlb-x') >= 0))) { close(); return; }
    if (!t || t.tagName !== 'IMG') return;
    if (t.closest && t.closest('nav,header,.nav,.nav-logo,.logo,.app-shell-nav')) return;   // skip chrome/logos
    var src = t.getAttribute('data-full') || t.src || '';
    var isMedia = t.hasAttribute('data-full')
      || t.className && /\blb-media\b/.test(t.className)
      || (t.closest && t.closest('.photos,.media,.gallery,[class*="photo"],[class*="media"],[class*="thumb"]'))
      || /(\/photo|\/upload|\/att|\/media|observations\/photo|\.jpe?g|\.png|\.webp|\.gif)/i.test(src);
    var bigEnough = t.hasAttribute('data-full') || (t.naturalWidth || t.width || 0) > 60;
    if (isMedia && bigEnough) { e.preventDefault(); open(src); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
})();
