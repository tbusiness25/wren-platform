'use strict';
/* ═══════════════════════════════════════════════════════════════════════════════
 * lookback-pack.js — b523 (2026-10-20)
 *
 * The inset-day slide pack: one self-contained HTML file, one chart per screen,
 * big type, no child names. Served by GET /api/lookback/pack.
 *
 * ── WHY HTML AND NOT A PDF ───────────────────────────────────────────────────
 * Chromium cannot run inside the Wren image (Alpine/musl, and puppeteer is a
 * devDependency — see the note in the repo about that), and pdfkit, the house
 * PDF path, draws boxes and text rather than charts. So the pack is a single
 * HTML file which:
 *   · opens straight on the projector and advances with the arrow keys;
 *   · prints to PDF from the browser at one slide per page (@page landscape,
 *     page-break-after on every slide), which is how Toby gets a PDF;
 *   · has NO <script src>, NO font fetch and NO API call, so it works from a
 *     USB stick in a room with no wifi.
 *
 * ── SELF-CONTAINED, BUT STILL NOT A PILE OF HEX LITERALS ─────────────────────
 * A file that must open with no network cannot use var(--c-*) from a stylesheet
 * it will not be able to fetch. Rather than hard-code a palette here — which
 * would be a second source of truth for Wren's colours and would drift — the
 * renderer READS public/css/wren-tokens.css at render time and inlines the
 * :root blocks it needs. The values still come from the one place that owns
 * them; only the delivery changes. If the token file cannot be read, the pack
 * still renders and says so, falling back to the browser's own colours.
 *
 * The charts come from public/js/wren-lookback-charts.js — the SAME renderer
 * the live Roost page uses, required() here rather than reimplemented, so what
 * goes on the projector cannot differ from what was reviewed on screen.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const charts = require('../../public/js/wren-lookback-charts');

const TOKENS_PATH = path.join(__dirname, '..', '..', 'public', 'css', 'wren-tokens.css');

const esc = charts.esc;

/** Pull the :root blocks out of wren-tokens.css so the pack carries the real
 *  Wren palette with no stylesheet to fetch. */
