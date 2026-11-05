/* app.js — Wren Kids: the hub (b507, 2026-10-18).
 *
 * Three screens, on a hash router so the whole thing is one static page that works offline:
 *   #/           the game grid, filtered by stage
 *   #/progress   "What I have practised" — for a grown-up, built only from this device
 *   #/about      what this is, who made it, and the screen-time note
 *
 * At home there is no login, no account and no request to any server. In staff mode (?staff=1 on
 * the EY portal, after a member of staff has picked a child) the engine posts each finished round
 * to /api/kids-games/sessions and nothing else changes.
 */
(function (W) {
  'use strict';
  var K = W.Kids, U = K.util;
  var view, stageFilter = 'all';

  var STAGES = [
    { id: 'all', label: 'All' },
    { id: 'eyfs', label: 'Under 5s', sub: 'EYFS' },
    { id: 'ks1', label: 'Years 1–2', sub: 'KS1' },
    { id: 'ks2', label: 'Years 3–6', sub: 'KS2' }
  ];
  var STAGE_NAME = { eyfs: 'EYFS', ks1: 'Key Stage 1', ks2: 'Key Stage 2' };

  /* ── theme ──────────────────────────────────────────────────────────────── */
  function theme(set) {
    var root = document.documentElement;
    if (set) {
      root.setAttribute('data-kids-theme', set);
      K.progress.setting('theme', set);
      if (K.onThemeChange) K.onThemeChange();
      return set;
    }
    var saved = K.progress.setting('theme');
    if (saved) root.setAttribute('data-kids-theme', saved);
    return saved || 'auto';
  }
  function currentTheme() {
    var t = K.progress.setting('theme');
    if (t) return t;
    try { return W.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
    catch (e) { return 'light'; }
  }

  /* ── the top bar ────────────────────────────────────────────────────────── */
  function buildTop() {
    var top = U.el('header', 'k-top');
    var brand = U.el('a', 'k-brand');
    brand.href = '#/';
    /* the same mark as the app icon and the generated pages, so the three cannot drift */
    brand.innerHTML =
      '<span class="k-mark" aria-hidden="true"><img src="icons/icon.svg" alt="" width="34" height="34"></span>' +
      '<span>Wren Kids</span>';
    top.appendChild(brand);
    top.appendChild(U.el('span', 'k-top-spacer'));

    var sound = U.el('button', 'k-iconbtn');
    sound.type = 'button';
    sound.setAttribute('aria-label', 'Sound on or off');
    function paintSound() {
      sound.setAttribute('aria-pressed', K.audio.on ? 'true' : 'false');
      sound.innerHTML = K.audio.on
        ? '<svg viewBox="0 0 24 24"><path d="M4 9v6h3l5 4V5L7 9H4zM16 9a4 4 0 010 6"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M4 9v6h3l5 4V5L7 9H4zM17 10l4 4M21 10l-4 4"/></svg>';
    }
    paintSound();
    sound.addEventListener('click', function () {
      K.audio.on = !K.audio.on;
      K.progress.setting('sound', K.audio.on);
      paintSound();
      if (K.audio.on) K.audio.sfx('pop');
    });
    top.appendChild(sound);

    var th = U.el('button', 'k-iconbtn');
    th.type = 'button';
    th.setAttribute('aria-label', 'Light or dark');
    function paintTheme() {
      th.innerHTML = currentTheme() === 'dark'
        ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 019.5 4 8.5 8.5 0 1020 14.5z"/></svg>';
    }
    paintTheme();
    th.addEventListener('click', function () {
      theme(currentTheme() === 'dark' ? 'light' : 'dark');
      paintTheme();
    });
    top.appendChild(th);

    var install = U.el('button', 'k-iconbtn');
    install.type = 'button';
    install.hidden = true;
    install.textContent = 'Install';
    install.style.width = 'auto';
    top.appendChild(install);
    W.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      install.hidden = false;
      install.addEventListener('click', function () { install.hidden = true; e.prompt(); });
    });

    return top;
  }

  /* ── the footer: "made by Your Nursery, Ealing" ────────────── */
  function buildFooter() {
    var f = U.el('footer', 'k-foot');
    f.innerHTML =
      '<div class="k-foot-in">' +
      '<div class="k-foot-made">' +
      '<p><strong>Wren Kids</strong> is free, has no adverts and no trackers, and keeps everything on your device. ' +
      'It is part of <a href="https://getwren.co.uk">Wren</a>, the nursery and school software made at ' +
      '<a href="https://example-nursery.co.uk"><strong>Your Nursery</strong>, Ealing, West London</a>.</p>' +
      '<p>Your Nursery · 123 Example Lane, Your Town, AB1 2CD · Mon–Fri 8:00am–6:00pm · Established 1990</p>' +
      '</div>' +
      '<nav aria-label="More"><a href="#/about">About these games</a>' +
      '<a href="https://phonics.getwren.co.uk">Wren Phonics (free)</a>' +
      '<a href="https://getwren.co.uk/resources">Free printable resources</a>' +
      '<a href="https://example-nursery.co.uk">Our nursery</a></nav>' +
      '</div>';
    return f;
  }

  /* ── the game grid ──────────────────────────────────────────────────────── */
  function cardFor(slug) {
    var def = K.GAMES[slug];
    var g = K.progress.forGame(slug);
    var a = U.el('a', 'k-card');
    a.href = '#/play/' + slug;
    a.style.setProperty('--c-accent', 'var(' + def.accent + ')');
    var stars = '★★★'.slice(0, g.stars) + '☆☆☆'.slice(0, 3 - g.stars);
    a.innerHTML =
      '<div class="k-card-top"><span class="k-card-emoji" aria-hidden="true">' + K.escapeHtml(def.emoji) + '</span></div>' +
      '<div class="k-card-body">' +
      '<h3>' + K.escapeHtml(def.title) + '</h3>' +
      '<p>' + K.escapeHtml(def.short) + '</p>' +
      '<div class="k-card-meta">' +
      '<span class="k-pill on-accent">' + K.escapeHtml(STAGE_NAME[def.stage]) + '</span>' +
      (g.plays ? '<span class="k-pill">played ' + g.plays + '×</span>' : '') +
      '<span class="k-stars" data-earned="' + g.stars + '" aria-label="' + g.stars + ' of 3 stars">' + stars + '</span>' +
      '</div></div>';
    return a;
  }

  function renderHome() {
    var wrap = U.el('div', 'k-wrap');

    if (K.staff.on) {
      var banner = U.el('div', 'k-staff');
      var who = K.staff.child && K.staff.child.first_name;
      banner.innerHTML = '<span aria-hidden="true">👩‍🏫</span><span>Nursery mode — this session will be saved to <b>' +
        K.escapeHtml(who || 'the chosen child') + '</b>’s record.</span>';
      var end = U.el('a', 'k-btn ghost small k-staff-end', 'Finish');
      end.href = '/ey/kids-games';
      banner.appendChild(end);
      wrap.appendChild(banner);
    }

    var hero = U.el('div', 'k-hero');
    hero.innerHTML =
      '<h1>Free learning games</h1>' +
      '<p class="k-lead">Eight games for ages 2 to 11, each tied to the Early Years Foundation Stage or the national curriculum. ' +
      'No login, no adverts, no trackers, and nothing leaves your device. Works offline once it has loaded.</p>';
    wrap.appendChild(hero);

    var stages = U.el('div', 'k-stages');
    stages.setAttribute('role', 'group');
    stages.setAttribute('aria-label', 'Choose an age group');
    STAGES.forEach(function (s) {
      var b = U.el('button', 'k-stage');
      b.type = 'button';
      b.textContent = s.label + (s.sub ? ' · ' + s.sub : '');
      b.setAttribute('aria-pressed', stageFilter === s.id ? 'true' : 'false');
      b.addEventListener('click', function () {
        stageFilter = s.id;
        K.audio.unlock(); K.audio.sfx('pop');
        render();
      });
      stages.appendChild(b);
    });
    wrap.appendChild(stages);

    var grid = U.el('div', 'k-grid');
    var shown = K.ORDER.filter(function (slug) {
      return stageFilter === 'all' || K.GAMES[slug].stage === stageFilter;
    });
    shown.forEach(function (slug) { grid.appendChild(cardFor(slug)); });
    wrap.appendChild(grid);

    if (!K.staff.on) {
      var links = U.el('div', 'k-panel');
      links.innerHTML =
        '<h2>Also free from us</h2>' +
        '<p><a href="https://phonics.getwren.co.uk"><strong>Wren Phonics</strong></a> — the complete free phonics programme ' +
        'for Reception and Year 1, with decodable books and a reader. These games deliberately stop short of teaching letters ' +
        'and sounds, because that app does it properly.</p>' +
        '<p><a href="https://getwren.co.uk/resources"><strong>Free printable resources</strong></a> — hundreds of worksheets ' +
        'and activity sheets, EYFS to Key Stage 4.</p>' +
        '<p style="margin-top:14px"><a class="k-btn ghost small" href="#/progress">What my child has practised</a> ' +
        '<a class="k-btn ghost small" href="#/about">About these games</a></p>';
      wrap.appendChild(links);
    }
    return wrap;
  }

  /* ── "what I have practised" ────────────────────────────────────────────── */
  function renderProgress() {
    var wrap = U.el('div', 'k-wrap');
    var data = K.progress.all();
    var played = K.ORDER.filter(function (s) { return (data.games[s] || {}).plays; });

    var hero = U.el('div', 'k-hero');
    hero.innerHTML = '<h1>What we have practised</h1>' +
      '<p>This page is for the grown-up. It is built only from this device — nothing has been sent anywhere, ' +
      'and clearing your browser data clears it.</p>';
    wrap.appendChild(hero);

    if (!played.length) {
      var e = U.el('div', 'k-panel');
      e.innerHTML = '<p class="k-empty">Nothing played yet on this device. ' +
        '<a href="#/">Pick a game</a> and this page will fill in.</p>';
      wrap.appendChild(e);
      wrap.appendChild(backLink());
      return wrap;
    }

    /* by area of learning, which is how a practitioner or an interested parent thinks */
    var areas = {};
    played.forEach(function (slug) {
      var def = K.GAMES[slug], g = data.games[slug];
      var key = STAGE_NAME[def.stage];
      areas[key] = areas[key] || [];
      areas[key].push({ def: def, g: g });
    });

    Object.keys(areas).forEach(function (key) {
      var panel = U.el('div', 'k-panel');
      panel.appendChild(U.el('h2', null, key));
      areas[key].forEach(function (row) {
        var r = U.el('div', 'k-prog-row');
        var pct = row.g.asked ? Math.round(100 * row.g.correct / row.g.asked) : 0;
        var name = U.el('div', 'k-prog-name');
        name.innerHTML = K.escapeHtml(row.def.title) +
          '<small>' + K.escapeHtml(row.def.curriculum.plain) + '</small>' +
          '<small>' + row.g.plays + ' round' + (row.g.plays === 1 ? '' : 's') +
          ' · ' + Math.round(row.g.seconds / 60) + ' min · level ' + row.g.level + ' of ' + row.def.levels +
          (row.g.last ? ' · last played ' + row.g.last : '') + '</small>';
        var bar = U.el('div', 'k-bar');
        var fill = U.el('i');
        fill.style.width = pct + '%';
        bar.appendChild(fill);
        bar.setAttribute('role', 'img');
        bar.setAttribute('aria-label', pct + ' per cent right');
        var stars = U.el('span', 'k-stars', '★★★'.slice(0, row.g.stars) + '☆☆☆'.slice(0, 3 - row.g.stars));
        r.appendChild(name); r.appendChild(bar); r.appendChild(stars);
        panel.appendChild(r);
      });
      wrap.appendChild(panel);
    });

    var note = U.el('div', 'k-note');
    note.innerHTML = '<p><strong>A word on screen time.</strong> These games are built in short rounds of about ' +
      'two to three minutes, and the app asks the child to stop after about five minutes (nine for the older games). ' +
      'UK and international guidance is consistent that for under-fives what matters most is that screen time is short, ' +
      'shared with an adult, and does not replace play, sleep or talk — so sit with them if you can, and talk about ' +
      'what they are doing. Read more on the <a href="#/about">about page</a>.</p>';
    wrap.appendChild(note);

    var reset = U.el('button', 'k-btn ghost small', 'Clear everything on this device');
    reset.type = 'button';
    reset.addEventListener('click', function () {
      if (!W.confirm('Clear all progress stored on this device? This cannot be undone.')) return;
      K.progress.reset();
      render();
    });
    var row2 = U.el('p');
    row2.appendChild(reset);
    wrap.appendChild(row2);
    wrap.appendChild(backLink());
    return wrap;
  }

  function backLink() {
    var p = U.el('p');
    var a = U.el('a', 'k-btn ghost', '← All games');
    a.href = '#/';
    p.appendChild(a);
    return p;
  }

  /* ── about ──────────────────────────────────────────────────────────────── */
  function renderAbout() {
    var wrap = U.el('div', 'k-wrap');
    wrap.innerHTML =
      '<div class="k-hero"><h1>About Wren Kids</h1>' +
      '<p>Eight free learning games, made by a nursery, tied to what children are actually taught.</p></div>' +

      '<div class="k-panel"><h2>A learning tool first</h2>' +
      '<p>Every game here starts from a line of the <strong>Early Years Foundation Stage</strong> framework or the ' +
      '<strong>national curriculum</strong>, and the game is designed around that line rather than a curriculum label ' +
      'being stuck on a game afterwards. Each game tells you, on its own page and at the end of every round, exactly ' +
      'what it has been practising.</p>' +
      '<p>Three ideas run through all of them. <strong>Retrieval practice</strong>: being asked and trying to remember is ' +
      'what makes something stick, so the games ask rather than explain. <strong>Spacing</strong>: the facts a child gets ' +
      'wrong come back round sooner, and the ones they know drop out of rotation. ' +
      '<strong>Concrete, pictorial, abstract</strong>: in the maths games the picture always comes before the symbol — ' +
      'the bar before the fraction, the carriages before the number bond, the spots before the numeral.</p></div>' +

      '<div class="k-panel"><h2>Screen time</h2>' +
      '<p>We have designed this to be easy to stop. Rounds last about two to three minutes. After about five minutes of ' +
      'continuous play (nine for the Key Stage games) the app interrupts with a break prompt, and "play again" is held ' +
      'back for a few seconds so that stopping is the easy option.</p>' +
      '<p>The World Health Organization recommends <strong>no sedentary screen time at all for children under 2</strong>, ' +
      'and <strong>no more than one hour a day for 2- to 4-year-olds — less is better</strong>. The Royal College of ' +
      'Paediatrics and Child Health deliberately does not set a limit, and asks families four questions instead: is screen ' +
      'time controlled, does it interfere with what the family wants to do, does it interfere with sleep, and are snacks ' +
      'being eaten in front of it. Both agree on what matters more than minutes: that young children’s screen time is ' +
      '<strong>shared with an adult who talks to them about it</strong>. So if you can, sit with them.</p>' +
      '<p>Sources and the full reading are in our research note, linked from ' +
      '<a href="https://getwren.co.uk/kids/curriculum.html">the curriculum page</a>.</p></div>' +

      '<div class="k-panel"><h2>Privacy</h2>' +
      '<p>There are <strong>no accounts, no adverts, no third-party trackers, no analytics and no cookies</strong>. ' +
      'Nothing about your child is sent anywhere. Progress is kept in your browser’s own storage on this device only, ' +
      'and the "clear everything" button on the ' +
      '<a href="#/progress">practised page</a> removes it. There are no external fonts, scripts or images: once the app ' +
      'has loaded it makes no network requests at all, which is why it works on a plane.</p>' +
      '<p>Staff at a nursery using Wren can switch on a mode where a round is saved to a child’s learning record — ' +
      'that only happens inside the nursery’s own system, on the nursery’s own network, after a member of staff ' +
      'has signed in and chosen the child.</p></div>' +

      '<div class="k-panel"><h2>Who made this</h2>' +
      '<p><strong>Your Nursery</strong> in Ealing, West London, has been looking after children since 1990. ' +
      'We built our own nursery software, <a href="https://getwren.co.uk">Wren</a>, and we give away the parts families ' +
      'and other settings can use: a complete <a href="https://phonics.getwren.co.uk">phonics programme</a>, hundreds of ' +
      '<a href="https://getwren.co.uk/resources">printable resources</a>, and now these games.</p>' +
      '<p>All the illustrations are our own. Nothing here is taken from anyone else.</p></div>';
    wrap.appendChild(backLink());
    return wrap;
  }

  /* ── router ─────────────────────────────────────────────────────────────── */
  function render() {
    var hash = location.hash || '#/';
    var m = hash.match(/^#\/play\/([a-z0-9-]+)$/);
    if (m && K.GAMES[m[1]]) { K.play(m[1]); return; }

    U.clear(view);
    var body;
    if (hash === '#/progress') body = renderProgress();
    else if (hash === '#/about') body = renderAbout();
    else body = renderHome();
    view.appendChild(body);
    if (hash !== '#/') W.scrollTo(0, 0);
    document.title = hash === '#/progress' ? 'What we have practised · Wren Kids'
      : hash === '#/about' ? 'About · Wren Kids'
      : 'Wren Kids — free learning games for EYFS, KS1 and KS2';
  }

  function boot() {
    theme();
    document.body.insertBefore(buildTop(), document.body.firstChild);
    view = document.getElementById('view');
    K.art.ready();
    render();
    document.body.appendChild(buildFooter());
    W.addEventListener('hashchange', render);

    if ('serviceWorker' in navigator) {
      W.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () { /* file:// or blocked */ });
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
