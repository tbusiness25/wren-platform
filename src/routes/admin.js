const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { getAllowedEmails } = require('../lib/email-allowlist');

router.use(authenticate);

// Admin-level roles across editions: nursery (manager/deputy_manager/admin) +
// school (headteacher/business_manager). Adding the school roles is a no-op for
// LADN/EYFS (no staff hold them) and unlocks the admin SPA on primary/secondary.
const ADMIN_ROLES = ['manager','deputy_manager','admin','headteacher','business_manager'];
const managerOnly = (req, res, next) => {
  if (!ADMIN_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};

// GET /parent-emails — full deduped, sorted parent-recipient allowlist (manager
// only). Used by scripts/sync-gmail-allowlist.js to mirror the list into Google
// Workspace. Returns addresses (this is the whole point of the endpoint) but is
// gated to managers; never log these beyond a count.
router.get('/parent-emails', managerOnly, async (req, res) => {
  try {
    const emails = await getAllowedEmails();
    res.json({ count: emails.length, emails });
  } catch (e) {
    console.error('admin parent-emails error:', e.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /overview — full dashboard data
router.get('/overview', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const safeCount = async (sql, params=[]) => {
      try { const r = await db.query(sql, params); return parseInt(r.rows[0]?.count||0); } catch { return 0; }
    };

    const [enrolled, staffCount, presentToday, pendingAbsences, openSafeguarding, staffIn] = await Promise.all([
      safeCount('SELECT COUNT(*) FROM children WHERE is_active=true'),
      safeCount('SELECT COUNT(*) FROM staff WHERE is_active=true'),
      safeCount(`SELECT COUNT(*) FROM attendance WHERE date=CURRENT_DATE AND absent=false`),
      safeCount(`SELECT COUNT(*) FROM absence_requests WHERE status='pending'`),
      safeCount(`SELECT COUNT(*) FROM safeguarding_concerns WHERE status='open'`),
      safeCount(`SELECT COUNT(*) FROM staff_attendance WHERE date=CURRENT_DATE AND clock_in IS NOT NULL`)
    ]);

    // Outstanding invoices (graceful — table may not exist)
    let outstandingInvoices = 0;
    try {
      const inv = await db.query(`SELECT COALESCE(SUM(amount_due),0) as total FROM invoices WHERE status='outstanding'`);
      outstandingInvoices = parseFloat(inv.rows[0]?.total||0);
    } catch {}

    // Room stats
    const { rows: rooms } = await db.query(`
      SELECT r.name, r.capacity,
        COUNT(c.id) FILTER (WHERE c.is_active) as enrolled,
        COUNT(a.id) FILTER (WHERE a.date=CURRENT_DATE AND NOT a.absent) as present
      FROM rooms r
      LEFT JOIN children c ON c.room_id = r.id
      LEFT JOIN attendance a ON a.child_id = c.id
      GROUP BY r.id, r.name, r.capacity ORDER BY r.id
    `).catch(() => ({ rows: [] }));

    // Financial estimate (enrolled × £800/month average)
    const monthlyEstimate = enrolled * 800;

    // Upcoming events (next 14 days from term_plans + supervisions + approved absences)
    let upcomingEvents = [];
    try {
      const tp = await db.query(`
        SELECT id, title, events FROM term_plans
        WHERE date_trunc('week', NOW()) <= end_date
        ORDER BY start_date LIMIT 5
      `);
      for (const plan of tp.rows) {
        if (plan.events && Array.isArray(plan.events)) {
          plan.events.filter(e => {
            const d = new Date(e.date||e.start); return d >= new Date() && d <= new Date(Date.now()+14*86400000);
          }).forEach(e => upcomingEvents.push({ type:'event', title:e.title||e.name, date:e.date||e.start }));
        }
      }
    } catch {}
    try {
      const sups = await db.query(`
        SELECT s.scheduled_date, st.first_name||' '||st.last_name as staff_name
        FROM supervisions s
        JOIN staff st ON st.id=s.staff_id
        WHERE s.scheduled_date BETWEEN CURRENT_DATE AND CURRENT_DATE+14
          AND s.status IN ('scheduled','pending')
        ORDER BY s.scheduled_date LIMIT 10
      `);
      sups.rows.forEach(r => upcomingEvents.push({ type:'supervision', title:`Supervision: ${r.staff_name}`, date:r.scheduled_date }));
    } catch {}
    try {
      const abs = await db.query(`
        SELECT ar.start_date, ar.end_date, s.first_name||' '||s.last_name as staff_name, ar.request_type
        FROM absence_requests ar
        JOIN staff s ON s.id=ar.staff_id
        WHERE ar.status='approved' AND ar.start_date BETWEEN CURRENT_DATE AND CURRENT_DATE+14
        ORDER BY ar.start_date LIMIT 10
      `);
      abs.rows.forEach(r => upcomingEvents.push({ type:'absence', title:`${r.staff_name} — ${(r.request_type||'leave').replace(/_/g,' ')}`, date:r.start_date }));
    } catch {}
    upcomingEvents.sort((a,b) => new Date(a.date)-new Date(b.date));

    // Compliance: DBS, training, supervisions
    let compliance = { dbs:{red:0,amber:0,green:0}, training:{red:0,amber:0,green:0}, supervisions:{red:0,amber:0,green:0} };
    try {
      const dbsRows = await db.query(`SELECT dbs_expiry FROM staff WHERE is_active=true AND dbs_expiry IS NOT NULL`);
      dbsRows.rows.forEach(r => {
        const d = new Date(r.dbs_expiry); const days = Math.floor((d-new Date())/86400000);
        if (days < 0) compliance.dbs.red++;
        else if (days < 90) compliance.dbs.amber++;
        else compliance.dbs.green++;
      });
      const noDbsCount = await safeCount('SELECT COUNT(*) FROM staff WHERE is_active=true AND dbs_expiry IS NULL');
      compliance.dbs.red += noDbsCount;
    } catch {}
    try {
      const trainRows = await db.query(`
        SELECT COUNT(*) FILTER (WHERE expiry_date < CURRENT_DATE) as expired,
               COUNT(*) FILTER (WHERE expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE+90) as expiring,
               COUNT(*) FILTER (WHERE expiry_date IS NULL OR expiry_date > CURRENT_DATE+90) as valid
        FROM cpd_records WHERE is_mandatory=true
      `);
      compliance.training.red = parseInt(trainRows.rows[0]?.expired||0);
      compliance.training.amber = parseInt(trainRows.rows[0]?.expiring||0);
      compliance.training.green = parseInt(trainRows.rows[0]?.valid||0);
    } catch {}
    try {
      const supRows = await db.query(`
        SELECT s.id FROM staff s
        WHERE s.is_active=true
          AND NOT EXISTS (
            SELECT 1 FROM supervisions sv WHERE sv.staff_id=s.id
              AND sv.scheduled_date >= CURRENT_DATE - INTERVAL '3 months'
              AND sv.status='completed'
          )
      `);
      compliance.supervisions.amber = supRows.rows.length;
      const totalActiveStaff = await safeCount('SELECT COUNT(*) FROM staff WHERE is_active=true');
      compliance.supervisions.green = Math.max(0, totalActiveStaff - supRows.rows.length);
    } catch {}

    // DBS expiry list (for compact alert panel)
    const { rows: dbsExpiring } = await db.query(`
      SELECT first_name, last_name, dbs_expiry FROM staff
      WHERE is_active=true AND dbs_expiry IS NOT NULL
        AND dbs_expiry < CURRENT_DATE + INTERVAL '60 days'
      ORDER BY dbs_expiry
    `).catch(() => ({ rows: [] }));

    // New enquiries (last 7 days)
    let newEnquiries = { count: 0, items: [] };
    try {
      const enq = await db.query(`
        SELECT id, first_name||' '||last_name as name, stage, created_at
        FROM enquiries WHERE created_at > CURRENT_DATE-7 ORDER BY created_at DESC LIMIT 10
      `);
      newEnquiries = { count: enq.rows.length, items: enq.rows };
    } catch {}

    // Unread parent messages
    let unreadMessages = { count: 0, threads: [] };
    try {
      const msgs = await db.query(`
        SELECT t.id, t.subject, t.last_message_at,
          c.first_name||' '||c.last_name as child_name,
          COUNT(m.id) FILTER (WHERE m.is_read=false AND m.sender_type='parent') as unread
        FROM message_threads t
        JOIN children c ON c.id=t.child_id
        LEFT JOIN messages m ON m.thread_id=t.id
        WHERE t.recipient_type != 'staff_group' OR t.recipient_type IS NULL
        GROUP BY t.id, t.subject, t.last_message_at, c.first_name, c.last_name
        HAVING COUNT(m.id) FILTER (WHERE m.is_read=false AND m.sender_type='parent') > 0
        ORDER BY t.last_message_at DESC LIMIT 5
      `);
      unreadMessages = { count: msgs.rows.reduce((s,r)=>s+parseInt(r.unread||0),0), threads: msgs.rows };
    } catch {}

    res.json({
      stats: {
        present: presentToday,
        enrolled,
        staff_in: staffIn,
        pending_absences: pendingAbsences,
        open_safeguarding: openSafeguarding,
        outstanding_invoices: outstandingInvoices
      },
      financial: { monthly_estimate: monthlyEstimate, enrolled_count: enrolled },
      upcoming_events: upcomingEvents.slice(0, 15),
      compliance,
      new_enquiries: newEnquiries,
      unread_messages: unreadMessages,
      // Legacy fields kept for backward compat
      children: enrolled,
      staff: staffCount,
      present_today: presentToday,
      open_incidents: 0,
      pending_absences: pendingAbsences,
      rooms: rooms.rows || rooms,
      dbs_expiring: dbsExpiring
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /occupancy
router.get('/occupancy', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT r.id, r.name, r.capacity, r.min_age_months, r.max_age_months,
        COUNT(c.id) FILTER (WHERE c.is_active) as enrolled,
        COUNT(a.id) FILTER (WHERE a.date=CURRENT_DATE AND NOT a.absent) as present_today
      FROM rooms r
      LEFT JOIN children c ON c.room_id = r.id
      LEFT JOIN attendance a ON a.child_id = c.id
      GROUP BY r.id ORDER BY r.id
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /staff — staff list with CPD summary
router.get('/staff', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT s.id, s.first_name, s.last_name, s.role, s.room_id,
             s.contracted_hours, s.employment_type, s.dbs_expiry,
             s.is_active, r.name as room_name,
             (SELECT COUNT(*) FROM cpd_records cp WHERE cp.staff_id=s.id AND cp.is_mandatory=true
              AND (cp.expiry_date IS NULL OR cp.expiry_date > CURRENT_DATE)) as mandatory_cpd_count
      FROM staff s
      LEFT JOIN rooms r ON r.id = s.room_id
      WHERE s.is_active=true
      ORDER BY s.first_name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /children — children register
router.get('/children', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.*, r.name as room_name,
             s.first_name || ' ' || s.last_name as key_person_name,
             CASE WHEN sr.id IS NOT NULL AND sr.is_active=true THEN true ELSE false END as is_on_sen_register,
             sr.sen_type
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN staff s ON s.id = c.key_person_id
      LEFT JOIN sen_register sr ON sr.child_id = c.id
      WHERE c.is_active=true
      ORDER BY r.name, c.first_name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /staff/:id
router.put('/staff/:id', managerOnly, async (req, res) => {
  const { role, room_id, contracted_hours, is_active, dbs_expiry } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE staff SET
        role=COALESCE($1,role),
        room_id=COALESCE($2,room_id),
        contracted_hours=COALESCE($3,contracted_hours),
        is_active=COALESCE($4,is_active),
        dbs_expiry=COALESCE($5,dbs_expiry),
        updated_at=NOW()
      WHERE id=$6 RETURNING id,first_name,last_name,role,room_id
    `, [role, room_id, contracted_hours, is_active, dbs_expiry, req.params.id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /sync-cf — manual CF allowlist sync
router.post('/sync-cf', managerOnly, async (req, res) => {
  try {
    const { syncCFAllowlist } = require('../../scripts/sync-cf-allowlist');
    const n = await syncCFAllowlist();
    res.json({ ok: true, synced: n });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// GET /rooms — list all rooms with capacity
router.get('/rooms', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM rooms ORDER BY id');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /rooms/:id/children — children in a room
router.get('/rooms/:id/children', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT id, first_name, last_name, date_of_birth, funded_hours FROM children WHERE room_id=$1 AND is_active=true ORDER BY first_name',
      [req.params.id]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /enquiries/waiting-list-count
router.get('/waiting-list-count', async (req, res) => {
  try {
    const db = getPool();
    // Optional tier filter: ?tier=active|parked (default active)
    const tier = (req.query.tier || 'active').toLowerCase();
    const valid = ['active', 'parked'];
    const tierFilter = valid.includes(tier) ? `AND tier='${tier}'` : '';
    const { rows } = await db.query(`SELECT COUNT(*) as count FROM waiting_list WHERE status='active' ${tierFilter}`);
    res.json({ count: parseInt(rows[0].count) });
  } catch(e) { res.json({ count: 0 }); }
});

// GET /settings — all settings as key/value object
router.get('/settings', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT key, value FROM settings ORDER BY key');
    const obj = {};
    rows.forEach(r => { obj[r.key] = r.value; });
    res.json(obj);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /settings — update key/value pairs
router.post('/settings', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const updates = req.body; // { key: value, ... }
    for (const [key, value] of Object.entries(updates)) {
      await db.query(
        'INSERT INTO settings(key,value,updated_by,updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT(key) DO UPDATE SET value=$2, updated_by=$3, updated_at=NOW()',
        [key, String(value), req.user.id]
      );
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /rooms — all rooms for editing
router.get('/rooms', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM rooms ORDER BY id');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /rooms/:id — update room display name and capacity
router.put('/rooms/:id', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { display_name, capacity } = req.body;
    const { rows } = await db.query(
      `UPDATE rooms SET
         display_name = COALESCE($1, display_name),
         capacity     = COALESCE($2, capacity)
       WHERE id = $3 RETURNING *`,
      [display_name || null, capacity ? parseInt(capacity) : null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Room not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /backup-status — backup system health
router.get('/backup-status', managerOnly, async (req, res) => {
  const { execSync } = require('child_process');
  try {
    const snapDir = '/home/toby/wren-backups/snapshots';
    const rawSnaps = execSync(`ls -dt ${snapDir}/daily-* 2>/dev/null | head -7 || true`, { encoding: 'utf8' }).trim();
    const snapshots = rawSnaps ? rawSnaps.split('\n').filter(Boolean) : [];
    const latestSize = snapshots[0]
      ? execSync(`du -sh ${snapshots[0]} 2>/dev/null | awk '{print $1}'`, { encoding: 'utf8' }).trim()
      : null;
    const latestDate = snapshots[0] ? snapshots[0].replace(/.*daily-/, '') : null;
    const totalSize = snapshots.length
      ? execSync(`du -sh ${snapDir} 2>/dev/null | awk '{print $1}'`, { encoding: 'utf8' }).trim()
      : '0';
    const usbMounted = execSync('mountpoint -q /media/wren-backup 2>/dev/null && echo yes || echo no', { encoding: 'utf8' }).trim() === 'yes';
    const lastLog = execSync("tail -8 /var/log/wren-backup.log 2>/dev/null || echo 'No backup log found'", { encoding: 'utf8' }).trim();
    const weeklySnaps = execSync(`ls -dt ${snapDir}/weekly-* 2>/dev/null | wc -l || echo 0`, { encoding: 'utf8' }).trim();
    res.json({
      snapshots: snapshots.length,
      weekly_snapshots: parseInt(weeklySnaps),
      latest_date: latestDate,
      latest_size: latestSize,
      total_size: totalSize,
      usb_mounted: usbMounted,
      last_log: lastLog,
      next_run: '02:00 nightly (cron)',
    });
  } catch (e) {
    res.json({ error: e.message, snapshots: 0, usb_mounted: false, last_log: 'Error reading backup status' });
  }
});

let backupRunning = false;

// POST /run-backup — trigger backup manually
router.post('/run-backup', managerOnly, async (req, res) => {
  if (backupRunning) {
    return res.status(409).json({ error: 'Backup already in progress. Check status in a moment.' });
  }
  const { exec } = require('child_process');
  const script = '/home/toby/wren/scripts/backup.sh';
  backupRunning = true;
  exec(`bash ${script} >> /var/log/wren-backup.log 2>&1`, (err) => {
    backupRunning = false;
    if (err) console.error('Backup error:', err.message);
  });
  res.json({ ok: true, message: 'Backup started in background — check status in ~60 seconds' });
});

// GET /invoice-summary — for dashboard
router.get('/invoice-summary', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const [outstanding, paid, overdue] = await Promise.all([
      db.query(`SELECT COUNT(*) as count, COALESCE(SUM(total_due),0) as total FROM invoices WHERE status='sent'`).catch(() => ({ rows: [{ count: 0, total: 0 }] })),
      db.query(`SELECT COUNT(*) as count, COALESCE(SUM(total_due),0) as total FROM invoices WHERE status='paid' AND paid_at > NOW()-INTERVAL '30 days'`).catch(() => ({ rows: [{ count: 0, total: 0 }] })),
      db.query(`SELECT COUNT(*) as count, COALESCE(SUM(total_due),0) as total FROM invoices WHERE status='overdue'`).catch(() => ({ rows: [{ count: 0, total: 0 }] })),
    ]);
    res.json({
      outstanding: { count: parseInt(outstanding.rows[0].count), total: parseFloat(outstanding.rows[0].total) },
      paid_this_month: { count: parseInt(paid.rows[0].count), total: parseFloat(paid.rows[0].total) },
      overdue: { count: parseInt(overdue.rows[0].count), total: parseFloat(overdue.rows[0].total) },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /invoices — list all invoices
router.get('/invoices', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { status, child_id } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (status) { params.push(status); where += ` AND i.status=$${params.length}`; }
    if (child_id) { params.push(child_id); where += ` AND i.child_id=$${params.length}`; }
    const { rows } = await db.query(`
      SELECT i.*, c.first_name||' '||c.last_name as child_name,
             c.parent_1_email, c.parent_1_name,
             s.first_name||' '||s.last_name as created_by_name
      FROM invoices i
      LEFT JOIN children c ON c.id=i.child_id
      LEFT JOIN staff s ON s.id=i.created_by
      ${where}
      ORDER BY i.created_at DESC LIMIT 200
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /invoices — create invoice
router.post('/invoices', managerOnly, async (req, res) => {
  const { child_id, period_start, period_end, session_hours, funded_hours, hourly_rate, funded_rate, notes } = req.body;
  try {
    const db = getPool();
    // Generate invoice number: INV-YYYYMM-XXXX
    const { rows: last } = await db.query(`SELECT id FROM invoices ORDER BY id DESC LIMIT 1`).catch(() => ({ rows: [] }));
    const seq = ((last[0]?.id || 0) + 1).toString().padStart(4, '0');
    const invNum = `INV-${new Date().toISOString().slice(0,7).replace('-','')}-${seq}`;

    const fHours = parseFloat(funded_hours || 0);
    const sHours = parseFloat(session_hours || 0);
    const rate = parseFloat(hourly_rate || 8.00);
    const fRate = parseFloat(funded_rate || 6.50);
    const chargeableHours = Math.max(0, sHours - fHours);
    const subtotal = chargeableHours * rate;
    const fundedDeduction = fHours * fRate;
    const totalDue = subtotal;

    const { rows } = await db.query(`
      INSERT INTO invoices (child_id, invoice_number, period_start, period_end,
        session_hours, funded_hours, chargeable_hours, hourly_rate, funded_rate,
        subtotal, funded_deduction, total_due, notes, created_by, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft')
      RETURNING *
    `, [child_id, invNum, period_start, period_end, sHours, fHours, chargeableHours,
        rate, fRate, subtotal, fundedDeduction, totalDue, notes, req.user.id]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /invoices/:id — update status
router.patch('/invoices/:id', managerOnly, async (req, res) => {
  const { status, notes, paid_at } = req.body;
  try {
    const db = getPool();
    const sets = [];
    const params = [];
    if (status) { params.push(status); sets.push(`status=$${params.length}`); }
    if (notes !== undefined) { params.push(notes); sets.push(`notes=$${params.length}`); }
    if (status === 'sent') sets.push(`sent_at=NOW()`);
    if (status === 'paid') sets.push(`paid_at=NOW()`);
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE invoices SET ${sets.join(',')} WHERE id=$${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /invoices/:id — delete draft
router.delete('/invoices/:id', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    await db.query(`DELETE FROM invoices WHERE id=$1 AND status='draft'`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /session-rates
router.get('/session-rates', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`SELECT * FROM session_rates ORDER BY id`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /notifications — live notification bell data
router.get('/notifications', managerOnly, async (req, res) => {
  const db = getPool();
  const notifications = [];
  try {
    // Unsigned medicine records (no manager sign-off) — column may not exist in all schemas
    try {
      const { rows: unsignedMeds } = await db.query(`
        SELECT COUNT(*) as cnt FROM medicine_records
        WHERE manager_sign_off_at IS NULL AND created_at >= NOW() - interval '30 days'
      `);
      if (parseInt(unsignedMeds[0].cnt) > 0) {
        notifications.push({ type: 'medicine', message: `${unsignedMeds[0].cnt} medicine record${unsignedMeds[0].cnt !== '1' ? 's' : ''} awaiting manager sign-off`, link: '/medicine.html', severity: 'warning', created_at: new Date().toISOString() });
      }
    } catch (_) {}

    // Open incidents without parent notification
    try {
      const { rows: unnotifiedInc } = await db.query(`
        SELECT COUNT(*) as cnt FROM incidents
        WHERE (parent_notified IS NULL OR parent_notified=false)
          AND created_at >= NOW() - interval '30 days'
          AND status != 'closed'
      `);
      if (parseInt(unnotifiedInc[0].cnt) > 0) {
        notifications.push({ type: 'incident', message: `${unnotifiedInc[0].cnt} accident${unnotifiedInc[0].cnt !== '1' ? 's' : ''} without parent notification`, link: '/incidents.html', severity: 'danger', created_at: new Date().toISOString() });
      }
    } catch (_) {}

    // DBS expiring in 30 days
    const { rows: dbsExpiring } = await db.query(`
      SELECT COUNT(*) as cnt FROM staff
      WHERE dbs_expiry IS NOT NULL AND dbs_expiry <= NOW() + interval '30 days'
        AND dbs_expiry > NOW() AND is_active=true
    `);
    if (parseInt(dbsExpiring[0].cnt) > 0) {
      notifications.push({ type: 'dbs', message: `${dbsExpiring[0].cnt} staff DBS check${dbsExpiring[0].cnt !== '1' ? 's' : ''} expiring within 30 days`, link: '/staff.html', severity: 'warning', created_at: new Date().toISOString() });
    }

    // Supervisions overdue (no supervision in last 90 days)
    const { rows: overdueSups } = await db.query(`
      SELECT COUNT(*) as cnt FROM staff s
      WHERE s.is_active=true
        AND NOT EXISTS (
          SELECT 1 FROM supervisions sup
          WHERE sup.staff_id=s.id AND sup.conducted_date >= NOW() - interval '90 days'
        )
    `);
    if (parseInt(overdueSups[0].cnt) > 0) {
      notifications.push({ type: 'supervision', message: `${overdueSups[0].cnt} staff member${overdueSups[0].cnt !== '1' ? 's' : ''} with no supervision in 90 days`, link: '/supervisions.html', severity: 'warning', created_at: new Date().toISOString() });
    }

    // Children unobserved 14+ days
    const { rows: unobsChildren } = await db.query(`
      SELECT COUNT(*) as cnt FROM children c
      WHERE c.is_active=true
        AND NOT EXISTS (
          SELECT 1 FROM observations o WHERE o.child_id=c.id AND o.created_at >= NOW() - interval '14 days'
        )
    `);
    if (parseInt(unobsChildren[0].cnt) > 0) {
      notifications.push({ type: 'observation', message: `${unobsChildren[0].cnt} child${unobsChildren[0].cnt !== '1' ? 'ren' : ''} not observed in 14+ days`, link: '/staff-performance.html', severity: parseInt(unobsChildren[0].cnt) > 3 ? 'danger' : 'warning', created_at: new Date().toISOString() });
    }

    res.json(notifications);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /compliance — staff DBS/First Aid/Food Hygiene compliance records
router.get('/compliance', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const now = new Date();
    const soonDays = 90;

    // Try staff_compliance table first, fall back to staff.dbs_expiry
    let records = [];
    try {
      const { rows } = await db.query(`
        SELECT sc.*, s.first_name || ' ' || s.last_name as staff_name
        FROM staff_compliance sc
        JOIN staff s ON s.id = sc.staff_id
        WHERE s.is_active = true
        ORDER BY sc.expiry_date ASC NULLS LAST
      `);
      records = rows;
    } catch {
      // Fallback: derive from staff table DBS fields
      const { rows } = await db.query(`
        SELECT id, first_name || ' ' || last_name as staff_name,
               'DBS Enhanced' as check_type, null as issued_date,
               dbs_expiry as expiry_date, null as certificate_number, 'unknown' as status
        FROM staff WHERE is_active=true AND dbs_expiry IS NOT NULL
        ORDER BY dbs_expiry ASC
      `).catch(() => ({ rows: [] }));
      records = rows;
    }

    // Annotate status
    const annotated = records.map(r => {
      let status = 'ok';
      if (r.expiry_date) {
        const exp = new Date(r.expiry_date);
        if (exp < now) status = 'overdue';
        else if (exp < new Date(now.getTime() + soonDays * 86400000)) status = 'expiring_soon';
      }
      return { ...r, status };
    });

    const overdue = annotated.filter(r => r.status === 'overdue').length;
    const expiring = annotated.filter(r => r.status === 'expiring_soon').length;

    res.json({ records: annotated, overdue, expiring_soon: expiring });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /funding — children with funding details
router.get('/funding', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name,
             c.funded_hours_15, c.funded_hours_30,
             c.two_year_funded, c.two_year_funding_type,
             c.pupil_premium, c.eypp_eligible,
             c.thirty_hour_code, c.thirty_hour_code_expiry,
             r.name as room_name
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
      WHERE c.is_active = true
      ORDER BY r.id, c.first_name
    `);
    const summary = {
      total: rows.length,
      funded_15: rows.filter(c => c.funded_hours_15 > 0).length,
      funded_30: rows.filter(c => c.funded_hours_30 > 0).length,
      two_year: rows.filter(c => c.two_year_funded).length,
      eypp: rows.filter(c => c.pupil_premium || c.eypp_eligible).length,
    };
    res.json({ children: rows, summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /waiting-list — full waiting list
router.get('/waiting-list', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT * FROM waiting_list ORDER BY created_at ASC LIMIT 200
    `).catch(() => ({ rows: [] }));

    // Also get enquiries
    const { rows: enqs } = await db.query(`
      SELECT id, first_name || ' ' || last_name as child_name,
             first_name as child_first_name, last_name as child_last_name,
             email as parent_email, phone as parent_phone, message as notes,
             status, created_at
      FROM enquiries ORDER BY created_at DESC LIMIT 50
    `).catch(() => ({ rows: [] }));

    const total = rows.length;
    res.json({ list: rows, enquiries: enqs, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Override /invoices to return structured response expected by admin.html
// The existing /invoices returns an array — add wrapper endpoint
router.get('/invoices-summary', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT i.*, c.first_name||' '||c.last_name as child_name
      FROM invoices i
      LEFT JOIN children c ON c.id=i.child_id
      ORDER BY i.created_at DESC LIMIT 200
    `);
    const outstanding = rows.filter(i=>i.status==='unpaid').reduce((s,i)=>s+parseFloat(i.amount_due||0),0);
    const paid = rows.filter(i=>i.status==='paid').reduce((s,i)=>s+parseFloat(i.amount_paid||0),0);
    res.json({ invoices: rows, outstanding, paid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── "Wipe to a fresh, import-ready instance" (private instances ONLY) ─────────
// Enabled solely when ALLOW_WIPE=true in the environment. Never set on LADN prod
// or the public product — so the button cannot exist or fire there.
//
// Design (2026-06-30, prompt 33): REFERENCE-PRESERVING KEEP-LIST, not a fixed
// truncate-list. We truncate EVERY base table in the current schema EXCEPT an
// explicit KEEP set of reference/config/scaffolding/login tables. This guarantees:
//   (a) all child/staff/operational/PII data is cleared — including any NEW table
//       added in future (it is wiped unless deliberately added to the keep-list),
//       so a "fresh" instance never silently retains stale personal data; and
//   (b) the instance stays USABLE after a wipe — the Early Learning Goals (and
//       every other framework), settings, rooms/classes scaffolding, lookups and
//       the login account all survive, so the colleague can immediately import
//       their own data and assess against the ELGs.
// framework_statements is in the keep-list → the ELGs always survive a wipe.
const WIPE_KEEP_TABLES = new Set([
  // ── Frameworks & assessment reference (the ELGs / Birth-to-5 etc. — MUST survive) ──
  'framework_statements','framework_versions','observation_standards',
  // ── Config / settings ──
  'settings','wren_settings','it_settings','twinkl_settings','payment_settings',
  'backup_config','planning_preferences','automation_rules','wp_school_settings',
  'inspection_modes','modules','feature_flags',
  // ── Structural scaffolding (containers, no child PII) ──
  'rooms','classes','subjects','houses','terms','funding_terms',
  // ── Lookups / reference catalogues ──
  'tag_definitions','safeguarding_categories','risk_assessment_templates',
  'wp_categories','ingredients','menu_recipes','spelling_lists','gias_cache',
  'courses','course_sections','course_quiz_questions','wren_workflow_templates',
  // ── Login / access account(s) so the instance stays usable after a wipe ──
  'staff',
]);

// Compute {keep, truncate} for the CURRENT schema without mutating anything.
async function _wipePlan(db) {
  const { rows } = await db.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
     ORDER BY table_name`);
  const all = rows.map(r => r.table_name);
  const keep     = all.filter(t => WIPE_KEEP_TABLES.has(t));
  const truncate = all.filter(t => !WIPE_KEEP_TABLES.has(t));
  return { all, keep, truncate };
}

router.get('/wipe-status', (req, res) => res.json({ enabled: process.env.ALLOW_WIPE === 'true' }));

// GET /wipe-preview — dry run: lists exactly which tables would be truncated vs kept.
// Read-only; never mutates. Lets you confirm framework_statements is preserved.
router.get('/wipe-preview', managerOnly, async (req, res) => {
  if (process.env.ALLOW_WIPE !== 'true') return res.status(403).json({ error: 'Wipe is disabled on this instance' });
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT current_schema() AS s');
    const plan = await _wipePlan(db);
    res.json({
      schema: rows[0].s,
      keepCount: plan.keep.length,
      truncateCount: plan.truncate.length,
      framework_statements_preserved: plan.keep.includes('framework_statements'),
      keep: plan.keep,
      wouldTruncate: plan.truncate,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/wipe-everything', managerOnly, async (req, res) => {
  if (process.env.ALLOW_WIPE !== 'true') return res.status(403).json({ error: 'Wipe is disabled on this instance' });
  if (!req.body || req.body.confirm !== 'WIPE') return res.status(400).json({ error: 'Type WIPE to confirm' });
  try {
    const db = getPool();
    const plan = await _wipePlan(db);
    if (plan.truncate.length) {
      await db.query(`TRUNCATE ${plan.truncate.map(t => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
    }
    res.json({ ok: true, wiped: plan.truncate.length, kept: plan.keep.length, keptTables: plan.keep, truncatedTables: plan.truncate });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Ratio settings ────────────────────────────────────────────────────────────
// GET /ratio-settings — retrieve ratio calculation settings
router.get('/ratio-settings', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT key, value FROM settings
      WHERE key IN ('ratio_include_settling', 'ratio_include_event_children', 'ratio_include_staff_on_booking')
    `);
    const settings = {};
    for (const r of rows) settings[r.key] = r.value === 'true';
    res.json(settings);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /ratio-settings — update ratio calculation settings
router.post('/ratio-settings', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const keys = ['ratio_include_settling', 'ratio_include_event_children', 'ratio_include_staff_on_booking'];
    for (const key of keys) {
      if (req.body[key] != null) {
        const val = req.body[key] ? 'true' : 'false';
        await db.query(
          `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
          [key, val]
        );
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
