'use strict';
/* ═══════════════════════════════════════════════════════════════════════════════
 * observation-review.js — b536 (2026-10-29) — mounted at /api/observation-review
 *
 * Toby, 29 Oct 2026: "Build an observation reviewer in Roost where I can just add
 * filters so I can choose the date range, I can choose the areas of learning, like
 * all those filters that were in e-log. And allow me to export as PDF, with an
 * additional anonymised button just in case."
 *
 * The night before, a one-off script made an anonymised INSET sample of 42
 * observations. This is that script made permanent and filterable: the same
 * anonymiser (src/lib/observation-review-redact.js), a real filter set, and two
 * buttons instead of a cron-less node invocation.
 *
 * ── WHY A NEW ROUTER AND NOT src/routes/observations.js ──────────────────────
 * Two reasons, and the second is the real one:
 *   1. observations.js is 3,600 lines and carries an unshipped staff-app change
 *      on the dev tree. Appending a reviewer to it would entangle the two.
 *   2. This router is READ ONLY — it contains no INSERT, UPDATE or DELETE
 *      against observations, and that is a property worth being able to state
 *      about a whole file rather than about a handful of handlers inside one.
 *      The only write anywhere here is the audit row every export leaves.
 *
 * ── GATING ───────────────────────────────────────────────────────────────────
 * authenticate → the Roost (admin) portal → role manager / deputy_manager /
 * admin / owner. Both gates are server-side and checked before anything is read.
 * A request with no portal is REFUSED rather than defaulted: failing open on a
 * bulk reader of every child's developmental record is not a trade-off worth
 * making. Same shape as lookback.js and security-hub.js.
 *
 * No capability is added on top. b505 established that requireCapability() over
 * a route which is already manager-gated changes nothing — hasCapability() gives
 * a manager a blanket pass unless the key is in MATRIX_REQUIRED_CAPS — so a
 * Permissions switch here would switch nothing, which is the exact lie b237
 * exists to stop that screen telling.
 *
 * On top of this file: 'observation-review' is on PARENT_DENY and on
 * ROOST_ONLY_PREFIXES in editions/ladn/server-unified.js, and is deliberately
 * ABSENT from HR_ALLOW (the HR guard became an allow-list in b491, so an unnamed
 * segment is refused rather than open).
 *
 * ── dsl_only ─────────────────────────────────────────────────────────────────
 * A safeguarding-only observation is excluded unless the signed-in person is the
 * DSL or deputy DSL — staff.is_dsl / is_deputy_dsl, read through the existing
 * src/lib/ey-inbox-permissions.js dslFlags() cache. Being a manager is NOT
 * enough on its own: unlike the EY inbox (where canSeeSafeguarding() gives a
 * manager a pass), a dsl_only observation is written precisely so that it stays
 * out of the general record, and a 500-row PDF is the last place to widen that.
 * In practice Toby is both, so this changes nothing for him and everything for a
 * deputy who is not the deputy DSL.
 *
 * ── GDPR ─────────────────────────────────────────────────────────────────────
 * This router hands real child data to the Roost client, which is its job. The
 * controls that matter are:
 *   · every export writes an audit row (who, the filters, the count, anonymised
 *     yes/no, photos yes/no) — an export of child data is a GDPR event;
 *   · an anonymised export is refused outright (409) if the leak scan finds any
 *     known name still in the text, with a COUNT and never the words;
 *   · the anonymised branch cannot be made to emit a photograph: the flag is
 *     dropped before the renderer sees it, and the renderer drops it again;
 *   · nothing in this file console.logs observation text, a child name or a
 *     staff name. Errors are logged with ids and messages only.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const express = require('express');
const router = express.Router();

const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');

const Q = require('../lib/observation-review-query');
const RD = require('../lib/observation-review-redact');
const PDF = require('../lib/observation-review-pdf');
const { dslFlags } = require('../lib/ey-inbox-permissions');

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'owner'];

// The hard ceiling on one export. 500 A4 cards is already a 200-page document;
// past that the browser download, the memory and the reader all give up, and
// "narrow the filters" is the right answer rather than a longer wait.
const EXPORT_CAP = 500;
const PAGE_MAX = 100;

// ── the guard ────────────────────────────────────────────────────────────────
function managerRoostOnly(req, res, next) {
  if ((req._portal || null) !== 'admin') {
    return res.status(403).json({
      error: 'forbidden_portal',
      message: 'The observation reviewer is available on the Roost (admin) portal only.',
    });
  }
  const role = req.user && req.user.role;
  if (!req.user || !MANAGER_ROLES.includes(role)) {
    return res.status(403).json({
      error: 'forbidden_role',
      message: 'Manager access only — the reviewer reads every child’s observations.',
    });
  }
  next();
}
const guard = [authenticate, managerRoostOnly];

// ── shared setup for every request ───────────────────────────────────────────
async function defaultFramework(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'default_framework'`);
    const v = rows[0] && rows[0].value;
    return v || 'birth_to_5_la';
  } catch (_) { return 'birth_to_5_la'; }
}

async function settingName(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key IN ('setting_name','nursery_name') ORDER BY key LIMIT 1`);
    return (rows[0] && rows[0].value) || 'Your Nursery';
  } catch (_) { return 'Your Nursery'; }
}

/**
 * Everything a handler needs, resolved once: the framework, the tracker's age
 * bands, the date window, the parsed filters and whether this viewer may see
 * dsl_only rows.
 */
