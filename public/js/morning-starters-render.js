'use strict';
/* b353 — Morning Starters engine: one slide-type renderer, two callers.
 *
 * A slide is a plain JSON object (see src/content/morning-starters-eyfs/ and
 * src/content/morning-starters-primary/ for examples).
 * This module turns a slide into an HTML FRAGMENT string for the child-facing
 * canvas. It has no DOM and no Node-only APIs, so the exact same file loads
 * as a <script> in the browser (public/js/morning-starters.js requires it via
 * a small shim, see below) and via require() from the host-side PDF pack
 * script (scripts/morning-starters/generate-pdfs.js) — one visual definition,
 * not two that can drift apart.
 *
 * Each renderer draws with plain shapes/CSS, never a copied or scraped image
 * (b353 brief: "no third-party clip art ... an empty box beats someone else's
 * copyright"). Colour is never the only signal — every coloured tag also
 * carries a text label, and matching/odd-one-out slides carry a shape AND a
 * word, not colour alone.
 */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── small original shape vocabulary, used by science-matching / label-the-picture ──
// Deliberately geometric, not representational clip art: a square standing in
// for "block", a circle for "ball", etc. The WORD alongside is what actually
// carries the meaning; the shape is a visual anchor, not the message.
const SHAPES = {
  square:   '<span class="ms-shape ms-shape-square" aria-hidden="true"></span>',
  circle:   '<span class="ms-shape ms-shape-circle" aria-hidden="true"></span>',
  triangle: '<span class="ms-shape ms-shape-triangle" aria-hidden="true"></span>',
  diamond:  '<span class="ms-shape ms-shape-diamond" aria-hidden="true"></span>',
  cloud:    '<span class="ms-shape ms-shape-cloud" aria-hidden="true"></span>',
  drop:     '<span class="ms-shape ms-shape-drop" aria-hidden="true"></span>',
};
function shapeFor(key) { return SHAPES[key] || SHAPES.square; }

// ── the mascot: a simple rounded friendly bird face, original, inline SVG ──
// Nods to Wren's own nature theme without copying any real product's brand.
function mascotSVG(size) {
  const s = size || 48;
  return `<svg class="ms-mascot" width="${s}" height="${s}" viewBox="0 0 64 64" aria-hidden="true">
    <circle cx="32" cy="34" r="24" fill="var(--ms-mascot-body)"/>
    <circle cx="23" cy="30" r="4.5" fill="var(--ms-mascot-ink)"/>
    <circle cx="41" cy="30" r="4.5" fill="var(--ms-mascot-ink)"/>
    <circle cx="24.3" cy="28.7" r="1.4" fill="#fff"/>
    <circle cx="42.3" cy="28.7" r="1.4" fill="#fff"/>
    <path d="M28 40q4 4 8 0" stroke="var(--ms-mascot-ink)" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <path d="M32 34l6 3-6 2z" fill="var(--ms-mascot-beak)"/>
    <path d="M10 20q6-10 16-6" stroke="var(--ms-mascot-body)" stroke-width="6" fill="none" stroke-linecap="round"/>
  </svg>`;
}

function practiceBoxes(n, opts) {
  opts = opts || {};
  const big = opts.big ? ' ms-box-big' : '';
  let out = '';
  for (let i = 0; i < n; i++) out += `<span class="ms-practice-box${big}" role="presentation"></span>`;
  return `<div class="ms-practice-row">${out}</div>`;
}

function linedSpace(lines) {
  let out = '';
  for (let i = 0; i < (lines || 3); i++) out += '<div class="ms-writing-line"></div>';
  return `<div class="ms-lines">${out}</div>`;
}

