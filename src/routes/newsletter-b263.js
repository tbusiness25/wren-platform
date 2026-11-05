'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b263 — the half-termly parent newsletter: assembled from Wren, not written
// from scratch.
//
// ── WHY A SECOND ROUTER RATHER THAN EDITS TO newsletter.js ───────────────────
// src/routes/newsletter.js already carries 30 working routes, and one of them is
// `GET /:id` registered at line 117. Appending `GET /cycle` to the end of that
// file would put it BEHIND that wildcard, so the request would arrive at the
// single-newsletter handler with id='cycle' and 404. The same trap the CPD build
// hit with GET /assignments.
//
// So this router is mounted at the SAME prefix, immediately BEFORE the existing
// one. Express tries these handlers first; anything not matched here calls
// next() and falls through to the original router untouched. Nothing in
// newsletter.js is rewritten, reordered, or shadowed.
//
// Storage: newsletter_sections, which is what it is for. No sixth table.
// The 15-type catalogue and the tier ordering live in lib/newsletter-content.js.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();

const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');

const { resolveCycle, FREQUENCY_SETTING, FREQUENCIES } = require('../lib/newsletter-cycle');
const { assembleTier1 } = require('../lib/newsletter-assemble');
const { consentGap, consentedChildIds } = require('../lib/newsletter-consent');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
const {
  SECTION_TYPES, TYPE_BY_KEY, SINGLETON_TYPES, sortWeight,
  getStandingBlock, setStandingBlock,
} = require('../lib/newsletter-content');

const managerOnly = (req, res, next) => {
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin', 'headteacher']))
    return res.status(403).json({ error: 'Manager only' });
  next();
};

// Which section types this build assembles and therefore owns. A refresh may
// replace these; it must never touch a section a human typed.
const ASSEMBLED_TYPES = SECTION_TYPES.filter(t => t.assembled).map(t => t.type);

// ── Cycle ────────────────────────────────────────────────────────────────────

