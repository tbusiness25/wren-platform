const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { notify } = require('../services/notification-dispatcher');
const ratioEngine = require('../services/ratio-engine');
const { requireSalaryView, canViewSalaries } = require('../lib/capabilities');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
const shiftTypes = require('../lib/shift-types');   // b192 — Day/AM/PM patterns
const shiftPatterns = require('../lib/shift-patterns'); // b189 — named patterns, pattern-owned breaks
const offratio = require('../lib/offratio');            // b189 — per-slot ratio check + off-ratio surplus
const otjRules = require('../lib/otj-rules');           // b317 — young-worker limits (WTR 1998)
const PDFDoc = require('pdfkit');   // payroll export (reuses the same lib as routes/export.js)

// b192 (2026-08-18): a shift's TYPE lives in rota_shifts.label ('Day'|'AM'|'PM'|
// 'Custom'). An AM and a PM on the SAME DATE for the SAME person is ONE day worked
// — so uniqueness, clash checks and day counts all key on the AM/PM/FULL *slot*,
// not on the date alone. SLOT_EXPR mirrors the generated column rota_shifts.shift_slot.
const SLOT_EXPR = shiftTypes.slotSql('rota_shifts');

// The b192 schema (generated column rota_shifts.shift_slot + the wider unique index)
// has to be migrated per schema, and this router is shared by every edition
// (ladn, demo_*, childrenscorner, htps, ht…). Probe once per process and fall back
// to the pre-b192 ON CONFLICT target where the migration has not been run yet —
// so an un-migrated edition keeps working exactly as it did before.
let _slotColumnPromise = null;
function hasSlotColumn(db) {
  if (!_slotColumnPromise) {
    _slotColumnPromise = db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'rota_shifts' AND column_name = 'shift_slot'
          AND table_schema = current_schema()`
    ).then(r => r.rows.length > 0).catch(() => false);
  }
  return _slotColumnPromise;
}
// ON CONFLICT target: (week, staff, date, slot) post-b192, (week, staff, date) before.
async function shiftConflictTarget(db) {
  return (await hasSlotColumn(db))
    ? '(rota_week_id, staff_id, shift_date, shift_slot)'
    : '(rota_week_id, staff_id, shift_date)';
}

// b189 (2026-08-19): NAMED shift patterns (ladn.shift_patterns) + rota_shifts.pattern_id.
// The BREAK belongs to the PATTERN — rota_shifts.break_mins stays as a per-shift
// override for genuine exceptions and is DEFAULTED from the pattern on save. Same
// per-edition migration caveat as b192 above: probe once per process and degrade to
// pre-b189 behaviour where the migration has not been run.
let _patternColumnPromise = null;
function hasPatternColumn(db) {
  if (!_patternColumnPromise) {
    _patternColumnPromise = db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'rota_shifts' AND column_name = 'pattern_id'
          AND table_schema = current_schema()`
    ).then(r => r.rows.length > 0).catch(() => false);
  }
  return _patternColumnPromise;
}

router.use(authenticate);

const managerOnly = (req, res, next) => {
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};

async function checkFeature(req, res, next) {
  try {
    const db = getPool();
    const { rows } = await db.query("SELECT is_enabled FROM feature_flags WHERE key='rota_builder'");
    if (rows.length && !rows[0].is_enabled) {
      return res.status(403).json({ error: 'rota_builder feature disabled' });
    }
    next();
  } catch {
    next();
  }
}

// Returns the ISO Monday of the week containing dateStr (YYYY-MM-DD)
function toWeekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().split('T')[0];
}

