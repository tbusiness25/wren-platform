'use strict';
/**
 * index.js — b232. The collector registry and the refresh.
 *
 * ── ADDING A COLLECTOR ──────────────────────────────────────────────────────
 * Write `src/services/attention/<name>.js` exporting
 *
 *     { name, owns: ['<source>'], async collect() { return { ok, items, note } } }
 *
 * and add one line to COLLECTORS below. That is the whole contract.
 *
 * ── THE THREE RULES OF THE REFRESH ──────────────────────────────────────────
 *
 *  1. NOTHING IS EVER DELETED. An item that no longer applies gets resolved_at
 *     set and moves to the green column for a week. The board is also a record
 *     of what was wrong and when.
 *
 *  2. A COLLECTOR THAT FAILS RESOLVES NOTHING. `ok:false` means "I could not
 *     look" — the crontab was unreadable, the dash database has been stopped,
 *     production was unreachable. Treating "I could not look" as "there is
 *     nothing there" would quietly empty the board, which is the worst possible
 *     failure for a screen whose entire job is to be trusted.
 *
 *  3. A HUMAN'S DECISION HOLDS FOR A WEEK. If Toby marks a collector-backed item
 *     done and the underlying problem is still there, the refresh does not
 *     immediately reopen it — it waits 7 days. A snooze is never overwritten at
 *     all. Otherwise the board argues with him, and he stops opening it.
 */

const { getPool } = require('../../db/pool');
const { compare } = require('./rag');

// ── the registry — one line per collector ───────────────────────────────────
const COLLECTORS = [
  require('./safeguarding'),
  require('./compliance'),
  require('./finance'),
  require('./messages'),
  require('./crons'),
  require('./migrations'),
  require('./dash'),
  require('./manual'),
  require('./inbox'),   // b235 — router queue, enquiries, Gmail backlog
  require('./parents-group'),  // b239 — Google group vs the children register
  require('./report-cycle'),   // b244 — settling-in / 6-month chat / termly / 2-year check, overdue
  require('./kitchen'),        // b331 — missed SFBB checks, fridge/freezer probes, kitchen shopping orders
  require('./leaving-notices'), // b341 — notices given in the parents app, and memory books that came back empty
  require('./family-access'),   // 2026-09-21 — a child on roll whose family cannot see them in the app
  require('./parent-forms'),    // b343 — forms a parent has not signed for a week, and funded children with no declaration
  require('./staff-voice'),     // b345 — anonymous comments from staff waiting to be read (a count, never a word of one)
  require('./finance-calendar'), // b346 — tax & filing deadlines: a card at our own date, red near the statutory one; idle without the b346 tables
  require('./reading-room'),     // b352 — ONE card: analyses waiting to be read (a count, never a title)
  require('./kanban'),           // b504 — Toby's open Kanban cards, so each job exists once (My list)
  require('./tasks'),            // b504 — Toby's open tasks (monthly-checklist overdue rows collapse into ONE item)
  require('./away-gaps'),        // b512 — ONE card: questions the away assistant could not answer from any document (a count and the modes, never a question)
  require('./funding-receipts'), // b524 — ONE card per Ealing claim month that is short or has not arrived (the July under-2s lesson); idle without the b524 tables
  require('./invoice-staleness'), // b535 — ONE card: invoices whose figures no longer match what Wren would bill today (the 29 Oct wrong-day-rate lesson); idle when every bill agrees
  require('./room-meetings'),    // b530 — TWO cards at most: a room that has not met in a fortnight, and meetings held but never written up; idle without the b530 columns
];

const REOPEN_AFTER_DAYS = 7;

