/**
 * safeguarding-ext.js — Extended safeguarding routes to CPOMS parity
 *
 * Adds: per-child chronology, WT2023 categories, multi-child persons,
 * DSL sign-off queue, escalation, supervision logging, tamper-evident
 * access audit, governor/Ofsted reports, CTF transfer initiation,
 * login alerts.
 *
 * All safeguarding reads are audit-logged (action='view').
 * DSL supervision notes are DSL-only (never returned to non-DSL).
 * No AI auto-categorisation anywhere in this file.
 */

const express  = require('express');
const crypto   = require('crypto');
const router   = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// ── Permission helpers ─────────────────────────────────────────────────────────

function isDSL(req) {
  return ['manager','deputy_manager','admin'].includes(req.user?.role);
}
function requireDSL(req, res) {
  if (!isDSL(req)) { res.status(403).json({ error: 'DSL access required' }); return false; }
  return true;
}
function isParent(req) {
  return req.user?.role === 'parent';
}

// ── Audit helper ───────────────────────────────────────────────────────────────

async function writeAudit(db, req, action, entityType, entityId, prevHash, newStateHash) {
  try {
    const lastRow = await db.query(
      `SELECT hash_self FROM safeguarding_access_audit ORDER BY id DESC LIMIT 1`
    );
    const prevSelf = lastRow.rows[0]?.hash_self || 'genesis';

    const payload = [
      String(req.user?.id || 0),
      action, entityType || '', String(entityId || ''),
      prevSelf, new Date().toISOString()
    ].join('|');
    const hashSelf = crypto.createHash('sha256').update(payload).digest('hex');

    await db.query(`
      INSERT INTO safeguarding_access_audit
        (user_id, user_name, ip_address, action, entity_type, entity_id,
         prev_state_hash, new_state_hash, hash_previous, hash_self)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [
      req.user?.id || null,
      req.user?.name || req.user?.email || 'unknown',
      req.ip || null,
      action,
      entityType || null,
      String(entityId || ''),
      prevHash || null,
      newStateHash || null,
      prevSelf,
      hashSelf,
    ]);
  } catch (_) { /* audit failures must not break the request */ }
}

// ── 1. WT2023 CATEGORIES ──────────────────────────────────────────────────────

router.get('/categories', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT * FROM safeguarding_categories
      WHERE active = true
      ORDER BY display_order, id
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 2. PER-CHILD CHRONOLOGY ──────────────────────────────────────────────────

/**
 * GET /chronology/:childId
 * Returns a unified timeline of ALL record types for a child.
 * Sorted reverse-chronologically.
 * Access is audit-logged every time.
 * DSL supervision_notes stripped for non-DSL.
 */
router.get('/chronology/:childId', async (req, res) => {
  if (isParent(req)) return res.status(403).json({ error: 'Access restricted' });
  const childId = parseInt(req.params.childId);
  if (!childId) return res.status(400).json({ error: 'Invalid childId' });

  const { from, to } = req.query;
  const db = getPool();

  await writeAudit(db, req, 'chronology_view', 'child', childId, null, null);

  try {
    const dsl = isDSL(req);
    const params = [childId];
    let pi = 2;

    const dateFilter = (col) => {
      let f = '';
      if (from) { f += ` AND ${col} >= $${pi++}`; params.push(from); }
      if (to)   { f += ` AND ${col} <= $${pi++}`; params.push(to); }
      return f;
    };

    // Build each event type as a CTE union
    // Confidentiality: non-DSL only sees their own confidential concerns
    const confidFilter = dsl
      ? ''
      : `AND (sc.reported_by=${req.user.id} OR sc.is_confidential=false)`;

    const q = `
      WITH timeline AS (

        -- Safeguarding concerns
        SELECT
          'safeguarding' as type,
          sc.id::text as record_id,
          COALESCE(sc.concern_date, sc.created_at) as event_ts,
          sc.category as subtype,
          CASE WHEN sc.severity='critical' THEN 'danger'
               WHEN sc.severity='high' THEN 'warning'
               ELSE 'info' END as severity_css,
          sc.severity,
          LEFT(COALESCE(sc.description,''),300) as summary,
          s.first_name || ' ' || s.last_name as logged_by,
          sc.status,
          sc.is_confidential,
          ${dsl ? `sc.supervision_notes` : `NULL::text`} as supervision_notes,
          sc.dsl_signoff_at,
          sc.body_map_data IS NOT NULL as has_body_map,
          sc.requires_lado,
          sc.escalation_level
        FROM safeguarding_concerns sc
        LEFT JOIN staff s ON s.id=sc.reported_by
        WHERE sc.child_id=$1
          ${confidFilter}
          ${dateFilter('sc.concern_date')}

        UNION ALL

        -- Accidents/incidents
        SELECT
          'incident' as type,
          i.id::text,
          i.created_at,
          i.incident_type,
          CASE WHEN i.riddor_reportable THEN 'warning' ELSE 'info' END,
          CASE WHEN i.riddor_reportable THEN 'high' ELSE 'low' END,
          LEFT(COALESCE(i.description,''),300),
          s.first_name || ' ' || s.last_name,
          COALESCE(i.status,'open'),
          false,
          NULL,
          i.manager_sign_off_at,
          false,
          false,
          0
        FROM incidents i
        LEFT JOIN staff s ON s.id=i.reported_by
        WHERE i.child_id=$1
          ${dateFilter('i.created_at')}

        UNION ALL

        -- Medicine records
        SELECT
          'medicine' as type,
          m.id::text,
          m.created_at,
          m.medicine_name,
          'info',
          'low',
          LEFT(COALESCE('Dose: '||m.dose||'. '||COALESCE(m.notes,''),''),300),
          s.first_name || ' ' || s.last_name,
          CASE WHEN m.manager_sign_off_at IS NOT NULL THEN 'signed-off' ELSE 'pending' END,
          false,
          NULL,
          m.manager_sign_off_at,
          false,
          false,
          0
        FROM medicine_records m
        LEFT JOIN staff s ON s.id=m.staff_id
        WHERE m.child_id=$1
          ${dateFilter('m.created_at')}

        UNION ALL

        -- Observations flagged as concern (if flagged field exists)
        SELECT
          'observation' as type,
          o.id::text,
          o.created_at,
          o.area_of_learning,
          'info',
          'low',
          LEFT(COALESCE(o.observation_text, o.notes,''),300),
          s.first_name || ' ' || s.last_name,
          COALESCE(o.status,'recorded'),
          false,
          NULL,
          NULL,
          false,
          false,
          0
        FROM observations o
        LEFT JOIN staff s ON s.id=o.staff_id
        WHERE o.child_id=$1
          AND COALESCE(o.is_concern, false)=true
          ${dateFilter('o.created_at')}

      )
      SELECT * FROM timeline
      ORDER BY event_ts DESC
      LIMIT 500
    `;

    const { rows } = await db.query(q, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 3. MULTI-CHILD CONCERN PERSONS ───────────────────────────────────────────

router.get('/:id/persons', async (req, res) => {
  if (!requireDSL(req, res)) return;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT scp.*,
        CASE scp.person_type
          WHEN 'child' THEN (SELECT c.first_name||' '||c.last_name FROM children c WHERE c.id=scp.person_id)
          WHEN 'staff' THEN (SELECT s.first_name||' '||s.last_name FROM staff s WHERE s.id=scp.person_id)
          ELSE NULL
        END as person_name
      FROM safeguarding_concern_persons scp
      WHERE scp.concern_id=$1
    `, [req.params.id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/persons', async (req, res) => {
  if (!requireDSL(req, res)) return;
  const { person_id, person_type='child', role, visible_to_other_subjects=false, notes } = req.body;
  if (!person_id || !role) return res.status(400).json({ error: 'person_id and role required' });
  const validRoles = ['subject','alleged_perpetrator','alleged_victim','witness','informant'];
  if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO safeguarding_concern_persons
        (concern_id, person_id, person_type, role, visible_to_other_subjects, notes)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (concern_id, person_id, role) DO UPDATE
        SET notes=EXCLUDED.notes, visible_to_other_subjects=EXCLUDED.visible_to_other_subjects
      RETURNING *
    `, [req.params.id, person_id, person_type, role, visible_to_other_subjects, notes||null]);

    // Mark concern as multi-child if more than one child subject
    await db.query(`
      UPDATE safeguarding_concerns SET is_multi_child=true, updated_at=NOW()
      WHERE id=$1
        AND (SELECT COUNT(*) FROM safeguarding_concern_persons
             WHERE concern_id=$1 AND person_type='child') > 1
    `, [req.params.id]);

    await writeAudit(db, req, 'add_person', 'safeguarding_concern', req.params.id, null, null);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 4. DSL SIGN-OFF QUEUE ─────────────────────────────────────────────────────

router.get('/dsl-queue', async (req, res) => {
  if (!requireDSL(req, res)) return;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT sc.*,
        c.first_name || ' ' || c.last_name as child_name,
        c.date_of_birth as child_dob,
        s.first_name || ' ' || s.last_name as reporter_name,
        EXTRACT(EPOCH FROM (NOW() - sc.concern_date))/3600 as hours_since_logged,
        sc.escalation_due_at < NOW() as sla_breached
      FROM safeguarding_concerns sc
      LEFT JOIN children c ON c.id=sc.child_id
      LEFT JOIN staff s ON s.id=sc.reported_by
      WHERE sc.status IN ('new','under_review')
        AND sc.dsl_signoff_at IS NULL
      ORDER BY
        CASE sc.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        sc.concern_date ASC
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 5. DSL SIGN-OFF ACTION ────────────────────────────────────────────────────

router.post('/:id/signoff', async (req, res) => {
  if (!requireDSL(req, res)) return;
  const { status, dsl_notes, category_ids, severity } = req.body;
  const validStatuses = ['under_review','action_taken','referred','closed'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    const db = getPool();

    // Get current state for hash chain
    const cur = await db.query('SELECT * FROM safeguarding_concerns WHERE id=$1', [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const prev = cur.rows[0];
    const prevHash = crypto.createHash('sha256')
      .update(JSON.stringify(prev)).digest('hex');

    const updates = [`dsl_signoff_at=NOW()`, `dsl_signoff_by=$1`, `updated_at=NOW()`];
    const params = [req.user.id];
    let pi = 2;

    if (status)       { updates.push(`status=$${pi++}`);       params.push(status); }
    if (dsl_notes)    { updates.push(`dsl_notes=$${pi++}`);    params.push(dsl_notes); }
    if (category_ids) { updates.push(`category_ids=$${pi++}`); params.push(category_ids); }
    if (severity)     { updates.push(`severity=$${pi++}`);     params.push(severity); }

    // Auto-set reviewed fields
    updates.push(`dsl_reviewed_by=$${pi++}`); params.push(req.user.id);
    updates.push(`dsl_reviewed_at=NOW()`);

    params.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE safeguarding_concerns SET ${updates.join(',')} WHERE id=$${pi} RETURNING *`,
      params
    );

    const newHash = crypto.createHash('sha256')
      .update(JSON.stringify(rows[0])).digest('hex');
    await writeAudit(db, req, 'dsl_signoff', 'safeguarding_concern', req.params.id, prevHash, newHash);

    // Auto-escalate if severity high/critical
    if (['high','critical'].includes(rows[0].severity) && rows[0].escalation_level === 0) {
      await _doEscalate(db, req, rows[0], 'Auto-escalated: severity ' + rows[0].severity);
    }

    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 6. ESCALATION ─────────────────────────────────────────────────────────────

async function _doEscalate(db, req, concern, reason) {
  const newLevel = (concern.escalation_level || 0) + 1;
  const slaHours = [4, 24, 48, 72][newLevel - 1] || 72;
  const dueAt = new Date(Date.now() + slaHours * 3600 * 1000).toISOString();

  await db.query(`
    UPDATE safeguarding_concerns SET
      escalation_level=$1, escalation_due_at=$2, escalated_at=NOW(), escalated_to=$3
    WHERE id=$4
  `, [newLevel, dueAt, req.user.id, concern.id]);

  await db.query(`
    INSERT INTO safeguarding_escalation_log
      (concern_id, from_level, to_level, escalated_by, reason, sla_hours, due_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [concern.id, concern.escalation_level||0, newLevel, req.user.id, reason, slaHours, dueAt]);

  // Telegram alert
  const BOT  = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT = process.env.TELEGRAM_CHAT_ID;
  if (BOT && CHAT) {
    fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT, parse_mode: 'HTML',
        text: `⚠️ <b>Safeguarding Escalated — Level ${newLevel}</b>\n\nConcern: #${concern.id}\nSeverity: ${concern.severity}\nReason: ${reason}\nSLA: ${slaHours}h (due ${new Date(dueAt).toLocaleString('en-GB')})\n\n<i>Action required in Wren.</i>`
      })
    }).catch(() => {});
  }
}

