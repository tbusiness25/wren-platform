'use strict';
/**
 * pippin.js — b518 (2026-10-20) — "Send to Toby's Pippin (home calendar, shared at home)"
 *
 * the office manager and the admissions lead (and Toby) can push one item from the managers' hub to Toby's
 * household app at home with one click: a calendar event, a to-do, a plan or a note.
 *
 * THE ORDER MATTERS, and it is the whole point of this file:
 *   1. /preview  — build what WOULD be sent, run the guard, show it back. Nothing
 *                  leaves Wren. The UI will not enable Send until a preview passed.
 *   2. /send     — run the guard AGAIN on the server (a client cannot skip it),
 *                  then POST it to the bridge, record the row and audit it.
 * The guard (src/lib/pippin-guard.js) is the control; the bridge's own filter is
 * the net under it, and it cannot see a plain first name, so this does.
 *
 * Who may use it: the managers' hub only (Toby, the office manager, the admissions lead — the
 * managers_hub_staff_ids setting). A parent token is refused by the router, and
 * 'pippin' is on PARENT_DENY as well.
 *
 * Calendar events land on Toby's SHARED household calendar — others at home can see
 * them. /preview says so in `lands`, and the button says so in the UI.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const CL = require('../lib/calendar-layers');
const PG = require('../lib/pippin-guard');
const PB = require('../lib/pippin-bridge');
const { recordAudit } = require('../utils/audit');

router.use(authenticate);
router.use((req, res, next) => {
  if (req.user && req.user.role === 'parent') return res.status(403).json({ error: 'Not available' });
  next();
});

async function gate(req, res) {
  const db = getPool();
  if (!(await CL.inManagersHub(db, req.user))) {
    res.status(403).json({ error: 'managers_only', message: 'Send to Pippin is for Toby, the office manager and the admissions lead.' });
    return false;
  }
  return true;
}

const type_of = (d) => String((d && d.type) || 'unknown').slice(0, 32);

async function enabled(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key='pippin_send_enabled'`);
    return !rows.length || rows[0].value !== 'false';
  } catch (_) { return true; }
}

// The guard is rebuilt at most every 5 minutes; the names only live in this process.
let guardCache = null;
async function getGuard(db) {
  if (guardCache && Date.now() - guardCache.at < 5 * 60 * 1000) return guardCache.g;
  const g = await PG.buildGuard((sql) => db.query(sql));
  guardCache = { at: Date.now(), g };
  return g;
}

/** Build the draft the sender asked for, from the thing they clicked. */
async function draftFrom(db, body) {
  const b = body || {};
  if (b.source_kind === 'event' && b.source_id) {
    const { rows } = await db.query(
      `SELECT id, title, description, event_date, end_date, start_time, end_time, layer
         FROM events WHERE id=$1`, [parseInt(b.source_id, 10)]);
    if (!rows.length) return { error: 'Event not found' };
    const e = rows[0];
    const d = CL.ymd(e.event_date);
    const start = e.start_time ? `${d}T${String(e.start_time).slice(0, 5)}` : d;
    const end = e.end_time ? `${CL.ymd(e.end_date) || d}T${String(e.end_time).slice(0, 5)}`
      : (e.end_date && CL.ymd(e.end_date) !== d ? CL.ymd(e.end_date) : '');
    return {
      type: b.type || 'calendar_event',
      title: b.title != null ? b.title : e.title,
      start: b.start || start,
      end: b.end != null ? b.end : end,
      note: b.note != null ? b.note : '',          // the description is NOT carried over by default
      due: b.due, priority: b.priority, steps: b.steps, body: b.body,
    };
  }
  if (b.source_kind === 'task' && b.source_id) {
    const { rows } = await db.query(
      `SELECT id, title, due_date FROM tasks WHERE id=$1`, [parseInt(b.source_id, 10)]).catch(() => ({ rows: [] }));
    if (!rows.length) return { error: 'Task not found' };
    const t = rows[0];
    return {
      type: b.type || 'todo',
      title: b.title != null ? b.title : t.title,
      due: b.due != null ? b.due : (t.due_date ? CL.ymd(t.due_date) : ''),
      priority: b.priority || 'normal',
      steps: b.steps, note: b.note, body: b.body, start: b.start,
    };
  }
  if (b.source_kind === 'note' && b.source_id) {
    const { rows } = await db.query(
      `SELECT id, title, body FROM manager_hub_notes WHERE id=$1 AND deleted_at IS NULL`,
      [parseInt(b.source_id, 10)]).catch(() => ({ rows: [] }));
    if (!rows.length) return { error: 'Note not found' };
    const n = rows[0];
    return {
      type: b.type || 'note',
      title: b.title != null ? b.title : n.title,
      body: b.body != null ? b.body : (n.body || ''),
      steps: b.steps, note: b.note, due: b.due, priority: b.priority, start: b.start,
    };
  }
  // free-hand: exactly what the sender typed
  return {
    type: b.type, title: b.title, note: b.note, body: b.body,
    steps: b.steps, start: b.start, end: b.end, due: b.due, priority: b.priority,
  };
}

