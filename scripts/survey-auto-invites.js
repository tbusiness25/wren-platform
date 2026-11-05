// b111 — Survey auto-invite hooks (starter + leaver).
// Shared module: exports runAutoInvites(pool) used by:
//   - POST /api/survey/auto-invites/run (manager, on-demand)
//   - nightly cron (CLI: `node scripts/survey-auto-invites.js`)
// Idempotent: an invite is only created if none exists for (template_id, email),
// so re-running never double-invites. Tables are ladn.-qualified so it works both
// inside the app pool and as a standalone script.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function publicOrigin() {
  return process.env.PARENTS_DOMAIN
    ? `https://${process.env.PARENTS_DOMAIN}`
    : 'https://parents.example-nursery.co.uk';
}

// `opts.skipDedupe` — set by callers that already did their OWN (differently
// scoped) idempotency check before calling this, e.g. the quarterly-survey
// automation dedupes on "invited THIS quarter" rather than "invited ever" —
// the default all-time (template_id,email) check below would otherwise block
// every quarter after the first, forever, for a permanent/recurring template.
async function createInviteAndQueue(pool, template, email, childId, origin, opts) {
  opts = opts || {};
  email = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return false;

  if (!opts.skipDedupe) {
    // Idempotency guard — one invite per (template, email), ever.
    const { rows: existing } = await pool.query(
      'SELECT id FROM ladn.survey_invites WHERE template_id=$1 AND email=$2',
      [template.id, email]
    );
    if (existing.length) return false;
  }

  const { rows: inv } = await pool.query(
    `INSERT INTO ladn.survey_invites (template_id, email, child_id, sent_at)
     VALUES ($1,$2,$3,NOW()) RETURNING token`,
    [template.id, email, childId || null]
  );
  const token = inv[0].token;
  const url = `${origin}/welcome/surveys/${template.slug}?t=${token}`;
  const pixel = `${origin}/api/survey/open/${token}.gif`;
  const html = `<p>Dear Parent,</p><p>We'd really value your thoughts. Please take a few minutes to complete our survey:</p>`
    + `<p><a href="${url}">Complete the survey →</a></p>`
    + `<p>This link is personal to you — no login needed.</p>`
    + `<p>Thank you,<br>Your Nursery</p>`
    + `<img src="${pixel}" width="1" height="1" alt="" style="display:none">`;
  try {
    await pool.query(
      `INSERT INTO ladn.comms_email_queue
         (from_email, from_name, subject, status, received_at, draft_text, body_html, classification)
       VALUES ($1,$2,$3,'pending',NOW(),$4,$5,'survey-invite')`,
      [
        email,
        'Your Nursery',
        `We'd love your feedback — ${template.name}`,
        `Dear Parent,\n\nWe'd really value your thoughts. Please take a few minutes to complete our survey:\n\n${url}\n\nThis link is personal to you — no login needed.\n\nThank you,\nYour Nursery`,
        html
      ]
    );
  } catch (err) {
    console.error('[survey-auto-invites] queue error:', err.message); // non-fatal — invite row still created
  }
  return true;
}

// ── STARTER: children who started ~6 weeks ago (target 42 days; nightly scan
//    uses a 38–49 day tolerance window so a missed cron day or two doesn't
//    skip a family — createInviteAndQueue's (template_id,email) dedupe means
//    the wider window can never double-send). ─────────────────────────────
async function runStarterInvites(pool) {
  const origin = publicOrigin();
  const result = { created: 0, candidates: 0 };
  const { rows: starterTpl } = await pool.query(
    `SELECT * FROM ladn.survey_templates WHERE auto_trigger='starter' AND audience='parent' AND active=true ORDER BY id LIMIT 1`
  );
  if (!starterTpl.length) return result;
  const t = starterTpl[0];
  const { rows: kids } = await pool.query(
    `SELECT id AS child_id, parent_1_email, parent_2_email
       FROM ladn.children
      WHERE is_active=true AND is_demo=false AND start_date IS NOT NULL
        AND start_date <= (CURRENT_DATE - INTERVAL '38 days')
        AND start_date >= (CURRENT_DATE - INTERVAL '49 days')`
  );
  result.candidates = kids.length;
  for (const k of kids) {
    for (const email of [k.parent_1_email, k.parent_2_email]) {
      if (await createInviteAndQueue(pool, t, email, k.child_id, origin)) result.created++;
    }
  }
  return result;
}

// ── LEAVER: children whose leave_date is ~1 week away (target 7 days; 4–10 day
//    tolerance window, always in the future so a family is never emailed the
//    "how was it" survey after they've already left). ─────────────────────
async function runLeaverInvites(pool) {
  const origin = publicOrigin();
  const result = { created: 0, candidates: 0 };
  const { rows: leaverTpl } = await pool.query(
    `SELECT * FROM ladn.survey_templates WHERE auto_trigger='leaver' AND audience='parent' AND active=true ORDER BY id LIMIT 1`
  );
  if (!leaverTpl.length) return result;
  const t = leaverTpl[0];
  const { rows: kids } = await pool.query(
    `SELECT id AS child_id, parent_1_email, parent_2_email
       FROM ladn.children
      WHERE is_demo=false AND leave_date IS NOT NULL
        AND leave_date - CURRENT_DATE BETWEEN 4 AND 10`
  );
  result.candidates = kids.length;
  for (const k of kids) {
    for (const email of [k.parent_1_email, k.parent_2_email]) {
      if (await createInviteAndQueue(pool, t, email, k.child_id, origin)) result.created++;
    }
  }
  return result;
}

async function runAutoInvites(pool) {
  const [starter, leaver] = await Promise.all([runStarterInvites(pool), runLeaverInvites(pool)]);
  return { starter, leaver };
}

module.exports = { runAutoInvites, runStarterInvites, runLeaverInvites, createInviteAndQueue, publicOrigin };

// ── CLI entrypoint (nightly cron) ────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const { Pool } = require('pg');
    const pool = new Pool({
      host: process.env.PGHOST || 'wren-postgres',
      port: parseInt(process.env.PGPORT || '5432'),
      user: process.env.PGUSER || process.env.PG_USER || 'wren',
      password: process.env.PGPASSWORD || process.env.PG_PASSWORD,
      database: process.env.PGDATABASE || 'wren',
    });
    try {
      const r = await runAutoInvites(pool);
      console.log('[survey-auto-invites]', JSON.stringify(r));
      process.exit(0);
    } catch (e) {
      console.error('[survey-auto-invites] FAILED:', e.message);
      process.exit(1);
    }
  })();
}
