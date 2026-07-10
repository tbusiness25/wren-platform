'use strict';
const crypto = require('crypto');

const CATEGORY_NORMALISERS = {
  email_triage_alert: (ctx) => ({
    sender_role:      ctx.sender_role || 'unknown',
    importance_band:  ctx.importance >= 4 ? 'high' : ctx.importance >= 3 ? 'med' : 'low',
    has_attachment:   !!ctx.has_attachment,
    has_thread:       (ctx.thread_count || 0) > 1,
  }),
  email_reply: (ctx) => ({
    sender_role:      ctx.sender_role || 'unknown',
    importance_band:  ctx.importance >= 4 ? 'high' : ctx.importance >= 3 ? 'med' : 'low',
    has_attachment:   !!ctx.has_attachment,
    action_keyword:   ctx.action_keyword || 'none',
  }),
  // Review-queue decisions (CPD courses + assessment modules) — the "it remembers" hook.
  // The scenario is identified by WHAT KIND of item it is and HOW it was generated, so the
  // confidence engine can learn "manager always approves AI-generated SEND courses as-is" as a
  // distinct, recurring scenario from "manager always edits the quiz on safeguarding refreshers".
  cpd_suggestion: (ctx) => ({
    item_type:   ctx.item_type || 'unknown',     // 'course' | 'module'
    item_kind:   ctx.item_kind || 'unknown',     // course category / module attaches_to
    origin:      ctx.origin || 'ai_generated',   // 'ai_generated' | 'ai_edited' | 'human'
    is_mandatory: !!ctx.is_mandatory,
  }),
};

function fingerprintScenario(category, inputContext) {
  const normaliser = CATEGORY_NORMALISERS[category]
    || ((c) => ({ category, keys: Object.keys(c).sort() }));
  const normalised = normaliser(inputContext);
  const stable = JSON.stringify(normalised, Object.keys(normalised).sort());
  return crypto.createHash('sha256').update(category + ':' + stable).digest('hex').slice(0, 32);
}

module.exports = { fingerprintScenario };
