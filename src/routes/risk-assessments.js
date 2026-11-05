/**
 * risk-assessments.js — Risk assessment management to Evolve standard
 *
 * Covers: library templates, per-RA hazard list, sign-off chain
 * (creator → reviewer → headteacher/manager), expiry tracking,
 * RIDDOR-enhanced incident flag, PDF-ready data export.
 */

const express  = require('express');
const router   = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

function isManager(req) {
  return hasRole(req.user, ['manager','deputy_manager','admin']);
}

// ── Daily opening / closing safety checks (EY tablet) ────────────────────────
// A deliberately SIMPLE daily walk-round that staff tick off at the start and
// end of the day — separate from the formal Evolve-standard RA library above.
// EASILY EDITABLE: change / add checklist items and reminder times right here.
//   `key`   — stable identifier (handy for future reporting; not a DB key)
//   `label` — the wording staff see
//   `remind_from_hour` — 24h local clock; the reminder starts nagging from here
//     if that day's check isn't done yet. (type-level — same for every room)
//
// b404 (2026-10-06): split from ONE shared item list into one list PER ROOM,
// because "BR RA" and "PS RA" used to open the identical whole-nursery check
// (GET /daily-checks/today picked the first row of the day for that
// check_type, ignoring room entirely). Split rationale, from the original
// 8 opening + 7 closing items:
//   - Baby Room / Pre-school (opening): rooms/temperature/firstaid/
//     locked_away/equipment/fireexits — generic indoor room-safety items,
//     equally relevant to both indoor rooms, so both keep the same wording.
//   - Garden (opening): gates/garden kept verbatim (outdoor perimeter);
//     `equipment` reworded for outdoor kit.
//   - Baby Room / Pre-school (closing): children_out reworded per room
//     (each room's own register); windows/appliances/logged/clean kept,
//     reworded generically.
//   - Garden (closing): garden_clear kept; `logged`/`clean` reworded for
//     outdoor use.
// NOT placed anywhere — flagging rather than guessing, per the brief:
//   - `alarm` ("Lights off & alarm set") — this is a single whole-building
//     action (one alarm panel), not a per-room one. Left out of all three
//     lists. Recommend Toby decide where end-of-day lock-up lives (e.g. a
//     separate one-off closing step, not tied to any of the 3 rooms).
//   - Garden opening `firstaid` / `locked_away` — unclear whether there's a
//     separate outdoor first-aid kit or lockable outdoor storage. Not
//     invented here; add to Garden's opening list if Toby confirms one exists.
//   - Garden closing `appliances` — no known outdoor appliance/equipment to
//     switch off; not invented here.
const ROOMS = ['Baby Room', 'Pre-school', 'Garden'];

// Port note (2026-10-17): the pre-b404 whole-nursery lists, kept as `items` on each check
// type in the config response so a consumer that still reads cfg.items (the EYFS demo
// edition's own copy of the page, editions/eyfs/public/ey/risk-assessments.html) keeps
// working. The EY page in editions/ladn uses cfg.rooms[room].items only.
const LEGACY_ITEMS = {
  opening: [
    { key: 'gates',       label: 'Gates & external doors secure' },
    { key: 'garden',      label: 'Garden / outdoor area safe — no hazards, gates locked' },
    { key: 'rooms',       label: 'Rooms set up safely — no trip or choking hazards' },
    { key: 'temperature', label: 'Room temperatures comfortable' },
    { key: 'firstaid',    label: 'First-aid kits stocked & accessible' },
    { key: 'fireexits',   label: 'Fire exits clear' },
    { key: 'locked_away', label: 'Cleaning products & medicines locked away' },
    { key: 'equipment',   label: 'Equipment & toys clean and undamaged' },
  ],
  closing: [
    { key: 'children_out', label: 'All children signed out & collected' },
    { key: 'garden_clear', label: 'Garden cleared & gates locked' },
    { key: 'windows',      label: 'Windows & external doors locked' },
    { key: 'appliances',   label: 'Appliances / heaters switched off' },
    { key: 'logged',       label: 'Any accidents / incidents logged' },
    { key: 'clean',        label: 'Rooms tidied & surfaces cleaned' },
    { key: 'alarm',        label: 'Lights off & alarm set' },
  ],
};

