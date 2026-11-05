'use strict';
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

const WHISPER_URL = process.env.WHISPER_URL || 'http://wren-whisper:9876';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Rate limit: max 20 requests per minute per staff member (in-memory, single-process)
const rateLimits = new Map();
function checkRateLimit(staffId) {
  const now = Date.now();
  const key = `${staffId}`;
  const bucket = rateLimits.get(key) || { count: 0, resetAt: now + 60000 };
  if (now > bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + 60000; }
  if (bucket.count >= 20) return false;
  bucket.count++;
  rateLimits.set(key, bucket);
  return true;
}

router.use(authenticate);

// POST /api/transcribe — multipart audio → whisper → { text, duration }
router.post('/', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

    if (!checkRateLimit(req.user.id)) {
      return res.status(429).json({ error: 'Rate limit exceeded (20/min)' });
    }

    const context = req.body.context || null;

    // Forward to whisper service using Node.js 18+ built-in FormData
    const fd = new FormData();
    const ext = (req.file.mimetype || '').includes('ogg') ? 'recording.ogg' : 'recording.webm';
    fd.append('file', new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' }), ext);

    const whisperRes = await fetch(`${WHISPER_URL}/transcribe`, {
      method: 'POST',
      body: fd,
      signal: AbortSignal.timeout(90000),
    });

    if (!whisperRes.ok) {
      const body = await whisperRes.text();
      return res.status(502).json({ error: `Whisper error: ${body}` });
    }

    const data = await whisperRes.json();
    const text = (data.text || '').trim();
    const duration = data.duration || null;

    // Audit log (fire and forget)
    getPool().query(
      'INSERT INTO transcriptions(staff_id, duration_seconds, text, context) VALUES($1,$2,$3,$4)',
      [req.user.id, duration, text, context]
    ).catch(e => console.error('[transcribe] audit save error:', e.message));

    res.json({ text, duration });
  } catch (e) {
    console.error('[transcribe] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
