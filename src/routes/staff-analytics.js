const express = require('express');
const router  = express.Router();
const http    = require('http');
const crypto  = require('crypto');
const { getPool } = require('../db/pool');
const { requireRole } = require('../middleware/auth');

const OLLAMA_BASE  = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = 'qwen3.5:27b';
const OLLAMA_TIMEOUT_MS = 120000;

// ── Deterministic stats ───────────────────────────────────────────────────────

function computeMonthlyDays(absences) {
  const result = {};
  const today  = new Date();
  for (let i = 23; i >= 0; i--) {
    const d   = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    result[key] = 0;
  }
  for (const a of absences) {
    const d   = new Date(a.start_date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      result[key] = Math.round((result[key] + parseFloat(a.effective_days || 0)) * 100) / 100;
    }
  }
  return result;
}

function bradfordTier(score) {
  if (score < 51)  return 'green';
  if (score <= 200) return 'amber';
  if (score <= 450) return 'red';
  return 'critical';
}

async function computeSicknessStats(db, scopeFrom, scopeTo) {
  const { rows: rawAbsences } = await db.query(`
    SELECT
      a.id,
      a.staff_id,
      a.start_date::text  AS start_date,
      a.end_date::text    AS end_date,
      COALESCE(a.duration_days, (a.end_date - a.start_date + 1))::numeric AS effective_days
    FROM ladn.hr_absences a
    WHERE a.absence_type IN ('Sickness', 'Self-isolation')
      AND a.start_date >= $1
      AND a.start_date <= $2
    ORDER BY a.staff_id, a.start_date
  `, [scopeFrom, scopeTo]);

  const { rows: staff } = await db.query(`
    SELECT id, first_name || ' ' || last_name AS name, role
    FROM ladn.staff
    WHERE is_active = true
    ORDER BY id
  `);

  const today       = new Date();
  const w52Start    = new Date(today); w52Start.setDate(today.getDate() - 364);
  const w12Start    = new Date(today); w12Start.setFullYear(today.getFullYear() - 1);
  const w6Start     = new Date(today); w6Start.setMonth(today.getMonth() - 6);
  const w6PrevStart = new Date(w12Start);

  const stats = {};

  for (const s of staff) {
    const abs = rawAbsences.filter(a => a.staff_id === s.id);

    const abs52   = abs.filter(a => new Date(a.start_date) >= w52Start);
    const abs12   = abs.filter(a => new Date(a.start_date) >= w12Start);
    const abs6Now = abs.filter(a => new Date(a.start_date) >= w6Start);
    const abs6Prv = abs.filter(a => {
      const d = new Date(a.start_date);
      return d >= w6PrevStart && d < w6Start;
    });

    // Bradford: S = spells count (52w), D = total days (52w)
    const S  = abs52.length;
    const D  = abs52.reduce((acc, a) => acc + parseFloat(a.effective_days || 0), 0);
    const bf = Math.round(S * S * D);

    // Day-of-week onsets across full scope
    const dow = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    for (const a of abs) dow[new Date(a.start_date).getDay()]++;
    const total = abs.length;
    const monPct = total > 0 ? dow[1] / total : 0;
    const friPct = total > 0 ? dow[5] / total : 0;

    const days12 = abs12.reduce((acc, a) => acc + parseFloat(a.effective_days || 0), 0);
    const days24 = abs.reduce((acc, a) => acc + parseFloat(a.effective_days || 0), 0);
    const days6n = abs6Now.reduce((acc, a) => acc + parseFloat(a.effective_days || 0), 0);
    const days6p = abs6Prv.reduce((acc, a) => acc + parseFloat(a.effective_days || 0), 0);

    const flags = [];
    if (abs12.length >= 4)                         flags.push('frequent_short');
    if (monPct > 0.6 && total > 1)                 flags.push('monday_pattern');
    if (friPct > 0.6 && total > 1)                 flags.push('friday_pattern');
    if (abs.some(a => parseFloat(a.effective_days || 0) >= 20)) flags.push('long_term');
    if (days6p > 0 && days6n > days6p * 1.5)       flags.push('rising_trend');

    stats[s.id] = {
      staff_id:       s.id,
      name:           s.name,
      role:           s.role,
      days_12m:       Math.round(days12 * 100) / 100,
      days_24m:       Math.round(days24 * 100) / 100,
      spells_12m:     abs12.length,
      spells_24m:     abs.length,
      bradford_S:     S,
      bradford_D:     Math.round(D * 100) / 100,
      bradford_score: bf,
      bradford_tier:  bradfordTier(bf),
      dow_counts:     dow,
      mon_onset_pct:  Math.round(monPct * 100),
      fri_onset_pct:  Math.round(friPct * 100),
      flags,
      days_last_6m:   Math.round(days6n * 100) / 100,
      days_prev_6m:   Math.round(days6p * 100) / 100,
      monthly_days:   computeMonthlyDays(abs),
    };
  }

  return { stats_by_staff: stats, raw_absences: rawAbsences };
}

