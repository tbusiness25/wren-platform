const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;
async function _tgPing(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'Markdown' }),
    });
  } catch (e) { console.error('telegram ping error:', e.message); }
}

router.use(authenticate);

// GET / — list all enquiries
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT e.*, s.first_name || ' ' || s.last_name AS assigned_to_name
      FROM enquiries e
      LEFT JOIN staff s ON e.assigned_to = s.id
      ORDER BY e.created_at DESC LIMIT 500
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /stats — trend statistics for last 12 months
router.get('/stats', async (req, res) => {
  try {
    const db = getPool();
    const [byMonth, bySource, convRate, avgDays] = await Promise.all([
      db.query(`
        SELECT TO_CHAR(created_at,'YYYY-MM') AS month, COUNT(*) AS count
        FROM enquiries
        WHERE created_at >= NOW() - INTERVAL '12 months'
        GROUP BY month ORDER BY month
      `),
      db.query(`
        SELECT COALESCE(source,'Unknown') AS source,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE stage='registered') AS converted
        FROM enquiries GROUP BY source ORDER BY total DESC
      `),
      db.query(`
        SELECT stage, COUNT(*) AS count FROM enquiries GROUP BY stage
      `),
      db.query(`
        SELECT ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at))/86400)::numeric,1) AS avg_days
        FROM enquiries WHERE stage='registered'
      `),
    ]);
    res.json({
      byMonth: byMonth.rows,
      bySource: bySource.rows,
      byStage: convRate.rows,
      avgDaysToRegistered: avgDays.rows[0]?.avg_days || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /forecast — predicted occupancy per room, next 6 months
router.get('/forecast', async (req, res) => {
  try {
    const db = getPool();
    const [rooms, enrolled, starters] = await Promise.all([
      db.query(`SELECT id, name, capacity FROM rooms ORDER BY id`),
      db.query(`
        SELECT r.id AS room_id, r.name AS room_name, COUNT(c.id) AS enrolled
        FROM rooms r
        LEFT JOIN children c ON c.room_id = r.id AND c.is_active = true
        GROUP BY r.id, r.name
      `),
      db.query(`
        SELECT room_needed,
               TO_CHAR(expected_start_date,'YYYY-MM') AS month,
               COUNT(*) AS starting
        FROM waiting_list
        WHERE expected_start_date BETWEEN NOW() AND NOW() + INTERVAL '6 months'
          AND status != 'placed'
        GROUP BY room_needed, month
      `),
    ]);

    const months = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() + i);
      months.push(d.toISOString().slice(0, 7));
    }

    const enrolledByRoom = {};
    enrolled.rows.forEach(r => { enrolledByRoom[r.room_id] = { name: r.room_name, count: parseInt(r.enrolled) }; });

    const startersByMonthRoom = {};
    starters.rows.forEach(r => {
      const k = `${r.month}:${r.room_needed}`;
      startersByMonthRoom[k] = parseInt(r.starting);
    });

    const result = months.map(month => {
      const roomData = rooms.rows.map(room => {
        const base = enrolledByRoom[room.id]?.count || 0;
        const key = `${month}:${room.name}`;
        const starting = startersByMonthRoom[key] || 0;
        const predicted = base + starting;
        return {
          room_id: room.id,
          room_name: room.name,
          capacity: room.capacity,
          enrolled: base,
          starting,
          predicted,
          utilisation: room.capacity ? Math.round((predicted / room.capacity) * 100) : 0,
        };
      });
      return { month, rooms: roomData };
    });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST / — create enquiry
router.post('/', async (req, res) => {
  const { child_first_name, child_last_name, child_dob, room_needed, preferred_room,
          start_date_requested, preferred_start_date, preferred_days, funded_hours_type,
          parent_name, parent_email, parent_phone, source, notes, assigned_to } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO enquiries (child_first_name, child_last_name, child_dob, room_needed,
        preferred_room, start_date_requested, preferred_start_date, preferred_days,
        funded_hours_type, parent_name, parent_email, parent_phone, source, notes, assigned_to)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
    `, [child_first_name, child_last_name, child_dob||null, room_needed,
        preferred_room, start_date_requested||null, preferred_start_date||null,
        preferred_days||null, funded_hours_type,
        parent_name, parent_email, parent_phone, source, notes, assigned_to||null]);
    const enq = rows[0];
    res.status(201).json(enq);
    // Dual-write into unified comms (fire-and-forget — never block the response)
    _dualWriteEnquiry(db, enq).catch(() => {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function _dualWriteEnquiry(db, enq) {
  const { upsertContact, upsertThread, insertThreadMessage, STAGE_TO_STATUS } =
    require('./contacts');
  const status = STAGE_TO_STATUS[enq.stage || 'new'] || 'enquirer';
  const contactId = await upsertContact(db, {
    email: enq.parent_email, phone: enq.parent_phone,
    name: enq.parent_name, status, enquiryId: enq.id,
  });
  const threadId = await upsertThread(
    db, contactId, `Enquiry: ${enq.child_first_name} ${enq.child_last_name || ''}`
  );
  const body = `Enquiry for ${enq.child_first_name} ${enq.child_last_name || ''}\nStage: ${enq.stage || 'new'}${enq.notes ? '\nNotes: '+enq.notes : ''}${enq.message ? '\nMessage: '+enq.message : ''}`;
  await insertThreadMessage(db, {
    threadId, direction: 'in', source: 'enquiry_form',
    bodyText: body, senderEmail: enq.parent_email, senderPhone: enq.parent_phone,
    createdAt: enq.created_at, enquiryId: enq.id,
  });
  const src = enq.source === 'wren_landing' ? 'Wren landing' : (enq.source === 'ladn_site' ? 'LADN website' : (enq.source || 'unknown'));
  _tgPing(`📬 *New enquiry* (${src})\nFrom: ${enq.parent_name || 'Unknown'} ${enq.parent_email ? `<${enq.parent_email}>` : ''}\n${enq.child_first_name ? `Child: ${enq.child_first_name} ${enq.child_last_name || ''}` : ''}${enq.message ? `\nMsg: ${enq.message.slice(0,120)}` : ''}`);
}

// PUT /:id — update fields
router.put('/:id', async (req, res) => {
  const { stage, notes, lost_reason, preferred_start_date, preferred_room,
          preferred_days, funded_hours_type, assigned_to,
          parent_name, parent_email, parent_phone, room_needed } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE enquiries SET
        stage=COALESCE($1,stage),
        notes=COALESCE($2,notes),
        lost_reason=COALESCE($3,lost_reason),
        preferred_start_date=COALESCE($4::date,preferred_start_date),
        preferred_room=COALESCE($5,preferred_room),
        preferred_days=COALESCE($6,preferred_days),
        funded_hours_type=COALESCE($7,funded_hours_type),
        assigned_to=COALESCE($8::int,assigned_to),
        parent_name=COALESCE($9,parent_name),
        parent_email=COALESCE($10,parent_email),
        parent_phone=COALESCE($11,parent_phone),
        room_needed=COALESCE($12,room_needed),
        updated_at=NOW()
      WHERE id=$13 RETURNING *
    `, [stage, notes, lost_reason, preferred_start_date||null, preferred_room,
        preferred_days||null, funded_hours_type, assigned_to||null,
        parent_name, parent_email, parent_phone, room_needed, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/move — explicit stage move
router.post('/:id/move', async (req, res) => {
  const { stage } = req.body;
  if (!stage) return res.status(400).json({ error: 'stage required' });
  const valid = ['new','tour_booked','tour_done','on_waiting_list','offer_made','offer_accepted','registered','declined','lost'];
  if (!valid.includes(stage)) return res.status(400).json({ error: 'Invalid stage' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE enquiries SET stage=$1, updated_at=NOW() WHERE id=$2 RETURNING *
    `, [stage, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
    // Dual-write: sync contact status when enquiry stage changes
    _dualWriteStageMove(db, rows[0], stage).catch(() => {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function _dualWriteStageMove(db, enq, stage) {
  const { STAGE_TO_STATUS } = require('./contacts');
  const newStatus = STAGE_TO_STATUS[stage] || 'enquirer';
  if (!enq.parent_email) return;
  const { rows } = await db.query(
    `SELECT id, status FROM ladn.contacts WHERE lower(primary_email)=$1`,
    [enq.parent_email.toLowerCase()]
  );
  if (!rows.length) return;
  const contact = rows[0];
  if (contact.status === newStatus) return;
  await db.query(
    `UPDATE ladn.contacts SET status=$1, status_changed_at=now() WHERE id=$2`,
    [newStatus, contact.id]
  );
  await db.query(
    `INSERT INTO ladn.contact_status_history
       (contact_id,from_status,to_status,changed_at,notes)
     VALUES ($1,$2,$3,now(),'synced from enquiry stage change')`,
    [contact.id, contact.status, newStatus]
  );
}

// POST /:id/convert-to-waiting-list
router.post('/:id/convert-to-waiting-list', async (req, res) => {
  try {
    const db = getPool();
    const { rows: enqRows } = await db.query(`SELECT * FROM enquiries WHERE id=$1`, [req.params.id]);
    if (!enqRows.length) return res.status(404).json({ error: 'Enquiry not found' });
    const e = enqRows[0];
    const { rows: wlRows } = await db.query(`
      INSERT INTO waiting_list (child_first_name, child_last_name, child_dob, room_needed,
        expected_start_date, parent_name, parent_email, parent_phone, source, notes, enquiry_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT DO NOTHING
      RETURNING *
    `, [e.child_first_name, e.child_last_name, e.child_dob,
        e.preferred_room || e.room_needed,
        e.preferred_start_date || e.start_date_requested,
        e.parent_name, e.parent_email, e.parent_phone, e.source, e.notes, e.id]);
    await db.query(`UPDATE enquiries SET stage='on_waiting_list', updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.status(201).json(wlRows[0] || { message: 'Already on waiting list' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /waiting-list — list waiting list
router.get('/waiting-list', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT wl.*, e.stage AS enquiry_stage
      FROM waiting_list wl
      LEFT JOIN enquiries e ON e.id = wl.enquiry_id
      WHERE wl.status != 'placed' OR wl.status IS NULL
      ORDER BY wl.priority ASC NULLS LAST, wl.date_added ASC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /waiting-list — create waiting list entry directly
router.post('/waiting-list', async (req, res) => {
  const { child_first_name, child_last_name, child_dob, room_needed,
          expected_start_date, parent_name, parent_email, parent_phone, source, notes, priority } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO waiting_list (child_first_name, child_last_name, child_dob, room_needed,
        expected_start_date, parent_name, parent_email, parent_phone, source, notes, priority)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [child_first_name, child_last_name, child_dob||null, room_needed,
        expected_start_date||null, parent_name, parent_email, parent_phone, source, notes, priority||3]);
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /waiting-list/:id/convert-to-child — create child record from waiting list
router.post('/waiting-list/:id/convert-to-child', async (req, res) => {
  try {
    const db = getPool();
    const { rows: wlRows } = await db.query(`SELECT * FROM waiting_list WHERE id=$1`, [req.params.id]);
    if (!wlRows.length) return res.status(404).json({ error: 'Waiting list entry not found' });
    const w = wlRows[0];
    const { room_id } = req.body;

    const { rows: childRows } = await db.query(`
      INSERT INTO children (first_name, last_name, date_of_birth, room_id, is_active)
      VALUES ($1,$2,$3,$4,true)
      RETURNING *
    `, [w.child_first_name, w.child_last_name, w.child_dob, room_id||null]);

    await db.query(`UPDATE waiting_list SET status='placed', updated_at=NOW() WHERE id=$1`, [req.params.id]);
    if (w.enquiry_id) {
      await db.query(`UPDATE enquiries SET stage='registered', updated_at=NOW() WHERE id=$1`, [w.enquiry_id]);
    }
    res.status(201).json(childRows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/reply — store reply, mark enquiry replied
router.post('/:id/reply', async (req, res) => {
  const { body } = req.body;
  if (!body) return res.status(400).json({ error: 'body required' });
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO ladn.enquiry_replies (enquiry_id, staff_id, body) VALUES ($1,$2,$3)`,
      [req.params.id, req.user.id, body]
    );
    await db.query(
      `UPDATE ladn.enquiries SET status='replied', replied_at=NOW(), replied_by=$1, updated_at=NOW() WHERE id=$2`,
      [req.user.id, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id — remove enquiry
router.delete('/:id', async (req, res) => {
  try {
    const db = getPool();
    await db.query(`DELETE FROM enquiries WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /stats-extended — 24-month trends + stage drop-off + time-in-stage
router.get('/stats-extended', async (req, res) => {
  try {
    const db = getPool();
    const monthKeys = [];
    for (let i = 23; i >= 0; i--) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      monthKeys.push(d.toISOString().slice(0, 7));
    }
    const [byMonth24, convByMonth, bySource, byStage, avgByStage] = await Promise.all([
      db.query(`
        SELECT TO_CHAR(created_at,'YYYY-MM') AS month, COUNT(*) AS total,
               COUNT(*) FILTER (WHERE stage='registered') AS registered
        FROM enquiries
        WHERE created_at >= NOW() - INTERVAL '24 months'
        GROUP BY month ORDER BY month
      `),
      db.query(`
        SELECT TO_CHAR(created_at,'YYYY-MM') AS month,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE stage IN ('registered','offer_accepted')) AS converted
        FROM enquiries
        WHERE created_at >= NOW() - INTERVAL '12 months'
        GROUP BY month ORDER BY month
      `),
      db.query(`
        SELECT COALESCE(source,'Unknown') AS source,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE stage='registered') AS converted
        FROM enquiries GROUP BY source ORDER BY total DESC
      `),
      db.query(`SELECT stage, COUNT(*) AS count FROM enquiries GROUP BY stage`),
      db.query(`
        SELECT stage,
               ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at))/86400)::numeric,1) AS avg_days
        FROM enquiries
        WHERE stage NOT IN ('new','declined','lost')
        GROUP BY stage
      `),
    ]);
    res.json({
      byMonth24: byMonth24.rows,
      convByMonth: convByMonth.rows,
      bySource: bySource.rows,
      byStage: byStage.rows,
      avgDaysByStage: avgByStage.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /forecast-extended — 12-month weighted/optimistic/pessimistic scenarios
router.get('/forecast-extended', async (req, res) => {
  try {
    const db = getPool();
    const STAGE_WEIGHTS = {
      registered: 0.95, offer_accepted: 0.85, offer_made: 0.55,
      on_waiting_list: 0.35, tour_done: 0.25, tour_booked: 0.15,
      new: 0.08,
    };
    const [rooms, enrolled, pipeline, leavers] = await Promise.all([
      db.query(`SELECT id, name, capacity FROM rooms ORDER BY id`),
      db.query(`
        SELECT c.room_id, COUNT(*) AS enrolled
        FROM children c WHERE c.is_active=true GROUP BY c.room_id
      `),
      db.query(`
        SELECT COALESCE(preferred_room, room_needed) AS room_name,
               TO_CHAR(COALESCE(preferred_start_date, start_date_requested),'YYYY-MM') AS month,
               stage, COUNT(*) AS cnt
        FROM enquiries
        WHERE stage NOT IN ('registered','declined','lost')
          AND COALESCE(preferred_start_date, start_date_requested) BETWEEN NOW() AND NOW()+INTERVAL '12 months'
        GROUP BY room_name, month, stage
      `),
      db.query(`
        SELECT c.room_id, TO_CHAR(c.date_of_birth + INTERVAL '5 years','YYYY-MM') AS month, COUNT(*) AS cnt
        FROM children c WHERE c.is_active=true
          AND c.date_of_birth + INTERVAL '5 years' BETWEEN NOW() AND NOW()+INTERVAL '12 months'
        GROUP BY c.room_id, month
      `),
    ]);
    const months = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + i);
      months.push(d.toISOString().slice(0, 7));
    }
    const enrolledByRoom = {};
    enrolled.rows.forEach(r => { enrolledByRoom[r.room_id] = parseInt(r.enrolled); });
    const leaversByRoomMonth = {};
    leavers.rows.forEach(r => { leaversByRoomMonth[`${r.room_id}:${r.month}`] = parseInt(r.cnt); });

    const result = months.map(month => {
      const roomData = rooms.rows.map(room => {
        const base = enrolledByRoom[room.id] || 0;
        const leavingThisMonth = leaversByRoomMonth[`${room.id}:${month}`] || 0;
        const monthPipeline = pipeline.rows.filter(p => p.room_name === room.name && p.month === month);
        let weightedStarters = 0, optimisticStarters = 0, pessimisticStarters = 0;
        monthPipeline.forEach(p => {
          const cnt = parseInt(p.cnt);
          const w = STAGE_WEIGHTS[p.stage] || 0.1;
          weightedStarters += cnt * w;
          optimisticStarters += cnt;
          pessimisticStarters += p.stage === 'offer_accepted' || p.stage === 'registered' ? cnt : 0;
        });
        const realistic = Math.round(Math.max(0, base - leavingThisMonth + weightedStarters));
        const optimistic = Math.round(Math.max(0, base - leavingThisMonth + optimisticStarters));
        const pessimistic = Math.round(Math.max(0, base - leavingThisMonth + pessimisticStarters));
        return {
          room_id: room.id, room_name: room.name, capacity: room.capacity,
          base, leavers: leavingThisMonth,
          realistic, optimistic, pessimistic,
          realistic_pct: room.capacity ? Math.round(realistic / room.capacity * 100) : 0,
          optimistic_pct: room.capacity ? Math.round(optimistic / room.capacity * 100) : 0,
          pessimistic_pct: room.capacity ? Math.round(pessimistic / room.capacity * 100) : 0,
        };
      });
      return { month, rooms: roomData };
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /occupancy-grid — EYworks-pattern grid: attendance by week×day×session×room
router.get('/occupancy-grid', async (req, res) => {
  try {
    const db = getPool();
    const { from, to, group_by = 'week' } = req.query;
    const fromDate = from || new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
    const toDate = to || new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10);

    const [roomsRes, gridRes] = await Promise.all([
      db.query(`SELECT id, name, capacity FROM rooms ORDER BY id`),
      db.query(`
        SELECT
          DATE_TRUNC($3, a.date)::date AS period_start,
          a.date,
          c.room_id,
          r.name AS room_name,
          r.capacity,
          COALESCE(a.session,'full_day') AS session,
          COUNT(DISTINCT a.child_id) FILTER (WHERE NOT COALESCE(a.absent,false)) AS places_occupied,
          COUNT(DISTINCT a.child_id) AS children_booked
        FROM attendance a
        JOIN children c ON c.id = a.child_id AND c.is_active = true
        JOIN rooms r ON r.id = c.room_id
        WHERE a.date BETWEEN $1::date AND $2::date
        GROUP BY period_start, a.date, c.room_id, r.name, r.capacity, COALESCE(a.session,'full_day')
        ORDER BY a.date, c.room_id, COALESCE(a.session,'full_day')
      `, [fromDate, toDate, group_by === 'month' ? 'month' : 'week']),
    ]);

    const rooms = roomsRes.rows;
    const periodMap = {};
    gridRes.rows.forEach(row => {
      const pKey = row.period_start;
      if (!periodMap[pKey]) periodMap[pKey] = { period_start: pKey, days: {} };
      const dKey = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10);
      if (!periodMap[pKey].days[dKey]) periodMap[pKey].days[dKey] = {};
      const rKey = `${row.room_id}:${row.session}`;
      periodMap[pKey].days[dKey][rKey] = {
        room_id: row.room_id, room_name: row.room_name,
        session: row.session, capacity: parseInt(row.capacity) || 0,
        places_occupied: parseInt(row.places_occupied) || 0,
        children_booked: parseInt(row.children_booked) || 0,
      };
    });
    res.json({ rooms, periods: Object.values(periodMap).sort((a, b) => a.period_start < b.period_start ? -1 : 1) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /occupancy-session — children attending a specific date/session/room
router.get('/occupancy-session', async (req, res) => {
  try {
    const db = getPool();
    const { date, session, room_id } = req.query;
    if (!date) return res.status(400).json({ error: 'date required' });
    const { rows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.date_of_birth,
             a.session, a.absent, a.sign_in_time, a.sign_out_time,
             r.name AS room_name
      FROM attendance a
      JOIN children c ON c.id = a.child_id
      JOIN rooms r ON r.id = c.room_id
      WHERE a.date = $1::date
        AND ($2::text IS NULL OR a.session = $2)
        AND ($3::int IS NULL OR c.room_id = $3::int)
      ORDER BY c.first_name, c.last_name
    `, [date, session || null, room_id || null]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /ai-scores — waiting list with AI scores
router.get('/ai-scores', async (req, res) => {
  try {
    const db = getPool();
    const [enquiriesRes, roomsRes, childrenRes] = await Promise.all([
      db.query(`
        SELECT e.*,
               EXTRACT(DAY FROM NOW() - e.created_at) AS days_waiting
        FROM enquiries e
        WHERE e.stage NOT IN ('registered','declined','lost')
        ORDER BY e.ai_score DESC NULLS LAST, e.created_at ASC
      `),
      db.query(`SELECT id, name, capacity FROM rooms`),
      db.query(`SELECT room_id, COUNT(*) AS enrolled FROM children WHERE is_active=true GROUP BY room_id`),
    ]);
    const roomCap = {};
    roomsRes.rows.forEach(r => { roomCap[r.name] = { capacity: r.capacity, id: r.id }; });
    const enrolled = {};
    childrenRes.rows.forEach(r => { enrolled[r.room_id] = parseInt(r.enrolled); });
    const withContext = enquiriesRes.rows.map(e => {
      const roomName = e.preferred_room || e.room_needed || '';
      const roomInfo = roomCap[roomName] || {};
      const cap = roomInfo.capacity || 0;
      const enr = enrolled[roomInfo.id] || 0;
      return { ...e, room_capacity: cap, room_enrolled: enr, room_spaces: Math.max(0, cap - enr) };
    });
    res.json(withContext);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/ai-score — compute and save AI score for one enquiry
router.post('/:id/ai-score', async (req, res) => {
  try {
    const db = getPool();
    const { rows: enqRows } = await db.query(`SELECT * FROM enquiries WHERE id=$1`, [req.params.id]);
    if (!enqRows.length) return res.status(404).json({ error: 'Not found' });
    const e = enqRows[0];

    const roomName = e.preferred_room || e.room_needed || '';
    const [roomRes, siblingRes, childrenRes] = await Promise.all([
      db.query(`SELECT id, capacity FROM rooms WHERE name=$1`, [roomName]),
      db.query(`SELECT COUNT(*) AS cnt FROM children WHERE last_name=$1 AND is_active=true`, [e.child_last_name]),
      db.query(`SELECT COUNT(*) AS enrolled FROM children c JOIN rooms r ON r.id=c.room_id WHERE r.name=$1 AND c.is_active=true`, [roomName]),
    ]);
    const room = roomRes.rows[0];
    const hasSibling = parseInt(siblingRes.rows[0]?.cnt || 0) > 0;
    const enrolled = parseInt(childrenRes.rows[0]?.enrolled || 0);
    const capacity = room?.capacity || 0;
    const spaces = Math.max(0, capacity - enrolled);
    const daysWaiting = Math.floor((Date.now() - new Date(e.created_at).getTime()) / 86400000);
    const childAgeMonths = e.child_dob ? Math.floor((Date.now() - new Date(e.child_dob).getTime()) / (30.44 * 86400000)) : null;
    const hasFunding = e.funded_hours_type && e.funded_hours_type !== 'none';

    let score = 0;
    let reasons = [];

    if (spaces > 0) { score += 20; reasons.push(`${spaces} space${spaces>1?'s':''} available`); }
    else { score += 5; reasons.push('Room at capacity (waitlist)'); }
    if (hasSibling) { score += 18; reasons.push('Sibling already enrolled'); }
    if (hasFunding) { score += 15; reasons.push(`Eligible for funded hours (${e.funded_hours_type})`); }
    else { score += 5; }
    if (daysWaiting > 90) { score += 15; reasons.push(`${daysWaiting}d on waiting list`); }
    else if (daysWaiting > 30) { score += 10; reasons.push(`${daysWaiting}d on waiting list`); }
    else { score += 5; }
    if (childAgeMonths !== null) {
      if (roomName === 'Baby Room' && childAgeMonths >= 6 && childAgeMonths <= 24) { score += 20; reasons.push('Ideal age for Baby Room'); }
      else if (roomName === 'Pre-school' && childAgeMonths >= 24 && childAgeMonths <= 60) { score += 20; reasons.push('Ideal age for Pre-school'); }
      else if (childAgeMonths > 0) { score += 8; reasons.push('Age partially matches room range'); }
    }
    if (e.parent_email && e.parent_phone) { score += 7; reasons.push('Full contact details provided'); }
    else if (e.parent_email || e.parent_phone) { score += 3; }
    if (e.notes && e.notes.length > 20) { score += 5; reasons.push('Detailed notes on record'); }

    score = Math.min(100, score);
    const reason = reasons.join('. ') + '.';
    await db.query(`
      UPDATE enquiries SET ai_score=$1, ai_score_reason=$2, ai_score_updated_at=NOW(),
        ai_score_override=false WHERE id=$3
    `, [score, reason, req.params.id]);
    res.json({ id: parseInt(req.params.id), score, reason });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/score-override — manager override with reason (audit logged)
router.post('/:id/score-override', async (req, res) => {
  const { score, reason } = req.body;
  if (score === undefined || !reason) return res.status(400).json({ error: 'score and reason required' });
  try {
    const db = getPool();
    await db.query(`
      UPDATE enquiries SET ai_score=$1, ai_score_reason=$2, ai_score_updated_at=NOW(),
        ai_score_override=true, ai_score_override_reason=$2, ai_score_override_by=$3
      WHERE id=$4
    `, [score, reason, req.user.id, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /score-all — score up to 30 waiting-list enquiries
router.post('/score-all', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT id FROM enquiries
      WHERE stage NOT IN ('registered','declined','lost') AND ai_score IS NULL
      ORDER BY created_at ASC LIMIT 30
    `);
    const results = [];
    for (const row of rows) {
      try {
        const enq = await db.query(`SELECT * FROM enquiries WHERE id=$1`, [row.id]);
        if (!enq.rows.length) continue;
        const e = enq.rows[0];
        const roomName = e.preferred_room || e.room_needed || '';
        const [roomRes, sibRes, chrRes] = await Promise.all([
          db.query(`SELECT id, capacity FROM rooms WHERE name=$1`, [roomName]),
          db.query(`SELECT COUNT(*) AS cnt FROM children WHERE last_name=$1 AND is_active=true`, [e.child_last_name]),
          db.query(`SELECT COUNT(*) AS enrolled FROM children c JOIN rooms r ON r.id=c.room_id WHERE r.name=$1 AND c.is_active=true`, [roomName]),
        ]);
        const hasSibling = parseInt(sibRes.rows[0]?.cnt || 0) > 0;
        const enrolled = parseInt(chrRes.rows[0]?.enrolled || 0);
        const cap = roomRes.rows[0]?.capacity || 0;
        const spaces = Math.max(0, cap - enrolled);
        const daysWaiting = Math.floor((Date.now() - new Date(e.created_at).getTime()) / 86400000);
        const ageMonths = e.child_dob ? Math.floor((Date.now() - new Date(e.child_dob).getTime()) / (30.44 * 86400000)) : null;
        const hasFunding = e.funded_hours_type && e.funded_hours_type !== 'none';
        let score = 0;
        const reasons = [];
        if (spaces > 0) { score += 20; reasons.push(`${spaces} space${spaces>1?'s':''} available`); } else { score += 5; reasons.push('Room at capacity'); }
        if (hasSibling) { score += 18; reasons.push('Sibling enrolled'); }
        if (hasFunding) { score += 15; reasons.push(`Funded hours eligible (${e.funded_hours_type})`); } else { score += 5; }
        if (daysWaiting > 90) { score += 15; reasons.push(`${daysWaiting}d waiting`); } else if (daysWaiting > 30) { score += 10; } else { score += 5; }
        if (ageMonths !== null) {
          if (roomName === 'Baby Room' && ageMonths >= 6 && ageMonths <= 24) { score += 20; reasons.push('Ideal age for Baby Room'); }
          else if (roomName === 'Pre-school' && ageMonths >= 24 && ageMonths <= 60) { score += 20; reasons.push('Ideal age for Pre-school'); }
          else { score += 8; }
        }
        if (e.parent_email && e.parent_phone) { score += 7; }
        if (e.notes && e.notes.length > 20) { score += 5; }
        score = Math.min(100, score);
        await db.query(`UPDATE enquiries SET ai_score=$1, ai_score_reason=$2, ai_score_updated_at=NOW(), ai_score_override=false WHERE id=$3`,
          [score, reasons.join('. '), e.id]);
        results.push({ id: e.id, score });
      } catch {}
    }
    res.json({ scored: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /import-waiting-list — bulk import from an EyLog enquiry/waitlist CSV ──
// Body = raw CSV (Content-Type text/csv). Maps EyLog export headers -> ladn.waiting_list.
// Idempotent: skips rows already present (same child name + DOB). Manager-only.
function _wlParseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (q) { if (c === '"' && n === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r' && n === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; }
    else if (c === '\n' || c === '\r') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  row.push(field); if (row.some(f => f !== '')) rows.push(row);
  return rows.filter(r => r.some(c => c.trim() !== ''));
}
function _wlDate(s) {
  if (!s) return null; s = String(s).trim(); if (!s) return null;
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) { let y = m[3]; if (y.length === 2) y = '20' + y; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0, 10);
}
function _wlStatus(statusRaw, waitlistedRaw) {
  const s = (statusRaw || '').toLowerCase(), w = (waitlistedRaw || '').toLowerCase();
  if (/enrol|register|placed|accepted/.test(s)) return 'placed';
  if (/lost|declin|cancel|withdraw/.test(s)) return 'lost';
  if (/wait/.test(s) || /yes|true|^1$/.test(w)) return 'waiting';
  return s || 'waiting';
}
router.post('/import-waiting-list', authenticate, express.text({ type: () => true, limit: '20mb' }), async (req, res) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user?.role)) return res.status(403).json({ error: 'Manager only' });
  const text = typeof req.body === 'string' ? req.body : ((req.body && req.body.csv) || '');
  if (!text || text.length < 10) return res.status(400).json({ error: 'No CSV provided' });
  try {
    const rows = _wlParseCSV(text);
    if (rows.length < 2) return res.status(400).json({ error: 'CSV has no data rows' });
    const headers = rows[0].map(h => h.trim().toLowerCase());
    const idx = nm => headers.indexOf(nm.toLowerCase());
    const cell = (r, ...names) => { for (const nm of names) { const i = idx(nm); if (i >= 0 && r[i] != null && String(r[i]).trim() !== '') return String(r[i]).trim(); } return null; };
    const db = getPool();
    let imported = 0, skipped = 0;
    for (let k = 1; k < rows.length; k++) {
      const r = rows[k];
      const fn = cell(r, 'Child First Name'), ln = cell(r, 'Child Last Name');
      if (!fn && !ln) { skipped++; continue; }
      const dob = _wlDate(cell(r, 'Child Date of Birth/Expected Date of Birth', 'Child Date of Birth', 'Child DOB'));
      const { rows: ex } = await db.query(
        `SELECT 1 FROM waiting_list WHERE lower(child_first_name)=lower($1)
           AND lower(coalesce(child_last_name,''))=lower(coalesce($2,''))
           AND coalesce(child_dob::text,'')=coalesce($3::text,'') LIMIT 1`, [fn, ln, dob]);
      if (ex.length) { skipped++; continue; }
      const parent = [cell(r, 'Parent First Name'), cell(r, 'Parent Last Name')].filter(Boolean).join(' ') || null;
      const notes = [
        cell(r, 'Stage') && `Stage: ${cell(r, 'Stage')}`,
        cell(r, 'Reason') && `Reason: ${cell(r, 'Reason')}`,
        cell(r, 'Requested Hours') && `Hours: ${cell(r, 'Requested Hours')}`,
        cell(r, 'Booking Type') && `Booking: ${cell(r, 'Booking Type')}`,
        cell(r, 'Attendance Schedule') && `Schedule: ${cell(r, 'Attendance Schedule')}`,
        cell(r, 'Preferred Session') && `Session: ${cell(r, 'Preferred Session')}`,
        cell(r, 'Tags') && `Tags: ${cell(r, 'Tags')}`,
        cell(r, 'Notes'),
      ].filter(Boolean).join(' · ') || null;
      await db.query(
        `INSERT INTO waiting_list (child_first_name, child_last_name, child_dob, room_needed,
           expected_start_date, parent_name, parent_email, parent_phone, source, status, notes, date_added, added_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($12,NOW()),NOW())`,
        [fn, ln, dob, cell(r, 'Waitlisted Room', 'Room'), _wlDate(cell(r, 'Preferred Start Date')),
         parent, cell(r, 'Parent Email'), cell(r, 'Parent Phone', 'Home Phone'),
         cell(r, 'Where did Parent hear about us? (Source)', 'Source', 'Utm Source'),
         _wlStatus(cell(r, 'Status'), cell(r, 'Waitlisted')), notes,
         _wlDate(cell(r, 'Waitlisted Date', 'Enquiry Date'))]);
      imported++;
    }
    res.json({ ok: true, imported, skipped, total: rows.length - 1 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
