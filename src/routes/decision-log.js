'use strict';
const express = require('express');
const router  = express.Router();
const { logDecision } = require('../lib/decision-log');

// Internal-only endpoint — no auth middleware intentionally (n8n and internal services call this).
// Not exposed via Cloudflare tunnel — wren-ladn listens on Docker internal network only.
router.post('/', async (req, res) => {
  try {
    // Enforce body contract: category is required.
    if (!req.body || !req.body.category) {
      return res.status(400).json({ error: 'category is required' });
    }

    // Truncate input_context body to 500 chars if present — never store full email bodies.
    const inputContext = { ...(req.body.inputContext || req.body.input_context || {}) };
    if (typeof inputContext.body === 'string') {
      inputContext.body = inputContext.body.slice(0, 500);
    }

    const id = await logDecision({
      category:          req.body.category,
      inputContext,
      optionsPresented:  req.body.optionsPresented || req.body.options_presented || [],
      decisionMade:      req.body.decisionMade || req.body.decision_made || null,
      decidedByAiModel:  req.body.decidedByAiModel || req.body.decided_by_ai_model || null,
      decidedByStaffId:  req.body.decidedByStaffId || req.body.decided_by_staff_id || null,
      sourceTable:       req.body.sourceTable || req.body.source_table || null,
      sourceId:          req.body.sourceId || req.body.source_id || null,
      relatedChildId:    req.body.relatedChildId || req.body.related_child_id || null,
      relatedStaffId:    req.body.relatedStaffId || req.body.related_staff_id || null,
    });

    res.json({ id });
  } catch (e) {
    console.error('decision-log error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
