/* Wren — the EY tablet's More menu, declared once (b273, 2026-09-04)
 *
 * WHY THIS FILE EXISTS
 * b242 made the nav customisable through a role x page matrix backed by
 * ladn.nav_layout, but only wired the portals that load wren-shell-v2.js. The EY
 * tablet is not one of them: it runs wren-app-shell.js, and /ey/more IS its whole
 * menu (data-portal="ey" suppresses the left drawer, and there is no Ctrl+K).
 *
 * So the More menu joins the same table under its own edition key, `ladn-more`:
 *   - editions/ladn/public/ey/more.html renders the tiles and applies
 *     /api/nav-layout/resolved?edition=ladn-more to them;
 *   - this file is what the MATRIX SCREEN reads, so Settings -> Permissions ->
 *     Navigation can list "EY More menu (LADN)" beside the other editions.
 *
 * It is shaped exactly like an entry in NAV_MPA (wren-shell-v2.js) so that
 * navMpaRoleList() / navMpaSections() consume it with no special-casing, and the
 * keys _mpaKey() derives from these hrefs are the same keys more.html puts on its
 * <li data-nav-key>. scripts/b273-verify.js asserts the two agree, item for item.
 *
 * GENERATED alongside more.html — if you add a tile there, add it here too, or
 * b273-verify.js fails.
 */
