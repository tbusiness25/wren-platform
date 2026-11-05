'use strict';
/**
 * parent-notification-settings.js — b340 (2026-09-18)
 * ─────────────────────────────────────────────────────────────────────────────
 * The API behind the parents app's Notifications screen (/welcome/notifications/settings).
 * Mounted at /welcome/notifications/api — a /welcome/<feature>/api path, so the shared
 * requireParentIdentity gate in server-unified.js has already run and req.parent.email is the
 * signed-in parent. The identity is taken from THAT, never from the body: a request cannot
 * choose, subscribe or remove anything on behalf of another parent's address.
 *
 *   GET    /prefs                 — every category with the effective channel, the devices,
 *                                   and the honest list of what cannot be switched yet
 *   PUT    /prefs                 — { category, channel }   push | email | both | off
 *   GET    /push/config           — { configured, key }  (key only when Wren has VAPID keys)
 *   POST   /push/subscribe        — { subscription }  one row per device, on an explicit tap
 *   POST   /push/unsubscribe      — { endpoint }
 *   DELETE /push/devices/:id      — remove one of this parent's devices
 * ─────────────────────────────────────────────────────────────────────────────
 */
const express = require('express');
const parentRouter = express.Router();

const { getPool } = require('../db/pool');
const { parentEmailOf } = require('../lib/parent-identity');
const P = require('../services/parent-notification-prefs');
const N = require('../services/parent-notify');

parentRouter.use(express.json({ limit: '16kb' }));

const fail = (res, e) => {
  const status = e && e.status ? e.status : 500;
  if (status === 500) console.error('parent notification settings:', e && e.message);
  res.status(status).json({ error: status === 500 ? 'Internal error' : e.message });
};

async function snapshot(db, email) {
  const [categories, devices] = await Promise.all([P.getPrefs(db, email), P.listDevices(db, email)]);
  return {
    email_hint: P.maskEmail(email),
    categories,
    not_yet: P.NOT_YET,
    push: {
      configured: N.pushConfigured(),
      devices: devices.map(d => ({ id: d.id, label: d.device_label || 'This device', created_at: d.created_at,
        last_used_at: d.last_used_at, endpoint: d.endpoint })),
    },
  };
}

parentRouter.get('/prefs', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  try { res.json(await snapshot(getPool(), email)); } catch (e) { fail(res, e); }
});

parentRouter.put('/prefs', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const { category, channel } = req.body || {};
  try {
    const db = getPool();
    await P.setChannel(db, email, String(category || ''), String(channel || ''));
    res.json(await snapshot(db, email));
  } catch (e) { fail(res, e); }
});

parentRouter.get('/push/config', (req, res) => {
  if (!parentEmailOf(req)) return res.status(401).json({ error: 'Not authenticated' });
  const configured = N.pushConfigured();
  res.json({ configured, key: configured ? process.env.VAPID_PUBLIC_KEY : null });
});

parentRouter.post('/push/subscribe', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  if (!N.pushConfigured()) return res.status(503).json({ error: 'push_not_configured' });
  try {
    const db = getPool();
    await P.addDevice(db, email, req.body && req.body.subscription, req.headers['user-agent']);
    res.json(await snapshot(db, email));
  } catch (e) { fail(res, e); }
});

parentRouter.post('/push/unsubscribe', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const db = getPool();
    await P.removeDevice(db, email, { endpoint: String((req.body && req.body.endpoint) || '') });
    res.json(await snapshot(db, email));
  } catch (e) { fail(res, e); }
});

parentRouter.delete('/push/devices/:id', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  try {
    const db = getPool();
    await P.removeDevice(db, email, { id });
    res.json(await snapshot(db, email));
  } catch (e) { fail(res, e); }
});

module.exports = { parentRouter };
