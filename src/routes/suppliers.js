'use strict';
/**
 * suppliers.js — Suppliers & Contracts directory + compliance-registrations tracker.
 * Mounted at /api/suppliers (server-unified.js). Manager-gated (same pattern as rota.js).
 *
 * Covers three previously-unmodelled areas:
 *   - suppliers                : vendor/service-provider directory
 *   - supplier_contracts       : utility/service/subscription/lease/insurance contracts
 *   - compliance_registrations : ICO / MPLC / Ofsted / insurance / food-hygiene renewals
 *
 * GET /api/suppliers/renewals?within_days=90 powers the Upcoming Renewals tab and the
 * nursery-watchdog "renewals due soon" check.
 *
 * POST /api/suppliers/discover scans the office mailbox (read-only) via the EXISTING
 * Google SA reader (lib/gmail-sender.js listInbox) and clusters senders into supplier
 * SUGGESTIONS — it never inserts anything.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

const managerOnly = (req, res, next) => {
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};

// ── validation helpers ────────────────────────────────────────────────────────
const SUPPLIER_COLS = ['name', 'category', 'contact_name', 'email', 'phone', 'website', 'account_ref', 'notes', 'status'];
const CONTRACT_COLS = ['supplier_id', 'title', 'contract_type', 'account_number', 'start_date', 'renewal_date', 'end_date',
  'monthly_cost_pence', 'annual_cost_pence', 'auto_renew', 'notice_period_days', 'notes', 'document_url', 'status'];
const REG_COLS = ['name', 'reference_number', 'provider', 'issued_date', 'expiry_date', 'renewal_cost_pence',
  'auto_renew', 'responsible_person', 'notes', 'document_url', 'status'];

// Whitelist sort columns per entity so the ?sort= param can't inject SQL.
const SORTABLE = {
  suppliers: ['name', 'category', 'status', 'created_at', 'updated_at'],
  contracts: ['title', 'contract_type', 'renewal_date', 'start_date', 'end_date', 'monthly_cost_pence', 'annual_cost_pence', 'status', 'created_at'],
  registrations: ['name', 'provider', 'expiry_date', 'issued_date', 'status', 'created_at'],
};
function orderClause(entity, req, fallback) {
  const col = SORTABLE[entity].includes(req.query.sort) ? req.query.sort : fallback;
  const dir = String(req.query.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  return `ORDER BY ${col} ${dir} NULLS LAST`;
}
// Build an INSERT/UPDATE column set from an allow-list + the request body.
function pick(cols, body) {
  const out = {};
  for (const c of cols) if (body[c] !== undefined) out[c] = body[c] === '' ? null : body[c];
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// SUPPLIERS
// ════════════════════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const where = req.query.include_inactive === '1' ? '' : "WHERE status <> 'inactive'";
    const { rows } = await db.query(`
      SELECT s.*,
             (SELECT COUNT(*)::int FROM supplier_contracts c WHERE c.supplier_id = s.id) AS contract_count
      FROM suppliers s
      ${where}
      ${orderClause('suppliers', req, 'name')}
    `);
    res.json(rows);
  } catch (err) { console.error('suppliers list error:', err.message); res.status(500).json({ error: err.message }); }
});

router.get('/item/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM suppliers WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { rows: contracts } = await db.query(
      'SELECT * FROM supplier_contracts WHERE supplier_id = $1 ORDER BY renewal_date ASC NULLS LAST', [req.params.id]);
    res.json({ ...rows[0], contracts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', managerOnly, async (req, res) => {
  try {
    if (!req.body.name) return res.status(400).json({ error: 'name required' });
    const data = pick(SUPPLIER_COLS, req.body);
    const cols = Object.keys(data), vals = Object.values(data);
    const ph = cols.map((_, i) => `$${i + 1}`);
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO suppliers (${cols.join(',')}) VALUES (${ph.join(',')}) RETURNING *`, vals);
    res.status(201).json(rows[0]);
  } catch (err) { console.error('suppliers create error:', err.message); res.status(500).json({ error: err.message }); }
});

router.put('/:id', managerOnly, async (req, res) => {
  try {
    const data = pick(SUPPLIER_COLS, req.body);
    if (!Object.keys(data).length) return res.status(400).json({ error: 'no fields to update' });
    data.updated_at = new Date().toISOString();
    const cols = Object.keys(data), vals = Object.values(data);
    const set = cols.map((c, i) => `${c} = $${i + 1}`);
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE suppliers SET ${set.join(',')} WHERE id = $${cols.length + 1} RETURNING *`, [...vals, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { console.error('suppliers update error:', err.message); res.status(500).json({ error: err.message }); }
});

// Soft-delete by default (status=inactive); ?hard=1 removes the row (+ its contracts via FK cascade).
router.delete('/:id', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    if (req.query.hard === '1') {
      const { rowCount } = await db.query('DELETE FROM suppliers WHERE id = $1', [req.params.id]);
      return res.json({ deleted: rowCount });
    }
    const { rows } = await db.query(
      "UPDATE suppliers SET status='inactive', updated_at=now() WHERE id=$1 RETURNING *", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// SUPPLIER CONTRACTS
// ════════════════════════════════════════════════════════════════════════════
router.get('/contracts', async (req, res) => {
  try {
    const db = getPool();
    const params = [];
    let where = "WHERE c.status <> 'inactive'";
    if (req.query.supplier_id) { params.push(req.query.supplier_id); where = `WHERE c.supplier_id = $${params.length}`; }
    const { rows } = await db.query(`
      SELECT c.*, s.name AS supplier_name, s.category AS supplier_category
      FROM supplier_contracts c
      LEFT JOIN suppliers s ON s.id = c.supplier_id
      ${where}
      ${orderClause('contracts', req, 'renewal_date')}
    `, params);
    res.json(rows);
  } catch (err) { console.error('contracts list error:', err.message); res.status(500).json({ error: err.message }); }
});

router.post('/contracts', managerOnly, async (req, res) => {
  try {
    if (!req.body.title) return res.status(400).json({ error: 'title required' });
    const data = pick(CONTRACT_COLS, req.body);
    const cols = Object.keys(data), vals = Object.values(data);
    const ph = cols.map((_, i) => `$${i + 1}`);
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO supplier_contracts (${cols.join(',')}) VALUES (${ph.join(',')}) RETURNING *`, vals);
    res.status(201).json(rows[0]);
  } catch (err) { console.error('contract create error:', err.message); res.status(500).json({ error: err.message }); }
});

router.put('/contracts/:id', managerOnly, async (req, res) => {
  try {
    const data = pick(CONTRACT_COLS, req.body);
    if (!Object.keys(data).length) return res.status(400).json({ error: 'no fields to update' });
    const cols = Object.keys(data), vals = Object.values(data);
    const set = cols.map((c, i) => `${c} = $${i + 1}`);
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE supplier_contracts SET ${set.join(',')} WHERE id = $${cols.length + 1} RETURNING *`, [...vals, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { console.error('contract update error:', err.message); res.status(500).json({ error: err.message }); }
});

router.delete('/contracts/:id', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rowCount } = await db.query('DELETE FROM supplier_contracts WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// COMPLIANCE REGISTRATIONS
// ════════════════════════════════════════════════════════════════════════════
router.get('/registrations', async (req, res) => {
  try {
    const db = getPool();
    const where = req.query.include_inactive === '1' ? '' : "WHERE status <> 'inactive'";
    const { rows } = await db.query(`SELECT * FROM compliance_registrations ${where} ${orderClause('registrations', req, 'expiry_date')}`);
    res.json(rows);
  } catch (err) { console.error('registrations list error:', err.message); res.status(500).json({ error: err.message }); }
});

router.post('/registrations', managerOnly, async (req, res) => {
  try {
    if (!req.body.name) return res.status(400).json({ error: 'name required' });
    const data = pick(REG_COLS, req.body);
    const cols = Object.keys(data), vals = Object.values(data);
    const ph = cols.map((_, i) => `$${i + 1}`);
    const db = getPool();
    // name is UNIQUE — upsert so re-adding a seeded row edits it rather than 500ing.
    const set = cols.filter(c => c !== 'name').map(c => `${c} = EXCLUDED.${c}`);
    const { rows } = await db.query(
      `INSERT INTO compliance_registrations (${cols.join(',')}) VALUES (${ph.join(',')})
       ON CONFLICT (name) DO UPDATE SET ${set.join(',')} RETURNING *`, vals);
    res.status(201).json(rows[0]);
  } catch (err) { console.error('registration create error:', err.message); res.status(500).json({ error: err.message }); }
});

router.put('/registrations/:id', managerOnly, async (req, res) => {
  try {
    const data = pick(REG_COLS, req.body);
    if (!Object.keys(data).length) return res.status(400).json({ error: 'no fields to update' });
    const cols = Object.keys(data), vals = Object.values(data);
    const set = cols.map((c, i) => `${c} = $${i + 1}`);
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE compliance_registrations SET ${set.join(',')} WHERE id = $${cols.length + 1} RETURNING *`, [...vals, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { console.error('registration update error:', err.message); res.status(500).json({ error: err.message }); }
});

router.delete('/registrations/:id', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    if (req.query.hard === '1') {
      const { rowCount } = await db.query('DELETE FROM compliance_registrations WHERE id = $1', [req.params.id]);
      return res.json({ deleted: rowCount });
    }
    const { rows } = await db.query(
      "UPDATE compliance_registrations SET status='inactive' WHERE id=$1 RETURNING *", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// RENEWALS — contracts + registrations due within a window (dashboard + watchdog)
// ════════════════════════════════════════════════════════════════════════════
router.get('/renewals', async (req, res) => {
  try {
    const within = Math.max(1, Math.min(730, parseInt(req.query.within_days, 10) || 90));
    const db = getPool();
    const { rows: contracts } = await db.query(`
      SELECT c.id, c.title, c.contract_type, c.renewal_date AS due_date, c.auto_renew,
             c.notice_period_days, c.annual_cost_pence, c.monthly_cost_pence,
             s.name AS supplier_name, s.category AS supplier_category,
             (c.renewal_date - CURRENT_DATE) AS days_left
      FROM supplier_contracts c
      LEFT JOIN suppliers s ON s.id = c.supplier_id
      WHERE c.status <> 'inactive' AND c.renewal_date IS NOT NULL
        AND c.renewal_date <= CURRENT_DATE + ($1 || ' days')::interval
      ORDER BY c.renewal_date ASC
    `, [within]);
    const { rows: registrations } = await db.query(`
      SELECT id, name, provider, expiry_date AS due_date, auto_renew, renewal_cost_pence,
             responsible_person, (expiry_date - CURRENT_DATE) AS days_left
      FROM compliance_registrations
      WHERE status <> 'inactive' AND expiry_date IS NOT NULL
        AND expiry_date <= CURRENT_DATE + ($1 || ' days')::interval
      ORDER BY expiry_date ASC
    `, [within]);
    const tag = r => ({ ...r, days_left: r.days_left == null ? null : Number(r.days_left),
      urgency: r.days_left == null ? 'none' : (Number(r.days_left) <= 14 ? 'critical' : (Number(r.days_left) <= 30 ? 'warn' : 'info')) });
    res.json({
      within_days: within,
      contracts: contracts.map(r => ({ ...tag(r), kind: 'contract' })),
      registrations: registrations.map(r => ({ ...tag(r), kind: 'registration' })),
    });
  } catch (err) { console.error('renewals error:', err.message); res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// EMAIL AUTO-DISCOVERY (phase 1) — read-only mailbox scan → supplier SUGGESTIONS.
// Reuses the existing Google-SA reader (lib/gmail-sender.js listInbox). Never inserts.
// ════════════════════════════════════════════════════════════════════════════
// Freemail / internal domains we never suggest as suppliers.
const IGNORE_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'yahoo.co.uk',
  'icloud.com', 'aol.com', 'live.com', 'me.com', 'msn.com', 'protonmail.com',
  'example-nursery.co.uk', 'getwren.co.uk',
]);
function prettyFromDomain(domain) {
  const core = domain.replace(/\.(co\.uk|org\.uk|ac\.uk|com|net|org|io|uk)$/i, '').split('.').pop() || domain;
  return core.charAt(0).toUpperCase() + core.slice(1);
}

router.post('/discover', managerOnly, async (req, res) => {
  let gmail;
  try { gmail = require('../lib/gmail-sender'); }
  catch (e) { return res.json({ available: false, reason: 'gmail-sender lib not present', suggestions: [] }); }

  if (!gmail.isConfigured || !gmail.isConfigured()) {
    return res.json({ available: false, reason: 'Google service-account key not configured', suggestions: [] });
  }

  try {
    const days = Math.max(1, Math.min(180, parseInt(req.body && req.body.days, 10) || 60));
    const messages = await gmail.listInbox({
      maxResults: Math.min(200, parseInt(req.body && req.body.max, 10) || 120),
      query: `newer_than:${days}d`,
    });

    // Existing supplier emails/domains — so we only suggest NEW ones.
    const db = getPool();
    const { rows: existing } = await db.query("SELECT LOWER(email) AS email FROM suppliers WHERE email IS NOT NULL AND email <> ''");
    const knownDomains = new Set(existing.map(r => (r.email.split('@')[1] || '').trim()).filter(Boolean));

    const clusters = {};
    for (const m of messages) {
      const email = (m.fromEmail || '').toLowerCase();
      const domain = email.split('@')[1];
      if (!domain || IGNORE_DOMAINS.has(domain) || knownDomains.has(domain)) continue;
      if (!clusters[domain]) clusters[domain] = { domain, count: 0, sample_subject: m.subject || '', sample_from: m.fromName || email, names: {} };
      const c = clusters[domain];
      c.count++;
      if (m.fromName) c.names[m.fromName] = (c.names[m.fromName] || 0) + 1;
      if (!c.sample_subject && m.subject) c.sample_subject = m.subject;
    }

    const suggestions = Object.values(clusters).map(c => {
      const topName = Object.keys(c.names).sort((a, b) => c.names[b] - c.names[a])[0];
      return {
        domain: c.domain,
        suggested_name: topName || prettyFromDomain(c.domain),
        email_domain: '@' + c.domain,
        message_count: c.count,
        sample_subject: c.sample_subject,
      };
    }).sort((a, b) => b.message_count - a.message_count);

    res.json({ available: true, scanned: messages.length, window_days: days, suggestions });
  } catch (err) {
    if (gmail.isAuthScopeError && gmail.isAuthScopeError(err)) {
      return res.json({ available: false, reason: 'gmail.readonly domain-wide-delegation scope not propagated (403/unauthorized_client)', suggestions: [] });
    }
    console.error('suppliers /discover error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// REGISTER (b352, 2026-09-22) — the supplier & subscription register.
// The 15 September contacts-and-subscriptions audit, loaded into the tables above by
// scripts/b352-import-supplier-register.js, as a register a manager works from:
// what each organisation is for, what recurring things cost and who could cancel them,
// which ones would stop the nursery if they lapsed, "still used?", and recurring bank
// payments to someone who is NOT in it (how a forgotten subscription is found).
// Same manager guard as the rest of this file. Nothing here reads a mailbox or a drive.
// ════════════════════════════════════════════════════════════════════════════
const SR = require('../lib/supplier-register');
const ORG_TYPES = ['regulator', 'utility', 'IT', 'trades', 'professional services', 'training', 'finance', 'insurance',
  'supplies', 'recruitment', 'local authority', 'property', 'other'];
// "Damaged" = the source HAD something and the name-stripping ruined it. Merely absent fields are not damage.
const DAMAGE = ['name_stripped', 'name_missing', 'what_for_partly_stripped', 'email_stripped', 'email_invalid', 'phone_stripped',
  'website_stripped', 'type_unrecognised', 'vendor_name_stripped', 'description_partly_stripped'];

router.get('/register', async (req, res) => {
  try {
    const db = getPool();
    const q = String(req.query.q || '').trim().slice(0, 100);
    const view = ['all', 'subscriptions', 'continuity', 'needs_review', 'unsure'].includes(req.query.view) ? req.query.view : 'all';
    const params = [];
    const where = ["s.status <> 'inactive'"];
    if (q) { params.push('%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%'); where.push(`(s.name ILIKE $1 OR s.what_for ILIKE $1 OR s.org_type ILIKE $1 OR s.email ILIKE $1)`); }
    if (view === 'subscriptions') where.push(`EXISTS (SELECT 1 FROM supplier_contracts c WHERE c.supplier_id = s.id AND c.status <> 'inactive')`);
    if (view === 'continuity') where.push(`s.continuity_critical`);
    if (view === 'needs_review') where.push(`s.import_reviewed_at IS NULL AND s.import_issues ?| $${params.push(DAMAGE)}::text[]`);
    if (view === 'unsure') where.push(`EXISTS (SELECT 1 FROM supplier_contracts c WHERE c.supplier_id = s.id AND c.status <> 'inactive' AND (c.still_used IS NULL OR c.still_used = 'unsure'))`);

    const { rows: sup } = await db.query(`
      SELECT s.id, s.name, s.category, s.org_type, s.what_for, s.email, s.phone, s.website, s.contact_name, s.notes, s.status,
             s.last_contact_month, s.continuity_critical, s.continuity_reason, s.import_source, s.import_issues, s.import_reviewed_at,
             (s.import_reviewed_at IS NULL AND s.import_issues ?| $${params.push(DAMAGE)}::text[]) AS needs_review
        FROM suppliers s WHERE ${where.join(' AND ')}
       ORDER BY s.continuity_critical DESC, lower(s.name) ASC LIMIT 1000`, params);

    const ids = sup.map(s => s.id);
    const { rows: con } = ids.length ? await db.query(`
      SELECT c.id, c.supplier_id, c.title, c.contract_type, c.frequency, c.cost_pence, c.monthly_cost_pence, c.annual_cost_pence,
             c.renewal_date, c.auto_renew, c.paid_by, c.who_can_cancel, c.still_used, c.still_used_at, c.last_seen_month, c.import_issues,
             trim(coalesce(st.first_name,'') || ' ' || coalesce(st.last_name,'')) AS still_used_by_name
        FROM supplier_contracts c LEFT JOIN staff st ON st.id = c.still_used_by
       WHERE c.supplier_id = ANY($1::int[]) AND c.status <> 'inactive'
       ORDER BY c.renewal_date ASC NULLS LAST, c.id`, [ids]) : { rows: [] };
    const byS = new Map();
    for (const c of con) { if (!byS.has(c.supplier_id)) byS.set(c.supplier_id, []); byS.get(c.supplier_id).push(c); }

    const { rows: cnt } = await db.query(`
      SELECT (SELECT count(*)::int FROM suppliers WHERE status <> 'inactive')                                              AS suppliers,
             (SELECT count(*)::int FROM supplier_contracts WHERE status <> 'inactive')                                     AS subscriptions,
             (SELECT count(*)::int FROM suppliers WHERE status <> 'inactive' AND continuity_critical)                      AS continuity,
             (SELECT count(*)::int FROM suppliers WHERE status <> 'inactive' AND import_reviewed_at IS NULL AND import_issues ?| $1::text[]) AS needs_review,
             (SELECT count(*)::int FROM supplier_contracts WHERE status <> 'inactive' AND still_used = 'yes')              AS still_yes,
             (SELECT count(*)::int FROM supplier_contracts WHERE status <> 'inactive' AND still_used = 'no')               AS still_no,
             (SELECT count(*)::int FROM supplier_contracts WHERE status <> 'inactive' AND still_used = 'unsure')           AS still_unsure,
             (SELECT count(*)::int FROM supplier_contracts WHERE status <> 'inactive' AND still_used IS NULL)              AS still_unset,
             (SELECT count(*)::int FROM supplier_contracts WHERE status <> 'inactive' AND cost_pence IS NULL AND monthly_cost_pence IS NULL AND annual_cost_pence IS NULL) AS no_cost`, [DAMAGE]);

    res.json({ ok: true, counts: cnt[0], suppliers: sup.map(s => ({ ...s, contracts: byS.get(s.id) || [] })), truncated: sup.length >= 1000 });
  } catch (err) {
    if (err.code === '42703') return res.status(503).json({ error: 'not_migrated', message: 'The b352 migration has not been applied to this database.' });
    console.error('register list error:', err.message); res.status(500).json({ error: err.message });
  }
});

router.put('/register/:id', managerOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const set = [], vals = [];
    const push = (col, v) => { vals.push(v); set.push(`${col} = $${vals.length}`); };
    for (const c of ['name', 'what_for', 'email', 'phone', 'website', 'contact_name', 'notes', 'continuity_reason']) {
      if (b[c] !== undefined) push(c, b[c] === '' || b[c] === null ? null : String(b[c]).trim().slice(0, 1000));
    }
    if (b.name !== undefined && !String(b.name || '').trim()) return res.status(400).json({ error: 'name_required' });
    if (b.org_type !== undefined) {
      if (b.org_type !== null && !ORG_TYPES.includes(b.org_type)) return res.status(400).json({ error: 'bad_org_type', allowed: ORG_TYPES });
      push('org_type', b.org_type);
    }
    if (b.continuity_critical !== undefined) push('continuity_critical', b.continuity_critical === true);
    if (b.reviewed !== undefined) { set.push(`import_reviewed_at = ${b.reviewed === true ? 'now()' : 'NULL'}`); }
    if (!set.length) return res.status(400).json({ error: 'no fields to update' });
    set.push('updated_at = now()');
    vals.push(req.params.id);
    const { rows } = await getPool().query(`UPDATE suppliers SET ${set.join(', ')} WHERE id = $${vals.length} RETURNING id`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, id: rows[0].id });
  } catch (err) { console.error('register update error:', err.message); res.status(500).json({ error: err.message }); }
});

router.put('/register/contracts/:id', managerOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const set = [], vals = [];
    const push = (col, v) => { vals.push(v); set.push(`${col} = $${vals.length}`); };
    if (b.who_can_cancel !== undefined) push('who_can_cancel', b.who_can_cancel ? String(b.who_can_cancel).trim().slice(0, 200) : null);
    if (b.still_used !== undefined) {
      if (b.still_used !== null && !['yes', 'no', 'unsure'].includes(b.still_used)) return res.status(400).json({ error: 'bad_still_used', allowed: ['yes', 'no', 'unsure', null] });
      push('still_used', b.still_used);
      if (b.still_used === null) { set.push('still_used_by = NULL', 'still_used_at = NULL'); }
      else { push('still_used_by', req.user.id || null); set.push('still_used_at = now()'); }
    }
    if (b.paid_by !== undefined) {
      if (b.paid_by !== null && !['direct_debit', 'card', 'invoice', 'unknown'].includes(b.paid_by)) return res.status(400).json({ error: 'bad_paid_by' });
      push('paid_by', b.paid_by);
    }
    if (b.frequency !== undefined) {
      if (b.frequency !== null && !['monthly', 'annual', 'unknown'].includes(b.frequency)) return res.status(400).json({ error: 'bad_frequency' });
      push('frequency', b.frequency);
    }
    if (b.cost_pence !== undefined) {
      const n = b.cost_pence === null || b.cost_pence === '' ? null : parseInt(b.cost_pence, 10);
      if (n !== null && (!Number.isFinite(n) || n < 0)) return res.status(400).json({ error: 'bad_cost_pence' });
      push('cost_pence', n);
    }
    if (b.renewal_date !== undefined) {
      if (b.renewal_date !== null && b.renewal_date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(b.renewal_date)) return res.status(400).json({ error: 'bad_renewal_date' });
      push('renewal_date', b.renewal_date || null);
    }
    if (b.auto_renew !== undefined) push('auto_renew', b.auto_renew === null ? null : b.auto_renew === true);
    if (!set.length) return res.status(400).json({ error: 'no fields to update' });
    vals.push(req.params.id);
    const { rows } = await getPool().query(`UPDATE supplier_contracts SET ${set.join(', ')} WHERE id = $${vals.length} RETURNING id`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, id: rows[0].id });
  } catch (err) { console.error('register contract update error:', err.message); res.status(500).json({ error: err.message }); }
});

// Recurring bank payments to someone who is not in the register. Outgoing lines only; a payee has to turn up in at
// least three different months at a steady size to count; anything already in the register, already answered
// ("not a supplier"), or that names a person (staff, a child's family) is left out — payroll and refunds are not
// subscriptions and a person's name is not something to list.
router.get('/register/unregistered-payments', async (req, res) => {
  try {
    const db = getPool();
    const { rows: lines } = await db.query(`
      SELECT transaction_date, amount_pence, payee_name, description
        FROM bank_statement_lines WHERE amount_pence < 0 AND transaction_date >= CURRENT_DATE - interval '18 months'`);
    const { rows: span } = await db.query(`
      SELECT count(DISTINCT to_char(transaction_date, 'YYYY-MM'))::int AS months, min(transaction_date) AS first, max(transaction_date) AS last
        FROM bank_statement_lines`);
    const recurring = SR.findRecurring(lines);
    const { rows: registered } = await db.query(`SELECT id, name, website, email FROM suppliers WHERE status <> 'inactive'`);
    let answered = new Map();
    try { answered = new Map((await db.query(`SELECT payee_key, decision FROM supplier_payee_reviews`)).rows.map(r => [r.payee_key, r.decision])); }
    catch (e) { if (e.code !== '42P01') throw e; }

    const rr = require('../lib/reading-room-scan');
    const guardFam = await rr.buildGuard(sql => db.query(sql));          // children, their families, family contacts
    const staffNames = new Set((await db.query(`SELECT first_name, last_name FROM staff`)).rows
      .map(r => `${r.first_name || ''} ${r.last_name || ''}`.toLowerCase().replace(/[^a-z]+/g, ' ').trim()).filter(Boolean));

    let inRegister = 0, answeredN = 0, people = 0;
    const flagged = [];
    for (const p of recurring) {
      if (answered.has(p.payee_key)) { answeredN++; continue; }
      if (SR.matchRegister(p, registered)) { inRegister++; continue; }
      const norm = String(p.payee || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
      if (staffNames.has(norm) || guardFam.check(p.payee).hit) { people++; continue; }
      flagged.push(p);
    }
    const months = span[0].months || 0;
    res.json({
      ok: true,
      checked: { outgoing_lines: lines.length, months_of_history: months, from: span[0].first, to: span[0].last, recurring_payees: recurring.length },
      already_in_register: inRegister, already_answered: answeredN, left_out_as_people: people,
      note: months < 3 ? `The bank feed holds only ${months} month${months === 1 ? '' : 's'} of history, so nothing can have repeated three times yet.` : null,
      flagged,
    });
  } catch (err) {
    if (err.code === '42P01') return res.json({ ok: true, checked: { outgoing_lines: 0, months_of_history: 0 }, flagged: [], note: 'No bank feed on this database.' });
    console.error('unregistered payments error:', err.message); res.status(500).json({ error: err.message });
  }
});

router.post('/register/payees/review', managerOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const key = String(b.payee_key || '').trim().slice(0, 120);
    if (!key) return res.status(400).json({ error: 'payee_key_required' });
    if (!['not_a_supplier', 'registered'].includes(b.decision)) return res.status(400).json({ error: 'bad_decision' });
    await getPool().query(`
      INSERT INTO supplier_payee_reviews (payee_key, decision, supplier_id, note, decided_by)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (payee_key) DO UPDATE SET decision = EXCLUDED.decision, supplier_id = EXCLUDED.supplier_id,
                                            note = EXCLUDED.note, decided_by = EXCLUDED.decided_by, decided_at = now()`,
      [key, b.decision, b.supplier_id || null, b.note ? String(b.note).slice(0, 500) : null, req.user.id || null]);
    res.json({ ok: true });
  } catch (err) { console.error('payee review error:', err.message); res.status(500).json({ error: err.message }); }
});


module.exports = router;