// ── Ollama narrative call ─────────────────────────────────────────────────────

function callOllama(promptText) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({
      model:   OLLAMA_MODEL,
      prompt:  promptText,
      stream:  false,
      options: { temperature: 0.3 },
    }));

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('Ollama request timed out after 120s'));
    }, OLLAMA_TIMEOUT_MS);

    const ollamaUrl = new URL(OLLAMA_BASE);
    const req = http.request({
      hostname: ollamaUrl.hostname,
      port:     ollamaUrl.port || 11434,
      path:     '/api/generate',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, rsp => {
      let data = '';
      rsp.on('data', chunk => { data += chunk; });
      rsp.on('end', () => {
        clearTimeout(timer);
        try   { resolve(JSON.parse(data).response || ''); }
        catch (e) { reject(e); }
      });
    });

    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.write(body);
    req.end();
  });
}

// ── Build anonymised summary for LLM (no raw absence rows, just per-staff stats) ─
function buildNarrativeStats(stats_by_staff) {
  const summary = [];
  for (const s of Object.values(stats_by_staff)) {
    summary.push({
      staff_id:       s.staff_id,
      days_12m:       s.days_12m,
      days_24m:       s.days_24m,
      spells_12m:     s.spells_12m,
      spells_24m:     s.spells_24m,
      bradford_score: s.bradford_score,
      bradford_tier:  s.bradford_tier,
      flags:          s.flags,
      mon_onset_pct:  s.mon_onset_pct,
      fri_onset_pct:  s.fri_onset_pct,
      days_last_6m:   s.days_last_6m,
      days_prev_6m:   s.days_prev_6m,
    });
  }
  return summary;
}

// ── POST /api/staff-analytics/sickness/run — manager only ────────────────────

