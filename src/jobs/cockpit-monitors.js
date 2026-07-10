// cockpit-monitors.js — scheduled "monitor bots" that feed the Management Cockpit.
//
// PURPOSE: the concrete, reliable half of "Hermes as main agent". These jobs run on a
// timer inside wren-ladn (NOT dependent on the Hermes agent config) and POST cards to the
// cockpit kanban (cockpit_cards) when a staff-HR signal crosses a threshold. The
// manager then actions the card from Roost. This is the same surface Hermes posts to, so the
// board is a single inbox for both human-tap and agent/automation findings.
//
// MONITORS:
//   1. Absence (Bradford Factor) — rolling-12m Bradford per active staff from hr_absences,
//      counting UNPLANNED absence (Sickness / Self-isolation), merging consecutive days into a
//      single spell (gaps-and-islands). Bradford = spells² × days. When a staff member crosses
//      BRADFORD_THRESHOLD and is not already carded, POST a 'This Week' card.
//   2. Supervision overdue — staff whose supervision is overdue (scheduled in the past, not
//      completed) OR whose next_supervision_date has passed. One card per overdue staff.
//
// IDEMPOTENCY: before posting, we read open cockpit cards and skip any staff already carded
// for the same monitor (matched by a stable tag `staff:<id>` + a monitor tag). Cards in the
// 'done' column are treated as resolved, so a recurrence re-cards (intended).
//
// AUTH: posts to the cockpit API over the in-cluster origin using the internal service token
// (X-Wren-Internal: WREN_INTERNAL_TOKEN) — the same machine-auth path Hermes uses. We hit the
// local origin (http://127.0.0.1:<PORT>) so no Cloudflare / nginx round-trip and no PII egress.
//
// SCHEDULE: startCockpitMonitors() runs once shortly after boot, then daily. Wired (append-only)
// in editions/ladn/server-unified.js alongside the other job starters.
//
// Append-only / additive: does not modify any route, table, or existing job.
'use strict';

const http = require('http');
const { getPool } = require('../db/pool');

const BRADFORD_THRESHOLD = parseInt(process.env.COCKPIT_BRADFORD_THRESHOLD || '200', 10);
const PORT = process.env.PORT || 3000;
const INTERNAL_TOKEN = process.env.WREN_INTERNAL_TOKEN || '';
// Unplanned absence types that count toward Bradford (planned leave is excluded).
const UNPLANNED_TYPES = ['Sickness', 'Self-isolation'];

