'use strict';
/**
 * setting-incidents.js — b193 (2026-08-19). Mounted at /api/setting-incidents.
 *
 * THE THIRD RECORD. Wren already had two, and neither fits a kitchen fire:
 *
 *   ladn.incidents             accidents and injuries. Injury-shaped
 *                              (injury_description, first_aid_given, body_map,
 *                              RIDDOR, hospital transfer) and child-centric.
 *   ladn.safeguarding_concerns abuse and safeguarding. DSL/LADO/MASH workflow,
 *                              hash-chained, the four statutory abuse types.
 *
 * A fire, an intruder, a burst pipe, a lost child, an adult who arrives drunk at
 * collection, a power cut, a food-poisoning outbreak, a medication error or a
 * near miss is a SIGNIFICANT EVENT AT THE SETTING. It frequently has no single
 * child, and none of the injury columns apply — so it gets its own table with
 * 0..n linked children rather than a flag on one of the other two. Neither of
 * those two tables is touched by this build.
 *
 *   GET  /                     list (category / status / severity / from / to /
 *                              ofsted / q), manager + room leader
 *   GET  /categories           the seeded catalogue, grouped, with form prompts
 *   GET  /stats                counts by status/severity/group + Ofsted position
 *   GET  /:id                  one incident with its linked children
 *   POST /                     create (children[] is 0..n)
 *   PUT  /:id                  update
 *   POST /:id/close            close — REJECTED without actions_taken AND
 *                              lessons_learned. An incident cannot be closed empty.
 *   POST /:id/escalate-to-safeguarding
 *                              create a linked safeguarding_concerns row and
 *                              store the link. NEVER automatic — a lost child or
 *                              an adult under the influence very often IS also a
 *                              safeguarding matter, but that is a judgement.
 *   POST /upload, GET /photo/:f, DELETE /photo/:f    photo attachments
 *
 * OFSTED NOTIFICATION (new to Wren in b193 — there was no such concept anywhere)
 *   EYFS requires providers to notify Ofsted of significant events affecting
 *   their suitability to care for children, and of food poisoning affecting two
 *   or more children, as soon as reasonably practicable and in any event within
 *   14 days. When ofsted_notifiable is true, ofsted_due_by is set to
 *   occurred_at + settings.ofsted_notification_days (default 14). The b186
 *   compliance sweep picks it up as kind 'ofsted_notification', so an
 *   un-notified event chases itself every night until it is notified.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { notify } = require('../services/notification-dispatcher');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

const MGR_ROLES    = ['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager'];
const LEADER_ROLES = MGR_ROLES.concat(['room_leader']);

const SEVERITIES = ['minor', 'significant', 'major'];
const STATUSES   = ['open', 'under_review', 'closed'];
const DEFAULT_OFSTED_DAYS = 14;

// ── Parents portal: deny everything ──────────────────────────────────────────
// Mirrors safeguarding.js. A setting incident is an internal operational record;
// parents are told what happened through parents_message, not through this API.
router.use((req, res, next) => {
  if (req._portal === 'parents') return res.status(403).json({ error: 'Forbidden' });
  next();
});

// GET /photo/:filename does its own auth (a plain <img src> carries no headers).
router.use((req, res, next) => {
  if (req.method === 'GET' && /^\/photo\//.test(req.path)) return next();
  return authenticate(req, res, next);
});

router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid id' });
  next();
});

function requireLeader(req, res, next) {
  if (!LEADER_ROLES.includes(req.user && req.user.role)) {
    return res.status(403).json({ error: 'Setting incidents are restricted to managers and room leaders' });
  }
  next();
}
function requireManager(req, res, next) {
  if (!MGR_ROLES.includes(req.user && req.user.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
}

/* ── helpers ───────────────────────────────────────────────────────────────── */

const trimOrNull = v => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const boolOrNull = v => (v === undefined || v === null ? null : !!v);
const intOrNull = v => {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};
/** text[] from an array or a comma-separated string. Empty → null, not []. */
const textArrayOrNull = v => {
  if (v === undefined || v === null) return null;
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const out = arr.map(x => String(x == null ? '' : x).trim()).filter(Boolean).slice(0, 20);
  return out.length ? out : null;
};

