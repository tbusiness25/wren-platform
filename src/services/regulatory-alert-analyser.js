'use strict';
// Regulatory alert analyser — runs every 15 min.
// For each new regulatory_alerts row with ai_analysis IS NULL:
//   1. Fetches alert + LADN policies (if table exists)
//   2. Calls local Ollama for triage (substantive vs noise + affected policies)
//   3. Saves ai_analysis JSON to alert
//   4. Marks noise automatically; fires Telegram for substantive alerts
//   5. Populates regulatory_policy_links for affected policies

const https       = require('https');
const http        = require('http');
const { getPool } = require('../db/pool');

const OLLAMA_URL  = process.env.OLLAMA_HOST || process.env.OLLAMA_URL  || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_HELPER_MODEL || 'qwen2.5-coder:27b';
const SCHEMA      = () => process.env.PG_SCHEMA || 'ladn';
const BATCH_SIZE  = 5;

// ── Telegram helper ───────────────────────────────────────────────────────────

function sendTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return Promise.resolve();
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' });
  return new Promise(resolve => {
    const req = https.request(
      { hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { res.resume(); resolve(); }
    );
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

// ── Ollama call ───────────────────────────────────────────────────────────────

function ollamaChat(prompt, systemMsg) {
  return new Promise((resolve, reject) => {
    let ollamaHost, ollamaPath, ollamaPort;
    try {
      const u = new URL(OLLAMA_URL);
      ollamaHost = u.hostname;
      ollamaPort = parseInt(u.port) || (u.protocol === 'https:' ? 443 : 80);
      ollamaPath = u.pathname.replace(/\/$/, '') + '/api/chat';
    } catch {
      return reject(new Error('Bad OLLAMA_URL'));
    }

    const body = JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: prompt },
      ],
      stream: false,
      format: 'json',
    });

    const lib = ollamaHost.startsWith('https') ? https : http;
    let resp = '';
    const req = (ollamaPort === 443 ? https : http).request(
      { hostname: ollamaHost, port: ollamaPort, path: ollamaPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => {
        res.setEncoding('utf8');
        res.on('data', d => resp += d);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(resp);
            resolve(parsed.message?.content || parsed.response || '');
          } catch { resolve(resp); }
        });
      }
    );
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Ollama timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Policy list fetcher ───────────────────────────────────────────────────────

async function getPolicySummaries(db, schema) {
  // Gracefully handle missing policies table
  try {
    const { rows } = await db.query(
      `SELECT id, title FROM ${schema}.policies WHERE is_active = true ORDER BY title LIMIT 80`
    );
    return rows;
  } catch {
    return []; // policies table doesn't exist yet
  }
}

// ── Extract JSON from LLM output ──────────────────────────────────────────────

function extractJson(text) {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try { return JSON.parse(jsonMatch[0]); } catch { return null; }
}

// ── Manager Telegram IDs ──────────────────────────────────────────────────────

async function getManagerChatIds(db, schema) {
  try {
    const { rows } = await db.query(
      `SELECT telegram_chat_id FROM ${schema}.staff
       WHERE role IN ('manager','deputy_manager') AND telegram_chat_id IS NOT NULL`
    );
    const ids = rows.map(r => r.telegram_chat_id).filter(Boolean);
    if (!ids.length) ids.push('7565744160'); // fallback to Toby's known ID
    return ids;
  } catch {
    return ['7565744160'];
  }
}

// ── Analyse one alert ─────────────────────────────────────────────────────────

