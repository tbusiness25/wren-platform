'use strict';
// cockpit.js — the Management Cockpit API (Roost admin portal + Hermes agent surface).
//
// Powers the owner's "cockpit": a kanban task board, an at-a-glance nursery health panel,
// an upcoming-events timeline, and a SWOT note board — backed by a clean REST surface so the
// Hermes agent can programmatically add cards,
// read health, and post findings.
//
// AUTH — two ways in:
//   1. Human (Roost UI): JWT bearer, manager/deputy_manager/admin only (req.user.role).
//   2. Machine (Hermes / n8n / monitor bots): header  X-Wren-Internal: <WREN_INTERNAL_TOKEN>
//      (same internal-service pattern as finance-xero.js). Machine callers are treated as a
//      manager-equivalent service principal (req.machine = true, no req.user).
//
// Cards created by Hermes carry source='hermes'; absence/performance monitor bots POST with
// source='hermes' (or 'auto') and land in the kanban for the manager to action.
//
// DATA REUSE: the health panel and timeline reuse EXISTING tables (children/rooms, invoices,
// compliance_events, supervisions, mandatory_training, hr_absences, inspection_modes,
// funding_terms) — nothing is recomputed that Wren already exposes. Honest empty states where
// a metric has no data (e.g. DBS expiry is unpopulated → shown as 'no data', not fabricated).

const express = require('express');
const router  = express.Router();
const { getPool } = require('../db/pool');
const jwt = require('jsonwebtoken');
const fs   = require('fs');
const path = require('path');
const { logDecision } = require('../lib/decision-log');

