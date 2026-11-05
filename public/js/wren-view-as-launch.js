/* ─────────────────────────────────────────────────────────────────────────────
 * b320 — the Roost end of "View as".
 *
 * One helper so the button can be added to any Roost screen that shows a person
 * without copying the flow around. It asks the server to open a session and
 * then opens the returned URL in a new tab.
 *
 * What travels in that URL is a one-time code, not a token: 32 random bytes,
 * two minutes, single use, sha256 in the database. The session token is minted
 * on the target portal's own host by /api/view-as/redeem and handed to an
 * HttpOnly cookie, so it never reaches an address bar, browser history, a log
 * line or an email.
 *
 * The window is opened synchronously BEFORE the request, then pointed at the
 * URL when it comes back — a window.open() after an await is a pop-up blocker's
 * definition of unsolicited.
 * ───────────────────────────────────────────────────────────────────────────── */
(function (W) {
  'use strict';

  function say(msg) {
    if (window.Wren && typeof Wren.alert === 'function') Wren.alert(msg);
    else alert(msg);
  }

  /**
   * open({ kind:'staff', staff_id }) — opens Seed as that member of staff.
   * open({ kind:'parent', email })   — opens Finch as that parent.
   */
  function open_(opts) {
    var tab = window.open('', '_blank');   // claimed while we still have the click
    var body = JSON.stringify(opts);
    return fetch('/api/view-as/start', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (sessionStorage.getItem('wrenToken') || ''),
      },
      body: body,
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          if (tab) tab.close();
          say((res.d && res.d.message) || 'Could not open a view-as session.');
          return null;
        }
        if (tab) tab.location.replace(res.d.url);
        else window.open(res.d.url, '_blank');   // pop-up blocked — try again plainly
        return res.d;
      })
      .catch(function () {
        if (tab) tab.close();
        say('Could not open a view-as session.');
        return null;
      });
  }

  /** A ready-made button. `label` defaults to "View as". */
  function button(opts, label) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'wva-launch';
    b.textContent = label || '👁️ View as';
    b.title = 'Open their portal exactly as they see it — read only, 30 minutes, and recorded.';
    b.addEventListener('click', function () { open_(opts); });
    return b;
  }

  W.WrenViewAs = { open: open_, button: button };
})(window);
