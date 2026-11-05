/* ─────────────────────────────────────────────────────────────────────────────
 * wren-how-to.js — b360 (2026-09-29).
 *
 * "How Wren works", written for a practitioner in their second week.
 *
 *   WrenHowTo.render()          -> HTML string, every how-to
 *   WrenHowTo.render('diary')   -> one of them
 *   WrenHowTo.TOPICS            -> the raw list
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * It is not /ey/how-wren-works (public/js/how-wren-works.js). That page answers
 * "where does our data live and who can see it" — the box in the office, the
 * nightly backup, the sealed compartments. Useful, and completely different from
 * "how do I do a termly update". This file is the second question, and the two
 * are deliberately not merged: one is for a parent evening, the other is for a
 * Tuesday morning when the diary will not publish.
 *
 * ── EVERY FLOW BELOW WAS CHECKED AGAINST THE REAL PAGE ON 2026-09-29 ────────
 * Not against how it was designed — against the markup. The buttons are named
 * as they are actually labelled, including the emoji, because a practitioner
 * scanning a screen looks for the thing they were told to look for. Two that
 * catch people out and are called out explicitly:
 *   • "Sign In / Out" in the More menu is STAFF signing themselves in (tap your
 *     photo, type your PIN). CHILDREN are signed in and out on Child Register.
 *     Both are in the same More group and the names do not say which is which.
 *   • An observation and a diary entry both save as a DRAFT. A parent sees
 *     neither until somebody publishes — the diary in one go at the end of the
 *     day, an observation one at a time.
 *
 * If a flow changes, change it here. A guide that is wrong is worse than none:
 * somebody follows it, it does not work, and they stop trusting the page.
 * ───────────────────────────────────────────────────────────────────────────── */
