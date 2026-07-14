const express = require('express');
const router  = express.Router();
const authenticate = require('../middleware/auth');

const OLLAMA_URL = process.env.OLLAMA_HOST || process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_HELPER_MODEL || 'qwen3.6:27b';

router.use(authenticate);

const PROMPTS = {
  observation: {
    polish:     (t) => `You are an experienced EYFS practitioner. Polish this observation note for professional quality. Keep it concise, use correct EYFS language, maintain all factual content. Return ONLY the improved text:\n\n${t}`,
    expand:     (t) => `You are an experienced EYFS practitioner. Expand this brief observation note into a fuller, richer observation including context, what the child did, what it shows about their development, and a suggested next step. Return ONLY the improved text:\n\n${t}`,
    next_steps: (t) => `Based on this EYFS observation, suggest 2-3 concrete next steps for the child's development. Be specific and practical. Return ONLY the next steps as a short bulleted list:\n\n${t}`,
    eyfs_link:  (t) => `Identify which EYFS prime and specific areas of learning are demonstrated in this observation. Return ONLY a short list of relevant areas with a one-line reason each:\n\n${t}`,
    grammar:    (t) => `Fix any grammar, spelling and punctuation in this observation note. Return ONLY the corrected text:\n\n${t}`,
  },
  parent_message: {
    polish:     (t) => `You are a nursery manager writing to a parent. Polish this message to be warm, professional and clear. Return ONLY the improved text:\n\n${t}`,
    tone_warm:  (t) => `Rewrite this nursery message in a warm, friendly, reassuring tone suitable for a parent. Return ONLY the rewritten text:\n\n${t}`,
    tone_brief: (t) => `Rewrite this nursery message to be shorter and more concise while keeping all key information. Return ONLY the rewritten text:\n\n${t}`,
    translate:  (t) => `Translate this nursery message into simple, clear English suitable for a non-native speaker. Return ONLY the translated/simplified text:\n\n${t}`,
    grammar:    (t) => `Fix any grammar, spelling and punctuation errors. Return ONLY the corrected text:\n\n${t}`,
  },
  newsletter: {
    polish:     (t) => `You are writing a nursery newsletter for Little Angels Day Nursery, Ealing. Polish this section to be engaging, warm and professional. Return ONLY the improved text:\n\n${t}`,
    expand:     (t) => `Expand this newsletter section with more detail and a warm nursery tone. Return ONLY the expanded text:\n\n${t}`,
    summarise:  (t) => `Summarise this newsletter section into 2-3 punchy sentences. Return ONLY the summary:\n\n${t}`,
    headline:   (t) => `Suggest 3 engaging newsletter headline options for this content. Return ONLY the 3 headlines as a numbered list:\n\n${t}`,
  },
  report: {
    polish:     (t) => `You are writing an EYFS parent report for Little Angels Day Nursery. Polish this section to be positive, informative and professionally written. Return ONLY the improved text:\n\n${t}`,
    expand:     (t) => `Expand this EYFS report section with specific developmental observations and achievements. Return ONLY the expanded text:\n\n${t}`,
    evidence:   (t) => `Suggest 2-3 types of evidence that could be collected to support this EYFS report statement. Return ONLY the suggestions as a brief bulleted list:\n\n${t}`,
    framework:  (t) => `Identify which sections of the EYFS framework (2021) are most relevant to this report statement. Return ONLY the framework references with brief explanations:\n\n${t}`,
  },
  default: {
    polish:     (t) => `Polish this text to be clearer and more professional. Return ONLY the improved text:\n\n${t}`,
    expand:     (t) => `Expand this text with more detail and context. Return ONLY the expanded text:\n\n${t}`,
    summarise:  (t) => `Summarise this text in 2-3 sentences. Return ONLY the summary:\n\n${t}`,
    rewrite:    (t) => `Rewrite this text to improve clarity and flow. Return ONLY the rewritten text:\n\n${t}`,
    translate:  (t) => `Simplify this text into plain English. Return ONLY the simplified text:\n\n${t}`,
    grammar:    (t) => `Fix any grammar, spelling and punctuation errors. Return ONLY the corrected text:\n\n${t}`,
  },
};

router.post('/', async (req, res) => {
  const { context = 'default', action, text } = req.body;
  if (!action || !text) return res.status(400).json({ error: 'action and text required' });
  if (text.length > 8000) return res.status(400).json({ error: 'text too long (max 8000 chars)' });

  const contextPrompts = PROMPTS[context] || PROMPTS.default;
  const promptFn = contextPrompts[action] || PROMPTS.default[action];
  if (!promptFn) return res.status(400).json({ error: `Unknown action: ${action}` });

  const prompt = promptFn(text);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const ollamaRes = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false, think: false,
        options: { temperature: 0.4, num_predict: 800 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!ollamaRes.ok) throw new Error(`Ollama error: ${ollamaRes.status}`);
    const data = await ollamaRes.json();
    let result = (data.response || '').trim();

    // Strip qwen3 chain-of-thought tags if present
    result = result.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    res.json({ result, model: OLLAMA_MODEL, context, action });
  } catch (e) {
    if (e.name === 'AbortError') return res.status(504).json({ error: 'AI helper timed out (30s)' });
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ai-helper/actions?context=X — list available actions for a context
router.get('/actions', (req, res) => {
  const { context = 'default' } = req.query;
  const prompts = PROMPTS[context] || PROMPTS.default;
  const labels = {
    polish: 'Polish', expand: 'Expand', summarise: 'Summarise', rewrite: 'Rewrite',
    grammar: 'Fix grammar', translate: 'Simplify / Translate',
    next_steps: 'Suggest next steps', eyfs_link: 'Link to EYFS areas',
    tone_warm: 'Warmer tone', tone_brief: 'Make briefer',
    headline: 'Suggest headline', evidence: 'Suggest evidence', framework: 'EYFS framework links',
  };
  res.json(Object.keys(prompts).map(k => ({ action: k, label: labels[k] || k })));
});

module.exports = router;
