const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// ── b155 SEN hub — role guards ────────────────────────────────────────────────
// Mirrors src/routes/sen-flag.js's requireSenco gate: manager-tier roles, or a
// non-manager staff member tagged as the setting's SENCO (staff.is_send_lead).
const MGR_ROLES = new Set(['manager', 'deputy_manager', 'admin', 'business_manager']);

async function requireSenco(req, res, next) {
  if (MGR_ROLES.has(req.user.role)) return next();
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT is_send_lead FROM staff WHERE id=$1', [req.user.id]);
    if (rows[0] && rows[0].is_send_lead) return next();
  } catch (e) { return res.status(500).json({ error: e.message }); }
  return res.status(403).json({ error: 'Forbidden — SENCO/manager access only' });
}

// Practitioners see only their own key children's SEN plans; SENCO/manager see all.
// Parents never reach this — the SEN register itself is never parent-visible (only
// their own child's shared Play Plan, via the separate /parent routes below).
async function checkAccess(req, childId) {
  if (req.user.role === 'parent') return false;
  if (MGR_ROLES.has(req.user.role)) return true;
  const db = getPool();
  const { rows: sencoRows } = await db.query('SELECT is_send_lead FROM staff WHERE id=$1', [req.user.id]);
  if (sencoRows[0] && sencoRows[0].is_send_lead) return true;
  const { rows } = await db.query('SELECT key_person_id FROM children WHERE id=$1', [childId]);
  return !!rows.length && Number(rows[0].key_person_id) === Number(req.user.id);
}
async function canAccessChild(req, res, next) {
  const childId = parseInt(req.params.childId, 10);
  if (!childId) return res.status(400).json({ error: 'Invalid child id' });
  try {
    if (await checkAccess(req, childId)) { req._childId = childId; return next(); }
    return res.status(403).json({ error: "Forbidden — SENCO/manager or this child's key person only" });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

const SEND_AREAS = ['Communication & Interaction', 'Cognition & Learning',
  'Social, Emotional & Mental Health', 'Sensory/Physical'];

// Local-only AI generation for SEN needs-profile suggestions — never Groq/cloud,
// regardless of the edition's AI_PROVIDER (same rule as scripts/sen-flag-analyse.js:
// child SEN data must never leave the building). Modelled on activity-bank.js's aiCall.
// b333: host + model from the one resolver (src/lib/ai-models.js) — role 'default'.
// ai.host() is still the local Ollama; nothing here reads AI_PROVIDER.
const ai = require('../lib/ai-models');
const OLLAMA_HOST  = ai.host();
const OLLAMA_MODEL = () => ai.model('default');
async function aiCall(prompt, systemPrompt, maxTokens) {
  const r = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL(), system: systemPrompt || '', prompt,
      stream: false, think: false,
      options: ai.options({ num_predict: maxTokens || 900, temperature: 0.7 })
    }),
    signal: AbortSignal.timeout(120000)
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}`);
  const data = await r.json();
  let text = (data.response || '').trim();
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
function parseJSON(text) {
  const m = text.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON in AI response');
  return JSON.parse(m[0]);
}

// Map the 7 Fledge/EYFS areas -> the 4 SEND Code of Practice broad areas, following
// the same split used by scripts/sen-flag-analyse.js's AREA_MAP.
const FLEDGE_TO_SEND_AREA = {
  'Communication & Language': 'Communication & Interaction',
  'Communication and Language': 'Communication & Interaction',
  'Personal, Social & Emotional Development': 'Social, Emotional & Mental Health',
  'Personal, Social and Emotional Development': 'Social, Emotional & Mental Health',
  'Physical Development': 'Sensory/Physical',
  'Literacy': 'Cognition & Learning',
  'Mathematics': 'Cognition & Learning',
  'Understanding the World': 'Cognition & Learning',
  'Expressive Arts & Design': 'Cognition & Learning',
  'Expressive Arts and Design': 'Cognition & Learning',
};

// GET / — SEN register entries. SENCO/manager see the whole register; practitioners
// are scoped to only their own key children (never the full nursery register).
router.get('/', async (req, res) => {
  if (req.user.role === 'parent') return res.status(403).json({ error: 'Forbidden' });
  try {
    const db = getPool();
    let scope = '';
    const params = [];
    if (!MGR_ROLES.has(req.user.role)) {
      const { rows: sencoRows } = await db.query('SELECT is_send_lead FROM staff WHERE id=$1', [req.user.id]);
      if (!(sencoRows[0] && sencoRows[0].is_send_lead)) {
        params.push(req.user.id);
        scope = ` AND c.key_person_id = $${params.length}`;
      }
    }
    const { rows } = await db.query(`
      SELECT sr.*, c.first_name || ' ' || c.last_name as child_name,
        c.date_of_birth, r.name as room_name,
        CASE WHEN sr.review_date <= CURRENT_DATE + 28 THEN true ELSE false END as review_due_soon,
        s.first_name || ' ' || s.last_name as created_by_name
      FROM sen_register sr
      LEFT JOIN children c ON c.id = sr.child_id
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN staff s ON s.id = sr.created_by
      WHERE sr.is_active = true${scope}
      ORDER BY sr.sen_type, c.first_name, c.last_name
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /child/:childId — single register row (SENCO/manager or this child's key person)
router.get('/child/:childId', canAccessChild, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT * FROM sen_register WHERE child_id=$1',
      [req.params.childId]
    );
    res.json(rows[0] || null);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST / — SENCO/manager only (adding a child to the register is a formal decision)
router.post('/', requireSenco, async (req, res) => {
  const { child_id, sen_type, primary_need, secondary_need, ehcp_date,
    review_date, annual_review_date, external_professionals, provision_map,
    status, areas_of_need, parental_consent, parental_consent_date,
    date_added_to_register, first_plan_date, senif_applied, ehcna_applied,
    outside_agencies,
    // b256 §2 — Abbey's register header is "Name of Setting | SENCO". Wren
    // derives today's SENCO from staff.is_send_lead, which is right for today
    // and loses who actually held the row when it was opened.
    senco_staff_id } = req.body;
  if (!child_id || !sen_type) return res.status(400).json({ error: 'child_id and sen_type required' });
  if (status && !['diagnosed', 'monitoring'].includes(status))
    return res.status(400).json({ error: 'status must be diagnosed or monitoring' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO sen_register (child_id,sen_type,primary_need,secondary_need,ehcp_date,
        review_date,annual_review_date,external_professionals,provision_map,created_by,
        status,areas_of_need,parental_consent,parental_consent_date,date_added_to_register,
        first_plan_date,senif_applied,ehcna_applied,outside_agencies,senco_staff_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT (child_id) DO UPDATE SET
        sen_type=EXCLUDED.sen_type, primary_need=EXCLUDED.primary_need,
        secondary_need=EXCLUDED.secondary_need, ehcp_date=EXCLUDED.ehcp_date,
        review_date=EXCLUDED.review_date, annual_review_date=EXCLUDED.annual_review_date,
        external_professionals=EXCLUDED.external_professionals,
        provision_map=EXCLUDED.provision_map,
        status=EXCLUDED.status, areas_of_need=EXCLUDED.areas_of_need,
        parental_consent=EXCLUDED.parental_consent, parental_consent_date=EXCLUDED.parental_consent_date,
        first_plan_date=EXCLUDED.first_plan_date, senif_applied=EXCLUDED.senif_applied,
        ehcna_applied=EXCLUDED.ehcna_applied, outside_agencies=EXCLUDED.outside_agencies,
        senco_staff_id=EXCLUDED.senco_staff_id,
        updated_at=NOW()
      RETURNING *
    `, [child_id, sen_type, primary_need||null, secondary_need||null, ehcp_date||null,
        review_date||null, annual_review_date||null,
        JSON.stringify(external_professionals||[]), provision_map||null, req.user.id,
        status || 'monitoring', areas_of_need || [], !!parental_consent, parental_consent_date || null,
        date_added_to_register || new Date().toISOString().slice(0,10), first_plan_date || null,
        !!senif_applied, !!ehcna_applied, JSON.stringify(outside_agencies || {}),
        senco_staff_id || null]);

    // b335 (2026-09-15) — optional, opt-in: start the concern pathway from this
    // SEN register entry. Additive and non-blocking, same as the safeguarding
    // hook — a caller that never sends start_pathway sees no change at all.
    if (req.body.start_pathway) {
      try {
        const { startPathway } = require('../lib/pathways');
        await startPathway(db, {
          childId: child_id,
          templateKey: req.body.pathway_template_key || 'child_concern',
          startedBy: req.user.id,
          startedReason: req.body.pathway_reason || `SEN register: ${primary_need || sen_type}`,
          sourceTable: 'sen_register',
          sourceId: rows[0].id,
        });
      } catch (e) { console.error('[sen] start_pathway failed:', e.message); }
    }

    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id — SENCO/manager only
router.put('/:id', requireSenco, async (req, res) => {
  const { sen_type, primary_need, secondary_need, ehcp_date, review_date,
    annual_review_date, external_professionals, provision_map, is_active,
    status, areas_of_need, parental_consent, parental_consent_date,
    first_plan_date, current_plan_number, senif_applied, ehcna_applied,
    outside_agencies, senco_staff_id } = req.body;
  if (status && !['diagnosed', 'monitoring'].includes(status))
    return res.status(400).json({ error: 'status must be diagnosed or monitoring' });
  try {
    const db = getPool();
    const updates = [];
    const params = [];
    let pi = 1;
    const add = (col, val) => { if (val !== undefined) { updates.push(`${col}=$${pi++}`); params.push(val); }};
    add('sen_type', sen_type);
    add('primary_need', primary_need);
    add('secondary_need', secondary_need);
    add('ehcp_date', ehcp_date);
    add('review_date', review_date);
    add('annual_review_date', annual_review_date);
    add('provision_map', provision_map);
    add('is_active', is_active);
    add('status', status);
    add('areas_of_need', areas_of_need);
    add('parental_consent', parental_consent);
    add('parental_consent_date', parental_consent_date);
    add('first_plan_date', first_plan_date);
    add('current_plan_number', current_plan_number);
    add('senif_applied', senif_applied);
    add('ehcna_applied', ehcna_applied);
    add('senco_staff_id', senco_staff_id);   // b256 §2 — Abbey's register header
    if (external_professionals !== undefined) {
      updates.push(`external_professionals=$${pi++}`);
      params.push(JSON.stringify(external_professionals));
    }
    if (outside_agencies !== undefined) {
      updates.push(`outside_agencies=$${pi++}`);
      params.push(JSON.stringify(outside_agencies));
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    updates.push('updated_at=NOW()');
    params.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE sen_register SET ${updates.join(',')} WHERE id=$${pi} RETURNING *`, params
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/termly-update — append a termly review stamp (Abbey's register template:
// "Date register updated: Autumn / Spring / Summer term")
router.post('/:id/termly-update', requireSenco, async (req, res) => {
  const { term, year, note } = req.body;
  if (!term || !['Autumn', 'Spring', 'Summer'].includes(term))
    return res.status(400).json({ error: 'term must be Autumn, Spring or Summer' });
  try {
    const db = getPool();
    const stamp = { term, year: year || new Date().getFullYear(),
      date: new Date().toISOString().slice(0,10), by: req.user.id, note: note || null };
    const { rows } = await db.query(`
      UPDATE sen_register SET termly_updates = termly_updates || $1::jsonb, updated_at=NOW()
      WHERE id=$2 RETURNING *
    `, [JSON.stringify([stamp]), req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── EHCP-specific endpoints ──────────────────────────────────────────────────
// GET /ehcp — children with EHCP (from children table + sen_register)
// q02 (2026-07-24): was fully unscoped — any authenticated staff role could list every
// child's EHCP data. Mirrors GET /'s scoping: SENCO/manager see all, practitioners are
// scoped to their own key children.
router.get('/ehcp', async (req, res) => {
  if (req.user.role === 'parent') return res.status(403).json({ error: 'Forbidden' });
  try {
    const db = getPool();
    let scope = '';
    const params = [];
    if (!MGR_ROLES.has(req.user.role)) {
      const { rows: sencoRows } = await db.query('SELECT is_send_lead FROM staff WHERE id=$1', [req.user.id]);
      if (!(sencoRows[0] && sencoRows[0].is_send_lead)) {
        params.push(req.user.id);
        scope = ` AND c.key_person_id = $${params.length}`;
      }
    }
    // Primary: query children directly (sen_status column on children table)
    const { rows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.year_group, c.class_group,
             c.sen_status,
             sr.primary_need, sr.review_date, sr.ehcp_date as issue_date,
             sr.provision_map as provision, sr.id as sen_reg_id,
             sr.review_date,
             CASE WHEN sr.review_date IS NOT NULL AND sr.review_date < NOW() THEN 'overdue'
                  WHEN sr.review_date IS NOT NULL AND sr.review_date < NOW() + INTERVAL '30 days' THEN 'soon'
                  ELSE 'ok' END as review_status
      FROM children c
      LEFT JOIN sen_register sr ON sr.child_id = c.id
      WHERE (c.sen_status = 'ehcp' OR sr.sen_type = 'ehcp' OR sr.ehcp_date IS NOT NULL)
        AND c.is_active = true${scope}
      ORDER BY c.first_name, c.last_name
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /summary — counts for admin dashboard
router.get('/summary', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE c.sen_status IS NOT NULL AND c.sen_status != 'none') as sen_count,
        COUNT(*) FILTER (WHERE c.sen_status = 'ehcp') as ehcp_count,
        COUNT(*) FILTER (WHERE c.sen_status = 'sen_support') as support_count
      FROM children c WHERE c.is_active = true AND c.is_demo = false
    `);
    res.json(rows[0] || { sen_count:0, ehcp_count:0, support_count:0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /ehcp — create/update EHCP record
// q02 (2026-07-24): was missing requireSenco entirely — any authenticated staff role
// could create/upsert an EHCP register entry for any child. Mirrors POST /'s gate.
router.post('/ehcp', requireSenco, async (req, res) => {
  const { child_id, status, issue_date, review_date, primary_need, lead, outcomes, provision } = req.body;
  if (!child_id) return res.status(400).json({ error: 'child_id required' });
  try {
    const db = getPool();
    // Upsert into children + sen_register
    if (status === 'active' || status === 'ehcp') {
      await db.query("UPDATE children SET sen_status='ehcp' WHERE id=$1", [child_id]);
    }
    const { rows } = await db.query(`
      INSERT INTO sen_register (child_id, sen_type, primary_need, ehcp_date, review_date, provision_map, created_by)
      VALUES ($1,'ehcp',$2,$3,$4,$5,$6)
      ON CONFLICT (child_id) DO UPDATE SET
        sen_type='ehcp', primary_need=EXCLUDED.primary_need,
        ehcp_date=EXCLUDED.ehcp_date, review_date=EXCLUDED.review_date,
        provision_map=EXCLUDED.provision_map, updated_at=NOW()
      RETURNING *
    `, [child_id, primary_need||null, issue_date||null, review_date||null, provision||null, req.user.id]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /ehcp/:id
// q02 (2026-07-24): was missing any access check at all — any authenticated staff role
// could tamper with any child's EHCP register row by id (IDOR). Mirrors PUT /:id's gate.
router.put('/ehcp/:id', requireSenco, async (req, res) => {
  const { status, issue_date, review_date, primary_need, lead, outcomes, provision } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE sen_register SET primary_need=$1, ehcp_date=$2, review_date=$3, provision_map=$4, updated_at=NOW()
      WHERE id=$5 RETURNING *
    `, [primary_need||null, issue_date||null, review_date||null, provision||null, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// b155 — SMART targets per SEND broad area
// ═══════════════════════════════════════════════════════════════════════════

// GET /child/:childId/targets
router.get('/child/:childId/targets', canAccessChild, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT t.*, o.observation_text AS evidence_observation_text
      FROM sen_targets t
      LEFT JOIN observations o ON o.id = t.evidence_observation_id
      WHERE t.child_id=$1 ORDER BY (t.status='active') DESC, t.area, t.created_at DESC
    `, [req._childId]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /child/:childId/targets — SMART target (reviewed at least termly, per abbey-pack)
router.post('/child/:childId/targets', canAccessChild, async (req, res) => {
  // b256 §2 — measure_text is Abbey's "Measurable: you can observe the
  // improvement/progress in this area", the half of SMART b155 prompted for in a
  // label and then captured nowhere. review_term is her "Time related: reviewed
  // at least termly", so a target's review lines up with the register's termly
  // stamp. Both optional; pre-b256 callers are unaffected.
  const { area, target_text, review_date, ways_to_help_nursery, ways_to_help_home,
    evidence_observation_id, evidence_note, framework_statement_id, apdr_cycle_id,
    measure_text, review_term } = req.body;
  if (!area || !SEND_AREAS.includes(area)) return res.status(400).json({ error: 'area must be one of: ' + SEND_AREAS.join(', ') });
  if (!target_text || !String(target_text).trim()) return res.status(400).json({ error: 'target_text required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO sen_targets (child_id, area, target_text, review_date, ways_to_help_nursery,
        ways_to_help_home, evidence_observation_id, evidence_note, framework_statement_id,
        apdr_cycle_id, measure_text, review_term, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *
    `, [req._childId, area, String(target_text).trim(), review_date || null,
        ways_to_help_nursery || null, ways_to_help_home || null,
        evidence_observation_id || null, evidence_note || null,
        framework_statement_id || null, apdr_cycle_id || null,
        measure_text || null, review_term || null, req.user.id]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /targets/:id — edit / mark achieved / discontinue / record parent view
router.patch('/targets/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows: existing } = await db.query('SELECT child_id FROM sen_targets WHERE id=$1', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    if (!(await checkAccess(req, existing[0].child_id)))
      return res.status(403).json({ error: "Forbidden — SENCO/manager or this child's key person only" });

    const { target_text, status, review_date, ways_to_help_nursery, ways_to_help_home,
      achieved_note, parent_view_note, measure_text, review_term } = req.body;
    if (status && !['active','achieved','discontinued'].includes(status))
      return res.status(400).json({ error: 'Invalid status' });
    const updates = [], params = []; let pi = 1;
    const add = (col, val) => { if (val !== undefined) { updates.push(`${col}=$${pi++}`); params.push(val); } };
    add('target_text', target_text);
    add('review_date', review_date);
    add('ways_to_help_nursery', ways_to_help_nursery);
    add('ways_to_help_home', ways_to_help_home);
    add('achieved_note', achieved_note);
    add('parent_view_note', parent_view_note);
    add('measure_text', measure_text);   // b256 §2 — Abbey's SMART 'Measurable'
    add('review_term', review_term);     // b256 §2 — Abbey's SMART 'Time related'
    if (parent_view_note !== undefined) { updates.push(`parent_view_date=CURRENT_DATE`); }
    if (status !== undefined) {
      updates.push(`status=$${pi++}`); params.push(status);
      if (status === 'achieved') updates.push('achieved_date=CURRENT_DATE');
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    updates.push('updated_at=NOW()');
    params.push(req.params.id);
    const { rows } = await db.query(`UPDATE sen_targets SET ${updates.join(',')} WHERE id=$${pi} RETURNING *`, params);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// b155 — APDR cycles (Assess -> Plan -> Do -> Review, graduated approach)
// ═══════════════════════════════════════════════════════════════════════════

// GET /child/:childId/apdr — every cycle, its running review log, and its targets
router.get('/child/:childId/apdr', canAccessChild, async (req, res) => {
  try {
    const db = getPool();
    const { rows: cycles } = await db.query(
      'SELECT * FROM sen_apdr_cycles WHERE child_id=$1 ORDER BY cycle_number DESC', [req._childId]);
    for (const c of cycles) {
      const { rows: reviews } = await db.query(
        `SELECT r.*, s.first_name || ' ' || s.last_name AS staff_name
         FROM sen_apdr_reviews r LEFT JOIN staff s ON s.id=r.staff_id
         WHERE r.cycle_id=$1 ORDER BY r.review_date DESC, r.id DESC`, [c.id]);
      const { rows: targets } = await db.query(
        'SELECT * FROM sen_targets WHERE apdr_cycle_id=$1 ORDER BY area', [c.id]);
      c.reviews = reviews; c.targets = targets;
    }
    res.json(cycles);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /child/:childId/apdr — open a new cycle (Assess + Plan + Do)
router.post('/child/:childId/apdr', canAccessChild, async (req, res) => {
  // b256 §2 — review_due_date / parent_views / practitioner_views are Abbey's
  // fields (her IEP header carries "Date of review", and the form itself prompts
  // for the parents' and other practitioners' views before you write the plan).
  // All three are optional: an existing caller that sends none behaves exactly
  // as it did before b256.
  const { assess_text, plan_text, do_text, target_ids,
    review_due_date, parent_views, practitioner_views } = req.body;
  try {
    const db = getPool();
    const { rows: maxRow } = await db.query(
      'SELECT COALESCE(MAX(cycle_number),0)+1 AS n FROM sen_apdr_cycles WHERE child_id=$1', [req._childId]);
    const { rows } = await db.query(`
      INSERT INTO sen_apdr_cycles (child_id, cycle_number, assess_text, plan_text, do_text,
        review_due_date, parent_views, practitioner_views, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [req._childId, maxRow[0].n, assess_text || null, plan_text || null, do_text || null,
        review_due_date || null, parent_views || null, practitioner_views || null, req.user.id]);
    const cycle = rows[0];
    if (Array.isArray(target_ids) && target_ids.length) {
      await db.query('UPDATE sen_targets SET apdr_cycle_id=$1 WHERE id = ANY($2::int[]) AND child_id=$3',
        [cycle.id, target_ids, req._childId]);
    }
    res.status(201).json(cycle);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /apdr/:cycleId — edit assess/plan/do while the cycle is still open
router.patch('/apdr/:cycleId', async (req, res) => {
  try {
    const db = getPool();
    const { rows: existing } = await db.query('SELECT * FROM sen_apdr_cycles WHERE id=$1', [req.params.cycleId]);
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    if (!(await checkAccess(req, existing[0].child_id)))
      return res.status(403).json({ error: "Forbidden — SENCO/manager or this child's key person only" });
    if (existing[0].status !== 'open') return res.status(400).json({ error: 'Cycle is closed' });
    // b256 §2 — the five fields Abbey's IEP carries that b155 did not. The
    // "shared on" pair answers the question an inspector actually asks: her
    // template says the APDR should be shared with parents AND relevant staff,
    // and until now Wren could only evidence that for a Play Plan.
    const { assess_text, plan_text, do_text,
      review_due_date, parent_views, practitioner_views,
      shared_with_parents_on, shared_with_staff_on } = req.body;
    const updates = [], params = []; let pi = 1;
    const add = (col, val) => { if (val !== undefined) { updates.push(`${col}=$${pi++}`); params.push(val); } };
    add('assess_text', assess_text); add('plan_text', plan_text); add('do_text', do_text);
    add('review_due_date', review_due_date);
    add('parent_views', parent_views);
    add('practitioner_views', practitioner_views);
    add('shared_with_parents_on', shared_with_parents_on);
    add('shared_with_staff_on', shared_with_staff_on);
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.cycleId);
    const { rows } = await db.query(`UPDATE sen_apdr_cycles SET ${updates.join(',')} WHERE id=$${pi} RETURNING *`, params);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /apdr/:cycleId/review-log — informal "Review of APDR Outcomes" running note
// (Abbey's template: a Date | Review Notes | Initials log kept during the cycle,
// distinct from the formal review that closes it).
router.post('/apdr/:cycleId/review-log', async (req, res) => {
  try {
    const db = getPool();
    const { rows: existing } = await db.query('SELECT child_id FROM sen_apdr_cycles WHERE id=$1', [req.params.cycleId]);
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    if (!(await checkAccess(req, existing[0].child_id)))
      return res.status(403).json({ error: "Forbidden — SENCO/manager or this child's key person only" });
    const { notes, review_date } = req.body;
    const { rows } = await db.query(`
      INSERT INTO sen_apdr_reviews (cycle_id, review_date, notes, staff_id)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [req.params.cycleId, review_date || new Date().toISOString().slice(0,10), notes || null, req.user.id]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /apdr/:cycleId/close — formal review: closes this cycle, resolves each target's
// outcome (achieved / continue / discontinued), and — per the graduated approach —
// automatically opens the next cycle, carrying forward any 'continue' targets.
router.post('/apdr/:cycleId/close', async (req, res) => {
  const { review_text, target_outcomes, notes } = req.body;
  try {
    const db = getPool();
    const { rows: existing } = await db.query('SELECT * FROM sen_apdr_cycles WHERE id=$1', [req.params.cycleId]);
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    const cycle = existing[0];
    if (!(await checkAccess(req, cycle.child_id)))
      return res.status(403).json({ error: "Forbidden — SENCO/manager or this child's key person only" });
    if (cycle.status !== 'open') return res.status(400).json({ error: 'Cycle already closed' });

    const { rows: closedRows } = await db.query(`
      UPDATE sen_apdr_cycles SET status='closed', review_text=$1, review_date=CURRENT_DATE, closed_at=NOW()
      WHERE id=$2 RETURNING *
    `, [review_text || null, req.params.cycleId]);

    const { rows: nextRows } = await db.query(`
      INSERT INTO sen_apdr_cycles (child_id, cycle_number, created_by)
      VALUES ($1, $2, $3) RETURNING *
    `, [cycle.child_id, cycle.cycle_number + 1, req.user.id]);
    const nextCycle = nextRows[0];

    const outcomes = Array.isArray(target_outcomes) ? target_outcomes : [];
    for (const o of outcomes) {
      if (!o || !o.target_id) continue;
      if (o.outcome === 'achieved') {
        await db.query(`UPDATE sen_targets SET status='achieved', achieved_date=CURRENT_DATE, updated_at=NOW() WHERE id=$1 AND child_id=$2`, [o.target_id, cycle.child_id]);
      } else if (o.outcome === 'discontinued') {
        await db.query(`UPDATE sen_targets SET status='discontinued', updated_at=NOW() WHERE id=$1 AND child_id=$2`, [o.target_id, cycle.child_id]);
      } else if (o.outcome === 'continue') {
        await db.query(`UPDATE sen_targets SET apdr_cycle_id=$1, updated_at=NOW() WHERE id=$2 AND child_id=$3`, [nextCycle.id, o.target_id, cycle.child_id]);
      }
    }
    if (notes) {
      await db.query('INSERT INTO sen_apdr_reviews (cycle_id, notes, staff_id) VALUES ($1,$2,$3)',
        [req.params.cycleId, notes, req.user.id]);
    }
    res.json({ closed_cycle: closedRows[0], new_cycle: nextCycle });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// b155 — Needs-profile -> activity suggestions (Intervention-Toolkit idea,
// ORIGINAL content only). Weak areas = child's band_judgements spiky profile +
// their own active SEN target areas.
// ═══════════════════════════════════════════════════════════════════════════

router.get('/child/:childId/suggested-activities', canAccessChild, async (req, res) => {
  try {
    const db = getPool();
    const { rows: bandRows } = await db.query(`
      SELECT DISTINCT ON (area) area, band FROM band_judgements
      WHERE child_id=$1 ORDER BY area, judged_on DESC, id DESC
    `, [req._childId]);
    const { rows: targetRows } = await db.query(
      "SELECT DISTINCT area FROM sen_targets WHERE child_id=$1 AND status='active'", [req._childId]);

    const maxBand = bandRows.length ? Math.max(...bandRows.map(r => r.band)) : null;
    const weakSendAreas = new Set();
    bandRows.forEach(r => {
      const sendArea = FLEDGE_TO_SEND_AREA[r.area];
      if (sendArea && maxBand != null && r.band < maxBand) weakSendAreas.add(sendArea);
    });
    targetRows.forEach(r => weakSendAreas.add(r.area));
    const focusAreas = weakSendAreas.size ? Array.from(weakSendAreas) : SEND_AREAS;

    const { rows: activities } = await db.query(`
      SELECT id, title, description, age_group, eyfs_areas, send_areas, sen_adaptations, duration_minutes
      FROM planning_activities WHERE send_areas && $1::text[] ORDER BY times_used DESC NULLS LAST LIMIT 8
    `, [focusAreas]);

    res.json({ child_id: req._childId, band_judgements: bandRows, focus_areas: focusAreas, activities });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /child/:childId/suggested-activities/generate — AI-original idea for one area.
// Local Ollama only (child SEN data never leaves the building) — never Groq/cloud,
// regardless of AI_PROVIDER. Never reproduces published intervention-toolkit content.
router.post('/child/:childId/suggested-activities/generate', canAccessChild, async (req, res) => {
  const { area } = req.body;
  if (!area || !SEND_AREAS.includes(area)) return res.status(400).json({ error: 'area must be one of: ' + SEND_AREAS.join(', ') });
  const sys = `You are an experienced UK Early Years SENCO writing an ORIGINAL activity idea for a nursery's
SEN needs-profile tool. Never reproduce or closely paraphrase any published intervention-toolkit-style book —
write a fresh, original idea grounded in ordinary EYFS good practice and the setting's own curriculum.
The nursery has: Baby Room (6m-2yr) and Pre-school (2-5yr). Return ONLY valid JSON, no commentary, no markdown.`;
  const prompt = `Write one original, small-steps activity idea targeting the SEND broad area: "${area}".
Return JSON:
{
  "title": "...",
  "description": "...",
  "ways_to_help_nursery": "...",
  "ways_to_help_home": "...",
  "materials_needed": ["item 1"]
}`;
  try {
    const text = await aiCall(prompt, sys, 700);
    const idea = parseJSON(text);
    res.json({ ai_generated: true, area,
      disclaimer: 'AI-suggested — review before use. Generated locally; original content only.', ...idea });
  } catch(e) { res.status(503).json({ error: 'AI unavailable', detail: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// b155 — Play Plan (child-voice printable, Abbey's format), staff side
// ═══════════════════════════════════════════════════════════════════════════

async function buildSnapshot(db, childId) {
  const { rows: childRows } = await db.query(`
    SELECT c.id, c.first_name, c.last_name, c.date_of_birth, c.key_person_id,
      c.photo_url, c.photo_consent,
      s.first_name || ' ' || s.last_name AS key_person_name
    FROM children c LEFT JOIN staff s ON s.id = c.key_person_id WHERE c.id=$1
  `, [childId]);
  if (!childRows.length) return null;
  const child = childRows[0];
  const { rows: targets } = await db.query(
    "SELECT * FROM sen_targets WHERE child_id=$1 AND status IN ('active','achieved') ORDER BY area, created_at", [childId]);
  const byArea = {};
  // b256 §2 — `measures` and `home_achieved` are new buckets. Abbey's plan has a
  // SETTING column and a HOME column on the review page, and b155 only ever
  // built the setting side; and her SMART sheet asks how you will know, which
  // now travels onto the printed plan beside the target it belongs to.
  SEND_AREAS.forEach(a => byArea[a] = { area: a, targets: [], measures: [],
    ways_to_help_nursery: [], ways_to_help_home: [], achieved: [],
    home_achieved: [], parent_views: [] });
  targets.forEach(t => {
    const bucket = byArea[t.area]; if (!bucket) return;
    if (t.status === 'active') bucket.targets.push(t.target_text);
    if (t.measure_text) bucket.measures.push(t.measure_text);
    if (t.ways_to_help_nursery) bucket.ways_to_help_nursery.push(t.ways_to_help_nursery);
    if (t.ways_to_help_home) bucket.ways_to_help_home.push(t.ways_to_help_home);
    if (t.status === 'achieved' && t.achieved_note) bucket.achieved.push(t.achieved_note);
    if (t.parent_view_note) bucket.parent_views.push(t.parent_view_note);
  });
  // `home_achieved` is left EMPTY here on purpose. The family fills it in after
  // the plan is generated, through /api/parents/child/:id/play-plan-feedback,
  // and it is stored on the plan ROW (sen_play_plans.home_achieved_by_area), not
  // baked into this snapshot — a snapshot is what the setting wrote on the day.
  // Renderers merge the live column over these buckets.
  return {
    child_id: child.id, child_name: `${child.first_name} ${child.last_name}`.trim(),
    date_of_birth: child.date_of_birth, key_person_name: child.key_person_name || null,
    // b256 §2 — "Picture of Child" is a box on page 1 of Abbey's template. Only
    // included where photo consent is actually recorded: a plan that goes home
    // is not a reason to bypass the consent flag.
    child_photo_url: child.photo_consent ? (child.photo_url || null) : null,
    generated_on: new Date().toISOString().slice(0,10), areas: Object.values(byArea),
  };
}

// POST /child/:childId/play-plan/generate
router.post('/child/:childId/play-plan/generate', canAccessChild, async (req, res) => {
  try {
    const db = getPool();
    const snapshot = await buildSnapshot(db, req._childId);
    if (!snapshot) return res.status(404).json({ error: 'Child not found' });
    // b256 §2 — Abbey's plan is dated TWICE: "targets I want to achieve by
    // (date)" (target_date, which b155 had) and "this is what I have achieved
    // (review date)" (review_date, which it did not).
    const { rows } = await db.query(`
      INSERT INTO sen_play_plans (child_id, apdr_cycle_id, target_date, review_date,
        child_photo_url, snapshot, generated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [req._childId, req.body.apdr_cycle_id || null, req.body.target_date || null,
        req.body.review_date || null, snapshot.child_photo_url || null,
        JSON.stringify(snapshot), req.user.id]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /child/:childId/play-plan/latest — most recent plan (staff view/print)
router.get('/child/:childId/play-plan/latest', canAccessChild, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT * FROM sen_play_plans WHERE child_id=$1 ORDER BY generated_at DESC LIMIT 1', [req._childId]);
    res.json(rows[0] || null);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /play-plan/:id — stable id-based fetch (for print URLs)
router.get('/play-plan/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM sen_play_plans WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (!(await checkAccess(req, rows[0].child_id)))
      return res.status(403).json({ error: "Forbidden — SENCO/manager or this child's key person only" });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /play-plan/:id/share — makes this snapshot visible on the parent portal
router.post('/play-plan/:id/share', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM sen_play_plans WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (!(await checkAccess(req, rows[0].child_id)))
      return res.status(403).json({ error: "Forbidden — SENCO/manager or this child's key person only" });
    const { rows: updated } = await db.query(
      'UPDATE sen_play_plans SET shared_with_parent=true, shared_at=NOW() WHERE id=$1 RETURNING *', [req.params.id]);
    res.json(updated[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// NOTE: the parent-facing Play Plan view + feedback endpoints live in
// src/routes/parents.js (mounted at /api/parents), NOT here — this whole /api/sen
// prefix is in server-unified.js's PARENT_DENY blanket denylist by design (the SEN
// register itself must never be parent-visible), so a parent-role token can never
// reach anything under /api/sen/* regardless of route-level guards in this file.

// ═══════════════════════════════════════════════════════════════════════════
// b256 — child ↔ toolkit strategy links (2026-09-01)
//
// The toolkit LIBRARY lives in src/routes/sen-toolkit.js and holds no child
// data. THIS is the child side: "we are trying a Now/Next board with this
// child, on this Play Plan target." b256 §4 — the link goes one way, from a
// child's plan out to a strategy; nothing in the toolkit records who used it on
// whom except through these rows.
//
// It is here rather than in sen-toolkit.js precisely because /api/sen is on
// PARENT_DENY: this is child data and belongs behind that block. The parent's
// own read of the strategies shared with them is in src/routes/parents.js.
// ═══════════════════════════════════════════════════════════════════════════

const LINK_STATUSES = ['trying', 'working', 'not_working', 'stopped'];

// Shared SELECT — joins the strategy so a caller never has to fetch twice, and
// deliberately returns the escalation text with it: the point of attaching a
// strategy is that the practitioner can see when to stop and refer on.
const LINK_SELECT = `
  SELECT l.*, st.slug, st.title, st.area, st.summary, st.how_to,
         st.what_success_looks_like, st.when_to_escalate,
         st.licensed, st.licence_note, st.source_name, st.source_url,
         st.curriculum_activity_id, st.resource_path, st.is_active AS strategy_is_active,
         t.target_text, t.area AS target_area,
         c.cycle_number,
         s.first_name || ' ' || s.last_name AS created_by_name
  FROM sen_strategy_links l
  JOIN sen_strategies st ON st.id = l.strategy_id
  LEFT JOIN sen_targets t ON t.id = l.target_id
  LEFT JOIN sen_apdr_cycles c ON c.id = l.apdr_cycle_id
  LEFT JOIN staff s ON s.id = l.created_by`;

// GET /child/:childId/strategies — what we are trying with this child
router.get('/child/:childId/strategies', canAccessChild, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `${LINK_SELECT} WHERE l.child_id = $1
       ORDER BY (l.status = 'stopped'), l.created_at DESC`, [req._childId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /child/:childId/strategies — attach one, optionally to a specific Play
// Plan target or APDR cycle so "what are we trying?" has an answer with a name.
router.post('/child/:childId/strategies', canAccessChild, async (req, res) => {
  const { strategy_id, target_id, apdr_cycle_id, note, share_with_parent } = req.body;
  if (!strategy_id) return res.status(400).json({ error: 'strategy_id required' });
  try {
    const db = getPool();
    const { rows: st } = await db.query(
      'SELECT id, is_active FROM sen_strategies WHERE id = $1', [strategy_id]);
    if (!st.length) return res.status(404).json({ error: 'Strategy not found' });
    if (!st[0].is_active) return res.status(400).json({ error: 'That strategy has been retired' });

    // A target or a cycle must belong to THIS child. Without these two checks a
    // key person could staple their own child's strategy onto another child's
    // plan by guessing an id — the same IDOR class q02 found on /ehcp/:id.
    if (target_id) {
      const { rows } = await db.query('SELECT child_id FROM sen_targets WHERE id = $1', [target_id]);
      if (!rows.length || Number(rows[0].child_id) !== Number(req._childId)) {
        return res.status(400).json({ error: 'That target does not belong to this child' });
      }
    }
    if (apdr_cycle_id) {
      const { rows } = await db.query('SELECT child_id FROM sen_apdr_cycles WHERE id = $1', [apdr_cycle_id]);
      if (!rows.length || Number(rows[0].child_id) !== Number(req._childId)) {
        return res.status(400).json({ error: 'That APDR cycle does not belong to this child' });
      }
    }

    const shared = !!share_with_parent;
    const { rows } = await db.query(`
      INSERT INTO sen_strategy_links
        (strategy_id, child_id, target_id, apdr_cycle_id, note, shared_with_parent, shared_at, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (child_id, strategy_id, COALESCE(target_id,0), COALESCE(apdr_cycle_id,0))
      DO UPDATE SET note = COALESCE(EXCLUDED.note, sen_strategy_links.note),
                    updated_at = NOW()
      RETURNING id
    `, [strategy_id, req._childId, target_id || null, apdr_cycle_id || null,
        note || null, shared, shared ? new Date() : null, req.user.id]);

    const { rows: full } = await db.query(`${LINK_SELECT} WHERE l.id = $1`, [rows[0].id]);
    res.status(201).json(full[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /strategies/link/:id — did it help? and share/unshare with the family.
// Path is /strategies/link/:id, not /strategies/:id, so it can never be
// confused with a strategy id — these are two different id spaces.
router.patch('/strategies/link/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows: existing } = await db.query(
      'SELECT child_id, shared_with_parent FROM sen_strategy_links WHERE id = $1', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    if (!(await checkAccess(req, existing[0].child_id)))
      return res.status(403).json({ error: "Forbidden — SENCO/manager or this child's key person only" });

    const { status, note, shared_with_parent, target_id } = req.body;
    if (status !== undefined && !LINK_STATUSES.includes(status))
      return res.status(400).json({ error: 'status must be one of: ' + LINK_STATUSES.join(', ') });

    const updates = [], params = []; let pi = 1;
    const add = (col, val) => { if (val !== undefined) { updates.push(`${col}=$${pi++}`); params.push(val); } };
    add('status', status);
    add('note', note);
    if (target_id !== undefined) {
      if (target_id !== null) {
        const { rows } = await db.query('SELECT child_id FROM sen_targets WHERE id = $1', [target_id]);
        if (!rows.length || Number(rows[0].child_id) !== Number(existing[0].child_id)) {
          return res.status(400).json({ error: 'That target does not belong to this child' });
        }
      }
      add('target_id', target_id);
    }
    if (shared_with_parent !== undefined) {
      add('shared_with_parent', !!shared_with_parent);
      // Stamp shared_at on the transition TO shared, and clear it on unshare, so
      // "shared on the 4th" never survives having been withdrawn.
      if (shared_with_parent && !existing[0].shared_with_parent) updates.push('shared_at=NOW()');
      if (!shared_with_parent) updates.push('shared_at=NULL');
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    updates.push('updated_at=NOW()');
    params.push(req.params.id);
    await db.query(`UPDATE sen_strategy_links SET ${updates.join(',')} WHERE id=$${pi}`, params);
    const { rows: full } = await db.query(`${LINK_SELECT} WHERE l.id = $1`, [req.params.id]);
    res.json(full[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /strategies/link/:id — a mis-tap. Only the person who attached it or a
// SENCO/manager can remove one; anyone else marks it 'stopped' instead, which
// keeps the record of what was tried.
router.delete('/strategies/link/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows: existing } = await db.query(
      'SELECT child_id, created_by FROM sen_strategy_links WHERE id = $1', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    if (!(await checkAccess(req, existing[0].child_id)))
      return res.status(403).json({ error: "Forbidden — SENCO/manager or this child's key person only" });
    const isOwner = Number(existing[0].created_by) === Number(req.user.id);
    if (!isOwner && !MGR_ROLES.has(req.user.role)) {
      const { rows: senco } = await db.query('SELECT is_send_lead FROM staff WHERE id=$1', [req.user.id]);
      if (!(senco[0] && senco[0].is_send_lead)) {
        return res.status(403).json({ error: 'Only the person who attached this, or a SENCO/manager, can remove it — mark it stopped instead' });
      }
    }
    await db.query('DELETE FROM sen_strategy_links WHERE id = $1', [req.params.id]);
    res.json({ ok: true, deleted: Number(req.params.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /strategies/for-target/:targetId — the strategies on one Play Plan target,
// for the target row in the b155 Targets tab.
router.get('/strategies/for-target/:targetId', async (req, res) => {
  try {
    const db = getPool();
    const { rows: t } = await db.query('SELECT child_id FROM sen_targets WHERE id = $1', [req.params.targetId]);
    if (!t.length) return res.status(404).json({ error: 'Not found' });
    if (!(await checkAccess(req, t[0].child_id)))
      return res.status(403).json({ error: "Forbidden — SENCO/manager or this child's key person only" });
    const { rows } = await db.query(
      `${LINK_SELECT} WHERE l.target_id = $1 ORDER BY l.created_at`, [req.params.targetId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
