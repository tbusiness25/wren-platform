'use strict';
/**
 * b311 — the office manager's case: the confused-clicks offer.
 *
 * Toby: "if it's seen that she's clicked on 4 Wrong Things it can pop up and
 * say what are you trying to find."
 *
 * ── WHY THIS IS NOT A NOTIFICATION ──────────────────────────────────────────
 * Every other signal in this build is a prediction sent to a manager. This one
 * is addressed to the person in front of the screen, at the moment they are
 * lost, and it is an OFFER — in the corner, dismissible, never a modal, never
 * blocking, and never more than once a session. Putting it through the
 * notification dispatcher would make it a bell badge somebody reads tomorrow,
 * which is not help.
 *
 * ── THE QUESTION ────────────────────────────────────────────────────────────
 *   Has this person opened `sections` distinct sections in the last `window`
 *   seconds without changing anything in any of them?
 *
 * The data is b164's beacons, already in ladn.audit_log — no new client
 * instrumentation, and the evaluation is server-side against the recorded rows
 * rather than a guess the browser makes about itself.
 *
 * "Without changing anything" is the half that stops it firing at somebody who
 * is simply working fast. A create / update / delete / download in the window
 * means they found what they came for.
 *
 * ── WHERE THE ANSWER GOES ───────────────────────────────────────────────────
 * Straight into the corpus b201 already built: CONTENT.find() over 416 pages,
 * deterministic, no model and no embeddings, so it answers when Ollama and
 * qdrant are both down. Nothing new is indexed for this build.
 */

const path = require('path');

const CONTENT = require(path.join(__dirname, '..', '..', '..', 'public', 'js', 'wren-tour-content.js'));

// Beacon actions that mean "I did the thing I came to do".
const PRODUCTIVE = ['create', 'update', 'delete', 'download', 'login'];

/**
 * Should this person be offered help right now?
 * @returns {Promise<{offer:boolean, reason:string, sections?:string[], window_secs?:number}>}
 */
async function evaluate(db, staffId, opts = {}) {
  const windowSecs = Math.min(900, Math.max(20, parseInt(opts.windowSecs, 10) || 120));
  const minSections = Math.min(20, Math.max(2, parseInt(opts.minSections, 10) || 4));
  const maxPerDay = Math.max(0, parseInt(opts.maxPerDay, 10) || 2);

  if (maxPerDay === 0) return { offer: false, reason: 'the offer is switched off' };

  const { rows: shown } = await db.query(
    `SELECT count(*)::int AS n FROM signal_nudges
      WHERE staff_id = $1 AND shown_day = (now() AT TIME ZONE 'Europe/London')::date`,
    [staffId]);
  if (shown[0].n >= maxPerDay) {
    return { offer: false, reason: `already offered ${shown[0].n} times today` };
  }

  const { rows } = await db.query(
    `SELECT
        count(DISTINCT entity_id) FILTER (WHERE action = 'page_view' AND entity_id IS NOT NULL)::int AS sections,
        count(*) FILTER (WHERE action = ANY($3::text[]))::int AS productive,
        array_agg(DISTINCT entity_id) FILTER (WHERE action = 'page_view' AND entity_id IS NOT NULL) AS pages
       FROM audit_log
      WHERE actor_id = $1
        AND occurred_at > now() - ($2 || ' seconds')::interval`,
    [staffId, String(windowSecs), PRODUCTIVE]);

  const sections = rows[0].sections || 0;
  const productive = rows[0].productive || 0;
  if (productive > 0) return { offer: false, reason: 'they got something done in that window' };
  if (sections < minSections) return { offer: false, reason: `${sections} sections in ${windowSecs}s — under the threshold of ${minSections}` };

  return {
    offer: true,
    reason: `${sections} sections opened in ${windowSecs} seconds with nothing changed`,
    sections: (rows[0].pages || []).slice(0, 12),
    section_count: sections,
    window_secs: windowSecs,
  };
}

/** Record that an offer was made. Returns the row id so the answer can attach. */
async function record(db, staffId, ev) {
  const { rows } = await db.query(
    `INSERT INTO signal_nudges (staff_id, sections, window_secs)
     VALUES ($1, $2, $3) RETURNING id`,
    [staffId, ev.sections || [], ev.window_secs || null]);
  return rows[0].id;
}

/** Where does "what were you looking for?" point? */
function destinations(query, portal, limit) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const hits = CONTENT.find(q, { portal: portal || undefined, limit: Math.min(6, Math.max(1, limit || 4)) });
  return hits.map(h => ({
    id: h.id,
    title: h.title,
    url: h.url,
    portal: h.portal,
    what: CONTENT.strip(h.what),
    status: h.status || 'ok',
    // b201's honesty rule: where a flow is known broken the corpus says so, and
    // sending somebody confidently down it would be worse than not answering.
    issue: h.issue ? CONTENT.strip(h.issue) : null,
  }));
}

module.exports = { evaluate, record, destinations, PRODUCTIVE };
