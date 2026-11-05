const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const multer = require('multer');
let csvParse = null;
try { csvParse = require('csv-parse').parse; } catch (e) { /* optional dep — CSV import returns 501 until installed */ }
const { pipeline } = require('stream');

// Parent auth – same as other parent routes
const parentAuth = (req, res, next) => {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-wren-token'] || '';
  if (!token) return res.status(401).json({ error: 'Unauthorised' });
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.aud || decoded.aud !== 'parents') {
      return res.status(401).json({ error: 'Invalid token audience' });
    }
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

router.use(parentAuth);

// Helper: ensure the request belongs to the parent
function ensureOwn(req, res, next) {
  const childId = parseInt(req.params.childId);
  if (req.user.role === 'parent' && req.user.child_id !== childId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// POST /api/home-log – create a log entry
router.post('/', async (req, res) => {
  const {
    child_id,
    waiting_list_id,
    logged_by,
    parent_email,
    kind,
    started_at,
    ended_at,
    detail,
    source,
  } = req.body;

  // Basic validation
  if (!kind || !started_at || !logged_by) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!child_id && !waiting_list_id) {
    return res.status(400).json({ error: 'Either child_id or waiting_list_id must be set' });
  }

  try {
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO home_log (
        child_id, waiting_list_id, logged_by, parent_email, kind,
        started_at, ended_at, detail, source
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        child_id || null,
        waiting_list_id || null,
        logged_by,
        parent_email || null,
        kind,
        started_at,
        ended_at || null,
        detail ? JSON.stringify(detail) : '{}',
        source || 'wren',
      ]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/home-log?from=ISO&to=ISO – list own logs
router.get('/', async (req, res) => {
  const { from, to } = req.query;
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT * FROM home_log WHERE (
          child_id = $1 OR waiting_list_id = $2
        ) AND ($3::timestamptz IS NULL OR started_at >= $3) AND ($4::timestamptz IS NULL OR started_at <= $4)
        ORDER BY started_at DESC`,
      [
        req.user.child_id || null,
        req.user.waiting_list_id || null,
        from || null,
        to || null,
      ]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/home-log/:id – delete own log (only if created by parent)
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getPool();
    const { rowCount } = await db.query(
      `DELETE FROM home_log WHERE id=$1 AND logged_by='parent' AND (
        child_id = $2 OR waiting_list_id = $3
      )`,
      [id, req.user.child_id || null, req.user.waiting_list_id || null]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Not found or not owned' });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// CSV import – Nighp (Baby Tracker) format
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } }); // 5 MB limit
router.post('/import/nighp', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!csvParse) return res.status(501).json({ error: 'CSV import unavailable — csv-parse not installed on server' });
  const records = [];
  const parser = csvParse({ columns: true, trim: true, skip_empty_lines: true });
  let imported = 0;
  let skippedDuplicates = 0;
  let unparsedRows = 0;

  // Collect records
  parser.on('readable', () => {
    let rec;
    while ((rec = parser.read())) records.push(rec);
  });

  const { Readable } = require('stream');
  pipeline(Readable.from(req.file.buffer), parser, async (err) => {
    if (err) {
      console.error('CSV parse error', err);
      return res.status(400).json({ error: 'Invalid CSV' });
    }
    const db = getPool();
    for (const rec of records) {
      const kindRaw = rec.Kind || rec.kind;
      const startRaw = rec.Start || rec.start;
      const endRaw = rec.End || rec.end;
      const detailRaw = rec.Detail || rec.detail;
      const childIdRaw = rec.ChildId || rec.childId || rec.child_id;
      const waitingIdRaw = rec.WaitingListId || rec.waitingListId || rec.waiting_list_id;

      if (!kindRaw || !startRaw) {
        unparsedRows++;
        continue;
      }

      const kindMap = {
        diaper: 'nappy',
        nappy: 'nappy',
        formula: 'bottle',
        bottle: 'bottle',
        nursing: 'breastfeed',
        breastfeed: 'breastfeed',
        feed: 'bottle',
        sleep: 'sleep',
        milestone: 'milestone',
      };
      const kind = kindMap[kindRaw.toLowerCase()] || kindRaw.toLowerCase();

      const started = new Date(startRaw);
      if (isNaN(started)) {
        unparsedRows++;
        continue;
      }
      const ended = endRaw ? new Date(endRaw) : null;
      let detail = {};
      try {
        detail = detailRaw ? (typeof detailRaw === 'string' ? JSON.parse(detailRaw) : detailRaw) : {};
      } catch (e) {
        // malformed JSON
        unparsedRows++;
        continue;
      }
      const childId = childIdRaw ? parseInt(childIdRaw) : null;
      const waitingId = waitingIdRaw ? parseInt(waitingIdRaw) : null;

      try {
        const { rowCount } = await db.query(
          `SELECT 1 FROM home_log WHERE (child_id = $1 OR waiting_list_id = $2) AND kind = $3 AND started_at = $4`,
          [childId, waitingId, kind, started]
        );
        if (rowCount > 0) {
          skippedDuplicates++;
          continue;
        }
        await db.query(
          `INSERT INTO home_log (
            child_id, waiting_list_id, logged_by, parent_email, kind,
            started_at, ended_at, detail, source
          ) VALUES ($1,$2,'import',NULL,$3,$4,$5,$6,'nighp_csv')`,
          [
            childId,
            waitingId,
            kind,
            started,
            ended,
            JSON.stringify(detail),
          ]
        );
        imported++;
      } catch (e) {
        console.error('Insert error', e);
        unparsedRows++;
      }
    }
    res.json({ imported, skipped_duplicates: skippedDuplicates, unparsed_rows: unparsedRows });
  });
});

module.exports = router;
