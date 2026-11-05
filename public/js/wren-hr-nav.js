/* Wren — the HR app's navigation, declared once (b525, 2026-10-22)
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * Before b525 the HR portal's navigation lived in three places that did not
 * agree with each other:
 *
 *   1. the bottom tab bar, hard-coded in public/js/wren-app-shell.js (b95);
 *   2. editions/hr/public/more.html, a hand-written list of <li> links;
 *   3. NAV_MPA.hr in public/js/wren-shell-v2.js — which NOTHING RENDERS.
 *
 * (3) is the trap. HR pages run wren-app-shell.js, not wren-shell-v2.js, and
 * the app shell suppresses the left drawer on this portal (`isHR` in _buildTopBar
 * drops the hamburger). So NAV_MPA.hr has been a dead declaration: b488's own
 * comment in more.html says My Action Plan "was orphaned: nothing in this
 * (current) HR nav linked to it, only the stale legacy wren-shell-v2 sidebar
 * did". Measured on 2026-10-22, six of its manager entries pointed at pages
 * that are not even served on this portal (staffing-weeks, data-editor,
 * keepsakes, suppliers, monitor live in editions/admin/public; cpd-matrix in
 * editions/shared-pages) — the HR static chain is hr/public then public/, so
 * those links 404. Two live pages (calendar.html from b518, briefings.html from
 * b503) were declared ONLY there, so they were unreachable from the real menu.
 *
 * This file is the one declaration. The bottom tab bar, the More page and the
 * new desktop sidebar all render from it, and all three apply the same
 * /api/nav-layout/resolved?edition=hr overrides — so a page hidden or moved in
 * Settings -> Permissions -> Navigation moves on every HR surface at once,
 * instead of in one of three copies. That is the b273 pattern (`ladn-more`,
 * public/js/wren-ey-more-nav.js) applied to the portal b242 could not see.
 *
 * WREN_HR_NAV is shaped exactly like an entry in NAV_MPA so that
 * navMpaRoleList() / navMpaSections() in wren-shell-v2.js consume it with no
 * special-casing, and the keys _mpaKey() derives from these hrefs are the keys
 * the More page puts on its <li data-nav-key>. scripts/b525-verify-hr-nav.js
 * asserts the two agree, item for item, and that every href is served.
 *
 * LAYOUT CONVENTIONS (b525 brief, Toby: "I want it familiar … I still want it
 * different, and I don't want to copy, but I'm used to seeing things a certain
 * way.") Placement follows what staff know from BrightHR; every pixel, word,
 * icon and colour is Wren's own. Nothing from BrightHR is reproduced here.
 *   - Home is the first tab and is a "today" screen.
 *   - A calendar tab sits second and answers "who is off" and "when am I in".
 *   - Starting a request is a CENTRE ACTION in the bar, not a menu item.
 *   - Documents is the far-right destination before More.
 *   - Everything else is grouped under More: my time, development, wellbeing,
 *     the nursery, me — and, for managers, the team.
 *
 * ADDING A PAGE: add one ITEMS row. Do not add it to more.html by hand, and do
 * not remove a row — ABSOLUTE RULE 3. If a page should stop appearing for a
 * role, hide it in Settings -> Permissions -> Navigation, which is reversible
 * and audited, rather than deleting the declaration.
 */
