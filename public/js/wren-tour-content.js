/*! wren-tour-content.js — b201 (2026-08-19)
 *
 * The Wren guided-tour CORPUS: one entry per page, and per section-within-a-page,
 * across all four portals (Roost / Nest / Finch / Seed).
 *
 * This file is DATA ONLY. The engine (public/js/wren-tour.js) turns entries into
 * spotlight steps; scripts/tour-brain-ingest.js turns the same entries into RAG
 * chunks in qdrant `wren_brain_v1` so the assistant can answer "where do I find X?"
 * with a real deep link. Keep it require()-able from Node — do not add DOM calls.
 *
 * Written for someone competent who has been away a year — not a beginner, not a
 * developer. Every entry answers three questions:
 *    what   — what this screen is for
 *    does   — what a manager typically does here
 *    gotcha — the one thing people get wrong
 *
 * Honesty rule (b201 req 5): where the b200 crawl proved a flow is broken, the
 * entry carries status:'broken' + issue:'…'. The engine renders that as a warning
 * band instead of teaching the broken flow, and the RAG chunk says so too.
 *
 * Step fields
 *   id      stable slug, '<portal>.<thing>'          (never renumber — RAG + progress key off it)
 *   url     canonical deep link (what "where do I find X?" answers with)
 *   title   card heading
 *   what/does/gotcha  the three sentences above
 *   nav     Roost SPA section id  → engine calls Wren.navigate(nav, tab)
 *   tab     Roost SPA tab id
 *   sel     optional CSS selector to spotlight
 *   tracks  extra track ids beyond 'everything' (which every step joins)
 *   tags    extra search words for the "where do I find X?" matcher
 *   status  'ok' (default) | 'broken' | 'partial'
 *   issue   required when status !== 'ok'
 */
