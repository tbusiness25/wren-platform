/* ============================================================================
   wren-notification-matrix.js — b230 (2026-08-25)

   The notification matrix, written ONCE and mounted in two places:
     • Roost → Notifications → Settings tab   (sections/notifications.html)
     • /notification-settings.html            (the standalone page)

   Both mount this same component, so the two screens cannot drift apart — which
   is exactly what went wrong before: notification-settings.html spoke to the
   older /api/notifications/prefs/* endpoints while /api/notification-matrix
   quietly became the real design, and nothing linked to either.

   Backing API: GET/PUT /api/notification-matrix (single source of truth; the
   older endpoints now write through the same server-side store).

   Also exports the "Enable notifications on this device" control — the missing
   piece behind Toby's "there isn't a way for me to turn on notifications on
   admin, so they don't come through my phone". ladn.push_subscriptions had 0
   rows because nothing in the admin portal ever called subscribe.

   Theme: var(--c-*) tokens only, no bare hex.
   ========================================================================== */
(function () {
  'use strict';

  var API_MATRIX  = '/api/notification-matrix';
  var API_CHANNEL = '/api/notifications/channel-status';
  var API_VAPID   = '/api/notifications/vapid-public-key';
  var API_SUB     = '/api/notifications/push-subscribe';
  var API_UNSUB   = '/api/notifications/push-unsubscribe';
  var API_TG      = '/api/notifications/telegram';

  var MODE_LABELS = {
    off:        'Off',
    inapp:      'In-app only',
    inapp_push: 'In-app + push',
    digest:     'Daily digest',
  };
  var SCOPE_LABELS = {
    all:            'Everything',
    my_room:        'My room only',
    my_keychildren: 'My key children',
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function token() {
    try { return sessionStorage.getItem('wrenToken') || localStorage.getItem('token') || sessionStorage.getItem('token') || ''; }
    catch (e) { return ''; }
  }

  // Prefer the shell's api() (handles token key + base + 401 redirect); fall
  // back to fetch so this file also works on a page without the shell.
  function api(path, opts) {
    if (window.Wren && typeof Wren.api === 'function') return Wren.api(path, opts);
    opts = opts || {};
    var h = { 'Content-Type': 'application/json' };
    var t = token(); if (t) h.Authorization = 'Bearer ' + t;
    return fetch(path, {
      method: opts.method || 'GET',
      headers: h,
      credentials: 'same-origin',
      body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t2) { throw new Error(t2 || ('HTTP ' + r.status)); });
      return r.json();
    });
  }

  function toast(msg, kind) {
    if (window.Wren && typeof Wren.toast === 'function') return Wren.toast(msg, kind || 'info');
    console.log('[wren-notification-matrix]', kind || 'info', msg);
  }

  // ── styles ─────────────────────────────────────────────────────────────────
  var STYLE_ID = 'wnm-styles';
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '.wnm { display:flex; flex-direction:column; gap:18px; }',
      '.wnm-card { background:var(--c-card); border:1px solid var(--c-border); border-radius:var(--radius,16px); padding:16px 18px; }',
      '.wnm-h { display:flex; align-items:center; gap:10px; flex-wrap:wrap; justify-content:space-between; margin-bottom:12px; }',
      '.wnm-h h3 { font-size:.95rem; font-weight:700; margin:0; color:var(--c-text); }',
      '.wnm-sub { font-size:.78rem; color:var(--c-text-muted); line-height:1.5; }',
      /* Channel readiness strip — auto-fit so it is 1 column folded, 2–4 open */
      '.wnm-chan { display:grid; gap:10px; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); }',
      '.wnm-chan-item { border:1px solid var(--c-border); border-radius:var(--radius-sm,8px); padding:10px 12px; background:var(--c-surface); }',
      '.wnm-chan-name { display:flex; align-items:center; gap:7px; font-size:.85rem; font-weight:600; color:var(--c-text); }',
      '.wnm-chan-why { font-size:.72rem; color:var(--c-text-muted); margin-top:4px; line-height:1.45; }',
      '.wnm-dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; }',
      '.wnm-dot.on  { background:var(--c-green); }',
      '.wnm-dot.off { background:var(--c-muted); }',
      '.wnm-dot.bad { background:var(--c-red); }',
      '.wnm-pill { font-size:.66rem; font-weight:700; letter-spacing:.04em; text-transform:uppercase; padding:2px 7px; border-radius:999px; border:1px solid var(--c-border); color:var(--c-text-muted); }',
      '.wnm-pill.on  { color:var(--c-green); border-color:var(--c-green); }',
      '.wnm-pill.bad { color:var(--c-red);   border-color:var(--c-red); }',
      '.wnm-actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }',
      '.wnm-btn { font:inherit; font-size:.82rem; font-weight:600; padding:8px 14px; min-height:40px; border-radius:var(--radius-sm,8px);',
      '           border:1px solid var(--c-border); background:var(--c-surface); color:var(--c-text); cursor:pointer; }',
      '.wnm-btn:hover:not(:disabled) { border-color:var(--c-blue); color:var(--c-blue); }',
      '.wnm-btn:disabled { opacity:.5; cursor:not-allowed; }',
      '.wnm-btn.primary { background:var(--c-blue); border-color:var(--c-blue); color:var(--c-navy); }',
      '.wnm-btn.primary:hover:not(:disabled) { background:var(--c-blue-dark); border-color:var(--c-blue-dark); color:var(--c-navy); }',
      '.wnm-sel { font:inherit; font-size:.8rem; padding:6px 8px; min-height:36px; border-radius:var(--radius-sm,8px);',
      '           border:1px solid var(--c-border); background:var(--c-bg); color:var(--c-text); max-width:100%; }',
      '.wnm-sel:disabled { opacity:.55; cursor:not-allowed; }',
      /* A bare <input type="time"> inside a flex label collapses to a sliver in
         Chrome — it has no intrinsic width to fall back on. */
      'input.wnm-sel[type="time"] { min-width:8.5em; }',
      '.wnm-portal { border:1px solid var(--c-border); border-radius:var(--radius,16px); overflow:hidden; background:var(--c-card); }',
      '.wnm-portal > summary { cursor:pointer; list-style:none; padding:13px 16px; display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; }',
      '.wnm-portal > summary::-webkit-details-marker { display:none; }',
      '.wnm-portal > summary:hover { background:var(--c-surface); }',
      '.wnm-portal-name { font-weight:700; font-size:.88rem; color:var(--c-text); }',
      '.wnm-portal-hint { font-size:.74rem; color:var(--c-text-muted); }',
      '.wnm-rows { border-top:1px solid var(--c-border); }',
      /* Row is a grid so it reflows on the fold instead of overflowing */
      '.wnm-row { display:grid; gap:8px 12px; align-items:center; padding:11px 16px; border-bottom:1px solid var(--c-border);',
      '           grid-template-columns:minmax(0,1fr) 160px 108px 150px; }',
      '.wnm-row:last-child { border-bottom:none; }',
      '.wnm-row-name { min-width:0; font-size:.84rem; color:var(--c-text); display:flex; gap:7px; align-items:center; flex-wrap:wrap; }',
      '.wnm-tag { font-size:.63rem; font-weight:700; text-transform:uppercase; letter-spacing:.04em; padding:1px 6px; border-radius:4px; }',
      '.wnm-tag.urgent { color:var(--c-red);   border:1px solid var(--c-red); }',
      '.wnm-tag.locked { color:var(--c-amber); border:1px solid var(--c-amber); }',
      '.wnm-tag.mgr    { color:var(--c-purple); border:1px solid var(--c-purple); }',
      '.wnm-cell-label { display:none; font-size:.68rem; text-transform:uppercase; letter-spacing:.05em; color:var(--c-text-muted); }',
      '.wnm-check { display:inline-flex; align-items:center; gap:7px; font-size:.78rem; color:var(--c-text-muted); cursor:pointer; }',
      '.wnm-check input { width:17px; height:17px; accent-color:var(--c-blue); cursor:pointer; }',
      '.wnm-check input:disabled { cursor:not-allowed; }',
      '.wnm-dirty { font-size:.75rem; color:var(--c-amber); }',
      '.wnm-empty { padding:24px; text-align:center; color:var(--c-text-muted); font-size:.85rem; }',
      /* ── Foldable / mobile. Honor Magic V5: ~400px folded, ~740–880 unfolded. */
      '@media (max-width:820px) {',
      '  .wnm-row { grid-template-columns:minmax(0,1fr) 150px; }',
      '  .wnm-row-name { grid-column:1 / -1; }',
      '}',
      '@media (max-width:560px) {',
      '  .wnm-row { grid-template-columns:1fr; padding:12px 14px; }',
      '  .wnm-row-name { grid-column:auto; }',
      '  .wnm-cell-label { display:block; margin-bottom:3px; }',
      '  .wnm-sel { width:100%; }',
      '}',
    ].join('\n');
    document.head.appendChild(st);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Device push control
  // ══════════════════════════════════════════════════════════════════════════

  function b64ToUint8(b64) {
    var pad = '='.repeat((4 - (b64.length % 4)) % 4);
    var s = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(s), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  var isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  /**
   * What is the honest state of push on THIS device?
   * Returns { state, title, detail, canEnable, canDisable }
   * state ∈ unsupported | ios-needs-install | blocked | no-server-keys | off | on
   */
  function deviceState() {
    return Promise.resolve().then(function () {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        // iOS < 16.4 lands here, and so does any browser without push at all.
        if (isIOS && !isStandalone()) {
          return { state: 'ios-needs-install', canEnable: false, canDisable: false,
                   title: 'Add Wren to your Home Screen first',
                   detail: 'On an iPhone or iPad, Safari only allows notifications once the site is installed. '
                         + 'Tap Share → Add to Home Screen, open Wren from the new icon, then come back here.' };
        }
        return { state: 'unsupported', canEnable: false, canDisable: false,
                 title: 'This browser cannot show notifications',
                 detail: 'No Push API in this browser. Try Chrome or Edge on Android/desktop, or install Wren to the Home Screen on iOS 16.4+.' };
      }
      if (isIOS && !isStandalone()) {
        return { state: 'ios-needs-install', canEnable: false, canDisable: false,
                 title: 'Add Wren to your Home Screen first',
                 detail: 'Safari on iPhone/iPad only permits notifications for an installed app. '
                       + 'Tap Share → Add to Home Screen, open Wren from that icon, then come back here.' };
      }
      if (Notification.permission === 'denied') {
        return { state: 'blocked', canEnable: false, canDisable: false,
                 title: 'Notifications are blocked for this site',
                 detail: 'The browser is refusing, not Wren. Open the padlock/site settings next to the address bar, '
                       + 'set Notifications to Allow, then reload this page.' };
      }
      return api(API_VAPID).catch(function () { return null; }).then(function (k) {
        if (!k || !k.key) {
          return { state: 'no-server-keys', canEnable: false, canDisable: false,
                   title: 'Push is not configured on this server',
                   detail: 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are missing from this Wren instance, so no browser can subscribe.' };
        }
        return navigator.serviceWorker.getRegistration().then(function (reg) {
          if (!reg) {
            return { state: 'off', canEnable: true, canDisable: false,
                     title: 'Not enabled on this device',
                     detail: 'Turn this on to get Wren alerts on this phone, tablet or computer even when the tab is closed.' };
          }
          return reg.pushManager.getSubscription().then(function (sub) {
            if (sub && Notification.permission === 'granted') {
              return { state: 'on', canEnable: false, canDisable: true, endpoint: sub.endpoint,
                       title: 'On for this device',
                       detail: 'This device is subscribed. Each phone, tablet and computer has to be turned on separately.' };
            }
            return { state: 'off', canEnable: true, canDisable: false,
                     title: 'Not enabled on this device',
                     detail: 'Turn this on to get Wren alerts on this phone, tablet or computer even when the tab is closed.' };
          });
        });
      });
    }).catch(function (e) {
      return { state: 'off', canEnable: true, canDisable: false,
               title: 'Not enabled on this device', detail: String(e && e.message || e) };
    });
  }

  function enableOnThisDevice() {
    // Prefer the shell's own subscribe path when it is present: it holds the
    // single in-flight guard that stops a boot-time re-sync and this tap
    // subscribing twice and leaving a duplicate endpoint for one device.
    if (window.Wren && typeof Wren.enablePush === 'function') {
      // Wren.enablePush() shares one in-flight promise with the shell's silent
      // boot-time re-sync, so tapping while that is running joins it instead of
      // subscribing a second time for the same device. But the tap must never
      // inherit that call's latency: pushManager.subscribe() can sit for a long
      // time when the push service is slow, and a button stuck on "Asking the
      // browser…" is worse than a duplicate endpoint. Give it a few seconds,
      // then go it alone.
      return _withTimeout(Wren.enablePush(), 8000)
        .then(function () {
          return navigator.serviceWorker.ready
            .then(function (reg) { return reg.pushManager.getSubscription(); });
        })
        .catch(function () { return null; })
        .then(function (sub) { return sub || _enableStandalone(); });
    }
    return _enableStandalone();
  }

  function _withTimeout(p, ms) {
    return Promise.race([
      Promise.resolve(p),
      new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, ms); }),
    ]);
  }

  function _enableStandalone() {
    return Promise.resolve().then(function () {
      if (Notification.permission !== 'granted') {
        return Notification.requestPermission().then(function (p) {
          if (p !== 'granted') throw new Error('Permission was not granted');
        });
      }
    }).then(function () {
      // The shell registers /sw.js at boot; register here too so the standalone
      // page (and a first-ever visit) does not depend on that having happened.
      return navigator.serviceWorker.getRegistration()
        .then(function (r) { return r || navigator.serviceWorker.register('/sw.js', { scope: '/' }); })
        .then(function () { return navigator.serviceWorker.ready; });
    }).then(function (reg) {
      return reg.pushManager.getSubscription().then(function (sub) {
        if (sub) return sub;
        return api(API_VAPID).then(function (k) {
          if (!k || !k.key) throw new Error('Server has no VAPID key');
          return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(k.key) });
        });
      });
    }).then(function (sub) {
      return api(API_SUB, { method: 'POST', body: { subscription: sub.toJSON ? sub.toJSON() : sub, user_agent: navigator.userAgent } })
        .then(function () { return sub; });
    });
  }

  function disableOnThisDevice() {
    return navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription();
    }).then(function (sub) {
      if (!sub) return;
      var endpoint = sub.endpoint;
      return sub.unsubscribe().then(function () {
        return api(API_UNSUB, { method: 'POST', body: { endpoint: endpoint } });
      });
    });
  }

  /** Renders the "Enable notifications on this device" card into `el`. */
  function mountDeviceCard(el, opts) {
    injectStyles();
    opts = opts || {};
    el.className = (el.className || '') + ' wnm-card';
    el.innerHTML = '<div class="wnm-sub">Checking this device…</div>';

    function paint() {
      return Promise.all([deviceState(), api(API_CHANNEL).catch(function () { return null; })])
        .then(function (r) {
          var s = r[0], ch = r[1];
          var on = s.state === 'on';
          var bad = (s.state === 'blocked' || s.state === 'unsupported' || s.state === 'no-server-keys');
          var devices = ch && ch.push ? ch.push.devices : null;
          el.innerHTML =
            '<div class="wnm-h">' +
              '<h3>📱 Notifications on this device</h3>' +
              '<span class="wnm-pill ' + (on ? 'on' : bad ? 'bad' : '') + '">' +
                (on ? 'On' : bad ? 'Unavailable' : 'Off') + '</span>' +
            '</div>' +
            '<div class="wnm-chan-name"><span class="wnm-dot ' + (on ? 'on' : bad ? 'bad' : 'off') + '"></span>' + esc(s.title) + '</div>' +
            '<div class="wnm-chan-why">' + esc(s.detail) + '</div>' +
            (devices !== null
              ? '<div class="wnm-chan-why">Devices signed up for your account: <strong>' + devices + '</strong>. '
                + 'Each phone, tablet and computer counts separately.</div>'
              : '') +
            '<div class="wnm-actions" style="margin-top:12px">' +
              (s.canEnable  ? '<button class="wnm-btn primary" data-wnm="enable">Enable notifications on this device</button>' : '') +
              (s.canDisable ? '<button class="wnm-btn" data-wnm="disable">Turn off on this device</button>' : '') +
              (on ? '<button class="wnm-btn" data-wnm="test">Send me a test</button>' : '') +
            '</div>';

          var eBtn = el.querySelector('[data-wnm="enable"]');
          if (eBtn) eBtn.addEventListener('click', function () {
            eBtn.disabled = true; eBtn.textContent = 'Asking the browser…';
            enableOnThisDevice()
              .then(function () { toast('Notifications enabled on this device', 'success'); return paint(); })
              .catch(function (err) { toast('Could not enable: ' + (err.message || err), 'error'); return paint(); });
          });
          var dBtn = el.querySelector('[data-wnm="disable"]');
          if (dBtn) dBtn.addEventListener('click', function () {
            dBtn.disabled = true;
            disableOnThisDevice()
              .then(function () { toast('Turned off on this device', 'info'); return paint(); })
              .catch(function (err) { toast('Could not turn off: ' + (err.message || err), 'error'); return paint(); });
          });
          var tBtn = el.querySelector('[data-wnm="test"]');
          if (tBtn) tBtn.addEventListener('click', function () {
            tBtn.disabled = true; tBtn.textContent = 'Sending…';
            api('/api/notifications/test', { method: 'POST' })
              .then(function () { toast('Test queued — it arrives within ~30 seconds', 'success'); })
              .catch(function (err) { toast('Test failed: ' + (err.message || err), 'error'); })
              .then(function () { tBtn.disabled = false; tBtn.textContent = 'Send me a test'; });
          });
          if (typeof opts.onState === 'function') opts.onState(s);
        });
    }
    return paint();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // The matrix
  // ══════════════════════════════════════════════════════════════════════════

  function mount(el, opts) {
    injectStyles();
    opts = opts || {};
    var state = { data: null, staffId: opts.staffId || null, dirty: {}, channels: null };

    el.classList.add('wnm');
    el.innerHTML = '<div class="wnm-card"><div class="wnm-sub">Loading notification settings…</div></div>';

    function load() {
      var q = state.staffId ? ('?staff_id=' + encodeURIComponent(state.staffId)) : '';
      return Promise.all([
        api(API_MATRIX + q),
        api(API_CHANNEL).catch(function () { return null; }),
        api(API_TG + '/status').catch(function () { return null; }),
      ]).then(function (r) {
        state.data = r[0]; state.channels = r[1]; state.telegram = r[2];
        state.staffId = r[0].staff.id;
        state.dirty = {};
        render();
      }).catch(function (e) {
        el.innerHTML = '<div class="wnm-card"><div class="wnm-empty">Could not load notification settings — '
          + esc(e.message || e) + '</div></div>';
      });
    }

    function channelCard() {
      var ch = state.channels;
      if (!ch) return '';
      var order = [
        ['inapp',    '🔔', 'In-app bell'],
        ['push',     '📱', 'Phone / browser push'],
        ['telegram', '✈️', 'Telegram'],
        ['email',    '📧', 'Email'],
      ];
      return '<div class="wnm-card">' +
        '<div class="wnm-h"><h3>Where Wren can reach you</h3></div>' +
        '<div class="wnm-chan">' +
        order.map(function (o) {
          var k = o[0], c = ch[k] || {};
          return '<div class="wnm-chan-item">' +
            '<div class="wnm-chan-name"><span class="wnm-dot ' + (c.ready ? 'on' : 'off') + '"></span>' +
              o[1] + ' ' + esc(o[2]) +
              ' <span class="wnm-pill ' + (c.ready ? 'on' : '') + '">' + (c.ready ? 'Ready' : 'Not set up') + '</span></div>' +
            (c.reason ? '<div class="wnm-chan-why">' + esc(c.reason) + '</div>' : '') +
          '</div>';
        }).join('') +
        '</div></div>';
    }

    function rowHtml(c) {
      var tgReady = state.channels && state.channels.telegram && state.channels.telegram.ready;
      var tgWhy   = state.channels && state.channels.telegram ? state.channels.telegram.reason : '';
      var d       = state.dirty[c.key] || {};
      var mode    = d.mode !== undefined ? d.mode : c.mode;
      var tg      = d.telegram !== undefined ? d.telegram : c.telegram;
      var scope   = d.scope !== undefined ? d.scope : c.scope;

      var modeOpts = ['off', 'inapp', 'inapp_push', 'digest'].map(function (m) {
        // A compliance-locked category cannot be silenced OR deferred to a
        // daily digest — the server enforces both, so the UI must not offer them.
        var dis = c.locked && (m === 'off' || m === 'digest');
        return '<option value="' + m + '"' + (mode === m ? ' selected' : '') + (dis ? ' disabled' : '') + '>'
             + esc(MODE_LABELS[m]) + (dis ? ' — not allowed' : '') + '</option>';
      }).join('');

      var scopeOpts = ['all', 'my_room', 'my_keychildren'].map(function (sc) {
        return '<option value="' + sc + '"' + (scope === sc ? ' selected' : '') + '>' + esc(SCOPE_LABELS[sc]) + '</option>';
      }).join('');

      return '<div class="wnm-row" data-key="' + esc(c.key) + '">' +
        '<div class="wnm-row-name">' + esc(c.label) +
          (c.locked ? ' <span class="wnm-tag locked" title="Compliance-critical — cannot be muted or digested">Always on</span>' : '') +
          (c.urgent && !c.locked ? ' <span class="wnm-tag urgent">Urgent</span>' : '') +
          (c.manager_only ? ' <span class="wnm-tag mgr">Managers</span>' : '') +
        '</div>' +
        '<div><span class="wnm-cell-label">Delivery</span>' +
          '<select class="wnm-sel" data-f="mode" aria-label="Delivery for ' + esc(c.label) + '">' + modeOpts + '</select></div>' +
        '<div><label class="wnm-check"><input type="checkbox" data-f="telegram"' +
          (tg ? ' checked' : '') + (tgReady ? '' : ' disabled') +
          ' aria-label="Telegram for ' + esc(c.label) + '"' +
          (tgReady ? '' : ' title="' + esc(tgWhy || 'Telegram not linked') + '"') + '>' +
          '<span>Telegram</span></label></div>' +
        '<div><span class="wnm-cell-label">Which children/staff</span>' +
          '<select class="wnm-sel" data-f="scope" aria-label="Scope for ' + esc(c.label) + '">' + scopeOpts + '</select></div>' +
      '</div>';
    }

    function render() {
      var d = state.data;
      var q = d.quiet_hours || {};
      var qEnabled = q.quiet_hours_enabled !== false;
      var qs = String(q.quiet_hours_start || '20:00').slice(0, 5);
      var qe = String(q.quiet_hours_end   || '07:00').slice(0, 5);

      var staffPicker = '';
      if (d.can_edit_others && d.staff_list && d.staff_list.length) {
        staffPicker =
          '<label class="wnm-check" style="gap:8px">' +
            '<span class="wnm-sub">Settings for</span>' +
            '<select class="wnm-sel" id="wnm-staff">' +
              d.staff_list.map(function (s) {
                return '<option value="' + s.id + '"' + (s.id === d.staff.id ? ' selected' : '') + '>'
                     + esc(s.name) + ' — ' + esc(String(s.role || '').replace(/_/g, ' ')) + '</option>';
              }).join('') +
            '</select>' +
          '</label>';
      }

      el.innerHTML =
        '<div class="wnm-card">' +
          '<div class="wnm-h">' +
            '<div><h3>🔔 Notification matrix</h3>' +
              '<div class="wnm-sub">Every notification Wren can send, per person, per portal. ' +
              'Choose how each one reaches ' + esc(d.is_self ? 'you' : d.staff.name) + '.</div></div>' +
            '<div class="wnm-actions">' + staffPicker +
              '<span class="wnm-dirty" id="wnm-dirty" hidden></span>' +
              '<button class="wnm-btn primary" id="wnm-save" disabled>Save changes</button>' +
            '</div>' +
          '</div>' +
        '</div>' +

        channelCard() +

        '<div class="wnm-card">' +
          '<div class="wnm-h"><h3>🌙 Quiet hours</h3></div>' +
          '<div class="wnm-sub" style="margin-bottom:10px">Push is held back during these hours and delivered afterwards. ' +
          'The bell still updates, and compliance-critical alerts still come straight through.</div>' +
          '<div class="wnm-actions">' +
            '<label class="wnm-check"><input type="checkbox" id="wnm-q-on"' + (qEnabled ? ' checked' : '') + '><span>Quiet hours on</span></label>' +
            '<label class="wnm-check"><span>From</span><input class="wnm-sel" type="time" id="wnm-q-start" value="' + esc(qs) + '"></label>' +
            '<label class="wnm-check"><span>Until</span><input class="wnm-sel" type="time" id="wnm-q-end" value="' + esc(qe) + '"></label>' +
          '</div>' +
        '</div>' +

        d.portals.map(function (p, i) {
          if (!p.categories.length) return '';
          return '<details class="wnm-portal"' + (i === 0 ? ' open' : '') + '>' +
            '<summary><span class="wnm-portal-name">' + esc(p.label) + '</span>' +
              '<span class="wnm-portal-hint">' + esc(p.hint) + '</span>' +
              '<span class="wnm-pill">' + p.categories.length + '</span></summary>' +
            '<div class="wnm-rows">' + p.categories.map(rowHtml).join('') + '</div>' +
          '</details>';
        }).join('');

      wire();
    }

    function markDirty(key, field, value) {
      (state.dirty[key] = state.dirty[key] || {})[field] = value;
      var n = Object.keys(state.dirty).length;
      var badge = el.querySelector('#wnm-dirty');
      if (badge) { badge.hidden = n === 0; badge.textContent = n + ' unsaved'; }
      var save = el.querySelector('#wnm-save');
      if (save) save.disabled = false;
    }

    function wire() {
      el.addEventListener('change', function (ev) {
        var t = ev.target;
        var row = t.closest && t.closest('.wnm-row');
        if (row && t.dataset && t.dataset.f) {
          var key = row.dataset.key;
          markDirty(key, t.dataset.f, t.type === 'checkbox' ? t.checked : t.value);
          return;
        }
        if (t.id === 'wnm-q-on' || t.id === 'wnm-q-start' || t.id === 'wnm-q-end') {
          var save = el.querySelector('#wnm-save'); if (save) save.disabled = false;
          return;
        }
        if (t.id === 'wnm-staff') { state.staffId = t.value; load(); }
      });

      var save = el.querySelector('#wnm-save');
      if (save) save.addEventListener('click', function () {
        save.disabled = true; save.textContent = 'Saving…';
        var cats = Object.keys(state.dirty).map(function (k) {
          var d = state.dirty[k];
          return { key: k, mode: d.mode, telegram: d.telegram, scope: d.scope };
        });
        api(API_MATRIX, {
          method: 'PUT',
          body: {
            staff_id: state.staffId,
            categories: cats,
            quiet_hours: {
              quiet_hours_enabled: el.querySelector('#wnm-q-on').checked,
              quiet_hours_start:   el.querySelector('#wnm-q-start').value,
              quiet_hours_end:     el.querySelector('#wnm-q-end').value,
            },
          },
        }).then(function (r) {
          if (r.rejected && r.rejected.length) {
            toast(r.rejected.map(function (x) { return x.why; }).join(' · '), 'error');
          } else {
            toast('Notification settings saved', 'success');
          }
          save.textContent = 'Save changes';
          return load();
        }).catch(function (e) {
          toast('Save failed: ' + (e.message || e), 'error');
          save.disabled = false; save.textContent = 'Save changes';
        });
      });
    }

    return load();
  }

  window.WrenNotificationMatrix = {
    mount: mount,
    mountDeviceCard: mountDeviceCard,
    deviceState: deviceState,
    enableOnThisDevice: enableOnThisDevice,
    disableOnThisDevice: disableOnThisDevice,
  };
})();