async function context(req) {
  const db = getPool();
  const framework = String(req.query.framework || '') || await defaultFramework(db);
  const { bands, derived } = await Q.ageBands(db, framework);
  const win = await Q.resolveWindow(db, req.query);
  const filters = Q.parseFilters(req.query, bands);

  let includeDsl = false;
  try {
    const f = await dslFlags(db, Number(req.user.id));
    includeDsl = !!(f.is_dsl || f.is_deputy_dsl);
  } catch (_) { includeDsl = false; }   // fail closed

  return { db, framework, bands, bandsDerived: derived, win, filters, includeDsl };
}

/* A filter that silently does not filter is the one failure mode this build
 * cannot have (b536-verify caught it: the canonical area key contains a comma,
 * so a comma-separated `areas` arrived as two unfoldable halves and every row
 * came back). Both handlers call this before they read anything. */
function badFilter(ctx, res) {
  if (ctx.filters.areas_unmatched) {
    res.status(400).json({
      error: 'unknown_area',
      message: 'None of the areas of learning asked for were recognised, so nothing was returned rather than '
        + 'everything. Use the slugs from /options: cl, psed, pd, literacy, mathematics, utw, ead.',
    });
    return true;
  }
  return false;
}

/**
 * One plain-English line per active filter, for the PDF cover and the UI chips.
 *
 * ⚠ `anonymised` is not a nicety. b536-verify caught the anonymised export
 * printing "Children: B536 Testchild, B536 Secondchild" on its COVER — the
 * document body was clean and the filter summary above it named every child the
 * filter had picked, which is the one thing an anonymised export exists to
 * prevent. On that branch every identifying line becomes a count, and the
 * free-text search (which can itself be the name someone searched for) becomes
 * the bare fact that one was used.
 */
function describeFilters(filters, bands, opts, anonymised) {
  const o = opts || {};
  const out = [];
  const name = (list, id) => {
    const hit = (list || []).find(r => Number(r.id) === Number(id));
    return hit ? hit.name : '#' + id;
  };
  const people = (label, ids, list) => {
    if (!ids.length) return;
    out.push(anonymised
      ? `${label}: ${ids.length} selected`
      : `${label}: ${ids.map(i => name(list, i)).join(', ')}`);
  };
  people('Children', filters.child_ids, o.children);
  people('Rooms', filters.room_ids, o.rooms);
  people('Key person', filters.key_person_ids, o.staff);
  people('Practitioners', filters.staff_ids, o.staff);
  if (filters.author_names.length) {
    out.push(anonymised
      ? `Recorded authors: ${filters.author_names.length} selected`
      : `Recorded authors: ${filters.author_names.join(', ')}`);
  }
  if (filters.areas.length) {
    out.push('Areas of learning: ' + filters.areas
      .map(k => (Q.areaList().find(a => a.key === k) || { label: k }).label).join(', '));
  }
  if (filters.other_area) out.push('Includes tags outside the seven areas');
  if (filters.no_area) out.push('Includes observations with no area tagged');
  if (filters.age_bands.length) {
    out.push('Age at the observation: ' + filters.age_bands
      .map(ord => (bands.find(b => b.ordinal === ord) || { label: 'Range ' + ord }).label).join(', '));
  }
  if (filters.statement_ids.length) out.push(`${filters.statement_ids.length} framework statement(s)`);
  if (filters.coel.length) out.push('Characteristics of Effective Learning: ' + filters.coel.join(', '));
  if (filters.tags.length) out.push('Tags: ' + filters.tags.map(Q.tagLabel).join(', '));
  if (filters.types.length) out.push('Type: ' + filters.types.map(t => PDF.TYPE_LABELS[t] || t).join(', '));
  if (filters.flags.length) out.push('Flagged: ' + filters.flags.map(f => f.replace(/_/g, ' ')).join(', '));
  if (filters.shared !== null) out.push(filters.shared ? 'Shared with parents' : 'Not shared with parents');
  if (filters.review_status.length) out.push('Review status: ' + filters.review_status.join(', '));
  if (filters.has_analysis !== null) out.push(filters.has_analysis ? 'Has "what it shows"' : 'No "what it shows"');
  if (filters.has_next_steps !== null) out.push(filters.has_next_steps ? 'Has next steps' : 'No next steps');
  if (filters.has_photos !== null) out.push(filters.has_photos ? 'Has photos or media' : 'No photos or media');
  if (filters.source) out.push(filters.source === 'eylog' ? 'EyLog imports only' : 'Written in Wren only');
  if (filters.group_mode === 'per_group') out.push('Group observations shown once');
  if (filters.q) out.push(anonymised ? 'A text search was used' : `Text contains “${filters.q}”`);
  return out;
}

