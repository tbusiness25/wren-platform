'use strict';
/**
 * staff-reading.js — b361 (2026-09-29). Mounted at /api/staff-reading.
 *
 * The Staff Reading Corner: the staff-side counterpart of the parents' Study
 * section (src/routes/study.js), and deliberately NOT the b352 reading room.
 *
 *   ── anyone signed in as staff ──────────────────────────────────────────────
 *   GET    /                    the corner: items, this week's digest, counts,
 *                               the sources note, and MY reads
 *   GET    /:id                 one item, including the full text of a document
 *   POST   /:id/read            mark read / unread  { read: true|false }
 *   POST   /:id/save            keep for later      { saved: true|false }
 *   GET    /digests             every week, newest first
 *   POST   /suggest             paste a link you found (a manager publishes it)
 *   GET    /suggest/mine        what I have suggested and what happened to it
 *
 *   ── manager-tier role ──────────────────────────────────────────────────────
 *   GET    /suggestions         the queue
 *   POST   /suggestions/:id/publish
 *   POST   /suggestions/:id/decline
 *   POST   /digests/:id/publish
 *   PATCH  /items/:id           pin / hide an item
 *
 * ── WHO CAN SEE IT ──────────────────────────────────────────────────────────
 * Every member of staff, on the EY portal and on Roost. Not parents: this
 * carries professional reading and a critique of the setting's own practice,
 * and the parents' Study section is the thing that faces families.
 *
 * Note what that means against b352: the reading room is manager+Roost only
 * because it lists analyses of staffing cost and fees. The curriculum critique
 * is in BOTH, because it is the one document in wren-docs that is aggregate-only
 * by construction and is written for practitioners to read. Its row here carries
 * doc_path, so the two surfaces are provably the same document.
 *
 * ── READING IS NOT A COMPLIANCE METRIC ──────────────────────────────────────
 * There is no endpoint in this file that tells anybody who has NOT read
 * something, and no aggregate over staff_reading_reads at all. A manager can see
 * how many people have read an item in total; they cannot see which people. That
 * is the same line b345 drew for staff voice, for the same reason: a reading
 * list that becomes a stick is a reading list nobody opens.
 *
 * ── NOTHING HERE FETCHES ANYTHING ───────────────────────────────────────────
 * The weekly job is a host script (scripts/b361-weekly-digest.js). This router
 * only reads and writes the database, so a request to an endpoint here can never
 * cause Wren to make an outbound request, and there is no route a browser can
 * hit that makes the server fetch a URL a person supplied.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { normaliseUrl, urlHash } = require('../lib/eyfs-news');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

// A parent token has no business here.
router.use((req, res, next) =>
  req.user && req.user.role === 'parent' ? res.status(403).json({ error: 'Staff only' }) : next());

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'owner', 'headteacher'];
const isManager = req => Number(req.user.id) === 1 || hasRole(req.user, MANAGER_ROLES);
const managerOnly = (req, res, next) =>
  isManager(req) ? next() : res.status(403).json({ error: 'Management access required' });

// Express 5 has no inline regex in a path (see the memory note): a non-numeric
// id is simply not an item.
const numericParam = name => (req, res, next, val) =>
  /^\d{1,9}$/.test(val) ? next() : res.status(404).json({ error: 'Not found' });
router.param('id', numericParam('id'));

const KINDS = ['news', 'critique', 'guidance', 'cpd'];
const clean = (v, max) => { const s = String(v == null ? '' : v).trim(); return s.length > max ? s.slice(0, max) : s; };
const ymd = d => (d instanceof Date && !isNaN(d)) ? d.toISOString().slice(0, 10) : (d ? String(d).slice(0, 10) : null);

// A 42P01 from any read here means the b361 migration has not been applied to
// this database. Answer with an empty corner and say so, rather than a 500 that
// looks like the page is broken.
const notMigrated = e => e && e.code === '42P01';

function shapeItem(r, mine) {
  return {
    id: r.id, kind: r.kind, title: r.title, url: r.url,
    source: r.source_name, publisher: r.publisher,
    published_on: ymd(r.published_on),
    summary: r.summary, what_it_means: r.what_it_means,
    topics: r.topics || [], doc_path: r.doc_path,
    has_body: !!r.has_body, words: r.words == null ? null : Number(r.words),
    digest_id: r.digest_id, week_start: ymd(r.week_start),
    model: r.model, pinned: !!r.pinned, status: r.status,
    suggested_by_name: r.suggested_by_name || null,
    read: mine ? mine.read.has(r.id) : false,
    saved: mine ? mine.saved.has(r.id) : false,
    read_count: r.read_count == null ? null : Number(r.read_count),
    created_at: r.created_at,
  };
}

async function myReads(db, staffId) {
  const { rows } = await db.query(
    `SELECT item_id, saved FROM staff_reading_reads WHERE staff_id = $1`, [staffId]);
  return { read: new Set(rows.map(r => r.item_id)), saved: new Set(rows.filter(r => r.saved).map(r => r.item_id)) };
}

const LIST_COLS = `
  i.id, i.kind, i.title, i.url, i.source_name, i.publisher, i.published_on,
  i.summary, i.what_it_means, i.topics, i.doc_path, i.digest_id, i.model,
  i.pinned, i.status, i.created_at,
  (i.body_md IS NOT NULL) AS has_body,
  CASE WHEN i.body_md IS NULL THEN NULL
       ELSE array_length(regexp_split_to_array(i.body_md, '\\s+'), 1) END AS words,
  d.week_start,
  (SELECT count(*) FROM staff_reading_reads rr WHERE rr.item_id = i.id)::int AS read_count,
  trim(coalesce(sg.first_name,'') || ' ' || coalesce(sg.last_name,'')) AS suggested_by_name`;
const LIST_JOINS = `
  LEFT JOIN staff_reading_digests d ON d.id = i.digest_id
  LEFT JOIN staff sg ON sg.id = i.suggested_by`;

// ── GET / — the corner ──────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const db = getPool();
  const mgr = isManager(req);
  try {
    const q = clean(req.query.q, 200);
    const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
    const topic = clean(req.query.topic, 60);
    const onlySaved = req.query.saved === '1';

    const where = [mgr && req.query.include_hidden === '1' ? `TRUE` : `i.status = 'published'`];
    const params = [];
    if (kind)  { params.push(kind);  where.push(`i.kind = $${params.length}`); }
    if (topic) { params.push(topic); where.push(`$${params.length} = ANY(i.topics)`); }
    if (q) {
      params.push('%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%');
      where.push(`(i.title ILIKE $${params.length} OR i.summary ILIKE $${params.length}
                   OR i.what_it_means ILIKE $${params.length} OR i.source_name ILIKE $${params.length})`);
    }

    const { rows } = await db.query(`
      SELECT ${LIST_COLS} FROM staff_reading_items i ${LIST_JOINS}
       WHERE ${where.join(' AND ')}
       ORDER BY i.pinned DESC,
                i.published_on DESC NULLS LAST,
                i.created_at DESC, i.id DESC
       LIMIT 300`, params);

    const mine = await myReads(db, req.user.id);
    let items = rows.map(r => shapeItem(r, mine));
    if (onlySaved) items = items.filter(i => i.saved);

    // This week's digest, and the one before it, so a Monday morning page is
    // never empty just because the job has not run yet.
    const { rows: digests } = await db.query(`
      SELECT id, week_start, status, published_at, item_count, model, sources_ok, sources_failed, run_note
        FROM staff_reading_digests
       WHERE status = 'published' OR $1::boolean
       ORDER BY week_start DESC LIMIT 8`, [mgr]);

    const { rows: sources } = await db.query(`
      SELECT key, name, publisher, site_url, kind, enabled, note, last_ok_at, last_error
        FROM staff_reading_sources ORDER BY (kind = 'rss' AND enabled) DESC, name`);

    const { rows: counts } = await db.query(`
      SELECT i.kind, count(*)::int AS n FROM staff_reading_items i
       WHERE i.status = 'published' GROUP BY i.kind`);

    const { rows: topics } = await db.query(`
      SELECT t AS topic, count(*)::int AS n
        FROM staff_reading_items i, unnest(i.topics) AS t
       WHERE i.status = 'published'
       GROUP BY t ORDER BY n DESC, t LIMIT 18`);

    let pendingSuggestions = null;
    if (mgr) {
      const { rows: p } = await db.query(`SELECT count(*)::int AS n FROM staff_reading_suggestions WHERE status = 'new'`);
      pendingSuggestions = p[0].n;
    }

    res.json({
      ok: true,
      is_manager: mgr,
      items,
      digests: digests.map(d => ({
        id: d.id, week_start: ymd(d.week_start), status: d.status, published_at: d.published_at,
        item_count: d.item_count, model: d.model,
        sources_ok: d.sources_ok || [], sources_failed: d.sources_failed || [], run_note: d.run_note,
      })),
      sources: sources.map(s => ({
        key: s.key, name: s.name, publisher: s.publisher, site_url: s.site_url,
        kind: s.kind, enabled: s.enabled, note: s.note,
        last_ok_at: s.last_ok_at, last_error: s.last_error,
      })),
      counts: Object.fromEntries(counts.map(c => [c.kind, c.n])),
      topics: topics.map(t => ({ topic: t.topic, n: t.n })),
      read_count: mine.read.size,
      saved_count: mine.saved.size,
      pending_suggestions: pendingSuggestions,
    });
  } catch (e) {
    if (notMigrated(e)) return res.json({ ok: true, items: [], digests: [], sources: [], counts: {}, topics: [], is_manager: mgr, note: 'The b361 migration has not been applied to this database.' });
    console.error('[b361] corner:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── GET /digests ────────────────────────────────────────────────────────────
router.get('/digests', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT id, week_start, status, published_at, item_count, model, run_note, sources_failed
        FROM staff_reading_digests
       WHERE status = 'published' OR $1::boolean
       ORDER BY week_start DESC LIMIT 60`, [isManager(req)]);
    res.json({ ok: true, digests: rows.map(d => ({ ...d, week_start: ymd(d.week_start) })) });
  } catch (e) {
    if (notMigrated(e)) return res.json({ ok: true, digests: [] });
    console.error('[b361] digests:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── POST /suggest ───────────────────────────────────────────────────────────
// The answer to the Facebook part of the brief: Wren cannot read a group, a
// person can. The URL is normalised through the same function the fetcher uses,
// so a link already in the corner is recognised as such rather than queued for a
// manager to discover is a duplicate.
router.post('/suggest', async (req, res) => {
  const db = getPool();
  const raw = clean((req.body || {}).url, 2000);
  const note = clean((req.body || {}).note, 1000);
  const where = clean((req.body || {}).where_from, 160);
  if (!raw) return res.status(400).json({ error: 'Paste a link' });
  const url = normaliseUrl(raw);
  if (!url) return res.status(400).json({ error: 'That does not look like a web address — it should start with http:// or https://' });
  const hash = urlHash(url);
  try {
    const dup = await db.query(`SELECT id, title FROM staff_reading_items WHERE url_hash = $1 AND status = 'published'`, [hash]);
    if (dup.rows.length) return res.status(409).json({ error: 'already_here', message: 'That one is already in the corner.', item_id: dup.rows[0].id, title: dup.rows[0].title });
    const open = await db.query(`SELECT id FROM staff_reading_suggestions WHERE url_hash = $1 AND status = 'new'`, [hash]);
    if (open.rows.length) return res.status(409).json({ error: 'already_suggested', message: 'Somebody has already suggested that one — it is waiting for a manager.' });

    const { rows } = await db.query(`
      INSERT INTO staff_reading_suggestions (staff_id, url, url_hash, note, where_from)
      VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [req.user.id, url, hash, note || null, where || null]);
    res.json({ ok: true, id: rows[0].id, created_at: rows[0].created_at });
  } catch (e) {
    if (notMigrated(e)) return res.status(503).json({ error: 'The b361 migration has not been applied to this database.' });
    console.error('[b361] suggest:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/suggest/mine', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT s.id, s.url, s.note, s.where_from, s.status, s.created_at, s.reviewed_at, s.review_note, s.item_id
        FROM staff_reading_suggestions s
       WHERE s.staff_id = $1 ORDER BY s.created_at DESC LIMIT 60`, [req.user.id]);
    res.json({ ok: true, suggestions: rows });
  } catch (e) {
    if (notMigrated(e)) return res.json({ ok: true, suggestions: [] });
    console.error('[b361] my suggestions:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── manager: the suggestion queue ───────────────────────────────────────────
router.get('/suggestions', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT s.id, s.url, s.note, s.where_from, s.status, s.created_at, s.reviewed_at, s.review_note, s.item_id,
             trim(coalesce(st.first_name,'') || ' ' || coalesce(st.last_name,'')) AS by_name
        FROM staff_reading_suggestions s LEFT JOIN staff st ON st.id = s.staff_id
       ORDER BY (s.status = 'new') DESC, s.created_at DESC LIMIT 200`);
    res.json({ ok: true, suggestions: rows });
  } catch (e) {
    if (notMigrated(e)) return res.json({ ok: true, suggestions: [] });
    console.error('[b361] suggestions:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/suggestions/:id/publish', managerOnly, async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const title = clean(b.title, 300);
  const summary = clean(b.summary, 1200);
  const means = clean(b.what_it_means, 600);
  const kind = KINDS.includes(b.kind) ? b.kind : 'news';
  if (!title) return res.status(400).json({ error: 'Give it a title — that is what people see in the list.' });

  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query(`SELECT * FROM staff_reading_suggestions WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows.length) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    const s = rows[0];
    if (s.status !== 'new') { await c.query('ROLLBACK'); return res.status(409).json({ error: 'Already dealt with' }); }

    // A manager writes the summary. There is no model call on this path on
    // purpose: the weekly job summarises a feed's own text, which is published
    // material; a link a person pasted could be anything, and Wren is not going
    // to fetch and read an arbitrary URL somebody typed.
    const ins = await c.query(`
      INSERT INTO staff_reading_items
        (kind, title, url, url_hash, source_name, publisher, summary, what_it_means,
         topics, suggested_by, published_by, status)
      VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8::text[],$9,$10,'published')
      ON CONFLICT (url_hash) WHERE url_hash IS NOT NULL DO NOTHING
      RETURNING id`,
      [kind, title, s.url, s.url_hash, clean(b.source_name, 160) || 'Suggested by a colleague',
       summary || null, means || null, Array.isArray(b.topics) ? b.topics.slice(0, 8).map(t => clean(t, 40)) : [],
       s.staff_id, req.user.id]);

    let itemId = ins.rows.length ? ins.rows[0].id : null;
    if (!itemId) {
      const ex = await c.query(`SELECT id FROM staff_reading_items WHERE url_hash = $1`, [s.url_hash]);
      itemId = ex.rows.length ? ex.rows[0].id : null;
    }
    await c.query(`
      UPDATE staff_reading_suggestions
         SET status = 'published', reviewed_by = $2, reviewed_at = now(), item_id = $3
       WHERE id = $1`, [id, req.user.id, itemId]);
    await c.query('COMMIT');
    res.json({ ok: true, item_id: itemId });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('[b361] publish suggestion:', e.message);
    res.status(500).json({ error: 'Database error' });
  } finally { c.release(); }
});

router.post('/suggestions/:id/decline', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      UPDATE staff_reading_suggestions
         SET status = 'declined', reviewed_by = $2, reviewed_at = now(), review_note = $3
       WHERE id = $1 AND status = 'new' RETURNING id`,
      [parseInt(req.params.id, 10), req.user.id, clean((req.body || {}).note, 500) || null]);
    if (!rows.length) return res.status(404).json({ error: 'Not found, or already dealt with' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[b361] decline suggestion:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── manager: publish a digest the job built as a draft ──────────────────────
router.post('/digests/:id/publish', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      UPDATE staff_reading_digests
         SET status = 'published', published_at = COALESCE(published_at, now()), updated_at = now()
       WHERE id = $1 AND item_count > 0 RETURNING id, week_start, item_count`, [parseInt(req.params.id, 10)]);
    if (!rows.length) return res.status(404).json({ error: 'Not found, or it has no items yet' });
    res.json({ ok: true, digest: { ...rows[0], week_start: ymd(rows[0].week_start) } });
  } catch (e) {
    console.error('[b361] publish digest:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── manager: pin / hide ─────────────────────────────────────────────────────
router.patch('/items/:id', managerOnly, async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  const sets = [], params = [parseInt(req.params.id, 10)];
  if (typeof b.pinned === 'boolean') { params.push(b.pinned); sets.push(`pinned = $${params.length}`); }
  if (b.status === 'published' || b.status === 'hidden') { params.push(b.status); sets.push(`status = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
  try {
    const { rows } = await db.query(
      `UPDATE staff_reading_items SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING id, pinned, status`, params);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, item: rows[0] });
  } catch (e) {
    console.error('[b361] patch item:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── GET /:id — one item, with the document text if it is one ────────────────
// Registered LAST so /digests, /suggest and /suggestions are never swallowed by
// it. The param check rejects a non-numeric id anyway, but ordering is the thing
// that makes that belt-and-braces rather than load-bearing.
router.get('/:id', async (req, res) => {
  const db = getPool();
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await db.query(`
      SELECT ${LIST_COLS}, i.body_md FROM staff_reading_items i ${LIST_JOINS}
       WHERE i.id = $1 AND (i.status = 'published' OR $2::boolean)`, [id, isManager(req)]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const mine = await myReads(db, req.user.id);
    res.json({ ok: true, item: Object.assign(shapeItem(rows[0], mine), { body_md: rows[0].body_md || null }) });
  } catch (e) {
    if (notMigrated(e)) return res.status(404).json({ error: 'Not found' });
    console.error('[b361] item:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── POST /:id/read and /:id/save — mine, always ─────────────────────────────
// The owner is the token, never a parameter. There is no way to mark somebody
// else as having read something.
async function mark(req, res, field) {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  const on = (req.body || {})[field] !== false;
  try {
    const ex = await db.query(`SELECT 1 FROM staff_reading_items WHERE id = $1`, [id]);
    if (!ex.rows.length) return res.status(404).json({ error: 'Not found' });

    if (field === 'read' && !on) {
      // Un-reading also drops "saved" — the row is the whole relationship.
      await db.query(`DELETE FROM staff_reading_reads WHERE item_id = $1 AND staff_id = $2`, [id, req.user.id]);
      return res.json({ ok: true, read: false, saved: false });
    }
    if (field === 'save' && !on) {
      // Un-saving something never read must not create a "read" row as a side
      // effect — that would quietly mark it read for the person un-saving it.
      const { rows } = await db.query(
        `UPDATE staff_reading_reads SET saved = false WHERE item_id = $1 AND staff_id = $2 RETURNING read_at`,
        [id, req.user.id]);
      return res.json({ ok: true, read: rows.length > 0, saved: false, read_at: rows.length ? rows[0].read_at : null });
    }
    const { rows } = await db.query(`
      INSERT INTO staff_reading_reads (item_id, staff_id, saved)
      VALUES ($1,$2,$3)
      ON CONFLICT (item_id, staff_id) DO UPDATE
        SET saved = CASE WHEN $4 THEN EXCLUDED.saved ELSE staff_reading_reads.saved END
      RETURNING read_at, saved`,
      [id, req.user.id, field === 'save' ? on : false, field === 'save']);
    res.json({ ok: true, read: true, saved: !!rows[0].saved, read_at: rows[0].read_at });
  } catch (e) {
    console.error(`[b361] ${field}:`, e.message);
    res.status(500).json({ error: 'Database error' });
  }
}
router.post('/:id/read', (req, res) => mark(req, res, 'read'));
router.post('/:id/save', (req, res) => mark(req, res, 'save'));

module.exports = router;
module.exports._internals = { shapeItem, isManager, KINDS };
