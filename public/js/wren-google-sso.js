/* ───────────────────────────────────────────────────────────────────────────
 * b210 — "Sign in with Google" for the Roost (admin) and Seed (hr) login pages.
 *
 * Shared, so the two login pages cannot drift apart. Lives in the shared
 * public/ root, which both editions serve.
 *
 * It is entirely additive to the page it loads into: if SSO is not configured,
 * or the portal does not support it, this script injects nothing at all and the
 * PIN pad is exactly what it was. PIN login is never removed or hidden — some
 * staff have no Workspace mailbox, and a manager locked out of Google needs a
 * way in.
 *
 * The page opts in with:
 *     <div id="google-sso-slot"></div>
 *     <script>window.WREN_SSO = { redirect: '/index.html' };</script>
 *     <script src="/js/wren-google-sso.js"></script>
 *
 * Optional hooks the host page may define on window.WREN_SSO:
 *   onTotp(challengeToken) — the account needs its second factor; the page
 *                            should show its TOTP step. Without this hook the
 *                            user is told to sign in with their PIN instead.
 *   onDenied(data)         — Roost's manager allowlist refused the token.
 * ─────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // Set before anything else so a host page's own auto-login (remember-device,
  // existing-token bounce) can stand down while an SSO redeem is in flight.
  // Host pages that need it earlier still set this themselves in an inline
  // script above this one — same value, computed the same way.
  window.WREN_SSO_PENDING = !!new URLSearchParams(window.location.search).get('sso');

  var CFG = window.WREN_SSO || {};
  var REDIRECT = CFG.redirect || '/index.html';

  function slot() { return document.getElementById('google-sso-slot'); }

  function showError(msg) {
    var box = document.getElementById('sso-error');
    if (!box) {
      var host = slot();
      if (!host) { return; }
      box = document.createElement('p');
      box.id = 'sso-error';
      box.style.cssText = 'color:var(--c-red,#dc2626);text-align:center;font-size:.85rem;margin:10px 0 0';
      host.appendChild(box);
    }
    box.textContent = msg;
    box.style.display = 'block';
  }

  // Google's mark, inlined — no external request, so it works behind
  // Cloudflare Access and offline-first service workers alike.
  var G_SVG =
    '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" style="flex:none">' +
    '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>' +
    '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>' +
    '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>' +
    '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>' +
    '</svg>';

  function renderButton(cfg) {
    var host = slot();
    if (!host) { return; }
    var wrap = document.createElement('div');
    wrap.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;margin:18px 0 14px;color:#94a3b8;font-size:.75rem">' +
      '  <span style="flex:1;height:1px;background:var(--c-border,#e2e8f0)"></span>OR' +
      '  <span style="flex:1;height:1px;background:var(--c-border,#e2e8f0)"></span>' +
      '</div>' +
      '<a id="google-sso-btn" href="/api/auth/google/start" ' +
      '   style="display:flex;align-items:center;justify-content:center;gap:10px;width:100%;' +
      '          padding:12px 16px;border:1px solid var(--c-border,#dadce0);border-radius:12px;' +
      '          background:#fff;color:#3c4043;font-weight:600;font-size:.95rem;' +
      '          text-decoration:none;box-sizing:border-box;cursor:pointer">' +
      G_SVG + '<span>Sign in with Google</span></a>' +
      '<p style="font-size:.75rem;color:#64748b;text-align:center;margin:10px 0 0">' +
      '  Use your @' + (cfg.domain || '') + ' work account.</p>';
    host.appendChild(wrap);
  }

  /** Redeem the one-time hand-off code the callback put in the URL. */
  function redeem(code) {
    // Take the code out of the address bar straight away so it is not left in
    // history or copied out of the URL bar. It is single-use and short-lived
    // anyway, but there is no reason for it to linger.
    try {
      var clean = window.location.pathname;
      window.history.replaceState({}, document.title, clean);
    } catch (e) { /* non-fatal */ }

    fetch('/api/auth/google/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, d: d }; });
    }).then(function (res) {
      if (!res.ok) {
        if (res.d && res.d.error === 'roost_restricted' && typeof CFG.onDenied === 'function') {
          CFG.onDenied(res.d);
          return;
        }
        showError((res.d && res.d.message) || 'Google sign-in could not be completed. Please use your PIN.');
        return;
      }
      if (res.d.requires_totp) {
        if (typeof CFG.onTotp === 'function') { CFG.onTotp(res.d.challenge_token); return; }
        showError('This account needs its authenticator code. Please sign in with your PIN.');
        return;
      }
      if (res.d.token) {
        sessionStorage.setItem('wrenToken', res.d.token);
        window.location.href = REDIRECT;
        return;
      }
      showError('Google sign-in could not be completed. Please use your PIN.');
    }).catch(function () {
      showError('Google sign-in could not be completed. Please use your PIN.');
    });
  }

  function init() {
    var params = new URLSearchParams(window.location.search);
    var code = params.get('sso');
    var err = params.get('sso_error');

    fetch('/api/auth/google/config')
      .then(function (r) { return r.json(); })
      .then(function (cfg) { if (cfg && cfg.enabled) { renderButton(cfg); } })
      .catch(function () { /* button simply does not appear */ })
      .then(function () {
        if (err) {
          showError(params.get('sso_message') || 'Google sign-in failed. Please use your PIN.');
          try { window.history.replaceState({}, document.title, window.location.pathname); } catch (e) {}
        }
      });

    if (code) { redeem(code); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
