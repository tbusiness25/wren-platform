'use strict';
// b158 — deterministic categoriser for the parents-resources file store.
// Used by BOTH the one-time study-attachment migration script
// (scripts/migrate-parents-resources-study.js) and the live
// /welcome/resources/api/{guides,documents,phonics-materials} routes, so the
// two are always in sync with whatever is actually on disk — no stale manifest.
//
// RESOURCES_ROOT holds generic nursery operational/educational documents
// (policies, planning packs, phonics worksheets, health leaflets) — it is
// NOT per-child data. Individual files are audited by NAME only here; nothing
// reads file contents.

const fs = require('fs');
const path = require('path');

const RESOURCES_ROOT = process.env.RESOURCES_ROOT || '/app/parents-resources';

// Exact relative-path overrides — files already used as the seed_document_path
// for an existing parent_study_modules row. These are carved out of the
// general folder rules below so they render as Study attachments, not a
// second time in Guides/Documents/Phonics.
const STUDY_EXACT = {
  '_migrated/Behaviour Management/No-drama discipline (book summary).docx': 1,
  '_migrated/Behaviour Management/Raising Emotionally Healthy Boys.docx': 2,
  '_migrated/Behaviour Management/Traffic Lights system.docx': 3,
  '_migrated/Home Learning/Phonics/Phonics Presentation.docx': 4,
  '_migrated/Health and Development/Preparing for school/PARENTS GUIDE - School Readiness.pdf': 5,
  'Home Learning/Potty Training Academy/PARENTS GUIDE - Toilet Training.pdf': 6,
  'Home Learning/Baby Room/Autumn sensory cloud dough recipe.pdf': 7,
  'Home Learning/Baby Room/Baby Room Yoga Bug Book/Yoga bug.pdf': 8,
  'Home Learning/Baby Room/Finger painting Autumn.pdf': 9,
  'New Parent Information/New Parent Guidelines (including settling in).docx': 10,
  'New Parent Information/Staffing Structure and Responsibilities.docx': 11,
  'Health and Development/Preparing for school/PARENTS GUIDE - Settling Into School.pdf': 12,
  'Health and Development/Preparing for school/PARENTS GUIDE - Getting Dressed.pdf': 13,
  'Menus and healthy eating/Recipes and healthy eating resources/Eating Well Recipe Book - First steps nutrition.pdf': 14,
};

// "Extra" folder-wide rules that bundle remaining files in a folder onto the
// same module as its STUDY_EXACT anchor (module id given).
const STUDY_EXTRA_RULES = [
  { test: p => /^Behaviour Management\//i.test(p), moduleId: 1 },
  { test: p => /^Home Learning\/Baby Room\//i.test(p), moduleId: 7 },
  { test: p => /^New Parent Information\//i.test(p), moduleId: 10 },
  { test: p => /^Menus and healthy eating\//i.test(p), moduleId: 14 },
  { test: p => /^Health and Development\/Preparing for school\//i.test(p), moduleId: 13 },
];

// Guides / Documents / exclude buckets, checked in order after the study rules.
const RULES = [
  // item 8 (2026-07-29): "Marmalade" is a legacy third-party planning-pack brand
  // (2023/2024 Baby/Toddler/Preschool packs under Planning/). Toby asked for it
  // removed from the parent app. Excluding by name here hides it everywhere the
  // parent UI reads — the categorised Documents grid AND the raw tree/list/file
  // browser (all of which drop exclude:* buckets). Non-Marmalade planning packs
  // stay in documents:planning. Checked first so it wins over the Planning rule.
  { test: p => /marmalade/i.test(p), bucket: 'exclude:marmalade' },
  { test: p => /phonics/i.test(p), bucket: 'phonics' },
  { test: p => /potty training academy/i.test(p), bucket: 'guides:potty_training', label: 'Potty Training' },
  { test: p => /oral health/i.test(p), bucket: 'guides:oral_health', label: 'Oral Health & Teeth' },
  { test: p => /ealing speech and language/i.test(p), bucket: 'guides:speech_language', label: 'Speech & Language (Ealing NHS)' },
  { test: p => /parents guide & resources for illnesses/i.test(p), bucket: 'guides:illness_health', label: 'Common Illnesses & Health' },
  { test: p => /^Health and Development\/Parent resources\//i.test(p), bucket: 'guides:sleep_behaviour', label: 'Sleep & Behaviour' },
  { test: p => /^Home Learning\/Maths & Writing Resources\//i.test(p), bucket: 'guides:maths_writing', label: 'Maths & Writing Activities' },
  { test: p => /^Home Learning\/Parent's guide/i.test(p), bucket: 'guides:eyfs_parent_guide', label: 'Understanding the EYFS' },
  { test: p => /^Policies and procedures\/2026 Drafts for Sign-off\//i.test(p), bucket: 'exclude:internal_draft' },
  { test: p => /^Policies and procedures\/Auto-Drafts\//i.test(p), bucket: 'exclude:internal_draft' },
  { test: p => /^Policies and procedures\/Fire Risk Assessment/i.test(p), bucket: 'exclude:internal_photos' },
  { test: p => /^Policies and procedures\//i.test(p), bucket: 'documents:policies', label: 'Policies & Procedures' },
  // b405 (2026-10-06): Toby — curriculum material belongs in Learning, not Documents.
  // Moved from documents:planning to guides:planning (was documents:planning until
  // today); Documents is meant for nursery paperwork (policies, forms), and these
  // packs are parent-facing teaching material like every other guides: bucket above.
  { test: p => /^Planning\//i.test(p), bucket: 'guides:planning', label: 'Curriculum Planning Packs' },
];

function normalise(relPath) {
  return relPath.split(path.sep).join('/');
}

// Strip whatever prefix a stored seed_document_path used (absolute host path,
// "data/parents-resources/..", or already-relative) down to a path relative
// to RESOURCES_ROOT, matching what safeResourcePath()/STUDY_EXACT expect.
function toRelative(storedPath) {
  if (!storedPath) return null;
  let p = normalise(storedPath);
  const markers = ['/parents-resources/', 'data/parents-resources/'];
  for (const m of markers) {
    const idx = p.indexOf(m);
    if (idx !== -1) return p.slice(idx + m.length);
  }
  return p.replace(/^\/+/, '');
}

function walkFiles(dir, base) {
  base = base || dir;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  let out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      out = out.concat(walkFiles(abs, base));
    } else if (e.isFile()) {
      const relPath = normalise(path.relative(base, abs));
      let size = 0;
      try { size = fs.statSync(abs).size; } catch {}
      out.push({ relPath, name: e.name, ext: path.extname(e.name).toLowerCase(), size });
    }
  }
  return out;
}

function categorize(relPath) {
  if (STUDY_EXACT[relPath] != null) return { bucket: 'study', moduleId: STUDY_EXACT[relPath] };
  const stripped = relPath.replace(/^_migrated\//, '');
  for (const rule of STUDY_EXTRA_RULES) {
    if (rule.test(stripped)) return { bucket: 'study', moduleId: rule.moduleId };
  }
  for (const rule of RULES) {
    if (rule.test(stripped)) return { bucket: rule.bucket, label: rule.label || null };
  }
  return { bucket: 'documents:misc', label: 'Other Documents' };
}

function allFiles() {
  return walkFiles(RESOURCES_ROOT);
}

module.exports = { RESOURCES_ROOT, walkFiles, allFiles, categorize, toRelative, STUDY_EXACT, STUDY_EXTRA_RULES };
