const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// GET / — all SEN register entries
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT sr.*, c.first_name || ' ' || c.last_name as child_name,
        c.date_of_birth, r.name as room_name,
        CASE WHEN sr.review_date <= CURRENT_DATE + 28 THEN true ELSE false END as review_due_soon,
        s.first_name || ' ' || s.last_name as created_by_name
      FROM sen_register sr
      LEFT JOIN children c ON c.id = sr.child_id
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN staff s ON s.id = sr.created_by
      WHERE sr.is_active = true
      ORDER BY sr.sen_type, c.last_name
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /:childId
router.get('/child/:childId', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT * FROM sen_register WHERE child_id=$1',
      [req.params.childId]
    );
    res.json(rows[0] || null);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /
router.post('/', async (req, res) => {
  const { child_id, sen_type, primary_need, secondary_need, ehcp_date,
    review_date, annual_review_date, external_professionals, provision_map } = req.body;
  if (!child_id || !sen_type) return res.status(400).json({ error: 'child_id and sen_type required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO sen_register (child_id,sen_type,primary_need,secondary_need,ehcp_date,
        review_date,annual_review_date,external_professionals,provision_map,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (child_id) DO UPDATE SET
        sen_type=EXCLUDED.sen_type, primary_need=EXCLUDED.primary_need,
        secondary_need=EXCLUDED.secondary_need, ehcp_date=EXCLUDED.ehcp_date,
        review_date=EXCLUDED.review_date, annual_review_date=EXCLUDED.annual_review_date,
        external_professionals=EXCLUDED.external_professionals,
        provision_map=EXCLUDED.provision_map, updated_at=NOW()
      RETURNING *
    `, [child_id, sen_type, primary_need||null, secondary_need||null, ehcp_date||null,
        review_date||null, annual_review_date||null,
        JSON.stringify(external_professionals||[]), provision_map||null, req.user.id]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id
router.put('/:id', async (req, res) => {
  const { sen_type, primary_need, secondary_need, ehcp_date, review_date,
    annual_review_date, external_professionals, provision_map, is_active } = req.body;
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
    if (external_professionals !== undefined) {
      updates.push(`external_professionals=$${pi++}`);
      params.push(JSON.stringify(external_professionals));
    }
    updates.push('updated_at=NOW()');
    params.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE sen_register SET ${updates.join(',')} WHERE id=$${pi} RETURNING *`, params
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── EHCP-specific endpoints ──────────────────────────────────────────────────
// GET /ehcp — children with EHCP (from children table + sen_register)
router.get('/ehcp', async (req, res) => {
  try {
    const db = getPool();
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
        AND c.is_active = true
      ORDER BY c.last_name, c.first_name
    `);
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
      FROM children c WHERE c.is_active = true
    `);
    res.json(rows[0] || { sen_count:0, ehcp_count:0, support_count:0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /ehcp — create/update EHCP record
router.post('/ehcp', async (req, res) => {
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
router.put('/ehcp/:id', async (req, res) => {
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

module.exports = router;
