/* engine.js — Wren Kids: the shared game engine (b507, 2026-10-18).
 *
 * One engine, eight games. It owns everything that is the same in all of them, so a game file
 * only has to describe its own learning:
 *
 *   Kids.audio     WebAudio sound effects, generated in-browser (no audio files to download), plus
 *                  spoken instructions: a pre-generated clip if one exists, else speechSynthesis,
 *                  else nothing (the instruction is ALWAYS on screen as text too — a muted tablet,
 *                  a deaf child, and Silk with no speechSynthesis all stay playable).
 *   Kids.fx        one canvas particle layer per game frame: confetti, sparkles, pop rings. The
 *                  rAF loop only runs while something is alive, so an idle question costs nothing.
 *   Kids.progress  localStorage, every read and write in try/catch. On the device, never leaves it.
 *   Kids.session   the round loop, adaptive difficulty, the break prompt, and (staff mode only)
 *                  the POST to /api/kids-games/sessions.
 *   Kids.game(def) register a game. Kids.play(slug) start it.
 *
 * NOTHING in here talks to a server unless Kids.staff.on is true (the EY portal, a member of
 * staff having picked a child). At home there are no accounts and no requests: progress is a
 * single localStorage key, and the app works with the network off.
 */
(function (W) {
  'use strict';

  var Kids = W.Kids = W.Kids || {};
  var GAMES = Kids.GAMES = {};
  var ORDER = Kids.ORDER = [];

  /* ══ small helpers ══════════════════════════════════════════════════════════ */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function rint(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function shuffle(arr) {
    var a = arr.slice(), i, j, t;
    for (i = a.length - 1; i > 0; i--) { j = Math.floor(Math.random() * (i + 1)); t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  /* distinct distractors around a target, clamped to a sensible range */
  function near(target, n, lo, hi) {
    var out = [], seen = {}, spread = 1, guard = 0;
    seen[target] = true;
    while (out.length < n && guard++ < 200) {
      var d = rint(1, spread + 2) * (Math.random() < .5 ? -1 : 1);
      var v = target + d;
      if (v >= lo && v <= hi && !seen[v]) { seen[v] = true; out.push(v); }
      if (guard % 12 === 0) spread++;
    }
    while (out.length < n) { var f = lo + out.length; if (!seen[f]) { seen[f] = true; out.push(f); } else lo++; }
    return out;
  }
  Kids.util = { el: el, clear: clear, rint: rint, pick: pick, shuffle: shuffle, near: near };

  /* ══ storage ════════════════════════════════════════════════════════════════ */
  var STORE_KEY = 'wren-kids.v1';
  var _mem = null;   /* in-memory mirror, so a private window with no storage still works */

  function load() {
    if (_mem) return _mem;
    var d = null;
    try { d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { d = null; }
    if (!d || typeof d !== 'object') d = {};
    d.games = d.games || {};
    d.settings = d.settings || {};
    _mem = d;
    return _mem;
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(_mem)); } catch (e) { /* private window, or storage full/blocked */ }
  }
  var progress = Kids.progress = {
    all: function () { return load(); },
    forGame: function (slug) {
      var d = load();
      if (!d.games[slug]) d.games[slug] = { plays: 0, stars: 0, level: 1, correct: 0, asked: 0, seconds: 0, last: null };
      return d.games[slug];
    },
    setting: function (k, v) {
      var d = load();
      if (arguments.length < 2) return d.settings[k];
      d.settings[k] = v; save(); return v;
    },
    record: function (slug, r) {
      var g = this.forGame(slug);
      g.plays += 1;
      g.correct += r.correct; g.asked += r.asked;
      g.seconds += r.seconds;
      g.stars = Math.max(g.stars || 0, r.stars);
      g.level = r.level;
      g.last = new Date().toISOString().slice(0, 10);
      save();
      return g;
    },
    reset: function () { _mem = { games: {}, settings: load().settings }; save(); }
  };

  /* ══ audio ══════════════════════════════════════════════════════════════════ */
  /* Every sound is synthesised, so the app ships no audio files and works offline from the
   * first load. The one thing we cannot synthesise is a human voice: an instruction uses a
   * pre-generated clip when /kids/audio/<key>.mp3 exists (see audio-manifest.json), otherwise
   * speechSynthesis, otherwise a short "listen" chime and the on-screen text alone. */
  var audio = Kids.audio = (function () {
    var ctx = null, master = null, clips = {}, voice = null, voiceTried = false;
    var on = true;

    function ensure() {
      if (ctx) return ctx;
      try {
        var AC = W.AudioContext || W.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.5;
        master.connect(ctx.destination);
      } catch (e) { ctx = null; }
      return ctx;
    }
    /* called from the first real tap, because a browser will not let us make noise before that */
    function unlock() {
      var c = ensure();
      if (c && c.state === 'suspended') { try { c.resume(); } catch (e) {} }
    }

    function tone(freq, dur, type, when, gain, slideTo) {
      var c = ensure();
      if (!c || !on) return;
      var t0 = c.currentTime + (when || 0);
      var osc = c.createOscillator(), g = c.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain == null ? 0.26 : gain, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g); g.connect(master);
      osc.start(t0); osc.stop(t0 + dur + 0.02);
    }
    function noise(dur, when, gain, hp) {
      var c = ensure();
      if (!c || !on) return;
      var t0 = c.currentTime + (when || 0);
      var n = Math.max(1, Math.floor(c.sampleRate * dur));
      var buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0), i;
      for (i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      var src = c.createBufferSource(); src.buffer = buf;
      var g = c.createGain(); g.gain.value = gain == null ? 0.12 : gain;
      var f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp || 900;
      src.connect(f); f.connect(g); g.connect(master);
      src.start(t0);
    }

    var SFX = {
      /* a rising major third, the "yes" everyone recognises */
      right:  function () { tone(660, .12, 'triangle', 0, .22); tone(880, .18, 'triangle', .10, .20); tone(1320, .26, 'sine', .20, .12); },
      /* deliberately soft and low: a wrong answer is information, not a telling-off */
      wrong:  function () { tone(240, .20, 'sine', 0, .16, 180); },
      pop:    function () { tone(520 + rint(0, 120), .07, 'square', 0, .10); },
      tick:   function () { tone(1100, .035, 'square', 0, .06); },
      whoosh: function () { noise(.28, 0, .07, 600); },
      listen: function () { tone(880, .10, 'sine', 0, .14); tone(1175, .12, 'sine', .09, .11); },
      level:  function () { [523, 659, 784, 1047].forEach(function (f, i) { tone(f, .16, 'triangle', i * .085, .17); }); },
      fanfare: function () {
        [523, 659, 784, 1047, 1319].forEach(function (f, i) { tone(f, .30, 'triangle', i * .10, .18); });
        noise(.5, .1, .05, 1800);
      },
      sparkle: function () { [1568, 2093, 2637].forEach(function (f, i) { tone(f, .14, 'sine', i * .05, .07); }); }
    };

    /* ── voice ─────────────────────────────────────────────────────────────── */
    function loadManifest() {
      /* optional: a set of pre-recorded instruction clips. Absent today (see b507 NOTES —
       * "pre-generated audio" is a follow-up); the hook is here so dropping the files in and
       * listing them is the whole job. */
      fetch('audio-manifest.json', { cache: 'force-cache' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (m) { if (m && m.clips) clips = m.clips; })
        .catch(function () { /* no manifest: speechSynthesis or text only */ });
    }
    function bestVoice() {
      if (voiceTried) return voice;
      voiceTried = true;
      if (!W.speechSynthesis || !W.speechSynthesis.getVoices) return null;
      var vs = [];
      try { vs = W.speechSynthesis.getVoices() || []; } catch (e) { vs = []; }
      if (!vs.length) { voiceTried = false; return null; }   /* Chrome fills these in late */
      function find(fn) { for (var i = 0; i < vs.length; i++) if (fn(vs[i])) return vs[i]; return null; }
      voice = find(function (v) { return /en[-_]GB/i.test(v.lang) && /female|libby|hazel|sonia|serena|google uk english female/i.test(v.name); })
           || find(function (v) { return /en[-_]GB/i.test(v.lang); })
           || find(function (v) { return /^en/i.test(v.lang); })
           || vs[0] || null;
      return voice;
    }
    var speaking = false;
    function say(text, opts) {
      opts = opts || {};
      if (!on || !text) return false;
      var key = opts.key;
      if (key && clips[key]) {
        try {
          var a = new Audio('audio/' + clips[key]);
          a.play().catch(function () { speak(text, opts); });
          return true;
        } catch (e) { /* fall through */ }
      }
      return speak(text, opts);
    }
    function speak(text, opts) {
      if (!W.speechSynthesis) { SFX.listen(); return false; }
      try {
        if (!opts.queue) W.speechSynthesis.cancel();
        var u = new SpeechSynthesisUtterance(String(text));
        u.lang = 'en-GB';
        var v = bestVoice();
        if (v) u.voice = v;
        u.rate = opts.rate || 0.92;       /* a touch slower than default: these are four-year-olds */
        u.pitch = opts.pitch || 1.08;
        u.onstart = function () { speaking = true; onSpeakChange(true); };
        u.onend = u.onerror = function () { speaking = false; onSpeakChange(false); };
        W.speechSynthesis.speak(u);
        return true;
      } catch (e) { SFX.listen(); return false; }
    }
    var speakListeners = [];
    function onSpeakChange(v) { speakListeners.forEach(function (f) { try { f(v); } catch (e) {} }); }

    return {
      unlock: unlock,
      sfx: function (name) { var f = SFX[name]; if (f && on) { unlock(); f(); } },
      say: say,
      stopSpeaking: function () { try { if (W.speechSynthesis) W.speechSynthesis.cancel(); } catch (e) {} },
      onSpeakChange: function (f) { speakListeners.push(f); },
      hasVoice: function () { return !!(W.speechSynthesis) || Object.keys(clips).length > 0; },
      get on() { return on; },
      set on(v) { on = !!v; if (!on) this.stopSpeaking(); },
      init: function () {
        on = progress.setting('sound') !== false;
        loadManifest();
        /* voices arrive asynchronously in Chrome and Silk */
        if (W.speechSynthesis && 'onvoiceschanged' in W.speechSynthesis) {
          W.speechSynthesis.onvoiceschanged = function () { voiceTried = false; voice = null; bestVoice(); };
        }
      }
    };
  })();

  /* ══ particle layer ═════════════════════════════════════════════════════════ */
  var fx = Kids.fx = (function () {
    var cv = null, cx = null, parts = [], running = false, shakeUntil = 0, host = null;
    var frames = 0, frameStart = 0, lastFps = 0;

    function attach(frame) {
      host = frame;
      cv = el('canvas', 'k-fx');
      cv.setAttribute('aria-hidden', 'true');
      frame.appendChild(cv);
      cx = cv.getContext('2d');
      resize();
      W.addEventListener('resize', resize);
    }
    function detach() {
      W.removeEventListener('resize', resize);
      if (cv && cv.parentNode) cv.parentNode.removeChild(cv);
      cv = cx = host = null; parts = []; running = false;
    }
    function resize() {
      if (!cv || !host) return;
      var dpr = Math.min(2, W.devicePixelRatio || 1);
      var r = host.getBoundingClientRect();
      cv.width = Math.max(1, Math.round(r.width * dpr));
      cv.height = Math.max(1, Math.round(r.height * dpr));
      cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px';
      if (cx) cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    /* Confetti is drawn on a canvas, which cannot take a CSS variable, so the token has to be
     * resolved to a value here. If that fails (a very old WebView), fall back to the page's own
     * text colour rather than inventing a literal — tokens.css stays the only place a colour is
     * written down. */
    function colour(token) {
      var cs;
      try { cs = getComputedStyle(document.documentElement); } catch (e) { return 'currentColor'; }
      var v = '';
      try { v = (cs.getPropertyValue(token) || '').trim(); } catch (e) { v = ''; }
      if (v) return v;
      try { return (cs.getPropertyValue('--c-text') || '').trim() || 'currentColor'; }
      catch (e) { return 'currentColor'; }
    }
    var PALETTE = null;
    function palette() {
      if (!PALETTE) {
        PALETTE = ['--c-play-1', '--c-play-2', '--c-play-4', '--c-play-6', '--c-play-8', '--c-orange'].map(colour);
      }
      return PALETTE;
    }
    Kids.onThemeChange = function () { PALETTE = null; };

    function loop(ts) {
      if (!cx || !cv) { running = false; return; }
      frames++;
      if (!frameStart) frameStart = ts;
      else if (ts - frameStart >= 1000) { lastFps = Math.round(frames * 1000 / (ts - frameStart)); frames = 0; frameStart = ts; }

      cx.clearRect(0, 0, cv.width, cv.height);
      var i, p, alive = 0;
      for (i = 0; i < parts.length; i++) {
        p = parts[i];
        if (p.life <= 0) continue;
        alive++;
        p.life -= 1;
        p.vy += p.g;
        p.x += p.vx; p.y += p.vy;
        p.rot += p.vr;
        var a = Math.min(1, p.life / 18);
        cx.save();
        cx.globalAlpha = a;
        cx.translate(p.x, p.y);
        cx.rotate(p.rot);
        cx.fillStyle = p.c;
        if (p.kind === 'ring') {
          cx.globalAlpha = a * .5;
          cx.strokeStyle = p.c; cx.lineWidth = 3;
          cx.beginPath(); cx.arc(0, 0, p.r0 + (p.r1 - p.r0) * (1 - p.life / p.life0), 0, 6.283); cx.stroke();
        } else if (p.kind === 'star') {
          cx.beginPath();
          for (var k = 0; k < 5; k++) {
            var ang = (k / 5) * 6.283 - 1.57;
            cx.lineTo(Math.cos(ang) * p.s, Math.sin(ang) * p.s);
            cx.lineTo(Math.cos(ang + .628) * p.s * .45, Math.sin(ang + .628) * p.s * .45);
          }
          cx.closePath(); cx.fill();
        } else {
          cx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * .62);
        }
        cx.restore();
      }
      if (shakeUntil > Date.now() && host) {
        var m = (shakeUntil - Date.now()) / 220;
        host.style.transform = 'translate(' + (Math.random() * 6 - 3) * m + 'px,' + (Math.random() * 6 - 3) * m + 'px)';
      } else if (host && host.style.transform) { host.style.transform = ''; }

      if (alive || shakeUntil > Date.now()) requestAnimationFrame(loop);
      else { running = false; parts = []; }
    }
    function start() { if (!running) { running = true; frames = 0; frameStart = 0; requestAnimationFrame(loop); } }

    function spawn(n, x, y, opts) {
      opts = opts || {};
      var cols = palette(), i;
      for (i = 0; i < n; i++) {
        var ang = opts.ang != null ? opts.ang + (Math.random() - .5) * (opts.spread || 2.2) : Math.random() * 6.283;
        var sp = (opts.speed || 7) * (0.45 + Math.random());
        parts.push({
          kind: opts.kind || 'bit',
          x: x, y: y,
          vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - (opts.lift || 2),
          g: opts.g == null ? 0.26 : opts.g,
          s: (opts.size || 10) * (.6 + Math.random() * .8),
          rot: Math.random() * 6.283, vr: (Math.random() - .5) * .3,
          c: opts.colour || cols[i % cols.length],
          life: opts.life || (42 + Math.random() * 26), life0: opts.life || 56,
          r0: 10, r1: opts.r1 || 90
        });
      }
      start();
    }

    function centreOf(node) {
      if (!node || !host) return { x: 0, y: 0 };
      var r = node.getBoundingClientRect(), h = host.getBoundingClientRect();
      return { x: r.left - h.left + r.width / 2, y: r.top - h.top + r.height / 2 };
    }
    var reduced = false;
    try { reduced = W.matchMedia && W.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

    return {
      attach: attach, detach: detach, resize: resize, fps: function () { return lastFps; },
      burst: function (node, n) {
        if (reduced) return;
        var c = centreOf(node);
        spawn(n || 16, c.x, c.y, { kind: 'star', size: 9, speed: 6, lift: 3 });
        spawn(1, c.x, c.y, { kind: 'ring', life: 22, life0: 22, g: 0, r1: 90, size: 1 });
      },
      confetti: function (n) {
        if (reduced) return;
        if (!host) return;
        var w = host.getBoundingClientRect().width, i;
        for (i = 0; i < (n || 90); i++) spawn(1, Math.random() * w, -12, { size: 12, speed: 2, lift: -2, g: .22, life: 130, spread: 1 });
      },
      shake: function (ms) { if (reduced) return; shakeUntil = Date.now() + (ms || 220); start(); }
    };
  })();

  /* ══ staff mode ═════════════════════════════════════════════════════════════ */
  /* On the EY portal only: a member of staff has picked a child on /ey/kids-games and handed the
   * tablet over. The child's name is read from sessionStorage (set by that page, cleared when the
   * tab closes) — it is never in the URL and never in localStorage. */
  var staff = Kids.staff = (function () {
    var on = false, child = null, token = null, device = '';
    function init() {
      var q = new URLSearchParams(location.search);
      if (q.get('staff') !== '1') return;
      try { token = sessionStorage.getItem('wrenToken'); } catch (e) { token = null; }
      try { device = localStorage.getItem('wrenDevice') || ''; } catch (e) { device = ''; }
      try { child = JSON.parse(sessionStorage.getItem('wren-kids.child') || 'null'); } catch (e) { child = null; }
      var id = parseInt(q.get('child') || '0', 10);
      if (!token || !id) return;
      if (!child || Number(child.id) !== id) child = { id: id, first_name: '' };
      on = true;
    }
    function post(body) {
      if (!on || !token) return Promise.resolve(null);
      var h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
      if (device) h['X-Wren-Device'] = device;
      return fetch('/api/kids-games/sessions', { method: 'POST', headers: h, body: JSON.stringify(body) })
        .then(function (r) { return r.ok ? r.json() : r.json().catch(function () { return {}; }).then(function (d) { return Promise.reject(d); }); });
    }
    return {
      init: init, post: post,
      get on() { return on; },
      get child() { return child; }
    };
  })();

  /* ══ the game frame ═════════════════════════════════════════════════════════ */
  var frame = null, current = null;

  function iconBack() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
  }
  function iconSpeaker() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h3l5 4V5L7 9H4zM16 8.5a4 4 0 010 7M18.5 6a7 7 0 010 12"' +
      ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  }

  function buildFrame(def) {
    var f = el('div', 'k-game');
    f.style.setProperty('--c-accent', 'var(' + def.accent + ')');

    var head = el('div', 'k-ghead');
    var back = el('button', 'k-gback');
    back.type = 'button';
    back.setAttribute('aria-label', 'Back to all games');
    back.innerHTML = iconBack();
    var h1 = el('h1', null, def.title);
    var lvl = el('span', 'k-glevel', 'Level 1');
    var score = el('span', 'k-gscore', '0');
    score.setAttribute('aria-label', 'Score');
    head.appendChild(back); head.appendChild(h1); head.appendChild(lvl); head.appendChild(score);

    var prompt = el('div', 'k-gprompt');
    var ptext = el('p');
    ptext.setAttribute('aria-live', 'polite');
    var say = el('button', 'k-gsay');
    say.type = 'button';
    say.setAttribute('aria-label', 'Say that again');
    say.innerHTML = iconSpeaker();
    prompt.appendChild(ptext); prompt.appendChild(say);

    var stage = el('div', 'k-gstage');
    var foot = el('div', 'k-gfoot');

    f.appendChild(head); f.appendChild(prompt); f.appendChild(stage); f.appendChild(foot);
    f._parts = { back: back, title: h1, level: lvl, score: score, prompt: ptext, say: say, stage: stage, foot: foot };
    return f;
  }

  /* ══ the round loop ═════════════════════════════════════════════════════════ */
  /* A round is `roundLength` turns, about 2–3 minutes. The engine never runs two rounds without
   * asking: after every round the child chooses "Play again" or "I've finished", and after
   * `breakAfterMs` of continuous play the choice becomes "Have a break" with Play again held back
   * for three seconds. That is the screen-time design (see wren-docs/research/...): short,
   * bounded, with a natural stop, rather than an endless feed. */
  function Session(def) {
    this.def = def;
    this.store = progress.forGame(def.slug);
    this.level = Math.min(def.levels, Math.max(1, this.store.level || 1));
    this.turn = 0;
    this.correct = 0;
    this.asked = 0;
    this.streak = 0;
    this.misses = 0;
    this.roundCorrect = 0;
    this.rounds = 0;
    this.startedAt = Date.now();
    this.levelStart = this.level;
    this.levelsSeen = {};
    this.locked = false;
    this.resolving = false;
    this.history = [];
  }

  Session.prototype.dots = function () {
    var foot = frame._parts.foot, n = this.def.roundLength, i;
    clear(foot);
    for (i = 0; i < n; i++) {
      var d = el('span', 'k-dot');
      var h = this.history[i];
      if (h === true) d.className = 'k-dot hit';
      else if (h === false) d.className = 'k-dot miss';
      else if (i === this.history.length) d.className = 'k-dot now';
      foot.appendChild(d);
    }
    var lbl = el('span');
    lbl.className = 'k-glevel';
    lbl.style.visibility = 'hidden';
    foot.appendChild(lbl);
  };

  Session.prototype.header = function () {
    frame._parts.level.textContent = 'Level ' + this.level;
    frame._parts.score.textContent = String(this.correct);
  };

  /* Adaptive difficulty. Deliberately gentle and symmetric: three right in a row moves up, two
   * wrong at a level moves down, and it never moves more than one level at a time. The aim is to
   * keep the child at roughly 80% success — high enough to stay willing, low enough to be learning
   * (the "desirable difficulty" the retrieval-practice literature describes). */
  Session.prototype.adapt = function (right) {
    if (right) {
      this.streak++; this.misses = 0;
      if (this.streak >= 3 && this.level < this.def.levels) {
        this.level++; this.streak = 0;
        audio.sfx('level');
        return 'up';
      }
    } else {
      this.streak = 0; this.misses++;
      if (this.misses >= 2 && this.level > 1) { this.level--; this.misses = 0; return 'down'; }
    }
    return null;
  };

  Session.prototype.api = function () {
    var s = this, def = this.def, p = frame._parts;
    return {
      el: p.stage,
      level: s.level,
      levels: def.levels,
      stage: def.stage,
      slug: def.slug,
      util: Kids.util,
      art: Kids.art,
      sfx: function (n) { audio.sfx(n); },
      /* set the on-screen instruction AND speak it */
      ask: function (text, opts) {
        p.prompt.textContent = text;
        audio.say(text, opts || {});
        p._last = text; p._lastOpts = opts || {};
      },
      /* speak without changing the instruction line (e.g. reading a word aloud) */
      say: function (text, opts) { audio.say(text, opts || {}); },
      tile: function (label, onPick, opts) {
        opts = opts || {};
        var b = el('button', 'k-tile' + (opts.cls ? ' ' + opts.cls : ''));
        b.type = 'button';
        if (opts.html) b.innerHTML = opts.html; else b.textContent = label;
        b.setAttribute('aria-label', opts.aria || String(label));
        b.addEventListener('click', function () {
          if (s.locked) return;
          audio.unlock();
          onPick(b);
        });
        return b;
      },
      correct: function (opts) { s.resolve(true, opts || {}); },
      wrong: function (opts) { s.resolve(false, opts || {}); },
      burst: function (node, n) { fx.burst(node, n); },
      shake: function (ms) { fx.shake(ms); },
      lock: function () { s.locked = true; },
      unlock: function () { s.locked = false; }
    };
  };

  Session.prototype.nextTurn = function () {
    var p = frame._parts;
    this.locked = false;
    this.resolving = false;
    this.dots();
    this.header();
    clear(p.stage);
    if (!this.levelsSeen[this.level]) this.levelsSeen[this.level] = 0;
    this.levelsSeen[this.level]++;
    try { this.def.turn(this.api()); }
    catch (e) {
      /* a game that throws must not strand the child on a blank screen */
      p.prompt.textContent = 'Something went wrong. Let us try the next one.';
      var self = this;
      setTimeout(function () { self.resolve(false, { silent: true }); }, 900);
      if (W.console) console.error('[wren-kids] ' + this.def.slug + ' turn failed:', e);
    }
  };

  /* Resolve a turn. opts: { node, reveal, silent, hint }
   * `resolving` is NOT the same flag as `locked`: a game locks its own input as soon as a tile is
   * tapped (and most of them do, right before calling correct()/wrong()), so guarding this on
   * `locked` would make the game's own lock swallow its own answer. This one guards re-entrancy:
   * two taps landing in the same tick must resolve the turn once. */
  Session.prototype.resolve = function (right, opts) {
    if (this.resolving) return;
    this.resolving = true;
    this.locked = true;
    var s = this, p = frame._parts;

    this.asked++;
    this.history.push(right);
    if (right) { this.correct++; this.roundCorrect++; }
    this.dots();

    if (!opts.silent) {
      if (right) {
        audio.sfx('right');
        if (opts.node) fx.burst(opts.node, 18);
        if (opts.node) opts.node.classList.add('right');
        p.prompt.textContent = pick(['Yes!', 'Well done!', 'That is it!', 'Brilliant!', 'Good looking!', 'Spot on!']);
      } else {
        audio.sfx('wrong');
        fx.shake(200);
        if (opts.node) opts.node.classList.add('wrong');
        if (opts.reveal) opts.reveal.classList.add('reveal');
        p.prompt.textContent = opts.hint || 'Not that one. Look — this is the answer.';
        if (opts.hint) audio.say(opts.hint);
      }
    }
    var move = this.adapt(right);
    if (move === 'up') p.prompt.textContent += ' Level ' + this.level + '!';
    this.header();

    var wait = right ? 820 : 1750;
    setTimeout(function () {
      s.turn++;
      if (s.history.length >= s.def.roundLength) s.endRound();
      else s.nextTurn();
    }, opts.silent ? 250 : wait);
  };

  Session.prototype.starsFor = function () {
    var pct = this.def.roundLength ? this.roundCorrect / this.def.roundLength : 0;
    if (pct >= 0.9) return 3;
    if (pct >= 0.7) return 2;
    if (pct >= 0.4) return 1;
    return 0;
  };

  Session.prototype.secondsPlayed = function () { return Math.round((Date.now() - this.startedAt) / 1000); };

  Session.prototype.endRound = function () {
    var s = this, def = this.def, p = frame._parts;
    this.rounds++;
    var stars = this.starsFor();
    var secs = this.secondsPlayed();

    /* keep progress on the device */
    var g = progress.record(def.slug, {
      correct: this.roundCorrect, asked: def.roundLength,
      stars: stars, level: this.level, seconds: secs
    });

    /* staff mode: and in the child's record */
    if (staff.on) this.postSession(stars);

    if (stars >= 2) { audio.sfx('fanfare'); fx.confetti(stars === 3 ? 120 : 70); }
    else { audio.sfx('sparkle'); }

    var needBreak = (Date.now() - this.startedAt) >= def.breakAfterMs;

    var wrapEl = el('div', 'k-sum');
    var card = el('div', 'k-sum-card');
    var starRow = el('div', 'k-sum-stars', '★★★'.slice(0, stars) + '☆☆☆'.slice(0, 3 - stars));
    starRow.setAttribute('aria-label', stars + ' out of 3 stars');
    var h2 = el('h2', null, stars === 3 ? 'Perfect!' : stars === 2 ? 'Great work!' : stars === 1 ? 'Good try!' : 'Let us try again');
    var line = el('p', 'k-sum-line', this.roundCorrect + ' out of ' + def.roundLength + ' right · level ' + this.level);
    var learn = el('div', 'k-sum-learn');
    learn.innerHTML = '<b>Practised:</b> ' + escapeHtml(def.curriculum.plain);
    var actions = el('div', 'k-sum-actions');

    card.appendChild(starRow); card.appendChild(h2); card.appendChild(line); card.appendChild(learn);

    var again = el('button', 'k-btn', needBreak ? 'One more go' : 'Play again');
    again.type = 'button';
    var stop = el('button', 'k-btn ghost', needBreak ? 'Have a break' : 'I have finished');
    stop.type = 'button';

    if (needBreak) {
      var brk = el('p', 'k-sum-line');
      brk.textContent = 'You have been playing for ' + Math.round(secs / 60) + ' minutes. Time to stretch, have a drink, and do something away from the screen.';
      card.appendChild(brk);
      again.disabled = true;
      audio.say('You have been playing for a while. Time for a break.');
      setTimeout(function () { again.disabled = false; }, 3000);
      actions.appendChild(stop); actions.appendChild(again);
    } else {
      audio.say(stars >= 2 ? 'Well done! Play again, or finish.' : 'Good try. Shall we play again?');
      actions.appendChild(again); actions.appendChild(stop);
    }
    card.appendChild(actions);

    if (staff.on) {
      var obs = el('button', 'k-btn ghost small', 'Make an observation note');
      obs.type = 'button';
      obs.addEventListener('click', function () { s.toObservation(stars); });
      var staffRow = el('div', 'k-sum-actions');
      staffRow.style.marginTop = '12px';
      staffRow.appendChild(obs);
      card.appendChild(staffRow);
    }

    wrapEl.appendChild(card);
    frame.appendChild(wrapEl);
    p.prompt.textContent = 'Round finished.';
    frame._parts.stage.setAttribute('aria-hidden', 'true');

    again.addEventListener('click', function () {
      audio.unlock();
      if (wrapEl.parentNode) wrapEl.parentNode.removeChild(wrapEl);
      frame._parts.stage.removeAttribute('aria-hidden');
      s.history = []; s.roundCorrect = 0; s.resolving = false; s.locked = false;
      if (needBreak) s.startedAt = Date.now();   /* a fresh break window after an acknowledged break */
      s.nextTurn();
    });
    stop.addEventListener('click', function () { Kids.exitGame(); });
    setTimeout(function () { (needBreak ? stop : again).focus(); }, 60);
  };

  Session.prototype.postSession = function (stars) {
    var def = this.def, s = this;
    staff.post({
      child_id: staff.child.id,
      game: def.slug,
      game_title: def.title,
      stage: def.stage,
      level: this.level,
      score: this.roundCorrect,
      max_score: def.roundLength,
      duration_secs: this.secondsPlayed(),
      stars: stars,
      framework: def.curriculum.framework || 'fledge',
      statement_codes: def.curriculum.codes || [],
      elg_codes: def.curriculum.elgs || [],
      curriculum_note: def.curriculum.plain,
      started_at: new Date(this.startedAt).toISOString()
    }).then(function (r) {
      if (r) s.lastSessionId = r.id;
    }).catch(function (e) {
      if (W.console) console.warn('[wren-kids] session not saved:', (e && (e.error || e.message)) || e);
      /* a failed save must never interrupt the child — the round already counted on the device */
    });
  };

  /* Staff only, and only ever a DRAFT: the practitioner lands on the normal observation form with
   * the text pre-filled and has to read it, edit it and save it themselves. Wren never writes an
   * observation on its own (see b507 NOTES). */
  Session.prototype.toObservation = function (stars) {
    var def = this.def, c = staff.child;
    var name = (c && c.first_name) || 'They';
    var txt = name + ' played ' + def.title + ' on the tablet and got ' + this.roundCorrect +
      ' out of ' + def.roundLength + ' right at level ' + this.level + ' of ' + def.levels + '. ' +
      def.curriculum.obs + ' ';
    /* /ey/observation/new is the registered clean URL; /ey/observation-new is not a route and
     * falls through to login.html, which bounces a signed-in practitioner to My Morning. */
    var url = '/ey/observation/new?child=' + encodeURIComponent(c.id) +
      '&text=' + encodeURIComponent(txt) + '&source=kids-games';
    location.href = url;
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  Kids.escapeHtml = escapeHtml;

  /* ══ registration + start ═══════════════════════════════════════════════════ */
  Kids.game = function (def) {
    def.roundLength = def.roundLength || 10;
    def.breakAfterMs = def.breakAfterMs || (def.stage === 'eyfs' ? 5 * 60 * 1000 : 9 * 60 * 1000);
    def.levels = def.levels || 4;
    GAMES[def.slug] = def;
    ORDER.push(def.slug);
    return def;
  };

  Kids.play = function (slug) {
    var def = GAMES[slug];
    if (!def) { location.hash = '#/'; return; }
    audio.unlock();
    Kids.exitGame(true);

    frame = buildFrame(def);
    document.body.appendChild(frame);
    document.body.style.overflow = 'hidden';
    fx.attach(frame);

    var s = current = new Session(def);
    var p = frame._parts;
    p.back.addEventListener('click', function () { Kids.exitGame(); });
    p.say.addEventListener('click', function () {
      audio.unlock();
      if (p._last) audio.say(p._last, p._lastOpts);
    });
    audio.onSpeakChange(function (v) { if (p && p.say) p.say.classList.toggle('speaking', !!v); });

    /* the "how to play" card: a grown-up reads it, and it is the gesture that unlocks sound */
    s.dots(); s.header();
    var intro = el('div', 'k-howto');
    intro.innerHTML =
      '<div class="k-howto-emoji" aria-hidden="true">' + escapeHtml(def.emoji) + '</div>' +
      '<h2>' + escapeHtml(def.title) + '</h2>' +
      '<p>' + escapeHtml(def.howTo) + '</p>' +
      (staff.on && staff.child && staff.child.first_name
        ? '<p><b>' + escapeHtml(staff.child.first_name) + '</b>, it is your turn.</p>' : '') +
      '<p class="k-howto-cur">' + escapeHtml(def.curriculum.plain) + '</p>';
    var go = el('button', 'k-btn', 'Start');
    go.type = 'button';
    go.style.marginTop = '14px';
    intro.appendChild(go);
    p.stage.appendChild(intro);
    p.prompt.textContent = def.howTo;
    setTimeout(function () { go.focus(); }, 60);

    go.addEventListener('click', function () {
      audio.unlock();
      audio.sfx('whoosh');
      s.startedAt = Date.now();
      if (def.start) { try { def.start(s.api()); } catch (e) {} }
      s.nextTurn();
    });

    document.addEventListener('keydown', onEsc);
  };

  function onEsc(e) { if (e.key === 'Escape') Kids.exitGame(); }

  Kids.exitGame = function (quiet) {
    document.removeEventListener('keydown', onEsc);
    audio.stopSpeaking();
    fx.detach();
    if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
    frame = null; current = null;
    document.body.style.overflow = '';
    if (!quiet) { if (location.hash !== '#/') location.hash = '#/'; else W.dispatchEvent(new Event('hashchange')); }
  };

  /* the playtest probe reads these */
  Kids.debug = {
    fps: function () { return fx.fps(); },
    session: function () { return current; },
    frame: function () { return frame; },
    answerAll: function (rightProb) {
      /* used by the headless playtest only: picks a tile each turn so a whole round can be scripted */
      var tiles = frame ? frame.querySelectorAll('.k-gstage .k-tile:not([disabled])') : [];
      if (!tiles.length) return false;
      var i = Math.random() < (rightProb == null ? 1 : rightProb) ? 0 : tiles.length - 1;
      tiles[i].click();
      return true;
    }
  };

  audio.init();
  staff.init();
})(window);