const UPSERT = `
INSERT INTO attention_items
  (source, source_key, rag, severity, title, detail, why, category, due_date,
   blocked_on, effort_minutes, action_url, evidence, manual, sort_hint,
   first_seen, last_seen)
VALUES
  ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14, now(), now())
ON CONFLICT (source, source_key) DO UPDATE SET
  rag            = EXCLUDED.rag,
  title          = EXCLUDED.title,
  detail         = EXCLUDED.detail,
  why            = EXCLUDED.why,
  category       = EXCLUDED.category,
  due_date       = EXCLUDED.due_date,
  blocked_on     = EXCLUDED.blocked_on,
  effort_minutes = EXCLUDED.effort_minutes,
  action_url     = EXCLUDED.action_url,
  evidence       = EXCLUDED.evidence,
  sort_hint      = EXCLUDED.sort_hint,
  last_seen      = now(),
  -- Rule 3, and note the resolved_by test. A HUMAN "done" is a decision and it
  -- stands for a week. An AUTOMATIC close is not a decision — it is this same
  -- refresh saying "gone" last time — so if a collector reports the item again
  -- it reopens at once. Without that distinction a bad auto-close (the container
  -- crontab incident) would have hidden sixteen real findings for seven days.
  resolved_at    = CASE
                     WHEN attention_items.resolved_at IS NULL THEN NULL
                     WHEN attention_items.resolved_by IS NULL THEN NULL
                     WHEN attention_items.resolved_at < now() - interval '${REOPEN_AFTER_DAYS} days' THEN NULL
                     ELSE attention_items.resolved_at
                   END,
  resolved_by    = CASE
                     WHEN attention_items.resolved_by IS NULL THEN NULL
                     WHEN attention_items.resolved_at < now() - interval '${REOPEN_AFTER_DAYS} days' THEN NULL
                     ELSE attention_items.resolved_by
                   END
RETURNING (xmax = 0) AS inserted`;

/**
 * Run every collector and reconcile the table against what they found.
 * @param {{only?: string[], quiet?: boolean}} opts
 */
async function refresh(opts = {}) {
  const db = getPool();
  const only = opts.only && opts.only.length ? new Set(opts.only) : null;
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);

  const report = { started: new Date().toISOString(), collectors: [], inserted: 0, updated: 0, resolved: 0 };

  for (const c of COLLECTORS) {
    if (only && !only.has(c.name)) continue;
    const entry = { name: c.name, ok: false, found: 0, inserted: 0, updated: 0, resolved: 0, note: null };
    let result;
    try {
      result = await c.collect();
    } catch (e) {
      entry.note = `threw: ${e.message}`;
      report.collectors.push(entry);
      log(`  ${pad(c.name)} ERROR  ${e.message}`);
      continue;
    }

    entry.ok = !!result.ok;
    entry.note = result.note || null;
    const items = Array.isArray(result.items) ? result.items : [];
    entry.found = items.length;

    for (const it of items) {
      const { rows } = await db.query(UPSERT, [
        it.source, it.source_key, it.rag,
        it.title, it.detail || null, it.why || null, it.category || null,
        it.due_date || null, it.blocked_on || null,
        it.effort_minutes == null ? null : it.effort_minutes,
        it.action_url || null, JSON.stringify(it.evidence || {}),
        it.manual === true, it.sort_hint || 0,
      ]);
      if (rows[0] && rows[0].inserted) entry.inserted++; else entry.updated++;

      // b504 — optional second step so a collector can set the My-list columns
      // without the UPSERT above changing. `extra_on_insert` applies only on the
      // first insert (so a human's later change to lane/owner/plan_due survives
      // every refresh); `extra_always` applies every time. Only the whitelisted
      // columns in EXTRA_COLS are ever written, and never a title or a resolved_at.
      const extra = Object.assign({}, rows[0] && rows[0].inserted ? it.extra_on_insert : null, it.extra_always);
      if (Object.keys(extra).length) {
        // A deploy that has the code but not scripts/b504-my-list.sql yet must not take the whole refresh down.
        try { await applyExtra(db, it.source, it.source_key, extra); }
        catch (e) { entry.note = `my-list columns not applied (${e.message}) — run scripts/b504-my-list.sql`; }
      }
    }

    // Rule 2 — only a collector that could actually look gets to close things.
    // Resolved one source at a time so a collector owning two sources cannot
    // close a row in one of them using the keys it found in the other.
    if (entry.ok && c.owns && c.owns.length) {
      for (const src of c.owns) {
        const keys = items.filter(i => i.source === src).map(i => i.source_key);
        const { rowCount } = await db.query(`
          UPDATE attention_items
             SET resolved_at = now()
           WHERE source = $1
             AND resolved_at IS NULL
             AND NOT (source_key = ANY($2))`, [src, keys]);
        entry.resolved += rowCount;
      }
    }

    report.inserted += entry.inserted;
    report.updated  += entry.updated;
    report.resolved += entry.resolved;
    report.collectors.push(entry);
    log(`  ${pad(c.name)} ${entry.ok ? 'ok  ' : 'SKIP'} found ${String(entry.found).padStart(3)}  new ${entry.inserted}, same ${entry.updated}, closed ${entry.resolved}${entry.note ? '  - ' + entry.note : ''}`);
  }

  report.finished = new Date().toISOString();
  return report;
}

