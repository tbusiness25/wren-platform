'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b524 (2026-10-21) — the duplicate bank lines, their cause, and the dry run.
//
// WHAT TOBY SAW: each Ealing receipt (13 Jul £33,913.01, 6 Aug £17,141.60) also
// appears as a second line labelled "Parent — Fees in" / "Parent".
//
// THE CAUSE, measured on prod read-only on 2026-10-21. The same Barclays account
// is fed into ladn.bank_statement_lines TWICE:
//
//   • TrueLayer open banking   (bank_statements.source = 'truelayer')  — the feed
//     since 26 Sep, src/routes/open-banking.js POST /sync
//   • the Xero bank feed       (bank_statements.source = 'xero')       — PROMPT 64,
//     src/routes/open-banking.js _syncXeroAccount
//
// Each keys its lines on its OWN provider_id under its OWN statement row, so the
// unique index (statement_id, provider_id) can never see the twin. 267 of the 268
// date+amount duplicate groups on prod span two sources; 556 lines are involved.
//
// And the label is the giveaway: _syncXeroAccount builds `description` as
// [Contact.Name, Reference, LineItems[0].Description].join(' — '), so an Ealing
// receipt that Xero has coded to the contact "Parent" with a line "Fees in"
// renders exactly as "Parent — Fees in". That is the Xero copy, every time.
//
// WHY IT MOSTLY STOPPED. Since 2026-10-05 _syncXeroAccount sets excluded_reason
// on INSERT ('Xero copy of a Barclays line…'), so only 2 of the 268 groups still
// have two LIVE lines. Two holes are left, and they are what this module closes:
//
//   1. the ON CONFLICT DO UPDATE branch does not set excluded_reason, so a line
//      that landed BEFORE that fix stays live forever however often it re-syncs;
//   2. a THIRD feed added later repeats the whole thing from nothing — the rule
//      lives inside one provider's sync function rather than anywhere a new
//      provider would have to pass.
//
// So: `markTwins` records the twin on the line itself (duplicate_of_line_id), is
// called by the sync AFTER its upsert whatever the branch, and is keyed on the
// data (date + amount) rather than on which provider wrote it.
//
// THE REPORT IS A REPORT. buildReport() writes to bank_line_duplicate_reports /
// _flags and changes no bank line. applyReport() exists, is never called by
// anything scheduled, and sets `excluded_reason` only — Toby approves the prod
// cleanup from the screen.
// ─────────────────────────────────────────────────────────────────────────────

// Which feed is the source of truth. The other copies lose.
const DEFAULT_KEEP_ORDER = ['truelayer', 'csv', 'xero'];

// pg hands a DATE back as a LOCAL-midnight Date, so String(d).slice(0,10) gives
// "Fri Aug 14" — which then fails as a date parameter. Read the local getters,
// not toISOString(), which rolls the day back west of UTC. (The same trap is
// commented in src/lib/funding-periods.js and src/lib/payroll-costs.js; this is
// the third place that needs it.)
const ymd = (v) => {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d)) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const REASON = (keepSource, keepId) =>
  `Duplicate of the ${keepSource} line (#${keepId}): the same Barclays account is fed by more than one provider — set aside by b524`;

/**
 * Every date+amount group holding lines from more than one feed.
 *
 * Grouped on (transaction_date, amount_pence) and nothing else, deliberately:
 * the two feeds give the same transaction different provider_ids AND different
 * description text, so those are the only two fields that agree. A genuine pair
 * of identical payments on one day from one feed is therefore NOT flagged — the
 * group must span two sources.
 *
 * @returns [{ transaction_date, amount_pence, keep, drop:[...] }]
 */
