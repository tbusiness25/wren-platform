'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b285 — publishing a policy, and making every surface show the new text.
//
// Toby: "add a terms and conditions reviewer, so that when we update them there
// it automatically updates everywhere else it is".
//
// FOUR OF THE FIVE SURFACES NEED NOTHING DOING TO THEM. The parents portal
// (/welcome/policies), the enrolment form (GET /onboard/child), the parent guide
// and the fees page all read ladn.policies on the request — the guide and the
// fees page through GET /api/public/terms, added by this build precisely so they
// could stop holding their own copy of the closures rule. Publishing a new
// version is therefore already live on all four the moment the row is written.
// They are still listed in the report, because "nothing to do" is only reassuring
// if the manager can see it was checked.
//
// THE PUBLIC WEBSITE IS THE ONE THAT NEEDS WORK. example-nursery.co.uk is a
// static index.html served by the `nursery-website` nginx container out of
// /opt/site-manager/data/sites/www, which cannot query Postgres. So the clause
// accordion is REGENERATED from the database into that file, between two
// markers, as part of the publish — not on a cron. A nightly job would leave the
// website wrong for up to a day after an edit, which is exactly the failure this
// build exists to remove.
//
// ── WHY THE TARGET DIRECTORY IS NOT DEFAULTED ────────────────────────────────
// ⚠️ BOTH wren-ladn AND wren-ladn-dev bind-mount the LIVE public site read-write
// at /app/website-live (verified with `docker inspect`, 2026-09-08). A default of
// WEBSITE_LIVE_DIR would mean a publish on the DEV container rewrites the real
// nursery website. So the directory comes from settings.terms_site_dir (or the
// TERMS_SITE_DIR env var) and there is NO fallback: unset means the surface is
// reported as not configured and nothing is written. The reviewer shows the
// value and lets a manager set it once.
//
// ── WHAT A WRITE DOES ────────────────────────────────────────────────────────
// Read → check the markers exist → splice → if unchanged, stop → timestamped
// .bak of the file being replaced → write a temp file → atomic rename. It never
// deletes a site file and never creates index.html from nothing. Same posture as
// src/routes/website-builder.js, which is the other thing in Wren allowed to
// touch that directory.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const termsDoc = require('./terms-doc');

const BEGIN = '<!-- WREN:TERMS:BEGIN — generated from ladn.policies by Wren. Do not edit by hand; edit the Terms & Conditions in Roost and press Publish. -->';
const END = '<!-- WREN:TERMS:END -->';
// Marker recognition is deliberately looser than the marker we write, so a file
// whose comment text was reflowed by an editor is still recognised.
const BEGIN_RE = /<!--\s*WREN:TERMS:BEGIN[\s\S]*?-->/;
const END_RE = /<!--\s*WREN:TERMS:END\s*-->/;

const TERMS_TITLE = 'Terms and Conditions';

/** Is this policy the one the public website and the enrolment gate render? */
const isTerms = policy => String(policy && policy.title || '').trim().toLowerCase() === TERMS_TITLE.toLowerCase();

// ── where the site lives ──────────────────────────────────────────────────────

/**
 * Resolve the public-site directory. settings first so a manager can set it from
 * the reviewer without a container restart; env second for a deployment that
 * would rather pin it; null (disabled) last. NEVER falls back to
 * WEBSITE_LIVE_DIR — see the header.
 */