/** The statutory notification window, overridable per setting. */
async function ofstedDays(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'ofsted_notification_days'`);
    const n = parseInt(rows[0] && rows[0].value, 10);
    if (Number.isFinite(n) && n > 0) return n;
  } catch (_) { /* settings unavailable — use the statutory outside limit */ }
  return DEFAULT_OFSTED_DAYS;
}

/** occurred_at + N days, as YYYY-MM-DD. Returns null when there is no clock. */
function dueBy(occurredAt, days) {
  const d = new Date(occurredAt);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getTime() + days * 86400000).toISOString().slice(0, 10);
}

/**
 * Allocate SI-YYYY-NNN. Serialised by a SHARE ROW EXCLUSIVE lock so two
 * simultaneous reports can never claim the same reference — the whole point of
 * a human ref is that it is unique on paper.
 */
async function nextRef(client, occurredAt) {
  const year = new Date(occurredAt).getUTCFullYear() || new Date().getUTCFullYear();
  await client.query('LOCK TABLE setting_incidents IN SHARE ROW EXCLUSIVE MODE');
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM setting_incidents WHERE incident_ref LIKE $1`, [`SI-${year}-%`]);
  return `SI-${year}-${String(rows[0].n + 1).padStart(3, '0')}`;
}

/** The children linked to a set of incidents, keyed by incident id. */
async function childrenFor(db, ids) {
  if (!ids.length) return {};
  const { rows } = await db.query(`
    SELECT sic.incident_id, sic.child_id, sic.note,
           btrim(coalesce(ch.preferred_name, ch.first_name, '') || ' ' || coalesce(ch.last_name, '')) AS child_name
      FROM setting_incident_children sic
      LEFT JOIN children ch ON ch.id = sic.child_id
     WHERE sic.incident_id = ANY($1::bigint[])
     ORDER BY sic.incident_id, sic.child_id`, [ids]);
  return rows.reduce((m, r) => {
    (m[r.incident_id] = m[r.incident_id] || []).push(
      { child_id: r.child_id, child_name: (r.child_name || '').trim() || `#${r.child_id}`, note: r.note });
    return m;
  }, {});
}

/** Replace the linked-children set for an incident. [] genuinely means "none". */
async function setChildren(client, incidentId, children) {
  await client.query('DELETE FROM setting_incident_children WHERE incident_id = $1', [incidentId]);
  for (const c of children) {
    const childId = intOrNull(typeof c === 'object' && c !== null ? c.child_id : c);
    if (!childId) continue;
    await client.query(
      `INSERT INTO setting_incident_children (incident_id, child_id, note)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [incidentId, childId, trimOrNull(typeof c === 'object' && c !== null ? c.note : null)]);
  }
}

/* ── GET /categories ───────────────────────────────────────────────────────── */
// Grouped for the picker. Kept unfiltered by role: a room leader has to be able
// to read the list before they can choose the right route for what they saw.
router.get('/categories', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT id, label, group_name, default_severity, ofsted_notifiable_default, prompts, sort_order
        FROM setting_incident_categories
       WHERE is_active = true
       ORDER BY sort_order, label`);
    const groups = [];
    for (const r of rows) {
      let g = groups.find(x => x.group_name === r.group_name);
      if (!g) groups.push(g = { group_name: r.group_name, categories: [] });
      g.categories.push(r);
    }
    res.json({ count: rows.length, groups, categories: rows });
  } catch (err) {
    console.error('setting-incidents/categories error:', err.message);
    res.status(500).json({ error: 'Failed to load categories' });
  }
});

