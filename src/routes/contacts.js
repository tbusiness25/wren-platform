const express = require('express');
const router  = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

// b491 (2026-10-12, security hardening item 6) — every route here was reachable
// by ANY authenticated role: the full prospective/current-family contact list
// and message threads, with no capability or role check at all. No EY/
// practitioner page calls /api/contacts — this is an office/admissions function.
router.use((req, res, next) => {
  if (hasRole(req.user, ['practitioner', 'apprentice'])) {
    return res.status(403).json({ error: 'Forbidden — contacts is not available to this role' });
  }
  next();
});

const STAGE_TO_STATUS = {
  new:'enquirer', enquiry:'enquirer', tour_booked:'enquirer', tour_done:'enquirer',
  declined:'enquirer', lost:'enquirer',
  on_waiting_list:'waiting_list', offer_made:'waiting_list',
  offer_accepted:'enrolled', registered:'enrolled',
};
const STATUS_TRANSITIONS = {
  enquirer:     ['waiting_list'],
  waiting_list: ['enrolled','enquirer'],
  enrolled:     ['leaver'],
  leaver:       [],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function upsertContact(db, { email, phone, name, status, enquiryId }) {
  const emailLower = email ? email.toLowerCase() : null;
  if (emailLower) {
    const { rows } = await db.query(
      `SELECT id FROM contacts WHERE lower(primary_email)=$1`, [emailLower]
    );
    if (rows.length) {
      await db.query(
        `UPDATE contacts SET
           primary_phone=COALESCE(primary_phone,$1),
           full_name=COALESCE(full_name,$2),
           enquiry_id=COALESCE(enquiry_id,$3)
         WHERE id=$4`,
        [phone||null, name||null, enquiryId||null, rows[0].id]
      );
      return rows[0].id;
    }
  } else if (phone) {
    const { rows } = await db.query(
      `SELECT id FROM contacts WHERE primary_email IS NULL AND primary_phone=$1`, [phone]
    );
    if (rows.length) return rows[0].id;
  }
  const { rows } = await db.query(
    `INSERT INTO contacts
       (primary_email,primary_phone,full_name,status,enquiry_id,status_changed_at,created_at)
     VALUES ($1,$2,$3,$4,$5,now(),now()) RETURNING id`,
    [email||null, phone||null, name||null, status||'enquirer', enquiryId||null]
  );
  await db.query(
    `INSERT INTO contact_status_history (contact_id,to_status,changed_at,notes)
     VALUES ($1,$2,now(),'auto-created')`,
    [rows[0].id, status||'enquirer']
  );
  return rows[0].id;
}

async function upsertThread(db, contactId, subject) {
  const { rows } = await db.query(
    `SELECT id FROM threads WHERE contact_id=$1 ORDER BY created_at LIMIT 1`, [contactId]
  );
  if (rows.length) return rows[0].id;
  const { rows: ins } = await db.query(
    `INSERT INTO threads (contact_id,subject,created_at) VALUES ($1,$2,now()) RETURNING id`,
    [contactId, subject||'General']
  );
  return ins[0].id;
}

async function insertThreadMessage(db, { threadId, direction, source, bodyText,
  senderEmail, senderPhone, createdAt, vapiCallId, emailTriageId, enquiryId, staffId, aiDrafted }) {
  await db.query(
    `INSERT INTO thread_messages
       (thread_id,direction,source,body_text,sender_email,sender_phone,
        created_at,vapi_call_id,email_triage_id,enquiry_id,sent_by_staff_id,ai_drafted)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [threadId, direction, source, bodyText||'',
     senderEmail||null, senderPhone||null,
     createdAt||new Date(), vapiCallId||null, emailTriageId||null,
     enquiryId||null, staffId||null, aiDrafted||false]
  );
  await db.query(
    `UPDATE threads SET
       last_message_at=COALESCE($1,now()),
       last_message_preview=LEFT($2,100),
       unread_count=unread_count+$3
     WHERE id=$4`,
    [createdAt||new Date(), bodyText||'', direction==='in'?1:0, threadId]
  );
}

// Export helpers for use in other route files
module.exports = router;
module.exports.upsertContact       = upsertContact;
module.exports.upsertThread        = upsertThread;
module.exports.insertThreadMessage = insertThreadMessage;
module.exports.STAGE_TO_STATUS     = STAGE_TO_STATUS;

// ── GET /api/contacts ─────────────────────────────────────────────────────────
// List contacts, ordered by last thread activity
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const { status, q, page=1, limit=50 } = req.query;
    const offset = (parseInt(page)-1) * parseInt(limit);
    const params = [];

    // 'archived' is a virtual status: archived_at IS NOT NULL, not a status enum value
    let where;
    if (status === 'archived') {
      where = 'WHERE c.archived_at IS NOT NULL';
    } else {
      where = 'WHERE c.archived_at IS NULL';
      if (status) { params.push(status); where += ` AND c.status=$${params.length}`; }
    }
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where += ` AND (lower(c.full_name) LIKE $${params.length}
                   OR lower(c.primary_email) LIKE $${params.length}
                   OR c.primary_phone LIKE $${params.length})`;
    }
    params.push(parseInt(limit), offset);
    const { rows } = await db.query(`
      SELECT c.id, c.primary_email, c.primary_phone, c.full_name,
             COALESCE(c.full_name, c.primary_email, c.primary_phone) AS display_name,
             c.status, c.status_changed_at, c.created_at, c.child_ids, c.enquiry_id,
             t.id AS thread_id, t.subject, t.last_message_at, t.last_message_preview,
             t.unread_count,
             COUNT(*) OVER() AS total_count
      FROM contacts c
      LEFT JOIN threads t ON t.contact_id=c.id
      ${where}
      ORDER BY COALESCE(t.last_message_at, c.created_at) DESC NULLS LAST
      LIMIT $${params.length-1} OFFSET $${params.length}
    `, params);
    res.json({
      contacts: rows,
      total: rows[0]?.total_count || 0,
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/contacts ────────────────────────────────────────────────────────
// Manual contact creation
router.post('/', async (req, res) => {
  const { display_name, primary_email, primary_phone, status } = req.body;
  if (!primary_email && !primary_phone) return res.status(400).json({ error: 'email or phone required' });
  try {
    const db = getPool();
    const id = await upsertContact(db, {
      email: primary_email, phone: primary_phone,
      name: display_name, status: status || 'enquirer',
    });
    const { rows: [contact] } = await db.query(
      `SELECT *, COALESCE(full_name,primary_email,primary_phone) AS display_name FROM contacts WHERE id=$1`, [id]
    );
    res.status(201).json(contact);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/contacts/:id ─────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const db = getPool();
    const [{ rows: [contact] }, { rows: threads }] = await Promise.all([
      db.query(`SELECT * FROM contacts WHERE id=$1`, [req.params.id]),
      db.query(`SELECT * FROM threads WHERE contact_id=$1 ORDER BY created_at`, [req.params.id]),
    ]);
    if (!contact) return res.status(404).json({ error: 'Not found' });

    // Fetch messages for first/primary thread
    const primaryThread = threads[0];
    let messages = [];
    if (primaryThread) {
      const { rows } = await db.query(`
        SELECT tm.*, s.first_name||' '||s.last_name AS staff_name
        FROM thread_messages tm
        LEFT JOIN staff s ON s.id=tm.sent_by_staff_id
        WHERE tm.thread_id=$1
        ORDER BY tm.created_at ASC
        LIMIT 100
      `, [primaryThread.id]);
      messages = rows;
    }

    // Status history
    const { rows: history } = await db.query(`
      SELECT csh.*, s.first_name||' '||s.last_name AS changed_by_name
      FROM contact_status_history csh
      LEFT JOIN staff s ON s.id=csh.changed_by
      WHERE csh.contact_id=$1 ORDER BY csh.changed_at DESC
    `, [req.params.id]);

    res.json({ contact, threads, messages, history });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/contacts/:id/status ───────────────────────────────────────────
router.patch('/:id/status', async (req, res) => {
  const { status, notes } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });
  const valid = ['enquirer','waiting_list','enrolled','leaver'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const db = getPool();
    const { rows: [cur] } = await db.query(
      `SELECT status FROM contacts WHERE id=$1`, [req.params.id]
    );
    if (!cur) return res.status(404).json({ error: 'Not found' });
    const allowed = STATUS_TRANSITIONS[cur.status] || [];
    if (!allowed.includes(status) && !hasRole(req.user, ['manager', 'admin'])) {
      return res.status(400).json({ error: `Cannot move from ${cur.status} to ${status}` });
    }
    await db.query(
      `UPDATE contacts SET status=$1, status_changed_at=now() WHERE id=$2`,
      [status, req.params.id]
    );
    await db.query(
      `INSERT INTO contact_status_history
         (contact_id,from_status,to_status,changed_by,changed_at,notes)
       VALUES ($1,$2,$3,$4,now(),$5)`,
      [req.params.id, cur.status, status, req.user.id, notes||null]
    );
    // System message in thread
    const { rows: threads } = await db.query(
      `SELECT id FROM threads WHERE contact_id=$1 LIMIT 1`, [req.params.id]
    );
    if (threads.length) {
      await insertThreadMessage(db, {
        threadId: threads[0].id, direction: 'out', source: 'system',
        bodyText: `Status changed: ${cur.status} → ${status}${notes?' ('+notes+')':''}`,
        staffId: req.user.id,
      });
    }
    res.json({ ok: true, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/contacts/:id/reply ─────────────────────────────────────────────
router.post('/:id/reply', async (req, res) => {
  const { body, aiDrafted } = req.body;
  if (!body) return res.status(400).json({ error: 'body required' });
  try {
    const db = getPool();
    const { rows: threads } = await db.query(
      `SELECT id FROM threads WHERE contact_id=$1 LIMIT 1`, [req.params.id]
    );
    if (!threads.length) return res.status(404).json({ error: 'No thread for contact' });
    await insertThreadMessage(db, {
      threadId: threads[0].id, direction: 'out', source: 'manual_note',
      bodyText: body, staffId: req.user.id, aiDrafted: !!aiDrafted,
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/contacts/:id/spam ──────────────────────────────────────────────
// Mark contact as spam: adds domain to email_sender_rules, archives contact
router.post('/:id/spam', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [contact] } = await db.query(
      `SELECT * FROM contacts WHERE id=$1`, [req.params.id]
    );
    if (!contact) return res.status(404).json({ error: 'Not found' });

    // Extract domain from email for rule
    const email = contact.primary_email || '';
    const domain = email.includes('@') ? email.split('@')[1].toLowerCase() : email.toLowerCase();

    if (domain) {
      await db.query(
        `INSERT INTO email_sender_rules (pattern, rule, reason, created_at)
         VALUES ($1,'never-alert',$2,now()) ON CONFLICT DO NOTHING`,
        [domain, `Marked as spam by staff (contact ID ${contact.id})`]
      );
    }
    await db.query(
      `UPDATE contacts SET archived_at=now() WHERE id=$1`, [req.params.id]
    );
    res.json({ ok: true, domain_blocked: domain });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/contacts/:id/archive ───────────────────────────────────────────
router.post('/:id/archive', async (req, res) => {
  try {
    const db = getPool();
    await db.query(`UPDATE contacts SET archived_at=now() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/contacts/threads/:threadId/messages ─────────────────────────────
router.get('/thread/:threadId/messages', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT tm.*, s.first_name||' '||s.last_name AS staff_name
      FROM thread_messages tm
      LEFT JOIN staff s ON s.id=tm.sent_by_staff_id
      WHERE tm.thread_id=$1 ORDER BY tm.created_at ASC
    `, [req.params.threadId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/contacts/thread/:threadId/read ──────────────────────────────────
router.post('/thread/:threadId/read', async (req, res) => {
  try {
    const db = getPool();
    await db.query(
      `UPDATE thread_messages SET is_read=true, read_at=now()
       WHERE thread_id=$1 AND is_read=false`, [req.params.threadId]
    );
    await db.query(
      `UPDATE threads SET unread_count=0 WHERE id=$1`, [req.params.threadId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── parentdetails-20261023: a parent's NI number and date of birth (Roost → child profile → Family → Parental details) ──
//   GET  /api/contacts/family/:childId/identity          parent 1 / parent 2, MASKED (last 3), + where the claim takes each from
//   PUT  /api/contacts/:id/identity      {child_id, ni_number?, date_of_birth?}   validated; '' clears
//   POST /api/contacts/:id/identity/reveal {child_id}    the full values, for a manager who pressed Show
//   GET  /api/contacts/family/:childId/identity/audit    who viewed / changed them (never the values)
// Managers only. Every view, reveal and change is written to contact_identity_audit (src/lib/carer-identity.js).
const CI = require('../lib/carer-identity');
const ID_MGR = ['manager', 'deputy_manager', 'admin', 'owner'];
const idMgrOnly = (req, res, next) => (ID_MGR.includes(req.user && req.user.role) && !req.isParent && req._portal !== 'parents'
  ? next() : res.status(403).json({ error: 'Manager access required' }));
const idActor = req => ({ id: req.user && req.user.id, ip: req.ip });

router.get('/family/:childId/identity', idMgrOnly, async (req, res) => {
  try { res.json(await CI.familyView(getPool(), parseInt(req.params.childId, 10), idActor(req))); }
  catch (e) { console.error('[contacts] identity view:', e.message); res.status(500).json({ error: 'DB error' }); }
});
router.get('/family/:childId/identity/audit', idMgrOnly, async (req, res) => {
  try { res.json({ audit: await CI.auditFor(getPool(), parseInt(req.params.childId, 10)) }); }
  catch (e) { res.status(500).json({ error: 'DB error' }); }
});
router.put('/:id/identity', idMgrOnly, async (req, res) => {
  const b = req.body || {};
  try {
    const r = await CI.update(getPool(), idActor(req), { contactId: req.params.id, childId: b.child_id, body: { ni_number: b.ni_number, date_of_birth: b.date_of_birth } });
    res.status(r.status).json(r);
  } catch (e) { console.error('[contacts] identity update:', e.message); res.status(500).json({ error: 'DB error' }); }
});
router.post('/:id/identity/reveal', idMgrOnly, async (req, res) => {
  try { const r = await CI.reveal(getPool(), idActor(req), { contactId: req.params.id, childId: (req.body || {}).child_id }); res.status(r.status).json(r); }
  catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// addresses-20261023: a parent's full address (line 1, line 2, town, postcode), edited in the same Parental details card.
//   PUT /api/contacts/:id/address  {child_id, address_line1?, address_line2?, town?, postcode?}   '' clears; audited (field names only)
router.put('/:id/address', idMgrOnly, async (req, res) => {
  const b = req.body || {};
  try {
    const r = await require('../lib/family-address').update(getPool(), idActor(req), { contactId: req.params.id, childId: b.child_id,
      body: { address_line1: b.address_line1, address_line2: b.address_line2, town: b.town, postcode: b.postcode } });
    res.status(r.status).json(r);
  } catch (e) { console.error('[contacts] address update:', e.message); res.status(500).json({ error: 'DB error' }); }
});
