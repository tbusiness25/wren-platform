'use strict';
/**
 * away-gaps.js — b512 collector for the Cockpit "What needs me" board.
 *
 * ONE card: "N questions nobody could answer while you were away". Never one
 * card per question — the board exists to end the burying, and a week away
 * could easily produce thirty gaps.
 *
 * A gap is a row in `ladn.assistant_away_log` with `gap = true` and no
 * `gap_cleared_at`: somebody asked the away assistant something, and NOTHING in
 * the Managers Bible, the business manual, the policies, the handbook or the
 * runbooks covered it. That is the most valuable output of the whole feature —
 * it is the Bible's own missing-sections list, written by the people who needed
 * those sections, at the moment they needed them.
 *
 * CONTENT: counts, the modes they fell in, and the oldest date. No question
 * text, because a question may name a child even though the route guards the
 * text before storing it — the board is read on a dashboard, so this one is
 * counts-only regardless, and the questions themselves are read on the
 * assistant's own page behind its own gate.
 *
 * DEGRADES on 42P01: attention-refresh.js is cronned nightly at 06:45 against
 * PROD and loads collectors from host source, so this file goes live on prod
 * the next morning with nothing deployed. It must answer "nothing to report"
 * rather than throwing until the b512 migration is applied.
 */
const { getPool } = require('../../db/pool');
const { classify } = require('./rag');

const SOURCE = 'away-gaps';

async function collect() {
  const db = getPool();
  let n = 0, oldest = null, byMode = [];
  try {
    const { rows } = await db.query(`
      SELECT count(*)::int AS n, to_char(min(created_at), 'YYYY-MM-DD') AS oldest
        FROM assistant_away_log
       WHERE gap AND gap_cleared_at IS NULL`);
    n = rows[0].n; oldest = rows[0].oldest;
    if (n) {
      const { rows: m } = await db.query(`
        SELECT mode, count(*)::int AS n
          FROM assistant_away_log
         WHERE gap AND gap_cleared_at IS NULL
         GROUP BY 1 ORDER BY 2 DESC`);
      byMode = m;
    }
  } catch (e) {
    if (e.code === '42P01') return { ok: true, items: [], note: 'b512 migration not applied' };
    throw e;
  }
  if (!n) return { ok: true, items: [] };

  const c = classify({ blockedOnToby: true });
  const modeWords = byMode.map(m => `${m.n} in ${m.mode}`).join(', ');
  return {
    ok: true,
    items: [{
      source: SOURCE,
      source_key: 'away-questions-unanswered',
      title: n === 1
        ? 'One question nobody could answer while you were away'
        : `${n} questions nobody could answer while you were away`,
      detail: `Somebody asked the stand-in adviser and nothing in the Bible, the manual, the policies or the `
            + `handbook covered it${modeWords ? ` (${modeWords})` : ''}. The oldest is from ${oldest || 'an unknown date'}. `
            + `Each one is a section the Bible is missing, written by the person who needed it. Read them, answer `
            + `what matters, and tick it off — this card clears when none is left open.`,
      why: c.why,
      rag: c.rag,
      category: 'documents',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: Math.min(90, 8 * n),
      action_url: '/away-assistant.html?gaps=1',
      evidence: { table: 'assistant_away_log', open_gaps: n, by_mode: byMode },
      sort_hint: 6,
    }],
  };
}

module.exports = { name: SOURCE, owns: [SOURCE], collect };
