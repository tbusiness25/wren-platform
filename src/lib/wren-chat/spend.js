'use strict';
/**
 * spend.js — b348: the ledger and the ceiling.
 *
 * wren_chat_calls IS the ledger: the month's spend is SUM(cost_usd) over its 'ok' rows (plus
 * any 'pending' row young enough to be a call still in flight). There is no second counter that
 * could drift from it.
 *
 * HOW IT FAILS TO "NOT NOW" RATHER THAN RUNNING UP A BILL
 *   Before a call, its WORST-CASE cost is worked out from the size of the payload actually going
 *   out and the output-token cap (doubled, to leave room for a model that thinks). A row is
 *   inserted with that cost as 'pending', inside a transaction holding an advisory lock — so two
 *   simultaneous calls cannot both slip under the ceiling. If month-to-date + worst-case would
 *   pass the monthly ceiling, or session-to-date + worst-case would pass the session cap, no call
 *   is made and the row is recorded as 'capped'. After the call the reservation is replaced by
 *   the cost Google reported (usageMetadata). A call that errors before Google answers costs 0.
 *
 * PRICES
 *   Per-million-token list prices, USD, from Google's pricing page as read on 2026-09-21 (see the
 *   NOTES for the source). They are an estimate, not an invoice: they change, and two of these
 *   models are on promotional pricing that ends 2026-12-31. A model that is not in the table is
 *   priced at the most expensive known rate until Toby sets prices in the settings — never at a
 *   guess that could under-count.
 */

const KNOWN_PRICES = Object.freeze({
  'gemini-3.5-flash-lite': { in: 0.30, out: 2.50 },
  'gemini-3.1-flash-lite': { in: 0.25, out: 1.50 },
  'gemini-3.5-flash':      { in: 1.50, out: 9.00 },
  'gemini-3.8-flash':      { in: 0.75, out: 3.75, until: '2026-12-31', after: { in: 1.50, out: 7.50 } },
  'gemini-3.7-flash':      { in: 0.75, out: 3.75, until: '2026-12-31', after: { in: 1.50, out: 7.50 } },
  'gemini-3.6-flash':      { in: 0.75, out: 3.75, until: '2026-12-31', after: { in: 1.50, out: 7.50 } },
});
const FALLBACK_PRICE = Object.freeze({ in: 1.50, out: 9.00 });
const LOCK_KEY = 348001;
const PENDING_TTL = "interval '5 minutes'";
const MONTH_START = "(date_trunc('month', now() AT TIME ZONE 'Europe/London') AT TIME ZONE 'Europe/London')";

function priceFor(cfg, model, now = new Date()) {
  if (cfg.price_in_per_mtok != null && cfg.price_out_per_mtok != null) {
    return { in: Number(cfg.price_in_per_mtok), out: Number(cfg.price_out_per_mtok), source: 'settings' };
  }
  const k = KNOWN_PRICES[model];
  if (k) {
    if (k.until && k.after && now > new Date(k.until + 'T23:59:59Z')) return { in: k.after.in, out: k.after.out, source: 'price table (after promotion)' };
    return { in: k.in, out: k.out, source: k.until ? 'price table (promotional until ' + k.until + ')' : 'price table' };
  }
  return { in: FALLBACK_PRICE.in, out: FALLBACK_PRICE.out, source: 'fallback: model not in the price table — set prices in settings' };
}

const costUsd = (price, promptTokens, outputTokens) => ((promptTokens || 0) * price.in + (outputTokens || 0) * price.out) / 1e6;

/** Upper bound for one call: every byte a token, and the output cap doubled for thinking. */
function worstCaseUsd(price, wireBytes, maxOutputTokens) {
  return costUsd(price, Math.ceil(wireBytes / 3), maxOutputTokens * 2);
}