// ── GET /config ──────────────────────────────────────────────────────────────
router.get('/config', async (req, res) => {
  if (!(await gate(req, res))) return;
  const db = getPool();
  const hint = PB.configHint();     // never carries the token itself
  res.json({
    connected: hint.configured,
    enabled: await enabled(db),
    bridge: hint.base,
    looked_in: hint.looked_in,
    types: [
      { key: 'calendar_event', label: 'Calendar event', lands: 'Toby’s SHARED household calendar — others at home can see it' },
      { key: 'todo', label: 'To-do', lands: 'Toby’s Pippin inbox (private to him)' },
      { key: 'plan', label: 'Plan', lands: 'Toby’s Pippin inbox, with the steps in his morning briefing' },
      { key: 'note', label: 'Note', lands: 'Toby’s morning briefing at home' },
    ],
    button_label: 'Send to Toby’s Pippin (home calendar, shared at home)',
    rules: [
      'No child, parent or staff name — say the role instead.',
      'Nothing about safeguarding, medical, SEN or HR, however it is worded.',
      'Dates go in the date field, never in the words.',
      'Keep it generic: “Staff meeting 14:00”, not who it is with or why.',
    ],
  });
});

// ── POST /preview — nothing leaves Wren ──────────────────────────────────────
router.post('/preview', async (req, res) => {
  if (!(await gate(req, res))) return;
  try {
    const db = getPool();
    const draft = await draftFrom(db, req.body);
    if (draft.error) return res.status(404).json({ error: draft.error });
    const g = await getGuard(db);
    const r = PG.prepare(g, draft);
    res.json({
      ok: r.ok, item: r.item, preview: r.preview, lands: r.lands,
      refusals: r.refusals, stripped: r.stripped, notes: r.notes,
      connected: PB.isConfigured(), enabled: await enabled(db),
      guard: g.size,            // counts only — never a name
    });
  } catch (e) { console.error('[pippin] preview:', e.message); res.status(500).json({ error: e.message }); }
});

