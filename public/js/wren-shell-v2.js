/* Wren Shell v2 — unified shell: SPA (admin) + MPA (hr/eyfs/ladn/primary/secondary) */
if (window.__wrenShellLoaded === 'app') { console.error('[wren-shell-v2] CONFLICT: wren-app-shell.js is already loaded on this page. Only one shell per page!'); }
window.__wrenShellLoaded = 'v2';
/* b367 (2026-09-29) — shellHeaders() lives inside the main IIFE below, but TWO LATER,
   SEPARATE IIFEs in this same file call it: the b164 activity beacon and the away-mode
   banner. Out of scope there, so both threw ReferenceError from the moment b306 added
   the helper (2026-09-10) — the away banner never rendered (an uncaught pageerror on
   every shell page) and POST /api/audit/beacon was never sent, so the manager's usage
   page stopped being fed. One file-scope copy, used by those two blocks. */
window.__wrenShellHeaders = function (token, extra) {
  var device = '';
  try { device = localStorage.getItem('wrenDevice') || ''; } catch (e) { device = ''; }
  var h = Object.assign({ Authorization: 'Bearer ' + token }, extra || {});
  if (device) h['X-Wren-Device'] = device;
  return h;
};
/* fledge-off (2026-10-26) — the Fledge switch (public/js/wren-fledge.js, fed by
   ladn.settings.fledge_enabled via /api/features/public). Roost pages do not load
   wren-core.js, so the shell brings it in. [data-fledge] markup stays hidden until
   it says Fledge is on. */