// GET /cycle — which newsletter is due, from school_terms.
router.get('/cycle', authenticate, managerOnly, async (req, res) => {
  try {
    const cycle = await resolveCycle(getPool(), { date: req.query.date || undefined });
    res.json(cycle);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /cycle/frequency — six a year (default) or three.
router.put('/cycle/frequency', authenticate, managerOnly, async (req, res) => {
  const f = String(req.body?.frequency || '').trim();
  if (!FREQUENCIES.has(f))
    return res.status(400).json({ error: 'frequency must be half_termly or termly' });
  try {
    const db = getPool();
    await db.query(`
      INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,now())
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()
    `, [FREQUENCY_SETTING, f, req.user.id || null]);
    res.json(await resolveCycle(db));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Consent ──────────────────────────────────────────────────────────────────

// GET /consent-gap — the number Toby cannot fix while he cannot see it.
router.get('/consent-gap', authenticate, managerOnly, async (req, res) => {
  try { res.json(await consentGap(getPool())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /section-types — the catalogue, for the compose screen.
router.get('/section-types', authenticate, managerOnly, (req, res) => {
  res.json({ types: SECTION_TYPES, assembled: ASSEMBLED_TYPES });
});

// ── Standing block (tier 2) ──────────────────────────────────────────────────

router.get('/standing-block', authenticate, managerOnly, async (req, res) => {
  try { res.json(await getStandingBlock(getPool())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/standing-block', authenticate, managerOnly, async (req, res) => {
  try {
    const saved = await setStandingBlock(getPool(), req.body?.items, req.user.id);
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Suggestions for the human-written tier ───────────────────────────────────
// Not auto-inserted: these are offered on the compose screen and a person
// chooses. The point of tier 3 is that a person wrote it.
router.get('/suggestions', authenticate, managerOnly, async (req, res) => {
  const db = getPool();
  const out = { theme: null, try_at_home: [], team_learning: null, you_said_we_did: [] };
  try {
    const cycle = await resolveCycle(db, { date: req.query.date || undefined });
    const period = cycle.current || cycle.next;
    out.cycle = cycle;
    if (!period) return res.json(out);

    // This half-term's theme, so the home activity connects to what the
    // children are actually doing rather than being generic.
    const { rows: plans } = await db.query(`
      SELECT theme, key_books FROM term_plans
       WHERE (school_term_id = ANY($1::int[]) OR term_name = $2)
         AND theme IS NOT NULL AND theme <> ''
       ORDER BY (school_term_id = ANY($1::int[])) DESC LIMIT 1`,
      [period.school_term_ids, period.name]);
    out.theme = plans[0]?.theme || null;

    // One thing to try at home, from the activity library. Matched loosely to
    // the theme where we can; otherwise the best-described library activities.
    const { rows: acts } = await db.query(`
      SELECT id, name, description, parent_tip, category, age_range
        FROM curriculum_activities
       WHERE is_library = true
         AND parent_tip IS NOT NULL AND parent_tip <> ''
         AND ($1::text IS NULL
              OR name ILIKE '%'||$1||'%' OR description ILIKE '%'||$1||'%'
              OR $1 = ANY(COALESCE(interests, ARRAY[]::text[])))
       ORDER BY id LIMIT 6`, [out.theme]);
    out.try_at_home = acts;
    if (!acts.length && out.theme) {
      const { rows: any } = await db.query(`
        SELECT id, name, description, parent_tip, category, age_range
          FROM curriculum_activities
         WHERE is_library = true AND parent_tip IS NOT NULL AND parent_tip <> ''
         ORDER BY id LIMIT 6`);
      out.try_at_home = any;
      out.try_at_home_note = `No library activity mentions “${out.theme}” — showing general suggestions.`;
    }

    // What the team is learning — the b262 deep-dive theme for the same
    // half-term. Parents rarely see that a setting invests in its staff.
    const { rows: cpd } = await db.query(`
      SELECT title, summary, evaluation_area FROM cpd_themes
       WHERE academic_year=$1 AND term=$2 AND ($3::int IS NULL OR half=$3) AND active
       ORDER BY sort_order LIMIT 1`,
      [period.academic_year, period.term, period.half]);
    out.team_learning = cpd[0] || null;

    // You said, we did — closing the loop publicly.
    const { rows: surveys } = await db.query(`
      SELECT id, survey_type, submitted_at FROM survey_responses
       ORDER BY submitted_at DESC NULLS LAST LIMIT 5`);
    out.you_said_we_did = surveys;
    out.you_said_we_did_note = surveys.length
      ? 'Survey responses are listed by type and date only — open Surveys to read them.'
      : 'No survey responses yet. “You said, we did” is the strongest partnership signal you have; a two-question survey would fill it.';

    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message, partial: out }); }
});

// ── Assemble tier 1 into a newsletter ────────────────────────────────────────

// POST /:id/assemble — (re)build every assembled section from live Wren data.
router.post('/:id/assemble', authenticate, managerOnly, async (req, res) => {
  const nlId = parseInt(req.params.id, 10);
  if (!Number.isInteger(nlId)) return res.status(400).json({ error: 'bad id' });
  const db = getPool();
  try {
    const { rows: nl } = await db.query('SELECT * FROM newsletters WHERE id=$1', [nlId]);
    if (!nl.length) return res.status(404).json({ error: 'Not found' });
    if (nl[0].status === 'sent')
      return res.status(409).json({ error: 'This newsletter has been sent — assembling would rewrite what parents received.' });
    // b295 — tier-1 assembly pulls PARENT content, and 'new_starters' names
    // children. A staff newsletter goes to personal inboxes, so it never gets
    // assembled from here; it is built from ladn.staff_notices instead.
    if (nl[0].audience === 'staff')
      return res.status(403).json({ error: 'That is a staff newsletter — it is assembled from the staff notices list, not from parent content.' });

    const cycle = await resolveCycle(db, { date: req.body?.date || undefined });
    const assembled = await assembleTier1(db, cycle, { room_id: req.body?.room_id || null });
    if (!assembled.window)
      return res.status(400).json({ error: 'No term period resolved', cycle });

    // Replace only the sections THIS build owns, and only on a draft. A section
    // someone typed is never touched: the delete is restricted to the assembled
    // type list for this one newsletter.
    await db.query(
      `DELETE FROM newsletter_sections WHERE newsletter_id=$1 AND section_type = ANY($2::text[])`,
      [nlId, ASSEMBLED_TYPES]);

    const written = [];
    for (const b of assembled.blocks) {
      // An empty section is noise in the newsletter — EXCEPT when it is empty
      // BECAUSE the consent gate emptied it. Dropping that row would delete the
      // only record that anything was hidden, and the compose screen would show
      // nothing at all rather than "1 child hidden: no photo consent recorded" —
      // which is precisely the silent swallowing this build exists to prevent.
      // The row is written with an empty items list, so renderSection() returns
      // '' and it never appears in the newsletter itself: visible while
      // composing, invisible to parents.
      if (b.empty && !b.consent_hidden) continue;
      const { rows } = await db.query(`
        INSERT INTO newsletter_sections
          (newsletter_id, section_type, title, final_content, metadata, section_order)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING id, section_type, section_order`,
        [nlId, b.key, b.title, '', JSON.stringify({
          items: b.items, source: b.source,
          consent_hidden: b.consent_hidden, consent_reason: b.consent_reason,
          window: assembled.window, assembled_at: new Date().toISOString(),
        }), sortWeight(b.key)]);
      written.push(rows[0]);
    }

    // Keep the term/year on the newsletter aligned to the cycle it was built for.
    await db.query(
      `UPDATE newsletters SET term=$2, academic_year=$3, updated_at=now() WHERE id=$1`,
      [nlId, assembled.window.name, (cycle.current || cycle.next).academic_year]);

    res.json({
      ok: true,
      window: assembled.window,
      cycle_warning: cycle.warning,
      sections_written: written.length,
      sections: written,
      blocks: assembled.blocks.map(b => ({
        key: b.key, title: b.title, source: b.source,
        items: b.items.length, empty: b.empty,
        consent_hidden: b.consent_hidden, consent_reason: b.consent_reason,
      })),
      consent_hidden_total: assembled.consent_hidden_total,
      consented_children: assembled.consented_children,
      unavailable: assembled.unavailable,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Tier-3 sections, including the single ask ────────────────────────────────

// PUT /:id/section/:type — upsert one human-written section.
// For a singleton type (`ask`, `standing_block`) this REPLACES rather than
// appends, which is how "exactly one ask" stays true without anyone policing it.
router.put('/:id/section/:type', authenticate, managerOnly, async (req, res) => {
  const nlId = parseInt(req.params.id, 10);
  const type = String(req.params.type);
  if (!Number.isInteger(nlId)) return res.status(400).json({ error: 'bad id' });
  const def = TYPE_BY_KEY[type];
  if (!def) return res.status(400).json({ error: `Unknown section type '${type}'` });
  if (def.assembled)
    return res.status(400).json({ error: `'${type}' is assembled from Wren data — use POST /:id/assemble` });

  const content = String(req.body?.content || '').trim();
  const title   = String(req.body?.title || def.label).slice(0, 255);
  const db = getPool();
  try {
    const { rows: nl } = await db.query('SELECT status FROM newsletters WHERE id=$1', [nlId]);
    if (!nl.length) return res.status(404).json({ error: 'Not found' });
    if (nl[0].status === 'sent') return res.status(409).json({ error: 'Already sent' });

    if (SINGLETON_TYPES.has(type)) {
      await db.query(
        'DELETE FROM newsletter_sections WHERE newsletter_id=$1 AND section_type=$2', [nlId, type]);
    }
    if (!content) return res.json({ ok: true, removed: true, section_type: type });

    const { rows } = await db.query(`
      INSERT INTO newsletter_sections
        (newsletter_id, section_type, title, final_content, metadata, section_order)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`,
      [nlId, type, title, content,
       JSON.stringify({ tier: def.tier, ...(req.body?.metadata || {}) }), sortWeight(type)]);
    res.json({ ok: true, section: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/apply-standing-block — drop the standing block in as the last section.
router.post('/:id/apply-standing-block', authenticate, managerOnly, async (req, res) => {
  const nlId = parseInt(req.params.id, 10);
  if (!Number.isInteger(nlId)) return res.status(400).json({ error: 'bad id' });
  const db = getPool();
  try {
    const { rows: nl } = await db.query('SELECT status FROM newsletters WHERE id=$1', [nlId]);
    if (!nl.length) return res.status(404).json({ error: 'Not found' });
    if (nl[0].status === 'sent') return res.status(409).json({ error: 'Already sent' });

    const sb = await getStandingBlock(db);
    await db.query(
      "DELETE FROM newsletter_sections WHERE newsletter_id=$1 AND section_type='standing_block'", [nlId]);
    const { rows } = await db.query(`
      INSERT INTO newsletter_sections
        (newsletter_id, section_type, title, final_content, metadata, section_order)
      VALUES ($1,'standing_block',$2,'',$3::jsonb,$4) RETURNING id, section_order`,
      [nlId, 'The usual reminders',
       JSON.stringify({ items: sb.items, last_reviewed: sb.last_reviewed,
                        stale: sb.stale, stale_reason: sb.stale_reason }),
       sortWeight('standing_block')]);
    res.json({ ok: true, section: rows[0], standing_block: sb });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Compose-screen summary: everything the screen needs in one call ──────────
router.get('/:id/compose-state', authenticate, managerOnly, async (req, res) => {
  const nlId = parseInt(req.params.id, 10);
  if (!Number.isInteger(nlId)) return res.status(400).json({ error: 'bad id' });
  const db = getPool();
  try {
    const { rows: nl } = await db.query('SELECT * FROM newsletters WHERE id=$1', [nlId]);
    if (!nl.length) return res.status(404).json({ error: 'Not found' });

    const [cycle, gap, standing, sectionsRes] = await Promise.all([
      resolveCycle(db),
      consentGap(db),
      getStandingBlock(db),
      db.query(`SELECT id, section_type, title, section_order, metadata,
                       (final_content IS NOT NULL AND final_content <> '') AS has_content
                  FROM newsletter_sections WHERE newsletter_id=$1
                 ORDER BY section_order, id`, [nlId]),
    ]);
    const sections = sectionsRes.rows;

    // How many photos/names the gate hid across this newsletter — the line the
    // compose screen shows so the gap is visible rather than silently swallowed.
    const hidden = sections.reduce((n, s) => n + Number(s.metadata?.consent_hidden || 0), 0);
    // Which sections the gate emptied completely — these render as nothing, so
    // without naming them here the screen would just be missing a section with
    // no explanation of why.
    const emptied = sections
      .filter(s => Number(s.metadata?.consent_hidden || 0) > 0
                && !(Array.isArray(s.metadata?.items) && s.metadata.items.length))
      .map(s => ({ section_type: s.section_type, title: s.title,
                   hidden: Number(s.metadata.consent_hidden) }));
    const present = new Set(sections.map(s => s.section_type));

    res.json({
      newsletter: nl[0],
      cycle,
      consent: {
        ...gap,
        hidden_in_this_newsletter: hidden,
        hidden_message: hidden
          ? `${hidden} ${hidden === 1 ? 'child' : 'children'} hidden: no photo consent recorded`
          : null,
        emptied_sections: emptied,
      },
      standing_block: standing,
      sections,
      // What is still missing, in tier order, so the screen can prompt rather
      // than leave someone guessing what a good newsletter contains.
      missing: SECTION_TYPES
        .filter(t => !t.assembled && !present.has(t.type))
        .map(t => ({ type: t.type, tier: t.tier, label: t.label, help: t.help })),
      has_ask: present.has('ask'),
      has_standing_block: present.has('standing_block'),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
