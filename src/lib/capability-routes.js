// Capability → route enforcement registry (b237, 2026-08-27)
//
// WHY THIS FILE EXISTS
// `ladn.role_capabilities` holds a well-designed 47-capability × 5-role matrix,
// but before b237 only four route files consulted it. A manager could set a
// capability to "—" for the apprentice role and nothing whatsoever changed,
// because no route read it. The Permissions screen therefore has to be able to
// say, honestly and per capability, "this is enforced on N routes" or "nothing
// reads this yet" — otherwise the screen lies about what it controls.
//
// This registry is that answer. It is hand-maintained: ONE LINE PER GATED ROUTE,
// added at the same time as the requireCapability() call it describes. It is
// served to the UI by GET /api/permissions/enforcement.
//
// It is documentation, NOT the gate. Adding a line here grants nothing and
// blocks nothing — the real enforcement is the middleware in the route file.
// Keeping them in sync is a review discipline, and scripts/b237-permissions-probe.js
// is what actually proves a route is scoped.
//
// level: the minimum level the route demands (view < edit < approve < manage).
//   'view' entries use requireCapability(); anything higher uses
//   requireCapabilityLevel(). See src/lib/capabilities.js.

/** @type {Array<{capability:string, file:string, method:string, path:string, level:string, note?:string}>} */
const GATED_ROUTES = [
  // ── Accidents / incidents ────────────────────────────────────────────────
  // Before b237 incidents.js had ZERO gating on list/read/create/edit-any: an
  // apprentice could read and modify any accident record in the setting.
  { capability: 'accidents.create',   file: 'src/routes/incidents.js', method: 'GET',  path: '/api/incidents',              level: 'view' },
  { capability: 'accidents.create',   file: 'src/routes/incidents.js', method: 'GET',  path: '/api/incidents/:id',          level: 'view' },
  { capability: 'accidents.create',   file: 'src/routes/incidents.js', method: 'POST', path: '/api/incidents',              level: 'edit' },
  { capability: 'accidents.create',   file: 'src/routes/incidents.js', method: 'POST', path: '/api/incidents/upload',       level: 'edit' },
  { capability: 'accidents.edit',     file: 'src/routes/incidents.js', method: 'PUT',  path: '/api/incidents/:id',          level: 'edit' },
  { capability: 'accidents.sign-off', file: 'src/routes/incidents.js', method: 'POST', path: '/api/incidents/:id/sign-off', level: 'approve',
    note: 'manager/deputy_manager role check kept as well — the stricter of the two wins' },

  // ── Observations ─────────────────────────────────────────────────────────
  { capability: 'observations.create',             file: 'src/routes/observations.js', method: 'POST', path: '/api/observations',                   level: 'edit' },
  { capability: 'observations.edit-own',           file: 'src/routes/observations.js', method: 'PUT',  path: '/api/observations/:id',               level: 'edit',
    note: 'own observation only; editing someone else’s needs observations.edit-any' },
  { capability: 'observations.edit-any',           file: 'src/routes/observations.js', method: 'PUT',  path: '/api/observations/:id',               level: 'edit',
    note: 'required when the observation was recorded by another member of staff' },
  { capability: 'observations.edit-any',           file: 'src/routes/observations.js', method: 'DELETE', path: '/api/observations/:id',             level: 'edit' },
  { capability: 'observations.publish-to-parents', file: 'src/routes/observations.js', method: 'POST', path: '/api/observations/:id/review/approve', level: 'approve' },
  { capability: 'observations.publish-to-parents', file: 'src/routes/observations.js', method: 'POST', path: '/api/observations/:id/share',          level: 'edit' },

  // ── The tracker grid (b255, 2026-09-01) ──────────────────────────────────
  // The grid reads every active child's assessment across a whole framework, so
  // it is gated on children.view — which until now nothing read, and the
  // Permissions screen therefore reported as "not enforced yet". Every role in
  // the shipped matrix holds children.view, so gating it changes nobody's access
  // today; what it changes is that revoking it now actually does something.
  { capability: 'children.view', file: 'src/routes/observations.js', method: 'GET', path: '/api/observations/grid-frameworks', level: 'view' },
  { capability: 'children.view', file: 'src/routes/observations.js', method: 'GET', path: '/api/observations/tracker-grid',    level: 'view' },
  { capability: 'children.view', file: 'src/routes/observations.js', method: 'GET', path: '/api/observations/tracker-cell',    level: 'view' },
  // Marking a child N/A for a framework is an arrangement decision, not an
  // assessment — 'edit' keeps it away from a practitioner, who holds
  // children.edit at 'view' only in the shipped matrix.
  { capability: 'children.edit', file: 'src/routes/observations.js', method: 'PUT', path: '/api/observations/framework-optout', level: 'edit',
    note: 'the EyLog-style N/A row — this framework is not used for this child' },

  // ── Children ─────────────────────────────────────────────────────────────
  { capability: 'children.edit',     file: 'src/routes/children.js', method: 'POST', path: '/api/children',                 level: 'edit' },
  { capability: 'children.edit',     file: 'src/routes/children.js', method: 'PUT',  path: '/api/children/:id',             level: 'edit' },
  { capability: 'children.edit',     file: 'src/routes/children.js', method: 'PUT',  path: '/api/children/:id/about-me',    level: 'edit' },
  { capability: 'children.transfer', file: 'src/routes/children.js', method: 'PUT',  path: '/api/children/:id',             level: 'edit',
    note: 'only when the body changes room_id — a room move is a transfer, not an edit' },
  { capability: 'children.archive',  file: 'src/routes/children.js', method: 'GET',  path: '/api/children/inactive',        level: 'view' },
  { capability: 'children.archive',  file: 'src/routes/children.js', method: 'POST', path: '/api/children/:id/reactivate',  level: 'edit' },
  { capability: 'children.archive',  file: 'src/routes/children.js', method: 'PUT',  path: '/api/children/:id',             level: 'edit',
    note: 'only when the body sets is_active=false / enrolment_status=left / a leave_date' },

  // ── Reports ──────────────────────────────────────────────────────────────
  // reports.approve has NO route to gate: reports.js exposes list / read /
  // generate / share only — there is no approval step in the report flow. It is
  // therefore left out of this registry on purpose, so the Permissions screen
  // marks it "not enforced yet" rather than implying a control that isn't there.
  // (POST /skip and POST /send-reply live in reports.js but act on decision_log,
  // the email-triage queue — nothing to do with a child's report. Gating them
  // with reports.* would be a category error, so they stay ungated.)
  { capability: 'reports.write',            file: 'src/routes/reports.js', method: 'POST', path: '/api/reports/generate',   level: 'edit' },
  { capability: 'reports.send-to-parents',  file: 'src/routes/reports.js', method: 'PUT',  path: '/api/reports/:id/share',  level: 'edit' },

  // ── Staff ────────────────────────────────────────────────────────────────
  { capability: 'staff.edit',      file: 'src/routes/staff.js', method: 'PUT',   path: '/api/staff/:id',               level: 'edit' },
  { capability: 'staff.edit',      file: 'src/routes/staff.js', method: 'PUT',   path: '/api/staff/:id/permissions',   level: 'edit' },
  { capability: 'staff.hire',      file: 'src/routes/staff.js', method: 'POST',  path: '/api/staff',                   level: 'edit',
    note: 'manager/deputy_manager requireRole kept as well' },
  { capability: 'staff.hire',      file: 'src/routes/staff.js', method: 'PATCH', path: '/api/staff/:id/reactivate',    level: 'edit' },
  { capability: 'staff.hire',      file: 'src/routes/staff.js', method: 'POST',  path: '/api/staff/:id/reactivate',    level: 'edit' },
  { capability: 'staff.terminate', file: 'src/routes/staff.js', method: 'PATCH', path: '/api/staff/:id/deactivate',    level: 'edit',
    note: 'manager/deputy_manager requireRole kept as well' },

  // ── Door fobs (b250, 2026-09-01) ─────────────────────────────────────────
  // A physical door, so the split is deliberate: any grant lets you SEE the
  // keyring and the reconcile view; only 'manage' lets you write a card to the
  // door station or take one off it. b199 gated these on a hard-coded role set
  // that the matrix could not influence — that set is gone, so these lines are
  // the whole truth about who can issue a fob.
  { capability: 'staff.access-fobs', file: 'src/routes/door.js', method: 'GET',   path: '/api/door/fobs',                    level: 'view' },
  { capability: 'staff.access-fobs', file: 'src/routes/door.js', method: 'GET',   path: '/api/door/fobs/reconcile',          level: 'view' },
  { capability: 'staff.access-fobs', file: 'src/routes/door.js', method: 'GET',   path: '/api/door/fobs/unassigned',         level: 'view' },
  { capability: 'staff.access-fobs', file: 'src/routes/door.js', method: 'GET',   path: '/api/door/device/cards',            level: 'view' },
  { capability: 'staff.access-fobs', file: 'src/routes/door.js', method: 'GET',   path: '/api/door/enrol/state',             level: 'view' },
  { capability: 'staff.access-fobs', file: 'src/routes/door.js', method: 'POST',  path: '/api/door/fobs',                    level: 'manage',
    note: 'writes a card to the door station — read back and verified before the fob is marked active' },
  { capability: 'staff.access-fobs', file: 'src/routes/door.js', method: 'PATCH', path: '/api/door/fobs/:id',                level: 'manage' },
  { capability: 'staff.access-fobs', file: 'src/routes/door.js', method: 'POST',  path: '/api/door/fobs/:id/deactivate',     level: 'manage',
    note: 'removes the card from the door station and confirms it is gone before Wren marks it revoked' },
  { capability: 'staff.access-fobs', file: 'src/routes/door.js', method: 'POST',  path: '/api/door/fobs/:id/retry-removal',  level: 'manage' },
  { capability: 'staff.access-fobs', file: 'src/routes/door.js', method: 'POST',  path: '/api/door/fobs/:id/replace',        level: 'manage' },
  { capability: 'staff.access-fobs', file: 'src/routes/door.js', method: 'POST',  path: '/api/door/enrol/arm',               level: 'manage' },
  { capability: 'staff.access-fobs', file: 'src/routes/door.js', method: 'POST',  path: '/api/door/enrol/disarm',            level: 'manage' },

  // ── Daily diary ──────────────────────────────────────────────────────────
  { capability: 'daily-diary.create',   file: 'src/routes/diary.js', method: 'POST',   path: '/api/diary',              level: 'edit' },
  { capability: 'daily-diary.create',   file: 'src/routes/diary.js', method: 'POST',   path: '/api/diary/entries',      level: 'edit' },
  { capability: 'daily-diary.create',   file: 'src/routes/diary.js', method: 'POST',   path: '/api/diary/group',        level: 'edit' },
  { capability: 'daily-diary.edit-own', file: 'src/routes/diary.js', method: 'PUT',    path: '/api/diary/:id',          level: 'edit' },
  { capability: 'daily-diary.edit-own', file: 'src/routes/diary.js', method: 'PATCH',  path: '/api/diary/entries/:id',  level: 'edit',
    note: 'own entry only; another practitioner’s entry needs daily-diary.edit-any' },
  { capability: 'daily-diary.edit-any', file: 'src/routes/diary.js', method: 'PATCH',  path: '/api/diary/entries/:id',  level: 'edit',
    note: 'required when the entry was recorded by another member of staff' },
  { capability: 'daily-diary.edit-any', file: 'src/routes/diary.js', method: 'DELETE', path: '/api/diary/entries/:id',  level: 'edit' },
  { capability: 'daily-diary.edit-any', file: 'src/routes/diary.js', method: 'POST',   path: '/api/diary/publish-today', level: 'edit' },

  // ── Admissions ───────────────────────────────────────────────────────────
  // src/routes/admissions-engine.js is already blanket managerOnly, so the
  // admissions.* keys land on enquiries.js — the pipeline staff actually work in.
  { capability: 'admissions.enquire', file: 'src/routes/enquiries.js', method: 'GET',    path: '/api/enquiries',                            level: 'view' },
  { capability: 'admissions.enquire', file: 'src/routes/enquiries.js', method: 'POST',   path: '/api/enquiries',                            level: 'edit' },
  { capability: 'admissions.enquire', file: 'src/routes/enquiries.js', method: 'PUT',    path: '/api/enquiries/:id',                        level: 'edit' },
  { capability: 'admissions.enquire', file: 'src/routes/enquiries.js', method: 'DELETE', path: '/api/enquiries/:id',                        level: 'edit' },
  { capability: 'admissions.tour',    file: 'src/routes/enquiries.js', method: 'POST',   path: '/api/enquiries/:id/move',                   level: 'edit',
    note: 'moving an enquiry to the tour stage' },
  { capability: 'admissions.offer',   file: 'src/routes/enquiries.js', method: 'POST',   path: '/api/enquiries/:id/convert-to-waiting-list', level: 'approve' },
  { capability: 'admissions.offer',   file: 'src/routes/enquiries.js', method: 'POST',   path: '/api/enquiries/waiting-list',                level: 'edit' },
  { capability: 'admissions.accept',  file: 'src/routes/enquiries.js', method: 'POST',   path: '/api/enquiries/waiting-list/:id/convert-to-child', level: 'approve' },

  // ── The SEN toolkit (b256, 2026-09-01) ───────────────────────────────────
  // READING the toolkit is deliberately NOT gated on a capability — it is a
  // library of generic practice content with no child data in it, and the whole
  // point is that the practitioner who is worried at 9am can open it. Only
  // CURATING it is gated, at 'manage', so a practitioner cannot quietly edit
  // what the setting says its own approved practice is.
  { capability: 'sen.toolkit', file: 'src/routes/sen-toolkit.js', method: 'POST',  path: '/api/sen-toolkit',             level: 'manage' },
  { capability: 'sen.toolkit', file: 'src/routes/sen-toolkit.js', method: 'PUT',   path: '/api/sen-toolkit/:id',         level: 'manage' },
  { capability: 'sen.toolkit', file: 'src/routes/sen-toolkit.js', method: 'PATCH', path: '/api/sen-toolkit/:id/active',  level: 'manage',
    note: 'retire / restore an entry — never a DELETE, because a retired strategy may still be attached to a live plan' },
  { capability: 'sen.toolkit', file: 'src/routes/sen-toolkit.js', method: 'GET',   path: '/api/sen-toolkit/admin/usage', level: 'manage',
    note: 'the Roost manager view — counts only, never a child id or name' },
  { capability: 'sen.toolkit', file: 'src/routes/sen-toolkit.js', method: 'GET',   path: '/api/sen-toolkit?include_retired=true', level: 'manage',
    note: 'listing retired entries; the unfiltered list is open to any signed-in staff member' },

  // ── Already enforced before b237 (kept here so the screen tells the truth) ─
  { capability: 'medicine_record',      file: 'src/routes/medicine.js',    method: '*',    path: '/api/medicine/*',        level: 'view',
    note: 'pre-b237 — the original per-staff capability gate (2026-06-06)' },
  { capability: 'medicine_signoff',     file: 'src/routes/medicine.js',    method: 'POST', path: '/api/medicine/*/sign-off', level: 'view',
    note: 'pre-b237' },
  { capability: 'kitchen.access',       file: 'src/routes/kitchen.js',     method: '*',    path: '/api/kitchen/*',         level: 'view',
    note: 'pre-b237' },
  { capability: 'view_staff_salaries',  file: 'src/routes/staff.js',       method: '*',    path: '/api/staff (salary fields)', level: 'view',
    note: 'pre-b237 — requireSalaryView + stripSalaryFields (PROMPT 35)' },
  { capability: 'medicine_record',      file: 'src/routes/children.js',    method: 'GET',  path: '/api/children/:id/timeline', level: 'view',
    note: 'pre-b237 — medicine events are filtered out of the timeline without it' },

  // ── Fee modeller sandbox (b270, 2026-09-02) ──────────────────────
  // Next year's rate card and the revenue it produces. Commercially sensitive, so
  // 'finance.view' to read and 'finance.edit' to change a scenario — the same split
  // the rest of Finance uses. A manager/deputy role check runs first in the route
  // file as well; the stricter of the two wins. These write ONLY to fee_scenarios*,
  // never to fee_items, so no capability here can change a live fee.
  { capability: 'finance.view', file: 'src/routes/fee-sandbox.js', method: 'GET',  path: '/api/fee-sandbox/meta',                     level: 'view' },
  { capability: 'finance.view', file: 'src/routes/fee-sandbox.js', method: 'GET',  path: '/api/fee-sandbox/scenarios',                level: 'view' },
  { capability: 'finance.view', file: 'src/routes/fee-sandbox.js', method: 'GET',  path: '/api/fee-sandbox/scenarios/:id',            level: 'view' },
  { capability: 'finance.view', file: 'src/routes/fee-sandbox.js', method: 'POST', path: '/api/fee-sandbox/simulate',                 level: 'view',
    note: 'prices the real cohort against a rate set — reads children/bookings/funding, returns counts and aggregates only' },
  { capability: 'finance.view', file: 'src/routes/fee-sandbox.js', method: 'POST', path: '/api/fee-sandbox/compare',                  level: 'view' },
  { capability: 'finance.view', file: 'src/routes/fee-sandbox.js', method: 'GET',  path: '/api/fee-sandbox/scenarios/:id/export.csv', level: 'view' },
  { capability: 'finance.view', file: 'src/routes/fee-sandbox.js', method: 'GET',  path: '/api/fee-sandbox/scenarios/:id/board-paper', level: 'view' },
  { capability: 'finance.edit', file: 'src/routes/fee-sandbox.js', method: 'POST', path: '/api/fee-sandbox/scenarios',                level: 'edit' },
  { capability: 'finance.edit', file: 'src/routes/fee-sandbox.js', method: 'POST', path: '/api/fee-sandbox/scenarios/seed-baseline',  level: 'edit' },
  { capability: 'finance.edit', file: 'src/routes/fee-sandbox.js', method: 'PUT',  path: '/api/fee-sandbox/scenarios/:id',            level: 'edit' },
  { capability: 'finance.edit', file: 'src/routes/fee-sandbox.js', method: 'DELETE', path: '/api/fee-sandbox/scenarios/:id',          level: 'edit' },

  // ── The paperwork store (b269, 2026-09-02) ───────────────────────────────
  // TEN capabilities, one per top-level heading of the filing cabinet, because
  // the whole point is that "who may open the DBS drawer" is a line on the
  // Permissions screen rather than a hard-coded role list.
  //
  // Why NOT reuse the keys that were already there: staff.view is granted to
  // PRACTITIONER at level 'edit' and safeguarding.view-all at 'view' in the
  // shipped matrix, so filing DBS certificates behind staff.view would have
  // handed every practitioner the staff vetting folder — the exact outcome b269
  // forbids. New keys, granted deliberately in the migration, is the honest answer.
  //
  // The enforcement is NOT one requireCapability() per route: the routes below
  // are all multi-category (a search spans every heading the caller may read),
  // so src/routes/paperwork.js resolves capabilityLevel() PER DOCUMENT via
  // readableCategories() / canWriteCategory(). The lines here therefore describe
  // a per-row filter rather than an all-or-nothing gate — noted on each, so the
  // Permissions screen does not overstate what it controls.
  //
  // 'view' reads; 'edit' is needed to change what a document IS (accept, re-file,
  // delete, confirm a receipt) — deliberately level-aware, because hasCapability()
  // ignores level and a bare 'view' grant would otherwise open every write path.
  { capability: 'paperwork.safeguarding',      file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/search',      level: 'view',
    note: 'per-row: results are filtered to the headings the caller holds — a practitioner never sees a "Safeguarding & child protection" hit they may not read' },
  { capability: 'paperwork.safeguarding',      file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/:id',         level: 'view',
    note: 'per-row: 403 unless the caller holds the heading the document is filed under' },
  { capability: 'paperwork.safeguarding',      file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/:id/file',    level: 'view' },
  { capability: 'paperwork.safeguarding',      file: 'src/routes/paperwork.js', method: 'POST',   path: '/api/paperwork/:id/accept',  level: 'edit',
    note: 'needs edit on the heading it is going TO and, on a re-file, the heading it is leaving' },
  { capability: 'paperwork.safeguarding',      file: 'src/routes/paperwork.js', method: 'PATCH',  path: '/api/paperwork/:id',         level: 'edit' },
  { capability: 'paperwork.safeguarding',      file: 'src/routes/paperwork.js', method: 'DELETE', path: '/api/paperwork/:id',         level: 'edit' },
  { capability: 'paperwork.staff-suitability', file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/search',      level: 'view',
    note: 'per-row: results are filtered to the headings the caller holds — a practitioner never sees a "Staff suitability & training" hit they may not read' },
  { capability: 'paperwork.staff-suitability', file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/:id',         level: 'view',
    note: 'per-row: 403 unless the caller holds the heading the document is filed under' },
  { capability: 'paperwork.staff-suitability', file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/:id/file',    level: 'view' },
  { capability: 'paperwork.staff-suitability', file: 'src/routes/paperwork.js', method: 'POST',   path: '/api/paperwork/:id/accept',  level: 'edit',
    note: 'needs edit on the heading it is going TO and, on a re-file, the heading it is leaving' },
  { capability: 'paperwork.staff-suitability', file: 'src/routes/paperwork.js', method: 'PATCH',  path: '/api/paperwork/:id',         level: 'edit' },
  { capability: 'paperwork.staff-suitability', file: 'src/routes/paperwork.js', method: 'DELETE', path: '/api/paperwork/:id',         level: 'edit' },
  { capability: 'paperwork.childrens-records', file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/search',      level: 'view',
    note: 'per-row: results are filtered to the headings the caller holds — a practitioner never sees a "Children\u2019s records" hit they may not read' },
  { capability: 'paperwork.childrens-records', file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/:id',         level: 'view',
    note: 'per-row: 403 unless the caller holds the heading the document is filed under' },
  { capability: 'paperwork.childrens-records', file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/:id/file',    level: 'view' },
  { capability: 'paperwork.childrens-records', file: 'src/routes/paperwork.js', method: 'POST',   path: '/api/paperwork/:id/accept',  level: 'edit',
    note: 'needs edit on the heading it is going TO and, on a re-file, the heading it is leaving' },
  { capability: 'paperwork.childrens-records', file: 'src/routes/paperwork.js', method: 'PATCH',  path: '/api/paperwork/:id',         level: 'edit' },
  { capability: 'paperwork.childrens-records', file: 'src/routes/paperwork.js', method: 'DELETE', path: '/api/paperwork/:id',         level: 'edit' },
  { capability: 'paperwork.health-safety',     file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/search',      level: 'view',
    note: 'per-row: results are filtered to the headings the caller holds — a practitioner never sees a "Health, safety & premises" hit they may not read' },
  { capability: 'paperwork.health-safety',     file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/:id',         level: 'view',
    note: 'per-row: 403 unless the caller holds the heading the document is filed under' },
  { capability: 'paperwork.health-safety',     file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/:id/file',    level: 'view' },
  { capability: 'paperwork.health-safety',     file: 'src/routes/paperwork.js', method: 'POST',   path: '/api/paperwork/:id/accept',  level: 'edit',
    note: 'needs edit on the heading it is going TO and, on a re-file, the heading it is leaving' },
  { capability: 'paperwork.health-safety',     file: 'src/routes/paperwork.js', method: 'PATCH',  path: '/api/paperwork/:id',         level: 'edit' },
  { capability: 'paperwork.health-safety',     file: 'src/routes/paperwork.js', method: 'DELETE', path: '/api/paperwork/:id',         level: 'edit' },
  { capability: 'paperwork.policies',          file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/search',      level: 'view',
    note: 'per-row: results are filtered to the headings the caller holds — a practitioner never sees a "Policies & procedures" hit they may not read' },
  { capability: 'paperwork.policies',          file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/:id',         level: 'view',
    note: 'per-row: 403 unless the caller holds the heading the document is filed under' },
  { capability: 'paperwork.policies',          file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/:id/file',    level: 'view' },
  { capability: 'paperwork.policies',          file: 'src/routes/paperwork.js', method: 'POST',   path: '/api/paperwork/:id/accept',  level: 'edit',
    note: 'needs edit on the heading it is going TO and, on a re-file, the heading it is leaving' },
  { capability: 'paperwork.policies',          file: 'src/routes/paperwork.js', method: 'PATCH',  path: '/api/paperwork/:id',         level: 'edit' },
  { capability: 'paperwork.policies',          file: 'src/routes/paperwork.js', method: 'DELETE', path: '/api/paperwork/:id',         level: 'edit' },
  { capability: 'paperwork.curriculum',        file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/search',      level: 'view',
    note: 'per-row: results are filtered to the headings the caller holds — a practitioner never sees a "Curriculum & planning" hit they may not read' },
  { capability: 'paperwork.curriculum',        file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/:id',         level: 'view',
    note: 'per-row: 403 unless the caller holds the heading the document is filed under' },
  { capability: 'paperwork.curriculum',        file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/:id/file',    level: 'view' },
  { capability: 'paperwork.curriculum',        file: 'src/routes/paperwork.js', method: 'POST',   path: '/api/paperwork/:id/accept',  level: 'edit',
    note: 'needs edit on the heading it is going TO and, on a re-file, the heading it is leaving' },
  { capability: 'paperwork.curriculum',        file: 'src/routes/paperwork.js', method: 'PATCH',  path: '/api/paperwork/:id',         level: 'edit' },
  { capability: 'paperwork.curriculum',        file: 'src/routes/paperwork.js', method: 'DELETE', path: '/api/paperwork/:id',         level: 'edit' },
  { capability: 'paperwork.parent-communication',file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/search',      level: 'view',
    note: 'per-row: results are filtered to the headings the caller holds — a practitioner never sees a "Parent communication" hit they may not read' },
  { capability: 'paperwork.parent-communication',file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/:id',         level: 'view',
    note: 'per-row: 403 unless the caller holds the heading the document is filed under' },
  { capability: 'paperwork.parent-communication',file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/:id/file',    level: 'view' },
  { capability: 'paperwork.parent-communication',file: 'src/routes/paperwork.js', method: 'POST',   path: '/api/paperwork/:id/accept',  level: 'edit',
    note: 'needs edit on the heading it is going TO and, on a re-file, the heading it is leaving' },
  { capability: 'paperwork.parent-communication',file: 'src/routes/paperwork.js', method: 'PATCH',  path: '/api/paperwork/:id',         level: 'edit' },
  { capability: 'paperwork.parent-communication',file: 'src/routes/paperwork.js', method: 'DELETE', path: '/api/paperwork/:id',         level: 'edit' },
  { capability: 'paperwork.legal-business',    file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/search',      level: 'view',
    note: 'per-row: results are filtered to the headings the caller holds — a practitioner never sees a "Legal & business" hit they may not read' },
  { capability: 'paperwork.legal-business',    file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/:id',         level: 'view',
    note: 'per-row: 403 unless the caller holds the heading the document is filed under' },
  { capability: 'paperwork.legal-business',    file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/:id/file',    level: 'view' },
  { capability: 'paperwork.legal-business',    file: 'src/routes/paperwork.js', method: 'POST',   path: '/api/paperwork/:id/accept',  level: 'edit',
    note: 'needs edit on the heading it is going TO and, on a re-file, the heading it is leaving' },
  { capability: 'paperwork.legal-business',    file: 'src/routes/paperwork.js', method: 'PATCH',  path: '/api/paperwork/:id',         level: 'edit' },
  { capability: 'paperwork.legal-business',    file: 'src/routes/paperwork.js', method: 'DELETE', path: '/api/paperwork/:id',         level: 'edit' },
  { capability: 'paperwork.finance',           file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/search',      level: 'view',
    note: 'per-row: results are filtered to the headings the caller holds — a practitioner never sees a "Finance & receipts" hit they may not read' },
  { capability: 'paperwork.finance',           file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/:id',         level: 'view',
    note: 'per-row: 403 unless the caller holds the heading the document is filed under' },
  { capability: 'paperwork.finance',           file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/:id/file',    level: 'view' },
  { capability: 'paperwork.finance',           file: 'src/routes/paperwork.js', method: 'POST',   path: '/api/paperwork/:id/accept',  level: 'edit',
    note: 'needs edit on the heading it is going TO and, on a re-file, the heading it is leaving' },
  { capability: 'paperwork.finance',           file: 'src/routes/paperwork.js', method: 'PATCH',  path: '/api/paperwork/:id',         level: 'edit' },
  { capability: 'paperwork.finance',           file: 'src/routes/paperwork.js', method: 'DELETE', path: '/api/paperwork/:id',         level: 'edit' },
  { capability: 'paperwork.external-guidance', file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/search',      level: 'view',
    note: 'per-row: results are filtered to the headings the caller holds — a practitioner never sees a "External guidance" hit they may not read' },
  { capability: 'paperwork.external-guidance', file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/:id',         level: 'view',
    note: 'per-row: 403 unless the caller holds the heading the document is filed under' },
  { capability: 'paperwork.external-guidance', file: 'src/routes/paperwork.js', method: 'GET',    path: '/api/paperwork/:id/file',    level: 'view' },
  { capability: 'paperwork.external-guidance', file: 'src/routes/paperwork.js', method: 'POST',   path: '/api/paperwork/:id/accept',  level: 'edit',
    note: 'needs edit on the heading it is going TO and, on a re-file, the heading it is leaving' },
  { capability: 'paperwork.external-guidance', file: 'src/routes/paperwork.js', method: 'PATCH',  path: '/api/paperwork/:id',         level: 'edit' },
  { capability: 'paperwork.external-guidance', file: 'src/routes/paperwork.js', method: 'DELETE', path: '/api/paperwork/:id',         level: 'edit' },
  // Upload is not per-category (nothing knows the category until the pipeline has
  // read the file), so it demands 'edit' on ANY heading — canFileAtAll(). Recorded
  // against paperwork.policies as the representative key so the count is not
  // multiplied ten-fold across headings that had no say in it.
  { capability: 'paperwork.policies',     file: 'src/routes/paperwork.js', method: 'POST',  path: '/api/paperwork/upload',      level: 'edit',
    note: 'requires edit on at least ONE heading; the EY portal is refused outright (read-only there)' },
  { capability: 'paperwork.policies',     file: 'src/routes/paperwork.js', method: 'GET',   path: '/api/paperwork/review',      level: 'edit' },
  { capability: 'paperwork.policies',     file: 'src/routes/paperwork.js', method: 'POST',  path: '/api/paperwork/accept-bulk', level: 'edit',
    note: 'each id is checked on its own — a bulk accept files the ones the caller may file and rejects the rest' },
  { capability: 'paperwork.finance',      file: 'src/routes/paperwork.js', method: 'GET',   path: '/api/paperwork/receipts',    level: 'view' },
  { capability: 'paperwork.finance',      file: 'src/routes/paperwork.js', method: 'PUT',   path: '/api/paperwork/:id/receipt', level: 'edit' },
  { capability: 'paperwork.finance',      file: 'src/routes/paperwork.js', method: 'POST',  path: '/api/paperwork/:id/receipt/attach', level: 'edit' },

  // ── Email routing rules (b279, 2026-09-04) ───────────────────────────────
  // A rule can forward mail off-site, archive it in Gmail and file attachments
  // into the paperwork store, so writing one is 'manage' and reading the list
  // is 'view'. Only roles.key 'manager' and 'deputy' hold the capability at all
  // (see migrations/2026-09-04-b279-email-rules.sql).
  { capability: 'comms.email-rules', file: 'src/routes/email-rules.js', method: 'GET',    path: '/api/email-rules',                 level: 'view' },
  { capability: 'comms.email-rules', file: 'src/routes/email-rules.js', method: 'GET',    path: '/api/email-rules/meta',            level: 'view' },
  { capability: 'comms.email-rules', file: 'src/routes/email-rules.js', method: 'GET',    path: '/api/email-rules/health',          level: 'view' },
  { capability: 'comms.email-rules', file: 'src/routes/email-rules.js', method: 'GET',    path: '/api/email-rules/:id',             level: 'view' },
  { capability: 'comms.email-rules', file: 'src/routes/email-rules.js', method: 'GET',    path: '/api/email-rules/:id/runs',        level: 'view' },
  { capability: 'comms.email-rules', file: 'src/routes/email-rules.js', method: 'GET',    path: '/api/email-rules/activity/recent', level: 'view' },
  { capability: 'comms.email-rules', file: 'src/routes/email-rules.js', method: 'POST',   path: '/api/email-rules',                 level: 'manage' },
  { capability: 'comms.email-rules', file: 'src/routes/email-rules.js', method: 'PUT',    path: '/api/email-rules/:id',             level: 'manage' },
  { capability: 'comms.email-rules', file: 'src/routes/email-rules.js', method: 'PATCH',  path: '/api/email-rules/:id/enabled',     level: 'manage' },
  { capability: 'comms.email-rules', file: 'src/routes/email-rules.js', method: 'PUT',    path: '/api/email-rules/order',           level: 'manage' },
  { capability: 'comms.email-rules', file: 'src/routes/email-rules.js', method: 'DELETE', path: '/api/email-rules/:id',             level: 'manage' },
  { capability: 'comms.email-rules', file: 'src/routes/email-rules.js', method: 'POST',   path: '/api/email-rules/test',            level: 'manage',
    note: 'a test evaluates but never runs an action, and never writes a run row — it must not look like a live firing' },

  // ── The Security hub (b505, 2026-10-18) ──────────────────────────────────
  // ONE LINE PER GATED ROUTE, same discipline as everything above. These are
  // documentation; the gates are the middleware in the two route files.
  //
  // The camera and recording lines are IN ADDITION TO cameras.js's existing
  // manager-role + Roost-portal check and the opening-hours rule, never instead
  // of them: revoking one of these takes footage away, granting it gives nobody
  // anything they could not already reach. They are refused through
  // auditedCapability(), so a refusal lands in ladn.camera_access_log with
  // granted = false, like every other refusal on that router.
  //
  // src/lib/capabilities.js MATRIX_REQUIRED_CAPS is what makes the three
  // security.* footage/building keys answer the matrix at all for a floor
  // manager — without it these lines would describe a gate that cannot say no.
  { capability: 'security.hub-view',          file: 'src/routes/security-hub.js', method: 'GET',    path: '/api/security-hub/overview',       level: 'view' },
  { capability: 'security.hub-view',          file: 'src/routes/security-hub.js', method: 'GET',    path: '/api/security-hub/timeline',       level: 'view' },
  { capability: 'security.hub-view',          file: 'src/routes/security-hub.js', method: 'GET',    path: '/api/security-hub/anomalies',      level: 'view' },
  { capability: 'security.hub-view',          file: 'src/routes/security-hub.js', method: 'GET',    path: '/api/security-hub/alarm',          level: 'view' },
  { capability: 'security.hub-view',          file: 'src/routes/security-hub.js', method: 'GET',    path: '/api/security-hub/reader-health',  level: 'view' },
  { capability: 'security.hub-view',          file: 'src/routes/security-hub.js', method: 'GET',    path: '/api/security-hub/ha/summary',     level: 'view' },
  { capability: 'security.hub-view',          file: 'src/routes/security-hub.js', method: 'GET',    path: '/api/security-hub/ha/entities',    level: 'view' },
  { capability: 'security.hub-view',          file: 'src/routes/security-hub.js', method: 'POST',   path: '/api/security-hub/alarm/arm',      level: 'view',
    note: 'arming out-of-hours alerting is a manager action on a manager-only page; the capability that matters is reaching the page at all' },
  { capability: 'security.hub-view',          file: 'src/routes/security-hub.js', method: 'POST',   path: '/api/security-hub/alarm/test',     level: 'view' },
  { capability: 'security.hub-view',          file: 'src/routes/security-hub.js', method: 'POST',   path: '/api/security-hub/alarm/sweep',    level: 'view' },
  { capability: 'security.hub-view',          file: 'src/routes/security-hub.js', method: 'POST',   path: '/api/security-hub/alerts/:id/ack',    level: 'view' },
  { capability: 'security.hub-view',          file: 'src/routes/security-hub.js', method: 'POST',   path: '/api/security-hub/alerts/:id/snooze',  level: 'view' },

  { capability: 'security.cameras-view',      file: 'src/routes/cameras.js',      method: 'POST',   path: '/api/cameras/:id/session',          level: 'view',
    note: 'live view. Composed with auditedManagerAdminOnly AND the internal/out-of-hours time rule — all three must pass' },

  { capability: 'security.recordings-view',   file: 'src/routes/cameras.js',      method: 'GET',    path: '/api/cameras/:id/recordings/summary', level: 'view' },
  { capability: 'security.recordings-view',   file: 'src/routes/cameras.js',      method: 'GET',    path: '/api/cameras/:id/recordings',        level: 'view' },
  { capability: 'security.recordings-view',   file: 'src/routes/cameras.js',      method: 'POST',   path: '/api/cameras/:id/recordings/session', level: 'view',
    note: 'playback. Still needs a CCTV Policy §3 trigger and a window of 30 minutes or less — the capability does not relax either' },

  { capability: 'security.building-control',  file: 'src/routes/security-hub.js', method: 'POST',   path: '/api/security-hub/ha/climate',      level: 'view',
    note: 'the entity must also be on the ha_entities allow-list WHERE enabled = true; a client-supplied entity id never reaches callService' },
  { capability: 'security.building-control',  file: 'src/routes/security-hub.js', method: 'POST',   path: '/api/security-hub/ha/switch',       level: 'view',
    note: 'light.* and switch.* only. Locks, alarms and sirens are out of scope — the ha_entities kind check permits neither' },
  { capability: 'security.building-control',  file: 'src/routes/security-hub.js', method: 'POST',   path: '/api/security-hub/ha/entities',     level: 'view' },
  { capability: 'security.building-control',  file: 'src/routes/security-hub.js', method: 'DELETE', path: '/api/security-hub/ha/entities/:id', level: 'view' },
  { capability: 'security.building-control',  file: 'src/routes/security-hub.js', method: 'GET',    path: '/api/security-hub/ha/discover',     level: 'view' },

  // ── b511 (2026-10-19) — Building & devices ────────────────────────────────
  // Also in MATRIX_REQUIRED_CAPS, and for a sharper reason than the b505 three:
  // the people this page is FOR (the office manager and the admissions lead, the office managers) are not
  // managers in staff.role at all, so a grant to them is the ONLY way they ever
  // reach it. Note there is no role gate on this router — the capability IS the
  // gate. Removing a device is the single exception and adds a manager check in
  // the handler, which is why its line below says so.
  { capability: 'building.devices.view',      file: 'src/routes/building-devices.js', method: 'GET',  path: '/api/building-devices/overview',       level: 'view' },
  { capability: 'building.devices.view',      file: 'src/routes/building-devices.js', method: 'GET',  path: '/api/building-devices/devices',        level: 'view' },
  { capability: 'building.devices.view',      file: 'src/routes/building-devices.js', method: 'GET',  path: '/api/building-devices/device/:ieee',   level: 'view' },
  { capability: 'building.devices.view',      file: 'src/routes/building-devices.js', method: 'GET',  path: '/api/building-devices/catalog',        level: 'view' },
  { capability: 'building.devices.view',      file: 'src/routes/building-devices.js', method: 'GET',  path: '/api/building-devices/recovery',       level: 'view' },
  { capability: 'building.devices.view',      file: 'src/routes/building-devices.js', method: 'GET',  path: '/api/building-devices/join/status',    level: 'view' },
  { capability: 'building.devices.view',      file: 'src/routes/building-devices.js', method: 'GET',  path: '/api/building-devices/radiators',      level: 'view' },
  { capability: 'building.devices.view',      file: 'src/routes/building-devices.js', method: 'GET',  path: '/api/building-devices/kitchen-check',  level: 'view' },

  { capability: 'building.devices.manage',    file: 'src/routes/building-devices.js', method: 'POST', path: '/api/building-devices/join/open',      level: 'view',
    note: 'opens the Zigbee network for ~2 minutes. z2m closes it itself; the page closes it too. Audited, plus a zigbee_join_sessions row.' },
  { capability: 'building.devices.manage',    file: 'src/routes/building-devices.js', method: 'POST', path: '/api/building-devices/join/close',     level: 'view' },
  { capability: 'building.devices.manage',    file: 'src/routes/building-devices.js', method: 'POST', path: '/api/building-devices/device/:ieee/rename', level: 'view',
    note: 'rename and/or move to another room. The room is an HA area; the name is validated before it becomes an MQTT topic segment.' },
  { capability: 'building.devices.manage',    file: 'src/routes/building-devices.js', method: 'POST', path: '/api/building-devices/device/:ieee/remove', level: 'view',
    note: 'ALSO requires the manager role in the handler, AND the device name typed back as a confirm. The only destructive action here.' },
  { capability: 'building.devices.manage',    file: 'src/routes/building-devices.js', method: 'POST', path: '/api/building-devices/radiators/temperature', level: 'view',
    note: '5-28C, the same clamp as /api/security-hub/ha/climate. The allow-list is DERIVED from HA\'s registry (Better Thermostat or z2m), not typed.' },
  { capability: 'building.devices.manage',    file: 'src/routes/building-devices.js', method: 'POST', path: '/api/building-devices/recovery/:ieee/retire', level: 'view' },

  // ── nest-building (2026-11-02): Building on Nest, leadership tier ─────────
  // EY portal only. Every write ALSO requires building.view. Both keys are in
  // MATRIX_REQUIRED_CAPS, so a floor manager answers the matrix too.
  { capability: 'building.view',   file: 'src/routes/nest-building.js', method: 'GET',  path: '/api/nest-building/summary',          level: 'view' },
  { capability: 'building.view',   file: 'src/routes/nest-building.js', method: 'GET',  path: '/api/nest-building/join/status',      level: 'view' },
  { capability: 'building.manage', file: 'src/routes/nest-building.js', method: 'POST', path: '/api/nest-building/radiator',         level: 'view',
    note: '5-24C, half-degree steps. Allow-list DERIVED from HA\'s registry (controllableClimate), as on Roost.' },
  { capability: 'building.manage', file: 'src/routes/nest-building.js', method: 'POST', path: '/api/nest-building/boiler',           level: 'view',
    note: '5-24C. Entity fixed server-side (climate.thermostat_2, Hive).' },
  { capability: 'building.manage', file: 'src/routes/nest-building.js', method: 'POST', path: '/api/nest-building/boiler/boost',     level: 'view',
    note: '30/60/120 min only, 5-24C (default 22).' },
  { capability: 'building.manage', file: 'src/routes/nest-building.js', method: 'POST', path: '/api/nest-building/boiler/boost/off', level: 'view' },
  { capability: 'building.manage', file: 'src/routes/nest-building.js', method: 'POST', path: '/api/nest-building/join/open',        level: 'view',
    note: 'Opens Zigbee pairing (10-254 s, default 120); same zigbee_join_sessions record as Roost.' },
  { capability: 'building.manage', file: 'src/routes/nest-building.js', method: 'POST', path: '/api/nest-building/join/close',       level: 'view' },
];

/**
 * Count of gated routes per capability key.
 * A key absent from this map is NOT enforced anywhere — the Permissions screen
 * shows those as "not enforced yet", which is the honest thing to show.
 * @returns {Record<string, number>}
 */
function enforcementCounts() {
  const counts = {};
  for (const r of GATED_ROUTES) counts[r.capability] = (counts[r.capability] || 0) + 1;
  return counts;
}

/** Every registry line for one capability key. */
function routesFor(capKey) {
  return GATED_ROUTES.filter(r => r.capability === capKey);
}

module.exports = { GATED_ROUTES, enforcementCounts, routesFor };
