'use strict';
// b425 — The Reading Room catalogue service.
//
// Unions existing content sources into one row shape. Reads only — every write
// still goes through that source's own editor (policies-workspace, handbook.html,
// the courses builder, etc). The only NEW data this file ever writes is
// reading_item_meta (areas/audiences/review_date/pinned/needs_review set by a
// manager) and reading_documents (the one new upload store). A source table
// that doesn't exist on a given tenant (42P01) is skipped, not fatal — same rule
// b352's collectors use, because this runs on every tenant, not just LADN.
const { getPool } = require('../db/pool');

const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';

const AREAS = [
  ['safeguarding', 'Safeguarding'],
  ['daily-rhythm', 'Daily Rhythm'],
  ['curriculum-assessment', 'Curriculum & Assessment'],
  ['parent-communication', 'Parent Communication'],
  ['admissions', 'Admissions'],
  ['money', 'Income & fees'],
  ['staffing-hr', 'Staffing & HR'],
  ['training-cpd', 'Training & CPD'],
  ['kitchen-food', 'Kitchen & Food'],
  ['health-safety-premises', 'Health, Safety & Premises'],
  ['compliance-ofsted', 'Compliance & Ofsted'],
  ['systems-it', 'Systems & IT'],
];

// Keyword → area guess, used only as a DEFAULT before a manager sets one
// explicitly via reading_item_meta. Order matters — first match wins.
const AREA_GUESS = [
  [/safeguard|child protection|allegation|whistleblow/i, 'safeguarding'],
  [/nappy|sleep|bottle|toilet|intimate care|key person|settling/i, 'daily-rhythm'],
  [/eyfs|curriculum|observation|assessment|planning|phonics|sen\b/i, 'curriculum-assessment'],
  [/parent|newsletter|complaint/i, 'parent-communication'],
  [/admission|waiting list|enquir|starter|fee/i, 'admissions'],
  [/invoice|funding|payment|finance|payroll|wage/i, 'money'],
  [/staff|hr\b|recruit|supervision|disciplin|absence|rota/i, 'staffing-hr'],
  [/cpd|training|induction|course/i, 'training-cpd'],
  [/menu|food|allerg|kitchen|cooking/i, 'kitchen-food'],
  [/fire|health and safety|h&s|premises|risk assessment|accident|first aid/i, 'health-safety-premises'],
  [/ofsted|inspection|complian|gdpr|data protection|regulat/i, 'compliance-ofsted'],
  [/it\b|system|password|device|network/i, 'systems-it'],
];

function guessArea(...text) {
  const s = text.filter(Boolean).join(' ');
  for (const [re, area] of AREA_GUESS) if (re.test(s)) return area;
  return null;
}

// ── b519: where did this come from, and is what you are looking at the whole thing? ─────────
// Toby, on a one-chapter item: "I can't click to open the file. Is that the whole thing? … I
// just wanted to make sure I'm not missing anything." Every adapter below now answers both
// questions in the same two fields, so the reader never has to guess:
//
//   provenance = { kind, label, detail, path, open: { url, how, label } | null }
//   extent     = { full: bool, label: '<one sentence>', chars }
//
// `provenance.open.how` tells the client HOW to open it, because the three cases genuinely
// differ: 'tab' is an ordinary link (an external article, a Wren page), 'blob' needs the
// fetch-with-Bearer dance (a stored file behind /api/library/documents/:id/file — an <a href>
// carries no token, reference_iframe_src_has_no_bearer), and 'inline' means the full text is
// already in the pane and there is nothing else to open.
//
// NOTE: `item.origin` was already taken by b426 (a reading_document's import provenance, the
// string 'upload'|'drive_import'|…) and is left exactly as it was — hence `provenance`.
const WREN_DOCS_ROOT = '/app-docs';

// Folders whose files "Also delete the file" must never touch, per the brief: the decision
// log, the Manager's Bible and the policies are the documents the nursery is run from. cse/
// (Cyber Essentials) and bus-manual/ are here because b352/b427 already treat them as
// off-limits. Checked here, again in the route, and a THIRD time in the host script that
// does the move — the same path can arrive by three routes and each one refuses it.
const PROTECTED_DOC_DIRS = ['decisions', 'managers-bible', 'policies', 'cse', 'bus-manual', '_deleted'];
const PROTECTED_DOC_FILES = [/^the-managers-bible\.md$/i, /^backlog\.md$/i];

/** Is this wren-docs-relative path one a manager may ask to have moved to _deleted/? */
function fileDeletable(relPath) {
  const rel = String(relPath || '').replace(/^\/+/, '');
  if (!rel) return { ok: false, reason: 'No file path is recorded for this item.' };
  if (rel.includes('..') || path_isAbsolute(rel)) return { ok: false, reason: 'That path is not inside wren-docs.' };
  if (!/\.(md|txt|html?|csv|json)$/i.test(rel)) return { ok: false, reason: 'Only a text document can be deleted this way.' };
  const parts = rel.split('/');
  const top = parts[0].toLowerCase();
  if (PROTECTED_DOC_DIRS.includes(top)) {
    return { ok: false, reason: `wren-docs/${parts[0]}/ is kept — it is where the nursery's own decisions and policies live.` };
  }
  const base = parts[parts.length - 1];
  if (PROTECTED_DOC_FILES.some(re => re.test(base))) {
    return { ok: false, reason: `${base} is kept — it is one of the documents the setting is run from.` };
  }
  return { ok: true, rel };
}
// path.isAbsolute without pulling `path` into a file that has never needed it.
function path_isAbsolute(p) { return /^([a-zA-Z]:)?[\\/]/.test(p); }

function hostLabel(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch (_) { return null; }
}