// GET /api/rota/weeks — recent rota weeks with status
router.get('/weeks', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT rw.*,
             s.first_name || ' ' || s.last_name AS published_by_name,
             COUNT(rs.id)::int AS shift_count
      FROM rota_weeks rw
      LEFT JOIN staff s ON s.id = rw.published_by
      LEFT JOIN rota_shifts rs ON rs.rota_week_id = rw.id
      GROUP BY rw.id, s.first_name, s.last_name
      ORDER BY rw.week_start DESC
      LIMIT 20
    `);
    res.json(rows);
  } catch (err) {
    console.error('rota /weeks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rota/week/:date — week data (week meta + all staff + shifts)
router.get('/week/:date', async (req, res) => {
  try {
    const ws = toWeekStart(req.params.date);
    const db = getPool();

    const { rows: weekRows } = await db.query(
      'SELECT * FROM rota_weeks WHERE week_start = $1', [ws]
    );
    const week = weekRows[0] || null;

    const { rows: staff } = await db.query(
      `SELECT id, first_name, last_name, role, email,
              contracted_hours, room_id, hourly_rate,
              is_dsl, is_deputy_dsl, is_first_aider
       FROM staff
       WHERE (is_active = true OR is_active IS NULL)
       ORDER BY first_name, last_name`
    );

    const { rows: rooms } = await db.query(
      'SELECT id, name, capacity, ratio_children_per_staff FROM rooms ORDER BY id'
    );

    let shifts = [];
    if (week) {
      const { rows } = await db.query(`
        SELECT rs.*, r.name AS room_name
        FROM rota_shifts rs
        LEFT JOIN rooms r ON r.id = rs.room_id
        WHERE rs.rota_week_id = $1
        ORDER BY rs.shift_date, rs.staff_id
      `, [week.id]);
      shifts = rows;
    }

    // login-20261023: every colleague's hourly_rate went to every role (EY and HR) with the week.
    // Pay is for people who may see salaries; everyone else gets the shifts without it.
    if (!(await canViewSalaries(req.user))) staff.forEach((s) => { delete s.hourly_rate; });
    // 29 Oct: and every colleague's email and contracted hours went to every member of staff.
    if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) staff.forEach((s) => { delete s.email; delete s.contracted_hours; });

    res.json({ week, staff, shifts, rooms });
  } catch (err) {
    console.error('rota /week/:date error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// login-20261023 — ONE rota mailer for both publish routes (they each built their own SMTP
// transport). Sends through the shared sender (src/lib/notifications.js: Gmail service account
// first, dev/MAIL_DISABLED guard, email_audit). Same answer as before: a person counts as "sent"
// when the mail went, or when this server has no way to send (dev / no transport — logged, as the
// old "no SMTP" branch did); "failed" only when a real send failed. smtpOk = something was mailed.
async function emailRota(byStaff, weekLabel, keyOf) {
  const { sendEmailDetailed } = require('../lib/notifications');
  const sent = [], failed = [];
  let mailed = false;
  for (const [id, d] of Object.entries(byStaff)) {
    if (!d.email) continue;
    const r = await sendEmailDetailed(d.email, `Your rota — w/c ${weekLabel}`, buildRotaEmail(d.name, d.shifts, weekLabel), 'rota_published');
    if (r.ok) { mailed = true; sent.push(keyOf(id, d)); }
    else if (/test environment|no mail transport|turned off/.test(r.reason || '')) { console.log(`[rota] not mailed (${r.reason}): ${d.email}`); sent.push(keyOf(id, d)); }
    else { console.error('rota email error for', d.email, r.reason); failed.push(keyOf(id, d)); }
  }
  return { sent, failed, smtpOk: mailed };
}

// POST /api/rota/week/:date/draft — save draft shifts (manager only)
router.post('/week/:date/draft', checkFeature, managerOnly, async (req, res) => {
  const { shifts } = req.body;
  if (!Array.isArray(shifts)) return res.status(400).json({ error: 'shifts must be array' });

  try {
    const ws = toWeekStart(req.params.date);
    const db = getPool();

    const { rows: weekRows } = await db.query(`
      INSERT INTO rota_weeks (week_start, status) VALUES ($1, 'draft')
      ON CONFLICT (week_start) DO UPDATE SET week_start = EXCLUDED.week_start
      RETURNING id, published_at
    `, [ws]);
    const weekId = weekRows[0].id;

    // Delete and re-insert assigned shifts for clean state.
    // Open shifts (is_open=true, staff_id NULL) are preserved — they are managed
    // via the dedicated open-shift / claim endpoints, not the draft grid.
    await db.query('DELETE FROM rota_shifts WHERE rota_week_id = $1 AND COALESCE(is_open,false) = false', [weekId]);

    // b192: `label` carries the shift TYPE (Day/AM/PM/Custom). When the client sends
    // a type but no times, fall back to that type's settings-driven defaults, so the
    // selector alone is enough to create a shift.
    const typeDefaults = await shiftTypes.getShiftTypeDefaults(db);
    const conflictTarget = await shiftConflictTarget(db);

    // b189: resolve each shift to a NAMED pattern by exact start+end, and take the
    // break FROM THAT PATTERN unless the manager explicitly typed one. This is the
    // whole point of req 2 — the same shift can no longer carry two different breaks
    // just because it was entered on two different days.
    const patterns = await shiftPatterns.listPatterns(db, true);
    const patternCol = await hasPatternColumn(db);
    const driftWarnings = [];

    for (const s of shifts) {
      if (!s.staff_id || !s.shift_date) continue;
      const label = shiftTypes.normaliseLabel(s.label);
      const def = typeDefaults[label] || null;
      const startT = s.planned_start || (def && def.start) || null;
      const endT   = s.planned_end   || (def && def.end)   || null;
      const pattern = shiftPatterns.matchPattern(patterns, startT, endT);
      // Explicit break wins (a genuine exception); otherwise pattern, then b192 type
      // default, then 30. Order matters: pattern BEFORE type default.
      const breakMins = (s.break_mins != null && s.break_mins !== '')
        ? parseInt(s.break_mins, 10)
        : shiftPatterns.defaultBreakFor(patterns, startT, endT, def ? def.break_mins : 30);
      // Warn (never correct) where an explicit break disagrees with its pattern.
      const drift = shiftPatterns.breakDrift(pattern, breakMins);
      if (drift) driftWarnings.push({ staff_id: s.staff_id, shift_date: s.shift_date,
                                      times: `${startT}-${endT}`, ...drift });

      const cols = ['rota_week_id', 'staff_id', 'shift_date', 'planned_start', 'planned_end',
                    'room_id', 'break_mins', 'notes', 'label', 'colour'];
      const vals = [weekId, s.staff_id, s.shift_date, startT, endT, s.room_id || null,
                    Number.isFinite(breakMins) ? breakMins : 30, s.notes || null, label, s.colour || null];
      let updateSet = `planned_start=EXCLUDED.planned_start, planned_end=EXCLUDED.planned_end,
          room_id=EXCLUDED.room_id, break_mins=EXCLUDED.break_mins, notes=EXCLUDED.notes,
          label=EXCLUDED.label, colour=EXCLUDED.colour`;
      if (patternCol) {
        cols.push('pattern_id');
        vals.push(pattern ? pattern.id : null);
        updateSet += ', pattern_id=EXCLUDED.pattern_id';
      }
      const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
      await db.query(`
        INSERT INTO rota_shifts (${cols.join(', ')})
        VALUES (${ph})
        ON CONFLICT ${conflictTarget} DO UPDATE SET ${updateSet}
      `, vals);
    }

    res.json({ ok: true, week_id: weekId, saved: shifts.length, week_start: ws,
               break_drift: driftWarnings });
  } catch (err) {
    console.error('rota /draft error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rota/week/:date/publish — mark published + email all staff
router.post('/week/:date/publish', checkFeature, managerOnly, async (req, res) => {
  try {
    const ws = toWeekStart(req.params.date);
    const db = getPool();

    const { rows: weekRows } = await db.query(
      'SELECT * FROM rota_weeks WHERE week_start = $1', [ws]
    );
    if (!weekRows.length) return res.status(404).json({ error: 'No draft rota for this week. Save a draft first.' });
    const week = weekRows[0];

    await db.query(
      'UPDATE rota_weeks SET published_at = NOW(), published_by = $1, status = \'published\' WHERE id = $2',
      [req.user.id, week.id]
    );
    try { await afterPublish(db, week.id, ws); } catch (e) { console.error('rota afterPublish error:', e.message); }

    const { rows: shifts } = await db.query(`
      SELECT rs.*, s.first_name, s.last_name, s.email,
             r.name AS room_name
      FROM rota_shifts rs
      JOIN staff s ON s.id = rs.staff_id
      LEFT JOIN rooms r ON r.id = rs.room_id
      WHERE rs.rota_week_id = $1
      ORDER BY rs.staff_id, rs.shift_date
    `, [week.id]);

    // Group shifts by staff
    const byStaff = {};
    for (const row of shifts) {
      if (!byStaff[row.staff_id]) {
        byStaff[row.staff_id] = {
          name: `${row.first_name} ${row.last_name}`,
          email: row.email,
          shifts: []
        };
      }
      byStaff[row.staff_id].shifts.push(row);
    }

    const weekLabel = new Date(ws + 'T00:00:00Z').toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
    });

    const { sent, failed, smtpOk } = await emailRota(byStaff, weekLabel, (id) => id);

    console.log(`[rota] Published ${ws}: ${sent.length} emails sent, ${failed.length} failed, smtp=${smtpOk}`);
    res.json({ ok: true, sent: sent.length, failed: failed.length, smtp: smtpOk, week_start: ws });
  } catch (err) {
    console.error('rota /publish error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rota/week/:date/unlock — clear published_at (manager only)
router.post('/week/:date/unlock', checkFeature, managerOnly, async (req, res) => {
  try {
    const ws = toWeekStart(req.params.date);
    const db = getPool();
    const { rows } = await db.query(
      'UPDATE rota_weeks SET published_at = NULL, published_by = NULL WHERE week_start = $1 RETURNING id',
      [ws]
    );
    if (!rows.length) return res.status(404).json({ error: 'No rota for this week' });
    res.json({ ok: true });
  } catch (err) {
    console.error('rota /unlock error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rota/my — current user's published shifts for next 14 days
router.get('/my', async (req, res) => {
  try {
    const db = getPool();
    const today = new Date().toISOString().split('T')[0];
    const future = new Date();
    future.setDate(future.getDate() + 14);
    const end = future.toISOString().split('T')[0];

    const settings = await getRotaSettings(db);
    const hideLabels = !!settings.hide_labels_from_employees;
    const { rows } = await db.query(`
      SELECT rs.id, rs.shift_date, rs.planned_start, rs.planned_end,
             rs.break_mins, rs.notes, rs.acceptance, rs.label, rs.colour,
             rs.is_absent, r.name AS room_name,
             rw.published_at, rw.week_start
      FROM rota_shifts rs
      JOIN rota_weeks rw ON rw.id = rs.rota_week_id
      LEFT JOIN rooms r ON r.id = rs.room_id
      WHERE rs.staff_id = $1
        AND rs.shift_date >= $2
        AND rs.shift_date <= $3
        AND rw.published_at IS NOT NULL
      ORDER BY rs.shift_date
    `, [req.user.id, today, end]);

    if (hideLabels) for (const r of rows) { r.label = null; r.colour = null; }
    res.json(rows);
  } catch (err) {
    console.error('rota /my error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Email template ────────────────────────────────────────────────────────────
function buildRotaEmail(name, shifts, weekLabel) {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const rows = shifts.map(s => {
    const d = new Date(s.shift_date + 'T00:00:00Z');
    const day = DAYS[d.getUTCDay()];
    const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
    const start = s.planned_start ? String(s.planned_start).substring(0, 5) : '—';
    const end = s.planned_end ? String(s.planned_end).substring(0, 5) : '—';
    const room = s.room_name || '—';
    return `<tr>
      <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;font-weight:600;color:#1e293b">${day}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;color:#374151">${date}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;color:#374151">${start} – ${end}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;color:#6b7280">${room}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
  <tr><td style="background:#0f172a;padding:24px 32px;text-align:center">
    <div style="font-family:'Arial Rounded MT Bold',Arial,sans-serif;font-size:22px">
      <span style="color:#4a9abf">Your Nursery</span>
      <span style="color:#e07820"> Day Nursery</span>
    </div>
    <div style="color:#94a3b8;font-size:13px;margin-top:6px">Weekly Rota</div>
  </td></tr>
  <tr><td style="padding:28px 32px">
    <div style="font-size:20px;font-weight:700;color:#1e293b;margin-bottom:4px">Hi ${name.split(' ')[0]},</div>
    <div style="font-size:14px;color:#6b7280;margin-bottom:24px">Here's your rota for <strong>week commencing ${weekLabel}</strong>.</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
      <thead>
        <tr style="background:#f8fafc">
          <th style="padding:10px 16px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em">Day</th>
          <th style="padding:10px 16px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em">Date</th>
          <th style="padding:10px 16px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em">Hours</th>
          <th style="padding:10px 16px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em">Room</th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="4" style="padding:16px;color:#9ca3af;text-align:center">No shifts scheduled this week</td></tr>'}</tbody>
    </table>
    <div style="margin-top:24px;text-align:center">
      <a href="https://hr.example-nursery.co.uk/my-shifts.html"
         style="display:inline-block;background:#4a9abf;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px">
        View My Shifts Online
      </a>
    </div>
  </td></tr>
  <tr><td style="background:#f8fafc;padding:20px 32px;border-top:1px solid #e5e7eb;text-align:center">
    <div style="font-size:12px;color:#9ca3af;line-height:1.6">
      Your Nursery | 123 Example Lane, Your Town, AB1 2CD<br>
      Office: 01234 567890 | info@example-nursery.co.uk<br>
      Mon–Fri 8:00am–6:00pm | Established 1990
    </div>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ── Room name normaliser (work_patterns uses short names) ─────────────────────
function normaliseRoomId(roomText, rooms) {
  if (!roomText) return null;
  const t = roomText.toLowerCase().replace(/[^a-z]/g, '');
  // Check if room name and pattern name share first 3 chars (handles "Babies"↔"Baby Room", "Preschool"↔"Pre-school")
  const r = rooms.find(r => {
    const rn = r.name.toLowerCase().replace(/[^a-z]/g, '');
    return rn.startsWith(t.substring(0,3)) || t.startsWith(rn.substring(0,3));
  });
  return r ? r.id : null;
}

// ── Ratio maths: AM/PM concurrency + age-band requirement ─────────────────────
// Nursery operates 08:00–18:00 with staggered staff shifts, so the binding
// constraint is the WORST-covered part of the day, not a flat daily headcount.
// We sample two representative peaks (mid-morning + mid-afternoon) and take the
// minimum concurrent cover — i.e. "AM shift vs PM shift", whichever is thinner.
const RATIO_AM_PEAK = '10:00';   // mid-morning: all rooms full, early staff in
const RATIO_PM_PEAK = '15:30';   // mid-afternoon: after lunch, some AM staff gone

function _hhmm(t) { return t ? String(t).substring(0, 5) : null; }
// Is this (non-absent) shift providing cover at clock time `hhmm`?
// A shift with no planned times is treated as full-day cover (present in both windows).
function _shiftCoversAt(s, hhmm) {
  if (s.is_absent || s.is_meeting) return false;
  const st = _hhmm(s.planned_start), en = _hhmm(s.planned_end);
  if (!st || !en) return true;
  return st <= hhmm && hhmm < en;
}
// Concurrent ratio-counting staff in each window + the binding minimum.
function windowPresence(shifts) {
  const cover = shifts.filter(s => !s.is_absent && !s.is_meeting);
  const am = cover.filter(s => _shiftCoversAt(s, RATIO_AM_PEAK)).length;
  const pm = cover.filter(s => _shiftCoversAt(s, RATIO_PM_PEAK)).length;
  return { am, pm, present: Math.min(am, pm), headcount: cover.length };
}

// Age-band staffing requirement for a room on a date, from the §55 booked register
// (child_bookings). Under-2 → 1:3, 2yr → 1:5, 3yr+ → 1:8. This is MORE accurate than
// capacity/ratio (which ignores age mix — e.g. 2yr-olds in pre-school need 1:5, not
// 1:8) and reflects who is actually booked in. Falls back to the room roster, then
// capacity, so it never silently regresses when the register is unseeded.
async function requiredForRoomDay(db, roomId, dateStr, room) {
  const { rows } = await db.query(`
    SELECT c.date_of_birth FROM child_bookings b JOIN children c ON c.id = b.child_id
    WHERE b.is_active = true AND b.room_id = $1
      AND COALESCE(c.is_active,true)=true AND COALESCE(c.is_demo,false)=false AND c.date_of_birth IS NOT NULL
      AND $2::date BETWEEN b.start_date AND COALESCE(b.end_date, DATE '2100-01-01')
      AND CASE EXTRACT(DOW FROM $2::date)::int
            WHEN 1 THEN b.mon WHEN 2 THEN b.tue WHEN 3 THEN b.wed WHEN 4 THEN b.thu WHEN 5 THEN b.fri ELSE false END
  `, [roomId, dateStr]);
  let src = 'bookings';
  let dobs = rows.map(r => r.date_of_birth);
  if (!dobs.length) {
    const { rows: rr } = await db.query(
      `SELECT date_of_birth FROM children
       WHERE room_id=$1 AND COALESCE(is_active,true)=true AND COALESCE(is_demo,false)=false AND date_of_birth IS NOT NULL`,
      [roomId]);
    dobs = rr.map(r => r.date_of_birth); src = dobs.length ? 'roster' : 'capacity';
  }
  let u2 = 0, t2 = 0, t3 = 0;
  for (const dob of dobs) { const b = ratioEngine.ageBandOn(dob, dateStr); if (b==='under2') u2++; else if (b==='two') t2++; else t3++; }
  // Use the CONFIGURED ratios (LADN policy: 2yr 1:4, stricter than statutory 1:5) so
  // the rota "needed" figure matches the Staffing-by-Week page + absence gatekeeper.
  const ratios = await ratioEngine.getRatios(db);
  let required = ratioEngine.requiredStaff({ under2: u2, two: t2, threePlus: t3 }, ratios);
  if (src === 'capacity' && room) required = Math.ceil((room.capacity||0)/(room.ratio_children_per_staff||4));
  return { booked: dobs.length, under2: u2, two: t2, threePlus: t3, required, source: src };
}

// ── Compute conflict flags for a day's shifts in a room ───────────────────────
// `required` (booking-based) may be supplied; otherwise falls back to capacity/ratio.
// Ratio breach is judged on AM/PM CONCURRENCY, not a flat daily headcount.
function computeDayConflicts(shifts, room, required) {
  const flags = [];
  const present = shifts.filter(s => !s.is_absent && !s.is_meeting);
  const req = (required != null) ? required : Math.ceil((room.capacity || 0) / (room.ratio_children_per_staff || 4));
  const { present: concurrent } = windowPresence(shifts);
  if (concurrent < req) flags.push('ratio_breach');
  const hasDsl = present.some(s => s.is_dsl || s.is_deputy_dsl);
  if (!hasDsl) flags.push('no_dsl');
  const hasFa = present.some(s => s.is_first_aider);
  if (!hasFa) flags.push('no_first_aider');
  return flags;
}

// ── POST /api/rota/auto-generate ─────────────────────────────────────────────
router.post('/auto-generate', checkFeature, managerOnly, async (req, res) => {
  const { week_start_date } = req.body;
  if (!week_start_date || !/^\d{4}-\d{2}-\d{2}$/.test(week_start_date)) {
    return res.status(400).json({ error: 'week_start_date required (YYYY-MM-DD Monday)' });
  }
  const ws = toWeekStart(week_start_date);
  if (ws !== week_start_date) {
    return res.status(400).json({ error: `${week_start_date} is not a Monday — use ${ws}` });
  }

  try {
    const db = getPool();

    // Idempotency guard
    const { rows: existing } = await db.query(
      "SELECT id FROM rota_weeks WHERE week_start = $1 AND status IN ('draft','published')", [ws]
    );
    if (existing.length) {
      return res.status(409).json({ error: 'rota_exists', week_id: existing[0].id, week_start: ws });
    }

    const { rows: rooms } = await db.query('SELECT * FROM rooms ORDER BY id');
    const { rows: staff } = await db.query(
      `SELECT s.*, s.is_dsl, s.is_deputy_dsl, s.is_first_aider, s.hourly_rate
       FROM staff s WHERE (s.is_active = true OR s.is_active IS NULL)`
    );

    // Get active work patterns for this week
    const { rows: patterns } = await db.query(
      `SELECT * FROM staff_work_patterns
       WHERE (effective_to IS NULL OR effective_to >= $1)
         AND effective_from <= $2`,
      [ws, ws]
    );

    // Get approved absences overlapping this week
    const weekEnd = new Date(ws + 'T00:00:00Z');
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 4); // Friday
    const weekEndStr = weekEnd.toISOString().split('T')[0];
    const { rows: absences } = await db.query(
      `SELECT staff_id, start_date, end_date FROM absence_requests
       WHERE status = 'approved'
         AND start_date <= $2 AND end_date >= $1`,
      [ws, weekEndStr]
    );

    // Build absence set: staff_id -> Set of ISO date strings
    const absenceMap = {};
    for (const ab of absences) {
      if (!absenceMap[ab.staff_id]) absenceMap[ab.staff_id] = new Set();
      const cur = new Date(ab.start_date + 'T00:00:00Z');
      const end = new Date(ab.end_date + 'T00:00:00Z');
      while (cur <= end) {
        absenceMap[ab.staff_id].add(cur.toISOString().split('T')[0]);
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    }

    // Bank/public holidays in this week + each staff member's pattern handling
    // ('works' = normal shift; 'deducted'/'not_deducted' = off that day).
    const { rows: bankHolRows } = await db.query(
      'SELECT holiday_date, name FROM bank_holidays WHERE holiday_date BETWEEN $1 AND $2', [ws, weekEndStr]
    );
    const bankHols = {};
    for (const h of bankHolRows) bankHols[new Date(h.holiday_date).toISOString().split('T')[0]] = h.name;
    const { rows: phhRows } = await db.query(
      `SELECT s.id AS staff_id, wp.public_holiday_handling
       FROM staff s JOIN work_patterns wp ON wp.id = s.work_pattern_id`
    );
    const phhMap = {};
    for (const r of phhRows) phhMap[r.staff_id] = r.public_holiday_handling;

    // Create the rota week
    const { rows: weekRows } = await db.query(
      `INSERT INTO rota_weeks (week_start, status, generated_from_pattern_at, created_at)
       VALUES ($1, 'draft', NOW(), NOW()) RETURNING id`,
      [ws]
    );
    const weekId = weekRows[0].id;

    const staffById = {};
    for (const s of staff) staffById[s.id] = s;

    let shiftCount = 0;
    const conflictsByDay = {}; // dayISO -> { roomId -> [shifts] }

    // Distinct person-per-day: a staff member may have overlapping effective ranges
    // for the same weekday. Keep exactly ONE pattern per (staff_id, day_of_week) —
    // the LATEST effective_from — so we never emit two shift rows for one person/day
    // (which would also violate the rota_shifts (week, staff, date) unique index).
    const patByStaffDay = new Map();
    for (const pat of patterns) {
      const key = `${pat.staff_id}-${pat.day_of_week}`;
      const prev = patByStaffDay.get(key);
      if (!prev || String(pat.effective_from) > String(prev.effective_from)) patByStaffDay.set(key, pat);
    }
    const dedupedPatterns = [...patByStaffDay.values()];

    // Generate shifts for each staff / day_of_week
    for (const pat of dedupedPatterns) {
      if (pat.is_off) continue; // off day — no shift row
      // day_of_week in patterns: 0=Mon, 4=Fri
      const shiftDate = new Date(ws + 'T00:00:00Z');
      shiftDate.setUTCDate(shiftDate.getUTCDate() + pat.day_of_week);
      const shiftDateStr = shiftDate.toISOString().split('T')[0];

      // b521 — a work-pattern row may carry no `room` text at all (the BrightHR
      // sync derives patterns from contracted hours and the customer API has no
      // rota/room endpoint, so `room` is left NULL; a pattern typed in by hand can
      // leave it blank too). normaliseRoomId(null) is null, which used to produce a
      // shift belonging to no room — and the week grid groups by room, so that
      // person vanished from the rota entirely. Fall back to the room on the staff
      // record, which is where the rest of Wren already asks "which room is this
      // person in". Still null only when the staff record has no room either.
      const roomId = normaliseRoomId(pat.room, rooms)
                  || (staffById[pat.staff_id] && staffById[pat.staff_id].room_id) || null;
      const onLeave = !!(absenceMap[pat.staff_id] && absenceMap[pat.staff_id].has(shiftDateStr));
      // Bank-holiday handling from the staff member's assigned pattern.
      const holName = bankHols[shiftDateStr];
      const holOff  = !!holName && (phhMap[pat.staff_id] || 'not_deducted') !== 'works';
      const isAbsent = onLeave || holOff;
      const note = holOff ? ('Bank holiday: ' + holName) : null;
      const staffRec = staffById[pat.staff_id] || {};

      const { rows } = await db.query(
        `INSERT INTO rota_shifts
           (rota_week_id, staff_id, shift_date, day_of_week, planned_start, planned_end,
            room_id, break_mins, is_absent, notes, source, conflict_flags, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pattern','[]',NOW()) RETURNING id`,
        [weekId, pat.staff_id, shiftDateStr, pat.day_of_week,
         pat.shift_start || null, pat.shift_end || null,
         // Lunch = 1h UNPAID for everyone (business rule) — default 60 when unset.
         roomId, pat.lunch_break_minutes || 60, isAbsent, note]
      );
      shiftCount++;

      // Collect for conflict computation
      if (!conflictsByDay[shiftDateStr]) conflictsByDay[shiftDateStr] = {};
      if (roomId) {
        if (!conflictsByDay[shiftDateStr][roomId]) conflictsByDay[shiftDateStr][roomId] = [];
        conflictsByDay[shiftDateStr][roomId].push({ ...staffRec, is_absent: isAbsent });
      }
    }

    // Compute and store conflict_flags per shift
    for (const [dateStr, roomGroups] of Object.entries(conflictsByDay)) {
      for (const [roomId, dayShifts] of Object.entries(roomGroups)) {
        const room = rooms.find(r => r.id === parseInt(roomId));
        if (!room) continue;
        const flags = computeDayConflicts(dayShifts, room);
        if (flags.length) {
          await db.query(
            `UPDATE rota_shifts SET conflict_flags = $1
             WHERE rota_week_id = $2 AND shift_date = $3 AND room_id = $4`,
            [JSON.stringify(flags), weekId, dateStr, roomId]
          );
        }
      }
    }

    res.json({ ok: true, week_id: weekId, week_start: ws, shifts_created: shiftCount });
  } catch (err) {
    console.error('rota /auto-generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rota/shifts/move — drag-drop shift move ────────────────────────
router.post('/shifts/move', checkFeature, managerOnly, async (req, res) => {
  const { shift_id, new_day, new_staff_id, new_room_id, new_start, new_end } = req.body;
  if (!shift_id || new_day == null) {
    return res.status(400).json({ error: 'shift_id and new_day required' });
  }

  try {
    const db = getPool();
    const { rows: shiftRows } = await db.query(
      `SELECT rs.*, rw.week_start FROM rota_shifts rs
       JOIN rota_weeks rw ON rw.id = rs.rota_week_id
       WHERE rs.id = $1`, [shift_id]
    );
    if (!shiftRows.length) return res.status(404).json({ error: 'Shift not found' });
    const shift = shiftRows[0];

    // Compute new date from week_start + new_day (0=Mon)
    const wsStr = shift.week_start instanceof Date
      ? shift.week_start.toISOString().split('T')[0]
      : String(shift.week_start).substring(0, 10);
    const newDate = new Date(wsStr + 'T00:00:00Z');
    newDate.setUTCDate(newDate.getUTCDate() + new_day);
    const newDateStr = newDate.toISOString().split('T')[0];

    const updates = {
      shift_date: newDateStr,
      day_of_week: new_day,
      staff_id: new_staff_id || shift.staff_id,
      room_id: new_room_id !== undefined ? new_room_id : shift.room_id,
      planned_start: new_start || shift.planned_start,
      planned_end: new_end || shift.planned_end
    };

    // Remove any existing shift at the target slot to avoid unique constraint violation.
    // b192: "slot" now means (date × AM/PM/FULL), not the whole date — moving an AM
    // shift onto a date that already has a PM shift must NOT wipe the PM.
    await db.query(
      `DELETE FROM rota_shifts WHERE rota_week_id=$1 AND staff_id=$2 AND shift_date=$3
         AND ${SLOT_EXPR} = $5 AND id!=$4`,
      [shift.rota_week_id, updates.staff_id, updates.shift_date, shift_id, shiftTypes.slotOf(shift.label)]
    );
    await db.query(
      `UPDATE rota_shifts SET
         shift_date=$1, day_of_week=$2, staff_id=$3, room_id=$4,
         planned_start=$5, planned_end=$6, source='manual'
       WHERE id=$7`,
      [updates.shift_date, updates.day_of_week, updates.staff_id,
       updates.room_id, updates.planned_start, updates.planned_end, shift_id]
    );

    // Recompute conflicts for affected days/rooms
    const { rows: rooms } = await db.query('SELECT * FROM rooms ORDER BY id');
    const { rows: staff } = await db.query('SELECT * FROM staff WHERE is_active=true');
    const staffById = {};
    for (const s of staff) staffById[s.id] = s;

    const oldDateStr = shift.shift_date instanceof Date
      ? shift.shift_date.toISOString().split('T')[0]
      : String(shift.shift_date).substring(0, 10);
    const affectedDays = new Set([oldDateStr, newDateStr]);
    for (const dateStr of affectedDays) {
      const { rows: dayShifts } = await db.query(
        `SELECT rs.*, s.is_dsl, s.is_deputy_dsl, s.is_first_aider
         FROM rota_shifts rs JOIN staff s ON s.id=rs.staff_id
         WHERE rs.rota_week_id=$1 AND rs.shift_date=$2`,
        [shift.rota_week_id, dateStr]
      );
      const byRoom = {};
      for (const ds of dayShifts) {
        if (!byRoom[ds.room_id]) byRoom[ds.room_id] = [];
        byRoom[ds.room_id].push(ds);
      }
      for (const [roomId, dayShiftsForRoom] of Object.entries(byRoom)) {
        const room = rooms.find(r => r.id === parseInt(roomId));
        if (!room) continue;
        const flags = computeDayConflicts(dayShiftsForRoom, room);
        await db.query(
          `UPDATE rota_shifts SET conflict_flags=$1
           WHERE rota_week_id=$2 AND shift_date=$3 AND room_id=$4`,
          [JSON.stringify(flags), shift.rota_week_id, dateStr, parseInt(roomId)]
        );
      }
    }

    // Return updated week data for UI refresh
    const { rows: updatedShifts } = await db.query(
      `SELECT rs.*, r.name AS room_name, s.first_name, s.last_name
       FROM rota_shifts rs
       LEFT JOIN rooms r ON r.id=rs.room_id
       LEFT JOIN staff s ON s.id=rs.staff_id
       WHERE rs.rota_week_id=$1 ORDER BY rs.shift_date, rs.staff_id`,
      [shift.rota_week_id]
    );

    res.json({ ok: true, shifts: updatedShifts });
  } catch (err) {
    console.error('rota /shifts/move error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/rota/weeks/:id/publish ─────────────────────────────────────────
router.put('/weeks/:id/publish', checkFeature, managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const weekId = parseInt(req.params.id);
    const { rows: weekRows } = await db.query('SELECT * FROM rota_weeks WHERE id=$1', [weekId]);
    if (!weekRows.length) return res.status(404).json({ error: 'Week not found' });
    const week = weekRows[0];
    const ws = week.week_start.toISOString ? week.week_start.toISOString().split('T')[0] : week.week_start;

    await db.query(
      "UPDATE rota_weeks SET status='published', published_at=NOW(), published_by=$1 WHERE id=$2",
      [req.user.id, weekId]
    );
    try { await afterPublish(db, weekId, ws); } catch (e) { console.error('rota afterPublish error:', e.message); }

    const { rows: shifts } = await db.query(
      `SELECT rs.*, s.first_name, s.last_name, s.email, r.name AS room_name
       FROM rota_shifts rs
       JOIN staff s ON s.id=rs.staff_id
       LEFT JOIN rooms r ON r.id=rs.room_id
       WHERE rs.rota_week_id=$1 ORDER BY rs.staff_id, rs.shift_date`, [weekId]
    );

    const byStaff = {};
    for (const row of shifts) {
      if (!byStaff[row.staff_id]) {
        byStaff[row.staff_id] = { name: `${row.first_name} ${row.last_name}`, email: row.email, shifts: [] };
      }
      byStaff[row.staff_id].shifts.push(row);
    }

    const weekLabel = new Date(ws + 'T00:00:00Z').toLocaleDateString('en-GB',
      { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    const { sent, failed, smtpOk } = await emailRota(byStaff, weekLabel, (id, d) => d.email);

    res.json({ ok: true, week_id: weekId, week_start: ws, sent: sent.length, failed: failed.length, smtp: smtpOk });
  } catch (err) {
    console.error('rota PUT /weeks/:id/publish error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/rota/calendar.ics — iCal feed (published shifts) ─────────────────
router.get('/calendar.ics', async (req, res) => {
  try {
    const { token, staff_id } = req.query;
    const db = getPool();

    let staffId = null;
    if (token) {
      const { rows } = await db.query(
        "SELECT entity_id FROM calendar_feed_tokens WHERE token=$1 AND scope='rota' AND entity_type='staff'",
        [token]
      );
      if (!rows.length) return res.status(403).send('Invalid token');
      staffId = rows[0].entity_id;
    } else if (staff_id && req.user) {
      staffId = parseInt(staff_id);
      // 29 Oct: anyone could pull any colleague's personal shift feed; your own, or a manager.
      if (staffId !== Number(req.user.id) && !hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) {
        return res.status(403).send('Not your calendar');
      }
    } else {
      return res.status(401).send('token or auth required');
    }

    const today = new Date();
    const from = new Date(today); from.setDate(from.getDate() - 7);
    const to = new Date(today); to.setDate(to.getDate() + 56);

    const { rows: shifts } = await db.query(
      `SELECT rs.shift_date, rs.planned_start, rs.planned_end, rs.break_mins,
              r.name AS room_name, s.first_name, s.last_name
       FROM rota_shifts rs
       JOIN rota_weeks rw ON rw.id = rs.rota_week_id
       LEFT JOIN rooms r ON r.id = rs.room_id
       JOIN staff s ON s.id = rs.staff_id
       WHERE rs.staff_id = $1
         AND rw.status = 'published'
         AND rs.shift_date >= $2 AND rs.shift_date <= $3
         AND rs.is_absent = false
       ORDER BY rs.shift_date`,
      [staffId, from.toISOString().split('T')[0], to.toISOString().split('T')[0]]
    );

    const icalLines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Your Nursery//Wren Rota//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:Wren Rota`,
      `X-WR-TIMEZONE:Europe/London`,
    ];

    for (const s of shifts) {
      const dateStr = s.shift_date.toISOString ? s.shift_date.toISOString().split('T')[0] : s.shift_date;
      const dtStamp = dateStr.replace(/-/g, '');
      const startHH = s.planned_start ? String(s.planned_start).substring(0,5).replace(':','') : '0900';
      const endHH = s.planned_end   ? String(s.planned_end).substring(0,5).replace(':','')   : '1700';
      const roomNote = s.room_name ? ` (${s.room_name})` : '';
      icalLines.push(
        'BEGIN:VEVENT',
        `UID:wren-rota-${staffId}-${dtStamp}@example-nursery.co.uk`,
        `DTSTAMP:${new Date().toISOString().replace(/[-:.]/g,'').substring(0,15)}Z`,
        `DTSTART;TZID=Europe/London:${dtStamp}T${startHH}00`,
        `DTEND;TZID=Europe/London:${dtStamp}T${endHH}00`,
        `SUMMARY:Shift${roomNote}`,
        `DESCRIPTION:Your Nursery\\nRoom: ${s.room_name || 'Any'}\\nBreak: ${s.break_mins || 30} mins`,
        `LOCATION:123 Example Lane\\, Ealing\\, AB1 2CD`,
        'END:VEVENT'
      );
    }
    icalLines.push('END:VCALENDAR');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="rota-${staffId}.ics"`);
    res.send(icalLines.join('\r\n'));
  } catch (err) {
    console.error('rota /calendar.ics error:', err.message);
    res.status(500).send('Error generating calendar');
  }
});

// ── GET /api/rota/week/:date/conflicts — per-day conflict summary ─────────────
router.get('/week/:date/conflicts', async (req, res) => {
  try {
    const ws = toWeekStart(req.params.date);
    const db = getPool();

    const { rows: rooms } = await db.query('SELECT * FROM rooms ORDER BY id');

    const { rows: weekRows } = await db.query('SELECT id FROM rota_weeks WHERE week_start=$1', [ws]);
    const weekId = weekRows.length ? weekRows[0].id : null;

    // Shifts (with planned times so we can judge AM/PM concurrency, not flat headcount).
    let shifts = [];
    if (weekId) {
      const r = await db.query(
        `SELECT rs.shift_date, rs.room_id, rs.planned_start, rs.planned_end,
                rs.is_absent, rs.is_meeting, rs.is_open, rs.staff_id,
                s.is_dsl, s.is_deputy_dsl, s.is_first_aider
         FROM rota_shifts rs JOIN staff s ON s.id=rs.staff_id
         WHERE rs.rota_week_id=$1 AND COALESCE(s.is_demo, false) = false`, [weekId]);
      shifts = r.rows;
    }

    // Index shifts by date × room
    const byDayRoom = {};
    for (const s of shifts) {
      if (s.is_open || !s.staff_id || !s.room_id) continue;   // open/unassigned don't count in ratio
      const d = s.shift_date.toISOString ? s.shift_date.toISOString().split('T')[0] : s.shift_date;
      (byDayRoom[d] = byDayRoom[d] || {});
      (byDayRoom[d][s.room_id] = byDayRoom[d][s.room_id] || []).push(s);
    }

    // Emit for EVERY room × Mon–Fri (so a room with zero staff still shows a breach
    // when children are booked). Required is booking + age-band based; present is the
    // worse of AM/PM concurrency.
    const out = {};
    for (let i = 0; i < 5; i++) {
      const date = addDaysStr(ws, i);
      out[date] = {};
      for (const room of rooms) {
        const dayShifts = (byDayRoom[date] && byDayRoom[date][room.id]) || [];
        const req = await requiredForRoomDay(db, room.id, date, room);
        const win = windowPresence(dayShifts);
        out[date][room.id] = {
          room_name: room.name,
          booked: req.booked,
          required: req.required,
          required_source: req.source,
          present: win.present,          // binding = min(AM, PM)
          am_present: win.am,
          pm_present: win.pm,
          headcount: win.headcount,
          ratio: room.ratio_children_per_staff,
          flags: computeDayConflicts(dayShifts, room, req.required),
        };
      }
    }
    res.json({ conflicts: out });
  } catch (err) {
    console.error('rota /conflicts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/rota/week/:date/wage-summary ────────────────────────────────────
// PROMPT 35 (2026-06-30): wage £ totals are pay data → manager-only. managerOnly
// (incl. deputy) still gates rota planning; requireSalaryView excludes deputy here.
router.get('/week/:date/wage-summary', managerOnly, requireSalaryView, async (req, res) => {
  try {
    const ws = toWeekStart(req.params.date);
    const db = getPool();

    const { rows: weekRows } = await db.query('SELECT id FROM rota_weeks WHERE week_start=$1', [ws]);
    if (!weekRows.length) return res.json({ total: 0, by_day: {}, by_staff: {}, total_hours: 0, hours_by_day: {}, total_days: 0 });
    const weekId = weekRows[0].id;

    const { rows: shifts } = await db.query(
      `SELECT rs.shift_date, rs.planned_start, rs.planned_end, rs.break_mins, rs.label,
              rs.is_absent, s.id AS staff_id, s.first_name, s.last_name, s.hourly_rate
       FROM rota_shifts rs JOIN staff s ON s.id=rs.staff_id
       WHERE rs.rota_week_id=$1 AND rs.is_absent=false AND COALESCE(s.is_demo, false) = false
       ORDER BY rs.shift_date, rs.staff_id`,
      [weekId]
    );

    let total = 0;
    const byDay = {};
    const byStaff = {};
    // EyMan/BrightHR parity: surface scheduled HOURS alongside cost. Hours are computed
    // for ALL non-absent shifts (even where hourly_rate is missing) so the headline
    // staff-hours figure is complete; cost only counts shifts that have a rate.
    let totalHours = 0;
    const hoursByDay = {};
    // b192: DAYS worked per staff member. An AM and a PM on the same date is ONE
    // day, so this is a Set of dates — never a shift-row count.
    const daysByStaff = {};

    for (const s of shifts) {
      if (!s.planned_start || !s.planned_end) continue;
      const [sh, sm] = String(s.planned_start).split(':').map(Number);
      const [eh, em] = String(s.planned_end).split(':').map(Number);
      const mins = (eh * 60 + em) - (sh * 60 + sm) - (s.break_mins || 0);
      const hours = Math.max(0, mins / 60);
      const rate = parseFloat(s.hourly_rate);
      const cost = hours * (isFinite(rate) ? rate : 0);

      const d = s.shift_date.toISOString ? s.shift_date.toISOString().split('T')[0] : s.shift_date;
      hoursByDay[d] = (hoursByDay[d] || 0) + hours;
      totalHours += hours;

      const key = `${s.staff_id}`;
      if (!byStaff[key]) byStaff[key] = { name: `${s.first_name} ${s.last_name}`, hourly_rate: s.hourly_rate, total: 0, hours: 0, days: 0 };
      (daysByStaff[key] = daysByStaff[key] || new Set()).add(d);
      byStaff[key].hours += hours;
      if (!s.hourly_rate) continue;   // cost requires a rate; hours already counted above
      byDay[d] = (byDay[d] || 0) + cost;
      byStaff[key].total += cost;
      total += cost;
    }
    // round per-staff/per-day hours for clean display
    for (const k in byStaff) byStaff[k].hours = Math.round(byStaff[k].hours * 100) / 100;
    for (const k in byStaff) byStaff[k].days = daysByStaff[k] ? daysByStaff[k].size : 0;
    for (const d in hoursByDay) hoursByDay[d] = Math.round(hoursByDay[d] * 100) / 100;
    // Total staff-days across the week (AM+PM on one date = 1 for that person).
    const totalDays = Object.values(byStaff).reduce((a, s) => a + s.days, 0);

    const totalRounded = Math.round(total * 100) / 100;
    const totalHoursRounded = Math.round(totalHours * 100) / 100;
    const { rows: wk } = await db.query('SELECT budget, name FROM rota_weeks WHERE id=$1', [weekId]);
    const budget = wk.length && wk[0].budget != null ? parseFloat(wk[0].budget) : null;
    const variance = budget != null ? Math.round((budget - totalRounded) * 100) / 100 : null;

    // Weekly income estimate: trailing 3 complete months of billed invoices ÷ 4.333
    // weeks/month. Lets managers weigh the week's wage bill against revenue at a
    // glance. (Full income modelling incl. LA funding lives in the forecast report.)
    let weeklyIncome = null, wagePctIncome = null;
    try {
      const { rows: inc } = await db.query(`
        SELECT COALESCE(SUM(amount_pence),0) AS pence, COUNT(DISTINCT (period_year,period_month)) AS months
        FROM invoices
        WHERE COALESCE(credit_note_for_id,0)=0 AND period_year IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM children dc WHERE dc.id = invoices.child_id AND COALESCE(dc.is_demo, false))  -- b484 port: demo child never money
          AND make_date(period_year, period_month, 1) >= (date_trunc('month', CURRENT_DATE) - INTERVAL '3 months')
          AND make_date(period_year, period_month, 1) <  date_trunc('month', CURRENT_DATE)`);
      const months = parseInt(inc[0].months) || 0;
      if (months > 0) {
        const monthlyAvg = (parseInt(inc[0].pence) / 100) / months;
        weeklyIncome = Math.round((monthlyAvg / 4.333) * 100) / 100;
        wagePctIncome = weeklyIncome > 0 ? Math.round((totalRounded / weeklyIncome) * 1000) / 10 : null;
      }
    } catch (e) { /* income optional — never block the wage summary */ }

    res.json({
      total: totalRounded, by_day: byDay, by_staff: byStaff,
      total_hours: totalHoursRounded, hours_by_day: hoursByDay,
      total_days: totalDays,        // b192 — staff-days, AM+PM on one date counts once
      budget, variance,
      over_budget: budget != null ? totalRounded > budget : null,
      weekly_income: weeklyIncome,
      wage_pct_income: wagePctIncome,
      name: wk.length ? wk[0].name : null,
    });
  } catch (err) {
    console.error('rota /wage-summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PROMPT 30 — BrightHR-parity additions (copy rota, budget/cost, settings,
//   accept/decline, open shifts, live ratio check, staff notifications).
//   ADDITIVE — all new endpoints; no existing route modified or duplicated.
// ════════════════════════════════════════════════════════════════════════════

// ── Date helpers (UTC, consistent with toWeekStart above) ────────────────────
function ymd(d) { return d instanceof Date ? d.toISOString().split('T')[0] : String(d).substring(0, 10); }
function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}
function daysBetweenStr(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
function fmtT(t) { return t ? String(t).substring(0, 5) : '—'; }

// ── Rota settings (stored as one JSON blob in settings) ─────────────────
const DEFAULT_ROTA_SETTINGS = {
  default_view: 'table',              // table | timeline | dragdrop
  restricted_permissions: false,      // only author/admin may edit (advisory flag surfaced to UI)
  hide_labels_from_employees: false,  // strip shift labels/colours on staff-facing views
  accept_decline_staff: [],           // staff_ids whose new shifts require accept/decline
  open_shifts_enabled: true,          // allow managers to post open (unassigned) shifts
};
async function getRotaSettings(db) {
  try {
    const { rows } = await db.query("SELECT value FROM settings WHERE key='rota_settings'");
    if (rows.length && rows[0].value) return { ...DEFAULT_ROTA_SETTINGS, ...JSON.parse(rows[0].value) };
  } catch (e) { /* fall through to defaults */ }
  return { ...DEFAULT_ROTA_SETTINGS };
}

// GET /api/rota/settings — readable by any authed user (staff UIs need default_view etc.)
router.get('/settings', async (req, res) => {
  try { res.json(await getRotaSettings(getPool())); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── b192: shift-type defaults (Day / AM / PM) ────────────────────────────────
// GET is open to any authed user — the rota UI and the staff-facing views both
// need to know what "AM" means. Stored in settings key 'shift_type_defaults' so
// Toby can retime the patterns without a deploy.
router.get('/shift-types', async (req, res) => {
  try {
    const db = getPool();
    res.json({
      types: shiftTypes.SHIFT_TYPES,
      defaults: await shiftTypes.getShiftTypeDefaults(db),
      slot_aware: await hasSlotColumn(db),   // false = AM+PM on one date not yet migrated in
    });
  } catch (err) {
    console.error('rota /shift-types error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rota/shift-types — manager only. Body: { Day:{start,end,break_mins}, AM:{…}, PM:{…} }
router.post('/shift-types', checkFeature, managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const saved = await shiftTypes.saveShiftTypeDefaults(db, req.body || {}, req.user.id);
    res.json({ ok: true, defaults: saved });
  } catch (err) {
    console.error('rota /shift-types save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rota/break-warnings — shifts whose break_mins disagrees with their shift
// type's default. WARN ONLY (b192 req 4) — nothing here ever writes a correction.
// ── GET /api/rota/week/:date/young-worker-warnings ──────────────────────────
// b317 (2026-09-11): most childcare apprentices are 16 or 17 when they start,
// and a worker under 18 has TIGHTER limits than an adult — 8 hours a day and 40
// a week, a 30-minute break after four and a half hours, 12 hours' rest between
// days and 48 in the week (Working Time Regulations 1998, regs 5A, 12(4), 10(2),
// 11(3)). The rota had no idea: a nine-hour day for a sixteen-year-old saved
// exactly like anyone else's.
//
// WARN ONLY, like /break-warnings and /break-drift beside it. Nothing here
// refuses to save a shift or edits one — a manager may have a reason, and a rota
// that silently rewrites the week is worse than one that asks. The limits, the
// arithmetic and the wording all live in src/lib/otj-rules.js so the same
// sentences appear wherever they are shown.
//
// Manager-only: this reads dates of birth. It returns the AGE and the warning,
// never the date itself.
// pg hands back a DATE as a LOCAL-midnight JS Date. toISOString() on that is a
// day early wherever the container is not UTC (memory: pg DATE -> ymd trap), and
// this router's own ymd() at the foot of the file does exactly that. Reading the
// local parts is correct under any TZ, so the warnings do not quietly move a day
// if TZ is ever set on the container.
function ywYmd(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const p2 = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

router.get('/week/:date/young-worker-warnings', managerOnly, async (req, res) => {
  try {
    const ws = toWeekStart(req.params.date);
    const db = getPool();

    const { rows: weekRows } = await db.query('SELECT id FROM rota_weeks WHERE week_start=$1', [ws]);
    if (!weekRows.length) {
      return res.json({ week_start: ws, count: 0, staff: [], limits: otjRules.YOUNG_WORKER,
                        note: 'No rota week exists for that date yet.' });
    }

    // Under-18 AT ANY POINT IN THIS WEEK, not "under 18 today": a rota drawn in
    // March for July must judge the shift by the age on the day it is worked,
    // and somebody turning 18 mid-week stops being a young worker mid-week.
    const { rows } = await db.query(`
      SELECT rs.id, rs.staff_id, rs.shift_date, rs.planned_start::text AS planned_start,
             rs.planned_end::text AS planned_end, rs.break_mins, rs.is_absent, rs.label,
             s.first_name, s.last_name, s.date_of_birth
        FROM rota_shifts rs
        JOIN staff s ON s.id = rs.staff_id
       WHERE rs.rota_week_id = $1
         AND rs.is_open IS NOT TRUE
         AND COALESCE(s.is_demo, false) = false
         AND s.date_of_birth IS NOT NULL
         AND s.date_of_birth > ($2::date - INTERVAL '18 years')
       ORDER BY rs.staff_id, rs.shift_date, rs.planned_start`, [weekRows[0].id, ws]);

    const byStaff = new Map();
    for (const r of rows) {
      if (!byStaff.has(r.staff_id)) byStaff.set(r.staff_id, { staff: r, shifts: [] });
      byStaff.get(r.staff_id).shifts.push(r);
    }

    const out = [];
    let total = 0;
    for (const { staff, shifts } of byStaff.values()) {
      const dob = ywYmd(staff.date_of_birth);
      // Only the days on which they are still under 18 are judged.
      // shift_date arrives as a JS Date; the rules lib works in 'YYYY-MM-DD'
      // strings, so normalise here rather than letting String(Date) through —
      // that would hand it "Mon Sep 14 2026 …" and every date test would fail
      // silently rather than loudly.
      const inScope = shifts
        .map(sh => Object.assign({}, sh, { shift_date: ywYmd(sh.shift_date) }))
        .filter(sh => otjRules.isYoungWorkerOn(dob, sh.shift_date));
      if (!inScope.length) continue;
      const warnings = otjRules.youngWorkerWarnings(inScope, ws);
      if (!warnings.length) continue;
      total += warnings.length;
      out.push({
        staff_id: staff.staff_id,
        staff_name: `${staff.first_name} ${staff.last_name}`,
        age: otjRules.ageOn(dob, ws),
        warnings,
      });
    }

    res.json({
      week_start: ws, count: total, staff: out, limits: otjRules.YOUNG_WORKER,
      note: total
        ? 'Warnings only — nothing has been changed. Staff with no date of birth on file cannot be checked.'
        : 'No young-worker limits are breached in this week. Staff with no date of birth on file cannot be checked.',
    });
  } catch (err) {
    console.error('rota /young-worker-warnings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/break-warnings', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const defaults = await shiftTypes.getShiftTypeDefaults(db);
    const params = [];
    let where = 'WHERE COALESCE(s.is_demo, false) = false';
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.week || ''))) {
      params.push(toWeekStart(req.query.week));
      where += ' AND rw.week_start = $1::date';
    }
    const { rows } = await db.query(`
      SELECT rs.id, rs.staff_id, rs.shift_date, rs.label, rs.break_mins,
             rs.planned_start::text AS planned_start, rs.planned_end::text AS planned_end,
             s.first_name, s.last_name
        FROM rota_shifts rs
        JOIN rota_weeks rw ON rw.id = rs.rota_week_id
        LEFT JOIN staff s ON s.id = rs.staff_id
        ${where}
       ORDER BY rs.shift_date, rs.staff_id`, params);

    const warnings = [];
    for (const r of rows) {
      const w = shiftTypes.breakWarning(r.label, r.break_mins, defaults);
      if (!w) continue;
      warnings.push({
        shift_id: r.id, staff_id: r.staff_id,
        staff_name: r.first_name ? `${r.first_name} ${r.last_name}` : null,
        shift_date: ymd(r.shift_date), shift_type: r.label,
        times: `${fmtT(r.planned_start)}–${fmtT(r.planned_end)}`,
        break_mins: w.actual, expected_break_mins: w.expected,
      });
    }
    res.json({ count: warnings.length, warnings, defaults });
  } catch (err) {
    console.error('rota /break-warnings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── b189: NAMED shift patterns ───────────────────────────────────────────────
// GET is open to any authed user — a practitioner looking at their own rota should
// be able to see that Tuesday is an "Early", not just "07:45".
router.get('/shift-patterns', async (req, res) => {
  try {
    const db = getPool();
    const includeInactive = String(req.query.all || '') === '1';
    const patterns = await shiftPatterns.listPatterns(db, !includeInactive);
    res.json({
      count: patterns.length,
      patterns,
      note: 'break_mins here is the reference value for the pattern. rota_shifts.break_mins '
          + 'may override it for a genuine exception; disagreements are reported by '
          + 'GET /api/rota/break-drift and are never auto-corrected.',
    });
  } catch (err) {
    console.error('rota /shift-patterns error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rota/break-drift[?week=YYYY-MM-DD] — every shift whose break disagrees with
// its PATTERN's break. b192's /break-warnings does the same against the three broad
// Day/AM/PM types; this is the finer, pattern-level version. Both are WARN ONLY.
//
// Historical shifts are deliberately NOT retro-edited (req 2): a break that was
// actually taken is a fact about the past, and rewriting it would falsify a
// working-time record. They are listed here so the drift is visible instead.
router.get('/break-drift', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    if (!(await hasPatternColumn(db))) {
      return res.json({ count: 0, drift: [], migrated: false,
                        note: 'b189 migration not applied on this edition — no pattern to compare against.' });
    }
    const patterns = await shiftPatterns.listPatterns(db, false);
    const byId = {};
    for (const p of patterns) byId[p.id] = p;

    const params = [];
    let where = 'WHERE rs.pattern_id IS NOT NULL AND COALESCE(s.is_demo, false) = false';
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.week || ''))) {
      params.push(toWeekStart(req.query.week));
      where += ' AND rw.week_start = $1::date';
    }
    const { rows } = await db.query(`
      SELECT rs.id, rs.staff_id, rs.shift_date, rs.break_mins, rs.pattern_id,
             rs.planned_start::text AS planned_start, rs.planned_end::text AS planned_end,
             s.first_name, s.last_name
        FROM rota_shifts rs
        LEFT JOIN rota_weeks rw ON rw.id = rs.rota_week_id
        LEFT JOIN staff s ON s.id = rs.staff_id
        ${where}
       ORDER BY rs.shift_date, rs.staff_id`, params);

    const drift = [];
    for (const r of rows) {
      const d = shiftPatterns.breakDrift(byId[r.pattern_id], r.break_mins);
      if (!d) continue;
      drift.push({
        shift_id: r.id, staff_id: r.staff_id,
        staff_name: r.first_name ? `${r.first_name} ${r.last_name}` : null,
        shift_date: ymd(r.shift_date),
        times: `${shiftPatterns.hhmm(r.planned_start)}-${shiftPatterns.hhmm(r.planned_end)}`,
        ...d,
      });
    }
    // Unmatched shifts are information too — a bespoke time nobody named yet.
    const { rows: unmatched } = await db.query(
      'SELECT count(*)::int AS n FROM rota_shifts WHERE pattern_id IS NULL');
    res.json({
      count: drift.length, drift, migrated: true,
      unmatched_shifts: unmatched[0].n,
      note: 'Warning only — nothing here is ever auto-corrected. Historical shifts are '
          + 'reported, not rewritten.',
    });
  } catch (err) {
    console.error('rota /break-drift error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── b189: GET /api/rota/ratio-check?date=YYYY-MM-DD ──────────────────────────
// Per room, per 30-minute slot across 08:00-18:00: children booked, staff rostered
// (excluding anyone who does not count on ratio), staff required by the CONFIGURED
// ratios, and status under|exact|over.
//
// The arithmetic is NOT reimplemented here — it reuses services/ratio-engine
// (getRatios / ageBandOn / requiredStaff), the same engine the absence gatekeeper
// and the weekly staffing page use, so the three can never disagree. This endpoint
// only surfaces the per-slot detail those callers collapse to a daily number.
router.get('/ratio-check', async (req, res) => {
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date=YYYY-MM-DD required' });
  }
  try {
    res.json(await offratio.ratioCheck(getPool(), date));
  } catch (err) {
    console.error('rota /ratio-check error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rota/settings — manager only
router.post('/settings', checkFeature, managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const current = await getRotaSettings(db);
    const next = { ...current };
    const b = req.body || {};
    if ('default_view' in b && ['table', 'timeline', 'dragdrop'].includes(b.default_view)) next.default_view = b.default_view;
    if ('restricted_permissions' in b) next.restricted_permissions = !!b.restricted_permissions;
    if ('hide_labels_from_employees' in b) next.hide_labels_from_employees = !!b.hide_labels_from_employees;
    if ('open_shifts_enabled' in b) next.open_shifts_enabled = !!b.open_shifts_enabled;
    if ('accept_decline_staff' in b && Array.isArray(b.accept_decline_staff))
      next.accept_decline_staff = b.accept_decline_staff.map(Number).filter(n => !isNaN(n));
    await db.query(
      `INSERT INTO settings (key, value, updated_by, updated_at)
       VALUES ('rota_settings', $1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
      [JSON.stringify(next), req.user.id]
    );
    res.json({ ok: true, settings: next });
  } catch (err) {
    console.error('rota /settings POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rota/week/:date/budget — set rota budget / name / duration ──────
router.post('/week/:date/budget', checkFeature, managerOnly, async (req, res) => {
  try {
    const ws = toWeekStart(req.params.date);
    const db = getPool();
    const { budget, name, duration_days } = req.body || {};
    const { rows } = await db.query(
      `INSERT INTO rota_weeks (week_start, status, budget, name, duration_days, created_at)
       VALUES ($1, 'draft', $2, $3, $4, NOW())
       ON CONFLICT (week_start) DO UPDATE SET
         budget        = COALESCE($2, rota_weeks.budget),
         name          = COALESCE($3, rota_weeks.name),
         duration_days = COALESCE($4, rota_weeks.duration_days)
       RETURNING id, week_start, status, budget, name, duration_days`,
      [ws, (budget != null && budget !== '') ? budget : null, name || null,
       duration_days ? parseInt(duration_days) : null]
    );
    res.json({ ok: true, week: rows[0] });
  } catch (err) {
    console.error('rota /budget error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rota/week/:date/copy-from/:sourceId — copy shifts to a new week ─
router.post('/week/:date/copy-from/:sourceId', checkFeature, managerOnly, async (req, res) => {
  try {
    const ws = toWeekStart(req.params.date);
    const sourceId = parseInt(req.params.sourceId);
    const db = getPool();
    const { name, duration_days, budget, team_room_id } = req.body || {};

    const { rows: srcRows } = await db.query('SELECT * FROM rota_weeks WHERE id=$1', [sourceId]);
    if (!srcRows.length) return res.status(404).json({ error: 'source rota not found' });
    const source = srcRows[0];
    const srcStart = ymd(source.week_start);

    const { rows: tw } = await db.query(
      `INSERT INTO rota_weeks (week_start, status, name, duration_days, budget, copied_from, created_at)
       VALUES ($1, 'draft', $2, $3, $4, $5, NOW())
       ON CONFLICT (week_start) DO UPDATE SET
         name          = COALESCE(EXCLUDED.name, rota_weeks.name),
         duration_days = EXCLUDED.duration_days,
         budget        = COALESCE(EXCLUDED.budget, rota_weeks.budget),
         copied_from   = EXCLUDED.copied_from
       RETURNING id`,
      [ws, name || source.name || null,
       duration_days ? parseInt(duration_days) : (source.duration_days || 7),
       (budget != null && budget !== '') ? budget : source.budget,
       sourceId]
    );
    const weekId = tw[0].id;

    // Clean slate on the target week before copying.
    await db.query('DELETE FROM rota_shifts WHERE rota_week_id=$1', [weekId]);

    const { rows: srcShifts } = await db.query('SELECT * FROM rota_shifts WHERE rota_week_id=$1', [sourceId]);
    const dayOffset = daysBetweenStr(srcStart, ws);
    const copyConflictTarget = await shiftConflictTarget(db);   // b192: slot-aware
    let copied = 0;
    for (const s of srcShifts) {
      if (team_room_id && s.room_id && parseInt(team_room_id) !== s.room_id) continue; // By-team filter
      const sd = addDaysStr(ymd(s.shift_date), dayOffset);
      await db.query(
        `INSERT INTO rota_shifts
           (rota_week_id, staff_id, shift_date, day_of_week, planned_start, planned_end,
            room_id, break_mins, notes, label, colour, is_open, acceptance, source, conflict_flags, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'not_required','copy','[]',NOW())
         ON CONFLICT ${copyConflictTarget} DO NOTHING`,
        [weekId, s.staff_id, sd, s.day_of_week, s.planned_start, s.planned_end,
         s.room_id, s.break_mins, s.notes, s.label, s.colour, !!s.is_open]
      );
      copied++;
    }
    res.json({ ok: true, week_id: weekId, week_start: ws, shifts_copied: copied, copied_from: sourceId });
  } catch (err) {
    console.error('rota /copy-from error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/rota/week/:date/ratio — live childcare ratio check (Wren's edge) ─
// Cross-checks rota staffing against BOOKED children (attendance weekday pattern)
// per room/age-band, flagging under-ratio days. This is what BrightHR cannot do.
router.get('/week/:date/ratio', async (req, res) => {
  try {
    const ws = toWeekStart(req.params.date);
    const db = getPool();

    const { rows: rooms } = await db.query(
      'SELECT id, name, capacity, ratio_children_per_staff FROM rooms ORDER BY ratio_children_per_staff'
    );
    const babyRoom = rooms.find(r => /bab/i.test(r.name)) ||
                     rooms.find(r => (r.ratio_children_per_staff || 8) <= 3) || rooms[0];
    const psRoom = rooms.find(r => !babyRoom || r.id !== babyRoom.id) || rooms[rooms.length - 1];

    const { rows: weekRows } = await db.query('SELECT id FROM rota_weeks WHERE week_start=$1', [ws]);
    const weekId = weekRows.length ? weekRows[0].id : null;

    // Present staff per (date, room) from the rota — exclude absent / meeting / still-open shifts.
    // b192: count DISTINCT staff, not shift rows. Someone rostered AM *and* PM on one
    // date is one pair of hands that day, not two — counting rows would inflate cover
    // and hide a genuine ratio breach.
    const presentByDayRoom = {};
    if (weekId) {
      const { rows: shifts } = await db.query(
        `SELECT rs.shift_date, rs.room_id, rs.is_absent, rs.is_meeting, rs.is_open, rs.staff_id
         FROM rota_shifts rs
         LEFT JOIN staff s ON s.id = rs.staff_id
         WHERE rs.rota_week_id=$1 AND COALESCE(s.is_demo, false) = false`, [weekId]);
      const seen = {};
      for (const s of shifts) {
        if (s.is_absent || s.is_meeting || s.is_open || !s.staff_id || !s.room_id) continue;
        const d = ymd(s.shift_date);
        const k = `${d}_${s.room_id}_${s.staff_id}`;
        if (seen[k]) continue;
        seen[k] = true;
        presentByDayRoom[d] = presentByDayRoom[d] || {};
        presentByDayRoom[d][s.room_id] = (presentByDayRoom[d][s.room_id] || 0) + 1;
      }
    }

    // b314 (2026-09-10) — this board used to split children between the two rooms
    // by AGE, not by the room they are in: Baby Room showed every under-2 in the
    // setting and Pre-school showed everyone else. So which room a child was
    // actually booked into made no difference to either number, and moving a
    // child between rooms changed nothing here — the same failure Toby found on
    // the occupancy board, in the one place where being wrong is a legal
    // question. A three-year-old kept in the Baby Room was counted against
    // Pre-school and the Baby Room's requirement was understated.
    //
    // It now counts each room's OWN booked children and applies the statutory
    // ratio band by band within the room, using the configured ratios (LADN runs
    // 1:4 for two-year-olds, stricter than statutory) rather than hard-coded
    // 3/5/8. The setting-wide age totals stay on `booked` exactly as before.
    const ratios = await ratioEngine.getRatios(db);
    const days = {};
    let anyUnder = false;
    let notBooked = null;
    for (let i = 0; i < 5; i++) {
      const dateStr = addDaysStr(ws, i);
      const booked = await ratioEngine.bookedChildrenByBand(db, dateStr); // {under2,two,threePlus,total}
      const byRoom = await ratioEngine.bookedChildrenByRoom(db, dateStr);
      if (!notBooked) notBooked = byRoom.not_booked;

      const roomsOut = {};
      for (const rm of byRoom.rooms) {
        if (rm.room_id == null) continue;      // reported separately, never folded in
        const required = ratioEngine.requiredStaff(rm, ratios);
        const present = (presentByDayRoom[dateStr] || {})[rm.room_id] || 0;
        // b316 (2026-09-11) — Toby signed off the room-based number and asked to
        // see the old age-based one beside it: nearly-two-year-olds are flexed
        // between rooms on the day depending on staff, so for the rota the age
        // split is still the working figure and the room figure matters more for
        // long-term planning. Both are the same configured ratios; only the
        // grouping differs. `required` stays the room-based figure, so nothing
        // that already reads it changes meaning.
        const isBaby = babyRoom && rm.room_id === babyRoom.id;
        const byAgeCounts = isBaby
          ? { under2: booked.under2 || 0 }
          : { two: booked.two || 0, threePlus: booked.threePlus || 0 };
        const byAgeBooked = isBaby ? (booked.under2 || 0) : (booked.two || 0) + (booked.threePlus || 0);
        roomsOut[rm.room_id] = {
          room_name: rm.room_name, booked: rm.total, required, present,
          under_ratio: present < required,
          bands: { under2: rm.under2, two: rm.two, threePlus: rm.threePlus },
          by_age: { booked: byAgeBooked, required: ratioEngine.requiredStaff(byAgeCounts, ratios),
                    under_ratio: present < ratioEngine.requiredStaff(byAgeCounts, ratios) },
        };
      }
      const unassigned = byRoom.rooms.find(r => r.room_id == null) || null;
      const dayUnder = Object.values(roomsOut).some(r => r.under_ratio);
      if (dayUnder) anyUnder = true;
      days[dateStr] = { weekday: i, booked, rooms: roomsOut, under_ratio: dayUnder,
        booked_source: 'booking room', ...(unassigned && unassigned.total ? { unassigned } : {}) };
    }
    res.json({ week_start: ws, any_under_ratio: anyUnder, days, ratios,
      // Children who are enrolled but have no live booking are in nobody's
      // count. Under-counting is the dangerous direction for a ratio, so the
      // board says so out loud instead of quietly running short.
      not_booked: notBooked || { total: 0, by_room: {} } });
  } catch (err) {
    console.error('rota /ratio error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rota/week/:date/open-shift — manager posts an unassigned shift ──
router.post('/week/:date/open-shift', checkFeature, managerOnly, async (req, res) => {
  try {
    const ws = toWeekStart(req.params.date);
    const db = getPool();
    const settings = await getRotaSettings(db);
    if (!settings.open_shifts_enabled) return res.status(403).json({ error: 'open_shifts_disabled' });

    const { shift_date, planned_start, planned_end, room_id, break_mins, label, colour, notes } = req.body || {};
    if (!shift_date || !/^\d{4}-\d{2}-\d{2}$/.test(shift_date))
      return res.status(400).json({ error: 'shift_date (YYYY-MM-DD) required' });

    const { rows: wk } = await db.query(
      `INSERT INTO rota_weeks (week_start, status, created_at) VALUES ($1, 'draft', NOW())
       ON CONFLICT (week_start) DO UPDATE SET week_start=EXCLUDED.week_start RETURNING id`, [ws]);
    const weekId = wk[0].id;
    const dow = daysBetweenStr(ws, ymd(shift_date));

    // b192: an open shift carries a type too, so "post the PM" needs no times typed.
    const openLabel = shiftTypes.normaliseLabel(label);
    const openDef = (await shiftTypes.getShiftTypeDefaults(db))[openLabel] || null;

    const { rows } = await db.query(
      `INSERT INTO rota_shifts
         (rota_week_id, staff_id, shift_date, day_of_week, planned_start, planned_end,
          room_id, break_mins, label, colour, notes, is_open, acceptance, source, conflict_flags, created_at)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, 'not_required', 'open', '[]', NOW())
       RETURNING *`,
      [weekId, ymd(shift_date), dow,
       planned_start || (openDef && openDef.start) || null,
       planned_end || (openDef && openDef.end) || null,
       room_id ? parseInt(room_id) : null,
       break_mins != null ? parseInt(break_mins) : (openDef ? openDef.break_mins : 30),
       openLabel, colour || null, notes || null]
    );
    const shift = rows[0];
    notifyOpenShift(db, shift).catch(e => console.error('notifyOpenShift:', e.message));
    res.json({ ok: true, shift });
  } catch (err) {
    console.error('rota /open-shift error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/rota/open — open shifts the current user is eligible to claim ────
router.get('/open', async (req, res) => {
  try {
    const db = getPool();
    const today = ymd(new Date());
    const { rows: me } = await db.query('SELECT room_id FROM staff WHERE id=$1', [req.user.id]);
    const myRoom = me.length ? me[0].room_id : null;
    const { rows } = await db.query(
      `SELECT rs.*, r.name AS room_name
       FROM rota_shifts rs
       JOIN rota_weeks rw ON rw.id = rs.rota_week_id
       LEFT JOIN rooms r ON r.id = rs.room_id
       WHERE rs.is_open = true AND rs.staff_id IS NULL
         AND rs.shift_date >= $1
         AND rw.status = 'published'
         AND (rs.room_id IS NULL OR $2::int IS NULL OR rs.room_id = $2)
         AND NOT EXISTS (
           SELECT 1 FROM rota_shifts x
           WHERE x.rota_week_id = rs.rota_week_id AND x.staff_id = $3 AND x.shift_date = rs.shift_date
             -- b192: only the SAME half of the day is a clash. Already on an AM?
             -- An open PM on that date is still claimable.
             AND ${shiftTypes.slotSql('x')} = ${shiftTypes.slotSql('rs')})
       ORDER BY rs.shift_date, rs.planned_start`,
      [today, myRoom, req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('rota /open error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rota/shift/:id/claim — atomic first-come-first-served claim ─────
router.post('/shift/:id/claim', async (req, res) => {
  const shiftId = parseInt(req.params.id);
  const staffId = req.user.id;
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Row-lock the candidate shift so concurrent claims serialise on it.
    const { rows: lock } = await client.query('SELECT * FROM rota_shifts WHERE id=$1 FOR UPDATE', [shiftId]);
    if (!lock.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'shift not found' }); }
    const sh = lock[0];
    if (!sh.is_open || sh.staff_id) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'already_claimed' }); }
    // b192: a clash is same date AND same AM/PM/FULL slot — an AM shift does not
    // block claiming the PM open shift on that date.
    const { rows: clash } = await client.query(
      `SELECT 1 FROM rota_shifts WHERE rota_week_id=$1 AND staff_id=$2 AND shift_date=$3
         AND ${SLOT_EXPR} = $4`,
      [sh.rota_week_id, staffId, ymd(sh.shift_date), shiftTypes.slotOf(sh.label)]);
    if (clash.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'already_scheduled_that_day' }); }
    const { rows: upd } = await client.query(
      `UPDATE rota_shifts
         SET staff_id=$1, is_open=false, acceptance='accepted', claimed_at=NOW(), responded_at=NOW(), source='claim'
       WHERE id=$2 AND is_open=true AND staff_id IS NULL
       RETURNING *`, [staffId, shiftId]);
    if (!upd.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'already_claimed' }); }
    await client.query('COMMIT');
    notifyManagers(db, 'rota_shift_claimed', 'Open shift claimed',
      `${req.user.name || 'A staff member'} claimed the ${ymd(sh.shift_date)} ${fmtT(sh.planned_start)}–${fmtT(sh.planned_end)} shift.`)
      .catch(e => console.error('notifyManagers:', e.message));
    res.json({ ok: true, shift: upd[0] });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('rota /claim error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── POST /api/rota/shift/:id/respond { accept:true|false } — accept/decline ───
router.post('/shift/:id/respond', async (req, res) => {
  try {
    const shiftId = parseInt(req.params.id);
    const accept = !!(req.body && req.body.accept);
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM rota_shifts WHERE id=$1', [shiftId]);
    if (!rows.length) return res.status(404).json({ error: 'shift not found' });
    const sh = rows[0];
    const isManager = hasRole(req.user, ['manager', 'deputy_manager', 'admin']);
    if (sh.staff_id !== req.user.id && !isManager) return res.status(403).json({ error: 'not your shift' });
    const newState = accept ? 'accepted' : 'declined';
    const { rows: upd } = await db.query(
      `UPDATE rota_shifts SET acceptance=$1, responded_at=NOW() WHERE id=$2 RETURNING *`,
      [newState, shiftId]);
    if (!accept) {
      notifyManagers(db, 'rota_shift_declined', 'Shift declined',
        `${req.user.name || 'A staff member'} declined the ${ymd(sh.shift_date)} ${fmtT(sh.planned_start)}–${fmtT(sh.planned_end)} shift.`)
        .catch(e => console.error('notifyManagers:', e.message));
    }
    res.json({ ok: true, shift: upd[0] });
  } catch (err) {
    console.error('rota /respond error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Notification helpers ─────────────────────────────────────────────────────
async function notifyManagers(db, category, title, body) {
  const { rows } = await db.query(
    "SELECT id FROM staff WHERE (is_active=true OR is_active IS NULL) AND role IN ('manager','deputy_manager','admin')");
  for (const r of rows) notify(category, 'staff', r.id, title, body, { relatedTable: 'rota_shifts' });
}

async function notifyOpenShift(db, shift) {
  const dateStr = ymd(shift.shift_date);
  const { rows } = await db.query(
    `SELECT id FROM staff
     WHERE (is_active=true OR is_active IS NULL)
       -- b271: this EXCLUDES people from the open-shift offer, so the rename
       -- inverts it. Before b271 'manager' meant the owners; the deputies were
       -- offered open shifts because they are on the floor. Excluding the new
       -- 'manager' would stop offering shifts to exactly the three people who
       -- cover them. Exclude the owners only.
       AND role NOT IN ('admin','owner')
       AND ($1::int IS NULL OR room_id = $1 OR room_id IS NULL)
       AND id NOT IN (
         SELECT staff_id FROM rota_shifts
         WHERE rota_week_id=$2 AND staff_id IS NOT NULL AND shift_date=$3)`,
    [shift.room_id || null, shift.rota_week_id, dateStr]);
  const t = `${fmtT(shift.planned_start)}–${fmtT(shift.planned_end)}`;
  for (const r of rows) {
    notify('rota_open_shift', 'staff', r.id,
      `Open shift available — ${dateStr}`,
      `${t}${shift.label ? ' · ' + shift.label : ''}. First to claim gets it.`,
      { relatedTable: 'rota_shifts', relatedId: shift.id, link: '/my-shifts.html' });
  }
}

// Called from both publish handlers: flip accept/decline-enabled staff to 'pending'
// and push each rostered staff member a "your rota is published" notification.
async function afterPublish(db, weekId, ws) {
  const settings = await getRotaSettings(db);
  const adIds = (settings.accept_decline_staff || []).map(Number).filter(n => !isNaN(n));
  if (adIds.length) {
    await db.query(
      `UPDATE rota_shifts SET acceptance='pending'
       WHERE rota_week_id=$1 AND is_open=false AND COALESCE(is_absent,false)=false
         AND acceptance='not_required' AND staff_id = ANY($2::int[])`,
      [weekId, adIds]);
  }
  const { rows: staffShifts } = await db.query(
    `SELECT DISTINCT staff_id FROM rota_shifts
     WHERE rota_week_id=$1 AND staff_id IS NOT NULL AND COALESCE(is_absent,false)=false`, [weekId]);
  const label = new Date(ws + 'T00:00:00Z').toLocaleDateString('en-GB',
    { day: 'numeric', month: 'long', timeZone: 'UTC' });
  for (const r of staffShifts) {
    notify('rota_published', 'staff', r.staff_id,
      `Your rota is published — w/c ${label}`,
      'Tap to view your shifts for the week.',
      { relatedTable: 'rota_weeks', relatedId: weekId, link: '/my-shifts.html' });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PAYROLL EXPORT (2026-07-01) — weekly rota → per-staff hours (+ est. cost) as
// CSV and PDF for payroll. ADDITIVE. Manager-only + salary-view gated (hours are
// benign but cost is pay data; keep the whole export behind the same gate as
// /wage-summary for consistency). Maths mirrors /wage-summary exactly so totals
// reconcile. Non-absent, non-open, assigned shifts only.
// ════════════════════════════════════════════════════════════════════════════
async function computePayroll(db, weekStartDate) {
  const ws = toWeekStart(weekStartDate);
  const { rows: weekRows } = await db.query('SELECT id, name, status FROM rota_weeks WHERE week_start=$1', [ws]);
  const week = weekRows[0] || null;
  const dates = []; for (let i = 0; i < 7; i++) dates.push(addDaysStr(ws, i)); // Mon..Sun
  if (!week) return { week_start: ws, week_name: null, status: null, dates, staff: [], totals: { hours: 0, cost: 0, days: 0 } };

  const { rows: shifts } = await db.query(
    `SELECT rs.shift_date, rs.planned_start, rs.planned_end, rs.break_mins, rs.label,
            s.id AS staff_id, s.first_name, s.last_name, s.role, s.hourly_rate
     FROM rota_shifts rs JOIN staff s ON s.id = rs.staff_id
     WHERE rs.rota_week_id=$1 AND rs.is_absent=false AND COALESCE(rs.is_open,false)=false
       AND COALESCE(s.is_demo, false) = false
     ORDER BY s.last_name, s.first_name, rs.shift_date`, [week.id]);

  const byStaff = {};
  let totHours = 0, totCost = 0;
  for (const s of shifts) {
    if (!s.planned_start || !s.planned_end) continue;
    const [sh, sm] = String(s.planned_start).split(':').map(Number);
    const [eh, em] = String(s.planned_end).split(':').map(Number);
    const mins = (eh * 60 + em) - (sh * 60 + sm) - (s.break_mins || 0);
    const hours = Math.max(0, mins / 60);
    const rate = parseFloat(s.hourly_rate);
    const cost = hours * (isFinite(rate) ? rate : 0);
    const d = s.shift_date.toISOString ? s.shift_date.toISOString().split('T')[0] : String(s.shift_date).slice(0, 10);
    const k = `${s.staff_id}`;
    if (!byStaff[k]) byStaff[k] = { staff_id: s.staff_id, name: `${s.first_name} ${s.last_name}`,
      role: s.role, hourly_rate: isFinite(rate) ? rate : null, per_day: {}, total_hours: 0, total_cost: 0,
      _dates: new Set() };
    // b192: per_day already merges an AM and a PM into the one date cell; _dates is
    // the day count for payroll — DISTINCT dates, so AM+PM on one date is 1 day.
    byStaff[k]._dates.add(d);
    byStaff[k].per_day[d] = (byStaff[k].per_day[d] || 0) + hours;
    byStaff[k].total_hours += hours;
    byStaff[k].total_cost += cost;
    totHours += hours; totCost += cost;
  }
  const r2 = n => Math.round(n * 100) / 100;
  const staff = Object.values(byStaff).map(x => {
    x.total_hours = r2(x.total_hours); x.total_cost = r2(x.total_cost);
    x.days_worked = x._dates.size; delete x._dates;
    for (const d in x.per_day) x.per_day[d] = r2(x.per_day[d]);
    return x;
  }).sort((a, b) => a.name.localeCompare(b.name));
  const totDays = staff.reduce((a, s) => a + s.days_worked, 0);
  return { week_start: ws, week_name: week.name, status: week.status, dates, staff,
    totals: { hours: r2(totHours), cost: r2(totCost), days: totDays } };
}

function dayLabel(dateStr) {
  const dt = new Date(dateStr + 'T00:00:00Z');
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getUTCDay()] + ' ' + dateStr.slice(8) + '/' + dateStr.slice(5, 7);
}

// GET /api/rota/week/:date/payroll.csv — all 7 day columns so column-sum == total.
router.get('/week/:date/payroll.csv', managerOnly, requireSalaryView, async (req, res) => {
  try {
    const p = await computePayroll(getPool(), req.params.date);
    const esc = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [];
    // b192: 'Days worked' counts DISTINCT dates — an AM + a PM on one date is 1 day.
    lines.push(['Staff', 'Role', ...p.dates.map(dayLabel), 'Days worked', 'Total hours', 'Hourly rate (£)', 'Est. cost (£)'].map(esc).join(','));
    for (const s of p.staff) {
      const dayCells = p.dates.map(d => (s.per_day[d] != null ? s.per_day[d] : ''));
      lines.push([s.name, s.role || '', ...dayCells, s.days_worked, s.total_hours, s.hourly_rate != null ? s.hourly_rate : '', s.total_cost].map(esc).join(','));
    }
    const totalDayCells = p.dates.map(d => { let h = 0; for (const s of p.staff) h += (s.per_day[d] || 0); return h ? Math.round(h * 100) / 100 : ''; });
    lines.push(['TOTAL', '', ...totalDayCells, p.totals.days, p.totals.hours, '', p.totals.cost].map(esc).join(','));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="payroll-${p.week_start}.csv"` });
    res.send('﻿' + lines.join('\r\n')); // BOM so Excel reads UTF-8
  } catch (e) { console.error('rota payroll.csv:', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// GET /api/rota/week/:date/payroll.pdf — printable per-staff hours summary.
router.get('/week/:date/payroll.pdf', managerOnly, requireSalaryView, async (req, res) => {
  try {
    const p = await computePayroll(getPool(), req.params.date);
    const doc = new PDFDoc({ size: 'A4', layout: 'landscape', margins: { top: 40, bottom: 40, left: 40, right: 40 } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

    doc.fontSize(17).fillColor('#0f172a').text('Your Nursery — Payroll');
    doc.moveDown(0.15).fontSize(10).fillColor('#475569')
      .text(`Week commencing ${p.week_start}${p.week_name ? ' · ' + p.week_name : ''}${p.status ? ' · ' + p.status : ''}   (generated ${new Date().toISOString().slice(0, 10)})`);
    doc.moveDown(0.6);

    // Weekday columns only (Mon–Fri) to keep the grid readable; Total column is authoritative.
    const cols = p.dates.slice(0, 5);
    const x0 = 40, wName = 150, wDay = 62, wDays = 50, wTot = 58, wCost = 74;
    const header = ['Staff', ...cols.map(dayLabel), 'Days', 'Total h', 'Est £'];
    const widths = [wName, ...cols.map(() => wDay), wDays, wTot, wCost];
    let y = doc.y;
    const drawRow = (cells, opts = {}) => {
      let x = x0;
      doc.fontSize(opts.head ? 8.5 : 9).fillColor(opts.head ? '#334155' : (opts.total ? '#0f172a' : '#1e293b'));
      if (opts.head) doc.font('Helvetica-Bold'); else if (opts.total) doc.font('Helvetica-Bold'); else doc.font('Helvetica');
      cells.forEach((c, i) => {
        const align = i === 0 ? 'left' : 'right';
        doc.text(String(c == null ? '' : c), x + 3, y + 3, { width: widths[i] - 6, align });
        x += widths[i];
      });
      y += 18;
      doc.moveTo(x0, y).lineTo(x0 + widths.reduce((a, b) => a + b, 0), y).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
    };
    drawRow(header, { head: true });
    for (const s of p.staff) {
      if (y > 520) { doc.addPage({ layout: 'landscape', margins: { top: 40, bottom: 40, left: 40, right: 40 } }); y = 40; drawRow(header, { head: true }); }
      const dayCells = cols.map(d => (s.per_day[d] != null ? s.per_day[d].toFixed(2) : '—'));
      drawRow([s.name, ...dayCells, s.days_worked, s.total_hours.toFixed(2), s.hourly_rate != null ? '£' + s.total_cost.toFixed(2) : '—']);
    }
    const totalDayCells = cols.map(d => { let h = 0; for (const s of p.staff) h += (s.per_day[d] || 0); return h ? h.toFixed(2) : '—'; });
    drawRow(['TOTAL', ...totalDayCells, p.totals.days, p.totals.hours.toFixed(2), '£' + p.totals.cost.toFixed(2)], { total: true });

    doc.font('Helvetica').fontSize(8).fillColor('#94a3b8')
      .text('Hours = planned end − start − break, non-absent assigned shifts. Days = distinct dates worked — an AM and a PM on the same date count as one day. Est £ uses each staff hourly rate; blank where no rate is set. Weekday columns shown; Total column includes any weekend shifts.', x0, y + 10, { width: widths.reduce((a, b) => a + b, 0) });

    doc.end();
    const buf = await done;
    res.set({ 'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="payroll-${p.week_start}.pdf"`, 'Content-Length': buf.length });
    res.send(buf);
  } catch (e) { console.error('rota payroll.pdf:', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// GET /api/rota/week/:date/hours.csv — b488: an hours-only export for managers
// who are NOT salary-view (room leaders/deputy post-b271) — same per-day hours
// breakdown as payroll.csv, no rate/cost columns, so it never needs requireSalaryView.
router.get('/week/:date/hours.csv', managerOnly, async (req, res) => {
  try {
    const p = await computePayroll(getPool(), req.params.date);
    const esc = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [];
    lines.push(['Staff', 'Role', ...p.dates.map(dayLabel), 'Days worked', 'Total hours'].map(esc).join(','));
    for (const s of p.staff) {
      const dayCells = p.dates.map(d => (s.per_day[d] != null ? s.per_day[d] : ''));
      lines.push([s.name, s.role || '', ...dayCells, s.days_worked, s.total_hours].map(esc).join(','));
    }
    const totalDayCells = p.dates.map(d => { let h = 0; for (const s of p.staff) h += (s.per_day[d] || 0); return h ? Math.round(h * 100) / 100 : ''; });
    lines.push(['TOTAL', '', ...totalDayCells, p.totals.days, p.totals.hours].map(esc).join(','));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="hours-${p.week_start}.csv"` });
    res.send('﻿' + lines.join('\r\n')); // BOM so Excel reads UTF-8
  } catch (e) { console.error('rota hours.csv:', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// GET /api/rota/week/:date/hours.pdf — printable per-staff hours summary, no pay.
router.get('/week/:date/hours.pdf', managerOnly, async (req, res) => {
  try {
    const p = await computePayroll(getPool(), req.params.date);
    const doc = new PDFDoc({ size: 'A4', layout: 'landscape', margins: { top: 40, bottom: 40, left: 40, right: 40 } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

    doc.fontSize(17).fillColor('#0f172a').text('Your Nursery — Hours');
    doc.moveDown(0.15).fontSize(10).fillColor('#475569')
      .text(`Week commencing ${p.week_start}${p.week_name ? ' · ' + p.week_name : ''}${p.status ? ' · ' + p.status : ''}   (generated ${new Date().toISOString().slice(0, 10)})`);
    doc.moveDown(0.6);

    const cols = p.dates.slice(0, 5);
    const x0 = 40, wName = 180, wDay = 70, wDays = 60, wTot = 70;
    const header = ['Staff', ...cols.map(dayLabel), 'Days', 'Total h'];
    const widths = [wName, ...cols.map(() => wDay), wDays, wTot];
    let y = doc.y;
    const drawRow = (cells, opts = {}) => {
      let x = x0;
      doc.fontSize(opts.head ? 8.5 : 9).fillColor(opts.head ? '#334155' : (opts.total ? '#0f172a' : '#1e293b'));
      if (opts.head) doc.font('Helvetica-Bold'); else if (opts.total) doc.font('Helvetica-Bold'); else doc.font('Helvetica');
      cells.forEach((c, i) => {
        const align = i === 0 ? 'left' : 'right';
        doc.text(String(c == null ? '' : c), x + 3, y + 3, { width: widths[i] - 6, align });
        x += widths[i];
      });
      y += 18;
      doc.moveTo(x0, y).lineTo(x0 + widths.reduce((a, b) => a + b, 0), y).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
    };
    drawRow(header, { head: true });
    for (const s of p.staff) {
      if (y > 520) { doc.addPage({ layout: 'landscape', margins: { top: 40, bottom: 40, left: 40, right: 40 } }); y = 40; drawRow(header, { head: true }); }
      const dayCells = cols.map(d => (s.per_day[d] != null ? s.per_day[d].toFixed(2) : '—'));
      drawRow([s.name, ...dayCells, s.days_worked, s.total_hours.toFixed(2)]);
    }
    const totalDayCells = cols.map(d => { let h = 0; for (const s of p.staff) h += (s.per_day[d] || 0); return h ? h.toFixed(2) : '—'; });
    drawRow(['TOTAL', ...totalDayCells, p.totals.days, p.totals.hours.toFixed(2)], { total: true });

    doc.font('Helvetica').fontSize(8).fillColor('#94a3b8')
      .text('Hours = planned end − start − break, non-absent assigned shifts. Days = distinct dates worked — an AM and a PM on the same date count as one day. Weekday columns shown; Total column includes any weekend shifts.', x0, y + 10, { width: widths.reduce((a, b) => a + b, 0) });

    doc.end();
    const buf = await done;
    res.set({ 'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="hours-${p.week_start}.pdf"`, 'Content-Length': buf.length });
    res.send(buf);
  } catch (e) { console.error('rota hours.pdf:', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// GET /api/rota/events?week=YYYY-MM-DD — read events (including planner_events if present)
router.get('/events', async (req, res) => {
  try {
    const weekParam = req.query.week;
    if (!weekParam || !/^\d{4}-\d{2}-\d{2}$/.test(weekParam)) {
      return res.status(400).json({ error: 'week query param required (YYYY-MM-DD)' });
    }
    const ws = toWeekStart(weekParam);
    const db = getPool();
    const { rows: evRows } = await db.query(
      `SELECT id, date, title, kind, starts_at, ends_at, room, notes, source, source_ref, created_by, created_at
       FROM rota_events WHERE date >= $1 AND date <= $2`,
      [ws, new Date(new Date(ws).setDate(new Date(ws).getDate() + 6)).toISOString().split('T')[0]]
    );
    let combined = evRows;
    // Attempt to include planner_events if table exists
    try {
      const { rows: plRows } = await db.query(
        `SELECT id, date, title, kind, starts_at, ends_at, room, notes, 'planner' AS source, source_ref, created_by, created_at
         FROM planner_events WHERE date >= $1 AND date <= $2`,
        [ws, new Date(new Date(ws).setDate(new Date(ws).getDate() + 6)).toISOString().split('T')[0]]
      );
      combined = combined.concat(plRows);
    } catch (e) {
      // ignore if planner_events missing
    }
    res.json(combined);
  } catch (err) {
    console.error('rota /events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rota/events — create event (manager only)
router.post('/events', managerOnly, async (req, res) => {
  try {
    const { date, title, kind, starts_at, ends_at, room, notes, source_ref } = req.body;
    if (!date || !title) return res.status(400).json({ error: 'date and title required' });
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO rota_events (date, title, kind, starts_at, ends_at, room, notes, source, source_ref, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9) RETURNING *`,
      [date, title, kind||'event', starts_at||null, ends_at||null, room||null, notes||null, source_ref||null, req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('rota POST /events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/rota/events/:id — delete event (manager only)
router.delete('/events/:id', managerOnly, async (req, res) => {
  try {
    const evId = parseInt(req.params.id);
    const db = getPool();
    await db.query('DELETE FROM rota_events WHERE id=$1', [evId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('rota DELETE /events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rota/events/suggest-meetings?from=YYYY-MM-DD — staff meeting suggestions (manager only)
router.get('/events/suggest-meetings', managerOnly, async (req, res) => {
  try {
    const from = req.query.from;
    if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      return res.status(400).json({ error: 'from query param required (YYYY-MM-DD)' });
    }
    const startDate = new Date(from + 'T00:00:00Z');
    const weeks = 8; // next ~8 weeks
    const suggestions = [];
    const db = getPool();
    // Helper to count events per day
    const dayCounts = {};
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + weeks * 7);
    const rows = await db.query(
      `SELECT date, COUNT(*) AS cnt FROM rota_events WHERE date >= $1 AND date <= $2 GROUP BY date`,
      [from, endDate.toISOString().split('T')[0]]
    );
    // pg returns date columns as Date objects — normalise to the same YYYY-MM-DD
    // string used for lookups below, or every key misses and existing_events is 0.
    rows.rows.forEach(r => { dayCounts[new Date(r.date).toISOString().split('T')[0]] = parseInt(r.cnt); });
    // Generate candidate dates per room
    const roomsRes = await db.query('SELECT id, name FROM rooms ORDER BY id');
    const rooms = roomsRes.rows;
    for (let i = 0; i < weeks; i++) {
      const weekStart = new Date(startDate);
      weekStart.setDate(startDate.getDate() + i * 7);
      const babyDate = new Date(weekStart);
      babyDate.setDate(weekStart.getDate() + 2); // Wednesday (0=Sun)
      const preDate = new Date(weekStart);
      preDate.setDate(weekStart.getDate() + 3); // Thursday
      const candidates = [
        { room: 'baby', date: babyDate },
        { room: 'preschool', date: preDate }
      ];
      for (const cand of candidates) {
        const roomObj = rooms.find(r => r.name.toLowerCase().includes(cand.room));
        if (!roomObj) continue;
        const dStr = cand.date.toISOString().split('T')[0];
        const existing = dayCounts[dStr] || 0;
        const tobyAttends = (i % 2 === 0); // every other week Toby attends
        suggestions.push({ date: dStr, room: roomObj.name, kind: 'staff_meeting', toby_attends: tobyAttends, existing_events: existing });
      }
    }
    // Sort by fewest existing events, then earliest date
    suggestions.sort((a, b) => a.existing_events - b.existing_events || a.date.localeCompare(b.date));
    res.json(suggestions.slice(0, 10)); // return top 10 suggestions
  } catch (err) {
    console.error('rota /events/suggest-meetings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══ b533 (2026-10-28) — historical rotas, Jan 2022 to 20 Apr 2026 ═══════════
// Read-only reconstruction from ladn.rota_history_days (built by
// scripts/rota-history-build.js from EyLog sign-ins + BrightHR leave — see that
// script's header for the full precedence). This NEVER writes rota_weeks /
// rota_shifts and these routes never write anything at all.
const HISTORY_CUTOFF = '2026-04-21'; // the first date Wren's own rota covers

const HISTORY_STATUS_LABEL = {
  present: 'Present', present_pattern: 'Present (reconstructed)', annual_leave: 'Annual leave',
  sick: 'Sick', toil: 'TOIL', bank_holiday: 'Bank holiday', unpaid: 'Unpaid leave',
  training: 'Training', mandatory_leave: 'Mandatory leave', medical: 'Medical appointment',
  other_leave: 'Other leave', closed: 'Nursery closed', off: 'Not scheduled',
};
const HISTORY_STATUS_SHORT = {
  present: 'IN', present_pattern: 'IN*', annual_leave: 'AL', sick: 'SICK', toil: 'TOIL',
  bank_holiday: 'BANK HOL', unpaid: 'UNPAID', training: 'TRAINING', mandatory_leave: 'MANDATORY',
  medical: 'MEDICAL', other_leave: 'OTHER', closed: 'CLOSED', off: '—',
};
const HISTORY_LEAVE_STATUSES = ['annual_leave', 'sick', 'toil', 'bank_holiday', 'unpaid',
  'training', 'mandatory_leave', 'medical', 'other_leave'];

async function loadHistoryWeek(db, weekStart) {
  const ws = toWeekStart(weekStart);
  const dates = [0, 1, 2, 3, 4].map(i => addDaysStr(ws, i)); // Mon..Fri
  const { rows } = await db.query(
    `SELECT person_key, display_name, staff_id, date, status, in_time, out_time, hours, confidence, sources
       FROM rota_history_days WHERE date BETWEEN $1 AND $2 ORDER BY display_name, date`,
    [dates[0], dates[4]]
  );
  const byPerson = new Map();
  for (const r of rows) {
    const d = r.date.toISOString ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10);
    if (!byPerson.has(r.person_key)) byPerson.set(r.person_key, {
      person_key: r.person_key, display_name: r.display_name, staff_id: r.staff_id, days: {},
    });
    byPerson.get(r.person_key).days[d] = {
      status: r.status, in_time: r.in_time, out_time: r.out_time, hours: r.hours != null ? Number(r.hours) : null,
      confidence: r.confidence, sources: r.sources,
    };
  }
  const people = [...byPerson.values()].sort((a, b) => a.display_name.localeCompare(b.display_name));
  return { week_start: ws, dates, people };
}

// GET /api/rota/history?week=YYYY-MM-DD — reconstructed week (read-only, before the live rota starts)
router.get('/history', managerOnly, async (req, res) => {
  try {
    const data = await loadHistoryWeek(getPool(), req.query.week || HISTORY_CUTOFF);
    res.json({ ...data, cutoff: HISTORY_CUTOFF, status_labels: HISTORY_STATUS_LABEL });
  } catch (err) {
    console.error('rota /history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rota/history/pdf?week=YYYY-MM-DD — printable week, same visual style as hours.pdf
router.get('/history/pdf', managerOnly, async (req, res) => {
  try {
    const data = await loadHistoryWeek(getPool(), req.query.week || HISTORY_CUTOFF);
    const doc = new PDFDoc({ size: 'A4', layout: 'landscape', margins: { top: 40, bottom: 40, left: 40, right: 40 } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

    doc.fontSize(17).fillColor('#0f172a').text('Your Nursery — Rota (reconstructed)');
    doc.moveDown(0.15).fontSize(10).fillColor('#475569')
      .text(`Week commencing ${data.week_start}   (generated ${new Date().toISOString().slice(0, 10)})`);
    doc.moveDown(0.6);

    const x0 = 40, wName = 180, wDay = 95, widths = [wName, wDay, wDay, wDay, wDay, wDay];
    const header = ['Staff', ...data.dates.map(dayLabel)];
    let y = doc.y;
    const drawRow = (cells, opts = {}) => {
      let x = x0;
      doc.fontSize(opts.head ? 8.5 : 8.5).fillColor(opts.head ? '#334155' : '#1e293b');
      doc.font(opts.head ? 'Helvetica-Bold' : 'Helvetica');
      cells.forEach((c, i) => {
        doc.text(String(c == null ? '' : c), x + 3, y + 3, { width: widths[i] - 6, align: i === 0 ? 'left' : 'center' });
        x += widths[i];
      });
      y += 20;
      doc.moveTo(x0, y).lineTo(x0 + widths.reduce((a, b) => a + b, 0), y).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
    };
    drawRow(header, { head: true });
    for (const p of data.people) {
      if (y > 500) { doc.addPage({ layout: 'landscape', margins: { top: 40, bottom: 40, left: 40, right: 40 } }); y = 40; drawRow(header, { head: true }); }
      const cells = data.dates.map(d => {
        const day = p.days[d];
        if (!day) return '—';
        if (day.status === 'present' || day.status === 'present_pattern') {
          const star = day.status === 'present_pattern' ? '*' : '';
          return day.in_time ? `${String(day.in_time).slice(0, 5)}–${String(day.out_time || '').slice(0, 5)}${star}` : `IN${star}`;
        }
        return HISTORY_STATUS_SHORT[day.status] || day.status;
      });
      drawRow([p.display_name, ...cells]);
    }
    doc.font('Helvetica').fontSize(8).fillColor('#94a3b8')
      .text('Reconstructed from EyLog sign-ins + BrightHR leave — not Wren\'s live rota. * = inferred from the usual working pattern, not a sign-in record. Times are gross sign-in to sign-out.', x0, y + 10, { width: widths.reduce((a, b) => a + b, 0) });

    doc.end();
    const buf = await done;
    res.set({ 'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="rota-history-${data.week_start}.pdf"`, 'Content-Length': buf.length });
    res.send(buf);
  } catch (e) { console.error('rota history/pdf:', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// GET /api/rota/history/person-pdf?person=<person_key>&year=YYYY — one person's yearly summary
router.get('/history/person-pdf', managerOnly, async (req, res) => {
  try {
    const personKey = String(req.query.person || '');
    const year = parseInt(req.query.year, 10);
    if (!personKey || !year) return res.status(400).json({ error: 'person and year are required' });
    const db = getPool();
    const { rows } = await db.query(
      `SELECT date, status, hours, display_name FROM rota_history_days
        WHERE person_key = $1 AND date BETWEEN $2 AND $3 ORDER BY date`,
      [personKey, `${year}-01-01`, `${year}-12-31`]
    );
    if (!rows.length) return res.status(404).json({ error: 'No reconstructed history for that person/year' });

    const displayName = rows[0].display_name;
    const leaveCounts = {}; HISTORY_LEAVE_STATUSES.forEach(s => (leaveCounts[s] = 0));
    let presentDays = 0, closedDays = 0, offDays = 0, totalHours = 0;
    let sickEpisodes = 0, prevSick = false;
    for (const r of rows) {
      const d = r.date.toISOString ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10);
      if (r.status === 'present' || r.status === 'present_pattern') { presentDays++; totalHours += Number(r.hours) || 0; }
      else if (r.status === 'closed') closedDays++;
      else if (r.status === 'off') offDays++;
      else if (HISTORY_LEAVE_STATUSES.includes(r.status)) leaveCounts[r.status]++;
      const isSick = r.status === 'sick';
      if (isSick && !prevSick) sickEpisodes++;
      prevSick = isSick;
      void d;
    }

    const doc = new PDFDoc({ size: 'A4', margins: { top: 50, bottom: 50, left: 50, right: 50 } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

    doc.fontSize(17).fillColor('#0f172a').text('Your Nursery');
    doc.fontSize(13).fillColor('#334155').text(`${year} rota summary — reconstructed`);
    doc.moveDown(0.3).fontSize(10).fillColor('#64748b').text(`Generated ${new Date().toISOString().slice(0, 10)}`);
    doc.moveDown(1);
    doc.fontSize(12).fillColor('#0f172a').text(displayName, { underline: false });
    doc.moveDown(0.8);

    const rowsOut = [
      ['Days present (incl. reconstructed)', String(presentDays)],
      ['Total hours (gross sign-in to sign-out)', (Math.round(totalHours * 100) / 100).toFixed(2)],
      ['Sick episodes', String(sickEpisodes)],
      ['Nursery closed days', String(closedDays)],
      ['Not scheduled (pattern)', String(offDays)],
      ...HISTORY_LEAVE_STATUSES.map(s => [HISTORY_STATUS_LABEL[s], String(leaveCounts[s])]),
    ];
    let y = doc.y;
    for (const [label, val] of rowsOut) {
      doc.font('Helvetica').fontSize(10).fillColor('#334155').text(label, 50, y, { width: 320 });
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a').text(val, 380, y, { width: 150, align: 'right' });
      y += 20;
    }
    doc.font('Helvetica').fontSize(8).fillColor('#94a3b8')
      .text('Reconstructed from EyLog sign-ins + BrightHR leave (plus the usual working pattern where neither says otherwise) — not a payroll record.', 50, y + 20, { width: 480 });

    doc.end();
    const buf = await done;
    res.set({ 'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="rota-history-person-${personKey}-${year}.pdf"`, 'Content-Length': buf.length });
    res.send(buf);
  } catch (e) { console.error('rota history/person-pdf:', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

module.exports = router;
