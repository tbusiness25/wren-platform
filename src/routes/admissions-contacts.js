/**
 * b224 (2026-08-25) — Admissions contact log, attribution and traffic lights.
 *
 * Three managers work the admissions list. The failure mode this route exists to
 * kill is two of them ringing the same parent on the same afternoon. So every
 * write records WHO from the session (never typed) and WHEN, every read hands the
 * UI back who last made contact, and a contact inside the last 24h is flagged.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * ⚠ PARENT-VISIBILITY BOUNDARY — INTERNAL, STAFF-ONLY, NO EXCEPTIONS
 * ══════════════════════════════════════════════════════════════════════════════
 * Everything this file touches is written by staff, about a family, for staff
 * eyes only:
 *
 *   ladn.admission_contacts       — BOTH kinds. 'contact' is a manager's own
 *                                   account of what was said on a call; 'note'
 *                                   is an internal note about the family.
 *   enquiries.contact_state       — our private read on whether they are warm.
 *   waiting_list.contact_state
 *   enquiries.last_contact_*      — internal attribution.
 *   waiting_list.last_contacted_*
 *
 * NO parent-facing or public route may ever SELECT them. That means, concretely:
 *   • no route under /api/parents/*        (src/routes/parents.js, parent-*.js)
 *   • no route under /api/public/*         (src/routes/public-availability.js)
 *   • no unauthenticated enquiry route     (public-enquiry.js, enquiry-form.js
 *                                           /api/enquiry-form/public)
 *   • no token-gated no-login route        (keepsake-public.js, onboarding-public.js)
 *   • not the parent portal's own view of a waiting-list place
 *     (parents.js GET /waiting-list-status selects room + position ONLY)
 *
 * If you need a family-visible message, that is a different thing: use the
 * outbound reply/message paths (POST /api/enquiries/:id/reply, POST
 * /api/admissions-engine/waitlist/:id/message), which send email and are
 * intended to be read by the parent.
 *
 * Enforced three ways:
 *   1. router.use(authenticate) + managerOnly below — no anonymous read at all.
 *   2. The blockParentPortal guard below — even a valid parent-audience JWT on
 *      the parents host is refused, so a future mount-order slip cannot expose it.
 *   3. scripts/b224-verify-internal-notes.sh — a static check that greps every
 *      parent-facing / public route file for these table and column names and
 *      exits non-zero if one appears. Run it before deploying.
 *
 * Storage note: ladn.enquiry_replies was read first and deliberately left alone —
 * see the header of scripts/b224-admissions-contacts.sql for why. Its rows are
 * UNIONed into the timeline read-only so the legacy reply history is not lost.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

// ── Traffic light ────────────────────────────────────────────────────────────
// The STATE is stored, never the colour. The UI maps state -> colour so a theme
// change (or a colour-blind mode) never needs a data migration.
//   active      🟢  in play, we are working it
//   heard_back  🟠  they have responded
//   no_response 🔴  contacted, nothing back
const STATES  = ['active', 'heard_back', 'no_response'];
const METHODS = ['call', 'email', 'text', 'in_person'];
const KINDS   = ['contact', 'note'];

// Which table each :subject maps to. Keeps the id columns out of the URL string
// interpolation — the subject is validated against these keys, never concatenated.
const SUBJECTS = {
  enquiry:  { table: 'enquiries',    fk: 'enquiry_id',      atCol: 'last_contact_at',    byCol: 'last_contact_by',    methodCol: 'last_contact_method' },
  waitlist: { table: 'waiting_list', fk: 'waiting_list_id', atCol: 'last_contacted_at',  byCol: 'last_contacted_by',  methodCol: 'last_contact_method' },
};

router.use(authenticate);

// Guard 2 of 3 (see header): the parents portal must never reach this router,
// whatever the mount order upstream ends up being.
router.use((req, res, next) => {
  if (req._portal === 'parents') {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
});

// Toby's framing: "three managers use this". At LADN that is the manager, the
// deputy manager and a room leader — so the gate is the codebase's usual
// management set, NOT admissions-engine's narrower ['manager', 'admin','room_leader']
// (which locks the deputy manager out of the admissions tools she runs daily).
const ADMISSIONS_ROLES = ['manager', 'deputy_manager', 'admin', 'room_leader', 'headteacher', 'business_manager'];
const managerOnly = (req, res, next) => {
  if (!hasRole(req.user, ADMISSIONS_ROLES)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};
router.use(managerOnly);

function subjectOf(req, res) {
  const s = SUBJECTS[req.params.subject];
  if (!s) { res.status(400).json({ error: 'subject must be "enquiry" or "waitlist"' }); return null; }
  return s;
}
function idOf(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: 'bad id' }); return null; }
  return id;
}

// The signed-in person's display name, for the staff_name snapshot. The JWT
// carries a name; fall back to the staff row, then to a plain id label — this
// must never fail a write.
async function actorName(db, user) {
  if (user.name && String(user.name).trim()) return String(user.name).trim();
  try {
    const { rows } = await db.query(
      `SELECT first_name || ' ' || last_name AS n FROM staff WHERE id = $1`, [user.id]);
    if (rows[0] && rows[0].n) return rows[0].n.trim();
  } catch { /* non-fatal */ }
  return `Staff #${user.id}`;
}

