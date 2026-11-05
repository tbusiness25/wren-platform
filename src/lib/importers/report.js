'use strict';

/**
 * Shared reconciliation-report builder (b117/b118 style) for Tapestry, BrightHR
 * and the generic CSV mapper. Markdown text — partner-facing evidence of what was
 * (or would be) imported, section by section, plus every skipped row and why.
 */

function fmt(n) {
  return (n ?? 0).toLocaleString();
}

function sectionMd(s) {
  const lines = [`## ${s.name}`];
  if (s.error) {
    lines.push(`⚠ ${s.error}`, '');
    return lines.join('\n');
  }
  if (s.dedupeKey) lines.push(`Dedupe key: ${s.dedupeKey}`);
  if (s.sourceCount !== undefined) lines.push(`- Source rows: ${fmt(s.sourceCount)}`);
  if (s.eligible !== undefined) lines.push(`- Eligible (linked child/staff found): ${fmt(s.eligible)}`);
  lines.push(`- Created: ${fmt(s.created)}`);
  if (s.updated !== undefined) lines.push(`- Updated (already existed): ${fmt(s.updated)}`);
  if (s.duplicate !== undefined) lines.push(`- Already imported (0 new — idempotent re-run): ${fmt(s.duplicate)}`);
  lines.push(`- Skipped (errors): ${fmt((s.errors || []).length)}`);
  if ((s.errors || []).length) {
    lines.push('', '| Row | Error |', '|-----|-------|');
    for (const e of s.errors.slice(0, 200)) {
      lines.push(`| ${e.row ?? '—'} | ${String(e.error || '').replace(/\|/g, '\\|')} |`);
    }
    if (s.errors.length > 200) lines.push(`| … | ${s.errors.length - 200} more not shown |`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * buildReport({ source, db, schema, mode, dedupeKey, jobId, sections })
 * sections: [{ name, dedupeKey?, sourceCount?, eligible?, created, updated?, duplicate?, errors? }]
 */
function buildReport({ source, db, schema, mode, dedupeKey, jobId, sections }) {
  const lines = [
    `# Reconciliation Report — ${source}`,
    '',
    `- Target: db \`${db}\`, schema \`${schema}\``,
    `- Mode: ${mode}`,
  ];
  if (jobId) lines.push(`- Job: \`${jobId}\``);
  lines.push(`- Generated: ${new Date().toISOString()}`);
  if (dedupeKey) lines.push(`- Dedupe key (overall): ${dedupeKey}`);
  lines.push('');
  for (const s of sections) lines.push(sectionMd(s));
  return lines.join('\n');
}

module.exports = { buildReport };
