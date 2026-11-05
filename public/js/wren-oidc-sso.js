/* ───────────────────────────────────────────────────────────────────────────
 * b233 — "Sign in with Wren ID" for the Roost (admin) and Seed (hr) login pages.
 *
 * The same shape as public/js/wren-google-sso.js, pointed at Wren's OWN identity
 * provider (Authentik) instead of Google. Shared between the two login pages so
 * they cannot drift apart.
 *
 * Entirely additive to the page it loads into: if Wren ID is not configured, or
 * the portal does not support it, this script injects nothing at all and the PIN
 * pad is exactly what it was. PIN login is never removed or hidden — it is the
 * documented fallback for a staff member locked out of the IdP, and the reason
 * an IdP outage is not a lockout. See
 * wren-docs/decisions/2026-08-26-authentik-own-idp.md ("Risks accepted").
 *
 * The page opts in with:
 *     <div id="oidc-sso-slot"></div>
 *     <script>window.WREN_OIDC = { redirect: '/index.html' };</script>
 *     <script src="/js/wren-oidc-sso.js"></script>
 *
 * Optional hooks the host page may define on window.WREN_OIDC:
 *   onTotp(challengeToken) — the account needs its second factor.
 *   onDenied(data)         — Roost's manager allowlist refused the token.
 *
 * NOTE ON THE QUERY PARAMS: this flow uses ?oidc= / ?oidc_error= / ?oidc_message=,
 * deliberately NOT the ?sso= that b210's Google script owns. Both scripts can
 * load on the same page, and a shared param would have each trying to redeem the
 * other's hand-off code.
 * ─────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // Set before anything else so a host page's own auto-login (remember-device,
  // existing-token bounce) can stand down while a redeem is in flight.
  window.WREN_OIDC_PENDING = !!new URLSearchParams(window.location.search).get('oidc');

  var CFG = window.WREN_OIDC || {};
  var REDIRECT = CFG.redirect || '/index.html';

  function slot() { return document.getElementById('oidc-sso-slot'); }

  function showError(msg) {
    var box = document.getElementById('oidc-error');
    if (!box) {
      var host = slot();
      if (!host) { return; }
      box = document.createElement('p');
      box.id = 'oidc-error';
      box.style.cssText = 'color:var(--c-red,#dc2626);text-align:center;font-size:.85rem;margin:10px 0 0';
      host.appendChild(box);
    }
    box.textContent = msg;
    box.style.display = 'block';
  }

  // Wren's own mark, inlined — no external request, so it works behind
  // Cloudflare Access and offline-first service workers alike. Uses the theme
  // tokens rather than a fixed hex so it is right in light and dark.
  var W_SVG =
    '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" style="flex:none">' +
    '<path fill="currentColor" d="M12 2a7 7 0 0 0-7 7v2.6A4.4 4.4 0 0 0 2.8 15c0 2.2 1.5 4 3.6 4.6l.7 1.6a1 1 0 0 0 1.8 0l.6-1.3h4.9l.6 1.3a1 1 0 0 0 1.8 0l.7-1.6c2.1-.6 3.6-2.4 3.6-4.6a4.4 4.4 0 0 0-2.2-3.4V9a7 7 0 0 0-7-7Zm-2.6 7.6a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4Zm5.2 0a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4Z"/>' +
    '</svg>';

  function renderButton() {
    var host = slot();
    if (!host) { return; }
    var wrap = document.createElement('div');
    // login-20261023 — CFG.compact: a small secondary link under the PIN sign-in
    // rather than a second full-width button. Staff were reading two equal
    // buttons as two things they had to do. Same href, same flow.
    if (CFG.compact) {
      wrap.innerHTML =
        '<p style="font-size:.8rem;color:var(--c-text-muted,var(--c-muted,#64748b));text-align:center;margin:16px 0 0;line-height:1.5">' +
        '  Set up a Wren ID password? ' +
        '  <a id="oidc-sso-btn" href="/api/auth/oidc/start" style="color:var(--c-blue,#4a9abf);font-weight:600">Sign in with Wren ID instead</a>' +
        '</p>';
      host.appendChild(wrap);
      return;
    }
    wrap.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;margin:18px 0 14px;color:#94a3b8;font-size:.75rem">' +
      '  <span style="flex:1;height:1px;background:var(--c-border,#e2e8f0)"></span>OR' +
      '  <span style="flex:1;height:1px;background:var(--c-border,#e2e8f0)"></span>' +
      '</div>' +
      '<a id="oidc-sso-btn" href="/api/auth/oidc/start" ' +
      '   style="display:flex;align-items:center;justify-content:center;gap:10px;width:100%;' +
      '          padding:12px 16px;border:1px solid var(--c-border,#e2e8f0);border-radius:12px;' +
      '          background:var(--c-surface,#fff);color:var(--c-text,#1e293b);font-weight:600;font-size:.95rem;' +
      '          text-decoration:none;box-sizing:border-box;cursor:pointer">' +
      W_SVG + '<span>Sign in with Wren ID</span></a>' +
      '<p style="font-size:.75rem;color:var(--c-text-muted,#64748b);text-align:center;margin:10px 0 0">' +
      '  Your Wren account — password and authenticator code.</p>';
    host.appendChild(wrap);
  }

  /** Redeem the one-time hand-off code the callback put in the URL. */
  function redeem(code) {
    // Take the code out of the address bar straight away so it is not left in
    // history or copied out of the URL bar. It is single-use and short-lived
    // anyway, but there is no reason for it to linger.
    try {
      window.history.replaceState({}, document.title, window.location.pathname);
    } catch (e) { /* non-fatal */ }

    fetch('/api/auth/oidc/exchange', {
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
        showError((res.d && res.d.message) || 'Wren ID sign-in could not be completed. Please sign in with your email and PIN instead.');
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
      showError('Wren ID sign-in could not be completed. Please use your PIN.');
    }).catch(function () {
      showError('Wren ID sign-in could not be completed. Please use your PIN.');
    });
  }

  function init() {
    var params = new URLSearchParams(window.location.search);
    var code = params.get('oidc');
    var err = params.get('oidc_error');

    fetch('/api/auth/oidc/config')
      .then(function (r) { return r.json(); })
      .then(function (cfg) { if (cfg && cfg.enabled) { renderButton(); } })
      .catch(function () { /* button simply does not appear */ })
      .then(function () {
        if (err) {
          showError(params.get('oidc_message') || 'Wren ID sign-in failed. Please use your PIN.');
          try { window.history.replaceState({}, document.title, window.location.pathname); } catch (e) {}
        }
      });

    if (code) { redeem(code); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
