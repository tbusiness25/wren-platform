/* lap-family.js — b342 (2026-09-21)
 * A family keeps their own details up to date: parent / carer 1, parent / carer 2, emergency contacts.
 *
 *   LapFamily.mount(el)    the three sections on Your account (/welcome/details)
 *   LapFamily.prompt(el)   the standing "add an emergency contact" card (home screen); mounts itself into
 *                          every [data-family-prompt] on DOMContentLoaded
 *
 * Everything a family reads is decided by the server (what is editable, who can sign in, what the office has decided
 * about collection); this file only draws it and posts /welcome/family/api/save. No emoji, inline stroke icons
 * (currentColor), the parents-portal tokens — so light and dark both follow lap-boot.js.
 *
 * "Mandatory" is asked for, not enforced by locking anything: a family with no emergency contact sees the prompt
 * until they add one, and nothing else in the app is held behind it.
 */
(function () {
  'use strict';
  var API = '/welcome/family/api';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ic(paths) {
    return '<svg class="lf-i" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }
  var I = {
    person: ic('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"/>'),
    phone:  ic('<path d="M5 4.5h4l1.5 4-2 1.3a11 11 0 0 0 5.7 5.7l1.3-2 4 1.5v4a1.5 1.5 0 0 1-1.6 1.5A15 15 0 0 1 3.5 6.1 1.5 1.5 0 0 1 5 4.5z"/>'),
    plus:   ic('<path d="M12 5v14M5 12h14"/>'),
    trash:  ic('<path d="M5 7h14"/><path d="M9 7V4.5h6V7"/><path d="M7 7l.8 12.5h8.4L17 7"/>'),
    info:   ic('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>'),
    check:  ic('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    key:    ic('<circle cx="8" cy="15" r="3.5"/><path d="m10.5 12.5 8-8M15 8l2.5 2.5"/>')
  };

  function injectCss() {
    if (document.querySelector('style[data-lf]')) return;
    var s = document.createElement('style'); s.setAttribute('data-lf', '1');
    s.textContent =
      '.lf{margin:0 0 22px;--lf-err:var(--no,#c0392b)}' +
      /* the red used on the dark card was 2.8:1; a lighter red of the same hue clears 7:1 there */
      'html.lap-shell[data-lap-theme="dark"]:not(.lap-custom) .lf{--lf-err:#ff9b8f}' +
      '.lf h2.lf-h{font-size:1.25rem;line-height:1.25;margin:0 0 10px;color:var(--lap-ink,var(--green,#2d5a4a))}' +
      '.lf-card{background:var(--surface,#fff);border:1px solid var(--border,#e8e0d0);border-radius:14px;padding:16px;margin-bottom:12px}' +
      '.lf-card h3{display:flex;align-items:center;gap:8px;font-size:1.05rem;line-height:1.3;margin:0 0 4px;color:var(--text,#2a2a2a);font-family:inherit;font-weight:800}' +
      '.lf-card h3 .lf-i{color:var(--lap-ink,var(--green,#2d5a4a));flex:0 0 auto}' +
      '.lf-sub{font-size:.85rem;line-height:1.5;color:var(--text-m,#5a5a5a);margin:0 0 12px}' +
      '.lf-grid{display:grid;grid-template-columns:1fr;gap:12px}' +
      '@media(min-width:560px){.lf-grid.two{grid-template-columns:1fr 1fr}}' +
      '.lf-f label{display:block;font-size:.8rem;font-weight:700;color:var(--text-m,#5a5a5a);margin:0 0 4px}' +
      '.lf-f input[type=text],.lf-f input[type=email],.lf-f input[type=tel],.lf-f select{width:100%;box-sizing:border-box;min-height:46px;border:1.5px solid var(--border,#e8e0d0);' +
        'background:var(--cream,#fefcf8);color:var(--text,#2a2a2a);border-radius:10px;padding:10px 12px;font:inherit;font-size:.95rem}' +
      '.lf-f input:focus,.lf-f select:focus,.lf-btn:focus-visible,.lf-link:focus-visible,.lf-chk input:focus-visible{outline:2px solid var(--lap-ink,var(--green,#2d5a4a));outline-offset:2px}' +
      '.lf-f.bad input,.lf-f.bad select{border-color:var(--lf-err)}' +
      '.lf-note{display:flex;gap:9px;align-items:flex-start;font-size:.84rem;line-height:1.5;color:var(--text,#2a2a2a);background:var(--lap-tint-orange,#fdf5e8);' +
        'border-left:3px solid var(--orange,#f0a050);border-radius:8px;padding:9px 11px;margin-top:10px}' +
      '.lf-note .lf-i{width:18px;height:18px;flex:0 0 auto;margin-top:1px;color:var(--lap-ink,var(--green,#2d5a4a))}' +
      '.lf-note.ok{border-left-color:var(--lap-ink,var(--green,#2d5a4a));background:var(--lap-tint-green,#eef5f1)}' +
      '.lf-note strong{font-weight:800}' +
      '.lf-err{font-size:.85rem;line-height:1.45;color:var(--lf-err);font-weight:700;margin-top:8px}' +
      '.lf-ec{border:1.5px solid var(--border,#e8e0d0);border-radius:12px;padding:12px;margin-top:10px}' +
      '.lf-ec-top{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}' +
      '.lf-ec-n{font-size:.78rem;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--text-m,#5a5a5a)}' +
      '.lf-chk{display:flex;align-items:flex-start;gap:10px;min-height:44px;margin-top:10px;font-size:.9rem;line-height:1.4;color:var(--text,#2a2a2a);cursor:pointer}' +
      '.lf-chk input{width:22px;height:22px;flex:0 0 auto;margin:2px 0 0;accent-color:var(--green,#2d5a4a)}' +
      '.lf-pill{display:inline-block;font-size:.76rem;font-weight:800;border-radius:999px;padding:3px 10px;margin-top:2px}' +
      '.lf-pill.wait{background:var(--lap-tint-orange,#fdf5e8);color:var(--text,#2a2a2a);border:1px solid var(--orange,#f0a050)}' +
      '.lf-pill.ok{background:var(--lap-tint-green,#eef5f1);color:var(--lap-ink,var(--green,#2d5a4a));border:1px solid var(--lap-ink,var(--green,#2d5a4a))}' +
      '.lf-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:0 18px;border-radius:12px;border:1.5px solid var(--green,#2d5a4a);' +
        'background:var(--green,#2d5a4a);color:#fff;font:800 .92rem Nunito,system-ui,sans-serif;cursor:pointer;text-decoration:none}' +
      '.lf-btn.quiet{background:var(--cream,#fefcf8);color:var(--lap-ink,var(--green,#2d5a4a));border-color:var(--border,#e8e0d0)}' +
      '.lf-btn.small{min-height:44px;padding:0 12px;font-size:.85rem}' +
      '.lf-btn.wide{width:100%}' +
      '.lf-btn:disabled{opacity:.6;cursor:default}' +
      '.lf-others{font-size:.85rem;line-height:1.55;color:var(--text-m,#5a5a5a);margin-top:4px}' +
      '.lf-saved{font-size:.85rem;color:var(--lap-ink,var(--green,#2d5a4a));font-weight:700;margin-top:8px}' +
      '.lf-hint{font-size:.78rem;line-height:1.45;color:var(--text-m,#5a5a5a);margin-top:5px}' +
      '.lf-ro{font-size:.92rem;line-height:1.5;color:var(--text,#2a2a2a)}' +
      '.lf-ro b{font-weight:800}' +
      /* the standing prompt (home + Your account) */
      '.lf-prompt{display:flex;gap:12px;align-items:flex-start;background:var(--surface,#fff);border:1px solid var(--orange,#f0a050);border-left:5px solid var(--orange,#f0a050);' +
        'border-radius:14px;padding:14px 16px;margin-bottom:12px;text-decoration:none;color:var(--text,#2a2a2a)}' +
      '.lf-prompt .lf-i{width:24px;height:24px;flex:0 0 auto;margin-top:1px;color:var(--lap-ink,var(--green,#2d5a4a))}' +
      '.lf-prompt-t{font-weight:800;font-size:1rem;line-height:1.3;color:var(--text,#2a2a2a)}' +
      '.lf-prompt-s{font-size:.88rem;line-height:1.5;color:var(--text-m,#5a5a5a);margin-top:3px}' +
      '.lf-prompt-go{display:inline-block;margin-top:8px;font-weight:800;font-size:.88rem;color:var(--lap-ink,var(--green,#2d5a4a))}';
    document.head.appendChild(s);
  }

  function get(path) {
    return fetch(API + path, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; j._ok = r.ok; return j; }); });
  }
  function post(path, body) {
    return fetch(API + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; j._ok = r.ok; return j; }); });
  }
  function names(list) {
    if (!list || !list.length) return 'your child';
    if (list.length === 1) return list[0];
    return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  }
  function toast(msg, isErr) {
    if (typeof window.toast === 'function') { window.toast(msg, isErr); return; }
    var t = document.getElementById('toast'); if (!t) return;
    t.textContent = msg; t.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.className = ''; }, 2600);
  }

  // ── the standing prompt ─────────────────────────────────────────────────────
  function promptCard(kids, href, inline) {
    var t = kids.length ? names(kids) + (kids.length === 1 ? " doesn't" : " don't") + ' have an emergency contact yet' : 'Please add an emergency contact';
    var tag = inline ? 'div' : 'a';
    return '<' + tag + ' class="lf-prompt"' + (inline ? '' : ' href="' + esc(href) + '"') + ' role="' + (inline ? 'note' : 'link') + '">' + I.phone +
      '<div><div class="lf-prompt-t">' + esc(t) + '</div>' +
      '<div class="lf-prompt-s">We need at least one person we can ring if we can’t reach you. It only takes a minute.</div>' +
      (inline ? '' : '<span class="lf-prompt-go">Add an emergency contact →</span>') + '</div></' + tag + '>';
  }
  function prompt(el) {
    if (!el) return;
    injectCss();
    get('/prompt').then(function (d) {
      if (d && d._ok && d.needs_emergency) el.innerHTML = promptCard(d.children || [], d.href || '/welcome/details#family', false);
      else el.innerHTML = '';
    }).catch(function () { el.innerHTML = ''; });
  }

  // ── the three sections ──────────────────────────────────────────────────────
  var S = null, host = null;

  function relSelect(name, value, choices, disabled) {
    return '<select name="' + name + '"' + (disabled ? ' disabled' : '') + '>' +
      choices.map(function (c) { return '<option value="' + esc(c.value) + '"' + (c.value === value ? ' selected' : '') + '>' + esc(c.label) + '</option>'; }).join('') + '</select>';
  }
  function fld(label, inner, cls) { return '<div class="lf-f' + (cls ? ' ' + cls : '') + '"><label>' + label + '</label>' + inner + '</div>'; }

  function parentCard(g, slot, p, choices) {
    var key = 'p' + slot, title = 'Parent / carer ' + slot;
    var optional = slot === 2;
    var head = '<h3>' + I.person + title + (optional ? ' <span style="font-weight:600;font-size:.82rem;color:var(--text-m,#5a5a5a)">· optional</span>' : '') + '</h3>';
    var sub = optional
      ? '<p class="lf-sub">Only if there is another parent or carer we should have on file. Leave this blank if not.</p>'
      : '<p class="lf-sub">The main person we contact and send invoices to.</p>';
    if (p && !p.editable) {
      return '<div class="lf-card" data-card="' + key + '">' + head +
        '<div class="lf-ro"><b>' + esc(p.name) + '</b>' + (p.phone ? '<br>' + esc(p.phone) : '') + (p.email ? '<br>' + esc(p.email) : '') + '</div>' +
        '<div class="lf-note">' + I.info + '<div>These details are shared with another family, so the office changes them for you.</div></div></div>';
    }
    var v = p || { name: '', email: '', phone: '', relationship: optional ? 'other' : 'mother', signin: false, is_you: false };
    var rel = relSelect(key + '-rel', v.relationship, choices, false);
    return '<div class="lf-card" data-card="' + key + '">' + head + sub +
      '<div class="lf-grid two">' +
        fld('Name', '<input type="text" name="' + key + '-name" autocomplete="' + (v.is_you ? 'name' : 'off') + '" maxlength="200" value="' + esc(v.name) + '">') +
        fld('Relationship', rel) +
        fld('Email', '<input type="email" name="' + key + '-email" inputmode="email" autocomplete="off" maxlength="320" value="' + esc(v.email) + '" data-orig="' + esc(v.email) + '" data-signin="' + (v.signin ? '1' : '') + '">') +
        fld('Phone', '<input type="tel" name="' + key + '-phone" inputmode="tel" autocomplete="off" maxlength="40" value="' + esc(v.phone) + '">') +
      '</div><div class="lf-emailnote" data-for="' + key + '"></div><div class="lf-err" data-err="' + key + '" role="alert" hidden></div></div>';
  }

  function ecRow(g, e, i) {
    var collect = '';
    if (e.editable === false) {
      return '<div class="lf-ec" data-ec data-id="' + esc(e.id) + '" data-ro="1"><div class="lf-ro"><b>' + esc(e.name) + '</b> · ' + esc(e.relationship) + '<br>' + esc(e.phone) + '</div>' +
        '<div class="lf-note">' + I.info + '<div>This contact is shared with another family, so the office changes it for you.</div></div></div>';
    }
    if (e.collect === 'approved') {
      collect = '<div class="lf-hint" style="margin-top:10px"><span class="lf-pill ok">Approved to collect</span><br>To change who can collect, please call the office.</div>';
    } else {
      var checked = e.collect === 'proposed' ? ' checked' : '';
      collect = '<label class="lf-chk"><input type="checkbox" name="collect"' + checked + '><span>Can collect ' + esc(names(g.children)) + ' from nursery</span></label>' +
        (e.collect === 'proposed' ? '<div><span class="lf-pill wait">Waiting for the nursery to confirm</span></div>' : '') +
        (e.collect === 'declined' ? '<div class="lf-hint" style="color:var(--lf-err);font-weight:700">The nursery hasn’t been able to approve this. Please call the office.</div>' : '') +
        '<div class="lf-hint">Ticking this asks the nursery. Nobody can collect until the office has confirmed it.</div>';
    }
    return '<div class="lf-ec" data-ec data-id="' + esc(e.id == null ? '' : e.id) + '">' +
      '<div class="lf-ec-top"><span class="lf-ec-n">Contact ' + (i + 1) + '</span>' +
        '<button type="button" class="lf-btn quiet small" data-act="rm" aria-label="Remove emergency contact ' + (i + 1) + '">' + I.trash + 'Remove</button></div>' +
      '<div class="lf-grid two">' +
        fld('Name', '<input type="text" name="ec-name" maxlength="200" autocomplete="off" value="' + esc(e.name) + '">') +
        fld('Relationship to ' + esc(names(g.children)), '<input type="text" name="ec-rel" list="lf-rels" maxlength="60" autocomplete="off" value="' + esc(e.relationship) + '">') +
        fld('Phone', '<input type="tel" name="ec-phone" inputmode="tel" maxlength="40" autocomplete="off" value="' + esc(e.phone) + '">') +
      '</div>' + collect + '<div class="lf-err" data-err="ec" role="alert" hidden></div></div>';
  }

  function groupForm(g, gi, choices, needs) {
    var heading = S.groups.length > 1 ? '<h2 class="lf-h">' + esc(names(g.children)) + '</h2>' : '';
    var others = g.others && g.others.length
      ? '<p class="lf-others">Also on file: ' + g.others.map(function (o) { return esc(o.name || 'Someone') + (o.relationship ? ' (' + esc(o.relationship) + ')' : ''); }).join(', ') +
        '. To change these, please ask the office.</p>' : '';
    return '<form class="lf-group" data-gi="' + gi + '" novalidate>' + heading +
      (needs ? promptCard(g.children, '', true) : '') +
      parentCard(g, 1, g.parent1, choices) +
      parentCard(g, 2, g.parent2, choices) +
      '<div class="lf-card" data-card="ec"><h3>' + I.phone + 'Emergency contacts</h3>' +
        '<p class="lf-sub">Someone other than you and the other parent / carer, who we can ring if we can’t reach you. We need at least one.</p>' +
        '<div data-ec-list>' + (g.emergency.length ? g.emergency : [{ id: null, name: '', relationship: '', phone: '', collect: 'none', editable: true, legacy: false }])
          .map(function (e, i) { return ecRow(g, e, i); }).join('') + '</div>' +
        '<div class="lf-err" data-err="emergency" role="alert" hidden></div>' +
        '<div style="margin-top:12px"><button type="button" class="lf-btn quiet small" data-act="add"' + (g.emergency.length >= g.max_emergency ? ' disabled' : '') + '>' + I.plus + 'Add another contact</button></div>' +
        others + '</div>' +
      '<button type="submit" class="lf-btn wide" data-save>Save these details</button>' +
      '<div class="lf-result" data-result aria-live="polite"></div>' +
    '</form>';
  }

  function pendingCard() {
    if (!S.pending || !S.pending.length) return '';
    return S.pending.map(function (p) {
      return '<div class="lf-card"><h3>' + I.key + 'Signing in with a new address</h3>' +
        '<div class="lf-note ok">' + I.info + '<div>You asked to sign in with <strong>' + esc(p.to) + '</strong>. Until you’ve signed in with it once, <strong>' + esc(p.from) + '</strong> keeps working. ' +
        'After that, the old address stops working. To finish, sign out of the app and sign back in with the new address.</div></div></div>';
    }).join('');
  }

  function render() {
    if (!host || !S) return;
    injectCss();
    var needAny = S.groups.map(function (g) { return g.emergency.length === 0; });
    host.innerHTML = '<div class="lf" id="family-body">' + pendingCard() +
      S.groups.map(function (g, gi) { return groupForm(g, gi, S.relationship_choices, needAny[gi]); }).join('') +
      '<datalist id="lf-rels"><option value="Grandparent"><option value="Aunt"><option value="Uncle"><option value="Family friend"><option value="Neighbour"><option value="Childminder"></datalist></div>';
    Array.prototype.forEach.call(host.querySelectorAll('.lf-group'), wire);
    if (location.hash === '#family') { try { host.scrollIntoView({ block: 'start' }); } catch (e) { /* older browsers */ } }
  }

  function showErr(form, key, msg) {
    var box = form.querySelector('[data-err="' + key + '"]');
    if (!box) { var any = form.querySelector('[data-err="emergency"]'); box = any; }
    if (box) { box.textContent = msg; box.hidden = false; try { box.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* ok */ } }
  }
  function clearErr(form) {
    Array.prototype.forEach.call(form.querySelectorAll('.lf-err'), function (b) { b.hidden = true; b.textContent = ''; });
    Array.prototype.forEach.call(form.querySelectorAll('.lf-f.bad'), function (b) { b.classList.remove('bad'); });
  }

  function emailNote(input) {
    var slot = input.name.split('-')[0], box = input.closest('form').querySelector('.lf-emailnote[data-for="' + slot + '"]');
    if (!box) return;
    var now = input.value.trim().toLowerCase(), was = (input.getAttribute('data-orig') || '').toLowerCase();
    if (now === was || !now) { box.innerHTML = ''; return; }
    if (input.getAttribute('data-signin')) {
      box.innerHTML = '<div class="lf-note">' + I.info + '<div><strong>This is an address you sign in with.</strong> When you save, we add the new address as a way to sign in. <strong>' + esc(was) +
        '</strong> keeps working until you have signed in with the new one once. After that, the old one stops. Please check it carefully — a mistyped address won’t let you in.</div></div>';
    } else if (!was) {
      box.innerHTML = '<div class="lf-note">' + I.info + '<div>This lets us contact them. It doesn’t give them a login to the app — ask the office if they’d like one.</div></div>';
    } else {
      box.innerHTML = '';
    }
  }

  function readForm(form) {
    var gi = +form.getAttribute('data-gi'), g = S.groups[gi];
    var val = function (n) { var el = form.querySelector('[name="' + n + '"]'); return el ? el.value : ''; };
    var body = { child_ids: g.child_ids };
    [1, 2].forEach(function (slot) {
      var k = 'p' + slot, p = slot === 1 ? g.parent1 : g.parent2;
      if (p && !p.editable) return;                        // read-only: never sent
      body['parent' + slot] = { name: val(k + '-name'), email: val(k + '-email'), phone: val(k + '-phone'), relationship: val(k + '-rel') };
    });
    body.emergency = Array.prototype.map.call(form.querySelectorAll('[data-ec]:not([data-ro])'), function (row) {
      var box = row.querySelector('[name="collect"]');
      var id = row.getAttribute('data-id');
      return {
        id: id === '' ? null : +id,
        name: row.querySelector('[name="ec-name"]').value, relationship: row.querySelector('[name="ec-rel"]').value, phone: row.querySelector('[name="ec-phone"]').value,
        collect: box ? box.checked : false
      };
    });
    // read-only (shared) contacts are not sent, so the server would treat them as removed — keep them by sending nothing
    // when there are none of ours to send AND some are shared.
    if (form.querySelector('[data-ec][data-ro]') && !body.emergency.length) delete body.emergency;
    return body;
  }

  function markField(form, field) {
    if (!field) return;
    var m = /^emergency\.(\d+)$/.exec(field);
    if (m) { var row = form.querySelectorAll('[data-ec]')[+m[1]]; if (row) { var f = row.querySelector('.lf-f'); if (f) f.classList.add('bad'); var er = row.querySelector('[data-err="ec"]'); return er; } }
  }

  function wire(form) {
    Array.prototype.forEach.call(form.querySelectorAll('input[type=email]'), function (inp) {
      inp.addEventListener('input', function () { emailNote(inp); });
    });
    form.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]'); if (!b) return;
      var list = form.querySelector('[data-ec-list]'), rows = list.querySelectorAll('[data-ec]');
      var g = S.groups[+form.getAttribute('data-gi')];
      if (b.getAttribute('data-act') === 'add') {
        if (rows.length >= g.max_emergency) return;
        var tmp = document.createElement('div');
        tmp.innerHTML = ecRow(g, { id: null, name: '', relationship: '', phone: '', collect: 'none', editable: true, legacy: false }, rows.length);
        var row = tmp.firstChild; list.appendChild(row); renumber(form);
        var first = row.querySelector('input'); if (first) first.focus();
      } else if (b.getAttribute('data-act') === 'rm') {
        if (rows.length <= 1) { showErr(form, 'emergency', 'Please keep at least one emergency contact. To swap someone, change their details instead.'); return; }
        b.closest('[data-ec]').remove(); renumber(form);
        clearErr(form);
      }
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault(); save(form);
    });
  }
  function renumber(form) {
    var g = S.groups[+form.getAttribute('data-gi')];
    Array.prototype.forEach.call(form.querySelectorAll('[data-ec]'), function (row, i) {
      var n = row.querySelector('.lf-ec-n'); if (n) n.textContent = 'Contact ' + (i + 1);
    });
    var add = form.querySelector('[data-act="add"]'); if (add) add.disabled = form.querySelectorAll('[data-ec]').length >= g.max_emergency;
  }

  function save(form) {
    clearErr(form);
    var btn = form.querySelector('[data-save]'), result = form.querySelector('[data-result]');
    var body = readForm(form);
    btn.disabled = true; result.innerHTML = '';
    post('/save', body).then(function (r) {
      if (r._ok && r.ok) {
        S = r.state; var gi = +form.getAttribute('data-gi');
        render();
        var f2 = host.querySelectorAll('.lf-group')[gi] || host.querySelector('.lf-group');
        var out = f2 && f2.querySelector('[data-result]');
        if (out) out.innerHTML = savedNote(r);
        toast('Saved');
        // the home-screen prompt may have just become stale
        Array.prototype.forEach.call(document.querySelectorAll('[data-family-prompt]'), function (el) { prompt(el); });
        return;
      }
      var msg = r.error || 'We couldn’t save that. Please try again.';
      if (r.reason === 'stale') { msg = 'Your details changed since this page loaded. Reloading…'; setTimeout(function () { load(); }, 900); }
      var key = r.field ? (/^emergency\./.test(r.field) ? 'emergency' : r.field) : 'emergency';
      var box = form.querySelector('[data-err="' + key + '"]') || form.querySelector('[data-err="emergency"]');
      if (/^emergency\.\d+$/.test(r.field || '')) { var rb = markField(form, r.field); if (rb) box = rb; }
      if (box) { box.textContent = msg; box.hidden = false; try { box.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* ok */ } }
      toast(msg, true);
    }).catch(function () {
      toast('Couldn’t save — please check your connection and try again', true);
    }).then(function () { btn.disabled = false; });
  }

  function savedNote(r) {
    var bits = ['<div class="lf-saved">' + I.check + ' Saved just now.</div>'];
    var n = r.notes || {};
    ['p1', 'p2'].forEach(function (k) {
      var x = n[k]; if (!x) return;
      if (x.kind === 'signin_switch') bits.push('<div class="lf-note ok">' + I.info + '<div>We’ve added <strong>' + esc(x.to) + '</strong> as a way to sign in. <strong>' + esc(x.from) + '</strong> keeps working until you’ve signed in with the new address once.</div></div>');
      if (x.kind === 'new_address') bits.push('<div class="lf-note ok">' + I.info + '<div>We’ve saved <strong>' + esc(x.to) + '</strong> as a contact address. It doesn’t give them a login — ask the office if they’d like one.</div></div>');
    });
    if (r.proposed) bits.push('<div class="lf-note ok">' + I.info + '<div>We’ve asked the nursery to confirm who can collect. Nobody can collect until they have.</div></div>');
    return bits.join('');
  }

  function load() {
    if (!host) return;
    host.innerHTML = '<div class="lf"><div class="lf-card"><p class="lf-sub" style="margin:0">Loading your family’s details…</p></div></div>';
    get('/state').then(function (d) {
      if (!d._ok || !d.groups) { host.innerHTML = d._status === 503 ? '' : '<div class="lf"><div class="lf-card"><p class="lf-sub" style="margin:0">We couldn’t load your family’s details just now. Please try again in a moment.</p></div></div>'; return; }
      if (!d.groups.length) { host.innerHTML = ''; return; }
      S = d; render();
    }).catch(function () { host.innerHTML = ''; });
  }

  function mount(el) { host = el; injectCss(); load(); }

  window.LapFamily = { mount: mount, prompt: prompt };
  document.addEventListener('DOMContentLoaded', function () {
    Array.prototype.forEach.call(document.querySelectorAll('[data-family-prompt]'), prompt);
  });
})();
