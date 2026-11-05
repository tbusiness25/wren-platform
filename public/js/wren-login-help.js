/* ───────────────────────────────────────────────────────────────────────────
 * login-20261023 — one place for the words on the four LADN sign-in screens.
 *
 * Toby: "some staff are confused with the Wren ID login and the email and
 * codes. Simplify the login screen, route each portal to the correct one."
 *
 * Two jobs, nothing else:
 *   1. renderWrongPlace(el, here) — a short "wrong place? go to …" block that
 *      links to the sibling portals. The links are built from THIS page's host
 *      (ey./hr./admin./parents. + the same domain), so a setting on another
 *      domain gets its own portals, never LADN's. On a host that does not
 *      follow that pattern (localhost, a bare IP on dev) it renders nothing.
 *   2. staffError(status, data) / totpError(data) — turn the server's error
 *      codes into plain English. The server's codes are unchanged; this only
 *      changes what a person reads.
 *
 * Loaded by the EY, HR, Roost and Parents login pages. Served from the shared
 * public/ tree, which all four portals fall back to.
 * ─────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var PORTALS = {
    ey:      { label: 'EY app',            who: 'room tablets — tap your name, then your PIN' },
    hr:      { label: 'Staff HR',          who: 'your own phone or computer — rota, leave, payslips, training' },
    admin:   { label: 'Roost',             who: 'managers and the office only' },
    parents: { label: 'Parents app',       who: 'parents and carers' },
  };

  /** https://<kind>.<this domain>/ — or null when this host is not a portal host. */
  function portalUrl(kind) {
    var m = /^(ey|hr|admin|parents)\.([a-z0-9.-]+\.[a-z]{2,})$/i.exec(location.hostname || '');
    if (!m) return null;
    return 'https://' + kind + '.' + m[2] + '/';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * @param {HTMLElement|string} el   container (or its id)
   * @param {string} here             'ey' | 'hr' | 'admin' | 'parents'
   * @param {string[]} [order]        which other portals to list, in order
   */
  function renderWrongPlace(el, here, order) {
    var box = typeof el === 'string' ? document.getElementById(el) : el;
    if (!box) return;
    var list = (order || ['ey', 'hr', 'admin', 'parents']).filter(function (k) { return k !== here; });
    var items = list.map(function (k) {
      var url = portalUrl(k);
      if (!url) return '';
      return '<li><a href="' + esc(url) + '">' + esc(PORTALS[k].label) + '</a> — ' + esc(PORTALS[k].who) + '</li>';
    }).filter(Boolean);
    if (!items.length) { box.style.display = 'none'; return; }
    box.innerHTML = '<p class="wlh-title">Wrong place?</p><ul class="wlh-list">' + items.join('') + '</ul>';
  }

  /** Plain-English text for a failed /api/auth/login. */
  function staffError(status, data) {
    var code = data && data.error;
    if (code === 'account_locked') return (data.message || 'Too many attempts') + '. A manager can unlock you sooner from Roost.';
    if (code === 'accountant_pin_disabled') return data.message;
    if (code === 'roost_restricted') return 'Roost is for managers and the office only.';
    if (status === 429) return 'Too many tries in a row — wait a minute, then try again.';
    if (code === 'PIN not set') return 'You don’t have a PIN yet. Ask a manager to set one for you (Roost → Staff PINs).';
    if (code === 'Staff not found') return 'We don’t recognise that email. Use the email address the nursery has for you — usually your personal one — or ask the office.';
    if (code === 'Incorrect PIN') return 'That PIN isn’t right — try again. It’s the same PIN you use on the room tablets.';
    if (status >= 500) return 'Wren had a problem signing you in. Try again in a minute; if it keeps happening, tell the office.';
    return 'That didn’t work — check your details and try again.';
  }

  /** Plain-English text for a failed /api/auth/totp. */
  function totpError(data) {
    var code = data && data.error;
    if (code === 'account_locked') return (data.message || 'Too many attempts') + '. A manager can unlock you sooner from Roost.';
    if (code === 'Invalid or expired challenge token' || code === 'Invalid challenge token scope')
      return 'That took too long — the sign-in expired after 5 minutes. Go back and enter your PIN again.';
    if (code === 'Code already used — wait for the next code') return 'That code has just been used. Wait for the next one (it changes every 30 seconds).';
    if (code === 'Invalid code') return 'That code isn’t right. Use the 6-digit code shown for “Wren” in your authenticator app — it changes every 30 seconds. It is not a code from an email.';
    if (code && /too many/i.test(code)) return 'Too many tries — wait 5 minutes, then try again.';
    return code || 'That code didn’t work — try again.';
  }

  // Shared look for the help blocks. Theme tokens only, so it reads in light and dark.
  var css = document.createElement('style');
  css.textContent =
    '.wlh-portal{margin:0 0 18px;padding:10px 12px;border-radius:10px;border:1px solid var(--c-border,rgba(148,163,184,.3));' +
    'background:color-mix(in srgb,var(--c-blue,#4a9abf) 8%,transparent);font-size:.82rem;line-height:1.5;color:var(--c-text,#e2e8f0);text-align:left}' +
    '.wlh-portal b{color:var(--c-text,#f1f5f9)}' +
    '.wlh-help{margin:14px 0 0;font-size:.78rem;line-height:1.55;color:var(--c-muted,#94a3b8);text-align:left}' +
    '.wlh-help b{color:var(--c-text,#e2e8f0)}' +
    '.wlh-wrong{margin-top:18px;padding-top:12px;border-top:1px solid var(--c-border,rgba(148,163,184,.25));font-size:.78rem;color:var(--c-muted,#94a3b8);text-align:left}' +
    '.wlh-title{margin:0 0 4px;font-weight:700;color:var(--c-text,#e2e8f0)}' +
    '.wlh-list{margin:0;padding-left:18px;line-height:1.6}' +
    '.wlh-list a{color:var(--c-blue,#4a9abf);font-weight:600}';
  (document.head || document.documentElement).appendChild(css);

  window.WrenLoginHelp = { portalUrl: portalUrl, renderWrongPlace: renderWrongPlace, staffError: staffError, totpError: totpError };
})();
