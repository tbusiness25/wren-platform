/* b131 — Parent app lock (PIN + WebAuthn biometric).
 * Loaded by /pwa.js on every /welcome/* page. Gates child data behind a PIN or
 * platform-biometric prompt on: first load, resume-from-background, and idle timeout.
 * Off by default (opt-in via Settings → App Lock). Server: /api/app-lock/* (CF Access
 * header identifies the parent — see src/routes/parent-app-lock.js).
 */
(function () {
  'use strict';
  if (window.WrenParentAppLock) return;

  var CACHE_KEY = 'wren.applock.cached';       // '1'/'0' — last known enabled state, for instant gating on load
  var BIOMETRIC_KEY = 'wren.applock.biometric.device'; // '1' — this device registered a platform authenticator
  var UNLOCKED_AT_KEY = 'wren.applock.unlockedAt';     // session-only: ms timestamp of last successful unlock
  var LAST_ACTIVE_KEY = 'wren.applock.lastActiveAt';   // session-only: ms timestamp of last user activity while unlocked
  var IDLE_CACHE_KEY = 'wren.applock.idleMinutes';     // last known idle window, so boot uses the real value pre-status

  var GREEN = 'var(--green,#2d5a4a)';
  var state = { enabled: false, idleMinutes: 5, hasPin: false, checked: false, locked: false };
  var idleTimer = null;
  var overlayEl = null;

  function fetchJSON(url, opts) {
    return fetch(url, Object.assign({ credentials: 'same-origin' }, opts || {}))
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); });
  }

  // ── base64url <-> ArrayBuffer (no @simplewebauthn/browser dependency) ────────
  function b64urlToBuffer(b64url) {
    var pad = '='.repeat((4 - (b64url.length % 4)) % 4);
    var base64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64);
    var buf = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
    return buf.buffer;
  }
  function bufferToB64url(buf) {
    var bytes = new Uint8Array(buf), str = '';
    for (var i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
    var base64 = btoa(str);
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function platformAuthenticatorAvailable() {
    return !!(window.PublicKeyCredential && window.isSecureContext &&
      window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable);
  }

  // ── WebAuthn: register a platform authenticator on this device ───────────────
  function registerBiometric() {
    return fetchJSON('/api/app-lock/webauthn/register-options', { method: 'POST' })
      .then(function (res) {
        if (!res.ok) throw new Error(res.body.error || 'Could not start registration');
        var options = res.body;
        options.challenge = b64urlToBuffer(options.challenge);
        options.user.id = b64urlToBuffer(options.user.id);
        if (options.excludeCredentials) {
          options.excludeCredentials = options.excludeCredentials.map(function (c) {
            return Object.assign({}, c, { id: b64urlToBuffer(c.id) });
          });
        }
        return navigator.credentials.create({ publicKey: options });
      })
      .then(function (cred) {
        var body = {
          id: cred.id,
          rawId: bufferToB64url(cred.rawId),
          type: cred.type,
          response: {
            clientDataJSON: bufferToB64url(cred.response.clientDataJSON),
            attestationObject: bufferToB64url(cred.response.attestationObject),
            transports: (cred.response.getTransports && cred.response.getTransports()) || [],
          },
          clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
        };
        return fetchJSON('/api/app-lock/webauthn/register-verify', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
      })
      .then(function (res) {
        if (!res.ok || !res.body.ok) throw new Error((res.body && res.body.error) || 'Registration failed');
        try { localStorage.setItem(BIOMETRIC_KEY, '1'); } catch (e) {}
        return true;
      });
  }

  // ── WebAuthn: authenticate (unlock) ───────────────────────────────────────────
  function unlockWithBiometric() {
    return fetchJSON('/api/app-lock/webauthn/auth-options', { method: 'POST' })
      .then(function (res) {
        if (!res.ok) throw new Error(res.body.error || 'no_biometric');
        var options = res.body;
        options.challenge = b64urlToBuffer(options.challenge);
        if (options.allowCredentials) {
          options.allowCredentials = options.allowCredentials.map(function (c) {
            return Object.assign({}, c, { id: b64urlToBuffer(c.id) });
          });
        }
        return navigator.credentials.get({ publicKey: options });
      })
      .then(function (assertion) {
        var body = {
          id: assertion.id,
          rawId: bufferToB64url(assertion.rawId),
          type: assertion.type,
          response: {
            clientDataJSON: bufferToB64url(assertion.response.clientDataJSON),
            authenticatorData: bufferToB64url(assertion.response.authenticatorData),
            signature: bufferToB64url(assertion.response.signature),
            userHandle: assertion.response.userHandle ? bufferToB64url(assertion.response.userHandle) : undefined,
          },
          clientExtensionResults: assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : {},
        };
        return fetchJSON('/api/app-lock/webauthn/auth-verify', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
      })
      .then(function (res) { return !!(res.ok && res.body.ok); });
  }

  // ── Overlay UI (PIN pad + biometric) ──────────────────────────────────────────
  function ensureOverlayStyle() {
    if (document.getElementById('lap-lock-style')) return;
    var s = document.createElement('style'); s.id = 'lap-lock-style';
    s.textContent =
      '#lap-lock{position:fixed;inset:0;z-index:9999;background:var(--cream,#fefcf8);' +
        'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;' +
        'font-family:Nunito,system-ui,sans-serif;text-align:center}' +
      '#lap-lock img{height:56px;margin-bottom:14px;border-radius:12px}' +
      '#lap-lock h3{font-family:"Crimson Pro",Georgia,serif;color:' + GREEN + ';font-size:1.4rem;margin-bottom:6px}' +
      '#lap-lock p.lap-lock-sub{color:#5a5a5a;font-size:.88rem;margin-bottom:20px;max-width:280px}' +
      '#lap-lock .lap-dots{display:flex;gap:12px;margin-bottom:22px}' +
      '#lap-lock .lap-dot{width:14px;height:14px;border-radius:50%;border:2px solid ' + GREEN + ';transition:.15s}' +
      '#lap-lock .lap-dot.filled{background:' + GREEN + '}' +
      '#lap-lock .lap-dot.err{border-color:#c0392b;background:#c0392b}' +
      '#lap-lock .lap-pad{display:grid;grid-template-columns:repeat(3,64px);gap:12px;margin-bottom:18px}' +
      '#lap-lock .lap-key{width:64px;height:64px;border-radius:50%;border:1px solid #e8e0d0;background:#fff;' +
        'font-size:1.3rem;font-weight:700;color:#2a2a2a;cursor:pointer;display:flex;align-items:center;justify-content:center}' +
      '#lap-lock .lap-key:active{background:#f0f8f5}' +
      '#lap-lock .lap-key.lap-ghost{border:0;background:none;box-shadow:none}' +
      '#lap-lock .lap-bio{margin-top:6px;background:' + GREEN + ';color:#fff;border:0;border-radius:10px;' +
        'padding:10px 18px;font-weight:700;font-size:.86rem;cursor:pointer;min-height:44px}' +
      '#lap-lock .lap-forgot{margin-top:16px;background:none;border:0;color:#8a8a8a;text-decoration:underline;' +
        'font-size:.82rem;cursor:pointer;min-height:32px}' +
      '#lap-lock .lap-err-msg{color:#c0392b;font-size:.82rem;min-height:1.2em;margin-bottom:8px}';
    document.head.appendChild(s);
  }

  function showOverlay() {
    if (overlayEl) return;
    ensureOverlayStyle();
    state.locked = true;
    // locking invalidates the session unlock, so navigating away can't skip the gate
    try { sessionStorage.removeItem(UNLOCKED_AT_KEY); sessionStorage.removeItem(LAST_ACTIVE_KEY); } catch (e) {}
    var pinLen = 4, entered = '';
    overlayEl = document.createElement('div');
    overlayEl.id = 'lap-lock';
    overlayEl.setAttribute('role', 'dialog');
    overlayEl.setAttribute('aria-label', 'App locked');
    var canBio = platformAuthenticatorAvailable() && (localStorage.getItem(BIOMETRIC_KEY) === '1');
    overlayEl.innerHTML =
      '<img src="/little-angels-logo.png" alt="Your Nursery">' +
      '<h3>App Locked</h3>' +
      '<p class="lap-lock-sub">Enter your PIN to see your child’s information.</p>' +
      '<div class="lap-err-msg" id="lap-err"></div>' +
      '<div class="lap-dots" id="lap-dots"></div>' +
      '<div class="lap-pad" id="lap-pad"></div>' +
      (canBio ? '<button type="button" class="lap-bio" id="lap-bio-btn">👤 Use Face ID / Fingerprint</button>' : '') +
      '<button type="button" class="lap-forgot" id="lap-forgot-btn">Forgot PIN?</button>';
    document.body.appendChild(overlayEl);

    var dotsEl = overlayEl.querySelector('#lap-dots');
    var errEl = overlayEl.querySelector('#lap-err');
    function renderDots(errFlash) {
      dotsEl.innerHTML = '';
      for (var i = 0; i < pinLen; i++) {
        var d = document.createElement('div');
        d.className = 'lap-dot' + (i < entered.length ? ' filled' : '') + (errFlash ? ' err' : '');
        dotsEl.appendChild(d);
      }
    }
    renderDots(false);

    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
    var padEl = overlayEl.querySelector('#lap-pad');
    keys.forEach(function (k) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'lap-key' + (k === '' ? ' lap-ghost' : '');
      b.textContent = k;
      b.disabled = k === '';
      b.addEventListener('click', function () {
        if (k === '⌫') { entered = entered.slice(0, -1); renderDots(false); errEl.textContent = ''; return; }
        if (entered.length >= pinLen) return;
        entered += k;
        renderDots(false);
        if (entered.length === pinLen) submitPin();
      });
      padEl.appendChild(b);
    });

    function submitPin() {
      fetchJSON('/api/app-lock/verify-pin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: entered }),
      }).then(function (res) {
        if (res.ok && res.body.ok) return unlock();
        entered = '';
        renderDots(true);
        errEl.textContent = (res.body && res.body.locked) ? 'Too many attempts — try again later.' : 'Wrong PIN, try again.';
        setTimeout(function () { renderDots(false); }, 500);
      }).catch(function () {
        entered = ''; renderDots(false); errEl.textContent = 'Network error — try again.';
      });
    }

    var bioBtn = overlayEl.querySelector('#lap-bio-btn');
    function tryBio() {
      if (!bioBtn) return;
      unlockWithBiometric().then(function (ok) {
        if (ok) unlock(); else errEl.textContent = 'Biometric unlock failed — use your PIN.';
      }).catch(function () { /* user cancelled or no matching authenticator — silently fall back to PIN */ });
    }
    if (bioBtn) {
      bioBtn.addEventListener('click', tryBio);
      setTimeout(tryBio, 300); // auto-prompt once overlay is visible
    }

    overlayEl.querySelector('#lap-forgot-btn').addEventListener('click', function () {
      if (!confirm('Reset your app lock? You’ll set a new PIN next time. (This does not affect your account sign-in.)')) return;
      fetchJSON('/api/app-lock/disable', { method: 'POST' }).then(function () {
        try { localStorage.setItem(CACHE_KEY, '0'); localStorage.removeItem(BIOMETRIC_KEY); } catch (e) {}
        state.enabled = false;
        unlock();
      });
    });
  }

  function unlock() {
    state.locked = false;
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    var now = String(Date.now());
    try { sessionStorage.setItem(UNLOCKED_AT_KEY, now); sessionStorage.setItem(LAST_ACTIVE_KEY, now); } catch (e) {}
    armIdleTimer();
  }

  // Session-wide lock decision: sessionStorage survives same-origin navigations but
  // dies with the tab/PWA window, so "unlocked" carries across page changes and ends
  // when the app is closed. Lock only if never unlocked this session, or idle window
  // exceeded since the last recorded activity.
  function idleWindowMs() {
    var mins = state.idleMinutes || 5;
    try { mins = parseInt(localStorage.getItem(IDLE_CACHE_KEY) || '', 10) || mins; } catch (e) {}
    return mins * 60 * 1000;
  }
  function shouldLock() {
    var last = 0;
    try {
      last = parseInt(sessionStorage.getItem(LAST_ACTIVE_KEY) || sessionStorage.getItem(UNLOCKED_AT_KEY) || '0', 10);
    } catch (e) {}
    return !last || (Date.now() - last) > idleWindowMs();
  }

  // ── Idle timer + resume-from-background ───────────────────────────────────────
  function armIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    if (!state.enabled) return;
    idleTimer = setTimeout(function () { showOverlay(); }, state.idleMinutes * 60 * 1000);
  }
  var lastActivityWrite = 0;
  function onActivity() {
    if (state.locked) return;
    armIdleTimer();
    var now = Date.now();
    if (now - lastActivityWrite > 15000) { // throttle storage writes
      lastActivityWrite = now;
      try { sessionStorage.setItem(LAST_ACTIVE_KEY, String(now)); } catch (e) {}
    }
  }

  function refreshStatus() {
    return fetchJSON('/api/app-lock/status').then(function (res) {
      if (!res.ok) return;
      var s = res.body;
      state.enabled = !!s.enabled;
      state.hasPin = !!s.has_pin;
      state.idleMinutes = s.idle_minutes || 5;
      try {
        localStorage.setItem(CACHE_KEY, state.enabled ? '1' : '0');
        localStorage.setItem(IDLE_CACHE_KEY, String(state.idleMinutes));
      } catch (e) {}
      if (state.enabled && !state.locked && shouldLock()) showOverlay();
      if (!state.enabled && overlayEl) unlock();
      if (state.enabled) armIdleTimer();
    });
  }

  function boot() {
    var cached = null;
    try { cached = localStorage.getItem(CACHE_KEY); } catch (e) {}
    if (cached === '1') { state.enabled = true; if (shouldLock()) showOverlay(); } // gate instantly, before status confirms
    refreshStatus();

    ['click', 'touchstart', 'keydown', 'scroll'].forEach(function (evt) {
      document.addEventListener(evt, onActivity, { passive: true });
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && state.enabled && !state.locked && shouldLock()) {
        showOverlay(); // resume-from-background re-prompts only once the idle window has lapsed
      }
    });
    window.addEventListener('pageshow', function (e) {
      if (e.persisted && state.enabled && shouldLock()) showOverlay();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.WrenParentAppLock = {
    getStatus: function () { return fetchJSON('/api/app-lock/status').then(function (r) { return r.body; }); },
    setPin: function (pin, idleMinutes) {
      return fetchJSON('/api/app-lock/set-pin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pin, idle_minutes: idleMinutes }),
      }).then(function (res) {
        if (res.ok) {
          state.enabled = true; state.idleMinutes = idleMinutes || 5;
          var now = String(Date.now());
          try {
            localStorage.setItem(CACHE_KEY, '1');
            localStorage.setItem(IDLE_CACHE_KEY, String(state.idleMinutes));
            // setting up the lock counts as an unlock — don't insta-lock the next page
            sessionStorage.setItem(UNLOCKED_AT_KEY, now); sessionStorage.setItem(LAST_ACTIVE_KEY, now);
          } catch (e) {}
          armIdleTimer();
        }
        return res;
      });
    },
    setIdleMinutes: function (idleMinutes) {
      return fetchJSON('/api/app-lock/set-idle', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idle_minutes: idleMinutes }),
      }).then(function (res) {
        if (res.ok) {
          state.idleMinutes = idleMinutes;
          try { localStorage.setItem(IDLE_CACHE_KEY, String(idleMinutes)); } catch (e) {}
          armIdleTimer();
        }
        return res;
      });
    },
    disable: function () {
      return fetchJSON('/api/app-lock/disable', { method: 'POST' }).then(function (res) {
        if (res.ok) { try { localStorage.setItem(CACHE_KEY, '0'); localStorage.removeItem(BIOMETRIC_KEY); } catch (e) {} state.enabled = false; if (idleTimer) clearTimeout(idleTimer); }
        return res;
      });
    },
    registerBiometric: registerBiometric,
    biometricSupported: platformAuthenticatorAvailable,
    biometricRegisteredOnThisDevice: function () { try { return localStorage.getItem(BIOMETRIC_KEY) === '1'; } catch (e) { return false; } },
    lockNow: showOverlay,
  };
})();
