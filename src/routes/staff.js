const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getPool } = require('../db/pool');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const authenticate = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { canViewSalaries, stripSalaryFields,
        requireCapabilityLevel, capabilityLevel, CAPABILITY_LEVELS: LEVELS } = require('../lib/capabilities');
// b303 — HMRC starter-checklist wording and the derived payroll block. Held in
// one place so the tokened form, this route and the Roost card agree.
const hmrcStarter = require('../lib/hmrc-starter');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

// b272 (2026-09-04) — the owner account. ladn.staff id=1 (Toby) is the one row
// whose pin_hash this router must never write: CLAUDE.md ABSOLUTE RULE 1, and
// ladn.protected_staff_pins holds the authoritative copy of it. Nothing in this
// file reads, writes or exposes that table.
const PROTECTED_STAFF_ID = 1;

// Who may administer somebody else's PIN. Same list the rest of this file uses
// for staff administration; b271 left both spellings in play (staff.role
// 'manager' is the floor manager, 'admin' the owner) so both are named.
const PIN_ADMIN_ROLES = ['manager', 'deputy_manager', 'admin'];

router.use(authenticate);

// login-20261023 — a staff record changing (new starter, leaver, email edit, reactivation) can change
// who Cloudflare should let into HR and Roost. One hook for every write below rather than a call in
// each handler: after a successful write, push the staff lists (debounced, LADN production only).
router.use((req, res, next) => {
  if (req.method === 'GET' || /\/(set-pin|pin|photo)$/.test(req.path)) return next();
  res.on('finish', () => {
    if (res.statusCode < 300) {
      try { require('../lib/cf-allowlist').scheduleStaffSync(); } catch (_) { /* best effort */ }
    }
  });
  next();
});

