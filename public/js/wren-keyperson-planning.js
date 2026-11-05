/* wren-keyperson-planning.js — b359 (2026-09-29)
 *
 * "AI planning for my key children": one board, mounted on TWO pages.
 *
 *   /ey/keyperson-planning        a practitioner, their own key children
 *   Roost /keyperson-planning.html a manager, anybody's
 *
 * One file rather than two because the screens are the same screen — Toby's
 * brief says "Managers can run it for any practitioner from Roost", not "and
 * a different tool for managers". The only difference between the two mounts is
 * whether the staff picker starts empty, and that is an option.
 *
 * ── THE ONE DESIGN DECISION WORTH READING ───────────────────────────────────
 * The run is driven ONE CHILD PER REQUEST from here, not by a server-side loop.
 *
 * Twenty children at ~40s of local inference each is thirteen minutes. A single
 * POST would be dead long before that behind nginx, Cloudflare and the browser,
 * and a background job would leave this page animating a progress bar it cannot
 * actually see. So: POST /runs creates the run and returns the full list
 * immediately, and this file then calls POST /runs/:id/step in series. Each
 * response IS the current state of the whole run, so the board is never
 * guessing, a timeout costs exactly one child, and closing the tab stops the run
 * rather than orphaning it.
 *
 * Series, not parallel, and deliberately: the Ascent answers one request at a
 * time anyway, and firing twenty at once turns a slow run into a failed one.
 */
