'use strict';
/**
 * reading-room.js — b352 collector for the "What needs me" board.
 *
 * ONE card, when analyses are waiting to be read: "N analyses are waiting to be read". Never one card per
 * document — with a few hundred documents in the two trees that would bury the board, which is the exact
 * failure this board was built to end. It clears itself the moment the last one is ticked Read.
 *
 * "Analyses" here means the four kinds a person is asked to read and act on: analysis, audit, research and
 * QA reports. Decision records (already made) and reference material (manuals, guides, decks) sit in the
 * reading room too but never raise a card.
 *
 * CONTENT: counts and the oldest date only. No title, no path, no word of any document.
 * If the b352 migration has not been applied the collector answers "nothing to report" rather than
 * failing, so prod stays quiet until it is.
 */
const { getPool } = require('../../db/pool');
const { classify } = require('./rag');

const SOURCE = 'reading-room';

async function collect() {
  const db = getPool();
  let n = 0, needDecision = 0, oldest = null;
  try {
    const { rows } = await db.query(`
      SELECT count(*)::int AS n,
             count(*) FILTER (WHERE needs_decision)::int AS need_decision,
             to_char(min(doc_date), 'YYYY-MM-DD') AS oldest
        FROM reading_room_items
       WHERE NOT withheld AND missing_since IS NULL AND read_at IS NULL
         AND kind IN ('analysis','audit','research','qa')`);
    n = rows[0].n; needDecision = rows[0].need_decision; oldest = rows[0].oldest;
  } catch (e) {
    if (e.code === '42P01') return { ok: true, items: [], note: 'b352 migration not applied' };
    throw e;
  }
  if (!n) return { ok: true, items: [] };

  const c = classify({ blockedOnToby: true });
  return {
    ok: true,
    items: [{
      source: SOURCE,
      source_key: 'analyses-waiting',
      title: n === 1 ? 'One analysis is waiting to be read' : `${n} analyses are waiting to be read`,
      detail: `${needDecision ? `${needDecision} of them look like they need a decision. ` : ''}`
            + `The oldest is from ${oldest || 'an unknown date'}. Open the Reading room, read what matters, and tick Read — `
            + 'the ones that need a decision then carry on to Discussed, Decided and Done. This card clears when nothing is left unread.',
      why: c.why,
      rag: c.rag,
      category: 'documents',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: Math.min(90, 10 * n),
      action_url: '/documents/reading-room.html',
      evidence: { table: 'reading_room_items', unread: n, need_decision: needDecision },
      sort_hint: 6,
    }],
  };
}

module.exports = { name: SOURCE, owns: [SOURCE], collect };
