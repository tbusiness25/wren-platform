/* device-detect.js — run before wren-shell to set body classes early */
(function () {
  var ua = navigator.userAgent || '';
  var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  var mobile = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua) ||
               (platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPad on iOS13+
  var tablet = mobile && Math.min(screen.width, screen.height) >= 600;
  var ios    = /iPad|iPhone|iPod/.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var android = /Android/i.test(ua);
  var standalone = window.matchMedia('(display-mode: standalone)').matches ||
                   window.navigator.standalone === true;

  var cls = [];
  if (mobile)     cls.push('is-mobile');
  if (tablet)     cls.push('is-tablet');
  if (!mobile)    cls.push('is-desktop');
  if (ios)        cls.push('is-ios');
  if (android)    cls.push('is-android');
  if (standalone) cls.push('is-pwa');

  cls.forEach(function (c) { document.documentElement.classList.add(c); });

  /* Expose for JS use */
  window.WrenDevice = { mobile: mobile, tablet: tablet, desktop: !mobile, ios: ios, android: android, pwa: standalone };
})();