(function () {
  'use strict';

  /* ── Roles ────────────────────────────────────────────────────────────────
   * The three lists NAV_MPA uses on every MPA edition. Anything else resolves
   * through navMpaRoleList's alias map (deputy / admin / headteacher ->
   * manager, room-leader -> room_leader) or falls back to practitioner. */
  var MANAGER_ROLES  = 'manager,deputy_manager,admin,headteacher,business_manager';
  var ROOMLEAD_ROLES = MANAGER_ROLES + ',room_leader';

  /* ── Groups, in the order they appear under More ──────────────────────────
   * `tab` marks the two groups that are also bottom-tab destinations, so the
   * Documents tab and the More page cannot drift apart. */
  var GROUPS = [
    { key: 'g-my-time',    label: 'My time',           slug: 'my-time',    icon: '⏰',
      blurb: 'Holiday, hours, shifts, overtime and TOIL' },
    { key: 'g-documents',  label: 'Documents',         slug: 'documents',  icon: '📄',
      blurb: 'Policies, the handbook, and anything waiting for your signature', tab: 'documents' },
    { key: 'g-development',label: 'Development',       slug: 'development',icon: '🎓',
      blurb: 'CPD, supervisions and induction' },
    { key: 'g-wellbeing',  label: 'Wellbeing & surveys', slug: 'wellbeing', icon: '💚',
      blurb: 'Your monthly check-in, and having your say' },
    { key: 'g-nursery',    label: 'Nursery',           slug: 'nursery',    icon: '🏠',
      blurb: 'What is on, what has been said, and what needs fixing' },
    { key: 'g-team',       label: 'Team',              slug: 'team',       icon: '👥',
      blurb: 'Approvals, the rota and everyone’s records', role: MANAGER_ROLES },
    /* Its own group, NOT inside Team, and with NO role gate. b512's whole point
       is that an office manager may hold no manager role, so the server's
       allow-list (ladn.settings away_assistant_office_manager_ids) is the only
       list: the row ships hidden and is revealed when GET
       /api/away-assistant/modes answers 200. The pre-b525 more.html had this as
       a separate section for exactly this reason — filing it under Team took it
       away from practitioners, which scripts/b525-verify-hr-nav.js caught. */
    { key: 'g-away',       label: 'When Toby’s away',  slug: 'away',       icon: '🕊️',
      blurb: 'What to do while he is out' },
    { key: 'g-me',         label: 'Me',                slug: 'me',         icon: '👤',
      blurb: 'Your details, your sign-in and how Wren looks' },
    { key: 'g-help',       label: 'Help',              slug: 'help',       icon: '❓',
      blurb: 'The staff guide, and telling us something is wrong' },
  ];

  /* ── Every destination, in page order within its group ───────────────────
   * key      — the _mpaKey() of the href, so ladn.nav_layout rows line up
   * role     — null = everyone; otherwise a comma list of staff.role values
   * gate     — a named runtime gate the page applies on top of `role`
   *            ('away-api' = reveal only when GET /api/away-assistant/modes 200s)
   * action   — a button rather than a link; the More page wires it by id
   * tabOnly  — reached from a bottom tab, listed here so the matrix can see it
   */
  var ITEMS = [
    /* ── My time ─────────────────────────────────────────────────────────── */
    { group: 'g-my-time', key: 'p-my-absences', label: 'My Holiday & Absence', href: '/my-absences.html',
      icon: 'palm', fallback: '🏖️', role: null,
      blurb: 'Your allowance, what you have booked, and the form to book more' },
    { group: 'g-my-time', key: 'p-absences', label: 'Team Absence Calendar', href: '/absences.html',
      icon: 'calendar', fallback: '🗓️', role: null,
      blurb: 'Who is off, and when — names and dates only' },
    { group: 'g-my-time', key: 'p-my-shifts', label: 'My Shifts', href: '/my-shifts.html',
      icon: 'calendar', fallback: '📆', role: null,
      blurb: 'The published rota, and any shift going spare' },
    { group: 'g-my-time', key: 'p-my-clock', label: 'My Hours', href: '/my-clock.html',
      icon: 'clock', fallback: '⏰', role: null,
      blurb: 'Every tap in and out, and the week’s worked time' },
    { group: 'g-my-time', key: 'p-my-overtime', label: 'My Overtime', href: '/my-overtime.html',
      icon: 'clock', fallback: '⏱️', role: null,
      blurb: 'Hours claimed, and where each claim has got to' },
    { group: 'g-my-time', key: 'p-my-toil', label: 'My TOIL', href: '/my-toil.html',
      icon: 'clock', fallback: '⏰', role: null,
      blurb: 'Time owed back to you, and what you have spent' },
    { group: 'g-my-time', key: 'p-my-leave-weights', label: 'My Leave Weights', href: '/my-leave-weights.html',
      icon: 'scale', fallback: '⚖️', role: null,
      blurb: 'Which weeks you would rather not be off' },

    /* ── Documents (also the Documents tab) ──────────────────────────────── */
    { group: 'g-documents', key: 'p-policies', label: 'Policies to Sign', href: '/policies.html',
      icon: 'document', fallback: '📄', role: null,
      blurb: 'The policies you are asked to read and sign' },
    { group: 'g-documents', key: 'p-handbook', label: 'Employee Handbook', href: '/handbook.html',
      icon: 'book', fallback: '📕', role: null,
      blurb: 'The rules, searchable' },
    { group: 'g-documents', key: 'p-my-documents', label: 'Documents to Sign', href: '/my-documents.html',
      icon: 'document', fallback: '✍️', role: null,
      blurb: 'Contracts and letters waiting for your signature' },
    { group: 'g-documents', key: 'p-library', label: 'Reading Room', href: '/library.html',
      icon: 'book', fallback: '📖', role: null,
      blurb: 'Everything filed: policies, training, articles' },

    /* ── Development ─────────────────────────────────────────────────────── */
    { group: 'g-development', key: 'p-my-cpd', label: 'My CPD', href: '/my-cpd.html',
      icon: 'graduation-cap', fallback: '🎓', role: null,
      blurb: 'Courses done, courses due' },
    { group: 'g-development', key: 'p-cpd-catalogue', label: 'Ealing Training', href: '/cpd-catalogue.html',
      icon: 'map', fallback: '🏫', role: null,
      blurb: 'What the borough is running, and how to get on it' },
    /* seed-gdpr-20261030 — the deep-dive CPD programme (b262), the same page Nest has.
       Everyone. ADDED; nothing above moved. */
    { group: 'g-development', key: 'p-deep-dive', label: 'Deep Dive', href: '/deep-dive.html',
      icon: 'compass', fallback: '🧭', role: null,
      blurb: 'This half-term’s theme and this week’s 15-minute read' },
    /* planning-seed-20261030 — each room's published half-term plans (Baby Room, Pre-school),
       readable in the holidays too, with a tab per half-term topic. Everyone. ADDED; nothing above moved. */
    { group: 'g-development', key: 'p-room-planning', label: 'Room Planning', href: '/room-planning.html',
      icon: 'calendar', fallback: '📋', role: null,
      blurb: 'What each room is doing, half-term by half-term' },
    /* seed-gdpr-20261030 — the INSET room reflection workbooks, also linked from the
       INSET agenda (section 9). Everyone. ADDED; nothing above moved. */
    { group: 'g-development', key: 'p-inset-workbook-html-room-baby', label: 'Baby Room Reflective Workbook', href: '/inset-workbook.html?room=baby',
      icon: 'checklist', fallback: '🍼', role: null,
      blurb: 'The room reflective practice pack — saves on your phone as you go' },
    { group: 'g-development', key: 'p-inset-workbook-html-room-preschool', label: 'Pre-school Reflective Workbook', href: '/inset-workbook.html?room=preschool',
      icon: 'checklist', fallback: '🎨', role: null,
      blurb: 'The room reflective practice pack — saves on your phone as you go' },
    { group: 'g-development', key: 'p-my-supervisions', label: 'My Supervisions', href: '/my-supervisions.html',
      icon: 'handshake', fallback: '🤝', role: null,
      blurb: 'Your one-to-ones and the targets from them' },
    { group: 'g-development', key: 'p-my-tasks', label: 'My Action Plan', href: '/my-tasks.html',
      icon: 'checklist', fallback: '✅', role: null,
      blurb: 'What is on your list, and what is overdue' },
    { group: 'g-development', key: 'p-my-induction', label: 'My Induction', href: '/my-induction.html',
      icon: 'sprout', fallback: '🌱', role: null,
      blurb: 'Your first weeks, step by step' },
    // 2026-10-28 (Toby): apprentices (and managers) only — nobody else needs it.
    { group: 'g-development', key: 'p-my-apprenticeship', label: 'My Apprenticeship', href: '/my-apprenticeship.html',
      icon: 'milestone', fallback: '🎓', role: 'apprentice,' + MANAGER_ROLES,
      blurb: 'Off-the-job hours, if you are on a programme' },
    { group: 'g-development', key: 'p-cpd-ai-creator', label: 'AI CPD Creator', href: '/cpd/ai-creator.html',
      icon: 'graduation-cap', fallback: '✨', role: MANAGER_ROLES,
      blurb: 'Write a course from a prompt' },
    /* inset-20261026 — the INSET-day agenda: read it, tell Toby what you think,
       and the two-minute check-in. Everyone. ADDED; nothing above moved. */
    { group: 'g-development', key: 'p-inset', label: 'INSET Day Agenda', href: '/inset.html',
      icon: 'checklist', fallback: '🗒️', role: null,
      blurb: 'Read the agenda, and send Toby your thoughts' },
    /* b530 (2026-10-26) — room meetings, owned by the room leader. ADDED; nothing
       above moved or was removed (ABSOLUTE RULE 3). Everyone, not ROOMLEAD_ROLES:
       Toby's whole point is that the room is accountable for these, so a
       practitioner and an apprentice need to read their own room's minutes and
       confirm they have, which is the half of the feature a role gate here
       would hide. The page itself shows each person only what the server says
       they may see (src/lib/room-meetings.js), and the write buttons appear
       only where can_edit comes back true. */
    { group: 'g-development', key: 'p-room-meetings', label: 'Room Meetings', href: '/room-meetings.html',
      icon: 'handshake', fallback: '🗣️', role: null,
      blurb: 'Your room’s meetings, minutes and actions' },

    /* ── Wellbeing & surveys ─────────────────────────────────────────────── */
    { group: 'g-wellbeing', key: 'p-my-wellbeing', label: 'My Wellbeing', href: '/my-wellbeing.html',
      icon: 'heart', fallback: '💚', role: null,
      blurb: 'Your monthly check-in — private to you' },
    { group: 'g-wellbeing', key: 'p-my-surveys', label: 'My Surveys', href: '/my-surveys.html',
      icon: 'document-chart', fallback: '📝', role: null,
      blurb: 'Open surveys, answered anonymously' },

    /* ── Nursery ─────────────────────────────────────────────────────────── */
    /* b518's calendar and b503's briefings were declared ONLY in the dead
       NAV_MPA.hr, so neither was reachable from the live menu. Added here. */
    { group: 'g-nursery', key: 'p-calendar', label: 'Events & Calendar', href: '/calendar.html',
      icon: 'calendar', fallback: '📅', role: null,
      blurb: 'What is on at the nursery, read-only' },
    { group: 'g-nursery', key: 'p-briefings', label: 'Briefings', href: '/briefings.html',
      icon: 'broadcast', fallback: '📰', role: ROOMLEAD_ROLES,
      blurb: 'The day’s briefing for the team' },
    { group: 'g-nursery', key: 'p-messages', label: 'Messages', href: '/messages.html',
      icon: 'message', fallback: '💬', role: null,
      blurb: 'Your threads with the office' },
    { group: 'g-nursery', key: 'p-ealing-partnership', label: 'Ealing EY Partnership', href: '/ealing-partnership.html',
      icon: 'handshake', fallback: '🏛️', role: null,
      blurb: 'The borough’s board for early years settings' },
    { group: 'g-nursery', key: 'p-repairs', label: 'Repairs & Maintenance', href: '/repairs.html',
      icon: 'wrench', fallback: '🔧', role: ROOMLEAD_ROLES,
      blurb: 'Report something broken, or close one off' },

    /* ── Team (managers) ─────────────────────────────────────────────────── */
    { group: 'g-team', key: 'p-absence-mgmt', label: 'Absence Approval', href: '/absence-mgmt.html',
      icon: 'palm', fallback: '🏖️', role: MANAGER_ROLES,
      blurb: 'Requests waiting on you' },
    { group: 'g-team', key: 'p-overtime-approval', label: 'Overtime Approval', href: '/overtime-approval.html',
      icon: 'clock', fallback: '🕒', role: MANAGER_ROLES,
      blurb: 'Claims waiting on you' },
    { group: 'g-team', key: 'p-toil', label: 'TOIL Adjustments', href: '/toil.html',
      icon: 'clock', fallback: '⏱️', role: MANAGER_ROLES,
      blurb: 'Add or take back time owed' },
    { group: 'g-team', key: 'p-rota', label: 'Rota', href: '/rota.html',
      icon: 'calendar', fallback: '📅', role: MANAGER_ROLES,
      blurb: 'Build and publish the week' },
    { group: 'g-team', key: 'p-staff', label: 'All Staff', href: '/staff.html',
      icon: 'users', fallback: '👥', role: MANAGER_ROLES,
      blurb: 'The team, and each person’s record' },
    { group: 'g-team', key: 'p-supervisions', label: 'Supervisions', href: '/supervisions.html',
      icon: 'handshake', fallback: '📋', role: MANAGER_ROLES,
      blurb: 'Who is due, and what was agreed' },
    { group: 'g-team', key: 'p-performance', label: 'Performance', href: '/performance.html',
      icon: 'chart-up', fallback: '📈', role: MANAGER_ROLES,
      blurb: 'How the team is doing, by the numbers' },
    { group: 'g-team', key: 'p-warnings', label: 'Attendance Warnings', href: '/warnings.html',
      icon: 'flag-search', fallback: '⚠️', role: MANAGER_ROLES,
      blurb: 'The warning ladder, verbal to final' },
    { group: 'g-team', key: 'p-induction-oversight', label: 'Induction & Onboarding', href: '/induction-oversight.html',
      icon: 'user-plus', fallback: '🌱', role: MANAGER_ROLES,
      blurb: 'New starters, and where each has got to' },
    { group: 'g-team', key: 'p-my-tasks-html-projects-1', label: 'Tasks (incl. action plans)', href: '/my-tasks.html?projects=1',
      icon: 'target', fallback: '🎯', role: MANAGER_ROLES,
      blurb: 'Everybody’s list, and the plans behind it' },
    { group: 'g-team', key: 'p-cpd-matrix', label: 'CPD Matrix', href: '/cpd-matrix.html',
      icon: 'graduation-cap', fallback: '🧩', role: MANAGER_ROLES,
      blurb: 'Who holds which certificate' },
    { group: 'g-team', key: 'p-policies-admin', label: 'Policies Admin', href: '/policies-admin.html',
      icon: 'document', fallback: '🗂️', role: MANAGER_ROLES,
      blurb: 'Publish a policy and chase the signatures' },
    { group: 'g-team', key: 'p-audit', label: 'Audit & Staff Usage', href: '/audit.html',
      icon: 'search', fallback: '🔍', role: MANAGER_ROLES,
      blurb: 'Who did what, and when' },

    /* ── When Toby's away (its own group — see the GROUPS note above) ─────── */
    { group: 'g-away', key: 'p-away-assistant', label: 'Ask what to do', href: '/away-assistant.html',
      icon: 'help', fallback: '🕊️', role: null, gate: 'away-api',
      blurb: 'The answer Toby would give, while he is out' },

    /* ── Me ──────────────────────────────────────────────────────────────── */
    { group: 'g-me', key: 'p-my-profile', label: 'My Profile', href: '/my-profile.html',
      icon: 'person', fallback: '👤', role: null,
      blurb: 'Your details, and who to ring in an emergency' },
    { group: 'g-me', key: 'p-totp-setup', label: 'Two-step sign-in', href: '/totp-setup.html',
      icon: 'shield-lock', fallback: '🔐', role: null,
      blurb: 'The six-digit code on your phone' },
    { group: 'g-me', key: 'g-appearance', label: 'Appearance', action: 'appearance',
      icon: 'palette', fallback: '🎨', role: null,
      blurb: 'Light or dark, and bigger text' },
    { group: 'g-me', key: 'g-enable-push', label: 'Enable notifications', action: 'enable-push',
      icon: 'bell', fallback: '🔔', role: null,
      blurb: 'Get told on this device' },
    { group: 'g-me', key: 'g-sign-out', label: 'Sign Out', action: 'sign-out',
      icon: 'logout', fallback: '↩', role: null, danger: true },

    /* ── Help ────────────────────────────────────────────────────────────── */
    /* b527 (2026-10-26) — Ask Wren. ADDED at the top of Help, above the staff
       guide, because it is the thing to try first when you are stuck: it reads
       the guide, the policies and the EYFS corpus for you and gives you the
       page. Nothing in this group was removed. On this portal it answers about
       the rota, who is off, our policies and how to use Wren — the child tools
       are absent because the HR allow-list (b491) refuses child data here. */
    { group: 'g-help', key: 'p-ask-wren', label: 'Ask Wren', href: '/ask-wren.html',
      icon: 'sparkles', fallback: '✨', role: null,
      blurb: 'Ask a question about your shifts, our policies or how Wren works' },
    { group: 'g-help', key: 'p-guides-staff-guide', label: 'Staff guide', href: '/guides/staff-guide.html',
      icon: 'book', fallback: '📗', role: null,
      blurb: 'How to do the things you do most' },
    { group: 'g-help', key: 'g-report-a-problem', label: 'Report a problem', action: 'report-bug',
      icon: 'bug', fallback: '🐞', role: null,
      blurb: 'Tell us what went wrong' },
  ];

  /* ── The bottom tab bar ──────────────────────────────────────────────────
   * Five slots. `centre: true` is the action slot the app shell already draws
   * for the EY ＋ button, reused here so starting a request is a thumb-reach
   * action in the middle of the bar rather than a buried menu item.
   * `page` matches <meta name="wren-app-page"> so the active tab lights up. */
  var TABS = [
    { key: 't-home',      label: 'Home',      href: '/index.html',      page: 'home',
      icon: 'home',     fallback: '🏠' },
    { key: 't-calendar',  label: 'Calendar',  href: '/my-calendar.html', page: 'my-calendar',
      icon: 'calendar', fallback: '📆',
      /* My Shifts and the team grid are the full views behind this one. */
      alsoActiveOn: ['my-shifts', 'absences', 'calendar'] },
    { key: 't-request',   label: 'Request',   href: '/request.html',    page: 'request',
      icon: 'calendar-plus', fallback: '+', centre: true },
    { key: 't-documents', label: 'Documents', href: '/documents.html',  page: 'documents',
      icon: 'document', fallback: '📄',
      alsoActiveOn: ['policies', 'handbook', 'my-documents', 'library'] },
    { key: 't-more',      label: 'More',      href: '/more.html',       page: 'more',
      icon: null,       fallback: '•••' },
  ];

  /* ── Role resolution ─────────────────────────────────────────────────────
   * Same alias map navMpaRoleList uses, so "deputy manager" sees the manager
   * nav here and in the matrix without a second table of synonyms. */
  function roleKey(role) {
    var r = String(role || '').toLowerCase().replace(/-/g, '_');
    if (['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager', 'owner'].indexOf(r) !== -1) return 'manager';
    if (r === 'room_leader') return 'room_leader';
    return 'practitioner';
  }

  /** Does `item.role` admit this staff.role? null/'' means everyone. */
  function roleAdmits(item, role) {
    if (!item.role) return true;
    var r = String(role || '').toLowerCase().replace(/-/g, '_');
    return item.role.split(',').map(function (x) { return x.trim().toLowerCase(); }).indexOf(r) !== -1;
  }

  /**
   * The menu for one role, as [{key,label,slug,icon,blurb,items:[...]}].
   * Groups whose every item is filtered out are dropped — a dead heading is
   * worse than no heading. `gate`d items are INCLUDED here and hidden by the
   * page at runtime, because only the server knows who may see them.
   */
  function groupsFor(role) {
    return GROUPS
      .filter(function (g) { return roleAdmits(g, role); })
      .map(function (g) {
        var items = ITEMS.filter(function (it) {
          return it.group === g.key && roleAdmits(it, role);
        });
        return Object.assign({}, g, { items: items });
      })
      .filter(function (g) { return g.items.length; });
  }

  /* ── NAV_MPA shape, for wren-shell-v2.js and the b242 matrix screen ──────
   * One {icon,label,children:[{label,href}]} per group, per role — identical
   * in shape to NAV_MPA.hr, which stays in wren-shell-v2.js as the fallback
   * for anything that loads the shell without this file. */
  function mpaFor(role) {
    return groupsFor(role).map(function (g) {
      return {
        icon: g.icon,
        label: g.label,
        children: g.items.map(function (it) {
          var o = { label: it.label };
          if (it.href) o.href = it.href;
          return o;
        }),
      };
    });
  }

  window.WREN_HR_GROUPS = GROUPS;
  window.WREN_HR_ITEMS  = ITEMS;
  window.WREN_HR_TABS   = TABS;
  window.WREN_HR_NAV    = {
    practitioner: mpaFor('practitioner'),
    room_leader:  mpaFor('room_leader'),
    manager:      mpaFor('manager'),
  };

  window.WrenHrNav = {
    GROUPS: GROUPS, ITEMS: ITEMS, TABS: TABS,
    roleKey: roleKey, roleAdmits: roleAdmits, groupsFor: groupsFor, mpaFor: mpaFor,

    /** Every href this declaration can reach for `role` — the reachability set
     *  scripts/b525-verify-hr-nav.js counts before and after. */
    hrefsFor: function (role) {
      var out = TABS.map(function (t) { return t.href; });
      groupsFor(role).forEach(function (g) {
        g.items.forEach(function (it) { if (it.href) out.push(it.href); });
      });
      return out.filter(function (h, i, a) { return a.indexOf(h) === i; });
    },

    /**
     * Fold /api/nav-layout/resolved?edition=hr over a groupsFor() result.
     * `sections` is that endpoint's map, keyed by the same _mpaKey() ids as
     * ITEMS.key. hidden removes, group_label moves, sort_order reorders.
     *
     * A layout that empties the whole menu is treated as broken and ignored —
     * the same rule _applyMpaOverrides and _resolveNavGroups already apply, so
     * nobody is ever stranded on a menu with no way out.
     */
    applyOverrides: function (groups, sections) {
      if (!sections || !Object.keys(sections).length) return groups;
      var byLabel = {};
      groups.forEach(function (g) { byLabel[g.label] = g; });

      var out = groups.map(function (g) { return Object.assign({}, g, { items: [] }); });
      var outByLabel = {};
      out.forEach(function (g) { outByLabel[g.label] = g; });

      var n = 0;
      groups.forEach(function (g) {
        g.items.forEach(function (it) {
          var o = sections[it.key] || null;
          var base = n++;
          if (o && o.hidden === true) return;
          var target = g.label;
          if (o && o.group_label != null && String(o.group_label).trim()) {
            var want = String(o.group_label).trim();
            // Only a group that exists on THIS portal can be a parent, so a
            // layout copied from Roost degrades to "leave it where it was"
            // rather than silently swallowing the item.
            if (outByLabel[want]) target = want;
          }
          outByLabel[target].items.push(Object.assign({}, it, {
            _sort: (o && o.sort_order != null) ? Number(o.sort_order) : null,
            _base: base,
          }));
        });
      });

      out.forEach(function (g) {
        g.items.sort(function (a, b) {
          var as = a._sort == null ? Infinity : a._sort;
          var bs = b._sort == null ? Infinity : b._sort;
          return as !== bs ? as - bs : a._base - b._base;
        });
      });
      var kept = out.filter(function (g) { return g.items.length; });
      return kept.length ? kept : groups;
    },

    /**
     * Is the away-assistant row allowed for this person? Resolves true/false.
     *
     * b512's design is that the SERVER's allow-list is the only list: managers
     * and the deputy by role, office managers by staff id, and a 403 means "not
     * you". So the only way to know is to ask — and asking means the browser
     * logs a 403 on every page that draws the menu. Before b525 that was one
     * page (More); the desktop sidebar draws the menu everywhere, which would
     * have made it every page, burying real errors in expected ones.
     *
     * So the answer is cached for the SESSION (sessionStorage, dies with the
     * tab): one call per session rather than one per page load. This is safe
     * because it is PRESENTATION — the server gates the page and the route
     * regardless, so a stale `true` shows a link that then refuses, and a stale
     * `false` hides a link whose URL still works. If Toby adds somebody to
     * away_assistant_office_manager_ids mid-session, they see it on their next
     * sign-in; that is the trade for not shouting 403 on every screen.
     */
    awayGate: function () {
      var KEY = 'wrenHrAwayGate';
      try {
        var cached = sessionStorage.getItem(KEY);
        if (cached === '1') return Promise.resolve(true);
        if (cached === '0') return Promise.resolve(false);
      } catch (_) { /* storage blocked — just ask */ }
      var t = '';
      try {
        t = (window.Wren && Wren.getToken && Wren.getToken()) || sessionStorage.getItem('wrenToken') || '';
      } catch (_) {}
      return fetch('/api/away-assistant/modes', { headers: t ? { Authorization: 'Bearer ' + t } : {} })
        .then(function (r) {
          var allowed = !!r.ok;
          try { sessionStorage.setItem(KEY, allowed ? '1' : '0'); } catch (_) {}
          return allowed;
        })
        .catch(function () { return false; });     // hidden is the safe default
    },

    /** GET the resolved overrides for this portal. Never rejects: a failure
     *  means "no overrides", and the shipped layout renders. */
    fetchOverrides: function () {
      var t = '';
      try {
        t = (window.Wren && Wren.getToken && Wren.getToken()) || sessionStorage.getItem('wrenToken') || '';
      } catch (_) { /* storage blocked */ }
      return fetch('/api/nav-layout/resolved?edition=hr', {
        headers: t ? { Authorization: 'Bearer ' + t } : {},
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { return (d && d.sections) || {}; })
        .catch(function () { return {}; });
    },
  };
}());