// GET / — all active staff (?include_inactive=1 also returns deactivated staff,
// manager/deputy only — needed so the HR staff page can offer Reactivate).
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const includeInactive = ['1','true','yes'].includes(String(req.query.include_inactive || '').toLowerCase())
      && hasRole(req.user, ['manager','deputy_manager', 'admin']);
    const { rows } = await db.query(`
      SELECT s.id, s.first_name, s.last_name, s.preferred_name, s.email, s.phone,
             s.role, s.room_id, s.employment_type, s.contracted_hours, s.is_active,
             s.dbs_expiry, s.contract_start, s.profile_photo, s.can_publish,
             s.pin_length, (s.pin_hash IS NOT NULL) AS has_pin,
             COALESCE(s.is_demo, false) AS is_demo,
             s.qualification_level, s.census_fr_level, s.census_qts, s.census_eyps, s.census_eyts,
             s.census_senco_l3, s.is_volunteer, s.census_works_with_under5, s.census_managerial,
             r.name as room_name
      FROM staff s
      LEFT JOIN rooms r ON r.id = s.room_id
      ${includeInactive ? '' : 'WHERE s.is_active=true'}
      ORDER BY s.first_name
    `);
    // login-20261023: the list is used by rota/room pickers for every role; employment details are
    // manager-only (Toby's tiers: leadership, team and apprentices do not see staff records).
    if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin']) && Number(req.user.id) !== 1) {
      for (const r of rows) {
        if (Number(r.id) === Number(req.user.id)) continue;
        for (const f of ['email', 'phone', 'employment_type', 'contracted_hours', 'dbs_expiry', 'contract_start', 'pin_length', 'has_pin']) delete r[f];
      }
    }
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /rooms — all rooms
router.get('/rooms', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM rooms ORDER BY id');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /work-patterns — must be before /:id to avoid param conflict
router.get('/work-patterns', requireRole('manager', 'deputy_manager'), async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT wp.staff_id, s.first_name, s.last_name, s.hourly_rate, s.qualification,
             s.hours_per_week, s.annual_salary,
             json_agg(json_build_object(
               'dow', wp.day_of_week,
               'start', wp.shift_start,
               'end', wp.shift_end,
               'is_off', wp.is_off,
               'lunch_mins', wp.lunch_break_minutes,
               'room', wp.room
             ) ORDER BY wp.day_of_week) AS patterns
      FROM staff_work_patterns wp
      JOIN staff s ON s.id = wp.staff_id
      WHERE wp.effective_to IS NULL
      GROUP BY wp.staff_id, s.first_name, s.last_name, s.hourly_rate, s.qualification,
               s.hours_per_week, s.annual_salary
      ORDER BY s.first_name
    `);
    // Deputy sees hours/work patterns but NOT pay — strip hourly_rate/annual_salary
    // (PROMPT 35, 2026-06-30). hours_per_week stays visible.
    if (!(await canViewSalaries(req.user))) {
      rows.forEach(stripSalaryFields);
    }
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// b212 (2026-08-21) — leaver lifecycle, mirroring children.js.
// Roles allowed to add/archive/restore a staff member. Matches the guard already
// used by POST / and PATCH /:id/deactivate below (requireRole('manager','deputy_manager')).
const STAFF_ADMIN_ROLES = ['manager', 'deputy_manager', 'admin'];

// GET /inactive — the "Inactive staff" list (b212, 2026-08-21).
// The mirror of GET /api/children/inactive. Staff drop off every operational
// surface once is_active flips (rota, ratios, key-person pickers, PIN login), but
// the rows are retained — employment records have a statutory retention period —
// so this is where a manager finds them: past leavers, plus anyone deactivated by
// hand. ?q= filters by name. Manager/deputy only; most recently left first.
// MUST stay above GET /:id or Express matches "inactive" as an :id.
router.get('/inactive', async (req, res) => {
  if (!hasRole(req.user, STAFF_ADMIN_ROLES)) {
    return res.status(403).json({ error: 'Insufficient role' });
  }
  try {
    const db = getPool();
    const params = [];
    let sql = `
      SELECT s.id, s.first_name, s.last_name, s.preferred_name, s.email, s.phone,
             s.role, s.room_id, s.employment_type, s.is_active,
             s.termination_date, s.contract_start, s.profile_photo,
             r.name AS room_name
      FROM staff s
      LEFT JOIN rooms r ON r.id = s.room_id
      WHERE (s.is_active = false
             OR (s.termination_date IS NOT NULL AND s.termination_date < CURRENT_DATE))
        AND s.id <> 1`;
    if (req.query.q && String(req.query.q).trim()) {
      params.push('%' + String(req.query.q).trim().toLowerCase() + '%');
      sql += ` AND (lower(s.first_name) LIKE $${params.length} OR lower(s.last_name) LIKE $${params.length})`;
    }
    sql += ` ORDER BY s.termination_date DESC NULLS LAST, s.first_name, s.last_name`;
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// b362 (2026-09-29) — GET /pins — every staff PIN's STATE, on one page.
//
// Toby: "Is there a page where I can view and edit multiple staff pins easily?"
// He couldn't: POST /:id/set-pin and DELETE /:id/pin have existed since b272, but
// the only way to reach either was one staff profile at a time.
//
// MUST STAY ABOVE GET /:id or Express matches "pins" as an :id.
//
// ── WHAT THIS ROUTE WILL NOT RETURN ─────────────────────────────────────────
// No PIN. No hash. Not truncated, not masked, not "just the length as a hint".
// `pin_hash` is offline-crackable against a 4-digit space in milliseconds, so it
// is a credential and it never crosses the wire — the same rule GET /:id already
// applies by deleting it from the row (see the b272 comment there). What comes
// back is a boolean, a length and a date: enough to run the page, useless to an
// attacker who gets hold of the response.
//
// pin_length IS returned. It is not secret — the login pad already reveals it by
// auto-submitting on the 4th or 6th digit — and a manager needs to see which
// accounts are still on a 4-digit PIN.
//
// ── WHEN IT WAS LAST SET ────────────────────────────────────────────────────
// There is no pin_set_at column, and adding one would not answer for any PIN set
// before today. `staff.updated_at` is not it either — any profile edit moves it,
// so it would report a room change as a PIN change. The honest source is the
// audit log, which has recorded action='set_pin' since b272: MAX(occurred_at)
// per staff member, and NULL where nothing was ever logged. NULL renders as
// "not recorded", never as "never".
//
// ── THE OWNER ACCOUNT ───────────────────────────────────────────────────────
// id=1 is listed, because a page called "Staff PINs" that silently omits a member
// of staff is worse than one that explains itself — but it is flagged
// `protected: true` and carries its own reason. The write routes refuse it
// independently (both return 403 protected_account), so the flag is a label on a
// rule enforced elsewhere, not the rule itself. ladn.protected_staff_pins is
// neither read nor written here.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/pins', async (req, res) => {
  if (!hasRole(req.user, PIN_ADMIN_ROLES)) {
    return res.status(403).json({ error: 'Insufficient role' });
  }
  try {
    const db = getPool();
    const includeInactive = String(req.query.include_inactive || '') === '1';
    // LEFT JOIN onto the audit log rather than a correlated subquery so a schema
    // without audit_log rows still returns every member of staff.
    const { rows } = await db.query(`
      SELECT s.id, s.first_name, s.last_name, s.preferred_name, s.role,
             s.is_active, s.room_id, r.name AS room_name,
             (s.pin_hash IS NOT NULL) AS has_pin,
             s.pin_length,
             a.last_set_at, a.last_cleared_at
        FROM staff s
        LEFT JOIN rooms r ON r.id = s.room_id
        LEFT JOIN (
          -- entity_id is text on audit_log, so it is filtered to digits before the
          -- cast: one non-numeric row would otherwise abort the whole query.
          -- clear_pin is read as well as set_pin, because "last set 29 Sept" against
          -- a row badged NO PIN is a contradiction — the PIN was set and then
          -- removed, and the removal is the later fact.
          SELECT entity_id::int AS sid,
                 MAX(occurred_at) FILTER (WHERE action = 'set_pin')   AS last_set_at,
                 MAX(occurred_at) FILTER (WHERE action = 'clear_pin') AS last_cleared_at
            FROM audit_log
           WHERE action IN ('set_pin', 'clear_pin')
             AND entity_type = 'staff'
             AND entity_id ~ '^[0-9]+$'
           GROUP BY 1
        ) a ON a.sid = s.id
       WHERE ($1::boolean OR s.is_active = true)
       ORDER BY s.is_active DESC, s.first_name, s.last_name`,
      [includeInactive]);

    const staff = rows.map(r => ({
      id: r.id,
      name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
      preferred_name: r.preferred_name || null,
      role: r.role,
      is_active: r.is_active,
      room_name: r.room_name || null,
      has_pin: r.has_pin,
      pin_length: r.has_pin ? r.pin_length : null,
      // Only meaningful while a PIN exists. Someone whose PIN was set and then
      // removed is reported as cleared, not as "last set" — the row's badge says
      // NO PIN and the date under it must agree with the badge.
      last_set_at: r.has_pin ? (r.last_set_at || null) : null,
      last_cleared_at: !r.has_pin ? (r.last_cleared_at || null) : null,
      protected: r.id === PROTECTED_STAFF_ID,
      protected_reason: r.id === PROTECTED_STAFF_ID
        ? 'Owner — change in Settings → Update PIN'
        : null,
    }));

    res.json({
      staff,
      counts: {
        total: staff.length,
        with_pin: staff.filter(s => s.has_pin).length,
        without_pin: staff.filter(s => !s.has_pin && !s.protected).length,
        four_digit: staff.filter(s => s.has_pin && s.pin_length === 4).length,
      },
      rule: {
        allowed_lengths: [4, 6],
        protected_staff_id: PROTECTED_STAFF_ID,
        never_shown: 'Wren never displays a PIN or its hash. A PIN can only be replaced, not read.',
        last_set_source: 'audit_log (set_pin / clear_pin). Blank means no PIN change has been recorded for that person — '
                       + 'PIN changes have only been logged since 4 September 2026, so an older PIN shows nothing.',
      },
    });
  } catch (e) {
    console.error('[staff] pins list failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /records — "Staff records" spreadsheet editor (b500, 2026-10-13) ────
// Toby: "add a page in settings where I can easily edit the data in the staff
// central records." One call with every column the Details tab shows —
// employment, qualifications (incl. b499 census flags), responsibilities, DBS
// and right-to-work — rather than N profile fetches. Manager/deputy/admin
// only (same STAFF_ADMIN_ROLES gate as GET /inactive above); salary/pay, PIN
// and TOTP columns are never selected here (they are not on this page —
// salary stays owner-only, PINs/TOTP are never serialised by this router at all).
// MUST STAY ABOVE GET /:id or Express matches "records" as an :id.
router.get('/records', async (req, res) => {
  if (!hasRole(req.user, STAFF_ADMIN_ROLES)) {
    return res.status(403).json({ error: 'Insufficient role' });
  }
  // b500 review: Roost-only. `staff` is on the HR allow-list and the EY portal has no
  // Roost person-allowlist, so without this a floor manager signed in on a room tablet
  // (or HR) could pull every staff member's DBS / right-to-work / qualification sheet.
  if (req._portal && req._portal !== 'admin') {
    return res.status(403).json({ error: 'roost_only', message: 'Staff records are only available in Roost.' });
  }
  try {
    const db = getPool();
    const includeInactive = String(req.query.include_inactive || '') === '1';
    const { rows } = await db.query(`
      SELECT s.id, s.first_name, s.last_name, s.preferred_name, s.is_active,
             s.role, s.room_id, r.name AS room_name, s.job_title,
             s.contracted_hours, s.contract_start, s.employment_type,
             s.qualification, s.qualification_level,
             s.census_fr_level, s.census_qts, s.census_eyps, s.census_eyts, s.census_senco_l3,
             s.is_volunteer, s.census_works_with_under5, s.census_managerial,
             s.is_dsl, s.is_deputy_dsl, s.is_first_aider,
             s.dbs_number, s.dbs_initial_date, s.dbs_check_date, s.dbs_expiry, s.dbs_followup_date,
             s.right_to_work_status, s.right_to_work_check_date, s.right_to_work_expiry_date,
             s.visa_expiry_date
      FROM staff s
      LEFT JOIN rooms r ON r.id = s.room_id
      WHERE ($1::boolean OR s.is_active = true) AND COALESCE(s.is_demo, false) = false
      ORDER BY s.first_name, s.last_name
    `, [includeInactive]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /:id
router.get('/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT s.*, r.name as room_name
      FROM staff s
      LEFT JOIN rooms r ON r.id = s.room_id
      WHERE s.id=$1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const safe = rows[0];
    // b272 — whether a PIN EXISTS is not the PIN. The staff drawer needs it to
    // show SET / NOT SET (who can actually log in) and to enable "Remove PIN".
    // Computed before the delete below; the hash itself still never leaves here.
    safe.has_pin = safe.pin_hash != null;
    // pin_hash must NEVER reach the client (offline-crackable; PINs are protected — CLAUDE rule 1)
    delete safe.pin_hash;
    // 2026-10-12 HR audit C2: secrets are never serialised, for ANY caller (an authenticator
    // seed, Telegram link codes, the NI ciphertext/IV/tag). Whether TOTP is enrolled is shown as a flag.
    safe.has_totp = safe.totp_secret != null;
    for (const f of Object.keys(safe)) {
      if (/^(totp_|pin_)/.test(f) || /^telegram_link_code/.test(f) || /^ni_number_(enc|iv|tag)$/.test(f)) delete safe[f];
    }
    const isSelf = req.user.id === parseInt(req.params.id);
    // Sensitive PII fields: visible only to the staff member themselves or managers/deputies.
    // (NI / DOB / DBS / address / emergency contacts stay visible to deputy — unchanged.)
    if (!isSelf && !hasRole(req.user, ['manager','deputy_manager', 'admin'])) {
      for (const f of ['ni_number','date_of_birth','dbs_number',
                       'address_line1','address_line2','address','postcode',
                       'emergency_contact_name','emergency_contact_phone','emergency_contact',
                       'bank_account_number','bank_sort_code','telegram_chat_id','notes',
                       // 2026-10-12 HR audit C2: immigration, contract and leaving details are HR-confidential.
                       'visa_number','visa_expiry_date','right_to_work_status','right_to_work_check_date',
                       'right_to_work_expiry_date','contract_type','contract_start','contract_end',
                       'termination_date','emergency_contact_relation']) {
        delete safe[f];
      }
      // login-20261023 — the deny-list above missed fields as they were added (DBS dates, leaving
      // reasons, contracted hours, employment type…). For a colleague who is neither the person nor
      // a manager, keep ONLY what a rota/room screen needs. A new column is now hidden by default.
      const COLLEAGUE_FIELDS = new Set(['id', 'first_name', 'last_name', 'preferred_name', 'role', 'job_title',
        'room_id', 'room_name', 'profile_photo', 'photo_url', 'is_active', 'is_dsl', 'is_deputy_dsl',
        'is_first_aider', 'is_send_lead', 'qualification_level', 'profile_summary', 'counts_on_ratio']);
      for (const f of Object.keys(safe)) if (!COLLEAGUE_FIELDS.has(f)) delete safe[f];
    }
    // PAY/salary (annual_salary, hourly_rate, tax_code, payroll, pension): manager-only
    // confidential (PROMPT 35, 2026-06-30). Deputy keeps hours/work patterns but NOT pay.
    // Staff always see their own pay.
    // b303: the HMRC starter-checklist answers are in SALARY_PAY_FIELDS too, so the
    // same one line gates them. `payroll_starter` is built ONLY on the branch that
    // is allowed to see them — never built and then stripped, which is the shape
    // that leaks the first time somebody adds a field to it and forgets the list.
    if (!isSelf && !(await canViewSalaries(req.user))) {
      stripSalaryFields(safe);
    } else {
      safe.payroll_starter = hmrcStarter.describe(safe);
    }
    res.json(safe);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── b500 (2026-10-13): the field whitelist + per-row guard, factored out of ──
// PUT /:id so the new bulk editor (POST /bulk-update, Staff records) runs
// every single row through the EXACT SAME checks — self-edit scoping, the
// owner-record rule, the staff.edit capability gate on employment fields, and
// the no-self-escalation / no-granting-a-role-you-don't-hold rules — rather
// than a second, easily-drifting copy of them.
//
// STAFF_EDITABLE_FIELDS additions for b500: job_title, qualification(_level),
// is_dsl/is_deputy_dsl/is_first_aider and the DBS/right-to-work/visa dates
// already existed as columns (b212/earlier) but were never on the PUT /:id
// whitelist — there was no screen that edited them. The Staff records page's
// Details tab is that screen, so they join EMPLOYMENT_FIELDS alongside
// role/room/dbs_* above: manager-controlled, not self-service.
const EMPLOYMENT_FIELDS = ['role','room_id','employment_type','contracted_hours','is_active',
  'dbs_number','dbs_expiry','notes','contract_start','contract_end','termination_date','ni_number','date_of_birth',
  // b499: census qualification flags — management-controlled, like role/dbs above.
  'census_fr_level','census_qts','census_eyps','census_eyts','census_senco_l3',
  'is_volunteer','census_works_with_under5','census_managerial',
  // b500: job title / qualification / responsibilities / DBS detail / right-to-work.
  'job_title','qualification','qualification_level',
  'is_dsl','is_deputy_dsl','is_first_aider',
  'dbs_initial_date','dbs_check_date','dbs_followup_date',
  'right_to_work_status','right_to_work_check_date','right_to_work_expiry_date',
  'visa_number','visa_expiry_date'];

const STAFF_EDITABLE_FIELDS = ['first_name','last_name','preferred_name','email','phone',
  'role','room_id','employment_type','contracted_hours','is_active',
  'address_line1','address_line2','postcode','date_of_birth','ni_number',
  'dbs_number','dbs_expiry','emergency_contact_name','emergency_contact_phone',
  'emergency_contact_relation','notes','contract_start','contract_end',
  'termination_date',
  'leaving_reason','leaving_notes', // 2026-10-13: the Roost "Has left…" form (reason + notes)
                       // b212: termination_date is now editable (was read-only,
                       // set by the BrightHR import / GDPR retention only)
  // b499 (2026-10-13): DfE Early Years Census fields — the Roost Census tab's staff grid and
  // the staff profile's qualification card both save through this same route.
  'census_fr_level','census_qts','census_eyps','census_eyts','census_senco_l3',
  'is_volunteer','census_works_with_under5','census_managerial',
  // b500 (2026-10-13): Staff records editor — see EMPLOYMENT_FIELDS comment above.
  'job_title','qualification','qualification_level',
  'is_dsl','is_deputy_dsl','is_first_aider',
  'dbs_initial_date','dbs_check_date','dbs_followup_date',
  'right_to_work_status','right_to_work_check_date','right_to_work_expiry_date',
  'visa_number','visa_expiry_date'];

// ── b500 review (2026-10-15): server-side value checks for the columns the Staff ──
// records page edits. Before this a typo went straight to Postgres (a 500 that echoed
// the SQL error — e.g. a pasted role label hit staff_role_check and showed the raw
// constraint text in the cell). Legacy columns (names, address, notes, …) are deliberately not touched here.
// A blank ('' / null) clears the column; booleans may be null (b499's census flags are
// tri-state: blank = "use the default").
const _BOOL_FIELDS = new Set(['census_qts','census_eyps','census_eyts','census_senco_l3','is_volunteer',
  'census_works_with_under5','census_managerial','is_dsl','is_deputy_dsl','is_first_aider']);
const _INT_FIELDS = { room_id: [1, 2147483647], qualification_level: [0, 9], census_fr_level: [0, 9] };
const _NUM_FIELDS = { contracted_hours: [0, 80] };
const _DATE_FIELDS = new Set(['contract_start','dbs_initial_date','dbs_check_date','dbs_expiry','dbs_followup_date',
  'right_to_work_check_date','right_to_work_expiry_date','visa_expiry_date']);
const _TEXT_FIELDS = { job_title: 120, qualification: 200, dbs_number: 40, visa_number: 40,
  right_to_work_status: 40, employment_type: 40 };

// → { value } or { error }
function _coerceStaffValue(field, v) {
  const blank = v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  if (field === 'role') {
    // every real role is lower-case snake_case (the list itself differs per edition, so the shape is
    // checked here and staff_role_check stays the authority on which roles exist)
    if (typeof v !== 'string' || !/^[a-z][a-z_]{1,29}$/.test(v)) {
      return { error: 'Role must be a role name such as practitioner, room_leader or manager' };
    }
    return { value: v };
  }
  if (_BOOL_FIELDS.has(field)) {
    if (blank) return { value: null };
    if (v === true || v === 'true' || v === 1 || v === '1') return { value: true };
    if (v === false || v === 'false' || v === 0 || v === '0') return { value: false };
    return { error: `${field} must be yes or no` };
  }
  if (_INT_FIELDS[field]) {
    if (blank) return { value: null };
    const n = typeof v === 'number' ? v : (/^-?\d+$/.test(String(v).trim()) ? Number(String(v).trim()) : NaN);
    const [lo, hi] = _INT_FIELDS[field];
    if (!Number.isInteger(n) || n < lo || n > hi) return { error: `${field} must be a whole number from ${lo} to ${hi > 1e6 ? 'a valid id' : hi}` };
    return { value: n };
  }
  if (_NUM_FIELDS[field]) {
    if (blank) return { value: null };
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    const [lo, hi] = _NUM_FIELDS[field];
    if (!Number.isFinite(n) || n < lo || n > hi) return { error: `${field} must be a number from ${lo} to ${hi}` };
    return { value: n };
  }
  if (_DATE_FIELDS.has(field)) {
    if (blank) return { value: null };
    // YYYY-MM-DD, or the longer ISO form an older page may send back from a read — passed through as before
    const m = typeof v === 'string' && v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
    const d = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`) : null;
    if (!m || isNaN(d) || d.toISOString().slice(0, 10) !== `${m[1]}-${m[2]}-${m[3]}`) {
      return { error: `${field} must be a date (YYYY-MM-DD)` };
    }
    return { value: v };
  }
  if (_TEXT_FIELDS[field]) {
    if (blank) return { value: null };
    if (typeof v !== 'string') return { error: `${field} must be text` };
    if (v.length > _TEXT_FIELDS[field]) return { error: `${field} is too long (max ${_TEXT_FIELDS[field]} characters)` };
    return { value: v };
  }
  return { value: v };
}