async function detect(db, { keepOrder = DEFAULT_KEEP_ORDER, since = null } = {}) {
  const params = [];
  let dateFilter = '';
  if (since) { params.push(String(since).slice(0, 10)); dateFilter = `AND l.transaction_date >= $${params.length}::date`; }

  // `duplicate_of_line_id` is added by the b524 migration. DETECTION itself needs
  // nothing new — it is a GROUP BY over date and amount — so selecting the column
  // unconditionally made the whole dry-run report 500 on any database the
  // migration has not reached, including PROD, which is exactly where somebody
  // would want to read it first. Asked for only where it exists.
  const { rows: haveCol } = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='ladn' AND table_name='bank_statement_lines'
        AND column_name='duplicate_of_line_id' LIMIT 1`);
  const dupCol = haveCol.length ? 'l.duplicate_of_line_id' : 'NULL::int AS duplicate_of_line_id';

  const { rows } = await db.query(`
    WITH g AS (
      SELECT l.transaction_date, l.amount_pence
        FROM bank_statement_lines l
        JOIN bank_statements s ON s.id = l.statement_id
       WHERE TRUE ${dateFilter}
       GROUP BY 1, 2
      HAVING COUNT(DISTINCT s.source) > 1
    )
    SELECT l.id, l.statement_id, l.transaction_date, l.amount_pence,
           s.source, l.excluded_reason, l.reconciled, ${dupCol}
      FROM bank_statement_lines l
      JOIN bank_statements s ON s.id = l.statement_id
      JOIN g ON g.transaction_date = l.transaction_date AND g.amount_pence = l.amount_pence
     ORDER BY l.transaction_date, l.amount_pence, l.id`, params);

  const rank = (src) => {
    const i = keepOrder.indexOf(String(src || ''));
    return i === -1 ? keepOrder.length : i;
  };

  const groups = new Map();
  for (const r of rows) {
    const key = `${ymd(r.transaction_date)}|${r.amount_pence}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const out = [];
  for (const [, lines] of groups) {
    // Keep: the preferred feed; within a feed, a line already RECONCILED beats an
    // untouched one (somebody has done work against it), then the lowest id.
    const sorted = lines.slice().sort((a, b) =>
      rank(a.source) - rank(b.source) ||
      (b.reconciled === true) - (a.reconciled === true) ||
      a.id - b.id);
    const keep = sorted[0];
    // ONLY LINES FROM A DIFFERENT FEED ARE COPIES.
    //
    // The read-only prod forecast turned up a group holding TWO truelayer lines
    // and one Xero one, and the naive "everything after the first" rule proposed
    // setting the second TRUELAYER line aside — £880.84 that the bank really did
    // move twice. Two identical payments on one day are ordinary (two families
    // paying the same fee, two card settlements of equal value), and the feed's
    // own unique index on (statement_id, provider_id) has already removed any
    // repeat that is genuinely the same transaction. A same-feed pair is
    // therefore real until a person says otherwise, and nothing here says it.
    const drop = sorted.slice(1).filter(l => l.source !== keep.source);
    if (!drop.length) continue;
    out.push({
      transaction_date: ymd(keep.transaction_date),
      amount_pence: Number(keep.amount_pence),
      keep: { id: keep.id, source: keep.source, reconciled: !!keep.reconciled },
      drop: drop.map(d => ({
        id: d.id, source: d.source, reconciled: !!d.reconciled,
        already_excluded: d.excluded_reason != null,
        suggested_excluded_reason: REASON(keep.source, keep.id),
      })),
    });
  }
  return out;
}

/**
 * Write the dry-run report. Mutates NO bank line.
 *
 * `db_name` is recorded on the report row so a report run against wren_dev can
 * never be mistaken for one run against prod — the whole point of the dry run is
 * that a person reads it before anything is set aside on live money.
 */