async function siteDir(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'terms_site_dir'`);
    const v = (rows[0] && rows[0].value || '').trim();
    if (v) return v;
  } catch (e) {
    // A tenant whose settings table is missing must still be able to publish.
    console.error('[terms-publish] settings lookup failed:', e.message);
  }
  const env = (process.env.TERMS_SITE_DIR || '').trim();
  return env || null;
}

// ── the markers ───────────────────────────────────────────────────────────────

/**
 * Find the run of `<div class="accordion">…</div>` blocks inside
 * `<section id="terms">`, by walking div open/close tags rather than by
 * regex — the clause bodies contain nested divs and `</div>` strings, and a
 * greedy or lazy match would cut the block in the wrong place.
 * @returns {{start:number, end:number}|null} indices into `html`
 */
function findAccordionBlock(html) {
  const secAt = html.search(/<section\b[^>]*\bid=["']terms["']/i);
  if (secAt < 0) return null;
  const secEnd = html.indexOf('</section>', secAt);
  if (secEnd < 0) return null;

  const OPEN = /<div\b/gi, CLOSE = /<\/div>/gi;
  const first = html.indexOf('<div class="accordion">', secAt);
  if (first < 0 || first > secEnd) return null;

  let cursor = first;
  let lastEnd = -1;
  // Walk one accordion at a time; stop when the next thing is not another one.
  while (cursor >= 0 && cursor < secEnd && html.startsWith('<div class="accordion">', cursor)) {
    let depth = 0, i = cursor, end = -1;
    while (i < secEnd) {
      OPEN.lastIndex = i; CLOSE.lastIndex = i;
      const o = OPEN.exec(html), c = CLOSE.exec(html);
      const oAt = o && o.index <= secEnd ? o.index : Infinity;
      const cAt = c && c.index <= secEnd ? c.index : Infinity;
      if (oAt === Infinity && cAt === Infinity) break;
      if (oAt < cAt) { depth++; i = oAt + 4; }
      else {
        depth--; i = cAt + 6;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) break;
    lastEnd = end;
    const nextAt = html.indexOf('<div class="accordion">', end);
    const between = nextAt < 0 ? '' : html.slice(end, nextAt);
    cursor = (nextAt > 0 && nextAt < secEnd && /^\s*$/.test(between)) ? nextAt : -1;
  }
  return lastEnd > first ? { start: first, end: lastEnd } : null;
}

/**
 * Put the markers around the existing clause block, once. Idempotent: a file
 * that already has them comes back unchanged. This is a STRUCTURAL edit — it
 * moves no text and changes no wording — so it is safe to run against the live
 * site before the first publish.
 * @returns {{html:string, inserted:boolean, reason?:string}}
 */
function ensureMarkers(html) {
  if (BEGIN_RE.test(html) && END_RE.test(html)) return { html, inserted: false, reason: 'already present' };
  const block = findAccordionBlock(html);
  if (!block) return { html, inserted: false, reason: 'no <section id="terms"> accordion block found' };
  const out = html.slice(0, block.start)
    + BEGIN + '\n' + html.slice(block.start, block.end) + '\n      ' + END
    + html.slice(block.end);
  return { html: out, inserted: true };
}

/** Replace whatever is between the markers with `fragment`. */
function injectFragment(html, fragment) {
  const b = html.match(BEGIN_RE), e = html.match(END_RE);
  if (!b || !e) return null;
  const bAt = b.index, eAt = e.index;
  if (eAt < bAt) return null;
  return html.slice(0, bAt) + BEGIN + '\n' + fragment.replace(/\s*$/, '') + '\n      ' + END
    + html.slice(eAt + e[0].length);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/**
 * Write the fragment into <dir>/index.html.
 * @returns {{status:string, detail:string, file?:string, backup?:string, bytes?:number}}
 */
function writeSite(dir, fragment) {
  const file = path.join(dir, 'index.html');
  let before;
  try { before = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { status: 'error', detail: `could not read ${file}: ${e.message}` }; }

  const after = injectFragment(before, fragment);
  if (after == null) {
    return {
      status: 'error', file,
      detail: 'the WREN:TERMS markers are not in this file. Run '
            + '`node scripts/b285/prepare-public-site.js --dir ' + dir + '` once; it wraps the '
            + 'clauses that are already there and changes no wording.',
    };
  }
  if (after === before) return { status: 'unchanged', file, detail: 'already showing this version', bytes: after.length };

  const backup = file + '.bak-b285-' + stamp();
  const tmp = path.join(dir, '.index.html.b285-' + process.pid);
  try {
    fs.copyFileSync(file, backup);
    fs.writeFileSync(tmp, after, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { status: 'error', file, detail: e.message };
  }
  return { status: 'updated', file, backup, bytes: after.length, detail: 'clause accordion regenerated from the database' };
}

/**
 * Everything a publish has to reach, and what happened to each.
 *
 * `policy` is the row as it now stands in ladn.policies. The report is stored on
 * the policy_versions row and shown back to the manager, so "which surfaces were
 * updated" is answerable later and not only in the moment.
 */
async function propagate(db, policy) {
  const surfaces = [];
  const terms = isTerms(policy);

  // 1. the public website — the only surface that holds a copy
  if (terms) {
    const dir = await siteDir(db);
    if (!dir) {
      surfaces.push({
        id: 'public-website', label: 'Public website — the Terms & Conditions accordion',
        status: 'not_configured',
        detail: 'No public-site directory is set, so nothing was written. Set it in the reviewer '
              + '(Publishing targets) to the directory the website is served from.',
      });
    } else {
      const fragment = termsDoc.accordionHtml(policy.content, {
        version: policy.version, version_label: policy.version_label,
        effective_date: policy.effective_date
          ? new Date(policy.effective_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
          : null,
      });
      const r = writeSite(dir, fragment);
      surfaces.push(Object.assign({
        id: 'public-website', label: 'Public website — the Terms & Conditions accordion',
      }, r));
    }
  }

  // 2..n — the surfaces that read the database on the request. Nothing to write;
  // the point of listing them is that the manager can see the whole set.
  if (terms) {
    surfaces.push({
      id: 'enrolment-form', label: 'Enrolment form — /onboard/child',
      status: 'live', detail: 'Embeds the full text and requires acceptance; read from the database per request.',
    });
    surfaces.push({
      id: 'parent-guide', label: 'Parent guide — /welcome/about/guide',
      status: 'live', detail: 'Renders the closures section through /api/public/terms.',
    });
    surfaces.push({
      id: 'parent-fees', label: 'Fees page — /welcome/fees',
      status: 'live', detail: 'Renders the closures section through /api/public/terms.',
    });
  }
  if (policy.parent_facing) {
    surfaces.push({
      id: 'parent-policies', label: 'Parents portal — /welcome/policies',
      status: 'live',
      detail: policy.requires_parent_signature
        ? 'Listed for reading and signing. This version supersedes every earlier signature.'
        : 'Listed for reading.',
    });
  }
  surfaces.push({
    id: 'staff-policies', label: 'Staff — EY /ey/policies and Roost',
    status: 'live', detail: 'Read from the database per request, in the setting\'s policy order.',
  });

  return surfaces;
}

module.exports = {
  BEGIN, END, BEGIN_RE, END_RE, TERMS_TITLE, isTerms,
  siteDir, findAccordionBlock, ensureMarkers, injectFragment, writeSite, propagate,
};
