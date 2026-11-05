/* b131 — App Lock settings panel. Bottom-sheet modal, opened from the parents
 * "More" sheet (Help & tools grid, pwa.js). Depends on wren-parent-app-lock.js
 * (window.WrenParentAppLock) for the actual enable/disable/verify calls.
 */
;(function () {
  'use strict';
  if (window.WrenParentAppLockSettings) return;

  var panel = null;
  var IDLE_OPTIONS = [1, 5, 10, 15, 30];

  function css() {
    if (document.getElementById('pals-css')) return;
    var s = document.createElement('style'); s.id = 'pals-css';
    s.textContent =
      '#pals-panel{position:fixed;inset:0;z-index:9500;display:flex;align-items:flex-end;justify-content:center;background:rgba(20,30,25,.5)}' +
      '#pals-card{width:100%;max-width:480px;background:#fefcf8;color:#2a2a2a;border-radius:18px 18px 0 0;' +
        'padding:20px 20px calc(24px + env(safe-area-inset-bottom,0px));max-height:88vh;overflow-y:auto;' +
        'box-shadow:0 -6px 30px rgba(0,0,0,.3);font-family:Nunito,system-ui,sans-serif;position:relative}' +
      '@media(min-width:560px){#pals-panel{align-items:center}#pals-card{border-radius:18px;max-height:80vh}}' +
      '#pals-card h3{margin:0 0 4px;font:700 1.15rem/1.2 "Crimson Pro",Georgia,serif;color:#2d5a4a}' +
      '.pals-sub{color:#6b7a72;font-size:.85rem;margin:0 0 16px}' +
      '#pals-close{position:absolute;top:14px;right:14px;background:transparent;border:0;font-size:1.4rem;color:#8a8a8a;cursor:pointer;line-height:1;padding:4px}' +
      '.pals-row{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid #ede7da}' +
      '.pals-row:last-child{border-bottom:0}' +
      '.pals-label{font-weight:700;font-size:.92rem}' +
      '.pals-hint{font-size:.78rem;color:#8a8a8a;margin-top:2px}' +
      '.pals-toggle{position:relative;width:46px;height:26px;border-radius:14px;background:#ddd4c0;border:0;cursor:pointer;flex:0 0 auto}' +
      '.pals-toggle.on{background:#2d5a4a}' +
      '.pals-toggle .knob{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:.15s}' +
      '.pals-toggle.on .knob{left:23px}' +
      '.pals-btn{width:100%;padding:12px;border-radius:10px;border:1px solid #e0dcd0;background:#fff;color:#2a2a2a;' +
        'font-weight:700;cursor:pointer;font-size:.9rem;min-height:44px;margin-top:8px}' +
      '.pals-btn.primary{background:#2d5a4a;border-color:#2d5a4a;color:#fff}' +
      '.pals-btn.danger{color:#c0392b;border-color:#f0d0cc}' +
      '.pals-in{width:100%;box-sizing:border-box;background:#fff;border:1px solid #e0dcd0;border-radius:10px;' +
        'color:#2a2a2a;padding:11px;margin:6px 0;font-family:inherit;font-size:1.4rem;letter-spacing:.3em;text-align:center}' +
      '.pals-select{width:100%;box-sizing:border-box;background:#fff;border:1px solid #e0dcd0;border-radius:10px;' +
        'color:#2a2a2a;padding:9px;font-family:inherit;font-size:.88rem}' +
      '.pals-msg{font-size:.82rem;margin:6px 0;text-align:center}' +
      '.pals-msg.err{color:#c0392b}.pals-msg.ok{color:#2d5a4a}' +
      '.pals-step{display:none}.pals-step.active{display:block}';
    document.head.appendChild(s);
  }

  function close() { if (panel) { panel.remove(); panel = null; } }

  function render(status) {
    var enabled = !!status.enabled;
    var idle = status.idle_minutes || 5;
    var bioAvailable = window.WrenParentAppLock && window.WrenParentAppLock.biometricSupported();
    var bioRegistered = window.WrenParentAppLock && window.WrenParentAppLock.biometricRegisteredOnThisDevice();

    panel = document.createElement('div'); panel.id = 'pals-panel';
    panel.innerHTML =
      '<div id="pals-card" role="dialog" aria-label="App Lock settings">' +
        '<button id="pals-close" aria-label="Close">×</button>' +
        '<h3>🔒 App Lock</h3>' +
        '<p class="pals-sub">Add a PIN or Face ID / fingerprint so your child’s information stays private on this device.</p>' +

        '<div id="pals-step-main" class="pals-step active">' +
          '<div class="pals-row"><div><div class="pals-label">App Lock</div>' +
            '<div class="pals-hint">' + (enabled ? 'On — a PIN is required to open the app' : 'Off — no lock on this device') + '</div></div>' +
            '<button type="button" class="pals-toggle' + (enabled ? ' on' : '') + '" id="pals-toggle"><span class="knob"></span></button></div>' +
          (enabled ? (
            '<div class="pals-row"><div><div class="pals-label">Lock after idle</div><div class="pals-hint">Auto-lock if left untouched</div></div>' +
              '<select class="pals-select" id="pals-idle-select" style="max-width:120px">' +
                IDLE_OPTIONS.map(function (m) { return '<option value="' + m + '"' + (m === idle ? ' selected' : '') + '>' + m + ' min</option>'; }).join('') +
              '</select></div>' +
            '<div class="pals-row"><div><div class="pals-label">Face ID / Fingerprint</div>' +
              '<div class="pals-hint">' + (bioRegistered ? 'Registered on this device' : bioAvailable ? 'Available on this device' : 'Not supported on this device') + '</div></div>' +
              (bioAvailable ? '<button type="button" class="pals-btn" id="pals-bio-btn" style="width:auto;margin:0">' + (bioRegistered ? 'Re-register' : 'Set up') + '</button>' : '') +
              '</div>' +
            '<button type="button" class="pals-btn" id="pals-change-pin-btn">Change PIN</button>' +
            '<button type="button" class="pals-btn danger" id="pals-turnoff-btn">Turn off App Lock</button>'
          ) : '') +
          '<div class="pals-msg" id="pals-main-msg"></div>' +
        '</div>' +

        '<div id="pals-step-setpin" class="pals-step">' +
          '<div class="pals-label" style="margin-bottom:6px">Choose a 4–6 digit PIN</div>' +
          '<input class="pals-in" id="pals-pin1" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="••••">' +
          '<div class="pals-label" style="margin-bottom:6px;margin-top:10px">Confirm PIN</div>' +
          '<input class="pals-in" id="pals-pin2" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="••••">' +
          '<div class="pals-msg err" id="pals-setpin-msg"></div>' +
          '<button type="button" class="pals-btn primary" id="pals-save-pin-btn">Save PIN</button>' +
          '<button type="button" class="pals-btn" id="pals-cancel-setpin-btn">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(panel);

    panel.addEventListener('click', function (e) { if (e.target === panel) close(); });
    document.getElementById('pals-close').addEventListener('click', close);

    function showStep(id) {
      panel.querySelectorAll('.pals-step').forEach(function (el) { el.classList.remove('active'); });
      document.getElementById(id).classList.add('active');
    }

    function digitsOnly(el) { el.value = el.value.replace(/\D/g, '').slice(0, 6); }

    var toggle = document.getElementById('pals-toggle');
    if (toggle) toggle.addEventListener('click', function () {
      if (enabled) {
        if (!confirm('Turn off App Lock on this device?')) return;
        window.WrenParentAppLock.disable().then(function () { open(); });
      } else {
        showStep('pals-step-setpin');
      }
    });

    var bioBtn = document.getElementById('pals-bio-btn');
    if (bioBtn) bioBtn.addEventListener('click', function () {
      var msg = document.getElementById('pals-main-msg');
      msg.className = 'pals-msg'; msg.textContent = 'Follow your device prompt…';
      window.WrenParentAppLock.registerBiometric().then(function () {
        msg.className = 'pals-msg ok'; msg.textContent = 'Registered!';
        setTimeout(function () { open(); }, 700);
      }).catch(function (e) {
        msg.className = 'pals-msg err'; msg.textContent = 'Could not register: ' + (e && e.message ? e.message : 'cancelled');
      });
    });

    var changeBtn = document.getElementById('pals-change-pin-btn');
    if (changeBtn) changeBtn.addEventListener('click', function () { showStep('pals-step-setpin'); });

    var turnoffBtn = document.getElementById('pals-turnoff-btn');
    if (turnoffBtn) turnoffBtn.addEventListener('click', function () {
      if (!confirm('Turn off App Lock on this device? Your PIN and biometric will be forgotten.')) return;
      window.WrenParentAppLock.disable().then(function () { open(); });
    });

    var pin1 = document.getElementById('pals-pin1'), pin2 = document.getElementById('pals-pin2');
    if (pin1) pin1.addEventListener('input', function () { digitsOnly(pin1); });
    if (pin2) pin2.addEventListener('input', function () { digitsOnly(pin2); });

    var cancelSetpin = document.getElementById('pals-cancel-setpin-btn');
    if (cancelSetpin) cancelSetpin.addEventListener('click', function () { showStep('pals-step-main'); });

    var savePin = document.getElementById('pals-save-pin-btn');
    if (savePin) savePin.addEventListener('click', function () {
      var msg = document.getElementById('pals-setpin-msg');
      var p1 = pin1.value, p2 = pin2.value;
      if (!/^\d{4,6}$/.test(p1)) { msg.textContent = 'PIN must be 4–6 digits'; return; }
      if (p1 !== p2) { msg.textContent = 'PINs don’t match'; return; }
      var idleSelect = document.getElementById('pals-idle-select');
      var idleMinutes = idleSelect ? parseInt(idleSelect.value, 10) : 5;
      window.WrenParentAppLock.setPin(p1, idleMinutes).then(function (res) {
        if (!res.ok) { msg.textContent = (res.body && res.body.error) || 'Could not save PIN'; return; }
        open();
      });
    });

    var idleSel = document.getElementById('pals-idle-select');
    if (idleSel) idleSel.addEventListener('change', function () {
      window.WrenParentAppLock.setIdleMinutes(parseInt(idleSel.value, 10));
    });
  }

  function open() {
    css();
    close();
    if (!window.WrenParentAppLock) { alert('App Lock isn’t available on this page — try again from Home.'); return; }
    window.WrenParentAppLock.getStatus().then(render);
  }

  window.WrenParentAppLockSettings = { open: open };
})();