// ── GET /options — the picker lists ──────────────────────────────────────────
router.get('/options', guard, async (req, res) => {
  try {
    const db = getPool();
    const framework = String(req.query.framework || '') || await defaultFramework(db);
    const { bands, derived } = await Q.ageBands(db, framework);
    const opts = await Q.options(db, framework);
    res.json(Object.assign(opts, {
      framework, age_bands: bands, age_bands_from_tracker: derived,
      export_cap: EXPORT_CAP, page_max: PAGE_MAX,
    }));
  } catch (e) {
    console.error('[observation-review] options:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET /windows — what each date preset resolves to ─────────────────────────
router.get('/windows', guard, async (req, res) => {
  try {
    const db = getPool();
    const out = {};
    for (const p of Q.PRESETS) {
      if (p === 'custom') continue;
      out[p] = await Q.resolveWindow(db, { preset: p });
    }
    res.json({ presets: out });
  } catch (e) {
    console.error('[observation-review] windows:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET / — the filtered list, the total and the facet counts ────────────────
router.get('/', guard, async (req, res) => {
  const t0 = Date.now();
  try {
    const ctx = await context(req);
    if (badFilter(ctx, res)) return;
    const pageSize = Math.min(PAGE_MAX, Math.max(1, parseInt(req.query.page_size, 10) || 25));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const { total, rows } = await Q.listRows(ctx.db, {
      filters: ctx.filters, win: ctx.win, bands: ctx.bands, includeDsl: ctx.includeDsl,
      limit: pageSize, offset: (page - 1) * pageSize,
    });

    let fac = null;
    if (req.query.facets !== '0') {
      try { fac = await Q.facets(ctx.db, ctx); }
      catch (e) { console.error('[observation-review] facets:', e.message); }
    }

    res.json({
      total, page, page_size: pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
      window: ctx.win,
      framework: ctx.framework,
      age_bands: ctx.bands,
      age_bands_from_tracker: ctx.bandsDerived,
      dsl_included: ctx.includeDsl,
      export_cap: EXPORT_CAP,
      facets: fac,
      filter_summary: describeFilters(ctx.filters, ctx.bands, {}),
      rows: rows.map(r => ({
        id: r.id,
        child_id: r.child_id,
        child_name: [r.child_first_name, r.child_last_name].filter(Boolean).join(' ').trim() || null,
        child_preferred_name: r.child_preferred_name,
        age_months: r.age_months,
        age_text: RD.ageText(r.age_months),
        date: r.created_at,
        author: r.author,
        staff_id: r.staff_id,
        room_id: r.room_id,
        key_person_id: r.key_person_id,
        observation_type: r.observation_type,
        title: r.title,
        areas: [...new Set((r.eyfs_areas || []).map(a => {
          const c = Q.canonOf(a); return c ? c.label : String(a);
        }))],
        raw_areas: r.eyfs_areas || [],
        obs_tags: r.obs_tags || [],
        statements: (r.statements || []).map(s => ({
          statement_id: s.statement_id, framework: s.framework, code: s.statement_code,
          area: s.area, aspect: s.aspect, age_range: s.age_range,
          text: s.statement_text, coel: s.coel_characteristic, coel_level: s.coel_level,
          is_next_step: s.is_next_step,
        })),
        baseline: r.baseline, termly_update: r.termly_update, parental: r.parental,
        planned_activity: r.planned_activity,
        shared_with_parents: r.shared_with_parents, review_status: r.review_status,
        from_eylog: r.from_eylog,
        photo_count: r.photo_count,
        group_uuid: r.group_uuid, group_size: r.group_size,
        observation_text: RD.plain(r.observation_text, false),
        analysis: RD.plain(r.analysis, false),
        next_steps: RD.plain(r.next_steps, false),
      })),
      ms: Date.now() - t0,
    });
  } catch (e) {
    console.error('[observation-review] list:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET /pdf — the two exports ───────────────────────────────────────────────
router.get('/pdf', guard, async (req, res) => {
  const anonymised = req.query.anonymised === '1' || req.query.anonymised === 'true';
  // Photos are impossible on the anonymised branch — dropped here as well as in
  // the renderer, so neither layer is the only thing standing between a request
  // and an image of a child in a document that claims to be anonymous.
  const photos = !anonymised && (req.query.photos === '1' || req.query.photos === 'true');

  try {
    const ctx = await context(req);
    if (badFilter(ctx, res)) return;
    const { total, rows } = await Q.listRows(ctx.db, {
      filters: ctx.filters, win: ctx.win, bands: ctx.bands, includeDsl: ctx.includeDsl,
      limit: EXPORT_CAP, offset: 0, noLimit: true,
    });

    const opts = await Q.options(ctx.db, ctx.framework).catch(() => ({}));
    // Two summaries, deliberately: the one PRINTED on an anonymised cover carries
    // counts, and the one written to the AUDIT LOG always carries the real names.
    // An audit row that cannot say which children were exported is not an audit row.
    const filterLines = describeFilters(ctx.filters, ctx.bands, opts, anonymised);
    const auditLines = anonymised ? describeFilters(ctx.filters, ctx.bands, opts, false) : filterLines;
    const name = await settingName(ctx.db);

    let red = null;
    if (anonymised) {
      const sets = await RD.loadExtendedSets(ctx.db);
      red = RD.exportRedactor(sets);
    }

    const buf = await PDF.renderObservationPdf(rows, {
      anonymised, photos, red,
      canonOf: Q.canonOf,
      settingName: name,
      windowLabel: `${ctx.win.label}${ctx.win.from ? ` · ${ctx.win.from} to ${ctx.win.to || 'today'}` : ''}`,
      filterLines,
      capped: total > rows.length,
    });

    /* THE REFUSAL. The document is fully rendered into a buffer and NOTHING has
     * been written to the response yet, so the leak scan the anonymiser
     * accumulated over every field can still stop it. A count goes back, never
     * the words — the words are children's names. */
    if (anonymised && red && red.leakCount > 0) {
      console.error(`[observation-review] anonymised export refused: ${red.leakCount} known name(s) survived over ${rows.length} rows`);
      recordAudit({
        req, action: 'export', entity_type: 'observation',
        meta: {
          build: 'b536', surface: 'observation-review', outcome: 'refused_leak',
          anonymised: true, photos: false, count: rows.length,
          leak_count: red.leakCount, filters: auditLines, window: ctx.win,
        },
      }).catch(() => {});
      return res.status(409).json({
        error: 'anonymisation_incomplete',
        leak_count: red.leakCount,
        message: `The anonymised export was not sent: ${red.leakCount} name${red.leakCount === 1 ? '' : 's'} Wren knows about `
          + 'were still in the text after redaction, so the document was thrown away rather than downloaded. '
          + 'Narrow the filters and try again, and tell Toby which filter did it.',
      });
    }

    recordAudit({
      req, action: 'export', entity_type: 'observation',
      meta: {
        build: 'b536', surface: 'observation-review', outcome: 'sent',
        anonymised, photos, count: rows.length, total_matching: total,
        capped: total > rows.length,
        window: ctx.win, filters: auditLines,
        dsl_included: ctx.includeDsl,
        unknown_caps_blanked: anonymised && red ? red.unknownCapCount : null,
        children_in_export: anonymised && red ? red.childCount : null,
        bytes: buf.length,
      },
    }).catch(() => {});

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${PDF.pdfFilename({ anonymised })}"`);
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Wren-Export-Count', String(rows.length));
    res.setHeader('X-Wren-Export-Total', String(total));
    if (anonymised && red) res.setHeader('X-Wren-Anon-Children', String(red.childCount));
    res.end(buf);
  } catch (e) {
    console.error('[observation-review] pdf:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal error', message: 'The export could not be built.' });
  }
});

module.exports = router;