async function insertCall(db, r) {
  const { rows } = await db.query(
    `INSERT INTO wren_chat_calls
       (staff_id, session_id, turn_id, provider, model, endpoint, endpoint_class, status, reason, data_classes, redactions,
        tool_calls, sent_bytes, sent_sha256, sent_text, prompt_tokens, output_tokens, thought_tokens, cost_usd, latency_ms, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20, CASE WHEN $8 = 'pending' THEN NULL ELSE now() END)
     RETURNING id`,
    [r.staff_id || null, r.session_id, r.turn_id || null, r.provider, r.model || null, r.endpoint || null, r.endpoint_class || null,
     r.status, r.reason || null, r.data_classes || [], JSON.stringify(r.redactions || {}), r.tool_calls ? JSON.stringify(r.tool_calls) : null,
     r.sent_bytes ?? null, r.sent_sha256 || null, r.sent_text || null, r.prompt_tokens ?? null, r.output_tokens ?? null,
     r.thought_tokens ?? null, r.cost_usd || 0, r.latency_ms ?? null]);
  return rows[0].id;
}

async function updateCall(db, id, r) {
  await db.query(
    `UPDATE wren_chat_calls SET status = $2, reason = $3, prompt_tokens = $4, output_tokens = $5, thought_tokens = $6,
            cost_usd = $7, latency_ms = $8, tool_calls = COALESCE($9::jsonb, tool_calls), finished_at = now()
     WHERE id = $1`,
    [id, r.status, r.reason || null, r.prompt_tokens ?? null, r.output_tokens ?? null, r.thought_tokens ?? null,
     r.cost_usd || 0, r.latency_ms ?? null, r.tool_calls ? JSON.stringify(r.tool_calls) : null]);
}

async function attachToolCalls(db, id, toolCalls) {
  await db.query('UPDATE wren_chat_calls SET tool_calls = $2::jsonb WHERE id = $1', [id, JSON.stringify(toolCalls)]);
}

async function totals(db, sessionId) {
  const { rows: [t] } = await db.query(
    `SELECT COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= ${MONTH_START}), 0)::float AS month_usd,
            COALESCE(SUM(cost_usd) FILTER (WHERE session_id = $1), 0)::float AS session_usd,
            COUNT(*) FILTER (WHERE created_at >= ${MONTH_START} AND status = 'ok')::int AS calls_month
       FROM wren_chat_calls
      WHERE provider = 'gemini' AND (status = 'ok' OR (status = 'pending' AND created_at > now() - ${PENDING_TTL}))`,
    [sessionId || '']);
  return t;
}

/**
 * Reserve worst-case spend for one call. Returns { ok:true, id } — a pending row now exists —
 * or { ok:false, reason:'monthly_ceiling'|'session_cap', ... } with a 'capped' row written.
 */
async function reserve(pool, cfg, base, worst) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    const t = await totals(c, base.session_id);
    let reason = null;
    if (t.month_usd + worst > Number(cfg.monthly_ceiling_usd)) reason = 'monthly_ceiling';
    else if (t.session_usd + worst > Number(cfg.session_cap_usd)) reason = 'session_cap';
    if (reason) {
      await insertCall(c, Object.assign({}, base, { status: 'capped', reason, cost_usd: 0 }));
      await c.query('COMMIT');
      return { ok: false, reason, month_usd: t.month_usd, session_usd: t.session_usd, worst_case_usd: worst,
               monthly_ceiling_usd: Number(cfg.monthly_ceiling_usd), session_cap_usd: Number(cfg.session_cap_usd) };
    }
    const id = await insertCall(c, Object.assign({}, base, { status: 'pending', cost_usd: worst }));
    await c.query('COMMIT');
    return { ok: true, id };
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* gone */ }
    throw e;
  } finally { c.release(); }
}

async function summary(db, cfg, sessionId) {
  const t = await totals(db, sessionId);
  const model = cfg.gemini_model;
  return {
    month_usd: round(t.month_usd), session_usd: round(t.session_usd), calls_month: t.calls_month,
    monthly_ceiling_usd: Number(cfg.monthly_ceiling_usd), session_cap_usd: Number(cfg.session_cap_usd),
    month_remaining_usd: round(Math.max(0, Number(cfg.monthly_ceiling_usd) - t.month_usd)),
    session_remaining_usd: round(Math.max(0, Number(cfg.session_cap_usd) - t.session_usd)),
    price: Object.assign({ model }, priceFor(cfg, model)),
  };
}
const round = (n) => Math.round(n * 1e6) / 1e6;

module.exports = { KNOWN_PRICES, priceFor, costUsd, worstCaseUsd, insertCall, updateCall, attachToolCalls, reserve, summary, totals };