(function () {
  'use strict';
  var G = window.WREN_EY_MORE_GROUPS = [
    { key: "g-my-day", label: "My Day", slug: "my-day", cls: "ey-g-day", symbol: "/symbols/mulberry/today.svg", icon: "\ud83c\udf24\ufe0f", blurb: "The shift in front of you" },
    { key: "g-children", label: "Children", slug: "children", cls: "ey-g-children", symbol: "/symbols/mulberry/family.svg", icon: "\ud83d\udc76", blurb: "Who they are, and what they need next" },
    { key: "g-planning", label: "Planning", slug: "planning", cls: "ey-g-planning", symbol: "/symbols/mulberry/calendar_month.svg", icon: "\ud83d\uddd3\ufe0f", blurb: "Termly, weekly, and the drafts Wren writes for you" },
    { key: "g-reports-checks", label: "Reports & Checks", slug: "reports-checks", cls: "ey-g-reports", symbol: "/symbols/mulberry/clipboard.svg", icon: "\ud83d\udccb", blurb: "What is owed, what is drafted, what is signed off" },
    { key: "g-cpd-reflection", label: "CPD & Reflection", slug: "cpd-reflection", cls: "ey-g-cpd", symbol: "/symbols/mulberry/brain.svg", icon: "\ud83e\udded", blurb: "Your learning, your week, your paperwork" },
    { key: "g-safeguarding-records", label: "Safeguarding & Records", slug: "safeguarding-records", cls: "ey-g-safeguarding", symbol: "/symbols/mulberry/first_aid_box.svg", icon: "\ud83d\udee1\ufe0f", blurb: "Concerns, accidents, medicine, footage" },
    { key: "g-messages", label: "Messages", slug: "messages", cls: "ey-g-messages", symbol: "/symbols/mulberry/email.svg", icon: "\u2709\ufe0f", blurb: "Email in and out, and what the whole team is told" },
    { key: "g-the-setting", label: "The Setting", slug: "the-setting", cls: "ey-g-setting", symbol: "/symbols/mulberry/house.svg", icon: "\ud83c\udfe0", blurb: "The building, the kit and the risks" },
    { key: "g-help-account", label: "Help & Account", slug: "help-account", cls: "ey-g-help", symbol: "/symbols/mulberry/help_,_to.svg", icon: "\u2753", blurb: "Settings, help, and getting unstuck" },
  ];

  // Every tile, in page order, with the gate more.html puts on its <li>.
  // `reviewer` marks the one tile gated by more.html's own reviewer-role IIFE
  // rather than by a data-role attribute (the Review Queue).
  var ITEMS = [
    { group: "g-my-day", key: "p-ey-my-morning", label: "My Morning", href: "/ey/my-morning", icon: "cockpit", role: null, capability: null },
    // 2026-10-28 (Toby): the INSET agenda on the tablets as well as Seed (same page, same answers).
    { group: "g-my-day", key: "p-ey-inset", label: "INSET Day Agenda", href: "/ey/inset", icon: "clipboard-check", role: null, capability: null },
    { group: "g-my-day", key: "p-ey-register", label: "Child Register", href: "/ey/weekly-register", /* 2026-10-28: the weekly booked register (EyLog-style); sign-in list linked from it */ icon: "clipboard-check", role: null, capability: null },
    // diaryfix2 (2026-10-13): mirrors the new more.html tile — the day's diary + Publish, off the bottom nav.
    { group: "g-my-day", key: "p-ey-diary", label: "Today's Diary & Publish", href: "/ey/diary", icon: "diary", role: null, capability: null },
    { group: "g-my-day", key: "p-ey-signin", label: "Sign In / Out", href: "/ey/signin", icon: "camera", role: null, capability: null },
    { group: "g-my-day", key: "p-ey-room-headcount", label: "Room Headcount", href: "/ey/room-headcount", icon: "grid-plus", role: null, capability: null },
    { group: "g-my-day", key: "p-ey-staff-clock", label: "Staff Clock-In", href: "/ey/staff-clock", icon: "clock-in", role: null, capability: null },
    { group: "g-my-day", key: "p-ey-door", label: "Front Door", href: "/ey/door", icon: "door", role: null, capability: null },
    { group: "g-my-day", key: "p-ey-kitchen", label: "Kitchen", href: "/ey/kitchen", icon: "kitchen", role: null, capability: "kitchen.access" },
    { group: "g-my-day", key: "p-ey-viewings", label: "Viewings", href: "/ey/viewings", icon: "eye", role: null, capability: null },
    // b405 (2026-10-06): mirrors the new more.html tile — role matches the server's own requireManager list.
    { group: "g-my-day", key: "p-ey-booking-requests", label: "Booking Requests", href: "/ey/booking-requests", icon: "calendar-plus", role: "manager,deputy_manager,admin,headteacher", capability: null },
    { group: "g-my-day", key: "p-ey-sleep-chart", label: "Sleep Chart", href: "/ey/sleep-chart", icon: "moon", role: null, capability: null },
    // cot cam (2026-11-02) — Baby Room live sleep check; mirrors the more.html tile. Server-gated.
    { group: "g-my-day", key: "p-ey-cot-cam", label: "Cot cam", href: "/ey/cot-cam", icon: "camera", role: null, capability: null },
    { group: "g-children", key: "p-ey-key-children", label: "Key Children", href: "/ey/key-children", icon: "children", role: null, capability: null },
    // keyperson-20261023 — ADDITIVE: your photo + intro for the parents' key person card.
    { group: "g-children", key: "p-ey-parent-profile", label: "My profile for parents", href: "/ey/parent-profile", icon: "person", role: null, capability: null },
    // b507 (2026-10-18): Wren Kids launcher — pick a child, then play together. Mirrors the
    // new more.html tile. No role gate: any practitioner may sit with a child and a game.
    { group: "g-children", key: "p-ey-kids-games", label: "Learning Games", href: "/ey/kids-games", icon: "sparkles", role: null, capability: null },
    { group: "g-children", key: "p-ey-new-starters", label: "New Starters", href: "/ey/new-starters", icon: "sprout", role: null, capability: null },
    { group: "g-children", key: "p-ey-memory-books", label: "Memory Books", href: "/ey/memory-books", icon: "book-heart", role: "manager,deputy_manager,admin,headteacher,room_leader", capability: null },
    { group: "g-children", key: "p-ey-drafts", label: "Observation Drafts", href: "/ey/drafts", icon: "pencil", role: null, capability: null },
    { group: "g-children", key: "p-ey-termly-review", label: "Family / Termly Reviews", href: "/ey/termly-review", icon: "family", role: null, capability: null },
    { group: "g-children", key: "p-ey-sen", label: "SEND Register", href: "/ey/sen", icon: "puzzle", role: null, capability: null },
    { group: "g-children", key: "p-ey-sen-toolkit", label: "SEN Toolkit", href: "/ey/sen-toolkit", icon: "toolbox", role: null, capability: null },
    // b518 (2026-10-20) — mirrors the new more.html tile: the nursery calendar,
    // read-only for staff. Nothing removed; the planning editor stays below.
    { group: "g-planning", key: "p-ey-calendar", label: "Events & Calendar", href: "/ey/calendar", icon: "calendar", role: null, capability: null },
    { group: "g-planning", key: "p-ey-planning", label: "Planning \u2014 Termly & Weekly", href: "/ey/planning", icon: "calendar", role: null, capability: null },
    { group: "g-planning", key: "p-ey-areas", label: "AI-Assisted Planning", href: "/ey/areas", icon: "sparkles", role: "manager,deputy_manager,admin,headteacher,room_leader,practitioner", capability: null },
    { group: "g-planning", key: "p-ey-plan-draft", label: "Draft Next Half-Term", href: "/ey/plan-draft", icon: "wand", role: "manager,deputy_manager,admin,headteacher,room_leader,practitioner", capability: null },
    { group: "g-planning", key: "p-ey-toolbox", label: "Teaching Toolbox", href: "/ey/toolbox", icon: "palette", role: null, capability: null },
    { group: "g-planning", key: "p-ey-planning-demo", label: "Planning in fortnights \u2014 demo", href: "/ey/planning-demo/index.html", icon: "planning", role: null, capability: null },
    { group: "g-planning", key: "p-ey-keyperson-planning", label: "AI Planning for Key Children", href: "/ey/keyperson-planning", icon: "sparkles", role: "manager,deputy_manager,admin,headteacher,room_leader,practitioner", capability: null },
    { group: "g-reports-checks", key: "p-ey-reports-due", label: "Reports Due", href: "/ey/reports-due", icon: "calendar-plus", role: null, capability: null },
    { group: "g-reports-checks", key: "p-ey-reports", label: "Reports", href: "/ey/reports", icon: "document-chart", role: null, capability: null },
    { group: "g-reports-checks", key: "p-ey-reports-summative", label: "Summative / Transition Reports", href: "/ey/reports/summative", icon: "arrow-next", role: null, capability: null },
    { group: "g-reports-checks", key: "p-ey-termly-update", label: "Termly Updates", href: "/ey/termly-update", icon: "book", role: null, capability: null },
    { group: "g-reports-checks", key: "p-ey-termly-tracker", label: "Termly Update Tracker", href: "/ey/termly-tracker", icon: "chart-up", role: null, capability: null },
    { group: "g-reports-checks", key: "p-ey-duties", label: "Duties Tracker", href: "/ey/duties", icon: "clipboard-check", role: null, capability: null },
    { group: "g-safeguarding-records", key: "p-ey-pathways", label: "Pathways — read-only", href: "/ey/pathways", icon: "tree", role: "manager,deputy_manager,admin,headteacher,room_leader,practitioner", capability: null },
    { group: "g-reports-checks", key: "p-ey-trackers-two-year-check", label: "2-Year Progress Check", href: "/ey/trackers/two-year-check", icon: "milestone", role: null, capability: null },
    { group: "g-reports-checks", key: "p-ey-two-year-check-review", label: "2-Year Checks \u2014 review & send", href: "/ey/two-year-check/review", icon: "flag-search", role: null, capability: null },
    { group: "g-reports-checks", key: "p-ey-review-queue", label: "Review Queue \u2014 Observations", href: "/ey/review-queue.html", icon: "binoculars", role: null, capability: null, reviewer: true },
    { group: "g-cpd-reflection", key: "p-ey-deep-dive", label: "Deep Dive", href: "/ey/deep-dive", icon: "compass", role: null, capability: null },
    { group: "g-cpd-reflection", key: "p-ey-fledge-framework", label: "Fledge — progress framework", href: "/ey/fledge-framework.html", icon: "feather", role: null, capability: null },
    { group: "g-cpd-reflection", key: "p-ey-reflect", label: "My Reflection & CPD", href: "/ey/reflect", icon: "mirror", role: null, capability: null },
    { group: "g-cpd-reflection", key: "p-ey-supervisions", label: "My Supervisions", href: "/ey/supervisions", icon: "users", role: null, capability: null },
    { group: "g-cpd-reflection", key: "p-ey-action-plans", label: "Tasks (incl. action plans)", href: "/ey/my-tasks?projects=1", icon: "target", role: null, capability: null },
    { group: "g-cpd-reflection", key: "p-ey-policies", label: "Policies to Sign", href: "/ey/policies", icon: "document", role: null, capability: null },
    { group: "g-cpd-reflection", key: "p-ey-my-shifts", label: "My Shifts", href: "/ey/my-shifts", icon: "clock", role: null, capability: null },
    // b522 (2026-10-20) — your own holiday balance in hours, read-only, beside
    // My Shifts. ADDITIVE: no existing entry is changed or removed.
    { group: "g-cpd-reflection", key: "p-ey-my-leave", label: "My Leave", href: "/ey/my-leave", icon: "calendar", role: null, capability: null },
    { group: "g-cpd-reflection", key: "p-ey-my-tasks", label: "My Tasks", href: "/ey/my-tasks", icon: "checklist", role: null, capability: null },
    { group: "g-reports-checks", key: "p-ey-briefings", label: "Briefings", href: "/ey/briefings", icon: "document-chart", role: "manager,deputy_manager,admin,headteacher,room_leader", capability: null },   // b503
    { group: "g-cpd-reflection", key: "p-ey-my-documents", label: "My Documents", href: "/ey/my-documents", icon: "archive", role: null, capability: null },
    { group: "g-cpd-reflection", key: "p-ey-library", label: "Reading Room", href: "/ey/library", icon: "book", role: null, capability: null },
    { group: "g-safeguarding-records", key: "p-ey-legacy-safeguarding", label: "Safeguarding \u2014 Review Concerns", href: "/ey-legacy/safeguarding.html", icon: "shield", role: "manager,deputy_manager,room_leader,headteacher,admin", capability: null },
    { group: "g-safeguarding-records", key: "p-ey-legacy-incidents", label: "Accidents & Incidents \u2014 Sign Off", href: "/ey-legacy/incidents.html", icon: "first-aid", role: "manager,deputy_manager,admin", capability: "accidents.create" },
    { group: "g-safeguarding-records", key: "p-ey-legacy-medicine", label: "Medicine Records", href: "/ey-legacy/medicine.html", icon: "pill", role: null, capability: "medicine_record" },
    { group: "g-safeguarding-records", key: "p-ey-cctv-request", label: "Request CCTV Footage", href: "/ey/cctv-request", icon: "eye", role: null, capability: null },
    // b487 (2026-10-12): role-gated — Toby, 2026-10-12: "only deputy managers
    // and room leaders [...] managers also see it". 'manager' here is the
    // post-b271 floor-manager role (what CLAUDE.md calls the deputy manager);
    // 'admin'/'headteacher' are the owner-equivalent roles, who already have
    // the same inbox on Roost but should not lose it if they open EY.
    // b486c (2026-10-13): kept equal to src/lib/inbox-access.js's
    // isEyInboxEligible() — EY_INBOX_ROLES ∪ OWNER_ROLES — see more.html's
    // matching <li> comment for the full cross-reference.
    // 2026-10-28 (Toby): parent messaging was only on the top-bar ✉️ — now listed here too.
    { group: "g-messages", key: "p-ey-messages", label: "Messages with parents", href: "/ey/messages", icon: "message", role: null, capability: null },
    { group: "g-messages", key: "p-ey-nursery-inbox", label: "Nursery Inbox", href: "/ey/nursery-inbox.html", icon: "mail", role: "manager,deputy_manager,admin,headteacher,room_leader", capability: null },
    { group: "g-messages", key: "p-ey-send-email", label: "Send an Email", href: "/ey/send-email", icon: "message", role: null, capability: null },
    { group: "g-messages", key: "p-ey-inbox", label: "Announcements", href: "/ey/inbox", icon: "megaphone", role: null, capability: null },
    // b405 (2026-10-06, staff feedback) — mirrors the new more.html tile.
    { group: "g-messages", key: "p-ey-events", label: "Events", href: "/ey/events", icon: "calendar-plus", role: null, capability: null },
    { group: "g-the-setting", key: "p-ey-risk-assessments", label: "Risk Assessment", href: "/ey/risk-assessments", icon: "shield-lock", role: null, capability: null },
    { group: "g-the-setting", key: "p-ey-repairs", label: "Repairs & Maintenance", href: "/ey/repairs", icon: "wrench", role: null, capability: null },
    // nest-building (2026-11-02) — mirrors the more.html tile. Server-gated on building.view (leadership tier).
    { group: "g-the-setting", key: "p-ey-building", label: "Building & Heating", href: "/ey/building", icon: "house", role: null, capability: "building.view" },
    { group: "g-the-setting", key: "p-ey-resources", label: "Resources & Equipment", href: "/ey/resources", icon: "box", role: null, capability: null },
    { group: "g-the-setting", key: "p-http-homeassistant-local-8123", label: "Building Controls (heating & fridges)", href: "http://homeassistant.local:8123", icon: "thermostat", role: null, capability: null },
    { group: "g-the-setting", key: "p-ey-paperwork", label: "Paperwork", href: "/ey/paperwork", icon: "folder", role: null, capability: null },
    // b527 (2026-10-26) — Ask Wren. First in Help & Account because it is what
    // you reach for when you are stuck mid-shift: it reads the guides, the
    // policies and the EYFS corpus for you, and it can look up a child, the
    // register and the ratios through the same gates the pages use. ADDED; the
    // existing tiles are untouched (ABSOLUTE RULE 3).
    { group: "g-help-account", key: "p-ey-ask-wren", label: "Ask Wren", href: "/ey/ask-wren", icon: "sparkles", role: null, capability: null },
    { group: "g-help-account", key: "p-ey-how-wren-works", label: "How Wren Works", href: "/ey/how-wren-works.html", icon: "map", role: null, capability: null },
    { group: "g-help-account", key: "p-ey-help", label: "Help", href: "/ey/help", icon: "help", role: null, capability: null },
    { group: "g-help-account", key: "p-ey-settings", label: "Settings", href: "/ey/settings", icon: "gear", role: null, capability: null },
    { group: "g-help-account", key: "p-ey-request-access", label: "Request access / unblock", href: "/ey/request-access", icon: "unlock", role: null, capability: null },
    { group: "g-help-account", key: "g-report-a-bug-feedback", label: "Report a bug / feedback", href: null, icon: "bug", role: null, capability: null },
    { group: "g-help-account", key: "g-sign-out", label: "Sign Out", href: null, icon: "logout", role: null, capability: null },
  ];
  window.WREN_EY_MORE_ITEMS = ITEMS;

  /* The per-role lists the matrix screen offers cells for. A role only gets a
     checkbox for a page its own menu actually contains — same rule the shell
     applies to every other MPA portal. Capability-gated tiles (kitchen, medicine,
     accidents) DO appear for every role: a capability is granted per PERSON in the
     b237 matrix, not per role, so hiding the cell would hide a page a manager may
     well have granted. */
  window.WREN_EY_MORE_NAV = {
    manager: [
      { icon: "\ud83c\udf24\ufe0f", label: "My Day", children: [
        { label: "My Morning", href: "/ey/my-morning" },
        { label: "Child Register", href: "/ey/weekly-register" },
        { label: "Sign In / Out", href: "/ey/signin" },
        { label: "Room Headcount", href: "/ey/room-headcount" },
        { label: "Staff Clock-In", href: "/ey/staff-clock" },
        { label: "Front Door", href: "/ey/door" },
        { label: "Kitchen", href: "/ey/kitchen" },
        { label: "Viewings", href: "/ey/viewings" },
      ]},
      { icon: "\ud83d\udc76", label: "Children", children: [
        { label: "Key Children", href: "/ey/key-children" },
        { label: "New Starters", href: "/ey/new-starters" },
        { label: "Memory Books", href: "/ey/memory-books" },
        { label: "Observation Drafts", href: "/ey/drafts" },
        { label: "Family / Termly Reviews", href: "/ey/termly-review" },
        { label: "SEND Register", href: "/ey/sen" },
        { label: "SEN Toolkit", href: "/ey/sen-toolkit" },
      ]},
      { icon: "\ud83d\uddd3\ufe0f", label: "Planning", children: [
        { label: "Planning \u2014 Termly & Weekly", href: "/ey/planning" },
        { label: "AI-Assisted Planning", href: "/ey/areas" },
        { label: "Draft Next Half-Term", href: "/ey/plan-draft" },
        { label: "Teaching Toolbox", href: "/ey/toolbox" },
        { label: "Planning in fortnights \u2014 demo", href: "/ey/planning-demo/index.html" },
      ]},
      { icon: "\ud83d\udccb", label: "Reports & Checks", children: [
        { label: "Reports Due", href: "/ey/reports-due" },
        { label: "Reports", href: "/ey/reports" },
        { label: "Summative / Transition Reports", href: "/ey/reports/summative" },
        { label: "Termly Updates", href: "/ey/termly-update" },
        { label: "Termly Update Tracker", href: "/ey/termly-tracker" },
        { label: "Duties Tracker", href: "/ey/duties" },
        { label: "2-Year Progress Check", href: "/ey/trackers/two-year-check" },
        { label: "2-Year Checks \u2014 review & send", href: "/ey/two-year-check/review" },
        { label: "Review Queue \u2014 Observations", href: "/ey/review-queue.html" },
      ]},
      { icon: "\ud83e\udded", label: "CPD & Reflection", children: [
        { label: "Deep Dive", href: "/ey/deep-dive" },
        { label: "Fledge — progress framework", href: "/ey/fledge-framework.html" },
        { label: "My Reflection & CPD", href: "/ey/reflect" },
        { label: "My Supervisions", href: "/ey/supervisions" },
        { label: "Tasks (incl. action plans)", href: "/ey/my-tasks?projects=1" },
        { label: "Policies to Sign", href: "/ey/policies" },
        { label: "My Shifts", href: "/ey/my-shifts" },
        { label: "My Leave", href: "/ey/my-leave" },
        { label: "My Tasks", href: "/ey/my-tasks" },
        { label: "My Documents", href: "/ey/my-documents" },
        { label: "Reading Room", href: "/ey/library" },
      ]},
      { icon: "\ud83d\udee1\ufe0f", label: "Safeguarding & Records", children: [
        { label: "Safeguarding \u2014 Review Concerns", href: "/ey-legacy/safeguarding.html" },
        { label: "Pathways — read-only", href: "/ey/pathways" },
        { label: "Accidents & Incidents \u2014 Sign Off", href: "/ey-legacy/incidents.html" },
        { label: "Medicine Records", href: "/ey-legacy/medicine.html" },
        { label: "Request CCTV Footage", href: "/ey/cctv-request" },
      ]},
      { icon: "\u2709\ufe0f", label: "Messages", children: [
        { label: "Nursery Inbox", href: "/ey/nursery-inbox.html" },
        { label: "Send an Email", href: "/ey/send-email" },
        { label: "Announcements", href: "/ey/inbox" },
        { label: "Events", href: "/ey/events" },
      ]},
      { icon: "\ud83c\udfe0", label: "The Setting", children: [
        { label: "Risk Assessment", href: "/ey/risk-assessments" },
        { label: "Repairs & Maintenance", href: "/ey/repairs" },
        { label: "Resources & Equipment", href: "/ey/resources" },
        { label: "Building Controls (heating & fridges)", href: "http://homeassistant.local:8123" },
      ]},
      { icon: "\u2753", label: "Help & Account", children: [
        { label: "Ask Wren", href: "/ey/ask-wren" },
        { label: "How Wren Works", href: "/ey/how-wren-works.html" },
        { label: "Help", href: "/ey/help" },
        { label: "Settings", href: "/ey/settings" },
        { label: "Request access / unblock", href: "/ey/request-access" },
        { label: "Report a bug / feedback" },
        { label: "Sign Out" },
      ]},
    ],
    room_leader: [
      { icon: "\ud83c\udf24\ufe0f", label: "My Day", children: [
        { label: "My Morning", href: "/ey/my-morning" },
        { label: "Child Register", href: "/ey/weekly-register" },
        { label: "Sign In / Out", href: "/ey/signin" },
        { label: "Room Headcount", href: "/ey/room-headcount" },
        { label: "Staff Clock-In", href: "/ey/staff-clock" },
        { label: "Front Door", href: "/ey/door" },
        { label: "Kitchen", href: "/ey/kitchen" },
        { label: "Viewings", href: "/ey/viewings" },
      ]},
      { icon: "\ud83d\udc76", label: "Children", children: [
        { label: "Key Children", href: "/ey/key-children" },
        { label: "New Starters", href: "/ey/new-starters" },
        { label: "Memory Books", href: "/ey/memory-books" },
        { label: "Observation Drafts", href: "/ey/drafts" },
        { label: "Family / Termly Reviews", href: "/ey/termly-review" },
        { label: "SEND Register", href: "/ey/sen" },
        { label: "SEN Toolkit", href: "/ey/sen-toolkit" },
      ]},
      { icon: "\ud83d\uddd3\ufe0f", label: "Planning", children: [
        { label: "Planning \u2014 Termly & Weekly", href: "/ey/planning" },
        { label: "AI-Assisted Planning", href: "/ey/areas" },
        { label: "Draft Next Half-Term", href: "/ey/plan-draft" },
        { label: "Teaching Toolbox", href: "/ey/toolbox" },
        { label: "Planning in fortnights \u2014 demo", href: "/ey/planning-demo/index.html" },
      ]},
      { icon: "\ud83d\udccb", label: "Reports & Checks", children: [
        { label: "Reports Due", href: "/ey/reports-due" },
        { label: "Reports", href: "/ey/reports" },
        { label: "Summative / Transition Reports", href: "/ey/reports/summative" },
        { label: "Termly Updates", href: "/ey/termly-update" },
        { label: "Termly Update Tracker", href: "/ey/termly-tracker" },
        { label: "Duties Tracker", href: "/ey/duties" },
        { label: "2-Year Progress Check", href: "/ey/trackers/two-year-check" },
        { label: "2-Year Checks \u2014 review & send", href: "/ey/two-year-check/review" },
        { label: "Review Queue \u2014 Observations", href: "/ey/review-queue.html" },
      ]},
      { icon: "\ud83e\udded", label: "CPD & Reflection", children: [
        { label: "Deep Dive", href: "/ey/deep-dive" },
        { label: "Fledge — progress framework", href: "/ey/fledge-framework.html" },
        { label: "My Reflection & CPD", href: "/ey/reflect" },
        { label: "My Supervisions", href: "/ey/supervisions" },
        { label: "Tasks (incl. action plans)", href: "/ey/my-tasks?projects=1" },
        { label: "Policies to Sign", href: "/ey/policies" },
        { label: "My Shifts", href: "/ey/my-shifts" },
        { label: "My Leave", href: "/ey/my-leave" },
        { label: "My Tasks", href: "/ey/my-tasks" },
        { label: "My Documents", href: "/ey/my-documents" },
        { label: "Reading Room", href: "/ey/library" },
      ]},
      { icon: "\ud83d\udee1\ufe0f", label: "Safeguarding & Records", children: [
        { label: "Safeguarding \u2014 Review Concerns", href: "/ey-legacy/safeguarding.html" },
        { label: "Medicine Records", href: "/ey-legacy/medicine.html" },
        { label: "Request CCTV Footage", href: "/ey/cctv-request" },
        { label: "Pathways — read-only", href: "/ey/pathways" },
      ]},
      { icon: "\u2709\ufe0f", label: "Messages", children: [
        { label: "Nursery Inbox", href: "/ey/nursery-inbox.html" },
        { label: "Send an Email", href: "/ey/send-email" },
        { label: "Announcements", href: "/ey/inbox" },
        { label: "Events", href: "/ey/events" },
      ]},
      { icon: "\ud83c\udfe0", label: "The Setting", children: [
        { label: "Risk Assessment", href: "/ey/risk-assessments" },
        { label: "Repairs & Maintenance", href: "/ey/repairs" },
        { label: "Resources & Equipment", href: "/ey/resources" },
        { label: "Building Controls (heating & fridges)", href: "http://homeassistant.local:8123" },
      ]},
      { icon: "\u2753", label: "Help & Account", children: [
        { label: "How Wren Works", href: "/ey/how-wren-works.html" },
        { label: "Help", href: "/ey/help" },
        { label: "Settings", href: "/ey/settings" },
        { label: "Request access / unblock", href: "/ey/request-access" },
        { label: "Report a bug / feedback" },
        { label: "Sign Out" },
      ]},
    ],
    practitioner: [
      { icon: "\ud83c\udf24\ufe0f", label: "My Day", children: [
        { label: "My Morning", href: "/ey/my-morning" },
        { label: "Child Register", href: "/ey/weekly-register" },
        { label: "Sign In / Out", href: "/ey/signin" },
        { label: "Room Headcount", href: "/ey/room-headcount" },
        { label: "Staff Clock-In", href: "/ey/staff-clock" },
        { label: "Front Door", href: "/ey/door" },
        { label: "Kitchen", href: "/ey/kitchen" },
        { label: "Viewings", href: "/ey/viewings" },
      ]},
      { icon: "\ud83d\udc76", label: "Children", children: [
        { label: "Key Children", href: "/ey/key-children" },
        { label: "New Starters", href: "/ey/new-starters" },
        { label: "Observation Drafts", href: "/ey/drafts" },
        { label: "Family / Termly Reviews", href: "/ey/termly-review" },
        { label: "SEND Register", href: "/ey/sen" },
        { label: "SEN Toolkit", href: "/ey/sen-toolkit" },
      ]},
      { icon: "\ud83d\uddd3\ufe0f", label: "Planning", children: [
        { label: "Planning \u2014 Termly & Weekly", href: "/ey/planning" },
        { label: "AI-Assisted Planning", href: "/ey/areas" },
        { label: "Draft Next Half-Term", href: "/ey/plan-draft" },
        { label: "Teaching Toolbox", href: "/ey/toolbox" },
        { label: "Planning in fortnights \u2014 demo", href: "/ey/planning-demo/index.html" },
      ]},
      { icon: "\ud83d\udccb", label: "Reports & Checks", children: [
        { label: "Reports Due", href: "/ey/reports-due" },
        { label: "Reports", href: "/ey/reports" },
        { label: "Summative / Transition Reports", href: "/ey/reports/summative" },
        { label: "Termly Updates", href: "/ey/termly-update" },
        { label: "Termly Update Tracker", href: "/ey/termly-tracker" },
        { label: "Duties Tracker", href: "/ey/duties" },
        { label: "2-Year Progress Check", href: "/ey/trackers/two-year-check" },
        { label: "2-Year Checks \u2014 review & send", href: "/ey/two-year-check/review" },
      ]},
      { icon: "\ud83e\udded", label: "CPD & Reflection", children: [
        { label: "Deep Dive", href: "/ey/deep-dive" },
        { label: "Fledge — progress framework", href: "/ey/fledge-framework.html" },
        { label: "My Reflection & CPD", href: "/ey/reflect" },
        { label: "My Supervisions", href: "/ey/supervisions" },
        { label: "Tasks (incl. action plans)", href: "/ey/my-tasks?projects=1" },
        { label: "Policies to Sign", href: "/ey/policies" },
        { label: "My Shifts", href: "/ey/my-shifts" },
        { label: "My Leave", href: "/ey/my-leave" },
        { label: "My Tasks", href: "/ey/my-tasks" },
        { label: "My Documents", href: "/ey/my-documents" },
        { label: "Reading Room", href: "/ey/library" },
      ]},
      { icon: "\ud83d\udee1\ufe0f", label: "Safeguarding & Records", children: [
        { label: "Medicine Records", href: "/ey-legacy/medicine.html" },
        { label: "Request CCTV Footage", href: "/ey/cctv-request" },
        { label: "Pathways — read-only", href: "/ey/pathways" },
      ]},
      { icon: "\u2709\ufe0f", label: "Messages", children: [
        { label: "Nursery Inbox", href: "/ey/nursery-inbox.html" },
        { label: "Send an Email", href: "/ey/send-email" },
        { label: "Announcements", href: "/ey/inbox" },
        { label: "Events", href: "/ey/events" },
      ]},
      { icon: "\ud83c\udfe0", label: "The Setting", children: [
        { label: "Risk Assessment", href: "/ey/risk-assessments" },
        { label: "Repairs & Maintenance", href: "/ey/repairs" },
        { label: "Resources & Equipment", href: "/ey/resources" },
        { label: "Building Controls (heating & fridges)", href: "http://homeassistant.local:8123" },
      ]},
      { icon: "\u2753", label: "Help & Account", children: [
        { label: "How Wren Works", href: "/ey/how-wren-works.html" },
        { label: "Help", href: "/ey/help" },
        { label: "Settings", href: "/ey/settings" },
        { label: "Request access / unblock", href: "/ey/request-access" },
        { label: "Report a bug / feedback" },
        { label: "Sign Out" },
      ]},
    ],
    apprentice: [
      { icon: "\ud83c\udf24\ufe0f", label: "My Day", children: [
        { label: "My Morning", href: "/ey/my-morning" },
        { label: "Child Register", href: "/ey/weekly-register" },
        { label: "Sign In / Out", href: "/ey/signin" },
        { label: "Room Headcount", href: "/ey/room-headcount" },
        { label: "Staff Clock-In", href: "/ey/staff-clock" },
        { label: "Front Door", href: "/ey/door" },
        { label: "Kitchen", href: "/ey/kitchen" },
        { label: "Viewings", href: "/ey/viewings" },
      ]},
      { icon: "\ud83d\udc76", label: "Children", children: [
        { label: "Key Children", href: "/ey/key-children" },
        { label: "New Starters", href: "/ey/new-starters" },
        { label: "Observation Drafts", href: "/ey/drafts" },
        { label: "Family / Termly Reviews", href: "/ey/termly-review" },
        { label: "SEND Register", href: "/ey/sen" },
        { label: "SEN Toolkit", href: "/ey/sen-toolkit" },
      ]},
      { icon: "\ud83d\uddd3\ufe0f", label: "Planning", children: [
        { label: "Planning \u2014 Termly & Weekly", href: "/ey/planning" },
        { label: "Teaching Toolbox", href: "/ey/toolbox" },
        { label: "Planning in fortnights \u2014 demo", href: "/ey/planning-demo/index.html" },
      ]},
      { icon: "\ud83d\udccb", label: "Reports & Checks", children: [
        { label: "Reports Due", href: "/ey/reports-due" },
        { label: "Reports", href: "/ey/reports" },
        { label: "Summative / Transition Reports", href: "/ey/reports/summative" },
        { label: "Termly Updates", href: "/ey/termly-update" },
        { label: "Termly Update Tracker", href: "/ey/termly-tracker" },
        { label: "Duties Tracker", href: "/ey/duties" },
        { label: "2-Year Progress Check", href: "/ey/trackers/two-year-check" },
        { label: "2-Year Checks \u2014 review & send", href: "/ey/two-year-check/review" },
      ]},
      { icon: "\ud83e\udded", label: "CPD & Reflection", children: [
        { label: "Deep Dive", href: "/ey/deep-dive" },
        { label: "Fledge — progress framework", href: "/ey/fledge-framework.html" },
        { label: "My Reflection & CPD", href: "/ey/reflect" },
        { label: "My Supervisions", href: "/ey/supervisions" },
        { label: "Tasks (incl. action plans)", href: "/ey/my-tasks?projects=1" },
        { label: "Policies to Sign", href: "/ey/policies" },
        { label: "My Shifts", href: "/ey/my-shifts" },
        { label: "My Leave", href: "/ey/my-leave" },
        { label: "My Tasks", href: "/ey/my-tasks" },
        { label: "My Documents", href: "/ey/my-documents" },
        { label: "Reading Room", href: "/ey/library" },
      ]},
      { icon: "\ud83d\udee1\ufe0f", label: "Safeguarding & Records", children: [
        { label: "Medicine Records", href: "/ey-legacy/medicine.html" },
        { label: "Request CCTV Footage", href: "/ey/cctv-request" },
      ]},
      { icon: "\u2709\ufe0f", label: "Messages", children: [
        { label: "Nursery Inbox", href: "/ey/nursery-inbox.html" },
        { label: "Send an Email", href: "/ey/send-email" },
        { label: "Announcements", href: "/ey/inbox" },
        { label: "Events", href: "/ey/events" },
      ]},
      { icon: "\ud83c\udfe0", label: "The Setting", children: [
        { label: "Risk Assessment", href: "/ey/risk-assessments" },
        { label: "Repairs & Maintenance", href: "/ey/repairs" },
        { label: "Resources & Equipment", href: "/ey/resources" },
        { label: "Building Controls (heating & fridges)", href: "http://homeassistant.local:8123" },
      ]},
      { icon: "\u2753", label: "Help & Account", children: [
        { label: "How Wren Works", href: "/ey/how-wren-works.html" },
        { label: "Help", href: "/ey/help" },
        { label: "Settings", href: "/ey/settings" },
        { label: "Request access / unblock", href: "/ey/request-access" },
        { label: "Report a bug / feedback" },
        { label: "Sign Out" },
      ]},
    ],
  };

  // Roles that are not listed above resolve through navMpaRoleList's alias map
  // (deputy/admin/headteacher -> manager, room-leader -> room_leader) or fall
  // back to `practitioner`, exactly as every other MPA edition does.

  /* fledge-off (2026-10-26) — the Fledge tile answers to the ONE Fledge switch
   * (ladn.settings.fledge_enabled, read in the browser by public/js/wren-fledge.js).
   * While it is off the matrix screen does not offer a "Fledge — progress framework"
   * row either. HIDDEN, not deleted: every declaration above is unchanged (b273-verify
   * still sees it item for item), more.html still carries the tile behind
   * data-fledge, and the row comes back as soon as the switch reads on. */
  (function () {
    var on = false;
    try { on = !!(window.WrenFledge && window.WrenFledge.enabled()); } catch (e) { on = false; }
    if (!on) { try { on = sessionStorage.getItem('wrenFledgeOn') === '1'; } catch (e) { on = false; } }
    if (on) return;
    var isFledge = function (x) { return !!x && x.href === '/ey/fledge-framework.html'; };
    window.WREN_EY_MORE_ITEMS = ITEMS.filter(function (x) { return !isFledge(x); });
    var NAV = window.WREN_EY_MORE_NAV || {};
    var out = {};
    Object.keys(NAV).forEach(function (role) {
      out[role] = (NAV[role] || []).map(function (g) {
        if (!g || !Array.isArray(g.children)) return g;
        var copy = {}; Object.keys(g).forEach(function (k) { copy[k] = g[k]; });
        copy.children = g.children.filter(function (c) { return !isFledge(c); });
        return copy;
      });
    });
    window.WREN_EY_MORE_NAV_ALL = NAV;     // the full declaration, for anything that needs it
    window.WREN_EY_MORE_NAV = out;
  })();
}());
