'use strict';
/**
 * report-evidence.js — b528 (2026-10-26)
 *
 * "Whenever they're doing reports they should be able to see the data that
 * they're writing about." — Toby, 2026-10-26.
 *
 * ONE endpoint that answers "what does Wren actually hold about this child?",
 * for the practitioner who is writing about them. It is the server half of
 * public/js/wren-report-evidence.js, which draws the panel; the two-year check
 * review screen is the first page to use it and others are listed in b528's
 * NOTES.
 *
 * ── IT GATHERS NOTHING OF ITS OWN ───────────────────────────────────────────
 * The evidence comes from src/lib/two-year-check.js's gatherEvidence() — the
 * same deterministic pack the drafting model is given. That is deliberate and
 * it is the point of the panel: a practitioner who disagrees with the draft is
 * looking at the SAME records it was written from, not at a second, slightly
 * different reading of the database. If the panel and the draft ever disagreed,
 * the panel would be worse than nothing.
 *
 * ── HONESTY ABOUT THE TRACKER ───────────────────────────────────────────────
 * 99.7% of framework_tracker cells on prod are status 'observed' — the b25m
 * backfill default, which means "there is evidence", NOT "this child is secure"
 * (see the b523 measurements). Showing those as achievement would hand a
 * practitioner a wall of green and let them write a developmental claim about a
 * real child on the strength of an import default. So this route separates
 *   judgements  — emerging / developing / secure, a person's assessment
 *   evidence_only — 'observed', which is a pointer to an observation
 *   not_yet     — explicitly looked for and not seen
 * and `tracking.recorded` is FALSE unless there is at least one real judgement.
 * The panel then says "no tracking recorded yet" rather than drawing defaults.
 *
 * ── WHO MAY READ IT ─────────────────────────────────────────────────────────
 * The b243 relationship, widened by exactly one step for the room leader who
 * now writes these checks (b528's routing change):
 *   manager-level · the child's key person · anyone a report for this child is
 *   assigned to · the room_leader of the child's own room.
 * A parent token is refused outright here as well as in PARENT_DENY: this is a
 * staff working surface and it quotes observation text.
 */

const express = require('express');
const router = express.Router();

const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const T = require('../lib/two-year-check');

const MANAGER_ROLES = new Set(['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager']);
const isManager = u => !!(u && MANAGER_ROLES.has(u.role));

// What a tracker status MEANS. Keys are the five statuses in use on prod and
// wren_dev (observed 6269 / emerging 63 / secure 4 / developing 3 on prod,
// 2026-10-26); anything unrecognised is treated as a judgement rather than
// silently dropped, because a status this file has not seen is more likely to be
// a new assessment value than a new import default.
const EVIDENCE_ONLY = new Set(['observed']);
const NOT_MET = new Set(['not_yet', 'not_observed', '']);
const STATUS_LABEL = {
  observed: 'evidence logged',
  emerging: 'emerging',
  developing: 'developing',
  secure: 'secure',
  not_yet: 'not yet',
};

router.use(authenticate);

// Belt and braces beside PARENT_DENY: this surface quotes observation text and
// names staff. A parents-audience token has no business in it.
router.use((req, res, next) => {
  if ((req.user && req.user.role === 'parent') || req._portal === 'parents') {
    return res.status(403).json({ error: 'Not available on the parents portal' });
  }
  next();
});

/** The relationship gate described in this file's header. */
async function mayRead(db, user, childId) {
  if (isManager(user)) return { ok: true, via: 'manager' };
  const { rows } = await db.query(`
    SELECT c.key_person_id, c.room_id,
           (SELECT s.room_id FROM staff s WHERE s.id = $2) AS my_room_id,
           EXISTS (SELECT 1 FROM reports r
                    WHERE r.child_id = c.id AND r.assigned_staff_id = $2) AS assigned
      FROM children c WHERE c.id = $1`, [childId, user.id]);
  if (!rows.length) return { ok: false, missing: true };
  const r = rows[0];
  if (Number(r.key_person_id) === Number(user.id)) return { ok: true, via: 'key_person' };
  if (r.assigned) return { ok: true, via: 'assigned' };
  if (user.role === 'room_leader' && r.room_id != null && Number(r.room_id) === Number(r.my_room_id)) {
    return { ok: true, via: 'room_leader' };
  }
  return { ok: false, missing: false };
}

/** One tracker row, as the panel shows it. */
function trackerItem(t) {
  const status = String(t.status || '').toLowerCase();
  return {
    ref: t.ref,
    statement: t.statement,
    aspect: t.aspect || null,
    age_range: t.age_range || null,
    status,
    status_label: STATUS_LABEL[status] || status || 'recorded',
    kind: NOT_MET.has(status) ? 'not_met' : (EVIDENCE_ONLY.has(status) ? 'evidence_only' : 'judgement'),
    date: t.assessed || null,
    notes: t.notes || null,
  };
}

/**
 * GET /child/:childId
 *   ?scope=two_year_check   (default) — the three statutory prime areas.
 *   ?obs=5                  how many recent observations to include (1–10).
 *
 * Counts, statements, dates, excerpts and bare photo paths. Nothing is written.
 */
