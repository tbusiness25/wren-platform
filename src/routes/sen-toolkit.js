'use strict';
// b256 (2026-09-01) — SEN early intervention toolkit, LIBRARY side.
//
// WHY THIS IS ITS OWN ROUTER AND NOT PART OF src/routes/sen.js
// Two reasons, and the second is the important one:
//
//  1. It is a library. There is no child in it. Everything here is generic
//     practice content that any member of staff should be able to read at the
//     moment they are worried about a child — which is the whole point of a
//     toolkit. Putting it behind sen.js's requireSenco/canAccessChild gates
//     would mean a practitioner had to be a SENCO to read a page about
//     Now/Next boards.
//
//  2. /api/sen is on server-unified.js's PARENT_DENY denylist WHOLESALE, by
//     design — the SEN register must never be parent-visible. Mixing library
//     content into that prefix means the library inherits the block, and the
//     next person who wants to show a family a strategy re-learns the b155
//     lesson the hard way. So: library here, child data in sen.js, and the
//     parent-facing path in parents.js. Three files, three audiences.
//
// /api/sen-toolkit is ALSO added to PARENT_DENY. That is deliberate belt-and-
// braces: nothing here would leak a child, but the sanctioned parent path is
// /api/parents/child/:childId/strategies, and having exactly one is what stops
// this drifting.
//
// The child→strategy link (ladn.sen_strategy_links) is NOT served from this
// file. It lives in sen.js. b256 §4: "the toolkit itself holds no child data".

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { requireCapabilityLevel, capabilityLevel } = require('../lib/capabilities');

router.use(authenticate);

// The four SEND Code of Practice broad areas — the same strings sen.js's
// SEND_AREAS uses, so a strategy and a SMART target file under one label.
const SEND_AREAS = ['Communication & Interaction', 'Cognition & Learning',
  'Social, Emotional & Mental Health', 'Sensory/Physical'];

// Curating the toolkit is the manager surface. Reading it is not gated at all
// beyond being signed in — see the header comment.
const requireCurator = requireCapabilityLevel('sen.toolkit', 'manage');

// A parent token can reach this router on the parents portal only if the
// PARENT_DENY entry is ever removed. Refuse anyway — cheap, and it means the
// file is correct on its own terms rather than only in one server's context.
router.use((req, res, next) => {
  if (req.user && req.user.role === 'parent') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});

const LIST_COLS = `id, slug, title, area, also_areas, summary, who_for, age_stage,
  prep_minutes, materials, licensed, licence_note, source_name, source_url, tags,
  curriculum_activity_id, planning_activity_id, resource_id, resource_path, sort_order`;

