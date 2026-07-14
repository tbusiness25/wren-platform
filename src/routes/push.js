'use strict';
// Web Push subscription routes — VAPID public key + subscribe/unsubscribe endpoints
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');

// VAPID keys are generated once and stored in env (see SETUP comment below).
// If keys don't exist yet, generate with:
//   const webpush = require('web-push');
//   const vapidKeys = webpush.generateVAPIDKeys();
//   console.log('VAPID_PUBLIC_KEY=' + vapidKeys.publicKey);
//   console.log('VAPID_PRIVATE_KEY=' + vapidKeys.privateKey);
// Then add both to editions/ladn/.env.

// ── GET /vapid-public-key — return the public key for browser subscription ────
// Public endpoint (no auth) — browsers need this before subscribing
router.get('/vapid-public-key', (req, res) => {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  if (!publicKey) {
    return res.status(503).json({ error: 'web_push_not_configured' });
  }
  res.json({ publicKey });
});

// ── POST /subscribe — store a PushSubscription from the browser ───────────────
// Body: { subscription: { endpoint, keys: { p256dh, auth } }, userAgent }
// Auth: staff or parent JWT (staff_id extracted from JWT, parents not yet supported)
router.post('/subscribe', async (req, res) => {
  const db = getPool();
  const { subscription, userAgent } = req.body;

  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ error: 'invalid_subscription' });
  }

  // Extract user from JWT (staff only for now — parents need separate user_id column)
  const user = req.user; // from auth middleware
  if (!user || !user.id) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const staffId = user.id;
  const { endpoint } = subscription;
  const { p256dh, auth } = subscription.keys;

  try {
    // Upsert: if the same endpoint exists for this staff, update it; otherwise insert
    await db.query(
      `INSERT INTO push_subscriptions
         (staff_id, endpoint, p256dh, auth, user_agent, created_at, last_used_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (endpoint)
       DO UPDATE SET
         staff_id = EXCLUDED.staff_id,
         p256dh = EXCLUDED.p256dh,
         auth = EXCLUDED.auth,
         user_agent = EXCLUDED.user_agent,
         last_used_at = NOW()`,
      [staffId, endpoint, p256dh, auth, userAgent || null]
    );

    console.log(`[push] subscribed staff ${staffId} endpoint ${endpoint.slice(0, 50)}...`);
    res.json({ success: true });
  } catch (err) {
    console.error('[push] subscribe failed:', err.message);
    res.status(500).json({ error: 'subscription_failed' });
  }
});

// ── POST /unsubscribe — remove a subscription ─────────────────────────────────
// Body: { endpoint }
router.post('/unsubscribe', async (req, res) => {
  const db = getPool();
  const { endpoint } = req.body;

  if (!endpoint) {
    return res.status(400).json({ error: 'endpoint_required' });
  }

  const user = req.user;
  if (!user || !user.id) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    // Only delete subscriptions belonging to this user
    const result = await db.query(
      `DELETE FROM push_subscriptions WHERE endpoint = $1 AND staff_id = $2`,
      [endpoint, user.id]
    );

    console.log(`[push] unsubscribed staff ${user.id} (${result.rowCount} rows)`);
    res.json({ success: true, removed: result.rowCount });
  } catch (err) {
    console.error('[push] unsubscribe failed:', err.message);
    res.status(500).json({ error: 'unsubscribe_failed' });
  }
});

module.exports = router;