function inlineTokens() {
  try {
    const css = fs.readFileSync(TOKENS_PATH, 'utf8');
    // Everything up to the end of the light-theme block covers the default
    // (dark) :root, the light override and the shared aliases. Nothing is
    // rewritten; the text is taken verbatim.
    const out = [];
    const re = /(:root[^{]*|\[data-wren-scope[^{]*)\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      const sel = m[1].trim();
      if (!/^:root/.test(sel)) continue;
      out.push(sel + '{' + m[2] + '}');
    }
    return out.length ? { ok: true, css: out.join('\n') } : { ok: false, css: '' };
  } catch (e) {
    return { ok: false, css: '', error: e.message };
  }
}

const SHELL_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--c-bg,#fff);color:var(--c-text,#111);
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif}
.lb-deck{max-width:100%}
.lb-slide{min-height:100vh;padding:4vh 5vw 5vh;display:flex;flex-direction:column;
  border-bottom:1px solid var(--c-border,#ddd);page-break-after:always;break-after:page}
.lb-slide:last-child{page-break-after:auto;break-after:auto}
.lb-eyebrow{font-size:1.1rem;letter-spacing:.08em;text-transform:uppercase;color:var(--c-muted,#666);margin:0 0 .4em}
.lb-slide h1{font-size:clamp(2rem,4.2vw,3.4rem);line-height:1.1;margin:0 0 .3em}
.lb-slide h2{font-size:clamp(1.5rem,3vw,2.4rem);line-height:1.15;margin:0 0 .25em}
.lb-sub{font-size:clamp(1rem,1.5vw,1.35rem);color:var(--c-muted,#666);margin:0 0 1em;max-width:60ch}
.lb-figure{flex:1;display:flex;flex-direction:column;justify-content:center;min-height:0}
.lb-svg{width:100%;height:auto;max-height:58vh;overflow:visible}
.lb-legend{display:flex;flex-wrap:wrap;gap:.6em 1.4em;margin:.8em 0 0;font-size:clamp(.9rem,1.2vw,1.15rem);color:var(--c-text,#111)}
.lb-legend-note{color:var(--c-muted,#666)}
.lb-key{display:inline-flex;align-items:center;gap:.45em}
.lb-key i{width:1em;height:1em;border-radius:3px;display:inline-block;flex:none}
.lb-key i.lb-med{height:4px;border-radius:2px;background:var(--c-cat-1,#36c)}
.lb-key i.lb-band{background:var(--c-cat-1,#36c);opacity:.22}
.lb-conf{display:inline-flex;align-items:center;gap:.5em;font-size:clamp(.85rem,1.1vw,1.05rem);
  padding:.35em .9em;border-radius:999px;border:1px solid var(--c-border-strong,#999);color:var(--c-text,#111)}
.lb-conf b{font-weight:700}
.lb-prompt{margin:1.2em 0 0;display:grid;grid-template-columns:1fr 1fr;gap:1em}
.lb-prompt>div{border-left:4px solid var(--c-cat-1,#36c);padding:.5em 0 .5em 1em;background:var(--c-surface,transparent)}
.lb-prompt h3{margin:0 0 .35em;font-size:clamp(.95rem,1.2vw,1.15rem);color:var(--c-cat-1,#36c)}
.lb-prompt p{margin:0;font-size:clamp(.9rem,1.15vw,1.1rem);line-height:1.45}
.lb-answer{margin-top:.6em;padding:.55em .7em;border:1px dashed var(--c-border-strong,#999);border-radius:8px;
  font-size:clamp(.88rem,1.1vw,1.05rem);line-height:1.45;white-space:pre-wrap}
.lb-answer b{display:block;color:var(--c-muted,#666);font-weight:600;font-size:.85em;margin-bottom:.2em}
.lb-limits{margin:1.2em 0 0;font-size:clamp(.85rem,1.05vw,1rem);line-height:1.5;color:var(--c-text,#111)}
.lb-limits h3{margin:0 0 .4em;font-size:1em;color:var(--c-muted,#666);text-transform:uppercase;letter-spacing:.06em}
.lb-limits li{margin-bottom:.45em;max-width:95ch}
.lb-facts{display:flex;flex-wrap:wrap;gap:1.4em 2.6em;margin:1em 0 0}
.lb-fact{min-width:9ch}
.lb-fact b{display:block;font-size:clamp(1.8rem,3.6vw,3rem);line-height:1;font-variant-numeric:tabular-nums}
.lb-fact span{display:block;font-size:clamp(.85rem,1.05vw,1rem);color:var(--c-muted,#666);margin-top:.3em;max-width:22ch}
.lb-tablewrap{overflow-x:auto;margin-top:.8em}
.lb-table{border-collapse:collapse;width:100%;font-size:clamp(.82rem,1vw,.98rem)}
.lb-table th,.lb-table td{text-align:left;padding:.45em .7em;border-bottom:1px solid var(--c-border,#ddd)}
.lb-table thead th{color:var(--c-muted,#666);font-weight:600}
.lb-table td.n,.lb-table th.n{text-align:right;font-variant-numeric:tabular-nums}
.lb-sup{color:var(--c-muted,#666);font-style:italic}
.lb-note{color:var(--c-muted,#666);font-size:clamp(.95rem,1.2vw,1.15rem);margin:2em 0}
.lb-foot{margin-top:auto;padding-top:1.2em;font-size:clamp(.78rem,.95vw,.92rem);color:var(--c-muted,#666)}
.lb-hit{cursor:default}
@media (max-width:760px){ .lb-prompt{grid-template-columns:1fr} .lb-slide{padding:5vh 6vw} }
@media print{
  html,body{background:#fff;color:#000}
  @page{size:A4 landscape;margin:10mm}
  .lb-slide{min-height:0;height:auto;border:0;padding:0 0 8mm}
  .lb-svg{max-height:120mm}
  .lb-nav{display:none}
}
.lb-nav{position:fixed;right:1rem;bottom:1rem;display:flex;gap:.4rem;z-index:9}
.lb-nav a{display:inline-flex;align-items:center;justify-content:center;width:2.6rem;height:2.6rem;
  border-radius:999px;border:1px solid var(--c-border-strong,#999);background:var(--c-surface,#fff);
  color:var(--c-text,#111);text-decoration:none;font-size:1.1rem}
`;

function confPill(c) {
  if (!c) return '';
  return '<span class="lb-conf"><b>' + esc(c.label) + '</b> — ' + esc(c.note) + '</span>';
}

function promptBlock(chart, note) {
  if (!chart.prompt) return '';
  const ans = (label, v) => v && String(v).trim()
    ? '<div class="lb-answer"><b>' + esc(label) + '</b>' + esc(String(v).trim()) + '</div>' : '';
  return '<div class="lb-prompt">'
    + '<div><h3>What might explain this?</h3><p>' + esc(chart.prompt.explain) + '</p>'
    + ans('On the day we said', note && note.explain) + '</div>'
    + '<div><h3>What will we try?</h3><p>' + esc(chart.prompt.try) + '</p>'
    + ans('We agreed', note && note.will_try) + '</div>'
    + '</div>';
}

function limitsBlock(section) {
  if (!section.limits || !section.limits.length) return '';
  return '<div class="lb-limits"><h3>What this number is worth</h3><ul>'
    + section.limits.map(l => '<li>' + esc(l) + '</li>').join('') + '</ul></div>';
}

function factsBlock(section) {
  if (!section.facts || !section.facts.length) return '';
  return '<div class="lb-facts">' + section.facts.map(f =>
    '<div class="lb-fact"><b>' + esc(f.value) + '</b><span>' + esc(f.label)
    + (f.note ? ' <em>(' + esc(f.note) + ')</em>' : '') + '</span></div>').join('') + '</div>';
}

/**
 * Render the slide pack.
 * @param {object} report  the payload from lookback-metrics.buildReport
 * @param {object} opts    { theme: 'light' | 'dark', numbers: boolean }
 */
function renderPack(report, opts) {
  const o = opts || {};
  const theme = o.theme === 'dark' ? 'dark' : 'light';
  const tok = inlineTokens();
  const win = report.window || {};
  const slides = [];

  const foot = (n, total) => '<div class="lb-foot">'
    + esc(report.setting_name || 'the setting') + ' · Look back · ' + esc(win.from || '') + ' to ' + esc(win.to || '')
    + ' · no individual child appears in this pack; any group under '
    + esc((report.suppression && report.suppression.min_group) || 5) + ' children is suppressed'
    + ' · slide ' + n + ' of ' + total + '</div>';

  // ── the title slide ─────────────────────────────────────────────────────
  slides.push(
    '<p class="lb-eyebrow">Inset day · ' + esc(report.today || '') + '</p>'
    + '<h1>Look back</h1>'
    + '<p class="lb-sub">How the children have been progressing — '
    + esc(win.years || '?') + ' academic ' + ((win.years === 1) ? 'year' : 'years') + ': '
    + esc((win.academic_years || []).join(', ')) + '.</p>'
    + '<div class="lb-limits"><h3>Read this first</h3><ul>'
    + '<li>' + esc(report.suppression ? report.suppression.rule : '') + '</li>'
    + '<li>' + esc(report.term_basis || '') + '</li>'
    + '<li>Every chart carries a rating saying how much its number is worth, and the limits of the data behind it. '
    + 'Several of the questions we most want answered cannot be answered well from what we record today — where that is true, '
    + 'the slide says so, and says what we would need to start recording. That is a finding, not a gap in the report.</li>'
    + '<li>Each chart ends with two questions. The answers are what the self-reflection workbooks pick up: '
    + 'what might explain this, and what we will try.</li>'
    + '</ul></div>'
    + (tok.ok ? '' : '<p class="lb-note">The Wren palette could not be inlined, so this pack uses the browser\'s default colours. The figures are unaffected.</p>')
    + '<div class="lb-facts">'
    + (report.sections || []).map(s => '<div class="lb-fact"><b>' + ((s.charts || []).length)
        + '</b><span>' + esc(s.title) + '</span></div>').join('')
    + '</div>');

  // ── one slide per section intro, then one per chart ─────────────────────
  for (const section of (report.sections || [])) {
    slides.push(
      '<p class="lb-eyebrow">' + esc(section.key) + '</p>'
      + '<h1>' + esc(section.title) + '</h1>'
      + '<p class="lb-sub">' + esc(section.question) + '</p>'
      + confPill(section.confidence)
      + factsBlock(section)
      + limitsBlock(section)
      + (section.source ? '<p class="lb-foot" style="margin-top:1.2em;padding:0">Source: ' + esc(section.source) + '</p>' : ''));

    for (const chart of (section.charts || [])) {
      const note = (report.notes || {})[chart.key];
      slides.push(
        '<p class="lb-eyebrow">' + esc(section.title) + '</p>'
        + '<h2>' + esc(chart.title) + '</h2>'
        + (chart.subtitle ? '<p class="lb-sub">' + esc(chart.subtitle) + '</p>' : '')
        + '<div class="lb-figure">' + charts.render(chart, { scale: 1.9, width: 1100, height: 520 }) + '</div>'
        + (o.numbers === false ? '' : charts.renderNumbers(chart))
        + promptBlock(chart, note));
    }
  }

  const total = slides.length;
  const body = slides.map((s, i) =>
    '<section class="lb-slide" id="s' + (i + 1) + '">' + s + foot(i + 1, total) + '</section>').join('\n');

  return '<!DOCTYPE html>\n<html lang="en" data-wren-theme="' + theme + '">\n<head>\n'
    + '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<title>Look back — ' + esc(report.today || '') + '</title>\n'
    + '<meta name="robots" content="noindex,nofollow">\n'
    + '<style>\n' + tok.css + '\n' + SHELL_CSS + '</style>\n</head>\n<body>\n'
    + '<div class="lb-deck">\n' + body + '\n</div>\n'
    // Anchor links, not script: arrow keys work in every browser's find-next on
    // an anchor, and a pack with no JavaScript is a pack that cannot break.
    + '<nav class="lb-nav" aria-label="slides"><a href="#s1" title="First slide">⇤</a>'
    + '<a href="#s' + total + '" title="Last slide">⇥</a></nav>\n'
    + '</body>\n</html>\n';
}

module.exports = { renderPack, inlineTokens };