const DAILY_CHECK_CONFIG = {
  opening: {
    label: 'Opening checks',
    remind_from_hour: 7,
    rooms: {
      'Baby Room': {
        items: [
          { key: 'rooms',       label: 'Room set up safely — no trip or choking hazards' },
          { key: 'temperature', label: 'Room temperature comfortable' },
          { key: 'firstaid',    label: 'First-aid kit stocked & accessible' },
          { key: 'locked_away', label: 'Cleaning products & medicines locked away' },
          { key: 'equipment',   label: 'Equipment & toys clean and undamaged' },
          { key: 'fireexits',   label: 'Fire exit clear' },
        ],
      },
      'Pre-school': {
        items: [
          { key: 'rooms',       label: 'Room set up safely — no trip or choking hazards' },
          { key: 'temperature', label: 'Room temperature comfortable' },
          { key: 'firstaid',    label: 'First-aid kit stocked & accessible' },
          { key: 'locked_away', label: 'Cleaning products & medicines locked away' },
          { key: 'equipment',   label: 'Equipment & toys clean and undamaged' },
          { key: 'fireexits',   label: 'Fire exit clear' },
        ],
      },
      'Garden': {
        items: [
          { key: 'gates',     label: 'Gates & external doors secure' },
          { key: 'garden',    label: 'Garden / outdoor area safe — no hazards, gates locked' },
          { key: 'equipment', label: 'Outdoor equipment clean and undamaged' },
        ],
      },
    },
  },
  closing: {
    label: 'Closing checks',
    remind_from_hour: 16,
    rooms: {
      'Baby Room': {
        items: [
          { key: 'children_out', label: 'All Baby Room children signed out & collected' },
          { key: 'windows',      label: 'Windows & doors locked' },
          { key: 'appliances',   label: 'Appliances / heaters switched off' },
          { key: 'logged',       label: 'Any accidents / incidents logged' },
          { key: 'clean',        label: 'Room tidied & surfaces cleaned' },
        ],
      },
      'Pre-school': {
        items: [
          { key: 'children_out', label: 'All Pre-school children signed out & collected' },
          { key: 'windows',      label: 'Windows & doors locked' },
          { key: 'appliances',   label: 'Appliances / heaters switched off' },
          { key: 'logged',       label: 'Any accidents / incidents logged' },
          { key: 'clean',        label: 'Room tidied & surfaces cleaned' },
        ],
      },
      'Garden': {
        items: [
          { key: 'garden_clear', label: 'Garden cleared & gates locked' },
          { key: 'logged',       label: 'Any accidents / incidents logged' },
          { key: 'clean',        label: 'Outdoor area tidied, toys put away' },
        ],
      },
    },
  },
};
// back-compat (see LEGACY_ITEMS above): every check type also carries the old flat list
Object.keys(LEGACY_ITEMS).forEach(t => { if (DAILY_CHECK_CONFIG[t]) DAILY_CHECK_CONFIG[t].items = LEGACY_ITEMS[t]; });

// Self-healing additive table (mirrors the device-enrol pattern in
// server-unified.js). Runs once on module load in whatever schema the pool's
// search_path points at (ladn / demo_* / wren_dev) — CREATE ... IF NOT EXISTS,
// so it never touches existing data.
function _ensureDailyCheckTable() {
  const db = getPool();
  db.query(`
    CREATE TABLE IF NOT EXISTS daily_safety_checks (
      id            bigserial PRIMARY KEY,
      check_date    date NOT NULL DEFAULT CURRENT_DATE,
      check_type    text NOT NULL,
      room          text,
      items         jsonb NOT NULL DEFAULT '[]'::jsonb,
      all_clear     boolean NOT NULL DEFAULT true,
      concerns      text,
      completed_by  integer,
      created_at    timestamptz NOT NULL DEFAULT now()
    )
  `)
  .then(() => db.query(`CREATE INDEX IF NOT EXISTS daily_safety_checks_date_idx ON daily_safety_checks (check_date, check_type)`))
  .catch(e => console.error('[risk-assessments] daily_safety_checks init:', e.message));
}
_ensureDailyCheckTable();