(function (root, factory) {
  var data = factory();
  if (typeof module === 'object' && module.exports) module.exports = data;
  if (root) root.WrenTourContent = data;
})(typeof self !== 'undefined' ? self : null, function () {
  'use strict';

  // ───────────────────────────────────────────────────────────────────────────
  // ROOST (admin portal) — SPA sections at /admin/<section>/<tab>
  // ───────────────────────────────────────────────────────────────────────────
  var roost = [];

  // A section-level entry: the sidebar walk. sel targets the real sidebar button.
  function sec(id, title, what, does, gotcha, extra) {
    var s = {
      id: 'roost.' + id, url: '/admin/' + id, title: title,
      what: what, does: does, gotcha: gotcha,
      nav: id, sel: '.v2-section-list [data-section="' + id + '"]',
      tracks: (extra && extra.tracks) || [], tags: (extra && extra.tags) || [],
    };
    if (extra && extra.status) { s.status = extra.status; s.issue = extra.issue; }
    if (extra && extra.aliases) s.aliases = extra.aliases;
    roost.push(s);
    return s;
  }
  // A tab-level entry inside a section.
  function tab(sectionId, tabId, title, what, does, gotcha, extra) {
    var s = {
      id: 'roost.' + sectionId + '.' + tabId,
      url: '/admin/' + sectionId + '/' + tabId, title: title,
      what: what, does: does, gotcha: gotcha,
      nav: sectionId, tab: tabId,
      sel: '#section-content .wren-tab[data-tab="' + tabId + '"]',
      tracks: (extra && extra.tracks) || [], tags: (extra && extra.tags) || [],
    };
    if (extra && extra.status) { s.status = extra.status; s.issue = extra.issue; }
    if (extra && extra.aliases) s.aliases = extra.aliases;
    roost.push(s);
    return s;
  }
  // A standalone Roost page (full navigation, not an SPA fragment).
  function page(slug, url, title, what, does, gotcha, extra) {
    var s = {
      id: 'roost.' + slug, url: url, title: title,
      what: what, does: does, gotcha: gotcha, href: url,
      tracks: (extra && extra.tracks) || [], tags: (extra && extra.tags) || [],
    };
    if (extra && extra.status) { s.status = extra.status; s.issue = extra.issue; }
    if (extra && extra.sel) s.sel = extra.sel;
    if (extra && extra.aliases) s.aliases = extra.aliases;
    roost.push(s);
    return s;
  }

  // ── Orientation ────────────────────────────────────────────────────────────
  roost.push({
    id: 'roost.welcome', url: '/admin/cockpit', title: '🐦 Welcome back to Roost',
    what: 'Roost is the admin portal — the whole nursery from the office chair. The other three portals are Nest (practitioners, on the tablets), Finch (parents) and Seed (HR/staff self-service); they all read and write the same database, so anything you change here shows up there within a page refresh.',
    does: 'Managers live in Cockpit, Children, Comms and Finance. Everything else is either weekly (Inspection, Checklist, CPD) or event-driven (Safeguarding, Admissions).',
    gotcha: 'Roost opens on <b>Cockpit</b>, not a dashboard — if you are hunting for "the dashboard" you are probably after Cockpit → Health, or Finance → Dashboard.',
    sel: '.topbar-logo, #wren-topbar .wren-logo, #wren-app-topbar .wren-app-logo, #wren-app-topbar', tracks: ['daily'], tags: ['home', 'start', 'admin portal', 'roost'],
  });
  roost.push({
    id: 'roost.search', url: '/admin/cockpit', title: '🔍 Ctrl + K finds anything',
    what: 'A single search box over every section, tab, child, staff member and parent.',
    does: 'Press <b>Ctrl + K</b> (⌘K on Mac) and type three or four letters — "fund", "brad", "consent" — then Enter.',
    gotcha: 'It searches the section registry, so a section that is switched OFF in System → Settings will not appear. If something is "missing", check the module toggle before assuming it is gone.',
    sel: '#wren-search-btn', tracks: ['daily'], tags: ['search', 'find', 'ctrl k', 'command palette'],
  });

  // ── Cockpit ────────────────────────────────────────────────────────────────
  sec('cockpit', '🛩️ Cockpit',
    'The command centre and the admin home page: today\'s comms, the kanban to-do board, system health, a timeline of what happened, plus SWOT and mind-map scratch space.',
    'Start the day here: clear the comms feed, drag anything that needs doing onto the kanban board, glance at Health for red rows.',
    'Cockpit is manager-only. A practitioner logging into Roost lands on Staff instead — that is by design, not a broken link.',
    { tracks: ['daily'], tags: ['home', 'dashboard', 'command centre', 'to do'] });
  tab('cockpit', 'comms', '🛩️ Cockpit → Comms',
    'A merged feed of the nursery inbox, parent messages, enquiry replies and anything the email gateway flagged — everything waiting on a human.',
    'Triage top-down each morning: reply, delegate to the kanban board, or archive.',
    'This feed is a view, not a mailbox. Replying here writes to the same thread as Comms → Inbox, so do not answer the same message in both places.',
    { tracks: ['daily', 'comms'], tags: ['inbox', 'feed', 'messages'] });
  tab('cockpit', 'kanban', '🛩️ Cockpit → Kanban',
    'The ADHD-friendly to-do board. Staff feedback reports and bug reports land here as cards automatically.',
    'Drag cards between columns; add a card for anything that came up in conversation and would otherwise be lost.',
    'Cards are personal-ish but the board is shared — do not use it for anything about a named child, that belongs in Safeguarding or the child\'s profile.',
    { tracks: ['daily'], tags: ['todo', 'tasks', 'board', 'kanban', 'feedback reports'] });
  tab('cockpit', 'health', '🛩️ Cockpit → Health',
    'Live checks on the things that silently stop working: integrations, sync jobs, backups, the door, the AI box.',
    'Scan for red once a day. A red row here explains most "why is X empty?" questions before you go hunting.',
    'Amber usually means "has not run yet today", not "broken" — check the timestamp before raising it.',
    { tracks: ['daily', 'setup'], tags: ['status', 'health', 'monitoring', 'integrations'] });
  tab('cockpit', 'timeline', '🛩️ Cockpit → Timeline',
    'A chronological record of significant events across the setting — who did what, when.',
    'Use it to reconstruct a day: "when did that incident get logged, and who signed it off?"',
    'It is a summary timeline, not the audit log. For evidence-grade detail (IP, user, before/after) use System → Audit log.',
    { tracks: ['compliance'], tags: ['history', 'timeline', 'activity'] });
  tab('cockpit', 'swot', '🛩️ Cockpit → SWOT',
    'A living SWOT for the setting, with an AI first draft generated from your own documents and decision log.',
    'Refresh it before a governance conversation, an inspection, or the annual plan; edit the draft — it is a starting point.',
    'The draft is written by the local model from your data. Read every line before you quote it to anyone; it is labelled "draft" for a reason.',
    { tracks: ['compliance'], tags: ['swot', 'strategy', 'planning'] });
  tab('cockpit', 'mindmap', '🛩️ Cockpit → Mind map',
    'Free-form thinking space; notes are stored as plain Markdown in the Obsidian vault on the server.',
    'Sketch out a change before it becomes an action plan.',
    'Nothing here is a record. Anything that needs to survive an inspection belongs in Action Plans or the Decision Log, not the mind map.',
    { tags: ['notes', 'mindmap', 'obsidian', 'ideas'] });

  // ── Admissions ─────────────────────────────────────────────────────────────
  sec('admissions', '🌱 Admissions',
    'The funnel from first phone call to first day: occupancy, the enquiry pipeline, the waiting list and the yield engine that forecasts what the roll looks like next term.',
    'Move enquiries along the pipeline, book viewings, and check occupancy before promising a family a start date.',
    'Occupancy here counts <em>booked</em> children from the attendance register, not signed contracts. A verbal "yes" from a parent is not occupancy until the booking exists.',
    { tracks: ['admissions'], tags: ['enquiries', 'waiting list', 'occupancy', 'places', 'intake'] });
  tab('admissions', 'occupancy', '🌱 Admissions → Occupancy',
    'Room-by-room, week-by-week occupancy against capacity (Baby Room 10, Pre-school 22).',
    'Check before quoting availability, and again when planning staffing for the term.',
    'A room can read over capacity legitimately — part-time children double-booked across different days. Look at the day columns, not the headline number.',
    { tracks: ['admissions', 'daily'], tags: ['capacity', 'rooms', 'spaces', 'availability'] });
  tab('admissions', 'pipeline', '🌱 Admissions → Pipeline',
    'Every live enquiry as a card, from first contact through the waiting list, Allocated and Forms &amp; deposit to registered (or lost).',
    'Work it daily. Click a card, then <b>Next stage</b> to move it on: at Forms &amp; deposit, Next stage is <b>Send deposit info &amp; registration form</b>, and once the form is back it sends the welcome pack. <b>✎ Edit details</b> on the card adds a missing email, phone number, date of birth or start date later. Each card holds the family\'s contact history, so you never ask "who called them back?"',
    'An enquiry that is never moved out of "new" still counts in the conversion stats and quietly wrecks them. Mark lost enquiries as lost.',
    { tracks: ['admissions'], tags: ['enquiries', 'leads', 'pipeline', 'viewings', 'registration form', 'send registration form', 'deposit', 'welcome pack', 'next stage', 'edit details', 'missing details', 'parent email'] });
  tab('admissions', 'waitlist-board', '🌐 Admissions → Website availability',
    'What parents see on the availability page of the nursery website, month by month for each room. Wren works it out from the children\'s start, move-up and leave dates.',
    'If a month is wrong, click it and set it to open, limited or full by hand. The website updates within about 2 minutes. The yellow box lists every month set by hand and when; <b>Clear all of them</b> hands them back to Wren.',
    'A month set by hand stays that way until you clear it, whatever changes. Old hand-set months are the usual reason the website looks wrong.',
    { tracks: ['admissions', 'comms'], tags: ['website', 'availability', 'public availability', 'heat map', 'spaces', 'waiting list', 'override'] });
  tab('admissions', 'engine', '🌱 Admissions → Engine',
    'The yield/forecast engine — projects future occupancy from bookings, leavers, funded-hour changes and pipeline probability.',
    'Run it before setting fees or committing to a new staff hire.',
    'It is a forecast built on today\'s bookings. Change the bookings and the forecast changes — do not treat a saved forecast as a record.',
    { tracks: ['admissions', 'finance'], tags: ['forecast', 'yield', 'projection', 'occupancy planning'] });

  // ── Action Plans ───────────────────────────────────────────────────────────
  sec('action-plans', '⭐ Action Plans',
    'Improvement plans for the setting and for each room, with items, owners, comments and a full audit trail.',
    'Raise an action, give it an owner and a date, and review it at the next management meeting.',
    'Plans can be shared with parents. Check the "shared with parents" flag before you write anything candid — shared plans appear in Finch.',
    { tracks: ['compliance'], tags: ['improvement', 'actions', 'sef', 'quality'] });
  tab('action-plans', 'management', '⭐ Action Plans → Management',
    'The whole-setting plan — leadership, compliance and business actions.',
    'Own this one yourself; review it monthly and close items with evidence, not just a tick.',
    'Closing an item without a comment leaves nothing for an inspector to read. Write one line of evidence when you close.',
    { tracks: ['compliance'], tags: ['management plan', 'leadership'] });
  tab('action-plans', 'baby-room', '⭐ Action Plans → Baby Room',
    'The Baby Room\'s own improvement plan (6 months–2 years).',
    'Agree items with the room leader in supervision, then track them here rather than on paper.',
    'Room plans are visible to that room\'s staff. Individual performance concerns go in Supervisions, not the room plan.',
    { tags: ['baby room', 'room plan'] });
  tab('action-plans', 'pre-school', '⭐ Action Plans → Pre-school',
    'The Pre-school room plan (2–5 years).',
    'Same rhythm as the Baby Room — agreed in supervision, reviewed monthly.',
    'Do not duplicate curriculum work here; planning belongs in Curriculum → Planning and Termly Plan.',
    { tags: ['pre-school', 'room plan'] });
  tab('action-plans', 'shared-with-parents', '⭐ Action Plans → Shared with parents',
    'The subset of actions deliberately published to the parents portal — "you said, we did".',
    'Share two or three visible improvements a term; it is the cheapest trust-building in the product.',
    'Sharing is one-way and immediate. Unshare removes it from Finch but parents may already have read it.',
    { tracks: ['comms'], tags: ['parents', 'you said we did', 'transparency'] });

  // ── Staff ──────────────────────────────────────────────────────────────────
  sec('staff', '👥 Staff',
    'The staff hub: the list, the calendar, the rota builder, supervisions, Bradford scores, training, documents, observation practice and performance.',
    'Most weeks: build/publish the rota, check Bradford for absence patterns, and prep supervisions.',
    'Pay is manager-only (the <code>view_staff_salaries</code> capability). A deputy sees hours and invoices but not salary — so "the numbers look wrong" is often "you are not allowed to see them".',
    { tracks: ['people', 'daily'], tags: ['team', 'employees', 'rota', 'hr'] });
  tab('staff', 'list', '👥 Staff → List',
    'Every staff member, their role, room, contract and status. The doorway to each individual profile.',
    'Add a new starter, change a role, or mark a leaver. Click a row to open the full profile.',
    'Deactivate leavers, never delete them — their observations, supervisions and safeguarding entries must survive.',
    { tracks: ['people'], tags: ['staff list', 'employees', 'add staff', 'new starter', 'leaver'] });
  tab('staff', 'calendar', '👥 Staff → Calendar',
    'A month view of who is off, who is in, training days and key dates.',
    'Sanity-check leave clashes before approving an absence request.',
    'Known issue (b200): the Google Calendar feed behind this tab returns a 500 — the Wren-native entries still render, the Google overlay does not.',
    { tracks: ['people'], tags: ['calendar', 'leave', 'holidays', 'dates'],
      status: 'broken', issue: 'GET /api/google-cal/events returns HTTP 500 (b200 crawl, 2026-08-19). Wren-native events render; the Google overlay does not. Use Staff → List / Absence Approval until the Google Calendar credential is refixed.' });
  tab('staff', 'rota', '👥 Staff → Rota',
    'The rota builder: shifts, open shifts staff can claim, live ratio checking and Auto-Generate from saved work patterns.',
    'Build next week with Auto-Generate, fix the gaps by hand, check the ratio bar is green, then publish.',
    '<b>Publishing emails every member of staff.</b> Never publish a test or draft week on production — build it, look at it, and leave it unpublished.',
    { tracks: ['people', 'daily'], tags: ['rota', 'shifts', 'scheduling', 'ratios', 'staffing'] });
  tab('staff', 'supervisions', '👥 Staff → Supervisions',
    'Supervision records and targets for each staff member, editable here and mirrored in Nest and Seed.',
    'Book, run and write up supervisions; set targets that carry into the next one.',
    'The staff member sees their own supervision in Seed. Write it as something they will read, because they will.',
    { tracks: ['people', 'compliance'], tags: ['supervision', 'one to one', '1:1', 'appraisal', 'targets'] });
  tab('staff', 'bradford', '👥 Staff → Bradford',
    'Bradford factor scores — short, frequent absences weighted more heavily than long ones.',
    'Review monthly; a rising score is a conversation, not a sanction.',
    'A high score can be a single long-term sickness or a disability-related absence. Look at the underlying record before acting.',
    { tracks: ['people'], tags: ['absence', 'bradford', 'sickness', 'attendance'] });
  tab('staff', 'training', '👥 Staff → Training',
    'Who holds what — paediatric first aid, safeguarding, food hygiene — and what expires when.',
    'Check expiries at the start of each term and book renewals before they lapse.',
    'An expired paediatric first aid certificate can put you out of ratio legally. Treat red rows here as urgent, not admin.',
    { tracks: ['people', 'compliance'], tags: ['training', 'certificates', 'first aid', 'expiry', 'qualifications'] });
  tab('staff', 'documents', '👥 Staff → Documents',
    'Per-staff document store: contracts, DBS, right-to-work, certificates.',
    'Upload on induction; re-check at renewal dates.',
    'These feed the Single Central Record. A document uploaded to the wrong person is an SCR gap that an inspector will find.',
    { tracks: ['people', 'compliance'], tags: ['documents', 'dbs', 'right to work', 'contracts', 'files'] });
  tab('staff', 'observations', '👥 Staff → Observations',
    'Observation <em>practice</em> per practitioner — volume, quality, coverage of key children.',
    'Use it supportively in supervision: "you have not observed three of your key children this month, what is getting in the way?"',
    'This is about practice, not about the children. It is deliberately not a league table — do not present it as one.',
    { tracks: ['people', 'learning'], tags: ['observation practice', 'key person', 'quality'] });
  tab('staff', 'performance', '👥 Staff → Performance',
    'Performance flags and the AI-written supportive summary (generated locally on your own hardware).',
    'Read before a supervision so you arrive with the facts rather than an impression.',
    'The summary is a draft from a local model. It is not evidence and must never be pasted into a formal HR process unchecked.',
    { tracks: ['people'], tags: ['performance', 'flags', 'appraisal'] });
  tab('staff', 'reports', '👥 Staff → Reports',
    'Staff-side reports: headcount, hours, cost per room, turnover.',
    'Pull before a budget conversation or a funding return.',
    'Salary-bearing columns are blank for non-managers by design — that is the capability gate, not missing data.',
    { tracks: ['people', 'finance'], tags: ['staff reports', 'headcount', 'hours', 'turnover'] });
  tab('staff', 'work-patterns', '👥 Staff → Work patterns',
    'Each person\'s contracted working pattern — the source Auto-Generate builds the rota from.',
    'Fix the pattern here once instead of hand-editing the rota every week.',
    'Patterns were imported from BrightHR. If a rota keeps generating wrong for one person, the pattern is wrong, not the rota.',
    { tracks: ['people'], tags: ['work patterns', 'contracted hours', 'brighthr', 'auto generate'] });
  tab('staff', 'sickness-patterns', '👥 Staff → Sickness patterns',
    'Pattern analysis over sickness absence — Mondays/Fridays, around leave, seasonality.',
    'Run it before a formal absence conversation so the pattern is evidenced, not remembered.',
    'Known issue (b200): the "latest" report 404s until the analysis has been run at least once — trigger a run first, then reload.',
    { tracks: ['people'], tags: ['sickness', 'patterns', 'absence analysis'],
      status: 'partial', issue: 'GET /api/staff-analytics/sickness/latest returns HTTP 404 when no analysis has been generated yet (b200 crawl, 2026-08-19). It is an empty-state, not a crash — run the analysis to populate it.' });

  // ── Children ───────────────────────────────────────────────────────────────
  sec('children', '👶 Children',
    'Every child on roll: details, contacts, allergies, key person, funding, bookings, trackers and reports.',
    'Open a child before a parent conversation — allergies, key person and next steps in one glance.',
    'Children who have left are hidden by default. If someone "has vanished", they are on the Inactive Children page, not deleted.',
    { tracks: ['learning', 'daily'], tags: ['children', 'pupils', 'child profile', 'add a child', 'roll'] });
  tab('children', 'list', '👶 Children → List',
    'The searchable roll, with room, key person and status. Click through to the full child profile.',
    'Add a child here (or send the parent a self-service onboarding link), assign a key person, set the room.',
    'Adding a child does not create their booking pattern. A child with no bookings never appears on the register — set bookings on the child\'s Bookings tab.',
    { tracks: ['learning'], tags: ['add child', 'new child', 'enrol', 'children list', 'roll'] });
  tab('children', 'reports', '👶 Children → Reports',
    'Child-level reporting: cohort progress, funding status, attendance and report generation.',
    'Pull a cohort report at the end of each term; generate parent-facing reports from here.',
    'A report reflects data at the moment you generate it. Regenerate after late observations land, or the parent gets a stale picture.',
    { tracks: ['learning'], tags: ['child reports', 'cohort', 'progress'] });

  // ── Family ─────────────────────────────────────────────────────────────────
  sec('family', '👪 Family',
    'The parent-facing admin surface: events and RSVPs, absences parents have reported, consents, and change requests waiting for approval.',
    'Clear the approval queue daily — a parent change request sitting unapproved means their details are wrong in an emergency.',
    'Anything approved here writes straight to the child record. Read the diff before approving a contact-detail change.',
    { tracks: ['comms', 'daily'], tags: ['parents', 'family', 'consents', 'events', 'absences'] });
  tab('family', 'events', '👪 Family → Events',
    'Nursery events with parent RSVP — trips, celebrations, parent evenings.',
    'Create the event, publish to Finch, then read the RSVP list for numbers and ratios.',
    'RSVP numbers are per-family, not per-child. Check the child count before ordering food or booking a coach.',
    { tracks: ['comms'], tags: ['events', 'rsvp', 'trips', 'parents evening'] });
  tab('family', 'absences', '👪 Family → Absences',
    'Absences parents have reported themselves from Finch, and their effect on the daily register.',
    'Confirm or query each one; confirmed absences flow into the register automatically.',
    'A reported absence updates the register but does <em>not</em> change the invoice. Fee consequences are handled in Finance.',
    { tracks: ['daily'], tags: ['absence', 'sickness', 'holiday', 'parent reported'] });
  tab('family', 'consents', '👪 Family → Consents',
    'Photo, media, outings, sun cream, plasters — who has consented to what, per child.',
    'Audit before a trip or before publishing photos; chase the blanks.',
    'A missing consent is a "no", not a "probably fine". Check before any photo goes to the website or a newsletter.',
    { tracks: ['compliance'], tags: ['consent', 'permission', 'photo', 'gdpr', 'media'] });

  // ── Next Steps ─────────────────────────────────────────────────────────────
  sec('next-steps', '➡️ Next Steps',
    'Every child\'s learning next steps in one place, across the whole setting.',
    'Scan for children with nothing open, and for next steps that have been sitting there all term.',
    'Next steps are created from observations in Nest. If a child has none, the fix is a conversation with their key person, not a data entry job here.',
    { tracks: ['learning'], tags: ['next steps', 'targets', 'learning', 'planning'] });
  tab('next-steps', 'list', '➡️ Next Steps → Open',
    'All currently open next steps with child, key person and age.',
    'Filter by room in your room-leader catch-ups.',
    'Sort by age, not by child. A next step older than half a term has usually been forgotten rather than achieved.',
    { tracks: ['learning'], tags: ['open next steps'] });
  tab('next-steps', 'completed', '➡️ Next Steps → Completed',
    'Next steps marked achieved, with the observation that evidenced them.',
    'Use in supervision and in parent conversations as concrete evidence of progress.',
    'Completed with no linked observation means someone ticked a box. Spot-check a few each term.',
    { tracks: ['learning'], tags: ['completed', 'achieved'] });
  tab('next-steps', 'overdue', '➡️ Next Steps → Overdue',
    'Next steps past their expected date.',
    'This is the tab to look at, not the other two. Work it weekly.',
    'Overdue is not failure — sometimes the step was wrong. Closing it as "no longer appropriate" is a valid outcome; leaving it rotting is not.',
    { tracks: ['learning', 'daily'], tags: ['overdue', 'late'] });

  // ── Visual Support ─────────────────────────────────────────────────────────
  sec('visual-schedules', '🗓️ Visual Support',
    'Builder for visual timetables, now/next boards and symbol strips (Mulberry symbol set), plus the saved library.',
    'Build a strip for a child who needs it, print it, and save it so the room can reprint without you.',
    'Save before printing. The builder does not autosave, and a printed strip nobody can reprint gets laminated and lost.',
    { tracks: ['learning'], tags: ['visual schedule', 'now next', 'symbols', 'sen', 'pecs', 'autism'] });
  tab('visual-schedules', 'builder', '🗓️ Visual Support → Builder',
    'Drag symbols into a strip or grid, label them, size for print.',
    'Make one per routine that a child finds hard — arrival, lunch, nappy change, home time.',
    'Symbols are generic. Swap in a photo of your actual room for the routines a child struggles to generalise.',
    { tracks: ['learning'], tags: ['builder', 'make a visual timetable'] });
  tab('visual-schedules', 'saved', '🗓️ Visual Support → Saved',
    'The library of strips already made, reusable across children and rooms.',
    'Check here first — the strip you need has probably been made before.',
    'Saved strips are setting-wide, not per-child. Do not put a child\'s name on one you want to reuse.',
    { tracks: ['learning'], tags: ['saved', 'library', 'templates'] });

  // ── Curriculum ─────────────────────────────────────────────────────────────
  sec('curriculum', '📚 Curriculum',
    'What is being taught and why: weekly planning, next steps feeding into it, events, trips and the curriculum calendar.',
    'Review each room\'s plan weekly; check next steps are actually driving the planning rather than sitting beside it.',
    'Planning written in Nest and planning written here are the same records. Do not maintain a parallel paper plan — it will drift within a fortnight.',
    { tracks: ['learning'], tags: ['curriculum', 'planning', 'topics', 'eyfs'] });
  tab('curriculum', 'planning', '📚 Curriculum → Planning',
    'The weekly plan per room — adult-led activities, provision enhancements, focus children.',
    'Read Friday, tweak, and use it as the agenda for the room leader catch-up.',
    'A plan with no named focus children is a timetable, not a plan. That is the single most common Ofsted comment on EY planning.',
    { tracks: ['learning'], tags: ['weekly plan', 'planning', 'activities'] });
  tab('curriculum', 'next-steps', '📚 Curriculum → Next steps',
    'Next steps viewed through the planning lens — what the plan needs to cover this week.',
    'Cross-check the plan against this before signing it off.',
    'Same records as the Next Steps section; editing in one place changes both. Do not "re-enter" them here.',
    { tracks: ['learning'], tags: ['next steps in planning'] });
  tab('curriculum', 'events', '📚 Curriculum → Events',
    'Curriculum events — festivals, themed weeks, visitors.',
    'Plan the term\'s events in one sitting; they populate the calendar and the parents portal.',
    'Curriculum events and Family → Events are different lists with different audiences. A trip parents must RSVP to belongs in Family.',
    { tracks: ['learning'], tags: ['events', 'festivals', 'themed weeks'] });
  tab('curriculum', 'trips', '📚 Curriculum → Trips',
    'Outings: destination, ratios, risk assessment link and the permission slips.',
    'Set the trip up here so the risk assessment and permission slips are generated rather than typed.',
    'A trip without every permission slip returned cannot go. Check the slip count, not your memory of who said yes at the door.',
    { tracks: ['learning', 'compliance'], tags: ['trips', 'outings', 'permission slips', 'risk assessment'] });
  tab('curriculum', 'calendar', '📚 Curriculum → Calendar',
    'The whole curriculum year on one calendar — terms, themes, events, trips.',
    'Use it in September to sanity-check the year, then monthly to see what is coming.',
    'It shows curriculum dates only. Staff leave and training are on Staff → Calendar; the two are deliberately separate.',
    { tracks: ['learning'], tags: ['calendar', 'year plan', 'terms'] });

  // ── Finance ────────────────────────────────────────────────────────────────
  sec('finance', '💷 Finance',
    'The money end to end: dashboard, forecast, invoices, payments, funding claims, wages, payroll and the Xero bank reconciliation.',
    'Monthly: run the invoices, reconcile the bank, submit the funding claim, approve payroll.',
    'Xero is connected as a <b>custom connection</b> (no consent screen). If sync suddenly returns nothing, the app has usually lost its authorisation against the Your Nursery organisation — re-authorise in Xero, then press Connect again.',
    { tracks: ['finance'], tags: ['money', 'invoices', 'fees', 'funding', 'payroll', 'xero'] });
  tab('finance', 'dashboard', '💷 Finance → Dashboard',
    'Headline financial position: income, debt, funded vs private hours, this month against last.',
    'Look here first each month; it tells you which of the other tabs needs attention.',
    'It reads invoices, not bank movements. A healthy dashboard with an unreconciled bank means money you have billed, not money you have.',
    { tracks: ['finance'], tags: ['finance dashboard', 'income', 'position'] });
  tab('finance', 'salary-per-room', '💷 Finance → Salary per room',
    'Staff cost split by room, against that room\'s income.',
    'Use when deciding whether a room can carry another member of staff.',
    'Manager-only (salary capability). Deputies see an empty table — that is the permission gate working.',
    { tracks: ['finance', 'people'], tags: ['salary', 'cost per room', 'staff cost'] });
  tab('finance', 'funded-hours-recon', '💷 Finance → Funded-hours reconciliation',
    'Reconciles funded hours claimed against hours actually delivered, per child per term.',
    'Run before every headcount submission; discrepancies here are money you either lose or have to pay back.',
    'Stretched funding (term-time hours spread across the year) will not reconcile against a term-time claim without the stretch calculation — use the Stretch Reconciliation page for July leavers.',
    { tracks: ['finance', 'compliance'], tags: ['funded hours', 'reconciliation', 'headcount', '30 hours'] });
  tab('finance', 'forecast', '💷 Finance → Forecast',
    'Forward income projection from bookings, funding rates and the admissions pipeline.',
    'Refresh at the start of each term and before any hiring decision.',
    'It assumes current bookings continue. It cannot know about the family who told you in the car park they are leaving — record the leave date first.',
    { tracks: ['finance', 'admissions'], tags: ['forecast', 'projection', 'budget'] });
  tab('finance', 'invoices', '💷 Finance → Invoices',
    'Invoice generation, the invoice run, statements and outstanding balances.',
    'Run invoices monthly; chase the aged debt list rather than waiting for parents to notice.',
    'Regenerating an invoice for a period a parent has already paid creates a duplicate, not a correction. Credit the original instead.',
    { tracks: ['finance'], tags: ['invoices', 'billing', 'statements', 'debt'] });
  tab('finance', 'reconcile', '💷 Finance → Reconcile',
    'Bank reconciliation against the Xero feed — match statement lines to invoices and payments.',
    'Do it weekly; it takes ten minutes weekly and half a day monthly.',
    'The "Sync from Xero" button and the 6am cron use the same tokens. If the cron has been silently skipping, the tokens are missing — the Connect button is inline on this tab for exactly that reason.',
    { tracks: ['finance'], tags: ['reconcile', 'bank', 'xero', 'statements'] });
  tab('finance', 'payments', '💷 Finance → Payments',
    'Payments received: card, Direct Debit mandates, manual entries.',
    'Check failed Direct Debits weekly — a failed DD is silent to the parent until you tell them.',
    'A payment recorded here is not a reconciled payment. It still has to be matched on Reconcile or the bank will never agree.',
    { tracks: ['finance'], tags: ['payments', 'direct debit', 'card', 'gocardless', 'stripe'] });
  tab('finance', 'funding', '💷 Finance → Funding',
    'Funded hours per child per term, funding terms, eligibility codes and the claim/submission workflow.',
    'Set the term up, allocate hours per child, validate the codes, then submit the headcount.',
    'Eligibility codes expire. A code valid last term is not automatically valid this term — revalidate before you claim on it.',
    { tracks: ['finance', 'compliance'], tags: ['funding', 'funded hours', '15 hours', '30 hours', 'eyfe', 'claims', 'headcount'] });
  tab('finance', 'wages', '💷 Finance → Wages',
    'Wage calculation from clocked/rota hours, including TOIL and overtime.',
    'Review before payroll; this is where you catch the person who forgot to clock out on Tuesday.',
    'There is a known latent bug in the wages query (a <code>clock_in</code> column reference) that can 500 even for a manager. If it errors, use Payroll and the rota wage summary instead of assuming the data is gone.',
    { tracks: ['finance', 'people'], tags: ['wages', 'pay', 'hours', 'toil', 'overtime'],
      status: 'partial', issue: 'Known latent column bug in the finance-wages query can return HTTP 500 even for a manager. Workaround: Finance → Payroll and Staff → Rota wage summary.' });
  tab('finance', 'payroll', '💷 Finance → Payroll',
    'The payroll run: export, approvals and the CSV/PDF the bureau needs.',
    'Approve, export, send. Keep the export — it is your evidence of what was paid.',
    'Payroll reads the wage figures at export time. Fix wage errors <em>before</em> exporting; re-exporting after a fix does not un-send the first file.',
    { tracks: ['finance', 'people'], tags: ['payroll', 'export', 'pay run'] });

  // ── Comms ──────────────────────────────────────────────────────────────────
  sec('communications', '💬 Comms',
    'Everything outbound and inbound: the nursery inbox, parent messaging, newsletters, Aria call handling, surveys, permission slips and the email-gateway review queue.',
    'Clear the inbox, approve anything sitting in message review, and send the newsletter on schedule.',
    'Non-managers can only email parents of currently enrolled children — the allowlist blocks anything else with a 403. That is a GDPR control, not a bug.',
    { tracks: ['comms', 'daily'], tags: ['messages', 'email', 'newsletter', 'inbox', 'parents'] });
  tab('communications', 'inbox', '💬 Comms → Inbox',
    'The nursery mailbox (admin@) inside Wren, threaded, with the triage the email gateway has already done.',
    'Work it like an inbox: reply, assign, archive. Replies send from the nursery mailbox, not your personal one.',
    'Outbound send is live via the Google service account; inbound polling depends on a Gmail scope that is still pending. If the inbox looks quiet, check Cockpit → Health before assuming nobody wrote.',
    { tracks: ['comms', 'daily'], tags: ['inbox', 'email', 'gmail', 'nursery inbox'] });
  tab('communications', 'messaging', '💬 Comms → Messaging',
    'Direct parent messaging threads (the parent side lives in Finch → Messages).',
    'Answer parent messages here so the thread stays in one place and is auditable.',
    'Messages are audited and can be blocked per-parent. If a parent says they cannot message you, check parent message blocks before blaming the app.',
    { tracks: ['comms', 'daily'], tags: ['messaging', 'parent messages', 'chat', 'threads'] });
  tab('communications', 'newsletters', '💬 Comms → Newsletters',
    'Newsletter composer with sections, media, and an EyLog-style audience picker (all parents, a room, bill payers, staff…).',
    'Draft, pick the audience, preview the count, then send. Recipients are BCC-batched.',
    'It sends from <b>admin@</b>, not info@, and "bill payers" resolves to the child\'s primary contact email — not a separate contacts flag. Check the audience count before sending; it is the only preview you get.',
    { tracks: ['comms'], tags: ['newsletter', 'bulk email', 'audience', 'send to parents'] });
  tab('communications', 'aria', '💬 Comms → Aria',
    'Aria, the voice/phone assistant — call logs, transcripts and what she told callers.',
    'Skim the transcripts weekly; they are the best source of "what do parents actually ask?"',
    'Aria answers from configured tools. If the screener tools are not configured in the Vapi dashboard she takes calls but does nothing useful — check the run count is non-zero.',
    { tracks: ['comms'], tags: ['aria', 'phone', 'calls', 'vapi', 'voice'] });
  tab('communications', 'content-creator', '💬 Comms → Content creator',
    'AI-assisted drafting for newsletters, social posts and parent-facing copy, running on your own hardware.',
    'Generate a first draft, then rewrite it in your own voice — the draft is scaffolding.',
    'Never paste a child\'s name into the prompt. The model is local, but the content ends up published.',
    { tracks: ['comms'], tags: ['content', 'ai writing', 'social media', 'drafts'] });
  tab('communications', 'message-review', '💬 Comms → Message review',
    'The manager approval queue for staff-written parent messages.',
    'Clear it daily — a message waiting for approval is a parent waiting for an answer.',
    'Approving sends immediately. Edit before approving if the tone is wrong; there is no recall.',
    { tracks: ['comms', 'daily'], tags: ['message review', 'approval queue', 'moderation'] });
  tab('communications', 'surveys', '💬 Comms → Surveys',
    'Parent and staff surveys — build, send, and read the responses.',
    'Run the annual parent survey from here; the results feed the SEF and the inspection evidence.',
    'Anonymous surveys really are anonymous — you cannot chase a specific non-responder. Decide on anonymity before you send, not after.',
    { tracks: ['comms', 'compliance'], tags: ['surveys', 'feedback', 'questionnaire', 'parent voice'] });
  tab('communications', 'permission-slips', '💬 Comms → Permission slips',
    'Digital permission slips: issue, chase, and see who has returned them.',
    'Issue as soon as a trip is booked, then use the outstanding list as your chase list.',
    'A slip issued to a parent who has never logged into Finch will sit unread forever. Check parent portal access first for new families.',
    { tracks: ['comms', 'compliance'], tags: ['permission slips', 'consent forms', 'trips'] });
  tab('communications', 'templates', '💬 Comms → Templates',
    'Reusable message and email templates.',
    'Template anything you have typed twice — waiting-list replies, fee reminders, settling-in emails.',
    'Templates with merge fields break silently if the field is empty (you get "Dear ,"). Preview with a real child before saving.',
    { tracks: ['comms'], tags: ['templates', 'canned responses', 'merge fields'] });

  // ── Safeguarding ───────────────────────────────────────────────────────────
  sec('safeguarding', '🛡️ Safeguarding',
    'Concerns, the sign-off queue, the chronology log and the audit trail. Locked on for every setting — this module never switches off.',
    'Read new concerns the day they are raised, sign off or escalate, and review the chronology per child before any external referral.',
    'Nothing here is ever deleted, and every read is audited. That is deliberate: if you open a record, there is a record that you opened it.',
    { tracks: ['compliance', 'daily'], tags: ['safeguarding', 'child protection', 'concerns', 'dsl', 'referral'] });
  tab('safeguarding', 'concerns', '🛡️ Safeguarding → Concerns',
    'Every logged concern with the practitioner\'s own words, date, and what happened next.',
    'Triage daily. Add your management response — the practitioner needs to see it was read.',
    'Never edit a practitioner\'s original wording. Add to the record; do not rewrite it. An edited original destroys its evidential value.',
    { tracks: ['compliance', 'daily'], tags: ['concerns', 'log a concern', 'child protection'] });
  tab('safeguarding', 'sign-off-queue', '🛡️ Safeguarding → Sign-off queue',
    'Concerns awaiting DSL sign-off.',
    'Empty this queue every day you are in the building.',
    'A nightly job validates the sign-off chain. Gaps get flagged — an unsigned concern is not invisible, it is reported.',
    { tracks: ['compliance', 'daily'], tags: ['sign off', 'dsl', 'queue', 'approval'] });
  tab('safeguarding', 'log', '🛡️ Safeguarding → Log',
    'The chronology — every concern, incident and note for a child in date order.',
    'Print this for a referral or a case conference; it is the document social care asks for.',
    'The chronology only contains what was logged in Wren. Anything recorded on paper or in a message thread is not in it — bring it in before you print.',
    { tracks: ['compliance'], tags: ['chronology', 'log', 'case history', 'referral pack'] });
  tab('safeguarding', 'audit', '🛡️ Safeguarding → Audit',
    'Who accessed which safeguarding record, when.',
    'Check after any concern about confidentiality; it answers the question definitively.',
    'Your own access appears here too. That is the point — do not treat it as a surveillance tool for staff only.',
    { tracks: ['compliance'], tags: ['audit', 'access log', 'who viewed'] });

  // ── Inspection ─────────────────────────────────────────────────────────────
  sec('inspection', '📋 Inspection',
    'Ofsted readiness: overview, action items, briefings, gap analysis, evidence and inspection history.',
    'Spend twenty minutes here monthly. The point is that an inspection call is boring, not frantic.',
    'It measures readiness against what you have recorded in Wren. Excellent practice that lives only in people\'s heads scores zero here — and, on the day, roughly the same with an inspector.',
    { tracks: ['compliance'], tags: ['ofsted', 'inspection', 'readiness', 'sef', 'evidence'] });
  tab('inspection', 'overview', '📋 Inspection → Overview',
    'The readiness summary — where you are strong, where you are exposed.',
    'Start here; it routes you to whichever of the other tabs matters this month.',
    'This is an internal indicator, not an Ofsted grade, and must never be presented to staff or parents as one.',
    { tracks: ['compliance'], tags: ['readiness', 'overview', 'ofsted'] });
  tab('inspection', 'action-items', '📋 Inspection → Action items',
    'The specific things to fix before an inspection, generated from the gaps.',
    'Assign each to a person with a date; they behave like action-plan items.',
    'Items closed without evidence reopen at the next gap analysis. Attach the evidence when you close.',
    { tracks: ['compliance'], tags: ['actions', 'to fix', 'ofsted prep'] });
  tab('inspection', 'briefings', '📋 Inspection → Briefings',
    'Briefing packs for staff — what an inspector may ask them, in plain language.',
    'Send one to the team a term ahead of the inspection window, not the night before.',
    'Do not script staff. The briefings are there so people can answer honestly and confidently, not identically.',
    { tracks: ['compliance'], tags: ['briefing', 'staff prep', 'inspector questions'] });
  tab('inspection', 'gap-analysis', '📋 Inspection → Gap analysis',
    'Statutory requirements checked against what exists in Wren, with the gaps listed.',
    'Run monthly; the output becomes the action items.',
    'A gap may be a recording gap rather than a practice gap. Read what it is actually asking for before you panic.',
    { tracks: ['compliance'], tags: ['gaps', 'compliance check', 'statutory'] });
  tab('inspection', 'evidence', '📋 Inspection → Evidence',
    'The evidence library — the documents and records you would hand an inspector.',
    'Curate it as you go; it is far easier than assembling a folder in 24 hours.',
    'Linking evidence does not copy it. If the source record is later deleted or archived, the link goes stale — check the library before an inspection.',
    { tracks: ['compliance'], tags: ['evidence', 'documents', 'folder', 'ofsted pack'] });
  tab('inspection', 'history', '📋 Inspection → History',
    'Previous inspections, outcomes and what was actioned afterwards.',
    'Read before a new inspection — inspectors follow up previous recommendations.',
    'Nothing populates this automatically. If a past inspection is missing, someone has to enter it.',
    { tracks: ['compliance'], tags: ['history', 'previous inspection', 'outcomes'] });

  // ── Checklist ──────────────────────────────────────────────────────────────
  sec('checklist', '✅ Checklist',
    'The recurring compliance checklist — the statutory jobs that must happen every month.',
    'Work down it once a month; it is the cheapest insurance in the product.',
    'Ticking without doing is worse than not ticking — the tick is a dated record with your name on it.',
    { tracks: ['compliance'], tags: ['checklist', 'monthly', 'compliance', 'statutory'] });
  tab('checklist', 'monthly', '✅ Checklist → Monthly',
    'This month\'s items, what is done, what is slipping.',
    'Do it on the same day each month — the first Monday works well.',
    'Items roll over unticked rather than disappearing, so a long red list is usually months of drift, not one bad month.',
    { tracks: ['compliance'], tags: ['monthly checklist'] });

  // ── Operations ─────────────────────────────────────────────────────────────
  sec('operations', '🔧 Operations',
    'The building and the day: kitchen and food safety, repairs, resources, clock in/out, compliance records and health & safety.',
    'Check repairs and kitchen temperatures daily; the rest is weekly.',
    'Freezer safe range is <b>−22°C to −10°C</b> (confirmed by Toby, 2026-07-07). Older policy drafts said −22 to −15 — the thresholds in Wren are the correct ones.',
    { tracks: ['daily', 'compliance'], tags: ['operations', 'kitchen', 'repairs', 'building', 'health and safety'] });
  tab('operations', 'kitchen', '🔧 Operations → Kitchen',
    'Food safety: fridge/freezer temperatures, cleaning records, allergen matrix and the menu link.',
    'Check the temperature log has today\'s readings; chase the blanks the same day.',
    'A missing temperature reading cannot be back-filled honestly. Record "not taken" rather than inventing a number — EHO officers know what a fabricated log looks like.',
    { tracks: ['daily', 'compliance'], tags: ['kitchen', 'food safety', 'temperatures', 'fridge', 'freezer', 'allergens', 'eho'] });
  tab('operations', 'repairs', '🔧 Operations → Repairs',
    'The repairs log — raised by staff in Nest, triaged and closed here.',
    'Triage daily; anything safety-related goes to the top regardless of cost.',
    'Closing a repair does not notify the person who raised it. Add a comment so the room knows it is done.',
    { tracks: ['daily'], tags: ['repairs', 'maintenance', 'broken', 'facilities'] });
  tab('operations', 'resources', '🔧 Operations → Resources',
    'Physical resources and equipment — what you have, where it lives, when it was checked.',
    'Audit termly; it is also how you find the thing you know you bought.',
    'Do not confuse this with the teaching resources library (Curriculum → Resource Cards). This one is equipment.',
    { tags: ['resources', 'equipment', 'inventory', 'stock'] });
  tab('operations', 'clock-in-out', '🔧 Operations → Clock in/out',
    'Staff clocking records, including the NFC fob taps on the front-door Dahua panel.',
    'Fix missed clock-outs before payroll; check the pattern if someone is regularly "still in" overnight.',
    'The door webhook is unauthenticated by design so the panel can post to it. A fob tap that did not register is nearly always a fob not registered in the door\'s own web UI.',
    { tracks: ['people', 'daily'], tags: ['clock in', 'clock out', 'fob', 'nfc', 'attendance', 'door'] });
  tab('operations', 'compliance', '🔧 Operations → Compliance',
    'Operational compliance records — insurance, certificates, servicing, statutory checks.',
    'Diary the renewal dates; this tab is where "the boiler service is due" becomes visible before it is overdue.',
    'Expiry dates are only as good as the last upload. An empty date field reads as "fine" on every dashboard — fill them in.',
    { tracks: ['compliance'], tags: ['compliance', 'certificates', 'insurance', 'servicing', 'renewals'] });
  tab('operations', 'health-safety', '🔧 Operations → Health & Safety',
    'H&S records: risk assessments, accident overview, fire safety and sleep-check compliance.',
    'Review risk assessments termly and after any incident.',
    'Known issue (b200): one panel on this tab calls an endpoint that 404s (<code>/api/sleep</code>), so the sleep-check summary can render empty. The underlying sleep checks are fine — read them on the child record or in Nest.',
    { tracks: ['compliance', 'daily'], tags: ['health and safety', 'risk assessment', 'fire', 'accidents', 'sleep checks'],
      status: 'broken', issue: 'GET /api/sleep returns HTTP 404 from this tab (b200 crawl, 2026-08-19), so the sleep-check panel renders empty. Sleep-check data itself is intact — view it per child or in Nest → Sleep chart.' });

  // ── CPD ────────────────────────────────────────────────────────────────────
  sec('cpd', '🎓 CPD',
    'The training academy (courses staff take inside Wren) and the CPD record with certificates.',
    'Assign courses, authorise completions, and use the records at appraisal.',
    'Assigning is not authorising. A completed course only becomes a CPD record with a certificate once a manager authorises it.',
    { tracks: ['people'], tags: ['cpd', 'training', 'courses', 'academy', 'certificates'] });
  tab('cpd', 'academy', '🎓 CPD → Academy',
    'The course catalogue staff can work through in-app.',
    'Publish the courses you want done, then assign them to individuals or the whole team.',
    'Only <em>published</em> courses appear in staff\'s "My courses". A draft course assigned to someone is invisible to them.',
    { tracks: ['people'], tags: ['academy', 'courses', 'assign training'] });
  tab('cpd', 'records', '🎓 CPD → Records',
    'The CPD record per staff member, with authorised completions and certificates.',
    'Export before an inspection; it is the training evidence.',
    'External training (a day course elsewhere) has to be entered manually — it will never appear on its own.',
    { tracks: ['people', 'compliance'], tags: ['cpd records', 'certificates', 'training log'] });

  // ── Review ─────────────────────────────────────────────────────────────────
  sec('review', '✅ Review',
    'The manager decision queue: AI-drafted items and staff submissions waiting for a yes/no.',
    'Clear it daily. Everything in here is blocking somebody.',
    'Nothing in this queue has happened yet. An AI-drafted reply sitting here has not been sent, however finished it looks.',
    { tracks: ['daily'], tags: ['review', 'approvals', 'queue', 'decisions'] });
  tab('review', 'queue', '✅ Review → Queue',
    'Items awaiting a decision, oldest first.',
    'Approve, edit-then-approve, or reject with a reason.',
    'Rejecting without a reason teaches nobody anything — the reason is shown to the person who submitted it.',
    { tracks: ['daily'], tags: ['queue', 'pending', 'awaiting approval'] });
  tab('review', 'decisions', '✅ Review → Decisions',
    'What has already been decided, by whom, and why.',
    'Use it to answer "who approved that?" without a conversation.',
    'Decisions are immutable. Fix a wrong decision by making a new one, not by editing history.',
    { tracks: ['compliance'], tags: ['decisions', 'decision log', 'history'] });
  tab('review', 'observations', '✅ Review → Observations',
    'Observations submitted by staff for manager review before they reach parents.',
    'Read for accuracy and tone; parents see these.',
    'An observation left unreviewed never reaches the parent. Long queues here are the usual cause of "we never see anything about our child".',
    { tracks: ['learning', 'daily'], tags: ['observation review', 'moderation', 'parents see'] });

  // ── System ─────────────────────────────────────────────────────────────────
  sec('system', '⚙️ System',
    'Settings, module switches, integrations, backups, security, permissions, approvals, the audit log, notifications and your own account.',
    'Come here to switch a module on or off, add a staff permission, or check a backup ran.',
    'System is not in the sidebar by default — reach it from Settings or the avatar menu, or Ctrl+K "system". It is deliberately out of the way.',
    { tracks: ['setup'], tags: ['settings', 'system', 'configuration', 'admin settings'] });
  tab('system', 'settings', '⚙️ System → Settings',
    'The main settings surface, including the module toggles that decide which sections exist for this setting, and the "Take the tour" card.',
    'Switch modules on/off as the setting grows; this is also where you relaunch this tour.',
    'Switching a module off <b>hides</b> it — it does not delete the data. Switching it back on brings everything back exactly as it was.',
    { tracks: ['setup'], tags: ['settings', 'modules', 'toggles', 'features', 'take the tour'] });
  tab('system', 'integrations', '⚙️ System → Integrations',
    'External connections: Xero, Google (mail/calendar/drive), the door panel, EyLog import, Telegram alerts, the AI host.',
    'Check here first whenever "the sync has not run".',
    'A green connection means credentials are valid, not that data arrived. Cross-check the last-run timestamp.',
    { tracks: ['setup'], tags: ['integrations', 'xero', 'google', 'eylog', 'connections', 'api'] });
  tab('system', 'backups', '⚙️ System → Backups',
    'Backup status and history — nightly database dumps plus the weekly restore test.',
    'Glance weekly. A backup that has never been restored is a hope, not a backup.',
    'The weekly restore test is the row that matters. A long green list of backups with a failing restore test means you have nothing.',
    { tracks: ['setup', 'compliance'], tags: ['backup', 'restore', 'disaster recovery', 'dumps'] });
  tab('system', 'tech', '⚙️ System → Tech',
    'Technical detail: versions, containers, storage, the local AI host.',
    'Mostly read-only. Useful when reporting a problem — quote what this page says.',
    'Nothing here needs your attention day to day. If you find yourself in this tab weekly, something else is wrong.',
    { tracks: ['setup'], tags: ['tech', 'versions', 'diagnostics', 'containers'] });
  tab('system', 'support', '⚙️ System → Support',
    'How to get help, plus the diagnostic bundle to attach when you do.',
    'Raise an issue from here so the diagnostics come with it.',
    'The bundle may contain operational detail. It never contains child data — but read what it says before sending it anywhere.',
    { tracks: ['setup'], tags: ['support', 'help', 'raise an issue', 'contact'] });
  tab('system', 'docs', '⚙️ System → Docs',
    'The in-app documentation and guides, and the source the assistant answers from.',
    'Search here before asking a human.',
    'These docs are indexed into the assistant\'s knowledge base. If a doc is out of date, the assistant repeats it confidently — fix the doc, not the answer.',
    { tracks: ['setup'], tags: ['docs', 'documentation', 'guides', 'manual', 'help'] });
  tab('system', 'security', '⚙️ System → Security',
    'Security posture: 2FA, session policy, device enrolment, trusted devices and login history.',
    'Review after any staff change; revoke devices for leavers the same day.',
    '"Trust this device 30 days" issues a rotating cookie. Revoking a device is a database update on refresh tokens — logging the person out is not enough.',
    { tracks: ['setup', 'compliance'], tags: ['security', '2fa', 'totp', 'devices', 'sessions', 'login'] });
  tab('system', 'permissions', '⚙️ System → Permissions',
    'Per-staff capabilities — who can see salaries, who can administer medicine, who can approve.',
    'Grant the minimum that lets someone do their job; review when roles change.',
    'Medicine is per-staff now, not blanket manager-only (decision 2026-06-06). Salary visibility stays manager-only via <code>view_staff_salaries</code>.',
    { tracks: ['setup', 'compliance'], tags: ['permissions', 'capabilities', 'roles', 'access', 'medicine permission', 'salary'] });
  tab('system', 'approvals', '⚙️ System → Approvals',
    'Approval routing — what needs a second pair of eyes and whose.',
    'Set once, revisit when the management structure changes.',
    'Turning an approval off is instant and retrospective for anything not yet actioned. Check the queue is empty first.',
    { tracks: ['setup'], tags: ['approvals', 'routing', 'sign off'] });
  tab('system', 'audit-log', '⚙️ System → Audit log',
    'The evidence-grade log: who did what, when, from where, with before/after values.',
    'Use for any genuine investigation — this is the authoritative record.',
    'It is append-only and includes your own actions. Do not go looking unless you are prepared to be in it.',
    { tracks: ['setup', 'compliance'], tags: ['audit', 'log', 'who changed', 'investigation', 'history'] });
  tab('system', 'notifications', '⚙️ System → Notifications',
    'Notification rules and delivery — what generates an alert, to whom, on which channel.',
    'Tune after go-live; the defaults are deliberately noisy so nothing is missed in week one.',
    'Turning a notification off does not stop the underlying event being recorded — it stops you hearing about it. Check the queue instead of silencing it.',
    { tracks: ['setup'], tags: ['notifications', 'alerts', 'push', 'email alerts'] });
  tab('system', 'my-account', '⚙️ System → My account',
    'Your own profile, PIN and two-factor settings.',
    'Change your PIN here. It is the same PIN you use on the EY tablets.',
    'Set a PIN you can type on a tablet with a child on your hip. And do not share it — every action in Nest is attributed to whoever\'s PIN was used.',
    { tracks: ['setup'], tags: ['my account', 'pin', 'password', '2fa', 'profile'] });

  // ── Intelligence / Automations / Access / Assistant / Data governance ───────
  sec('intelligence', '📡 Intelligence',
    'Workflows, search across everything, and AI chat over your setting\'s data.',
    'Use Search when you know a fact exists but not where; use AI chat when you are not sure what you are looking for.',
    'It searches your data, not the internet. Ask it about your nursery, not about EYFS in general — for that, use the assistant.',
    { tracks: ['setup'], tags: ['intelligence', 'search everything', 'workflows', 'ai'] });
  tab('intelligence', 'workflows', '📡 Intelligence → Workflows',
    'Automated workflows (n8n) that run in the background — syncs, reminders, digests.',
    'Check what exists before building a new one; most of what you want already runs nightly.',
    'These are live automations that email real people. Do not "test" one on production data.',
    { tracks: ['setup'], tags: ['workflows', 'n8n', 'automation', 'cron', 'scheduled'] });
  tab('intelligence', 'search', '📡 Intelligence → Search',
    'Cross-entity search: children, staff, parents, documents, messages.',
    'The fastest way to answer "where did I see that?"',
    'Results respect your permissions. A colleague finding something you cannot is a permission difference, not a bug.',
    { tracks: ['daily'], tags: ['search', 'find', 'lookup'] });
  tab('intelligence', 'ai-chat', '📡 Intelligence → AI chat',
    'Chat grounded in your own data, running on the local model.',
    'Ask operational questions: "how many children are on funded hours this term?"',
    'It grounds on live SQL plus the knowledge base, but it can still be wrong. Verify anything you are about to act on.',
    { tracks: ['setup'], tags: ['ai chat', 'ask', 'assistant', 'llm'] });
  sec('automations', '🔁 Automations',
    'Recipe-style automations you can switch on without touching a workflow editor.',
    'Turn on the ones that match how you work — reminders, digests, chase-ups.',
    'An automation that emails parents is live from the moment you enable it. Read what it sends before switching it on.',
    { tracks: ['setup'], tags: ['automations', 'recipes', 'reminders', 'digests'] });
  tab('automations', 'recipes', '🔁 Automations → Recipes',
    'The catalogue of available automations.',
    'Browse, read the description, enable.',
    'Some recipes need an integration (Google, Xero) that must be connected first, or they enable and silently do nothing.',
    { tracks: ['setup'], tags: ['recipes', 'available automations'] });
  tab('automations', 'active', '🔁 Automations → Active',
    'What is currently running, when it last ran and what it did.',
    'Check here when an expected email did not arrive.',
    '"Last run: never" after a week means it is enabled but not firing — usually a missing credential, not a broken recipe.',
    { tracks: ['setup'], tags: ['active automations', 'running', 'last run'] });
  sec('access', '🔓 Access',
    'Access requests — staff asking for a portal, a role or a capability they do not yet have.',
    'Approve or decline; approvals apply immediately.',
    'Granting a portal is not granting a role. A staff member with Roost access and a practitioner role sees very little — set the role too.',
    { tracks: ['setup'], tags: ['access requests', 'permissions request', 'grant access'] });
  sec('assistant', '🪺 Wren AI',
    'The built-in assistant: ask about children, staff, emails, EYFS or "where do I find X?". It runs on your own hardware, not a cloud API.',
    'Ask it in plain English. It answers from live database facts plus the indexed docs, guides and this tour, and links you straight to the page.',
    'It is manager-only, and it is grounded but not infallible. Follow its link and check the screen before acting on the answer.',
    { tracks: ['daily'], tags: ['assistant', 'wren ai', 'ask wren', 'where do i find', 'help', 'chat'] });
  tab('assistant', 'chat', '🪺 Wren AI → Chat',
    'The chat itself, with document upload and voice input.',
    'Try "where do I find the funding claims?" or "how do I do a supervision?" — it answers with a link.',
    'Uploaded documents are indexed for the session. Do not upload anything containing children\'s personal data.',
    { tracks: ['daily'], tags: ['chat', 'ask', 'upload', 'voice'] });
  sec('data-governance', '🗄️ Data Governance',
    'GDPR housekeeping: the retention schedule, records map, encrypted archives and subject-access/erasure requests.',
    'Review the retention schedule annually; process subject access requests here rather than by hand.',
    'Nothing is ever auto-deleted. Erasure is queued and needs manager sign-off, and safeguarding, incident, medication, financial and attendance records are retained by law even after an erasure request.',
    { tracks: ['compliance'], tags: ['gdpr', 'data protection', 'retention', 'subject access', 'erasure', 'dpo'] });
  tab('data-governance', 'dashboard', '🗄️ Data Governance → Dashboard',
    'RAG view of retention compliance by record type.',
    'Check quarterly; amber is usually "older than the schedule allows", not a breach.',
    'Retention periods are still marked DRAFT until a DPO confirms them. Do not delete anything on the strength of an amber cell.',
    { tracks: ['compliance'], tags: ['retention dashboard', 'rag', 'compliance'] });
  tab('data-governance', 'schedule', '🗄️ Data Governance → Schedule',
    'The legal retention schedule — 12 record types with their statutory citations.',
    'Read it once so you know what you must keep and for how long.',
    'Citations are drafted from EYFS/ICO/KCSIE/IRMS/HMRC guidance and are labelled DRAFT. Confirm with your DPO before relying on them.',
    { tracks: ['compliance'], tags: ['retention schedule', 'how long to keep', 'legal'] });
  tab('data-governance', 'records-map', '🗄️ Data Governance → Records map',
    'What personal data exists, where it lives, and who can reach it.',
    'This is your Article 30 record of processing activities.',
    'It maps Wren. Data in a filing cabinet or a WhatsApp group is not on this map and is still your responsibility.',
    { tracks: ['compliance'], tags: ['records map', 'article 30', 'ropa', 'data map'] });
  tab('data-governance', 'archives', '🗄️ Data Governance → Archives',
    'Encrypted (GPG AES-256) archives, taken on-box and copied off-site.',
    'Verify a restore occasionally — the script has a restore-verify mode.',
    'The archive passphrase lives in a single file on the server. If that file is lost, every archive is permanently unreadable. Back it up somewhere else.',
    { tracks: ['compliance', 'setup'], tags: ['archives', 'encrypted', 'gpg', 'offsite'] });
  tab('data-governance', 'data-requests', '🗄️ Data Governance → Data requests',
    'Parent subject-access and erasure requests, with the export and the retention-aware erasure queue.',
    'Acknowledge within the statutory window, generate the export, and log what you released.',
    'Erasure anonymises the child tombstone and removes developmental data, but deliberately retains safeguarding, incident, medication, financial and attendance records. Tell the parent that up front.',
    { tracks: ['compliance'], tags: ['sar', 'subject access', 'erasure', 'right to be forgotten', 'data request'] });

  // ═══════════════════════════════════════════════════════════════════════════
  // ROOST standalone pages (full navigation, not SPA fragments).
  // Every .html under editions/admin/public is covered here except the six
  // documented exclusions (app.html / app-new.html / dashboard-new.html /
  // index.html / login.html / module-demo.html) — see scripts/tour-coverage.js.
  // ═══════════════════════════════════════════════════════════════════════════
  page('absence-fairness', '/absence-fairness.html', '⚖️ Absence fairness',
    'Checks whether absence is being managed consistently across staff — same pattern, same response.',
    'Run before a formal absence process so you can show the approach is even-handed.',
    'It compares treatment, not entitlement. A protected or disability-related absence should look different — the tool cannot know that, you do.',
    { tracks: ['people'], tags: ['absence fairness', 'consistency', 'equality'] });
  page('absences', '/absences.html', '🏖️ Absences',
    'The full absence record: leave, sickness, TOIL and unauthorised, across all staff.',
    'Approve requests, record sickness on the day, and check remaining entitlement before saying yes.',
    'Historical BrightHR absences (including 47 leavers) are RAG-only and deliberately NOT in the request table — do not expect to find them here.',
    { tracks: ['people'], tags: ['absence', 'leave', 'holiday', 'sickness', 'time off'] });
  page('action-plans-page', '/action-plans.html', '⭐ Action plans (standalone)',
    'The same action plans as the SPA section, on a standalone page for deep links and printing.',
    'Use when you want to print a plan or send someone a direct link.',
    'Edits here and in the section are the same records. There is no separate "page version" to keep in sync.',
    { tracks: ['compliance'], tags: ['action plans', 'print'] });
  page('activity-bank', '/activity-bank.html', '🎨 Activity bank',
    'A searchable bank of activities with EYFS links, resources needed and adult role.',
    'Pull ideas into planning instead of starting a blank week.',
    'Bank activities are starting points, not a curriculum. A week made entirely of bank activities has no children in it.',
    { tracks: ['learning'], tags: ['activities', 'ideas', 'activity bank', 'planning'] });
  page('admissions-enquiries', '/admissions/enquiries.html', '📨 Admissions → Enquiries',
    'The raw enquiry list — every web form, phone call and walk-in.',
    'Triage new enquiries into the pipeline daily.',
    'Public web enquiries arrive unauthenticated. Confirm the family exists before you put real detail against the record.',
    { tracks: ['admissions'], tags: ['enquiries', 'leads', 'enquiry list'] });
  page('admissions-forecast', '/admissions/forecast.html', '📈 Admissions → Forecast',
    'Occupancy and income forecast from the pipeline and current bookings.',
    'Use for the termly planning conversation.',
    'Probability-weighted, so it will never match the raw enquiry count. That is correct, not a bug.',
    { tracks: ['admissions', 'finance'], tags: ['forecast', 'projection'] });
  page('admissions-index', '/admissions/index.html', '🌱 Admissions hub',
    'The landing page for the standalone admissions pages — enquiries, list, pipeline, forecast, trends, waiting list.',
    'Use it as the menu when you are working admissions for an hour.',
    'The SPA section (/admin/admissions) and these pages are the same data with different layouts. Pick one and stay in it for a session.',
    { tracks: ['admissions'], tags: ['admissions hub'] });
  page('admissions-list', '/admissions/list.html', '📋 Admissions → List',
    'A flat, sortable, exportable list of every admission record.',
    'Export for a board report or a funding return.',
    'The export is a snapshot. Date it, or you will be comparing two exports from different weeks without knowing.',
    { tracks: ['admissions'], tags: ['admissions list', 'export'] });
  page('admissions-pipeline-page', '/admissions/pipeline.html', '🌱 Admissions → Pipeline (standalone)',
    'The pipeline board on its own page.',
    'Same job as the SPA tab; handy on a second monitor.',
    'Two people dragging the same card at once will fight. Agree who owns the pipeline in the morning.',
    { tracks: ['admissions'], tags: ['pipeline board'] });
  page('admissions-trends', '/admissions/trends.html', '📊 Admissions → Trends',
    'Enquiry volume, conversion and source over time.',
    'Read quarterly — it tells you which marketing is actually working.',
    'Conversion is skewed by enquiries never marked lost. Clean the pipeline before trusting the trend line.',
    { tracks: ['admissions'], tags: ['trends', 'conversion', 'marketing'] });
  page('admissions-waiting-list-ai', '/admissions/waiting-list-ai.html', '🤖 Waiting list (AI view)',
    'AI-assisted view of the waiting list — likely matches for the places you are about to have.',
    'Use it to shortlist, then check each family yourself.',
    'It suggests; it does not offer. Every offer is still a human decision and a human phone call.',
    { tracks: ['admissions'], tags: ['waiting list ai', 'matching', 'offers'] });
  page('admissions-waitlist-manage', '/admissions/waitlist-manage.html', '📝 Waiting list management',
    'Add, reorder, tier and prune the waiting list; "parked" families are held separately from active demand.',
    'Review monthly so the list reflects families who still want a place.',
    'Parked entries are deliberately excluded from active demand figures. A "quiet" waiting list may just be a heavily parked one.',
    { tracks: ['admissions'], tags: ['waiting list', 'waitlist', 'parked', 'demand'] });
  page('ai-demo', '/ai-demo.html', '🧪 AI demo',
    'A sandbox page for trying the AI features without touching real records.',
    'Use it to see what a feature does before enabling it for staff.',
    'It is a demo surface. Nothing you do here is saved anywhere a colleague will find it.',
    { tags: ['ai demo', 'sandbox', 'try'] });
  page('aria', '/aria.html', '☎️ Aria (call assistant)',
    'The voice assistant that answers the phone: call log, transcripts, outcomes and configuration.',
    'Review calls weekly; adjust what she is allowed to say.',
    'Aria\'s screener tools live in the Vapi dashboard, not in Wren. Zero tool runs means she answered but could not act.',
    { tracks: ['comms'], tags: ['aria', 'phone', 'vapi', 'calls', 'answering'] });
  page('attendance-monitoring', '/attendance-monitoring.html', '📉 Attendance monitoring',
    'Child attendance patterns — persistent absence, lateness, and children whose attendance has changed.',
    'Review half-termly; a sudden change in a child\'s attendance is sometimes a safeguarding signal.',
    'Poor attendance is not automatically a concern in EY (funded hours are flexible). Read the pattern alongside the family context before contacting anyone.',
    { tracks: ['compliance', 'daily'], tags: ['attendance', 'absence', 'persistent absence', 'lateness'] });
  page('audit', '/audit.html', '🔍 Audit',
    'The audit report page — a filtered, printable view of the audit log.',
    'Pull evidence for a specific date range or user.',
    'Filtering does not reduce what is recorded, only what you see. Do not present a filtered view as "everything that happened".',
    { tracks: ['compliance'], tags: ['audit', 'report', 'evidence', 'log'] });
  page('availability', '/availability.html', '🗓️ Public availability heatmap',
    'The public-facing availability heat map — which rooms have space, which months are full.',
    'Keep it honest and current; it is linked from the nursery website and drives enquiries.',
    'It is generated from real enrolment, so it will show a room genuinely full (Baby Room has run 11/10). Do not "tidy" the numbers — they are the credibility.',
    { tracks: ['admissions'], tags: ['availability', 'heatmap', 'public', 'spaces', 'website'] });
  page('availability-preview', '/availability-preview.html', '👁️ Availability preview',
    'A preview of the availability page exactly as a prospective parent sees it.',
    'Check here before pointing marketing at it.',
    'Preview only — changing anything here changes nothing. Edit the underlying occupancy instead.',
    { tracks: ['admissions'], tags: ['preview', 'availability'] });
  page('careers', '/careers.html', '🧑‍🍼 Careers page',
    'The public careers/vacancies page content.',
    'Post a vacancy here and it appears on the nursery website.',
    'A vacancy left up after it is filled generates applications you then have to decline. Take it down the day you appoint.',
    { tracks: ['people'], tags: ['careers', 'vacancies', 'jobs', 'recruitment'] });
  page('cf-access', '/cf-access.html', '🔐 Access control (Cloudflare)',
    'Cloudflare Access policies — who can reach which portal from outside the building.',
    'Add or remove a person\'s external access when they join or leave.',
    'This sits <em>in front of</em> Wren\'s own login. Removing someone here locks them out even if their Wren account is still active — and vice versa. Do both.',
    { tracks: ['setup', 'compliance'], tags: ['cloudflare', 'access', 'external access', 'remote', 'security'] });
  page('checklist-page', '/checklist.html', '✅ Checklist (standalone)',
    'The compliance checklist as a standalone, printable page.',
    'Print it for a walk-round, then tick it off in the app.',
    'Printing does not tick anything. The paper copy is a prompt, not the record.',
    { tracks: ['compliance'], tags: ['checklist', 'print'] });
  page('child-profile', '/child-profile.html', '👶 Child profile',
    'The full record for one child: details, contacts, allergies, key person, funding, bookings, consents, observations, trackers, reports and safeguarding links.',
    'Open before any parent conversation. The Bookings tab is where "who is expected today" comes from.',
    'Allergies and dietary needs live here and feed the kitchen. If they are wrong here, they are wrong on the lunch table.',
    { tracks: ['learning', 'daily'], tags: ['child profile', 'child record', 'allergies', 'key person', 'bookings', 'about me'] });
  page('children-page', '/admin/children/list', '👶 Children (standalone)',
    'The children list as a standalone page.',
    'Use for a quick lookup without loading the whole SPA.',
    'It hides inactive children exactly like the SPA does — leavers are on Inactive Children.',
    { tracks: ['learning'], tags: ['children list'] });
  page('children-next-steps', '/children/next-steps.html', '➡️ Children → Next steps',
    'Next steps grouped by child rather than by status.',
    'Use in a key-person catch-up: one child at a time.',
    'A child with a long list of next steps usually has an over-enthusiastic key person, not a developmental problem. Two or three at a time is plenty.',
    { tracks: ['learning'], tags: ['next steps by child'] });
  page('children-trackers', '/children/trackers.html', '📊 Children → Trackers',
    'The framework tracker grid — every statement against every child, colour-coded by status.',
    'Use at termly review to spot coverage gaps across a cohort.',
    'The live framework is <code>birth_to_5_la</code> (554 statements). There is an older synthetic <code>birth_to_5</code> key with different statements — if your grid looks wrong, you are on the wrong framework.',
    { tracks: ['learning'], tags: ['tracker', 'framework', 'birth to 5', 'development matters', 'grid', 'coverage'] });
  page('clockin', '/clockin.html', '⏱️ Clock in / out',
    'The clocking record and manual corrections.',
    'Fix missed clock-outs before payroll runs.',
    'A manual correction is audited and attributed to you. Correct it, do not quietly overwrite it.',
    { tracks: ['people'], tags: ['clock in', 'timesheet', 'hours', 'fob'] });
  page('communications-page', '/communications.html', '💬 Communications (standalone)',
    'The comms surface on its own page.',
    'Handy for a comms-only session without the rest of the shell.',
    'Same threads as the SPA. Do not reply in both.',
    { tracks: ['comms'], tags: ['communications'] });
  page('community-moderation', '/community-moderation.html', '👪 Parent community moderation',
    'Moderation for the parent forum in Finch — reported posts, removals, banned members.',
    'Check weekly; a parent forum with no moderation becomes a complaints channel.',
    'Removing a post does not notify the author. Message them, or they will repost it.',
    { tracks: ['comms'], tags: ['forum', 'community', 'moderation', 'parents'] });
  page('competitor-intel', '/competitor-intel.html', '🔭 Competitor intel',
    'Local competitor research — fees, capacity, Ofsted grades, what they offer.',
    'Refresh before a fee review.',
    'It is research, not truth. Published fees are frequently out of date; verify before quoting them to a parent.',
    { tracks: ['admissions'], tags: ['competitors', 'fees', 'market', 'local nurseries'] });
  page('compliance', '/compliance.html', '📑 Compliance',
    'The consolidated compliance view across statutory areas.',
    'Use as a monthly sweep alongside the checklist.',
    'It reads other modules. A green here with an empty module underneath means "nothing recorded", not "nothing to do".',
    { tracks: ['compliance'], tags: ['compliance', 'statutory', 'overview'] });
  page('contracts', '/contracts.html', '📄 Contracts',
    'Parent contracts: templates, issued contracts, signature status.',
    'Issue on offer; chase unsigned before the start date.',
    'A child can be on the register with no signed contract. Check this page, not the register, before assuming you are covered.',
    { tracks: ['admissions', 'finance'], tags: ['contracts', 'terms', 'signing', 'parent contract'] });
  page('contract-sign', '/contract-sign.html', '✍️ Contract signing',
    'The signing surface a parent lands on from their contract link.',
    'Use to check what the parent sees, and to re-send a link.',
    'The link is per-contract and single-purpose. Forwarding one parent\'s link to another family signs the wrong contract.',
    { tracks: ['admissions'], tags: ['sign contract', 'esign', 'signature'] });
  page('crib-sheet', '/crib-sheet.html', '📝 Crib sheet',
    'The one-page "everything an inspector might ask" crib sheet, generated from live data.',
    'Print on the morning of an inspection.',
    'It is generated at the moment you open it. Print it on the day, not the week before.',
    { tracks: ['compliance'], tags: ['crib sheet', 'inspection', 'key facts', 'ofsted'] });
  page('ctf-export', '/ctf-export.html', '📤 CTF export',
    'Common Transfer File export — the standard file a school imports when a child moves on.',
    'Generate when a child leaves for reception.',
    'CTF is a schools format with strict fields. A missing UPN or DOB fails the school\'s import silently — validate before sending.',
    { tracks: ['learning'], tags: ['ctf', 'transfer', 'school', 'export', 'moving on'] });
  page('data-editor', '/data-editor.html', '🗂️ Data editor',
    'A direct table editor for the records that have no dedicated screen yet.',
    'Use for one-off corrections a normal screen cannot make.',
    'It writes straight to the database with no form validation. Read the row twice before you save it once.',
    { tracks: ['setup'], tags: ['data editor', 'raw edit', 'fix data', 'table'] });
  page('documents-library', '/documents/library.html', '📚 Document library',
    'The shared document store — policies, procedures, templates and forms.',
    'Keep the current version here so nobody works from a copy on a desktop.',
    'Uploading a new version does not retire the old one. Delete or supersede, or staff will open whichever they find first.',
    { tracks: ['compliance'], tags: ['documents', 'library', 'policies', 'files', 'templates'] });
  page('documents-workspaces', '/documents/workspaces.html', '🗃️ Document workspaces',
    'Collaborative document workspaces — a set of sources plus the drafting space over them.',
    'Use when writing something long from many sources (a policy rewrite, an SEF).',
    'Requires an authenticated session; the b200 crawl saw 401s here simply because it was not logged in. If you get 401 while logged in, your session has expired — reload.',
    { tracks: ['compliance'], tags: ['workspaces', 'documents', 'drafting', 'policy writing'] });
  page('documents-workspaces-new', '/documents/workspaces-new.html', '➕ New document workspace',
    'Create a workspace and pick its sources.',
    'Add the sources first; the drafting is much better when the sources are right.',
    'Sources are snapshotted into the workspace. Adding a document to the library later does not add it here.',
    { tracks: ['compliance'], tags: ['new workspace', 'sources'] });
  page('documents-workspace-detail', '/documents/workspace-detail.html', '📄 Workspace detail',
    'One workspace: its sources, drafts and history.',
    'Draft, revise, then publish the final version into the document library.',
    'A draft here is not a policy. Nothing is live until it is in the library and staff have acknowledged it.',
    { tracks: ['compliance'], tags: ['workspace', 'draft', 'detail'] });
  page('door-access', '/door-access.html', '🚪 Door access',
    'Who may open the front door, which fobs are registered, and the access log.',
    'Revoke a leaver\'s fob the day they leave.',
    'Known issue (b200): this page calls <code>/api/it-settings/modules</code>, which 404s, so a settings panel can render empty. The access list itself still loads.',
    { tracks: ['setup', 'compliance'], tags: ['door', 'access', 'fob', 'entry', 'dahua'],
      status: 'partial', issue: 'GET /api/it-settings/modules returns HTTP 404 on the door pages (b200 crawl, 2026-08-19). Cosmetic — the module-settings panel renders empty; door access and fob lists load normally.' });
  page('door', '/door.html', '🚪 Door',
    'The door panel view — live status, recent rings, and the intercom link.',
    'Use when someone reports the doorbell did not reach anyone.',
    'Same <code>/api/it-settings/modules</code> 404 as Door access — cosmetic, not a door fault.',
    { tracks: ['setup'], tags: ['door', 'doorbell', 'intercom', 'entry'],
      status: 'partial', issue: 'GET /api/it-settings/modules returns HTTP 404 (b200 crawl, 2026-08-19). Cosmetic only.' });
  page('email-triage', '/email-triage.html', '📬 Email triage',
    'The AI triage layer over the nursery inbox — category, urgency and a suggested action per email.',
    'Use the triage to decide reading order, and correct it when it is wrong (the correction trains the ranking).',
    'Triage is advisory. An email marked low urgency is still an email — the queue is a sort order, not a filter.',
    { tracks: ['comms'], tags: ['email triage', 'inbox', 'sorting', 'urgency'] });
  page('enquiry-form', '/enquiry-form.html', '📝 Enquiry form',
    'The public enquiry form as parents see it, plus its configuration.',
    'Check it after any website change; a broken form is silent lost business.',
    'Submissions arrive unauthenticated from the internet. Treat every field as untrusted text until you have spoken to the family.',
    { tracks: ['admissions'], tags: ['enquiry form', 'web form', 'contact form'] });
  page('features', '/features.html', '🎛️ Features',
    'The feature flag surface — what is on, off, or in preview for this setting.',
    'Turn a feature on when the team is ready for it, not when it ships.',
    'A feature switched on appears for everyone with the right role immediately, with no announcement. Tell people first.',
    { tracks: ['setup'], tags: ['features', 'flags', 'modules', 'enable'] });
  page('feedback-reports', '/feedback-reports.html', '💭 Staff feedback reports',
    'What staff have reported through the in-app feedback button — bugs, ideas, gripes.',
    'Read weekly. Cards also land on the Cockpit kanban board.',
    'Staff stop reporting if nothing visibly happens. Close the loop even when the answer is no.',
    { tracks: ['setup'], tags: ['feedback', 'bug reports', 'staff feedback', 'ideas'] });
  page('fee-schedule', '/fee-schedule.html', '🧾 Fee schedule',
    'Itemised billing setup: fee items, funding rates, opt-outs and the invoice run.',
    'Set the schedule once a year; check the funding rates every time the local authority changes them.',
    'Changing a fee item changes future invoices only. Invoices already raised keep the old rate — credit and reissue if you need to correct them.',
    { tracks: ['finance'], tags: ['fees', 'fee schedule', 'rates', 'billing', 'charges', 'consumables'] });
  page('fledge-framework', '/fledge-framework.html', '🪶 Fledge framework',
    'Wren\'s own developmental framework (Fledge) — statements, areas and how it maps to EYFS.',
    'Read it once so you can explain to staff how it relates to Development Matters.',
    'Fledge is additional to the statutory framework, not a replacement. Statutory reporting still uses EYFS.',
    { tracks: ['learning'], tags: ['fledge', 'framework', 'curriculum', 'eyfs mapping'] }).fledge = true;   // fledge-off: behind the switch
  page('framework-builder', '/framework-builder.html', '🧭 Framework builder',
    'Build the setting\'s own curriculum framework — areas, statements, age bands.',
    'Use if you want a house curriculum alongside EYFS.',
    'A custom framework does not backfill. Children already tracked stay on the framework they were assessed against.',
    { tracks: ['learning', 'setup'], tags: ['framework builder', 'custom curriculum', 'statements'] });
  page('funding', '/funding.html', '💷 Funding',
    'Funded hours per child, funding terms, eligibility codes, allocations and the claim workflow.',
    'Allocate at the start of term, validate codes, submit the headcount, then reconcile.',
    'Eligibility codes expire termly and stretched funding needs its own calculation. Both are the usual causes of a clawback.',
    { tracks: ['finance', 'compliance'], tags: ['funding', 'funded hours', 'free entitlement', '15 hours', '30 hours', 'claims', 'codes', 'headcount'] });
  page('handbook', '/handbook.html', '📖 Handbook',
    'The staff handbook — the policies and expectations everyone signs up to.',
    'Update annually; staff acknowledge it in Seed.',
    'A handbook nobody has acknowledged is not evidence of anything. Check the acknowledgement list, not the upload date.',
    { tracks: ['people', 'compliance'], tags: ['handbook', 'staff handbook', 'policies', 'induction'] });
  page('how-wren-works', '/how-wren-works.html', '🗺️ How Wren works',
    'The self-training hub and architecture explainer — what the four portals are, how data flows, what runs where.',
    'Send it to a new manager on day one; read it yourself before explaining Wren to anyone else.',
    'It explains the system, not your setting. For "how do we do it here", use the tour and the docs.',
    { tracks: ['setup'], tags: ['how wren works', 'architecture', 'training', 'explainer', 'portals'] });
  page('import-wizard', '/import-wizard.html', '📥 Import wizard',
    'Bulk import of children, staff and historical records from CSV or another system.',
    'Use at go-live or when taking on a cohort from another setting.',
    'Imports are additive but not idempotent — running the same file twice creates duplicates. Import once, check, then move on.',
    { tracks: ['setup'], tags: ['import', 'csv', 'bulk upload', 'migration', 'wizard'] });
  page('inactive-children', '/inactive-children.html', '📦 Inactive children',
    'Children who have left, with their full record intact.',
    'Come here when a past family asks for records, or a child returns.',
    'Records are retained under the retention schedule, not deleted. "I cannot find the child" almost always means "they are here".',
    { tracks: ['learning', 'compliance'], tags: ['leavers', 'inactive', 'past children', 'archived children'] });
  page('incidents', '/incidents.html', '🩹 Incidents',
    'Accidents, injuries and incidents involving children — what happened, who was told, what changed.',
    'Review daily; look for patterns by place, time or practitioner.',
    'Some incidents are notifiable to Ofsted within 14 days. Wren records them; it does not notify for you — see Setting Incidents for that tracking.',
    { tracks: ['compliance', 'daily'], tags: ['incidents', 'accidents', 'injuries', 'bumps', 'ofsted notification'] });
  page('induction-oversight', '/induction-oversight.html', '🌱 Induction oversight',
    'New-starter induction workbooks and how far through each one is.',
    'Check weekly for the first two months of every new starter.',
    'An unfinished induction is a safeguarding gap, not an admin one. Do not leave someone unsupervised on an incomplete induction.',
    { tracks: ['people', 'compliance'], tags: ['induction', 'new starter', 'onboarding staff', 'probation'] });
  page('intercom-answer', '/intercom-answer.html', '📞 Intercom answer',
    'The screen that opens when the front-door intercom rings.',
    'Answer, see who it is, release the door.',
    'It only pops on devices that are logged in and awake. Do not rely on it as the only way anyone hears the door.',
    { tracks: ['daily'], tags: ['intercom', 'doorbell', 'answer', 'front door'] });
  page('intervention', '/intervention.html', '🎯 Interventions',
    'Targeted interventions for individual children — what was tried, for how long, with what effect.',
    'Record before escalating to SEN support; it is the evidence an outside professional asks for.',
    'An intervention with no review date is a good intention. Always set the review.',
    { tracks: ['learning', 'compliance'], tags: ['intervention', 'support', 'targeted', 'sen', 'apdr'] });
  page('invoices', '/invoices.html', '💷 Invoices (standalone)',
    'Invoice list, generation and statements on a standalone page.',
    'Run the monthly invoices; chase the aged debt.',
    'Regenerating creates a duplicate rather than a correction — credit the original.',
    { tracks: ['finance'], tags: ['invoices', 'billing', 'statements'] });
  page('james', '/james.html', '🛎️ James (front desk)',
    'The front-desk assistant view — visitors, deliveries, who is expected.',
    'Leave it open on the office screen.',
    'It is a display, not a record. Visitors still have to be signed in properly (Nest → Visitors).',
    { tracks: ['daily'], tags: ['front desk', 'james', 'reception', 'visitors'] });
  page('keepsakes', '/keepsakes.html', '💛 Keepsakes',
    'The free leaving keepsake — a self-contained offline copy of a child\'s whole journey, given to families when they leave.',
    'Generate on the child\'s last week and send the link; it needs no login and never expires.',
    'Known issue (b200): the packages endpoint returns a 500, so the list can fail to load. Generation per child from the child record still works.',
    { tracks: ['learning', 'comms'], tags: ['keepsake', 'leaving gift', 'memory', 'leavers', 'journey'],
      status: 'broken', issue: 'GET /api/leavers-gift/packages returns HTTP 500 (b200 crawl, 2026-08-19). The keepsake list page fails to populate; generate from the individual child record instead until fixed.' });
  page('kitchen', '/kitchen.html', '🍽️ Kitchen',
    'The kitchen surface: menus, allergen matrix, temperature logs, cleaning records and the daily day-sheet.',
    'Print the day sheet each morning — it carries the allergy list for who is actually in.',
    'The allergy list is built from the child records. A child with an allergy recorded only on paper is not on the day sheet.',
    { tracks: ['daily', 'compliance'], tags: ['kitchen', 'menu', 'allergens', 'food', 'temperatures', 'chef'] });
  page('launch-prep', '/launch-prep.html', '📋 Wren To Do List',
    'Everything to be done to Wren itself — the software, not the nursery. Nursery work stays on the Cockpit board; a task belongs to one list or the other, never both.',
    'Add to it as things come up, and drag it into the order you will actually work in.',
    'Below the list sit the go-live readiness checks, which are read-only and computed from the database — they are not to-dos you tick off. They filter out children with future leave dates, so a count that looks low is usually correct.',
    { tracks: ['setup'], tags: ['wren to do list', 'to do', 'todo', 'launch', 'go live', 'readiness', 'setup checklist'] });
  page('leavers-book', '/leavers-book.html', '📕 Leavers book',
    'The end-of-year leavers book — a printable collection for children moving on to school.',
    'Build it in June, print in July.',
    'It pulls photos, which means consent. Check photo consent per child before printing anything shared between families.',
    { tracks: ['learning'], tags: ['leavers book', 'moving on', 'graduation', 'school'] });
  page('medicine', '/medicine.html', '💊 Medicine',
    'Medicine records: what was given, by whom, witnessed by whom, with parent consent.',
    'Check daily that every administration has a witness and a consent.',
    'Access is per-staff (decision 2026-06-06), not blanket manager-only, and the route needs its own token header. If a colleague cannot see this, it is a permission, not a fault.',
    { tracks: ['compliance', 'daily'], tags: ['medicine', 'medication', 'meds', 'administration', 'consent'] });
  page('memory-box', '/memory-box.html', '🎁 Memory box',
    'Curated highlights from a child\'s time with you — the photos and moments worth keeping.',
    'Add as you go; it feeds the keepsake and the leavers book.',
    'Adding to the memory box publishes to the parent\'s Finch memory box. Check consent and check the photo has no other child in it.',
    { tracks: ['learning', 'comms'], tags: ['memory box', 'photos', 'highlights', 'keepsake'] });
  page('message-review-page', '/message-review.html', '🔎 Message review (standalone)',
    'The approval queue for staff messages to parents, standalone.',
    'Clear daily.',
    'Approving sends immediately, with no recall.',
    { tracks: ['comms', 'daily'], tags: ['message review', 'approve messages'] });
  page('messages', '/messages.html', '💬 Messages',
    'Parent and staff message threads.',
    'Answer here so the audit trail stays in one place.',
    'Message reads are audited and locked to an allowlist. Opening a thread you have no business in leaves a record.',
    { tracks: ['comms', 'daily'], tags: ['messages', 'threads', 'chat', 'parent messages'] });
  page('module-builder', '/module-builder.html', '🧱 Module builder',
    'Build a custom record type (a form + a list) without code — the "we have a paper form for that" solver.',
    'Use for setting-specific records Wren has no screen for.',
    'A custom module has no reports and no permissions of its own beyond role. Do not build safeguarding or medical records here.',
    { tracks: ['setup'], tags: ['module builder', 'custom form', 'no code', 'build a form'] });
  page('module-records', '/module-records.html', '🗒️ Module records',
    'The records captured by custom modules.',
    'Read and export what the custom forms have collected.',
    'Custom-module data is outside the standard retention schedule. Decide its retention yourself.',
    { tracks: ['setup'], tags: ['module records', 'custom data'] });
  page('modules', '/modules.html', '🧩 Modules',
    'The module catalogue — which parts of Wren this setting uses.',
    'Switch modules on as the setting grows.',
    'Switching off hides, never deletes. Data comes back untouched when you switch back on.',
    { tracks: ['setup'], tags: ['modules', 'switch on', 'features', 'catalogue'] });
  page('module-templates', '/module-templates.html', '📐 Module templates',
    'Starting templates for custom modules — common forms already laid out.',
    'Start from a template rather than a blank form.',
    'Templates copy at creation time. Improving a template later does not improve modules already built from it.',
    { tracks: ['setup'], tags: ['templates', 'module templates'] });
  page('monitor', '/monitor.html', '🚨 Nursery watchdog',
    'The watchdog view — anomalies and things that look wrong across the setting.',
    'Glance daily; it surfaces the quiet failures nobody reports.',
    'It flags patterns, not facts. Every flag needs a human look before it becomes an action.',
    { tracks: ['daily', 'setup'], tags: ['watchdog', 'monitor', 'alerts', 'anomalies'] });
  page('nav-settings', '/nav-settings.html', '🎛️ Sidebar layout',
    'Reorder and regroup the Roost sidebar to match how you actually work.',
    'Put the four sections you use daily at the top.',
    'The layout is saved in <b>this browser only</b> (localStorage), not to your account. A new laptop gets the default layout back.',
    { tracks: ['setup'], tags: ['sidebar', 'nav', 'layout', 'reorder', 'menu'] });
  page('newsletter', '/newsletter.html', '📰 Newsletter',
    'The newsletter composer with sections, media and the audience picker.',
    'Draft, choose the audience, check the count, send.',
    'Sends from <b>admin@</b>, and "bill payers" means the child\'s primary contact email. Preview the count — it is the only preview you get.',
    { tracks: ['comms'], tags: ['newsletter', 'send to parents', 'bulk email', 'audience'] });
  page('notification-settings', '/notification-settings.html', '🔔 Notification settings',
    'Per-user and per-setting notification preferences and channels.',
    'Tune yours so the important ones cut through.',
    'Turning off a notification stops you hearing about the event, not the event. Check the source queue instead of silencing it.',
    { tracks: ['setup'], tags: ['notifications', 'alerts', 'preferences', 'push', 'email'] });
  page('observations', '/observations.html', '🔭 Observations',
    'Every observation across the setting — the learning evidence base.',
    'Moderate a sample each week; check coverage of key children and areas.',
    'A "termly update" is an observation with the termly-update flag set, not a separate record type. Filter for it rather than hunting for a separate screen.',
    { tracks: ['learning'], tags: ['observations', 'learning journey', 'evidence', 'wow moments', 'termly update'] });
  page('occupancy', '/occupancy.html', '🏫 Occupancy',
    'Room occupancy against capacity, day by day.',
    'Check before offering a place.',
    'Occupancy counts bookings from the register, not contracts. A promised place with no booking is invisible here.',
    { tracks: ['admissions'], tags: ['occupancy', 'capacity', 'spaces', 'rooms'] });
  page('occupancy-sandbox', '/occupancy-sandbox.html', '🧪 Occupancy sandbox',
    'A what-if space: move children, change patterns, see the effect without touching real bookings.',
    'Model a proposed intake before committing to it.',
    'Nothing here saves to the real register. That is the point — but it also means your careful model disappears when you leave.',
    { tracks: ['admissions'], tags: ['sandbox', 'what if', 'occupancy modelling', 'scenario'] });
  page('occupancy-planner', '/occupancy-v2.html', '📈 Occupancy planner',
    'The forward occupancy planner — how the rooms fill over the coming terms.',
    'Use for staffing and hiring decisions.',
    'Projections assume current bookings persist. Record leave dates as soon as you know them or the plan flatters you.',
    { tracks: ['admissions', 'finance'], tags: ['occupancy planner', 'forecast', 'planning', 'terms'] });
  page('outings', '/outings.html', '🚌 Outings',
    'Trips and outings: destination, ratios, risk assessments, permission slips and the register for the day.',
    'Set up the outing, generate the risk assessment and slips, then print the register.',
    'Ratios on an outing are stricter than in the setting. Check the ratio the page calculates before you confirm numbers.',
    { tracks: ['learning', 'compliance'], tags: ['outings', 'trips', 'ratios', 'risk assessment', 'permission'] });
  page('parent-app-feedback', '/parent-app-feedback.html', '💭 Parent app feedback',
    'What parents have said through the feedback button in Finch — likes, change requests, ideas, bugs.',
    'Triage weekly; it is the cheapest parent-voice evidence you will ever collect.',
    'Parents cannot see your triage. Reply through Messages if the feedback deserves an answer.',
    { tracks: ['comms'], tags: ['parent feedback', 'app feedback', 'suggestions', 'parent voice'] });
  page('parent-onboarding', '/parent-onboarding.html', '🤝 Parent onboarding',
    'The new-family journey: invite, portal access, forms, consents and first-day readiness.',
    'Send the invite as soon as the contract is signed; chase the incomplete steps weekly.',
    'A parent who has never activated their portal account gets no messages, no permission slips and no invoices. Check activation before wondering why they never reply.',
    { tracks: ['admissions', 'comms'], tags: ['parent onboarding', 'invite', 'portal access', 'new family', 'settling in'] });
  page('parent-reports', '/parent-reports.html', '📑 Parent reports',
    'The reports that go to parents — summative reports, progress checks and termly summaries.',
    'Generate, read every one before release, then publish.',
    'Publishing is immediate and visible in Finch. Read for tone as well as accuracy — parents keep these.',
    { tracks: ['learning', 'comms'], tags: ['parent reports', 'summative', 'progress check', 'termly report'] });
  page('payments-admin', '/payments-admin.html', '💳 Payments admin',
    'Payment configuration and administration — mandates, providers, failed payments.',
    'Check failed Direct Debits weekly and re-present or chase.',
    'A failed DD is silent to the parent. If you do not tell them, the next one usually fails too.',
    { tracks: ['finance'], tags: ['payments', 'direct debit', 'mandates', 'gocardless', 'stripe', 'failed payment'] });
  page('phonics', '/phonics.html', '🔤 Phonics',
    'Phonics tracking against the setting\'s chosen DfE-validated scheme.',
    'Set the scheme once (System → Settings), then track children through it.',
    'The scheme setting is per-edition. A demo or school instance writing to the wrong schema was a real bug — if the tracker looks like someone else\'s data, check which portal you are on.',
    { tracks: ['learning'], tags: ['phonics', 'rwi', 'letters and sounds', 'sounds', 'reading'] });
  page('phonics-library', '/phonics-library.html', '📖 Phonics library',
    'Decodable stories and phonics games, browsable by phase.',
    'Point staff and parents at the right phase rather than "anything with pictures".',
    'Decodable means decodable <em>for that scheme and phase</em>. A book from the wrong phase teaches guessing.',
    { tracks: ['learning'], tags: ['phonics library', 'decodable books', 'stories', 'games', 'reading'] });
  page('planner', '/planner.html', '🗓️ Planner',
    'A general planner surface for the week ahead.',
    'Use for anything that is not curriculum planning — meetings, visits, deadlines.',
    'It is a planner, not a record. Nothing here appears on the curriculum plan or the calendar.',
    { tags: ['planner', 'week', 'plan'] });
  page('planning', '/planning.html', '📚 Planning',
    'Weekly curriculum planning per room.',
    'Read Friday, sign off, use as the room catch-up agenda.',
    'A plan with no named focus children is a timetable. Name the children.',
    { tracks: ['learning'], tags: ['planning', 'weekly plan', 'curriculum'] });
  page('policies-workspace', '/policies-workspace.html', '📜 Policies workspace',
    'Drafting space for policies, with the relevant legislation alongside.',
    'Use for the annual policy review.',
    'Known issue (b200): the legislation feed returns a 500, so the legislation pane can be empty. Drafting still works; check citations by hand until it is fixed.',
    { tracks: ['compliance'], tags: ['policies', 'legislation', 'policy review', 'drafting'],
      status: 'broken', issue: 'GET /api/legislation returns HTTP 500 (b200 crawl, 2026-08-19). The legislation pane renders empty; policy drafting and saving are unaffected.' });
  page('recruitment', '/recruitment.html', '🧑‍🍼 Recruitment',
    'Wren Recruit — vacancies, applicants, interviews and offers.',
    'Post the vacancy, track applicants, keep interview notes with the applicant.',
    'Applicant data is personal data with its own retention rule. Do not keep unsuccessful applicants indefinitely.',
    { tracks: ['people'], tags: ['recruitment', 'vacancies', 'applicants', 'hiring', 'interviews'] });
  page('regulatory', '/regulatory.html', '⚖️ Regulatory',
    'Regulatory alerts and changes that affect the setting — statutory updates, guidance changes.',
    'Read the alerts monthly; each one usually becomes a policy or checklist change.',
    'Alerts are informational. Wren does not action them for you — turn each into an action-plan item.',
    { tracks: ['compliance'], tags: ['regulatory', 'alerts', 'legislation', 'statutory changes', 'guidance'] });
  page('regulatory-alert-detail', '/regulatory/alert-detail.html', '⚖️ Regulatory → Alert detail',
    'One regulatory alert in full, with what changed and what it means for you.',
    'Read, decide the action, log the decision.',
    'Known issue (b200): the crawl hit a 500 on this route when reached without a valid alert id — reach it by clicking an alert, not by typing the URL.',
    { tracks: ['compliance'], tags: ['alert detail', 'regulatory'],
      status: 'partial', issue: 'The crawl recorded HTTP 500 on /api/regulatory/alerts/alert-detail.html — the page was reached without a real alert id. Open alerts from the Regulatory list rather than by direct URL.' });
  page('repairs', '/repairs.html', '🔧 Repairs',
    'The repairs log — raised in Nest, triaged and closed here.',
    'Triage daily; safety first regardless of cost.',
    'Closing does not notify the reporter. Leave a comment.',
    { tracks: ['daily'], tags: ['repairs', 'maintenance', 'broken', 'facilities'] });
  page('report-card', '/report-card.html', '📊 Report card',
    'An internal inspection-readiness indicator across the statutory areas.',
    'Use as a management temperature check, monthly.',
    '<b>It is not an Ofsted grade</b> and must never be shown to staff or parents as one. It is a self-assessment of what is recorded.',
    { tracks: ['compliance'], tags: ['report card', 'readiness', 'self assessment', 'ofsted'] });
  page('reports', '/reports.html', '📄 Reports',
    'The reporting hub — every standard report across children, staff, finance and compliance.',
    'Come here first when someone asks for "the numbers".',
    'Reports run on live data. Two people running the same report an hour apart can legitimately get different answers — date-stamp anything you circulate.',
    { tracks: ['compliance'], tags: ['reports', 'reporting', 'export', 'numbers', 'statistics'] });
  page('report-writer', '/report-writer.html', '✍️ Report writer',
    'Write child reports with AI assistance grounded in that child\'s own observations.',
    'Generate a first draft per child, then rewrite in your voice.',
    'The draft is written from recorded observations only. A child with few observations gets a thin, generic report — fix the observations, not the prompt.',
    { tracks: ['learning'], tags: ['report writer', 'write reports', 'ai reports', 'summative'] });
  page('resource-cards', '/resource-cards.html', '🃏 Resource cards',
    'Printable teaching resource cards — activities, prompts and provocations by area.',
    'Print a set for each room and rotate them.',
    'Cards are generic starting points. The good bit is the adult\'s follow-up, not the card.',
    { tracks: ['learning'], tags: ['resource cards', 'printables', 'activities', 'prompts'] });
  page('room-headcounts', '/room-headcounts.html', '🧮 Room headcounts',
    'Scheduled headcounts and the live ratio-compliance log.',
    'Do them at the set times; the log is your evidence you were in ratio all day.',
    'A missed headcount cannot be back-filled honestly. Record it as missed — a fabricated headcount is far worse than a gap.',
    { tracks: ['compliance', 'daily'], tags: ['headcount', 'ratios', 'room counts', 'compliance'] });
  page('rota', '/rota.html', '📅 Rota',
    'The rota on a standalone page — build, check ratios, publish, export.',
    'Build next week, check the ratio bar, publish.',
    '<b>Publishing emails 17+ real staff.</b> Never publish a test week on production.',
    { tracks: ['people'], tags: ['rota', 'shifts', 'schedule', 'publish rota'] });
  page('sanitiser', '/sanitiser.html', '🧼 PII sanitiser',
    'Strips names and identifying detail out of text before it goes anywhere external.',
    'Run any case study, training example or support ticket through it first.',
    'It is a helper, not a guarantee. Read the output yourself — context can identify a child even without a name.',
    { tracks: ['compliance'], tags: ['sanitiser', 'pii', 'anonymise', 'redact', 'gdpr'] });
  page('scheduling', '/scheduling.html', '🗓️ Scheduling',
    'General scheduling across rooms, staff and resources.',
    'Use for anything that needs a slot but is not a shift.',
    'It does not check ratios. The rota does — do not schedule staff here and assume you are covered.',
    { tracks: ['people'], tags: ['scheduling', 'slots', 'bookings', 'timetable'] });
  page('security', '/security.html', '🔒 Security',
    'Security posture on a standalone page: sessions, devices, 2FA and login history.',
    'Review after any staff change.',
    'Revoking a device is a token revocation, not a logout. Do the revocation, not just the sign-out.',
    { tracks: ['setup', 'compliance'], tags: ['security', 'devices', '2fa', 'sessions', 'logins'] });
  page('sen-flags', '/sen-flags.html', '🔎 SEN early flagging',
    'Decision support that flags children whose pattern may warrant a closer look.',
    'Use as a prompt for a professional conversation, never as a conclusion.',
    'It is a signal, not a diagnosis, and it is dev-status. Nothing here goes to a parent without a practitioner\'s judgement in front of it.',
    { tracks: ['learning', 'compliance'], tags: ['sen flags', 'early identification', 'send', 'concerns'] });
  page('sen-register', '/sen-register.html', '🧩 SEND register',
    'The SEND hub: the register, SMART targets, assess-plan-do-review cycles and play plans.',
    'Keep the register current and run APDR cycles on a real schedule.',
    'A child on the register with no current cycle is the single most common SEND inspection finding. Cycles, not the register, are the evidence.',
    { tracks: ['learning', 'compliance'], tags: ['send', 'sen', 'send register', 'apdr', 'targets', 'play plan', 'senco'] });
  page('setting-incidents', '/setting-incidents.html', '🏚️ Setting incidents',
    'Significant events at the <em>setting</em> — fire, intruder, lost child, outbreak — with Ofsted notification tracking.',
    'Log the event the same day and record whether Ofsted was notified and when.',
    'These are the ones with a statutory notification window. Child accidents go in Incidents; this page is for events affecting the setting.',
    { tracks: ['compliance'], tags: ['setting incidents', 'fire', 'intruder', 'lost child', 'outbreak', 'ofsted notification'] });
  page('settings-approvals', '/settings/approvals.html', '✅ Settings → Approvals',
    'Approval routing configuration.',
    'Set who signs off what.',
    'Check the queue is empty before turning an approval off.',
    { tracks: ['setup'], tags: ['approvals', 'sign off', 'routing'] });
  page('settings-food-menus', '/settings/food-menus.html', '🍽️ Settings → Food menus',
    'The menu builder — weekly menus, dishes and their allergens.',
    'Set the term\'s menu; it publishes to the parents portal and the kitchen day sheet.',
    'Allergens are per dish. A dish with no allergens recorded shows as safe for everyone — fill them in.',
    { tracks: ['daily', 'compliance'], tags: ['menu', 'food', 'meals', 'allergens', 'dishes'] });
  page('settings-page', '/settings.html', '⚙️ Settings',
    'The main settings page, including the module toggles and the "Take the tour" card that launches this tour.',
    'Come here to switch modules, change setting details, or relaunch the tour.',
    'Some destinations (Data Governance, Access Control, Sidebar Layout) are only linked from here and the avatar menu — they are deliberately not in the sidebar.',
    { tracks: ['setup'], tags: ['settings', 'preferences', 'configuration', 'take the tour', 'modules'] });
  page('settings-index', '/settings/index.html', '⚙️ Settings hub',
    'The index for the standalone settings pages.',
    'Use as the menu when doing a configuration session.',
    'Same settings as the SPA section — do not expect a second, different set.',
    { tracks: ['setup'], tags: ['settings hub'] });
  page('settings-permissions', '/settings/permissions.html', '🔑 Settings → Permissions',
    'Per-staff capability grants.',
    'Grant the minimum needed; review on every role change.',
    'Medicine permissions are per-staff; salary visibility is manager-only. Both are capabilities, not roles.',
    { tracks: ['setup', 'compliance'], tags: ['permissions', 'capabilities', 'grant', 'access rights'] });
  page('setup', '/setup.html', '🚀 Setup wizard',
    'The first-run wizard — eight screens that get a new setting from empty to usable.',
    'Run once at go-live; it is self-gating and closes itself when complete.',
    'It is unauthenticated by design so a brand-new setting can start. On an established setting it is already closed — that is correct, not broken.',
    { tracks: ['setup'], tags: ['setup', 'wizard', 'first run', 'onboarding', 'go live'] });
  page('single-central-record', '/single-central-record.html', '🗂️ Single central record',
    'The inspector-ready SCR: every staff member\'s checks in one table, with unified expiry tracking.',
    'Check it monthly and before any inspection; it is the first document an inspector asks for.',
    'A blank cell reads as "not checked", not "not applicable". Fill every cell, even if the answer is N/A with a reason.',
    { tracks: ['people', 'compliance'], tags: ['scr', 'single central record', 'dbs', 'checks', 'safer recruitment', 'ofsted'] });
  page('staff-absence-mgmt', '/staff/absence-mgmt.html', '🏖️ Staff → Absence approval',
    'The absence approval queue for staff leave requests.',
    'Approve or decline within a couple of days; people book real life around this.',
    'Approving does not check the rota. Look at the rota and the calendar before saying yes to a busy week.',
    { tracks: ['people'], tags: ['absence approval', 'leave requests', 'holiday approval'] });
  page('staff-celebrations', '/staff-celebrations.html', '🎉 Celebrations',
    'Birthdays, work anniversaries and festivals, with cards, vouchers, flowers and credited service.',
    'Check at the start of each month so nobody is missed.',
    'Credited service (from a previous employment) changes anniversary dates. Set it when someone joins, not when they notice.',
    { tracks: ['people'], tags: ['celebrations', 'birthdays', 'anniversaries', 'gifts', 'staff recognition'] });
  page('staff-cpd-page', '/staff/cpd.html', '🎓 Staff → CPD',
    'CPD from the staff-management side — who has done what.',
    'Use in appraisal and for the training matrix.',
    'External training must be entered manually or it never appears.',
    { tracks: ['people'], tags: ['cpd', 'training record'] });
  page('staff-page', '/staff.html', '👥 Staff (standalone)',
    'The staff list on a standalone page.',
    'Quick lookups without loading the SPA.',
    'Salary columns are hidden for non-managers — a permission gate, not missing data.',
    { tracks: ['people'], tags: ['staff list', 'team'] });
  page('staffing-analytics', '/staffing-analytics.html', '📊 Staffing analytics',
    'Analysis of staffing against occupancy and ratio requirements, including the historical BrightHR analysis.',
    'Use before hiring or restructuring — it shows where you are genuinely over- or under-staffed.',
    'The historical analysis found ~92% of weekdays overstaffed and zero below legal minimum. That is a planning signal, not a redundancy plan.',
    { tracks: ['people', 'finance'], tags: ['staffing analytics', 'ratios', 'overstaffed', 'efficiency', 'cost'] });
  page('staffing-weeks', '/staffing-weeks.html', '📆 Staffing by week',
    'Week-by-week staffing levels against expected occupancy.',
    'Use for term planning and holiday cover.',
    'It uses work patterns plus attendance, because actual shift records are sparse. Treat it as a good estimate, not a timesheet.',
    { tracks: ['people'], tags: ['staffing by week', 'cover', 'weekly staffing'] });
  page('staff-knowledge', '/staff-knowledge.html', '🧠 Knowledge & CPD',
    'Always-on staff knowledge checks plus the safeguarding-CPD dashboard.',
    'Run a check each term; the dashboard shows who is overdue on safeguarding.',
    'A knowledge check is formative. Do not use a low score punitively — use it to decide what to train.',
    { tracks: ['people', 'compliance'], tags: ['knowledge checks', 'quiz', 'safeguarding cpd', 'competence'] });
  page('staff-performance', '/staff-performance.html', '📈 Staff performance',
    'The supportive observation-practice board with a locally generated AI summary.',
    'Read before supervision.',
    'It is about practice and support. Presenting it as a ranking is the fastest way to make staff stop recording observations.',
    { tracks: ['people'], tags: ['performance', 'observation practice', 'supervision prep'] });
  page('staff-policies', '/staff/policies.html', '📄 Staff → Policies',
    'Policies from the staff-management side — who has acknowledged what.',
    'Chase the unacknowledged after every policy update.',
    'An acknowledgement is against a version. Updating a policy resets acknowledgement — that is intended.',
    { tracks: ['people', 'compliance'], tags: ['policies', 'acknowledge', 'staff policies'] });
  page('staff-profile', '/staff-profile.html', '👤 Staff profile',
    'One staff member in full: contract, documents, absence, CPD, supervisions, performance.',
    'Open before a supervision or an HR conversation.',
    'Salary fields render blank without the salary capability. Do not conclude the record is incomplete.',
    { tracks: ['people'], tags: ['staff profile', 'staff record', 'employee'] });
  page('staff-scheduling', '/staff-scheduling.html', '🗓️ Staff scheduling',
    'Staff scheduling beyond the rota — training days, meetings, cover.',
    'Block out training before building the rota, not after.',
    'Blocks here do not automatically remove someone from the rota. Check the rota afterwards.',
    { tracks: ['people'], tags: ['staff scheduling', 'training days', 'cover', 'meetings'] });
  page('staff-smart-staffing', '/staff/smart-staffing.html', '🤖 Smart staffing',
    'AI-assisted staffing suggestions from occupancy, patterns and ratios.',
    'Run it when planning a term; treat the output as a proposal.',
    'Known issue (b200): "latest" 404s until the analysis has been run at least once. Run it, then reload.',
    { tracks: ['people'], tags: ['smart staffing', 'ai staffing', 'suggestions'],
      status: 'partial', issue: 'GET /api/staff-analytics/smart-staffing/latest returns HTTP 404 with no generated analysis (b200 crawl, 2026-08-19) — empty state, not a crash.' });
  page('staff-toil', '/staff/toil.html', '⏰ Staff → TOIL',
    'Time off in lieu balances and manager adjustments.',
    'Adjust when someone works extra; staff spend it as leave in Seed.',
    'TOIL adjustments are manager-only and audited. Adjusting a balance without a note produces an argument three months later.',
    { tracks: ['people'], tags: ['toil', 'time off in lieu', 'overtime', 'balance'] });
  page('staff-wellbeing', '/staff/wellbeing.html', '💚 Staff → Wellbeing',
    'Wellbeing check-ins and concerns across the team.',
    'Read the trend, not individual entries; act on a sustained dip.',
    'Staff share these expecting care, not management action. Respond privately and personally, never in a team meeting.',
    { tracks: ['people'], tags: ['wellbeing', 'mental health', 'check in', 'staff support'] });
  page('state-view', '/state-view.html', '🔭 State view',
    'A forward-looking view of the setting\'s state — where things are heading.',
    'Use in the monthly management review.',
    'It is a forecast surface. Do not read a projection as a commitment.',
    { tracks: ['setup'], tags: ['state', 'forecast', 'overview'] });
  page('stretch-reconciliation', '/stretch-reconciliation.html', '📐 Stretch reconciliation',
    'Reconciles stretched funded hours for children leaving in July — the classic clawback trap.',
    'Run every July before the final claim.',
    'A child who leaves mid-stretch has taken more hours than the term-time claim covers. This page is what stops you paying that back.',
    { tracks: ['finance', 'compliance'], tags: ['stretch', 'stretched funding', 'reconciliation', 'july leavers', 'clawback'] });
  page('study', '/study.html', '🎓 Study (admin)',
    'Admin over the parent study modules — what is published, who has completed what, pending approvals.',
    'Publish a module a term and check completions.',
    'The crawl saw 401s here without a session; if you get one while logged in, the session has expired.',
    { tracks: ['comms'], tags: ['study', 'parent learning', 'modules', 'courses for parents'] });
  page('supervisions', '/supervisions.html', '🤝 Supervisions',
    'Supervision records and targets, editable, mirrored to Nest and Seed.',
    'Book, run, write up, set targets.',
    'The staff member reads their own supervision. Write it for them, not about them.',
    { tracks: ['people', 'compliance'], tags: ['supervision', 'one to one', 'appraisal', 'targets', 'meetings'] });
  page('suppliers', '/suppliers.html', '📇 Suppliers',
    'The supplier directory — contacts, contracts, renewal dates.',
    'Keep it current so anyone can find the plumber at 7am.',
    'A supplier record with no renewal date will auto-renew without anyone noticing. Fill the dates.',
    { tags: ['suppliers', 'contractors', 'vendors', 'contacts'] });
  page('survey-eylog', '/survey-eylog.html', '🗳️ EyLog survey',
    'The migration/parity survey comparing what EyLog did with what Wren does.',
    'Use when a member of staff says "EyLog had X".',
    'It is a comparison record, not a roadmap. A gap listed here is not automatically being built.',
    { tags: ['eylog', 'migration', 'parity', 'comparison'] });
  page('tasks', '/tasks.html', '🗒️ Tasks',
    'Task list across the setting — assigned, due, done.',
    'Assign anything that needs doing by a named person on a named day.',
    'Tasks and the Cockpit kanban are different lists. Pick one for a given kind of work, or you will keep both badly.',
    { tracks: ['daily'], tags: ['tasks', 'to do', 'assignments', 'jobs'] });
  page('termly-plan', '/termly-plan.html', '🗓️ Termly plan',
    'The termly plan: six weeks of provision and activities per room, ending in an evaluation.',
    'Write it at the start of term with the room leaders; evaluate at the end.',
    'The end-of-term evaluation is the bit that matters and the bit everyone skips. Diary it in week one.',
    { tracks: ['learning'], tags: ['termly plan', 'term planning', 'provision', 'evaluation'] });
  page('totp-setup', '/totp-setup.html', '🔐 Two-factor setup',
    'Set up an authenticator app for your account.',
    'Do it once, on your own phone.',
    'Save the recovery codes somewhere that is not the phone with the authenticator on it.',
    { tracks: ['setup'], tags: ['2fa', 'totp', 'authenticator', 'mfa', 'security'] });
  page('traffic-stats', '/traffic-stats.html', '📊 Traffic stats',
    'Website and portal traffic — what parents and prospects actually look at.',
    'Read monthly alongside the enquiry numbers.',
    'Known issue (b200): the summary endpoint returned 403 in the crawl — it is manager-gated. If you see an empty page, check your role before reporting a fault.',
    { tracks: ['admissions'], tags: ['traffic', 'analytics', 'visitors', 'website stats'],
      status: 'partial', issue: 'GET /api/analytics/summary returned HTTP 403 in the b200 crawl — role-gated to managers. Not a defect; non-managers see an empty page.' });
  page('vapi-actions', '/vapi-actions.html', '☎️ Vapi actions',
    'What the phone assistant is allowed to do — the tools and their parameters.',
    'Configure before expecting Aria to do anything beyond talking.',
    'Tools have to exist in the Vapi dashboard as well. Zero runs means the dashboard side was never configured.',
    { tracks: ['comms', 'setup'], tags: ['vapi', 'aria tools', 'phone actions', 'call automation'] });
  page('vapi-health', '/vapi-health.html', '🩺 Vapi health',
    'Health of the phone-assistant integration — calls, failures, latency.',
    'Check after any report that "the phone did something odd".',
    'A healthy integration with zero calls means the number is not routed to it. Check the phone routing, not Wren.',
    { tracks: ['comms', 'setup'], tags: ['vapi health', 'phone status', 'calls'] });
  page('waiting-list', '/waiting-list.html', '📝 Waiting list',
    'The waiting list with tiers, dates and parked entries.',
    'Review monthly; offer from it when a place appears.',
    'Parked families are excluded from active demand on purpose. Do not read a short active list as low demand.',
    { tracks: ['admissions'], tags: ['waiting list', 'waitlist', 'places', 'demand', 'parked'] });
  page('waiting-list-info', '/waiting-list-info.html', '📄 Waiting list policy',
    'The honest public explanation of how the waiting list works.',
    'Link it from every waiting-list conversation so expectations are set once.',
    'If the policy and your actual practice differ, fix the practice. Parents compare notes.',
    { tracks: ['admissions'], tags: ['waiting list policy', 'how the list works', 'public'] });
  page('website-builder', '/website-builder.html', '🌐 Website',
    'The editor for the public nursery website.',
    'Update news, availability links and staff photos as they change.',
    'Publishing is live to the public internet immediately. Preview first, and remember photo consent applies to the website too.',
    { tracks: ['comms', 'setup'], tags: ['website', 'public site', 'marketing', 'edit website'] });
  page('wren-leads', '/wren-leads.html', '📥 Wren leads',
    'Leads from the getwren.co.uk product site (not nursery enquiries).',
    'Only relevant if you are also selling Wren; otherwise ignore.',
    'These are product leads, not parents. Never answer one with nursery information.',
    { tags: ['leads', 'getwren', 'product', 'sales'] });

  // ───────────────────────────────────────────────────────────────────────────
  // NEST (EY practitioner portal, /ey/*) — tablet-first, one job per screen
  // ───────────────────────────────────────────────────────────────────────────
  var ey = [];
  function eyp(slug, url, title, what, does, gotcha, extra) {
    var s = { id: 'ey.' + slug, url: url, title: title, what: what, does: does, gotcha: gotcha,
      href: url, tracks: (extra && extra.tracks) || [], tags: (extra && extra.tags) || [] };
    if (extra && extra.status) { s.status = extra.status; s.issue = extra.issue; }
    if (extra && extra.sel) s.sel = extra.sel;
    if (extra && extra.aliases) s.aliases = extra.aliases;
    ey.push(s); return s;
  }

  ey.push({
    id: 'ey.welcome', url: '/ey/home', title: '🪺 Welcome to Nest',
    what: 'Nest is the practitioner portal — the tablet app the floor actually uses. Everything here is designed to be done one-handed, in a room, in under thirty seconds.',
    does: 'A room leader\'s day: register in, diary through the day, observations as they happen, register out. Everything else lives behind <b>More</b>.',
    gotcha: 'Nest and Roost are the same database. An observation written here is instantly visible to the office and (once reviewed) to the parent — there is no "save it properly later".',
    sel: '#wren-app-topbar, header', tracks: ['daily'], tags: ['nest', 'ey portal', 'tablet', 'practitioner'],
  });
  eyp('home', '/ey/home', '🏠 Nest → Home',
    'The day at a glance: who is in, what still needs doing, nudges, the door, and the quick actions for the current room.',
    'Start and end every session here. The nudges are the honest to-do list.',
    'The child photos come from the uploads folder; a missing photo shows a placeholder 404 in the console. Cosmetic — it never blocks anything.',
    { tracks: ['daily'], tags: ['home', 'today', 'nest home', 'dashboard'] });
  eyp('register', '/ey/register', '📋 Nest → Register',
    'The daily register — sign children in and out, see who is expected, mark absences.',
    'Sign in as children arrive, not in a batch at 10am. Ratios and fire lists depend on it being live.',
    '"Who is expected today" comes from the child\'s bookings, not from a contract. A child with no booking never appears — tell the office rather than adding them ad hoc.',
    { tracks: ['daily'], tags: ['register', 'sign in', 'attendance', 'who is in', 'present'] });
  eyp('signin', '/ey/signin', '✍️ Nest → Sign in',
    'The quick sign-in surface for arrivals and departures, including who collected.',
    'Record the collector\'s name every time, not just for unusual pick-ups.',
    'A blank collector field on an unusual pick-up is the gap that matters. Fill it in at the door, not from memory at 6pm.',
    { tracks: ['daily'], tags: ['sign in', 'sign out', 'collection', 'pick up', 'arrival'] });
  eyp('room-headcount', '/ey/room-headcount', '🧮 Nest → Room headcount',
    'Scheduled headcounts with the live ratio check.',
    'Do them at the set times; it takes ten seconds and it is your ratio evidence.',
    'A skipped headcount cannot be recovered later. Record it as missed rather than guessing a number.',
    { tracks: ['daily', 'safety'], tags: ['headcount', 'ratios', 'count', 'room count'] });
  eyp('diary', '/ey/diary', '📔 Nest → Diary',
    'The child\'s day: meals, drinks, bottles, nappies, toileting, sleep, mood — a timeline of entries, not one row per day.',
    'Log as it happens. Parents read this the moment they get home.',
    'The "Bottle" filter matches entry type <code>bottle</code>, but bottles are stored as <code>drink</code> — so the Bottle filter can look empty when bottles have been logged. Use the unfiltered timeline.',
    { tracks: ['daily'], tags: ['diary', 'daily diary', 'meals', 'nappies', 'sleep', 'bottles', 'food'],
      status: 'partial', issue: 'The /ey/diary "Bottle" filter queries entry_type=\'bottle\' while bottle entries are stored as \'drink\', so it can render empty. Workaround: use the unfiltered timeline. Logged for fix.' });
  eyp('diary-all', '/ey/diary-all', '📔 Nest → Diary (all children)',
    'Every child\'s diary in one list for the room.',
    'Use at the end of the session to spot the child nobody has logged anything for.',
    'A blank row is not a quiet day; it is usually a missed entry. Check before you go home.',
    { tracks: ['daily'], tags: ['all diaries', 'room diary', 'everyone'] });
  eyp('diary-entry', '/ey/diary/entry', '➕ Nest → New diary entry',
    'The single-entry form — pick the child, the type, the detail.',
    'Use for anything not covered by the group screens.',
    'Time defaults to now. If you are catching up at the end of a session, set the real time or the parent gets a nonsense timeline.',
    { tracks: ['daily'], tags: ['new diary entry', 'log', 'add entry'], aliases: ['/ey/diary-entry'] });
  eyp('group-diary', '/ey/group/diary.html', '👥 Nest → Group diary',
    'Log the same diary event for several children at once.',
    'Use at snack, lunch and sleep — it is the difference between logging and not logging.',
    'Group logging applies the same time and detail to everyone selected. Deselect the child who did something different rather than editing afterwards.',
    { tracks: ['daily'], tags: ['group diary', 'bulk log', 'several children'] });
  eyp('group-food', '/ey/group/food.html', '🍽️ Nest → Group food',
    'Record what a group of children ate and how much.',
    'Do it at the table, while you can still see the plates.',
    'Allergy flags come from the child record. If a flag looks wrong, stop and check the child profile — do not override it here.',
    { tracks: ['daily'], tags: ['food', 'meals', 'lunch', 'snack', 'eating'] });
  eyp('group-bottle', '/ey/group/bottle.html', '🍼 Nest → Group bottles',
    'Bottle feeds for several babies — amount, time, how much was taken.',
    'Record the amount actually taken, not the amount offered.',
    'Bottles are stored as drink entries. See the Diary "Bottle" filter note — the data is there even when that filter looks empty.',
    { tracks: ['daily'], tags: ['bottle', 'milk', 'feed', 'baby'] });
  eyp('group-nappies', '/ey/group/nappies.html', '👶 Nest → Group nappies',
    'Nappy changes for the room, including whether cream was applied.',
    'Log at the change; use the per-child cream toggle where a cream is prescribed.',
    'Cream is a per-child consent/medical matter. Applying cream that is not on the child\'s record is a medicines issue, not a nappy one.',
    { tracks: ['daily'], tags: ['nappy', 'nappies', 'changing', 'cream', 'dry', 'clean'] });
  eyp('group-toilet', '/ey/group/toilet.html', '🚽 Nest → Group toileting',
    'Toileting records for children out of nappies.',
    'Log through the day; it matters for potty training conversations with parents.',
    'Accidents are not incidents. Log them here, not in Incidents, unless someone was hurt.',
    { tracks: ['daily'], tags: ['toilet', 'potty', 'toileting', 'wee', 'accidents'] });
  eyp('group-sleep', '/ey/group/sleep.html', '😴 Nest → Group sleep',
    'Sleep records for the room, feeding the sleep-check chart.',
    'Start the sleep when the child goes down, not when you remember.',
    'Wake time is derived from start time plus duration. Get the start right and the rest follows.',
    { tracks: ['daily', 'safety'], tags: ['sleep', 'nap', 'rest', 'sleep checks'] });
  eyp('group-observation', '/ey/group/observation.html', '🔭 Nest → Group observation',
    'One observation applied to several children who were in the same moment.',
    'Use for a shared activity, then personalise each child\'s next step.',
    'A group observation with identical wording for six children reads exactly like what it is. Add one specific line per child.',
    { tracks: ['learning'], tags: ['group observation', 'shared activity'] });
  eyp('log-select-action', '/ey/log/select-action', '➕ Nest → Log something',
    'The chooser: which kind of thing are you about to record?',
    'It is the fastest route into the right form — start here rather than hunting in More.',
    'Choosing the wrong type then editing is slower than backing out. Back out.',
    { tracks: ['daily'], tags: ['log', 'add', 'record something', 'new entry'] });
  eyp('sleep-chart', '/ey/sleep-chart', '😴 Nest → Sleep chart',
    'The sleep-check chart — every check on every sleeping child, at the required interval.',
    'Check and record at the interval, every time, without exception.',
    'A gap in the chart is a safeguarding finding, not a paperwork one. If a check was late, record it late and honestly.',
    { tracks: ['daily', 'safety'], tags: ['sleep chart', 'sleep checks', 'safer sleep', 'naps'] });
  eyp('observation-new', '/ey/observation/new', '🔭 Nest → New observation',
    'Write an observation: what you saw, photos, framework statements, next step.',
    'Write it in the moment in the child\'s own words and actions. Link statements after, not before.',
    'Statements chosen before writing produce observations that fit the framework rather than the child. Write first, tag second.',
    { tracks: ['learning', 'daily'], tags: ['observation', 'new observation', 'wow moment', 'write observation', 'photo'], aliases: ['/ey/observation-new'] });
  eyp('observation-view', '/ey/observation-view.html', '👁️ Nest → View observation',
    'One observation in full, with its statements, next steps and review status.',
    'Check yours were approved; read colleagues\' to calibrate.',
    'An observation still in review has not reached the parent, however finished it looks.',
    { tracks: ['learning'], tags: ['view observation', 'observation detail'] });
  eyp('obs-tracker', '/ey/obs-tracker', '📊 Nest → Observation tracker',
    'Coverage of observations by child and area — who has been observed and who has not.',
    'Check weekly for your key children.',
    'Coverage is not quality. Six observations of the same child at the sand tray is one observation repeated.',
    { tracks: ['learning'], tags: ['observation tracker', 'coverage', 'key children'] });
  eyp('trackers', '/ey/trackers', '📈 Nest → Trackers',
    'The framework tracker grid, EyLog-style, plus the Termly Updates tab.',
    'Update at termly review; use the Termly Updates tab to see who is Done / Due / Overdue.',
    'The live framework is <code>birth_to_5_la</code> (554 statements, 4,510 cells) — not the older synthetic <code>birth_to_5</code>. A grid that looks unfamiliar is the wrong framework.',
    { tracks: ['learning'], tags: ['tracker', 'framework', 'grid', 'birth to 5', 'termly update', 'development matters'] });
  eyp('two-year-check', '/ey/trackers/two-year-check', '2️⃣ Nest → Two-year check',
    'The statutory progress check at age two.',
    'Complete within the window and share it with the parent and the health visitor.',
    'It is statutory and dated. Late is a compliance finding — diary it from the child\'s second birthday, not from when someone notices.',
    { tracks: ['learning', 'safety'], tags: ['two year check', 'progress check', 'statutory', '2 year old'] });
  eyp('journey', '/ey/journey', '🌱 Nest → Learning journey',
    'A child\'s whole journey — observations, photos, milestones, in order.',
    'Read before a parent conversation or a transition meeting.',
    'It shows what was recorded. A thin journey usually means thin recording, not a thin child.',
    { tracks: ['learning'], tags: ['learning journey', 'journey', 'progress', 'portfolio'] });
  eyp('child', '/ey/child.html', '👶 Nest → Child',
    'The practitioner view of one child: about me, allergies, key person, diary, observations, next steps.',
    'Open at the start of a session with a child you do not know well.',
    'Allergies and medical detail come from the office record. If they look wrong, escalate — do not edit around them.',
    { tracks: ['daily', 'learning'], tags: ['child', 'child record', 'about me', 'allergies', 'key person'], aliases: ['/ey/child/:id'] });
  eyp('next-steps-ey', '/ey/child.html#next-steps', '➡️ Nest → Next steps',
    'A child\'s next steps, created from observations.',
    'Set one or two at a time, from something you actually saw.',
    'A next step nobody plans for is a wish. Put it into the weekly plan the same week.',
    { tracks: ['learning'], tags: ['next steps', 'targets', 'what next'] });
  eyp('planning', '/ey/planning', '📚 Nest → Planning',
    'The room\'s weekly plan — activities, provision, focus children.',
    'Write it with the room, not for the room. Name the focus children.',
    'Planning written here is the same record the office reads. There is no separate "proper" plan to write up later.',
    { tracks: ['learning'], tags: ['planning', 'weekly plan', 'activities', 'provision'] });
  eyp('termly-plan', '/ey/termly-plan', '🗓️ Nest → Termly plan',
    'Six weeks of provision per room, with an end-of-term evaluation.',
    'Write it in week one, evaluate in week six.',
    'The evaluation is the part that improves anything and the part that gets skipped. Diary it now.',
    { tracks: ['learning'], tags: ['termly plan', 'term', 'provision', 'evaluation'] });
  eyp('termly-review', '/ey/termly-review', '🔁 Nest → Termly review',
    'The per-child termly review — where each child is and what changes next term.',
    'Do them in a block at the end of term, with the tracker open.',
    'A termly update is an observation flagged as a termly update. Doing one is what clears the "Due" state on the tracker.',
    { tracks: ['learning'], tags: ['termly review', 'termly update', 'end of term', 'review'] });
  eyp('activities', '/ey/activities', '🎨 Nest → Activities',
    'The activity bank with EYFS links and what you need for each.',
    'Pull two or three into next week\'s plan.',
    'An activity is not a plan. The learning is in the adult\'s intent, which the bank cannot supply.',
    { tracks: ['learning'], tags: ['activities', 'ideas', 'activity bank'] });
  eyp('story-studio', '/ey/story-studio', '📖 Nest → Story studio',
    'Make an illustrated story for or with a child, using the setting\'s own photos.',
    'Great for transitions, settling in and social stories.',
    'Photos mean consent. Check before a story leaves the room.',
    { tracks: ['learning'], tags: ['story studio', 'social story', 'stories', 'transitions'] });
  eyp('phonics', '/ey/phonics', '🔤 Nest → Phonics',
    'Phonics progress per child against the setting\'s scheme.',
    'Update after each session; it takes seconds and it is the only record.',
    'The scheme is set centrally. Do not track against a scheme the setting does not use — it will not match the school\'s expectations.',
    { tracks: ['learning'], tags: ['phonics', 'sounds', 'reading', 'rwi'] });
  eyp('phonics-group', '/ey/phonics-group', '🔤 Nest → Phonics group',
    'Run and record a phonics group session for several children.',
    'Record who was present and what was covered, straight after.',
    'Absent children silently fall behind. Check the group list, not the register, before assuming a child has had the input.',
    { tracks: ['learning'], tags: ['phonics group', 'group session', 'sounds'] });
  eyp('sen', '/ey/sen', '🧩 Nest → SEN',
    'SEN support from the room: targets, play plans, what has been tried.',
    'Record what you actually did and what happened — that is the evidence.',
    'A play plan with no recorded delivery is a plan nobody followed. Log the sessions.',
    { tracks: ['learning', 'safety'], tags: ['sen', 'send', 'special needs', 'play plan', 'targets'] });
  eyp('two-year-check-alt', '/ey/two-year-check', '2️⃣ Nest → Two-year check (direct)',
    'The two-year progress check reached directly rather than through the tracker.',
    'Same form, same statutory window.',
    'Two routes, one record. Do not fill it in twice.',
    { tracks: ['learning'], tags: ['two year check', 'progress check'] });
  eyp('safeguarding-new', '/ey/safeguarding/new', '🛡️ Nest → Log a concern',
    'Record a safeguarding concern in your own words, immediately.',
    'Write what you saw and heard, not what you concluded. Submit the same day — the same hour if you can.',
    'Once submitted it cannot be edited, by design. That is what makes it evidence. Write it carefully, then submit.',
    { tracks: ['safety', 'daily'], tags: ['safeguarding', 'concern', 'child protection', 'report a concern', 'disclosure'], aliases: ['/ey/safeguarding-new'] });
  eyp('incident-new', '/ey/incident/new', '🩹 Nest → Log an incident',
    'Record an accident or injury to a child — what happened, where, what you did, who was told.',
    'Log before the child goes home; the parent must be told the same day.',
    'A bump to the head has its own escalation. Do not batch head bumps with grazes.',
    { tracks: ['safety', 'daily'], tags: ['incident', 'accident', 'injury', 'bump', 'head bump', 'first aid'], aliases: ['/ey/incident-new'] });
  eyp('setting-incident-new', '/ey/setting-incident/new', '🏚️ Nest → Setting incident',
    'Record a significant event affecting the setting — fire, intruder, evacuation, outbreak, lost child.',
    'Log it as soon as the situation is safe.',
    'These carry statutory Ofsted notification windows. Logging it here is the start of that clock, not the end of the job.',
    { tracks: ['safety'], tags: ['setting incident', 'fire', 'evacuation', 'intruder', 'lost child', 'outbreak'], aliases: ['/ey/setting-incident-new'] });
  eyp('medicine-new', '/ey/medicine/new', '💊 Nest → Give medicine',
    'Record administering medicine, with the witness and the parental consent.',
    'Two people, every time: administer and witness.',
    'Access is per-staff. If the screen is not there for you, you do not have the medicine permission — find someone who does rather than logging it under their name.',
    { tracks: ['safety', 'daily'], tags: ['medicine', 'medication', 'give medicine', 'calpol', 'witness'], aliases: ['/ey/medicine-new'] });
  eyp('risk-assessments', '/ey/risk-assessments', '⚠️ Nest → Risk assessments',
    'Risk assessments for the room, the garden, activities and outings.',
    'Read the relevant one before the activity; update it after anything unexpected.',
    'A risk assessment nobody has read is paperwork. The safety nudge on the home page exists because they get skipped.',
    { tracks: ['safety'], tags: ['risk assessment', 'safety', 'hazards', 'ra'] });
  eyp('visitors', '/ey/visitors', '🚶 Nest → Visitors',
    'The visitor log — who came in, when, why, and whether ID was checked.',
    'Sign every visitor in and out, including contractors and professionals.',
    'A visitor not signed in does not exist on the fire list. That is the whole point of the log.',
    { tracks: ['safety', 'daily'], tags: ['visitors', 'sign in visitors', 'contractors', 'fire list'] });
  eyp('door', '/ey/door', '🚪 Nest → Door',
    'The front door: who is ringing, live view and release.',
    'Answer from the room rather than walking to the door with a child on your hip.',
    'Releasing the door is your responsibility. Look before you release — the camera is there for that.',
    { tracks: ['daily', 'safety'], tags: ['door', 'doorbell', 'entry', 'answer the door', 'intercom'] });
  eyp('kitchen-ey', '/ey/kitchen', '🍽️ Nest → Kitchen',
    'The kitchen view from the floor: today\'s menu, allergens and the day sheet.',
    'Check the allergen list against who is actually in before lunch.',
    'The day sheet is generated from signed-in children. Check it after late arrivals.',
    { tracks: ['daily', 'safety'], tags: ['kitchen', 'menu', 'allergens', 'lunch', 'food'] });
  eyp('repairs-ey', '/ey/repairs', '🔧 Nest → Repairs',
    'Report something broken, and see what you have already reported.',
    'Report it the moment you see it, with a photo.',
    'Reporting twice is far better than assuming someone else did. Duplicates are cheap; a broken gate is not.',
    { tracks: ['daily'], tags: ['repairs', 'broken', 'report', 'maintenance', 'fix'] });
  eyp('resources-ey', '/ey/resources', '📁 Nest → Resources',
    'Documents, guides and printables staff need on the floor.',
    'Look here before asking the office for a form.',
    'These are the current versions. Do not work from a printout in a drawer.',
    { tags: ['resources', 'documents', 'forms', 'guides'] });
  eyp('resource-cards-ey', '/ey/resource-cards', '🃏 Nest → Resource cards',
    'Printable activity and prompt cards by area of learning.',
    'Print a set per room and rotate.',
    'A card is a prompt for the adult, not a worksheet for the child.',
    { tracks: ['learning'], tags: ['resource cards', 'printables', 'prompts'] });
  eyp('toolbox', '/ey/toolbox', '🧰 Nest → Toolbox',
    'The practitioner toolbox — quick tools and references for the floor.',
    'Bookmark the two or three you use.',
    'It is a collection of shortcuts, not a separate system. Everything in it also lives somewhere else.',
    { tags: ['toolbox', 'tools', 'shortcuts'] });
  eyp('policies-ey', '/ey/policies', '📄 Nest → Policies',
    'The setting\'s policies, and which ones you still need to acknowledge.',
    'Acknowledge when a new version lands; read the safeguarding one properly.',
    'Acknowledgement resets when a policy is updated. That is intended — read the change, do not just re-tick.',
    { tracks: ['safety'], tags: ['policies', 'acknowledge', 'procedures'] });
  eyp('reflect', '/ey/reflect', '🪞 Nest → Reflect',
    'Your private self-reflection space: quizzes, key-children gap analysis, an AI coach and sector watch.',
    'Ten minutes a week. Share only the narrative you choose to share.',
    'Reflections are owner-scoped — your manager cannot read them unless you share. Child names are stripped before anything reaches the model.',
    { tracks: ['learning'], tags: ['reflect', 'reflection', 'cpd', 'self assessment', 'coach', 'quiz'] });
  eyp('supervisions-ey', '/ey/supervisions', '🤝 Nest → Supervisions',
    'Your supervision records and targets, editable from the floor.',
    'Read your targets before the next supervision; add your own agenda items.',
    'It is the same record the manager writes in. Adding your view before the meeting genuinely changes the meeting.',
    { tracks: ['learning'], tags: ['supervision', 'one to one', 'targets', 'appraisal'] });
  eyp('my-shifts', '/ey/my-shifts', '📅 Nest → My shifts',
    'Your published shifts, and any open shifts you can claim.',
    'Claim open shifts here — first to claim gets it.',
    'Only published rotas appear. An empty week usually means the rota has not been published yet, not that you are not working.',
    { tracks: ['daily'], tags: ['my shifts', 'rota', 'when am i working', 'open shifts', 'claim'] });
  eyp('staff-clock', '/ey/staff-clock', '⏱️ Nest → Clock in/out',
    'Clock in and out from the tablet (as well as the door fob).',
    'Clock in when you start, out when you finish. Not when you remember.',
    'A missed clock-out has to be corrected by a manager and shows in the audit. Two seconds now saves that.',
    { tracks: ['daily'], tags: ['clock in', 'clock out', 'hours', 'timesheet'] });
  eyp('my-documents', '/ey/my-documents', '📄 Nest → My documents',
    'Your own documents — contract, certificates, DBS.',
    'Upload a new certificate the day you get it.',
    'These feed the Single Central Record. An expired certificate here is a compliance gap on the office\'s report.',
    { tags: ['my documents', 'certificates', 'dbs', 'contract'] });
  eyp('messages-ey', '/ey/messages', '💬 Nest → Messages',
    'Message threads with parents and colleagues.',
    'Answer parents through here so it is recorded and reviewable.',
    'Messages to parents may go through manager review before sending. If a parent says they never got it, check the review queue.',
    { tracks: ['daily'], tags: ['messages', 'chat', 'parents', 'threads'] });
  eyp('inbox-ey', '/ey/inbox', '📥 Nest → Inbox',
    'Your own inbox within Nest.',
    'Check at the start and end of a shift.',
    'It is not the nursery inbox. Anything addressed to the nursery is in Nursery Inbox.',
    { tracks: ['daily'], tags: ['inbox', 'my messages'] });
  eyp('nursery-inbox', '/ey/nursery-inbox.html', '🏢 Nest → Nursery inbox',
    'The shared nursery mailbox, readable from the floor.',
    'Use when the office is closed and something needs answering.',
    'Reads are locked to an allowlist and audited. Open it because you need to, not because you can.',
    { tracks: ['daily'], tags: ['nursery inbox', 'shared inbox', 'office email'] });
  eyp('send-email', '/ey/send-email', '📧 Nest → Send email',
    'Send an email from the nursery address.',
    'Use for the things a message thread does not cover — a form, a letter, an attachment.',
    'Non-managers can only email parents of currently enrolled children; anything else is refused with a 403. That is the GDPR allowlist, not a fault.',
    { tracks: ['daily'], tags: ['send email', 'email a parent', 'compose'] });
  eyp('review-queue-ey', '/ey/review-queue.html', '✅ Nest → Review queue',
    'Items from the floor waiting on a manager decision.',
    'Check whether yours has been approved before chasing.',
    'Nothing in the queue has happened yet — an unapproved observation has not reached the parent.',
    { tracks: ['daily'], tags: ['review queue', 'pending', 'approval'] });
  eyp('drafts', '/ey/drafts', '📝 Nest → Drafts',
    'Your unfinished observations and entries.',
    'Empty it at the end of every shift.',
    'A draft is invisible to everyone else. An observation left in drafts is an observation that did not happen.',
    { tracks: ['daily', 'learning'], tags: ['drafts', 'unfinished', 'saved'] });
  eyp('reports-ey', '/ey/reports', '📄 Nest → Reports',
    'Child reports you can write and read from the floor.',
    'Write from your own observations of your key children.',
    'Parents keep these. Read yours back once before submitting.',
    { tracks: ['learning'], tags: ['reports', 'write a report', 'child report'] });
  eyp('reports-summative', '/ey/reports/summative', '📊 Nest → Summative reports',
    'End-of-term and transition summaries per child.',
    'Write with the tracker open so the summary matches the evidence.',
    'A summative report that contradicts the tracker will be spotted. Fix the tracker or fix the report — do not publish both.',
    { tracks: ['learning'], tags: ['summative', 'end of term report', 'transition report'],
      aliases: ['/ey/reports-summative'] });
  eyp('action-plans-ey', '/ey/action-plans', '⭐ Nest → Action plans',
    'Your room\'s improvement plan and your part in it.',
    'Look before supervision; bring evidence of what you have done.',
    'Room plans are visible to the whole room. Individual issues belong in supervision.',
    { tags: ['action plans', 'room plan', 'improvement'] });
  eyp('new-starters', '/ey/new-starters', '🌱 Nest → New starters',
    'Children starting soon: settling-in visits, about-me information, first-day needs.',
    'Read before the child\'s first session so you know their name and their comfort object.',
    'Settling-in information is often the only thing you know about a child on day one. Read it before, not during.',
    { tracks: ['daily'], tags: ['new starters', 'settling in', 'new children', 'first day'] });
  eyp('more', '/ey/more', '☰ Nest → More',
    'The full menu — everything not on the home screen, grouped by what you are trying to do.',
    'When you cannot find something, it is here.',
    'Planning and curriculum live in More, not on the home screen. That is deliberate (the home screen is for now, More is for everything else) — they must never be removed from here.',
    { tracks: ['daily'], tags: ['more', 'menu', 'everything', 'find'] });
  eyp('settings-ey', '/ey/settings', '⚙️ Nest → Settings',
    'Your account and device preferences, including the mic and chatbot toggles.',
    'Set your PIN and turn off anything you find distracting.',
    'Preferences are per-device. Turning the mic off on the baby-room tablet does not turn it off on the pre-school one.',
    { tags: ['settings', 'my account', 'pin', 'preferences', 'mic'] });
  eyp('help-ey', '/ey/help', '❓ Nest → Help',
    'In-app help for practitioners — how to do the common jobs, in order.',
    'Check here before asking; it covers the twenty things people actually ask.',
    'The help text here is also indexed into the assistant, so asking Wren AI gets you the same answer plus a link.',
    { tracks: ['daily'], tags: ['help', 'how do i', 'guide', 'support'] });
  eyp('how-wren-works-ey', '/ey/how-wren-works.html', '🗺️ Nest → How Wren works',
    'The plain-English explanation of the four portals and where data goes.',
    'Read once in your first week.',
    'Knowing that Nest, Roost and Finch share one database is what stops people double-recording everything.',
    { tags: ['how wren works', 'portals', 'explainer'] });
  eyp('fledge-framework-ey', '/ey/fledge-framework.html', '🪶 Nest → Fledge framework',
    'Wren\'s own developmental framework and how it maps to EYFS.',
    'Read once so the extra statements make sense.',
    'Statutory reporting still uses EYFS. Fledge sits alongside it.',
    { tracks: ['learning'], tags: ['fledge', 'framework'] }).fledge = true;   // fledge-off: behind the switch
  eyp('request-access', '/ey/request-access', '🔓 Nest → Request access',
    'Ask for a permission or a portal you do not currently have.',
    'Say what you need it for — that is what the manager approves against.',
    'Requests go to a manager queue, not to IT. A request with no reason usually sits.',
    { tags: ['request access', 'permission', 'ask for access'] });
  eyp('journey-alt', '/ey/journey?child=', '🌱 Nest → A child\'s journey',
    'One child\'s learning journey, reached from their profile.',
    'Open it in a parent conversation and scroll together.',
    'Photos in the journey are consent-gated. Check before showing a screen to another family.',
    { tracks: ['learning'], tags: ['journey', 'portfolio', 'parent conversation'] });

  // ───────────────────────────────────────────────────────────────────────────
  // FINCH (parents portal, /welcome/*)
  // ───────────────────────────────────────────────────────────────────────────
  var parents = [];
  function pp(slug, url, title, what, does, gotcha, extra) {
    var s = { id: 'parents.' + slug, url: url, title: title, what: what, does: does, gotcha: gotcha,
      href: url, tracks: (extra && extra.tracks) || [], tags: (extra && extra.tags) || [] };
    if (extra && extra.status) { s.status = extra.status; s.issue = extra.issue; }
    if (extra && extra.sel) s.sel = extra.sel;
    if (extra && extra.aliases) s.aliases = extra.aliases;
    parents.push(s); return s;
  }

  parents.push({
    // The parents home is served at /welcome (see server-unified). /welcome/home
    // is NOT that page — it falls through to the legacy dashboard — so the alias
    // exists only so the coverage audit can match welcome/home.html.
    id: 'parents.welcome', url: '/welcome', aliases: ['/welcome/home'], title: '🐣 Welcome to Finch',
    what: 'Finch is the parents portal. Families see their own child\'s day, learning, fees and messages — and nothing about anyone else\'s child.',
    does: 'As a manager, know this portal well enough to talk a parent through it on the phone. Most "the app is broken" calls are "I am looking at the wrong screen".',
    gotcha: 'Everything here is strictly own-child scoped, and access is behind an email one-time-code. A parent who has never activated their account sees nothing at all — check activation first.',
    tracks: ['daily'], tags: ['finch', 'parents portal', 'parent app', 'family'],
  });
  pp('home', '/welcome', '🏠 Finch → Home',
    'The parent\'s landing page: today\'s highlights, unread messages, and the menu of everything else.',
    'Walk a new parent through this screen once — it prevents most support calls.',
    'The keepsake row only appears for leaving families. A parent who cannot see it has not left yet, which is correct.',
    { tracks: ['daily'], tags: ['home', 'parent home', 'dashboard'], aliases: ['/welcome/home'] });
  pp('learning-journey', '/welcome/learning-journey', '🌱 Finch → Learning journey',
    'Observations, photos and progress for their child.',
    'Point parents here when they ask "what does she actually do all day?"',
    'Only reviewed observations appear. A quiet journey usually means a backlog in the review queue, not a quiet child.',
    { tracks: ['daily'], tags: ['learning journey', 'observations', 'photos', 'progress'] });
  pp('diary', '/welcome/diary', '📔 Finch → Diary',
    'The daily diary — meals, naps, nappies, mood.',
    'This is the single most-read screen in the product. Diary quality is parent satisfaction.',
    'It updates through the day, so a parent checking at 11am sees less than at 5pm. Say so, or they think it is broken.',
    { tracks: ['daily'], tags: ['diary', 'daily diary', 'meals', 'naps', 'nappies'] });
  pp('baby-log', '/welcome/baby-log', '🍼 Finch → Baby log',
    'The baby-specific view — bottles, sleeps, nappies at a glance.',
    'Recommend it to baby-room parents instead of the general diary.',
    'Same underlying entries as the diary, laid out differently. Not a second record to fill in.',
    { tracks: ['daily'], tags: ['baby log', 'bottles', 'baby', 'feeds'] });
  pp('records', '/welcome/records', '🗂️ Finch → Records',
    'Accident, medication and sleep records for their child.',
    'Parents can see accidents here as well as being told at the door — mention that when you hand over.',
    'A parent seeing an accident record they were not told about verbally is a complaint. Always tell them first.',
    { tracks: ['daily'], tags: ['records', 'accidents', 'medication', 'sleep', 'incidents'] });
  pp('messages', '/welcome/messages', '💬 Finch → Messages',
    'Message threads with the key person, the office or the manager.',
    'Answer within a working day; parents treat it like WhatsApp.',
    'Staff replies may go through manager review. Set the expectation of "within a day", not "immediately".',
    { tracks: ['daily'], tags: ['messages', 'contact', 'chat', 'ask'] });
  pp('community', '/welcome/community', '👪 Finch → Community',
    'The parent-to-parent forum.',
    'Moderate it weekly from Roost — see Parent community moderation.',
    'An unmoderated parent forum becomes a complaints board. Moderate it or switch it off; do not leave it drifting.',
    { tags: ['community', 'forum', 'other parents'] });
  pp('menu', '/welcome/menu', '🍽️ Finch → Menu',
    'This week\'s meals.',
    'Keep it current — parents plan the evening meal around it.',
    'It publishes from the food-menu builder. A stale menu here means nobody updated the builder.',
    { tracks: ['daily'], tags: ['menu', 'food', 'meals', 'lunch', 'what is for lunch'] });
  pp('events', '/welcome/events', '📅 Finch → Events',
    'Trips, celebrations and parent evenings, with RSVP.',
    'Publish events at least two weeks ahead; chase RSVPs at one week.',
    'RSVP is per-family. Ask for child numbers explicitly if you need them for catering or ratios.',
    { tags: ['events', 'rsvp', 'trips', 'parents evening'] });
  pp('calendar', '/welcome/calendar', '🗓️ Finch → Calendar',
    'The nursery calendar as parents see it — terms, closures, events.',
    'Publish closures as early as you can; it is the single biggest source of parent frustration.',
    'A closure added late is worse than a closure announced early. Get the year up in September.',
    { tags: ['calendar', 'term dates', 'closures', 'holidays', 'inset'] });
  pp('newsletter', '/welcome/newsletter', '📰 Finch → Newsletter',
    'The latest newsletter, archived in the portal as well as emailed.',
    'Send monthly; the archive means new families can catch up.',
    'Emailed and in-app are the same newsletter. Do not write two.',
    { tags: ['newsletter', 'news', 'updates'] });
  pp('planning', '/welcome/planning', '📚 Finch → Planning',
    'What the child\'s room is learning this week.',
    'Publishing planning is cheap and disproportionately builds trust.',
    'Planning must stay reachable from the parents portal — it is one of the things families notice is missing when it moves.',
    { tags: ['planning', 'what they are learning', 'curriculum'] });
  pp('phonics', '/welcome/phonics', '🔤 Finch → Phonics',
    'The child\'s phonics progress plus sounds and games to try at home.',
    'Point pre-school parents here in the spring term.',
    'Parents teaching a different scheme at home confuses children. Name the scheme explicitly.',
    { tags: ['phonics', 'sounds', 'reading at home', 'rwi'] });
  pp('home-activities', '/welcome/home-activities', '🎨 Finch → Home activities',
    'Things to try at home, linked to what the child is working on.',
    'Refresh termly; it is the most-used "extra" in the portal.',
    'Activities needing equipment most families do not have are worse than none. Keep them cheap.',
    { tags: ['home activities', 'things to do', 'at home', 'ideas'] });
  pp('study', '/welcome/study', '🎓 Finch → Study',
    'Short parent-learning modules — sleep, behaviour, speech, school readiness.',
    'Publish one a term and mention it in the newsletter.',
    'Completion is voluntary. Do not build anything (a consent, a place) on top of finishing a module.',
    { tags: ['study', 'parent learning', 'modules', 'courses'] });
  pp('study-module', '/welcome/study-module', '📘 Finch → Study module',
    'One module in full.',
    'Read one yourself before recommending it.',
    'Modules are generic content. If it contradicts your setting\'s practice, say so before a parent asks.',
    { tags: ['study module', 'lesson'] });
  pp('study-completed', '/welcome/study-completed', '✅ Finch → Completed study',
    'What the parent has finished.',
    'Acknowledge it — a one-line message costs nothing.',
    'Only the parent and the office see this. It is not a comparison between families.',
    { tags: ['completed', 'study progress'] });
  pp('study-rewards', '/welcome/study-rewards', '🏅 Finch → Study rewards',
    'Rewards for completing parent study modules.',
    'Keep the rewards genuine; a meaningless badge devalues the whole thing.',
    'Rewards need a session; the crawl saw 401s when logged out. If a parent reports an error, ask them to sign in again.',
    { tags: ['rewards', 'badges', 'study'] });
  pp('resources', '/welcome/resources', '📁 Finch → Resources',
    'Guides, policies and documents for families.',
    'Keep the policy pack current; it is what a parent reads before complaining.',
    'File links need an authenticated session. A parent opening a link from an old email while logged out gets an error.',
    { tags: ['resources', 'documents', 'policies', 'guides', 'downloads'] });
  pp('guide', '/welcome/guide', '📗 Finch → Parent guide',
    'The in-app guide: how to use the portal, and how the nursery works.',
    'Link it in the welcome email for every new family.',
    'This guide is indexed into the assistant\'s knowledge base too, so keeping it accurate improves the answers staff get.',
    { tags: ['guide', 'help', 'how to use', 'parent handbook'] });
  pp('consents', '/welcome/consents', '✅ Finch → Consents',
    'Photos, outings, sun cream, plasters — the parent grants and withdraws consent here.',
    'Chase blanks before a trip or a photo shoot.',
    'A withdrawn consent takes effect immediately and retrospectively for anything not yet published. Check before publishing photos.',
    { tracks: ['daily'], tags: ['consent', 'permission', 'photos', 'sun cream', 'outings'] });
  pp('declaration', '/welcome/declaration', '📝 Finch → Funding declaration',
    'The parental declaration for funded hours.',
    'It must be signed each funding period before you can claim.',
    'A missing declaration means an unclaimable child. Chase it before the headcount, not after.',
    { tracks: ['daily'], tags: ['declaration', 'funding', 'funded hours', 'parental declaration', 'sign'] });
  pp('absence', '/welcome/absence', '🏝️ Finch → Report absence',
    'Parents report sickness or holiday themselves; it flows into the register.',
    'Encourage it — it beats a 7:50am voicemail nobody hears.',
    'A reported absence updates the register but not the invoice. Fees are unaffected unless you change them in Finance.',
    { tracks: ['daily'], tags: ['absence', 'report absence', 'sickness', 'holiday', 'not coming in'] });
  pp('bookings', '/welcome/bookings', '📆 Finch → Bookings',
    'The child\'s session pattern and requests for extra days.',
    'Approve or decline extra-day requests promptly; parents book childcare around them.',
    'Bookings drive the register and occupancy. An approved extra day that never becomes a booking is invisible to the room.',
    { tags: ['bookings', 'sessions', 'extra days', 'days'] });
  pp('fees', '/welcome/fees', '🧾 Finch → Fees',
    'The family\'s fee schedule — what is charged and why.',
    'Point parents here before a fee conversation; it removes most of the heat.',
    'It shows the schedule, not the balance. Balance is on Invoices.',
    { tags: ['fees', 'charges', 'costs', 'fee schedule'] });
  pp('invoices', '/welcome/invoices', '💷 Finch → Invoices',
    'Statements and balance, view-only, own-child scoped.',
    'Point parents here for "what do I owe?"',
    'It is deliberately view-only — there is no payment button on this page. Payment is on the Payments page.',
    { tags: ['invoices', 'balance', 'statement', 'what do i owe'] });
  pp('payments', '/welcome/payments', '💳 Finch → Payments',
    'Pay and manage the Direct Debit mandate.',
    'Get every family onto Direct Debit; it removes most of the chasing.',
    'A failed Direct Debit is silent to the parent. Tell them; do not wait for them to notice.',
    { tags: ['payments', 'pay', 'direct debit', 'card'] });
  pp('dd-setup', '/welcome/dd-setup', '🏦 Finch → Direct Debit setup',
    'Setting up the mandate.',
    'Send the link with the welcome pack, not with the first invoice.',
    'A mandate takes days to become active. Set it up before the first payment is due.',
    { tags: ['direct debit', 'mandate', 'setup', 'bank'] });
  pp('details', '/welcome/details', '📋 Finch → Your account',
    'Contact and child details the parent can update; changes come to Roost for approval.',
    'Ask families to check it termly — emergency contacts drift.',
    'Changes are requests, not immediate edits. If nobody clears the Family approval queue, the record stays wrong.',
    { tracks: ['daily'], tags: ['details', 'contact details', 'update details', 'emergency contact', 'address'] });
  pp('documents', '/welcome/documents', '📄 Finch → Document upload',
    'Parents share files with the setting — birth certificates, court orders, medical letters.',
    'Tell parents what you need rather than waiting for it.',
    'Uploaded documents may contain sensitive legal material. File them properly and do not leave them sitting in the upload queue.',
    { tags: ['upload', 'documents', 'share a file', 'birth certificate'] });
  pp('data-request', '/welcome/data-request', '🔐 Finch → My data',
    'Subject access and erasure requests, self-service.',
    'Handle from Roost → Data Governance → Data requests within the statutory window.',
    'Erasure retains safeguarding, incident, medication, financial and attendance records by law. Tell the parent that when they ask, not after.',
    { tags: ['my data', 'gdpr', 'subject access', 'delete my data', 'erasure'] });
  pp('surveys', '/welcome/surveys', '🗳️ Finch → Surveys',
    'Surveys waiting for the family.',
    'Run the annual survey here; the results feed the SEF.',
    'Anonymous means anonymous — decide before sending, because you cannot chase individuals afterwards.',
    { tags: ['surveys', 'feedback', 'questionnaire'] });
  pp('survey-render', '/welcome/survey-render', '📝 Finch → Survey (fill in)',
    'The survey form itself.',
    'Test one yourself on a phone before sending it to 70 families.',
    'A survey that is painful on a phone gets a 10% response rate. Keep it under ten questions.',
    { tags: ['survey form', 'fill in survey'] });
  pp('survey-annual', '/welcome/survey-annual', '📊 Finch → Annual survey',
    'The annual parent survey.',
    'Send once a year, publish the results and what you changed.',
    'Publishing "you said, we did" afterwards is what makes the next year\'s response rate good.',
    { tags: ['annual survey', 'parent survey'] });
  pp('survey-eylog', '/welcome/survey-eylog', '🗳️ Finch → EyLog survey',
    'The migration survey asking families about the move from EyLog.',
    'Useful once; archive it when the migration is old news.',
    'A live survey about a finished migration makes the setting look stuck. Retire it.',
    { tags: ['eylog survey', 'migration'] });
  pp('memory-box', '/welcome/memory-box', '🎁 Finch → Memory box',
    'The curated highlights of the child\'s time with you.',
    'Add to it through the year, not in the last week.',
    'Everything here is consent-gated and family-visible. Check no other child appears in a photo.',
    { tags: ['memory box', 'photos', 'highlights', 'memories'] });
  pp('keepsake', '/welcome/keepsake', '💛 Finch → Memory keepsake',
    'The free leaving keepsake — a self-contained, offline, installable copy of the child\'s whole journey, theirs forever.',
    'Generate and send in the child\'s last week. It needs no login and never expires.',
    'It embeds the media, so it is large and it is permanent. Once a family has it you cannot take it back — check the content first.',
    { tags: ['keepsake', 'leaving gift', 'memories', 'leaving', 'moving on'] });
  pp('action-plans', '/welcome/action-plans', '⭐ Finch → Action plans',
    'The improvement actions you have chosen to share with families.',
    'Share two or three visible ones a term.',
    'Only shared plans appear. If it looks empty, nothing has been shared — that is a decision, not a fault.',
    { tags: ['action plans', 'you said we did', 'improvements'] });
  pp('homework', '/welcome/homework', '📚 Finch → Homework',
    'Home learning tasks (used by the school editions more than the nursery).',
    'Ignore in an EY setting unless you deliberately set home learning.',
    'Setting homework in early years is usually a mistake. Home activities are the EY-appropriate version.',
    { tags: ['homework', 'home learning'] });
  pp('about', '/welcome/about', '🛡️ Finch → About & security',
    'How the setting keeps data safe, and where to get help.',
    'Link it in the welcome email; it answers the data questions before they are asked.',
    'It states your actual security posture. Keep it accurate — an out-of-date claim here is a GDPR problem, not a marketing one.',
    { tags: ['about', 'security', 'privacy', 'data protection', 'help'] });

  // ───────────────────────────────────────────────────────────────────────────
  // SEED (HR portal)
  // ───────────────────────────────────────────────────────────────────────────
  var hr = [];
  function hp(slug, url, title, what, does, gotcha, extra) {
    var s = { id: 'hr.' + slug, url: url, title: title, what: what, does: does, gotcha: gotcha,
      href: url, tracks: (extra && extra.tracks) || [], tags: (extra && extra.tags) || [] };
    if (extra && extra.status) { s.status = extra.status; s.issue = extra.issue; }
    if (extra && extra.sel) s.sel = extra.sel;
    if (extra && extra.aliases) s.aliases = extra.aliases;
    hr.push(s); return s;
  }

  hr.push({
    id: 'hr.welcome', url: '/index.html', title: '🌱 Welcome to Seed',
    what: 'Seed is the HR portal: your own employment record, and — if you manage people — the team\'s.',
    does: 'Staff live in the "My" pages. Managers also get Team, Rota, Policies admin and Performance.',
    gotcha: 'Seed and Roost share the staff record. A change made in either shows in both — there is no separate HR database to keep in sync.',
    sel: '.topbar-logo, #wren-topbar .wren-logo, #wren-app-topbar .wren-app-logo, #wren-app-topbar', tracks: ['my'], tags: ['seed', 'hr portal', 'staff portal'],
  });
  hp('dashboard', '/index.html', '🏠 Seed → Dashboard',
    'Your HR summary: leave balance, TOIL, policies awaiting acknowledgement, next supervision.',
    'Glance weekly; act on anything with a number on it.',
    'Managers see an extra team block below. If a colleague describes a screen you do not have, that is the role difference.',
    { tracks: ['my'], tags: ['hr dashboard', 'home', 'my summary'] });
  hp('my-profile', '/my-profile.html', '👤 Seed → My profile',
    'Your own record: contact details, emergency contact, contract, bank details.',
    'Check it termly; keep the emergency contact current.',
    'You update your own details. If yours are wrong, that is yours to fix, not the office\'s.',
    { tracks: ['my'], tags: ['my profile', 'my details', 'emergency contact', 'bank details'] });
  hp('my-absences', '/my-absences.html', '🏖️ Seed → My absences',
    'Your leave: booked, taken, remaining, plus sickness.',
    'Book leave here; check the remaining balance before promising anyone a holiday.',
    'Booking is a request, not an approval. Do not book flights on an unapproved request.',
    { tracks: ['my'], tags: ['my absences', 'book leave', 'holiday', 'annual leave', 'time off'] });
  hp('my-supervisions', '/my-supervisions.html', '🤝 Seed → My supervisions',
    'Your supervision records and agreed targets.',
    'Read your targets before each supervision; add your own agenda items.',
    'This is the same record your manager writes. Reading it before the meeting changes the meeting.',
    { tracks: ['my'], tags: ['my supervisions', 'one to one', 'targets', 'appraisal'] });
  hp('my-toil', '/my-toil.html', '⏰ Seed → My TOIL',
    'Your time-off-in-lieu balance and history.',
    'Check before requesting TOIL as leave.',
    'Only a manager can adjust the balance. If it looks wrong, ask — do not assume it will correct itself.',
    { tracks: ['my'], tags: ['toil', 'time off in lieu', 'overtime', 'my hours'] });
  hp('my-cpd', '/my-cpd.html', '🎓 Seed → My CPD',
    'Your training record, assigned courses and certificates.',
    'Complete assigned courses; upload external certificates yourself.',
    'A completed course is not a CPD record until a manager authorises it. Chase the authorisation.',
    { tracks: ['my'], tags: ['my cpd', 'my training', 'courses', 'certificates'] });
  hp('my-induction', '/my-induction.html', '🌱 Seed → My induction',
    'Your induction workbook and how far through it you are.',
    'Finish it in the first weeks, not the first year.',
    'An incomplete induction limits what you can do unsupervised. It is a safeguarding control, not paperwork.',
    { tracks: ['my'], tags: ['induction', 'new starter', 'onboarding', 'probation'] });
  hp('my-wellbeing', '/my-wellbeing.html', '💚 Seed → My wellbeing',
    'Your private wellbeing check-ins.',
    'Use it honestly; a pattern is more useful than a single bad day.',
    'A manager sees trends and concerns, not every entry. Anything you flag as a concern is intended to be read.',
    { tracks: ['my'], tags: ['wellbeing', 'mental health', 'check in', 'how am i'] });
  hp('my-shifts-hr', '/my-shifts.html', '📅 Seed → My shifts',
    'Your published rota and claimable open shifts.',
    'Claim open shifts fast — first claim wins.',
    'Only published weeks show. An empty week is usually an unpublished rota.',
    { tracks: ['my'], tags: ['my shifts', 'rota', 'when am i working'] });
  hp('my-surveys', '/my-surveys.html', '🗳️ Seed → My surveys',
    'Staff surveys waiting for you.',
    'Answer them; staff-voice evidence matters at inspection.',
    'Anonymous staff surveys really are anonymous. Say what you think.',
    { tracks: ['my'], tags: ['my surveys', 'staff survey', 'feedback'] });
  hp('my-leave-weights', '/my-leave-weights.html', '⚖️ Seed → My leave weights',
    'How your leave entitlement is calculated from your working pattern.',
    'Check when your hours change — entitlement changes with them.',
    'Part-time entitlement is pro-rata in <em>days you work</em>, not calendar days. This page is where that gets explained.',
    { tracks: ['my'], tags: ['leave weights', 'entitlement', 'pro rata', 'part time holiday'] });
  hp('policies', '/policies.html', '📄 Seed → Policies',
    'Every policy, and which ones you still need to acknowledge.',
    'Acknowledge when prompted; actually read the safeguarding ones.',
    'Acknowledgement is per version. An update resets it — that is intended.',
    { tracks: ['my'], tags: ['policies', 'acknowledge', 'read policies'] });
  hp('ealing-partnership', '/ealing-partnership.html', '🤝 Seed → Ealing EY partnership',
    'Local authority early-years partnership information, training and updates.',
    'Check for LA training before booking anything commercial.',
    'LA training is often free and often unadvertised. This page is the only place it surfaces.',
    { tracks: ['my'], tags: ['ealing', 'local authority', 'partnership', 'la training'] });
  hp('cpd-ai-creator', '/cpd/ai-creator.html', '🤖 Seed → AI CPD creator',
    'Generate a CPD course from a topic, running on the local model.',
    'Use to turn a real incident or a new policy into a short course quickly.',
    'The output is a draft. Read it end to end before publishing — it will confidently invent a statistic if you let it.',
    { tracks: ['manager'], tags: ['ai cpd', 'create course', 'training creator'] });
  hp('staff-hr', '/staff.html', '👥 Seed → All staff',
    'The team list from the HR side.',
    'Use for contact details and contract facts.',
    'Salary fields are manager-only. A deputy seeing blanks is the capability gate, not a bug.',
    { tracks: ['manager'], tags: ['all staff', 'team', 'staff list'] });
  hp('supervisions-hr', '/supervisions.html', '🤝 Seed → Supervisions',
    'Team supervisions — schedule, run, record.',
    'Keep the cycle; overdue supervisions are an inspection finding.',
    'The staff member reads it. Write it for them.',
    { tracks: ['manager'], tags: ['supervisions', 'team supervisions', 'schedule'] });
  hp('action-plans-hr', '/action-plans.html', '⭐ Seed → Action plans',
    'Action plans from the HR side.',
    'Link staff development actions to supervision targets.',
    'Same records as Roost. Do not maintain two versions.',
    { tracks: ['manager'], tags: ['action plans'] });
  hp('absence-mgmt', '/absence-mgmt.html', '✅ Seed → Absence approval',
    'The leave approval queue.',
    'Approve or decline within a couple of days.',
    'Approving does not check the rota. Look at the rota first.',
    { tracks: ['manager'], tags: ['absence approval', 'approve leave', 'requests'] });
  hp('absences-hr', '/absences.html', '🏖️ Seed → Absences',
    'The whole team\'s absence record.',
    'Review monthly alongside Bradford scores.',
    'Historical BrightHR absence (including leavers) is RAG-only and not in this table by design.',
    { tracks: ['manager'], tags: ['absences', 'team absence', 'sickness'] });
  hp('toil-hr', '/toil.html', '⏰ Seed → TOIL adjustments',
    'Adjust team TOIL balances.',
    'Adjust when someone works extra, with a note saying why.',
    'Adjustments are audited. An unexplained adjustment causes an argument three months later.',
    { tracks: ['manager'], tags: ['toil adjustments', 'time off in lieu'] });
  hp('cpd-matrix', '/cpd-matrix.html', '📊 Seed → CPD matrix',
    'The training matrix — who holds what, and the Assign & Authorise grid.',
    'Assign courses and authorise completions from the same grid.',
    'Assigning is not authorising. Both steps are needed before it counts as a CPD record.',
    { tracks: ['manager'], tags: ['cpd matrix', 'training matrix', 'assign', 'authorise'] });
  hp('policies-admin', '/policies-admin.html', '📝 Seed → Policies admin',
    'Publish and version policies; see who has acknowledged what.',
    'Publish a new version, then chase the unacknowledged.',
    'Publishing resets acknowledgement for everyone. Only publish a genuinely changed version.',
    { tracks: ['manager', 'compliance'], tags: ['policies admin', 'publish policy', 'versions', 'acknowledgements'] });
  hp('performance-hr', '/performance.html', '📈 Seed → Performance',
    'Team performance management.',
    'Use alongside supervisions, not instead of them.',
    'A performance process that starts here without prior supervision evidence will not survive scrutiny.',
    { tracks: ['manager'], tags: ['performance', 'performance management', 'capability'] });
  hp('rota-hr', '/rota.html', '📅 Seed → Rota',
    'The rota builder from the HR side.',
    'Build, ratio-check, publish.',
    '<b>Publishing emails every member of staff.</b> Never publish a test week.',
    { tracks: ['manager'], tags: ['rota', 'shifts', 'publish'] });
  hp('staffing-weeks-hr', '/staffing-weeks.html', '📆 Seed → Staffing by week',
    'Staffing levels week by week — a planning view, built from work patterns plus attendance because shift records are sparse.',
    'Use for holiday cover planning. Until the link below is fixed, open it in Roost instead: /staffing-weeks.html on the admin portal.',
    'The Seed manager sidebar links to this page, but the file only exists in the Roost edition — on the HR host the link lands on the HR login screen. Confirmed by the b201 link check, 2026-08-19.',
    { tracks: ['manager'], tags: ['staffing by week', 'cover'],
      status: 'broken', issue: 'The Seed manager nav links to /staffing-weeks.html, which is not served on the HR host (editions/hr/public has no such file) — the request falls through to the HR login page. The working copy is the same path on the Roost (admin) host.' });
  hp('messages-hr', '/messages.html', '💬 Seed → Messages',
    'Staff message threads.',
    'Use for HR conversations that need a record.',
    'HR messages are still auditable. Nothing here is off the record.',
    { tracks: ['my'], tags: ['messages', 'hr messages'] });
  hp('repairs-hr', '/repairs.html', '🔧 Seed → Repairs',
    'Report and track repairs from the HR portal.',
    'Report anything broken you notice.',
    'Same log as Nest and Roost. Duplicates are fine; silence is not.',
    { tracks: ['my'], tags: ['repairs', 'broken', 'report'] });
  hp('audit-hr', '/audit.html', '🔍 Seed → Audit',
    'The HR-side audit view.',
    'Use for HR investigations.',
    'Your own access is logged too.',
    { tracks: ['manager', 'compliance'], tags: ['audit', 'hr audit', 'log'] });
  hp('more-hr', '/more.html', '☰ Seed → More',
    'The rest of the HR portal — everything not on the dashboard.',
    'When something is missing, look here.',
    'Manager-only destinations are hidden for practitioners, so two people comparing this page see different lists. That is correct.',
    { tracks: ['my'], tags: ['more', 'menu', 'everything'] });

  // ── Legacy SPA fragments still on disk but NOT in the section registry ─────
  // b201 honesty pass: these five section fragments exist under
  // editions/admin/public/sections/ but have no entry in SECTIONS, so the shell
  // redirects /admin/<id> to the landing section. Documented rather than hidden,
  // because they are still linked from old bookmarks and screenshots.
  page('dashboard-legacy', '/admin/dashboard', '📊 Dashboard (legacy)',
    'The old admin dashboard. Roost\u2019s home became Cockpit on 2026-06-30 and this fragment was left behind.',
    'Nothing — use Cockpit for the daily view and Finance \u2192 Dashboard for the numbers.',
    'The fragment file still exists but the section is not registered, so /admin/dashboard bounces you to Cockpit. That is the shell working, not a broken link.',
    { tracks: ['setup'], tags: ['dashboard', 'old dashboard', 'home'], aliases: ['/sections/dashboard.html'],
      status: 'partial', issue: 'sections/dashboard.html exists on disk but has no SECTIONS entry, so /admin/dashboard redirects to the landing section (Cockpit). Legacy fragment — use Cockpit.' });
  page('insights-legacy', '/admin/insights', '📈 Insights (legacy)',
    'The Insights fragment, backed by the separate Insights FastAPI service (37 metrics).',
    'Nothing routinely — the metrics that matter surface in Reports and Finance.',
    'Not in the section registry, so it is unreachable through the SPA. The Insights service itself is still running internally.',
    { tracks: ['setup'], tags: ['insights', 'metrics', 'statistics'], aliases: ['/sections/insights.html'],
      status: 'partial', issue: 'sections/insights.html has no SECTIONS entry, so /admin/insights redirects to the landing section. The insights service (wren-insights-stats) is unaffected.' });
  page('gov-corpus-legacy', '/admin/gov-corpus', '🏛️ Gov corpus (legacy)',
    'A browser over ingested government guidance documents.',
    'Nothing — use Regulatory for guidance changes, and the assistant to search guidance.',
    'Not registered as a section, so unreachable through the SPA. The parents-side policies-and-frameworks page that reads the same corpus was seen returning 500 in the b200 crawl.',
    { tracks: ['compliance'], tags: ['gov corpus', 'guidance', 'legislation', 'documents'], aliases: ['/sections/gov-corpus.html'],
      status: 'broken', issue: 'No SECTIONS entry (unreachable via the SPA), and GET /api/gov-corpus/documents returned HTTP 500 in the b200 crawl (2026-08-19).' });
  page('intercom-legacy', '/admin/intercom', '📞 Intercom (legacy)',
    'An older intercom/door fragment.',
    'Nothing — use Door, Door access, or the Intercom answer screen.',
    'Not in the section registry. The working door surfaces are /door.html, /door-access.html and /intercom-answer.html.',
    { tracks: ['setup'], tags: ['intercom', 'door', 'doorbell'], aliases: ['/sections/intercom.html'],
      status: 'partial', issue: 'sections/intercom.html has no SECTIONS entry, so /admin/intercom redirects to the landing section. Use the standalone door pages.' });
  page('comms-hub-legacy', '/admin/comms-hub', '💬 Comms hub (legacy)',
    'The pre-merge comms hub fragment, superseded when comms merged into one section on 2026-06-18.',
    'Nothing — everything it did is in Comms.',
    'Not in the section registry. Its five .bak siblings on disk are a good sign of how much it moved before being retired.',
    { tracks: ['comms'], tags: ['comms hub', 'old comms'], aliases: ['/sections/comms-hub.html'],
      status: 'partial', issue: 'sections/comms-hub.html has no SECTIONS entry; superseded by the merged Comms section (2026-06-18).' });

  // ───────────────────────────────────────────────────────────────────────────
  // TRACKS — named subsets so "Manager: everything" and "Nest: daily routine"
  // are different runs of the same corpus. Every step is in 'everything'.
  // ───────────────────────────────────────────────────────────────────────────
  var TRACKS = {
    roost: [
      { id: 'everything',  label: 'Manager: everything',        blurb: 'Every screen in Roost, section by section. Long — it resumes where you left off.' },
      { id: 'daily',       label: 'Manager: the daily round',   blurb: 'The screens a manager touches every day.' },
      { id: 'people',      label: 'Staff & HR',                 blurb: 'Rota, absence, supervision, CPD, recruitment, the SCR.' },
      { id: 'finance',     label: 'Money',                      blurb: 'Invoices, funding, payroll, Xero reconciliation.' },
      { id: 'admissions',  label: 'Admissions & occupancy',     blurb: 'Enquiry to first day, plus occupancy and the waiting list.' },
      { id: 'learning',    label: 'Children & learning',        blurb: 'Children, observations, trackers, planning, SEND.' },
      { id: 'comms',       label: 'Communications',             blurb: 'Inbox, messaging, newsletters, parents, the website.' },
      { id: 'compliance',  label: 'Compliance & inspection',    blurb: 'Safeguarding, inspection, checklist, data governance.' },
      { id: 'setup',       label: 'Setup & system',             blurb: 'Settings, modules, integrations, permissions, security.' },
    ],
    ey: [
      { id: 'daily',      label: 'Nest: daily routine',   blurb: 'Register, diary, observations, sleep, home time. Start here.' },
      { id: 'everything', label: 'Nest: everything',      blurb: 'Every screen in Nest, including the ones behind More.' },
      { id: 'learning',   label: 'Learning & assessment', blurb: 'Observations, trackers, planning, phonics, reports.' },
      { id: 'safety',     label: 'Safety & safeguarding', blurb: 'Concerns, incidents, medicine, sleep checks, risk assessments.' },
    ],
    parents: [
      { id: 'daily',      label: 'Finch: what parents see daily', blurb: 'The screens families open every day — know these before the phone rings.' },
      { id: 'everything', label: 'Finch: everything',             blurb: 'The whole parents portal, so you can talk anyone through it.' },
    ],
    hr: [
      { id: 'my',         label: 'Seed: my own records', blurb: 'Your leave, TOIL, CPD, supervisions and policies.' },
      { id: 'manager',    label: 'Seed: managing a team', blurb: 'Approvals, rota, policies admin, CPD matrix, performance.' },
      { id: 'everything', label: 'Seed: everything',      blurb: 'Both of the above, in order.' },
      { id: 'compliance', label: 'Seed: compliance',      blurb: 'Policies, acknowledgements and the audit view.' },
    ],
  };

  var PORTALS = {
    roost:   { key: 'roost',   label: 'Roost',  subtitle: 'Admin portal',        steps: roost,   tracks: TRACKS.roost },
    ey:      { key: 'ey',      label: 'Nest',   subtitle: 'Practitioner portal', steps: ey,      tracks: TRACKS.ey },
    ladn:    { key: 'ladn',    label: 'Nest',   subtitle: 'Practitioner portal', steps: ey,      tracks: TRACKS.ey, aliasOf: 'ey' },
    parents: { key: 'parents', label: 'Finch',  subtitle: 'Parents portal',      steps: parents, tracks: TRACKS.parents },
    hr:      { key: 'hr',      label: 'Seed',   subtitle: 'HR portal',           steps: hr,      tracks: TRACKS.hr },
  };

  // ── Normalisation: every step gets portal + a full tracks list ──────────────
  Object.keys(PORTALS).forEach(function (pk) {
    if (PORTALS[pk].aliasOf) return;
    PORTALS[pk].steps.forEach(function (s) {
      s.portal = pk;
      s.status = s.status || 'ok';
      s.tracks = ['everything'].concat(s.tracks || []).filter(function (t, i, a) { return a.indexOf(t) === i; });
      s.tags = s.tags || [];
      s.aliases = s.aliases || [];
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Helpers (shared by the browser engine and the Node ingest script)
  // ───────────────────────────────────────────────────────────────────────────

  // Canonical path form so /ey/diary, /ey/diary.html and /ey/diary?child=3 all
  // resolve to the same step.
  function normPath(p) {
    if (!p) return '';
    p = String(p).split('?')[0].split('#')[0].toLowerCase();
    p = p.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
    if (p.length > 1) p = p.replace(/\/+$/, '');
    return p || '/';
  }

  /* fledge-off (2026-10-26): a step marked `fledge` describes a Fledge page, and only
   * exists while the Fledge switch is on (public/js/wren-fledge.js in the browser,
   * fed by ladn.settings.fledge_enabled). Off — or on the server, where there is no
   * switch reader — it is left out of every list, lookup and search below. The step
   * itself stays in the file, so it comes straight back when the switch is on. */
  function fledgeOn() {
    try { return !!(typeof self !== 'undefined' && self.WrenFledge && self.WrenFledge.enabled()); }
    catch (e) { return false; }
  }
  function live(s) { return !(s && s.fledge) || fledgeOn(); }

  function allSteps() {
    var out = [];
    Object.keys(PORTALS).forEach(function (pk) {
      if (PORTALS[pk].aliasOf) return;
      out = out.concat(PORTALS[pk].steps);
    });
    return out.filter(live);
  }

  function portalOf(key) {
    var p = PORTALS[key];
    if (p && p.aliasOf) p = PORTALS[p.aliasOf];
    return p || null;
  }

  function stepsFor(portalKey, trackId) {
    var p = portalOf(portalKey);
    if (!p) return [];
    var t = trackId || 'everything';
    return p.steps.filter(function (s) { return live(s) && s.tracks.indexOf(t) !== -1; });
  }

  function tracksFor(portalKey) {
    var p = portalOf(portalKey);
    return p ? p.tracks : [];
  }

  function stepById(id) {
    var all = allSteps();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  // Contextual help: the step describing the page you are standing on.
  // Exact path first, then the section prefix (so /admin/staff/rota falls back
  // to /admin/staff if the tab has no entry of its own).
  function forUrl(portalKey, pathname) {
    var p = portalOf(portalKey);
    if (!p) return null;
    var want = normPath(pathname);
    var i, s;
    for (i = 0; i < p.steps.length; i++) {
      s = p.steps[i];
      if (!live(s)) continue;
      if (normPath(s.url) === want) return s;
      for (var a = 0; a < (s.aliases || []).length; a++) {
        if (normPath(s.aliases[a]) === want) return s;
      }
    }
    var parts = want.split('/').filter(Boolean);
    while (parts.length > 1) {
      parts.pop();
      var pref = '/' + parts.join('/');
      for (i = 0; i < p.steps.length; i++) {
        s = p.steps[i];
        if (normPath(s.url) === pref) return s;
      }
    }
    return null;
  }

  var STOP = { the: 1, a: 1, an: 1, i: 1, do: 1, is: 1, of: 1, to: 1, in: 1, on: 1, for: 1, and: 1,
    where: 1, how: 1, what: 1, can: 1, my: 1, me: 1, it: 1, we: 1, you: 1, does: 1, find: 1, get: 1,
    see: 1, look: 1, are: 1, was: 1, be: 1, am: 1, should: 1, would: 1, there: 1, page: 1, screen: 1 };

  function tokens(q) {
    return String(q || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
      .filter(function (w) { return w.length > 1 && !STOP[w]; });
  }

  // Deterministic "where do I find X?" matcher. Used by /api/tour/find as the
  // reliable fallback beside the vector search — no model, no embeddings.
  function find(query, opts) {
    opts = opts || {};
    var toks = tokens(query);
    if (!toks.length) return [];
    var pool = (opts.portal ? (portalOf(opts.portal) || { steps: [] }).steps : allSteps()).filter(live);
    var scored = pool.map(function (s) {
      var hayTitle = (s.title || '').toLowerCase();
      var hayTags = (s.tags || []).join(' ').toLowerCase();
      var hayUrl = (s.url || '').toLowerCase();
      var hayBody = ((s.what || '') + ' ' + (s.does || '') + ' ' + (s.gotcha || '')).toLowerCase();
      var score = 0;
      toks.forEach(function (t) {
        if (hayTags.indexOf(t) !== -1) score += 6;
        if (hayTitle.indexOf(t) !== -1) score += 5;
        if (hayUrl.indexOf(t) !== -1) score += 3;
        if (hayBody.indexOf(t) !== -1) score += 1;
      });
      // Longest-contiguous-phrase bonus. Real questions carry filler the stop
      // list never fully removes ("where do I SEE the waiting list"), so score
      // every contiguous n-gram rather than only the whole cleaned query.
      // An EXACT tag equal to an n-gram is the strongest signal there is:
      // without it, "waiting list" ranked the AI waiting-list view (tag
      // 'waiting list ai', which merely contains the words) above the real one.
      var tagList = (s.tags || []).map(function (t) { return String(t).toLowerCase(); });
      var bestPhrase = 0;
      for (var n = toks.length; n >= 2 && !bestPhrase; n--) {
        for (var i0 = 0; i0 + n <= toks.length; i0++) {
          var gram = toks.slice(i0, i0 + n).join(' ');
          if (tagList.indexOf(gram) !== -1) { bestPhrase = 12 + n; break; }
          if (hayTags.indexOf(gram) !== -1) { bestPhrase = 6 + n; break; }
          if (hayTitle.indexOf(gram) !== -1) { bestPhrase = 5 + n; break; }
        }
      }
      score += bestPhrase;
      toks.forEach(function (t) { if (tagList.indexOf(t) !== -1) score += 2; });
      // A tab entry is a more precise answer than its parent section when both
      // match equally — nudge the deeper URL ahead.
      if (s.tab) score += 1;
      return { step: s, score: score };
    }).filter(function (r) { return r.score > 0; });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, opts.limit || 5).map(function (r) {
      return {
        id: r.step.id, portal: r.step.portal, title: r.step.title, url: r.step.url,
        what: r.step.what, does: r.step.does, gotcha: r.step.gotcha,
        status: r.step.status, issue: r.step.issue, score: r.score,
      };
    });
  }

  // Plain-text form of one step — what gets embedded into wren_brain_v1.
  function stepText(s) {
    var p = portalOf(s.portal);
    var lines = [
      (p ? p.label + ' (' + p.subtitle + ')' : s.portal) + ' — ' + s.title,
      'Where: ' + s.url,
      'What this screen is for: ' + strip(s.what),
      'What a manager typically does here: ' + strip(s.does),
      'The one thing people get wrong: ' + strip(s.gotcha),
    ];
    if (s.tags && s.tags.length) lines.push('Also called: ' + s.tags.join(', '));
    if (s.status && s.status !== 'ok') lines.push('KNOWN ISSUE (' + s.status + '): ' + strip(s.issue || ''));
    return lines.join('\n');
  }

  function strip(html) {
    return String(html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  }

  return {
    version: '2026-08-19-b201',
    portals: PORTALS,
    tracks: TRACKS,
    roost: roost, ey: ey, parents: parents, hr: hr,
    allSteps: allSteps, stepsFor: stepsFor, tracksFor: tracksFor, stepById: stepById,
    forUrl: forUrl, find: find, stepText: stepText, normPath: normPath, portalOf: portalOf,
    strip: strip,
  };
});
