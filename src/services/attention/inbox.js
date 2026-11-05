'use strict';
/**
 * inbox.js — b235 collector for the b232 "What needs me" board.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
 * It does not build a second UI. Toby's problem is that there are already too
 * many places to look; the fix for that is not a sixth screen. Everything b235
 * produces arrives as cards on the board that already exists.
 *
 * ── AND WHAT IT DOES NOT DUPLICATE ──────────────────────────────────────────
 * b232's messages.js already emits "N parents waiting in the parents portal"
 * and "N inbound conversations in the comms hub". Repeating those here would
 * put the same fact on the board twice under two sources, which is exactly how
 * a board stops being trusted. So this collector emits only what is new in
 * b235:
 *
 *   • the router's reply-now queue — the ranked "do this next"
 *   • anything the safeguarding/medical/allergy/complaint bypass caught
 *   • unanswered ENQUIRIES, which nothing covered before and which are money
 *   • the Gmail "1. TO DO" backlog — his own filing, aged
 *   • parents in Gmail whose last word was theirs
 *   • one card for the prevention report
 *
 * ── CONTENT ─────────────────────────────────────────────────────────────────
 * Counts, ids and hashes. No subject, no body, no address, no name. Same rule
 * as every other collector: a card says how many and how old, and reading what
 * they actually said means opening the place where the access checks live.
 */

const { getPool } = require('../../db/pool');
const { classify } = require('./rag');

const SOURCE = 'inbox';

// A thread only counts as "left waiting" after this long. Below it, he is
// simply working through the day like anybody else.
const WAIT_HOURS = 48;

