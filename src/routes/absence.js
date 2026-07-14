const express = require('express');
const router = express.Router();
const https = require('https');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { calculateBradfordFactor } = require('../services/bradford-factor');
const { notify } = require('../services/notification-dispatcher');
const ratioEngine = require('../services/ratio-engine');

router.use(authenticate);

// ── AI AUTHORISATION LOGIC ─────────────────────────────────
async function aiAuthoriseHoliday(db, staffId, startDate, endDate, requestType) {
  // Rule 1: sick → never auto-approve
  if (requestType === 'sick') return { decision: 'manual_review', reason: 'Sick leave always requires manual review.' };

  // Rule 1b: DETERMINISTIC RATIO GATE (A3 engine). Authoritative pass/fail on
  // booked-children-by-age-band × qualified ratio staff (Toby/Hetty/Clare excluded),
  // +1 spare (Q6), and the 14-day block rule (Q9). On fail: block + nearest passing dates.
  try {
    const rg = await ratioEngine.checkRange(db, startDate, endDate, staffId);
    if (rg.blackout) {
      return { decision: 'manual_review', reason: rg.blackout_note, flags: ['blackout_over_14d'], ratio: rg };
    }
    if (!rg.pass) {
      const near = (rg.nearest_passing_dates || []);
      const suffix = near.length ? ` Nearest dates that pass ratios: ${near.join(', ')}.` : '';
      return {
        decision: 'decline_ratio',
        reason: `${rg.failing_days[0]?.reason || 'Staffing ratios cannot be maintained on the requested dates.'}${suffix}`,
        flags: ['ratio_fail'], ratio: rg
      };
    }
  } catch (e) {
    console.error('[absence] ratio-engine error (continuing to legacy checks):', e.message);
  }

  // Rule 2/3: Room clash
  const { rows: staff } = await db.query('SELECT id, room_id FROM staff WHERE id=$1', [staffId]);
  const roomId = staff[0]?.room_id;
  if (roomId) {
    const { rows: clashes } = await db.query(`
      SELECT ar.staff_id FROM absence_requests ar
      JOIN staff s ON s.id = ar.staff_id
      WHERE ar.status='approved' AND ar.staff_id != $1
        AND ar.start_date <= $3::date AND ar.end_date >= $2::date
        AND s.room_id = $4
    `, [staffId, startDate, endDate, roomId]);
    if (clashes.length > 0) {
      const { rows: rs } = await db.query(
        'SELECT COUNT(*) as total FROM staff WHERE room_id=$1 AND is_active=true', [roomId]
      );
      const total = parseInt(rs[0].total) || 1;
      if (clashes.length >= Math.floor(total / 2)) {
        return { decision: 'decline_clash', reason: `${clashes.length} other staff already approved off — minimum staffing ratios cannot be maintained.` };
      }
      return { decision: 'manual_review', reason: `${clashes.length} other staff member(s) from your room already have approved leave overlapping these dates. Manager review required.`, flags: ['potential_clash'] };
    }
  }

  // Rule 3: Bradford Factor (combined hr_absences + absence_requests, rolling 52 weeks)
  const bf = await calculateBradfordFactor(db, staffId);
  if (bf.score > 200) {
    return { decision: 'manual_review', reason: `Bradford Factor score is ${bf.score} — above the 200 threshold. Manager review required before any leave is approved.`, bradford: bf };
  }
  if (bf.score > 100) {
    // Flag but don't block — falls through to further checks
  }

  // Rule 4: Notice period
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const reqStart = new Date(startDate);
  const noticeDays = Math.floor((reqStart - today) / 86400000);
  if (noticeDays < 2) {
    return { decision: 'manual_review', reason: 'Less than 2 days notice — manager must review urgently.', flags: ['short_notice'] };
  }

  // Rule 5: Holiday entitlement
  if (requestType === 'holiday') {
    const reqDays = Math.max(1, Math.floor((new Date(endDate) - reqStart) / 86400000) + 1);
    // Try hr_holiday_entitlement first (BrightHR data), fall back to staff_entitlement
    const { rows: hrEnt } = await db.query(`
      SELECT entitlement_days, taken_days, awaiting_approval_days, remaining_days
      FROM hr_holiday_entitlement
      WHERE staff_id=$1
        AND year_start <= $2::date AND year_end >= $2::date
      ORDER BY year_start DESC LIMIT 1
    `, [staffId, startDate]);

    let remaining, awaiting;
    if (hrEnt.length) {
      remaining = parseFloat(hrEnt[0].remaining_days) || 0;
      awaiting  = parseFloat(hrEnt[0].awaiting_approval_days) || 0;
    } else {
      // Fall back: 28 days minus approved holiday in the same leave year (Jan–Dec),
      // counting across BOTH absence_requests and hr_absences (BrightHR historical)
      const reqYear = new Date(startDate).getFullYear();
      const yearStart = `${reqYear}-01-01`;
      const yearEnd   = `${reqYear}-12-31`;
      const { rows: used } = await db.query(`
        SELECT COALESCE(SUM(days),0) as used FROM (
          SELECT COALESCE(days_count,1) as days
          FROM absence_requests
          WHERE staff_id=$1 AND status='approved' AND request_type='holiday'
            AND start_date >= $2::date AND start_date <= $3::date
          UNION ALL
          SELECT COALESCE(duration_days,1) as days
          FROM hr_absences
          WHERE staff_id=$1 AND absence_type='Annual leave'
            AND start_date >= $2::date AND start_date <= $3::date
        ) t
      `, [staffId, yearStart, yearEnd]);
      const defaultEnt = 28;
      remaining = defaultEnt - parseFloat(used[0].used);
      awaiting = 0;
    }

    if (reqDays > remaining) {
      return { decision: 'decline_no_entitlement', reason: `Only ${remaining.toFixed(1)} days holiday remaining this year — not enough to cover this ${reqDays}-day request.` };
    }
    if (reqDays > remaining - awaiting) {
      return { decision: 'manual_review', reason: `This request may exceed available entitlement once pending requests are accounted for (${remaining.toFixed(1)} days remaining, ${awaiting} days awaiting approval).`, flags: ['entitlement_tight'] };
    }
  }

  // Rule 6: Same day-of-week pattern
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
  const { rows: history } = await db.query(`
    SELECT start_date, request_type FROM absence_requests
    WHERE staff_id=$1 AND status='approved' AND start_date >= $2::date
    ORDER BY start_date
  `, [staffId, twelveMonthsAgo.toISOString().split('T')[0]]);

  const reqDow = new Date(startDate).getDay();
  const sameDow = history.filter(h => new Date(h.start_date).getDay() === reqDow).length;
  if (sameDow >= 3) {
    return { decision: 'manual_review', reason: `Pattern detected: ${sameDow} previous absences start on this day of the week. Manager review required.`, flags: ['pattern_dow'] };
  }

  // Bradford 101-200: conditional approve (auto-approved but flagged)
  if (bf.score > 100) {
    return { decision: 'conditional_approve', reason: `Approved — Bradford Factor score of ${bf.score} is elevated. A welfare conversation is recommended.`, bradford: bf, flags: ['bradford_elevated'] };
  }

  // Short notice 2-13 days: flag but approve
  if (noticeDays < 14) {
    return { decision: 'conditional_approve', reason: `Approved with short notice (${noticeDays} day${noticeDays !== 1 ? 's' : ''}). Manager has been notified.`, flags: ['short_notice'] };
  }

  // All clear
  return { decision: 'auto_approve', reason: 'No conflicts detected. Leave approved automatically.', bradford: bf };
}

