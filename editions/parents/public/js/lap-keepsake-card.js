/* lap-keepsake-card.js — b341 (2026-09-21)
 * The family's own memory book, as one card. Used by /welcome/keepsake and by the confirmation
 * on /welcome/leaving, so "Create", "Make it again" and "Email me the link" exist in ONE place.
 *
 *   LapKeepsakeCard.render(el, state, { onChange })
 *     state = one entry of GET /welcome/keepsake/api/state → .children[]
 *
 * Everything the family sees is decided by the server (can_create, create_blocked, dates in words);
 * this file only draws it and calls /create and /send-link. Icons are inline strokes (currentColor);
 * no emoji. Colours are the parents-portal tokens, so light and dark both follow lap-boot.js.
 */
(function () {
  'use strict';
  var API = '/welcome/keepsake/api';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ic(paths) {
    return '<svg class="lkc-i" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }
  var I = {
    book:    ic('<path d="M5 4.5h11.5A2.5 2.5 0 0 1 19 7v13H7.5A2.5 2.5 0 0 1 5 17.5z"/><path d="M5 17.5A2.5 2.5 0 0 1 7.5 15H19"/>'),
    save:    ic('<path d="M12 4v11"/><path d="m7.5 11 4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/>'),
    pdf:     ic('<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5H7a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z"/><path d="M14 3.5V8h4"/><path d="M9.5 13h5M9.5 16.5h5"/>'),
    mail:    ic('<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7.5 8 6 8-6"/>'),
    again:   ic('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>'),
    plus:    ic('<path d="M12 5v14M5 12h14"/>'),
    check:   ic('<path d="m5 12.5 4.5 4.5L19 7.5"/>')
  };

  function injectCss() {
    if (document.querySelector('style[data-lkc]')) return;
    var s = document.createElement('style'); s.setAttribute('data-lkc', '1');
    s.textContent =
      '.lkc{background:var(--surface,#fff);border:1px solid var(--border,#e8e0d0);border-radius:14px;padding:16px;margin-bottom:14px}' +
      '.lkc h2{font-size:1.1rem;line-height:1.3;color:var(--text,#2a2a2a);margin:0 0 4px;font-family:inherit;font-weight:800}' +
      '.lkc p{font-size:.9rem;line-height:1.5;color:var(--text-m,#5a5a5a);margin:6px 0 0}' +
      '.lkc p.lkc-strong{color:var(--text,#2a2a2a)}' +
      '.lkc-stat{display:flex;align-items:baseline;gap:8px;margin-top:10px}' +
      '.lkc-stat b{font-size:1.5rem;line-height:1;color:var(--lap-ink,var(--green,#2d5a4a));font-weight:800}' +
      '.lkc-stat span{font-size:.82rem;color:var(--text-m,#5a5a5a)}' +
      '.lkc-btns{display:grid;gap:8px;margin-top:14px}' +
      '.lkc-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:48px;padding:0 16px;border-radius:12px;border:1.5px solid var(--green,#2d5a4a);background:var(--green,#2d5a4a);color:#fff;font:800 .92rem Nunito,system-ui,sans-serif;cursor:pointer;text-decoration:none}' +
      '.lkc-btn.quiet{background:var(--cream,#fefcf8);color:var(--lap-ink,var(--green,#2d5a4a));border-color:var(--border,#e8e0d0)}' +
      '.lkc-btn:disabled{opacity:.6;cursor:default}' +
      '.lkc-row2{display:grid;grid-template-columns:1fr 1fr;gap:8px}' +
      '.lkc-note{font-size:.84rem;line-height:1.5;color:var(--text,#2a2a2a);background:var(--lap-tint-orange,#fdf5e8);border-left:3px solid var(--orange,#f0a050);border-radius:8px;padding:9px 11px;margin-top:12px}' +
      '.lkc-ok{border-left-color:var(--lap-ink,var(--green,#2d5a4a))}' +
      '.lkc-confirm{margin-top:10px;padding:12px;border:1.5px solid var(--border,#e8e0d0);border-radius:12px}' +
      '.lkc-confirm p{margin:0 0 8px;color:var(--text,#2a2a2a)}' +
      '.lkc-spin{width:18px;height:18px;border:2.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:lkcsp .9s linear infinite}' +
      '@keyframes lkcsp{to{transform:rotate(360deg)}}' +
      '@media(prefers-reduced-motion:reduce){.lkc-spin{animation:none}}';
    document.head.appendChild(s);
  }

  function post(path, body) {
    return fetch(API + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; j._ok = r.ok; return j; }); });
  }
  function waitText(sec) {
    var m = Math.max(1, Math.ceil((sec || 60) / 60));
    return m === 1 ? 'about a minute' : 'about ' + m + ' minutes';
  }

  function render(el, c, opts) {
    injectCss();
    opts = opts || {};
    var name = esc(c.name), p = c.package, h = '<section class="lkc" aria-labelledby="lkc-h-' + c.child_id + '">';

    if (p) {
      h += '<h2 id="lkc-h-' + c.child_id + '">' + name + '’s memory book</h2>';
      h += '<div class="lkc-stat"><b>' + (p.media_count || 0) + '</b><span>photos and videos</span></div>';
      h += '<p class="lkc-strong">It covers everything up to ' + esc(p.covers_up_to_text) + '. You can make it again any time to include newer photos.</p>';
      if (p.withheld > 0) h += '<p>' + p.withheld + ' picture' + (p.withheld === 1 ? ' is' : 's are') + ' not in the book: another child’s family has asked that pictures their child appears in are not shared with other families.</p>';
      h += '<div class="lkc-btns">' +
        '<a class="lkc-btn" href="' + esc(p.url) + '">' + I.book + 'Open the memory book</a>' +
        '<div class="lkc-row2"><a class="lkc-btn quiet" href="' + esc(p.download_url) + '">' + I.save + 'Save it</a>' +
        '<a class="lkc-btn quiet" href="' + esc(p.pdf_url) + '">' + I.pdf + 'PDF</a></div>' +
        '<button type="button" class="lkc-btn quiet" data-a="send">' + I.mail + 'Email me the link</button>' +
        (c.can_create ? '<button type="button" class="lkc-btn quiet" data-a="again">' + I.again + 'Make it again with the latest photos</button>' : '') +
        '</div>';
      if (!c.can_create && c.create_blocked === 'rate_limited') h += '<p>You made it just now. You can make it again in ' + waitText(c.retry_after_seconds) + '.</p>';
      if (!c.can_create && c.create_blocked === 'daily_limit') h += '<p>That is as many as we can make today — you can make it again tomorrow.</p>';
      h += '<div class="lkc-note lkc-ok"><b>When this link stops working.</b> ' +
        (p.expires_text ? 'The link works until ' + esc(p.expires_text) + '. ' : '') +
        'Once ' + name + ' has left, your login to this app stops working, but the link carries on until that date. Save the book to your device or email yourself the link so you still have it.</div>';
    } else if (c.gathering) {
      h += '<h2 id="lkc-h-' + c.child_id + '">' + name + '’s memory book</h2>';
      h += '<div class="lkc-note">We are still gathering ' + name + '’s photos — we will have this ready shortly. The nursery has been told, and you do not need to do anything.</div>';
      if (c.can_create) h += '<div class="lkc-btns"><button type="button" class="lkc-btn quiet" data-a="create">' + I.again + 'Try again</button></div>';
    } else {
      h += '<h2 id="lkc-h-' + c.child_id + '">' + name + '’s memory book</h2>';
      h += '<p class="lkc-strong">A keepsake of ' + name + '’s whole time at Your Nursery — photos, videos, milestones and their learning journey. It is free and it is yours to keep.</p>';
      h += '<div class="lkc-btns"><button type="button" class="lkc-btn" data-a="create"' + (c.can_create ? '' : ' disabled') + '>' + I.plus + 'Create my memory book</button></div>';
      if (c.create_blocked === 'rate_limited') h += '<p>Please wait ' + waitText(c.retry_after_seconds) + ' before trying again.</p>';
      if (c.create_blocked === 'daily_limit') h += '<p>That is as many as we can make today — please try again tomorrow.</p>';
      if (c.create_blocked === 'not_leaving') h += '<p>You can make it once ' + name + '’s last day is set.</p>';
    }
    h += '<div class="lkc-msg" role="status" aria-live="polite"></div></section>';
    el.innerHTML = h;

    // One delegated listener per element, reading the CURRENT state: render() runs again after a
    // "gathering" reply or a cancelled confirm, and a listener per render would fire the action twice.
    el._lkc = { c: c, opts: opts };
    if (el._lkcBound) return;
    el._lkcBound = true;

    function say(text, ok) { var m = el.querySelector('.lkc-msg'); if (m) m.innerHTML = text ? '<div class="lkc-note' + (ok ? ' lkc-ok' : '') + '">' + esc(text) + '</div>' : ''; }
    function busy(btn, text) { btn.disabled = true; btn.dataset.was = btn.innerHTML; btn.innerHTML = '<span class="lkc-spin" aria-hidden="true"></span>' + esc(text); }
    function idle(btn) { btn.disabled = false; if (btn.dataset.was) btn.innerHTML = btn.dataset.was; }

    function make(btn) {
      var cur = el._lkc.c, o = el._lkc.opts;
      busy(btn, 'Making ' + cur.name + '’s memory book… ' + waitText(60));
      post('/create', { child_id: cur.child_id }).then(function (j) {
        if (j._ok && j.url) { location.href = j.url; return; }            // "lands them on it"
        idle(btn);
        if (j.reason === 'gathering') { cur.gathering = true; cur.can_create = false; if (o.onChange) o.onChange(); render(el, cur, o); return; }
        say(j.error || 'That did not work — please try again in a moment.');
        if (o.onChange && j._status === 429) o.onChange();
      }).catch(function () { idle(btn); say('We could not reach Your Nursery — please check your connection and try again.'); });
    }

    el.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-a]'); if (!b || !el.contains(b)) return;
      var cur = el._lkc.c, o = el._lkc.opts, a = b.dataset.a;
      if (a === 'create' || a === 'again-yes') return make(b);
      if (a === 'again') {
        // Two steps, not a browser confirm(): the old link stops working, and that is worth a sentence.
        var box = document.createElement('div'); box.className = 'lkc-confirm';
        box.innerHTML = '<p>This makes a new memory book and the old link stops working. If you have saved or shared the old link, use the new one instead.</p>' +
          '<div class="lkc-row2"><button type="button" class="lkc-btn" data-a="again-yes">Make it again</button><button type="button" class="lkc-btn quiet" data-a="again-no">Cancel</button></div>';
        b.replaceWith(box); return;
      }
      if (a === 'again-no') return render(el, cur, o);
      if (a === 'send') {
        busy(b, 'Sending…');
        post('/send-link', { child_id: cur.child_id }).then(function (j) {
          idle(b);
          if (j._ok && j.emailed) say('Sent to ' + (j.to_hint || 'your email') + '. It can take a minute to arrive — check your junk folder if it does not.', true);
          else if (j._ok) say(j.note || 'We could not send the email just now.');
          else say(j.error || 'That did not work — please try again in a moment.');
        }).catch(function () { idle(b); say('We could not reach Your Nursery — please check your connection and try again.'); });
      }
    });
  }

  window.LapKeepsakeCard = { render: render, load: function () {
    return fetch(API + '/state', { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  } };
})();