/* ── GET /stats ────────────────────────────────────────────────────────────── */
router.get('/stats', requireLeader, async (req, res) => {
  const db = getPool();
  const days = Math.min(1095, Math.max(1, parseInt(req.query.days, 10) || 365));
  try {
    const { rows: tot } = await db.query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status = 'open')::int         AS open,
             count(*) FILTER (WHERE status = 'under_review')::int  AS under_review,
             count(*) FILTER (WHERE status = 'closed')::int        AS closed,
             count(*) FILTER (WHERE severity = 'major')::int       AS major,
             count(*) FILTER (WHERE severity = 'significant')::int AS significant,
             count(*) FILTER (WHERE severity = 'minor')::int       AS minor,
             count(*) FILTER (WHERE evacuation_required)::int      AS evacuations,
             count(*) FILTER (WHERE emergency_services_called)::int AS emergency_services,
             count(*) FILTER (WHERE safeguarding_concern_id IS NOT NULL)::int AS escalated
        FROM setting_incidents
       WHERE occurred_at >= now() - ($1::int * interval '1 day')`, [days]);

    const { rows: ofsted } = await db.query(`
      SELECT count(*) FILTER (WHERE ofsted_notifiable)::int AS notifiable,
             count(*) FILTER (WHERE ofsted_notifiable AND ofsted_notified_at IS NOT NULL)::int AS notified,
             count(*) FILTER (WHERE ofsted_notifiable AND ofsted_notified_at IS NULL
                                AND ofsted_due_by < current_date)::int AS overdue,
             count(*) FILTER (WHERE ofsted_notifiable AND ofsted_notified_at IS NULL
                                AND ofsted_due_by >= current_date)::int AS pending
        FROM setting_incidents
       WHERE occurred_at >= now() - ($1::int * interval '1 day')`, [days]);

    const { rows: byGroup } = await db.query(`
      SELECT coalesce(c.group_name, 'Uncategorised') AS group_name, count(*)::int AS n
        FROM setting_incidents si
        LEFT JOIN setting_incident_categories c ON c.id = si.category
       WHERE si.occurred_at >= now() - ($1::int * interval '1 day')
       GROUP BY 1 ORDER BY n DESC`, [days]);

    res.json({ window_days: days, generated_at: new Date().toISOString(),
               totals: tot[0], ofsted: ofsted[0], by_group: byGroup });
  } catch (err) {
    console.error('setting-incidents/stats error:', err.message);
    res.status(500).json({ error: 'Failed to build stats' });
  }
});

/* ── GET / — the list ──────────────────────────────────────────────────────── */
router.get('/', requireLeader, async (req, res) => {
  const db = getPool();
  const where = [], params = [];
  // `$$` is replaced by the placeholder number — globally, so a clause can use
  // the same bound value more than once (the free-text search does).
  const add = (sql, val) => { params.push(val); where.push(sql.split('$$').join(`$${params.length}`)); };

  if (req.query.category) add('si.category = ANY($$::text[])', String(req.query.category).split(',').map(s => s.trim()).filter(Boolean));
  if (req.query.status)   add('si.status   = ANY($$::text[])', String(req.query.status).split(',').map(s => s.trim()).filter(Boolean));
  if (req.query.severity) add('si.severity = ANY($$::text[])', String(req.query.severity).split(',').map(s => s.trim()).filter(Boolean));
  if (req.query.group)    add('c.group_name = $$', String(req.query.group));
  if (req.query.from)     add('si.occurred_at >= $$::timestamptz', String(req.query.from));
  if (req.query.to)       add('si.occurred_at <  ($$::date + 1)', String(req.query.to));
  if (req.query.q)        add('(si.description ILIKE $$ OR si.location ILIKE $$ OR si.incident_ref ILIKE $$)', `%${req.query.q}%`);
  // ofsted=due → notifiable and not yet notified; ofsted=overdue → past the 14 days.
  if (req.query.ofsted === 'due')     where.push('si.ofsted_notifiable AND si.ofsted_notified_at IS NULL');
  if (req.query.ofsted === 'overdue') where.push('si.ofsted_notifiable AND si.ofsted_notified_at IS NULL AND si.ofsted_due_by < current_date');
  if (req.query.ofsted === 'any')     where.push('si.ofsted_notifiable');

  const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  try {
    // The q filter reuses one placeholder three times, so build it explicitly.
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const { rows } = await db.query(`
      SELECT si.*, c.label AS category_label, c.group_name,
             btrim(coalesce(s.preferred_name, s.first_name, '') || ' ' || coalesce(s.last_name, '')) AS reported_by_name,
             (SELECT count(*)::int FROM setting_incident_children x WHERE x.incident_id = si.id) AS children_linked,
             (si.ofsted_notifiable AND si.ofsted_notified_at IS NULL AND si.ofsted_due_by < current_date) AS ofsted_overdue
        FROM setting_incidents si
        LEFT JOIN setting_incident_categories c ON c.id = si.category
        LEFT JOIN staff s ON s.id = si.reported_by
        ${clause}
       ORDER BY si.occurred_at DESC, si.id DESC
       LIMIT ${limit} OFFSET ${offset}`, params);

    const kids = await childrenFor(db, rows.map(r => r.id));
    res.json({
      count: rows.length, limit, offset,
      incidents: rows.map(r => Object.assign({}, r, { children: kids[r.id] || [] })),
    });
  } catch (err) {
    console.error('setting-incidents list error:', err.message);
    res.status(500).json({ error: 'Failed to load setting incidents' });
  }
});

/* ── GET /:id ──────────────────────────────────────────────────────────────── */
router.get('/:id', requireLeader, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT si.*, c.label AS category_label, c.group_name, c.prompts,
             btrim(coalesce(s.preferred_name, s.first_name, '') || ' ' || coalesce(s.last_name, '')) AS reported_by_name,
             btrim(coalesce(m.preferred_name, m.first_name, '') || ' ' || coalesce(m.last_name, '')) AS manager_reviewed_by_name,
             (si.ofsted_notifiable AND si.ofsted_notified_at IS NULL AND si.ofsted_due_by < current_date) AS ofsted_overdue
        FROM setting_incidents si
        LEFT JOIN setting_incident_categories c ON c.id = si.category
        LEFT JOIN staff s ON s.id = si.reported_by
        LEFT JOIN staff m ON m.id = si.manager_reviewed_by
       WHERE si.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const kids = await childrenFor(db, [rows[0].id]);
    res.json(Object.assign({}, rows[0], { children: kids[rows[0].id] || [] }));
  } catch (err) {
    console.error('setting-incidents get error:', err.message);
    res.status(500).json({ error: 'Failed to load the incident' });
  }
});

/* ── POST / — create ───────────────────────────────────────────────────────── */
router.post('/', requireLeader, async (req, res) => {
  const b = req.body || {};
  const description = trimOrNull(b.description);
  const category    = trimOrNull(b.category);
  if (!description) return res.status(400).json({ error: 'description is required — say what happened' });
  if (!category)    return res.status(400).json({ error: 'category is required' });

  const db = getPool();
  const client = await db.connect();
  try {
    const { rows: cat } = await client.query(
      `SELECT id, label, default_severity, ofsted_notifiable_default
         FROM setting_incident_categories WHERE id = $1`, [category]);
    if (!cat.length) return res.status(400).json({ error: `Unknown category "${category}"` });

    const severity = SEVERITIES.includes(b.severity) ? b.severity : cat[0].default_severity;
    const occurredAt = b.occurred_at ? new Date(b.occurred_at) : new Date();
    if (isNaN(occurredAt.getTime())) return res.status(400).json({ error: 'occurred_at is not a valid date/time' });

    // Ofsted-notifiable: the reporter's explicit answer wins; otherwise the
    // category default. Food poisoning is seeded notifiable because the
    // statutory trigger is TWO OR MORE children — starting the 14-day clock and
    // letting a manager untick a single-child case is the safe way round.
    const notifiable = (b.ofsted_notifiable === undefined || b.ofsted_notifiable === null)
      ? !!cat[0].ofsted_notifiable_default
      : !!b.ofsted_notifiable;
    const days   = await ofstedDays(db);
    const due    = notifiable ? dueBy(occurredAt, days) : null;

    const children = Array.isArray(b.children) ? b.children : [];

    await client.query('BEGIN');
    const ref = await nextRef(client, occurredAt);
    const { rows } = await client.query(`
      INSERT INTO setting_incidents (
        incident_ref, category, severity, occurred_at, discovered_at, location,
        description, immediate_action, reported_by, witness_names,
        children_present, staff_present, evacuation_required, evacuation_completed_at,
        roll_call_complete, roll_call_notes,
        emergency_services_called, services_attended, external_ref,
        ofsted_notifiable, ofsted_due_by,
        riddor_dangerous_occurrence, other_agencies,
        parents_informed, parents_informed_at, parents_message,
        root_cause, actions_taken, lessons_learned, preventive_actions,
        status, photo_urls)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::text[],$19,
              $20,$21::date,$22,$23::text[],$24,$25,$26,$27,$28,$29,$30,$31,$32::text[])
      RETURNING *`, [
      ref, category, severity, occurredAt.toISOString(),
      b.discovered_at || null, trimOrNull(b.location),
      description, trimOrNull(b.immediate_action),
      intOrNull(b.reported_by) || (req.user && req.user.id) || null, trimOrNull(b.witness_names),
      intOrNull(b.children_present), intOrNull(b.staff_present),
      b.evacuation_required === undefined ? false : !!b.evacuation_required,
      b.evacuation_completed_at || null,
      boolOrNull(b.roll_call_complete), trimOrNull(b.roll_call_notes),
      b.emergency_services_called === undefined ? false : !!b.emergency_services_called,
      textArrayOrNull(b.services_attended), trimOrNull(b.external_ref),
      notifiable, due,
      b.riddor_dangerous_occurrence === undefined ? false : !!b.riddor_dangerous_occurrence,
      textArrayOrNull(b.other_agencies),
      b.parents_informed === undefined ? false : !!b.parents_informed,
      b.parents_informed_at || null, trimOrNull(b.parents_message),
      trimOrNull(b.root_cause), trimOrNull(b.actions_taken),
      trimOrNull(b.lessons_learned), trimOrNull(b.preventive_actions),
      STATUSES.includes(b.status) ? b.status : 'open',
      textArrayOrNull(b.photo_urls),
    ]);
    const inc = rows[0];
    await setChildren(client, inc.id, children);
    await client.query('COMMIT');

    // Managers are told immediately. Counts and the category only — no child is
    // named in the notification body.
    const linked = children.length;
    notify(severity === 'major' ? 'incident_severe' : 'incident_reported', 'all-managers', null,
      `${severity === 'major' ? '🚨' : '⚠️'} Setting incident: ${cat[0].label}`,
      [`Ref ${ref} — ${cat[0].label} (${severity}).`,
       `Reported by ${(req.user && (req.user.first_name || req.user.name)) || 'a staff member'}.`,
       linked ? `${linked} child record(s) linked.` : 'No individual child is linked to this event.',
       notifiable ? `OFSTED-NOTIFIABLE — notify by ${due}.` : '',
      ].filter(Boolean).join('\n'),
      { priority: severity === 'major' ? 'urgent' : 'normal',
        relatedTable: 'setting_incidents', relatedId: inc.id,
        link: '/setting-incidents.html' });

    res.status(201).json(Object.assign({}, inc, {
      category_label: cat[0].label,
      children_linked: linked,
      ofsted_notification_days: days,
      notifiable_note: (category === 'food_poisoning' && notifiable)
        ? 'Ofsted must be notified of food poisoning affecting TWO OR MORE children. '
          + 'The clock has been started; a manager can clear ofsted_notifiable if only one child is affected.'
        : null,
    }));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    console.error('setting-incidents create error:', err.message);
    res.status(500).json({ error: 'Failed to save the incident' });
  } finally {
    client.release();
  }
});

/* ── PUT /:id — update ─────────────────────────────────────────────────────── */
// Whitelisted column-by-column. Closing is deliberately NOT possible here — it
// goes through POST /:id/close so the actions/lessons gate can never be bypassed.
const TEXT_FIELDS = ['location', 'description', 'immediate_action', 'witness_names',
  'roll_call_notes', 'external_ref', 'ofsted_reference', 'parents_message',
  'root_cause', 'actions_taken', 'lessons_learned', 'preventive_actions'];
const BOOL_FIELDS = ['evacuation_required', 'roll_call_complete', 'emergency_services_called',
  'ofsted_notifiable', 'riddor_dangerous_occurrence', 'parents_informed'];
const INT_FIELDS  = ['children_present', 'staff_present'];
const TS_FIELDS   = ['discovered_at', 'evacuation_completed_at', 'ofsted_notified_at',
  'riddor_notified_at', 'parents_informed_at'];
const ARR_FIELDS  = ['services_attended', 'other_agencies', 'photo_urls'];

router.put('/:id', requireLeader, async (req, res) => {
  const b = req.body || {};
  const db = getPool();
  const client = await db.connect();
  const has = k => Object.prototype.hasOwnProperty.call(b, k);

  try {
    const { rows: cur } = await client.query('SELECT * FROM setting_incidents WHERE id = $1', [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Not found' });

    const sets = [], vals = [];
    const put = (col, val, cast) => { vals.push(val); sets.push(`${col} = $${vals.length}${cast || ''}`); };

    for (const f of TEXT_FIELDS) if (has(f)) put(f, trimOrNull(b[f]));
    for (const f of BOOL_FIELDS) if (has(f)) put(f, boolOrNull(b[f]));
    for (const f of INT_FIELDS)  if (has(f)) put(f, intOrNull(b[f]));
    for (const f of TS_FIELDS)   if (has(f)) put(f, b[f] || null, '::timestamptz');
    for (const f of ARR_FIELDS)  if (has(f)) put(f, textArrayOrNull(b[f]), '::text[]');
    if (has('severity')) {
      if (!SEVERITIES.includes(b.severity)) return res.status(400).json({ error: `severity must be one of ${SEVERITIES.join(', ')}` });
      put('severity', b.severity);
    }
    if (has('status')) {
      if (!STATUSES.includes(b.status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
      if (b.status === 'closed') {
        return res.status(400).json({ error: 'Close an incident through POST /:id/close — it requires actions_taken and lessons_learned' });
      }
      put('status', b.status);
    }
    if (has('category')) {
      const { rows: cat } = await client.query('SELECT id FROM setting_incident_categories WHERE id = $1', [b.category]);
      if (!cat.length) return res.status(400).json({ error: `Unknown category "${b.category}"` });
      put('category', b.category);
    }
    if (has('occurred_at')) {
      const d = new Date(b.occurred_at);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'occurred_at is not a valid date/time' });
      put('occurred_at', d.toISOString(), '::timestamptz');
    }
    if (has('manager_reviewed') && b.manager_reviewed) {
      if (!hasRole(req.user, MGR_ROLES)) return res.status(403).json({ error: 'Only a manager can mark an incident reviewed' });
      put('manager_reviewed_by', req.user.id);
      put('manager_reviewed_at', new Date().toISOString(), '::timestamptz');
    }

    // The Ofsted clock follows whichever of the two inputs moved. Recomputed
    // from the resulting values, never from the request alone, so a PUT that
    // changes only occurred_at still moves the deadline.
    const notifiableAfter = has('ofsted_notifiable') ? !!b.ofsted_notifiable : !!cur[0].ofsted_notifiable;
    const occurredAfter   = has('occurred_at') ? new Date(b.occurred_at) : new Date(cur[0].occurred_at);
    if (has('ofsted_notifiable') || has('occurred_at')) {
      put('ofsted_due_by', notifiableAfter ? dueBy(occurredAfter, await ofstedDays(db)) : null, '::date');
    }

    if (has('children')) {
      await setChildren(client, cur[0].id, Array.isArray(b.children) ? b.children : []);
    }
    if (!sets.length && !has('children')) return res.status(400).json({ error: 'Nothing to update' });

    let out = cur[0];
    if (sets.length) {
      vals.push(req.params.id);
      const { rows } = await client.query(
        `UPDATE setting_incidents SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $${vals.length} RETURNING *`, vals);
      out = rows[0];
    }
    const kids = await childrenFor(db, [out.id]);
    res.json(Object.assign({}, out, { children: kids[out.id] || [] }));
  } catch (err) {
    console.error('setting-incidents update error:', err.message);
    res.status(500).json({ error: 'Failed to update the incident' });
  } finally {
    client.release();
  }
});

/* ── POST /:id/close ───────────────────────────────────────────────────────── */
// An incident cannot be closed empty. actions_taken says what was DONE and
// lessons_learned says what CHANGES — a closed record with neither is the thing
// an inspector finds and a setting cannot defend.
router.post('/:id/close', requireManager, async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  try {
    const { rows: cur } = await db.query('SELECT * FROM setting_incidents WHERE id = $1', [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Not found' });

    const actions = trimOrNull(b.actions_taken)   || trimOrNull(cur[0].actions_taken);
    const lessons = trimOrNull(b.lessons_learned) || trimOrNull(cur[0].lessons_learned);
    const missing = [];
    if (!actions) missing.push('actions_taken');
    if (!lessons) missing.push('lessons_learned');
    if (missing.length) {
      return res.status(400).json({
        error: 'An incident cannot be closed empty',
        missing,
        detail: 'Record what was done (actions_taken) and what changes as a result (lessons_learned) before closing.',
      });
    }

    const { rows } = await db.query(`
      UPDATE setting_incidents
         SET status = 'closed',
             actions_taken = $1,
             lessons_learned = $2,
             preventive_actions = COALESCE($3, preventive_actions),
             root_cause = COALESCE($4, root_cause),
             manager_reviewed_by = COALESCE(manager_reviewed_by, $5),
             manager_reviewed_at = COALESCE(manager_reviewed_at, now()),
             closed_by = $5, closed_at = now(), updated_at = now()
       WHERE id = $6
       RETURNING *`,
      [actions, lessons, trimOrNull(b.preventive_actions), trimOrNull(b.root_cause),
       req.user.id, req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    console.error('setting-incidents close error:', err.message);
    res.status(500).json({ error: 'Failed to close the incident' });
  }
});

/* ── POST /:id/escalate-to-safeguarding ────────────────────────────────────── */
// One click, never automatic. A missing child or an adult under the influence
// very often IS also a safeguarding matter — but "often" is not "always", and a
// record that opens a DSL workflow by itself would either flood the DSL or train
// people to ignore it. Writes an ordinary safeguarding_concerns row (no schema
// change to that table) and stores the id back on the setting incident.
router.post('/:id/escalate-to-safeguarding', requireLeader, async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  try {
    const { rows: cur } = await db.query(`
      SELECT si.*, c.label AS category_label
        FROM setting_incidents si
        LEFT JOIN setting_incident_categories c ON c.id = si.category
       WHERE si.id = $1`, [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Not found' });
    const inc = cur[0];
    if (inc.safeguarding_concern_id) {
      return res.status(409).json({ error: 'Already escalated',
        safeguarding_concern_id: inc.safeguarding_concern_id });
    }

    // Which child? The caller's choice wins; otherwise the single linked child.
    // With 0 or 2+ linked children and no explicit choice, the concern is raised
    // against no single child rather than guessing which one it is about.
    let childId = intOrNull(b.child_id);
    if (!childId) {
      const { rows: kids } = await db.query(
        'SELECT child_id FROM setting_incident_children WHERE incident_id = $1', [inc.id]);
      if (kids.length === 1) childId = kids[0].child_id;
    }

    const category = trimOrNull(b.category) || 'setting_incident';
    const severity = ['standard', 'serious', 'critical'].includes(b.severity)
      ? b.severity
      : (inc.severity === 'major' ? 'critical' : 'serious');

    const description = trimOrNull(b.description) || [
      `Escalated from setting incident ${inc.incident_ref} (${inc.category_label || inc.category}).`,
      inc.description,
      inc.immediate_action ? `Immediate action taken: ${inc.immediate_action}` : null,
    ].filter(Boolean).join('\n\n');

    const { rows } = await db.query(`
      INSERT INTO safeguarding_concerns
        (child_id, reported_by, category, subcategory, description, immediate_action,
         is_confidential, status, concern_date, severity)
      VALUES ($1,$2,$3,$4,$5,$6,true,'new',$7,$8)
      RETURNING id, child_id, category, severity, status, concern_date`, [
      childId || null, req.user.id, category,
      inc.category_label || inc.category, description,
      trimOrNull(b.immediate_action) || inc.immediate_action || null,
      inc.occurred_at, severity]);
    const concern = rows[0];

    const { rows: upd } = await db.query(`
      UPDATE setting_incidents
         SET safeguarding_concern_id = $1, escalated_at = now(), escalated_by = $2,
             status = CASE WHEN status = 'closed' THEN status ELSE 'under_review' END,
             updated_at = now()
       WHERE id = $3 RETURNING *`, [concern.id, req.user.id, inc.id]);

    notify('safeguarding_logged', 'all-managers', null,
      `🛡️ Setting incident escalated to safeguarding`,
      `${inc.incident_ref} (${inc.category_label || inc.category}) has been escalated by `
      + `${(req.user && (req.user.first_name || req.user.name)) || 'a staff member'}. Concern #${concern.id} is open for the DSL.`,
      { priority: 'urgent', relatedTable: 'safeguarding_concerns', relatedId: concern.id,
        link: '/admin/safeguarding/concerns' });

    res.status(201).json({ incident: upd[0], safeguarding_concern: concern });
  } catch (err) {
    console.error('setting-incidents escalate error:', err.message);
    res.status(500).json({ error: 'Failed to escalate: ' + err.message });
  }
});

