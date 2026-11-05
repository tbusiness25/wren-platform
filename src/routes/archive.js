'use strict';
// ── b308 — the leavers' archive, read back ───────────────────────────────────
// Toby asked to be able to read and query the archive. A zip nobody can search
// is a zip nobody will trust, and an archive nobody trusts gets kept "just in
// case" — which is the over-retention this whole build exists to stop.
//
// So the thing that answers questions is the DATABASE (ladn.archive_items), not
// the tarball. Every endpoint here reads that index: what we hold for a child,
// in which retention class, and the date each item dies.
//
// READ-ONLY. Nothing in this file writes, archives or deletes. Building an
// archive is scripts/b308-archive-leaver.js; destroying an expired artefact is
// scripts/b308-archive-sweep.js, which defaults to a dry run and needs --apply.
// Both are deliberately off the web: a deletion you can trigger from a browser
// tab is a deletion that happens by accident.
//
// Manager-only, like the rest of Data Governance.
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const AC = require('../lib/archive-classes');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

const MGR_ROLES = ['manager', 'admin', 'headteacher'];
const managerOnly = (req, res, next) => {
  if (!hasRole(req.user, MGR_ROLES)) return res.status(403).json({ error: 'Manager access required' });
  next();
};

/** Has the migration been applied on this database? */
async function ready(db) {
  const { rows: [r] } = await db.query(`SELECT to_regclass('ladn.archive_items') t`);
  return !!r.t;
}
const notReady = { error: 'not_installed', message: 'ladn.archive_items does not exist on this database — apply migrations/2026-09-10-b308-leaver-archive.sql.' };

/**
 * The one-line reason an item sits on the clock it sits on. Three sources, in
 * order: a table with one class, a table SPLIT across two classes (a photo
 * permission and a trip permission slip are both child_consents and are 18 years
 * apart), and the paranoid default.
 */
function whyFor(table, cls, needsReview) {
  const split = AC.CLASS_SPLITS[table]?.find(s => s.class === cls);
  if (split) return split.why;
  if (AC.TABLE_CLASS[table]) return AC.TABLE_CLASS[table].why;
  if (table === 'person_documents') return 'uploaded document, classed by its category';
  return needsReview
    ? 'no rule names this table — defaulted to protected and flagged for a human'
    : null;
}

// ── GET /classes — the four clocks, so the UI never restates them itself ─────
router.get('/classes', managerOnly, (req, res) => {
  res.json(AC.CLASSES.map(c => ({ class: c, ...AC.CLASS_RULES[c] })));
});