// ── tiny internal HTTP helper — talks to our own cockpit API as the machine principal ──────────
function cockpitRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: '127.0.0.1', port: PORT, method, path,
      headers: {
        'Content-Type': 'application/json',
        'X-Wren-Internal': INTERNAL_TOKEN,
        ...(payload ? { 'Content-Length': payload.length } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
        else reject(new Error(`cockpit ${method} ${path} -> ${res.statusCode}: ${data.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Read the current board once; return the set of open cards (col != 'done') so monitors can
// dedupe against existing cards by tag.
async function openCards() {
  const board = await cockpitRequest('GET', '/api/cockpit/cards');
  const all = Array.isArray(board && board.cards) ? board.cards : [];
  return all.filter(c => c.col !== 'done');
}

// True if an open card already exists for this staff + monitor (matched on tags).
function alreadyCarded(open, staffId, monitorTag) {
  const staffTag = `staff:${staffId}`;
  return open.some(c => Array.isArray(c.tags) && c.tags.includes(staffTag) && c.tags.includes(monitorTag));
}

// ── MONITOR 1 — Bradford Factor ────────────────────────────────────────────────────────────────
async function runAbsenceMonitor(open) {
  const db = getPool();
  // Gaps-and-islands: merge consecutive/overlapping unplanned-absence rows into spells, then
  // Bradford = spells² × total_days, over a rolling 12 months, per active (non-terminated) staff.
  const { rows } = await db.query(`
    WITH sick AS (
      SELECT a.staff_id, a.start_date, COALESCE(a.end_date, a.start_date) AS end_date
      FROM hr_absences a
      JOIN staff s ON s.id = a.staff_id AND s.is_active AND NOT COALESCE(s.terminated, false)
      WHERE a.absence_type = ANY($1::text[])
        AND a.start_date >= CURRENT_DATE - INTERVAL '12 months'
    ),
    ordered AS (
      SELECT staff_id, start_date, end_date,
        CASE WHEN start_date <= LAG(end_date) OVER (PARTITION BY staff_id ORDER BY start_date) + 1
             THEN 0 ELSE 1 END AS new_spell
      FROM sick
    ),
    grp AS (
      SELECT staff_id, start_date, end_date,
        SUM(new_spell) OVER (PARTITION BY staff_id ORDER BY start_date ROWS UNBOUNDED PRECEDING) AS spell_id
      FROM ordered
    ),
    spells AS (
      SELECT staff_id, MIN(start_date) s, MAX(end_date) e,
             (MAX(end_date) - MIN(start_date) + 1) AS spell_days
      FROM grp GROUP BY staff_id, spell_id
    ),
    agg AS (
      SELECT staff_id, COUNT(*) AS spells, SUM(spell_days) AS days FROM spells GROUP BY staff_id
    )
    SELECT a.staff_id, a.spells, a.days, (a.spells * a.spells * a.days) AS bradford,
           s.first_name, s.last_name
    FROM agg a JOIN staff s ON s.id = a.staff_id
    WHERE (a.spells * a.spells * a.days) >= $2
    ORDER BY bradford DESC
  `, [UNPLANNED_TYPES, BRADFORD_THRESHOLD]);

  let posted = 0, skipped = 0;
  for (const r of rows) {
    if (alreadyCarded(open, r.staff_id, 'bradford')) { skipped++; continue; }
    const name = `${r.first_name} ${r.last_name}`.trim();
    await cockpitRequest('POST', '/api/cockpit/cards', {
      title: `${name} — Bradford ${r.bradford}, review absence pattern`,
      detail: `Rolling-12m Bradford Factor = ${r.bradford} (${r.spells} unplanned spells × ${r.days} days). `
            + `Threshold is ${BRADFORD_THRESHOLD}. Review the pattern and consider a return-to-work / `
            + `welfare conversation. (Auto-raised by the absence monitor — Bradford counts Sickness / `
            + `Self-isolation only; planned leave is excluded.)`,
      column: 'this_week',
      priority: r.bradford >= 500 ? 'high' : 'medium',
      source: 'auto',
      tags: ['hr', 'absence', 'bradford', `staff:${r.staff_id}`],
    });
    posted++;
  }
  return { posted, skipped, evaluated: rows.length };
}

// ── MONITOR 2 — Supervision overdue ─────────────────────────────────────────────────────────────
async function runSupervisionMonitor(open) {
  const db = getPool();
  // A staff member is "supervision overdue" if their most recent supervision record is either
  // scheduled in the past and not completed, or its next_supervision_date has passed. We pick the
  // single worst (oldest overdue date) signal per staff so we card each person at most once.
  const { rows } = await db.query(`
    WITH latest AS (
      SELECT DISTINCT ON (sup.staff_id)
             sup.staff_id,
             sup.status,
             sup.scheduled_date,
             sup.next_supervision_date,
             sup.conducted_date
      FROM supervisions sup
      JOIN staff s ON s.id = sup.staff_id AND s.is_active AND NOT COALESCE(s.terminated, false)
      ORDER BY sup.staff_id, COALESCE(sup.conducted_date, sup.scheduled_date) DESC NULLS LAST
    ),
    overdue AS (
      SELECT l.staff_id,
             CASE
               WHEN l.next_supervision_date IS NOT NULL AND l.next_supervision_date < CURRENT_DATE
                 THEN l.next_supervision_date
               WHEN l.scheduled_date IS NOT NULL AND l.scheduled_date < CURRENT_DATE
                    AND COALESCE(l.status,'') NOT IN ('completed','finalized','signed_off')
                 THEN l.scheduled_date
               ELSE NULL
             END AS overdue_since
      FROM latest l
    )
    SELECT o.staff_id, o.overdue_since,
           (CURRENT_DATE - o.overdue_since) AS days_overdue,
           s.first_name, s.last_name
    FROM overdue o JOIN staff s ON s.id = o.staff_id
    WHERE o.overdue_since IS NOT NULL
    ORDER BY o.overdue_since ASC
  `);

  let posted = 0, skipped = 0;
  for (const r of rows) {
    if (alreadyCarded(open, r.staff_id, 'supervision')) { skipped++; continue; }
    const name = `${r.first_name} ${r.last_name}`.trim();
    const since = r.overdue_since instanceof Date
      ? r.overdue_since.toISOString().slice(0, 10) : String(r.overdue_since).slice(0, 10);
    await cockpitRequest('POST', '/api/cockpit/cards', {
      title: `${name} — supervision overdue (${r.days_overdue}d)`,
      detail: `Supervision overdue since ${since} (${r.days_overdue} days). EYFS requires regular `
            + `supervision of staff. Schedule a 1:1 / supervision and record it. (Auto-raised by the `
            + `supervision monitor.)`,
      column: 'this_week',
      priority: Number(r.days_overdue) > 60 ? 'high' : 'medium',
      source: 'auto',
      tags: ['hr', 'supervision', `staff:${r.staff_id}`],
    });
    posted++;
  }
  return { posted, skipped, evaluated: rows.length };
}

// ── orchestrator ────────────────────────────────────────────────────────────────────────────────
async function runCockpitMonitors() {
  if (!INTERNAL_TOKEN) {
    console.error('[cockpit-monitors] WREN_INTERNAL_TOKEN unset — cannot authenticate to cockpit API; skipping');
    return;
  }
  let open;
  try {
    open = await openCards();
  } catch (e) {
    console.error('[cockpit-monitors] could not read existing cards (skipping run):', e.message);
    return;
  }

  try {
    const a = await runAbsenceMonitor(open);
    console.log(`[cockpit-monitors] absence/Bradford: ${a.posted} carded, ${a.skipped} already-carded, ${a.evaluated} over threshold`);
  } catch (e) {
    console.error('[cockpit-monitors] absence monitor failed:', e.message);
  }

  try {
    const s = await runSupervisionMonitor(open);
    console.log(`[cockpit-monitors] supervision: ${s.posted} carded, ${s.skipped} already-carded, ${s.evaluated} overdue`);
  } catch (e) {
    console.error('[cockpit-monitors] supervision monitor failed:', e.message);
  }
}

function startCockpitMonitors() {
  // Delay the first run a little so the HTTP server is fully listening before we call our own API.
  setTimeout(() => {
    runCockpitMonitors().catch(e => console.error('[cockpit-monitors] initial run:', e.message));
  }, 60 * 1000); // 60s after boot
  setInterval(() => {
    runCockpitMonitors().catch(e => console.error('[cockpit-monitors] interval:', e.message));
  }, 24 * 60 * 60 * 1000); // daily
  console.log('[cockpit-monitors] started (first run in 60s, then daily)');
}

module.exports = { startCockpitMonitors, runCockpitMonitors, runAbsenceMonitor, runSupervisionMonitor };

// Allow manual / task-runner invocation: `node src/jobs/cockpit-monitors.js`
if (require.main === module) {
  runCockpitMonitors()
    .then(() => { console.log('[cockpit-monitors] manual run complete'); process.exit(0); })
    .catch(e => { console.error('[cockpit-monitors] fatal:', e.message); process.exit(1); });
}