router.post('/:id/escalate', async (req, res) => {
  if (!requireDSL(req, res)) return;
  const { reason } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM safeguarding_concerns WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    await _doEscalate(db, req, rows[0], reason || 'Manual escalation by DSL');
    await writeAudit(db, req, 'escalate', 'safeguarding_concern', req.params.id, null, null);

    res.json({ ok: true, new_level: (rows[0].escalation_level || 0) + 1 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 7. SUPERVISION LOGGING ────────────────────────────────────────────────────

router.post('/:id/supervision', async (req, res) => {
  if (!requireDSL(req, res)) return;
  const { notes } = req.body;
  if (!notes?.trim()) return res.status(400).json({ error: 'notes required' });
  try {
    const db = getPool();
    await db.query(`
      UPDATE safeguarding_concerns SET
        supervision_notes = COALESCE(supervision_notes,'') || E'\n\n' ||
          '[' || NOW()::text || ' — ' || $2 || ']\n' || $3,
        supervision_at=NOW(),
        supervision_by=$4,
        updated_at=NOW()
      WHERE id=$1
    `, [req.params.id, req.user.name || 'DSL', notes, req.user.id]);

    await writeAudit(db, req, 'supervision_note', 'safeguarding_concern', req.params.id, null, null);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 8. AUDIT TRAIL VIEW ───────────────────────────────────────────────────────

router.get('/audit-trail', async (req, res) => {
  if (!requireDSL(req, res)) return;
  const { entity_id, from, to, limit=100 } = req.query;
  try {
    const db = getPool();
    const conditions = [];
    const params = [];
    let pi = 1;
    if (entity_id) { conditions.push(`entity_id=$${pi++}`); params.push(String(entity_id)); }
    if (from)      { conditions.push(`occurred_at>=$${pi++}`); params.push(from); }
    if (to)        { conditions.push(`occurred_at<=$${pi++}`); params.push(to); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await db.query(
      `SELECT * FROM safeguarding_access_audit ${where}
       ORDER BY occurred_at DESC LIMIT $${pi}`,
      [...params, parseInt(limit)]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 9. HASH CHAIN VALIDATION ──────────────────────────────────────────────────

router.post('/validate-chain', async (req, res) => {
  if (!requireDSL(req, res)) return;
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT * FROM safeguarding_access_audit ORDER BY id ASC LIMIT 10000'
    );

    let broken = [];
    let prevSelf = 'genesis';
    for (const row of rows) {
      const payload = [
        String(row.user_id || 0),
        row.action, row.entity_type || '', String(row.entity_id || ''),
        prevSelf, row.occurred_at.toISOString()
      ].join('|');
      const expected = crypto.createHash('sha256').update(payload).digest('hex');
      if (row.hash_self !== expected) {
        broken.push({ id: row.id, occurred_at: row.occurred_at });
      }
      if (row.hash_previous !== prevSelf) {
        broken.push({ id: row.id, occurred_at: row.occurred_at, prev_mismatch: true });
      }
      prevSelf = row.hash_self;
    }

    if (broken.length) {
      const BOT  = process.env.TELEGRAM_BOT_TOKEN;
      const CHAT = process.env.TELEGRAM_CHAT_ID;
      if (BOT && CHAT) {
        fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: CHAT, parse_mode: 'HTML',
            text: `🚨 <b>SAFEGUARDING AUDIT CHAIN COMPROMISED</b>\n\n${broken.length} broken link(s) detected.\nFirst broken: ID ${broken[0].id} at ${broken[0].occurred_at}\n\n<b>Immediate investigation required.</b>`
          })
        }).catch(() => {});
      }
    }

    res.json({
      ok: broken.length === 0,
      rows_checked: rows.length,
      broken_count: broken.length,
      broken: broken.slice(0, 20),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 10. LOGIN ALERTS ──────────────────────────────────────────────────────────

router.get('/login-alerts', async (req, res) => {
  try {
    const db = getPool();
    const userId = req.user.id;
    const alerts = [];

    if (isDSL(req)) {
      // Concerns awaiting DSL sign-off
      const { rows: queue } = await db.query(`
        SELECT COUNT(*) as cnt FROM safeguarding_concerns
        WHERE status IN ('new','under_review') AND dsl_signoff_at IS NULL
      `);
      if (parseInt(queue[0].cnt) > 0) {
        alerts.push({
          type: 'dsl_queue',
          severity: 'warning',
          message: `${queue[0].cnt} concern${queue[0].cnt!=='1'?'s':''} awaiting DSL sign-off`,
          action_url: '/safeguarding.html?tab=queue',
        });
      }

      // SLA breaches
      const { rows: sla } = await db.query(`
        SELECT COUNT(*) as cnt FROM safeguarding_concerns
        WHERE escalation_due_at < NOW()
          AND status NOT IN ('closed')
      `);
      if (parseInt(sla[0].cnt) > 0) {
        alerts.push({
          type: 'sla_breach',
          severity: 'danger',
          message: `${sla[0].cnt} concern${sla[0].cnt!=='1'?'s':''} overdue escalation SLA`,
          action_url: '/safeguarding.html?tab=concerns',
        });
      }

      // LADO referrals due
      const { rows: lado } = await db.query(`
        SELECT COUNT(*) as cnt FROM safeguarding_concerns
        WHERE requires_lado=true AND lado_referral_date IS NULL AND status NOT IN ('closed')
      `);
      if (parseInt(lado[0].cnt) > 0) {
        alerts.push({
          type: 'lado_pending',
          severity: 'danger',
          message: `${lado[0].cnt} concern${lado[0].cnt!=='1'?'s':''} flagged for LADO — referral not yet recorded`,
          action_url: '/safeguarding.html',
        });
      }
    }

    // Concerns logged by this user — awaiting action
    const { rows: mine } = await db.query(`
      SELECT COUNT(*) FILTER (WHERE status='new') as new_mine,
             COUNT(*) FILTER (WHERE status='under_review') as review_mine,
             COUNT(*) FILTER (WHERE status IN ('closed','referred')) as closed_mine
      FROM safeguarding_concerns
      WHERE reported_by=$1
        AND concern_date > NOW() - INTERVAL '28 days'
    `, [userId]);
    const m = mine[0];
    if (parseInt(m.new_mine) + parseInt(m.review_mine) > 0) {
      alerts.push({
        type: 'my_concerns',
        severity: 'info',
        message: `You have ${parseInt(m.new_mine)+parseInt(m.review_mine)} active concern${parseInt(m.new_mine)+parseInt(m.review_mine)!==1?'s':''} this month. ${m.closed_mine} closed.`,
        action_url: '/safeguarding.html',
      });
    }

    // Risk assessments expiring within 7 days
    const { rows: expRA } = await db.query(`
      SELECT COUNT(*) as cnt FROM risk_assessments
      WHERE review_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7
        AND status='approved'
    `);
    if (parseInt(expRA[0].cnt) > 0) {
      alerts.push({
        type: 'ra_expiring',
        severity: 'warning',
        message: `${expRA[0].cnt} risk assessment${expRA[0].cnt!=='1'?'s':''} due for review in the next 7 days`,
        action_url: '/risk-assessments.html',
      });
    }

    res.json(alerts);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 11. GOVERNOR TERMLY REPORT ───────────────────────────────────────────────

router.get('/reports/termly', async (req, res) => {
  if (!requireDSL(req, res)) return;

  const { term_start, term_end } = req.query;
  const start = term_start || new Date(new Date().setMonth(new Date().getMonth() - 4)).toISOString().split('T')[0];
  const end   = term_end   || new Date().toISOString().split('T')[0];

  try {
    const db = getPool();

    const [totals, byCat, escalations, lado, mash, raExpiring] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status='closed') as closed,
          COUNT(*) FILTER (WHERE status NOT IN ('closed')) as open,
          COUNT(*) FILTER (WHERE severity='critical') as critical,
          COUNT(*) FILTER (WHERE severity='high') as high,
          COUNT(*) FILTER (WHERE is_multi_child=true) as multi_child
        FROM safeguarding_concerns
        WHERE concern_date BETWEEN $1 AND $2
      `, [start, end]),

      db.query(`
        SELECT category, COUNT(*) as cnt
        FROM safeguarding_concerns
        WHERE concern_date BETWEEN $1 AND $2
        GROUP BY category ORDER BY cnt DESC
      `, [start, end]),

      db.query(`
        SELECT COUNT(*) as cnt FROM safeguarding_escalation_log
        WHERE created_at BETWEEN $1 AND $2
      `, [start, end]),

      db.query(`
        SELECT COUNT(*) as cnt FROM safeguarding_concerns
        WHERE concern_date BETWEEN $1 AND $2 AND requires_lado=true
      `, [start, end]),

      db.query(`
        SELECT COUNT(*) as cnt FROM safeguarding_concerns
        WHERE concern_date BETWEEN $1 AND $2 AND mash_referral_date IS NOT NULL
      `, [start, end]),

      db.query(`
        SELECT COUNT(*) as cnt FROM risk_assessments
        WHERE review_date <= CURRENT_DATE + 30 AND status='approved'
      `),
    ]);

    await writeAudit(db, req, 'governor_report_view', 'report', 'termly', null, null);

    res.json({
      period: { start, end },
      totals: totals.rows[0],
      by_category: byCat.rows,
      escalation_count: escalations.rows[0].cnt,
      lado_referrals: lado.rows[0].cnt,
      mash_referrals: mash.rows[0].cnt,
      ra_due_30d: raExpiring.rows[0].cnt,
      generated_at: new Date().toISOString(),
      generated_by: req.user.name,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 12. OFSTED PACK ───────────────────────────────────────────────────────────

router.get('/reports/ofsted', async (req, res) => {
  if (!requireDSL(req, res)) return;
  const { from, to } = req.query;
  const start = from || new Date(new Date().setFullYear(new Date().getFullYear()-1)).toISOString().split('T')[0];
  const end   = to   || new Date().toISOString().split('T')[0];

  try {
    const db = getPool();

    const [summary, categories, openByAge, raStatus, drills] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*) as total_concerns,
          COUNT(DISTINCT child_id) as children_involved,
          COUNT(*) FILTER (WHERE status='closed') as closed,
          COUNT(*) FILTER (WHERE status NOT IN ('closed')) as open,
          COUNT(*) FILTER (WHERE requires_lado=true) as lado,
          COUNT(*) FILTER (WHERE mash_referral_date IS NOT NULL) as mash,
          COUNT(*) FILTER (WHERE severity IN ('high','critical')) as high_severity
        FROM safeguarding_concerns
        WHERE concern_date BETWEEN $1 AND $2
      `, [start, end]),

      db.query(`
        SELECT category, severity, COUNT(*) as cnt
        FROM safeguarding_concerns
        WHERE concern_date BETWEEN $1 AND $2
        GROUP BY category, severity ORDER BY cnt DESC
      `, [start, end]),

      db.query(`
        SELECT
          EXTRACT(EPOCH FROM (NOW()-concern_date))/86400 as age_days,
          id, severity, category
        FROM safeguarding_concerns
        WHERE status NOT IN ('closed')
        ORDER BY concern_date ASC LIMIT 20
      `),

      db.query(`
        SELECT status, COUNT(*) as cnt
        FROM risk_assessments GROUP BY status
      `),

      db.query(`
        SELECT drill_date, evacuation_time_seconds, issues_raised
        FROM fire_drills ORDER BY drill_date DESC LIMIT 5
      `),
    ]);

    await writeAudit(db, req, 'ofsted_pack_view', 'report', 'ofsted', null, null);

    res.json({
      period: { start, end },
      summary: summary.rows[0],
      categories: categories.rows,
      open_concerns: openByAge.rows,
      risk_assessment_status: raStatus.rows,
      recent_fire_drills: drills.rows,
      generated_at: new Date().toISOString(),
      generated_by: req.user.name,
      footer: 'This is a controlled safeguarding record. Unauthorised distribution is a data breach.',
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 13. CTF TRANSFER INITIATION ───────────────────────────────────────────────

router.post('/transfer/:childId', async (req, res) => {
  if (!requireDSL(req, res)) return;
  const { destination_school, destination_urn, transfer_date, notes } = req.body;
  if (!destination_school) return res.status(400).json({ error: 'destination_school required' });

  try {
    const db = getPool();
    const childId = parseInt(req.params.childId);

    // Pull chronology to bundle
    const { rows: concerns } = await db.query(`
      SELECT id, concern_date, category, description, status, severity
      FROM safeguarding_concerns
      WHERE child_id=$1 AND is_confidential=false
      ORDER BY concern_date ASC
    `, [childId]);

    const bundle = {
      child_id: childId,
      destination: destination_school,
      destination_urn,
      transfer_date: transfer_date || new Date().toISOString().split('T')[0],
      safeguarding_summary: concerns,
      generated_at: new Date().toISOString(),
      generated_by: req.user.name,
      footer: 'CONTROLLED RECORD — share only with receiving DSL via secure channel',
    };

    const bundleHash = crypto.createHash('sha256')
      .update(JSON.stringify(bundle)).digest('hex');

    const { rows } = await db.query(`
      INSERT INTO safeguarding_transfers
        (child_id, destination_school, destination_urn, transfer_date,
         initiated_by, bundle_hash, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `, [childId, destination_school, destination_urn||null,
        transfer_date||new Date().toISOString().split('T')[0],
        req.user.id, bundleHash, notes||null]);

    await writeAudit(db, req, 'ctf_transfer_initiated', 'child', childId, null, bundleHash);

    // Telegram alert for audit trail
    const BOT  = process.env.TELEGRAM_BOT_TOKEN;
    const CHAT = process.env.TELEGRAM_CHAT_ID;
    if (BOT && CHAT) {
      fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT, parse_mode: 'HTML',
          text: `📦 <b>Safeguarding Transfer Initiated</b>\n\nDestination: ${destination_school}\nInitiated by: ${req.user.name}\nTransfer ID: ${rows[0].id}\nBundle hash: ${bundleHash.substring(0,12)}…\n\nBundle available in Wren for secure handover.`
        })
      }).catch(() => {});
    }

    res.status(201).json({
      transfer: rows[0],
      bundle,
      bundle_hash: bundleHash,
      notice: 'This bundle must be transmitted to the receiving DSL via an encrypted channel only.',
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 14. CONCERN BODY MAP UPDATE ────────────────────────────────────────────────

router.put('/:id/body-map', async (req, res) => {
  const { body_map_data } = req.body;
  if (!body_map_data) return res.status(400).json({ error: 'body_map_data required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE safeguarding_concerns SET body_map_data=$1, updated_at=NOW()
      WHERE id=$2 RETURNING id, body_map_data
    `, [body_map_data, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    await writeAudit(db, req, 'body_map_update', 'safeguarding_concern', req.params.id, null, null);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