// ── GET /summary — the board: what we hold, per class and per child ──────────
router.get('/summary', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    if (!await ready(db)) return res.status(503).json(notReady);

    const { rows: [insp] } = await db.query(
      `SELECT value FROM ladn.settings WHERE key='ofsted_last_inspection'`);
    const ofstedLastInspection = (insp?.value || '').trim().slice(0, 10) || null;

    // Per class: live artefacts, rows, bytes, how many are past their stored date,
    // how many of those the sweep would actually take, and how many are flagged.
    // The Ofsted clause is applied below rather than here, because the UI must not
    // imply that an ordinary record is going anywhere while that date is unset.
    const { rows: classes } = await db.query(
      `SELECT class,
              count(*)::int                                            AS items,
              COALESCE(sum(row_count),0)::int                          AS rows,
              COALESCE(sum(bytes),0)::bigint                           AS bytes,
              count(*) FILTER (WHERE expires_on <= CURRENT_DATE)::int  AS past_date,
              -- what the sweep would actually act on: past its date AND not
              -- flagged. Subtracting the flagged count from past_date would be
              -- wrong — a flagged item need not be past its date at all.
              count(*) FILTER (WHERE expires_on <= CURRENT_DATE AND NOT needs_review)::int AS sweepable,
              count(*) FILTER (WHERE expires_on IS NULL)::int          AS undated,
              count(*) FILTER (WHERE needs_review)::int                AS flagged,
              min(expires_on)                                          AS next_expiry
         FROM ladn.archive_items WHERE deleted_at IS NULL
        GROUP BY class`);

    const byClass = AC.CLASSES.map(c => {
      const r = classes.find(x => x.class === c) || {};
      const pastDate = r.past_date || 0;
      const frozen = c === 'ordinary' && !ofstedLastInspection;
      return {
        class: c,
        ...AC.CLASS_RULES[c],
        items: r.items || 0,
        rows: r.rows || 0,
        bytes: Number(r.bytes || 0),
        undated: r.undated || 0,
        flagged: r.flagged || 0,
        next_expiry: AC.ymd(r.next_expiry),
        // What the sweep would actually act on today. The ordinary class is
        // frozen wholesale while the inspection date is unset, however overdue
        // its items look.
        due: frozen ? 0 : (r.sweepable || 0),
        past_date: pastDate,
        frozen,
        frozen_reason: frozen
          ? 'held until the next Ofsted inspection — ladn.settings.ofsted_last_inspection is unset'
          : null,
      };
    });

    const { rows: children } = await db.query(
      `SELECT a.child_id,
              c.first_name, c.last_name, c.leave_date, c.date_of_birth, c.looked_after,
              count(*)::int                                    AS items,
              COALESCE(sum(a.row_count),0)::int                AS rows,
              COALESCE(sum(a.bytes),0)::bigint                 AS bytes,
              min(a.archived_at)                               AS archived_at,
              min(a.expires_on)                                AS next_expiry,
              max(a.expires_on)                                AS last_expiry,
              count(*) FILTER (WHERE a.needs_review)::int      AS flagged
         FROM ladn.archive_items a
         LEFT JOIN ladn.children c ON c.id = a.child_id
        WHERE a.deleted_at IS NULL
        GROUP BY a.child_id, c.first_name, c.last_name, c.leave_date, c.date_of_birth, c.looked_after
        ORDER BY min(a.archived_at) DESC`);

    const { rows: [deleted] } = await db.query(
      `SELECT count(*)::int n, COALESCE(sum(bytes),0)::bigint b FROM ladn.archive_items WHERE deleted_at IS NOT NULL`);

    const { rows: runs } = await db.query(
      `SELECT run_id, kind, mode, child_id, started_at, finished_at, items, deleted, held, ok, note
         FROM ladn.archive_runs ORDER BY started_at DESC LIMIT 15`);

    res.json({
      ofsted_last_inspection: ofstedLastInspection,
      classes: byClass,
      children: children.map(c => ({
        child_id: c.child_id,
        name: [c.first_name, c.last_name].filter(Boolean).join(' ') || `Child #${c.child_id}`,
        leave_date: AC.ymd(c.leave_date),
        date_of_birth: AC.ymd(c.date_of_birth),
        looked_after: !!c.looked_after,
        items: c.items, rows: c.rows, bytes: Number(c.bytes),
        archived_at: c.archived_at,
        next_expiry: AC.ymd(c.next_expiry),
        last_expiry: AC.ymd(c.last_expiry),
        flagged: c.flagged,
      })),
      destroyed: { items: deleted.n, bytes: Number(deleted.b) },
      runs,
      generated_at: new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /child/:id — what we hold for one child, in which class, dying when ──
router.get('/child/:id', managerOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'child id required' });
  try {
    const db = getPool();
    if (!await ready(db)) return res.status(503).json(notReady);

    const { rows: [child] } = await db.query(
      `SELECT id, first_name, last_name, date_of_birth, leave_date, looked_after, erased_at
         FROM ladn.children WHERE id=$1`, [id]);

    const { rows: [insp] } = await db.query(
      `SELECT value FROM ladn.settings WHERE key='ofsted_last_inspection'`);
    const ofstedLastInspection = (insp?.value || '').trim().slice(0, 10) || null;

    const { rows: items } = await db.query(
      `SELECT id, class, source_table, source_id, row_count, path, sha256, bytes,
              archived_at, anchor, anchor_date, expires_on, needs_review,
              deleted_at, delete_reason, run_id
         FROM ladn.archive_items WHERE child_id=$1
        ORDER BY class, source_table, path`, [id]);

    if (!items.length && !child) return res.status(404).json({ error: 'No archive and no child record for that id' });

    const today = AC.ymd(new Date());
    const classes = AC.CLASSES.map(c => {
      const mine = items.filter(i => i.class === c && !i.deleted_at);
      const dates = mine.map(i => AC.ymd(i.expires_on)).filter(Boolean).sort();
      return {
        class: c,
        ...AC.CLASS_RULES[c],
        items: mine.length,
        rows: mine.reduce((n, i) => n + (i.row_count || 0), 0),
        bytes: mine.reduce((n, i) => n + Number(i.bytes || 0), 0),
        next_expiry: dates[0] || null,
        last_expiry: dates[dates.length - 1] || null,
        frozen: c === 'ordinary' && !ofstedLastInspection,
      };
    });

    await recordAudit({ req, action: 'view', entity_type: 'child_archive', entity_id: String(id),
      meta: { items: items.length } });

    res.json({
      child: child ? {
        id: child.id,
        name: [child.first_name, child.last_name].filter(Boolean).join(' ') || `Child #${child.id}`,
        date_of_birth: AC.ymd(child.date_of_birth),
        leave_date: AC.ymd(child.leave_date),
        looked_after: !!child.looked_after,
        erased_at: child.erased_at,
      } : { id, name: `Child #${id}`, note: 'no live children row — the archive outlived the record' },
      ofsted_last_inspection: ofstedLastInspection,
      classes,
      items: items.map(i => ({
        ...i,
        bytes: Number(i.bytes || 0),
        anchor_date: AC.ymd(i.anchor_date),
        expires_on: AC.ymd(i.expires_on),
        expired: !!i.expires_on && AC.ymd(i.expires_on) <= today,
        // Why this item is on this clock, straight from the class map — so the
        // answer to "why does an attendance row die at three years and a SEN
        // record at twenty-five" is on the screen, not in somebody's head.
        // A split table (child_consents) has a reason PER CLASS, not per table:
        // the photo permission and the trip permission slip are the same table
        // on two clocks eighteen years apart.
        why: whyFor(i.source_table, i.class, i.needs_review),
      })),
      totals: {
        live: items.filter(i => !i.deleted_at).length,
        destroyed: items.filter(i => i.deleted_at).length,
        flagged: items.filter(i => i.needs_review && !i.deleted_at).length,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /flagged — everything the paranoid default is holding for a human ────
// The fallback is only defensible if somebody eventually looks at it. This is
// the list they look at.
router.get('/flagged', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    if (!await ready(db)) return res.status(503).json(notReady);
    const { rows } = await db.query(
      `SELECT source_table, count(*)::int items, count(DISTINCT child_id)::int children,
              COALESCE(sum(row_count),0)::int rows, min(expires_on) next_expiry
         FROM ladn.archive_items
        WHERE deleted_at IS NULL AND needs_review
        GROUP BY source_table ORDER BY items DESC`);
    res.json(rows.map(r => ({ ...r, next_expiry: AC.ymd(r.next_expiry) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /destroyed — the deletion log ────────────────────────────────────────
// The part everyone skips, and the part the ICO asks about.
router.get('/destroyed', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    if (!await ready(db)) return res.status(503).json(notReady);
    const { rows } = await db.query(
      `SELECT child_id, class, source_table, path, row_count, bytes, expires_on, deleted_at, delete_reason
         FROM ladn.archive_items WHERE deleted_at IS NOT NULL
        ORDER BY deleted_at DESC LIMIT 500`);
    res.json(rows.map(r => ({ ...r, bytes: Number(r.bytes || 0), expires_on: AC.ymd(r.expires_on) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