// ── the 11 slide types ──────────────────────────────────────────────────────
const SLIDE_TYPES = {

  'letter-formation': {
    label: 'Letter formation',
    render(d) {
      const letter = esc(d.letter || '');
      const upper = esc((d.upper || d.letter || '').toUpperCase());
      return `
        <div class="ms-letter-stage">
          <div class="ms-big-letter" aria-hidden="true">${letter}<span class="ms-big-letter-cap">${upper}</span></div>
          <div class="ms-family-chip">${esc(d.family || '')}</div>
        </div>
        ${practiceBoxes(3, { big: true })}
      `;
    },
  },

  'number-bonds': {
    label: 'Number bonds',
    render(d) {
      const target = esc(String(d.target != null ? d.target : ''));
      const a = d.part_a != null ? esc(String(d.part_a)) : '?';
      return `
        <div class="ms-bond-stage">
          <div class="ms-bond-row">
            <span class="ms-bond-box">${a}</span>
            <span class="ms-bond-op">+</span>
            <span class="ms-bond-box ms-bond-blank">?</span>
            <span class="ms-bond-op">=</span>
            <span class="ms-bond-box ms-bond-target">${target}</span>
          </div>
          <div class="ms-bond-hint">Use fingers, counters or a ten frame to find the missing part.</div>
        </div>
      `;
    },
  },

  'one-more-one-less': {
    label: 'One more, one less',
    render(d) {
      const n = esc(String(d.start != null ? d.start : ''));
      return `
        <div class="ms-oml-row">
          <div class="ms-oml-cell"><div class="ms-oml-label">One less</div><span class="ms-practice-box ms-box-big"></span></div>
          <div class="ms-oml-cell ms-oml-mid"><div class="ms-oml-label">&nbsp;</div><span class="ms-oml-target">${n}</span></div>
          <div class="ms-oml-cell"><div class="ms-oml-label">One more</div><span class="ms-practice-box ms-box-big"></span></div>
        </div>
      `;
    },
  },

  'missing-number': {
    label: 'Missing number',
    render(d) {
      const seq = Array.isArray(d.sequence) ? d.sequence : [];
      const blankAt = d.blank_index;
      const cells = seq.map((v, i) => i === blankAt
        ? '<span class="ms-seq-cell ms-seq-blank">?</span>'
        : `<span class="ms-seq-cell">${esc(String(v))}</span>`).join('<span class="ms-seq-arrow">·</span>');
      return `<div class="ms-seq-row">${cells}</div>`;
    },
  },

  'arithmetic-grid': {
    label: 'Arithmetic grid',
    render(d) {
      const qs = Array.isArray(d.questions) ? d.questions : [];
      const cells = qs.map((q, i) =>
        `<div class="ms-arith-cell"><span class="ms-arith-num">${i + 1}.</span> ${esc(String(q.a))} ${esc(q.op)} ${esc(String(q.b))} = <span class="ms-practice-box"></span></div>`
      ).join('');
      return `<div class="ms-arith-grid">${cells}</div>`;
    },
  },

  'super-sentence': {
    label: 'Super sentence',
    render(d) {
      const word = esc(d.word || '');
      return `
        <div class="ms-word-stage"><span class="ms-word-chip">${word}</span></div>
        ${linedSpace(3)}
      `;
    },
  },

  spelling: {
    label: 'Spelling',
    render(d) {
      const words = Array.isArray(d.words) ? d.words : [];
      const rows = words.map(w => `
        <div class="ms-spell-row">
          <span class="ms-spell-word">${esc(w)}</span>
          <span class="ms-practice-box"></span>
        </div>`).join('');
      return `<div class="ms-spell-list">${rows}</div>`;
    },
  },

  'retrieval-question': {
    label: 'Retrieval practice',
    render(d) {
      return `
        <div class="ms-retrieval-q">${esc(d.question || '')}</div>
        ${linedSpace(2)}
      `;
    },
  },

  'odd-one-out': {
    label: 'Odd one out',
    render(d) {
      const items = Array.isArray(d.items) ? d.items : [];
      const cells = items.map((it, i) => `<span class="ms-ooo-item${i === d.answer_index ? ' ms-ooo-answer' : ''}">${esc(it)}</span>`).join('');
      return `<div class="ms-ooo-row">${cells}</div>`;
    },
  },

  'science-matching': {
    label: 'Science matching',
    render(d) {
      const pairs = Array.isArray(d.pairs) ? d.pairs : [];
      const left = pairs.map(p => `<div class="ms-match-item">${shapeFor(p.shape)}<span>${esc(p.left)}</span></div>`).join('');
      const right = pairs.map(p => `<div class="ms-match-item ms-match-right">${esc(p.right)}</div>`).join('');
      return `<div class="ms-match-cols"><div class="ms-match-col">${left}</div><div class="ms-match-rule" aria-hidden="true"></div><div class="ms-match-col">${right}</div></div>`;
    },
  },

  'label-the-picture': {
    label: 'Label the picture',
    render(d) {
      const labels = Array.isArray(d.labels) ? d.labels : [];
      const rows = labels.map(l => `
        <div class="ms-label-row">
          ${shapeFor(l.shape)}
          <span class="ms-practice-box ms-label-box"></span>
        </div>`).join('');
      return `<div class="ms-label-stage"><div class="ms-label-diagram">${shapeFor(d.diagram_shape || 'circle')}</div><div class="ms-label-list">${rows}</div></div>`;
    },
  },
};

const SUBJECT_LABEL = { English: 'English', Maths: 'Maths', Science: 'Science' };

// Renders the whole child-facing slide (chrome + type body). teacherMode also
// prints the answer/teacher note — used ONLY by the print pack's separate
// answer-key pages and the PPTX speaker-notes field, never on the child canvas.
function renderSlideHTML(slide, opts) {
  opts = opts || {};
  const type = SLIDE_TYPES[slide.type];
  const body = type ? type.render(slide.data || {}) : `<div class="ms-fallback">${esc(slide.prompt || '')}</div>`;
  const subject = SUBJECT_LABEL[slide.subject] || slide.subject || '';
  return `
    <section class="ms-slide ms-subject-${esc((slide.subject || '').toLowerCase())}">
      <header class="ms-slide-head">
        ${mascotSVG(40)}
        <span class="ms-subject-tag">${esc(subject)}</span>
      </header>
      <h2 class="ms-slide-title">${esc(slide.title || '')}</h2>
      <p class="ms-slide-prompt">${esc(slide.prompt || '')}</p>
      <div class="ms-slide-body">${body}</div>
      ${opts.teacherMode ? `<footer class="ms-teacher-panel">
        ${slide.answer != null ? `<div class="ms-answer"><strong>Answer:</strong> ${esc(Array.isArray(slide.answer) ? slide.answer.join(', ') : String(slide.answer))}</div>` : ''}
        <div class="ms-teacher-note">${esc(slide.teacher_note || '')}</div>
        <div class="ms-curriculum-ref">${esc(slide.curriculum_ref || '')}</div>
      </footer>` : ''}
    </section>
  `;
}

const API = { SLIDE_TYPES, renderSlideHTML, mascotSVG, esc };
// UMD-lite: require() in Node (the PDF pack script), a plain global in the
// browser (loaded as <script src="/js/morning-starters-render.js"> before
// morning-starters.js) — one file, so the child canvas can never drift
// between the in-app view and the printed pack.
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else if (typeof window !== 'undefined') window.WrenMorningStartersRender = API;