// b504 — the only columns a collector may set through extra_on_insert / extra_always,
// with the cast each needs. Anything else in the object is ignored.
const EXTRA_COLS = {
  kind: '::text', owner_staff_id: '::int', plan_due: '::date', lane: '::text',
  parked_at: '::timestamptz', tags: '::text[]', blocked_on: '::text',
};
async function applyExtra(db, source, sourceKey, extra) {
  const sets = [], params = [source, sourceKey];
  for (const [col, cast] of Object.entries(EXTRA_COLS)) {
    if (!(col in extra)) continue;
    params.push(extra[col]);
    sets.push(`${col} = $${params.length}${cast}`);
  }
  if (!sets.length) return;
  await db.query(`UPDATE attention_items SET ${sets.join(', ')} WHERE source = $1 AND source_key = $2`, params);
}

// ── reads used by the route ─────────────────────────────────────────────────

// b504 — jobs mirrored/seeded for My list. They are Toby's list, not "Wren is
// watching" findings, so the traffic lights (summary) and the old board leave them
// out; they live on My list. `include_jobs` brings them back for the full view.
const JOB_ONLY_SOURCES = ['launch-list', 'kanban', 'tasks', 'session'];
const NOT_JOB_SQL = `source <> ALL('{${JOB_ONLY_SOURCES.join(',')}}'::text[])`;

/** Counts only. This is what the login/cockpit traffic lights call. */
async function summary() {
  const db = getPool();
  const { rows } = await db.query(`
    SELECT rag, COUNT(*)::int AS n
      FROM attention_items
     WHERE resolved_at IS NULL
       AND (snoozed_until IS NULL OR snoozed_until <= now())
       AND ${NOT_JOB_SQL}
     GROUP BY rag`);
  const out = { red: 0, amber: 0, green: 0 };
  for (const r of rows) if (out[r.rag] != null) out[r.rag] = r.n;

  const { rows: recent } = await db.query(`
    SELECT COUNT(*)::int AS n FROM attention_items
     WHERE resolved_at IS NOT NULL AND resolved_at > now() - interval '7 days' AND ${NOT_JOB_SQL}`);
  out.cleared_this_week = recent[0] ? recent[0].n : 0;
  out.total = out.red + out.amber + out.green;
  return out;
}

const ITEM_COLS = `id, source, source_key, rag, title, detail, why, category, due_date,
                   blocked_on, effort_minutes, action_url, evidence, manual, sort_hint,
                   first_seen, last_seen, snoozed_until, resolved_at, created_at`;

/**
 * The board. Live items plus anything cleared in the last week (which is what
 * "resolved in the last 7 days is green" means in practice).
 */
async function board(opts = {}) {
  const db = getPool();
  const includeSnoozed = !!opts.include_snoozed;
  const { rows } = await db.query(`
    SELECT ${ITEM_COLS}
      FROM attention_items
     WHERE (resolved_at IS NULL OR resolved_at > now() - interval '7 days')
       ${opts.include_jobs ? '' : 'AND ' + NOT_JOB_SQL}
     ORDER BY id`);

  // pg hands DATE back as a JS Date in local time, which turns 2026-09-01 into
  // an ISO string a day early for anyone west of UTC. The board only ever wants
  // the calendar day, so it is normalised once, here, rather than in the UI.
  for (const r of rows) {
    if (r.due_date instanceof Date) {
      r.due_date = [r.due_date.getFullYear(),
                    String(r.due_date.getMonth() + 1).padStart(2, '0'),
                    String(r.due_date.getDate()).padStart(2, '0')].join('-');
    }
  }

  const live = [], cleared = [], snoozed = [];
  for (const r of rows) {
    if (r.resolved_at) { cleared.push(Object.assign({}, r, { rag: 'green' })); continue; }
    if (r.snoozed_until && new Date(r.snoozed_until) > new Date()) { snoozed.push(r); continue; }
    live.push(r);
  }
  live.sort(compare);

  const columns = {
    red:   live.filter(i => i.rag === 'red'),
    amber: live.filter(i => i.rag === 'amber'),
    green: live.filter(i => i.rag === 'green').concat(cleared),
  };
  if (includeSnoozed) columns.amber = columns.amber.concat(snoozed);

  return {
    start_here: columns.red[0] || columns.amber[0] || columns.green[0] || null,
    counts: { red: columns.red.length, amber: columns.amber.length, green: columns.green.length, snoozed: snoozed.length },
    columns,
    snoozed,
  };
}

function pad(s) { return String(s).padEnd(13, ' '); }

module.exports = { COLLECTORS, refresh, summary, board, REOPEN_AFTER_DAYS, JOB_ONLY_SOURCES };
