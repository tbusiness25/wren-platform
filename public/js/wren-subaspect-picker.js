/* Wren — sub-aspect tick list (b211, 2026-08-21)
 * ----------------------------------------------------------------------------
 * "Tick the bits you want covered, see only those" — the shared control behind
 * the EY planning card picker, the Roost card library and the termly-plan
 * learning-intentions picker, so all three feel like one thing.
 *
 *   var picker = WrenSubAspectPicker.create({
 *     mount:  document.getElementById('...'),      // required, emptied on create
 *     groups: WrenRCFilters.aspectGroups(index),   // [{area,label,aspects:[{aspect,label,count}]}]
 *     bands:  WrenRCFilters.AGE_BANDS,             // optional; omit to hide the row
 *     placeholder: 'Search titles, intent, key questions…',
 *     onChange: function (state) { ... }           // {q, aspects:[], bands:[]}
 *   });
 *   picker.setGroups(groups);      // re-build the tick list from fresh data
 *   picker.setCount('38 of 284 cards');
 *   picker.state();                // current selection
 *   picker.clear();                // one click back to everything
 *
 * The tick list is ALWAYS built from the data handed in — nothing here knows the
 * names of any aspects. Colours are theme tokens only; no literals, so it reads
 * correctly whatever palette wren-theme.js has written onto :root.
 */