// ── GET /areas — the four areas with counts, for the landing screen ──────────
router.get('/areas', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT area, count(*)::int AS total,
             count(*) FILTER (WHERE licensed)::int AS licensed_count
      FROM sen_strategies WHERE is_active GROUP BY area
    `);
    const byArea = new Map(rows.map(r => [r.area, r]));
    res.json(SEND_AREAS.map(a => ({
      area: a,
      total: byArea.has(a) ? byArea.get(a).total : 0,
      licensed_count: byArea.has(a) ? byArea.get(a).licensed_count : 0,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /tags — the tag cloud, most-used first ──────────────────────────────
router.get('/tags', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT t AS tag, count(*)::int AS n
      FROM sen_strategies s, unnest(s.tags) t
      WHERE s.is_active GROUP BY t ORDER BY n DESC, t
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET / — the browsable list ──────────────────────────────────────────────
// ?area=  one of the four (exact string)
// ?q=     free text over title/summary/who_for/tags
// ?tag=   exact tag
// ?licensed=true|false
// ?include_retired=true  (curators only — everyone else always sees is_active)
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const where = [];
    const params = [];
    // Returns the placeholder for a value pushed onto params — every filter
    // below builds its own clause, because two of them need the SAME placeholder
    // twice and a naive one-clause-one-param helper cannot express that.
    const p = (val) => { params.push(val); return '$' + params.length; };

    // Retired entries are only listed for a curator. Nothing sensitive is in
    // them, but "retired" has to mean "gone from the browse list" for the
    // practitioner or retiring an entry accomplishes nothing.
    let showRetired = false;
    if (String(req.query.include_retired) === 'true') {
      showRetired = ['manage'].includes(await capabilityLevel(req.user, 'sen.toolkit'));
    }
    if (!showRetired) where.push('is_active');
    if (req.query.area) {
      if (!SEND_AREAS.includes(req.query.area)) {
        return res.status(400).json({ error: 'area must be one of: ' + SEND_AREAS.join(', ') });
      }
      // An entry filed under one area but tagged as also serving another shows
      // up under both — a Now/Next board is not only a communication tool.
      const i = p(req.query.area);
      where.push(`(area = ${i} OR ${i} = ANY(also_areas))`);
    }
    if (req.query.tag) where.push(`${p(req.query.tag)} = ANY(tags)`);
    if (req.query.licensed === 'true')  where.push('licensed');
    if (req.query.licensed === 'false') where.push('NOT licensed');
    // b404 — this used to ILIKE the WHOLE query as one literal substring.
    // That only ever matches a single word or a phrase quoted verbatim in
    // the text, so the toolkit's own suggested search "won't sit" returned
    // nothing: no entry contains the word "won't" anywhere (the library is
    // written in neutral third person — "who cannot sit still" — not as a
    // caregiver's complaint), so requiring the full phrase, or even just
    // the word "won't", as a substring was a dead end regardless of
    // apostrophe handling. Fix: split the query into words, normalise
    // curly vs straight apostrophes away on both sides, drop stopwords/
    // contractions that carry no topical signal (falling back to the raw
    // words if that would empty the list), and require each remaining
    // word as a whole word (regex \y boundaries, not a bare substring —
    // plain ILIKE '%sit%' also matches "position"/"transition"/"visit"
    // and drowns the result in noise) ANDed across title+tags+body. A
    // phrase now only has to share its content words with an entry, not
    // be quoted verbatim in it.
    if (req.query.q && String(req.query.q).trim()) {
      const STOPWORDS = new Set([
        'a', 'an', 'the', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'on', 'for',
        'and', 'or', 'it', 'its', 'this', 'that', 'my', 'i', 'me', 'will', 'wont',
        'dont', 'cant', 'isnt', 'arent', 'not', 'no', 'with', 'at', 'by', 'so', 'be',
        'has', 'have', 'had', 'does', 'doesnt', 'wouldnt', 'shouldnt',
      ]);
      const deapos = (s) => String(s).toLowerCase().replace(/[’']/g, '');
      const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rawWords = deapos(req.query.q).trim().split(/\s+/).filter(Boolean);
      const kept = rawWords.filter((w) => !STOPWORDS.has(w));
      const terms = kept.length ? kept : rawWords;
      // One expression, built once, reused per term — title+summary+who_for+
      // how_to+what_success_looks_like+when_to_escalate+tags, lower-cased,
      // apostrophes stripped so query-side and text-side normalise the same way.
      const SEARCHABLE = `replace(replace(lower(
          coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(who_for,'') || ' ' ||
          coalesce(how_to,'') || ' ' || coalesce(what_success_looks_like,'') || ' ' ||
          coalesce(when_to_escalate,'') || ' ' || array_to_string(tags,' ')
        ), '’', ''), '''', '')`;
      const clauses = terms.map((w) => `${SEARCHABLE} ~* ${p('\\y' + escapeRegex(w) + '\\y')}`);
      where.push('(' + clauses.join(' AND ') + ')');
    }

    const { rows } = await db.query(`
      SELECT ${LIST_COLS}, is_active
      FROM sen_strategies
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY area, sort_order, title
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /:slug — one complete entry, plus whatever Wren already holds for it ─
// b256 §1: "Where Wren already has a resource card, a phonics story or a
// curriculum_activities row that serves it, link to that rather than
// duplicating it." The link is resolved here so the client never has to know
// which of the three tables it landed in.
router.get('/:slug', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT * FROM sen_strategies WHERE slug = $1', [req.params.slug]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const s = rows[0];

    const linked = [];
    if (s.curriculum_activity_id) {
      const { rows: a } = await db.query(
        `SELECT id, name AS title, description, category, age_range, parent_tip
         FROM curriculum_activities WHERE id = $1`, [s.curriculum_activity_id]);
      if (a[0]) linked.push({ kind: 'curriculum_activity', href: '/ey/activities?id=' + a[0].id, ...a[0] });
    }
    if (s.planning_activity_id) {
      const { rows: a } = await db.query(
        `SELECT id, title, description, age_group, sen_adaptations
         FROM planning_activities WHERE id = $1`, [s.planning_activity_id]);
      if (a[0]) linked.push({ kind: 'planning_activity', href: '/ey/activities?plan=' + a[0].id, ...a[0] });
    }
    if (s.resource_id) {
      const { rows: a } = await db.query(
        'SELECT id, title, source_url, category FROM resources WHERE id = $1', [s.resource_id]);
      if (a[0]) linked.push({ kind: 'resource', href: a[0].source_url || null, ...a[0] });
    }
    if (s.resource_path) {
      linked.push({ kind: 'printable', title: s.title + ' — printable', href: s.resource_path });
    }
    // Sibling entries in the same area, so a practitioner who opened the wrong
    // one has somewhere to go that isn't Back.
    const { rows: siblings } = await db.query(
      `SELECT slug, title FROM sen_strategies
       WHERE area = $1 AND is_active AND id <> $2 ORDER BY sort_order, title LIMIT 6`,
      [s.area, s.id]);

    res.json({ ...s, linked, siblings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// Curation — the Roost manager view. Gated on sen.toolkit at 'manage'.
// ═══════════════════════════════════════════════════════════════════════════

const TEXT_FIELDS = ['title', 'summary', 'who_for', 'age_stage', 'how_to',
  'what_success_looks_like', 'when_to_escalate', 'licence_note', 'source_name',
  'source_url', 'resource_path'];
const ARRAY_FIELDS = ['also_areas', 'materials', 'tags'];
const INT_FIELDS = ['prep_minutes', 'curriculum_activity_id', 'planning_activity_id',
  'resource_id', 'sort_order'];

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

// POST / — add an entry
router.post('/', requireCurator, async (req, res) => {
  const b = req.body || {};
  if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'title required' });
  if (!SEND_AREAS.includes(b.area)) return res.status(400).json({ error: 'area must be one of: ' + SEND_AREAS.join(', ') });
  for (const f of ['summary', 'who_for', 'how_to', 'what_success_looks_like', 'when_to_escalate']) {
    if (!b[f] || !String(b[f]).trim()) return res.status(400).json({ error: `${f} required` });
  }
  // b256 §1 — a licensed entry MUST say what the restriction is. This is the
  // rule that stops a trademarked scheme being written up as if it were free.
  if (b.licensed && !(b.licence_note && String(b.licence_note).trim())) {
    return res.status(400).json({ error: 'licence_note is required when licensed is true' });
  }
  const slug = slugify(b.slug || b.title);
  if (!slug) return res.status(400).json({ error: 'could not derive a slug from the title' });
  try {
    const { rows } = await getPool().query(`
      INSERT INTO sen_strategies
        (slug,title,area,also_areas,summary,who_for,age_stage,how_to,what_success_looks_like,
         when_to_escalate,prep_minutes,materials,licensed,licence_note,source_name,source_url,
         tags,curriculum_activity_id,planning_activity_id,resource_id,resource_path,sort_order,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
      RETURNING *
    `, [slug, String(b.title).trim(), b.area, b.also_areas || [], b.summary, b.who_for,
        b.age_stage || null, b.how_to, b.what_success_looks_like, b.when_to_escalate,
        b.prep_minutes == null ? null : Number(b.prep_minutes), b.materials || [],
        !!b.licensed, b.licence_note || null, b.source_name || null, b.source_url || null,
        b.tags || [], b.curriculum_activity_id || null, b.planning_activity_id || null,
        b.resource_id || null, b.resource_path || null,
        b.sort_order == null ? 100 : Number(b.sort_order), req.user.id]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A strategy with that name already exists' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id — edit an entry
router.put('/:id', requireCurator, async (req, res) => {
  const b = req.body || {};
  if (b.area !== undefined && !SEND_AREAS.includes(b.area)) {
    return res.status(400).json({ error: 'area must be one of: ' + SEND_AREAS.join(', ') });
  }
  try {
    const db = getPool();
    const { rows: cur } = await db.query('SELECT * FROM sen_strategies WHERE id = $1', [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Not found' });

    // Same rule as POST, evaluated against the RESULTING row: you cannot flip an
    // entry to licensed and leave the note behind, nor blank the note on one
    // that is already licensed.
    const willBeLicensed = b.licensed === undefined ? cur[0].licensed : !!b.licensed;
    const willHaveNote = b.licence_note === undefined
      ? !!(cur[0].licence_note && cur[0].licence_note.trim())
      : !!(b.licence_note && String(b.licence_note).trim());
    if (willBeLicensed && !willHaveNote) {
      return res.status(400).json({ error: 'licence_note is required when licensed is true' });
    }

    const updates = [], params = []; let pi = 1;
    const add = (col, val) => { if (val !== undefined) { updates.push(`${col}=$${pi++}`); params.push(val); } };
    add('area', b.area);
    TEXT_FIELDS.forEach(f => add(f, b[f]));
    ARRAY_FIELDS.forEach(f => add(f, b[f]));
    INT_FIELDS.forEach(f => add(f, b[f] === undefined ? undefined : (b[f] === null || b[f] === '' ? null : Number(b[f]))));
    if (b.licensed !== undefined) add('licensed', !!b.licensed);
    if (b.is_active !== undefined) add('is_active', !!b.is_active);
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    updates.push('updated_at=NOW()');
    params.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE sen_strategies SET ${updates.join(',')} WHERE id=$${pi} RETURNING *`, params);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /:id/active — retire or restore. Never a DELETE: a strategy may be
// attached to a child's live plan, and removing it would take the record of
// "what we tried" with it.
router.patch('/:id/active', requireCurator, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'UPDATE sen_strategies SET is_active=$1, updated_at=NOW() WHERE id=$2 RETURNING id, slug, title, is_active',
      [!!req.body.is_active, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /admin/usage — the manager view's one piece of real information: which
// strategies are actually being reached for, and which have never been used.
// COUNTS ONLY — no child_id, no child name, ever. (Same rule as the b-series
// build logs: this endpoint would be the obvious place to leak a roster.)
router.get('/admin/usage', requireCurator, async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT s.id, s.slug, s.title, s.area, s.licensed, s.is_active,
             count(l.id)::int                                    AS times_attached,
             count(DISTINCT l.child_id)::int                     AS children,
             count(*) FILTER (WHERE l.status='working')::int     AS reported_working,
             count(*) FILTER (WHERE l.status='not_working')::int AS reported_not_working,
             max(l.created_at)                                   AS last_attached_at
      FROM sen_strategies s
      LEFT JOIN sen_strategy_links l ON l.strategy_id = s.id
      GROUP BY s.id
      ORDER BY count(l.id) DESC, s.area, s.sort_order
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