// ── GET /summary — attribution for every open enquiry + waiting-list row ─────
// One call feeds the whole pipeline board and the waiting-list table, so a
// 60-card board costs one query per subject rather than one per card.
router.get('/summary', async (req, res) => {
  try {
    const db = getPool();
    const [enq, wl] = await Promise.all([
      db.query(`
        SELECT e.id,
               COALESCE(e.contact_state, 'active') AS contact_state,
               e.last_contact_at   AS last_contact_at,
               e.last_contact_by   AS last_contact_by,
               e.last_contact_method,
               s.first_name || ' ' || s.last_name AS last_contact_by_name,
               (SELECT COUNT(*) FROM admission_contacts c
                 WHERE c.enquiry_id = e.id AND c.kind = 'contact') AS contact_count,
               (SELECT COUNT(*) FROM admission_contacts c
                 WHERE c.enquiry_id = e.id AND c.kind = 'note')    AS note_count
        FROM enquiries e
        LEFT JOIN staff s ON s.id = e.last_contact_by`),
      db.query(`
        SELECT w.id,
               COALESCE(w.contact_state, 'active') AS contact_state,
               w.last_contacted_at AS last_contact_at,
               w.last_contacted_by AS last_contact_by,
               w.last_contact_method,
               s.first_name || ' ' || s.last_name AS last_contact_by_name,
               (SELECT COUNT(*) FROM admission_contacts c
                 WHERE c.waiting_list_id = w.id AND c.kind = 'contact') AS contact_count,
               (SELECT COUNT(*) FROM admission_contacts c
                 WHERE c.waiting_list_id = w.id AND c.kind = 'note')    AS note_count
        FROM waiting_list_live w
        LEFT JOIN staff s ON s.id = w.last_contacted_by`),
    ]);
    const shape = rows => {
      const out = {};
      rows.forEach(r => {
        out[r.id] = {
          contact_state: r.contact_state,
          last_contact_at: r.last_contact_at,
          last_contact_by: r.last_contact_by,
          last_contact_by_name: r.last_contact_by_name || null,
          last_contact_method: r.last_contact_method || null,
          contact_count: parseInt(r.contact_count, 10) || 0,
          note_count: parseInt(r.note_count, 10) || 0,
        };
      });
      return out;
    };
    res.json({
      // Echoed so the client never hard-codes the vocabulary.
      states: STATES, methods: METHODS,
      viewer_id: req.user.id,
      enquiry: shape(enq.rows),
      waitlist: shape(wl.rows),
    });
  } catch (e) {
    console.error('[admissions-contacts/summary]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:subject/:id — the full internal timeline for one family ────────────
// Newest first. Contacts and internal notes interleave, because when you are
// picking up someone else's enquiry you want to read it as one story.
router.get('/:subject/:id', async (req, res) => {
  const s = subjectOf(req, res); if (!s) return;
  const id = idOf(req, res);     if (id === null) return;
  try {
    const db = getPool();
    // Legacy ladn.enquiry_replies rows are folded in read-only (enquiries only —
    // that table has no waiting-list concept). They pre-date b224 and carry no
    // method, so they surface as method NULL, kind 'contact', source 'legacy'.
    const sql = s.fk === 'enquiry_id'
      ? `SELECT c.id, c.kind, c.method, c.body, c.created_at, c.staff_id,
                COALESCE(c.staff_name, s.first_name || ' ' || s.last_name) AS staff_name,
                'b224' AS source
           FROM admission_contacts c
           LEFT JOIN staff s ON s.id = c.staff_id
          WHERE c.enquiry_id = $1
          UNION ALL
         SELECT r.id, 'contact' AS kind, 'email' AS method, r.body, r.created_at, r.staff_id,
                s2.first_name || ' ' || s2.last_name AS staff_name,
                'legacy_reply' AS source
           FROM enquiry_replies r
           LEFT JOIN staff s2 ON s2.id = r.staff_id
          WHERE r.enquiry_id = $1
          ORDER BY created_at DESC, id DESC`
      : `SELECT c.id, c.kind, c.method, c.body, c.created_at, c.staff_id,
                COALESCE(c.staff_name, s.first_name || ' ' || s.last_name) AS staff_name,
                'b224' AS source
           FROM admission_contacts c
           LEFT JOIN staff s ON s.id = c.staff_id
          WHERE c.waiting_list_id = $1
          ORDER BY c.created_at DESC, c.id DESC`;

    const [entries, subject] = await Promise.all([
      db.query(sql, [id]),
      db.query(
        `SELECT COALESCE(contact_state,'active') AS contact_state,
                ${s.atCol}     AS last_contact_at,
                ${s.byCol}     AS last_contact_by,
                ${s.methodCol} AS last_contact_method
           FROM ${s.table} WHERE id = $1`, [id]),
    ]);
    if (!subject.rows.length) return res.status(404).json({ error: 'not found' });

    const head = subject.rows[0];
    // "Someone else rang them this morning" — the single most useful thing to
    // know before you pick up the phone.
    const recent = entries.rows.find(r => r.kind === 'contact');
    const within24h = recent
      && (Date.now() - new Date(recent.created_at).getTime()) < 24 * 3600 * 1000;

    res.json({
      subject: req.params.subject,
      id,
      states: STATES, methods: METHODS,
      contact_state: head.contact_state,
      last_contact_at: head.last_contact_at,
      last_contact_by: head.last_contact_by,
      last_contact_method: head.last_contact_method,
      recent_contact_by_other: (within24h && recent.staff_id !== req.user.id)
        ? { staff_id: recent.staff_id, staff_name: recent.staff_name, at: recent.created_at, method: recent.method }
        : null,
      entries: entries.rows,
    });
  } catch (e) {
    console.error('[admissions-contacts/timeline]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /:subject/:id — log a contact, or add an internal note ──────────────
// Body: { kind: 'contact'|'note', method, body, state? }
// Appends. Never overwrites a previous entry — the history is the point.
router.post('/:subject/:id', async (req, res) => {
  const s = subjectOf(req, res); if (!s) return;
  const id = idOf(req, res);     if (id === null) return;
  const kind  = KINDS.includes(req.body && req.body.kind) ? req.body.kind : 'contact';
  const body  = String((req.body && req.body.body) || '').trim();
  const state = req.body && req.body.state;

  if (!body) return res.status(400).json({ error: 'Say what was said — the note body is required' });
  let method = (req.body && req.body.method) || null;
  if (kind === 'note') {
    method = null;                                   // a note is not a contact
  } else if (!METHODS.includes(method)) {
    return res.status(400).json({ error: `method must be one of: ${METHODS.join(', ')}` });
  }
  if (state !== undefined && state !== null && !STATES.includes(state)) {
    return res.status(400).json({ error: `state must be one of: ${STATES.join(', ')}` });
  }

  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query(`SELECT 1 FROM ${s.table} WHERE id = $1`, [id]);
    if (!exists.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }

    const who = await actorName(client, req.user);
    const ins = await client.query(
      `INSERT INTO admission_contacts (${s.fk}, staff_id, staff_name, kind, method, body)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, kind, method, body, created_at, staff_id, staff_name`,
      [id, req.user.id, who, kind, method, body]);

    // Only a CONTACT moves the attribution stamp — an internal note is not
    // "we spoke to them", and stamping it would make the 24h duplicate-call
    // warning lie.
    if (kind === 'contact') {
      const sets = [`${s.atCol} = NOW()`, `${s.byCol} = $2`, `${s.methodCol} = $3`];
      const vals = [id, req.user.id, method];
      if (state) { sets.push(`contact_state = $${vals.length + 1}`); vals.push(state); }
      await client.query(`UPDATE ${s.table} SET ${sets.join(', ')} WHERE id = $1`, vals);
    } else if (state) {
      await client.query(`UPDATE ${s.table} SET contact_state = $2 WHERE id = $1`, [id, state]);
    }

    const head = await client.query(
      `SELECT COALESCE(contact_state,'active') AS contact_state,
              ${s.atCol} AS last_contact_at, ${s.byCol} AS last_contact_by,
              ${s.methodCol} AS last_contact_method
         FROM ${s.table} WHERE id = $1`, [id]);
    await client.query('COMMIT');
    res.status(201).json({ ok: true, entry: ins.rows[0], ...head.rows[0], last_contact_by_name: who });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admissions-contacts/post]', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── PUT /:subject/:id/state — set the traffic light on its own ───────────────
router.put('/:subject/:id/state', async (req, res) => {
  const s = subjectOf(req, res); if (!s) return;
  const id = idOf(req, res);     if (id === null) return;
  const state = req.body && req.body.state;
  if (!STATES.includes(state)) {
    return res.status(400).json({ error: `state must be one of: ${STATES.join(', ')}` });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE ${s.table} SET contact_state = $2 WHERE id = $1 RETURNING id, contact_state`,
      [id, state]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, ...rows[0] });
  } catch (e) {
    console.error('[admissions-contacts/state]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
