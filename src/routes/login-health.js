// login-20261023 — Roost → Login health. Manager-only, Roost (admin portal) only.
//
//   GET  /api/login-health                     who can sign in, and what is missing
//   GET  /api/login-health/wren-id-preview/:id the Wren ID set-up email, as it would be sent,
//                                              so a manager sees it BEFORE pressing Send
//   POST /api/login-health/sync-access         push Cloudflare's parents, staff and Roost lists now —
//                                              the same push the 07:17 job makes (refuses off LADN prod)
//
// The page's other fix buttons use endpoints that already exist and are already
// human-clicked: POST /api/auth/lockouts/unlock and
// POST /api/auth/oidc/enrolment/staff/invite. Nothing here sends mail, changes a
// PIN or a second factor, or loosens an Access policy.
const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { getPool } = require('../db/pool');
const { recordAudit } = require('../utils/audit');
const { loginHealth } = require('../lib/login-health');

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin'];

router.use(authenticate);
router.use((req, res, next) => {
  if ((req._portal || 'learning') !== 'admin') return res.status(404).json({ error: 'Not found' });
  if (!MANAGER_ROLES.includes(req.user && req.user.role)) return res.status(403).json({ error: 'Manager access required' });
  next();
});

router.get('/', async (req, res) => {
  try {
    const out = await loginHealth(getPool(), { fresh: req.query.fresh === '1' });
    res.set('Cache-Control', 'no-store');
    res.json(out);
  } catch (e) {
    console.error('[login-health]', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/wren-id-preview/:staff_id', async (req, res) => {
  const id = Number(req.params.staff_id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad staff id' });
  try {
    const { rows } = await getPool().query(
      'SELECT id, first_name, last_name, role, lower(trim(email)) AS email FROM staff WHERE id=$1 AND is_active=true', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const s = rows[0];
    if (!s.email) return res.status(400).json({ error: 'no_email', message: 'This person has no email on file.' });
    const { composeInviteEmail } = require('../lib/wren-id-invite');
    const { staffPortalUrlFor, STAFF_INVITE_TTL_MS } = require('./auth-oidc');
    const expires = new Date(Date.now() + STAFF_INVITE_TTL_MS);
    const parts = composeInviteEmail({
      firstName: s.first_name,
      link: '[a one-time link, made when you press Send]',
      expires,
      portalUrl: await staffPortalUrlFor(req, id, s.role),
      senderName: String(req.user.name || '').trim().split(/\s+/)[0] || 'the office',
    });
    res.json({ to: s.email, name: `${s.first_name || ''} ${s.last_name || ''}`.trim(), subject: parts.subject, text: parts.text });
  } catch (e) {
    console.error('[login-health] preview', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/login-health/sync-access — push all three Cloudflare lists (parents, staff HR, Roost) now:
// the same push src/jobs/access-list-sync.js makes at 07:17. Refuses off LADN production.
router.post('/sync-access', async (req, res) => {
  try {
    const r = await require('../lib/cf-allowlist').syncAllAccessLists();
    const errs = Object.entries(r).filter(([, v]) => v && v.error);
    recordAudit({ req, action: 'update', entity_type: 'cf_access_policy', meta: { change: 'access_lists_synced', source: 'login-health',
      result: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v && (v.error ? 'error' : v.count)])) } });
    if (errs.length === 3) {
      const offProd = errs.every(([, v]) => /refus/i.test(v.error));
      return res.status(offProd ? 409 : 502).json({ error: offProd ? 'not_ladn_production' : 'cloudflare_error', message: errs[0][1].error, result: r });
    }
    res.json({ ok: errs.length === 0, result: r });
  } catch (e) {
    res.status(502).json({ error: 'cloudflare_error', message: e.message });
  }
});

module.exports = router;