// 2026-07-08: deputy_manager REMOVED — cockpit surfaces confidential owner emails / SWOT.
// Deputies (the deputy) get child-data + operational access elsewhere, not the cockpit. Manager/owner only.
const MGR_ROLES = ['manager', 'admin'];
const COLUMNS   = ['backlog', 'this_week', 'in_progress', 'done'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const SOURCES   = ['manual', 'hermes', 'auto'];

// ── Dual auth gate ────────────────────────────────────────────────────────────
// Accepts EITHER a manager JWT (human, Roost UI) OR the internal service token (machine: Hermes).
router.use((req, res, next) => {
  // Machine path — X-Wren-Internal token (Hermes / n8n / monitor bots)
  const internal = req.headers['x-wren-internal'] || '';
  if (internal && process.env.WREN_INTERNAL_TOKEN && internal === process.env.WREN_INTERNAL_TOKEN) {
    req.machine = true;
    req.user = { id: null, role: 'service', name: 'hermes-service' };
    return next();
  }
  // Human path — JWT bearer, must be a manager-class role
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-wren-token'] || '');
  if (!token) return res.status(401).json({ error: 'Unauthorised' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const expectedAud = req._portal || 'learning';
    if (!decoded.aud || decoded.aud !== expectedAud) {
      return res.status(401).json({ error: 'Invalid token audience' });
    }
    if (!MGR_ROLES.includes(decoded.role)) {
      return res.status(403).json({ error: 'Manager only' });
    }
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  KANBAN CARDS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/cockpit/cards  — full board (cards grouped by column) + the legacy `tasks` table
// surfaced read-only so the owner sees nursery tasks alongside cockpit cards.
router.get('/cards', async (req, res) => {
  try {
    const db = getPool();
    const { rows: cards } = await db.query(`
        SELECT c.id, c.title, c.detail, c.col, c.priority, c.due_date, c.source, c.estimated_minutes, c.needs_onsite, c.needs_prep, c.resources, c.hard_deadline, c.energy, c.context_tags,
             c.assignee, c.tags, c.position, c.created_by, c.created_at, c.updated_at,
             s.first_name || ' ' || s.last_name AS created_by_name
      FROM cockpit_cards c
      LEFT JOIN staff s ON s.id = c.created_by
      ORDER BY c.col, c.position, c.created_at
    `);

    // Surface the existing nursery `tasks` table (open/in-progress) read-only, so the owner has
    // a single board. These are tagged origin='task' and are NOT cockpit_cards (kept separate).
    let linkedTasks = [];
    try {
      const { rows } = await db.query(`
        SELECT t.id, t.title, t.description AS detail, t.status, t.priority, t.due_date,
               t.source, s.first_name || ' ' || s.last_name AS owner_name
        FROM tasks t LEFT JOIN staff s ON s.id = t.owner_staff_id
        WHERE t.status IN ('open','in_progress')
        ORDER BY t.due_date ASC NULLS LAST, t.priority DESC LIMIT 50
      `);
      linkedTasks = rows;
    } catch { /* tasks table optional */ }

    const board = { backlog: [], this_week: [], in_progress: [], done: [] };
    for (const c of cards) (board[c.col] || board.backlog).push(c);
    res.json({ board, cards, linked_tasks: linkedTasks, columns: COLUMNS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/cockpit/cards  — create a card. Hermes/monitor bots POST here.
// Body: { title*, detail, column|col, priority, due_date, source, assignee, tags[] }
router.post('/cards', async (req, res) => {
  const b = req.body || {};
  const title = (b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title required' });

  let col = (b.column || b.col || 'backlog');
  if (!COLUMNS.includes(col)) col = 'backlog';
  let priority = b.priority || 'medium';
  if (!PRIORITIES.includes(priority)) priority = 'medium';
  // Machine callers default to source='hermes'; humans default to 'manual'.
  let source = b.source || (req.machine ? 'hermes' : 'manual');
  if (!SOURCES.includes(source)) source = req.machine ? 'hermes' : 'manual';
  const tags = Array.isArray(b.tags) ? b.tags.map(String).slice(0, 12) : [];

  try {
    const db = getPool();
    const { rows: posRow } = await db.query(
      `SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM cockpit_cards WHERE col=$1`, [col]);
    const { rows } = await db.query(`
        INSERT INTO cockpit_cards (title, detail, col, priority, due_date, source, assignee, tags, position, estimated_minutes, needs_onsite, needs_prep, resources, hard_deadline, energy, context_tags, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *
    `,           [title, b.detail || null, col, priority, b.due_date || null, source,
        b.assignee || null, tags, posRow[0].pos, b.estimated_minutes || null, b.needs_onsite || null, b.needs_prep || null, b.resources || null, b.hard_deadline || null, b.energy || null, (b.context_tags||[]).map(String), req.machine ? null : req.user.id]);

    // Learning hook: machine-created cards are decisions worth logging (task_action category).
    if (req.machine || source !== 'manual') {
      try {
        await logDecision({
          category: 'task_action',
          inputContext: { kind: 'cockpit_card_create', source, column: col, priority },
          optionsPresented: [],
          decisionMade: { action: 'create_card', title: title.slice(0, 120) },
          decidedByAiModel: req.machine ? 'hermes' : null,
          decidedByStaffId: req.machine ? null : req.user.id,
          sourceTable: 'cockpit_cards',
          sourceId: rows[0].id,
        });
      } catch { /* logging best-effort */ }
    }

    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/cockpit/cards/:id  — update fields and/or move column.
// Body: any of { title, detail, column|col, priority, due_date, assignee, tags[], position }
router.patch('/cards/:id', async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = [];
  const push = (sql, v) => { vals.push(v); sets.push(`${sql}=$${vals.length}`); };

  if (b.title !== undefined)    push('title', String(b.title).trim());
  if (b.detail !== undefined)   push('detail', b.detail || null);
  const col = b.column || b.col;
  if (col !== undefined) {
    if (!COLUMNS.includes(col)) return res.status(400).json({ error: 'invalid column' });
    push('col', col);
  }
  if (b.priority !== undefined) {
    if (!PRIORITIES.includes(b.priority)) return res.status(400).json({ error: 'invalid priority' });
    push('priority', b.priority);
  }
  if (b.due_date !== undefined) push('due_date', b.due_date || null);
  if (b.assignee !== undefined) push('assignee', b.assignee || null);
  if (b.tags !== undefined)     push('tags', Array.isArray(b.tags) ? b.tags.map(String).slice(0, 12) : []);
  if (b.position !== undefined) push('position', parseInt(b.position, 10) || 0);
  // ADHD-kanban fields (prompt 76)
  if (b.estimated_minutes !== undefined) push('estimated_minutes', b.estimated_minutes);
  if (b.needs_onsite !== undefined) push('needs_onsite', b.needs_onsite);
  if (b.needs_prep !== undefined) push('needs_prep', b.needs_prep);
  if (b.resources !== undefined) push('resources', b.resources);
  if (b.hard_deadline !== undefined) push('hard_deadline', b.hard_deadline);
  if (b.energy !== undefined) push('energy', b.energy);
  if (b.context_tags !== undefined) push('context_tags', (Array.isArray(b.context_tags) ? b.context_tags.map(String) : []));

  if (!sets.length) return res.status(400).json({ error: 'no fields to update' });
  sets.push('updated_at=NOW()');
  vals.push(req.params.id);

  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE cockpit_cards SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/cockpit/cards/:id
router.delete('/cards/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rowCount } = await db.query(`DELETE FROM cockpit_cards WHERE id=$1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  HEALTH PANEL  — RAG-coloured tiles from REAL existing data only.
// ═══════════════════════════════════════════════════════════════════════════════
// Each tile: { key, label, value, detail, rag: 'green'|'amber'|'red'|'none', metric }
// rag='none' = honest empty state (no data to assess).

router.get('/health', async (req, res) => {
  const db = getPool();
  const today = new Date().toISOString().slice(0, 10);
  const tiles = [];
  const errors = [];

  // 1. Occupancy — active children vs total room capacity (children.is_active + rooms.capacity)
  try {
    const { rows } = await db.query(`
      SELECT r.id, r.name, r.capacity,
             (SELECT COUNT(*) FROM children c WHERE c.room_id=r.id AND c.is_active) AS occupied
      FROM rooms r ORDER BY r.id`);
    const totCap = rows.reduce((a, r) => a + (Number(r.capacity) || 0), 0);
    const totOcc = rows.reduce((a, r) => a + (Number(r.occupied) || 0), 0);
    const pct = totCap ? Math.round((totOcc / totCap) * 100) : 0;
    tiles.push({
      key: 'occupancy', label: 'Occupancy', metric: `${totOcc}/${totCap}`,
      value: `${pct}%`,
      detail: rows.map(r => `${r.name}: ${r.occupied}/${r.capacity}`).join(' · '),
      // Healthy nursery occupancy is high; very low is a business concern, over-capacity is a ratio risk.
      rag: !totCap ? 'none' : totOcc > totCap ? 'red' : pct >= 70 ? 'green' : pct >= 45 ? 'amber' : 'red',
      rooms: rows,
    });
  } catch (e) { errors.push('occupancy: ' + e.message); }

  // 2. Outstanding invoices — finance (invoices.status='overdue'/'sent')
  try {
    const { rows } = await db.query(`
      SELECT status, COUNT(*) n, COALESCE(SUM(amount_pence),0) pence
      FROM invoices WHERE status IN ('overdue','sent') GROUP BY status`);
    const overdue = rows.find(r => r.status === 'overdue') || { n: 0, pence: 0 };
    const sent    = rows.find(r => r.status === 'sent')    || { n: 0, pence: 0 };
    const outstandingPence = Number(overdue.pence) + Number(sent.pence);
    tiles.push({
      key: 'invoices', label: 'Outstanding invoices',
      metric: `${Number(overdue.n) + Number(sent.n)} unpaid`,
      value: '£' + (outstandingPence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 }),
      detail: `${overdue.n} overdue (£${(Number(overdue.pence) / 100).toLocaleString('en-GB')}) · ${sent.n} sent/awaiting`,
      rag: Number(overdue.n) > 0 ? 'red' : Number(sent.n) > 5 ? 'amber' : 'green',
    });
  } catch (e) { errors.push('invoices: ' + e.message); }

  // 3. Compliance deadlines — compliance_events.next_due within lead window
  try {
    const { rows } = await db.query(`
      SELECT title, category, next_due, lead_days,
             (next_due - CURRENT_DATE) AS days_away
      FROM compliance_events
      WHERE is_active AND next_due IS NOT NULL
      ORDER BY next_due`);
    const overdueC = rows.filter(r => Number(r.days_away) < 0);
    const dueSoon  = rows.filter(r => Number(r.days_away) >= 0 && Number(r.days_away) <= Number(r.lead_days));
    tiles.push({
      key: 'compliance', label: 'Compliance deadlines',
      metric: `${overdueC.length} overdue · ${dueSoon.length} due soon`,
      value: overdueC.length ? `${overdueC.length} overdue` : dueSoon.length ? `${dueSoon.length} soon` : 'Clear',
      detail: (overdueC[0] || dueSoon[0])
        ? (n => `Next: ${n.title} (${n.next_due instanceof Date ? n.next_due.toISOString().slice(0,10) : String(n.next_due).slice(0,10)})`)(overdueC[0] || dueSoon[0])
        : `${rows.length} tracked events, none in lead window`,
      rag: overdueC.length ? 'red' : dueSoon.length ? 'amber' : rows.length ? 'green' : 'none',
    });
  } catch (e) { errors.push('compliance: ' + e.message); }

  // 4. Supervisions — overdue (scheduled in the past but not completed) + due-soon next_supervision_date
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status NOT IN ('completed','finalized','signed_off')
                         AND scheduled_date IS NOT NULL AND scheduled_date < CURRENT_DATE) AS overdue,
        COUNT(*) FILTER (WHERE next_supervision_date IS NOT NULL
                         AND next_supervision_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30) AS due_soon,
        COUNT(*) AS total
      FROM supervisions`);
    const r = rows[0];
    tiles.push({
      key: 'supervisions', label: 'Supervisions',
      metric: `${r.overdue} overdue · ${r.due_soon} due ≤30d`,
      value: Number(r.overdue) > 0 ? `${r.overdue} overdue` : Number(r.due_soon) > 0 ? `${r.due_soon} due soon` : 'On track',
      detail: `${r.total} supervision records`,
      rag: Number(r.overdue) > 0 ? 'red' : Number(r.due_soon) > 0 ? 'amber' : 'green',
    });
  } catch (e) { errors.push('supervisions: ' + e.message); }

  // 5. Staffing — current absences (hr_absences spanning today)
  try {
    const { rows } = await db.query(`
      SELECT COUNT(DISTINCT staff_id) AS off_today
      FROM hr_absences
      WHERE start_date <= $1 AND (end_date IS NULL OR end_date >= $1)`, [today]);
    const { rows: tot } = await db.query(`SELECT COUNT(*) n FROM staff WHERE is_active`);
    const off = Number(rows[0].off_today || 0), total = Number(tot[0].n || 0);
    tiles.push({
      key: 'staffing', label: 'Staff absent today',
      metric: `${off}/${total} staff`,
      value: `${off} away`,
      detail: `${total} active staff`,
      rag: off === 0 ? 'green' : off <= 2 ? 'amber' : 'red',
    });
  } catch (e) { errors.push('staffing: ' + e.message); }

  // 6. Mandatory training expiry (mandatory_training.expiry_date)
  try {
    const { rows } = await db.query(`
      SELECT COUNT(*) FILTER (WHERE expiry_date < CURRENT_DATE) AS expired,
             COUNT(*) FILTER (WHERE expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 60) AS soon,
             COUNT(*) AS total
      FROM mandatory_training WHERE expiry_date IS NOT NULL`);
    const r = rows[0];
    tiles.push({
      key: 'training', label: 'Mandatory training',
      metric: `${r.expired} expired · ${r.soon} ≤60d`,
      value: Number(r.expired) > 0 ? `${r.expired} expired` : Number(r.soon) > 0 ? `${r.soon} expiring` : 'Current',
      detail: `${r.total} training records with expiry`,
      rag: Number(r.total) === 0 ? 'none' : Number(r.expired) > 0 ? 'red' : Number(r.soon) > 0 ? 'amber' : 'green',
    });
  } catch (e) { errors.push('training: ' + e.message); }

  // 7. DBS expiry (staff.dbs_expiry) — likely unpopulated → honest empty state
  try {
    const { rows } = await db.query(`
      SELECT COUNT(*) FILTER (WHERE dbs_expiry IS NOT NULL) AS have_dbs,
             COUNT(*) FILTER (WHERE dbs_expiry < CURRENT_DATE) AS expired,
             COUNT(*) FILTER (WHERE dbs_expiry BETWEEN CURRENT_DATE AND CURRENT_DATE + 90) AS soon
      FROM staff WHERE is_active`);
    const r = rows[0];
    if (Number(r.have_dbs) === 0) {
      tiles.push({ key: 'dbs', label: 'DBS expiry', metric: 'no data', value: '—',
        detail: 'No DBS expiry dates recorded yet', rag: 'none' });
    } else {
      tiles.push({
        key: 'dbs', label: 'DBS expiry', metric: `${r.have_dbs} on record`,
        value: Number(r.expired) > 0 ? `${r.expired} expired` : Number(r.soon) > 0 ? `${r.soon} ≤90d` : 'Current',
        detail: `${r.have_dbs} staff with DBS expiry recorded`,
        rag: Number(r.expired) > 0 ? 'red' : Number(r.soon) > 0 ? 'amber' : 'green',
      });
    }
  } catch (e) { errors.push('dbs: ' + e.message); }

  // 8. Open cockpit cards (workload signal)
  try {
    const { rows } = await db.query(`
      SELECT COUNT(*) FILTER (WHERE col <> 'done') AS open,
             COUNT(*) FILTER (WHERE col <> 'done' AND due_date < CURRENT_DATE) AS overdue,
             COUNT(*) FILTER (WHERE source='hermes') AS from_hermes
      FROM cockpit_cards`);
    const r = rows[0];
    tiles.push({
      key: 'cards', label: 'Cockpit tasks',
      metric: `${r.open} open`,
      value: Number(r.overdue) > 0 ? `${r.overdue} overdue` : `${r.open} open`,
      detail: `${r.from_hermes} raised by Hermes`,
      rag: Number(r.overdue) > 0 ? 'amber' : 'green',
    });
  } catch (e) { errors.push('cards: ' + e.message); }

  res.json({ generated_at: new Date().toISOString(), tiles, errors });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  TIMELINE  — upcoming dated items from existing tables.
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/timeline', async (req, res) => {
  const db = getPool();
  const horizon = Math.min(parseInt(req.query.days, 10) || 120, 365);
  const items = [];
  const errors = [];

  // Compliance / statutory deadlines
  try {
    const { rows } = await db.query(`
      SELECT title, category, next_due AS date FROM compliance_events
      WHERE is_active AND next_due IS NOT NULL
        AND next_due BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE + $1::int
      ORDER BY next_due`, [horizon]);
    for (const r of rows) items.push({ date: r.date, type: 'compliance', category: r.category, title: r.title });
  } catch (e) { errors.push('compliance: ' + e.message); }

  // Supervisions due (next_supervision_date or future scheduled_date)
  try {
    const { rows } = await db.query(`
      SELECT COALESCE(next_supervision_date, scheduled_date) AS date,
             s.first_name || ' ' || s.last_name AS staff_name
      FROM supervisions sup
      LEFT JOIN staff s ON s.id = sup.staff_id
      WHERE COALESCE(next_supervision_date, scheduled_date)
            BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int
      ORDER BY 1`, [horizon]);
    for (const r of rows) items.push({ date: r.date, type: 'supervision',
      title: `Supervision due — ${r.staff_name || 'staff'}` });
  } catch (e) { errors.push('supervisions: ' + e.message); }

  // Mandatory training expiries
  try {
    const { rows } = await db.query(`
      SELECT mt.expiry_date AS date, mt.training_type,
             s.first_name || ' ' || s.last_name AS staff_name
      FROM mandatory_training mt
      LEFT JOIN staff s ON s.id = mt.staff_id
      WHERE mt.expiry_date BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE + $1::int
      ORDER BY mt.expiry_date`, [horizon]);
    for (const r of rows) items.push({ date: r.date, type: 'training',
      title: `${r.training_type} renewal — ${r.staff_name || 'staff'}` });
  } catch (e) { errors.push('training: ' + e.message); }

  // Funding term boundaries
  try {
    const { rows } = await db.query(`
      SELECT name, start_date, end_date, funding_eligible_date FROM funding_terms
      WHERE end_date >= CURRENT_DATE - 30 OR start_date >= CURRENT_DATE`);
    for (const r of rows) {
      if (r.start_date) items.push({ date: r.start_date, type: 'term', title: `${r.name} starts` });
      if (r.end_date)   items.push({ date: r.end_date, type: 'term', title: `${r.name} ends` });
    }
  } catch (e) { errors.push('funding_terms: ' + e.message); }

  // Active inspection windows (if any)
  try {
    const { rows } = await db.query(`
      SELECT type, expected_arrival, inspector_org, status FROM inspection_modes
      WHERE status IS NULL OR status NOT IN ('closed')
      ORDER BY expected_arrival NULLS LAST`);
    for (const r of rows) items.push({
      date: r.expected_arrival ? r.expected_arrival.toISOString().slice(0, 10) : null,
      type: 'inspection', title: `Inspection (${r.type || 'Ofsted'}) — ${r.status || 'active'}` });
  } catch (e) { errors.push('inspection_modes: ' + e.message); }

  // Cockpit cards with due dates
  try {
    const { rows } = await db.query(`
      SELECT title, due_date, priority, source FROM cockpit_cards
      WHERE due_date IS NOT NULL AND col <> 'done'
        AND due_date BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE + $1::int`, [horizon]);
    for (const r of rows) items.push({ date: r.due_date, type: 'task',
      title: r.title, priority: r.priority, source: r.source });
  } catch (e) { errors.push('cards: ' + e.message); }

  // Sort by date, push undated to the end
  const norm = d => (d instanceof Date ? d.toISOString().slice(0, 10) : (d ? String(d).slice(0, 10) : null));
  items.forEach(i => { i.date = norm(i.date); });
  items.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));

  res.json({ generated_at: new Date().toISOString(), horizon_days: horizon, items, errors });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  SWOT  — manager/owner note board.
// ═══════════════════════════════════════════════════════════════════════════════

const QUADRANTS = ['strengths', 'weaknesses', 'opportunities', 'threats'];

router.get('/swot', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT quadrant, items, updated_at FROM cockpit_swot ORDER BY quadrant`);
    const out = {};
    for (const q of QUADRANTS) out[q] = { items: [], updated_at: null };
    for (const r of rows) out[r.quadrant] = { items: Array.isArray(r.items) ? r.items : [], updated_at: r.updated_at };
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/cockpit/swot  — replace a quadrant's items.  Body: { quadrant, items: [string] }
router.post('/swot', async (req, res) => {
  const b = req.body || {};
  if (!QUADRANTS.includes(b.quadrant)) return res.status(400).json({ error: 'invalid quadrant' });
  const items = Array.isArray(b.items) ? b.items.map(s => String(s)).filter(s => s.trim()).slice(0, 50) : [];
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO cockpit_swot (quadrant, items, updated_by, updated_at)
      VALUES ($1, $2::jsonb, $3, NOW())
      ON CONFLICT (quadrant) DO UPDATE SET items=EXCLUDED.items, updated_by=EXCLUDED.updated_by, updated_at=NOW()
      RETURNING quadrant, items, updated_at
    `, [b.quadrant, JSON.stringify(items), req.machine ? null : req.user.id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  COMMS — "what needs my attention" (calls + emails + open to-dos, last N days)
// ═══════════════════════════════════════════════════════════════════════════════
// Reuses existing tables (vapi_calls, comms_email_queue, cockpit_cards, tasks). Server-side
// time window via ?days=N (default 2). Degrades gracefully per-source (try/catch each query),
// so a sparse email queue (Gmail readonly pull not yet live) just yields an empty list.

router.get('/comms', async (req, res) => {
  const db = getPool();
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 2, 1), 30);
  const out = { window_days: days, generated_at: new Date().toISOString(),
                calls: [], emails: [], todos: [], counts: {}, errors: [] };

  // Recent calls (Aria / Vapi) within the window — newest first.
  // Noise (clean transfers / silent / abandoned calls) is auto-classified
  // action_status='no_action_needed' at ingest; the cockpit only shows calls
  // carrying real information. ?all=1 restores the unfiltered list. 2026-07-08.
  try {
    const { rows } = await db.query(`
      SELECT id, started_at, duration_seconds, from_number, summary, urgency,
             outcome, reviewed_at, action_status
      FROM vapi_calls
      WHERE started_at > NOW() - make_interval(days => $1::int)
        ${req.query.all ? '' : `AND (action_status IS NULL OR action_status NOT IN ('no_action_needed','archived'))`}
      ORDER BY started_at DESC LIMIT 50`, [days]);
    out.calls = rows;
  } catch (e) { out.errors.push('calls: ' + e.message); }

  // Recent inbound emails within the window (with the AI-suggested action).
  try {
    const { rows } = await db.query(`
      SELECT id, received_at, from_email, from_name, subject, summary,
             suggested_action, importance, category, status, direction
      FROM comms_email_queue
      WHERE received_at > NOW() - make_interval(days => $1::int)
        AND (direction = 'in' OR direction IS NULL)
      ORDER BY importance DESC NULLS LAST, received_at DESC LIMIT 50`, [days]);
    out.emails = rows;
  } catch (e) { out.errors.push('emails: ' + e.message); }

  // Open to-dos — cockpit cards not done + open nursery tasks (read-only).
  try {
    const { rows } = await db.query(`
      SELECT id, title, detail, col, priority, due_date, source, 'card'::text AS kind
      FROM cockpit_cards WHERE col <> 'done'
      ORDER BY (due_date IS NULL), due_date, position LIMIT 30`);
    out.todos = rows;
  } catch (e) { out.errors.push('cards: ' + e.message); }
  try {
    const { rows } = await db.query(`
      SELECT id, title, description AS detail, status AS col, priority, due_date,
             source, 'task'::text AS kind
      FROM tasks WHERE status IN ('open','in_progress')
      ORDER BY (due_date IS NULL), due_date ASC LIMIT 30`);
    out.todos = out.todos.concat(rows);
  } catch (e) { out.errors.push('tasks: ' + e.message); }

  out.counts = { calls: out.calls.length, emails: out.emails.length, todos: out.todos.length };
  res.json(out);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  MIND-MAP NOTES — Obsidian-compatible markdown vault (Toby's thinking space)
// ═══════════════════════════════════════════════════════════════════════════════
// Notes are plain .md files in OBSIDIAN_VAULT_DIR (default /app/data/obsidian-vault/wren →
// host /app/data/ladn/obsidian-vault/wren via the prod rw bind mount). [[wikilinks]]
// are preserved verbatim, so pointing/symlinking a real Obsidian vault at that path gives a
// two-way filesystem sync. Manager-only (inherits the router's auth gate above).

const NOTES_DIR = process.env.OBSIDIAN_VAULT_DIR || '/app/data/obsidian-vault/wren';
// The container runs as root, but the vault is shared with Toby's host-side Obsidian (uid 1000)
// via the data bind mount, so make the dir + files world-writable for genuine two-way sync on
// this single-user box. Best-effort (ignore EPERM etc.).
function _ensureVault() {
  try { fs.mkdirSync(NOTES_DIR, { recursive: true }); } catch (e) { /* best-effort */ }
  try { fs.chmodSync(NOTES_DIR, 0o777); } catch (e) { /* best-effort */ }
}
// Obsidian note name → safe .md basename (strips path separators / traversal / control chars).
function _safeName(name) {
  let n = String(name == null ? '' : name).trim().replace(/\.md$/i, '');
  n = n.replace(/[\/\\]/g, '-').replace(/\.{2,}/g, '.').replace(/[\x00-\x1f]/g, '').trim();
  return n.slice(0, 120);
}
// Resolve a safe name to an absolute path that must live inside the vault dir.
function _noteFile(name) {
  const safe = _safeName(name);
  if (!safe) return null;
  const file = path.resolve(NOTES_DIR, safe + '.md');
  const root = path.resolve(NOTES_DIR);
  if (file !== path.join(root, safe + '.md')) return null;       // basename only
  if (!file.startsWith(root + path.sep)) return null;            // inside vault
  return { safe, file };
}
function _titleOf(content, fallback) {
  const m = String(content || '').match(/^#\s+(.+)$/m);
  return (m && m[1].trim()) || fallback;
}
function _linksOf(content) {
  const out = []; const re = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g; let m;
  while ((m = re.exec(String(content || '')))) { const t = m[1].trim(); if (t) out.push(t); }
  return Array.from(new Set(out));
}

// GET /api/cockpit/notes            — list all notes (name, title, content, links, updated_at)
// GET /api/cockpit/notes?name=Foo   — read a single note
router.get('/notes', (req, res) => {
  _ensureVault();
  if (req.query.name) {
    const ref = _noteFile(req.query.name);
    if (!ref) return res.status(400).json({ error: 'bad name' });
    try {
      const content = fs.readFileSync(ref.file, 'utf8');
      const stat = fs.statSync(ref.file);
      return res.json({ name: ref.safe, title: _titleOf(content, ref.safe),
                        content, links: _linksOf(content), updated_at: stat.mtime });
    } catch { return res.status(404).json({ error: 'Not found' }); }
  }
  try {
    const files = fs.readdirSync(NOTES_DIR).filter(f => f.toLowerCase().endsWith('.md'));
    const notes = files.map(f => {
      const full = path.join(NOTES_DIR, f);
      let content = '', mtime = null;
      try { content = fs.readFileSync(full, 'utf8'); mtime = fs.statSync(full).mtime; } catch {}
      const name = f.replace(/\.md$/i, '');
      return { name, title: _titleOf(content, name), content, links: _linksOf(content), updated_at: mtime };
    }).sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
    res.json({ vault: NOTES_DIR, count: notes.length, notes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/cockpit/notes — create or update a note. Body: { name|title, content }
router.post('/notes', (req, res) => {
  _ensureVault();
  const b = req.body || {};
  const ref = _noteFile(b.name || b.title || '');
  if (!ref) return res.status(400).json({ error: 'name or title required' });
  let content = b.content;
  if (content == null) content = `# ${(b.title || ref.safe)}\n\n`;
  try {
    fs.writeFileSync(ref.file, String(content), 'utf8');
    try { fs.chmodSync(ref.file, 0o666); } catch (e) { /* best-effort, so host-side Obsidian can edit too */ }
    const stat = fs.statSync(ref.file);
    res.status(201).json({ name: ref.safe, title: _titleOf(content, ref.safe),
                           content: String(content), links: _linksOf(content), updated_at: stat.mtime });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/cockpit/notes?name=Foo
router.delete('/notes', (req, res) => {
  const ref = _noteFile(req.query.name || '');
  if (!ref) return res.status(400).json({ error: 'name required' });
  try { fs.unlinkSync(ref.file); res.json({ ok: true }); }
  catch { res.status(404).json({ error: 'Not found' }); }
});

module.exports = router;