async function buildReport(db, { actorId = null, since = null, notes = null } = {}) {
  const groups = await detect(db, { since });
  const { rows: [dbrow] } = await db.query('SELECT current_database() AS d');

  const flags = [];
  for (const g of groups) {
    for (const d of g.drop) {
      flags.push({
        bank_line_id: d.id, keep_line_id: g.keep.id,
        transaction_date: g.transaction_date, amount_pence: g.amount_pence,
        dup_source: d.source, keep_source: g.keep.source,
        rule: 'same_date_amount_other_feed',
        suggested_excluded_reason: d.suggested_excluded_reason,
        already_excluded: d.already_excluded,
      });
    }
  }
  const pence = flags.filter(f => !f.already_excluded).reduce((a, f) => a + Math.abs(f.amount_pence), 0);

  const { rows: [rep] } = await db.query(`
    INSERT INTO bank_line_duplicate_reports (run_by, db_name, groups_found, lines_flagged, pence_flagged, notes)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [actorId, dbrow.d, groups.length, flags.length, pence, notes]);

  for (const f of flags) {
    await db.query(`
      INSERT INTO bank_line_duplicate_flags
        (report_id, bank_line_id, keep_line_id, transaction_date, amount_pence,
         dup_source, keep_source, rule, suggested_excluded_reason, already_excluded)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (report_id, bank_line_id) DO NOTHING`,
      [rep.id, f.bank_line_id, f.keep_line_id, f.transaction_date, f.amount_pence,
       f.dup_source, f.keep_source, f.rule, f.suggested_excluded_reason, f.already_excluded]);
  }

  return {
    report: rep,
    groups_found: groups.length,
    lines_flagged: flags.length,
    lines_already_excluded: flags.filter(f => f.already_excluded).length,
    lines_to_exclude: flags.filter(f => !f.already_excluded).length,
    pence_to_exclude: pence,
    by_source: countBy(flags.filter(f => !f.already_excluded), f => f.dup_source),
    dry_run: true,
  };
}

function countBy(rows, fn) {
  const m = {};
  for (const r of rows) { const k = fn(r) || 'unknown'; m[k] = (m[k] || 0) + 1; }
  return m;
}

/**
 * Apply a report: set `excluded_reason` on the flagged lines.
 *
 * Nothing calls this on a schedule and nothing calls it from a sync. It sets one
 * column on lines a report already named, skips any line that already carries a
 * reason (somebody else's decision is not overwritten) and skips any line that
 * has been RECONCILED since the report was written — excluding a line somebody
 * has since matched would strand their work.
 */
async function applyReport(db, reportId, { actorId = null } = {}) {
  const { rows: [rep] } = await db.query(
    'SELECT * FROM bank_line_duplicate_reports WHERE id=$1', [reportId]);
  if (!rep) return { error: 'no_such_report' };
  if (rep.applied_at) return { error: 'already_applied', applied_at: rep.applied_at };

  const { rows: flags } = await db.query(
    'SELECT * FROM bank_line_duplicate_flags WHERE report_id=$1 ORDER BY id', [reportId]);

  let excluded = 0, skipped_has_reason = 0, skipped_reconciled = 0;
  for (const f of flags) {
    const { rows: [line] } = await db.query(
      'SELECT id, excluded_reason, reconciled FROM bank_statement_lines WHERE id=$1', [f.bank_line_id]);
    if (!line) continue;
    if (line.excluded_reason != null) { skipped_has_reason++; continue; }
    if (line.reconciled === true)     { skipped_reconciled++; continue; }
    await db.query(`
      UPDATE bank_statement_lines
         SET excluded_reason=$2, excluded_by=$3, excluded_at=now(),
             duplicate_of_line_id=COALESCE(duplicate_of_line_id, $4),
             duplicate_rule=COALESCE(duplicate_rule, $5)
       WHERE id=$1`,
      [f.bank_line_id, f.suggested_excluded_reason, actorId, f.keep_line_id, f.rule]);
    excluded++;
  }
  await db.query(
    'UPDATE bank_line_duplicate_reports SET applied_at=now(), applied_by=$2 WHERE id=$1',
    [reportId, actorId]);
  return { report_id: reportId, excluded, skipped_has_reason, skipped_reconciled, total_flags: flags.length };
}

/**
 * Record the twin on lines that have one. The recurrence guard.
 *
 * Called by the Xero sync after its upsert (both branches), and by the Accounts
 * screen's Refresh. Two writes, both safe to repeat:
 *   • duplicate_of_line_id / duplicate_rule on the newer copy;
 *   • excluded_reason, but ONLY where it is NULL and ONLY on a line from a feed
 *     that is not the designated source — which is hole 1 above. A line somebody
 *     has reconciled is left alone.
 *
 * It is keyed on the DATA, so a third provider added tomorrow is covered without
 * anyone remembering to add a rule to its sync function.
 *
 * `exclude` DEFAULTS TO FALSE and the caller has to ask for it, with a `since`.
 * The sync passes its own fetch window, so the only lines it can ever set aside
 * are ones that arrived in the call that is running. Left on by default it would
 * retroactively exclude 556 historical prod lines the first time anything called
 * it — which is exactly the cleanup Toby has said he approves himself, from the
 * dry-run report.
 */
async function markTwins(db, { keepOrder = DEFAULT_KEEP_ORDER, since = null, exclude = false } = {}) {
  if (exclude && !since) throw new Error('markTwins: refusing to exclude without a `since` window');
  // It WRITES duplicate_of_line_id, so unlike detect() it genuinely needs the
  // migration. The Xero sync calls this and catches — a sync that worked must
  // not fail because the guard could not run.
  const { rows: haveCol } = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='ladn' AND table_name='bank_statement_lines'
        AND column_name='duplicate_of_line_id' LIMIT 1`);
  if (!haveCol.length) return { skipped: 'b524 migration not applied on this database', groups: 0, linked: 0, excluded: 0 };
  const groups = await detect(db, { keepOrder, since });
  let linked = 0, excludedNow = 0;
  for (const g of groups) {
    for (const d of g.drop) {
      const r = await db.query(`
        UPDATE bank_statement_lines
           SET duplicate_of_line_id = $2, duplicate_rule = $3
         WHERE id = $1 AND duplicate_of_line_id IS DISTINCT FROM $2`,
        [d.id, g.keep.id, 'same_date_amount_other_feed']);
      linked += r.rowCount;
      if (exclude && !d.already_excluded && !d.reconciled) {
        const e = await db.query(`
          UPDATE bank_statement_lines
             SET excluded_reason = $2, excluded_at = now()
           WHERE id = $1 AND excluded_reason IS NULL AND reconciled = false`,
          [d.id, d.suggested_excluded_reason]);
        excludedNow += e.rowCount;
      }
    }
  }
  return { groups: groups.length, linked, excluded: excludedNow };
}

module.exports = { DEFAULT_KEEP_ORDER, REASON, detect, buildReport, applyReport, markTwins };