(function (global) {
  'use strict';

  var CSS_ID = 'wren-subaspect-picker-css';
  var CSS = [
    '.wsap{display:flex;flex-direction:column;gap:9px}',
    '.wsap-bar{display:flex;gap:7px;align-items:center;flex-wrap:wrap}',
    '.wsap-q{flex:1;min-width:170px;box-sizing:border-box;border:1px solid var(--c-border);',
      'background:var(--c-surface);color:var(--c-text);padding:9px 11px;border-radius:10px;',
      'font-size:.9rem;font-family:inherit;min-height:44px}',
    '.wsap-grow{flex:1}',
    '.wsap-count{font-size:.76rem;font-weight:600;color:var(--c-muted);white-space:nowrap}',
    '.wsap-clear{border:1px solid var(--c-border);background:var(--c-surface);color:var(--c-text);',
      'border-radius:10px;min-height:44px;padding:0 12px;font-size:.8rem;font-weight:600;',
      'cursor:pointer;font-family:inherit}',
    '.wsap-clear:hover{border-color:var(--c-blue)}',
    '.wsap-clear[disabled]{opacity:.45;cursor:default}',
    '.wsap-toggle{border:1px solid var(--c-border);background:var(--c-surface);color:var(--c-text);',
      'border-radius:10px;min-height:44px;padding:0 12px;font-size:.8rem;font-weight:600;',
      'cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:6px}',
    '.wsap-toggle .n{font-size:.7rem;font-weight:700;color:var(--c-blue)}',
    '.wsap-body{display:flex;flex-direction:column;gap:8px}',
    '.wsap.collapsed .wsap-body{display:none}',
    '.wsap-group{border:1px solid var(--c-border);border-radius:10px;padding:8px 10px;background:var(--c-card)}',
    '.wsap-group-h{font-size:.68rem;text-transform:uppercase;letter-spacing:.5px;font-weight:700;',
      'color:var(--c-muted);margin-bottom:6px}',
    '.wsap-opts{display:flex;flex-wrap:wrap;gap:6px}',
    '.wsap-opt{display:inline-flex;align-items:center;gap:6px;font-size:.78rem;font-weight:500;',
      'color:var(--c-text);border:1px solid var(--c-border);border-radius:999px;padding:7px 11px;',
      'cursor:pointer;margin:0;background:var(--c-surface);min-height:38px;box-sizing:border-box}',
    '.wsap-opt input{width:auto;margin:0;accent-color:var(--c-blue)}',
    '.wsap-opt i{font-style:normal;font-size:.68rem;color:var(--c-muted)}',
    '.wsap-opt:hover{border-color:var(--c-blue)}',
    '.wsap-opt.on{border-color:var(--c-blue);background:var(--c-surface)}',
    '@supports (background:color-mix(in srgb,red 10%,transparent)){',
      '.wsap-opt.on{background:color-mix(in srgb, var(--c-blue) 20%, transparent)}}',
    '.wsap-opt.on i{color:var(--c-text)}',
    '.wsap-bands{display:flex;flex-wrap:wrap;gap:6px}',
    '.wsap-empty{font-size:.78rem;color:var(--c-muted);font-style:italic}',
    // b219 — themes sit OUTSIDE .wsap-body so collapsing the sub-aspect list never
    // hides them: picking a theme is the first move, not an advanced one.
    '.wsap-themes{border:1px solid var(--c-border);border-radius:10px;padding:8px 10px;background:var(--c-card)}',
    // The theme chips are the control staff hit first and they are labels, not
    // buttons, so the app-shell's 40px phone floor never reaches them — set 44 here.
    '.wsap-themes .wsap-opt{font-weight:600;min-height:44px}',
    '.wsap-themes .wsap-opt.on{border-color:var(--c-blue)}',
  ].join('');

  function ensureCSS() {
    if (document.getElementById(CSS_ID)) return;
    var s = document.createElement('style');
    s.id = CSS_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function create(opts) {
    opts = opts || {};
    var mount = opts.mount;
    if (!mount) throw new Error('WrenSubAspectPicker: opts.mount is required');
    ensureCSS();

    var state = { q: '', aspects: [], bands: (opts.selectedBands || []).slice(),
                  themes: (opts.selectedThemes || []).slice() };
    var groups = opts.groups || [];
    var bands = opts.bands || null;
    // b219 — [{key,label,count}] from WrenRCFilters.themeOptions(index). Omit to
    // hide the row entirely, so a host that has no themed data is unchanged.
    var themes = opts.themes || null;
    var themeLabel = opts.themeLabel || 'Theme';
    var collapsed = !!opts.collapsed;

    var wantSearch = opts.search !== false;   // a host page with its own search box passes search:false

    mount.innerHTML =
      '<div class="wsap' + (collapsed ? ' collapsed' : '') + '">' +
        '<div class="wsap-bar">' +
          (wantSearch
            ? '<input class="wsap-q" type="search" placeholder="' + esc(opts.placeholder || 'Search…') + '">'
            : '<span class="wsap-grow"></span>') +
          '<button type="button" class="wsap-toggle">' + esc(opts.tickLabel || 'Sub-aspects') +
            ' <span class="n"></span></button>' +
          '<span class="wsap-count"></span>' +
          '<button type="button" class="wsap-clear" disabled>Clear</button>' +
        '</div>' +
        // b219 — theme and age band are the quick facets and sit OUTSIDE .wsap-body,
        // so the "Sub-aspects" toggle only ever hides the long tick list. On a tablet
        // that is the difference between opening the picker onto cards and opening it
        // onto a screenful of chips. (Only the EY planning picker passes `bands`, so
        // no other host's layout moves.)
        (themes
          ? '<div class="wsap-themes"><div class="wsap-group-h">' + esc(themeLabel) + '</div>' +
              '<div class="wsap-opts wsap-theme-opts"></div></div>'
          : '') +
        (bands ? '<div class="wsap-bands"></div>' : '') +
        '<div class="wsap-body">' +
          '<div class="wsap-groups"></div>' +
        '</div>' +
      '</div>';

    var root    = mount.querySelector('.wsap');
    var elQ     = mount.querySelector('.wsap-q');
    var elCount = mount.querySelector('.wsap-count');
    var elClear = mount.querySelector('.wsap-clear');
    var elTog   = mount.querySelector('.wsap-toggle');
    var elBands = mount.querySelector('.wsap-bands');
    var elGroups= mount.querySelector('.wsap-groups');
    var elThemes= mount.querySelector('.wsap-theme-opts');

    function chip(kind, value, label, count, on) {
      return '<label class="wsap-opt' + (on ? ' on' : '') + '" data-kind="' + kind + '">' +
        '<input type="checkbox" value="' + esc(value) + '"' + (on ? ' checked' : '') + '>' +
        '<span>' + esc(label) + '</span>' +
        (count == null ? '' : '<i>' + count + '</i>') + '</label>';
    }

    function renderBands() {
      if (!elBands) return;
      elBands.innerHTML = bands.map(function (b) {
        return chip('band', b.key, b.short || b.label, null, state.bands.indexOf(b.key) >= 0);
      }).join('');
    }

    function renderThemes() {
      if (!elThemes) return;
      if (!themes.length) {
        elThemes.innerHTML = '<span class="wsap-empty">No themes tagged yet.</span>';
        return;
      }
      elThemes.innerHTML = themes.map(function (t) {
        return chip('theme', t.key, t.label || t.key, t.count, state.themes.indexOf(t.key) >= 0);
      }).join('');
    }

    function renderGroups() {
      if (!groups.length) {
        elGroups.innerHTML = '<div class="wsap-empty">' +
          esc(opts.emptyText || 'Nothing is tagged with sub-aspects yet.') + '</div>';
        return;
      }
      elGroups.innerHTML = groups.map(function (g) {
        return '<div class="wsap-group"><div class="wsap-group-h">' + esc(g.label || g.area) + '</div>' +
          '<div class="wsap-opts">' + g.aspects.map(function (a) {
            return chip('aspect', a.aspect, a.label || a.aspect, a.count,
                        state.aspects.indexOf(a.aspect) >= 0);
          }).join('') + '</div></div>';
      }).join('');
    }

    function syncBar() {
      var n = state.aspects.length;
      elTog.querySelector('.n').textContent = n ? '(' + n + ')' : '';
      var dirty = !!(state.q || n || state.bands.length || state.themes.length);
      elClear.disabled = !dirty;
    }

    function fire() { syncBar(); if (opts.onChange) opts.onChange(api.state()); }

    function toggle(list, value) {
      var i = list.indexOf(value);
      if (i >= 0) list.splice(i, 1); else list.push(value);
    }

    mount.addEventListener('change', function (e) {
      var input = e.target;
      if (!input || input.type !== 'checkbox') return;
      var lbl = input.closest('.wsap-opt');
      if (!lbl) return;
      var kind = lbl.getAttribute('data-kind');
      toggle(kind === 'band' ? state.bands : kind === 'theme' ? state.themes : state.aspects, input.value);
      lbl.classList.toggle('on', input.checked);
      fire();
    });

    var qTimer = null;
    if (elQ) {
      elQ.addEventListener('input', function () {
        clearTimeout(qTimer);
        qTimer = setTimeout(function () { state.q = elQ.value; fire(); }, 120);
      });
    }

    elClear.addEventListener('click', function () { api.clear(); });
    elTog.addEventListener('click', function () { root.classList.toggle('collapsed'); });

    var api = {
      el: root,
      state: function () {
        return { q: state.q, aspects: state.aspects.slice(), bands: state.bands.slice(),
                 themes: state.themes.slice() };
      },
      setGroups: function (g) { groups = g || []; renderGroups(); syncBar(); },
      // b219 — refresh the theme chips (and their counts) from fresh data. Ticks
      // for themes that survive the refresh are kept; ones that vanish are dropped.
      setThemes: function (t) {
        if (!elThemes) return;
        themes = t || [];
        var live = {};
        themes.forEach(function (x) { live[x.key] = 1; });
        state.themes = state.themes.filter(function (k) { return live[k]; });
        renderThemes(); syncBar();
      },
      setQ: function (q) { state.q = q || ''; if (elQ) elQ.value = state.q; syncBar(); },
      setCount: function (text) { elCount.textContent = text || ''; },
      clear: function () {
        state.q = ''; state.aspects = []; state.bands = []; state.themes = [];
        if (elQ) elQ.value = '';
        renderBands(); renderThemes(); renderGroups();
        fire();
      },
      focus: function () { try { if (elQ) elQ.focus(); } catch (e) {} },
    };

    renderBands();
    renderThemes();
    renderGroups();
    syncBar();
    return api;
  }

  global.WrenSubAspectPicker = { create: create };
})(window);
