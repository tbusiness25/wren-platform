const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool').getPool();
const authenticate = require('../middleware/auth');

// PII Sanitiser — strips identifying data from text BEFORE sending to cloud AI.
// Runs fully local, fails safe (works offline without AI).
//
// AUTH REQUIRED: this route reads live child/staff names from the DB (a name
// enumeration oracle if left open) and can drive the Ascent Ollama box in deep
// mode. Mount behind auth so only logged-in staff can reach it.
router.use(authenticate);

// ── Core PII patterns ───────────────────────────────────────────────────────
const PII_PATTERNS = {
  email: {
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    replacement: '[EMAIL]'
  },
  phone_uk: {
    regex: /\b(?:0|\+44\s?)?(?:\d{4}\s?\d{6}|\d{5}\s?\d{5}|\d{3}\s?\d{3}\s?\d{4})\b/g,
    replacement: '[PHONE]'
  },
  postcode_uk: {
    regex: /\b[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}\b/gi,
    replacement: '[POSTCODE]'
  },
  dob: {
    regex: /\b(?:\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})\b/g,
    replacement: '[DATE]'
  },
  nhs_number: {
    regex: /\b\d{3}\s?\d{3}\s?\d{4}\b/g,
    replacement: '[NHS_NUM]'
  },
  ni_number: {
    regex: /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-Z]\b/gi,
    replacement: '[NI_NUM]'
  }
};

// ── Name sanitiser ─────────────────────────────────────────────────────────
async function _getNamesFromDB() {
  const schema = process.env.PG_SCHEMA || 'ladn';
  try {
    // Get active children and staff names
    const childResult = await pool.query(`
      SELECT DISTINCT first_name, last_name
      FROM ${schema}.children
      WHERE (leave_date IS NULL OR leave_date > CURRENT_DATE)
        AND first_name IS NOT NULL AND last_name IS NOT NULL
    `);
    const staffResult = await pool.query(`
      SELECT DISTINCT first_name, last_name
      FROM ${schema}.staff
      WHERE (is_active = true OR is_active IS NULL)
        AND first_name IS NOT NULL AND last_name IS NOT NULL
    `);

    const children = childResult.rows.map(r => ({
      first: r.first_name.trim(),
      last: r.last_name.trim(),
      full: `${r.first_name.trim()} ${r.last_name.trim()}`
    }));
    const staff = staffResult.rows.map(r => ({
      first: r.first_name.trim(),
      last: r.last_name.trim(),
      full: `${r.first_name.trim()} ${r.last_name.trim()}`
    }));

    return { children, staff };
  } catch (e) {
    console.error('[sanitiser] DB lookup failed:', e.message);
    return { children: [], staff: [] };
  }
}

function _sanitiseNames(text, names) {
  let sanitised = text;
  const replacements = [];

  // Track used tokens per name for consistency
  const tokenMap = new Map();
  let childCounter = 1;
  let staffCounter = 1;

  // First pass: replace emails to avoid matching names inside email addresses
  const emailPlaceholders = [];
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
  sanitised = sanitised.replace(emailRegex, (match) => {
    const placeholder = `__EMAIL_PLACEHOLDER_${emailPlaceholders.length}__`;
    emailPlaceholders.push(match);
    return placeholder;
  });

  // Sort by length (longest first) to avoid partial matches
  const sortedChildren = names.children
    .sort((a, b) => b.full.length - a.full.length);
  const sortedStaff = names.staff
    .sort((a, b) => b.full.length - a.full.length);

  // Replace child names
  sortedChildren.forEach(child => {
    // Full name first
    const fullRegex = new RegExp(`\\b${_escapeRegex(child.full)}\\b`, 'gi');
    if (fullRegex.test(sanitised)) {
      if (!tokenMap.has(child.full)) {
        tokenMap.set(child.full, `[CHILD_${childCounter++}]`);
      }
      const token = tokenMap.get(child.full);
      sanitised = sanitised.replace(fullRegex, token);
      replacements.push({
        type: 'child_name',
        original_masked: child.full.substring(0, 1) + '***',
        token
      });
    }

    // First name alone
    const firstRegex = new RegExp(`\\b${_escapeRegex(child.first)}\\b`, 'gi');
    if (firstRegex.test(sanitised)) {
      if (!tokenMap.has(child.first)) {
        tokenMap.set(child.first, `[CHILD_${childCounter++}]`);
      }
      const token = tokenMap.get(child.first);
      sanitised = sanitised.replace(firstRegex, token);
      if (!replacements.find(r => r.token === token)) {
        replacements.push({
          type: 'child_name',
          original_masked: child.first.substring(0, 1) + '***',
          token
        });
      }
    }
  });

  // Replace staff names
  sortedStaff.forEach(staff => {
    const fullRegex = new RegExp(`\\b${_escapeRegex(staff.full)}\\b`, 'gi');
    if (fullRegex.test(sanitised)) {
      if (!tokenMap.has(staff.full)) {
        tokenMap.set(staff.full, `[STAFF_${staffCounter++}]`);
      }
      const token = tokenMap.get(staff.full);
      sanitised = sanitised.replace(fullRegex, token);
      replacements.push({
        type: 'staff_name',
        original_masked: staff.full.substring(0, 1) + '***',
        token
      });
    }

    const firstRegex = new RegExp(`\\b${_escapeRegex(staff.first)}\\b`, 'gi');
    if (firstRegex.test(sanitised)) {
      if (!tokenMap.has(staff.first)) {
        tokenMap.set(staff.first, `[STAFF_${staffCounter++}]`);
      }
      const token = tokenMap.get(staff.first);
      sanitised = sanitised.replace(firstRegex, token);
      if (!replacements.find(r => r.token === token)) {
        replacements.push({
          type: 'staff_name',
          original_masked: staff.first.substring(0, 1) + '***',
          token
        });
      }
    }
  });

  // Restore email placeholders
  emailPlaceholders.forEach((email, i) => {
    sanitised = sanitised.replace(`__EMAIL_PLACEHOLDER_${i}__`, email);
  });

  return { sanitised, replacements };
}