// Personal identifiers are never copied into audit_log's old/new diff — only the fact that
// they changed (meta.fields_changed). Everything else (role, room, flags, dates…) is logged in full.
const _AUDIT_REDACT = new Set(['ni_number','date_of_birth','address_line1','address_line2','postcode','email','phone',
  'emergency_contact_name','emergency_contact_phone','emergency_contact_relation','notes','leaving_notes',
  'dbs_number','visa_number']);

// The fields the Staff records page's Details tab shows — the ONLY ones POST /bulk-update accepts
// (the single-row PUT keeps its wider whitelist for the profile pages). dbs_number is left out on
// purpose: a DBS number is per person, setting one value for N people can only be a mistake.
const BULK_EDITABLE_FIELDS = ['role','room_id','job_title','employment_type','contracted_hours','contract_start',
  'qualification','qualification_level',
  'census_fr_level','census_qts','census_eyps','census_eyts','census_senco_l3',
  'is_volunteer','census_works_with_under5','census_managerial',
  'is_dsl','is_deputy_dsl','is_first_aider',
  'dbs_initial_date','dbs_check_date','dbs_expiry','dbs_followup_date',
  'right_to_work_status','right_to_work_expiry_date','visa_expiry_date'];

// Returns { status, json } — never throws. Callers (PUT /:id, POST /bulk-update)
// send `status` + `json` straight back as the response for that row.
async function applyStaffUpdate(req, targetId, body) {
  const canEditOthers = hasRole(req.user, ['manager','deputy_manager', 'admin']);
  const isSelf = Number(req.user.id) === Number(targetId);
  // own-record exception (was middleware _requireStaffEditCap): capability
  // required only when editing someone ELSE's row.
  if (!isSelf) {
    let level = 'none';
    try { level = await capabilityLevel(req.user, 'staff.edit'); } catch (_) { level = 'none'; }
    if (LEVELS.indexOf(level) < LEVELS.indexOf('edit')) {
      return { status: 403, json: { error: 'capability_forbidden', capability: 'staff.edit', required_level: 'edit' } };
    }
  }
  if (!canEditOthers && !isSelf) {
    return { status: 403, json: { error: 'Forbidden' } };
  }
  // ── 2026-10-12 HR audit C1 (ported from release d9974543 for b491): no self-service
  // privilege escalation ─────────────────────────────────────────────────────
  // The owner's row (id 1) is changed only by the owner.
  if (Number(targetId) === PROTECTED_STAFF_ID && !isSelf) {
    return { status: 403, json: { error: 'The owner\'s record can only be changed by the owner' } };
  }
  // Employment fields need the staff.edit capability — on your OWN row too (that is the
  // hole: the own-record exception above lets everyone through for their own id).
  const touchesEmployment = EMPLOYMENT_FIELDS.some(f => body[f] !== undefined);
  if (touchesEmployment) {
    let level = 'none';
    try { level = await capabilityLevel(req.user, 'staff.edit'); } catch (_) { level = 'none'; }
    if (LEVELS.indexOf(level) < LEVELS.indexOf('edit')) {
      return { status: 403, json: { error: 'capability_forbidden', capability: 'staff.edit', required_level: 'edit',
        detail: 'You can change your own name and contact details; a manager changes role, hours, contract and DBS.' } };
    }
  }
  // b480 review F7 (restored by the b500 review — the first cut of this refactor dropped it):
  // 'accountant' opens Roost (Finance) without the person allowlist and is added to the Roost
  // CF Access policy by the daily sync, so it is an owner-only grant. It applies to the bulk
  // editor too, because every row runs through here.
  if (body.role === 'accountant' && !require('../lib/capabilities').isOwnerRole(req.user)) {
    let cur = null;
    try { ({ rows: [cur] } = await getPool().query('SELECT role FROM staff WHERE id=$1', [targetId])); } catch (_) { cur = null; }
    if (!cur || cur.role !== 'accountant') {  // re-saving an existing accountant's other details is fine
      return { status: 403, json: { error: 'Only the owner can give someone the accountant role' } };
    }
  }
  if (body.role !== undefined) {
    const PRIVILEGED = ['owner', 'admin', 'manager', 'deputy_manager'];
    const newRole = String(body.role || '');
    if (!newRole) return { status: 400, json: { error: 'role cannot be blank' } };
    if (isSelf && Number(targetId) !== PROTECTED_STAFF_ID) {
      return { status: 403, json: { error: 'You cannot change your own role' } };
    }
    const held = require('../middleware/auth').rolesHeldBy(req.user.role);
    if (PRIVILEGED.includes(newRole) && !held.includes(newRole)) {
      return { status: 403, json: { error: `You cannot give someone the ${newRole} role` } };
    }
    // b500 review: and nobody can re-role someone who sits above them (a manager ticking an
    // admin row and bulk-setting "Practitioner" is the mirror image of the escalation above).
    try {
      const { rows: [cur] } = await getPool().query('SELECT role FROM staff WHERE id=$1', [targetId]);
      if (cur && PRIVILEGED.includes(cur.role) && !held.includes(cur.role) && cur.role !== newRole) {
        return { status: 403, json: { error: `You cannot change the role of someone with the ${cur.role} role` } };
      }
    } catch (_) { /* row lookup failed — the UPDATE below will 404/500 on its own */ }
  }
  const touched = STAFF_EDITABLE_FIELDS.filter(f => body[f] !== undefined);
  if (!touched.length) return { status: 400, json: { error: 'No fields' } };
  const clean = {};
  for (const f of touched) {
    const c = _coerceStaffValue(f, body[f]);
    if (c.error) return { status: 400, json: { error: c.error } };
    clean[f] = c.value;
  }
  const updates = [];
  const vals = [];
  touched.forEach(f => { vals.push(clean[f]); updates.push(`${f}=$${vals.length}`); });
  vals.push(targetId);
  try {
    const db = getPool();
    // Old values, for the audit diff — only the fields actually touched.
    let oldVals = {};
    try {
      const { rows: before } = await db.query(
        `SELECT ${touched.join(',')} FROM staff WHERE id=$1`, [targetId]);
      oldVals = before[0] || {};
    } catch (_) { /* best-effort — never blocks the write */ }

    const { rows } = await db.query(
      `UPDATE staff SET ${updates.join(',')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING id,first_name,last_name,role,room_id,is_active,termination_date`,
      vals
    );
    if (!rows.length) return { status: 404, json: { error: 'Staff not found' } };
    // b212: a leaving date already in the past must take effect NOW, not at 03:50
    // tomorrow — exactly the rule children.js applies to leave_date. Dozens of route
    // files filter staff on is_active alone, so until that flips a leaver keeps
    // appearing on the rota and in the ratio maths and it looks like nothing saved.
    // staff-termination-roll.js still does this nightly — this just stops the wait.
    // 🔒 id=1 (owner) is never deactivated, whatever date is typed.
    try {
      const r0 = rows[0] || {};
      const leftNow = r0.termination_date
        && new Date(r0.termination_date) < new Date(new Date().toDateString());
      if (leftNow && r0.is_active && Number(r0.id) !== 1) {
        await db.query(`UPDATE staff SET is_active=false, updated_at=NOW() WHERE id=$1 AND id<>1`, [r0.id]);
        rows[0].is_active = false;
      }
    } catch (tErr) { console.error('[staff] termination-date apply failed:', tErr.message); }

    const newVals = {}, oldOut = {};
    touched.forEach(f => {
      newVals[f] = _AUDIT_REDACT.has(f) ? '[changed]' : clean[f];
      oldOut[f] = _AUDIT_REDACT.has(f) ? '[changed]' : oldVals[f];
    });
    recordAudit({ req, action: 'update', entity_type: 'staff', entity_id: targetId,
      diff: { old: oldOut, new: newVals },
      meta: { fields_changed: touched } });
    return { status: 200, json: rows[0] };
  } catch (e) {
    return { status: 500, json: { error: e.message } };
  }
}