;(function () {
  'use strict';
  if (window.WrenHowTo) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  // A button or a tab, named exactly as the screen names it.
  function k(s) { return '<span class="sf-key">' + esc(s) + '</span>'; }

  var TOPICS = [
    {
      key: 'diary',
      icon: '📖',
      title: 'Write the daily diary',
      link: { href: '/ey/diary', label: 'Open the Diary' },
      html:
        '<p>One diary, one flow — nappies, meals, sleeps and the little notes all go in the same place.</p>' +
        '<ol>' +
        '<li>Press the big ' + k('+') + ' in the middle of the bottom bar, then ' + k('📖 Diary') + '.</li>' +
        '<li>Pick the child or children, choose what you are logging, fill it in and save.</li>' +
        '<li>It saves as a <strong>draft</strong>. A parent cannot see it yet — you will see a ' +
        k('Draft') + ' chip next to it.</li>' +
        '<li>At the end of the day open the ' + k('Diary') + ' tab in the bottom bar. A bar appears ' +
        'saying how many entries are not yet shared. Press ' + k('📤 Publish to parents') + '.</li>' +
        '</ol>' +
        '<p>Publishing is per room and per day, so one press covers everything still in draft for the ' +
        'room you are looking at.</p>',
    },
    {
      key: 'observation',
      icon: '📝',
      title: 'Write an observation',
      link: { href: '/ey/observation/new', label: 'Start an observation' },
      html:
        '<ol>' +
        '<li>' + k('+') + ' → ' + k('📝 Observation') + '. (From a child’s profile it already knows who it is about.)</li>' +
        '<li>Write what you saw. The cards underneath are optional — what it tells you, the next step, ' +
        'photos, tags.</li>' +
        '<li>Link the framework statements. Wren suggests some; you decide.</li>' +
        '<li>' + k('💾 Save as') + ' keeps it as a draft for later. ' + k('✔ Publish') + ' finishes it.</li>' +
        '</ol>' +
        '<p>Drafts are waiting for you under More → Children → ' + k('Drafts') + '. If your room is set to ' +
        'be reviewed, a published observation goes to the review queue before a parent sees it.</p>',
    },
    {
      key: 'termly',
      icon: '📊',
      title: 'Do a termly update',
      link: { href: '/ey/termly-update', label: 'Open Termly Updates' },
      html:
        '<ol>' +
        '<li>More → Reports &amp; Checks → ' + k('Termly Updates') + '.</li>' +
        '<li>Find your key child in the list and press ' + k('Start') + '. Wren pulls in what has already ' +
        'been observed this term, so you are editing, not starting from nothing.</li>' +
        '<li>' + k('Save draft') + ' as often as you like. ' + k('Preview PDF') + ' shows the parent’s version.</li>' +
        '<li>When it is right, ' + k('Approve & send') + '.</li>' +
        '</ol>' +
        '<p>Who still has one outstanding is on More → Reports &amp; Checks → ' + k('Termly Update Tracker') + '.</p>',
    },
    {
      key: 'safeguarding',
      icon: '🛡️',
      title: 'Record a safeguarding concern, an accident, or a setting incident',
      link: { href: '/ey/safeguarding/new', label: 'Log a concern' },
      warn: 'Writing it in Wren is never the whole job. Tell the designated safeguarding lead in ' +
            'person, the same day, as well.',
      html:
        '<ol>' +
        '<li>' + k('+') + ' → ' + k('🛡️ Safeguarding') + '.</li>' +
        '<li>The first screen asks which record you need, because they are three different things:' +
        '<ul>' +
        '<li>' + k('🚑 Accident or injury') + ' — a child hurt themselves. A bump, a graze, a bite, a fall.</li>' +
        '<li>' + k('🛡️ Safeguarding concern') + ' — you are worried about a child’s welfare, or about ' +
        'something an adult said or did.</li>' +
        '<li>' + k('🏚️ Setting incident') + ' — something happened to the nursery. Fire, intruder, leak, ' +
        'power cut, a lost child, an outbreak, a near miss.</li>' +
        '</ul></li>' +
        '<li>Fill the form in and save. Write what you SAW and what was SAID, in the words used. Not what ' +
        'you think it means.</li>' +
        '</ol>' +
        '<p>Concerns already logged are on More → Safeguarding &amp; Records → ' +
        k('Safeguarding — Review Concerns') + ', which only staff with that permission can open.</p>',
    },
    {
      key: 'medicine',
      icon: '💊',
      title: 'Give medicine',
      link: { href: '/ey/medicine/new', label: 'Log medicine' },
      warn: 'Never give anything without consent on file. If it is not recorded, it did not happen.',
      html:
        '<ol>' +
        '<li>' + k('+') + ' → ' + k('💊 Medicine') + '.</li>' +
        '<li>Pick the child. Wren shows you the parent consents already on file for them.</li>' +
        '<li>Medicine, dose, time given, and the temperature if you took one. There is a temperature log ' +
        'if you are taking it more than once.</li>' +
        '<li>Tick how consent was given — ' + k('written') + ' or ' + k('verbal by phone') + '.</li>' +
        '<li>Sign it: your full name and your signature, and a witness’s.</li>' +
        '<li>' + k('Log medicine') + '.</li>' +
        '</ol>' +
        '<p>The records themselves are under More → Safeguarding &amp; Records → ' + k('Medicine Records') +
        ', which is restricted.</p>',
    },
    {
      key: 'register',
      icon: '✅',
      title: 'Sign children in and out',
      link: { href: '/ey/register', label: 'Open the Child Register' },
      warn: 'More → ' + '"Sign In / Out"' + ' is not this. That one is for staff signing themselves in.',
      html:
        '<ol>' +
        '<li>More → My Day → ' + k('Child Register') + '.</li>' +
        '<li>Tap a child to set them ' + k('In') + ', ' + k('Out') + ' or ' + k('Absent') + '.</li>' +
        '<li>Signing a child out asks who is collecting them. Pick from their approved list, or type a ' +
        'name if it is somebody else — and check the password first.</li>' +
        '</ol>' +
        '<p>' + k('Room Headcount') + ' in the same group is the quick count for a sweep or a fire drill.</p>',
    },
    {
      key: 'kitchen',
      icon: '🍽️',
      title: 'The kitchen',
      link: { href: '/ey/kitchen', label: 'Open the Kitchen' },
      html:
        '<p>More → My Day → ' + k('Kitchen') + '. Six tabs along the top:</p>' +
        '<ul>' +
        '<li>' + k('Today') + ' — who is in and what they are eating, allergies and dislikes on the list.</li>' +
        '<li>' + k('Menu') + ' — what is on this week.</li>' +
        '<li>' + k('Temps') + ' — fridge, freezer and food temperatures. Log them when you take them, ' +
        'not at the end of the day.</li>' +
        '<li>' + k('SFBB') + ' — the Safer Food Better Business daily diary.</li>' +
        '<li>' + k('Cleaning') + ' — the cleaning schedule and what has been signed off.</li>' +
        '<li>' + k('Notes') + ' — anything else worth a record.</li>' +
        '</ul>',
    },
    {
      key: 'clockin',
      icon: '🕐',
      title: 'Your fob, and clocking in',
      link: { href: '/ey/staff-clock', label: 'Open Staff Clock-In' },
      html:
        '<p>Two ways in, and they are the same record:</p>' +
        '<ul>' +
        '<li><strong>Your fob.</strong> Hold it on the reader. It knows whether you are arriving or ' +
        'leaving from which reader you used.</li>' +
        '<li><strong>The tablet.</strong> More → My Day → ' + k('Staff Clock-In') + ', then ' +
        k('🕐 Clock me in') + '. Breaks are ' + k('☕ Start break') + ' and ' + k('↩ Back from break') + ', ' +
        'and the end of the day is ' + k('Clock me out') + '.</li>' +
        '</ul>' +
        '<p>Lost your fob, or it has stopped working? Tell a manager the same day — a fob is a key to ' +
        'the building. Do not lend it to anybody, including another member of staff.</p>' +
        '<p>Your own hours and shifts are under More → CPD &amp; Reflection → ' + k('My Shifts') + '.</p>',
    },
    {
      key: 'holiday',
      icon: '🏖️',
      title: 'Book a holiday',
      warn: 'Holiday is still booked in BrightHR, not in Wren — until January 2027.',
      html:
        '<p>Book annual leave in <strong>BrightHR</strong>, exactly as you do now. Wren does not replace ' +
        'it yet, and anything you put in Wren will not reach the rota.</p>' +
        '<p>Wren is being built to take it over in <strong>January 2027</strong>. Until it does, BrightHR ' +
        'is the only place a holiday counts.</p>' +
        '<p>What Wren DOES know about is the shifts you are rostered for — More → CPD &amp; Reflection → ' +
        k('My Shifts') + ' — and who is off, on the room boards. That comes from BrightHR overnight.</p>',
    },
    {
      key: 'training',
      icon: '🎓',
      title: 'Training and CPD',
      link: { href: '/ey/deep-dive', label: 'Open the Deep Dive' },
      html:
        '<p>All of it is in More → CPD &amp; Reflection.</p>' +
        '<ul>' +
        '<li>' + k('Deep Dive') + ' — one theme a half-term, one fifteen-minute read a week, and a room ' +
        'meeting that talks about last week’s. Press ' + k('✓ I’ve read this') + ' when you have. At ' +
        'the end of the theme you evaluate it and sign off, and it goes onto your CPD record.</li>' +
        '<li>' + k('Ealing Training') + ' — what Ealing Council are running, and how to ask to go.</li>' +
        '<li>' + k('My Reflection & CPD') + ' — your own reflections, your practice, and what you have done.</li>' +
        '<li>' + k('Policies to Sign') + ' — anything waiting for your signature.</li>' +
        '<li>' + k('My Induction') + ' — if you are new, this is your checklist.</li>' +
        '</ul>',
    },
    {
      key: 'messages',
      icon: '✉️',
      title: 'Where messages are',
      link: { href: '/ey/messages', label: 'Open Messages' },
      html:
        '<ul>' +
        '<li><strong>Parents.</strong> The ' + k('✉️') + ' at the top right of any page. Tap it for the ' +
        'latest few, or open it for the full list. A number on it means something is unread.</li>' +
        '<li><strong>The nursery’s own mailbox.</strong> More → Messages → ' + k('Nursery Inbox') + ' — ' +
        'email that came in to the nursery address.</li>' +
        '<li><strong>Sending one out.</strong> More → Messages → ' + k('Send an Email') + '.</li>' +
        '<li><strong>Notices from management.</strong> More → Messages → ' + k('Announcements') + '.</li>' +
        '</ul>' +
        '<p>Anything that worries you about a child does not belong in a message to a parent. It belongs ' +
        'in a safeguarding record.</p>',
    },
    {
      key: 'broken',
      icon: '🐞',
      title: 'When something is broken',
      html:
        '<p>Press the ' + k('🐞') + ' button. It floats on every page, it takes a picture of whatever you ' +
        'are looking at, and it goes straight onto the list of things to fix.</p>' +
        '<p>If it is not there, turn it on: More → ' + k('Settings') + ' → Show Report-a-Bug Button.</p>' +
        '<p>For anything longer than a sentence, use the ' + k('Tell us') + ' tab on this page. Both end up ' +
        'in the same place.</p>' +
        '<p>And if the tablet itself is being slow or showing an old version: More → ' + k('Settings') + ' → ' +
        k('Clear cache & load latest version') + '.</p>',
    },
  ];

  function one(t) {
    return '<details class="sf-how" data-how="' + esc(t.key) + '">' +
      '<summary><span aria-hidden="true">' + t.icon + '</span> ' + esc(t.title) + '</summary>' +
      '<div class="sf-how-body">' +
      (t.warn ? '<p class="sf-warn-inline">⚠ ' + t.warn + '</p>' : '') +
      t.html +
      (t.link ? '<a class="sf-go" href="' + esc(t.link.href) + '">' + esc(t.link.label) + ' →</a>' : '') +
      '</div></details>';
  }

  function render(key) {
    if (key) {
      var found = TOPICS.filter(function (t) { return t.key === key; });
      return found.length ? one(found[0]) : '';
    }
    return '<div class="sf-card">' +
      '<h3>How Wren works</h3>' +
      '<p class="sf-sub">The jobs you actually do, with the buttons named as they are on screen. ' +
      'Checked against the real pages on 29 September 2026 — if one of these is wrong, that is a bug ' +
      'and the Tell us tab is the place for it.</p>' +
      TOPICS.map(one).join('') +
      '</div>';
  }

  window.WrenHowTo = { render: render, TOPICS: TOPICS };
}());