;(function () {
  if (window.WrenFledge || document.getElementById('wren-fledge-js')) return;
  var s = document.createElement('script');
  s.id = 'wren-fledge-js';
  s.src = '/js/wren-fledge.js?v=fledgeoff1';
  (document.head || document.documentElement).appendChild(s);
})();
;(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────────
  const BUILD              = '20260511b';
  const TOKEN_KEY          = 'wrenToken';
  // 2026-10-13: an automatic bounce to sign-in remembers where you were going, so a silent
  // remembered-device re-sign-in lands you back there (Toby: the Reading Room card "is a dead link" —
  // an expired session sent him to login, which dropped him on the Cockpit instead).
  const _loginUrl = () => '/login.html?next=' + encodeURIComponent(location.pathname + location.search + location.hash);
  const SESSION_TIMEOUT_MS = 4 * 60 * 60 * 1000;
  const SESSION_WARN_MS    = (4 * 60 * 60 - 60) * 1000;
  const BASE               = window.WREN_BASE || '/admin';

  // b146: icon-pack key lookup for a nav/section item — resolves to a registered
  // SVG icon name via label, or '' (leaves the emoji in place, untouched, as fallback).
  const WI_KEY = s => (window.WrenIcons && s && s.label) ? (WrenIcons.keyFor(s.label) || '') : '';

  // ── Edition / mode detection ─────────────────────────────────────────────────
  const editionMeta = document.querySelector('meta[name="wren-edition"]');
  const EDITION     = window.WREN_EDITION || (editionMeta ? editionMeta.content : 'admin');
  const IS_ADMIN    = EDITION === 'admin' || !!window.WREN_SECTIONS;

  // ── MPA nav definitions ──────────────────────────────────────────────────────
  // HR link is hostname-aware (2026-07-04): LADN staff go to the real HR portal;
  // demo/getwren hosts must never leak the production URL — they get the local page.
  const HR_PORTAL_URL = /example-nursery\.co\.uk$/.test(location.hostname)
    ? 'https://hr.example-nursery.co.uk/' : '/hr.html';
  const NAV_MPA = {
    hr: {
      practitioner: [
        { icon: '🏠', label: 'Dashboard',    href: '/index.html' },
        { icon: '👤', label: 'My Profile',   href: '/my-profile.html' },
        { icon: '🏖️', label: 'Absences',     href: '/my-absences.html' },
        { icon: '🤝', label: 'Supervisions', href: '/my-supervisions.html' },
        { icon: '⏰', label: 'TOIL',         href: '/my-toil.html' },
        { icon: '🎓', label: 'CPD',          href: '/my-cpd.html' },
        { icon: '🤝', label: 'Ealing EY Partnership', href: '/ealing-partnership.html' },
        { icon: '💚', label: 'Wellbeing',    href: '/my-wellbeing.html' },
        { icon: '📄', label: 'Policies',     href: '/policies.html' },
        { icon: '📋', label: 'My Tasks',     href: '/my-tasks.html' },   // b209
        { icon: '📅', label: 'Events & Calendar', href: '/calendar.html' },   // b518 — nursery + parents layers, read-only
      ],
      room_leader: [
        { icon: '🏠', label: 'Dashboard',    href: '/index.html' },
        { icon: '👤', label: 'My Profile',   href: '/my-profile.html' },
        { icon: '🏖️', label: 'Absences',     href: '/my-absences.html' },
        { icon: '🤝', label: 'Supervisions', href: '/my-supervisions.html' },
        { icon: '⏰', label: 'TOIL',         href: '/my-toil.html' },
        { icon: '🎓', label: 'CPD',          href: '/my-cpd.html' },
        { icon: '🤝', label: 'Ealing EY Partnership', href: '/ealing-partnership.html' },
        { icon: '💚', label: 'Wellbeing',    href: '/my-wellbeing.html' },
        { icon: '📄', label: 'Policies',     href: '/policies.html' },
        { icon: '📋', label: 'My Tasks',     href: '/my-tasks.html' },   // b209
        { icon: '📰', label: 'Briefings', href: '/briefings.html' },   // b503
        { icon: '📅', label: 'Events & Calendar', href: '/calendar.html' },   // b518 — nursery + parents layers, read-only
      ],
      manager: [
        { icon: '🏠', label: 'Dashboard',    href: '/index.html' },
        { icon: '👤', label: 'My Space', children: [
          { label: 'My Profile',      href: '/my-profile.html' },
          { label: 'My Supervisions', href: '/my-supervisions.html' },
          { label: 'My Absences',     href: '/my-absences.html' },
          { label: 'My TOIL',         href: '/my-toil.html' },
          { label: 'My CPD',          href: '/my-cpd.html' },
          { label: 'AI CPD Creator',  href: '/cpd/ai-creator.html' },
          { label: 'Ealing EY Partnership', href: '/ealing-partnership.html' },
          { label: 'My Wellbeing',    href: '/my-wellbeing.html' },
        ]},
        { icon: '👥', label: 'Team', children: [
          { label: 'All Staff',        href: '/staff.html' },
          { label: 'Supervisions',     href: '/supervisions.html' },
          { label: 'Tasks (incl. action plans)', href: '/my-tasks.html?projects=1' },   // b501: Action Plans are tasks now
          { label: 'Absence Approval', href: '/absence-mgmt.html' },
          { label: 'TOIL Adjustments', href: '/toil.html' },
          { label: 'CPD Matrix',       href: '/cpd-matrix.html' },
          { label: 'Policies Admin',   href: '/policies-admin.html' },
          { label: 'Performance',      href: '/performance.html' },
        ]},
        { icon: '📄', label: 'Policies', href: '/policies.html' },
        { icon: '📅', label: 'Rota',     href: '/rota.html' },
        { icon: '📊', label: 'Staffing by Week', href: '/staffing-weeks.html' },
        { icon: '🗂️', label: 'Data Editor',      href: '/data-editor.html' },
        { icon: '💛', label: 'Keepsakes',        href: '/keepsakes.html' },
        { icon: '📇', label: 'Suppliers',        href: '/suppliers.html' },
        { icon: '🚨', label: 'Nursery Watchdog', href: '/monitor.html' },
        { icon: '🔧', label: 'Repairs',  href: '/repairs.html' },
        { icon: '📋', label: 'My Tasks', href: '/my-tasks.html' },   // b209
        { icon: '📰', label: 'Briefings', href: '/briefings.html' },   // b503
        { icon: '📅', label: 'Events & Calendar', href: '/calendar.html' },   // b518 — nursery + parents layers, read-only
      ],
    },
    eyfs: {
      practitioner: [
        { icon: '💬', label: 'Comms', children: [
          { label: 'Diary',          href: '/diary.html' },
          { label: 'Communications', href: '/communications.html' },
        ]},
        { icon: '🚑', label: 'Health & Safety', children: [
          { label: 'Sleep Checks',  href: '/sleep-checks.html' },
          { label: 'Medicine',      href: '/medicine.html' },
          { label: 'Incidents',     href: '/incidents.html' },
          { label: 'Safeguarding',  href: '/safeguarding.html' },
          { label: 'Repairs',       href: '/repairs.html' },
        ]},
        { icon: '🎓', label: 'Learning & Dev', children: [
          { label: 'Observations',  href: '/observations.html' },
          { label: 'Next Steps',    href: '/next-steps.html' },
          { label: 'Planning',      href: '/planning.html' },
          { label: 'Story Studio',  href: '/ey/story-studio' },
          { label: 'Curriculum',    href: '/curriculum.html' },
          { label: 'Phonics',       href: '/phonics.html' },
          { label: 'First Words',   href: '/first-words.html' },
          { label: 'Activity Bank', href: '/activity-bank.html' },
        ]},
        { icon: '👶', label: 'Children & Families', children: [
          { label: 'Children',      href: '/learning.html' },
          { label: 'Child Profile', href: '/child-profile.html' },
        ]},
        { icon: '⚙️', label: 'Operations', children: [
          { label: 'Outings',      href: '/outings.html' },
          { label: 'Clock In/Out', href: '/clock.html' },
          { label: 'Paperwork',    href: '/ey/paperwork' },  // b269 — read/search the setting's filed paper
        ]},
        { icon: '👤', label: 'My Account', children: [
          { label: 'My Profile', href: '/profile.html' },
          { label: 'HR & CPD →', href: HR_PORTAL_URL },
        ]},
      ],
      room_leader: [
        { icon: '💬', label: 'Comms', children: [
          { label: 'Diary',          href: '/diary.html' },
          { label: 'Communications', href: '/communications.html' },
        ]},
        { icon: '🚑', label: 'Health & Safety', children: [
          { label: 'Sleep Checks',  href: '/sleep-checks.html' },
          { label: 'Medicine',      href: '/medicine.html' },
          { label: 'Incidents',     href: '/incidents.html' },
          { label: 'Safeguarding',  href: '/safeguarding.html' },
          { label: 'Repairs',       href: '/repairs.html' },
        ]},
        { icon: '🎓', label: 'Learning & Dev', children: [
          { label: 'Observations',  href: '/observations.html' },
          { label: 'Next Steps',    href: '/next-steps.html' },
          { label: 'Planning',      href: '/planning.html' },
          { label: 'Story Studio',  href: '/ey/story-studio' },
          { label: 'Curriculum',    href: '/curriculum.html' },
          { label: 'Phonics',       href: '/phonics.html' },
          { label: 'First Words',   href: '/first-words.html' },
        ]},
        { icon: '👶', label: 'Children & Families', children: [
          { label: 'Children',      href: '/learning.html' },
          { label: 'Child Profile', href: '/child-profile.html' },
        ]},
        { icon: '⚙️', label: 'Operations', children: [
          { label: 'Outings',       href: '/outings.html' },
          { label: 'Clock In/Out',  href: '/clock.html' },
          { label: 'Action Plans',  href: '/action-plans.html' },
          { label: 'Paperwork',     href: '/ey/paperwork' },  // b269 — read/search the setting's filed paper
        ]},
        { icon: '👤', label: 'My Account', children: [
          { label: 'My Profile', href: '/profile.html' },
          { label: 'HR & CPD →', href: HR_PORTAL_URL },
        ]},
      ],
      manager: [
        { icon: '💬', label: 'Comms', children: [
          { label: 'Messages',       href: '/messages.html' },
          { label: 'Diary',          href: '/diary.html' },
          { label: 'Communications', href: '/communications.html' },
          { label: 'Aria calls',     href: '/aria.html' },
        ]},
        { icon: '🚑', label: 'Health & Safety', children: [
          { label: 'Sleep Checks',  href: '/sleep-checks.html' },
          { label: 'Medicine',      href: '/medicine.html' },
          { label: 'Incidents',     href: '/incidents.html' },
          { label: 'Safeguarding',  href: '/safeguarding.html' },
          { label: 'Repairs',       href: '/repairs.html' },
        ]},
        { icon: '🎓', label: 'Learning & Dev', children: [
          { label: 'Observations',  href: '/observations.html' },
          { label: 'Next Steps',    href: '/next-steps.html' },
          { label: 'Planning',      href: '/planning.html' },
          { label: 'Story Studio',  href: '/ey/story-studio' },
          { label: 'Curriculum',    href: '/curriculum.html' },
          { label: 'Phonics',       href: '/phonics.html' },
          { label: 'First Words',   href: '/first-words.html' },
          { label: 'Activity Bank', href: '/activity-bank.html' },
          { label: 'SEN',           href: '/sen.html' },
          { label: 'Reports',       href: '/reports.html' },
        ]},
        { icon: '👶', label: 'Children & Families', children: [
          { label: 'Children',      href: '/learning.html' },
          { label: 'Child Profile', href: '/child-profile.html' },
        ]},
        { icon: '⚙️', label: 'Operations', children: [
          { label: 'Outings',       href: '/outings.html' },
          { label: 'Clock In/Out',  href: '/clock.html' },
          { label: 'Action Plans',  href: '/action-plans.html' },
          { label: 'Paperwork',     href: '/ey/paperwork' },  // b269 — read/search the setting's filed paper
        ]},
        { icon: '👤', label: 'My Account', children: [
          { label: 'My Profile',  href: '/profile.html' },
          { label: 'HR portal →', href: HR_PORTAL_URL },
        ]},
      ],
    },
    primary: {
      practitioner: [
        { icon: '🎓', label: 'Pupils & teaching', children: [
          { label: 'Pupils',            href: '/learning.html' },
          { label: 'Register',          href: '/attendance.html' },
          { label: 'Assessments',       href: '/assessments.html' },
          { label: 'Reports',           href: '/reports.html' },
          { label: 'Homework',          href: '/homework.html' },
          { label: 'Curriculum',        href: '/curriculum.html' },
          { label: 'Teaching programmes', href: '/curriculum-programmes.html' }, // b257
          { label: 'Phonics',           href: '/phonics.html' },
          { label: 'Seating Plan',      href: '/seating-plan.html' },
          { label: 'Wren Points',       href: '/points-class.html' },
        ]},
        { icon: '🎭', label: 'Pastoral', children: [
          { label: 'Behaviour',         href: '/behaviour.html' },
          { label: 'Action Plans',      href: '/action-plans.html' },
          { label: 'Incidents',         href: '/incidents.html' },
          { label: 'Safeguarding',      href: '/safeguarding.html' },
        ]},
        { icon: '📅', label: 'Operations', children: [
          { label: 'Calendar',          href: '/calendar.html' },
          { label: 'Classes',           href: '/classes.html' },
          { label: 'Rota',              href: '/rota.html' },
          { label: 'Resources library', href: '/resources-library.html' },
          { label: 'Classroom Tools',   href: '/classroom-tools.html' },
        ]},
        { icon: '⚙️', label: 'Personal', children: [
          { label: 'CPD',     href: '/cpd.html' },
          { label: 'Profile', href: '/profile.html' },
        ]},
      ],
      manager: [
        { icon: '🏠', label: 'Admin Dashboard', href: '/admin.html' },
        { icon: '🎓', label: 'Pupils & teaching', children: [
          { label: 'Pupils',            href: '/learning.html' },
          { label: 'Register',          href: '/attendance.html' },
          { label: 'Assessments',       href: '/assessments.html' },
          { label: 'Reports',           href: '/reports.html' },
          { label: 'Homework',          href: '/homework.html' },
          { label: 'Curriculum',        href: '/curriculum.html' },
          { label: 'Teaching programmes', href: '/curriculum-programmes.html' }, // b257
          { label: 'Phonics',           href: '/phonics.html' },
          { label: 'Seating Plan',      href: '/seating-plan.html' },
          { label: 'Wren Points',       href: '/points-class.html' },
        ]},
        { icon: '🎭', label: 'Pastoral', children: [
          { label: 'Behaviour',         href: '/behaviour.html' },
          { label: 'Action Plans',      href: '/action-plans.html' },
          { label: 'Incidents',         href: '/incidents.html' },
          { label: 'Safeguarding',      href: '/safeguarding.html' },
          { label: 'SEND Register',     href: '/send.html' },
          { label: 'EHCP Tracker',      href: '/ehcp.html' },
          { label: 'Exclusions',        href: '/exclusions.html' },
          { label: 'Pupil Premium',     href: '/pupil-premium.html' },
        ]},
        { icon: '📅', label: 'Operations', children: [
          { label: 'Calendar',          href: '/calendar.html' },
          { label: 'Classes',           href: '/classes.html' },
          { label: 'Rota',              href: '/rota.html' },
          { label: 'Resources library', href: '/resources-library.html' },
          { label: 'Classroom Tools',   href: '/classroom-tools.html' },
        ]},
        { icon: '👥', label: 'Staff', children: [
          { label: 'Staff',           href: '/staff.html' },
          { label: 'HR',              href: '/hr.html' },
          { label: 'CPD',             href: '/cpd.html' },
          { label: 'NQT / ECT',       href: '/nqt-ect.html' },
          { label: 'Performance Mgmt',href: '/performance.html' },
        ]},
        { icon: '🏫', label: 'Compliance', children: [
          { label: 'Ofsted Prep',       href: '/ofsted-prep.html' },
          { label: 'CTF Import/Export', href: '/ctf-import.html' },
          { label: 'DfE Census',        href: '/census.html' },
        ]},
        { icon: '⚙️', label: 'System', children: [
          { label: 'Profile',         href: '/profile.html' },
          { label: 'IT Settings',     href: '/it-settings.html' },
          { label: 'Points Settings', href: '/points-admin.html' },
        ]},
      ],
    },
    secondary: {
      practitioner: [
        { icon: '🎓', label: 'Pupils & teaching', children: [
          { label: 'Pupils',            href: '/learning.html' },
          { label: 'Register',          href: '/attendance.html' },
          { label: 'Markbook',          href: '/assessments.html' },
          { label: 'Reports',           href: '/reports.html' },
          { label: 'Homework',          href: '/homework.html' },
          { label: 'Curriculum',        href: '/curriculum.html' },
          { label: 'Wren Points',       href: '/points-class.html' },
          { label: 'Google Classroom',  href: '/classroom-student.html' },
        ]},
        { icon: '🎭', label: 'Pastoral', children: [
          { label: 'Behaviour',         href: '/behaviour.html' },
          { label: 'Incidents',         href: '/incidents.html' },
          { label: 'Safeguarding',      href: '/safeguarding.html' },
        ]},
        { icon: '📅', label: 'Operations', children: [
          { label: 'Timetable',         href: '/timetable.html' },
          { label: 'Lesson Swaps',      href: '/swaps.html' },
          { label: 'Classes',           href: '/classes.html' },
          { label: 'Resources library', href: '/resources-library.html' },
        ]},
        { icon: '⚙️', label: 'Personal', children: [
          { label: 'CPD',     href: '/cpd.html' },
          { label: 'Profile', href: '/profile.html' },
        ]},
      ],
      manager: [
        { icon: '📊', label: 'MIS Dashboard', href: '/admin.html' },
        { icon: '🎓', label: 'Pupils & teaching', children: [
          { label: 'Pupils',            href: '/learning.html' },
          { label: 'Register',          href: '/attendance.html' },
          { label: 'Markbook',          href: '/assessments.html' },
          { label: 'Reports',           href: '/reports.html' },
          { label: 'Homework',          href: '/homework.html' },
          { label: 'Curriculum',        href: '/curriculum.html' },
          { label: 'Exam entries',      href: '/exam-entries.html' },
          { label: 'Progress 8',        href: '/progress8.html' },
          { label: 'Destinations',      href: '/destinations.html' },
          { label: 'Options',           href: '/options.html' },
          { label: 'Wren Points',       href: '/points-class.html' },
          { label: 'Google Classroom',  href: '/classroom-student.html' },
        ]},
        { icon: '🎭', label: 'Pastoral', children: [
          { label: 'Behaviour',         href: '/behaviour.html' },
          { label: 'Incidents',         href: '/incidents.html' },
          { label: 'Safeguarding',      href: '/safeguarding.html' },
          { label: 'SEND',              href: '/send.html' },
          { label: 'Exclusions',        href: '/exclusions.html' },
          { label: 'Detentions',        href: '/detentions.html' },
        ]},
        { icon: '📅', label: 'Operations', children: [
          { label: 'Timetable',         href: '/timetable.html' },
          { label: 'Cover',             href: '/cover.html' },
          { label: 'Lesson Swaps',      href: '/swaps.html' },
          { label: 'Classes',           href: '/classes.html' },
          { label: 'Resources library', href: '/resources-library.html' },
        ]},
        { icon: '👥', label: 'Staff', children: [
          { label: 'Staff', href: '/staff.html' },
          { label: 'HR',    href: '/hr.html' },
          { label: 'CPD',   href: '/cpd.html' },
        ]},
        { icon: '⚙️', label: 'System', children: [
          { label: 'Profile',            href: '/profile.html' },
          { label: 'IT Settings',        href: '/it-settings.html' },
          { label: 'Points Settings',    href: '/points-admin.html' },
          { label: 'Classroom Settings', href: '/classroom-settings.html' },
        ]},
      ],
    },
  };
  // ladn uses eyfs nav
  NAV_MPA.ladn = NAV_MPA.eyfs;

  // b273 (2026-09-04) — the EY tablet's More menu as a fourth arrangeable surface.
  // It is NOT one of the NAV_MPA sidebars: /ey/more runs wren-app-shell.js, not this
  // shell, and it is that portal's ENTIRE menu (data-portal="ey" suppresses the left
  // drawer). b242 wired the shells it could see; this closes the gap by giving More
  // its own edition key, `ladn-more`, backed by the declaration in
  // public/js/wren-ey-more-nav.js. Looked up lazily so script order does not matter,
  // and absent unless that file is loaded — no phantom edition in the picker.
  // b525 (2026-10-22) — `hr` prefers public/js/wren-hr-nav.js when that file is
  // on the page. NAV_MPA.hr below is rendered by NOTHING (HR pages run
  // wren-app-shell.js, which drops the hamburger on this portal), so the matrix
  // screen was offering Toby a layout for a sidebar nobody sees — including six
  // rows whose pages are not even served on the HR portal. The declaration is
  // what the HR tab bar, More page and desktop sidebar actually render, so it is
  // what the matrix must list. NAV_MPA.hr is KEPT as the fallback for anything
  // that loads this shell without the declaration: nothing is removed.
  const _navMpaCfg = edition =>
    (edition === 'hr' ? (window.WREN_HR_NAV || null) : null) ||
    NAV_MPA[edition] ||
    (edition === 'ladn-more' ? (window.WREN_EY_MORE_NAV || null) : null) ||
    {};

  // ── Admin SPA section registry ────────────────────────────────────────────────
  const SECTIONS = window.WREN_SECTIONS || {
    cockpit:        { id: 'cockpit',        icon: '🛩️', label: 'Cockpit',      tabs: ['mylist', 'comms', 'kanban', 'health', 'timeline', 'swot', 'mindmap'], requiresRole: 'manager' },   // b504 — +mylist FIRST: My list is the default tab (def.tabs[0]); nothing removed
    // b232 (2026-08-26) — the "What needs me" board. It populates itself from real
    // system state (policy review dates, unapplied migrations, silent crons,
    // unpaid invoices, unanswered parents, open safeguarding), so there is
    // nothing to keep up to date. Manager-only: it aggregates safeguarding
    // counts and money, and /api/attention checks the role and the portal again
    // server-side. Sits next to Cockpit because it is the other landing screen.
    attention:      { id: 'attention',      icon: '🎯', label: 'What needs me', tabs: ['board', 'all'], requiresRole: 'manager' },
    admissions:     { id: 'admissions',     icon: '🌱', label: 'Admissions',   tabs: ['occupancy', 'pipeline', 'engine'] },
    // b336 (2026-09-17) — one booking system for the office, the rooms and the
    // family: a week grid of slots, book-on-behalf, slot-time settings.
    viewings:       { id: 'viewings',       icon: '🚪', label: 'Viewings',     tabs: [] },
    'action-plans': { id: 'action-plans',   icon: '⭐', label: 'Tasks (incl. action plans)', tabs: ['management', 'baby-room', 'pre-school', 'shared-with-parents'] },
    staff:          { id: 'staff',          icon: '👥', label: 'Staff',        tabs: ['list', 'calendar', 'rota', 'supervisions', 'bradford', 'training', 'documents', 'observations', 'performance', 'reports', 'work-patterns', 'sickness-patterns', 'staff-voice'] }, // b345 — +staff-voice: what staff wrote about themselves and how we work, and the anonymous box. Added to the list, nothing removed; this array is what makes /admin/staff/staff-voice a deep link and puts it in Ctrl+K.
    // b228 (2026-08-25) — Toby: "I should just click - staff - payroll - generate."
    // No requiresRole on purpose: a deputy manager may open Payroll and see HOURS.
    // /api/payroll masks every money field for anyone without view_staff_salaries,
    // so hiding the whole section from them would remove staffing information they
    // are entitled to. Finance keeps its own 'payroll' TAB — that one is the
    // manager-only finance view; this is the staffing one.
    // b363 (2026-09-29) — +import: the BrightHR CSV importer. Added to the array,
    // nothing removed; this list is what makes /admin/payroll/import a deep link
    // and puts the tab in Ctrl+K. The tab itself is hidden on the page for anyone
    // without view_staff_salaries, and /api/payroll/import refuses them anyway.
    payroll:        { id: 'payroll',        icon: '💰', label: 'Payroll',      tabs: ['generate', 'runs', 'templates', 'import'] },
    children:       { id: 'children',       icon: '👶', label: 'Children',     tabs: ['list', 'reports'] },
    // b411 (2026-10-08) — read-only Roost view of the EY phonics programme hub.
    'phonics-programme': { id: 'phonics-programme', icon: '📅', label: 'Phonics Programme', href: '/phonics-programme.html', tabs: [] },
    family:         { id: 'family',         icon: '👪', label: 'Family',       tabs: ['events', 'absences', 'consents', 'bookings'] },
    'next-steps':   { id: 'next-steps',     icon: '➡️', label: 'Next Steps',  tabs: ['list', 'completed', 'overdue'] },
    'visual-schedules': { id: 'visual-schedules', icon: '🗓️', label: 'Visual Support', tabs: ['builder', 'saved'] },
    // b220 (2026-08-24) — Curriculum is now the ONE sidebar entry for curriculum work.
    // Termly Plan / Resource Cards / Fledge Framework / Framework Builder / Phonics
    // Library used to be six more sidebar icons; they are tabs on this page now (the
    // standalone pages still exist and are still reachable — see NAV_SIDEBAR_HIDDEN).
    // b276 (2026-09-04) — Toby: "resource cards and activities and phonics dont need
    // to be in curriculum section any more as they will be in planning". So termly,
    // weekly, resource-cards and phonics MOVED to the new `planning` section below,
    // and the activity bank joined them. Curriculum keeps the curriculum itself.
    // Nothing became unreachable: every one of those is a tab on Planning, still has
    // its own standalone URL, and still answers to Ctrl+K.
    // ('areas' was in the HTML but missing from this list before b276 — restored.)
    // b536 (2026-10-29) — 'observations' APPENDED at the end: the observation
    // reviewer (EyLog-style filters + PDF / anonymised PDF export), which Toby
    // asked to live in "curriculum/observations". Nothing reordered, nothing
    // removed — the array's first entry is still the section's default tab.
    curriculum:     { id: 'curriculum',     icon: '📚', label: 'Curriculum',   tabs: ['framework', 'next-steps', 'areas', 'events', 'trips', 'calendar', 'timetable', 'homework', 'observations'] },
    // b518 (2026-10-20) — Events & Calendar: ONE area for the three calendar layers
    // (Nursery internal / Parents / Managers), with the weekly planning merged in as
    // an overlay, a message thread per managers' event, the read-only iCal feeds and
    // Send to Pippin. Its tabs are sections/events-calendar.html.
    // Nothing is removed: Curriculum keeps its Calendar tab (which now redirects
    // here), and the Planning section above is still the editor this reads from.
    'events-calendar': { id: 'events-calendar', icon: '📅', label: 'Events & Calendar',
      tabs: ['month', 'week', 'list', 'managers', 'pippin', 'feeds', 'term-dates'] },
    // b276 — Planning: the one place the setting plans from. Termly theme and books,
    // the weekly workspace, the resource cards and activities those weeks are built
    // from, and phonics. Its tabs are sections/planning.html.
    // b521 — +focus-block, +half-term. Both tabs have been IN sections/planning.html since
    // b368/b371, so the tab bar showed them, but this array is what registers a deep link
    // (/admin/planning/half-term) and what Ctrl+K searches — so the two newest planning
    // pages were the two you could not find by searching for them. Added in the DOM's own
    // order; 'termly' stays first because tabs[0] is the section's default tab.
    planning:       { id: 'planning',       icon: '🗓️', label: 'Planning',     tabs: ['termly', 'focus-block', 'half-term', 'weekly', 'resource-cards', 'activities', 'phonics'] },
    // b524 (2026-10-21) — ACCOUNTS: the one money home. Toby: "should we just build
    // everything into the accounting section, and then in future when I run payroll
    // and fees and everything it gets put into the accounting section anyway."
    // A landing page that links every money view, plus the four things that only
    // exist here: the Paycheck payroll import, the fee runs derived from the
    // invoices, Ealing funding expected-vs-received by age group, and auto-allocate.
    // Its tabs are sections/accounts.html. Nothing is removed: money / finance /
    // finance-reports / finance-hmrc / funding-manager all stay exactly where they
    // are, and this page links to each of them rather than replacing any.
    accounts:       { id: 'accounts',       icon: '🧮', label: 'Accounts',
      tabs: ['home', 'payroll-import', 'allocate', 'funding', 'duplicates'] },
    // b397 (2026-10-05) — Invoices & Payments, rebuilt EyMan-shaped: Toby, reconciling,
    // "there is no easy way to add payments." A standalone page (href + tabs:[]) rather than
    // a Finance tab — it has its own tab bar (Invoices/Payments/Reconcile/Funding/Families).
    money:          { id: 'money',          icon: '💷', label: 'Invoices & Payments', href: '/money.html', tabs: [] },
    // 2026-10-15 (Toby): "on the finance screen add a button for funding … through to the full funding manager". Additive.
    'funding-manager': { id: 'funding-manager', icon: '🧾', label: 'Funding', href: '/funding.html?full=1', tabs: [], requiresRole: 'manager' },
    finance:        { id: 'finance',        icon: '💷', label: 'Finance (full)', tabs: ['dashboard', 'salary-per-room', 'funded-hours-recon', 'forecast', 'invoices', 'reconcile', 'payments', 'funding', 'wages', 'payroll'] },
    // b227 (2026-08-25) — the finance report pack. Its own section rather than a
    // twelfth tab on Finance: these are reports you run, print and send on, not
    // screens you work in, and the Finance tab bar is already full.
    'finance-reports': { id: 'finance-reports', icon: '📊', label: 'Finance Reports', tabs: ['income', 'aged-debtors', 'chase-list', 'payments', 'funding'], requiresRole: 'manager' },
    // b346 (2026-09-21) — HMRC & Deadlines. The company's tax and filing calendar (dates computed
    // from the year end, reminders on the What-needs-me board) and the termly money report (over
    // reconciled months only). Its own section in the Finance group, not a twelfth Finance tab.
    'finance-hmrc': { id: 'finance-hmrc', icon: '🏛️', label: 'HMRC & Deadlines', tabs: ['calendar', 'termly'], requiresRole: 'manager' },
    communications: { id: 'communications', icon: '💬', label: 'Comms',        tabs: ['inbox', 'messaging', 'newsletters', 'aria', 'content-creator', 'message-review', 'message-log', 'surveys', 'permission-slips', 'templates', 'gateway', 'rules'] },
    // b237 (2026-08-27): the API 403s anyone who is not DSL/room-leader
    // (requireSafeguardingViewer in src/routes/safeguarding.js) but the sidebar
    // entry showed regardless, so staff walked into a wall instead of not seeing
    // the door. requiresRoleAny mirrors that check exactly.
    safeguarding:   { id: 'safeguarding',   icon: '🛡️', label: 'Safeguarding', tabs: ['concerns', 'sign-off-queue', 'log', 'audit'],
                      requiresRoleAny: ['manager', 'deputy_manager', 'room_leader', 'headteacher', 'admin'] },
    inspection:     { id: 'inspection',     icon: '📋', label: 'Inspection',   tabs: ['overview', 'action-items', 'briefings', 'gap-analysis', 'evidence', 'history'], requiresRole: 'manager' },
    checklist:      { id: 'checklist',      icon: '✅', label: 'Checklist',    tabs: ['monthly'], requiresRole: 'manager' },
    operations:     { id: 'operations',     icon: '🔧', label: 'Operations',   tabs: ['kitchen', 'repairs', 'resources', 'clock-in-out', 'compliance', 'health-safety'] },
    // b403 (6 Oct, staff feedback) — "maintenance & repairs not there". Operations
    // above HAS a repairs tab, but nothing in the sidebar tree is LABELLED "repairs"
    // or "maintenance", so staff searching for either word found nothing. This was
    // built on dev on 6 Oct and never ported; confirmed absent from prod's served
    // shell on 2026-10-20 (ladn-ready/logs/chainN-ey-prod-probe.json).
    // Existing page, existing API — editions/admin/public/repairs.html + /api/repairs,
    // both already on prod. Additive: nothing above or below is changed or reordered.
    repairs:        { id: 'repairs',        icon: '🔧', label: 'Maintenance & Repairs', href: '/repairs.html', tabs: [] },
    // b234 (2026-08-26) — CCTV. Manager-only, and the API refuses an EY-portal token
    // even when the role is manager. The section is NOT the access control: the
    // opening-hours rule (internal cameras out-of-hours only) is enforced in
    // src/routes/cameras.js on the request that mints the stream token, and every
    // attempt is audited. Sits next to Operations because it is a premises system.
    // b362 (2026-09-29) — +recordings. Recording became real on 2026-09-28 (Frigate
    // on the Z420 at the nursery), so "what did the door camera see on Tuesday" has
    // an answer for the first time. Appended to the tab list; 'live' stays first so
    // the section's default landing tab is unchanged. ('requests', the b249 tab, was
    // never in this array — it is read from the DOM tab bar; it is added here too so
    // Ctrl+K and /admin/cameras/requests both resolve.)
    cameras:        { id: 'cameras',        icon: '📹', label: 'Cameras',      tabs: ['live', 'access-log', 'requests', 'recordings'], requiresRole: 'manager' },
    // b220 (2026-08-24) — CPD and Staff Knowledge were two sidebar entries covering the
    // same ground. One entry now, with Knowledge Checks as a tab (see NAV_SIDEBAR_HIDDEN).
    // b262 (2026-09-01) — 'deep-dive' (the half-term theme programme) and
    // 'monitoring' added. 'academy' stays FIRST so the section's default landing
    // tab is unchanged; the three existing tabs are untouched.
    cpd:            { id: 'cpd',            icon: '🎓', label: 'CPD & Knowledge', tabs: ['academy', 'deep-dive', 'knowledge', 'records', 'monitoring'], requiresRole: 'manager' },
    review:         { id: 'review',         icon: '✅', label: 'Review',       tabs: ['queue', 'decisions', 'observations'], requiresRole: 'manager' },
    // b230 (2026-08-25) — the notification centre. Toby: "I want wren admin full
    // notifications similar to eylog … this can be where I switch the notifications
    // matrix on and off, i thought you had already set that up for me, but i couldnt
    // see it." The matrix DID exist (/api/notification-matrix, b212) but
    // notification-settings.html was linked from nowhere. This section is the place
    // it is finally reachable from — category tabs 1–10, matrix + device push on
    // the Settings tab. No requiresRole: every member of staff has notifications,
    // and the API scopes both the feed and the matrix to the caller.
    notifications:  { id: 'notifications',  icon: '🔔', label: 'Notifications', tabs: ['all', 'safeguarding', 'accidents', 'enquiries', 'forms', 'payments', 'absence', 'children', 'staff', 'messages', 'system', 'settings'] },
    // b237 (2026-08-27) — the permissions matrix as a first-class screen. ladn.role_capabilities
    // held a 47-capability x 5-role matrix that only four route files read and that no screen
    // rendered in full; System -> Permissions showed the grid but per-staff overrides were
    // limited to two medicine tick-boxes. This section is the whole matrix, per-staff overrides
    // for every capability, and an honest "not enforced yet" badge per row. The System tab is
    // untouched and still works.
    permissions:    { id: 'permissions',    icon: '🔑', label: 'Permissions',  tabs: ['matrix', 'staff', 'approvals', 'navigation', 'wrenid'], requiresRole: 'manager' }, // b242 — +navigation: the role x page NAV matrix, deliberately beside the capability matrix so the difference between "cannot see it" and "cannot do it" is one tab apart. b292 — +wrenid: who holds a Wren ID and the button that sends somebody their first one. Added to the list, nothing removed; the tab bar reads the DOM, but this array is what makes /admin/permissions/wrenid a deep link and puts it in Ctrl+K
    system:         { id: 'system',         icon: '⚙️', label: 'System',       tabs: ['settings', 'integrations', 'backups', 'tech', 'support', 'docs', 'security', 'approvals', 'audit-log', 'notifications', 'my-account'], requiresRole: 'manager' }, // b200: +notifications, +my-account (panels existed in sections/system.html but were missing here, so Ctrl+K search could not find them)
    intelligence:   { id: 'intelligence',   icon: '📡', label: 'Intelligence',  tabs: ['workflows', 'search', 'ai-chat'], requiresRole: 'manager' },
    automations:    { id: 'automations',    icon: '🔁', label: 'Automations',   tabs: ['recipes', 'active'], requiresRole: 'manager' },
    access:         { id: 'access',         icon: '🔓', label: 'Access',        tabs: [], requiresRole: 'manager' },
    'quick-actions': { id: 'quick-actions', icon: '⚡', label: 'Quick Actions', tabs: [], requiresRole: 'manager' }, // b212 (2026-08-21) — add/archive a child or a staff member in one place
    assistant:      { id: 'assistant',      icon: '🪺', label: 'Wren AI',       tabs: ['chat'], requiresRole: 'manager' },
    // b348 (2026-09-21) — Wren Chat: a chat on Gemini that knows Wren (manuals + schema + COUNTS, never a
    // record). Its own standalone page, not another dropdown; the on-site Wren AI above stays as it is.
    'wren-chat':    { id: 'wren-chat',      icon: '💬', label: 'Wren Chat',     href: '/wren-chat.html', tabs: [], requiresRole: 'manager' },
    // b512 (2026-10-18) — the "when Toby's away" adviser: the Managers Bible, the business manual,
    // the policies, the handbook and the runbooks as RAG on the nursery's own model, with five
    // consultant modes and a "who decides" line on every answer. Its own standalone page, like
    // Wren Chat above; tabs:[] keeps the Ctrl+K search index safe (it reads s.tabs). ADDED to the
    // list — nothing here was changed or removed.
    'away-assistant': { id: 'away-assistant', icon: '🕊️', label: "When Toby's away", href: '/away-assistant.html', tabs: [], requiresRole: 'manager' },
    // b308 (2026-09-10) — +leavers-archive. ADDED to the list, nothing removed.
    // The existing 'archives' tab is the off-site gpg log (which record types have
    // been shipped where); this one is the per-child leavers' archive on its four
    // retention clocks. They are deliberately separate tabs: one answers "what
    // left the building", the other answers "what do we still hold about this
    // child, and when does each part of it die".
    'data-governance': { id: 'data-governance', icon: '🗄️', label: 'Data Governance', tabs: ['dashboard', 'schedule', 'records-map', 'leavers-archive', 'archives', 'data-requests'], requiresRole: 'manager' },
    // Standalone tool pages — full-page nav via href (not SPA fragments). tabs:[] keeps
    // the search index safe (it reads s.tabs).
    'occupancy-sandbox': { id: 'occupancy-sandbox', icon: '🧪', label: 'Occupancy Sandbox', href: '/occupancy-sandbox.html', tabs: [], requiresRole: 'manager' },
    'occupancy-planner': { id: 'occupancy-planner', icon: '📈', label: 'Occupancy Planner', href: '/occupancy-v2.html', tabs: [], requiresRole: 'manager' },
    'resource-cards':    { id: 'resource-cards',    icon: '🃏', label: 'Resource Cards',    href: '/resource-cards.html', tabs: [] }, // b159 (sidebar link 2026-07-27)
    'phonics-library':   { id: 'phonics-library',   icon: '📖', label: 'Phonics Library',   href: '/phonics-library.html', tabs: [] }, // b-resource-lib (2026-08-03) — decodable stories + phonics games browser
    'competitor-intel':  { id: 'competitor-intel',  icon: '🔭', label: 'Competitor Intel',  href: '/competitor-intel.html', tabs: [], requiresRole: 'manager' },
    'cf-access':         { id: 'cf-access',         icon: '🔐', label: 'Access Control',    href: '/cf-access.html', tabs: [], requiresRole: 'manager' },
    // b233 — Wren ID (self-hosted Authentik) parent enrolment state. Sits beside
    // Access Control rather than inside it: that page is Cloudflare's access
    // list, this one is Wren's own identity provider, and conflating the two
    // would be exactly the confusion b233 exists to remove.
    'parent-enrolment':  { id: 'parent-enrolment',  icon: '👪', label: 'Parent Enrolment',  href: '/parent-enrolment.html', tabs: [], requiresRole: 'manager' },
    'nav-settings':      { id: 'nav-settings',      icon: '🎛️', label: 'Sidebar Layout',    href: '/nav-settings.html', tabs: [], requiresRole: 'manager' },
    // ── b298 (2026-09-10) — two calendars, two settings pages ────────────────
    // Toby: "In terms of funding dates and term dates, these can be options in
    // the Settings menu … the termly dates are for the planning and the funding
    // dates are for the funding in the settings." They were the same screen in
    // people's heads, and on 2026-09-09 the planning half-terms were briefly
    // rewritten to funding boundaries, which deleted the breaks staff use for
    // evaluation and termly updates. Separate entries, separate labels, so the
    // question "which one do I want?" is answered by the sidebar itself.
    // href + tabs:[] — standalone pages, like every tool page above. Both are in
    // NAV_SIDEBAR_HIDDEN: they are reached from Settings and from Ctrl+K, which
    // is where a setting belongs, and neither adds a sidebar row.
    'term-dates':        { id: 'term-dates',        icon: '📅', label: 'Term dates',       href: '/term-dates.html',    tabs: [], requiresRole: 'manager' },
    'funding-dates':     { id: 'funding-dates',     icon: '💷', label: 'Funding dates',    href: '/funding-dates.html', tabs: [], requiresRole: 'manager' },
    // b230 — the standalone matrix page. Kept as its own entry so Ctrl+K search
    // and the Settings → System Tools link can reach it; it is NOT in the
    // sidebar (see NAV_SIDEBAR_HIDDEN) because the same screen is already the
    // Settings tab of the Notifications section.
    'notification-settings': { id: 'notification-settings', icon: '🔔', label: 'Notification Settings', href: '/notification-settings.html', tabs: [], requiresRole: 'manager' },
    'wren-leads':        { id: 'wren-leads',        icon: '🐦', label: 'Wren sales leads', href: '/wren-leads.html', tabs: [], requiresRole: 'manager' }, // 2026-10-09: getwren.co.uk leads were only on a page no menu linked to
    // ── b517 (2026-10-20) — who is finding getwren.co.uk ─────────────────────
    // A standalone page: href + tabs: []. requiresRole 'manager' matches the
    // server, where /api/site-analytics is requireRole('manager') and sits on
    // ROOST_ONLY_PREFIXES, so a deputy gets a 403 and would see an empty page.
    //
    // It is in the COMMS group, not a new 'Analytics' group as the brief sketched.
    // A new group is a new SIDEBAR ROW, and the sidebar is already 14 rows (10
    // groups + 3 Staff pins + Tracker Grid) at about 45px each: an eleventh group
    // takes the list past the 1366x768 fold that b241 shrank it to fit and that
    // scripts/b255-render-probe.js asserts. Comms is where everything about
    // getwren.co.uk already lives — the website editor, the Wren sales leads and
    // the public feedback — so the page is one click from its neighbours and no
    // row was added. The NOTES carry the three-line patch if Toby wants the group.
    'site-analytics':    { id: 'site-analytics',    icon: '📈', label: 'Website visitors', href: '/site-analytics.html', tabs: [], requiresRole: 'manager' }, // b517
    'website-builder':   { id: 'website-builder',   icon: '🌐', label: 'Website',           href: '/website-builder.html', tabs: [], requiresRole: 'manager' },
    'fledge-framework':  { id: 'fledge-framework',  icon: '🪶', label: 'Fledge — progress framework',  href: '/fledge-framework.html', tabs: [] },
    // ── b255 (2026-09-01) — the tracker pages Roost did not have ─────────────
    // Toby went looking for the phonics tracker on Roost and it was not there
    // (b247 built it EY-only), and there was no per-child framework tracker on
    // Roost at all. Both are standalone pages, so href + tabs:[] — the same
    // shape as every other tool page above. Additive: nothing here is replaced.
    // observations.html has existed for months with NO SECTIONS entry at all, so
    // Ctrl+K could never reach it — searching "observations" found the Review and
    // Staff TABS of that name instead, and the page itself was only reachable by
    // typing the URL. Adding it here is what makes §5's "it must stay findable in
    // Ctrl+K" actually true. href + tabs:[] — a standalone page, like the rest.
    observations:        { id: 'observations',        icon: '📔', label: 'Observations',  href: '/observations.html',       tabs: [] },
    // b334 (2026-09-15) — the duties tracker. Toby: "just like the observation
    // tracker or the framework tracker — one that tracks when the last report
    // was done, accident forms signed, medicine forms signed..." Same shape as
    // those two (href + tabs:[], a standalone grid page), so it joins Operations
    // rather than any single scope — it spans child, room, staff and setting.
    duties:              { id: 'duties',              icon: '🗂️', label: 'Duties Tracker', href: '/duties.html',            tabs: [], requiresRole: 'manager' },
    // b342 (2026-09-21) — custom reports, the EyMan kind. Toby: "put the fields as parent names, parent emails, child names, and
    // then that report will show me what's missing." Same shape as duties (href + tabs:[], standalone page). Named "Reports" in
    // Operations; the EYFS progress reports keep their own "Reports" link elsewhere and are not touched.
    'reports-builder':   { id: 'reports-builder',     icon: '🧾', label: 'Reports',        href: '/reports-builder.html',   tabs: [], requiresRole: 'manager' },
    // b335 (2026-09-15) — the concern pathway. Toby: "if a child joins us and
    // we have concerns, all the way from raising concerns about this child
    // until they leave us, what needs to happen in that time frame." Sits
    // beside duties: same shape (href + tabs:[], standalone page), reads
    // duty_status too for the manager digest, but is child-centred rather
    // than a whole-setting grid.
    pathways:            { id: 'pathways',            icon: '🧭', label: 'Pathways',       href: '/pathways.html',          tabs: [], requiresRole: 'manager' },
    // b286 (2026-09-08) — the practitioner morning board, on Roost. The SAME page
    // EY opens at /ey/my-morning, with the key-person filter free to change so a
    // manager can look at anyone's list. href + tabs:[] — a standalone page.
    'my-morning':        { id: 'my-morning',        icon: '🌅', label: 'Morning Board',  href: '/my-morning.html',        tabs: [] },
    'framework-tracker': { id: 'framework-tracker', icon: '📈', label: 'Tracker Grid',    href: '/framework-tracker.html', tabs: [] },

    // ── b523 (2026-10-20) — Look back ────────────────────────────────────────
    // Toby: "a build which gives us some good analysis tools, so that on the
    // inset day ... it's a look back at maybe the last year ... or compare the
    // last five years of data and say how the children have been progressing."
    // The one page that reads next to the Tracker Grid, so it sits beside it.
    //
    // A standalone page, so href + tabs: [] — the same shape as framework-tracker
    // above. requiresRole: 'manager' matches the server, which refuses anything
    // but a manager on the Roost portal. No capability is attached, deliberately:
    // see the header of src/routes/lookback.js for why a capability on an
    // already-manager-gated route would be a switch that switches nothing.
    'lookback':          { id: 'lookback',          icon: '🔭', label: 'Look back',      href: '/lookback.html',          tabs: [], requiresRole: 'manager' },
    // b359 (2026-09-29) — run the per-key-person termly-update drafter for any
    // practitioner. A standalone page, not a tab: it is a thing you RUN, and what
    // it produces is reviewed on /ey/termly-update where termly updates already
    // live. Not requiresRole:'manager' — the API's own gate is b246's isLead(),
    // which includes room leaders, and a sidebar that hides what the API allows
    // is the mismatch that makes people think a feature is broken.
    'keyperson-planning': { id: 'keyperson-planning', icon: '🐣', label: 'Key-Person Planning', href: '/keyperson-planning.html', tabs: [] },
    // b364 (2026-09-29) — the inbox in sections, with the context already worked
    // out. A standalone page beside Communications rather than a tab on it: the
    // Comms page is already twelve tabs and this is a screen you work in for an
    // hour, not one you glance at. Deliberately NOT requiresRole:'manager' — the
    // real gate is a PERSON list (settings.comms_manager_staff_ids, checked in
    // src/lib/inbox-access.js), which is narrower than any role, and a sidebar
    // that hides what the API allows is what makes people think it is broken.
    'hermes-inbox':      { id: 'hermes-inbox',      icon: '🪺', label: 'Inbox', href: '/hermes-inbox.html', tabs: [] },
    'phonics-tracker':   { id: 'phonics-tracker',   icon: '🔤', label: 'Phonics Tracker', href: '/phonics-tracker.html',   tabs: [] },
    // Manager-only, and the API refuses anyone else: it is a DRAFT comparison of
    // two frameworks for Toby to read, not a screen anyone works in.
    'fledge-mapping':    { id: 'fledge-mapping',    icon: '🪶', label: 'Fledge mapping', href: '/fledge-mapping.html', tabs: [], requiresRole: 'manager' },
    'framework-builder': { id: 'framework-builder', icon: '🧭', label: 'Framework Builder', href: '/framework-builder.html', tabs: [], requiresRole: 'manager' }, // b180 — build the setting's own curriculum framework
    'recruitment':       { id: 'recruitment',       icon: '🧑‍🍼', label: 'Recruitment',      href: '/recruitment.html', tabs: [], requiresRole: 'manager' }, // b112 — Wren Recruit
    'induction-oversight': { id: 'induction-oversight', icon: '🌱', label: 'Induction',      href: '/induction-oversight.html', tabs: [], requiresRole: 'manager' }, // b128 — new-starter induction workbook oversight
    'apprenticeships':   { id: 'apprenticeships',   icon: '🎓', label: 'Apprenticeships', href: '/apprenticeships.html', tabs: [], requiresRole: 'manager' }, // b317 — off-the-job training log + young-worker limits
    'ealing-cpd':        { id: 'ealing-cpd',        icon: '🏫', label: 'Ealing CPD',       href: '/ealing-cpd.html', tabs: [], requiresRole: 'manager' }, // b322 — Ealing's training emails as a catalogue staff request from
    'how-wren-works':    { id: 'how-wren-works',    icon: '🗺️', label: 'How Wren Works',    href: '/how-wren-works.html', tabs: [] }, // b113 — architecture explainer / self-training hub
    'fee-schedule':      { id: 'fee-schedule',      icon: '🧾', label: 'Fee Schedule',      href: '/fee-schedule.html', tabs: [], requiresRole: 'manager' }, // b114 — itemised billing: fee items / funding rates / opt-outs / invoice run
    'fee-sandbox':       { id: 'fee-sandbox',       icon: '💷', label: 'Fee Modeller',     href: '/fee-sandbox.html', tabs: [], requiresRole: 'manager' }, // b270 — what-if fee structure sandbox
    'stretch-recon':     { id: 'stretch-recon',     icon: '📐', label: 'Stretch Reconciliation', href: '/stretch-reconciliation.html', tabs: [], requiresRole: 'manager' }, // b114 — July-leavers funded-hour reconciliation
    'sen-flags':         { id: 'sen-flags',         icon: '🔎', label: 'SEN Early-Flagging', href: '/sen-flags.html', tabs: [], requiresRole: 'manager' }, // b120 — SEN early-flagging decision support (dev-only)
    'room-headcounts':   { id: 'room-headcounts',   icon: '🧮', label: 'Room Headcounts',   href: '/room-headcounts.html', tabs: [], requiresRole: 'manager' }, // b125 — scheduled headcounts + live ratio-compliance log
    'parent-app-feedback': { id: 'parent-app-feedback', icon: '💭', label: 'Parent App Feedback', href: '/parent-app-feedback.html', tabs: [], requiresRole: 'manager' },
    // b316 (2026-09-11) — the staff feedback / bug inbox. /feedback-reports.html has
    // existed since July and receives every report from the round button on every
    // staff screen, but had no nav entry: the only way in was a card inside System.
    // Toby asked where to find what staff submit. It now sits beside the parents' one.
    'feedback-reports':    { id: 'feedback-reports',    icon: '🐞', label: 'Staff Feedback & Bugs', href: '/feedback-reports.html', tabs: [], requiresRole: 'manager' }, // b129 — triage the in-app parent feedback button (like/change/idea/bug/other)
    'staff-celebrations': { id: 'staff-celebrations', icon: '🎉', label: 'Celebrations', href: '/staff-celebrations.html', tabs: [], requiresRole: 'manager' }, // b142 — birthdays/anniversaries/Christmas/Eid: cards, vouchers, flowers, credited service
    'sen-register':       { id: 'sen-register',       icon: '🧩', label: 'SEND Register',    href: '/sen-register.html', tabs: [], requiresRole: 'manager' }, // b155 — SEN hub: register, SMART targets, APDR cycles, Play Plans
    'sen-toolkit':        { id: 'sen-toolkit',        icon: '🧰', label: 'SEN Toolkit',      href: '/sen-toolkit.html', tabs: [], requiresRole: 'manager' }, // b256 — the strategy library by area of need; this Roost view is the CURATION side (EY practitioners read it at /ey/sen-toolkit)
    'staff-knowledge':    { id: 'staff-knowledge',    icon: '🧠', label: 'Knowledge & CPD',  href: '/staff-knowledge.html', tabs: [], requiresRole: 'manager' }, // b170 — always-on staff knowledge checks + safeguarding-CPD dashboard
    'cpd-matrix':         { id: 'cpd-matrix',         icon: '🎓', label: 'CPD Matrix',       href: '/cpd-matrix.html', tabs: [], requiresRole: 'manager' }, // 2026-09-15 — the HR portal's full matrix, on Roost too
    // b500 (2026-10-13) — Toby: "add a page in settings where I can easily edit
    // the data in the staff central records... check everybody's role... first
    // aid, other training etc and need to be able to edit bulk on the fly."
    // One spreadsheet-style page (Details + Training tabs) living in Settings,
    // not a new top-level Staff-group row — it's reached from the Settings
    // page/sidebar entry below plus "Edit/Open in Staff records" links on
    // Single Central Record, CPD Matrix and the Funding Census tab.
    'staff-records':      { id: 'staff-records',      icon: '📋', label: 'Staff Records',    href: '/staff-records.html', tabs: [], requiresRole: 'manager' },
    'community-moderation': { id: 'community-moderation', icon: '👪', label: 'Parent Community', href: '/community-moderation.html', tabs: [], requiresRole: 'manager' }, // 2026-07-28 parent forum moderation
    // b356 (2026-09-24) — three additive entries. staff-recognition and parent-voice moderate
    // parent-submitted content (thank-yous, anonymous feedback, testimonials, the question
    // board) — a different dataset from community-moderation's parent_group_posts, so kept
    // separate rather than folded in. inspection-toolkit complements 'inspection'/'report-card'
    // (self-evaluation vs compliance scoring) and sits next to them in Operations.
    'staff-recognition':  { id: 'staff-recognition',  icon: '💚', label: 'Recognition',       href: '/staff-recognition.html', tabs: [], requiresRole: 'manager' },
    'parent-voice':       { id: 'parent-voice',       icon: '💬', label: 'Parent Voice',       href: '/parent-voice.html', tabs: [], requiresRole: 'manager' },
    'inspection-toolkit': { id: 'inspection-toolkit', icon: '📘', label: 'Inspection Toolkit', href: '/inspection-toolkit.html', tabs: [], requiresRole: 'manager' },
    'single-central-record': { id: 'single-central-record', icon: '🗂️', label: 'Single Central Record', href: '/single-central-record.html', tabs: [], requiresRole: 'manager' }, // b186 — inspector-ready SCR + unified compliance expiry
    'report-card':        { id: 'report-card',        icon: '📊', label: 'Report Card',      href: '/report-card.html', tabs: [], requiresRole: 'manager' }, // b187 — internal inspection-readiness indicator (NOT an Ofsted grade)
    'termly-plan':        { id: 'termly-plan',        icon: '🗓️', label: 'Termly Plan',      href: '/termly-plan.html', tabs: [] }, // b181 — termly plan → 6 weeks of provision/activities per room → end-of-term evaluation
    'setting-incidents':  { id: 'setting-incidents',  icon: '🏚️', label: 'Setting Incidents', href: '/setting-incidents.html', tabs: [], requiresRole: 'manager' }, // b193 — significant events at the SETTING (fire/intruder/lost child/outbreak) + Ofsted notification tracking
    // ── b242 (2026-08-28) — two pages that existed but were not SECTIONS ──────
    // Toby, on the Staff group: "Absences should be main page. Payroll/Rota/Absences
    // on sidebar, everything else on page." Neither had a SECTIONS entry to put in a
    // group: Absences was only reachable as an HR-portal link (/absence-mgmt.html) and
    // via the /absences.html redirect stub, and Rota only as the `rota` TAB of Staff
    // plus an HR link. Adding them here is additive — nothing is removed, and the
    // staff/rota tab keeps working so every existing deep link still resolves.
    absences:             { id: 'absences',             icon: '🏖️', label: 'Absences',       href: '/staff/absence-mgmt.html', tabs: [], requiresRole: 'manager' }, // b242 — the b229 absence calendar + approval queue
    rota:                 { id: 'rota',                 icon: '📅', label: 'Rota',           href: '/rota.html', tabs: [], requiresRole: 'manager' },               // b242 — same page the Staff → Rota tab embeds

    // ── b309 (2026-09-10) — the BrightHR-parity screens ─────────────────────
    // Four standalone pages in the Staff group, which renders as a card grid, so
    // four more cards cost zero sidebar rows. Additive: every existing section is
    // untouched and every existing link still resolves.
    //   entitlement  the leave figures and the workings behind them. This is the
    //                one that mattered: before b309 every balance on every screen
    //                was a hard-coded 28 days.
    //   overtime     claim -> approve -> pay or TOIL. Nobody approves their own.
    //   lateness     clock-in against the rota. Reads zero rows until b310 makes
    //                clock-in real, and says so on the page rather than looking
    //                like a clean sheet.
    //   doc-signing  e-signature + read receipts for policies and staff documents.
    entitlement:          { id: 'entitlement',          icon: '🏝️', label: 'Leave Entitlement', href: '/staff/entitlement.html', tabs: [], requiresRole: 'manager' },

    // ── b522 (2026-10-20) — the hours-based leave surface ───────────────────
    // Toby: "the absence section of Roost just isn't that detailed … I'm used
    // to seeing things a certain way", before the January switch off BrightHR.
    //
    // ADDITIVE. 'absences' (the request queue and the b229 calendar) and
    // 'entitlement' (b309's DAYS figures) are both left exactly as they are and
    // both still work, because until Toby has decided between the two leave
    // policies the old figures must stay readable beside the new ones.
    //
    //   leave         who is off, the team calendar, everyone's allowance in
    //                 HOURS, sickness, and the set-up: contract weeks, the
    //                 holiday year, bank-holiday and closure deduction, and the
    //                 opening-balance import for the BrightHR cutover.
    //   leave-person  one person: the allowance with its workings, a ledger of
    //                 every hour that has come off it, their working pattern,
    //                 and their sickness. Not in a group — it is reached from a
    //                 card on the dashboard, so it needs a SECTIONS entry for
    //                 the shell to render its chrome but no sidebar row.
    leave:                { id: 'leave',                icon: '🏖️', label: 'Absence & Leave',   href: '/staff/leave.html',        tabs: [], requiresRole: 'manager' },
    'leave-person':       { id: 'leave-person',         icon: '🏖️', label: 'Leave Record',      href: '/staff/leave-person.html', tabs: [], requiresRole: 'manager', hidden: true },
    overtime:             { id: 'overtime',             icon: '⏱️', label: 'Overtime',          href: '/staff/overtime.html',    tabs: [], requiresRole: 'manager' },
    lateness:             { id: 'lateness',             icon: '⏰', label: 'Lateness',          href: '/staff/lateness.html',    tabs: [], requiresRole: 'manager' },
    'doc-signing':        { id: 'doc-signing',          icon: '✍️', label: 'Signatures',        href: '/staff/doc-signing.html', tabs: [], requiresRole: 'manager' },

    // ── b318 (2026-09-11) — the rules, written down and enforced ────────────
    // Two more cards in the Staff group (which renders as a card grid, so they
    // cost zero sidebar rows). Additive: every existing section is untouched.
    //   handbook-rules  the rule catalogue — what each rule is, which document
    //                   it comes from, whether it warns or blocks — plus who has
    //                   read which version of the handbook, and where the
    //                   handbook is out of date against the law. Staff read the
    //                   handbook itself on HR at /handbook.html.
    //   discipline      the ACAS-ordered disciplinary record. The outcome box
    //                   does not appear until an invitation and a meeting exist,
    //                   and the server refuses it regardless of the button.
    'handbook-rules':     { id: 'handbook-rules',       icon: '📘', label: 'Handbook & Rules',  href: '/staff/handbook-rules.html', tabs: [], requiresRole: 'manager' },
    discipline:           { id: 'discipline',           icon: '⚖️', label: 'Disciplinary',      href: '/staff/discipline.html',     tabs: [], requiresRole: 'manager' },

    // ── b366 (2026-09-29) — attendance triggers ──────────────────────────────
    // One more card in the Staff group (a card grid, so it costs no sidebar
    // row). Deliberately its own page rather than a tab on Absences: the
    // thresholds it carries decide when somebody gets a formal letter, and that
    // belongs where it can be read on its own, next to Disciplinary — which is
    // where approving one of its drafts lands you. Additive; nothing above or
    // below is changed.
    'absence-warnings':   { id: 'absence-warnings',     icon: '📋', label: 'Absence warnings',  href: '/staff/absence-warnings.html', tabs: [], requiresRole: 'manager' },

    // ── b362 (2026-09-29) — two more cards in the Staff group ────────────────
    // The Staff group renders as a card grid, so both cost zero sidebar rows.
    // Additive: every existing section is untouched.
    //
    //   staff-pins    Toby: "Is there a page where I can view and edit multiple
    //                 staff pins easily?" There wasn't — setting a PIN meant
    //                 opening one staff profile at a time. This is every active
    //                 person on one page with set / reset / remove per row.
    //                 It shows no PIN and no hash, ever, and the owner account
    //                 (id=1) is listed but not editable: that PIN changes in
    //                 Settings → Update PIN and nothing else may write it.
    //   clockin-fobs  Fob management has existed since b199/b250 and was
    //                 reachable ONLY from a "Full view →" link on the Operations
    //                 page, as a tab on a page whose name does not mention fobs.
    //                 The #fobs deep link opens clockin.html straight on that tab.
    'staff-pins':         { id: 'staff-pins',           icon: '🔢', label: 'Staff PINs',        href: '/staff/staff-pins.html',     tabs: [], requiresRole: 'manager' },
    'clockin-fobs':       { id: 'clockin-fobs',         icon: '🏷️', label: 'Clock-in & fobs',   href: '/clockin.html#fobs',         tabs: [], requiresRole: 'manager' },
    'login-health':       { id: 'login-health',         icon: '🩺', label: 'Login health',      href: '/login-health.html',         tabs: [], requiresRole: 'manager' }, // login-20261023: can every member of staff and every parent actually sign in? (additive)

    // ── b505 (2026-10-18) — the Security hub ─────────────────────────────────
    // Everything about the physical security of the building was already in Wren
    // and it was in six places: cameras here, the front door on /door.html, fobs
    // on /door-access.html, clock-in on /clockin.html, the CCTV disclosure
    // register behind /api/cctv, and nothing at all for the heating and lights.
    // On a Monday morning "what happened at the building over the weekend?" took
    // five pages. This is one page that answers it, reading the routes that
    // already own each number.
    //
    // A standalone page, so href + tabs: [] — the same shape as staff-pins and
    // clockin-fobs above. requiresRole: 'manager' matches the server, which
    // refuses anything but a manager on the Roost portal AND requires the
    // security.hub-view capability.
    'security-hub':       { id: 'security-hub',         icon: '🛡️', label: 'Security hub',      href: '/security-hub.html',         tabs: [], requiresRole: 'manager' },

    // ── b511 (2026-10-19) — Building & devices ───────────────────────────────
    // Toby: "just make it super duper easy to see and manage all of the Z2M
    // devices ... if I'm not there it needs to be able to be done." Until now the
    // only way to add a radiator valve or a fridge thermometer was Home
    // Assistant's own Zigbee2MQTT screen, which assumes you know what a
    // coordinator is. This is the same devices as a map of the building.
    //
    // A standalone page: href + tabs: []. DELIBERATELY NO requiresRole, unlike
    // the Security hub above — the office managers this page exists for are not
    // managers in staff.role, and the server gates on the building.devices.*
    // capabilities instead (src/routes/building-devices.js).
    'building-devices':   { id: 'building-devices',     icon: '🏠', label: 'Building & devices', href: '/building-devices.html',  tabs: [] },

    // ── b269 (2026-09-02) — the paperwork store ──────────────────────────────
    // Drop a folder of scans in and it files itself (with a human accepting every
    // proposal). A standalone page, so href + tabs:[] — the same shape as the
    // other tool pages above. Deliberately NO requiresRole: the per-category
    // capability gate in src/routes/paperwork.js decides what each person sees,
    // and a deputy manager filing the policy set is exactly the intended use.
    // Practitioners read it on the EY tablet at /ey/paperwork instead.
    paperwork:            { id: 'paperwork',            icon: '🗄️', label: 'Paperwork',      href: '/paperwork.html', tabs: [] },

    // ── b285 (2026-09-08) — the policy + T&C reviewer ────────────────────────
    // Toby: "make sure policies and terms and conditions reviewers are on admin
    // portal". policies-workspace.html has existed for months and was reachable
    // ONLY from two card links buried inside System and Operations — so Ctrl+K
    // could not find it and the sidebar never mentioned it. It is now a section
    // like any other tool page: href + tabs:[]. Additive; both existing card
    // links still work and still point at the same page.
    // No requiresRole — every write endpoint behind it checks MANAGER_ROLES
    // server-side, and a deputy reading the policy set is the intended use.
    policies:             { id: 'policies',             icon: '📄', label: 'Policies & T&C', href: '/policies-workspace.html', tabs: [] },

    // ── b290 (2026-09-08) — Deep Research ────────────────────────────────────
    // Toby: the reports and summaries written for him should be filed where he
    // can read them at leisure. A standalone page over the b269 paperwork store,
    // narrowed to the 'deep-research' heading and ordered by urgency rather than
    // by date. No requiresRole: paperwork.deep-research is granted to nobody by
    // default, so the ROUTE decides who gets anything — and the page says so
    // rather than 404ing. Additive; no existing entry changed.
    research:             { id: 'research',             icon: '📚', label: 'Deep Research',  href: '/research.html', tabs: [] },
    // b352 (2026-09-22) — the reading room (every analysis / audit / research report / decision note, with a Read ->
    // Discussed -> Decided -> Done track) and the supplier & subscription register. Two standalone pages, added to
    // SECTIONS only — nothing above or below is changed. Manager-only: the API refuses anyone else regardless.
    // 2026-10-13: relabelled (was 'Reading room') — Toby saw "two copies of Reading Room in Operations".
    // This one is the b352 decision log (analyses, audits, decisions with Read/Discussed/Decided/Done);
    // 'library' below is the Reading Room bookshelf, which also links back here.
    'reading-room':       { id: 'reading-room',         icon: '🗂️', label: 'Decision log',   href: '/documents/reading-room.html', tabs: [], requiresRole: 'manager' },
    // b425 (2026-10-08) — The Reading Room: the catalogue (policies, handbook, courses,
    // study modules, uploaded paperwork…) across every portal. Added to SECTIONS only —
    // nothing above or below changed. Deliberately a different id/href from b352's
    // "reading-room" above (an unrelated manager decision-log) — see
    // src/lib/reading-room-catalogue.js for the naming note.
    library:              { id: 'library',              icon: '📖', label: 'Reading Room',   href: '/library.html', tabs: [] },
    'supplier-register':  { id: 'supplier-register',    icon: '📇', label: 'Supplier register', href: '/supplier-register.html', tabs: [], requiresRole: 'manager' },
    // b295 (2026-09-09) — the running list of what staff need told, and the staff
    // newsletter it drafts. A standalone page rather than a tab on Comms: Comms
    // is the PARENT surface end to end (inbox, parent messaging, the parents
    // newsletter, surveys, permission slips) and the two audiences are exactly
    // what this build is keeping apart. requiresRole manager — it is the owner's
    // memory, and the send goes to personal inboxes.
    'staff-notices':      { id: 'staff-notices',        icon: '📣', label: 'Tell the staff', href: '/staff-notices.html', tabs: [], requiresRole: 'manager' },
    // 2026-09-17 — how Wren itself has changed, written for the people who run the
    // nursery (Toby: "a separate page on Wren for updates and latest bits"). Not
    // Tell the staff: that list is for the room teams and drafts their newsletter.
    // 2026-09-21 — Keepsakes existed only in the legacy per-role menu, so it never
    // appeared in this sidebar and Toby could not find it. One place to generate and
    // send a leaver's memory book; the farewell text inside one is on /leavers-book.html.
    keepsakes:      { id: 'keepsakes',      icon: '💛', label: 'Keepsakes',    href: '/keepsakes.html', tabs: [], requiresRole: 'manager' },
    // 2026-09-23 — the funding-claim compliance view: what is on file per child, what is not.
    'forms-register': { id: 'forms-register', icon: '📋', label: 'Forms & documents', href: '/forms-register.html', tabs: [], requiresRole: 'manager' },
    // b502 (2026-10-17) — who is missing what, who has to supply it, how long, and the reminders sent; reminder campaigns live here too.
    // b503 (2026-10-17) — weekly / monthly / termly briefings (standalone page; EY and HR have their own entries).
    briefings: { id: 'briefings', icon: '📰', label: 'Briefings', href: '/briefings.html', tabs: [], requiresRole: 'manager' },
    'missing-details': { id: 'missing-details', icon: '🧩', label: 'Missing details', href: '/missing-details.html', tabs: [], requiresRole: 'manager' },
    'wren-updates':       { id: 'wren-updates',         icon: '✨', label: "What's new in Wren", href: '/wren-updates.html', tabs: [], requiresRole: 'manager' },
    // b311 (2026-09-10) — the things Wren has noticed and said first: an invoice
    // run nobody has started, a September with half the roll leaving, an open
    // safeguarding concern with nothing written against it. A standalone page,
    // like every tool page above (href + tabs:[]). requiresRole manager: the mute
    // control decides whether a whole nursery hears from a signal, and the board
    // shows the finance and safeguarding counts behind each one. Additive —
    // nothing here is replaced.
    signals:              { id: 'signals',              icon: '🧭', label: 'Signals',       href: '/signals.html',      tabs: [], requiresRole: 'manager' },
    // b312 (2026-09-10) — the staff handbook consultation: who has answered,
    // the split on each of the eighteen questions, and every word anybody
    // typed. A standalone page like every tool page above (href + tabs:[]).
    // requiresRole manager because the rows are named staff opinions about how
    // we work, and /api/consultation/summary refuses a non-manager itself.
    // Additive — nothing here is replaced.
    consultation:         { id: 'consultation',         icon: '📕', label: 'Staff Handbook', href: '/consultation.html', tabs: [], requiresRole: 'manager' },
    // b360 (2026-09-29) — what the team have said about Wren itself: this term's
    // questions, which More-menu tiles they have switched off for themselves,
    // and their review of the deep-dive programme. A standalone page like every
    // tool page above (href + tabs:[]). requiresRole manager because the rows
    // are named staff opinions, and /api/staff-feedback/summary refuses a
    // non-manager (and anybody off the Roost person allowlist) itself.
    // Bugs and ideas deliberately are NOT here — they are on the bugs board with
    // everything else reported, and this page links there. Additive; nothing
    // above is replaced.
    'staff-feedback':     { id: 'staff-feedback',       icon: '💬', label: 'Staff Feedback', href: '/staff-feedback.html', tabs: [], requiresRole: 'manager' },
    // b396 (2026-10-05) — Toby: "set up a page in Help & Training called 'Managers guide'… one for staff as well." Additive.
    'managers-guide':     { id: 'managers-guide',       icon: '📘', label: "Managers' guide", href: '/managers-guide.html', tabs: [] },
    'staff-guide':        { id: 'staff-guide',          icon: '📗', label: 'Staff guide', href: '/guides/staff-guide.html', tabs: [] },
  };

  // ── Sidebar grouping (2026-07-12): default layout + user-editable override ──
  // The Sidebar Layout editor (/nav-settings.html) saves a reordered copy to
  // localStorage['wrenNavGroups']; the shell reads it here. Unmapped sections fall
  // into "More" at render time, so a stale saved layout can never hide a section.
  // b97 (2026-07-17, Toby): Visual Support + Next Steps moved Children → Curriculum.
  // The "System" sidebar group was removed entirely — its destinations (System/Settings,
  // Data Governance, Access Control, Access, Sidebar Layout) are linked from Settings
  // (/admin/system/settings + /settings.html) and the avatar account menu instead.
  const DEFAULT_NAV_GROUPS = [
    // b311 — +signals (additive; nothing removed). It belongs with Cockpit and
    // Attention: those two are "what is waiting on you today", and Signals is
    // the same question asked about next month. The Home group has `direct:
    // 'cockpit'`, so it renders as a card grid and a sixth card costs zero
    // sidebar rows.
    // 2026-09-17 — +wren-updates (additive; nothing removed). Card grid, so zero sidebar rows.
    { label: 'Home',             sections: ['cockpit', 'attention', 'briefings', 'quick-actions', 'notifications', 'my-morning', 'signals', 'wren-updates'] }, // b212 — +quick-actions; b230 — +notifications; b232 — +attention; b286 — +my-morning, the practitioner morning board (all additive; nothing removed)
    // b220 — +next-steps, +visual-schedules (both moved out of Curriculum: they are
    // child-level tools, and Curriculum is now a single entry).
    // b255 — +observations (additive). The Children group has no `direct` and no
    // `pinned`, so its row already opens a card grid: a ninth card costs zero
    // sidebar rows and the group is where a per-child record belongs.
    // b256 — +sen-toolkit (additive; nothing removed). It sits with sen-register
    // and sen-flags: same family of screens, and the Children group renders as a
    // card grid, so a tenth card costs zero sidebar rows.
    // b335 — +pathways (additive; nothing removed). A per-child timeline from
    // an initial concern to a leaving summary belongs beside safeguarding and
    // sen-register, not in the whole-setting Operations group with duties.
    { label: 'Children',         sections: ['children', 'family', 'action-plans', 'next-steps', 'visual-schedules', 'safeguarding', 'sen-flags', 'sen-register', 'sen-toolkit', 'pathways', 'observations', 'keepsakes', 'forms-register', 'missing-details'] },
    // b220 — −staff-knowledge (now the "Knowledge Checks" tab on CPD & Knowledge).
    // b228 — +payroll (additive; nothing removed). Sits next to Staff so the path
    // reads Staff → Payroll, which is exactly how Toby asked for it.
    // b237 — +permissions (additive; nothing removed). It belongs to the System family,
    // but the System sidebar group was deliberately removed (see NAV_SIDEBAR_HIDDEN below),
    // and "who is allowed to do what" reads naturally as Staff -> Permissions. It is also
    // linked from System -> Settings -> System Tools and from System -> Permissions.
    // b242 (2026-08-28) — Toby's Staff layout, shipped as the default rather than
    // left to be configured: "with staff section - Absences should be main page.
    // Payroll/Rota/Absences on sidebar, everything else on page".
    // Absences leads (it is the group's `direct` landing in NAV_GROUP_META below);
    // payroll + rota + absences are `pinned`, so they render as their own sidebar
    // rows; everything else reaches the Staff group PAGE as cards. Additive: every
    // section that was in this group is still in it.
    // b309 — +entitlement, +overtime, +lateness, +doc-signing (additive; nothing
    // removed and nothing reordered). Entitlement is listed immediately after
    // absences because it is the number every absence decision is made against.
    // b317 — +apprenticeships, listed next to induction because it is the same
    // person at the same stage: the workbook sign-offs the induction screen
    // records are where most off-the-job hours come from. Additive: every
    // section that was in this group is still in it, in the same order.
    // b318 — +handbook-rules, +discipline (additive; nothing removed and nothing
    // reordered). handbook-rules sits next to doc-signing because both answer
    // "who has read what"; discipline follows it because the rules and the
    // process for breaking them belong together.
    // b362 — +staff-pins, +clockin-fobs (additive; nothing removed and nothing
    // reordered). staff-pins sits next to permissions because both answer "who can
    // get in and with what"; clockin-fobs follows it because a fob and a PIN are
    // the two credentials a member of staff actually holds.
    // b522: 'leave' added at the FRONT of the Staff group — it is the absence
    // page Toby asked for. 'absences' (requests + approvals) and 'entitlement'
    // (b309's days figures) are kept, unmoved, immediately after it.
    { label: 'Staff',            sections: ['leave', 'absences', 'absence-warnings', 'entitlement', 'payroll', 'rota', 'staff', 'cpd-matrix', 'overtime', 'lateness', 'doc-signing', 'handbook-rules', 'discipline', 'recruitment', 'induction-oversight', 'apprenticeships', 'cpd', 'ealing-cpd', 'review', 'staff-celebrations', 'single-central-record', 'permissions', 'staff-pins', 'clockin-fobs', 'login-health'] }, // login-20261023 — +login-health (additive; nothing removed)
    // b336 — +viewings (additive; nothing removed). Toby, 2026-09-17: the phone
    // case ("Toby, the office manager or James take the call") is an admissions job.
    { label: 'Admissions',       sections: ['admissions', 'occupancy-sandbox', 'occupancy-planner', 'viewings'] },
    // b397 (2026-10-05) — +money, listed FIRST (Toby: "this is the way in"). Additive:
    // every section already in this group is still here, in the same order after it.
    // b524 (2026-10-21) — +accounts, listed FIRST. Toby asked for "one Finance
    // home ... so Nathan and Toby have one place to go", and the group has no
    // `direct` in NAV_GROUP_META, so the group's own row still opens the card
    // page — putting Accounts first changes which card reads first, not where a
    // click lands. ADDITIVE: every section already in this group is still here,
    // in the same order after it, 'money' included.
    { label: 'Finance',          sections: ['accounts', 'money', 'funding-manager', 'finance', 'finance-reports', 'finance-hmrc', 'fee-schedule', 'fee-sandbox', 'stretch-recon', 'supplier-register'] }, // b352 — +supplier-register (additive) // b227 — +finance-reports (additive); b270 — +fee-sandbox; b346 — +finance-hmrc; b524 — +accounts
    // b220 — collapsed from 11 entries to 1. termly-plan / resource-cards /
    // fledge-framework / framework-builder / phonics-library are tabs on the Curriculum
    // page; next-steps + visual-schedules moved to Children; inspection, report-card
    // and checklist moved to Operations. Nothing lost.
    // b255 — +framework-tracker, +phonics-tracker, +fledge-mapping. Curriculum was
    // a group of ONE, so its sidebar row WAS the Curriculum page; `direct` in
    // NAV_GROUP_META below keeps that one click intact now that the group has four.
    // b276 — +planning, listed FIRST so the group's row lands on the place staff
    // actually work. Additive: 'curriculum' and the three trackers are all still here.
    // b359 — +keyperson-planning (additive; nothing removed and nothing reordered).
    // b411 — +phonics-programme, APPENDED (additive; nothing removed and nothing reordered).
    // b518 — +events-calendar; b523 — +lookback. Both additive; nothing removed or reordered.
    { label: 'Curriculum',       sections: ['events-calendar', 'planning', 'curriculum', 'framework-tracker', 'phonics-tracker', 'keyperson-planning', 'phonics-programme', 'lookback'] },
    // b295 — +staff-notices (additive; nothing removed). The Comms group renders
    // as a card grid, so a fifth card costs zero sidebar rows.
    // b356 — +staff-recognition, +parent-voice (additive; nothing removed).
    // b364 — +hermes-inbox, APPENDED. Tempting to list it first — it is where the
    // email gets worked — but the Comms group renders as a card grid and the first
    // entry is what the group's own row lands on, so putting it first would move
    // Communications out from under a click Toby already has muscle memory for.
    // Additive, and nothing is reordered.
    // 2026-10-05 (Toby): "make the new inbox the default page on Comms". hermes-inbox moved to
    // the FRONT so the Comms row lands on it; nothing removed, the classic Communications page
    // (inbox, messaging, newsletters…) is still the next card along.
    // b517 — +site-analytics, listed straight after wren-leads because it answers
    // the question those leads come out of: who is finding getwren.co.uk, and
    // which phonics and resources pages brought them. The Comms group renders as
    // a card grid, so an eleventh card costs zero sidebar rows (additive; nothing
    // removed or reordered).
    { label: 'Comms',            sections: ['hermes-inbox', 'communications', 'community-moderation', 'website-builder', 'wren-leads', 'site-analytics', 'parent-app-feedback', 'feedback-reports', 'staff-notices', 'staff-recognition', 'parent-voice'] },
    // b220 — +inspection, +report-card, +checklist (inspection-readiness is an operational
    // routine, and they kept Curriculum from collapsing to one entry).
    // b241 — +room-headcounts. It was the ONE section in neither a group nor
    // NAV_SIDEBAR_HIDDEN, so it was swept into an eleventh "More" group of one.
    // It is a premises/ratio routine, so it belongs here. Additive: nothing removed.
    // b269 — +paperwork (additive; nothing removed). The setting's filing cabinet
    // is an operational routine and the Operations group already renders as a card
    // grid, so an eighth card costs zero sidebar rows.
    // b334 — +duties (additive; nothing removed). The whole-setting accountability
    // view belongs with checklist/inspection — "proving it was run well" is the
    // group's own blurb.
    { label: 'Operations',       sections: ['operations', 'repairs', 'setting-incidents', 'inspection', 'inspection-toolkit', 'report-card', 'checklist', 'cameras', 'security-hub', 'building-devices', 'room-headcounts', 'paperwork', 'policies', 'duties', 'reports-builder', 'reading-room', 'library'] }, // b342 — +reports-builder (additive); b193 — +setting-incidents; b234 — +cameras (additive); b285 — +policies (the policy + T&C reviewer; additive, nothing removed); b356 — +inspection-toolkit (additive); b425 — +library (the Reading Room, additive); b505 — +security-hub, listed straight after cameras because it is the page the cameras are reached FROM (additive; nothing removed or reordered); b511 — +building-devices, next to it for the same reason (additive)
    // b290 — +research (additive; nothing removed). The Deep Research folder is
    // analysis and reports, which is what this group already is.
    { label: 'AI & Intelligence', sections: ['intelligence', 'assistant', 'wren-chat', 'away-assistant', 'competitor-intel', 'automations', 'research'] }, // b348 — +wren-chat (additive); b512 — +away-assistant (additive)
    { label: 'Help & Training',  sections: ['how-wren-works', 'consultation', 'staff-feedback', 'managers-guide', 'staff-guide'] }, // b113 — self-training hub / architecture explainer; b312 — +consultation, the staff handbook and what they said about it; b360 — +staff-feedback, what the team have said about Wren (all additive; nothing removed)
  ];
  // Sections that no longer appear in the sidebar (still routable via URL, Ctrl+K
  // search and the Settings page links — SECTIONS itself is untouched). Applied to
  // saved wrenNavGroups layouts too, so a stale saved layout can't resurrect them.
  // b220 (2026-08-24): the seven ids after 'nav-settings' are the pages that became TABS.
  // They must be listed here as well as dropped from DEFAULT_NAV_GROUPS — an unmapped
  // section is swept into "More" at render time, which would have put the icon straight
  // back. They stay in SECTIONS, so the URL, the Ctrl+K search and the "Open full screen ↗"
  // links all still reach the standalone page.
  //   termly-plan, resource-cards, fledge-framework, framework-builder, phonics-library
  //     → tabs on Curriculum
  //   staff-knowledge → "Knowledge Checks" tab on CPD & Knowledge
  // report-card is deliberately NOT here: it was going to be an Inspection tab, but the
  // Inspection tab bar lives inside #insp-active, which stays display:none until someone
  // actually starts an inspection — so a tab there would have been reachable less of the
  // time than the icon was. It keeps its own entry, moved to Operations.
  const NAV_SIDEBAR_HIDDEN = new Set(['system', 'data-governance', 'cf-access', 'parent-enrolment', 'access', 'nav-settings',
    // b298 — settings screens, reached from Settings and Ctrl+K. Adding them to
    // the sidebar would put two more rows on a sidebar Toby already asked to shrink.
    'term-dates', 'funding-dates',
    'termly-plan', 'resource-cards', 'fledge-framework', 'framework-builder', 'phonics-library',
    'staff-knowledge',
    // b230 — same screen as Notifications → Settings & devices; one sidebar
    // entry for notifications, not two.
    'notification-settings']);

  // ── b241 (2026-08-28): the sidebar lists GROUPS; the sections live on a page ──
  // Toby, with a screenshot of the sidebar circled: "the only issue is still sidebar
  // has way too many items. What I meant was to group them in the main page pages…
  // rather than to keep scrolling, change to 2/3 rows."
  //
  // Ten groups held ~44 sections and the sidebar rendered one row per SECTION, so it
  // ran past the bottom of a laptop screen and Sign Out sat below the fold. It now
  // renders one row per GROUP; clicking a group opens a card grid of its sections
  // (3 columns desktop / 2 tablet / 1 phone). This is a LAYOUT change only — every
  // section stays in SECTIONS, stays routable by URL, stays in Ctrl+K search and
  // stays reachable from the Settings links that already point at it.
  //
  // Escape hatch: localStorage['wrenNavFlat'] = '1' restores the pre-b241 flat
  // grouped sidebar (the collapsible-group code below is unchanged and still runs).
  const GROUP_ROUTE = 'group';                       // /admin/group/<slug>
  const _grpSlugify = l => String(l || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'group';
  // Per-group chrome, keyed by the group LABEL so a saved wrenNavGroups / setting-wide
  // layout picks it up too. An unknown label still works — it falls back to a derived
  // slug, a neutral icon and no blurb, so a custom group is never unreachable.
  //   direct: clicking the sidebar row goes STRAIGHT to that section instead of the
  //   group page. Only Home uses it: Cockpit is the landing and the one thing opened
  //   every day — it must not become two clicks. The group page is still reachable
  //   from the row's "open group" button, from /admin/group/home and from Ctrl+K.
  const NAV_GROUP_META = {
    'Home':              { icon: '🏠', direct: 'cockpit', blurb: 'Today at a glance, and the things waiting on you.' },
    'Children':          { icon: '👶', blurb: 'Every child record, and the plans and concerns attached to them.' },
    //   pinned: sections that ALSO get their own sidebar row, under the group row.
    //   b242 — Toby wanted Payroll/Rota/Absences one tap away, not behind a card
    //   grid. Three extra rows is the whole cost; the sidebar is still 13 rows and
    //   Sign Out still sits above the fold at 1366x768 (measured, see the notes).
    // b242 gave this group `direct: 'absences'` on Toby's instruction that
    // "Absences should be main page". 2026-09-08 he reversed it: clicking Staff
    // jumped past the chooser into the old absence screen, and only the chevron
    // reached the group page — which reads as a broken row, not a shortcut.
    // Dropping `direct` makes the row open the Staff card page. Absences loses
    // nothing: it stays in `pinned`, so it keeps its own sidebar row one click away.
    'Staff':             { icon: '👥', blurb: 'Your team — from hiring and induction through to pay and permissions.',
                           pinned: ['payroll', 'rota', 'absences'] },
    'Admissions':        { icon: '🌱', blurb: 'Enquiries, occupancy and the places you can still fill.' },
    'Finance':           { icon: '💷', blurb: 'Invoicing, funding, reports and the fee schedule behind them.' },
    // b255 — Curriculum stopped being a group of one, so without `direct` its row
    // would have become a card page and the Curriculum screen two clicks.
    //
    // ONE pin, not two. Pinning both trackers took the sidebar to 15 rows — 676px
    // of list in 651px, so it scrolled, and b241's whole point was that it does
    // not (measured by scripts/b255-render-probe.js, which fails the build if it
    // does). Tracker Grid is the pinned one because "no framework tracker exists
    // on Roost at all" is the larger half of what b255 fixes. Phonics Tracker and
    // the Fledge draft are one ▸ away on the Curriculum group page, in Ctrl+K, and
    // linked from the top of the tracker grid — and Toby can pin either of them
    // himself in Sidebar Layout, which is what b242 made configurable.
    // b276 — the group row now lands on PLANNING, because that is where staff work:
    // termly theme, the weekly grid, the cards and activities that fill it, phonics.
    //
    // Curriculum is NOT pinned alongside it, and that is a measurement, not a
    // preference: pinning it as a second row took the sidebar to 15 rows and
    // scripts/b255-render-probe.js failed on exactly the rule b255 exists to hold
    // ("the sidebar list still does not scroll"). So Curriculum keeps every route it
    // had except the pinned row — it is on the Curriculum group page (b255 asserts
    // that page still lists it), in Ctrl+K, and at /admin/curriculum. One click
    // became two for Curriculum; one click became one for Planning, which is the
    // screen staff open daily.
    // Same reversal as Staff, and the same symptom: `direct: 'planning'` sent the
    // sidebar row straight into one section, so the group's OTHER sections —
    // Curriculum itself, the trackers, Fledge mapping — were reachable only via
    // the chevron. Toby's report was "I can't see termly or weekly planning in
    // the curriculum section": the planning had not gone anywhere, it had moved
    // to its own Planning section in b276 and the row's shortcut hid the chooser
    // that would have shown him both. The row now opens the card grid.
    // Planning is pinned as well as listed. Toby, 2026-09-09: "you said you pushed
    // the planning to the portal but I can't see it". It was there — first card on
    // the Curriculum group page — but a card behind a row nobody thinks to open is
    // not findable, and Termly/Weekly are where staff actually work. Its own row
    // makes it one click, and it stays in `sections` so the group page still lists it.
    'Curriculum':        { icon: '📚', blurb: 'Planning first — then the framework, trackers and the rest of the curriculum.',
                           pinned: ['planning', 'framework-tracker'] },
    'Comms':             { icon: '💬', blurb: 'Talking to parents, and the places they talk back.' },
    'Operations':        { icon: '🔧', blurb: 'Running the building, and proving it was run well.' },
    'AI & Intelligence': { icon: '📡', blurb: 'Wren doing the reading, watching and joining-up for you.' },
    'Help & Training':   { icon: '🗺️', blurb: 'How Wren works, for staff learning it.' },
    'More':              { icon: '📦', blurb: 'Sections not yet placed in a group.' },
  };
  // One short line per section, saying what the page is FOR. Written from the pages
  // themselves (their own headings, intros and tab bars) — not invented.
  const SECTION_BLURB = {
    // Home
    cockpit:            'Your daily landing screen — attention, the management board, nursery health and what is coming up.',
    attention:          'One board of everything waiting on you, built from live system state rather than a list you maintain.',
    'quick-actions':    'Bring a child or a member of staff in, or close them off — without hunting through a long form.',
    notifications:      'Every alert by category, plus the on/off matrix and this device’s push settings.',
    'my-morning':       'What every practitioner is behind on this morning — termly updates, two-year checks, parent replies, observations, tracking, phonics, activities and planning, on one screen.',
    // Children
    children:           'The child list, each child’s profile and their reports.',
    family:             'Events and RSVPs, parent-reported absences, consents and requests.',
    'action-plans':     'Improvement plans for management, each room, and the ones shared with parents.',
    'next-steps':       'Next steps per child — pending, completed, overdue, and gaps Wren suggests.',
    'visual-schedules': 'Build now/next boards and visual routines from a symbol library, and reuse saved ones.',
    safeguarding:       'Active concerns, the manager sign-off queue, the log and the audit trail.',
    'sen-flags':        'Patterns Wren noticed in a child’s own records, for a SENCO to review. Decision support, never a diagnosis.',
    'sen-register':     'Diagnosed and monitoring children, SMART targets, APDR cycles and Play Plans.',
    'sen-toolkit':      'The strategy library by area of need — what it is, how to do it, what to look for. Curate what the setting offers.',
    observations:       'Every observation in the setting — filter by child, type, EYFS area or date, then read and edit it.',
    // Staff
    staff:              'Profiles, rota, calendar, supervisions, training, documents and performance.',
    leave:              'Who is off, the team calendar, and every allowance in hours \u2014 5.6 weeks of each person\u2019s own contracted hours, with bank holidays that fall on their working days deducted automatically. Also the set-up and the opening-balance import for the switch off BrightHR.',
    'leave-person':     'One person\u2019s leave: the allowance and the workings behind it, a ledger of every hour that has come off it, their working pattern, and their sickness.',
    absences:           'The absence calendar, who is off today, and the requests waiting for a decision.',
    rota:               'Build and publish the rota, claim open shifts, and check ratio cover.',
    payroll:            'Generate a payroll run from hours worked, review past runs and edit the templates.',
    recruitment:        'Vacancies, applicant pipeline and hiring. Applicant data is manager-only.',
    'induction-oversight': 'Assign the 4-week induction workbook, track progress and manage probation check-ins.',
    apprenticeships:    'Off-the-job training hours logged as they happen, the target from the standard, and the under-18 working limits.',
    cpd:                'Training academy, the half-term deep-dive programme, always-on knowledge checks, and CPD records with expiry dates.',
    'ealing-cpd':       'Courses Ealing Council are running, read from their training emails. Staff ask to attend; you see the staffing position on those dates and answer.',
    review:             'Work waiting on a manager — pending items, recorded decisions and observations to review.',
    'staff-celebrations': 'Birthdays, work anniversaries, Christmas and Eid — cards, vouchers and flowers.',
    'single-central-record': 'The inspector-ready Single Central Record and unified compliance expiry.',
    permissions:        'Who is allowed to do what — the capability matrix and per-staff overrides.',
    // b366
    'absence-warnings': 'Bradford Factor and timekeeping triggers, with thresholds you set. When somebody crosses one Wren drafts the letter and tells you — they are told nothing until you approve it.',
    // b362
    'staff-pins':       'Every active member of staff, whether they have a login PIN and when it was last set — set, reset or remove one without opening their profile.',
    'lookback':         'The inset-day report: how the children have been progressing over one to five years — how long next steps take, what the framework tracker shows, whether new children are settling, and observation volume and quality. Presenter mode for the projector, and a slide pack to export. No child is ever named and any group under five is suppressed.',
    'clockin-fobs':     'Registered NFC fobs, who holds each one, and the readers they tap on. Opens on Fob Management.',
    'login-health':     'Can everyone actually sign in on Monday? Every member of staff and every parent login: PIN, email, Cloudflare list, authenticator app, lockouts — and what is missing.',
    'security-hub':     'One page for the building: cameras, the front door, fobs, clock-in patterns, out-of-hours alerts and the heating and lights. Every figure comes from the page that owns it.',
    'building-devices': 'Every radiator valve, thermometer, smart plug, button and sensor in the building, room by room, with a green/amber/red light and plain words for what is wrong. Add a device with a step-by-step wizard, rename one, move it to another room, or work through the re-pair checklist.',
    // Admissions
    admissions:         'Enquiry through to registered — occupancy, the pipeline board and the offer engine.',
    'occupancy-sandbox': 'Model what-if rosters and watch occupancy and Ofsted ratios update live.',
    'occupancy-planner': 'Layer changes on top of real enrolment and save them as a forecast scenario.',
    // Finance
    accounts:           'One money home: payroll from Paycheck, fee runs, the bank, Ealing funding expected against received, and auto-allocate.',
    money:              'Invoices, payments, reconciliation, funding and family statements — EyMan-shaped.',
    'funding-manager':  'Funding terms, child allocations, the council portal, declarations and the Census, in one place.',
    finance:            'Dashboard, invoices, payments, funding, wages and reconciliation.',
    'finance-reports':  'Reports you run, print and send on — income, aged debtors, chase list, payments, funding.',
    'finance-hmrc':     'Tax and filing deadlines with reminders, and the termly money report — over reconciled months only.',
    'fee-schedule':     'Statutory itemised billing — fee items, funding rates and parent opt-outs.',
    'fee-sandbox':      'Model next year\'s fee structure and see the year\'s totals — a sandbox that changes no live fee.',
    'stretch-recon':    'Funded-hour evidence for leavers: entitlement vs delivered vs claimable vs claimed.',
    // Curriculum
    // b276 — planning moved out of Curriculum into its own section; both blurbs
    // rewritten so neither promises what it no longer holds.
    planning:           'The setting’s plan: the termly theme, the weekly grid it fills, and the resource cards, activities and phonics it is built from.',
    curriculum:         'The framework, next steps, areas of responsibility, events, trips, the calendar, the timetable — and the observation reviewer, where you filter observations and export them as a PDF.',
    'events-calendar':  'One calendar in three layers — the nursery\u2019s own, what families see, and the managers\u2019 — with the weekly planning on it, the iCal feeds and Send to Pippin.',
    'framework-tracker': 'Every child against a whole framework — area, aspect and age band, the same shape as EyLog’s tracker.',
    'phonics-tracker':  'The sounds each child is confident in. Only children whose phonics switch is on appear.',
    'fledge-mapping':   'DRAFT: Fledge framework mapping. Publishes nothing.',
    // Comms
    communications:     'The unified inbox, parent messaging, newsletters, Aria calls, surveys and permission slips.',
    'staff-notices':    'The running list of things staff need told, and the staff newsletter it drafts itself into.',
    'wren-updates':     'How Wren has changed lately — what is live, what is coming, and who has read it.',
    'community-moderation': 'Room groups and parent-created groups — every post non-anonymous, moderated here.',
    'website-builder':  'The drag-and-drop editor for the nursery’s public website.',
    'site-analytics':   'Who is finding getwren.co.uk and the phonics app — visitors, the pages and files they read, where they came from, how often a link gets shared, and how much of the traffic is robots. Counted from the web server’s own log, with no cookies.',
    'parent-app-feedback': 'Triage the like / change / idea / bug notes parents send from inside the app.',
    'staff-recognition': 'Parent thank-yous awaiting review, and how they feed each profile once released.',
    'parent-voice':      'Anonymous parent feedback, the question board (both sides anonymous), and testimonial approval.',
    // Operations
    operations:         'Kitchen and menus, repairs, resources, clock in/out, compliance and health & safety.',
    repairs:            'Report a fault and follow it to done — the same list as Operations \u2192 Repairs, found under the words staff actually search for.',
    'setting-incidents': 'Significant events at the setting — fire, intruder, lost child, outbreak — and Ofsted notification.',
    inspection:         'Inspection Mode — action items, staff briefing packs, gap analysis and evidence.',
    'report-card':      'How inspection-ready this setting looks on the records it already holds, and what to fix first.',
    'inspection-toolkit': 'Every EYFS judgement area, what an inspector looks for, what Wren already knows, and space for your own answer. The self-evaluation.', // b356

    checklist:          'The monthly checklist of routine management jobs.',
    cameras:            'The door camera live, what it recorded on a chosen day, and the log of every request to view either — granted or refused.',   // b362
    'room-headcounts':  'Scheduled headcounts, live ratio-compliance verdicts and the audit trail.',
    paperwork:          'Every scan the setting holds — drop a folder in, Wren reads it and proposes where it goes. Searchable inside the scans.',  // b269
    'reading-room':     'Every analysis, audit, research report and decision note — tick Read, Discussed, Decided and Done as you go. Decisions are written to the register.', // b352
    library:            'Policies, the handbook, courses, study modules and uploaded paperwork — one catalogue, browsable by area. New uploads wait in Needs review until an area and audience are set.', // b425
    'supplier-register':'Who we buy from and what recurs: what each is for, what it costs, who could cancel it, what would stop the nursery if it lapsed, and payments no one has registered.', // b352
    'reports-builder':  'Pick the fields (parent names, emails, emergency contacts…) and see what is missing. Save a report, export it as CSV, print it.', // b342
    duties:             'When the last report was done, forms signed, checks made — child, room, staff and setting duties on one grid instead of a stream of notifications.', // b334
    pathways:           'A child we have concerns about, from the first concern to a leaving summary — the stages, who owns each one, and what is overdue.', // b335
    // AI & Intelligence
    intelligence:       'Automation workflows, deep search across the nursery, and AI chat.',
    assistant:          'Wren AI — chat over your own records, on the nursery’s own model, with upload and voice.',
    'away-assistant':   'When Toby’s away — ask what to do, or how to do it in Wren. The Managers Bible, the manual, the policies, the handbook and Wren’s own guides, with six modes and who decides.',
    'wren-chat':        'Wren Chat — a fast chat that knows Wren and the nursery’s numbers, with voice and conversation mode. Counts and manuals only: it never sees a child’s record.', // b348
    'competitor-intel': 'Local nursery pricing, Ofsted and reputation from public data, compared against us.',
    automations:        'Automation recipes, and what is currently running.',
    // Help & Training
    'how-wren-works':   'A visual tour of the system behind your nursery — for staff self-training.',
    'managers-guide':   "Everything a manager needs to know about running Wren day to day, with screenshots.", // b396
    'staff-guide':      'How to sign in, clock in, and use the room tablet and staff app — for every member of staff.', // b396
    // Not in the sidebar (NAV_SIDEBAR_HIDDEN) but blurbed anyway, so a saved layout
    // that does place one of these still gets a described card.
    system:             'Settings, integrations, backups, security, docs, audit log and support.',
    'data-governance':  'Retention schedule, records map, the leavers’ archive on its four clocks, off-site archives and data-subject requests.',
    'cf-access':        'The Cloudflare access list — who can reach which portal.',
    'parent-enrolment': 'Wren’s own identity provider: which parents have enrolled.',
    access:             'Approve staff access requests and give enquiring families early Parents-portal access.',
    'nav-settings':     'Reorder the sidebar — for you, or for everyone in the setting.',
    'term-dates':       'The teaching half-terms and the breaks between them. What planning counts weeks against. NOT the funding periods.',
    'funding-dates':    'The three funding periods a year and the rates per band. What the council pays. NOT the teaching half-terms.',
    'notification-settings': 'The notification matrix and registered devices, as a standalone page.',
    'termly-plan':      'The half-term plan: theme, provision and activities per room, with an end-of-term evaluation.',
    'resource-cards':   'Printable activity and provision cards.',
    'fledge-framework': 'Wren’s open Early Years curriculum framework.',
    'framework-builder': 'Build this setting’s own curriculum framework.',
    'phonics-library':  'Decodable stories and phonics games.',
    'staff-knowledge':  'Always-on staff knowledge checks and the safeguarding-CPD dashboard.',
  };

  // Layout precedence, most specific first (2026-08-20):
  //   1. window.WREN_NAV_GROUPS      — build/edition override
  //   2. localStorage wrenNavGroups  — this person's personal tweak, this browser only
  //   3. _SETTING_NAV_GROUPS         — THE SETTING'S layout from /api/nav-layout (everyone)
  //   4. DEFAULT_NAV_GROUPS          — what Wren ships with
  // Layer 3 is fetched once before the shell renders (see _loadSettingNav below); until
  // it lands the default is used, so a slow or failed fetch degrades to a working sidebar
  // rather than an empty one.
  let _SETTING_NAV_GROUPS = null;
  function _resolveNavGroups() {
    if (window.WREN_NAV_GROUPS) return window.WREN_NAV_GROUPS;
    try { const sv = JSON.parse(localStorage.getItem('wrenNavGroups') || 'null'); if (Array.isArray(sv) && sv.length) return sv; } catch (e) { /* fall through */ }
    if (Array.isArray(_SETTING_NAV_GROUPS) && _SETTING_NAV_GROUPS.length) return _SETTING_NAV_GROUPS;
    return DEFAULT_NAV_GROUPS;
  }
  // Fetch the setting-wide layout. Never throws and never blocks boot for long — on any
  // failure the shell just carries on with the default.
  /* b306 — every hand-rolled fetch in this file used to send Authorization and
     nothing else. Wren.api() adds X-Wren-Device; these did not, so under device
     enforcement they 403 and each one ends in a bare .catch(){} — the nav
     layout, the away banner and the attention board would simply stop loading
     and say nothing. Dormant only because the enforcement toggles are off.
     Found by the b280 usage simulation. */
  function shellHeaders(token, extra) {
    var device = '';
    try { device = localStorage.getItem('wrenDevice') || ''; } catch (e) { device = ''; }
    var h = Object.assign({ Authorization: 'Bearer ' + token }, extra || {});
    if (device) h['X-Wren-Device'] = device;
    return h;
  }

  function _loadSettingNav() {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) return Promise.resolve();
    return fetch('/api/nav-layout', { headers: shellHeaders(token) })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d && Array.isArray(d.groups) && d.groups.length) _SETTING_NAV_GROUPS = d.groups; })
      .catch(() => { /* default is fine */ });
  }

  // ── b242 (2026-08-28): the role x page overrides, layered on top ────────────
  // /api/nav-layout/resolved returns THIS user's effective rows — the server has
  // already collapsed "edition + role" over "edition + '*'", so the client applies
  // one flat map: { section_id: { group_label, sort_order, hidden } }.
  //
  // Absence of a row means "use the shipped default", so an untouched install has
  // an empty map here and `_applyNavOverrides` returns its input unchanged. That is
  // what makes a fresh edition render byte-identically to today.
  //
  // PRESENTATION ONLY. `hidden` removes a row from the sidebar and from its group
  // page; it does NOT gate the section. Wren.navigate(), the /admin/<section> URL
  // and the Ctrl+K index all still reach it — the capability matrix (b237) decides
  // whether the API then answers, and nothing here touches that.
  let _NAV_OVERRIDES = {};
  // Sections this layout has HIDDEN. _buildShell sweeps anything ungrouped into a
  // "More" group so a stale layout can never strand a page — but a page that was
  // deliberately hidden is not stranded, it is hidden, and sweeping it into "More"
  // would undo every hide. Populated by _applyNavOverrides, consulted there.
  const _navHiddenIds = new Set();
  // Sections the owner has explicitly UN-hidden. NAV_SIDEBAR_HIDDEN is a shipped
  // opinion about what clutters the sidebar; an explicit row that says hidden=false
  // is a newer, more specific instruction, so it wins. Consulted in _buildShell.
  const _navForcedVisible = new Set();

  function _loadNavOverrides() {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) return Promise.resolve();
    return fetch('/api/nav-layout/resolved?edition=' + encodeURIComponent(EDITION), {
      headers: shellHeaders(token) })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d || !d.sections || typeof d.sections !== 'object') return;
        _NAV_OVERRIDES = d.sections;
        Object.keys(_NAV_OVERRIDES).forEach(id => {
          if (_NAV_OVERRIDES[id] && _NAV_OVERRIDES[id].hidden === false) _navForcedVisible.add(id);
        });
      })
      .catch(() => { /* no overrides — the shipped default is correct */ });
  }

  // Fold the overrides into a [{label, sections}] layout. Pure: same input, same
  // output, no DOM. Returns `groups` unchanged when there is nothing to apply.
  function _applyNavOverrides(groups) {
    const ov = _NAV_OVERRIDES;
    _navHiddenIds.clear();
    if (!ov || !Object.keys(ov).length) return groups;
    Object.keys(ov).forEach(id => { if (ov[id] && ov[id].hidden === true) _navHiddenIds.add(id); });

    // Base position of every section, so an entry with no sort_order keeps exactly
    // the place it has today rather than jumping to the top.
    const baseIdx = {};
    const baseLabel = {};
    const order = [];                       // group labels, in the order they appear
    groups.forEach(g => {
      if (order.indexOf(g.label) === -1) order.push(g.label);
      (g.sections || []).forEach((id, i) => {
        if (!(id in baseIdx)) { baseIdx[id] = order.length * 1000 + i; baseLabel[id] = g.label; }
      });
    });

    // Every section the layout should contain: the base ones, plus any the owner has
    // explicitly placed (which is how a NAV_SIDEBAR_HIDDEN section gets surfaced).
    const ids = Object.keys(baseIdx);
    Object.keys(ov).forEach(id => {
      if (!(id in baseIdx) && SECTIONS[id] && ov[id] && ov[id].hidden === false) {
        baseIdx[id] = 1e9;                  // unplaced → after everything, unless sorted
        baseLabel[id] = (ov[id].group_label || 'More');
        ids.push(id);
      }
    });

    const buckets = {};
    ids.forEach(id => {
      const o = ov[id] || {};
      if (o.hidden === true) return;        // hidden: not in the sidebar, still routable
      const label = (o.group_label && String(o.group_label).trim()) || baseLabel[id];
      if (!label) return;
      if (order.indexOf(label) === -1) order.push(label);   // a group the owner invented
      (buckets[label] || (buckets[label] = [])).push({ id, sort: o.sort_order, base: baseIdx[id] });
    });

    const out = order.map(label => {
      const items = (buckets[label] || []).slice().sort((a, b) => {
        const as = (a.sort == null) ? Infinity : Number(a.sort);
        const bs = (b.sort == null) ? Infinity : Number(b.sort);
        if (as !== bs) return as - bs;
        return a.base - b.base;             // stable: unsorted entries hold their place
      });
      return { label, sections: items.map(i => i.id) };
    }).filter(g => g.sections.length);

    // The brief's hard rule: "A layout that hides everything must still leave the
    // user a way back — never render an empty sidebar." If a layout resolves to
    // nothing at all, it is broken, so ignore it rather than stranding the user.
    if (!out.length) return groups;
    return out;
  }

  // ── b242: the same overrides, applied to the MPA portals (EY / HR / demos) ──
  // Those sidebars come from NAV_MPA, which is a flat list of {icon,label,href} plus
  // {icon,label,children:[...]} groups — there are no SECTIONS ids to key on. So a
  // stable key is DERIVED from the href (the one thing that identifies a nav item
  // across renames): '/my-absences.html' -> 'p-my-absences'. A `children` group,
  // which has no href, is keyed from its label instead.
  //
  // The brief said to wire these portals to the same table rather than invent a
  // second mechanism, so hide / reorder / move-between-groups all work here too —
  // it is the same ladn.nav_layout row, just resolved against a different shape.
  const _mpaKey = item => {
    if (item && item.href) {
      return 'p-' + String(item.href).replace(/^\//, '').replace(/\.html$/i, '')
        .replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
    }
    return 'g-' + String((item && item.label) || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  };

  function _applyMpaOverrides(items) {
    const ov = _NAV_OVERRIDES;
    if (!ov || !Object.keys(ov).length || !Array.isArray(items) || !items.length) return items;
    const TOP = '\u0000top';
    // Flatten to (key, item, parent) so a child can be moved out of its group and a
    // top-level link can be moved into one.
    const flat = [];
    let n = 0;
    items.forEach(it => {
      flat.push({ key: _mpaKey(it), item: it, parent: TOP, base: n++, isGroup: !!it.children });
      if (it.children) it.children.forEach(c =>
        flat.push({ key: _mpaKey(c), item: c, parent: it.label, base: n++, isGroup: false }));
    });
    const groupLabels = new Set(items.filter(i => i.children).map(i => i.label));
    const hiddenGroups = new Set();
    const kept = [];
    flat.forEach(e => {
      const o = ov[e.key];
      if (o && o.hidden === true) { if (e.isGroup) hiddenGroups.add(e.item.label); return; }
      let parent = e.parent;
      if (o && o.group_label != null && String(o.group_label).trim()) {
        const want = String(o.group_label).trim();
        // Only a real group on THIS portal can be a parent; anything else means
        // "top level", so a layout copied from another edition degrades to a flat
        // list rather than silently swallowing the item.
        parent = groupLabels.has(want) ? want : TOP;
      }
      kept.push({ ...e, parent, sort: (o && o.sort_order != null) ? Number(o.sort_order) : null });
    });
    // A hidden group must not strand its children — they come up to the top level.
    kept.forEach(e => { if (e.parent !== TOP && hiddenGroups.has(e.parent)) e.parent = TOP; });

    const bySort = (a, b) => {
      const as = a.sort == null ? Infinity : a.sort;
      const bs = b.sort == null ? Infinity : b.sort;
      return as !== bs ? as - bs : a.base - b.base;     // stable: unsorted hold their place
    };
    const out = kept.filter(e => e.parent === TOP).sort(bySort).map(e => {
      if (!e.isGroup) return e.item;
      const children = kept.filter(c => c.parent === e.item.label).sort(bySort).map(c => c.item);
      // A group emptied by hiding every child would render as a dead chevron.
      if (!children.length) return null;
      return Object.assign({}, e.item, { children });
    }).filter(Boolean);

    // Never render an empty sidebar — a layout that hides everything is broken, so
    // ignore it rather than stranding the user with no way back.
    return out.length ? out : items;
  }

  // b241 — the resolved layout, decorated with a URL slug and its chrome. Slugs are
  // derived from the label and de-duplicated (a saved layout may well contain two
  // groups called the same thing), so /admin/group/<slug> always names exactly one.
  // b242 — the per-role overrides are folded in first, so the sidebar, the group
  // pages and the Ctrl+K index all read one resolved layout.
  function _navGroupList() {
    const seen = new Set();
    return _applyNavOverrides(_resolveNavGroups()).map(g => {
      const meta = NAV_GROUP_META[g.label] || {};
      let slug = _grpSlugify(g.label), n = 2;
      while (seen.has(slug)) slug = _grpSlugify(g.label) + '-' + n++;
      seen.add(slug);
      const sections = Array.isArray(g.sections) ? g.sections : [];
      return {
        label: g.label,
        slug,
        icon: meta.icon || '📂',
        blurb: meta.blurb || '',
        // A `direct` / `pinned` section the layout has moved out of this group (or
        // hidden) must not be advertised here — filter both against what the group
        // actually holds, so a customised layout can never point at a missing row.
        direct: (meta.direct && sections.indexOf(meta.direct) !== -1) ? meta.direct : null,
        pinned: (meta.pinned || []).filter(id => sections.indexOf(id) !== -1),
        sections,
      };
    });
  }

  // ── Default landing section ────────────────────────────────────────────────────
  // Cockpit is the admin home (Prompt 34, 2026-06-30). It's manager-only, so a non-manager
  // admin role falls back to the always-available Dashboard rather than dead-ending.
  const MGR_ROLES = ['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager'];
  // ── b521 — tab-level feature switches ────────────────────────────────────────
  // `module_<sectionId>` (below, from /api/features/public) switches a whole
  // SECTION off. There was no equivalent for a single TAB, so switching one off
  // meant deleting its markup — which absolute rule 3 forbids, and which throws the
  // data away with the nav entry.
  //
  // This is that missing switch: '<section>:<tab>' -> the feature_flags key that
  // governs it. A key that is absent, or true, leaves the tab exactly as it was —
  // FAIL-OPEN, like every other nav gate here. Only an explicit `false` hides it,
  // from the tab bar, from the deep link and from Ctrl+K. Nothing is deleted and
  // the data behind the tab is untouched.
  //
  // staff:staff-voice — Toby, 2026-10-20: "let's also remove the strengths and
  // voice from staff on Roost ... I just doubt staff will use it, and we've still
  // got supervisions and there are the performance reports." Flag `staff_voice`.
  const TAB_FEATURE = {
    'staff:staff-voice': 'staff_voice',
  };
  // fledge-off (2026-10-26): the two Fledge sections answer to the ONE Fledge switch
  // (ladn.settings.fledge_enabled). FAIL CLOSED, unlike the module flags: until the
  // server says Fledge is on they are not drawn. Their sidebar rows and cards carry
  // data-fledge, so they reappear without a reload the moment the answer is "on";
  // nothing is removed from SECTIONS or from any saved layout.
  const FLEDGE_SECTIONS = new Set(['fledge-framework', 'fledge-mapping']);
  const _fledgeOn = () => !!(window.WrenFledge && window.WrenFledge.enabled()) ||
    !!(_modFlags && _modFlags.fledge_enabled === true);
  const _fledgeAttr = id => (FLEDGE_SECTIONS.has(id) ? ' data-fledge' : '');
  // null = flags not fetched yet (fail open); otherwise the /api/features/public map.
  function _tabEnabled(sectionId, tabId) {
    const key = TAB_FEATURE[sectionId + ':' + tabId];
    if (!key) return true;
    if (!_modFlags) return true;                 // not loaded yet — show it
    return _modFlags[key] !== false;
  }
  // Resolve the flags once, shared by the sidebar, the group pages and the tab bars.
  let _modFlagsPromise = null;
  function _loadModFlags() {
    if (_modFlagsPromise) return _modFlagsPromise;
    _modFlagsPromise = (async () => {
      const CK = 'wrenModulesV2';
      try {
        const c = JSON.parse(sessionStorage.getItem(CK) || 'null');
        if (c && Date.now() - c.ts < 5 * 60 * 1000) { _modFlags = c.data; return _modFlags; }
      } catch (e) { /* ignore cache errors */ }
      try {
        const flags = await Wren.api('/api/features/public');
        if (flags && typeof flags === 'object') {
          _modFlags = flags;
          try { sessionStorage.setItem(CK, JSON.stringify({ ts: Date.now(), data: flags })); } catch (e) {}
        }
      } catch (e) { /* fail open — _modFlags stays null */ }
      return _modFlags;
    })();
    return _modFlagsPromise;
  }

  function _landingSection() {
    const role = (window.Wren && Wren.user && Wren.user.role) || '';
    return (MGR_ROLES.includes(role) && SECTIONS.cockpit) ? 'cockpit' : 'staff';
  }

  // ── Session timers ────────────────────────────────────────────────────────────
  let sessionTimer, sessionWarnTimer;
  let _loadSection;     // hoisted; assigned in buildShellSPA
  let _renderGroupPage; // b241 — hoisted; assigned in buildShellSPA
  // b241 — the two runtime nav gates, cached so the group pages apply exactly the
  // same rules as the sidebar. Both are fail-open: null / empty means "show it".
  let _modFlags = null;            // /api/features/public — module_<id> === false hides
  const _capDenied = new Set();    // section ids /api/permissions/me says this person lacks


  // ── device_required — make the silent 403 impossible to miss ─────────────────
  // The EY portal gates the WHOLE /api prefix on an enrolment token
  // (server-unified.js `app.use('/api', _deviceGate(...))`). Until 2026-09-04
  // nothing in the frontend looked at that 403, so a tablet whose token had been
  // cleared just... stopped working: pages rendered empty, diary entries looked
  // saved and were not, photos vanished after upload. Five tablets sat like that
  // for five weeks and it was reported as "diaries not saving".
  // A save that is not happening must never look like a save that happened.
  function wrenShowDeviceBlocked() {
    if (document.getElementById('wren-device-blocked')) return;   // once per page
    var bar = document.createElement('div');
    bar.id = 'wren-device-blocked';
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
      'background:#b91c1c;color:#fff;padding:14px 18px;font:600 15px/1.45 system-ui,sans-serif;' +
      'box-shadow:0 2px 12px rgba(0,0,0,.35);display:flex;gap:14px;align-items:center;' +
      'flex-wrap:wrap;justify-content:center;text-align:center';
    bar.innerHTML =
      '<span>⚠️ This device is not set up for Wren — <u>nothing you save here is being kept</u>.</span>' +
      '<a href="/ey/enrol-device" style="background:#fff;color:#b91c1c;padding:7px 14px;' +
      'border-radius:8px;text-decoration:none;font-weight:700;white-space:nowrap">Set this device up</a>' +
      '<span style="font-weight:400;opacity:.9">A manager or deputy needs to sign in on this device.</span>';
    (document.body || document.documentElement).appendChild(bar);
    try {
      var pad = parseInt(getComputedStyle(document.body).paddingTop, 10) || 0;
      document.body.style.paddingTop = (pad + bar.offsetHeight) + 'px';
    } catch (_) { /* styling only */ }
  }

  // ── totp_required — make the mid-setup 403 flood impossible to miss ──────────
  // weeklybugs-20261030: a 'totp_only' / 'totp_enroll_required' token (server-unified.js's
  // two-factor scope gate, b491) refuses everything except /api/auth/*, so the shell's own
  // background widgets (notifications, messages, nav-layout, mylist, …) all 403 the moment
  // someone is mid-2FA-setup — reported as "button does nothing" / "nothing loads" on
  // ey/more, admin/cockpit/mylist and the HR dashboard (log-watch filed 20+ of these as
  // separate bugs on 2026-10-26..29; see wren-docs memory reference_logwatch_403s_view_as_and_totp).
  // The gate is correct; the frontend just never said why. Same "once per page" guard as
  // wrenShowDeviceBlocked — one banner, not one per failed widget.
  function wrenShowTotpRequired(d) {
    if (document.getElementById('wren-totp-required')) return;
    var bar = document.createElement('div');
    bar.id = 'wren-totp-required';
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
      'background:#b45309;color:#fff;padding:14px 18px;font:600 15px/1.45 system-ui,sans-serif;' +
      'box-shadow:0 2px 12px rgba(0,0,0,.35);display:flex;gap:14px;align-items:center;' +
      'flex-wrap:wrap;justify-content:center;text-align:center';
    bar.innerHTML =
      '<span>' + ((d && d.message) || 'Finish two-factor sign-in before continuing.') + '</span>' +
      '<a href="/totp-setup.html" style="background:#fff;color:#b45309;padding:7px 14px;' +
      'border-radius:8px;text-decoration:none;font-weight:700;white-space:nowrap">Finish set-up</a>';
    (document.body || document.documentElement).appendChild(bar);
    try {
      var pad = parseInt(getComputedStyle(document.body).paddingTop, 10) || 0;
      document.body.style.paddingTop = (pad + bar.offsetHeight) + 'px';
    } catch (_) { /* styling only */ }
  }

  // ── Roost refused this person (roost_restricted) — 2026-10-06 ──────────────────
  // This used to be a silent bounce to ey.example-nursery.co.uk. On the 4-portal
  // demo editions (htps, childrenscorner) that dropped a refused member of staff
  // into the LADN production portal: the wrong setting. The 403 now carries this
  // setting's own portals (src/lib/roost-redirect.js); this says why, and lets
  // them choose. Token-only colours; it loads the tokens itself on a page that
  // has none.
  function wrenRoostPortals(d) {
    var r = (d && d.redirect) || {};
    if (r.ey || r.hr) return r;
    // No hint (LADN's own Gate 2 sends none). Off getwren.co.uk that is LADN, so
    // keep its portals as before; a getwren-hosted setting gets no link rather
    // than another setting's.
    if (/(^|\.)getwren\.co\.uk$/.test(location.hostname)) return {};
    return { ey: 'https://ey.example-nursery.co.uk/', hr: 'https://hr.example-nursery.co.uk/' };
  }
  function wrenShowRoostRestricted(d) {
    if (document.getElementById('wren-roost-restricted')) return;   // once: a dashboard fires many calls
    try {
      if (!getComputedStyle(document.documentElement).getPropertyValue('--c-text').trim()) {
        var tl = document.createElement('link'); tl.rel = 'stylesheet'; tl.href = '/css/wren-tokens.css';
        document.head.appendChild(tl);
      }
    } catch (_) { /* styling only */ }
    var p = wrenRoostPortals(d);
    var ok = function (u) { return typeof u === 'string' && /^https?:\/\//i.test(u); };
    var hasWay = ok(p.ey) || ok(p.hr);
    var wrap = document.createElement('div');
    wrap.id = 'wren-roost-restricted';
    wrap.setAttribute('role', 'alertdialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'wren-roost-restricted-title');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;' +
      'justify-content:center;padding:16px;box-sizing:border-box;' +
      'background:color-mix(in srgb, var(--c-bg) 90%, transparent);font:15px/1.5 system-ui,sans-serif';
    var card = document.createElement('div');
    card.style.cssText = 'max-width:420px;width:100%;box-sizing:border-box;background:var(--c-surface-solid);' +
      'color:var(--c-text);border:1px solid var(--c-border);border-top:4px solid var(--c-danger);' +
      'border-radius:12px;padding:22px;text-align:center';
    var h = document.createElement('h2');
    h.id = 'wren-roost-restricted-title';
    h.style.cssText = 'margin:0 0 8px;font-size:1.1rem;color:var(--c-text)';
    h.textContent = 'Roost is restricted to authorised managers';
    var msg = document.createElement('p');
    msg.style.cssText = 'margin:0 0 18px;color:var(--c-muted);font-size:.9rem';
    msg.textContent = 'Your sign-in worked, but your account is not on this setting’s Roost list. ' +
      (hasWay ? 'Use your usual portal instead, or ask the owner to add you.' : 'Ask the owner to add you.');
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:center;flex-wrap:wrap';
    var btn = function (label, href, primary) {
      var a = document.createElement('a');
      a.href = href; a.textContent = label;
      // Whichever way out they take, this Roost session is finished.
      a.addEventListener('click', function () { sessionStorage.removeItem(TOKEN_KEY); });
      a.style.cssText = 'min-height:44px;display:inline-flex;align-items:center;padding:0 16px;' +
        'border-radius:12px;text-decoration:none;font-weight:700;' + (primary
          ? 'background:var(--c-blue);color:var(--c-on-blue);border:1px solid var(--c-blue)'
          : 'background:transparent;color:var(--c-text);border:1px solid var(--c-border-strong)');
      row.appendChild(a);
    };
    if (ok(p.ey)) btn('EY portal', p.ey, true);
    if (ok(p.hr)) btn('HR portal', p.hr, false);
    btn('Sign out', '/login.html', !hasWay);
    card.appendChild(h); card.appendChild(msg); card.appendChild(row); wrap.appendChild(card);
    (document.body || document.documentElement).appendChild(wrap);
  }

  // ── Wren public API ───────────────────────────────────────────────────────────
  window.Wren = {
    edition: EDITION,
    user: null,

    // b495 review F1 — same helper wren-core.js exposes, so a page or shared script that
    // calls Wren.authHeaders() works under this shell too (Roost SPA, /ey-legacy/*,
    // release-era EY pages still on shell-v2). Without it, wren-safeguarding-form.js
    // sent NO Authorization on Roost and repairs.html threw a TypeError.
    authHeaders(extra) {
      const token = sessionStorage.getItem(TOKEN_KEY);
      const deviceToken = localStorage.getItem('wrenDevice') || '';
      return Object.assign({},
        token ? { Authorization: `Bearer ${token}` } : {},
        deviceToken ? { 'X-Wren-Device': deviceToken } : {},
        extra || {});
    },

    api(url, opts = {}) {
      const token = sessionStorage.getItem(TOKEN_KEY);
      const deviceToken = localStorage.getItem('wrenDevice') || '';
      opts.headers = Object.assign({}, opts.headers, {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(deviceToken ? { 'X-Wren-Device': deviceToken } : {}),
      });
      if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
      return fetch(url, opts).then(r => {
        if (r.status === 401) { Wren.logout(); return; }
        if (r.status === 403) {
          return r.json().catch(() => ({})).then(d => {
            // b126 (2026-07-21): Roost person-allowlist gate. A valid, in-use
            // token just lost admin access (or never had it) — point them at the
            // portal it's still good for instead of leaving a dead dashboard.
            // 2026-10-06: a message with the way out, not a silent bounce (see
            // wrenShowRoostRestricted). The token is cleared when they pick a
            // way out, not here: clearing it now turns every call still in flight
            // into a 401, and Wren.logout() then whisks the message away.
            if (d && d.error === 'device_required') { wrenShowDeviceBlocked(); return Promise.reject(d); }
            if (d && d.error === 'totp_required') { wrenShowTotpRequired(d); return Promise.reject(d); }
            if (d && d.error === 'roost_restricted') {
              wrenShowRoostRestricted(d);
              return Promise.reject(d);
            }
            return Promise.reject(d);
          });
        }
        if (!r.ok) return r.json().then(d => Promise.reject(d));
        return r.json();
      });
    },

    // ── Wren.download — fetch an AUTHENTICATED file and hand it to the browser ──
    // 2026-09-22. Every "PDF" / "Export" / "Preview" button in Wren used to be
    // window.open('/api/…'), and a new window carries no Authorization header, so the
    // route answered {"error":"Unauthorised"} and the user saw that JSON instead of
    // their file. (Toby hit it on Keepsakes → PDF.) This fetches the file the same way
    // Wren.api fetches JSON — same token, same device header — then hands the browser a
    // blob to save. Use it for ANY /api/ URL that returns a file.
    //   Wren.download('/api/leavers-gift/packages/12/book.pdf', 'memory-book.pdf')
    // `filename` is optional: the server's Content-Disposition wins when it sends one.
    download(url, filename) {
      const token = sessionStorage.getItem(TOKEN_KEY);
      const deviceToken = localStorage.getItem('wrenDevice') || '';
      const headers = Object.assign({},
        token ? { Authorization: `Bearer ${token}` } : {},
        deviceToken ? { 'X-Wren-Device': deviceToken } : {});
      return fetch(url, { headers }).then(r => {
        if (r.status === 401) { Wren.logout(); return Promise.reject({ error: 'Unauthorised' }); }
        if (!r.ok) {
          return r.json().catch(() => ({ error: 'That file could not be produced (' + r.status + ').' }))
                  .then(d => Promise.reject(d));
        }
        // the server names the file when it can; `filename` is only the fallback
        let name = filename || 'download';
        const cd = r.headers.get('Content-Disposition') || '';
        const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
        if (m) { try { name = decodeURIComponent(m[1]); } catch (_) { name = m[1]; } }
        return r.blob().then(blob => {
          const href = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = href; a.download = name; a.rel = 'noopener';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(href), 30000);
          return { ok: true, filename: name, size: blob.size };
        });
      });
    },

    // ── Build number, for "what version are you on?" down the phone (2026-09-24) ──
    // Reports BOTH halves, because a cached tablet is exactly the fault this diagnoses: the
    // server says what the container runs, the client says what this browser actually loaded.
    // Showing one number and implying agreement would hide the problem.
    build() {
      const clientBuild = (document.currentScript && document.currentScript.src || '')
        .replace(/.*[?&]v=([^&]+).*/, '$1') || (window.__WREN_CLIENT_BUILD__ || 'unversioned');
      return Wren.api('/api/build').then(b => ({
        server: b.build, commit: b.commit, built_at: b.built_at,
        client: clientBuild,
        stale: !!(b.build && clientBuild && clientBuild !== 'unversioned' && !String(clientBuild).includes(String(b.build).slice(0, 8))),
      })).catch(() => ({ server: 'unreachable', client: clientBuild, stale: null }));
    },

    // ── Sidebar layout editor support (nav-settings.html) ──────────────────────
    getNavMeta() {
      return {
        sections: Object.values(SECTIONS).map(s => ({ id: s.id, label: s.label, icon: s.icon })),
        groups: _resolveNavGroups(),
        defaultGroups: DEFAULT_NAV_GROUPS,
      };
    },
    saveNavGroups(groups) {
      try { localStorage.setItem('wrenNavGroups', JSON.stringify(groups)); return true; } catch (e) { return false; }
    },
    resetNavGroups() { try { localStorage.removeItem('wrenNavGroups'); } catch (e) { /* ignore */ } },
    // Setting-wide layout (everyone in this nursery). Manager-level on the server.
    loadSettingNav() { return Wren.api('/api/nav-layout'); },
    saveSettingNav(groups) { return Wren.api('/api/nav-layout', { method: 'PUT', body: { groups } }); },
    resetSettingNav() { return Wren.api('/api/nav-layout', { method: 'DELETE' }); },
    hasPersonalNav() { try { return !!localStorage.getItem('wrenNavGroups'); } catch (e) { return false; } },

    // ── b242: the role x page matrix (Settings -> Navigation) ─────────────────
    // The SERVER stores only overrides; the shipped default lives here in the
    // shell. So the matrix screen has to ask the shell what the baseline is and
    // compose the two — that is what getNavMatrixMeta() is for.
    //
    // `sections` is EVERY entry in SECTIONS, including the ones NAV_SIDEBAR_HIDDEN
    // keeps out of the sidebar, because the brief asked for a row per page and the
    // owner may well want one of those back. `defaultGroups` carries `pinned` so
    // the screen can show which rows are promoted to the sidebar.
    // b242 — the editions the matrix screen can arrange. 'admin' is the SPA (Roost);
    // the rest come from NAV_MPA and are arranged as flat lists. The Parents portal
    // is deliberately absent: it does not load this shell at all (its own PWA nav
    // lives in editions/parents/public), so there is nothing here to wire — see
    // wren/logs/b242-nav-customiser.NOTES.md.
    navMatrixEditions() {
      const known = [{ key: 'admin', label: 'Roost (admin)', kind: 'spa' }];
      ['ladn', 'eyfs', 'hr', 'primary', 'secondary'].forEach(k => {
        if (NAV_MPA[k]) known.push({
          key: k, kind: 'mpa',
          label: { ladn: 'EY (LADN)', eyfs: 'EY (demo)', hr: 'HR (Seed)',
                   primary: 'Primary (demo)', secondary: 'Secondary (demo)' }[k] || k,
        });
      });
      // b273 — the EY tablet's More menu, if its declaration is loaded.
      if (window.WREN_EY_MORE_NAV) known.push({ key: 'ladn-more', kind: 'mpa', label: 'EY More menu (LADN)' });
      return known;
    },
    // roles.key -> the NAV_MPA list that role actually renders. Mirrors the roleAlias
    // logic in buildShellMPA, so the screen never offers a cell the portal ignores.
    navMpaRoleList(edition, roleKey) {
      const cfg = _navMpaCfg(edition);
      const alias = { manager: 'manager', deputy: 'manager', admin: 'manager',
                      headteacher: 'manager', 'business-manager': 'manager',
                      'room-leader': 'room_leader' }[roleKey] || roleKey;
      return cfg[alias] || cfg[roleKey] || cfg.practitioner || cfg.manager || [];
    },
    // The pages of an MPA portal, keyed exactly as _applyMpaOverrides keys them.
    navMpaSections(edition) {
      const cfg = _navMpaCfg(edition);
      const out = [];
      const seen = new Set();
      const push = (key, label, icon, group) => {
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ id: key, label, icon: icon || '•', defaultGroup: group, defaultHidden: false, managerOnly: false });
      };
      // Manager first: it is the richest list, so groups appear in their real order.
      const roleOrder = ['manager', 'room_leader', 'practitioner'].filter(r => cfg[r])
        .concat(Object.keys(cfg).filter(r => ['manager', 'room_leader', 'practitioner'].indexOf(r) === -1));
      roleOrder.forEach(r => (cfg[r] || []).forEach(it => {
        push(_mpaKey(it), it.label, it.icon, 'Top level');
        if (it.children) it.children.forEach(c => push(_mpaKey(c), c.label, '', it.label));
      }));
      const groups = ['Top level'];
      roleOrder.forEach(r => (cfg[r] || []).forEach(it => {
        if (it.children && groups.indexOf(it.label) === -1) groups.push(it.label);
      }));
      return { sections: out, groups };
    },
    getNavMatrixMeta() {
      const placed = new Set();
      DEFAULT_NAV_GROUPS.forEach(g => (g.sections || []).forEach(id => placed.add(id)));
      return {
        edition: EDITION,
        sections: Object.values(SECTIONS).map(s => ({
          id: s.id,
          label: s.label,
          icon: s.icon,
          // What the shipped default does with it, so the screen can say "default".
          defaultGroup: (DEFAULT_NAV_GROUPS.find(g => (g.sections || []).indexOf(s.id) !== -1) || {}).label || null,
          defaultHidden: NAV_SIDEBAR_HIDDEN.has(s.id) || !placed.has(s.id),
          managerOnly: s.requiresRole === 'manager',
        })),
        groups: DEFAULT_NAV_GROUPS.map(g => ({
          label: g.label,
          sections: (g.sections || []).slice(),
          pinned: ((NAV_GROUP_META[g.label] || {}).pinned || []).slice(),
        })),
        // The layout this browser is actually rendering right now, overrides applied.
        effective: _navGroupList().map(g => ({ label: g.label, slug: g.slug, sections: g.sections, pinned: g.pinned })),
      };
    },
    navMatrixRoles()            { return Wren.api('/api/nav-layout/roles'); },
    navMatrixLoad(edition)      { return Wren.api('/api/nav-layout/matrix?edition=' + encodeURIComponent(edition)); },
    navMatrixSaveCell(cell)     { return Wren.api('/api/nav-layout/cell',  { method: 'PUT', body: cell }); },
    navMatrixSaveCells(cells)   { return Wren.api('/api/nav-layout/cells', { method: 'PUT', body: { cells } }); },
    navMatrixClearCell(edition, role, sectionId) {
      return Wren.api('/api/nav-layout/cell?edition=' + encodeURIComponent(edition) +
        '&role=' + encodeURIComponent(role) + '&section_id=' + encodeURIComponent(sectionId), { method: 'DELETE' });
    },
    navMatrixReset(edition, role) {
      return Wren.api('/api/nav-layout/reset', { method: 'POST', body: { edition, role } });
    },

    toast(message, type = 'info', duration = 3500) {
      let container = document.getElementById('wren-toasts');
      if (!container) {
        container = document.createElement('div');
        container.id = 'wren-toasts';
        document.body.appendChild(container);
      }
      const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
      const toast = document.createElement('div');
      toast.className = `wren-toast wren-toast-${type}`;
      toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span>${message}</span>`;
      container.appendChild(toast);
      requestAnimationFrame(() => toast.classList.add('visible'));
      setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 300);
      }, duration);
    },

    modal(title, content, buttons = []) {
      document.querySelectorAll('.wren-modal-overlay').forEach(el => el.remove());
      const overlay = document.createElement('div');
      overlay.className = 'wren-modal-overlay';
      const btnHtml = buttons.map((b, i) =>
        `<button class="btn ${b.class || 'btn-ghost'}" data-idx="${i}">${b.label}</button>`
      ).join('');
      overlay.innerHTML = `
        <div class="wren-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <div class="modal-header">
            <span class="modal-title" id="modal-title">${title}</span>
            <button class="modal-close" aria-label="Close">✕</button>
          </div>
          <div class="modal-body">${typeof content === 'string' ? content : ''}</div>
          ${buttons.length ? `<div class="modal-footer">${btnHtml}</div>` : ''}
        </div>`;
      if (typeof content !== 'string') overlay.querySelector('.modal-body').appendChild(content);
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('open'));
      overlay.querySelector('.modal-close').onclick = () => { overlay.classList.remove('open'); setTimeout(() => overlay.remove(), 200); };
      overlay.addEventListener('click', e => { if (e.target === overlay) overlay.querySelector('.modal-close').click(); });
      buttons.forEach((b, i) => {
        overlay.querySelector(`[data-idx="${i}"]`).onclick = () => {
          if (b.action) b.action();
          if (b.close !== false) overlay.querySelector('.modal-close').click();
        };
      });
      return overlay;
    },

    logout() {
      sessionStorage.removeItem(TOKEN_KEY);
      // 29 Oct: never reload a sign-in page from itself. A background 401 there (nobody is
      // signed in yet) used to send the page round in a loop.
      if (/\/login(\.html)?$/.test(window.location.pathname)) return;
      window.location.href = '/login.html';
    },

    getToken() { return sessionStorage.getItem(TOKEN_KEY); },

    setToken(token) {
      sessionStorage.setItem(TOKEN_KEY, token);
      Wren._parseUser();
      Wren._resetSessionTimer();
    },

    _parseUser() {
      const token = sessionStorage.getItem(TOKEN_KEY);
      if (!token) return;
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        if (!payload || !payload.id) throw new Error('malformed');
        if (payload.exp && payload.exp * 1000 < Date.now()) throw new Error('expired');
        Wren.user = payload;
      } catch {
        sessionStorage.removeItem(TOKEN_KEY);
        if (!window.location.pathname.includes('login.html')) {
          window.location.replace(_loginUrl());
        }
      }
    },

    _resetSessionTimer() {
      clearTimeout(sessionTimer);
      clearTimeout(sessionWarnTimer);
      const warn = document.getElementById('wren-session-warning');
      if (warn) warn.hidden = true;
      sessionWarnTimer = setTimeout(() => {
        const w = document.getElementById('wren-session-warning');
        if (w) w.hidden = false;
      }, SESSION_WARN_MS);
      sessionTimer = setTimeout(() => {
        Wren.toast('Session expired — please sign in again', 'warning');
        Wren.logout();
      }, SESSION_TIMEOUT_MS);
    },

    navigate(section, tab) {
      if (!IS_ADMIN) {
        window.location.href = '/' + section + '.html';
        return;
      }
      // b241 — /admin/group/<slug> is a first-class route: the landing page for one
      // sidebar group, rendered as a card grid. Handled before the SECTIONS lookup
      // because 'group' is deliberately NOT a section (it must stay out of the
      // section registry, the search index and the module/role gates).
      if (section === GROUP_ROUTE) {
        const slug = tab || _navGroupList()[0]?.slug || 'home';
        const gurl = `${BASE}/${GROUP_ROUTE}/${slug}`;
        if (!document.getElementById('section-content')) { window.location.href = gurl; return; }
        if (window.location.pathname !== gurl) history.pushState({ section: GROUP_ROUTE, tab: slug }, '', gurl);
        if (typeof _renderGroupPage === 'function') _renderGroupPage(slug);
        return;
      }
      const def = SECTIONS[section];
      if (!def) { Wren.navigate(_landingSection(), null); return; }
      // b200: 26 sections are declared with `href:` — they are standalone pages,
      // not SPA fragments, and no /sections/<id>.html exists for them. Without
      // this guard, reaching one by URL (bookmark, Ctrl+K search, "Open →" link)
      // made the shell fetch a fragment that does not exist. Wren answers 200 +
      // the Admin Login page for any unknown path, so the login form was injected
      // into the section area. Send the user to the real page instead.
      if (def.href && !(def.tabs && def.tabs.length)) { window.location.href = def.href; return; }
      const resolvedTab = tab || def.tabs[0];
      const url = `${BASE}/${section}/${resolvedTab}`;
      // Legacy standalone page (chrome-only, no #section-content): full-navigate into the SPA
      // rather than pushState + _loadSection into a container that doesn't exist.
      if (!document.getElementById('section-content')) { window.location.href = url; return; }
      if (window.location.pathname !== url) {
        history.pushState({ section, tab: resolvedTab }, '', url);
      }
      _loadSection(section, resolvedTab);
    },

    openDrawer(content, title = '') { if (typeof _openDrawerFn === 'function') _openDrawerFn(content, title); },
    closeDrawer()                   { if (typeof _closeDrawerFn === 'function') _closeDrawerFn(); },
  };

  // drawer fn refs — assigned by whichever buildShell* runs
  let _openDrawerFn, _closeDrawerFn;

  // ── Route parsing (admin SPA) ─────────────────────────────────────────────────
  function _parseRoute() {
    const m = window.location.pathname.match(/^\/admin\/([^/?#]+)(?:\/([^/?#]+))?/);
    if (!m) return { section: _landingSection(), tab: null };
    return { section: m[1], tab: m[2] || null };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ── b237 (2026-08-27): the sidebar stops advertising what the API refuses ────
  // A section may declare `requiresCapability: 'kitchen.access'`. Because that
  // needs a round trip to /api/permissions/me, it is applied AFTER the sidebar is
  // rendered rather than filtering it up front — so a slow or failed call leaves
  // the sidebar exactly as it is today (hide-on-confirmation, never hide-on-error).
  // The API is still the real gate; this only stops staff walking into a 403.
  function _applyCapabilityNavGates() {
    const gated = Object.values(SECTIONS).filter(s => s.requiresCapability);
    if (!gated.length) return;
    Wren.api('/api/permissions/me').then(me => {
      if (!me) return;
      if (me.manager || Number(Wren.user && Wren.user.id) === 1) return;   // never lose access
      const held = new Set(me.capabilities || []);
      gated.forEach(s => {
        if (held.has(s.requiresCapability)) return;
        _capDenied.add(s.id);   // b241 — group-page cards read this too
        document
          .querySelectorAll(`#wren-sidebar [data-section="${s.id}"], #wren-sidebar a[href="${s.href}"], `
                          + `#section-content .v2-gp-card[data-section="${s.id}"]`)
          .forEach(btn => { const li = btn.closest('li'); if (li) li.hidden = true; });
      });
    }).catch(() => { /* leave the sidebar untouched */ });
  }

  // buildShellSPA — admin SPA shell (unchanged from original v2)
  // ─────────────────────────────────────────────────────────────────────────────
  function buildShellSPA() {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) { if (!window.location.pathname.includes('login')) window.location.replace(_loginUrl()); return; }

    Wren._parseUser();
    Wren._resetSessionTimer();
    const user = Wren.user;
    if (!user) return;

    const role  = user.role || 'practitioner';
    const isMgr = ['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager'].includes(role);
    // Home/landing section: Cockpit for managers (Prompt 34), Staff otherwise.
    const _home = isMgr ? 'cockpit' : 'staff';

    document.body.classList.add('v2-shell');
    try { if (/(^|\.)getwren\.co\.uk$/i.test(location.hostname)) document.body.classList.add('v2-demo'); } catch (e) {}

    // Distinguish the canonical admin SPA (app.html — served under /admin/* and shipping a
    // static #section-content) from the 65 legacy standalone .html pages that also load this
    // shell. On legacy pages we build chrome only; injecting an SPA section there rendered a
    // dashboard stacked on top of the page's own content (the double-render bug).
    const isSPA = !!document.getElementById('section-content') || /^\/admin(\/|$)/.test(window.location.pathname);

    const warnBar = document.createElement('div');
    warnBar.id = 'wren-session-warning';
    warnBar.hidden = true;
    warnBar.setAttribute('role', 'alert');
    warnBar.innerHTML = `⏱ Your session expires in 1&nbsp;minute. <a href="#" onclick="Wren._resetSessionTimer();this.closest('#wren-session-warning').hidden=true;return false">Stay signed in</a>`;
    document.body.appendChild(warnBar);

    const topbar = document.createElement('header');
    topbar.id = 'wren-topbar';
    topbar.setAttribute('role', 'banner');
    topbar.innerHTML = `
      <button id="wren-hamburger" class="topbar-icon-btn" aria-label="Toggle navigation" aria-expanded="false" aria-controls="wren-sidebar">
        <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
      </button>
      <a href="${BASE}/${_home}" class="topbar-logo" aria-label="Wren home" onclick="Wren.navigate('${_home}');return false">
        <div class="wren-logo"><span class="logo-w">w</span><span class="logo-ren">ren</span></div>
      </a>
      <span id="wren-section-title" class="topbar-section-title" aria-live="polite" aria-atomic="true"></span>
      <div class="topbar-spacer"></div>
      ${IS_ADMIN && isMgr ? '<span id="wren-mylist-chip"></span>' : ''}
      ${IS_ADMIN && isMgr ? '<span id="wren-attention-lights"></span>' : ''}
      <button id="wren-search-btn" class="topbar-icon-btn topbar-search-btn" aria-label="Search (Ctrl+K)" title="Search (Ctrl+K)">
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        <span class="topbar-search-label">Search</span>
        <kbd class="topbar-kbd">Ctrl K</kbd>
      </button>
      <button id="wren-ai-btn" class="topbar-icon-btn" aria-label="Wren AI" title="Wren AI">
        <span aria-hidden="true" data-wren-icon="bird" style="font-size:1.1rem">🪺</span>
      </button>
      <button id="wren-msg-btn" class="topbar-icon-btn" aria-label="Messages" aria-haspopup="true">
        <span aria-hidden="true" data-wren-icon="message" style="font-size:1.1rem">✉️</span>
        <span id="wren-msg-count" class="v2-notif-badge" hidden aria-label="unread messages"></span>
      </button>
      ${EDITION === 'learning' ? `
      <button id="wren-door-btn" class="topbar-icon-btn" aria-label="Front door" title="Front door" hidden>
        <span aria-hidden="true" style="font-size:1.1rem">🚪</span>
        <span id="wren-door-badge" class="v2-notif-badge" hidden aria-label="someone at the door"></span>
      </button>` : ''}
      <button id="wren-notif-btn" class="topbar-icon-btn" aria-label="Notifications" aria-haspopup="true">
        <span aria-hidden="true" style="font-size:1.1rem">🔔</span>
        <span id="wren-notif-count" class="v2-notif-badge" hidden aria-label="unread notifications"></span>
      </button>
      <button class="topbar-avatar" aria-label="Account menu" aria-haspopup="true" id="wren-account-btn">
        ${(user.name || '?').charAt(0).toUpperCase()}
      </button>`;
    document.body.prepend(topbar);
    if (window.WrenIcons) WrenIcons.hydrate(topbar);

    // Keep --topbar-h in sync with real rendered topbar height (grows on inspection bar, etc.)
    // Use rAF for initial read — offsetHeight is 0 until the browser completes layout for the
    // newly-prepended position:fixed topbar, so an immediate call would set --topbar-h to 0px
    // and defeat the CSS fallback (var(--topbar-h, 56px) only uses fallback when unset, not 0).
    function _syncTopbarH() {
      const h = topbar.offsetHeight;
      if (h > 0) document.documentElement.style.setProperty('--topbar-h', h + 'px');
    }
    requestAnimationFrame(() => requestAnimationFrame(_syncTopbarH));
    new ResizeObserver(_syncTopbarH).observe(topbar);

    // Keep --quickbar-h in sync if #wren-quickbar exists (created by legacy wren-shell.js)
    function _watchQuickbar() {
      const qb = document.getElementById('wren-quickbar');
      if (!qb) return;
      document.body.classList.add('has-quickbar');
      function _syncQH() { document.documentElement.style.setProperty('--quickbar-h', qb.offsetHeight + 'px'); }
      _syncQH();
      new ResizeObserver(_syncQH).observe(qb);
    }
    if (document.getElementById('wren-quickbar')) {
      _watchQuickbar();
    } else {
      const _qbObserver = new MutationObserver(() => {
        if (document.getElementById('wren-quickbar')) { _qbObserver.disconnect(); _watchQuickbar(); }
      });
      _qbObserver.observe(document.body, { childList: true, subtree: false });
    }

    // b237 — role filter, plus the two declarative gates below (requiresRoleAny /
    // requiresCapability). requiresRoleAny is synchronous so it applies here;
    // requiresCapability needs /api/permissions/me and is applied by
    // _applyCapabilityNavGates() once the sidebar is in the DOM.
    const visibleSections = Object.values(SECTIONS).filter(s => {
      if (s.requiresRole === 'manager' && !isMgr) return false;
      if (Array.isArray(s.requiresRoleAny)) {
        const role = (Wren.user && Wren.user.role) || '';
        if (Number(Wren.user && Wren.user.id) !== 1 && s.requiresRoleAny.indexOf(role) === -1) return false;
      }
      return true;
    });
    const sidebar = document.createElement('nav');
    sidebar.id = 'wren-sidebar';
    sidebar.setAttribute('role', 'navigation');
    sidebar.setAttribute('aria-label', 'Main navigation');
    // Grouped sidebar: resolved layout (saved override or default). Unmapped
    // sections fall into "More" below so nothing ever disappears.
    // b241 — the layout is now resolved by _navGroupList() (which decorates it with
    // slug + icon + blurb), a few lines down.
    const _itemHtml = s => s.href ? `
          <li role="none"${_fledgeAttr(s.id)}>
            <a class="v2-section-btn" href="${s.href}" aria-label="${s.label}" title="${s.label}" role="menuitem">
              <span class="v2-section-icon" aria-hidden="true" data-wren-icon="${WI_KEY(s)}">${s.icon}</span>
              <span class="v2-section-label">${s.label}</span>
            </a>
          </li>` : `
          <li role="none"${_fledgeAttr(s.id)}>
            <button class="v2-section-btn" data-section="${s.id}" aria-label="${s.label}" title="${s.label}" role="menuitem">
              <span class="v2-section-icon" aria-hidden="true" data-wren-icon="${WI_KEY(s)}">${s.icon}</span>
              <span class="v2-section-label">${s.label}</span>
            </button>
          </li>`;
    // b242 — NAV_SIDEBAR_HIDDEN is a shipped opinion about sidebar clutter. A saved
    // nav_layout row that explicitly says hidden=false is a newer, more specific
    // instruction from this setting's owner, so it overrules it (_navForcedVisible).
    // The role filter above is NOT overruled — that one is about access, not taste.
    const _visMap = {};
    visibleSections.forEach(s => {
      if (!NAV_SIDEBAR_HIDDEN.has(s.id) || _navForcedVisible.has(s.id)) _visMap[s.id] = s;
    });
    const _grouped = new Set();
    const _groupHtml = (label, items) => {
      // b97: groups start closed unless pinned open ('0'); the active section's
      // group is slid open by _updateSidebarActive once the route resolves.
      const collapsed = sessionStorage.getItem('wren-navgrp-' + label) !== '0';
      return `<li class="v2-nav-group${collapsed ? ' collapsed' : ''}" role="none">
        <button class="v2-group-header" data-group-toggle="${label}" aria-expanded="${!collapsed}">
          <span class="v2-group-label">${label}</span><span class="v2-group-chev" aria-hidden="true">▾</span>
        </button>
        <ul class="v2-group-items" role="list">${items.map(_itemHtml).join('')}</ul>
      </li>`;
    };
    // ── b241: the layout, resolved once and shared by the sidebar, the group pages
    // and the Ctrl+K index. `_GROUPS` is _navGroupList() with the invisible sections
    // already dropped, plus a "More" group for anything the layout forgot — so a
    // stale saved wrenNavGroups can no more strand a section than it could before.
    const _GROUPS = _navGroupList().map(g => {
      const items = g.sections.map(id => _visMap[id]).filter(Boolean);
      items.forEach(s => _grouped.add(s.id));
      // b242 — `direct` and `pinned` are declared against the LAYOUT, but the row
      // that renders has already been filtered by role and by module toggles. Re-
      // filter them against what this person can actually see, or an apprentice's
      // Staff row would point at Absences (requiresRole:'manager') and dead-end.
      const has = id => items.some(s => s.id === id);
      return Object.assign({}, g, {
        items,
        direct: (g.direct && has(g.direct)) ? g.direct : null,
        pinned: (g.pinned || []).filter(has),
      });
    }).filter(g => g.items.length);
    // b242 — ...but NOT a section the layout deliberately hid. Without this the
    // "More" sweep would hand every hidden page straight back, and hiding would
    // do nothing at all (caught by scripts/b242-probe-nav-layout.js, which found
    // a "cook with only Kitchen" rendering a second row full of everything else).
    const _leftover = visibleSections.filter(s =>
      !_grouped.has(s.id) && !NAV_SIDEBAR_HIDDEN.has(s.id) && !_navHiddenIds.has(s.id));
    if (_leftover.length) {
      const m = NAV_GROUP_META['More'];
      _GROUPS.push({ label: 'More', slug: 'more', icon: m.icon, blurb: m.blurb, direct: null,
                     sections: _leftover.map(s => s.id), items: _leftover });
    }
    // sectionId → its group, for sidebar highlighting and the group page's back-link.
    const _GROUP_OF = {};
    _GROUPS.forEach(g => g.items.forEach(s => { if (!_GROUP_OF[s.id]) _GROUP_OF[s.id] = g; }));
    const _groupBySlug = slug => _GROUPS.find(g => g.slug === slug) || null;

    // A group row. One row per GROUP, not per section — that is the whole point of
    // b241. Three shapes:
    //   · a group of ONE section  → the row IS that section (no landing page holding
    //     a single card: Curriculum and Help & Training)
    //   · a group with `direct`   → the row goes straight to that section (Cockpit),
    //     and a second, separately-labelled button opens the group page
    //   · everything else         → the row opens /admin/group/<slug>
    const _groupRowHtml = g => {
      if (g.items.length === 1) return _itemHtml(g.items[0]);
      const openBtn = g.direct ? `
            <button class="v2-group-more" data-group="${g.slug}" aria-label="Open the ${g.label} group"
                    title="Open the ${g.label} group"><span aria-hidden="true">▸</span></button>` : '';
      const main = g.direct
        ? `<button class="v2-section-btn v2-grouprow-btn" data-section="${g.direct}" aria-label="${g.label}" title="${g.label}" role="menuitem">`
        : `<button class="v2-section-btn v2-grouprow-btn" data-group="${g.slug}" aria-label="${g.label}" title="${g.label}" role="menuitem">`;
      // b242 — `pinned` sections get their own row UNDER the group row, so the two
      // or three things a role opens every day are one tap away instead of behind
      // the card grid. Toby, on Staff: "Payroll/Rota/Absences on sidebar, everything
      // else on page." Rendered from g.items (already role- and module-filtered), so
      // a pinned section a role cannot see simply produces no row.
      const pins = (g.pinned || [])
        .map(id => g.items.find(s => s.id === id))
        .filter(Boolean)
        .map(s => _itemHtml(s).replace('<li role="none">', `<li role="none" class="v2-pinrow" data-pin-of="${g.slug}">`))
        .join('');
      return `
          <li role="none" class="v2-grouprow" data-grouprow="${g.slug}">
            ${main}
              <span class="v2-section-icon" aria-hidden="true" data-wren-icon="${WI_KEY(g)}">${g.icon}</span>
              <span class="v2-section-label">${g.label}</span>
            </button>${openBtn}
          </li>${pins}`;
    };
    // Pre-b241 flat sidebar, kept as a per-browser escape hatch rather than deleted.
    const _flat = (() => { try { return localStorage.getItem('wrenNavFlat') === '1'; } catch (e) { return false; } })();
    const _navHtml = _flat
      ? _GROUPS.map(g => _groupHtml(g.label, g.items)).join('')
      : _GROUPS.map(_groupRowHtml).join('');
    sidebar.innerHTML = `
      <ul class="v2-section-list" role="list" aria-label="Sections">
        ${_navHtml}
      </ul>
      <div class="v2-sidebar-footer">
        <button class="v2-section-btn v2-signout-btn" onclick="Wren.logout()" aria-label="Sign out" title="Sign out" role="menuitem">
          <span class="v2-section-icon" aria-hidden="true" data-wren-icon="logout">🚪</span>
          <span class="v2-section-label">Sign Out</span>
        </button>
      </div>`;
    document.body.insertBefore(sidebar, topbar.nextSibling);
    if (window.WrenIcons) WrenIcons.hydrate(sidebar);

    // ── Collapsible nav-group styling + toggle (admin grouped sidebar, 2026-07-12) ──
    // b97 (2026-07-17): drawer-style slide (animated max-height pushes items below —
    // never overlays them), hover-to-open with a ~300ms grace auto-close when the
    // pointer leaves the group. Click pins a group open/closed (per-session). In the
    // icon-only rail (sidebar not expanded) headers hide and every icon stays visible.
    if (!document.getElementById('wren-navgroup-css')) {
      const _st = document.createElement('style');
      _st.id = 'wren-navgroup-css';
      _st.textContent = '.v2-group-header{display:flex;align-items:center;justify-content:space-between;width:100%;background:none;border:none;cursor:pointer;color:var(--c-muted,#94a3b8);font-weight:700;font-size:.66rem;text-transform:uppercase;letter-spacing:.05em;padding:11px 14px 5px}.v2-group-header:hover{color:var(--c-text,#f1f5f9)}.v2-group-chev{transition:transform .15s ease;font-size:.7rem;opacity:.7}.v2-nav-group.collapsed .v2-group-chev{transform:rotate(-90deg)}.v2-group-items{list-style:none;margin:0;padding:0;overflow:hidden;max-height:0;transition:max-height .28s ease}@media (prefers-reduced-motion:reduce){.v2-group-items{transition:none}}@media (min-width:768px){body.v2-shell #wren-sidebar:not(.v2-expanded):not(:hover):not(.v2-mobile-open) .v2-group-header{display:none}body.v2-shell #wren-sidebar:not(.v2-expanded):not(:hover):not(.v2-mobile-open) .v2-group-items{max-height:none!important}}';
      document.head.appendChild(_st);
    }
    const GRP_GRACE_MS = 300;
    const GRP_OPEN_DELAY_MS = 220; // hover-intent dwell (2026-07-20): stops travel-cascade opening
    function _grpSet(grp, open) {
      const ul  = grp.querySelector('.v2-group-items');
      const hdr = grp.querySelector('.v2-group-header');
      if (!ul || !hdr) return;
      grp.classList.toggle('collapsed', !open);
      hdr.setAttribute('aria-expanded', String(open));
      ul.style.maxHeight = open ? ul.scrollHeight + 'px' : '0px';
    }
    function _grpPinned(grp) {
      const btn = grp.querySelector('[data-group-toggle]');
      return !!btn && sessionStorage.getItem('wren-navgrp-' + btn.getAttribute('data-group-toggle')) === '0';
    }
    function _grpHasActive(grp) { return !!grp.querySelector('.v2-section-btn.v2-active'); }
    sidebar.querySelectorAll('.v2-nav-group').forEach(grp => {
      let _closeTimer = null;
      let _openTimer  = null;
      if (!grp.classList.contains('collapsed')) _grpSet(grp, true);   // pinned-open at build
      const btn = grp.querySelector('[data-group-toggle]');
      if (btn) btn.addEventListener('click', () => {
        const opening = grp.classList.contains('collapsed');
        _grpSet(grp, opening);
        try { sessionStorage.setItem('wren-navgrp-' + btn.getAttribute('data-group-toggle'), opening ? '0' : '1'); } catch (e) {}
      });
      grp.addEventListener('mouseenter', () => {
        if (window.innerWidth < 768) return;
        clearTimeout(_closeTimer);
        clearTimeout(_openTimer);
        if (grp.classList.contains('collapsed')) {
          _openTimer = setTimeout(() => {
            if (!grp.matches(':hover')) return;               // pointer already moved on
            sidebar.querySelectorAll('.v2-nav-group:not(.collapsed)').forEach(o => {
              if (o !== grp && !_grpPinned(o) && !_grpHasActive(o)) _grpSet(o, false);
            });                                                // one hover-open at a time
            _grpSet(grp, true);
          }, GRP_OPEN_DELAY_MS);
        }
      });
      // Keyboard: tabbing/arrowing into a closed group slides it open (max-height:0
      // leaves items focusable, unlike the old display:none — never trap focus unseen).
      grp.addEventListener('focusin', () => {
        clearTimeout(_closeTimer);
        if (grp.classList.contains('collapsed')) _grpSet(grp, true);
      });
      grp.addEventListener('mouseleave', () => {
        if (window.innerWidth < 768) return;
        clearTimeout(_openTimer);
        clearTimeout(_closeTimer);
        _closeTimer = setTimeout(() => {
          if (!_grpPinned(grp) && !_grpHasActive(grp)) _grpSet(grp, false);
        }, GRP_GRACE_MS);
      });
    });

    // ── Module toggles (2026-07-09): hide sidebar sections whose module_<id>
    // feature flag is off (set in Setup & Features / the wizard presets).
    // FAIL-OPEN: any error → every section stays visible. Locked sections
    // (children, safeguarding, system) have no module_* flag so never hide.
    (async () => {
      try {
        // b521 — one resolver for the flags, shared with the tab-level switch
        // (_tabEnabled / TAB_FEATURE); it keeps the same 5-minute sessionStorage
        // cache and the same fail-open behaviour this block always had.
        const flags = await _loadModFlags();
        if (!flags || typeof flags !== 'object') return;
        // _modFlags is already set by _loadModFlags (b241 — group-page cards read it too)
        let currentHidden = false;
        sidebar.querySelectorAll('.v2-section-list [data-section]').forEach(btn => {
          if (flags['module_' + btn.dataset.section] === false) {
            const li = btn.closest('li');
            if (li) li.style.display = 'none';
            if (btn.classList.contains('active')) currentHidden = true;
          }
        });
        // b241 — a GROUP row whose every section is switched off leads to an empty
        // page, so the row goes too. A group with one live section still shows.
        _GROUPS.forEach(g => {
          const live = g.items.some(s => flags['module_' + s.id] !== false);
          if (live) return;
          const li = sidebar.querySelector(`[data-grouprow="${g.slug}"]`);
          if (li) li.style.display = 'none';
        });
        // If the landing section itself is disabled, hop to the first visible one.
        if (currentHidden) {
          const first = sidebar.querySelector('.v2-section-list li:not([style*="none"]) [data-section], .v2-section-list li:not([style*="none"]) [data-group]');
          if (first) first.click();
        }
        // A group page already on screen re-renders, so a card for a module that has
        // just been switched off does not sit there until the next navigation.
        const _openGp = document.querySelector('#section-content [data-group-page]');
        if (_openGp && typeof _renderGroupPage === 'function') _renderGroupPage(_openGp.getAttribute('data-group-page'));
      } catch (e) { /* fail-open */ }
    })();

    let mainEl = document.getElementById('wren-main');
    if (!mainEl) {
      mainEl = document.createElement('main');
      mainEl.id = 'wren-main';
      mainEl.setAttribute('role', 'main');
      mainEl.setAttribute('tabindex', '-1');
      if (isSPA) {
        let contentEl = document.getElementById('section-content');
        if (!contentEl) {
          contentEl = document.createElement('div');
          contentEl.id = 'section-content';
        }
        mainEl.appendChild(contentEl);
        document.body.appendChild(mainEl);
      } else {
        // Legacy standalone page: wrap its own existing content in #wren-main for layout,
        // rather than creating an empty #section-content and loading a section into it.
        document.body.appendChild(mainEl);
        const SHELL_IDS = new Set(['wren-topbar', 'wren-sidebar', 'wren-main', 'wren-session-warning', 'wren-quickbar']);
        [...document.body.children].forEach(el => {
          if (el === mainEl || SHELL_IDS.has(el.id)) return;
          if (['SCRIPT', 'STYLE', 'LINK', 'TEMPLATE'].includes(el.tagName)) return;
          mainEl.appendChild(el);
        });
      }
    }

    // 2026-07-28: hover expand/collapse with a grace delay so a quick mouse-out (or crossing a
    // small gap) doesn't snap the sidebar shut — it was too twitchy before.
    let _sbCollapseTimer = null;
    sidebar.addEventListener('mouseenter', () => {
      if (_sbCollapseTimer) { clearTimeout(_sbCollapseTimer); _sbCollapseTimer = null; }
      if (window.innerWidth >= 768) sidebar.classList.add('v2-expanded');
    });
    sidebar.addEventListener('mouseleave', () => {
      if (window.innerWidth < 768) return;
      if (_sbCollapseTimer) clearTimeout(_sbCollapseTimer);
      _sbCollapseTimer = setTimeout(() => sidebar.classList.remove('v2-expanded'), 450);
    });

    const hamburger = topbar.querySelector('#wren-hamburger');
    hamburger.addEventListener('click', () => {
      const open = sidebar.classList.toggle('v2-mobile-open');
      hamburger.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', e => {
      if (window.innerWidth >= 768) return;
      if (!sidebar.contains(e.target) && !hamburger.contains(e.target)) {
        sidebar.classList.remove('v2-mobile-open');
        hamburger.setAttribute('aria-expanded', 'false');
      }
    });

    sidebar.addEventListener('keydown', e => {
      const btns = [...sidebar.querySelectorAll('.v2-section-btn')];
      const cur = btns.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); btns[Math.min(cur + 1, btns.length - 1)]?.focus(); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); btns[Math.max(cur - 1, 0)]?.focus(); }
      if (e.key === 'Home')      { e.preventDefault(); btns[0]?.focus(); }
      if (e.key === 'End')       { e.preventDefault(); btns[btns.length - 1]?.focus(); }
    });

    sidebar.querySelectorAll('[data-section]').forEach(btn => {
      btn.addEventListener('click', () => {
        Wren.navigate(btn.dataset.section, null);
        if (window.innerWidth < 768) {
          sidebar.classList.remove('v2-mobile-open');
          hamburger.setAttribute('aria-expanded', 'false');
        }
      });
    });
    // b241 — a group row (and the small "open group" button on a `direct` row).
    sidebar.querySelectorAll('[data-group]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        Wren.navigate(GROUP_ROUTE, btn.dataset.group);
        if (window.innerWidth < 768) {
          sidebar.classList.remove('v2-mobile-open');
          hamburger.setAttribute('aria-expanded', 'false');
        }
      });
    });

    function _updateSidebarActive(sectionId) {
      sidebar.querySelectorAll('[data-section]').forEach(btn => {
        const active = btn.dataset.section === sectionId;
        btn.classList.toggle('v2-active', active);
        btn.setAttribute('aria-current', active ? 'page' : 'false');
      });
      // b241 — the sidebar shows groups, so the row that lights up for a section is
      // its GROUP's row. (A one-section group renders as the section itself and is
      // already handled by the loop above.)
      const _og = _GROUP_OF[sectionId];
      sidebar.querySelectorAll('[data-grouprow]').forEach(li => {
        const on = !!_og && li.dataset.grouprow === _og.slug;
        const b = li.querySelector('.v2-grouprow-btn');
        if (b) { b.classList.toggle('v2-active', on); b.setAttribute('aria-current', on ? 'true' : 'false'); }
      });
      const def = SECTIONS[sectionId];
      const titleEl = document.getElementById('wren-section-title');
      if (titleEl) titleEl.textContent = def ? def.label : '';
      // b97: the active section's group slides open; groups left behind close again
      // unless pinned open or currently hovered.
      sidebar.querySelectorAll('.v2-nav-group').forEach(grp => {
        if (_grpHasActive(grp)) { if (grp.classList.contains('collapsed')) _grpSet(grp, true); }
        else if (!grp.classList.contains('collapsed') && !_grpPinned(grp) && !grp.matches(':hover')) _grpSet(grp, false);
      });
    }

    const _sectionCache = {};

    // ── b241: the group landing page ────────────────────────────────────────────
    // A responsive card grid of the group's sections — 3 columns on desktop, 2 on
    // tablet, 1 on phone, so a group of eight reads as three rows rather than eight
    // scrolls. Cards are real <a> links (right-click / open-in-new-tab keep working)
    // whose clicks are intercepted for SPA sections.
    const _escG = s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    // The same two runtime gates the sidebar honours, so a card can never advertise
    // a door the API will slam. Both fail OPEN: unknown → shown.
    const _cardAllowed = s =>
      !(_modFlags && _modFlags['module_' + s.id] === false) && !_capDenied.has(s.id);
    const _sectionHref = s => (s.href && !(s.tabs && s.tabs.length))
      ? s.href
      : `${BASE}/${s.id}/${(s.tabs && s.tabs[0]) || ''}`;

    function _updateSidebarActiveGroup(slug) {
      sidebar.querySelectorAll('[data-section]').forEach(btn => {
        btn.classList.remove('v2-active'); btn.setAttribute('aria-current', 'false');
      });
      sidebar.querySelectorAll('[data-grouprow]').forEach(li => {
        const on = li.dataset.grouprow === slug;
        const b = li.querySelector('.v2-grouprow-btn');
        if (b) { b.classList.toggle('v2-active', on); b.setAttribute('aria-current', on ? 'page' : 'false'); }
      });
    }

    _renderGroupPage = function (slug) {
      const g = _groupBySlug(slug);
      const container = document.getElementById('section-content');
      if (!container) return;
      // Unknown slug (renamed group, stale bookmark): don't dead-end — go home.
      if (!g) { Wren.navigate(_landingSection(), null); return; }
      // A group of one has no landing page of its own — the sidebar row already IS
      // that section, and a page holding a single card is a wasted click.
      if (g.items.length === 1) { Wren.navigate(g.items[0].id, null); return; }

      _updateSidebarActiveGroup(slug);
      const titleEl = document.getElementById('wren-section-title');
      if (titleEl) titleEl.textContent = g.label;
      document.dispatchEvent(new CustomEvent('wren:group-loaded', { detail: { group: slug } }));

      // b242 — a pinned section already has its own sidebar row, so it is not
      // repeated as a card: "everything else on page". If a group pins ALL of its
      // sections the page would be empty, which reads as a fault — fall back to
      // showing every card in that case.
      const _pinSet = new Set(g.pinned || []);
      const _cardItems = g.items.filter(s => !_pinSet.has(s.id));
      const cards = (_cardItems.length ? _cardItems : g.items).filter(_cardAllowed).map(s => `
            <li role="none"${_fledgeAttr(s.id)}>
              <a class="v2-gp-card" href="${_escG(_sectionHref(s))}"
                 ${s.href && !(s.tabs && s.tabs.length) ? '' : `data-section="${_escG(s.id)}"`}>
                <span class="v2-gp-card-icon" aria-hidden="true" data-wren-icon="${WI_KEY(s)}">${s.icon}</span>
                <span class="v2-gp-card-text">
                  <span class="v2-gp-card-label">${_escG(s.label)}</span>
                  <span class="v2-gp-card-desc">${_escG(SECTION_BLURB[s.id] || '')}</span>
                </span>
              </a>
            </li>`).join('');

      container.innerHTML = `
        <div class="v2-group-page" data-group-page="${_escG(slug)}">
          <header class="v2-gp-head">
            <span class="v2-gp-head-icon" aria-hidden="true">${g.icon}</span>
            <div class="v2-gp-head-text">
              <h1 class="v2-gp-title">${_escG(g.label)}</h1>
              ${g.blurb ? `<p class="v2-gp-blurb">${_escG(g.blurb)}</p>` : ''}
            </div>
          </header>
          ${cards
            ? `<ul class="v2-gp-grid" role="list">${cards}</ul>`
            : `<p class="v2-gp-empty">Every section in this group is switched off in Setup &amp; Features.</p>`}
        </div>`;
      if (window.WrenIcons) WrenIcons.hydrate(container);
      container.querySelectorAll('.v2-gp-card[data-section]').forEach(a => {
        a.addEventListener('click', e => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;  // let the browser open a tab
          e.preventDefault();
          Wren.navigate(a.dataset.section, null);
        });
      });
      const firstCard = container.querySelector('.v2-gp-card');
      if (firstCard) firstCard.setAttribute('data-gp-first', '1');
      const main = document.getElementById('wren-main');
      if (main) main.scrollTop = 0;
      window.scrollTo(0, 0);
    };

    _loadSection = async function (sectionId, tabId) {
      // b241 — /admin/group/<slug>. Handled here as well as in Wren.navigate so the
      // BACK BUTTON works: popstate calls _loadSection with the stored state.
      if (sectionId === GROUP_ROUTE) { _renderGroupPage(tabId); return; }
      const def = SECTIONS[sectionId];
      if (!def) { Wren.navigate(_landingSection(), null); return; }
      // b200: 26 sections are declared with `href:` — they are standalone pages,
      // not SPA fragments, and no /sections/<id>.html exists for them. Without
      // this guard, reaching one by URL (bookmark, Ctrl+K search, "Open →" link)
      // made the shell fetch a fragment that does not exist. Wren answers 200 +
      // the Admin Login page for any unknown path, so the login form was injected
      // into the section area. Send the user to the real page instead.
      if (def.href && !(def.tabs && def.tabs.length)) { window.location.replace(def.href); return; }
      _updateSidebarActive(sectionId);
      const container = document.getElementById('section-content');
      if (!container) return;
      if (!_sectionCache[sectionId]) {
        container.innerHTML = `<div class="v2-section-loading"><div class="v2-sk-bar wide"></div><div class="v2-sk-tabs"></div><div class="v2-sk-body"></div></div>`;
      }
      try {
        let html;
        if (_sectionCache[sectionId]) {
          html = _sectionCache[sectionId];
        } else {
          const res = await fetch(`/sections/${sectionId}.html`, { cache: 'no-store', credentials: 'same-origin' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          html = await res.text();
          _sectionCache[sectionId] = html;
        }
        container.innerHTML = html;
        container.querySelectorAll('script').forEach(old => {
          const s = document.createElement('script');
          [...old.attributes].forEach(a => s.setAttribute(a.name, a.value));
          s.textContent = old.textContent;
          old.replaceWith(s);
        });
        _wireTabBar(container, sectionId, tabId || def.tabs[0]);
        document.dispatchEvent(new CustomEvent('wren:section-loaded', { detail: { section: sectionId } }));
      } catch (err) {
        console.error('Section load error:', err);
        container.innerHTML = `
          <div class="v2-section-error">
            <div style="font-size:2.5rem">⚠️</div>
            <h2>Section unavailable</h2>
            <p>Could not load <strong>${sectionId}</strong>. <a href="${BASE}/cockpit">Go to Cockpit</a></p>
          </div>`;
      }
    };

    function _wireTabBar(container, sectionId, activeTabId) {
      const tabList = container.querySelector('[role="tablist"]');
      if (!tabList) return;
      // Sync --tabbar-h so sticky content knows how much space the tab bar takes
      const _syncTBH = () => document.documentElement.style.setProperty('--tabbar-h', tabList.offsetHeight + 'px');
      _syncTBH();
      new ResizeObserver(_syncTBH).observe(tabList);
      let tabs     = [...tabList.querySelectorAll('[role="tab"]')];
      let panels   = [...container.querySelectorAll('[role="tabpanel"]')];
      // b521 — a tab whose feature_flags key is explicitly false comes out of the
      // tab bar entirely (see TAB_FEATURE). The markup and the route behind it are
      // untouched; flipping the flag back to true brings it straight back.
      // FAIL-OPEN: before the flags arrive _tabEnabled() says yes, so a slow or dead
      // /api/features/public can never hide a tab. Re-run once they land.
      function _applyTabFlags() {
        const gone = tabs.filter(t => !_tabEnabled(sectionId, t.dataset.tab));
        if (!gone.length) return;
        const goneIds = new Set(gone.map(t => t.dataset.tab));
        gone.forEach(t => { const li = t.closest('li'); (li || t).remove(); });
        panels.filter(p => goneIds.has(p.dataset.tab)).forEach(p => { p.hidden = true; });
        tabs   = tabs.filter(t => !goneIds.has(t.dataset.tab));
        panels = panels.filter(p => !goneIds.has(p.dataset.tab));
        // If the hidden tab was the one on screen, fall back to the first live one.
        if (goneIds.has(activeTabId) && tabs.length) _activateTab(tabs[0].dataset.tab);
      }
      const track      = container.querySelector('.tab-bar-track');
      const leftArrow  = container.querySelector('.tab-scroll-arrow.left');
      const rightArrow = container.querySelector('.tab-scroll-arrow.right');
      if (track && leftArrow && rightArrow) {
        const scroll = dir => track.scrollBy({ left: dir * 180, behavior: 'smooth' });
        leftArrow.addEventListener('click', () => scroll(-1));
        rightArrow.addEventListener('click', () => scroll(1));
        const upd = () => {
          leftArrow.style.visibility  = track.scrollLeft > 1 ? 'visible' : 'hidden';
          rightArrow.style.visibility = (track.scrollLeft + track.clientWidth + 1) < track.scrollWidth ? 'visible' : 'hidden';
        };
        track.addEventListener('scroll', upd, { passive: true });
        requestAnimationFrame(upd);
        new ResizeObserver(upd).observe(track);
      }
      function _activateTab(tabId) {
        const activeTab = tabs.find(t => t.dataset.tab === tabId);
        if (!activeTab) return;
        tabs.forEach(t => {
          const isActive = t.dataset.tab === tabId;
          t.classList.toggle('wren-tab-active', isActive);
          t.setAttribute('aria-selected', String(isActive));
          t.setAttribute('tabindex', isActive ? '0' : '-1');
        });
        panels.forEach(p => {
          const isActive = p.dataset.tab === tabId;
          p.hidden = !isActive;
          if (isActive) {
            const fn = window[`wrenLoadTab_${sectionId}_${tabId}`];
            if (typeof fn === 'function') { fn(p); window[`wrenLoadTab_${sectionId}_${tabId}`] = null; }
          }
        });
        activeTab.scrollIntoView({ inline: 'nearest', behavior: 'smooth' });
        const newUrl = `${BASE}/${sectionId}/${tabId}`;
        if (window.location.pathname !== newUrl) history.replaceState({ section: sectionId, tab: tabId }, '', newUrl);
      }
      tabs.forEach(tab => tab.addEventListener('click', () => _activateTab(tab.dataset.tab)));
      tabList.addEventListener('keydown', e => {
        const cur = tabs.findIndex(t => t === document.activeElement);
        if (cur < 0) return;
        const map = { ArrowRight: 1, ArrowLeft: -1 };
        if (e.key in map) {
          e.preventDefault();
          const next = Math.max(0, Math.min(tabs.length - 1, cur + map[e.key]));
          tabs[next].focus();
          _activateTab(tabs[next].dataset.tab);
        } else if (e.key === 'Home') { e.preventDefault(); tabs[0].focus(); _activateTab(tabs[0].dataset.tab); }
        else if (e.key === 'End')   { e.preventDefault(); tabs[tabs.length-1].focus(); _activateTab(tabs[tabs.length-1].dataset.tab); }
      });
      _applyTabFlags();
      const valid = tabs.find(t => t.dataset.tab === activeTabId);
      _activateTab(valid ? activeTabId : tabs[0]?.dataset.tab);
      // Flags are cached in sessionStorage for 5 minutes, so this is a no-op on
      // every load but the first in a session.
      if (!_modFlags) _loadModFlags().then(_applyTabFlags);
    }

    window.addEventListener('popstate', e => {
      const state = e.state || _parseRoute();
      _loadSection(state.section, state.tab);
    });

    function _openSearch() {
      if (document.getElementById('wren-search-overlay')) return;
      const overlay = document.createElement('div');
      overlay.id = 'wren-search-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', 'Global search');
      overlay.innerHTML = `
        <div class="search-backdrop"></div>
        <div class="search-panel">
          <div class="search-input-row">
            <svg class="search-input-icon" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
            <input type="text" id="wren-search-input" class="search-input" placeholder="Search sections, tabs…" autocomplete="off" spellcheck="false" aria-label="Search">
            <kbd class="search-esc">Esc</kbd>
          </div>
          <div id="wren-search-results" class="search-results" role="listbox" aria-label="Search results">
            <p class="search-hint">Jump to any section or tab</p>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('open'));
      const input = overlay.querySelector('#wren-search-input');
      setTimeout(() => input.focus(), 30);
      function close() { overlay.classList.remove('open'); setTimeout(() => overlay.remove(), 180); }
      overlay.querySelector('.search-backdrop').addEventListener('click', close);
      function escHandler(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); } }
      document.addEventListener('keydown', escHandler);
      const _escS = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      let _searchSeq = 0, _searchDebounce = null;
      function _bindResults(resultsEl) {
        resultsEl.querySelectorAll('[data-section]').forEach(btn => {
          btn.addEventListener('click', () => { close(); Wren.navigate(btn.dataset.section, btn.dataset.tab); });
        });
        resultsEl.querySelectorAll('[data-href]').forEach(btn => {
          btn.addEventListener('click', () => { const href = btn.dataset.href; if (href) window.location.href = href; });
        });
      }
      input.addEventListener('input', () => {
        const q = input.value.trim();
        const ql = q.toLowerCase();
        const resultsEl = overlay.querySelector('#wren-search-results');
        if (!q) { resultsEl.innerHTML = '<p class="search-hint">Jump to any section or tab</p>'; return; }
        // 1) Section/tab hits — client-side, instant
        const hits = [];
        Object.values(SECTIONS).forEach(s => {
          if (FLEDGE_SECTIONS.has(s.id) && !_fledgeOn()) return;   // fledge-off: not searchable while off
          if (s.href) {
            // b241 — the 27 standalone tool pages have no SPA fragment, so they were
            // skipped here entirely and Ctrl+K could not find one of them by name.
            // That mattered less when each had its own sidebar icon; now that they
            // live on a group page, search is the fast path to them. They resolve by
            // href (handled by _bindResults' [data-href] branch), not by section id.
            if (s.label.toLowerCase().includes(ql)) hits.push({ label: s.label, icon: s.icon, iconKey: WI_KEY(s), href: s.href });
            return;
          }
          if (s.label.toLowerCase().includes(ql)) hits.push({ label: s.label, icon: s.icon, iconKey: WI_KEY(s), section: s.id, tab: s.tabs[0] });
          s.tabs.forEach(t => {
            if (!_tabEnabled(s.id, t)) return;     // b521 — switched-off tabs are not searchable
            if (t.includes(ql) || t.replace(/-/g, ' ').includes(ql)) hits.push({ label: `${s.label} → ${t.replace(/-/g, ' ')}`, icon: s.icon, iconKey: WI_KEY(s), section: s.id, tab: t });
          });
        });
        // b241 — the ten group pages are searchable too. Appended AFTER the section
        // hits so a section always outranks the group it lives in; the section index
        // above is untouched, so every section is still found exactly as before.
        _GROUPS.forEach(g => {
          if (g.items.length < 2) return;                       // a group of one IS its section
          if (!g.label.toLowerCase().includes(ql)) return;
          hits.push({ label: `${g.label} (group)`, icon: g.icon, iconKey: '', section: GROUP_ROUTE, tab: g.slug });
        });
        const sectionHtml = hits.length ? `<div class="search-group-label">Sections</div>` + hits.slice(0, 8).map((h, i) => `
          <button class="search-result" role="option" aria-selected="false" data-idx="${i}"
                  ${h.href ? `data-href="${h.href}"` : `data-section="${h.section}" data-tab="${h.tab}"`}>
            <span class="search-result-icon" data-wren-icon="${h.iconKey || ''}">${h.icon}</span>
            <span class="search-result-label">${h.label}</span>
          </button>`).join('') : '';
        resultsEl.innerHTML = sectionHtml + '<div id="wren-search-entities"><p class="search-hint">Searching…</p></div>';
        if (window.WrenIcons) WrenIcons.hydrate(resultsEl);
        _bindResults(resultsEl);

        // 2) Entity hits — children / staff / parents via backend (debounced, race-safe)
        const seq = ++_searchSeq;
        clearTimeout(_searchDebounce);
        _searchDebounce = setTimeout(async () => {
          let data = null;
          try { data = await Wren.api('/api/search/global?q=' + encodeURIComponent(q)); } catch {}
          if (seq !== _searchSeq) return; // a newer keystroke superseded this
          const box = overlay.querySelector('#wren-search-entities');
          if (!box) return;
          const groups = data ? [['Children', data.children, '🧒'], ['Staff', data.staff, '👤'], ['Parents', data.parents, '👪']] : [];
          let html = '';
          groups.forEach(([label, items, icon]) => {
            if (!items || !items.length) return;
            html += `<div class="search-group-label">${label}</div>`;
            html += items.map(it => `
              <button class="search-result" role="option" data-href="${_escS(it.link || '')}">
                <span class="search-result-icon">${icon}</span>
                <span class="search-result-label">${_escS(it.name)}${it.sub ? `<span class="search-result-sub">${_escS(it.sub)}</span>` : ''}</span>
              </button>`).join('');
          });
          if (!html) box.innerHTML = hits.length ? '' : '<p class="search-hint">No results</p>';
          else box.innerHTML = html;
          _bindResults(box);
        }, 180);
      });
    }

    topbar.querySelector('#wren-search-btn').addEventListener('click', _openSearch);
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); _openSearch(); }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'I') {
        e.preventDefault();
        if (typeof WrenInspection !== 'undefined') WrenInspection.openLauncher();
        else Wren.navigate('inspection', 'overview');
      }
    });

    _wireNotifications(topbar, user);
    _wireMessages(topbar, user);
    _wireWrenAI(topbar);
    _wireAccountMenu(topbar, user, role);
    _wireAttentionLights(topbar);
    _wireMyListChip(topbar);   // b504
    _wireDeadlineBanner(topbar);   // 28 Oct 2026 — past-due banners (invoices first)
    _wireDrawer();

    ['click', 'keydown', 'touchstart'].forEach(ev => {
      document.addEventListener(ev, () => { if (sessionStorage.getItem(TOKEN_KEY)) Wren._resetSessionTimer(); }, { passive: true });
    });

    _injectFonts();

    if (isSPA) {
      const { section, tab } = _parseRoute();
      // b241 — a group page reached cold (bookmark, shared link, hard refresh).
      // Branch, don't return: everything below this block (chat widget, voice
      // capture, feedback button, wren:ready) must still wire up on a group page.
      if (section === GROUP_ROUTE) {
        const slug = _groupBySlug(tab) ? tab : _GROUPS[0].slug;
        const gUrl = `${BASE}/${GROUP_ROUTE}/${slug}`;
        if (window.location.pathname !== gUrl) history.replaceState({ section: GROUP_ROUTE, tab: slug }, '', gUrl);
        _renderGroupPage(slug);
      } else {
      let initSection = SECTIONS[section] ? section : _landingSection();
      // A manager-only section landed on by a non-manager (e.g. cockpit home) falls back to Dashboard.
      if (SECTIONS[initSection] && SECTIONS[initSection].requiresRole === 'manager' && !isMgr) initSection = 'staff';
      // b200: an href-only section (no SPA fragment) has tabs:[] — building an
      // init URL from tabs[0] wrote `/admin/<id>/undefined` into history before
      // _loadSection's guard redirected. Go straight to the real page instead.
      const _initDef = SECTIONS[initSection];
      if (_initDef.href && !(_initDef.tabs && _initDef.tabs.length)) { window.location.replace(_initDef.href); return; }
      const initUrl = `${BASE}/${initSection}/${tab || SECTIONS[initSection].tabs[0]}`;
      if (window.location.pathname !== initUrl) {
        history.replaceState({ section: initSection, tab: tab || SECTIONS[initSection].tabs[0] }, '', initUrl);
      }
      _loadSection(initSection, tab || SECTIONS[initSection].tabs[0]);
      }
    }

    (async function _initInspectionCountdown() {
      return; // top inspection countdown banner removed per Toby 2026-06-22 — Inspection Mode still reachable from the Operations nav
      if (!isMgr) return;
      try {
        const data = await Wren.api('/api/inspection/active');
        if (!data?.inspection) return;
        const insp = data.inspection;
        if (insp.type !== 'pre_announced' || !insp.expected_arrival) return;
        const arrival = new Date(insp.expected_arrival);
        if (arrival < new Date()) return;
        const bar = document.createElement('div');
        bar.id = 'wren-inspection-bar';
        bar.setAttribute('role', 'status');
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2000;background:#7c3aed;color:#fff;text-align:center;padding:6px 16px;font-size:0.8rem;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:12px';
        bar.onclick = () => Wren.navigate('inspection', 'overview');
        function _updateBar() {
          const diff = arrival - new Date();
          if (diff <= 0) { bar.remove(); return; }
          const h = Math.floor(diff / 3600000);
          const m = Math.floor((diff % 3600000) / 60000);
          const s = Math.floor((diff % 60000) / 1000);
          const pad = n => String(n).padStart(2, '0');
          bar.innerHTML = `<span>📋 Inspection Mode — ${insp.inspector_name ? insp.inspector_name + ' — ' : ''}Arrival in</span><span style="font-variant-numeric:tabular-nums;font-size:1rem;letter-spacing:1px">${h}:${pad(m)}:${pad(s)}</span><span style="opacity:0.7;font-size:0.7rem">Click to open Inspection Mode</span>`;
        }
        _updateBar();
        document.body.style.paddingTop = (parseInt(document.body.style.paddingTop || '0') + 34) + 'px';
        document.body.prepend(bar);
        const tick = setInterval(() => { if (!document.getElementById('wren-inspection-bar')) { clearInterval(tick); return; } _updateBar(); }, 1000);
      } catch {}
    })();

    _applyCapabilityNavGates();

    window._wrenReady = true;
    document.dispatchEvent(new CustomEvent('wren:ready', { detail: { user: Wren.user } }));
    _loadChatWidget('admin');
    if (!document.getElementById('wren-vc-btn')) {
      const _vcs = document.createElement('script');
      _vcs.src = '/js/wren-voice-capture.js?v=2026071501';
      document.head.appendChild(_vcs);
    }
    // Feedback/bug-report widget (2026-07-09) — every portal, staff testing phase
    if (!document.getElementById('wfb-btn') && !document.querySelector('script[src^="/js/wren-feedback.js"]')) {
      const _fbs = document.createElement('script');
      _fbs.src = '/js/wren-feedback.js?v=20261020fbv';
      document.head.appendChild(_fbs);
    }
    // First-run setup wizard (2026-07-16) — generic engine; self-guards to portals
    // that register a config (roost/hr). Loaded before the tour so the tour can
    // hand first-run off to it. Inert on portals without a registered config.
    if (!document.querySelector('script[src^="/js/wren-wizard.js"]')) {
      const _wzs = document.createElement('script');
      _wzs.src = '/js/wren-wizard.js?v=20261009';
      document.head.appendChild(_wzs);
    }
    // First-run guided tour (2026-07-09; generic engine 2026-07-16) — self-guards:
    // installs the ? trigger, auto-offers on first visit, smart-skips hidden modules.
    if (!document.querySelector('script[src^="/js/wren-tour.js"]')) {
      const _trs = document.createElement('script');
      _trs.src = '/js/wren-tour.js?v=20261009';
      document.head.appendChild(_trs);
    }
  }

  // ── Chat widget loader ────────────────────────────────────────────────────────
  // The bird chatbot lives in wren-chat.js. shell-v2 previously only *called*
  // WrenChat.init() but never loaded the script, so the widget never appeared on
  // any shell-v2 page (the whole EY portal + admin SPA). Load it once, then init
  // with the given persona. Honours an opt-out <meta name="wren-app-chat" content="off">.
  function _loadChatWidget(persona) {
    try {
      const off = document.querySelector('meta[name="wren-app-chat"]');
      if (off && off.content === 'off') return;
    } catch (e) {}
    function _init() { if (window.WrenChat) WrenChat.init({ persona: persona, greeting: "Hi! I'm Wren." }); }
    if (window.WrenChat) { _init(); return; }
    if (document.getElementById('wren-chat-loader')) return;
    const s = document.createElement('script');
    s.id  = 'wren-chat-loader';
    s.src = '/js/wren-chat.js?v=20261020fbv';
    s.onload = _init;
    document.head.appendChild(s);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // buildShellMPA — MPA shell for hr / eyfs / ladn / primary / secondary
  // ─────────────────────────────────────────────────────────────────────────────
  function buildShellMPA() {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token && !window.location.pathname.includes('login')) {
      window.location.replace(_loginUrl());
      return;
    }

    Wren._parseUser();
    Wren._resetSessionTimer();
    const user = Wren.user;
    if (!user) return;

    const role   = user.role || 'practitioner';
    const edKey  = EDITION === 'ladn' ? 'eyfs' : EDITION;
    const navCfg = NAV_MPA[edKey] || {};
    // Manager-equivalent roles inherit the manager nav when they lack their own key
    const roleAlias = ['deputy_manager', 'admin', 'headteacher', 'business_manager'].includes(role) ? 'manager' : null;
    // b242 — the same ladn.nav_layout rows the Roost sidebar honours, applied to
    // this portal's flat nav. No rows for this edition+role => returns the list
    // unchanged, so an untouched portal renders exactly as it did before.
    const navItems = _applyMpaOverrides(
      navCfg[role] || (roleAlias && navCfg[roleAlias]) || navCfg['practitioner'] || navCfg['manager'] || []);

    document.body.classList.add('v2-shell', 'edition-' + EDITION);
    // Demo editions (getwren.co.uk): show a static, always-labelled sidebar (icon + word
    // side by side, no hover-only rail). Hostname-gated so LADN never matches. 2026-07-30.
    try { if (/(^|\.)getwren\.co\.uk$/i.test(location.hostname)) document.body.classList.add('v2-demo'); } catch (e) {}

    // ── HR portal (Seed): tag body for mode-toggle CSS scoping + apply saved mode.
    // HR is used both on phones (at home) and at a desk, so it gets a persistent
    // mobile/desktop layout toggle. Additive, HR-only. (Prompt 24, 2026-06-29.)
    // Setting data-portal here also guarantees the attribute on every HR page
    // regardless of whether the page's <body> declares it.
    if (EDITION === 'hr') {
      document.body.setAttribute('data-portal', 'hr');
      _hrApplySavedMode();
    }

    const warnBar = document.createElement('div');
    warnBar.id = 'wren-session-warning';
    warnBar.hidden = true;
    warnBar.setAttribute('role', 'alert');
    warnBar.innerHTML = `⏱ Your session expires in 1&nbsp;minute. <a href="#" onclick="Wren._resetSessionTimer();this.closest('#wren-session-warning').hidden=true;return false">Stay signed in</a>`;
    document.body.appendChild(warnBar);

    // Topbar
    const topbar = document.createElement('header');
    topbar.id = 'wren-topbar';
    topbar.setAttribute('role', 'banner');
    topbar.innerHTML = `
      <button id="wren-hamburger" class="topbar-icon-btn" aria-label="Toggle navigation" aria-expanded="false" aria-controls="wren-sidebar">
        <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
      </button>
      <a href="/index.html" class="topbar-logo" aria-label="Wren home">
        <div class="wren-logo"><span class="logo-w">w</span><span class="logo-ren">ren</span></div>
      </a>
      <div class="topbar-spacer"></div>
      <button id="wren-ai-btn" class="topbar-icon-btn" aria-label="Wren AI" title="Wren AI">
        <span aria-hidden="true" data-wren-icon="bird" style="font-size:1.1rem">🪺</span>
      </button>
      ${EDITION === 'hr' ? '' : `
      <button id="wren-msg-btn" class="topbar-icon-btn" aria-label="Messages" aria-haspopup="true">
        <span aria-hidden="true" data-wren-icon="message" style="font-size:1.1rem">✉️</span>
        <span id="wren-msg-count" class="v2-notif-badge" hidden aria-label="unread messages"></span>
      </button>`}
      <button id="wren-notif-btn" class="topbar-icon-btn" aria-label="Notifications" aria-haspopup="true">
        <span aria-hidden="true" style="font-size:1.1rem">🔔</span>
        <span id="wren-notif-count" class="v2-notif-badge" hidden aria-label="unread notifications"></span>
      </button>
      <button class="topbar-avatar" aria-label="Account menu" aria-haspopup="true" id="wren-account-btn">
        ${(user.name || '?').charAt(0).toUpperCase()}
      </button>`;
    document.body.prepend(topbar);
    if (window.WrenIcons) WrenIcons.hydrate(topbar);

    // HR: inject the mobile/desktop layout toggle into the topbar (every HR page).
    if (EDITION === 'hr') _hrInstallModeToggle(topbar);

    // Keep --topbar-h in sync with real rendered topbar height
    // rAF defers the initial read so offsetHeight is non-zero after browser layout.
    function _syncTopbarH() {
      const h = topbar.offsetHeight;
      if (h > 0) document.documentElement.style.setProperty('--topbar-h', h + 'px');
    }
    requestAnimationFrame(() => requestAnimationFrame(_syncTopbarH));
    new ResizeObserver(_syncTopbarH).observe(topbar);

    // Sync --tabbar-h for any .wren-tab-bar present on this page
    (function _watchTabbar() {
      const tb = document.querySelector('.wren-tab-bar');
      if (!tb) return;
      const _syncTBH = () => document.documentElement.style.setProperty('--tabbar-h', tb.offsetHeight + 'px');
      _syncTBH();
      new ResizeObserver(_syncTBH).observe(tb);
    })();

    // Keep --quickbar-h in sync if #wren-quickbar exists (created by legacy wren-shell.js)
    function _watchQuickbar() {
      const qb = document.getElementById('wren-quickbar');
      if (!qb) return;
      document.body.classList.add('has-quickbar');
      function _syncQH() { document.documentElement.style.setProperty('--quickbar-h', qb.offsetHeight + 'px'); }
      _syncQH();
      new ResizeObserver(_syncQH).observe(qb);
    }
    if (document.getElementById('wren-quickbar')) {
      _watchQuickbar();
    } else {
      const _qbObserver = new MutationObserver(() => {
        if (document.getElementById('wren-quickbar')) { _qbObserver.disconnect(); _watchQuickbar(); }
      });
      _qbObserver.observe(document.body, { childList: true, subtree: false });
    }

    // Sidebar
    const curPath = window.location.pathname;
    const sidebar = document.createElement('nav');
    sidebar.id = 'wren-sidebar';
    sidebar.setAttribute('role', 'navigation');
    sidebar.setAttribute('aria-label', 'Main navigation');

    const navHtml = navItems.map(item => {
      if (item.href) {
        const isActive = curPath === item.href || curPath.endsWith(item.href.replace(/^\//, ''));
        return `
          <li role="none">
            <a class="v2-section-btn v2-nav-link${isActive ? ' v2-active' : ''}"
               href="${item.href}" title="${item.label}" aria-label="${item.label}"${isActive ? ' aria-current="page"' : ''}>
              <span class="v2-section-icon" aria-hidden="true" data-wren-icon="${WI_KEY(item)}">${item.icon}</span>
              <span class="v2-section-label">${item.label}</span>
            </a>
          </li>`;
      } else if (item.children) {
        const hasActive = item.children.some(c => curPath === c.href || curPath.endsWith(c.href.replace(/^\//, '')));
        const childHtml = item.children.map(c => {
          const isCA = curPath === c.href || curPath.endsWith(c.href.replace(/^\//, ''));
          return `<li><a class="v2-child-link${isCA ? ' v2-active' : ''}" href="${c.href}"${isCA ? ' aria-current="page"' : ''}>${c.label}</a></li>`;
        }).join('');
        return `
          <li role="none" class="v2-mpa-group${hasActive ? ' v2-group-active' : ''}">
            <button class="v2-section-btn v2-group-btn" aria-expanded="${hasActive ? 'true' : 'false'}" title="${item.label}" aria-label="${item.label}">
              <span class="v2-section-icon" aria-hidden="true" data-wren-icon="${WI_KEY(item)}">${item.icon}</span>
              <span class="v2-section-label">${item.label}<span class="v2-mpa-chevron" aria-hidden="true">›</span></span>
            </button>
            <ul class="v2-mpa-children"${hasActive ? '' : ' hidden'}>
              ${childHtml}
            </ul>
          </li>`;
      }
      return '';
    }).join('');

    sidebar.innerHTML = `
      <ul class="v2-section-list" role="list" aria-label="Navigation">
        ${navHtml}
      </ul>
      <div class="v2-sidebar-footer">
        <button class="v2-section-btn v2-signout-btn" onclick="Wren.logout()" aria-label="Sign out" title="Sign out">
          <span class="v2-section-icon" aria-hidden="true" data-wren-icon="logout">🚪</span>
          <span class="v2-section-label">Sign Out</span>
        </button>
      </div>`;
    document.body.insertBefore(sidebar, topbar.nextSibling);
    if (window.WrenIcons) WrenIcons.hydrate(sidebar);

    // Wrap #wren-content in #wren-main
    const contentEl = document.getElementById('wren-content');
    if (contentEl && !document.getElementById('wren-main')) {
      const mainEl = document.createElement('main');
      mainEl.id = 'wren-main';
      mainEl.setAttribute('role', 'main');
      contentEl.parentNode.insertBefore(mainEl, contentEl);
      mainEl.appendChild(contentEl);
    }

    // Group toggle (when sidebar is expanded)
    sidebar.querySelectorAll('.v2-group-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const group    = btn.closest('.v2-mpa-group');
        const children = group.querySelector('.v2-mpa-children');
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', String(!expanded));
        children.hidden = expanded;
      });
    });

    // Hover expand (desktop) — with a grace delay on collapse (2026-07-28, matches the other
    // shell mode) so a quick mouse-out doesn't snap it shut.
    let _mpaCollapseTimer = null;
    sidebar.addEventListener('mouseenter', () => {
      if (_mpaCollapseTimer) { clearTimeout(_mpaCollapseTimer); _mpaCollapseTimer = null; }
      if (window.innerWidth >= 768) sidebar.classList.add('v2-expanded');
    });
    sidebar.addEventListener('mouseleave', () => {
      if (window.innerWidth < 768) return;
      if (_mpaCollapseTimer) clearTimeout(_mpaCollapseTimer);
      _mpaCollapseTimer = setTimeout(() => {
        sidebar.classList.remove('v2-expanded');
        // Collapse non-active groups when sidebar collapses
        sidebar.querySelectorAll('.v2-mpa-group').forEach(g => {
          if (!g.classList.contains('v2-group-active')) {
            const btn = g.querySelector('.v2-group-btn');
            const ul  = g.querySelector('.v2-mpa-children');
            if (btn) btn.setAttribute('aria-expanded', 'false');
            if (ul)  ul.hidden = true;
          }
        });
      }, 450);
    });

    // Mobile hamburger
    const hamburger = topbar.querySelector('#wren-hamburger');
    hamburger.addEventListener('click', () => {
      const open = sidebar.classList.toggle('v2-mobile-open');
      hamburger.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', e => {
      if (window.innerWidth >= 768) return;
      if (!sidebar.contains(e.target) && !hamburger.contains(e.target)) {
        sidebar.classList.remove('v2-mobile-open');
        hamburger.setAttribute('aria-expanded', 'false');
      }
    });

    _wireNotifications(topbar, user);
    _wireMessages(topbar, user);
    _wireWrenAI(topbar);
    _wireAccountMenu(topbar, user, role);
    _wireDrawer();

    ['click', 'keydown', 'touchstart'].forEach(ev => {
      document.addEventListener(ev, () => { if (sessionStorage.getItem(TOKEN_KEY)) Wren._resetSessionTimer(); }, { passive: true });
    });

    _injectFonts();

    // HR: make any wide tables horizontally-contained + card-reflow in mobile mode.
    if (EDITION === 'hr') _hrInitResponsiveTables();

    window._wrenReady = true;
    document.dispatchEvent(new CustomEvent('wren:ready', { detail: { user: Wren.user } }));
    _loadChatWidget(EDITION);
    if (!document.getElementById('wren-vc-btn')) {
      const _vcs = document.createElement('script');
      _vcs.src = '/js/wren-voice-capture.js?v=2026071501';
      document.head.appendChild(_vcs);
    }
    // Feedback/bug-report widget (2026-07-09) — every portal, staff testing phase
    if (!document.getElementById('wfb-btn') && !document.querySelector('script[src^="/js/wren-feedback.js"]')) {
      const _fbs = document.createElement('script');
      _fbs.src = '/js/wren-feedback.js?v=20261020fbv';
      document.head.appendChild(_fbs);
    }
    // First-run setup wizard (2026-07-16) — generic engine; self-guards to portals
    // that register a config (roost/hr). Loaded before the tour for first-run hand-off.
    if (!document.querySelector('script[src^="/js/wren-wizard.js"]')) {
      const _wzs = document.createElement('script');
      _wzs.src = '/js/wren-wizard.js?v=20261009';
      document.head.appendChild(_wzs);
    }
    // First-run guided tour (2026-07-09; generic engine 2026-07-16) — self-guards:
    // installs the ? trigger, auto-offers on first visit, smart-skips hidden modules.
    if (!document.querySelector('script[src^="/js/wren-tour.js"]')) {
      const _trs = document.createElement('script');
      _trs.src = '/js/wren-tour.js?v=20261009';
      document.head.appendChild(_trs);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HR mobile/desktop mode toggle (Prompt 24, 2026-06-29) — HR portal only
  // ─────────────────────────────────────────────────────────────────────────────
  const HR_MODE_KEY = 'wren.hr.mode';                 // 'auto' | 'mobile' | 'desktop'
  const HR_MODES    = ['auto', 'mobile', 'desktop'];
  const HR_MODE_META = {
    auto:    { icon: '🔄', label: 'Auto',    title: 'Layout: Auto (follows screen size). Tap to force Mobile.' },
    mobile:  { icon: '📱', label: 'Mobile',  title: 'Layout: Mobile (compact phone column). Tap to force Desktop.' },
    desktop: { icon: '🖥️', label: 'Desktop', title: 'Layout: Desktop (wide, full width). Tap for Auto.' },
  };
  function _hrGetMode() {
    try { const m = localStorage.getItem(HR_MODE_KEY); return HR_MODES.includes(m) ? m : 'auto'; }
    catch { return 'auto'; }
  }
  function _hrApplySavedMode() {
    const m = _hrGetMode();
    if (m === 'auto') document.body.removeAttribute('data-mode');
    else document.body.setAttribute('data-mode', m);
  }
  function _hrInstallModeToggle(topbar) {
    if (document.getElementById('wren-hr-mode-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'wren-hr-mode-btn';
    btn.className = 'topbar-icon-btn wren-hr-mode-btn';
    btn.type = 'button';
    function _render() {
      const meta = HR_MODE_META[_hrGetMode()];
      btn.innerHTML = `<span aria-hidden="true" style="font-size:1.05rem" data-wren-icon="${WI_KEY(meta)}">${meta.icon}</span><span class="wren-hr-mode-label">${meta.label}</span>`;
      if (window.WrenIcons) WrenIcons.hydrate(btn);
      btn.title = meta.title;
      btn.setAttribute('aria-label', meta.title);
    }
    function _cycle() {
      const cur  = _hrGetMode();
      const next = HR_MODES[(HR_MODES.indexOf(cur) + 1) % HR_MODES.length];
      try { localStorage.setItem(HR_MODE_KEY, next); } catch {}
      _hrApplySavedMode();
      _render();
      if (window.Wren && Wren.toast) {
        Wren.toast('Layout: ' + HR_MODE_META[next].label + (next === 'auto' ? ' — follows screen size' : ' mode'), 'success', 2200);
      }
    }
    btn.addEventListener('click', _cycle);
    _render();
    const notif = topbar.querySelector('#wren-notif-btn');
    if (notif) topbar.insertBefore(btn, notif); else topbar.appendChild(btn);
  }

  // Wrap wide tables for horizontal-scroll containment (no page-level h-scroll) and
  // tag header→cell labels so they can reflow to cards in mobile mode. Purely additive.
  function _hrEnhanceTable(table) {
    if (!table || table.dataset.hrEnhanced) return;
    table.dataset.hrEnhanced = '1';
    if (!(table.parentElement && table.parentElement.classList.contains('wren-hr-tablewrap'))) {
      const wrap = document.createElement('div');
      wrap.className = 'wren-hr-tablewrap';
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    }
    try {
      const heads = [...table.querySelectorAll(':scope > thead th, :scope > thead > tr > th')].map(th => th.textContent.trim());
      if (heads.length) {
        const rows = [...table.querySelectorAll(':scope > tbody > tr')];
        const ok = rows.length && rows.every(r => r.children.length === heads.length);
        if (ok) {
          table.classList.add('wren-hr-reflow');
          rows.forEach(r => [...r.children].forEach((td, i) => {
            if (!td.hasAttribute('data-label') && heads[i]) td.setAttribute('data-label', heads[i]);
          }));
        }
      }
    } catch (e) { /* leave table as plain scroll-wrapped */ }
  }
  function _hrScanTables() {
    const scope = document.getElementById('wren-main') || document.body;
    scope.querySelectorAll('table').forEach(_hrEnhanceTable);
  }
  function _hrInitResponsiveTables() {
    _hrScanTables();
    const target = document.getElementById('wren-main') || document.body;
    let pending = false;
    const obs = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; _hrScanTables(); });
    });
    obs.observe(target, { childList: true, subtree: true });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Shared helpers
  // ─────────────────────────────────────────────────────────────────────────────
  // b230 — where does "View all notifications" go? Roost has the new SPA
  // section; EY has /ey/inbox (a real route in server-unified.js). No other
  // edition has a full notification page — checked, there is no
  // editions/*/public/notifications.html anywhere — so they get NO link rather
  // than one that 404s. Returning null is the signal to omit the footer.
  function _notifCentreHref() {
    if (IS_ADMIN) return `${BASE}/notifications/all`;
    if (EDITION === 'learning' || EDITION === 'ladn' || EDITION === 'eyfs') return '/ey/inbox';
    return null;
  }

  function _wireNotifications(topbar, user) {
    let _notifItems = [];

    async function _refreshNotifCount() {
      try {
        const data = await Wren.api('/api/notifications/unread');
        _notifItems = data.items || [];
        const cnt   = data.count || 0;
        const badge = document.getElementById('wren-notif-count');
        if (badge) { badge.textContent = cnt > 99 ? '99+' : String(cnt); badge.hidden = cnt === 0; }
      } catch {}
    }

    function _relTime(ts) {
      const m = Math.floor((Date.now() - new Date(ts)) / 60000);
      if (m < 1)  return 'Just now';
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      return new Date(ts).toLocaleDateString('en-GB');
    }

    const _esc = s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    Wren._toggleNotifPanel = function () {
      const existing = document.getElementById('wren-notif-panel');
      if (existing) { existing.remove(); return; }
      const catIcon = { repair: '🔧', message: '💬', calendar: '📅', 'action-plan': '📋', safeguarding: '🛡️', medicine: '💊', incident: '🚨', system: 'ℹ️', gmail: '📧', enquiry: '📩', 'waiting-list': '📝' };
      const panel = document.createElement('div');
      panel.id = 'wren-notif-panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Notifications');
      // NOTE: rows are wired with event delegation below (NOT inline onclick). Inline
      // onclick with JSON.stringify(link) broke whenever a link was present, because the
      // double-quotes it emits closed the HTML attribute — so clicks did nothing.
      // b230: the dropdown gained Dismiss all + View all, matching the EyLog
      // shape Toby asked for. Dismiss all is deliberately NOT a silent wipe —
      // POST /dismiss-all fences safeguarding off server-side and reports what
      // it held back, and we then ask before clearing those too.
      panel.innerHTML = `
        <div class="notif-panel-header">
          <span>Notifications</span>
          <span style="display:inline-flex;gap:8px">
            <button class="notif-mark-all" type="button">Mark all read</button>
            <button class="notif-dismiss-all" type="button">Dismiss all</button>
          </span>
        </div>
        <div id="wren-notif-list">
          ${_notifItems.length
            ? _notifItems.map(n => `
                <div class="notif-item ${n.read_at ? 'read' : ''}" data-nid="${n.id}" data-link="${_esc(n.link || '')}" role="button" tabindex="0">
                  <span class="notif-cat">${catIcon[n.category] || '🔔'}</span>
                  <div class="notif-body">
                    <div class="notif-title">${_esc(n.title)}</div>
                    ${n.body ? `<div class="notif-text">${_esc(n.body)}</div>` : ''}
                    <div class="notif-time">${_relTime(n.created_at)}</div>
                  </div>
                  <button class="notif-dismiss" type="button" data-nid="${n.id}" aria-label="Dismiss notification" title="Dismiss">✕</button>
                </div>`).join('')
            : '<div class="notif-empty">All caught up 👍</div>'}
        </div>
        ${_notifCentreHref() ? `<a href="${_notifCentreHref()}" class="notif-view-all" onclick="Wren._gotoNotifCentre(event)">View all notifications →</a>` : ''}`;
      document.body.appendChild(panel);

      panel.querySelector('.notif-mark-all')?.addEventListener('click', e => { e.stopPropagation(); Wren._markAllRead(); });
      panel.querySelector('.notif-dismiss-all')?.addEventListener('click', e => { e.stopPropagation(); Wren._dismissAllNotifs(); });

      const listEl = panel.querySelector('#wren-notif-list');
      listEl?.addEventListener('click', e => {
        const dismissBtn = e.target.closest('.notif-dismiss');
        if (dismissBtn) {
          e.stopPropagation();
          Wren._dismissNotif(parseInt(dismissBtn.dataset.nid, 10), dismissBtn.closest('.notif-item'));
          return;
        }
        const item = e.target.closest('.notif-item');
        if (!item) return;
        Wren._openNotif(parseInt(item.dataset.nid, 10), item.dataset.link || '');
      });
      listEl?.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const item = e.target.closest('.notif-item');
        if (!item || e.target.classList.contains('notif-dismiss')) return;
        e.preventDefault();
        Wren._openNotif(parseInt(item.dataset.nid, 10), item.dataset.link || '');
      });

      // Close on outside click — re-arms itself while clicks land inside the panel,
      // so dismissing a single row doesn't disable the outside-to-close behaviour.
      const outside = e => {
        if (panel.contains(e.target) || document.getElementById('wren-notif-btn')?.contains(e.target)) return;
        panel.remove();
        document.removeEventListener('click', outside);
      };
      setTimeout(() => document.addEventListener('click', outside), 50);
    };

    document.getElementById('wren-notif-btn').addEventListener('click', Wren._toggleNotifPanel);
    document.getElementById('wren-notif-btn').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); Wren._toggleNotifPanel(); } });

    // 2026-10-28 — the URL a section button would go to, so middle-click can open it in a new tab.
    Wren.sectionUrl = function (section, tab) {
      if (!section) return null;
      if (section === GROUP_ROUTE) return `${BASE}/${GROUP_ROUTE}/${tab || ''}`;
      if (!IS_ADMIN) return '/' + section + '.html';
      const def = SECTIONS[section];
      if (!def) return null;
      if (def.href && !(def.tabs && def.tabs.length)) return def.href;
      return `${BASE}/${section}/${tab || (def.tabs && def.tabs[0]) || ''}`;
    };
    if (!document.querySelector('script[src^="/js/wren-middle-click.js"]')) {
      const mc = document.createElement('script'); mc.src = '/js/wren-middle-click.js?v=1'; mc.defer = true;
      document.head.appendChild(mc);
    }

    Wren._gotoNotifCentre = function (ev) {
      if (ev) ev.preventDefault();
      document.getElementById('wren-notif-panel')?.remove();
      const href = _notifCentreHref();
      if (IS_ADMIN && Wren.navigate) Wren.navigate('notifications', 'all');
      else if (href) window.location.href = href;
      return false;
    };

    Wren._openNotif = async function (id, link) {
      try { await Wren.api(`/api/notifications/${id}/read`, { method: 'POST' }); } catch {}
      document.getElementById('wren-notif-panel')?.remove();
      _refreshNotifCount();
      if (link) window.location.href = link;
    };

    Wren._dismissNotif = async function (id, rowEl) {
      try { await Wren.api(`/api/notifications/${id}/dismiss`, { method: 'POST' }); } catch {}
      _notifItems = _notifItems.filter(n => Number(n.id) !== Number(id));
      if (rowEl) rowEl.remove();
      const badge = document.getElementById('wren-notif-count');
      if (badge) { const left = _notifItems.length; badge.textContent = left > 99 ? '99+' : String(left); badge.hidden = left === 0; }
      const listEl = document.getElementById('wren-notif-list');
      if (listEl && !_notifItems.length) listEl.innerHTML = '<div class="notif-empty">All caught up 👍</div>';
      _refreshNotifCount();
    };

    Wren._markAllRead = async function () {
      try { await Wren.api('/api/notifications/read-all', { method: 'POST' }); } catch {}
      document.getElementById('wren-notif-panel')?.remove();
      _refreshNotifCount();
    };

    // b230 — "Dismiss all". The server excludes safeguarding by default and
    // tells us how many it kept back; only an explicit yes clears those, so a
    // safeguarding concern can never be wiped by a tidy-up tap.
    Wren._dismissAllNotifs = async function () {
      try {
        const r = await Wren.api('/api/notifications/dismiss-all', { method: 'POST', body: {} });
        if (r && r.safeguarding_held_back > 0) {
          const msg = r.safeguarding_held_back + ' safeguarding notification(s) were NOT dismissed.\n\n'
                    + 'Dismiss those as well? The safeguarding records themselves are not affected.';
          if (window.confirm(msg)) {
            await Wren.api('/api/notifications/dismiss-all', { method: 'POST', body: { include_safeguarding: true } });
          }
        }
        if (Wren.toast) Wren.toast('Notifications cleared', 'success');
      } catch (e) { if (Wren.toast) Wren.toast('Could not dismiss: ' + e.message, 'error'); }
      document.getElementById('wren-notif-panel')?.remove();
      _notifItems = [];
      _refreshNotifCount();
    };

    _refreshNotifCount();
    setInterval(_refreshNotifCount, 30000);
  }

  // ── b150: Messages envelope (topbar) ────────────────────────────────────────
  // Reuses the existing role-scoped GET /api/messages/threads (same endpoint the
  // EY app-shell dropdown already uses). Not rendered on HR (no messages button
  // in the HR markup — see topbar template) since HR staff shouldn't see
  // child-linked family comms on a personal device. Idempotent: no-ops if the
  // button isn't in the DOM for this edition.
  function _wireMessages(topbar, user) {
    const btn = document.getElementById('wren-msg-btn');
    if (!btn) return;

    const viewAllHref = IS_ADMIN ? `${BASE}/communications/messaging` : '/communications.html';
    const _esc = s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const _relTime = ts => {
      const m = Math.floor((Date.now() - new Date(ts)) / 60000);
      if (m < 1)  return 'Just now';
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      return new Date(ts).toLocaleDateString('en-GB');
    };

    let _threads = [];

    async function _refreshMsgCount() {
      try {
        const data = await Wren.api('/api/messages/threads');
        _threads = (data && data.threads) || (Array.isArray(data) ? data : []);
        const n = _threads.reduce((a, t) => a + (parseInt(t.unread_count, 10) || 0), 0);
        const badge = document.getElementById('wren-msg-count');
        if (badge) { badge.textContent = n > 99 ? '99+' : String(n); badge.hidden = n === 0; }
      } catch {}
    }

    Wren._toggleMsgPanel = function () {
      const existing = document.getElementById('wren-msg-panel');
      if (existing) { existing.remove(); return; }
      const top8 = _threads.slice(0, 8);
      const panel = document.createElement('div');
      panel.id = 'wren-msg-panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Messages');
      panel.innerHTML = `
        <div class="notif-panel-header">
          <span>Messages</span>
          <span style="display:flex;gap:10px">
            <button class="notif-mark-all" id="wren-msg-markall" type="button">Mark all read</button>
            <button class="notif-mark-all" id="wren-msg-clear" type="button">Clear</button>
          </span>
        </div>
        <div id="wren-msg-list">
          ${top8.length
            ? top8.map(t => {
                const unread = parseInt(t.unread_count, 10) || 0;
                return `
                <div class="notif-item ${unread ? 'msg-unread' : ''}" data-tid="${t.id}" role="button" tabindex="0">
                  <span class="notif-cat">💬</span>
                  <div class="notif-body">
                    <div class="notif-title">${_esc(t.child_name || t.subject || 'Thread')}</div>
                    ${t.subject && t.child_name ? `<div class="notif-text">${_esc(t.subject)}</div>` : ''}
                    ${t.last_message ? `<div class="notif-text">${_esc(String(t.last_message).slice(0, 70))}</div>` : ''}
                    <div class="notif-time">${_relTime(t.last_message_at || t.created_at)}</div>
                  </div>
                </div>`;
              }).join('')
            : '<div class="notif-empty">💬 No message threads yet</div>'}
        </div>
        <a href="${viewAllHref}" id="wren-msg-viewall" class="notif-view-all" onclick="Wren.navigate('${viewAllHref}');return false">View all →</a>`;
      document.body.appendChild(panel);

      panel.querySelector('#wren-msg-markall')?.addEventListener('click', e => { e.stopPropagation(); Wren._markAllMsgRead(); });
      panel.querySelector('#wren-msg-clear')?.addEventListener('click', e => { e.stopPropagation(); Wren._clearMsgThreads(); });

      const listEl = panel.querySelector('#wren-msg-list');
      const _go = tid => { panel.remove(); Wren.navigate(`${viewAllHref}?thread=${tid}`); };
      listEl?.addEventListener('click', e => {
        const item = e.target.closest('.notif-item');
        if (!item) return;
        _go(item.dataset.tid);
      });
      listEl?.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const item = e.target.closest('.notif-item');
        if (!item) return;
        e.preventDefault();
        _go(item.dataset.tid);
      });

      const outside = e => {
        if (panel.contains(e.target) || btn.contains(e.target)) return;
        panel.remove();
        document.removeEventListener('click', outside);
      };
      setTimeout(() => document.addEventListener('click', outside), 50);
    };

    // Esc dismisses the messages dropdown (matches notif panel convention).
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') document.getElementById('wren-msg-panel')?.remove();
    });

    btn.addEventListener('click', Wren._toggleMsgPanel);
    btn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); Wren._toggleMsgPanel(); } });

    // "Mark all read" — no bulk endpoint exists; loop the existing per-thread
    // /thread/:id/read (same one the full messages page uses).
    Wren._markAllMsgRead = async function () {
      const unread = _threads.filter(t => (parseInt(t.unread_count, 10) || 0) > 0);
      try { await Promise.all(unread.map(t => Wren.api(`/api/messages/thread/${t.id}/read`, { method: 'POST' }))); } catch {}
      document.getElementById('wren-msg-panel')?.remove();
      _refreshMsgCount();
    };

    // "Clear" — archives every thread currently shown (per-user archive flag,
    // never deletes a message; same endpoint the full messages page's archive
    // action uses). Threads reappear if a new reply arrives.
    Wren._clearMsgThreads = async function () {
      const shown = _threads.slice(0, 8);
      try { await Promise.all(shown.map(t => Wren.api(`/api/messages/thread/${t.id}/archive`, { method: 'POST' }))); } catch {}
      document.getElementById('wren-msg-panel')?.remove();
      _refreshMsgCount();
    };

    _refreshMsgCount();
    setInterval(_refreshMsgCount, 30000);
  }

  // ── b150: Wren AI topbar button ─────────────────────────────────────────────
  // Opens the SAME chat surface as the existing floating widget (wren-chat.js /
  // window.WrenChat) — never builds a second chat. The widget is already being
  // loaded/inited by this shell's own _loadChatWidget() call earlier in init, so
  // by the time anyone clicks this it's normally instant; the poll below just
  // covers the (rare) case of a very fast click before that script finishes.
  function _wireWrenAI(topbar) {
    const btn = document.getElementById('wren-ai-btn');
    if (!btn) return;
    function _tryOpen(attemptsLeft) {
      if (window.WrenChat) {
        if (!WrenChat.isReady()) WrenChat.init({});   // idempotent — builds the widget if not built yet
        if (WrenChat.isReady()) { WrenChat.open(); return; }
      }
      if (attemptsLeft <= 0) return;
      setTimeout(() => _tryOpen(attemptsLeft - 1), 150);
    }
    btn.addEventListener('click', () => _tryOpen(20));
  }

  /* b232 — the "what needs me" traffic lights in the Roost topbar.
     They sit here rather than on login.html because login.html redirects the
     instant it holds a valid token: a strip there would never be on screen long
     enough to read. The topbar IS the landing page, whichever section the shell
     lands on after sign-in.

     Loaded lazily and only on the admin portal — /api/attention is Roost-only —
     and everything here is best-effort. A failed fetch, a missing script or a
     403 all render nothing at all rather than an error; see rule 2 in
     wren-attention-lights.js. */
  /* b504 (2026-10-17) — the "My list 1/3 · 9d" chip beside the lights. Same two rules as the lights:
     one lazy compact call after paint (countdown + today's count only), and failure renders nothing.
     The chip is the one-click way back to the list from any Roost page. */
  function _wireMyListChip(topbar) {
    const slot = topbar.querySelector('#wren-mylist-chip');
    if (!slot) return;
    if (/^(ey|hr|parents)\.example-nursery\.co\.uk$|^(cc|htps)-(hr|parents)\.getwren\.co\.uk$/i.test(location.hostname)) { slot.remove(); return; }
    const go = () => { try { window.WrenMyList.chip(slot); } catch (e) { /* silent by design */ } };
    if (window.WrenMyList) { go(); return; }
    const sc = document.createElement('script');
    sc.src = '/js/wren-mylist.js?v=b504';
    sc.onload = go;
    sc.onerror = () => { /* nothing renders */ };
    document.head.appendChild(sc);
  }

  /* 28 Oct 2026 — deadline banners. Toby: "When things like this go past due date
     I need a banner reminder." Same audience as the attention lights (Roost,
     managers — the slot below exists only then), same rules: one lazy call after
     wren:ready, failure renders nothing, never inside an embedded iframe. The strip
     goes at the top of #wren-main, above #section-content, so SPA section changes
     do not wipe it. Choices: Roost → Signals → "Show as a banner". */
  function _wireDeadlineBanner(topbar) {
    if (!topbar.querySelector('#wren-attention-lights')) return;
    if (/^(ey|hr|parents)\.example-nursery\.co\.uk$|^(cc|htps)-(hr|parents)\.getwren\.co\.uk$/i.test(location.hostname)) return;
    try { if (window.self !== window.top) return; } catch (e) { return; }
    const go = () => {
      try { window.WrenDeadlineBanner.mount(document.getElementById('wren-main')); } catch (e) { /* silent by design */ }
    };
    const load = () => {
      if (window.WrenDeadlineBanner) { go(); return; }
      const sc = document.createElement('script');
      sc.src = '/js/wren-deadline-banner.js?v=20261028';
      sc.onload = go;
      sc.onerror = () => { /* nothing renders */ };
      document.head.appendChild(sc);
    };
    if (Wren.user) setTimeout(load, 0);
    else document.addEventListener('wren:ready', load, { once: true });
  }

  function _wireAttentionLights(topbar) {
    const slot = topbar.querySelector('#wren-attention-lights');
    if (!slot) return;
    // 2026-10-08: shared pages with no wren-edition meta (e.g. /notifications.html)
    // default EDITION to 'admin', so the EY and HR portals asked /api/attention and got
    // a 403 forbidden_portal in the console. Those hosts are never Roost.
    if (/^(ey|hr|parents)\.example-nursery\.co\.uk$|^(cc|htps)-(hr|parents)\.getwren\.co\.uk$/i.test(location.hostname)) { slot.remove(); return; }
    const go = () => {
      try { window.WrenAttentionLights.mount(slot, { compact: true }); } catch (e) { /* silent by design */ }
    };
    if (window.WrenAttentionLights) { go(); return; }
    const sc = document.createElement('script');
    sc.src = '/js/wren-attention-lights.js?v=b232';
    sc.onload = go;
    sc.onerror = () => { /* nothing renders */ };
    document.head.appendChild(sc);
  }

  function _wireAccountMenu(topbar, user, role) {
    Wren._showUserMenu = function () {
      const existing = document.getElementById('user-menu-popup');
      if (existing) { existing.remove(); return; }
      const popup = document.createElement('div');
      popup.id = 'user-menu-popup';
      popup.setAttribute('role', 'menu');
      const ls = 'display:flex;align-items:center;gap:10px;padding:10px 12px;font-size:.875rem;color:var(--c-text);text-decoration:none;border-radius:6px;cursor:pointer;background:none;border:none;width:100%;text-align:left;font-family:inherit;transition:background .15s;white-space:nowrap;';
      const hs = `onmouseenter="this.style.background='rgba(74,154,191,.12)'" onmouseleave="this.style.background=''"`;
      const profileHref = IS_ADMIN ? '/my-profile.html' : (EDITION === 'hr' ? '/my-profile.html' : '/profile.html');
      popup.innerHTML = `
        <div style="padding:8px 12px 6px;border-bottom:1px solid var(--c-border);font-size:.82rem;color:var(--c-muted);font-weight:600">${user.name || 'User'} <span style="font-weight:400">(${role})</span></div>
        <a href="${profileHref}" style="${ls}" ${hs} role="menuitem">👤 My Profile</a>
        <a href="/ey-legacy/totp-setup.html"  style="${ls}" ${hs} role="menuitem">🔐 Two-Factor Auth</a>
        ${IS_ADMIN ? `
        <a href="/settings/index.html"    style="${ls}" ${hs} role="menuitem">⚙️ Settings</a>
        <a href="/admin/system/tech"        style="${ls}" ${hs} role="menuitem">💻 IT Settings</a>
        <a href="/admin/permissions" style="${ls}" ${hs} role="menuitem">🛡️ Permissions</a>
        <a href="/admin/system/approvals"   style="${ls}" ${hs} role="menuitem">✅ Approvals</a>` : ''}
        <div style="border-top:1px solid var(--c-border);margin:4px 0"></div>
        <button onclick="Wren.logout()" style="${ls}color:var(--c-red);" ${hs} role="menuitem">🚪 Sign Out</button>`;
      popup.style.cssText = 'position:fixed;top:56px;right:12px;background:var(--c-card);border:1px solid var(--c-border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.5);padding:8px;z-index:9000;min-width:210px;';
      document.body.appendChild(popup);
      setTimeout(() => document.addEventListener('click', e => { if (!popup.contains(e.target)) popup.remove(); }, { once: true }), 50);
    };
    document.getElementById('wren-account-btn').addEventListener('click', Wren._showUserMenu);
  }

  function _wireDrawer() {
    let _drawerEl = null;

    function _open(content, title) {
      _close();
      _drawerEl = document.createElement('div');
      _drawerEl.className = 'wren-drawer';
      _drawerEl.setAttribute('role', 'dialog');
      _drawerEl.setAttribute('aria-modal', 'true');
      _drawerEl.setAttribute('aria-label', title || 'Details');
      _drawerEl.innerHTML = `
        <div class="drawer-backdrop"></div>
        <div class="drawer-panel" tabindex="-1">
          <div class="drawer-header">
            <span class="drawer-title">${title || ''}</span>
            <button class="drawer-close" aria-label="Close">✕</button>
          </div>
          <div class="drawer-body"></div>
        </div>`;
      const body = _drawerEl.querySelector('.drawer-body');
      if (typeof content === 'string') body.innerHTML = content;
      else if (content instanceof Element) body.appendChild(content);
      document.body.appendChild(_drawerEl);
      document.body.classList.add('drawer-open');
      requestAnimationFrame(() => _drawerEl.classList.add('open'));
      _drawerEl.querySelector('.drawer-backdrop').addEventListener('click', _close);
      _drawerEl.querySelector('.drawer-close').addEventListener('click', _close);
      _drawerEl.querySelector('.drawer-panel').focus();
    }

    function _close() {
      if (!_drawerEl) return;
      _drawerEl.classList.remove('open');
      document.body.classList.remove('drawer-open');
      const el = _drawerEl;
      setTimeout(() => el.remove(), 260);
      _drawerEl = null;
    }

    document.addEventListener('keydown', e => { if (e.key === 'Escape' && _drawerEl) _close(); });

    _openDrawerFn  = _open;
    _closeDrawerFn = _close;
    Wren.openDrawer  = (c, t) => _open(c, t);
    Wren.closeDrawer = () => _close();
  }

  function _injectFonts() {
    if (document.querySelector('link[data-wren-fonts]')) return;
    const pc = document.createElement('link'); pc.rel = 'preconnect'; pc.href = 'https://fonts.gstatic.com'; pc.crossOrigin = 'anonymous'; document.head.appendChild(pc);
    const fl = document.createElement('link'); fl.rel = 'stylesheet'; fl.href = 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=DM+Sans:wght@400;500;600&display=swap'; fl.setAttribute('data-wren-fonts', '1'); document.head.appendChild(fl);
  }

  // ── PWA installability (b148) ────────────────────────────────────────────────
  // wren-shell-v2.js is the shared shell for admin/primary/secondary/eyfs app.html +
  // login/legacy pages — every page that loads this script gets the manifest link,
  // iOS meta tags and an SW registration for free, idempotently. Each origin/portal
  // serves its OWN manifest.webmanifest + sw.js (hostname/edition static dispatch),
  // so the plain relative '/manifest.webmanifest' + '/sw.js' URLs always resolve to
  // the right file — no per-edition branching needed for the URLs themselves.
  // b297 — hr was 'Your Nursery HR'. This file is shared by every tenant, so
  // that string was the home-screen name a prospect got when installing the
  // demo. The others were already setting-neutral; hr now matches them.
  const PWA_TITLES = { admin: 'Roost', eyfs: 'Wren EYFS', primary: 'Wren Primary', secondary: 'Wren Secondary', hr: 'Seed' };   // 2026-11-01 — the product names (Roost/Nest/Seed), as the install bar says
  function _ensurePWA() {
    try {
      const head = document.head;
      const ensureLink = (rel, href, extra) => {
        if (head.querySelector(`link[rel="${rel}"]`)) return;
        const l = document.createElement('link'); l.rel = rel; l.href = href;
        if (extra) Object.keys(extra).forEach(k => l.setAttribute(k, extra[k]));
        head.appendChild(l);
      };
      const ensureMeta = (name, content) => {
        if (head.querySelector(`meta[name="${name}"]`)) return;
        const m = document.createElement('meta'); m.name = name; m.content = content; head.appendChild(m);
      };
      ensureLink('manifest', '/manifest.webmanifest');
      // 2026-11-01 — every edition now serves its own square /icons/apple-touch-icon.png (was the
      // non-square Your Nursery logo, which also put the nursery's logo on the school demos).
      ensureLink('apple-touch-icon', '/icons/apple-touch-icon.png', { sizes: '180x180' });
      ensureMeta('theme-color', '#080f1e');
      ensureMeta('apple-mobile-web-app-capable', 'yes');
      ensureMeta('apple-mobile-web-app-status-bar-style', 'black-translucent');
      ensureMeta('apple-mobile-web-app-title', PWA_TITLES[EDITION] || 'Wren');
      ensureMeta('mobile-web-app-capable', 'yes');
      // 2026-11-01 — iPhones never offer to install; the "Add to Home Screen" bar (wren-install.js).
      if (!head.querySelector('script[src^="/js/wren-install.js"]')) {
        const s = document.createElement('script'); s.src = '/js/wren-install.js?v=20261101'; s.defer = true; head.appendChild(s);
      }
    } catch (e) { /* non-fatal */ }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then(() => _syncPushSubscription(false))   // re-sync silently if already granted
        .catch(err => console.warn('[wren-shell-v2] SW registration failed', err));
    }
  }

  // ── Web Push (b149 — Roost gets the same opt-in the EY/HR shell already has) ──
  function _urlB64ToUint8(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const s = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(s); const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  // b230 — the boot-time silent re-sync and an explicit "Enable on this device"
  // tap can land at the same moment. Both then see getSubscription() === null
  // and both call subscribe(), which leaves TWO endpoints for one device: a
  // duplicate push, and a stale row that only clears when the push service
  // eventually 410s it. One shared in-flight promise removes the race.
  let _pushSyncInFlight = null;
  function _syncPushSubscription(force) {
    if (_pushSyncInFlight) return _pushSyncInFlight;
    _pushSyncInFlight = _doSyncPushSubscription(force)
      .finally(() => { _pushSyncInFlight = null; });
    return _pushSyncInFlight;
  }
  async function _doSyncPushSubscription(force) {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
      // 29 Oct: nobody signed in yet (the login pages load this shell too). The re-sync's 401
      // called Wren.logout(), which reloaded the login page, which re-synced again: a phone that
      // had ever allowed Wren notifications reloaded ~9 times a second and could not be typed in.
      if (!sessionStorage.getItem(TOKEN_KEY)) return;
      if (Notification.permission === 'denied') return;
      if (Notification.permission === 'default') {
        if (!force) return;                       // never auto-prompt — only on explicit opt-in
        if ((await Notification.requestPermission()) !== 'granted') return;
      }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const k = await Wren.api('/api/notifications/vapid-public-key').catch(() => null);
        if (!k || !k.key) return;
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: _urlB64ToUint8(k.key) });
      }
      await Wren.api('/api/notifications/push-subscribe', { method: 'POST', body: { subscription: sub, user_agent: navigator.userAgent } });
      if (force && window.Wren && Wren.toast) Wren.toast('Notifications enabled on this device', 'success');
    } catch (e) { console.warn('[wren-push] subscribe failed', e); }
  }

  /* ── Front door (2026-08-21) ────────────────────────────────────────────────
     Moved off the EY home page into the top bar so it is one tap from ANY page —
     a doorbell you have to scroll to find is no use when someone is at the door.
     The button stays hidden unless a door device is actually configured, so
     settings without a VTO never see it. Polls the recent door_events feed; on a
     new ring it badges the icon and plays a short tone on the tablet. Every path
     swallows its own errors — the doorbell must never break the shell. */
  (function () {
    if (EDITION !== 'learning') return;
    var btn, badge, lastSeen = null, ringing = false, audio = null;
    function tone() {
      try {
        var C = window.AudioContext || window.webkitAudioContext; if (!C) return;
        audio = audio || new C();
        if (audio.state === 'suspended') audio.resume();
        [0, 0.32].forEach(function (off) {
          var o = audio.createOscillator(), g = audio.createGain();
          o.type = 'sine'; o.frequency.value = off ? 660 : 880;
          g.gain.setValueAtTime(0.0001, audio.currentTime + off);
          g.gain.exponentialRampToValueAtTime(0.22, audio.currentTime + off + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + off + 0.28);
          o.connect(g); g.connect(audio.destination);
          o.start(audio.currentTime + off); o.stop(audio.currentTime + off + 0.3);
        });
      } catch (e) { /* audio blocked until first interaction — badge still shows */ }
    }
    function ring(ev) {
      if (ringing) return;
      ringing = true;
      badge.hidden = false; badge.textContent = '!';
      btn.style.animation = 'wrenDoorPulse 1s ease-in-out 6';
      tone();
      try { Wren.toast('🚪 Someone is at the front door', 'info', 8000); } catch (e) {}
      setTimeout(function () { ringing = false; btn.style.animation = ''; }, 6000);
    }
    function poll() {
      Wren.api('/api/door/events?limit=1&type=ring').then(function (d) {
        // /api/door/events returns a bare array (checked against the route).
        var rows = Array.isArray(d) ? d : ((d && (d.events || d.rows)) || []);
        if (!rows.length) return;
        var newest = rows[0].id || rows[0].created_at;
        if (lastSeen !== null && newest !== lastSeen) ring(rows[0]);
        lastSeen = newest;
      }).catch(function () { /* endpoint may not exist yet — stay quiet */ });
    }
    function boot() {
      btn = document.getElementById('wren-door-btn');
      badge = document.getElementById('wren-door-badge');
      if (!btn) return;
      btn.addEventListener('click', function () { window.location.href = '/ey/door'; });
      Wren.api('/api/door/config').then(function (cfg) {
        if (!cfg || !cfg.device_configured) return;   // no VTO → button stays hidden
        btn.hidden = false;
        poll();
        setInterval(poll, 15000);
      }).catch(function () { /* leave hidden */ });
    }
    document.addEventListener('wren:ready', boot);
  })();

  window.Wren.enablePush = function () { return _syncPushSubscription(true); };

  // ── Entry point ───────────────────────────────────────────────────────────────
  const _buildShell = IS_ADMIN ? buildShellSPA : buildShellMPA;
  const _init = () => {
    // When this page is loaded INSIDE an iframe (e.g. Staff → Rota tab embeds /rota.html),
    // skip building the nav/topbar — the parent already has chrome. Prevents double-chrome.
    // BUT we MUST still parse the user + fire wren:ready, or embedded pages that wait for
    // wren:ready to start loading hang on "Loading…" forever (build-77 regression that
    // stuck the Rota builder and any other iframe module). No chrome, just the init signal.
    if (window.self !== window.top) {
      document.body.classList.add('wren-embedded', 'v2-shell');
      try {
        const token = sessionStorage.getItem(TOKEN_KEY);
        if (token) { Wren._parseUser(); Wren._resetSessionTimer(); }
      } catch (e) { /* no token in the iframe context — parent handles auth */ }
      document.dispatchEvent(new CustomEvent('wren:ready', { detail: { user: Wren.user, embedded: true } }));
      return;
    }
    _ensurePWA();
    // Fetch this setting's sidebar layout BEFORE building, so the sidebar renders once in
    // its final shape rather than flashing the default and re-ordering. Capped so a slow
    // or dead endpoint can never hold the shell hostage — 1.2s then build regardless.
    let _built = false;
    const _go = () => { if (!_built) { _built = true; _buildShell(); } };
    const _cap = setTimeout(_go, 1200);
    // b242 — the per-role overrides are fetched in the SAME window as the setting
    // layout, not after it, so customising the nav costs no extra boot latency. The
    // 1.2s cap covers both: if either is slow the shell builds with the default.
    Promise.all([_loadSettingNav(), _loadNavOverrides()]).finally(() => { clearTimeout(_cap); _go(); });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _init);
  else _init();

})();

// ── b164 (2026-07-27): activity beacons — page views, clicks, session end ─────
// Feeds POST /api/audit/beacon so the manager's audit/usage page can answer
// "how long are staff using it, and are they using it correctly?". Batched
// (15s / 20 events / pagehide), fire-and-forget, no-ops when signed out.
(function () {
  var q = [], t0 = Date.now(), flushTimer = null;
  // 2026-10-29 (log-watch 8/9): a view-as session is read-only and a two-factor set-up or
  // challenge token only reaches /api/auth/*, so both get a 403 here by design — and the
  // clicks aren't the signed-in person's to record. Don't send for either.
  function tok() {
    var t = null;
    try { t = sessionStorage.getItem('wrenToken'); } catch (e) { return null; }
    if (!t || (window.__wrenViewAs && window.__wrenViewAs.active)) return null;
    try {
      var p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (p && (p.vas || p.scope === 'totp_only' || p.scope === 'totp_enroll_required')) return null;
    } catch (e) { /* not a JWT we can read — send as before */ }
    return t;
  }
  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    var t = tok();
    if (!q.length || !t) { q = []; return; }
    var events = q.splice(0, 50);
    try {
      fetch('/api/audit/beacon', {
        method: 'POST', keepalive: true,
        headers: window.__wrenShellHeaders(t, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ events: events })
      }).catch(function () {});
    } catch (e) { /* never break the page */ }
  }
  function push(ev) {
    if (!tok()) return;
    q.push(ev);
    if (q.length >= 20) flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, 15000);
  }
  push({ t: 'page_view', page: location.pathname });
  document.addEventListener('wren:section-loaded', function (e) {
    push({ t: 'page_view', page: '/admin/' + ((e.detail && e.detail.section) || '') });
  });
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest && e.target.closest('a,button,[role="button"],[role="tab"]');
    if (!el) return;
    // b345: anything inside [data-no-audit] is never recorded. The anonymous "tell management"
    // card uses it — a click label logged against the signed-in person would name the writer.
    if (el.closest('[data-no-audit]')) return;
    var label = (el.getAttribute('aria-label') || el.title || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 48);
    if (!label) label = el.id || (el.className && String(el.className).slice(0, 30)) || '?';
    push({ t: 'click', label: label, page: location.pathname });
  }, true);
  window.addEventListener('pagehide', function () {
    push({ t: 'session_end', page: location.pathname, dur_s: (Date.now() - t0) / 1000 });
    flush();
  });
})();

/* ── Manager-away banner (2026-08-04) — self-contained, appended to portal shell.
   Fetches /api/away-mode/banner and shows a dismissible top bar when away mode is
   active + show_banner is on. Wrapped so it can never break the shell. */
(function () {
  try {
    function tok(){ try { return sessionStorage.getItem("wrenToken") || localStorage.getItem("wrenToken"); } catch(e){ return null; } }
    function esc(s){ return String(s||"").replace(/[<>&]/g, c=>({ "<":"&lt;",">":"&gt;","&":"&amp;" }[c])); }
    function render(d){
      if (!d || !d.show) return;
      if (document.getElementById("wren-away-banner")) return;
      var msg = "\u{1F3D6}️ Manager away" + (d.return_date ? " until " + esc(d.return_date) : "")
              + (d.cover_name ? " — " + esc(d.cover_name) + " (" + esc(d.cover_role||"deputy") + ") is covering" : "") + ".";
      var bar = document.createElement("div");
      bar.id = "wren-away-banner";
      bar.setAttribute("role","status");
      bar.style.cssText = "position:sticky;top:0;left:0;right:0;z-index:900;display:flex;align-items:center;justify-content:center;gap:12px;"
        + "padding:8px 14px;background:#7c2d12;color:#fed7aa;font-size:.82rem;font-weight:600;line-height:1.3;text-align:center;border-bottom:1px solid #9a3412";
      var span = document.createElement("span"); span.textContent = msg;
      var x = document.createElement("button"); x.textContent = "×";
      x.setAttribute("aria-label","Dismiss");
      x.style.cssText = "background:none;border:none;color:#fed7aa;font-size:1.1rem;cursor:pointer;line-height:1;padding:0 4px";
      x.onclick = function(){ try{ sessionStorage.setItem("wrenAwayBannerHidden","1"); }catch(e){} bar.remove(); };
      bar.appendChild(span); bar.appendChild(x);
      document.body.insertBefore(bar, document.body.firstChild);
    }
    function go(){
      try { if (sessionStorage.getItem("wrenAwayBannerHidden")==="1") return; } catch(e){}
      var t = tok(); if (!t) return;
      fetch("/api/away-mode/banner", { headers: window.__wrenShellHeaders(t) })
        .then(function(r){ return r.ok ? r.json() : null; }).then(render).catch(function(){});
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go();
  } catch (e) { /* never break the shell */ }
})();

/* ── b311 (2026-09-10) — “What were you trying to find?” ─────────────────────
   Toby: "if it's seen that she's clicked on 4 Wrong Things it can pop up and say
   what are you trying to find."

   THE RULES THIS BLOCK EXISTS TO KEEP, in the order they were given:
     · an OFFER, in the corner — never a modal, never blocking, never focus-stealing
     · dismissible, and dismissing it ends it for the session
     · never more than once a session (the server allows twice a day; this is the
       tighter of the two limits and it is deliberately enforced here as well)
     · if they type an answer, route it to search

   WHY IT ASKS THE SERVER AT ALL. The page could count its own navigation and
   decide by itself, but then the threshold would live in two places and the
   decision would rest on what the tab remembers rather than on what was
   recorded. So the browser only notices a BURST — cheap, local, no request —
   and the server makes the call from the b164 beacons already in audit_log.
   One request per burst, and only after a burst.

   Everything is wrapped so it can never break a page. If the endpoint 404s (an
   edition without the b311 router) this silently does nothing at all. */
(function () {
  try {
    var TOKEN_KEY = 'wrenToken';
    var SESSION_FLAG = 'wrenNudgeDone';
    var BURST_KEY = 'wrenNudgeBurst';
    var BURST_WINDOW_MS = 120000;   // matches the server default; the server decides
    var BURST_MIN = 4;
    var asking = false;

    function tok() { try { return sessionStorage.getItem(TOKEN_KEY) || null; } catch (e) { return null; } }
    function done() { try { return sessionStorage.getItem(SESSION_FLAG) === '1'; } catch (e) { return true; } }
    function markDone() { try { sessionStorage.setItem(SESSION_FLAG, '1'); } catch (e) {} }
    function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]; }); }
    function portal() {
      var m = document.querySelector('meta[name="wren-edition"]');
      var e = (m && m.getAttribute('content')) || '';
      return { admin: 'roost', eyfs: 'ey', ey: 'ey', parents: 'parents', hr: 'hr' }[e] || '';
    }
    function headers() {
      var t = tok();
      return Object.assign({ 'Content-Type': 'application/json' },
        t ? { Authorization: 'Bearer ' + t } : {},
        (function () { try { var d = localStorage.getItem('wrenDevice');
          return d ? { 'X-Wren-Device': d } : {}; } catch (e) { return {}; } })());
    }

    function card(offer) {
      if (document.getElementById('wren-nudge')) return;
      var box = document.createElement('div');
      box.id = 'wren-nudge';
      box.setAttribute('role', 'complementary');       // NOT dialog — nothing is trapped
      box.setAttribute('aria-label', 'Wren offering help');
      box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:880;width:min(320px,calc(100vw - 32px));'
        + 'background:var(--c-surface);color:var(--c-text);border:1px solid var(--c-border);'
        + 'border-left:4px solid var(--c-blue);border-radius:12px;padding:13px 14px;'
        + 'box-shadow:0 8px 28px rgba(0,0,0,.28);font-size:.85rem;line-height:1.55';
      box.innerHTML =
        '<div style="display:flex;gap:8px;align-items:flex-start">'
      +   '<div style="flex:1 1 auto">'
      +     '<div style="font-weight:700">' + esc(offer.question) + '</div>'
      +     '<div style="font-size:.76rem;color:var(--c-muted);margin-top:4px">I noticed ' + esc(offer.saw) + '.</div>'
      +   '</div>'
      +   '<button type="button" id="wren-nudge-x" aria-label="No thanks" '
      +     'style="background:none;border:none;color:var(--c-muted);font-size:1.15rem;line-height:1;'
      +     'cursor:pointer;padding:0 2px;font-family:inherit">×</button>'
      + '</div>'
      + '<form id="wren-nudge-form" style="display:flex;gap:6px;margin-top:9px">'
      +   '<input id="wren-nudge-q" type="text" maxlength="200" autocomplete="off" placeholder="In your own words…" '
      +     'style="flex:1 1 auto;min-width:0;background:var(--c-bg);border:1px solid var(--c-border);'
      +     'color:var(--c-text);border-radius:8px;padding:7px 10px;font-size:.83rem;font-family:inherit;min-height:36px">'
      +   '<button type="submit" style="background:var(--c-blue);border:1px solid var(--c-blue);color:var(--c-navy);'
      +     'border-radius:8px;padding:7px 12px;font-size:.8rem;cursor:pointer;font-family:inherit;min-height:36px">Find it</button>'
      + '</form>'
      + '<div id="wren-nudge-out" style="margin-top:8px"></div>';
      document.body.appendChild(box);

      function close(tellServer) {
        markDone();
        if (tellServer) {
          try { fetch('/api/signals/nudge/' + offer.id + '/dismiss',
            { method: 'POST', headers: headers(), keepalive: true }).catch(function () {}); } catch (e) {}
        }
        box.remove();
      }
      document.getElementById('wren-nudge-x').addEventListener('click', function () { close(true); });

      document.getElementById('wren-nudge-form').addEventListener('submit', function (ev) {
        ev.preventDefault();
        var q = document.getElementById('wren-nudge-q').value.trim();
        var out = document.getElementById('wren-nudge-out');
        if (q.length < 2) { out.innerHTML = '<span style="color:var(--c-muted);font-size:.78rem">A word or two more.</span>'; return; }
        out.innerHTML = '<span style="color:var(--c-muted);font-size:.78rem">Looking…</span>';
        fetch('/api/signals/nudge/' + offer.id + '/answer',
          { method: 'POST', headers: headers(), body: JSON.stringify({ answer: q, portal: portal() }) })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            markDone();
            var hits = (d && d.destinations) || [];
            if (!hits.length) {
              out.innerHTML = '<span style="color:var(--c-muted);font-size:.78rem">'
                + 'I could not match that to a screen — but it is written down, and it will be on the Signals page for the manager to see.</span>';
              return;
            }
            out.innerHTML = hits.map(function (h) {
              return '<a href="' + esc(h.url) + '" style="display:block;padding:6px 8px;margin-top:4px;'
                + 'border:1px solid var(--c-border);border-radius:8px;color:var(--c-text);text-decoration:none;font-size:.81rem">'
                + '<b>' + esc(h.title) + '</b>'
                + (h.what ? '<div style="color:var(--c-muted);font-size:.74rem;margin-top:2px">' + esc(h.what) + '</div>' : '')
                + (h.status && h.status !== 'ok' && h.issue
                    ? '<div style="color:var(--c-amber);font-size:.72rem;margin-top:3px">Heads up — ' + esc(h.issue) + '</div>' : '')
                + '</a>';
            }).join('');
          })
          .catch(function () {
            out.innerHTML = '<span style="color:var(--c-muted);font-size:.78rem">Could not look that up.</span>';
          });
      });
    }

    function askServer() {
      if (asking || done() || !tok()) return;
      asking = true;
      fetch('/api/signals/nudge', { headers: headers() })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d && d.offer) card(d); else if (d) { /* the usual answer: no */ } })
        .catch(function () {})
        .then(function () { asking = false; });
    }

    // The burst lives in sessionStorage, not in a variable. Roost is a single
    // page and a variable would have been enough there — but EY, HR and the
    // parents app are multi-page, and somebody opening four screens in a row is
    // exactly four page loads, each with a fresh JavaScript context. In memory
    // the count would reset every time and the offer would never appear on the
    // portals most likely to need it.
    //
    // A path is counted once per window: re-opening the same screen is not
    // four wrong things, it is one.
    function readBurst() {
      try { var v = JSON.parse(sessionStorage.getItem(BURST_KEY) || '[]');
            return Array.isArray(v) ? v : []; } catch (e) { return []; }
    }
    function writeBurst(v) { try { sessionStorage.setItem(BURST_KEY, JSON.stringify(v)); } catch (e) {} }

    function sawSection(pathHint) {
      if (done() || !tok()) return;
      var now = Date.now();
      var path = String(pathHint || location.pathname || '').slice(0, 120);
      var burst = readBurst().filter(function (e) { return now - e.t < BURST_WINDOW_MS; });
      if (burst.some(function (e) { return e.p === path; })) { writeBurst(burst); return; }
      burst.push({ t: now, p: path });
      writeBurst(burst);
      if (burst.length >= BURST_MIN) { writeBurst([]); askServer(); }
    }

    // Roost fires this per SPA section; every portal fires a page_view beacon on
    // load, which is what the server counts. Both routes feed the same burst.
    var sawSpaSection = false;
    document.addEventListener('wren:section-loaded', function (e) {
      sawSpaSection = true;
      sawSection('/admin/' + ((e.detail && e.detail.section) || ''));
    });
    document.addEventListener('wren:ready', function () {
      // A fresh page load in a multi-page portal is one section open, recorded
      // server-side. Give the beacon a moment to land before asking — and skip
      // it on the SPA, where the section-loaded event above is the real signal
      // and this would count the landing page twice.
      setTimeout(function () { if (!sawSpaSection) sawSection(location.pathname); }, 2500);
    });
  } catch (e) { /* never break the shell */ }
})();

// 2026-10-09 — What's new popup: loaded once per page after the shell is ready.
// Shows the newest update meant for this portal that this person hasn't dismissed.
// The shell's init is synchronous and may already have fired 'wren:ready' by the time this
// tail runs (see the bootstrap note in wren-app-shell.js), so bind to both and to the DOM.
(function () {
  function loadWhatsNew() {
    if (window.__wrenWhatsNewTag) return; window.__wrenWhatsNewTag = true;
    var s = document.createElement('script'); s.src = '/js/wren-whats-new.js?v=20261009'; s.defer = true;
    document.head.appendChild(s);
  }
  document.addEventListener('wren:ready', loadWhatsNew);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadWhatsNew);
  else loadWhatsNew();
})();
