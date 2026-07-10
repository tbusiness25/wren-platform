const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');

router.use(authenticate);

const managerOrLeader = requireRole('manager','deputy_manager','room_leader','senior_practitioner');

// ── Helpers ────────────────────────────────────────────────────────────────

function periodDates(period) {
  const now = new Date();
  let start;
  if (period === '30') {
    start = new Date(now); start.setDate(now.getDate() - 30);
  } else if (period === 'term') {
    // Rough term calculation: Spring = Jan-Apr, Summer = Apr-Aug, Autumn = Sep-Dec
    const m = now.getMonth();
    if (m < 4) { start = new Date(now.getFullYear(), 0, 6); }       // Spring from Jan 6
    else if (m < 8) { start = new Date(now.getFullYear(), 3, 22); } // Summer from ~Apr 22
    else { start = new Date(now.getFullYear(), 8, 1); }              // Autumn from Sep 1
  } else {
    start = new Date(now); start.setDate(now.getDate() - 14);        // default 14 days
  }
  return { start: start.toISOString().split('T')[0], end: now.toISOString().split('T')[0] };
}

function periodLabel(period) {
  if (period === '30') return 'Last 30 days';
  if (period === 'term') return 'This term';
  return 'Last 14 days';
}

// ── GET /standards ─────────────────────────────────────────────────────────
router.get('/standards', managerOrLeader, async (req, res) => {
  try {
    const { rows } = await getPool().query('SELECT * FROM observation_standards ORDER BY key');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /standards/:key ────────────────────────────────────────────────────
router.put('/standards/:key', managerOrLeader, async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role)) return res.status(403).json({ error: 'Manager only' });
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'value required' });
  try {
    const { rows } = await getPool().query(
      `UPDATE observation_standards SET value=$1, updated_at=NOW() WHERE key=$2 RETURNING *`,
      [value, req.params.key]
    );
    if (!rows.length) return res.status(404).json({ error: 'Standard not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /staff/:staffId ────────────────────────────────────────────────────
router.get('/staff/:staffId', managerOrLeader, async (req, res) => {
  const db = getPool();
  const { period } = req.query;
  const { start, end } = periodDates(period);

  try {
    // Load standards
    const { rows: stds } = await db.query('SELECT key, value FROM observation_standards');
    const S = {};
    stds.forEach(r => { S[r.key] = parseFloat(r.value); });

    // Staff info
    const { rows: staffRows } = await db.query(
      `SELECT id, first_name||' '||last_name as name, role, room_id, contracted_hours
       FROM staff WHERE id=$1`, [req.params.staffId]
    );
    if (!staffRows.length) return res.status(404).json({ error: 'Staff not found' });
    const staff = staffRows[0];

    // Key children
    const { rows: keyChildren } = await db.query(`
      SELECT c.id, c.first_name||' '||c.last_name as name, c.date_of_birth,
        COUNT(o.id) as obs_count,
        MAX(o.created_at) as last_obs_date,
        ARRAY_AGG(DISTINCT unnested_area) FILTER (WHERE unnested_area IS NOT NULL) as eyfs_areas_covered,
        EXTRACT(DAY FROM NOW() - MAX(o.created_at)) as gap_days
      FROM children c
      LEFT JOIN observations o ON o.child_id=c.id
        AND o.created_at >= $2 AND o.created_at <= $3::date + interval '1 day'
        AND o.staff_id=$1
      LEFT JOIN LATERAL UNNEST(o.eyfs_areas) AS unnested_area ON TRUE
      WHERE c.key_person_id=$1 AND c.is_active=true
      GROUP BY c.id
      ORDER BY c.first_name
    `, [req.params.staffId, start, end]);

    // All observations by this staff in period
    const { rows: obs } = await db.query(`
      SELECT o.id, o.child_id, o.observation_text, o.eyfs_areas, o.created_at,
        c.first_name||' '||c.last_name as child_name
      FROM observations o
      JOIN children c ON c.id=o.child_id
      WHERE o.staff_id=$1 AND o.created_at >= $2 AND o.created_at <= $3::date + interval '1 day'
      ORDER BY o.created_at DESC
    `, [req.params.staffId, start, end]);

    const totalObs = obs.length;
    const activeKeyChildren = keyChildren.length;

    // Weeks in period
    const periodDays = Math.max(1, (new Date(end) - new Date(start)) / 86400000);
    const periodWeeks = periodDays / 7;

    const obsPerKeyChildPerWeek = activeKeyChildren > 0
      ? (totalObs / activeKeyChildren / periodWeeks).toFixed(2)
      : 0;

    // Next steps: obs where text contains "next step"
    const obsWithNextSteps = obs.filter(o => /next.?step/i.test(o.observation_text || ''));
    const pctObsWithNextSteps = totalObs > 0
      ? Math.round((obsWithNextSteps.length / totalObs) * 100) : 0;

    // Follow-up rate: for each "next step" obs, check if there's a subsequent obs on same child within window
    const followUpWindow = (S.follow_up_window_days || 21) * 86400000;
    let followedUp = 0;
    for (const nso of obsWithNextSteps) {
      const childObs = obs.filter(o => o.child_id === nso.child_id && new Date(o.created_at) > new Date(nso.created_at));
      if (childObs.some(o => (new Date(o.created_at) - new Date(nso.created_at)) <= followUpWindow)) {
        followedUp++;
      }
    }
    const pctNextStepsFollowedUp = obsWithNextSteps.length > 0
      ? Math.round((followedUp / obsWithNextSteps.length) * 100) : 0;

    // EYFS area coverage
    const eyfsCounts = { CL: 0, PSED: 0, PD: 0, L: 0, M: 0, UTW: 0, EAD: 0 };
    for (const o of obs) {
      (o.eyfs_areas || []).forEach(area => {
        const k = area.replace(/[^A-Z]/g, '');
        if (eyfsCounts[k] !== undefined) eyfsCounts[k]++;
        else if (area.includes('Communication') || area.includes('Language')) eyfsCounts.CL++;
        else if (area.includes('PSED') || area.includes('Personal')) eyfsCounts.PSED++;
        else if (area.includes('Physical') || area.includes('PD')) eyfsCounts.PD++;
        else if (area.includes('Literacy') || area === 'L') eyfsCounts.L++;
        else if (area.includes('Maths') || area === 'M') eyfsCounts.M++;
        else if (area.includes('Understanding') || area.includes('World')) eyfsCounts.UTW++;
        else if (area.includes('Expressive') || area.includes('Arts')) eyfsCounts.EAD++;
      });
    }
    const areasWithObs = Object.values(eyfsCounts).filter(v => v > 0).length;
    const coverageBalanceScore = (areasWithObs / 7).toFixed(2);

    const avgObsLengthChars = totalObs > 0
      ? Math.round(obs.reduce((s, o) => s + (o.observation_text || '').length, 0) / totalObs)
      : 0;

    const childrenUnobserved14d = keyChildren.filter(c => !c.last_obs_date || c.gap_days > 14).length;

    // Active flags
    const { rows: flags } = await db.query(`
      SELECT * FROM staff_performance_flags
      WHERE staff_id=$1 AND period_end >= $2 AND acknowledged_at IS NULL
      ORDER BY generated_at DESC
    `, [req.params.staffId, start]);

    res.json({
      staff,
      period: { start, end, label: periodLabel(period) },
      key_children: keyChildren.map(c => ({
        ...c,
        obs_count: parseInt(c.obs_count) || 0,
        gap_days: c.gap_days ? Math.round(parseFloat(c.gap_days)) : null,
        last_obs_date: c.last_obs_date || null,
      })),
      metrics: {
        total_obs: totalObs,
        obs_per_key_child_per_week: parseFloat(obsPerKeyChildPerWeek),
        pct_obs_with_next_steps: pctObsWithNextSteps,
        pct_next_steps_followed_up: pctNextStepsFollowedUp,
        eyfs_coverage: eyfsCounts,
        coverage_balance_score: parseFloat(coverageBalanceScore),
        avg_obs_length_chars: avgObsLengthChars,
        children_unobserved_14d: childrenUnobserved14d,
      },
      standards: S,
      flags,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /room ──────────────────────────────────────────────────────────────
router.get('/room', managerOrLeader, async (req, res) => {
  const db = getPool();
  const { period } = req.query;
  const { start, end } = periodDates(period);
  try {
    const { rows: rooms } = await db.query('SELECT id, name FROM rooms ORDER BY id');
    const result = [];
    for (const room of rooms) {
      const { rows: staffInRoom } = await db.query(
        `SELECT id, first_name||' '||last_name as name FROM staff WHERE room_id=$1 AND is_active=true`,
        [room.id]
      );
      const { rows: childrenInRoom } = await db.query(
        `SELECT id FROM children WHERE room_id=$1 AND is_active=true`, [room.id]
      );
      const childIds = childrenInRoom.map(c => c.id);
      if (childIds.length === 0) {
        result.push({ room_id: room.id, room_name: room.name, staff_count: staffInRoom.length, child_count: 0, avg_obs_per_child: 0, children_unobserved_14d: 0, staff_contributions: [], flags_count: 0 });
        continue;
      }

      const { rows: obsRows } = await db.query(`
        SELECT o.staff_id, s.first_name||' '||s.last_name as staff_name, COUNT(*) as obs_count
        FROM observations o
        JOIN staff s ON s.id=o.staff_id
        WHERE o.child_id = ANY($1) AND o.created_at >= $2 AND o.created_at <= $3::date + interval '1 day'
        GROUP BY o.staff_id, s.first_name, s.last_name
      `, [childIds, start, end]);

      const totalRoomObs = obsRows.reduce((s, r) => s + parseInt(r.obs_count), 0);
      const avgObsPerChild = childIds.length > 0 ? (totalRoomObs / childIds.length).toFixed(1) : 0;

      // Children unobserved 14d
      const { rows: unobsRows } = await db.query(`
        SELECT COUNT(*) as cnt FROM children c
        WHERE c.room_id=$1 AND c.is_active=true
          AND NOT EXISTS (
            SELECT 1 FROM observations o WHERE o.child_id=c.id
              AND o.created_at >= NOW() - interval '14 days'
          )
      `, [room.id]);

      const { rows: flagsCount } = await db.query(`
        SELECT COUNT(*) as cnt FROM staff_performance_flags spf
        JOIN staff s ON s.id=spf.staff_id
        WHERE s.room_id=$1 AND spf.acknowledged_at IS NULL
      `, [room.id]);

      result.push({
        room_id: room.id,
        room_name: room.name,
        staff_count: staffInRoom.length,
        child_count: childIds.length,
        avg_obs_per_child: parseFloat(avgObsPerChild),
        children_unobserved_14d: parseInt(unobsRows[0].cnt),
        staff_contributions: obsRows.map(r => ({
          staff_id: r.staff_id,
          name: r.staff_name,
          obs_count: parseInt(r.obs_count),
          pct_of_room_total: totalRoomObs > 0 ? Math.round((r.obs_count / totalRoomObs) * 100) : 0,
        })),
        flags_count: parseInt(flagsCount[0].cnt),
      });
    }
    res.json({ rooms: result, period: { start, end, label: periodLabel(period) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /overview ──────────────────────────────────────────────────────────
router.get('/overview', managerOrLeader, async (req, res) => {
  const db = getPool();
  const { period } = req.query;
  const { start, end } = periodDates(period);
  try {
    const { rows: [obsCount] } = await db.query(
      `SELECT COUNT(*) as cnt FROM observations WHERE created_at >= $1 AND created_at <= $2::date + interval '1 day'`,
      [start, end]
    );
    const { rows: [staffFlags] } = await db.query(
      `SELECT COUNT(DISTINCT staff_id) as cnt FROM staff_performance_flags WHERE period_end >= $1 AND acknowledged_at IS NULL`,
      [start]
    );
    const { rows: [unobsCount] } = await db.query(
      `SELECT COUNT(*) as cnt FROM children c WHERE c.is_active=true AND NOT EXISTS (
        SELECT 1 FROM observations o WHERE o.child_id=c.id AND o.created_at >= NOW() - interval '14 days'
      )`
    );
    const { rows: flags } = await db.query(`
      SELECT spf.flag_type, spf.flag_data, spf.generated_at,
        s.first_name||' '||s.last_name as staff_name
      FROM staff_performance_flags spf
      JOIN staff s ON s.id=spf.staff_id
      WHERE spf.acknowledged_at IS NULL
      ORDER BY spf.generated_at DESC
      LIMIT 20
    `);
    res.json({
      period_label: periodLabel(period),
      total_observations: parseInt(obsCount.cnt),
      staff_with_flags: parseInt(staffFlags.cnt),
      children_unobserved: parseInt(unobsCount.cnt),
      flags,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /flags ─────────────────────────────────────────────────────────────
// List active (unacknowledged) performance flags, optionally for one staff member.
// Returns a bare array; staff-performance.html groups by staff_id. (Was 404 — route was missing.)
router.get('/flags', managerOrLeader, async (req, res) => {
  const db = getPool();
  const { staff_id } = req.query;
  try {
    const params = [];
    let where = 'spf.acknowledged_at IS NULL';
    if (staff_id) { params.push(staff_id); where += ` AND spf.staff_id = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT spf.staff_id, spf.flag_type, spf.flag_data, spf.generated_at, spf.period_end,
              s.first_name||' '||s.last_name AS staff_name
       FROM staff_performance_flags spf
       JOIN staff s ON s.id = spf.staff_id
       WHERE ${where}
       ORDER BY spf.generated_at DESC`,
      params
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /generate-flags ───────────────────────────────────────────────────
router.post('/generate-flags', managerOrLeader, async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role)) return res.status(403).json({ error: 'Manager only' });
  const db = getPool();
  const { start, end } = periodDates('14');
  try {
    const { rows: stds } = await db.query('SELECT key, value FROM observation_standards');
    const S = {};
    stds.forEach(r => { S[r.key] = parseFloat(r.value); });

    const { rows: activeStaff } = await db.query(
      `SELECT id, first_name||' '||last_name as name, role FROM staff WHERE is_active=true`
    );

    let flagsCreated = 0;
    for (const staff of activeStaff) {
      const { rows: keyChildren } = await db.query(
        `SELECT id FROM children WHERE key_person_id=$1 AND is_active=true`, [staff.id]
      );
      if (keyChildren.length === 0) continue;

      const childIds = keyChildren.map(c => c.id);
      const { rows: obs } = await db.query(`
        SELECT id, child_id, observation_text, eyfs_areas, created_at
        FROM observations
        WHERE staff_id=$1 AND created_at >= $2 AND created_at <= $3::date + interval '1 day'
      `, [staff.id, start, end]);

      const periodDays = Math.max(1, (new Date(end) - new Date(start)) / 86400000);
      const obsPerKeyChildPerWeek = keyChildren.length > 0
        ? obs.length / keyChildren.length / (periodDays / 7) : 0;

      const newFlags = [];

      // LOW_COVERAGE
      if (obsPerKeyChildPerWeek < S.expected_obs_per_key_child_per_week) {
        newFlags.push({
          flag_type: 'LOW_COVERAGE',
          flag_data: {
            obs_count: obs.length,
            key_children: keyChildren.length,
            obs_per_child_per_week: obsPerKeyChildPerWeek.toFixed(2),
            standard: S.expected_obs_per_key_child_per_week,
          }
        });
      }

      // AREA_IMBALANCE
      const areaCounts = { CL: 0, PSED: 0, PD: 0, L: 0, M: 0, UTW: 0, EAD: 0 };
      obs.forEach(o => (o.eyfs_areas||[]).forEach(a => {
        if (areaCounts[a] !== undefined) areaCounts[a]++;
      }));
      const areasWithObs = Object.values(areaCounts).filter(v => v > 0).length;
      if (obs.length >= 5 && (areasWithObs / 7) < S.coverage_balance_threshold) {
        newFlags.push({
          flag_type: 'AREA_IMBALANCE',
          flag_data: { areas_covered: areasWithObs, out_of: 7, distribution: areaCounts }
        });
      }

      // UNOBSERVED_CHILDREN
      const unobsChildren = childIds.filter(cid => !obs.some(o => o.child_id === cid));
      if (unobsChildren.length > 0) {
        newFlags.push({
          flag_type: 'UNOBSERVED_CHILDREN',
          flag_data: { unobserved_count: unobsChildren.length, total_key_children: keyChildren.length }
        });
      }

      // LOW_QUALITY
      const shortObs = obs.filter(o => (o.observation_text||'').length < S.obs_quality_min_chars);
      if (shortObs.length > obs.length * 0.3 && obs.length > 3) {
        newFlags.push({
          flag_type: 'LOW_QUALITY',
          flag_data: { short_obs_count: shortObs.length, total_obs: obs.length, min_chars: S.obs_quality_min_chars }
        });
      }

      // NEXT_STEPS_MISSING
      const obsWithNS = obs.filter(o => /next.?step/i.test(o.observation_text||''));
      if (obs.length >= 5 && (obsWithNS.length / obs.length) < 0.2) {
        newFlags.push({
          flag_type: 'NEXT_STEPS_MISSING',
          flag_data: { obs_with_next_steps: obsWithNS.length, total_obs: obs.length }
        });
      }

      // Insert new flags (clear old unacknowledged first)
      await db.query(
        `DELETE FROM staff_performance_flags WHERE staff_id=$1 AND acknowledged_at IS NULL AND period_start=$2`,
        [staff.id, start]
      );
      for (const flag of newFlags) {
        await db.query(
          `INSERT INTO staff_performance_flags (staff_id, flag_type, flag_data, period_start, period_end)
           VALUES ($1,$2,$3,$4,$5)`,
          [staff.id, flag.flag_type, JSON.stringify(flag.flag_data), start, end]
        );
        flagsCreated++;
      }
    }
    res.json({ flags_created: flagsCreated, staff_checked: activeStaff.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /staff/:staffId/supervision-pack ──────────────────────────────────
router.get('/staff/:staffId/supervision-pack', managerOrLeader, async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role)) return res.status(403).json({ error: 'Manager only' });
  const db = getPool();
  const { period } = req.query;
  const { start, end } = periodDates(period || 'term');

  try {
    // Re-use staff/:staffId logic
    const { rows: staffRows } = await db.query(
      `SELECT id, first_name||' '||last_name as name, role, contracted_hours FROM staff WHERE id=$1`,
      [req.params.staffId]
    );
    if (!staffRows.length) return res.status(404).json({ error: 'Staff not found' });
    const staff = staffRows[0];

    const { rows: obs } = await db.query(`
      SELECT id, child_id, observation_text, eyfs_areas, created_at
      FROM observations
      WHERE staff_id=$1 AND created_at >= $2 AND created_at <= $3::date + interval '1 day'
      ORDER BY RANDOM() LIMIT 3
    `, [req.params.staffId, start, end]);

    const { rows: flags } = await db.query(`
      SELECT flag_type, flag_data FROM staff_performance_flags
      WHERE staff_id=$1 AND acknowledged_at IS NULL
    `, [req.params.staffId]);

    const { rows: keyChildren } = await db.query(`
      SELECT c.id, c.first_name||' '||c.last_name as name, COUNT(o.id) as obs_count
      FROM children c
      LEFT JOIN observations o ON o.child_id=c.id AND o.staff_id=$1
        AND o.created_at >= $2 AND o.created_at <= $3::date + interval '1 day'
      WHERE c.key_person_id=$1 AND c.is_active=true
      GROUP BY c.id
    `, [req.params.staffId, start, end]);

    const totalObs = obs.length;
    const activeKeyChildren = keyChildren.length;
    const periodDays = Math.max(1, (new Date(end) - new Date(start)) / 86400000);
    const obsPerKeyChildPerWeek = activeKeyChildren > 0 ? (totalObs / activeKeyChildren / (periodDays / 7)).toFixed(2) : 0;

    // AI discussion prompts via Ollama
    let aiPrompts = [];
    try {
      const aiBody = {
        model: 'qwen2.5:4b',
        prompt: `You are helping a nursery manager prepare for a staff supervision. Staff: ${staff.name}, Role: ${staff.role}, Period: ${periodLabel(period || 'term')}. Metrics: observations this period: ${totalObs}, obs per key child per week: ${obsPerKeyChildPerWeek}, key children: ${activeKeyChildren}. Flags raised: ${flags.map(f => f.flag_type).join(', ') || 'none'}. Generate 4 factual discussion prompts a manager could use in the supervision. Do not make judgements about the staff member's ability. Do not use language like 'poor performance' or 'weakness'. Frame prompts as curious questions that invite reflection. Output as JSON array of strings only.`,
        stream: false, think: false,
      };
      const aiRes = await fetch(`${process.env.OLLAMA_HOST || 'http://localhost:11434'}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(aiBody),
        signal: AbortSignal.timeout(30000),
      });
      const aiData = await aiRes.json();
      const raw = (aiData.response || '').trim();
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) aiPrompts = JSON.parse(match[0]);
    } catch { aiPrompts = ['How do you feel about your observations this term?', 'Which child have you found most rewarding to observe and why?', 'Are there any children you feel you haven\'t had enough one-to-one time with?', 'What would you like to try differently in your observations next term?']; }

    res.json({
      staff,
      period: { start, end, label: periodLabel(period || 'term') },
      metrics: { total_obs: totalObs, obs_per_key_child_per_week: parseFloat(obsPerKeyChildPerWeek), key_children: activeKeyChildren },
      key_children: keyChildren,
      flags,
      ai_discussion_prompts: aiPrompts,
      observation_samples: obs,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /overdue — per-staff overdue observations + report timings ────
router.get('/overdue', managerOrLeader, async (req, res) => {
  try {
    const db = getPool();

    // Overdue observations: key children not observed by their key person in 14+ days
    const { rows: obsOverdue } = await db.query(`
      SELECT c.id as child_id, c.first_name||' '||c.last_name as child_name,
             c.key_person_id, s.first_name||' '||s.last_name as key_person,
             EXTRACT(DAY FROM NOW() - MAX(o.created_at)) as gap_days
      FROM children c
      JOIN staff s ON s.id = c.key_person_id
      LEFT JOIN observations o ON o.child_id = c.id AND o.staff_id = c.key_person_id
      WHERE c.is_active = true AND c.key_person_id IS NOT NULL
      GROUP BY c.id, c.first_name, c.last_name, c.key_person_id, s.first_name, s.last_name
      HAVING MAX(o.created_at) IS NULL OR EXTRACT(DAY FROM NOW() - MAX(o.created_at)) > 14
      ORDER BY key_person_id, gap_days DESC
    `);

    // Settling-in overdue: new children (started < 3 months ago) with settling-in report not issued
    const { rows: settlingOverdue } = await db.query(`
      SELECT c.id as child_id, c.first_name||' '||c.last_name as child_name,
             c.key_person_id, s.first_name||' '||s.last_name as key_person,
             c.date_of_birth as start_age_approx,
             (CURRENT_DATE - c.start_date::date) as days_since_start
      FROM children c
      JOIN staff s ON s.id = c.key_person_id
      WHERE c.is_active = true
        AND c.start_date IS NOT NULL
        AND (CURRENT_DATE - c.start_date::date) < 90
        AND NOT EXISTS (
          SELECT 1 FROM reports r WHERE r.child_id = c.id AND r.report_type = 'settling_in'
        )
      ORDER BY c.start_date ASC
    `);

    // 6-month review due: children who started 4-7 months ago without a report
    const { rows: sixMonthDue } = await db.query(`
      SELECT c.id as child_id, c.first_name||' '||c.last_name as child_name,
             c.key_person_id, s.first_name||' '||s.last_name as key_person,
             (CURRENT_DATE - c.start_date::date) as days_since_start
      FROM children c
      JOIN staff s ON s.id = c.key_person_id
      WHERE c.is_active = true
        AND c.start_date IS NOT NULL
        AND (CURRENT_DATE - c.start_date::date) BETWEEN 100 AND 240
        AND NOT EXISTS (
          SELECT 1 FROM reports r WHERE r.child_id = c.id AND r.report_type = 'six_month'
        )
      ORDER BY c.start_date ASC
    `);

    // Group by key person
    const byPerson = {};
    for (const r of obsOverdue) {
      if (!byPerson[r.key_person_id]) byPerson[r.key_person_id] = { name: r.key_person, obs: [], settling: [], six_month: [] };
      byPerson[r.key_person_id].obs.push(r);
    }
    for (const r of settlingOverdue) {
      if (!byPerson[r.key_person_id]) byPerson[r.key_person_id] = { name: r.key_person, obs: [], settling: [], six_month: [] };
      byPerson[r.key_person_id].settling.push(r);
    }
    for (const r of sixMonthDue) {
      if (!byPerson[r.key_person_id]) byPerson[r.key_person_id] = { name: r.key_person, obs: [], settling: [], six_month: [] };
      byPerson[r.key_person_id].six_month.push(r);
    }

    const result = Object.values(byPerson).map(p => ({
      staff_id: Object.keys(byPerson).find(k => byPerson[k].name === p.name),
      name: p.name,
      overdue_obs_count: p.obs.length,
      settling_in_overdue_count: p.settling.length,
      six_month_due_count: p.six_month.length,
      total_overdue: p.obs.length + p.settling.length + p.six_month.length,
      details: {
        obs: p.obs.map(r => ({ child_id: r.child_id, child_name: r.child_name, gap_days: parseInt(r.gap_days) })),
        settling: p.settling.map(r => ({ child_id: r.child_id, child_name: r.child_name })),
        six_month: p.six_month.map(r => ({ child_id: r.child_id, child_name: r.child_name })),
      },
    }));

    res.json({ by_person: result, summary: {
      total_overdue_obs: obsOverdue.length,
      total_settling_in: settlingOverdue.length,
      total_six_month: sixMonthDue.length,
    }});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /review-cycles/drain — auto-seed reminder tasks ──
router.post('/review-cycles/drain', managerOrLeader, async (req, res) => {
  try {
    const db = getPool();
    let created = 0;

    // ── 1. Parse term_dates from wren_settings ────────────────────────────
    const { rows: tdRows } = await db.query(
      `SELECT value FROM wren_settings WHERE key='term_dates_2025_2026'`
    );
    let parsedTerms = [];
    const raw = tdRows && tdRows[0] && tdRows[0].value;
    if (typeof raw === 'string') {
      const blocks = raw.split('|').map(s => s.trim());
      blocks.forEach(b => {
        const termMatch = b.match(/^(\S.*?):\s*(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})/);
        if (termMatch) {
          const [, name, td, tm, ty, hd, hm, hy] = termMatch;
          const termStart = `${ty}-${tm.padStart(2,'0')}-${td.padStart(2,'0')}`;
          const termEnd = `${hy}-${hm.padStart(2,'0')}-${hd.padStart(2,'0')}`;
          parsedTerms.push({ name, start: termStart, end: termEnd });
        }
        const htMatch = b.match(/^Half-term:\s*(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})/);
        if (htMatch) {
          const [, d1, m1, y1, d2, m2, y2] = htMatch;
          parsedTerms.push({
            name: 'Half-term',
            start: `${y1}-${m1.padStart(2,'0')}-${d1.padStart(2,'0')}`,
            end: `${y2}-${m2.padStart(2,'0')}-${d2.padStart(2,'0')}`
          });
        }
      });
    }

    // ── 2. Settling-in overdue: children started 14-60 days ago, no settling-in report, no task ──
    const { rows: settlingKids } = await db.query(`
      SELECT c.id as child_id, c.first_name || ' ' || c.last_name as child_name,
             c.key_person_id, s.first_name || ' ' || s.last_name as key_person,
             (CURRENT_DATE - c.start_date::date) as days_since_start
      FROM children c
      JOIN staff s ON s.id = c.key_person_id
      WHERE c.is_active = true
        AND c.start_date IS NOT NULL
        AND (CURRENT_DATE - c.start_date::date) BETWEEN 14 AND 60
        AND NOT EXISTS (
          SELECT 1 FROM reports r WHERE r.child_id = c.id AND r.report_type = 'settling_in'
        )
        AND NOT EXISTS (
          SELECT 1 FROM tasks t
          WHERE t.title ILIKE 'Settling-in report due for %'
            AND t.owner_staff_id = c.key_person_id AND t.status = 'open'
        )
      ORDER BY c.start_date ASC
    `);
    for (const r of settlingKids) {
      await db.query(
        `INSERT INTO tasks (title, due_date, owner_staff_id, source, status, priority, created_at)
         VALUES ($1, $2, $3, 'review_cycles', 'open', 'high', NOW())
         ON CONFLICT DO NOTHING`,
        [`Settling-in report due for ${r.child_name}`,
         (new Date(Date.now() + 14*86400000).toISOString().split('T')[0]),
         r.key_person_id]
      );
      created++;
    }

    // ── 3. 6-month review due: children started 90-240 days ago, no 6-month report ──
    const { rows: sixMonthKids2 } = await db.query(`
      SELECT c.id as child_id, c.first_name || ' ' || c.last_name as child_name,
             c.key_person_id, s.first_name || ' ' || s.last_name as key_person,
             (CURRENT_DATE - c.start_date::date) as days_since_start
      FROM children c
      JOIN staff s ON s.id = c.key_person_id
      WHERE c.is_active = true
        AND c.start_date IS NOT NULL
        AND (CURRENT_DATE - c.start_date::date) BETWEEN 90 AND 240
        AND NOT EXISTS (
          SELECT 1 FROM reports r WHERE r.child_id = c.id AND r.report_type = 'six_month'
        )
      ORDER BY c.start_date ASC
    `);
    for (const r of sixMonthKids2) {
      // Check no existing task for this staff with this type
      const { rows: existing } = await db.query(
        `SELECT 1 FROM tasks WHERE title ILIKE $1 AND owner_staff_id = $2 AND status = 'open' LIMIT 1`,
        [`%6-month review due for ${r.child_name}%`, r.key_person_id]
      );
      if (existing.length === 0) {
        await db.query(
          `INSERT INTO tasks (title, due_date, owner_staff_id, source, status, priority, created_at)
           VALUES ($1, $2, $3, 'review_cycles', 'open', 'high', NOW())
           ON CONFLICT DO NOTHING`,
          [`6-month review due for ${r.child_name}`,
           (new Date(Date.now() + 30*86400000).toISOString().split('T')[0]),
           r.key_person_id]
        );
        created++;
      }
    }

    // ── 4. Termly update window: during half-term, check children who need termly theme update ──
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const halfTerms = parsedTerms.filter(t => t.name === 'Half-term');
    for (const ht of halfTerms) {
      if (todayStr >= ht.start && todayStr <= ht.end) {
        const { rows: termKids } = await db.query(`
          SELECT c.id as child_id, c.first_name || ' ' || c.last_name as child_name,
                 c.key_person_id
          FROM children c
          WHERE c.is_active = true
            AND NOT EXISTS (
              SELECT 1 FROM reports r
              WHERE r.child_id = c.id AND r.report_type = 'termly_update'
                AND r.updated_at >= $1
            )
          LIMIT 20
        `, [ht.start]);
        for (const r of termKids) {
          await db.query(
            `INSERT INTO tasks (title, due_date, owner_staff_id, source, status, priority, created_at)
             VALUES ($1, $2, $3, 'review_cycles', 'open', 'medium', NOW())
             ON CONFLICT DO NOTHING`,
            [`Termly theme update due for ${r.child_name}`,
             (new Date(Date.parse(ht.end) + 7*86400000).toISOString().split('T')[0]),
             r.key_person_id]
          );
          created++;
        }
      }
    }

    res.json({ created, settling: settlingKids.length, six_month: sixMonthKids2.length, termly_update: created - settlingKids.length - sixMonthKids2.length, half_terms_parsed: halfTerms.length });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
