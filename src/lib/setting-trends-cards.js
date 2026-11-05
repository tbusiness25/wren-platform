'use strict';
/* ═══════════════════════════════════════════════════════════════════════════════
 * setting-trends-cards.js — b529 (2026-10-26)
 *
 * Turns the flags from src/lib/setting-trends.js into cards on the What-needs-me
 * board (ladn.cockpit_cards, b232). Kept OUT of the engine so the engine can
 * state, and keep, that it contains no write.
 *
 * IN-APP ONLY. There is no email, no Telegram, no notify() and no push in this
 * file or in the job that calls it. A card appearing on the board is the whole
 * notification: nothing about how the children are getting on should arrive in
 * anybody's inbox.
 *
 * ── ONE CARD PER KIND OF FLAG, NOT ONE PER FLAG ──────────────────────────────
 * The engine raises a flag per finding, which is right for the page: a manager
 * reading the report wants Literacy and Mathematics named separately. On a
 * kanban board it is wrong. Measured on wren_dev, a single term produced twelve
 * cards, seven of them "<area> evidenced for under half the children" — which
 * is one job ("our evidence is thin across the board"), not seven, and would
 * bury the rest of the board.
 *
 * So the cards are grouped by flag KIND and every member's numbers go in the
 * card body. At most five cards per term, each one a thing a person could
 * actually do.
 *
 * ── ONE CARD PER KIND PER TERM ───────────────────────────────────────────────
 * The term key and the kind are written into cockpit_cards.tags, and a card is
 * only inserted when no card already carries both — including a card already
 * moved to Done, because a manager who has dealt with "our Literacy evidence is
 * thin this term" does not want it back next Tuesday. That is why this needs no
 * new table: the dedupe key is the tag pair.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const TAG = 'setting-trends';

/** What a flag is worth on a kanban board. */
const PRIORITY = { high: 'high', medium: 'medium', low: 'low' };
const RANK = { high: 0, medium: 1, low: 2 };

/** The title a group of flags of one kind gets. */
function groupTitle(kind, flags, trends) {
  if (flags.length === 1) return flags[0].title;
  const n = flags.length;
  switch (kind) {
    case 'area_thin':
      return `${n} areas of learning are evidenced for under half the children`;
    case 'group_gap':
      return `${n} groups are more than ${flags[0].numbers.threshold_pp} points behind the rest`;
    case 'attribute_missing':
      return `${n} things we do not record are blinding the ${trends.term.label} analysis`;
    default:
      return `${n} things to look at (${kind.replace(/_/g, ' ')})`;
  }
}

/** The card body: the numbers, then where it came from. */
function cardBody(kind, flags, trends) {
  const t = trends.term;
  const lines = [];
  if (flags.length === 1) {
    lines.push(flags[0].detail);
  } else {
    lines.push('Each of these is from Look back → Setting trends for ' + t.label + ':', '');
    for (const f of flags) lines.push('• ' + f.title, '  ' + f.detail, '');
  }
  lines.push('', `Term: ${t.label} (${t.start} to ${t.as_of}${t.in_progress ? ', still running' : ''}).`
    + ` Cohort: ${trends.cohort.children} children on roll.`);
  const link = (flags.find(f => f.link) || {});
  if (link.link) lines.push('', `${link.link_label || 'Open'}: ${link.link}`);
  lines.push('', 'Raised by Look back → Setting trends (Roost → Curriculum). '
    + 'Groups of fewer than five children are never shown, so nothing here identifies a child.');
  return lines.join('\n');
}

/**
 * Insert a card for each KIND of flag that has no card yet for this term.
 *
 * @param {object} db      pg pool
 * @param {object} trends  the output of buildTrends()
 * @param {object} [opts]  { staffId, dryRun, severities }
 * @returns {Promise<{raised: Array, skipped: Array, dry_run: boolean, term: string}>}
 */
async function raiseCards(db, trends, opts) {
  const o = opts || {};
  const want = o.severities || ['high', 'medium'];
  const termKey = trends.term.key;
  const raised = [], skipped = [];

  // group, keeping the engine's order (worst first) inside each group
  const groups = new Map();
  for (const flag of (trends.flags || [])) {
    if (!want.includes(flag.severity)) { skipped.push({ key: flag.key, why: 'severity ' + flag.severity }); continue; }
    const kind = flag.kind || 'other';
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(flag);
  }
  // worst group first, so the board reads in the order a person should work
  const ordered = [...groups.entries()].sort((a, b) =>
    RANK[a[1][0].severity] - RANK[b[1][0].severity] || a[0].localeCompare(b[0]));

  for (const [kind, flags] of ordered) {
    const tags = [TAG, termKey, 'kind:' + kind];
    const { rows: existing } = await db.query(
      `SELECT id, col FROM cockpit_cards WHERE tags @> $1::text[] LIMIT 1`, [tags]);
    if (existing.length) {
      skipped.push({ key: 'kind:' + kind, why: 'already raised (card ' + existing[0].id + ', ' + existing[0].col + ')' });
      continue;
    }
    const title = groupTitle(kind, flags, trends);
    if (o.dryRun) { raised.push({ key: 'kind:' + kind, title, flags: flags.length, card_id: null }); continue; }

    const { rows: posRow } = await db.query(
      `SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM cockpit_cards WHERE col = 'this_week'`);
    const { rows } = await db.query(`
      INSERT INTO cockpit_cards (title, detail, col, priority, source, tags, position, created_by)
      VALUES ($1, $2, 'this_week', $3, 'auto', $4::text[], $5, $6)
      RETURNING id`,
      [title.slice(0, 200), cardBody(kind, flags, trends), PRIORITY[flags[0].severity] || 'medium',
       tags, posRow[0].pos, o.staffId || null]);
    raised.push({ key: 'kind:' + kind, title, flags: flags.length, card_id: rows[0].id });
  }
  return { raised, skipped, dry_run: !!o.dryRun, term: termKey };
}

module.exports = { raiseCards, cardBody, groupTitle, TAG };