// PUT /:id
router.put('/:id', async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const result = await applyStaffUpdate(req, targetId, req.body || {});
  res.status(result.status).json(result.json);
});

// ── POST /bulk-update — "Staff records" spreadsheet editor (b500, 2026-10-13) ──
// { ids:[...], field, value } — set ONE field to ONE value for MANY staff in a
// single call. Every id runs through applyStaffUpdate, the same guard PUT /:id
// uses, so a refused role-escalation / an owner-record edit / a missing
// staff.edit capability is refused per-row with the same reason, not silently
// skipped. Roost-only (the editor page lives only there); manager/deputy/admin
// role on top, same as the rest of staff administration in this file.
router.post('/bulk-update', async (req, res) => {
  if (req._portal && req._portal !== 'admin') {
    return res.status(403).json({ error: 'roost_only', message: 'Staff records editing is only available in Roost.' });
  }
  if (!hasRole(req.user, STAFF_ADMIN_ROLES)) {
    return res.status(403).json({ error: 'Insufficient role' });
  }
  const ids = Array.from(new Set(Array.isArray(req.body && req.body.ids)
    ? req.body.ids.map(n => parseInt(n, 10)).filter(Number.isInteger)
    : []));
  const field = String((req.body && req.body.field) || '');
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  if (ids.length > 200) return res.status(400).json({ error: 'Too many people in one go (max 200)' });
  // b500 review: the page's own columns only — not the single route's whole whitelist (which
  // also carries email, is_active, date_of_birth, ni_number, address, emergency contacts…).
  if (!BULK_EDITABLE_FIELDS.includes(field)) {
    return res.status(400).json({ error: `Field not editable in bulk: ${field}` });
  }
  if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'value')) {
    return res.status(400).json({ error: 'value required (use null to clear)' });
  }
  const value = req.body.value;
  const results = [];
  for (const id of ids) {
    const r = await applyStaffUpdate(req, id, { [field]: value });
    results.push({
      id, ok: r.status < 400,
      ...(r.status >= 400 ? { error: r.json.error, detail: r.json.detail } : {}),
    });
  }
  recordAudit({ req, action: 'bulk_update', entity_type: 'staff', entity_id: null,
    meta: { field, value, staff_ids: ids,
            succeeded: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length } });
  res.json({ results });
});