async function analyseAlert(db, alert, policies, managerChatIds, schema) {
  const systemMsg = `You are reviewing a regulatory update for a UK early years nursery. \
Determine if it is substantive (a real change practitioners need to know about) or noise \
(typo fixes, formatting, link corrections, irrelevant content). \
For substantive changes produce: a 2-3 sentence plain-English summary, a list of key changes, \
identify which existing nursery policies (from provided list) are affected and why, and suggest \
one concrete action. For noise just mark it as noise. \
Return ONLY valid JSON in this exact shape: \
{"is_substantive":bool,"summary":"...","key_changes":["..."],"affected_policies":[{"policy_id":int,"policy_title":"...","why":"...","urgency":"critical|high|normal"}],"suggested_action":"...","action_type":"review_policy|start_doc_update|fyi_only|check_staff_training"}`;

  const policyList = policies.length
    ? policies.map(p => `${p.id}: ${p.title}`).join('\n')
    : '(no policies in system yet)';

  const userMsg = [
    `Source: ${alert.publisher || 'unknown publisher'}.`,
    `Title: ${alert.title}`,
    `Content: ${(alert.raw_content || alert.summary || '').slice(0, 4000)}`,
    `\nLADN policies:\n${policyList}`,
  ].join('\n');

  let analysis;
  try {
    const raw = await ollamaChat(userMsg, systemMsg);
    analysis  = extractJson(raw);
    if (!analysis) {
      analysis = { is_substantive: false, summary: 'AI parse error', key_changes: [], affected_policies: [], suggested_action: '', action_type: 'fyi_only' };
    }
  } catch (e) {
    analysis = { is_substantive: false, summary: `AI unavailable: ${e.message}`, key_changes: [], affected_policies: [], suggested_action: '', action_type: 'fyi_only', error: true };
  }

  const newStatus = analysis.is_substantive ? 'new' : 'noise';

  await db.query(
    `UPDATE ${schema}.regulatory_alerts SET ai_analysis=$1, status=$2 WHERE id=$3`,
    [JSON.stringify(analysis), newStatus, alert.id]
  );

  // Populate policy links for affected policies
  if (analysis.is_substantive && analysis.affected_policies?.length) {
    for (const ap of analysis.affected_policies) {
      if (!ap.policy_id) continue;
      try {
        await db.query(`
          INSERT INTO ${schema}.regulatory_policy_links (source_id, policy_id, relationship, confidence)
          VALUES ($1, $2, 'references', 'medium')
          ON CONFLICT (source_id, policy_id) DO NOTHING
        `, [alert.source_id, ap.policy_id]);
      } catch { /* ignore */ }
    }
  }

  // Send Telegram for substantive alerts
  if (analysis.is_substantive && !analysis.error) {
    const urgency = (analysis.affected_policies || []).some(p => p.urgency === 'critical') ? '🚨' : '⚠️';
    const affectedCount = (analysis.affected_policies || []).length;
    const msg = [
      `${urgency} *Wren — Regulatory Alert*`,
      `*${alert.title}*`,
      analysis.summary,
      affectedCount ? `_Affects ${affectedCount} existing policy/policies_` : '',
      analysis.suggested_action ? `→ ${analysis.suggested_action}` : '',
      `\nhttps://admin.littleangelsealing.co.uk/admin/regulatory/alerts/${alert.id}`,
    ].filter(Boolean).join('\n');

    for (const chatId of managerChatIds) {
      await sendTelegram(chatId, msg);
    }
  }

  return analysis.is_substantive;
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function runAnalyser(schemaOverride) {
  const db     = getPool();
  const schema = schemaOverride || SCHEMA();

  const { rows: alerts } = await db.query(`
    SELECT ra.*, rs.publisher, rs.source_key, rs.name AS source_name
    FROM ${schema}.regulatory_alerts ra
    JOIN ${schema}.regulatory_sources rs ON rs.id = ra.source_id
    WHERE ra.ai_analysis IS NULL
      AND ra.status = 'new'
    ORDER BY ra.detected_at
    LIMIT ${BATCH_SIZE}
  `);

  if (!alerts.length) return;
  console.log(`[regulatory-analyser] ${alerts.length} alert(s) to analyse (schema: ${schema})`);

  const policies       = await getPolicySummaries(db, schema);
  const managerChatIds = await getManagerChatIds(db, schema);

  for (const alert of alerts) {
    try {
      const substantive = await analyseAlert(db, alert, policies, managerChatIds, schema);
      console.log(`  [${schema}] alert ${alert.id}: ${substantive ? 'SUBSTANTIVE' : 'noise'}`);
    } catch (e) {
      console.error(`  [analyser] alert ${alert.id} failed: ${e.message}`);
    }
  }
}

// ── Cron (every 15 min) ───────────────────────────────────────────────────────

let _timer = null;

function startAnalyser() {
  if (_timer) return;

  async function tick() {
    try { await runAnalyser(); } catch (e) { console.error('[regulatory-analyser] error:', e); }
    _timer = setTimeout(tick, 15 * 60 * 1000);
  }

  // Start after 30s on boot to let DB settle
  _timer = setTimeout(tick, 30000);
  console.log('[regulatory-analyser] started (15-min interval)');
}

function stopAnalyser() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

module.exports = { startAnalyser, stopAnalyser, runAnalyser };
