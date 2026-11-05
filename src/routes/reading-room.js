'use strict';
/**
 * reading-room.js — b352 (2026-09-22)
 *
 * The reading room: every analysis, audit, research report and decision note from the two wren-docs
 * trees, with a four-step progress track per document.
 *
 *   GET    /api/reading-room              the list (metadata only) + counts; scans the trees first if stale
 *   GET    /api/reading-room/summary      counts only — what the What-needs-me card and the nav badge call
 *   GET    /api/reading-room/:id          one document: its text, its ticks, its history
 *   POST   /api/reading-room/:id/step     tick / un-tick / edit one of read | discussed | decided | done
 *   PATCH  /api/reading-room/:id          flip "for information" <-> "needs a decision"
 *   POST   /api/reading-room/:id/pin      b506 — pin this one to the top of the list / unpin it
 *   POST   /api/reading-room/bulk-read    mark a stated list of ids as read (recorded as a bulk action)
 *   POST   /api/reading-room/rescan       scan now
 *
 * ── THE PIN (b506, 2026-10-18) ─────────────────────────────────────────────────────────────────
 * `pinned_at` is a nullable timestamp, not a boolean: it answers "pinned?" and "pinned when?" at once, and
 * most-recently-pinned sorts first for free. A pinned document stays at the top AFTER it has been read —
 * that is the point of a pin — so it is also kept in the default "everything still open" list once its
 * ticks would otherwise have filed it away. At most PIN_CAP of them: a reading room where everything is
 * pinned is a reading room with no pins. The scanner never touches the two columns (its upsert enumerates
 * what it writes), so a re-scan cannot silently unpin anything.
 *
 * ── THE FOUR TICKS ─────────────────────────────────────────────────────────────────────────────
 *   Read       any manager. Explicit — opening a document is not reading it.
 *   Discussed  any manager, with an optional note and the date it was talked through.
 *   Decided    needs the decision itself in words. Written to decision_log too, so Roost's decision
 *              register and this screen cannot disagree.
 *   Done       needs what happened, in words.
 * An item is either FOR INFORMATION (Read is the end of it) or NEEDS A DECISION (all four). The scanner
 * guesses on import; a person flips it and the scanner never overrides that.
 * Steps go in order (Read first; Done only after Decided) and come off in reverse order, so the track can
 * never say "done" about something nobody read.
 *
 * ── ACCESS ─────────────────────────────────────────────────────────────────────────────────────
 * Manager role AND the admin (Roost) portal, both checked here, the same shape as attention.js. These are
 * analyses of staffing cost, fees and money: not for a practitioner on the tablet, not for a deputy.
 *
 * ── WHAT THE CLIENT CAN NEVER DO ───────────────────────────────────────────────────────────────
 * Name a file. Every read is by row id and comes out of the snapshot the scanner took, so there is no path
 * parameter to traverse. The family-data guard runs again before any text is served.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const rr = require('../lib/reading-room-scan');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

function managerAdminOnly(req, res, next) {
  if ((req._portal || null) !== 'admin') {
    return res.status(403).json({ error: 'forbidden_portal', message: 'The reading room is available on the Roost (admin) portal only.' });
  }
  if (!req.user || !hasRole(req.user, ['manager', 'admin'])) {
    return res.status(403).json({ error: 'forbidden_role', message: 'Manager access only.' });
  }
  next();
}
const guard = [authenticate, managerAdminOnly];

// Express 5 has no inline regex in a path, so the id is checked here: a non-numeric id is simply not a document.
router.param('id', (req, res, next, val) => (/^\d{1,9}$/.test(val) ? next() : res.status(404).json({ error: 'not_found' })));

const STEPS = ['read', 'discussed', 'decided', 'done'];
const KINDS = ['analysis', 'audit', 'research', 'decision', 'qa', 'reference', 'other'];
const PIN_CAP = 10;                 // b506 — the whole list pinned is the same as nothing pinned

// read → nothing else yet = unread; a decision still open = in_progress; the rest = done.
const STATUS_SQL = `(CASE WHEN i.read_at IS NULL THEN 'unread'
                          WHEN i.needs_decision AND i.done_at IS NULL THEN 'in_progress'
                          ELSE 'done' END)`;

const LIST_COLS = `
  i.id, i.tree, i.rel_path, i.title, i.kind, i.format, i.summary, i.bytes, i.doc_date,
  i.needs_decision, i.needs_decision_auto, i.needs_decision_locked, i.missing_since, i.content_changed_at,
  i.read_at, i.discussed_at, i.discussed_on, i.discussed_note, i.decided_at, i.decision_text, i.done_at, i.done_note,
  i.pinned_at, i.pinned_by,
  ${STATUS_SQL} AS status,
  (i.content_changed_at IS NOT NULL AND i.read_at IS NOT NULL AND i.content_changed_at > i.read_at) AS changed_since_read,
  trim(coalesce(rs.first_name,'') || ' ' || coalesce(rs.last_name,'')) AS read_by_name,
  trim(coalesce(ds.first_name,'') || ' ' || coalesce(ds.last_name,'')) AS discussed_by_name,
  trim(coalesce(cs.first_name,'') || ' ' || coalesce(cs.last_name,'')) AS decided_by_name,
  trim(coalesce(ns.first_name,'') || ' ' || coalesce(ns.last_name,'')) AS done_by_name,
  trim(coalesce(ps.first_name,'') || ' ' || coalesce(ps.last_name,'')) AS pinned_by_name`;
const LIST_JOINS = `
  LEFT JOIN staff rs ON rs.id = i.read_by
  LEFT JOIN staff ds ON ds.id = i.discussed_by
  LEFT JOIN staff cs ON cs.id = i.decided_by
  LEFT JOIN staff ns ON ns.id = i.done_by
  LEFT JOIN staff ps ON ps.id = i.pinned_by`;

const ymd = d => (d instanceof Date && !isNaN(d)) ? d.toISOString().slice(0, 10) : (d ? String(d).slice(0, 10) : null);

function shape(r) {
  return {
    id: r.id, tree: r.tree, path: r.rel_path, title: r.title, kind: r.kind, format: r.format, summary: r.summary,
    bytes: Number(r.bytes || 0), date: ymd(r.doc_date),
    needs_decision: !!r.needs_decision, needs_decision_auto: !!r.needs_decision_auto, needs_decision_locked: !!r.needs_decision_locked,
    status: r.status, changed_since_read: !!r.changed_since_read, file_missing: !!r.missing_since,
    pinned: !!r.pinned_at, pinned_at: r.pinned_at || null, pinned_by: r.pinned_by_name || null,
    steps: {
      read:      r.read_at      ? { at: r.read_at, by: r.read_by_name || null } : null,
      discussed: r.discussed_at ? { at: r.discussed_at, on: ymd(r.discussed_on), note: r.discussed_note || null, by: r.discussed_by_name || null } : null,
      decided:   r.decided_at   ? { at: r.decided_at, text: r.decision_text || '', by: r.decided_by_name || null } : null,
      done:      r.done_at      ? { at: r.done_at, note: r.done_note || '', by: r.done_by_name || null } : null,
    },
  };
}

// ── the on-load scan ──────────────────────────────────────────────────────────────────────────
let lastScan = null;           // { at, result }
let inFlight = null;
const SCAN_EVERY_MS = 60 * 1000;

async function scanNow(force = false) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const db = getPool();
      const result = await rr.scan((sql, p) => db.query(sql, p), { force, source: 'route' });
      lastScan = { at: new Date().toISOString(), result };
      return lastScan;
    } catch (e) {
      lastScan = { at: new Date().toISOString(), result: { ok: false, note: 'scan failed: ' + e.message } };
      return lastScan;
    } finally { inFlight = null; }
  })();
  return inFlight;
}
async function scanIfStale() {
  if (lastScan && Date.now() - new Date(lastScan.at).getTime() < SCAN_EVERY_MS) return lastScan;
  return scanNow(false);
}

// ── a short-lived family-data guard for serving text ───────────────────────────────────────────
let guardCache = null;
async function getGuard() {
  if (guardCache && Date.now() - guardCache.at < 5 * 60 * 1000) return guardCache.g;
  const db = getPool();
  const g = await rr.buildGuard((sql) => db.query(sql));
  guardCache = { at: Date.now(), g };
  return g;
}

const likeEsc = s => String(s).replace(/[\\%_]/g, m => '\\' + m);

// ── GET /summary ──────────────────────────────────────────────────────────────────────────────
async function summaryCounts(db) {
  const { rows } = await db.query(`
    SELECT count(*) FILTER (WHERE ${STATUS_SQL} = 'unread')::int                                       AS unread,
           count(*) FILTER (WHERE ${STATUS_SQL} = 'in_progress')::int                                  AS in_progress,
           count(*) FILTER (WHERE ${STATUS_SQL} = 'done')::int                                         AS done,
           count(*) FILTER (WHERE i.needs_decision AND i.read_at IS NOT NULL AND i.decided_at IS NULL)::int   AS awaiting_decision,
           count(*) FILTER (WHERE i.needs_decision AND i.decided_at IS NOT NULL AND i.done_at IS NULL)::int   AS awaiting_done,
           count(*) FILTER (WHERE i.pinned_at IS NOT NULL)::int                                        AS pinned,
           count(*)::int AS total,
           min(i.doc_date) FILTER (WHERE ${STATUS_SQL} = 'unread') AS oldest_unread
      FROM reading_room_items i
     WHERE NOT i.withheld AND i.missing_since IS NULL`);
  const r = rows[0];
  return { unread: r.unread, in_progress: r.in_progress, done: r.done, awaiting_decision: r.awaiting_decision,
           awaiting_done: r.awaiting_done, pinned: r.pinned, total: r.total, oldest_unread: ymd(r.oldest_unread) };
}

router.get('/summary', guard, async (req, res) => {
  try { res.json(Object.assign({ ok: true }, await summaryCounts(getPool()))); }
  catch (e) {
    // 42P01 the table is not there (b352 not applied); 42703 a column is not there (b506 not applied yet —
    // the SQL goes before the restart, but a half-deployed prod must stay quiet rather than 500).
    if (e.code === '42P01' || e.code === '42703') return res.json({ ok: true, unread: 0, in_progress: 0, done: 0, pinned: 0, total: 0, note: 'reading-room migration not applied' });
    console.error('[reading-room] summary:', e.message); res.status(500).json({ error: e.message });
  }
});

// ── GET / — the list ──────────────────────────────────────────────────────────────────────────
router.get('/', guard, async (req, res) => {
  try {
    const db = getPool();
    const reachable = rr.resolveRoots().some(r => r.reachable);
    const sc = reachable ? await scanIfStale() : null;     // nothing to walk from here: the host script keeps the table fresh

    const q = String(req.query.q || '').trim().slice(0, 200);
    const status = ['unread', 'in_progress', 'done', 'open', 'all'].includes(req.query.status) ? req.query.status : (q ? 'all' : 'open');
    const kinds = String(req.query.kind || '').split(',').map(s => s.trim()).filter(k => KINDS.includes(k));
    const decision = ['yes', 'no'].includes(req.query.decision) ? req.query.decision : null;
    const pinnedOnly = ['1', 'true', 'yes'].includes(String(req.query.pinned || ''));

    // Each filter is [sql-with-one-?, value]. Built twice: with the kind filter for the list, without it for the chip counts.
    const filters = [];
    if (q) filters.push([`(i.title ILIKE ? OR i.summary ILIKE ? OR i.rel_path ILIKE ? OR i.content_text ILIKE ? OR i.decision_text ILIKE ?)`, '%' + likeEsc(q) + '%', 5]);
    // b506: a pin survives being read, so "everything still open" keeps the pinned ones in view. With nothing
    // pinned the clause is inert, so the default list is byte-for-byte what it was before this build.
    if (status === 'open') filters.push([`(${STATUS_SQL} IN ('unread','in_progress') OR i.pinned_at IS NOT NULL)`]);
    else if (status !== 'all') filters.push([`${STATUS_SQL} = ?`, status, 1]);
    if (decision) filters.push([`i.needs_decision = ?`, decision === 'yes', 1]);
    if (pinnedOnly) filters.push([`i.pinned_at IS NOT NULL`]);
    const build = withKind => {
      const where = ['NOT i.withheld'], params = [];
      const all = withKind && kinds.length ? filters.concat([[`i.kind = ANY(?::text[])`, kinds, 1]]) : filters;
      for (const [sql, value, uses] of all) {
        if (uses) { params.push(value); where.push(sql.replace(/\?/g, '$' + params.length)); } else where.push(sql);
      }
      return { where: where.join(' AND '), params };
    };
    const main = build(true), chips = build(false);

    const { rows } = await db.query(`
      SELECT ${LIST_COLS}
        FROM reading_room_items i ${LIST_JOINS}
       WHERE ${main.where}
       ORDER BY (i.pinned_at IS NULL),          -- false (pinned) sorts before true: pins first, read or not
                i.pinned_at DESC,
                CASE ${STATUS_SQL} WHEN 'unread' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
                i.doc_date DESC NULLS LAST, i.id DESC
       LIMIT 1500`, main.params);

    // Chip counts: the same filters, minus the kind filter itself.
    const { rows: kc } = await db.query(`
      SELECT i.kind, count(*)::int AS n FROM reading_room_items i
       WHERE ${chips.where} GROUP BY i.kind`, chips.params);
    const kindCounts = {}; kc.forEach(r => { kindCounts[r.kind] = r.n; });

    const counts = await summaryCounts(db);
    const { rows: wh } = await db.query(`SELECT count(*)::int AS n FROM reading_room_items WHERE withheld`);
    const { rows: gone } = await db.query(`SELECT count(*)::int AS n FROM reading_room_items WHERE missing_since IS NOT NULL AND NOT withheld`);

    let last = null;
    try { last = (await db.query(`SELECT at, source, result FROM reading_room_scans ORDER BY at DESC, id DESC LIMIT 1`)).rows[0] || null; }
    catch (e) { if (e.code !== '42P01') throw e; }
    res.json({
      ok: true,
      scanned_at: last ? last.at : null,
      scanned_by: last ? last.source : null,
      folders_reachable: reachable,
      scan_note: reachable ? null : 'This server cannot see the document folders, so the list is as of the last scan run on the host.',
      counts, kind_counts: kindCounts,
      pin_cap: PIN_CAP,
      withheld: wh[0].n, file_missing: gone[0].n,
      on_disk: last && last.result && last.result.trees ? Object.fromEntries(Object.entries(last.result.trees).map(([k, t]) => [k, { files: t.onDisk, listed: t.listed, withheld: t.withheld, excluded: t.excluded }])) : null,
      items: rows.map(shape),
      truncated: rows.length >= 1500,
    });
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return res.status(503).json({ error: 'not_migrated', message: 'The reading-room migration has not been applied to this database.' });
    console.error('[reading-room] list:', e.message); res.status(500).json({ error: e.message });
  }
});

// ── POST /rescan ──────────────────────────────────────────────────────────────────────────────
router.post('/rescan', guard, async (req, res) => {
  try {
    const sc = await scanNow(req.body && req.body.force === true);
    res.json({ ok: !!(sc.result && sc.result.ok), scanned_at: sc.at, note: sc.result && sc.result.note || null,
               trees: sc.result && sc.result.trees ? Object.fromEntries(Object.entries(sc.result.trees).map(([k, t]) => [k, { added: t.added, changed: t.changed, unchanged: t.unchanged, missing: t.missing, listed: t.listed, withheld: t.withheld }])) : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /bulk-read ───────────────────────────────────────────────────────────────────────────
// A person saying "I have read these N". Recorded as a bulk action so the history never pretends they
// were opened one by one. Only unread items move; nothing already ticked is touched.
router.post('/bulk-read', guard, async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(n => parseInt(n, 10)).filter(Number.isFinite) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids_required' });
  if (ids.length > 1000) return res.status(400).json({ error: 'too_many', message: 'At most 1000 at a time.' });
  const db = getPool();
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query(
      `UPDATE reading_room_items SET read_at = now(), read_by = $2
        WHERE id = ANY($1::int[]) AND NOT withheld AND read_at IS NULL RETURNING id`, [ids, req.user.id || null]);
    for (const r of rows) {
      await c.query(`INSERT INTO reading_room_events (item_id, staff_id, step, action, detail) VALUES ($1,$2,'read','bulk',$3::jsonb)`,
        [r.id, req.user.id || null, JSON.stringify({ batch_size: rows.length })]);
    }
    await c.query('COMMIT');
    res.json({ ok: true, marked: rows.length, skipped: ids.length - rows.length });
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('[reading-room] bulk-read:', e.message); res.status(500).json({ error: e.message }); }
  finally { c.release(); }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────────────────────
router.get('/:id', guard, async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const { rows } = await db.query(`SELECT ${LIST_COLS}, i.content_text FROM reading_room_items i ${LIST_JOINS} WHERE i.id = $1 AND NOT i.withheld`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const row = rows[0];

    // The guard again, at the moment of serving: the children table moves, the snapshot does not.
    let content = row.content_text;
    if (content != null) {
      const g = await getGuard();
      if (g.check(content).hit) {
        await db.query(`UPDATE reading_room_items SET withheld = true, withheld_reason = 'family_name', content_text = NULL WHERE id = $1`, [id]);
        return res.status(404).json({ error: 'not_found' });
      }
    }
    const { rows: ev } = await db.query(`
      SELECT e.at, e.step, e.action, e.detail, trim(coalesce(s.first_name,'') || ' ' || coalesce(s.last_name,'')) AS by
        FROM reading_room_events e LEFT JOIN staff s ON s.id = e.staff_id
       WHERE e.item_id = $1 ORDER BY e.at DESC, e.id DESC LIMIT 60`, [id]);
    res.json({ ok: true, item: shape(row), content: content, too_large: content == null, history: ev });
  } catch (e) { console.error('[reading-room] get:', e.message); res.status(500).json({ error: e.message }); }
});

// ── PATCH /:id — the one-tap flip ─────────────────────────────────────────────────────────────
router.patch('/:id', guard, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (typeof (req.body || {}).needs_decision !== 'boolean') return res.status(400).json({ error: 'needs_decision_boolean_required' });
  const want = req.body.needs_decision;
  const db = getPool();
  try {
    const { rows } = await db.query(`SELECT needs_decision, discussed_at, decided_at, done_at FROM reading_room_items WHERE id = $1 AND NOT withheld`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const it = rows[0];
    if (!want && (it.discussed_at || it.decided_at || it.done_at)) {
      return res.status(409).json({ error: 'steps_ticked', message: 'Clear the discussed / decided / done ticks first — this would hide them.' });
    }
    if (it.needs_decision !== want) {
      await db.query(`UPDATE reading_room_items SET needs_decision = $2, needs_decision_locked = true WHERE id = $1`, [id, want]);
      await db.query(`INSERT INTO reading_room_events (item_id, staff_id, step, action, detail) VALUES ($1,$2,'needs_decision','flip',$3::jsonb)`,
        [id, req.user.id || null, JSON.stringify({ needs_decision: want })]);
    }
    res.json({ ok: true, item: await loadItem(db, id) });
  } catch (e) { console.error('[reading-room] flip:', e.message); res.status(500).json({ error: e.message }); }
});

async function loadItem(db, id) {
  const { rows } = await db.query(`SELECT ${LIST_COLS} FROM reading_room_items i ${LIST_JOINS} WHERE i.id = $1`, [id]);
  return rows.length ? shape(rows[0]) : null;
}

// ── POST /:id/pin — b506 ──────────────────────────────────────────────────────────────────────
// Pin this one to the top of the list, or take the pin off. Nothing else about the document changes:
// a pin is not a tick and it is not a flip. It is recorded in the same per-item history as every tick,
// so the item can say who put it there and when.
router.post('/:id/pin', guard, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (typeof (req.body || {}).pinned !== 'boolean') return res.status(400).json({ error: 'pinned_boolean_required', message: 'Send { "pinned": true } or { "pinned": false }.' });
  const want = req.body.pinned;
  const me = req.user.id || null;
  const db = getPool();
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query(`SELECT id, pinned_at FROM reading_room_items WHERE id = $1 AND NOT withheld FOR UPDATE`, [id]);
    if (!rows.length) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }
    const already = !!rows[0].pinned_at;

    if (want && !already) {
      // The cap is counted inside the transaction, so two taps at once cannot both squeeze past it.
      const { rows: n } = await c.query(`SELECT count(*)::int AS n FROM reading_room_items WHERE pinned_at IS NOT NULL AND NOT withheld`);
      if (n[0].n >= PIN_CAP) {
        await c.query('ROLLBACK');
        return res.status(409).json({ error: 'pin_cap',
          message: `${PIN_CAP} documents are already pinned, which is as many as the top of the list can usefully hold. Unpin one first.`,
          pin_cap: PIN_CAP, pinned: n[0].n });
      }
    }

    if (want !== already) {
      await c.query(
        want ? `UPDATE reading_room_items SET pinned_at = now(), pinned_by = $2 WHERE id = $1`
             : `UPDATE reading_room_items SET pinned_at = NULL, pinned_by = NULL WHERE id = $1`,
        want ? [id, me] : [id]);
      await c.query(`INSERT INTO reading_room_events (item_id, staff_id, step, action, detail) VALUES ($1,$2,'pinned',$3,$4::jsonb)`,
        [id, me, want ? 'pin' : 'unpin', JSON.stringify({ pinned: want })]);
    }
    await c.query('COMMIT');
    res.json({ ok: true, item: await loadItem(db, id) });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    if (e.code === '42703') return res.status(503).json({ error: 'not_migrated', message: 'The b506 migration has not been applied to this database.' });
    console.error('[reading-room] pin:', e.message);
    res.status(500).json({ error: e.message });
  } finally { c.release(); }
});

// ── POST /:id/step ────────────────────────────────────────────────────────────────────────────
router.post('/:id/step', guard, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const step = String(b.step || '');
  const on = b.on !== false;
  if (!STEPS.includes(step)) return res.status(400).json({ error: 'bad_step', message: 'step must be one of ' + STEPS.join(', ') });
  const me = req.user.id || null;

  const db = getPool();
  const c = await db.connect();
  const fail = async (code, error, message) => { await c.query('ROLLBACK').catch(() => {}); return res.status(code).json({ error, message }); };
  try {
    await c.query('BEGIN');
    const { rows } = await c.query(`SELECT * FROM reading_room_items WHERE id = $1 AND NOT withheld FOR UPDATE`, [id]);
    if (!rows.length) return await fail(404, 'not_found');
    const it = rows[0];

    if (step !== 'read' && !it.needs_decision) {
      return await fail(409, 'for_information', 'This one is for information — reading it is the end of it. Flip it to "needs a decision" first.');
    }

    const log = (action, detail) => c.query(
      `INSERT INTO reading_room_events (item_id, staff_id, step, action, detail) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [id, me, step, action, JSON.stringify(detail || {})]);

    if (on) {
      if (step === 'read') {
        if (!it.read_at) {
          await c.query(`UPDATE reading_room_items SET read_at = now(), read_by = $2 WHERE id = $1`, [id, me]);
          await log('tick');
        }
      } else if (step === 'discussed') {
        if (!it.read_at) return await fail(409, 'read_first', 'Tick Read before Discussed.');
        let when = b.when ? String(b.when).slice(0, 10) : null;
        if (when && !/^\d{4}-\d{2}-\d{2}$/.test(when)) return await fail(400, 'bad_date', 'when must be YYYY-MM-DD');
        const note = b.note ? String(b.note).trim().slice(0, 500) : null;
        const had = !!it.discussed_at;
        await c.query(`UPDATE reading_room_items SET discussed_at = COALESCE(discussed_at, now()), discussed_by = COALESCE(discussed_by, $2),
                         discussed_on = COALESCE($3::date, discussed_on, CURRENT_DATE), discussed_note = $4 WHERE id = $1`, [id, me, when, note]);
        await log(had ? 'edit' : 'tick', { on: when, note });
      } else if (step === 'decided') {
        if (!it.read_at) return await fail(409, 'read_first', 'Tick Read before Decided.');
        const text = String(b.decision || '').trim();
        if (!text) return await fail(400, 'decision_required', 'Write the decision itself — what was decided.');
        if (text.length > 4000) return await fail(400, 'decision_too_long', 'At most 4000 characters.');
        if (it.decided_at && it.decision_text === text) { await c.query('COMMIT'); return res.json({ ok: true, item: await loadItem(db, id) }); }
        // decision_log is append-only: an edit supersedes the old row, it does not rewrite it. The row is
        // deliberately written without a scenario fingerprint — a one-off human decision is not a "scenario"
        // for confidence-update.js to learn from, and nothing here should ever graduate toward automatic.
        if (it.decision_log_id) await c.query(`UPDATE decision_log SET undo_at = now(), undo_reason = $2 WHERE id = $1`, [it.decision_log_id, 'superseded in the reading room']);
        const dl = await c.query(`
          INSERT INTO decision_log (category, scenario_fingerprint, input_context, options_presented, decision_made,
                                    decided_by_staff_id, source_table, source_id, decided_at)
          VALUES ('system_other', NULL, $1::jsonb, '[]'::jsonb, $2::jsonb, $3, 'reading_room_items', $4, now())
          RETURNING id`,
          [JSON.stringify({ item_type: 'Reading room', item_kind: String(it.title).slice(0, 160), doc_kind: it.kind, doc_path: it.rel_path }),
           JSON.stringify({ action: 'decided', decision: text, source: 'reading_room' }), me, id]);
        await c.query(`UPDATE reading_room_items SET decided_at = now(), decided_by = $2, decision_text = $3, decision_log_id = $4 WHERE id = $1`,
          [id, me, text, dl.rows[0].id]);
        await log(it.decided_at ? 'edit' : 'tick', { decision: text, decision_log_id: dl.rows[0].id });
      } else if (step === 'done') {
        if (!it.decided_at) return await fail(409, 'decide_first', 'Record the decision before marking it done.');
        const note = String(b.note || b.done_note || '').trim();
        if (!note) return await fail(400, 'note_required', 'Say what happened — how the decision was carried out.');
        if (note.length > 2000) return await fail(400, 'note_too_long', 'At most 2000 characters.');
        const had = !!it.done_at;
        await c.query(`UPDATE reading_room_items SET done_at = COALESCE(done_at, now()), done_by = COALESCE(done_by, $2), done_note = $3 WHERE id = $1`, [id, me, note]);
        await log(had ? 'edit' : 'tick', { note });
      }
    } else {
      // un-tick: only from the end of the track backwards
      if (step === 'read' && (it.discussed_at || it.decided_at || it.done_at)) return await fail(409, 'later_steps_set', 'Clear the later ticks first.');
      if (step === 'decided' && it.done_at) return await fail(409, 'later_steps_set', 'Clear Done first.');
      if (step === 'read' && it.read_at) {
        await c.query(`UPDATE reading_room_items SET read_at = NULL, read_by = NULL WHERE id = $1`, [id]); await log('untick');
      } else if (step === 'discussed' && it.discussed_at) {
        await c.query(`UPDATE reading_room_items SET discussed_at = NULL, discussed_by = NULL, discussed_on = NULL, discussed_note = NULL WHERE id = $1`, [id]); await log('untick');
      } else if (step === 'decided' && it.decided_at) {
        if (it.decision_log_id) await c.query(`UPDATE decision_log SET undo_at = now(), undo_reason = $2 WHERE id = $1`, [it.decision_log_id, 'reopened in the reading room']);
        await c.query(`UPDATE reading_room_items SET decided_at = NULL, decided_by = NULL, decision_text = NULL, decision_log_id = NULL WHERE id = $1`, [id]);
        await log('untick', { was: it.decision_text });
      } else if (step === 'done' && it.done_at) {
        await c.query(`UPDATE reading_room_items SET done_at = NULL, done_by = NULL, done_note = NULL WHERE id = $1`, [id]);
        await log('untick', { was: it.done_note });
      }
    }
    await c.query('COMMIT');
    res.json({ ok: true, item: await loadItem(db, id) });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('[reading-room] step:', e.message);
    res.status(500).json({ error: e.message });
  } finally { c.release(); }
});

module.exports = router;
module.exports._internals = { shape, STATUS_SQL, PIN_CAP };