// PUT /:id/permissions — update scope and scope_value for a staff member (manager/admin/IT only)
// b237: the role allow-list below STAYS — capability layered on top, stricter wins.
router.put('/:id/permissions', requireCapabilityLevel('staff.edit', 'edit'), async (req, res) => {
  const allowed = ['manager','deputy_manager','headteacher','admin','it_technician','senco','business_manager'];
  if (!hasRole(req.user, allowed)) {
    return res.status(403).json({ error: 'Forbidden — manager or admin role required' });
  }
  const { scope, scope_value } = req.body;
  const validScopes = ['all','year_group','class','room'];
  if (!validScopes.includes(scope)) {
    return res.status(400).json({ error: 'Invalid scope. Must be: all, year_group, class, room' });
  }
  try {
    const db = getPool();
    await db.query(
      'UPDATE staff SET scope=$1, scope_value=$2, updated_at=NOW() WHERE id=$3',
      [scope, scope === 'all' ? null : (scope_value || null), req.params.id]
    );
    const { rows } = await db.query(
      'SELECT id, first_name, last_name, role, scope, scope_value FROM staff WHERE id=$1',
      [req.params.id]
    );
    res.json(rows[0] || { ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /:id/can-publish — grant/revoke a staff member's ability to publish
// observations directly to parents (manager/deputy_manager only; no self-service —
// staff must not be able to lift their own review requirement). New/unqualified
// staff default to false (see POST / above); a manager flips this on once they're
// confident in the person's judgement. See src/routes/observations.js review-queue.
router.patch('/:id/can-publish', requireRole('manager', 'deputy_manager'), async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const canPublish = !!(req.body && req.body.can_publish);
  try {
    const db = getPool();
    const { rows } = await db.query(
      'UPDATE staff SET can_publish=$1, updated_at=NOW() WHERE id=$2 RETURNING id, first_name, last_name, can_publish',
      [canPublish, targetId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Staff not found' });
    recordAudit({ req, action: 'update', entity_type: 'staff', entity_id: targetId,
      meta: { field: 'can_publish', value: canPublish } });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /permissions/year-groups — return distinct year groups / rooms for scope dropdown
router.get('/permissions/groups', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT DISTINCT year_group as value, year_group as label FROM children
      WHERE year_group IS NOT NULL AND is_active=true
      UNION
      SELECT DISTINCT form_group, form_group FROM children
      WHERE form_group IS NOT NULL AND is_active=true
      UNION
      SELECT DISTINCT r.name, r.name FROM rooms r
      WHERE r.name IS NOT NULL
      ORDER BY value
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /permissions/all — return all staff with scope info (manager/admin/IT only)
router.get('/permissions/all', async (req, res) => {
  const allowed = ['manager','deputy_manager','headteacher','admin','it_technician','senco','business_manager'];
  if (!hasRole(req.user, allowed)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT id, first_name, last_name, role, scope, scope_value
      FROM staff WHERE is_active=true ORDER BY first_name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/set-pin — manager sets PIN for any staff; staff sets own
// Supports 4 OR 6 digit numeric PINs. Stores pin_length so the login pad
// knows when to auto-submit. bcrypt cost 10 (matches auth.js login verify).
//
// 🔒 CRITICAL: for id=1 (Toby) the PIN must be written to BOTH staff
// AND protected_staff_pins in the SAME transaction so the backup never
// goes stale. Any seed/reset prompt restores Toby's PIN from that backup.
router.post('/:id/set-pin', async (req, res) => {
  const canSetOthers = hasRole(req.user, ['manager','deputy_manager', 'admin']);
  const targetId = parseInt(req.params.id, 10);
  if (!canSetOthers && req.user.id !== targetId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  // ── b272 (2026-09-04): id=1 is off-limits on the staff-admin path ──────────
  // CLAUDE.md ABSOLUTE RULE 1: never write ladn.staff id=1's pin_hash. Until now
  // this route would happily overwrite it for any manager/admin caller AND
  // clobber the ladn.protected_staff_pins backup in the same transaction, which
  // is precisely the failure the protected table exists to survive.
  // Toby is not locked out by this: POST /api/auth/set-my-pin (Roost → Settings
  // → Update PIN) is the self-service path and carries the same id=1 dual-write.
  // That route is untouched; this is the *administer someone else's PIN* path,
  // and the owner account is not somebody else's.
  if (targetId === PROTECTED_STAFF_ID) {
    return res.status(403).json({
      error: 'protected_account',
      message: 'The owner account\u2019s PIN cannot be set from Staff admin. Change it in Settings \u2192 Update PIN.',
    });
  }
  const pin = req.body && req.body.pin != null ? String(req.body.pin) : '';
  if (!/^\d+$/.test(pin) || (pin.length !== 4 && pin.length !== 6)) {
    return res.status(400).json({ error: 'PIN must be exactly 4 or 6 digits' });
  }
  const db = getPool();
  const client = await db.connect();
  try {
    const hash = await bcrypt.hash(pin, 10);
    await client.query('BEGIN');
    // 2026-07-04: was hard-coded staff — a demo/HT edition calling set-pin
    // wrote into PRODUCTION staff (and for id=1 clobbered the protected backup
    // in the same transaction). Schema-unqualified: search_path scopes each
    // edition to its own schema.
    const { rows: upd } = await client.query(
      'UPDATE staff SET pin_hash=$1, pin_length=$2, updated_at=NOW() WHERE id=$3 RETURNING id, first_name, last_name',
      [hash, pin.length, targetId]
    );
    if (!upd.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Staff not found' });
    }
    // id=1 PIN-sync rule — keep the protected backup in lockstep (only where the
    // schema has the table; demo schemas may not, and must never touch ladn's)
    // b272: unreachable now that targetId === PROTECTED_STAFF_ID is refused at the
    // top of this handler. Kept deliberately — if that guard is ever removed, the
    // backup still cannot go stale behind it. POST /api/auth/set-my-pin carries
    // the live copy of this dual-write.
    if (targetId === 1) {
      const { rows: reg } = await client.query(
        "SELECT to_regclass('protected_staff_pins') IS NOT NULL AS has_table");
      if (reg[0]?.has_table) {
        const name = `${upd[0].first_name || ''} ${upd[0].last_name || ''}`.trim();
        await client.query(`
          INSERT INTO protected_staff_pins (staff_id, staff_name, pin_hash, updated_at)
          VALUES (1, $1, $2, NOW())
          ON CONFLICT (staff_id) DO UPDATE SET staff_name=$1, pin_hash=$2, updated_at=NOW()
        `, [name, hash]);
      }
    }
    await client.query('COMMIT');
    recordAudit({ req, action: 'set_pin', entity_type: 'staff', entity_id: targetId,
      meta: { pin_length: pin.length, protected_synced: targetId === 1 } });
    res.json({ ok: true, pin_length: pin.length });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── DELETE /:id/pin — remove a staff member's PIN (b272, 2026-09-04) ─────────
// Toby: "Allow me to add/edit/delete staff PINS from the admin page." Add/edit
// was already there (POST /:id/set-pin); delete was the missing third.
//
// WHY IT MATTERS: a leaver whose row is deactivated cannot be relied on to be
// unable to log in — nothing here clears the credential, and clearing it is the
// difference between "we took them off the rota" and "they cannot get in".
// Clearing pin_hash makes the PIN pad reject them: src/routes/auth.js verifies
// with bcrypt.compare against pin_hash and a NULL hash can never match.
//
// Deliberately NOT a self-service action: you may set your own PIN, you may not
// remove your own login. Manager/admin only, and never id=1.
router.delete('/:id/pin', async (req, res) => {
  if (!hasRole(req.user, PIN_ADMIN_ROLES)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const targetId = parseInt(req.params.id, 10);
  if (!Number.isInteger(targetId)) {
    return res.status(400).json({ error: 'Bad staff id' });
  }
  // Same absolute rule as set-pin: the owner account's PIN is never touched from
  // Staff admin, and ladn.protected_staff_pins is neither read nor written here.
  if (targetId === PROTECTED_STAFF_ID) {
    return res.status(403).json({
      error: 'protected_account',
      message: 'The owner account\u2019s PIN is protected and cannot be removed.',
    });
  }
  try {
    const db = getPool();
    // Schema-unqualified on purpose (2026-07-04 sweep): search_path scopes each
    // edition to its own schema, so a demo/HT caller can never reach ladn.staff.
    //
    // pin_hash is the credential and is nullable — nulling it is what actually
    // locks the account. pin_length is NOT NULL DEFAULT 4 (verified on wren_dev
    // AND on prod), so it is reset to DEFAULT rather than NULL; nulling it threw
    // a not-null violation and left the PIN in place, which would have been a
    // "removed" PIN that still logged in. It is only a hint to the login pad
    // about when to auto-submit, and means nothing while no hash exists.
    //
    // RETURNING carries no PIN material — id and the after-state flag only.
    const { rows } = await db.query(
      `UPDATE staff
          SET pin_hash = NULL, pin_length = DEFAULT, updated_at = NOW()
        WHERE id = $1
      RETURNING id, (pin_hash IS NULL) AS cleared`,
      [targetId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Staff not found' });
    recordAudit({ req, action: 'clear_pin', entity_type: 'staff', entity_id: targetId,
      meta: { cleared: true } });   // never log a PIN, a hash, or a length
    res.json({ ok: true, has_pin: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST / — create a new staff member (manager/deputy_manager only)
// Optional starting PIN (4 or 6 digits). New row defaults is_active=true.
// b237: hiring. requireRole stays; the capability gate is additional, not a swap.
router.post('/', requireRole('manager', 'deputy_manager'), requireCapabilityLevel('staff.hire', 'edit'), async (req, res) => {
  const b = req.body || {};
  const first_name = (b.first_name || '').trim();
  const last_name = (b.last_name || '').trim();
  if (!first_name || !last_name) {
    return res.status(400).json({ error: 'First and last name are required' });
  }
  const role = (b.role || 'practitioner').trim();
  if (role === 'accountant' && !require('../lib/capabilities').isOwnerRole(req.user)) { // b480 review F7
    return res.status(403).json({ error: 'Only the owner can give someone the accountant role' });
  }
  const startingPin = b.pin != null ? String(b.pin) : '';
  if (startingPin && (!/^\d+$/.test(startingPin) || (startingPin.length !== 4 && startingPin.length !== 6))) {
    return res.status(400).json({ error: 'Starting PIN must be exactly 4 or 6 digits' });
  }
  // Optionally generate a first-login PIN server-side (shown ONCE to the manager
  // in the create response — never stored in plaintext). Only when no PIN typed.
  let generatedPin = null;
  let effectivePin = startingPin;
  if (!effectivePin && (b.generate_pin === true || b.generate_pin === 'true')) {
    generatedPin = String(require('crypto').randomInt(0, 10000)).padStart(4, '0');
    effectivePin = generatedPin;
  }
  const db = getPool();
  try {
    let pinHash = null;
    let pinLength = 4;
    if (effectivePin) {
      pinHash = await bcrypt.hash(effectivePin, 10);
      pinLength = effectivePin.length;
    }
    // b177 review-queue: new staff start unable to publish observations straight to
    // parents (EyLog-style moderation) — a manager grants can_publish once they're
    // trained/confirmed (PATCH /:id/can-publish below). Existing staff, migrated via
    // ALTER ... DEFAULT true, are grandfathered and unaffected.
    const { rows } = await db.query(`
      INSERT INTO staff
        (first_name, last_name, preferred_name, email, role, room_id,
         pin_hash, pin_length, is_active, can_publish, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,false,NOW(),NOW())
      RETURNING id, first_name, last_name, preferred_name, email, role, room_id, pin_length, is_active, can_publish
    `, [
      first_name, last_name,
      (b.preferred_name || '').trim() || null,
      (b.email || '').trim() || null,
      role,
      b.room_id != null && b.room_id !== '' ? parseInt(b.room_id, 10) : null,
      pinHash, pinLength
    ]);
    recordAudit({ req, action: 'create', entity_type: 'staff', entity_id: rows[0].id,
      meta: { role, pin_set: !!effectivePin, pin_generated: !!generatedPin } });
    res.status(201).json(generatedPin ? { ...rows[0], generated_pin: generatedPin } : rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /:id/deactivate — soft-deactivate (manager/deputy_manager only)
// NEVER deactivates id=1 (Toby). Sets is_active=false; data is retained.
// b237: terminating a member of staff. requireRole stays.
router.patch('/:id/deactivate', requireRole('manager', 'deputy_manager'), requireCapabilityLevel('staff.terminate', 'edit'), async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (targetId === 1) {
    return res.status(403).json({ error: 'The owner account cannot be deactivated' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      'UPDATE staff SET is_active=false, updated_at=NOW() WHERE id=$1 RETURNING id, first_name, last_name, is_active',
      [targetId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Staff not found' });
    recordAudit({ req, action: 'deactivate', entity_type: 'staff', entity_id: targetId });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /:id/reactivate — restore a soft-deactivated staff member (manager only)
router.patch('/:id/reactivate', requireRole('manager', 'deputy_manager'), requireCapabilityLevel('staff.hire', 'edit'), async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  try {
    const db = getPool();
    const { rows } = await db.query(
      // b212: clear termination_date too — otherwise staff-termination-roll.js
      // re-archives them on the next nightly run and the restore silently undoes itself.
      'UPDATE staff SET is_active=true, termination_date=NULL, updated_at=NOW() WHERE id=$1 RETURNING id, first_name, last_name, is_active, termination_date',
      [targetId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Staff not found' });
    recordAudit({ req, action: 'reactivate', entity_type: 'staff', entity_id: targetId });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/reactivate — b212, the mirror of POST /api/children/:id/reactivate.
// Same behaviour as the PATCH above (which predates it and stays for the HR page);
// this exists so the Quick-actions panel and the children/staff flows are symmetric.
// Clears termination_date so the nightly roll doesn't immediately archive them again.
router.post('/:id/reactivate', requireRole('manager', 'deputy_manager'), requireCapabilityLevel('staff.hire', 'edit'), async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'Bad staff id' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE staff SET is_active=true, termination_date=NULL, updated_at=NOW()
       WHERE id=$1 RETURNING id, first_name, last_name, role, is_active, termination_date`,
      [targetId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Staff not found' });
    recordAudit({ req, action: 'reactivate', entity_type: 'staff', entity_id: targetId });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /:id/absences
router.get('/:id/absences', async (req, res) => {
  const canViewOthers = hasRole(req.user, ['manager','deputy_manager', 'admin']);
  if (!canViewOthers && req.user.id !== parseInt(req.params.id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT * FROM absence_requests WHERE staff_id=$1 ORDER BY start_date DESC LIMIT 50`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /:id/training — mandatory training records for a staff member
// Backs the "Mandatory Training" tab in hr/my-cpd.html (was 404 — route was missing).
router.get('/:id/training', async (req, res) => {
  const canViewOthers = hasRole(req.user, ['manager','deputy_manager', 'admin']);
  if (!canViewOthers && req.user.id !== parseInt(req.params.id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, staff_id, training_type, completed_date, expiry_date, provider, certificate_url
         FROM mandatory_training
        WHERE staff_id=$1
        ORDER BY (expiry_date IS NULL), expiry_date ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Work-pattern importer ─────────────────────────────────────────────────────
// POST /import-workpattern  (manager/deputy_manager only)
// Accepts multipart .xlsx or .csv upload with columns:
//   First, Last, Hours per week, Hourly Rate, Qualification, Years of Service,
//   Monday, Tuesday, Wednesday, Thursday, Friday, Lunch break, Room
//
// Shift cell format: "H-H", "H.MM-H.MM", empty = day off.
// Ambiguity rule: hours 1-6 in the end position → treat as pm (add 12).
//   e.g. "8-6" → 08:00-18:00, "8-1.30" → 08:00-13:30, "7.45-6" → 07:45-18:00.
//   Hours ≥7 kept as-is (morning). No nursery shifts start before 07:00.

function _parseShiftTime(raw) {
  // raw e.g. "7.45" or "6" or "1.30" or "10"
  raw = String(raw).trim();
  const dotIdx = raw.indexOf('.');
  let h, m;
  if (dotIdx >= 0) {
    h = parseInt(raw.slice(0, dotIdx), 10);
    const minStr = raw.slice(dotIdx + 1).padEnd(2, '0').slice(0, 2);
    m = parseInt(minStr, 10);
  } else {
    h = parseInt(raw, 10);
    m = 0;
  }
  if (isNaN(h) || isNaN(m)) return null;
  // Hours 1-6 are afternoon in a nursery context (nursery opens 08:00, closes 18:00)
  if (h >= 1 && h <= 6) h += 12;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function _parseShiftCell(cell) {
  // Returns { start, end } or null if day off, or { error } if unparseable
  if (cell === null || cell === undefined || String(cell).trim() === '' || String(cell).trim().toLowerCase() === 'none') {
    return null; // day off
  }
  const s = String(cell).trim();
  const dashIdx = s.lastIndexOf('-');
  if (dashIdx < 1) return { error: `Cannot parse shift "${cell}"` };
  const startRaw = s.slice(0, dashIdx).trim();
  const endRaw   = s.slice(dashIdx + 1).trim();
  const start = _parseShiftTime(startRaw);
  const end   = _parseShiftTime(endRaw);
  if (!start) return { error: `Bad start time in "${cell}"` };
  if (!end)   return { error: `Bad end time in "${cell}"` };
  return { start, end };
}

const QUAL_LEVEL = { l6: 6, l5: 5, l4: 4, l3: 3, l2: 2, apprentice: 1, unqual: 0 };
function _qualLevel(q) {
  if (!q) return null;
  const k = String(q).toLowerCase().replace(/\s+/g, '');
  return QUAL_LEVEL[k] ?? null;
}

router.post('/import-workpattern', requireRole('manager', 'deputy_manager'), (req, res, next) => {
  const upload = getUpload();
  if (!upload) return res.status(500).json({ error: 'multer not installed' });
  upload.single('file')(req, res, next);
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let rows;
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  } catch (e) {
    return res.status(400).json({ error: `Could not parse file: ${e.message}` });
  }

  if (!rows.length) return res.status(400).json({ error: 'Empty file' });

  // Find header row
  const hdr = rows[0].map(h => String(h || '').trim().toLowerCase());
  const col = name => hdr.indexOf(name.toLowerCase());
  const idxFirst = col('first');
  const idxLast  = col('last');
  if (idxFirst < 0 || idxLast < 0) {
    return res.status(400).json({ error: 'Missing First/Last columns in header' });
  }
  const idxHours   = col('hours per week');
  const idxRate    = col('hourly rate');
  const idxQual    = col('qualification');
  const idxYears   = col('years of service');
  const idxMon     = col('monday');
  const idxTue     = col('tuesday');
  const idxWed     = col('wednesday');
  const idxThu     = col('thursday');
  const idxFri     = col('friday');
  const idxLunch   = col('lunch break');
  const idxRoom    = col('room');

  const db = getPool();
  const dataRows = rows.slice(1).filter(r => r[idxFirst] || r[idxLast]);

  const matched = [];
  const unmatched = [];
  let totalShifts = 0;

  for (const row of dataRows) {
    const first = String(row[idxFirst] || '').trim();
    const last  = String(row[idxLast]  || '').trim();
    if (!first && !last) continue;

    // Look up staff by case-insensitive first+last name match
    const { rows: staffRows } = await db.query(
      'SELECT id FROM staff WHERE lower(first_name)=$1 AND lower(last_name)=$2 AND is_active=true',
      [first.toLowerCase(), last.toLowerCase()]
    );

    if (!staffRows.length) {
      unmatched.push({ first, last, reason: 'No active staff found with this name' });
      continue;
    }

    const staffId = staffRows[0].id;
    const qualText  = idxQual >= 0 ? String(row[idxQual] || '').trim() || null : null;
    const qualLevel = _qualLevel(qualText);
    const hoursPerWeek = idxHours >= 0 && row[idxHours] != null ? parseFloat(row[idxHours]) : null;
    const hourlyRate   = idxRate  >= 0 && row[idxRate]  != null ? parseFloat(row[idxRate])  : null;
    const yearsService = idxYears >= 0 && row[idxYears] != null ? parseInt(row[idxYears], 10) : null;
    const lunchMins    = idxLunch >= 0 && row[idxLunch] != null ? parseInt(String(row[idxLunch]).replace(/[^0-9]/g, ''), 10) || 0 : 0;
    const room         = idxRoom  >= 0 && row[idxRoom]  != null ? String(row[idxRoom]).trim() || null : null;

    // Update staff row (skip annual_salary — it is a generated column)
    const staffUpdates = [];
    const staffVals = [];
    if (hourlyRate   !== null && !isNaN(hourlyRate))   { staffUpdates.push(`hourly_rate=$${staffUpdates.length+1}`);   staffVals.push(hourlyRate); }
    if (qualText)                                       { staffUpdates.push(`qualification=$${staffUpdates.length+1}`); staffVals.push(qualText); }
    if (qualLevel    !== null)                          { staffUpdates.push(`qualification_level=$${staffUpdates.length+1}`); staffVals.push(qualLevel); }
    if (yearsService !== null && !isNaN(yearsService)) { staffUpdates.push(`years_of_service=$${staffUpdates.length+1}`); staffVals.push(yearsService); }
    if (hoursPerWeek !== null && !isNaN(hoursPerWeek)) { staffUpdates.push(`hours_per_week=$${staffUpdates.length+1}`); staffVals.push(hoursPerWeek); }

    if (staffUpdates.length) {
      staffVals.push(staffId);
      await db.query(`UPDATE staff SET ${staffUpdates.join(',')}, updated_at=NOW() WHERE id=$${staffVals.length}`, staffVals);
    }

    // Insert/replace work patterns for Mon(0)-Fri(4)
    const dayCols = [idxMon, idxTue, idxWed, idxThu, idxFri];
    let shiftsForStaff = 0;
    const parseErrors = [];

    for (let dow = 0; dow < 5; dow++) {
      const cellIdx = dayCols[dow];
      const cell = cellIdx >= 0 ? row[cellIdx] : null;
      const parsed = _parseShiftCell(cell);

      if (parsed && parsed.error) {
        parseErrors.push(parsed.error);
        continue;
      }

      const isOff = parsed === null;
      const start = isOff ? null : parsed.start;
      const end   = isOff ? null : parsed.end;

      await db.query(`
        INSERT INTO staff_work_patterns
          (staff_id, day_of_week, shift_start, shift_end, is_off, lunch_break_minutes, room, effective_from)
        VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE)
        ON CONFLICT (staff_id, day_of_week, effective_from)
        DO UPDATE SET shift_start=$3, shift_end=$4, is_off=$5, lunch_break_minutes=$6, room=$7, updated_at=NOW()
      `, [staffId, dow, start, end, isOff, lunchMins, room]);
      shiftsForStaff++;
    }

    totalShifts += shiftsForStaff;

    if (parseErrors.length) {
      unmatched.push({ first, last, reason: parseErrors.join('; ') });
    } else {
      matched.push({ staff_id: staffId, name: `${first} ${last}`, patterns_inserted: shiftsForStaff });
    }
  }

  res.json({
    matched,
    unmatched,
    summary: {
      total_rows: dataRows.length,
      matched: matched.length,
      unmatched: unmatched.length,
      shifts_created: totalShifts,
    },
  });
});

// POST /:id/photo — staff profile photo (2026-07-11). Served from /uploads/staff-photos.
const _staffPhotoDir = '/app/uploads/staff-photos';
const _staffPhotoUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb){ fs.mkdirSync(_staffPhotoDir, { recursive: true }); cb(null, _staffPhotoDir); },
    // sec-20261026: the extension is chosen by the server from the (already
    // filtered) mimetype, never taken from the client's filename — an
    // `x.html` declared as image/png used to be saved as `<id>.html`.
    filename(req, file, cb){ const ext=({'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp'})[file.mimetype]||'.jpg'; cb(null, String(req.params.id)+ext); },
  }),
  limits: { fileSize: 8*1024*1024 },
  fileFilter(req, file, cb){ cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype)); },
});
// sec-20261026: validate the id and the caller BEFORE multer writes anything.
// `:id` is URL-decoded by express, so `..%2F..%2Fapp%2Fpublic%2Fjs%2Fx` reached
// the filename above as a path and multer wrote the upload outside the photo
// folder (as root) before the role check below ever ran.
function _staffPhotoPreflight(req, res, next) {
  if (!/^\d+$/.test(String(req.params.id || ''))) return res.status(400).json({ error: 'Invalid staff id' });
  const canEditOthers = hasRole(req.user, ['manager','deputy_manager', 'admin']);
  if (!canEditOthers && Number(req.user && req.user.id) !== parseInt(req.params.id, 10)) return res.status(403).json({ error: 'Forbidden' });
  next();
}
router.post('/:id/photo', _staffPhotoPreflight, _staffPhotoUpload.single('photo'), async (req, res) => {
  const canEditOthers = hasRole(req.user, ['manager','deputy_manager', 'admin']);
  if (!canEditOthers && req.user.id !== parseInt(req.params.id)) return res.status(403).json({ error: 'Forbidden' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const url = '/uploads/staff-photos/' + req.file.filename;
  try {
    await getPool().query('UPDATE staff SET photo_url=$1, updated_at=NOW() WHERE id=$2', [url, req.params.id]);
    res.json({ photo_url: url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

// BrightHR import — multer parses multipart upload in-memory
let _multer;
function getUpload() {
  if (!_multer) {
    try { _multer = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 10*1024*1024 } }); }
    catch { return null; }
  }
  return _multer;
}

// sec-20261026: this route had `authenticate` only — any member of staff could
// upload a CSV that rewrote any colleague's role, active flag and contact
// details (matched by name), or create a staff row. Same gate as POST / (hire).
// It also refuses to touch staff id 1 (absolute rule: Toby's record).
router.post('/import-brighthr', requireRole('manager', 'deputy_manager'), requireCapabilityLevel('staff.hire', 'edit'), (req, res, next) => {
  const upload = getUpload();
  if (!upload) return res.status(500).json({ error: 'multer not installed — run: npm install multer' });
  upload.single('file')(req, res, next);
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const csv = req.file.buffer.toString('utf-8').replace(/^\uFEFF/, '');
  const lines = csv.split('\n');
  const data = {};
  let section = null, hdrs = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) { section = null; continue; }
    if (l.startsWith('Personal Details:'))    { section='personal';  i++; hdrs=lines[i].split(',').map(h=>h.trim().replace(/"/g,'')); continue; }
    if (l.startsWith('Terms of Employment:')) { section='terms';     i++; hdrs=lines[i].split(',').map(h=>h.trim().replace(/"/g,'')); continue; }
    if (l.startsWith('Employment Contracts:')){ section='contract';  i++; hdrs=lines[i].split(',').map(h=>h.trim().replace(/"/g,'')); continue; }
    if (l.startsWith('User Information:'))    { section='user';      i++; hdrs=lines[i].split(',').map(h=>h.trim().replace(/"/g,'')); continue; }
    if (section && hdrs.length) {
      const vals = l.split(',');
      hdrs.forEach((h,idx) => { data[`${section}_${h}`] = (vals[idx]||'').replace(/^"|"$/g,'').trim(); });
      section = null;
    }
  }
  const pd = s => { if(!s||s==='N/A')return null; const d=new Date(s); return isNaN(d)?null:d.toISOString().split('T')[0]; };
  const jt = data['terms_Job Title']||'';
  const roleMap = {'Room Leader':'room_leader','Deputy Manager':'deputy_manager','Manager':'manager','Apprentice':'apprentice','Cook':'cook'};
  const role = Object.entries(roleMap).find(([k])=>jt.toLowerCase().includes(k.toLowerCase()))?.[1]||'practitioner';
  const staff = {
    first_name: data['personal_First Name']||'',
    last_name:  data['personal_Last Name']||'',
    email:      data['user_Email Address']||data['personal_Work Email Address']||'',
    phone:      data['personal_Mobile Number']||'',
    date_of_birth: pd(data['personal_Date of Birth']),
    address_line1: data['personal_Address Line 1']||'',
    postcode:   data['personal_PostCode']||'',
    role, contracted_hours: parseFloat(data['contract_Hours Per Week'])||null,
    contract_start: pd(data['terms_Start Date']),
    is_active: !data['terms_End Date']||!pd(data['terms_End Date']),
  };
  if (!staff.first_name||!staff.last_name) return res.status(400).json({ error: 'Could not parse name' });
  const db = getPool();
  try {
    const { rows } = await db.query('SELECT id FROM staff WHERE first_name=$1 AND last_name=$2',[staff.first_name,staff.last_name]);
    if (rows.some(r => Number(r.id) === 1)) return res.status(403).json({ error: 'This record cannot be changed by an import' });
    if (rows.length) {
      const keys=Object.keys(staff);
      await db.query(`UPDATE staff SET ${keys.map((k,i)=>`${k}=$${i+1}`).join(',')} WHERE id=$${keys.length+1}`,[...Object.values(staff),rows[0].id]);
      res.json({ action:'updated', name:`${staff.first_name} ${staff.last_name}` });
    } else {
      const keys=Object.keys(staff);
      await db.query(`INSERT INTO staff (${keys.join(',')}) VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')})`,[...Object.values(staff)]);
      res.json({ action:'created', name:`${staff.first_name} ${staff.last_name}` });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});