function _escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Regex PII sanitiser ────────────────────────────────────────────────────
function _sanitiseRegexPII(text) {
  let sanitised = text;
  const replacements = [];

  for (const [type, { regex, replacement }] of Object.entries(PII_PATTERNS)) {
    const matches = [...text.matchAll(regex)];
    matches.forEach(match => {
      const original = match[0];
      // Mask for audit trail
      const masked = type === 'email'
        ? original.substring(0, 2) + '***@' + original.split('@')[1]
        : original.substring(0, 2) + '***';

      replacements.push({
        type,
        original_masked: masked,
        token: replacement
      });
    });

    sanitised = sanitised.replace(regex, replacement);
  }

  return { sanitised, replacements };
}

// ── Deep AI-assisted sanitiser (optional) ──────────────────────────────────
async function _deepSanitise(text) {
  const ollamaHost = process.env.OLLAMA_HOST;
  if (!ollamaHost) {
    return { extraReplacements: [], warnings: ['OLLAMA_HOST not set — deep mode unavailable'] };
  }

  try {
    const response = await fetch(`${ollamaHost}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6:35b-a3b',
        prompt: `You are a PII detection system. Analyse this text and identify ANY remaining personally identifiable information that might have been missed by regex patterns. Look for:
- Names (people, including nicknames)
- Addresses or location identifiers
- Any other identifying details

Text to analyse:
${text}

Respond ONLY with a JSON array of objects like: [{"type":"name","value":"John"},{"type":"address","value":"123 Main St"}]
If no PII found, respond with: []`,
        stream: false,
        options: { temperature: 0.1, num_predict: 500 }
      })
    });

    if (!response.ok) {
      return { extraReplacements: [], warnings: ['AI detection unavailable'] };
    }

    const data = await response.json();
    const aiResponse = data.response.trim();

    // Try to extract JSON
    const jsonMatch = aiResponse.match(/\[.*\]/s);
    if (!jsonMatch) {
      return { extraReplacements: [], warnings: ['AI response unparseable'] };
    }

    const findings = JSON.parse(jsonMatch[0]);
    return { extraReplacements: findings, warnings: [] };
  } catch (e) {
    console.error('[sanitiser] deep mode error:', e.message);
    return { extraReplacements: [], warnings: ['AI detection error: ' + e.message] };
  }
}

// ── Routes ────────────────────────────────────────────────────────────────
router.post('/text', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text field required' });
    }

    const deep = req.query.deep === '1';

    // Step 1: Sanitise names from DB
    const names = await _getNamesFromDB();
    const step1 = _sanitiseNames(text, names);

    // Step 2: Regex PII patterns
    const step2 = _sanitiseRegexPII(step1.sanitised);

    let finalSanitised = step2.sanitised;
    let allReplacements = [...step1.replacements, ...step2.replacements];
    const warnings = [];

    // Step 3: Optional deep AI pass
    if (deep) {
      const deepResult = await _deepSanitise(finalSanitised);
      warnings.push(...deepResult.warnings);

      // Apply AI findings
      deepResult.extraReplacements.forEach((finding, idx) => {
        const token = `[AI_PII_${idx + 1}]`;
        const regex = new RegExp(`\\b${_escapeRegex(finding.value)}\\b`, 'gi');
        if (regex.test(finalSanitised)) {
          finalSanitised = finalSanitised.replace(regex, token);
          allReplacements.push({
            type: finding.type,
            original_masked: finding.value.substring(0, 2) + '***',
            token
          });
        }
      });
    }

    res.json({
      sanitised: finalSanitised,
      replacements: allReplacements,
      deep_mode: deep,
      warnings: warnings.length > 0 ? warnings : undefined
    });
  } catch (e) {
    console.error('[sanitiser] error:', e);
    res.status(500).json({ error: 'sanitisation failed' });
  }
});

module.exports = router;