// ── Telegram helper ────────────────────────────────────────
function telegramNotify(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat  = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  const body = JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

// GET /my — own requests
router.get('/my', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT ar.*, s2.first_name || ' ' || s2.last_name as approved_by_name
      FROM absence_requests ar
      LEFT JOIN staff s2 ON s2.id = ar.approved_by
      WHERE ar.staff_id=$1
      ORDER BY ar.start_date DESC LIMIT 50
    `, [req.user.id]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /all — manager view: UNION absence_requests (wren-submitted) + hr_absences (BrightHR historical)
router.get('/all', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT ar.id, ar.staff_id, ar.start_date, ar.end_date,
        ar.request_type as absence_type, ar.request_type,
        ar.status, ar.notes, ar.created_at, ar.days_count,
        ar.auto_approved, ar.ai_decision_reason, ar.rejected_reason,
        ar.half_day, ar.room_impact_baby, ar.room_impact_preschool,
        COALESCE(ar.created_via, 'wren') as created_via,
        s.first_name || ' ' || s.last_name as staff_name,
        s.first_name, s.last_name, s.room_id,
        r.name as room_name,
        'absence_request' as record_source
      FROM absence_requests ar
      JOIN staff s ON s.id = ar.staff_id
      LEFT JOIN rooms r ON r.id = s.room_id
      UNION ALL
      SELECT ha.id + 100000 as id, ha.staff_id,
        ha.start_date, ha.end_date,
        ha.absence_type, ha.absence_type as request_type,
        'approved' as status, ha.reason as notes, ha.created_at,
        ha.duration_days as days_count,
        true as auto_approved, null as ai_decision_reason, null as rejected_reason,
        null as half_day, false as room_impact_baby, false as room_impact_preschool,
        'brighthr' as created_via,
        s.first_name || ' ' || s.last_name as staff_name,
        s.first_name, s.last_name, s.room_id,
        r.name as room_name,
        'hr_absences' as record_source
      FROM hr_absences ha
      JOIN staff s ON s.id = ha.staff_id
      LEFT JOIN rooms r ON r.id = s.room_id
      -- De-dupe: absence_requests (Wren-submitted / nightly BrightHR API sync) are
      -- authoritative for their (staff_id,start_date); suppress the overlapping
      -- hr_absences (BrightHR CSV historical) row so it isn't listed twice.
      -- Mirrors the same precedence used in services/bradford-factor.js.
      WHERE NOT EXISTS (
        SELECT 1 FROM absence_requests ar2
        WHERE ar2.staff_id = ha.staff_id AND ar2.start_date = ha.start_date
      )
      ORDER BY created_at DESC LIMIT 2000
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /pending — pending requests only
router.get('/pending', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT ar.*, s.first_name || ' ' || s.last_name as staff_name, s.room_id
      FROM absence_requests ar
      JOIN staff s ON s.id = ar.staff_id
      WHERE ar.status='pending'
      ORDER BY ar.created_at ASC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /entitlement/my — own entitlement (hr_holiday_entitlement preferred)
router.get('/entitlement/my', async (req, res) => {
  try {
    const db = getPool();
    const today = new Date().toISOString().split('T')[0];
    const { rows: hrEnt } = await db.query(`
      SELECT entitlement_days, taken_days, awaiting_approval_days, remaining_days,
             upcoming_days, carried_over_days, year_start, year_end
      FROM hr_holiday_entitlement
      WHERE staff_id=$1 AND year_start <= $2::date AND year_end >= $2::date
      ORDER BY year_start DESC LIMIT 1
    `, [req.user.id, today]);
    if (hrEnt.length) return res.json({ source: 'hr_holiday_entitlement', ...hrEnt[0] });

    // Fallback: staff_entitlement table
    const { rows: se } = await db.query('SELECT * FROM staff_entitlement WHERE staff_id=$1', [req.user.id]);
    if (se.length) return res.json({ source: 'staff_entitlement', ...se[0] });

    // Final fallback: calculated from BOTH absence_requests and hr_absences (current leave year Jan–Dec)
    const yearStart = `${new Date().getFullYear()}-01-01`;
    const yearEnd   = `${new Date().getFullYear()}-12-31`;
    const { rows: used } = await db.query(`
      SELECT COALESCE(SUM(days),0) as taken FROM (
        SELECT COALESCE(days_count,1) as days
        FROM absence_requests
        WHERE staff_id=$1 AND status='approved' AND request_type='holiday'
          AND start_date >= $2::date AND start_date <= $3::date
        UNION ALL
        SELECT COALESCE(duration_days,1) as days
        FROM hr_absences
        WHERE staff_id=$1 AND absence_type='Annual leave'
          AND start_date >= $2::date AND start_date <= $3::date
      ) t
    `, [req.user.id, yearStart, yearEnd]);
    const taken = parseFloat(used[0].taken);
    const entitlement = 28;
    res.json({ source: 'calculated', entitlement_days: entitlement, taken_days: taken, remaining_days: entitlement - taken, awaiting_approval_days: 0, carried_over_days: 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /entitlement/:staffId
router.get('/entitlement/:staffId', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT * FROM staff_entitlement WHERE staff_id=$1', [req.params.staffId]
    );
    if (!rows.length) {
      // Return default entitlement
      const used = await db.query(`
        SELECT COALESCE(SUM(days_count),0) as used FROM absence_requests
        WHERE staff_id=$1 AND status='approved' AND request_type='holiday'
      `, [req.params.staffId]);
      return res.json({ staff_id: req.params.staffId, annual_leave_days: 28, carried_over_days: 0, used_days: parseFloat(used.rows[0].used), year: '2025-2026' });
    }
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /entitlement — all staff (manager)
router.get('/entitlement', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT s.id, s.first_name || ' ' || s.last_name as name, s.role,
        COALESCE(se.annual_leave_days, 28) as annual_leave_days,
        COALESCE(se.carried_over_days, 0) as carried_over_days,
        COALESCE((SELECT SUM(days_count) FROM absence_requests
          WHERE staff_id=s.id AND status='approved' AND request_type='holiday'),0) as used_days,
        COALESCE(se.year, '2025-2026') as year
      FROM staff s
      LEFT JOIN staff_entitlement se ON se.staff_id = s.id
      WHERE s.is_active=true
      ORDER BY s.last_name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /calendar — month view
router.get('/calendar', async (req, res) => {
  const { month, year } = req.query;
  const m = parseInt(month) || new Date().getMonth() + 1;
  const y = parseInt(year) || new Date().getFullYear();
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT ar.id, ar.staff_id, ar.start_date, ar.end_date, ar.request_type,
        ar.status, ar.days_count, ar.auto_approved,
        s.first_name || ' ' || s.last_name as staff_name, s.room_id,
        r.name as room_name
      FROM absence_requests ar
      JOIN staff s ON s.id = ar.staff_id
      LEFT JOIN rooms r ON r.id = s.room_id
      WHERE ar.status IN ('approved','pending')
        AND (EXTRACT(YEAR FROM ar.start_date)=$1 OR EXTRACT(YEAR FROM ar.end_date)=$1)
        AND (EXTRACT(MONTH FROM ar.start_date)=$2 OR EXTRACT(MONTH FROM ar.end_date)=$2)
      ORDER BY ar.start_date
    `, [y, m]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /request — submit new absence
router.post('/request', async (req, res) => {
  const { start_date, end_date, request_type, half_day, notes } = req.body;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });

  // Booking window: today → 31 Dec of current year
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const reqStart = new Date(start_date); reqStart.setHours(0, 0, 0, 0);
  const reqEnd   = new Date(end_date);   reqEnd.setHours(0, 0, 0, 0);
  const windowEnd = new Date(today.getFullYear(), 11, 31);
  if (reqEnd < reqStart) return res.status(400).json({ error: 'End date must be on or after start date.', code: 'date_order' });
  if (reqStart < today)  return res.status(400).json({ error: 'Cannot book absences in the past.', code: 'booking_window' });
  if (reqStart > windowEnd) {
    return res.status(400).json({
      error: `Booking window: you can request absence up to 31 Dec ${today.getFullYear()}. Dates in ${reqStart.getFullYear()} will open for booking on 1 Jan ${reqStart.getFullYear()}.`,
      code: 'booking_window'
    });
  }

  // Calculate working days
  const s = new Date(start_date), e = new Date(end_date);
  let days = 0;
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== 0 && d.getDay() !== 6) days++;
  }
  if (half_day) days = days - 0.5;

  try {
    const db = getPool();
    const ai = await aiAuthoriseHoliday(db, req.user.id, start_date, end_date, request_type || 'holiday');

    // Auto-approval kill-switch (Toby, 2026-07-13): until settings.absence_auto_approve='true',
    // approve-decisions land as PENDING for manager review. Auto-declines (ratio/clash) still block.
    let effectiveDecision = ai.decision;
    let autoApproveOn = false;
    try {
      const { rows: aa } = await db.query("SELECT value FROM settings WHERE key='absence_auto_approve'");
      autoApproveOn = aa.length > 0 && aa[0].value === 'true';
    } catch (_) { /* settings unavailable — fail safe: no auto-approval */ }
    if (!autoApproveOn && (ai.decision === 'auto_approve' || ai.decision === 'conditional_approve')) {
      effectiveDecision = 'manual_review';
      ai.reason = `[Auto-approve is off — queued for manager review] ${ai.reason}`;
    }

    const decisionToStatus = {
      auto_approve: 'approved',
      conditional_approve: 'approved',
      manual_review: 'pending',
      decline_ratio: 'declined',          // ratio breach — block at request time (A3 gatekeeper)
      decline_clash: 'declined',
      decline_no_entitlement: 'declined',
    };
    const status       = decisionToStatus[effectiveDecision] || 'pending';
    const autoApproved = status === 'approved';

    const { rows } = await db.query(`
      INSERT INTO absence_requests (staff_id, start_date, end_date, request_type,
        absence_type, half_day, days_count, notes, status, auto_approved, ai_decision_reason, created_via)
      VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,'wren')
      RETURNING *
    `, [req.user.id, start_date, end_date, request_type || 'holiday',
        half_day, days, notes, status, autoApproved, ai.reason]);

    // Per-absence running summary → manager (Telegram). Deterministic; fires on
    // EVERY request so the manager has a live picture of the leave queue + any
    // statutory-ratio impact. Replaces the old manual_review-only alert.
    try {
      const { rows: st } = await db.query('SELECT first_name, last_name FROM staff WHERE id=$1', [req.user.id]);
      const name = st[0] ? `${st[0].first_name} ${st[0].last_name}` : `Staff #${req.user.id}`;
      const { rows: pend } = await db.query("SELECT COUNT(*)::int AS c FROM absence_requests WHERE status='pending'");
      const pendingCount = pend[0] ? pend[0].c : 0;
      const icon = status === 'approved' ? '✅' : status === 'declined' ? '⛔' : '📋';
      const decisionLabel = {
        auto_approve: 'auto-approved',
        conditional_approve: 'approved (flagged)',
        manual_review: 'needs manager review',
        decline_ratio: 'BLOCKED — staffing ratio breach',
        decline_clash: 'declined — room staffing clash',
        decline_no_entitlement: 'declined — no entitlement left',
      }[ai.decision] || status;
      let ratioLine = '';
      const fd = ai.ratio && ai.ratio.failing_days;
      if (Array.isArray(fd) && fd.length) {
        ratioLine = `\n⚠️ Ratio fails on ${fd.length} day(s) — first: <i>${fd[0].reason}</i>`;
      }
      const range = `${start_date}${end_date !== start_date ? ' → ' + end_date : ''}`;
      telegramNotify(
        `${icon} <b>Absence ${decisionLabel}</b>\n${name} — ${request_type || 'holiday'} · ${range} (${days}d)` +
        `${ratioLine}\n<i>${ai.reason}</i>\n📊 ${pendingCount} request(s) now awaiting manager action.`
      );
    } catch (e) { console.error('[absence] summary telegram error:', e.message); }

    // Notification system: fire staff_sick to all-managers when type is sick
    if ((request_type || 'holiday') === 'sick') {
      const { rows: st } = await db.query('SELECT first_name, last_name FROM staff WHERE id=$1', [req.user.id]);
      const name = st[0] ? `${st[0].first_name} ${st[0].last_name}` : `Staff #${req.user.id}`;
      notify('staff_sick', 'all-managers', null,
        `${name} called in sick`,
        `Absence request: ${start_date}${end_date !== start_date ? ' → ' + end_date : ''}.${ai.reason ? ' ' + ai.reason : ''}`,
        { priority: 'high', relatedTable: 'absence_requests', relatedId: rows[0].id }
      );
    }

    // Internal notification for auto-declined requests
    if (status === 'declined') {
      await db.query(`
        INSERT INTO notifications (recipient_type, recipient_id, category, title, body, link, related_table, related_id, priority)
        VALUES ('staff', $1, 'absence', 'Leave request declined', $2, '/hr.html#absences', 'absence_requests', $3, 'high')
      `, [req.user.id, ai.reason, rows[0].id]).catch(() => {});
    }

    res.status(201).json({ ...rows[0], ai_decision: ai.decision, ai_reason: ai.reason, ai_flags: ai.flags || [], bradford: ai.bradford });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST / — alias for /request
router.post('/', async (req, res) => {
  const { start_date, end_date, absence_type, request_type, duration_days, duration_hours, notes } = req.body;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO absence_requests (staff_id, start_date, end_date, absence_type,
        request_type, days_count, duration_days, duration_hours, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8)
      RETURNING *
    `, [req.user.id, start_date, end_date, absence_type || request_type || 'holiday',
        request_type || absence_type || 'holiday', duration_days, duration_hours, notes]);
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/ai-check — run AI check before approving
router.post('/:id/ai-check', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM absence_requests WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const req_ = rows[0];
    const result = await aiAuthoriseHoliday(db, req_.staff_id, req_.start_date, req_.end_date, req_.request_type || req_.absence_type);
    // Store the AI decision reason
    await db.query('UPDATE absence_requests SET ai_decision_reason=$1 WHERE id=$2', [result.reason, req.params.id]);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id/approve
router.put('/:id/approve', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE absence_requests SET status='approved', approved_by=$1, auto_approved=$2
      WHERE id=$3 RETURNING *
    `, [req.user.id, req.body.auto_approved || false, req.params.id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id/decline
router.put('/:id/decline', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE absence_requests SET status='declined', approved_by=$1, rejected_reason=$2
      WHERE id=$3 RETURNING *
    `, [req.user.id, req.body.reason || null, req.params.id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /pending-review — requests needing manager action (manual_review + conditional_approve statuses)
router.get('/pending-review', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT ar.*, s.first_name, s.last_name, s.room_id,
        r.name as room_name,
        (SELECT COUNT(*) FROM absence_requests ar2
         WHERE ar2.staff_id=ar.staff_id AND ar2.status='approved'
           AND ar2.start_date >= NOW() - INTERVAL '1 year') AS absences_ytd
      FROM absence_requests ar
      JOIN staff s ON s.id = ar.staff_id
      LEFT JOIN rooms r ON r.id = s.room_id
      WHERE ar.status IN ('pending')
         OR (ar.status='approved' AND ar.auto_approved=true AND ar.ai_decision_reason ILIKE '%elevated%')
      ORDER BY ar.created_at ASC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /bradford-watchlist — all active staff sorted by Bradford score
router.get('/bradford-watchlist', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows: staffList } = await db.query(`SELECT id, first_name, last_name, room_id FROM staff WHERE is_active=true ORDER BY last_name`);
    const results = await Promise.all(staffList.map(async s => {
      const bf = await calculateBradfordFactor(db, s.id);
      return { ...s, ...bf };
    }));
    results.sort((a, b) => b.score - a.score);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /bradford/:staffId — Bradford factor (combined hr_absences + absence_requests)
router.get('/bradford/:staffId', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role) && req.user.id !== parseInt(req.params.staffId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const bf = await calculateBradfordFactor(db, parseInt(req.params.staffId));
    res.json({ staff_id: parseInt(req.params.staffId), ...bf,
      rag: bf.score > 200 ? 'red' : bf.score > 100 ? 'amber' : bf.score > 50 ? 'yellow' : 'green' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /preview  { request_type, start_date, end_date }
// Transparency preview for the leave-request form (Toby, 2026-07-14): runs the SAME
// gates as aiAuthoriseHoliday but without early exit, and returns every check with
// its weighting so staff can see exactly how their request will be assessed BEFORE
// submitting. Self-only: always previews for req.user.id. Read-only — writes nothing.
router.post('/preview', async (req, res) => {
  const db = getPool();
  const staffId = req.user.id;
  const { request_type = 'holiday', start_date, end_date } = req.body || {};
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });
  const checks = [];
  let percent = 95;        // auto-approval baseline
  let hardBlock = false;   // any fail → declined at request time
  let review = false;      // any review trigger → goes to manager
  const cap = v => { percent = Math.min(percent, v); };

  try {
    // Sick leave never auto-approves
    if (request_type === 'sick') {
      review = true; cap(50);
      checks.push({ key: 'sick', label: 'Request type', status: 'review', points: 'to manager',
        detail: 'Sick leave always goes to your manager — it is never decided automatically.' });
    }

    // Gate 1: statutory staffing ratios (deterministic, authoritative)
    try {
      const rg = await ratioEngine.checkRange(db, start_date, end_date, staffId);
      if (rg.blackout) {
        review = true; cap(40);
        checks.push({ key: 'ratio', label: 'Staffing ratios', status: 'review', points: 'to manager', detail: rg.blackout_note });
      } else if (!rg.pass) {
        hardBlock = true;
        const near = (rg.nearest_passing_dates || []);
        checks.push({ key: 'ratio', label: 'Staffing ratios', status: 'fail', points: 'blocks request',
          detail: `${rg.failing_days?.[0]?.reason || 'Ratios cannot be maintained on these dates.'}${near.length ? ` Nearest dates that pass: ${near.join(', ')}.` : ''}` });
      } else {
        checks.push({ key: 'ratio', label: 'Staffing ratios', status: 'pass', points: '—',
          detail: 'Legal child:staff ratios hold on every requested day with you away.' });
      }
    } catch (e) {
      checks.push({ key: 'ratio', label: 'Staffing ratios', status: 'review', points: '—', detail: 'Ratio check unavailable — a manager will confirm.' });
    }

    // Gate 2: room clash
    const { rows: staff } = await db.query('SELECT room_id FROM staff WHERE id=$1', [staffId]);
    const roomId = staff[0]?.room_id;
    if (roomId) {
      const { rows: clashes } = await db.query(`
        SELECT ar.staff_id FROM absence_requests ar
        JOIN staff s ON s.id = ar.staff_id
        WHERE ar.status='approved' AND ar.staff_id != $1
          AND ar.start_date <= $3::date AND ar.end_date >= $2::date
          AND s.room_id = $4
      `, [staffId, start_date, end_date, roomId]);
      if (clashes.length > 0) {
        const { rows: rs } = await db.query('SELECT COUNT(*) as total FROM staff WHERE room_id=$1 AND is_active=true', [roomId]);
        const total = parseInt(rs[0].total) || 1;
        if (clashes.length >= Math.floor(total / 2)) {
          hardBlock = true;
          checks.push({ key: 'clash', label: 'Room cover', status: 'fail', points: 'blocks request',
            detail: `${clashes.length} of your room already approved off over these dates — minimum staffing cannot be maintained.` });
        } else {
          review = true; percent -= 30;
          checks.push({ key: 'clash', label: 'Room cover', status: 'flag', points: '−30%',
            detail: `${clashes.length} other staff in your room already have approved leave overlapping these dates — manager decides.` });
        }
      } else {
        checks.push({ key: 'clash', label: 'Room cover', status: 'pass', points: '—', detail: 'No overlapping approved leave in your room.' });
      }
    }

    // Gate 3: Bradford Factor (your own score, rolling 52 weeks: spells² × days)
    try {
      const bf = await calculateBradfordFactor(db, staffId);
      const formula = `${bf.instances ?? 0} spells² × ${bf.days_total ?? 0} days = ${bf.score}`;
      if (bf.score > 200) {
        review = true; cap(40);
        checks.push({ key: 'bradford', label: 'Bradford Factor', status: 'review', points: 'to manager',
          detail: `Your score is ${bf.score} (${formula}) — above the 200 threshold, so a manager reviews any leave.` });
      } else if (bf.score > 100) {
        percent -= 10;
        checks.push({ key: 'bradford', label: 'Bradford Factor', status: 'flag', points: '−10%',
          detail: `Your score is ${bf.score} (${formula}) — elevated (over 100). Approvable, but flagged for a welfare chat.` });
      } else {
        checks.push({ key: 'bradford', label: 'Bradford Factor', status: 'pass', points: '—',
          detail: `Your score is ${bf.score} (${formula}) — under the 100 threshold.` });
      }
    } catch (e) {
      checks.push({ key: 'bradford', label: 'Bradford Factor', status: 'review', points: '—', detail: 'Score unavailable.' });
    }

    // Gate 4: notice period
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const noticeDays = Math.floor((new Date(start_date) - today) / 86400000);
    if (noticeDays < 2) {
      review = true; cap(40);
      checks.push({ key: 'notice', label: 'Notice given', status: 'review', points: 'to manager',
        detail: `${noticeDays} day${noticeDays === 1 ? '' : 's'} notice — under 2 days always goes to a manager urgently.` });
    } else if (noticeDays < 14) {
      percent -= 10;
      checks.push({ key: 'notice', label: 'Notice given', status: 'flag', points: '−10%',
        detail: `${noticeDays} days notice — approvable, but under the 14 days we ask for, so your manager is notified.` });
    } else {
      checks.push({ key: 'notice', label: 'Notice given', status: 'pass', points: '—', detail: `${noticeDays} days notice.` });
    }

    // Gate 5: entitlement (holiday only)
    if (request_type === 'holiday') {
      const reqDays = Math.max(1, Math.floor((new Date(end_date) - new Date(start_date)) / 86400000) + 1);
      const { rows: hrEnt } = await db.query(`
        SELECT remaining_days, awaiting_approval_days FROM hr_holiday_entitlement
        WHERE staff_id=$1 AND year_start <= $2::date AND year_end >= $2::date
        ORDER BY year_start DESC LIMIT 1
      `, [staffId, start_date]);
      let remaining, awaiting;
      if (hrEnt.length) {
        remaining = parseFloat(hrEnt[0].remaining_days) || 0;
        awaiting  = parseFloat(hrEnt[0].awaiting_approval_days) || 0;
      } else {
        const reqYear = new Date(start_date).getFullYear();
        const { rows: used } = await db.query(`
          SELECT COALESCE(SUM(days),0) as used FROM (
            SELECT COALESCE(days_count,1) as days FROM absence_requests
            WHERE staff_id=$1 AND status='approved' AND request_type='holiday'
              AND start_date >= $2::date AND start_date <= $3::date
            UNION ALL
            SELECT COALESCE(duration_days,1) as days FROM hr_absences
            WHERE staff_id=$1 AND absence_type='Annual leave'
              AND start_date >= $2::date AND start_date <= $3::date
          ) t
        `, [staffId, `${reqYear}-01-01`, `${reqYear}-12-31`]);
        remaining = 28 - parseFloat(used[0].used);
        awaiting = 0;
      }
      if (reqDays > remaining) {
        hardBlock = true;
        checks.push({ key: 'entitlement', label: 'Holiday entitlement', status: 'fail', points: 'blocks request',
          detail: `This is a ${reqDays}-day request but you have ${remaining.toFixed(1)} days remaining this year.` });
      } else if (reqDays > remaining - awaiting) {
        review = true; percent -= 20;
        checks.push({ key: 'entitlement', label: 'Holiday entitlement', status: 'flag', points: '−20%',
          detail: `${remaining.toFixed(1)} days remaining but ${awaiting} awaiting approval — this could take you over, so a manager checks.` });
      } else {
        checks.push({ key: 'entitlement', label: 'Holiday entitlement', status: 'pass', points: '—',
          detail: `${reqDays}-day request, ${remaining.toFixed(1)} days remaining.` });
      }
    }

    // Gate 6: same day-of-week pattern (last 12 months)
    const twelveMonthsAgo = new Date(); twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
    const { rows: history } = await db.query(`
      SELECT start_date FROM absence_requests
      WHERE staff_id=$1 AND status='approved' AND start_date >= $2::date
    `, [staffId, twelveMonthsAgo.toISOString().split('T')[0]]);
    const reqDow = new Date(start_date).getDay();
    const sameDow = history.filter(h => new Date(h.start_date).getDay() === reqDow).length;
    if (sameDow >= 3) {
      review = true; cap(40);
      checks.push({ key: 'pattern', label: 'Absence pattern', status: 'review', points: 'to manager',
        detail: `${sameDow} of your previous absences started on this day of the week, so a manager reviews this one.` });
    } else {
      checks.push({ key: 'pattern', label: 'Absence pattern', status: 'pass', points: '—', detail: 'No repeating day-of-week pattern.' });
    }

    // Overall
    if (hardBlock) percent = 5;
    percent = Math.max(5, Math.min(95, Math.round(percent)));
    const { rows: aa } = await db.query("SELECT value FROM settings WHERE key='absence_auto_approve'");
    const autoApproveOn = aa.length && aa[0].value === 'true';
    const band = hardBlock ? 'blocked' : percent >= 80 ? 'high' : percent >= 55 ? 'medium' : 'low';
    const headline = hardBlock
      ? 'This request would be declined as things stand — see the failing check below.'
      : review
        ? `Around ${percent}% — this will go to your manager to decide, with the flags below attached.`
        : autoApproveOn
          ? `Around ${percent}% — on today's numbers this would be approved automatically.`
          : `Around ${percent}% — every check passes; your manager gets it marked "recommend approve".`;
    res.json({ percent, band, headline, checks, auto_approve_enabled: autoApproveOn,
      note: 'Estimate based on today\'s bookings, rotas and approved leave — it can change if those change before you submit. Your manager sees the same checks, and a person always makes the final call on anything not approved automatically.' });
  } catch (e) {
    console.error('[absence/preview]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /ratio-check?staff_id=&start=YYYY-MM-DD&end=YYYY-MM-DD
// Deterministic preview for the leave-request form: per-day pass/fail + nearest dates.
router.get('/ratio-check', async (req, res) => {
  const { start, end } = req.query;
  const staffId = req.query.staff_id ? parseInt(req.query.staff_id, 10) : (req.user && req.user.id);
  if (!start) return res.status(400).json({ error: 'start (date) required' });
  try {
    const result = await ratioEngine.checkRange(getPool(), start, end || start, staffId);
    res.json(result);
  } catch (e) {
    console.error('[absence/ratio-check]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
