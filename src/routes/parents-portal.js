'use strict';
// Parent-facing API routes for the primary parent portal
const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const { getPool } = require('../db/pool');
const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts, please wait' },
});

// ── Auth middleware (parent JWT) ──────────────────────────────────────────────
function parentAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthenticated' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const expectedAud = req._portal || 'parents';
    // TODO(strict-aud): Remove legacy-allow after 2026-05-20 — reject all tokens without aud
    if (decoded.aud && decoded.aud !== expectedAud) {
      return res.status(401).json({ error: 'Invalid token audience' });
    }
    if (!decoded.aud) console.warn(`[parentAuth] legacy token without aud, user=${decoded.id}`);
    req.parent = decoded;
    next();
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
}

// ── POST /parent-login — email + password ────────────────────────────────────
router.post('/parent-login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT pa.*, c.first_name as child_first, c.last_name as child_last
       FROM parent_portal_access pa
       LEFT JOIN children c ON c.id = pa.child_id
       WHERE pa.email = $1 AND pa.is_active = true
       LIMIT 1`,
      [email.toLowerCase().trim()]
    );
    const par = rows[0];
    if (!par) return res.status(401).json({ error: 'Invalid email or password' });

    // Demo mode: accept any password if no hash set
    if (!par.password_hash) {
      if (process.env.DEMO_MODE !== 'true') return res.status(401).json({ error: 'Account not set up' });
    } else {
      const valid = await bcrypt.compare(password, par.password_hash);
      if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
    }

    await db.query('UPDATE parent_portal_access SET last_login=NOW() WHERE id=$1', [par.id]);

    const token = jwt.sign(
      { id: par.id, email: par.email, child_id: par.child_id, type: 'parent',
        first_name: par.first_name || 'Parent' },
      process.env.JWT_SECRET,
      { expiresIn: '12h', audience: req._portal || 'parents' }
    );
    res.json({ token, parent: { id: par.id, email: par.email, first_name: par.first_name, child_id: par.child_id } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /parent-otp — request OTP code ──────────────────────────────────────
router.post('/parent-otp', loginLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT id FROM parent_portal_access WHERE email=$1 AND is_active=true', [email.toLowerCase().trim()]);
    if (!rows.length) { res.json({ ok: true }); return; } // silent fail
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await db.query('UPDATE parent_portal_access SET otp_code=$1, otp_expires_at=$2 WHERE email=$3',
      [code, expires, email.toLowerCase().trim()]);
    console.log(`[parent-otp] Code for ${email}: ${code}`); // Demo: log to console
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /parent-otp-verify ───────────────────────────────────────────────────
router.post('/parent-otp-verify', loginLimiter, async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code required' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT * FROM parent_portal_access WHERE email=$1 AND otp_code=$2 AND otp_expires_at > NOW() AND is_active=true`,
      [email.toLowerCase().trim(), code]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid or expired code' });
    const par = rows[0];
    await db.query('UPDATE parent_portal_access SET otp_code=NULL, otp_expires_at=NULL, last_login=NOW() WHERE id=$1', [par.id]);
    const token = jwt.sign(
      { id: par.id, email: par.email, child_id: par.child_id, type: 'parent', first_name: par.first_name||'Parent' },
      process.env.JWT_SECRET,
      { expiresIn: '12h', audience: req._portal || 'parents' }
    );
    res.json({ token, parent: { id: par.id, email: par.email, first_name: par.first_name, child_id: par.child_id } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /children — children linked to this parent ───────────────────────────
router.get('/children', parentAuth, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT c.id, c.first_name, c.last_name, c.year_group, c.class_group,
              c.date_of_birth, c.attendance_pct, c.sen_status, c.pupil_premium
       FROM parent_portal_access pa
       JOIN children c ON c.id = pa.child_id
       WHERE pa.email = $1 AND pa.is_active = true`,
      [req.parent.email]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /messages/:childId ────────────────────────────────────────────────────
router.get('/messages/:childId', parentAuth, async (req, res) => {
  try {
    const db = getPool();
    // Try messages via thread (primary schema: message_threads + messages)
    const { rows } = await db.query(
      `SELECT m.id, m.body, m.sender_type, m.sent_at as created_at
       FROM message_threads mt
       JOIN messages m ON m.thread_id = mt.id
       WHERE mt.child_id = $1
       ORDER BY m.sent_at ASC LIMIT 100`,
      [req.params.childId]
    ).catch(() => ({ rows: [] }));
    if (rows.length) return res.json(rows);
    // Fallback: flat message_threads with body column (EYFS schema)
    const { rows: r2 } = await db.query(
      `SELECT id, body, sender_type, created_at FROM message_threads
       WHERE child_id=$1 AND body IS NOT NULL ORDER BY created_at ASC LIMIT 100`,
      [req.params.childId]
    ).catch(() => ({ rows: [] }));
    res.json(r2);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /messages/:childId ───────────────────────────────────────────────────
router.post('/messages/:childId', parentAuth, async (req, res) => {
  const { body } = req.body;
  if (!body) return res.status(400).json({ error: 'Message body required' });
  try {
    const db = getPool();
    // Get or create thread for this child/parent
    let thread = await db.query(
      `SELECT id FROM message_threads WHERE child_id=$1 AND parent_email=$2 LIMIT 1`,
      [req.params.childId, req.parent.email]
    ).catch(() => ({ rows: [] }));

    let threadId;
    if (thread.rows.length) {
      threadId = thread.rows[0].id;
    } else {
      const { rows } = await db.query(
        `INSERT INTO message_threads (child_id, parent_email, subject, created_at, last_message_at)
         VALUES ($1,$2,'Parent message',NOW(),NOW()) RETURNING id`,
        [req.params.childId, req.parent.email]
      ).catch(() => ({ rows: [] }));
      threadId = rows[0]?.id;
    }

    if (threadId) {
      await db.query(
        `INSERT INTO messages (thread_id, sender_type, sender_email, body, sent_at)
         VALUES ($1,'parent',$2,$3,NOW())`,
        [threadId, req.parent.email, body]
      );
      await db.query(`UPDATE message_threads SET last_message_at=NOW() WHERE id=$1`, [threadId]).catch(()=>{});
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /invoices/:childId ────────────────────────────────────────────────────
router.get('/invoices/:childId', parentAuth, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT * FROM invoices WHERE child_id=$1 ORDER BY due_date DESC LIMIT 20`,
      [req.params.childId]
    ).catch(() => ({ rows: [] }));
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /checkout — Stripe checkout session ──────────────────────────────────
router.post('/checkout', parentAuth, async (req, res) => {
  const { invoice_id, child_id } = req.body;
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe not configured' });
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const db = getPool();
    let amount = 500, desc = 'School payment';
    if (invoice_id) {
      const { rows } = await db.query('SELECT * FROM invoices WHERE id=$1', [invoice_id]);
      if (rows[0]) { amount = Math.round(parseFloat(rows[0].amount) * 100); desc = rows[0].description || desc; }
    }
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{ price_data: { currency:'gbp', product_data:{ name: desc }, unit_amount: amount }, quantity: 1 }],
      success_url: (process.env.ALLOWED_ORIGIN || 'http://localhost:3000') + '/parent/?payment=success',
      cancel_url:  (process.env.ALLOWED_ORIGIN || 'http://localhost:3000') + '/parent/',
      metadata: { invoice_id: invoice_id||'', child_id: child_id||'', parent_email: req.parent.email },
    });
    res.json({ checkout_url: session.url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