// ── POST /send ───────────────────────────────────────────────────────────────
router.post('/send', async (req, res) => {
  if (!(await gate(req, res))) return;
  const db = getPool();
  try {
    if (!(await enabled(db))) return res.status(403).json({ error: 'disabled', message: 'Send to Pippin is switched off.' });
    const draft = await draftFrom(db, req.body);
    if (draft.error) return res.status(404).json({ error: draft.error });

    // The guard runs again HERE. A client that skipped /preview gets the same answer.
    const g = await getGuard(db);
    const r = PG.prepare(g, draft);
    if (!r.ok) {
      // Worth a log line: "someone tried to send a child's name home" is exactly
      // the thing to be able to answer later. The CODES only — never the content,
      // which is what was refused in the first place.
      recordAudit({ req, action: 'view', entity_type: 'pippin_refused', entity_id: null,
        meta: { item_type: type_of(draft), codes: r.refusals.map((f) => f.code) } }).catch(() => {});
      return res.status(422).json({ ok: false, refused_by: 'wren', refusals: r.refusals, preview: r.preview });
    }
    if (!PB.isConfigured()) {
      return res.status(503).json({
        ok: false, refused_by: 'config', status: 'not_connected',
        message: 'The bridge to Pippin is not connected on this server. Nothing was sent.',
        looked_in: PB.configHint().looked_in,
      });
    }

    const b = req.body || {};
    const kind = ['event', 'task', 'note'].includes(b.source_kind) ? b.source_kind : 'adhoc';
    const sid = parseInt(b.source_id, 10);
    // An idempotent, stable id: resending the same thing is a duplicate at home,
    // not a second copy. A deliberate resend passes resend=true for a fresh id.
    const stamp = b.resend ? '-' + Date.now().toString(36) : '';
    const pippinId = `roost-${r.item.type.replace('_', '')}-${kind}-${Number.isInteger(sid) ? sid : 'x'}${stamp}`
      .replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
    if (pippinId.length < 8) return res.status(400).json({ error: 'could not build an id' });

    const sent = await PB.send(pippinId, r.item);
    const status = sent.status === 'delivered' ? 'delivered' : 'failed';

    const { rows } = await db.query(
      `INSERT INTO pippin_sends (pippin_id, item_type, source_kind, source_id, title, payload,
                                 status, http_code, delivered_to, error, sent_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)
       ON CONFLICT (pippin_id) DO UPDATE SET
         status = EXCLUDED.status, http_code = EXCLUDED.http_code,
         delivered_to = EXCLUDED.delivered_to, error = EXCLUDED.error,
         payload = EXCLUDED.payload, title = EXCLUDED.title,
         sent_by = EXCLUDED.sent_by, sent_at = now(), updated_at = now()
       RETURNING *`,
      [pippinId, r.item.type, kind, Number.isInteger(sid) ? sid : null, r.item.title,
       JSON.stringify(r.item), status, sent.http || null, sent.delivered_to || null,
       sent.error || null, req.user.id]);

    recordAudit({ req, action: 'export', entity_type: 'pippin_send', entity_id: pippinId,
      meta: { item_type: r.item.type, source_kind: kind, source_id: Number.isInteger(sid) ? sid : null,
              status, http: sent.http || null, delivered_to: sent.delivered_to || null,
              payload: r.item } }).catch(() => {});

    if (status !== 'delivered') {
      return res.status(502).json({ ok: false, refused_by: 'bridge', send: rows[0],
        status, http: sent.http, code: sent.code, retryable: !!sent.retryable, message: sent.error });
    }
    res.status(201).json({ ok: true, send: rows[0], duplicate: !!sent.duplicate, lands: r.lands });
  } catch (e) { console.error('[pippin] send:', e.message); res.status(500).json({ error: e.message }); }
});

// ── GET /sends — what has been sent, and where it got to ─────────────────────
router.get('/sends', async (req, res) => {
  if (!(await gate(req, res))) return;
  try {
    const db = getPool();
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const { rows } = await db.query(
      `SELECT p.*, COALESCE(s.preferred_name, s.first_name) AS sent_by_name
         FROM pippin_sends p LEFT JOIN staff s ON s.id = p.sent_by
        ORDER BY p.sent_at DESC LIMIT $1`, [limit]);
    res.json(rows);
  } catch (e) {
    if (e.code === '42P01') return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /sends/:id/refresh — ask the bridge what happened to it at home ─────
router.post('/sends/:id/refresh', async (req, res) => {
  if (!(await gate(req, res))) return;
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM pippin_sends WHERE id=$1', [parseInt(req.params.id, 10)]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const st = await PB.status(rows[0].pippin_id);
    const home = st.found ? (st.home_status || null) : (st.code === 'gone' ? 'removed' : null);
    const { rows: up } = await db.query(
      `UPDATE pippin_sends SET home_status=$2, updated_at=now() WHERE id=$1 RETURNING *`,
      [rows[0].id, home]);
    res.json({ ok: true, send: up[0], found: !!st.found, code: st.code || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sends/:id/withdraw — take it back off the home calendar ────────────
router.post('/sends/:id/withdraw', async (req, res) => {
  if (!(await gate(req, res))) return;
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM pippin_sends WHERE id=$1', [parseInt(req.params.id, 10)]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const w = await PB.withdraw(rows[0].pippin_id);
    if (!w.ok) return res.status(502).json({ ok: false, code: w.code, message: w.error || 'The bridge refused the withdrawal.' });
    const { rows: up } = await db.query(
      `UPDATE pippin_sends SET status='withdrawn', home_status='removed', updated_at=now()
        WHERE id=$1 RETURNING *`, [rows[0].id]);
    recordAudit({ req, action: 'delete', entity_type: 'pippin_send', entity_id: rows[0].pippin_id,
      meta: { withdrawn: true } }).catch(() => {});
    res.json({ ok: true, send: up[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
