'use strict';
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { getPool } = require('../db/pool');

const RECORDINGS_DIR = process.env.VAPI_RECORDINGS_DIR || '/app/data/vapi-recordings';
const MAX_RETRIES    = 3;
const BATCH_SIZE     = 5;
const INTERVAL_MS    = 15 * 60 * 1000; // 15 min
const VAPI_API_BASE  = 'https://api.vapi.ai';

// Downloads to destPath. Follows redirects (the authenticated Vapi artifact
// endpoint 302-redirects to a short-lived signed URL on storage.vapi.ai).
// Auth headers are NOT forwarded across the redirect (the signed URL is
// already authenticated, and forwarding the bearer to storage is unnecessary).
function downloadFile(url, destPath, headers = {}, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { timeout: 60000, headers }, (res) => {
      const { statusCode } = res;
      if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location) {
        res.resume(); // drain
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
        return resolve(downloadFile(res.headers.location, destPath, {}, redirectsLeft - 1));
      }
      if (statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${statusCode}`));
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', (e) => { try { fs.unlinkSync(destPath); } catch {} reject(e); });
    }).on('error', reject);
  });
}

async function runAudioPull() {
  const db = getPool();
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) {
    console.error('[vapi-audio] VAPI_API_KEY not set — cannot download recordings');
    return { downloaded: 0, failed: 0 };
  }

  const { rows } = await db.query(`
    SELECT id, raw->>'recordingUrl' AS recording_url
    FROM ladn.vapi_calls
    WHERE audio_download_status = 'pending'
      AND raw->>'recordingUrl' IS NOT NULL
      AND COALESCE(audio_retry_count, 0) < $1
    ORDER BY started_at DESC
    LIMIT $2
  `, [MAX_RETRIES, BATCH_SIZE]);

  if (!rows.length) return { downloaded: 0, failed: 0 };

  let downloaded = 0, failed = 0;
  for (const row of rows) {
    const destPath = path.join(RECORDINGS_DIR, `${row.id}.wav`);
    try {
      // Authenticated artifact endpoint (required from 2026-07-15; works today).
      // Downloads by call id; 302-redirects to a short-lived signed URL.
      const url = `${VAPI_API_BASE}/call/${row.id}/mono-recording`;
      await downloadFile(url, destPath, { Authorization: `Bearer ${apiKey}` });
      await db.query(`
        UPDATE ladn.vapi_calls
        SET audio_local_path      = $1,
            audio_download_status = 'downloaded',
            audio_download_at     = now()
        WHERE id = $2
      `, [destPath, row.id]);
      downloaded++;
      console.log(`[vapi-audio] downloaded ${row.id}`);
    } catch (err) {
      console.error(`[vapi-audio] failed ${row.id}: ${err.message}`);
      await db.query(`
        UPDATE ladn.vapi_calls
        SET audio_retry_count     = COALESCE(audio_retry_count, 0) + 1,
            audio_download_status = CASE
              WHEN COALESCE(audio_retry_count, 0) + 1 >= $1 THEN 'failed'
              ELSE 'pending'
            END
        WHERE id = $2
      `, [MAX_RETRIES, row.id]);
      failed++;
    }
  }
  return { downloaded, failed };
}

function startCron() {
  // Run immediately on startup, then every 15 min
  runAudioPull()
    .then(r => { if (r.downloaded) console.log(`[vapi-audio] startup pull: ${r.downloaded} downloaded, ${r.failed} failed`); })
    .catch(e => console.error('[vapi-audio] startup pull error:', e.message));

  setInterval(() => {
    runAudioPull()
      .then(r => { if (r.downloaded || r.failed) console.log(`[vapi-audio] ${r.downloaded} downloaded, ${r.failed} failed`); })
      .catch(e => console.error('[vapi-audio] pull error:', e.message));
  }, INTERVAL_MS);

  console.log('[vapi-audio] pull cron started (every 15 min)');
}

module.exports = { runAudioPull, startCron };