(function (global) {
  'use strict';

  var API = '/api/termly-drafts';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function errText(e) {
    // Wren.api rejects with the BODY, so e.message is undefined — see
    // memory/reference_wren_api_rejects_with_body.md.
    if (!e) return 'Something went wrong.';
    return e.error || e.detail || e.message || (typeof e === 'string' ? e : 'Something went wrong.');
  }
  function plural(n, one, many) { return Number(n) === 1 ? one : (many || one + 's'); }

  function KeyPersonPlanning(el, opts) {
    this.el = el;
    this.opts = opts || {};
    this.ctx = null;
    this.run = null;
    this.staffId = this.opts.staffId || null;
    this.selected = null;      // null = all draftable
    this.busy = false;
    this.stopRequested = false;
  }

  KeyPersonPlanning.prototype.url = function (path) {
    var u = API + path;
    if (this.staffId) u += (u.indexOf('?') === -1 ? '?' : '&') + 'staff_id=' + encodeURIComponent(this.staffId);
    return u;
  };

  // ── Load ──────────────────────────────────────────────────────────────────
  KeyPersonPlanning.prototype.load = function () {
    var self = this;
    self.el.innerHTML = '<div class="kp-loading">Loading your key children…</div>';
    return Wren.api(self.url('/context')).then(function (c) {
      self.ctx = c;
      if (!self.staffId && c.key_person && c.key_person.id) self.staffId = null; // stay implicit for "me"
      self.render();
      return c;
    }).catch(function (e) {
      self.el.innerHTML = '<div class="kp-error">Could not load: ' + esc(errText(e)) + '</div>';
    });
  };

  // ── Render ────────────────────────────────────────────────────────────────
  KeyPersonPlanning.prototype.render = function () {
    var c = this.ctx;
    if (!c) return;
    var h = [];

    // Staff picker — managers only. It is the whole of "run it for any
    // practitioner", so it is first, not buried in a settings drawer.
    if (c.can_run_for_others) {
      h.push('<div class="kp-row kp-staffpick">');
      h.push('<label for="kp-staff">Key children of</label>');
      h.push('<select id="kp-staff">');
      h.push('<option value="">' + esc('Me (' + (c.user.id === c.key_person.id ? 'my own' : '#' + c.key_person.id) + ')') + '</option>');
      (c.staff || []).forEach(function (s) {
        h.push('<option value="' + s.id + '"' + (String(s.id) === String(this.staffId) ? ' selected' : '') + '>' +
               esc(s.name) + ' — ' + s.key_children + ' key ' + plural(s.key_children, 'child', 'children') + '</option>');
      }, this);
      h.push('</select></div>');
    }

    // The honest state of the model, before anyone presses anything.
    if (!c.model.reachable) {
      h.push('<div class="kp-banner kp-bad">' +
        '<strong>The local model is not answering.</strong> ' +
        'Wren asked <code>' + esc(c.model.host) + '</code> for <code>' + esc(c.model.name) + '</code> and got no useful reply' +
        (c.model.error ? ' (' + esc(c.model.error) + ')' : '') + '. ' +
        'Nothing can be drafted until it is back. Nothing has been saved and nothing is half-written — ' +
        'your key children\'s records are untouched.</div>');
    }
    if (c.calendar_problem) {
      h.push('<div class="kp-banner kp-bad">' + esc(c.calendar_problem) + '</div>');
    } else if (c.cycle) {
      h.push('<div class="kp-banner kp-info">Drafting <strong>' + esc(c.cycle.label) + '</strong>' +
             (c.cycle.due_on ? ' — due ' + esc(c.cycle.due_on) : '') +
             '. Every draft goes to the review screen. Nothing reaches a family until you send it.</div>');
    }

    /* The button, ABOVE the list and sticky.
     * It was below the list to begin with, where the EY bottom nav sits on top of
     * it — and worse, during a twenty-child run you would have had to scroll past
     * twenty rows to see how far it had got. The thing you press and the thing
     * that tells you it is working belong where you can always see them. */
    var canRun = c.model.reachable && c.cycle && (c.children || []).some(function (k) { return k.draftable; });
    h.push('<div class="kp-actions">');
    if (this.busy) {
      h.push('<button class="kp-btn" id="kp-stop" type="button">Stop after this child</button>');
      h.push('<span class="kp-progress">' + this.progressText() + '</span>');
    } else {
      h.push('<button class="kp-btn primary" id="kp-run" type="button"' + (canRun ? '' : ' disabled') + '>' +
             (this.run ? 'Draft again' : 'Draft a termly update for each of them') + '</button>');
      if (!canRun && c.model.reachable && c.cycle) {
        h.push('<span class="kp-hint">There is nothing on record yet for any of them.</span>');
      }
    }
    h.push('</div>');

    if (this.run && this.run.degraded_reason) {
      h.push('<div class="kp-banner kp-warn">' + esc(this.run.degraded_reason) + '</div>');
    }

    // The children.
    var kids = c.children || [];
    if (!kids.length) {
      h.push('<div class="kp-empty">No active key children' + (c.can_run_for_others ? ' for this member of staff' : '') + '.</div>');
    } else {
      var draftable = kids.filter(function (k) { return k.draftable; });
      h.push('<div class="kp-summary">' + kids.length + ' key ' + plural(kids.length, 'child', 'children') +
             ' · ' + draftable.length + ' with records to draft from</div>');
      h.push('<div class="kp-list">');
      kids.forEach(function (k) {
        var item = this.itemFor(k.id);
        h.push(this.childRow(k, item));
      }, this);
      h.push('</div>');
    }

    // Recent runs — the way back to a run you started yesterday.
    if (!this.run && (c.recent_runs || []).length) {
      h.push('<div class="kp-recent"><span>Earlier runs:</span> ');
      c.recent_runs.slice(0, 5).forEach(function (r) {
        h.push('<button class="kp-link" data-run="' + r.id + '" type="button">' +
               esc(r.cycle_label || r.cycle_key) + ' — ' + r.drafted + '/' + r.child_total +
               (Number(r.failed) ? ' (' + r.failed + ' failed)' : '') + '</button> ');
      });
      h.push('</div>');
    }

    this.el.innerHTML = h.join('');
    this.wire();
  };

  KeyPersonPlanning.prototype.itemFor = function (childId) {
    if (!this.run) return null;
    for (var i = 0; i < this.run.items.length; i++) {
      if (Number(this.run.items[i].child_id) === Number(childId)) return this.run.items[i];
    }
    return null;
  };

  KeyPersonPlanning.prototype.childRow = function (k, item) {
    var h = ['<div class="kp-child kp-' + (item ? item.status : 'idle') + '">'];
    h.push('<div class="kp-child-head">');
    h.push('<span class="kp-child-name">' + esc(k.name) + '</span>');
    if (k.room) h.push('<span class="kp-child-room">' + esc(k.room) + '</span>');
    h.push('<span class="kp-child-state">' + this.stateLabel(k, item) + '</span>');
    h.push('</div>');

    h.push('<div class="kp-child-counts">' +
      k.observations + ' ' + plural(k.observations, 'observation') + ' · ' +
      k.next_steps_open + ' open next ' + plural(k.next_steps_open, 'step') + ' · ' +
      k.previous_updates + ' previous ' + plural(k.previous_updates, 'update') +
      '</div>');

    if (item && item.error) {
      h.push('<div class="kp-child-error">' + esc(item.error) + '</div>');
    }

    if (item && item.status === 'drafted') {
      var s = item.suggestions || {};
      var picks = (s.nursery || []).concat(s.home || []);
      if (picks.length) {
        h.push('<div class="kp-sugg">');
        (s.nursery || []).forEach(function (p) {
          h.push('<a class="kp-chip kp-chip-nursery" href="' + esc(p.href) + '" title="' + esc(p.why || '') + '">' +
                 (p.kind === 'card' ? '🗂️ ' : '🎨 ') + esc(p.title) + '</a>');
        });
        (s.home || []).forEach(function (p) {
          h.push('<a class="kp-chip kp-chip-home" href="' + esc(p.href) + '" title="' + esc(p.why || '') + '">' +
                 '🏠 ' + esc(p.title) + '</a>');
        });
        h.push('</div>');
      } else if (s.unavailable) {
        h.push('<div class="kp-child-note">No suggestions: ' + esc(s.unavailable) + '</div>');
      }
      if (item.review_link) {
        h.push('<div class="kp-child-actions">' +
               '<a class="kp-btn" href="' + esc(item.review_link) + '">Read and edit the draft</a>' +
               (item.observation_count != null
                 ? '<span class="kp-hint">read ' + item.observation_count + ' ' +
                   plural(item.observation_count, 'observation') +
                   (item.previous_update_count ? ' and ' + item.previous_update_count + ' previous ' +
                     plural(item.previous_update_count, 'update') : '') + '</span>'
                 : '') +
               '</div>');
      }
    } else if (!item && k.this_cycle_report_id) {
      h.push('<div class="kp-child-actions"><a class="kp-btn" href="/ey/termly-update?id=' +
             k.this_cycle_report_id + '">This cycle\'s update already exists — open it</a></div>');
    }
    h.push('</div>');
    return h.join('');
  };

  KeyPersonPlanning.prototype.stateLabel = function (k, item) {
    if (item) {
      if (item.status === 'drafted') return '<span class="kp-tag ok">Drafted</span>';
      if (item.status === 'running') return '<span class="kp-tag busy">Writing…</span>';
      if (item.status === 'failed')  return '<span class="kp-tag bad">Failed</span>';
      if (item.status === 'skipped') return '<span class="kp-tag warn">Left alone</span>';
      return '<span class="kp-tag">Waiting</span>';
    }
    if (k.this_cycle_status) {
      // b246's own status values are database words. A practitioner reads the
      // board, not the schema.
      var LABEL = {
        drafting: 'Being written',
        awaiting_review: 'Draft waiting for you',
        sent: 'Already sent',
        approved: 'Approved',
      };
      return '<span class="kp-tag warn">' + esc(LABEL[k.this_cycle_status] || k.this_cycle_status) + '</span>';
    }
    if (!k.draftable) return '<span class="kp-tag">Nothing on record yet</span>';
    return '';
  };

  KeyPersonPlanning.prototype.progressText = function () {
    if (!this.run) return 'Starting…';
    var c = this.run.counts || {};
    var done = (c.drafted || 0) + (c.failed || 0) + (c.skipped || 0);
    return done + ' of ' + this.run.child_total + ' done';
  };

  // ── Wiring ────────────────────────────────────────────────────────────────
  KeyPersonPlanning.prototype.wire = function () {
    var self = this;
    var sel = document.getElementById('kp-staff');
    if (sel) sel.addEventListener('change', function () {
      self.staffId = this.value || null;
      self.run = null;
      self.load();
    });
    var run = document.getElementById('kp-run');
    if (run) run.addEventListener('click', function () { self.start(); });
    var stop = document.getElementById('kp-stop');
    if (stop) stop.addEventListener('click', function () {
      self.stopRequested = true;
      this.disabled = true;
      this.textContent = 'Stopping after this child…';
    });
    Array.prototype.forEach.call(self.el.querySelectorAll('[data-run]'), function (b) {
      b.addEventListener('click', function () {
        Wren.api(API + '/runs/' + this.getAttribute('data-run')).then(function (r) {
          self.run = r; self.render();
        }).catch(function (e) { Wren.toast && Wren.toast(errText(e)); });
      });
    });
  };

  // ── The run ───────────────────────────────────────────────────────────────
  KeyPersonPlanning.prototype.start = function () {
    var self = this;
    if (self.busy) return;
    self.busy = true;
    self.stopRequested = false;
    self.render();

    var body = {};
    if (self.staffId) body.staff_id = Number(self.staffId);
    Wren.api(API + '/runs', { method: 'POST', body: body }).then(function (run) {
      self.run = run;
      self.render();
      return self.step();
    }).catch(function (e) {
      self.busy = false;
      self.run = null;
      self.render();
      self.el.insertAdjacentHTML('afterbegin',
        '<div class="kp-banner kp-bad">Could not start: ' + esc(errText(e)) + '</div>');
    });
  };

  /** One child, then the next, until there are none left or someone says stop. */
  KeyPersonPlanning.prototype.step = function () {
    var self = this;
    if (!self.run || self.stopRequested) { self.busy = false; self.render(); return Promise.resolve(); }
    return Wren.api(API + '/runs/' + self.run.id + '/step', { method: 'POST', body: {} })
      .then(function (out) {
        self.run = out;
        self.render();
        if (out.done || !out.pending) { self.busy = false; self.render(); return; }
        return self.step();
      })
      .catch(function (e) {
        // A step that failed at the HTTP level (a timeout, a dropped connection)
        // is NOT a failed run: the server records per-child failure itself. Re-read
        // the run and carry on, once — twice in a row means stop and say so.
        if (self._retried) {
          self.busy = false;
          self.render();
          self.el.insertAdjacentHTML('afterbegin',
            '<div class="kp-banner kp-bad">The run stopped: ' + esc(errText(e)) +
            '. Anything already drafted is safe — press Draft again to carry on where it stopped.</div>');
          return;
        }
        self._retried = true;
        return Wren.api(API + '/runs/' + self.run.id).then(function (r) {
          self.run = r; self._retried = false; self.render();
          if (r.pending && !self.stopRequested) return self.step();
          self.busy = false; self.render();
        }).catch(function () {
          self.busy = false; self.render();
        });
      });
  };

  global.WrenKeyPersonPlanning = {
    mount: function (el, opts) {
      var node = typeof el === 'string' ? document.getElementById(el) : el;
      if (!node) return null;
      var kp = new KeyPersonPlanning(node, opts);
      kp.load();
      return kp;
    },
  };
})(window);
