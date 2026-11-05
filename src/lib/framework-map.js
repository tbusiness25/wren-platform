'use strict';

// ── Canonical framework short-name → framework_statements.framework key map ──
// Single source of truth shared by editions/ladn/server-unified.js (the
// /api/framework-statements alias + the /api/framework-statements/tree drill
// endpoint) and src/routes/observations.js (ai-suggest-statements framework
// resolution). Previously this literal only lived inline in server-unified.js,
// so the AI endpoint received unresolved short keys ('B25') and matched nothing.
//
// B25 → the real EyLog-imported Birth to 5 Matters set (554 stmts, framework
// 'birth_to_5_la'), not the 126-row legacy summary (2026-07-27). Legacy set stays
// reachable as B25_LEGACY. Keep this literal identical to the old inline map so
// existing callers (incl. the lowercase 'coel' param that falls through to itself)
// behave unchanged.
const FRAMEWORK_MAP = {
  EYFS: 'eyfs_statutory', B25: 'birth_to_5_la', B25_LEGACY: 'birth_to_5',
  CFE: 'development_matters', COEL: 'coel',
  Fledge: 'fledge', fledge: 'fledge',
  // P4 multi-framework parity: SEND has its own seeded set, plus Leuven + Phonics.
  SEND: 'send', Leuven: 'leuven', Phonics: 'phonics',
  EYDJ: 'eydj', DM: 'development_matters',
  // Full EyLog developmental milestones (area → aspect → age_band → statement)
  EyLog: 'eylog_dev_matters', DevMatters: 'eylog_dev_matters',
};

// Resolve a short key to its internal framework key. Unknown keys (including
// keys that ARE already internal, e.g. 'birth_to_5_la', 'coel') pass through
// unchanged; empty/falsy → the EYFS statutory default.
function resolveFramework(key) {
  if (!key) return 'eyfs_statutory';
  return FRAMEWORK_MAP[key] || key;
}

module.exports = { FRAMEWORK_MAP, resolveFramework };