function words(s) {
  const t = String(s || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

/** "the whole thing" sentence for a body we hold in full. */
function wholeItem(kind, chars) {
  return { full: true, chars: chars || 0, label: `This is the whole ${kind}${chars ? ` — about ${Math.max(1, Math.round(chars / 6))} words` : ''}, shown in full below.` };
}
/** "there is more than this" sentence, naming where the rest is. */
function summaryOnly(whereRest, chars) {
  return { full: false, chars: chars || 0, label: `This is a summary, not the document. ${whereRest}` };
}

// Markdown → readable plain text, PARAGRAPHS KEPT. Deliberately not reading-room-scan's
// mdPlain(), which collapses every run of whitespace to one space: right for a one-line
// summary, unreadable for the 8,000-word curriculum critique in the reader's pane.
function mdReadable(md) {
  return String(md || '')
    .replace(/\r\n?/g, '\n')
    .replace(/^```.*$/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // [^\S\n] not \s: in multiline mode a trailing \s* happily matches the newline AND the
    // following blank line (the empty line satisfies $ straight away), which collapsed the
    // paragraph break after every single heading. Caught by check 5.6 of the probe.
    .replace(/^[^\S\n]{0,3}(#{1,6})[^\S\n]+(.*?)[^\S\n]*#*[^\S\n]*$/gm, (_m, h, t) => (h.length <= 2 ? t.toUpperCase() : t))
    .replace(/^[^\S\n]{0,3}>[^\S\n]?/gm, '')
    .replace(/[`*_~]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The one stable key a tombstone is matched on across a re-scan. */
function fingerprintFor(item) {
  if (!item) return null;
  if (item.source === 'reading_document') {
    if (item.doc_key && String(item.doc_key).startsWith('wrendocs:')) return String(item.doc_key);
    if (item.drive_file_id) return `drive:${item.drive_file_id}`;
    return `dockey:${item.doc_key || item.source_id}`;
  }
  if (item.source === 'staff_reading') {
    if (item.provenance && item.provenance.path) return `docpath:${item.provenance.path}`;
    if (item.url_hash) return `url:${item.url_hash}`;
  }
  return `${item.source}:${item.source_id}`;
}

// b425b fix #3 — every source below used to hard-code ONE portal's own page as the
// href for every audience, so opening the same catalogued item from a different
// portal (EY/HR staff, Roost managers browsing everything) landed on the wrong
// hostname's static root and 404ed/fell through to a login page. `portal` is
// req._portal verbatim ('admin'|'hr'|'learning'|'parents') — each map below picks
// the CURRENT viewer's own page for that source, falling back to null (card is not
// a link) when that source genuinely has no page on the current portal.
function portalHref(map, portal) {
  return (map && map[portal]) || null;
}
const POLICY_HREF = { admin: '/policies-workspace.html', hr: '/policies.html', learning: '/ey/policies', parents: '/welcome/policies' };
const HANDBOOK_HREF = { admin: '/handbook.html', hr: '/handbook.html', learning: '/ey/handbook' };
// cpd-matrix.html is one shared file served to both admin and hr hosts (see
// server-unified.js) — Roost has no page of its own for "browse courses".
const COURSE_HREF = { admin: '/cpd-matrix.html', hr: '/cpd-matrix.html', learning: '/ey/cpd-catalogue' };
const STAFF_READING_HREF = { learning: '/ey/reading-corner', hr: '/reading-corner.html' };

async function safeQuery(db, sql, params) {
  try {
    const { rows } = await db.query(sql, params);
    return rows;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return []; // table/column doesn't exist on this tenant
    console.error('[reading-room-catalogue]', e.message);
    return [];
  }
}

async function metaMap(db, source) {
  const rows = await safeQuery(db,
    `SELECT * FROM ${SCHEMA()}.reading_item_meta WHERE source = $1`, [source]);
  const map = new Map();
  for (const r of rows) map.set(String(r.source_id), r);
  return map;
}

function applyMeta(item, meta) {
  const m = meta.get(String(item.source_id));
  if (!m) return { ...item, needs_review: item.needs_review || false, pinned: false, review_date: null };
  return {
    ...item,
    areas: (m.areas && m.areas.length) ? m.areas : item.areas,
    audiences: (m.audiences && m.audiences.length) ? m.audiences : item.audiences,
    review_date: m.review_date || item.review_date || null,
    pinned: !!m.pinned,
    needs_review: !!m.needs_review,
  };
}

function baseItem({ source, sourceId, title, summary, type, areas, audiences, owner, version, publishedAt, updatedAt, reviewDate, href, editHref }) {
  return {
    id: `${source}:${sourceId}`,
    source, source_id: String(sourceId),
    title: title || '(untitled)',
    summary: summary || null,
    type: type || source,
    areas: areas ? areas.filter(Boolean) : [],
    audiences: audiences || [],
    owner: owner || null,
    version: version != null ? version : null,
    published_at: publishedAt || null,
    updated_at: updatedAt || publishedAt || null,
    review_date: reviewDate || null,
    href: href || null,
    edit_href: editHref || null,
    needs_review: false,
    pinned: false,
  };
}

// ── Source adapters ──────────────────────────────────────────────────────────

async function sourcePolicies(db, portal) {
  const rows = await safeQuery(db, `
    SELECT id, title, content, category, version, version_label, effective_date,
           review_due, published_at, parent_facing, requires_parent_signature
    FROM ${SCHEMA()}.policies WHERE is_active = true`);
  const meta = await metaMap(db, 'policy');
  const href = portalHref(POLICY_HREF, portal);
  return rows.map(r => {
    const item = applyMeta(baseItem({
      source: 'policy', sourceId: r.id,
      title: r.title,
      summary: (r.content || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 220) || null,
      type: 'policy',
      areas: [guessArea(r.category, r.title)],
      audiences: r.parent_facing ? ['staff', 'parents'] : ['staff'],
      version: r.version,
      publishedAt: r.published_at,
      reviewDate: r.review_due,
      href,
      editHref: POLICY_HREF.admin,
    }), meta);
    // b482 — retained so the bookshelf's auto-grouping can group a set of
    // same-category policies into one book ("Records & information policies");
    // not used anywhere before this build.
    item.category = r.category || null;
    // b519 — chapterBody() already returns the policy's whole stored text, so the pane
    // IS the document; "Open original" is the policy editor, where it can be changed.
    const polChars = (r.content || '').length;
    item.provenance = {
      kind: 'wren_record',
      label: 'Wren — Policies',
      detail: [r.version_label || (r.version ? `v${r.version}` : null), r.category].filter(Boolean).join(' · ') || null,
      path: null,
      open: href ? { url: href, how: 'tab', label: 'Open the policy page' } : (portal === 'admin' ? { url: POLICY_HREF.admin, how: 'tab', label: 'Open the policy page' } : null),
    };
    item.extent = polChars ? wholeItem('policy', polChars) : { full: false, chars: 0, label: 'This policy has no text stored yet.' };
    return item;
  });
}

async function sourceHandbook(db, portal) {
  // b519 — length(...) rather than the text itself: the handbook body is large and the
  // shelf never needs it (chapterBody() fetches it when the reader actually opens it).
  const rows = await safeQuery(db, `
    SELECT id, version, title, is_current, effective_date, published_at, section_count,
           coalesce(length(body_html), 0) AS html_chars, coalesce(length(content_md), 0) AS md_chars
    FROM ${SCHEMA()}.staff_handbook_versions WHERE is_current = true LIMIT 1`);
  const meta = await metaMap(db, 'handbook');
  const href = portalHref(HANDBOOK_HREF, portal);
  return rows.map(r => {
    const item = applyMeta(baseItem({
      source: 'handbook', sourceId: 'document',
      title: r.title || 'Staff Handbook',
      summary: 'Onboarding, expectations and day-to-day reference for staff.',
      type: 'guide',
      areas: ['staffing-hr'],
      audiences: ['staff'],
      version: r.version,
      publishedAt: r.published_at,
      reviewDate: r.effective_date,
      href,
      editHref: HANDBOOK_HREF.admin,
    }), meta);
    const hbChars = r.html_chars || r.md_chars || 0;
    item.provenance = {
      kind: 'wren_record',
      label: 'Wren — Staff handbook',
      detail: [r.version ? `v${r.version}` : null, r.section_count ? `${r.section_count} sections` : null].filter(Boolean).join(' · ') || null,
      path: null,
      open: (href || HANDBOOK_HREF.admin) ? { url: href || HANDBOOK_HREF.admin, how: 'tab', label: 'Open the handbook' } : null,
    };
    // b519 — chapterBody() now returns the handbook text too, so this is no longer a
    // one-line stub with nothing behind it (that was the second instance of exactly the
    // thing Toby reported).
    item.extent = hbChars ? wholeItem('handbook', hbChars) : summaryOnly('Open the handbook to read it.', 0);
    return item;
  });
}

async function sourceCourses(db, portal) {
  const rows = await safeQuery(db, `
    SELECT c.id, c.slug, c.name, c.description, c.category, c.status, c.cpd_hours,
           c.published_at, c.target_audience,
           (SELECT count(*) FROM ${SCHEMA()}.course_sections cs WHERE cs.course_id = c.id)::int AS section_count
    FROM ${SCHEMA()}.courses c WHERE c.status = 'published'`);
  const meta = await metaMap(db, 'course');
  const href = portalHref(COURSE_HREF, portal);
  return rows.map(r => {
    const item = applyMeta(baseItem({
      source: 'course', sourceId: r.id,
      title: r.name,
      summary: r.description,
      type: 'course',
      areas: [guessArea(r.category, r.name) || 'training-cpd'],
      audiences: ['staff'],
      publishedAt: r.published_at,
      href,
      editHref: COURSE_HREF.admin,
    }), meta);
    item.provenance = {
      kind: 'wren_record',
      label: 'Wren — Courses',
      detail: [r.cpd_hours ? `${r.cpd_hours} CPD hours` : null, r.section_count ? `${r.section_count} sections` : null].filter(Boolean).join(' · ') || null,
      path: null,
      open: (href || (portal === 'admin' ? COURSE_HREF.admin : null))
        ? { url: href || COURSE_HREF.admin, how: 'tab', label: 'Open the course' } : null,
    };
    // A course is taken, not read: its sections live behind the course player, so the
    // honest line is that this is the outline and says where the rest is.
    item.extent = summaryOnly(r.section_count
      ? `The course itself has ${r.section_count} section${r.section_count === 1 ? '' : 's'} — open it to take it.`
      : 'Open the course to take it.', (r.description || '').length);
    return item;
  });
}

async function sourceStudyModules(db, portal) {
  const rows = await safeQuery(db, `
    SELECT id, slug, title, category, summary, format, age_group, status, published_at,
           coalesce(jsonb_array_length((content_json::jsonb)->'sections'), 0)::int AS section_count,
           coalesce(length(content_json::text), 0) AS json_chars
    FROM ${SCHEMA()}.parent_study_modules WHERE status = 'published'`);
  const meta = await metaMap(db, 'study_module');
  // Only the parents portal has a page for a study module — Roost's admin audience
  // still sees these rows (it sees everything), but with no link to click, rather
  // than one that 404s on the admin host (b425b fix #3).
  return rows.map(r => {
    const href = portal === 'parents' ? `/welcome/study/${r.slug}` : null;
    const item = applyMeta(baseItem({
      source: 'study_module', sourceId: r.id,
      title: r.title,
      summary: r.summary,
      type: 'study_module',
      areas: [guessArea(r.category, r.title) || 'curriculum-assessment'],
      audiences: ['parents'],
      publishedAt: r.published_at,
      href,
      editHref: href,
    }), meta);
    item.provenance = {
      kind: 'wren_record',
      label: 'Wren — Family study modules',
      detail: [r.age_group, r.section_count ? `${r.section_count} sections` : null].filter(Boolean).join(' · ') || null,
      path: null,
      // Only the parents portal has a page for a module (b425b fix #3). On Roost the
      // module's own text is now rendered in the pane instead, which is a better answer
      // than a button that 404s on the admin host.
      open: href ? { url: href, how: 'tab', label: 'Open the module' } : null,
    };
    item.extent = r.section_count ? wholeItem('module', r.json_chars) : summaryOnly('Open the module to read it.', (r.summary || '').length);
    return item;
  });
}

async function sourceArticles(db, portal) {
  const rows = await safeQuery(db, `
    SELECT id, title, content_html, category, source_url, created_at,
           coalesce(length(content_html), 0) AS html_chars
    FROM ${SCHEMA()}.resources WHERE published = true`);
  const meta = await metaMap(db, 'article');
  // b425c fix D4 — '/welcome/resources' only exists on Parents; the hard-coded
  // fallback sent Roost (and HR/EY) to a path that serves the Admin Login page
  // there. Same portal-aware pattern as sourceStudyModules/sourceStaffReading
  // above: no fallback page on a portal that doesn't have one, card just isn't
  // a link. An external source_url still works from any portal.
  const internalFallback = portal === 'parents' ? '/welcome/resources' : null;
  return rows.map(r => {
    const item = applyMeta(baseItem({
      source: 'article', sourceId: r.id,
      title: r.title,
      summary: (r.content_html || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 220) || null,
      type: 'article',
      areas: [guessArea(r.category, r.title)],
      audiences: ['parents'],
      publishedAt: r.created_at,
      href: r.source_url || internalFallback,
      editHref: internalFallback,
    }), meta);
    const ext = r.source_url ? hostLabel(r.source_url) : null;
    item.provenance = {
      kind: r.source_url ? 'external_url' : 'wren_record',
      label: ext || 'Wren — Resource library',
      detail: r.category || null,
      path: null,
      open: r.source_url
        ? { url: r.source_url, how: 'tab', label: `Open original on ${ext}` }
        : (internalFallback ? { url: internalFallback, how: 'tab', label: 'Open in the resource library' } : null),
    };
    // The whole article text is stored here, so the pane is the article; an external
    // source_url, where there is one, is where it was taken from.
    item.extent = r.html_chars ? wholeItem('article', r.html_chars) : summaryOnly(ext ? `The full text is on ${ext}.` : 'No text is stored for this one.', 0);
    return item;
  });
}

async function sourceStaffReading(db, portal) {
  // b425b fix #6 — this had no status filter at all; a draft/suggested item would
  // have shown up in the catalogue the moment someone added it, before an editor
  // ever published it.
  // b519 — url / what_it_means / publisher / doc_path / the body's size were all sitting
  // right here and none of them were being read. That is the whole of Toby's report: a news
  // item showed its 341-character summary, no source, and no way to reach the article.
  const rows = await safeQuery(db, `
    SELECT id, kind, title, url, url_hash, summary, what_it_means, publisher, source_name,
           doc_path, published_on, created_at, topics, pinned,
           (body_md IS NOT NULL) AS has_body, coalesce(length(body_md), 0) AS body_chars
    FROM ${SCHEMA()}.staff_reading_items WHERE status = 'published'`);
  const meta = await metaMap(db, 'staff_reading');
  // Neither Roost nor the parents app has a page for Reading Corner — only EY and
  // HR do (b425b fix #3); no admin fallback exists, so the card just isn't a link
  // when browsed from Roost.
  const href = portalHref(STAFF_READING_HREF, portal);
  return rows.map(r => {
    const ext = r.url ? hostLabel(r.url) : null;
    const item = applyMeta(baseItem({
      source: 'staff_reading', sourceId: r.id,
      title: r.title,
      summary: r.summary,
      type: 'article',
      areas: [guessArea((r.topics || []).join(' '), r.title) || 'training-cpd'],
      audiences: ['staff'],
      publishedAt: r.published_on || r.created_at,
      // b519 — an external article's own URL works from EVERY portal, including Roost,
      // where STAFF_READING_HREF has no entry at all and href was therefore null: the
      // card was not a link and the reader had no Open button. The Reading Corner page
      // (EY/HR) stays the href where it exists, so nothing that worked stops working.
      href: href || r.url || null,
      editHref: href,
    }), meta);
    item.url_hash = r.url_hash || null;
    item.reading_kind = r.kind || 'news';  // 2026-10-28: staff see practice reading, not the raw news feed
    // "What it means for us" — written by the digest when the item was published and shown
    // on the Reading Corner page since b361. The catalogue was dropping it.
    item.so_what = r.what_it_means || null;
    const srcName = r.source_name || r.publisher || ext;
    item.provenance = r.doc_path
      ? {
          kind: 'wren_docs_file',
          label: 'Wren\u2019s own analysis',
          detail: r.doc_path.split('/')[0],
          path: r.doc_path,
          open: href ? { url: href, how: 'tab', label: 'Open in the Reading Corner' } : null,
        }
      : {
          kind: r.url ? 'external_url' : 'wren_record',
          label: srcName || 'Reading Corner',
          detail: [r.publisher && r.publisher !== srcName ? r.publisher : null, ext].filter(Boolean).join(' · ') || null,
          path: null,
          open: r.url
            ? { url: r.url, how: 'tab', label: `Open the original on ${ext}` }
            : (href ? { url: href, how: 'tab', label: 'Open in the Reading Corner' } : null),
        };
    item.extent = r.has_body
      // A critique/analysis written here: the whole text is in the DB and chapterBody now
      // returns it, so the pane really is the document.
      ? wholeItem(r.doc_path ? 'document' : 'item', r.body_chars)
      // A news item: Wren holds a summary of somebody else's article, on purpose. Say so
      // rather than letting a short paragraph look like the whole thing.
      : summaryOnly(ext ? `The article itself is on ${ext} — Open original goes straight to it.`
                        : 'The full item is not stored in Wren.', (r.summary || '').length);
    // pinned on the source row itself also counts as pinned in the catalogue
    return r.pinned ? { ...item, pinned: true } : item;
  });
}

// Admin-only: committed document-workspace outputs. Never exposed to staff/parents —
// that route is manager-only today and loosening it is a permissions decision, not
// a query change (left to Toby, see NOTES).
async function sourceDocumentWorkspaces(db) {
  const rows = await safeQuery(db, `
    SELECT id, name, doc_type, status, committed_to_table, created_at, updated_at
    FROM ${SCHEMA()}.document_workspaces WHERE status = 'committed'`);
  const meta = await metaMap(db, 'document_workspace');
  return rows.map(r => {
    const item = applyMeta(baseItem({
      source: 'document_workspace', sourceId: r.id,
      title: r.name,
      summary: r.committed_to_table ? `Committed to ${r.committed_to_table}` : null,
      type: 'document',
      areas: [guessArea(r.doc_type, r.name)],
      audiences: [], // admin-only; gated in the route, not via this field
      publishedAt: r.updated_at || r.created_at,
      href: '/documents/workspaces.html',
      editHref: `/documents/workspace-detail.html?id=${r.id}`,
    }), meta);
    item.provenance = {
      kind: 'wren_record',
      label: 'Wren — Document workspaces',
      detail: r.committed_to_table ? `Committed to ${r.committed_to_table}` : null,
      path: null,
      open: { url: `/documents/workspace-detail.html?id=${r.id}`, how: 'tab', label: 'Open the workspace' },
    };
    item.extent = summaryOnly('The document itself lives in its workspace — open it there.', 0);
    return item;
  });
}

async function sourceReadingDocuments(db) {
  const rows = await safeQuery(db, `
    SELECT id, doc_key, version, title, summary, doc_type, areas, audiences,
           status, filename, mime, size_bytes, uploaded_by_name, uploaded_at,
           source, drive_file_id, drive_path, drive_folder, drive_modified_at, review_date,
           proposed_audiences
    FROM ${SCHEMA()}.reading_documents WHERE is_current = true`);
  return rows.map(r => {
    const item = baseItem({
      source: 'reading_document', sourceId: r.id,
      title: r.title,
      summary: r.summary,
      type: r.doc_type || 'document',
      areas: r.areas || [],
      audiences: r.status === 'published' ? (r.audiences || []) : [],
      owner: r.uploaded_by_name,
      version: r.version,
      publishedAt: r.uploaded_at,
      reviewDate: r.review_date,
      href: `/api/library/documents/${r.id}/file`,
      editHref: null,
    });
    item.needs_review = r.status === 'needs_review';
    item.doc_key = r.doc_key;
    // b426: Drive-import provenance — 'upload' items carry none of this.
    item.origin = r.source || 'upload';
    item.drive_path = r.drive_path || null;
    item.drive_folder = r.drive_folder || null;
    item.drive_modified_at = r.drive_modified_at || null;
    item.proposed_audiences = r.proposed_audiences || [];
    item.drive_file_id = r.drive_file_id || null;
    // b519 — where the stored file actually came from, and the fact that what you open IS
    // the whole document (these rows are a rendered snapshot of the source file, full text,
    // written by the host importers; nothing here is a summary).
    const docKey = String(r.doc_key || '');
    const wrenDocsRel = docKey.startsWith('wrendocs:') ? docKey.slice('wrendocs:'.length) : null;
    const kb = r.size_bytes ? Math.max(1, Math.round(r.size_bytes / 1024)) : 0;
    if (wrenDocsRel) {
      item.provenance = {
        // The path itself goes in `path`, which the page renders on its own line — putting it
        // in `label` too printed it twice (caught in the screenshots).
        kind: 'wren_docs_file',
        label: 'Wren\u2019s own notes',
        detail: `${wrenDocsRel.split('/')[0]}, indexed from the host`,
        path: wrenDocsRel,
        open: { url: item.href, how: 'blob', label: 'Open original' },
      };
    } else if (r.source === 'drive_import') {
      item.provenance = {
        kind: 'drive_file',
        label: r.drive_path ? `Google Drive — ${r.drive_path}` : 'Google Drive',
        detail: r.drive_folder || null,
        path: null,
        open: { url: item.href, how: 'blob', label: 'Open original' },
      };
    } else if (r.source === 'help_centre_import') {
      item.provenance = {
        kind: 'stored_file',
        label: 'Wren help centre',
        detail: r.filename || null,
        path: null,
        open: { url: item.href, how: 'blob', label: 'Open original' },
      };
    } else {
      item.provenance = {
        kind: 'stored_file',
        label: r.uploaded_by_name ? `Uploaded by ${r.uploaded_by_name}` : 'Uploaded to Wren',
        detail: r.filename || null,
        path: null,
        open: { url: item.href, how: 'blob', label: 'Open original' },
      };
    }
    item.extent = {
      full: true,
      chars: r.size_bytes || 0,
      label: `The whole document is stored in Wren${kb ? ` (${kb} KB)` : ''} — "Open original" shows all of it.`,
    };
    return item;
  });
}

const STAFF_PRACTICE_SOURCES = new Set(['staff_reading', 'cpd_article']);

// 2026-10-28 — our own half-term CPD articles (EY → Deep dive), readable in the Reading Room too.
async function sourceCpdArticles(db, portal) {
  const rows = await safeQuery(db, `
    SELECT a.id, a.title, a.practice_point, a.minutes, a.created_at, a.updated_at, length(a.body) AS chars,
           t.title AS theme, t.term, t.half
      FROM ${SCHEMA()}.cpd_theme_articles a JOIN ${SCHEMA()}.cpd_themes t ON t.id = a.theme_id
     WHERE a.status = 'published' AND COALESCE(a.body, '') <> '' AND t.active = true`);
  const meta = await metaMap(db, 'cpd_article');
  return rows.map(r => {
    const item = applyMeta(baseItem({
      source: 'cpd_article', sourceId: r.id,
      title: r.title,
      summary: r.practice_point || (r.theme ? 'Part of our ' + r.theme + ' topic.' : null),
      type: 'article',
      areas: [guessArea(r.theme, r.title) || 'training-cpd'],
      audiences: ['staff'],
      publishedAt: r.updated_at || r.created_at,
      href: portal === 'learning' ? '/ey/deep-dive.html' : null,
      editHref: null,
    }), meta);
    item.provenance = { kind: 'wren_record', label: 'Our CPD: ' + (r.theme || 'topic'),
      detail: [r.term, r.half ? 'half ' + r.half : null, r.minutes ? r.minutes + ' min read' : null].filter(Boolean).join(' · ') || null,
      path: null, open: null };
    item.extent = wholeItem('article', Number(r.chars) || 0);
    return item;
  });
}

const SOURCE_ADAPTERS = {
  cpd_article: sourceCpdArticles,
  policy: sourcePolicies,
  handbook: sourceHandbook,
  course: sourceCourses,
  study_module: sourceStudyModules,
  article: sourceArticles,
  staff_reading: sourceStaffReading,
  document_workspace: sourceDocumentWorkspaces,
  reading_document: sourceReadingDocuments,
};

// audience: 'admin' sees everything (including document_workspace + needs-review
// items); 'staff'/'parents'/'pupils' only ever see items whose audiences include
// that string, and never anything with needs_review=true.
// b425b fix #11 — the "no area set" tile (slug=null / 'Uncategorised') needs a
// filter value that is distinguishable from "no area filter applied at all"
// (also falsy). ui and server share this one sentinel string.
const UNCATEGORISED = '__none__';

// ── b519: archive + delete state ─────────────────────────────────────────────
// Both are catalogue-level, keyed by (source, source_id), and both are applied HERE — in the
// one function every view goes through — rather than inside each adapter, so there is no way
// to add a ninth source later that quietly ignores them. Each degrades on 42P01 like
// everything else in this file, so the page still works on a tenant (or a prod box) where
// the b519 migration has not run yet.
async function itemStateMap(db) {
  const rows = await safeQuery(db,
    `SELECT source, source_id, archived_at, archived_by, archived_by_name FROM ${SCHEMA()}.reading_item_state WHERE archived_at IS NOT NULL`);
  const m = new Map();
  for (const r of rows) m.set(`${r.source}:${r.source_id}`, r);
  return m;
}

/** Live tombstones, by id AND by fingerprint — a re-import can give the same file a new id. */
async function deletionKeys(db) {
  const rows = await safeQuery(db,
    `SELECT source, source_id, fingerprint FROM ${SCHEMA()}.reading_item_deletions WHERE restored_at IS NULL`);
  const ids = new Set(), fps = new Set();
  for (const r of rows) {
    ids.add(`${r.source}:${r.source_id}`);
    if (r.fingerprint) fps.add(r.fingerprint);
  }
  return { ids, fps };
}

function isDeleted(item, keys) {
  if (!keys) return false;
  if (keys.ids.has(`${item.source}:${item.source_id}`)) return true;
  const fp = fingerprintFor(item);
  return !!(fp && keys.fps.has(fp));
}

// `archived`: undefined/'live' = hide archived (the default every existing caller gets),
// 'only' = just the archived ones, 'all' = both (used by the shelf, which needs the archived
// COUNT while showing the live list, and by bookDetail so an archived book still opens).
async function listItems({ audience, portal, area, type, q, sort, from, to, includeNeedsReview, archived }) {
  const db = getPool();
  const p = portal || (audience === 'admin' ? 'admin' : 'learning');
  const sources = Object.keys(SOURCE_ADAPTERS);
  const settled = await Promise.all(sources.map(s => SOURCE_ADAPTERS[s](db, p).catch(() => [])));
  let items = settled.flat();

  const [stateMap, tombstones] = await Promise.all([itemStateMap(db), deletionKeys(db)]);
  items = items.filter(i => !isDeleted(i, tombstones));
  for (const i of items) {
    const st = stateMap.get(`${i.source}:${i.source_id}`);
    i.archived_at = (st && st.archived_at) || null;
    i.archived_by = (st && st.archived_by_name) || null;
    // Archiving unpins — the two mean opposite things ("keep this at the top" vs "I have
    // read it and will not need it again"), so an archived item never floats to the top of
    // anything. setArchived() also clears the stored pin; this is the belt to that braces,
    // and it also covers a pin that lives on the source row (staff_reading_items.pinned),
    // which belongs to the Reading Corner's own editor and is not ours to write to.
    if (i.archived_at) i.pinned = false;
  }
  if (archived === 'only') items = items.filter(i => i.archived_at);
  else if (archived !== 'all') items = items.filter(i => !i.archived_at);

  if (audience !== 'admin') {
    items = items.filter(i => !i.needs_review && i.audiences.includes(audience));
    // 2026-10-28 (Toby: "Reading room should be more like Nursery World articles on improving
    // practice … only the practice ones"): staff get practice reading — the Reading Corner's
    // practice articles and our own CPD topic articles. Policies live in Documents, the
    // how-to guides in Help, courses in My CPD; Roost (admin) still sees everything.
    if (audience === 'staff') items = items.filter(i => STAFF_PRACTICE_SOURCES.has(i.source)
      && !(i.source === 'staff_reading' && i.reading_kind === 'news'));  // feed news waits for a manager to promote it
    // b425b fix #7 — Drive provenance is an internal detail of how a document
    // reached the catalogue (which Google Drive folder it came from); never show
    // that to a parent or a member of staff, only to a Roost manager (audience
    // 'admin'). The client also gates rendering on `admin`, but the authoritative
    // cut is here — never send the field at all.
    for (const i of items) {
      if (i.source === 'reading_document') {
        delete i.drive_path; delete i.drive_folder; delete i.drive_modified_at;
        delete i.proposed_audiences; delete i.origin;
        delete i.drive_file_id;
      }
      // b519 — same rule for the new provenance block: a member of staff or a family sees
      // WHERE something came from in words ("ndna.org.uk", "Wren — Policies") but never an
      // internal file path, and never the Drive/Google file id.
      if (i.provenance && i.provenance.path) {
        i.provenance = { ...i.provenance, path: null };
      }
    }
  } else {
    // b519 — a manager's own view carries the answer to "may this file be deleted?", so the
    // page never has to keep its own copy of the protected-folder list and then drift from
    // the server's. The API refuses an ineligible path regardless of what the page sent.
    for (const i of items) {
      if (i.provenance && i.provenance.path) {
        i.provenance = { ...i.provenance, file_delete: fileDeletable(i.provenance.path) };
      }
    }
    if (!includeNeedsReview) {
      // admin default view still shows published + unreviewed-but-visible items;
      // needs-review items surface separately via the dedicated queue endpoint
    }
  }

  if (area === UNCATEGORISED) items = items.filter(i => !i.areas.length);
  else if (area) items = items.filter(i => i.areas.includes(area));
  if (type) items = items.filter(i => i.type === type);
  if (q) {
    const needle = q.toLowerCase();
    items = items.filter(i =>
      (i.title || '').toLowerCase().includes(needle) ||
      (i.summary || '').toLowerCase().includes(needle));
  }
  if (from) items = items.filter(i => i.updated_at && new Date(i.updated_at) >= new Date(from));
  if (to) items = items.filter(i => i.updated_at && new Date(i.updated_at) <= new Date(to));

  const byDateDesc = (a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
  // b425b fix #11 — an undated item coerced to epoch 0 is the SMALLEST possible
  // value, so ascending ("Oldest first") put it ahead of every real date instead
  // of after it. Undated items now sort last regardless of direction, same
  // convention byReviewDue below already uses.
  const byDateAsc = (a, b) => {
    if (!a.updated_at && !b.updated_at) return 0;
    if (!a.updated_at) return 1;
    if (!b.updated_at) return -1;
    return new Date(a.updated_at) - new Date(b.updated_at);
  };
  const byTitle = (a, b) => (a.title || '').localeCompare(b.title || '');
  const byReviewDue = (a, b) => {
    if (!a.review_date && !b.review_date) return 0;
    if (!a.review_date) return 1;
    if (!b.review_date) return -1;
    return new Date(a.review_date) - new Date(b.review_date);
  };
  const sorters = { newest: byDateDesc, oldest: byDateAsc, az: byTitle, 'review-due': byReviewDue };
  items.sort(sorters[sort] || byDateDesc);
  items.sort((a, b) => (b.pinned - a.pinned)); // pinned always floats to top, stable within sort

  return items;
}

// b426: area/folder filters for the bulk-review UI. `folder` only ever matches
// reading_document items (drive_folder is null on every other source), so asking
// for a folder naturally narrows the queue down to Drive imports.
async function needsReviewQueue({ area, folder } = {}) {
  const db = getPool();
  // Always admin — the route gates this endpoint to roostManagerOnly, so the
  // Drive-provenance fields (b425b fix #7) are meant to be visible here.
  let items = (await Promise.all(Object.keys(SOURCE_ADAPTERS).map(s => SOURCE_ADAPTERS[s](db, 'admin').catch(() => []))))
    .flat()
    .filter(i => i.needs_review);
  if (area === UNCATEGORISED) items = items.filter(i => !i.areas.length);
  else if (area) items = items.filter(i => i.areas.includes(area));
  if (folder) items = items.filter(i => i.drive_folder === folder);
  return items;
}

// b426: the Roost "Needs review" bulk toolbar — accept/publish or discard a batch
// of reading_documents rows in one call. Only ever touches reading_documents
// (the one new store); the other eight unioned sources keep their own editors
// and are not reachable through this function.
async function bulkUpdateDocuments(ids, patch, actor) {
  const db = getPool();
  const numericIds = ids.map(n => parseInt(n, 10)).filter(Number.isFinite);
  if (!numericIds.length) return { updated: 0 };

  if (patch.discard) {
    const { rows } = await db.query(
      `UPDATE ${SCHEMA()}.reading_documents SET status = 'archived'
        WHERE id = ANY($1::int[]) RETURNING id`, [numericIds]);
    return { updated: rows.length, action: 'discard' };
  }

  const sets = [];
  const values = [numericIds];
  const push = (sql, v) => { values.push(v); sets.push(sql.replace('$n', '$' + values.length)); };
  if (patch.areas !== undefined) push('areas = $n::text[]', patch.areas);
  if (patch.doc_type !== undefined) push('doc_type = $n', patch.doc_type);
  if (patch.audiences !== undefined) push('audiences = $n::text[]', patch.audiences);
  push('status = CASE WHEN $n::boolean THEN \'published\' ELSE status END', !!patch.publish);
  const { rows } = await db.query(
    `UPDATE ${SCHEMA()}.reading_documents SET ${sets.join(', ')}
      WHERE id = ANY($1::int[]) RETURNING id`, values);
  return { updated: rows.length, action: patch.publish ? 'publish' : 'update' };
}

async function areaCounts(audience) {
  const items = await listItems({ audience });
  const counts = Object.fromEntries(AREAS.map(([slug]) => [slug, 0]));
  let uncategorised = 0;
  for (const i of items) {
    if (!i.areas.length) { uncategorised++; continue; }
    for (const a of i.areas) if (counts[a] != null) counts[a]++;
  }
  return AREAS.map(([slug, name]) => ({ slug, name, count: counts[slug] })).concat(
    uncategorised ? [{ slug: null, name: 'Uncategorised', count: uncategorised }] : []
  );
}

// b519 — this is the ONE lookup that bypasses listItems() (it is a single-adapter call by
// design, not a whole catalogue scan), so it needs the delete/archive rules of its own or a
// deleted item would still open by direct URL — ?chapter=… is a link people paste.
// `includeDeleted` is for the archive/delete writers themselves.
async function findItem(source, sourceId, portal, { includeDeleted } = {}) {
  const adapter = SOURCE_ADAPTERS[source];
  if (!adapter) return null;
  const db = getPool();
  const rows = await adapter(db, portal || 'admin');
  const item = rows.find(r => String(r.source_id) === String(sourceId)) || null;
  if (!item) return null;
  const [stateMap, tombstones] = await Promise.all([itemStateMap(db), deletionKeys(db)]);
  if (!includeDeleted && isDeleted(item, tombstones)) return null;
  const st = stateMap.get(`${item.source}:${item.source_id}`);
  item.archived_at = (st && st.archived_at) || null;
  item.archived_by = (st && st.archived_by_name) || null;
  if (item.archived_at) item.pinned = false;
  return item;
}

// b425b fix #9 — the generic reading_item_meta table (used by every other source)
// is never read back for reading_document rows: sourceReadingDocuments() takes its
// areas/audiences straight off the reading_documents row itself. Calling the
// generic upsertMeta() for a reading_document therefore wrote meta that nothing
// ever displayed — "Set area / audience" silently did nothing for an uploaded or
// Drive-imported document. This writes to the same columns bulkUpdateDocuments()
// already uses for the bulk toolbar, just for one id.
async function updateDocumentMeta(id, patch, actor) {
  const db = getPool();
  const numericId = parseInt(id, 10);
  if (!Number.isFinite(numericId)) return null;
  const sets = [];
  const values = [numericId];
  const push = (sql, v) => { values.push(v); sets.push(sql.replace('$n', '$' + values.length)); };
  if (patch.areas !== undefined) push('areas = $n::text[]', patch.areas);
  if (patch.audiences !== undefined) push('audiences = $n::text[]', patch.audiences);
  if (patch.review_date !== undefined) push('review_date = $n', patch.review_date || null);
  if (!sets.length) return { id: numericId, unchanged: true };
  const { rows } = await db.query(
    `UPDATE ${SCHEMA()}.reading_documents SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, values);
  return rows[0] || null;
}

async function upsertMeta(source, sourceId, patch, actor) {
  const db = getPool();
  const fields = ['areas', 'audiences', 'review_date', 'pinned', 'needs_review'];
  const values = {};
  for (const f of fields) if (patch[f] !== undefined) values[f] = patch[f];
  // The INSERT branch (first time this item gets meta) can't leave $3/$4/$6/$7
  // as a bare NULL when the caller didn't set that field — the columns are
  // NOT NULL DEFAULT '{}'/false, and an explicit NULL bypasses the column
  // default and violates the constraint. COALESCE them to the same defaults.
  await db.query(`
    INSERT INTO ${SCHEMA()}.reading_item_meta (source, source_id, areas, audiences, review_date, pinned, needs_review, set_by, set_by_name, updated_at)
    VALUES ($1,$2, COALESCE($3::text[],'{}'),COALESCE($4::text[],'{}'),$5,COALESCE($6::boolean,false),COALESCE($7::boolean,false), $8,$9, now())
    ON CONFLICT (source, source_id) DO UPDATE SET
      areas        = COALESCE($3::text[], ${SCHEMA()}.reading_item_meta.areas),
      audiences    = COALESCE($4::text[], ${SCHEMA()}.reading_item_meta.audiences),
      review_date  = COALESCE($5, ${SCHEMA()}.reading_item_meta.review_date),
      pinned       = COALESCE($6::boolean, ${SCHEMA()}.reading_item_meta.pinned),
      needs_review = COALESCE($7::boolean, ${SCHEMA()}.reading_item_meta.needs_review),
      set_by = $8, set_by_name = $9, updated_at = now()
  `, [
    source, String(sourceId),
    values.areas ?? null, values.audiences ?? null, values.review_date ?? null,
    values.pinned ?? null, values.needs_review ?? null,
    actor && actor.id, actor && actor.name,
  ]);
}

// b427 — Roost's "What's in the Reading Room" page. Audience is always 'admin' here (the
// route gates this to roostManagerOnly before calling it) so this sees every catalogued item,
// including ones still in needs_review — a manager reviewing coverage needs the full picture,
// not the published-only slice a staff/parent would see.
async function overview() {
  const items = await listItems({ audience: 'admin' });
  const AUDIENCE_KEYS = ['admin', 'staff', 'parents', 'pupils'];

  const byArea = new Map(AREAS.map(([slug, name]) => [slug, { slug, name, admin: 0, staff: 0, parents: 0, pupils: 0, total: 0 }]));
  let noArea = [];
  const dueSoon = [];
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() + 30);

  for (const item of items) {
    if (!item.areas.length) {
      noArea.push({ source: item.source, source_id: item.source_id, title: item.title, type: item.type, href: item.edit_href || item.href });
    }
    for (const area of item.areas) {
      const row = byArea.get(area);
      if (!row) continue; // an area slug that isn't one of the twelve (shouldn't happen, but never throw over it)
      row.total++;
      // Admin always "sees" every catalogued item; staff/parents/pupils only count if the
      // item is actually published to them (never needs_review, audience must include them).
      row.admin++;
      if (!item.needs_review) {
        for (const aud of ['staff', 'parents', 'pupils']) {
          if (item.audiences.includes(aud)) row[aud]++;
        }
      }
    }
    if (item.review_date) {
      const d = new Date(item.review_date);
      if (d <= cutoff) dueSoon.push({ source: item.source, source_id: item.source_id, title: item.title, review_date: item.review_date, href: item.edit_href || item.href });
    }
  }
  dueSoon.sort((a, b) => new Date(a.review_date) - new Date(b.review_date));

  const checklist = await listChecklist();
  const checklistByArea = {};
  for (const row of checklist) (checklistByArea[row.area] = checklistByArea[row.area] || []).push(row);

  return {
    areas: Array.from(byArea.values()),
    audience_keys: AUDIENCE_KEYS,
    total_items: items.length,
    no_area: noArea,
    due_soon: dueSoon,
    checklist: checklistByArea,
  };
}

// b427 — the paperless checklist (reading_paperless_checklist). Seeded by the migration from
// wren-docs/analysis/2026-09-15-how-the-nursery-runs.md; a manager only ever updates `status`/
// `notes` here — this table is a checklist, not a workflow, and never writes anywhere else.
async function listChecklist() {
  const db = getPool();
  const rows = await safeQuery(db, `
    SELECT id, area, item, detail, status, notes, sort_order, updated_by_name, updated_at
    FROM ${SCHEMA()}.reading_paperless_checklist ORDER BY area, sort_order, id`);
  return rows;
}

async function updateChecklistItem(id, patch, actor) {
  const db = getPool();
  const status = ['paper', 'in_progress', 'done', 'not_needed'].includes(patch.status) ? patch.status : null;
  const { rows } = await db.query(`
    UPDATE ${SCHEMA()}.reading_paperless_checklist SET
      status = COALESCE($2, status),
      notes = COALESCE($3, notes),
      updated_by = $4, updated_by_name = $5, updated_at = now()
    WHERE id = $1
    RETURNING id, area, item, detail, status, notes, sort_order, updated_by_name, updated_at`,
    [id, status, patch.notes !== undefined ? patch.notes : null, actor && actor.id, actor && actor.name]);
  return rows[0] || null;
}

// ── b482: the bookshelf — grouping catalogue items into "books" ──────────────
// Deterministic by default (same catalogue state always groups the same way,
// no stored state needed for the common case): a policy category, a title
// prefix shared by ≥2 items of the same type ("Fire Safety: Evacuation Plan" /
// "Fire Safety: Drill Log"), or — for imported/uploaded documents specifically
// — a shared area+type bucket ("Systems & IT guides"). A manager's override
// (reading_book_overrides) always wins, and is the ONLY way items from
// different sources end up in one book (e.g. the brief's own example: money
// policies + invoicing guides combined by hand into "Money & fees handbook").
const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}$/;
const TITLE_SPLIT_RE = /\s*(?::| — | – | - )\s*/;
const TYPE_PLURAL = {
  guide: 'guides', decision: 'decisions', analysis: 'analyses', policy: 'policies',
  document: 'documents', course: 'courses', article: 'articles', procedure: 'procedures',
  form: 'forms', report: 'reports', letter: 'letters',
};
const SOURCE_LABEL = {
  policy: 'Policies', handbook: 'Handbook', course: 'Courses', study_module: 'Study modules',
  article: 'Articles', staff_reading: 'Reading Corner', cpd_article: 'Our CPD', document_workspace: 'Document workspace',
  reading_document: 'Documents', mixed: 'Combined books',
};

function slugifyKey(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function titlePrefixKey(item) {
  const parts = (item.title || '').split(TITLE_SPLIT_RE);
  if (parts.length < 2) return null;
  const prefix = parts[0].trim();
  if (prefix.length < 4 || DATE_PREFIX_RE.test(prefix)) return null; // a bare date isn't a series name
  return `auto:prefix:${item.type}:${slugifyKey(prefix)}`;
}

function autoBookKey(item) {
  if (item.source === 'policy' && item.category) return `auto:policycat:${slugifyKey(item.category)}`;
  const byPrefix = titlePrefixKey(item);
  if (byPrefix) return byPrefix;
  if (item.source === 'reading_document' && item.areas.length === 1 && item.type) {
    return `auto:areatype:${item.areas[0]}:${slugifyKey(item.type)}`;
  }
  return null;
}

// Pure function — no DB access — so it's directly unit-testable and reused by
// both booksFor() (the shelf) and bookDetail() (one book's chapters).
function computeBooks(items, overrideMap, metaMap) {
  overrideMap = overrideMap || new Map();
  metaMap = metaMap || new Map();
  const AREA_NAME = Object.fromEntries(AREAS.map(([s, n]) => [s, n]));

  // Pass 1: size up every auto-group (ignoring items a manager has already
  // moved elsewhere) — a group only "counts" as a real book once it has ≥2
  // members; a lone item with no company stays a 1-chapter solo book.
  const groupSize = new Map();
  for (const item of items) {
    const id = `${item.source}:${item.source_id}`;
    if (overrideMap.has(id)) continue;
    const key = autoBookKey(item);
    if (key) groupSize.set(key, (groupSize.get(key) || 0) + 1);
  }

  const books = new Map();
  for (const item of items) {
    const id = `${item.source}:${item.source_id}`;
    const ov = overrideMap.get(id);
    let key, chapterTitle = item.title;
    if (ov) {
      key = ov.book_key;
      if (ov.chapter_title) chapterTitle = ov.chapter_title;
    } else {
      const auto = autoBookKey(item);
      key = (auto && groupSize.get(auto) >= 2) ? auto : `solo:${id}`;
    }
    if (!books.has(key)) books.set(key, { key, items: [] });
    books.get(key).items.push({ ...item, chapter_title: chapterTitle });
  }

  const result = [];
  for (const b of books.values()) {
    const solo = b.key.startsWith('solo:');
    const manualMeta = metaMap.get(b.key);
    // b482b fix F11 — plain localeCompare sorts "10.2" before "10.10" (lexical,
    // not numeric); { numeric: true } reads the digit runs as numbers instead.
    b.items.sort((x, y) => (y.pinned - x.pinned) || (x.chapter_title || '').localeCompare(y.chapter_title || '', undefined, { numeric: true }));
    const first = b.items[0];

    let title = manualMeta && manualMeta.title;
    if (!title) {
      if (solo) title = first.title;
      else if (b.key.startsWith('auto:policycat:')) title = `${first.category} policies`;
      else if (b.key.startsWith('auto:areatype:')) {
        const [, , area, type] = b.key.split(':');
        title = `${AREA_NAME[area] || area} ${TYPE_PLURAL[type] || type + 's'}`;
      } else if (b.key.startsWith('auto:prefix:')) {
        title = first.title.split(TITLE_SPLIT_RE)[0].trim();
      } else title = first.title;
    }

    const areasSet = new Set(), audSet = new Set();
    let needsReview = false, pinned = false, updatedAt = null;
    for (const it of b.items) {
      (it.areas || []).forEach(a => areasSet.add(a));
      (it.audiences || []).forEach(a => audSet.add(a));
      if (it.needs_review) needsReview = true;
      if (it.pinned) pinned = true;
      if (it.updated_at && (!updatedAt || new Date(it.updated_at) > new Date(updatedAt))) updatedAt = it.updated_at;
    }

    // b482b fix F10 — a grouped book was ALWAYS 'mixed', even when every one
    // of its chapters came from the same source adapter (e.g. a whole
    // policy-category book is still all `policy` rows) — so Source = Policies
    // hid every grouped policy book and showed only the two solo ones. Only
    // call it 'mixed' when the chapters actually come from more than one
    // source.
    const chapterSources = new Set(b.items.map(it => it.source));
    const uniformSource = chapterSources.size === 1 ? b.items[0].source : 'mixed';

    result.push({
      book_key: b.key,
      title,
      subtitle: (manualMeta && manualMeta.subtitle) || null,
      icon: (manualMeta && manualMeta.icon) || null,
      source: solo ? first.source : uniformSource,
      type: first.type,
      auto: !solo,
      areas: Array.from(areasSet),
      audiences: Array.from(audSet),
      chapter_count: b.items.length,
      needs_review: needsReview,
      pinned,
      updated_at: updatedAt,
      href: solo ? first.href : null,
      open_attr: solo ? (first.source === 'reading_document' ? first.href : null) : null,
      chapters: b.items,
    });
  }
  return result;
}

async function overridesMap(db) {
  const rows = await safeQuery(db, `SELECT source, source_id, book_key, chapter_title FROM ${SCHEMA()}.reading_book_overrides`);
  const m = new Map();
  for (const r of rows) m.set(`${r.source}:${r.source_id}`, r);
  return m;
}

async function booksMetaMap(db) {
  const rows = await safeQuery(db, `SELECT book_key, title, subtitle, icon FROM ${SCHEMA()}.reading_books_meta`);
  const m = new Map();
  for (const r of rows) m.set(r.book_key, r);
  return m;
}

async function readProgressSet(readerKind, readerId) {
  if (!readerKind || !readerId) return new Set();
  const db = getPool();
  const rows = await safeQuery(db,
    `SELECT source, source_id FROM ${SCHEMA()}.reading_progress WHERE reader_kind=$1 AND reader_id=$2 AND read=true`,
    [readerKind, readerId]);
  return new Set(rows.map(r => `${r.source}:${r.source_id}`));
}

// ── Personas ("For" facet) ────────────────────────────────────────────────────
async function listPersonas() {
  const db = getPool();
  return safeQuery(db, `
    SELECT persona_key, label, match_type, match_roles, match_staff_ids, match_portal, relevant_areas, sort_order
    FROM ${SCHEMA()}.reading_personas WHERE is_active = true ORDER BY sort_order, persona_key`);
}

async function updatePersona(key, patch, actor) {
  const db = getPool();
  const sets = [];
  const values = [key];
  const push = (sql, v) => { values.push(v); sets.push(sql.replace('$n', '$' + values.length)); };
  if (patch.label !== undefined) push('label = $n', patch.label);
  if (patch.match_roles !== undefined) push('match_roles = $n::text[]', patch.match_roles);
  if (patch.match_staff_ids !== undefined) push('match_staff_ids = $n::int[]', patch.match_staff_ids);
  if (patch.relevant_areas !== undefined) push('relevant_areas = $n::text[]', patch.relevant_areas);
  if (patch.is_active !== undefined) push('is_active = $n::boolean', patch.is_active);
  if (!sets.length) return { unchanged: true };
  const { rows } = await db.query(
    `UPDATE ${SCHEMA()}.reading_personas SET ${sets.join(', ')}, updated_by=$${values.length + 1}, updated_by_name=$${values.length + 2}, updated_at = now()
     WHERE persona_key = $1 RETURNING persona_key, label, match_type, match_roles, match_staff_ids, match_portal, relevant_areas`,
    [...values, actor && actor.id, actor && actor.name]);
  return rows[0] || null;
}

function personaMatchesViewer(persona, viewer) {
  if (persona.match_type === 'everyone') return true;
  if (persona.match_type === 'staff_id') return viewer.staffId != null && (persona.match_staff_ids || []).map(Number).includes(Number(viewer.staffId));
  if (persona.match_type === 'role') return !!viewer.role && (persona.match_roles || []).includes(viewer.role);
  if (persona.match_type === 'portal') return viewer.portal === persona.match_portal;
  return false;
}

// b482b fix F3(b) — a 'portal' or 'role' persona stands for a specific
// audience (Parents, or staff generally); a book that audience can't even see
// is never "for" that persona, regardless of area. 'staff_id' (Owner) and
// 'everyone' carry no implied audience — their whole point is seeing
// everything admin can see, unrestricted.
function personaImpliedAudience(persona) {
  if (persona.match_type === 'portal') return persona.match_portal || null;
  if (persona.match_type === 'role') return 'staff';
  return null;
}

function bookRelevantToPersona(book, persona) {
  const impliedAudience = personaImpliedAudience(persona);
  if (impliedAudience && !book.audiences.includes(impliedAudience)) return false;
  if (!persona.relevant_areas || !persona.relevant_areas.length) return true; // no area restriction = everything within that audience
  return book.areas.some(a => persona.relevant_areas.includes(a));
}

// b482b fix F3(a) — which personas even APPEAR in the "For" facet, before any
// per-book relevance check. Parents get no persona facet at all (showing
// family a staff roster is the actual bug the brief rules out); EY/HR staff
// only see personas that represent them, not Roost's "preview as Parents"
// portal-type persona, which would always narrow their own (already
// staff-only) shelf to nothing. Roost sees every persona, including
// portal-type ones, because "preview as Parents" is exactly what a manager
// wants there.
function personasVisibleTo(personas, audience, viewer) {
  if (audience === 'parents') return [];
  if (audience === 'admin') return personas;
  // 2026-10-28 (Toby: "I saw [books] locked into another staff member … they should only see
  // the reading room books that are for them"): a member of staff is offered only the
  // personas that match THEM, never another person's shelf.
  return personas.filter(p => p.match_type !== 'portal' && (!viewer || personaMatchesViewer(p, viewer)));
}

// ── The shelf ──────────────────────────────────────────────────────────────
// `viewer` (optional) = { kind: 'staff'|'parent', readerId, role, staffId, portal } —
// used for progress (unread facet/sort) and "most relevant to me" sort. Facet
// counts are always computed against the FULL audience-scoped book set (same
// convention areaCounts() already uses) — they don't shrink as other filters
// are applied, same as the existing About-area pills.
const DATE_BUCKET_TEST = {
  '7d': (d) => d && (Date.now() - new Date(d)) <= 7 * 86400000,
  '30d': (d) => d && (Date.now() - new Date(d)) <= 30 * 86400000,
  older: (d) => !d || (Date.now() - new Date(d)) > 30 * 86400000,
};

async function booksFor({ audience, portal, area, persona, source, unread, sort, q, date, viewer, archived }) {
  const db = getPool();
  // b519 — one pass over everything, then split: the shelf needs the live books AND the
  // archived COUNT in the same render, and computeBooks() is pure so grouping each half
  // costs nothing but CPU. Grouping them SEPARATELY matters: an archived chapter must not
  // reappear inside a live book, which is exactly what "hidden from the default view" means.
  const allItems = await listItems({ audience, portal, archived: 'all' });
  const archivedItems = allItems.filter(i => i.archived_at);
  const liveItems = allItems.filter(i => !i.archived_at);
  const [overrideMapRows, metaMapRows, personas] = await Promise.all([
    overridesMap(db), booksMetaMap(db), listPersonas(),
  ]);
  const archivedOnly = archived === 'only';
  const archivedBooks = computeBooks(archivedItems, overrideMapRows, metaMapRows);
  let books = archivedOnly ? archivedBooks : computeBooks(liveItems, overrideMapRows, metaMapRows);
  for (const b of books) b.archived = archivedOnly;

  const readerKind = viewer && viewer.kind;
  const readerId = viewer && viewer.readerId;
  const progressSet = await readProgressSet(readerKind, readerId);
  for (const b of books) {
    b.unread_chapters = b.chapters.filter(c => !progressSet.has(`${c.source}:${c.source_id}`)).length;
    b.read = b.unread_chapters === 0;
  }

  // b482b fix F3(a) — the facet LIST (which personas even show up as a "For"
  // option) is scoped to the viewer's audience; `personas` (unfiltered) is
  // still used below for "most relevant to me", which is a different question
  // (does one of MY OWN personas match) than "which personas should this
  // audience be offered as a filter".
  const visiblePersonas = personasVisibleTo(personas, audience, viewer);
  const personaByKey = new Map(visiblePersonas.map(p => [p.persona_key, p]));
  const forFacet = visiblePersonas.map(p => ({ key: p.persona_key, label: p.label, count: books.filter(b => bookRelevantToPersona(b, p)).length }));

  const aboutFacet = AREAS.map(([slug, name]) => ({ slug, name, count: books.filter(b => b.areas.includes(slug)).length }));
  const uncategorisedCount = books.filter(b => !b.areas.length).length;
  if (uncategorisedCount) aboutFacet.push({ slug: null, name: 'Uncategorised', count: uncategorisedCount });

  const sourceKeys = Array.from(new Set(books.map(b => b.source))).sort();
  const sourceFacet = sourceKeys.map(s => ({ key: s, label: SOURCE_LABEL[s] || s, count: books.filter(b => b.source === s).length }));

  const now = Date.now();
  const DAY = 86400000;
  const dateFacet = [
    { key: '7d', label: 'Added in the last 7 days', count: books.filter(b => b.updated_at && (now - new Date(b.updated_at)) <= 7 * DAY).length },
    { key: '30d', label: 'Added in the last 30 days', count: books.filter(b => b.updated_at && (now - new Date(b.updated_at)) <= 30 * DAY).length },
    { key: 'older', label: 'Older / undated', count: books.filter(b => !b.updated_at || (now - new Date(b.updated_at)) > 30 * DAY).length },
  ];
  const unreadFacetCount = books.filter(b => b.unread_chapters > 0).length;
  // Counted against the archived set itself, so it does not change as other filters move.
  const archivedFacetCount = archivedBooks.length;

  let filtered = books;
  if (area) {
    filtered = (area === UNCATEGORISED) ? filtered.filter(b => !b.areas.length) : filtered.filter(b => b.areas.includes(area));
  }
  if (persona) {
    const p = personaByKey.get(persona);
    if (p) filtered = filtered.filter(b => bookRelevantToPersona(b, p));
  }
  if (source) filtered = filtered.filter(b => b.source === source);
  if (unread) filtered = filtered.filter(b => b.unread_chapters > 0);
  if (date && DATE_BUCKET_TEST[date]) filtered = filtered.filter(b => DATE_BUCKET_TEST[date](b.updated_at));
  if (q) {
    const needle = q.toLowerCase();
    filtered = filtered.filter(b =>
      b.title.toLowerCase().includes(needle) ||
      b.chapters.some(c => (c.chapter_title || '').toLowerCase().includes(needle) || (c.summary || '').toLowerCase().includes(needle)));
  }

  const myPersonaKeys = viewer ? personas.filter(p => personaMatchesViewer(p, viewer)).map(p => p.persona_key) : [];
  const myAreas = new Set(personas.filter(p => myPersonaKeys.includes(p.persona_key)).flatMap(p => p.relevant_areas || []));

  const byDateDesc = (a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
  const byDateAsc = (a, b) => {
    if (!a.updated_at && !b.updated_at) return 0;
    if (!a.updated_at) return 1;
    if (!b.updated_at) return -1;
    return new Date(a.updated_at) - new Date(b.updated_at);
  };
  const byTitle = (a, b) => a.title.localeCompare(b.title);
  const byUnread = (a, b) => (b.unread_chapters > 0) - (a.unread_chapters > 0);
  // "Most relevant to me": books in an area that matches one of MY personas'
  // remit sort first; a persona with no area restriction (e.g. Owner, who sees
  // everything) contributes nothing here, so this degrades to recency for a
  // viewer whose only matching persona has an unrestricted remit — documented
  // in NOTES rather than silently claimed as more precise than it is.
  const byRelevance = (a, b) => {
    const ra = myAreas.size && a.areas.some(x => myAreas.has(x)) ? 1 : 0;
    const rb = myAreas.size && b.areas.some(x => myAreas.has(x)) ? 1 : 0;
    return (rb - ra) || byDateDesc(a, b);
  };
  const sorters = { newest: byDateDesc, oldest: byDateAsc, az: byTitle, unread: byUnread, relevance: byRelevance };
  filtered.sort(sorters[sort] || byDateDesc);
  filtered.sort((a, b) => (b.pinned - a.pinned));

  return {
    books: filtered.map(({ chapters, open_attr, ...rest }) => rest), // chapter bodies aren't needed on the shelf, only on a book's own page
    facets: { for: forFacet, about: aboutFacet, source: sourceFacet, date: dateFacet, unread: unreadFacetCount, archived: archivedFacetCount },
    total_books: books.length,
    archived_books: archivedFacetCount,
    archived_view: archivedOnly,
  };
}

async function bookDetail(bookKey, { audience, portal, viewer, archived }) {
  const db = getPool();
  const allItems = await listItems({ audience, portal, archived: 'all' });
  const [overrideMapRows, metaMapRows] = await Promise.all([overridesMap(db), booksMetaMap(db)]);
  const liveItems = allItems.filter(i => !i.archived_at);
  const archivedItems = allItems.filter(i => i.archived_at);
  // Normally a book is its LIVE chapters. If it isn't there — you came from the Archived
  // view, or every chapter in it has been archived — look again among the archived ones,
  // so "Archived" is a view you can actually open things from and not a dead list.
  const wanted = archived === 'only' ? archivedItems : liveItems;
  const other = archived === 'only' ? liveItems : archivedItems;
  let book = computeBooks(wanted, overrideMapRows, metaMapRows).find(b => b.book_key === bookKey);
  if (!book) book = computeBooks(other, overrideMapRows, metaMapRows).find(b => b.book_key === bookKey);
  if (!book) return null;
  book.archived = book.chapters.every(c => !!c.archived_at);
  const readerKind = viewer && viewer.kind;
  const readerId = viewer && viewer.readerId;
  const progressSet = await readProgressSet(readerKind, readerId);
  book.chapters = book.chapters.map(c => ({ ...c, read: progressSet.has(`${c.source}:${c.source_id}`) }));
  return book;
}

// Full body for a chapter, where Wren holds one.
//
// b519 — this used to answer for `policy` and `article` only, and returned null for
// everything else, which is why the handbook rendered as its own one-line blurb and the
// 8,257-word curriculum critique rendered as its 200-character summary with no way to
// reach the rest. Three more sources now answer, in the shape each one actually stores:
//   { html }  — already-HTML content, sanitised by the client before it reaches the DOM
//   { text }  — plain text with its paragraphs intact, rendered via textContent
// A `course` and a `document_workspace` still have no body here on purpose: a course is
// taken in the course player and a workspace is edited in its own page, and `extent` now
// says so in words instead of leaving a short summary looking like the whole thing.
async function chapterBody(source, sourceId) {
  const db = getPool();
  if (source === 'policy') {
    const rows = await safeQuery(db, `SELECT content FROM ${SCHEMA()}.policies WHERE id = $1`, [sourceId]);
    return rows[0] ? { html: rows[0].content || '' } : null;
  }
  if (source === 'article') {
    const rows = await safeQuery(db, `SELECT content_html FROM ${SCHEMA()}.resources WHERE id = $1`, [sourceId]);
    return rows[0] ? { html: rows[0].content_html || '' } : null;
  }
  if (source === 'handbook') {
    const rows = await safeQuery(db,
      `SELECT body_html, content_md FROM ${SCHEMA()}.staff_handbook_versions WHERE is_current = true LIMIT 1`);
    if (!rows[0]) return null;
    if (rows[0].body_html) return { html: rows[0].body_html };
    return rows[0].content_md ? { text: mdReadable(rows[0].content_md) } : null;
  }
  if (source === 'staff_reading') {
    const rows = await safeQuery(db,
      `SELECT body_md, what_it_means FROM ${SCHEMA()}.staff_reading_items WHERE id = $1 AND status = 'published'`, [sourceId]);
    if (!rows[0]) return null;
    return rows[0].body_md ? { text: mdReadable(rows[0].body_md) } : null;
  }
  if (source === 'cpd_article') {
    const rows = await safeQuery(db,
      `SELECT body, practice_point, in_the_room, try_this_week, how_you_know FROM ${SCHEMA()}.cpd_theme_articles WHERE id = $1 AND status = 'published'`, [sourceId]);
    if (!rows[0]) return null;
    const r = rows[0];
    const parts = [r.body,
      r.in_the_room ? '\n\nIn the room\n' + r.in_the_room : '',
      r.try_this_week ? '\n\nTry this week\n' + r.try_this_week : '',
      r.how_you_know ? '\n\nHow you\u2019ll know it\u2019s working\n' + r.how_you_know : ''];
    return { text: mdReadable(parts.join('')) };
  }
  if (source === 'study_module') {
    const rows = await safeQuery(db,
      `SELECT content_json FROM ${SCHEMA()}.parent_study_modules WHERE id = $1 AND status = 'published'`, [sourceId]);
    if (!rows[0] || !rows[0].content_json) return null;
    return { text: studyModuleText(rows[0].content_json) };
  }
  return null;
}

// content_json is { sections: [{heading, body_md}], key_takeaways, try_at_home,
// when_to_seek_help } — flattened in that order, headings kept, markdown markers stripped.
// Tolerant of a string, an object, a missing key or a list of strings: the shape is
// whatever the module builder wrote, and a module with an unexpected shape should render
// what it can rather than blow up the pane.
function studyModuleText(json) {
  let j = json;
  if (typeof j === 'string') { try { j = JSON.parse(j); } catch (_) { return mdReadable(j); } }
  if (!j || typeof j !== 'object') return '';
  const out = [];
  const asList = (v) => Array.isArray(v) ? v : (v ? [v] : []);
  for (const sec of asList(j.sections)) {
    if (typeof sec === 'string') { out.push(mdReadable(sec)); continue; }
    if (sec && sec.heading) out.push(String(sec.heading).toUpperCase());
    if (sec && sec.body_md) out.push(mdReadable(sec.body_md));
  }
  const extras = [['KEY TAKEAWAYS', j.key_takeaways], ['TRY AT HOME', j.try_at_home], ['WHEN TO SEEK HELP', j.when_to_seek_help]];
  for (const [label, val] of extras) {
    const list = asList(val).map(v => (typeof v === 'string' ? v : (v && (v.text || v.body_md)) || '')).filter(Boolean);
    if (!list.length) continue;
    out.push(label);
    for (const line of list) out.push('\u2022 ' + mdReadable(line));
  }
  return out.join('\n\n').trim();
}

// ── Manager override (combine/rename/split) ───────────────────────────────────
async function moveToBook(source, sourceId, bookKey, chapterTitle, actor) {
  const db = getPool();
  await db.query(`
    INSERT INTO ${SCHEMA()}.reading_book_overrides (source, source_id, book_key, chapter_title, set_by, set_by_name, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6, now())
    ON CONFLICT (source, source_id) DO UPDATE SET
      book_key = $3, chapter_title = $4, set_by = $5, set_by_name = $6, updated_at = now()
  `, [source, String(sourceId), bookKey, chapterTitle || null, actor && actor.id, actor && actor.name]);
  return { book_key: bookKey };
}

async function splitFromBook(source, sourceId, actor) {
  const bookKey = `solo:${source}:${sourceId}`;
  await moveToBook(source, sourceId, bookKey, null, actor);
  return { book_key: bookKey };
}

async function renameBook(bookKey, patch, actor) {
  const db = getPool();
  await db.query(`
    INSERT INTO ${SCHEMA()}.reading_books_meta (book_key, title, subtitle, icon, updated_by, updated_by_name, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6, now())
    ON CONFLICT (book_key) DO UPDATE SET
      title = COALESCE($2, ${SCHEMA()}.reading_books_meta.title),
      subtitle = COALESCE($3, ${SCHEMA()}.reading_books_meta.subtitle),
      icon = COALESCE($4, ${SCHEMA()}.reading_books_meta.icon),
      updated_by = $5, updated_by_name = $6, updated_at = now()
  `, [bookKey, patch.title || null, patch.subtitle || null, patch.icon || null, actor && actor.id, actor && actor.name]);
  return { book_key: bookKey };
}

async function markRead(readerKind, readerId, source, sourceId, bookKey, read) {
  const db = getPool();
  await db.query(`
    INSERT INTO ${SCHEMA()}.reading_progress (reader_kind, reader_id, source, source_id, book_key, read, read_at, last_opened_at)
    VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $6 THEN now() ELSE NULL END, now())
    ON CONFLICT (reader_kind, reader_id, source, source_id) DO UPDATE SET
      read = $6, read_at = CASE WHEN $6 THEN now() ELSE ${SCHEMA()}.reading_progress.read_at END,
      book_key = $5, last_opened_at = now()
  `, [readerKind, readerId, source, String(sourceId), bookKey || null, !!read]);
}

// ── b519: archive ────────────────────────────────────────────────────────────
// "An archive button … for once I've read something and I won't need to read it again."
// Reversible, per item, and it unpins: see the note in listItems() for why both.
async function setArchived(source, sourceId, archived, actor) {
  const db = getPool();
  const id = String(sourceId);
  if (archived) {
    await db.query(`
      INSERT INTO ${SCHEMA()}.reading_item_state (source, source_id, archived_at, archived_by, archived_by_name, updated_at)
      VALUES ($1,$2, now(), $3, $4, now())
      ON CONFLICT (source, source_id) DO UPDATE SET
        archived_at = COALESCE(${SCHEMA()}.reading_item_state.archived_at, now()),
        archived_by = COALESCE(${SCHEMA()}.reading_item_state.archived_by, $3),
        archived_by_name = COALESCE(${SCHEMA()}.reading_item_state.archived_by_name, $4),
        updated_at = now()
    `, [source, id, actor && actor.id, actor && actor.name]);
    // Archiving unpins. Only ever UPDATEs an existing reading_item_meta row — it never
    // creates one, so archiving something nobody has ever set an area on leaves the meta
    // table exactly as it was.
    await db.query(
      `UPDATE ${SCHEMA()}.reading_item_meta SET pinned = false, updated_at = now()
       WHERE source = $1 AND source_id = $2 AND pinned = true`, [source, id]);
  } else {
    await db.query(
      `UPDATE ${SCHEMA()}.reading_item_state SET archived_at = NULL, archived_by = NULL, archived_by_name = NULL, updated_at = now()
       WHERE source = $1 AND source_id = $2`, [source, id]);
  }
  const { rows } = await db.query(
    `SELECT archived_at, archived_by_name FROM ${SCHEMA()}.reading_item_state WHERE source = $1 AND source_id = $2`, [source, id]);
  return { source, source_id: id, archived_at: (rows[0] && rows[0].archived_at) || null, archived_by: (rows[0] && rows[0].archived_by_name) || null };
}

/** "Archive all read" — everything THIS reader has ticked as read and has not archived yet. */
async function archiveAllRead({ audience, portal, viewer, actor }) {
  const db = getPool();
  const readSet = await readProgressSet(viewer && viewer.kind, viewer && viewer.readerId);
  if (!readSet.size) return { archived: 0, items: [] };
  const items = await listItems({ audience, portal });   // live only: already-archived ones are not in here
  const target = items.filter(i => readSet.has(`${i.source}:${i.source_id}`));
  for (const i of target) await setArchived(i.source, i.source_id, true, actor);
  return { archived: target.length, items: target.map(i => ({ source: i.source, source_id: i.source_id, title: i.title })) };
}

// ── b519: delete ─────────────────────────────────────────────────────────────
// A soft delete. The row stays (so it is auditable and restorable) and the fingerprint stops
// the host scanners re-adding the same document tomorrow morning.
async function deleteItem(item, actor, { fileRequested } = {}) {
  const db = getPool();
  const fp = fingerprintFor(item);
  const { rows } = await db.query(`
    INSERT INTO ${SCHEMA()}.reading_item_deletions
      (source, source_id, fingerprint, title, deleted_by, deleted_by_name, file_requested)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (source, source_id) DO UPDATE SET
      fingerprint = $3, title = $4, deleted_at = now(), deleted_by = $5, deleted_by_name = $6,
      file_requested = ${SCHEMA()}.reading_item_deletions.file_requested OR $7,
      restored_at = NULL, restored_by = NULL, restored_by_name = NULL
    RETURNING *`,
    [item.source, String(item.source_id), fp, item.title || null, actor && actor.id, actor && actor.name, !!fileRequested]);
  return rows[0];
}

/** Queue the file move. Never moves anything itself — see the migration's comment. */
async function requestFileDeletion(relPath, item, actor) {
  const db = getPool();
  const { rows } = await db.query(`
    INSERT INTO ${SCHEMA()}.reading_file_deletions
      (rel_path, item_source, item_source_id, requested_by, requested_by_name)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (rel_path) WHERE status = 'requested' DO NOTHING
    RETURNING *`,
    [relPath, item && item.source, item && String(item.source_id), actor && actor.id, actor && actor.name]);
  if (rows[0]) return rows[0];
  const { rows: existing } = await db.query(
    `SELECT * FROM ${SCHEMA()}.reading_file_deletions WHERE rel_path = $1 AND status = 'requested'`, [relPath]);
  return existing[0] || null;
}

async function listDeletions({ includeRestored } = {}) {
  const db = getPool();
  return safeQuery(db, `
    SELECT d.*, f.status AS file_status, f.moved_to, f.applied_at AS file_applied_at, f.rel_path AS file_rel_path
    FROM ${SCHEMA()}.reading_item_deletions d
    LEFT JOIN ${SCHEMA()}.reading_file_deletions f
      ON f.item_source = d.source AND f.item_source_id = d.source_id
    ${includeRestored ? '' : 'WHERE d.restored_at IS NULL'}
    ORDER BY d.deleted_at DESC`);
}

async function restoreDeletion(id, actor) {
  const db = getPool();
  const { rows } = await db.query(`
    UPDATE ${SCHEMA()}.reading_item_deletions
       SET restored_at = now(), restored_by = $2, restored_by_name = $3
     WHERE id = $1 AND restored_at IS NULL
    RETURNING *`, [id, actor && actor.id, actor && actor.name]);
  return rows[0] || null;
}

async function listFileDeletions(status) {
  const db = getPool();
  return safeQuery(db,
    `SELECT * FROM ${SCHEMA()}.reading_file_deletions ${status ? 'WHERE status = $1' : ''} ORDER BY requested_at DESC`,
    status ? [status] : []);
}

module.exports = {
  AREAS, guessArea, listItems, needsReviewQueue, areaCounts, findItem, upsertMeta, updateDocumentMeta,
  bulkUpdateDocuments, SOURCE_ADAPTERS, UNCATEGORISED,
  overview, listChecklist, updateChecklistItem,
  // b482 — bookshelf
  computeBooks, booksFor, bookDetail, chapterBody,
  moveToBook, splitFromBook, renameBook, markRead,
  listPersonas, updatePersona, personaMatchesViewer, personasVisibleTo,
  // b519 — provenance, archive, delete
  WREN_DOCS_ROOT, PROTECTED_DOC_DIRS, fileDeletable, fingerprintFor, mdReadable, studyModuleText,
  itemStateMap, deletionKeys, isDeleted,
  setArchived, archiveAllRead, deleteItem, requestFileDeletion, listDeletions, restoreDeletion,
  listFileDeletions,
};
