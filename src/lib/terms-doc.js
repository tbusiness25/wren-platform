'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b285 — reading the Terms & Conditions as a DOCUMENT, not a blob.
//
// ladn.policies.content is plain text with blank-line paragraphs and ALL-CAPS
// headings. b274 chose plain text deliberately: every reader in Wren does
// `textContent = policy.content` into a `white-space: pre-wrap` box, so markdown
// would render as literal '#' and '**' (the live bug on prod's "CCTV Policy"
// row). That choice is kept — this module does not change the stored format, it
// parses it.
//
// WHY IT HAS TO BE PARSED AT ALL
//   * the public website shows the T&C as ~35 collapsible clauses, one per
//     heading. Before b285 those clauses were typed into index.html by hand and
//     had drifted from everything else.
//   * the enrolment form, the parent guide and the fees page each showed a
//     summary of ONE section — the closures/billing rule — as static prose. Three
//     more hand-maintained copies. section('CLOSURES') returns that section from
//     the stored document, so those surfaces quote the document instead of
//     paraphrasing it.
//
// HEADING DETECTION. A heading is a line that:
//   * starts at column 0 (numbered list items in the document are indented),
//   * is 3..80 characters,
//   * equals its own uppercase form (so "Terms and Conditions" and
//     "Your Nursery" are NOT headings),
//   * contains at least one A-Z (so a line of "───" is not a heading),
//   * is preceded by a blank line or is the first line.
// "PAYMENT OF FEES (MONTHLY IN ADVANCE)" has to match, so punctuation and
// brackets are allowed — testing `line === line.toUpperCase()` covers it without
// a character class that would have to be maintained.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_HEADING = 80;

function isHeading(line, prevBlank) {
  if (!prevBlank) return false;
  if (line !== line.replace(/^\s+/, '')) return false;      // indented → not a heading
  const t = line.trim();
  if (t.length < 3 || t.length > MAX_HEADING) return false;
  if (!/[A-Z]/.test(t)) return false;
  if (/[a-z]/.test(t)) return false;                        // any lower-case letter → prose
  return true;
}

/**
 * Parse the stored plain-text document.
 * @returns {{preamble:string[], sections:Array<{heading:string, paragraphs:string[]}>}}
 */
function parse(content) {
  const lines = String(content == null ? '' : content).replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  const preamble = [];
  let current = null;
  let buf = [];
  let prevBlank = true;

  const flushParagraph = () => {
    const text = buf.join('\n').replace(/\s+$/, '');
    buf = [];
    if (!text.trim()) return;
    (current ? current.paragraphs : preamble).push(text);
  };

  for (const raw of lines) {
    const blank = raw.trim() === '';
    if (isHeading(raw, prevBlank)) {
      flushParagraph();
      current = { heading: raw.trim(), paragraphs: [] };
      sections.push(current);
    } else if (blank) {
      flushParagraph();
    } else {
      buf.push(raw);
    }
    prevBlank = blank;
  }
  flushParagraph();
  return { preamble, sections };
}

/**
 * One section by heading. `needle` is matched case-insensitively against the
 * START of the heading, so section('CLOSURES') finds
 * "CLOSURES — AND WHY FEES ARE STILL PAYABLE" without this module having to know
 * the punctuation of the em dash.
 */
function section(content, needle) {
  const n = String(needle || '').toUpperCase();
  const { sections } = parse(content);
  return sections.find(s => s.heading.toUpperCase().startsWith(n)) || null;
}

// Title-case a heading for display: the document stores "CHANGE OF BOOKING
// PATTERN" but the website has always shown "Change of Booking Pattern". Small
// words stay lower unless they lead, and an acronym stays shouted.
const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
const ACRONYM = new Set(['INSET', 'GDPR', 'SEN', 'SEND', 'EYFS', 'CCTV', 'SIDS', 'GP', 'NHS', 'UK']);
function titleCase(heading) {
  const words = String(heading || '').split(/(\s+|—|-)/);
  let first = true;
  return words.map(w => {
    if (!/[A-Za-z]/.test(w)) return w;
    if (ACRONYM.has(w)) { first = false; return w; }
    const lower = w.toLowerCase();
    // A word can be wrapped in punctuation — "(monthly" in "PAYMENT OF FEES
    // (MONTHLY IN ADVANCE)". Look the small-word list up on the letters alone,
    // and capitalise the first LETTER rather than the first character, or the
    // bracket gets "capitalised" and the m stays lower.
    const bare = lower.replace(/[^a-z]/g, '');
    const wasFirst = first;
    first = false;
    if (!wasFirst && SMALL.has(bare)) return lower;
    return lower.replace(/[a-z]/, c => c.toUpperCase());
  }).join('');
}

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// A paragraph may itself be an indented block (the numbered closure list). Those
// keep their line breaks; ordinary prose is re-flowed, because the stored line
// wrapping is an artefact of the plain-text file and not meaningful.
function paragraphHtml(text) {
  const indented = /^\s{2,}/.test(text);
  if (indented) return `<p style="white-space:pre-wrap">${esc(text.replace(/^\n+/, ''))}</p>`;
  return `<p>${esc(text.replace(/\s*\n\s*/g, ' ').trim())}</p>`;
}

/**
 * The public website's accordion markup, generated from the document.
 *
 * The markup is EXACTLY what index.html already used — `.accordion` /
 * `.accordion-head` + `toggleAcc(this)` / `.accordion-body` — because the site's
 * own CSS and its `toggleAcc` function are staying put. This replaces the clause
 * text, not the site's design.
 *
 * Nothing here is inserted as HTML: every string that came from the database is
 * escaped. The document is a document, not markup.
 */
function accordionHtml(content, opts) {
  const o = opts || {};
  const { sections } = parse(content);
  const body = sections.map(s => {
    const inner = s.paragraphs.map(paragraphHtml).join('\n          ');
    return `      <div class="accordion">
        <div class="accordion-head" onclick="toggleAcc(this)"><h4>${esc(titleCase(s.heading))}</h4><span class="chevron">▼</span></div>
        <div class="accordion-body">
          ${inner}
        </div>
      </div>`;
  }).join('\n');

  const stamp = o.version_label || o.version || '';
  const meta = stamp
    ? `      <p class="terms-intro" style="font-size:0.85rem;margin-top:24px;">Version ${esc(String(stamp))}${o.effective_date ? ' — in force from ' + esc(String(o.effective_date)) : ''}. This page is generated from the nursery's own records; the same wording is what parents accept when they register.</p>\n`
    : '';
  return body + '\n' + meta;
}

/** Plain-text section rendered as safe HTML, for the in-portal callouts. */
function sectionHtml(content, needle) {
  const s = section(content, needle);
  if (!s) return '';
  return s.paragraphs.map(paragraphHtml).join('\n');
}

module.exports = { parse, section, sectionHtml, accordionHtml, titleCase, isHeading, esc };
