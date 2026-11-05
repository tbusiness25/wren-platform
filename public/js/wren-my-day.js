/* wren-my-day.js — b358 (2026-09-29)
 *
 * "My day", rendered. The first thing a practitioner sees after they log in.
 *
 * Sits ABOVE b286's morning board on /ey/my-morning and is deliberately a
 * separate file from wren-morning-board.js: the board is shared with Roost and
 * must not change shape because the EY landing page gained blocks.
 *
 * ── RULES THIS FILE ENFORCES ────────────────────────────────────────────────
 * 1. A block with count === null is NEVER drawn as a number. It draws the words
 *    "not counted" and the reason. A false zero reads as "done" and is the one
 *    failure mode that matters on a page somebody glances at for four seconds.
 * 2. An EMPTY block hides itself. "0 messages from parents" is noise on a
 *    morning board; the absence of the block is the answer. The exception is a
 *    block flagged always_show (the meeting question), where "no" is the useful
 *    half of a yes/no.
 * 3. A block that could not be READ never hides — hiding it would be the same
 *    lie as showing 0. It stays on the page saying so.
 * 4. All network calls go through Wren.api(), never a bare fetch() with a
 *    hand-rolled Authorization header — b280 found five call sites that 403
 *    silently under device enforcement and there is not going to be a sixth.
 */