router.get('/child/:childId', async (req, res) => {
  const childId = parseInt(req.params.childId, 10);
  if (!Number.isInteger(childId)) return res.status(400).json({ error: 'bad child id' });
  const obsWanted = Math.max(1, Math.min(10, parseInt(req.query.obs, 10) || 5));
  const scope = String(req.query.scope || 'two_year_check');

  try {
    const db = getPool();
    const gate = await mayRead(db, req.user, childId);
    if (gate.missing) return res.status(404).json({ error: 'Child not found' });
    if (!gate.ok) {
      return res.status(403).json({ error: 'This child is not one of yours — ask a manager if you need their records.' });
    }

    const ev = await T.gatherEvidence(db, childId);

    // ── The prime areas, honestly ──────────────────────────────────────────
    let judgements = 0, trackerRows = 0;
    const areas = T.PRIME_AREAS.map(def => {
      const a = ev.areas[def.key] || { observations: [], tracker: [], next_steps: [], planned: [] };
      const items = a.tracker.map(trackerItem);
      trackerRows += items.length;
      const met = items.filter(i => i.kind === 'judgement');
      judgements += met.length;
      return {
        key: def.key,
        heading: def.heading,
        plain: def.plain,
        // "The statements met, with dates" — a real judgement, most recent first.
        judgements: met
          .sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')))
          .slice(0, 25),
        evidence_only: items.filter(i => i.kind === 'evidence_only').length,
        not_met: items.filter(i => i.kind === 'not_met').length,
        not_met_examples: items.filter(i => i.kind === 'not_met').slice(0, 4).map(i => i.statement),
        observation_count: a.observations.length,
        // The drafter's own bar for "is there enough to write about this?" —
        // the same function, so the panel and the draft agree.
        sufficiency: T.areaSufficiency(a),
        open_next_steps: a.next_steps
          .filter(n => n.status === 'pending')
          .slice(0, 8)
          .map(n => ({ ref: n.ref, id: n.id, description: n.description, created: n.created, due_by: n.due_by })),
      };
    });

    // ── Recent observations across the prime areas ─────────────────────────
    // De-duplicated: one observation tagged C&L and PSED appears in two areas of
    // the pack and must appear once in the panel.
    const seen = new Set();
    const recent = [];
    for (const k of T.PRIME_KEYS) {
      for (const o of (ev.areas[k].observations || [])) {
        if (seen.has(o.id)) continue;
        seen.add(o.id);
        recent.push(o);
      }
    }
    // Observations with no prime-area tag are still this child's records and are
    // still worth reading — they go after the tagged ones, never instead of them.
    for (const o of (ev.unplaced.observations || [])) {
      if (!seen.has(o.id)) { seen.add(o.id); recent.push(o); }
    }
    recent.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const observations = recent.slice(0, obsWanted).map(o => ({
      ref: o.ref,
      id: o.id,
      date: o.date,
      title: o.title,
      areas: (o.areas || []).map(k => {
        const d = T.PRIME_AREAS.find(x => x.key === k);
        return d ? d.heading : k;
      }),
      // An excerpt, not the whole observation: this is a prompt to the
      // practitioner's memory, and the full record is one tap away.
      excerpt: String(o.text || '').replace(/\s+/g, ' ').slice(0, 320),
      truncated: String(o.text || '').length > 320,
      analysis: o.analysis ? String(o.analysis).replace(/\s+/g, ' ').slice(0, 220) : null,
      author: o.author,
      photos: (o.photos || []).slice(0, 4),
      link: `/ey/observation/${o.id}`,
    }));

    const openNextSteps = [];
    for (const a of areas) for (const n of a.open_next_steps) openNextSteps.push(Object.assign({ area: a.heading }, n));
    for (const n of (ev.unplaced.next_steps || [])) {
      if (n.status === 'pending' && !openNextSteps.some(x => x.id === n.id)) {
        openNextSteps.push({ area: null, ref: n.ref, id: n.id, description: n.description, created: n.created, due_by: n.due_by });
      }
    }

    res.json({
      scope,
      child: {
        id: ev.child.id,
        name: ev.child.name,
        known_as: ev.child.known_as,
        age_months: ev.child.age_months,
        room_name: ev.child.room_name,
        date_of_birth: ev.child.date_of_birth,
        premature_weeks: ev.child.premature_weeks || null,
        corrected_age_label: ev.child.corrected_age_label || null,
        send_needs: ev.child.send_needs,
      },
      key_person: ev.keyperson,
      window: ev.window,
      tracking: {
        // THE honesty flag. False ⇒ the panel says "no tracking recorded yet"
        // instead of showing import defaults as if they were progress.
        recorded: judgements > 0,
        judgement_count: judgements,
        row_count: trackerRows,
        evidence_only_count: trackerRows - judgements,
        note: judgements > 0 ? null
          : (trackerRows > 0
            ? `${trackerRows} statement${trackerRows === 1 ? '' : 's'} in the prime areas carry evidence from an observation, but nobody has recorded a judgement (emerging / developing / secure) against any of them. There is no tracked progress to read here yet.`
            : 'No framework tracking has been recorded for this child in the prime areas.'),
        areas,
      },
      observations,
      open_next_steps: openNextSteps.slice(0, 12),
      counts: ev.counts,
      coel: (ev.coel || []).filter(c => c.status && c.status !== 'not_yet').slice(0, 8),
    });
  } catch (e) {
    if (/Child not found/i.test(e.message || '')) return res.status(404).json({ error: 'Child not found' });
    console.error('[b528] report-evidence:', e.message);
    res.status(500).json({ error: 'Could not gather this child\'s records' });
  }
});

module.exports = router;