// GET checklist config (item lists + reminder windows) — drives the EY page.
router.get('/daily-checks/config', (req, res) => {
  res.json(DAILY_CHECK_CONFIG);
});

// GET today's opening + closing status, per room (b404). Each of the 3 rooms
// is resolved independently — logging Baby Room's opening check no longer
// marks Pre-school's or Garden's as done.
router.get('/daily-checks/today', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT d.*, s.first_name||' '||s.last_name AS completed_by_name
      FROM daily_safety_checks d
      LEFT JOIN staff s ON s.id=d.completed_by
      WHERE d.check_date=CURRENT_DATE
      ORDER BY d.created_at DESC
    `);
    // Exact-room match only — legacy rows with room=NULL or 'Whole nursery'
    // are never folded into one of the 3 new rooms (they'd wrongly read as
    // "this room's check is done" otherwise). They stay visible in the
    // unfiltered /daily-checks history list.
    const pick = (t, room) => rows.find(r => r.check_type === t && r.room === room) || null;
    const byRoom = {};
    ROOMS.forEach(room => {
      byRoom[room] = { opening: pick('opening', room), closing: pick('closing', room) };
    });
    res.json({
      date: new Date().toISOString().slice(0, 10),
      rooms: byRoom,
      rooms_list: ROOMS,
      // Back-compat top-level fields for any caller still expecting a single
      // global pick (none in this codebase as of b404 — the EYFS demo
      // edition's copy of this page calls this same shared route but keeps
      // its own pre-b404 single-whole-nursery UI, so these are kept rather
      // than removed):
      opening: pick('opening', null) || rows.find(r => r.check_type === 'opening') || null,
      closing: pick('closing', null) || rows.find(r => r.check_type === 'closing') || null,
      config: DAILY_CHECK_CONFIG,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET recent daily checks (default last 7 days) — reference list.
// b404: optional ?room= filters to one room; omitted = unfiltered, exactly
// as before (so old pre-split rows, including 'Whole nursery'/NULL-room
// history, stay reachable from an unfiltered call).
router.get('/daily-checks', async (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || 7, 90);
  const { room } = req.query;
  try {
    const db = getPool();
    const params = [days];
    let roomClause = '';
    if (room) { params.push(room); roomClause = ` AND d.room = $${params.length}`; }
    const { rows } = await db.query(`
      SELECT d.*, s.first_name||' '||s.last_name AS completed_by_name
      FROM daily_safety_checks d
      LEFT JOIN staff s ON s.id=d.completed_by
      WHERE d.check_date >= CURRENT_DATE - $1::int${roomClause}
      ORDER BY d.check_date DESC, d.created_at DESC
      LIMIT 200
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST a completed daily check. items = [{key,label,ok:true/false,note}].
// b404: upserts on (check_date, check_type, room) via the new partial unique
// index (migrations/2026-10-06-b404-safety-check-room-split.sql) so
// re-submitting the same room/type today ("Record again") updates today's
// row instead of erroring on the new constraint. room=NULL (no room picked)
// falls back to a plain INSERT, unchanged from before — the unique index
// deliberately excludes NULL rooms, and Postgres never enforces uniqueness
// across NULLs anyway, so this matches historical behaviour exactly.
router.post('/daily-checks', async (req, res) => {
  const { check_type, room = null, items = [], concerns = null } = req.body || {};
  if (!['opening','closing'].includes(check_type)) {
    return res.status(400).json({ error: 'check_type must be "opening" or "closing"' });
  }
  const list = Array.isArray(items) ? items : [];
  const all_clear = list.every(i => i && i.ok !== false);
  try {
    const db = getPool();
    let rows;
    if (room == null) {
      // No room picked: plain INSERT, exactly as before the room split.
      ({ rows } = await db.query(
        `INSERT INTO daily_safety_checks (check_type, room, items, all_clear, concerns, completed_by)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6) RETURNING *`,
        [check_type, room, JSON.stringify(list), all_clear, concerns, req.user.id]));
    } else {
      // One row per (day, check_type, room): re-submitting ("Record again") updates today's
      // row. Written as UPDATE-then-INSERT rather than INSERT ... ON CONFLICT, so it works
      // whether or not the optional unique index from
      // migrations/2026-10-06-b404-safety-check-room-split.sql has been applied yet (ON CONFLICT
      // on a missing index would 500 every submission). If the index IS there and two taps
      // race, the loser's INSERT hits 23505 and falls back to the UPDATE.
      const upd = () => db.query(
        `UPDATE daily_safety_checks
            SET items=$3::jsonb, all_clear=$4, concerns=$5, completed_by=$6, created_at=now()
          WHERE id = (SELECT id FROM daily_safety_checks
                       WHERE check_date=CURRENT_DATE AND check_type=$1 AND room=$2
                       ORDER BY id DESC LIMIT 1)
          RETURNING *`,
        [check_type, room, JSON.stringify(list), all_clear, concerns, req.user.id]);
      ({ rows } = await upd());
      if (!rows.length) {
        try {
          ({ rows } = await db.query(
            `INSERT INTO daily_safety_checks (check_type, room, items, all_clear, concerns, completed_by)
             VALUES ($1,$2,$3::jsonb,$4,$5,$6) RETURNING *`,
            [check_type, room, JSON.stringify(list), all_clear, concerns, req.user.id]));
        } catch (e) {
          if (e && e.code === '23505') ({ rows } = await upd()); else throw e;
        }
      }
    }
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Templates ─────────────────────────────────────────────────────────────────

router.get('/templates', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT * FROM risk_assessment_templates WHERE is_active=true ORDER BY category, name'
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── List ──────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const { status, category } = req.query;
  try {
    const db = getPool();
    const conds = [];
    const params = [];
    let pi = 1;
    if (status)   { conds.push(`ra.status=$${pi++}`);   params.push(status); }
    if (category) { conds.push(`ra.category=$${pi++}`); params.push(category); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const { rows } = await db.query(`
      SELECT ra.*,
        s_c.first_name||' '||s_c.last_name as created_by_name,
        s_r.first_name||' '||s_r.last_name as reviewed_by_name,
        s_a.first_name||' '||s_a.last_name as approved_by_name,
        (ra.review_date < CURRENT_DATE) as is_expired,
        (ra.review_date BETWEEN CURRENT_DATE AND CURRENT_DATE+30) as review_due_soon,
        (SELECT COUNT(*) FROM risk_assessment_hazards h WHERE h.risk_assessment_id=ra.id) as hazard_count
      FROM risk_assessments ra
      LEFT JOIN staff s_c ON s_c.id=ra.created_by
      LEFT JOIN staff s_r ON s_r.id=ra.reviewed_by
      LEFT JOIN staff s_a ON s_a.id=ra.approved_by
      ${where}
      ORDER BY ra.review_date ASC NULLS LAST, ra.created_at DESC
      LIMIT 200
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Single ────────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const db = getPool();
    const [ra, hazards] = await Promise.all([
      db.query(`
        SELECT ra.*,
          s_c.first_name||' '||s_c.last_name as created_by_name,
          s_r.first_name||' '||s_r.last_name as reviewed_by_name,
          s_a.first_name||' '||s_a.last_name as approved_by_name,
          t.name as template_name
        FROM risk_assessments ra
        LEFT JOIN staff s_c ON s_c.id=ra.created_by
        LEFT JOIN staff s_r ON s_r.id=ra.reviewed_by
        LEFT JOIN staff s_a ON s_a.id=ra.approved_by
        LEFT JOIN risk_assessment_templates t ON t.id=ra.template_id
        WHERE ra.id=$1
      `, [req.params.id]),
      db.query(
        'SELECT * FROM risk_assessment_hazards WHERE risk_assessment_id=$1 ORDER BY display_order, id',
        [req.params.id]
      ),
    ]);
    if (!ra.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ...ra.rows[0], hazards: hazards.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Create ────────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const {
    template_id, title, category='general', location, activity,
    persons_at_risk=[], assessment_date, review_date, notes, outing_id,
  } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO risk_assessments
        (template_id, title, category, location, activity, persons_at_risk,
         assessment_date, review_date, notes, outing_id, created_by, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft')
      RETURNING *
    `, [template_id||null, title, category, location||null, activity||null,
        persons_at_risk, assessment_date||null, review_date||null,
        notes||null, outing_id||null, req.user.id]);

    // If from template, copy hazards
    if (template_id) {
      const tmpl = await db.query(
        'SELECT hazards_template FROM risk_assessment_templates WHERE id=$1', [template_id]
      );
      const hazards = tmpl.rows[0]?.hazards_template || [];
      if (Array.isArray(hazards) && hazards.length) {
        for (let i = 0; i < hazards.length; i++) {
          const h = hazards[i];
          const text = typeof h === 'string' ? h : h.hazard || String(h);
          await db.query(`
            INSERT INTO risk_assessment_hazards
              (risk_assessment_id, hazard, display_order)
            VALUES ($1,$2,$3)
          `, [rows[0].id, text, i]);
        }
      }
    }

    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Update ────────────────────────────────────────────────────────────────────

router.put('/:id', async (req, res) => {
  const {
    title, location, activity, persons_at_risk, assessment_date,
    review_date, notes, severity_before, severity_after,
  } = req.body;
  try {
    const db = getPool();
    const updates = ['updated_at=NOW()'];
    const params = [];
    let pi = 1;
    const add = (col, val) => { if (val !== undefined) { updates.push(`${col}=$${pi++}`); params.push(val); }};
    add('title', title);
    add('location', location);
    add('activity', activity);
    add('persons_at_risk', persons_at_risk);
    add('assessment_date', assessment_date);
    add('review_date', review_date);
    add('notes', notes);
    add('severity_before', severity_before);
    add('severity_after', severity_after);
    params.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE risk_assessments SET ${updates.join(',')} WHERE id=$${pi} RETURNING *`, params
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Hazards CRUD ──────────────────────────────────────────────────────────────

router.get('/:id/hazards', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT * FROM risk_assessment_hazards WHERE risk_assessment_id=$1 ORDER BY display_order, id',
      [req.params.id]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/hazards', async (req, res) => {
  const { hazard, who_at_risk, existing_controls, residual_risk='medium',
          additional_controls, responsible_person, display_order=0 } = req.body;
  if (!hazard) return res.status(400).json({ error: 'hazard required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO risk_assessment_hazards
        (risk_assessment_id, hazard, who_at_risk, existing_controls,
         residual_risk, additional_controls, responsible_person, display_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [req.params.id, hazard, who_at_risk||null, existing_controls||null,
        residual_risk, additional_controls||null, responsible_person||null, display_order]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id/hazards/:hid', async (req, res) => {
  const { hazard, who_at_risk, existing_controls, residual_risk,
          additional_controls, responsible_person } = req.body;
  try {
    const db = getPool();
    const updates = [];
    const params = [];
    let pi = 1;
    const add = (col, val) => { if (val !== undefined) { updates.push(`${col}=$${pi++}`); params.push(val); }};
    add('hazard', hazard);
    add('who_at_risk', who_at_risk);
    add('existing_controls', existing_controls);
    add('residual_risk', residual_risk);
    add('additional_controls', additional_controls);
    add('responsible_person', responsible_person);
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.hid, req.params.id);
    const { rows } = await db.query(
      `UPDATE risk_assessment_hazards SET ${updates.join(',')}
       WHERE id=$${pi} AND risk_assessment_id=$${pi+1} RETURNING *`, params
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/hazards/:hid', async (req, res) => {
  try {
    const db = getPool();
    await db.query(
      'DELETE FROM risk_assessment_hazards WHERE id=$1 AND risk_assessment_id=$2',
      [req.params.hid, req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Submit for review ─────────────────────────────────────────────────────────

router.post('/:id/submit', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE risk_assessments SET status='submitted', updated_at=NOW()
      WHERE id=$1 AND created_by=$2 RETURNING *
    `, [req.params.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found or not your RA' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Manager review ────────────────────────────────────────────────────────────

router.post('/:id/review', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  const { notes } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE risk_assessments SET
        status='reviewed', reviewed_by=$1, reviewed_at=NOW(),
        notes=COALESCE(notes||E'\n\n','') || COALESCE($2,''),
        updated_at=NOW()
      WHERE id=$3 RETURNING *
    `, [req.user.id, notes||null, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Approve ───────────────────────────────────────────────────────────────────

router.post('/:id/approve', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE risk_assessments SET
        status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW()
      WHERE id=$2 RETURNING *
    `, [req.user.id, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Expiring ──────────────────────────────────────────────────────────────────

router.get('/expiring/list', async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT ra.*,
        s.first_name||' '||s.last_name as created_by_name,
        ra.review_date - CURRENT_DATE as days_until_expiry
      FROM risk_assessments ra
      LEFT JOIN staff s ON s.id=ra.created_by
      WHERE ra.review_date IS NOT NULL
        -- b367 (2026-09-29): $1 arrives untyped, so Postgres saw "date + unknown" and
        -- raised "operator is not unique" — the endpoint 500'd for every caller. Cast it.
        AND ra.review_date <= CURRENT_DATE + ($1)::int
        AND ra.status='approved'
      ORDER BY ra.review_date ASC
    `, [days]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RIDDOR: incidents requiring report ───────────────────────────────────────

router.get('/riddor/reportable', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT i.*,
        c.first_name||' '||c.last_name as child_name,
        s.first_name||' '||s.last_name as reporter_name
      FROM incidents i
      LEFT JOIN children c ON c.id=i.child_id
      LEFT JOIN staff s ON s.id=i.reported_by
      WHERE i.riddor_reportable=true
      ORDER BY i.created_at DESC LIMIT 100
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/riddor/:incidentId/confirm', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  const { hse_ref, notes } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE incidents SET
        riddor_notified_at=NOW(),
        riddor_hse_ref=$1,
        follow_up_notes=COALESCE(follow_up_notes||E'\n','') || COALESCE($2,'')
      WHERE id=$3 RETURNING *
    `, [hse_ref||null, notes||null, req.params.incidentId]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RIDDOR export package ─────────────────────────────────────────────────────

router.get('/riddor/:incidentId/export', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT i.*,
        c.first_name||' '||c.last_name as child_name,
        c.date_of_birth as child_dob,
        s.first_name||' '||s.last_name as reporter_name,
        sm.first_name||' '||sm.last_name as manager_name
      FROM incidents i
      LEFT JOIN children c ON c.id=i.child_id
      LEFT JOIN staff s ON s.id=i.reported_by
      LEFT JOIN staff sm ON sm.id=i.manager_signed_by
      WHERE i.id=$1
    `, [req.params.incidentId]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const i = rows[0];

    // RIDDOR F2508 equivalent fields
    res.json({
      riddor_export: {
        report_type: 'F2508 equivalent',
        setting_name: 'Your Nursery',
        setting_address: '123 Example Lane, Your Town, AB1 2CD',
        date_of_incident: i.incident_date,
        time_of_incident: i.incident_time,
        injured_person: i.child_name,
        date_of_birth: i.child_dob,
        nature_of_injury: i.injury_description,
        location_of_incident: i.location,
        cause_description: i.description,
        first_aid_given: i.first_aid_given,
        hospital_transfer: i.hospital_transfer,
        hospital_name: i.hospital_name,
        days_absence_expected: i.days_absence_expected,
        riddor_threshold_reason: i.riddor_threshold_reason,
        specified_injury: i.specified_injury,
        specified_injury_type: i.specified_injury_type,
        dangerous_occurrence: i.dangerous_occurrence,
        reported_by: i.reporter_name,
        manager_signed_by: i.manager_name,
        hse_ref: i.riddor_hse_ref,
        notified_at: i.riddor_notified_at,
        footer: 'This is a controlled health & safety record. Report to HSE at riddor.hse.gov.uk if threshold met.',
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