;(function () {
  'use strict';

  var W = window;
  var STATE = { root: null, data: null, open: {}, loading: false };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Said in words on every row, so the page needs no colour key to be readable
  // — and so it still reads correctly in a high-contrast or monochrome setting.
  var STATE_WORDS = {
    overdue: 'overdue', due: 'to do', upcoming: 'later',
    in: 'in', ok: 'on track', info: '', mine: 'yours', unknown: 'unknown',
  };

  function greeting() {
    var h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }

  function blockCount(b) {
    if (b.count === null || b.count === undefined) {
      return '<span class="md-n md-n-unknown" aria-label="not counted">—</span>';
    }
    // A badge on this page means "this many things need you", so zero of them is
    // a tick, never a nought. Two blocks reach here with a real 0 and stay
    // visible: "Meeting today?" (always_show — the "no" is the useful half) and
    // tracking when every child is on track. Drawing "0" there is the same false
    // signal as a false zero, and it is what rule 1 exists to stop; the status
    // line and note underneath still say it in words.
    if (!b.count) {
      return '<span class="md-n md-n-clear" aria-label="nothing outstanding">✓</span>';
    }
    return '<span class="md-n md-n-open">' + b.count + '</span>';
  }

  function blockStatusLine(b) {
    if (b.state === 'not_tracked') return 'Not counted';
    if (b.state === 'error')       return 'Could not be read';
    if (b.state === 'none')        return 'Nothing expected';
    if (!b.items || !b.items.length) return 'Nothing today';
    // Say the SAME number the badge says. These two can differ — the tracking
    // block counts the children who are behind but lists all of them, so reading
    // items.length here drew "7" beside the words "10 things". A card whose own
    // two numbers disagree is the thing this page is built not to do; the note
    // underneath still gives the "7 of 10" detail.
    var n = (typeof b.count === 'number') ? b.count : b.items.length;
    if (!n) return 'Nothing outstanding';
    return n + (n === 1 ? ' thing' : ' things');
  }

  function renderItems(b) {
    if (!b.items || !b.items.length) return '';
    return '<ul class="md-items" role="list">' + b.items.map(function (i) {
      var word = STATE_WORDS[i.state] || '';
      var inner =
        '<span class="md-i-main">' + esc(i.label) + '</span>'
        + (i.sub ? '<span class="md-i-sub">' + esc(i.sub) + '</span>' : '')
        + (word ? '<span class="md-i-state md-s-' + esc(i.state) + '">' + esc(word) + '</span>' : '');
      return '<li>' + (i.href
        ? '<a class="md-i" href="' + esc(i.href) + '">' + inner + '<span class="md-i-go" aria-hidden="true">›</span></a>'
        : '<span class="md-i md-i-flat">' + inner + '</span>') + '</li>';
    }).join('') + '</ul>';
  }

  function renderBlock(b) {
    var open = !!STATE.open[b.key];
    var canOpen = !!(b.items && b.items.length);
    var cls = ['md-block', 'md-st-' + b.state, open ? 'is-open' : ''].join(' ');
    return ''
      + '<section class="' + cls + '" data-block="' + esc(b.key) + '">'
      +   '<button class="md-block-head" type="button" data-toggle="' + esc(b.key) + '"'
      +     (canOpen ? ' aria-expanded="' + (open ? 'true' : 'false') + '"' : ' disabled')
      +   '>'
      +     blockCount(b)
      +     '<span class="md-block-text">'
      +       '<span class="md-block-title">' + esc(b.label) + '</span>'
      +       '<span class="md-block-status">' + esc(blockStatusLine(b)) + '</span>'
      +     '</span>'
      +     (canOpen ? '<span class="md-chev" aria-hidden="true">›</span>' : '')
      +   '</button>'
      +   (b.note ? '<p class="md-note">' + esc(b.note) + '</p>' : '')
      +   (open ? renderItems(b) : '')
      +   (b.definition
          ? '<details class="md-def"><summary>How is this counted?</summary><p>'
            + esc(b.definition) + '</p></details>'
          : '')
      + '</section>';
  }

  /**
   * Rule 2 and rule 3 together: hide a block that genuinely has nothing, keep
   * one that could not be read. `always_show` is the yes/no exception.
   */
  function visible(b) {
    if (b.state === 'not_tracked' || b.state === 'error') return true;
    if (b.always_show) return true;
    return !!(b.items && b.items.length);
  }

  function render() {
    var d = STATE.data, el = STATE.root;
    if (!el) return;
    if (STATE.loading && !d) { el.innerHTML = '<p class="md-loading">Getting your day together…</p>'; return; }
    if (!d) { el.innerHTML = '<p class="md-loading">Nothing loaded.</p>'; return; }

    var shown = (d.blocks || []).filter(visible);
    var unknown = (d.blocks || []).filter(function (b) { return b.count === null; });

    var head = ''
      + '<div class="md-head">'
      +   '<div class="md-greet">'
      +     '<h1>' + greeting() + '</h1>'
      +     '<p>' + (d.key_children
              ? 'Your day at a glance — ' + d.key_children + ' key child'
                + (d.key_children === 1 ? '' : 'ren') + '. Everything here is yours alone.'
              : 'Your day at a glance. No children are assigned to you as key person yet.')
      +     '</p>'
      +   '</div>'
      // The one obvious way off this page, as the brief asks. The Children tab
      // in the shell still goes to the same place — this is an addition, not a
      // replacement for it.
      +   '<a class="md-children-btn" href="/ey/home">Go to children <span aria-hidden="true">→</span></a>'
      +   kitchenButtonHTML()
      + '</div>';

    var body;
    if (!shown.length) {
      body = '<p class="md-clear">Nothing needs you right now.'
           + '<span>Blocks appear here only when they have something in them, so an empty page means '
           + 'an empty list — not a page that failed to load.</span></p>';
    } else {
      body = '<div class="md-grid">' + shown.map(renderBlock).join('') + '</div>';
    }

    var warn = '';
    if (unknown.length) {
      warn += '<p class="md-warn">' + unknown.length + ' block'
            + (unknown.length === 1 ? ' is' : 's are') + ' not being counted — shown as “—”, never as zero. '
            + 'Nothing in them is claimed to be done.</p>';
    }
    if (d.board_error) {
      warn += '<p class="md-warn">The morning board could not be read (' + esc(d.board_error)
            + '), so the parent-message and tracking blocks are missing rather than empty.</p>';
    }

    el.innerHTML = head + warn + body;
  }

  function load() {
    STATE.loading = true;
    render();
    return W.Wren.api('/api/my-morning/day').then(function (d) {
      STATE.loading = false;
      STATE.data = d;
      render();
    }).catch(function (e) {
      STATE.loading = false;
      STATE.root.innerHTML = '<p class="md-warn">Your day could not be loaded: '
        + esc((e && (e.error || e.message)) || 'unknown error')
        + '. Nothing here is being reported as done.</p>';
    });
  }

  function onClick(ev) {
    var dish = ev.target.closest && ev.target.closest('[data-action="change-dish"]');
    if (dish) { return openChangeDishModal(); }
    var tog = ev.target.closest && ev.target.closest('[data-toggle]');
    if (tog && !tog.disabled) {
      var k = tog.getAttribute('data-toggle');
      STATE.open[k] = !STATE.open[k];
      return render();
    }
  }

  // ── Kitchen: "Change today's dish" (b404, 2026-10-06) ───────────────────
  // Toby: swap just today's lunch without touching the week's planned menu —
  // POST /api/menus/today-override writes the one dated menu_plans row that
  // src/lib/menu-rotation.js already treats as the authority over the
  // rotation's placeholder lunch for that day (b330), so the kitchen screen,
  // the parents' menu page and the diary all pick it up immediately.
  //
  // Role is decoded straight off the JWT, NOT Wren.getUser() — more.html's
  // Review Queue gate already found that sessionStorage['wrenUser'] is never
  // populated anywhere on the EY portal, so getUser() would always read null
  // here and hide this for everyone, kitchen staff included. Same fix, same
  // reasoning: decode the token itself, the one thing every EY page actually
  // has.
  var KITCHEN_ROLES = ['cook', 'manager', 'deputy_manager', 'admin'];
  function myRole() {
    try {
      var t = sessionStorage.getItem('wrenToken');
      var p = t && JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return (p && p.role) || null;
    } catch (e) { return null; }
  }

  function kitchenButtonHTML() {
    if (KITCHEN_ROLES.indexOf(myRole()) === -1) return '';
    return '<button type="button" class="md-children-btn md-kitchen-btn" data-action="change-dish">'
         + 'Change today’s dish <span aria-hidden="true">🍽️</span></button>';
  }

  function openChangeDishModal() {
    if (!window.Wren || !Wren.api || !Wren.modal) return;
    var box = document.createElement('div');
    box.innerHTML =
      '<p class="md-dish-intro">This swaps just today’s lunch. The rest of the week’s menu is untouched.</p>'
      + '<label class="md-dish-field"><span>Room</span>'
      +   '<select id="md-dish-room">'
      +     '<option value="preschool">Pre-school</option>'
      +     '<option value="baby">Baby Room</option>'
      +   '</select></label>'
      + '<p class="md-dish-current" id="md-dish-current">Loading today’s plan…</p>'
      + '<label class="md-dish-field"><span>New dish</span>'
      +   '<select id="md-dish-recipe"><option value="">Loading recipes…</option></select></label>';

    function refreshCurrent() {
      var p = box.querySelector('#md-dish-current');
      var room = box.querySelector('#md-dish-room').value;
      p.textContent = 'Loading today’s plan…';
      Wren.api('/api/menus/today?room=' + encodeURIComponent(room)).then(function (d) {
        var lunch = (d.plans || []).filter(function (x) { return x.meal_type === 'lunch'; })[0];
        p.textContent = (lunch && lunch.recipe_name)
          ? ('Currently: ' + lunch.recipe_name)
          : 'Nothing planned for today yet.';
      }).catch(function () { p.textContent = ''; });
    }

    Wren.api('/api/menus/recipes').then(function (recipes) {
      var sel = box.querySelector('#md-dish-recipe');
      sel.innerHTML = '<option value="">Choose a dish…</option>'
        + (recipes || []).map(function (r) {
            return '<option value="' + r.id + '">' + esc(r.name) + '</option>';
          }).join('');
    }).catch(function () {
      box.querySelector('#md-dish-recipe').innerHTML = '<option value="">Could not load recipes</option>';
    });

    box.querySelector('#md-dish-room').addEventListener('change', refreshCurrent);
    refreshCurrent();

    Wren.modal('Change today’s dish', box, [
      { label: 'Cancel' },
      { label: 'Save', class: 'btn-primary', action: function () {
          var recipeId = box.querySelector('#md-dish-recipe').value;
          var room = box.querySelector('#md-dish-room').value;
          if (!recipeId) { Wren.toast('Choose a dish first', 'warning'); return; }
          Wren.api('/api/menus/today-override', {
            method: 'POST',
            body: { recipe_id: Number(recipeId), room: room },
          }).then(function () {
            Wren.toast('Today’s dish updated', 'success');
          }).catch(function (e) {
            Wren.toast((e && e.error) || 'Could not update today’s dish', 'error');
          });
        } },
    ]);
  }

  function mount(opts) {
    opts = opts || {};
    STATE.root = typeof opts.root === 'string' ? document.querySelector(opts.root) : opts.root;
    if (!STATE.root) return;
    STATE.root.addEventListener('click', onClick);
    return load();
  }

  W.WrenMyDay = { mount: mount, _state: STATE };
})();