/* ── photos ────────────────────────────────────────────────────────────────── */
// Own directory and own si_ filename prefix, mirroring the incidents.js
// mechanism without sharing its store — a setting-incident photo (a burst pipe,
// a forced door) is not an accident photo and should not land in the same folder.
const SI_UPLOAD_DIR = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'setting-incidents')
  : path.join(__dirname, '../../data/ladn/uploads/setting-incidents');

const _siUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) { fs.mkdirSync(SI_UPLOAD_DIR, { recursive: true }); cb(null, SI_UPLOAD_DIR); },
    filename(req, file, cb) {
      const ext = (path.extname(file.originalname).toLowerCase() || '.jpg').replace(/[^.a-z0-9]/g, '');
      cb(null, `si_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext || '.jpg'}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter(req, file, cb) { cb(null, /^image\/(jpeg|png|webp|gif|heic|heif)$/.test(file.mimetype)); },
});

router.post('/upload', requireLeader, _siUpload.array('photos', 6), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files uploaded' });
  res.json({ urls: req.files.map(f => `/api/setting-incidents/photo/${f.filename}`) });
});

// Exempted from authenticate() at the top — a plain <img src> carries no
// Authorization header, so the token arrives as ?token= (and, on the
// device-gated EY portal, ?dev= gets the request past the enrolment gate).
// b491 (2026-10-12): ?token= used to accept the same long-lived session JWT as
// the header path (release CHECK.md F1) — now a short-lived (≤10min) token
// signed with MEDIA_URL_KEY instead (src/lib/media-url.js), same claim shape.
router.get('/photo/:filename', async (req, res) => {
  const header = req.headers['authorization'] || '';
  const headerTok = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-wren-token'] || '');
  let decoded;
  if (headerTok) {
    try {
      decoded = jwt.verify(headerTok, process.env.JWT_SECRET);
      if (!decoded.aud || decoded.aud !== (req._portal || 'learning')) {
        return res.status(401).json({ error: 'Invalid token audience' });
      }
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  } else if (req.query.token) {
    decoded = require('../lib/media-url').verifySessionToken(req.query.token, req._portal || 'learning');
    if (!decoded) return res.status(403).json({ error: 'invalid_or_expired_media_url' });
    if ((req._portal || 'learning') === 'learning' && !(await require('../lib/device-token').isAllowed(req))) {
      return res.status(403).json({ error: 'device_required' });
    }
  } else {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  if (decoded.role === 'parent') return res.status(403).json({ error: 'Forbidden' });
  const name = path.basename(req.params.filename);
  const full = path.join(SI_UPLOAD_DIR, name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(full);
});

// Deletes an ORPHAN upload (the "remove" button before saving). Removing a photo
// from a saved incident is done by PUTting a shorter photo_urls array.
router.delete('/photo/:filename', requireLeader, (req, res) => {
  const name = path.basename(req.params.filename);
  if (!/^si_[a-z0-9_.]+$/i.test(name)) return res.status(400).json({ error: 'Invalid filename' });
  const full = path.join(SI_UPLOAD_DIR, name);
  try {
    if (fs.existsSync(full)) fs.unlinkSync(full);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