async function collect() {
  const db = getPool();
  const items = [];

  // The b235 tables may not exist on an edition where the build has not run.
  // A collector that throws here would take the whole refresh down with it.
  const have = await tablesPresent(db);

  // ── 1. the router queue ───────────────────────────────────────────────────
  if (have.verdicts) {
    const { rows } = await db.query(`
      SELECT lane, urgency, COUNT(*)::int AS n,
             ARRAY_AGG(id ORDER BY confidence DESC) AS ids
        FROM inbox_router_verdicts
       GROUP BY 1, 2`);

    const replyNow = rows.filter((r) => r.lane === 'reply-now');
    const n = replyNow.reduce((s, r) => s + r.n, 0);
    if (n > 0) {
      const red = replyNow.filter((r) => r.urgency === 'red').reduce((s, r) => s + r.n, 0);
      const c = classify({ blockedOnToby: true });
      items.push({
        source: SOURCE,
        source_key: 'router-reply-now',
        title: `${n} item${n === 1 ? '' : 's'} the router says you can clear in under two minutes each`,
        detail: `${red} of them are red. This is the queue in order — start at the top and do not sort it again.`,
        why: c.why,
        rag: red > 0 ? 'red' : c.rag,
        category: 'comms',
        blocked_on: 'toby',
        effort_minutes: Math.min(120, n * 2),
        action_url: '/admin/cockpit',
        evidence: { count: n, red, verdict_ids: flatIds(replyNow, 50) },
        sort_hint: 0,
      });
    }

    const delegate = rows.filter((r) => r.lane === 'delegate-to-ayla');
    const dn = delegate.reduce((s, r) => s + r.n, 0);
    if (dn > 0) {
      items.push({
        source: SOURCE,
        source_key: 'router-delegate',
        title: `${dn} item${dn === 1 ? '' : 's'} only need forwarding to the deputy`,
        detail: 'The router judged these as somebody else\'s job. Forwarding them is the entire task.',
        why: 'Waiting on a decision only you can make — but the decision is just "send it".',
        rag: 'amber',
        category: 'comms',
        blocked_on: 'toby',
        effort_minutes: Math.min(60, dn),
        action_url: '/admin/cockpit',
        evidence: { count: dn, verdict_ids: flatIds(delegate, 50) },
        sort_hint: 1,
      });
    }

    // ── 2. the bypass ───────────────────────────────────────────────────────
    // Anything the rules force-routed. Always red, always at the top, and the
    // model was never consulted about it.
    const { rows: forced } = await db.query(`
      SELECT forced_key, COUNT(*)::int AS n, ARRAY_AGG(id) AS ids
        FROM inbox_router_verdicts WHERE forced GROUP BY 1 ORDER BY 2 DESC`);
    const fn = forced.reduce((s, r) => s + r.n, 0);
    if (fn > 0) {
      const kinds = forced.map((r) => `${r.n} ${r.forced_key}`).join(', ');
      const c = classify({ childSafety: true });
      items.push({
        source: SOURCE,
        source_key: 'router-forced',
        title: `${fn} message${fn === 1 ? '' : 's'} routed by rule: ${kinds}`,
        detail: 'Safeguarding, medical, allergy and complaint content bypasses the model entirely and is never downgraded. Open Comms to read them.',
        why: c.why,
        rag: 'red',
        category: 'safeguarding',
        blocked_on: 'toby',
        effort_minutes: Math.min(90, fn * 5),
        action_url: '/admin/communications/inbox',
        evidence: { count: fn, by_kind: forced.map((r) => ({ kind: r.forced_key, n: r.n })), verdict_ids: flatIds(forced, 50) },
        sort_hint: 0,
      });
    }
  }

  // ── 3. enquiries — nothing covered these before, and they are money ───────
  const { rows: enq } = await db.query(`
    SELECT COUNT(*)::int AS n,
           MIN(created_at) AS oldest,
           ARRAY_AGG(id ORDER BY created_at) AS ids
      FROM enquiries
     WHERE replied_at IS NULL
       AND created_at < now() - ($1 || ' hours')::interval`, [WAIT_HOURS]);
  if (enq[0] && enq[0].n > 0) {
    const n = enq[0].n;
    const c = classify({ money: true });
    items.push({
      source: SOURCE,
      source_key: 'enquiries-unanswered',
      title: `${n} enquir${n === 1 ? 'y has' : 'ies have'} never been replied to`,
      detail: `The oldest came in on ${stamp(enq[0].oldest)}. An enquiry is a family who wanted a place and asked for it — two days of silence and they have booked somewhere else.`,
      why: c.why,
      rag: 'red',
      category: 'admissions',
      blocked_on: 'toby',
      effort_minutes: Math.min(120, n * 4),
      action_url: '/admin/admissions/enquiries',
      evidence: { count: n, enquiry_ids: (enq[0].ids || []).slice(0, 50), oldest: stamp(enq[0].oldest) },
      sort_hint: 0,
    });
  }

  // ── 4. the "1. TO DO" pile ────────────────────────────────────────────────
  if (have.gmail) {
    const { rows: todo } = await db.query(`
      SELECT COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE last_msg_at < now() - interval '365 days')::int AS over_1y,
             MIN(last_msg_at) AS oldest
        FROM inbox_gmail_threads
       WHERE swept_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM unnest(labels) l WHERE l = '1. TO DO' OR l LIKE '1. TO DO/%')`);
    if (todo[0] && todo[0].n > 0) {
      const n = todo[0].n, oldYr = todo[0].over_1y;
      items.push({
        source: SOURCE,
        source_key: 'gmail-todo-backlog',
        title: `${n} email${n === 1 ? '' : 's'} are still labelled "1. TO DO"`,
        detail: `${oldYr} of them are over a year old, the oldest from ${stamp(todo[0].oldest)}. By your own filing these are things you meant to do and did not.`,
        why: 'Waiting on a decision only you can make — mostly the decision to stop pretending these will happen.',
        rag: oldYr > 0 ? 'amber' : 'green',
        category: 'comms',
        blocked_on: 'toby',
        effort_minutes: 30,
        action_url: '/admin/cockpit',
        evidence: { count: n, over_1y: oldYr, oldest: stamp(todo[0].oldest) },
        sort_hint: 3,
      });
    }

    // ── 5. parents in Gmail, unanswered ─────────────────────────────────────
    const { rows: par } = await db.query(`
      SELECT COUNT(*)::int AS n, MIN(last_msg_at) AS oldest
        FROM inbox_gmail_threads
       WHERE swept_at IS NOT NULL AND is_parent
         AND last_direction = 'in' AND NOT answered
         AND last_msg_at < now() - ($1 || ' hours')::interval
         AND last_msg_at > now() - interval '180 days'`, [WAIT_HOURS]);
    if (par[0] && par[0].n > 0) {
      const n = par[0].n;
      const c = classify({ blockedOnToby: true });
      items.push({
        source: SOURCE,
        source_key: 'gmail-parents-unanswered',
        title: `${n} parent email${n === 1 ? '' : 's'} in the last six months had the last word`,
        detail: `Filed under Parents, inbound, no reply from us. Oldest ${stamp(par[0].oldest)}. Counted from Gmail, so this is separate from the parents-portal figure.`,
        why: c.why,
        rag: 'amber',
        category: 'comms',
        blocked_on: 'toby',
        effort_minutes: Math.min(120, n * 3),
        action_url: '/admin/cockpit',
        evidence: { count: n, oldest: stamp(par[0].oldest), window_days: 180, table: 'inbox_gmail_threads' },
        sort_hint: 2,
      });
    }
  }

  // ── 6b. b338 — pinned emails/notes and stale assignments ─────────────────
  // Additive to the collector, not a new card type: still counts/ids only,
  // still lands on the same board. "Stale" = assigned, still needs_reply,
  // and nobody has touched it in 48h — the same WAIT_HOURS used above.
  try {
    const { rows: pinnedEmails } = await db.query(`
      SELECT COUNT(*)::int AS n, ARRAY_AGG(id ORDER BY pinned_at DESC) AS ids
        FROM comms_email_queue WHERE pinned_by IS NOT NULL`);
    const { rows: pinnedNotes } = await db.query(`
      SELECT COUNT(*)::int AS n FROM manager_notes WHERE pinned = true`);
    const pn = (pinnedEmails[0]?.n || 0) + (pinnedNotes[0]?.n || 0);
    if (pn > 0) {
      items.push({
        source: SOURCE,
        source_key: 'pinned',
        title: `${pn} pinned item${pn === 1 ? '' : 's'} waiting on the board`,
        detail: `${pinnedEmails[0]?.n || 0} pinned email${pinnedEmails[0]?.n === 1 ? '' : 's'}, ${pinnedNotes[0]?.n || 0} pinned note${pinnedNotes[0]?.n === 1 ? '' : 's'}. Pinned by one of the three managers for the others to see.`,
        why: 'Waiting on a decision only you can make — someone pinned it so it would not scroll away.',
        rag: 'amber',
        category: 'comms',
        blocked_on: 'toby',
        effort_minutes: Math.min(60, pn * 3),
        action_url: '/admin/communications',
        evidence: { count: pn, email_ids: (pinnedEmails[0]?.ids || []).filter(Boolean).slice(0, 50) },
        sort_hint: 1,
      });
    }
  } catch (_) { /* pre-b338 schema on this edition — skip, don't fail the refresh */ }

  try {
    const { rows: stale } = await db.query(`
      SELECT COUNT(*)::int AS n, MIN(received_at) AS oldest, ARRAY_AGG(id ORDER BY received_at) AS ids
        FROM comms_email_queue
       WHERE assigned_to IS NOT NULL AND action_state = 'needs_reply'
         AND received_at < now() - ($1 || ' hours')::interval`, [WAIT_HOURS]);
    if (stale[0] && stale[0].n > 0) {
      const n = stale[0].n;
      items.push({
        source: SOURCE,
        source_key: 'assigned-stale',
        title: `${n} assigned email${n === 1 ? '' : 's'} still marked "needs reply" after 48h`,
        detail: `Oldest since ${stamp(stale[0].oldest)}. Assigned to someone, but the state has not moved — check it has not been missed.`,
        why: 'Waiting on a decision only you can make — whoever it is assigned to may need it reassigned or chased.',
        rag: 'amber',
        category: 'comms',
        blocked_on: 'toby',
        effort_minutes: Math.min(60, n * 3),
        action_url: '/admin/communications',
        evidence: { count: n, oldest: stamp(stale[0].oldest), email_ids: (stale[0].ids || []).slice(0, 50) },
        sort_hint: 2,
      });
    }
  } catch (_) { /* pre-b338 schema on this edition — skip, don't fail the refresh */ }

  // ── 6. the prevention report ──────────────────────────────────────────────
  // Informational by design: this card is a pointer, not a task. classify()
  // guarantees informational can never be worse than green.
  const c = classify({ informational: true, why: 'Every recommendation cites a figure from your own inbox.' });
  items.push({
    source: SOURCE,
    source_key: 'prevention-report',
    title: 'How to stop this happening — ranked by hours saved',
    detail: 'Concrete changes, each one backed by a number from your own correspondence. Opens in the Cockpit.',
    why: c.why,
    rag: 'green',
    category: 'comms',
    blocked_on: null,
    effort_minutes: 5,
    action_url: '/admin/cockpit',
    evidence: { endpoint: '/api/inbox-intel/prevention' },
    sort_hint: 9,
  });

  return { ok: true, items };
}

/**
 * Rule 2 of the refresh applies here too: if the b235 tables are missing we
 * must still return ok:true for the sources we CAN see, but we must not report
 * "nothing found" for a table we could not read.
 */
async function tablesPresent(db) {
  const { rows } = await db.query(`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name IN ('inbox_router_verdicts', 'inbox_gmail_threads')`);
  const set = new Set(rows.map((r) => r.table_name));
  return { verdicts: set.has('inbox_router_verdicts'), gmail: set.has('inbox_gmail_threads') };
}

function flatIds(rows, max) {
  const out = [];
  for (const r of rows) for (const id of (r.ids || [])) { if (out.length >= max) return out; out.push(id); }
  return out;
}

function stamp(d) {
  if (!d) return 'an unknown date';
  return new Date(d).toISOString().slice(0, 10);
}

module.exports = { name: SOURCE, owns: [SOURCE], collect };