router.post('/sickness/run', requireRole('manager'), async (req, res) => {
  const db  = getPool();
  const now = new Date();

  const defaultFrom = new Date(now); defaultFrom.setFullYear(now.getFullYear() - 2);
  const scopeFrom = req.body?.scope_from
    ? new Date(req.body.scope_from)
    : defaultFrom;
  const scopeTo   = req.body?.scope_to
    ? new Date(req.body.scope_to)
    : now;

  try {
    const { stats_by_staff, raw_absences } = await computeSicknessStats(db, scopeFrom, scopeTo);

    // SHA256 of raw input rows for reproducibility audit
    const rawHash = crypto.createHash('sha256')
      .update(JSON.stringify(raw_absences))
      .digest('hex');

    // Build flagged staff list (tier != green OR has flags)
    const flaggedStaff = Object.values(stats_by_staff)
      .filter(s => s.bradford_tier !== 'green' || s.flags.length > 0)
      .sort((a, b) => b.bradford_score - a.bradford_score)
      .map(s => ({
        staff_id:       s.staff_id,
        name:           s.name,
        bradford_score: s.bradford_score,
        bradford_tier:  s.bradford_tier,
        reasons:        s.flags,
      }));

    // Narrative via Ollama — fail gracefully
    let narrativeSummary = null;
    let modelUsed        = null;
    const narrativeStats = buildNarrativeStats(stats_by_staff);
    const ollamaPrompt   = [
      'You are a workforce analyst writing for a UK day nursery manager.',
      'The data below is anonymised per-staff sickness statistics over the past 24 months.',
      'DO NOT speculate beyond what the data shows.',
      'DO NOT make medical judgements about individuals.',
      'DO use neutral, factual language — these are management observations, not accusations.',
      '',
      'Stats:',
      JSON.stringify(narrativeStats, null, 2),
      '',
      'Write a 200-400 word summary covering:',
      '1. Overall picture — total sickness days, Bradford-tier distribution.',
      '2. Notable patterns — Monday/Friday clustering, rising trends, frequent-short spell concerns.',
      '   Name no more than 3 staff by anonymised id (e.g. "Staff member with ID 7").',
      '   The manager has the names alongside.',
      '3. Recommended actions — formal/informal review triggers, supportive conversations,',
      '   what NOT to act on (e.g. one-off serious illness).',
      '4. Limitations of the analysis — data quality, what is not visible (return-to-work,',
      '   GP notes if not captured, etc).',
      '',
      'Do NOT include the JSON in your output. Plain prose only. UK English.',
      'Bradford Factor is a screening tool, not a judgement. Reflect this in your tone.',
    ].join('\n');

    try {
      narrativeSummary = await callOllama(ollamaPrompt);
      modelUsed        = OLLAMA_MODEL;
      console.log('[staff-analytics] Ollama narrative generated, length:', narrativeSummary.length);
    } catch (ollamaErr) {
      console.error('[staff-analytics] Ollama call failed:', ollamaErr.message);
    }

    const { rows: [report] } = await db.query(`
      INSERT INTO ladn.staff_analytics_reports
        (report_type, scope_from, scope_to, generated_by, model_used,
         deterministic_stats, narrative_summary, flagged_staff, raw_inputs_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, generated_at
    `, [
      'sickness_patterns',
      scopeFrom,
      scopeTo,
      req.user.id,
      modelUsed,
      JSON.stringify(stats_by_staff),
      narrativeSummary,
      JSON.stringify(flaggedStaff),
      rawHash,
    ]);

    res.json({ id: report.id, generated_at: report.generated_at, narrative_null: !narrativeSummary });
  } catch (err) {
    console.error('[staff-analytics] run error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/staff-analytics/sickness/latest ─────────────────────────────────

router.get('/sickness/latest', requireRole('manager', 'room_leader'), async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT id, report_type, scope_from, scope_to, generated_at, generated_by,
             model_used, deterministic_stats, narrative_summary, flagged_staff, raw_inputs_hash
      FROM ladn.staff_analytics_reports
      WHERE report_type = 'sickness_patterns'
      ORDER BY generated_at DESC
      LIMIT 1
    `);
    if (!rows.length) return res.status(404).json({ error: 'No reports found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/staff-analytics/sickness/:id ────────────────────────────────────

router.get('/sickness/:id', requireRole('manager', 'room_leader'), async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { rows } = await db.query(`
      SELECT id, report_type, scope_from, scope_to, generated_at, generated_by,
             model_used, deterministic_stats, narrative_summary, flagged_staff, raw_inputs_hash
      FROM ladn.staff_analytics_reports
      WHERE id = $1 AND report_type = 'sickness_patterns'
    `, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Report not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/staff-analytics/sickness (history list) ─────────────────────────

router.get('/sickness', requireRole('manager', 'room_leader'), async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT r.id, r.scope_from, r.scope_to, r.generated_at, r.model_used,
             s.first_name || ' ' || s.last_name AS generated_by_name,
             jsonb_array_length(COALESCE(r.flagged_staff, '[]'::jsonb)) AS flagged_count,
             r.narrative_summary IS NOT NULL AS has_narrative
      FROM ladn.staff_analytics_reports r
      LEFT JOIN ladn.staff s ON s.id = r.generated_by
      WHERE r.report_type = 'sickness_patterns'
      ORDER BY r.generated_at DESC
      LIMIT 50
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SMART STAFFING ANALYSIS — Prompt 23
// ══════════════════════════════════════════════════════════════════════════════

const STAFFING_RATIOS = {
  baby:         { perChildren: 3,  ageMinMonths: 0,   ageMaxMonths: 24 },
  toddler:      { perChildren: 5,  ageMinMonths: 24,  ageMaxMonths: 36 },
  preschool:    { perChildren: 8,  ageMinMonths: 36,  ageMaxMonths: 60 },
  preschool_l6: { perChildren: 13, ageMinMonths: 36,  ageMaxMonths: 60 },
};

const NURSERY_OPEN  = 8;  // 8am
const NURSERY_CLOSE = 18; // 6pm

function calcAgeMonths(dobStr, asOfStr) {
  const [dy, dm, dd] = dobStr.split('-').map(Number);
  const [ay, am, ad] = asOfStr.split('-').map(Number);
  let months = (ay - dy) * 12 + (am - dm);
  if (ad < dd) months--;
  return months;
}

function calcAgeBucket(months) {
  if (months < 0)  return 'unknown';
  if (months < 24) return 'baby';
  if (months < 36) return 'toddler';
  if (months < 60) return 'preschool';
  return 'school_age';
}

function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

function getMondayStr(dateStr) {
  const d   = new Date(dateStr + 'T12:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun, 1=Mon … 6=Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().split('T')[0];
}

function getWeekdayStrs(mondayStr) {
  const days = [];
  for (let i = 0; i < 5; i++) days.push(addDaysStr(mondayStr, i));
  return days;
}

// work_patterns day_of_week: 0=Mon … 4=Fri
function getWPDayIndex(dateStr) {
  const dow = new Date(dateStr + 'T12:00:00Z').getUTCDay(); // 1=Mon … 5=Fri
  return dow - 1;
}

function parseHour(timeStr) {
  if (!timeStr) return null;
  return parseInt(timeStr.split(':')[0]);
}

function bucketChildren(childrenRows, asOfStr) {
  const b = { baby: 0, toddler: 0, preschool: 0, school_age: 0, unknown: 0 };
  for (const c of childrenRows) {
    if (!c.dob) { b.unknown++; continue; }
    const bucket = calcAgeBucket(calcAgeMonths(c.dob, asOfStr));
    b[bucket] = (b[bucket] || 0) + 1;
  }
  return b;
}

function calcRequired(buckets, hasL6) {
  const psR = hasL6 ? STAFFING_RATIOS.preschool_l6.perChildren : STAFFING_RATIOS.preschool.perChildren;
  return Math.ceil((buckets.baby      || 0) / STAFFING_RATIOS.baby.perChildren)
       + Math.ceil((buckets.toddler   || 0) / STAFFING_RATIOS.toddler.perChildren)
       + Math.ceil((buckets.preschool || 0) / psR);
}

async function computeSmartStaffing(db, asOfStr, lookaheadStr) {
  const { rows: staffRows } = await db.query(`
    SELECT id, first_name || ' ' || last_name AS full_name, role,
           qualification, qualification_level,
           is_dsl, is_deputy_dsl, is_first_aider,
           COALESCE(hourly_rate, 0)::numeric   AS hourly_rate,
           COALESCE(annual_salary, 0)::numeric AS annual_salary,
           is_active
    FROM ladn.staff WHERE is_active = true ORDER BY id
  `);

  const { rows: wps } = await db.query(`
    SELECT staff_id, day_of_week,
           shift_start::text, shift_end::text, is_off, room,
           COALESCE(effective_from::text, '2000-01-01') AS effective_from,
           COALESCE(effective_to::text,   '9999-12-31') AS effective_to
    FROM ladn.staff_work_patterns ORDER BY staff_id, day_of_week
  `);

  const { rows: absences } = await db.query(`
    SELECT staff_id, start_date::text AS start_date, end_date::text AS end_date
    FROM ladn.absence_requests WHERE status = 'approved' ORDER BY staff_id, start_date
  `);

  const { rows: childrenRows } = await db.query(`
    SELECT id, room, date_of_birth::text AS dob
    FROM ladn.children
    WHERE (status IS NULL OR status = 'active') ORDER BY date_of_birth
  `);

  function isAbsent(staffId, dateStr) {
    return absences.some(a =>
      a.staff_id === staffId && dateStr >= a.start_date && dateStr <= a.end_date);
  }

  function staffAtHour(dateStr, hour) {
    const wpDay = getWPDayIndex(dateStr);
    const present = [];
    for (const s of staffRows) {
      if (isAbsent(s.id, dateStr)) continue;
      const pat = wps.find(p =>
        p.staff_id === s.id &&
        p.day_of_week === wpDay &&
        !p.is_off &&
        dateStr >= p.effective_from &&
        dateStr <= p.effective_to
      );
      if (!pat) continue;
      const sh = parseHour(pat.shift_start);
      const eh = parseHour(pat.shift_end);
      if (sh === null || eh === null) continue;
      if (hour >= sh && hour < eh) {
        present.push({
          id:             s.id,
          name:           s.full_name,
          qual_level:     parseInt(s.qualification_level) || 0,
          is_dsl:         !!s.is_dsl,
          is_deputy_dsl:  !!s.is_deputy_dsl,
          is_first_aider: !!s.is_first_aider,
          room:           pat.room,
        });
      }
    }
    return present;
  }

  function buildHeatmap(mondayStr, childBuckets) {
    const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    const days = getWeekdayStrs(mondayStr);
    const rows = [];
    for (let di = 0; di < days.length; di++) {
      const dateStr = days[di];
      for (let hour = NURSERY_OPEN; hour < NURSERY_CLOSE; hour++) {
        const staff      = staffAtHour(dateStr, hour);
        const qualified  = staff.filter(s => s.qual_level >= 2);
        const apprentice = staff.filter(s => s.qual_level === 1);
        const hasL6      = staff.some(s => s.qual_level >= 6);
        const dslOK      = staff.some(s => s.is_dsl || s.is_deputy_dsl);
        const faOK       = staff.some(s => s.is_first_aider);
        const eff        = qualified.length + apprentice.length * 0.5;
        const req        = calcRequired(childBuckets, hasL6);
        const diff       = Math.round((eff - req) * 10) / 10;
        rows.push({
          date:               dateStr,
          day_name:           DAY_NAMES[di],
          hour,
          staff_count:        staff.length,
          effective_count:    eff,
          required:           req,
          surplus_deficit:    diff,
          rag:                diff < 0 ? 'red' : diff === 0 ? 'amber' : 'green',
          dsl_present:        dslOK,
          first_aider_present: faOK,
          staff_names:        staff.map(s => `${s.name} (L${s.qual_level}, ${s.room})`),
        });
      }
    }
    return rows;
  }

  const curMonday  = getMondayStr(asOfStr);
  const curBuckets = bucketChildren(childrenRows, asOfStr);
  const curHeatmap = buildHeatmap(curMonday, curBuckets);

  const sep1Str     = '2026-09-01';
  const sepLeavers  = childrenRows.filter(c => c.dob && calcAgeMonths(c.dob, sep1Str) >= 48);
  const postSepKids = childrenRows.filter(c => !sepLeavers.find(l => l.id === c.id));
  const sepBuckets  = bucketChildren(postSepKids, sep1Str);
  const sepMonday   = getMondayStr(sep1Str);
  const sepHeatmap  = buildHeatmap(sepMonday, sepBuckets);

  const coverGaps = curHeatmap
    .filter(s => !s.dsl_present || !s.first_aider_present)
    .map(s => ({
      date: s.date, day: s.day_name, hour: s.hour,
      missing: [
        ...(!s.dsl_present         ? ['DSL']          : []),
        ...(!s.first_aider_present ? ['First Aider']  : []),
      ],
    }));

  // Wage computation
  const staffWeekHrs = {};
  for (const p of wps) {
    if (p.is_off) continue;
    const sh = parseHour(p.shift_start);
    const eh = parseHour(p.shift_end);
    if (sh === null || eh === null || eh <= sh) continue;
    const raw = eh - sh;
    const hrs = raw > 0.5 ? raw - 0.5 : raw;
    staffWeekHrs[p.staff_id] = (staffWeekHrs[p.staff_id] || 0) + hrs;
  }

  let totalWeeklyCost = 0;
  const staffCosts = [];
  for (const s of staffRows) {
    const wh   = staffWeekHrs[s.id] || 0;
    const rate = parseFloat(s.hourly_rate) || 0;
    const cost = Math.round(wh * rate * 100) / 100;
    totalWeeklyCost += cost;
    staffCosts.push({
      id: s.id, name: s.full_name,
      qual_level: parseInt(s.qualification_level) || 0,
      is_dsl: !!s.is_dsl, is_first_aider: !!s.is_first_aider,
      hourly_rate: rate, weekly_hours: wh, weekly_cost: cost,
    });
  }
  totalWeeklyCost = Math.round(totalWeeklyCost * 100) / 100;

  // Greedy min-cost: cheapest staff to meet worst-hour ratio + DSL coverage
  const worstReq = calcRequired(curBuckets, false);
  const byRate   = staffCosts
    .filter(s => s.hourly_rate > 0 && (staffWeekHrs[s.id] || 0) > 0)
    .sort((a, b) => a.hourly_rate - b.hourly_rate);

  const dslStaff = byRate.find(s => s.is_dsl);
  let minPool;
  if (dslStaff && !byRate.slice(0, worstReq).some(s => s.is_dsl)) {
    minPool = [...byRate.filter(s => !s.is_dsl).slice(0, worstReq - 1), dslStaff];
  } else {
    minPool = byRate.slice(0, worstReq);
  }
  const avgHrs      = minPool.length ? minPool.reduce((a, s) => a + (staffWeekHrs[s.id] || 35), 0) / minPool.length : 35;
  const minWeeklyCost = Math.round(minPool.reduce((a, s) => a + s.hourly_rate * avgHrs, 0) * 100) / 100;
  const effPct        = totalWeeklyCost > 0 ? Math.round((minWeeklyCost / totalWeeklyCost) * 100) : 0;

  const deficitSlots = curHeatmap.filter(s => s.surplus_deficit < 0);
  const allDiffs     = curHeatmap.map(s => s.surplus_deficit);
  const avgSurplus   = allDiffs.length ? Math.round(allDiffs.reduce((a, b) => a + b, 0) / allDiffs.length * 10) / 10 : 0;

  return {
    as_of_date:       asOfStr,
    lookahead_to:     lookaheadStr,
    children_summary: { total: childrenRows.length, ...curBuckets },
    sep_leavers: {
      count:              sepLeavers.length,
      children_remaining: postSepKids.length,
      buckets_after_sep:  sepBuckets,
    },
    current_week_heatmap: curHeatmap,
    sep_week_heatmap:     sepHeatmap,
    mandatory_cover_gaps: coverGaps,
    wage_analysis: {
      total_weekly_cost:       totalWeeklyCost,
      min_ratio_weekly_cost:   minWeeklyCost,
      efficiency_pct:          effPct,
      staff_with_rate_count:   byRate.length,
      min_headcount_for_ratio: worstReq,
    },
    staff_costs: staffCosts,
    coverage_summary: {
      worst_deficit:             Math.min(...allDiffs),
      best_surplus:              Math.max(...allDiffs),
      avg_surplus:               avgSurplus,
      slots_total:               curHeatmap.length,
      slots_deficit:             deficitSlots.length,
      slots_at_minimum:          curHeatmap.filter(s => s.surplus_deficit === 0).length,
      slots_surplus:             curHeatmap.filter(s => s.surplus_deficit > 0).length,
      dsl_count:                 staffRows.filter(s => s.is_dsl || s.is_deputy_dsl).length,
      first_aider_count:         staffRows.filter(s => s.is_first_aider).length,
      no_first_aider_registered: staffRows.every(s => !s.is_first_aider),
      l3_plus_count:             staffRows.filter(s => (parseInt(s.qualification_level) || 0) >= 3).length,
      l6_plus_count:             staffRows.filter(s => (parseInt(s.qualification_level) || 0) >= 6).length,
      cover_gap_hours:           coverGaps.length,
    },
    ratio_constants: STAFFING_RATIOS,
    settings_used: {
      nursery_open:                  NURSERY_OPEN,
      nursery_close:                 NURSERY_CLOSE,
      apprentice_counts_as_half:     true,
      mandatory_dsl_per_hour:        1,
      mandatory_first_aider_per_hour: 1,
    },
  };
}

// ── POST /api/staff-analytics/smart-staffing/run ─────────────────────────────

router.post('/smart-staffing/run', requireRole('manager'), async (req, res) => {
  const db     = getPool();
  const now    = new Date();
  const asOf   = req.body?.as_of_date || now.toISOString().split('T')[0];
  const lookTo = req.body?.lookahead_to_date || addDaysStr(asOf, 90);

  try {
    const stats = await computeSmartStaffing(db, asOf, lookTo);

    const rawHash = crypto.createHash('sha256')
      .update(JSON.stringify({ asOf, lookTo })).digest('hex');

    const summaryForLLM = {
      as_of_date:       stats.as_of_date,
      children_summary: stats.children_summary,
      coverage_summary: stats.coverage_summary,
      wage_analysis:    stats.wage_analysis,
      sep_leavers:      stats.sep_leavers,
      cover_gap_hours:  stats.mandatory_cover_gaps.length,
      worst_slot:       [...stats.current_week_heatmap]
        .sort((a, b) => a.surplus_deficit - b.surplus_deficit)[0] || null,
      settings_used:    stats.settings_used,
    };

    const ollamaPrompt = [
      'You are a staffing analyst writing for a UK day nursery manager.',
      'The data below is pre-computed. Do NOT re-derive or contradict the numbers.',
      '',
      JSON.stringify(summaryForLLM, null, 2),
      '',
      'Write a 250–500 word staffing report covering:',
      '1. Current state — over/understaffed this week, by how much, which rooms/slots are tightest.',
      '2. September outlook — after school-age leavers depart, what changes in required staffing.',
      '3. DSL / L3 distribution — are mandatory cover requirements being met, any gaps.',
      '4. Wage efficiency — weekly cost vs ratio-minimum, what the efficiency % means in practice.',
      '5. Recommendations — up to 3 bullet points on possible hire/restructure/room reassignment.',
      '',
      'REQUIRED FINAL PARAGRAPH: Clearly state this report is generated by a mathematical model',
      'based on work pattern data, is NOT a substitute for professional HR or legal advice, and',
      'that any staffing decisions must involve proper management judgement, staff consultation,',
      'and full compliance with employment law and EYFS statutory requirements.',
      '',
      'Tone: factual, professional, UK English. No JSON. Plain prose only.',
    ].join('\n');

    let narrativeSummary = null;
    let modelUsed = null;
    try {
      narrativeSummary = await callOllama(ollamaPrompt);
      modelUsed = OLLAMA_MODEL;
      console.log('[smart-staffing] narrative generated, length:', narrativeSummary.length);
    } catch (e) {
      console.error('[smart-staffing] Ollama failed:', e.message);
    }

    const { rows: [report] } = await db.query(`
      INSERT INTO ladn.staff_analytics_reports
        (report_type, scope_from, scope_to, generated_by, model_used,
         deterministic_stats, narrative_summary, flagged_staff, raw_inputs_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id, generated_at
    `, [
      'smart_staffing', asOf, lookTo, req.user.id, modelUsed,
      JSON.stringify(stats), narrativeSummary, JSON.stringify([]), rawHash,
    ]);

    res.json({ id: report.id, generated_at: report.generated_at, narrative_null: !narrativeSummary });
  } catch (err) {
    console.error('[smart-staffing] run error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/staff-analytics/smart-staffing/latest ───────────────────────────

router.get('/smart-staffing/latest', requireRole('manager'), async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT id, report_type, scope_from, scope_to, generated_at, generated_by,
             model_used, deterministic_stats, narrative_summary, flagged_staff
      FROM ladn.staff_analytics_reports
      WHERE report_type = 'smart_staffing'
      ORDER BY generated_at DESC LIMIT 1
    `);
    if (!rows.length) return res.status(404).json({ error: 'No reports found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/staff-analytics/smart-staffing/:id ──────────────────────────────

router.get('/smart-staffing/:id', requireRole('manager'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { rows } = await getPool().query(`
      SELECT id, report_type, scope_from, scope_to, generated_at, generated_by,
             model_used, deterministic_stats, narrative_summary, flagged_staff
      FROM ladn.staff_analytics_reports
      WHERE id = $1 AND report_type = 'smart_staffing'
    `, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Report not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
