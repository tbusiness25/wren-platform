/**
 * points-weekly-digest.js
 * Runs every Sunday at 18:00 via cron or n8n.
 *
 * Cron install (inside container or host):
 *   0 18 * * 0  node /home/toby/wren/src/jobs/points-weekly-digest.js
 *
 * Env vars:
 *   PG_HOST / PG_PORT / PG_USER / PG_PASSWORD / PG_DATABASE
 *   DIGEST_SCHEMAS   — comma-separated list, e.g. "demo_primary,demo_secondary"
 *   POINTS_DIGEST_WEBHOOK — n8n webhook URL to deliver emails
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../editions/eyfs/.env'), override: false });

const { Pool } = require('pg');
const https = require('https');
const http  = require('http');

async function runDigest(pgConfig, schema, webhookUrl) {
  const pool = new Pool(pgConfig);

  // Week start = most recent Monday
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const daysBack = day === 0 ? 7 : day;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - daysBack);
  weekStart.setHours(0, 0, 0, 0);
  const weekStartStr = weekStart.toISOString().slice(0, 10);

  try {
    const { rows: childAwards } = await pool.query(`
      SELECT
        ch.id                                          AS child_id,
        ch.first_name,
        ch.last_name,
        CONCAT(ch.first_name, ' ', ch.last_name)       AS child_name,
        ch.parent_1_email,
        ch.parent_2_email,
        COUNT(a.id)::int                               AS award_count,
        COALESCE(SUM(CASE WHEN a.value > 0 THEN a.value ELSE 0 END), 0)::int AS positive_total,
        json_agg(json_build_object(
          'category',   cat.name,
          'icon',       cat.icon,
          'reason',     a.reason_text,
          'awarded_by', CONCAT(st.first_name, ' ', st.last_name),
          'awarded_at', a.awarded_at
        ) ORDER BY a.awarded_at DESC) AS awards,
        mode() WITHIN GROUP (ORDER BY cat.name)        AS top_category
      FROM ${schema}.children ch
      JOIN ${schema}.wp_awards a
        ON a.child_id = ch.id
        AND a.awarded_at::date >= $1::date
        AND a.awarded_at::date <  ($1::date + INTERVAL '7 days')
      JOIN ${schema}.wp_categories cat ON cat.id = a.category_id
      JOIN ${schema}.staff st          ON st.id  = a.awarded_by_staff_id
      WHERE ch.is_active = true
      GROUP BY ch.id, ch.first_name, ch.last_name, ch.parent_1_email, ch.parent_2_email
    `, [weekStartStr]);

    if (!childAwards.length) {
      console.log(`[digest][${schema}] No awards for week ${weekStartStr}`);
      await pool.end();
      return { schema, sent: 0, week_start: weekStartStr };
    }

    let sent = 0;
    for (const child of childAwards) {
      // Skip if already sent this week
      const { rows: existing } = await pool.query(
        `SELECT sent_at FROM ${schema}.wp_weekly_digests WHERE child_id=$1 AND week_start=$2`,
        [child.child_id, weekStartStr]
      );
      if (existing[0]?.sent_at) continue;

      const summary = {
        child_name:     child.child_name,
        first_name:     child.first_name,
        week_start:     weekStartStr,
        award_count:    child.award_count,
        positive_total: child.positive_total,
        top_category:   child.top_category,
        awards:         child.awards,
      };

      await pool.query(`
        INSERT INTO ${schema}.wp_weekly_digests (child_id, week_start, sent_at, summary_json)
        VALUES ($1, $2, now(), $3)
        ON CONFLICT (child_id, week_start) DO UPDATE
          SET sent_at=now(), summary_json=$3
      `, [child.child_id, weekStartStr, JSON.stringify(summary)]);

      const emails = [child.parent_1_email, child.parent_2_email].filter(Boolean);
      if (webhookUrl && emails.length) {
        await postWebhook(webhookUrl, {
          trigger:   'wren_points_weekly_digest',
          schema,
          emails,
          child,
          summary,
        }).catch(err => console.error(`[digest][${schema}] webhook error:`, err.message));
      }
      sent++;
    }

    console.log(`[digest][${schema}] Sent ${sent} digests for week ${weekStartStr}`);
    await pool.end();
    return { schema, sent, week_start: weekStartStr };
  } catch (e) {
    await pool.end();
    throw e;
  }
}

function postWebhook(urlStr, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url  = new URL(urlStr);
    const lib  = url.protocol === 'https:' ? https : http;
    const req  = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.end(body);
  });
}

if (require.main === module) {
  const pgConfig = {
    host:     process.env.PG_HOST     || 'localhost',
    port:     parseInt(process.env.PG_PORT || '5432'),
    user:     process.env.PG_USER     || 'wren',
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE || 'wren',
  };
  const schemas    = (process.env.DIGEST_SCHEMAS || 'demo_primary').split(',').map(s => s.trim());
  const webhookUrl = process.env.POINTS_DIGEST_WEBHOOK;

  Promise.all(schemas.map(s => runDigest(pgConfig, s, webhookUrl)))
    .then(results => { console.log('[digest] Complete:', results); process.exit(0); })
    .catch(err    => { console.error('[digest] Error:', err);       process.exit(1); });
}

module.exports = { runDigest };
